/**
 * The window boxes of a facade drawn over its straightened photo, before and after the window array step
 * (pipeline-k/window-array.ts), for a labelled proof sheet.
 *
 *   npx vite-node scripts/window_array_overlay.ts --orthos <relief_orthos_k_dir> --facade <id> --out <png>
 *       the boxes from window_fit.json: before (array.in) in magenta on the left, after (rects) on the right, the moved
 *       and replaced boxes in cyan, strips folded into cells in orange, the added in yellow, bays kept whole in green,
 *       boxes of another size kept as read in magenta, sites the array stepped on into a blank band in violet
 *   npx vite-node scripts/window_array_overlay.ts --orthos <dir> --facade <id> --glb <model.glb> --out <png>
 *       the right side from the model's own extras (sbFacadeLattice.windows: uv, generated, array) instead
 *   add --infer to run the array step on a copy of the orthos first (an offline check of a kept cache)
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { decodePng } from '../packages/core/src/node/texture-processing';
import { encodePng } from '../packages/core/src/node/3d-engine/staged-location/png-encode';
import { parseGlbBytes } from '../packages/core/src/node/3d-engine/staged-location/glb-bytes';
import { inferWindowArrays, SITE_KIND, type ArrayRecord } from '../packages/core/src/node/3d-engine/staged-location/pipeline-k/window-array';
import type { WindowFitFile, WindowRect } from '../packages/core/src/node/3d-engine/staged-location/window-fit';

const arg = (k: string): string | undefined => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const orthosArg = arg('orthos'), facadeId = Number(arg('facade')), out = arg('out'), glb = arg('glb');
if (!orthosArg || !Number.isFinite(facadeId) || !out) { console.error('usage: --orthos <dir> --facade <id> --out <png> [--glb <model>] [--infer]'); process.exit(2); }

let orthos = orthosArg;
if (process.argv.includes('--infer')) {
    const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'window-array-'));
    for (const f of fs.readdirSync(orthosArg)) if (/^facade_\d+(_uncovered|_occluded|_featureless)?\.png$|^facades\.json$|^window_fit\.json$/.test(f)) fs.copyFileSync(path.join(orthosArg, f), path.join(copy, f));
    const fit = JSON.parse(fs.readFileSync(path.join(copy, 'window_fit.json'), 'utf8')) as WindowFitFile;
    const rep = inferWindowArrays(copy, fit);
    console.log(JSON.stringify(rep.facades.map(f => ({ ...f, tiers: f.tiers?.map(t => ({ ...t, boxM: t.boxM.join('x') })) })), null, 1));
    orthos = copy;
}
const fit = JSON.parse(fs.readFileSync(path.join(orthos, 'window_fit.json'), 'utf8')) as WindowFitFile;
const e = fit.facades.find(f => f.facadeId === facadeId);
if (!e || 'error' in e) { console.error(`facade ${facadeId} not fitted`); process.exit(1); }
const img = decodePng(fs.readFileSync(path.join(orthos, `facade_${facadeId}.png`)));
const W = img.width, H = img.height;
const rec = (e as typeof e & { array?: ArrayRecord }).array;
const before: WindowRect[] = rec ? rec.in.rects : e.rects;
type Box = { r: WindowRect; kind: number };
let after: Box[];
if (glb) {
    const g = parseGlbBytes(fs.readFileSync(glb));
    const node = (g.json.nodes ?? []).find((n: any) => n.extras?.sbFacadeLattice?.facadeId === facadeId);
    const w = node?.extras?.sbFacadeLattice?.windows;
    if (!w) { console.error(`no sbFacadeLattice.windows for facade ${facadeId} in ${glb}`); process.exit(1); }
    const toPx = (uv: number[]): WindowRect[] => { const o: WindowRect[] = []; for (let k = 0; k + 3 < uv.length; k += 4) o.push([Math.round(uv[k] * W), Math.round(uv[k + 1] * H), Math.round(uv[k + 2] * W), Math.round(uv[k + 3] * H)]); return o; };
    const gen = new Set(toPx(w.generated?.uv ?? []).map(r => r.join(','))), moved = new Set([...toPx(w.array?.snapped_uv ?? []), ...toPx(w.array?.replaced_uv ?? [])].map(r => r.join(','))), folded = new Set(toPx(w.array?.folded_uv ?? []).map(r => r.join(','))), continued = new Set(toPx(w.array?.continued_uv ?? []).map(r => r.join(',')));
    after = toPx(w.uv).map(r => ({ r, kind: continued.has(r.join(',')) ? SITE_KIND.continued : gen.has(r.join(',')) ? SITE_KIND.added : moved.has(r.join(',')) ? SITE_KIND.snapped : folded.has(r.join(',')) ? SITE_KIND.folded : SITE_KIND.on }));
    console.log(JSON.stringify({ facadeId, extras: { ...w.array, snapped_uv: undefined, replaced_uv: undefined, folded_uv: undefined, continued_uv: undefined }, windows: toPx(w.uv).length, generated: gen.size }, null, 1));
} else after = rec ? Array.from({ length: rec.sites.length / 7 }, (_, k) => ({ r: rec.sites.slice(k * 7, k * 7 + 4) as WindowRect, kind: rec.sites[k * 7 + 4] })) : e.rects.map(r => ({ r, kind: SITE_KIND.on }));

const gap = 12, rgba = new Uint8Array((W * 2 + gap) * H * 4).fill(255);
const OW = W * 2 + gap;
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const s = (y * W + x) * 4; for (const ox of [0, W + gap]) rgba.set(img.rgba.subarray(s, s + 4), (y * OW + x + ox) * 4); }
const draw = (rIn: WindowRect, ox: number, c: [number, number, number]) => {
    const r = rIn.map(Math.round) as WindowRect; // the reader's boxes come at fractional pixels
    const set = (x: number, y: number) => { if (x >= 0 && x < W && y >= 0 && y < H) rgba.set([...c, 255], (y * OW + x + ox) * 4); };
    for (let x = r[0]; x < r[2]; x++) { set(x, r[1]); set(x, r[3] - 1); }
    for (let y = r[1]; y < r[3]; y++) { set(r[0], y); set(r[2] - 1, y); }
};
const MAGENTA: [number, number, number] = [255, 0, 255], CYAN: [number, number, number] = [0, 220, 255], YELLOW: [number, number, number] = [255, 230, 0], GREEN: [number, number, number] = [0, 255, 80], ORANGE: [number, number, number] = [255, 140, 0], VIOLET: [number, number, number] = [170, 90, 255];
for (const r of before) draw(r, 0, MAGENTA);
for (const b of after) draw(b.r, W + gap, b.kind === SITE_KIND.added ? YELLOW : b.kind === SITE_KIND.continued ? VIOLET : b.kind === SITE_KIND.snapped || b.kind === SITE_KIND.replaced ? CYAN : b.kind === SITE_KIND.folded ? ORANGE : b.kind === SITE_KIND.span ? GREEN : MAGENTA);
fs.writeFileSync(out, encodePng(OW, H, rgba, 4));
console.log(`before ${before.length} boxes, after ${after.length} (${after.filter(b => b.kind === SITE_KIND.added).length} added, ${after.filter(b => b.kind === SITE_KIND.snapped || b.kind === SITE_KIND.replaced).length} moved or replaced, ${after.filter(b => b.kind === SITE_KIND.folded).length} cells from folded strips, ${after.filter(b => b.kind === SITE_KIND.continued).length} stepped into blank bands); ${out}`);
