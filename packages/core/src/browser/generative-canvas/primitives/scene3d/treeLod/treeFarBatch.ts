/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The far level of every tree of a trees GLB drawn as one multi-draw batch per material (THREE.BatchedMesh), not one or
 * two draw calls per tree.
 *
 * A district's trees sit at the far level almost all of the time (the Colosseum: 690 tree draw calls, 10.1 / 22.8 ms GPU
 * p50 / p95 against 1.5 ms with the trees hidden, docs/processes/build_speed_benchmark.md), and the far level is the one
 * level that is plain geometry (blob masses over the main limbs: no instancing). The far meshes of all the trees that wear
 * the same full material (and the same attribute layout) go into one BatchedMesh: each far mesh is one geometry and one
 * instance, in its own frame, with the mesh-to-root transform as its instance matrix, so the crown shading's mesh-frame
 * attributes (the quadric, the lobes) read as before. Each instance has a run of texels in a float texture the batch
 * materials read; the first is its state:
 *
 *   r, g  the share of the hash the far level draws, [lo, hi) in 0..1 (0..1 when it draws whole);
 *   b     1 when the main pass draws the tree's far level (the tree is in the frustum and the level is on);
 *   a     1 when the far level casts the tree's shadow (its casting level, treeLodController);
 *
 * and the rest are the mesh's per-mesh attributes, one texel each (the values the per-tree draws carry as instanced
 * attributes with one value per mesh: the crown constants sbCrownC, sbCrownS0, sbCrownS1, sbCrownL of treeCrownShading.ts
 * and the tree's tint sbTreeTint of treeTextureMaterials.ts), read per instance in the vertex shader in place of the
 * attribute declarations, so the batched vertex is no wider than the tree's own and every per-mesh value a material reads
 * is the one its mesh had.
 *
 * An instance whose far level is off is hidden (setVisibleAt: drawn in no pass); the vertex shader takes a tree the pass does
 * not draw out of the clip volume (the main pass by b, the shadow pass by a); the fragment shader drops the fragments outside
 * [lo, hi) by the same screen-space interleaved-gradient noise the far level's dither variant uses (treeLodFade.ts), so a
 * dissolve between the mid level (drawn by the tree's own meshes) and the far level complements exactly as before and a
 * whole far level discards nothing. The batched mesh culls each instance against the camera of the pass and counts only
 * what it draws, so the pixels and the triangle counts are the per-tree draws'; only the draw calls change.
 *
 * The batch follows whatever the per-tree meshes wear: their full material (the base, or its crown variant; the clay pass
 * and the tree textures change the base), checked every frame from a per-mesh cache, and a changed grouping rebuilds the
 * batch. A tree whose far mesh the staged-build hook has dressed (a reveal, the provenance view: a staged material) is
 * left to its own meshes for those frames. The per-tree far meshes stay in the scene, hidden, for picking (a raycast
 * ignores visibility) and for the trees the batch does not take. Opt out with `?sbTreeFarBatch=0` or
 * `localStorage['sb.treeFarBatch'] = '0'` (before / after comparisons with `?sbViewportCost=1`).
 */

import * as THREE from 'three';
import { isStagedMaterial } from '../stagedBuild/revealMaterial';
import { breakupDepthMaterial, isBreakupDepthMaterial } from './treeCrownShading';
import { FADE_STEPS } from './treeLodMath';

const BATCH_FLAG = 'sbTreeFarBatch';
/** Texels per row of the state texture. */
const STATE_ROW = 4096;
const GLSL_TYPES = ['float', 'vec2', 'vec3', 'vec4'];
const SWIZZLES = ['.x', '.xy', '.xyz', ''];

export function treeFarBatchEnabled(): boolean {
    try {
        if (typeof window === 'undefined') return true;
        const q = new URLSearchParams(window.location.search).get('sbTreeFarBatch');
        if (q !== null) return q !== '0';
        return window.localStorage?.getItem('sb.treeFarBatch') !== '0';
    } catch {
        return true;
    }
}

/** Marks a batch mesh or its holder (the per-tree meshes keep their own tags). */
export const isTreeFarBatchObject = (o: THREE.Object3D): boolean => !!(o.userData as { [BATCH_FLAG]?: boolean })[BATCH_FLAG];

export interface FarBatchTree {
    /** The tree's node (its visibility is the controller's frustum cull). */
    node: THREE.Object3D;
    /** The far level's meshes (plain, one material each). */
    meshes: THREE.Mesh[];
}

/** A tree's far-level state for one frame. */
export interface FarTreeState {
    /** The draw state the controller applied to the far level: 'off', 'full', 'lo-hi' (FADE_STEPS steps) or 'redress' (unchanged). */
    applied: string;
    /** The main camera sees the tree (not culled, in the frustum). */
    inMain: boolean;
    /** The far level is the tree's casting level. */
    casts: boolean;
}

interface Instance { tree: number; mesh: THREE.Mesh; id: number; visible: boolean }
/** A per-mesh attribute of a group's meshes (one value per mesh), carried in the instance texels. */
interface PerMeshAttribute { name: string; itemSize: number }

interface Group {
    key: string;
    full: THREE.Material;
    /** The group's per-mesh attributes, in texel order after the state; texels per instance = 1 + their count. */
    perMesh: PerMeshAttribute[];
    texelsPerInstance: number;
    batched: THREE.BatchedMesh;
    /** Worn while every instance draws whole (no discard in the shader, so the GPU keeps its early depth test). */
    material: THREE.Material;
    /** Worn while any instance is in a dissolve (the dither's discard), as the per-tree fade variants were. */
    fading: THREE.Material;
    depth: THREE.Material;
    state: THREE.DataTexture;
    data: Float32Array;
    instances: Instance[];
}

/** What decides a mesh's group, remembered per mesh so a frame recomputes nothing that did not change. */
interface MeshCache { base: THREE.Material | undefined; material: THREE.Material | THREE.Material[]; full: THREE.Material | undefined; depth: THREE.Material | undefined; geometry: THREE.BufferGeometry; layout: string; key: string }

/** The attribute layout of a geometry (names, item sizes, types), so only geometries that batch together are grouped together. */
function layoutOf(g: THREE.BufferGeometry): string {
    return Object.keys(g.attributes).sort().map(n => { const a = g.attributes[n] as THREE.BufferAttribute; return `${n}:${a.itemSize}${a.normalized ? 'n' : ''}:${a.array.constructor.name}`; }).join(',');
}

function readState(applied: string): { lo: number; hi: number; on: boolean } | undefined {
    if (applied === 'off') return { lo: 0, hi: 0, on: false };
    if (applied === 'full') return { lo: 0, hi: 1, on: true };
    const m = /^(\d+)-(\d+)$/.exec(applied);
    if (!m) return undefined;                                   // 'redress': unchanged
    return { lo: Number(m[1]) / FADE_STEPS, hi: Number(m[2]) / FADE_STEPS, on: true };
}

const VERTEX_PARS = `
uniform sampler2D uSbTreeState;
uniform float uSbFarPass;
varying vec2 vSbTreeRange;
mat4 sbBatchM = mat4( 1.0 );
float sbFarDrawn = 1.0;
vec4 sbTreeTexel( int i ) { return texelFetch( uSbTreeState, ivec2( i % ${STATE_ROW}, i / ${STATE_ROW} ), 0 ); }
`;
/** After batching_vertex: this instance's state, its per-mesh attributes and its matrix (for the crown code's world and view-space terms). */
const VERTEX_STATE = `
{
    int sbI = int( getIndirectIndex( gl_DrawID ) + 0.5 ) * SB_TEXELS_PER_INSTANCE;
    vec4 sbState = sbTreeTexel( sbI );
    vSbTreeRange = sbState.xy;
    sbFarDrawn = uSbFarPass > 0.5 ? sbState.w : sbState.z;
    sbBatchM = batchingMatrix;
    SB_PER_MESH_READS
}`;
/** After project_vertex: a tree the pass does not draw leaves the clip volume. */
const VERTEX_CULL = `
if ( sbFarDrawn < 0.5 ) gl_Position = vec4( 2.0, 2.0, 2.0, 1.0 );`;
const FRAGMENT_PARS = `
varying vec2 vSbTreeRange;
`;
/** The far level's dither (treeLodFade.ts, plain meshes): the same noise, the tree's own range. A whole level drops nothing. */
const FRAGMENT_MAIN = `
{
    float sbn = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
    if (sbn < vSbTreeRange.x || sbn >= vSbTreeRange.y) discard;
}`;

/**
 * The crown shading's world and view-space terms (treeCrownShading.ts) take the mesh's frame from the object's matrices; in
 * a batch the instance matrix sits between them. Its mesh-frame terms (the field, the quadric) are left as they are.
 */
const CROWN_BATCH_PATCHES: Array<[string, string]> = [
    ['modelMatrix * sbLocal', 'modelMatrix * sbBatchM * sbLocal'],
    ['modelMatrix * vec4( sbCrownC.xyz, 1.0 )', 'modelMatrix * sbBatchM * vec4( sbCrownC.xyz, 1.0 )'],
    ['modelViewMatrix * sbLocal', 'modelViewMatrix * sbBatchM * sbLocal'],
    ['modelViewMatrix * vec4( sbCrownC.xyz, 1.0 )', 'modelViewMatrix * sbBatchM * vec4( sbCrownC.xyz, 1.0 )'],
    ['normalMatrix * sbG', 'normalMatrix * mat3( sbBatchM ) * sbG'],
    ['normalMatrix * sbJ', 'normalMatrix * mat3( sbBatchM ) * sbJ']
];

/**
 * The batch's vertex shader: the instance state read after the batching chunk, the pass's cull after the projection, every
 * per-mesh attribute the shader declares turned into a global read from the instance's texels, and the crown code's
 * object-space terms given the instance matrix.
 */
function batchVertexShader(src: string, perMesh: PerMeshAttribute[]): string {
    const reads: string[] = [];
    let v = src;
    perMesh.forEach((a, k) => {
        const type = GLSL_TYPES[a.itemSize - 1];
        const decl = new RegExp(`attribute\\s+${type}\\s+${a.name}\\s*;`);
        if (!decl.test(v)) return;                               // this material does not read it
        v = v.replace(decl, `${type} ${a.name} = ${type}( 0.0 );`);
        reads.push(`${a.name} = sbTreeTexel( sbI + ${k + 1} )${SWIZZLES[a.itemSize - 1]};`);
    });
    v = v
        .replace('#include <common>', `#include <common>\n${VERTEX_PARS}`)
        .replace('#include <batching_vertex>', `#include <batching_vertex>\n${VERTEX_STATE.replace('SB_TEXELS_PER_INSTANCE', String(1 + perMesh.length)).replace('SB_PER_MESH_READS', reads.join('\n    '))}`)
        .replace('#include <project_vertex>', `#include <project_vertex>\n${VERTEX_CULL}`);
    for (const [from, to] of CROWN_BATCH_PATCHES) v = v.split(from).join(to);
    return v;
}

/**
 * The batch's material: the group's full material with the per-instance state read in. With `fading` the fragment shader
 * carries the dither's discard (worn only while an instance dissolves: a shader with a discard loses the GPU's early depth
 * test, which the per-tree draws paid only for their fade variants).
 */
function batchMaterial(full: THREE.Material, state: THREE.DataTexture, perMesh: PerMeshAttribute[], fading: boolean): THREE.Material {
    const mat = full.clone();
    mat.userData = { ...full.userData, [BATCH_FLAG]: true };
    const baseKey = full.customProgramCacheKey?.call(full) ?? '';
    const layout = perMesh.map(a => `${a.name}${a.itemSize}`).join(',');
    mat.customProgramCacheKey = () => `${baseKey}|sbfarbatch${fading ? 'F' : ''}|${layout}`;
    mat.onBeforeCompile = (shader, renderer) => {
        full.onBeforeCompile?.call(full, shader, renderer);
        shader.uniforms.uSbTreeState = { value: state };
        shader.uniforms.uSbFarPass = { value: 0 };
        shader.vertexShader = batchVertexShader(shader.vertexShader, perMesh);
        shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `#include <common>\n${FRAGMENT_PARS}`);
        if (fading) shader.fragmentShader = shader.fragmentShader.replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>\n${FRAGMENT_MAIN}`);
    };
    mat.needsUpdate = true;
    return mat;
}

/** The shadow pass's depth material: the breakup's (crown leaves) or a plain one, drawing only the trees whose far level casts. */
function batchDepthMaterial(breakup: boolean, state: THREE.DataTexture, perMesh: PerMeshAttribute[]): THREE.MeshDepthMaterial {
    const base = breakup ? breakupDepthMaterial() : undefined;
    const mat = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
    if (base) mat.defines = { ...(base.defines ?? {}) };
    mat.userData = { [BATCH_FLAG]: true };
    const layout = perMesh.map(a => `${a.name}${a.itemSize}`).join(',');
    mat.customProgramCacheKey = () => `${base?.customProgramCacheKey?.call(base) ?? 'depth'}|sbfarbatchdepth|${layout}`;
    mat.onBeforeCompile = (shader, renderer) => {
        base?.onBeforeCompile?.call(base, shader, renderer);
        shader.uniforms.uSbTreeState = { value: state };
        shader.uniforms.uSbFarPass = { value: 1 };
        shader.vertexShader = batchVertexShader(shader.vertexShader, perMesh);
        // the depth pass has no dither: the range is read but never discards (a whole level)
        shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `#include <common>\n${FRAGMENT_PARS}`);
    };
    mat.needsUpdate = true;
    return mat;
}

