/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Pipeline K's inner core: a closed solid inside the finished building, behind every surface it has, seen only through
 * whatever hole the outside still has. A hole then shows a surface textured like the wall around it, not the building's
 * inside (the back of a wall's photo) or the sky through the building. Built natively (scratchbox_inner_core.hpp, whose
 * comment gives the rules): voxels under the building's own top-down heightfield and inside its footprint, inside by its
 * winding number, and at least insetM behind every surface, scan, rebuilt wall or fill, so it never stands in front of any.
 *
 * Its faces take the photo of the surface they sit behind: the nearest rebuilt wall facing alike, else the nearest other
 * photo-textured surface facing alike, the face's corners projected onto that surface's plane and mapped through its own
 * texture coordinates (a rebuilt wall's are linear over the whole wall, so its photo carries straight on); clay where no
 * surface within reach faces alike (the core's underside). Labelled generated, with the reason, in the node's extras
 * (sbInnerCore). The clay gets the same solid, untextured.
 */

import type { Vec2 } from '../../../../common/spatial/staged-location-contracts';
import { assembleGlb, nodeWorldMatrices, parseGlbBytes, readAccessor, transformPoint, type ParsedGlb } from '../glb-bytes';
import { nativePolishThreads, runNativeInnerCore } from '../remesh-polish-native';

export const INNER_CORE_VERSION = 'inner-core/1';

export const INNER_CORE_PARAMS = {
    /** The voxel's plan side and height (m). */
    cellM: 1.5, layerM: 1.5,
    /** The core's box stays at least this far behind every surface, and under the heightfield (m). */
    insetM: 1.0,
    /** Inside where the building's winding number is at least this. */
    windingMin: 0.5,
    /** Barnes-Hut: a node is one dipole beyond this many of its radii. */
    farRatio: 2,
    /** Within a repair region (a hole with no core behind it): the smaller inset (m) and winding threshold. */
    minInsetM: 0.3, regionWindingMin: 0.3,
    /** A face takes its photo from a surface facing within this |cos|, no further than textureMaxM (m). */
    facingMin: 0.5, textureMaxM: 12,
    /** Fewer voxels than this in one piece are no core. */
    minComponentVoxels: 8,
    /** The confidence the core's faces carry: generated behind a hole, its photo the wall's in front of it. */
    confidence: 0.3
};
export type InnerCoreParams = typeof INNER_CORE_PARAMS;

export function innerCoreParamVector(P: InnerCoreParams): number[] {
    return [P.cellM, P.layerM, P.insetM, P.windingMin, P.farRatio, P.minInsetM, P.regionWindingMin, P.facingMin, P.textureMaxM, P.minComponentVoxels];
}

/** A place where the core may come closer to the surface (a hole the outside check found with no core behind it). */
export interface CoreRegion { c: [number, number, number]; r: number }

export interface InnerCoreReport {
    version: string;
    angleDeg: number; grid: [number, number, number];
    candidates: number; keptVoxels: number; droppedSpecks: number; nearSurface: number; outside: number; inRegions: number;
    areaM2: number; volumeM3: number;
    /** The least distance of the core's box to the nearest surface (m): at least insetM (minInsetM in a repair region). */
    minClearanceM: number;
    facesWall: number; facesPhoto: number; facesNone: number;
    triangles: number; regions: number;
}

/** Every triangle of a GLB in world space, with what the hole check and the core need of it. */
export interface Soup {
    pos: Float32Array;
    /** 0 untextured, 1 photo-textured, 2 a rebuilt wall (a FacadeLattice node) with a photo. */
    kind: Uint8Array;
    /** Per triangle its material (-1: none) and its corners' texture coordinates (6 values; NaN when untextured). */
    material: Int32Array;
    uv: Float64Array;
    /** Per triangle its node's index, and 1 when that node is a rebuilt wall (textured or not). */
    node: Int32Array;
    wall: Uint8Array;
}

export function readSoup(g: ParsedGlb, skip: (nodeName: string, extras: any) => boolean = () => false): Soup {
    const json = g.json, world = nodeWorldMatrices(json);
    const textured = (json.materials ?? []).map((m: any) => m?.pbrMetallicRoughness?.baseColorTexture !== undefined);
    const pos: number[] = [], kind: number[] = [], material: number[] = [], uv: number[] = [], node: number[] = [], walls: number[] = [];
    (json.nodes ?? []).forEach((n: any, ni: number) => {
        if (n.mesh === undefined || skip(n.name ?? '', n.extras)) return;
        const m = world[ni];
        const det = m[0] * (m[5] * m[10] - m[6] * m[9]) - m[4] * (m[1] * m[10] - m[2] * m[9]) + m[8] * (m[1] * m[6] - m[2] * m[5]);
        const wall = !!n.extras?.sbFacadeLattice;
        for (const p of json.meshes[n.mesh]?.primitives ?? []) {
            if ((p.mode ?? 4) !== 4 || p.attributes?.POSITION === undefined) continue;
            const X = readAccessor(g, p.attributes.POSITION).data;
            const I = p.indices !== undefined ? readAccessor(g, p.indices).data : Float64Array.from({ length: X.length / 3 }, (_, i) => i);
            const photo = p.material !== undefined && textured[p.material] && p.attributes.TEXCOORD_0 !== undefined;
            const T = photo ? readAccessor(g, p.attributes.TEXCOORD_0).data : undefined;
            const order = det < 0 ? [0, 2, 1] : [0, 1, 2];
            for (let t = 0; t + 2 < I.length; t += 3) {
                for (const k of order) { const v = I[t + k]; pos.push(...transformPoint(m, X[v * 3], X[v * 3 + 1], X[v * 3 + 2])); if (T) uv.push(T[v * 2], T[v * 2 + 1]); else uv.push(NaN, NaN); }
                kind.push(photo ? (wall ? 2 : 1) : 0);
                material.push(p.material ?? -1);
                node.push(ni);
                walls.push(wall ? 1 : 0);
            }
        }
    });
    return { pos: Float32Array.from(pos), kind: Uint8Array.from(kind), material: Int32Array.from(material), uv: Float64Array.from(uv), node: Int32Array.from(node), wall: Uint8Array.from(walls) };
}

/** One primitive to append: triangle soup positions (9 per triangle) or indexed, with optional normals, uv and float attributes. */
export interface AppendPrim { positions: Float32Array; indices?: Uint32Array; normals?: Float32Array; uv?: Float32Array; attributes?: Record<string, Float32Array>; material: number | Record<string, unknown> }

/** Appends one node of primitives at the scene's root (world space), its materials either existing indices or new ones. */
export function appendNode(bytes: Uint8Array, prims: AppendPrim[], name: string, extras: Record<string, unknown>): Buffer {
    const g = parseGlbBytes(bytes);
    const json = g.json;
    json.bufferViews ??= []; json.accessors ??= []; json.meshes ??= []; json.nodes ??= []; json.materials ??= [];
    const chunks: Uint8Array[] = [g.bin];
    let len = g.bin.length;
    const push = (arr: Float32Array | Uint32Array, target: number) => {
        const pad = (4 - (len % 4)) % 4;
        if (pad) { chunks.push(new Uint8Array(pad)); len += pad; }
        json.bufferViews.push({ buffer: 0, byteOffset: len, byteLength: arr.byteLength, target });
        chunks.push(new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength)); len += arr.byteLength;
        return json.bufferViews.length - 1;
    };
    const primitives: any[] = [];
    for (const p of prims) {
        if (!p.positions.length) continue;
        const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
        for (let v = 0; v < p.positions.length; v += 3) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], p.positions[v + k]); max[k] = Math.max(max[k], p.positions[v + k]); }
        json.accessors.push({ bufferView: push(p.positions, 34962), componentType: 5126, count: p.positions.length / 3, type: 'VEC3', min, max });
        const attributes: Record<string, number> = { POSITION: json.accessors.length - 1 };
        if (p.normals) { json.accessors.push({ bufferView: push(p.normals, 34962), componentType: 5126, count: p.normals.length / 3, type: 'VEC3' }); attributes.NORMAL = json.accessors.length - 1; }
        if (p.uv) { json.accessors.push({ bufferView: push(p.uv, 34962), componentType: 5126, count: p.uv.length / 2, type: 'VEC2' }); attributes.TEXCOORD_0 = json.accessors.length - 1; }
        for (const [k, a] of Object.entries(p.attributes ?? {})) { json.accessors.push({ bufferView: push(a, 34962), componentType: 5126, count: a.length, type: 'SCALAR' }); attributes[k] = json.accessors.length - 1; }
        let material: number;
        if (typeof p.material === 'number') material = p.material;
        else { json.materials.push(p.material); material = json.materials.length - 1; }
        const prim: any = { attributes, material, mode: 4 };
        if (p.indices) { json.accessors.push({ bufferView: push(p.indices, 34963), componentType: 5125, count: p.indices.length, type: 'SCALAR' }); prim.indices = json.accessors.length - 1; }
        primitives.push(prim);
    }
    if (!primitives.length) return assembleGlb(json, g.bin);
    json.meshes.push({ name, primitives });
    json.nodes.push({ name, mesh: json.meshes.length - 1, extras });
    json.scenes?.[json.scene ?? 0]?.nodes?.push(json.nodes.length - 1);
    const pad = (4 - (len % 4)) % 4;
    if (pad) { chunks.push(new Uint8Array(pad)); len += pad; }
    const bin = new Uint8Array(len);
    let o = 0;
    for (const c of chunks) { bin.set(c, o); o += c.length; }
    json.buffers = [{ ...(json.buffers?.[0] ?? {}), byteLength: len }];
    return assembleGlb(json, bin);
}

