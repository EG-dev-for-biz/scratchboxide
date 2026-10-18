/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/** Messages between the texture worker pool (texture-worker-pool.ts) and its threads (texture-worker.ts), and their helpers. */

import type { EnhanceModelAnswer, EnhanceModelRequest } from './texture-enhance';
import type { TextureLayerInput, TextureLayerOutcome, TexturePassSources } from './texture-pass';
import type { TextureSourcesInput, TextureSourcesWire } from './texture-sources';
import type { TileSurfaceState } from './tile-texture-transfer';
import type { LooFit } from './texture-fit-metric';

/** A layer's sources as they cross: no functions (the tile as its state, the model client and progress by message). */
export type WireLayerSources = Omit<TexturePassSources, 'tile' | 'enhance' | 'signal' | 'onProgress'>;

export type ToWorker =
    | { type: 'prepare'; id: number; input: TextureSourcesInput }
    | { type: 'texture'; id: number; layer: TextureLayerInput; src: WireLayerSources; tile?: TileSurfaceState; enhance?: { models?: string[]; budgetMs?: number } }
    | { type: 'loo'; id: number; budgetMs?: number }
    | { type: 'release' }
    | { type: 'abort'; id: number }
    | { type: 'enhance-result'; callId: number; answer?: EnhanceModelAnswer; error?: WireError };

export type WireOutcome = Omit<TextureLayerOutcome, 'glb' | 'measureLoo'> & { glb: Uint8Array; hasLoo: boolean };

export type FromWorker =
    | { type: 'ready' }
    | { type: 'progress'; id: number; message: string }
    | { type: 'enhance'; id: number; callId: number; request: Omit<EnhanceModelRequest, 'signal'> }
    | { type: 'enhance-abort'; id: number; callId: number }
    | { type: 'result'; id: number; value: unknown }
    | { type: 'error'; id: number; error: WireError };

export type PrepareResult = TextureSourcesWire;
export type LooResult = LooFit;

export interface WireError { name: string; message: string; stack?: string; code?: string }

export function wireError(err: unknown): WireError {
    const e = err as { name?: string; message?: string; stack?: string; code?: unknown };
    return { name: e?.name ?? 'Error', message: e?.message ?? String(err), ...(e?.stack ? { stack: e.stack } : {}), ...(typeof e?.code === 'string' ? { code: e.code } : {}) };
}

export function errorFromWire(w: WireError): Error {
    const err = new Error(w.message);
    err.name = w.name;
    if (w.stack) err.stack = w.stack;
    if (w.code) (err as { code?: string }).code = w.code;
    return err;
}

/** The bytes in an ArrayBuffer of their own (a Buffer may be a slice of a shared pool), so they can be transferred. */
export function ownedBytes(b: Uint8Array): Uint8Array {
    if (b.byteOffset === 0 && b.byteLength === b.buffer.byteLength && !(b.buffer instanceof SharedArrayBuffer)) return b;
    const out = new Uint8Array(b.byteLength);
    out.set(b);
    return out;
}

type TypedArray = Float32Array | Float64Array | Int8Array | Int16Array | Int32Array | Uint8Array | Uint8ClampedArray | Uint16Array | Uint32Array;

const SHARED = new WeakMap<object, TypedArray>();

function shareArray(a: TypedArray): TypedArray {
    if (a.buffer instanceof SharedArrayBuffer) return a;
    const hit = SHARED.get(a);
    if (hit) return hit;
    const Ctor = (a.constructor === Buffer ? Uint8Array : a.constructor) as { new(b: SharedArrayBuffer, o: number, n: number): TypedArray; BYTES_PER_ELEMENT: number };
    const buf = new SharedArrayBuffer(a.byteLength);
    const out = new Ctor(buf, 0, a.length);
    out.set(a as never);
    SHARED.set(a, out);
    return out;
}

/**
 * The value with every typed array in shared memory (copied once per array: the same array shared again is the same
 * copy), so posting it to any number of threads copies none of their contents. Plain objects, arrays and Maps are walked;
 * arrays of primitives are kept as they are.
 */
export function shareDeep<T>(value: T): T {
    const walk = (v: unknown): unknown => {
        if (v === null || typeof v !== 'object') return v;
        if (ArrayBuffer.isView(v)) return v instanceof DataView ? v : shareArray(v as TypedArray);
        if (Array.isArray(v)) return v.length && (v[0] === null || typeof v[0] !== 'object') ? v : v.map(walk);
        if (v instanceof Map) return new Map([...v].map(([k, x]) => [k, walk(x)]));
        if (v instanceof Set || v instanceof Date || v instanceof RegExp || v instanceof ArrayBuffer || v instanceof SharedArrayBuffer) return v;
        const out: Record<string, unknown> = {};
        for (const [k, x] of Object.entries(v as Record<string, unknown>)) if (typeof x !== 'function') out[k] = walk(x);
        return out;
    };
    return walk(value) as T;
}
