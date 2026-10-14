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
 * file (objects[].content.durableUri, e.g. /models/x.glb). Persisted copies only need the file reference; the
 * viewport loads it from there when the base64 is absent. Returns a copy with the base64 removed wherever a
 * matching file reference exists; the input is not modified.
 */
export function stripEmbeddedGlb<T>(value: T): T {
    return strip(value) as T;
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
    if (files.size > 0) {
        for (const key of ['pythonGenerator', 'cppGenerator']) {
            const gen = out[key] as Record<string, unknown> | undefined;
            const file = typeof gen?.glbPath === 'string' ? gen.glbPath.split('/').pop() : undefined;
            if (gen && typeof gen.glbBase64 === 'string' && file && files.has(file)) {
                const { glbBase64: _dropped, ...rest } = gen;
                out[key] = rest;
            }
        }
    }
    return out;
}
