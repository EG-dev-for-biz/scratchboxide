/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Vehicles out of the scan (user rule, 2026-10-22): every staged build removes the cars, vans, buses, trams and trucks the
 * Google Photorealistic 3D Tiles scan baked in (melted lumps on carriageways and kerbsides) and leaves the street under
 * them seamless: no hole, no lump, no smeared car texture.
 *
 * 1. Candidates (measured): the scan's top surface on a fine grid against the measured street (GroundModel); cells standing
 *    proud of it, clear of the vector buildings, joined into components. Measures only pick what the model is shown.
 * 2. The decision (the model's judgement, never a noun list): each candidate is shown to the vision model in a top-down
 *    orthophoto of the textured scan around it; the model boxes every vehicle it sees, in its own words, with whether it is
 *    a vehicle and whether it stands there only for a while. Proud cells inside a vehicle's box are the vehicle.
 * 3. The patch (geometry): the vehicle's cells, widened by its skirt, are one region; the surface infill
 *    (surface-infill.ts) rebuilds the street under it from the measured scan just outside it (the ring's levels, a kerb
 *    kept sharp, grade and camber kept), and every scan vertex in it is moved down onto that surface, so the kerb and the
 *    road around keep their heights and the mesh keeps its topology: no triangle is removed, so no edge opens, and the lump
 *    is gone.
 * 4. The patch (texture): the surface infill paints the region from the street itself, each texel by the first rung of
 *    its ladder whose fill passes the seam gate: a registered view that sees the street clear, then a continuation along
 *    the street's measured direction (lane lines, kerbs, a crosswalk's bars at their measured period) or its measured
 *    repeat, then patches of its own grain; the other regions and the vehicles nothing was patched for are never a
 *    source. Painted from the plan position alone, so folded triangles of the old lump that now lie on each other show
 *    the same colour.
 *
 * Every removal is labelled in the GLB's root extras (sbVehicleRemoval): what the model called it, the region, the patch's
 * provenance (heights estimated from the measured ring: generated; texels by the infill's labels: measured, photo-inferred,
 * generated) with the reason; the infill's own record per region (sbInfill) beside it.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as jpegJs from 'jpeg-js';
import type { GroundModel, ScanMesh } from '../../spatial/StreetViewSurveyPlanner';
import { assembleGlb, invert, nodeWorldMatrices, parseGlbBytes, isIdentity, transformPoint } from './glb-bytes';
import { readTileTriangles, selectTriangles, type TileTriangles } from './tile-texture-transfer';
import { topDownCamera, type TopDownFrame } from './top-down-photo';
import { renderTriangles } from './photo-match-eval';
import { applyInfillToGlb, cellsToTriangles, infillExtras, infillRegions, writeInfillRecords, type InfillRegionSpec } from './surface-infill';
import type { VisionModelChain } from '../../gemini/vision-model-chain';

export const VEHICLE_REMOVAL_VERSION = 'vehicle-removal/5';  // 5: the surface infill rebuilds the street under a region and paints it

export const VEHICLE_REMOVAL_PARAMS = {
    /** The top-surface grid. */
    cellM: 0.25,
    /** A cell whose scan top stands at least this far above the measured street is proud (a kerb is 0.15 m). */
    proudMinM: 0.4,
    /** Taller than this is not cut (a double-deck bus is 4.4 m); the patch never moves a vertex more than this above its surface. */
    proudMaxM: 5,
    /** Proud cells this close (plan) to a vector building footprint belong to the building. */
    buildingClearM: 1,
    /** Components smaller than this are not shown to the model (scan noise, bollards). */
    componentMinAreaM2: 1.5,
    /** Components larger than this are not shown (a building part the vector data misses, a whole market). */
    componentMaxAreaM2: 600,
    /** The crops the model reads: at least this wide, at this texel (a car is about 80 pixels long). */
    cropM: 56,
    cropTexelM: 0.056,
    /** The crop never reaches past this many pixels a side (the texel grows). */
    cropMaxPx: 1000,
    /** A vehicle box is widened by this before its proud cells are taken. */
    boxPadM: 0.4,
    /** A component with at least this share of its cells inside vehicle boxes is taken whole; below `componentPartShare` it is left. */
    componentWholeShare: 0.8,
    componentPartShare: 0.2,
    /** A vehicle box with nothing proud under it is patched this share inside each of its edges; a matched one's box is added this share inside. */
    unmatchedBoxInset: 0.1,
    matchedBoxInset: 0.08,
    /** A vertical gap at least this tall between scan surfaces over a cell is open space: what is above it is not the vehicle. */
    stackGapM: 1,
    /** The stack starts at the first surface no further than this below the street. */
    stackBelowStreetM: 0.5,
    /** The model's confidence at or above which a vehicle (or a temporary object) is removed. */
    minConfidence: 0.5,
    /**
     * Street clutter (user decision, 2026-10-30): what the model reads as neither a vehicle nor permanent (a vendor cart, a
     * plaza umbrella, a scaffold shed: not in a model of the place next month) is removed with the vehicles; permanent
     * fixtures (shelters, subway entrances, kiosks, planters, lamps, trees) stay. SCRATCHBOX_STAGED_CLUTTER=0 keeps them.
     */
    removeTemporary: true,
    /**
     * Debris on the carriageway: a proud lump too small to show the model (`componentMinAreaM2`) but at least this big (m²),
     * at most `debrisMaxHeightM` tall, with at least `debrisRoadShare` of it inside the road corridor (Google's centreline
     * and ROAD_HALF_WIDTH_M either side: the carriageway, not the sidewalk, whose posts, hydrants and bollards stay) is a
     * remnant, a dropped load or the scan's own blob, and is patched like a vehicle without a reading. Infinity: none.
     */
    debrisMinAreaM2: 0.25,
    debrisMaxHeightM: 1.5,
    debrisRoadShare: 0.8,
    /** The region grows by this around the vehicle's cells (the lump's skirt down to the road). */
    skirtM: 0.75,
    /** The ring the patch heights are measured from: this far outside the region, scan vertices this close to the street. */
    ringM: 1.5,
    ringMaxAboveStreetM: 0.35,
    ringMaxSamples: 400,
    /** Concurrent model calls. */
    concurrency: 10,
    /** Each call's limit. */
    timeoutMs: 90_000,
    /** Crops read in one call (visionVehicleBatchJudge): a district's hundreds of crops in a tenth of the calls; a crop the
     * batch's answer leaves out is read again on its own. 1: one crop a call. */
    batch: 6,
    /** A batch call's limit: its images are read together. */
    batchTimeoutMs: 180_000,
    sendQuality: 90
};
export type VehicleRemovalParams = typeof VEHICLE_REMOVAL_PARAMS & {
    /**
     * Keep what stands over open space in a region (measureStacks: an awning, a canopy over the vehicle). Default true. The
     * seen-through removal (seen-through.ts) passes false: the registered photos see through the whole height of what they
     * remove, so nothing of it stays as an awning and no ramp joins a kept top to the lowered base.
     */
    keepOverOpenSpace?: boolean;
};

/** On by default (the user rule); SCRATCHBOX_STAGED_VEHICLES=0 keeps the scan's vehicles. */
export function vehicleRemovalEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
    return env.SCRATCHBOX_STAGED_VEHICLES !== '0';
}

export interface VehicleLookups {
    buildingAt?: (x: number, z: number) => number;
    waterAt?: (x: number, z: number) => boolean;
    roadAt?: (x: number, z: number) => boolean;
    within?: (x: number, z: number) => boolean;
}

// ------------------------------------------------------------------------------------------------ 1. candidates

export interface ProudGrid {
    x0: number; z0: number; nx: number; nz: number; cellM: number;
    /** Scan top above the measured street per cell (NaN: no scan or no street). */
    rel: Float32Array;
    /** Component per proud cell (-1: not a candidate). */
    comp: Int32Array;
    /** 1 where a vehicle may be patched at all: inside the extraction's cover, not on water. */
    street: Uint8Array;
    /** The carriageway's debris: lumps too small to show the model, each its cells (patched without a reading). */
    debris?: number[][];
}

export interface VehicleCandidate {
    id: number;
    cells: number[];
    areaM2: number;
    /** Highest top above the street. */
    heightM: number;
    lo: [number, number]; hi: [number, number];
    /** Share of its cells on a Google vector road (a cue for ranking and the report, never the decision). */
    onRoadShare: number;
}

