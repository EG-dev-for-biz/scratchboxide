/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * ffmpeg-backed RGBA image codec for Node.
 *
 * Node has no JPEG decoder in this codebase (texture-processing.ts only decodes PNG),
 * so JPEG/WebP decode and JPEG encode shell out to ffmpeg. Modelled on
 * GlbTextureRecolorService.decodeToRgba / encodeFromRgba, but these helpers fail loudly (they
 * never resolve to an empty buffer) and validate the decoded size against the header.
 *
 * Colour: JPEG colour conversion is done here with the exact JFIF (full-range BT.601)
 * equations, and ffmpeg only moves Y'CbCr planes. Letting ffmpeg's swscale convert RGB to
 * yuvj420p biases every re-encoded image by about dRGB (-0.6, +0.5, -0.9), i.e. Lab
 * da* -0.8 / db* +0.7, which shows up as a colour shift on texels that were never meant to
 * change; its YCbCr -> RGB path is also about -0.17 levels off in green against libjpeg.
 * 4:2:0 chroma is resampled here too, as libjpeg does (each sample centred on its 2 x 2 block):
 * swscale sites it differently across versions, and Ubuntu 24.04's ffmpeg 6.1 against Homebrew's
 * 8.1 shifted it by half a pixel between encode and decode, a 0.26 level round-trip bias on
 * gradients. ffmpeg only codes the planes it is given and hands back the planes as coded.
 *
 * Robustness: ffmpeg reads its input from a temporary file (never stdin; `-nostdin`), and
 * every invocation has a timeout, because ffmpeg occasionally blocked forever in read() on a
 * stdin pipe, hanging synchronous callers.
 *
 * Without ffmpeg (not installed, or it fails), JPEG decode/encode fall back to the in-process
 * jpeg-js codec and PNG encode to texture-processing's encodePng. Decoded Y'CbCr planes go
 * through the same exact JFIF conversion; jpeg-js replicates (rather than interpolates)
 * subsampled chroma, and always encodes 4:4:4. WebP still needs ffmpeg (or macOS `sips` in the
 * synchronous decoder).
 */

