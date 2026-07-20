import type { Company, ExpenseRequest, NettUser, Role, Vendor } from '../types/domain.js';
import * as expenseRepo from '../repositories/expense.repository.js';
import * as companyRepo from '../repositories/company.repository.js';
import * as vendorRepo from '../repositories/vendor.repository.js';
import * as auditRepo from '../repositories/audit.repository.js';
import { canApprove, canPay } from '../utils/permissions.js';
import { UserFacingError } from '../utils/errors.js';
import { makeRef } from '../utils/ids.js';
import { initiateTransfer, authorizeTransfer } from './monnify.service.js';

// Every action on a ref is scoped to the actor's company. A ref from another
// company behaves exactly like a ref that does not exist.
async function findOwnedRequest(ref: string, companyId: string): Promise<ExpenseRequest> {
    const request = await expenseRepo.findByRef(ref);
    if (!request || request.company_id !== companyId) {
        throw new UserFacingError('Expense request not found.');
    }
    return request;
}

export async function createRequest(input: {
    company: Company;
    requester: NettUser;
    vendor: Vendor;
    amountKobo: number;
    purpose: string;
    category: string;
    invoiceFileId?: string | null;
}): Promise<ExpenseRequest> {
    const request = await expenseRepo.create({
        ref: makeRef('EXP'),
        company_id: input.company.id,
        requester_user_id: input.requester.id,
        vendor_id: input.vendor.id,
        amount_kobo: input.amountKobo,
        currency: input.company.base_currency,
        purpose: input.purpose,
        category: input.category,
        invoice_file_id: input.invoiceFileId ?? null,
        status: 'PENDING_APPROVAL',
        required_approvals: input.company.required_approvals,
    });

    await auditRepo.log({
        companyId: input.company.id,
        actorUserId: input.requester.id,
        action: 'expense_requested',
        entityType: 'expense_request',
        entityId: request.ref,
        details: { amountKobo: input.amountKobo, vendor: input.vendor.nickname, purpose: input.purpose },
    });
    return request;
}

export async function decide(input: {
    ref: string;
    companyId: string;
    userId: string;
    decision: 'APPROVED' | 'REJECTED';
    role: Role;
}): Promise<{ request: ExpenseRequest; approvals: number }> {
    if (!canApprove(input.role)) {
        throw new UserFacingError('Your role cannot approve or reject expense requests.');
    }

    const request = await findOwnedRequest(input.ref, input.companyId);

    if (request.requester_user_id === input.userId && input.role !== 'owner') {
        throw new UserFacingError('You cannot approve your own request. Ask another approver, admin, or owner.');
    }
    if (request.status !== 'PENDING_APPROVAL' && request.status !== 'APPROVED') {
        throw new UserFacingError(`This request is already ${request.status.toLowerCase()}.`);
    }

    await expenseRepo.recordDecision(request.id, input.userId, input.decision);

    if (input.decision === 'REJECTED') {
        let updated = await expenseRepo.transition(
            request.ref,
            input.companyId,
            ['PENDING_APPROVAL', 'APPROVED'],
            'REJECTED',
        );
        if (!updated) {
            updated = await findOwnedRequest(input.ref, input.companyId);
        }
        await auditRepo.log({
            companyId: request.company_id,
            actorUserId: input.userId,
            action: 'expense_rejected',
            entityType: 'expense_request',
            entityId: request.ref,
        });
        const approvals = await expenseRepo.countApproved(request.id);
        return { request: updated, approvals };
    }

    const approvals = await expenseRepo.countApproved(request.id);
    let updated = request;
    if (approvals >= request.required_approvals) {
        const transitioned = await expenseRepo.transition(
            request.ref,
            input.companyId,
            ['PENDING_APPROVAL'],
            'APPROVED',
        );
        if (transitioned) {
            updated = transitioned;
        } else {
            updated = await findOwnedRequest(input.ref, input.companyId);
        }
    }

    await auditRepo.log({
        companyId: request.company_id,
        actorUserId: input.userId,
        action: 'expense_approved',
        entityType: 'expense_request',
        entityId: request.ref,
        details: { approvals, required: request.required_approvals },
    });
    return { request: updated, approvals };
}

