import { describe, expect, it } from 'vitest';
import { canApprove, canPay, hasRole } from '../src/utils/permissions.js';

describe('role permissions', () => {
    it('enforces the role hierarchy', () => {
        expect(hasRole('owner', 'admin')).toBe(true);
        expect(hasRole('approver', 'requester')).toBe(true);
        expect(hasRole('viewer', 'requester')).toBe(false);
    });

    it('limits who can approve', () => {
        expect(canApprove('approver')).toBe(true);
        expect(canApprove('requester')).toBe(false);
    });

    it('limits who can release payouts', () => {
        expect(canPay('owner')).toBe(true);
        expect(canPay('admin')).toBe(true);
        expect(canPay('approver')).toBe(false);
    });
});
