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
 * 3. The patch (geometry): the vehicle's cells, widened by its skirt, are one region; every scan vertex in it is moved down
 *    onto a surface interpolated from the measured scan just outside it (inverse-distance from the ring's own vertices), so
 *    the kerb and the road around keep their heights and the mesh keeps its topology: no triangle is removed, so no edge
 *    opens, and the lump is gone.
 * 4. The patch (texture): the texels of every moved triangle are painted again from an orthophoto of the road around the
 *    region: along the direction the road's own markings run (the photo's orientation around the region: lane lines, kerbs,
 *    a crosswalk's bars), mirrored from the road just beyond the region's ends on that line (lane lines and kerbs continue:
 *    photo-inferred), with the remaining mismatch at each end carried along the same line (seamless, and a lane's colour
 *    never runs into the next lane), and texels neither end's look reaches (deep in a long queue) taking the road's look
 *    along their lane (generated).
 *    Painted from the plan position alone, so folded triangles of the old lump that now lie on each other show the same
 *    colour.
 *
 * Every removal is labelled in the GLB's root extras (sbVehicleRemoval): what the model called it, the region, the patch's
 * provenance (heights estimated from the measured ring: generated; texels mirrored from the scan's own photo:
 * photo-inferred; filled: generated) with the reason.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as jpegJs from 'jpeg-js';
import type { GroundModel, ScanMesh } from '../../spatial/StreetViewSurveyPlanner';
import { assembleGlb, nodeWorldMatrices, parseGlbBytes, isIdentity, transformPoint, type Mat4 } from './glb-bytes';
import { decodeImageInMemory, readTileTriangles, selectTriangles, type TileTriangles } from './tile-texture-transfer';
import { topDownCamera, type TopDownFrame } from './top-down-photo';
import { renderTriangles } from './photo-match-eval';
import { encodePng } from './png-encode';
import type { VisionModelChain } from '../../gemini/vision-model-chain';

export const VEHICLE_REMOVAL_VERSION = 'vehicle-removal/3';

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
    /** The road photo the texels are painted from: this margin around the region, at this texel. */
    fillMarginM: 8,
    fillTexelM: 0.05,
    /** The photo this close to any region is not painted from (it may still show the vehicle's edge); the seam step meets it instead. */
    fillGuardM: 0.4,
    /** How far past the guard a source texel is looked for along a line (past another region, a gap in the photo). */
    fillSearchM: 6,
    /**
     * The direction the patch is painted along: the photo's own orientation (lane lines, kerbs, a crosswalk's bars) read from
     * the road within `fillOrientM` of the region, nearer counting more (`fillOrientSigmaM`); with less coherence than
     * `fillMinCoherence` (no markings to follow) the region's long axis.
     */
    fillOrientM: 3,
    fillOrientSigmaM: 1.5,
    fillMinCoherence: 0.2,
    /**
     * The stretch of road beyond each end a line is painted from: at most this long, and only as far as the road keeps its
     * look (three texels in a row further than `fillRunTolerance` a channel from the stretch's mean end it: a crosswalk's bar
     * or a line's edge beyond it is not carried into the patch). The line takes the colour of the stretch's first `fillBaseM`
     * (the road at the region's edge, not a shade further off) and the stretch's grain (each texel's difference from the road
     * within `fillGrainM` either side of it, held to `fillGrain` a channel), reflected back and forth across a longer hole.
     */
    fillRunM: 2,
    fillRunTolerance: 30,
    fillBaseM: 0.5,
    fillGrain: 15,
    fillGrainM: 0.4,
    /**
     * How far into the patch an end's look is carried: `fillReachPerRun` times as far as it was seen running beyond the end
     * (a lane or a lane line seen for the full `fillRunM` is carried 10 m in; a crosswalk's bar glimpsed for 0.4 m between
     * queued cars, 2 m), at least `fillReachMinM`, fading over `fillReachFadeM` past that into the road's look along its
     * strip: the median of the street within `fillOrientM` of the regions (clear of them by the guard) along the painting
     * direction, `fillStripM` across (a lane's colour beside its vehicles, not a glimpse of a bar or a tail light's smear),
     * a strip with less than `fillStripMinM2` of it (a lane parked solid) taking the nearest strip's beside it (generated).
     */
    fillReachPerRun: 5,
    fillReachMinM: 1,
    fillReachFadeM: 1,
    fillStripM: 0.2,
    fillStripMinM2: 0.5,
    /** The seam: the mismatch at an end (at most this much a channel) carried along the line, fading over this length. */
    fillSeamMax: 30,
    fillSeamFadeM: 1,
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
export type VehicleRemovalParams = typeof VEHICLE_REMOVAL_PARAMS;

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

// ------------------------------------------------------------------------------------------------ 4. the texels

/** Fills the unknown entries of a `c`-channel field from the known ones (push-pull over a pyramid). */
export function pushPull(values: Float32Array, known: Float32Array, w: number, h: number, c: number): Float32Array {
    if (w <= 1 && h <= 1) return values.slice();
    const cw = Math.ceil(w / 2), ch = Math.ceil(h / 2);
    const cv = new Float32Array(cw * ch * c), ck = new Float32Array(cw * ch);
    for (let k = 0; k < h; k++) for (let i = 0; i < w; i++) {
        const wt = known[k * w + i];
        if (!(wt > 0)) continue;
        const q = (k >> 1) * cw + (i >> 1);
        ck[q] += wt;
        for (let j = 0; j < c; j++) cv[q * c + j] += wt * values[(k * w + i) * c + j];
    }
    for (let q = 0; q < cw * ch; q++) if (ck[q] > 0) { for (let j = 0; j < c; j++) cv[q * c + j] /= ck[q]; ck[q] = Math.min(1, ck[q]); }
    const coarse = ck.some(v => v > 0) ? pushPull(cv, ck, cw, ch, c) : cv;
    const out = new Float32Array(w * h * c);
    for (let k = 0; k < h; k++) for (let i = 0; i < w; i++) {
        // bilinear from the coarse level (its texel centres at (2i + 0.5) of this level)
        const fx = Math.max(0, Math.min(cw - 1, (i - 0.5) / 2)), fz = Math.max(0, Math.min(ch - 1, (k - 0.5) / 2));
        const i0 = Math.floor(fx), k0 = Math.floor(fz), i1 = Math.min(cw - 1, i0 + 1), k1 = Math.min(ch - 1, k0 + 1);
        const ax = fx - i0, az = fz - k0;
        const wt = Math.min(1, known[k * w + i] || 0);
        for (let j = 0; j < c; j++) {
            const up = (1 - az) * ((1 - ax) * coarse[(k0 * cw + i0) * c + j] + ax * coarse[(k0 * cw + i1) * c + j]) + az * ((1 - ax) * coarse[(k1 * cw + i0) * c + j] + ax * coarse[(k1 * cw + i1) * c + j]);
            out[(k * w + i) * c + j] = wt * values[(k * w + i) * c + j] + (1 - wt) * up;
        }
    }
    return out;
}

/**
 * The direction (unit, plan) a region's patch is painted along: the orientation the road photo around it varies least
 * along (lane lines, kerbs, a crosswalk's bars), from the colour structure tensor of the street texels `use` admits whose
 * distance from the region (`dist`, texels; -1 beyond the band) is set, nearer counting more; `fallback` (the region's long
 * axis) where the photo shows no direction (coherence under `fillMinCoherence`).
 */
export function fillDirection(val: Float32Array, use: (p: number) => boolean, dist: Int32Array, W: number, H: number, texelM: number, fallback: [number, number], P: VehicleRemovalParams = VEHICLE_REMOVAL_PARAMS): { dir: [number, number]; coherence: number } {
    let jxx = 0, jzz = 0, jxz = 0;
    const s2 = 2 * P.fillOrientSigmaM * P.fillOrientSigmaM;
    for (let k = 1; k < H - 1; k++) for (let i = 1; i < W - 1; i++) {
        const p = k * W + i;
        if (dist[p] <= 0 || !use(p - W - 1) || !use(p - W) || !use(p - W + 1) || !use(p - 1) || !use(p + 1) || !use(p + W - 1) || !use(p + W) || !use(p + W + 1)) continue;
        const w = Math.exp(-((dist[p] * texelM) ** 2) / s2);
        // Scharr's kernel: a direction held to a fraction of a degree at any angle (a central difference drifts by degrees,
        // and a degree is 17 cm across a 10 m queue)
        for (let j = 0; j < 3; j++) {
            const v = (q: number) => val[q * 3 + j];
            const gx = (3 * (v(p - W + 1) - v(p - W - 1)) + 10 * (v(p + 1) - v(p - 1)) + 3 * (v(p + W + 1) - v(p + W - 1))) / 32;
            const gz = (3 * (v(p + W - 1) - v(p - W - 1)) + 10 * (v(p + W) - v(p - W)) + 3 * (v(p + W + 1) - v(p - W + 1))) / 32;
            jxx += w * gx * gx; jzz += w * gz * gz; jxz += w * gx * gz;
        }
    }
    const coherence = jxx + jzz > 0 ? Math.sqrt((jxx - jzz) ** 2 + 4 * jxz * jxz) / (jxx + jzz) : 0;
    if (coherence < P.fillMinCoherence) return { dir: fallback, coherence };
    // the photo changes most across the markings; the patch is painted along them
    const across = 0.5 * Math.atan2(2 * jxz, jxx - jzz);
    return { dir: [-Math.sin(across), Math.cos(across)], coherence };
}

/**
 * The road's look along strips of direction `dir` (`stripPx` across): per strip, the per-channel median of the texels `use`
 * admits (every second texel each way); `at(i, k, out)` interpolates between the strips' centres. A strip with fewer than
 * `minCount` of them takes its nearest neighbour's look, and with none anywhere, black.
 */
export function stripLooks(val: Float32Array, use: (p: number) => boolean, W: number, H: number, dir: [number, number], stripPx: number, minCount = 8): { at(i: number, k: number, out: number[]): void } {
    const [ax, az] = dir;
    const across = (i: number, k: number) => -az * i + ax * k;
    const u0 = Math.min(across(0, 0), across(W, 0), across(0, H), across(W, H));
    const u1 = Math.max(across(0, 0), across(W, 0), across(0, H), across(W, H));
    const S = Math.max(1, Math.ceil((u1 - u0) / stripPx));
    const hist = new Uint32Array(S * 3 * 256), count = new Uint32Array(S);
    for (let k = 0; k < H; k += 2) for (let i = 0; i < W; i += 2) {
        const p = k * W + i;
        if (!use(p)) continue;
        const b = Math.min(S - 1, Math.floor((across(i + 0.5, k + 0.5) - u0) / stripPx));
        count[b]++;
        for (let j = 0; j < 3; j++) hist[(b * 3 + j) * 256 + Math.max(0, Math.min(255, Math.round(val[p * 3 + j])))]++;
    }
    const looks = new Float32Array(S * 3), has = new Uint8Array(S);
    for (let b = 0; b < S; b++) {
        if (count[b] < minCount) continue;
        has[b] = 1;
        for (let j = 0; j < 3; j++) {
            const h = (b * 3 + j) * 256;
            let c = hist[h], v = 0;
            while (v < 255 && c * 2 < count[b]) c += hist[h + ++v];
            looks[b * 3 + j] = v;
        }
    }
    // a strip without enough texels: its nearest strip's look
    for (let b = 0; b < S; b++) {
        if (has[b]) continue;
        for (let d = 1; d < S; d++) {
            const n = b - d >= 0 && has[b - d] ? b - d : b + d < S && has[b + d] ? b + d : -1;
            if (n < 0) continue;
            for (let j = 0; j < 3; j++) looks[b * 3 + j] = looks[n * 3 + j];
            break;
        }
    }
    return {
        at(i: number, k: number, out: number[]) {
            const f = Math.max(0, Math.min(S - 1, (across(i + 0.5, k + 0.5) - u0) / stripPx - 0.5));
            const b0 = Math.floor(f), b1 = Math.min(S - 1, b0 + 1), a = f - b0;
            for (let j = 0; j < 3; j++) out[j] = (1 - a) * looks[b0 * 3 + j] + a * looks[b1 * 3 + j];
        }
    };
}

export interface FillField {
    frame: TopDownFrame; texelM: number; width: number; height: number;
    /** sRGB8 RGB. */
    rgb: Uint8Array;
    /**
     * The group's texels painted from the photo along the line (photo-inferred) and those taken from their strip's look where
     * neither end's look reaches (generated), each texel counted by its share of either.
     */
    mirrored: number; generated: number;
    /** The direction painted along (unit, plan) and the photo's coherence there (0: no direction, the long axis used). */
    direction: [number, number]; coherence: number;
}

/**
 * The road photo for one group: the scan rendered from above around it (every region masked out), each of the group's
 * texels painted along the direction the road's own markings run (`fillDirection`): from the road just beyond the region's
 * end on each side along that line, the stretch there reflected back and forth so a long region carries the road's texture
 * (photo-inferred), the two ends blended by nearness and by how far each end's look was seen running on. Then the mismatch
 * with the photo at each end is spread along the same line, so the patch meets the photo around it without a seam and a
 * lane's colour never runs into the next lane; where neither end's look reaches, the texel takes the road's look along its
 * strip (generated).
 */
export function buildFillField(tris: TileTriangles, region: VehicleRegion, g: RegionGroup, P: VehicleRemovalParams = VEHICLE_REMOVAL_PARAMS): FillField {
    const frame: TopDownFrame = { x0: g.lo[0] - P.fillMarginM, z0: g.lo[1] - P.fillMarginM, widthM: g.hi[0] - g.lo[0] + 2 * P.fillMarginM, heightM: g.hi[1] - g.lo[1] + 2 * P.fillMarginM };
    let texelM = Math.max(P.fillTexelM, frame.widthM / 2048, frame.heightM / 2048);
    const sub = selectTriangles(tris, trianglesNear(tris, frame));
    let topY = -Infinity;
    for (let i = 1; i < sub.positions.length; i += 3) topY = Math.max(topY, sub.positions[i]);
    if (topY === -Infinity) topY = 0;
    const cam = topDownCamera(frame, topY, texelM);
    const W = cam.width, H = cam.height;
    texelM = frame.widthM / W;
    const r = renderTriangles([sub], cam, { supersample: 1, ambient: 1, background: [0, 0, 0] });
    // hole: inside any region; mine: inside this group (the texels its patch reads); known: drawn and not a hole
    const hole = new Uint8Array(W * H), known = new Uint8Array(W * H);
    const mine: number[] = [];
    for (let k = 0; k < H; k++) for (let i = 0; i < W; i++) {
        const p = k * W + i;
        const x = frame.x0 + (i + 0.5) * texelM, z = frame.z0 + (k + 0.5) * texelM;
        const ci = Math.floor((x - region.x0) / region.cellM), ck = Math.floor((z - region.z0) / region.cellM);
        const c = ci < 0 || ck < 0 || ci >= region.nx || ck >= region.nz ? -1 : ck * region.nx + ci;
        if (c >= 0 && region.group[c] >= 0) { hole[p] = 1; if (region.group[c] === g.id) mine.push(p); }
        // the street only: what stands on it (a canopy, a vehicle the model did not box) is no source for the street under a vehicle
        else if (r.coverage[p] > 0.5 && c >= 0 && region.rel[c] <= P.ringMaxAboveStreetM) known[p] = 1;
    }
    const src = r.rgba;
    const val = new Float32Array(W * H * 3);
    for (let p = 0; p < W * H; p++) if (known[p]) { val[p * 3] = src[p * 4]; val[p * 3 + 1] = src[p * 4 + 1]; val[p * 3 + 2] = src[p * 4 + 2]; }
    // each texel's distance from the nearest region (4-neighbour steps; -1 past the orientation band)
    const guard = Math.max(1, Math.round(P.fillGuardM / texelM));
    const band = Math.max(guard + 2, Math.round(P.fillOrientM / texelM));
    const dist = new Int32Array(W * H).fill(-1);
    {
        let frontier: number[] = [];
        for (let p = 0; p < W * H; p++) if (hole[p]) { dist[p] = 0; frontier.push(p); }
        for (let s = 1; s <= band && frontier.length; s++) {
            const nf: number[] = [];
            for (const p of frontier) {
                const i = p % W, k = (p - i) / W;
                if (i > 0 && dist[p - 1] < 0) { dist[p - 1] = s; nf.push(p - 1); }
                if (i < W - 1 && dist[p + 1] < 0) { dist[p + 1] = s; nf.push(p + 1); }
                if (k > 0 && dist[p - W] < 0) { dist[p - W] = s; nf.push(p - W); }
                if (k < H - 1 && dist[p + W] < 0) { dist[p + W] = s; nf.push(p + W); }
            }
            frontier = nf;
        }
    }
    // sources: street texels clear of every region by the guard (nearer, the photo may still show the vehicle's edge)
    const source = (q: number) => q >= 0 && known[q] === 1 && (dist[q] < 0 || dist[q] > guard);
    const { dir: [ax, az], coherence } = fillDirection(val, source, dist, W, H, texelM, g.axis, P);
    const searchPx = guard + Math.round(P.fillSearchM / texelM), runPx = Math.max(1, Math.round(P.fillRunM / texelM));
    const reachMinPx = P.fillReachMinM / texelM, reachFadePx = P.fillReachFadeM / texelM, basePx = Math.max(1, Math.round(P.fillBaseM / texelM));
    const grainPx = Math.max(1, Math.round(P.fillGrainM / texelM));
    const maxSteps = Math.ceil(Math.hypot(W, H));
    const at = (fi: number, fk: number) => { const i = Math.round(fi), k = Math.round(fk); return i < 0 || k < 0 || i >= W || k >= H ? -1 : k * W + i; };
    const off = (q: number, m: number[]) => Math.max(Math.abs(val[q * 3] - m[0]), Math.abs(val[q * 3 + 1] - m[1]), Math.abs(val[q * 3 + 2] - m[2]));
    // the stretch of road from step `s0` along a line: as far as it keeps its look (at most fillRunM), its length, its mean
    // and the mean of its first fillBaseM
    const st = { run: 0, m: [0, 0, 0], base: [0, 0, 0] };
    const stretch = (i: number, k: number, dx: number, dz: number, s0: number) => {
        const q0 = at(i + s0 * dx, k + s0 * dz);
        let run = 1, n = 1, nb = 1, odd = 0;
        for (let j = 0; j < 3; j++) st.m[j] = st.base[j] = val[q0 * 3 + j];
        for (let s = s0 + 1; s < s0 + runPx; s++) {
            const q = at(i + s * dx, k + s * dz);
            if (!source(q)) break;
            // a speck (a crack, a stain) is stepped over, not taken into the look
            if (off(q, st.m) > P.fillRunTolerance) { if (++odd >= 3) break; continue; }
            odd = 0;
            for (let j = 0; j < 3; j++) st.m[j] = (st.m[j] * n + val[q * 3 + j]) / (n + 1);
            if (s - s0 < basePx) { for (let j = 0; j < 3; j++) st.base[j] = (st.base[j] * nb + val[q * 3 + j]) / (nb + 1); nb++; }
            n++; run = s - s0 + 1;
        }
        st.run = run;
    };
    // the mirror: a texel `e` deep inside takes the road at the region's edge with the grain of the road as far into the
    // stretch, reflected back and forth across it (its difference from the road within fillGrainM either side, held to fillGrain)
    const local = [0, 0, 0];
    const grainAt = (i: number, k: number, dx: number, dz: number, s0: number, e: number, out: number[]) => {
        const m = (e - 1) % (2 * st.run), t = m < st.run ? m : 2 * st.run - 1 - m;
        let n = 0;
        local[0] = local[1] = local[2] = 0;
        for (let u = Math.max(0, t - grainPx); u <= Math.min(st.run - 1, t + grainPx); u++) {
            const q = at(i + (s0 + u) * dx, k + (s0 + u) * dz);
            if (!source(q)) continue;
            n++; local[0] += val[q * 3]; local[1] += val[q * 3 + 1]; local[2] += val[q * 3 + 2];
        }
        const q = at(i + (s0 + t) * dx, k + (s0 + t) * dz);
        for (let j = 0; j < 3; j++) out[j] = st.base[j] + (n ? Math.max(-P.fillGrain, Math.min(P.fillGrain, val[q * 3 + j] - local[j] / n)) : 0);
    };
    const c = [0, 0, 0];
    const N = mine.length;
    const paint = new Float32Array(W * H * 3), painted = new Uint8Array(W * H), trust = new Float32Array(N);
    // per texel and side: the first texel past the region along the line, the last inside it, and how deep the texel lies
    const endQ = new Int32Array(N * 2).fill(-1), lastQ = new Int32Array(N * 2).fill(-1), depth = new Int32Array(N * 2);
    for (let n = 0; n < N; n++) {
        const p = mine[n], i = p % W, k = (p - i) / W;
        let sw = 0, a0 = 0, a1 = 0, a2 = 0, reached = 0;
        for (let side = 0; side < 2; side++) {
            const dx = side ? -ax : ax, dz = side ? -az : az;
            let e = 0;
            for (let s = 1; s <= maxSteps; s++) { const q = at(i + s * dx, k + s * dz); if (q < 0) break; if (!hole[q]) { e = s; break; } }
            if (!e) continue;
            endQ[n * 2 + side] = at(i + e * dx, k + e * dz); lastQ[n * 2 + side] = e > 1 ? at(i + (e - 1) * dx, k + (e - 1) * dz) : p; depth[n * 2 + side] = e;
            // the first source past the guard (past another region, a gap in the photo), and the stretch of road from it
            let s0 = 0;
            for (let s = e; s <= e + searchPx; s++) { const q = at(i + s * dx, k + s * dz); if (q < 0) break; if (source(q)) { s0 = s; break; } }
            if (!s0) continue;
            stretch(i, k, dx, dz, s0);
            grainAt(i, k, dx, dz, s0, e, c);
            // carried in about as far as it was seen running on beyond the end
            const reach = Math.max(reachMinPx, st.run * P.fillReachPerRun);
            const f = e <= reach ? 1 : Math.exp(-(e - reach) / reachFadePx);
            const w = f / (e * e);
            reached = Math.max(reached, f);
            sw += w; a0 += w * c[0]; a1 += w * c[1]; a2 += w * c[2];
        }
        if (sw > 0) { paint[p * 3] = a0 / sw; paint[p * 3 + 1] = a1 / sw; paint[p * 3 + 2] = a2 / sw; painted[p] = 1; trust[n] = reached; }
    }
    // the seam: at each end, the photo just outside (its street texels' 5x5 mean, the guard band included) less the paint just
    // inside, held to `fillSeamMax` (more is something else at the end: a shadow, a kerb) and carried along the line by
    // nearness to that end, fading with depth (a dark spot at an end never streaks across the patch)
    const mean5 = (v: Float32Array, has: Uint8Array, q: number, out: number[]) => {
        const i = q % W, k = (q - i) / W;
        let c = 0; out[0] = out[1] = out[2] = 0;
        for (let kk = Math.max(0, k - 2); kk <= Math.min(H - 1, k + 2); kk++) for (let ii = Math.max(0, i - 2); ii <= Math.min(W - 1, i + 2); ii++) {
            const u = kk * W + ii;
            if (!has[u]) continue;
            c++; out[0] += v[u * 3]; out[1] += v[u * 3 + 1]; out[2] += v[u * 3 + 2];
        }
        if (c) { out[0] /= c; out[1] /= c; out[2] /= c; }
        return c;
    };
    const fix = new Float32Array(N * 3);
    const ph = [0, 0, 0], pa = [0, 0, 0];
    const fadePx = P.fillSeamFadeM / texelM, cap = (v: number) => Math.max(-P.fillSeamMax, Math.min(P.fillSeamMax, v));
    for (let n = 0; n < N; n++) {
        const p = mine[n];
        if (!painted[p]) continue;
        let fw = 0, f0 = 0, f1 = 0, f2 = 0;
        for (let side = 0; side < 2; side++) {
            const q = endQ[n * 2 + side];
            if (q < 0 || !mean5(val, known, q, ph) || !mean5(paint, painted, lastQ[n * 2 + side], pa)) continue;
            const e = depth[n * 2 + side], w = 1 / e, fade = w * Math.exp(-(e - 1) / fadePx);
            fw += w; f0 += fade * cap(ph[0] - pa[0]); f1 += fade * cap(ph[1] - pa[1]); f2 += fade * cap(ph[2] - pa[2]);
        }
        if (fw) { fix[n * 3] = f0 / fw; fix[n * 3 + 1] = f1 / fw; fix[n * 3 + 2] = f2 / fw; }
    }
    // the road's look along each strip of the painting direction: the median of its street beside the regions
    const strips = stripLooks(val, q => dist[q] > 0 && source(q), W, H, [ax, az], Math.max(1, P.fillStripM / texelM), Math.ceil(P.fillStripMinM2 / (4 * texelM * texelM)));
    const look = [0, 0, 0];
    // the field: the photo, the painted texels (fading into their strip's look where neither end reaches), and what lies
    // around (for the sampler) from its surroundings
    const fillV = new Float32Array(W * H * 3), fillK = new Float32Array(W * H);
    for (let p = 0; p < W * H; p++) if (known[p]) { fillV[p * 3] = val[p * 3]; fillV[p * 3 + 1] = val[p * 3 + 1]; fillV[p * 3 + 2] = val[p * 3 + 2]; fillK[p] = 1; }
    let reachedShare = 0;
    for (let n = 0; n < N; n++) {
        const p = mine[n], i = p % W, k = (p - i) / W, t = trust[n];
        strips.at(i, k, look);
        for (let j = 0; j < 3; j++) fillV[p * 3 + j] = t * (paint[p * 3 + j] + fix[n * 3 + j]) + (1 - t) * look[j];
        fillK[p] = 1;
        reachedShare += t;
    }
    const field = pushPull(fillV, fillK, W, H, 3);
    const rgb = new Uint8Array(W * H * 3);
    for (let p = 0; p < W * H * 3; p++) rgb[p] = Math.max(0, Math.min(255, Math.round(field[p])));
    const mirrored = Math.round(reachedShare);
    return { frame, texelM, width: W, height: H, rgb, mirrored, generated: N - mirrored, direction: [ax, az], coherence };
}

/** Bilinear sRGB sample of a fill field at plan (x, z). */
function sampleFill(f: FillField, x: number, z: number, out: number[]): void {
    const fx = Math.max(0, Math.min(f.width - 1, (x - f.frame.x0) / f.texelM - 0.5)), fz = Math.max(0, Math.min(f.height - 1, (z - f.frame.z0) / f.texelM - 0.5));
    const i0 = Math.floor(fx), k0 = Math.floor(fz), i1 = Math.min(f.width - 1, i0 + 1), k1 = Math.min(f.height - 1, k0 + 1);
    const ax = fx - i0, az = fz - k0;
    for (let j = 0; j < 3; j++) {
        const a = f.rgb[(k0 * f.width + i0) * 3 + j], b = f.rgb[(k0 * f.width + i1) * 3 + j], c = f.rgb[(k1 * f.width + i0) * 3 + j], d = f.rgb[(k1 * f.width + i1) * 3 + j];
        out[j] = (1 - az) * ((1 - ax) * a + ax * b) + az * ((1 - ax) * c + ax * d);
    }
}

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

/** A node matrix's inverse (a world point back into the node's frame). */
export function invert(m: Mat4): Mat4 {
    const inv = new Float64Array(16);
    inv[0] = m[5] * m[10] * m[15] - m[5] * m[11] * m[14] - m[9] * m[6] * m[15] + m[9] * m[7] * m[14] + m[13] * m[6] * m[11] - m[13] * m[7] * m[10];
    inv[4] = -m[4] * m[10] * m[15] + m[4] * m[11] * m[14] + m[8] * m[6] * m[15] - m[8] * m[7] * m[14] - m[12] * m[6] * m[11] + m[12] * m[7] * m[10];
    inv[8] = m[4] * m[9] * m[15] - m[4] * m[11] * m[13] - m[8] * m[5] * m[15] + m[8] * m[7] * m[13] + m[12] * m[5] * m[11] - m[12] * m[7] * m[9];
    inv[12] = -m[4] * m[9] * m[14] + m[4] * m[10] * m[13] + m[8] * m[5] * m[14] - m[8] * m[6] * m[13] - m[12] * m[5] * m[10] + m[12] * m[6] * m[9];
    inv[1] = -m[1] * m[10] * m[15] + m[1] * m[11] * m[14] + m[9] * m[2] * m[15] - m[9] * m[3] * m[14] - m[13] * m[2] * m[11] + m[13] * m[3] * m[10];
    inv[5] = m[0] * m[10] * m[15] - m[0] * m[11] * m[14] - m[8] * m[2] * m[15] + m[8] * m[3] * m[14] + m[12] * m[2] * m[11] - m[12] * m[3] * m[10];
    inv[9] = -m[0] * m[9] * m[15] + m[0] * m[11] * m[13] + m[8] * m[1] * m[15] - m[8] * m[3] * m[13] - m[12] * m[1] * m[11] + m[12] * m[3] * m[9];
    inv[13] = m[0] * m[9] * m[14] - m[0] * m[10] * m[13] - m[8] * m[1] * m[14] + m[8] * m[2] * m[13] + m[12] * m[1] * m[10] - m[12] * m[2] * m[9];
    inv[2] = m[1] * m[6] * m[15] - m[1] * m[7] * m[14] - m[5] * m[2] * m[15] + m[5] * m[3] * m[14] + m[13] * m[2] * m[7] - m[13] * m[3] * m[6];
    inv[6] = -m[0] * m[6] * m[15] + m[0] * m[7] * m[14] + m[4] * m[2] * m[15] - m[4] * m[3] * m[14] - m[12] * m[2] * m[7] + m[12] * m[3] * m[6];
    inv[10] = m[0] * m[5] * m[15] - m[0] * m[7] * m[13] - m[4] * m[1] * m[15] + m[4] * m[3] * m[13] + m[12] * m[1] * m[7] - m[12] * m[3] * m[5];
    inv[14] = -m[0] * m[5] * m[14] + m[0] * m[6] * m[13] + m[4] * m[1] * m[14] - m[4] * m[2] * m[13] - m[12] * m[1] * m[6] + m[12] * m[2] * m[5];
    inv[3] = -m[1] * m[6] * m[11] + m[1] * m[7] * m[10] + m[5] * m[2] * m[11] - m[5] * m[3] * m[10] - m[9] * m[2] * m[7] + m[9] * m[3] * m[6];
    inv[7] = m[0] * m[6] * m[11] - m[0] * m[7] * m[10] - m[4] * m[2] * m[11] + m[4] * m[3] * m[10] + m[8] * m[2] * m[7] - m[8] * m[3] * m[6];
    inv[11] = -m[0] * m[5] * m[11] + m[0] * m[7] * m[9] + m[4] * m[1] * m[11] - m[4] * m[3] * m[9] - m[8] * m[1] * m[7] + m[8] * m[3] * m[5];
    inv[15] = m[0] * m[5] * m[10] - m[0] * m[6] * m[9] - m[4] * m[1] * m[10] + m[4] * m[2] * m[9] + m[8] * m[1] * m[6] - m[8] * m[2] * m[5];
    let det = m[0] * inv[0] + m[1] * inv[4] + m[2] * inv[8] + m[3] * inv[12];
    if (Math.abs(det) < 1e-15) throw new Error('a node matrix is singular');
    det = 1 / det;
    for (let i = 0; i < 16; i++) inv[i] *= det;
    return inv;
}

export interface PatchGlbStats { movedVertices: number; touchedTriangles: number; paintedTexels: number; repaintedImages: number; primitives: number }

/**
 * Moves every vertex of the GLB that lies in a region group (and not more than proudMaxM above its patch surface) onto the
 * patch surface, and, with `fills`, paints again the texels of every triangle it moved from the group's fill field. Index
 * lists are untouched (no triangle removed, no edge opened); positions, normals, the moved accessors' bounds and the
 * repainted images change.
 */
export function patchVehiclesInGlb(bytes: Uint8Array, region: VehicleRegion, opts: { fills?: Map<number, FillField>; extras?: Record<string, unknown>; P?: VehicleRemovalParams } = {}): { glb: Buffer; stats: PatchGlbStats } {
    const P = opts.P ?? VEHICLE_REMOVAL_PARAMS;
    const glb = parseGlbBytes(bytes);
    const json = glb.json;
    const bin = new Uint8Array(glb.bin.byteLength);
    bin.set(glb.bin);
    const dv = new DataView(bin.buffer);
    const world = nodeWorldMatrices(json);
    const stats: PatchGlbStats = { movedVertices: 0, touchedTriangles: 0, paintedTexels: 0, repaintedImages: 0, primitives: 0 };
    const images = new Map<number, { width: number; height: number; rgba: Uint8Array; mime: string }>();
    const dirty = new Set<number>();
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
            const gid = new Int32Array(n).fill(-1);
            let any = 0;
            for (let v = 0; v < n; v++) {
                const o = pl.base + v * pl.stride;
                const lx = dv.getFloat32(o, true), ly = dv.getFloat32(o + 4, true), lz = dv.getFloat32(o + 8, true);
                const w = ident ? [lx, ly, lz] : transformPoint(m, lx, ly, lz);
                wp[v * 3] = w[0]; wp[v * 3 + 1] = w[1]; wp[v * 3 + 2] = w[2];
                const ci = Math.floor((w[0] - region.x0) / region.cellM), ck = Math.floor((w[2] - region.z0) / region.cellM);
                if (ci < 0 || ck < 0 || ci >= region.nx || ck >= region.nz) continue;
                const g = region.group[ck * region.nx + ci];
                if (g < 0) continue;
                if (w[1] > region.ceiling[ck * region.nx + ci] + 0.05) continue;
                const y = patchHeight(region.groups[g], w[0], w[2]);
                if (y !== y || w[1] - y > P.proudMaxM) continue;
                gid[v] = g;
                moved[v] = 1; any++;
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
            const idxAcc = prim.indices !== undefined ? json.accessors[prim.indices] : undefined;
            const triIdx: number[] = [];
            const count = idxAcc ? idxAcc.count : n;
            const readIndex = (k: number) => {
                if (!idxAcc) return k;
                const v = json.bufferViews[idxAcc.bufferView];
                const size = idxAcc.componentType === 5125 ? 4 : idxAcc.componentType === 5123 ? 2 : 1;
                const o = (v.byteOffset ?? 0) + (idxAcc.byteOffset ?? 0) + k * (v.byteStride || size);
                return size === 4 ? dv.getUint32(o, true) : size === 2 ? dv.getUint16(o, true) : dv.getUint8(o);
            };
            for (let t = 0; t + 2 < count; t += 3) {
                const a = readIndex(t), b = readIndex(t + 1), c = readIndex(t + 2);
                if (moved[a] || moved[b] || moved[c]) triIdx.push(a, b, c);
            }
            stats.touchedTriangles += triIdx.length / 3;
            // the texels
            const texIndex = json.materials?.[prim.material]?.pbrMetallicRoughness?.baseColorTexture?.index;
            const texCoord = json.materials?.[prim.material]?.pbrMetallicRoughness?.baseColorTexture?.texCoord ?? 0;
            const uvAcc = prim.attributes[`TEXCOORD_${texCoord}`];
            if (!opts.fills || texIndex === undefined || uvAcc === undefined) continue;
            const imageIndex = json.textures?.[texIndex]?.source;
            const image = imageIndex !== undefined ? json.images?.[imageIndex] : undefined;
            if (!image || image.bufferView === undefined) continue;
            const ul = layout(uvAcc);
            if (ul.a.componentType !== 5126) continue;
            let img = images.get(imageIndex);
            if (!img) {
                const view = json.bufferViews[image.bufferView];
                const d = decodeImageInMemory(glb.bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength));
                img = { width: d.width, height: d.height, rgba: new Uint8Array(d.rgba), mime: image.mimeType ?? 'image/jpeg' };
                images.set(imageIndex, img);
            }
            const IW = img.width, IH = img.height;
            const uv = (v: number) => [dv.getFloat32(ul.base + v * ul.stride, true) * IW - 0.5, dv.getFloat32(ul.base + v * ul.stride + 4, true) * IH - 0.5];
            const col = [0, 0, 0];
            for (let t = 0; t < triIdx.length; t += 3) {
                const [a, b, c] = [triIdx[t], triIdx[t + 1], triIdx[t + 2]];
                const [ua, va] = uv(a), [ub, vb] = uv(b), [uc, vc] = uv(c);
                const det = (ub - ua) * (vc - va) - (uc - ua) * (vb - va);
                if (Math.abs(det) < 1e-9) continue;
                // one texel past the triangle's edges, so filtering at the chart's border reads the new colour too
                const pad = 1;
                const i0 = Math.max(0, Math.floor(Math.min(ua, ub, uc)) - pad), i1 = Math.min(IW - 1, Math.ceil(Math.max(ua, ub, uc)) + pad);
                const k0 = Math.max(0, Math.floor(Math.min(va, vb, vc)) - pad), k1 = Math.min(IH - 1, Math.ceil(Math.max(va, vb, vc)) + pad);
                if ((i1 - i0 + 1) * (k1 - k0 + 1) > 4_000_000) continue;
                // the barycentric tolerance that reaches one texel past the shortest altitude
                const e = [Math.hypot(ub - uc, vb - vc), Math.hypot(uc - ua, vc - va), Math.hypot(ua - ub, va - vb)];
                const alt = e.map(L => Math.abs(det) / Math.max(L, 1e-9));
                const tol = alt.map(h => 1.0 / Math.max(h, 1e-6));
                for (let k = k0; k <= k1; k++) for (let i = i0; i <= i1; i++) {
                    const l1 = ((ub - i) * (vc - k) - (uc - i) * (vb - k)) / det;
                    const l2 = ((uc - i) * (va - k) - (ua - i) * (vc - k)) / det;
                    const l3 = 1 - l1 - l2;
                    if (l1 < -tol[0] || l2 < -tol[1] || l3 < -tol[2]) continue;
                    const b1 = Math.max(0, l1), b2 = Math.max(0, l2), b3 = Math.max(0, l3), bs = b1 + b2 + b3 || 1;
                    const x = (b1 * wp[a * 3] + b2 * wp[b * 3] + b3 * wp[c * 3]) / bs;
                    const z = (b1 * wp[a * 3 + 2] + b2 * wp[b * 3 + 2] + b3 * wp[c * 3 + 2]) / bs;
                    const g = regionGroupAt(region, x, z);
                    if (g < 0) continue;
                    const f = opts.fills.get(g);
                    if (!f) continue;
                    sampleFill(f, x, z, col);
                    const p = (k * IW + i) * 4;
                    img.rgba[p] = col[0]; img.rgba[p + 1] = col[1]; img.rgba[p + 2] = col[2];
                    stats.paintedTexels++;
                }
            }
            dirty.add(imageIndex);
        }
    });
    // the repainted images back into the binary chunk (each buffer view copied in order, the images' replaced)
    const replaced = new Map<number, Uint8Array>();
    for (const [imageIndex, img] of images) {
        if (!dirty.has(imageIndex)) continue;
        const data = img.mime === 'image/png'
            ? new Uint8Array(encodePng(img.width, img.height, img.rgba, 4))
            : new Uint8Array(jpegJs.encode({ data: Buffer.from(img.rgba.buffer, img.rgba.byteOffset, img.rgba.byteLength), width: img.width, height: img.height }, 92).data);
        replaced.set(json.images[imageIndex].bufferView, data);
        stats.repaintedImages++;
    }
    let out: Uint8Array = bin;
    if (replaced.size) {
        const parts: Array<{ view: any; data: Uint8Array }> = (json.bufferViews as any[]).map((view, vi) => ({ view, data: replaced.get(vi) ?? bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength) }));
        let len = 0;
        for (const p of parts) { len += (4 - (len % 4)) % 4; len += p.data.byteLength; }
        out = new Uint8Array(len);
        let o = 0;
        for (const p of parts) { o += (4 - (o % 4)) % 4; out.set(p.data, o); p.view.byteOffset = o; p.view.byteLength = p.data.byteLength; o += p.data.byteLength; }
        if (json.buffers?.[0]) json.buffers[0].byteLength = out.byteLength;
    }
    if (opts.extras) {
        const scene = json.scenes?.[json.scene ?? 0];
        json.extras = { ...(json.extras ?? {}), ...opts.extras };
        if (scene) scene.extras = { ...(scene.extras ?? {}), ...opts.extras };
    }
    return { glb: assembleGlb(json, out), stats };
}

