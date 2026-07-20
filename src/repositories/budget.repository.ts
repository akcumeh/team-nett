import type { Budget } from '../types/domain.js';
import { db, assertData } from './db.js';

export async function upsert(input: Omit<Budget, 'id' | 'created_at'>): Promise<Budget> {
    const result = await db()
        .from('nett_budgets')
        .upsert(input, { onConflict: 'company_id,category,period_month' })
        .select('*')
        .single();
    return assertData(result.data as Budget | null, result.error, 'save budget');
}

export async function list(companyId: string, periodMonth: string): Promise<Budget[]> {
    const result = await db()
        .from('nett_budgets')
        .select('*')
        .eq('company_id', companyId)
        .eq('period_month', periodMonth)
        .order('category');
    if (result.error) {
        throw new Error(`list budgets: ${result.error.message}`);
    }
    return (result.data ?? []) as Budget[];
}
