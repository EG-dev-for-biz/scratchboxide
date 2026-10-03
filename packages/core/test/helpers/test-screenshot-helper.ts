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
import { inspectGlbBuffer } from '../../src/node/3d-engine/photorealism-evaluator';

// =============================================================================
// Standalone Pure Node.js PNG Encoder (0 external dependencies)
// =============================================================================

const crcTable = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
        c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    crcTable[i] = c;
}

function crc32(buf: Buffer): number {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) {
        c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
}

function writePngChunk(type: string, data: Buffer): Buffer {
    const len = data.length;
    const buf = Buffer.alloc(12 + len);
    buf.writeUInt32BE(len, 0);
    buf.write(type, 4, 4, 'ascii');
    data.copy(buf, 8);
    const crc = crc32(buf.subarray(4, 8 + len));
    buf.writeUInt32BE(crc, 8 + len);
    return buf;
}

export function encodeRgbaToPng(width: number, height: number, rgbaBuffer: Buffer): Buffer {
    const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;
    ihdr[9] = 6; // RGBA
    ihdr[10] = 0;
    ihdr[11] = 0;
    ihdr[12] = 0;

    const rawScanlines = Buffer.alloc(height * (1 + width * 4));
    for (let y = 0; y < height; y++) {
        const rowOffset = y * (1 + width * 4);
        rawScanlines[rowOffset] = 0; // Filter: None
        rgbaBuffer.copy(rawScanlines, rowOffset + 1, y * width * 4, (y + 1) * width * 4);
    }

    const compressed = zlib.deflateSync(rawScanlines, { level: 6 });
    return Buffer.concat([
        signature,
        writePngChunk('IHDR', ihdr),
        writePngChunk('IDAT', compressed),
        writePngChunk('IEND', Buffer.alloc(0))
    ]);
}

export interface TestScreenshotOptions {
    /** Output directory. Defaults to <repo-root>/docs/screenshots */
    dir?: string;
    /** Image width when passing raw RGBA buffer or rasterizing GLB. Defaults to 512 */
    width?: number;
    /** Image height when passing raw RGBA buffer or rasterizing GLB. Defaults to 512 */
    height?: number;
}

/**
 * Resolves default screenshots directory (guaranteed to be .gitignored).
 */
export function getDefaultTestScreenshotDir(): string {
    // Traverse up to repository root
    let current = __dirname;
    while (current !== path.dirname(current)) {
        if (fs.existsSync(path.join(current, 'package.json')) && fs.existsSync(path.join(current, '.gitignore'))) {
            return path.join(current, 'docs', 'screenshots');
        }
        current = path.dirname(current);
    }
    return path.resolve(process.cwd(), 'docs', 'screenshots');
}

/**
 * Normalizes test name to safe filename.
 */
export function sanitizeScreenshotFilename(testName: string): string {
    return testName
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '_')
        .replace(/^_+|_+$/g, '') + '.png';
}

/**
 * Saves a screenshot of test results. Accepts PNG Buffers, base64 strings,
 * data URLs, or raw RGBA buffers.
 *
 * @returns Absolute file path to the saved screenshot.
 */
export function saveTestScreenshot(
    testName: string,
    source: Buffer | Uint8Array | string,
    options: TestScreenshotOptions = {}
): string {
    const targetDir = options.dir || getDefaultTestScreenshotDir();
    if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
    }

    const filename = sanitizeScreenshotFilename(testName);
    const outputPath = path.join(targetDir, filename);

    let pngBuffer: Buffer;

    if (typeof source === 'string') {
        const cleanBase64 = source.replace(/^data:image\/[a-z]+;base64,/, '').trim();
        pngBuffer = Buffer.from(cleanBase64, 'base64');
    } else if (source instanceof Buffer) {
        // Check if already a PNG
        if (source.length >= 8 && source[0] === 0x89 && source[1] === 0x50 && source[2] === 0x4e && source[3] === 0x47) {
            pngBuffer = source;
        } else if (options.width && options.height && source.length === options.width * options.height * 4) {
            pngBuffer = encodeRgbaToPng(options.width, options.height, source);
        } else {
            pngBuffer = source;
        }
    } else {
        const buf = Buffer.from(source);
        if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
            pngBuffer = buf;
        } else if (options.width && options.height && buf.length === options.width * options.height * 4) {
            pngBuffer = encodeRgbaToPng(options.width, options.height, buf);
        } else {
            pngBuffer = buf;
        }
    }

    fs.writeFileSync(outputPath, pngBuffer);
    if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size === 0) {
        throw new Error(`Failed to persist test screenshot to: ${outputPath}`);
    }

    return outputPath;
}

