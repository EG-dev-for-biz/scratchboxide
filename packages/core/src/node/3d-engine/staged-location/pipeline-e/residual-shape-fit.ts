/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * A residual cluster the audit confidently measured as a solid of revolution (radial symmetry, cross-section constancy:
 * a rooftop tank, a chimney, any other round object) is fit with a clean one instead of kept as raw, unresolved scan
 * triangles — one of the engine's four universal geometric operators (AGENTS.md 1.5.2: "harmonic solids of revolution:
 * a radial profile r(z)"), reused here via the existing shape-program trial's native revolve generator
 * (scratchbox_shape_program.hpp's emitRevolve, scripts/shape_program.cpp "mode program") rather than any new geometry
 * code: the profile is the cluster's own measured per-slice radius (residual-audit.ts's NativeCluster.slices), so
 * nothing is invented — the native tool is given `fit 0 0` (no scan-target fit) and just revolves the measured profile.
 *
 * Coloured with the cluster's own measured average photo colour (NativeCluster.photo.rgb) when it has one: a flat
 * colour, not a texture, since no per-texel photo mapping exists for a curved surface fit this way; a clay grey
 * fallback otherwise (massing-glb.ts's `flat` material, unconfigured per AGENTS.md's "zero uninvited defaults").
 */

import * as fs from 'fs';
import * as path from 'path';
import { programSpecText, runShapeTool, elementHandles, type ProgramRevolve, type ShapeProgram } from './shape-program';
import type { ResidualAuditResult } from '../residual-audit';
import type { MassingNode } from './native-massing';
import { FLAT_COLOUR_REF_BASE } from './massing-glb';

/** Below this, a cluster's circle fits are not confident enough to revolve a profile from. */
export const MIN_RADIAL_SYMMETRY = 0.5;
/** Fewer valid slices than this (a successful circle fit, r > 0, filling at least MIN_SECTORS of the slice) is too little of a profile to fit. */
export const MIN_PROFILE_SLICES = 3;
/**
 * A slice counts toward the profile only when its circle fit covers at least this share of its angular sectors. A
 * continuous wall fills (close to) all 12; a sparse support frame (e.g. a tank's four legs, each a flat fin with some
 * width) still manages a real-looking circle fit through its edges, but only ever a handful of sectors — measured on
 * the tank-on-legs fixture (residual-audit.test.ts): legs 0.667 (8/12, noisy, rmsRel 0.03-0.06), tank wall a clean
 * 1.000 (12/12, rmsRel ~0.003) with a sharp jump at the true wall, not a gradual one. 0.9 sits well inside that gap.
 */
export const MIN_SECTORS = 0.9;
/** Sides of the revolved polygon (a plain, un-lobed body: AGENTS.md's "32 or more round"). */
export const REVOLVE_SIDES = 32;

export interface RadialShapeFit {
    clusterId: number;
    /** Candidate triangle ids (residual-audit.ts's global numbering) this fit replaces. */
    triangleIds: number[];
    /** World (x, z) of the revolve axis, and its profile: height above baseY (metres), radius (metres). */
    centerX: number; centerZ: number;
    profileZR: Array<[number, number]>;
    /** World y of the profile's first and last point: only triangles in [baseY, topY] are replaced (others, e.g. a
     *  support frame below a tank, keep their own raw scanned triangles — the fit never deletes unmeasured geometry). */
    baseY: number; topY: number;
    /** min(radialSymmetry, 1) blended with crossSectionConstancy: how confidently this cluster is a body of revolution. */
    confidence: number;
    /** The cluster's own measured average photo colour (0..255), or undefined when it has none. */
    colorRgb?: [number, number, number];
}

/** Picks the audit's real-object clusters confident enough to revolve a clean solid from their own measured profile. */
export function pickRadialShapeFits(result: ResidualAuditResult, opts: { minRadialSymmetry?: number; minSlices?: number; minSectors?: number } = {}): RadialShapeFit[] {
    const minSym = opts.minRadialSymmetry ?? MIN_RADIAL_SYMMETRY, minSlices = opts.minSlices ?? MIN_PROFILE_SLICES, minSectors = opts.minSectors ?? MIN_SECTORS;
    const out: RadialShapeFit[] = [];
    for (const c of result.clusters) {
        if (c.verdict !== 'real-object') continue;
        if (c.symmetry.radialSymmetry < minSym) continue;
        const valid = c.slices.filter(s => s.r > 0 && s.sectors >= minSectors).sort((a, b) => a.y - b.y);
        if (valid.length < minSlices) continue;
        const baseY = valid[0].y, topY = valid[valid.length - 1].y;
        const profileZR: Array<[number, number]> = valid.map(s => [s.y - baseY, s.r] as [number, number]);
        const centerX = valid.reduce((a, s) => a + s.cx, 0) / valid.length, centerZ = valid.reduce((a, s) => a + s.cz, 0) / valid.length;
        const confidence = Math.max(0, Math.min(1, (Math.min(1, c.symmetry.radialSymmetry) + Math.min(1, c.symmetry.crossSectionConstancy)) / 2));
        out.push({
            clusterId: c.id, triangleIds: c.triangleIds.slice(), centerX, centerZ, profileZR, baseY, topY, confidence,
            ...(c.photo ? { colorRgb: [Math.round(c.photo.rgb[0]), Math.round(c.photo.rgb[1]), Math.round(c.photo.rgb[2])] as [number, number, number] } : {})
        });
    }
    return out;
}

