/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Pipeline K's material regions shaded by maps measured from the building's own mesh (scratchbox_mesh_maps.hpp through
 * mesh-maps.ts), after the plan and before its maps are written:
 *   - ambient occlusion goes into the orm's R channel, which becomes the material's occlusion texture (the viewer darkens
 *     the light the sky and the surroundings send there, never the direct sun);
 *   - the roughness is raised in cavities (window reveals, joints, the foot of a setback: where dirt and damp gather) and
 *     eased on convex edges (arrises worn smooth), each by a fraction of the way to rough or of the roughness;
 *   - glass keeps its own roughness and occlusion.
 * The colour stays the photo (it already shows the building's real dirt); no surface moves; every value written is
 * generated, and the plan's report says what was measured. The maps are measured on a grid of one point per `step` x
 * `step` texels of each material's photo (the step chosen so the whole building stays within a budget of points) and
 * read back bilinearly. Placement comes from the measured maps alone: no surface is singled out by what it is.
 */

import type { ParsedGlb } from '../glb-bytes';
import { readAccessor } from '../glb-bytes';
import { bakeMeshMaps, type MeshMapsParams } from '../../mesh-maps';
import { forEachTriangleOf, forTexelsOf, type MaterialRegionsPlan, type MeshMapsShadingReport } from './material-regions';

/** Part of the twin's stage key and the look code (place-store-best.ts): a change to what this draws makes new twins. */
export const MESH_MAPS_SHADING_VERSION = 'mesh-maps-shading/1';

export const MESH_MAPS_SHADING_PARAMS = {
    /** The scales maps are read at on a building, metres. */
    curvatureRadiusM: 0.4,
    cavityRadiusM: 0.25,
    aoRadiusM: 1.5,
    aoSamples: 16,
    /** Points measured over the whole building at most (each the maps of step x step texels). */
    maxQueries: 1_500_000,
    /** Surface points each point set holds at most (past it the radii grow, reported). */
    maxSamples: 4_000_000,
    /** How much of the way to fully rough cavity takes the roughness (at cavity 1). */
    cavityRoughen: 0.35,
    /** The share of the roughness eased on a convex edge (at full convexity). */
    edgeSmooth: 0.2,
    /** How much of the measured occlusion is written (1: all of it). */
    aoStrength: 1
};
export type MeshMapsShadingParams = typeof MESH_MAPS_SHADING_PARAMS;

const smoothstep = (e0: number, e1: number, x: number) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };

