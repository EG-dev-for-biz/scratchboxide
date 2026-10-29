/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Texture swatches of a building from a survey of its 3D tiles: the material harvester (StreetViewMaterialHarvester)
 * fed with survey station views instead of Street View frames. Station poses are the render cameras, so they are exact
 * and the harvester's rectification never guesses a pose.
 *   1. The subject: the scan's hero footprint (findHeroFootprint): centroid, ground, facade orientation, height, cells.
 *   2. Stations: each of the four facade normals square-on and +-TEXTURE_STATION_SPREAD_DEG off it, at street and mid
 *      height, then TEXTURE_AERIALS framed aerials. A station mostly closer than BLOCKED_M to geometry is dropped.
 *   3. Each station is path-traced (albedo) and, when a Beautify service is given, run through AI Beautify; the image's
 *      pose is the Beautify QC-aligned station.
 *   4. The harvester proposes, rectifies and turns swatches into PBR maps; a swatch whose centre lies off the subject's
 *      footprint (a neighbour's wall, the street) is dropped unless `subjectOnly` is false.
 * Every swatch is labelled 'generated' (from a render or a Beautify image of the tiles), never measured.
 */

import * as fs from 'fs';
import * as path from 'path';
import { stationFromLookAt } from '../../common/spatial/SurveySynthesisEngine';
import type { ColmapCameraPose, GeodeticAnchor } from '../../common/spatial/colmap-vector-reference-types';
import { SurveyStationRenderService } from './SurveyStationRenderService';
import { harvestStreetViewMaterials, type HarvestFrameInput, type MaterialSegmenter } from './StreetViewMaterialHarvester';
import { loadTexturedScene, type FrameCamera } from './StreetViewPoseRegistrar';
import { buildGroundModel, findHeroFootprint, loadScanMesh, type GroundModel, type HeroModel } from './StreetViewSurveyPlanner';
import { decodePng, encodePng } from '../texture-processing';

export const TEXTURE_STATION_SPREAD_DEG = 25;
export const TEXTURE_STATION_STANDOFF_M = 22;
export const TEXTURE_AERIALS = 4;
export const TEXTURE_AERIAL_ELEVATION_DEG = 35;
export const TEXTURE_STATION_OPTICS = { focalLengthMm: 35, sensorWidthMm: 36, aspectRatio: 16 / 9 };
export const TEXTURE_STATION_SIZE: [number, number] = [1600, 900];
/** A station with more than BLOCKED_SHARE of its frame closer than BLOCKED_M sits inside or against a neighbour. */
export const BLOCKED_M = 3;
export const BLOCKED_SHARE = 0.3;
/** A swatch belongs to the subject when its centre's plan cell is in the hero footprint, or this close to it. */
export const SUBJECT_MARGIN_M = 2;

export type V3 = [number, number, number];
export interface TextureStationPlan { key: string; eye: V3; target: V3 }

/**
 * How far the footprint reaches from its centroid along a plan direction (radians, x towards z): the last footprint cell
 * met marching out from the centroid. A station stands TEXTURE_STATION_STANDOFF_M beyond it, outside the wall, whatever
 * the building's size (from the centroid, a large footprint put the cameras inside the building).
 */
export function footprintReach(hero: Pick<HeroModel, 'centroid' | 'footprint'>, ground: Pick<GroundModel, 'cellIndex' | 'cellMeters'>, maxMeters = 600): (angle: number) => number {
    return angle => {
        const dx = Math.cos(angle), dz = Math.sin(angle), step = ground.cellMeters / 2;
        let last = 0;
        for (let t = 0; t <= maxMeters; t += step) {
            const i = ground.cellIndex(hero.centroid.x + dx * t, hero.centroid.z + dz * t);
            if (i >= 0 && hero.footprint[i]) last = t;
        }
        return last;
    };
}

/** The stations around `hero` (see the module comment); `reach` (footprintReach) puts them outside its walls. */
export function planTextureStations(hero: Pick<HeroModel, 'centroid' | 'groundY' | 'gridYawDeg' | 'heightMeters'>, reach: (angle: number) => number = () => 0): TextureStationPlan[] {
    const c = hero.centroid, gy = hero.groundY, H = Math.max(6, hero.heightMeters), yaw = hero.gridYawDeg * Math.PI / 180;
    const out: TextureStationPlan[] = [];
    let span = 0;
    for (let f = 0; f < 4; f++) for (const off of [-TEXTURE_STATION_SPREAD_DEG, 0, TEXTURE_STATION_SPREAD_DEG]) {
        const a = yaw + f * Math.PI / 2 + off * Math.PI / 180, d = reach(a) + TEXTURE_STATION_STANDOFF_M;
        span = Math.max(span, reach(a));
        for (const [row, eyeY, lookY] of [['street', 2, Math.min(10, H / 3)], ['mid', H / 2, H / 2]] as const) {
            out.push({ key: `f${f}_${off}_${row}`, eye: [c.x + Math.cos(a) * d, gy + eyeY, c.z + Math.sin(a) * d], target: [c.x, gy + lookY, c.z] });
        }
    }
    const o = TEXTURE_STATION_OPTICS;
    const vfov = 2 * Math.atan(o.sensorWidthMm / (2 * o.focalLengthMm) / o.aspectRatio);
    // the aerials frame the whole building: its footprint's span (or, without one, the standoff) and its height
    const R = span > 0 ? 2 * span : TEXTURE_STATION_STANDOFF_M;
    const r = Math.hypot(R, R, H) / 2 * 1.15, dist = r / Math.sin(vfov / 2);
    const el = TEXTURE_AERIAL_ELEVATION_DEG * Math.PI / 180;
    for (let k = 0; k < TEXTURE_AERIALS; k++) {
        const a = yaw + Math.PI / 4 + k * 2 * Math.PI / TEXTURE_AERIALS;
        out.push({ key: `aerial_${k}`, eye: [c.x + Math.cos(a) * Math.cos(el) * dist, gy + H / 2 + Math.sin(el) * dist, c.z + Math.sin(a) * Math.cos(el) * dist], target: [c.x, gy + H / 2, c.z] });
    }
    return out;
}

/** The harvester's camera for a station rendered at w x h (vertical field of view from the station pose). */
export function stationFrameCamera(station: ColmapCameraPose, w: number, h: number): FrameCamera {
    const { pose } = SurveyStationRenderService.stationToCameraPose6DOF(station, w, h);
    const eye: V3 = [pose.x, pose.y, pose.z];
    const fl = Math.hypot(pose.targetX - pose.x, pose.targetY - pose.y, pose.targetZ - pose.z) || 1;
    const fwd: V3 = [(pose.targetX - pose.x) / fl, (pose.targetY - pose.y) / fl, (pose.targetZ - pose.z) / fl];
    const u0 = (pose.up ?? [0, 1, 0]) as V3;
    let right: V3 = [fwd[1] * u0[2] - fwd[2] * u0[1], fwd[2] * u0[0] - fwd[0] * u0[2], fwd[0] * u0[1] - fwd[1] * u0[0]];
    const rl = Math.hypot(...right) || 1;
    right = [right[0] / rl, right[1] / rl, right[2] / rl];
    const up: V3 = [right[1] * fwd[2] - right[2] * fwd[1], right[2] * fwd[0] - right[0] * fwd[2], right[0] * fwd[1] - right[1] * fwd[0]];
    const fy = (h / 2) / Math.tan(pose.fov * Math.PI / 360);
    return { eye, right, up, fwd, fx: fy, fy, cx: w / 2, cy: h / 2, width: w, height: h };
}

/** Whether a world point's plan cell is in the hero footprint, or within SUBJECT_MARGIN_M of it. */
export function onSubject(hero: Pick<HeroModel, 'footprint'>, ground: Pick<GroundModel, 'cellIndex' | 'cellMeters'>, x: number, z: number): boolean {
    const r = Math.ceil(SUBJECT_MARGIN_M / ground.cellMeters);
    for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
        const i = ground.cellIndex(x + dx * ground.cellMeters, z + dz * ground.cellMeters);
        if (i >= 0 && hero.footprint[i]) return true;
    }
    return false;
}

