import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { getConfig } from '../config/index.js';

let client: SupabaseClient | null = null;

export function db(): SupabaseClient {
    if (!client) {
        const config = getConfig();
        client = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
            auth: { persistSession: false, autoRefreshToken: false },
        });
    }
    return client;
}

export function resetDbForTests(): void {
    client = null;
}

export function assertData<T>(
    data: T | null,
    error: { message: string; code?: string } | null,
    context: string,
): T {
    if (error) {
        const wrapped = new Error(`${context}: ${error.message}`);
        throw Object.assign(wrapped, { code: error.code });
    }
    if (data === null) {
        throw new Error(`${context}: no data returned`);
    }
    return data;
}
