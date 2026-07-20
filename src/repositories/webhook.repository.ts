import { db } from './db.js';

export async function claim(
    provider: string,
    eventKey: string,
    eventType: string,
    payload: unknown,
): Promise<boolean> {
    const result = await db().from('nett_webhook_events').insert({
        provider,
        event_key: eventKey,
        event_type: eventType,
        payload,
    });

    if (result.error) {
        if (result.error.code === '23505') {
            return false;
        }
        const wrapped = new Error(`claim webhook: ${result.error.message}`);
        throw Object.assign(wrapped, { code: result.error.code });
    }
    return true;
}

export async function finish(eventKey: string, error?: string): Promise<void> {
    const result = await db()
        .from('nett_webhook_events')
        .update({
            processed: !error,
            error: error ?? null,
            processed_at: new Date().toISOString(),
        })
        .eq('event_key', eventKey);
    if (result.error) {
        throw new Error(`finish webhook: ${result.error.message}`);
    }
}
