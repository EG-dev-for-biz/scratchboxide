/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Unique per-surface textures that supersede the tiling library on a rebuilt surface (user direction 2026-10-22: do not
 * rely on repeating textures; the library is the base layer, a texture made for the one surface wins where there is
 * one). A unique texture is an image laid on its surface by a planar frame (a facade's own plane, or the ground seen from
 * above), generated and labelled so (photo-conditioned: made from the scan's render of that surface, de-lit, never the
 * scan's photo itself). The procedural writers (procedural-materials.ts) take a map of them by surface key: a massing node
 * name (one face) or a ground / street surface key ('ground:3', 'roads:carriageway').
 */

import type { StagedGlbImage, StagedGlbMaterial } from './staged-glb-writer';
import type { MassingFace } from './pipeline-e/native-massing';

type V3 = [number, number, number];

/** uv = (((p - origin) . axisU - u0) / (u1 - u0), (v1 - (p - origin) . axisV) / (v1 - v0)): the image's top row at v1. */
export interface PlanarFrame { origin: V3; axisU: V3; axisV: V3; u0: number; u1: number; v0: number; v1: number }

export interface UniqueSurfaceTexture {
    /** The surface it supersedes (a massing node name, or a ground / street surface key). */
    surface: string;
    baseColor: StagedGlbImage;
    normal?: StagedGlbImage;
    /** glTF metallicRoughness (G roughness, B metalness); else `roughness`. */
    metallicRoughness?: StagedGlbImage;
    roughness?: number;
    frame: PlanarFrame;
    /** Always 'generated'; what it was made from and how (open text), and a confidence. */
    provenance: { label: 'generated'; method: string; conditionedOn: string; confidence?: number; model?: string };
}

export function planarFrameUv(frame: PlanarFrame, positions: Float32Array, out = new Float32Array((positions.length / 3) * 2)): Float32Array {
    const du = frame.u1 - frame.u0 || 1, dv = frame.v1 - frame.v0 || 1;
    for (let i = 0; i < positions.length / 3; i++) {
        const x = positions[i * 3] - frame.origin[0], y = positions[i * 3 + 1] - frame.origin[1], z = positions[i * 3 + 2] - frame.origin[2];
        out[i * 2] = (x * frame.axisU[0] + y * frame.axisU[1] + z * frame.axisU[2] - frame.u0) / du;
        out[i * 2 + 1] = (frame.v1 - (x * frame.axisV[0] + y * frame.axisV[1] + z * frame.axisV[2])) / dv;
    }
    return out;
}

/** A massing face's own plane as a frame (its s along the face, t up it, over its extent). */
export function planarFrameOfFace(f: Pick<MassingFace, 'origin' | 'axisS' | 'axisT' | 'sMin' | 'sMax' | 'tMin' | 'tMax'>): PlanarFrame {
    return { origin: f.origin, axisU: f.axisS, axisV: f.axisT, u0: f.sMin, u1: f.sMax, v0: f.tMin, v1: f.tMax };
}

/** The ground seen from above over a rectangle (u east, v south down the image). */
export function planarFrameFromAbove(x0: number, z0: number, x1: number, z1: number): PlanarFrame {
    return { origin: [0, 0, 0], axisU: [1, 0, 0], axisV: [0, 0, -1], u0: x0, u1: x1, v0: -z1, v1: -z0 };
}

/** The glTF material of a unique texture, labelled as superseding `supersedes` (the library choice it replaces). */
export function uniqueSurfaceMaterial(t: UniqueSurfaceTexture, supersedes?: Record<string, unknown>): StagedGlbMaterial {
    return {
        name: `Unique_${t.surface.replace(/[^\w]+/g, '_')}`, baseColor: t.baseColor, ...(t.normal ? { normal: t.normal } : {}),
        ...(t.metallicRoughness ? { metallicRoughness: t.metallicRoughness, roughness: 1, metallic: 1 } : { roughness: t.roughness ?? 0.85, metallic: 0 }),
        extras: {
            sbTexture: { confidenceTexture: '@image:confidence' },
            sbSurfaceMaterial: { schema: 'scratchbox.surface-material/1', provenance: 'generated', unique: true, surface: t.surface, ...t.provenance, ...(supersedes ? { supersedes } : {}), note: 'a texture made for this one surface, laid on its own plane; it supersedes the tiling library here' }
        }
    };
}