import { spawn, spawnSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as jpegJs from 'jpeg-js';
import { decodePng, encodePng } from './texture-processing';

export interface RgbaImage {
    width: number;
    height: number;
    /** Tightly packed RGBA8, row 0 = top of the image. */
    rgba: Buffer;
}

export type EncodedImageFormat = 'jpeg' | 'png' | 'webp' | 'unknown';

/** Resolves the ffmpeg executable: FFMPEG_PATH, then PATH lookup of `ffmpeg`. */
export function resolveFfmpegPath(): string {
    return process.env.FFMPEG_PATH || 'ffmpeg';
}

/** Sniffs the container format from magic bytes. */
export function sniffImageFormat(buf: Buffer | Uint8Array): EncodedImageFormat {
    if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
    if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
    if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
    return 'unknown';
}

/**
 * sha256 of an image's content: for a JPEG, every byte but its APP0-APP15 and COM segments (metadata: the grounding API
 * signs each answer with a fresh content-credentials APP11 segment, so the same view's file differs every time while its
 * pixels do not); any other bytes whole. Two answers with the same digest decode to the same pixels.
 */
export function imageContentSha256(buf: Buffer | Uint8Array): string {
    const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
    const h = crypto.createHash('sha256');
    if (sniffImageFormat(b) !== 'jpeg') return h.update(b).digest('hex');
    h.update(b.subarray(0, 2));
    let i = 2;
    while (i + 4 <= b.length && b[i] === 0xff) {
        const m = b[i + 1];
        // start of scan: the entropy-coded data to the end is content
        if (m === 0xda) { h.update(b.subarray(i)); return h.digest('hex'); }
        // a marker with no length (RSTn, TEM, fill bytes) is kept as it is
        if ((m >= 0xd0 && m <= 0xd7) || m === 0x01 || m === 0xff) { h.update(b.subarray(i, i + 2)); i += m === 0xff ? 1 : 2; continue; }
        const end = i + 2 + b.readUInt16BE(i + 2);
        if (end > b.length) break;
        if (!((m >= 0xe0 && m <= 0xef) || m === 0xfe)) h.update(b.subarray(i, end));
        i = end;
    }
    // not a well-formed header: the rest whole
    h.update(b.subarray(i));
    return h.digest('hex');
}

/**
 * Reads pixel dimensions from a JPEG (any SOFn marker), PNG (IHDR) or WebP (VP8 / VP8L / VP8X) header without decoding.
 * Returns null when the header cannot be parsed.
 */
export function readImageDimensions(input: Buffer | Uint8Array): { width: number; height: number } | null {
    const buf = Buffer.isBuffer(input) ? input : Buffer.from(input.buffer, input.byteOffset, input.byteLength);
    const fmt = sniffImageFormat(buf);
    if (fmt === 'png') {
        if (buf.length < 24) return null;
        return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    if (fmt === 'webp') {
        // First chunk after "RIFF....WEBP": VP8X (extended), VP8 (lossy) or VP8L (lossless).
        if (buf.length < 30) return null;
        const chunk = buf.toString('ascii', 12, 16);
        if (chunk === 'VP8X') return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
        if (chunk === 'VP8 ' && buf[23] === 0x9d && buf[24] === 0x01 && buf[25] === 0x2a) {
            return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
        }
        if (chunk === 'VP8L' && buf[20] === 0x2f) {
            const bits = buf.readUInt32LE(21);
            return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >>> 14) & 0x3fff) };
        }
        return null;
    }
    if (fmt === 'jpeg') {
        let pos = 2;
        while (pos + 4 <= buf.length) {
            if (buf[pos] !== 0xff) { pos++; continue; }
            const marker = buf[pos + 1];
            // Fill bytes and standalone markers (RSTn, SOI, EOI, TEM) carry no length field.
            if (marker === 0xff) { pos++; continue; }
            if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { pos += 2; continue; }
            if (marker === 0xd9) return null;
            if (pos + 4 > buf.length) return null;
            const segLen = buf.readUInt16BE(pos + 2);
            // SOF0..SOF15 except DHT (C4), JPG (C8) and DAC (CC).
            const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
            if (isSof) {
                if (pos + 9 > buf.length) return null;
                return { height: buf.readUInt16BE(pos + 5), width: buf.readUInt16BE(pos + 7) };
            }
            if (marker === 0xda) return null; // start of scan before any SOF
            pos += 2 + segLen;
        }
        return null;
    }
    return null;
}

/** Default per-invocation ffmpeg timeout (ms). Override with SCRATCHBOX_FFMPEG_TIMEOUT_MS. */
export function ffmpegTimeoutMs(): number {
    const v = Number(process.env.SCRATCHBOX_FFMPEG_TIMEOUT_MS);
    return Number.isFinite(v) && v > 0 ? v : 60_000;
}

/** Writes `data` to a fresh temporary file, runs `fn(filePath)` and always removes the directory. */
function withTempFile<T>(data: Buffer, ext: string, fn: (file: string) => T): T {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-imgcodec-'));
    const file = path.join(dir, `in${ext}`);
    try {
        fs.writeFileSync(file, data);
        return fn(file);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

async function withTempFileAsync<T>(data: Buffer, ext: string, fn: (file: string) => Promise<T>): Promise<T> {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sb-imgcodec-'));
    const file = path.join(dir, `in${ext}`);
    try {
        await fs.promises.writeFile(file, data);
        return await fn(file);
    } finally {
        await fs.promises.rm(dir, { recursive: true, force: true });
    }
}

/** Runs ffmpeg (input given as a file in `args`, output on stdout) with a timeout; stdin is closed. */
function runFfmpeg(args: string[], label: string, timeoutMs = ffmpegTimeoutMs()): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const proc = spawn(resolveFfmpegPath(), ['-nostdin', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
        const out: Buffer[] = [];
        const err: Buffer[] = [];
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; proc.kill('SIGKILL'); }, timeoutMs);
        proc.stdout.on('data', (c: Buffer) => out.push(c));
        proc.stderr.on('data', (c: Buffer) => err.push(c));
        proc.on('error', e => { clearTimeout(timer); reject(new Error(`${label}: failed to start ffmpeg (${(e as Error).message}). Set FFMPEG_PATH or install ffmpeg.`)); });
        proc.on('close', code => {
            clearTimeout(timer);
            if (timedOut) { reject(new Error(`${label}: ffmpeg timed out after ${timeoutMs} ms`)); return; }
            if (code === 0) {
                resolve(Buffer.concat(out));
            } else {
                const msg = Buffer.concat(err).toString('utf8').trim().split('\n').slice(-3).join(' | ');
                reject(new Error(`${label}: ffmpeg exited with code ${code}${msg ? `: ${msg}` : ''}`));
            }
        });
    });
}

