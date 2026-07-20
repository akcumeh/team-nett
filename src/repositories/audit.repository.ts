import { db } from './db.js';

export async function log(input: {
    companyId?: string | null;
    actorUserId?: string | null;
    action: string;
    entityType: string;
    entityId?: string | null;
    details?: Record<string, unknown>;
}): Promise<void> {
    const result = await db().from('nett_audit_logs').insert({
        company_id: input.companyId ?? null,
        actor_user_id: input.actorUserId ?? null,
        action: input.action,
        entity_type: input.entityType,
        entity_id: input.entityId ?? null,
        details: input.details ?? {},
    });
    if (result.error) {
        throw new Error(`audit log: ${result.error.message}`);
    }
}
