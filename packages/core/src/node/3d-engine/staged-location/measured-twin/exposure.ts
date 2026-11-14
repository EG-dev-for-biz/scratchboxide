/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The building's one exposure gain on the twin (pipeline K's fitExposureGain, material-regions.ts, fitted in infer.ts on
 * the twin's classes): every colour the twin draws is multiplied by it in linear light, each channel clamped at 1. That
 * is every image a material reads as its base colour (decoded, raised, re-encoded in its own format) and the vertex
 * colours (COLOR_0, linear in glTF). Occlusion, roughness, metalness and normal maps are not colour and are left alone.
 * Labelled photo-inferred: the asset's and every touched material's extras carry sbExposure with the fit's reason.
 */

import * as fs from 'fs';
import * as jpegJs from 'jpeg-js';
import { assembleGlb, COMPONENT_BYTES, parseGlbBytes, TYPE_COMPONENTS } from '../glb-bytes';
import { applyExposureGain, type ExposureFit } from '../pipeline-k/material-regions';
import { encodePng } from '../png-encode';
import { decodeImageInMemory, type RgbaImage8 } from '../tile-texture-transfer';

/* eslint-disable @typescript-eslint/no-explicit-any -- glTF JSON is untyped */

export interface GlbExposureReport { gain: number; images: number; colourAccessors: number; why: string }

/** Raises the GLB's colour by the fit's gain, in place on disk; returns what it touched, or undefined when the gain is 1. */
export function applyGlbExposure(glbFile: string, fit: ExposureFit, jpegQuality = 92): GlbExposureReport | undefined {
    if (!(fit.gain > 0) || Math.abs(fit.gain - 1) < 1e-6) return undefined;
    const { json, bin } = parseGlbBytes(fs.readFileSync(glbFile));
    const views: any[] = json.bufferViews ?? [];
    const replaced = new Map<number, Uint8Array>();
    // the images a material reads as its base colour
    const colourImages = new Set<number>(), touchedMaterials = new Set<number>();
    (json.materials ?? []).forEach((m: any, mi: number) => {
        const t = m.pbrMetallicRoughness?.baseColorTexture?.index;
        if (t === undefined) return;
        const src = json.textures?.[t]?.source;
        if (src !== undefined) { colourImages.add(src); touchedMaterials.add(mi); }
    });
    for (const ii of colourImages) {
        const im = json.images[ii];
        if (im.bufferView === undefined) continue;
        const v = views[im.bufferView], bytes = bin.subarray(v.byteOffset ?? 0, (v.byteOffset ?? 0) + v.byteLength);
        const img: RgbaImage8 = decodeImageInMemory(bytes);
        applyExposureGain(new Map([[0, img]]), fit.gain);
        const out = im.mimeType === 'image/jpeg'
            ? new Uint8Array(jpegJs.encode({ data: Buffer.from(img.rgba.buffer, img.rgba.byteOffset, img.rgba.byteLength), width: img.width, height: img.height }, jpegQuality).data)
            : new Uint8Array(encodePng(img.width, img.height, img.rgba, 4));
        replaced.set(im.bufferView, out);
    }
    // vertex colours: float, linear; normalized integer colours are scaled through their range
    const colourAccessors = new Set<number>();
    for (const mesh of json.meshes ?? []) for (const p of mesh.primitives ?? []) if (p.attributes?.COLOR_0 !== undefined) colourAccessors.add(p.attributes.COLOR_0);
    const newBin = repack(bin, views, replaced);
    for (const ai of colourAccessors) {
        const a = json.accessors[ai], v = views[a.bufferView];
        const comps = TYPE_COMPONENTS[a.type], cb = COMPONENT_BYTES[a.componentType], stride = v.byteStride ?? comps * cb;
        const base = (v.byteOffset ?? 0) + (a.byteOffset ?? 0), dv = new DataView(newBin.buffer, newBin.byteOffset, newBin.byteLength);
        const max = a.componentType === 5121 ? 255 : a.componentType === 5123 ? 65535 : 1;
        for (let i = 0; i < a.count; i++) for (let c = 0; c < 3; c++) {
            const o = base + i * stride + c * cb;
            if (a.componentType === 5126) dv.setFloat32(o, Math.min(1, dv.getFloat32(o, true) * fit.gain), true);
            else if (a.componentType === 5121) dv.setUint8(o, Math.min(max, Math.round(dv.getUint8(o) * fit.gain)));
            else if (a.componentType === 5123) dv.setUint16(o, Math.min(max, Math.round(dv.getUint16(o, true) * fit.gain)), true);
        }
    }
    const extras = { gain: fit.gain, label: 'photo-inferred', source: fit.why };
    for (const mi of touchedMaterials) json.materials[mi].extras = { ...(json.materials[mi].extras ?? {}), sbExposure: extras };
    json.asset = { ...(json.asset ?? {}), extras: { ...(json.asset?.extras ?? {}), sbExposure: extras } };
    if (json.buffers?.[0]) json.buffers[0].byteLength = newBin.byteLength;
    fs.writeFileSync(glbFile, assembleGlb(json, newBin));
    return { gain: fit.gain, images: replaced.size, colourAccessors: colourAccessors.size, why: fit.why };
}

/** The binary chunk again with some views' bytes replaced; every view moved to its new offset, 4-byte aligned. */
function repack(bin: Uint8Array, views: any[], replaced: Map<number, Uint8Array>): Uint8Array {
    const parts: Uint8Array[] = [];
    let off = 0;
    views.forEach((v, i) => {
        const data = replaced.get(i) ?? bin.subarray(v.byteOffset ?? 0, (v.byteOffset ?? 0) + v.byteLength);
        const pad = (4 - (off % 4)) % 4;
        if (pad) { parts.push(new Uint8Array(pad)); off += pad; }
        v.byteOffset = off; v.byteLength = data.byteLength;
        parts.push(data); off += data.byteLength;
    });
    const out = new Uint8Array(off);
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.byteLength; }
    return out;
}
