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

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { MAX_STREET_VIEW_IMAGES_PER_BUILDING, type Vec3 } from '../../../common/spatial/staged-location-contracts';
import { fetchStreetViewPanoMetadata } from '../../spatial/StreetViewPanoramaProjectionService';
import { isGoogleCapture, type GroundingAspectRatio, type GroundingImage, type GroundingImageRequest } from '../../spatial/StreetViewGroundingImageService';
import { geodeticToScan, scanToGeodetic, type GeodeticOrigin, type GroundModel } from '../../spatial/StreetViewSurveyPlanner';
import { readJpegSize } from '../../spatial/StreetViewPoseRegistrar';
import type { StructurePickResult } from './extraction-sizing';

const DEG = Math.PI / 180;
export const EVIDENCE_IMAGE_TIMEOUT_MS = 8000;
export const EVIDENCE_STAGE_BUDGET_MS = 20_000;
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
    pitchDeg: number;
    fovDeg: number;
    aspectRatio: GroundingAspectRatio;
    distanceM: number;
    score: number;
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
    now?: () => number;
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

/** Street points on rings 12-60 m out (10 m steps) from each facade centre, within ±30° of its heading. */
export function candidatePoints(facades: FacadeGeometry[]): Array<{ x: number; z: number }> {
    const pts: Array<{ x: number; z: number }> = [];
    for (const f of facades) {
        for (let r = 12; r <= 60; r += 10) {
            for (const off of [-30, -15, 0, 15, 30]) {
                const [dx, dz] = headingDir(f.headingDeg + off);
                pts.push({ x: f.centre[0] + dx * r, z: f.centre[1] + dz * r });
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
 * Google panos near the facades: metadata at each candidate point (8 m radius, 8 at a time, cached by point), Google
 * captures only, at most 3 years older than the newest one found, thinned to 6 m (newest first).
 */
export async function discoverPanos(origin: GeodeticOrigin, facades: FacadeGeometry[], deps: StreetViewEvidenceDeps, signal?: AbortSignal): Promise<{ panos: PanoCandidate[]; metadataCalls: number; cachedCalls: number; rejectedNotGoogle: number }> {
    const points = candidatePoints(facades);
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
    const google = ok.filter(a => isGoogleCapture(a.copyright));
    const newest = Math.max(...google.map(a => months(a.date)));
    const byId = new Map<string, PanoCandidate>();
    for (const a of google) {
        if (byId.has(a.panoId) || months(a.date) < newest - 36) continue;
        const q = geodeticToScan(origin, a.lat, a.lng);
        byId.set(a.panoId, { panoId: a.panoId, lat: a.lat, lng: a.lng, date: a.date, copyright: a.copyright, x: q.x, z: q.z });
    }
    const sorted = [...byId.values()].sort((a, b) => months(b.date) - months(a.date) || a.panoId.localeCompare(b.panoId));
    const kept: PanoCandidate[] = [];
    for (const p of sorted) if (!kept.some(q => Math.hypot(q.x - p.x, q.z - p.z) < 6)) kept.push(p);
    return { panos: kept, metadataCalls: calls, cachedCalls: cached, rejectedNotGoogle: new Set(ok.filter(a => !isGoogleCapture(a.copyright)).map(a => a.panoId)).size };
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

/**
 * The views to fetch: per facade, panos within 50° of its heading and 12-60 m from its centre, scored by angular
 * width × incidence cosine × visibility × recency; the best per facade first, then by score, up to `max`.
 */
export function selectViews(
    panos: PanoCandidate[],
    facades: FacadeGeometry[],
    structure: Pick<StructurePickResult, 'cells' | 'groundY' | 'heightM'>,
    ground: Pick<GroundModel, 'cellIndex' | 'groundAt'>,
    unmaskedTop: Float32Array,
    max = MAX_STREET_VIEW_IMAGES_PER_BUILDING
): SelectedView[] {
    const limit = Math.max(0, Math.min(MAX_STREET_VIEW_IMAGES_PER_BUILDING, max));
    const newest = Math.max(...panos.map(p => months(p.date)));
    const perFacade: SelectedView[][] = facades.map(f => {
        const out: SelectedView[] = [];
        for (const p of panos) {
            const distanceM = Math.hypot(p.x - f.centre[0], p.z - f.centre[1]);
            if (distanceM < 12 || distanceM > 60) continue;
            const from = bearingDeg(f.centre[0], f.centre[1], p.x, p.z);
            const off = angleDiff(from, f.headingDeg);
            if (off > 50) continue;
            const g = ground.groundAt(p.x, p.z);
            const eye: Vec3 = [p.x, (g === g ? g : structure.groundY) + STREET_VIEW_EYE_HEIGHT_M, p.z];
            const visibility = facadeVisibility(eye, f, structure, ground, unmaskedTop);
            if (visibility <= 0) continue;
            const angularWidth = 2 * Math.atan(f.widthM / 2 / distanceM);
            const recency = Number.isFinite(newest) && Number.isFinite(months(p.date)) ? Math.max(0.5, 1 - (newest - months(p.date)) / 72) : 0.75;
            const score = angularWidth * Math.cos(off * DEG) * visibility * recency;
            const midY = structure.groundY + structure.heightM / 2;
            const tall = structure.heightM > f.widthM;
            out.push({
                panoId: p.panoId, date: p.date, copyright: p.copyright, eye, facadeHeadingDeg: f.headingDeg,
                headingDeg: Math.round(bearingDeg(p.x, p.z, f.centre[0], f.centre[1]) * 10) / 10,
                pitchDeg: Math.round(Math.max(-10, Math.min(45, Math.atan2(midY - eye[1], distanceM) / DEG)) * 10) / 10,
                // choosing the fov is the crop: the image comes back framed on the facade
                fovDeg: Math.round(Math.max(20, Math.min(90, (angularWidth / DEG) * 1.15)) * 10) / 10,
                aspectRatio: tall ? 'RATIO_3X4' : 'RATIO_4X3',
                distanceM: Math.round(distanceM * 100) / 100,
                score
            });
        }
        return out.sort((a, b) => b.score - a.score || a.panoId.localeCompare(b.panoId));
    });
    const chosen: SelectedView[] = [];
    const used = new Set<string>();
    const key = (v: SelectedView) => `${v.panoId}:${v.facadeHeadingDeg}`;
    for (const list of perFacade) {
        const best = list.find(v => !used.has(key(v)));
        if (best && chosen.length < limit) { chosen.push(best); used.add(key(best)); }
    }
    const rest = perFacade.flat().filter(v => !used.has(key(v))).sort((a, b) => b.score - a.score || a.panoId.localeCompare(b.panoId));
    for (const v of rest) {
        if (chosen.length >= limit) break;
        chosen.push(v);
        used.add(key(v));
    }
    return chosen;
}

export function evidenceImageId(v: Pick<SelectedView, 'panoId' | 'headingDeg' | 'pitchDeg' | 'fovDeg'>): string {
    return `sv:${v.panoId}:${v.headingDeg}:${v.pitchDeg}:${v.fovDeg}`;
}

/**
 * Fetches the views in parallel, each with an 8 s timeout and the request's signal; a failed image is recorded and the
 * others continue. The bytes stay in memory as they arrived.
 */
export async function fetchViews(views: SelectedView[], deps: StreetViewEvidenceDeps, signal?: AbortSignal, timeoutMs = EVIDENCE_IMAGE_TIMEOUT_MS): Promise<{ images: EvidenceImage[]; failures: Array<{ view: SelectedView; error: string; transient: boolean }> }> {
    if (!deps.grounding) throw new Error(missingCredentials(deps) ?? 'Street View not configured');
    const grounding = deps.grounding;
    const results = await Promise.all(views.map(async view => {
        const own = new AbortController();
        const timer = setTimeout(() => own.abort(Object.assign(new Error(`timed out after ${timeoutMs / 1000} s`), { name: 'TimeoutError' })), timeoutMs);
        const combined = signal ? AbortSignal.any([signal, own.signal]) : own.signal;
        try {
            const img = await grounding.retrieveGroundingImage({
                panoId: view.panoId, headingDegree: view.headingDeg, pitchDegree: view.pitchDeg, fovDegree: view.fovDeg, aspectRatio: view.aspectRatio
            }, combined);
            const size = readJpegSize(img.image);
            if (!size) throw new Error('the grounding image is not a JPEG with a readable size');
            const sha256 = crypto.createHash('sha256').update(img.image).digest('hex');
            return {
                ok: true as const,
                image: {
                    view, bytes: img.image, mimeType: img.mimeType, widthPx: size.width, heightPx: size.height, sha256,
                    id: evidenceImageId(view),
                    nativeSampleM: (view.distanceM * view.fovDeg * DEG) / size.width
                } satisfies EvidenceImage
            };
        } catch (err) {
            const message = own.signal.aborted && !signal?.aborted ? `timed out after ${timeoutMs / 1000} s` : (err as Error).message;
            return { ok: false as const, view, error: message, transient: !/not published or eligible|400|403/.test(message) };
        } finally {
            clearTimeout(timer);
        }
    }));
    return {
        images: results.flatMap(r => (r.ok ? [r.image] : [])),
        failures: results.flatMap(r => (r.ok ? [] : [{ view: r.view, error: r.error, transient: r.transient }]))
    };
}