/** Synchronous ffmpeg run with a timeout and one retry (stdin closed, output on stdout). */
function runFfmpegSync(args: string[], label: string, maxBuffer: number, timeoutMs = ffmpegTimeoutMs()): Buffer {
    let last = '';
    for (let attempt = 0; attempt < 2; attempt++) {
        const r = spawnSync(resolveFfmpegPath(), ['-nostdin', ...args], { stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer });
        if (r.error && (r.error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`${label}: ffmpeg not found. Set FFMPEG_PATH or install ffmpeg.`);
        if (r.status === 0 && r.stdout) return r.stdout;
        last = r.signal ? `killed by ${r.signal} (timeout ${timeoutMs} ms)` : `exit ${r.status}: ${(r.stderr || Buffer.alloc(0)).toString('utf8').trim().split('\n').slice(-2).join(' | ')}`;
    }
    throw new Error(`${label}: ffmpeg failed twice (${last})`);
}

// ---------------------------------------------------------------------------------------------
// Exact JFIF (full-range BT.601) colour conversion, planar Y'CbCr 4:4:4
// ---------------------------------------------------------------------------------------------

const clamp8 = (v: number): number => (v <= 0 ? 0 : v >= 255 ? 255 : Math.round(v));

/** RGBA8 -> planar Y, Cb, Cr (JFIF), each width * height bytes. */
export function rgbaToJfifYcc444(rgba: Buffer | Uint8Array, width: number, height: number): Buffer {
    const n = width * height;
    const out = Buffer.alloc(n * 3);
    for (let i = 0; i < n; i++) {
        const r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2];
        out[i] = clamp8(0.299 * r + 0.587 * g + 0.114 * b);
        out[n + i] = clamp8(-0.168735892 * r - 0.331264108 * g + 0.5 * b + 128);
        out[2 * n + i] = clamp8(0.5 * r - 0.418687589 * g - 0.081312411 * b + 128);
    }
    return out;
}

/** Planar Y, Cb, Cr (JFIF) -> RGBA8 (alpha 255). */
export function jfifYcc444ToRgba(planes: Buffer | Uint8Array, width: number, height: number): Buffer {
    const n = width * height;
    const out = Buffer.alloc(n * 4);
    for (let i = 0; i < n; i++) {
        const y = planes[i], cb = planes[n + i] - 128, cr = planes[2 * n + i] - 128;
        out[i * 4] = clamp8(y + 1.402 * cr);
        out[i * 4 + 1] = clamp8(y - 0.344136286 * cb - 0.714136286 * cr);
        out[i * 4 + 2] = clamp8(y + 1.772 * cb);
        out[i * 4 + 3] = 255;
    }
    return out;
}

// ---------------------------------------------------------------------------------------------
// 4:2:0 chroma, sited as JPEG sites it (each Cb/Cr sample at the centre of its 2 x 2 luma block)
// ---------------------------------------------------------------------------------------------

/** Bytes of planar Y'CbCr 4:2:0 for width x height (chroma planes ceil(w/2) x ceil(h/2), as ffmpeg lays them out). */
export function yuv420Bytes(width: number, height: number): number {
    return width * height + 2 * Math.ceil(width / 2) * Math.ceil(height / 2);
}

/**
 * Planar 4:4:4 -> 4:2:0: each chroma sample the mean of its 2 x 2 block, edges replicated, rounding alternating
 * between +1 and +2 along a row (libjpeg's h2v2_downsample), so the subsampling adds no bias.
 */
export function subsampleYcc444To420(planes: Buffer | Uint8Array, width: number, height: number): Buffer {
    const n = width * height, cw = Math.ceil(width / 2), ch = Math.ceil(height / 2);
    const out = Buffer.alloc(yuv420Bytes(width, height));
    out.set(planes.subarray(0, n), 0);
    for (let p = 0; p < 2; p++) {
        const src = n * (p + 1), dst = n + p * cw * ch;
        for (let y = 0; y < ch; y++) {
            const r0 = src + 2 * y * width, r1 = src + Math.min(2 * y + 1, height - 1) * width;
            let bias = 1;
            for (let x = 0; x < cw; x++) {
                const x0 = 2 * x, x1 = Math.min(2 * x + 1, width - 1);
                out[dst + y * cw + x] = (planes[r0 + x0] + planes[r0 + x1] + planes[r1 + x0] + planes[r1 + x1] + bias) >> 2;
                bias ^= 3;
            }
        }
    }
    return out;
}

