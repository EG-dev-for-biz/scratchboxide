/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Stage 3: Street View detail on the scan's own texture (plan E8-E10 + F Stage-3 gates).
 *
 * Chain: scripts/fetch_register_streetview_plates.ts (E2-E7, writes plates.json) -> this script:
 * registered plates -> SurveyTextureUnprojector + StreetViewTextureFusion -> fused GLB, then every Stage 3
 * gate measured from the written files by StreetViewStage3Metrics, and before/after path-traced renders.
 *
 *   npx vite-node scripts/build_streetview_stage3.ts \
 *     --base-glb <textured scan or rectified base .glb> --plates <cache>/plates/plates.json --out <stage3 .glb>
 *
 * --base-glb, --plates and --out are required (no site defaults). Any GLB in the plates' frame works (raw tile or
 * the rectified Stage 2 textured base, same UVs). When the plates were registered on another GLB, plate depth is
 * re-rendered from the base mesh (--rerender-depth auto).
 *
 * Options:
 *   --region hero|all           texels the photos may change: the hero footprint found in the scan (default; the
 *                               footprint is the DSM component under the plates' anchor) or every texel
 *   --hero-margin <m>           extra dilation of the hero footprint (default 0; the footprint is already dilated 2 m)
 *   --anchor lat,lng,h          frame anchor (provenance only)
 *   --work <dir>                reports, confidence GLB, renders (default <out dir>/<out name>_work)
 *   --sv-cache <dir>            Street View cache with plan.json + visibility/ (default: parent of the plates dir)
 *   --rerender-depth auto|always|never
 *   --depth-edge-guard <px>     plate depth-discontinuity guard (default 3)
 *   --depth-edge-guard-m <m>    object-space depth-discontinuity guard on the surface (default 0.5)
 *   --detail-mode fine|ratio    photo band transferred (default fine: only detail finer than the tile resolves; ratio: the
 *                               plan's L(T) * S / L(S) transfer, replacing every band above --low-pass-sigma texels)
 *   --low-pass-sigma <texels>   low band of the ratio mode (default 3)
 *   --max-scale <n>             per-primitive atlas scale cap (default 4)
 *   --min-pose-quality <q>      drop plates below this poseQuality (default 0: the fusion skips q = 0)
 *   --renderer <bin>            path tracer (default build/omnispatial/render_pt)
 *   --shots <dir> --shot-prefix <name>   hstacks (default test-results/screenshots, esb_sv_pilot)
 *   --held-out <n>              rejected frames rendered as held-out views (default 6)
 *   --exposure <ev>             fixed path-tracer exposure for the baked beauty pass (default 3; same for every render)
 *   --no-render                 skip renders (render-based gates are then reported as not measured)
 *   --reuse-fusion              reuse <work>/fusion_cache (written by every run) when it matches --out, --base-glb and
 *                               the plates: re-measures gates and re-renders without re-running the fusion
 *   --pose-quality-override <q> diagnostics only: give every projected plate this poseQuality (q = 0 plates stay off)
 *
 * Outputs stay local: .scratchbox/ and test-results/ are gitignored. Street View pixels end up in the
 * fused GLB and in the screenshots; nothing here uploads or shares them.
 */

import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { spawnSync } from 'child_process';
import * as zlib from 'zlib';
import {
    loadStreetViewPlates, readGlbScene, sceneToRenderMesh, plateRecordCamera, readPlateMask, renderFrameDepth, decodeImageToRgba,
    evaluateFrameGates, PLAN_GATES, frameCameraToPose,
    type StreetViewPlatesFile, type StreetViewPlateRecord, type FrameCamera, type RegistrationGates
} from '../packages/core/src/node/spatial/StreetViewPoseRegistrar';
import {
    loadScanMesh, buildGroundModel, findHeroFootprint, buildTargetSamples, localStreetHeight, computePanoVisibilityCached, HEIGHT_BANDS
} from '../packages/core/src/node/spatial/StreetViewSurveyPlanner';
import { StreetViewTextureFusion, compactGlb, type StreetViewTextureFusionResult } from '../packages/core/src/node/spatial/StreetViewTextureFusion';
import { SurveyTextureUnprojector } from '../packages/core/src/node/spatial/SurveyTextureUnprojector';
import { AlgorithmicUvEngine } from '../packages/core/src/node/spatial/AlgorithmicUvEngine';
import {
    compareBaseColorImages, listPrimitiveBaseColorImages, auditMaterials, auditReplacedImage, confidenceCoverageAtSamples,
    luminance8, laplacianVariance, maskedNcc, edgeResidualPx, blur1, sobelEnergy,
    type ReplacedImageAudit, type CoverageResult
} from '../packages/core/src/node/spatial/StreetViewStage3Metrics';
import { encodePng, decodePng } from '../packages/core/src/node/texture-processing';

const REPO = path.resolve(__dirname, '..');
const DEG = Math.PI / 180;
const MAX_BYTES = 45_000_000;
/** Path-tracer samples per pixel (tent-jittered): 8 averages texture lookups enough to keep minified 4x atlases from aliasing into false sharpness. */
const RENDER_SPP = Number(process.env.SV_STAGE3_SPP ?? 8);

interface Args {
    baseGlb: string; plates: string; out: string; work: string; anchor: string | null; svCache: string;
    rerenderDepth: 'auto' | 'always' | 'never'; depthEdgeGuardPx: number; depthEdgeGuardMeters: number; maxScale: number; minPoseQuality: number;
    renderer: string; shots: string; shotPrefix: string; heldOut: number; render: boolean; exposure: number;
    reuseFusion: boolean; poseQualityOverride: number | null; region: 'hero' | 'all'; heroMargin: number;
    detailMode: 'fine' | 'ratio'; lowPassSigma: number;
}

function parseArgs(argv: string[]): Args {
    const get = (k: string) => { const i = argv.indexOf(k); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined; };
    const known = new Set(['--base-glb', '--plates', '--out', '--work', '--anchor', '--sv-cache', '--rerender-depth', '--depth-edge-guard', '--max-scale',
        '--min-pose-quality', '--renderer', '--shots', '--shot-prefix', '--held-out', '--no-render', '--exposure', '--reuse-fusion', '--pose-quality-override',
        '--region', '--hero-margin', '--depth-edge-guard-m', '--detail-mode', '--low-pass-sigma']);
    const flags = new Set(['--no-render', '--reuse-fusion']);
    for (let i = 0; i < argv.length; i++) {
        if (!argv[i].startsWith('--')) continue;
        if (!known.has(argv[i])) throw new Error(`Unknown argument ${argv[i]}`);
        if (!flags.has(argv[i])) {
            if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) throw new Error(`${argv[i]} needs a value`);
            i++;
        }
    }
    for (const req of ['--base-glb', '--plates', '--out']) if (!get(req)) throw new Error(`${req} is required`);
    const num = (k: string, d: number) => {
        const v = get(k);
        if (v === undefined) return d;
        const n = Number(v);
        if (!Number.isFinite(n)) throw new Error(`${k} must be a number (got "${v}")`);
        return n;
    };
    const region = get('--region') ?? 'hero';
    const detailMode = get('--detail-mode') ?? 'fine';
    if (detailMode !== 'fine' && detailMode !== 'ratio') throw new Error('--detail-mode must be fine or ratio');
    if (region !== 'hero' && region !== 'all') throw new Error('--region must be hero or all');
    const baseGlb = path.resolve(REPO, get('--base-glb')!);
    const plates = path.resolve(REPO, get('--plates')!);
    const out = path.resolve(REPO, get('--out')!);
    const rr = get('--rerender-depth') ?? 'auto';
    if (rr !== 'auto' && rr !== 'always' && rr !== 'never') throw new Error('--rerender-depth must be auto, always or never');
    return {
        baseGlb, plates, out,
        work: path.resolve(REPO, get('--work') ?? path.join(path.dirname(out), `${path.basename(out, '.glb')}_work`)),
        anchor: get('--anchor') ?? null,
        svCache: path.resolve(REPO, get('--sv-cache') ?? path.dirname(path.dirname(plates))),
        rerenderDepth: rr,
        depthEdgeGuardPx: num('--depth-edge-guard', 3),
        depthEdgeGuardMeters: num('--depth-edge-guard-m', 0.5),
        maxScale: num('--max-scale', 4),
        minPoseQuality: num('--min-pose-quality', 0),
        renderer: path.resolve(REPO, get('--renderer') ?? 'build/omnispatial/render_pt'),
        shots: path.resolve(REPO, get('--shots') ?? 'test-results/screenshots'),
        shotPrefix: get('--shot-prefix') ?? 'esb_sv_pilot',
        heldOut: num('--held-out', 6),
        render: !argv.includes('--no-render'),
        exposure: num('--exposure', 3),
        reuseFusion: argv.includes('--reuse-fusion'),
        poseQualityOverride: get('--pose-quality-override') !== undefined ? num('--pose-quality-override', 0) : null,
        region, heroMargin: num('--hero-margin', 0), detailMode, lowPassSigma: num('--low-pass-sigma', 3)
    };
}

const log = (m: string) => console.log(`[stage3] ${m}`);
const r3 = (v: number | null | undefined, d = 3) => (v === null || v === undefined || !Number.isFinite(v) ? null : Number(v.toFixed(d)));
const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const rel = (p: string) => path.relative(REPO, p) || p;

interface Gate { name: string; pass: boolean | null; value: unknown; threshold: string; note?: string }

// ============================================================================================
// Fusion cache (lets gates / renders be re-measured without re-running the fusion)
// ============================================================================================

function writeFusionCache(dir: string, key: string, res: StreetViewTextureFusionResult): void {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    for (const p of res.primitives) {
        if (!p.maps) continue;
        const { width: W, height: H } = p.maps;
        const head = Buffer.alloc(8); head.writeUInt32LE(W, 0); head.writeUInt32LE(H, 4);
        const body = Buffer.concat([
            head,
            Buffer.from(p.maps.confidence.buffer, p.maps.confidence.byteOffset, W * H * 4),
            Buffer.from(p.maps.texelSizeMeters.buffer, p.maps.texelSizeMeters.byteOffset, W * H * 4),
            Buffer.from(p.maps.coverage.buffer, p.maps.coverage.byteOffset, W * H)
        ]);
        fs.writeFileSync(path.join(dir, `prim${p.primitiveIndex}.maps.gz`), zlib.gzipSync(body, { level: 1 }));
    }
    const summary = { ...res, glbBuffer: undefined, outSha256: sha256(res.glbBuffer), key, primitives: res.primitives.map(p => ({ ...p, maps: undefined })) };
    fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(summary));
}

