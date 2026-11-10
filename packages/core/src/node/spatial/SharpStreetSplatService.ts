/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The street level of a street-vantage world, as Gaussian splats predicted from the Street View panoramas themselves
 * (SHARP, tools/depth/sharp_street_worker.py) and scaled onto the scan.
 *
 * Per panorama: four level views a quarter turn apart and one looking straight down, each at its registered camera. SHARP
 * predicts one Gaussian per pixel at its own scale. A level view's reference is the photo's own depth (Depth Anything 3
 * over the panorama's four level views, Da3RigDepthService), brought to metres by one number: the scan's depth where it
 * agrees with the photo's (so a parked car or a tree the scan smeared does not pull the fit), else the eye's height over
 * the ground. One smooth scale-against-depth curve per view then moves SHARP's splats onto that reference, and only the
 * splats within 30 m of the panorama's own eye are kept: beyond that the world's base layer stands. Without Depth
 * Anything 3 (SCRATCHBOX_STREET_SHARP_DEPTH=scan, or its interpreter missing) the scan itself is the reference, fitted
 * only where it agrees with the view's ground, and the report says so.
 *
 * Each view is drawn from the panorama's own full-resolution tiles where they can be read (Map Tiles API, 1536 px a view
 * in place of the Static API's 640; SCRATCHBOX_STREET_SHARP_TILES=0 off), and only where the tile view matches the Static
 * view the registration used.
 *
 * Before SHARP draws a view, the image model removes its vehicles and people (Nano Banana, through the world's station
 * image generator; SCRATCHBOX_STREET_SHARP_CLEAR=0 off): what was parked or walking in one panorama is not in the next,
 * and would otherwise be baked into the street as splats. The edit is `generated`, and is used only where it holds the
 * photograph's framing (edges compared over small shifts); otherwise the photograph is drawn and the view's report says why.
 *
 * Each view is then cleaned, every drop counted in its report: splats hanging between a near and a far surface of the view
 * (the streaks a per-pixel prediction leaves at depth edges), splats well behind the scan, and, in a view under half of
 * which lands on the scan, everything that does not (the view is dropped when little is left); a panorama with fewer than
 * two level views that land on the scan at all is left out. SHARP's splats are kept only up to 7 m over the street: the
 * street and the lowest storeys. Above that the base layer stands, which already holds the registered Street View
 * photographs baked onto the scan (the survey's street stations) and the tile stations for the tops.
 *
 * The panoramas' splats are then merged: what stands in the free space another panorama saw through goes, each panorama
 * keeps only the splats nearer to it on the plan than to any other panorama (hard cells: one source per place and a clean
 * cut between them, since two panoramas' predictions of one place never agree; SCRATCHBOX_STREET_SHARP_CELLS=0 is the
 * older overlap rule, where a 1 m cell several panoramas cover keeps the nearest one's), and the world's base layer is
 * kept where no street splat stands and everywhere above the nearest panorama's street top.
 *
 * SHARP is allowed for this step only (user decision, 2026-11-09; AGENTS.md section 2). Its output is `generated`: the
 * model draws the splats, the scan only sets their scale and place. The weights are under Apple's research-only model
 * licence. The Street View views are sent to the worker inline and never written to disk; only derived data (the scan's
 * depth, the splats) touches it.
 *
 * The interpreter: SCRATCHBOX_SHARP_PYTHON, else ~/.cache/scratchbox-sharp/venv/bin/python (with `sharp`, torch, scipy and
 * PIL importable). The checkpoint: SCRATCHBOX_SHARP_CHECKPOINT, else .model-cache/sharp/sharp_2572gikvuh.pt in the repo,
 * else ~/.cache/scratchbox-sharp/sharp_2572gikvuh.pt. SCRATCHBOX_STREET_SHARP=0 turns the step off. Where either is
 * missing, or the step is off or fails, the world is built without it and the report says why.
 */

import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { getPythonWorkerPool } from '../process/persistent-python-worker';
import { repoPath } from '../process/repo-python';
import { MapsImageryGroundingService } from './MapsImageryGroundingService';
import { frameCamera, loadTexturedScene, renderTexturedView, ZERO_CORRECTION, type FrameCamera } from './StreetViewPoseRegistrar';
import type { StreetPanoPose } from './street-view-stations';
import { Da3RigDepthService, type RigViewImage } from './Da3RigDepthService';
import type { RigDepthView } from './rig-depth-registration';
import { toStationImageAnswer, type StationImageGenerator } from './BeautifyStationService';
import { GoogleMediaCredentialsService } from '../google-media-credentials-service';
import { fetchStreetViewPanoTiles } from './street-view-tiles';

/** Part of the world cache's key: a world built with another version of this step is another world. */
export const SHARP_STREET_VERSION = 6;
export const SHARP_CHECKPOINT_NAME = 'sharp_2572gikvuh.pt';
export const SHARP_LICENCE_NOTE = "SHARP weights: Apple's research-only model licence";
/** A panorama's views: four level, a quarter turn apart, and one straight down. Square, in pixels and degrees. */
export const SHARP_VIEW_SIZE = 640;
export const SHARP_LEVEL_FOV_DEG = 110;
export const SHARP_FLOOR_FOV_DEG = 100;
export const SHARP_LEVEL_HEADINGS_DEG = [0, 90, 180, 270];
/** Street splats kept after the merge (SCRATCHBOX_STREET_SHARP_BUDGET moves it). */
export const SHARP_STREET_BUDGET = 10_000_000;

/** What the image model is asked of each view before SHARP draws it. */
export const SHARP_CLEAR_PROMPT = [
    'Remove every vehicle (cars, taxis, buses, trucks, vans, motorcycles, bicycles, scooters) and every person from this street photograph, with their shadows, however small or far away.',
    'Fill what they hid with the road, crosswalk, kerb, sidewalk and building fronts that continue behind them, in the same light.',
    'Keep every painted road marking exactly as it is: crosswalk stripes, lane lines, arrows, stop lines and lettering stay, and continue under what is removed.',
    'Change nothing else: the same camera, the same framing and crop, the same buildings, signs, trees, poles, scaffolds and street furniture, each exactly where it is.',
    'No new objects, no text, no border, no change of colour, sharpness or exposure.'
].join(' ');
/** The second pass, on an edit the detector still finds a vehicle or a person in. */
export const SHARP_CLEAR_AGAIN_PROMPT = `Some vehicles or people are still in this picture. ${SHARP_CLEAR_PROMPT}`;
/** The side of the views SHARP is given where the panorama's tiles can be read (its own working size). */
export const SHARP_SOURCE_SIZE = 1536;

/** The vision model that looks for leftovers in an edited view. */
export const SHARP_LEFTOVER_MODEL = 'gemini-3.8-flash';

/**
 * How many vehicles and people a vision model still finds in an edited view (the edit, never the photograph), through
 * the same Google credentials the image model uses.
 */
export async function countVehiclesAndPeople(png: Buffer): Promise<number> {
    const client = await new GoogleMediaCredentialsService().createClient();
    const res = await client.models.generateContent({
        model: SHARP_LEFTOVER_MODEL,
        contents: [{ role: 'user', parts: [
            { inlineData: { mimeType: 'image/png', data: png.toString('base64') } },
            { text: 'Count the vehicles (cars, taxis, buses, trucks, vans, motorcycles, bicycles, scooters) and the people actually standing or moving in this street picture, however small. Do not count buildings, signs, or people and vehicles pictured on billboards and posters. Answer with JSON only: {"vehicles": n, "people": n}.' }
        ] }],
        config: { responseMimeType: 'application/json', temperature: 0 }
    });
    const parsed = JSON.parse(res.text ?? '') as { vehicles?: number; people?: number };
    const n = Number(parsed.vehicles ?? 0) + Number(parsed.people ?? 0);
    if (!Number.isFinite(n)) throw new Error('the vision model gave no count');
    return n;
}

export const sharpStreetEnabled = (): boolean => process.env.SCRATCHBOX_STREET_SHARP !== '0';

/** The interpreter and checkpoint the step would use, or why it cannot run. Looks at the disk only; loads nothing. */
export function sharpStreetAvailability(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): { python: string; checkpoint: string } | { reason: string } {
    if (env.SCRATCHBOX_STREET_SHARP === '0') return { reason: 'off (SCRATCHBOX_STREET_SHARP=0)' };
    const python = env.SCRATCHBOX_SHARP_PYTHON || path.join(home, '.cache', 'scratchbox-sharp', 'venv', 'bin', 'python');
    if (!fs.existsSync(python)) return { reason: `SHARP is not installed: no interpreter at ${python} (set SCRATCHBOX_SHARP_PYTHON)` };
    const candidates = env.SCRATCHBOX_SHARP_CHECKPOINT
        ? [env.SCRATCHBOX_SHARP_CHECKPOINT]
        : [repoPath('.model-cache', 'sharp', SHARP_CHECKPOINT_NAME), path.join(home, '.cache', 'scratchbox-sharp', SHARP_CHECKPOINT_NAME)];
    const checkpoint = candidates.find(c => fs.existsSync(c));
    if (!checkpoint) return { reason: `SHARP is not installed: no checkpoint at ${candidates.join(' or ')} (set SCRATCHBOX_SHARP_CHECKPOINT)` };
    return { python, checkpoint };
}

export interface SharpPanoView {
    name: string;
    kind: 'level' | 'floor';
    camera: FrameCamera;
    hfovDeg: number;
    /** The view asked of Street View: compass heading and pitch, degrees. */
    headingDeg: number;
    pitchDeg: number;
}

/** The five views of one panorama at its registered pose (the nominal one when it has none). */
export function sharpPanoViews(pano: StreetPanoPose): SharpPanoView[] {
    const corr = pano.correction ?? ZERO_CORRECTION;
    const n = SHARP_VIEW_SIZE;
    const level = SHARP_LEVEL_HEADINGS_DEG.map(h => ({
        name: `h${h}`, kind: 'level' as const, hfovDeg: SHARP_LEVEL_FOV_DEG, headingDeg: h, pitchDeg: 0,
        camera: frameCamera(pano.eye, h, 0, SHARP_LEVEL_FOV_DEG, n, n, corr, corr.referenceHeadingDeg ?? h)
    }));
    // straight down; a hair short of it keeps the view's right axis defined
    const floor = {
        name: 'floor', kind: 'floor' as const, hfovDeg: SHARP_FLOOR_FOV_DEG, headingDeg: 0, pitchDeg: -90,
        camera: frameCamera(pano.eye, 0, -89.99, SHARP_FLOOR_FOV_DEG, n, n, corr, corr.referenceHeadingDeg ?? 0)
    };
    return [...level, floor];
}

export interface SharpViewReport {
    name: string;
    error?: string;
    predicted?: number; kept?: number;
    /** What the splats were scaled onto: the photo's own depth (Depth Anything 3) or the scan's. */
    reference?: 'photo depth' | 'scan';
    /** Where the metres came from: the scan where it agrees, the eye's height over the ground, or a plain median. */
    scaleSource?: string;
    /** Metres per unit of the photo's depth (photo reference), as the scan and as the ground height give it. */
    scanScale?: number; groundScale?: number;
    /** Share of the scan's samples that agree with the reference (the rest: cars, trees, smeared scan). */
    agreeShare?: number;
    /** Share of the placed splats past the near range, left to the base layer. */
    beyondRangeShare?: number;
    /** Share of the scale field's cells filled directly. */
    cellsFilled?: number;
    /** Share of the predicted splats over no scan (sky, past the scan's edge): dropped. */
    noScanShare?: number;
    /** Scan / SHARP depth before scaling: how far the model's own scale was off, and how unevenly. */
    rawRatioP10?: number; rawRatioMedian?: number; rawRatioP90?: number;
    /** After scaling: the kept splats' distance from the scan along the view, and the share within 10 % of the range. */
    residMedianM?: number; residP90M?: number; within10pct?: number;
    /** The cleanup. The share of the view within 10 % of the scan's depth before it; then the splats it dropped: */
    fitBeforeCleanup?: number;
    /** hanging between a near and a far surface of the view (streaks at depth edges); */
    streaks?: number;
    /** well behind the scan's surface; */
    behindScan?: number;
    /** off the scan, in a view under half of which fits it (only its fitting splats are kept); */
    gated?: number;
    /** above the street top, where the base layer stands. */
    aboveStreet?: number;
    /** Why the street top was not applied, when it was not. */
    streetTop?: string;
    inferS?: number;
    /** Drawn from the photo with its vehicles and people removed by the image model (`generated`); else why not. */
    cleared?: boolean;
    clearedNote?: string;
    /** Edits made (1 or 2), and the vehicles and people the detector still finds in the one used. */
    clearedPasses?: number; clearedLeftover?: number;
    /** Where the view's photograph came from, and at what size. */
    source?: string;
    /** The edit against its photo: edge correlation at no shift, and the shift that matches best, pixels. */
    clearedNcc?: number; clearedShiftPx?: [number, number];
}

export interface SharpPanoReport {
    panoId: string;
    /** How the panorama's pose was registered; 'nominal' is good to about ±2 m and ±2°. */
    method: string;
    splats: number;
    /** The level views' reference depth, and why it is the scan's when it is. */
    depthReference?: 'photo depth' | 'scan';
    depthReferenceReason?: string;
    /** The eye's height over the scan's ground, metres. */
    eyeHeightM?: number;
    /** The height (scan frame) this panorama's splats stop at; above it the base layer stands. */
    streetTopY?: number;
    /** Left out whole: too few of its level views land on the scan. `error` says how few. */
    leftOut?: boolean;
    /** Kept after the merge. */
    merged?: number;
    ms: number;
    views: SharpViewReport[];
    error?: string;
}

export type SharpStreetReport =
    | { ran: false; reason: string; panos?: SharpPanoReport[] }
    | {
        ran: true; model: 'SHARP'; provenance: 'generated'; licence: string; device: string;
        panos: SharpPanoReport[];
        /** Splats predicted over the scan, before the merge. */
        predicted: number;
        /** Dropped: standing in the free space another panorama saw through. */
        inFreeSpace: number;
        /** Each panorama kept only what lies nearer to it than to any other panorama (the default; SCRATCHBOX_STREET_SHARP_CELLS=0 is the overlap rule). */
        hardCells: boolean;
        /** Dropped under hard cells: nearer to another panorama than to its own. */
        outsideCell: number;
        /** Dropped under the overlap rule: a cell another, nearer panorama covers. */
        doubled: number;
        /** Dropped to keep the street within its budget. */
        thinned: number;
        /** Street splats in the world. */
        street: number;
        /** The base layer's splats kept (where no street splat stands) and replaced. */
        baseKept: number; baseReplaced: number;
        /** Of the kept base splats, those kept because they stand above the nearest panorama's street top. */
        baseKeptAboveStreet: number;
        /** The world's splats: street and base together. */
        splats: number;
        ms: number;
    };

export interface SharpStreetRequest {
    /** The scan the panoramas were registered against (x east, y up, z south): its depth sets the splats' scale. */
    glbPath: string;
    panos: StreetPanoPose[];
    /** The world's base layer (32-byte rows), kept where no street splat stands. */
    baseSplatPath?: string;
    /** The merged world. May be `baseSplatPath`: it is written whole, then moved into place. */
    outSplatPath: string;
    /** Holds each panorama's splats until the merge; removed afterwards. */
    workDir: string;
    /**
     * Keep `workDir` after the run, with a copy of the base layer and `job.json` (the scan's path, the panoramas' poses and
     * the merge's inputs): what a re-merge or a refinement trial needs. Derived data only; no photograph is in it.
     */
    keepWorkDir?: boolean;
    /**
     * The image model that removes vehicles and people from each view before SHARP draws it (SCRATCHBOX_STREET_SHARP_CLEAR=0
     * off). The photograph goes to it inline and is never written; a view whose edit moved or re-cropped the framing, or
     * that the model did not answer, is drawn from its photograph, and its report says so.
     */
    clearGenerator?: StationImageGenerator;
    /** How many vehicles and people are left in an edited view (default: countVehiclesAndPeople, a vision model). */
    countLeftovers?: (png: Buffer) => Promise<number>;
    mapsApiKey?: string;
    fetchImpl?: typeof fetch;
    /** The views of one panorama, in memory (default: the Street View Static API). The images are never written. */
    fetchViews?: (pano: StreetPanoPose, views: SharpPanoView[]) => Promise<Buffer[]>;
    budget?: number;
    signal?: AbortSignal;
    onProgress?: (message: string) => void;
    pythonExecutable?: string;
    checkpoint?: string;
    /**
     * The photo's own depth for a panorama's level views (default: Depth Anything 3, unless
     * SCRATCHBOX_STREET_SHARP_DEPTH=scan). `false` uses the scan as the reference.
     */
    photoDepth?: false | ((images: RigViewImage[]) => Promise<RigDepthView[]>);
}

/** The level views' reference depth: the estimator, or the reason there is none. */
function photoDepthEstimator(req: SharpStreetRequest, env: NodeJS.ProcessEnv = process.env): { estimate: (images: RigViewImage[]) => Promise<RigDepthView[]> } | { reason: string } {
    if (req.photoDepth === false) return { reason: 'the request asked for the scan' };
    if (req.photoDepth) return { estimate: req.photoDepth };
    if (env.SCRATCHBOX_STREET_SHARP_DEPTH === 'scan') return { reason: 'SCRATCHBOX_STREET_SHARP_DEPTH=scan' };
    const service = new Da3RigDepthService();
    return { estimate: async images => (await service.estimate(images, { stride: 1, timeoutMs: 300_000 })).views };
}

const lastJsonLine = (stdout: string): string | undefined => stdout.trim().split('\n').filter(l => l.startsWith('{')).pop();

export class SharpStreetSplatService {
    constructor(private readonly workerPath = repoPath('tools', 'depth', 'sharp_street_worker.py')) { }

    private async fetchViews(req: SharpStreetRequest, pano: StreetPanoPose, views: SharpPanoView[]): Promise<Buffer[]> {
        if (req.fetchViews) return req.fetchViews(pano, views);
        const base = { panoId: pano.panoId, size: SHARP_VIEW_SIZE, ...(req.mapsApiKey ? { apiKey: req.mapsApiKey } : {}), ...(req.fetchImpl ? { fetchImpl: req.fetchImpl } : {}) };
        const level = views.filter(v => v.kind === 'level'), floor = views.filter(v => v.kind === 'floor');
        const [a, b] = await Promise.all([
            MapsImageryGroundingService.fetchPanoViewsInMemory({ ...base, headingsDeg: level.map(v => v.headingDeg), fovDegrees: SHARP_LEVEL_FOV_DEG, pitchDeg: 0 }),
            MapsImageryGroundingService.fetchPanoViewsInMemory({ ...base, headingsDeg: floor.map(v => v.headingDeg), fovDegrees: SHARP_FLOOR_FOV_DEG, pitchDeg: -90 })
        ]);
        return [...a.views.map(v => v.image), ...b.views.map(v => v.image)];
    }

    /**
     * The panorama's views drawn from its full-resolution tiles (Map Tiles API), where each holds its Static view's framing.
     * One entry per view: the sharper image, or why the 640 px Static view stands. Nothing is written.
     */
    private async sharperViews(
        req: SharpStreetRequest, pano: StreetPanoPose, views: SharpPanoView[], images: Buffer[], ask: <T>(request: object, timeoutMs: number) => Promise<T>
    ): Promise<Array<{ image?: Buffer; note: string }>> {
        const stand = (why: string) => images.map(() => ({ note: `Static API view, ${SHARP_VIEW_SIZE} px (${why})` }));
        if (req.fetchViews) return stand('the views were supplied');
        if (process.env.SCRATCHBOX_STREET_SHARP_TILES === '0') return stand('SCRATCHBOX_STREET_SHARP_TILES=0');
        try {
            const apiKey = MapsImageryGroundingService.resolveApiKey(req.mapsApiKey);
            // enough of the panorama for a view of SHARP_SOURCE_SIZE across its field of view
            const minWidth = Math.ceil(SHARP_SOURCE_SIZE * 360 / Math.min(SHARP_LEVEL_FOV_DEG, SHARP_FLOOR_FOV_DEG));
            const tiles = await fetchStreetViewPanoTiles({ panoId: pano.panoId, apiKey, minWidth, ...(req.fetchImpl ? { fetchImpl: req.fetchImpl } : {}), ...(req.signal ? { signal: req.signal } : {}) });
            const answer = await ask<{ views: Array<{ jpegBase64: string | null; held: boolean; ncc: number; shiftPx: [number, number] }> }>({
                op: 'tileViews', width: tiles.width, height: tiles.height, tileSize: tiles.tileSize, headingDeg: tiles.headingDeg, tiltDeg: tiles.tiltDeg, rollDeg: tiles.rollDeg,
                size: SHARP_SOURCE_SIZE, tiles: tiles.tiles.map(t => ({ x: t.x, y: t.y, jpegBase64: t.image.toString('base64') })),
                views: views.map((v, k) => ({ headingDeg: v.headingDeg, pitchDeg: v.pitchDeg, hfovDeg: v.hfovDeg, staticBase64: images[k].toString('base64') }))
            }, 300_000);
            return answer.views.map(v => v.held && v.jpegBase64
                ? { image: Buffer.from(v.jpegBase64, 'base64'), note: `Street View tiles, ${SHARP_SOURCE_SIZE} px (matches the Static view, edge correlation ${v.ncc})` }
                : { note: `Static API view, ${SHARP_VIEW_SIZE} px (the tile view did not match it: ${v.shiftPx[0]}, ${v.shiftPx[1]} px off, edge correlation ${v.ncc})` });
        } catch (err) {
            if (req.signal?.aborted) throw err;
            return stand(`the tiles could not be read: ${(err instanceof Error ? err.message : String(err)).split('\n')[0].slice(0, 160)}`);
        }
    }

    /**
     * Each level view with its vehicles and people removed by the image model, where the edit holds the photo's framing.
     * A detector then looks at the edit; one it still finds a vehicle or a person in is edited once more. One entry per
     * view: `image` when an edit is used; `note` says the model, or why the photograph stands.
     */
    private async clearViews(
        req: SharpStreetRequest, views: SharpPanoView[], images: Buffer[], progress: (m: string) => void, ask: <T>(request: object, timeoutMs: number) => Promise<T>
    ): Promise<Array<{ image?: Buffer; note?: string; ncc?: number; shiftPx?: [number, number]; passes?: number; leftover?: number; skipped?: boolean }>> {
        const generator = req.clearGenerator;
        if (!generator || process.env.SCRATCHBOX_STREET_SHARP_CLEAR === '0') return images.map(() => ({ skipped: true }));
        const count = req.countLeftovers ?? countVehiclesAndPeople;
        const mime = (b: Buffer) => (b[0] === 0x89 ? 'image/png' : 'image/jpeg');
        type Check = { held: boolean; ncc: number; shiftPx: [number, number]; square: boolean };
        const edit = async (source: Buffer, prompt: string): Promise<{ png: Buffer; model: string } | { error: string }> => {
            try {
                const out = toStationImageAnswer(await generator.generate({
                    prompt, blockoutPng: Buffer.alloc(0), groundingPhoto: { bytes: source, mimeType: mime(source) },
                    aspectRatio: '1:1', width: SHARP_SOURCE_SIZE, height: SHARP_SOURCE_SIZE, imageSize: '2K', ...(req.signal ? { signal: req.signal } : {})
                }));
                return { png: out.png, model: out.modelUsed ?? generator.name };
            } catch (err) {
                if (req.signal?.aborted) throw err;
                return { error: (err instanceof Error ? err.message : String(err)).split('\n')[0].slice(0, 200) };
            }
        };
        const framing = async (photo: Buffer, edited: Buffer): Promise<Check | undefined> =>
            (await ask<{ pairs: Check[] }>({ op: 'framing', pairs: [{ photoBase64: photo.toString('base64'), editedBase64: edited.toString('base64') }] }, 120_000)).pairs[0];
        const level = views.filter(v => v.kind === 'level').length;
        progress(`removing vehicles and people from ${level} views (${generator.name})`);
        return Promise.all(images.map(async (photo, k) => {
            // a road seen from straight above has too little for the model to hold on to: it redraws it
            if (views[k].kind !== 'level') return { note: 'photograph kept: a straight-down view is not edited (the image model redraws it)' };
            const first = await edit(photo, SHARP_CLEAR_PROMPT);
            if ('error' in first) return { note: `photograph kept: the image model gave no edit (${first.error})` };
            const c1 = await framing(photo, first.png);
            if (!c1) return { note: 'photograph kept: the edit could not be checked' };
            if (!c1.held) return { ncc: c1.ncc, shiftPx: c1.shiftPx, note: `photograph kept: the edit did not hold the framing (${c1.square ? `best match ${c1.shiftPx[0]}, ${c1.shiftPx[1]} px off, edge correlation ${c1.ncc}` : 'not square'})` };
            let used = { png: first.png, check: c1, passes: 1 };
            let leftover = await count(first.png).catch(() => undefined);
            if (leftover) {
                const second = await edit(first.png, SHARP_CLEAR_AGAIN_PROMPT);
                const c2 = 'png' in second ? await framing(photo, second.png) : undefined;
                if ('png' in second && c2?.held) {
                    used = { png: second.png, check: c2, passes: 2 };
                    leftover = await count(second.png).catch(() => undefined);
                }
            }
            return {
                image: used.png, ncc: used.check.ncc, shiftPx: used.check.shiftPx, passes: used.passes, ...(leftover !== undefined ? { leftover } : {}),
                note: `vehicles and people removed by ${first.model} (generated), ${used.passes} pass${used.passes === 1 ? '' : 'es'}; ${leftover === undefined ? 'the result was not checked by the detector' : leftover ? `the detector still finds ${leftover}` : 'the detector finds none left'}`
            };
        }));
    }

    /** The street level from `req.panos`, merged with the base layer into `req.outSplatPath`. Never throws for a step that could not run: the report says why, and the base layer stands untouched. */
    async run(req: SharpStreetRequest): Promise<SharpStreetReport> {
        const t0 = Date.now();
        const progress = req.onProgress ?? (() => undefined);
        const found = req.pythonExecutable && req.checkpoint ? { python: req.pythonExecutable, checkpoint: req.checkpoint } : sharpStreetAvailability();
        if ('reason' in found) return { ran: false, reason: found.reason };
        if (!req.panos.length) return { ran: false, reason: 'no Street View panorama near the vantage' };

        const pool = getPythonWorkerPool({
            pythonBinary: found.python, scriptPath: this.workerPath, label: 'the SHARP street splat worker',
            env: { ...process.env, PYTORCH_ENABLE_MPS_FALLBACK: '1', KMP_DUPLICATE_LIB_OK: 'TRUE' }
        });
        const ask = async <T>(request: object, timeoutMs: number): Promise<T> => {
            const res = await pool.run({ stdin: JSON.stringify(request), timeoutMs });
            const line = lastJsonLine(res.stdout);
            const answer = line ? JSON.parse(line) as T & { error?: string } : undefined;
            if (answer?.error && !('views' in answer)) throw new Error(answer.error);
            if (res.exitCode !== 0) throw new Error(`exit ${res.exitCode}: ${res.stderr.trim().split('\n').slice(-4).join(' | ')}`);
            if (!answer) throw new Error('the worker returned no answer');
            return answer;
        };

        await fs.ensureDir(req.workDir);
        const depthPath = path.join(os.tmpdir(), `sb_sharp_depth_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.f32`);
        const reports: SharpPanoReport[] = [];
        let estimator = photoDepthEstimator(req);
        const done: Array<{ path: string; eye: [number, number, number]; report: SharpPanoReport }> = [];
        let device = '';
        try {
            const scene = loadTexturedScene(req.glbPath);
            for (const [i, pano] of req.panos.entries()) {
                if (req.signal?.aborted) throw req.signal.reason ?? new Error('stopped');
                const tp = Date.now();
                const report: SharpPanoReport = { panoId: pano.panoId, method: pano.method, splats: 0, ms: 0, views: [] };
                reports.push(report);
                progress(`Street splats from panorama ${i + 1} of ${req.panos.length} (SHARP, ${pano.method === 'nominal' ? 'nominal pose' : 'registered'})`);
                try {
                    const views = sharpPanoViews(pano);
                    const images = await this.fetchViews(req, pano, views);
                    if (images.length !== views.length) throw new Error(`Street View returned ${images.length} of ${views.length} views`);
                    const sharper = await this.sharperViews(req, pano, views, images, ask);
                    sharper.forEach((s, k) => { if (s.image) images[k] = s.image; });
                    const cleared = await this.clearViews(req, views, images, m => progress(`Panorama ${i + 1} of ${req.panos.length}: ${m}`), ask);
                    cleared.forEach((c, k) => { if (c.image) images[k] = c.image; });
                    const n = SHARP_VIEW_SIZE;
                    const depth = Buffer.alloc(views.length * n * n * 4);
                    views.forEach((v, k) => {
                        const d = renderTexturedView(scene, v.camera).depth;
                        Buffer.from(d.buffer, d.byteOffset, d.byteLength).copy(depth, k * n * n * 4);
                    });
                    // the photo's own depth for the level views, appended after the scan's
                    const photoDepth = new Map<number, { offset: number; width: number; height: number }>();
                    const blocks: Buffer[] = [depth];
                    if ('estimate' in estimator) {
                        try {
                            const level = views.map((v, k) => ({ v, k })).filter(e => e.v.kind === 'level');
                            const got = await estimator.estimate(level.map(e => ({ panoId: pano.panoId, yawDeg: e.v.headingDeg, image: images[e.k], horizontalFovDeg: e.v.hfovDeg })));
                            if (got.length !== level.length) throw new Error(`${got.length} of ${level.length} depth maps`);
                            let offset = views.length * n * n;
                            level.forEach((e, j) => {
                                const g = got[j];
                                if (g.depth.length !== g.width * g.height) throw new Error('a depth map of the wrong size');
                                photoDepth.set(e.k, { offset, width: g.width, height: g.height });
                                blocks.push(Buffer.from(g.depth.buffer, g.depth.byteOffset, g.depth.byteLength));
                                offset += g.depth.length;
                            });
                            report.depthReference = 'photo depth';
                        } catch (err) {
                            if (req.signal?.aborted) throw err;
                            // no photo depth on this machine: every later panorama would fail the same way, so ask once
                            photoDepth.clear();
                            blocks.length = 1;
                            estimator = { reason: `Depth Anything 3 could not run: ${(err instanceof Error ? err.message : String(err)).split('\n')[0].slice(0, 240)}` };
                        }
                    }
                    if ('reason' in estimator) { report.depthReference = 'scan'; report.depthReferenceReason = estimator.reason; }
                    await fs.writeFile(depthPath, Buffer.concat(blocks));
                    const outPath = path.join(req.workDir, `pano_${i}.splat`);
                    const request = {
                        op: 'pano', checkpoint: found.checkpoint, outPath, depthPath,
                        views: views.map((v, k) => ({
                            name: v.name, kind: v.kind, jpegBase64: images[k].toString('base64'), size: n, focalPx: v.camera.fx, hfovDeg: v.hfovDeg,
                            eye: v.camera.eye, right: v.camera.right, up: v.camera.up, fwd: v.camera.fwd, depthOffset: k * n * n,
                            ...(photoDepth.has(k) ? { photoDepth: photoDepth.get(k) } : {})
                        }))
                    };
                    type PanoAnswer = { error?: string; leftOut?: boolean; device?: string; splats?: number; eyeHeightM?: number; streetTopY?: number; views: SharpViewReport[] };
                    let answer: PanoAnswer;
                    try {
                        answer = await ask<PanoAnswer>(request, 600_000);
                    } catch (first) {
                        // the Metal backend fails now and then on a first allocation; once more before giving up on the panorama
                        if (req.signal?.aborted) throw first;
                        answer = await ask<PanoAnswer>(request, 600_000);
                    }
                    report.views = answer.views ?? [];
                    report.views.forEach(vr => {
                        const at = views.findIndex(v => v.name === vr.name);
                        if (sharper[at]) vr.source = sharper[at].note;
                        const c = cleared[at];
                        if (!c || c.skipped) return;
                        if (c.passes) vr.clearedPasses = c.passes;
                        if (c.leftover !== undefined) vr.clearedLeftover = c.leftover;
                        vr.cleared = !!c.image;
                        if (c.note) vr.clearedNote = c.note;
                        if (c.ncc !== undefined) vr.clearedNcc = c.ncc;
                        if (c.shiftPx) vr.clearedShiftPx = c.shiftPx;
                    });
                    if (answer.eyeHeightM) report.eyeHeightM = answer.eyeHeightM;
                    if (answer.streetTopY !== undefined) report.streetTopY = answer.streetTopY;
                    if (answer.leftOut) report.leftOut = true;
                    if (answer.error || !answer.splats) throw new Error(answer.error ?? 'no splats');
                    report.splats = answer.splats;
                    device = answer.device ?? device;
                    done.push({ path: outPath, eye: views[0].camera.eye as [number, number, number], report });
                } catch (err) {
                    if (req.signal?.aborted) throw err;
                    report.error = err instanceof Error ? err.message : String(err);
                } finally {
                    report.ms = Date.now() - tp;
                }
            }
            if (!done.length) return { ran: false, reason: `SHARP made no street splats: ${reports.map(r => r.error).filter(Boolean)[0] ?? 'no panorama could be scaled onto the scan'}`, panos: reports };

            progress(`Merging the street splats of ${done.length} panorama${done.length === 1 ? '' : 's'} with the world's base layer`);
            const budget = req.budget ?? (Number(process.env.SCRATCHBOX_STREET_SHARP_BUDGET) || SHARP_STREET_BUDGET);
            const mergedPath = `${req.outSplatPath}.sharp_merge`;
            const hardCells = process.env.SCRATCHBOX_STREET_SHARP_CELLS !== '0';
            type MergeAnswer = { predicted: number; inFreeSpace: number; outsideCell?: number; doubled: number; thinned: number; street: number; perPano: number[]; baseKept?: number; baseReplaced?: number; baseKeptAboveStreet?: number; splats: number };
            let merged: MergeAnswer;
            const mergeJob = {
                op: 'merge', inputs: done.map(d => ({ path: d.path, eye: d.eye, ...(d.report.streetTopY !== undefined ? { streetTopY: d.report.streetTopY } : {}) })),
                basePath: req.baseSplatPath && fs.existsSync(req.baseSplatPath) ? req.baseSplatPath : null, outPath: mergedPath, budget, cells: hardCells
            };
            if (req.keepWorkDir) {
                const keptBase = mergeJob.basePath ? path.join(req.workDir, 'base.splat') : null;
                if (keptBase && mergeJob.basePath) await fs.copy(mergeJob.basePath, keptBase);
                await fs.writeJson(path.join(req.workDir, 'job.json'), {
                    glbPath: req.glbPath, panos: req.panos, used: done.map(d => d.report.panoId), merge: { ...mergeJob, basePath: keptBase, outPath: path.join(req.workDir, 'merged.splat') }
                }, { spaces: 1 });
            }
            try {
                merged = await ask<MergeAnswer>(mergeJob, 900_000);
                await fs.move(mergedPath, req.outSplatPath, { overwrite: true });
            } catch (err) {
                if (req.signal?.aborted) throw err;
                return { ran: false, reason: `the street splats could not be merged: ${err instanceof Error ? err.message : String(err)}`, panos: reports };
            } finally {
                await fs.remove(mergedPath).catch(() => undefined);
            }
            done.forEach((d, k) => { d.report.merged = merged.perPano[k] ?? 0; });
            return {
                ran: true, model: 'SHARP', provenance: 'generated', licence: SHARP_LICENCE_NOTE, device, panos: reports,
                predicted: merged.predicted, inFreeSpace: merged.inFreeSpace, hardCells, outsideCell: merged.outsideCell ?? 0, doubled: merged.doubled, thinned: merged.thinned, street: merged.street,
                baseKept: merged.baseKept ?? 0, baseReplaced: merged.baseReplaced ?? 0, baseKeptAboveStreet: merged.baseKeptAboveStreet ?? 0, splats: merged.splats, ms: Date.now() - t0
            };
        } catch (err) {
            if (req.signal?.aborted) throw err;
            return { ran: false, reason: `the SHARP street step failed: ${err instanceof Error ? err.message : String(err)}`, panos: reports };
        } finally {
            await fs.remove(depthPath).catch(() => undefined);
            if (!req.keepWorkDir) await fs.remove(req.workDir).catch(() => undefined);
        }
    }
}
