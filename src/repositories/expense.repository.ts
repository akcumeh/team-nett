import type { Approval, ExpenseRequest, RequestStatus } from '../types/domain.js';
import { db, assertData } from './db.js';

type NewExpenseRequest = Omit<
    ExpenseRequest,
    'id' | 'created_at' | 'paid_at' | 'monnify_reference' | 'monnify_status'
>;

type ExpenseExtras = Partial<
    Pick<ExpenseRequest, 'monnify_reference' | 'monnify_status' | 'paid_at'>
>;

export async function create(input: NewExpenseRequest): Promise<ExpenseRequest> {
    const result = await db().from('nett_expense_requests').insert(input).select('*').single();
    return assertData(result.data as ExpenseRequest | null, result.error, 'create expense request');
}

export async function findByRef(ref: string): Promise<ExpenseRequest | null> {
    const result = await db()
        .from('nett_expense_requests')
        .select('*')
        .eq('ref', ref.toUpperCase())
        .maybeSingle();
    if (result.error) {
        throw new Error(`find expense: ${result.error.message}`);
    }
    return result.data as ExpenseRequest | null;
}

export async function findById(id: string): Promise<ExpenseRequest | null> {
    const result = await db().from('nett_expense_requests').select('*').eq('id', id).maybeSingle();
    if (result.error) {
        throw new Error(`find expense by id: ${result.error.message}`);
    }
    return result.data as ExpenseRequest | null;
}

export async function list(companyId: string, limit = 20): Promise<ExpenseRequest[]> {
    const result = await db()
        .from('nett_expense_requests')
        .select('*')
        .eq('company_id', companyId)
        .order('created_at', { ascending: false })
        .limit(limit);
    if (result.error) {
        throw new Error(`list expenses: ${result.error.message}`);
    }
    return (result.data ?? []) as ExpenseRequest[];
}

export async function listByStatuses(
    companyId: string,
    statuses: RequestStatus[],
): Promise<ExpenseRequest[]> {
    const result = await db()
        .from('nett_expense_requests')
        .select('*')
        .eq('company_id', companyId)
        .in('status', statuses)
        .order('created_at', { ascending: false });
    if (result.error) {
        throw new Error(`list expenses by status: ${result.error.message}`);
    }
    return (result.data ?? []) as ExpenseRequest[];
}

// Conditional state transition. The update only fires when the row still belongs to
// this company and sits in an expected status. Zero rows back means someone else won
// the race, and the caller treats null as "already handled". This is what stops a
// double-click on Pay from paying twice.
export async function transition(
    ref: string,
    companyId: string,
    fromStatuses: RequestStatus[],
    toStatus: RequestStatus,
    extra: ExpenseExtras = {},
): Promise<ExpenseRequest | null> {
    const result = await db()
        .from('nett_expense_requests')
        .update({ status: toStatus, ...extra })
        .eq('ref', ref.toUpperCase())
        .eq('company_id', companyId)
        .in('status', fromStatuses)
        .select('*')
        .maybeSingle();
    if (result.error) {
        throw new Error(`transition expense: ${result.error.message}`);
    }
    return result.data as ExpenseRequest | null;
}

export async function recordDecision(
    requestId: string,
    userId: string,
    decision: 'APPROVED' | 'REJECTED',
    comment?: string,
): Promise<Approval> {
    const row = {
        expense_request_id: requestId,
        user_id: userId,
        decision,
        comment: comment ?? null,
    };
    const result = await db()
        .from('nett_approvals')
        .upsert(row, { onConflict: 'expense_request_id,user_id' })
        .select('*')
        .single();
    return assertData(result.data as Approval | null, result.error, 'record approval');
}

export async function approvals(requestId: string): Promise<Approval[]> {
    const result = await db()
        .from('nett_approvals')
        .select('*')
        .eq('expense_request_id', requestId)
        .order('created_at');
    if (result.error) {
        throw new Error(`list approvals: ${result.error.message}`);
    }
    return (result.data ?? []) as Approval[];
}

export async function countApproved(requestId: string): Promise<number> {
    const result = await db()
        .from('nett_approvals')
        .select('*', { count: 'exact', head: true })
        .eq('expense_request_id', requestId)
        .eq('decision', 'APPROVED');
    if (result.error) {
        throw new Error(`count approvals: ${result.error.message}`);
    }
    return result.count ?? 0;
}

export async function paidThisMonthKobo(companyId: string, startIso: string): Promise<number> {
    const result = await db()
        .from('nett_expense_requests')
        .select('amount_kobo')
        .eq('company_id', companyId)
        .eq('status', 'PAID')
        .gte('paid_at', startIso);
    if (result.error) {
        throw new Error(`sum paid expenses: ${result.error.message}`);
    }

    const rows = (result.data ?? []) as Array<{ amount_kobo: number }>;
    let total = 0;
    for (const row of rows) {
        total += Number(row.amount_kobo);
    }
    return total;
}

export async function paidByCategoryKobo(
    companyId: string,
    startIso: string,
): Promise<Record<string, number>> {
    const result = await db()
        .from('nett_expense_requests')
        .select('amount_kobo,category')
        .eq('company_id', companyId)
        .eq('status', 'PAID')
        .gte('paid_at', startIso);
    if (result.error) {
        throw new Error(`sum category expenses: ${result.error.message}`);
    }

    const rows = (result.data ?? []) as Array<{ amount_kobo: number; category: string }>;
    const totals: Record<string, number> = {};
    for (const row of rows) {
        const current = totals[row.category] ?? 0;
        totals[row.category] = current + Number(row.amount_kobo);
    }
    return totals;
}