/** Every drawn triangle of the GLB (its raw positions, as the material regions read them), 9 floats each. */
function soupOf(g: ParsedGlb, json: any): Float32Array {
    const out: number[] = [];
    for (const mesh of json.meshes ?? []) for (const prim of mesh.primitives ?? []) {
        if ((prim.mode ?? 4) !== 4 || prim.attributes?.POSITION === undefined) continue;
        const pos = readAccessor(g, prim.attributes.POSITION).data;
        const idx = prim.indices !== undefined ? readAccessor(g, prim.indices).data : undefined;
        const n = idx ? idx.length : pos.length / 3;
        for (let t = 0; t + 2 < n; t += 3) for (let k = 0; k < 3; k++) {
            const i = idx ? idx[t + k] : t + k;
            out.push(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
        }
    }
    return Float32Array.from(out);
}

/**
 * Shades the plan's finish in place by the mesh-measured maps (see the file comment) and records what it did in the
 * plan's report. Throws when the native bake fails (the caller reports it; nothing is drawn in its place).
 */
export async function applyMeshMapsToPlan(g: ParsedGlb, json: any, plan: MaterialRegionsPlan, opts: { params?: Partial<MeshMapsShadingParams>; threads?: number; signal?: AbortSignal } = {}): Promise<MeshMapsShadingReport> {
    const P = { ...MESH_MAPS_SHADING_PARAMS, ...(opts.params ?? {}) };
    const t0 = Date.now();
    const totalTexels = plan.materials.reduce((a, m) => a + m.orm.width * m.orm.height, 0);
    const step = Math.max(1, Math.ceil(Math.sqrt(totalTexels / Math.max(1, P.maxQueries))));

    // the measuring grid of each material: a point at each coarse texel its triangles cover, with the triangle's normal
    interface Grid { W: number; H: number; first: number; at: Int32Array }
    const grids: Grid[] = [];
    const points: number[] = [];
    for (const pm of plan.materials) {
        const W = Math.ceil(pm.orm.width / step), H = Math.ceil(pm.orm.height / step);
        const at = new Int32Array(W * H).fill(-1), first = points.length / 6;
        forEachTriangleOf(g, json, pm.material, (p, uv) => {
            const ux = p[3] - p[0], uy = p[4] - p[1], uz = p[5] - p[2], vx = p[6] - p[0], vy = p[7] - p[1], vz = p[8] - p[2];
            const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx, nl = Math.hypot(nx, ny, nz);
            if (!(nl > 0)) return;
            forTexelsOf(uv, W, H, (k, wa, wb, wc) => {
                if (at[k] >= 0) return;
                at[k] = points.length / 6 - first;
                points.push(wa * p[0] + wb * p[3] + wc * p[6], wa * p[1] + wb * p[4] + wc * p[7], wa * p[2] + wb * p[5] + wc * p[8], nx / nl, ny / nl, nz / nl);
            });
        });
        grids.push({ W, H, first, at });
    }
    const params: MeshMapsParams = {
        curvatureRadiusM: P.curvatureRadiusM, cavityRadiusM: P.cavityRadiusM, aoRadiusM: P.aoRadiusM, aoSamples: P.aoSamples,
        thicknessMaxM: 1, thicknessSamples: 0, samplesPerDisk: 32, maxSamples: P.maxSamples, rayEpsM: 0.005
    };
    const baked = await bakeMeshMaps({ soup: soupOf(g, json), points: Float32Array.from(points), params, ...(opts.threads ? { threads: opts.threads } : {}), ...(opts.signal ? { signal: opts.signal } : {}) });
    const maps = baked.maps;

    // read back at every texel, bilinear over the measured neighbours, and shade the finish
    let shaded = 0, aoSum = 0, cavityN = 0, convexN = 0, materials = 0;
    plan.materials.forEach((pm, mi) => {
        const { W, H, first, at } = grids[mi], { width: FW, height: FH } = pm.orm, orm = pm.orm.rgba, glass = pm.params.rgba;
        let any = false;
        const v = [0, 0, 0];
        for (let y = 0; y < FH; y++) for (let x = 0; x < FW; x++) {
            const k = y * FW + x;
            if (glass[k * 4]) continue;                       // glass keeps its own finish
            const gx = (x + 0.5) / step - 0.5, gy = (y + 0.5) / step - 0.5;
            const x0 = Math.floor(gx), y0 = Math.floor(gy), fx = gx - x0, fy = gy - y0;
            let w = 0; v[0] = v[1] = v[2] = 0;
            for (let dy = 0; dy <= 1; dy++) for (let dx = 0; dx <= 1; dx++) {
                const cx = Math.min(W - 1, Math.max(0, x0 + dx)), cy = Math.min(H - 1, Math.max(0, y0 + dy)), q = at[cy * W + cx];
                if (q < 0) continue;
                const ww = (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy) + 1e-6, j = (first + q) * 4;
                v[0] += ww * maps[j]; v[1] += ww * maps[j + 1]; v[2] += ww * maps[j + 3]; w += ww;
            }
            if (!w) continue;                                 // no measured point near this texel (outside every triangle)
            const curvature = v[0] / w, cavity = v[1] / w, ao = v[2] / w;
            const r0 = orm[k * 4 + 1] / 255;
            const convex = smoothstep(0.3, 1, curvature);
            let r = r0 + (1 - r0) * P.cavityRoughen * cavity;
            r *= 1 - P.edgeSmooth * convex;
            orm[k * 4] = Math.round(255 * Math.min(1, Math.max(0, 1 - P.aoStrength * (1 - ao))));
            orm[k * 4 + 1] = Math.round(255 * Math.min(1, Math.max(0, r)));
            any = true; shaded++; aoSum += ao;
            if (cavity > 0.2) cavityN++;
            if (convex > 0.2) convexN++;
        }
        if (any) { pm.occlusion = true; materials++; }
    });
    const r3 = (x: number) => Math.round(x * 1000) / 1000;
    const report: MeshMapsShadingReport = {
        label: 'generated', queries: points.length / 6, step, curvatureRadiusM: r3(baked.curvatureRadiusM), cavityRadiusM: r3(baked.cavityRadiusM), aoRadiusM: P.aoRadiusM,
        meanAo: r3(shaded ? aoSum / shaded : 1), cavityShare: r3(shaded ? cavityN / shaded : 0), convexShare: r3(shaded ? convexN / shaded : 0),
        materials, texels: shaded, ms: Date.now() - t0
    };
    plan.report.meshMaps = report;
    return report;
}