/** The scan's top surface per cell (max height of the triangles covering the cell centre, and of the vertices in it). */
export function topSurface(scan: ScanMesh, cellM: number): { x0: number; z0: number; nx: number; nz: number; top: Float32Array } {
    const x0 = Math.floor(scan.bounds.min[0] / cellM) * cellM - cellM, z0 = Math.floor(scan.bounds.min[2] / cellM) * cellM - cellM;
    const nx = Math.ceil((scan.bounds.max[0] - x0) / cellM) + 2, nz = Math.ceil((scan.bounds.max[2] - z0) / cellM) + 2;
    const top = new Float32Array(nx * nz).fill(NaN);
    const V = scan.mesh.vertices as ArrayLike<number>, I = scan.mesh.indices as ArrayLike<number>;
    const put = (i: number, k: number, y: number) => {
        if (i < 0 || k < 0 || i >= nx || k >= nz) return;
        const c = k * nx + i;
        if (!(top[c] >= y)) top[c] = y;
    };
    for (let t = 0; t < scan.triCount; t++) {
        const a = I[t * 3] * 3, b = I[t * 3 + 1] * 3, c = I[t * 3 + 2] * 3;
        const ax = V[a], ay = V[a + 1], az = V[a + 2], bx = V[b], by = V[b + 1], bz = V[b + 2], cx = V[c], cy = V[c + 1], cz = V[c + 2];
        put(Math.floor((ax - x0) / cellM), Math.floor((az - z0) / cellM), ay);
        put(Math.floor((bx - x0) / cellM), Math.floor((bz - z0) / cellM), by);
        put(Math.floor((cx - x0) / cellM), Math.floor((cz - z0) / cellM), cy);
        const det = (bx - ax) * (cz - az) - (cx - ax) * (bz - az);
        if (Math.abs(det) < 1e-9) continue;
        const i0 = Math.floor((Math.min(ax, bx, cx) - x0) / cellM), i1 = Math.floor((Math.max(ax, bx, cx) - x0) / cellM);
        const k0 = Math.floor((Math.min(az, bz, cz) - z0) / cellM), k1 = Math.floor((Math.max(az, bz, cz) - z0) / cellM);
        for (let k = k0; k <= k1; k++) for (let i = i0; i <= i1; i++) {
            const px = x0 + (i + 0.5) * cellM, pz = z0 + (k + 0.5) * cellM;
            const u = ((bx - px) * (cz - pz) - (cx - px) * (bz - pz)) / det;
            const v = ((cx - px) * (az - pz) - (ax - px) * (cz - pz)) / det;
            const w = 1 - u - v;
            if (u < -1e-6 || v < -1e-6 || w < -1e-6) continue;
            put(i, k, u * ay + v * by + w * cy);
        }
    }
    return { x0, z0, nx, nz, top };
}

/** Within `r` metres (plan) of a vector building cell. */
function nearBuilding(buildingAt: (x: number, z: number) => number, x: number, z: number, r: number): boolean {
    if (buildingAt(x, z) > 0) return true;
    const n = Math.ceil(r);
    for (let dz = -n; dz <= n; dz++) for (let dx = -n; dx <= n; dx++) if (dx * dx + dz * dz <= r * r + 1e-6 && buildingAt(x + dx, z + dz) > 0) return true;
    return false;
}

/** The proud components: what the model is shown. */
export function vehicleCandidates(scan: ScanMesh, ground: GroundModel, look: VehicleLookups = {}, P: VehicleRemovalParams = VEHICLE_REMOVAL_PARAMS): { grid: ProudGrid; candidates: VehicleCandidate[] } {
    // (the grid also carries the carriageway's debris: lumps too small to show the model, patched without a reading)
    const s = topSurface(scan, P.cellM);
    const { x0, z0, nx, nz, top } = s;
    const rel = new Float32Array(nx * nz).fill(NaN);
    const proud = new Uint8Array(nx * nz);
    const street = new Uint8Array(nx * nz);
    for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) {
        const c = k * nx + i;
        if (top[c] !== top[c]) continue;
        const x = x0 + (i + 0.5) * P.cellM, z = z0 + (k + 0.5) * P.cellM;
        const g = ground.groundAt(x, z);
        if (g !== g) continue;
        rel[c] = top[c] - g;
        if (look.within && !look.within(x, z)) continue;
        if (look.waterAt?.(x, z)) continue;
        street[c] = 1;
        if (rel[c] < P.proudMinM || rel[c] > P.proudMaxM) continue;
        if (look.buildingAt && nearBuilding(look.buildingAt, x, z, P.buildingClearM)) continue;
        proud[c] = 1;
    }
    const comp = new Int32Array(nx * nz).fill(-1);
    const candidates: VehicleCandidate[] = [];
    const debris: number[][] = [];
    const stack: number[] = [];
    const seen = new Uint8Array(nx * nz);
    let next = 0;
    for (let c0 = 0; c0 < nx * nz; c0++) {
        if (!proud[c0] || seen[c0]) continue;
        const cells: number[] = [];
        comp[c0] = next; seen[c0] = 1; stack.push(c0);
        while (stack.length) {
            const c = stack.pop()!;
            cells.push(c);
            const i = c % nx, k = (c - i) / nx;
            for (let dk = -1; dk <= 1; dk++) for (let di = -1; di <= 1; di++) {
                const ii = i + di, kk = k + dk;
                if (ii < 0 || kk < 0 || ii >= nx || kk >= nz) continue;
                const n = kk * nx + ii;
                if (proud[n] && !seen[n]) { comp[n] = next; seen[n] = 1; stack.push(n); }
            }
        }
        const areaM2 = cells.length * P.cellM * P.cellM;
        if (areaM2 < P.componentMinAreaM2 || areaM2 > P.componentMaxAreaM2) {
            for (const c of cells) comp[c] = -1;
            // too small for the model: debris when it lies low on the carriageway
            if (areaM2 >= P.debrisMinAreaM2 && areaM2 < P.componentMinAreaM2 && look.roadAt) {
                let road = 0, h = 0;
                for (const c of cells) { const i = c % nx, k = (c - i) / nx; if (look.roadAt(x0 + (i + 0.5) * P.cellM, z0 + (k + 0.5) * P.cellM)) road++; h = Math.max(h, rel[c]); }
                if (h <= P.debrisMaxHeightM && road >= P.debrisRoadShare * cells.length) debris.push(cells);
            }
            continue;
        }
        let lx = Infinity, lz = Infinity, hx = -Infinity, hz = -Infinity, h = 0, road = 0;
        for (const c of cells) {
            const i = c % nx, k = (c - i) / nx;
            const x = x0 + i * P.cellM, z = z0 + k * P.cellM;
            lx = Math.min(lx, x); lz = Math.min(lz, z); hx = Math.max(hx, x + P.cellM); hz = Math.max(hz, z + P.cellM);
            h = Math.max(h, rel[c]);
            if (look.roadAt?.(x + P.cellM / 2, z + P.cellM / 2)) road++;
        }
        candidates.push({ id: next, cells, areaM2, heightM: h, lo: [lx, lz], hi: [hx, hz], onRoadShare: cells.length ? road / cells.length : 0 });
        next++;
    }
    // renumber the kept components densely (dropped ones were reset to -1)
    const remap = new Map<number, number>();
    candidates.forEach((c, k) => remap.set(c.id, k));
    for (let c = 0; c < comp.length; c++) if (comp[c] >= 0) comp[c] = remap.get(comp[c]) ?? -1;
    candidates.forEach((c, k) => { c.id = k; });
    return { grid: { x0, z0, nx, nz, cellM: P.cellM, rel, comp, street, debris }, candidates };
}

/** Crops covering every candidate whole: greedy, the largest first, each crop centred on the candidate it starts from. */
export function planCrops(candidates: VehicleCandidate[], P: VehicleRemovalParams = VEHICLE_REMOVAL_PARAMS): Array<{ frame: TopDownFrame; members: number[] }> {
    const crops: Array<{ frame: TopDownFrame; members: number[] }> = [];
    const covered = new Set<number>();
    const order = candidates.slice().sort((a, b) => b.areaM2 - a.areaM2);
    const inside = (c: VehicleCandidate, f: TopDownFrame) => c.lo[0] >= f.x0 + 1 && c.lo[1] >= f.z0 + 1 && c.hi[0] <= f.x0 + f.widthM - 1 && c.hi[1] <= f.z0 + f.heightM - 1;
    for (const c of order) {
        if (covered.has(c.id)) continue;
        const w = Math.max(P.cropM, c.hi[0] - c.lo[0] + 6, c.hi[1] - c.lo[1] + 6);
        const cx = (c.lo[0] + c.hi[0]) / 2, cz = (c.lo[1] + c.hi[1]) / 2;
        const frame: TopDownFrame = { x0: cx - w / 2, z0: cz - w / 2, widthM: w, heightM: w };
        const members = candidates.filter(o => inside(o, frame)).map(o => o.id);
        if (!members.includes(c.id)) members.push(c.id);
        for (const m of members) covered.add(m);
        crops.push({ frame, members });
    }
    return crops;
}

// ------------------------------------------------------------------------------------------------ 2. the model's reading

