import { createHash } from 'node:crypto';
import * as webhookRepo from '../repositories/webhook.repository.js';
import * as expenseRepo from '../repositories/expense.repository.js';
import * as companyRepo from '../repositories/company.repository.js';
import * as auditRepo from '../repositories/audit.repository.js';
import * as invoiceService from './invoice.service.js';
import { push } from './telegram.service.js';
import { money } from '../utils/format.js';

function nairaToKobo(naira: number): number {
    return Math.round(naira * 100);
}

function extractEventKey(payload: any, rawBody: string): string {
    const data = payload?.eventData ?? payload?.data ?? {};
    const reference =
        data.paymentReference ?? data.reference ?? data.transactionReference ?? data.refundReference;
    if (reference) {
        return String(reference);
    }
    const bodyHash = createHash('sha256').update(rawBody).digest('hex');
    return `${payload?.eventType ?? 'UNKNOWN'}-${bodyHash}`;
}

// Claim first, process second, respond only after processing finishes. The claim
// is an insert against a unique key, so a redelivered event is dropped before it
// can touch any money state.
export async function processMonnifyWebhook(payload: any, rawBody: string): Promise<void> {
    const type = String(payload?.eventType ?? 'UNKNOWN');
    const data = payload?.eventData ?? payload?.data ?? {};
    const key = `${type}:${extractEventKey(payload, rawBody)}`;

    const claimed = await webhookRepo.claim('monnify', key, type, payload);
    if (!claimed) {
        return;
    }

    try {
        if (type === 'SUCCESSFUL_TRANSACTION' || type === 'REJECTED_PAYMENT') {
            await handleCollectionEvent(type, data);
        }

        if (['SUCCESSFUL_DISBURSEMENT', 'FAILED_DISBURSEMENT', 'REVERSED_DISBURSEMENT'].includes(type)) {
            await handleDisbursementEvent(type, data);
        }

        await webhookRepo.finish(key);
    } catch (error) {
        let message = String(error);
        if (error instanceof Error) {
            message = error.message;
        }
        await webhookRepo.finish(key, message);
        throw error;
    }
}

async function handleCollectionEvent(type: string, data: any): Promise<void> {
    const ref = String(data.paymentReference ?? '');
    if (!ref) {
        return;
    }

    let status = String(data.paymentStatus ?? 'PAID');
    if (type === 'REJECTED_PAYMENT') {
        status = 'FAILED';
    }

    const amountPaidNaira = Number(data.amountPaid ?? data.amount ?? 0);
    const settlementNaira = Number(data.settlementAmount ?? data.amountPaid ?? data.amount ?? 0);

    const invoice = await invoiceService.applyProviderPayment({
        ref,
        status,
        amountPaidKobo: nairaToKobo(amountPaidNaira),
        settlementAmountKobo: nairaToKobo(settlementNaira),
        transactionReference: data.transactionReference,
        paidOn: data.paidOn,
    });
    if (!invoice) {
        return;
    }

    const company = await companyRepo.findById(invoice.company_id);
    if (company?.telegram_chat_id) {
        await push(
            company.telegram_chat_id,
            `COLLECTION UPDATE\n${invoice.ref}\n${invoice.customer_name}\n${money(invoice.amount_paid_kobo)}\nStatus: ${invoice.status}`,
        );
    }
}

async function handleDisbursementEvent(type: string, data: any): Promise<void> {
    const ref = String(data.reference ?? data.transactionReference ?? '');
    if (!ref) {
        return;
    }

    const expense = await expenseRepo.findByRef(ref);
    if (!expense) {
        return;
    }

    let nextStatus: 'PAID' | 'FAILED' = 'FAILED';
    if (type === 'SUCCESSFUL_DISBURSEMENT') {
        nextStatus = 'PAID';
    }

    let paidAt = expense.paid_at;
    if (nextStatus === 'PAID') {
        paidAt = new Date().toISOString();
    }

    const updated = await expenseRepo.transition(
        expense.ref,
        expense.company_id,
        ['PROCESSING', 'PENDING_AUTHORIZATION', 'APPROVED'],
        nextStatus,
        { monnify_status: String(data.status ?? type), paid_at: paidAt },
    );
    if (!updated) {
        return;
    }

    await auditRepo.log({
        companyId: expense.company_id,
        action: 'payout_provider_update',
        entityType: 'expense_request',
        entityId: expense.ref,
        details: { webhookType: type },
    });

    const company = await companyRepo.findById(expense.company_id);
    if (company?.telegram_chat_id) {
        await push(company.telegram_chat_id, `PAYOUT UPDATE\n${updated.ref}\nStatus: ${updated.status}`);
    }
}
