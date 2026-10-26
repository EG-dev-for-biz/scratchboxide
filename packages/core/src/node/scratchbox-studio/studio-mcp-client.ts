/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * A client for the hosted Scratchbox Studio MCP (scratchbox.ai/api/mcp/canvas, docs/integrations/mcp/README.md): JSON-RPC
 * over Streamable HTTP, authenticated by the internal secret, user id and workspace id headers. Used for the workspace's
 * Style DNA: `ai.generate_images` with `inheritCanvasStyle` applies the saved canvas/workspace style, and explicit
 * presets override fields of it. Generation is a durable, billed job: queued, then polled with `operation.get` until
 * terminal, and its image fetched from the workspace's public storage URL.
 */

export interface StudioMcpConfig {
    endpoint: string;
    secret: string;
    userId: string;
    workspaceId: string;
    canvasId?: string;
}

/** The connection from SCRATCHBOX_MCP_* (secrets.json, loaded by the server); undefined when any required value is missing. */
export function studioMcpConfigFromEnv(env: Record<string, string | undefined> = process.env): StudioMcpConfig | undefined {
    const secret = env.SCRATCHBOX_MCP_SECRET?.trim(), userId = env.SCRATCHBOX_MCP_USER_ID?.trim(), workspaceId = env.SCRATCHBOX_MCP_WORKSPACE_ID?.trim();
    if (!secret || !userId || !workspaceId) return undefined;
    const canvasId = env.SCRATCHBOX_MCP_CANVAS_ID?.trim();
    return { endpoint: env.SCRATCHBOX_MCP_ENDPOINT?.trim() || 'https://scratchbox.ai/api/mcp/canvas', secret, userId, workspaceId, ...(canvasId ? { canvasId } : {}) };
}

export class StudioMcpError extends Error {
    constructor(message: string, readonly details: Record<string, unknown> = {}) {
        super(message);
        this.name = 'StudioMcpError';
    }
}

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string>; arrayBuffer(): Promise<ArrayBuffer>; headers: { get(name: string): string | null } }>;

export interface StudioCallOptions {
    fetch?: FetchLike;
    signal?: AbortSignal;
}

const fetchOf = (o: StudioCallOptions): FetchLike => o.fetch ?? (globalThis.fetch as unknown as FetchLike);

/** The JSON-RPC result of the last `data:` event of a Streamable HTTP answer (or a plain JSON body). */
export function parseMcpAnswer(body: string): { result?: { content?: Array<{ type: string; text?: string }>; structuredContent?: Record<string, unknown>; isError?: boolean }; error?: { code: number; message: string } } {
    const events = body.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).filter(Boolean);
    const json = events.length ? events[events.length - 1] : body.trim();
    try {
        return JSON.parse(json);
    } catch {
        throw new StudioMcpError(`Scratchbox Studio answered with something that is not JSON-RPC: ${body.slice(0, 200)}`);
    }
}

/** Calls one Studio MCP tool and returns its structured content; throws StudioMcpError on an HTTP, JSON-RPC or tool error. */
export async function callStudioTool(config: StudioMcpConfig, name: string, args: Record<string, unknown>, options: StudioCallOptions = {}): Promise<Record<string, unknown>> {
    const res = await fetchOf(options)(config.endpoint, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
            'x-internal-secret': config.secret,
            'x-internal-user-id': config.userId,
            'x-scratchbox-workspace-id': config.workspaceId
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
        ...(options.signal ? { signal: options.signal } : {})
    });
    const body = await res.text();
    if (!res.ok) throw new StudioMcpError(`Scratchbox Studio ${name} failed (HTTP ${res.status}): ${body.slice(0, 200)}`, { status: res.status, tool: name });
    const answer = parseMcpAnswer(body);
    if (answer.error) throw new StudioMcpError(`Scratchbox Studio ${name} failed: ${answer.error.message}`, { code: answer.error.code, tool: name });
    const text = answer.result?.content?.map(c => c.text ?? '').join(' ').trim() ?? '';
    if (answer.result?.isError) throw new StudioMcpError(`Scratchbox Studio ${name} failed: ${text.slice(0, 300)}`, { tool: name });
    return answer.result?.structuredContent ?? (text ? safeJson(text) : {});
}

function safeJson(text: string): Record<string, unknown> {
    try { const v = JSON.parse(text); return v && typeof v === 'object' ? v : { text }; } catch { return { text }; }
}