/**
 * Planar Y'CbCr 4:2:0 (JFIF) -> RGBA8: chroma upsampled by libjpeg's h2v2 "fancy" triangle filter (each output sample
 * 3/4 its own chroma sample and 1/4 the next one toward it, in each direction, rounding alternating +8 / +7), the result
 * libjpeg-turbo gives by default (which, like it, replicates instead when the chroma is at most 2 samples wide), then
 * the exact JFIF conversion.
 */
export function jfifYcc420ToRgba(planes: Buffer | Uint8Array, width: number, height: number): Buffer {
    const n = width * height, cw = Math.ceil(width / 2), ch = Math.ceil(height / 2);
    const full = Buffer.alloc(n * 3);
    full.set(planes.subarray(0, n), 0);
    const colsum = new Int32Array(cw);
    for (let p = 0; p < 2; p++) {
        const src = n + p * cw * ch, dst = n * (p + 1);
        if (cw <= 2) {
            for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) full[dst + y * width + x] = planes[src + (y >> 1) * cw + (x >> 1)];
            continue;
        }
        for (let y = 0; y < height; y++) {
            const near = y >> 1, far = Math.min(Math.max(y & 1 ? near + 1 : near - 1, 0), ch - 1);
            for (let x = 0; x < cw; x++) colsum[x] = 3 * planes[src + near * cw + x] + planes[src + far * cw + x];
            const row = dst + y * width;
            for (let x = 0; x < width; x++) {
                const i = x >> 1;
                full[row + x] = x & 1
                    ? (3 * colsum[i] + colsum[Math.min(i + 1, cw - 1)] + 7) >> 4
                    : (3 * colsum[i] + colsum[Math.max(i - 1, 0)] + 8) >> 4;
            }
        }
    }
    return jfifYcc444ToRgba(full, width, height);
}

/** How ffmpeg hands back a decoded image: Y'CbCr planes (full resolution, or 4:2:0 as coded) or RGBA. */
type RawLayout = 'yuv444' | 'yuv420' | 'rgba';

const DECODE_ARGS = (file: string, layout: RawLayout) =>
    ['-v', 'error', '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', layout === 'yuv420' ? 'yuvj420p' : layout === 'yuv444' ? 'yuvj444p' : 'rgba', 'pipe:1'];

/**
 * A plain Y'CbCr 4:2:0 JPEG comes back in its own planes and is upsampled here, not by ffmpeg's scaler, which sites the
 * chroma differently across ffmpeg versions; every other JPEG comes back at full resolution in Y'CbCr, anything else RGBA.
 */
function rawLayoutOf(fmt: EncodedImageFormat, buf: Buffer): RawLayout {
    if (fmt !== 'jpeg') return 'rgba';
    const l = jpegColourLayout(buf);
    const is420 = l.components === 3 && l.adobeTransform === undefined
        && l.sampling[0]?.join() === '2,2' && l.sampling[1]?.join() === '1,1' && l.sampling[2]?.join() === '1,1';
    return is420 ? 'yuv420' : 'yuv444';
}

function rawBytes(layout: RawLayout, dims: { width: number; height: number }): number {
    const n = dims.width * dims.height;
    return layout === 'yuv420' ? yuv420Bytes(dims.width, dims.height) : layout === 'yuv444' ? n * 3 : n * 4;
}

function finishDecode(layout: RawLayout, raw: Buffer, dims: { width: number; height: number }, label: string): RgbaImage {
    const expected = rawBytes(layout, dims);
    if (raw.length !== expected) throw new Error(`${label}: expected ${expected} bytes for ${dims.width}x${dims.height}, got ${raw.length}`);
    const rgba = layout === 'yuv420' ? jfifYcc420ToRgba(raw, dims.width, dims.height) : layout === 'yuv444' ? jfifYcc444ToRgba(raw, dims.width, dims.height) : raw;
    return { width: dims.width, height: dims.height, rgba };
}

