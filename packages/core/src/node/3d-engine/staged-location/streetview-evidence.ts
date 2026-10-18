/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Street View close-ups of an isolated structure's facades, as evidence for the facade-detail reading.
 *
 * Only Google captures, through the permitted route:
 * - discovery uses the Street View metadata endpoint with the Maps API key (free), keeps only "© Google" captures, and
 *   caches only pano ids, locations and dates;
 * - images come only from StreetViewGroundingImageService (the Maps Imagery Grounding API, the app's service account);
 * - both credentials are needed; when either is missing the stage says which, and the detail is read from the tile
 *   photos only. No Static API image is ever requested.
 *
 * Inputs come only from the probe (the structure pick, its facade headings, the ground and the unmasked surface model),
 * so this stage starts as soon as the tiles commit.
 *
 * At most MAX_STREET_VIEW_IMAGES_PER_BUILDING images (4): the best pano per facade heading, then the next best by score.
 * The images are kept in memory only, exactly as they arrived (no decode, no re-encode, so their content credentials
 * stay intact): their size is read from the JPEG header and their sha256 over the bytes as sent. Nothing here writes
 * them, logs them, or hands them to a codec.
 */

import { groundingFocalPx } from '../../spatial/StreetViewPoseRegistrar';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { MAX_STREET_VIEW_IMAGES_PER_BUILDING, type Vec3 } from '../../../common/spatial/staged-location-contracts';
import { fetchStreetViewPanoMetadata } from '../../spatial/StreetViewPanoramaProjectionService';
import { groundingPitchForElevation, isGoogleCapture, type GroundingAspectRatio, type GroundingImage, type GroundingImageRequest } from '../../spatial/StreetViewGroundingImageService';
import { geodeticToScan, scanToGeodetic, type GeodeticOrigin, type GroundModel } from '../../spatial/StreetViewSurveyPlanner';
import { readJpegSize } from '../../spatial/StreetViewPoseRegistrar';
import { imageContentSha256 } from '../../image-codec-ffmpeg';
import type { StructurePickResult } from './extraction-sizing';
import { callTimeout } from './call-timer';

const DEG = Math.PI / 180;
/**
 * One image, retries included. The grounding endpoint answers in 0.5-25 s and sometimes with 503 "Deadline expired"
 * (the service retries those twice), so 8 s cut off answers that were coming. The images of a stage are fetched in
 * parallel, so the stage's fetch costs one of these at most.
 */
export const EVIDENCE_IMAGE_TIMEOUT_MS = 30_000;
/** Pano discovery (free metadata queries, 8 at a time) before the fetch; the stage's budget is this plus one image. */
export const EVIDENCE_DISCOVERY_ALLOWANCE_MS = 45_000;
export const EVIDENCE_STAGE_BUDGET_MS = EVIDENCE_DISCOVERY_ALLOWANCE_MS + EVIDENCE_IMAGE_TIMEOUT_MS + 15_000;
/** Panos kept for selection: the nearest to the structure. */
export const MAX_CANDIDATE_PANOS = 90;
export const STREET_VIEW_EYE_HEIGHT_M = 2.5;
/** The nominal pose's stated uncertainty (pano position, car camera height, heading): registration is not run in v1. */
export const NOMINAL_POSE_UNCERTAINTY = { meters: 2, degrees: 2 } as const;

export interface PanoCandidate {
    panoId: string;
    lat: number;
    lng: number;
    date?: string;
    copyright?: string;
    /** Tile frame. */
    x: number;
    z: number;
}

export interface SelectedView {
    panoId: string;
    date?: string;
    copyright?: string;
    /** Nominal eye: the pano position in the tile frame, 2.5 m above the probe ground there. */
    eye: Vec3;
    /** The facade heading (outward, clockwise from north) this view looks at. */
    facadeHeadingDeg: number;
    headingDeg: number;
    /** Elevation of the view axis, degrees, UP POSITIVE (the app's convention). fetchViews converts it to the API's sign. */
    pitchDeg: number;
    fovDeg: number;
    aspectRatio: GroundingAspectRatio;
    distanceM: number;
    score: number;
    /** The fitted slots this view was aimed at (the crop) and those it shows, by projection of their 3D outlines. */
    aimedSlotIds?: string[];
    coveredSlotIds?: string[];
}

export interface EvidenceImage {
    view: SelectedView;
    /** The bytes exactly as the grounding API returned them, in memory only. */
    bytes: Buffer;
    mimeType: string;
    widthPx: number;
    heightPx: number;
    sha256: string;
    /** "sv:<panoId>:<heading>:<pitch>:<fov>". */
    id: string;
    /** distance × fov (rad) / width: the smallest distance one pixel spans on the facade. */
    nativeSampleM: number;
    /** Seconds-level cost: how long this image took to come back, retries included. */
    fetchMs: number;
}

export interface EvidenceRecord {
    reasonCode: string;
    reason: string;
    error?: string;
    transient: boolean;
}

export interface StreetViewEvidenceDeps {
    /** Maps API key for the (free) metadata endpoint. */
    mapsApiKey?: string;
    /** The grounding service on the app's service account; absent when it is not configured. */
    grounding?: { retrieveGroundingImage(req: GroundingImageRequest, signal?: AbortSignal): Promise<GroundingImage> };
    /** Why the grounding service is absent (shown to the user). */
    groundingUnavailable?: string;
    fetchImpl?: typeof fetch;
    /** JSON cache of metadata answers (pano ids, locations, dates only). */
    metadataCachePath?: string;
    /**
     * Panos the grounding API refused ("Pano is not published or eligible", 403) this run, with the error: no later view
     * in the run asks for them again. Kept beside the metadata cache too (REFUSALS_FILE), so discovery leaves them out
     * for REFUSAL_TTL_MS and a nearby eligible pano is not thinned away in their favour.
     */
    refusedPanos?: Map<string, string>;
    now?: () => number;
}

/** Beside the metadata cache: {panoId: {atMs, error}} of the grounding API's refusals. */
export const REFUSALS_FILE = 'grounding_refusals.json';
/** A refusal is trusted this long (a pano's eligibility can change). */
export const REFUSAL_TTL_MS = 30 * 24 * 3600 * 1000;

/** The grounding API refused the pano itself (not a transient failure): another pano must be asked. */
export function isGroundingRefusal(message: string): boolean {
    return /not published or eligible|\b403\b/i.test(message);
}

function refusalsPath(deps: Pick<StreetViewEvidenceDeps, 'metadataCachePath'>): string | undefined {
    return deps.metadataCachePath ? path.join(path.dirname(deps.metadataCachePath), REFUSALS_FILE) : undefined;
}

/** The refusals recorded within REFUSAL_TTL_MS, and this run's. */
export function knownRefusals(deps: Pick<StreetViewEvidenceDeps, 'metadataCachePath' | 'refusedPanos' | 'now'>): Map<string, string> {
    const out = new Map<string, string>();
    const file = refusalsPath(deps);
    if (file && fs.existsSync(file)) {
        try {
            const rec = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, { atMs: number; error: string }>;
            const now = (deps.now ?? Date.now)();
            for (const [id, r] of Object.entries(rec)) if (r && now - r.atMs < REFUSAL_TTL_MS) out.set(id, r.error);
        } catch { /* an unreadable record is ignored; it is rewritten on the next refusal */ }
    }
    for (const [id, e] of deps.refusedPanos ?? []) out.set(id, e);
    return out;
}

/** Records a refusal for the run and on disk. */
export function recordRefusal(deps: StreetViewEvidenceDeps, panoId: string, error: string): void {
    deps.refusedPanos?.set(panoId, error);
    const file = refusalsPath(deps);
    if (!file) return;
    let rec: Record<string, { atMs: number; error: string }> = {};
    try { if (fs.existsSync(file)) rec = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { rec = {}; }
    rec[panoId] = { atMs: (deps.now ?? Date.now)(), error };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(rec));
    fs.renameSync(tmp, file);
}

/** "Street View not configured: <which>", or undefined when both credentials are there. */
export function missingCredentials(deps: StreetViewEvidenceDeps): string | undefined {
    const missing: string[] = [];
    if (!deps.mapsApiKey) missing.push('no Google Maps API key for pano discovery');
    if (!deps.grounding) missing.push(deps.groundingUnavailable || 'no service account for the Maps Imagery Grounding API');
    return missing.length ? `Street View not configured: ${missing.join('; ')}` : undefined;
}

/** Outward unit direction (tile frame x east, z south) of a compass heading. */
export function headingDir(headingDeg: number): [number, number] {
    return [Math.sin(headingDeg * DEG), -Math.cos(headingDeg * DEG)];
}

/** Compass bearing (deg, clockwise from north) from a to b in the tile frame. */
export function bearingDeg(ax: number, az: number, bx: number, bz: number): number {
    return ((Math.atan2(bx - ax, -(bz - az)) / DEG) + 360) % 360;
}

function angleDiff(a: number, b: number): number {
    const d = Math.abs(a - b) % 360;
    return d > 180 ? 360 - d : d;
}

export interface FacadeGeometry {
    headingDeg: number;
    /** Centre of the facade at the ground, tile frame. */
    centre: [number, number];
    widthM: number;
}

/** Each facade heading's centre and width, from the structure's outline. */
export function facadeGeometry(structure: Pick<StructurePickResult, 'outline' | 'centroid' | 'facadeHeadingsDeg'>): FacadeGeometry[] {
    return structure.facadeHeadingsDeg.map(h => {
        const [nx, nz] = headingDir(h);
        const tx = -nz, tz = nx; // along the facade
        let far = -Infinity, lo = Infinity, hi = -Infinity;
        for (const [x, z] of structure.outline) {
            far = Math.max(far, (x - structure.centroid.x) * nx + (z - structure.centroid.z) * nz);
            const t = (x - structure.centroid.x) * tx + (z - structure.centroid.z) * tz;
            lo = Math.min(lo, t); hi = Math.max(hi, t);
        }
        const mid = (lo + hi) / 2;
        return {
            headingDeg: h,
            centre: [structure.centroid.x + nx * far + tx * mid, structure.centroid.z + nz * far + tz * mid],
            widthM: Math.max(1, hi - lo)
        };
    });
}

/**
 * Street points to ask the metadata endpoint about. It answers with the NEAREST pano only, so one query per place
 * finds one pano: the points are rings (10-90 m, 8 m steps) round each facade centre within ±75° of its heading (oblique views of a face), and
 * rings (12-130 m) all the way round the structure, every 15°, so panos on every side of it come up.
 */
export function candidatePoints(facades: FacadeGeometry[], centre?: { x: number; z: number }): Array<{ x: number; z: number }> {
    const pts: Array<{ x: number; z: number }> = [];
    for (const f of facades) {
        for (let r = 10; r <= 90; r += 8) {
            for (let off = -75; off <= 75; off += 15) {
                const [dx, dz] = headingDir(f.headingDeg + off);
                pts.push({ x: f.centre[0] + dx * r, z: f.centre[1] + dz * r });
            }
        }
    }
    if (centre) {
        for (const r of [12, 20, 30, 42, 56, 72, 90, 110, 130]) {
            for (let a = 0; a < 360; a += 15) {
                const [dx, dz] = headingDir(a + (r % 20 === 0 ? 7.5 : 0));
                pts.push({ x: centre.x + dx * r, z: centre.z + dz * r });
            }
        }
    }
    return pts;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
    const out: R[] = new Array(items.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
        while (next < items.length) { const i = next++; out[i] = await fn(items[i]); }
    }));
    return out;
}

