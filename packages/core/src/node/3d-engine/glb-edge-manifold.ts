/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/** Edge-manifold audit of a GLB's triangles after welding coincident vertices. */
export interface GlbEdgeManifoldReport {
    /** True when there is at least one triangle and every welded edge is used by exactly two triangles. */
    isManifold: boolean;
    triangles: number;
    weldedVertices: number;
    edges: number;
    /** Edges used by one triangle (holes, open borders). */
    boundaryEdges: number;
    /** Edges used by three or more triangles. */
    nonManifoldEdges: number;
    /** Triangles that collapse after welding (two corners at one position); they contribute no edges. */
    degenerateTriangles: number;
}

type Mat4 = number[];

const IDENTITY: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function mul(a: Mat4, b: Mat4): Mat4 {
    const o = new Array(16).fill(0);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
        let s = 0;
        for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
        o[c * 4 + r] = s;
    }
    return o;
}

function nodeMatrix(node: any): Mat4 {
    if (Array.isArray(node.matrix) && node.matrix.length === 16) return node.matrix;
    const [tx, ty, tz] = node.translation ?? [0, 0, 0];
    const [qx, qy, qz, qw] = node.rotation ?? [0, 0, 0, 1];
    const [sx, sy, sz] = node.scale ?? [1, 1, 1];
    // column-major T * R * S
    return [
        (1 - 2 * (qy * qy + qz * qz)) * sx, (2 * (qx * qy + qz * qw)) * sx, (2 * (qx * qz - qy * qw)) * sx, 0,
        (2 * (qx * qy - qz * qw)) * sy, (1 - 2 * (qx * qx + qz * qz)) * sy, (2 * (qy * qz + qx * qw)) * sy, 0,
        (2 * (qx * qz + qy * qw)) * sz, (2 * (qy * qz - qx * qw)) * sz, (1 - 2 * (qx * qx + qy * qy)) * sz, 0,
        tx, ty, tz, 1
    ];
}

/**
 * Welds coincident vertices (positions in world space, quantised to `weldToleranceM`) across every TRIANGLES / STRIP /
 * FAN primitive reachable from the GLB's scenes, then counts how many triangles use each undirected edge.
 * Throws on bytes that are not a GLB or on POSITION data that is not float32 VEC3.
 */
