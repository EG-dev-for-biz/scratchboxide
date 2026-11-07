/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The scene weather's sky, from the native engine (GET /api/sky/multiple-scattering, native-sky-ms-service.ts):
 * García Liñán's multiple-scattering clear sky (vendored from Blender, MIT), as a sky-view table in physical-sky.ts's
 * layout and units, so the dome draws it as it draws the TypeScript spectral sky. Tables are kept by their inputs (the
 * sun to 0.05 degrees, the turbidity to 0.01), so dragging the Weather tool's time back and forth asks once per sun.
 */

import type { PhysicalSkyLut } from './physical-sky';

export const MULTIPLE_SCATTERING_SKY_MODEL = 'multiple-scattering';

/** The dome's table size (physical-sky.ts's own default). */
const W = 64, H = 48;
const cache = new Map<string, Promise<PhysicalSkyLut>>();

export function multipleScatteringSkyKey(sunElevationDeg: number, turbidity: number): string {
    return `${(Math.round(sunElevationDeg * 20) / 20).toFixed(2)}|${turbidity.toFixed(2)}`;
}

/** A table already fetched for these inputs (undefined while it is on its way, or never asked for). */
const settled = new Map<string, PhysicalSkyLut>();
export function cachedMultipleScatteringSky(sunElevationDeg: number, turbidity: number): PhysicalSkyLut | undefined {
    return settled.get(multipleScatteringSkyKey(sunElevationDeg, turbidity));
}

function decode(b64: string): Float32Array {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Float32Array(bytes.buffer);
}

/** The table for one sun and haze. Rejects with the server's reason when the native sky fails. */
export function fetchMultipleScatteringSky(sunElevationDeg: number, turbidity: number, fetchImpl: typeof fetch = fetch): Promise<PhysicalSkyLut> {
    const key = multipleScatteringSkyKey(sunElevationDeg, turbidity);
    let hit = cache.get(key);
    if (!hit) {
        const [el, t] = key.split('|');
        hit = fetchImpl(`/api/sky/multiple-scattering?sunElevationDeg=${el}&turbidity=${t}&azimuthResolution=${W}&elevationResolution=${H}`)
            .then(async res => {
                const body = await res.json().catch(() => ({ success: false, error: `HTTP ${res.status}` })) as {
                    success: boolean; error?: string;
                    table?: { dataBase64: string; azimuthResolution: number; elevationResolution: number; horizontalIrradiance: [number, number, number]; sunTransmittance: [number, number, number] };
                };
                if (!res.ok || !body.success || !body.table) throw new Error(`multiple-scattering sky: ${body.error ?? `HTTP ${res.status}`}`);
                const tb = body.table;
                const lut: PhysicalSkyLut = {
                    data: decode(tb.dataBase64),
                    azimuthResolution: tb.azimuthResolution,
                    elevationResolution: tb.elevationResolution,
                    horizontalIrradiance: tb.horizontalIrradiance,
                    sunTransmittance: tb.sunTransmittance
                };
                if (lut.data.length !== lut.azimuthResolution * lut.elevationResolution * 3) throw new Error('multiple-scattering sky: the table has the wrong size');
                settled.set(key, lut);
                if (settled.size > 256) settled.delete(settled.keys().next().value as string);
                return lut;
            });
        hit.catch(() => cache.delete(key));
        if (cache.size > 256) cache.delete(cache.keys().next().value as string);
        cache.set(key, hit);
    }
    return hit;
}