/**
 * Explicit presets laid over the inherited Style DNA. Labels come from `ai.list_image_presets`; an unknown label fails
 * before the job is queued.
 */
export interface StudioImagePresets {
    framing?: string; style?: string; lens?: string; lighting?: string; filmStock?: string; filterEffect?: string;
    cameraBody?: string; cinemaLens?: string; depthOfField?: string; colorPalette?: string; tonalCurve?: string;
    cameraShake?: string; microTexture?: string;
}

export interface StyleDnaImageRequest {
    prompt: string;
    /** Stable per request; reused only to retry the exact same request (the server rejects a changed one). */
    idempotencyKey: string;
    aspectRatio?: '1:1' | '16:9' | '9:16' | '4:3' | '3:4' | '2:3' | '3:2' | '21:9' | '4:5' | '5:4';
    presets?: StudioImagePresets;
    /** Refuse to queue when the server's per-image credit estimate is higher. */
    maxEstimatedCost?: number;
}

export interface StyleDnaImage {
    data: Buffer;
    mimeType: string;
    /** The image's public storage URL in the workspace. */
    url: string;
    operationId: string;
    /** The presets the server actually applied (inherited Style DNA with the explicit overrides). */
    effectivePresets: Record<string, string>;
}

export interface StyleDnaPollOptions extends StudioCallOptions {
    sleep?: (ms: number) => Promise<void>;
    pollMs?: number;
    timeoutMs?: number;
}

/** One image in the workspace's Style DNA (inheritCanvasStyle), with `presets` overriding fields of it; waits for the job and fetches the image. */
export async function generateStyleDnaImage(config: StudioMcpConfig, request: StyleDnaImageRequest, options: StyleDnaPollOptions = {}): Promise<StyleDnaImage> {
    const queued = await callStudioTool(config, 'ai.generate_images', {
        prompt: request.prompt,
        count: 1,
        aspectRatio: request.aspectRatio ?? '1:1',
        inheritCanvasStyle: true,
        ...(request.presets && Object.keys(request.presets).length ? { presets: request.presets } : {}),
        idempotencyKey: request.idempotencyKey,
        waitForCompletion: false,
        ...(request.maxEstimatedCost !== undefined ? { maxEstimatedCost: request.maxEstimatedCost } : {})
    }, options);
    const jobs = (queued.jobs as Array<{ jobId?: string; cinematicPreparation?: { effectivePresets?: Record<string, string> } }> | undefined) ?? [];
    const operationId = (queued.operationId as string | undefined) ?? jobs[0]?.jobId;
    if (!operationId) throw new StudioMcpError('Scratchbox Studio queued no image job.', { answer: queued });
    const effectivePresets = jobs[0]?.cinematicPreparation?.effectivePresets ?? {};
    const sleep = options.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
    const deadline = Date.now() + (options.timeoutMs ?? 180_000);
    let op: Record<string, unknown> = {};
    for (;;) {
        op = await callStudioTool(config, 'operation.get', { operationId }, options);
        if (op.terminal === true || op.status === 'completed' || op.status === 'failed' || op.status === 'cancelled') break;
        if (Date.now() > deadline) throw new StudioMcpError(`Scratchbox Studio image job ${operationId} did not finish in ${Math.round((options.timeoutMs ?? 180_000) / 1000)} s (status ${String(op.status)}).`, { operationId });
        if (options.signal?.aborted) throw options.signal.reason ?? new Error('aborted');
        await sleep(options.pollMs ?? 3000);
    }
    if (op.status !== 'completed') throw new StudioMcpError(`Scratchbox Studio image job ${operationId} ended ${String(op.status)}${op.error ? `: ${JSON.stringify(op.error).slice(0, 200)}` : ''}.`, { operationId, status: op.status });
    const rel = (op.result as { url?: string } | undefined)?.url;
    if (!rel) throw new StudioMcpError(`Scratchbox Studio image job ${operationId} completed without an image URL.`, { operationId });
    const url = new URL(rel, config.endpoint).toString();
    const img = await fetchOf(options)(url, { method: 'GET', headers: {}, ...(options.signal ? { signal: options.signal } : {}) });
    if (!img.ok) throw new StudioMcpError(`Fetching the Style DNA image failed (HTTP ${img.status}).`, { url });
    return { data: Buffer.from(await img.arrayBuffer()), mimeType: img.headers.get('content-type')?.split(';')[0] || 'image/jpeg', url, operationId, effectivePresets };
}
