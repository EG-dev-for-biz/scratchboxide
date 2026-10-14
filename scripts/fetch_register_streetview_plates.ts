/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Street View acquisition + registration for projective texturing of a scan (plan E2-E7).
 *
 *   npx vite-node scripts/fetch_register_streetview_plates.ts \
 *     --glb <textured base.glb> --anchor <lat,lng,h> --out .scratchbox/streetview_cache/<site> [--frames-from-cache] [--jobs 6]
 *
 * --glb, --anchor and --out are required (no site defaults). --glb is the TEXTURED base the plates will be projected
 * onto (its own texture is what the photos are registered against). Keep --out under .scratchbox/ (gitignored): the
 * imagery stays local.
 *
 * Stages:
 *   E2-E4  pano discovery (free metadata), coverage-driven frame plan, cached fetch (billed; see Billing). With
 *          --frames-from-cache nothing is requested at all: the panos of <out>/plan.json and every cached frame are used.
 *   E5     masks: watermark strip + Gemini occluder / signage boxes (cached per frame with the prompt version)
 *   E6     registration, --method feature (default; StreetViewFeatureRegistrar): dense orientation alignment of the
 *          photo to the textured scan render from the GPS pose and +-2.5 m seeds, local feature matches lifted to
 *          3D through the render depth, RANSAC-PnP with the fixed Street View intrinsics, interior-edge refinement.
 *          Per pano (frames of a pano share the camera centre), in parallel child processes (--jobs, each with a
 *          timeout); results are cached per pano and reused while the inputs are unchanged (--force-registration).
 *          --method rigid keeps the earlier silhouette/line registrar + joint cross-view refinement.
 *   E6c    cross-frame agreement: held-out check inside each pano (the frame's interior edges under the pose fitted to
 *          the pano's other frames) and cross-view photo consistency with accepted partner panos
 *          (StreetViewCrossViewRefiner.measure at the final poses).
 *   E7     plates.json: accepted frames only. Gates (DEFAULT_FEATURE_GATES): interior edge median <= 2 px, orientation
 *          NCC (photo vs textured render) above the GPS pose's, >= 12 PnP inliers, cross-frame agreement measured and
 *          passed (held-out edge median <= 3 px / cross-view median <= 2.5 px), not on a search bound. poseQuality
 *          counts every gated statistic (featurePoseQuality).
 *
 * Writes into --out: metadata_cache.json, plan.json, <frame>.jpg/.json, occluders/<frame>.json, visibility/*.vis,
 * feature_registration/<pano>.json, plates/plates.json, plates/<frame>.depth.f32, .mask.png, plates/overlays/<frame>.png
 * (photo vs textured render, red/cyan, GPS pose | final pose), plates/pose_report.json (plates/ = --plates-dir).
 *
 * Billing: every billed Static API image request is counted in ONE global ledger,
 * <repo>/.scratchbox/streetview_cache/billing_ledger.json, whatever --out is (earlier ledgers are folded in once). The
 * hard cap is 80 requests in total; --max-billed (an integer 0..80) can only lower it. The ledger is re-read under a
 * lock before every request.
 *
 * Flags: --method feature|rigid, --frames-from-cache, --jobs N, --worker-timeout-min M, --force-registration,
 *        --plates-dir <dir> (default <out>/plates; plates.json, pose_report.json, depth / mask / overlay files),
 *        --plan-only, --no-fetch, --no-gemini, --redetect-occluders, --regate (re-evaluate the gates on the stored
 *        statistics), --max-billed N, --max-frames N, --frames-per-pano N, --radius M, --spacing M, --camera-height M,
 *        --pano <id> (repeatable), --seed-frames <json>, --no-cross-view.
 *        Feature gate overrides: --gate-edge-px, --gate-heldout-px, --gate-cross-px, --gate-min-inliers, --gate-ncc-gain.
 *        Rigid method: --max-fallbacks N, --reuse-registration, --reuse-cross-view, --cross-view-start rot|reg|gps,
 *        --gate-silhouette-px / --gate-line-px / --gate-sky-iou / --gate-agree-m / --gate-agree-deg / --gate-min-ncc /
 *        --gate-min-peak / --gate-cross-p75 (number or 'off'), --gate-cross-min-matches N.
 *
 * API keys are read from the environment or the repo .env and never printed.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { spawn } from 'child_process';
import {
    loadScanMesh, buildGroundModel, findHeroFootprint, buildTargetSamples, discoverPanos, localStreetHeight,
    planFrames, fetchFrames, coverageReport, cameraUtilities, parseAnchor, frameKey, computePanoVisibilityCached,
    openGlobalLedger, effectiveBillingCap, STREETVIEW_BILLING_HARD_CAP,
    type PanoRecord, type PanoVisibility, type CachedFrame, type CandidateFrame, type ScanMesh, type HeroModel, type TargetSamples, type GroundModel
} from '../packages/core/src/node/spatial/StreetViewSurveyPlanner';
import {
    StreetViewPoseRegistrar, decodeImageToRgba, buildValidMask, renderPlateDepth, renderRegistrationOverlay, renderFrameDepth,
    poseQuality, stationForFrame, streetViewIntrinsics, encodeDepthF32, encodeMaskPng, createGeminiContentClient,
    detectOccludersWithGemini, correspondenceFallback, ZERO_CORRECTION, extractTextureLineSamples, loadTexturedScene,
    evaluateFrameGates, PLAN_GATES, TEXTURING_GATES, plateRecordCamera, readPlateMask, frameCameraToPose, frameCamera, OCCLUDER_PROMPT_VERSION,
    STREETVIEW_GEMINI_MODEL,
    type PanoRegistrationInput, type PanoRegistrationResult, type OccluderBox, type StreetViewPlatesFile, type StreetViewPlateRecord,
    type RegistrationGates, type PoseCorrection, type RgbaImage, type GateInput, type TexturedPrimitive, type FrameCamera
} from '../packages/core/src/node/spatial/StreetViewPoseRegistrar';
import {
    StreetViewFeatureRegistrar, evaluateFeatureGates, featurePoseQuality, DEFAULT_FEATURE_GATES,
    type FeatureGates, type FeatureGateInput, type FeaturePanoInput, type FeaturePanoResult
} from '../packages/core/src/node/spatial/StreetViewFeatureRegistrar';
import { StreetViewCrossViewRefiner, refineWithTileAnchor, tileAnchorLandscapes, type CrossViewFrame } from '../packages/core/src/node/spatial/StreetViewCrossViewRefiner';
import { encodePng } from '../packages/core/src/node/texture-processing';

const REPO = path.resolve(__dirname, '..');
const SECRET_ENV = ['GOOGLE_MAPS_API_KEY', 'MAP_TILES_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_GENAI_API_KEY', 'GOOGLE_AI_API_KEY'];
/** Bumped when the feature registration changes in a way that invalidates cached per-pano results. */
const FEATURE_REGISTRATION_VERSION = 'feature-pnp-2';

function loadDotEnv() {
    const p = path.join(REPO, '.env');
    if (!fs.existsSync(p)) return;
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
        const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
        if (!m || process.env[m[1]]) continue;
        process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
    }
}

/** Removes the value of every known secret environment variable from a message. */
function redactSecrets(text: string): string {
    let out = text;
    for (const k of SECRET_ENV) { const v = process.env[k]; if (v && v.length >= 8) out = out.split(v).join('<redacted>'); }
    return out;
}

interface Args {
    glb: string; anchor: string; maxFrames: number; out: string; planOnly: boolean; noFetch: boolean; gemini: boolean; redetect: boolean;
    maxBilled: number; framesPerPano: number; radius: number; spacing: number; cameraHeight: number; panos: string[]; seedFrames?: string;
    method: 'feature' | 'rigid'; framesFromCache: boolean; jobs: number; workerTimeoutMin: number; forceRegistration: boolean; platesDir?: string;
    gates: Partial<RegistrationGates>; featureGates: Partial<FeatureGates>;
    maxFallbacks: number;
    regate: boolean; reuseRegistration: boolean; reuseCrossView: boolean; crossView: boolean; crossViewStart: 'rot' | 'reg' | 'gps';
}

