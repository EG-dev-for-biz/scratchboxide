/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/


import * as THREE from 'three';
import type { TreeCrownExtras } from '../../../../../common/spatial/staged-location-contracts';

/**
 * Soft crown ("envelope") shading for the leaves of a tree. The trees GLB carries, per tree, the crown of its delivered
 * leaves (extras sbTree.crown, written by the native trees writer): an ellipsoid, and where the writer found them its lobes,
 * a smooth union of spheres (smooth minimum with blend radius lobeBlendM), so a crown keeps its real bulges. The shape used
 * is the lobes when present (and lobes are on), else the ellipsoid. Two effects, with factors per detail slot (near,
 * near-mid, mid, far): occlusion darkens a leaf's diffuse colour toward the crown's underside and core (no normal changes,
 * so near leaves keep their own outline, fold and lighting), and the coarser slots also blend their normal toward the
 * crown's normal (its gradient), tilted a little toward the sky, so cards and blob masses read as soft volumes. Wood is
 * never touched.
 *
 * Leaf clusters are instanced and their geometry is shared by every tree, so nothing is baked: each leaf mesh gets a light
 * geometry of its own that shares the cluster's buffers and adds the crown as four instanced attributes with a divisor
 * past the instance count (one value for the whole mesh, i.e. per tree and level), in the mesh's own frame: the ellipsoid
 * as a quadric (centre c and symmetric matrix S, gradient S (x - c)) and where the lobes are, a block of a shared float
 * texture (one texel a lobe, in the mesh's frame) with the blend radius. The normal matrix then takes the gradient to view
 * space as it does a normal. The detail slot is the centre's w, and picks the factors from shared uniforms, so they are
 * adjustable at run time for every tree at once.
 *
 * The leaf material is a variant of the mesh's base (the shared clay, or the loader's material) that only leaf meshes
 * wear; the dither variants of treeLodFade are made from it, so a crossfade keeps the soft shading. The variant keeps every
 * property of its base (it is a clone): colour, maps, alpha test, transparency, side. At a level that blends, a card's own
 * normal is first turned to face the crown normal and the fragment stage does not flip the normal of a back face, so the
 * underside of a card is not dark; at a level that does not blend (the near level by default), three's own flip applies.
 */

/** A factor per detail slot: near, near-mid, mid, far (a trees-lod/1 file's levels use slots 0, 2, 3). */
export type CrownSlotFactors = [number, number, number, number];

export interface CrownShadingOptions {
    /** Off: leaves wear the plain base material (for comparison). */
    enabled: boolean;
    /** Share of the crown normal in the leaf normal per detail slot (near, near-mid, mid, far). */
    blend: CrownSlotFactors;
    /** How far the crown normal tilts toward world up (added to the unit normal before renormalising). */
    skyBias: number;
    /** Amplitude of the per-leaf normal noise per slot (only where the slot blends), so a crown does not read as a balloon. */
    noise: CrownSlotFactors;
    /**
     * Share of the crown occlusion in the leaf's diffuse colour per slot: leaves on the crown's underside and in its core
     * are darkened, leaves on its sky side are not. It changes no normal, so a leaf keeps its own shape and fold.
     */
    occlusion: CrownSlotFactors;
    /** Use the crown's lobes (a smooth union of spheres) where the file has them; off, every tree uses its ellipsoid. */
    lobes: boolean;
    /** Ragged silhouettes, holes and clump value variation of the leaves (treeCrownBreakup below). */
    breakup: CrownBreakupOptions;
}

/**
 * Breaking up a crown that would read as a smooth ball. Every quantity is continuous; the noise is a function of the world
 * point (in metres: the tree frame's units), so every level of a tree, and the shadow pass, decide the same at the same point.
 *
 * - Holes: a fragment is discarded where a band-limited world-space value noise (two octaves, at the clump scale and
 *   `coarseOctave` times it) falls below a hole share: `holes` (per slot) weighted toward the crown's rim (1 on and
 *   outside the crown's surface, falling to 0 at `rimWidth` mean lobe radii inside it, from the crown field) plus `pockets`
 *   (per slot) where a third, coarser octave rises (a few interior gaps). The edge of a hole is dithered over `edgeSoftness`
 *   of the noise range. Each octave fades out (its share of the holes with it) as the pixel footprint grows from
 *   `filterStart` to `filterEnd` of its period, so a distant crown keeps only the holes the screen can resolve (no shimmer).
 * - Clumps: cellular (Worley) noise at the clump scale brightens the top of each clump (`clumpTop`, by its height above the
 *   cell's feature point) and darkens the crevices between clumps (`clumpCrevice`), faded like the fine octave; `clump`
 *   (per slot) is its share (by default the mid and far levels only: the near levels' leaves have their own light and
 *   shade, and their fragments are the most numerous). A lobe-scale value noise (`lobeVariation`) and a per-tree value
 *   (`treeVariation`) vary the grey, with `tone` (per slot) their share (all but the near level by default). It multiplies the diffuse colour with the crown occlusion, so it works in clay (one grey) and textured alike.
 * - Inside a blob mass (the far level's closed foliage, seen through a hole from its back face) the diffuse colour is
 *   darkened by `gapDarkening`, so a hole reads as a dark gap.
 * The clump scale is clamp(clumpPerCrownRadius x the crown's mean radius, clumpMinM, clumpMaxM) metres.
 */
export interface CrownBreakupOptions {
    /** Off: no holes and no clump variation (for comparison). */
    enabled: boolean;
    holes: CrownSlotFactors;
    pockets: CrownSlotFactors;
    clump: CrownSlotFactors;
    /** Share of the lobe-scale and per-tree grey variation per slot. */
    tone: CrownSlotFactors;
    /** Share of the holes the shadow pass draws (0 casts solid crowns and skips the noise there; 1 the same holes as the leaves). */
    shadowHoles: number;
    clumpPerCrownRadius: number;
    clumpMinM: number;
    clumpMaxM: number;
    coarseOctave: number;
    rimWidth: number;
    edgeSoftness: number;
    filterStart: number;
    filterEnd: number;
    gapDarkening: number;
    clumpTop: number;
    clumpCrevice: number;
    lobeVariation: number;
    treeVariation: number;
}

export const DEFAULT_CROWN_BREAKUP: Readonly<CrownBreakupOptions> = Object.freeze<CrownBreakupOptions>({
    enabled: true, holes: [0, 0, 0.5, 0.55], pockets: [0, 0, 0.18, 0.2], clump: [0, 0, 1, 1], tone: [0, 1, 1, 1], shadowHoles: 1,
    clumpPerCrownRadius: 0.28, clumpMinM: 0.8, clumpMaxM: 1.5, coarseOctave: 2.7, rimWidth: 0.9, edgeSoftness: 0.05,
    filterStart: 0.25, filterEnd: 0.6, gapDarkening: 0.55, clumpTop: 0.2, clumpCrevice: 0.22, lobeVariation: 0.1, treeVariation: 0.07
});

export const DEFAULT_CROWN_SHADING: Readonly<CrownShadingOptions> = Object.freeze<CrownShadingOptions>({
    enabled: true, blend: [0, 0.45, 0.9, 0.75], skyBias: 0.18, noise: [0, 0.06, 0.12, 0.06], occlusion: [0.6, 0.55, 0.45, 0.4], lobes: true,
    breakup: DEFAULT_CROWN_BREAKUP
});

/** Lobes per mesh are read from a float texture LOBE_TEX_WIDTH texels wide (one RGBA texel a lobe: centre xyz, radius). */
export const LOBE_TEX_WIDTH = 1024;
/** The most lobes the shader reads for one mesh (the contract allows 16). */
export const MAX_SHADER_LOBES = 16;