const CLAY = (name: string) => ({ name, pbrMetallicRoughness: { baseColorFactor: [0.55, 0.53, 0.5, 1], metallicFactor: 0, roughnessFactor: 0.9 } });

/**
 * A triangle's texture coordinates at points beyond it: each point projected onto the triangle's plane and weighted by its
 * barycentric coordinates there (outside the triangle too), so the triangle's own mapping carries on across it.
 */
export function extendMapping(tri: ArrayLike<number>, uv: ArrayLike<number>, pts: number[][]): number[][] | undefined {
    const a = [tri[0], tri[1], tri[2]], e1 = [tri[3] - a[0], tri[4] - a[1], tri[5] - a[2]], e2 = [tri[6] - a[0], tri[7] - a[1], tri[8] - a[2]];
    const d11 = e1[0] * e1[0] + e1[1] * e1[1] + e1[2] * e1[2], d12 = e1[0] * e2[0] + e1[1] * e2[1] + e1[2] * e2[2], d22 = e2[0] * e2[0] + e2[1] * e2[1] + e2[2] * e2[2];
    const den = d11 * d22 - d12 * d12;
    if (!(Math.abs(den) > 1e-12)) return undefined;
    return pts.map(p => {
        const q = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
        const q1 = q[0] * e1[0] + q[1] * e1[1] + q[2] * e1[2], q2 = q[0] * e2[0] + q[1] * e2[1] + q[2] * e2[2];
        // the projection onto the plane is implied: the components along e1 and e2 alone
        const w1 = (d22 * q1 - d12 * q2) / den, w2 = (d11 * q2 - d12 * q1) / den, w0 = 1 - w1 - w2;
        return [w0 * uv[0] + w1 * uv[2] + w2 * uv[4], w0 * uv[1] + w1 * uv[3] + w2 * uv[5]];
    });
}

