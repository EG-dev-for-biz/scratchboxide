/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Every blob of a district audit read from the cheap evidence first, with no Street View (MAIN, 2026-11-08: at Penn,
 * Street View as the first source reached 4% of 4,425 clusters in 128 min; 372 fell past the image budget and 271 had no
 * pano near enough).
 *
 * - Evidence, continuous, per cluster: the scan's measures the audit already took (height over what supports it, plan,
 *   main-axis verticality, thinness, elongation, radial symmetry, the slices' periodicity, how much of it faces up or
 *   sideways, how much is grounded) and where it stands against Google's vector data (distance to the nearest building
 *   line and road centreline, on the carriageway or not, inside or touching a building footprint, the land-use codes).
 * - A cluster inside or touching a building footprint is a building's part, not a street blob: left out of this read, with
 *   that reason (the street objects' families never see it).
 * - Its top-down tile photo: one orthophoto of the district from the tile (top-down-photo.ts), a square patch round each
 *   cluster with its plan extent outlined.
 * - The read: contact sheets of PATCHES_PER_SHEET patches, each numbered, with the numbers beside it in the prompt; one
 *   vision call per sheet gives each blob an open-vocabulary label, a confidence, and continuous answers (how much it
 *   stands up off the ground, how permanent it looks, how likely it is a fault of the scan rather than a thing). The
 *   model is the domain engine: no list of nouns is given or read back; nothing branches on the words.
 * - Stability: each sheet's answer is a record in the model readings store (pipeline-k/model-readings.ts), keyed by the
 *   prompt version, the sheet's pixels and its numbers, so a rerun on the same audit reads the same answers.
 *
 * Labels are photo-inferred (the tile photo and the scan's measures), never measured. The tile photo is Google's (the
 * 3D tiles); nothing here asks for or holds a Street View image.
 */

import * as jpegJs from 'jpeg-js';
import type { AuditedCluster, ResidualAuditResult } from '../residual-audit';
import type { EvidenceLookup, VectorEvidence } from '../vector-footprints';
import { renderTopDownPhoto, type TopDownPhoto } from '../top-down-photo';
import type { TileTriangles } from '../tile-texture-transfer';
import { readingKey, type ModelReadingStore } from '../pipeline-k/model-readings';
import type { VisionModelChain } from '../../../gemini/vision-model-chain';

export const BLOB_READ_VERSION = 'blob-read/1';

export const BLOB_READ_PARAMS = {
    /** Patches on one contact sheet (a 4 x 4 grid). */
    patchesPerSheet: 16,
    sheetColumns: 4,
    /** One patch's pixels on the sheet. */
    patchPx: 224,
    /** A patch spans the cluster's plan extent times this, and at least minPatchM. */
    patchScale: 1.8,
    minPatchM: 5,
    /** The district orthophoto's texel (m) and its largest side (px). */
    texelM: 0.1,
    maxOrthoPx: 8000,
    /** Sheets read at once. */
    concurrency: 4,
    timeoutMs: 120_000,
    maxOutputTokens: 8192,
    /** A label at or above this confidence explains its blob; below it the blob is unsure (Street View may be asked). */
    confidentAt: 0.6
};

export interface BlobEvidence {
    clusterId: number;
    /** Plan centre (tile frame x, z) and the cluster's oriented plan box (centre, x axis, extents along x and z). */
    centre: [number, number];
    box: { origin: [number, number]; xAxis: [number, number]; extentsM: [number, number] };
    verdict: AuditedCluster['verdict'];
    auditConfidence: number;
    heightM: number;
    /** Its top above what supports it (m), when the audit measured the support. */
    standM: number | null;
    planM: [number, number];
    areaM2: number;
    triangles: number;
    verticality: number;
    thinness: number;
    elongation: number;
    radialSymmetry: number;
    radiusMedianM: number;
    periodM: number;
    upShare: number;
    sideShare: number;
    groundedShare: number;
    vector: {
        inFootprint: boolean;
        touchesFootprint: boolean;
        /** Plan distance to the nearest building footprint edge (m; negative inside one). */
        toBuildingM: number | null;
        /** Plan distance to the nearest road centreline (m). */
        toRoadM: number | null;
        onCarriageway: boolean;
        landuse: string[];
    };
}

export interface BlobLabel {
    clusterId: number;
    /** In the model's words (open vocabulary; labels only). */
    label: string;
    confidence: number;
    /** 0 lies flat on the ground (a stain, a patch, litter) .. 1 stands up off it (a post, a planter). */
    standing: number;
    /** 0 put out for a while .. 1 installed to stay. */
    permanent: number;
    /** 0 a real thing .. 1 a fault of the scan (a melted copy, a spike, a sliver). */
    scanFault: number;
    notes?: string;
    sheet: number;
    provenance: 'photo-inferred';
}

export interface BlobReadReport {
    schema: 'scratchbox.blob-read/1';
    version: string;
    evidence: BlobEvidence[];
    /** Clusters left out of the read, with why (a building's part, a scan artefact the audit measured). */
    leftOut: Array<{ clusterId: number; reason: string }>;
    labels: BlobLabel[];
    sheets: Array<{ index: number; clusters: number[]; key: string; cached: boolean; ms: number; error?: string }>;
    stats: { clusters: number; read: number; confident: number; unsure: number; inFootprint: number; artefacts: number; visionCalls: number; storeHits: number; orthoMs: number; readMs: number };
}

const r3 = (v: number) => Math.round(v * 1000) / 1000;

function segDist(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
    const dx = bx - ax, dz = bz - az, L = dx * dx + dz * dz;
    const t = L > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / L)) : 0;
    return Math.hypot(px - (ax + t * dx), pz - (az + t * dz));
}

