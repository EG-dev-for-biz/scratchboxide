/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as zlib from 'zlib';

export interface DecodedImage {
    width: number;
    height: number;
    rgba: Buffer;
    data: Buffer;
}

export interface PbrBufferSet {
    albedoPng: Buffer;
    normalPng: Buffer;
    roughnessPng: Buffer;
    metallicPng: Buffer;
    aoPng: Buffer;
    ormPng: Buffer;
    heightPng?: Buffer;
}

export interface PbrDecompositionOptions {
    isMetallic?: boolean;
    bumpStrength?: number;
    featherRatio?: number;
}

// ============================================================================
// Zero-Dependency PNG Encoder / Decoder (RFC 2083 / RFC 1950)
// ============================================================================

function computeCrc32(buf: Buffer): number {
    const table: number[] = [];
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) {
            c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
        }
        table[n] = c >>> 0;
    }
    let crc = 0xffffffff;
    for (let i = 0; i < buf.length; i++) {
        crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function makePngChunk(type: string, data?: Buffer): Buffer {
    const len = data ? data.length : 0;
    const chunk = Buffer.alloc(8 + len + 4);
    chunk.writeUInt32BE(len, 0);
    chunk.write(type, 4, 4, 'ascii');
    if (data && len > 0) {
        data.copy(chunk, 8);
    }
    const typeAndData = Buffer.alloc(4 + len);
    typeAndData.write(type, 0, 4, 'ascii');
    if (data && len > 0) {
        data.copy(typeAndData, 4);
    }
    chunk.writeUInt32BE(computeCrc32(typeAndData), 8 + len);
    return chunk;
}

export function encodePng(width: number, height: number, rgba: Buffer): Buffer {
    const header = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;  // bit depth: 8
    ihdr[9] = 6;  // color type: RGBA
    ihdr[10] = 0; // compression: deflate
    ihdr[11] = 0; // filter: standard
    ihdr[12] = 0; // interlace: none

    const ihdrChunk = makePngChunk('IHDR', ihdr);

    const scanlineLen = width * 4;
    const uncompressed = Buffer.alloc(height * (1 + scanlineLen));
    let offset = 0;
    for (let y = 0; y < height; y++) {
        uncompressed[offset++] = 0; // Filter: none
        rgba.copy(uncompressed, offset, y * scanlineLen, (y + 1) * scanlineLen);
        offset += scanlineLen;
    }

    const compressed = zlib.deflateSync(uncompressed);
    const idatChunk = makePngChunk('IDAT', compressed);
    const iendChunk = makePngChunk('IEND');

    return Buffer.concat([header, ihdrChunk, idatChunk, iendChunk]);
}

export function decodePng(pngBuffer: Buffer): DecodedImage {
    // Check PNG signature
    if (pngBuffer.length < 8 || pngBuffer[0] !== 0x89 || pngBuffer[1] !== 0x50) {
        throw new Error('Invalid PNG signature');
    }

    let offset = 8;
    let width = 0;
    let height = 0;
    let bitDepth = 8;
    let colorType = 6;
    const idatChunks: Buffer[] = [];

    while (offset < pngBuffer.length) {
        const length = pngBuffer.readUInt32BE(offset);
        const type = pngBuffer.toString('ascii', offset + 4, offset + 8);
        const data = pngBuffer.subarray(offset + 8, offset + 8 + length);
        offset += 12 + length;

        if (type === 'IHDR') {
            width = data.readUInt32BE(0);
            height = data.readUInt32BE(4);
            bitDepth = data[8];
            colorType = data[9];
        } else if (type === 'IDAT') {
            idatChunks.push(data);
        } else if (type === 'IEND') {
            break;
        }
    }

    if (width <= 0 || height <= 0 || idatChunks.length === 0) {
        throw new Error('Corrupt or unsupported PNG');
    }

    const inflated = zlib.inflateSync(Buffer.concat(idatChunks));
    const rgba = Buffer.alloc(width * height * 4);
    const bytesPerPixel = (colorType === 6) ? 4 : (colorType === 2 ? 3 : 1);
    const scanlineLen = width * bytesPerPixel;

    let prevScanline = Buffer.alloc(scanlineLen);
    let currScanline = Buffer.alloc(scanlineLen);

    let inOffset = 0;
    for (let y = 0; y < height; y++) {
        const filterType = inflated[inOffset++];
        const raw = inflated.subarray(inOffset, inOffset + scanlineLen);
        inOffset += scanlineLen;

        for (let i = 0; i < scanlineLen; i++) {
            const left = i >= bytesPerPixel ? currScanline[i - bytesPerPixel] : 0;
            const up = prevScanline[i];
            const upLeft = i >= bytesPerPixel ? prevScanline[i - bytesPerPixel] : 0;

            let val = raw[i];
            switch (filterType) {
                case 0: // None
                    break;
                case 1: // Sub
                    val = (val + left) & 0xff;
                    break;
                case 2: // Up
                    val = (val + up) & 0xff;
                    break;
                case 3: // Average
                    val = (val + Math.floor((left + up) / 2)) & 0xff;
                    break;
                case 4: // Paeth
                    val = (val + paethPredictor(left, up, upLeft)) & 0xff;
                    break;
            }
            currScanline[i] = val;
        }

        for (let x = 0; x < width; x++) {
            const outIdx = (y * width + x) * 4;
            const inIdx = x * bytesPerPixel;
            if (bytesPerPixel >= 3) {
                rgba[outIdx] = currScanline[inIdx];
                rgba[outIdx + 1] = currScanline[inIdx + 1];
                rgba[outIdx + 2] = currScanline[inIdx + 2];
                rgba[outIdx + 3] = (bytesPerPixel === 4) ? currScanline[inIdx + 3] : 255;
            } else {
                const lum = currScanline[inIdx];
                rgba[outIdx] = lum;
                rgba[outIdx + 1] = lum;
                rgba[outIdx + 2] = lum;
                rgba[outIdx + 3] = 255;
            }
        }

        // Swap scanline buffers
        const tmp = prevScanline;
        prevScanline = currScanline;
        currScanline = tmp;
    }

    return { width, height, rgba, data: rgba };
}

function paethPredictor(a: number, b: number, c: number): number {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    if (pa <= pb && pa <= pc) return a;
    if (pb <= pc) return b;
    return c;
}

// ============================================================================
// Pillar 1: Toroidal Boundary Shift & Hermite Crossfade
// ============================================================================

export function makeToroidalSeamless(rgba: Buffer, width: number, height: number, featherRatio = 0.15): Buffer {
    const shifted = Buffer.alloc(width * height * 4);
    const halfW = Math.floor(width / 2);
    const halfH = Math.floor(height / 2);

    // 1. Shift
    for (let y = 0; y < height; y++) {
        const srcY = (y + halfH) % height;
        for (let x = 0; x < width; x++) {
            const srcX = (x + halfW) % width;
            const targetIdx = (y * width + x) * 4;
            const srcIdx = (srcY * width + srcX) * 4;
            shifted[targetIdx] = rgba[srcIdx];
            shifted[targetIdx + 1] = rgba[srcIdx + 1];
            shifted[targetIdx + 2] = rgba[srcIdx + 2];
            shifted[targetIdx + 3] = rgba[srcIdx + 3];
        }
    }

    // 2. Feather crosshairs
    const result = Buffer.from(shifted);
    const blendDistX = Math.max(2, Math.floor(width * featherRatio * 0.5));
    const blendDistY = Math.max(2, Math.floor(height * featherRatio * 0.5));

    for (let y = 0; y < height; y++) {
        const distY = Math.abs(y - halfH);
        let weightY = 1.0;
        if (distY < blendDistY) {
            const t = distY / blendDistY;
            weightY = t * t * (3.0 - 2.0 * t);
        }

        for (let x = 0; x < width; x++) {
            const distX = Math.abs(x - halfW);
            let weightX = 1.0;
            if (distX < blendDistX) {
                const t = distX / blendDistX;
                weightX = t * t * (3.0 - 2.0 * t);
            }

            const finalWeight = weightX * weightY;
            if (finalWeight < 0.999) {
                const idx = (y * width + x) * 4;
                for (let c = 0; c < 3; c++) {
                    const shiftedVal = shifted[idx + c];
                    const origVal = rgba[idx + c];
                    result[idx + c] = Math.round(shiftedVal * finalWeight + origVal * (1.0 - finalWeight));
                }
            }
        }
    }

    return result;
}

// ============================================================================
// Pillar 3: Algorithmic PBR Decomposition
// ============================================================================

export function decomposeRgbaToPbr(
    rgba: Buffer,
    width: number,
    height: number,
    options: PbrDecompositionOptions = {}
): PbrBufferSet {
    const isMetallic = options.isMetallic ?? false;
    const bumpStrength = options.bumpStrength ?? 3.5;
    const featherRatio = options.featherRatio ?? 0.15;

    const seamlessAlbedo = makeToroidalSeamless(rgba, width, height, featherRatio);

    const normal = Buffer.alloc(width * height * 4);
    const roughness = Buffer.alloc(width * height * 4);
    const metallic = Buffer.alloc(width * height * 4);
    const ao = Buffer.alloc(width * height * 4);

    const getLum = (x: number, y: number): number => {
        const px = ((x % width) + width) % width;
        const py = ((y % height) + height) % height;
        const idx = (py * width + px) * 4;
        return (0.2126 * seamlessAlbedo[idx] + 0.7152 * seamlessAlbedo[idx + 1] + 0.0722 * seamlessAlbedo[idx + 2]) / 255.0;
    };

    const metalByte = isMetallic ? 255 : 0;
    const baseRoughness = isMetallic ? 0.35 : 0.65;

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const idx = (y * width + x) * 4;

            // 1. Scharr / Sobel Normal
            const tl = getLum(x - 1, y - 1);
            const tc = getLum(x,     y - 1);
            const tr = getLum(x + 1, y - 1);
            const ml = getLum(x - 1, y);
            const mr = getLum(x + 1, y);
            const bl = getLum(x - 1, y + 1);
            const bc = getLum(x,     y + 1);
            const br = getLum(x + 1, y + 1);

            const dx = (tr + (10.0 / 3.0) * mr + br - (tl + (10.0 / 3.0) * ml + bl)) / 5.333;
            const dy = (bl + (10.0 / 3.0) * bc + br - (tl + (10.0 / 3.0) * tc + tr)) / 5.333;

            let nx = -dx * bumpStrength;
            let ny = -dy * bumpStrength;
            let nz = 1.0;
            const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1.0;
            nx /= len;
            ny /= len;
            nz /= len;

            normal[idx] = Math.round((nx * 0.5 + 0.5) * 255.0);
            normal[idx + 1] = Math.round((ny * 0.5 + 0.5) * 255.0);
            normal[idx + 2] = Math.round((nz * 0.5 + 0.5) * 255.0);
            normal[idx + 3] = 255;

            // 2. Roughness
            const centerLum = getLum(x, y);
            const neighborLum = (getLum(x - 1, y) + getLum(x + 1, y) + getLum(x, y - 1) + getLum(x, y + 1)) * 0.25;
            const variance = Math.abs(centerLum - neighborLum);
            const rough = Math.min(0.98, Math.max(0.08, baseRoughness + variance * 2.2));
            const roughByte = Math.round(rough * 255.0);

            roughness[idx] = roughByte;
            roughness[idx + 1] = roughByte;
            roughness[idx + 2] = roughByte;
            roughness[idx + 3] = 255;

            // 3. Metallic
            metallic[idx] = metalByte;
            metallic[idx + 1] = metalByte;
            metallic[idx + 2] = metalByte;
            metallic[idx + 3] = 255;

            // 4. Cavity AO
            const concavity = Math.max(0, neighborLum - centerLum);
            const aoVal = Math.min(1.0, Math.max(0.15, 1.0 - concavity * 4.8));
            const aoByte = Math.round(aoVal * 255.0);

            ao[idx] = aoByte;
            ao[idx + 1] = aoByte;
            ao[idx + 2] = aoByte;
            ao[idx + 3] = 255;
        }
    }

    const orm = packOrmBuffer(ao, roughness, metallic, width, height);

    return {
        albedoPng: encodePng(width, height, seamlessAlbedo),
        normalPng: encodePng(width, height, normal),
        roughnessPng: encodePng(width, height, roughness),
        metallicPng: encodePng(width, height, metallic),
        aoPng: encodePng(width, height, ao),
        ormPng: encodePng(width, height, orm)
    };
}

