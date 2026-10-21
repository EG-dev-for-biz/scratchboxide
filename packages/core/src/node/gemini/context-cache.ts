/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/
import * as crypto from 'crypto';
import type { Content } from '@google/genai';
import type { GeminiToolConfig } from './tool-registry';
import type { FetchLike } from './gemini-client';

/**
 * Explicit Vertex context caches (cachedContents) for the chat's stable prefix: the system instruction and the tool
 * declarations. A call whose prefix has a ready cache sends `cachedContent` instead of them, and the model reads the
 * prefix from the cache: measured 2026-10-20 on gemini-3.8-flash with the 32k-token catalog prefix, 1.9-3.6 s to the
 * first token against 5.4-7.9 s without (docs/processes/fast_chat_routing.md). Implicit prefix caching hit about one
 * request in six on gemini-4-argon, and gemini-4-argon refuses explicit caches ("does not support explicit context
 * caching"), so for it this does nothing after the first refusal.
 *
 * A cache is created in the background the first time a prefix is seen (that call goes without it), lives for an hour
 * and is recreated when it is close to expiring. The content sent is identical either way: the cache only holds the
 * prefix the call would otherwise carry. SCRATCHBOX_CHAT_CONTEXT_CACHE=0 turns it off.
 */
export const CONTEXT_CACHE_TTL_S = 3600;
/** A cache this close to expiry is not used; a new one is made. */
const RENEW_BEFORE_MS = 5 * 60_000;
/** After a failed creation, the same prefix is not tried again for this long. */
const RETRY_AFTER_MS = 10 * 60_000;
const MAX_ENTRIES = 32;

export function contextCacheEnabled(): boolean {
    return process.env.SCRATCHBOX_CHAT_CONTEXT_CACHE !== '0';
}

export interface ContextCacheTarget {
    /** e.g. https://aiplatform.googleapis.com/v1/projects/p/locations/global */
    apiBase: string;
    projectId: string;
    location: string;
    token: string;
}

type Entry =
    | { state: 'creating' }
    | { state: 'ready'; name: string; expiresAt: number }
    | { state: 'failed'; until: number; reason: string };

export class ContextCacheManager {
    private readonly entries = new Map<string, Entry>();
    /** Models that refused explicit caching; never asked again in this process. */
    private readonly unsupported = new Map<string, string>();

    constructor(
        private readonly fetchFn: () => FetchLike,
        private readonly now: () => number = Date.now,
        private readonly log: (line: string) => void = line => console.log(line)
    ) {}

    static key(model: string, systemInstruction: Content | undefined, tools: GeminiToolConfig[] | undefined): string {
        return crypto.createHash('sha256').update(JSON.stringify([model, systemInstruction ?? null, tools ?? null])).digest('hex');
    }

    /** Why `model` takes no explicit cache, if it refused one. */
    unsupportedReason(model: string): string | undefined {
        return this.unsupported.get(model);
    }

    /**
     * The name of a ready cache for this prefix, or undefined (then a creation is started in the background unless
     * one is running, recently failed, or the model refuses caches).
     */
    lookup(target: ContextCacheTarget, model: string, systemInstruction: Content | undefined, tools: GeminiToolConfig[] | undefined): string | undefined {
        if (!contextCacheEnabled() || this.unsupported.has(model)) return undefined;
        const key = ContextCacheManager.key(model, systemInstruction, tools);
        const entry = this.entries.get(key);
        const now = this.now();
        if (entry?.state === 'ready' && entry.expiresAt - now > RENEW_BEFORE_MS) return entry.name;
        if (entry?.state === 'creating') return undefined;
        if (entry?.state === 'failed' && entry.until > now) return undefined;
        this.entries.set(key, { state: 'creating' });
        void this.create(key, target, model, systemInstruction, tools);
        return undefined;
    }

    /** Forget a cache the server no longer has (a call naming it failed with 404 / NOT_FOUND). */
    invalidate(name: string): void {
        for (const [key, entry] of this.entries) {
            if (entry.state === 'ready' && entry.name === name) this.entries.delete(key);
        }
    }

    /** Wait for running creations (tests and scripts). */
    async settled(): Promise<void> {
        while ([...this.entries.values()].some(e => e.state === 'creating')) {
            await new Promise(r => setTimeout(r, 5));
        }
    }

    private async create(key: string, target: ContextCacheTarget, model: string, systemInstruction: Content | undefined, tools: GeminiToolConfig[] | undefined): Promise<void> {
        const startedAt = this.now();
        try {
            const res = await this.fetchFn()(`${target.apiBase}/cachedContents`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${target.token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: `projects/${target.projectId}/locations/${target.location}/publishers/google/models/${model}`,
                    ...(systemInstruction ? { systemInstruction } : {}),
                    ...(tools ? { tools } : {}),
                    ttl: `${CONTEXT_CACHE_TTL_S}s`
                })
            });
            const body = await res.text();
            if (!res.ok) {
                if (res.status === 400 && /does not support explicit context caching|not supported/i.test(body)) {
                    this.unsupported.set(model, body.slice(0, 200));
                    this.entries.delete(key);
                    this.log(`[context-cache] ${model} takes no explicit cache: ${body.slice(0, 200)}`);
                    return;
                }
                throw new Error(`cachedContents create failed (${res.status}): ${body.slice(0, 300)}`);
            }
            const json = JSON.parse(body) as { name?: string; expireTime?: string; usageMetadata?: { totalTokenCount?: number } };
            if (!json.name) throw new Error('cachedContents create returned no name');
            const expiresAt = json.expireTime ? Date.parse(json.expireTime) : startedAt + CONTEXT_CACHE_TTL_S * 1000;
            this.entries.set(key, { state: 'ready', name: json.name, expiresAt });
            this.prune();
            this.log(`[context-cache] ${model} cache ready in ${this.now() - startedAt} ms: ${json.usageMetadata?.totalTokenCount ?? '?'} tokens, until ${new Date(expiresAt).toISOString()}`);
        } catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            this.entries.set(key, { state: 'failed', until: this.now() + RETRY_AFTER_MS, reason });
            this.log(`[context-cache] ${model} cache not created (calls go without it for ${RETRY_AFTER_MS / 60_000} min): ${reason}`);
        }
    }

    private prune(): void {
        while (this.entries.size > MAX_ENTRIES) {
            const oldest = this.entries.keys().next().value as string;
            this.entries.delete(oldest);
        }
    }
}
