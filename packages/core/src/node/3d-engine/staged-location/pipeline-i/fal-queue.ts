/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Fal.ai plumbing shared by pipeline I's 3D model services: FAL_KEY lookup, image upload to Fal storage, and one queued
 * job (submit, poll, fetch the result, download the GLB it names). Failures throw GeneratorFailedError with the reason.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GeneratorFailedError, MissingInputError } from '../../../../common/errors/pipeline-errors';

export type FetchFn = (url: string, init?: any) => Promise<{ ok: boolean; status: number; json(): Promise<any>; arrayBuffer(): Promise<ArrayBuffer> }>;

/** FAL_KEY from the environment (the desktop server copies secrets.json into it), else from a secrets.json. */
export function resolveFalKey(env: NodeJS.ProcessEnv = process.env, candidates: string[] = [
    path.resolve(process.cwd(), 'secrets.json'),
    // the checkout root, wherever the server runs from (the desktop app's backend runs in desktop-app/)
    path.resolve(__dirname, '../../../../../../../secrets.json'),
    path.join(os.homedir(), '.scratchbox', 'secrets.json')
]): string | undefined {
    if (env.FAL_KEY?.trim()) return env.FAL_KEY.trim();
    for (const p of candidates) {
        try {
            const k = JSON.parse(fs.readFileSync(p, 'utf8')).FAL_KEY;
            if (typeof k === 'string' && k.trim()) return k.trim();
        } catch { /* not there or not JSON: try the next */ }
    }
    return undefined;
}

export interface FalQueue {
    upload(png: Buffer, name: string, signal?: AbortSignal): Promise<string>;
    /** Runs one job and returns the GLB at `glbOf(result)` with the request id. */
    run(model: string, body: unknown, glbOf: (result: any) => string | undefined, opts: { signal?: AbortSignal; timeoutMs: number; onProgress?: (msg: string) => void }): Promise<{ glb: Buffer; requestId: string; seconds: number }>;
}

export function createFalQueue(tool: string, opts: { falKey?: string; fetch?: FetchFn; pollMs?: number; sleep?: (ms: number) => Promise<void> } = {}): FalQueue {
    const key = opts.falKey ?? resolveFalKey();
    if (!key) throw new MissingInputError(tool, 'FAL_KEY', 'pipeline I builds its model on Fal.ai: add FAL_KEY to secrets.json or the environment');
    const f: FetchFn = opts.fetch ?? (globalThis.fetch as unknown as FetchFn);
    const sleep = opts.sleep ?? (ms => new Promise(r => setTimeout(r, ms)));
    const H = { Authorization: `Key ${key}`, 'Content-Type': 'application/json' };
    return {
        async upload(png, name, signal) {
            const init = await (await f('https://rest.alpha.fal.ai/storage/upload/initiate', { method: 'POST', headers: H, body: JSON.stringify({ file_name: name, content_type: 'image/png' }), signal })).json();
            if (!init?.upload_url || !init?.file_url) throw new GeneratorFailedError(tool, `Fal storage did not start an upload (${JSON.stringify(init).slice(0, 200)})`);
            const put = await f(init.upload_url, { method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: png, signal });
            if (!put.ok) throw new GeneratorFailedError(tool, `Fal storage upload failed: HTTP ${put.status}`);
            return init.file_url;
        },
        async run(model, body, glbOf, { signal, timeoutMs, onProgress }) {
            const t0 = Date.now();
            const sub = await (await f(`https://queue.fal.run/${model}`, { method: 'POST', headers: H, body: JSON.stringify(body), signal })).json();
            if (!sub?.request_id || !sub.status_url || !sub.response_url) throw new GeneratorFailedError(tool, `${model} did not accept the job (${JSON.stringify(sub).slice(0, 300)})`);
            onProgress?.(`${model} job ${sub.request_id} queued`);
            for (;;) {
                if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : Object.assign(new Error('pipeline I was stopped'), { name: 'AbortError' });
                if (Date.now() - t0 > timeoutMs) throw new GeneratorFailedError(tool, `${model} job ${sub.request_id} did not finish within ${Math.round(timeoutMs / 1000)} s`);
                await sleep(opts.pollMs ?? 8_000);
                const st = await (await f(sub.status_url, { headers: H, signal })).json();
                if (st?.status === 'COMPLETED') break;
                onProgress?.(`${model} job ${String(st?.status ?? 'pending').toLowerCase()} (${Math.round((Date.now() - t0) / 1000)} s)`);
            }
            const resp = await f(sub.response_url, { headers: H, signal });
            const res = await resp.json();
            if (!resp.ok) throw new GeneratorFailedError(tool, `${model} job ${sub.request_id} failed: HTTP ${resp.status} ${JSON.stringify(res).slice(0, 300)}`);
            const glbUrl = glbOf(res);
            if (!glbUrl) throw new GeneratorFailedError(tool, `${model} job ${sub.request_id} returned no GLB (fields: ${Object.keys(res ?? {}).join(', ')})`);
            const g = await f(glbUrl, { signal });
            if (!g.ok) throw new GeneratorFailedError(tool, `downloading ${model}'s GLB failed: HTTP ${g.status}`);
            const glb = Buffer.from(await g.arrayBuffer());
            if (glb.length < 4 || glb.readUInt32LE(0) !== 0x46546c67) throw new GeneratorFailedError(tool, `${model} returned a file that is not a binary glTF`);
            return { glb, requestId: sub.request_id, seconds: Math.round((Date.now() - t0) / 1000) };
        }
    };
}
