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
}

export const DEFAULT_CROWN_SHADING: Readonly<CrownShadingOptions> = Object.freeze<CrownShadingOptions>({
    enabled: true, blend: [0, 0.45, 0.9, 0.75], skyBias: 0.18, noise: [0, 0.06, 0.12, 0.06], occlusion: [0.6, 0.55, 0.45, 0.4], lobes: true
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
    uSbCrownLobes: { value: makeLobeTexture(lobeAtlas.data, lobeAtlas.rows) }
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
export function setCrownShadingUniforms(o: Pick<CrownShadingOptions, 'blend' | 'skyBias' | 'noise' | 'occlusion'> & Partial<Pick<CrownShadingOptions, 'lobes'>>): void {
    const c01 = (x: number) => Math.min(1, Math.max(0, Number.isFinite(x) ? x : 0));
    const pos = (x: number) => Math.max(0, Number.isFinite(x) ? x : 0);
    uniforms.uSbCrownBlend.value.set(...(o.blend.map(c01) as CrownSlotFactors));
    uniforms.uSbCrownNoise.value.set(...(o.noise.map(pos) as CrownSlotFactors));
    uniforms.uSbCrownOcclusion.value.set(...(o.occlusion.map(c01) as CrownSlotFactors));
    uniforms.uSbCrownSky.value = pos(o.skyBias);
    uniforms.uSbCrownUseLobes.value = o.lobes === false ? 0 : 1;
}

/** An override of the options: the per-slot factors as four numbers (near, near-mid, mid, far) or three (near, mid, far). */
export type CrownShadingInput = Partial<Omit<CrownShadingOptions, 'blend' | 'noise' | 'occlusion'> & { blend: readonly number[]; noise: readonly number[]; occlusion: readonly number[] }>;

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
        lobes: o?.lobes ?? d.lobes
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
const PER_MESH_DIVISOR = 1 << 30;

/**
 * Gives `mesh` its own geometry that shares every buffer of the current one and adds the crown attributes. The shared
 * attributes stay one GPU buffer each (the renderer keys buffers by attribute). A mesh that already has its own geometry
 * (a second call) has its crown values updated in place. `lobes` is the mesh's lobe block in the shared atlas: [first
 * index, count, blend radius, mean lobe radius] (mesh units); count 0 means the ellipsoid.
 */
export function attachCrownAttributes(mesh: THREE.Mesh, quadric: ReturnType<typeof crownQuadricInMeshFrame>, lobes: [number, number, number, number] = [0, 0, 0, 0]): void {
    const g = mesh.geometry as THREE.BufferGeometry;
    const set = (geom: THREE.BufferGeometry, name: string, v: number[]) => {
        const a = geom.getAttribute(name) as THREE.InstancedBufferAttribute | undefined;
        if (a && (a as THREE.InstancedBufferAttribute).isInstancedBufferAttribute) {
            (a.array as Float32Array).set(v);
            a.needsUpdate = true;
            return;
        }
        geom.setAttribute(name, new THREE.InstancedBufferAttribute(new Float32Array(v), v.length, false, PER_MESH_DIVISOR));
    };
    let own = g;
    if (!g.userData?.sbCrownOwn) {
        own = new THREE.BufferGeometry();
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
    }
    set(own, 'sbCrownC', quadric.c);
    set(own, 'sbCrownS0', quadric.s0);
    set(own, 'sbCrownS1', quadric.s1);
    set(own, 'sbCrownL', lobes);
}

/**
 * For an instanced leaf mesh: the lobe field at each instance's origin (the cluster's attachment, in the mesh's frame),
 * as one value per instance: gradient xyz and depth inside the crown (-f / mean lobe radius, clamped to [0, 1]). The
 * shader reads it instead of looping over the lobes at every vertex of every leaf.
 */
export function attachCrownInstanceField(mesh: THREE.InstancedMesh, lobes: ReadonlyArray<readonly [number, number, number, number]>, blend: number, meanRadius: number): void {
    const n = mesh.count;
    const data = new Float32Array(4 * n);
    const m = mesh.instanceMatrix.array as Float32Array;
    for (let i = 0; i < n; i++) {
        const p: [number, number, number] = [m[16 * i + 12], m[16 * i + 13], m[16 * i + 14]];
        const { f, gradient } = crownLobeField(lobes, blend, p);
        data.set([gradient[0], gradient[1], gradient[2], Math.min(1, Math.max(0, -f / Math.max(1e-6, meanRadius)))], 4 * i);
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

export const CROWN_VERTEX_PARS = `
attribute vec4 sbCrownC;
attribute vec3 sbCrownS0;
attribute vec3 sbCrownS1;
attribute vec4 sbCrownL;
#ifdef USE_INSTANCING
attribute vec4 sbCrownI;
#endif
uniform vec4 uSbCrownBlend;
uniform vec4 uSbCrownNoise;
uniform vec4 uSbCrownOcclusion;
uniform float uSbCrownSky;
uniform float uSbCrownUseLobes;
uniform highp sampler2D uSbCrownLobes;
varying float vSbCrownOcc;
varying float vSbCrownFlip;
`;

/**
 * Vertex code, after the projection. The crown's shape in the mesh's frame is its lobes when it has them (a smooth minimum
 * of spheres read from the lobe atlas: f = -k log sum exp(-(|x - c_i| - r_i) / k), gradient the weighted mean of the lobes'
 * unit directions) and its ellipsoid otherwise. Two effects, each with its own factor per detail slot (sbCrownC.w):
 * - occlusion (every slot): the leaf's diffuse colour is darkened by where it sits in the crown, from the crown normal's
 *   facing toward the sky and the depth inside the crown, so the crown reads as a lit volume while every leaf keeps its own
 *   normal, its fold and its outline (the near slot relies on this alone by default);
 * - normal blend: the leaf's normal varying is replaced with a blend toward the crown normal. Only a slot that blends has
 *   its card normal turned to the crown's side and the back-face flip dropped; a slot with blend 0 is lit exactly as the
 *   plain material lights it (three's own back-face flip, vSbCrownFlip = 1).
 */
export const CROWN_VERTEX_MAIN = `
vSbCrownOcc = 1.0;
vSbCrownFlip = 1.0;
#ifndef FLAT_SHADED
{
    vec4 sbLocal = vec4( transformed, 1.0 );
#ifdef USE_INSTANCING
    sbLocal = instanceMatrix * sbLocal;
#endif
    vec3 sbD = sbLocal.xyz - sbCrownC.xyz;
    vec3 sbG;
    float sbDepth;
    int sbLobeCount = int( sbCrownL.y + 0.5 );
    if ( uSbCrownUseLobes > 0.5 && sbLobeCount > 0 ) {
#ifdef USE_INSTANCING
        // leaf clusters: the field at the cluster's origin, evaluated once per instance on the CPU (xyz gradient, w depth)
        sbG = sbCrownI.xyz;
        sbDepth = sbCrownI.w;
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
            vec3 sbR = sbLocal.xyz - sbL.xyz;
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
        sbDepth = clamp( - sbF / max( sbCrownL.w, 1e-6 ), 0.0, 1.0 );
#endif
    } else {
        sbG = vec3(
            dot( vec3( sbCrownS0.x, sbCrownS1.x, sbCrownS1.y ), sbD ),
            dot( vec3( sbCrownS1.x, sbCrownS0.y, sbCrownS1.z ), sbD ),
            dot( vec3( sbCrownS1.y, sbCrownS1.z, sbCrownS0.z ), sbD ) );
        // the quadric is 1 on the surface
        sbDepth = 1.0 - sqrt( clamp( dot( sbD, sbG ), 0.0, 1.0 ) );
    }
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
}
#endif
`;

/** Fragment declarations of the crown variant. */
export const CROWN_FRAGMENT_PARS = `
varying float vSbCrownOcc;
varying float vSbCrownFlip;
`;

/** After color_fragment: the crown's occlusion on the leaf's diffuse colour. */
export const CROWN_FRAGMENT_COLOR = `
diffuseColor.rgb *= vSbCrownOcc;
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
        const frag = shader.fragmentShader
            .replace('#include <common>', `#include <common>\n${CROWN_FRAGMENT_PARS}`)
            .replace('#include <color_fragment>', `#include <color_fragment>\n${CROWN_FRAGMENT_COLOR}`)
            .replace('#include <normal_fragment_begin>', crownNormalFragmentBegin());
        if (!frag.includes(CROWN_FRAGMENT_COLOR)) throw new Error('treeCrownShading: the leaf material has no color_fragment chunk to darken');
        shader.fragmentShader = frag;
    };
    mat.needsUpdate = true;
    return mat;
}