function readFusionCache(dir: string, key: string, outGlb: string): StreetViewTextureFusionResult | null {
    const sp = path.join(dir, 'summary.json');
    if (!fs.existsSync(sp) || !fs.existsSync(outGlb)) return null;
    const summary = JSON.parse(fs.readFileSync(sp, 'utf8'));
    const out = fs.readFileSync(outGlb);
    if (summary.key !== key || summary.outSha256 !== sha256(out)) return null;
    for (const p of summary.primitives) {
        const f = path.join(dir, `prim${p.primitiveIndex}.maps.gz`);
        if (!fs.existsSync(f)) continue;
        const b = zlib.gunzipSync(fs.readFileSync(f));
        const W = b.readUInt32LE(0), H = b.readUInt32LE(4), N = W * H;
        const copy = (off: number, bytes: number) => b.buffer.slice(b.byteOffset + off, b.byteOffset + off + bytes);
        p.maps = {
            width: W, height: H,
            confidence: new Float32Array(copy(8, N * 4)),
            texelSizeMeters: new Float32Array(copy(8 + N * 4, N * 4)),
            coverage: new Uint8Array(copy(8 + N * 8, N)),
            worldPositions: new Float32Array(0), worldNormals: new Float32Array(0)
        };
    }
    return { ...summary, glbBuffer: out };
}

// ============================================================================================
// Diagnostic GLB: baseColor = fused confidence (replaced primitives), black elsewhere
// ============================================================================================

function writeConfidenceGlb(fusedGlb: Buffer, res: StreetViewTextureFusionResult, outPath: string): void {
    const { json, bin } = AlgorithmicUvEngine.parseGlb(fusedGlb);
    const parts: Buffer[] = [bin];
    let len = bin.length;
    const addView = (b: Buffer) => {
        const al = (len + 3) & ~3;
        if (al > len) parts.push(Buffer.alloc(al - len));
        parts.push(b); len = al + b.length;
        json.bufferViews.push({ buffer: 0, byteOffset: al, byteLength: b.length });
        return json.bufferViews.length - 1;
    };
    const addTexturedMaterial = (png: Buffer) => {
        json.images.push({ bufferView: addView(png), mimeType: 'image/png' });
        json.textures.push({ source: json.images.length - 1 });
        json.materials.push({
            pbrMetallicRoughness: { baseColorTexture: { index: json.textures.length - 1, texCoord: 0 }, metallicFactor: 0, roughnessFactor: 1 },
            extensions: { KHR_materials_unlit: {} }
        });
        return json.materials.length - 1;
    };
    const black = addTexturedMaterial(encodePng(4, 4, Buffer.from(new Uint8Array(4 * 4 * 4).map((_, i) => (i % 4 === 3 ? 255 : 0)))));
    const replaced = new Map(res.primitives.filter(p => p.replaced && p.maps).map(p => [p.primitiveIndex, p]));
    let k = 0;
    for (const mesh of json.meshes || []) for (const prim of mesh.primitives || []) {
        if (!prim.attributes || prim.attributes.POSITION === undefined) continue;
        const rep = replaced.get(k++);
        if (!rep || !rep.maps) { prim.material = black; continue; }
        const { width: W, height: H, confidence: c } = rep.maps;
        const rgba = Buffer.alloc(W * H * 4);
        for (let i = 0; i < W * H; i++) { const v = Math.round(Math.min(1, Math.max(0, c[i])) * 255); rgba[i * 4] = v; rgba[i * 4 + 1] = v; rgba[i * 4 + 2] = v; rgba[i * 4 + 3] = 255; }
        prim.material = addTexturedMaterial(encodePng(W, H, rgba));
    }
    const merged = Buffer.concat(parts, len);
    json.buffers[0].byteLength = merged.length;
    const cg = compactGlb(json, merged);
    fs.writeFileSync(outPath, AlgorithmicUvEngine.serializeGlb(cg.json, cg.bin));
}

