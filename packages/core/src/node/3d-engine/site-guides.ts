/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Pipeline K's facade photos of a site's building, handed to a procedural script as guides (sb.site_guides): each
 * facade's rectified ortho (the scan's photo straightened onto the facade's fitted plane, about 8 cm a pixel), its
 * original before straightening, its uncovered mask, its plane and its bay and storey pitch, with the plane carried into
 * the script's frame (sb.site_tiers': x east, z south, y up from the street). The script registers its own facades to the
 * photos, reads colours per part from them, and the weathering bake reads the photos' repeat residual as stain.
 *
 * The photos themselves are read from K's finished model (its rebuilt facades carrying the straightened, de-lit and
 * harmonised photos), seen straight on by the engine; the orthos are the fallback when the model is not found.
 *
 * Nothing is run here: the guides are the newest pipeline K run at the place (the 3D Building for the same building), read
 * from the staged cache. Without one the script is told why, and the bake falls back to the tile photos.
 */

import * as fs from 'fs';
import * as path from 'path';
import { stagedWorkspaceRoot } from './staged-location/stage-cache';

export interface SiteGuideFacade {
    id: number;
    /** The straightened ortho (colours, registration), the original ortho (stains) and the uncovered mask, absolute. */
    image: string;
    original?: string;
    uncovered?: string;
    /** The facade's plane in the script's frame: s along axisS, t along axisT, both from centroid. */
    centroid: [number, number, number];
    normal: [number, number, number];
    axisS: [number, number, number];
    axisT: [number, number, number];
    sMin: number; sMax: number; tMin: number; tMax: number;
    /** Ortho pixels: x = (s - orthoSMin) / pixel, y = (orthoTMax - t) / pixel. */
    pixel: number; width: number; height: number; orthoSMin: number; orthoTMax: number;
    coverage: number;
    /** The facade's bay pitch and storey height as K measured them (m), when it did. */
    periodM?: number;
    storeyM?: number;
}

export interface SiteGuides {
    source: string;
    runId: string;
    orthosDir: string;
    /** K's finished model (absolute), and the column-major matrix taking it into the script's frame (street at y = 0). */
    model?: string;
    modelMatrix?: number[];
    facades: SiteGuideFacade[];
}

type Mat4 = number[];   // column-major, as glTF localToEcef

/** The JSON chunk of a GLB, read without loading its binary chunk. */
function glbJson(file: string): any {
    const fd = fs.openSync(file, 'r');
    try {
        const head = Buffer.alloc(20);
        fs.readSync(fd, head, 0, 20, 0);
        const len = head.readUInt32LE(12);
        const json = Buffer.alloc(len);
        fs.readSync(fd, json, 0, len, 20);
        return JSON.parse(json.toString('utf8'));
    } finally {
        fs.closeSync(fd);
    }
}

function mul(a: Mat4, b: Mat4): Mat4 {
    const o = new Array(16).fill(0);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
    return o;
}

/** Inverse of a rigid transform (rotation and translation), column-major. */
function invRigid(m: Mat4): Mat4 {
    const o = new Array(16).fill(0);
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) o[c * 4 + r] = m[r * 4 + c];
    for (let r = 0; r < 3; r++) o[12 + r] = -(o[r] * m[12] + o[4 + r] * m[13] + o[8 + r] * m[14]);
    o[15] = 1;
    return o;
}

const apply = (m: Mat4, p: number[], w: number): [number, number, number] =>
    [0, 1, 2].map(r => m[r] * p[0] + m[4 + r] * p[1] + m[8 + r] * p[2] + w * m[12 + r]) as [number, number, number];

/**
 * The finished model of a pipeline K run: the path the run noted (pipeline_k_model.json), else, for runs from before that
 * note, the textures cache entry whose harmonise report is the one the run noted (pipeline_k_texture.json).
 */
function kModel(runDir: string, cache: string): string | undefined {
    const note = path.join(runDir, 'pipeline_k_model.json');
    if (fs.existsSync(note)) {
        const m = JSON.parse(fs.readFileSync(note, 'utf8')).model;
        if (m && fs.existsSync(m)) return m;
    }
    const texNote = path.join(runDir, 'pipeline_k_texture.json');
    const texDir = path.join(cache, 'staged_location', 'textures');
    if (!fs.existsSync(texNote) || !fs.existsSync(texDir)) return undefined;
    const want = JSON.parse(fs.readFileSync(texNote, 'utf8'));
    for (const key of fs.readdirSync(texDir)) {
        const done = path.join(texDir, key, 'done.json'), glb = path.join(texDir, key, 'twin.glb');
        if (!fs.existsSync(done) || !fs.existsSync(glb)) continue;
        const h = JSON.parse(fs.readFileSync(done, 'utf8'))?.value?.harmonize;
        if (h && h.samples === want.samples && h.images === want.images && h.groups === want.groups && h.why === want.why) return glb;
    }
    return undefined;
}

