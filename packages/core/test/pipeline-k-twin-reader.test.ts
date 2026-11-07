import { describe, expect, it } from 'vitest';
import { memoryReadingStore } from '../src/node/3d-engine/staged-location/pipeline-k/model-readings';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { decodePng } from '../src/node/texture-processing';
import { encodePng } from '../src/node/3d-engine/staged-location/png-encode';
import { writeStagedGlbFile } from '../src/node/3d-engine/staged-location/staged-glb-writer';
import { readOnTwin } from '../src/node/3d-engine/staged-location/pipeline-k/twin-reader';
import type { FacadeAsk, ImageRegion } from '../src/node/3d-engine/staged-location/pipeline-k/facade-reader';

// a 30 m x 30 m facade at 0.1 m a pixel: 5 columns of windows 12 px wide, storeys every 40 px, windows 22 px tall
const W = 300, H = 300, PIXEL = 0.1, PITCH = 40, PHASE = 9, WIN_H = 22;
const cols: Array<[number, number]> = [18, 74, 130, 186, 242].map(x => [x, x + 12]);
function photo(win: number, wall: number): Uint8Array {
    const rgba = new Uint8Array(W * H * 4);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const v = cols.some(([a, b]) => x >= a && x < b) && (((y - PHASE) % PITCH) + PITCH) % PITCH < WIN_H ? win : wall;
        rgba.set([v, v, v, 255], (y * W + x) * 4);
    }
    return rgba;
}
const frame = { facadeId: 7, image: 'facade_7.png', width: W, height: H, pixel: PIXEL, texel: PIXEL, orthoSMin: 0, orthoTMax: H * PIXEL, coverage: 1, centroid: [0, 15, 0], normal: [0, 0, 1], axisS: [1, 0, 0], axisT: [0, 1, 0], sMin: -15, sMax: 15, tMin: -15, tMax: 15 };

/**
 * K's orthos for facade 7 (its straightened photo, and its occlusion mask when given: one channel, 255 x the share blocked,
 * as tile_refine writes it), tile_refine's flat scan, and the twin whose image 0 is facade 7's rebuilt texture.
 */
function twinCase(dir: string, occluded?: Uint8Array) {
    const orthos = path.join(dir, 'relief_orthos_k_x');
    fs.mkdirSync(orthos);
    fs.writeFileSync(path.join(orthos, 'facade_7.png'), encodePng(W, H, photo(90, 200), 4));
    if (occluded) fs.writeFileSync(path.join(orthos, 'facade_7_occluded.png'), encodePng(W, H, occluded, 1));
    fs.writeFileSync(path.join(orthos, 'facades.json'), JSON.stringify({ facades: [{ ...frame, ...(occluded ? { occludedMask: 'facade_7_occluded.png' } : {}) }] }));
    // the flat scan: one small triangle, no plane of its own worth photographing
    const flat = path.join(dir, 'textured.glb');
    writeStagedGlbFile(flat, [{ name: 'scan', positions: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]), indices: Uint32Array.from([0, 1, 2]) }], {});
    const twinJson = { nodes: [{ mesh: 0, extras: { sbFacadeLattice: { facadeId: 7 } } }], meshes: [{ primitives: [{ material: 0 }] }], materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }], textures: [{ source: 0 }], images: [{}] };
    return { orthos, flat, twinJson };
}

/** A model that sees every column's windows in each storey its crop holds (grey or not), and accepts every outline; the read crops kept. */
function oracle() {
    const asked: string[] = [], crops: Array<{ png: Buffer; region: ImageRegion }> = [];
    const ask: FacadeAsk = async (png, _prompt, kind, region) => {
        asked.push(kind);
        if (kind === 'judge') return JSON.stringify({ accept: true, badColumns: [], conf: 80 });
        if (kind === 'overview') return JSON.stringify({ zones: [{ box: [0, 0, 1000, 1000], openings: true }], conf: 90 });
        if (kind === 'read') crops.push({ png: png as Buffer, region });
        const ch = region.y1 - region.y0, cw = region.x1 - region.x0, rows = [];
        for (let k = 0; k < 10; k++) { const t = PHASE + k * PITCH; if (t >= region.y0 && t + WIN_H <= region.y1) rows.push({ y: [((t - region.y0) / ch) * 1000, ((t + WIN_H - region.y0) / ch) * 1000], openings: cols.map(([a, b]) => ({ x: [((a - region.x0) / cw) * 1000, ((b - region.x0) / cw) * 1000], panes: 1 })) }); }
        return JSON.stringify({ rows, conf: 85 });
    };
    return { ask, asked, crops };
}

