/**
 * One run of the micro-edit loop (packages/core/src/node/3d-engine/staged-location/micro-edits.ts) on one building's roof,
 * from a fresh extraction: the Google 3D Tiles around the point pulled into an empty cache, the building's Google vector
 * footprint, a Static Maps satellite crop per unit as the held-out photo. The building's plan is read from the place
 * store (or a local plan file), replayed, added to, verified and written back; the kept units are written as a labelled
 * GLB, and a sheet of the rooftop units (tile photo, held-out photo, the model from above, the scan and the edits seen
 * obliquely, the edit list and its metrics) is written beside it.
 *
 *   npx vite-node scripts/micro_edit_run.ts --lat 40.75065 --lng -73.99245 --radius 70 --out <dir> --run-id <id> \
 *       [--plan-file <local plan.json>] [--no-store] [--edits 1]
 *
 * Costs: the tile pull (one 3D Tiles session), the vector tiles, one Static Maps image per unit verified.
 */
import * as fs from 'fs';
import * as path from 'path';
import { GoogleTileDistrictCrawler } from '../packages/core/src/node/spatial/GoogleTileDistrictCrawler';
import { GoogleVectorTileService } from '../packages/core/src/node/spatial/GoogleVectorTileService';
import { fetchVectorEvidence } from '../packages/core/src/node/3d-engine/staged-location/vector-footprints';
import { readTileTriangles, type TileTriangles } from '../packages/core/src/node/3d-engine/staged-location/tile-texture-transfer';
import { drawModelTopDown, registerPlanImage, resamplePlanImage, tileCropAround, type PlanImage, type TopDownCrop } from '../packages/core/src/node/3d-engine/staged-location/micro-edit-evidence';
import { effectiveParams, emptyPlan, fromAnchor, insideFootprint, keptEdits, microEditContains, runMicroEditPass, supportDisc, toAnchor, writeMicroEditGlb, type BuiltUnit, type Footprint, type MicroEditPlan } from '../packages/core/src/node/3d-engine/staged-location/micro-edits';
import { fetchOrthoReference } from '../packages/core/src/node/3d-engine/staged-location/ortho-reference';
import { drawText, renderTriangles } from '../packages/core/src/node/3d-engine/staged-location/photo-match-eval';
import { encodePng } from '../packages/core/src/node/3d-engine/staged-location/png-encode';
import { loadMicroEditPlan, openPlaceStore, placeKey, saveMicroEditPlan } from '../packages/core/src/node/3d-engine/staged-location/place-store';
import type { PinholeCamera } from '../packages/core/src/common/spatial/texture-pass-contracts';

const arg = (name: string, fallback?: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback; };
const flag = (name: string) => process.argv.includes(`--${name}`);

function envKey(name: string): string | undefined {
    if (process.env[name]) return process.env[name];
    for (const dir of [process.cwd(), path.resolve(__dirname, '..'), path.resolve(__dirname, '../../../..')]) {
        const f = path.join(dir, '.env');
        if (!fs.existsSync(f)) continue;
        const m = fs.readFileSync(f, 'utf8').match(new RegExp(`^${name}\\s*=\\s*"?([^"\\n]+)"?`, 'm'));
        if (m?.[1]) return m[1].trim();
    }
    return undefined;
}

