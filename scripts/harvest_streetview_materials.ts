/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Texture agent, capture step: harvest tileable metric PBR material swatches from CACHED Street View frames.
 *
 *   npx vite-node scripts/harvest_streetview_materials.ts \
 *     --cache .scratchbox/streetview_cache/<site> --base-glb <textured scan.glb> [--out <cache>/materials]
 *
 * No Street View image is fetched (zero billed requests): frames are read from --cache (<key>.jpg + <key>.json, as
 * written by fetch_register_streetview_plates.ts). Poses come from <cache>/plates/pose_report.json (registered pose
 * of every frame; --poses to change) and fall back to the GPS prior (needs the anchor from plates.json or --anchor).
 * Occluder / signage boxes come from <cache>/occluders/<key>.json.
 *
 * Gemini (GEMINI_API_KEY or Vertex credentials from the environment or the repo .env, never printed) proposes the
 * material patches; responses are cached in <out>/segmentation/ and re-used. --no-gemini uses the cache only.
 *
 * Writes <out>/library.json, <out>/swatches/*.png (albedo, normal, ORM, height, rectified photo swatch),
 * <out>/harvest_report.json and <out>/library_contact_sheet.png. Keep --out under .scratchbox/ (gitignored): the
 * swatches are Street View pixels and stay local.
 *
 * Flags: --frames k1,k2 (subset), --max-frames N, --refresh-segmentation, --camera-height M (prior poses),
 *        --min-incidence C, --min-gain G, --max-swatch PX, --max-axis-dev DEG, --debug (every rectified candidate to <out>/debug),
 *        --concurrency N (parallel Gemini segmentation requests, default 6).
 */

import * as fs from 'fs';
import * as path from 'path';
import {
    harvestStreetViewMaterials, cachedGeminiSegmenter, type HarvestFrameInput, type MaterialLibrary
} from '../packages/core/src/node/spatial/StreetViewMaterialHarvester';
import {
    loadTexturedScene, plateRecordCamera, frameCamera, createGeminiContentClient, decodeImageToRgba, ZERO_CORRECTION,
    type OccluderBox, type StreetViewPlateRecord, type FrameCamera
} from '../packages/core/src/node/spatial/StreetViewPoseRegistrar';
import { loadScanMesh, buildGroundModel, localStreetHeight, geodeticToScan, parseAnchor, type GeodeticOrigin } from '../packages/core/src/node/spatial/StreetViewSurveyPlanner';
import { decodePng, encodePng } from '../packages/core/src/node/texture-processing';

const REPO = path.resolve(__dirname, '..');
const SECRET_ENV = ['GOOGLE_MAPS_API_KEY', 'MAP_TILES_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_GENAI_API_KEY', 'GOOGLE_AI_API_KEY', 'GOOGLE_CLOUD_API_KEY'];

function loadDotEnv() {
    const p = path.join(REPO, '.env');
    if (!fs.existsSync(p)) return;
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
        const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
        if (!m || process.env[m[1]]) continue;
        process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
    }
}
function redactSecrets(text: string): string {
    let out = text;
    for (const k of SECRET_ENV) { const v = process.env[k]; if (v && v.length >= 8) out = out.split(v).join('<redacted>'); }
    return out;
}
const log = (msg: string) => console.log(redactSecrets(msg));

interface Args {
    cache: string; baseGlb: string; out: string; poses: string; plates: string; anchor?: string;
    gemini: boolean; refresh: boolean; frames: string[] | null; maxFrames: number; cameraHeight: number;
    minIncidence?: number; minGain?: number; maxSwatch?: number; maxAxisDev?: number; debug: boolean; concurrency: number;
}

function usage(): never {
    console.error('usage: npx vite-node scripts/harvest_streetview_materials.ts --cache <frames dir> --base-glb <scan.glb> [--out <dir>] [--poses <pose_report.json>] [--plates <plates.json>] [--anchor lat,lng,h] [--no-gemini] [--refresh-segmentation] [--frames k1,k2] [--max-frames N] [--camera-height M] [--min-incidence C] [--min-gain G] [--max-swatch PX] [--max-axis-dev DEG]');
    process.exit(2);
}