describe('the facade reader on the finished exterior', () => {
    it('reads each facade from its harmonised rebuilt texture, and records its openings', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'twin-reader-'));
        try {
            const { orthos, flat, twinJson } = twinCase(dir);
            // the twin: facade 7's rebuilt texture is image 0, harmonised darker
            const harmonised = photo(40, 150);
            const { ask, asked } = oracle();
            const r = await readOnTwin({ orthosDir: orthos, flatGlb: flat, twinJson, finalImage: new Map([[0, { width: W, height: H, rgba: harmonised }]]), ask });
            expect(r.report).toMatchObject({ facadesHarmonised: 1, facadesAsPhotographed: 0 });
            // what the reader was given is the harmonised texture, in the photo's own frame
            const given = decodePng(fs.readFileSync(path.join(r.report.dir, 'facade_7.png')));
            expect([given.width, given.height]).toEqual([W, H]);
            expect(Buffer.from(given.rgba).equals(Buffer.from(harmonised))).toBe(true);
            expect(asked).toContain('read');
            // the reader's openings recorded (told to the material reads; nothing is drawn from them)
            const p = r.records.readings.find(x => x.facadeId === 7)!;
            expect(p.rects.length).toBeGreaterThan(20);
            expect(r.records.readings.filter(x => x.facadeId === 7)).toHaveLength(1);
            expect('planes' in r).toBe(false);
        } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    });

    it('keeps a facade\'s answers by its straightened photo, so a twin whose harmonised texture drifted a little asks nothing again', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'twin-reader-'));
        try {
            const { orthos, flat, twinJson } = twinCase(dir);
            const store = memoryReadingStore();
            const first = oracle();
            const a = await readOnTwin({ orthosDir: orthos, flatGlb: flat, twinJson, finalImage: new Map([[0, { width: W, height: H, rgba: photo(40, 150) }]]), ask: first.ask, readings: { store, model: 'm' } });
            expect(first.asked.length).toBeGreaterThan(0);
            // the same building built again: its straightened photo the same, its harmonised texture a few levels off
            const second = oracle();
            const b = await readOnTwin({ orthosDir: orthos, flatGlb: flat, twinJson, finalImage: new Map([[0, { width: W, height: H, rgba: photo(43, 153) }]]), ask: second.ask, readings: { store, model: 'm' } });
            expect(second.asked).toEqual([]);
            expect(b.records.readings.find(x => x.facadeId === 7)!.rects).toEqual(a.records.readings.find(x => x.facadeId === 7)!.rects);
        } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    });

    it("greys what tile_refine found blocked out of the reader's crops on the twin, and tiles no window there", async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'twin-reader-occ-'));
        try {
            // a crown stood in front of the right of the facade (x >= 170: 78% of the rays blocked, columns 4 and 5), and
            // something low across its left (x < 60: 59% blocked, under the 65% the readers skip: column 1 is still read)
            const CROWN = 170, occluded = new Uint8Array(W * H);
            for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) occluded[y * W + x] = x >= CROWN ? 200 : x < 60 ? 150 : 0;
            const { orthos, flat, twinJson } = twinCase(dir, occluded);
            // the twin's harmonised texture shows the crown's leaves where it stood
            const harmonised = photo(40, 150);
            for (let y = 0; y < H; y++) for (let x = CROWN; x < W; x++) harmonised.set([30, 90, 30, 255], (y * W + x) * 4);
            const { ask, crops } = oracle();
            const r = await readOnTwin({ orthosDir: orthos, flatGlb: flat, twinJson, finalImage: new Map([[0, { width: W, height: H, rgba: harmonised }]]), ask });
            // the occlusion mask reached the reader's copy of the orthos beside the harmonised texture
            expect(Buffer.from(fs.readFileSync(path.join(r.report.dir, 'facade_7_occluded.png'))).equals(fs.readFileSync(path.join(orthos, 'facade_7_occluded.png')))).toBe(true);
            // every read crop: uniform grey over the occluded texels, the harmonised texture everywhere else
            expect(crops.length).toBeGreaterThan(0);
            for (const { png, region } of crops) {
                const c = decodePng(png), scale = c.width / (region.x1 - region.x0);
                let grey = 0, kept = 0, wrong = 0;
                for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
                    const sx = region.x0 + Math.floor(x / scale), sy = region.y0 + Math.floor(y / scale), q = (y * c.width + x) * 4, p = (sy * W + sx) * 4;
                    const want = sx >= CROWN ? [128, 128, 128] : [harmonised[p], harmonised[p + 1], harmonised[p + 2]];
                    if (c.rgba[q] !== want[0] || c.rgba[q + 1] !== want[1] || c.rgba[q + 2] !== want[2]) wrong++;
                    if (sx >= CROWN) grey++; else kept++;
                }
                expect(wrong).toBe(0);
                expect(grey).toBeGreaterThan(0);
                expect(kept).toBeGreaterThan(0);
            }
            // the model saw windows in all five columns, but the tiling draws only the three it may read, a window every storey
            const p = r.records.readings.find(x => x.facadeId === 7)!;
            expect(p.rects.length).toBeGreaterThan(0);
            expect(p.rects.filter(w => w[2] > CROWN)).toEqual([]);
            for (const [a, b] of cols.slice(0, 3)) expect(p.rects.filter(w => Math.abs(w[0] - a) < 2 && Math.abs(w[2] - b) < 2).length).toBeGreaterThanOrEqual(6);
            expect(p.panes.filter(w => w[2] > CROWN)).toEqual([]);
        } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    });
});