/**
 * Packs Ambient Occlusion (Red), Roughness (Green), and Metalness (Blue) into a single 4-channel
 * RGBA buffer conforming to glTF 2.0 / Three.js standard ORM texture layout.
 */
export function packOrmBuffer(
    ao: Buffer,
    roughness: Buffer,
    metallic: Buffer,
    width: number,
    height: number
): Buffer {
    const orm = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const idx = (y * width + x) * 4;
            orm[idx] = ao[idx] !== undefined ? ao[idx] : 255;
            orm[idx + 1] = roughness[idx + 1] !== undefined ? roughness[idx + 1] : (roughness[idx] ?? 128);
            orm[idx + 2] = metallic[idx + 2] !== undefined ? metallic[idx + 2] : (metallic[idx] ?? 0);
            orm[idx + 3] = 255;
        }
    }
    return orm;
}

/**
 * Universal ORM packing function that works seamlessly with Uint8Array or Buffer.
 */
export function packOrmData(
    ao: Uint8Array | Buffer,
    roughness: Uint8Array | Buffer,
    metallic: Uint8Array | Buffer,
    width: number,
    height: number
): Uint8Array {
    const orm = new Uint8Array(width * height * 4);
    for (let i = 0; i < width * height; i++) {
        const idx = i * 4;
        orm[idx] = ao[idx] !== undefined ? ao[idx] : 255;
        orm[idx + 1] = roughness[idx + 1] !== undefined ? roughness[idx + 1] : (roughness[idx] ?? 128);
        orm[idx + 2] = metallic[idx + 2] !== undefined ? metallic[idx + 2] : (metallic[idx] ?? 0);
        orm[idx + 3] = 255;
    }
    return orm;
}

/**
 * Decodes three separate PNG buffers (AO, Roughness, Metalness) and packages them into a single glTF ORM PNG.
 */
export function packOrmPng(aoPng: Buffer, roughnessPng: Buffer, metallicPng: Buffer): Buffer {
    const dAo = decodePng(aoPng);
    const dRough = decodePng(roughnessPng);
    const dMetal = decodePng(metallicPng);

    const w = dAo.width || dRough.width || dMetal.width;
    const h = dAo.height || dRough.height || dMetal.height;

    const orm = packOrmBuffer(dAo.rgba, dRough.rgba, dMetal.rgba, w, h);
    return encodePng(w, h, orm);
}

// ============================================================================
// Procedural Mathematical Noise Kernels (Headless TypeScript)
// ============================================================================