function decodePngImage(buf: Buffer): RgbaImage {
    const d = decodePng(buf);
    return { width: d.width, height: d.height, rgba: Buffer.from(d.rgba) };
}

/** In-process JPEG decode (jpeg-js), used when ffmpeg is unavailable or fails. Throws with both causes. */
/** Component count and each component's [horizontal, vertical] sampling factors (from the SOF marker), and the Adobe APP14 colour transform byte, when present. */
function jpegColourLayout(buf: Buffer): { components: number; sampling: Array<[number, number]>; adobeTransform?: number } {
    let pos = 2, components = 0, adobeTransform: number | undefined;
    const sampling: Array<[number, number]> = [];
    while (pos + 4 <= buf.length) {
        if (buf[pos] !== 0xff) { pos++; continue; }
        const marker = buf[pos + 1];
        if (marker === 0xff) { pos++; continue; }
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { pos += 2; continue; }
        if (marker === 0xd9 || marker === 0xda) break;
        const segLen = buf.readUInt16BE(pos + 2);
        if (marker === 0xee && segLen >= 14 && buf.toString('ascii', pos + 4, pos + 9) === 'Adobe') adobeTransform = buf[pos + 15];
        const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
        if (isSof && pos + 9 < buf.length) {
            components = buf[pos + 9];
            for (let c = 0; c < components && pos + 11 + 3 * c < buf.length; c++) {
                const hv = buf[pos + 11 + 3 * c];
                sampling.push([hv >> 4, hv & 15]);
            }
        }
        pos += 2 + segLen;
    }
    return { components, sampling, adobeTransform };
}

/**
 * In-process JPEG decode (jpeg-js), used when ffmpeg is unavailable or fails. Throws with both causes.
 * jpeg-js truncates its own Y'CbCr -> RGB result (a -0.4 to -0.5 level bias per channel), so for plain Y'CbCr JPEGs
 * it hands back the raw planes and the exact, rounded JFIF conversion above does the rest. An Adobe marker forces
 * jpeg-js's own transform, so those (and grey / CMYK) keep its default path.
 */
function decodeJpegInProcess(buf: Buffer, label: string, ffmpegError: unknown): RgbaImage {
    try {
        const layout = jpegColourLayout(buf);
        const ycc = layout.components === 3 && layout.adobeTransform === undefined;
        const rgbAsIs = layout.components === 3 && layout.adobeTransform === 0;
        const d = jpegJs.decode(buf, {
            useTArray: true, formatAsRGBA: true, maxResolutionInMP: 250, maxMemoryUsageInMB: 2048,
            ...(ycc || rgbAsIs ? { colorTransform: false } : {})
        });
        const n = d.width * d.height;
        if (d.data.length !== n * 4) throw new Error(`expected ${n * 4} bytes for ${d.width}x${d.height}, got ${d.data.length}`);
        if (!ycc) return { width: d.width, height: d.height, rgba: Buffer.from(d.data.buffer, d.data.byteOffset, d.data.byteLength) };
        const planes = Buffer.alloc(n * 3);
        for (let i = 0; i < n; i++) {
            planes[i] = d.data[i * 4];
            planes[n + i] = d.data[i * 4 + 1];
            planes[2 * n + i] = d.data[i * 4 + 2];
        }
        return { width: d.width, height: d.height, rgba: jfifYcc444ToRgba(planes, d.width, d.height) };
    } catch (e) {
        const why = ffmpegError ? `ffmpeg: ${(ffmpegError as Error).message}; ` : '';
        throw new Error(`${label}: could not decode the JPEG (${why}jpeg-js: ${(e as Error).message})`);
    }
}

/**
 * Decodes an encoded image (JPEG, PNG, WebP) into RGBA8 (PNG in-process, JPEG / WebP through ffmpeg, JPEG
 * in-process with jpeg-js when ffmpeg is unavailable or fails). Throws when the format is unknown, no decoder
 * succeeds, or the output size does not match the header.
 */