/** The per-mesh attributes of a geometry (one value per mesh: instanced attributes with the per-mesh divisor), by name. */
function perMeshAttributesOf(g: THREE.BufferGeometry): PerMeshAttribute[] {
    return Object.entries(g.attributes)
        .filter(([, a]) => (a as THREE.InstancedBufferAttribute).isInstancedBufferAttribute && a.itemSize >= 1 && a.itemSize <= 4)
        .map(([name, a]) => ({ name, itemSize: a.itemSize }))
        .sort((a, b) => a.name.localeCompare(b.name));
}

/** A far mesh's geometry as one batched geometry: its own frame, its per-vertex attributes (the per-mesh ones go to the texels), always indexed. */
function batchGeometry(mesh: THREE.Mesh): THREE.BufferGeometry {
    const src = mesh.geometry as THREE.BufferGeometry;
    const g = new THREE.BufferGeometry();
    const count = src.getAttribute('position').count;
    for (const [name, attr] of Object.entries(src.attributes)) {
        const a = attr as THREE.BufferAttribute & { isInstancedBufferAttribute?: boolean };
        if (a.isInstancedBufferAttribute) continue;
        g.setAttribute(name, a);
    }
    if (src.index) g.setIndex(src.index);
    else {
        const idx = new (count > 65535 ? Uint32Array : Uint16Array)(count);
        for (let i = 0; i < count; i++) idx[i] = i;
        g.setIndex(new THREE.BufferAttribute(idx, 1));
    }
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
}

