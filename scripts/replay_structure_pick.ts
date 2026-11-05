/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Replays only the structure pick of an isolated staged build (extraction-sizing.ts sizeExtraction) for a place: the
 * real extraction and Google vector evidence, written to a scratch workspace, and the pick, the footprint chosen and the
 * vector buildings near it printed as JSON, with a top-down picture of the pick (green), the chosen footprint (outline)
 * and the raised scan (grey). No remesh, no model calls.
 *
 *   npx vite-node scripts/replay_structure_pick.ts -- --query "Flatiron Building, New York" --out <dir>
 */

import * as fs from 'fs';
import * as path from 'path';
import { createStagedLocationDeps } from '../packages/core/src/node/3d-engine/staged-location/staged-location-tool';
import { sizeExtraction, PICK_STRUCTURE } from '../packages/core/src/node/3d-engine/staged-location/extraction-sizing';
import { evidenceLookup } from '../packages/core/src/node/3d-engine/staged-location/vector-footprints';
import { encodePng } from '../packages/core/src/node/3d-engine/staged-location/png-encode';

function arg(name: string): string | undefined {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
    const query = arg('query');
    const out = arg('out');
    if (!query || !out) throw new Error('usage: --query <place> --out <dir>');
    fs.mkdirSync(out, { recursive: true });
    const workspace = path.resolve(arg('workspace') ?? path.join(out, 'workspace'));
    fs.mkdirSync(workspace, { recursive: true });
    const deps = await createStagedLocationDeps(workspace);
    const place = await deps.geocode(query);
    const ctl = new AbortController();
    let n = 0;
    const sizing = await sizeExtraction({
        extract: async (radiusM: number) => deps.extract({ lat: place.lat, lng: place.lng, radiusM, outDir: path.join(workspace, `extract_r${Math.round(radiusM)}_${n++}`), place, signal: ctl.signal, onProgress: () => undefined }),
        ...(deps.vegetation.canopy ? { canopy: async (tile: string) => (await deps.vegetation.canopy!({ tilePath: tile, signal: ctl.signal })).mask } : {}),
        ...(deps.vectorEvidence ? { vector: async (radiusM: number) => {
            const ev = await deps.vectorEvidence!({ lat: place.lat, lng: place.lng, radiusM });
            fs.writeFileSync(path.join(out, 'vector_evidence.json'), JSON.stringify(ev));
            return evidenceLookup(ev, radiusM);
        } } : {}),
        placeName: query, onProgress: m => console.error(`[pick] ${m}`), signal: ctl.signal
    });
    const s = sizing.structure;
    const report = {
        query, place, radiusM: sizing.radiusM, rounds: sizing.rounds, sizedTo: sizing.sizedTo, notes: sizing.notes, vectorError: sizing.vectorError,
        extraction: sizing.extraction.texturedGlb, grid: sizing.ground ? { x0: sizing.ground.x0, z0: sizing.ground.z0, nx: sizing.ground.nx, nz: sizing.ground.nz } : undefined,
        pick: s ? { seed: s.seed, areaM2: s.areaM2, heightM: s.heightM, bounds: s.bounds, coreHeightM: s.coreHeightM, footprintSource: s.footprintSource, vectorFootprint: s.vectorFootprint } : undefined
    };
    fs.writeFileSync(path.join(out, 'pick.json'), JSON.stringify(report, null, 1));
    console.log(JSON.stringify(report, null, 1));
    if (s && sizing.ground) {
        const g = sizing.ground, N = g.nx * g.nz, rgb = Buffer.alloc(N * 3);
        const target = s.vectorFootprint?.choice?.target;
        for (let c = 0; c < N; c++) {
            const x = g.x0 + ((c % g.nx) + 0.5) * g.cellMeters, z = g.z0 + (((c / g.nx) | 0) + 0.5) * g.cellMeters;
            const h = g.top[c] - g.ground[c];
            const v = h === h ? Math.max(20, Math.min(200, 40 + h * 2)) : 0;
            let r = v, gg = v, b = v;
            const fb = sizing.vector?.buildingAt(x, z) ?? 0;
            if (fb) b = Math.min(255, b + 40);
            if (sizing.vector?.roadAt(x, z)) { r = 0; gg = 0; b = 255; }
            if (s.footprintMask[c] === PICK_STRUCTURE) { r = 40; gg = 200; b = 60; }
            if (target && fb === target) { r = Math.min(255, r + 120); }
            rgb[c * 3] = r; rgb[c * 3 + 1] = gg; rgb[c * 3 + 2] = b;
        }
        fs.writeFileSync(path.join(out, 'pick.png'), encodePng(g.nx, g.nz, rgb, 3));
    }
    process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
