/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Blueprint outlines (blueprint-outlines.ts, object_blueprint_outlines): a car-shaped test object of known size
 * (body, cabin, four wheels) is drawn into exact orthographic side, top and front views on a flat background; the
 * outlines read from those views match the ones cut from its triangles, a build that differs is caught where it
 * differs, and the tool draws (with a stand-in image model), saves and compares with no billed call.
 */

import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    aspectErrors,
    compareOutlines,
    describeDifferences,
    outlinesFromSilhouettes,
    outlinesFromTriangles,
    outlinesAsNotes,
    silhouetteOf,
    type ObjectOutlines,
    type Vec3
} from '../src/node/3d-engine/blueprint-outlines';
import { createBlueprintOutlineHandlers, BLUEPRINT_OUTLINE_TOOL_DECLARATIONS } from '../src/node/gemini/tools/blueprint-outline-tools';
import { HeadlessMeshSilhouetteRenderer } from '../src/node/spatial/HeadlessMeshSilhouetteRenderer';
import type { TriangleSoup } from '../src/node/3d-engine/part-connectivity';
import type { ToolContext } from '../src/node/gemini/tools/types';
import { boxToMeters, findOpenings, parseRegions } from '../src/node/3d-engine/blueprint-openings';
import { ObjectSegmenterService } from '../src/node/video/ObjectSegmenterService';
import { resolveRepoPython } from '../src/node/process/repo-python';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-blueprint-'));
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

type Box = [number, number, number, number, number, number]; // x0 x1 y0 y1 z0 z1

/** Body 4.0 m long and 1.8 m wide from 0.3 m to 1.0 m, a cabin from z -1.2 to 0.6 up to 1.5 m, four wheels 0.66 m tall. */
function carBoxes(cabinTop = 1.5): Box[] {
    const wheel = (x0: number, x1: number, zc: number): Box => [x0, x1, 0, 0.66, zc - 0.33, zc + 0.33];
    return [
        [-0.9, 0.9, 0.3, 1.0, -2.0, 2.0],
        [-0.7, 0.7, 0.99, cabinTop, -1.2, 0.6],
        wheel(0.7, 0.9, 1.3), wheel(-0.9, -0.7, 1.3), wheel(0.7, 0.9, -1.3), wheel(-0.9, -0.7, -1.3)
    ];
}
const SIZE: Vec3 = [1.8, 1.5, 4.0];

function soupOf(boxes: Box[]): TriangleSoup {
    const pos: number[] = [], idx: number[] = [];
    const faces = [[0, 1, 2, 3], [4, 5, 6, 7], [0, 1, 5, 4], [2, 3, 7, 6], [0, 3, 7, 4], [1, 2, 6, 5]];
    for (const [x0, x1, y0, y1, z0, z1] of boxes) {
        const b = pos.length / 3;
        pos.push(x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0, x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1);
        for (const [a, c, d, e] of faces) idx.push(b + a, b + c, b + d, b + a, b + d, b + e);
    }
    return { positions: new Float32Array(pos), indices: new Uint32Array(idx) };
}

function glbOf(soup: TriangleSoup): Buffer {
    const positions = Array.from(soup.positions), indices = Array.from(soup.indices);
    const pad = (b: Buffer, fill: number) => Buffer.concat([b, Buffer.alloc((4 - (b.length % 4)) % 4, fill)]);
    const pos = Buffer.from(new Float32Array(positions).buffer);
    const idx = Buffer.from(new Uint32Array(indices).buffer);
    const bin = pad(Buffer.concat([pos, idx]), 0);
    const min = [0, 1, 2].map(k => Math.min(...positions.filter((_, i) => i % 3 === k)));
    const max = [0, 1, 2].map(k => Math.max(...positions.filter((_, i) => i % 3 === k)));
    const json = pad(Buffer.from(JSON.stringify({
        asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0, name: 'car' }],
        meshes: [{ name: 'car', primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
        buffers: [{ byteLength: bin.length }],
        bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: pos.length }, { buffer: 0, byteOffset: pos.length, byteLength: idx.length }],
        accessors: [
            { bufferView: 0, componentType: 5126, count: positions.length / 3, type: 'VEC3', min, max },
            { bufferView: 1, componentType: 5125, count: indices.length, type: 'SCALAR' }
        ]
    })), 0x20);
    const header = Buffer.alloc(12);
    header.write('glTF', 0, 'ascii');
    header.writeUInt32LE(2, 4);
    header.writeUInt32LE(12 + 8 + json.length + 8 + bin.length, 8);
    const chunk = (data: Buffer, type: string) => { const h = Buffer.alloc(8); h.writeUInt32LE(data.length, 0); h.write(type, 4, 'ascii'); return Buffer.concat([h, data]); };
    return Buffer.concat([header, chunk(json, 'JSON'), chunk(bin, 'BIN\0')]);
}

