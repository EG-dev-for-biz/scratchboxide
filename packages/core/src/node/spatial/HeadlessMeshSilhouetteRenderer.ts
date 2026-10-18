/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { SobelEdgeField, computeSobelField, CameraPose6DOF } from './SubPixelEdgeAlignmentOptimizer';

export interface RenderMesh3D {
    /** Flat array of vertex positions [x0, y0, z0, x1, y1, z1, ...] */
    vertices: Float32Array | number[];
    /** Triangle indices [i0, i1, i2, ...] */
    indices: Uint32Array | number[];
}

export interface RenderTargetBuffer {
    width: number;
    height: number;
    depthBuffer: Float32Array;
    silhouetteBuffer: Uint8Array;
}

export class HeadlessMeshSilhouetteRenderer {
    /**
     * Renders a 3D mesh into depth and binary silhouette buffers using fast
     * software scanline rasterization in pure Node.js.
     */
    public static renderMesh(
        mesh: RenderMesh3D,
        pose: CameraPose6DOF,
        width: number = 320,
        height: number = 240,
        options?: { clipNearPlane?: boolean }
    ): RenderTargetBuffer {
        const size = width * height;
        const depthBuffer = new Float32Array(size);
        depthBuffer.fill(1e9); // Far plane infinity
        const silhouetteBuffer = new Uint8Array(size); // 0 or 255

        const fovRad = (pose.fov * Math.PI) / 180.0;
        const aspect = width / height;
        const near = 0.5;
        const far = 20000.0;

        // 1. Build View Matrix (LookAt)
        const eye: [number, number, number] = [pose.x, pose.y, pose.z];
        const target: [number, number, number] = [pose.targetX, pose.targetY, pose.targetZ];
        const up: [number, number, number] = pose.up ?? [0, 1, 0];

        // Forward vector (eye to target)
        let fx = target[0] - eye[0];
        let fy = target[1] - eye[1];
        let fz = target[2] - eye[2];
        let fLen = Math.hypot(fx, fy, fz);
        if (fLen < 1e-6) fLen = 1;
        fx /= fLen;
        fy /= fLen;
        fz /= fLen;

        // Right vector (forward x up)
        let rx = fy * up[2] - fz * up[1];
        let ry = fz * up[0] - fx * up[2];
        let rz = fx * up[1] - fy * up[0];
        let rLen = Math.hypot(rx, ry, rz);
        if (rLen < 1e-6) {
            rx = 1; ry = 0; rz = 0;
        } else {
            rx /= rLen; ry /= rLen; rz /= rLen;
        }

        // True up vector (right x forward)
        const ux = ry * fz - rz * fy;
        const uy = rz * fx - rx * fz;
        const uz = rx * fy - ry * fx;

        // View Matrix
        // Camera frame: +X right, +Y up, -Z forward (OpenGL / Three.js convention)
        const V = [
            [rx, ry, rz, -(rx * eye[0] + ry * eye[1] + rz * eye[2])],
            [ux, uy, uz, -(ux * eye[0] + uy * eye[1] + uz * eye[2])],
            [-fx, -fy, -fz, fx * eye[0] + fy * eye[1] + fz * eye[2]],
            [0, 0, 0, 1]
        ];

        // 2. Perspective Projection Matrix
        const tanHalfFov = Math.tan(fovRad * 0.5);
        const P00 = 1.0 / (aspect * tanHalfFov);
        const P11 = 1.0 / tanHalfFov;
        const P22 = -(far + near) / (far - near);
        const P23 = -(2.0 * far * near) / (far - near);

        // Combined VP matrix (P * V)
        const VP: number[][] = Array.from({ length: 4 }, () => new Array(4).fill(0));
        const P = [
            [P00, 0, 0, 0],
            [0, P11, 0, 0],
            [0, 0, P22, P23],
            [0, 0, -1, 0]
        ];

        for (let r = 0; r < 4; r++) {
            for (let c = 0; c < 4; c++) {
                let sum = 0;
                for (let k = 0; k < 4; k++) {
                    sum += P[r][k] * V[k][c];
                }
                VP[r][c] = sum;
            }
        }

        // 3+4. Project and rasterize with near-plane clipping (triangles straddling the camera plane
        // are clipped, not dropped, so street-level ground and facades stay intact)
        HeadlessMeshSilhouetteRenderer.forEachClippedScreenTriangle(mesh, eye, [rx, ry, rz], [ux, uy, uz], [fx, fy, fz], P00, P11, width, height, near, far, (x0, y0, z0, x1, y1, z1, x2, y2, z2) => {
            // 2D signed area. No winding cull: photogrammetry GLBs have inconsistent winding and the
            // depth test already keeps the nearest surface. Only degenerate triangles are skipped.
            const area = (x1 - x0) * (y2 - y0) - (y1 - y0) * (x2 - x0);
            if (Math.abs(area) < 1e-12) return;

            const invArea = 1.0 / area;

            // Triangle 2D Bounding Box
            const minX = Math.max(0, Math.floor(Math.min(x0, x1, x2)));
            const maxX = Math.min(width - 1, Math.ceil(Math.max(x0, x1, x2)));
            const minY = Math.max(0, Math.floor(Math.min(y0, y1, y2)));
            const maxY = Math.min(height - 1, Math.ceil(Math.max(y0, y1, y2)));

            for (let py = minY; py <= maxY; py++) {
                const rowOffset = py * width;
                for (let px = minX; px <= maxX; px++) {
                    // Barycentric coordinates sampled at the pixel centre (matches unprojection at u + 0.5)
                    const sx = px + 0.5, sy = py + 0.5;
                    const w0 = ((x1 - sx) * (y2 - sy) - (y1 - sy) * (x2 - sx)) * invArea;
                    const w1 = ((x2 - sx) * (y0 - sy) - (y2 - sy) * (x0 - sx)) * invArea;
                    const w2 = 1.0 - w0 - w1;

                    if (w0 >= 0 && w1 >= 0 && w2 >= 0) {
                        // Perspective-correct depth: 1/z is affine in screen space, z is not
                        const depth = 1.0 / (w0 / z0 + w1 / z1 + w2 / z2);
                        const idx = rowOffset + px;

                        if (depth < depthBuffer[idx]) {
                            depthBuffer[idx] = depth;
                            silhouetteBuffer[idx] = 255;
                        }
                    }
                }
            }
        }, options?.clipNearPlane ? 'clip' : 'cull');

        return {
            width,
            height,
            depthBuffer,
            silhouetteBuffer
        };
    }