// ============================================================================================
// Rendering
// ============================================================================================

interface View {
    id: string;
    kind: 'plate' | 'held-out' | 'facade-midrise' | 'aerial';
    position: [number, number, number]; target: [number, number, number]; up: [number, number, number]; verticalFovDeg: number;
    width: number; height: number;
    photo?: { rgba: Buffer; valid: Uint8Array; panoId: string; id: string };
}

function viewFromCamera(id: string, kind: View['kind'], cam: FrameCamera): View {
    const p = frameCameraToPose(cam);
    return { id, kind, position: [p.x, p.y, p.z], target: [p.targetX, p.targetY, p.targetZ], up: (p.up ?? [0, 1, 0]) as [number, number, number], verticalFovDeg: p.fov, width: cam.width, height: cam.height };
}

interface RenderOut { albedo: Buffer; beauty: Buffer; coverage: Uint8Array; width: number; height: number }

interface Sun { latitude: number; longitude: number; unixSeconds: number }

/** Sun for the renderer config: the plates' anchor and the median capture month (only 'relit' shading uses it). */
function sunFromPlates(file: StreetViewPlatesFile): Sun {
    const months = file.plates.map(p => /^(\d{4})-(\d{2})/.exec(p.date ?? '')).filter((m): m is RegExpExecArray => !!m).map(m => Date.UTC(Number(m[1]), Number(m[2]) - 1, 15, 16) / 1000).sort((a, b) => a - b);
    return { latitude: file.anchor.lat, longitude: file.anchor.lng, unixSeconds: months.length ? months[months.length >> 1] : Math.round(Date.parse(file.createdAt) / 1000) };
}