export function measureGlbEdgeManifold(glb: Buffer, weldToleranceM = 1e-6): GlbEdgeManifoldReport {
    if (glb.length < 20 || glb.readUInt32LE(0) !== 0x46546c67) throw new Error('measureGlbEdgeManifold: not a binary glTF');
    const jsonLength = glb.readUInt32LE(12);
    if (glb.readUInt32LE(16) !== 0x4e4f534a) throw new Error('measureGlbEdgeManifold: GLB has no JSON chunk');
    const gltf = JSON.parse(glb.toString('utf8', 20, 20 + jsonLength));
    const binStart = 20 + jsonLength + 8;
    const accessors: any[] = gltf.accessors ?? [];
    const views: any[] = gltf.bufferViews ?? [];

    const readPositions = (ai: number): Float32Array => {
        const a = accessors[ai];
        if (!a || a.componentType !== 5126 || a.type !== 'VEC3' || a.bufferView === undefined) {
            throw new Error(`measureGlbEdgeManifold: POSITION accessor ${ai} is not float32 VEC3`);
        }
        const v = views[a.bufferView];
        const stride = v.byteStride ?? 12;
        const base = binStart + (v.byteOffset ?? 0) + (a.byteOffset ?? 0);
        const out = new Float32Array(a.count * 3);
        for (let i = 0; i < a.count; i++) for (let k = 0; k < 3; k++) out[i * 3 + k] = glb.readFloatLE(base + i * stride + k * 4);
        return out;
    };
    const readIndices = (ai: number): Uint32Array => {
        const a = accessors[ai];
        const v = views[a.bufferView];
        const base = binStart + (v.byteOffset ?? 0) + (a.byteOffset ?? 0);
        const out = new Uint32Array(a.count);
        for (let i = 0; i < a.count; i++) {
            out[i] = a.componentType === 5125 ? glb.readUInt32LE(base + i * 4)
                : a.componentType === 5123 ? glb.readUInt16LE(base + i * 2)
                    : glb.readUInt8(base + i);
        }
        return out;
    };

    const weld = new Map<string, number>();
    const edgeUses = new Map<string, number>();
    let triangles = 0;
    let degenerateTriangles = 0;
    const q = 1 / weldToleranceM;

    const addPrimitive = (prim: any, world: Mat4) => {
        const mode = prim.mode ?? 4;
        if (prim.attributes?.POSITION === undefined || (mode !== 4 && mode !== 5 && mode !== 6)) return;
        const p = readPositions(prim.attributes.POSITION);
        const n = p.length / 3;
        const ids = new Uint32Array(n);
        for (let i = 0; i < n; i++) {
            const x = p[i * 3], y = p[i * 3 + 1], z = p[i * 3 + 2];
            const wx = world[0] * x + world[4] * y + world[8] * z + world[12];
            const wy = world[1] * x + world[5] * y + world[9] * z + world[13];
            const wz = world[2] * x + world[6] * y + world[10] * z + world[14];
            const key = `${Math.round(wx * q)},${Math.round(wy * q)},${Math.round(wz * q)}`;
            let id = weld.get(key);
            if (id === undefined) { id = weld.size; weld.set(key, id); }
            ids[i] = id;
        }
        const idx = prim.indices !== undefined ? readIndices(prim.indices) : Uint32Array.from({ length: n }, (_, i) => i);
        const tri = (a: number, b: number, c: number) => {
            triangles++;
            const A = ids[a], B = ids[b], C = ids[c];
            if (A === B || B === C || A === C) { degenerateTriangles++; return; }
            for (const [u, v] of [[A, B], [B, C], [C, A]]) {
                const k = u < v ? `${u}_${v}` : `${v}_${u}`;
                edgeUses.set(k, (edgeUses.get(k) ?? 0) + 1);
            }
        };
        if (mode === 4) for (let t = 0; t + 2 < idx.length; t += 3) tri(idx[t], idx[t + 1], idx[t + 2]);
        else if (mode === 5) for (let t = 0; t + 2 < idx.length; t++) tri(idx[t], idx[t + 1], idx[t + 2]);
        else for (let t = 1; t + 1 < idx.length; t++) tri(idx[0], idx[t], idx[t + 1]);
    };

    const visit = (ni: number, parent: Mat4) => {
        const node = gltf.nodes?.[ni];
        if (!node) return;
        const world = mul(parent, nodeMatrix(node));
        if (node.mesh !== undefined) for (const prim of gltf.meshes?.[node.mesh]?.primitives ?? []) addPrimitive(prim, world);
        for (const c of node.children ?? []) visit(c, world);
    };
    const scenes: any[] = gltf.scenes ?? [];
    if (scenes.length) {
        for (const sc of scenes) for (const ni of sc.nodes ?? []) visit(ni, IDENTITY);
    } else {
        // No scene graph: every mesh in its own space
        for (const m of gltf.meshes ?? []) for (const prim of m.primitives ?? []) addPrimitive(prim, IDENTITY);
    }

    let boundaryEdges = 0, nonManifoldEdges = 0;
    for (const uses of edgeUses.values()) {
        if (uses === 1) boundaryEdges++;
        else if (uses > 2) nonManifoldEdges++;
    }
    return {
        isManifold: edgeUses.size > 0 && boundaryEdges === 0 && nonManifoldEdges === 0,
        triangles, weldedVertices: weld.size, edges: edgeUses.size, boundaryEdges, nonManifoldEdges, degenerateTriangles
    };
}
