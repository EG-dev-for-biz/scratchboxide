/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Pipeline E's material channels (the textured twin's metallicRoughness map and the viewer's material parameters), from
 * the evidence E already holds: the openings it cut. Each opening node is a recessed pane (the triangles facing out along
 * its face's normal) inside four reveals. A pane is drawn as glass (roughness GLASS_ROUGHNESS, dielectric, so the viewer's
 * environment gives it a Fresnel reflection) only where its own texels are darker than the wall around it (the check the
 * texture pass's tile-only reading makes: a window in a facade photo is a darker, more uniform patch than its masonry);
 * a pane that is not darker keeps the wall's roughness and is reported as rejected. Every other texel keeps the wall
 * value (WALL_ROUGHNESS, labelled assumed: nothing measured it). Albedo is never changed.
 *
 * Provenance per texel (params A = index into `sources`): glass inherits the opening's own label (photo-inferred when the
 * opening was read from the tile photo and checked on the scan, generated when it was cut from an AI-enhanced plate),
 * and the method says the material is a reading of that opening, not a measurement of glass. Nothing here branches on a
 * place, a style or a building type: only on the node's geometry, its face and its texels.
 */

import { GLASS_ROUGHNESS, WALL_ROUGHNESS } from '../facade-materials';
import type { MassingFace, MassingNode } from './native-massing';
import type { FaceTexture } from './massing-glb';

/** A pane's median luminance must be at most this share of its wall's (the wall: the face's texels outside every pane). */
export const GLASS_MAX_LUMA_RATIO = 0.85;
/** A pane triangle faces out along its face: |n . face normal| at least this. */
export const PANE_MIN_COS = 0.9;
/** Fewer pane texels than this: too small to judge, left as wall. */
export const MIN_PANE_TEXELS = 4;

/** What the per-texel material parameters' channels mean (written beside them in the GLB). */
export const MASSING_MATERIAL_PARAMS_CHANNELS = 'R = glass weight 0..255 (the opening\'s confidence), G = 0 (no coursing read), B = metalness 0..255, A = index into materialSources[] (255 = the assumed wall default)';

/** One material source of the legend (open labels). */
export interface MaterialSource { source: string; label: string; method: string; roughness: number; metalness: number; texels: number }

export interface MaterialRegion {
    node: string; face: number; texels: number; label: string; accepted: boolean; confidence: number;
    paneLuma: number | null; wallLuma: number | null; reason: string;
}

export interface MassingMaterialResult {
    /** Per face: RGBA params (R glass weight, G 0, B metalness, A source index or 255). */
    params: Map<number, Uint8Array>;
    sources: MaterialSource[];
    regions: MaterialRegion[];
    totals: { glassTexels: number; candidates: number; accepted: number; rejected: number };
}

const luma = (rgba: Uint8Array, i: number) => 0.2126 * rgba[i * 4] + 0.7152 * rgba[i * 4 + 1] + 0.0722 * rgba[i * 4 + 2];

function median(v: number[]): number | null {
    if (!v.length) return null;
    const s = [...v].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
}

/** Rasterises a triangle given in face texel coordinates into `mask` (texel centres inside, edges inclusive). */
function rasterise(mask: Uint16Array, W: number, H: number, x: number[], y: number[], value: number): number {
    const area = (x[1] - x[0]) * (y[2] - y[0]) - (x[2] - x[0]) * (y[1] - y[0]);
    if (Math.abs(area) < 1e-9) return 0;
    let n = 0;
    const x0 = Math.max(0, Math.floor(Math.min(...x))), x1 = Math.min(W - 1, Math.ceil(Math.max(...x)));
    const y0 = Math.max(0, Math.floor(Math.min(...y))), y1 = Math.min(H - 1, Math.ceil(Math.max(...y)));
    for (let py = y0; py <= y1; py++) for (let px = x0; px <= x1; px++) {
        const xc = px + 0.5, yc = py + 0.5;
        const w0 = ((x[1] - xc) * (y[2] - yc) - (x[2] - xc) * (y[1] - yc)) / area;
        const w1 = ((x[2] - xc) * (y[0] - yc) - (x[0] - xc) * (y[2] - yc)) / area;
        const w2 = 1 - w0 - w1;
        if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) continue;
        const i = py * W + px;
        if (mask[i] !== value) { mask[i] = value; n++; }
    }
    return n;
}

/**
 * The material channels of E's faces. `labelOf` gives an opening node's provenance label (its node record's label:
 * 'photo-inferred', 'generated', ...); `confidenceOf` its confidence.
 */