function makeLobeTexture(data: Float32Array, rows: number): THREE.DataTexture {
    const t = new THREE.DataTexture(data, LOBE_TEX_WIDTH, rows, THREE.RGBAFormat, THREE.FloatType);
    t.minFilter = t.magFilter = THREE.NearestFilter;
    t.generateMipmaps = false;
    t.needsUpdate = true;
    return t;
}

const lobeAtlas = { data: new Float32Array(LOBE_TEX_WIDTH * 4), rows: 1, used: 0, holders: 0 };

const uniforms = {
    uSbCrownBlend: { value: new THREE.Vector4(...DEFAULT_CROWN_SHADING.blend) },
    uSbCrownNoise: { value: new THREE.Vector4(...DEFAULT_CROWN_SHADING.noise) },
    uSbCrownOcclusion: { value: new THREE.Vector4(...DEFAULT_CROWN_SHADING.occlusion) },
    uSbCrownSky: { value: DEFAULT_CROWN_SHADING.skyBias },
    uSbCrownUseLobes: { value: 1 },
    uSbCrownLobes: { value: makeLobeTexture(lobeAtlas.data, lobeAtlas.rows) },
    uSbBkOn: { value: 1 },
    uSbBkHoles: { value: new THREE.Vector4(...DEFAULT_CROWN_BREAKUP.holes) },
    uSbBkPockets: { value: new THREE.Vector4(...DEFAULT_CROWN_BREAKUP.pockets) },
    uSbBkClump: { value: new THREE.Vector4(...DEFAULT_CROWN_BREAKUP.clump) },
    uSbBkTone: { value: new THREE.Vector4(...DEFAULT_CROWN_BREAKUP.tone) },
    // clumpPerCrownRadius, clumpMinM, clumpMaxM, rimWidth
    uSbBkShape: { value: new THREE.Vector4(DEFAULT_CROWN_BREAKUP.clumpPerCrownRadius, DEFAULT_CROWN_BREAKUP.clumpMinM, DEFAULT_CROWN_BREAKUP.clumpMaxM, DEFAULT_CROWN_BREAKUP.rimWidth) },
    // edgeSoftness, filterStart, filterEnd, gapDarkening
    uSbBkFilter: { value: new THREE.Vector4(DEFAULT_CROWN_BREAKUP.edgeSoftness, DEFAULT_CROWN_BREAKUP.filterStart, DEFAULT_CROWN_BREAKUP.filterEnd, DEFAULT_CROWN_BREAKUP.gapDarkening) },
    // clumpTop, clumpCrevice, lobeVariation, treeVariation
    uSbBkValue: { value: new THREE.Vector4(DEFAULT_CROWN_BREAKUP.clumpTop, DEFAULT_CROWN_BREAKUP.clumpCrevice, DEFAULT_CROWN_BREAKUP.lobeVariation, DEFAULT_CROWN_BREAKUP.treeVariation) },
    uSbBkOctave: { value: DEFAULT_CROWN_BREAKUP.coarseOctave },
    uSbBkShadowHoles: { value: DEFAULT_CROWN_BREAKUP.shadowHoles }
};

/** The uniforms every crown variant shares (one set for all trees). */
export const crownShadingUniforms = (): Readonly<typeof uniforms> => uniforms;

/** A controller holding lobes in the shared atlas; when the last one lets go the atlas is emptied. */
export function retainCrownLobeAtlas(): void { lobeAtlas.holders++; }
export function releaseCrownLobeAtlas(): void {
    lobeAtlas.holders = Math.max(0, lobeAtlas.holders - 1);
    if (lobeAtlas.holders === 0) lobeAtlas.used = 0;
}

/** Writes lobes (centre xyz, radius each) into the shared atlas and returns the index of the first. */
export function allocateCrownLobes(lobes: ReadonlyArray<readonly [number, number, number, number]>): number {
    const start = lobeAtlas.used;
    const need = start + lobes.length;
    if (need > lobeAtlas.rows * LOBE_TEX_WIDTH) {
        let rows = lobeAtlas.rows;
        while (rows * LOBE_TEX_WIDTH < need) rows *= 2;
        const data = new Float32Array(rows * LOBE_TEX_WIDTH * 4);
        data.set(lobeAtlas.data);
        lobeAtlas.data = data;
        lobeAtlas.rows = rows;
        uniforms.uSbCrownLobes.value.dispose();
        uniforms.uSbCrownLobes.value = makeLobeTexture(data, rows);
    }
    lobes.forEach((l, i) => lobeAtlas.data.set([l[0], l[1], l[2], l[3]], (start + i) * 4));
    lobeAtlas.used = need;
    uniforms.uSbCrownLobes.value.needsUpdate = true;
    return start;
}

/** The atlas's lobes from `start` (tests, diagnostics). */
export function crownLobesAt(start: number, count: number): Array<[number, number, number, number]> {
    return Array.from({ length: count }, (_, i) => Array.from(lobeAtlas.data.subarray((start + i) * 4, (start + i) * 4 + 4)) as [number, number, number, number]);
}

/** Writes the adjustable factors into the shared uniforms (clamped to their meaningful ranges). */
export function setCrownShadingUniforms(o: Pick<CrownShadingOptions, 'blend' | 'skyBias' | 'noise' | 'occlusion'> & Partial<Pick<CrownShadingOptions, 'lobes' | 'breakup' | 'enabled'>>): void {
    const c01 = (x: number) => Math.min(1, Math.max(0, Number.isFinite(x) ? x : 0));
    const pos = (x: number) => Math.max(0, Number.isFinite(x) ? x : 0);
    uniforms.uSbCrownBlend.value.set(...(o.blend.map(c01) as CrownSlotFactors));
    uniforms.uSbCrownNoise.value.set(...(o.noise.map(pos) as CrownSlotFactors));
    uniforms.uSbCrownOcclusion.value.set(...(o.occlusion.map(c01) as CrownSlotFactors));
    uniforms.uSbCrownSky.value = pos(o.skyBias);
    uniforms.uSbCrownUseLobes.value = o.lobes === false ? 0 : 1;
    const b = o.breakup ?? DEFAULT_CROWN_BREAKUP;
    // the depth materials (shadows) wear the breakup whatever the leaf material: off with the crown shading too
    uniforms.uSbBkOn.value = b.enabled && o.enabled !== false ? 1 : 0;
    uniforms.uSbBkHoles.value.set(...(b.holes.map(c01) as CrownSlotFactors));
    uniforms.uSbBkPockets.value.set(...(b.pockets.map(c01) as CrownSlotFactors));
    uniforms.uSbBkClump.value.set(...(b.clump.map(c01) as CrownSlotFactors));
    uniforms.uSbBkTone.value.set(...(b.tone.map(c01) as CrownSlotFactors));
    const minM = Math.max(0.01, pos(b.clumpMinM));
    uniforms.uSbBkShape.value.set(pos(b.clumpPerCrownRadius), minM, Math.max(minM, pos(b.clumpMaxM)), Math.max(1e-3, pos(b.rimWidth)));
    const fs = pos(b.filterStart);
    uniforms.uSbBkFilter.value.set(pos(b.edgeSoftness), fs, Math.max(fs + 1e-3, pos(b.filterEnd)), c01(b.gapDarkening));
    uniforms.uSbBkValue.value.set(pos(b.clumpTop), c01(b.clumpCrevice), c01(b.lobeVariation), c01(b.treeVariation));
    uniforms.uSbBkOctave.value = Math.max(1.01, pos(b.coarseOctave));
    uniforms.uSbBkShadowHoles.value = c01(b.shadowHoles);
}

/** An override of the breakup: the per-slot factors as four numbers (near, near-mid, mid, far) or three (near, mid, far). */
export type CrownBreakupInput = Partial<Omit<CrownBreakupOptions, 'holes' | 'pockets' | 'clump' | 'tone'> & { holes: readonly number[]; pockets: readonly number[]; clump: readonly number[]; tone: readonly number[] }>;

