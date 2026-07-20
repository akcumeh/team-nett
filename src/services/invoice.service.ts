import type { Company, CustomerInvoice, InvoiceStatus, NettUser } from '../types/domain.js';
import * as invoiceRepo from '../repositories/invoice.repository.js';
import * as auditRepo from '../repositories/audit.repository.js';
import { initializeCheckout, verifyPayment } from './monnify.service.js';
import { UserFacingError } from '../utils/errors.js';
import { makeRef } from '../utils/ids.js';

export async function createInvoice(input: {
    company: Company;
    creator: NettUser;
    customerName: string;
    customerEmail: string;
    amountKobo: number;
    description: string;
    dueAt?: string | null;
}): Promise<CustomerInvoice> {
    const ref = makeRef('INV');
    const checkout = await initializeCheckout({
        amountKobo: input.amountKobo,
        paymentReference: ref,
        customerName: input.customerName,
        customerEmail: input.customerEmail,
        description: input.description,
    });

    const invoice = await invoiceRepo.create({
        ref,
        company_id: input.company.id,
        created_by: input.creator.id,
        customer_name: input.customerName,
        customer_email: input.customerEmail,
        amount_kobo: input.amountKobo,
        currency: input.company.base_currency,
        description: input.description,
        status: 'PENDING',
        checkout_url: checkout.checkoutUrl,
        monnify_transaction_reference: checkout.transactionReference,
        due_at: input.dueAt ?? null,
    });

    await auditRepo.log({
        companyId: input.company.id,
        actorUserId: input.creator.id,
        action: 'customer_invoice_created',
        entityType: 'customer_invoice',
        entityId: ref,
        details: { amountKobo: input.amountKobo, customer: input.customerName },
    });
    return invoice;
}

function normalizePaymentStatus(status: string): InvoiceStatus {
    const upper = status.toUpperCase();
    if (upper === 'PAID') return 'PAID';
    if (upper === 'PARTIALLY_PAID') return 'PARTIALLY_PAID';
    if (upper === 'OVERPAID') return 'OVERPAID';
    if (upper === 'REVERSED') return 'REVERSED';
    if (upper === 'EXPIRED') return 'EXPIRED';
    if (upper === 'FAILED') return 'FAILED';
    return 'PENDING';
}

export async function reconcileInvoice(ref: string, companyId: string): Promise<CustomerInvoice> {
    const existing = await invoiceRepo.findByRef(ref);
    if (!existing || existing.company_id !== companyId) {
        throw new UserFacingError('Invoice not found.');
    }

    const verified = await verifyPayment(ref);
    const status = normalizePaymentStatus(verified.paymentStatus);

    let paidAt = existing.paid_at;
    if (status === 'PAID' || status === 'OVERPAID') {
        paidAt = verified.paidOn ?? new Date().toISOString();
    }

    return invoiceRepo.updateStatus(ref, status, {
        amount_paid_kobo: verified.amountPaidKobo,
        settlement_amount_kobo: verified.settlementAmountKobo,
        paid_at: paidAt,
        monnify_transaction_reference:
            verified.transactionReference ?? existing.monnify_transaction_reference,
    });
}

// Called from the webhook processor. Provider events carry no actor, so the
// invoice row itself is the authority on which company gets notified.
export async function applyProviderPayment(input: {
    ref: string;
    status: string;
    amountPaidKobo: number;
    settlementAmountKobo: number;
    transactionReference?: string;
    paidOn?: string;
}): Promise<CustomerInvoice | null> {
    const existing = await invoiceRepo.findByRef(input.ref);
    if (!existing) {
        return null;
    }

    const authoritativeStatus = input.status.toUpperCase();
    let status = normalizePaymentStatus(authoritativeStatus);
    if (authoritativeStatus === 'PAID' && input.amountPaidKobo < existing.amount_kobo) {
        status = 'PARTIALLY_PAID';
    }
    if (authoritativeStatus === 'PAID' && input.amountPaidKobo > existing.amount_kobo) {
        status = 'OVERPAID';
    }

    let paidAt = existing.paid_at;
    if (status === 'PAID' || status === 'OVERPAID') {
        paidAt = input.paidOn ?? new Date().toISOString();
    }

    const updated = await invoiceRepo.updateStatus(input.ref, status, {
        amount_paid_kobo: input.amountPaidKobo,
        settlement_amount_kobo: input.settlementAmountKobo,
        paid_at: paidAt,
        monnify_transaction_reference:
            input.transactionReference ?? existing.monnify_transaction_reference,
    });

    await auditRepo.log({
        companyId: existing.company_id,
        action: 'customer_invoice_provider_update',
        entityType: 'customer_invoice',
        entityId: existing.ref,
        details: { status, amountPaidKobo: input.amountPaidKobo },
    });
    return updated;
}
