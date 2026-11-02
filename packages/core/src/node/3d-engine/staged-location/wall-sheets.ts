/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * One sheet per wall (pipeline K's whole-wall rebuild). A wall the wall grammar read from several facades (planes
 * tile_refine fitted to one physical wall, overlapping and a few decimetres apart) is rebuilt once, on one plane, instead of
 * once per facade (sheets stacked on one another, each one's edges and reveals poking through the others):
 * 1. the sheet's frame: the wall's largest facade's plane and axes, its extent every member's;
 * 2. its photo: a mosaic at the finest member's texel, each texel from the member photos that reached it (the member
 *    covering most of its own wall first), the rest filled from the sheet's own repeats (ortho-rectify.ts fillHoles,
 *    generated) and marked uncovered beside it, as a facade's holes are;
 * 3. its windows and panes: every member's fitted ones carried onto the sheet (one kept where two land on each other);
 *    its bays: the wall grammar's, in the sheet's frame.
 * Written as wall_<id>.png, wall_<id>_uncovered.png and walls.json beside the orthos; the lattice rebuilds a sheet in place
 * of its members (facade-lattice.ts rebuildFacadesOnLattice).
 */

import * as fs from 'fs';
import * as path from 'path';
import type { ReliefFacade } from './facade-lattice';
import { wallCoverage } from './facade-lattice';
import { encodePng } from './png-encode';
import { readOccluded } from './pipeline-k/occlusion';
import { fillHoles, occludedMaskName, smoothFillHoles } from './pipeline-k/ortho-rectify';
import type { WallGrammarFile } from './wall-grammar';
import type { WindowFitFile, WindowRect } from './window-fit';

export const WALL_SHEETS_VERSION = 'wall-sheets/2';
export const WALLS_FILE = 'walls.json';
/** A sheet's facade id: its wall's id past every facade id tile_refine writes. */
export const SHEET_ID_BASE = 10000;

export interface WallSheet {
    wallId: number; members: number[];
    /** The sheet as a facade of its own (its photo the mosaic, its id SHEET_ID_BASE + wallId). */
    facade: ReliefFacade;
    /** The members' fitted windows and panes on the sheet's photo (pixels), and the wall grammar's bays in its frame ([s0, t0, s1, t1]). */
    windows: WindowRect[]; panes: WindowRect[]; bays: Array<[number, number, number, number]>;
}
export interface WallSheetsFile { version: string; sheets: WallSheet[] }

const dot = (a: ArrayLike<number>, b: ArrayLike<number>) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
type Img = { rgba: Uint8Array; width: number; height: number };

/** A member's photo-pixel position of a world point, through its plane frame. */
const toPx = (f: ReliefFacade, p: number[]): [number, number] => {
    const q = [p[0] - f.centroid[0], p[1] - f.centroid[1], p[2] - f.centroid[2]];
    return [(dot(q, f.axisS) - f.orthoSMin) / f.pixel, (f.orthoTMax - dot(q, f.axisT)) / f.pixel];
};
const world = (f: ReliefFacade, s: number, t: number) => [0, 1, 2].map(k => f.centroid[k] + s * f.axisS[k] + t * f.axisT[k]);

