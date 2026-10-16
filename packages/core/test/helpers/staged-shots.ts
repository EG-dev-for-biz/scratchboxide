/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Screenshots of staged-build layers for the native suites: clay renders of one or more GLBs (each its own colour) from a
 * chosen bearing and elevation, saved to test-results/screenshots/staged/<name>.png (gitignored) with the share of the
 * picture they cover, so a test can assert that a render is not blank.
 */

import * as fs from 'fs';
import * as path from 'path';
import { decodePng } from '../../src/node/texture-processing';
import { readGlbTriangles, renderClayPng, type ClayLayer, type ClayView } from './clay-glb-render';

export const SHOT_DIR = path.resolve(__dirname, '../../../..', 'test-results/screenshots/staged');

export type ShotLayer = { file: string; color?: [number, number, number] };

export interface Shot { path: string; covered: number; width: number; height: number }

/** The layers' bounds in the tile frame. */
function bounds(layers: ClayLayer[]): { x0: number; x1: number; z0: number; z1: number; y0: number; y1: number } {
    const b = { x0: Infinity, x1: -Infinity, z0: Infinity, z1: -Infinity, y0: Infinity, y1: -Infinity };
    for (const l of layers) for (let v = 0; v < l.positions.length; v += 3) {
        b.x0 = Math.min(b.x0, l.positions[v]); b.x1 = Math.max(b.x1, l.positions[v]);
        b.y0 = Math.min(b.y0, l.positions[v + 1]); b.y1 = Math.max(b.y1, l.positions[v + 1]);
        b.z0 = Math.min(b.z0, l.positions[v + 2]); b.z1 = Math.max(b.z1, l.positions[v + 2]);
    }
    return b;
}

/** Renders the GLBs together (later layers over earlier ones), framed so that the tallest structure is whole. */
export function saveClayShot(name: string, files: ShotLayer[], view: Partial<ClayView> & { kind?: 'top' | 'aerial' } = {}, size: [number, number] = [900, 650]): Shot {
    const layers: ClayLayer[] = files.map(f => {
        const t = readGlbTriangles(fs.readFileSync(f.file));
        return { positions: t.positions, indices: t.indices, color: f.color };
    });
    const b = bounds(layers);
    const span = Math.max(b.x1 - b.x0, b.z1 - b.z0, (b.y1 - b.y0) * 1.1) * (view.kind === 'top' ? 1.1 : 2.1);
    const cx = (b.x0 + b.x1) / 2, cz = (b.z0 + b.z1) / 2;
    const png = renderClayPng(layers, { kind: 'aerial', width: size[0], height: size[1], bearingDeg: 210, elevationDeg: 22, region: [cx - span / 2, cz - span / 2, cx + span / 2, cz + span / 2], ...view });
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    const out = path.join(SHOT_DIR, `${name}.png`);
    fs.writeFileSync(out, png);
    const img = decodePng(png);
    let covered = 0;
    for (let i = 0; i < img.width * img.height; i++) {
        const o = i * 4; // DecodedImage.rgba is 4 bytes per pixel
        if (Math.abs(img.rgba[o] - 236) > 3 || Math.abs(img.rgba[o + 1] - 237) > 3 || Math.abs(img.rgba[o + 2] - 240) > 3) covered++;
    }
    return { path: out, covered: covered / (img.width * img.height), width: img.width, height: img.height };
}