const PX = 200; // pixels per metre
const MARGIN = 40;
const MAGENTA = [255, 0, 255];
const PAINT = [200, 30, 30];

/** An exact orthographic view of the boxes on magenta: side (front right), top (front right) or front. */
function viewOf(boxes: Box[], view: 'side' | 'top' | 'front', extra?: (rgba: Buffer, w: number, h: number) => void): { width: number; height: number; rgba: Buffer } {
    const [W, H, L] = SIZE;
    const across = view === 'front' ? W : L, up = view === 'top' ? W : H;
    const w = Math.round(across * PX) + 2 * MARGIN, h = Math.round(up * PX) + 2 * MARGIN;
    const rgba = Buffer.alloc(w * h * 4);
    for (let i = 0; i < w * h; i++) { rgba[i * 4] = MAGENTA[0]; rgba[i * 4 + 1] = MAGENTA[1]; rgba[i * 4 + 2] = MAGENTA[2]; rgba[i * 4 + 3] = 255; }
    for (const [x0, x1, y0, y1, z0, z1] of boxes) {
        const [u0, u1, v0, v1] = view === 'side' ? [z0 + L / 2, z1 + L / 2, y0, y1] : view === 'top' ? [z0 + L / 2, z1 + L / 2, x0 + W / 2, x1 + W / 2] : [x0 + W / 2, x1 + W / 2, y0, y1];
        for (let py = Math.round(h - MARGIN - v1 * PX); py < Math.round(h - MARGIN - v0 * PX); py++) {
            for (let px = Math.round(MARGIN + u0 * PX); px < Math.round(MARGIN + u1 * PX); px++) {
                const i = (py * w + px) * 4;
                rgba[i] = PAINT[0]; rgba[i + 1] = PAINT[1]; rgba[i + 2] = PAINT[2];
            }
        }
    }
    extra?.(rgba, w, h);
    return { width: w, height: h, rgba };
}

const near = (a: number, b: number, tol = 0.012) => Math.abs(a - b) <= tol;

describe('silhouettes', () => {
    it('removes only the background that touches the border, keeps enclosed background-coloured pixels, and drops specks', () => {
        const img = viewOf(carBoxes(), 'side', (rgba, w) => {
            // a magenta window inside the body (enclosed: stays object) and a red speck in the margin (not the object)
            for (let y = 120; y < 130; y++) for (let x = 300; x < 330; x++) { const i = (y * w + x) * 4; rgba[i] = 255; rgba[i + 1] = 0; rgba[i + 2] = 255; }
            for (let y = 5; y < 8; y++) for (let x = 5; x < 8; x++) { const i = (y * w + x) * 4; rgba[i] = 200; rgba[i + 1] = 30; rgba[i + 2] = 30; }
        });
        const s = silhouetteOf(img);
        expect(s.background).toEqual([255, 0, 255]);
        expect(s.box).toEqual({ x0: MARGIN, y0: MARGIN, x1: MARGIN + 4 * PX - 1, y1: MARGIN + 1.5 * PX - 1 });
        expect(s.mask[125 * s.width + 310]).toBe(1);
        expect(s.mask[6 * s.width + 6]).toBe(0);
    });

    it('drops a drawn ground line joining the tyres, so only the wheels touch the ground', () => {
        const img = viewOf(carBoxes(), 'side', (rgba, w, h) => {
            // a 3-pixel black line along the ground under the whole car, touching both wheels
            for (let py = h - MARGIN - 1; py < h - MARGIN + 2; py++) for (let px = MARGIN - 10; px < w - MARGIN + 10; px++) { const i = (py * w + px) * 4; rgba[i] = 10; rgba[i + 1] = 10; rgba[i + 2] = 10; }
        });
        const s = silhouetteOf(img);
        expect(s.box.x0).toBe(MARGIN);                       // the line's ends past the car are gone
        const outlines = outlinesFromSilhouettes({ side: s, top: silhouetteOf(viewOf(carBoxes(), 'top')), front: silhouetteOf(viewOf(carBoxes(), 'front')) }, SIZE);
        expect(outlines.groundContacts.map(c => c.zCentre)).toEqual([1.3, -1.3]);
    });

    it('fails on a view with no object', () => {
        const blank = { width: 10, height: 10, rgba: Buffer.alloc(400, 255) };
        expect(() => silhouetteOf(blank)).toThrow(/no object/);
    });
});

