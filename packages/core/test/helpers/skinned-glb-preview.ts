/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Independent reader + CPU linear-blend skinning + software rasteriser for skinned GLBs, used to
 * verify SB-Rig output and to write verification screenshots. It shares no code with the native
 * writer, so a skinning bug cannot hide in shared code.
 */

import { encodePng } from '../../src/node/texture-processing';

type Mat4 = Float64Array; // column-major

export interface SkinnedGlb {
    json: any;
    positions: Float32Array;        // mesh-local, all skinned primitives concatenated
    indices: Uint32Array;
    joints: Uint16Array;            // 4 per vertex, indices into skin.joints
    weights: Float32Array;          // 4 per vertex
    jointNodes: number[];           // node index per skin joint
    jointNames: string[];
    inverseBind: Mat4[];
    parentOf: Map<number, number>;  // node -> parent node
    primitiveVertexCounts: number[];
}

const COMPONENTS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
const BYTES: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };

function readAccessor(json: any, bin: Buffer, index: number): { data: Float64Array; count: number; comps: number } {
    const acc = json.accessors[index];
    const view = json.bufferViews[acc.bufferView];
    const comps = COMPONENTS[acc.type];
    const size = BYTES[acc.componentType];
    const stride = view.byteStride || size * comps;
    const base = (view.byteOffset || 0) + (acc.byteOffset || 0);
    const data = new Float64Array(acc.count * comps);
    for (let e = 0; e < acc.count; e++) {
        for (let c = 0; c < comps; c++) {
            const p = base + e * stride + c * size;
            switch (acc.componentType) {
                case 5126: data[e * comps + c] = bin.readFloatLE(p); break;
                case 5125: data[e * comps + c] = bin.readUInt32LE(p); break;
                case 5123: data[e * comps + c] = bin.readUInt16LE(p); break;
                case 5121: data[e * comps + c] = bin.readUInt8(p); break;
                default: throw new Error(`unsupported componentType ${acc.componentType}`);
            }
        }
    }
    return { data, count: acc.count, comps };
}

export function parseGlbChunks(buffer: Buffer): { json: any; bin: Buffer } {
    if (buffer.readUInt32LE(0) !== 0x46546c67) throw new Error('not a GLB');
    const jsonLength = buffer.readUInt32LE(12);
    const json = JSON.parse(buffer.toString('utf8', 20, 20 + jsonLength));
    const binHeader = 20 + jsonLength;
    const bin = binHeader + 8 <= buffer.length ? buffer.subarray(binHeader + 8, binHeader + 8 + buffer.readUInt32LE(binHeader)) : Buffer.alloc(0);
    return { json, bin };
}

export function readSkinnedGlb(buffer: Buffer): SkinnedGlb {
    const { json, bin } = parseGlbChunks(buffer);
    if (!json.skins?.length) throw new Error('GLB has no skin');
    const skin = json.skins[0];
    const ibm = readAccessor(json, bin, skin.inverseBindMatrices);
    const inverseBind: Mat4[] = [];
    for (let j = 0; j < skin.joints.length; j++) inverseBind.push(Float64Array.from(ibm.data.subarray(j * 16, j * 16 + 16)));
    const parentOf = new Map<number, number>();
    (json.nodes || []).forEach((n: any, i: number) => (n.children || []).forEach((c: number) => parentOf.set(c, i)));

    const pos: number[] = [], idx: number[] = [], jts: number[] = [], wts: number[] = [];
    const counts: number[] = [];
    (json.nodes || []).forEach((node: any) => {
        if (node.mesh === undefined || node.skin === undefined) return;
        for (const prim of json.meshes[node.mesh].primitives) {
            const base = pos.length / 3;
            const p = readAccessor(json, bin, prim.attributes.POSITION);
            const jj = readAccessor(json, bin, prim.attributes.JOINTS_0);
            const ww = readAccessor(json, bin, prim.attributes.WEIGHTS_0);
            if (jj.count !== p.count || ww.count !== p.count) throw new Error('JOINTS_0/WEIGHTS_0 count does not match POSITION');
            for (const x of p.data) pos.push(x);
            for (const x of jj.data) jts.push(x);
            for (const x of ww.data) wts.push(x);
            counts.push(p.count);
            if (prim.indices !== undefined) {
                const ii = readAccessor(json, bin, prim.indices);
                for (let i = 0; i < ii.count; i++) idx.push(base + ii.data[i]);
            } else {
                for (let i = 0; i < p.count; i++) idx.push(base + i);
            }
        }
    });
    return {
        json,
        positions: Float32Array.from(pos),
        indices: Uint32Array.from(idx),
        joints: Uint16Array.from(jts),
        weights: Float32Array.from(wts),
        jointNodes: skin.joints,
        jointNames: skin.joints.map((n: number) => json.nodes[n].name as string),
        inverseBind,
        parentOf,
        primitiveVertexCounts: counts,
    };
}