/** An override of the options: the per-slot factors as four numbers (near, near-mid, mid, far) or three (near, mid, far). */
export type CrownShadingInput = Partial<Omit<CrownShadingOptions, 'blend' | 'noise' | 'occlusion' | 'breakup'> & { blend: readonly number[]; noise: readonly number[]; occlusion: readonly number[]; breakup: CrownBreakupInput }>;

/**
 * Factors per slot from an override: four numbers (near, near-mid, mid, far), or three in the old order (near, mid, far)
 * with the near-mid slot halfway between near and mid; anything else is the default.
 */
function slotFactors(v: unknown, def: readonly number[]): CrownSlotFactors {
    const ok = Array.isArray(v) && v.every(x => typeof x === 'number' && Number.isFinite(x));
    if (ok && v.length === 4) return [v[0], v[1], v[2], v[3]];
    if (ok && v.length === 3) return [v[0], 0.5 * (v[0] + v[1]), v[1], v[2]];
    return [def[0], def[1], def[2], def[3]];
}

/** Options completed from the defaults (a partial override from scene data or a console hook). */
export function resolveCrownShading(o: CrownShadingInput | undefined | null): CrownShadingOptions {
    const d = DEFAULT_CROWN_SHADING;
    return {
        enabled: o?.enabled ?? d.enabled,
        blend: slotFactors(o?.blend, d.blend),
        skyBias: typeof o?.skyBias === 'number' && Number.isFinite(o.skyBias) ? o.skyBias : d.skyBias,
        noise: slotFactors(o?.noise, d.noise),
        occlusion: slotFactors(o?.occlusion, d.occlusion),
        lobes: o?.lobes ?? d.lobes,
        breakup: resolveCrownBreakup(o?.breakup)
    };
}

/** Breakup options completed from the defaults. */
export function resolveCrownBreakup(o: CrownBreakupInput | undefined | null): CrownBreakupOptions {
    const d = DEFAULT_CROWN_BREAKUP;
    const num = (v: unknown, def: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : def);
    return {
        enabled: o?.enabled ?? d.enabled,
        holes: slotFactors(o?.holes, d.holes), pockets: slotFactors(o?.pockets, d.pockets), clump: slotFactors(o?.clump, d.clump), tone: slotFactors(o?.tone, d.tone), shadowHoles: num(o?.shadowHoles, d.shadowHoles),
        clumpPerCrownRadius: num(o?.clumpPerCrownRadius, d.clumpPerCrownRadius), clumpMinM: num(o?.clumpMinM, d.clumpMinM), clumpMaxM: num(o?.clumpMaxM, d.clumpMaxM),
        coarseOctave: num(o?.coarseOctave, d.coarseOctave), rimWidth: num(o?.rimWidth, d.rimWidth), edgeSoftness: num(o?.edgeSoftness, d.edgeSoftness),
        filterStart: num(o?.filterStart, d.filterStart), filterEnd: num(o?.filterEnd, d.filterEnd), gapDarkening: num(o?.gapDarkening, d.gapDarkening),
        clumpTop: num(o?.clumpTop, d.clumpTop), clumpCrevice: num(o?.clumpCrevice, d.clumpCrevice), lobeVariation: num(o?.lobeVariation, d.lobeVariation),
        treeVariation: num(o?.treeVariation, d.treeVariation)
    };
}

/** The factors the shader picks for a detail slot (0 near .. 3 far), from the shared uniforms (mirrors the GLSL). */
export function crownLevelFactors(slot: number): { blend: number; noise: number; occlusion: number } {
    const k = slot < 0.5 ? 'x' : slot < 1.5 ? 'y' : slot < 2.5 ? 'z' : 'w';
    return { blend: uniforms.uSbCrownBlend.value[k], noise: uniforms.uSbCrownNoise.value[k], occlusion: uniforms.uSbCrownOcclusion.value[k] };
}

/**
 * The crown ellipsoid as a quadric in a mesh's own frame. `meshToTree` maps the mesh's frame (where its instance matrices
 * put the vertices) into the tree node's frame (where the crown is). Returns the centre (xyz, w = detail slot) and the
 * symmetric matrix S as its diagonal (xx, yy, zz) and off-diagonal (xy, xz, yz), unscaled: (x - c)^T S (x - c) is 1 on the
 * ellipsoid, which the occlusion reads as the depth inside the crown, and S (x - c) is the gradient.
 */
export function crownQuadricInMeshFrame(crown: TreeCrownExtras, meshToTree: THREE.Matrix4, slot: number): { c: [number, number, number, number]; s0: [number, number, number]; s1: [number, number, number] } {
    const [r0, r1, r2] = crown.radii.map(r => Math.max(1e-3, r));
    const cy = Math.cos(crown.yawRad), sy = Math.sin(crown.yawRad);
    const axes: Array<[THREE.Vector3, number]> = [[new THREE.Vector3(cy, 0, sy), r0], [new THREE.Vector3(0, 1, 0), r1], [new THREE.Vector3(-sy, 0, cy), r2]];
    const q = new THREE.Matrix3().set(0, 0, 0, 0, 0, 0, 0, 0, 0);
    for (const [a, r] of axes) {
        const w = 1 / (r * r);
        const e = q.elements;    // column-major; the matrix is symmetric so the order does not matter
        e[0] += w * a.x * a.x; e[1] += w * a.x * a.y; e[2] += w * a.x * a.z;
        e[3] += w * a.y * a.x; e[4] += w * a.y * a.y; e[5] += w * a.y * a.z;
        e[6] += w * a.z * a.x; e[7] += w * a.z * a.y; e[8] += w * a.z * a.z;
    }
    const t = new THREE.Matrix3().setFromMatrix4(meshToTree);
    // S = T^T Q T
    const s = t.clone().transpose().multiply(q).multiply(t);
    const e = s.elements;
    const sxx = e[0], syy = e[4], szz = e[8], sxy = 0.5 * (e[1] + e[3]), sxz = 0.5 * (e[2] + e[6]), syz = 0.5 * (e[5] + e[7]);
    const centre = new THREE.Vector3(...crown.centre).applyMatrix4(meshToTree.clone().invert());
    return { c: [centre.x, centre.y, centre.z, slot], s0: [sxx, syy, szz], s1: [sxy, sxz, syz] };
}

/**
 * The crown's lobes in a mesh's own frame: centres through the inverse of `meshToTree`, radii and the blend radius divided
 * by its scale. Spheres stay spheres only under a similarity (rotation, translation, one scale), which is what the trees
 * writer's quantisation frames are; any other map returns null and the mesh keeps the ellipsoid.
 * Returns the lobes and [blend radius, mean lobe radius] in the mesh's units.
 */
export function crownLobesInMeshFrame(crown: TreeCrownExtras, meshToTree: THREE.Matrix4): { lobes: Array<[number, number, number, number]>; blend: number; meanRadius: number } | null {
    if (!crown.lobes?.length || !(typeof crown.lobeBlendM === 'number' && crown.lobeBlendM > 0)) return null;
    const e = meshToTree.elements;
    const cols = [0, 4, 8].map(o => new THREE.Vector3(e[o], e[o + 1], e[o + 2]));
    const sc = cols.map(c => c.length());
    const scale = (sc[0] + sc[1] + sc[2]) / 3;
    if (!(scale > 0) || sc.some(x => Math.abs(x - scale) > 1e-3 * scale)) return null;
    if (Math.abs(cols[0].dot(cols[1])) > 1e-3 * scale * scale || Math.abs(cols[0].dot(cols[2])) > 1e-3 * scale * scale || Math.abs(cols[1].dot(cols[2])) > 1e-3 * scale * scale) return null;
    const inv = meshToTree.clone().invert();
    const lobes = crown.lobes.slice(0, MAX_SHADER_LOBES).map(l => {
        const c = new THREE.Vector3(l[0], l[1], l[2]).applyMatrix4(inv);
        return [c.x, c.y, c.z, l[3] / scale] as [number, number, number, number];
    });
    const meanRadius = lobes.reduce((a, l) => a + l[3], 0) / lobes.length;
    return { lobes, blend: crown.lobeBlendM / scale, meanRadius };
}

