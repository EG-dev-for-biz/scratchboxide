/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Pipeline K's closed side: the party wall (base-cleanup.ts step 5, off by default) and the infill's large flat patches
 * (lattice-stitch.ts fillOpenLoops, the `Seal` node) where the infill had no photo for them (clay, or a scan triangle's
 * corner photo stretched over it), drawn in the twin as the building's own facade carried over:
 *
 *  1. Borrowed facade (the default): for each flat patch (or party wall facing one way), the straightened photo (ortho) of
 *     the facade facing the other way (the building's opposite side, else the best covered of the others) at the same
 *     storeys; its bay repeat measured on that crop (ortho-rectify.ts horizontalPeriod); whole bays taken from where the
 *     photo covers most (at most borrowMaxM wide), resampled to exactly that many bays so the crop continues across its
 *     own edges; repeated along the patch and mapped 1:1 in metres up it, its storeys at their world height; tinted by one
 *     gain per channel so its wall (the lighter half) is the colour measured on the building at that height. Labelled
 *     generated (route 4 in the infill's routes): the scan never saw this wall, and the windows are a guess from the
 *     opposite side.
 *  2. Party walls no facade can be borrowed for, with an image client (SCRATCHBOX_K_PARTY_WALL_TEXTURE=1): a straight-on,
 *     evenly lit square of this building's masonry continued as a blank wall, drawn by the image model from the orthos at
 *     those storeys, tinted the same way and repeated at tileM.
 *
 * With no orthos, no repeat on any facade at those storeys, or too few texels to measure a colour, the patch keeps what the
 * infill gave it and the report says why.
 */

import * as fs from 'fs';
import * as path from 'path';
import { linearRgbToLab } from '../../../../common/spatial/texture-library-index';
import { assembleGlb, parseGlbBytes, readAccessor } from '../glb-bytes';
import { encodePng } from '../png-encode';
import type { EnhanceModelClient } from '../texture-enhance';
import { decodeImageInMemory, type RgbaImage8 } from '../tile-texture-transfer';
import type { ReliefFacade } from '../facade-lattice';
import { horizontalPeriod } from './ortho-rectify';

export const PARTY_WALL_TEXTURE_VERSION = 'party-wall-texture/8';

export const PARTY_WALL_TEXTURE_PARAMS = {
    /** The building's wall at the party wall's height: photo-textured surfaces within its height band (plus bandM, m), near vertical (|normal y| at most wallNyMax). */
    bandM: 2, wallNyMax: 0.4,
    /** The wall's colour: the lighter share of the texels near it (its masonry, not its windows). */
    wallShare: 0.5,
    /** Fewer photo texels than this near it: no colour to match, the wall stays clay. */
    minSamples: 50,
    /** The generated tile: its side on the wall (m) and in pixels at most; the references' longest side (px), and how many. */
    tileM: 4, tilePx: 1024, referencePx: 1024, references: 3,
    /** The roughness drawn (a matte wall). */
    roughness: 0.85,
    /**
     * The borrowed facade: a source facing away from the patch by at least borrowOpposite (-normal . normal, in plan) is
     * preferred; it must cover borrowMinRows rows and borrowMinHeight of the patch's storeys, and its whole bays (at most
     * borrowMaxM wide) at least borrowMinCovered with real photo (not hole-filled); the crop at most borrowPx a side.
     */
    borrowOpposite: 0.7, borrowMinRows: 16, borrowMinHeight: 0.7, borrowMaxM: 20, borrowMinCovered: 0.8, borrowPx: 2048,
    /** Its confidence (route 4), on each vertex. */
    borrowConfidence: 0.3,
    /**
     * The infill's patches carried over: its triangles on these routes (lattice-stitch.ts ROUTES: 0 clay, 2 a scan
     * triangle's corner photo), near vertical, grouped by plane (normals within patchFacingCos, planes within patchPlaneM),
     * each split into connected pieces, those of at least patchMinM2.
     */
    sealRoutes: [0, 2] as number[], patchNyMax: 0.2, patchFacingCos: 0.96, patchPlaneM: 0.5, patchMinM2: 20
};

/** One facade carried over onto a flat patch or a party wall. */
export interface BorrowedFacade {
    /** Where it went: the party wall or the infill, how many triangles, their area (m²), their storeys (m) and which way they face (plan). */
    onto: 'party wall' | 'infill'; triangles: number; areaM2: number; y0: number; y1: number; facing: [number, number];
    /** The source: its ortho image and facade, whether it faces the other way, its bay (m), the bays taken and their real photo share. */
    source: string; facadeId: number; opposite: boolean; bayM: number; bays: number; covered: number;
}

export interface PartyWallTextureReport {
    walls: number;
    /** The infill's flat patches looked at, and what was carried onto them and the party walls. */
    patches?: number; borrowed?: BorrowedFacade[];
    /** The model that drew it, the tile (m), the references (ortho images), the measured wall colour (linear sRGB) and the photo texels it came from. */
    model?: string; tileM?: number; references?: string[]; neighbourLinear?: [number, number, number]; samples?: number;
    /** Why the party wall stayed clay. */
    skipped?: string;
}

const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const linearToSrgb = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);

/** A box-filtered copy at most maxPx a side. */
function shrink(img: RgbaImage8, maxPx: number): RgbaImage8 {
    const f = Math.max(1, Math.ceil(Math.max(img.width, img.height) / maxPx));
    if (f === 1) return img;
    const W = Math.floor(img.width / f), H = Math.floor(img.height / f), out = new Uint8Array(W * H * 4);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) for (let c = 0; c < 4; c++) {
        let s = 0;
        for (let j = 0; j < f; j++) for (let i = 0; i < f; i++) s += img.rgba[((y * f + j) * img.width + x * f + i) * 4 + c];
        out[(y * W + x) * 4 + c] = Math.round(s / (f * f));
    }
    return { width: W, height: H, rgba: out };
}

