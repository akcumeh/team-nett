const hits = new Map<string, number[]>();

export function rateLimit(key: string, limit = 10, windowMs = 60_000): boolean {
    const now = Date.now();
    const previous = hits.get(key) ?? [];
    const recent = previous.filter((timestamp) => now - timestamp < windowMs);

    if (recent.length >= limit) {
        hits.set(key, recent);
        return false;
    }

    recent.push(now);
    hits.set(key, recent);
    return true;
}

export function resetRateLimitForTests(): void {
    hits.clear();
}
