export function money(amountKobo: number, currency = 'NGN'): string {
    const naira = amountKobo / 100;
    const formatter = new Intl.NumberFormat('en-NG', {
        style: 'currency',
        currency,
        maximumFractionDigits: 2,
    });
    return formatter.format(naira);
}

export function parseAmountToKobo(input: string): number | null {
    let clean = input.trim().toLowerCase();
    clean = clean.replace(/[₦$£€\s]/g, '');
    clean = clean.replace(/,/g, '');

    const match = clean.match(/^(\d+(?:\.\d+)?)(k|m)?$/);
    if (!match) {
        return null;
    }

    const value = Number(match[1]);
    if (!Number.isFinite(value) || value <= 0) {
        return null;
    }

    let multiplier = 1;
    if (match[2] === 'k') {
        multiplier = 1_000;
    } else if (match[2] === 'm') {
        multiplier = 1_000_000;
    }

    const kobo = Math.round(value * multiplier * 100);
    if (kobo <= 0) {
        return null;
    }
    return kobo;
}

export function maskAccount(account: string): string {
    if (account.length <= 4) {
        return account;
    }
    const hidden = '*'.repeat(account.length - 4);
    const visible = account.slice(-4);
    return hidden + visible;
}

export function monthKey(date = new Date()): string {
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    return `${year}-${month}-01`;
}

export function splitPipeArgs(value: string): string[] {
    const parts = value.split('|');
    const trimmed = parts.map((part) => part.trim());
    return trimmed.filter(Boolean);
}

const HTML_ESCAPES: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
};

export function escapeHtml(value: string): string {
    return value.replace(/[&<>"']/g, (char) => {
        return HTML_ESCAPES[char] ?? char;
    });
}
