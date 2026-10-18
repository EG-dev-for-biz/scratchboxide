/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Vertex and triangle counts of a binary glTF 2.0, read from its JSON chunk (POSITION accessor counts;
 * triangles from indices, or vertices when unindexed, for TRIANGLES / STRIP / FAN primitives).
 * Runs in the browser and in Node. Throws when the bytes are not a GLB with a parseable JSON chunk.
 */
export function measureGlbMeshCounts(glb: Uint8Array): { vertexCount: number; triangleCount: number } {
    const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
    if (glb.byteLength < 20 || view.getUint32(0, true) !== 0x46546c67) {
        throw new Error('measureGlbMeshCounts: not a binary glTF (magic header missing)');
    }
    const jsonLength = view.getUint32(12, true);
    if (view.getUint32(16, true) !== 0x4e4f534a || 20 + jsonLength > glb.byteLength) {
        throw new Error('measureGlbMeshCounts: GLB has no JSON chunk');
    }
    const gltf = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + jsonLength)));
    const accessors: any[] = gltf.accessors || [];
    let vertexCount = 0;
    let triangleCount = 0;
    for (const mesh of gltf.meshes || []) {
        for (const prim of mesh.primitives || []) {
            const pos = accessors[prim.attributes?.POSITION];
            if (!pos) continue;
            vertexCount += pos.count;
            const n = prim.indices !== undefined ? accessors[prim.indices]?.count ?? 0 : pos.count;
            const mode = prim.mode ?? 4;
            if (mode === 4) triangleCount += Math.floor(n / 3);
            else if (mode === 5 || mode === 6) triangleCount += Math.max(0, n - 2);
        }
    }
    return { vertexCount, triangleCount };
}

/** Decodes standard base64 to bytes in the browser or Node. */
export function base64ToBytes(b64: string): Uint8Array {
    const bin = atob(b64.replace(/^data:[^,]*,/, ''));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

/** Counts of a base64 GLB, or undefined when the bytes are not a GLB (no count is then known, so none is reported). */
export function measureGlbBase64MeshCounts(b64: string): { vertexCount: number; triangleCount: number } | undefined {
    const bytes = base64ToBytes(b64);
    if (bytes.byteLength < 20 || new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true) !== 0x46546c67) return undefined;
    return measureGlbMeshCounts(bytes);
}