export interface WorleyResult {
    f1: number;
    f2: number;
    f2_minus_f1: number;
    cellX: number;
    cellY: number;
}

function hashInt(x: number): number {
    let h = (x ^ 0x45d9f3b) >>> 0;
    h = ((h >>> 16) ^ h) * 0x45d9f3b;
    h = ((h >>> 16) ^ h) * 0x45d9f3b;
    return ((h >>> 16) ^ h) >>> 0;
}

export function worley2D(x: number, y: number, jitter = 1.0, seed = 1337): WorleyResult {
    const xi = Math.floor(x);
    const yi = Math.floor(y);

    let d1 = 1e9;
    let d2 = 1e9;
    let closestX = xi;
    let closestY = yi;

    for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
            const cx = xi + dx;
            const cy = yi + dy;
            const h = hashInt((seed ^ (Math.imul(cx, 73856093) ^ Math.imul(cy, 19349663))) >>> 0);

            const fx = cx + ((h & 1023) / 1024.0) * jitter;
            const fy = cy + (((h >>> 10) & 1023) / 1024.0) * jitter;

            const distSq = (x - fx) * (x - fx) + (y - fy) * (y - fy);
            if (distSq < d1) {
                d2 = d1;
                d1 = distSq;
                closestX = cx;
                closestY = cy;
            } else if (distSq < d2) {
                d2 = distSq;
            }
        }
    }

    const f1 = Math.sqrt(d1);
    const f2 = Math.sqrt(d2);
    return {
        f1,
        f2,
        f2_minus_f1: Math.max(0, f2 - f1),
        cellX: closestX,
        cellY: closestY
    };
}

function grad2D(hashVal: number, x: number, y: number): number {
    const h = hashVal & 7;
    const u = h < 4 ? x : y;
    const v = h < 4 ? y : x;
    return ((h & 1) === 0 ? u : -u) + ((h & 2) === 0 ? v : -v);
}

function fade(t: number): number {
    return t * t * t * (t * (t * 6.0 - 15.0) + 10.0);
}

export function perlin2D(x: number, y: number, seed = 1337): number {
    const X = Math.floor(x) & 255;
    const Y = Math.floor(y) & 255;

    const xf = x - Math.floor(x);
    const yf = y - Math.floor(y);

    const u = fade(xf);
    const v = fade(yf);

    const h = (ix: number, iy: number) => hashInt(seed ^ (ix + iy * 57));

    const aa = h(X, Y);
    const ab = h(X, Y + 1);
    const ba = h(X + 1, Y);
    const bb = h(X + 1, Y + 1);

    const x1 = (1 - u) * grad2D(aa, xf, yf) + u * grad2D(ba, xf - 1, yf);
    const x2 = (1 - u) * grad2D(ab, xf, yf - 1) + u * grad2D(bb, xf - 1, yf - 1);

    return (1 - v) * x1 + v * x2;
}

export function fbm2D(x: number, y: number, octaves = 5, lacunarity = 2.0, gain = 0.5, seed = 1337): number {
    let sum = 0.0;
    let amp = 1.0;
    let freq = 1.0;
    let maxAmp = 0.0;

    for (let i = 0; i < octaves; i++) {
        sum += perlin2D(x * freq, y * freq, seed + i * 31) * amp;
        maxAmp += amp;
        amp *= gain;
        freq *= lacunarity;
    }

    return maxAmp > 0 ? sum / maxAmp : 0;
}

export function curlWarp2D(x: number, y: number, strength = 0.25, freq = 2.0, seed = 777): [number, number] {
    const dx = fbm2D(x * freq + 0.317, y * freq + 0.719, 4, 2.0, 0.5, seed) * strength;
    const dy = fbm2D(x * freq + 15.713, y * freq + 31.927, 4, 2.0, 0.5, seed + 99) * strength;
    return [x + dx, y + dy];
}

export function gaborAnisotropic2D(x: number, y: number, angleRad: number, freq = 16.0, bandwidth = 1.0): number {
    const cosA = Math.cos(angleRad);
    const sinA = Math.sin(angleRad);

    const u = x * cosA - y * sinA;
    const v = x * sinA + y * cosA;

    const carrier = Math.cos(2.0 * Math.PI * freq * v);
    const envelope = Math.exp(-Math.PI * (bandwidth * bandwidth * u * u + v * v * 0.1));
    return carrier * envelope;
}

export function blendNormalsRNM(
    n1: [number, number, number],
    n2: [number, number, number]
): [number, number, number] {
    const u: [number, number, number] = [n1[0], n1[1], n1[2] + 1.0];
    const t: [number, number, number] = [-n2[0], -n2[1], n2[2]];

    const uDotT = u[0] * t[0] + u[1] * t[1] + u[2] * t[2];
    const uz = Math.max(0.0001, u[2]);
    const factor = uDotT / uz;

    const rx = u[0] * factor - t[0];
    const ry = u[1] * factor - t[1];
    const rz = u[2] * factor - t[2];

    const len = Math.sqrt(rx * rx + ry * ry + rz * rz) || 1.0;
    return [rx / len, ry / len, rz / len];
}

// ============================================================================
// Procedural Material Archetype Synthesis (TypeScript Node / Offline)
// ============================================================================

