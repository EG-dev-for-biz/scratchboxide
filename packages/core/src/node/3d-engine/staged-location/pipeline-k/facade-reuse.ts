/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Pipeline K: which facades the ownership vote left as they were. A material vote re-refines the structure, and tile_refine
 * fits its wall planes and writes their orthophotos again over the whole voted isolate; the facade pass (straightening,
 * the facade reader, the window fit, the window arrays) then ran again on every facade, though most of them are the same
 * wall photographed the same way. A voted facade is taken as the first pass's when
 *
 *   - its plane is the same: normals within FACADE_REUSE_PARAMS.normalCos, the planes within planeOffsetM of each other,
 *     each edge of its rectangle within boundsM;
 *   - the vote moved no scan triangle near it: none of the triangles one isolate holds and the other does not (the raw
 *     scans' own, ownership-change.ts) lies within slabM of the plane and marginM of the rectangle;
 *   - its orthophoto is the same photo of the same surface: aligned to the first pass's (the frames shift by a fraction
 *     of a texel), the texels one covers and the other does not are at most coverageDiff of those either covers, and the
 *     colours the two share differ by at most colourMean levels on average.
 *
 * The three tests measure different things: tile_refine regrows its plane regions over the whole isolate, so a plane far
 * from anything the vote moved can still gain or lose surface (30 Rockefeller Plaza, 2026-11-08: the main slab's region
 * grew by 1,540 m², coverage 0.71 -> 0.80, with no moved triangle within a metre of it), which only the photo shows. On
 * that build the matched planes fell into two groups: 22 within 1.4% of covered texels of the first pass's (the colour
 * on their shared texels 0.0 to 4.8 levels apart, the drift of a 0 to 0.7 texel shift of the frame resampling a sharp
 * facade), and the rest 2.5% and more apart. A kept facade takes the first pass's id, straightened photo, reading, window
 * fit and arrays; a changed one is computed again, under an id the first pass never gave to any facade.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { ReliefFacade } from '../facade-lattice';
import { decodePng } from '../../../texture-processing';
import { occludedMaskName } from './ortho-rectify';

export const FACADE_REUSE_VERSION = 'facade-reuse/1';

export const FACADE_REUSE_PARAMS = {
    /** The planes' normals at most 0.5 degrees apart. */
    normalCos: 0.99996,
    /** The planes at most this far apart along the normal (m). */
    planeOffsetM: 0.05,
    /** Each edge of the facade's rectangle at most this far from the first pass's (m; four texels at 7.7 cm). */
    boundsM: 0.3,
    /** A moved scan triangle within this distance of the plane (m) and marginM of its rectangle changes the facade. */
    slabM: 1.0,
    marginM: 1.0,
    /** The texels one ortho covers and the other does not, as a share of those either covers. */
    coverageDiff: 0.02,
    /** The mean difference (the largest channel, 8-bit levels) over the texels both cover. */
    colourMean: 8
};
export type FacadeReuseParams = typeof FACADE_REUSE_PARAMS;

export interface FacadeMatchMetrics {
    /** The first pass's facade the voted one was compared with, and how far their rectangles' edges lie apart (m). */
    firstId?: number; boundsM?: number;
    /** Scan area (m²) the vote moved near the facade. */
    movedM2: number;
    /** Covered texels one ortho has and the other does not, over those either has; the colours' mean difference; the frame shift (texels). */
    coverageDiff?: number; colourMean?: number; shiftPx?: [number, number];
}

export interface FacadeReusePlan {
    version: string;
    params: FacadeReuseParams;
    /** Voted facades taken as the first pass's, under the first pass's id. */
    kept: Array<{ votedId: number; firstId: number; areaM2: number; metrics: FacadeMatchMetrics }>;
    /** Voted facades computed again: their id in the composed set and why they were not kept. */
    changed: Array<{ votedId: number; id: number; areaM2: number; reason: string; metrics: FacadeMatchMetrics }>;
    keptAreaM2: number;
    changedAreaM2: number;
}

const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: number[], b: number[]) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