const months = (d?: string) => { const m = /^(\d{4})-(\d{2})/.exec(d ?? ''); return m ? Number(m[1]) * 12 + Number(m[2]) - 1 : -Infinity; };

/**
 * Google panos near the structure: metadata at each candidate point (8 m radius, 8 at a time, cached by point), Google
 * captures only, thinned to 6 m (newest first), the nearest MAX_CANDIDATE_PANOS kept. Age does not drop a pano (the
 * arch has about 24 within 100 m, most of them from 2021 and one from 2026: a 3-year window would have kept the one);
 * recency is a factor in the view score instead.
 */
export async function discoverPanos(origin: GeodeticOrigin, facades: FacadeGeometry[], deps: StreetViewEvidenceDeps, signal?: AbortSignal, centre?: { x: number; z: number }): Promise<{ panos: PanoCandidate[]; metadataCalls: number; cachedCalls: number; rejectedNotGoogle: number; rejectedRefused: number }> {
    const points = candidatePoints(facades, centre);
    const cache: Record<string, any> = deps.metadataCachePath && fs.existsSync(deps.metadataCachePath) ? JSON.parse(fs.readFileSync(deps.metadataCachePath, 'utf8')) : {};
    let calls = 0, cached = 0;
    const answers = await mapLimit(points, 8, async p => {
        if (signal?.aborted) return undefined;
        const g = scanToGeodetic(origin, p.x, 0, p.z);
        const key = `${g.lat.toFixed(6)},${g.lng.toFixed(6)},8`;
        if (cache[key]) { cached++; return cache[key]; }
        calls++;
        let rec: any;
        try {
            const m = await fetchStreetViewPanoMetadata({ lat: g.lat, lng: g.lng, radiusMeters: 8, apiKey: deps.mapsApiKey, fetchImpl: deps.fetchImpl });
            rec = { status: 'OK', panoId: m.panoId, lat: m.lat, lng: m.lng, date: m.date, copyright: m.copyright };
        } catch (err) {
            if (/ZERO_RESULTS|NOT_FOUND|No Street View/i.test((err as Error).message)) rec = { status: 'ZERO_RESULTS' };
            else throw err;
        }
        cache[key] = rec;
        return rec;
    });
    if (deps.metadataCachePath) {
        fs.mkdirSync(path.dirname(deps.metadataCachePath), { recursive: true });
        fs.writeFileSync(deps.metadataCachePath, JSON.stringify(cache));
    }
    const ok = answers.filter(a => a && a.status === 'OK');
    // the grounding API's own refusals are left out before thinning, so an eligible pano beside one is kept
    const refused = knownRefusals(deps);
    const google = ok.filter(a => isGoogleCapture(a.copyright));
    const byId = new Map<string, PanoCandidate>();
    for (const a of google) {
        if (refused.has(a.panoId)) continue;
        if (byId.has(a.panoId)) continue;
        const q = geodeticToScan(origin, a.lat, a.lng);
        byId.set(a.panoId, { panoId: a.panoId, lat: a.lat, lng: a.lng, date: a.date, copyright: a.copyright, x: q.x, z: q.z });
    }
    const sorted = [...byId.values()].sort((a, b) => months(b.date) - months(a.date) || a.panoId.localeCompare(b.panoId));
    const kept: PanoCandidate[] = [];
    for (const p of sorted) if (!kept.some(q => Math.hypot(q.x - p.x, q.z - p.z) < 6)) kept.push(p);
    if (centre) kept.sort((a, b) => Math.hypot(a.x - centre.x, a.z - centre.z) - Math.hypot(b.x - centre.x, b.z - centre.z));
    kept.splice(MAX_CANDIDATE_PANOS);
    return {
        panos: kept, metadataCalls: calls, cachedCalls: cached, rejectedNotGoogle: new Set(ok.filter(a => !isGoogleCapture(a.copyright)).map(a => a.panoId)).size,
        rejectedRefused: new Set(google.filter(a => refused.has(a.panoId)).map(a => a.panoId)).size
    };
}