/** The party wall's quads (four corners each) from the twin, by node. */
function partyWalls(g: ReturnType<typeof parseGlbBytes>): Array<{ node: any; prim: any; pos: Float64Array }> {
    const out: Array<{ node: any; prim: any; pos: Float64Array }> = [];
    for (const n of g.json.nodes ?? []) {
        if (n.name !== 'PartyWall' || n.mesh === undefined) continue;
        for (const p of g.json.meshes[n.mesh]?.primitives ?? []) if (p.attributes?.POSITION !== undefined) out.push({ node: n, prim: p, pos: readAccessor(g, p.attributes.POSITION).data });
    }
    return out;
}

/** The photo texels of the building's wall at the storeys y0..y1 (world y): their mean (linear sRGB) and CIELAB spread, and how many. */
function neighbourColour(g: ReturnType<typeof parseGlbBytes>, band: { y0: number; y1: number }, P: typeof PARTY_WALL_TEXTURE_PARAMS): { mean: [number, number, number]; spreadLab: [number, number, number]; samples: number } {
    // the building's wall at those storeys: its vertical surfaces anywhere around it within that height band (right beside a
    // party wall or an infill patch the scan is torn, its edges dark; the masonry at the same storeys reads truer)
    const y0 = band.y0 - P.bandM, y1 = band.y1 + P.bandM;
    const near = (_x: number, y: number) => y >= y0 && y <= y1;
    const images = new Map<number, RgbaImage8 | null>();
    const imageOf = (texIndex: number) => {
        const src = g.json.textures?.[texIndex]?.source;
        if (src === undefined) return null;
        if (!images.has(src)) {
            const im = g.json.images?.[src], bv = im?.bufferView !== undefined ? g.json.bufferViews[im.bufferView] : undefined;
            let dec: RgbaImage8 | null = null;
            if (bv) { try { dec = decodeImageInMemory(g.bin.subarray(bv.byteOffset ?? 0, (bv.byteOffset ?? 0) + bv.byteLength)); } catch { dec = null; } }
            images.set(src, dec);
        }
        return images.get(src)!;
    };
    const lin: number[][] = [];
    (g.json.nodes ?? []).forEach((n: any) => {
        if (n.mesh === undefined || n.name === 'PartyWall' || n.name === 'BaseSkirt' || n.name === 'Seal' || n.name === 'LatticeStitch') return;
        for (const p of g.json.meshes[n.mesh]?.primitives ?? []) {
            const tex = g.json.materials?.[p.material]?.pbrMetallicRoughness?.baseColorTexture?.index;
            if (tex === undefined || p.attributes?.TEXCOORD_0 === undefined || p.indices === undefined) continue;
            const X = readAccessor(g, p.attributes.POSITION).data, U = readAccessor(g, p.attributes.TEXCOORD_0).data, I = readAccessor(g, p.indices).data;
            let img: RgbaImage8 | null | undefined;
            for (let t = 0; t + 2 < I.length; t += 3) {
                const [a, b, c] = [I[t], I[t + 1], I[t + 2]];
                const cx = (X[a * 3] + X[b * 3] + X[c * 3]) / 3, cy = (X[a * 3 + 1] + X[b * 3 + 1] + X[c * 3 + 1]) / 3, cz = (X[a * 3 + 2] + X[b * 3 + 2] + X[c * 3 + 2]) / 3;
                const ux = X[b * 3] - X[a * 3], uy = X[b * 3 + 1] - X[a * 3 + 1], uz = X[b * 3 + 2] - X[a * 3 + 2], vx = X[c * 3] - X[a * 3], vy = X[c * 3 + 1] - X[a * 3 + 1], vz = X[c * 3 + 2] - X[a * 3 + 2];
                const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx, nl = Math.hypot(nx, ny, nz);
                if (!(nl > 0) || Math.abs(ny / nl) > P.wallNyMax || !near(cx, cy)) continue;
                if (img === undefined) img = imageOf(tex);
                if (!img) break;
                const u = (U[a * 2] + U[b * 2] + U[c * 2]) / 3, v = (U[a * 2 + 1] + U[b * 2 + 1] + U[c * 2 + 1]) / 3;
                const px = Math.min(img.width - 1, Math.max(0, Math.floor((u - Math.floor(u)) * img.width))), py = Math.min(img.height - 1, Math.max(0, Math.floor((v - Math.floor(v)) * img.height)));
                const o = (py * img.width + px) * 4;
                lin.push([srgbToLinear(img.rgba[o] / 255), srgbToLinear(img.rgba[o + 1] / 255), srgbToLinear(img.rgba[o + 2] / 255)]);
            }
        }
    });
    // the masonry, not its openings: the lighter part of the texels (wallShare by luminance), as the material regions take
    // the lightest appearance class for the wall
    const lum = (c: number[]) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    const wall = [...lin].sort((a, b) => lum(b) - lum(a)).slice(0, Math.max(1, Math.round(lin.length * P.wallShare)));
    const n = wall.length;
    const mean = [0, 1, 2].map(k => wall.reduce((s, c) => s + c[k], 0) / n) as [number, number, number];
    const labs = wall.map(c => linearRgbToLab(c as [number, number, number]));
    const ml = [0, 1, 2].map(k => labs.reduce((s, c) => s + c[k], 0) / n);
    const spreadLab = [0, 1, 2].map(k => Math.sqrt(labs.reduce((s, c) => s + (c[k] - ml[k]) ** 2, 0) / n)) as [number, number, number];
    return { mean, spreadLab, samples: lin.length };
}

