/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * SPDX-License-Identifier: MIT
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