/**
 * Rasterizes a binary GLB model into a high-resolution 3D screenshot.
 * Extracts positions, vertex normals, and vertex colors, renders with directional
 * lighting, z-buffering, and crevice shading, and saves directly to the screenshot directory.
 *
 * @returns Absolute file path to the saved screenshot.
 */
export function rasterizeGlbToTestScreenshot(
    testName: string,
    glbBytes: Uint8Array,
    options: TestScreenshotOptions = {}
): string {
    const width = options.width || 512;
    const height = options.height || 512;
    const data = inspectGlbBuffer(glbBytes);

    const positions = data.positions;
    const normals = data.normals;
    const colors = data.colors;
    const indices = data.indices;

    const rgba = Buffer.alloc(width * height * 4);
    const zBuffer = new Float32Array(width * height);
    zBuffer.fill(-Infinity);

    // Default neutral studio background (dark slate gradient)
    for (let y = 0; y < height; y++) {
        const t = y / height;
        const bgR = Math.round(28 * (1 - t * 0.4));
        const bgG = Math.round(32 * (1 - t * 0.4));
        const bgB = Math.round(38 * (1 - t * 0.4));
        for (let x = 0; x < width; x++) {
            const idx = (y * width + x) * 4;
            rgba[idx] = bgR;
            rgba[idx + 1] = bgG;
            rgba[idx + 2] = bgB;
            rgba[idx + 3] = 255;
        }
    }

    if (positions.length < 9) {
        return saveTestScreenshot(testName, rgba, { ...options, width, height });
    }

    // Compute bounding box
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < positions.length; i += 3) {
        const x = positions[i];
        const y = positions[i + 1];
        const z = positions[i + 2];
        if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
            minX = Math.min(minX, x);
            minY = Math.min(minY, y);
            minZ = Math.min(minZ, z);
            maxX = Math.max(maxX, x);
            maxY = Math.max(maxY, y);
            maxZ = Math.max(maxZ, z);
        }
    }

    const cx = (minX + maxX) * 0.5;
    const cy = (minY + maxY) * 0.5;
    const cz = (minZ + maxZ) * 0.5;
    const extent = Math.max(maxX - minX, maxY - minY, maxZ - minZ, 0.001);
    const scale = (Math.min(width, height) * 0.38) / extent;

    // Isometric 3/4 camera orientation
    const yaw = Math.PI * 0.25;
    const pitch = Math.PI * 0.18;
    const cosY = Math.cos(yaw), sinY = Math.sin(yaw);
    const cosP = Math.cos(pitch), sinP = Math.sin(pitch);

    function projectVertex(x: number, y: number, z: number): { sx: number; sy: number; sz: number } {
        // Center
        const dx = x - cx;
        const dy = y - cy;
        const dz = z - cz;

        // Yaw around Y
        const rx = dx * cosY - dz * sinY;
        const rz = dx * sinY + dz * cosY;

        // Pitch around X
        const ry = dy * cosP - rz * sinP;
        const rz2 = dy * sinP + rz * cosP;

        const sx = width * 0.5 + rx * scale;
        const sy = height * 0.5 - ry * scale; // Y-flipped for screen coordinates
        const sz = rz2;
        return { sx, sy, sz };
    }

    // Light direction (key light from upper-right-front)
    const lx = 0.577, ly = 0.577, lz = 0.577;

    const triangleCount = indices ? indices.length / 3 : positions.length / 9;

    for (let t = 0; t < triangleCount; t++) {
        const i0 = indices ? indices[t * 3] : t * 3;
        const i1 = indices ? indices[t * 3 + 1] : t * 3 + 1;
        const i2 = indices ? indices[t * 3 + 2] : t * 3 + 2;

        const p0 = projectVertex(positions[i0 * 3], positions[i0 * 3 + 1], positions[i0 * 3 + 2]);
        const p1 = projectVertex(positions[i1 * 3], positions[i1 * 3 + 1], positions[i1 * 3 + 2]);
        const p2 = projectVertex(positions[i2 * 3], positions[i2 * 3 + 1], positions[i2 * 3 + 2]);

        // Triangle bounding box
        const minPx = Math.max(0, Math.floor(Math.min(p0.sx, p1.sx, p2.sx)));
        const maxPx = Math.min(width - 1, Math.ceil(Math.max(p0.sx, p1.sx, p2.sx)));
        const minPy = Math.max(0, Math.floor(Math.min(p0.sy, p1.sy, p2.sy)));
        const maxPy = Math.min(height - 1, Math.ceil(Math.max(p0.sy, p1.sy, p2.sy)));

        const denom = (p1.sy - p2.sy) * (p0.sx - p2.sx) + (p2.sx - p1.sx) * (p0.sy - p2.sy);
        if (Math.abs(denom) < 1e-6) continue;

        // Normal and color estimation
        let nx = 0, ny = 1, nz = 0;
        if (normals.length > i0 * 3 + 2) {
            nx = (normals[i0 * 3] + normals[i1 * 3] + normals[i2 * 3]) / 3;
            ny = (normals[i0 * 3 + 1] + normals[i1 * 3 + 1] + normals[i2 * 3 + 1]) / 3;
            nz = (normals[i0 * 3 + 2] + normals[i1 * 3 + 2] + normals[i2 * 3 + 2]) / 3;
            const nlen = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
            nx /= nlen; ny /= nlen; nz /= nlen;
        }

        let cr = 0.78, cg = 0.82, cb = 0.88;
        if (colors && colors.length > i0 * 4 + 2) {
            cr = (colors[i0 * 4] + colors[i1 * 4] + colors[i2 * 4]) / 3;
            cg = (colors[i0 * 4 + 1] + colors[i1 * 4 + 1] + colors[i2 * 4 + 1]) / 3;
            cb = (colors[i0 * 4 + 2] + colors[i1 * 4 + 2] + colors[i2 * 4 + 2]) / 3;
        }

        // Shading: Ambient + Diffuse Lambertian
        const ndotl = Math.max(0, nx * lx + ny * ly + nz * lz);
        const intensity = 0.25 + 0.75 * ndotl;
        const outR = Math.min(255, Math.round(cr * intensity * 255));
        const outG = Math.min(255, Math.round(cg * intensity * 255));
        const outB = Math.min(255, Math.round(cb * intensity * 255));

        for (let py = minPy; py <= maxPy; py++) {
            for (let px = minPx; px <= maxPx; px++) {
                const w0 = ((p1.sy - p2.sy) * (px - p2.sx) + (p2.sx - p1.sx) * (py - p2.sy)) / denom;
                const w1 = ((p2.sy - p0.sy) * (px - p2.sx) + (p0.sx - p2.sx) * (py - p2.sy)) / denom;
                const w2 = 1 - w0 - w1;

                if (w0 >= 0 && w1 >= 0 && w2 >= 0) {
                    const z = w0 * p0.sz + w1 * p1.sz + w2 * p2.sz;
                    const pixelIdx = py * width + px;
                    if (z > zBuffer[pixelIdx]) {
                        zBuffer[pixelIdx] = z;
                        const offset = pixelIdx * 4;
                        rgba[offset] = outR;
                        rgba[offset + 1] = outG;
                        rgba[offset + 2] = outB;
                        rgba[offset + 3] = 255;
                    }
                }
            }
        }
    }

    return saveTestScreenshot(testName, rgba, { ...options, width, height });
}