    /**
     * Renders a 3D mesh and computes the Sobel edge field on the resulting
     * silhouette and depth boundaries.
     */
    /**
     * The part of `mesh` a camera near `pose` can see: drops every triangle whose three vertices all lie outside the
     * same side of a widened frustum (each half-angle widened by `marginDegrees`, apex pulled back `marginMeters` along
     * the view axis) or all lie more than `marginMeters` behind the camera, and compacts the vertices. Renders from
     * poses within that margin are pixel-identical to renders of the whole mesh; a pose search that re-renders many
     * nearby poses runs on the visible part only.
     */
    public static cullMeshToView(
        mesh: RenderMesh3D,
        pose: CameraPose6DOF,
        width: number,
        height: number,
        options: { marginMeters?: number; marginDegrees?: number } = {}
    ): RenderMesh3D {
        const m = options.marginMeters ?? 10;
        const marginRad = ((options.marginDegrees ?? 45) * Math.PI) / 180;
        const maxHalf = (85 * Math.PI) / 180;
        const eye = [pose.x, pose.y, pose.z];
        let fx = pose.targetX - pose.x, fy = pose.targetY - pose.y, fz = pose.targetZ - pose.z;
        const fl = Math.hypot(fx, fy, fz) || 1; fx /= fl; fy /= fl; fz /= fl;
        const up0 = pose.up ?? [0, 1, 0];
        let rx = fy * up0[2] - fz * up0[1], ry = fz * up0[0] - fx * up0[2], rz = fx * up0[1] - fy * up0[0];
        const rl = Math.hypot(rx, ry, rz);
        if (rl < 1e-9) return mesh; // degenerate basis: nothing safe to drop
        rx /= rl; ry /= rl; rz /= rl;
        const ux = ry * fz - rz * fy, uy = rz * fx - rx * fz, uz = rx * fy - ry * fx;
        const halfY = (pose.fov * Math.PI) / 360;
        const halfX = Math.atan(Math.tan(halfY) * (width / height));
        const tanY = Math.tan(Math.min(maxHalf, halfY + marginRad));
        const tanX = Math.tan(Math.min(maxHalf, halfX + marginRad));
        const vertCount = Math.floor(mesh.vertices.length / 3);
        // Per-vertex outcode: bit 0 right, 1 left, 2 top, 3 bottom, 4 behind.
        const code = new Uint8Array(vertCount);
        for (let i = 0; i < vertCount; i++) {
            const dx = mesh.vertices[i * 3] - eye[0], dy = mesh.vertices[i * 3 + 1] - eye[1], dz = mesh.vertices[i * 3 + 2] - eye[2];
            const x = dx * rx + dy * ry + dz * rz, y = dx * ux + dy * uy + dz * uz, z = dx * fx + dy * fy + dz * fz;
            const zz = z + m;
            let c = 0;
            if (x > tanX * zz) c |= 1;
            if (-x > tanX * zz) c |= 2;
            if (y > tanY * zz) c |= 4;
            if (-y > tanY * zz) c |= 8;
            if (z < -m) c |= 16;
            code[i] = c;
        }
        const remap = new Int32Array(vertCount).fill(-1);
        const verts: number[] = [];
        const idx: number[] = [];
        const triCount = Math.floor(mesh.indices.length / 3);
        for (let t = 0; t < triCount; t++) {
            const a = mesh.indices[t * 3], b = mesh.indices[t * 3 + 1], c = mesh.indices[t * 3 + 2];
            if (code[a] & code[b] & code[c]) continue;
            for (const v of [a, b, c]) {
                if (remap[v] < 0) {
                    remap[v] = verts.length / 3;
                    verts.push(mesh.vertices[v * 3], mesh.vertices[v * 3 + 1], mesh.vertices[v * 3 + 2]);
                }
                idx.push(remap[v]);
            }
        }
        return { vertices: new Float32Array(verts), indices: new Uint32Array(idx) };
    }

    public static renderEdgeField(
        mesh: RenderMesh3D,
        pose: CameraPose6DOF,
        width: number = 320,
        height: number = 240
    ): SobelEdgeField {
        const { depthBuffer, silhouetteBuffer } = this.renderMesh(mesh, pose, width, height);
        const size = width * height;

        // Create luminance map: high contrast silhouette edges + normalized depth relief
        const lum = new Float32Array(size);
        for (let i = 0; i < size; i++) {
            if (silhouetteBuffer[i] > 0) {
                // Modulate silhouette interior by normalized inverse depth
                const d = depthBuffer[i];
                lum[i] = 180.0 + Math.min(75.0, 500.0 / (d + 1.0));
            } else {
                lum[i] = 0;
            }
        }

        return computeSobelField(width, height, lum);
    }

    /**
     * Helper to create a proxy 3D building box mesh.
     */
    public static createBoxMesh(
        center: [number, number, number],
        size: [number, number, number]
    ): RenderMesh3D {
        const [cx, cy, cz] = center;
        const [sx, sy, sz] = size;
        const hx = sx * 0.5;
        const hy = sy * 0.5;
        const hz = sz * 0.5;

        // 8 vertices
        const vertices = new Float32Array([
            cx - hx, cy - hy, cz - hz, // 0: LBF
            cx + hx, cy - hy, cz - hz, // 1: RBF
            cx + hx, cy + hy, cz - hz, // 2: RTF
            cx - hx, cy + hy, cz - hz, // 3: LTF
            cx - hx, cy - hy, cz + hz, // 4: LBB
            cx + hx, cy - hy, cz + hz, // 5: RBB
            cx + hx, cy + hy, cz + hz, // 6: RTB
            cx - hx, cy + hy, cz + hz  // 7: LTB
        ]);

        // 12 triangles (2 per face)
        const indices = new Uint32Array([
            // Front (+Z towards -Z)
            0, 2, 1, 0, 3, 2,
            // Back
            5, 6, 4, 4, 6, 7,
            // Left
            4, 7, 0, 0, 7, 3,
            // Right
            1, 2, 5, 5, 2, 6,
            // Top
            3, 7, 2, 2, 7, 6,
            // Bottom
            4, 0, 5, 5, 0, 1
        ]);

        return { vertices, indices };
    }