/**
 * Share of 25 facade sample points (5 across × 5 up) the eye sees over the unmasked surface model: a cell on the way
 * that stands higher than the ray (by 0.3 m) blocks it; cells of the structure itself do not.
 */
export function facadeVisibility(eye: Vec3, facade: FacadeGeometry, structure: Pick<StructurePickResult, 'cells' | 'groundY' | 'heightM'>, ground: Pick<GroundModel, 'cellIndex'>, top: Float32Array): number {
    const [nx, nz] = headingDir(facade.headingDeg);
    const tx = -nz, tz = nx;
    let seen = 0;
    for (let i = 0; i < 5; i++) for (let j = 0; j < 5; j++) {
        const along = (i / 4 - 0.5) * facade.widthM * 0.9;
        const px = facade.centre[0] + tx * along + nx * 0.5, pz = facade.centre[1] + tz * along + nz * 0.5;
        const py = structure.groundY + structure.heightM * (0.1 + 0.8 * (j / 4));
        const d = Math.hypot(px - eye[0], pz - eye[2]);
        let blocked = false;
        for (let s = 0.5; s < d - 0.5 && !blocked; s += 0.5) {
            const f = s / d;
            const x = eye[0] + (px - eye[0]) * f, z = eye[2] + (pz - eye[2]) * f, y = eye[1] + (py - eye[1]) * f;
            if (structure.cells.has(`${Math.floor(x)},${Math.floor(z)}`)) continue;
            const c = ground.cellIndex(x, z);
            if (c >= 0 && top[c] === top[c] && top[c] > y + 0.3) blocked = true;
        }
        if (!blocked) seen++;
    }
    return seen / 25;
}

