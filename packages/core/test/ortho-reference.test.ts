/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The Static Maps satellite reference: its ground sample distance at a known latitude and zoom, the orthographic camera that
 * reproduces it in the tile frame, and the fetch through a stubbed fetch (a tiny PNG decoded; nothing reaches Google).
 */

import { describe, expect, it } from 'vitest';
import { encodePng } from '../src/node/3d-engine/staged-location/png-encode';
import {
    fetchOrthoReference, orthoReferenceCamera, orthoReferenceRecord, projectOrtho, staticMapsSatelliteUrl, webMercatorPixelMetres,
    STATIC_MAPS_NO_DATE_NOTE, WEB_MERCATOR_EQUATOR_M_PER_PX
} from '../src/node/3d-engine/staged-location/ortho-reference';

describe('ortho reference (Static Maps satellite crop)', () => {
    it('computes the Web Mercator ground sample distance: 156543.03392 cos(lat) / 2^zoom / scale', () => {
        expect(webMercatorPixelMetres(0, 0, 1)).toBeCloseTo(WEB_MERCATOR_EQUATOR_M_PER_PX, 3);
        // the Empire State Building's latitude at zoom 19: 0.2262 m/px at scale 1, half that at scale 2
        expect(webMercatorPixelMetres(40.7484, 19, 1)).toBeCloseTo(0.22620081814592086, 3);
        expect(webMercatorPixelMetres(40.7484, 19, 2)).toBeCloseTo(0.11310040907296043, 3);
        // London at zoom 20, scale 2
        expect(webMercatorPixelMetres(51.5, 20, 2)).toBeCloseTo(0.04646793836539237, 3);
        const rec = orthoReferenceRecord({ lat: 40.7484, lng: -73.9857, zoom: 19, scale: 2, widthPx: 2048, heightPx: 2048 });
        expect(rec.pixelM).toBeCloseTo(0.1131, 3);
        expect(rec.widthM).toBeCloseTo(0.11310040907296043 * 2048, 3);
        expect(rec.heightM).toBeCloseTo(rec.widthM, 6);
        // no capture date is known, and the record says so
        expect(rec.capturedAt).toBeUndefined();
        expect(rec.captureDateNote).toBe(STATIC_MAPS_NO_DATE_NOTE);
        expect(rec.source).toBe('google_static_maps');
    });

    it('builds the top-down camera in the tile frame: +10 m east lands 10 / pixelM pixels right of centre, south is down', () => {
        const rec = orthoReferenceRecord({ lat: 40.7484, lng: -73.9857, zoom: 19, scale: 2, widthPx: 2048, heightPx: 2048 });
        const cam = orthoReferenceCamera(rec);
        expect(cam.projection).toBe('ortho');
        expect(cam.pixelM).toBe(rec.pixelM);
        expect(cam.fwd).toEqual([0, -1, 0]);
        const centre = projectOrtho(cam, [0, 0, 0]);
        expect(centre.x).toBeCloseTo(1024, 9);
        expect(centre.y).toBeCloseTo(1024, 9);
        expect(centre.depth).toBeCloseTo(2000, 9);
        const east = projectOrtho(cam, [10, 0, 0]);
        expect(east.x - centre.x).toBeCloseTo(10 / rec.pixelM, 6);
        expect(east.y).toBeCloseTo(centre.y, 9);
        // the tile frame's +z is south: it moves down the image; height changes only the depth
        const south = projectOrtho(cam, [0, 30, 5]);
        expect(south.y - centre.y).toBeCloseTo(5 / rec.pixelM, 6);
        expect(south.x).toBeCloseTo(centre.x, 9);
        expect(south.depth).toBeCloseTo(1970, 9);
        expect(orthoReferenceCamera(rec, { eyeHeightM: 500 }).eye).toEqual([0, 500, 0]);
    });

    it('fetches the satellite PNG through the given fetch and decodes it; the request names the crop and the key goes nowhere else', async () => {
        const rgba = new Uint8Array(4 * 3 * 4);
        for (let i = 0; i < 12; i++) rgba.set([200, 30 + i, 40, 255], i * 4);
        const png = encodePng(4, 3, rgba, 4);
        const urls: string[] = [];
        const fetchImpl = (async (url: string | URL | Request) => {
            urls.push(String(url));
            return new Response(png, { status: 200, headers: { 'content-type': 'image/png' } });
        }) as unknown as typeof fetch;
        const ref = await fetchOrthoReference({ lat: 40.7484, lng: -73.9857, apiKey: 'test-key', fetchImpl });
        expect(urls).toHaveLength(1);
        const u = new URL(urls[0]);
        expect(u.origin + u.pathname).toBe('https://maps.googleapis.com/maps/api/staticmap');
        expect(u.searchParams.get('center')).toBe('40.7484,-73.9857');
        expect(u.searchParams.get('zoom')).toBe('19');
        expect(u.searchParams.get('size')).toBe('1024x1024');
        expect(u.searchParams.get('scale')).toBe('2');
        expect(u.searchParams.get('maptype')).toBe('satellite');
        expect(u.searchParams.get('format')).toBe('png32');
        expect(u.searchParams.get('key')).toBe('test-key');
        // the record follows the decoded image (what Google returned), the GSD the latitude, zoom and scale
        expect(ref.widthPx).toBe(4);
        expect(ref.heightPx).toBe(3);
        expect(ref.pixelM).toBeCloseTo(0.1131, 3);
        expect(ref.widthM).toBeCloseTo(4 * 0.11310040907296043, 3);
        expect(Array.from(ref.image.rgba.subarray(0, 4))).toEqual([200, 30, 40, 255]);
        expect(Array.from(ref.image.rgba.subarray(11 * 4, 12 * 4))).toEqual([200, 41, 40, 255]);
        expect(ref.bytes.equals(png)).toBe(true);
        expect(ref.capturedAt).toBeUndefined();
        expect(JSON.stringify(ref).includes('test-key')).toBe(false);
        expect(staticMapsSatelliteUrl({ lat: 1, lng: 2, zoom: 20, sizePx: 640, scale: 1, apiKey: 'k' })).toContain('zoom=20&size=640x640&scale=1');
    });

    it('refuses without a key and surfaces an HTTP failure instead of inventing an image', async () => {
        await expect(fetchOrthoReference({ lat: 0, lng: 0, apiKey: '', fetchImpl: (async () => { throw new Error('must not be called'); }) as unknown as typeof fetch })).rejects.toThrow(/API key/);
        const failing = (async () => new Response('REQUEST_DENIED', { status: 403 })) as unknown as typeof fetch;
        await expect(fetchOrthoReference({ lat: 0, lng: 0, apiKey: 'k', fetchImpl: failing })).rejects.toThrow(/HTTP 403 REQUEST_DENIED/);
    });
});