/** The straightened facade photos cropped to the storeys y0..y1 (world y), the best covered first, as PNG. */
function references(orthosDir: string, y0: number, y1: number, P: typeof PARTY_WALL_TEXTURE_PARAMS): Array<{ name: string; png: Uint8Array; covered: number }> {
    const file = path.join(orthosDir, 'facades.json');
    if (!fs.existsSync(file)) return [];
    const facades = JSON.parse(fs.readFileSync(file, 'utf8')).facades as ReliefFacade[];
    const out: Array<{ name: string; png: Uint8Array; covered: number }> = [];
    for (const f of facades) {
        // rows of the storeys: t along the facade's up axis from its centroid, row 0 at orthoTMax
        if (Math.abs(f.axisT[1]) < 0.9) continue;
        const t0 = (y0 - f.centroid[1]) / f.axisT[1], t1 = (y1 - f.centroid[1]) / f.axisT[1];
        const r0 = Math.max(0, Math.floor((f.orthoTMax - Math.max(t0, t1)) / f.pixel)), r1 = Math.min(f.height, Math.ceil((f.orthoTMax - Math.min(t0, t1)) / f.pixel));
        if (r1 - r0 < 16 || !fs.existsSync(path.join(orthosDir, f.image))) continue;
        const img = decodeImageInMemory(fs.readFileSync(path.join(orthosDir, f.image)));
        const mask = f.uncoveredMask && fs.existsSync(path.join(orthosDir, f.uncoveredMask)) ? decodeImageInMemory(fs.readFileSync(path.join(orthosDir, f.uncoveredMask))) : undefined;
        let covered = 0;
        const crop = new Uint8Array(img.width * (r1 - r0) * 4);
        for (let y = r0; y < r1; y++) for (let x = 0; x < img.width; x++) {
            const o = (y * img.width + x) * 4, c = ((y - r0) * img.width + x) * 4;
            crop.set(img.rgba.subarray(o, o + 4), c);
            if (!mask || mask.rgba[o] <= 127) covered++;
        }
        if (covered < 1000) continue;
        const small = shrink({ width: img.width, height: r1 - r0, rgba: crop }, P.referencePx);
        const rgb = new Uint8Array(small.width * small.height * 3);
        for (let i = 0; i < small.width * small.height; i++) rgb.set(small.rgba.subarray(i * 4, i * 4 + 3), i * 3);
        out.push({ name: f.image, png: encodePng(small.width, small.height, rgb, 3), covered });
    }
    return out.sort((a, b) => b.covered - a.covered).slice(0, P.references);
}

/** The prompt: the wall continued as blank masonry, straight on, evenly lit, one tile of tileM metres. */
export function partyWallPrompt(tileM: number): string {
    return [
        `The attached images are straightened, straight-on photos of one building's own facades at the same storeys.`,
        `Draw a square image of this building's wall masonry continued as a blank wall: the same stone or brick, the same colour, course height, joints and weathering as in the photos,`,
        `seen exactly straight on, evenly lit as under a bright overcast sky, with no windows, doors, signs, people, shadows, sky, ground or perspective.`,
        `Keep the weathering even and light: no stains, streaks, drips or dark marks, and no motif repeated inside the square.`,
        `The square spans ${tileM} m by ${tileM} m of wall; keep the courses horizontal and the texture even across the whole square, its left edge continuing its right and its top continuing its bottom, so it repeats without a seam.`
    ].join(' ');
}

/** A borrowed facade's crop: exactly `bays` bays wide (so it continues across its own edges), its rows from yTop down to yBot (world y). */
interface Borrow { name: string; facadeId: number; opposite: boolean; bayM: number; bays: number; covered: number; img: RgbaImage8; yTop: number; yBot: number }

/** The orthos of a folder, each image (and its uncovered mask) decoded once. */
function orthoSet(orthosDir: string): { facades: ReliefFacade[]; image: (f: ReliefFacade) => { img: RgbaImage8; mask?: RgbaImage8 } | undefined } {
    const file = path.join(orthosDir, 'facades.json');
    const facades = fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')).facades as ReliefFacade[]) : [];
    const cache = new Map<string, { img: RgbaImage8; mask?: RgbaImage8 } | undefined>();
    const image = (f: ReliefFacade) => {
        if (!cache.has(f.image)) {
            const ip = path.join(orthosDir, f.image), mp = f.uncoveredMask ? path.join(orthosDir, f.uncoveredMask) : undefined;
            cache.set(f.image, fs.existsSync(ip) ? { img: decodeImageInMemory(fs.readFileSync(ip)), ...(mp && fs.existsSync(mp) ? { mask: decodeImageInMemory(fs.readFileSync(mp)) } : {}) } : undefined);
        }
        return cache.get(f.image);
    };
    return { facades, image };
}

/**
 * The facade carried onto a patch facing (nx, nz) in plan over the storeys y0..y1: the one facing the other way first, else
 * the others by real photo share; its rows at those storeys, its bay repeat, and the whole bays (at most borrowMaxM wide)
 * where its photo covers most, resampled to exactly that many bays and turned so it reads left to right from outside.
 */
