/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The measured massing of a real building, for sizing a procedural script's building (sb.site / sb.site_tiers).
 *
 * Sources, never averaged, each labelled:
 *   - a building Google models as a 3D volume is sliced by the native scan analysis into its flat levels: one tier per
 *     step of the setback stack, each with its plan outline (vector-modelled);
 *   - a building Google extrudes is one tier per vector part, from the part's min to max height (vector-modelled);
 *   - a part with no vector height takes the fused height (Solar DSM where it covers the footprint) with its confidence.
 * The frame is the tile frame the generator uses: x east, z south, metres from the place point, y up from the lowest
 * point of the building. Storeys are not measured here; sb.site_tiers splits each tier into storeys by norms and says so.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runBuildingShape, type BuildingShapeResult } from '../gemini/tools/location-evidence/building-shape';
import { runShapeTool } from './staged-location/pipeline-e/shape-program';

export interface SiteTier {
    baseM: number;
    topM: number;
    areaM2: number;
    /** Plan loops [x east, z south] (first outer; the native scan's squared outlines, or the vector part's ring and holes). */
    loops: Array<Array<[number, number]>>;
    provenance: 'vector-modelled' | 'measured';
    source: string;
    confidence: number;
}

export interface SiteMassing {
    place: { query: string; resolvedAs: string; lat: number; lng: number };
    frame: string;
    /** Highest point the vector data reaches (a modeled volume's antenna or spire can rise above its sliced tiers). */
    topM?: number;
    tiers: SiteTier[];
    /** The facade grid's direction, degrees from +x, when the scan measured it (walls of a gridded city are rotated). */
    wallDirectionDeg?: number;
    footprintAreaM2: number;
    notes: string[];
}

const toSouth = (ring: Array<[number, number]>): Array<[number, number]> => ring.map(([e, n]) => [e, -n]);

/** Tiers of a modeled volume: the native scan analysis of the vector GLB (no model, well under a second). */
async function sliceModeled(shape: BuildingShapeResult, glb: string, workDir: string, signal?: AbortSignal): Promise<{ tiers: SiteTier[]; notes: string[]; directionDeg?: number }> {
    const hull = toSouth(shape.target.footprint.parts[0].ringLocalMeters as Array<[number, number]>);
    const dir = path.join(workDir, 'scan');
    const spec = ['mode scan', `out ${dir}`, `isolate ${glb}`, 'ground 0',
        `footprint ${hull.length} ${hull.map(p => `${p[0]} ${p[1]}`).join(' ')}`].join('\n') + '\n';
    await runShapeTool(spec, dir, signal ? { signal } : {});
    const doc = JSON.parse(fs.readFileSync(path.join(dir, 'scan.json'), 'utf8')) as {
        frame: { theta: number };
        tiers: Array<{ baseY: number; topY: number; areaM2: number; loops: Array<Array<[number, number]>> }>;
        notes: string[];
    };
    const tiers = doc.tiers.filter(t => t.topY - t.baseY > 0.05 && t.loops.length > 0).map(t => ({
        baseM: t.baseY, topM: t.topY, areaM2: t.areaM2, loops: t.loops,
        provenance: 'vector-modelled' as const,
        source: 'Google vector data modeled volume, sliced at its flat levels (native scan analysis)',
        confidence: 0.85
    }));
    return { tiers, notes: doc.notes, directionDeg: (doc.frame.theta * 180) / Math.PI };
}

/** Measures the building at `place` (a name, address or "lat, lng"). Throws BuildingShapeError when there is none. */
export async function measureSiteMassing(place: string, opts: { workspaceRoot: string; signal?: AbortSignal; progress?: (m: string) => void }): Promise<SiteMassing> {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-site-'));
    const coords = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(place);
    const shape = await runBuildingShape(
        coords ? { latitude: Number(coords[1]), longitude: Number(coords[2]), roofSegments: false, outputDir: workDir }
               : { location: place, roofSegments: false, outputDir: workDir },
        { workspaceRoot: opts.workspaceRoot, ...(opts.progress ? { progress: opts.progress } : {}) });
    const t = shape.target;
    const notes: string[] = [`footprint: ${t.footprint.chosen} (${t.footprint.why})`];
    let tiers: SiteTier[] = [];
    let directionDeg: number | undefined;
    if (t.vector.kind === 'modeled' && t.vector.modeledGlbPath) {
        const sliced = await sliceModeled(shape, t.vector.modeledGlbPath, workDir, opts.signal);
        tiers = sliced.tiers;
        directionDeg = sliced.directionDeg;
        notes.push(...sliced.notes);
    }
    if (!tiers.length) {
        for (const p of t.footprint.parts) {
            const top = p.vectorHeightMeters ?? t.fusion?.heightMeters;
            if (top === undefined) continue;
            const fromVector = p.vectorHeightMeters !== undefined;
            tiers.push({
                baseM: p.vectorMinHeightMeters ?? 0, topM: top, areaM2: p.areaM2,
                loops: [toSouth(p.ringLocalMeters as Array<[number, number]>)],
                provenance: fromVector ? 'vector-modelled' : 'measured',
                source: fromVector ? 'Google vector data extrusion' : `fused height (${t.fusion?.heightSource}, ${t.fusion?.confidence} confidence)`,
                confidence: fromVector ? 0.8 : t.fusion?.confidence === 'high' ? 0.8 : t.fusion?.confidence === 'medium' ? 0.6 : 0.4
            });
        }
        if (!tiers.length) notes.push('no height for any footprint part: the vector data and the Solar DSM gave none');
        if (t.footprint.parts.some(p => p.holesWgs84?.length)) notes.push('courtyard holes are in the vector data but not yet passed on');
    }
    tiers.sort((a, b) => a.baseM - b.baseM || b.areaM2 - a.areaM2);
    const massing: SiteMassing = {
        place: { query: place, resolvedAs: shape.place.resolvedAs, lat: shape.place.lat, lng: shape.place.lng },
        frame: 'metres from the place point: x east, z south (the generator\'s frame), y up from the lowest point of the building',
        ...(t.vector.heightMeters !== undefined ? { topM: t.vector.heightMeters } : {}),
        tiers,
        ...(directionDeg !== undefined ? { wallDirectionDeg: directionDeg } : {}),
        footprintAreaM2: t.footprint.areaM2,
        notes
    };
    fs.rmSync(workDir, { recursive: true, force: true });
    return massing;
}