// ---------------------------------------------------------------------------
// Matrices
// ---------------------------------------------------------------------------

function identity(): Mat4 {
    const m = new Float64Array(16);
    m[0] = m[5] = m[10] = m[15] = 1;
    return m;
}

function mul(a: Mat4, b: Mat4): Mat4 {
    const o = new Float64Array(16);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
        let s = 0;
        for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
        o[c * 4 + r] = s;
    }
    return o;
}

function rotation(axis: number[], angle: number): Mat4 {
    const len = Math.hypot(axis[0], axis[1], axis[2]) || 1;
    const [x, y, z] = [axis[0] / len, axis[1] / len, axis[2] / len];
    const c = Math.cos(angle), s = Math.sin(angle), t = 1 - c;
    const m = identity();
    m[0] = t * x * x + c;     m[4] = t * x * y - s * z; m[8] = t * x * z + s * y;
    m[1] = t * x * y + s * z; m[5] = t * y * y + c;     m[9] = t * y * z - s * x;
    m[2] = t * x * z - s * y; m[6] = t * y * z + s * x; m[10] = t * z * z + c;
    return m;
}

function nodeLocal(node: any, extra?: Mat4): Mat4 {
    if (node.matrix) return extra ? mul(Float64Array.from(node.matrix), extra) : Float64Array.from(node.matrix);
    const t = node.translation || [0, 0, 0];
    const q = node.rotation || [0, 0, 0, 1];
    const s = node.scale || [1, 1, 1];
    const [qx, qy, qz, qw] = q;
    const r = identity();
    r[0] = 1 - 2 * (qy * qy + qz * qz); r[4] = 2 * (qx * qy - qw * qz);     r[8] = 2 * (qx * qz + qw * qy);
    r[1] = 2 * (qx * qy + qw * qz);     r[5] = 1 - 2 * (qx * qx + qz * qz); r[9] = 2 * (qy * qz - qw * qx);
    r[2] = 2 * (qx * qz - qw * qy);     r[6] = 2 * (qy * qz + qw * qx);     r[10] = 1 - 2 * (qx * qx + qy * qy);
    const T = identity();
    T[12] = t[0]; T[13] = t[1]; T[14] = t[2];
    const S = identity();
    S[0] = s[0]; S[5] = s[1]; S[10] = s[2];
    let m = mul(T, r);
    if (extra) m = mul(m, extra);
    return mul(m, S);
}

function transformPoint(m: Mat4, x: number, y: number, z: number): [number, number, number] {
    return [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]];
}

export interface JointPose { axis: number[]; angleRad: number }

/** World matrices of every skin joint, with optional extra local rotations by joint name. */
export function jointWorldMatrices(doc: SkinnedGlb, pose: Record<string, JointPose> = {}): Mat4[] {
    const cache = new Map<number, Mat4>();
    const world = (node: number): Mat4 => {
        const hit = cache.get(node);
        if (hit) return hit;
        const n = doc.json.nodes[node];
        const p = pose[n.name];
        const local = nodeLocal(n, p ? rotation(p.axis, p.angleRad) : undefined);
        const parent = doc.parentOf.get(node);
        const m = parent === undefined ? local : mul(world(parent), local);
        cache.set(node, m);
        return m;
    };
    return doc.jointNodes.map(world);
}