function readFacades(dir: string): ReliefFacade[] {
    return (JSON.parse(fs.readFileSync(path.join(dir, 'facades.json'), 'utf8')) as { facades: ReliefFacade[] }).facades;
}

/** The scan area the vote moved near a facade: centroids within slabM of its plane and marginM of its rectangle. */
function movedNear(g: ReliefFacade, moved: Float64Array, areas: Float64Array | undefined, P: FacadeReuseParams): { m2: number; count: number } {
    let m2 = 0, count = 0;
    for (let k = 0; k + 2 < moved.length; k += 3) {
        const d = [moved[k] - g.centroid[0], moved[k + 1] - g.centroid[1], moved[k + 2] - g.centroid[2]];
        if (Math.abs(dot(d, g.normal)) > P.slabM) continue;
        const s = dot(d, g.axisS), t = dot(d, g.axisT);
        if (s < g.sMin - P.marginM || s > g.sMax + P.marginM || t < g.tMin - P.marginM || t > g.tMax + P.marginM) continue;
        count++; m2 += areas ? areas[k / 3] : 0;
    }
    return { m2, count };
}

/** How far the first pass's rectangle lies from the voted one's (m, the largest edge), in the voted plane's frame. */
function boundsApart(f: ReliefFacade, g: ReliefFacade): number {
    const dc = sub(f.centroid, g.centroid), ds = dot(dc, g.axisS), dt = dot(dc, g.axisT);
    return Math.max(Math.abs(f.sMin + ds - g.sMin), Math.abs(f.sMax + ds - g.sMax), Math.abs(f.tMin + dt - g.tMin), Math.abs(f.tMax + dt - g.tMax));
}

/** A raw ortho's covered texels: drawn (alpha) and not tile_refine's exact grey 128 for "the photo did not reach". */
function covered(rgba: Uint8Array, i: number): boolean {
    return rgba[i * 4 + 3] > 0 && !(rgba[i * 4] === 128 && rgba[i * 4 + 1] === 128 && rgba[i * 4 + 2] === 128);
}

/** The two orthos compared on the voted frame's grid, the first pass's shifted onto it by the frames' offset (whole texels). */
export function compareOrthos(a: { rgba: Uint8Array; width: number; height: number }, b: { rgba: Uint8Array; width: number; height: number }, ox: number, oy: number): { coverageDiff: number; colourMean: number } {
    // a's texel (x, y) lies at b's (x + ox, y + oy)
    let either = 0, one = 0, shared = 0, diff = 0;
    for (let y = Math.min(0, oy); y < Math.max(a.height, b.height - oy); y++) {
        for (let x = Math.min(0, ox); x < Math.max(a.width, b.width - ox); x++) {
            const inA = x >= 0 && y >= 0 && x < a.width && y < a.height, bx = x + ox, by = y + oy, inB = bx >= 0 && by >= 0 && bx < b.width && by < b.height;
            const ca = inA && covered(a.rgba, y * a.width + x), cb = inB && covered(b.rgba, by * b.width + bx);
            if (!ca && !cb) continue;
            either++;
            if (ca !== cb) { one++; continue; }
            const i = (y * a.width + x) * 4, j = (by * b.width + bx) * 4;
            diff += Math.max(Math.abs(a.rgba[i] - b.rgba[j]), Math.abs(a.rgba[i + 1] - b.rgba[j + 1]), Math.abs(a.rgba[i + 2] - b.rgba[j + 2]));
            shared++;
        }
    }
    return { coverageDiff: either ? one / either : 0, colourMean: shared ? diff / shared : 0 };
}

/**
 * Matches the voted remesh's facades (tile_refine's raw orthos, `votedDir`) to the first pass's (`firstDir`) and decides
 * which the vote left unchanged. `moved` holds the centroids of the scan triangles the vote moved (x y z, the scan frame),
 * `movedAreas` their areas.
 */