function parseArgs(argv: string[]): Args {
    const a: Partial<Args> & { gates: Partial<RegistrationGates>; featureGates: Partial<FeatureGates>; panos: string[] } = {
        maxFrames: 40, planOnly: false, noFetch: false, gemini: true, redetect: false, maxBilled: STREETVIEW_BILLING_HARD_CAP,
        framesPerPano: 3, radius: 450, spacing: 12, cameraHeight: 2.5, panos: [], gates: {}, featureGates: {}, maxFallbacks: 6,
        method: 'feature', framesFromCache: false, jobs: 1, workerTimeoutMin: 240, forceRegistration: false,
        regate: false, reuseRegistration: false, reuseCrossView: false, crossView: true, crossViewStart: 'rot'
    };
    const value = (k: string, i: number) => {
        const v = argv[i];
        if (v === undefined || v.startsWith('--')) throw new Error(`${k} needs a value`);
        return v;
    };
    const num = (k: string, v: string, opts: { min?: number; max?: number; integer?: boolean } = {}) => {
        const n = Number(v);
        if (!Number.isFinite(n) || (opts.integer && !Number.isInteger(n)) || (opts.min !== undefined && n < opts.min) || (opts.max !== undefined && n > opts.max)) {
            throw new Error(`${k} must be a${opts.integer ? 'n integer' : ' number'}${opts.min !== undefined ? ` >= ${opts.min}` : ''}${opts.max !== undefined ? ` and <= ${opts.max}` : ''} (got "${v}")`);
        }
        return n;
    };
    const gate = (k: string, v: string) => (v === 'off' ? null : num(k, v, { min: 0 }));
    for (let i = 0; i < argv.length; i++) {
        const k = argv[i];
        const v = () => value(k, ++i);
        switch (k) {
            case '--glb': a.glb = v(); break;
            case '--anchor': a.anchor = v(); break;
            case '--out': a.out = v(); break;
            case '--max-frames': a.maxFrames = num(k, v(), { min: 1, integer: true }); break;
            case '--plan-only': a.planOnly = true; break;
            case '--no-fetch': a.noFetch = true; break;
            case '--no-gemini': a.gemini = false; break;
            case '--redetect-occluders': a.redetect = true; break;
            case '--max-billed': a.maxBilled = num(k, v(), { min: 0, max: STREETVIEW_BILLING_HARD_CAP, integer: true }); break;
            case '--ledger': throw new Error('--ledger was removed: billing is always counted in the global ledger (<repo>/.scratchbox/streetview_cache/billing_ledger.json)');
            case '--frames-per-pano': a.framesPerPano = num(k, v(), { min: 1, integer: true }); break;
            case '--radius': a.radius = num(k, v(), { min: 1 }); break;
            case '--spacing': a.spacing = num(k, v(), { min: 1 }); break;
            case '--camera-height': a.cameraHeight = num(k, v(), { min: 0 }); break;
            case '--pano': a.panos.push(v()); break;
            case '--seed-frames': a.seedFrames = v(); break;
            case '--method': { const m = v(); if (m !== 'feature' && m !== 'rigid') throw new Error('--method must be feature or rigid'); a.method = m; break; }
            case '--frames-from-cache': a.framesFromCache = true; break;
            case '--plates-dir': a.platesDir = v(); break;
            case '--jobs': a.jobs = num(k, v(), { min: 1, max: 32, integer: true }); break;
            case '--worker-timeout-min': a.workerTimeoutMin = num(k, v(), { min: 1 }); break;
            case '--force-registration': a.forceRegistration = true; break;
            case '--max-fallbacks': a.maxFallbacks = num(k, v(), { min: 0, integer: true }); break;
            case '--regate': a.regate = true; break;
            case '--reuse-registration': a.reuseRegistration = true; break;
            case '--reuse-cross-view': a.reuseRegistration = true; a.reuseCrossView = true; break;
            case '--no-cross-view': a.crossView = false; break;
            case '--cross-view-start': { const s = v(); if (s !== 'rot' && s !== 'reg' && s !== 'gps') throw new Error('--cross-view-start must be rot, reg or gps'); a.crossViewStart = s; break; }
            // Feature gate overrides (DEFAULT_FEATURE_GATES otherwise)
            case '--gate-edge-px': a.featureGates.interiorEdgeMedianPx = num(k, v(), { min: 0 }); break;
            case '--gate-heldout-px': a.featureGates.heldOutEdgeMedianPx = num(k, v(), { min: 0 }); break;
            case '--gate-min-inliers': a.featureGates.minInliers = num(k, v(), { min: 0, integer: true }); break;
            case '--gate-ncc-gain': a.featureGates.minNccGain = num(k, v()); break;
            // Rigid gate overrides (TEXTURING_GATES otherwise); 'off' disables a gate
            case '--gate-silhouette-px': a.gates.silhouetteMedianPx = gate(k, v()); break;
            case '--gate-line-px': a.gates.creaseMedianPx = gate(k, v()); break;
            case '--gate-sky-iou': a.gates.skyIoU = gate(k, v()); break;
            case '--gate-agree-m': a.gates.frameAgreementMeters = gate(k, v()); break;
            case '--gate-agree-deg': a.gates.frameAgreementDeg = gate(k, v()); break;
            case '--gate-min-ncc': a.gates.minPhotometricNcc = v() === 'off' ? null : num(k, argv[i]); break;
            case '--gate-min-peak': a.gates.minPhotometricPeak = v() === 'off' ? null : num(k, argv[i]); break;
            case '--gate-cross-px': { const g = gate(k, v()); a.gates.crossViewMedianPx = g; if (g !== null) a.featureGates.crossViewMedianPx = g; break; }
            case '--gate-cross-p75': a.gates.crossViewP75Px = gate(k, v()); break;
            case '--gate-cross-min-matches': { const n = num(k, v(), { min: 1, integer: true }); a.gates.crossViewMinMatches = n; a.featureGates.crossViewMinMatches = n; break; }
            default: throw new Error(`Unknown argument ${k}`);
        }
    }
    for (const req of ['glb', 'anchor', 'out'] as const) if (!a[req]) throw new Error(`--${req} is required`);
    return a as Args;
}

const log = (msg: string) => console.log(`[sv] ${redactSecrets(msg)}`);
const round = (v: number | null | undefined, d = 2) => (v === null || v === undefined || !Number.isFinite(v) ? null : Number(v.toFixed(d)));
const roundCorr = (c: PoseCorrection) => Object.fromEntries(Object.entries(c).map(([k, v]) => [k, round(v as number, 4)])) as unknown as PoseCorrection;
const DEG = Math.PI / 180;

interface FrameCtx {
    cf: CachedFrame;
    pano: PanoRecord;
    image: RgbaImage;
    occluders: OccluderBox[];
    valid: Uint8Array;
}

interface ScanCtx {
    args: Args; glbPath: string; outDir: string; platesDir: string; origin: { lat: number; lng: number; heightMeters: number };
    scan: ScanMesh; ground: GroundModel; hero: HeroModel; targets: TargetSamples; scanKey: string;
}

// ============================================================================================
// Scan analysis, street visibility
// ============================================================================================

function analyseScan(args: Args): ScanCtx {
    const glbPath = path.resolve(REPO, args.glb);
    const outDir = path.resolve(REPO, args.out);
    const platesDir = args.platesDir ? path.resolve(REPO, args.platesDir) : path.join(outDir, 'plates');
    fs.mkdirSync(path.join(platesDir, 'overlays'), { recursive: true });
    fs.mkdirSync(path.join(outDir, 'occluders'), { recursive: true });
    const origin = parseAnchor(args.anchor);
    const scan = loadScanMesh(glbPath);
    const ground = buildGroundModel(scan);
    const hero = findHeroFootprint(scan, ground);
    const targets = buildTargetSamples(scan, ground, hero);
    log(`scan: ${scan.triCount} triangles; hero footprint ${hero.areaM2.toFixed(0)} m2, height ${hero.heightMeters.toFixed(1)} m above ground ${hero.groundY.toFixed(2)}, ` +
        `grid yaw ${hero.gridYawDeg.toFixed(2)} deg; ${targets.count} target samples`);
    const st = fs.statSync(glbPath);
    const scanKey = `${st.size}_${Math.round(st.mtimeMs)}_${targets.count}`;
    return { args, glbPath, outDir, platesDir, origin, scan, ground, hero, targets, scanKey };
}

