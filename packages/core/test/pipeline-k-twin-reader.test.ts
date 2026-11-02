import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { decodePng } from '../src/node/texture-processing';
import { encodePng } from '../src/node/3d-engine/staged-location/png-encode';
import { writeStagedGlbFile } from '../src/node/3d-engine/staged-location/staged-glb-writer';
import { readOnTwin } from '../src/node/3d-engine/staged-location/pipeline-k/twin-reader';
import type { FacadeAsk } from '../src/node/3d-engine/staged-location/pipeline-k/facade-reader';
import type { FittedPlane } from '../src/node/3d-engine/staged-location/window-fit';

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

describe('the facade reader on the finished exterior', () => {
    it("reads each facade from its harmonised rebuilt texture, and its openings replace the window fit's for the glass", async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'twin-reader-'));
        try {
            const orthos = path.join(dir, 'relief_orthos_k_x');
            fs.mkdirSync(orthos);
            const frame = { facadeId: 7, image: 'facade_7.png', width: W, height: H, pixel: PIXEL, texel: PIXEL, orthoSMin: 0, orthoTMax: H * PIXEL, coverage: 1, centroid: [0, 15, 0], normal: [0, 0, 1], axisS: [1, 0, 0], axisT: [0, 1, 0], sMin: -15, sMax: 15, tMin: -15, tMax: 15 };
            fs.writeFileSync(path.join(orthos, 'facade_7.png'), encodePng(W, H, photo(90, 200), 4));
            fs.writeFileSync(path.join(orthos, 'facades.json'), JSON.stringify({ facades: [frame] }));
            // the flat scan: one small triangle, no plane of its own worth photographing
            const flat = path.join(dir, 'textured.glb');
            writeStagedGlbFile(flat, [{ name: 'scan', positions: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]), indices: Uint32Array.from([0, 1, 2]) }], {});
            // the twin: facade 7's rebuilt texture is image 0, harmonised darker
            const harmonised = photo(40, 150);
            const twinJson = { nodes: [{ mesh: 0, extras: { sbFacadeLattice: { facadeId: 7 } } }], meshes: [{ primitives: [{ material: 0 }] }], materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }], textures: [{ source: 0 }], images: [{}] };
            const fitted: FittedPlane = { ...frame, windows: [[0, 0, 5, 5]], panes: [[0, 0, 5, 5]], bays: [[10, 10, 60, 290]] };
            const asked: string[] = [];
            const ask: FacadeAsk = async (_png, _prompt, kind, region) => {
                asked.push(kind);
                if (kind === 'judge') return JSON.stringify({ accept: true, badColumns: [], conf: 80 });
                if (kind === 'overview') return JSON.stringify({ zones: [{ box: [0, 0, 1000, 1000], openings: true }], conf: 90 });
                const ch = region.y1 - region.y0, cw = region.x1 - region.x0, rows = [];
                for (let k = 0; k < 10; k++) { const t = PHASE + k * PITCH; if (t >= region.y0 && t + WIN_H <= region.y1) rows.push({ y: [((t - region.y0) / ch) * 1000, ((t + WIN_H - region.y0) / ch) * 1000], openings: cols.map(([a, b]) => ({ x: [((a - region.x0) / cw) * 1000, ((b - region.x0) / cw) * 1000], panes: 1 })) }); }
                return JSON.stringify({ rows, conf: 85 });
            };
            const r = await readOnTwin({ orthosDir: orthos, flatGlb: flat, twinJson, finalImage: new Map([[0, { width: W, height: H, rgba: harmonised }]]), fitted: [fitted], ask });
            expect(r.report).toMatchObject({ facadesHarmonised: 1, facadesAsPhotographed: 0 });
            // what the reader was given is the harmonised texture, in the photo's own frame
            const given = decodePng(fs.readFileSync(path.join(r.report.dir, 'facade_7.png')));
            expect([given.width, given.height]).toEqual([W, H]);
            expect(Buffer.from(given.rgba).equals(Buffer.from(harmonised))).toBe(true);
            expect(asked).toContain('read');
            // the reader's openings in place of the window fit's, the wall grammar's bays kept
            const p = r.planes.find(x => x.facadeId === 7)!;
            expect(p.windows.length).toBeGreaterThan(20);
            expect(p.windows).not.toContainEqual([0, 0, 5, 5]);
            expect(p.bays).toEqual([[10, 10, 60, 290]]);
            expect(r.planes.filter(x => x.facadeId === 7)).toHaveLength(1);
        } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    });
});
