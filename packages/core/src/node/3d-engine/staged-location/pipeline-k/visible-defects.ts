/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Pipeline K's outside check: how much of a textured build looks wrong from outside, as the viewer draws it. Area cannot
 * tell a clay cap inside the shell (never seen) from one across a facade's recess (a grey patch on the building), nor a
 * hole from a recess, so the build is looked at: orthographic views around it (every 45° on the horizon and four
 * diagonals from above), each two depth buffers of the whole model.
 *
 *  - The drawn buffer keeps what the viewer shows: a single-sided triangle only from its front (glTF counter-clockwise),
 *    a double-sided one from either side.
 *  - The raw buffer keeps the nearest triangle whichever way it faces.
 *
 * Per pixel of the building (any triangle in the raw buffer), where the nearest triangle is the back of a photo-textured
 * one (the inside of a wall: tile_refine's twin draws every material double-sided, so the viewer shows that back, the
 * wall's photo seen from inside; the untextured fill is double-sided on purpose and its back is only clay):
 *  - see-through: nothing is drawn there or behind it: the viewer shows the background through the building;
 *  - inside visible: something is drawn (the wall's back itself when double-sided, else what lies behind it): the viewer
 *    shows the building's inside through a hole.
 * Elsewhere:
 *  - clay: the drawn surface's material has no base colour texture (or its primitive no TEXCOORD_0): the stitch, the
 *    seal and the base skirt as the twin draws them, or a scan piece the texture pass did not reach. Texels a photo never
 *    covered but a fill drew (labelled generated in the GLB extras) are textured and do not count;
 *  - smeared (counted in clay too): a textured surface whose texture mapping has (almost) no width, so one line of texels is
 *    drawn across it (a face standing edge-on to the photo it was mapped from): it reads as a flat patch like clay.
 *
 * A hole is found by the back face it shows. Not counted: a hole whose far side has no surface at all (an open sheet seen
 * edge to edge: nothing in either buffer), and one through which the eye meets an inner surface facing outward first (an
 * inner shell, a floor slab seen from above), which is drawn as a front face. The report gives each share per view and
 * over all views, and which nodes the defect pixels belong to. A build over a limit is flagged (the orchestrator degrades
 * it with this report); nothing is changed.
 */

import { nodeWorldMatrices, parseGlbBytes, readAccessor, transformPoint, type ParsedGlb } from '../glb-bytes';

export const VISIBLE_DEFECTS_VERSION = 'visible-defects/2';

export const VISIBLE_DEFECTS_PARAMS = {
    /** Pixels along each view's longer side, when pixelM is 0. */
    resolution: 768,
    /** The pixel's size (m) when above 0: a hole or a slit narrower than a pixel is not seen, so a fixed size, not a share of the build. */
    pixelM: 0.15,
    /** At most this many pixels in a view (the pixel grows past pixelM on a larger build); the ESB at 0.15 m is about 2.6 M. */
    maxViewPixels: 4_000_000,
    /** Depths within this (m) are a tie (a shared edge, a corner): the front face wins, so a closed shell shows no back face. */
    tieM: 0.05,
    /** Horizon views every this many degrees of azimuth. */
    azimuthStepDeg: 45,
    /** The views from above: this elevation, at the four diagonals. */
    aboveElevationDeg: 35,
    /** Over these shares of the building's pixels, over all views, the build is flagged. */
    maxClayShare: 0.01,
    maxHoleShare: 0.01,
    /** Over these shares in any one view, the build is flagged too (a clay band or a row of holes on one face). */
    maxViewClayShare: 0.03,
    maxViewHoleShare: 0.03,
    /** A textured triangle is smeared when its texture mapping, in texels, stretches one way less than this share of the other. */
    smearRatio: 0.05
};
export type VisibleDefectsParams = typeof VISIBLE_DEFECTS_PARAMS;

/** Per pixel of a view: 0 background, 1 good, 2 clay, 3 inside visible, 4 see-through. */
export const DEFECT = { background: 0, good: 1, clay: 2, inside: 3, seeThrough: 4 } as const;

export interface DefectCounts { building: number; clay: number; inside: number; seeThrough: number; /** Of clay: textured but smeared. */ smear: number }
export interface VisibleDefectsView extends DefectCounts {
    azimuthDeg: number; elevationDeg: number;
    clayShare: number; holeShare: number;
    /** With keepMasks: the view's classes (DEFECT), row 0 at the top. */
    mask?: { width: number; height: number; data: Uint8Array };
}
export interface VisibleDefectsReport extends DefectCounts {
    version: string;
    views: VisibleDefectsView[];
    /** Clay and holes (inside visible + see-through) over the building's pixels, all views. */
    clayShare: number;
    holeShare: number;
    maxViewClayShare: number;
    maxViewHoleShare: number;
    /** Smeared pixels (counted in clay) over the building's pixels, all views. */
    smearShare: number;
    /** Defect pixels by node name (all views): clay (smears included) by the drawn surface's node, holes by the back face's node. */
    byNode: { clay: Record<string, number>; holes: Record<string, number>; smear: Record<string, number> };
    flagged: boolean;
    why: string;
}

interface Soup { pos: Float32Array; clay: Uint8Array; smear: Uint8Array; twoSided: Uint8Array; node: Int32Array; names: string[] }

/** An embedded image's size in pixels (PNG or JPEG header), or undefined (a URI, another format). */
export function embeddedImageSize(glb: ParsedGlb, image: number): { width: number; height: number } | undefined {
    const view = glb.json.images?.[image]?.bufferView;
    if (view === undefined) return undefined;
    const bv = glb.json.bufferViews[view], b = glb.bin.subarray(bv.byteOffset ?? 0, (bv.byteOffset ?? 0) + bv.byteLength);
    const be16 = (o: number) => (b[o] << 8) | b[o + 1], be32 = (o: number) => ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
    if (b.length >= 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { width: be32(16), height: be32(20) };
    if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
        // the frame header: the first start-of-frame marker (C0-CF, not C4 DHT, C8 JPG, CC DAC)
        for (let o = 2; o + 9 < b.length;) {
            if (b[o] !== 0xff) { o++; continue; }
            const m = b[o + 1];
            if (m === 0xff) { o++; continue; }
            if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { width: be16(o + 7), height: be16(o + 5) };
            if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { o += 2; continue; }
            o += 2 + be16(o + 2);
        }
    }
    return undefined;
}

/** Whether a triangle's texture mapping has (almost) no width: the smaller singular value of its texel-per-metre map (uv in
 * texels, so a long thin image is not mistaken for a smear) under ratio x the larger. */
export function smearedMapping(p: ArrayLike<number>, uv: ArrayLike<number>, ratio: number): boolean {
    const e1 = [p[3] - p[0], p[4] - p[1], p[5] - p[2]], e2 = [p[6] - p[0], p[7] - p[1], p[8] - p[2]];
    const l1 = Math.hypot(e1[0], e1[1], e1[2]);
    if (!(l1 > 0)) return false;
    // the triangle in its own plane: (l1, 0) and (bx, by)
    const bx = (e2[0] * e1[0] + e2[1] * e1[1] + e2[2] * e1[2]) / l1, by = Math.sqrt(Math.max(0, e2[0] ** 2 + e2[1] ** 2 + e2[2] ** 2 - bx * bx));
    if (!(by > 1e-9 * l1)) return false;
    const du1 = uv[2] - uv[0], dv1 = uv[3] - uv[1], du2 = uv[4] - uv[0], dv2 = uv[5] - uv[1];
    // J maps plane coordinates to uv: J (l1, 0) = (du1, dv1), J (bx, by) = (du2, dv2)
    const j00 = du1 / l1, j10 = dv1 / l1, j01 = (du2 - j00 * bx) / by, j11 = (dv2 - j10 * bx) / by;
    const a = j00 * j00 + j10 * j10, b = j00 * j01 + j10 * j11, c = j01 * j01 + j11 * j11;
    const root = Math.sqrt(Math.max(0, ((a - c) / 2) ** 2 + b * b)), hi = (a + c) / 2 + root, lo = Math.max(0, (a + c) / 2 - root);
    return hi <= 0 || Math.sqrt(lo) < ratio * Math.sqrt(hi);
}

/** Every triangle of the scene in world space: whether its material is untextured, whether it is drawn from both sides, its node. */
function readSoup(glb: ParsedGlb, smearRatio: number): Soup {
    const json = glb.json;
    const world = nodeWorldMatrices(json);
    const textured = (json.materials ?? []).map((m: any) => m?.pbrMetallicRoughness?.baseColorTexture !== undefined);
    // texels per uv unit of each material's base colour image (1 x 1 when its size cannot be read)
    const texels = (json.materials ?? []).map((m: any) => {
        const tex = m?.pbrMetallicRoughness?.baseColorTexture?.index, img = tex !== undefined ? json.textures?.[tex]?.source : undefined;
        const sz = img !== undefined ? embeddedImageSize(glb, img) : undefined;
        return sz ? [sz.width, sz.height] : [1, 1];
    });
    const doubleSided = (json.materials ?? []).map((m: any) => m?.doubleSided === true);
    const pos: number[] = [], clay: number[] = [], smear: number[] = [], twoSided: number[] = [], node: number[] = [], names: string[] = [];
    (json.nodes ?? []).forEach((n: any, ni: number) => {
        if (n.mesh === undefined) return;
        const name = n.name ?? json.meshes[n.mesh]?.name ?? `node ${ni}`;
        let ix = names.indexOf(name);
        if (ix < 0) { ix = names.length; names.push(name); }
        const m = world[ni];
        // a mirroring node transform turns the winding over
        const det = m[0] * (m[5] * m[10] - m[6] * m[9]) - m[4] * (m[1] * m[10] - m[2] * m[9]) + m[8] * (m[1] * m[6] - m[2] * m[5]);
        for (const p of json.meshes[n.mesh]?.primitives ?? []) {
            if ((p.mode ?? 4) !== 4 || p.attributes?.POSITION === undefined) continue;
            const P = readAccessor(glb, p.attributes.POSITION).data;
            const I = p.indices !== undefined ? readAccessor(glb, p.indices).data : Float64Array.from({ length: P.length / 3 }, (_, i) => i);
            const isClay = !(p.material !== undefined && textured[p.material] && p.attributes.TEXCOORD_0 !== undefined);
            const isTwoSided = p.material !== undefined && doubleSided[p.material];
            const UV = isClay ? undefined : readAccessor(glb, p.attributes.TEXCOORD_0).data;
            for (let t = 0; t + 2 < I.length; t += 3) {
                const order = det < 0 ? [0, 2, 1] : [0, 1, 2];
                for (const k of order) { const v = I[t + k]; pos.push(...transformPoint(m, P[v * 3], P[v * 3 + 1], P[v * 3 + 2])); }
                const tri = [0, 1, 2].map(k => I[t + k]);
                const tx = texels[p.material] ?? [1, 1];
                const smeared = !!UV && smearedMapping(tri.flatMap(v => [P[v * 3], P[v * 3 + 1], P[v * 3 + 2]]), tri.flatMap(v => [UV[v * 2] * tx[0], UV[v * 2 + 1] * tx[1]]), smearRatio);
                clay.push(isClay ? 1 : 0); smear.push(smeared ? 1 : 0); twoSided.push(isTwoSided ? 1 : 0); node.push(ix);
            }
        }
    });
    return { pos: Float32Array.from(pos), clay: Uint8Array.from(clay), smear: Uint8Array.from(smear), twoSided: Uint8Array.from(twoSided), node: Int32Array.from(node), names };
}

/** One orthographic view: per pixel the nearest triangle drawn and the nearest triangle at all, then the class. */
function renderView(s: Soup, azimuthDeg: number, elevationDeg: number, P: VisibleDefectsParams, byClay: number[], byHole: number[], bySmear: number[], keepMask: boolean): VisibleDefectsView {
    const az = (azimuthDeg * Math.PI) / 180, el = (elevationDeg * Math.PI) / 180;
    // toward the viewer (y up); right and up of the image
    const d = [Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az)];
    const r0 = [d[2], 0, -d[0]], rl = Math.hypot(r0[0], r0[2]) || 1, r = [r0[0] / rl, 0, r0[2] / rl];
    const u = [d[1] * r[2] - d[2] * r[1], d[2] * r[0] - d[0] * r[2], d[0] * r[1] - d[1] * r[0]];
    const n = s.pos.length / 3;
    const X = new Float32Array(n), Y = new Float32Array(n), Z = new Float32Array(n);
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (let i = 0; i < n; i++) {
        const px = s.pos[i * 3], py = s.pos[i * 3 + 1], pz = s.pos[i * 3 + 2];
        X[i] = px * r[0] + py * r[1] + pz * r[2]; Y[i] = px * u[0] + py * u[1] + pz * u[2]; Z[i] = px * d[0] + py * d[1] + pz * d[2];
        if (X[i] < x0) x0 = X[i]; if (X[i] > x1) x1 = X[i]; if (Y[i] < y0) y0 = Y[i]; if (Y[i] > y1) y1 = Y[i];
    }
    const ext = Math.max(x1 - x0, y1 - y0, 1e-6);
    const px = Math.max(P.pixelM > 0 ? P.pixelM : ext / P.resolution, Math.sqrt(((x1 - x0) * (y1 - y0)) / P.maxViewPixels));
    const W = Math.max(1, Math.ceil((x1 - x0) / px) + 1), H = Math.max(1, Math.ceil((y1 - y0) / px) + 1);
    const drawnZ = new Float32Array(W * H).fill(-Infinity), drawn = new Int32Array(W * H).fill(-1);
    const rawZ = new Float32Array(W * H).fill(-Infinity), raw = new Int32Array(W * H).fill(-1), rawBack = new Uint8Array(W * H);
    for (let t = 0; t < n / 3; t++) {
        const a = t * 3, b = a + 1, c = a + 2;
        const S = [(X[a] - x0) / px, (X[b] - x0) / px, (X[c] - x0) / px], T = [(Y[a] - y0) / px, (Y[b] - y0) / px, (Y[c] - y0) / px];
        const area = (S[1] - S[0]) * (T[2] - T[0]) - (S[2] - S[0]) * (T[1] - T[0]);
        if (Math.abs(area) < 1e-12) continue;
        // image x right, y up, toward the viewer: counter-clockwise in the image is the front
        const back = area < 0, shown = !back || s.twoSided[t] === 1;
        const sx0 = Math.max(0, Math.ceil(Math.min(S[0], S[1], S[2]))), sx1 = Math.min(W - 1, Math.floor(Math.max(S[0], S[1], S[2])));
        const sy0 = Math.max(0, Math.ceil(Math.min(T[0], T[1], T[2]))), sy1 = Math.min(H - 1, Math.floor(Math.max(T[0], T[1], T[2])));
        for (let y = sy0; y <= sy1; y++) for (let x = sx0; x <= sx1; x++) {
            const w1 = ((x - S[0]) * (T[2] - T[0]) - (S[2] - S[0]) * (y - T[0])) / area, w2 = ((S[1] - S[0]) * (y - T[0]) - (x - S[0]) * (T[1] - T[0])) / area, w0 = 1 - w1 - w2;
            if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) continue;
            const z = w0 * Z[a] + w1 * Z[b] + w2 * Z[c], o = y * W + x;
            // the inside of the building: a photo-textured surface seen from behind, drawn (double-sided) or not; the
            // untextured fill is double-sided on purpose and has no inside, so its back is only clay
            const inner = back && s.clay[t] !== 1;
            if (raw[o] < 0 || (inner ? z > rawZ[o] + P.tieM : z > rawZ[o] || (rawBack[o] === 1 && z > rawZ[o] - P.tieM))) { rawZ[o] = z; raw[o] = t; rawBack[o] = inner ? 1 : 0; }
            if (shown && z > drawnZ[o]) { drawnZ[o] = z; drawn[o] = t; }
        }
    }
    const counts: DefectCounts = { building: 0, clay: 0, inside: 0, seeThrough: 0, smear: 0 };
    const mask = keepMask ? new Uint8Array(W * H) : undefined;
    for (let o = 0; o < raw.length; o++) {
        if (raw[o] < 0) continue;
        counts.building++;
        let k: number = DEFECT.good;
        // a hole lies within the building's image: on its outline a back face only meets the front at their shared edge
        const x = o % W, y = Math.floor(o / W);
        const within = x > 0 && x < W - 1 && y > 0 && y < H - 1 && raw[o - 1] >= 0 && raw[o + 1] >= 0 && raw[o - W] >= 0 && raw[o + W] >= 0;
        if (rawBack[o] && within) { k = drawn[o] < 0 ? DEFECT.seeThrough : DEFECT.inside; byHole[s.node[raw[o]]]++; }
        else if (drawn[o] >= 0 && (s.clay[drawn[o]] || s.smear[drawn[o]])) {
            k = DEFECT.clay; byClay[s.node[drawn[o]]]++;
            if (s.smear[drawn[o]]) { counts.smear++; bySmear[s.node[drawn[o]]]++; }
        }
        if (k === DEFECT.clay) counts.clay++; else if (k === DEFECT.inside) counts.inside++; else if (k === DEFECT.seeThrough) counts.seeThrough++;
        // flipped to row 0 at the top
        if (mask) mask[(H - 1 - Math.floor(o / W)) * W + (o % W)] = k;
    }
    const b = Math.max(1, counts.building);
    return {
        azimuthDeg, elevationDeg, ...counts, clayShare: counts.clay / b, holeShare: (counts.inside + counts.seeThrough) / b,
        ...(mask ? { mask: { width: W, height: H, data: mask } } : {})
    };
}

