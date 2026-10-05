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

/**
 * 5x8 bitmap font glyph definitions for high-contrast test screenshot text rendering.
 */
const FONT_5X8: Record<string, number[]> = {
    ' ': [0, 0, 0, 0, 0],
    '!': [0, 0, 0x5f, 0, 0],
    '"': [0, 0x07, 0, 0x07, 0],
    '#': [0x14, 0x7f, 0x14, 0x7f, 0x14],
    '$': [0x24, 0x2a, 0x7f, 0x2a, 0x12],
    '%': [0x23, 0x13, 0x08, 0x64, 0x62],
    '&': [0x36, 0x49, 0x55, 0x22, 0x50],
    "'": [0, 0x05, 0x03, 0, 0],
    '(': [0, 0x1c, 0x22, 0x41, 0],
    ')': [0, 0x41, 0x22, 0x1c, 0],
    '*': [0x14, 0x08, 0x3e, 0x08, 0x14],
    '+': [0x08, 0x08, 0x3e, 0x08, 0x08],
    ',': [0, 0x50, 0x30, 0, 0],
    '-': [0x08, 0x08, 0x08, 0x08, 0x08],
    '.': [0, 0x60, 0x60, 0, 0],
    '/': [0x20, 0x10, 0x08, 0x04, 0x02],
    '0': [0x3e, 0x51, 0x49, 0x45, 0x3e],
    '1': [0, 0x42, 0x7f, 0x40, 0],
    '2': [0x42, 0x61, 0x51, 0x49, 0x46],
    '3': [0x21, 0x41, 0x45, 0x4b, 0x31],
    '4': [0x18, 0x14, 0x12, 0x7f, 0x10],
    '5': [0x27, 0x45, 0x45, 0x45, 0x39],
    '6': [0x3c, 0x4a, 0x49, 0x49, 0x30],
    '7': [0x01, 0x71, 0x09, 0x05, 0x03],
    '8': [0x36, 0x49, 0x49, 0x49, 0x36],
    '9': [0x06, 0x49, 0x49, 0x29, 0x1e],
    ':': [0, 0x36, 0x36, 0, 0],
    ';': [0, 0x56, 0x36, 0, 0],
    '<': [0x08, 0x14, 0x22, 0x41, 0],
    '=': [0x14, 0x14, 0x14, 0x14, 0x14],
    '>': [0x41, 0x22, 0x14, 0x08, 0],
    '?': [0x02, 0x01, 0x51, 0x09, 0x06],
    '@': [0x32, 0x49, 0x79, 0x41, 0x3e],
    'A': [0x7e, 0x11, 0x11, 0x11, 0x7e],
    'B': [0x7f, 0x49, 0x49, 0x49, 0x36],
    'C': [0x3e, 0x41, 0x41, 0x41, 0x22],
    'D': [0x7f, 0x41, 0x41, 0x22, 0x1c],
    'E': [0x7f, 0x49, 0x49, 0x49, 0x41],
    'F': [0x7f, 0x09, 0x09, 0x09, 0x01],
    'G': [0x3e, 0x41, 0x49, 0x49, 0x7a],
    'H': [0x7f, 0x08, 0x08, 0x08, 0x7f],
    'I': [0, 0x41, 0x7f, 0x41, 0],
    'J': [0x20, 0x40, 0x41, 0x3f, 0x01],
    'K': [0x7f, 0x08, 0x14, 0x22, 0x41],
    'L': [0x7f, 0x40, 0x40, 0x40, 0x40],
    'M': [0x7f, 0x02, 0x0c, 0x02, 0x7f],
    'N': [0x7f, 0x04, 0x08, 0x10, 0x7f],
    'O': [0x3e, 0x41, 0x41, 0x41, 0x3e],
    'P': [0x7f, 0x09, 0x09, 0x09, 0x06],
    'Q': [0x3e, 0x41, 0x51, 0x21, 0x5e],
    'R': [0x7f, 0x09, 0x19, 0x29, 0x46],
    'S': [0x46, 0x49, 0x49, 0x49, 0x31],
    'T': [0x01, 0x01, 0x7f, 0x01, 0x01],
    'U': [0x3f, 0x40, 0x40, 0x40, 0x3f],
    'V': [0x1f, 0x20, 0x40, 0x20, 0x1f],
    'W': [0x3f, 0x40, 0x38, 0x40, 0x3f],
    'X': [0x63, 0x14, 0x08, 0x14, 0x63],
    'Y': [0x07, 0x08, 0x70, 0x08, 0x07],
    'Z': [0x61, 0x51, 0x49, 0x45, 0x43],
    '[': [0, 0x7f, 0x41, 0x41, 0],
    '\\': [0x02, 0x04, 0x08, 0x10, 0x20],
    ']': [0, 0x41, 0x41, 0x7f, 0],
    '^': [0x04, 0x02, 0x01, 0x02, 0x04],
    '_': [0x40, 0x40, 0x40, 0x40, 0x40],
    '`': [0, 0x01, 0x02, 0x04, 0],
    'a': [0x20, 0x54, 0x54, 0x54, 0x78],
    'b': [0x7f, 0x48, 0x44, 0x44, 0x38],
    'c': [0x38, 0x44, 0x44, 0x44, 0x20],
    'd': [0x38, 0x44, 0x44, 0x48, 0x7f],
    'e': [0x38, 0x54, 0x54, 0x54, 0x18],
    'f': [0x08, 0x7e, 0x09, 0x01, 0x02],
    'g': [0x0c, 0x52, 0x52, 0x52, 0x3e],
    'h': [0x7f, 0x08, 0x04, 0x04, 0x78],
    'i': [0, 0x44, 0x7d, 0x40, 0],
    'j': [0x20, 0x40, 0x44, 0x3d, 0],
    'k': [0x7f, 0x10, 0x28, 0x44, 0],
    'l': [0, 0x41, 0x7f, 0x40, 0],
    'm': [0x7c, 0x04, 0x18, 0x04, 0x78],
    'n': [0x7c, 0x08, 0x04, 0x04, 0x78],
    'o': [0x38, 0x44, 0x44, 0x44, 0x38],
    'p': [0x7c, 0x14, 0x14, 0x14, 0x08],
    'q': [0x08, 0x14, 0x14, 0x18, 0x7c],
    'r': [0x7c, 0x08, 0x04, 0x04, 0x08],
    's': [0x48, 0x54, 0x54, 0x54, 0x20],
    't': [0x04, 0x3f, 0x44, 0x40, 0x20],
    'u': [0x3c, 0x40, 0x40, 0x20, 0x7c],
    'v': [0x1c, 0x20, 0x40, 0x20, 0x1c],
    'w': [0x3c, 0x40, 0x30, 0x40, 0x3c],
    'x': [0x44, 0x28, 0x10, 0x28, 0x44],
    'y': [0x0c, 0x50, 0x50, 0x50, 0x3c],
    'z': [0x44, 0x64, 0x54, 0x4c, 0x44],
    '{': [0, 0x08, 0x36, 0x41, 0],
    '|': [0, 0, 0x7f, 0, 0],
    '}': [0, 0x41, 0x36, 0x08, 0],
    '~': [0x08, 0x04, 0x08, 0x10, 0x08]
};