/** One thing the model boxed in a crop, placed in plan. */
export interface VehicleReading {
    /** The model's own words. */
    label: string;
    vehicle: boolean;
    /** False: it stands there only for a while (the model's judgement). */
    permanent: boolean;
    confidence: number;
    lo: [number, number]; hi: [number, number];
    crop: number;
}

export interface VehicleCrop { index: number; frame: TopDownFrame; jpeg: Buffer; widthPx: number; heightPx: number; texelM: number }

/** Reads one crop: what in it is a vehicle. Implemented by the vision model (visionVehicleJudge); tests give their own. */
export type VehicleJudge = (crop: VehicleCrop, signal?: AbortSignal) => Promise<VehicleReading[]>;

export function vehiclePrompt(crop: Pick<VehicleCrop, 'frame' | 'texelM'>): string {
    const w = Math.round(crop.frame.widthM), h = Math.round(crop.frame.heightM);
    return `A top-down orthophoto, north up, of a photogrammetry scan of a real city: ${w} m by ${h} m, about ${Math.round(crop.texelM * 100)} cm per pixel. ` +
        'The scan bakes in whatever stood there when it was flown; objects come out as soft, melted, rounded blobs with their colours smeared over them. ' +
        'Find every vehicle in it of any kind and size, parked or moving, wherever it stands (road, kerbside, car park, tracks, driveway), even when it is half melted into the road or cut off by the image edge. ' +
        'Give each one its own box, tight around it, even in a row of vehicles nose to tail. Also box anything else you considered and decided is not a vehicle, so the decision is explicit. ' +
        'Reply JSON only: {"objects": [{"box_2d": [ymin, xmin, ymax, xmax] in 0-1000 of this image, "label": "a few words of what it is", ' +
        '"vehicle": true|false, "permanent": true|false (false when it stands there only for a while and would not be in a model of the place next month), "confidence": 0..1}]}. ' +
        'An empty list is a correct answer when there is nothing.';
}

/** Reads several crops in one call: per crop index, what in it is a vehicle; a crop missing from the map was not answered. */
export type VehicleBatchJudge = (crops: VehicleCrop[], signal?: AbortSignal) => Promise<Map<number, VehicleReading[]>>;

/** The prompt for several crops at once: each image is introduced by its number, size and scale before it is sent. */
export function vehicleBatchPrompt(count: number): string {
    return `The ${count} images above are top-down orthophotos, north up, of a photogrammetry scan of a real city, each introduced by its number, size and scale. ` +
        'The scan bakes in whatever stood there when it was flown; objects come out as soft, melted, rounded blobs with their colours smeared over them. ' +
        'In each image separately, find every vehicle of any kind and size, parked or moving, wherever it stands (road, kerbside, car park, tracks, driveway), even when it is half melted into the road or cut off by the image edge. ' +
        'Give each one its own box, tight around it, even in a row of vehicles nose to tail. Also box anything else you considered and decided is not a vehicle, so the decision is explicit. ' +
        'Reply JSON only: {"images": [{"image": the image\'s number, "objects": [{"box_2d": [ymin, xmin, ymax, xmax] in 0-1000 of that image, "label": "a few words of what it is", ' +
        '"vehicle": true|false, "permanent": true|false (false when it stands there only for a while and would not be in a model of the place next month), "confidence": 0..1}]}]}, ' +
        'one entry for every image, in order. An empty list of objects is a correct answer for an image with nothing.';
}

/** Parses a batch reply into each crop's plan boxes (crops[k] is image k + 1); a crop with no entry is left out of the map. */
export function parseVehicleBatchReply(text: string, crops: Array<Pick<VehicleCrop, 'frame' | 'index'>>): Map<number, VehicleReading[]> {
    const out = new Map<number, VehicleReading[]>();
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return out;
    let doc: any;
    try { doc = JSON.parse(m[0]); } catch { return out; }
    for (const e of Array.isArray(doc?.images) ? doc.images : []) {
        const k = Number(e?.image) - 1;
        if (!Number.isInteger(k) || k < 0 || k >= crops.length || !Array.isArray(e?.objects)) continue;
        out.set(crops[k].index, parseVehicleReply(JSON.stringify({ objects: e.objects }), crops[k]));
    }
    return out;
}

/** Parses the model's reply into plan boxes (the image's row 0 is the frame's minimum z). */
export function parseVehicleReply(text: string, crop: Pick<VehicleCrop, 'frame' | 'index'>): VehicleReading[] {
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return [];
    let doc: any;
    try { doc = JSON.parse(m[0]); } catch { return []; }
    const out: VehicleReading[] = [];
    for (const o of Array.isArray(doc?.objects) ? doc.objects : []) {
        const b = o?.box_2d;
        if (!Array.isArray(b) || b.length !== 4 || !b.every((v: unknown) => typeof v === 'number' && Number.isFinite(v))) continue;
        const [y0, x0, y1, x1] = b.map((v: number) => Math.max(0, Math.min(1000, v)) / 1000);
        if (y1 <= y0 || x1 <= x0) continue;
        const f = crop.frame;
        out.push({
            label: String(o.label ?? '').slice(0, 120), vehicle: o.vehicle === true, permanent: o.permanent !== false,
            confidence: typeof o.confidence === 'number' && Number.isFinite(o.confidence) ? Math.max(0, Math.min(1, o.confidence)) : 0.5,
            lo: [f.x0 + x0 * f.widthM, f.z0 + y0 * f.heightM], hi: [f.x0 + x1 * f.widthM, f.z0 + y1 * f.heightM], crop: crop.index
        });
    }
    return out;
}

/** The vision model reading several crops in one call (VEHICLE_REMOVAL_PARAMS.batch). */
export function visionVehicleBatchJudge(vision: VisionModelChain<string>, P: VehicleRemovalParams = VEHICLE_REMOVAL_PARAMS): VehicleBatchJudge {
    return async (crops, signal) => {
        const own = new AbortController();
        const timer = setTimeout(() => own.abort(new Error(`the vision call took longer than ${P.batchTimeoutMs / 1000} s`)), P.batchTimeoutMs);
        try {
            const parts = crops.flatMap((c, k) => [
                { text: `Image ${k + 1}: ${Math.round(c.frame.widthM)} m by ${Math.round(c.frame.heightM)} m, about ${Math.round(c.texelM * 100)} cm per pixel.` },
                { inlineData: { mimeType: 'image/jpeg', data: c.jpeg.toString('base64') } }
            ]);
            const r = await vision.generate({
                contents: [{ role: 'user', parts: [...parts, { text: vehicleBatchPrompt(crops.length) }] }],
                config: { responseMimeType: 'application/json', temperature: 0, maxOutputTokens: 8192 * Math.min(4, crops.length), abortSignal: signal ? AbortSignal.any([signal, own.signal]) : own.signal }
            }, { stage: 'vehicles' });
            const text = (r.response.candidates?.[0]?.content?.parts ?? []).filter(p => !(p as { thought?: boolean }).thought).map(p => p.text ?? '').join('');
            const got = parseVehicleBatchReply(text, crops);
            if (got.size) r.remember();
            return got;
        } finally { clearTimeout(timer); }
    };
}

/** The vision model as the judge. */
export function visionVehicleJudge(vision: VisionModelChain<string>, P: VehicleRemovalParams = VEHICLE_REMOVAL_PARAMS): VehicleJudge {
    return async (crop, signal) => {
        const own = new AbortController();
        const timer = setTimeout(() => own.abort(new Error(`the vision call took longer than ${P.timeoutMs / 1000} s`)), P.timeoutMs);
        try {
            const r = await vision.generate({
                contents: [{ role: 'user', parts: [{ inlineData: { mimeType: 'image/jpeg', data: crop.jpeg.toString('base64') } }, { text: vehiclePrompt(crop) }] }],
                config: { responseMimeType: 'application/json', temperature: 0, maxOutputTokens: 8192, abortSignal: signal ? AbortSignal.any([signal, own.signal]) : own.signal }
            }, { stage: 'vehicles' });
            const text = (r.response.candidates?.[0]?.content?.parts ?? []).filter(p => !(p as { thought?: boolean }).thought).map(p => p.text ?? '').join('');
            const readings = parseVehicleReply(text, crop);
            r.remember();
            return readings;
        } finally { clearTimeout(timer); }
    };
}

// ------------------------------------------------------------------------------------------------ 3. the region and its surface

export interface RegionGroup {
    id: number;
    cells: number[];
    /** The plan's long axis (unit). */
    axis: [number, number];
    lo: [number, number]; hi: [number, number];
    /** The model's readings it rests on. */
    readings: number[];
    /** Candidates it took (whole or in part). */
    candidates: number[];
    /** Cells it took as carriageway debris (no reading). */
    debrisCells?: number;
    /** Ring samples (x, y, z): the measured scan just outside it. */
    ring: Float32Array;
    /** The street height the ring gives when it is empty (GroundModel). */
    ringFromGroundModel: boolean;
}