/** Nearest distance from (x, z) to any edge of the loops / polylines, with a coarse plan grid so a district stays cheap. */
function nearestEdges(lines: Array<Array<[number, number]>>, cellM = 20): (x: number, z: number, maxM: number) => number | null {
    const cells = new Map<string, Array<[number, number, number, number]>>();
    const add = (ax: number, az: number, bx: number, bz: number) => {
        const i0 = Math.floor(Math.min(ax, bx) / cellM), i1 = Math.floor(Math.max(ax, bx) / cellM), k0 = Math.floor(Math.min(az, bz) / cellM), k1 = Math.floor(Math.max(az, bz) / cellM);
        for (let i = i0; i <= i1; i++) for (let k = k0; k <= k1; k++) { const key = `${i},${k}`; let l = cells.get(key); if (!l) cells.set(key, l = []); l.push([ax, az, bx, bz]); }
    };
    for (const l of lines) for (let j = 0; j + 1 < l.length; j++) add(l[j][0], l[j][1], l[j + 1][0], l[j + 1][1]);
    return (x, z, maxM) => {
        const r = Math.ceil(maxM / cellM), gx = Math.floor(x / cellM), gz = Math.floor(z / cellM);
        let best = Infinity;
        for (let i = gx - r; i <= gx + r; i++) for (let k = gz - r; k <= gz + r; k++) for (const s of cells.get(`${i},${k}`) ?? []) best = Math.min(best, segDist(x, z, s[0], s[1], s[2], s[3]));
        return best <= maxM ? best : null;
    };
}