function parseArgs(argv: string[]): Args {
    const a: Partial<Args> = { gemini: true, refresh: false, frames: null, maxFrames: Infinity, cameraHeight: 2.5, debug: false, concurrency: 6 };
    const num = (k: string, v: string | undefined, min = -Infinity, max = Infinity): number => {
        const n = Number(v);
        if (v === undefined || v.startsWith('--') || !Number.isFinite(n) || n < min || n > max) throw new Error(`${k} needs a number in [${min}, ${max}] (got "${v}")`);
        return n;
    };
    const str = (k: string, v: string | undefined): string => { if (v === undefined || v.startsWith('--')) throw new Error(`${k} needs a value`); return v; };
    for (let i = 0; i < argv.length; i++) {
        const k = argv[i];
        switch (k) {
            case '--cache': a.cache = path.resolve(REPO, str(k, argv[++i])); break;
            case '--base-glb': a.baseGlb = path.resolve(REPO, str(k, argv[++i])); break;
            case '--out': a.out = path.resolve(REPO, str(k, argv[++i])); break;
            case '--poses': a.poses = path.resolve(REPO, str(k, argv[++i])); break;
            case '--plates': a.plates = path.resolve(REPO, str(k, argv[++i])); break;
            case '--anchor': a.anchor = str(k, argv[++i]); break;
            case '--no-gemini': a.gemini = false; break;
            case '--refresh-segmentation': a.refresh = true; break;
            case '--frames': a.frames = str(k, argv[++i]).split(',').map(s => s.trim()).filter(Boolean); break;
            case '--max-frames': a.maxFrames = num(k, argv[++i], 1); break;
            case '--camera-height': a.cameraHeight = num(k, argv[++i], 0, 10); break;
            case '--min-incidence': a.minIncidence = num(k, argv[++i], 0, 1); break;
            case '--min-gain': a.minGain = num(k, argv[++i], 1); break;
            case '--max-swatch': a.maxSwatch = num(k, argv[++i], 32, 2048); break;
            case '--max-axis-dev': a.maxAxisDev = num(k, argv[++i], 0, 45); break;
            case '--debug': a.debug = true; break;
            case '--concurrency': a.concurrency = num(k, argv[++i], 1, 32); break;
            case '-h': case '--help': usage();
            // eslint-disable-next-line no-fallthrough
            default: throw new Error(`unknown argument ${k}`);
        }
    }
    if (!a.cache || !a.baseGlb) usage();
    a.out = a.out ?? path.join(a.cache!, 'materials');
    a.poses = a.poses ?? path.join(a.cache!, 'plates', 'pose_report.json');
    a.plates = a.plates ?? path.join(a.cache!, 'plates', 'plates.json');
    return a as Args;
}

interface FrameMeta { key: string; panoId: string; headingDeg: number; pitchDeg: number; fovDeg: number; width: number; height: number; date?: string; location: { lat: number; lng: number } }

/** Contact sheet of the harvested photo swatches (128 px cells, library order). */
function contactSheet(library: MaterialLibrary, dir: string): Buffer | null {
    if (!library.samples.length) return null;
    const C = 128, cols = Math.min(10, library.samples.length), rows = Math.ceil(library.samples.length / cols);
    const W = cols * (C + 4), H = rows * (C + 4);
    const out = Buffer.alloc(W * H * 4, 255);
    library.samples.forEach((s, k) => {
        const file = path.join(dir, s.files.photoSwatch ?? s.files.albedo);
        if (!fs.existsSync(file)) return;
        const img = decodePng(fs.readFileSync(file));
        const ox = (k % cols) * (C + 4), oy = Math.floor(k / cols) * (C + 4);
        for (let y = 0; y < C; y++) for (let x = 0; x < C; x++) {
            const sx = Math.min(img.width - 1, Math.floor(x * img.width / C)), sy = Math.min(img.height - 1, Math.floor(y * img.height / C));
            img.rgba.copy(out, ((oy + y) * W + ox + x) * 4, (sy * img.width + sx) * 4, (sy * img.width + sx) * 4 + 4);
        }
    });
    return encodePng(W, H, out);
}