export function synthesizeProceduralPbr(
    archetype: 'concrete' | 'brushed_metal' | 'marble' | 'wood' | 'hammered_copper' | 'chipped_paint',
    width = 256,
    height = 256,
    options: { wear?: number; seed?: number; color?: [number, number, number] } = {}
): PbrBufferSet {
    const seed = options.seed ?? 101;
    const albedo = Buffer.alloc(width * height * 4);
    const normal = Buffer.alloc(width * height * 4);
    const roughness = Buffer.alloc(width * height * 4);
    const metallic = Buffer.alloc(width * height * 4);
    const ao = Buffer.alloc(width * height * 4);
    const heightMap = Buffer.alloc(width * height * 4);

    const heightVals = new Float32Array(width * height);

    if (archetype === 'concrete') {
        const wear = options.wear ?? 0.45;
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const u = x / width;
                const v = y / height;
                const macro = fbm2D(u * 4.0, v * 4.0, 4, 2.0, 0.5, seed);
                const wPebbles = worley2D(u * 32.0, v * 32.0, 0.85, seed + 1);
                const pebble = Math.min(1.0, Math.max(0.0, (wPebbles.f1 - 0.15) / 0.3));
                const wCracks = worley2D(u * 12.0, v * 12.0, 0.95, seed + 2);
                const crack = Math.max(0, 1.0 - wCracks.f2_minus_f1 / (0.08 * wear));
                const grit = perlin2D(u * 128.0, v * 128.0, seed + 3) * 0.15;

                const hVal = Math.min(1.0, Math.max(0.0, 0.5 + macro * 0.15 + pebble * 0.12 - crack * 0.35 + grit));
                heightVals[y * width + x] = hVal;

                const idx = (y * width + x) * 4;
                const base = 0.61 * (0.85 + macro * 0.3);
                const col = Math.round(Math.min(255, Math.max(0, (base * (1.0 - crack) + 0.35 * crack) * 255)));
                albedo[idx] = col;
                albedo[idx + 1] = Math.round(col * 0.98);
                albedo[idx + 2] = Math.round(col * 0.94);
                albedo[idx + 3] = 255;

                metallic[idx] = 0;
                metallic[idx + 1] = 0;
                metallic[idx + 2] = 0;
                metallic[idx + 3] = 255;
            }
        }
    } else if (archetype === 'brushed_metal') {
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const u = x / width;
                const v = y / height;
                const scratch = gaborAnisotropic2D(u * 64.0, v * 64.0, 0.0, 32.0, 2.0);
                const hVal = Math.min(1.0, Math.max(0.0, 0.5 + scratch * 0.25));
                heightVals[y * width + x] = hVal;

                const idx = (y * width + x) * 4;
                const col = Math.round(Math.min(255, Math.max(0, (0.76 + scratch * 0.06) * 255)));
                albedo[idx] = col;
                albedo[idx + 1] = Math.round(col * 1.01);
                albedo[idx + 2] = Math.round(col * 1.08);
                albedo[idx + 3] = 255;

                metallic[idx] = 245;
                metallic[idx + 1] = 245;
                metallic[idx + 2] = 245;
                metallic[idx + 3] = 255;
            }
        }
    } else if (archetype === 'marble') {
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const u = x / width;
                const v = y / height;
                const [wu, wv] = curlWarp2D(u * 4.0, v * 4.0, 0.45, 2.5, seed);
                const vein = Math.abs(fbm2D(wu, wv, 5, 2.0, 0.5, seed));
                const veinMask = Math.max(0, Math.min(1.0, 1.0 - vein / 0.12));
                const hVal = Math.min(1.0, Math.max(0.0, 0.5 - veinMask * 0.08));
                heightVals[y * width + x] = hVal;

                const idx = (y * width + x) * 4;
                const r = Math.round((0.94 * (1.0 - veinMask) + 0.28 * veinMask) * 255);
                const g = Math.round((0.93 * (1.0 - veinMask) + 0.29 * veinMask) * 255);
                const b = Math.round((0.91 * (1.0 - veinMask) + 0.31 * veinMask) * 255);
                albedo[idx] = r;
                albedo[idx + 1] = g;
                albedo[idx + 2] = b;
                albedo[idx + 3] = 255;

                metallic[idx] = 5;
                metallic[idx + 1] = 5;
                metallic[idx + 2] = 5;
                metallic[idx + 3] = 255;
            }
        }
    } else if (archetype === 'wood') {
        const cx = width * 0.5;
        const cy = height * 0.5;
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const dx = (x - cx) / width;
                const dy = (y - cy) / height;
                const r = Math.sqrt(dx * dx + dy * dy);
                const warp = fbm2D(dx * 4.0, dy * 4.0, 4, 2.0, 0.5, seed) * 0.04;
                const ringVal = Math.sin((r + warp) * 14.0 * 2.0 * Math.PI) * 0.5 + 0.5;
                heightVals[y * width + x] = ringVal;

                const idx = (y * width + x) * 4;
                const red = Math.round((0.78 * (1.0 - ringVal) + 0.42 * ringVal) * 255);
                const grn = Math.round((0.58 * (1.0 - ringVal) + 0.26 * ringVal) * 255);
                const blu = Math.round((0.38 * (1.0 - ringVal) + 0.14 * ringVal) * 255);
                albedo[idx] = red;
                albedo[idx + 1] = grn;
                albedo[idx + 2] = blu;
                albedo[idx + 3] = 255;

                metallic[idx] = 0;
                metallic[idx + 1] = 0;
                metallic[idx + 2] = 0;
                metallic[idx + 3] = 255;
            }
        }
    } else if (archetype === 'hammered_copper') {
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const u = x / width;
                const v = y / height;
                const w = worley2D(u * 10.0, v * 10.0, 0.9, seed);
                const dimple = Math.max(0, 1.0 - w.f1 * 1.4);
                const sphereCap = Math.sqrt(Math.max(0, 1.0 - dimple * dimple));
                heightVals[y * width + x] = sphereCap;

                const cavity = Math.max(0, 1.0 - sphereCap * 1.5);
                const idx = (y * width + x) * 4;
                const red = Math.round((0.95 * (1.0 - cavity * 0.6) + 0.32 * cavity * 0.6) * 255);
                const grn = Math.round((0.64 * (1.0 - cavity * 0.6) + 0.68 * cavity * 0.6) * 255);
                const blu = Math.round((0.54 * (1.0 - cavity * 0.6) + 0.55 * cavity * 0.6) * 255);
                albedo[idx] = red;
                albedo[idx + 1] = grn;
                albedo[idx + 2] = blu;
                albedo[idx + 3] = 255;

                const m = Math.round(Math.max(0, 0.95 - cavity * 0.85) * 255);
                metallic[idx] = m;
                metallic[idx + 1] = m;
                metallic[idx + 2] = m;
                metallic[idx + 3] = 255;
            }
        }
    } else {
        // Chipped paint over rust
        const pCol = options.color ?? [0.12, 0.45, 0.85];
        const chip = options.wear ?? 0.4;
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const u = x / width;
                const v = y / height;
                const w = worley2D(u * 8.0, v * 8.0, 0.9, seed + 88);
                const fbmMod = fbm2D(u * 16.0, v * 16.0, 4, 2.0, 0.5, seed + 99) * 0.25;
                const paintMask = w.f1 > (chip + fbmMod) ? 1.0 : 0.0;
                heightVals[y * width + x] = paintMask * 0.75 + (1.0 - paintMask) * 0.5;

                const idx = (y * width + x) * 4;
                if (paintMask > 0.5) {
                    albedo[idx] = Math.round(pCol[0] * 255);
                    albedo[idx + 1] = Math.round(pCol[1] * 255);
                    albedo[idx + 2] = Math.round(pCol[2] * 255);
                    metallic[idx] = 0;
                    metallic[idx + 1] = 0;
                    metallic[idx + 2] = 0;
                } else {
                    albedo[idx] = 110;
                    albedo[idx + 1] = 55;
                    albedo[idx + 2] = 30;
                    metallic[idx] = 90;
                    metallic[idx + 1] = 90;
                    metallic[idx + 2] = 90;
                }
                albedo[idx + 3] = 255;
                metallic[idx + 3] = 255;
            }
        }
    }

    // Extract Normals, Roughness, and Cavity AO from heightVals
    const getH = (x: number, y: number): number => {
        const px = ((x % width) + width) % width;
        const py = ((y % height) + height) % height;
        return heightVals[py * width + px];
    };

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const idx = (y * width + x) * 4;
            const hC = getH(x, y);
            const hL = getH(x - 1, y);
            const hR = getH(x + 1, y);
            const hT = getH(x, y - 1);
            const hB = getH(x, y + 1);

            heightMap[idx] = Math.round(hC * 255);
            heightMap[idx + 1] = Math.round(hC * 255);
            heightMap[idx + 2] = Math.round(hC * 255);
            heightMap[idx + 3] = 255;

            // Scharr normal
            const dx = (getH(x + 1, y - 1) + 3.33 * hR + getH(x + 1, y + 1) - (getH(x - 1, y - 1) + 3.33 * hL + getH(x - 1, y + 1))) / 5.333;
            const dy = (getH(x - 1, y + 1) + 3.33 * hB + getH(x + 1, y + 1) - (getH(x - 1, y - 1) + 3.33 * hT + getH(x + 1, y - 1))) / 5.333;
            const strength = 3.0;
            let nx = -dx * strength;
            let ny = -dy * strength;
            let nz = 1.0;
            const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1.0;
            nx /= len;
            ny /= len;
            nz /= len;

            normal[idx] = Math.round((nx * 0.5 + 0.5) * 255);
            normal[idx + 1] = Math.round((ny * 0.5 + 0.5) * 255);
            normal[idx + 2] = Math.round((nz * 0.5 + 0.5) * 255);
            normal[idx + 3] = 255;

            // Curvature / variance roughness
            const avg = (hL + hR + hT + hB) * 0.25;
            const variance = Math.abs(hC - avg);
            const laplacian = 4.0 * hC - (hL + hR + hT + hB);
            const baseR = archetype === 'brushed_metal' ? 0.22 : (archetype === 'marble' ? 0.12 : (archetype === 'wood' ? 0.55 : 0.75));
            const vWeight = archetype === 'brushed_metal' ? 0.6 : 2.0;
            const rVal = Math.min(0.98, Math.max(0.04, baseR + variance * vWeight - Math.max(0, laplacian) * 0.2 + Math.max(0, -laplacian) * 0.3));
            const rByte = Math.round(rVal * 255);

            roughness[idx] = rByte;
            roughness[idx + 1] = rByte;
            roughness[idx + 2] = rByte;
            roughness[idx + 3] = 255;

            // Cavity AO
            const concavity = Math.max(0, avg - hC);
            const aoVal = Math.min(1.0, Math.max(0.2, 1.0 - concavity * 4.5));
            const aoByte = Math.round(aoVal * 255);

            ao[idx] = aoByte;
            ao[idx + 1] = aoByte;
            ao[idx + 2] = aoByte;
            ao[idx + 3] = 255;
        }
    }

    const orm = packOrmBuffer(ao, roughness, metallic, width, height);

    return {
        albedoPng: encodePng(width, height, albedo),
        normalPng: encodePng(width, height, normal),
        roughnessPng: encodePng(width, height, roughness),
        metallicPng: encodePng(width, height, metallic),
        aoPng: encodePng(width, height, ao),
        ormPng: encodePng(width, height, orm),
        heightPng: encodePng(width, height, heightMap)
    };
}