export interface VehicleRegion {
    x0: number; z0: number; nx: number; nz: number; cellM: number;
    /** Group per cell (-1: outside every region). */
    group: Int32Array;
    groups: RegionGroup[];
    /**
     * Per cell, the top of the lowest continuous stack of scan surfaces (measureStacks): a vertex above it belongs to
     * something with open space beneath (an awning, a canopy, a gantry over the vehicle) and is never moved. Infinity: no limit.
     */
    ceiling: Float32Array;
    /** The candidates' grid: scan top above the street per cell (the fill takes its sources only where this is low: the street itself). */
    rel: Float32Array;
}

/** The cells to patch: the proud cells of the vehicles the model boxed, widened by their skirt, grouped. */
/** Two readings of one object: their boxes overlap by at least half of the smaller one. */
function sameObject(a: VehicleReading, b: VehicleReading): boolean {
    const ix = Math.min(a.hi[0], b.hi[0]) - Math.max(a.lo[0], b.lo[0]), iz = Math.min(a.hi[1], b.hi[1]) - Math.max(a.lo[1], b.lo[1]);
    if (ix <= 0 || iz <= 0) return false;
    const area = (r: VehicleReading) => (r.hi[0] - r.lo[0]) * (r.hi[1] - r.lo[1]);
    return (ix * iz) / Math.min(area(a), area(b)) >= 0.5;
}

/**
 * The cells to patch: the proud cells of the vehicles the model boxed, widened by their skirt, grouped. `vehicles` lists the
 * readings that stand for distinct vehicles (duplicates from overlapping crops folded in), `unmatchedReadings` those with
 * no proud candidate under them, `boxOnly` those patched by their box alone.
 */
export function vehicleRegion(grid: ProudGrid, candidates: VehicleCandidate[], readings: VehicleReading[], P: VehicleRemovalParams = VEHICLE_REMOVAL_PARAMS): { region: VehicleRegion; unmatchedReadings: number[]; vehicles: number[]; boxOnly: number[] } {
    const { x0, z0, nx, nz, cellM } = grid;
    // one vehicle seen in two overlapping crops is one vehicle: the most confident reading stands for it
    const all = readings.map((r, k) => ({ r, k })).filter(({ r }) => removable(r, P)).sort((a, b) => b.r.confidence - a.r.confidence);
    const vehicles: Array<{ r: VehicleReading; k: number }> = [];
    for (const v of all) if (!vehicles.some(u => sameObject(u.r, v.r))) vehicles.push(v);
    const boxOf = new Int32Array(nx * nz).fill(-1);
    for (const { r, k } of vehicles) {
        const i0 = Math.max(0, Math.floor((r.lo[0] - P.boxPadM - x0) / cellM)), i1 = Math.min(nx - 1, Math.floor((r.hi[0] + P.boxPadM - x0) / cellM));
        const k0 = Math.max(0, Math.floor((r.lo[1] - P.boxPadM - z0) / cellM)), k1 = Math.min(nz - 1, Math.floor((r.hi[1] + P.boxPadM - z0) / cellM));
        for (let kk = k0; kk <= k1; kk++) for (let i = i0; i <= i1; i++) if (boxOf[kk * nx + i] < 0) boxOf[kk * nx + i] = k;
    }
    const take = new Uint8Array(nx * nz);
    const boxCell = new Map<number, number>();
    const boxOnly = new Set<number>();
    const readingsOf = new Map<number, Set<number>>();
    const matched = new Set<number>();
    for (const c of candidates) {
        let inBox = 0;
        for (const cell of c.cells) if (boxOf[cell] >= 0) inBox++;
        const share = c.cells.length ? inBox / c.cells.length : 0;
        if (share < P.componentPartShare) continue;
        const whole = share >= P.componentWholeShare;
        for (const cell of c.cells) if (whole || boxOf[cell] >= 0) { take[cell] = 1; if (boxOf[cell] >= 0) { matched.add(boxOf[cell]); if (!readingsOf.has(c.id)) readingsOf.set(c.id, new Set()); readingsOf.get(c.id)!.add(boxOf[cell]); } }
    }
    // the carriageway's debris (no reading: too small to show the model)
    const debrisCell = new Uint8Array(nx * nz);
    for (const cells of grid.debris ?? []) for (const c of cells) { take[c] = 1; debrisCell[c] = 1; }
    // the vehicle's photo reaches past its proud cells (a bonnet, a boot, a low lump at its ends): every matched vehicle's box,
    // a little inside its edges, is taken too
    for (const { r, k } of vehicles) {
        if (!matched.has(k)) continue;
        const sx = (r.hi[0] - r.lo[0]) * P.matchedBoxInset, sz = (r.hi[1] - r.lo[1]) * P.matchedBoxInset;
        const i0 = Math.max(0, Math.floor((r.lo[0] + sx - x0) / cellM)), i1 = Math.min(nx - 1, Math.floor((r.hi[0] - sx - x0) / cellM));
        const k0 = Math.max(0, Math.floor((r.lo[1] + sz - z0) / cellM)), k1 = Math.min(nz - 1, Math.floor((r.hi[1] - sz - z0) / cellM));
        for (let kk = k0; kk <= k1; kk++) for (let i = i0; i <= i1; i++) { const c = kk * nx + i; if (grid.street[c] && grid.rel[c] <= P.proudMaxM && !take[c]) { take[c] = 1; boxCell.set(c, k); } }
    }
    // a vehicle with nothing proud enough to be a candidate (a low, dark car the scan flattened) still carries its smeared
    // photo: its box (a little inside it) is patched too
    for (const { r, k } of vehicles) {
        if (matched.has(k)) continue;
        const sx = (r.hi[0] - r.lo[0]) * P.unmatchedBoxInset, sz = (r.hi[1] - r.lo[1]) * P.unmatchedBoxInset;
        const i0 = Math.max(0, Math.floor((r.lo[0] + sx - x0) / cellM)), i1 = Math.min(nx - 1, Math.floor((r.hi[0] - sx - x0) / cellM));
        const k0 = Math.max(0, Math.floor((r.lo[1] + sz - z0) / cellM)), k1 = Math.min(nz - 1, Math.floor((r.hi[1] - sz - z0) / cellM));
        let n = 0;
        for (let kk = k0; kk <= k1; kk++) for (let i = i0; i <= i1; i++) { const c = kk * nx + i; if (grid.street[c] && grid.rel[c] <= P.proudMaxM) { take[c] = 1; boxCell.set(c, k); n++; } }
        if (n) boxOnly.add(k);
    }
    // the skirt: the lump runs down to the street around the proud cells
    const r = Math.max(0, Math.round(P.skirtM / cellM));
    const region = new Uint8Array(nx * nz);
    for (let c = 0; c < nx * nz; c++) {
        if (!take[c]) continue;
        const i = c % nx, k = (c - i) / nx;
        for (let dk = -r; dk <= r; dk++) for (let di = -r; di <= r; di++) {
            if (di * di + dk * dk > r * r + 0.5) continue;
            const ii = i + di, kk = k + dk;
            if (ii < 0 || kk < 0 || ii >= nx || kk >= nz) continue;
            const n = kk * nx + ii;
            // never into what stands taller than a vehicle can (a shelter's post, a wall), nor onto water
            if (grid.rel[n] > P.proudMaxM || !grid.street[n]) continue;
            region[n] = 1;
        }
    }
    const group = new Int32Array(nx * nz).fill(-1);
    const groups: RegionGroup[] = [];
    const stack: number[] = [];
    for (let c0 = 0; c0 < nx * nz; c0++) {
        if (!region[c0] || group[c0] >= 0) continue;
        const id = groups.length;
        const cells: number[] = [];
        group[c0] = id; stack.push(c0);
        while (stack.length) {
            const c = stack.pop()!;
            cells.push(c);
            const i = c % nx, k = (c - i) / nx;
            for (const [di, dk] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                const ii = i + di, kk = k + dk;
                if (ii < 0 || kk < 0 || ii >= nx || kk >= nz) continue;
                const n = kk * nx + ii;
                if (region[n] && group[n] < 0) { group[n] = id; stack.push(n); }
            }
        }
        // the long axis (plan PCA)
        let mx = 0, mz = 0;
        for (const c of cells) { const i = c % nx, k = (c - i) / nx; mx += i; mz += k; }
        mx /= cells.length; mz /= cells.length;
        let sxx = 0, szz = 0, sxz = 0, lx = Infinity, lz = Infinity, hx = -Infinity, hz = -Infinity;
        for (const c of cells) {
            const i = c % nx, k = (c - i) / nx;
            sxx += (i - mx) ** 2; szz += (k - mz) ** 2; sxz += (i - mx) * (k - mz);
            lx = Math.min(lx, x0 + i * cellM); lz = Math.min(lz, z0 + k * cellM); hx = Math.max(hx, x0 + (i + 1) * cellM); hz = Math.max(hz, z0 + (k + 1) * cellM);
        }
        const ang = 0.5 * Math.atan2(2 * sxz, sxx - szz);
        const rs = new Set<number>(), cs = new Set<number>();
        let debrisCells = 0;
        for (const c of cells) {
            if (debrisCell[c]) debrisCells++;
            const cand = grid.comp[c];
            if (cand >= 0 && take[c]) { cs.add(cand); for (const q of readingsOf.get(cand) ?? []) rs.add(q); }
            const b = boxCell.get(c);
            if (b !== undefined) rs.add(b);
        }
        groups.push({ id, cells, axis: [Math.cos(ang), Math.sin(ang)], lo: [lx, lz], hi: [hx, hz], readings: [...rs], candidates: [...cs], ...(debrisCells ? { debrisCells } : {}), ring: new Float32Array(0), ringFromGroundModel: false });
    }
    const unmatchedReadings = vehicles.map(v => v.k).filter(k => !matched.has(k));
    return { region: { x0, z0, nx, nz, cellM, group, groups, ceiling: new Float32Array(nx * nz).fill(Infinity), rel: grid.rel }, unmatchedReadings, vehicles: vehicles.map(v => v.k), boxOnly: [...boxOnly] };
}