export async function decodeImageToRgba(encoded: Buffer | Uint8Array): Promise<RgbaImage> {
    const buf = Buffer.isBuffer(encoded) ? encoded : Buffer.from(encoded.buffer, encoded.byteOffset, encoded.byteLength);
    const fmt = sniffImageFormat(buf);
    if (fmt === 'unknown') throw new Error('decodeImageToRgba: unrecognised image format');
    if (fmt === 'png') return decodePngImage(buf);
    const dims = readImageDimensions(buf);
    if (!dims && fmt === 'jpeg') throw new Error('decodeImageToRgba: could not read image dimensions from header');
    try {
        const layout = rawLayoutOf(fmt, buf);
        const raw = await withTempFileAsync(buf, `.${fmt === 'jpeg' ? 'jpg' : fmt}`, file => runFfmpeg(DECODE_ARGS(file, layout), 'decodeImageToRgba'));
        if (!dims) throw new Error('decodeImageToRgba: could not read image dimensions from header');
        return finishDecode(layout, raw, dims, 'decodeImageToRgba');
    } catch (e) {
        if (fmt !== 'jpeg') throw e;
        return decodeJpegInProcess(buf, 'decodeImageToRgba', e);
    }
}

/**
 * Synchronous decodeImageToRgba (same colour conversion), for callers that cannot await. ffmpeg runs with a
 * timeout and one retry; JPEGs then fall back to jpeg-js, and on macOS `sips` is the last resort.
 */
