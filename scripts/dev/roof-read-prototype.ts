/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Roof reading prototype (dev tool): pipeline G's facade method applied to a roof. The roof's plate is the photo straight
 * down (the tile's top-down render) in the building's own frame, beside its measured height above the roof (the scan's
 * top surface); a vision model reads it as a roof program (boxes, round tanks, rows of posts, ducts, insets, the
 * parapet); every item's height is then measured on the scan (estimated, and said so, where the scan does not see it
 * stand). The reading and the current photo-colour roof objects are scored against the same height map and built as
 * clay from the same cameras.
 *
 *   SCRATCHBOX_ROOT=$PWD npx tsx scripts/dev/roof-read-prototype.ts <out-dir> [run-id]
 *
 * Writes <out>/roof_photo.png, roof_height.png (the plate), reading.json, overlay.png, scores.json and
 * clay_<view>_<candidate>.png.
 */

import * as fs from 'fs';
import * as path from 'path';
import { GeminiClient } from '../../packages/core/src/node/gemini/gemini-client';
import { HeadlessMeshSilhouetteRenderer as R, type RenderMesh3D } from '../../packages/core/src/node/spatial/HeadlessMeshSilhouetteRenderer';
import { encodePng } from '../../packages/core/src/node/3d-engine/staged-location/png-encode';
import { decodePng } from '../../packages/core/src/node/texture-processing';
import { roofPhotoFor, runScanMassing, type StructureScanNote } from '../../packages/core/src/node/3d-engine/staged-location/scan-massing';

type P2 = [number, number];
const OUT = process.argv[2];
const RUNS = '.scratchbox/cache/staged_location/runs';
const runId = process.argv[3] ?? fs.readdirSync(RUNS).filter(r => fs.existsSync(path.join(RUNS, r, 'structure_scan.json'))).sort((a, b) => fs.statSync(path.join(RUNS, b)).mtimeMs - fs.statSync(path.join(RUNS, a)).mtimeMs)[0];
const MODEL = process.env.ROOF_READ_MODEL ?? 'gemini-4-argon';
const PX = 0.06;           // the plate's metres per pixel
const ABOVE_M = 0.4;       // a cell stands on the roof when the scan is this far above it
const MARGIN_M = 1.0;

interface RoofProgram {
    roofColour?: string;
    boxes?: Array<{ u0: number; v0: number; u1: number; v1: number; height?: number; colour?: string; label?: string; seen?: boolean }>;
    tanks?: Array<{ u: number; v: number; radius: number; height?: number; standHeight?: number; cap?: 'flat' | 'cone'; colour?: string; label?: string }>;
    rows?: Array<{ u0: number; v0: number; u1: number; v1: number; pitch: number; size?: number; height?: number; colour?: string; label?: string }>;
    ducts?: Array<{ points: number[][]; width: number; height?: number; colour?: string; label?: string }>;
    insets?: Array<{ u0: number; v0: number; u1: number; v1: number; colour?: string; label?: string }>;
    parapet?: { height?: number; width?: number; colour?: string };
    notes?: string;
}

function inRing(r: P2[], x: number, z: number): boolean {
    let c = false;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) if ((r[i][1] > z) !== (r[j][1] > z) && x < ((r[j][0] - r[i][0]) * (z - r[i][1])) / (r[j][1] - r[i][1]) + r[i][0]) c = !c;
    return c;
}