export function evidenceImageId(v: Pick<SelectedView, 'panoId' | 'headingDeg' | 'pitchDeg' | 'fovDeg'>): string {
    return `sv:${v.panoId}:${v.headingDeg}:${v.pitchDeg}:${v.fovDeg}`;
}

/**
 * Fetches the views in parallel, each with a 30 s timeout (retries of 503s included) and the request's signal; a failed image is recorded and the
 * others continue. The bytes stay in memory as they arrived.
 */
export async function fetchViews(views: SelectedView[], deps: StreetViewEvidenceDeps, signal?: AbortSignal, timeoutMs = EVIDENCE_IMAGE_TIMEOUT_MS): Promise<{ images: EvidenceImage[]; failures: Array<{ view: SelectedView; error: string; transient: boolean; refused: boolean }>; elapsedMs: number }> {
    const started = (deps.now ?? Date.now)();
    if (!deps.grounding) throw new Error(missingCredentials(deps) ?? 'Street View not configured');
    const grounding = deps.grounding;
    const results = await Promise.all(views.map(async view => {
        const t0 = (deps.now ?? Date.now)();
        const own = new AbortController();
        const timer = callTimeout(() => own.abort(Object.assign(new Error(`timed out after ${timeoutMs / 1000} s`), { name: 'TimeoutError' })), timeoutMs);
        const combined = signal ? AbortSignal.any([signal, own.signal]) : own.signal;
        try {
            // pitchDeg is elevation (up positive); the grounding API counts down as positive
            const img = await grounding.retrieveGroundingImage({
                panoId: view.panoId, headingDegree: view.headingDeg, pitchDegree: groundingPitchForElevation(view.pitchDeg), fovDegree: view.fovDeg, aspectRatio: view.aspectRatio
            }, combined);
            const size = readJpegSize(img.image);
            if (!size) throw new Error('the grounding image is not a JPEG with a readable size');
            // the image's content hash (its pixels' JPEG without metadata): the grounding API re-signs every answer with a fresh
            // metadata segment, so a hash of the whole file would differ for the same view on every fetch
            const sha256 = imageContentSha256(img.image);
            return {
                ok: true as const,
                image: {
                    view, bytes: img.image, mimeType: img.mimeType, widthPx: size.width, heightPx: size.height, sha256,
                    id: evidenceImageId(view),
                    nativeSampleM: view.distanceM / groundingFocalPx(view.fovDeg, size.width, size.height),
                    fetchMs: (deps.now ?? Date.now)() - t0
                } satisfies EvidenceImage
            };
        } catch (err) {
            const message = own.signal.aborted && !signal?.aborted ? `timed out after ${timeoutMs / 1000} s` : (err as Error).message;
            const refused = !signal?.aborted && isGroundingRefusal(message);
            if (refused) recordRefusal(deps, view.panoId, message);
            return { ok: false as const, view, error: message, transient: !/not published or eligible|400|403/.test(message), refused };
        } finally {
            timer.clear();
        }
    }));
    return {
        images: results.flatMap(r => (r.ok ? [r.image] : [])),
        failures: results.flatMap(r => (r.ok ? [] : [{ view: r.view, error: r.error, transient: r.transient, refused: r.refused }])),
        elapsedMs: (deps.now ?? Date.now)() - started
    };
}

