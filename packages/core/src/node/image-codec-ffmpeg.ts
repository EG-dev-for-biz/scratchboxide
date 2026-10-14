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
 *
 * Robustness: ffmpeg reads its input from a temporary file (never stdin; `-nostdin`), and
 * every invocation has a timeout, because ffmpeg occasionally blocked forever in read() on a
 * stdin pipe, hanging synchronous callers.
 */

import { spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { decodePng } from './texture-processing';

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
 * Reads pixel dimensions from a JPEG (any SOFn marker) or PNG (IHDR) header without decoding.
 * Returns null when the header cannot be parsed.
 */
export function readImageDimensions(input: Buffer | Uint8Array): { width: number; height: number } | null {
    const buf = Buffer.isBuffer(input) ? input : Buffer.from(input.buffer, input.byteOffset, input.byteLength);
    const fmt = sniffImageFormat(buf);
    if (fmt === 'png') {
        if (buf.length < 24) return null;
        return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
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

const DECODE_JPEG_ARGS = (file: string) => ['-v', 'error', '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'yuvj444p', 'pipe:1'];
const DECODE_RGBA_ARGS = (file: string) => ['-v', 'error', '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1'];

function finishDecode(fmt: EncodedImageFormat, raw: Buffer, dims: { width: number; height: number }, label: string): RgbaImage {
    const n = dims.width * dims.height;
    const expected = fmt === 'jpeg' ? n * 3 : n * 4;
    if (raw.length !== expected) throw new Error(`${label}: expected ${expected} bytes for ${dims.width}x${dims.height}, got ${raw.length}`);
    return { width: dims.width, height: dims.height, rgba: fmt === 'jpeg' ? jfifYcc444ToRgba(raw, dims.width, dims.height) : raw };
}

function decodePngImage(buf: Buffer): RgbaImage {
    const d = decodePng(buf);
    return { width: d.width, height: d.height, rgba: Buffer.from(d.rgba) };
}

/**
 * Decodes an encoded image (JPEG, PNG, WebP) into RGBA8 (PNG in-process, JPEG / WebP through ffmpeg).
 * Throws when the format is unknown, ffmpeg fails or times out, or the output size does not match the header.
 */
export async function decodeImageToRgba(encoded: Buffer | Uint8Array): Promise<RgbaImage> {
    const buf = Buffer.isBuffer(encoded) ? encoded : Buffer.from(encoded.buffer, encoded.byteOffset, encoded.byteLength);
    const fmt = sniffImageFormat(buf);
    if (fmt === 'unknown') throw new Error('decodeImageToRgba: unrecognised image format');
    if (fmt === 'png') return decodePngImage(buf);
    const dims = readImageDimensions(buf);
    if (!dims && fmt === 'jpeg') throw new Error('decodeImageToRgba: could not read image dimensions from header');
    const raw = await withTempFileAsync(buf, `.${fmt === 'jpeg' ? 'jpg' : fmt}`, file =>
        runFfmpeg(fmt === 'jpeg' ? DECODE_JPEG_ARGS(file) : DECODE_RGBA_ARGS(file), 'decodeImageToRgba'));
    if (!dims) throw new Error('decodeImageToRgba: could not read image dimensions from header');
    return finishDecode(fmt, raw, dims, 'decodeImageToRgba');
}

/**
 * Synchronous decodeImageToRgba (same colour conversion), for callers that cannot await. ffmpeg runs with a
 * timeout and one retry; on macOS `sips` is the last resort.
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
            const raw = withTempFile(buf, `.${fmt === 'jpeg' ? 'jpg' : fmt}`, file =>
                runFfmpegSync(fmt === 'jpeg' ? DECODE_JPEG_ARGS(file) : DECODE_RGBA_ARGS(file), 'decodeImageToRgbaSync', dims.width * dims.height * 4 + 4096));
            return finishDecode(fmt, raw, dims, 'decodeImageToRgbaSync');
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
 * Encodes RGBA8 (alpha ignored) to a baseline JPEG: exact JFIF RGB -> Y'CbCr here, ffmpeg's mjpeg encoder
 * only compresses the planes (and subsamples chroma for '420'), so the round trip carries no colour bias.
 */
export async function encodeRgbaToJpeg(rgba: Buffer | Uint8Array, width: number, height: number, options: JpegEncodeOptions = {}): Promise<Buffer> {
    if (rgba.length !== width * height * 4) {
        throw new Error(`encodeRgbaToJpeg: buffer has ${rgba.length} bytes, expected ${width * height * 4}`);
    }
    const qscale = jpegQualityToQscale(options.quality ?? 90);
    const pixFmt = options.chroma === '444' ? 'yuvj444p' : 'yuvj420p';
    const planes = rgbaToJfifYcc444(rgba, width, height);
    const out = await withTempFileAsync(planes, '.yuv', file => runFfmpeg([
        '-v', 'error',
        '-f', 'rawvideo', '-pix_fmt', 'yuvj444p', '-s', `${width}x${height}`, '-i', file,
        '-frames:v', '1', '-pix_fmt', pixFmt, '-q:v', String(qscale), '-qmin', String(qscale), '-qmax', String(qscale),
        '-f', 'mjpeg', 'pipe:1'
    ], 'encodeRgbaToJpeg'));
    if (sniffImageFormat(out) !== 'jpeg') throw new Error('encodeRgbaToJpeg: ffmpeg did not produce a JPEG');
    return out;
}

/** Encodes RGBA8 to PNG through ffmpeg (lossless, keeps alpha). */
export async function encodeRgbaToPng(rgba: Buffer | Uint8Array, width: number, height: number): Promise<Buffer> {
    if (rgba.length !== width * height * 4) {
        throw new Error(`encodeRgbaToPng: buffer has ${rgba.length} bytes, expected ${width * height * 4}`);
    }
    const input = Buffer.isBuffer(rgba) ? rgba : Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength);
    const out = await withTempFileAsync(input, '.rgba', file => runFfmpeg([
        '-v', 'error',
        '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${width}x${height}`, '-i', file,
        '-frames:v', '1', '-c:v', 'png', '-f', 'image2pipe', 'pipe:1'
    ], 'encodeRgbaToPng'));
    if (sniffImageFormat(out) !== 'png') throw new Error('encodeRgbaToPng: ffmpeg did not produce a PNG');
    return out;
}