export function planFacadeReuse(firstDir: string, votedDir: string, moved: Float64Array, movedAreas?: Float64Array, P: FacadeReuseParams = FACADE_REUSE_PARAMS): FacadeReusePlan {
    const first = readFacades(firstDir), voted = readFacades(votedDir);
    const claimed = new Set<number>();
    const kept: FacadeReusePlan['kept'] = [], undecided: Array<{ g: ReliefFacade; reason: string; metrics: FacadeMatchMetrics }> = [];
    // the largest first, each first-pass facade matched once
    const order = [...voted].sort((a, b) => (b.coverage * b.width * b.height * b.pixel * b.pixel) - (a.coverage * a.width * a.height * a.pixel * a.pixel) || a.facadeId - b.facadeId);
    for (const g of order) {
        const near = movedNear(g, moved, movedAreas, P);
        const metrics: FacadeMatchMetrics = { movedM2: Math.round(near.m2 * 10) / 10 };
        let best: { f: ReliefFacade; apart: number } | undefined;
        for (const f of first) {
            if (claimed.has(f.facadeId) || dot(f.normal, g.normal) < P.normalCos || Math.abs(dot(sub(f.centroid, g.centroid), g.normal)) > P.planeOffsetM) continue;
            const apart = boundsApart(f, g);
            if (!best || apart < best.apart) best = { f, apart };
        }
        if (best) { metrics.firstId = best.f.facadeId; metrics.boundsM = Math.round(best.apart * 1000) / 1000; }
        if (!best || best.apart > P.boundsM) { undecided.push({ g, reason: best ? `its plane's rectangle moved ${metrics.boundsM} m from the first pass's facade ${best.f.facadeId}` : 'no first-pass facade lies on its plane', metrics }); continue; }
        if (near.count) { undecided.push({ g, reason: `the vote moved ${metrics.movedM2} m² of scan (${near.count} triangles) within ${P.slabM} m of it`, metrics }); continue; }
        const f = best.f;
        const fa = path.join(firstDir, f.image), fb = path.join(votedDir, g.image);
        if (!fs.existsSync(fa) || !fs.existsSync(fb)) { undecided.push({ g, reason: 'an orthophoto is missing', metrics }); continue; }
        const a = decodePng(fs.readFileSync(fa)), b = decodePng(fs.readFileSync(fb));
        const dc = sub(f.centroid, g.centroid);
        const dx = (f.orthoSMin + dot(dc, g.axisS) - g.orthoSMin) / g.pixel, dy = (g.orthoTMax - (f.orthoTMax + dot(dc, g.axisT))) / g.pixel;
        const cmp = compareOrthos(a, b, Math.round(dx), Math.round(dy));
        metrics.coverageDiff = Math.round(cmp.coverageDiff * 100000) / 100000;
        metrics.colourMean = Math.round(cmp.colourMean * 100) / 100;
        metrics.shiftPx = [Math.round(dx * 100) / 100, Math.round(dy * 100) / 100];
        if (cmp.coverageDiff > P.coverageDiff) { undecided.push({ g, reason: `its photo covers other texels than the first pass's (${Math.round(cmp.coverageDiff * 1000) / 10}% of them)`, metrics }); continue; }
        if (cmp.colourMean > P.colourMean) { undecided.push({ g, reason: `its photo's colours differ from the first pass's by ${metrics.colourMean} levels on average`, metrics }); continue; }
        claimed.add(f.facadeId);
        kept.push({ votedId: g.facadeId, firstId: f.facadeId, areaM2: Math.round(g.coverage * g.width * g.height * g.pixel * g.pixel), metrics });
    }
    // a changed facade keeps its id unless the first pass gave it to any facade (whose reading, brief family and records
    // name it): then the next id free in both sets
    const taken = new Set(first.map(f => f.facadeId));
    let next = Math.max(-1, ...first.map(f => f.facadeId), ...voted.map(f => f.facadeId)) + 1;
    const changed: FacadeReusePlan['changed'] = undecided.sort((x, y) => x.g.facadeId - y.g.facadeId).map(({ g, reason, metrics }) => {
        let id = g.facadeId;
        if (taken.has(id)) id = next++;
        taken.add(id);
        return { votedId: g.facadeId, id, areaM2: Math.round(g.coverage * g.width * g.height * g.pixel * g.pixel), reason, metrics };
    });
    kept.sort((x, y) => x.firstId - y.firstId);
    return { version: FACADE_REUSE_VERSION, params: P, kept, changed, keptAreaM2: kept.reduce((s, k) => s + k.areaM2, 0), changedAreaM2: changed.reduce((s, c) => s + c.areaM2, 0) };
}