function borrowFacade(set: ReturnType<typeof orthoSet>, nx: number, nz: number, y0: number, y1: number, P: typeof PARTY_WALL_TEXTURE_PARAMS): Borrow | undefined {
    const options: Array<Borrow & { rank: number }> = [];
    for (const f of set.facades) {
        if (Math.abs(f.axisT[1]) < 0.9) continue;
        const fl = Math.hypot(f.normal[0], f.normal[2]);
        if (!(fl > 0.9)) continue;
        const fx = f.normal[0] / fl, fz = f.normal[2] / fl, opposite = -(fx * nx + fz * nz) >= P.borrowOpposite;
        // its rows at those storeys: t along its up axis from its centroid, row 0 at orthoTMax
        const t0 = (y0 - f.centroid[1]) / f.axisT[1], t1 = (y1 - f.centroid[1]) / f.axisT[1];
        const r0 = Math.max(0, Math.floor((f.orthoTMax - Math.max(t0, t1)) / f.pixel)), r1 = Math.min(f.height, Math.ceil((f.orthoTMax - Math.min(t0, t1)) / f.pixel));
        if (r1 - r0 < P.borrowMinRows || (r1 - r0) * f.pixel < P.borrowMinHeight * (y1 - y0)) continue;
        const im = set.image(f);
        if (!im) continue;
        const W = im.img.width, H = r1 - r0;
        // the crop, its hole-filled texels marked uncovered (grey 128) so the repeat is measured on real photo only
        const crop = new Uint8Array(W * H * 4), real = new Uint8Array(W * H);
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
            const o = ((y + r0) * W + x) * 4, c = (y * W + x) * 4;
            const ok = im.img.rgba[o + 3] > 0 && !(im.mask && im.mask.rgba[o] > 127) && !(im.img.rgba[o] === 128 && im.img.rgba[o + 1] === 128 && im.img.rgba[o + 2] === 128);
            real[y * W + x] = ok ? 1 : 0;
            if (ok) crop.set(im.img.rgba.subarray(o, o + 4), c); else { crop[c] = crop[c + 1] = crop[c + 2] = 128; crop[c + 3] = 255; }
        }
        const period = horizontalPeriod({ width: W, height: H, rgba: crop }, f.pixel);
        if (!period) continue;
        const bays = Math.min(Math.floor(W / period.periodPx), Math.max(1, Math.floor(P.borrowMaxM / (period.periodPx * f.pixel))));
        if (bays < 1) continue;
        const span = bays * period.periodPx, spanPx = Math.ceil(span);
        // where the photo covers most: the window of those bays with the most real texels
        const col = new Float64Array(W + 1);
        for (let x = 0; x < W; x++) { let n = 0; for (let y = 0; y < H; y++) n += real[y * W + x]; col[x + 1] = col[x] + n; }
        let x0 = 0, best = -1;
        for (let x = 0; x + spanPx <= W; x++) { const n = col[x + spanPx] - col[x]; if (n > best) { best = n; x0 = x; } }
        const covered = best / (spanPx * H);
        if (covered < P.borrowMinCovered) continue;
        // resampled to exactly `bays` bays (linear along the row), from the photo itself (its fill kept where it filled)
        const outW = Math.max(1, Math.round(span)), out = new Uint8Array(outW * H * 4);
        // read left to right from outside: its axisS against the right hand of someone facing it, (fz, 0, -fx)
        const flip = f.axisS[0] * fz - f.axisS[2] * fx < 0;
        for (let y = 0; y < H; y++) for (let i = 0; i < outW; i++) {
            const sx = x0 + ((flip ? outW - 1 - i : i) + 0.5) * (span / outW) - 0.5, xa = Math.max(0, Math.min(W - 1, Math.floor(sx))), xb = Math.min(W - 1, xa + 1), w = Math.min(1, Math.max(0, sx - xa));
            for (let k = 0; k < 4; k++) out[(y * outW + i) * 4 + k] = Math.round((1 - w) * im.img.rgba[((y + r0) * W + xa) * 4 + k] + w * im.img.rgba[((y + r0) * W + xb) * 4 + k]);
        }
        const yTop = f.centroid[1] + (f.orthoTMax - r0 * f.pixel) * f.axisT[1], yBot = f.centroid[1] + (f.orthoTMax - r1 * f.pixel) * f.axisT[1];
        options.push({ name: f.image, facadeId: f.facadeId, opposite, bayM: period.periodPx * f.pixel, bays, covered, img: { width: outW, height: H, rgba: out }, yTop: Math.max(yTop, yBot), yBot: Math.min(yTop, yBot), rank: (opposite ? 1 : 0) + covered * 0.5 * Math.min(1, ((r1 - r0) * f.pixel) / Math.max(1e-6, y1 - y0)) });
    }
    options.sort((a, b) => b.rank - a.rank);
    const best = options[0];
    if (!best) return undefined;
    const { rank: _rank, ...borrow } = best;
    // at most borrowPx a side
    return { ...borrow, img: shrink(borrow.img, P.borrowPx) };
}

/** An image as PNG, tinted by one gain per channel (linear) so its lighter half (the wall, not its openings) is `target`. */
function tintedPng(img: RgbaImage8, target: [number, number, number] | undefined, whole: boolean): Uint8Array {
    const px = img.width * img.height, lin = new Float64Array(px * 3);
    for (let i = 0; i < px; i++) for (let k = 0; k < 3; k++) lin[i * 3 + k] = srgbToLinear(img.rgba[i * 4 + k] / 255);
    let gain = [1, 1, 1];
    if (target) {
        const lum = (i: number) => 0.2126 * lin[i * 3] + 0.7152 * lin[i * 3 + 1] + 0.0722 * lin[i * 3 + 2];
        const order = Array.from({ length: px }, (_, i) => i);
        if (!whole) order.sort((a, b) => lum(b) - lum(a));
        const use = whole ? order : order.slice(0, Math.max(1, Math.round(px / 2)));
        const m = [0, 0, 0];
        for (const i of use) for (let k = 0; k < 3; k++) m[k] += lin[i * 3 + k] / use.length;
        gain = m.map((v, k) => (v > 1e-6 ? target[k] / v : 1));
    }
    const rgb = new Uint8Array(px * 3);
    for (let i = 0; i < px; i++) for (let k = 0; k < 3; k++) rgb[i * 3 + k] = Math.round(255 * Math.min(1, Math.max(0, linearToSrgb(lin[i * 3 + k] * gain[k]))));
    return encodePng(img.width, img.height, rgb, 3);
}

/** A flat group of triangles to carry a facade onto: their positions (three per triangle), outward plan normal and storeys. */
interface Patch { tris: number[][][]; nx: number; nz: number; y0: number; y1: number; areaM2: number }

