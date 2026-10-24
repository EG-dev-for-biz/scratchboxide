/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Pipeline I: a generated model (arbitrary scale, orientation and handedness) fitted onto the scan of the structure it
 * was made from. Its height is scaled to the scan's height, then the plan is searched over mirror and yaw (2 deg), then
 * refined over yaw, uniform scale (within 10 % of the height's) and a plan shift, scoring the 1 m plan occupancy of the model's raised part against the
 * scan's footprint cells (IoU). The fit is reported, never enforced: how much of the model's plan falls outside the
 * footprint (overflow) and how much of the footprint it covers travel with the layer (user decision 2026-10-24: fit and
 * report, nothing clipped). The fit is applied as one root-node matrix, so the model's mesh and textures are untouched.
 */

import { assembleGlb, parseGlbBytes } from '../glb-bytes';

export interface FootprintTarget {
    /** The scan's footprint cells: "floor(x),floor(z)" in the tile frame (x east, z south), 1 m. */
    cells: Set<string>;
    groundY: number;
    heightM: number;
}

export interface RegistrationFit {
    /** glTF column-major 4x4: model frame -> tile frame. */
    matrix: number[];
    yawDeg: number;
    mirrored: boolean;
    scale: number;
    /** Intersection over union of the model's raised plan and the scan footprint (1 m cells). */
    planIoU: number;
    /** Share of the model's plan outside the footprint. */
    overflowShare: number;
    /** Share of the footprint the model's plan covers. */
    coverage: number;
    /** Model height after the fit over the scan's height. */
    heightRatio: number;
}

const key = (x: number, z: number) => `${Math.floor(x)},${Math.floor(z)}`;

/**
 * Plan cells (1 m) of points already in the tile frame, closed (dilated then eroded by one cell): gaps between vertices
 * fill without the outline growing, so the plan's size stays the model's.
 */
function planCells(xs: Float64Array, zs: Float64Array): Set<string> {
    const raw = new Set<string>();
    for (let i = 0; i < xs.length; i++) raw.add(`${Math.floor(xs[i])},${Math.floor(zs[i])}`);
    const grown = new Set<string>();
    for (const k of raw) { const c = k.indexOf(','), x = +k.slice(0, c), z = +k.slice(c + 1); for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) grown.add(`${x + dx},${z + dz}`); }
    const closed = new Set<string>();
    for (const k of grown) {
        const c = k.indexOf(','), x = +k.slice(0, c), z = +k.slice(c + 1);
        let all = true;
        for (let dx = -1; dx <= 1 && all; dx++) for (let dz = -1; dz <= 1; dz++) if (!grown.has(`${x + dx},${z + dz}`)) { all = false; break; }
        if (all) closed.add(k);
    }
    return closed;
}

function score(a: Set<string>, f: Set<string>, sx = 0, sz = 0): { inter: number; union: number } {
    let inter = 0;
    for (const k of a) {
        const c = k.indexOf(','), x = +k.slice(0, c) + sx, z = +k.slice(c + 1) + sz;
        if (f.has(`${x},${z}`)) inter++;
    }
    return { inter, union: a.size + f.size - inter };
}

/**
 * positions: the model's vertices (x, y, z flat, glTF Y-up, node transforms applied). Raised = above 10 % of the model's
 * height, so a base slab or sidewalk plate the model drew does not count as plan.
 */
