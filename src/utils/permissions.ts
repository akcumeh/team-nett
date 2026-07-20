import type { Role } from '../types/domain.js';

const rank: Record<Role, number> = {
    viewer: 0,
    requester: 1,
    approver: 2,
    admin: 3,
    owner: 4,
};

export function hasRole(actual: Role, minimum: Role): boolean {
    return rank[actual] >= rank[minimum];
}

export function canApprove(role: Role): boolean {
    return role === 'owner' || role === 'admin' || role === 'approver';
}

export function canPay(role: Role): boolean {
    return role === 'owner' || role === 'admin';
}