/** Hero samples visible from any of `eyes` (street-visible facade), from the visibility cache (computed when missing). */
function streetVisibility(c: ScanCtx, panos: Array<{ panoId: string; eye: [number, number, number] }>): Uint8Array {
    const vis = new Uint8Array(c.targets.count);
    const t0 = Date.now();
    panos.forEach((p, i) => {
        const v = computePanoVisibilityCached(c.scan, c.targets, p.eye, p.panoId, path.join(c.outDir, 'visibility'), c.scanKey);
        for (const s of v.idx) vis[s] = 1;
        if ((i + 1) % 40 === 0) log(`street visibility ${i + 1}/${panos.length} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
    });
    return vis;
}

/** Panos of an earlier plan.json, placed on THIS scan (street height re-measured; no network). */
function panosFromPlan(c: ScanCtx): PanoRecord[] {
    const plan = JSON.parse(fs.readFileSync(path.join(c.outDir, 'plan.json'), 'utf8'));
    return plan.panos.map((p: any) => {
        let streetY = localStreetHeight(c.scan, c.ground, p.x, p.z);
        if (!(streetY === streetY)) streetY = p.streetY;
        return {
            panoId: p.panoId, lat: NaN, lng: NaN, date: p.date, copyright: '© Google', x: p.x, z: p.z, streetY,
            eye: [p.x, streetY + c.args.cameraHeight, p.z], distanceToHeroMeters: p.distanceToHeroMeters ?? Math.hypot(p.x - c.hero.centroid.x, p.z - c.hero.centroid.z)
        } as PanoRecord;
    });
}

// ============================================================================================
// E2-E4 acquisition (or the cache) and E5 masks
// ============================================================================================

async function acquireFrames(c: ScanCtx, apiKey: string): Promise<{ panoById: Map<string, PanoRecord>; frames: CachedFrame[]; allPanos: PanoRecord[] } | null> {
    const { args, outDir } = c;
    if (args.framesFromCache) {
        const allPanos = panosFromPlan(c);
        const panoById = new Map(allPanos.map(p => [p.panoId, p]));
        const frames: CachedFrame[] = [];
        for (const f of fs.readdirSync(outDir).filter(n => n.endsWith('.json'))) {
            const imagePath = path.join(outDir, f.replace(/\.json$/, '.jpg'));
            if (!fs.existsSync(imagePath)) continue;
            const m = JSON.parse(fs.readFileSync(path.join(outDir, f), 'utf8'));
            if (!m.panoId || !panoById.has(m.panoId)) continue;
            const cf: CandidateFrame = { panoId: m.panoId, headingDeg: Number(m.headingDeg), pitchDeg: Number(m.pitchDeg), fovDeg: Number(m.fovDeg), width: m.width ?? 640, height: m.height ?? 640 };
            frames.push({ ...cf, key: frameKey(cf), imagePath, metaPath: path.join(outDir, f), date: m.date, copyright: m.copyright, fromCache: true });
        }
        frames.sort((a, b) => a.key.localeCompare(b.key));
        log(`frames from cache: ${frames.length} cached frames of ${new Set(frames.map(f => f.panoId)).size} panos (no network requests)`);
        return { panoById, frames, allPanos };
    }
    if (!apiKey) throw new Error('GOOGLE_MAPS_API_KEY is not set (environment or .env); use --frames-from-cache to work offline');
    const disc = await discoverPanos(c.scan, c.ground, c.hero, {
        origin: c.origin, apiKey, radiusMeters: args.radius, sampleSpacingMeters: args.spacing, cameraHeightMeters: args.cameraHeight,
        cachePath: path.join(outDir, 'metadata_cache.json'), log
    });
    const panoById = new Map<string, PanoRecord>(disc.panos.map(p => [p.panoId, p]));
    const owned: CandidateFrame[] = [];
    if (args.seedFrames) {
        const seeds = JSON.parse(fs.readFileSync(path.resolve(REPO, args.seedFrames), 'utf8'));
        for (const s of seeds) {
            if (s.status !== 'OK' || !s.file || !fs.existsSync(s.file)) continue;
            const [w, h] = String(s.size ?? '640x640').split('x').map(Number);
            const f: CandidateFrame = { panoId: s.pano, headingDeg: Number(Number(s.heading).toFixed(2)), pitchDeg: Number(s.pitch), fovDeg: Number(s.fov), width: w, height: h };
            const key = frameKey(f);
            if (!fs.existsSync(path.join(outDir, `${key}.jpg`))) {
                fs.copyFileSync(s.file, path.join(outDir, `${key}.jpg`));
                fs.writeFileSync(path.join(outDir, `${key}.json`), JSON.stringify({ key, panoId: f.panoId, headingDeg: f.headingDeg, pitchDeg: f.pitchDeg, fovDeg: f.fovDeg, width: w, height: h, date: s.date, location: s.location, copyright: s.copyright, importedFrom: 'seed' }, null, 1));
            }
            if (panoById.has(f.panoId)) owned.push(f);
        }
        log(`seed frames: ${owned.length} reused from ${args.seedFrames}`);
    }
    // E3 visibility + greedy plan
    const tv = Date.now();
    const vis: PanoVisibility[] = [];
    for (const p of disc.panos) {
        vis.push(computePanoVisibilityCached(c.scan, c.targets, p.eye, p.panoId, path.join(outDir, 'visibility'), c.scanKey));
        if (vis.length % 20 === 0) log(`visibility ${vis.length}/${disc.panos.length} (${((Date.now() - tv) / 1000).toFixed(0)} s)`);
    }
    const streetVisible = new Uint8Array(c.targets.count);
    for (const v of vis) for (const s of v.idx) streetVisible[s] = 1;
    const plan = planFrames(vis, c.targets, { maxFrames: args.maxFrames, maxFramesPerPano: args.framesPerPano, ownedFrames: owned });
    const predicted = coverageReport(c.targets, c.hero, plan.best, streetVisible);
    fs.writeFileSync(path.join(outDir, 'plan.json'), JSON.stringify({
        createdAt: new Date().toISOString(), glbPath: c.glbPath, anchor: c.origin,
        hero: { areaM2: c.hero.areaM2, heightMeters: c.hero.heightMeters, groundY: c.hero.groundY, gridYawDeg: c.hero.gridYawDeg, sideHeadingsDeg: c.hero.sideHeadingsDeg, centroid: c.hero.centroid },
        discovery: { samplePoints: disc.samplePoints, metadataCalls: disc.metadataCalls, cachedCalls: disc.cachedCalls, panos: disc.panos.length, rejectedCopyright: disc.rejectedCopyright, rejectedOld: disc.rejectedOld },
        panos: disc.panos.map(p => ({ panoId: p.panoId, date: p.date, x: round(p.x), z: round(p.z), streetY: round(p.streetY), distanceToHeroMeters: round(p.distanceToHeroMeters, 1), visibleSamples: vis.find(v => v.panoId === p.panoId)?.idx.length ?? 0 })),
        candidates: plan.candidates,
        frames: plan.frames.map(f => ({ key: f.key, panoId: f.panoId, headingDeg: f.headingDeg, pitchDeg: f.pitchDeg, fovDeg: f.fovDeg, gainM2: round(f.gainM2, 1), coveredM2: round(f.coveredM2, 1) })),
        predictedCoverage: predicted.map(cc => ({ ...cc, areaM2: round(cc.areaM2, 0), streetVisibleM2: round(cc.streetVisibleM2, 0), coveredM2: round(cc.coveredM2, 0), coveredFractionOfVisible: round(cc.coveredFractionOfVisible, 3) }))
    }, null, 1));
    log(`plan: ${plan.frames.length} frames from ${new Set(plan.frames.map(f => f.panoId)).size} panos (${plan.candidates} candidates)`);
    if (args.planOnly) return null;
    let frames: CachedFrame[];
    if (args.noFetch) {
        frames = plan.frames.filter(f => fs.existsSync(path.join(outDir, `${f.key}.jpg`))).map(f => {
            const meta = JSON.parse(fs.readFileSync(path.join(outDir, `${f.key}.json`), 'utf8'));
            return { ...f, imagePath: path.join(outDir, `${f.key}.jpg`), metaPath: path.join(outDir, `${f.key}.json`), date: meta.date, copyright: meta.copyright, fromCache: true };
        });
    } else {
        const res = await fetchFrames(plan.frames, panoById, { apiKey, cacheDir: outDir, maxBilledRequests: args.maxBilled, log });
        frames = res.frames;
        log(`fetch: ${frames.length} frames (${res.billed} billed this run, cap ${res.cap}, ${res.skippedForCap} skipped by cap; ledger ${path.relative(REPO, res.ledgerPath)})`);
    }
    return { panoById, frames, allPanos: disc.panos };
}

async function loadOccluders(c: ScanCtx, frames: CachedFrame[]): Promise<{ occluders: Map<string, OccluderBox[]>; failures: string[]; gemini: Awaited<ReturnType<typeof createGeminiContentClient>> }> {
    const { args, outDir } = c;
    const gemini = args.gemini ? await createGeminiContentClient() : null;
    if (args.gemini && !gemini) log('Gemini unavailable: masking falls back to the watermark strip and cached detections');
    const occluders = new Map<string, OccluderBox[]>();
    const failures: string[] = [];
    let redetected = 0, staleKept = 0;
    const queue = frames.slice();
    await Promise.all(Array.from({ length: 4 }, async () => {
        for (let f = queue.shift(); f; f = queue.shift()) {
            const p = path.join(outDir, 'occluders', `${f.key}.json`);
            const cached = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
            const current = cached && cached.promptVersion === OCCLUDER_PROMPT_VERSION && !args.redetect;
            if (current) { occluders.set(f.key, cached.boxes); continue; }
            if (!gemini) { occluders.set(f.key, cached?.boxes ?? []); if (cached) staleKept++; continue; }
            try {
                const boxes = await detectOccludersWithGemini(gemini, fs.readFileSync(f.imagePath), f.width, f.height);
                fs.writeFileSync(p, JSON.stringify({ model: STREETVIEW_GEMINI_MODEL, promptVersion: OCCLUDER_PROMPT_VERSION, boxes }, null, 1));
                occluders.set(f.key, boxes); redetected++;
            } catch (e: any) {
                log(`occluder detection failed for ${f.key}: ${String(e?.message ?? e).slice(0, 200)}`);
                occluders.set(f.key, cached?.boxes ?? []); failures.push(f.key);
            }
        }
    }));
    log(`occluders: ${[...occluders.values()].reduce((a, b) => a + b.length, 0)} boxes on ${frames.length} frames (${redetected} detected now, ${staleKept} older-prompt detections kept, ${failures.length} failures)`);
    return { occluders, failures, gemini };
}

// ============================================================================================
// E6 feature registration: per-pano jobs (in process or in child processes with a timeout)
// ============================================================================================

interface FeatureJobPano {
    panoId: string; nominalEye: [number, number, number]; referenceHeadingDeg: number; inputKey: string;
    frames: Array<{ key: string; imagePath: string; occluders: OccluderBox[]; headingDeg: number; pitchDeg: number; fovDeg: number; width: number; height: number }>;
}
interface FeatureJob { glbPath: string; featureDir: string; panos: FeatureJobPano[] }
type StoredPanoResult = Omit<FeaturePanoResult, 'frames'> & { frames: Array<Omit<FeaturePanoResult['frames'][number], 'camera'>> };

function featureInputKey(glbPath: string, p: Omit<FeatureJobPano, 'inputKey'>): string {
    const st = fs.statSync(glbPath);
    const h = crypto.createHash('sha256');
    h.update(JSON.stringify({ v: FEATURE_REGISTRATION_VERSION, glb: [st.size, Math.round(st.mtimeMs)], eye: p.nominalEye.map(v => v.toFixed(3)), ref: p.referenceHeadingDeg, frames: p.frames.map(f => [f.key, f.occluders]) }));
    return h.digest('hex').slice(0, 24);
}

function runFeatureJob(job: FeatureJob, logf: (m: string) => void): void {
    const textured = loadTexturedScene(job.glbPath);
    const reg = new StreetViewFeatureRegistrar(textured, { log: logf });
    for (const p of job.panos) {
        const input: FeaturePanoInput = {
            panoId: p.panoId, nominalEye: p.nominalEye, referenceHeadingDeg: p.referenceHeadingDeg,
            frames: p.frames.map(f => {
                const image = decodeImageToRgba(fs.readFileSync(f.imagePath));
                return { key: f.key, image, valid: buildValidMask(image.width, image.height, { occluders: f.occluders }), headingDeg: f.headingDeg, pitchDeg: f.pitchDeg, fovDeg: f.fovDeg };
            })
        };
        const t0 = Date.now();
        const res = reg.registerPano(input);
        const stored: StoredPanoResult = { ...res, frames: res.frames.map(({ camera: _camera, ...rest }) => rest) };
        fs.writeFileSync(path.join(job.featureDir, `${p.panoId}.json`), JSON.stringify({ inputKey: p.inputKey, version: FEATURE_REGISTRATION_VERSION, result: stored }, null, 1));
        logf(`pano ${p.panoId}: ${res.frames.length} frames registered in ${((Date.now() - t0) / 1000).toFixed(0)} s, move ${res.moveMeters.toFixed(2)} m, dy ${res.correction.dy.toFixed(2)} m, dyaw ${res.correction.dyawDeg.toFixed(2)} deg`);
    }
}

/** Runs the jobs in child processes (vite-node, this script with --feature-worker), each killed after `timeoutMs`. */
async function runFeatureWorkers(jobs: FeatureJob[], featureDir: string, timeoutMs: number): Promise<void> {
    const bin = path.join(REPO, 'node_modules', '.bin', 'vite-node');
    await Promise.all(jobs.map((job, k) => new Promise<void>((resolve) => {
        const jobPath = path.join(featureDir, `job_${k}.json`);
        fs.writeFileSync(jobPath, JSON.stringify(job));
        const child = spawn(bin, [__filename, '--feature-worker', jobPath], { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
        const relay = (prefix: string) => (b: Buffer) => { for (const line of b.toString('utf8').split('\n')) if (line.trim()) log(`[worker ${k}${prefix}] ${line.replace(/^\[sv\] /, '')}`); };
        child.stdout.on('data', relay(''));
        child.stderr.on('data', relay(' err'));
        child.on('error', e => { clearTimeout(timer); log(`worker ${k} failed to start: ${e.message}`); resolve(); });
        child.on('close', code => {
            clearTimeout(timer);
            if (timedOut) log(`worker ${k} killed after the ${Math.round(timeoutMs / 60000)} min timeout (its unfinished panos stay unregistered)`);
            else if (code !== 0) log(`worker ${k} exited with code ${code}`);
            fs.rmSync(jobPath, { force: true });
            resolve();
        });
    })));
}

// ============================================================================================
// Feature method: registration, cross-frame agreement, gates, plates, coverage
// ============================================================================================

interface FeatureFrameRecord {
    key: string; panoId: string;
    gateInput: FeatureGateInput;
    stats: Record<string, unknown>;
    reasons: string[];
    poseQuality: number;
}

/** Red/cyan anaglyph of photo (red) and textured render (cyan), each normalised over the frame. */
function anaglyph(photo: Buffer, render: Buffer, W: number, H: number): Buffer {
    const lum = (b: Buffer, i: number) => 0.299 * b[i * 4] + 0.587 * b[i * 4 + 1] + 0.114 * b[i * 4 + 2];
    const n = W * H;
    let mp = 0, mr = 0, sp = 0, sr = 0;
    for (let i = 0; i < n; i++) { const a = lum(photo, i), b = lum(render, i); mp += a; mr += b; sp += a * a; sr += b * b; }
    mp /= n; mr /= n; sp = Math.sqrt(Math.max(1e-6, sp / n - mp * mp)); sr = Math.sqrt(Math.max(1e-6, sr / n - mr * mr));
    const o = Buffer.alloc(n * 4);
    for (let i = 0; i < n; i++) {
        const a = 128 + 50 * (lum(photo, i) - mp) / sp, b = 128 + 50 * (lum(render, i) - mr) / sr;
        o[i * 4] = Math.max(0, Math.min(255, a)); o[i * 4 + 1] = Math.max(0, Math.min(255, b)); o[i * 4 + 2] = Math.max(0, Math.min(255, b)); o[i * 4 + 3] = 255;
    }
    return o;
}

async function runFeature(c: ScanCtx) {
    const { args, outDir, platesDir } = c;
    const t0 = Date.now();
    const featureGates: FeatureGates = { ...DEFAULT_FEATURE_GATES, ...args.featureGates };
    const reportPath = path.join(platesDir, 'pose_report.json');
    if (args.regate) {
        const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
        const allPanos = panosFromPlan(c);
        finalizeFeature(c, report, featureGates, streetVisibility(c, allPanos.map(p => ({ panoId: p.panoId, eye: p.eye }))));
        return;
    }
    loadDotEnv();
    const apiKey = process.env.GOOGLE_MAPS_API_KEY || process.env.MAP_TILES_API_KEY || '';
    const acq = await acquireFrames(c, apiKey);
    if (!acq) return;
    const { panoById, allPanos } = acq;
    let frames = acq.frames;
    if (args.panos.length) frames = frames.filter(f => args.panos.includes(f.panoId));
    const { occluders, failures } = await loadOccluders(c, frames);

    // ---------------- E6 per-pano feature registration ----------------
    const featureDir = path.join(outDir, 'feature_registration');
    fs.mkdirSync(featureDir, { recursive: true });
    const byPano = new Map<string, CachedFrame[]>();
    for (const f of frames) { if (!byPano.has(f.panoId)) byPano.set(f.panoId, []); byPano.get(f.panoId)!.push(f); }
    const jobPanos: FeatureJobPano[] = [];
    for (const [panoId, pf] of byPano) {
        const pano = panoById.get(panoId)!;
        const base = {
            panoId, nominalEye: pano.eye, referenceHeadingDeg: pf[0].headingDeg,
            frames: pf.map(f => ({ key: f.key, imagePath: f.imagePath, occluders: occluders.get(f.key) ?? [], headingDeg: f.headingDeg, pitchDeg: f.pitchDeg, fovDeg: f.fovDeg, width: f.width, height: f.height }))
        };
        jobPanos.push({ ...base, inputKey: featureInputKey(c.glbPath, base) });
    }
    const cachedResult = (p: FeatureJobPano): StoredPanoResult | null => {
        const f = path.join(featureDir, `${p.panoId}.json`);
        if (!fs.existsSync(f)) return null;
        const j = JSON.parse(fs.readFileSync(f, 'utf8'));
        return j.inputKey === p.inputKey ? j.result : null;
    };
    const todo = jobPanos.filter(p => args.forceRegistration || !cachedResult(p));
    log(`feature registration: ${jobPanos.length} panos, ${todo.length} to register (${jobPanos.length - todo.length} cached results reused), ${Math.min(args.jobs, Math.max(1, todo.length))} job(s)`);
    const tr = Date.now();
    if (todo.length) {
        if (args.jobs <= 1) runFeatureJob({ glbPath: c.glbPath, featureDir, panos: todo }, m => log(m));
        else {
            // balance by frame count (registration cost is roughly proportional)
            const jobs: FeatureJob[] = Array.from({ length: Math.min(args.jobs, todo.length) }, () => ({ glbPath: c.glbPath, featureDir, panos: [] as FeatureJobPano[] }));
            const load = jobs.map(() => 0);
            for (const p of todo.slice().sort((a, b) => b.frames.length - a.frames.length)) { const k = load.indexOf(Math.min(...load)); jobs[k].panos.push(p); load[k] += p.frames.length; }
            await runFeatureWorkers(jobs, featureDir, args.workerTimeoutMin * 60_000);
        }
    }
    const results = new Map<string, StoredPanoResult>();
    for (const p of jobPanos) { const r = cachedResult(p); if (r) results.set(p.panoId, r); else log(`pano ${p.panoId}: no registration result (worker failed or timed out)`); }
    log(`feature registration done in ${Math.round((Date.now() - tr) / 1000)} s: ${results.size}/${jobPanos.length} panos`);

    // ---------------- frame contexts at the final poses ----------------
    const ctxs = new Map<string, FrameCtx>();
    for (const cf of frames) {
        const occ = occluders.get(cf.key) ?? [];
        const image = decodeImageToRgba(fs.readFileSync(cf.imagePath));
        ctxs.set(cf.key, { cf, pano: panoById.get(cf.panoId)!, image, occluders: occ, valid: buildValidMask(cf.width, cf.height, { occluders: occ }) });
    }
    const jobOf = new Map(jobPanos.map(p => [p.panoId, p]));
    const camOf = (panoId: string, key: string, corr: PoseCorrection): FrameCamera => {
        const jp = jobOf.get(panoId)!, fr = jp.frames.find(f => f.key === key)!;
        return frameCamera(jp.nominalEye, fr.headingDeg, fr.pitchDeg, fr.fovDeg, fr.width, fr.height, corr, jp.referenceHeadingDeg);
    };

    // ---------------- E6c cross-view consistency between panos at the final poses ----------------
    let crossPairs: Array<{ a: string; b: string; matches: number; medianPx: number | null }> = [];
    const keyPano = new Map(frames.map(f => [f.key, f.panoId]));
    if (args.crossView && results.size > 1) {
        const tc = Date.now();
        const cvFrames: CrossViewFrame[] = [];
        const corrs = new Map<string, PoseCorrection>();
        for (const [panoId, r] of results) {
            corrs.set(panoId, r.correction);
            const jp = jobOf.get(panoId)!;
            for (const fr of jp.frames) {
                const x = ctxs.get(fr.key)!;
                cvFrames.push({ key: fr.key, panoId, nominalEye: jp.nominalEye, headingDeg: fr.headingDeg, pitchDeg: fr.pitchDeg, fovDeg: fr.fovDeg, referenceHeadingDeg: jp.referenceHeadingDeg, image: x.image, valid: x.valid });
            }
        }
        const refiner = new StreetViewCrossViewRefiner(c.scan.mesh, cvFrames, { log });
        const m = refiner.measure(corrs);
        crossPairs = m.pairs.map(p => ({ a: p.a, b: p.b, matches: p.matches, medianPx: p.medianPx }));
        log(`cross-view: ${m.matches.length} photo-to-photo matches over ${m.pairs.filter(p => p.matches > 0).length} frame pairs in ${Math.round((Date.now() - tc) / 1000)} s`);
    }

    // ---------------- report ----------------
    const report: any = {
        createdAt: new Date().toISOString(), method: 'feature-pnp', version: FEATURE_REGISTRATION_VERSION, glbPath: c.glbPath, scanKey: c.scanKey,
        occluderPromptVersion: OCCLUDER_PROMPT_VERSION, occluderDetectionFailures: failures, crossPairs: crossPairs.map(p => ({ ...p, medianPx: round(p.medianPx) })),
        panos: [] as any[]
    };
    const textured = loadTexturedScene(c.glbPath);
    const reg = new StreetViewFeatureRegistrar(textured, {});
    for (const jp of jobPanos) {
        const r = results.get(jp.panoId);
        const pano = panoById.get(jp.panoId)!;
        const pr: any = {
            panoId: jp.panoId, date: pano.date, nominalEye: jp.nominalEye.map(v => round(v, 4)), referenceHeadingDeg: jp.referenceHeadingDeg,
            registered: !!r, frames: [] as any[]
        };
        if (r) Object.assign(pr, {
            correction: roundCorr(r.correction), moveMeters: round(r.moveMeters), moveBearingDeg: round(r.moveBearingDeg, 1), atBound: r.atBound,
            seed: { label: r.seed.label, denseScore: round(r.seed.denseScore, 4), tried: r.seed.tried.map(t => ({ label: t.label, denseScore: round(t.denseScore, 4), edgeCostPx: round(t.edgeCostPx, 3), inliers: t.inliers })) },
            inliers: r.inliers, matches: r.matches, timingsMs: r.timingsMs
        });
        for (const fr of jp.frames) {
            const x = ctxs.get(fr.key)!;
            const fs_ = r?.frames.find(q => q.key === fr.key);
            const rec: any = { key: fr.key, headingDeg: fr.headingDeg, pitchDeg: fr.pitchDeg, fovDeg: fr.fovDeg, occluders: x.occluders.length };
            if (r && fs_) {
                const gi: FeatureGateInput = {
                    inliers: fs_.inliers, edgeMedianPx: fs_.edges.medianPx, edgeLocated: fs_.edges.located, nccFinal: fs_.nccFinal, nccPrior: fs_.nccPrior,
                    heldOutEdgeMedianPx: fs_.heldOut ? fs_.heldOut.edges.medianPx : null, hasOtherFrames: jp.frames.length > 1, crossView: null, atBound: r.atBound
                };
                rec.gateInput = gi;
                rec.stats = {
                    matches: fs_.matches, inliers: fs_.inliers, inlierMedianPx: round(fs_.inlierMedianPx), matchMedianPx: round(fs_.matchMedianPx),
                    edges: { ...fs_.edges, medianPx: round(fs_.edges.medianPx), p75Px: round(fs_.edges.p75Px), locatedLengthPx: round(fs_.edges.locatedLengthPx, 0), truncatedCostPx: round(fs_.edges.truncatedCostPx, 3) },
                    edgesAtGps: { ...fs_.edgesPrior, medianPx: round(fs_.edgesPrior.medianPx), p75Px: round(fs_.edgesPrior.p75Px), locatedLengthPx: round(fs_.edgesPrior.locatedLengthPx, 0), truncatedCostPx: round(fs_.edgesPrior.truncatedCostPx, 3) },
                    orientationNcc: { gps: round(fs_.nccPrior, 4), final: round(fs_.nccFinal, 4), gain: fs_.nccFinal !== null && fs_.nccPrior !== null ? round(fs_.nccFinal - fs_.nccPrior, 4) : null, pixels: fs_.nccPixels },
                    luminanceNcc: { gps: round(fs_.lumNccPrior, 4), final: round(fs_.lumNccFinal, 4) },
                    heldOut: fs_.heldOut ? { correction: roundCorr(fs_.heldOut.correction), edgeMedianPx: round(fs_.heldOut.edges.medianPx), located: fs_.heldOut.edges.located, truncatedCostPx: round(fs_.heldOut.edges.truncatedCostPx, 3), inlierMedianPx: round(fs_.heldOut.inlierMedianPx), displacementPx: round(fs_.heldOut.displacementPx) } : null
                };
                // overlay: photo vs textured render (red/cyan) at the GPS pose | at the final pose
                const W = fr.width, H = fr.height;
                const r0 = reg.render(camOf(jp.panoId, fr.key, ZERO_CORRECTION)).rgba, r1 = reg.render(camOf(jp.panoId, fr.key, r.correction)).rgba;
                const a0 = anaglyph(x.image.rgba, r0, W, H), a1 = anaglyph(x.image.rgba, r1, W, H);
                const both = Buffer.alloc(2 * W * H * 4 + 0);
                for (let y = 0; y < H; y++) { a0.copy(both, y * 2 * W * 4, y * W * 4, (y + 1) * W * 4); a1.copy(both, (y * 2 * W + W) * 4, y * W * 4, (y + 1) * W * 4); }
                const overlayRel = path.join('overlays', `${fr.key}.png`);
                fs.writeFileSync(path.join(platesDir, overlayRel), encodePng(2 * W, H, both));
                rec.overlay = overlayRel; // relative to the plates directory
            }
            pr.frames.push(rec);
        }
        report.panos.push(pr);
    }
    const allEyes = allPanos.map(p => ({ panoId: p.panoId, eye: p.eye as [number, number, number] }));
    finalizeFeature(c, report, featureGates, streetVisibility(c, allEyes), { ctxs, camOf });
    log(`done in ${Math.round((Date.now() - t0) / 1000)} s`);
}

/**
 * Gates (with the cross-view partner fixpoint), plates for the accepted frames and their coverage. Works on a fresh
 * report or on one read back from disk (--regate: plates are rebuilt from the stored poses).
 */
function finalizeFeature(c: ScanCtx, report: any, gates: FeatureGates, streetVisible: Uint8Array, live?: { ctxs: Map<string, FrameCtx>; camOf: (p: string, k: string, corr: PoseCorrection) => FrameCamera }) {
    const { platesDir, outDir } = c;
    const frames: Array<{ pano: any; fr: any }> = [];
    for (const p of report.panos) for (const fr of p.frames) if (fr.gateInput) frames.push({ pano: p, fr });
    const pairs: Array<{ a: string; b: string; matches: number; medianPx: number | null }> = report.crossPairs ?? [];
    // Cross-frame agreement: a frame's cross-view partner must itself be accepted. Start from the frames that pass every
    // other gate and iterate to a fixpoint.
    const selfOk = (gi: FeatureGateInput) => evaluateFeatureGates({ ...gi, hasOtherFrames: false, heldOutEdgeMedianPx: null, crossView: { medianPx: 0, matches: Number.MAX_SAFE_INTEGER, partnerPanoId: '' } }, gates).length === 0
        && (!gi.hasOtherFrames || (gi.heldOutEdgeMedianPx !== null && gi.heldOutEdgeMedianPx <= gates.heldOutEdgeMedianPx));
    let accepted = new Set(frames.filter(x => selfOk(x.fr.gateInput)).map(x => x.fr.key));
    const panoOf = new Map(frames.map(x => [x.fr.key, x.pano.panoId as string]));
    const bestPartner = (key: string, pool: Set<string>) => {
        let best: { medianPx: number; matches: number; partnerPanoId: string } | null = null;
        let fallback: { medianPx: number; matches: number; partnerPanoId: string } | null = null;
        for (const p of pairs) {
            if (p.a !== key && p.b !== key) continue;
            const other = p.a === key ? p.b : p.a;
            if (!pool.has(other) || panoOf.get(other) === panoOf.get(key) || p.medianPx === null) continue;
            const cand = { medianPx: p.medianPx, matches: p.matches, partnerPanoId: panoOf.get(other)! };
            if (p.matches >= gates.crossViewMinMatches) { if (!best || cand.medianPx < best.medianPx) best = cand; }
            else if (!fallback || cand.matches > fallback.matches) fallback = cand;
        }
        return best ?? fallback;
    };
    for (let it = 0; it < 10; it++) {
        const next = new Set<string>();
        for (const { fr } of frames) {
            const gi: FeatureGateInput = { ...fr.gateInput, crossView: bestPartner(fr.key, accepted) };
            if (!evaluateFeatureGates(gi, gates).length) next.add(fr.key);
        }
        const same = next.size === accepted.size && [...next].every(k => accepted.has(k));
        accepted = next;
        if (same) break;
    }
    const platesFile: StreetViewPlatesFile = {
        version: 1, createdAt: new Date().toISOString(), glbPath: c.glbPath, anchor: c.origin,
        frameConvention: 'x=East,y=Up,z=South(-North); heading clockwise from north', plates: [], rejected: []
    };
    const acceptedUtility = new Float32Array(c.targets.count), allUtility = new Float32Array(c.targets.count);
    const addUtility = (dst: Float32Array, panoId: string, cam: FrameCamera, valid: Uint8Array) => {
        const v = computePanoVisibilityCached(c.scan, c.targets, cam.eye, `${panoId}_reg`, path.join(outDir, 'visibility'), c.scanKey);
        const util = cameraUtilities(v, c.targets, cam, valid);
        for (let k = 0; k < v.idx.length; k++) if (util[k] > dst[v.idx[k]]) dst[v.idx[k]] = util[k];
    };
    for (const { pano, fr } of frames) {
        const gi: FeatureGateInput = { ...fr.gateInput, crossView: bestPartner(fr.key, accepted) };
        fr.gateInput = gi;
        const reasons = evaluateFeatureGates(gi, gates);
        const q = featurePoseQuality(gi, gates);
        fr.accepted = reasons.length === 0; fr.reasons = reasons; fr.poseQuality = round(q, 4);
        const corr: PoseCorrection = pano.correction;
        const W = 640, H = 640;
        let cam: FrameCamera;
        let valid: Uint8Array;
        if (live) { const x = live.ctxs.get(fr.key)!; cam = live.camOf(pano.panoId, fr.key, corr); valid = x.valid; }
        else {
            const meta = JSON.parse(fs.readFileSync(path.join(outDir, `${fr.key}.json`), 'utf8'));
            cam = frameCamera(pano.nominalEye, fr.headingDeg, fr.pitchDeg, fr.fovDeg, meta.width ?? W, meta.height ?? H, corr, pano.referenceHeadingDeg);
            const occ = fs.existsSync(path.join(outDir, 'occluders', `${fr.key}.json`)) ? JSON.parse(fs.readFileSync(path.join(outDir, 'occluders', `${fr.key}.json`), 'utf8')).boxes : [];
            valid = buildValidMask(cam.width, cam.height, { occluders: occ });
        }
        addUtility(allUtility, pano.panoId, cam, valid);
        if (reasons.length) { platesFile.rejected.push({ id: fr.key, panoId: pano.panoId, reasons }); continue; }
        const plateDepth = renderPlateDepth(c.scan.mesh, cam, valid);
        const depthRel = `${fr.key}.depth.f32`, maskRel = `${fr.key}.mask.png`;
        fs.writeFileSync(path.join(platesDir, depthRel), encodeDepthF32(plateDepth));
        fs.writeFileSync(path.join(platesDir, maskRel), encodeMaskPng(valid, cam.width, cam.height));
        const metaPath = path.join(outDir, `${fr.key}.json`);
        const meta = fs.existsSync(metaPath) ? JSON.parse(fs.readFileSync(metaPath, 'utf8')) : {};
        const occ = live ? live.ctxs.get(fr.key)!.occluders : (fs.existsSync(path.join(outDir, 'occluders', `${fr.key}.json`)) ? JSON.parse(fs.readFileSync(path.join(outDir, 'occluders', `${fr.key}.json`), 'utf8')).boxes : []);
        const plate: StreetViewPlateRecord = {
            id: fr.key, panoId: pano.panoId, date: meta.date ?? pano.date, copyright: meta.copyright,
            imagePath: path.relative(platesDir, path.join(outDir, `${fr.key}.jpg`)), depthPath: depthRel, maskPngPath: maskRel,
            overlayPngPath: fs.existsSync(path.join(platesDir, 'overlays', `${fr.key}.png`)) ? path.join('overlays', `${fr.key}.png`) : undefined,
            width: cam.width, height: cam.height, request: { headingDeg: fr.headingDeg, pitchDeg: fr.pitchDeg, fovDeg: fr.fovDeg },
            pose: frameCameraToPose(cam), intrinsics: streetViewIntrinsics(fr.fovDeg, cam.width, cam.height),
            station: stationForFrame(frames.findIndex(q => q.fr === fr), fr.key, cam, fr.fovDeg, c.origin, pano.nominalEye[1] - c.args.cameraHeight),
            poseQuality: q, occluders: occ,
            registration: {
                method: 'feature-pnp', correction: corr, moveMeters: Math.hypot(corr.dx, corr.dz),
                creaseMedianPx: null, silhouetteMedianPx: null, skyIoU: null,
                feature: { ...fr.stats, gateInput: gi, gates }
            }
        };
        platesFile.plates.push(plate);
        addUtility(acceptedUtility, pano.panoId, cam, valid);
    }
    const cov = (u: Float32Array) => coverageReport(c.targets, c.hero, u, streetVisible).map(cc => ({ ...cc, areaM2: round(cc.areaM2, 0), streetVisibleM2: round(cc.streetVisibleM2, 0), coveredM2: round(cc.coveredM2, 0), coveredFractionOfVisible: round(cc.coveredFractionOfVisible, 3) }));
    report.gates = gates;
    report.coverageAccepted = cov(acceptedUtility);
    report.coverageAllFrames = cov(allUtility);
    const below120 = (cells: any[]) => {
        let vis = 0, covd = 0;
        for (const cc of cells) if (!String(cc.side).startsWith('roof') && parseFloat(cc.band) < 120) { vis += cc.streetVisibleM2; covd += cc.coveredM2; }
        return { vis, covd, frac: vis ? Number((covd / vis).toFixed(3)) : 0 };
    };
    const acc = below120(report.coverageAccepted), all = below120(report.coverageAllFrames);
    const fr = frames.map(x => x.fr);
    const med = (v: number[]) => { const a = v.filter(Number.isFinite).sort((p, q) => p - q); return a.length ? round(a[a.length >> 1]) : null; };
    report.summary = {
        panos: report.panos.length, panosRegistered: report.panos.filter((p: any) => p.registered).length, frames: report.panos.reduce((a: number, p: any) => a + p.frames.length, 0),
        accepted: platesFile.plates.length, rejected: platesFile.rejected.length,
        acceptedEdgeMedianPx: med(fr.filter(f => f.accepted).map(f => f.gateInput.edgeMedianPx)),
        allEdgeMedianPxAtFinal: med(fr.map(f => f.gateInput.edgeMedianPx ?? NaN)), allEdgeMedianPxAtGps: med(fr.map(f => f.stats?.edgesAtGps?.medianPx ?? NaN)),
        facadeBelow120mStreetVisibleM2: acc.vis, facadeBelow120mCoveredM2: acc.covd, facadeBelow120mCoveredFraction: acc.frac,
        facadeBelow120mCoveredFractionIfAllFramesAccepted: all.frac,
        note: 'coverage counts a hero facade sample as covered when an accepted frame sees it (visible, cos >= 0.3, Street View footprint <= 0.5 tile texel) through its plate mask; street-visible = visible from any discovered pano'
    };
    fs.writeFileSync(path.join(platesDir, 'pose_report.json'), JSON.stringify(report, null, 1));
    fs.writeFileSync(path.join(platesDir, 'plates.json'), JSON.stringify(platesFile, null, 1));
    log(`plates: ${platesFile.plates.length} accepted / ${platesFile.rejected.length} rejected -> ${path.relative(REPO, path.join(platesDir, 'plates.json'))}`);
    log(`coverage of street-visible hero facade below 120 m: ${(acc.frac * 100).toFixed(1)} % by accepted frames (${(all.frac * 100).toFixed(1)} % if every frame were accepted)`);
}

// ============================================================================================
// Rigid method (earlier silhouette / line registrar + joint cross-view refinement)
// ============================================================================================

async function runRigid(c: ScanCtx) {
    const { args, outDir, platesDir, scan, targets, origin, glbPath } = c;
    const t0 = Date.now();
    const gates = { ...TEXTURING_GATES, ...args.gates } as RegistrationGates;
    const reportPath = path.join(platesDir, 'pose_report.json');
    const streetVisibleFromCache = () => {
        const streetVisible = new Uint8Array(targets.count);
        const scanTag = `_${c.scanKey}_`.replace(/[^A-Za-z0-9_.-]/g, '_');
        const visDir = path.join(outDir, 'visibility');
        if (fs.existsSync(visDir)) for (const f of fs.readdirSync(visDir).filter(n => n.endsWith('.vis') && !n.includes('_reg_') && n.includes(scanTag))) {
            const b = fs.readFileSync(path.join(visDir, f));
            const n = b.readUInt32LE(0);
            for (let k = 0; k < n; k++) streetVisible[b.readUInt32LE(4 + k * 4)] = 1;
        }
        return streetVisible;
    };
    if (args.regate) {
        const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
        finalizePlates(report, gates, platesDir, { scan, hero: c.hero, targets, streetVisible: streetVisibleFromCache(), origin, glbPath, scanKey: c.scanKey, outDir });
        return;
    }
    loadDotEnv();
    const apiKey = process.env.GOOGLE_MAPS_API_KEY || process.env.MAP_TILES_API_KEY || '';
    let panoById: Map<string, PanoRecord>;
    let frames: CachedFrame[];
    let streetVisible: Uint8Array;
    const previous = args.reuseRegistration ? JSON.parse(fs.readFileSync(reportPath, 'utf8')) : null;
    if (previous) {
        const plan = JSON.parse(fs.readFileSync(path.join(outDir, 'plan.json'), 'utf8'));
        panoById = new Map();
        for (const p of previous.panos) {
            const pp = plan.panos.find((q: any) => q.panoId === p.panoId);
            panoById.set(p.panoId, { panoId: p.panoId, lat: NaN, lng: NaN, date: p.date, copyright: '© Google', x: pp?.x ?? p.nominalEye[0], z: pp?.z ?? p.nominalEye[2], streetY: pp?.streetY ?? p.nominalEye[1] - args.cameraHeight, eye: p.nominalEye, distanceToHeroMeters: pp?.distanceToHeroMeters ?? NaN } as unknown as PanoRecord);
        }
        frames = [];
        for (const p of previous.panos) for (const fr of p.frames) {
            const imagePath = path.join(outDir, `${fr.key}.jpg`), metaPath = path.join(outDir, `${fr.key}.json`);
            if (!fs.existsSync(imagePath)) continue;
            const m = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
            frames.push({ panoId: p.panoId, headingDeg: fr.headingDeg, pitchDeg: fr.pitchDeg, fovDeg: fr.fovDeg, width: m.width ?? 640, height: m.height ?? 640, key: fr.key, imagePath, metaPath, date: m.date, copyright: m.copyright, fromCache: true });
        }
        streetVisible = streetVisibleFromCache();
        log(`reuse: ${frames.length} cached frames of ${panoById.size} registered panos from ${path.relative(REPO, reportPath)}`);
    } else {
        const acq = await acquireFrames(c, apiKey);
        if (!acq) return;
        panoById = acq.panoById; frames = acq.frames;
        streetVisible = streetVisibility(c, acq.allPanos.map(p => ({ panoId: p.panoId, eye: p.eye })));
    }
    const { occluders, failures: occluderFailures, gemini } = await loadOccluders(c, frames);
    const ctxs = new Map<string, FrameCtx>();
    for (const cf of frames) {
        const pano = panoById.get(cf.panoId);
        if (!pano) continue;
        const occ = occluders.get(cf.key) ?? [];
        ctxs.set(cf.key, { cf, pano, image: decodeImageToRgba(fs.readFileSync(cf.imagePath)), occluders: occ, valid: buildValidMask(cf.width, cf.height, { occluders: occ }) });
    }

    // ---------------- E6a per-pano registration (absolute rotation anchor) ----------------
    const byPano = new Map<string, CachedFrame[]>();
    for (const f of frames) { if (!byPano.has(f.panoId)) byPano.set(f.panoId, []); byPano.get(f.panoId)!.push(f); }
    const report: any = { createdAt: new Date().toISOString(), method: 'rigid', glbPath, occluderPromptVersion: OCCLUDER_PROMPT_VERSION, occluderDetectionFailures: occluderFailures, panos: [] };
    let registrar: StreetViewPoseRegistrar;
    let textured: TexturedPrimitive[] | null = null;
    if (previous) {
        registrar = new StreetViewPoseRegistrar(scan.mesh, { log, gates });
        report.bounds = previous.bounds; report.priors = previous.priors;
        for (const p of previous.panos) {
            if (!byPano.has(p.panoId)) continue;
            report.panos.push({ ...p, frames: p.frames.filter((fr: any) => ctxs.has(fr.key)).map((fr: any) => ({ ...fr, registrationGateInput: fr.registrationGateInput ?? fr.gateInput })) });
        }
    } else {
        textured = loadTexturedScene(glbPath);
        const textureLines = extractTextureLineSamples(textured);
        registrar = new StreetViewPoseRegistrar(scan.mesh, { log, gates }, undefined, { textureLines, textured });
        report.bounds = registrar.bounds; report.priors = registrar.priors;
        log(`mesh features: ${registrar.creases.chainCount} straight crease chains (${(registrar.creases.totalLengthMeters / 1000).toFixed(1)} km), ${textureLines.chainCount} texture lines`);
        let fallbacksUsed = 0;
        for (const [panoId, pframes] of byPano) {
            if (args.panos.length && !args.panos.includes(panoId)) continue;
            const pano = panoById.get(panoId)!;
            const input: PanoRegistrationInput = {
                panoId, nominalEye: pano.eye,
                frames: pframes.map(f => ({ key: f.key, image: ctxs.get(f.key)!.image, headingDeg: f.headingDeg, pitchDeg: f.pitchDeg, fovDeg: f.fovDeg, occluders: ctxs.get(f.key)!.occluders }))
            };
            const photos = registrar.photoFeatures(input.frames);
            let result: PanoRegistrationResult = registrar.registerPano(input, photos);
            let fallback: any = null;
            if (!result.accepted && gemini && fallbacksUsed < args.maxFallbacks) {
                fallbacksUsed++;
                const order = result.frames.map((fr, i) => ({ i, n: fr.creaseSamples + 4 * fr.silhouetteSamples })).sort((a, b) => b.n - a.n);
                for (const { i } of order.slice(0, 2)) {
                    try {
                        const fb = await correspondenceFallback(gemini, registrar, input, i, fs.readFileSync(pframes[i].imagePath));
                        fallback = { frame: pframes[i].key, ok: fb.ok, reason: fb.reason, inliers: fb.inliers, rmsPx: round(fb.rmsPx), correction: fb.correction, markers: fb.markers.length };
                        if (fb.annotatedRender) fs.writeFileSync(path.join(platesDir, 'overlays', `${pframes[i].key}.markers.png`), encodePng(pframes[i].width, pframes[i].height, fb.annotatedRender));
                        if (fb.ok && fb.correction) {
                            const second = registrar.registerPano({ ...input, initialCorrection: fb.correction }, photos);
                            if (second.accepted || second.cost.final < result.cost.final) result = second;
                            break;
                        }
                    } catch (e: any) {
                        fallback = { frame: pframes[i].key, ok: false, reason: String(e?.message ?? e).slice(0, 300) };
                    }
                }
            }
            report.panos.push({
                panoId, date: pano.date, nominalEye: pano.eye.map(v => round(v, 4)), referenceHeadingDeg: input.frames[0].headingDeg,
                method: result.method, objective: result.objective,
                correction: roundCorr(result.correction),
                moveMeters: round(result.moveMeters), moveBearingDeg: round(result.moveBearingDeg, 1), atBound: result.atBound,
                cost: { initial: round(result.cost.initial), coarse: round(result.cost.coarse), final: round(result.cost.final) },
                fallback, timingsMs: result.timingsMs,
                frames: result.frames.map(fr => ({
                    key: fr.key, headingDeg: fr.headingDeg, pitchDeg: fr.pitchDeg, fovDeg: fr.fovDeg,
                    creaseSamples: fr.creaseSamples, silhouetteSamples: fr.silhouetteSamples, textureLineSamples: fr.textureSamples, photoSegments: fr.photoSegments, photoSkyFraction: round(fr.photoSkyFraction, 3),
                    initial: { lineMedianPx: round(fr.initial.creaseMedianPx), silhouetteMedianPx: round(fr.initial.silhouetteMedianPx), skyIoU: round(fr.initial.skyIoU, 3), photometricNcc: round(fr.initial.photometricNcc, 3) },
                    final: { lineMedianPx: round(fr.final.creaseMedianPx), silhouetteMedianPx: round(fr.final.silhouetteMedianPx), textureLineMedianPx: round(fr.final.textureMedianPx), lineInlierFraction: round(fr.final.creaseInlierFraction, 3), skyIoU: round(fr.final.skyIoU, 3), skyEvaluatedFraction: round(fr.final.skyEvaluatedFraction, 3), photometricNcc: round(fr.final.photometricNcc, 3) },
                    photometricPeak: round(fr.photometricPeak, 4),
                    agreement: fr.agreement ? { meters: round(fr.agreement.meters), deg: round(fr.agreement.deg) } : null,
                    registrationGateInput: { final: { creaseMedianPx: fr.final.creaseMedianPx, silhouetteMedianPx: fr.final.silhouetteMedianPx, skyIoU: fr.final.skyIoU, photometricNcc: fr.final.photometricNcc }, photometricPeak: fr.photometricPeak, agreement: fr.agreement ?? null }
                }))
            });
            const acc = result.frames.filter(f => f.accepted).length;
            log(`pano ${panoId}: rigid registration ${acc}/${result.frames.length} frames within the rigid gates, move ${round(result.moveMeters)} m @ ${round(result.moveBearingDeg, 1)} deg, dyaw ${round(result.correction.dyawDeg)}`);
        }
    }
    for (const p of report.panos) if (p.referenceHeadingDeg === undefined) p.referenceHeadingDeg = p.frames[0]?.headingDeg;

    // ---------------- E6b joint cross-view refinement ----------------
    const corrOf = (p: any): PoseCorrection => ({ dx: p.correction.dx, dy: p.correction.dy, dz: p.correction.dz, dyawDeg: p.correction.dyawDeg, dpitchDeg: p.correction.dpitchDeg, drollDeg: p.correction.drollDeg });
    const finalCorr = new Map<string, PoseCorrection>(report.panos.map((p: any) => [p.panoId, corrOf(p)]));
    const crossStats = new Map<string, { matches: number; medianPx: number | null; p75Px: number | null; medianMeters: number | null; partnerPanos: string[]; supportedPixels: number }>();
    const supportMask = new Map<string, Uint8Array>();
    const sane = (fr: any) => {
        const g = (fr.registrationGateInput ?? fr.gateInput)?.final ?? {};
        return !(g.skyIoU !== null && g.skyIoU !== undefined && g.skyIoU < 0.5) && !(g.silhouetteMedianPx !== null && g.silhouetteMedianPx !== undefined && g.silhouetteMedianPx > 4);
    };
    if (args.crossView) {
        const cvFrames: CrossViewFrame[] = [];
        const cvKeys: string[] = [];
        for (const p of report.panos) {
            if ((p.atBound ?? []).length) continue;
            for (const fr of p.frames) {
                const x = ctxs.get(fr.key);
                if (!x || !sane(fr)) continue;
                const ph = registrar.photoFeatures([{ key: fr.key, image: x.image, headingDeg: fr.headingDeg, pitchDeg: fr.pitchDeg, fovDeg: fr.fovDeg, occluders: x.occluders }])[0];
                cvFrames.push({
                    key: fr.key, panoId: p.panoId, nominalEye: p.nominalEye, headingDeg: fr.headingDeg, pitchDeg: fr.pitchDeg, fovDeg: fr.fovDeg, referenceHeadingDeg: p.referenceHeadingDeg,
                    image: x.image, valid: x.valid, sky: ph.skyFraction > 0.005 ? { mask: ph.sky, dt: ph.skyDT } : undefined
                });
                cvKeys.push(fr.key);
            }
        }
        const start = new Map<string, PoseCorrection>();
        for (const p of report.panos) {
            const cc = corrOf(p);
            start.set(p.panoId, args.crossViewStart === 'reg' ? cc : args.crossViewStart === 'gps' ? { ...ZERO_CORRECTION } : { dx: 0, dy: 0, dz: 0, dyawDeg: cc.dyawDeg, dpitchDeg: cc.dpitchDeg, drollDeg: cc.drollDeg });
        }
        const prior = new Map<string, PoseCorrection>(report.panos.map((p: any) => [p.panoId, { dx: 0, dy: 0, dz: 0, dyawDeg: p.correction.dyawDeg, dpitchDeg: p.correction.dpitchDeg, drollDeg: p.correction.drollDeg }]));
        log(`cross-view refinement: ${cvFrames.length} frames of ${new Set(cvFrames.map(f => f.panoId)).size} panos (start: ${args.crossViewStart})`);
        const refiner = new StreetViewCrossViewRefiner(scan.mesh, cvFrames, { log });
        textured = textured ?? loadTexturedScene(glbPath);
        let anchored: ReturnType<typeof refineWithTileAnchor>;
        if (args.reuseCrossView) {
            const stored = new Map<string, PoseCorrection>(previous.panos.filter((p: any) => p.finalCorrection).map((p: any) => [p.panoId, p.finalCorrection as PoseCorrection]));
            const corrs = new Map([...start].map(([k, cc]) => [k, stored.get(k) ?? cc]));
            const measured = refiner.measure(corrs);
            anchored = { first: measured, final: measured, panos: previous.crossView?.textureAnchor ?? [], anchor: undefined as any };
            log(`cross-view: reused the refined poses of the previous report (${stored.size} panos), re-measured`);
        } else {
            anchored = refineWithTileAnchor(refiner, textured, start, prior);
        }
        const cv = anchored.final;
        const check = tileAnchorLandscapes(textured, cvFrames.map((f, i) => ({ key: f.key, cam: cv.cameras[i], image: f.image, valid: f.valid })), () => 'all');
        log(`texture anchor at the final poses: aggregate optimum ${JSON.stringify(check.overall.offset)} m (NCC ${check.overall.nccAtZero.toFixed(3)} at 0, ${check.overall.nccBest.toFixed(3)} best, contrast ${check.overall.ringContrast.toFixed(3)})`);
        for (const [p, cc] of cv.corrections) finalCorr.set(p, cc);
        cv.frames.forEach((s, i) => {
            crossStats.set(s.key, { matches: s.matches, medianPx: s.medianPx, p75Px: s.p75Px, medianMeters: s.medianMeters, partnerPanos: s.partnerPanos, supportedPixels: s.supportedPixels });
            supportMask.set(cvKeys[i], cv.supportMasks[i]);
        });
        report.crossView = {
            frames: cvFrames.length, start: args.crossViewStart, priors: refiner.priors, bounds: refiner.bounds,
            firstPass: { history: anchored.first.history, corrections: Object.fromEntries([...anchored.first.corrections].map(([k, cc]) => [k, Object.fromEntries(Object.entries(cc).map(([a, b]) => [a, round(b as number, 3)]))])), timingsMs: anchored.first.timingsMs },
            textureAnchor: anchored.panos.map(p => ({ ...p, ringContrast: round(p.ringContrast, 3), nccAtZero: round(p.nccAtZero, 3), nccBest: round(p.nccBest, 3) })),
            finalTextureAnchor: { offset: check.overall.offset, nccAtZero: round(check.overall.nccAtZero, 3), nccBest: round(check.overall.nccBest, 3), ringContrast: round(check.overall.ringContrast, 3), atEdge: check.overall.atEdge, frames: check.frames.map(f => ({ ...f, nccAtZero: round(f.nccAtZero, 3), blurPx: round(f.blurPx, 1) })), grid: check.overall.grid.map(r => r.map(v => round(v, 3))) },
            history: cv.history, timingsMs: cv.timingsMs,
            pairs: cv.pairs.filter(p => p.matches > 0).map(p => ({ ...p, medianPx: round(p.medianPx), fractionWithin3Px: round(p.fractionWithin3Px, 3), medianShift: p.medianShift?.map(v => round(v)) }))
        };
    }

    // ---------------- E7 plates at the final poses ----------------
    for (const p of report.panos) {
        const cc = finalCorr.get(p.panoId)!;
        p.finalCorrection = roundCorr(cc);
        p.finalMoveMeters = round(Math.hypot(cc.dx, cc.dz));
        p.finalMoveBearingDeg = round(((Math.atan2(cc.dx, -cc.dz) / DEG) + 360) % 360, 1);
        p.crossViewRefined = args.crossView && p.frames.some((fr: any) => crossStats.has(fr.key));
        const input: PanoRegistrationInput = {
            panoId: p.panoId, nominalEye: p.nominalEye,
            frames: p.frames.map((fr: any) => { const x = ctxs.get(fr.key)!; return { key: fr.key, image: x.image, headingDeg: fr.headingDeg, pitchDeg: fr.pitchDeg, fovDeg: fr.fovDeg, occluders: x.occluders }; })
        };
        if (input.frames[0].headingDeg !== p.referenceHeadingDeg) {
            const k = input.frames.findIndex(f => f.headingDeg === p.referenceHeadingDeg);
            if (k > 0) { const [ref] = input.frames.splice(k, 1); input.frames.unshift(ref); p.frames.unshift(...p.frames.splice(k, 1)); }
        }
        const photos = registrar.photoFeatures(input.frames);
        for (let i = 0; i < p.frames.length; i++) {
            const fr = p.frames[i], x = ctxs.get(fr.key)!, cf = x.cf;
            const cam = registrar.camera(input, input.frames[i], cc);
            const res = registrar.featureResiduals(input, photos, cc, i).filter(r => r.kind === 2).map(r => r.r).sort((a, b) => a - b);
            const silMed = res.length >= registrar.gates.minSilhouetteSamples ? res[res.length >> 1] : null;
            const finalDepth = renderFrameDepth(scan.mesh, cam);
            const iou = registrar.skyIoU(finalDepth, photos[i]);
            const cs = crossStats.get(fr.key) ?? null;
            const support = supportMask.get(fr.key);
            const mask = Uint8Array.from(x.valid);
            if (args.crossView) for (let k = 0; k < mask.length; k++) if (!support || !support[k]) mask[k] = 0;
            const plateDepth = renderPlateDepth(scan.mesh, cam, mask);
            const initialDepth = renderFrameDepth(scan.mesh, registrar.camera(input, input.frames[i], ZERO_CORRECTION));
            const overlayRel = path.join('overlays', `${cf.key}.png`);
            fs.writeFileSync(path.join(platesDir, overlayRel), encodePng(cf.width, cf.height, renderRegistrationOverlay(x.image, initialDepth, finalDepth, { ...photos[i], valid: mask })));
            const depthRel = `${cf.key}.depth.f32`, maskRel = `${cf.key}.mask.png`;
            fs.writeFileSync(path.join(platesDir, depthRel), encodeDepthF32(plateDepth));
            fs.writeFileSync(path.join(platesDir, maskRel), encodeMaskPng(mask, cf.width, cf.height));
            const regGate = fr.registrationGateInput ?? fr.gateInput;
            const gateInput: GateInput = {
                final: { creaseMedianPx: regGate?.final?.creaseMedianPx ?? null, silhouetteMedianPx: silMed, skyIoU: iou.iou, photometricNcc: regGate?.final?.photometricNcc ?? null },
                photometricPeak: regGate?.photometricPeak ?? null,
                agreement: args.crossView ? null : (regGate?.agreement ?? null),
                crossView: cs ? { matches: cs.matches, medianPx: cs.medianPx, p75Px: cs.p75Px, partnerPanos: cs.partnerPanos.length } : null
            };
            const plate: StreetViewPlateRecord = {
                id: cf.key, panoId: p.panoId, date: cf.date, copyright: cf.copyright,
                imagePath: path.relative(platesDir, cf.imagePath), depthPath: depthRel, maskPngPath: maskRel, overlayPngPath: overlayRel,
                width: cf.width, height: cf.height, request: { headingDeg: cf.headingDeg, pitchDeg: cf.pitchDeg, fovDeg: cf.fovDeg },
                pose: frameCameraToPose(cam), intrinsics: streetViewIntrinsics(cf.fovDeg, cf.width, cf.height),
                station: stationForFrame(frames.indexOf(cf), cf.key, cam, cf.fovDeg, origin, x.pano.streetY),
                poseQuality: poseQuality(gateInput, gates), occluders: x.occluders,
                registration: {
                    method: p.method, correction: cc, moveMeters: Math.hypot(cc.dx, cc.dz),
                    creaseMedianPx: gateInput.final.creaseMedianPx, silhouetteMedianPx: silMed, skyIoU: iou.iou,
                    ...(cs ? { crossView: { matches: cs.matches, medianPx: cs.medianPx, p75Px: cs.p75Px, partnerPanos: cs.partnerPanos.length, medianMeters: cs.medianMeters, supportedPixels: cs.supportedPixels } } : {})
                }
            };
            Object.assign(fr, {
                occluders: x.occluders.length,
                atFinal: { silhouetteMedianPx: round(silMed), skyIoU: round(iou.iou, 3), skyEvaluatedFraction: round(iou.evaluatedFraction, 3) },
                crossView: cs ? { matches: cs.matches, medianPx: round(cs.medianPx), p75Px: round(cs.p75Px), medianMeters: round(cs.medianMeters, 3), partnerPanos: cs.partnerPanos, supportedPixels: cs.supportedPixels } : null,
                reasonsPlanGates: evaluateFrameGates(gateInput, p.atBound ?? [], { ...PLAN_GATES }),
                gateInput, overlay: path.join('plates', overlayRel), plate
            });
        }
        log(`pano ${p.panoId}: final move ${p.finalMoveMeters} m @ ${p.finalMoveBearingDeg} deg${p.crossViewRefined ? ' (cross-view refined)' : ''}`);
    }
    finalizePlates(report, gates, platesDir, { scan, hero: c.hero, targets, streetVisible, origin, glbPath, scanKey: c.scanKey, outDir });
    log(`done in ${Math.round((Date.now() - t0) / 1000)} s`);
}

/** Builds plates.json (accepted under `gates`) and the coverage of accepted frames from pose_report data (rigid method). */
function finalizePlates(report: any, gates: RegistrationGates, platesDir: string, ctx: {
    scan: ScanMesh; hero: HeroModel; targets: TargetSamples; streetVisible: Uint8Array; origin: { lat: number; lng: number; heightMeters: number }; glbPath: string; scanKey: string; outDir: string;
}) {
    const platesFile: StreetViewPlatesFile = {
        version: 1, createdAt: new Date().toISOString(), glbPath: ctx.glbPath, anchor: ctx.origin,
        frameConvention: 'x=East,y=Up,z=South(-North); heading clockwise from north', plates: [], rejected: []
    };
    const acceptedUtility = new Float32Array(ctx.targets.count);
    let planAccepted = 0;
    for (const pano of report.panos) {
        for (const fr of pano.frames) {
            if (!fr.gateInput || !fr.plate) continue;
            const reasons = evaluateFrameGates(fr.gateInput, pano.atBound ?? [], gates);
            fr.plate.poseQuality = reasons.length ? 0 : poseQuality(fr.gateInput, gates);
            if (fr.plate.poseQuality <= 0 && !reasons.length) {
                const ncc = fr.gateInput.final?.photometricNcc;
                reasons.push(ncc !== null && ncc !== undefined && ncc <= 0 ? `poseQuality 0: photometric NCC ${ncc.toFixed(3)} <= 0` : 'poseQuality 0: interior alignment unverified');
            }
            fr.acceptedActive = reasons.length === 0; fr.reasonsActive = reasons;
            if (!(fr.reasonsPlanGates ?? ['n/a']).length) planAccepted++;
            if (reasons.length) { platesFile.rejected.push({ id: fr.key, panoId: pano.panoId, reasons }); continue; }
            platesFile.plates.push(fr.plate);
            const cam = plateRecordCamera(fr.plate);
            const valid = readPlateMask(path.join(platesDir, fr.plate.maskPngPath), cam.width, cam.height);
            const v = computePanoVisibilityCached(ctx.scan, ctx.targets, cam.eye, `${pano.panoId}_reg`, path.join(ctx.outDir, 'visibility'), ctx.scanKey);
            const util = cameraUtilities(v, ctx.targets, cam, valid);
            for (let k = 0; k < v.idx.length; k++) if (util[k] > acceptedUtility[v.idx[k]]) acceptedUtility[v.idx[k]] = util[k];
        }
    }
    report.activeGates = gates;
    report.planGates = { ...PLAN_GATES };
    report.coverageAccepted = coverageReport(ctx.targets, ctx.hero, acceptedUtility, ctx.streetVisible).map(c => ({ ...c, areaM2: round(c.areaM2, 0), streetVisibleM2: round(c.streetVisibleM2, 0), coveredM2: round(c.coveredM2, 0), coveredFractionOfVisible: round(c.coveredFractionOfVisible, 3) }));
    let vis = 0, cov = 0;
    for (const c of report.coverageAccepted) if (!c.side.startsWith('roof') && parseFloat(c.band) < 120) { vis += c.streetVisibleM2; cov += c.coveredM2; }
    report.summary = {
        panos: report.panos.length, frames: report.panos.reduce((a: number, p: any) => a + p.frames.length, 0),
        acceptedActiveGates: platesFile.plates.length, acceptedPlanGates: planAccepted, rejectedActiveGates: platesFile.rejected.length,
        facadeBelow120mStreetVisibleM2: vis, facadeBelow120mCoveredM2: cov, facadeBelow120mCoveredFraction: vis ? round(cov / vis, 3) : 0,
        note: 'coverage counts a sample as covered when an accepted frame sees it with its plate mask (cross-view support included); the fusion applies further confidence factors'
    };
    fs.writeFileSync(path.join(platesDir, 'pose_report.json'), JSON.stringify(report, null, 1));
    fs.writeFileSync(path.join(platesDir, 'plates.json'), JSON.stringify(platesFile, null, 1));
    log(`plates: ${platesFile.plates.length} accepted under active gates (${planAccepted} under plan gates) / ${platesFile.rejected.length} rejected -> ${path.relative(REPO, path.join(platesDir, 'plates.json'))}`);
    log(`coverage of street-visible hero facade below 120 m by accepted frames: ${(report.summary.facadeBelow120mCoveredFraction * 100).toFixed(1)} %`);
}

// ============================================================================================
// Entry
// ============================================================================================

async function main() {
    const argv = process.argv.slice(2);
    const wi = argv.indexOf('--feature-worker');
    if (wi >= 0) {
        // child process: register the panos of one job file
        const job: FeatureJob = JSON.parse(fs.readFileSync(argv[wi + 1], 'utf8'));
        runFeatureJob(job, m => log(m));
        return;
    }
    loadDotEnv();
    const args = parseArgs(argv);
    // One billing ledger for every run, whatever --out is (earlier ledgers are folded in once)
    const { ledgerPath, ledger } = openGlobalLedger(path.resolve(REPO, args.out));
    log(`billing ledger ${path.relative(REPO, ledgerPath)}: ${ledger.billedImageRequests} billed of the ${STREETVIEW_BILLING_HARD_CAP} hard cap (this run's cap ${effectiveBillingCap(args.maxBilled)})`);
    const c = analyseScan(args);
    if (args.method === 'rigid') await runRigid(c); else await runFeature(c);
}

main().catch(e => {
    console.error(redactSecrets(String(e?.stack ?? e)));
    process.exit(1);
});