/** One fit's revolved mesh (world positions, welded, with smooth per-vertex normals). */
export interface RevolveMesh { positions: Float32Array; normals: Float32Array; indices: Uint32Array }

async function revolveMesh(fit: RadialShapeFit, dir: string, opts: { signal?: AbortSignal } = {}): Promise<RevolveMesh> {
    const revolve: ProgramRevolve = { centerU: fit.centerX, centerV: fit.centerZ, baseM: fit.baseY, profile: fit.profileZR, sides: REVOLVE_SIDES };
    const prog: ShapeProgram = { elements: [{ label: `residual-shape/${fit.clusterId}`, revolve }] };
    const specDir = path.join(dir, `cluster_${fit.clusterId}`);
    const handles = [elementHandles({ label: '', revolve }, false)];
    const specText = programSpecText(prog, {
        outDir: specDir, measuredOutline: [], fit: null, handles,
        scan: { dir: specDir, frame: { ox: 0, oz: 0, theta: 0, groundY: 0 }, grid: { u0: 0, v0: 0, cell: 1, nu: 0, nv: 0 }, cameras: [], buildingH: 0 }
    });
    await runShapeTool(specText, specDir, { name: 'spec.txt', ...(opts.signal ? { signal: opts.signal } : {}) });
    const geometry = JSON.parse(fs.readFileSync(path.join(specDir, 'geometry.json'), 'utf8')) as { meshes: Array<{ vertices: Array<[number, number, number]>; indices: number[] }> };
    const mesh = geometry.meshes[0];
    if (!mesh) throw new Error(`residual-shape-fit: cluster ${fit.clusterId}: the revolve produced no mesh (profile of ${fit.profileZR.length} points)`);
    const n = mesh.vertices.length;
    const positions = new Float32Array(n * 3);
    mesh.vertices.forEach((v, i) => positions.set(v, i * 3));
    const indices = Uint32Array.from(mesh.indices);
    const normals = new Float32Array(n * 3);
    for (let t = 0; t < indices.length; t += 3) {
        const [ia, ib, ic] = [indices[t], indices[t + 1], indices[t + 2]];
        const ax = positions[ia * 3], ay = positions[ia * 3 + 1], az = positions[ia * 3 + 2];
        const bx = positions[ib * 3] - ax, by = positions[ib * 3 + 1] - ay, bz = positions[ib * 3 + 2] - az;
        const cx = positions[ic * 3] - ax, cy = positions[ic * 3 + 1] - ay, cz = positions[ic * 3 + 2] - az;
        const nx = by * cz - bz * cy, ny = bz * cx - bx * cz, nz = bx * cy - by * cx;
        for (const i of [ia, ib, ic]) { normals[i * 3] += nx; normals[i * 3 + 1] += ny; normals[i * 3 + 2] += nz; }
    }
    for (let i = 0; i < n; i++) {
        const x = normals[i * 3], y = normals[i * 3 + 1], z = normals[i * 3 + 2], l = Math.hypot(x, y, z) || 1;
        normals[i * 3] = x / l; normals[i * 3 + 1] = y / l; normals[i * 3 + 2] = z / l;
    }
    return { positions, normals, indices };
}

/** The provenance token massingProvenance (pipeline-e.ts) reads to label these nodes 'measured'. */
export const RESIDUAL_SHAPE_TOKEN = 'residual-shape-measured';

/**
 * Builds one MassingNode per fit (the native revolve mesh), and the flat-colour material map to go with it
 * (massing-glb.ts's FLAT_COLOUR_REF_BASE convention). Colour ids are local to this call (0, 1, 2, ...).
 */
export async function buildResidualShapeNodes(fits: RadialShapeFit[], dir: string, opts: { signal?: AbortSignal } = {}): Promise<{ nodes: MassingNode[]; flatColours: Map<number, [number, number, number]> }> {
    const nodes: MassingNode[] = [];
    const flatColours = new Map<number, [number, number, number]>();
    for (let i = 0; i < fits.length; i++) {
        const fit = fits[i];
        const mesh = await revolveMesh(fit, dir, opts);
        const n = mesh.positions.length / 3;
        const ref = new Int32Array(n).fill(FLAT_COLOUR_REF_BASE - i);
        const st = new Float32Array(n * 2);
        flatColours.set(i, fit.colorRgb ?? [140, 140, 140]);
        nodes.push({
            name: `residual/shape_${fit.clusterId}`, kind: 'residual-shape', provenance: RESIDUAL_SHAPE_TOKEN, confidence: fit.confidence,
            positions: mesh.positions, normals: mesh.normals, ref, st, indices: mesh.indices
        });
    }
    return { nodes, flatColours };
}