export class TreeFarBatch {
    /** The group the batches hang from (named as a level gate, so the viewport cost probe counts them with the far level). */
    readonly holder: THREE.Object3D;
    private groups: Group[] = [];
    /** Per tree: the group keys its far meshes are batched under ('' = drawn by its own meshes). */
    private readonly batchedAs: string[];
    private readonly lastApplied: string[];
    private readonly cache = new Map<THREE.Mesh, MeshCache>();
    private readonly tmp = new THREE.Matrix4();
    private stale = true;

    constructor(readonly root: THREE.Object3D, readonly trees: FarBatchTree[], farLevel: number) {
        this.holder = new THREE.Object3D();
        this.holder.name = `sb-lod-gate-${farLevel}`;
        this.holder.userData[BATCH_FLAG] = true;
        root.add(this.holder);
        this.batchedAs = trees.map(() => '');
        this.lastApplied = trees.map(() => 'off');
    }

    /** Trees drawn through the batch, and the draw calls it takes (one per group). */
    get stats(): { batchedTrees: number; groups: number } {
        return { batchedTrees: this.batchedAs.filter(Boolean).length, groups: this.groups.length };
    }

    /**
     * The group key a mesh joins this frame ('' when it is left to itself), from the per-mesh cache: three identity reads a
     * frame; the full material is asked again only when the base changed or the caller says its mapping changed (`force`: a
     * crown or tint toggle, which gives the same base a different full material).
     */
    private keyOf(m: THREE.Mesh, fullOf: (m: THREE.Mesh, base: THREE.Material) => THREE.Material, force: boolean): string {
        const base = m.userData.sbLodBase as THREE.Material | undefined;
        const geometry = m.geometry as THREE.BufferGeometry;
        const c = this.cache.get(m);
        if (!force && c && c.base === base && c.material === m.material && c.depth === m.customDepthMaterial && c.geometry === geometry) return c.key;
        const full = base ? fullOf(m, base) : undefined;
        if (c && c.base === base && c.material === m.material && c.full === full && c.depth === m.customDepthMaterial && c.geometry === geometry) return c.key;
        let key = '';
        if (base && full && !Array.isArray(m.material) && !isStagedMaterial(m.material as THREE.Material) && !(m as THREE.InstancedMesh).isInstancedMesh && geometry?.getAttribute('position')) {
            const layout = c && c.geometry === geometry ? c.layout : layoutOf(geometry);
            key = `${full.uuid}|${isBreakupDepthMaterial(m.customDepthMaterial) ? 'B' : 'P'}|${layout}`;
            this.cache.set(m, { base, material: m.material, full, depth: m.customDepthMaterial, geometry, layout, key });
        } else {
            this.cache.set(m, { base, material: m.material, full, depth: m.customDepthMaterial, geometry, layout: c?.layout ?? '', key });
        }
        return key;
    }