async function main() {
    loadDotEnv();
    const args = parseArgs(process.argv.slice(2));
    const t0 = Date.now();
    fs.mkdirSync(args.out, { recursive: true });

    // ---------------- frames ----------------
    const metas: FrameMeta[] = fs.readdirSync(args.cache).filter(f => f.endsWith('.json') && fs.existsSync(path.join(args.cache, f.replace(/\.json$/, '.jpg'))))
        .map(f => JSON.parse(fs.readFileSync(path.join(args.cache, f), 'utf8')))
        .filter((m: any) => typeof m?.key === 'string' && Number.isFinite(m?.headingDeg))
        .sort((a: FrameMeta, b: FrameMeta) => a.key.localeCompare(b.key));
    const selected = metas.filter(m => !args.frames || args.frames.includes(m.key)).slice(0, args.maxFrames);
    log(`frames: ${selected.length} of ${metas.length} cached (no Street View requests are made)`);

    // ---------------- poses ----------------
    const registered = new Map<string, { plate: StreetViewPlateRecord; accepted: boolean }>();
    if (fs.existsSync(args.poses)) {
        const rep = JSON.parse(fs.readFileSync(args.poses, 'utf8'));
        for (const pano of rep.panos ?? []) for (const f of pano.frames ?? []) if (f.plate?.pose && f.plate?.intrinsics) registered.set(f.key, { plate: f.plate, accepted: !!f.acceptedActive });
        log(`poses: ${registered.size} registered frames from ${path.relative(REPO, args.poses)}`);
    }
    let anchor: GeodeticOrigin | null = null;
    if (args.anchor) anchor = parseAnchor(args.anchor);
    else if (fs.existsSync(args.plates)) { const p = JSON.parse(fs.readFileSync(args.plates, 'utf8')); if (p.anchor) anchor = { lat: p.anchor.lat, lng: p.anchor.lng, heightMeters: p.anchor.heightMeters } as GeodeticOrigin; }

    log(`loading base ${path.relative(REPO, args.baseGlb)}`);
    const texturedPrims = loadTexturedScene(args.baseGlb);
    const scan = loadScanMesh(args.baseGlb);
    const ground = buildGroundModel(scan);

    const frames: HarvestFrameInput[] = [];
    for (const m of selected) {
        const image = fs.readFileSync(path.join(args.cache, `${m.key}.jpg`));
        const img = decodeImageToRgba(image);
        let camera: FrameCamera, poseSource: string, poseConfidence: number;
        const reg = registered.get(m.key);
        if (reg && reg.plate.width === img.width && reg.plate.height === img.height) {
            camera = plateRecordCamera(reg.plate);
            poseSource = reg.accepted ? 'registered-accepted' : 'registered';
            poseConfidence = reg.accepted ? Math.max(0.5, reg.plate.poseQuality) : 0.35;
        } else if (anchor) {
            const { x, z } = geodeticToScan(anchor, m.location.lat, m.location.lng);
            const y = localStreetHeight(scan, ground, x, z) + args.cameraHeight;
            camera = frameCamera([x, y, z], m.headingDeg, m.pitchDeg, m.fovDeg, img.width, img.height, ZERO_CORRECTION, m.headingDeg);
            poseSource = 'prior'; poseConfidence = 0.15;
        } else {
            log(`${m.key}: skipped (no registered pose and no anchor for a prior pose)`);
            continue;
        }
        let occluders: OccluderBox[] = [];
        const occFile = path.join(args.cache, 'occluders', `${m.key}.json`);
        if (fs.existsSync(occFile)) occluders = JSON.parse(fs.readFileSync(occFile, 'utf8')).boxes ?? [];
        frames.push({ key: m.key, panoId: m.panoId, date: m.date, image, rgba: img.rgba, width: img.width, height: img.height, camera, poseSource, poseConfidence, occluders });
    }

    // ---------------- harvest ----------------
    const client = args.gemini ? await createGeminiContentClient() : null;
    if (args.gemini && !client) log('Gemini client unavailable: using cached segmentations only');
    const segmenter = cachedGeminiSegmenter(client, path.join(args.out, 'segmentation'), { allowNetwork: args.gemini, refresh: args.refresh });
    // Warm the segmentation cache with a few concurrent requests (the harvest itself then reads the cache).
    if (client && args.gemini) {
        const queue = frames.slice();
        let done = 0, failed = 0;
        const worker = async () => {
            for (let f = queue.shift(); f; f = queue.shift()) {
                try { await segmenter(f); } catch (e) { failed++; log(`${f.key}: segmentation failed: ${(e as Error).message}`); }
                done++;
            }
        };
        await Promise.all(Array.from({ length: Math.min(args.concurrency, frames.length) }, worker));
        log(`segmentation: ${done} frames (${failed} failed)`);
    }
    const cachedSegmenter = cachedGeminiSegmenter(client, path.join(args.out, 'segmentation'), { allowNetwork: args.gemini });
    const { library, libraryPath, frameReports } = await harvestStreetViewMaterials(frames, {
        outDir: args.out, segmenter: cachedSegmenter, texturedPrims, baseGlbPath: path.relative(args.out, args.baseGlb),
        groundHeightAt: (x, z) => ground.groundAt(x, z),
        minIncidenceCos: args.minIncidence, minResolutionGain: args.minGain, maxSwatchPx: args.maxSwatch, maxAxisDeviationDeg: args.maxAxisDev,
        debugDir: args.debug ? path.join(args.out, 'debug') : undefined,
        log
    });
    const sheet = contactSheet(library, args.out);
    if (sheet) fs.writeFileSync(path.join(args.out, 'library_contact_sheet.png'), sheet);

    // ---------------- report ----------------
    const reasons = new Map<string, number>();
    for (const r of library.rejected) { const key = r.reason.replace(/[\d.]+/g, '#').slice(0, 80); reasons.set(key, (reasons.get(key) ?? 0) + 1); }
    const byLabel = new Map<string, number>();
    for (const s of library.samples) byLabel.set(s.label, (byLabel.get(s.label) ?? 0) + 1);
    const report = {
        createdAt: new Date().toISOString(), baseGlb: path.relative(REPO, args.baseGlb), cache: path.relative(REPO, args.cache),
        frames: frames.length, samples: library.samples.length, rejected: library.rejected.length,
        rejectionReasons: Object.fromEntries([...reasons.entries()].sort((a, b) => b[1] - a[1])),
        labels: Object.fromEntries([...byLabel.entries()].sort((a, b) => b[1] - a[1])),
        frameReports, elapsedMs: Date.now() - t0
    };
    fs.writeFileSync(path.join(args.out, 'harvest_report.json'), JSON.stringify(report, null, 1));
    log(`library: ${library.samples.length} samples from ${frames.length} frames (${library.rejected.length} proposals rejected) -> ${path.relative(REPO, libraryPath)}`);
    for (const s of library.samples) {
        log(`  ${s.id.padEnd(58)} ${s.label.slice(0, 40).padEnd(40)} ${s.widthPx}x${s.heightPx} ${(s.sizeMeters.u).toFixed(1)}x${(s.sizeMeters.v).toFixed(1)} m  ${(100 * s.metresPerPixel.u).toFixed(1)} cm/px  gain ${s.tile?.resolutionGain ?? '-'}  tilt ${s.plane.tiltDeg.toFixed(0)}  ${s.plane.method}  score ${s.quality.score.toFixed(2)}`);
    }
    log(`rejections: ${JSON.stringify(report.rejectionReasons)}`);
    log(`done in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}

main().catch(e => { console.error(redactSecrets(String((e as Error)?.stack ?? e))); process.exit(1); });