/** The parameters a staged build removes with: street clutter (temporary objects, carriageway debris) off with SCRATCHBOX_STAGED_CLUTTER=0. */
export function vehicleRemovalParams(env: NodeJS.ProcessEnv = process.env): VehicleRemovalParams {
    return env.SCRATCHBOX_STAGED_CLUTTER?.trim() === '0' ? { ...VEHICLE_REMOVAL_PARAMS, removeTemporary: false, debrisMinAreaM2: Infinity } : VEHICLE_REMOVAL_PARAMS;
}

/** Whether a reading is removed: a vehicle, or (with removeTemporary) anything the model judged not permanent; confident enough either way. */
export function removable(r: Pick<VehicleReading, 'vehicle' | 'permanent' | 'confidence'>, P: VehicleRemovalParams = VEHICLE_REMOVAL_PARAMS): boolean {
    return (r.vehicle || (P.removeTemporary && !r.permanent)) && r.confidence >= P.minConfidence;
}

/** The region group a plan point falls in (-1: none). */
export function regionGroupAt(region: VehicleRegion, x: number, z: number): number {
    const i = Math.floor((x - region.x0) / region.cellM), k = Math.floor((z - region.z0) / region.cellM);
    return i < 0 || k < 0 || i >= region.nx || k >= region.nz ? -1 : region.group[k * region.nx + i];
}

/**
 * The ring of each group: scan vertices within `ringM` outside it and within `ringMaxAboveStreetM` of the street (the road
 * and kerb the patch must meet), at most `ringMaxSamples` each.
 */
export function measureRings(region: VehicleRegion, scan: ScanMesh, ground: GroundModel, P: VehicleRemovalParams = VEHICLE_REMOVAL_PARAMS): void {
    const { nx, nz, cellM } = region;
    const owner = new Int32Array(nx * nz).fill(-1);
    const dist = new Float32Array(nx * nz).fill(Infinity);
    // breadth-first out from every region cell up to ringM
    let frontier: number[] = [];
    for (let c = 0; c < nx * nz; c++) if (region.group[c] >= 0) { owner[c] = region.group[c]; dist[c] = 0; frontier.push(c); }
    const steps = Math.ceil(P.ringM / cellM);
    for (let s = 1; s <= steps && frontier.length; s++) {
        const nextF: number[] = [];
        for (const c of frontier) {
            const i = c % nx, k = (c - i) / nx;
            for (const [di, dk] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                const ii = i + di, kk = k + dk;
                if (ii < 0 || kk < 0 || ii >= nx || kk >= nz) continue;
                const n = kk * nx + ii;
                if (dist[n] <= s) continue;
                dist[n] = s; owner[n] = owner[c]; nextF.push(n);
            }
        }
        frontier = nextF;
    }
    const samples: number[][] = region.groups.map(() => []);
    const V = scan.mesh.vertices as ArrayLike<number>;
    for (let v = 0; v < V.length; v += 3) {
        const x = V[v], y = V[v + 1], z = V[v + 2];
        const i = Math.floor((x - region.x0) / cellM), k = Math.floor((z - region.z0) / cellM);
        if (i < 0 || k < 0 || i >= nx || k >= nz) continue;
        const c = k * nx + i;
        if (region.group[c] >= 0 || owner[c] < 0) continue;
        const g = ground.groundAt(x, z);
        if (g !== g || Math.abs(y - g) > P.ringMaxAboveStreetM) continue;
        samples[owner[c]].push(x, y, z);
    }
    for (const g of region.groups) {
        let s = samples[g.id];
        const n = s.length / 3;
        if (n > P.ringMaxSamples) {
            const keep: number[] = [];
            const stride = n / P.ringMaxSamples;
            for (let q = 0; q < P.ringMaxSamples; q++) { const j = Math.floor(q * stride) * 3; keep.push(s[j], s[j + 1], s[j + 2]); }
            s = keep;
        }
        if (s.length < 9) {
            // no measured ring (the scan is open around it): the measured street model's own heights at the group's cells
            const fromModel: number[] = [];
            for (const c of g.cells) {
                const i = c % nx, k = (c - i) / nx;
                const x = region.x0 + (i + 0.5) * cellM, z = region.z0 + (k + 0.5) * cellM;
                const y = ground.groundAt(x, z);
                if (y === y) fromModel.push(x, y, z);
            }
            g.ring = Float32Array.from(fromModel.length > 3 * P.ringMaxSamples ? fromModel.filter((_, j) => Math.floor(j / 3) % Math.ceil(fromModel.length / 3 / P.ringMaxSamples) === 0) : fromModel);
            g.ringFromGroundModel = true;
        } else g.ring = Float32Array.from(s);
    }
}

/**
 * The ceiling of each region cell: the scan's surface heights over the cell (triangles crossing its centre, vertices in it)
 * sorted, climbed from the lowest while each step up is shorter than `stackGapM`. A vehicle's lump is draped, one continuous
 * stack from the street to its roof; an awning or a canopy over it stands across a gap.
 */
export function measureStacks(region: VehicleRegion, scan: ScanMesh, ground: GroundModel, P: VehicleRemovalParams = VEHICLE_REMOVAL_PARAMS): void {
    const { nx, nz, cellM, x0, z0 } = region;
    const hs = new Map<number, number[]>();
    const add = (c: number, y: number) => { if (region.group[c] < 0) return; let a = hs.get(c); if (!a) hs.set(c, a = []); a.push(y); };
    const V = scan.mesh.vertices as ArrayLike<number>, I = scan.mesh.indices as ArrayLike<number>;
    let lx = Infinity, lz = Infinity, hx = -Infinity, hz = -Infinity;
    for (const g of region.groups) { lx = Math.min(lx, g.lo[0]); lz = Math.min(lz, g.lo[1]); hx = Math.max(hx, g.hi[0]); hz = Math.max(hz, g.hi[1]); }
    if (!region.groups.length) return;
    const cellOf = (x: number, z: number) => { const i = Math.floor((x - x0) / cellM), k = Math.floor((z - z0) / cellM); return i < 0 || k < 0 || i >= nx || k >= nz ? -1 : k * nx + i; };
    for (let t = 0; t < scan.triCount; t++) {
        const a = I[t * 3] * 3, b = I[t * 3 + 1] * 3, c = I[t * 3 + 2] * 3;
        const ax = V[a], ay = V[a + 1], az = V[a + 2], bx = V[b], by = V[b + 1], bz = V[b + 2], cx = V[c], cy = V[c + 1], cz = V[c + 2];
        if (Math.max(ax, bx, cx) < lx || Math.min(ax, bx, cx) > hx || Math.max(az, bz, cz) < lz || Math.min(az, bz, cz) > hz) continue;
        for (const [x, y, z] of [[ax, ay, az], [bx, by, bz], [cx, cy, cz]]) { const q = cellOf(x, z); if (q >= 0) add(q, y); }
        const det = (bx - ax) * (cz - az) - (cx - ax) * (bz - az);
        if (Math.abs(det) < 1e-9) continue;
        const i0 = Math.max(0, Math.floor((Math.min(ax, bx, cx) - x0) / cellM)), i1 = Math.min(nx - 1, Math.floor((Math.max(ax, bx, cx) - x0) / cellM));
        const k0 = Math.max(0, Math.floor((Math.min(az, bz, cz) - z0) / cellM)), k1 = Math.min(nz - 1, Math.floor((Math.max(az, bz, cz) - z0) / cellM));
        for (let k = k0; k <= k1; k++) for (let i = i0; i <= i1; i++) {
            if (region.group[k * nx + i] < 0) continue;
            const px = x0 + (i + 0.5) * cellM, pz = z0 + (k + 0.5) * cellM;
            const u = ((bx - px) * (cz - pz) - (cx - px) * (bz - pz)) / det;
            const v = ((cx - px) * (az - pz) - (ax - px) * (cz - pz)) / det;
            const w = 1 - u - v;
            if (u < -1e-6 || v < -1e-6 || w < -1e-6) continue;
            add(k * nx + i, u * ay + v * by + w * cy);
        }
    }
    for (const [c, a] of hs) {
        a.sort((p, q) => p - q);
        // climbed from the street, not from what the scan holds under it (a deck's underside, a cutting below a car park)
        const i = c % nx, k = (c - i) / nx;
        const g = ground.groundAt(x0 + (i + 0.5) * cellM, z0 + (k + 0.5) * cellM);
        let j = 0;
        if (g === g) while (j < a.length && a[j] < g - P.stackBelowStreetM) j++;
        if (j >= a.length) { region.ceiling[c] = g === g ? g + P.stackBelowStreetM : a[a.length - 1]; continue; }
        let top = a[j];
        for (j++; j < a.length && a[j] - top < P.stackGapM; j++) top = a[j];
        region.ceiling[c] = top;
    }
}