/**
 * The grounding service with one request per (pano, heading, pitch, fov, aspect) per run: a view fetched ahead (the ring
 * views while the survey reads its faces) is handed to whoever asks for it next. Only a successful answer is shared; a
 * caller whose shared request failed for someone else's reason (that caller's stop or time limit) asks again on its own.
 * The bytes live in memory for the run only, like every other Street View image here.
 */
export function memoizeGrounding(grounding: NonNullable<StreetViewEvidenceDeps['grounding']>): NonNullable<StreetViewEvidenceDeps['grounding']> & { prefetched(): number } {
    const memo = new Map<string, Promise<GroundingImage>>();
    let shared = 0;
    const keyOf = (req: GroundingImageRequest) => JSON.stringify([req.panoId, req.headingDegree, req.pitchDegree, req.fovDegree, req.aspectRatio ?? null]);
    return {
        prefetched: () => shared,
        retrieveGroundingImage: async (req, signal) => {
            const key = keyOf(req);
            const pending = memo.get(key);
            if (pending) {
                try {
                    const got = await pending;
                    shared++;
                    return got;
                } catch {
                    if (signal?.aborted) throw signal.reason;
                    // the shared request failed: this caller asks on its own below
                }
            }
            const work = grounding.retrieveGroundingImage(req, signal);
            memo.set(key, work);
            work.catch(() => { if (memo.get(key) === work) memo.delete(key); });
            return work;
        }
    };
}
