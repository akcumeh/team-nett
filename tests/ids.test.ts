import { describe, expect, it } from 'vitest';
import { makeInviteCode, makeRef, slugify } from '../src/utils/ids.js';

describe('identifier helpers', () => {
    it('creates readable unique references', () => {
        const first = makeRef('EXP');
        const second = makeRef('EXP');
        expect(first).toMatch(/^EXP-[A-Z0-9]+-[A-F0-9]{8}$/);
        expect(first).not.toBe(second);
    });

    it('creates invite codes', () => {
        expect(makeInviteCode()).toMatch(/^[A-F0-9]{8}$/);
    });

    it('slugifies company names', () => {
        expect(slugify('Ada & Sons Limited')).toMatch(/^ada-sons-limited-[a-f0-9]{4}$/);
    });
});
