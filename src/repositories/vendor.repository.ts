import type { Vendor } from '../types/domain.js';
import { db, assertData } from './db.js';

export async function create(input: Omit<Vendor, 'id' | 'created_at'>): Promise<Vendor> {
    const result = await db().from('nett_vendors').insert(input).select('*').single();
    return assertData(result.data as Vendor | null, result.error, 'create vendor');
}

export async function findByNickname(companyId: string, nickname: string): Promise<Vendor | null> {
    const result = await db()
        .from('nett_vendors')
        .select('*')
        .eq('company_id', companyId)
        .ilike('nickname', nickname)
        .maybeSingle();
    if (result.error) {
        throw new Error(`find vendor: ${result.error.message}`);
    }
    return result.data as Vendor | null;
}

export async function findById(id: string): Promise<Vendor | null> {
    const result = await db().from('nett_vendors').select('*').eq('id', id).maybeSingle();
    if (result.error) {
        throw new Error(`find vendor by id: ${result.error.message}`);
    }
    return result.data as Vendor | null;
}

export async function list(companyId: string): Promise<Vendor[]> {
    const result = await db()
        .from('nett_vendors')
        .select('*')
        .eq('company_id', companyId)
        .order('nickname');
    if (result.error) {
        throw new Error(`list vendors: ${result.error.message}`);
    }
    return (result.data ?? []) as Vendor[];
}