export function massingMaterials(input: {
    nodes: MassingNode[]; faces: MassingFace[]; textures: Map<number, FaceTexture>;
    labelOf: (node: MassingNode) => string; confidenceOf: (node: MassingNode) => number;
}): MassingMaterialResult {
    const facesByIndex = new Map(input.faces.map(f => [f.index, f]));
    // per face: which pane (region id + 1) covers each texel
    const paneMask = new Map<number, Uint16Array>();
    const regionsOf: Array<{ node: MassingNode; face: number; id: number }> = [];
    for (const node of input.nodes) {
        if (node.kind !== 'opening') continue;
        for (let t = 0; t + 2 < node.indices.length; t += 3) {
            const v = [node.indices[t], node.indices[t + 1], node.indices[t + 2]];
            const ref = node.ref[v[0]];
            if (ref < 0 || node.ref[v[1]] !== ref || node.ref[v[2]] !== ref) continue;
            const face = facesByIndex.get(ref), tex = input.textures.get(ref);
            if (!face || !tex || !face.width || !face.pixel) continue;
            // the triangle's own normal against the face's: the pane, not a reveal
            const p = v.map(k => [node.positions[k * 3], node.positions[k * 3 + 1], node.positions[k * 3 + 2]]);
            const e1 = [p[1][0] - p[0][0], p[1][1] - p[0][1], p[1][2] - p[0][2]], e2 = [p[2][0] - p[0][0], p[2][1] - p[0][1], p[2][2] - p[0][2]];
            const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
            const nl = Math.hypot(n[0], n[1], n[2]);
            if (!(nl > 1e-12)) continue;
            const cos = Math.abs((n[0] * face.normal[0] + n[1] * face.normal[1] + n[2] * face.normal[2]) / nl);
            if (cos < PANE_MIN_COS) continue;
            let region = regionsOf.find(r => r.node === node && r.face === ref);
            if (!region) { region = { node, face: ref, id: regionsOf.length }; regionsOf.push(region); }
            let mask = paneMask.get(ref);
            if (!mask) paneMask.set(ref, mask = new Uint16Array(tex.width * tex.height));
            const xs = v.map(k => (node.st[k * 2] - face.orthoSMin) / face.pixel), ys = v.map(k => (face.orthoTMax - node.st[k * 2 + 1]) / face.pixel);
            rasterise(mask, tex.width, tex.height, xs, ys, region.id + 1);
        }
    }
    const sources: MaterialSource[] = [];
    const sourceIndex = new Map<string, number>();
    const sourceFor = (label: string): number => {
        let k = sourceIndex.get(label);
        if (k === undefined) {
            sources.push({
                source: 'pipeline-e-openings', label, roughness: GLASS_ROUGHNESS, metalness: 0, texels: 0,
                method: `glass on the panes of pipeline E's openings (${label}: the opening's own label), each kept only where its texels are darker than its wall (median luminance at most ${GLASS_MAX_LUMA_RATIO} of the wall's); roughness ${GLASS_ROUGHNESS}, dielectric, the viewer's environment gives the Fresnel reflection; the albedo is unchanged`
            });
            sourceIndex.set(label, k = sources.length - 1);
        }
        return k;
    };
    const regions: MaterialRegion[] = [];
    const params = new Map<number, Uint8Array>();
    let glassTexels = 0;
    for (const [faceIndex, mask] of paneMask) {
        const tex = input.textures.get(faceIndex)!;
        const N = tex.width * tex.height;
        const wall: number[] = [];
        const pane = new Map<number, number[]>();
        for (let i = 0; i < N; i++) {
            const m = mask[i];
            if (!m) { if (tex.rgba[i * 4 + 3]) wall.push(luma(tex.rgba, i)); continue; }
            (pane.get(m - 1) ?? pane.set(m - 1, []).get(m - 1)!).push(i);
        }
        const wallLuma = median(wall);
        const out = new Uint8Array(N * 4);
        for (let i = 0; i < N; i++) out[i * 4 + 3] = 255;
        for (const r of regionsOf.filter(x => x.face === faceIndex)) {
            const texels = pane.get(r.id) ?? [];
            const label = input.labelOf(r.node);
            const confidence = Math.max(0, Math.min(1, input.confidenceOf(r.node)));
            const paneLuma = median(texels.map(i => luma(tex.rgba, i)));
            let reason: string, accepted = false;
            if (texels.length < MIN_PANE_TEXELS) reason = `the pane covers ${texels.length} texels (fewer than ${MIN_PANE_TEXELS}): too small to judge`;
            else if (wallLuma === null || paneLuma === null) reason = 'the face has no wall texels to compare the pane with';
            else if (paneLuma > GLASS_MAX_LUMA_RATIO * wallLuma) reason = `the pane is not darker than its wall (median luminance ${paneLuma.toFixed(0)} against the wall's ${wallLuma.toFixed(0)}; at most ${GLASS_MAX_LUMA_RATIO} of it is needed)`;
            else { accepted = true; reason = `the pane is darker than its wall (median luminance ${paneLuma.toFixed(0)} against ${wallLuma.toFixed(0)})`; }
            if (accepted) {
                const s = sourceFor(label);
                const w = Math.max(1, Math.round(255 * confidence));
                for (const i of texels) { out[i * 4] = w; out[i * 4 + 2] = 0; out[i * 4 + 3] = s; }
                sources[s].texels += texels.length;
                glassTexels += texels.length;
            }
            regions.push({ node: r.node.name, face: faceIndex, texels: texels.length, label, accepted, confidence, paneLuma: paneLuma === null ? null : Math.round(paneLuma), wallLuma: wallLuma === null ? null : Math.round(wallLuma), reason });
        }
        params.set(faceIndex, out);
    }
    const accepted = regions.filter(r => r.accepted).length;
    return { params, sources, regions, totals: { glassTexels, candidates: regions.length, accepted, rejected: regions.length - accepted } };
}

/** The glTF metallicRoughness bytes (RGB: G roughness, B metalness) of one params texel. */
export function roughnessOfParams(params: Uint8Array, i: number): number {
    return params[i * 4] > 0 ? Math.round(GLASS_ROUGHNESS * 255) : Math.round(WALL_ROUGHNESS * 255);
}