async function main() {
    const lat = Number(arg('lat')), lng = Number(arg('lng'));
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw new Error('--lat and --lng are required (a point on the building\'s roof)');
    const radius = Number(arg('radius', '70'));
    const out = path.resolve(arg('out', 'micro-edit-run')!);
    const runId = arg('run-id', `run-${Date.now()}`)!;
    const label = arg('label', 'roof')!;
    const apiKey = envKey('GOOGLE_MAPS_API_KEY');
    if (!apiKey) throw new Error('GOOGLE_MAPS_API_KEY is not set');
    fs.mkdirSync(out, { recursive: true });
    const t0 = Date.now();
    const log = (m: string) => console.log(`${((Date.now() - t0) / 1000).toFixed(1).padStart(7)} s  ${m}`);
    const costs: Record<string, number> = {};

    // a fresh extraction: an empty leaf cache for this run
    const cacheDir = path.join(out, 'tiles_cache');
    fs.rmSync(cacheDir, { recursive: true, force: true });
    const crawler = new GoogleTileDistrictCrawler({ apiKey, cacheDir, concurrency: 8 });
    const anchor = { lat, lng, heightGuessM: 0 };
    const { leaves, session, requests } = await crawler.collectLeafTiles(anchor, radius);
    const buffers = await crawler.downloadLeaves(leaves, session);
    costs.tileRootSessions = 1;
    log(`tiles: ${requests} tileset requests, ${leaves.length} leaves, ${(buffers.reduce((s, b) => s + b.length, 0) / 1e6).toFixed(1)} MB`);
    const district = GoogleTileDistrictCrawler.buildDistrictGlb(buffers.flatMap(b => GoogleTileDistrictCrawler.parseLeafGlbPrimitives(b)), anchor, { name: runId });
    const glbPath = path.join(out, 'extraction.glb');
    fs.writeFileSync(glbPath, district.glb);
    const tris = readTileTriangles(new Uint8Array(district.glb));
    const frame = { lat, lng, ellipsoidalHeightM: district.originEllipsoidalHeightM, axes: 'x east, y up, z south (metres)' };
    log(`extraction: ${district.triangleCount} triangles, origin ${district.originEllipsoidalHeightM.toFixed(2)} m ellipsoidal`);

    // the building: the vector footprint under the point
    const ev = await fetchVectorEvidence({ lat, lng, radiusM: Math.min(radius, 120), fetchTile: (x, y, z) => GoogleVectorTileService.fetchVectorTile(x, y, z, '') });
    costs.vectorTiles = ev.tiles;
    const building = ev.buildings.find(b => b.parts.some(loops => insideFootprint([loops as Array<Array<[number, number]>>], 0, 0)));
    if (!building) throw new Error(`no vector building footprint contains (${lat}, ${lng})`);
    const footprint = building.parts as unknown as Footprint;
    const buildingId = `building/${building.id}`;
    log(`building ${buildingId}: ${footprint.length} footprint parts`);

    // the plan: the place store first, else a local file
    const planFile = arg('plan-file') ? path.resolve(arg('plan-file')!) : undefined;
    const store = flag('no-store') ? undefined : await openPlaceStore({ key: placeKey({ lat, lng }), tmpDir: path.join(out, 'place_tmp') });
    if (store) log(`place store: ${store.where.kind} ${store.where.label}${store.where.reason ? ` (${store.where.reason})` : ''}`);
    let plan: MicroEditPlan | undefined, generation: string | undefined;
    if (store?.bucket) {
        const r = await loadMicroEditPlan<MicroEditPlan>(store, buildingId);
        if (r) { plan = r.plan; generation = r.generation; }
    }
    if (!plan && planFile && fs.existsSync(planFile)) plan = JSON.parse(fs.readFileSync(planFile, 'utf8')) as MicroEditPlan;
    plan ??= emptyPlan(buildingId, label);
    log(`plan: ${keptEdits(plan).length} kept edits, ${plan.runs.length} runs before`);

    // the held-out photo: a Static Maps satellite crop per unit (zoom 21), registered on the tile photo once
    const held = new Map<string, Promise<PlanImage | undefined>>();
    const satelliteFor = (cx: number, cz: number): Promise<PlanImage | undefined> => {
        const key = `${Math.round(cx / 15)},${Math.round(cz / 15)}`;
        let p = held.get(key);
        if (!p) {
            p = (async () => {
                const g = toAnchor(frame, Math.round(cx / 15) * 15, 0, Math.round(cz / 15) * 15);
                const ref = await fetchOrthoReference({ lat: g.lat, lng: g.lng, zoom: 21, sizePx: 640, scale: 2, apiKey });
                costs.staticMaps = (costs.staticMaps ?? 0) + 1;
                const [x, , z] = fromAnchor(frame, { lat: g.lat, lng: g.lng, hM: frame.ellipsoidalHeightM });
                const image: PlanImage = { image: ref.image, x0: x - ref.widthM / 2, z0: z - ref.heightM / 2, pixelM: ref.pixelM };
                // registered on a coarse, wide tile crop around it
                const coarse = tileCropAround(tris, x, z, 12, 0.08, topY(tris, x, z));
                const reg = registerPlanImage(image, coarse, 3);
                log(`held-out satellite at (${x.toFixed(1)}, ${z.toFixed(1)}): ${ref.pixelM.toFixed(3)} m/px, registered shift (${reg.shiftM.join(', ')}) m, NCC ${reg.ncc}`);
                return { ...image, x0: image.x0 - reg.shiftM[0], z0: image.z0 - reg.shiftM[1] };
            })().catch(err => { log(`held-out satellite failed: ${(err as Error).message}`); return undefined; });
            held.set(key, p);
        }
        return p;
    };
    const heldOut = async (grid: TopDownCrop): Promise<TopDownCrop | undefined> => {
        const cx = grid.x0 + (grid.width * grid.texelM) / 2, cz = grid.z0 + (grid.height * grid.texelM) / 2;
        const img = await satelliteFor(cx, cz);
        return img ? resamplePlanImage(img, grid) : undefined;
    };

    const soup = tris.positions;
    const result = await runMicroEditPass({
        plan, runId, frame, scan: soup, footprint, workDir: path.join(out, 'work'),
        tileCrop: (cx, cz, half, texelM, refY) => tileCropAround(tris, cx, cz, half, texelM, refY),
        heldOut,
        params: { ...(arg('edits') ? { maxEditsPerRun: Number(arg('edits')) } : {}) }
    });
    const { report } = result;
    log(`pass: ${report.candidates.found} round units found (${report.candidates.components} raised components; ${JSON.stringify(report.candidates.rejected)})`);
    log(`replayed ${report.run.replayed} edits, sha ${report.run.replaySha}${report.run.previousSha ? ` (previous ${report.run.previousSha}, drift ${report.run.drift})` : ''}`);
    for (const p of report.proposals) log(`  ${p.verdict.padEnd(8)} ${p.primitive ?? p.kind} rung ${p.rung} ${p.key}: ${p.reason}`);
    for (const r of report.run.retired) log(`  retired  ${r.key}: ${r.reason}`);

    // write the plan back (place store, over the generation it was read at) and locally
    fs.writeFileSync(path.join(out, 'plan.json'), JSON.stringify(result.plan, null, 1));
    if (planFile) fs.writeFileSync(planFile, JSON.stringify(result.plan, null, 1));
    if (store?.bucket) {
        const w = await saveMicroEditPlan(store, buildingId, result.plan, generation);
        log(w === 'conflict' ? 'place store: another run wrote the plan first; this run\'s edits are in plan.json only' : 'place store: plan saved');
    }
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify({ ...report, buildingId, frame, costs, extraction: { leaves: leaves.length, triangles: district.triangleCount } }, null, 1));

    // the layer
    const colourOf = (part: { positions: Float32Array; normals: Float32Array; indices: Uint32Array; id: string }) => {
        let x = 0, z = 0, n = 0, yMax = -Infinity;
        for (let i = 0; i < part.positions.length; i += 3) { x += part.positions[i]; z += part.positions[i + 2]; yMax = Math.max(yMax, part.positions[i + 1]); n++; }
        const c = tileCropAround(tris, x / n, z / n, 2.5, 0.03, yMax);
        const d = drawModelTopDown([{ ...part }], c);
        const k = Math.floor(c.height / 2) * c.width + Math.floor(c.width / 2);
        return [d.image.rgba[k * 4], d.image.rgba[k * 4 + 1], d.image.rgba[k * 4 + 2]] as [number, number, number];
    };
    if (result.units.length) writeMicroEditGlb(path.join(out, 'micro_edits.glb'), result.plan, result.units, colourOf);

    // the sheet
    const sheet = await renderSheet(result.plan, result.units, report, tris, heldOut, `${label.toUpperCase()} - RUN ${result.plan.runs.length} (${runId})`);
    fs.writeFileSync(path.join(out, 'sheet.png'), sheet);
    log(`sheet: ${path.join(out, 'sheet.png')}`);
    log(`costs: ${JSON.stringify(costs)}`);
}

