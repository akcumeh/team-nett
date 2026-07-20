import type { Session } from '../types/domain.js';
import { db } from './db.js';

export async function get(userId: string): Promise<Session | null> {
    const result = await db().from('nett_sessions').select('*').eq('user_id', userId).maybeSingle();
    if (result.error) {
        throw new Error(`get session: ${result.error.message}`);
    }
    if (!result.data) {
        return null;
    }

    const session = result.data as Session;
    const expired = new Date(session.expires_at) <= new Date();
    if (expired) {
        await clear(userId);
        return null;
    }
    return session;
}

export async function set(
    userId: string,
    state: string,
    context: Record<string, unknown>,
    ttlMinutes = 10,
): Promise<void> {
    const expiresAt = new Date(Date.now() + ttlMinutes * 60_000).toISOString();

    const result = await db()
        .from('nett_sessions')
        .upsert(
            {
                user_id: userId,
                state,
                context,
                expires_at: expiresAt,
                updated_at: new Date().toISOString(),
            },
            { onConflict: 'user_id' },
        );
    if (result.error) {
        throw new Error(`set session: ${result.error.message}`);
    }
}

export async function clear(userId: string): Promise<void> {
    const result = await db().from('nett_sessions').delete().eq('user_id', userId);
    if (result.error) {
        throw new Error(`clear session: ${result.error.message}`);
    }
}
