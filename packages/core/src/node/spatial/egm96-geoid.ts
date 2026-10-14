/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * EGM96 geoid undulation N (meters): the height of mean sea level above the WGS84 ellipsoid.
 * Photorealistic 3D Tiles are in ellipsoid heights; the Elevation API and the Solar DSM are above mean sea level:
 *   h_ellipsoid = h_msl + N
 * N ranges from about -107 m to +85 m worldwide (about -32.7 m in Manhattan), so a fixed offset is only right locally.
 */
import * as fs from 'fs';
import * as path from 'path';

interface GeoidGrid {
    width: number;
    height: number;
    offset: number;
    scale: number;
    values: Uint16Array;
}

let grid: GeoidGrid | undefined;

export const EGM96_GRID_PATH = path.resolve(__dirname, '../../../data/geoid/egm96-15.pgm');

/** Parse GeographicLib's 16-bit PGM geoid format (header comments carry Offset and Scale). */
export function parseGeoidPgm(buf: Buffer): GeoidGrid {
    if (buf.toString('latin1', 0, 2) !== 'P5') throw new Error('Geoid grid is not a binary PGM file');
    let pos = 2, offset = NaN, scale = NaN;
    const fields: number[] = [];
    while (fields.length < 3) {
        while (/\s/.test(String.fromCharCode(buf[pos]))) pos++;
        if (buf[pos] === 0x23) {
            const end = buf.indexOf(0x0a, pos);
            const line = buf.toString('latin1', pos, end);
            const m = /^#\s*(Offset|Scale)\s+(\S+)/.exec(line);
            if (m) (m[1] === 'Offset' ? (offset = Number(m[2])) : (scale = Number(m[2])));
            pos = end + 1;
            continue;
        }
        const start = pos;
        while (!/\s/.test(String.fromCharCode(buf[pos]))) pos++;
        fields.push(Number(buf.toString('latin1', start, pos)));
    }
    pos++; // single whitespace before the raster
    const [width, height, maxval] = fields;
    if (maxval !== 65535 || !Number.isFinite(offset) || !Number.isFinite(scale)) throw new Error('Unexpected geoid PGM header');
    const values = new Uint16Array(width * height);
    for (let i = 0; i < values.length; i++) values[i] = buf.readUInt16BE(pos + 2 * i);
    return { width, height, offset, scale, values };
}

function loadGrid(): GeoidGrid {
    if (!grid) {
        if (!fs.existsSync(EGM96_GRID_PATH)) throw new Error(`EGM96 geoid grid not found at ${EGM96_GRID_PATH}`);
        grid = parseGeoidPgm(fs.readFileSync(EGM96_GRID_PATH));
    }
    return grid;
}

/** Geoid undulation N in meters at a WGS84 lat/lng (bilinear on the 15' grid; 4 cm RMS). */
export function geoidUndulation(latDeg: number, lngDeg: number, g: GeoidGrid = loadGrid()): number {
    const step = 180 / (g.height - 1);
    const lng = ((lngDeg % 360) + 360) % 360;
    const fy = (90 - Math.max(-90, Math.min(90, latDeg))) / step;
    const fx = lng / step;
    const y0 = Math.min(g.height - 2, Math.floor(fy)), x0 = Math.floor(fx) % g.width;
    const x1 = (x0 + 1) % g.width, ty = fy - y0, tx = fx - Math.floor(fx);
    const v = (x: number, y: number) => g.offset + g.scale * g.values[y * g.width + x];
    return (1 - ty) * ((1 - tx) * v(x0, y0) + tx * v(x1, y0)) + ty * ((1 - tx) * v(x0, y0 + 1) + tx * v(x1, y0 + 1));
}

/** Height above mean sea level (EGM96) to height above the WGS84 ellipsoid. */
export function mslToEllipsoid(heightMsl: number, latDeg: number, lngDeg: number): number {
    return heightMsl + geoidUndulation(latDeg, lngDeg);
}

/** Height above the WGS84 ellipsoid to height above mean sea level (EGM96). */
export function ellipsoidToMsl(heightEllipsoid: number, latDeg: number, lngDeg: number): number {
    return heightEllipsoid - geoidUndulation(latDeg, lngDeg);
}
