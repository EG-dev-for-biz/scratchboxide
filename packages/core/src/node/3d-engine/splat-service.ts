/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as fs from 'fs';
import { decodeSpz } from '../../common/splat-spz-codec';
import * as path from 'path';
import * as zlib from 'zlib';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { NativeCppCompilerService } from './native-compiler-service';
import { BakedGaussian } from '../../common/geospatial-4d-protocol';
import { pruneSplatFloaters, type FloaterPruningOptions, type FloaterPruningReport } from '../../common/spatial/splat-floater-pruning';
import { buildNativeIfStale } from './native-build';
import { InvalidInputError, MissingInputError } from '../../common/errors/pipeline-errors';

const execFileAsync = promisify(execFile);

export interface SplatConversionOptions {
    inputPath?: string;
    outSplatPath?: string;
    outputSplatPath?: string;
    outSpzPath?: string;
    outputSpzPath?: string;
    outGlbPath?: string;
    outputGlbPath?: string;
    voxelSize?: number;
    voxelizeLeafSize?: number;
    synthetic?: boolean;
    count?: number;
    syntheticCount?: number;
}

export interface SplatPipelineResult {
    success: boolean;
    numSplats: number;
    splatCount?: number;
    splatBytes?: number;
    spzBytes?: number;
    glbBytes?: number;
    glbPath?: string;
    spzPath?: string;
    splatPath?: string;
    bounds?: {
        min: [number, number, number];
        max: [number, number, number];
    };
    centroid?: [number, number, number];
    error?: string;
}

export interface SplatPoint {
    position: [number, number, number];
    scale: [number, number, number];
    colorRgb: [number, number, number];
    opacity: number;
    quaternion?: [number, number, number, number];
}

function findRepoRoot(startDir: string = process.cwd()): string {
    let cur = startDir;
    while (cur !== path.dirname(cur)) {
        if (fs.existsSync(path.join(cur, 'scripts/run_splat_pipeline.cpp'))) {
            return cur;
        }
        cur = path.dirname(cur);
    }
    let fromDirname = __dirname;
    while (fromDirname !== path.dirname(fromDirname)) {
        if (fs.existsSync(path.join(fromDirname, 'scripts/run_splat_pipeline.cpp'))) {
            return fromDirname;
        }
        fromDirname = path.dirname(fromDirname);
    }
    return process.cwd();
}

export class SplatService {
    private binaryPath: string;
    private compilerService: NativeCppCompilerService;

    constructor(customBinaryPath?: string) {
        this.compilerService = new NativeCppCompilerService();
        if (customBinaryPath) {
            this.binaryPath = customBinaryPath;
        } else {
            const repoRoot = findRepoRoot();
            this.binaryPath = path.resolve(repoRoot, 'build/run_splat_pipeline');
        }
    }

    /**
     * Ensures native C++20 Gaussian Splatting CLI binary is compiled and up-to-date.
     */
    async ensureBinary(): Promise<string> {
        const sourcePath = path.resolve(findRepoRoot(), 'scripts/run_splat_pipeline.cpp');
        if (!fs.existsSync(sourcePath)) {
            throw new Error(`Splat CLI pipeline source not found at: ${sourcePath}`);
        }
        return buildNativeIfStale({ source: sourcePath, binary: this.binaryPath, includeDir: this.compilerService.getSdkIncludePath(), libs: ['-lz'] });
    }

    /**
     * Executes the native C++20 splat pipeline for converting between .splat, .spz, and .glb.
     */
    async runPipeline(options: SplatConversionOptions): Promise<SplatPipelineResult> {
        const bin = await this.ensureBinary();

        const args = ['--json'];

        const outSplat = options.outSplatPath || options.outputSplatPath;
        const outSpz = options.outSpzPath || options.outputSpzPath;
        const outGlb = options.outGlbPath || options.outputGlbPath;
        const voxelSize = options.voxelSize ?? options.voxelizeLeafSize;
        const count = options.count ?? options.syntheticCount;
        const isSynthetic = options.synthetic || (options.syntheticCount !== undefined && options.syntheticCount > 0);

        if (options.inputPath) {
            args.push('--input', options.inputPath);
        }
        if (outSplat) {
            args.push('--out-splat', outSplat);
        }
        if (outSpz) {
            args.push('--out-spz', outSpz);
        }
        if (outGlb) {
            args.push('--out-glb', outGlb);
        }
        if (voxelSize && voxelSize > 0) {
            args.push('--voxelize', String(voxelSize));
        }
        if (isSynthetic) {
            args.push('--synthetic');
        }
        if (count && count > 0) {
            args.push('--count', String(count));
        }

        try {
            const { stdout } = await execFileAsync(bin, args);
            const parsed = JSON.parse(stdout.trim()) as SplatPipelineResult;
            parsed.splatCount = parsed.numSplats;
            if (outGlb) parsed.glbPath = outGlb;
            if (outSpz) parsed.spzPath = outSpz;
            if (outSplat) parsed.splatPath = outSplat;
            return parsed;
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            return {
                success: false,
                numSplats: 0,
                splatCount: 0,
                error: message
            };
        }
    }

