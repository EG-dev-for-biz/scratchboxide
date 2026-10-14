/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Google Solar API digital surface model (dataLayers DSM GeoTIFF): rooftop/ground surface heights in meters above
 * sea level, 0.1-0.5 m per pixel, in a UTM projection. Reads the GeoTIFF the API serves (float32, deflate, tiled or
 * stripped, either byte order, georeferenced by ModelTransformation or tiepoint + pixel scale) and samples it by
 * latitude/longitude.
 */
import { unzlibSync } from 'fflate';

export interface DsmRaster {
    width: number;
    height: number;
    /** Heights in meters above sea level; NaN where there is no data. */
    data: Float32Array;
    /** Map x = a0 + a1 * col + a2 * row; map y = b0 + b1 * col + b2 * row (pixel corners). */
    affine: { a0: number; a1: number; a2: number; b0: number; b1: number; b2: number };
    /** EPSG code of the projected CRS (326xx / 327xx UTM). */
    epsg: number;
}

// ---------------------------------------------------------------------------
// UTM (Krüger series, WGS84), accurate to well under a centimeter within a zone
// ---------------------------------------------------------------------------

const A = 6378137, F = 1 / 298.257223563, K0 = 0.9996;
const N_ = F / (2 - F);
const A_HAT = (A / (1 + N_)) * (1 + N_ ** 2 / 4 + N_ ** 4 / 64);
const ALPHA = [
    N_ / 2 - (2 / 3) * N_ ** 2 + (5 / 16) * N_ ** 3,
    (13 / 48) * N_ ** 2 - (3 / 5) * N_ ** 3,
    (61 / 240) * N_ ** 3
];

/** WGS84 lat/lng to UTM easting/northing in the given zone and hemisphere. */
export function latLngToUtm(latDeg: number, lngDeg: number, zone: number, south: boolean): { easting: number; northing: number } {
    const lat = (latDeg * Math.PI) / 180;
    const lng0 = (((zone - 1) * 6 - 180 + 3) * Math.PI) / 180;
    const dl = (lngDeg * Math.PI) / 180 - lng0;
    const e = Math.sqrt(F * (2 - F));
    const t = Math.sinh(Math.atanh(Math.sin(lat)) - e * Math.atanh(e * Math.sin(lat)));
    const xiP = Math.atan2(t, Math.cos(dl));
    const etaP = Math.atanh(Math.sin(dl) / Math.sqrt(1 + t * t));
    let xi = xiP, eta = etaP;
    for (let j = 1; j <= 3; j++) {
        xi += ALPHA[j - 1] * Math.sin(2 * j * xiP) * Math.cosh(2 * j * etaP);
        eta += ALPHA[j - 1] * Math.cos(2 * j * xiP) * Math.sinh(2 * j * etaP);
    }
    return { easting: 500000 + K0 * A_HAT * eta, northing: (south ? 10000000 : 0) + K0 * A_HAT * xi };
}

// ---------------------------------------------------------------------------
// GeoTIFF
// ---------------------------------------------------------------------------

const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 11: 4, 12: 8, 16: 8 };

