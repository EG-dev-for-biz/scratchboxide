/**
 * Map `items` through `fn` with at most `limit` calls in flight. Results keep the input order, so callers that
 * merge them get the same output as a sequential loop. The first rejection rejects the whole call.
 */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
    const out: R[] = new Array(items.length);
    let next = 0;
    const workers = Array.from({ length: Math.max(1, Math.min(Math.floor(limit) || 1, items.length)) }, async () => {
        while (next < items.length) {
            const i = next++;
            out[i] = await fn(items[i], i);
        }
    });
    await Promise.all(workers);
    return out;
}
