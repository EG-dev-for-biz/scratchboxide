/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * location_grass_map: where the ground of a real place is grass (grass-detect.ts), shown in the viewport as a layer
 * over the photo-textured 3D tiles. Grass seen from above is photo-inferred; inside Google park outlines, the ground
 * hidden under tree crowns is filled from the nearest seen surface and labelled generated. Google vector water areas
 * are never grass, and buildings are never filled. Without vector data the map still runs, from the scan alone, and
 * says so.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { ToolDeclaration, ToolHandler, ToolHandlerOutcome, ToolResultPayload } from '../types';
import { getGoogle3DTilesFullTexture } from '../../../spatial/Google3DTileBlockoutPipelineService';
import { GoogleVectorTileService } from '../../../spatial/GoogleVectorTileService';
import { loadScanMesh, buildGroundModel, type GroundModel } from '../../../spatial/StreetViewSurveyPlanner';
import { renderTopDownPhoto } from '../../../3d-engine/staged-location/top-down-photo';
import { readTileTriangles } from '../../../3d-engine/staged-location/tile-texture-transfer';
import { fetchVectorEvidence, rasterizeEvidence, rasterizeAreas } from '../../../3d-engine/staged-location/vector-footprints';
import { detectGrass, type GrassMask } from '../../../3d-engine/staged-location/grass-detect';
import { GltfBinaryPacker } from '../../../3d-engine/gltf-binary-packer';

export const GRASS_MAP_TOOL_NAME = 'location_grass_map';

export const GRASS_MAP_TOOL_DECLARATION: ToolDeclaration = {
    name: GRASS_MAP_TOOL_NAME,
    description: 'Map where the ground of a real place is grass and show it in the viewport over the photo-textured Google 3D Tiles. Grass seen from above (ground-level cells whose lit colour is vegetation green) is labelled photo-inferred and drawn green; inside Google park outlines, ground hidden under tree crowns continues the nearest surface seen in the same park (grass, or a path for a few metres) and is labelled generated, drawn cyan. Google vector water areas are never grass and buildings are never filled. Reports the grass area, the filled area, the patches and why other ground was not grass. Use it when the user asks where the grass or lawns are at a place.',
    parameters: {
        type: 'OBJECT',
        properties: {
            query: { type: 'STRING', description: 'Place name, address or "lat, lng".' },
            radiusMeters: { type: 'NUMBER', description: 'Radius of the area mapped (default 250 m).' }
        },
        required: ['query']
    }
};

/** The grass cells as flat quads just above the terrain, coloured by kind (seen green, filled cyan) and confidence. */
function writeGrassGlb(file: string, g: GrassMask, ground: GroundModel, extras: Record<string, unknown>): number {
    const pos: number[] = [], nrm: number[] = [], col: number[] = [], idx: number[] = [];
    const lift = 0.12;
    for (let k = 0; k < g.nz; k++) for (let i = 0; i < g.nx; i++) {
        const c = k * g.nx + i;
        if (!g.mask[c]) continue;
        const y = ground.ground[c] + lift, x0 = g.x0 + i * g.cellM, z0 = g.z0 + k * g.cellM;
        const t = 0.55 + 0.45 * g.confidence[c];
        const rgb = g.mask[c] === 2 ? [0.1 * t, 0.75 * t, 1.0 * t] : [0.15 * t, 1.0 * t, 0.2 * t];
        const v = pos.length / 3;
        for (const [dx, dz] of [[0, 0], [g.cellM, 0], [g.cellM, g.cellM], [0, g.cellM]]) { pos.push(x0 + dx, y, z0 + dz); nrm.push(0, 1, 0); col.push(rgb[0], rgb[1], rgb[2], 1); }
        idx.push(v, v + 2, v + 1, v, v + 3, v + 2);
    }
    const n = pos.length / 3;
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let q = 0; q < pos.length; q++) { min[q % 3] = Math.min(min[q % 3], pos[q]); max[q % 3] = Math.max(max[q % 3], pos[q]); }
    const gltf = {
        asset: { version: '2.0', generator: `Scratchbox ${GRASS_MAP_TOOL_NAME}`, extras },
        scene: 0, scenes: [{ nodes: [0] }],
        nodes: [{ name: 'grass map', mesh: 0, extras }],
        materials: [{ name: 'grass map', pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 1 }, doubleSided: true }],
        meshes: [{ name: 'grass map', primitives: [{ attributes: { POSITION: 0, NORMAL: 1, COLOR_0: 2 }, indices: 3, material: 0, mode: 4 }] }],
        accessors: [
            { bufferView: 0, componentType: 5126, count: n, type: 'VEC3', min, max },
            { bufferView: 1, componentType: 5126, count: n, type: 'VEC3' },
            { bufferView: 2, componentType: 5126, count: n, type: 'VEC4' },
            { bufferView: 3, componentType: 5125, count: idx.length, type: 'SCALAR' }
        ],
        bufferViews: [{ buffer: 0, target: 34962 }, { buffer: 0, target: 34962 }, { buffer: 0, target: 34962 }, { buffer: 0, target: 34963 }]
    };
    GltfBinaryPacker.writeGlb(file, gltf, [Float32Array.from(pos), Float32Array.from(nrm), Float32Array.from(col), Uint32Array.from(idx)].map(a => Buffer.from(a.buffer)));
    return idx.length / 3;
}

const modelUri = (file: string) => `/models/${path.basename(file)}`;