function render(renderer: string, glb: string, v: View, dir: string, sun: Sun, exposure = 3): RenderOut {
    fs.mkdirSync(dir, { recursive: true });
    const cfg = {
        glbPath: glb, outputDir: dir, width: v.width, height: v.height, samplesPerPixel: RENDER_SPP, maxBounces: 1, threads: 8, groundPlane: false,
        shadingMode: 'baked', denoise: false, exposure, sun,
        camera: { position: v.position, target: v.target, up: v.up, verticalFovDeg: v.verticalFovDeg }
    };
    const cfgPath = path.join(dir, 'cfg.json');
    fs.writeFileSync(cfgPath, JSON.stringify(cfg));
    const r = spawnSync(renderer, [cfgPath], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (r.status !== 0) throw new Error(`renderer failed (${r.status}) for ${v.id}: ${(r.stderr || r.stdout || '').slice(-400)}`);
    const albedo = decodePng(fs.readFileSync(path.join(dir, 'albedo.png'))), beauty = decodePng(fs.readFileSync(path.join(dir, 'beauty.png')));
    const depthRaw = fs.readFileSync(path.join(dir, 'depth.f32'));
    const coverage = new Uint8Array(v.width * v.height);
    for (let i = 0; i < coverage.length; i++) coverage[i] = depthRaw.readFloatLE(i * 4) > 0 ? 1 : 0;
    return { albedo: Buffer.from(albedo.rgba), beauty: Buffer.from(beauty.rgba), coverage, width: v.width, height: v.height };
}

function hstack(images: Array<{ rgba: Buffer | Uint8Array; width: number; height: number }>, gap = 6): { rgba: Buffer; width: number; height: number } {
    const H = Math.max(...images.map(i => i.height));
    const W = images.reduce((s, i) => s + i.width, 0) + gap * (images.length - 1);
    const out = Buffer.alloc(W * H * 4, 255);
    let x0 = 0;
    for (const im of images) {
        for (let y = 0; y < im.height; y++) Buffer.from(im.rgba.buffer, im.rgba.byteOffset + y * im.width * 4, im.width * 4).copy(out, (y * W + x0) * 4);
        x0 += im.width + gap;
    }
    return { rgba: out, width: W, height: H };
}

/** Beauty render with c >= 0.5 tinted green and 0 < c < 0.5 tinted amber (confidence from the diagnostic GLB). */
function confidenceOverlay(beauty: Buffer, conf: Buffer, n: number): Buffer {
    const out = Buffer.from(beauty);
    for (let i = 0; i < n; i++) {
        const c = conf[i * 4] / 255;
        if (c <= 0.02) continue;
        const [tr, tg, tb] = c >= 0.5 ? [40, 220, 90] : [240, 170, 40];
        const a = c >= 0.5 ? 0.45 : 0.35;
        out[i * 4] = Math.round(out[i * 4] * (1 - a) + tr * a);
        out[i * 4 + 1] = Math.round(out[i * 4 + 1] * (1 - a) + tg * a);
        out[i * 4 + 2] = Math.round(out[i * 4 + 2] * (1 - a) + tb * a);
    }
    return out;
}

// ============================================================================================
// Main
// ============================================================================================

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const t0 = Date.now();
    fs.mkdirSync(args.work, { recursive: true });
    const platesFile: StreetViewPlatesFile = JSON.parse(fs.readFileSync(args.plates, 'utf8'));
    const platesDir = path.dirname(args.plates);
    const baseBuf = fs.readFileSync(args.baseGlb);

    // ---------------- Plates (E7/E8 inputs) ----------------
    const registeredOn = path.resolve(platesDir, platesFile.glbPath);
    const sameMesh = fs.existsSync(registeredOn) && sha256(fs.readFileSync(registeredOn)) === sha256(baseBuf);
    const rerender = args.rerenderDepth === 'always' || (args.rerenderDepth === 'auto' && !sameMesh);
    const scenePrims = readGlbScene(args.baseGlb);
    const mesh = sceneToRenderMesh(scenePrims);
    const plates = loadStreetViewPlates(args.plates, { minPoseQuality: args.minPoseQuality, depthMesh: rerender ? mesh : undefined });
    if (args.poseQualityOverride !== null) {
        for (const p of plates) if (p.poseQuality > 0) p.poseQuality = args.poseQualityOverride;
        log(`DIAGNOSTIC: poseQuality of every projected plate overridden to ${args.poseQualityOverride}`);
    }
    log(`base ${rel(args.baseGlb)} (${(baseBuf.length / 1e6).toFixed(2)} MB); plates registered on ${rel(registeredOn)}${sameMesh ? ' (same bytes)' : ''}; ` +
        `depth ${rerender ? 're-rendered from the base mesh' : 'read from the plate files'}; ${plates.length} plates: ` +
        plates.map(p => `${p.id.slice(0, 8)} q=${p.poseQuality.toFixed(2)}`).join(', '));

    // Primitive order check: readGlbScene (coverage samples) and the fusion (mesh order) must agree
    const unprojPrims = SurveyTextureUnprojector.loadMeshPrimitives(baseBuf, 512, { decodeAllIndexTypes: true }).primitives;
    if (unprojPrims.length !== scenePrims.length || unprojPrims.some((p, i) => p.indices.length !== scenePrims[i].indices.length)) {
        throw new Error('primitive order differs between readGlbScene and SurveyTextureUnprojector.loadMeshPrimitives (node transforms or instancing?)');
    }

    // ---------------- Scan analysis: hero footprint (region filter, coverage gate, views) ----------------
    const sun = sunFromPlates(platesFile);
    const tc = Date.now();
    const scan = loadScanMesh(args.baseGlb);
    const ground = buildGroundModel(scan);
    const hero = findHeroFootprint(scan, ground);
    const targets = buildTargetSamples(scan, ground, hero);
    const marginCells = Math.max(0, Math.round(args.heroMargin / ground.cellMeters));
    const inHero = (x: number, z: number): boolean => {
        for (let dz = -marginCells; dz <= marginCells; dz++) for (let dx = -marginCells; dx <= marginCells; dx++) {
            const ci = ground.cellIndex(x + dx * ground.cellMeters, z + dz * ground.cellMeters);
            if (ci >= 0 && hero.footprint[ci]) return true;
        }
        return false;
    };
    // Hero texels only: inside the footprint and not ground-level horizontal surfaces (sidewalk inside the dilation)
    const texelFilter = args.region === 'hero'
        ? (x: number, y: number, z: number, _nx: number, ny: number) => inHero(x, z) && !(ny > 0.7 && y < hero.groundY + 2)
        : undefined;
    const primitiveFilter = args.region === 'hero'
        ? (_i: number, prim: { positions: Float32Array }) => {
            const P = prim.positions;
            for (let v = 0; v < P.length; v += 3) if (inHero(P[v], P[v + 2])) return true;
            return false;
        }
        : undefined;

    // ---------------- E8-E10 fusion ----------------
    const tf = Date.now();
    const cacheDir = path.join(args.work, 'fusion_cache');
    const fusionKey = sha256(Buffer.from(JSON.stringify({
        base: sha256(baseBuf), plates: plates.map(p => [p.id, p.poseQuality, sha256(Buffer.from(p.depth.buffer, p.depth.byteOffset, p.depth.byteLength))]),
        maxScale: args.maxScale, guard: args.depthEdgeGuardPx, guardM: args.depthEdgeGuardMeters, region: args.region, heroMargin: args.heroMargin, detailMode: args.detailMode, lowPassSigma: args.lowPassSigma, fusionVersion: 3
    })));
    let res: StreetViewTextureFusionResult | null = args.reuseFusion ? readFusionCache(cacheDir, fusionKey, args.out) : null;
    if (res) {
        log(`fusion: reused ${rel(cacheDir)} (${res.imagesReplaced} images replaced, ${(res.bytes / 1e6).toFixed(2)} MB)`);
    } else {
        if (args.reuseFusion) log('fusion: no matching cache, running the fusion');
        res = await StreetViewTextureFusion.fuse({
            glbPath: args.baseGlb,
            plates,
            options: {
                outGlbPath: args.out,
                maxScale: args.maxScale,
                depthEdgeGuardPx: args.depthEdgeGuardPx,
                depthEdgeGuardMeters: args.depthEdgeGuardMeters,
                detailMode: args.detailMode,
                lowPassSigmaTexels: args.lowPassSigma,
                returnConfidenceMaps: true,
                texelFilter,
                primitiveFilter,
                // Default colour gate: any unobserved texel leaking into the output would be magenta.
                unprojectorOverrides: { defaultColor: [255, 0, 255] },
                log: m => { if (!m.startsWith('[SurveyTextureUnprojector]')) log(m); }
            }
        });
        log(`fusion: ${res.imagesReplaced} images replaced, ${(res.bytes / 1e6).toFixed(2)} MB, ${((Date.now() - tf) / 1000).toFixed(0)} s -> ${rel(args.out)}`);
        writeFusionCache(cacheDir, fusionKey, res);
    }
    const outBuf = fs.readFileSync(args.out);

    // ---------------- Gates ----------------
    const gates: Gate[] = [];
    const report: any = {
        createdAt: new Date().toISOString(), baseGlb: rel(args.baseGlb), baseSha256: sha256(baseBuf), plates: rel(args.plates), out: rel(args.out),
        outSha256: sha256(outBuf), anchor: args.anchor ?? platesFile.anchor, depthRerendered: rerender, depthEdgeGuardPx: args.depthEdgeGuardPx,
        depthEdgeGuardMeters: args.depthEdgeGuardMeters, region: args.region, heroMargin: args.heroMargin, renderSpp: RENDER_SPP,
        detailMode: args.detailMode, lowPassSigmaTexels: args.lowPassSigma
    };

    // Pose: every projected plate must meet the plan E6 gates (read from the registrar's pose report)
    const poseReportPath = path.join(platesDir, 'pose_report.json');
    const poseReport = fs.existsSync(poseReportPath) ? JSON.parse(fs.readFileSync(poseReportPath, 'utf8')) : null;
    const frameIndex = new Map<string, { frame: any; pano: any }>();
    if (poseReport) for (const pano of poseReport.panos) for (const fr of pano.frames) frameIndex.set(fr.key, { frame: fr, pano });
    const used = plates.filter(p => p.poseQuality > 0);
    const plateGates = plates.map(p => {
        const e = frameIndex.get(p.id);
        const planReasons = e ? evaluateFrameGates(e.frame.gateInput, e.pano.atBound ?? [], { ...PLAN_GATES } as RegistrationGates) : ['no pose_report entry'];
        const activeReasons = e && poseReport.activeGates ? evaluateFrameGates(e.frame.gateInput, e.pano.atBound ?? [], poseReport.activeGates) : null;
        return {
            id: p.id, panoId: p.panoId, date: p.date, poseQuality: r3(p.poseQuality), projected: p.poseQuality > 0,
            silhouetteMedianPx: r3(p.record.registration.silhouetteMedianPx, 2), lineMedianPx: r3(p.record.registration.creaseMedianPx, 2), skyIoU: r3(p.record.registration.skyIoU),
            photometricNcc: e ? r3(e.frame.gateInput.final.photometricNcc) : null, moveMeters: r3(p.record.registration.moveMeters, 2),
            planGateReasons: planReasons, activeGateReasons: activeReasons
        };
    });
    report.plates = plateGates.map(pg => {
        const rec = plates.find(p => p.id === pg.id)!.record;
        return { ...pg, crossView: rec.registration.crossView ?? null };
    });
    report.registrationGatesActive = poseReport?.activeGates ?? null;
    const activeGates: RegistrationGates | null = poseReport?.activeGates ?? null;
    const crossOn = !!activeGates && activeGates.crossViewMedianPx !== null && activeGates.crossViewMedianPx !== undefined;
    const activePass = plateGates.filter(p => p.projected && p.activeGateReasons !== null && p.activeGateReasons.length === 0).length;
    const planPass = plateGates.filter(p => p.projected && p.planGateReasons.length === 0).length;
    gates.push({
        name: 'pose: every projected frame passes the texturing gates with cross-view certification', pass: used.length > 0 && crossOn && activePass === used.length,
        value: `${activePass}/${used.length} projected frames pass (${poseReport ? `${poseReport.summary?.acceptedActiveGates ?? '?'}/${poseReport.summary?.frames ?? '?'} registered frames accepted` : 'no pose report'}); ` +
            `cross-view medians ${used.map(p => p.record.registration.crossView?.medianPx?.toFixed(2) ?? 'n/a').join(', ')} px`,
        threshold: crossOn ? `cross-view median <= ${activeGates!.crossViewMedianPx} px, p75 <= ${activeGates!.crossViewP75Px} px, >= ${activeGates!.crossViewMinMatches} matches; silhouette <= ${activeGates!.silhouetteMedianPx} px, sky IoU >= ${activeGates!.skyIoU}` : 'cross-view gate must be on',
        note: crossOn ? undefined : 'plates.json was built without the cross-view gate: interior alignment is not certified'
    });
    gates.push({
        name: 'pose: plan E6 gates as written (line <= 3 px, solo agreement)', pass: null,
        value: `${planPass}/${used.length} projected frames`,
        threshold: 'silhouette <= 2 px, line <= 3 px, sky IoU >= 0.96, not at bound, frames agree <= 0.5 m / 0.3 deg',
        note: 'informational: superseded by the cross-view gate (tile creases are bevelled/eroded, so their residual saturates at the 15 px truncation even at a correct pose; the silhouette is blind to translation)'
    });

    // Coverage: c >= 0.5 over the hero's street-visible facade below 120 m (mesh-derived hero, target samples)
    const st = fs.statSync(args.baseGlb);
    const scanKey = `${st.size}_${Math.round(st.mtimeMs)}_${targets.count}`;
    const planPath = path.join(args.svCache, 'plan.json');
    let streetVisible: Uint8Array | null = null;
    let visiblePanos = 0;
    if (fs.existsSync(planPath)) {
        const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
        streetVisible = new Uint8Array(targets.count);
        const camH = 2.5;
        for (const p of plan.panos) {
            const streetY = localStreetHeight(scan, ground, p.x, p.z);
            if (!(streetY === streetY)) continue;
            const v = computePanoVisibilityCached(scan, targets, [p.x, streetY + camH, p.z], p.panoId, path.join(args.svCache, 'visibility'), scanKey);
            for (const s of v.idx) streetVisible[s] = 1;
            visiblePanos++;
        }
    } else {
        log(`no ${rel(planPath)}: coverage denominator falls back to all hero facade samples`);
    }
    const maps = new Map<number, { width: number; height: number; confidence: Float32Array }>();
    for (const p of res.primitives) if (p.replaced && p.maps) maps.set(p.primitiveIndex, p.maps);
    const sideName = (s: number) => (s < targets.facadeSides ? `facade ${hero.sideHeadingsDeg[s].toFixed(0)}deg` : 'roof/terrace');
    const bandName = (b: number) => `${HEIGHT_BANDS[b][0]}-${HEIGHT_BANDS[b][1] === Infinity ? 'top' : HEIGHT_BANDS[b][1]} m`;
    const mkSamples = (inGate: (s: number) => boolean, groupBy: (s: number) => string) => {
        const g: string[] = new Array(targets.count), gate = new Uint8Array(targets.count);
        for (let s = 0; s < targets.count; s++) { g[s] = groupBy(s); gate[s] = inGate(s) ? 1 : 0; }
        return { count: targets.count, pos: targets.pos, area: targets.area, triangle: targets.triangle, group: g, inGate: gate };
    };
    const facadeBelow = (s: number) => targets.side[s] < targets.facadeSides && targets.heightAboveGround[s] < 120;
    const covStreet: CoverageResult = confidenceCoverageAtSamples(
        mkSamples(s => facadeBelow(s) && (!streetVisible || streetVisible[s] === 1), s => `${sideName(targets.side[s])} | ${bandName(targets.band[s])}`), scenePrims, maps);
    const covAll: CoverageResult = confidenceCoverageAtSamples(mkSamples(facadeBelow, s => (targets.side[s] < targets.facadeSides ? 'facade' : 'other')), scenePrims, maps);
    const covBySideBelow = confidenceCoverageAtSamples(
        mkSamples(s => facadeBelow(s) && (!streetVisible || streetVisible[s] === 1), s => sideName(targets.side[s])), scenePrims, maps);
    report.coverage = {
        hero: { footprintM2: r3(hero.areaM2, 0), heightMeters: r3(hero.heightMeters, 1), groundY: r3(hero.groundY, 2), sideHeadingsDeg: hero.sideHeadingsDeg.map(h => r3(h, 2)) },
        targetSamples: targets.count, streetVisibilityPanos: visiblePanos, ms: Date.now() - tc,
        streetVisibleFacadeBelow120m: { areaM2: r3(covStreet.gateAreaM2, 0), confidentM2: r3(covStreet.gateConfidentM2, 0), fraction: r3(covStreet.gateFraction) },
        allFacadeBelow120m: { areaM2: r3(covAll.gateAreaM2, 0), confidentM2: r3(covAll.gateConfidentM2, 0), fraction: r3(covAll.gateFraction), note: 'includes hidden shells / party walls on an unculled mesh' },
        bySide: covBySideBelow.byGroup.filter(g => g.gateAreaM2 > 0).map(g => ({ side: g.group, areaM2: r3(g.gateAreaM2, 0), confidentM2: r3(g.gateConfidentM2, 0), fraction: r3(g.gateFraction) })),
        bySideAndBand: covStreet.byGroup.map(g => ({ cell: g.group, streetVisibleM2: r3(g.gateAreaM2, 0), confidentStreetVisibleM2: r3(g.gateConfidentM2, 0), fraction: r3(g.gateFraction), allAreaM2: r3(g.areaM2, 0), confidentAllM2: r3(g.confidentM2, 0) })),
        samplesOutsideMaps: covStreet.samplesOutsideMaps
    };
    gates.push({
        name: 'coverage: hero visible facade below 120 m with c >= 0.5', pass: covStreet.gateFraction >= 0.6,
        value: `${(covStreet.gateFraction * 100).toFixed(1)}% (${covStreet.gateConfidentM2.toFixed(0)} of ${covStreet.gateAreaM2.toFixed(0)} m2 street-visible)`,
        threshold: '>= 60%', note: `all hero facade below 120 m incl. hidden surfaces: ${(covAll.gateFraction * 100).toFixed(1)}%`
    });

    // Image identity: only replaced primitives change; c = 0 primitives byte-identical
    const replacedSet = new Set(res.primitives.filter(p => p.replaced).map(p => p.primitiveIndex));
    const ident = compareBaseColorImages(baseBuf, outBuf, replacedSet);
    const zeroC = res.primitives.filter(p => !(p.maxConfidence > 0)).map(p => p.primitiveIndex);
    const zeroChanged = zeroC.filter(i => ident.changed.includes(i));
    report.imageIdentity = { ...ident, zeroConfidencePrimitives: zeroC.length, zeroConfidenceChanged: zeroChanged };
    gates.push({
        name: 'primitives with c = 0 keep byte-identical images', pass: zeroChanged.length === 0 && ident.unexpectedChanges.length === 0 && ident.declaredButIdentical.length === 0,
        value: `${ident.changed.length} changed (= ${replacedSet.size} replaced), ${ident.unchanged.length} identical; ${zeroChanged.length} of ${zeroC.length} c = 0 primitives changed; ${ident.unexpectedChanges.length} unexpected`,
        threshold: '0 changed outside the replaced set'
    });

    // Replaced-image audits: default colour, seam, colour cast
    const inImgs = listPrimitiveBaseColorImages(baseBuf), outImgs = listPrimitiveBaseColorImages(outBuf);
    const bytesOf = (g: ReturnType<typeof listPrimitiveBaseColorImages>, i: number): Buffer => {
        const im = g.json.images[g.prims[i].imageIndex!];
        const bv = g.json.bufferViews[im.bufferView];
        return g.bin.subarray(bv.byteOffset || 0, (bv.byteOffset || 0) + bv.byteLength);
    };
    const audits: ReplacedImageAudit[] = [];
    for (const p of res.primitives) {
        if (!p.replaced || !p.maps) continue;
        audits.push(await auditReplacedImage(p.primitiveIndex, bytesOf(inImgs, p.primitiveIndex), bytesOf(outImgs, p.primitiveIndex), p.maps, p.scale));
    }
    report.replacedImages = audits.map(a => ({ ...a, meanDeltaL: r3(a.meanDeltaL, 2), meanDeltaA: r3(a.meanDeltaA, 2), meanDeltaB: r3(a.meanDeltaB, 2), controlDeltaL: r3(a.controlDeltaL, 2), controlDeltaA: r3(a.controlDeltaA, 2), controlDeltaB: r3(a.controlDeltaB, 2), seamDeltaE00Mean: r3(a.seamDeltaE00Mean), seamDeltaE00P95: r3(a.seamDeltaE00P95) }));
    const magenta = audits.reduce((s, a) => s + a.magentaTexels, 0), magentaIn = audits.reduce((s, a) => s + a.magentaTexelsInput, 0);
    gates.push({
        name: 'zero default-colour texels (run with defaultColor magenta)', pass: magenta === 0 && res.totals.defaultColorTexels === 0,
        value: `${magenta} magenta texels in replaced images (input had ${magentaIn}); fusion's own count ${res.totals.defaultColorTexels}`, threshold: '0'
    });
    const bandTex = audits.reduce((s, a) => s + a.seamBandTexels, 0);
    const seamMean = bandTex ? audits.reduce((s, a) => s + a.seamDeltaE00Mean * a.seamBandTexels, 0) / bandTex : 0;
    gates.push({
        name: 'seam: boundary-band mean low-pass dE00', pass: audits.length ? seamMean <= 3 : null,
        value: `${seamMean.toFixed(3)} (worst primitive p95 ${Math.max(0, ...audits.map(a => a.seamDeltaE00P95)).toFixed(2)}; fusion's own figure ${res.totals.seamDeltaE00Mean.toFixed(3)})`, threshold: '<= 3'
    });
    const mats = auditMaterials(outBuf), matsIn = auditMaterials(baseBuf);
    const worst = (f: (a: ReplacedImageAudit) => number) => (audits.length ? audits.map(f).reduce((m, v) => (Math.abs(v) > Math.abs(m) ? v : m), 0) : 0);
    const castA = worst(a => a.meanDeltaA), castB = worst(a => a.meanDeltaB);
    const ctrlA = worst(a => a.controlDeltaA), ctrlB = worst(a => a.controlDeltaB);
    report.materials = { output: mats, input: { materials: matsIn.materials, unlit: matsIn.unlit, metallic: matsIn.metallic.length } };
    gates.push({
        name: 'no metallic materials; no colour cast (confident texels) and no re-encode shift (c = 0 texels)',
        pass: mats.metallic.length === 0 && magenta === 0 && Math.abs(castA) <= 2 && Math.abs(castB) <= 2 && Math.abs(ctrlA) <= 0.5 && Math.abs(ctrlB) <= 0.5,
        value: `${mats.metallic.length} metallic of ${mats.materials} (unlit ${mats.unlit}, input unlit ${matsIn.unlit}); worst per-image mean da* ${castA.toFixed(2)}, db* ${castB.toFixed(2)} on c >= 0.5 texels; ` +
            `c = 0 control da* ${ctrlA.toFixed(2)}, db* ${ctrlB.toFixed(2)}`,
        threshold: '0 metallic (unlit included), 0 magenta texels, |mean da*|, |mean db*| <= 2 on confident texels and <= 0.5 on c = 0 texels'
    });
    gates.push({ name: 'file size', pass: outBuf.length <= MAX_BYTES, value: `${(outBuf.length / 1e6).toFixed(2)} MB`, threshold: '<= 45 MB' });

    // ---------------- Renders ----------------
    const views: View[] = [];
    if (args.render) {
        if (!fs.existsSync(args.renderer)) throw new Error(`renderer not found: ${rel(args.renderer)}`);
        const confGlb = path.join(args.work, 'confidence.glb');
        writeConfidenceGlb(outBuf, res, confGlb);
        const photoOf = (rec: StreetViewPlateRecord) => {
            const img = decodeImageToRgba(fs.readFileSync(path.resolve(platesDir, rec.imagePath)));
            return { rgba: img.rgba, valid: readPlateMask(path.resolve(platesDir, rec.maskPngPath), rec.width, rec.height), panoId: rec.panoId, id: rec.id };
        };
        for (const p of plates) views.push({ ...viewFromCamera(`plate_${p.id}`, 'plate', plateRecordCamera(p.record)), photo: photoOf(p.record) });

        // Facade mid-rise pose: in front of the hero side with the most confident street-visible area, aimed at the
        // area-weighted centre of its street-visible 30-90 m samples. Candidate eyes go out along the side's outward
        // heading (farthest first) and up in steps; a candidate is kept when at least 7 of 9 central rays first hit
        // the hero footprint (nothing in between, and the eye is not inside a neighbouring building).
        const sideStats = hero.sideHeadingsDeg.map((_, s) => ({ s, conf: covBySideBelow.byGroup.find(g => g.group === sideName(s))?.gateConfidentM2 ?? 0 }));
        const bestSide = sideStats.sort((a, b) => b.conf - a.conf)[0].s;
        let sx = 0, sy = 0, sz = 0, sn = 0;
        for (let s = 0; s < targets.count; s++) {
            if (targets.side[s] !== bestSide || targets.heightAboveGround[s] < 30 || targets.heightAboveGround[s] > 90 || (streetVisible && !streetVisible[s])) continue;
            sx += targets.pos[s * 3] * targets.area[s]; sy += targets.pos[s * 3 + 1] * targets.area[s]; sz += targets.pos[s * 3 + 2] * targets.area[s]; sn += targets.area[s];
        }
        if (sn > 0) {
            const tgt: [number, number, number] = [sx / sn, sy / sn, sz / sn];
            const h = hero.sideHeadingsDeg[bestSide] * DEG, out: [number, number] = [Math.sin(h), -Math.cos(h)];
            const R = 64;
            let chosen: View | null = null;
            search: for (const rise of [0, 25, 50, 80, 120]) {
                for (const d of [160, 140, 120, 100, 80, 60]) {
                    const eye: [number, number, number] = [tgt[0] + out[0] * d, tgt[1] + rise, tgt[2] + out[1] * d];
                    const f = [tgt[0] - eye[0], tgt[1] - eye[1], tgt[2] - eye[2]];
                    const fl = Math.hypot(f[0], f[1], f[2]);
                    const fwd: [number, number, number] = [f[0] / fl, f[1] / fl, f[2] / fl];
                    const rl = Math.hypot(fwd[2], fwd[0]);
                    const right: [number, number, number] = [-fwd[2] / rl, 0, fwd[0] / rl];
                    const up: [number, number, number] = [right[1] * fwd[2] - right[2] * fwd[1], right[2] * fwd[0] - right[0] * fwd[2], right[0] * fwd[1] - right[1] * fwd[0]];
                    const cam: FrameCamera = { eye, fwd, right, up, fx: R / 2, fy: R / 2, cx: R / 2, cy: R / 2, width: R, height: R };
                    const depth = renderFrameDepth(mesh, cam);
                    let heroHits = 0;
                    for (const oy of [-6, 0, 6]) for (const ox of [-6, 0, 6]) {
                        const px = R / 2 + ox, py = R / 2 + oy, z = depth[py * R + px];
                        if (!(z < 1e8)) continue;
                        const u = (px + 0.5 - cam.cx) / cam.fx, v = -(py + 0.5 - cam.cy) / cam.fy;
                        const hx = eye[0] + z * (fwd[0] + u * right[0] + v * up[0]), hz = eye[2] + z * (fwd[2] + u * right[2] + v * up[2]);
                        const ci = ground.cellIndex(hx, hz);
                        if (ci >= 0 && hero.footprint[ci]) heroHits++;
                    }
                    if (heroHits >= 7) {
                        chosen = { id: `facade_midrise_side${hero.sideHeadingsDeg[bestSide].toFixed(0)}_d${d}_rise${rise}`, kind: 'facade-midrise', position: eye, target: tgt, up: [0, 1, 0], verticalFovDeg: 50, width: 960, height: 640 };
                        break search;
                    }
                }
            }
            if (chosen) views.push(chosen); else log('facade mid-rise pose: no unobstructed candidate found');
        }
        // Aerial: 45 deg off the best side, 300 m out, 240 m above the hero ground
        {
            const h = (hero.sideHeadingsDeg[bestSide] + 45) * DEG;
            const c = hero.centroid;
            views.push({ id: 'aerial', kind: 'aerial', position: [c.x + Math.sin(h) * 300, hero.groundY + 240, c.z - Math.cos(h) * 300], target: [c.x, hero.groundY + 70, c.z], up: [0, 1, 0], verticalFovDeg: 45, width: 960, height: 640 });
        }
        // Held-out views: rejected frames (never projected), ranked by confident pixels in view
        if (poseReport && args.heldOut > 0) {
            const usedPanos = new Set(used.map(p => p.panoId));
            const cands: Array<{ v: View; confPx: number; independentPano: boolean }> = [];
            for (const [key, e] of frameIndex) {
                if (plates.some(p => p.id === key) || !e.frame.plate) continue;
                const rec: StreetViewPlateRecord = e.frame.plate;
                if (!fs.existsSync(path.resolve(platesDir, rec.imagePath)) || !fs.existsSync(path.resolve(platesDir, rec.maskPngPath))) continue;
                const v = viewFromCamera(`heldout_${key}`, 'held-out', plateRecordCamera(rec));
                const valid = readPlateMask(path.resolve(platesDir, rec.maskPngPath), rec.width, rec.height);
                const cr = render(args.renderer, confGlb, v, path.join(args.work, 'renders', v.id, 'conf'), sun);
                let n = 0;
                for (let i = 0; i < valid.length; i++) if (valid[i] && cr.albedo[i * 4] >= 128) n++;
                cands.push({ v: { ...v, photo: photoOf(rec) }, confPx: n, independentPano: !usedPanos.has(rec.panoId) });
            }
            cands.sort((a, b) => (Number(b.independentPano) - Number(a.independentPano)) || b.confPx - a.confPx);
            const picked = cands.filter(c => c.confPx >= 2000).slice(0, args.heldOut);
            report.heldOutCandidates = cands.map(c => ({ id: c.v.id, confidentPixels: c.confPx, independentPano: c.independentPano }));
            for (const c of picked) views.push(c.v);
        }

        fs.mkdirSync(args.shots, { recursive: true });
        const rows: any[] = [];
        for (const v of views) {
            const dir = path.join(args.work, 'renders', v.id);
            const A = render(args.renderer, args.baseGlb, v, path.join(dir, 'base'), sun, args.exposure);
            const B = render(args.renderer, args.out, v, path.join(dir, 'stage3'), sun, args.exposure);
            const C = render(args.renderer, confGlb, v, path.join(dir, 'conf'), sun);
            const n = v.width * v.height;
            const confMask = new Uint8Array(n), meshMask = new Uint8Array(n);
            let confPx = 0;
            for (let i = 0; i < n; i++) {
                meshMask[i] = A.coverage[i] && B.coverage[i] ? 1 : 0;
                if (meshMask[i] && C.albedo[i * 4] >= 128 && (!v.photo || v.photo.valid[i])) { confMask[i] = 1; confPx++; }
            }
            const la = luminance8(A.albedo, n), lb = luminance8(B.albedo, n);
            const lapA = laplacianVariance(la, v.width, v.height, confMask), lapB = laplacianVariance(lb, v.width, v.height, confMask);
            const soA = sobelEnergy(la, v.width, v.height, confMask), soB = sobelEnergy(lb, v.width, v.height, confMask);
            const row: any = {
                view: v.id, kind: v.kind, confidentPixels: confPx, confidentFraction: r3(confPx / n, 4), lapVarBase: r3(lapA.variance, 2), lapVarStage3: r3(lapB.variance, 2), sharpnessGain: lapA.variance > 0 ? r3(lapB.variance / lapA.variance, 2) : null,
                sobelXGain: soA.x > 0 ? r3(soB.x / soA.x, 3) : null, sobelYGain: soA.y > 0 ? r3(soB.y / soA.y, 3) : null
            };
            const panels: Array<{ rgba: Buffer; width: number; height: number }> = [];
            if (v.photo) {
                const valid = new Uint8Array(n);
                for (let i = 0; i < n; i++) valid[i] = v.photo.valid[i] && meshMask[i] ? 1 : 0;
                const lp = luminance8(v.photo.rgba, n);
                const lpB = blur1(lp, v.width, v.height, 1);
                const nccA = maskedNcc(blur1(la, v.width, v.height, 1), lpB, valid), nccB = maskedNcc(blur1(lb, v.width, v.height, 1), lpB, valid);
                const nccAc = maskedNcc(blur1(la, v.width, v.height, 1), lpB, confMask), nccBc = maskedNcc(blur1(lb, v.width, v.height, 1), lpB, confMask);
                const eA = edgeResidualPx(la, lp, v.width, v.height, valid), eB = edgeResidualPx(lb, lp, v.width, v.height, valid);
                const eAc = edgeResidualPx(la, lp, v.width, v.height, confMask), eBc = edgeResidualPx(lb, lp, v.width, v.height, confMask);
                Object.assign(row, {
                    photoValidMeshPixels: nccA.pixels, nccBase: r3(nccA.ncc), nccStage3: r3(nccB.ncc), nccGain: nccA.ncc !== null && nccB.ncc !== null ? r3(nccB.ncc - nccA.ncc) : null,
                    nccBaseConfident: r3(nccAc.ncc), nccStage3Confident: r3(nccBc.ncc),
                    edgeMedianPxBase: eA.medianPx, edgeMedianPxStage3: eB.medianPx, edgeMedianPxBaseConfident: eAc.medianPx, edgeMedianPxStage3Confident: eBc.medianPx
                });
                panels.push({ rgba: v.photo.rgba, width: v.width, height: v.height });
            }
            panels.push({ rgba: A.beauty, width: v.width, height: v.height }, { rgba: B.beauty, width: v.width, height: v.height }, { rgba: confidenceOverlay(B.beauty, C.albedo, n), width: v.width, height: v.height });
            const hs = hstack(panels);
            const shot = path.join(args.shots, `${args.shotPrefix}_${v.id.replace(/[^A-Za-z0-9_.-]/g, '_')}.png`);
            fs.writeFileSync(shot, encodePng(hs.width, hs.height, hs.rgba));
            row.screenshot = rel(shot);
            row.panels = v.photo ? 'photo | base | stage3 | stage3 + confidence (green c>=0.5, amber 0<c<0.5)' : 'base | stage3 | stage3 + confidence';
            rows.push(row);
            log(`render ${v.id}: conf px ${confPx}, sharpness x${row.sharpnessGain ?? 'n/a'}${v.photo ? `, NCC ${row.nccBase} -> ${row.nccStage3}, edge ${row.edgeMedianPxBase} -> ${row.edgeMedianPxStage3} px` : ''}`);
        }
        report.renders = rows;
        report.views = views.map(v => ({ id: v.id, kind: v.kind, position: v.position.map(x => r3(x, 2)), target: v.target.map(x => r3(x, 2)), up: v.up.map(x => r3(x, 4)), verticalFovDeg: r3(v.verticalFovDeg, 3) }));

        // Sharpness gate: the 3 street-level plate poses with the most confident pixels
        const street = rows.filter(r => r.kind === 'plate' && r.confidentPixels > 0).sort((a, b) => b.confidentPixels - a.confidentPixels).slice(0, 3);
        gates.push({
            name: 'sharpness: Laplacian variance in SV-covered facade crops, 3 street poses', pass: street.length === 3 ? street.every(r => (r.sharpnessGain ?? 0) >= 1.5) : false,
            value: street.map(r => `${r.view.slice(6, 14)} x${r.sharpnessGain} (${r.confidentPixels} px)`).join(', ') || 'no street pose with confident pixels',
            threshold: '>= 1.5x on each of 3 street poses'
        });
        // No softening anywhere the photos changed the texture: vertical / horizontal edge energy must not drop
        const softRows = rows.filter(r => r.confidentPixels >= 2000);
        gates.push({
            name: 'no softening: Sobel x / y edge energy in confident pixels >= 0.95x base in every view', pass: softRows.length ? softRows.every(r => (r.sobelXGain ?? 0) >= 0.95 && (r.sobelYGain ?? 0) >= 0.95) : null,
            value: softRows.map(r => `${r.view.slice(0, 22)} x${r.sobelXGain}/${r.sobelYGain}`).join(', ') || 'no view with >= 2000 confident pixels',
            threshold: '>= 0.95x (x and y) per view with >= 2000 confident pixels'
        });
        const platesRows = rows.filter(r => r.kind === 'plate' && plates.find(p => `plate_${p.id}` === r.view)!.poseQuality > 0);
        gates.push({
            name: 'registration: NCC at each projected SV pose >= base + 0.10, edge residual <= 3 px', pass: platesRows.length ? platesRows.every(r => (r.nccGain ?? -1) >= 0.1 && (r.edgeMedianPxStage3 ?? 99) <= 3) : false,
            value: platesRows.map(r => `${r.view.slice(6, 14)} NCC ${r.nccBase}->${r.nccStage3} (+${r.nccGain}), edge ${r.edgeMedianPxBase}->${r.edgeMedianPxStage3} px`).join('; '),
            threshold: 'NCC gain >= 0.10 and median edge residual <= 3 px per projected pose',
            note: 'circular at the plate poses: the photo was projected from that pose; see held-out views for an independent check'
        });
        const held = rows.filter(r => r.kind === 'held-out');
        report.heldOutSummary = held.length ? {
            views: held.length,
            meanNccGainAllPixels: r3(held.reduce((s, r) => s + (r.nccGain ?? 0), 0) / held.length),
            meanNccGainConfidentPixels: r3(held.reduce((s, r) => s + ((r.nccStage3Confident ?? 0) - (r.nccBaseConfident ?? 0)), 0) / held.length),
            improved: held.filter(r => (r.nccStage3Confident ?? 0) > (r.nccBaseConfident ?? 0)).length
        } : null;
    } else {
        gates.push({ name: 'sharpness', pass: null, value: 'not measured (--no-render)', threshold: '>= 1.5x' });
        gates.push({ name: 'registration (render NCC / edges)', pass: null, value: 'not measured (--no-render)', threshold: 'NCC +0.10, edges <= 3 px' });
    }
    gates.push({ name: 'in-app viewport load (Scene3DPrimitive GLTFLoader) with no console errors', pass: null, value: 'not measured by this script', threshold: 'loads, no console errors' });

    report.fusion = {
        imagesReplaced: res.imagesReplaced, imagesRemoved: res.imagesRemoved, texturesRemoved: res.texturesRemoved, bufferViewsRemoved: res.bufferViewsRemoved,
        budgetDownscales: res.budgetDownscales, bytes: res.bytes, durationMs: Math.round(res.durationMs),
        totals: { chartAreaM2: r3(res.totals.chartAreaM2, 0), observedAreaM2: r3(res.totals.observedAreaM2, 0), confidentAreaM2: r3(res.totals.confidentAreaM2, 0), seamDeltaE00Mean: r3(res.totals.seamDeltaE00Mean), defaultColorTexels: res.totals.defaultColorTexels },
        plateExposure: res.plateExposure.map(e => ({ plate: plates[e.plate]?.id, samples: e.samples, gain: e.gain.map(g => r3(g)) })),
        primitives: res.primitives.filter(p => p.observedTexels > 0).map(p => ({
            i: p.primitiveIndex, replaced: p.replaced, skipped: p.skippedReason, scale: p.scale, size: `${p.width}x${p.height}`, observedM2: r3(p.observedAreaM2, 1), confidentM2: r3(p.confidentAreaM2, 1),
            maxC: r3(p.maxConfidence), factors: Object.fromEntries(Object.entries(p.confidenceFactors).map(([k, v]) => [k, r3(v as number)])), kb: p.outputImageBytes ? Math.round(p.outputImageBytes / 1024) : undefined
        }))
    };
    report.gates = gates;
    report.durationSec = Math.round((Date.now() - t0) / 1000);
    const reportPath = path.join(args.work, 'stage3_report.json');
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 1));
    console.log('\nStage 3 gates');
    for (const g of gates) console.log(`  [${g.pass === null ? 'n/a ' : g.pass ? 'PASS' : 'FAIL'}] ${g.name}: ${g.value} (gate ${g.threshold})${g.note ? ` - ${g.note}` : ''}`);
    log(`report -> ${rel(reportPath)} (${report.durationSec} s)`);
}

main().catch(e => { console.error(e?.stack ?? e); process.exit(1); });