/**
 * Creates procedural high-frequency texture noise fallback when testing or offline.
 */
export function generateProceduralTextureBuffer(width = 256, height = 256, baseColor = [180, 150, 110]): Buffer {
    const buf = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const idx = (y * width + x) * 4;
            const fx = x / width;
            const fy = y / height;
            const noise = Math.sin(fx * 24.0) * Math.cos(fy * 24.0) * 20.0 +
                          Math.sin(fx * 48.0 + fy * 48.0) * 12.0;

            buf[idx] = Math.min(255, Math.max(0, Math.round(baseColor[0] + noise)));
            buf[idx + 1] = Math.min(255, Math.max(0, Math.round(baseColor[1] + noise)));
            buf[idx + 2] = Math.min(255, Math.max(0, Math.round(baseColor[2] + noise)));
            buf[idx + 3] = 255;
        }
    }
    return buf;
}

/**
 * Bilinearly resamples an RGBA buffer from (srcW, srcH) to (dstW, dstH).
 */
export function resampleRgba(
    src: Uint8Array | Buffer,
    srcW: number,
    srcH: number,
    dstW: number,
    dstH: number
): Buffer {
    if (srcW === dstW && srcH === dstH) {
        return Buffer.isBuffer(src) ? Buffer.from(src) : Buffer.from(src.buffer, src.byteOffset, src.byteLength);
    }
    const dst = Buffer.alloc(dstW * dstH * 4);
    for (let y = 0; y < dstH; y++) {
        const v = (y + 0.5) / dstH;
        const sy = Math.max(0, Math.min(srcH - 1, v * srcH - 0.5));
        const y0 = Math.floor(sy);
        const y1 = Math.min(srcH - 1, y0 + 1);
        const fy = sy - y0;
        const row0 = y0 * srcW * 4;
        const row1 = y1 * srcW * 4;
        const dstRow = y * dstW * 4;

        for (let x = 0; x < dstW; x++) {
            const u = (x + 0.5) / dstW;
            const sx = Math.max(0, Math.min(srcW - 1, u * srcW - 0.5));
            const x0 = Math.floor(sx);
            const x1 = Math.min(srcW - 1, x0 + 1);
            const fx = sx - x0;

            const w00 = (1 - fx) * (1 - fy);
            const w10 = fx * (1 - fy);
            const w01 = (1 - fx) * fy;
            const w11 = fx * fy;

            const i00 = row0 + x0 * 4;
            const i10 = row0 + x1 * 4;
            const i01 = row1 + x0 * 4;
            const i11 = row1 + x1 * 4;

            const di = dstRow + x * 4;
            dst[di] = Math.round(src[i00] * w00 + src[i10] * w10 + src[i01] * w01 + src[i11] * w11);
            dst[di + 1] = Math.round(src[i00 + 1] * w00 + src[i10 + 1] * w10 + src[i01 + 1] * w01 + src[i11 + 1] * w11);
            dst[di + 2] = Math.round(src[i00 + 2] * w00 + src[i10 + 2] * w10 + src[i01 + 2] * w01 + src[i11 + 2] * w11);
            dst[di + 3] = Math.round(src[i00 + 3] * w00 + src[i10 + 3] * w10 + src[i01 + 3] * w01 + src[i11 + 3] * w11);
        }
    }
    return dst;
}

// ============================================================================
// Universal Stone Albedo & Radiometric De-Lighting Calibrator
// ============================================================================

export type StoneAlbedoPreset =
    | 'sandstone'
    | 'travertine'
    | 'limestone'
    | 'granite'
    | 'terracotta'
    | 'marble'
    | 'concrete'
    | 'neutral'
    | 'asphalt'
    | 'brick';

export interface StoneAlbedoCalibrationOptions {
    stoneType?: StoneAlbedoPreset;
    shadowLift?: number;        // default 0.60 (lifts dark shadows/crevices)
    highlightCompress?: number; // default 0.45 (tames baked noon solar glare)
    hazeReduction?: number;     // default 0.50 (attenuates blue Rayleigh atmospheric wash)
    customTint?: [number, number, number];
}

const STONE_PROFILES: Record<StoneAlbedoPreset, { rScale: number; gScale: number; bScale: number; rOffset: number; bOffset: number }> = {
    sandstone: { rScale: 1.24, gScale: 0.98, bScale: 0.72, rOffset: 6, bOffset: -4 },
    travertine: { rScale: 1.15, gScale: 1.05, bScale: 0.85, rOffset: 6, bOffset: -6 },
    limestone: { rScale: 1.12, gScale: 1.08, bScale: 0.90, rOffset: 4, bOffset: -4 },
    marble: { rScale: 1.02, gScale: 1.02, bScale: 0.98, rOffset: 2, bOffset: 0 },
    granite: { rScale: 1.05, gScale: 1.02, bScale: 0.95, rOffset: 2, bOffset: -2 },
    terracotta: { rScale: 1.38, gScale: 0.82, bScale: 0.62, rOffset: 12, bOffset: -10 },
    brick: { rScale: 1.35, gScale: 0.85, bScale: 0.68, rOffset: 10, bOffset: -8 },
    concrete: { rScale: 1.02, gScale: 1.02, bScale: 0.96, rOffset: 0, bOffset: -2 },
    neutral: { rScale: 1.00, gScale: 1.00, bScale: 1.00, rOffset: 0, bOffset: 0 },
    asphalt: { rScale: 0.95, gScale: 0.95, bScale: 0.95, rOffset: 0, bOffset: 0 }
};

