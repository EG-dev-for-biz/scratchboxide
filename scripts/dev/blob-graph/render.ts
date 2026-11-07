/**
 * Blob graph prototype (dev tool, not shipped), step 4: renders for reading.
 *
 *   node -r ts-node/register scripts/dev/blob-graph/render.ts --out <dir> select [--others 180] [--seed penn]
 *   node -r ts-node/register scripts/dev/blob-graph/render.ts --out <dir> overview
 *   node -r ts-node/register scripts/dev/blob-graph/render.ts --out <dir> blobs --shard 0 --of 3
 *
 * select: every building and roof object, the ground, and a seeded random sample of the other blobs (the plan's rule for
 * districts of more than about 400 blobs) -> <dir>/selection.json.
 * overview: the district from above, photo textured and coloured by treatment group -> <dir>/overview_*.png.
 * blobs: each selected blob's views -> <dir>/views/<index>/ (photo_<az>.png, clay_<az>.png, context.png, heldout.png,
 * sheet.png), and for each building a numbered sheet of it with its child blobs (building_sheet.png).
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { renderTriangles, composeGrid, drawText } from '../../../packages/core/src/node/3d-engine/staged-location/photo-match-eval';
import { loadScene, subset, boundsOf, orbit, topDown, blobViews, readerSheet, png, READER_AZIMUTHS, type Scene } from './views';
import type { BlobRecord } from './split';

type V3 = [number, number, number];

export const GROUP_COLOURS: Record<string, V3> = {
    ground: [0.35, 0.35, 0.35], building: [0.55, 0.62, 0.75], 'roof-object': [0.95, 0.55, 0.05], 'wall-attachment': [0.85, 0.1, 0.6],
    tree: [0.1, 0.7, 0.15], 'transient-candidate': [0.95, 0.9, 0.05], 'ground-object': [0.05, 0.75, 0.95]
};

function arg(name: string, fallback?: string): string {
    const i = process.argv.indexOf(`--${name}`);
    const v = i >= 0 ? process.argv[i + 1] : fallback;
    if (v === undefined) throw new Error(`--${name} is required`);
    return v;
}

function seededShuffle<T>(items: T[], seed: string): T[] {
    return items.map(x => ({ x, k: crypto.createHash('sha256').update(seed + JSON.stringify(x)).digest('hex') })).sort((a, b) => a.k.localeCompare(b.k)).map(e => e.x);
}

function project(cam: ReturnType<typeof orbit>, p: V3): [number, number] | undefined {
    const d: V3 = [p[0] - cam.eye[0], p[1] - cam.eye[1], p[2] - cam.eye[2]];
    const x = d[0] * cam.right[0] + d[1] * cam.right[1] + d[2] * cam.right[2];
    const y = d[0] * cam.up[0] + d[1] * cam.up[1] + d[2] * cam.up[2];
    const z = d[0] * cam.fwd[0] + d[1] * cam.fwd[1] + d[2] * cam.fwd[2];
    if (z <= 0.1) return undefined;
    return [cam.cx + (cam.fx * x) / z, cam.cy - (cam.fy * y) / z];
}

/** The building with its child blobs, each child's number drawn at its centre (two views). */
function buildingSheet(s: Scene, blobs: BlobRecord[], bi: number, size = 640): { sheet: Buffer; children: number[] } {
    // the 30 largest children are numbered (more crowd the sheet unreadably); every child is still read on its own
    const allChildren = blobs.filter(b => b.parent === bi).map(b => b.index);
    const children = allChildren.slice().sort((a, b) => Number(blobs[b].measures.areaM2) - Number(blobs[a].measures.areaM2)).slice(0, 30);
    const all = [bi, ...allChildren].flatMap(i => s.members[i]);
    const b = boundsOf(s, all);
    const dist = (b.radius / Math.sin((22 * Math.PI) / 180)) * 1.05;
    const tiles = [45, 225].map(az => {
        const cam = orbit(b.centre, dist, az, 50, size);
        const r = renderTriangles([subset(s.soup, all)], cam, { supersample: 2 });
        const rgb = new Uint8Array(r.width * r.height * 3);
        for (let i = 0; i < r.width * r.height; i++) { rgb[i * 3] = r.rgba[i * 4]; rgb[i * 3 + 1] = r.rgba[i * 4 + 1]; rgb[i * 3 + 2] = r.rgba[i * 4 + 2]; }
        children.forEach((c, k) => {
            const cb = boundsOf(s, s.members[c]);
            const p = project(cam, cb.centre);
            if (!p) return;
            const label = String(k + 1);
            const x = Math.round(p[0]) - 4, y = Math.round(p[1]) - 7;
            for (let dy = -2; dy < 16; dy++) for (let dx = -2; dx < label.length * 12 + 1; dx++) {
                const px = x + dx, py = y + dy;
                if (px < 0 || py < 0 || px >= r.width || py >= r.height) continue;
                const o = (py * r.width + px) * 3; rgb[o] = 0; rgb[o + 1] = 0; rgb[o + 2] = 0;
            }
            drawText(rgb, r.width, r.height, x, y, label, 2, [255, 230, 0]);
        });
        const rgba = new Uint8Array(r.width * r.height * 4);
        for (let i = 0; i < r.width * r.height; i++) { rgba[i * 4] = rgb[i * 3]; rgba[i * 4 + 1] = rgb[i * 3 + 1]; rgba[i * 4 + 2] = rgb[i * 3 + 2]; rgba[i * 4 + 3] = 255; }
        return { image: { width: r.width, height: r.height, rgba }, label: `FROM ${az}` };
    });
    return { sheet: composeGrid(tiles, { tileWidth: size, columns: 2, title: `BUILDING ${bi}: ${children.length} OF ${allChildren.length} CHILD BLOBS NUMBERED` }), children };
}

