import { randomBytes } from 'node:crypto';

export function makeRef(prefix: string): string {
    const stamp = Date.now().toString(36).toUpperCase();
    const random = randomBytes(4).toString('hex').toUpperCase();
    return `${prefix}-${stamp}-${random}`;
}

export function makeInviteCode(): string {
    return randomBytes(4).toString('hex').toUpperCase();
}

export function slugify(value: string): string {
    let base = value.toLowerCase();
    base = base.replace(/[^a-z0-9]+/g, '-');
    base = base.replace(/^-|-$/g, '');
    base = base.slice(0, 40);

    if (!base) {
        base = 'company';
    }

    const suffix = randomBytes(2).toString('hex');
    return `${base}-${suffix}`;
}
