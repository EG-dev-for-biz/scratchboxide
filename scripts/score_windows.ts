/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Scores a build's window fit against the checked sets (window-score.ts): per crop and over all crops, pixel IoU,
 * precision and recall, windows found and correct, and edge error in pixels. Window sets are scored against the fitted
 * windows; bay sets against the bays the relief recesses (facade-lattice.ts windowStrips, from the same windows), and the
 * two are totalled apart.
 *
 *   npm run score:windows                         the latest pipeline K window fit in .scratchbox/cache
 *   npm run score:windows -- --orthos <dir>       a facade photo folder holding window_fit.json and facades.json
 *   npm run score:windows -- --fit <file>         a window_fit.json (no texel check, no overlays without --orthos)
 *   ... --sets <dir>                              checked sets (default packages/core/test/fixtures/window-checked)
 *   ... --overlays <dir>                          a PNG per crop: checked windows cyan, fitted green, matched edges off by more than 2 px red
 *   ... --json                                    the scores as JSON
 *
 * A set whose facade photo now has another texel (a different extraction or rectification) is skipped and said so: its
 * crop would no longer hold the same windows.
 */

import * as fs from 'fs';
import * as path from 'path';
import { fittedWindowRects, type WindowFitFile } from '../packages/core/src/node/3d-engine/staged-location/window-fit';
import { windowStrips } from '../packages/core/src/node/3d-engine/staged-location/facade-lattice';
import { fittedInCrop, scoreTotals, scoreWindows, type CheckedSet, type WindowRect, type WindowScore } from '../packages/core/src/node/3d-engine/staged-location/window-score';
import { decodePng } from '../packages/core/src/node/texture-processing';
import { encodePng } from '../packages/core/src/node/3d-engine/staged-location/png-encode';

const ROOT = path.resolve(__dirname, '..');
const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };
const flag = (name: string) => process.argv.includes(`--${name}`);

function latestOrthos(): string | undefined {
    const base = path.join(ROOT, '.scratchbox/cache/tile_refine');
    if (!fs.existsSync(base)) return undefined;
    const found: Array<{ dir: string; t: number }> = [];
    for (const k of fs.readdirSync(base)) for (const d of fs.existsSync(path.join(base, k)) ? fs.readdirSync(path.join(base, k)) : []) {
        const file = path.join(base, k, d, 'window_fit.json');
        if (d.startsWith('relief_orthos_k') && fs.existsSync(file)) found.push({ dir: path.join(base, k, d), t: fs.statSync(file).mtimeMs });
    }
    return found.sort((a, b) => b.t - a.t)[0]?.dir;
}

function overlay(file: string, set: CheckedSet, fitted: WindowRect[], score: WindowScore, out: string): void {
    const img = decodePng(fs.readFileSync(file));
    const [x0, x1, y0, y1] = set.crop, w = x1 - x0, h = y1 - y0, S = 3, W = w * S, H = h * S;
    const rgb = new Uint8Array(W * H * 3);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const sx = Math.min(img.width - 1, x0 + Math.floor(x / S)), sy = Math.min(img.height - 1, y0 + Math.floor(y / S)), i = (sy * img.width + sx) * 4;
        rgb.set([img.rgba[i], img.rgba[i + 1], img.rgba[i + 2]], (y * W + x) * 3);
    }
    const tint = (r: WindowRect, c: number[], a: number) => { for (let y = Math.max(0, r[1] * S); y < Math.min(H, r[3] * S); y++) for (let x = Math.max(0, r[0] * S); x < Math.min(W, r[2] * S); x++) { const k = (y * W + x) * 3; for (let j = 0; j < 3; j++) rgb[k + j] = Math.round(rgb[k + j] * (1 - a) + c[j] * a); } };
    const outline = (r: WindowRect, c: number[]) => { const [a, b, cc, d] = r.map(v => Math.round(v * S)); for (let x = Math.max(0, a); x < Math.min(W, cc); x++) for (const y of [b, d - 1]) if (y >= 0 && y < H) rgb.set(c, (y * W + x) * 3); for (let y = Math.max(0, b); y < Math.min(H, d); y++) for (const x of [a, cc - 1]) if (x >= 0 && x < W) rgb.set(c, (y * W + x) * 3); };
    for (const r of fitted) tint(r, [0, 200, 0], 0.45);
    for (const r of set.windows) outline(r, [0, 255, 255]);
    for (const p of score.pairs) if (p.offsetPx.some(o => Math.abs(o) > 2)) outline(fitted[p.fitted], [255, 0, 0]);
    fs.writeFileSync(out, encodePng(W, H, rgb, 3));
}