function topY(t: TileTriangles, x: number, z: number, reach = 12): number {
    let y = -Infinity;
    for (let i = 0; i < t.positions.length; i += 3) if (Math.abs(t.positions[i] - x) <= reach && Math.abs(t.positions[i + 2] - z) <= reach) y = Math.max(y, t.positions[i + 1]);
    return y;
}

/** A model's parts as a flat-coloured triangle soup the renderer draws. */
function modelTriangles(units: BuiltUnit[], colour: [number, number, number]): TileTriangles {
    const pos: number[] = [], nrm: number[] = [];
    for (const u of units) for (const p of u.parts) for (let i = 0; i + 2 < p.indices.length; i += 3) {
        const v = [p.indices[i], p.indices[i + 1], p.indices[i + 2]];
        for (const k of v) pos.push(p.positions[k * 3], p.positions[k * 3 + 1], p.positions[k * 3 + 2]);
        const a = v.map(k => [p.positions[k * 3], p.positions[k * 3 + 1], p.positions[k * 3 + 2]]);
        const ux = a[1][0] - a[0][0], uy = a[1][1] - a[0][1], uz = a[1][2] - a[0][2], wx = a[2][0] - a[0][0], wy = a[2][1] - a[0][1], wz = a[2][2] - a[0][2];
        const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx, l = Math.hypot(nx, ny, nz) || 1;
        nrm.push(nx / l, ny / l, nz / l);
    }
    const n = nrm.length / 3;
    const lin = colour.map(c => (c / 255) ** 2.2);
    const flat = new Float32Array(n * 3);
    for (let t = 0; t < n; t++) flat.set(lin, t * 3);
    return { positions: new Float32Array(pos), uvs: new Float32Array(n * 6), normals: new Float32Array(nrm), texture: new Int32Array(n).fill(-1), flatLinear: flat, textures: [] };
}