/** The patch surface of group `g` at (x, z): inverse-distance (squared) through its ring. */
export function patchHeight(g: RegionGroup, x: number, z: number): number {
    const R = g.ring;
    let sw = 0, sy = 0;
    for (let j = 0; j < R.length; j += 3) {
        const d2 = (R[j] - x) ** 2 + (R[j + 2] - z) ** 2;
        if (d2 < 1e-6) return R[j + 1];
        const w = 1 / (d2 * d2);
        sw += w; sy += w * R[j + 1];
    }
    return sw > 0 ? sy / sw : NaN;
}

// ------------------------------------------------------------------------------------------------ 4. the texels (surface-infill.ts)

/** Triangles whose plan bounding box meets the frame (with a metre's margin). */
export function trianglesNear(tris: TileTriangles, f: TopDownFrame, marginM = 1): Uint8Array {
    const n = tris.texture.length, keep = new Uint8Array(n), P = tris.positions;
    const x0 = f.x0 - marginM, x1 = f.x0 + f.widthM + marginM, z0 = f.z0 - marginM, z1 = f.z0 + f.heightM + marginM;
    for (let t = 0; t < n; t++) {
        const o = t * 9;
        const lx = Math.min(P[o], P[o + 3], P[o + 6]), hx = Math.max(P[o], P[o + 3], P[o + 6]);
        const lz = Math.min(P[o + 2], P[o + 5], P[o + 8]), hz = Math.max(P[o + 2], P[o + 5], P[o + 8]);
        if (hx >= x0 && lx <= x1 && hz >= z0 && lz <= z1) keep[t] = 1;
    }
    return keep;
}

// ------------------------------------------------------------------------------------------------ the GLB

export interface PatchGlbStats {
    movedVertices: number; touchedTriangles: number; paintedTexels: number; repaintedImages: number; primitives: number;
    /** Of the moved vertices, those over their cell's stack ceiling in a piece attached to nothing outside the region. */
    shellVertices?: number;
}

/**
 * The vertices over their cell's stack ceiling (`above`) whose piece is attached to nothing outside the region: a vehicle's
 * own shell over a street the scan also holds beneath it, its roof standing across a gap in the stack and so taken for an
 * awning by the ceiling alone. An awning, a canopy or a tree runs on past the vehicle: a triangle of its piece reaches a
 * vertex outside the region, and the whole piece is kept.
 */
export function unattachedAboveCeiling(above: Uint8Array, inRegion: Uint8Array, triangle: (t: number) => [number, number, number], triangles: number): Uint8Array {
    const n = above.length, parent = new Int32Array(n).map((_, i) => i), attached = new Uint8Array(n);
    const find = (x: number): number => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
    for (let t = 0; t < triangles; t++) {
        const tri = triangle(t), up = tri.filter(v => above[v]);
        if (!up.length) continue;
        if (tri.some(v => !inRegion[v])) for (const v of up) attached[v] = 1;
        for (let k = 1; k < up.length; k++) parent[find(up[k])] = find(up[0]);
    }
    const rootAttached = new Uint8Array(n);
    for (let v = 0; v < n; v++) if (above[v] && attached[v]) rootAttached[find(v)] = 1;
    const out = new Uint8Array(n);
    for (let v = 0; v < n; v++) if (above[v] && !rootAttached[find(v)]) out[v] = 1;
    return out;
}

/**
 * Moves every vertex of the GLB that lies in a region group (and not more than proudMaxM above its surface) down onto the
 * group's surface: `surface` (the surface infill's model of the street under it: the measured ring and its continuation,
 * a kerb kept sharp), else the inverse-distance surface through the ring (patchHeight). A vertex over its cell's stack
 * ceiling stays (an awning or a canopy over the vehicle) unless its piece is attached to nothing outside the region
 * (unattachedAboveCeiling: the vehicle's own shell, its roof over a street the scan holds beneath it). Index lists are
 * untouched (no triangle removed, no edge opened); positions, normals and the moved accessors' bounds change. The texels
 * are painted afterwards by the surface infill (applyInfillToGlb).
 */
export function patchVehiclesInGlb(bytes: Uint8Array, region: VehicleRegion, opts: { surface?: (group: number, x: number, z: number) => number; extras?: Record<string, unknown>; P?: VehicleRemovalParams } = {}): { glb: Buffer; stats: PatchGlbStats } {
    const P = opts.P ?? VEHICLE_REMOVAL_PARAMS;
    const glb = parseGlbBytes(bytes);
    const json = glb.json;
    const bin = new Uint8Array(glb.bin.byteLength);
    bin.set(glb.bin);
    const dv = new DataView(bin.buffer);
    const world = nodeWorldMatrices(json);
    const stats: PatchGlbStats = { movedVertices: 0, touchedTriangles: 0, paintedTexels: 0, repaintedImages: 0, primitives: 0, shellVertices: 0 };
    const done = new Set<number>();
    const layout = (ai: number) => {
        const a = json.accessors[ai], v = json.bufferViews[a.bufferView];
        const comps = a.type === 'VEC3' ? 3 : a.type === 'VEC2' ? 2 : 1;
        return { a, base: (v.byteOffset ?? 0) + (a.byteOffset ?? 0), stride: v.byteStride || comps * 4, comps };
    };
    (json.nodes ?? []).forEach((node: any, ni: number) => {
        if (node.mesh === undefined || done.has(node.mesh)) return;
        done.add(node.mesh);
        const m = world[ni], ident = isIdentity(m), inv = ident ? m : invert(m);
        for (const prim of json.meshes?.[node.mesh]?.primitives ?? []) {
            if ((prim.mode ?? 4) !== 4 || prim.attributes?.POSITION === undefined) continue;
            const pl = layout(prim.attributes.POSITION);
            if (pl.a.componentType !== 5126 || pl.comps !== 3 || pl.a.sparse) continue;
            const n = pl.a.count;
            const wp = new Float64Array(n * 3);
            const moved = new Uint8Array(n);
            let any = 0;
            // the triangles (their vertex indices), read before anything moves
            const idxAcc = prim.indices !== undefined ? json.accessors[prim.indices] : undefined;
            const count = idxAcc ? idxAcc.count : n;
            const readIndex = (k: number) => {
                if (!idxAcc) return k;
                const v = json.bufferViews[idxAcc.bufferView];
                const size = idxAcc.componentType === 5125 ? 4 : idxAcc.componentType === 5123 ? 2 : 1;
                const o = (v.byteOffset ?? 0) + (idxAcc.byteOffset ?? 0) + k * (v.byteStride || size);
                return size === 4 ? dv.getUint32(o, true) : size === 2 ? dv.getUint16(o, true) : dv.getUint8(o);
            };
            // each vertex's group, and whether it stands over its cell's stack ceiling
            const group = new Int32Array(n).fill(-1), inRegion = new Uint8Array(n), above = new Uint8Array(n);
            for (let v = 0; v < n; v++) {
                const o = pl.base + v * pl.stride;
                const lx = dv.getFloat32(o, true), ly = dv.getFloat32(o + 4, true), lz = dv.getFloat32(o + 8, true);
                const w = ident ? [lx, ly, lz] : transformPoint(m, lx, ly, lz);
                wp[v * 3] = w[0]; wp[v * 3 + 1] = w[1]; wp[v * 3 + 2] = w[2];
                const ci = Math.floor((w[0] - region.x0) / region.cellM), ck = Math.floor((w[2] - region.z0) / region.cellM);
                if (ci < 0 || ck < 0 || ci >= region.nx || ck >= region.nz) continue;
                const g = region.group[ck * region.nx + ci];
                if (g < 0) continue;
                group[v] = g; inRegion[v] = 1;
                if (w[1] > region.ceiling[ck * region.nx + ci] + 0.05) above[v] = 1;
            }
            const shell = above.some(a => a === 1) ? unattachedAboveCeiling(above, inRegion, t => [readIndex(t * 3), readIndex(t * 3 + 1), readIndex(t * 3 + 2)], Math.floor(count / 3)) : above;
            for (let v = 0; v < n; v++) {
                const g = group[v];
                if (g < 0 || (above[v] && !shell[v])) continue;
                const o = pl.base + v * pl.stride;
                const w = [wp[v * 3], wp[v * 3 + 1], wp[v * 3 + 2]];
                // which vertices move is decided against the ring's own surface (a vehicle's roof is within proudMaxM of
                // the street the ring measures, whatever the rebuilt surface's level under it); where they go, the surface
                const ring = patchHeight(region.groups[g], w[0], w[2]);
                if (ring !== ring || w[1] - ring > P.proudMaxM) continue;
                const s = opts.surface ? opts.surface(g, w[0], w[2]) : ring;
                const y = s === s ? s : ring;
                moved[v] = 1; any++;
                if (above[v]) stats.shellVertices!++;
                wp[v * 3 + 1] = y;
                const l = ident ? [w[0], y, w[2]] : transformPoint(inv, w[0], y, w[2]);
                dv.setFloat32(o, l[0], true); dv.setFloat32(o + 4, l[1], true); dv.setFloat32(o + 8, l[2], true);
            }
            if (!any) continue;
            stats.primitives++;
            stats.movedVertices += any;
            // bounds of the moved accessor
            const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
            for (let v = 0; v < n; v++) for (let j = 0; j < 3; j++) { const q = dv.getFloat32(pl.base + v * pl.stride + j * 4, true); mn[j] = Math.min(mn[j], q); mx[j] = Math.max(mx[j], q); }
            pl.a.min = mn; pl.a.max = mx;
            // normals: up (the patch is the street's surface)
            if (prim.attributes.NORMAL !== undefined) {
                const nl = layout(prim.attributes.NORMAL);
                if (nl.a.componentType === 5126 && nl.comps === 3) {
                    // world up in the node's frame: the inverse-transpose maps normals to world, so its transpose maps them back
                    const up = ident ? [0, 1, 0] : (() => { const x = m[1], y = m[5], z = m[9]; const L = Math.hypot(x, y, z) || 1; return [x / L, y / L, z / L]; })();
                    for (let v = 0; v < n; v++) if (moved[v]) { const o = nl.base + v * nl.stride; dv.setFloat32(o, up[0], true); dv.setFloat32(o + 4, up[1], true); dv.setFloat32(o + 8, up[2], true); }
                }
            }
            // the triangles it moved
            for (let t = 0; t + 2 < count; t += 3) if (moved[readIndex(t)] || moved[readIndex(t + 1)] || moved[readIndex(t + 2)]) stats.touchedTriangles++;
        }
    });
    if (opts.extras) {
        const scene = json.scenes?.[json.scene ?? 0];
        json.extras = { ...(json.extras ?? {}), ...opts.extras };
        if (scene) scene.extras = { ...(scene.extras ?? {}), ...opts.extras };
    }
    return { glb: assembleGlb(json, bin), stats };
}