export function calibrateStoneAlbedoRgba(
    rgba: Buffer,
    width: number,
    height: number,
    options: StoneAlbedoCalibrationOptions = {}
): Buffer {
    const profile = options.stoneType ? (STONE_PROFILES[options.stoneType] || STONE_PROFILES.neutral) : STONE_PROFILES.neutral;
    const shadowLift = options.shadowLift ?? 0.60;
    const highlightCompress = options.highlightCompress ?? 0.45;
    const hazeReduction = options.hazeReduction ?? 0.50;

    const out = Buffer.alloc(width * height * 4);
    const numPixels = width * height;

    for (let i = 0; i < numPixels; i++) {
        const off = i * 4;
        const r = rgba[off];
        const g = rgba[off + 1];
        const b = rgba[off + 2];
        const a = rgba[off + 3];

        if (r + g + b > 15) {
            let rCal: number, gCal: number, bCal: number;

            if (options.customTint) {
                rCal = r * options.customTint[0];
                gCal = g * options.customTint[1];
                bCal = b * options.customTint[2];
            } else {
                rCal = r * profile.rScale + profile.rOffset;
                gCal = g * profile.gScale;
                // Atmospheric Rayleigh sky haze attenuation
                const hazeAtten = 1.0 - (0.35 * hazeReduction);
                bCal = (b * profile.bScale + profile.bOffset) * hazeAtten;
            }

            // Shadow lift in dark crevices
            const currentLum = 0.299 * rCal + 0.587 * gCal + 0.114 * bCal;
            if (currentLum < 65) {
                const liftFactor = 1.0 + (shadowLift * (1.0 - currentLum / 65) * 0.4);
                rCal *= liftFactor;
                gCal *= liftFactor;
                bCal *= liftFactor;
            }

            // Highlight compression for noon solar specular glare
            const postLum = 0.299 * rCal + 0.587 * gCal + 0.114 * bCal;
            if (postLum > 190) {
                const knee = 190;
                const comp = knee + (postLum - knee) * (1.0 - highlightCompress * 0.68);
                const scale = comp / Math.max(1, postLum);
                rCal *= scale;
                gCal *= scale;
                bCal *= scale;
            }

            out[off] = Math.max(0, Math.min(255, Math.round(rCal)));
            out[off + 1] = Math.max(0, Math.min(255, Math.round(gCal)));
            out[off + 2] = Math.max(0, Math.min(255, Math.round(bCal)));
            out[off + 3] = a;
        } else {
            out[off] = r;
            out[off + 1] = g;
            out[off + 2] = b;
            out[off + 3] = a;
        }
    }
    return out;
}

export function calibrateStoneAlbedoPng(
    pngBuffer: Buffer,
    options: StoneAlbedoCalibrationOptions = {}
): Buffer {
    const decoded = decodePng(pngBuffer);
    const calibrated = calibrateStoneAlbedoRgba(decoded.rgba, decoded.width, decoded.height, options);
    return encodePng(decoded.width, decoded.height, calibrated);
}

// ============================================================================
// Biophysical Humanoid PBR Synthesis (Skin & Nail Biophysics)
// ============================================================================

export interface BiophysicalSkinPbrOptions {
    melaninFraction?: number;   // 0.0 (pale) to 1.0 (deep complexion), default 0.35
    pheomelaninRatio?: number;  // 0.0 (eumelanin) to 1.0 (pheomelanin), default 0.20
    poreDensity?: number;       // Micro-pore spatial frequency (default 48.0)
    sulciScale?: number;        // Epidermal polygonal tile frequency (default 36.0)
    vascularity?: number;       // Subdermal capillary vascular mottling (default 0.35)
    roughnessBaseline?: number; // Keratin stratum corneum base roughness (default 0.48)
    normalStrength?: number;    // Tangent normal relief strength (default 2.4)
    seed?: number;
}

export interface BiophysicalNailPbrOptions {
    lunulaWidth?: number;       // Relative width/height of proximal crescent (default 0.22)
    bedPinkFlush?: number;      // Vascular nail bed pink capillary intensity (default 0.65)
    freeEdgeWidth?: number;     // Relative size of distal free edge (default 0.12)
    striationDensity?: number;  // Longitudinal anisotropic micro-ridges (default 64.0)
    roughnessBaseline?: number; // Hard alpha-keratin plate mirror gloss (default 0.14)
    normalStrength?: number;    // Anisotropic tangent normal strength (default 1.8)
    seed?: number;
}

/**
 * Synthesizes biophysical human skin PBR texture set (Albedo, Tangent Normal, ORM, Height).
 * Incorporates:
 * 1. Melanin spectral absorption curve + vascular capillary mottling
 * 2. Stratum corneum keratin sulci (polygonal Voronoi micro-grooves)
 * 3. Eccrine sweat pore micro-depressions
 * 4. Micro-cavity ambient occlusion and curvature-coupled roughness
 */