/**
 * The smooth-min crown of lobes at `p` (same frame): f = -k log sum exp(-(|p - c_i| - r_i) / k) and its gradient, the
 * weighted mean of the lobes' unit directions (mirrors the GLSL; for tests and diagnostics).
 */
export function crownLobeField(lobes: ReadonlyArray<readonly [number, number, number, number]>, k: number, p: [number, number, number]): { f: number; gradient: [number, number, number] } {
    const d = lobes.map(l => Math.hypot(p[0] - l[0], p[1] - l[1], p[2] - l[2]) - l[3]);
    const dmin = Math.min(...d);
    let sum = 0;
    const g: [number, number, number] = [0, 0, 0];
    lobes.forEach((l, i) => {
        const w = Math.exp(-(d[i] - dmin) / k);
        const len = Math.max(1e-9, Math.hypot(p[0] - l[0], p[1] - l[1], p[2] - l[2]));
        g[0] += w * (p[0] - l[0]) / len; g[1] += w * (p[1] - l[1]) / len; g[2] += w * (p[2] - l[2]) / len;
        sum += w;
    });
    return { f: dmin - k * Math.log(sum), gradient: [g[0] / sum, g[1] / sum, g[2] / sum] };
}

/** One value for every instance of a mesh (and for a plain mesh, which draws as instance 0). */
export const PER_MESH_DIVISOR = 1 << 30;

/**
 * The mesh's own geometry: a light geometry that shares every buffer of the current one (the renderer keys buffers by
 * attribute, so the shared ones stay one GPU buffer each), made on the first call and returned as it is after that. Per-tree
 * values (the crown, a texture tint) go on it as per-mesh attributes, never on a geometry other trees share.
 */
export function ownGeometryOf(mesh: THREE.Mesh): THREE.BufferGeometry {
    const g = mesh.geometry as THREE.BufferGeometry;
    if (g.userData?.sbCrownOwn) return g;
    const own = new THREE.BufferGeometry();
    own.name = g.name;
    own.setIndex(g.index);
    for (const [name, attr] of Object.entries(g.attributes)) own.setAttribute(name, attr);
    for (const [name, list] of Object.entries(g.morphAttributes)) (own.morphAttributes as Record<string, Array<THREE.BufferAttribute | THREE.InterleavedBufferAttribute>>)[name] = list;
    own.morphTargetsRelative = g.morphTargetsRelative;
    for (const grp of g.groups) own.addGroup(grp.start, grp.count, grp.materialIndex);
    own.drawRange = { ...g.drawRange };
    if (g.boundingBox) own.boundingBox = g.boundingBox.clone();
    if (g.boundingSphere) own.boundingSphere = g.boundingSphere.clone();
    own.userData = { ...g.userData, sbCrownOwn: true };
    mesh.geometry = own;
    return own;
}

/** Sets (or updates in place) a per-mesh attribute: one value for the whole mesh, on its own geometry. */
export function setPerMeshAttribute(mesh: THREE.Mesh, name: string, v: number[]): void {
    const geom = ownGeometryOf(mesh);
    const a = geom.getAttribute(name) as THREE.InstancedBufferAttribute | undefined;
    if (a && (a as THREE.InstancedBufferAttribute).isInstancedBufferAttribute && a.array.length === v.length) {
        (a.array as Float32Array).set(v);
        a.needsUpdate = true;
        return;
    }
    geom.setAttribute(name, new THREE.InstancedBufferAttribute(new Float32Array(v), v.length, false, PER_MESH_DIVISOR));
}

/**
 * Gives `mesh` its own geometry that shares every buffer of the current one and adds the crown attributes. The shared
 * attributes stay one GPU buffer each (the renderer keys buffers by attribute). A mesh that already has its own geometry
 * (a second call) has its crown values updated in place. `lobes` is the mesh's lobe block in the shared atlas: [first
 * index, count, blend radius, mean lobe radius] (mesh units); count 0 means the ellipsoid. `scale` gives the breakup its
 * metric: the crown's mean radius in metres (the tree frame's units) and the world units a metre is (the tree node's world
 * scale), written as the w of sbCrownS0 and sbCrownS1.
 */
export function attachCrownAttributes(mesh: THREE.Mesh, quadric: ReturnType<typeof crownQuadricInMeshFrame>, lobes: [number, number, number, number] = [0, 0, 0, 0],
    scale: { crownRadiusM: number; worldPerMetre: number } = { crownRadiusM: 0, worldPerMetre: 1 }): void {
    setPerMeshAttribute(mesh, 'sbCrownC', quadric.c);
    setPerMeshAttribute(mesh, 'sbCrownS0', [...quadric.s0, Math.max(0, scale.crownRadiusM)]);
    setPerMeshAttribute(mesh, 'sbCrownS1', [...quadric.s1, scale.worldPerMetre > 0 ? scale.worldPerMetre : 1]);
    setPerMeshAttribute(mesh, 'sbCrownL', lobes);
}

/**
 * For an instanced leaf mesh: the lobe field at each instance's origin (the cluster's attachment, in the mesh's frame),
 * as one value per instance: gradient xyz and the signed depth inside the crown (-f / mean lobe radius; negative outside).
 * The shader reads it instead of looping over the lobes at every vertex of every leaf: the occlusion clamps the depth to
 * [0, 1], and the breakup extends it to each vertex along the gradient (first order, depth - g . (x - origin) / radius).
 */
export function attachCrownInstanceField(mesh: THREE.InstancedMesh, lobes: ReadonlyArray<readonly [number, number, number, number]>, blend: number, meanRadius: number): void {
    const n = mesh.count;
    const data = new Float32Array(4 * n);
    const m = mesh.instanceMatrix.array as Float32Array;
    for (let i = 0; i < n; i++) {
        const p: [number, number, number] = [m[16 * i + 12], m[16 * i + 13], m[16 * i + 14]];
        const { f, gradient } = crownLobeField(lobes, blend, p);
        data.set([gradient[0], gradient[1], gradient[2], -f / Math.max(1e-6, meanRadius)], 4 * i);
    }
    mesh.geometry.setAttribute('sbCrownI', new THREE.InstancedBufferAttribute(data, 4));
}

const CROWN_VARIANT = 'sbCrownVariant';

export const isCrownVariant = (m: THREE.Material | THREE.Material[] | null | undefined): boolean =>
    !!m && !Array.isArray(m) && m.userData?.[CROWN_VARIANT] === true;

/** Materials that light with a normal (and so have the vNormal varying the crown writes). */
export const supportsCrownShading = (m: THREE.Material): boolean => {
    const x = m as THREE.Material & Record<string, unknown>;
    return !!(x.isMeshStandardMaterial || x.isMeshLambertMaterial || x.isMeshPhongMaterial || x.isMeshToonMaterial);
};

/**
 * Vertex declarations shared by the crown variant and the breakup depth materials: the crown attributes and uniforms, the
 * crown field (sbCrownField), and the varyings the breakup reads in the fragment stage.
 */