export async function pay(input: {
    ref: string;
    companyId: string;
    userId: string;
    role: Role;
}): Promise<ExpenseRequest> {
    if (!canPay(input.role)) {
        throw new UserFacingError('Only an owner or admin can release an approved payment.');
    }

    const request = await findOwnedRequest(input.ref, input.companyId);
    if (request.status !== 'APPROVED') {
        throw new UserFacingError(`This request cannot be paid while its status is ${request.status}.`);
    }

    const vendor = await vendorRepo.findById(request.vendor_id);
    if (!vendor) {
        throw new Error('Vendor no longer exists.');
    }

    // Claim the row before calling the provider. If another admin clicked Pay a
    // heartbeat earlier, this update matches zero rows and we stop here.
    const claimed = await expenseRepo.transition(
        request.ref,
        input.companyId,
        ['APPROVED'],
        'PROCESSING',
    );
    if (!claimed) {
        throw new UserFacingError('This payment is already being processed.');
    }

    let result;
    try {
        result = await initiateTransfer({
            amountKobo: request.amount_kobo,
            reference: request.ref,
            narration: request.purpose,
            bankCode: vendor.bank_code,
            accountNumber: vendor.account_number,
            accountName: vendor.account_name,
        });
    } catch (error) {
        await expenseRepo.transition(request.ref, input.companyId, ['PROCESSING'], 'APPROVED');
        throw error;
    }

    const status = String(result.status).toUpperCase();
    let next: ExpenseRequest | null;

    if (status === 'SUCCESS' || status === 'COMPLETED') {
        next = await expenseRepo.transition(request.ref, input.companyId, ['PROCESSING'], 'PAID', {
            monnify_reference: result.reference,
            monnify_status: status,
            paid_at: new Date().toISOString(),
        });
    } else if (status === 'PENDING_AUTHORIZATION') {
        next = await expenseRepo.transition(
            request.ref,
            input.companyId,
            ['PROCESSING'],
            'PENDING_AUTHORIZATION',
            { monnify_reference: result.reference, monnify_status: status },
        );
    } else if (status === 'READY_FOR_PAYOUT') {
        // Disbursement is not activated yet. Return the row to APPROVED so the
        // owner can retry once Monnify enables it.
        next = await expenseRepo.transition(request.ref, input.companyId, ['PROCESSING'], 'APPROVED', {
            monnify_reference: result.reference,
            monnify_status: status,
        });
    } else if (['PENDING', 'AWAITING_PROCESSING', 'IN_PROGRESS', 'PROCESSING'].includes(status)) {
        next = await expenseRepo.transition(request.ref, input.companyId, ['PROCESSING'], 'PROCESSING', {
            monnify_reference: result.reference,
            monnify_status: status,
        });
    } else {
        next = await expenseRepo.transition(request.ref, input.companyId, ['PROCESSING'], 'FAILED', {
            monnify_reference: result.reference,
            monnify_status: status,
        });
    }

    await auditRepo.log({
        companyId: request.company_id,
        actorUserId: input.userId,
        action: 'payout_initiated',
        entityType: 'expense_request',
        entityId: request.ref,
        details: { providerStatus: status },
    });

    if (!next) {
        next = await findOwnedRequest(input.ref, input.companyId);
    }
    return next;
}

export async function authorize(input: {
    ref: string;
    otp: string;
    companyId: string;
    userId: string;
    role: Role;
}): Promise<ExpenseRequest> {
    if (!canPay(input.role)) {
        throw new UserFacingError('Only an owner or admin can authorize a payment.');
    }

    const request = await findOwnedRequest(input.ref, input.companyId);
    if (request.status !== 'PENDING_AUTHORIZATION') {
        throw new UserFacingError('This request is not waiting for an OTP.');
    }

    const claimed = await expenseRepo.transition(
        request.ref,
        input.companyId,
        ['PENDING_AUTHORIZATION'],
        'PROCESSING',
    );
    if (!claimed) {
        throw new UserFacingError('This authorization is already being processed.');
    }

    let result;
    try {
        result = await authorizeTransfer(request.monnify_reference ?? request.ref, input.otp);
    } catch (error) {
        await expenseRepo.transition(request.ref, input.companyId, ['PROCESSING'], 'PENDING_AUTHORIZATION');
        throw error;
    }

    const status = String(result.status).toUpperCase();
    let next: ExpenseRequest | null;
    if (status === 'SUCCESS' || status === 'COMPLETED') {
        next = await expenseRepo.transition(request.ref, input.companyId, ['PROCESSING'], 'PAID', {
            monnify_status: status,
            paid_at: new Date().toISOString(),
        });
    } else {
        next = await expenseRepo.transition(request.ref, input.companyId, ['PROCESSING'], 'PROCESSING', {
            monnify_status: status,
        });
    }

    await auditRepo.log({
        companyId: request.company_id,
        actorUserId: input.userId,
        action: 'payout_authorized',
        entityType: 'expense_request',
        entityId: request.ref,
        details: { providerStatus: status },
    });

    if (!next) {
        next = await findOwnedRequest(input.ref, input.companyId);
    }
    return next;
}

export async function companyForRequest(request: ExpenseRequest): Promise<Company> {
    const company = await companyRepo.findById(request.company_id);
    if (!company) {
        throw new Error('Company no longer exists.');
    }
    return company;
}