/** Linear-blend-skinned positions: sum_j w_j (World_j . IBM_j) v. */
export function skinPositions(doc: SkinnedGlb, pose: Record<string, JointPose> = {}): Float32Array {
    const worlds = jointWorldMatrices(doc, pose);
    const skinMats = worlds.map((w, j) => mul(w, doc.inverseBind[j]));
    const out = new Float32Array(doc.positions.length);
    const n = doc.positions.length / 3;
    for (let v = 0; v < n; v++) {
        let x = 0, y = 0, z = 0;
        for (let k = 0; k < 4; k++) {
            const w = doc.weights[v * 4 + k];
            if (w === 0) continue;
            const p = transformPoint(skinMats[doc.joints[v * 4 + k]], doc.positions[v * 3], doc.positions[v * 3 + 1], doc.positions[v * 3 + 2]);
            x += w * p[0]; y += w * p[1]; z += w * p[2];
        }
        out[v * 3] = x; out[v * 3 + 1] = y; out[v * 3 + 2] = z;
    }
    return out;
}

/** Principal axes of a point set (Jacobi on the 3x3 covariance), sorted by decreasing variance. */
export function principalAxes(positions: Float32Array): number[][] {
    const n = positions.length / 3;
    const mean = [0, 0, 0];
    for (let v = 0; v < n; v++) for (let k = 0; k < 3; k++) mean[k] += positions[v * 3 + k] / n;
    const a = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (let v = 0; v < n; v++) {
        const d = [positions[v * 3] - mean[0], positions[v * 3 + 1] - mean[1], positions[v * 3 + 2] - mean[2]];
        for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) a[i][j] += d[i] * d[j];
    }
    const vecs = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    for (let sweep = 0; sweep < 50; sweep++) {
        for (const [p, q] of [[0, 1], [0, 2], [1, 2]]) {
            if (Math.abs(a[p][q]) < 1e-15) continue;
            const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
            const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
            const c = 1 / Math.sqrt(t * t + 1), s = t * c;
            for (let k = 0; k < 3; k++) {
                const akp = a[k][p], akq = a[k][q];
                a[k][p] = c * akp - s * akq;
                a[k][q] = s * akp + c * akq;
            }
            for (let k = 0; k < 3; k++) {
                const apk = a[p][k], aqk = a[q][k];
                a[p][k] = c * apk - s * aqk;
                a[q][k] = s * apk + c * aqk;
            }
            for (let k = 0; k < 3; k++) {
                const vkp = vecs[k][p], vkq = vecs[k][q];
                vecs[k][p] = c * vkp - s * vkq;
                vecs[k][q] = s * vkp + c * vkq;
            }
        }
    }
    return [0, 1, 2]
        .map(i => ({ value: a[i][i], axis: [vecs[0][i], vecs[1][i], vecs[2][i]] }))
        .sort((x, y) => y.value - x.value)
        .map(e => e.axis);
}

// ---------------------------------------------------------------------------
// Software rasteriser
// ---------------------------------------------------------------------------

export interface PreviewPanel {
    doc: SkinnedGlb;
    pose?: Record<string, JointPose>;
    /** Screen axes in world space; the camera looks along right x up. */
    right: number[];
    up: number[];
    colorBy?: 'joint' | 'clay';
    skeleton?: boolean;
    highlightJoints?: string[];
    /** Override framing: world-space point at the panel centre and the world span across it. */
    frame?: { center: number[]; span: number };
    /** Draw world grid lines every `gridStep` units along the screen axes (for reading coordinates). */
    gridStep?: number;
    /** Extra world-space points to mark (e.g. candidate hints). */
    markers?: number[][];
}