/** The plan's identity: the facades kept (as first, voted pairs) and the ids the changed ones take. */
export function facadeReuseKey(plan: FacadeReusePlan): string {
    return crypto.createHash('sha256').update(JSON.stringify({ v: plan.version, p: plan.params, kept: plan.kept.map(k => [k.firstId, k.votedId]), changed: plan.changed.map(c => [c.votedId, c.id]) })).digest('hex').slice(0, 16);
}

function linkOrCopy(from: string, to: string): void {
    try { fs.linkSync(from, to); } catch { fs.copyFileSync(from, to); }
}

/**
 * The voted remesh's orthos with the kept facades put back as the first pass's (their frame and photo, under their id) and
 * the changed ones under the plan's ids: a directory beside the voted orthos, named by both passes and the plan, which the
 * straightening reads in place of tile_refine's own. Largest facade first, as tile_refine lists them.
 */
export function composeReusedOrthos(firstDir: string, votedDir: string, plan: FacadeReusePlan): string {
    const key = crypto.createHash('sha256').update(`${path.basename(path.dirname(firstDir))}/${path.basename(firstDir)}\0${facadeReuseKey(plan)}`).digest('hex').slice(0, 16);
    const out = `${votedDir}_reuse_${key}`;
    if (fs.existsSync(path.join(out, 'facades.json'))) return out;
    const first = readFacades(firstDir), voted = readFacades(votedDir);
    const tmp = `${out}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    fs.mkdirSync(tmp, { recursive: true });
    try {
        const facades: ReliefFacade[] = [];
        const images = new Set<string>();
        const put = (f: ReliefFacade, fromDir: string, src: ReliefFacade) => {
            if (images.has(f.image)) throw new Error(`facade reuse: two facades would be written as ${f.image}`);
            images.add(f.image);
            linkOrCopy(path.join(fromDir, src.image), path.join(tmp, f.image));
            if (src.occludedMask && fs.existsSync(path.join(fromDir, src.occludedMask))) linkOrCopy(path.join(fromDir, src.occludedMask), path.join(tmp, f.occludedMask!));
            facades.push(f);
        };
        for (const k of plan.kept) { const f = first.find(x => x.facadeId === k.firstId)!; put(f, firstDir, f); }
        for (const c of plan.changed) {
            const g = voted.find(x => x.facadeId === c.votedId)!;
            const image = c.id === g.facadeId ? g.image : `facade_${c.id}.png`;
            put({ ...g, facadeId: c.id, image, ...(g.occludedMask ? { occludedMask: occludedMaskName(image) } : {}) }, votedDir, g);
        }
        facades.sort((a, b) => (b as ReliefFacade & { area_m2?: number }).area_m2! - (a as ReliefFacade & { area_m2?: number }).area_m2! || a.facadeId - b.facadeId);
        const schema = (JSON.parse(fs.readFileSync(path.join(votedDir, 'facades.json'), 'utf8')) as { schema?: string }).schema;
        fs.writeFileSync(path.join(tmp, 'reuse.json'), JSON.stringify({ first: firstDir, voted: votedDir, plan }, null, 1));
        fs.writeFileSync(path.join(tmp, 'facades.json'), JSON.stringify({ ...(schema ? { schema } : {}), facades }));
        fs.rmSync(out, { recursive: true, force: true });
        fs.renameSync(tmp, out);
    } catch (err) {
        fs.rmSync(tmp, { recursive: true, force: true });
        if (fs.existsSync(path.join(out, 'facades.json'))) return out;
        throw err;
    }
    return out;
}
