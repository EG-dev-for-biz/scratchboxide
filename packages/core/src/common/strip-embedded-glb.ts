/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Generated 3D scenes carry their model twice: as base64 in pythonGenerator/cppGenerator.glbBase64 and as a
 * file. Persisted copies only need the file reference. Returns a copy with the base64 removed wherever the
 * viewport can get the model back without it; the input is not modified:
 * - a scene object loads the same file (objects[].content.durableUri, e.g. /models/x.glb), or
 * - the file is in the Python runner's output directory, which the app serves (servedGeneratorGlbUrl), and the
 *   generator keeps its source, so the model is rebuilt if that file has since been deleted.
 * Every revision of the project artifact graph is posted on each save, so one embedded 25 MB model per
 * revision pushed the request past the server's 50 MB limit (HTTP 413).
 */
export function stripEmbeddedGlb<T>(value: T): T {
    return strip(value) as T;
}

/** The app serves the Python runner's output directory here (desktop-app/server/app.ts). */
const PYTHON_OUTPUT_ROUTE = '/build/3d-python/';

/** URL the app serves a generator's output file at, when the file is in the Python runner's output directory. */
export function servedGeneratorGlbUrl(glbPath: unknown): string | undefined {
    if (typeof glbPath !== 'string') return undefined;
    const match = glbPath.replace(/\\/g, '/').match(/(?:^|\/)build\/3d-python\/([^/]+\.glb)$/i);
    return match ? `${PYTHON_OUTPUT_ROUTE}${encodeURIComponent(match[1])}` : undefined;
}

/**
 * Loads a saved generator's model from its served file, as base64. Undefined when the file is not served or no
 * longer exists, or when the response is not a GLB (a dev server answers unknown paths with index.html).
 */
export async function loadServedGeneratorGlb(glbPath: unknown, fetchFn?: typeof fetch): Promise<string | undefined> {
    const url = servedGeneratorGlbUrl(glbPath);
    if (!url) return undefined;
    try {
        const res = await (fetchFn ? fetchFn(url) : fetch(url));
        if (!res.ok) return undefined;
        const bytes = new Uint8Array(await res.arrayBuffer());
        const isGlb = bytes.length >= 12 && bytes[0] === 0x67 && bytes[1] === 0x6c && bytes[2] === 0x54 && bytes[3] === 0x46; // 'glTF'
        return isGlb ? bytesToBase64(bytes) : undefined;
    } catch {
        return undefined;
    }
}

function bytesToBase64(bytes: Uint8Array): string {
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary);
}

function strip(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(strip);
    if (!value || typeof value !== 'object') return value;
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) out[k] = strip(v);

    const files = new Set(
        (Array.isArray(obj.objects) ? obj.objects : [])
            .map((o: any) => o?.content?.durableUri)
            .filter((u: unknown): u is string => typeof u === 'string' && /\.glb$/i.test(u))
            .map(u => u.split('/').pop())
    );
    for (const key of ['pythonGenerator', 'cppGenerator']) {
        const gen = out[key] as Record<string, unknown> | undefined;
        if (!gen || typeof gen.glbBase64 !== 'string') continue;
        const file = typeof gen.glbPath === 'string' ? gen.glbPath.split('/').pop() : undefined;
        const loadedByObject = !!file && files.has(file);
        const reloadable = !!servedGeneratorGlbUrl(gen.glbPath) && typeof gen.sourceCode === 'string' && gen.sourceCode.trim().length > 0;
        if (loadedByObject || reloadable) {
            const { glbBase64: _dropped, ...rest } = gen;
            out[key] = rest;
        }
    }
    return out;
}
