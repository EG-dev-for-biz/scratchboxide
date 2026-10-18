/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Worker of HeadlessEdgeRenderPool: holds the mesh (shared memory) and rasterizes its triangle shard for each pose it
 * is sent, returning the depth buffers. The pool merges the shards by per-pixel minimum.
 */
import { parentPort, workerData } from 'worker_threads';
import { HeadlessMeshSilhouetteRenderer } from './HeadlessMeshSilhouetteRenderer';
import type { CameraPose6DOF } from './SubPixelEdgeAlignmentOptimizer';

/** workerData of an edge-render worker (the pool imports this type, which also keeps this file in compiled builds). */
export interface EdgeRenderWorkerInit {
    vertices: SharedArrayBuffer;
    indices: SharedArrayBuffer;
    width: number;
    height: number;
    triangleRange: [number, number];
}

const init = workerData as EdgeRenderWorkerInit & { entry: string };
const mesh = { vertices: new Float32Array(init.vertices), indices: new Uint32Array(init.indices) };

parentPort!.on('message', (msg: { id: number; poses: CameraPose6DOF[] }) => {
    try {
        const depths = msg.poses.map(pose => HeadlessMeshSilhouetteRenderer.renderMesh(mesh, pose, init.width, init.height, { triangleRange: init.triangleRange }).depthBuffer);
        parentPort!.postMessage({ id: msg.id, depths }, depths.map(d => d.buffer as ArrayBuffer));
    } catch (err) {
        parentPort!.postMessage({ id: msg.id, error: err instanceof Error ? err.message : String(err) });
    }
});

parentPort!.postMessage({ ready: true });