export const CROWN_FIELD_VERTEX_PARS = `
attribute vec4 sbCrownC;
attribute vec4 sbCrownS0;
attribute vec4 sbCrownS1;
attribute vec4 sbCrownL;
#ifdef USE_INSTANCING
attribute vec4 sbCrownI;
#endif
uniform float uSbCrownUseLobes;
uniform highp sampler2D uSbCrownLobes;
varying vec3 vSbBkW;
varying float vSbBkDepth;
varying vec4 vSbBkInfo;
/*
 * The crown at sbP (the mesh's frame): returns the signed depth inside the crown (> 0 inside, in mean lobe radii, or for
 * the ellipsoid 1 - sqrt of the quadric), and writes the crown gradient (mesh frame) and the depth the occlusion reads
 * (clamped to [0, 1]). Lobes when the crown has them: a leaf cluster reads the field at its origin, evaluated once per
 * instance on the CPU, and extends the signed depth to the vertex along the gradient; a plain mesh (the far masses) loops
 * over its lobes, a running smooth minimum. The ellipsoid otherwise.
 */
float sbCrownField( vec3 sbP, out vec3 sbG, out float sbDepth ) {
    vec3 sbD = sbP - sbCrownC.xyz;
    int sbLobeCount = int( sbCrownL.y + 0.5 );
    float sbS;
    if ( uSbCrownUseLobes > 0.5 && sbLobeCount > 0 ) {
#ifdef USE_INSTANCING
        // leaf clusters: the field at the cluster's origin, evaluated once per instance on the CPU (xyz gradient, w depth)
        sbG = sbCrownI.xyz;
        sbDepth = clamp( sbCrownI.w, 0.0, 1.0 );
        sbS = sbCrownI.w - dot( sbCrownI.xyz, sbP - instanceMatrix[ 3 ].xyz ) / max( sbCrownL.w, 1e-6 );
#else
        // one pass over the lobes: a running smooth minimum (the sum is rescaled whenever a nearer lobe lowers the minimum)
        int sbBase = int( sbCrownL.x + 0.5 );
        float sbK = max( sbCrownL.z, 1e-6 );
        float sbDMin = 1e30;
        float sbWSum = 0.0;
        vec3 sbSum = vec3( 0.0 );
        for ( int i = 0; i < ${MAX_SHADER_LOBES}; i ++ ) {
            if ( i >= sbLobeCount ) break;
            int sbIdx = sbBase + i;
            vec4 sbL = texelFetch( uSbCrownLobes, ivec2( sbIdx % ${LOBE_TEX_WIDTH}, sbIdx / ${LOBE_TEX_WIDTH} ), 0 );
            vec3 sbR = sbP - sbL.xyz;
            float sbLen = length( sbR );
            float sbDi = sbLen - sbL.w;
            vec3 sbU = sbLen > 1e-6 ? sbR / sbLen : vec3( 0.0, 1.0, 0.0 );
            if ( sbDi < sbDMin ) {
                float sbScale = exp( - ( sbDMin - sbDi ) / sbK );
                sbWSum = sbWSum * sbScale + 1.0;
                sbSum = sbSum * sbScale + sbU;
                sbDMin = sbDi;
            } else {
                float sbW = exp( - ( sbDi - sbDMin ) / sbK );
                sbWSum += sbW;
                sbSum += sbW * sbU;
            }
        }
        sbG = sbSum / max( sbWSum, 1e-6 );
        float sbF = sbDMin - sbK * log( max( sbWSum, 1e-6 ) );
        sbS = - sbF / max( sbCrownL.w, 1e-6 );
        sbDepth = clamp( sbS, 0.0, 1.0 );
#endif
    } else {
        sbG = vec3(
            dot( vec3( sbCrownS0.x, sbCrownS1.x, sbCrownS1.y ), sbD ),
            dot( vec3( sbCrownS1.x, sbCrownS0.y, sbCrownS1.z ), sbD ),
            dot( vec3( sbCrownS1.y, sbCrownS1.z, sbCrownS0.z ), sbD ) );
        // the quadric is 1 on the surface
        sbS = 1.0 - sqrt( max( dot( sbD, sbG ), 0.0 ) );
        sbDepth = clamp( sbS, 0.0, 1.0 );
    }
    return sbS;
}
/*
 * The breakup's varyings: the world point, the signed depth, and (slot, world units per metre, crown mean radius in
 * metres, a per-tree value from the crown centre's world place, so every level of a tree gets the same one).
 */
void sbBreakupVertex( vec4 sbLocal, float sbS ) {
    vSbBkW = ( modelMatrix * sbLocal ).xyz;
    vSbBkDepth = sbS;
    float sbPerM = max( sbCrownS1.w, 1e-6 );
    vec3 sbCw = floor( ( modelMatrix * vec4( sbCrownC.xyz, 1.0 ) ).xyz / sbPerM * 2.0 + 0.5 );
    float sbTree = fract( sin( dot( sbCw, vec3( 12.9898, 78.233, 37.719 ) ) ) * 43758.5453 );
    vSbBkInfo = vec4( sbCrownC.w, sbPerM, sbCrownS0.w, sbTree );
}
`;

export const CROWN_VERTEX_PARS = `${CROWN_FIELD_VERTEX_PARS}
uniform vec4 uSbCrownBlend;
uniform vec4 uSbCrownNoise;
uniform vec4 uSbCrownOcclusion;
uniform float uSbCrownSky;
varying float vSbCrownOcc;
varying float vSbCrownFlip;
`;

/**
 * Vertex code, after the projection. The crown's shape in the mesh's frame is its lobes when it has them (a smooth minimum
 * of spheres read from the lobe atlas: f = -k log sum exp(-(|x - c_i| - r_i) / k), gradient the weighted mean of the lobes'
 * unit directions) and its ellipsoid otherwise (sbCrownField). Two effects, each with its own factor per detail slot (sbCrownC.w):
 * - occlusion (every slot): the leaf's diffuse colour is darkened by where it sits in the crown, from the crown normal's
 *   facing toward the sky and the depth inside the crown, so the crown reads as a lit volume while every leaf keeps its own
 *   normal, its fold and its outline (the near slot relies on this alone by default);
 * - normal blend: the leaf's normal varying is replaced with a blend toward the crown normal. Only a slot that blends has
 *   its card normal turned to the crown's side and the back-face flip dropped; a slot with blend 0 is lit exactly as the
 *   plain material lights it (three's own back-face flip, vSbCrownFlip = 1).
 * It also writes the breakup's varyings (sbBreakupVertex).
 */
export const CROWN_VERTEX_MAIN = `
vSbCrownOcc = 1.0;
vSbCrownFlip = 1.0;
{
    vec4 sbLocal = vec4( transformed, 1.0 );
#ifdef USE_INSTANCING
    sbLocal = instanceMatrix * sbLocal;
#endif
    vec3 sbG;
    float sbDepth;
    float sbS = sbCrownField( sbLocal.xyz, sbG, sbDepth );
    sbBreakupVertex( sbLocal, sbS );
#ifndef FLAT_SHADED
    vec3 sbUp = normalize( mat3( viewMatrix ) * vec3( 0.0, 1.0, 0.0 ) );
    vec3 sbN = dot( sbG, sbG ) > 1e-20 ? normalize( normalMatrix * sbG ) : sbUp;
    float sbLvl = sbCrownC.w;
    vec4 sbSel = vec4( 1.0 - step( 0.5, sbLvl ), step( 0.5, sbLvl ) - step( 1.5, sbLvl ), step( 1.5, sbLvl ) - step( 2.5, sbLvl ), step( 2.5, sbLvl ) );
    float sbBlend = dot( uSbCrownBlend, sbSel );
    float sbAmp = dot( uSbCrownNoise, sbSel );
    // occlusion: 1 on the sky side of the crown's surface, darker toward its underside and its core
    float sbLit = ( 0.5 + 0.5 * dot( sbN, sbUp ) ) * ( 1.0 - 0.6 * sbDepth );
    vSbCrownOcc = mix( 1.0, 0.4 + 0.6 * sbLit, dot( uSbCrownOcclusion, sbSel ) );
    if ( sbBlend > 0.0 ) {
        // per-leaf noise: smooth in the leaf's own normal (one leaf, one direction), varied by the cluster's place
#ifdef USE_INSTANCING
        vec3 sbSeed = instanceMatrix[3].xyz;
#else
        vec3 sbSeed = vec3( 0.0 );
#endif
        float sbH = fract( sin( dot( floor( sbSeed * 1024.0 ), vec3( 12.9898, 78.233, 37.719 ) ) ) * 43758.5453 ) * 6.2831853;
        vec3 sbJ = sin( objectNormal * vec3( 7.13, 9.31, 8.77 ) + vec3( sbH, sbH * 1.7, sbH * 2.3 ) );
        vec3 sbC = normalize( sbN + uSbCrownSky * sbUp + sbAmp * normalMatrix * sbJ );
        vec3 sbOwn = normalize( vNormal );
        if ( dot( sbOwn, sbC ) < 0.0 ) sbOwn = - sbOwn;
        vNormal = normalize( mix( sbOwn, sbC, sbBlend ) );
        vSbCrownFlip = 0.0;
    }
#endif
}
`;

