/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Real height on a finished GLB (user ask, 2026-11-05: "real height, it moves the actual geometry"): the surfaces whose
 * material carries a relief (extras.sbMaterial.relief: a class map and a metric frame; the classes' recess tiles in the
 * asset's sbMaterialRelief, written by pipeline K's material regions) get a near level of detail whose triangles are
 * tessellated and displaced by that relief in the native engine (height-displace-native.ts).
 *
 *  - Which surfaces: only those with the relief extras, which the material path writes for rebuilt facades (FacadeLattice
 *    nodes) and generated objects. A scan's own pieces carry none and are never moved (AGENTS.md section 2: inferred
 *    relief never moves the measured surface).
 *  - Where: with `bandM`, only what stands within bandM of the lowest relief surface (a building: the storey a walker
 *    stands beside; the rest is seen from too far for a few centimetres to show, and the viewer's parallax covers it).
 *    Without it, the whole surface (an object).
 *  - Cells: the band's triangles are grouped into cells of cellM (by centroid). Each cell's triangles are moved to the
 *    end of their primitive's index buffer as one run, and its displaced copy is added as a child node of the surface's
 *    node. The surface's own triangles are all still there, undisplaced: a viewer that knows nothing of this draws the
 *    model as before (the displaced copies lie behind the surface, being recesses). The app's viewer (heightRelief.ts)
 *    draws a cell's displaced copy in place of its run when the camera is within showWithinM, so the triangle count on
 *    screen stays bounded.
 *  - Bounded: all displaced cells together hold at most maxTriangles; the kernel coarsens every cell alike until they do,
 *    reading the relief low-passed to the triangles' size (a grain finer than a triangle stays in the shading).
 *  - Joined: a cell's displacement fades to nothing at its border, and the relief fades toward a class's border (the
 *    class map's green channel, when the material says `weights`), so cells and materials meet without a gap or a step.
 *
 * Everything added is labelled generated in the extras: the near nodes, the report on the asset, the provenance entry.
 */

import { assembleGlb, accessorLayout, isIdentity, nodeWorldMatrices, parseGlbBytes, readAccessor, transformPoint, type ParsedGlb } from './staged-location/glb-bytes';
import { decodeImageInMemory } from './staged-location/tile-texture-transfer';
import { displaceByHeight, type DisplacePatch, type ReliefClassMap, type ReliefTile } from './height-displace-native';

export const HEIGHT_RELIEF_VERSION = 'height-relief/2';

export const HEIGHT_RELIEF_PARAMS = {
    /** Only what stands within this of the lowest relief surface is displaced (m); undefined: everything. */
    bandM: 4 as number | undefined,
    /** A cell's side (m): what the viewer swaps as one. */
    cellM: 4,
    /** The kernel's edge lengths and tolerance (m): see scratchbox_height_displace.hpp. */
    edgeMinM: 0.012, edgeMaxM: 0.3, toleranceM: 0.0015,
    /** The displacement fades to nothing over this distance from a cell's border and its seams (m), so cells meet without a gap. */
    fadeM: 0.08,
    /** All displaced cells together (triangles). */
    maxTriangles: 900_000,
    /** A cell whose deepest recess is under this is left as it is (m). */
    minRecessM: 0.001,
    /** The viewer draws a cell's displaced copy within this of the camera (m). */
    showWithinM: 14
};
export type HeightReliefParams = typeof HEIGHT_RELIEF_PARAMS;

export interface HeightReliefReport {
    version: string;
    /** Surfaces (primitives) with a relief, those given displaced cells, and the cells. */
    surfaces: number; displacedSurfaces: number; cells: number;
    /** The cells' triangles before, and their displaced copies' (riserTriangles is 0: a cell's border fades instead). */
    baseTriangles: number; nearTriangles: number; riserTriangles: number;
    /** The least edge asked and used (raised to fit maxTriangles), m. */
    edgeMinAskedM: number; edgeMinUsedM: number;
    /** The deepest recess of any displaced vertex, m, and the area displaced, m2. */
    maxRecessM: number; areaM2: number;
    bandM?: number; showWithinM: number;
    label: 'generated';
    skipped?: string;
    ms: number;
}

/** Whether a pipeline K build runs the displacement: the node graph's switch when set, else SCRATCHBOX_K_HEIGHT_RELIEF (1 on, 0 off), else on for one building and off for a district (its chunks hold dozens of buildings). */
export function heightReliefAsked(steps: Record<string, unknown> | undefined, opts: { district?: boolean } = {}): boolean {
    const asked = steps?.['twin.heightRelief'];
    if (typeof asked === 'boolean') return asked;
    const env = process.env.SCRATCHBOX_K_HEIGHT_RELIEF?.trim();
    return env === '1' ? true : env === '0' ? false : opts.district !== true;
}

export const heightReliefProvenance = (r: Pick<HeightReliefReport, 'areaM2' | 'maxRecessM' | 'nearTriangles' | 'riserTriangles' | 'bandM' | 'showWithinM'>, totalAreaM2: number) => ({
    source: 'height-relief', label: 'generated' as const,
    method: `the rebuilt surfaces' ${r.bandM ? `lowest ${r.bandM} m` : 'whole extent'} tessellated and displaced by their materials' height (library sets, at estimated depths; recesses of at most ${Math.round(r.maxRecessM * 1000)} mm below the rebuilt surface, never above it): ${r.nearTriangles + r.riserTriangles} triangles drawn only within ${r.showWithinM} m of the camera; no measured surface moved`,
    coverage: totalAreaM2 > 0 ? Math.min(1, r.areaM2 / totalAreaM2) : 0
});

interface ReliefAsset { depthM: number; tiles: Array<null | { class: number; texture: number; sizeM: [number, number] }> }

function imageBytesOf(g: ParsedGlb, texture: number): Uint8Array {
    const src = g.json.textures?.[texture]?.source, view = g.json.bufferViews?.[g.json.images?.[src]?.bufferView];
    if (!view) throw new Error(`texture ${texture} has no embedded image`);
    return g.bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength);
}

/** An embedded texture's red channel, a byte a texel, and its green. */
function redOf(g: ParsedGlb, texture: number): { width: number; height: number; values: Uint8Array; green: Uint8Array } {
    const img = decodeImageInMemory(imageBytesOf(g, texture));
    const values = new Uint8Array(img.width * img.height), green = new Uint8Array(img.width * img.height);
    for (let i = 0; i < values.length; i++) { values[i] = img.rgba[i * 4]; green[i] = img.rgba[i * 4 + 1]; }
    return { width: img.width, height: img.height, values, green };
}

/**
 * Adds the displaced near level of detail to a GLB (see the file comment). Returns the GLB unchanged, with the reason in
 * the report, when it carries no relief or nothing in it is deep enough to show.
 */
export async function applyHeightRelief(bytes: Uint8Array, P: HeightReliefParams = HEIGHT_RELIEF_PARAMS, opts: { threads?: number; signal?: AbortSignal } = {}): Promise<{ glb: Uint8Array; report: HeightReliefReport }> {
    const t0 = Date.now();
    const g = parseGlbBytes(bytes);
    const json = JSON.parse(JSON.stringify(g.json));
    const report: HeightReliefReport = { version: HEIGHT_RELIEF_VERSION, surfaces: 0, displacedSurfaces: 0, cells: 0, baseTriangles: 0, nearTriangles: 0, riserTriangles: 0, edgeMinAskedM: P.edgeMinM, edgeMinUsedM: P.edgeMinM, maxRecessM: 0, areaM2: 0, ...(P.bandM ? { bandM: P.bandM } : {}), showWithinM: P.showWithinM, label: 'generated', ms: 0 };
    const skip = (why: string) => ({ glb: bytes, report: { ...report, skipped: why, ms: Date.now() - t0 } });
    const asset = json.asset?.extras?.sbMaterialRelief as ReliefAsset | undefined;
    if (!asset?.tiles?.some(t => t) || !(asset.depthM > 0)) return skip('the model carries no material relief (no class\'s set has a height)');

    const tiles: Array<ReliefTile | undefined> = asset.tiles.map(t => { if (!t) return undefined; const r = redOf(g, t.texture); return { width: r.width, height: r.height, values: r.values, sizeM: t.sizeM }; });
    const world = nodeWorldMatrices(json);
    // every primitive whose material has a relief, with its node
    interface Surface { node: number; mesh: number; prim: any; material: number; classMap: number; uvMetres: [number, number]; pos: Float64Array; nrm: Float64Array; uv: Float64Array; idx: Float64Array; cells: Map<string, number[]> }
    const classMaps: ReliefClassMap[] = [], mapOfTexture = new Map<number, number>();
    const surfaces: Surface[] = [];
    let ground = Infinity;
    for (const [ni, node] of (json.nodes ?? []).entries()) {
        if (node.mesh === undefined) continue;
        for (const prim of json.meshes[node.mesh].primitives ?? []) {
            const relief = json.materials?.[prim.material]?.extras?.sbMaterial?.relief;
            if (!relief || relief.displaced || (prim.mode ?? 4) !== 4 || prim.indices === undefined || prim.attributes?.POSITION === undefined || prim.attributes.NORMAL === undefined) continue;
            const texCoord = json.materials[prim.material].pbrMetallicRoughness?.baseColorTexture?.texCoord ?? 0;
            const uvAcc = prim.attributes[`TEXCOORD_${texCoord}`];
            if (uvAcc === undefined) continue;
            // metres are the world's: a scaled node would stretch the relief
            const m = world[ni], sx = Math.hypot(m[0], m[1], m[2]), sy = Math.hypot(m[4], m[5], m[6]), sz = Math.hypot(m[8], m[9], m[10]);
            if (Math.abs(sx - 1) > 1e-3 || Math.abs(sy - 1) > 1e-3 || Math.abs(sz - 1) > 1e-3) continue;
            if (!mapOfTexture.has(relief.classTexture)) { const c = redOf(g, relief.classTexture); mapOfTexture.set(relief.classTexture, classMaps.length); classMaps.push({ width: c.width, height: c.height, classes: c.values, ...(relief.weights ? { weights: c.green } : {}) }); }
            const s: Surface = { node: ni, mesh: node.mesh, prim, material: prim.material, classMap: mapOfTexture.get(relief.classTexture)!, uvMetres: relief.uvMetres, pos: readAccessor(g, prim.attributes.POSITION).data, nrm: readAccessor(g, prim.attributes.NORMAL).data, uv: readAccessor(g, uvAcc).data, idx: readAccessor(g, prim.indices).data, cells: new Map() };
            surfaces.push(s);
            for (let v = 0; v < s.pos.length; v += 3) ground = Math.min(ground, isIdentity(m) ? s.pos[v + 1] : transformPoint(m, s.pos[v], s.pos[v + 1], s.pos[v + 2])[1]);
        }
    }
    report.surfaces = surfaces.length;
    if (!surfaces.length) return skip('no surface carries a relief (rebuilt facades and generated objects do; a scan\'s own pieces never)');

    // the band's triangles by cell
    for (const s of surfaces) {
        const m = world[s.node];
        for (let t = 0; t + 2 < s.idx.length; t += 3) {
            let cx = 0, cy = 0, cz = 0;
            for (let k = 0; k < 3; k++) { const i = s.idx[t + k]; cx += s.pos[i * 3]; cy += s.pos[i * 3 + 1]; cz += s.pos[i * 3 + 2]; }
            const [wx, wy, wz] = transformPoint(m, cx / 3, cy / 3, cz / 3);
            if (P.bandM && wy - ground > P.bandM) continue;
            const key = `${Math.floor(wx / P.cellM)},${Math.floor((wy - ground) / P.cellM)},${Math.floor(wz / P.cellM)}`;
            const list = s.cells.get(key) ?? [];
            list.push(t / 3);
            s.cells.set(key, list);
        }
    }
    // each cell a patch of its own vertices
    interface Cell { surface: Surface; triangles: number[]; patch: DisplacePatch; areaM2: number }
    const cells: Cell[] = [];
    for (const s of surfaces) for (const triangles of s.cells.values()) {
        const remap = new Map<number, number>(), order: number[] = [], indices = new Uint32Array(triangles.length * 3);
        let area = 0;
        triangles.forEach((t, k) => {
            for (let c = 0; c < 3; c++) {
                const i = s.idx[t * 3 + c];
                let j = remap.get(i);
                if (j === undefined) { j = order.length; remap.set(i, j); order.push(i); }
                indices[k * 3 + c] = j;
            }
            const [a, b, c] = [s.idx[t * 3] * 3, s.idx[t * 3 + 1] * 3, s.idx[t * 3 + 2] * 3];
            const ux = s.pos[b] - s.pos[a], uy = s.pos[b + 1] - s.pos[a + 1], uz = s.pos[b + 2] - s.pos[a + 2], vx = s.pos[c] - s.pos[a], vy = s.pos[c + 1] - s.pos[a + 1], vz = s.pos[c + 2] - s.pos[a + 2];
            area += 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
        });
        const positions = new Float32Array(order.length * 3), normals = new Float32Array(order.length * 3), uvs = new Float32Array(order.length * 2);
        order.forEach((i, j) => { for (let c = 0; c < 3; c++) { positions[j * 3 + c] = s.pos[i * 3 + c]; normals[j * 3 + c] = s.nrm[i * 3 + c]; } uvs[j * 2] = s.uv[i * 2]; uvs[j * 2 + 1] = s.uv[i * 2 + 1]; });
        cells.push({ surface: s, triangles, patch: { positions, normals, uvs, indices, classMap: s.classMap, uvMetres: s.uvMetres }, areaM2: area });
    }
    if (!cells.length) return skip('no relief surface stands within the band');
    opts.signal?.throwIfAborted();
    const res = await displaceByHeight({ tiles, classMaps, patches: cells.map(c => c.patch), depthM: asset.depthM, edgeMinM: P.edgeMinM, edgeMaxM: P.edgeMaxM, toleranceM: P.toleranceM, fadeM: P.fadeM, maxTriangles: P.maxTriangles, ...(opts.threads ? { threads: opts.threads } : {}) });
    opts.signal?.throwIfAborted();
    report.edgeMinUsedM = Math.round(res.edgeMinM * 1e4) / 1e4;

    // the GLB: each kept cell's run moved to the end of its primitive's indices, its displaced copy a child node
    const bin: Uint8Array[] = [Uint8Array.from(g.bin)];
    let binLength = g.bin.length;
    const base = bin[0], baseView = new DataView(base.buffer, base.byteOffset, base.byteLength);
    const push = (b: Uint8Array, target?: number) => {
        if (binLength % 4) { const padBytes = new Uint8Array(4 - (binLength % 4)); bin.push(padBytes); binLength += padBytes.length; }
        json.bufferViews.push({ buffer: 0, byteOffset: binLength, byteLength: b.byteLength, ...(target ? { target } : {}) });
        bin.push(b); binLength += b.byteLength;
        return json.bufferViews.length - 1;
    };
    const f32 = (a: Float32Array) => new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
    const displacedMaterial = new Map<number, number>();
    const r3 = (v: number) => Math.round(v * 1000) / 1000;
    for (const s of surfaces) {
        const mine = cells.map((c, i) => ({ c, r: res.patches[i] })).filter(x => x.c.surface === s && x.r.maxRecessM >= P.minRecessM && x.r.surfaceTriangles > 0);
        if (!mine.length) continue;
        report.displacedSurfaces++;
        // the indices: everything outside the kept cells first, in its order, then each cell's run
        const inCell = new Int32Array(s.idx.length / 3).fill(-1);
        mine.forEach((x, k) => { for (const t of x.c.triangles) inCell[t] = k; });
        const order: number[] = [];
        for (let t = 0; t < inCell.length; t++) if (inCell[t] < 0) order.push(t);
        const runs: Array<{ start: number; count: number }> = [];
        for (const x of mine) { runs.push({ start: order.length * 3, count: x.c.triangles.length * 3 }); order.push(...x.c.triangles); }
        const lay = accessorLayout(json, s.prim.indices);
        const put = (at: number, v: number) => { const o = lay.base + at * lay.stride; if (lay.componentType === 5125) baseView.setUint32(o, v, true); else if (lay.componentType === 5123) baseView.setUint16(o, v, true); else baseView.setUint8(o, v); };
        order.forEach((t, k) => { for (let c = 0; c < 3; c++) put(k * 3 + c, s.idx[t * 3 + c]); });
        // its displaced copy's material: the surface's own, marked displaced (the viewer shades its relief without the parallax)
        let mat = displacedMaterial.get(s.material);
        if (mat === undefined) {
            const src = json.materials[s.material];
            json.materials.push({ ...JSON.parse(JSON.stringify(src)), name: `${src.name ?? `material_${s.material}`}_displaced`, extras: { ...(src.extras ?? {}), sbMaterial: { ...src.extras.sbMaterial, relief: { ...src.extras.sbMaterial.relief, displaced: true } } } });
            mat = json.materials.length - 1;
            displacedMaterial.set(s.material, mat);
        }
        const node = json.nodes[s.node], name = node.name ?? `node_${s.node}`;
        const extrasCells: Array<{ start: number; count: number; near: string; centre: number[]; radius: number }> = [];
        mine.forEach((x, k) => {
            const r = x.r, min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
            for (let v = 0; v < r.positions.length; v += 3) for (let c = 0; c < 3; c++) { min[c] = Math.min(min[c], r.positions[v + c]); max[c] = Math.max(max[c], r.positions[v + c]); }
            const acc = (bv: number, count: number, type: string, componentType: number, mm?: { min: number[]; max: number[] }) => { json.accessors.push({ bufferView: bv, componentType, count, type, ...(mm ?? {}) }); return json.accessors.length - 1; };
            const V = r.positions.length / 3;
            const attributes = { POSITION: acc(push(f32(r.positions), 34962), V, 'VEC3', 5126, { min, max }), NORMAL: acc(push(f32(r.normals), 34962), V, 'VEC3', 5126), TEXCOORD_0: acc(push(f32(r.uvs), 34962), V, 'VEC2', 5126) };
            const indices = acc(push(new Uint8Array(r.indices.buffer, r.indices.byteOffset, r.indices.byteLength), 34963), r.indices.length, 'SCALAR', 5125);
            const nearName = `${name}_relief_${k}`;
            json.meshes.push({ name: `relief_near_${json.meshes[s.mesh].name ?? s.mesh}_${k}`, primitives: [{ attributes, indices, material: mat, mode: 4 }] });
            json.nodes.push({ name: nearName, mesh: json.meshes.length - 1, extras: { sbHeightRelief: { version: HEIGHT_RELIEF_VERSION, role: 'near', label: 'generated', of: name, cell: k, triangles: r.surfaceTriangles + r.riserTriangles, maxRecessM: r3(r.maxRecessM), source: `this surface's triangles tessellated and displaced by its material's height (a library set's, at an estimated depth), a recess below the surface as rebuilt; drawn in place of its cell within ${P.showWithinM} m` } } });
            node.children = [...(node.children ?? []), json.nodes.length - 1];
            const centre = [0, 1, 2].map(c => (min[c] + max[c]) / 2);
            extrasCells.push({ start: runs[k].start, count: runs[k].count, near: nearName, centre: centre.map(r3), radius: r3(Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2) });
            report.cells++; report.baseTriangles += x.c.triangles.length; report.nearTriangles += r.surfaceTriangles; report.riserTriangles += r.riserTriangles;
            report.maxRecessM = Math.max(report.maxRecessM, r.maxRecessM); report.areaM2 += x.c.areaM2;
        });
        node.extras = { ...(node.extras ?? {}), sbHeightRelief: { version: HEIGHT_RELIEF_VERSION, role: 'base', showWithinM: P.showWithinM, cells: extrasCells } };
    }
    if (!report.cells) return skip('no cell\'s relief is deep enough to show');
    report.maxRecessM = Math.round(report.maxRecessM * 1e4) / 1e4; report.areaM2 = Math.round(report.areaM2 * 10) / 10;
    if (binLength % 4) { const padBytes = new Uint8Array(4 - (binLength % 4)); bin.push(padBytes); binLength += padBytes.length; }
    json.buffers = [{ byteLength: binLength }];
    report.ms = Date.now() - t0;
    json.asset.extras = { ...json.asset.extras, sbHeightRelief: report };
    const out = new Uint8Array(binLength);
    let o = 0;
    for (const b of bin) { out.set(b, o); o += b.byteLength; }
    return { glb: assembleGlb(json, out), report };
}