/** Every cluster's evidence (see the file comment). */
export function blobEvidence(audit: ResidualAuditResult, look: Pick<EvidenceLookup, 'buildingAt' | 'roadAt' | 'landuseAt'>, ev: Pick<VectorEvidence, 'buildings' | 'roads'>): BlobEvidence[] {
    const rings: Array<Array<[number, number]>> = [];
    for (const b of ev.buildings) for (const part of b.parts) for (const loop of part) rings.push([...loop.map(p => [p[0], p[1]] as [number, number]), [loop[0][0], loop[0][1]]]);
    const toBuilding = nearestEdges(rings), toRoad = nearestEdges(ev.roads.map(l => l.map(p => [p[0], p[1]] as [number, number])));
    return audit.clusters.map(c => {
        const cx = (c.lo[0] + c.hi[0]) / 2, cz = (c.lo[2] + c.hi[2]) / 2;
        const fr = c.frame, ext = fr.extentsM;
        const corners: Array<[number, number]> = [-1, 1].flatMap(sx => [-1, 1].map(sz => [fr.origin[0] + (sx * ext[0] / 2) * fr.xAxis[0] + (sz * ext[2] / 2) * fr.zAxis[0], fr.origin[2] + (sx * ext[0] / 2) * fr.xAxis[2] + (sz * ext[2] / 2) * fr.zAxis[2]] as [number, number]));
        const inFootprint = look.buildingAt(cx, cz) >= 0;
        const touches = inFootprint || corners.some(([x, z]) => look.buildingAt(x, z) >= 0);
        const dB = toBuilding(cx, cz, 60);
        const top = c.attachment as unknown as { topAboveSupportM?: number | null };
        return {
            clusterId: c.id, centre: [r3(cx), r3(cz)],
            box: { origin: [r3(fr.origin[0]), r3(fr.origin[2])], xAxis: [r3(fr.xAxis[0]), r3(fr.xAxis[2])], extentsM: [r3(ext[0]), r3(ext[2])] },
            verdict: c.verdict, auditConfidence: r3(c.confidence),
            heightM: r3(c.hi[1] - c.lo[1]), standM: typeof top.topAboveSupportM === 'number' ? r3(top.topAboveSupportM) : null,
            planM: [r3(Math.max(ext[0], ext[2])), r3(Math.min(ext[0], ext[2]))], areaM2: r3(c.areaM2), triangles: c.triangles,
            verticality: r3(c.shape.mainAxisVerticality), thinness: r3(c.shape.thinness), elongation: r3(c.shape.elongation),
            radialSymmetry: r3(c.symmetry.radialSymmetry), radiusMedianM: r3(c.symmetry.radiusMedianM), periodM: r3(c.symmetry.periodM),
            upShare: r3(c.surface.upShare), sideShare: r3(c.surface.sideShare), groundedShare: r3(c.attachment.groundedShare),
            vector: {
                inFootprint, touchesFootprint: touches,
                toBuildingM: dB === null ? null : r3(inFootprint ? -dB : dB),
                toRoadM: (() => { const d = toRoad(cx, cz, 80); return d === null ? null : r3(d); })(),
                onCarriageway: look.roadAt(cx, cz), landuse: look.landuseAt(cx, cz) ?? []
            }
        };
    });
}

/** Which clusters the read takes: not a building's part (inside or touching a footprint), not a scan artefact the audit measured. */
export function blobsToRead(evidence: BlobEvidence[]): { read: BlobEvidence[]; leftOut: Array<{ clusterId: number; reason: string }> } {
    const read: BlobEvidence[] = [], leftOut: Array<{ clusterId: number; reason: string }> = [];
    for (const e of evidence) {
        if (e.vector.touchesFootprint) leftOut.push({ clusterId: e.clusterId, reason: e.vector.inFootprint ? 'inside a building footprint: a part of the building, not a street blob' : 'touching a building footprint: a part of the building, not a street blob' });
        else if (e.verdict === 'scan-artefact') leftOut.push({ clusterId: e.clusterId, reason: `a scan artefact by the audit's measures (confidence ${e.auditConfidence})` });
        else read.push(e);
    }
    return { read, leftOut };
}

// ---- the contact sheets ---------------------------------------------------------------------------------------------

/** 3 x 5 digits, one bit a pixel, rows top to bottom. */
const DIGITS = ['111101101101111', '010110010010111', '111001111100111', '111001111001111', '101101111001001', '111100111001111', '111100111101111', '111001001001001', '111101111101111', '111101111001111'];

function drawNumber(rgba: Uint8Array, W: number, x0: number, y0: number, n: number, scale = 4): void {
    const s = String(n);
    const w = s.length * 4 * scale + scale, h = 7 * scale;
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) { const i = (y * W + x) * 4; rgba[i] = 0; rgba[i + 1] = 0; rgba[i + 2] = 0; rgba[i + 3] = 255; }
    [...s].forEach((ch, k) => {
        const bits = DIGITS[Number(ch)];
        for (let r = 0; r < 5; r++) for (let c = 0; c < 3; c++) if (bits[r * 3 + c] === '1')
            for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
                const x = x0 + scale + k * 4 * scale + c * scale + dx, y = y0 + scale + r * scale + dy, i = (y * W + x) * 4;
                rgba[i] = 255; rgba[i + 1] = 255; rgba[i + 2] = 255;
            }
    });
}

function line(rgba: Uint8Array, W: number, H: number, ax: number, ay: number, bx: number, by: number, col: [number, number, number]): void {
    const n = Math.ceil(Math.hypot(bx - ax, by - ay) * 2) + 1;
    for (let t = 0; t <= n; t++) {
        const x = Math.round(ax + ((bx - ax) * t) / n), y = Math.round(ay + ((by - ay) * t) / n);
        for (const [ox, oy] of [[0, 0], [1, 0], [0, 1]]) { const px = x + ox, py = y + oy; if (px >= 0 && py >= 0 && px < W && py < H) { const i = (py * W + px) * 4; rgba[i] = col[0]; rgba[i + 1] = col[1]; rgba[i + 2] = col[2]; } }
    }
}