/** Triangles grouped into flat near-vertical connected patches (normals within patchFacingCos, planes within patchPlaneM), the large ones, facing out from `centre`. */
function flatPatches(tris: number[][][], centre: [number, number], P: typeof PARTY_WALL_TEXTURE_PARAMS): Array<Patch & { members: number[] }> {
    const info = tris.map(f => {
        const u = [f[1][0] - f[0][0], f[1][1] - f[0][1], f[1][2] - f[0][2]], v = [f[2][0] - f[0][0], f[2][1] - f[0][1], f[2][2] - f[0][2]];
        let n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
        const l = Math.hypot(n[0], n[1], n[2]);
        if (!(l > 1e-9)) return undefined;
        n = n.map(x => x / l);
        const c = [0, 1, 2].map(k => (f[0][k] + f[1][k] + f[2][k]) / 3);
        // outward: away from the building's centre in plan (the infill's caps are drawn double sided, wound either way)
        if (n[0] * (c[0] - centre[0]) + n[2] * (c[2] - centre[1]) < 0) n = n.map(x => -x);
        return { n, c, area: l / 2 };
    });
    const groups: Array<{ n: number[]; d: number; area: number; members: number[] }> = [];
    const order = info.map((_, i) => i).filter(i => info[i] && Math.abs(info[i]!.n[1]) <= P.patchNyMax).sort((a, b) => info[b]!.area - info[a]!.area);
    for (const i of order) {
        const t = info[i]!, d = t.n[0] * t.c[0] + t.n[1] * t.c[1] + t.n[2] * t.c[2];
        const g = groups.find(g => g.n[0] * t.n[0] + g.n[1] * t.n[1] + g.n[2] * t.n[2] >= P.patchFacingCos && Math.abs(g.d - d) <= P.patchPlaneM);
        if (g) { g.members.push(i); g.area += t.area; } else groups.push({ n: t.n, d, area: t.area, members: [i] });
    }
    // each plane's triangles split into connected pieces (sharing a corner, welded at 1 cm): a patch is one surface, not
    // the slivers that happen to lie on its plane all up the building
    const key = (p: number[]) => `${Math.round(p[0] * 100)},${Math.round(p[1] * 100)},${Math.round(p[2] * 100)}`;
    const pieces: typeof groups = [];
    for (const g of groups) {
        const parent = g.members.map((_, i) => i), find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
        const at = new Map<string, number>();
        g.members.forEach((m, i) => { for (const p of tris[m]) { const k = key(p), j = at.get(k); if (j === undefined) at.set(k, i); else parent[find(i)] = find(j); } });
        const byRoot = new Map<number, number[]>();
        g.members.forEach((_, i) => { const r = find(i); (byRoot.get(r) ?? byRoot.set(r, []).get(r)!).push(i); });
        for (const list of byRoot.values()) pieces.push({ n: g.n, d: g.d, area: list.reduce((s, i) => s + info[g.members[i]]!.area, 0), members: list.map(i => g.members[i]) });
    }
    return pieces.filter(g => g.area >= P.patchMinM2).map(g => {
        const l = Math.hypot(g.n[0], g.n[2]) || 1;
        let y0 = Infinity, y1 = -Infinity;
        for (const i of g.members) for (const p of tris[i]) { y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); }
        return { tris: g.members.map(i => tris[i]), members: g.members, nx: g.n[0] / l, nz: g.n[2] / l, y0, y1, areaM2: g.area };
    });
}

/** UVs of a borrowed facade at a point on a patch facing (nx, nz): u along it in bays (repeating), v down its storeys (clamped). */
const borrowedUv = (p: ArrayLike<number>, nx: number, nz: number, b: Borrow): [number, number] => [(p[0] * nz - p[2] * nx) / (b.bays * b.bayM), (b.yTop - p[1]) / Math.max(1e-6, b.yTop - b.yBot)];

/**
 * The twin with its closed side drawn as the building's own facade carried over: the infill's large flat patches without a
 * photo and the party walls get the borrowed facade; party walls with none, the image model's masonry (with a client); or
 * as it was, with the reason.
 */
