/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * An object cut from a layer carries only the texels it uses. A district's rebuilt buildings share two 4096 px atlas
 * pages (Federation Square: page 0 used by 70 buildings, page 1 by 90); cut whole into every building, the 30 MB of
 * the layer's images became 532 MB across 96 building GLBs. Here each primitive's own UV rectangle is copied out of the
 * pages it samples (every image its material reads, the albedo and the confidence map alike, at the same rectangle),
 * the rectangles are shelf-packed into a new, smaller atlas per page group, and the primitive's UVs are moved onto it.
 *
 * Pixels are copied, never resampled: a texel keeps its value (a JPEG page is re-encoded once, at `jpegQuality`; a PNG
 * page is written losslessly). A rectangle keeps a `padPx` border of its neighbours' texels, as the page had, so
 * filtering at a face's edge reads what it read before. A group is left as it is when its primitives use most of the
 * page anyway, when a UV leaves [0, 1] (a repeating texture), or when the group's images differ in size.
 */

import * as jpegJs from 'jpeg-js';
import * as crypto from 'crypto';
import { decodePng, encodePng } from '../../texture-processing';
import { readAccessor, type ParsedGlb } from './glb-bytes';

/** An embedded JPEG's or PNG's pixel size from its header, without decoding it. */
export function imageSize(bytes: Uint8Array, mime: string): { width: number; height: number } | undefined {
    if (mime === 'image/png') {
        if (bytes.length < 24 || bytes[0] !== 0x89 || bytes[1] !== 0x50) return undefined;
        const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        return { width: dv.getUint32(16), height: dv.getUint32(20) };
    }
    if (mime === 'image/jpeg') {
        let i = 2;
        while (i + 9 < bytes.length) {
            if (bytes[i] !== 0xff) return undefined;
            const m = bytes[i + 1];
            const len = (bytes[i + 2] << 8) | bytes[i + 3];
            // SOF0..SOF15 (not DHT, JPG or DAC): height then width
            if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { height: (bytes[i + 5] << 8) | bytes[i + 6], width: (bytes[i + 7] << 8) | bytes[i + 8] };
            if (m === 0xda) return undefined;
            i += 2 + len;
        }
    }
    return undefined;
}

/* eslint-disable @typescript-eslint/no-explicit-any -- glTF JSON is untyped */

export interface RepackOptions {
    padPx?: number;
    jpegQuality?: number;
    /** Leave a group whole when its rectangles cover more than this share of its page (default 0.6). */
    maxUsedShare?: number;
}

/** Decoded pages shared across the objects of one store pass (keyed by the image bytes' hash). */
export class DecodedImageCache {
    private readonly images = new Map<string, { width: number; height: number; rgba: Uint8Array }>();
    get(bytes: Uint8Array, mime: string): { width: number; height: number; rgba: Uint8Array } {
        const key = crypto.createHash('sha1').update(bytes).digest('hex');
        let d = this.images.get(key);
        if (!d) {
            if (mime === 'image/jpeg') {
                const j = jpegJs.decode(bytes, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 2048, maxResolutionInMP: 400 });
                d = { width: j.width, height: j.height, rgba: j.data };
            } else if (mime === 'image/png') {
                const p = decodePng(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
                d = { width: p.width, height: p.height, rgba: new Uint8Array(p.rgba.buffer, p.rgba.byteOffset, p.rgba.byteLength) };
            } else throw new Error(`texture repack: ${mime} is not decoded here`);
            this.images.set(key, d);
        }
        return d;
    }
    clear(): void { this.images.clear(); }
}

export interface RepackReport {
    groups: number;
    repacked: number;
    imageBytesBefore: number;
    imageBytesAfter: number;
    skipped: string[];
}

/** Texture indices a material reads: core and extension textureInfos, and the staged layers' extras confidence map. */
function materialTextures(m: any): number[] {
    const out: number[] = [];
    const walk = (o: any) => {
        if (!o || typeof o !== 'object') return;
        for (const [k, v] of Object.entries(o)) {
            if (v && typeof v === 'object' && /Texture$/.test(k) && typeof (v as any).index === 'number') {
                if (((v as any).texCoord ?? 0) !== 0) out.push(-1);
                out.push((v as any).index);
            } else walk(v);
        }
    };
    walk({ ...m, extras: undefined });
    const conf = m.extras?.sbTexture?.confidenceTexture;
    if (typeof conf === 'number') out.push(conf);
    return out;
}

function viewBytes(glb: ParsedGlb, view: number): Uint8Array {
    const v = glb.json.bufferViews[view];
    const o = v.byteOffset ?? 0;
    return glb.bin.subarray(o, o + v.byteLength);
}