export function synthesizeBiophysicalSkinPbr(
    width = 512,
    height = 512,
    options: BiophysicalSkinPbrOptions = {}
): PbrBufferSet {
    const seed = options.seed ?? 1337;
    const melanin = Math.max(0.0, Math.min(1.0, options.melaninFraction ?? 0.35));
    const pheo = Math.max(0.0, Math.min(1.0, options.pheomelaninRatio ?? 0.20));
    const poreDensity = options.poreDensity ?? 48.0;
    const sulciScale = options.sulciScale ?? 36.0;
    const vascularity = options.vascularity ?? 0.35;
    const roughnessBaseline = options.roughnessBaseline ?? 0.48;
    const normalStrength = options.normalStrength ?? 2.4;

    // Base melanin albedo calculation
    const baseR = 0.82;
    const baseG = 0.62;
    const baseB = 0.52;
    const euAbs = [1.8, 3.2, 5.5];
    const phAbs = [0.8, 2.4, 6.2];
    const effAbsR = (1 - pheo) * euAbs[0] + pheo * phAbs[0];
    const effAbsG = (1 - pheo) * euAbs[1] + pheo * phAbs[1];
    const effAbsB = (1 - pheo) * euAbs[2] + pheo * phAbs[2];
    const skinAlbedoR = Math.max(0.02, Math.min(1.0, baseR * Math.exp(-melanin * effAbsR)));
    const skinAlbedoG = Math.max(0.015, Math.min(1.0, baseG * Math.exp(-melanin * effAbsG)));
    const skinAlbedoB = Math.max(0.01, Math.min(1.0, baseB * Math.exp(-melanin * effAbsB)));

    const albedo = Buffer.alloc(width * height * 4);
    const normal = Buffer.alloc(width * height * 4);
    const roughness = Buffer.alloc(width * height * 4);
    const metallic = Buffer.alloc(width * height * 4);
    const ao = Buffer.alloc(width * height * 4);
    const heightMap = Buffer.alloc(width * height * 4);
    const heightVals = new Float32Array(width * height);

    // Pass 1: Compute Heightfield and Albedo
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const u = x / width;
            const v = y / height;

            // 1. Epidermal sulci (polygonal keratin tiles)
            const wSulci = worley2D(u * sulciScale, v * sulciScale, 0.92, seed + 10);
            const sulciDepth = Math.pow(Math.min(1.0, Math.max(0.0, wSulci.f2_minus_f1 / 0.32)), 0.6);

            // 2. Eccrine sweat pores
            const wPore = worley2D(u * poreDensity, v * poreDensity, 0.85, seed + 20);
            const poreDepth = Math.pow(Math.max(0.0, 1.0 - wPore.f1 / 0.22), 2.0) * 0.25;

            // 3. Micro-grain (stratum corneum texture)
            const microGrain = perlin2D(u * 128.0, v * 128.0, seed + 30) * 0.035;

            // Composite micro-height
            const hVal = Math.min(1.0, Math.max(0.0, 0.5 + (sulciDepth - 0.5) * 0.18 - poreDepth + microGrain));
            heightVals[y * width + x] = hVal;

            // 4. Subdermal vascular mottling
            const vNoise = fbm2D(u * 12.0, v * 12.0, 3, 2.0, 0.5, seed + 40);
            const vCell = worley2D(u * 6.0, v * 6.0, 0.8, seed + 50).f2_minus_f1;
            const mottle = (vNoise * 0.6 + vCell * 0.4 - 0.3) * vascularity;

            // Vascular hemoglobin warm bleed
            const hemoR = 0.95;
            const hemoG = 0.22;
            const hemoB = 0.18;

            let colR = skinAlbedoR + mottle * (hemoR - skinAlbedoR);
            let colG = skinAlbedoG + mottle * 0.35 * (hemoG - skinAlbedoG);
            let colB = skinAlbedoB + mottle * 0.25 * (hemoB - skinAlbedoB);

            // Darken in pore bottoms and sulci crevices
            const poreDarken = 1.0 - poreDepth * 0.55;
            const sulciDarken = 0.92 + sulciDepth * 0.08;
            colR = Math.max(0.0, Math.min(1.0, colR * poreDarken * sulciDarken));
            colG = Math.max(0.0, Math.min(1.0, colG * poreDarken * sulciDarken));
            colB = Math.max(0.0, Math.min(1.0, colB * poreDarken * sulciDarken));

            const idx = (y * width + x) * 4;
            albedo[idx] = Math.round(colR * 255);
            albedo[idx + 1] = Math.round(colG * 255);
            albedo[idx + 2] = Math.round(colB * 255);
            albedo[idx + 3] = 255;

            metallic[idx] = 0;
            metallic[idx + 1] = 0;
            metallic[idx + 2] = 0;
            metallic[idx + 3] = 255;
        }
    }

    // Pass 2: Normal, Roughness, and Cavity AO via 3x3 Scharr Gradient
    const getH = (x: number, y: number): number => {
        const px = ((x % width) + width) % width;
        const py = ((y % height) + height) % height;
        return heightVals[py * width + px];
    };

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const idx = (y * width + x) * 4;
            const hC = getH(x, y);
            const hL = getH(x - 1, y);
            const hR = getH(x + 1, y);
            const hT = getH(x, y - 1);
            const hB = getH(x, y + 1);

            heightMap[idx] = Math.round(hC * 255);
            heightMap[idx + 1] = Math.round(hC * 255);
            heightMap[idx + 2] = Math.round(hC * 255);
            heightMap[idx + 3] = 255;

            // Scharr gradient normal
            const dx = (getH(x + 1, y - 1) + 3.33 * hR + getH(x + 1, y + 1) - (getH(x - 1, y - 1) + 3.33 * hL + getH(x - 1, y + 1))) / 5.333;
            const dy = (getH(x - 1, y + 1) + 3.33 * hB + getH(x + 1, y + 1) - (getH(x - 1, y - 1) + 3.33 * hT + getH(x + 1, y - 1))) / 5.333;

            let nx = -dx * normalStrength;
            let ny = -dy * normalStrength;
            let nz = 1.0;
            const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1.0;
            nx /= len;
            ny /= len;
            nz /= len;

            normal[idx] = Math.round((nx * 0.5 + 0.5) * 255);
            normal[idx + 1] = Math.round((ny * 0.5 + 0.5) * 255);
            normal[idx + 2] = Math.round((nz * 0.5 + 0.5) * 255);
            normal[idx + 3] = 255;

            // Roughness: Ridge burnishing smoother, crevices and pores rougher
            const avg = (hL + hR + hT + hB) * 0.25;
            const concavity = Math.max(0, avg - hC);
            const convexity = Math.max(0, hC - avg);
            const rVal = Math.min(0.85, Math.max(0.25, roughnessBaseline - convexity * 0.8 + concavity * 1.4));
            const rByte = Math.round(rVal * 255);

            roughness[idx] = rByte;
            roughness[idx + 1] = rByte;
            roughness[idx + 2] = rByte;
            roughness[idx + 3] = 255;

            // Cavity AO in micro-pores and sulci
            const aoVal = Math.min(1.0, Math.max(0.35, 1.0 - concavity * 3.5));
            const aoByte = Math.round(aoVal * 255);

            ao[idx] = aoByte;
            ao[idx + 1] = aoByte;
            ao[idx + 2] = aoByte;
            ao[idx + 3] = 255;
        }
    }

    const orm = packOrmBuffer(ao, roughness, metallic, width, height);

    return {
        albedoPng: encodePng(width, height, albedo),
        normalPng: encodePng(width, height, normal),
        roughnessPng: encodePng(width, height, roughness),
        metallicPng: encodePng(width, height, metallic),
        aoPng: encodePng(width, height, ao),
        ormPng: encodePng(width, height, orm),
        heightPng: encodePng(width, height, heightMap)
    };
}

/**
 * Synthesizes biophysical fingernail PBR texture set (Albedo, Anisotropic Normal, ORM, Height).
 * Incorporates:
 * 1. 4-Zone anatomical keratin morphology (Lunula, Vascular Bed, Onychodermal Band, Free Edge)
 * 2. Longitudinal anisotropic micro-striations running along finger growth axis
 * 3. Hard alpha-keratin high-gloss mirror surface (roughness ~0.12 - 0.16)
 * 4. Cuticle & lateral nail groove cavity shadowing
 */