export function parseDsmGeoTiff(buf: Buffer | Uint8Array): DsmRaster {
    const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
    const le = b.toString('latin1', 0, 2) === 'II';
    if (!le && b.toString('latin1', 0, 2) !== 'MM') throw new Error('DSM is not a TIFF file');
    const u16 = (o: number) => (le ? b.readUInt16LE(o) : b.readUInt16BE(o));
    const u32 = (o: number) => (le ? b.readUInt32LE(o) : b.readUInt32BE(o));
    const f64 = (o: number) => (le ? b.readDoubleLE(o) : b.readDoubleBE(o));
    if (u16(2) !== 42) throw new Error('BigTIFF DSMs are not supported');

    const ifd = u32(4);
    const tags = new Map<number, number[]>();
    for (let i = 0, n = u16(ifd); i < n; i++) {
        const e = ifd + 2 + i * 12;
        const tag = u16(e), type = u16(e + 2), count = u32(e + 4);
        const size = (TYPE_SIZE[type] || 1) * count;
        const at = size <= 4 ? e + 8 : u32(e + 8);
        const vals: number[] = [];
        for (let k = 0; k < count && type !== 2; k++) {
            if (type === 3) vals.push(u16(at + 2 * k));
            else if (type === 4) vals.push(u32(at + 4 * k));
            else if (type === 12) vals.push(f64(at + 8 * k));
            else if (type === 1) vals.push(b[at + k]);
        }
        tags.set(tag, vals);
    }
    const tag = (t: number) => tags.get(t) || [];
    const width = tag(256)[0], height = tag(257)[0];
    if (tag(258)[0] !== 32 || (tag(339)[0] ?? 1) !== 3) throw new Error('DSM must be 32-bit float');
    const compression = tag(259)[0] ?? 1;
    if (![1, 8, 32946].includes(compression)) throw new Error(`Unsupported DSM compression ${compression}`);
    if ((tag(317)[0] ?? 1) !== 1) throw new Error('DSM predictors are not supported');

    const data = new Float32Array(width * height).fill(NaN);
    const decode = (offset: number, count: number): Float32Array => {
        const raw = b.subarray(offset, offset + count);
        const bytes = compression === 1 ? raw : unzlibSync(raw);
        const out = new Float32Array(bytes.length / 4);
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        for (let i = 0; i < out.length; i++) out[i] = view.getFloat32(4 * i, le);
        return out;
    };
    if (tags.has(322)) {
        const tw = tag(322)[0], th = tag(323)[0], offs = tag(324), counts = tag(325);
        const across = Math.ceil(width / tw);
        offs.forEach((off, t) => {
            const px = decode(off, counts[t]);
            const x0 = (t % across) * tw, y0 = Math.floor(t / across) * th;
            for (let y = 0; y < th && y0 + y < height; y++) {
                for (let x = 0; x < tw && x0 + x < width; x++) data[(y0 + y) * width + x0 + x] = px[y * tw + x];
            }
        });
    } else {
        const rps = tag(278)[0] ?? height, offs = tag(273), counts = tag(279);
        offs.forEach((off, s) => data.set(decode(off, counts[s]).subarray(0, Math.min(rps, height - s * rps) * width), s * rps * width));
    }
    const noData = tags.get(42113);
    if (noData && noData.length) {
        const nd = Number(String.fromCharCode(...noData).replace(/\0/g, ''));
        if (Number.isFinite(nd)) for (let i = 0; i < data.length; i++) if (data[i] === nd) data[i] = NaN;
    }

    let affine: DsmRaster['affine'];
    const m = tag(34264);
    if (m.length >= 16) affine = { a0: m[3], a1: m[0], a2: m[1], b0: m[7], b1: m[4], b2: m[5] };
    else {
        const tp = tag(33922), sc = tag(33550);
        if (tp.length < 6 || sc.length < 2) throw new Error('DSM has no georeferencing');
        affine = { a0: tp[3] - tp[0] * sc[0], a1: sc[0], a2: 0, b0: tp[4] + tp[1] * sc[1], b1: 0, b2: -sc[1] };
    }
    const keys = tag(34735);
    let epsg = 0;
    for (let i = 4; i + 3 < keys.length; i += 4) if (keys[i] === 3072) epsg = keys[i + 3];
    if (!(epsg >= 32601 && epsg <= 32760)) throw new Error(`DSM projection EPSG:${epsg} is not UTM`);
    return { width, height, data, affine, epsg };
}

/** Surface height (m above sea level) at a lat/lng, bilinear between pixel centers; NaN outside the raster. */
export function sampleDsm(dsm: DsmRaster, latDeg: number, lngDeg: number): number {
    const zone = dsm.epsg % 100, south = dsm.epsg >= 32701;
    const { easting, northing } = latLngToUtm(latDeg, lngDeg, zone, south);
    const { a0, a1, a2, b0, b1, b2 } = dsm.affine;
    const det = a1 * b2 - a2 * b1;
    const col = ((easting - a0) * b2 - (northing - b0) * a2) / det - 0.5;
    const row = ((northing - b0) * a1 - (easting - a0) * b1) / det - 0.5;
    const c0 = Math.floor(col), r0 = Math.floor(row);
    if (c0 < 0 || r0 < 0 || c0 + 1 >= dsm.width || r0 + 1 >= dsm.height) return NaN;
    const fx = col - c0, fy = row - r0, w = dsm.width, d = dsm.data;
    const v00 = d[r0 * w + c0], v10 = d[r0 * w + c0 + 1], v01 = d[(r0 + 1) * w + c0], v11 = d[(r0 + 1) * w + c0 + 1];
    return v00 * (1 - fx) * (1 - fy) + v10 * fx * (1 - fy) + v01 * (1 - fx) * fy + v11 * fx * fy;
}

/**
 * Fetch the Solar API DSM around a point (dataLayers:get, DSM only) and parse it. Throws with the API's message when
 * there is no coverage, so callers can fall back to vector heights and say why.
 */
export async function fetchSolarDsm(
    latDeg: number,
    lngDeg: number,
    radiusMeters: number,
    apiKey: string,
    options: { pixelSizeMeters?: number; fetchImpl?: typeof fetch } = {}
): Promise<DsmRaster & { imageryDate?: string }> {
    if (!apiKey) throw new Error('A Google Maps API key is required for the Solar API DSM.');
    const f = options.fetchImpl ?? fetch;
    const params = new URLSearchParams({
        'location.latitude': String(latDeg),
        'location.longitude': String(lngDeg),
        radiusMeters: String(Math.round(radiusMeters)),
        view: 'DSM_LAYER',
        requiredQuality: 'MEDIUM',
        pixelSizeMeters: String(options.pixelSizeMeters ?? 0.5),
        key: apiKey
    });
    const res = await f(`https://solar.googleapis.com/v1/dataLayers:get?${params}`);
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok || !json.dsmUrl) {
        throw new Error(`Solar DSM unavailable (${res.status}): ${json?.error?.message || 'no dsmUrl in response'}`);
    }
    const tif = await f(`${json.dsmUrl}&key=${apiKey}`);
    if (!tif.ok) throw new Error(`Solar DSM download failed (${tif.status}).`);
    const raster = parseDsmGeoTiff(Buffer.from(await tif.arrayBuffer()));
    const d = json.imageryDate;
    return { ...raster, imageryDate: d ? `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}` : undefined };
}