    /**
     * Parses standard 32-byte .splat binary buffer into BakedGaussian array.
     */
    static parseSplatBuffer(buffer: Buffer | ArrayBuffer): BakedGaussian[] {
        const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
        const BYTES_PER_SPLAT = 32;
        const count = Math.floor(buf.length / BYTES_PER_SPLAT);
        const splats: BakedGaussian[] = [];

        for (let i = 0; i < count; i++) {
            const offset = i * BYTES_PER_SPLAT;

            const px = buf.readFloatLE(offset);
            const py = buf.readFloatLE(offset + 4);
            const pz = buf.readFloatLE(offset + 8);

            const sx = buf.readFloatLE(offset + 12);
            const sy = buf.readFloatLE(offset + 16);
            const sz = buf.readFloatLE(offset + 20);

            const r = buf.readUInt8(offset + 24);
            const g = buf.readUInt8(offset + 25);
            const b = buf.readUInt8(offset + 26);
            const a = buf.readUInt8(offset + 27) / 255.0;

            const qx = (buf.readUInt8(offset + 28) / 255.0) * 2.0 - 1.0;
            const qy = (buf.readUInt8(offset + 29) / 255.0) * 2.0 - 1.0;
            const qz = (buf.readUInt8(offset + 30) / 255.0) * 2.0 - 1.0;
            const qw = (buf.readUInt8(offset + 31) / 255.0) * 2.0 - 1.0;

            splats.push({
                position: [px, py, pz],
                scale: [sx, sy, sz],
                colorRgb: [r, g, b],
                opacity: a,
                quaternion: [qx, qy, qz, qw]
            });
        }

        return splats;
    }

    /**
     * Encodes BakedGaussian array into standard 32-byte .splat binary buffer.
     */
    static serializeSplatBuffer(splats: BakedGaussian[]): Buffer {
        const BYTES_PER_SPLAT = 32;
        const buf = Buffer.alloc(splats.length * BYTES_PER_SPLAT);

        for (let i = 0; i < splats.length; i++) {
            const s = splats[i];
            const offset = i * BYTES_PER_SPLAT;

            buf.writeFloatLE(s.position[0], offset);
            buf.writeFloatLE(s.position[1], offset + 4);
            buf.writeFloatLE(s.position[2], offset + 8);

            buf.writeFloatLE(s.scale[0], offset + 12);
            buf.writeFloatLE(s.scale[1], offset + 16);
            buf.writeFloatLE(s.scale[2], offset + 20);

            const col = s.colorRgb || (s as any).color || [1.0, 1.0, 1.0];
            const r = col[0] <= 1.0 ? col[0] * 255.0 : col[0];
            const g = col[1] <= 1.0 ? col[1] * 255.0 : col[1];
            const b = col[2] <= 1.0 ? col[2] * 255.0 : col[2];

            buf.writeUInt8(Math.min(255, Math.max(0, Math.round(r))), offset + 24);
            buf.writeUInt8(Math.min(255, Math.max(0, Math.round(g))), offset + 25);
            buf.writeUInt8(Math.min(255, Math.max(0, Math.round(b))), offset + 26);
            buf.writeUInt8(Math.min(255, Math.max(0, Math.round(s.opacity * 255.0))), offset + 27);

            const q = s.quaternion || [0, 0, 0, 1];
            buf.writeUInt8(Math.min(255, Math.max(0, Math.round((q[0] * 0.5 + 0.5) * 255.0))), offset + 28);
            buf.writeUInt8(Math.min(255, Math.max(0, Math.round((q[1] * 0.5 + 0.5) * 255.0))), offset + 29);
            buf.writeUInt8(Math.min(255, Math.max(0, Math.round((q[2] * 0.5 + 0.5) * 255.0))), offset + 30);
            buf.writeUInt8(Math.min(255, Math.max(0, Math.round((q[3] * 0.5 + 0.5) * 255.0))), offset + 31);
        }

        return buf;
    }