/**
 * Fragment declarations shared by the crown variant and the breakup depth materials: the breakup uniforms and varyings,
 * the world-space noises, the hole test (sbBreakupKeep) and the clump value (sbBreakupValue).
 */
export const BREAKUP_FRAGMENT_PARS = `
uniform float uSbBkOn;
uniform vec4 uSbBkHoles;
uniform vec4 uSbBkPockets;
uniform vec4 uSbBkClump;
uniform vec4 uSbBkTone;
uniform vec4 uSbBkShape;
uniform vec4 uSbBkFilter;
uniform vec4 uSbBkValue;
uniform float uSbBkOctave;
uniform float uSbBkShadowHoles;
varying vec3 vSbBkW;
varying float vSbBkDepth;
varying vec4 vSbBkInfo;
float sbBkHash31( vec3 p ) {
    p = fract( p * vec3( 0.1031, 0.1030, 0.0973 ) );
    p += dot( p, p.yzx + 33.33 );
    return fract( ( p.x + p.y ) * p.z );
}
vec3 sbBkHash33( vec3 p ) {
    p = fract( p * vec3( 0.1031, 0.1030, 0.0973 ) );
    p += dot( p, p.yxz + 33.33 );
    return fract( ( p.xxy + p.yxx ) * p.zyx );
}
// value noise in [0, 1] (smoothstep-interpolated lattice values)
float sbBkValueNoise( vec3 p ) {
    vec3 i = floor( p );
    vec3 f = fract( p );
    f = f * f * ( 3.0 - 2.0 * f );
    float a = mix( sbBkHash31( i ), sbBkHash31( i + vec3( 1.0, 0.0, 0.0 ) ), f.x );
    float b = mix( sbBkHash31( i + vec3( 0.0, 1.0, 0.0 ) ), sbBkHash31( i + vec3( 1.0, 1.0, 0.0 ) ), f.x );
    float c = mix( sbBkHash31( i + vec3( 0.0, 0.0, 1.0 ) ), sbBkHash31( i + vec3( 1.0, 0.0, 1.0 ) ), f.x );
    float d = mix( sbBkHash31( i + vec3( 0.0, 1.0, 1.0 ) ), sbBkHash31( i + vec3( 1.0, 1.0, 1.0 ) ), f.x );
    return mix( mix( a, b, f.y ), mix( c, d, f.y ), f.z );
}
// cellular noise: x nearest feature distance F1, y second F2, z height of p above its nearest feature (cell units). One
// feature point per cell, jittered within the middle half of it, so the 2 x 2 x 2 cells around p hold its nearest ones.
vec3 sbBkWorley( vec3 p ) {
    vec3 i = floor( p - 0.5 );
    vec3 f = p - i;
    float d1 = 8.0, d2 = 8.0, dy = 0.0;
    for ( int z = 0; z <= 1; z ++ ) for ( int y = 0; y <= 1; y ++ ) for ( int x = 0; x <= 1; x ++ ) {
        vec3 o = vec3( float( x ), float( y ), float( z ) );
        vec3 r = o + 0.25 + 0.5 * sbBkHash33( i + o ) - f;
        float d = dot( r, r );
        if ( d < d1 ) { d2 = d1; d1 = d; dy = - r.y; } else if ( d < d2 ) { d2 = d; }
    }
    return vec3( sqrt( d1 ), sqrt( d2 ), dy );
}
vec4 sbBkSlot( float lvl ) {
    return vec4( 1.0 - step( 0.5, lvl ), step( 0.5, lvl ) - step( 1.5, lvl ), step( 1.5, lvl ) - step( 2.5, lvl ), step( 2.5, lvl ) );
}
// the clump scale (m) of this crown
float sbBkClumpM() {
    return clamp( uSbBkShape.x * vSbBkInfo.z, uSbBkShape.y, uSbBkShape.z );
}
// 1 while a noise of period periodM is resolved at this pixel footprint, fading to 0 as the footprint reaches filterEnd of it
float sbBkResolved( float footprintM, float periodM ) {
    return 1.0 - smoothstep( uSbBkFilter.y, uSbBkFilter.z, footprintM / max( periodM, 1e-6 ) );
}
/*
 * Keep (true) or drop this fragment: a function of the world point (metres), the crown's signed depth there, the slot's
 * factors, the pixel footprint (m) and a dither value in [0, 1).
 */
bool sbBreakupKeep( vec3 pM, float depthS, vec4 sel, float footprintM, float dither ) {
    float holes = dot( uSbBkHoles, sel );
    float pockets = dot( uSbBkPockets, sel );
#ifdef SB_BREAKUP_SHADOW
    holes *= uSbBkShadowHoles;
    pockets *= uSbBkShadowHoles;
#endif
    if ( uSbBkOn < 0.5 || holes + pockets <= 0.0 ) return true;
    float c = sbBkClumpM();
    float cc = c * uSbBkOctave;
    float cp = cc * 1.3;
#ifdef SB_BREAKUP_SHADOW
    // the shadow pass keeps the coarse octave and the pockets only (a shadow is softer than the leaves that cast it)
    float wf = 0.0;
#else
    float wf = 0.55 * sbBkResolved( footprintM, c );
#endif
    float wc = 0.45 * sbBkResolved( footprintM, cc );
    float wp = pockets * sbBkResolved( footprintM, cp );
    float wsum = wf + wc;
    float rim = 1.0 - smoothstep( 0.0, uSbBkShape.w, depthS );
    float rimShare = holes * rim * wsum;
    // the noises only where they can drop something (the crown's core keeps its pockets alone)
    if ( rimShare <= 0.0 && wp <= 0.0 ) return true;
    float pocket = wp > 0.0 ? wp * smoothstep( 0.52, 0.72, sbBkValueNoise( pM / cp + 51.7 ) ) : 0.0;
    float share = rimShare + pocket;
    if ( share <= 0.0 ) return true;
    float n = wsum > 1e-4 ? ( wf * sbBkValueNoise( pM / c ) + wc * sbBkValueNoise( pM / cc + 17.31 ) ) / wsum : 0.5;
    // a value noise gathers near 0.5 (sd about 0.187, less for the blend of two): spread it toward a uniform share
    float sig = 0.187 * length( vec2( wf, wc ) ) / max( wsum, 1e-4 );
    n = smoothstep( 0.5 - 1.88 * sig, 0.5 + 1.88 * sig, n );
    return n + ( dither - 0.5 ) * uSbBkFilter.x >= share;
}
// the value: brighter clump tops and darker crevices between clumps (the slot's clump share), lobe-scale and per-tree grey
// variation (the slot's tone share)
float sbBreakupValue( vec3 pM, vec4 sel, float footprintM ) {
    if ( uSbBkOn < 0.5 ) return 1.0;
    float amount = dot( uSbBkClump, sel );
    float c = sbBkClumpM();
    float v = 1.0;
    float wc = amount * sbBkResolved( footprintM, c );
    if ( wc > 0.0 ) {
        vec3 w = sbBkWorley( pM / c );
        // a clump is a dome lit from above: brighter toward its centre and its top; darker in the seams between clumps
        float dome = 1.0 - smoothstep( 0.0, 0.9, w.x );
        float top = clamp( w.z * 1.2, - 1.0, 1.0 );
        float crevice = 1.0 - smoothstep( 0.0, 0.55, w.y - w.x );
        v += wc * ( uSbBkValue.x * ( 0.6 * top + 0.8 * ( dome - 0.5 ) ) - uSbBkValue.y * crevice );
    }
    float tone = dot( uSbBkTone, sel );
    if ( tone > 0.0 ) {
        float lobeM = max( 0.7 * vSbBkInfo.z, 2.0 * c );
        v *= 1.0 + tone * uSbBkValue.z * ( 2.0 * sbBkValueNoise( pM / lobeM + 41.3 ) - 1.0 );
        v *= 1.0 + tone * uSbBkValue.w * ( 2.0 * vSbBkInfo.w - 1.0 );
    }
    return max( v, 0.0 );
}
`;

