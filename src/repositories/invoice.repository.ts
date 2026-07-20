import type { CustomerInvoice, InvoiceStatus } from '../types/domain.js';
import { db, assertData } from './db.js';

type NewInvoice = Omit<
    CustomerInvoice,
    'id' | 'created_at' | 'amount_paid_kobo' | 'settlement_amount_kobo' | 'paid_at'
>;

type InvoiceExtras = Partial<
    Pick<
        CustomerInvoice,
        | 'amount_paid_kobo'
        | 'settlement_amount_kobo'
        | 'paid_at'
        | 'monnify_transaction_reference'
        | 'checkout_url'
    >
>;

export async function create(input: NewInvoice): Promise<CustomerInvoice> {
    const result = await db().from('nett_customer_invoices').insert(input).select('*').single();
    return assertData(result.data as CustomerInvoice | null, result.error, 'create invoice');
}

export async function findByRef(ref: string): Promise<CustomerInvoice | null> {
    const result = await db()
        .from('nett_customer_invoices')
        .select('*')
        .eq('ref', ref.toUpperCase())
        .maybeSingle();
    if (result.error) {
        throw new Error(`find invoice: ${result.error.message}`);
    }
    return result.data as CustomerInvoice | null;
}

export async function list(companyId: string, limit = 20): Promise<CustomerInvoice[]> {
    const result = await db()
        .from('nett_customer_invoices')
        .select('*')
        .eq('company_id', companyId)
        .order('created_at', { ascending: false })
        .limit(limit);
    if (result.error) {
        throw new Error(`list invoices: ${result.error.message}`);
    }
    return (result.data ?? []) as CustomerInvoice[];
}

export async function pending(companyId: string): Promise<CustomerInvoice[]> {
    const result = await db()
        .from('nett_customer_invoices')
        .select('*')
        .eq('company_id', companyId)
        .in('status', ['PENDING', 'PARTIALLY_PAID'])
        .order('created_at');
    if (result.error) {
        throw new Error(`pending invoices: ${result.error.message}`);
    }
    return (result.data ?? []) as CustomerInvoice[];
}

export async function updateStatus(
    ref: string,
    status: InvoiceStatus,
    values: InvoiceExtras = {},
): Promise<CustomerInvoice> {
    const result = await db()
        .from('nett_customer_invoices')
        .update({ status, ...values })
        .eq('ref', ref.toUpperCase())
        .select('*')
        .single();
    return assertData(result.data as CustomerInvoice | null, result.error, 'update invoice');
}

export async function collectedThisMonthKobo(companyId: string, startIso: string): Promise<number> {
    const result = await db()
        .from('nett_customer_invoices')
        .select('amount_paid_kobo')
        .eq('company_id', companyId)
        .eq('status', 'PAID')
        .gte('paid_at', startIso);
    if (result.error) {
        throw new Error(`sum collected invoices: ${result.error.message}`);
    }

    const rows = (result.data ?? []) as Array<{ amount_paid_kobo: number }>;
    let total = 0;
    for (const row of rows) {
        total += Number(row.amount_paid_kobo);
    }
    return total;
}