/** The patch side (m) a cluster is shown at. */
export const patchSideM = (e: BlobEvidence, P = BLOB_READ_PARAMS) => Math.max(P.minPatchM, P.patchScale * Math.max(e.planM[0], 1));

/** One contact sheet: each cluster's square patch of the orthophoto (resampled to patchPx), its plan box outlined in magenta, its number in a corner. */
export function contactSheet(ortho: TopDownPhoto & { x0: number; z0: number }, blobs: BlobEvidence[], P = BLOB_READ_PARAMS): { rgba: Uint8Array; width: number; height: number } {
    const cols = P.sheetColumns, rows = Math.ceil(blobs.length / cols), S = P.patchPx, gap = 6;
    const W = cols * S + (cols + 1) * gap, H = rows * S + (rows + 1) * gap;
    const out = new Uint8Array(W * H * 4).fill(255);
    blobs.forEach((e, n) => {
        const ox = gap + (n % cols) * (S + gap), oy = gap + Math.floor(n / cols) * (S + gap);
        const side = patchSideM(e, P), px0 = e.centre[0] - side / 2, pz0 = e.centre[1] - side / 2;
        for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
            const wx = px0 + ((x + 0.5) / S) * side, wz = pz0 + ((y + 0.5) / S) * side;
            const sx = Math.floor((wx - ortho.x0) / ortho.texelM), sy = Math.floor((wz - ortho.z0) / ortho.texelM);
            const o = ((oy + y) * W + ox + x) * 4;
            if (sx < 0 || sy < 0 || sx >= ortho.width || sy >= ortho.height) { out[o] = out[o + 1] = out[o + 2] = 128; continue; }
            const i = (sy * ortho.width + sx) * 4;
            out[o] = ortho.rgba[i]; out[o + 1] = ortho.rgba[i + 1]; out[o + 2] = ortho.rgba[i + 2]; out[o + 3] = 255;
        }
        // the plan box, in the patch's pixels
        const b = e.box, zx = -b.xAxis[1], zz = b.xAxis[0];
        const toPx = (wx: number, wz: number): [number, number] => [ox + ((wx - px0) / side) * S, oy + ((wz - pz0) / side) * S];
        const c = [-1, 1, 1, -1].map((sx, k) => { const sz = [-1, -1, 1, 1][k]; return toPx(b.origin[0] + (sx * b.extentsM[0] / 2) * b.xAxis[0] + (sz * b.extentsM[1] / 2) * zx, b.origin[1] + (sx * b.extentsM[0] / 2) * b.xAxis[1] + (sz * b.extentsM[1] / 2) * zz); });
        for (let k = 0; k < 4; k++) line(out, W, H, c[k][0], c[k][1], c[(k + 1) % 4][0], c[(k + 1) % 4][1], [255, 0, 255]);
        drawNumber(out, W, ox + 2, oy + 2, n + 1);
    });
    return { rgba: out, width: W, height: H };
}