function jointColor(j: number): [number, number, number] {
    const h = (j * 0.618033988749895) % 1;
    const s = 0.62, l = 0.58;
    const f = (n: number) => {
        const k = (n + h * 12) % 12;
        const a = s * Math.min(l, 1 - l);
        return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    };
    return [f(0) * 255, f(8) * 255, f(4) * 255];
}

const sub = (a: number[], b: number[]) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: number[]) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

/** Renders panels side by side (each `size` x `size`) into one PNG; every panel shares one framing. */
export function renderPreviewPng(panels: PreviewPanel[], size = 640): Buffer {
    const W = size * panels.length, H = size;
    const rgba = Buffer.alloc(W * H * 4);
    for (let i = 0; i < W * H; i++) { rgba[i * 4] = 236; rgba[i * 4 + 1] = 236; rgba[i * 4 + 2] = 240; rgba[i * 4 + 3] = 255; }

    const posed = panels.map(p => skinPositions(p.doc, p.pose));
    let span = 0;
    const centres: number[][] = [];
    panels.forEach((p, i) => {
        const r = norm(p.right), u = norm(p.up);
        let lo = [Infinity, Infinity], hi = [-Infinity, -Infinity];
        const P = posed[i];
        for (let v = 0; v < P.length / 3; v++) {
            const q = [P[v * 3], P[v * 3 + 1], P[v * 3 + 2]];
            const x = dot(q, r), y = dot(q, u);
            lo = [Math.min(lo[0], x), Math.min(lo[1], y)];
            hi = [Math.max(hi[0], x), Math.max(hi[1], y)];
        }
        span = Math.max(span, hi[0] - lo[0], hi[1] - lo[1]);
        centres.push([(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2]);
    });
    const sharedScale = (size * 0.9) / (span || 1);

    panels.forEach((panel, pi) => {
        const r = norm(panel.right), u = norm(panel.up), fwd = cross(r, u);
        const light = norm([fwd[0] * -0.7 + u[0] * 0.5 + r[0] * 0.3, fwd[1] * -0.7 + u[1] * 0.5 + r[1] * 0.3, fwd[2] * -0.7 + u[2] * 0.5 + r[2] * 0.3]);
        const P = posed[pi];
        const doc = panel.doc;
        const scale = panel.frame ? size / panel.frame.span : sharedScale;
        const [cx, cy] = panel.frame ? [dot(panel.frame.center, r), dot(panel.frame.center, u)] : centres[pi];
        const screen = (q: number[]) => [pi * size + size / 2 + (dot(q, r) - cx) * scale, H / 2 - (dot(q, u) - cy) * scale, -dot(q, fwd)];
        const depth = new Float32Array(size * H).fill(Infinity);
        const nv = P.length / 3;
        const S: number[][] = [];
        const dominant = new Int32Array(nv);
        for (let v = 0; v < nv; v++) {
            S.push(screen([P[v * 3], P[v * 3 + 1], P[v * 3 + 2]]));
            let best = 0;
            for (let k = 1; k < 4; k++) if (doc.weights[v * 4 + k] > doc.weights[v * 4 + best]) best = k;
            dominant[v] = doc.joints[v * 4 + best];
        }
        for (let t = 0; t < doc.indices.length; t += 3) {
            const [a, b, c] = [doc.indices[t], doc.indices[t + 1], doc.indices[t + 2]];
            const pa = [P[a * 3], P[a * 3 + 1], P[a * 3 + 2]], pb = [P[b * 3], P[b * 3 + 1], P[b * 3 + 2]], pc = [P[c * 3], P[c * 3 + 1], P[c * 3 + 2]];
            const n = norm(cross(sub(pb, pa), sub(pc, pa)));
            const shade = 0.35 + 0.65 * Math.abs(dot(n, light));
            const base = panel.colorBy === 'clay' ? [178, 180, 186] : jointColor(dominant[a]);
            const A = S[a], B = S[b], C = S[c];
            const minX = Math.max(pi * size, Math.floor(Math.min(A[0], B[0], C[0]))), maxX = Math.min(pi * size + size - 1, Math.ceil(Math.max(A[0], B[0], C[0])));
            const minY = Math.max(0, Math.floor(Math.min(A[1], B[1], C[1]))), maxY = Math.min(H - 1, Math.ceil(Math.max(A[1], B[1], C[1])));
            const area = (B[0] - A[0]) * (C[1] - A[1]) - (B[1] - A[1]) * (C[0] - A[0]);
            if (Math.abs(area) < 1e-12) continue;
            for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
                const px = x + 0.5, py = y + 0.5;
                const w0 = ((B[0] - px) * (C[1] - py) - (B[1] - py) * (C[0] - px)) / area;
                const w1 = ((C[0] - px) * (A[1] - py) - (C[1] - py) * (A[0] - px)) / area;
                const w2 = 1 - w0 - w1;
                if (w0 < 0 || w1 < 0 || w2 < 0) continue;
                const z = w0 * A[2] + w1 * B[2] + w2 * C[2];
                const di = y * size + (x - pi * size);
                if (z >= depth[di]) continue;
                depth[di] = z;
                const o = (y * W + x) * 4;
                rgba[o] = base[0] * shade; rgba[o + 1] = base[1] * shade; rgba[o + 2] = base[2] * shade;
            }
        }
        const plot = (x: number, y: number, c: number[]) => {
            const xi = Math.round(x), yi = Math.round(y);
            if (xi < pi * size || xi >= pi * size + size || yi < 0 || yi >= H) return;
            const o = (yi * W + xi) * 4;
            rgba[o] = c[0]; rgba[o + 1] = c[1]; rgba[o + 2] = c[2];
        };
        if (panel.gridStep) {
            const step = panel.gridStep;
            const half = size / 2 / scale;
            for (let g = Math.ceil((cx - half) / step) * step; g <= cx + half; g += step) {
                const x = pi * size + size / 2 + (g - cx) * scale;
                const major = Math.abs(Math.round(g / step) % 5) === 0;
                for (let y = 0; y < H; y += major ? 1 : 3) plot(x, y, major ? [90, 90, 110] : [150, 150, 165]);
            }
            for (let g = Math.ceil((cy - half) / step) * step; g <= cy + half; g += step) {
                const y = H / 2 - (g - cy) * scale;
                const major = Math.abs(Math.round(g / step) % 5) === 0;
                for (let x = pi * size; x < pi * size + size; x += major ? 1 : 3) plot(x, y, major ? [90, 90, 110] : [150, 150, 165]);
            }
        }
        for (const m of panel.markers ?? []) {
            const [x, y] = screen(m);
            for (let d = -6; d <= 6; d++) {
                plot(x + d, y, [0, 120, 255]);
                plot(x, y + d, [0, 120, 255]);
            }
        }
        if (panel.skeleton !== false) {
            const worlds = jointWorldMatrices(doc, panel.pose);
            const jp = worlds.map(m => screen([m[12], m[13], m[14]]));
            doc.jointNodes.forEach((node, j) => {
                const parent = doc.parentOf.get(node);
                const pj = parent === undefined ? -1 : doc.jointNodes.indexOf(parent);
                if (pj < 0) return;
                const [x0, y0] = jp[pj], [x1, y1] = jp[j];
                const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0)));
                for (let s = 0; s <= steps; s++) plot(x0 + (x1 - x0) * s / steps, y0 + (y1 - y0) * s / steps, [20, 20, 28]);
            });
            jp.forEach(([x, y], j) => {
                const hot = panel.highlightJoints?.includes(doc.jointNames[j]);
                const rad = hot ? 4 : 2;
                for (let dy = -rad; dy <= rad; dy++) for (let dx = -rad; dx <= rad; dx++) {
                    if (dx * dx + dy * dy <= rad * rad) plot(x + dx, y + dy, hot ? [230, 30, 30] : [255, 255, 255]);
                }
            });
        }
    });
    return encodePng(W, H, rgba);
}