    /**
     * Loads 3D geometry (vertices and indices) directly from a binary glTF 2.0 (.glb) asset,
     * such as real Google Photorealistic 3D Tiles meshes.
     */
    public static loadMeshFromGlb(glbInput: Buffer | string): RenderMesh3D {
        const buf = typeof glbInput === 'string' ? fs.readFileSync(glbInput) : glbInput;
        if (buf.length < 20) throw new Error('Invalid GLB: file too small');
        const magic = buf.toString('utf8', 0, 4);
        if (magic !== 'glTF') throw new Error('Invalid GLB: missing glTF magic header');

        const jsonLen = buf.readUInt32LE(12);
        const jsonStr = buf.toString('utf8', 20, 20 + jsonLen);
        const gltf = JSON.parse(jsonStr);

        const binHeaderOffset = 20 + jsonLen;
        const binLen = buf.readUInt32LE(binHeaderOffset);
        const binOffset = binHeaderOffset + 8;
        const binBuffer = buf.subarray(binOffset, binOffset + binLen);

        const allVertices: number[] = [];
        const allIndices: number[] = [];
        let vertexOffset = 0;

        // Traverse node hierarchy to accumulate world transform matrices
        const nodeCount = gltf.nodes ? gltf.nodes.length : 0;
        const worldMatrices: (number[] | null)[] = new Array(nodeCount).fill(null);

        function getNodeLocalMat(node: any): number[] {
            if (node.matrix && node.matrix.length === 16) return [...node.matrix];
            const m = [
                1, 0, 0, 0,
                0, 1, 0, 0,
                0, 0, 1, 0,
                0, 0, 0, 1
            ];
            const t = node.translation || [0, 0, 0];
            const r = node.rotation || [0, 0, 0, 1];
            const s = node.scale || [1, 1, 1];
            const x = r[0], y = r[1], z = r[2], w = r[3];
            const x2 = x + x, y2 = y + y, z2 = z + z;
            const xx = x * x2, xy = x * y2, xz = x * z2;
            const yy = y * y2, yz = y * z2, zz = z * z2;
            const wx = w * x2, wy = w * y2, wz = w * z2;
            const sx = s[0], sy = s[1], sz = s[2];
            m[0] = (1 - (yy + zz)) * sx; m[1] = (xy + wz) * sx; m[2] = (xz - wy) * sx;
            m[4] = (xy - wz) * sy; m[5] = (1 - (xx + zz)) * sy; m[6] = (yz + wx) * sy;
            m[8] = (xz + wy) * sz; m[9] = (yz - wx) * sz; m[10] = (1 - (xx + yy)) * sz;
            m[12] = t[0]; m[13] = t[1]; m[14] = t[2];
            return m;
        }

        function multMat4(a: number[], b: number[]): number[] {
            const out = new Array(16);
            for (let col = 0; col < 4; col++) {
                for (let row = 0; row < 4; row++) {
                    out[col * 4 + row] =
                        a[row] * b[col * 4] +
                        a[4 + row] * b[col * 4 + 1] +
                        a[8 + row] * b[col * 4 + 2] +
                        a[12 + row] * b[col * 4 + 3];
                }
            }
            return out;
        }

        const visited = new Set<number>();
        function traverseNode(nodeIdx: number, parentMat: number[] | null) {
            if (visited.has(nodeIdx)) return;
            visited.add(nodeIdx);
            const node = gltf.nodes[nodeIdx];
            if (!node) return;
            const localMat = getNodeLocalMat(node);
            const worldMat = parentMat ? multMat4(parentMat, localMat) : localMat;
            worldMatrices[nodeIdx] = worldMat;
            if (node.children && Array.isArray(node.children)) {
                for (const childIdx of node.children) {
                    traverseNode(childIdx, worldMat);
                }
            }
        }

        const scenes = gltf.scenes || (gltf.scene !== undefined ? [gltf.scenes[gltf.scene]] : []);
        for (const sc of scenes) {
            if (sc && sc.nodes) {
                for (const rootNode of sc.nodes) {
                    traverseNode(rootNode, null);
                }
            }
        }
        for (let i = 0; i < nodeCount; i++) {
            if (!visited.has(i)) traverseNode(i, null);
        }

        // Collect mesh instances to process
        interface MeshInstance {
            mesh: any;
            worldMat: number[];
        }
        const meshInstances: MeshInstance[] = [];

        if (gltf.nodes && gltf.nodes.length > 0) {
            for (let i = 0; i < gltf.nodes.length; i++) {
                const node = gltf.nodes[i];
                if (node.mesh !== undefined && gltf.meshes && gltf.meshes[node.mesh]) {
                    meshInstances.push({
                        mesh: gltf.meshes[node.mesh],
                        worldMat: worldMatrices[i] || [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]
                    });
                }
            }
        }

        // Fallback if no nodes reference meshes
        if (meshInstances.length === 0 && gltf.meshes) {
            for (const mesh of gltf.meshes) {
                meshInstances.push({
                    mesh,
                    worldMat: [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]
                });
            }
        }

        for (const inst of meshInstances) {
            const mesh = inst.mesh;
            const wm = inst.worldMat;
            const isIdentity = (
                wm[0] === 1 && wm[5] === 1 && wm[10] === 1 && wm[15] === 1 &&
                wm[1] === 0 && wm[2] === 0 && wm[3] === 0 &&
                wm[4] === 0 && wm[6] === 0 && wm[7] === 0 &&
                wm[8] === 0 && wm[9] === 0 && wm[11] === 0 &&
                wm[12] === 0 && wm[13] === 0 && wm[14] === 0
            );

            for (const prim of mesh.primitives || []) {
                // Only triangle lists render as surfaces (mode 4 is the glTF default)
                if (prim.mode !== undefined && prim.mode !== 4) continue;
                if (prim.attributes && prim.attributes.POSITION !== undefined) {
                    const posAcc = gltf.accessors[prim.attributes.POSITION];
                    if (posAcc.componentType !== 5126) {
                        throw new Error(`loadMeshFromGlb: POSITION componentType ${posAcc.componentType} is not FLOAT (5126)`);
                    }
                    const posView = gltf.bufferViews[posAcc.bufferView];
                    const byteOffset = (posView.byteOffset || 0) + (posAcc.byteOffset || 0);
                    const posStride = posView.byteStride || 12;
                    const count = posAcc.count;
                    // DataView: accessors may be interleaved (byteStride) or not 4-byte aligned within the BIN chunk
                    const bin = new DataView(binBuffer.buffer, binBuffer.byteOffset, binBuffer.byteLength);

                    for (let v = 0; v < count; v++) {
                        const o = byteOffset + v * posStride;
                        const px = bin.getFloat32(o, true);
                        const py = bin.getFloat32(o + 4, true);
                        const pz = bin.getFloat32(o + 8, true);
                        if (isIdentity) {
                            allVertices.push(px, py, pz);
                        } else {
                            const tx = wm[0] * px + wm[4] * py + wm[8] * pz + wm[12];
                            const ty = wm[1] * px + wm[5] * py + wm[9] * pz + wm[13];
                            const tz = wm[2] * px + wm[6] * py + wm[10] * pz + wm[14];
                            allVertices.push(tx, ty, tz);
                        }
                    }

                    if (prim.indices !== undefined) {
                        const indAcc = gltf.accessors[prim.indices];
                        const indView = gltf.bufferViews[indAcc.bufferView];
                        const indByteOffset = (indView.byteOffset || 0) + (indAcc.byteOffset || 0);
                        const indCount = indAcc.count;

                        // UNSIGNED_BYTE, UNSIGNED_SHORT and UNSIGNED_INT are all valid glTF index types (Google 3D
                        // Tiles use all three); skipping one silently drops that primitive's triangles
                        const read = indAcc.componentType === 5121 ? (o: number) => bin.getUint8(o)
                            : indAcc.componentType === 5123 ? (o: number) => bin.getUint16(o, true)
                            : indAcc.componentType === 5125 ? (o: number) => bin.getUint32(o, true)
                            : undefined;
                        if (!read) {
                            throw new Error(`loadMeshFromGlb: unsupported index componentType ${indAcc.componentType}`);
                        }
                        const size = indAcc.componentType === 5121 ? 1 : indAcc.componentType === 5123 ? 2 : 4;
                        const indStride = indView.byteStride || size;
                        for (let i = 0; i < indCount; i++) {
                            allIndices.push(read(indByteOffset + i * indStride) + vertexOffset);
                        }
                    } else {
                        // Non-indexed primitive: sequential triangles (glTF mode 4 TRIANGLES default)
                        for (let i = 0; i < count; i++) {
                            allIndices.push(vertexOffset + i);
                        }
                    }
                    vertexOffset += count;
                }
            }
        }

        return {
            vertices: new Float32Array(allVertices),
            indices: new Uint32Array(allIndices)
        };
    }