export function synthesizeBiophysicalNailPbr(
    width = 512,
    height = 512,
    options: BiophysicalNailPbrOptions = {}
): PbrBufferSet {
    const seed = options.seed ?? 2026;
    const lunulaWidth = options.lunulaWidth ?? 0.22;
    const bedPinkFlush = options.bedPinkFlush ?? 0.65;
    const freeEdgeWidth = options.freeEdgeWidth ?? 0.12;
    const striationDensity = options.striationDensity ?? 64.0;
    const roughnessBaseline = options.roughnessBaseline ?? 0.14;
    const normalStrength = options.normalStrength ?? 1.8;

    const albedo = Buffer.alloc(width * height * 4);
    const normal = Buffer.alloc(width * height * 4);
    const roughness = Buffer.alloc(width * height * 4);
    const metallic = Buffer.alloc(width * height * 4);
    const ao = Buffer.alloc(width * height * 4);
    const heightMap = Buffer.alloc(width * height * 4);
    const heightVals = new Float32Array(width * height);

    // Pass 1: Compute Nail Heightfield and 4-Zone Morphology Albedo
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const u = x / width;   // [0, 1] across nail width (0.5 = center)
            const v = y / height;  // [0, 1] along nail length (0 = cuticle, 1 = free edge)

            const uNorm = Math.abs((u - 0.5) * 2.0); // 0 at center, 1 at lateral edges

            // 1. Transverse convex arch
            const arch = (1.0 - uNorm * uNorm) * 0.12;

            // 2. Longitudinal anisotropic micro-striations along finger length
            const s1 = Math.sin(u * striationDensity * 2.0 * Math.PI) * 0.045;
            const s2 = Math.sin(u * striationDensity * 4.0 * Math.PI + 0.5) * 0.020;
            const s3 = perlin2D(u * 32.0, v * 3.0, seed + 60) * 0.015;
            const striations = s1 + s2 + s3;

            // 3. Cuticle groove (v near 0) and lateral grooves (uNorm near 1)
            const cuticleT = Math.max(0.0, Math.min(1.0, (0.06 - v) / 0.06));
            const cuticleGroove = -0.18 * (cuticleT * cuticleT * (3.0 - 2.0 * cuticleT));

            const lateralT = Math.max(0.0, Math.min(1.0, (uNorm - 0.82) / 0.18));
            const lateralGroove = -0.20 * (lateralT * lateralT * (3.0 - 2.0 * lateralT));

            const hVal = Math.min(1.0, Math.max(0.0, 0.5 + arch + striations + cuticleGroove + lateralGroove));
            heightVals[y * width + x] = hVal;

            // 4. 4-Zone Anatomical Keratin Colors
            // Zone 1: Proximal Lunula (crescent apex at lunulaWidth)
            const lunApex = lunulaWidth * (1.0 - uNorm * uNorm * 0.85);
            const lunDist = (lunApex - v) / 0.04;
            const lunMask = Math.max(0.0, Math.min(1.0, lunDist > 0 ? 1.0 : (lunDist > -1.0 ? 1.0 + lunDist : 0.0)));

            // Zone 4: Distal Free Edge
            const edgeLine = 1.0 - freeEdgeWidth * (1.0 - uNorm * uNorm * 0.15);
            const edgeDist = (v - edgeLine) / 0.03;
            const edgeMask = Math.max(0.0, Math.min(1.0, edgeDist > 1.0 ? 1.0 : (edgeDist > 0.0 ? edgeDist : 0.0)));

            // Zone 3: Onychodermal Band
            const bandDist = (v - (edgeLine - 0.05)) / 0.04;
            const bandMask = Math.max(0.0, Math.min(1.0, bandDist > 0.0 && bandDist < 1.0 ? 1.0 - Math.abs(bandDist - 0.5) * 2.0 : 0.0)) * (1.0 - edgeMask);

            // Palette definitions
            const lunCol = [0.91, 0.88, 0.84]; // Creamy pale ivory lunula
            const edgeCol = [0.93, 0.91, 0.80]; // Ivory opaque free edge
            const bandCol = [0.84, 0.54, 0.46]; // Warm amber onychodermal band
            const bedCol = [                    // Rosy pink vascular nail bed
                0.87,
                0.58 * (1.0 - bedPinkFlush * 0.28),
                0.54 * (1.0 - bedPinkFlush * 0.38)
            ];

            // Blend 4 zones
            let colR = bedCol[0] * (1.0 - lunMask) + lunCol[0] * lunMask;
            let colG = bedCol[1] * (1.0 - lunMask) + lunCol[1] * lunMask;
            let colB = bedCol[2] * (1.0 - lunMask) + lunCol[2] * lunMask;

            colR = colR * (1.0 - edgeMask) + edgeCol[0] * edgeMask;
            colG = colG * (1.0 - edgeMask) + edgeCol[1] * edgeMask;
            colB = colB * (1.0 - edgeMask) + edgeCol[2] * edgeMask;

            colR = colR * (1.0 - bandMask * 0.45) + bandCol[0] * bandMask * 0.45;
            colG = colG * (1.0 - bandMask * 0.45) + bandCol[1] * bandMask * 0.45;
            colB = colB * (1.0 - bandMask * 0.45) + bandCol[2] * bandMask * 0.45;

            // Micro-striation tone modulation
            const striMod = 1.0 + s1 * 0.35;
            colR = Math.max(0.0, Math.min(1.0, colR * striMod));
            colG = Math.max(0.0, Math.min(1.0, colG * striMod));
            colB = Math.max(0.0, Math.min(1.0, colB * striMod));

            const idx = (y * width + x) * 4;
            albedo[idx] = Math.round(colR * 255);
            albedo[idx + 1] = Math.round(colG * 255);
            albedo[idx + 2] = Math.round(colB * 255);
            albedo[idx + 3] = 255;

            metallic[idx] = 0;
            metallic[idx + 1] = 0;
            metallic[idx + 2] = 0;
            metallic[idx + 3] = 255;
        }
    }

    // Pass 2: Anisotropic Scharr Normal, Hard-Keratin Roughness, and Cuticle AO
    const getH = (x: number, y: number): number => {
        const px = Math.max(0, Math.min(width - 1, x));
        const py = Math.max(0, Math.min(height - 1, y));
        return heightVals[py * width + px];
    };

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const idx = (y * width + x) * 4;
            const uNorm = Math.abs(((x / width) - 0.5) * 2.0);
            const v = y / height;

            const hC = getH(x, y);
            const hL = getH(x - 1, y);
            const hR = getH(x + 1, y);
            const hT = getH(x, y - 1);
            const hB = getH(x, y + 1);

            heightMap[idx] = Math.round(hC * 255);
            heightMap[idx + 1] = Math.round(hC * 255);
            heightMap[idx + 2] = Math.round(hC * 255);
            heightMap[idx + 3] = 255;

            // Scharr gradient normal
            const dx = (getH(x + 1, y - 1) + 3.33 * hR + getH(x + 1, y + 1) - (getH(x - 1, y - 1) + 3.33 * hL + getH(x - 1, y + 1))) / 5.333;
            const dy = (getH(x - 1, y + 1) + 3.33 * hB + getH(x + 1, y + 1) - (getH(x - 1, y - 1) + 3.33 * hT + getH(x + 1, y - 1))) / 5.333;

            let nx = -dx * normalStrength;
            let ny = -dy * normalStrength;
            let nz = 1.0;
            const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1.0;
            nx /= len;
            ny /= len;
            nz /= len;

            normal[idx] = Math.round((nx * 0.5 + 0.5) * 255);
            normal[idx + 1] = Math.round((ny * 0.5 + 0.5) * 255);
            normal[idx + 2] = Math.round((nz * 0.5 + 0.5) * 255);
            normal[idx + 3] = 255;

            // High-gloss hard keratin roughness (0.12 - 0.16) with subtle wear at free edge
            const edgeRoughness = v > 0.88 ? (v - 0.88) * 0.08 : 0.0;
            const borderRoughness = uNorm > 0.85 ? (uNorm - 0.85) * 0.22 : 0.0;
            const rVal = Math.min(0.40, Math.max(0.10, roughnessBaseline + edgeRoughness + borderRoughness));
            const rByte = Math.round(rVal * 255);

            roughness[idx] = rByte;
            roughness[idx + 1] = rByte;
            roughness[idx + 2] = rByte;
            roughness[idx + 3] = 255;

            // Cuticle and lateral groove cavity AO
            const cuticleAo = v < 0.06 ? (0.06 - v) / 0.06 * 0.45 : 0.0;
            const lateralAo = uNorm > 0.85 ? (uNorm - 0.85) / 0.15 * 0.40 : 0.0;
            const aoVal = Math.min(1.0, Math.max(0.35, 1.0 - cuticleAo - lateralAo));
            const aoByte = Math.round(aoVal * 255);

            ao[idx] = aoByte;
            ao[idx + 1] = aoByte;
            ao[idx + 2] = aoByte;
            ao[idx + 3] = 255;
        }
    }

    const orm = packOrmBuffer(ao, roughness, metallic, width, height);

    return {
        albedoPng: encodePng(width, height, albedo),
        normalPng: encodePng(width, height, normal),
        roughnessPng: encodePng(width, height, roughness),
        metallicPng: encodePng(width, height, metallic),
        aoPng: encodePng(width, height, ao),
        ormPng: encodePng(width, height, orm),
        heightPng: encodePng(width, height, heightMap)
    };
}