export function blobReadPrompt(blobs: BlobEvidence[], P = BLOB_READ_PARAMS): string {
    const f = (v: number | null, d = 1) => (v === null ? 'n/a' : v.toFixed(d));
    return [
        `This image is a contact sheet of ${blobs.length} numbered patches cut from a top-down orthophoto of a city district (Google's photorealistic 3D tiles, seen from straight above; north is not necessarily up).`,
        'Each patch is centred on one blob that a coarse 3D scan of the district shows standing proud of the ground away from the buildings; its plan extent is outlined in magenta. The scan is coarse: a blob may be a real thing (anything at all a street can hold), several things melted together, or a fault of the scan itself.',
        'Beside each patch, the scan\'s own measures and where the blob stands against the map:',
        ...blobs.map((e, i) => `Patch ${i + 1}: ${f(patchSideM(e, P), 0)} m across; ${f(e.heightM)} m tall (top ${f(e.standM)} m above what supports it); plan ${f(e.planM[0])} x ${f(e.planM[1])} m; main-axis verticality ${f(e.verticality, 2)} (1 upright); thinness ${f(e.thinness, 2)} (0 a thin sheet or rod, 1 a solid body); radial symmetry ${f(e.radialSymmetry, 2)}; facing up ${f(e.upShare, 2)}, facing sideways ${f(e.sideShare, 2)}; grounded ${f(e.groundedShare, 2)}${e.periodM > 0 ? `; repeats every ${f(e.periodM)} m` : ''}; ${f(e.vector.toBuildingM)} m from the nearest building line; ${f(e.vector.toRoadM)} m from the nearest road centreline${e.vector.onCarriageway ? ', on the carriageway' : ''}${e.vector.landuse.length ? `; land use ${e.vector.landuse.join(', ')}` : ''}.`),
        'For every patch give:',
        '- "patch": its number;',
        '- "label": what the blob is, in a few plain words of your own;',
        '- "confidence": 0 to 1, how sure you are of the label from this evidence alone;',
        '- "standing": 0 to 1, 0 when it lies flat on the ground (a stain, a patch of repair, moss, litter), 1 when it stands up off it;',
        '- "permanent": 0 to 1, 0 when put out for a while (works, a parked vehicle, a delivery), 1 when installed to stay;',
        '- "scanFault": 0 to 1, how likely the blob is a fault of the scan rather than a thing (a melted copy of a wall, a spike, a floating sliver);',
        '- "notes": optional, a few words on what decided it.',
        'Reply with JSON only: {"blobs": [{"patch": 1, "label": "...", "confidence": 0.7, "standing": 1, "permanent": 1, "scanFault": 0.1}, ...]}'
    ].join('\n');
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/** Parses a sheet's reply into labels (patches the reply leaves out get none: never guessed). */
export function parseBlobReading(text: string, blobs: BlobEvidence[], sheet: number): BlobLabel[] | { error: string } {
    let j: { blobs?: unknown };
    try { j = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, '')) as { blobs?: unknown }; } catch (e) { return { error: `the reply is not JSON (${(e as Error).message})` }; }
    if (!j || !Array.isArray(j.blobs)) return { error: 'the reply has no "blobs" list' };
    const out: BlobLabel[] = [];
    const seen = new Set<number>();
    for (const r of j.blobs as Array<Record<string, unknown>>) {
        const i = (num(r?.patch) ?? 0) - 1;
        if (i < 0 || i >= blobs.length || seen.has(i) || typeof r.label !== 'string' || !r.label.trim()) continue;
        seen.add(i);
        out.push({
            clusterId: blobs[i].clusterId, label: r.label.trim(), confidence: clamp01(num(r.confidence) ?? 0), standing: clamp01(num(r.standing) ?? 0.5),
            permanent: clamp01(num(r.permanent) ?? 0.5), scanFault: clamp01(num(r.scanFault) ?? 0), ...(typeof r.notes === 'string' && r.notes.trim() ? { notes: r.notes.trim() } : {}),
            sheet, provenance: 'photo-inferred'
        });
    }
    return out;
}

/** The district's orthophoto over the clusters' extent (plus a margin), exact at the ground's level. */
export function districtOrtho(tile: TileTriangles, evidence: BlobEvidence[], groundY: number, P = BLOB_READ_PARAMS): TopDownPhoto & { x0: number; z0: number } {
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (const e of evidence) { const h = patchSideM(e, P) / 2 + 1; x0 = Math.min(x0, e.centre[0] - h); z0 = Math.min(z0, e.centre[1] - h); x1 = Math.max(x1, e.centre[0] + h); z1 = Math.max(z1, e.centre[1] + h); }
    const frame = { x0, z0, widthM: x1 - x0, heightM: z1 - z0 };
    const photo = renderTopDownPhoto(tile, frame, { texelM: P.texelM, maxPx: P.maxOrthoPx, referenceY: groundY });
    return { ...photo, x0, z0 };
}

