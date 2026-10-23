/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Pipeline G, step 2: the survey's pictures as metric wall plates. Each station is path-traced from the photo tile with its
 * metric depth (SurveyStationRenderService, albedo); every pixel is a known point, and a point within the slab of a surveyed
 * face lands on that face's plate at PLATE_PIXEL_M in its (s, t), with how far it stands proud of the plane (relief). Where
 * several stations see a texel, the most square-on and nearest wins. A plate is an elevation in metres: no perspective is left
 * for the reading to undo.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { ColmapCameraPose } from '../../../../common/spatial/colmap-vector-reference-types';
import { SurveyStationRenderService } from '../../../spatial/SurveyStationRenderService';
import type { MassingFace } from '../pipeline-e/native-massing';
import { encodePng } from '../png-encode';
import { eachPoint, onFace, type V3 } from './stations';

export const PLATE_PIXEL_M = 0.05;
export const STATION_WIDTH = 1280;
export const STATION_HEIGHT = 720;
export const STATION_SAMPLES = 4;
/** A ray under this cosine to the face normal is too oblique to texture it. */
export const MIN_INCIDENCE_COS = 0.25;

export interface Plate {
    face: number;
    key: string;
    w: number; h: number;
    widthM: number; heightM: number;
    /** RGB, row 0 at the top (tMax); unseen texels mid-grey. */
    rgb: Uint8Array;
    /** Signed offset from the face plane per texel, NaN where unseen. */
    relief: Float32Array;
    coverage: number;
    stations: number[];
}

/** An empty plate for face `f`. */
export function emptyPlate(face: number, f: MassingFace): Plate & { score: Float32Array } {
    const w = Math.ceil((f.sMax - f.sMin) / PLATE_PIXEL_M), h = Math.ceil((f.tMax - f.tMin) / PLATE_PIXEL_M);
    return { face, key: f.key, w, h, widthM: f.sMax - f.sMin, heightM: f.tMax - f.tMin, rgb: new Uint8Array(w * h * 3).fill(128), relief: new Float32Array(w * h).fill(NaN), score: new Float32Array(w * h), coverage: 0, stations: [] };
}

/** Lays one rendered station (RGBA + camera-z depth) onto the plates of `faces`. Returns the texels it laid per plate. */
export function layStation(view: { rgba: Uint8Array | Buffer; depth: Float32Array; cameraPose: Parameters<typeof eachPoint>[0]['cameraPose']; intrinsics: { verticalFovDegrees: number }; width: number; height: number }, stationId: number, plates: Array<Plate & { score: Float32Array }>, faces: MassingFace[]): number[] {
    const hits = plates.map(() => 0);
    eachPoint(view, view.width, view.height, (i, p, ray, range) => {
        plates.forEach((pl, k) => {
            const f = faces[pl.face];
            const at = onFace(f, p);
            if (!at) return;
            const cos = -(ray[0] * f.normal[0] + ray[1] * f.normal[1] + ray[2] * f.normal[2]);
            if (cos < MIN_INCIDENCE_COS) return;
            const score = cos / (1 + range / 30);
            const j = Math.min(pl.h - 1, Math.floor((f.tMax - at.t) / PLATE_PIXEL_M)) * pl.w + Math.min(pl.w - 1, Math.floor((at.s - f.sMin) / PLATE_PIXEL_M));
            hits[k]++;
            if (score <= pl.score[j]) return;
            pl.score[j] = score;
            pl.relief[j] = at.off;
            pl.rgb[j * 3] = view.rgba[i * 4]; pl.rgb[j * 3 + 1] = view.rgba[i * 4 + 1]; pl.rgb[j * 3 + 2] = view.rgba[i * 4 + 2];
            if (!pl.stations.includes(stationId)) pl.stations.push(stationId);
        });
    });
    return hits;
}

/** Finishes a plate: its coverage. */
export function finishPlate(pl: Plate & { score: Float32Array }): Plate {
    let cov = 0;
    for (let j = 0; j < pl.w * pl.h; j++) if (pl.score[j] > 0) cov++;
    const { score: _score, ...plate } = pl;
    return { ...plate, coverage: cov / (pl.w * pl.h) };
}