// ------------------------------------------------------------------------------------------------ the whole step

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
        provenance: { geometry: 'generated'; texture: { photoInferredShare: number; generatedShare: number } };
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
    const P = input.P ?? VEHICLE_REMOVAL_PARAMS;
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
    measureStacks(region, input.scan, input.ground, P);
    const fills = new Map<number, FillField>();
    for (const g of region.groups) {
        const f = buildFillField(tris, region, g, P);
        fills.set(g.id, f);
        if (input.keepImages) fs.writeFileSync(path.join(cropDir, `fill_${g.id}.png`), encodePng(f.width, f.height, f.rgb, 3));
    }
    const removed: VehicleRemovalReport['removed'] = region.groups.map(g => {
        const f = fills.get(g.id)!;
        const holeTexels = f.mirrored + f.generated || 1;
        const labels = [...new Set(g.readings.map(k => readings[k].label))];
        const temporary = g.readings.some(k => !readings[k].vehicle);
        const what = labels.length ? `the vision model read ${labels.join('; ')} here in the scan's top-down photo${temporary ? ' (standing there only for a while: not part of the place)' : ''}` : g.debrisCells ? 'a lump too small to be a fixture lay low on the carriageway (a remnant, a dropped load or the scan\'s own blob)' : 'the vision model read a vehicle here';
        return {
            id: g.id, labels, lo: [r2(g.lo[0]), r2(g.lo[1])], hi: [r2(g.hi[0]), r2(g.hi[1])], areaM2: r2(g.cells.length * region.cellM * region.cellM),
            provenance: { geometry: 'generated', texture: { photoInferredShare: r2(f.mirrored / holeTexels), generatedShare: r2(f.generated / holeTexels) } },
            kind: labels.length ? (temporary ? 'temporary' : 'vehicle') : g.debrisCells ? 'debris' : 'vehicle',
            reason: `${what}, so the lump the scan made of it is removed: the surface under it is estimated from ${g.ringFromGroundModel ? "the measured street model (no scan ring around it)" : `${g.ring.length / 3} measured scan points around it`} (no measurement exists under a vehicle) and painted from the road photo around it`
        };
    });
    const extras = {
        sbVehicleRemoval: {
            version: VEHICLE_REMOVAL_VERSION,
            removed: removed.map(r => ({ id: r.id, labels: r.labels, lo: r.lo, hi: r.hi, areaM2: r.areaM2, provenance: { geometry: { label: 'generated', reason: 'heights estimated from the measured scan around the vehicle: nothing was measured under it' }, texture: { label: r.provenance.texture.generatedShare > 0.5 ? 'generated' : 'photo-inferred', ...r.provenance.texture, reason: "painted along the road's own markings from the scan's photo of the road beyond the vehicle's ends; texels no end's look reached take the road's look along their lane (generated)" } } }))
        }
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
        const tex = patchVehiclesInGlb(bytes, region, { fills, extras, P });
        texturedOut = path.join(input.outDir, 'textured.glb');
        fs.writeFileSync(texturedOut, tex.glb);
        report.patch.textured = tex.stats;
        if (input.geometryGlb) {
            const geo = patchVehiclesInGlb(fs.readFileSync(input.geometryGlb), region, { extras, P });
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
