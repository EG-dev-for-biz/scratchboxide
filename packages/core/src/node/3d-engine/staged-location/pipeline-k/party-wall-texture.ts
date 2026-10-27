/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Pipeline K's party wall (base-cleanup.ts step 5: a wall where the scan has none, typically shared with a neighbour)
 * drawn in the twin as the building's own masonry continued, by an image model:
 *
 *  1. The building's wall at its height: the twin's own photo texels on the building's near-vertical surfaces within the
 *     party wall's height band, all round (right beside it the scan is torn and dark); the lighter half of them (the
 *     masonry, not its windows): mean colour and spread.
 *  2. References: pipeline K's straightened facade photos (its orthos) cropped to those storeys, the best covered ones
 *     (texels the photo reached, by each ortho's uncovered mask), at most referencePx a side.
 *  3. One image call (Nano Banana, the app's image client): a straight-on, evenly lit square of this building's wall
 *     masonry continued as a blank wall, tileM on a side; tinted by one gain per channel so its mean is the colour
 *     measured in (1), and repeated over each party wall at that size (planar along the wall, metres).
 *
 * Labelled generated, with the model that answered, the tile size, the references and the measured colour. No normal or
 * roughness map is drawn (a matte roughness factor stands in). With no image client, no reference, too few texels to
 * measure, or a failed call, the wall stays clay and the report says why.
 */

import * as fs from 'fs';
import * as path from 'path';
import { linearRgbToLab } from '../../../../common/spatial/texture-library-index';
import { assembleGlb, parseGlbBytes, readAccessor } from '../glb-bytes';
import { encodePng } from '../png-encode';
import type { EnhanceModelClient } from '../texture-enhance';
import { decodeImageInMemory, type RgbaImage8 } from '../tile-texture-transfer';
import type { ReliefFacade } from '../facade-lattice';

export const PARTY_WALL_TEXTURE_VERSION = 'party-wall-texture/7';

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
    roughness: 0.85
};

export interface PartyWallTextureReport {
    walls: number;
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

/** The photo texels of the wall beside the party wall: their mean (linear sRGB) and CIELAB spread, and how many. */
function neighbourColour(g: ReturnType<typeof parseGlbBytes>, walls: Array<{ pos: Float64Array }>, P: typeof PARTY_WALL_TEXTURE_PARAMS): { mean: [number, number, number]; spreadLab: [number, number, number]; samples: number } {
    // the party wall's segments in plan, with their height
    const segs: Array<{ ax: number; az: number; bx: number; bz: number; y0: number; y1: number; nx: number; nz: number }> = [];
    for (const w of walls) for (let q = 0; q + 11 < w.pos.length; q += 12) {
        const p = w.pos;
        // its outward normal in plan, from its winding (base-cleanup.ts winds it to face out): (B - A) x (C - A)
        const u = [p[q + 3] - p[q], p[q + 4] - p[q + 1], p[q + 5] - p[q + 2]], v = [p[q + 6] - p[q], p[q + 7] - p[q + 1], p[q + 8] - p[q + 2]];
        const nx = u[1] * v[2] - u[2] * v[1], nz = u[0] * v[1] - u[1] * v[0], nl = Math.hypot(nx, nz) || 1;
        segs.push({ ax: p[q], az: p[q + 2], bx: p[q + 3], bz: p[q + 5], y0: Math.min(p[q + 1], p[q + 4], p[q + 7], p[q + 10]), y1: Math.max(p[q + 1], p[q + 4], p[q + 7], p[q + 10]), nx: nx / nl, nz: nz / nl });
    }
    // the building's wall at the party wall's height: its vertical surfaces anywhere around it within that height band
    // (right beside a party wall the scan is torn, its edges dark; the masonry at the same storeys reads truer)
    const y0 = Math.min(...segs.map(s => s.y0)) - P.bandM, y1 = Math.max(...segs.map(s => s.y1)) + P.bandM;
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

/** The twin with its party wall drawn as the building's masonry continued by an image model (or as it was, with the reason). */
export async function texturePartyWall(twin: Uint8Array, opts: { client?: EnhanceModelClient; models: string[]; orthosDir?: string; signal?: AbortSignal; progress?: (m: string) => void }, P = PARTY_WALL_TEXTURE_PARAMS): Promise<{ glb: Buffer; report: PartyWallTextureReport }> {
    const g = parseGlbBytes(twin);
    const walls = partyWalls(g);
    const report: PartyWallTextureReport = { walls: walls.length };
    const unchanged = (skipped: string) => ({ glb: Buffer.from(twin), report: { ...report, skipped } });
    if (!walls.length) return unchanged('no party wall in this build');
    if (!opts.client) return unchanged('no image model client in this build\'s services');
    if (!opts.orthosDir) return unchanged('no straightened facade photos to draw the wall from');
    const beside = neighbourColour(g, walls, P);
    if (beside.samples < P.minSamples) return unchanged(`only ${beside.samples} photo texels on the building's wall at its height (at least ${P.minSamples} needed to match a colour)`);
    let y0 = Infinity, y1 = -Infinity;
    for (const w of walls) for (let v = 1; v < w.pos.length; v += 3) { y0 = Math.min(y0, w.pos[v]); y1 = Math.max(y1, w.pos[v]); }
    const refs = references(opts.orthosDir, y0, y1, P);
    if (!refs.length) return unchanged(`no straightened facade photo covers the party wall's storeys (${y0.toFixed(1)} to ${y1.toFixed(1)} m)`);
    opts.progress?.(`party wall: drawing the building's masonry from ${refs.length} of its facade photos`);
    const answer = await opts.client({
        label: 'party-wall', models: opts.models, prompt: partyWallPrompt(P.tileM),
        image: { mimeType: 'image/png', bytes: refs[0].png, width: P.tilePx, height: P.tilePx },
        references: refs.slice(1).map(r => ({ panoId: r.name, mimeType: 'image/png' as const, bytes: r.png })),
        ...(opts.signal ? { signal: opts.signal } : {})
    });
    const map = shrink(decodeImageInMemory(answer.bytes), P.tilePx);
    // tinted: one gain per channel (linear) so the tile's mean is the colour measured on the building's wall
    const px = map.width * map.height, mapMean = [0, 0, 0];
    for (let i = 0; i < px; i++) for (let k = 0; k < 3; k++) mapMean[k] += srgbToLinear(map.rgba[i * 4 + k] / 255) / px;
    const gain = mapMean.map((m, k) => (m > 1e-6 ? beside.mean[k] / m : 1));
    const rgb = new Uint8Array(px * 3);
    for (let i = 0; i < px; i++) for (let k = 0; k < 3; k++) rgb[i * 3 + k] = Math.round(255 * Math.min(1, Math.max(0, linearToSrgb(srgbToLinear(map.rgba[i * 4 + k] / 255) * gain[k]))));
    const png = encodePng(map.width, map.height, rgb, 3);
    const size = P.tileM;
    // the twin rewritten: the tile (drawn to continue across its own edges), a repeating sampler, the material, planar UVs
    const json = g.json;
    const chunks: Uint8Array[] = [g.bin];
    let len = g.bin.length;
    const view = (bytes: Uint8Array, target?: number) => { const pad = (4 - (len % 4)) % 4; if (pad) { chunks.push(new Uint8Array(pad)); len += pad; } json.bufferViews.push({ buffer: 0, byteOffset: len, byteLength: bytes.byteLength, ...(target ? { target } : {}) }); chunks.push(bytes); len += bytes.byteLength; return json.bufferViews.length - 1; };
    json.images ??= []; json.textures ??= []; json.samplers ??= []; json.materials ??= [];
    json.images.push({ bufferView: view(png), mimeType: 'image/png' });
    json.samplers.push({ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 });
    json.textures.push({ source: json.images.length - 1, sampler: json.samplers.length - 1 });
    json.materials.push({ name: 'PartyWall', pbrMetallicRoughness: { baseColorTexture: { index: json.textures.length - 1 }, metallicFactor: 0, roughnessFactor: P.roughness }, doubleSided: true });
    const material = json.materials.length - 1;
    const method = `drawn by ${answer.modelUsed} as this building's masonry continued (a ${size} x ${size} m tile from ${refs.length} of its straightened facade photos at these storeys: ${refs.map(r => r.name).join(', ')}), tinted to the wall colour measured on the building at that height (${beside.samples} photo texels) and repeated`;
    for (const w of walls) {
        const uv = new Float32Array((w.pos.length / 3) * 2);
        for (let q = 0; q + 11 < w.pos.length; q += 12) {
            // along the wall: the quad's bottom edge in plan, from the wall's own origin so neighbouring quads continue
            const dx = w.pos[q + 3] - w.pos[q], dz = w.pos[q + 5] - w.pos[q + 2], l = Math.hypot(dx, dz) || 1;
            for (let k = 0; k < 4; k++) {
                const x = w.pos[q + k * 3], y = w.pos[q + k * 3 + 1], z = w.pos[q + k * 3 + 2];
                uv[(q / 3 + k) * 2] = Math.abs((x * dx + z * dz) / l) / size;
                uv[(q / 3 + k) * 2 + 1] = -y / size;
            }
        }
        json.accessors.push({ bufferView: view(new Uint8Array(uv.buffer), 34962), componentType: 5126, count: uv.length / 2, type: 'VEC2' });
        w.prim.attributes.TEXCOORD_0 = json.accessors.length - 1;
        w.prim.material = material;
        const prov = w.node.extras?.sbBaseSkirt?.provenance;
        if (prov) prov.method = `${prov.method}; ${method}`;
    }
    const pad = (4 - (len % 4)) % 4;
    if (pad) { chunks.push(new Uint8Array(pad)); len += pad; }
    const bin = new Uint8Array(len);
    let o = 0;
    for (const c of chunks) { bin.set(c, o); o += c.length; }
    json.buffers = [{ ...(json.buffers?.[0] ?? {}), byteLength: len }];
    return { glb: assembleGlb(json, bin), report: { ...report, model: answer.modelUsed, tileM: size, references: refs.map(r => r.name), neighbourLinear: beside.mean.map(v => +v.toFixed(4)) as [number, number, number], samples: beside.samples } };
}
