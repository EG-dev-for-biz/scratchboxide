/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * A top-down satellite reference for the photo-match judge: one Google Static Maps `satellite` image centred on the place,
 * its ground sample distance, and the orthographic camera that reproduces it in the tile frame (x east, y up, z south,
 * metres, origin at the anchor), so a build can be rendered top-down at the same scale and shown beside it.
 *
 * Static Maps is a Web Mercator raster: metres per pixel = 156543.03392 * cos(lat) / 2^zoom / scale (the equator's 256-px
 * zoom-0 tile over the Mercator scale factor), uniform across a crop a few hundred metres wide to well under a percent. The
 * image is north-up, so image x is east and image y is south: the camera's `right` is +x, its `up` is -z (north) and it
 * looks down -y.
 *
 * Static Maps carries no capture date: the imagery's age is unknown and is reported as such (`capturedAt` undefined,
 * `captureDateNote`). It is a second opinion for the judge; the tile photo's own roof ortho stays the first.
 */

import type { DecodedImage, OrthoCamera } from '../../../common/spatial/texture-pass-contracts';
import { decodePng } from '../../texture-processing';

/** Metres per pixel of a 256-px Web Mercator tile at zoom 0 on the equator. */
export const WEB_MERCATOR_EQUATOR_M_PER_PX = 156543.03392;

/** Ground sample distance (metres per output pixel) of a Static Maps image at `zoom` and `scale` on latitude `latDeg`. */
export function webMercatorPixelMetres(latDeg: number, zoom: number, scale = 1): number {
    return (WEB_MERCATOR_EQUATOR_M_PER_PX * Math.cos((latDeg * Math.PI) / 180)) / Math.pow(2, zoom) / scale;
}

/** What is known about one satellite reference image: where it is, how big a pixel is, and that its date is not known. */
export interface OrthoReferenceRecord {
    source: 'google_static_maps';
    mapType: 'satellite';
    centre: { lat: number; lng: number };
    zoom: number;
    scale: number;
    /** Pixel size of the decoded image (size x scale). */
    widthPx: number;
    heightPx: number;
    /** Ground sample distance, metres per pixel. */
    pixelM: number;
    /** Ground extent the image covers, metres. */
    widthM: number;
    heightM: number;
    /** Static Maps does not say when its imagery was captured; this is always undefined. */
    capturedAt?: undefined;
    captureDateNote: string;
    attribution: string;
}

export interface OrthoReference extends OrthoReferenceRecord {
    /** The PNG as fetched. */
    bytes: Buffer;
    /** The decoded image (RGBA8). */
    image: DecodedImage;
}

export const STATIC_MAPS_NO_DATE_NOTE = 'Google Static Maps carries no capture date: the satellite imagery\'s age is unknown.';

export interface OrthoReferenceRequest {
    lat: number;
    lng: number;
    /** Static Maps zoom (default 19; 20 where Google serves it). */
    zoom?: number;
    /** Requested side in CSS pixels (default 1024, the API's maximum at scale 2). */
    sizePx?: number;
    /** Static Maps scale (1 or 2; default 2, so the image is sizePx x 2 on each side). */
    scale?: 1 | 2;
    /** Maps Platform API key. */
    apiKey: string;
    fetchImpl?: typeof fetch;
    signal?: AbortSignal;
}

/** The record for an image of `widthPx` x `heightPx` at `zoom` / `scale` centred on the anchor (no network). */
export function orthoReferenceRecord(input: { lat: number; lng: number; zoom: number; scale: number; widthPx: number; heightPx: number }): OrthoReferenceRecord {
    const pixelM = webMercatorPixelMetres(input.lat, input.zoom, input.scale);
    return {
        source: 'google_static_maps', mapType: 'satellite',
        centre: { lat: input.lat, lng: input.lng }, zoom: input.zoom, scale: input.scale,
        widthPx: input.widthPx, heightPx: input.heightPx,
        pixelM, widthM: pixelM * input.widthPx, heightM: pixelM * input.heightPx,
        capturedAt: undefined, captureDateNote: STATIC_MAPS_NO_DATE_NOTE,
        attribution: 'Imagery (c) Google, via the Maps Static API'
    };
}