// ------------------------------------------------------------------------------------------------ the whole step

/** What the model read in a region, in the words the report and the provenance carry. */
function whatOfGroup(g: RegionGroup, readings: VehicleReading[]): string {
    const labels = [...new Set(g.readings.map(k => readings[k].label))];
    const temporary = g.readings.some(k => !readings[k].vehicle);
    return labels.length ? `the vision model read ${labels.join('; ')} here in the scan's top-down photo${temporary ? ' (standing there only for a while: not part of the place)' : ''}` : g.debrisCells ? 'a lump too small to be a fixture lay low on the carriageway (a remnant, a dropped load or the scan\'s own blob)' : 'the vision model read a vehicle here';
}

export interface VehicleRemovalReport {
    schema: 'scratchbox.vehicle-removal/1';
    version: string;
    candidates: number;
    crops: number;
    modelCalls: number;
    failedCalls: Array<{ crop: number; error: string }>;
    readings: Array<VehicleReading & { removed: boolean }>;
    /** Distinct vehicles the model read (duplicates from overlapping crops folded in). */
    vehicles: number;
    /** Of them, those with no proud candidate under them: patched by their box alone (the scan flattened them). */
    boxOnlyVehicles: number;
    /** Of them, those with nothing to patch (their box holds no scan). */
    unpatchedVehicles: number;
    /** Things the model judged not permanent and not vehicles but left (removeTemporary off, or not confident enough). */
    transientKept: number;
    /** Regions removed for a temporary object, and for carriageway debris. */
    temporaryRemoved?: number;
    debrisRemoved?: number;
    removed: Array<{
        id: number; labels: string[]; lo: [number, number]; hi: [number, number]; areaM2: number;
        /** What was removed: a vehicle, a temporary object, or carriageway debris. */
        kind?: 'vehicle' | 'temporary' | 'debris';
        provenance: { geometry: 'generated'; texture: { measuredShare?: number; photoInferredShare: number; generatedShare: number } };
        /** The surface infill's account of the region: the rungs that filled it, whether every fill passed the seam gate, the rim CIEDE2000, the surface's levels. */
        infill?: { rungs: string[]; gatePassed: boolean; rimDeltaE: number | null; levels: number };
        reason: string;
    }>;
    patch: { textured?: PatchGlbStats; geometry?: PatchGlbStats };
    notes: string[];
    ms: number;
}

export interface RemoveVehiclesInput {
    texturedGlb: string;
    geometryGlb?: string;
    scan: ScanMesh;
    ground: GroundModel;
    look?: VehicleLookups;
    judge: VehicleJudge;
    /** Reads several crops in one call (P.batch at a time); a crop it leaves out is read again with `judge`. */
    judgeMany?: VehicleBatchJudge;
    outDir: string;
    /** Writes each crop sent to the model (and the fills) beside the outputs. */
    keepImages?: boolean;
    signal?: AbortSignal;
    P?: VehicleRemovalParams;
    log?: (m: string) => void;
    /** Already read textured triangles (avoid decoding the tile's images twice). */
    tris?: TileTriangles;
}

export interface RemoveVehiclesResult {
    texturedGlb: string;
    geometryGlb?: string;
    report: VehicleRemovalReport;
}

async function mapConcurrent<T>(items: T[], n: number, fn: (item: T, index: number) => Promise<void>): Promise<void> {
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (next < items.length) { const i = next++; await fn(items[i], i); } }));
}