/**
 * Returns a GLB whose shared atlas pages are cut down to what its primitives sample (see the module doc); the input is
 * not changed. Unreferenced bytes are left in the returned binary chunk: compose it once more to drop them.
 */
export function repackTextures(glb: ParsedGlb, cache: DecodedImageCache, opts: RepackOptions = {}): { glb: ParsedGlb; report: RepackReport } {
    const pad = opts.padPx ?? 2, quality = opts.jpegQuality ?? 92, maxShare = opts.maxUsedShare ?? 0.6;
    const json = JSON.parse(JSON.stringify(glb.json));
    const report: RepackReport = { groups: 0, repacked: 0, imageBytesBefore: 0, imageBytesAfter: 0, skipped: [] };
    const images: any[] = json.images ?? [];
    for (const im of images) if (im.bufferView !== undefined) report.imageBytesBefore += json.bufferViews[im.bufferView].byteLength;
    const materials: any[] = json.materials ?? [];
    if (!materials.length || !images.length) { report.imageBytesAfter = report.imageBytesBefore; return { glb, report }; }
    // a small image of one colour reads the same at any UV (the tile photos' shared 1 px confidence map): it is left
    // as it is and joins no group, so it cannot tie every material that reads it into one
    const uniform = new Map<number, boolean>();
    const isUniform = (i: number): boolean => {
        let u = uniform.get(i);
        if (u === undefined) {
            u = false;
            const im = images[i];
            if (im?.bufferView !== undefined && json.bufferViews[im.bufferView].byteLength < 4096 && ['image/jpeg', 'image/png'].includes(im.mimeType)) {
                try {
                    const d = cache.get(viewBytes(glb, im.bufferView), im.mimeType);
                    u = true;
                    for (let k = 4; k < d.rgba.length && u; k += 4) if (d.rgba[k] !== d.rgba[0] || d.rgba[k + 1] !== d.rgba[1] || d.rgba[k + 2] !== d.rgba[2] || d.rgba[k + 3] !== d.rgba[3]) u = false;
                } catch { u = false; }
            }
            uniform.set(i, u);
        }
        return u;
    };
    // materials joined by the images they share
    const parent = materials.map((_, i) => i);
    const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    const imagesOf = materials.map(m => materialTextures(m).map(t => (t < 0 ? -1 : json.textures?.[t]?.source ?? -1)).filter(i => i < 0 || !isUniform(i)));
    const owner = new Map<number, number>();
    imagesOf.forEach((imgs, mi) => { for (const im of imgs) if (im >= 0) { const o = owner.get(im); if (o === undefined) owner.set(im, mi); else parent[find(mi)] = find(o); } });
    const groups = new Map<number, number[]>();
    materials.forEach((_, mi) => { if (imagesOf[mi].length) { const g = find(mi); groups.set(g, [...(groups.get(g) ?? []), mi]); } });
    const prims: Array<{ mesh: number; prim: number; material: number }> = [];
    (json.meshes ?? []).forEach((m: any, mi: number) => m.primitives.forEach((p: any, pi: number) => { if (p.material !== undefined) prims.push({ mesh: mi, prim: pi, material: p.material }); }));
    const extra: Buffer[] = [];
    let binLength = glb.bin.byteLength;
    const append = (bytes: Uint8Array): number => {
        const padBytes = (4 - (binLength % 4)) % 4;
        if (padBytes) { extra.push(Buffer.alloc(padBytes)); binLength += padBytes; }
        json.bufferViews.push({ buffer: 0, byteOffset: binLength, byteLength: bytes.byteLength });
        extra.push(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
        binLength += bytes.byteLength;
        return json.bufferViews.length - 1;
    };
    for (const [g, mats] of groups) {
        report.groups++;
        const why = (s: string) => { report.skipped.push(`material group ${g}: ${s}`); };
        if (mats.some(mi => imagesOf[mi].includes(-1))) { why('a texture reads another UV set'); continue; }
        const imgIds = [...new Set(mats.flatMap(mi => imagesOf[mi]))];
        if (imgIds.some(i => images[i]?.bufferView === undefined || !['image/jpeg', 'image/png'].includes(images[i].mimeType))) { why('an image is not an embedded JPEG or PNG'); continue; }
        const sizes = imgIds.map(i => imageSize(viewBytes(glb, images[i].bufferView), images[i].mimeType));
        if (sizes.some(d => !d)) { why('an image header could not be read'); continue; }
        const W = sizes[0]!.width, H = sizes[0]!.height;
        if (sizes.some(d => d!.width !== W || d!.height !== H)) { why('its images differ in size'); continue; }
        const groupPrims = prims.filter(p => mats.includes(p.material));
        const rects: Array<{ p: typeof groupPrims[number]; uv: Float64Array; x0: number; y0: number; w: number; h: number; nx: number; ny: number }> = [];
        let bad = false;
        for (const p of groupPrims) {
            const ai = json.meshes[p.mesh].primitives[p.prim].attributes?.TEXCOORD_0;
            if (ai === undefined) continue;
            const a = json.accessors[ai];
            if (a.componentType !== 5126 || a.type !== 'VEC2') { bad = true; break; }
            const uv = readAccessor(glb, ai).data;
            let u0 = Infinity, v0 = Infinity, u1 = -Infinity, v1 = -Infinity;
            for (let i = 0; i < uv.length; i += 2) { u0 = Math.min(u0, uv[i]); u1 = Math.max(u1, uv[i]); v0 = Math.min(v0, uv[i + 1]); v1 = Math.max(v1, uv[i + 1]); }
            if (u0 < -1e-6 || v0 < -1e-6 || u1 > 1 + 1e-6 || v1 > 1 + 1e-6) { bad = true; break; }
            const x0 = Math.max(0, Math.floor(u0 * W) - pad), y0 = Math.max(0, Math.floor(v0 * H) - pad);
            const x1 = Math.min(W, Math.ceil(u1 * W) + pad), y1 = Math.min(H, Math.ceil(v1 * H) + pad);
            rects.push({ p, uv, x0, y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0), nx: 0, ny: 0 });
        }
        if (bad) { why('a UV is quantized or leaves [0, 1]'); continue; }
        if (!rects.length) { why('no primitive samples it'); continue; }
        const area = rects.reduce((s, r) => s + r.w * r.h, 0);
        if (area > maxShare * W * H) { why(`its primitives use ${Math.round((100 * area) / (W * H))}% of the page`); continue; }
        // decoded only now, when the page is cut
        const decoded = imgIds.map(i => cache.get(viewBytes(glb, images[i].bufferView), images[i].mimeType));
        if (decoded.some(d => d.width !== W || d.height !== H)) { why('an image decodes to another size than its header says'); continue; }
        // shelf packing, tallest first, into a width near the square of the area (never wider than the page)
        const width = Math.min(W, Math.max(64, Math.max(...rects.map(r => r.w)), 2 ** Math.ceil(Math.log2(Math.sqrt(area * 1.25)))));
        let x = 0, y = 0, shelf = 0;
        for (const r of [...rects].sort((a, b) => b.h - a.h || b.w - a.w)) {
            if (x + r.w > width) { x = 0; y += shelf; shelf = 0; }
            r.nx = x; r.ny = y;
            x += r.w;
            shelf = Math.max(shelf, r.h);
        }
        const height = y + shelf;
        // each image of the group: the same rectangles copied to the same places
        for (let k = 0; k < imgIds.length; k++) {
            const src = decoded[k];
            const out = new Uint8Array(width * height * 4);
            for (const r of rects) for (let row = 0; row < r.h; row++) {
                const s = ((r.y0 + row) * W + r.x0) * 4;
                out.set(src.rgba.subarray(s, s + r.w * 4), ((r.ny + row) * width + r.nx) * 4);
            }
            const im = images[imgIds[k]];
            const bytes = im.mimeType === 'image/jpeg'
                ? jpegJs.encode({ data: Buffer.from(out.buffer, out.byteOffset, out.byteLength), width, height }, quality).data
                : encodePng(width, height, Buffer.from(out.buffer, out.byteOffset, out.byteLength));
            im.bufferView = append(bytes);
        }
        // UVs onto the new atlas, one new accessor per primitive (a shared accessor may map two ways now)
        for (const r of rects) {
            const nuv = new Float32Array(r.uv.length);
            for (let i = 0; i < r.uv.length; i += 2) {
                nuv[i] = (r.uv[i] * W - r.x0 + r.nx) / width;
                nuv[i + 1] = (r.uv[i + 1] * H - r.y0 + r.ny) / height;
            }
            const view = append(new Uint8Array(nuv.buffer));
            json.bufferViews[view].target = 34962;
            json.accessors.push({ bufferView: view, componentType: 5126, count: nuv.length / 2, type: 'VEC2' });
            json.meshes[r.p.mesh].primitives[r.p.prim].attributes.TEXCOORD_0 = json.accessors.length - 1;
        }
        report.repacked++;
    }
    const bin = extra.length ? new Uint8Array(Buffer.concat([Buffer.from(glb.bin.buffer, glb.bin.byteOffset, glb.bin.byteLength), ...extra])) : glb.bin;
    if (json.buffers?.[0]) json.buffers[0].byteLength = bin.byteLength;
    for (const im of images) if (im.bufferView !== undefined) report.imageBytesAfter += json.bufferViews[im.bufferView].byteLength;
    return { glb: { json, bin }, report };
}