(async () => {
    fs.mkdirSync(OUT, { recursive: true });
    const note = JSON.parse(fs.readFileSync(path.join(RUNS, runId, 'structure_scan.json'), 'utf8')) as StructureScanNote;
    console.log(`run ${runId}: ${note.place}`);
    const sm = await runScanMassing(note);
    const block = sm.block, roofY = sm.roofY;
    // the roof frame: u along the footprint's longest edge, v across it
    let axis = 0, longest = -1;
    for (let i = 0; i < block.length; i++) { const a = block[i], b = block[(i + 1) % block.length]; const L = Math.hypot(b[0] - a[0], b[1] - a[1]); if (L > longest) { longest = L; axis = Math.atan2(b[1] - a[1], b[0] - a[0]); } }
    const U: P2 = [Math.cos(axis), Math.sin(axis)], V: P2 = [-Math.sin(axis), Math.cos(axis)];
    const toUV = ([x, z]: P2): P2 => [x * U[0] + z * U[1], x * V[0] + z * V[1]];
    const uvs = block.map(toUV);
    const u0 = Math.min(...uvs.map(p => p[0])) - MARGIN_M, v0 = Math.min(...uvs.map(p => p[1])) - MARGIN_M;
    const W = Math.ceil((Math.max(...uvs.map(p => p[0])) + MARGIN_M - u0) / PX), H = Math.ceil((Math.max(...uvs.map(p => p[1])) + MARGIN_M - v0) / PX);
    // plate (u, v) in metres from its corner -> world (x, z)
    const toXZ = (u: number, v: number): P2 => { const a = u + u0, b = v + v0; return [a * U[0] + b * V[0], a * U[1] + b * V[1]]; };
    console.log(`plate ${W} x ${H} px (${(W * PX).toFixed(1)} x ${(H * PX).toFixed(1)} m), roof at ${roofY.toFixed(2)} m`);

    // 1. the photo straight down, resampled into the roof frame
    const rp = roofPhotoFor(note);
    if (!rp) throw new Error('no roof photo');
    const photo = decodePng(fs.readFileSync(rp.path));
    const rgb = new Uint8Array(W * H * 3);
    const inside = new Uint8Array(W * H);
    for (let k = 0; k < H; k++) for (let i = 0; i < W; i++) {
        const [x, z] = toXZ((i + 0.5) * PX, (H - 1 - k + 0.5) * PX);  // row 0 at the plate's far edge (v max), like a map
        const j = k * W + i;
        inside[j] = inRing(block, x, z) ? 1 : 0;
        const pi = Math.floor((x - rp.frame.x0) / rp.frame.texel), pk = Math.floor((z - rp.frame.z0) / rp.frame.texel);
        if (pi < 0 || pk < 0 || pi >= photo.width || pk >= photo.height) { rgb.set([128, 128, 128], j * 3); continue; }
        const q = (pk * photo.width + pi) * 4;
        rgb.set([photo.rgba[q], photo.rgba[q + 1], photo.rgba[q + 2]], j * 3);
    }
    // 2. the scan's top surface above the roof, on the same grid (max height of the scan's triangles per cell)
    const scan = R.loadMeshFromGlb(note.scanGlb);
    const top = new Float32Array(W * H).fill(-Infinity);
    const vs = scan.vertices as ArrayLike<number>, ix = scan.indices as ArrayLike<number>;
    const cellOf = (x: number, z: number): P2 => { const [a, b] = toUV([x, z]); return [(a - u0) / PX, H - 1 - (b - v0) / PX]; };
    for (let t = 0; t < ix.length; t += 3) {
        const P = [0, 1, 2].map(n => { const o = ix[t + n] * 3; return [vs[o], vs[o + 1], vs[o + 2]]; });
        const C = P.map(p => cellOf(p[0], p[2]));
        const ia = Math.max(0, Math.floor(Math.min(...C.map(c => c[0])))), ib = Math.min(W - 1, Math.ceil(Math.max(...C.map(c => c[0]))));
        const ka = Math.max(0, Math.floor(Math.min(...C.map(c => c[1])))), kb = Math.min(H - 1, Math.ceil(Math.max(...C.map(c => c[1]))));
        const d = (C[1][1] - C[2][1]) * (C[0][0] - C[2][0]) + (C[2][0] - C[1][0]) * (C[0][1] - C[2][1]);
        for (let k = ka; k <= kb; k++) for (let i = ia; i <= ib; i++) {
            let y: number;
            if (Math.abs(d) < 1e-9) y = Math.max(P[0][1], P[1][1], P[2][1]);
            else {
                const px = i + 0.5, pz = k + 0.5;
                const w0 = ((C[1][1] - C[2][1]) * (px - C[2][0]) + (C[2][0] - C[1][0]) * (pz - C[2][1])) / d, w1 = ((C[2][1] - C[0][1]) * (px - C[2][0]) + (C[0][0] - C[2][0]) * (pz - C[2][1])) / d, w2 = 1 - w0 - w1;
                if (w0 < -0.02 || w1 < -0.02 || w2 < -0.02) continue;
                y = w0 * P[0][1] + w1 * P[1][1] + w2 * P[2][1];
            }
            const j = k * W + i;
            if (y > top[j]) top[j] = y;
        }
    }
    const above = new Float32Array(W * H);
    for (let j = 0; j < W * H; j++) above[j] = Number.isFinite(top[j]) ? top[j] - roofY : NaN;

    // the plate as two images with metre ticks, the footprint outlined
    const ticks = (img: Uint8Array) => {
        const step = Math.round(1 / PX);
        const put = (x: number, y: number) => { if (x >= 0 && y >= 0 && x < W && y < H) img.set([255, 0, 255], (y * W + x) * 3); };
        for (let m = 0; m * step < W; m++) for (let k = 0; k < (m % 5 === 0 ? 24 : 10); k++) { put(m * step, k); put(m * step, H - 1 - k); }
        for (let m = 0; m * step < H; m++) for (let k = 0; k < (m % 5 === 0 ? 24 : 10); k++) { put(k, H - 1 - m * step); put(W - 1 - k, H - 1 - m * step); }
        for (let k = 1; k < H - 1; k++) for (let i = 1; i < W - 1; i++) { const j = k * W + i; if (inside[j] && (!inside[j - 1] || !inside[j + 1] || !inside[j - W] || !inside[j + W])) img.set([0, 255, 255], j * 3); }
        return img;
    };
    const photoPng = encodePng(W, H, Buffer.from(ticks(Uint8Array.from(rgb))), 3);
    const hrgb = new Uint8Array(W * H * 3);
    for (let j = 0; j < W * H; j++) {
        const a = above[j];
        if (!inside[j] || Number.isNaN(a)) { hrgb.set([40, 40, 40], j * 3); continue; }
        const s = Math.max(0, Math.min(1, a / 4));  // 0 m black .. 4 m and up white, the roof itself dark blue
        hrgb.set(a < ABOVE_M ? [20, 30, 90] : [Math.round(80 + 175 * s), Math.round(60 + 195 * s), Math.round(40 + 160 * s)], j * 3);
    }
    const heightPng = encodePng(W, H, Buffer.from(ticks(hrgb)), 3);
    fs.writeFileSync(path.join(OUT, 'roof_photo.png'), photoPng);
    fs.writeFileSync(path.join(OUT, 'roof_height.png'), heightPng);

    // 3. the reading
    const Wm = +(W * PX).toFixed(2), Hm = +(H * PX).toFixed(2);
    const prompt = `You are reading the roof of ${note.place} so it can be rebuilt procedurally in exact metres.
Image 1 is the roof photographed straight down (an orthophoto from Google's photorealistic 3D tiles), rotated so the building's longest wall runs left-right: ${W} x ${H} px at ${PX} m per pixel, so the image is ${Wm} m wide (u, 0 at the left edge) and ${Hm} m tall (v, 0 at the BOTTOM edge, increasing upward). Magenta ticks every metre along all four edges (long ticks every 5 m). The cyan line is the building's footprint: everything you list lies inside it.
Image 2 is the measured height above the main roof in the same frame, from the 3D scan: dark blue is the roof itself, brown to white stands 0.4 m to 4 m and more above it, dark grey is outside the footprint or unmeasured. The scan is blurred by 1-2 m and misses thin things (posts, rails); the photo shows edges sharply. Use the photo for outlines and positions, the height image to tell what stands up from what is painted or flush.

Answer with JSON only:
{"roofColour": "#rrggbb",
 "boxes": [{"u0","v0","u1","v1","height","colour","label","seen"}],
 "tanks": [{"u","v","radius","height","standHeight","cap","colour","label"}],
 "rows": [{"u0","v0","u1","v1","pitch","size","height","colour","label"}],
 "ducts": [{"points": [[u, v], ...], "width", "height", "colour", "label"}],
 "insets": [{"u0","v0","u1","v1","colour","label"}],
 "parapet": {"height", "width", "colour"},
 "notes": "..."}
- boxes: every solid thing standing on the roof with a rectangular plan (bulkheads, stair and elevator housings, plant, HVAC units, chimneys, skylight frames that stand up), as an axis-aligned rectangle in metres (u0 < u1, v0 < v1); a building element of several stepped parts is several boxes. height is your estimate above the roof (metres); seen false if it is mostly hidden.
- tanks: round things (water tanks, round vents) by centre and radius; height of the round body, standHeight the height of the structure it stands on (0 when it sits on the roof), cap "cone" or "flat".
- rows: regularly repeated small things along a line (railing posts, fence posts, small vents in a line) from (u0, v0) to (u1, v1), pitch the spacing between them, size their width.
- ducts: long thin raised runs (ducts, pipes, cable trays) as a centreline with a width.
- insets: flat things flush with the roof (hatches, flat skylights, drains, painted areas) as rectangles.
- parapet: the low wall along the roof's edge, if any.
Be exhaustive and exact; give positions to 0.1 m. Do not list anything outside the cyan footprint, and do not invent what neither image shows.`;
    // ROOF_REREAD=1 asks the model again; otherwise a reading already in <out> is reused (the build steps change, not the read)
    const readingFile = path.join(OUT, 'reading.json');
    const t0 = Date.now();
    let prog: RoofProgram;
    if (fs.existsSync(readingFile) && !process.env.ROOF_REREAD) prog = JSON.parse(fs.readFileSync(readingFile, 'utf8'));
    else {
        const client = await new GeminiClient().getGenAIClient();
        if (!client) throw new Error('no Vertex client (service account)');
        const res = await client.models.generateContent({
            model: MODEL,
            contents: [{ role: 'user', parts: [{ text: prompt }, { inlineData: { mimeType: 'image/png', data: photoPng.toString('base64') } }, { inlineData: { mimeType: 'image/png', data: heightPng.toString('base64') } }] }],
            config: { responseMimeType: 'application/json', maxOutputTokens: 16000 }
        });
        const text = (res.text ?? '').replace(/^\s*```(?:json)?\s*/i, '').replace(/```\s*$/, '');
        prog = JSON.parse(text) as RoofProgram;
        fs.writeFileSync(readingFile, JSON.stringify(prog, null, 1));
    }
    console.log(`read by ${MODEL} in ${((Date.now() - t0) / 1000).toFixed(0)} s: ${prog.boxes?.length ?? 0} boxes, ${prog.tanks?.length ?? 0} tanks, ${prog.rows?.length ?? 0} rows, ${prog.ducts?.length ?? 0} ducts, ${prog.insets?.length ?? 0} insets${prog.parapet ? ', a parapet' : ''}`);

    // 4. every item's height measured on the scan (p90 of the height map in its plan), estimated where the scan is flat there
    const cellIdx = (u: number, v: number) => { const i = Math.floor(u / PX), k = H - 1 - Math.floor(v / PX); return i >= 0 && k >= 0 && i < W && k < H ? k * W + i : -1; };
    const measure = (cells: number[]) => { const hs = cells.map(j => above[j]).filter(h => Number.isFinite(h)).sort((a, b) => a - b); return hs.length ? hs[Math.floor(0.9 * (hs.length - 1))] : NaN; };
    const rectCells = (a: number, b: number, c: number, d: number) => { const out: number[] = []; for (let v = Math.min(b, d); v < Math.max(b, d); v += PX) for (let u = Math.min(a, c); u < Math.max(a, c); u += PX) { const j = cellIdx(u, v); if (j >= 0) out.push(j); } return out; };
    // a taller neighbour's blur is not an item's height (the scan smears 1-2 m): cells within BLUR_M of a tank are the tank's
    const BLUR_M = 0.5;
    const claimed = new Uint8Array(W * H);
    for (const t of prog.tanks ?? []) for (const j of rectCells(t.u - t.radius - BLUR_M, t.v - t.radius - BLUR_M, t.u + t.radius + BLUR_M, t.v + t.radius + BLUR_M)) {
        const i = j % W, k = Math.floor(j / W); if (Math.hypot((i + 0.5) * PX - t.u, (H - 1 - k + 0.5) * PX - t.v) <= t.radius + BLUR_M) claimed[j] = 1;
    }
    const heightOf = (cells: number[], est: number | undefined, fallback: number, own = false) => { const m = measure(own ? cells : cells.filter(j => !claimed[j])); return m >= ABOVE_M ? { h: m, source: 'scan' } : { h: est && est > 0 ? est : fallback, source: 'estimated' }; };

    // the shapes, in plate metres, for the score and the build
    interface Solid { kind: string; label: string; ring: P2[]; base: number; topY: number; source: string; cone?: number }
    const solids: Solid[] = [];
    const rect = (a: number, b: number, c: number, d: number): P2[] => [[a, b], [c, b], [c, d], [a, d]];
    for (const b of prog.boxes ?? []) { const hh = heightOf(rectCells(b.u0, b.v0, b.u1, b.v1), b.height, 1.0); solids.push({ kind: 'box', label: b.label ?? 'box', ring: rect(b.u0, b.v0, b.u1, b.v1), base: 0, topY: hh.h, source: hh.source }); }
    for (const t of prog.tanks ?? []) {
        const ring: P2[] = Array.from({ length: 24 }, (_, n) => [t.u + t.radius * Math.cos((n * Math.PI) / 12), t.v + t.radius * Math.sin((n * Math.PI) / 12)] as P2);
        const cells = rectCells(t.u - t.radius, t.v - t.radius, t.u + t.radius, t.v + t.radius);
        const hh = heightOf(cells, (t.height ?? 0) + (t.standHeight ?? 0), 3, true);
        const cone = t.cap === 'cone' ? Math.min(1.5, t.radius * 0.6) : 0;
        // the stand: the model's share of the whole height (the scan sees the top, not where the body starts)
        const read = (t.height ?? 0) + (t.standHeight ?? 0);
        const stand = read > 0 ? (hh.h * (t.standHeight ?? 0)) / read : 0;
        solids.push({ kind: 'tank', label: t.label ?? 'tank', ring, base: stand, topY: hh.h - cone, source: hh.source, cone });
        if (stand > 0.3) {
            for (const [du, dv] of [[-0.6, -0.6], [0.6, -0.6], [0.6, 0.6], [-0.6, 0.6]]) { const cu = t.u + du * t.radius, cv = t.v + dv * t.radius; solids.push({ kind: 'tank leg', label: 'leg', ring: rect(cu - 0.12, cv - 0.12, cu + 0.12, cv + 0.12), base: 0, topY: stand, source: 'estimated' }); }
            // the deck the tank sits on
            solids.push({ kind: 'tank leg', label: 'deck', ring: rect(t.u - t.radius * 0.95, t.v - t.radius * 0.95, t.u + t.radius * 0.95, t.v + t.radius * 0.95), base: stand - 0.2, topY: stand, source: 'estimated' });
        }
    }
    for (const r of prog.rows ?? []) {
        const L = Math.hypot(r.u1 - r.u0, r.v1 - r.v0), n = Math.max(1, Math.round(L / Math.max(0.2, r.pitch))), s = (r.size ?? 0.1) / 2;
        for (let k = 0; k <= n; k++) { const u = r.u0 + ((r.u1 - r.u0) * k) / n, v = r.v0 + ((r.v1 - r.v0) * k) / n; solids.push({ kind: 'post', label: r.label ?? 'post', ring: rect(u - s, v - s, u + s, v + s), base: 0, topY: r.height ?? 1.07, source: 'estimated' }); }
    }
    for (const d of prog.ducts ?? []) for (let k = 0; k + 1 < (d.points?.length ?? 0); k++) {
        const [a, b] = [d.points[k], d.points[k + 1]]; const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1; const nx = -(b[1] - a[1]) / L * d.width / 2, nz = (b[0] - a[0]) / L * d.width / 2;
        const ring: P2[] = [[a[0] + nx, a[1] + nz], [b[0] + nx, b[1] + nz], [b[0] - nx, b[1] - nz], [a[0] - nx, a[1] - nz]];
        const cells = rectCells(Math.min(a[0], b[0]) - d.width / 2, Math.min(a[1], b[1]) - d.width / 2, Math.max(a[0], b[0]) + d.width / 2, Math.max(a[1], b[1]) + d.width / 2);
        const hh = heightOf(cells, d.height, 0.6);
        solids.push({ kind: 'duct', label: d.label ?? 'duct', ring, base: 0, topY: hh.h, source: hh.source });
    }

    // 5. scored against the scan's height map: recall of what stands on the roof, precision of what is built there
    const standing = new Uint8Array(W * H);
    for (let j = 0; j < W * H; j++) standing[j] = inside[j] && above[j] >= ABOVE_M ? 1 : 0;
    const score = (rings: P2[][]) => {
        const built = new Uint8Array(W * H);
        for (const ring of rings) {
            const us = ring.map(p => p[0]), vs2 = ring.map(p => p[1]);
            for (const j of rectCells(Math.min(...us), Math.min(...vs2), Math.max(...us), Math.max(...vs2))) {
                const i = j % W, k = Math.floor(j / W); if (inRing(ring, (i + 0.5) * PX, (H - 1 - k + 0.5) * PX)) built[j] = 1;
            }
        }
        let s = 0, b = 0, both = 0;
        // a 0.5 m allowance each way: the scan is blurred by about that
        const near = (m: Uint8Array, j: number) => { const i = j % W, k = Math.floor(j / W), r = Math.round(0.5 / PX); for (let dk = -r; dk <= r; dk += 2) for (let di = -r; di <= r; di += 2) { const ii = i + di, kk = k + dk; if (ii >= 0 && kk >= 0 && ii < W && kk < H && m[kk * W + ii]) return true; } return false; };
        let recallHit = 0, precHit = 0;
        for (let j = 0; j < W * H; j++) { if (standing[j]) { s++; if (near(built, j)) recallHit++; } if (built[j] && inside[j]) { b++; if (near(standing, j)) precHit++; } if (standing[j] && built[j]) both++; }
        return { standingM2: +(s * PX * PX).toFixed(1), builtM2: +(b * PX * PX).toFixed(1), recall: +(recallHit / Math.max(1, s)).toFixed(3), precision: +(precHit / Math.max(1, b)).toFixed(3) };
    };
    const current = (sm.roof?.objects ?? []).filter(o => o.outline.length >= 3).map(o => o.outline.map(p => { const [a, b] = toUV(p); return [a - u0, b - v0] as P2; }));
    const scores = { reading: score(solids.filter(s => s.kind !== 'post').map(s => s.ring)), current: score(current), currentObjects: current.length, readingParts: solids.length, model: MODEL, notes: prog.notes };
    fs.writeFileSync(path.join(OUT, 'scores.json'), JSON.stringify(scores, null, 1));
    console.log('scores', JSON.stringify(scores));

    // 6. the reading drawn on the photo (boxes red, tanks yellow, posts green, ducts blue, insets cyan)
    const ov = Uint8Array.from(rgb);
    const drawRing = (ring: P2[], c: [number, number, number]) => {
        for (let n = 0; n < ring.length; n++) {
            const a = ring[n], b = ring[(n + 1) % ring.length], L = Math.hypot(b[0] - a[0], b[1] - a[1]), steps = Math.max(2, Math.ceil(L / (PX / 2)));
            for (let s = 0; s <= steps; s++) { const j = cellIdx(a[0] + ((b[0] - a[0]) * s) / steps, a[1] + ((b[1] - a[1]) * s) / steps); if (j >= 0) { ov.set(c, j * 3); if (j + 1 < W * H) ov.set(c, (j + 1) * 3); } }
        }
    };
    for (const s of solids) drawRing(s.ring, s.kind === 'tank' || s.kind === 'tank leg' ? [255, 220, 0] : s.kind === 'post' ? [0, 255, 0] : s.kind === 'duct' ? [60, 140, 255] : [255, 40, 40]);
    for (const i of prog.insets ?? []) drawRing(rect(i.u0, i.v0, i.u1, i.v1), [0, 255, 255]);
    fs.writeFileSync(path.join(OUT, 'overlay.png'), encodePng(W, H, Buffer.from(ov), 3));

    // 7. clay: the block with the reading, the block with the current roof objects, and the scan, from the same cameras
    const worldOf = ([u, v]: P2): P2 => toXZ(u, v);
    const meshOf = (items: Array<{ ring: P2[]; y0: number; y1: number; cone?: number }>): RenderMesh3D => {
        const V: number[] = [], I: number[] = [];
        for (const it of items) {
            const r = it.ring, b = V.length / 3;
            for (const p of r) V.push(p[0], it.y0, p[1]);
            for (const p of r) V.push(p[0], it.y1, p[1]);
            const n = r.length;
            for (let k = 0; k < n; k++) { const k2 = (k + 1) % n; I.push(b + k, b + k2, b + n + k2, b + k, b + n + k2, b + n + k); }
            // caps (fan: the rings here are convex or nearly)
            for (let k = 1; k + 1 < n; k++) { I.push(b + n, b + n + k, b + n + k + 1); I.push(b, b + k + 1, b + k); }
            if (it.cone) { let cx = 0, cz = 0; for (const p of r) { cx += p[0]; cz += p[1]; } V.push(cx / n, it.y1 + it.cone, cz / n); const apex = V.length / 3 - 1; for (let k = 0; k < n; k++) I.push(b + n + k, b + n + (k + 1) % n, apex); }
        }
        return { vertices: V, indices: I };
    };
    const blockItem = { ring: block, y0: sm.groundY, y1: roofY };
    const readingMesh = meshOf([blockItem, ...solids.map(s => ({ ring: s.ring.map(worldOf), y0: roofY + s.base, y1: roofY + s.topY, cone: s.cone }))]);
    const currentMesh = meshOf([blockItem, ...(sm.roof?.objects ?? []).filter(o => o.outline.length >= 3 && !o.mesh).map(o => ({ ring: o.outline, y0: o.baseY, y1: o.topY }))]);
    // the current method's revolved and repeated solids are meshes: drawn as their bounding prisms here, labelled so
    const curSolids = (sm.roof?.objects ?? []).filter(o => o.mesh).map(o => { const xs = o.mesh!.v.map(p => p[0]), zs = o.mesh!.v.map(p => p[2]), ys = o.mesh!.v.map(p => p[1]); return { v: o.mesh!.v, i: o.mesh!.i, y: [Math.min(...ys), Math.max(...ys)], x: [Math.min(...xs), Math.max(...xs)], z: [Math.min(...zs), Math.max(...zs)] }; });
    const cm = { vertices: [...(currentMesh.vertices as number[])], indices: [...(currentMesh.indices as number[])] };
    for (const s of curSolids) { const b = cm.vertices.length / 3; for (const p of s.v) cm.vertices.push(p[0], p[1], p[2]); for (const q of s.i) cm.indices.push(b + q); }
    const [cx, cz] = toXZ((W * PX) / 2, (H * PX) / 2);
    const views = {
        top: { x: cx + 0.01, y: roofY + 70, z: cz + 0.01, targetX: cx, targetY: roofY, targetZ: cz, fov: 40 },
        oblique: { x: cx + V[0] * 40 + U[0] * 25, y: roofY + 30, z: cz + V[1] * 40 + U[1] * 25, targetX: cx, targetY: roofY + 2, targetZ: cz, fov: 45 }
    };
    for (const [vn, cam] of Object.entries(views)) for (const [cn, mesh] of Object.entries({ scan, reading: readingMesh, current: cm })) {
        const img = R.renderShadedMesh(mesh as RenderMesh3D, cam, 900, 700, { clayColor: [200, 194, 184], bgColor: [255, 255, 255, 255], lightDir: [0.4, 0.8, 0.3], clipNearPlane: true });
        fs.writeFileSync(path.join(OUT, `clay_${vn}_${cn}.png`), encodePng(900, 700, img.rgba, 4));
    }
    console.log(`written to ${OUT}`);
})().catch(e => { console.error('FAILED', e); process.exit(1); });