    /** Niantic SPZ constants (nianticlabs/spz load-spz.cc): SH-DC colour scale and Y00 */
    private static readonly SPZ_COLOR_SCALE = 0.15;
    private static readonly SPZ_SH_C0 = 0.28209479177387814;

    /**
     * Parses .spz into BakedGaussian[]. Accepts:
     *  - Niantic SPZ v2/v3 header layout, SH degree 0..3 (higher SH bands are skipped)
     *  - the interim Scratchbox planar layout (NGSP header, 22 B/pt) written by earlier builds
     *  - legacy 'SPZ1' interleaved records
     */
    static parseSpzBuffer(buffer: Buffer | ArrayBuffer): BakedGaussian[] {
        let raw = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
        if (raw.length >= 2 && raw[0] === 0x1f && raw[1] === 0x8b) raw = zlib.gunzipSync(raw);
        const d = decodeSpz(new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength), { decodeSH: true });
        const shPer = d.sh ? d.sh.length / Math.max(1, d.count) : 0;
        const splats: BakedGaussian[] = [];
        for (let i = 0; i < d.count; i++) {
            const splat: BakedGaussian = {
                position: [d.positions[i * 3], d.positions[i * 3 + 1], d.positions[i * 3 + 2]],
                scale: [d.scales[i * 3], d.scales[i * 3 + 1], d.scales[i * 3 + 2]],
                quaternion: [d.quats[i * 4], d.quats[i * 4 + 1], d.quats[i * 4 + 2], d.quats[i * 4 + 3]],
                colorRgb: [Math.round(d.colors[i * 3] * 255), Math.round(d.colors[i * 3 + 1] * 255), Math.round(d.colors[i * 3 + 2] * 255)],
                opacity: d.opacities[i]
            };
            if (d.sh && shPer > 0) splat.sh = Array.from(d.sh.subarray(i * shPer, (i + 1) * shPer));
            splats.push(splat);
        }
        return splats;
    }

    /**
     * Encodes BakedGaussian[] as spec-exact Niantic SPZ v2 (SH degree 0..3), gzip-compressed.
     * Body layout (SoA): positions 24-bit fixed | alphas u8 | colors u8 (SH-DC) | scales u8 (log) | rotations u8 (xyz, w >= 0) | sh u8.
     */
    static serializeSpzBuffer(splats: BakedGaussian[], fractionalBits = 12, shDegree = 0): Buffer {
        const n = splats.length;
        const shDim = shDegree === 1 ? 3 : shDegree === 2 ? 8 : shDegree === 3 ? 15 : 0;
        const shCoeffsPerSplat = shDim * 3;
        const raw = Buffer.alloc(16 + n * 19 + n * shCoeffsPerSplat);
        raw.writeUInt32LE(0x5053474e, 0); // 'NGSP'
        raw.writeUInt32LE(2, 4);          // version 2 (first-three rotation encoding)
        raw.writeUInt32LE(n, 8);
        raw.writeUInt8(shDegree, 12);     // shDegree
        raw.writeUInt8(fractionalBits, 13);
        raw.writeUInt8(0, 14);            // flags
        raw.writeUInt8(0, 15);            // reserved

        const posOff = 16, alphaOff = posOff + 9 * n, colorOff = alphaOff + n, scaleOff = colorOff + 3 * n, rotOff = scaleOff + 3 * n, shOff = rotOff + 3 * n;
        const posScale = 1 << fractionalBits;
        const u8 = (x: number) => Math.min(255, Math.max(0, Math.round(x)));
        const cs = SplatService.SPZ_COLOR_SCALE, c0 = SplatService.SPZ_SH_C0;

        for (let i = 0; i < n; i++) {
            const s = splats[i];
            for (let k = 0; k < 3; k++) {
                let v = Math.round(s.position[k] * posScale);
                v = Math.min(8388607, Math.max(-8388608, v));
                const b = posOff + (i * 3 + k) * 3;
                raw[b] = v & 0xff; raw[b + 1] = (v >> 8) & 0xff; raw[b + 2] = (v >> 16) & 0xff;
            }
            raw[alphaOff + i] = u8(s.opacity * 255);
            const col = s.colorRgb || (s as any).color || [255, 255, 255];
            for (let k = 0; k < 3; k++) {
                const c = col[k] <= 1.0 ? col[k] : col[k] / 255;
                const shDc = (c - 0.5) / c0;
                raw[colorOff + i * 3 + k] = u8(shDc * (cs * 255) + 127.5);
            }
            for (let k = 0; k < 3; k++) {
                raw[scaleOff + i * 3 + k] = u8((Math.log(Math.max(s.scale[k], 1e-6)) + 10) * 16);
            }
            const q = s.quaternion || [0, 0, 0, 1];
            const qn = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
            const sign = (q[3] < 0 ? -127.5 : 127.5) / qn;
            raw[rotOff + i * 3] = u8(q[0] * sign + 127.5);
            raw[rotOff + i * 3 + 1] = u8(q[1] * sign + 127.5);
            raw[rotOff + i * 3 + 2] = u8(q[2] * sign + 127.5);

            if (shDegree > 0 && shCoeffsPerSplat > 0) {
                const sSh = s.sh || [];
                for (let c = 0; c < shCoeffsPerSplat; c++) {
                    const val = c < sSh.length ? sSh[c] : 0;
                    raw[shOff + i * shCoeffsPerSplat + c] = u8(val * 127.5 + 127.5);
                }
            }
        }
        return zlib.gzipSync(raw);
    }

    /**
     * Synthesizes oriented 3D Gaussian Splats from a DepthBox depth-ray field.
     * Evaluates local surface tangents, normal alignment quaternions, anisotropic scales,
     * and edge-adaptive severance.
     */
    static generateSplatsFromDepthRayField(params: {
        width: number;
        height: number;
        rgbPixels: Uint8Array | Buffer;
        channels?: number;
        metricDepths: Float32Array | number[];
        rayMap: Float32Array | number[];
        stride?: number;
        edgeSeveranceTau?: number;
        minDepth?: number;
        maxDepth?: number;
        /** kNN floater pruning after the bake (default on; false disables). */
        floaterPruning?: FloaterPruningOptions | false;
        onFloaterReport?: (report: FloaterPruningReport) => void;
    }): BakedGaussian[] {
        const {
            width: W,
            height: H,
            rgbPixels,
            channels = 3,
            metricDepths,
            rayMap,
            stride = 1,
            edgeSeveranceTau = 0.08,
            minDepth = 0.5,
            maxDepth = 200.0
        } = params;

        const splats: BakedGaussian[] = [];
        const sampleStep = Math.max(1, stride);

        for (let y = 0; y < H; y += sampleStep) {
            for (let x = 0; x < W; x += sampleStep) {
                const idx = y * W + x;
                const d = metricDepths[idx];
                if (d < minDepth || d > maxDepth || isNaN(d)) continue;

                const rx = rayMap[idx * 3 + 0];
                const ry = rayMap[idx * 3 + 1];
                const rz = rayMap[idx * 3 + 2];

                // Direct DepthBox unprojection: P = d * r
                const px = d * rx;
                const py = d * ry;
                const pz = d * rz;

                // Color extraction
                const cIdx = idx * channels;
                const r = rgbPixels[cIdx + 0];
                const g = rgbPixels[cIdx + 1];
                const b = rgbPixels[cIdx + 2];

                // Tangent frame & normal estimation via neighbors
                const xNext = Math.min(W - 1, x + sampleStep);
                const xPrev = Math.max(0, x - sampleStep);
                const yNext = Math.min(H - 1, y + sampleStep);
                const yPrev = Math.max(0, y - sampleStep);

                const dRight = metricDepths[y * W + xNext];
                const dLeft = metricDepths[y * W + xPrev];
                const dDown = metricDepths[yNext * W + x];
                const dUp = metricDepths[yPrev * W + x];

                // Relative depth step check for edge severance
                const deltaX = Math.abs(dRight - dLeft) / Math.max(1e-4, Math.max(dRight, dLeft));
                const deltaY = Math.abs(dDown - dUp) / Math.max(1e-4, Math.max(dDown, dUp));
                const isEdge = deltaX > edgeSeveranceTau || deltaY > edgeSeveranceTau;

                // Neighbor 3D positions
                const pR = [dRight * rayMap[(y * W + xNext) * 3 + 0], dRight * rayMap[(y * W + xNext) * 3 + 1], dRight * rayMap[(y * W + xNext) * 3 + 2]];
                const pL = [dLeft * rayMap[(y * W + xPrev) * 3 + 0], dLeft * rayMap[(y * W + xPrev) * 3 + 1], dLeft * rayMap[(y * W + xPrev) * 3 + 2]];
                const pD = [dDown * rayMap[(yNext * W + x) * 3 + 0], dDown * rayMap[(yNext * W + x) * 3 + 1], dDown * rayMap[(yNext * W + x) * 3 + 2]];
                const pU = [dUp * rayMap[(yPrev * W + x) * 3 + 0], dUp * rayMap[(yPrev * W + x) * 3 + 1], dUp * rayMap[(yPrev * W + x) * 3 + 2]];

                // Tangents: Tx = pR - pL, Ty = pD - pU
                const tx = [pR[0] - pL[0], pR[1] - pL[1], pR[2] - pL[2]];
                const ty = [pD[0] - pU[0], pD[1] - pU[1], pD[2] - pU[2]];

                const lenTx = Math.hypot(tx[0], tx[1], tx[2]);
                const lenTy = Math.hypot(ty[0], ty[1], ty[2]);

                // Normal = normalize(Tx x Ty)
                let nx = tx[1] * ty[2] - tx[2] * ty[1];
                let ny = tx[2] * ty[0] - tx[0] * ty[2];
                let nz = tx[0] * ty[1] - tx[1] * ty[0];
                const lenN = Math.hypot(nx, ny, nz);

                if (lenN > 1e-6) {
                    nx /= lenN;
                    ny /= lenN;
                    nz /= lenN;
                } else {
                    nx = -rx;
                    ny = -ry;
                    nz = -rz;
                }

                // Make sure normal points toward the camera (dot(N, ray) < 0)
                if (nx * rx + ny * ry + nz * rz > 0) {
                    nx = -nx;
                    ny = -ny;
                    nz = -nz;
                }

                // Quaternion from (0, 0, 1) to normal N
                let qx = 0, qy = 0, qz = 0, qw = 1;
                const dotZ = nz; // dot((0, 0, 1), (nx, ny, nz))
                if (dotZ >= 0.9999) {
                    qx = 0; qy = 0; qz = 0; qw = 1;
                } else if (dotZ <= -0.9999) {
                    qx = 0; qy = 1; qz = 0; qw = 0;
                } else {
                    const ax = -ny;
                    const ay = nx;
                    const az = 0;
                    const s = Math.sqrt((1.0 + dotZ) * 2.0);
                    const invs = 1.0 / s;
                    qx = ax * invs;
                    qy = ay * invs;
                    qz = az * invs;
                    qw = s * 0.5;
                    const qLen = Math.hypot(qx, qy, qz, qw);
                    qx /= qLen;
                    qy /= qLen;
                    qz /= qLen;
                    qw /= qLen;
                }

                // Anisotropic scale (surfel ellipsoid disk)
                const baseScale = (d / 500.0) * sampleStep * 1.8;
                const sx = Math.max(0.02, Math.min(5.0, lenTx > 1e-4 ? lenTx * 0.75 : baseScale));
                const sy = Math.max(0.02, Math.min(5.0, lenTy > 1e-4 ? lenTy * 0.75 : baseScale));
                const sz = Math.max(0.005, Math.min(sx, sy) * 0.2); // Flattened into surfel

                const opacity = isEdge ? 0.75 : 0.98;

                splats.push({
                    position: [px, py, pz],
                    scale: [sx, sy, sz],
                    colorRgb: [r, g, b],
                    opacity,
                    quaternion: [qx, qy, qz, qw]
                });
            }
        }

        return SplatService.applyFloaterPruning(splats, params.floaterPruning, params.onFloaterReport);
    }

    /**
     * kNN statistical floater pruning (see common/spatial/splat-floater-pruning). `false` skips it; the report gives the
     * count pruned.
     */
    static applyFloaterPruning<T extends { position: ArrayLike<number> }>(
        splats: T[],
        options: FloaterPruningOptions | false | undefined,
        onReport?: (report: FloaterPruningReport) => void
    ): T[] {
        if (options === false) return splats;
        const { splats: kept, report } = pruneSplatFloaters(splats, options ?? {});
        onReport?.(report);
        return kept;
    }

    /**
     * Spatial voxel grid decimation and deduplication.
     * Collapses duplicate / overlapping splats from multi-view captures or dense clouds
     * into an optimal representative splat per spatial voxel.
     */
    static decimateSplatsVoxelGrid(splats: SplatPoint[], voxelSize = 0.05): SplatPoint[] {
        if (!splats || splats.length === 0) return [];
        if (voxelSize <= 0) voxelSize = 0.05;

        const invVoxel = 1.0 / voxelSize;
        const grid = new Map<string, {
            sumPos: [number, number, number];
            sumColor: [number, number, number];
            sumScale: [number, number, number];
            sumWeight: number;
            count: number;
            quat: [number, number, number, number];
        }>();

        for (let i = 0; i < splats.length; i++) {
            const s = splats[i];
            const vx = Math.floor(s.position[0] * invVoxel);
            const vy = Math.floor(s.position[1] * invVoxel);
            const vz = Math.floor(s.position[2] * invVoxel);
            const key = `${vx}_${vy}_${vz}`;

            const weight = Math.max(0.01, s.opacity ?? 1.0);
            const existing = grid.get(key);

            if (!existing) {
                grid.set(key, {
                    sumPos: [s.position[0] * weight, s.position[1] * weight, s.position[2] * weight],
                    sumColor: [s.colorRgb[0] * weight, s.colorRgb[1] * weight, s.colorRgb[2] * weight],
                    sumScale: [s.scale[0] * weight, s.scale[1] * weight, s.scale[2] * weight],
                    sumWeight: weight,
                    count: 1,
                    quat: s.quaternion ? [s.quaternion[0], s.quaternion[1], s.quaternion[2], s.quaternion[3]] : [0, 0, 0, 1]
                });
            } else {
                existing.sumPos[0] += s.position[0] * weight;
                existing.sumPos[1] += s.position[1] * weight;
                existing.sumPos[2] += s.position[2] * weight;

                existing.sumColor[0] += s.colorRgb[0] * weight;
                existing.sumColor[1] += s.colorRgb[1] * weight;
                existing.sumColor[2] += s.colorRgb[2] * weight;

                existing.sumScale[0] += s.scale[0] * weight;
                existing.sumScale[1] += s.scale[1] * weight;
                existing.sumScale[2] += s.scale[2] * weight;

                existing.sumWeight += weight;
                existing.count++;
            }
        }

        const decimated: SplatPoint[] = [];
        grid.forEach((acc) => {
            if (acc.sumWeight <= 0) return;
            const invW = 1.0 / acc.sumWeight;
            const px = acc.sumPos[0] * invW;
            const py = acc.sumPos[1] * invW;
            const pz = acc.sumPos[2] * invW;

            const cr = Math.min(1.0, Math.max(0.0, acc.sumColor[0] * invW));
            const cg = Math.min(1.0, Math.max(0.0, acc.sumColor[1] * invW));
            const cb = Math.min(1.0, Math.max(0.0, acc.sumColor[2] * invW));

            const sx = Math.max(voxelSize * 0.5, acc.sumScale[0] * invW);
            const sy = Math.max(voxelSize * 0.5, acc.sumScale[1] * invW);
            const sz = Math.max(0.005, Math.min(sx, sy) * 0.2);

            const opacity = Math.min(1.0, Math.max(0.5, acc.sumWeight / acc.count));

            decimated.push({
                position: [px, py, pz],
                scale: [sx, sy, sz],
                colorRgb: [cr, cg, cb],
                opacity,
                quaternion: acc.quat
            });
        });

        return decimated;
    }

    /**
     * Adaptive Densification: splits oversized splats into two child splats along
     * the primary tangent axis to increase geometric fidelity in undersampled regions.
     */
    static densifySplats(splats: SplatPoint[], maxScale = 0.15): SplatPoint[] {
        if (!splats || splats.length === 0) return [];
        const result: SplatPoint[] = [];

        for (let i = 0; i < splats.length; i++) {
            const s = splats[i];
            const maxDim = Math.max(s.scale[0], s.scale[1]);

            if (maxDim > maxScale) {
                const [qx, qy, qz, qw] = s.quaternion || [0, 0, 0, 1];
                // Tangent vector along local X: R * (1, 0, 0)^T
                const tx = 1.0 - 2.0 * (qy * qy + qz * qz);
                const ty = 2.0 * (qx * qy + qw * qz);
                const tz = 2.0 * (qx * qz - qw * qy);
                const lenT = Math.hypot(tx, ty, tz) || 1.0;

                const offsetDist = maxDim * 0.35;
                const ox = (tx / lenT) * offsetDist;
                const oy = (ty / lenT) * offsetDist;
                const oz = (tz / lenT) * offsetDist;

                const childScale: [number, number, number] = [
                    s.scale[0] * 0.65,
                    s.scale[1] * 0.65,
                    s.scale[2]
                ];

                result.push({
                    position: [s.position[0] + ox, s.position[1] + oy, s.position[2] + oz],
                    scale: childScale,
                    colorRgb: [...s.colorRgb],
                    opacity: s.opacity,
                    quaternion: [...(s.quaternion || [0, 0, 0, 1])]
                });

                result.push({
                    position: [s.position[0] - ox, s.position[1] - oy, s.position[2] - oz],
                    scale: childScale,
                    colorRgb: [...s.colorRgb],
                    opacity: s.opacity,
                    quaternion: [...(s.quaternion || [0, 0, 0, 1])]
                });
            } else {
                result.push(s);
            }
        }

        return result;
    }

    /**
     * Fuses multi-view Gaussian splats (e.g. from camera orbiting or outpainting passes)
     * with spatial voxel grid deduplication and adaptive densification.
     */
    static fuseMultiViewSplats(
        splatViews: SplatPoint[][],
        options: {
            voxelSize?: number;
            densifyMaxScale?: number;
            /** kNN floater pruning after fusion (default on; false disables). */
            floaterPruning?: FloaterPruningOptions | false;
            onFloaterReport?: (report: FloaterPruningReport) => void;
        } = {}
    ): SplatPoint[] {
        if (!splatViews || splatViews.length === 0) return [];
        const flat: SplatPoint[] = [];
        for (const view of splatViews) {
            for (let i = 0; i < view.length; i++) {
                flat.push(view[i]);
            }
        }

        const voxelSize = options.voxelSize ?? 0.05;
        let fused = SplatService.decimateSplatsVoxelGrid(flat, voxelSize);

        if (options.densifyMaxScale && options.densifyMaxScale > 0) {
            fused = SplatService.densifySplats(fused, options.densifyMaxScale);
        }

        return SplatService.applyFloaterPruning(fused, options.floaterPruning, options.onFloaterReport);
    }

    /**
     * Physical thin-lens Circle of Confusion (CoC) calculation in meters.
     */
    static computeThinLensCoC(
        depth: number,
        focusDist: number,
        focalLengthMm: number,
        aperture: number
    ): number {
        const fMeters = focalLengthMm * 0.001;
        if (depth <= 0.001 || focusDist <= fMeters || aperture <= 0.1) return 0;
        const coc = Math.abs(
            ((fMeters * fMeters) / (aperture * (focusDist - fMeters))) *
            ((depth - focusDist) / depth)
        );
        return coc;
    }

    /**
     * ACES Filmic Tone Mapping (Narkowicz 2015 formulation)
     */
    static acesFilmicToneMap(rgb: [number, number, number]): [number, number, number] {
        const a = 2.51;
        const b = 0.03;
        const c = 2.43;
        const d = 0.59;
        const e = 0.14;
        const map = (x: number) => {
            const v = (x * (a * x + b)) / (x * (c * x + d) + e);
            return Math.min(1.0, Math.max(0.0, v));
        };
        return [map(rgb[0]), map(rgb[1]), map(rgb[2])];
    }

    /**
     * View-dependent Spherical Harmonics (Degree 1) radiance evaluation
     */
    static evaluateSH1Radiance(
        baseColor: [number, number, number],
        normal: [number, number, number],
        viewDir: [number, number, number],
        weight: number = 0.5
    ): [number, number, number] {
        const C1 = 0.4886025119029199;
        const dotNV = normal[0] * viewDir[0] + normal[1] * viewDir[1] + normal[2] * viewDir[2];
        const rx = 2 * dotNV * normal[0] - viewDir[0];
        const ry = 2 * dotNV * normal[1] - viewDir[1];
        const rz = 2 * dotNV * normal[2] - viewDir[2];

        const shY = C1 * ry;
        const shZ = C1 * rz;
        const shX = C1 * rx;

        const deltaR = (0.12 * shX + 0.18 * Math.max(0, shY)) * weight;
        const deltaG = (0.14 * shZ + 0.22 * Math.max(0, shY)) * weight;
        const deltaB = (0.20 * shX + 0.28 * Math.max(0, shY)) * weight;

        return [
            Math.min(1.0, Math.max(0.0, baseColor[0] + deltaR)),
            Math.min(1.0, Math.max(0.0, baseColor[1] + deltaG)),
            Math.min(1.0, Math.max(0.0, baseColor[2] + deltaB))
        ];
    }

    /**
     * Unprojects an equirectangular panoramic image (2:1 aspect ratio) into 360-degree Gaussian splats.
     * `depthMap` (width*height metres from the camera, which sits at the origin) is required: a pixel's distance is
     * not guessed. Pixels whose depth is not a positive finite number give no splat.
     */
    static unprojectEquirectangularPanorama(
        imageRgb: Uint8Array | Buffer,
        width: number,
        height: number,
        depthMap: Float32Array
    ): SplatPoint[] {
        if (!depthMap) {
            throw new MissingInputError('unprojectEquirectangularPanorama', 'a depth map', 'each pixel needs its distance from the camera; none is assumed');
        }
        if (depthMap.length !== width * height) {
            throw new InvalidInputError('unprojectEquirectangularPanorama', 'depthMap', `it has ${depthMap.length} values for a ${width}x${height} panorama (${width * height} needed)`);
        }
        const splats: SplatPoint[] = [];
        const step = Math.max(1, Math.floor(width / 360)); // Downsample to avoid excessive density

        for (let y = 0; y < height; y += step) {
            const v = y / (height - 1);
            const pitch = (0.5 - v) * Math.PI;
            const cosPitch = Math.cos(pitch);
            const sinPitch = Math.sin(pitch);

            for (let x = 0; x < width; x += step) {
                const u = x / width;
                const yaw = (u * 2.0 - 1.0) * Math.PI;
                const sinYaw = Math.sin(yaw);
                const cosYaw = Math.cos(yaw);

                const rx = sinYaw * cosPitch;
                const ry = sinPitch;
                const rz = -cosYaw * cosPitch;

                const idx = (y * width + x) * 3;
                const r = (imageRgb[idx] || 0) / 255.0;
                const g = (imageRgb[idx + 1] || 0) / 255.0;
                const b = (imageRgb[idx + 2] || 0) / 255.0;

                const depth = depthMap[y * width + x];
                if (!(depth > 0) || !Number.isFinite(depth)) continue;

                const px = rx * depth;
                const py = ry * depth;
                const pz = rz * depth;

                const baseScale = depth * 0.015 * step;

                splats.push({
                    position: [px, py, pz],
                    scale: [baseScale, baseScale, baseScale * 0.25],
                    colorRgb: [r, g, b],
                    opacity: 0.95,
                    quaternion: [0, 0, 0, 1]
                });
            }
        }

        return splats;
    }
}
export {
    ImageToSplatService,
    SingleImageConversionOptions,
    MultiViewConversionOptions,
    MultiViewImageInput,
    VideoTrajectoryType,
    VideoKeyframeInput,
    VideoKeyframeConversionOptions,
    PublicSourceItem,
    PublicSourceCatalog,
    BoxCollider3D,
    PhysicsColliderMesh,
    AtmospherePreset,
    AtmosphereEnvironment,
    EquirectangularConversionOptions,
    SpatialMeasurementResult
} from './image-to-splat-service';

export {
    GoogleSpatialInpaintingService,
    SpatialSceneDeconstruction,
    GroundPlaneSpecification,
    ForegroundSilhouetteSpecification,
    BoxColliderSpecification,
    OccludedBackgroundPrior
} from './google-spatial-inpainting-service';