/** The visible defects of a textured build (GLB bytes), from views around it and above it. */
export function measureVisibleDefects(bytes: Uint8Array, P: VisibleDefectsParams = VISIBLE_DEFECTS_PARAMS, opts: { keepMasks?: boolean } = {}): VisibleDefectsReport {
    const s = readSoup(parseGlbBytes(bytes), P.smearRatio);
    const byClay = new Array<number>(s.names.length).fill(0), byHole = new Array<number>(s.names.length).fill(0), bySmear = new Array<number>(s.names.length).fill(0);
    const views: VisibleDefectsView[] = [];
    for (let az = 0; az < 360; az += P.azimuthStepDeg) views.push(renderView(s, az, 0, P, byClay, byHole, bySmear, opts.keepMasks === true));
    for (const az of [45, 135, 225, 315]) views.push(renderView(s, az, P.aboveElevationDeg, P, byClay, byHole, bySmear, opts.keepMasks === true));
    const sum = (k: keyof DefectCounts) => views.reduce((a, v) => a + v[k], 0);
    const counts: DefectCounts = { building: sum('building'), clay: sum('clay'), inside: sum('inside'), seeThrough: sum('seeThrough'), smear: sum('smear') };
    const b = Math.max(1, counts.building);
    const clayShare = counts.clay / b, holeShare = (counts.inside + counts.seeThrough) / b;
    const maxViewClayShare = Math.max(0, ...views.map(v => v.clayShare)), maxViewHoleShare = Math.max(0, ...views.map(v => v.holeShare));
    const named = (c: number[]) => { const o: Record<string, number> = {}; s.names.forEach((nm, i) => { if (c[i]) o[nm] = c[i]; }); return o; };
    const byNode = { clay: named(byClay), holes: named(byHole), smear: named(bySmear) };
    const pct = (x: number) => `${(x * 100).toFixed(2)}%`;
    const top = (c: Record<string, number>, total: number) => Object.entries(c).sort((x, y) => y[1] - x[1]).slice(0, 3).map(([k, v]) => `${k} ${pct(v / Math.max(1, total))}`).join(', ');
    const worst = (k: 'clayShare' | 'holeShare') => views.reduce((a, v) => (v[k] > a[k] ? v : a), views[0]);
    const wc = worst('clayShare'), wh = worst('holeShare');
    const flagged = clayShare > P.maxClayShare || holeShare > P.maxHoleShare || maxViewClayShare > P.maxViewClayShare || maxViewHoleShare > P.maxViewHoleShare;
    const why = `from ${views.length} views, ${pct(clayShare)} of the building is seen untextured (limit ${pct(P.maxClayShare)}; worst view ${pct(maxViewClayShare)} at ${wc.azimuthDeg}°/${wc.elevationDeg}°)` +
        `${counts.clay ? `, from ${top(byNode.clay, counts.clay)}` : ''}${counts.smear ? ` (${pct(counts.smear / b)} textured but smeared, from ${top(byNode.smear, counts.smear)})` : ''}; ${pct(holeShare)} through holes: ${pct(counts.inside / b)} showing the inside, ${pct(counts.seeThrough / b)} see-through (limit ${pct(P.maxHoleShare)}; worst view ${pct(maxViewHoleShare)} at ${wh.azimuthDeg}°/${wh.elevationDeg}°)` +
        `${counts.inside + counts.seeThrough ? `, at the back faces of ${top(byNode.holes, counts.inside + counts.seeThrough)}` : ''}`;
    return { version: VISIBLE_DEFECTS_VERSION, views, ...counts, clayShare, holeShare, smearShare: counts.smear / b, maxViewClayShare, maxViewHoleShare, byNode, flagged, why };
}