/** Reads every blob (see the file comment). */
export async function readBlobs(input: {
    audit: ResidualAuditResult; look: Pick<EvidenceLookup, 'buildingAt' | 'roadAt' | 'landuseAt'>; vector: Pick<VectorEvidence, 'buildings' | 'roads'>;
    tile: TileTriangles; vision: VisionModelChain<string>; store?: ModelReadingStore; params?: Partial<typeof BLOB_READ_PARAMS>;
    /** Writes each sheet as JPEG (the tile's own photo, no Street View), for the proof. */
    onSheet?: (index: number, jpeg: Buffer) => void;
    signal?: AbortSignal; onProgress?: (m: string) => void;
}): Promise<BlobReadReport> {
    const P = { ...BLOB_READ_PARAMS, ...(input.params ?? {}) };
    const progress = input.onProgress ?? (() => undefined);
    const evidence = blobEvidence(input.audit, input.look, input.vector);
    const { read, leftOut } = blobsToRead(evidence);
    read.sort((a, b) => a.clusterId - b.clusterId);
    const groundY = input.audit.groundY ?? (() => { const ys = input.audit.clusters.map(c => c.lo[1]).sort((a, b) => a - b); return ys[ys.length >> 1] ?? 0; })();
    progress(`drawing the district's orthophoto from the tile for ${read.length} blobs`);
    const t0 = Date.now();
    const ortho = read.length ? districtOrtho(input.tile, read, groundY, P) : undefined;
    const orthoMs = Date.now() - t0;
    const batches: BlobEvidence[][] = [];
    for (let i = 0; i < read.length; i += P.patchesPerSheet) batches.push(read.slice(i, i + P.patchesPerSheet));
    const labels: BlobLabel[] = [], sheets: BlobReadReport['sheets'] = [];
    let visionCalls = 0, storeHits = 0, next = 0;
    const t1 = Date.now();
    const worker = async () => {
        while (next < batches.length) {
            const index = next++, blobs = batches[index];
            const ts = Date.now();
            const sheet = contactSheet(ortho!, blobs, P);
            const jpeg = Buffer.from(jpegJs.encode({ data: Buffer.from(sheet.rgba.buffer, sheet.rgba.byteOffset, sheet.rgba.byteLength), width: sheet.width, height: sheet.height }, 88).data);
            input.onSheet?.(index, jpeg);
            const prompt = blobReadPrompt(blobs, P);
            const key = readingKey('blob-read', [BLOB_READ_VERSION, input.vision.requested, prompt, jpeg]);
            let text = input.store ? await input.store.get<string>(key) : undefined;
            const cached = text !== undefined;
            let error: string | undefined;
            if (cached) storeHits++;
            else {
                const own = new AbortController();
                const timer = setTimeout(() => own.abort(new Error(`the vision call took longer than ${P.timeoutMs / 1000} s`)), P.timeoutMs);
                try {
                    progress(`reading blobs: sheet ${index + 1} of ${batches.length}`);
                    const r = await input.vision.generate({
                        contents: [{ role: 'user', parts: [{ inlineData: { mimeType: 'image/jpeg', data: jpeg.toString('base64') } }, { text: prompt }] }],
                        config: { responseMimeType: 'application/json', temperature: 0, maxOutputTokens: P.maxOutputTokens, abortSignal: input.signal ? AbortSignal.any([input.signal, own.signal]) : own.signal }
                    }, { stage: 'street-objects' });
                    visionCalls++;
                    text = (r.response.candidates?.[0]?.content?.parts ?? []).filter(p => !(p as { thought?: boolean }).thought).map(p => p.text ?? '').join('');
                    r.remember();
                } catch (err) {
                    if (input.signal?.aborted) throw err;
                    error = err instanceof Error ? err.message : String(err);
                } finally { clearTimeout(timer); }
            }
            if (text !== undefined) {
                const parsed = parseBlobReading(text, blobs, index);
                if ('error' in parsed) error = parsed.error;
                else { labels.push(...parsed); if (!cached) input.store?.put(key, text); }
            }
            sheets.push({ index, clusters: blobs.map(b => b.clusterId), key, cached, ms: Date.now() - ts, ...(error ? { error } : {}) });
        }
    };
    await Promise.all(Array.from({ length: Math.min(P.concurrency, batches.length) }, worker));
    labels.sort((a, b) => a.clusterId - b.clusterId);
    sheets.sort((a, b) => a.index - b.index);
    const confident = labels.filter(l => l.confidence >= P.confidentAt).length;
    return {
        schema: 'scratchbox.blob-read/1', version: BLOB_READ_VERSION, evidence, leftOut, labels, sheets,
        stats: {
            clusters: evidence.length, read: read.length, confident, unsure: read.length - confident,
            inFootprint: leftOut.filter(l => /footprint/.test(l.reason)).length, artefacts: leftOut.filter(l => /artefact/.test(l.reason)).length,
            visionCalls, storeHits, orthoMs, readMs: Date.now() - t1
        }
    };
}