export function registerToFootprint(positions: ArrayLike<number>, target: FootprintTarget): RegistrationFit {
    if (target.cells.size === 0) throw new Error('registerToFootprint: the scan footprint is empty');
    let minY = Infinity, maxY = -Infinity;
    for (let i = 1; i < positions.length; i += 3) { minY = Math.min(minY, positions[i]); maxY = Math.max(maxY, positions[i]); }
    const h = maxY - minY;
    if (!(h > 0)) throw new Error('registerToFootprint: the model has no height');
    const stride = Math.max(1, Math.floor(positions.length / 3 / 40000));
    const px: number[] = [], pz: number[] = [];
    for (let i = 0; i < positions.length; i += 3 * stride) if (positions[i + 1] > minY + 0.1 * h) { px.push(positions[i]); pz.push(positions[i + 2]); }
    let fcx = 0, fcz = 0;
    for (const k of target.cells) { const c = k.indexOf(','); fcx += +k.slice(0, c) + 0.5; fcz += +k.slice(c + 1) + 0.5; }
    fcx /= target.cells.size; fcz /= target.cells.size;
    const s0 = target.heightM / h;
    // the model's plan under (mirror, yaw, scale), centred on the footprint's centroid
    const place = (m: number, yawDeg: number, s: number) => {
        const a = yawDeg * Math.PI / 180, c = Math.cos(a), sn = Math.sin(a), n = px.length;
        const xs = new Float64Array(n), zs = new Float64Array(n);
        let mx = 0, mz = 0;
        for (let i = 0; i < n; i++) { xs[i] = s * (c * m * px[i] - sn * pz[i]); zs[i] = s * (sn * m * px[i] + c * pz[i]); mx += xs[i]; mz += zs[i]; }
        mx /= n; mz /= n;
        for (let i = 0; i < n; i++) { xs[i] += fcx - mx; zs[i] += fcz - mz; }
        return { cells: planCells(xs, zs), tx: fcx - mx, tz: fcz - mz };
    };
    // coarse: every 2 deg in both handednesses at the height's scale. Before scale and shift are refined a mirrored, turned
    // pose can score as well as the true one (an L against its mirror image), so the best few distinct poses of each
    // handedness are all refined and the best refined pose wins
    const coarse: Array<{ m: number; yaw: number; iou: number }> = [];
    for (const m of [1, -1]) for (let yaw = 0; yaw < 360; yaw += 2) {
        const { inter, union } = score(place(m, yaw, s0).cells, target.cells);
        coarse.push({ m, yaw, iou: inter / union });
    }
    const seeds: typeof coarse = [];
    for (const m of [1, -1]) for (const c of coarse.filter(x => x.m === m).sort((p, q) => q.iou - p.iou)) {
        if (seeds.filter(x => x.m === m).length >= 3) break;
        if (seeds.every(x => x.m !== m || Math.abs(((c.yaw - x.yaw + 540) % 360) - 180) >= 10)) seeds.push(c);
    }
    let best = { m: 1, yaw: 0, s: s0, sx: 0, sz: 0, iou: -1 };
    for (const seed of seeds) for (let yaw = seed.yaw - 2; yaw <= seed.yaw + 2; yaw += 0.5) for (let f = 0.9; f <= 1.1001; f += 0.025) {
        const { cells } = place(seed.m, yaw, s0 * f);
        for (let sx = -3; sx <= 3; sx++) for (let sz = -3; sz <= 3; sz++) {
            const { inter, union } = score(cells, target.cells, sx, sz);
            if (inter / union > best.iou) best = { m: seed.m, yaw, s: s0 * f, sx, sz, iou: inter / union };
        }
    }
    const fin = place(best.m, best.yaw, best.s);
    const { inter } = score(fin.cells, target.cells, best.sx, best.sz);
    const a = best.yaw * Math.PI / 180, c = Math.cos(a), sn = Math.sin(a), s = best.s, m = best.m;
    // world = R(yaw) * diag(m s, s, s) * p + t
    const tx = fin.tx + best.sx, tz = fin.tz + best.sz, ty = target.groundY - s * minY;
    const matrix = [c * m * s, 0, sn * m * s, 0, 0, s, 0, 0, -sn * s, 0, c * s, 0, tx, ty, tz, 1];
    return {
        matrix, yawDeg: ((best.yaw % 360) + 360) % 360, mirrored: m < 0, scale: s,
        planIoU: best.iou, overflowShare: 1 - inter / fin.cells.size, coverage: inter / target.cells.size, heightRatio: (s * h) / target.heightM
    };
}

/** The GLB with every scene root put under one new node carrying `matrix`. */
export function applyRootTransform(glb: Buffer, matrix: number[], name = 'pipeline_i_fit'): Buffer {
    const { json, bin } = parseGlbBytes(glb);
    const scene = json.scenes[json.scene ?? 0];
    json.nodes = json.nodes ?? [];
    json.nodes.push({ name, matrix, children: scene.nodes });
    scene.nodes = [json.nodes.length - 1];
    return assembleGlb(json, bin);
}

/** The same GLB without materials (studio clay): node names and position bytes unchanged, for the layer's clay twin. */
export function stripMaterials(glb: Buffer): Buffer {
    const { json, bin } = parseGlbBytes(glb);
    for (const mesh of json.meshes ?? []) for (const p of mesh.primitives ?? []) { delete p.material; if (p.attributes) delete p.attributes.TEXCOORD_0; }
    delete json.materials; delete json.textures; delete json.images; delete json.samplers;
    const keep = (e: string) => !/^KHR_(materials|texture)/.test(e);
    if (json.extensionsUsed) json.extensionsUsed = json.extensionsUsed.filter(keep);
    if (json.extensionsRequired) json.extensionsRequired = json.extensionsRequired.filter(keep);
    return assembleGlb(json, bin);
}

/** The footprint cell of a tile-frame point (extraction-sizing's cellKey). */
export { key as footprintCellKey };