describe('outlines', () => {
    const boxes = carBoxes();
    const silhouettes = { side: silhouetteOf(viewOf(boxes, 'side')), top: silhouetteOf(viewOf(boxes, 'top')), front: silhouetteOf(viewOf(boxes, 'front')) };
    const drawn = outlinesFromSilhouettes(silhouettes, SIZE);
    const cut = outlinesFromTriangles(soupOf(boxes), drawn);

    it('reads the side, plan and front outlines of the views in metres in the build frame', () => {
        const at = (z: number) => drawn.side.find(s => near(s.z, z, 0.001))!;
        expect(drawn.side).toHaveLength(81);
        expect(at(2).top).toBeCloseTo(1.0, 1);
        expect(near(at(0).top, 1.5)).toBe(true);           // the cabin
        expect(near(at(1.5).top, 1.0)).toBe(true);         // the bonnet ahead of the cabin
        expect(near(at(1.3).bottom, 0)).toBe(true);        // a wheel
        expect(near(at(0).bottom, 0.3)).toBe(true);        // the sill between the wheels
        expect(drawn.plan.every(s => near(s.halfWidth, 0.9))).toBe(true);
        const front = (y: number) => drawn.front.find(s => near(s.y, y, 0.001))!;
        expect(near(front(1.2).halfWidth, 0.7)).toBe(true);
        expect(near(front(0.6).halfWidth, 0.9)).toBe(true);
        expect(drawn.groundContacts.map(c => c.zCentre)).toEqual([1.3, -1.3]);
        expect(aspectErrors(silhouettes, SIZE)).toEqual({ side: 0, top: 0, front: 0 });
    });

    it('cuts the same outlines from the triangles, at the blueprint\'s stations', () => {
        expect(cut.sizeMeters).toEqual(SIZE);
        expect(cut.side.map(s => s.z)).toEqual(drawn.side.map(s => s.z));
        const c = compareOutlines(drawn, cut);
        expect(c.differences).toEqual([]);
        expect(Math.max(...Object.values(c.meanAbsMeters))).toBeLessThan(0.01);
        expect(cut.groundContacts.map(g => g.zCentre)).toEqual([1.3, -1.3]);
    });

    it('lists where a build differs: a cabin 0.12 m low over its length, and nothing else', () => {
        const low = outlinesFromTriangles(soupOf(carBoxes(1.38)), drawn);
        const c = compareOutlines(drawn, low);
        expect(c.differences).toHaveLength(2); // the side top line, and the front half width at the heights it no longer reaches
        const top = c.differences.find(d => d.outline === 'side top')!;
        expect(top.worstMeters).toBeCloseTo(-0.12, 2);
        expect(top.from).toBeCloseTo(0.6, 1);
        expect(top.to).toBeCloseTo(-1.2, 1);
        const front = c.differences.find(d => d.outline === 'front half width')!;
        expect([front.from, front.to, front.worstMeters]).toEqual([1.425, 1.5, -0.7]); // the cabin's top, missing
        expect(describeDifferences(c)).toContainEqual(expect.stringMatching(/^side top, z 0\.6 to -1\.2 m: the build is 0\.120 m lower than the blueprint/));
    });

    it('writes the outlines as notes the spec reader can follow', () => {
        const notes = outlinesAsNotes(drawn);
        expect(notes).toContain('scaled to 1.8 x 1.5 x 4 m');
        expect(notes).toMatch(/side, z: top\/bottom: 2: 1\/0\.3/);
        expect(notes).toContain('ground contacts along z (from/to, centre):');
    });
});