    /** The keys a tree's far meshes join, joined; '' when any of them is left to itself (then the whole tree is). */
    private treeKey(t: FarBatchTree, fullOf: (m: THREE.Mesh, base: THREE.Material) => THREE.Material, force: boolean): string {
        if (!t.meshes.length) return '';
        let key = '';
        for (const m of t.meshes) {
            const k = this.keyOf(m, fullOf, force);
            if (!k) return '';
            key = key ? `${key};${k}` : k;
        }
        return key;
    }

    /**
     * Keeps the batch in step with the trees: regroups when any tree's full material, dressing or batchability changed since the
     * last frame, writes each instance's texel and visibility from its tree's far-level state, follows a moved tree, and keeps the
     * per-tree far gates hidden for batched trees. Returns whether the batch was rebuilt and the trees that left it (their own
     * far gates are the controller's to show again).
     */
    sync(states: FarTreeState[], gates: THREE.Object3D[], fullOf: (m: THREE.Mesh, base: THREE.Material) => THREE.Material, force = false): { regrouped: boolean; left: number[] } {
        let regroup = this.stale;
        const keys = this.trees.map(t => this.treeKey(t, fullOf, force));
        const left: number[] = [];
        for (let i = 0; i < keys.length; i++) {
            if (keys[i] !== this.batchedAs[i]) regroup = true;
            if (!keys[i] && this.batchedAs[i]) left.push(i);
        }
        if (regroup) this.rebuild(keys, fullOf);
        const on: Array<{ lo: number; hi: number; on: boolean } | undefined> = new Array(this.trees.length);
        for (let i = 0; i < this.trees.length; i++) {
            if (!this.batchedAs[i]) continue;
            const s = states[i];
            on[i] = readState(s.applied) ?? readState(this.lastApplied[i]) ?? { lo: 0, hi: 0, on: false };
            if (s.applied !== 'redress') this.lastApplied[i] = s.applied;
            // the tree's own far meshes are not drawn (the batch draws them); they stay for picking
            if (gates[i].visible) gates[i].visible = false;
        }
        for (const g of this.groups) {
            let dirty = false, fading = false;
            for (const inst of g.instances) {
                const st = on[inst.tree]!, s = states[inst.tree], t = this.trees[inst.tree], o = 4 * g.texelsPerInstance * inst.id;
                const visible = t.node.visible && st.on;
                if (visible !== inst.visible) { g.batched.setVisibleAt(inst.id, visible); inst.visible = visible; }
                const main = visible && s.inMain ? 1 : 0, cast = visible && s.casts ? 1 : 0;
                if (g.data[o] !== st.lo || g.data[o + 1] !== st.hi || g.data[o + 2] !== main || g.data[o + 3] !== cast) {
                    g.data[o] = st.lo; g.data[o + 1] = st.hi; g.data[o + 2] = main; g.data[o + 3] = cast;
                    dirty = true;
                }
                if (main && (st.lo > 0 || st.hi < 1)) fading = true;
            }
            if (dirty) g.state.needsUpdate = true;
            // the dither's discard only while an instance dissolves; a swap behind our back (the clay preset pass) is undone here too
            const wear = fading ? g.fading : g.material;
            if (g.batched.material !== wear) g.batched.material = wear;
        }
        return { regrouped: regroup, left };
    }