export function decodeImageToRgbaSync(encoded: Buffer | Uint8Array): RgbaImage {
    const buf = Buffer.isBuffer(encoded) ? encoded : Buffer.from(encoded.buffer, encoded.byteOffset, encoded.byteLength);
    const fmt = sniffImageFormat(buf);
    if (fmt === 'unknown') throw new Error('decodeImageToRgbaSync: unrecognised image format');
    if (fmt === 'png') return decodePngImage(buf);
    const dims = readImageDimensions(buf);
    let ffmpegError: unknown;
    if (dims) {
        try {
            const layout = rawLayoutOf(fmt, buf);
            const raw = withTempFile(buf, `.${fmt === 'jpeg' ? 'jpg' : fmt}`, file =>
                runFfmpegSync(DECODE_ARGS(file, layout), 'decodeImageToRgbaSync', rawBytes(layout, dims) + 4096));
            return finishDecode(layout, raw, dims, 'decodeImageToRgbaSync');
        } catch (e) {
            ffmpegError = e;
        }
    }
    if (fmt === 'jpeg') {
        try {
            return decodeJpegInProcess(buf, 'decodeImageToRgbaSync', ffmpegError);
        } catch (e) {
            ffmpegError = e;
        }
    }
    if (process.platform === 'darwin' && fs.existsSync('/usr/bin/sips')) {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-imgcodec-'));
        try {
            const src = path.join(dir, `in.${fmt === 'jpeg' ? 'jpg' : fmt}`), png = path.join(dir, 'out.png');
            fs.writeFileSync(src, buf);
            const r = spawnSync('/usr/bin/sips', ['-s', 'format', 'png', src, '--out', png], { stdio: 'pipe', timeout: ffmpegTimeoutMs(), killSignal: 'SIGKILL' });
            if (r.status === 0 && fs.existsSync(png)) return decodePngImage(fs.readFileSync(png));
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }
    throw new Error(`decodeImageToRgbaSync: could not decode the ${fmt} image${ffmpegError ? ` (${(ffmpegError as Error).message})` : ''}`);
}

/**
 * Maps a libjpeg-style quality (1..100) to ffmpeg's mjpeg qscale (2..31).
 * q90 -> 3, q95 -> 2, q80 -> 5, q75 -> 6.
 */
export function jpegQualityToQscale(quality: number): number {
    const q = Math.max(1, Math.min(100, quality));
    return Math.max(2, Math.min(31, Math.round((100 - q) / 5 + 1)));
}

export interface JpegEncodeOptions {
    /** libjpeg-style quality 1..100 (default 90). */
    quality?: number;
    /** Chroma subsampling: '420' (default, smallest) or '444'. */
    chroma?: '420' | '444';
}

/**
 * A JPEG made smaller in one ffmpeg process: decoded, area-averaged to `width` x `height` and re-encoded, all in the
 * Y'CbCr planes (full range, so no colour conversion at all), with no pixel loop in this thread. Deterministic: the same
 * bytes in give the same bytes out. Throws when ffmpeg is unavailable or fails (callers fall back to the in-process path).
 */
export async function downscaleJpegFfmpeg(jpeg: Buffer, width: number, height: number, options: JpegEncodeOptions = {}): Promise<Buffer> {
    if (sniffImageFormat(jpeg) !== 'jpeg') throw new Error('downscaleJpegFfmpeg: the input is not a JPEG');
    const qscale = jpegQualityToQscale(options.quality ?? 90);
    const pixFmt = options.chroma === '444' ? 'yuvj444p' : 'yuvj420p';
    const out = await withTempFileAsync(jpeg, '.jpg', file => runFfmpeg([
        '-v', 'error', '-i', file, '-frames:v', '1',
        '-vf', `scale=${width}:${height}:flags=area:in_range=full:out_range=full,format=${pixFmt}`,
        '-q:v', String(qscale), '-qmin', String(qscale), '-qmax', String(qscale), '-f', 'mjpeg', 'pipe:1'
    ], 'downscaleJpegFfmpeg'));
    if (sniffImageFormat(out) !== 'jpeg') throw new Error('downscaleJpegFfmpeg: encoder did not produce a JPEG');
    const dims = readImageDimensions(out);
    if (!dims || dims.width !== width || dims.height !== height) throw new Error(`downscaleJpegFfmpeg: got ${dims?.width}x${dims?.height}, wanted ${width}x${height}`);
    return out;
}

/**
 * Encodes RGBA8 (alpha ignored) to a baseline JPEG: exact JFIF RGB -> Y'CbCr (and the 4:2:0 subsampling) here,
 * ffmpeg's mjpeg encoder only compresses the planes, so the round trip carries no colour bias.
 * Without ffmpeg, jpeg-js encodes at the same quality (always 4:4:4).
 */
export async function encodeRgbaToJpeg(rgba: Buffer | Uint8Array, width: number, height: number, options: JpegEncodeOptions = {}): Promise<Buffer> {
    if (rgba.length !== width * height * 4) {
        throw new Error(`encodeRgbaToJpeg: buffer has ${rgba.length} bytes, expected ${width * height * 4}`);
    }
    const qscale = jpegQualityToQscale(options.quality ?? 90);
    const pixFmt = options.chroma === '444' ? 'yuvj444p' : 'yuvj420p';
    const ycc = rgbaToJfifYcc444(rgba, width, height);
    // 4:2:0 is subsampled here, not by ffmpeg's scaler (see jfifYcc420ToRgba): ffmpeg only compresses the planes it is given
    const planes = pixFmt === 'yuvj420p' ? subsampleYcc444To420(ycc, width, height) : ycc;
    let out: Buffer;
    try {
        out = await withTempFileAsync(planes, '.yuv', file => runFfmpeg([
            '-v', 'error',
            '-f', 'rawvideo', '-pix_fmt', pixFmt, '-s', `${width}x${height}`, '-i', file,
            '-frames:v', '1', '-pix_fmt', pixFmt, '-q:v', String(qscale), '-qmin', String(qscale), '-qmax', String(qscale),
            '-f', 'mjpeg', 'pipe:1'
        ], 'encodeRgbaToJpeg'));
    } catch {
        out = jpegJs.encode({ data: rgba, width, height }, Math.max(1, Math.min(100, options.quality ?? 90))).data;
    }
    if (sniffImageFormat(out) !== 'jpeg') throw new Error('encodeRgbaToJpeg: encoder did not produce a JPEG');
    return out;
}

/** Encodes RGBA8 to PNG through ffmpeg, or in-process without it (lossless, keeps alpha). */
export async function encodeRgbaToPng(rgba: Buffer | Uint8Array, width: number, height: number): Promise<Buffer> {
    if (rgba.length !== width * height * 4) {
        throw new Error(`encodeRgbaToPng: buffer has ${rgba.length} bytes, expected ${width * height * 4}`);
    }
    const input = Buffer.isBuffer(rgba) ? rgba : Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength);
    let out: Buffer;
    try {
        out = await withTempFileAsync(input, '.rgba', file => runFfmpeg([
            '-v', 'error',
            '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${width}x${height}`, '-i', file,
            '-frames:v', '1', '-c:v', 'png', '-f', 'image2pipe', 'pipe:1'
        ], 'encodeRgbaToPng'));
    } catch {
        out = encodePng(width, height, input);
    }
    if (sniffImageFormat(out) !== 'png') throw new Error('encodeRgbaToPng: encoder did not produce a PNG');
    return out;
}