/** The Static Maps URL for a request (truecolor PNG, no markers or labels). The key travels only in this request. */
export function staticMapsSatelliteUrl(r: { lat: number; lng: number; zoom: number; sizePx: number; scale: number; apiKey: string }): string {
    const q = new URLSearchParams({
        center: `${r.lat},${r.lng}`, zoom: String(r.zoom), size: `${r.sizePx}x${r.sizePx}`, scale: String(r.scale),
        maptype: 'satellite', format: 'png32', key: r.apiKey
    });
    return `https://maps.googleapis.com/maps/api/staticmap?${q}`;
}

/**
 * Fetches the satellite image centred on (lat, lng) through `fetchImpl` and decodes it. The record's pixel size is the
 * decoded image's (what Google returned), and the ground sample distance follows from the latitude, zoom and scale.
 */
export async function fetchOrthoReference(req: OrthoReferenceRequest): Promise<OrthoReference> {
    if (!req.apiKey) throw new Error('A Google Maps Platform API key is needed for the Static Maps satellite reference (GOOGLE_MAPS_API_KEY or Settings).');
    const zoom = req.zoom ?? 19, sizePx = req.sizePx ?? 1024, scale = req.scale ?? 2;
    const fetchImpl = req.fetchImpl ?? fetch;
    const res = await fetchImpl(staticMapsSatelliteUrl({ lat: req.lat, lng: req.lng, zoom, sizePx, scale, apiKey: req.apiKey }), req.signal ? { signal: req.signal } : {});
    if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`Static Maps satellite image at ${req.lat}, ${req.lng} zoom ${zoom}: HTTP ${res.status}${detail ? ` ${detail.slice(0, 200)}` : ''}`);
    }
    const bytes = Buffer.from(await res.arrayBuffer());
    const image = decodePng(bytes);
    return { ...orthoReferenceRecord({ lat: req.lat, lng: req.lng, zoom, scale, widthPx: image.width, heightPx: image.height }), bytes, image };
}

/**
 * The orthographic camera that reproduces the reference in the tile frame: above the anchor at `eyeHeightM` (default
 * 2000 m, over any building), looking straight down, image x east and image y south, one pixel = `pixelM` metres. A point
 * d metres east of the anchor lands d / pixelM pixels right of the image centre.
 */
export function orthoReferenceCamera(record: Pick<OrthoReferenceRecord, 'pixelM' | 'widthPx' | 'heightPx'>, options: { eyeHeightM?: number } = {}): OrthoCamera {
    return {
        projection: 'ortho',
        eye: [0, options.eyeHeightM ?? 2000, 0], right: [1, 0, 0], up: [0, 0, -1], fwd: [0, -1, 0],
        pixelM: record.pixelM, cx: record.widthPx / 2, cy: record.heightPx / 2, width: record.widthPx, height: record.heightPx
    };
}

/** Pixel position of a tile-frame point in an ortho camera's image (x right, y down), with its depth along the view. */
export function projectOrtho(cam: OrthoCamera, p: [number, number, number]): { x: number; y: number; depth: number } {
    const dx = p[0] - cam.eye[0], dy = p[1] - cam.eye[1], dz = p[2] - cam.eye[2];
    const rx = dx * cam.right[0] + dy * cam.right[1] + dz * cam.right[2];
    const uy = dx * cam.up[0] + dy * cam.up[1] + dz * cam.up[2];
    const depth = dx * cam.fwd[0] + dy * cam.fwd[1] + dz * cam.fwd[2];
    return { x: cam.cx + rx / cam.pixelM, y: cam.cy - uy / cam.pixelM, depth };
}