export async function texturePartyWall(twin: Uint8Array, opts: { client?: EnhanceModelClient; models: string[]; orthosDir?: string; signal?: AbortSignal; progress?: (m: string) => void }, P = PARTY_WALL_TEXTURE_PARAMS): Promise<{ glb: Buffer; report: PartyWallTextureReport }> {
    const g = parseGlbBytes(twin);
    const json = g.json;
    const walls = partyWalls(g);
    // the infill's triangles with no photo of their own (its route attribute), with where they came from
    const seal: Array<{ node: any; prim: any; tri: number; route: number; p: number[][] }> = [];
    for (const n of json.nodes ?? []) {
        if (n.mesh === undefined || !n.extras?.sbSeal) continue;
        for (const pr of json.meshes[n.mesh]?.primitives ?? []) {
            if (pr.attributes?.POSITION === undefined || pr.attributes?._PROVENANCE === undefined) continue;
            const X = readAccessor(g, pr.attributes.POSITION).data, R = readAccessor(g, pr.attributes._PROVENANCE).data;
            const I = pr.indices !== undefined ? readAccessor(g, pr.indices).data : Float64Array.from({ length: X.length / 3 }, (_, i) => i);
            for (let t = 0; t + 2 < I.length; t += 3) if (P.sealRoutes.includes(Math.round(R[I[t]]))) seal.push({ node: n, prim: pr, tri: t, route: Math.round(R[I[t]]), p: [I[t], I[t + 1], I[t + 2]].map(v => [X[v * 3], X[v * 3 + 1], X[v * 3 + 2]]) });
        }
    }
    // the building's centre in plan (outward for the infill's caps)
    let cx = 0, cz = 0, cn = 0;
    for (const a of json.accessors ?? []) if (a.type === 'VEC3' && a.min && a.max && a.count > 0) { cx += (a.min[0] + a.max[0]) / 2 * a.count; cz += (a.min[2] + a.max[2]) / 2 * a.count; cn += a.count; }
    const patches = flatPatches(seal.map(s => s.p), [cn ? cx / cn : 0, cn ? cz / cn : 0], P);
    const report: PartyWallTextureReport = { walls: walls.length, patches: patches.length };
    const unchanged = (skipped: string) => ({ glb: Buffer.from(twin), report: { ...report, skipped } });
    if (!walls.length && !patches.length) return unchanged(`no party wall and no flat infill patch of at least ${P.patchMinM2} m² without a photo in this build`);
    if (!opts.orthosDir) return unchanged('no straightened facade photos to carry over');
    const set = orthoSet(opts.orthosDir);
    // the GLB rewritten in place: new images, materials, accessors and primitives appended
    const chunks: Uint8Array[] = [g.bin];
    let len = g.bin.length;
    const view = (bytes: Uint8Array, target?: number) => { const pad = (4 - (len % 4)) % 4; if (pad) { chunks.push(new Uint8Array(pad)); len += pad; } json.bufferViews.push({ buffer: 0, byteOffset: len, byteLength: bytes.byteLength, ...(target ? { target } : {}) }); chunks.push(bytes); len += bytes.byteLength; return json.bufferViews.length - 1; };
    const f32 = (a: ArrayLike<number>) => new Uint8Array(Float32Array.from(a).buffer);
    json.images ??= []; json.textures ??= []; json.samplers ??= []; json.materials ??= [];
    // repeating along the wall, clamped up it (the storeys are mapped once)
    json.samplers.push({ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 33071 });
    const borrowSampler = json.samplers.length - 1;
    const materialOf = new Map<string, number>();
    const borrowMaterial = (b: Borrow, colour: [number, number, number] | undefined) => {
        const key = `${b.name}:${b.yTop.toFixed(2)}:${b.yBot.toFixed(2)}`;
        if (!materialOf.has(key)) {
            json.images.push({ bufferView: view(tintedPng(b.img, colour, false)), mimeType: 'image/png' });
            json.textures.push({ source: json.images.length - 1, sampler: borrowSampler });
            json.materials.push({ name: `Borrowed_${b.name.replace(/\.png$/i, '')}`, pbrMetallicRoughness: { baseColorTexture: { index: json.textures.length - 1 }, metallicFactor: 0, roughnessFactor: P.roughness }, doubleSided: true });
            materialOf.set(key, json.materials.length - 1);
        }
        return materialOf.get(key)!;
    };
    const borrowed: BorrowedFacade[] = [];
    const methodOf = (b: Borrow, colour: unknown) => `carried over from facade ${b.facadeId}'s straightened photo (${b.name}${b.opposite ? ', the side facing the other way' : ''}): ${b.bays} whole bay${b.bays === 1 ? '' : 's'} of ${b.bayM.toFixed(2)} m (${Math.round(b.covered * 100)}% real photo) repeated along the wall, its storeys from ${b.yBot.toFixed(1)} to ${b.yTop.toFixed(1)} m at their height${colour ? ', tinted to the wall colour measured on the building at that height' : ''}; a guess, the scan never saw this wall`;
    // 1. the infill's flat patches: their triangles moved out of their primitives into the borrowed facade's
    const moved = new Map<any, Set<number>>();
    const sealAdds = new Map<any, any[]>();
    for (const patch of patches) {
        const b = borrowFacade(set, patch.nx, patch.nz, patch.y0, patch.y1, P);
        if (!b) continue;
        const beside = neighbourColour(g, patch, P);
        const colour = beside.samples >= P.minSamples ? beside.mean : undefined;
        const material = borrowMaterial(b, colour);
        const pos: number[] = [], nrm: number[] = [], uv: number[] = [];
        for (const m of patch.members) {
            const s = seal[m];
            (moved.get(s.prim) ?? moved.set(s.prim, new Set()).get(s.prim)!).add(s.tri);
            for (const p of s.p) { pos.push(...p); nrm.push(patch.nx, 0, patch.nz); uv.push(...borrowedUv(p, patch.nx, patch.nz, b)); }
        }
        const n = pos.length / 3, min = [0, 1, 2].map(k => Math.min(...pos.filter((_, i) => i % 3 === k))), max = [0, 1, 2].map(k => Math.max(...pos.filter((_, i) => i % 3 === k)));
        json.accessors.push({ bufferView: view(f32(pos), 34962), componentType: 5126, count: n, type: 'VEC3', min, max });
        const attributes: Record<string, number> = { POSITION: json.accessors.length - 1 };
        json.accessors.push({ bufferView: view(f32(nrm), 34962), componentType: 5126, count: n, type: 'VEC3' }); attributes.NORMAL = json.accessors.length - 1;
        json.accessors.push({ bufferView: view(f32(uv), 34962), componentType: 5126, count: n, type: 'VEC2' }); attributes.TEXCOORD_0 = json.accessors.length - 1;
        json.accessors.push({ bufferView: view(f32(new Array(n).fill(4)), 34962), componentType: 5126, count: n, type: 'SCALAR' }); attributes._PROVENANCE = json.accessors.length - 1;
        json.accessors.push({ bufferView: view(f32(new Array(n).fill(P.borrowConfidence)), 34962), componentType: 5126, count: n, type: 'SCALAR' }); attributes._CONFIDENCE = json.accessors.length - 1;
        json.accessors.push({ bufferView: view(new Uint8Array(Uint32Array.from({ length: n }, (_, i) => i).buffer), 34963), componentType: 5125, count: n, type: 'SCALAR' });
        const node = seal[patch.members[0]].node;
        const fromRoute = new Map<number, number>();
        for (const m of patch.members) fromRoute.set(seal[m].route, (fromRoute.get(seal[m].route) ?? 0) + 1);
        (sealAdds.get(node) ?? sealAdds.set(node, []).get(node)!).push({ prim: { attributes, indices: json.accessors.length - 1, material, mode: 4 }, method: methodOf(b, colour), triangles: patch.members.length, areaM2: patch.areaM2, fromRoute });
        borrowed.push({ onto: 'infill', triangles: patch.members.length, areaM2: Math.round(patch.areaM2 * 10) / 10, y0: +patch.y0.toFixed(1), y1: +patch.y1.toFixed(1), facing: [+patch.nx.toFixed(3), +patch.nz.toFixed(3)], source: b.name, facadeId: b.facadeId, opposite: b.opposite, bayM: +b.bayM.toFixed(3), bays: b.bays, covered: +b.covered.toFixed(3) });
    }
    // the moved triangles dropped from their primitives (a new index list each)
    for (const [prim, tris] of moved) {
        const I = prim.indices !== undefined ? readAccessor(g, prim.indices).data : Float64Array.from({ length: json.accessors[prim.attributes.POSITION].count }, (_, i) => i);
        const keep: number[] = [];
        for (let t = 0; t + 2 < I.length; t += 3) if (!tris.has(t)) keep.push(I[t], I[t + 1], I[t + 2]);
        json.accessors.push({ bufferView: view(new Uint8Array(Uint32Array.from(keep).buffer), 34963), componentType: 5125, count: keep.length, type: 'SCALAR' });
        prim.indices = json.accessors.length - 1;
    }
    for (const [node, adds] of sealAdds) {
        json.meshes[node.mesh].primitives.push(...adds.map(a => a.prim));
        const sb = node.extras.sbSeal;
        const pieces = adds.reduce((s, a) => s + a.triangles, 0);
        if (Array.isArray(sb.routes)) {
            // the pieces moved off the routes they had (clay, a corner photo)
            for (const r of sb.routes) r.pieces = Math.max(0, r.pieces - adds.reduce((s, a) => s + (a.fromRoute.get(r.code) ?? 0), 0));
            sb.routes.push({ code: 4, label: "carried over from the building's own facade facing the other way (whole bays of its straightened photo)", pieces, meanConfidence: P.borrowConfidence });
        }
        if (typeof sb.clay === 'number') sb.clay = Math.max(0, sb.clay - adds.reduce((s, a) => s + (a.fromRoute.get(0) ?? 0), 0));
        if (typeof sb.cornerTextured === 'number') sb.cornerTextured = Math.max(0, sb.cornerTextured - adds.reduce((s, a) => s + (a.fromRoute.get(2) ?? 0), 0));
        sb.borrowed = adds.map(a => ({ triangles: a.triangles, areaM2: Math.round(a.areaM2 * 10) / 10, method: a.method }));
        if (sb.provenance) sb.provenance.method = `${sb.provenance.method}; ${pieces} pieces in ${adds.length} flat patch${adds.length === 1 ? '' : 'es'} without a photo ${adds.map(a => a.method).join('; ')}`;
    }
    // 2. the party walls: each quad facing the way of a borrowed facade takes it; the rest the image model's masonry, if any
    const left: Array<{ w: (typeof walls)[number]; q: number }> = [];
    let tile: { material: number; method: string; model: string; references: string[]; colour: [number, number, number]; samples: number } | undefined;
    const wallPrims: Array<{ w: (typeof walls)[number]; quads: Array<{ q: number; material: number; uv: number[] }> }> = [];
    for (const w of walls) {
        const quads: Array<{ q: number; material: number; uv: number[] }> = [];
        for (let q = 0; q + 11 < w.pos.length; q += 12) {
            const p = w.pos;
            // its outward normal in plan, from its winding (base-cleanup.ts winds it to face out): (B - A) x (C - A)
            const u = [p[q + 3] - p[q], p[q + 4] - p[q + 1], p[q + 5] - p[q + 2]], v = [p[q + 6] - p[q], p[q + 7] - p[q + 1], p[q + 8] - p[q + 2]];
            let nx = u[1] * v[2] - u[2] * v[1], nz = u[0] * v[1] - u[1] * v[0];
            const nl = Math.hypot(nx, nz) || 1; nx /= nl; nz /= nl;
            let qy0 = Infinity, qy1 = -Infinity;
            for (let k = 0; k < 4; k++) { qy0 = Math.min(qy0, p[q + k * 3 + 1]); qy1 = Math.max(qy1, p[q + k * 3 + 1]); }
            const b = borrowFacade(set, nx, nz, qy0, qy1, P);
            if (!b) { left.push({ w, q }); continue; }
            const beside = neighbourColour(g, { y0: qy0, y1: qy1 }, P);
            const colour = beside.samples >= P.minSamples ? beside.mean : undefined;
            const uv: number[] = [];
            for (let k = 0; k < 4; k++) uv.push(...borrowedUv(p.subarray(q + k * 3, q + k * 3 + 3), nx, nz, b));
            quads.push({ q, material: borrowMaterial(b, colour), uv });
            const prov = w.node.extras?.sbBaseSkirt?.provenance;
            if (prov && !String(prov.method).includes(b.name)) prov.method = `${prov.method}; ${methodOf(b, colour)}`;
            borrowed.push({ onto: 'party wall', triangles: 2, areaM2: Math.round(Math.hypot(u[0], u[2]) * (qy1 - qy0) * 10) / 10, y0: +qy0.toFixed(1), y1: +qy1.toFixed(1), facing: [+nx.toFixed(3), +nz.toFixed(3)], source: b.name, facadeId: b.facadeId, opposite: b.opposite, bayM: +b.bayM.toFixed(3), bays: b.bays, covered: +b.covered.toFixed(3) });
        }
        wallPrims.push({ w, quads });
    }
    if (left.length && opts.client) {
        let y0 = Infinity, y1 = -Infinity;
        for (const { w, q } of left) for (let k = 0; k < 4; k++) { y0 = Math.min(y0, w.pos[q + k * 3 + 1]); y1 = Math.max(y1, w.pos[q + k * 3 + 1]); }
        const beside = neighbourColour(g, { y0, y1 }, P);
        const refs = beside.samples >= P.minSamples ? references(opts.orthosDir, y0, y1, P) : [];
        if (refs.length) {
            opts.progress?.(`party wall: drawing the building's masonry from ${refs.length} of its facade photos`);
            const answer = await opts.client({
                label: 'party-wall', models: opts.models, prompt: partyWallPrompt(P.tileM),
                image: { mimeType: 'image/png', bytes: refs[0].png, width: P.tilePx, height: P.tilePx },
                references: refs.slice(1).map(r => ({ panoId: r.name, mimeType: 'image/png' as const, bytes: r.png })),
                ...(opts.signal ? { signal: opts.signal } : {})
            });
            const map = shrink(decodeImageInMemory(answer.bytes), P.tilePx);
            json.images.push({ bufferView: view(tintedPng(map, beside.mean, true)), mimeType: 'image/png' });
            json.samplers.push({ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 });
            json.textures.push({ source: json.images.length - 1, sampler: json.samplers.length - 1 });
            json.materials.push({ name: 'PartyWall', pbrMetallicRoughness: { baseColorTexture: { index: json.textures.length - 1 }, metallicFactor: 0, roughnessFactor: P.roughness }, doubleSided: true });
            tile = { material: json.materials.length - 1, model: answer.modelUsed, references: refs.map(r => r.name), colour: beside.mean, samples: beside.samples, method: `drawn by ${answer.modelUsed} as this building's masonry continued (a ${P.tileM} x ${P.tileM} m tile from ${refs.length} of its straightened facade photos at these storeys: ${refs.map(r => r.name).join(', ')}), tinted to the wall colour measured on the building at that height (${beside.samples} photo texels) and repeated` };
            for (const { w, q } of left) {
                const dx = w.pos[q + 3] - w.pos[q], dz = w.pos[q + 5] - w.pos[q + 2], l = Math.hypot(dx, dz) || 1, uv: number[] = [];
                for (let k = 0; k < 4; k++) { const x = w.pos[q + k * 3], y = w.pos[q + k * 3 + 1], z = w.pos[q + k * 3 + 2]; uv.push(Math.abs((x * dx + z * dz) / l) / P.tileM, -y / P.tileM); }
                wallPrims.find(e => e.w === w)!.quads.push({ q, material: tile.material, uv });
            }
            for (const w of new Set(left.map(l => l.w))) { const prov = w.node.extras?.sbBaseSkirt?.provenance; if (prov) prov.method = `${prov.method}; ${tile.method}`; }
        }
    }
    // the party walls' quads regrouped by material (the untextured ones keep the primitive's own)
    for (const { w, quads } of wallPrims) {
        if (!quads.length) continue;
        const byMat = new Map<number, Array<{ q: number; uv: number[] }>>();
        for (const e of quads) (byMat.get(e.material) ?? byMat.set(e.material, []).get(e.material)!).push(e);
        const taken = new Set(quads.map(e => e.q));
        const mesh = json.meshes[w.node.mesh];
        const rest: number[] = [];
        for (let q = 0; q + 11 < w.pos.length; q += 12) if (!taken.has(q)) rest.push(...w.pos.subarray(q, q + 12));
        const addPrim = (pos: number[], uv: number[] | undefined, material: number) => {
            const n = pos.length / 3, idx: number[] = [];
            // wound as base-cleanup.ts winds its quads (A B C, A C D: facing out)
            for (let b = 0; b < n; b += 4) idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
            json.accessors.push({ bufferView: view(f32(pos), 34962), componentType: 5126, count: n, type: 'VEC3', min: [0, 1, 2].map(k => Math.min(...pos.filter((_, i) => i % 3 === k))), max: [0, 1, 2].map(k => Math.max(...pos.filter((_, i) => i % 3 === k))) });
            const attributes: Record<string, number> = { POSITION: json.accessors.length - 1 };
            if (uv) { json.accessors.push({ bufferView: view(f32(uv), 34962), componentType: 5126, count: n, type: 'VEC2' }); attributes.TEXCOORD_0 = json.accessors.length - 1; }
            json.accessors.push({ bufferView: view(new Uint8Array(Uint32Array.from(idx).buffer), 34963), componentType: 5125, count: idx.length, type: 'SCALAR' });
            return { attributes, indices: json.accessors.length - 1, material, mode: 4 };
        };
        const prims = [...byMat].map(([mat, es]) => addPrim(es.flatMap(e => Array.from(w.pos.subarray(e.q, e.q + 12))), es.flatMap(e => e.uv), mat));
        if (rest.length) prims.push(addPrim(rest, undefined, w.prim.material));
        mesh.primitives = [...mesh.primitives.filter((p: any) => p !== w.prim), ...prims];
    }
    if (!borrowed.length && !tile) return unchanged(`no facade at these storeys has a bay repeat with at least ${Math.round(P.borrowMinCovered * 100)}% real photo to carry over${walls.length && !opts.client ? ', and no image model client in this build\'s services for the party wall' : ''}`);
    opts.progress?.(`closed side: ${borrowed.length} wall${borrowed.length === 1 ? '' : 's'} carried over from the building's own facades`);
    const pad = (4 - (len % 4)) % 4;
    if (pad) { chunks.push(new Uint8Array(pad)); len += pad; }
    const bin = new Uint8Array(len);
    let o = 0;
    for (const c of chunks) { bin.set(c, o); o += c.length; }
    json.buffers = [{ ...(json.buffers?.[0] ?? {}), byteLength: len }];
    return { glb: assembleGlb(json, bin), report: { ...report, borrowed, ...(tile ? { model: tile.model, tileM: P.tileM, references: tile.references, neighbourLinear: tile.colour.map(v => +v.toFixed(4)) as [number, number, number], samples: tile.samples } : {}) } };
}