/**
 * Renders structured Markdown chat response text into a high-contrast dark-mode visual screenshot.
 *
 * @returns Absolute file path to the saved screenshot.
 */
export function rasterizeChatMarkdownToScreenshot(
    testName: string,
    markdownText: string,
    options: TestScreenshotOptions = {}
): string {
    const width = options.width || 680;
    const height = options.height || 540;
    const rgba = Buffer.alloc(width * height * 4);

    // Studio canvas dark background (#0b0f17)
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const idx = (y * width + x) * 4;
            rgba[idx] = 11;
            rgba[idx + 1] = 15;
            rgba[idx + 2] = 23;
            rgba[idx + 3] = 255;
        }
    }

    // Draw card background (#151c28 with border)
    const cardMarginX = 24;
    const cardMarginY = 24;
    const cardW = width - cardMarginX * 2;
    const cardH = height - cardMarginY * 2;

    for (let y = cardMarginY; y < cardMarginY + cardH; y++) {
        for (let x = cardMarginX; x < cardMarginX + cardW; x++) {
            const idx = (y * width + x) * 4;
            const isBorder = (x === cardMarginX || x === cardMarginX + cardW - 1 || y === cardMarginY || y === cardMarginY + cardH - 1);
            if (isBorder) {
                rgba[idx] = 40; rgba[idx + 1] = 52; rgba[idx + 2] = 72; rgba[idx + 3] = 255;
            } else {
                rgba[idx] = 19; rgba[idx + 1] = 26; rgba[idx + 2] = 38; rgba[idx + 3] = 255;
            }
        }
    }

    // Helper to draw char
    const drawChar = (char: string, cx: number, cy: number, r: number, g: number, b: number, scale: number = 1) => {
        const glyph = FONT_5X8[char] || FONT_5X8['?'] || [0, 0, 0, 0, 0];
        for (let col = 0; col < 5; col++) {
            const byte = glyph[col];
            for (let row = 0; row < 8; row++) {
                if ((byte & (1 << row)) !== 0) {
                    for (let sy = 0; sy < scale; sy++) {
                        for (let sx = 0; sx < scale; sx++) {
                            const px = cx + col * scale + sx;
                            const py = cy + row * scale + sy;
                            if (px >= 0 && px < width && py >= 0 && py < height) {
                                const idx = (py * width + px) * 4;
                                rgba[idx] = r; rgba[idx + 1] = g; rgba[idx + 2] = b; rgba[idx + 3] = 255;
                            }
                        }
                    }
                }
            }
        }
    };

    const drawString = (str: string, sx: number, sy: number, r: number, g: number, b: number, scale: number = 1) => {
        let curX = sx;
        for (let i = 0; i < str.length; i++) {
            drawChar(str[i], curX, sy, r, g, b, scale);
            curX += (5 * scale + scale);
        }
    };

    // Header badge: 🪐 Studio AI • Adaptive Domain Synthesis
    drawString("SCRATCHBOX STUDIO AI  •  ADAPTIVE DOMAIN ARCHITECTURE", cardMarginX + 16, cardMarginY + 16, 56, 189, 248, 1);

    // Render markdown lines
    const rawLines = markdownText.split('\n');
    let curY = cardMarginY + 38;
    const maxLines = Math.min(rawLines.length, 32);

    for (let i = 0; i < maxLines && curY < height - cardMarginY - 20; i++) {
        const line = rawLines[i].trim();
        if (!line) {
            curY += 8;
            continue;
        }

        if (line.startsWith('# ')) {
            const heading = line.replace(/^#\s+/, '').slice(0, 48);
            drawString(heading, cardMarginX + 16, curY, 241, 245, 249, 2);
            curY += 22;
        } else if (line.startsWith('### ')) {
            const h3 = line.replace(/^###\s+/, '').slice(0, 60);
            drawString(h3, cardMarginX + 16, curY, 147, 197, 253, 1);
            curY += 14;
        } else if (line.startsWith('* ') || line.startsWith('- ')) {
            const bullet = line.slice(0, 80);
            drawString("•", cardMarginX + 16, curY, 56, 189, 248, 1);
            drawString(bullet.replace(/^[\*\-]\s+/, ''), cardMarginX + 28, curY, 203, 213, 225, 1);
            curY += 13;
        } else if (line.startsWith('|')) {
            const tableRow = line.slice(0, 84);
            drawString(tableRow, cardMarginX + 16, curY, 148, 163, 184, 1);
            curY += 12;
        } else {
            const textLine = line.slice(0, 84);
            drawString(textLine, cardMarginX + 16, curY, 226, 232, 240, 1);
            curY += 13;
        }
    }

    return saveTestScreenshot(testName, rgba, { ...options, width, height });
}