function main(): void {
    const orthos = arg('orthos') ?? (arg('fit') ? undefined : latestOrthos());
    const fitFile = arg('fit') ?? (orthos ? path.join(orthos, 'window_fit.json') : undefined);
    if (!fitFile || !fs.existsSync(fitFile)) throw new Error('no window_fit.json: run a pipeline K build first, or pass --orthos <dir> or --fit <file>');
    const setsDir = arg('sets') ?? path.join(ROOT, 'packages/core/test/fixtures/window-checked');
    const fit = JSON.parse(fs.readFileSync(fitFile, 'utf8')) as WindowFitFile;
    const facades = orthos && fs.existsSync(path.join(orthos, 'facades.json')) ? (JSON.parse(fs.readFileSync(path.join(orthos, 'facades.json'), 'utf8')).facades as Array<{ facadeId: number; image: string; pixel: number }>) : [];
    const overlays = arg('overlays');
    if (overlays) fs.mkdirSync(overlays, { recursive: true });
    const rows: Array<{ set: string; kind: string; facadeId: number; score?: WindowScore; skipped?: string }> = [];
    for (const name of fs.readdirSync(setsDir).filter(n => n.endsWith('.json')).sort()) {
        const set = JSON.parse(fs.readFileSync(path.join(setsDir, name), 'utf8')) as CheckedSet;
        const facade = facades.find(f => f.facadeId === set.facadeId);
        const kind = set.kind ?? 'windows';
        if (facade && Math.abs(facade.pixel - set.pixel) > 0.01 * set.pixel) { rows.push({ set: name, kind, facadeId: set.facadeId, skipped: `its photo's texel is now ${facade.pixel.toFixed(4)} m, the set was checked at ${set.pixel.toFixed(4)} m` }); continue; }
        const windows = (fittedWindowRects(fit, set.facadeId) ?? []) as WindowRect[];
        // bays: the relief's runs drawn from the fitted windows (in metres, as the lattice draws them), back in photo pixels
        const px = set.pixel, rects = kind === 'bays' ? windowStrips(windows.map(r => r.map(v => v * px) as WindowRect)).map(b => b.map(v => v / px) as WindowRect) : windows;
        const fitted = fittedInCrop(rects, set);
        const [x0, x1, y0, y1] = set.crop;
        const score = scoreWindows(fitted, set.windows, x1 - x0, y1 - y0);
        rows.push({ set: name, kind, facadeId: set.facadeId, score });
        if (overlays && orthos && facade) overlay(path.join(orthos, facade.image), set, fitted.map(r => [Math.max(0, r[0]), Math.max(0, r[1]), Math.min(x1 - x0, r[2]), Math.min(y1 - y0, r[3])] as WindowRect), score, path.join(overlays, name.replace(/\.json$/, '.png')));
    }
    const kinds = [...new Set(rows.map(r => r.kind))].sort().reverse();
    const totals = Object.fromEntries(kinds.map(k => [k, rows.filter(r => r.kind === k && r.score).map(r => r.score!)] as const).filter(([, s]) => s.length).map(([k, s]) => [k, scoreTotals(s)]));
    if (flag('json')) { console.log(JSON.stringify({ fit: fitFile, sets: setsDir, rows, totals }, null, 2)); return; }
    const f2 = (v: number) => (Number.isFinite(v) ? v.toFixed(2) : '-'), f1 = (v: number) => (Number.isFinite(v) ? v.toFixed(1) : '-');
    console.log(`window fit: ${fitFile}\nchecked sets: ${setsDir}\n`);
    for (const k of kinds) {
        console.log(`\n${k === 'bays' ? 'Bays (the relief\'s runs between piers)' : k === 'windows' ? 'Windows (each opening)' : k}:\n`);
        console.log('| Set | Facade | Pixel IoU | Precision | Recall | Found | Correct | Edge error px (mean / median / p90, n) |');
        console.log('|---|---|---|---|---|---|---|---|');
        for (const r of rows.filter(x => x.kind === k)) {
            if (!r.score) { console.log(`| ${r.set} | ${r.facadeId} | skipped: ${r.skipped} | | | | | |`); continue; }
            const s = r.score;
            console.log(`| ${r.set} | ${r.facadeId} | ${f2(s.pixel.iou)} | ${f2(s.pixel.precision)} | ${f2(s.pixel.recall)} | ${s.found}/${s.checked} | ${s.correct}/${s.fitted} | ${f1(s.edges.meanPx)} / ${f1(s.edges.medianPx)} / ${f1(s.edges.p90Px)}, ${s.edges.n} |`);
        }
        const t = totals[k];
        if (t) console.log(`| **all** | | **${f2(t.pixel.iou)}** | **${f2(t.pixel.precision)}** | **${f2(t.pixel.recall)}** | **${t.found}/${t.checked}** | **${t.correct}/${t.fitted}** | **${f1(t.edges.meanPx)} / ${f1(t.edges.medianPx)} / ${f1(t.edges.p90Px)}, ${t.edges.n}** |`);
    }
}

main();
