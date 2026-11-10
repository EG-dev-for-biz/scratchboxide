/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Street-level survey stations for the splat pipeline (SurveySplatPipelineService), posed by real Street View panoramas
 * around a vantage: where a person stands and which way they look.
 *
 * Nothing here is new machinery; it wires what the staged build's Street View evidence already runs:
 * - pano discovery at street points on the free metadata endpoint, Google captures only (discoverPanosAt);
 * - the views through the Maps Imagery Grounding API, bytes in memory exactly as returned (fetchViews);
 * - the edge then joint registration against the same clay GLB the stations are baked on (runPanoRegistrationOffThread),
 *   so each pose is in that GLB's own frame and needs no conversion;
 * - the registered camera as a survey station (castCamera, stationForFrame).
 *
 * The photographs are never written, cached, logged or re-encoded: each station carries its bytes in memory to the image
 * model (BeautifyStationService's groundingPhoto, the Street View seed prompt), and only the generated image is baked.
 * Pano ids, positions and dates go to the metadata cache as before.
 */

import type { ColmapCameraPose, GeodeticAnchor } from '../../common/spatial/colmap-vector-reference-types';
import type { GeodeticOrigin } from './StreetViewSurveyPlanner';
import { geodeticToScan, scanToGeodetic } from './StreetViewSurveyPlanner';
import { groundingHorizontalFovDeg, readGlbScene, sceneToRenderMesh, stationForFrame, type PoseCorrection } from './StreetViewPoseRegistrar';
import { TileMeshRaycaster } from './tile-mesh-raycast';
import type { GroundingPhoto } from './BeautifyStationService';
import {
    discoverPanosAt, fetchViews, headingDir, knownRefusals, missingCredentials, STREET_VIEW_EYE_HEIGHT_M,
    type SelectedView, type StreetViewEvidenceDeps
} from '../3d-engine/staged-location/streetview-evidence';
import { runPanoRegistrationOffThread, type PanoRegistrationJob, type PanoRegistrationOutcome } from '../3d-engine/staged-location/pano-registration-run';
import { castCamera, type CastView } from '../3d-engine/staged-location/survey-casting';
import { describeDriveRegistration, type SeenPoint } from '../3d-engine/staged-location/pano-drive-registration';

/** Where the viewer stands and which way they look. */
export interface StreetVantage {
    lat: number;
    lng: number;
    /** Compass heading the viewer looks along (clockwise from north). */
    headingDeg: number;
    /** Length of the walk across the look direction (along the sidewalk), centred on the vantage. Default 60 m. */
    walkMeters?: number;
    /** How far toward the look direction panos are looked for (the roadway in front). Default 20 m. */
    reachMeters?: number;
    /** Most panos used, the nearest to the vantage first. Default 6. */
    maxPanos?: number;
    /** View headings per pano, relative to headingDeg. Default VANTAGE_VIEW_OFFSETS_DEG. */
    viewOffsetsDeg?: number[];
    /** Elevation of every view axis, up positive. Default 0: level, so the ground is in view from about 5 m out (the survey's higher stations cover the upper facades). */
    elevationDeg?: number;
    /** Requested field of view of every view. Default 70. */
    fovDeg?: number;
}

/** Ahead, half left, half right, and behind the viewer: the vantage seen all round, the look direction first. */
export const VANTAGE_VIEW_OFFSETS_DEG = [0, -55, 55, 180];
/** Spacing of the street points pano discovery asks at. */
export const VANTAGE_POINT_SPACING_M = 6;

export interface StreetViewStation {
    station: ColmapCameraPose;
    photo: GroundingPhoto;
    /** 'joint', 'edges' or 'nominal' (unregistered: good to about ±2 m and ±2°), and why. */
    registration: { method: string; reason?: string };
}

export interface StreetViewStationsResult {
    stations: StreetViewStation[];
    /** The vantage in the GLB frame (x east, z south), and the scan's top surface there (the sidewalk), when the scan covers it. */
    vantageLocal: { x: number; z: number };
    vantageGroundY?: number;
    discovery: { panosFound: number; panosUsed: number; metadataCalls: number; cachedCalls: number; rejectedNotGoogle: number };
    /** Views that failed or were refused, with the API's error. */
    failures: Array<{ panoId: string; headingDeg: number; error: string }>;
    /** One line: how many panos took a registered pose. */
    registrationSummary: string;
    /** Points two registered photos both see (the drive registration's), for the seen-through removal (seen-through.ts). */
    seenPoints?: SeenPoint[];
    /** The drive registration in words, when it ran. */
    driveSummary?: string;
    /** Each panorama used: its nominal eye in the GLB frame, its registered correction when it has one, and how it was registered. */
    panoPoses?: StreetPanoPose[];
}

export interface StreetPanoPose {
    panoId: string;
    /** The nominal eye: the panorama's position, 2.5 m above the scan's top surface there. */
    eye: [number, number, number];
    correction?: PoseCorrection;
    /** 'joint', 'edges', ... or 'nominal' (unregistered: good to about ±2 m and ±2°). */
    method: string;
}

export interface StreetViewStationsRequest {
    /** The clay GLB the stations are rendered and baked on; its origin is `anchor` (x east, y up, z south). */
    glbPath: string;
    /** The same tiles with their photo texture, in glbPath's frame: the drive registration matches the photos against it (texturedTilesTwin). */
    texturedGlbPath?: string;
    anchor: GeodeticAnchor;
    vantage: StreetVantage;
    streetView: StreetViewEvidenceDeps;
    /** First station id (survey stations count from 0; street stations sit apart from them). Default 1000. */
    firstId?: number;
    /** The registration (default runPanoRegistrationOffThread). */
    register?: (job: PanoRegistrationJob, opts: { signal?: AbortSignal; log?: (m: string) => void }) => Promise<PanoRegistrationOutcome>;
    signal?: AbortSignal;
    onProgress?: (message: string) => void;
}

/** The street points pano discovery asks at: a grid `walkMeters` across the look direction by `reachMeters` along it. */
export function vantageStreetPoints(v: { x: number; z: number }, headingDeg: number, walkMeters: number, reachMeters: number): Array<{ x: number; z: number }> {
    const [fx, fz] = headingDir(headingDeg);
    const sx = -fz, sz = fx;
    const pts: Array<{ x: number; z: number }> = [];
    const half = walkMeters / 2;
    for (let along = -half; along <= half + 1e-9; along += VANTAGE_POINT_SPACING_M) {
        for (let ahead = 0; ahead <= reachMeters + 1e-9; ahead += VANTAGE_POINT_SPACING_M) {
            pts.push({ x: v.x + sx * along + fx * ahead, z: v.z + sz * along + fz * ahead });
        }
    }
    return pts;
}

/** Vertical rays against a GLB in its own frame (the top surface under a point). */
export function glbRaycaster(glbPath: string, origin: GeodeticOrigin): TileMeshRaycaster {
    const mesh = sceneToRenderMesh(readGlbScene(glbPath));
    return new TileMeshRaycaster({ soup: { positions: Float32Array.from(mesh.vertices), indices: Uint32Array.from(mesh.indices) }, anchorLat: origin.lat, anchorLng: origin.lng, originEllipsoidalHeightM: 0 });
}

/** A street centreline from the vector tiles: its geodetic path ([lng, lat] per vertex) and modelled width. */
export interface VectorStreet { geodeticPath: Array<[number, number]>; widthM?: number }

/** Where the snap put the viewer, and why. */
export interface SidewalkSnap {
    lat: number;
    lng: number;
    headingDeg: number;
    /** The street the viewer stands beside: its bearing (0..180, clockwise from north), and its centreline point beside the viewer. */
    streetBearingDeg: number;
    streetPoint: { lat: number; lng: number };
    /** From the street's centreline to the viewer, metres; and from the named place to the street. */
    offsetM: number;
    placeDistanceM: number;
    /** From the centreline to the first building the scan shows on that side, when one was found. */
    buildingLineM?: number;
    reason: string;
}

/**
 * Streets farther than this from the named place are not the one the viewer stands beside. A landmark on the street
 * ("the west sidewalk of 7th Ave at Madison Square Garden") resolves to its own middle, well back from the street.
 */
export const SNAP_STREET_RADIUS_M = 200;
/** A street whose sidewalk side points more than this away from the asked direction is not the one meant. */
export const SNAP_SIDE_TOLERANCE_DEG = 45;
/** The place may lie this far across the street from the asked side (a corner, a point on the centreline). */
export const SNAP_CORNER_M = 15;
/** How far out from the centreline the building line is looked for. */
export const SNAP_BUILDING_SEARCH_M = 45;
/** A building front: the scan's top surface this far above the street, over SNAP_BUILDING_RUN_M of the walk out. */
export const SNAP_BUILDING_RISE_M = 5;
export const SNAP_BUILDING_RUN_M = 2;
/** The viewer stands this far in front of the building line (the middle of a sidewalk). */
export const SNAP_STANDOFF_M = 2.5;
/** A requested look heading within this of "across the street" is taken to mean across the street. */
export const SNAP_ACROSS_TOLERANCE_DEG = 45;

const angleDiff = (a: number, b: number): number => { const d = Math.abs(((a - b) % 360 + 360) % 360); return d > 180 ? 360 - d : d; };
const wrap360 = (a: number): number => ((a % 360) + 360) % 360;

/** A street the viewer may stand beside: the point on it nearest the place (`c`, local), its bearing and the side's direction. */
export interface SidewalkCandidate { dist: number; score: number; c: { x: number; z: number }; bearing: number; side: number; widthM?: number }

/**
 * The streets a worded vantage may mean, nearest the place first: within SNAP_STREET_RADIUS_M, with a side facing
 * `sideDeg` (the compass direction from the street to the viewer) within SNAP_SIDE_TOLERANCE_DEG, and the place on that
 * side of it (a landmark on the sidewalk) or within SNAP_CORNER_M of it (a corner). One per street, at its nearest point.
 */
export function sidewalkCandidates(args: { origin: GeodeticOrigin; place: { x: number; z: number }; sideDeg: number; streets: VectorStreet[] }): SidewalkCandidate[] {
    const out: SidewalkCandidate[] = [];
    for (const st of args.streets) {
        let best: SidewalkCandidate | undefined;
        const pts = st.geodeticPath.map(([lng, lat]) => geodeticToScan(args.origin, lat, lng));
        for (let i = 0; i + 1 < pts.length; i++) {
            const a = pts[i], b = pts[i + 1], dx = b.x - a.x, dz = b.z - a.z, L = dx * dx + dz * dz;
            if (L < 1e-6) continue;
            const t = Math.max(0, Math.min(1, ((args.place.x - a.x) * dx + (args.place.z - a.z) * dz) / L));
            const c = { x: a.x + t * dx, z: a.z + t * dz };
            const dist = Math.hypot(c.x - args.place.x, c.z - args.place.z);
            if (dist > SNAP_STREET_RADIUS_M) continue;
            // a street drawn either way has one bearing, 0 (inclusive) to 180 (exclusive)
            let bearing = wrap360(Math.atan2(dx, -dz) / (Math.PI / 180)) % 180;
            if (180 - bearing < 1e-6) bearing = 0;
            const n1 = wrap360(bearing + 90), n2 = wrap360(bearing - 90);
            const side = angleDiff(n1, args.sideDeg) <= angleDiff(n2, args.sideDeg) ? n1 : n2;
            const score = angleDiff(side, args.sideDeg);
            if (score > SNAP_SIDE_TOLERANCE_DEG) continue;
            const [ux, uz] = headingDir(side);
            if ((args.place.x - c.x) * ux + (args.place.z - c.z) * uz < -SNAP_CORNER_M) continue;
            if (!best || dist < best.dist - 1e-6 || (Math.abs(dist - best.dist) <= 1e-6 && score < best.score)) best = { score, dist, c, bearing, side, ...(st.widthM ? { widthM: st.widthM } : {}) };
        }
        if (best) out.push(best);
    }
    return out.sort((a, b) => a.dist - b.dist || a.score - b.score);
}

/**
 * Puts a worded vantage ("on the west sidewalk of 7th Avenue at Penn Station, looking east") where a person would stand:
 * beside the first of sidewalkCandidates (snapVantageToDrivenSidewalk checks each against Street View coverage first),
 * placed by placeOnSidewalk. Null when no such street lies near the place.
 */
export function snapVantageToSidewalk(args: {
    origin: GeodeticOrigin;
    place: { x: number; z: number };
    sideDeg: number;
    headingDeg?: number;
    streets: VectorStreet[];
    ray?: Pick<TileMeshRaycaster, 'topHitLocal'>;
}): SidewalkSnap | null {
    const first = sidewalkCandidates(args)[0];
    return first ? placeOnSidewalk(args.origin, first, args) : null;
}

/**
 * The vector tiles label avenues, side streets and driveways inside a block alike, so the nearest street is not always
 * the one meant. The one meant is a street a Google car drove: candidates are taken nearest first, and the first with a
 * Google-captured pano at its point (`driven`) wins; at most `maxTries` are asked. None driven: the nearest, saying so.
 */
export async function snapVantageToDrivenSidewalk(args: Parameters<typeof snapVantageToSidewalk>[0] & {
    driven: (c: { x: number; z: number }) => Promise<boolean>;
    maxTries?: number;
}): Promise<SidewalkSnap | null> {
    const candidates = sidewalkCandidates(args);
    if (!candidates.length) return null;
    const tries = candidates.slice(0, Math.max(1, args.maxTries ?? 6));
    for (const [k, cand] of tries.entries()) {
        if (!(await args.driven(cand.c))) continue;
        const snap = placeOnSidewalk(args.origin, cand, args);
        return k ? { ...snap, reason: `${snap.reason}; the ${k} nearer street${k === 1 ? '' : 's'} had no Street View coverage there (not a street a car drives)` } : snap;
    }
    const snap = placeOnSidewalk(args.origin, candidates[0], args);
    return { ...snap, reason: `${snap.reason}; none of the ${tries.length} nearest streets had Street View coverage, so the nearest was used` };
}

/**
 * The viewer beside `best`: SNAP_STANDOFF_M in front of the first building the scan shows on that side (measured by
 * walking out from the centreline over the scan's top surface), and the look heading snapped to across the street when
 * it is within SNAP_ACROSS_TOLERANCE_DEG of it (on a rotated grid "east" is the grid's east). Without `ray`, or no
 * building line within reach, the vector road width is used and the reason says so.
 */
export function placeOnSidewalk(origin: GeodeticOrigin, best: SidewalkCandidate, args: { headingDeg?: number; ray?: Pick<TileMeshRaycaster, 'topHitLocal'> }): SidewalkSnap {
    const [sx, sz] = headingDir(best.side);
    const ray = args.ray;
    const streetY = ray?.topHitLocal(best.c.x, best.c.z);
    let buildingLineM: number | undefined;
    if (ray && streetY !== undefined) {
        const step = 0.5, need = Math.round(SNAP_BUILDING_RUN_M / step);
        let run = 0;
        for (let d = step; d <= SNAP_BUILDING_SEARCH_M; d += step) {
            const y = ray.topHitLocal(best.c.x + sx * d, best.c.z + sz * d);
            run = y !== undefined && y - streetY > SNAP_BUILDING_RISE_M ? run + 1 : 0;
            if (run >= need) { buildingLineM = d - (need - 1) * step; break; }
        }
    }
    const roadHalf = (best.widthM ?? 8) / 2;
    const offsetM = buildingLineM !== undefined ? Math.max(roadHalf + 1, buildingLineM - SNAP_STANDOFF_M) : roadHalf + 3;
    const across = wrap360(best.side + 180);
    const headingDeg = args.headingDeg === undefined || angleDiff(args.headingDeg, across) <= SNAP_ACROSS_TOLERANCE_DEG ? across : wrap360(args.headingDeg);
    const g = scanToGeodetic(origin, best.c.x + sx * offsetM, 0, best.c.z + sz * offsetM);
    const onStreet = scanToGeodetic(origin, best.c.x, 0, best.c.z);
    return {
        lat: g.lat, lng: g.lng, headingDeg, streetBearingDeg: best.bearing, streetPoint: { lat: onStreet.lat, lng: onStreet.lng }, offsetM,
        ...(buildingLineM !== undefined ? { buildingLineM } : {}),
        placeDistanceM: best.dist,
        reason: (buildingLineM !== undefined
            ? `${SNAP_STANDOFF_M} m in front of the building line the scan shows ${buildingLineM.toFixed(1)} m from the street's centreline`
            : `${ray ? `no building line within ${SNAP_BUILDING_SEARCH_M} m in the scan` : 'no scan read'}: ${offsetM.toFixed(1)} m from the centreline, by the vector road width (${best.widthM ?? 8} m)`)
            // a place well off the street (a landmark, not a corner) may have meant another of its streets: said, so it shows
            + (best.dist > SNAP_CORNER_M ? `; the named place lies ${best.dist.toFixed(0)} m from this street (a street corner pins the street exactly)` : '')
    };
}

/** The survey station of a grounding view: its camera (castCamera, under the pano's correction when registered) as stationForFrame gives it. */
export function streetViewStation(id: number, view: CastView & { panoId: string }, origin: GeodeticOrigin, streetY?: number): ColmapCameraPose {
    const cam = castCamera(view);
    const name = `SV_${view.panoId.replace(/[^A-Za-z0-9_-]/g, '_')}_h${Math.round(view.headingDeg)}`;
    const st = stationForFrame(id, name, cam, groundingHorizontalFovDeg(view.fovDeg, view.widthPx, view.heightPx), origin, streetY);
    // The camera's up vector already carries its roll; the renderer would roll it again from rollDegrees, and the
    // baker reads only the vectors, so the roll stays in the vectors alone and both see one camera.
    // cameraAltitude is height above the street (the baker's street-level splat size and the fuser's priority read it)
    return { ...st, rollDegrees: 0, cameraAltitude: streetY !== undefined ? cam.eye[1] - streetY : STREET_VIEW_EYE_HEIGHT_M };
}

/** Discovers, fetches and registers the Street View views around the vantage, as survey stations. Throws on missing credentials. */
export async function planStreetViewStations(req: StreetViewStationsRequest): Promise<StreetViewStationsResult> {
    const sv = req.streetView;
    const missing = missingCredentials(sv);
    if (missing) throw new Error(`Street View stations: ${missing}`);
    const progress = req.onProgress ?? (() => undefined);
    const v = req.vantage;
    const walk = v.walkMeters ?? 60, reach = v.reachMeters ?? 20, maxPanos = Math.max(1, Math.floor(v.maxPanos ?? 6));
    const offsets = v.viewOffsetsDeg?.length ? v.viewOffsetsDeg : VANTAGE_VIEW_OFFSETS_DEG;
    const elevation = v.elevationDeg ?? 0, fov = v.fovDeg ?? 70;

    const origin: GeodeticOrigin = { lat: req.anchor.lat, lng: req.anchor.lng, heightMeters: req.anchor.elevationMeters };
    const local = geodeticToScan(origin, v.lat, v.lng);

    progress('finding Google Street View panoramas around the vantage');
    const found = await discoverPanosAt(origin, vantageStreetPoints(local, v.headingDeg, walk, reach), sv, req.signal, local);
    const refused = knownRefusals(sv);
    const panos = found.panos.filter(p => !refused.has(p.panoId))
        .sort((a, b) => Math.hypot(a.x - local.x, a.z - local.z) - Math.hypot(b.x - local.x, b.z - local.z))
        .slice(0, maxPanos);
    const discovery = { panosFound: found.panos.length, panosUsed: panos.length, metadataCalls: found.metadataCalls, cachedCalls: found.cachedCalls, rejectedNotGoogle: found.rejectedNotGoogle };
    const ray = glbRaycaster(req.glbPath, origin);
    const groundY = ray.topHitLocal(local.x, local.z);
    const vantage = { vantageLocal: local, ...(groundY !== undefined ? { vantageGroundY: groundY } : {}) };
    if (!panos.length) return { stations: [], ...vantage, discovery, failures: [], registrationSummary: 'no Google-captured panorama near the vantage' };

    // the nominal eye: the pano position, 2.5 m above the scan's top surface there (the roadway the car drove on)
    const views: SelectedView[] = [];
    const streetY = new Map<string, number>();
    for (const p of panos) {
        const y = ray.topHitLocal(p.x, p.z);
        if (y === undefined) continue;
        streetY.set(p.panoId, y);
        for (const off of offsets) {
            views.push({
                panoId: p.panoId, ...(p.date ? { date: p.date } : {}), ...(p.copyright ? { copyright: p.copyright } : {}),
                eye: [p.x, y + STREET_VIEW_EYE_HEIGHT_M, p.z], facadeHeadingDeg: v.headingDeg,
                headingDeg: ((v.headingDeg + off) % 360 + 360) % 360, pitchDeg: elevation, fovDeg: fov, aspectRatio: 'RATIO_3X2',
                distanceM: reach, score: 0
            });
        }
    }

    progress(`requesting ${views.length} view${views.length === 1 ? '' : 's'} through the Maps Imagery Grounding API`);
    const got = await fetchViews(views, sv, req.signal);
    if (req.signal?.aborted) throw req.signal.reason ?? new Error('stopped');
    const failures = got.failures.map(f => ({ panoId: f.view.panoId, headingDeg: f.view.headingDeg, error: f.error }));

    let reg: PanoRegistrationOutcome | undefined, regError: string | undefined;
    if (got.images.length) {
        try {
            reg = await (req.register ?? runPanoRegistrationOffThread)({
                images: got.images.map(im => ({ id: im.id, bytes: im.bytes, widthPx: im.widthPx, heightPx: im.heightPx, view: im.view })),
                meshFiles: [req.glbPath], ...(req.texturedGlbPath ? { texturedMeshFiles: [req.texturedGlbPath] } : {}), correspondences: [], faces: []
            }, { signal: req.signal, log: progress });
        } catch (err) {
            if (req.signal?.aborted) throw err;
            regError = err instanceof Error ? err.message : String(err);
            progress(`registration failed (${regError}); the nominal poses stand`);
        }
    }
    const registration = reg?.registration;

    const firstId = req.firstId ?? 1000;
    const stations: StreetViewStation[] = got.images.map((im, k) => {
        const view = im.view;
        const correction = registration?.corrections.get(view.panoId);
        const station = streetViewStation(firstId + k, { ...view, widthPx: im.widthPx, heightPx: im.heightPx, ...(correction ? { correction } : {}) }, origin, streetY.get(view.panoId));
        const per = registration?.perPano.find(p => p.panoId === view.panoId);
        return {
            station,
            photo: { bytes: im.bytes, mimeType: im.mimeType, panoId: view.panoId, ...(view.date ? { date: view.date.slice(0, 7) } : {}) },
            registration: per?.method
                ? { method: per.method }
                : { method: 'nominal', reason: regError ? `registration failed (${regError})` : got.images.length < 2 ? 'one image only: the registration needs two or more' : 'not registered' }
        };
    });
    const registered = new Set(stations.filter(s => s.registration.method !== 'nominal').map(s => s.photo.panoId)).size;
    const used = new Set(stations.map(s => s.photo.panoId)).size;
    return {
        stations, ...vantage, discovery, failures,
        registrationSummary: `${registered} of ${used} pano${used === 1 ? '' : 's'} registered against the scan${regError ? ` (registration failed: ${regError})` : ''}; the rest keep the nominal pose (about ±2 m, ±2°)`,
        ...(reg?.drive?.seenPoints?.length ? { seenPoints: reg.drive.seenPoints } : {}),
        ...(reg?.drive ? { driveSummary: describeDriveRegistration(reg.drive) } : {}),
        panoPoses: panos.filter(p => streetY.has(p.panoId)).map(p => {
            const correction = registration?.corrections.get(p.panoId);
            return {
                panoId: p.panoId, eye: [p.x, streetY.get(p.panoId)! + STREET_VIEW_EYE_HEIGHT_M, p.z] as [number, number, number],
                ...(correction ? { correction } : {}), method: registration?.perPano.find(q => q.panoId === p.panoId)?.method ?? 'nominal'
            };
        })
    };
}
