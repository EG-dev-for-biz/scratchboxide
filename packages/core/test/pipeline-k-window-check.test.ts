/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The window check (pipeline-k/window-check.ts): the window array records every empty site it judged with its evidence
 * and decision; the check draws the sites nearest their cut-off from an earlier build's orthos with one sure window and one
 * sure wall, crops them with the site outlined, and stores the answers as labels joined to that evidence, trusted only
 * when both controls were answered right.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { encodePng } from '../src/node/3d-engine/staged-location/png-encode';
import { decodePng } from '../src/node/texture-processing';
import { inferWindowArrays, SITE_DECISION, SITE_EVIDENCE_FIELDS, SITE_KIND, type ArrayRecord } from '../src/node/3d-engine/staged-location/pipeline-k/window-array';
import { answeredKeys, checkSitesOf, findWindowCheckSources, WINDOW_LABELS_FILE, WindowCheckService } from '../src/node/3d-engine/staged-location/pipeline-k/window-check';
import { WINDOW_FIT_PARAMS, WINDOW_FIT_VERSION, type WindowFitFile, type WindowRect } from '../src/node/3d-engine/staged-location/window-fit';

const PX = 0.1, W = 300, H = 600, COL = 30, ROW = 40, BW = 12, BH = 20;
const site = (i: number, j: number): WindowRect => { const cx = COL / 2 + i * COL, cy = ROW / 2 + j * ROW; return [cx - BW / 2, cy - BH / 2, cx + BW / 2, cy + BH / 2]; };
const frame = (id: number) => ({ facadeId: id, image: `facade_${id}.png`, width: W, height: H, pixel: PX, coverage: 1, orthoSMin: 0, orthoTMax: H * PX / 2, texel: PX, centroid: [0, H * PX / 2, 0], normal: [0, 0, -1], axisT: [0, 1, 0], tMin: -H * PX / 2, tMax: H * PX / 2 });
function facadePhoto(windows: Array<{ r: WindowRect; grey: number }>): Uint8Array {
    const rgba = new Uint8Array(W * H * 4);
    for (let k = 0; k < W * H; k++) rgba.set([200, 200, 200, 255], k * 4);
    for (const { r: [x0, y0, x1, y1], grey } of windows) for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) rgba.set([grey, grey, grey], (y * W + x) * 4);
    return rgba;
}
function orthoDir(root: string, windows: Array<{ r: WindowRect; grey: number }>, fit: WindowFitFile): string {
    const dir = path.join(root, 'tile_refine', 'abc', 'relief_orthos_k_test');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'facade_1.png'), encodePng(W, H, facadePhoto(windows), 4));
    fs.writeFileSync(path.join(dir, 'facades.json'), JSON.stringify({ facades: [frame(1)] }));
    fs.writeFileSync(path.join(dir, 'window_fit.json'), JSON.stringify(fit));
    return dir;
}
const nF = SITE_EVIDENCE_FIELDS.length;