/**
 * Fragment code at the start of the fragment stage (after the clipping planes), in the crown variant and the breakup depth
 * materials alike: the hole test, discarding the fragment. The footprint is the pixel's size on the surface (m), from the
 * screen derivatives of the world point; the dither is white noise per pixel.
 */
export const BREAKUP_FRAGMENT_DISCARD = `
{
    vec3 sbPM = vSbBkW / max( vSbBkInfo.y, 1e-6 );
    float sbFoot = max( length( dFdx( sbPM ) ), length( dFdy( sbPM ) ) );
    float sbDither = sbBkHash31( vec3( floor( gl_FragCoord.xy ), 7.0 ) );
    if ( ! sbBreakupKeep( sbPM, vSbBkDepth, sbBkSlot( vSbBkInfo.x ), sbFoot, sbDither ) ) discard;
}
`;

/** Fragment declarations of the crown variant. */
export const CROWN_FRAGMENT_PARS = `${BREAKUP_FRAGMENT_PARS}
varying float vSbCrownOcc;
varying float vSbCrownFlip;
`;

/**
 * After color_fragment: the crown's occlusion and the clump value on the leaf's diffuse colour; inside a closed blob mass
 * (a plain mesh seen from its back face, through a hole) darker still.
 */
export const CROWN_FRAGMENT_COLOR = `
{
    vec3 sbPM = vSbBkW / max( vSbBkInfo.y, 1e-6 );
    float sbFoot = max( length( dFdx( sbPM ) ), length( dFdy( sbPM ) ) );
    diffuseColor.rgb *= vSbCrownOcc * sbBreakupValue( sbPM, sbBkSlot( vSbBkInfo.x ), sbFoot );
#ifndef USE_INSTANCING
    if ( uSbBkOn > 0.5 && ! gl_FrontFacing ) diffuseColor.rgb *= 1.0 - uSbBkFilter.w;
#endif
}
`;

/**
 * normal_fragment_begin whose back-face flip applies only where the level does not blend toward the crown normal (a
 * blended normal already faces the crown's side, so flipping it would light the back of a card as the dark side).
 */
export const crownNormalFragmentBegin = (): string => {
    const chunk = THREE.ShaderChunk.normal_fragment_begin;
    const out = chunk.replace('float faceDirection = gl_FrontFacing ? 1.0 : - 1.0;', 'float faceDirection = vSbCrownFlip > 0.5 ? ( gl_FrontFacing ? 1.0 : - 1.0 ) : 1.0;');
    if (out === chunk) throw new Error('treeCrownShading: three.js normal_fragment_begin no longer has the faceDirection line this patch replaces');
    return out;
};

/** Injects the breakup's hole test after the clipping planes of a fragment shader; throws when the anchor is gone. */
function injectBreakupDiscard(fragmentShader: string, where: string): string {
    const anchor = '#include <clipping_planes_fragment>';
    if (!fragmentShader.includes(anchor)) throw new Error(`treeCrownShading: the ${where} fragment shader has no clipping_planes_fragment chunk to put the breakup after`);
    return fragmentShader.replace(anchor, `${anchor}\n${BREAKUP_FRAGMENT_DISCARD}`);
}

/** A variant of `base` that shades with the crown normal. Only leaf meshes that carry the crown attributes wear it. */
export function makeCrownVariant(base: THREE.Material): THREE.Material {
    const mat = base.clone();
    mat.userData = { ...base.userData, [CROWN_VARIANT]: true };
    const baseKey = base.customProgramCacheKey?.call(base) ?? '';
    mat.customProgramCacheKey = () => `${baseKey}|sbcrown`;
    mat.onBeforeCompile = (shader, renderer) => {
        base.onBeforeCompile?.call(base, shader, renderer);
        Object.assign(shader.uniforms, uniforms);
        shader.vertexShader = shader.vertexShader
            .replace('#include <common>', `#include <common>\n${CROWN_VERTEX_PARS}`)
            .replace('#include <project_vertex>', `#include <project_vertex>\n${CROWN_VERTEX_MAIN}`);
        let frag = shader.fragmentShader
            .replace('#include <common>', `#include <common>\n${CROWN_FRAGMENT_PARS}`)
            .replace('#include <color_fragment>', `#include <color_fragment>\n${CROWN_FRAGMENT_COLOR}`)
            .replace('#include <normal_fragment_begin>', crownNormalFragmentBegin());
        if (!frag.includes(CROWN_FRAGMENT_COLOR)) throw new Error('treeCrownShading: the leaf material has no color_fragment chunk to darken');
        frag = injectBreakupDiscard(frag, 'leaf material');
        shader.fragmentShader = frag;
    };
    mat.needsUpdate = true;
    return mat;
}

const BREAKUP_DEPTH = 'sbBreakupDepth';

/** True for the depth and distance materials that carry the breakup into the shadow pass. */
export const isBreakupDepthMaterial = (m: THREE.Material | null | undefined): boolean => !!m && m.userData?.[BREAKUP_DEPTH] === true;

/** Adds the crown field and the breakup's hole test to a depth or distance material (its shadow pass discards the same holes). */
function withBreakup<T extends THREE.Material>(mat: T, key: string): T {
    mat.userData[BREAKUP_DEPTH] = true;
    mat.defines = { ...(mat.defines ?? {}), SB_BREAKUP_SHADOW: '' };
    mat.customProgramCacheKey = () => key;
    mat.onBeforeCompile = shader => {
        Object.assign(shader.uniforms, uniforms);
        if (!shader.vertexShader.includes('#include <project_vertex>')) throw new Error(`treeCrownShading: the ${key} vertex shader has no project_vertex chunk`);
        shader.vertexShader = shader.vertexShader
            .replace('#include <common>', `#include <common>\n${CROWN_FIELD_VERTEX_PARS}`)
            .replace('#include <project_vertex>', `#include <project_vertex>
{
    vec4 sbLocal = vec4( transformed, 1.0 );
#ifdef USE_INSTANCING
    sbLocal = instanceMatrix * sbLocal;
#endif
    vec3 sbG;
    float sbDepth;
    sbBreakupVertex( sbLocal, sbCrownField( sbLocal.xyz, sbG, sbDepth ) );
    // a shadow needs a hole through the whole crown: the point moves along the light (the shadow camera's view axis) onto the
    // plane through the crown's centre, so every layer on one light ray decides alike, and the rim weight is 1 (depth < 0)
    vec3 sbPv = ( modelViewMatrix * sbLocal ).xyz;
    vec3 sbCv = ( modelViewMatrix * vec4( sbCrownC.xyz, 1.0 ) ).xyz;
    vec3 sbOnPlane = vec3( sbPv.xy, sbCv.z ) - viewMatrix[ 3 ].xyz;
    vSbBkW = transpose( mat3( viewMatrix ) ) * sbOnPlane;
    vSbBkDepth = - 1.0;
}`);
        shader.fragmentShader = injectBreakupDiscard(shader.fragmentShader.replace('#include <common>', `#include <common>\n${BREAKUP_FRAGMENT_PARS}`), key);
    };
    return mat;
}