/** Renders every station from the photo tile and lays it onto the plates of `faceIdx`. */
/** `keepRendersDir`: each station's render is also written there as station_<id>.png (the building brief's survey photographs). */
export async function surveyPlates(opts: { stations: Array<{ station: ColmapCameraPose }>; faces: MassingFace[]; faceIdx: number[]; tileGlb: string; signal?: AbortSignal; onProgress?: (m: string) => void; keepRendersDir?: string }): Promise<{ plates: Plate[]; laid: Array<{ station: number; texels: number[] }>; renders: Array<{ station: number; file: string }> }> {
    const plates = opts.faceIdx.map(i => emptyPlate(i, opts.faces[i]));
    const renderer = new SurveyStationRenderService();
    const laid: Array<{ station: number; texels: number[] }> = [];
    const renders: Array<{ station: number; file: string }> = [];
    if (opts.keepRendersDir) fs.mkdirSync(opts.keepRendersDir, { recursive: true });
    for (const [n, { station }] of opts.stations.entries()) {
        if (opts.signal?.aborted) throw new DOMException('aborted', 'AbortError');
        // no workDir: the renderer makes its own and removes it after reading the image and depth back (a given one is kept)
        const r = await renderer.renderStation(station, { renderMode: 'albedo', glbPath: opts.tileGlb, width: STATION_WIDTH, height: STATION_HEIGHT, samplesPerPixel: STATION_SAMPLES });
        if (opts.keepRendersDir) {
            const file = path.join(opts.keepRendersDir, `station_${station.id}.png`);
            fs.writeFileSync(file, encodePng(r.width, r.height, Buffer.from(r.rgba), 4));
            renders.push({ station: station.id, file });
        }
        laid.push({ station: station.id, texels: layStation({ rgba: r.rgba, depth: r.depth, cameraPose: r.cameraPose as never, intrinsics: r.intrinsics, width: r.width, height: r.height }, station.id, plates, opts.faces) });
        opts.onProgress?.(`pipeline G: station ${n + 1} of ${opts.stations.length} laid on the wall plates`);
    }
    return { plates: plates.map(finishPlate), laid, renders };
}

/** The plate as a PNG, metre ticks on all four edges (every 1 m, longer every 5 m) so a reader can measure. */
export function platePng(pl: Plate, ruled = true): Buffer {
    const rgb = Uint8Array.from(pl.rgb);
    if (ruled) {
        const step = Math.round(1 / PLATE_PIXEL_M);
        const put = (x: number, y: number) => { if (x >= 0 && y >= 0 && x < pl.w && y < pl.h) rgb.set([255, 0, 255], (y * pl.w + x) * 3); };
        for (let m = 0; m * step <= pl.w; m++) for (let k = 0; k < (m % 5 === 0 ? 30 : 12); k++) { put(m * step, k); put(m * step, pl.h - 1 - k); }
        for (let m = 0; m * step <= pl.h; m++) for (let k = 0; k < (m % 5 === 0 ? 30 : 12); k++) { put(k, pl.h - 1 - m * step); put(pl.w - 1 - k, pl.h - 1 - m * step); }
    }
    return encodePng(pl.w, pl.h, Buffer.from(rgb), 3);
}

/** The relief as a PNG: warm proud of the plane, cool set back (full colour at 1 m), black unseen. */
export function reliefPng(pl: Plate): Buffer {
    const rgb = new Uint8Array(pl.w * pl.h * 3);
    for (let j = 0; j < pl.w * pl.h; j++) {
        const o = pl.relief[j];
        if (Number.isNaN(o)) continue;
        const a = Math.max(-1, Math.min(1, o));
        rgb.set(a >= 0 ? [128 + 127 * a, 128 - 60 * a, 128 - 100 * a] : [128 + 100 * a, 128 + 30 * a, 128 - 127 * a], j * 3);
    }
    return encodePng(pl.w, pl.h, Buffer.from(rgb), 3);
}

export type { V3 };
