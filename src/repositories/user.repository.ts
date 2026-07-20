import type { NettUser } from '../types/domain.js';
import { db, assertData } from './db.js';

export async function findOrCreate(input: {
    telegramUserId: string;
    username?: string;
    fullName: string;
}): Promise<NettUser> {
    const existing = await db()
        .from('nett_users')
        .select('*')
        .eq('telegram_user_id', input.telegramUserId)
        .maybeSingle();
    if (existing.error) {
        throw new Error(`find user: ${existing.error.message}`);
    }

    if (existing.data) {
        const user = existing.data as NettUser;
        const nameChanged = user.full_name !== input.fullName;
        const usernameChanged = user.telegram_username !== (input.username ?? null);

        if (nameChanged || usernameChanged) {
            const updated = await db()
                .from('nett_users')
                .update({ full_name: input.fullName, telegram_username: input.username ?? null })
                .eq('id', user.id)
                .select('*')
                .single();
            return assertData(updated.data as NettUser | null, updated.error, 'update user');
        }
        return user;
    }

    const inserted = await db()
        .from('nett_users')
        .insert({
            telegram_user_id: input.telegramUserId,
            telegram_username: input.username ?? null,
            full_name: input.fullName,
        })
        .select('*')
        .single();
    return assertData(inserted.data as NettUser | null, inserted.error, 'create user');
}

export async function findById(id: string): Promise<NettUser | null> {
    const result = await db().from('nett_users').select('*').eq('id', id).maybeSingle();
    if (result.error) {
        throw new Error(`find user by id: ${result.error.message}`);
    }
    return result.data as NettUser | null;
}