    /**
     * Fast pure-Node.js CRC32 lookup table and calculation
     */
    private static _crcTable: number[] | null = null;
    private static getCrcTable(): number[] {
        if (!HeadlessMeshSilhouetteRenderer._crcTable) {
            const table: number[] = [];
            for (let n = 0; n < 256; n++) {
                let c = n;
                for (let k = 0; k < 8; k++) {
                    c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
                }
                table[n] = c;
            }
            HeadlessMeshSilhouetteRenderer._crcTable = table;
        }
        return HeadlessMeshSilhouetteRenderer._crcTable;
    }

    private static crc32(buf: Buffer): number {
        const table = HeadlessMeshSilhouetteRenderer.getCrcTable();
        let c = 0xffffffff;
        for (let i = 0; i < buf.length; i++) {
            c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
        }
        return (c ^ 0xffffffff);
    }

    private static makeChunk(type: string, data: Buffer): Buffer {
        const len = Buffer.alloc(4);
        len.writeUInt32BE(data.length, 0);
        const typeBuf = Buffer.from(type, 'ascii');
        const crc = HeadlessMeshSilhouetteRenderer.crc32(Buffer.concat([typeBuf, data]));
        const crcBuf = Buffer.alloc(4);
        crcBuf.writeUInt32BE(crc >>> 0, 0);
        return Buffer.concat([len, typeBuf, data, crcBuf]);
    }

    /**
     * Encodes raw 32-bit RGBA buffer into a standard PNG file buffer in pure Node.js (zero external dependencies).
     */
    public static encodePng(width: number, height: number, rgba: Buffer | Uint8Array): Buffer {
        const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

        const ihdr = Buffer.alloc(13);
        ihdr.writeUInt32BE(width, 0);
        ihdr.writeUInt32BE(height, 4);
        ihdr[8] = 8;  // bit depth: 8-bit per channel
        ihdr[9] = 6;  // color type: RGBA
        ihdr[10] = 0; // compression: deflate
        ihdr[11] = 0; // filter method
        ihdr[12] = 0; // interlace: none

        const scanlines = Buffer.alloc((width * 4 + 1) * height);
        const rgbaBuf = Buffer.isBuffer(rgba) ? rgba : Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength);

        for (let y = 0; y < height; y++) {
            const rowOffset = y * (width * 4 + 1);
            scanlines[rowOffset] = 0; // Filter type 0 (None)
            rgbaBuf.copy(scanlines, rowOffset + 1, y * width * 4, (y + 1) * width * 4);
        }

        const idatData = zlib.deflateSync(scanlines);

