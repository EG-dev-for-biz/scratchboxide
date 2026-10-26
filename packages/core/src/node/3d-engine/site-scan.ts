/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The 3D-tiles scan of a site's building, handed to a procedural script beside its measured massing: sb.site_tiers reads
 * setback tiers from it (sb.massing) when Google has no modeled volume, and sb.site_score measures what the script built
 * against it (height-balanced coverage and precision). The scan is the structure the staged extraction isolates (the
 * same cached extraction the facade and crown use), written with the street at y = 0 so it shares sb.site_tiers' frame.
 */

import * as fs from 'fs';
import * as path from 'path';
import { prepareSurveySite } from '../gemini/tools/location-evidence/streetview-survey';
import { createStagedLocationDeps } from './staged-location/staged-location-tool';
import { stagedWorkspaceRoot } from './staged-location/stage-cache';
import { writeTrianglesGlb } from './site-crown';
import type { SiteMassing } from './site-massing';

export interface SiteScan {
    /** GLB of the isolated structure's tile triangles: x east, z south from the place point, y above the street. */
    glbPath: string;
    /** The street's height in that frame (0: the scan is shifted to it). */
    groundY: number;
    /** The structure's outline as the extraction picked it (x, z), for sb.massing's plan. */
    plan: Array<Array<[number, number]>>;
    triangles: number;
    heightM: number;
    source: string;
}

export async function measureSiteScan(massing: SiteMassing, opts: { workspaceRoot: string; signal?: AbortSignal; progress?: (m: string) => void }): Promise<SiteScan> {
    const deps = await createStagedLocationDeps(stagedWorkspaceRoot(), opts.signal ? { signal: opts.signal } : {});
    (opts.progress ?? (() => undefined))('site scan: the 3D tiles of the building (extraction cached for 7 days)');
    const site = await prepareSurveySite({ lat: massing.place.lat, lng: massing.place.lng, query: massing.place.resolvedAs }, deps, { ...(opts.signal ? { signal: opts.signal } : {}), ...(opts.progress ? { onProgress: opts.progress } : {}) });
    const v = site.structureMesh.vertices, ix = site.structureMesh.indices;
    const g = site.structure.groundY;
    const pos = new Float32Array(v.length);
    let top = 0;
    for (let i = 0; i < v.length; i += 3) { pos[i] = v[i]; pos[i + 1] = v[i + 1] - g; pos[i + 2] = v[i + 2]; top = Math.max(top, pos[i + 1]); }
    const dir = path.join(opts.workspaceRoot, 'build', 'site-scan', `${massing.place.lat.toFixed(5)}_${massing.place.lng.toFixed(5)}`);
    fs.mkdirSync(dir, { recursive: true });
    const glbPath = path.join(dir, 'structure_scan.glb');
    writeTrianglesGlb(glbPath, pos, Uint32Array.from(ix as ArrayLike<number>));
    return {
        glbPath, groundY: 0, plan: [site.structure.outline.map(p => [p[0], p[1]] as [number, number])], triangles: ix.length / 3, heightM: top,
        source: `Google 3D Tiles, the structure the staged extraction isolates (${site.structureMeshSource})`
    };
}