let breakupDepth: THREE.MeshDepthMaterial | undefined;
let breakupDistance: THREE.MeshDistanceMaterial | undefined;

/**
 * The depth material a leaf mesh with a crown draws into a directional or spot light's shadow map (customDepthMaterial):
 * the renderer's own depth material plus the breakup, so shadows are dappled. It draws the same noise field, its coarse
 * octave and the pockets, sampled where each point's light ray crosses the plane through the crown's centre (so a hole
 * runs through the whole crown, as it must to let light through), at `shadowHoles` of the leaves' hole share and with no
 * rim weighting. One for every tree; the renderer sets its side from the leaf material each draw, and instancing comes
 * from the mesh.
 */
export function breakupDepthMaterial(): THREE.MeshDepthMaterial {
    if (!breakupDepth) breakupDepth = withBreakup(new THREE.MeshDepthMaterial(), 'sbbreakupdepth');
    return breakupDepth;
}

/** The same for a point light's shadow (customDistanceMaterial). */
export function breakupDistanceMaterial(): THREE.MeshDistanceMaterial {
    if (!breakupDistance) breakupDistance = withBreakup(new THREE.MeshDistanceMaterial(), 'sbbreakupdistance');
    return breakupDistance;
}

// ------------------------------------------------------------------------------------------------
// The breakup's decision in TypeScript, mirroring the GLSL (float32 at each step), for tests and diagnostics
// ------------------------------------------------------------------------------------------------

const f32 = Math.fround;
const fract32 = (x: number): number => f32(x - Math.floor(x));
const smooth = (a: number, b: number, x: number): number => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

function hash31(x: number, y: number, z: number): number {
    let px = fract32(f32(x * f32(0.1031))), py = fract32(f32(y * f32(0.1030))), pz = fract32(f32(z * f32(0.0973)));
    const d = f32(f32(f32(px * f32(py + f32(33.33))) + f32(py * f32(pz + f32(33.33)))) + f32(pz * f32(px + f32(33.33))));
    px = f32(px + d); py = f32(py + d); pz = f32(pz + d);
    return fract32(f32(f32(px + py) * pz));
}

/** Value noise in [0, 1] (mirrors sbBkValueNoise). */
export function breakupValueNoise(x: number, y: number, z: number): number {
    const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
    let fx = fract32(x), fy = fract32(y), fz = fract32(z);
    fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy); fz = fz * fz * (3 - 2 * fz);
    const mix = (a: number, b: number, t: number) => a + (b - a) * t;
    const h = (dx: number, dy: number, dz: number) => hash31(ix + dx, iy + dy, iz + dz);
    const a = mix(h(0, 0, 0), h(1, 0, 0), fx), b = mix(h(0, 1, 0), h(1, 1, 0), fx), c = mix(h(0, 0, 1), h(1, 0, 1), fx), d = mix(h(0, 1, 1), h(1, 1, 1), fx);
    return mix(mix(a, b, fy), mix(c, d, fy), fz);
}

/**
 * Keep (true) or drop the leaf fragment at world point `pM` (metres) with the crown's signed depth `depthS` there, at
 * detail slot `slot`, pixel footprint `footprintM` and dither `dither` in [0, 1), for a crown of mean radius
 * `crownRadiusM`, with the shared uniforms' current factors (mirrors sbBreakupKeep).
 */
export function breakupKeepAt(pM: readonly [number, number, number], depthS: number, slot: number, footprintM: number, dither: number, crownRadiusM: number): boolean {
    const u = uniforms;
    const k = slot < 0.5 ? 'x' : slot < 1.5 ? 'y' : slot < 2.5 ? 'z' : 'w';
    const holes = u.uSbBkHoles.value[k], pockets = u.uSbBkPockets.value[k];
    if (u.uSbBkOn.value < 0.5 || holes + pockets <= 0) return true;
    const sh = u.uSbBkShape.value, fl = u.uSbBkFilter.value;
    const c = Math.min(sh.z, Math.max(sh.y, sh.x * crownRadiusM));
    const cc = c * u.uSbBkOctave.value, cp = cc * 1.3;
    const resolved = (period: number) => 1 - smooth(fl.y, fl.z, footprintM / Math.max(period, 1e-6));
    const wf = 0.55 * resolved(c), wc = 0.45 * resolved(cc), wp = pockets * resolved(cp), wsum = wf + wc;
    const rim = 1 - smooth(0, sh.w, depthS);
    const rimShare = holes * rim * wsum;
    if (rimShare <= 0 && wp <= 0) return true;
    const pocket = wp > 0 ? wp * smooth(0.52, 0.72, breakupValueNoise(pM[0] / cp + 51.7, pM[1] / cp + 51.7, pM[2] / cp + 51.7)) : 0;
    const share = rimShare + pocket;
    if (share <= 0) return true;
    let n = wsum > 1e-4 ? (wf * breakupValueNoise(pM[0] / c, pM[1] / c, pM[2] / c) + wc * breakupValueNoise(pM[0] / cc + 17.31, pM[1] / cc + 17.31, pM[2] / cc + 17.31)) / wsum : 0.5;
    const sig = 0.187 * Math.hypot(wf, wc) / Math.max(wsum, 1e-4);
    n = smooth(0.5 - 1.88 * sig, 0.5 + 1.88 * sig, n);
    return n + (dither - 0.5) * fl.x >= share;
}

/**
 * The crown's signed depth at a point of a leaf mesh as its shader computes it, from the mesh's crown attributes: `pLocal`
 * in the mesh's frame (an instance's vertex already through its instance matrix), `instance` the instance index of an
 * instanced mesh (its field at the origin, extended along the gradient), the ellipsoid when the mesh has no lobes.
 */
export function crownSignedDepthAt(mesh: THREE.Mesh, pLocal: THREE.Vector3, instance?: number): number {
    const g = mesh.geometry as THREE.BufferGeometry;
    const C = g.getAttribute('sbCrownC'), S0 = g.getAttribute('sbCrownS0'), S1 = g.getAttribute('sbCrownS1'), L = g.getAttribute('sbCrownL');
    const lobeCount = Math.round(L.getY(0));
    if (uniforms.uSbCrownUseLobes.value > 0.5 && lobeCount > 0) {
        const im = mesh as THREE.InstancedMesh;
        if (im.isInstancedMesh && instance !== undefined) {
            const I = g.getAttribute('sbCrownI');
            const o = new THREE.Vector3().setFromMatrixPosition(new THREE.Matrix4().fromArray(im.instanceMatrix.array as Float32Array, 16 * instance));
            return I.getW(instance) - (I.getX(instance) * (pLocal.x - o.x) + I.getY(instance) * (pLocal.y - o.y) + I.getZ(instance) * (pLocal.z - o.z)) / Math.max(L.getW(0), 1e-6);
        }
        const lobes = crownLobesAt(Math.round(L.getX(0)), lobeCount);
        return -crownLobeField(lobes, Math.max(L.getZ(0), 1e-6), [pLocal.x, pLocal.y, pLocal.z]).f / Math.max(L.getW(0), 1e-6);
    }
    const d = [pLocal.x - C.getX(0), pLocal.y - C.getY(0), pLocal.z - C.getZ(0)];
    const sxx = S0.getX(0), syy = S0.getY(0), szz = S0.getZ(0), sxy = S1.getX(0), sxz = S1.getY(0), syz = S1.getZ(0);
    const gx = sxx * d[0] + sxy * d[1] + sxz * d[2], gy = sxy * d[0] + syy * d[1] + syz * d[2], gz = sxz * d[0] + syz * d[1] + szz * d[2];
    return 1 - Math.sqrt(Math.max(0, d[0] * gx + d[1] * gy + d[2] * gz));
}