describe('object_blueprint_outlines', () => {
    const boxes = carBoxes();
    const png = (view: 'side' | 'top' | 'front') => { const v = viewOf(boxes, view); return HeadlessMeshSilhouetteRenderer.encodePng(v.width, v.height, v.rgba).toString('base64'); };
    const prompts: string[] = [];
    const client = {
        models: {
            generateContent: async (params: any) => {
                const text = params.contents[0].parts.map((p: any) => p.text || '').join('');
                prompts.push(text);
                const view = /side elevation/.test(text) ? 'side' : /plan view/.test(text) ? 'top' : 'front';
                return { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: png(view) } }] }, finishReason: 'STOP' }], modelVersion: params.model } as any;
            }
        }
    };
    const publicDir = path.join(TMP, 'public');
    fs.mkdirSync(path.join(publicDir, 'models'), { recursive: true });
    const run = createBlueprintOutlineHandlers({ client: async () => client as any, publicDir, sleep: async () => undefined }).object_blueprint_outlines;
    const ctx = { workspaceRoot: TMP, request: { prompt: 'x' } } as unknown as ToolContext;

    it('is declared with its two modes', () => {
        const d = BLUEPRINT_OUTLINE_TOOL_DECLARATIONS[0];
        expect(d.name).toBe('object_blueprint_outlines');
        expect(Object.keys((d.parameters as any).properties)).toEqual(['subject', 'sizeMeters', 'blueprintPath', 'compareGlbPath', 'model', 'openings']);
    });

    let blueprintPath = '';
    it('draws the side view, then the top and front views shown it, and saves the views, overlays and outlines', async () => {
        const out = await run({ subject: 'a red test car', sizeMeters: SIZE }, ctx);
        expect(out.status, String(out.resultPayload.error)).not.toBe('failed');
        expect(prompts).toHaveLength(3);
        expect(prompts[0]).toMatch(/side elevation of: a red test car[\s\S]*front faces RIGHT/);
        const p = out.resultPayload as any;
        blueprintPath = p.blueprintPath;
        for (const f of Object.values(p.files) as string[]) expect(fs.existsSync(path.join(TMP, f))).toBe(true);
        expect(fs.readFileSync(path.join(TMP, p.files.sideOverlay)).subarray(1, 4).toString()).toBe('PNG');
        const saved = JSON.parse(fs.readFileSync(path.join(TMP, blueprintPath), 'utf8'));
        expect(saved.provenance.label).toBe('generated');
        expect(saved.outlines.groundContacts.map((c: any) => c.zCentre)).toEqual([1.3, -1.3]);
        expect(p.aspectError).toEqual({ side: 0, top: 0, front: 0 });
        expect(p.notesText).toContain('Blueprint outlines');
        expect(out.summaryResult).toContain('Touches the ground at z 1.3, -1.3 m, the outermost contacts 2.600 m apart');
    });

    it('compares a built model with the blueprint, with no image call', async () => {
        const before = prompts.length;
        fs.writeFileSync(path.join(publicDir, 'models', 'same.glb'), glbOf(soupOf(boxes)));
        fs.writeFileSync(path.join(publicDir, 'models', 'low.glb'), glbOf(soupOf(carBoxes(1.38))));
        const same = await run({ blueprintPath, compareGlbPath: '/models/same.glb' }, ctx);
        expect(same.summaryResult).toMatch(/matches its blueprint/);
        const low = await run({ blueprintPath, compareGlbPath: '/models/low.glb' }, ctx);
        expect((low.resultPayload as any).differences).toContainEqual(expect.stringMatching(/^side top, z 0\.6 to -1\.2 m: the build is 0\.120 m lower/));
        expect(prompts.length).toBe(before);
    });

    it('refuses incomplete or invalid calls', async () => {
        expect((await run({}, ctx)).resultPayload.error).toMatch(/needs subject and sizeMeters/);
        expect((await run({ subject: 'x', sizeMeters: [1, 2] }, ctx)).resultPayload.error).toMatch(/three positive numbers/);
        expect((await run({ blueprintPath }, ctx)).resultPayload.error).toMatch(/pass both blueprintPath and compareGlbPath/);
        expect((await run({ blueprintPath, compareGlbPath: '/models/missing.glb' }, ctx)).resultPayload.error).toMatch(/No model at/);
        expect((await run({ blueprintPath, compareGlbPath: '../../etc/passwd' }, ctx)).resultPayload.error).toMatch(/No model at/);
    });
});

export type { ObjectOutlines };