export const grassMapHandler: ToolHandler = async (args, ctx): Promise<ToolHandlerOutcome> => {
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    if (!query) return { status: 'failed', summaryResult: `${GRASS_MAP_TOOL_NAME}: query is required (a place name, address or "lat, lng").`, resultPayload: { status: 'error', error: 'query is required' } };
    const radiusM = typeof args.radiusMeters === 'number' && args.radiusMeters > 0 ? args.radiusMeters : 250;
    ctx.reportProgress?.('Fetching the photo-textured 3D tiles');
    const tiles = await getGoogle3DTilesFullTexture(query, { radiusMeters: radiusM, signal: ctx.signal });
    if (tiles.mock) return { status: 'failed', summaryResult: `${GRASS_MAP_TOOL_NAME}: the extraction returned placeholder tiles, not Google 3D Tiles; nothing is mapped.`, resultPayload: { status: 'error', error: 'placeholder tiles' } };
    const anchor = tiles.geoAnchor as { lat: number; lng: number };
    const place = tiles.resolvedAddress || query;

    ctx.reportProgress?.('Reading the ground and the top-down photo');
    const scan = loadScanMesh(tiles.glbPath), ground = buildGroundModel(scan, { cellMeters: 1 });
    const frame = { x0: ground.x0, z0: ground.z0, widthM: ground.nx * ground.cellMeters, heightM: ground.nz * ground.cellMeters };
    const photo = renderTopDownPhoto(readTileTriangles(fs.readFileSync(tiles.glbPath)), frame, { texelM: 0.2, maxPx: 3000 });

    ctx.reportProgress?.('Reading Google vector water, parks and buildings');
    let evidence: { water?: Uint8Array; park?: Uint8Array; building?: Int32Array } | undefined, vectorNote: string;
    try {
        const ev = await fetchVectorEvidence({ lat: anchor.lat, lng: anchor.lng, radiusM: radiusM + 20, fetchTile: (x, y, z) => GoogleVectorTileService.fetchVectorTile(x, y, z, '') });
        const r = rasterizeEvidence(ev, ground);
        evidence = { water: r.water, building: r.building, park: rasterizeAreas(ev, ground, 'FEATURE_TYPE_PARK') };
        vectorNote = `Google vector data: ${ev.water.length} water areas, ${(ev.landuse ?? []).filter(a => a.types.includes('FEATURE_TYPE_PARK')).length} park outlines`;
    } catch (err) {
        vectorNote = `no Google vector data (${err instanceof Error ? err.message : String(err)}): water is not excluded and nothing under crowns is filled`;
    }
    const g = detectGrass(photo, frame, ground, undefined, evidence);

    const out = tiles.glbPath.replace(/(_textured)?\.glb$/i, '_grass_map.glb');
    const extras = { sb: { provenance: { label: 'photo-inferred', measuredGeometry: false, method: g.provenance.method, confidence: 0.7, ...(g.provenance.underCrown ? { underCrown: { ...g.provenance.underCrown, confidence: 0.35 } } : {}) }, version: g.version } };
    const triangles = writeGrassGlb(out, g, ground, extras);
    const stamp = Date.now();
    const object = (id: string, file: string, metadata: Record<string, unknown>) => ({
        id, content: { type: '3d-model', durableUri: modelUri(file), mimeType: 'model/gltf-binary', metadata: { role: 'environment', resolvedAddress: place, ...metadata } },
        space: { spatial3d: { x: 0, y: 0, z: 0 } }, time: { startMs: 0, durationMs: 20000 }, lineage: { version: 1 }
    });
    const seenM2 = g.areaM2 - g.underCrown.areaM2;
    const summary = `Grass at ${place}: ${Math.round(seenM2).toLocaleString()} m² seen from above (photo-inferred, green) and ${Math.round(g.underCrown.areaM2).toLocaleString()} m² filled under park tree crowns (generated, cyan), in ${g.patches.length} patches. Not grass: ${g.stats.tooHigh.toLocaleString()} m² standing above the ground, ${g.stats.water.toLocaleString()} m² water, ${g.stats.notGreen.toLocaleString()} m² ground that is not green. ${vectorNote}.`;
    const artifact = {
        id: `artifact-3d-${stamp}`, type: '3d-scene', title: `${place} (grass map)`, summary, version: 1,
        data: {
            title: `${place} — grass map`, subtitle: 'Photo-textured Google 3D Tiles with the grass layer: green seen from above, cyan filled under park crowns.',
            renderMode: 'shaded', cameraMode: 'orbit', environment: { skybox: 'studio', lighting: 'studio', ground: false },
            groundTileMode: 'photoreal-textured', geoAnchor: tiles.geoAnchor,
            objects: [
                object(`tile-texture-${stamp}`, tiles.glbPath, { source: 'Google3DTilesFullTexture', isGround: true, metricScale: 1, groundDatumMeters: 0 }),
                object(`grass-map-${stamp}`, out, { source: GRASS_MAP_TOOL_NAME, layer: 'grass', isGround: false, triangleCount: triangles, provenance: extras.sb.provenance })
            ]
        }
    };
    return {
        status: 'completed',
        summaryResult: summary,
        resultPayload: {
            status: 'success', place, geoAnchor: tiles.geoAnchor, glbPath: out, areaM2: g.areaM2, underCrown: g.underCrown, patches: g.patches.slice(0, 20), stats: g.stats,
            provenance: g.provenance, vector: vectorNote, artifact
        } as unknown as ToolResultPayload
    };
};