/** Every multi-facade wall of the grammar as one sheet (see the file comment); writes the sheets beside the orthos. */
export function buildWallSheets(orthosDir: string, grammar: WallGrammarFile, fit: WindowFitFile | undefined, decode: (b: Buffer) => Img): { file: string; sheets: WallSheet[] } {
    const facades = JSON.parse(fs.readFileSync(path.join(orthosDir, 'facades.json'), 'utf8')).facades as ReliefFacade[];
    const byId = new Map(facades.map(f => [f.facadeId, f]));
    const fitOf = new Map<number, { rects: WindowRect[]; panes: WindowRect[] }>();
    for (const e of fit?.facades ?? []) if (!('error' in e)) fitOf.set(e.facadeId, { rects: e.rects, panes: e.panes ?? [] });
    const sheets: WallSheet[] = [];
    for (const w of grammar.walls) {
        const members = w.facades.map(id => byId.get(id)).filter((f): f is ReliefFacade => !!f && fs.existsSync(path.join(orthosDir, f.image)));
        if (members.length < 2) continue;
        // the frame: the largest member's plane and axes; the extent every member's corners
        const ref = members.reduce((m, f) => ((f.sMax - f.sMin) * (f.tMax - f.tMin) > (m.sMax - m.sMin) * (m.tMax - m.tMin) ? f : m));
        const c = ref.centroid, S = ref.axisS, T = ref.axisT, px = Math.min(...members.map(f => f.pixel));
        const st = members.flatMap(f => [[f.sMin, f.tMin], [f.sMax, f.tMin], [f.sMin, f.tMax], [f.sMax, f.tMax]].map(([s, t]) => { const p = world(f, s, t), q = [p[0] - c[0], p[1] - c[1], p[2] - c[2]]; return [dot(q, S), dot(q, T)]; }));
        const sMin = Math.min(...st.map(v => v[0])), sMax = Math.max(...st.map(v => v[0])), tMin = Math.min(...st.map(v => v[1])), tMax = Math.max(...st.map(v => v[1]));
        const W = Math.max(1, Math.ceil((sMax - sMin) / px)), H = Math.max(1, Math.ceil((tMax - tMin) / px));
        // the members, the one covering most of its own wall first, each with its photo, its mask and its affine map from the sheet's pixels
        const ms = members.map(f => {
            const img = decode(fs.readFileSync(path.join(orthosDir, f.image)));
            const mf = f.uncoveredMask ? path.join(orthosDir, f.uncoveredMask) : undefined;
            const unc = mf && fs.existsSync(mf) ? (() => { const m = decode(fs.readFileSync(mf)); return Uint8Array.from({ length: m.width * m.height }, (_, k) => (m.rgba[k * 4] >= 128 ? 1 : 0)); })()
                : Uint8Array.from({ length: img.width * img.height }, (_, k) => (img.rgba[k * 4 + 3] === 0 || (img.rgba[k * 4] === 128 && img.rgba[k * 4 + 1] === 128 && img.rgba[k * 4 + 2] === 128) ? 1 : 0));
            // what stood in front of this member when it was photographed (pipeline-k/occlusion.ts)
            const occ = readOccluded(orthosDir, f, img.width, img.height, decode);
            // sheet pixel (x, y) -> member pixel: affine in x and y
            const o = toPx(f, world(ref, sMin + 0.5 * px, tMax - 0.5 * px)), ox = toPx(f, world(ref, sMin + 1.5 * px, tMax - 0.5 * px)), oy = toPx(f, world(ref, sMin + 0.5 * px, tMax - 1.5 * px));
            return { f, img, unc, occ, o, dx: [ox[0] - o[0], ox[1] - o[1]], dy: [oy[0] - o[0], oy[1] - o[1]], rank: f.wallCoverage ?? f.coverage };
        }).sort((a, b) => b.rank - a.rank);
        const rgba = new Uint8Array(W * H * 4), uncovered = new Uint8Array(W * H).fill(1), occluded = new Uint8Array(W * H);
        const anyOcc = ms.some(m => m.occ);
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
            const k = y * W + x;
            // a member that saw the texel clear first; one with something in front of it only when no other saw it
            for (let pass = 0; pass < (anyOcc ? 2 : 1) && uncovered[k]; pass++) for (const m of ms) {
                const mx = Math.floor(m.o[0] + x * m.dx[0] + y * m.dy[0]), my = Math.floor(m.o[1] + x * m.dx[1] + y * m.dy[1]);
                if (mx < 0 || my < 0 || mx >= m.img.width || my >= m.img.height) continue;
                const j = my * m.img.width + mx;
                if (m.unc[j] || !m.img.rgba[j * 4 + 3]) continue;
                const blocked = !!m.occ?.[j];
                if (pass === 0 && blocked) continue;
                rgba.set(m.img.rgba.subarray(j * 4, j * 4 + 3), k * 4);
                // a real texel exactly the uncovered grey would read as a hole
                if (rgba[k * 4] === 128 && rgba[k * 4 + 1] === 128 && rgba[k * 4 + 2] === 128) rgba[k * 4 + 2] = 129;
                rgba[k * 4 + 3] = 255; uncovered[k] = 0; occluded[k] = blocked ? 1 : 0;
                break;
            }
            if (uncovered[k]) rgba.set([128, 128, 128, 255], k * 4);
        }
        const cov = wallCoverage({ rgba, width: W, height: H }, px);
        // the sheet's own repeats, then a smooth fill for what they leave (the nearest texel copied across draws streaks)
        const filled = fillHoles({ width: W, height: H, rgba }, px, undefined, { nearest: false });
        const out = filled.image.rgba;
        const left = Uint8Array.from({ length: W * H }, (_, k) => (uncovered[k] && out[k * 4] === 128 && out[k * 4 + 1] === 128 && out[k * 4 + 2] === 128 ? 1 : 0));
        const smooth = smoothFillHoles(filled.image, left);
        const holes = uncovered.reduce((a, v) => a + v, 0);
        const id = SHEET_ID_BASE + w.wallId, image = `wall_${w.wallId}.png`, mask = `wall_${w.wallId}_uncovered.png`;
        fs.writeFileSync(path.join(orthosDir, image), encodePng(W, H, Buffer.from(filled.image.rgba), 4));
        fs.writeFileSync(path.join(orthosDir, mask), encodePng(W, H, Buffer.from(uncovered.map(v => (v ? 255 : 0))), 1));
        const occMask = occluded.some(v => v) ? occludedMaskName(image) : undefined;
        if (occMask) fs.writeFileSync(path.join(orthosDir, occMask), encodePng(W, H, Buffer.from(occluded.map(v => (v ? 255 : 0))), 1));
        const facade: ReliefFacade = {
            facadeId: id, image, centroid: c, normal: ref.normal, axisS: S, axisT: T, sMin, sMax, tMin, tMax, pixel: px, width: W, height: H, orthoSMin: sMin, orthoTMax: tMax,
            coverage: 1 - holes / (W * H), uncoveredMask: mask, ...(occMask ? { occludedMask: occMask } : {}), wallCoverage: Math.round(cov.wallCoverage * 1000) / 1000, wallAreaM2: Math.round(cov.wallAreaM2),
            textureFill: { label: 'generated', texels: holes, share: Math.round((holes / (W * H)) * 1e4) / 1e4, method: `the wall's ${members.length} facade photos laid on one sheet, the member covering most of its own wall first; its ${holes} texels no photo reached filled from the sheet's own repeats (${filled.fill.fromRepeats} at its bay pitch, ${filled.fill.fromStoreys} at its storey pitch), ${smooth} by a smooth fill between the colours at the holes' edges` }
        };
        // the members' windows and panes carried onto the sheet
        const carry = (rects: Array<{ f: ReliefFacade; r: WindowRect }>): WindowRect[] => {
            const out: WindowRect[] = [];
            for (const { f, r } of rects) {
                const a = toPx(facade, world(f, f.orthoSMin + r[0] * f.pixel, f.orthoTMax - r[1] * f.pixel)), b = toPx(facade, world(f, f.orthoSMin + r[2] * f.pixel, f.orthoTMax - r[3] * f.pixel));
                const q: WindowRect = [Math.round(Math.min(a[0], b[0])), Math.round(Math.min(a[1], b[1])), Math.round(Math.max(a[0], b[0])), Math.round(Math.max(a[1], b[1]))];
                if (q[2] <= 0 || q[3] <= 0 || q[0] >= W || q[1] >= H) continue;
                const area = (q[2] - q[0]) * (q[3] - q[1]);
                if (out.some(o => Math.max(0, Math.min(o[2], q[2]) - Math.max(o[0], q[0])) * Math.max(0, Math.min(o[3], q[3]) - Math.max(o[1], q[1])) > 0.5 * area)) continue;
                out.push(q);
            }
            return out;
        };
        const windows = carry(members.flatMap(f => (fitOf.get(f.facadeId)?.rects ?? []).map(r => ({ f, r }))));
        const panes = carry(members.flatMap(f => (fitOf.get(f.facadeId)?.panes ?? []).map(r => ({ f, r }))));
        // the grammar's bays (u along the wall's axis, y up) in the sheet's frame
        const cu = dot(c, w.axisU), su = dot(S, w.axisU);
        const bays = w.bays.map(b => {
            const s0 = (b.u0 - cu) / su, s1 = (b.u1 - cu) / su, t0 = (b.y0 - c[1]) / T[1], t1 = (b.y1 - c[1]) / T[1];
            return [Math.min(s0, s1), Math.min(t0, t1), Math.max(s0, s1), Math.max(t0, t1)] as [number, number, number, number];
        }).filter(b => b[2] - b[0] >= 0.5 && b[3] - b[1] >= 1);
        sheets.push({ wallId: w.wallId, members: members.map(f => f.facadeId), facade, windows, panes, bays });
    }
    const file = path.join(orthosDir, WALLS_FILE);
    fs.writeFileSync(file, JSON.stringify({ version: WALL_SHEETS_VERSION, sheets } satisfies WallSheetsFile));
    return { file, sheets };
}