/** Finds the vehicles in a textured scan and writes it (and its geometry twin) without them. */
export async function removeVehicles(input: RemoveVehiclesInput): Promise<RemoveVehiclesResult> {
    const t0 = Date.now();
    const P: VehicleRemovalParams = input.P ?? VEHICLE_REMOVAL_PARAMS;
    const log = input.log ?? (() => undefined);
    fs.mkdirSync(input.outDir, { recursive: true });
    const { grid, candidates } = vehicleCandidates(input.scan, input.ground, input.look ?? {}, P);
    const crops = planCrops(candidates, P);
    log(`${candidates.length} proud components, ${crops.length} crops for the model`);
    const bytes = fs.readFileSync(input.texturedGlb);
    const tris = input.tris ?? readTileTriangles(bytes);
    const readings: VehicleReading[] = [];
    const failedCalls: VehicleRemovalReport['failedCalls'] = [];
    const cropDir = path.join(input.outDir, 'crops');
    if (input.keepImages) fs.mkdirSync(cropDir, { recursive: true });
    const failedFirst = new Set<number>();
    let modelCalls = 0;
    const renderCrop = (c: { frame: TopDownFrame }, index: number): VehicleCrop => {
        const sub = selectTriangles(tris, trianglesNear(tris, c.frame));
        let topY = -Infinity;
        for (let i = 1; i < sub.positions.length; i += 3) topY = Math.max(topY, sub.positions[i]);
        const texelM = Math.max(P.cropTexelM, c.frame.widthM / P.cropMaxPx);
        const cam = topDownCamera(c.frame, topY === -Infinity ? 0 : topY, texelM);
        const r = renderTriangles([sub], cam, { supersample: 1, ambient: 1, background: [128, 128, 128] });
        const jpeg = Buffer.from(jpegJs.encode({ data: Buffer.from(r.rgba.buffer, r.rgba.byteOffset, r.rgba.byteLength), width: r.width, height: r.height }, P.sendQuality).data);
        if (input.keepImages) fs.writeFileSync(path.join(cropDir, `crop_${index}.jpg`), jpeg);
        return { index, frame: c.frame, jpeg, widthPx: r.width, heightPx: r.height, texelM: c.frame.widthM / r.width };
    };
    const readCrop = async (c: { frame: TopDownFrame }, index: number, last: boolean) => {
        if (input.signal?.aborted) throw input.signal.reason ?? new Error('aborted');
        const crop = renderCrop(c, index);
        try {
            modelCalls++;
            readings.push(...await input.judge(crop, input.signal));
        } catch (err) {
            if (input.signal?.aborted) throw err;
            if (last) failedCalls.push({ crop: index, error: err instanceof Error ? err.message : String(err) });
            else failedFirst.add(index);
        }
    };
    if (input.judgeMany && P.batch > 1) {
        // several crops a call; a crop the batch's answer leaves out (or a batch that failed) is read once more on its own
        const batches: number[][] = [];
        for (let k = 0; k < crops.length; k += P.batch) batches.push(crops.slice(k, k + P.batch).map((_, j) => k + j));
        await mapConcurrent(batches, P.concurrency, async ids => {
            if (input.signal?.aborted) throw input.signal.reason ?? new Error('aborted');
            const rendered = ids.map(i => renderCrop(crops[i], i));
            let got = new Map<number, VehicleReading[]>();
            try { modelCalls++; got = await input.judgeMany!(rendered, input.signal); } catch (err) { if (input.signal?.aborted) throw err; }
            for (const i of ids) { const r = got.get(i); if (r) readings.push(...r); else failedFirst.add(i); }
        });
        if (failedFirst.size) await mapConcurrent([...failedFirst], P.concurrency, index => readCrop(crops[index], index, true));
    } else {
        await mapConcurrent(crops, P.concurrency, (c, index) => readCrop(c, index, false));
        // a call that failed (a timeout, a refusal of the moment) is asked once more
        if (failedFirst.size) await mapConcurrent([...failedFirst], P.concurrency, index => readCrop(crops[index], index, true));
    }
    readings.sort((a, b) => a.crop - b.crop || a.lo[0] - b.lo[0] || a.lo[1] - b.lo[1]);
    const { region, unmatchedReadings, vehicles: distinct, boxOnly } = vehicleRegion(grid, candidates, readings, P);
    measureRings(region, input.scan, input.ground, P);
    if (P.keepOverOpenSpace !== false) measureStacks(region, input.scan, input.ground, P);
    const whatOf = (g: RegionGroup) => whatOfGroup(g, readings);
    // the surface under each region and its texels: the surface infill (one ladder and seam gate for every removed surface),
    // charted in plan so the vertices move straight down and the region's plan cells are its chart's cells
    const specs: InfillRegionSpec[] = region.groups.map(g => {
        const hole = cellsToTriangles(g.cells, region.nx, region.x0, region.z0, region.cellM, (x, z) => patchHeight(g, x, z));
        return { id: g.id, what: whatOf(g), hole, ring: g.ring, plan: true };
    });
    // the vehicles the model read but nothing was patched for stay out of the sources (their photo is still a vehicle)
    const unpatched = unmatchedReadings.filter(k => !boxOnly.includes(k)).map(k => { const r = readings[k], y = input.ground.groundAt((r.lo[0] + r.hi[0]) / 2, (r.lo[1] + r.hi[1]) / 2); const h = y === y ? y : 0; return Float32Array.from([r.lo[0], h, r.lo[1], r.lo[0], h, r.hi[1], r.hi[0], h, r.lo[1], r.hi[0], h, r.lo[1], r.lo[0], h, r.hi[1], r.hi[0], h, r.hi[1]]); });
    const infill = region.groups.length ? await infillRegions({ scan: tris, regions: specs, exclude: unpatched, ...(input.signal ? { signal: input.signal } : {}), log }) : { regions: [], ms: 0 };
    const byGroup = new Map(infill.regions.map(r => [r.id as number, r] as const));
    const surface = (gid: number, x: number, z: number) => { const r = byGroup.get(gid); if (!r) return NaN; const c = r.chart; return c.origin[1] + r.model.heightAt(x - c.origin[0], z - c.origin[2]); };
    if (input.keepImages && infill.regions.length) writeInfillRecords(path.join(input.outDir, 'infill'), infill.regions, 'vehicles');
    const removed: VehicleRemovalReport['removed'] = region.groups.map(g => {
        const f = byGroup.get(g.id)!;
        const labels = [...new Set(g.readings.map(k => readings[k].label))];
        const temporary = g.readings.some(k => !readings[k].vehicle);
        return {
            id: g.id, labels, lo: [r2(g.lo[0]), r2(g.lo[1])], hi: [r2(g.hi[0]), r2(g.hi[1])], areaM2: r2(g.cells.length * region.cellM * region.cellM),
            provenance: { geometry: 'generated', texture: { measuredShare: f.shares.measured, photoInferredShare: f.shares['photo-inferred'], generatedShare: f.shares.generated } },
            kind: labels.length ? (temporary ? 'temporary' : 'vehicle') : g.debrisCells ? 'debris' : 'vehicle',
            infill: { rungs: f.attempts.filter(a => a.accepted).map(a => a.rung), gatePassed: f.gatePassed, rimDeltaE: f.attempts.find(a => a.accepted)?.gate?.metrics.rim?.median ?? null, levels: f.model.levels.length },
            reason: `${f.what}, so the lump the scan made of it is removed: ${f.reason.slice(f.what.length + 2)}`
        };
    });
    const extras = {
        sbVehicleRemoval: {
            version: VEHICLE_REMOVAL_VERSION,
            removed: removed.map(r => ({ id: r.id, labels: r.labels, lo: r.lo, hi: r.hi, areaM2: r.areaM2, provenance: { geometry: { label: 'generated', reason: 'heights estimated from the measured scan around the vehicle (its levels, a kerb kept sharp): nothing was measured under it' }, texture: { label: r.provenance.texture.generatedShare > 0.5 ? 'generated' : r.provenance.texture.measuredShare! > 0.5 ? 'measured' : 'photo-inferred', ...r.provenance.texture, reason: 'the surface infill: continued from the street\'s own clear texels along its measured direction or repeat where it has one, else synthesised from its grain (generated); per region in sbInfill' } } }))
        },
        ...infillExtras(infill.regions, 'vehicles')
    };
    const report: VehicleRemovalReport = {
        schema: 'scratchbox.vehicle-removal/1', version: VEHICLE_REMOVAL_VERSION, candidates: candidates.length, crops: crops.length, modelCalls, failedCalls,
        readings: readings.map((r, k) => { const used = new Set(region.groups.flatMap(g => g.readings)); return { ...r, removed: used.has(k) || [...used].some(u => sameObject(readings[u], r)) }; }),
        vehicles: distinct.filter(k => readings[k].vehicle).length, boxOnlyVehicles: boxOnly.length, unpatchedVehicles: unmatchedReadings.length - boxOnly.length,
        transientKept: readings.filter(r => !r.vehicle && !r.permanent && !removable(r, P)).length,
        temporaryRemoved: removed.filter(r => r.kind === 'temporary').length, debrisRemoved: removed.filter(r => r.kind === 'debris').length,
        removed, patch: {}, notes: [], ms: 0
    };
    let texturedOut = input.texturedGlb, geometryOut = input.geometryGlb;
    if (region.groups.length) {
        const moved = patchVehiclesInGlb(bytes, region, { surface, P });
        const tex = applyInfillToGlb(moved.glb, infill.regions, { paint: true, paintPlan: true, extras });
        texturedOut = path.join(input.outDir, 'textured.glb');
        fs.writeFileSync(texturedOut, tex.glb);
        report.patch.textured = { ...moved.stats, paintedTexels: tex.stats.paintedTexels, repaintedImages: tex.stats.repaintedImages };
        if (input.geometryGlb) {
            const geo = patchVehiclesInGlb(fs.readFileSync(input.geometryGlb), region, { surface, extras, P });
            geometryOut = path.join(input.outDir, 'geometry.glb');
            fs.writeFileSync(geometryOut, geo.glb);
            report.patch.geometry = geo.stats;
        }
    }
    report.notes.push(`vehicles: ${candidates.length} components of scan standing proud of the street shown to the vision model in ${crops.length} top-down crops (${failedCalls.length} calls failed); it read ${report.vehicles} vehicles (${boxOnly.length} of the removed too flat in the scan to stand proud, patched by their box); ${removed.length} regions removed and patched (${r2(removed.reduce((s, r) => s + r.areaM2, 0))} m²): ${removed.filter(r => r.kind === 'vehicle').length} vehicles, ${report.temporaryRemoved} temporary objects, ${report.debrisRemoved} carriageway debris`);
    report.ms = Date.now() - t0;
    fs.writeFileSync(path.join(input.outDir, 'vehicle_removal.json'), JSON.stringify(report, null, 1));
    return { texturedGlb: texturedOut, ...(geometryOut ? { geometryGlb: geometryOut } : {}), report };
}

const r2 = (v: number) => Math.round(v * 100) / 100;