function distanceM(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
    const k = Math.PI / 180, x = (b.lng - a.lng) * k * Math.cos(((a.lat + b.lat) / 2) * k), y = (b.lat - a.lat) * k;
    return Math.hypot(x, y) * 6371008.8;
}

/**
 * The newest pipeline K guides within `radiusM` of the place, in the frame of the photo-textured GLB the site scan uses
 * (`frameGlb`, whose street lies at `groundY`). Returns the reason instead when there are none.
 */
export function findSiteGuides(place: { lat: number; lng: number }, frameGlb: string, groundY: number, radiusM = 60): SiteGuides | { reason: string } {
    const cache = path.join(stagedWorkspaceRoot(), '.scratchbox', 'cache');
    const runsDir = path.join(cache, 'staged_location', 'runs');
    if (!fs.existsSync(runsDir)) return { reason: 'no staged runs in the cache' };
    const runs = fs.readdirSync(runsDir)
        .map(id => ({ id, k: path.join(runsDir, id, 'pipeline_k.json'), stages: path.join(runsDir, id, 'stages.json') }))
        .filter(r => fs.existsSync(r.k) && fs.existsSync(r.stages))
        .sort((a, b) => fs.statSync(b.k).mtimeMs - fs.statSync(a.k).mtimeMs);
    // the newest run with a finished model; a run still going (orthos, no model yet) only when none has one
    let fallback: SiteGuides | undefined;
    for (const run of runs) {
        const stages = JSON.parse(fs.readFileSync(run.stages, 'utf8'));
        if (!stages.place || distanceM(place, stages.place) > radiusM) continue;
        const k = JSON.parse(fs.readFileSync(run.k, 'utf8'));
        const facadesFile = path.join(k.orthosDir ?? '', 'facades.json');
        if (!k.orthosDir || !fs.existsSync(facadesFile)) continue;
        // K's frame is its scan's: the tile_refine input named in the folder above the orthos
        const refineDir = path.dirname(k.orthosDir);
        const done = path.join(refineDir, 'done.json');
        const input = fs.existsSync(done) ? JSON.parse(fs.readFileSync(done, 'utf8')).input : undefined;
        if (!input || !fs.existsSync(input)) continue;
        const kFrame: Mat4 | undefined = glbJson(input)?.extras?.localToEcef;
        const ourFrame: Mat4 | undefined = glbJson(frameGlb)?.extras?.localToEcef;
        if (!kFrame || !ourFrame) return { reason: 'a GLB carries no localToEcef, so the frames cannot be related' };
        const toOurs = mul(invRigid(ourFrame), kFrame);
        const reports = new Map<number, any>((k.reports ?? []).map((r: any) => [r.facadeId, r.report]));
        const doc = JSON.parse(fs.readFileSync(facadesFile, 'utf8'));
        const originals = path.join(refineDir, 'relief_orthos');
        const facades: SiteGuideFacade[] = (doc.facades ?? []).map((f: any) => {
            const c = apply(toOurs, f.centroid, 1);
            c[1] -= groundY;
            const rep = reports.get(f.facadeId);
            const original = path.join(originals, f.image);
            const uncovered = f.uncoveredMask ? path.join(k.orthosDir, f.uncoveredMask) : undefined;
            return {
                id: f.facadeId, image: path.join(k.orthosDir, f.image),
                ...(fs.existsSync(original) ? { original } : {}),
                ...(uncovered && fs.existsSync(uncovered) ? { uncovered } : {}),
                centroid: c, normal: apply(toOurs, f.normal, 0), axisS: apply(toOurs, f.axisS, 0), axisT: apply(toOurs, f.axisT, 0),
                sMin: f.sMin, sMax: f.sMax, tMin: f.tMin, tMax: f.tMax,
                pixel: f.pixel, width: f.width, height: f.height, orthoSMin: f.orthoSMin, orthoTMax: f.orthoTMax,
                coverage: f.coverage ?? 0,
                ...(rep?.periodM ? { periodM: rep.periodM } : {}),
                ...(rep?.holes?.storeyPx ? { storeyM: rep.holes.storeyPx * f.pixel } : {})
            };
        }).filter((f: SiteGuideFacade) => fs.existsSync(f.image));
        const model = kModel(path.dirname(run.k), cache);
        const modelMatrix = toOurs.slice();
        modelMatrix[13] -= groundY;
        const out: SiteGuides = {
            source: model
                ? `pipeline K run ${run.id} (${k.version}): its finished model, seen straight on at ${facades.length} facades (straightened, de-lit and harmonised photos)`
                : `pipeline K run ${run.id} (${k.version}): ${facades.length} rectified facade photos of the scan (its finished model was not found)`,
            runId: run.id, orthosDir: k.orthosDir, ...(model ? { model, modelMatrix } : {}), facades
        };
        if (model) return out;
        fallback ??= out;
    }
    return fallback ?? { reason: `no pipeline K run within ${radiusM} m of the place: run the 3D Building for it first` };
}