/** The AI Beautify step, as the harvest uses it (BeautifyStationService.beautify). */
export interface StationBeautifier {
    beautify(station: ColmapCameraPose, ctx: { locationName: string; moodPromptContext?: string }, options: { blockoutOverride: unknown; width: number; height: number; maxRerolls: number }): Promise<{ imagePng: Buffer; alignedStation?: ColmapCameraPose }>;
}

export interface SurveySwatchHarvestResult {
    outDir: string;
    libraryPath: string;
    hero: { centroid: { x: number; z: number }; groundY: number; gridYawDeg: number; heightMeters: number; areaM2: number };
    stations: Array<{ key: string; kept: boolean; reason?: string; beautified: boolean }>;
    swatches: Array<{ id: string; label: string; description: string; sizeMeters: { u: number; v: number }; metresPerPixel: { u: number; v: number }; files: Record<string, string>; score: number; onSubject: boolean }>;
    rejected: number;
    droppedOffSubject: number;
}

export async function harvestSurveySwatches(input: {
    tileGlb: string; anchor: GeodeticAnchor; place: string; outDir: string; segmenter: MaterialSegmenter;
    beautifier?: StationBeautifier; subjectOnly?: boolean; log?: (m: string) => void; signal?: AbortSignal;
}): Promise<SurveySwatchHarvestResult> {
    const log = input.log ?? (() => undefined);
    fs.mkdirSync(path.join(input.outDir, 'frames'), { recursive: true });
    const scan = loadScanMesh(input.tileGlb);
    const ground = buildGroundModel(scan);
    const hero = findHeroFootprint(scan, ground);
    log(`subject: ${Math.round(hero.areaM2)} m2 footprint, ${hero.heightMeters.toFixed(1)} m tall, facades at ${hero.gridYawDeg.toFixed(1)} deg`);
    const renderer = new SurveyStationRenderService();
    await renderer.loadMesh(input.tileGlb);
    const [w, h] = TEXTURE_STATION_SIZE;
    const frames: HarvestFrameInput[] = [];
    const stations: SurveySwatchHarvestResult['stations'] = [];
    let id = 1;
    for (const s of planTextureStations(hero, footprintReach(hero, ground))) {
        if (input.signal?.aborted) throw new Error('stopped');
        const station = stationFromLookAt(id++, s.eye, s.target, TEXTURE_STATION_OPTICS, input.anchor, { name: s.key });
        const render = await renderer.renderStation(station, { renderMode: 'albedo', glbPath: input.tileGlb, width: w, height: h, samplesPerPixel: 16 });
        let near = 0;
        for (const z of render.depth) if (z < BLOCKED_M) near++;
        if (near > BLOCKED_SHARE * w * h) { stations.push({ key: s.key, kept: false, reason: 'blocked by nearby geometry', beautified: false }); continue; }
        let rgba = Buffer.from(render.rgba), pose = station, beautified = false;
        if (input.beautifier) {
            try {
                const b = await input.beautifier.beautify(station, { locationName: input.place }, { blockoutOverride: render, width: w, height: h, maxRerolls: 0 });
                const img = decodePng(b.imagePng);
                rgba = Buffer.from(img.width === w && img.height === h ? img.rgba : resizeNearest(img, w, h));
                pose = b.alignedStation ?? station;
                beautified = true;
            } catch (err) {
                stations.push({ key: s.key, kept: false, reason: `AI Beautify failed: ${(err as Error).message.slice(0, 200)}`, beautified: false });
                continue;
            }
        }
        const png = encodePng(w, h, rgba);
        fs.writeFileSync(path.join(input.outDir, 'frames', `${s.key}.png`), png);
        frames.push({ key: s.key, image: png, rgba, width: w, height: h, camera: stationFrameCamera(pose, w, h), poseSource: beautified ? 'survey-station-beautified' : 'survey-station', poseConfidence: beautified ? 0.9 : 1, occluders: [], watermarkBottomPx: 0 });
        stations.push({ key: s.key, kept: true, beautified });
        log(`${s.key}: ${beautified ? 'beautified' : 'rendered'}`);
    }
    if (!frames.length) throw new Error(`no survey station saw the subject (${stations.map(s => `${s.key}: ${s.reason}`).join('; ')})`);
    const { library, libraryPath } = await harvestStreetViewMaterials(frames, {
        outDir: input.outDir, segmenter: input.segmenter, texturedPrims: loadTexturedScene(input.tileGlb), baseGlbPath: path.relative(input.outDir, input.tileGlb),
        groundHeightAt: (x: number, z: number) => ground.groundAt(x, z), log
    });
    const subjectOnly = input.subjectOnly !== false;
    const all = library.samples.map((s: any) => {
        const c = s.source?.centreWorld as V3 | undefined;
        return {
            id: s.id, label: s.label, description: s.description, sizeMeters: s.sizeMeters, metresPerPixel: s.metresPerPixel,
            files: Object.fromEntries(Object.entries(s.files as Record<string, string>).map(([k, v]) => [k, path.join(input.outDir, v)])),
            score: s.quality?.score ?? 0, onSubject: c ? onSubject(hero, ground, c[0], c[2]) : false
        };
    });
    const swatches = subjectOnly ? all.filter(s => s.onSubject) : all;
    return {
        outDir: input.outDir, libraryPath,
        hero: { centroid: hero.centroid, groundY: hero.groundY, gridYawDeg: hero.gridYawDeg, heightMeters: hero.heightMeters, areaM2: hero.areaM2 },
        stations, swatches, rejected: library.rejected.length, droppedOffSubject: all.length - swatches.length
    };
}

function resizeNearest(src: { width: number; height: number; rgba: Uint8Array | Buffer }, w: number, h: number): Uint8Array {
    const o = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = (Math.floor((y + 0.5) * src.height / h) * src.width + Math.floor((x + 0.5) * src.width / w)) * 4;
        o.set(src.rgba.subarray(i, i + 4), (y * w + x) * 4);
    }
    return o;
}