const ROUTES = ['clay: no surface within reach faces this way', "the nearest rebuilt wall's photo, its mapping carried on", "the nearest photo-textured surface's photo, its mapping carried on"];

/** The inner core added to the clay and its textured copies (one node, InnerCore); the soup the core is built from is the first textured copy's (what is seen), else the clay's. */
export function addInnerCore(clay: Uint8Array, others: Uint8Array[], opts: { footprint?: Vec2[][]; groundY?: number; regions?: CoreRegion[]; threads?: number } = {}, P: InnerCoreParams = INNER_CORE_PARAMS): { clay: Buffer; others: Buffer[]; report: InnerCoreReport } {
    const seenBytes = others[0] ?? clay;
    const soup = readSoup(parseGlbBytes(seenBytes), name => name === 'InnerCore');
    const r = runNativeInnerCore(innerCoreParamVector(P), soup.pos, soup.kind, opts.footprint ?? [], opts.groundY, opts.regions ?? [], opts.threads ?? nativePolishThreads());
    const nTri = r.indices.length / 3;
    const report = { version: INNER_CORE_VERSION, ...(r.report as Omit<InnerCoreReport, 'version' | 'triangles' | 'regions'>), triangles: nTri, regions: opts.regions?.length ?? 0 } as InnerCoreReport;
    const method = `a closed solid inside the building (${INNER_CORE_VERSION}): voxels of ${P.cellM} x ${P.cellM} x ${P.layerM} m under the building's own top-down heightfield${opts.footprint?.length ? ' and inside its footprint' : ''}, inside by its winding number (at least ${P.windingMin}), at least ${P.insetM} m behind every surface it has (${P.minInsetM} m where a hole showed no core behind it), so it is seen only through a hole; each face takes the photo of the surface it sits behind (the nearest rebuilt wall facing alike, else the nearest photo-textured surface, its mapping carried on), clay where none faces alike`;
    const extras = { sbInnerCore: { version: INNER_CORE_VERSION, provenance: { label: 'generated', confidence: P.confidence, method }, report, routes: ROUTES.map((label, code) => ({ code, label })) } };
    if (!nTri) return { clay: Buffer.from(clay), others: others.map(b => Buffer.from(b)), report };
    const positions = Float32Array.from(r.positions);
    // the clay: one welded, closed mesh
    const normals = new Float32Array(positions.length);
    for (let t = 0; t < nTri; t++) {
        const [a, b, c] = [r.indices[t * 3], r.indices[t * 3 + 1], r.indices[t * 3 + 2]];
        const e1 = [0, 1, 2].map(k => positions[b * 3 + k] - positions[a * 3 + k]), e2 = [0, 1, 2].map(k => positions[c * 3 + k] - positions[a * 3 + k]);
        const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
        for (const v of [a, b, c]) for (let k = 0; k < 3; k++) normals[v * 3 + k] += n[k];
    }
    for (let v = 0; v < normals.length; v += 3) { const l = Math.hypot(normals[v], normals[v + 1], normals[v + 2]) || 1; normals[v] /= l; normals[v + 1] /= l; normals[v + 2] /= l; }
    const clayOut = appendNode(clay, [{ positions, indices: r.indices, normals, material: CLAY('InnerCore') }], 'InnerCore', extras);
    // the textured copies: per source material, the faces mapped through their source triangle's texture coordinates
    const byMat = new Map<number, number[]>();
    const uvs = new Float64Array(nTri * 6);
    for (let t = 0; t < nTri; t++) {
        const s = r.source[t];
        let mat = -1;
        if (s >= 0 && r.route[t] > 0) {
            const pts = [0, 1, 2].map(k => { const v = r.indices[t * 3 + k]; return [r.positions[v * 3], r.positions[v * 3 + 1], r.positions[v * 3 + 2]]; });
            const m = extendMapping(soup.pos.subarray(s * 9, s * 9 + 9), soup.uv.subarray(s * 6, s * 6 + 6), pts);
            if (m && m.every(x => Number.isFinite(x[0]) && Number.isFinite(x[1]))) { mat = soup.material[s]; m.forEach((x, k) => { uvs[t * 6 + k * 2] = x[0]; uvs[t * 6 + k * 2 + 1] = x[1]; }); }
        }
        const l = byMat.get(mat);
        if (l) l.push(t); else byMat.set(mat, [t]);
    }
    const texPrims: AppendPrim[] = [...byMat].map(([mat, list]) => {
        const P9 = new Float32Array(list.length * 9), N9 = new Float32Array(list.length * 9), UV = new Float32Array(list.length * 6), RT = new Float32Array(list.length * 3), CF = new Float32Array(list.length * 3);
        list.forEach((t, i) => {
            for (let k = 0; k < 3; k++) {
                const v = r.indices[t * 3 + k];
                for (let c = 0; c < 3; c++) { P9[i * 9 + k * 3 + c] = positions[v * 3 + c]; N9[i * 9 + k * 3 + c] = normals[v * 3 + c]; }
                UV[i * 6 + k * 2] = uvs[t * 6 + k * 2]; UV[i * 6 + k * 2 + 1] = uvs[t * 6 + k * 2 + 1];
                RT[i * 3 + k] = mat >= 0 ? r.route[t] : 0; CF[i * 3 + k] = mat >= 0 ? P.confidence : 0;
            }
        });
        return mat >= 0 ? { positions: P9, normals: N9, uv: UV, attributes: { _PROVENANCE: RT, _CONFIDENCE: CF }, material: mat } : { positions: P9, normals: N9, attributes: { _PROVENANCE: RT, _CONFIDENCE: CF }, material: CLAY('InnerCore') };
    });
    return { clay: clayOut, others: others.map(b => appendNode(b, texPrims, 'InnerCore', extras)), report };
}

/** One line for the build's notes. */
export function describeInnerCore(r: InnerCoreReport): string {
    if (!r.keptVoxels) return `no inner core: no voxel lies ${INNER_CORE_PARAMS.insetM} m behind every surface inside the building (${r.candidates} under its heightfield, ${r.nearSurface} too near a surface, ${r.outside} outside it)`;
    return `inner core (generated, seen only through holes): ${r.keptVoxels} voxels, ${Math.round(r.volumeM3)} m³, ${Math.round(r.areaM2)} m² of closed surface at least ${Math.round(r.minClearanceM * 100) / 100} m behind every surface; ${r.facesWall} faces take a rebuilt wall's photo, ${r.facesPhoto} another photo, ${r.facesNone} clay${r.regions ? `; ${r.regions} hole regions let it come closer (${r.inRegions} voxels)` : ''}`;
}

