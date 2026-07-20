import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyMonnifySignature, verifyTelegramSecret } from '../src/utils/security.js';

describe('Monnify webhook signature', () => {
    const raw = JSON.stringify({
        eventType: 'SUCCESSFUL_TRANSACTION',
        eventData: { paymentReference: 'INV-1' },
    });
    const secret = 'test-secret';

    it('verifies HMAC-SHA512 signatures', () => {
        const sig = createHmac('sha512', secret).update(raw).digest('hex');
        expect(verifyMonnifySignature(raw, sig, secret, 'hmac')).toBe(true);
    });

    it('rejects a tampered body', () => {
        const sig = createHmac('sha512', secret).update(raw).digest('hex');
        const tampered = raw.replace('INV-1', 'INV-2');
        expect(verifyMonnifySignature(tampered, sig, secret, 'hmac')).toBe(false);
    });

    it('rejects a wrong signature', () => {
        const wrongSig = createHmac('sha512', 'other-secret').update(raw).digest('hex');
        expect(verifyMonnifySignature(raw, wrongSig, secret, 'hmac')).toBe(false);
    });

    it('supports the legacy SHA512 mode', () => {
        const sig = createHash('sha512').update(secret + raw).digest('hex');
        expect(verifyMonnifySignature(raw, sig, secret, 'legacy')).toBe(true);
    });

    it('auto mode accepts either documented scheme', () => {
        const hmacSig = createHmac('sha512', secret).update(raw).digest('hex');
        const legacySig = createHash('sha512').update(secret + raw).digest('hex');
        expect(verifyMonnifySignature(raw, hmacSig, secret, 'auto')).toBe(true);
        expect(verifyMonnifySignature(raw, legacySig, secret, 'auto')).toBe(true);
    });

    it('rejects missing signatures', () => {
        expect(verifyMonnifySignature(raw, undefined, secret, 'hmac')).toBe(false);
    });
});

describe('Telegram webhook secret', () => {
    it('accepts the matching secret token', () => {
        expect(verifyTelegramSecret('my-secret', 'my-secret')).toBe(true);
    });

    it('rejects a wrong token', () => {
        expect(verifyTelegramSecret('guess', 'my-secret')).toBe(false);
    });

    it('rejects a missing token', () => {
        expect(verifyTelegramSecret(undefined, 'my-secret')).toBe(false);
    });
});