async function main(): Promise<void> {
    const out = path.resolve(arg('out'));
    const cmd = process.argv[process.argv.length - 1] === 'select' || process.argv.includes('select') ? 'select' : process.argv.includes('overview') ? 'overview' : 'blobs';
    const graph = JSON.parse(fs.readFileSync(path.join(out, 'split', 'blobs.json'), 'utf8')) as { blobs: BlobRecord[] };
    const blobs = graph.blobs;
    if (cmd === 'select') {
        const always = blobs.filter(b => b.group === 'building' || b.group === 'roof-object' || b.group === 'ground').map(b => b.index);
        const pool = blobs.filter(b => !always.includes(b.index)).map(b => b.index);
        const others = seededShuffle(pool, arg('seed', 'penn-blob-test')).slice(0, Number(arg('others', '180')));
        const selection = { always, others: others.sort((a, b) => a - b), pool: pool.length, rule: 'every building, roof object and the ground; a seeded random sample of the rest (more than ~400 blobs in the district)' };
        fs.writeFileSync(path.join(out, 'selection.json'), JSON.stringify(selection, null, 1));
        console.log(`selected ${always.length} + ${others.length} of ${blobs.length}`);
        return;
    }
    const t0 = Date.now();
    const s = loadScene(out, blobs.length);
    console.log(`scene loaded (${Date.now() - t0} ms)`);
    if (cmd === 'overview') {
        const all = Array.from({ length: s.labels.length }, (_, t) => t);
        const b = boundsOf(s, all);
        const cam = topDown(b.lo, b.hi, 0.25);
        const tex = renderTriangles([subset(s.soup, all)], cam, { supersample: 1 });
        fs.writeFileSync(path.join(out, 'overview_photo.png'), png(tex));
        const meshes = Object.keys(GROUP_COLOURS).map(g => {
            const tris = blobs.filter(x => x.group === g).flatMap(x => s.members[x.index]);
            const c = GROUP_COLOURS[g].map(v => Math.pow(v, 2.2)) as V3;
            return subset(s.soup, tris, c);
        });
        const un: number[] = []; for (let t = 0; t < s.labels.length; t++) if (s.labels[t] < 0) un.push(t);
        meshes.push(subset(s.soup, un, [1, 0, 0]));
        const grp = renderTriangles(meshes, cam, { supersample: 1 });
        fs.writeFileSync(path.join(out, 'overview_groups.png'), png(grp));
        // an oblique overview for the district brief
        const obl = renderTriangles([subset(s.soup, all)], orbit([b.centre[0], b.lo[1] + 30, b.centre[2]], 420, 200, 40, 1400, 50), { supersample: 1 });
        fs.writeFileSync(path.join(out, 'overview_oblique.png'), png(obl));
        const obl2 = renderTriangles([subset(s.soup, all)], orbit([b.centre[0], b.lo[1] + 30, b.centre[2]], 420, 20, 40, 1400, 50), { supersample: 1 });
        fs.writeFileSync(path.join(out, 'overview_oblique_n.png'), png(obl2));
        console.log(`overview in ${Date.now() - t0} ms`);
        return;
    }
    const sel = JSON.parse(fs.readFileSync(path.join(out, 'selection.json'), 'utf8')) as { always: number[]; others: number[] };
    const shard = Number(arg('shard', '0')), of = Number(arg('of', '1'));
    const list = [...sel.always, ...sel.others].filter((_, k) => k % of === shard);
    for (const bi of list) {
        const dir = path.join(out, 'views', String(bi));
        if (process.argv.includes('--building-sheets')) {
            if (blobs[bi].group !== 'building') continue;
            const bs = buildingSheet(s, blobs, bi);
            fs.writeFileSync(path.join(dir, 'building_sheet.png'), bs.sheet);
            fs.writeFileSync(path.join(dir, 'building_children.json'), JSON.stringify(bs.children));
            continue;
        }
        if (fs.existsSync(path.join(dir, 'sheet.png'))) continue;
        fs.mkdirSync(dir, { recursive: true });
        const t1 = Date.now();
        const b = blobs[bi];
        const size = b.group === 'building' || b.group === 'ground' ? 448 : 320;
        const v = blobViews(s, bi, size);
        v.textured.forEach((r, k) => fs.writeFileSync(path.join(dir, `photo_${READER_AZIMUTHS[k]}.png`), png(r)));
        v.clay.forEach((r, k) => fs.writeFileSync(path.join(dir, `clay_${READER_AZIMUTHS[k]}.png`), png(r)));
        fs.writeFileSync(path.join(dir, 'context.png'), png(v.context));
        fs.writeFileSync(path.join(dir, 'heldout.png'), png(v.heldOut));
        if (b.group === 'building') {
            const bs = buildingSheet(s, blobs, bi);
            fs.writeFileSync(path.join(dir, 'building_sheet.png'), bs.sheet);
            fs.writeFileSync(path.join(dir, 'building_children.json'), JSON.stringify(bs.children));
        }
        fs.writeFileSync(path.join(dir, 'sheet.png'), readerSheet(v, `BLOB ${bi}`));
        console.log(`blob ${bi} (${b.group}, ${b.triangles} tris) ${Date.now() - t1} ms`);
    }
    console.log(`shard ${shard}/${of} done in ${Date.now() - t0} ms`);
}

main().catch(err => { console.error(err); process.exit(1); });