function selectSoup(t: TileTriangles, keep: (x: number, y: number, z: number) => boolean): TileTriangles {
    const idx: number[] = [];
    for (let i = 0; i < t.texture.length; i++) {
        const x = (t.positions[i * 9] + t.positions[i * 9 + 3] + t.positions[i * 9 + 6]) / 3, y = (t.positions[i * 9 + 1] + t.positions[i * 9 + 4] + t.positions[i * 9 + 7]) / 3, z = (t.positions[i * 9 + 2] + t.positions[i * 9 + 5] + t.positions[i * 9 + 8]) / 3;
        if (keep(x, y, z)) idx.push(i);
    }
    const pick = (a: Float32Array | Int32Array | Uint8Array, w: number) => { const o = new (a.constructor as any)(idx.length * w); idx.forEach((i, k) => o.set(a.subarray(i * w, i * w + w), k * w)); return o; };
    return { positions: pick(t.positions, 9), uvs: pick(t.uvs, 6), normals: pick(t.normals, 3), texture: pick(t.texture, 1), flatLinear: pick(t.flatLinear, 3), textures: t.textures };
}

function obliqueCamera(target: [number, number, number], distM: number, azDeg: number, elDeg: number, W: number, H: number, fovDeg = 40): PinholeCamera {
    const az = (azDeg * Math.PI) / 180, el = (elDeg * Math.PI) / 180;
    const eye: [number, number, number] = [target[0] + distM * Math.cos(el) * Math.sin(az), target[1] + distM * Math.sin(el), target[2] + distM * Math.cos(el) * Math.cos(az)];
    const f = [target[0] - eye[0], target[1] - eye[1], target[2] - eye[2]];
    const fl = Math.hypot(f[0], f[1], f[2]);
    const fwd: [number, number, number] = [f[0] / fl, f[1] / fl, f[2] / fl];
    const r = [fwd[1] * 0 - fwd[2] * 1, fwd[2] * 0 - fwd[0] * 0, fwd[0] * 1 - fwd[1] * 0];
    const rl = Math.hypot(r[0], r[1], r[2]);
    const right: [number, number, number] = [r[0] / rl, r[1] / rl, r[2] / rl];
    const up: [number, number, number] = [right[1] * fwd[2] - right[2] * fwd[1], right[2] * fwd[0] - right[0] * fwd[2], right[0] * fwd[1] - right[1] * fwd[0]];
    const fpx = W / 2 / Math.tan((fovDeg * Math.PI) / 360);
    return { eye, right, up, fwd, fx: fpx, fy: fpx, cx: W / 2, cy: H / 2, width: W, height: H };
}

