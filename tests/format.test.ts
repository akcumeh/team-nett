import { describe, expect, it } from 'vitest';
import { maskAccount, money, monthKey, parseAmountToKobo, splitPipeArgs } from '../src/utils/format.js';

describe('format helpers', () => {
    it('parses plain naira amounts to kobo', () => {
        expect(parseAmountToKobo('780000')).toBe(78_000_000);
        expect(parseAmountToKobo('₦780,000')).toBe(78_000_000);
        expect(parseAmountToKobo('150.75')).toBe(15_075);
    });

    it('parses k and m shorthand', () => {
        expect(parseAmountToKobo('50k')).toBe(5_000_000);
        expect(parseAmountToKobo('2.5m')).toBe(250_000_000);
    });

    it('rejects invalid and non-positive amounts', () => {
        expect(parseAmountToKobo('abc')).toBeNull();
        expect(parseAmountToKobo('0')).toBeNull();
        expect(parseAmountToKobo('-1')).toBeNull();
    });

    it('formats kobo as naira', () => {
        expect(money(78_000_000)).toContain('780,000');
        expect(money(15_075)).toContain('150.75');
    });

    it('masks all but the last four digits of an account', () => {
        expect(maskAccount('0123456789')).toBe('******6789');
    });

    it('splits pipe-separated arguments', () => {
        expect(splitPipeArgs(' 10 | Ada | Design ')).toEqual(['10', 'Ada', 'Design']);
    });

    it('builds a first-day month key', () => {
        expect(monthKey(new Date('2026-07-16T10:00:00Z'))).toBe('2026-07-01');
    });
});