        return Buffer.concat([
            signature,
            HeadlessMeshSilhouetteRenderer.makeChunk('IHDR', ihdr),
            HeadlessMeshSilhouetteRenderer.makeChunk('IDAT', idatData),
            HeadlessMeshSilhouetteRenderer.makeChunk('IEND', Buffer.alloc(0))
        ]);
    }

    /**
     * Writes PNG buffer to disk and ensures parent directory exists.
     */
    public static exportPngToFile(outputPath: string, width: number, height: number, rgba: Buffer | Uint8Array): void {
        const dir = path.dirname(outputPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        const pngBuf = HeadlessMeshSilhouetteRenderer.encodePng(width, height, rgba);
        fs.writeFileSync(outputPath, pngBuf);
    }


    /**
     * Transforms every triangle to camera space, clips it against the near plane (Sutherland-Hodgman,
     * yielding up to two triangles), projects to screen and invokes `emit`. Far-plane and viewport
     * culling are left to the depth test and the rasterizer's bounding-box clamp.
     */
    private static forEachClippedScreenTriangle(
        mesh: RenderMesh3D,
        eye: [number, number, number], right: [number, number, number], up: [number, number, number], fwd: [number, number, number],
        P00: number, P11: number, width: number, height: number, near: number, far: number,
        emit: (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, x2: number, y2: number, z2: number, i0: number, i1: number, i2: number) => void,
        /**
         * 'clip'     : Sutherland-Hodgman clip against the near plane (geometrically correct; use for survey/blockout renders).
         * 'cull'     : legacy renderMesh behaviour, drop any triangle with a vertex nearer than `near`.
         * 'cull-ndc' : legacy renderShadedMesh behaviour, also drop triangles with a vertex outside +/-1.2 NDC.
         * Legacy modes stay the default because mixed-LOD tile dumps contain kilometre-scale skirt
         * triangles that, rendered correctly, cover the frame; existing resection tests depend on that.
         */
        mode: 'clip' | 'cull' | 'cull-ndc' = 'clip'
    ): void {
        const vertCount = Math.floor(mesh.vertices.length / 3);
        const vX = new Float32Array(vertCount), vY = new Float32Array(vertCount), vZ = new Float32Array(vertCount);
        for (let i = 0; i < vertCount; i++) {
            const dx = mesh.vertices[i * 3] - eye[0], dy = mesh.vertices[i * 3 + 1] - eye[1], dz = mesh.vertices[i * 3 + 2] - eye[2];
            vX[i] = dx * right[0] + dy * right[1] + dz * right[2];
            vY[i] = dx * up[0] + dy * up[1] + dz * up[2];
            vZ[i] = dx * fwd[0] + dy * fwd[1] + dz * fwd[2];
        }
        const halfW = width * 0.5, halfH = height * 0.5;
        const sx = (x: number, z: number) => (P00 * x / z + 1) * halfW;
        const sy = (y: number, z: number) => (1 - P11 * y / z) * halfH;
        const triCount = Math.floor(mesh.indices.length / 3);
        const poly: number[][] = [];
        for (let t = 0; t < triCount; t++) {
            const i0 = mesh.indices[t * 3], i1 = mesh.indices[t * 3 + 1], i2 = mesh.indices[t * 3 + 2];
            const z0 = vZ[i0], z1 = vZ[i1], z2 = vZ[i2];
            if (z0 < near && z1 < near && z2 < near) continue;            // fully behind
            if (z0 > far && z1 > far && z2 > far) continue;               // fully beyond
            if (z0 >= near && z1 >= near && z2 >= near) {
                if (mode === 'cull-ndc') {
                    const inNdc = (x: number, y: number, z: number) => { const nx = P00 * x / z, ny = P11 * y / z; return nx >= -1.2 && nx <= 1.2 && ny >= -1.2 && ny <= 1.2; };
                    if (!inNdc(vX[i0], vY[i0], z0) || !inNdc(vX[i1], vY[i1], z1) || !inNdc(vX[i2], vY[i2], z2)) continue;
                }
                emit(sx(vX[i0], z0), sy(vY[i0], z0), z0, sx(vX[i1], z1), sy(vY[i1], z1), z1, sx(vX[i2], z2), sy(vY[i2], z2), z2, i0, i1, i2);
                continue;
            }
            if (mode !== 'clip') continue; // legacy: a vertex is behind the near plane -> drop
            // Clip against z = near
            poly.length = 0;
            const idx = [i0, i1, i2];
            for (let k = 0; k < 3; k++) {
                const a = idx[k], b = idx[(k + 1) % 3];
                const az = vZ[a], bz = vZ[b];
                const aIn = az >= near, bIn = bz >= near;
                if (aIn) poly.push([vX[a], vY[a], az]);
                if (aIn !== bIn) {
                    const tt = (near - az) / (bz - az);
                    poly.push([vX[a] + (vX[b] - vX[a]) * tt, vY[a] + (vY[b] - vY[a]) * tt, near]);
                }
            }
            for (let k = 1; k + 1 < poly.length; k++) {
                const A = poly[0], B = poly[k], C = poly[k + 1];
                emit(sx(A[0], A[2]), sy(A[1], A[2]), A[2], sx(B[0], B[2]), sy(B[1], B[2]), B[2], sx(C[0], C[2]), sy(C[1], C[2]), C[2], i0, i1, i2);
            }
        }
    }

    /**
     * Rasterizes a 3D mesh with Lambertian directional shading and soft ambient into an RGBA Buffer.
     */
    public static renderShadedMesh(
        mesh: RenderMesh3D,
        pose: CameraPose6DOF,
        width: number = 640,
        height: number = 480,
        options?: {
            clayColor?: [number, number, number];
            bgColor?: [number, number, number, number];
            lightDir?: [number, number, number];
            /** Clip triangles at the near plane instead of dropping them (see forEachClippedScreenTriangle). */
            clipNearPlane?: boolean;
            /** Linear RGB per vertex (0..1). When given, each triangle is shaded in its own color instead of clayColor. */
            vertexColors?: Float32Array | number[];
        }
    ): { width: number; height: number; rgba: Buffer; depthBuffer: Float32Array; silhouetteBuffer: Uint8Array } {
        const baseColor = options?.clayColor || [190, 205, 220]; // Studio grey-blue clay
        const bgColor = options?.bgColor || [18, 22, 28, 255]; // Deep dark slate canvas
        const light = options?.lightDir || [0.4, 0.8, -0.6];
        const lLen = Math.hypot(light[0], light[1], light[2]) || 1;
        const lx = light[0] / lLen, ly = light[1] / lLen, lz = light[2] / lLen;

        const size = width * height;
        const depthBuffer = new Float32Array(size);
        depthBuffer.fill(1e9);
        const silhouetteBuffer = new Uint8Array(size);
        const rgba = Buffer.alloc(size * 4);

        // Fill background
        for (let i = 0; i < size; i++) {
            rgba[i * 4] = bgColor[0];
            rgba[i * 4 + 1] = bgColor[1];
            rgba[i * 4 + 2] = bgColor[2];
            rgba[i * 4 + 3] = bgColor[3];
        }

        // Camera View-Projection Matrix
        const eye = [pose.x, pose.y, pose.z];
        const target = [pose.targetX, pose.targetY, pose.targetZ];
        let fx = target[0] - eye[0];
        let fy = target[1] - eye[1];
        let fz = target[2] - eye[2];
        const flen = Math.hypot(fx, fy, fz) || 1;
        fx /= flen; fy /= flen; fz /= flen;

        const up = pose.up ?? [0, 1, 0];
        // right = forward x up (camera looks down -Z with +Y up => right is +X)
        let rx = fy * up[2] - fz * up[1];
        let ry = fz * up[0] - fx * up[2];
        let rz = fx * up[1] - fy * up[0];
        const rlen = Math.hypot(rx, ry, rz) || 1;
        rx /= rlen; ry /= rlen; rz /= rlen;

        // true up = right x forward
        const ux = ry * fz - rz * fy;
        const uy = rz * fx - rx * fz;
        const uz = rx * fy - ry * fx;

        const aspect = width / height;
        const fovRad = (pose.fov * Math.PI) / 180;
        const f = 1.0 / Math.tan(fovRad / 2);
        const zNear = 0.5;
        const zFar = 1000.0;

        const V = [
            rx, ux, -fx, 0,
            ry, uy, -fy, 0,
            rz, uz, -fz, 0,
            -(rx * eye[0] + ry * eye[1] + rz * eye[2]),
            -(ux * eye[0] + uy * eye[1] + uz * eye[2]),
            -(-fx * eye[0] + -fy * eye[1] + -fz * eye[2]),
            1
        ];

        const P = [
            f / aspect, 0, 0, 0,
            0, f, 0, 0,
            0, 0, (zFar + zNear) / (zNear - zFar), -1,
            0, 0, (2 * zFar * zNear) / (zNear - zFar), 0
        ];

        const VP = new Float32Array(16);
        for (let i = 0; i < 4; i++) {
            for (let j = 0; j < 4; j++) {
                let sum = 0;
                for (let k = 0; k < 4; k++) {
                    sum += V[i * 4 + k] * P[k * 4 + j];
                }
                VP[i * 4 + j] = sum;
            }
        }

        const P00 = f / aspect, P11 = f;
        HeadlessMeshSilhouetteRenderer.forEachClippedScreenTriangle(mesh, [eye[0], eye[1], eye[2]], [rx, ry, rz], [ux, uy, uz], [fx, fy, fz], P00, P11, width, height, zNear, zFar, (x0, y0, z0, x1, y1, z1, x2, y2, z2, i0, i1, i2) => {
            const area = (x1 - x0) * (y2 - y0) - (y1 - y0) * (x2 - x0);
            if (Math.abs(area) < 1e-12) return; // degenerate only; no winding cull (see renderMesh)

            // Calculate 3D normal for Lambertian lighting
            const ax = mesh.vertices[i1 * 3] - mesh.vertices[i0 * 3];
            const ay = mesh.vertices[i1 * 3 + 1] - mesh.vertices[i0 * 3 + 1];
            const az = mesh.vertices[i1 * 3 + 2] - mesh.vertices[i0 * 3 + 2];
            const bx = mesh.vertices[i2 * 3] - mesh.vertices[i0 * 3];
            const by = mesh.vertices[i2 * 3 + 1] - mesh.vertices[i0 * 3 + 1];
            const bz = mesh.vertices[i2 * 3 + 2] - mesh.vertices[i0 * 3 + 2];

            let nx = ay * bz - az * by;
            let ny = az * bx - ax * bz;
            let nz = ax * by - ay * bx;
            const nlen = Math.hypot(nx, ny, nz) || 1;
            nx /= nlen; ny /= nlen; nz /= nlen;
            // Face the normal toward the camera so shading is winding-independent
            const vcx = eye[0] - mesh.vertices[i0 * 3], vcy = eye[1] - mesh.vertices[i0 * 3 + 1], vcz = eye[2] - mesh.vertices[i0 * 3 + 2];
            if (nx * vcx + ny * vcy + nz * vcz < 0) { nx = -nx; ny = -ny; nz = -nz; }

            const dot = nx * lx + ny * ly + nz * lz;
            const diffuse = Math.max(0, dot);
            const ambient = 0.35;
            const intensity = Math.min(1.0, ambient + 0.65 * diffuse);

            let triColor = baseColor;
            const vcol = options?.vertexColors;
            if (vcol && vcol.length >= (Math.max(i0, i1, i2) + 1) * 3) {
                // Average the corners in linear space, then encode to sRGB for display.
                const toSrgb = (c: number) => 255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
                triColor = [0, 1, 2].map(k => toSrgb(Math.max(0, Math.min(1, (vcol[i0 * 3 + k] + vcol[i1 * 3 + k] + vcol[i2 * 3 + k]) / 3)))) as [number, number, number];
            }
            const rCol = Math.min(255, Math.max(0, Math.round(triColor[0] * intensity)));
            const gCol = Math.min(255, Math.max(0, Math.round(triColor[1] * intensity)));
            const bCol = Math.min(255, Math.max(0, Math.round(triColor[2] * intensity)));

            const minX = Math.max(0, Math.floor(Math.min(x0, x1, x2)));
            const maxX = Math.min(width - 1, Math.ceil(Math.max(x0, x1, x2)));
            const minY = Math.max(0, Math.floor(Math.min(y0, y1, y2)));
            const maxY = Math.min(height - 1, Math.ceil(Math.max(y0, y1, y2)));

            const invArea = 1.0 / area;
            for (let py = minY; py <= maxY; py++) {
                const pyOffset = py * width;
                for (let px = minX; px <= maxX; px++) {
                    const sx = px + 0.5, sy = py + 0.5; // pixel-centre sampling
                    const w0 = (x1 - sx) * (y2 - sy) - (y1 - sy) * (x2 - sx);
                    const w1 = (x2 - sx) * (y0 - sy) - (y2 - sy) * (x0 - sx);
                    const w2 = (x0 - sx) * (y1 - sy) - (y0 - sy) * (x1 - sx);

                    const b0 = w0 * invArea;
                    const b1 = w1 * invArea;
                    const b2 = w2 * invArea;
                    if (b0 >= 0 && b1 >= 0 && b2 >= 0) {
                        const z = 1.0 / (b0 / z0 + b1 / z1 + b2 / z2); // perspective-correct
                        const idx = pyOffset + px;
                        if (z < depthBuffer[idx]) {
                            depthBuffer[idx] = z;
                            silhouetteBuffer[idx] = 255;
                            const pIdx = idx * 4;
                            rgba[pIdx] = rCol;
                            rgba[pIdx + 1] = gCol;
                            rgba[pIdx + 2] = bCol;
                            rgba[pIdx + 3] = 255;
                        }
                    }
                }
            }
        }, options?.clipNearPlane ? 'clip' : 'cull-ndc');

        return { width, height, rgba, depthBuffer, silhouetteBuffer };
    }

    /**
     * Draws Bresenham line on an RGBA buffer.
     */
    public static drawLine(
        rgba: Buffer,
        width: number,
        height: number,
        x0: number,
        y0: number,
        x1: number,
        y1: number,
        color: [number, number, number, number] = [0, 240, 255, 255]
    ): void {
        let ix0 = Math.round(x0);
        let iy0 = Math.round(y0);
        const ix1 = Math.round(x1);
        const iy1 = Math.round(y1);

        const dx = Math.abs(ix1 - ix0);
        const dy = Math.abs(iy1 - iy0);
        const sx = ix0 < ix1 ? 1 : -1;
        const sy = iy0 < iy1 ? 1 : -1;
        let err = dx - dy;

        while (true) {
            if (ix0 >= 0 && ix0 < width && iy0 >= 0 && iy0 < height) {
                const idx = (iy0 * width + ix0) * 4;
                rgba[idx] = color[0];
                rgba[idx + 1] = color[1];
                rgba[idx + 2] = color[2];
                rgba[idx + 3] = color[3];
            }
            if (ix0 === ix1 && iy0 === iy1) break;
            const e2 = 2 * err;
            if (e2 > -dy) {
                err -= dy;
                ix0 += sx;
            }
            if (e2 < dx) {
                err += dx;
                iy0 += sy;
            }
        }
    }

    /**
     * Draws a filled circular keypoint with an optional outline.
     */
    public static drawPoint(
        rgba: Buffer,
        width: number,
        height: number,
        cx: number,
        cy: number,
        radius: number = 4,
        color: [number, number, number, number] = [255, 215, 0, 255],
        outlineColor: [number, number, number, number] = [0, 0, 0, 255]
    ): void {
        const icx = Math.round(cx);
        const icy = Math.round(cy);
        const r2 = radius * radius;
        const outR2 = (radius + 1.5) * (radius + 1.5);

        for (let dy = -radius - 2; dy <= radius + 2; dy++) {
            const py = icy + dy;
            if (py < 0 || py >= height) continue;
            for (let dx = -radius - 2; dx <= radius + 2; dx++) {
                const px = icx + dx;
                if (px < 0 || px >= width) continue;
                const d2 = dx * dx + dy * dy;
                const idx = (py * width + px) * 4;
                if (d2 <= r2) {
                    rgba[idx] = color[0];
                    rgba[idx + 1] = color[1];
                    rgba[idx + 2] = color[2];
                    rgba[idx + 3] = color[3];
                } else if (d2 <= outR2) {
                    rgba[idx] = outlineColor[0];
                    rgba[idx + 1] = outlineColor[1];
                    rgba[idx + 2] = outlineColor[2];
                    rgba[idx + 3] = outlineColor[3];
                }
            }
        }
    }

    /**
     * Projects and draws the 3D triangle wireframe of the mesh onto the RGBA buffer.
     */
    public static drawWireframe(
        rgba: Buffer,
        width: number,
        height: number,
        mesh: RenderMesh3D,
        pose: CameraPose6DOF,
        color: [number, number, number, number] = [0, 240, 255, 255],
        stride: number = 1
    ): void {
        const eye = [pose.x, pose.y, pose.z];
        const target = [pose.targetX, pose.targetY, pose.targetZ];
        let fx = target[0] - eye[0];
        let fy = target[1] - eye[1];
        let fz = target[2] - eye[2];
        const flen = Math.hypot(fx, fy, fz) || 1;
        fx /= flen; fy /= flen; fz /= flen;

        const up = [0, 1, 0];
        let rx = up[1] * fz - up[2] * fy;
        let ry = up[2] * fx - up[0] * fz;
        let rz = up[0] * fy - up[1] * fx;
        const rlen = Math.hypot(rx, ry, rz) || 1;
        rx /= rlen; ry /= rlen; rz /= rlen;

        const ux = fy * rz - fz * ry;
        const uy = fz * rx - fx * rz;
        const uz = fx * ry - fy * rx;

        const aspect = width / height;
        const fovRad = (pose.fov * Math.PI) / 180;
        const f = 1.0 / Math.tan(fovRad / 2);
        const zNear = 0.5;
        const zFar = 1000.0;

        const V = [
            rx, ux, -fx, 0,
            ry, uy, -fy, 0,
            rz, uz, -fz, 0,
            -(rx * eye[0] + ry * eye[1] + rz * eye[2]),
            -(ux * eye[0] + uy * eye[1] + uz * eye[2]),
            -(-fx * eye[0] + -fy * eye[1] + -fz * eye[2]),
            1
        ];

        const P = [
            f / aspect, 0, 0, 0,
            0, f, 0, 0,
            0, 0, (zFar + zNear) / (zNear - zFar), -1,
            0, 0, (2 * zFar * zNear) / (zNear - zFar), 0
        ];

        const VP = new Float32Array(16);
        for (let i = 0; i < 4; i++) {
            for (let j = 0; j < 4; j++) {
                let sum = 0;
                for (let k = 0; k < 4; k++) sum += V[i * 4 + k] * P[k * 4 + j];
                VP[i * 4 + j] = sum;
            }
        }

        const vertCount = (mesh.vertices.length / 3) | 0;
        const screenX = new Float32Array(vertCount);
        const screenY = new Float32Array(vertCount);
        const isValid = new Uint8Array(vertCount);

        for (let i = 0; i < vertCount; i++) {
            const vx = mesh.vertices[i * 3];
            const vy = mesh.vertices[i * 3 + 1];
            const vz = mesh.vertices[i * 3 + 2];

            const cx = vx * VP[0] + vy * VP[4] + vz * VP[8] + VP[12];
            const cy = vx * VP[1] + vy * VP[5] + vz * VP[9] + VP[13];
            const cw = vx * VP[3] + vy * VP[7] + vz * VP[11] + VP[15];

            if (cw > 0.5) {
                const invW = 1.0 / cw;
                const ndcX = cx * invW;
                const ndcY = cy * invW;
                screenX[i] = (ndcX * 0.5 + 0.5) * width;
                screenY[i] = (1.0 - (ndcY * 0.5 + 0.5)) * height;
                if (ndcX >= -0.3 && ndcX <= 1.3 && ndcY >= -0.3 && ndcY <= 1.3) {
                    isValid[i] = 1;
                }
            }
        }

        const triCount = (mesh.indices.length / 3) | 0;
        for (let t = 0; t < triCount; t += stride) {
            const i0 = mesh.indices[t * 3];
            const i1 = mesh.indices[t * 3 + 1];
            const i2 = mesh.indices[t * 3 + 2];

            if (!isValid[i0] || !isValid[i1] || !isValid[i2]) continue;

            const x0 = screenX[i0], y0 = screenY[i0];
            const x1 = screenX[i1], y1 = screenY[i1];
            const x2 = screenX[i2], y2 = screenY[i2];
            const area = (x1 - x0) * (y2 - y0) - (y1 - y0) * (x2 - x0);
            if (area <= 0) continue; // Back-face culling for wireframe

            HeadlessMeshSilhouetteRenderer.drawLine(rgba, width, height, x0, y0, x1, y1, color);
            HeadlessMeshSilhouetteRenderer.drawLine(rgba, width, height, x1, y1, x2, y2, color);
            HeadlessMeshSilhouetteRenderer.drawLine(rgba, width, height, x2, y2, x0, y0, color);
        }
    }

    /**
     * Composites left and right RGBA images with an interactive vertical 50/50 split line.
     */
    public static compositeSplit(
        leftRgba: Buffer,
        rightRgba: Buffer,
        width: number,
        height: number,
        splitRatio: number = 0.5,
        dividerColor: [number, number, number, number] = [0, 240, 255, 255]
    ): Buffer {
        const out = Buffer.alloc(width * height * 4);
        const splitX = Math.round(width * splitRatio);

        for (let y = 0; y < height; y++) {
            const rowOffset = y * width * 4;
            for (let x = 0; x < width; x++) {
                const idx = rowOffset + x * 4;
                if (Math.abs(x - splitX) <= 1) {
                    out[idx] = dividerColor[0];
                    out[idx + 1] = dividerColor[1];
                    out[idx + 2] = dividerColor[2];
                    out[idx + 3] = dividerColor[3];
                } else if (x < splitX) {
                    out[idx] = leftRgba[idx];
                    out[idx + 1] = leftRgba[idx + 1];
                    out[idx + 2] = leftRgba[idx + 2];
                    out[idx + 3] = leftRgba[idx + 3];
                } else {
                    out[idx] = rightRgba[idx];
                    out[idx + 1] = rightRgba[idx + 1];
                    out[idx + 2] = rightRgba[idx + 2];
                    out[idx + 3] = rightRgba[idx + 3];
                }
            }
        }
        return out;
    }

    /**
     * Converts Sobel edge field magnitudes into an emerald edge heatmap RGBA buffer.
     */
    public static renderEdgeFieldToRgba(
        edgeField: SobelEdgeField,
        edgeColor: [number, number, number] = [0, 255, 136],
        bgColor: [number, number, number] = [15, 20, 25]
    ): Buffer {
        const { width, height, magnitudes } = edgeField;
        const rgba = Buffer.alloc(width * height * 4);

        for (let i = 0; i < magnitudes.length; i++) {
            const mag = Math.min(1.0, magnitudes[i]);
            const idx = i * 4;
            rgba[idx] = Math.round(bgColor[0] * (1 - mag) + edgeColor[0] * mag);
            rgba[idx + 1] = Math.round(bgColor[1] * (1 - mag) + edgeColor[1] * mag);
            rgba[idx + 2] = Math.round(bgColor[2] * (1 - mag) + edgeColor[2] * mag);
            rgba[idx + 3] = 255;
        }
        return rgba;
    }

    /**
     * Projects a single 3D world coordinate into 2D screen pixel space [x, y, zDepth].
     */
    public static projectPoint(
        vx: number, vy: number, vz: number,
        pose: CameraPose6DOF,
        width: number, height: number
    ): [number, number, number] | null {
        const eye = [pose.x, pose.y, pose.z];
        const target = [pose.targetX, pose.targetY, pose.targetZ];
        let fx = target[0] - eye[0];
        let fy = target[1] - eye[1];
        let fz = target[2] - eye[2];
        const flen = Math.hypot(fx, fy, fz) || 1;
        fx /= flen; fy /= flen; fz /= flen;

        const up = [0, 1, 0];
        let rx = up[1] * fz - up[2] * fy;
        let ry = up[2] * fx - up[0] * fz;
        let rz = up[0] * fy - up[1] * fx;
        const rlen = Math.hypot(rx, ry, rz) || 1;
        rx /= rlen; ry /= rlen; rz /= rlen;

        const ux = fy * rz - fz * ry;
        const uy = fz * rx - fx * rz;
        const uz = fx * ry - fy * rx;

        const aspect = width / height;
        const fovRad = (pose.fov * Math.PI) / 180;
        const f = 1.0 / Math.tan(fovRad / 2);
        const zNear = 0.5;
        const zFar = 1000.0;

        const V = [
            rx, ux, -fx, 0,
            ry, uy, -fy, 0,
            rz, uz, -fz, 0,
            -(rx * eye[0] + ry * eye[1] + rz * eye[2]),
            -(ux * eye[0] + uy * eye[1] + uz * eye[2]),
            -(-fx * eye[0] + -fy * eye[1] + -fz * eye[2]),
            1
        ];

        const P = [
            f / aspect, 0, 0, 0,
            0, f, 0, 0,
            0, 0, (zFar + zNear) / (zNear - zFar), -1,
            0, 0, (2 * zFar * zNear) / (zNear - zFar), 0
        ];

        const VP = new Float32Array(16);
        for (let i = 0; i < 4; i++) {
            for (let j = 0; j < 4; j++) {
                let sum = 0;
                for (let k = 0; k < 4; k++) sum += V[i * 4 + k] * P[k * 4 + j];
                VP[i * 4 + j] = sum;
            }
        }

        const cx = vx * VP[0] + vy * VP[4] + vz * VP[8] + VP[12];
        const cy = vx * VP[1] + vy * VP[5] + vz * VP[9] + VP[13];
        const cw = vx * VP[3] + vy * VP[7] + vz * VP[11] + VP[15];

        if (cw <= 0.05) return null;
        const invW = 1.0 / cw;
        const sx = (cx * invW * 0.5 + 0.5) * width;
        const sy = (1.0 - (cy * invW * 0.5 + 0.5)) * height;
        return [sx, sy, cw];
    }
}