type Img = { width: number; height: number; rgba: Uint8Array };

function resize(img: Img, w: number, h: number): Img {
    const out = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const sx = Math.min(img.width - 1, Math.floor((x / w) * img.width)), sy = Math.min(img.height - 1, Math.floor((y / h) * img.height));
        out.set(img.rgba.subarray((sy * img.width + sx) * 4, (sy * img.width + sx) * 4 + 4), (y * w + x) * 4);
        out[(y * w + x) * 4 + 3] = 255;
    }
    return { width: w, height: h, rgba: out };
}

async function renderSheet(plan: MicroEditPlan, units: BuiltUnit[], report: Awaited<ReturnType<typeof runMicroEditPass>>['report'], tris: TileTriangles, heldOut: (g: TopDownCrop) => Promise<TopDownCrop | undefined>, title: string): Promise<Buffer> {
    const tile = 300, gap = 8, labelH = 34;
    const cols = ['TILE PHOTO (READ)', 'HELD-OUT SATELLITE', 'MODEL FROM ABOVE', 'SCAN AS EXTRACTED', 'WITH MICRO-EDITS'];
    const shown = units.slice(0, 3);
    const textLines: Array<{ text: string; colour: [number, number, number] }> = [];
    const r = report.run;
    textLines.push({ text: `REPLAYED ${r.replayed} EDITS SHA ${r.replaySha}${r.previousSha ? ` PREV ${r.previousSha} DRIFT ${r.drift ? 'YES' : 'NO'}` : ' (FIRST RUN)'}`, colour: r.drift ? [255, 120, 120] : [170, 255, 170] });
    textLines.push({ text: `THIS RUN: KEPT ${r.kept.length}  REJECTED ${r.rejected.length}  SKIPPED ${r.skipped.length}  RETIRED ${r.retired.length}  ROUND UNITS FOUND ${report.candidates.found}`, colour: [255, 255, 255] });
    for (const p of report.proposals) {
        const m = p.metrics;
        const metric = m?.before && m?.after ? `  SCAN RMS ${m.before.scanRmsM.toFixed(3)}>${m.after.scanRmsM.toFixed(3)} M (${(m.scanRule ?? '').toUpperCase()})  SSIM ${fmtN(m.before.photoSsim)}>${fmtN(m.after.photoSsim)}  GRAD ${fmtN(m.before.photoGradientNcc)}>${fmtN(m.after.photoGradientNcc)}  MOVED ${m.changedAreaM2?.toFixed(2)} M2 P95 ${m.displacementP95M?.toFixed(3)} M` : '';
        textLines.push({ text: `${p.verdict.toUpperCase()} ${(p.primitive ?? p.kind).toUpperCase()} RUNG ${p.rung} ${p.key}${metric}`, colour: p.verdict === 'kept' ? [170, 255, 170] : p.verdict === 'rejected' ? [255, 170, 120] : [180, 180, 180] });
        if (p.verdict !== 'kept') textLines.push({ text: `    ${p.reason.slice(0, 190)}`, colour: [200, 200, 200] });
    }
    for (const x of r.retired) textLines.push({ text: `RETIRED ${x.key}: ${x.reason.slice(0, 170)}`, colour: [255, 140, 140] });
    textLines.push({ text: 'THE PLAN (KEPT, IN ORDER):', colour: [255, 236, 160] });
    keptEdits(plan).forEach((e, i) => {
        const p = e.kind === 'nudge' ? { [e.nudge!.param]: e.nudge!.to } : e.params;
        const ps = Object.entries(p).map(([k, v]) => `${k.replace(/M$|Rad$/, '').toUpperCase()} ${Number.isInteger(v) ? v : v.toFixed(3)}`).join(' ');
        textLines.push({ text: `${i + 1}. ${(e.primitive ?? 'NUDGE').toUpperCase()} ${e.key} RUN ${e.proposedBy.runId} ${e.provenance.toUpperCase()} CONF ${e.confidence.toFixed(2)}: ${ps}`, colour: [220, 230, 255] });
    });
    const W = cols.length * tile + (cols.length + 1) * gap;
    const titleH = 40, rowH = tile + labelH + gap, textH = textLines.length * 18 + 16;
    const H = titleH + Math.max(1, shown.length) * rowH + textH + gap;
    const rgb = new Uint8Array(W * H * 3).fill(24);
    drawText(rgb, W, H, gap, 12, title, 3, [255, 255, 255]);
    const put = (img: Img, x0: number, y0: number) => {
        const s = resize(img, tile, tile);
        for (let y = 0; y < tile; y++) for (let x = 0; x < tile; x++) { const o = ((y0 + y) * W + x0 + x) * 3, k = (y * tile + x) * 4; rgb[o] = s.rgba[k]; rgb[o + 1] = s.rgba[k + 1]; rgb[o + 2] = s.rgba[k + 2]; }
    };
    for (let ui = 0; ui < shown.length; ui++) {
        const u = shown[ui];
        const root = plan.edits.find(e => e.key === u.root)!;
        const rp = effectiveParams(plan, root);
        const [cx, by, cz] = u.origin;
        const half = rp.radiusM + 1.2;
        const crop = tileCropAround(tris, cx, cz, half, 0.02, by + rp.heightM);
        const sat = await heldOut(crop);
        const model = drawModelTopDown([supportDisc(cx, by, cz, rp.radiusM + 0.6), ...u.parts], crop).image;
        const near = selectSoup(tris, (x, _y, z) => Math.hypot(x - cx, z - cz) < half + 6);
        const cam = obliqueCamera([cx, by + rp.heightM * 0.5, cz], Math.max(4, rp.radiusM * 4.5), 200, 38, 600, 600);
        const before = renderTriangles([near], cam, { supersample: 2 });
        const cut = selectSoup(near, (x, y, z) => !microEditContains([u], plan, x, y, z));
        const after = renderTriangles([cut, modelTriangles([u], [170, 170, 165])], cam, { supersample: 2 });
        const y0 = titleH + ui * rowH;
        const imgs: Img[] = [crop, sat ?? { width: 1, height: 1, rgba: new Uint8Array([60, 60, 60, 255]) }, model, before, after];
        imgs.forEach((img, c) => {
            const x0 = gap + c * (tile + gap);
            drawText(rgb, W, H, x0, y0 + 4, cols[c], 2, [255, 236, 160]);
            if (c === 0) drawText(rgb, W, H, x0, y0 + 20, `UNIT ${ui + 1} R ${rp.radiusM.toFixed(2)} H ${rp.heightM.toFixed(2)}`, 2, [200, 220, 255]);
            put(img, x0, y0 + labelH);
        });
    }
    let ty = titleH + Math.max(1, shown.length) * rowH + 8;
    for (const l of textLines) { drawText(rgb, W, H, gap, ty, l.text, 2, l.colour); ty += 18; }
    return encodePng(W, H, rgb, 3);
}

function fmtN(v: number | null | undefined): string { return v === null || v === undefined ? '-' : v.toFixed(3); }

main().catch(err => { console.error(err instanceof Error ? err.stack : err); process.exit(1); });
