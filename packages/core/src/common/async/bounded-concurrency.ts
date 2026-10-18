/**
 * Bounded-concurrency helpers for independent model calls.
 *
 * `mapBounded` runs `fn` over `items` with at most `limit` calls in flight and
 * returns results in input order. A shared AbortController is derived from the
 * caller's signal: the first failure (or the caller aborting) aborts every
 * in-flight call through the signal passed to `fn`, and no further items are
 * started. The first error is rethrown once all started calls have settled, so
 * nothing keeps running after the promise rejects.
 */

export interface MapBoundedOptions {
    /** Maximum calls in flight. Defaults to all items at once. */
    limit?: number;
    /** Caller's abort signal; aborting it aborts every in-flight call. */
    signal?: AbortSignal;
}

export function abortReason(signal: AbortSignal): Error {
    const reason = (signal as AbortSignal & { reason?: unknown }).reason;
    if (reason instanceof Error) return reason;
    const err = new Error(typeof reason === 'string' ? reason : 'The operation was aborted');
    err.name = 'AbortError';
    return err;
}

export function throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) throw abortReason(signal);
}

export async function mapBounded<T, R>(
    items: readonly T[],
    fn: (item: T, index: number, signal: AbortSignal) => Promise<R>,
    options: MapBoundedOptions = {},
): Promise<R[]> {
    const { signal } = options;
    throwIfAborted(signal);
    const limit = Math.max(1, Math.floor(options.limit ?? items.length) || 1);
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal ? (signal as AbortSignal & { reason?: unknown }).reason : undefined);
    signal?.addEventListener('abort', onAbort, { once: true });

    const results = new Array<R>(items.length);
    let next = 0;
    let firstError: unknown;
    let failed = false;

    const worker = async (): Promise<void> => {
        while (!failed && !controller.signal.aborted) {
            const index = next++;
            if (index >= items.length) return;
            try {
                results[index] = await fn(items[index], index, controller.signal);
            } catch (err) {
                if (!failed) {
                    failed = true;
                    firstError = err;
                    controller.abort(err);
                }
                return;
            }
        }
    };

    try {
        await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    } finally {
        signal?.removeEventListener('abort', onAbort);
    }
    if (failed) throw firstError;
    throwIfAborted(signal);
    return results;
}

/**
 * Run independent tasks concurrently with shared abort: the first failure
 * aborts the others' signal. Results keep their positions.
 */
export function allAbortable<R extends readonly unknown[]>(
    tasks: { [K in keyof R]: (signal: AbortSignal) => Promise<R[K]> },
    signal?: AbortSignal,
): Promise<R> {
    return mapBounded(tasks as unknown as ReadonlyArray<(s: AbortSignal) => Promise<unknown>>, (task, _i, s) => task(s), { signal }) as unknown as Promise<R>;
}
