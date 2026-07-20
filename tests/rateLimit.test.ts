import { afterEach, describe, expect, it } from 'vitest';
import { rateLimit, resetRateLimitForTests } from '../src/utils/rateLimit.js';

describe('rate limiter', () => {
    afterEach(() => {
        resetRateLimitForTests();
    });

    it('allows requests under the limit', () => {
        expect(rateLimit('user-1', 3)).toBe(true);
        expect(rateLimit('user-1', 3)).toBe(true);
        expect(rateLimit('user-1', 3)).toBe(true);
    });

    it('blocks requests over the limit', () => {
        rateLimit('user-1', 2);
        rateLimit('user-1', 2);
        expect(rateLimit('user-1', 2)).toBe(false);
    });

    it('tracks each key separately', () => {
        rateLimit('user-1', 1);
        expect(rateLimit('user-1', 1)).toBe(false);
        expect(rateLimit('user-2', 1)).toBe(true);
    });
});
