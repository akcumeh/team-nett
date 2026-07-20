import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

function safeEqualHex(a: string, b: string): boolean {
    try {
        const bufferA = Buffer.from(a, 'hex');
        const bufferB = Buffer.from(b, 'hex');
        if (bufferA.length !== bufferB.length) {
            return false;
        }
        return timingSafeEqual(bufferA, bufferB);
    } catch {
        return false;
    }
}

export function verifyMonnifySignature(
    rawBody: string,
    supplied: string | undefined,
    secret: string,
    mode: 'auto' | 'hmac' | 'legacy',
): boolean {
    if (!supplied || !secret) {
        return false;
    }

    const hmac = createHmac('sha512', secret).update(rawBody).digest('hex');
    const legacy = createHash('sha512').update(secret + rawBody).digest('hex');
    const suppliedLower = supplied.toLowerCase();

    if (mode === 'hmac') {
        return safeEqualHex(hmac, suppliedLower);
    }
    if (mode === 'legacy') {
        return safeEqualHex(legacy, suppliedLower);
    }
    return safeEqualHex(hmac, suppliedLower) || safeEqualHex(legacy, suppliedLower);
}

// The x-telegram-bot-api-secret-token header must match the secret_token we gave
// setWebhook. Hashing both sides first means timingSafeEqual never throws on a
// length mismatch, and the comparison stays constant-time.
export function verifyTelegramSecret(supplied: string | undefined, expected: string): boolean {
    if (!supplied || !expected) {
        return false;
    }
    const hashedSupplied = createHash('sha256').update(supplied).digest();
    const hashedExpected = createHash('sha256').update(expected).digest();
    return timingSafeEqual(hashedSupplied, hashedExpected);
}