    /** Each instance's matrix: its mesh's frame in the root's (the trees do not move; set when the batch is built or on `refreshMatrices`). */
    refreshMatrices(): void {
        this.root.updateMatrixWorld(true);
        const rootInverse = this.tmp.copy(this.root.matrixWorld).invert();
        const m = new THREE.Matrix4();
        for (const g of this.groups) {
            for (const inst of g.instances) {
                inst.mesh.updateWorldMatrix(true, false);
                g.batched.setMatrixAt(inst.id, m.multiplyMatrices(rootInverse, inst.mesh.matrixWorld));
            }
        }
    }

    private rebuild(keys: string[], fullOf: (m: THREE.Mesh, base: THREE.Material) => THREE.Material): void {
        this.clearGroups();
        const parts = new Map<string, { full: THREE.Material; breakup: boolean; members: Array<{ tree: number; mesh: THREE.Mesh; geometry: THREE.BufferGeometry }> }>();
        for (let i = 0; i < this.trees.length; i++) {
            this.batchedAs[i] = keys[i];
            if (!keys[i]) continue;
            for (const mesh of this.trees[i].meshes) {
                const base = mesh.userData.sbLodBase as THREE.Material;
                const k = this.keyOf(mesh, fullOf, false);
                const p = parts.get(k) ?? parts.set(k, { full: fullOf(mesh, base), breakup: isBreakupDepthMaterial(mesh.customDepthMaterial), members: [] }).get(k)!;
                p.members.push({ tree: i, mesh, geometry: batchGeometry(mesh) });
            }
        }
        for (const [key, p] of parts) {
            const vertices = p.members.reduce((a, x) => a + x.geometry.getAttribute('position').count, 0);
            const indices = p.members.reduce((a, x) => a + x.geometry.index!.count, 0);
            const n = p.members.length;
            const perMesh = perMeshAttributesOf(p.members[0].mesh.geometry as THREE.BufferGeometry);
            const texelsPerInstance = 1 + perMesh.length;
            const rows = Math.ceil((texelsPerInstance * n) / STATE_ROW);
            const data = new Float32Array(4 * STATE_ROW * rows);
            const state = new THREE.DataTexture(data, STATE_ROW, rows, THREE.RGBAFormat, THREE.FloatType);
            state.magFilter = state.minFilter = THREE.NearestFilter;
            state.generateMipmaps = false;
            state.needsUpdate = true;
            const material = batchMaterial(p.full, state, perMesh, false);
            const fading = batchMaterial(p.full, state, perMesh, true);
            const depth = batchDepthMaterial(p.breakup, state, perMesh);
            const batched = new THREE.BatchedMesh(n, vertices, indices, material);
            batched.name = 'sb-tree-far-batch';
            batched.castShadow = true;
            batched.receiveShadow = true;
            batched.customDepthMaterial = depth;
            batched.userData[BATCH_FLAG] = true;
            batched.userData.sbTexelsPerInstance = texelsPerInstance;
            batched.userData.sbPerMeshAttributes = perMesh.map(a => a.name);
            // the per-tree meshes answer picking; the batch is never hit
            batched.raycast = () => undefined;
            const instances: Instance[] = [];
            for (const x of p.members) {
                const geometryId = batched.addGeometry(x.geometry);
                const id = batched.addInstance(geometryId);
                batched.setVisibleAt(id, false);
                instances.push({ tree: x.tree, mesh: x.mesh, id, visible: false });
                // the mesh's per-mesh attributes, one texel each after its state
                perMesh.forEach((pa, k) => {
                    const a = (x.mesh.geometry as THREE.BufferGeometry).getAttribute(pa.name) as THREE.BufferAttribute | undefined;
                    if (a) for (let c = 0; c < pa.itemSize; c++) data[4 * (texelsPerInstance * id + 1 + k) + c] = (a.array as ArrayLike<number>)[c];
                });
            }
            this.holder.add(batched);
            this.groups.push({ key, full: p.full, perMesh, texelsPerInstance, batched, material, fading, depth, state, data, instances });
        }
        this.refreshMatrices();
        this.stale = false;
    }

    private clearGroups(): void {
        for (const g of this.groups) {
            this.holder.remove(g.batched);
            g.batched.dispose();
            g.material.dispose();
            g.fading.dispose();
            g.depth.dispose();
            g.state.dispose();
        }
        this.groups = [];
    }

    /** The batched meshes (diagnostics and tests). */
    get batches(): readonly THREE.BatchedMesh[] { return this.groups.map(g => g.batched); }

    /** Takes the batch out of the scene; the trees' own far gates are the controller's to show again. */
    dispose(): void {
        this.clearGroups();
        this.root.remove(this.holder);
        this.batchedAs.fill('');
        this.cache.clear();
    }
}
