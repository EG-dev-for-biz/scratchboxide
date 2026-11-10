/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The walk surface of a splat world: the scan the world was built from (the Google 3D Tiles extraction, in the splat's
 * own frame), kept beside the splats as bare triangles. Splats are not surfaces, so a walker in a world of splats alone
 * has nothing to stand on or stop at; the viewport loads this mesh, never draws it, and walks on it (walkMode.ts): the
 * ground holds, walls stop. It is measured geometry, positions and triangles only: no textures, no materials.
 */

import * as fs from 'fs';
import * as path from 'path';
import { GltfBinaryPacker } from '../3d-engine/gltf-binary-packer';
import { readGlbScene, sceneToRenderMesh } from './StreetViewPoseRegistrar';

/** The walk surface's file name in a world's folder. */
export const WALK_SURFACE_FILE = 'walk_surface.glb';

export interface WalkSurfaceReport { path: string; vertices: number; triangles: number; bytes: number }

/** Writes the scan's triangles (every primitive, in the scan's frame) as one untextured mesh. */
export function writeWalkSurface(scanGlbPath: string, outPath: string): WalkSurfaceReport {
    const mesh = sceneToRenderMesh(readGlbScene(scanGlbPath));
    const positions = mesh.vertices instanceof Float32Array ? mesh.vertices : Float32Array.from(mesh.vertices);
    const indices = mesh.indices instanceof Uint32Array ? mesh.indices : Uint32Array.from(mesh.indices);
    const vertices = positions.length / 3, triangles = Math.floor(indices.length / 3);
    if (!vertices || !triangles) throw new Error(`the scan ${path.basename(scanGlbPath)} holds no triangles to walk on`);
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < positions.length; i += 3) {
        for (let k = 0; k < 3; k++) {
            const v = positions[i + k];
            if (v < min[k]) min[k] = v;
            if (v > max[k]) max[k] = v;
        }
    }
    const gltf = {
        asset: { version: '2.0', generator: 'Scratchbox walk surface' },
        scene: 0,
        scenes: [{ nodes: [0] }],
        nodes: [{ mesh: 0, name: 'walk_surface' }],
        meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, mode: 4 }] }],
        accessors: [
            { bufferView: 0, componentType: 5126, count: vertices, type: 'VEC3', min, max },
            { bufferView: 1, componentType: 5125, count: triangles * 3, type: 'SCALAR' }
        ],
        bufferViews: [{ target: 34962 }, { target: 34963 }]
    };
    const result = GltfBinaryPacker.writeGlb(outPath, gltf, [
        Buffer.from(positions.buffer, positions.byteOffset, positions.byteLength),
        Buffer.from(indices.buffer, indices.byteOffset, triangles * 12)
    ]);
    return { path: outPath, vertices, triangles, bytes: result.glbBuffer.length };
}
