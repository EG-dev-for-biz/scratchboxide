/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { SobelEdgeField, computeSobelField, CameraPose6DOF } from './SubPixelEdgeAlignmentOptimizer.js';

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
        height: number = 240
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
        const up: [number, number, number] = [0, 1, 0];

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

        // 3. Project vertices to Clip Space & Screen Space
        const vertCount = Math.floor(mesh.vertices.length / 3);
        const screenX = new Float32Array(vertCount);
        const screenY = new Float32Array(vertCount);
        const screenZ = new Float32Array(vertCount);
        const isVisible = new Uint8Array(vertCount);

        const halfW = width * 0.5;
        const halfH = height * 0.5;

        for (let i = 0; i < vertCount; i++) {
            const vx = mesh.vertices[i * 3];
            const vy = mesh.vertices[i * 3 + 1];
            const vz = mesh.vertices[i * 3 + 2];

            const cx = VP[0][0] * vx + VP[0][1] * vy + VP[0][2] * vz + VP[0][3];
            const cy = VP[1][0] * vx + VP[1][1] * vy + VP[1][2] * vz + VP[1][3];
            const cz = VP[2][0] * vx + VP[2][1] * vy + VP[2][2] * vz + VP[2][3];
            const cw = VP[3][0] * vx + VP[3][1] * vy + VP[3][2] * vz + VP[3][3];

            if (cw > near && cw < far) {
                const invW = 1.0 / cw;
                const ndcX = cx * invW;
                const ndcY = cy * invW;

                screenX[i] = (ndcX + 1.0) * halfW;
                screenY[i] = (1.0 - ndcY) * halfH; // Flip Y for screen coords
                screenZ[i] = cw; // Store positive depth along viewing axis
                isVisible[i] = 1;
            } else {
                isVisible[i] = 0;
            }
        }

        // 4. Rasterize Triangles
        const triCount = Math.floor(mesh.indices.length / 3);

        for (let t = 0; t < triCount; t++) {
            const i0 = mesh.indices[t * 3];
            const i1 = mesh.indices[t * 3 + 1];
            const i2 = mesh.indices[t * 3 + 2];

            if (!isVisible[i0] || !isVisible[i1] || !isVisible[i2]) continue;

            const x0 = screenX[i0]; const y0 = screenY[i0]; const z0 = screenZ[i0];
            const x1 = screenX[i1]; const y1 = screenY[i1]; const z1 = screenZ[i1];
            const x2 = screenX[i2]; const y2 = screenY[i2]; const z2 = screenZ[i2];

            // 2D Signed Area (cross product for backface culling)
            const area = (x1 - x0) * (y2 - y0) - (y1 - y0) * (x2 - x0);
            if (area <= 0) continue; // Back-face or degenerate

            const invArea = 1.0 / area;

            // Triangle 2D Bounding Box
            const minX = Math.max(0, Math.floor(Math.min(x0, x1, x2)));
            const maxX = Math.min(width - 1, Math.ceil(Math.max(x0, x1, x2)));
            const minY = Math.max(0, Math.floor(Math.min(y0, y1, y2)));
            const maxY = Math.min(height - 1, Math.ceil(Math.max(y0, y1, y2)));

            for (let py = minY; py <= maxY; py++) {
                const rowOffset = py * width;
                for (let px = minX; px <= maxX; px++) {
                    // Barycentric coordinates
                    const w0 = ((x1 - px) * (y2 - py) - (y1 - py) * (x2 - px)) * invArea;
                    const w1 = ((x2 - px) * (y0 - py) - (y2 - py) * (x0 - px)) * invArea;
                    const w2 = 1.0 - w0 - w1;

                    if (w0 >= 0 && w1 >= 0 && w2 >= 0) {
                        const depth = w0 * z0 + w1 * z1 + w2 * z2;
                        const idx = rowOffset + px;

                        if (depth < depthBuffer[idx]) {
                            depthBuffer[idx] = depth;
                            silhouetteBuffer[idx] = 255;
                        }
                    }
                }
            }
        }

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

        for (const mesh of gltf.meshes || []) {
            for (const prim of mesh.primitives || []) {
                if (prim.attributes && prim.attributes.POSITION !== undefined) {
                    const posAcc = gltf.accessors[prim.attributes.POSITION];
                    const posView = gltf.bufferViews[posAcc.bufferView];
                    const byteOffset = (posView.byteOffset || 0) + (posAcc.byteOffset || 0);
                    const count = posAcc.count;
                    const positions = new Float32Array(
                        binBuffer.buffer,
                        binBuffer.byteOffset + byteOffset,
                        count * 3
                    );

                    for (let i = 0; i < positions.length; i++) {
                        allVertices.push(positions[i]);
                    }

                    if (prim.indices !== undefined) {
                        const indAcc = gltf.accessors[prim.indices];
                        const indView = gltf.bufferViews[indAcc.bufferView];
                        const indByteOffset = (indView.byteOffset || 0) + (indAcc.byteOffset || 0);
                        const indCount = indAcc.count;

                        if (indAcc.componentType === 5123) { // UNSIGNED_SHORT
                            const indices = new Uint16Array(
                                binBuffer.buffer,
                                binBuffer.byteOffset + indByteOffset,
                                indCount
                            );
                            for (let i = 0; i < indices.length; i++) {
                                allIndices.push(indices[i] + vertexOffset);
                            }
                        } else if (indAcc.componentType === 5125) { // UNSIGNED_INT
                            const indices = new Uint32Array(
                                binBuffer.buffer,
                                binBuffer.byteOffset + indByteOffset,
                                indCount
                            );
                            for (let i = 0; i < indices.length; i++) {
                                allIndices.push(indices[i] + vertexOffset);
                            }
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
                for (let k = 0; k < 4; k++) {
                    sum += V[i * 4 + k] * P[k * 4 + j];
                }
                VP[i * 4 + j] = sum;
            }
        }

        const vertCount = (mesh.vertices.length / 3) | 0;
        const screenX = new Float32Array(vertCount);
        const screenY = new Float32Array(vertCount);
        const screenZ = new Float32Array(vertCount);
        const isVisible = new Uint8Array(vertCount);

        for (let i = 0; i < vertCount; i++) {
            const vx = mesh.vertices[i * 3];
            const vy = mesh.vertices[i * 3 + 1];
            const vz = mesh.vertices[i * 3 + 2];

            const cx = vx * VP[0] + vy * VP[4] + vz * VP[8] + VP[12];
            const cy = vx * VP[1] + vy * VP[5] + vz * VP[9] + VP[13];
            const cz = vx * VP[2] + vy * VP[6] + vz * VP[10] + VP[14];
            const cw = vx * VP[3] + vy * VP[7] + vz * VP[11] + VP[15];

            if (cw > 0.01) {
                const invW = 1.0 / cw;
                const ndcX = cx * invW;
                const ndcY = cy * invW;
                screenX[i] = (ndcX * 0.5 + 0.5) * width;
                screenY[i] = (1.0 - (ndcY * 0.5 + 0.5)) * height;
                screenZ[i] = cw;
                if (ndcX >= -1.2 && ndcX <= 1.2 && ndcY >= -1.2 && ndcY <= 1.2) {
                    isVisible[i] = 1;
                }
            }
        }

        const triCount = (mesh.indices.length / 3) | 0;
        for (let t = 0; t < triCount; t++) {
            const i0 = mesh.indices[t * 3];
            const i1 = mesh.indices[t * 3 + 1];
            const i2 = mesh.indices[t * 3 + 2];

            if (!isVisible[i0] || !isVisible[i1] || !isVisible[i2]) continue;

            const x0 = screenX[i0], y0 = screenY[i0], z0 = screenZ[i0];
            const x1 = screenX[i1], y1 = screenY[i1], z1 = screenZ[i1];
            const x2 = screenX[i2], y2 = screenY[i2], z2 = screenZ[i2];

            const area = (x1 - x0) * (y2 - y0) - (y1 - y0) * (x2 - x0);
            if (area <= 0) continue; // Back-face or degenerate

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

            const dot = nx * lx + ny * ly + nz * lz;
            const diffuse = Math.max(0, dot);
            const ambient = 0.35;
            const intensity = Math.min(1.0, ambient + 0.65 * diffuse);

            const rCol = Math.min(255, Math.max(0, Math.round(baseColor[0] * intensity)));
            const gCol = Math.min(255, Math.max(0, Math.round(baseColor[1] * intensity)));
            const bCol = Math.min(255, Math.max(0, Math.round(baseColor[2] * intensity)));

            const minX = Math.max(0, Math.floor(Math.min(x0, x1, x2)));
            const maxX = Math.min(width - 1, Math.ceil(Math.max(x0, x1, x2)));
            const minY = Math.max(0, Math.floor(Math.min(y0, y1, y2)));
            const maxY = Math.min(height - 1, Math.ceil(Math.max(y0, y1, y2)));

            const invArea = 1.0 / area;
            for (let py = minY; py <= maxY; py++) {
                const pyOffset = py * width;
                for (let px = minX; px <= maxX; px++) {
                    const w0 = (x1 - px) * (y2 - py) - (y1 - py) * (x2 - px);
                    const w1 = (x2 - px) * (y0 - py) - (y2 - py) * (x0 - px);
                    const w2 = (x0 - px) * (y1 - py) - (y0 - py) * (x1 - px);

                    if (w0 >= 0 && w1 >= 0 && w2 >= 0) {
                        const b0 = w0 * invArea;
                        const b1 = w1 * invArea;
                        const b2 = w2 * invArea;
                        const z = b0 * z0 + b1 * z1 + b2 * z2;
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
        }

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