describe('the window check', () => {
    it('the window array records every empty site it judged, with its evidence and its decision', () => {
        // ten columns of windows, 15 storeys, two boxes in three read: the empty sites inside the array are added
        const truth: WindowRect[] = []; for (let j = 0; j < 15; j++) for (let i = 0; i < 10; i++) truth.push(site(i, j));
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'window-check-'));
        const fit: WindowFitFile = { version: WINDOW_FIT_VERSION, params: WINDOW_FIT_PARAMS, ms: 0, facades: [{ facadeId: 1, width: W, height: H, rects: truth.filter((_, k) => k % 3 !== 0), panes: [], bands: [], ms: 0 }] };
        const dir = orthoDir(root, truth.map(r => ({ r, grey: 40 })), fit);
        const rep = inferWindowArrays(dir, fit);
        expect(rep.facades[0].reason).toBeUndefined();
        const a = (JSON.parse(fs.readFileSync(path.join(dir, 'window_fit.json'), 'utf8')) as WindowFitFile).facades[0] as { array: ArrayRecord };
        const ev = a.array.evidence!;
        expect(ev.length % nF).toBe(0);
        const rows = Array.from({ length: ev.length / nF }, (_, k) => ev.slice(k * nF, (k + 1) * nF));
        // every site the array added is recorded as added, with a contrast showing the window and the photo covering it
        const added = rows.filter(r => r[4] === SITE_DECISION.added);
        expect(added).toHaveLength(rep.facades[0].added);
        expect(added.length).toBe(50);
        for (const r of added) { expect(r[5]).toBeGreaterThan(0.5); expect(r[6]).toBe(1); expect(r[7]).toBe(0); }
        fs.rmSync(root, { recursive: true, force: true });
    });

    it('draws the sites nearest their cut-off with a sure window and a sure wall, crops them outlined, and stores trusted labels', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'window-check-'));
        // a box kept on its site (a sure window), eight sites added on dim evidence (uncertain), one site reading clearly
        // the opposite of a window outside the array (a sure wall), and one site the photo barely covers (never asked)
        const ev: Array<number | null> = [];
        for (let k = 0; k < 8; k++) ev.push(...site(k + 1, 3), SITE_DECISION.added, 0.05 * k, 1, 0, 0.6, 0.6, 0.5, 0.5);
        ev.push(...site(2, 10), SITE_DECISION.outside, -0.9, 1, 0, -0.1, 0.0, 0, 0);
        ev.push(...site(5, 12), SITE_DECISION.added, 0.1, 0.3, 0, 0.6, 0.6, 0.5, 0.5);
        const array: ArrayRecord = { version: 'test', in: { rects: [site(0, 3)] }, report: { boxesIn: 1, spans: 0, on: 1, snapped: 0, replaced: 0, added: 8, rejected: 0 }, sites: [...site(0, 3), SITE_KIND.on, 0.95, 0], evidence: ev };
        const fit = { version: WINDOW_FIT_VERSION, params: WINDOW_FIT_PARAMS, ms: 0, facades: [{ facadeId: 1, width: W, height: H, rects: [site(0, 3)], panes: [], bands: [], ms: 0, array }] } as unknown as WindowFitFile;
        const dir = orthoDir(root, [{ r: site(0, 3), grey: 40 }, ...Array.from({ length: 8 }, (_, k) => ({ r: site(k + 1, 3), grey: 150 }))], fit);
        expect(findWindowCheckSources([root])).toEqual([dir]);
        const sites = checkSitesOf(dir);
        expect(sites.filter(s => s.role === 'uncertain')).toHaveLength(8);
        expect(sites.filter(s => s.role === 'window')).toHaveLength(1);
        expect(sites.filter(s => s.role === 'wall')).toHaveLength(1);

        const labels = path.join(root, 'labels');
        const svc = new WindowCheckService(() => [dir], labels);
        const { check } = svc.next(7);
        expect(check!.tiles).toHaveLength(9);
        for (const t of check!.tiles) {
            const png = Buffer.from(t.png, 'base64');
            expect([...png.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
            const img = decodePng(png);
            expect(img.width).toBe(200);
            // the outline is drawn in yellow
            let yellow = 0; for (let k = 0; k < img.width * img.height; k++) if (img.rgba[k * 4] === 255 && img.rgba[k * 4 + 1] === 214 && img.rgba[k * 4 + 2] === 0) yellow++;
            expect(yellow).toBeGreaterThan(100);
        }
        const roles = svc.inspect(check!.id)!;
        expect(roles.filter(x => x.role === 'uncertain')).toHaveLength(7);
        const windowTile = check!.tiles.find(t => roles.find(x => x.tileId === t.id)!.role === 'window')!;
        const dim = check!.tiles.filter(t => roles.find(x => x.tileId === t.id)!.role === 'uncertain');
        // the sure window is the kept box (row 3, column 0)
        expect(roles.find(x => x.role === 'window')!.box).toEqual(site(0, 3));
        // contrasts 0, 0.05 ... 0.35 under the 0.5 add bar: the seven nearest it are columns 2 to 8 (column 1, contrast 0, is farthest)
        expect(roles.filter(x => x.role === 'uncertain').map(x => x.box[0]).sort((a, b) => a - b)).toEqual([2, 3, 4, 5, 6, 7, 8].map(i => site(i, 3)[0]));
        // answered right: the window and four of the dim sites marked
        const r = svc.answer(check!.id, [windowTile.id, ...dim.slice(0, 4).map(t => t.id)]);
        expect(r).toEqual({ stored: 7, controlsPassed: true });
        const lines = fs.readFileSync(path.join(labels, WINDOW_LABELS_FILE), 'utf8').trim().split('\n').map(l => JSON.parse(l));
        expect(lines).toHaveLength(7);
        expect(lines.filter(l => l.window)).toHaveLength(4);
        for (const l of lines) { expect(l.trusted).toBe(true); expect(l.evidence).toHaveLength(nF); expect(l.fields).toEqual([...SITE_EVIDENCE_FIELDS]); }
        expect(answeredKeys(labels).size).toBe(7);
        expect(() => svc.answer(check!.id, [])).toThrow(/not known/);
        // seven of the eight uncertain sites answered: too few left for a check
        expect(svc.next(8).reason).toMatch(/unanswered uncertain sites/);
        fs.rmSync(root, { recursive: true, force: true });
    });

    it('keeps the answers of a check that misses a control aside as untrusted, and stores nothing for a skipped one', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'window-check-'));
        const ev: Array<number | null> = [];
        for (let k = 0; k < 9; k++) ev.push(...site(k, 5), SITE_DECISION.outside, 0.35 + 0.01 * k, 1, 0, 0.2, 0.2, 0, 0);
        ev.push(...site(3, 11), SITE_DECISION.outside, -0.8, 1, 0, 0, 0, 0, 0);
        const array: ArrayRecord = { version: 'test', in: { rects: [site(4, 1)] }, report: { boxesIn: 1, spans: 0, on: 1, snapped: 0, replaced: 0, added: 0, rejected: 0 }, sites: [...site(4, 1), SITE_KIND.on, 0.9, 0], evidence: ev };
        const fit = { version: WINDOW_FIT_VERSION, params: WINDOW_FIT_PARAMS, ms: 0, facades: [{ facadeId: 1, width: W, height: H, rects: [site(4, 1)], panes: [], bands: [], ms: 0, array }] } as unknown as WindowFitFile;
        const dir = orthoDir(root, [{ r: site(4, 1), grey: 40 }], fit);
        const labels = path.join(root, 'labels');
        const svc = new WindowCheckService(() => [dir], labels);
        const skipped = svc.next(1).check!;
        expect(svc.answer(skipped.id, [], true)).toEqual({ stored: 0, controlsPassed: false });
        expect(fs.existsSync(path.join(labels, WINDOW_LABELS_FILE))).toBe(false);
        // everything marked a window, the sure wall too: stored, but untrusted
        const c = svc.next(2).check!;
        expect(svc.answer(c.id, c.tiles.map(t => t.id))).toEqual({ stored: 7, controlsPassed: false });
        const lines = fs.readFileSync(path.join(labels, WINDOW_LABELS_FILE), 'utf8').trim().split('\n').map(l => JSON.parse(l));
        expect(lines.every(l => l.trusted === false && l.window === true)).toBe(true);
        fs.rmSync(root, { recursive: true, force: true });
    });
});