describe('openings read from the drawings', () => {
    const front = viewOf(carBoxes(), 'front', (rgba, w, h) => {
        // a dark intake 0.8 m wide and 0.2 m tall, centred, 0.35-0.55 m up the front
        for (let py = Math.round(h - MARGIN - 0.55 * PX); py < Math.round(h - MARGIN - 0.35 * PX); py++) {
            for (let px = Math.round(MARGIN + 0.5 * PX); px < Math.round(MARGIN + 1.3 * PX); px++) { const i = (py * w + px) * 4; rgba[i] = 20; rgba[i + 1] = 20; rgba[i + 2] = 22; }
        }
    });
    const side = viewOf(carBoxes(), 'side');
    const sFront = silhouetteOf(front), sSide = silhouetteOf(side);

    it('parses only well-formed regions', () => {
        const regions = parseRegions('noise {"regions": [{"view": "front", "label": "intake", "box": [0.2, 0.5, 0.8, 0.6]}, {"view": "top", "label": "x", "box": [0, 0, 1, 1]}, {"view": "side", "label": "y", "box": [0.5, 0.5, 0.4, 0.6]}]} tail');
        expect(regions).toEqual([{ view: 'front', label: 'intake', box: [0.2, 0.5, 0.8, 0.6] }]);
        expect(parseRegions('not json')).toEqual([]);
    });

    it('maps a box to metres: x mirrored in the front view (the object\'s right is the viewer\'s left), z forward in the side view', () => {
        const nx = (m: number) => (MARGIN + (m + 0.9) * PX) / front.width, ny = (m: number) => (front.height - MARGIN - m * PX) / front.height;
        // a box over the viewer's left half of the intake: the object's right, +X
        const m = boxToMeters('front', [nx(-0.4), ny(0.55), nx(0), ny(0.35)], sFront, SIZE);
        expect(m.across[0]).toBeCloseTo(0, 2);
        expect(m.across[1]).toBeCloseTo(0.4, 2);
        expect(m.height[0]).toBeCloseTo(0.35, 2);
        expect(m.height[1]).toBeCloseTo(0.55, 2);
        const zx = (z: number) => (MARGIN + (z + 2) * PX) / side.width, zy = (y: number) => (side.height - MARGIN - y * PX) / side.height;
        const s = boxToMeters('side', [zx(0.6), zy(1.4), zx(1.0), zy(1.1)], sSide, SIZE);
        expect(s.across).toEqual([0.6, 1]);
        expect(s.height[0]).toBeCloseTo(1.1, 2);
    });

    it('boxes regions with the vision model, traces them, and keeps an untraced box with its reason', async () => {
        const client = { models: { generateContent: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify({ regions: [
            { view: 'front', label: 'lower intake', box: [0.1, 0.4, 0.9, 0.7] },
            { view: 'side', label: 'side glass', box: [0.4, 0.1, 0.6, 0.3] }
        ] }) }] } }], modelVersion: 'stand-in' }) } } as any;
        const views = { front: { image: { data: Buffer.alloc(0), mimeType: 'image/png' }, path: '/front.png', silhouette: sFront }, side: { image: { data: Buffer.alloc(0), mimeType: 'image/png' }, path: '/side.png', silhouette: sSide } };
        const found = await findOpenings(client, 'a test car', views, SIZE, {
            // the stand-in segmenter traces the front view's dark rectangle exactly and cannot trace the side view
            segment: async (imagePath) => {
                if (imagePath === '/side.png') throw new Error('empty mask');
                return [(MARGIN + 0.5 * PX) / front.width, (front.height - MARGIN - 0.55 * PX) / front.height, (MARGIN + 1.3 * PX) / front.width, (front.height - MARGIN - 0.35 * PX) / front.height];
            }
        });
        expect(found.model).toBe('stand-in');
        const [intake, glass] = found.openings;
        expect(intake).toMatchObject({ view: 'front', label: 'lower intake', traced: true, provenance: 'generated' });
        expect(intake.across[0]).toBeCloseTo(-0.4, 2);
        expect(intake.across[1]).toBeCloseTo(0.4, 2);
        expect(intake.height[0]).toBeCloseTo(0.35, 2);
        expect(glass).toMatchObject({ view: 'side', traced: false, note: expect.stringMatching(/not traced \(empty mask\)/) });
    });

    let python: string | undefined;
    try { python = resolveRepoPython({ modules: ['numpy', 'cv2', 'mediapipe'] }); } catch { python = undefined; }
    it.skipIf(!python)('traces a drawn intake with the real object segmenter (the project\'s Python: numpy, cv2, mediapipe)', async () => {
        const file = path.join(TMP, 'front_intake.png');
        fs.writeFileSync(file, HeadlessMeshSilhouetteRenderer.encodePng(front.width, front.height, front.rgba));
        const box: [number, number, number, number] = [(MARGIN + 0.4 * PX) / front.width, (front.height - MARGIN - 0.6 * PX) / front.height, (MARGIN + 1.4 * PX) / front.width, (front.height - MARGIN - 0.3 * PX) / front.height];
        const out = await new ObjectSegmenterService().segment({ imagePath: file, outputDir: path.join(TMP, 'seg'), box, refine: true });
        const traced = boxToMeters('front', out.frames[0].bbox, sFront, SIZE);
        expect(Math.abs(traced.across[0] + 0.4)).toBeLessThan(0.05);
        expect(Math.abs(traced.across[1] - 0.4)).toBeLessThan(0.05);
        expect(Math.abs(traced.height[0] - 0.35)).toBeLessThan(0.05);
        expect(Math.abs(traced.height[1] - 0.55)).toBeLessThan(0.05);
    }, 180_000);
});
