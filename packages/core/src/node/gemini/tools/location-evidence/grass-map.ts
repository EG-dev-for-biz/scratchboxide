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
 * says so. With `blades`, real grass is grown over the mapped grass near a centre as instanced clump meshes
 * (grass-field.ts), in place of the flat debug layer: blade geometry generated, its colour photo-inferred.
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
import { detectGrass, grassOverlay, type GrassMask } from '../../../3d-engine/staged-location/grass-detect';
import { classifyGround, type GroundClassification } from '../../../3d-engine/staged-location/ground-classifier';
import { areaPriorRasters } from '../../../3d-engine/staged-location/ground-area-priors';
import { buildGrassField, grassFieldGrid, scanTrianglesNear, writeGrassFieldGlb, GRASS_CHUNK_M, GRASS_FIELD_VERSION, type GrassFieldParams } from '../../../3d-engine/staged-location/grass-field';
import { GltfBinaryPacker } from '../../../3d-engine/gltf-binary-packer';
import { encodePng } from '../../../3d-engine/staged-location/png-encode';

export const GRASS_MAP_TOOL_NAME = 'location_grass_map';

export const GRASS_MAP_TOOL_DECLARATION: ToolDeclaration = {
    name: GRASS_MAP_TOOL_NAME,
    description: 'Map where the ground of a real place is grass and show it in the viewport over the photo-textured Google 3D Tiles. Grass seen from above (ground-level cells whose lit colour is vegetation green) is labelled photo-inferred and drawn green; inside Google park outlines, ground hidden under tree crowns continues the nearest surface seen in the same park (grass, or a path for a few metres) and is labelled generated, drawn cyan. Google vector water areas are never grass and buildings are never filled; green open ground is checked against Google land-use areas (park outlines say planted; parking lots and carriageways say paved), so green paint, roofs and vehicles off every planted area are held back and reported. Writes a top-down overlay PNG of the map. Reports the grass area, the filled area, the patches and why other ground was not grass. Use it when the user asks where the grass or lawns are at a place. With blades: true it instead grows real 3D grass (instanced blade clumps, generated geometry tinted to the photo colour) over the mapped grass within a band around the place (or the nearest grass to it), never over buildings or water; ground farther out stays the tile photo. Use blades when the user wants 3D grass, lawns or a grass layer they can see up close.',
    parameters: {
        type: 'OBJECT',
        properties: {
            query: { type: 'STRING', description: 'Place name, address or "lat, lng".' },
            radiusMeters: { type: 'NUMBER', description: 'Radius of the area mapped (default 250 m).' },
            blades: { type: 'BOOLEAN', description: 'Grow 3D grass blades (instanced clumps) over the mapped grass instead of the flat map layer (default false).' },
            bladeBandRadiusM: { type: 'NUMBER', description: 'Radius around the centre within which blades are grown (default 60 m); farther grass stays the tile photo.' },
            bladeDensityPerM2: { type: 'NUMBER', description: 'Clumps per square metre on fully confident grass (default 8).' },
            bladesPerClump: { type: 'NUMBER', description: 'Blades in each near clump (default 30); farther clumps hold fewer, wider ones. Blades per square metre near the viewer = density x this.' },
            bladeSegments: { type: 'NUMBER', description: 'Spine segments of a near blade (default 5; fewer is cheaper and straighter).' },
            bladeFarSegments: { type: 'NUMBER', description: 'Spine segments of the widened distant blades (default 2).' },
            bladeMaxClumps: { type: 'NUMBER', description: 'Most clumps grown (default 150000); past it the nearest are kept.' },
            bladeRootShade: { type: 'NUMBER', description: '0..1: tone of a blade at its root relative to its lit upper part (default 0.3): the shade neighbouring blades cast low in a lawn.' },
            bladeUnderlayerRadiusM: { type: 'NUMBER', description: 'Radius around the centre of the darker, blade-textured sheet laid under the blades so no bare ground shows between them (default 40 m; 0 = none).' },
            bladeChunkM: { type: 'NUMBER', description: 'Side of the square tiles the grass is split into so the viewer skips the tiles out of view (default 30 m; 0 = one piece per clump shape).' },
            bladeHeightMinM: { type: 'NUMBER', description: 'Shortest blade length (default 0.06 m).' },
            bladeHeightMaxM: { type: 'NUMBER', description: 'Longest blade length (default 0.14 m). A mown lawn is a few centimetres; a meadow half a metre or more.' },
            bladeSenescence: { type: 'NUMBER', description: '0..1, how far blade tips turn toward straw (default 0.2).' },
            bladePixelAngle: { type: 'NUMBER', description: 'Radians one screen pixel spans (default 0.0015). Blades farther from the centre are built wider and fewer so they stay about a pixel wide; 0 keeps every blade at its near width.' }
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
    let evidence: { water?: Uint8Array; park?: Uint8Array; building?: Int32Array; classification?: GroundClassification } | undefined, vectorNote: string;
    try {
        const ev = await fetchVectorEvidence({ lat: anchor.lat, lng: anchor.lng, radiusM: radiusM + 20, fetchTile: (x, y, z) => GoogleVectorTileService.fetchVectorTile(x, y, z, '') });
        const r = rasterizeEvidence(ev, ground), priors = areaPriorRasters(ev, ground);
        evidence = { water: r.water, building: r.building, park: rasterizeAreas(ev, ground, 'FEATURE_TYPE_PARK'), classification: classifyGround(photo, frame, ground, { raster: r, priors }) };
        vectorNote = `Google vector data: ${ev.water.length} water areas, ${(ev.landuse ?? []).filter(a => a.types.includes('FEATURE_TYPE_PARK')).length} park outlines, ${ev.roads.length} road centrelines, area priors from ${priors.used.map(u => `${u.areas} ${u.code}`).join(', ') || 'no area'}`;
    } catch (err) {
        vectorNote = `no Google vector data (${err instanceof Error ? err.message : String(err)}): water is not excluded, green is not checked against planted areas and nothing under crowns is filled`;
    }
    const g = detectGrass(photo, frame, ground, undefined, evidence);
    const cls = evidence?.classification;

    const out = tiles.glbPath.replace(/(_textured)?\.glb$/i, '_grass_map.glb');
    const extras = { sb: { provenance: { label: 'photo-inferred', measuredGeometry: false, method: g.provenance.method, confidence: 0.7, ...(g.provenance.underCrown ? { underCrown: { ...g.provenance.underCrown, confidence: 0.35 } } : {}) }, version: g.version } };
    const triangles = writeGrassGlb(out, g, ground, extras);
    const overlayPng = out.replace(/\.glb$/i, '_overlay.png');
    fs.writeFileSync(overlayPng, encodePng(photo.width, photo.height, grassOverlay(photo, frame, g), 4));
    const stamp = Date.now();
    const object = (id: string, file: string, metadata: Record<string, unknown>) => ({
        id, content: { type: '3d-model', durableUri: modelUri(file), mimeType: 'model/gltf-binary', metadata: { role: 'environment', resolvedAddress: place, ...metadata } },
        space: { spatial3d: { x: 0, y: 0, z: 0 } }, time: { startMs: 0, durationMs: 20000 }, lineage: { version: 1 }
    });
    const seenM2 = g.areaM2 - g.underCrown.areaM2;
    let summary = `Grass at ${place}: ${Math.round(seenM2).toLocaleString()} m² seen from above (photo-inferred, green) and ${Math.round(g.underCrown.areaM2).toLocaleString()} m² filled under park tree crowns (generated, cyan), in ${g.patches.length} patches. Not grass: ${g.stats.tooHigh.toLocaleString()} m² standing above the ground, ${g.stats.water.toLocaleString()} m² water, ${g.stats.notGreen.toLocaleString()} m² ground that is not green${g.stats.offPlanted || g.stats.paved ? `; ${g.stats.offPlanted.toLocaleString()} m² green but off every planted area (likely paint, a roof or a vehicle) and ${g.stats.paved.toLocaleString()} m² green on paved ground were held back (orange in the overlay)` : ''}. ${vectorNote}.${cls?.stats.openInFootprintM2 ? ` ${Math.round(cls.stats.openInFootprintM2).toLocaleString()} m² of open ground at the terrain lies inside Google building footprints with nothing standing on it in the scan (a plaza or a lawn over an underground structure): classified as ground.` : ''}`;
    const layer = object(`grass-map-${stamp}`, out, { source: GRASS_MAP_TOOL_NAME, layer: 'grass', isGround: false, triangleCount: triangles, provenance: extras.sb.provenance });
    let bladeLayer: ReturnType<typeof object> | undefined, blades: Record<string, unknown> | undefined;
    if (args.blades === true) {
        if (!g.cells) summary += ' No blades were grown: no grass was found.';
        else {
            ctx.reportProgress?.('Growing the grass blades');
            const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined;
            const bandRadiusM = num(args.bladeBandRadiusM) ?? 60;
            const centre = bladeCentre(g, bandRadiusM);
            const params: GrassFieldParams = {
                centreX: centre.x, centreZ: centre.z, bandRadiusM, densityPerM2: num(args.bladeDensityPerM2),
                bladeHeightMin: num(args.bladeHeightMinM), bladeHeightMax: num(args.bladeHeightMaxM),
                rootShade: typeof args.bladeRootShade === 'number' ? Math.min(1, Math.max(0, args.bladeRootShade)) : undefined,
                underlayerRadiusM: typeof args.bladeUnderlayerRadiusM === 'number' && args.bladeUnderlayerRadiusM >= 0 ? args.bladeUnderlayerRadiusM : undefined,
                bladeCount: num(args.bladesPerClump), segmentsPerBlade: num(args.bladeSegments), farSegmentsPerBlade: num(args.bladeFarSegments), maxInstances: num(args.bladeMaxClumps),
                senescence: typeof args.bladeSenescence === 'number' ? Math.min(1, Math.max(0, args.bladeSenescence)) : undefined,
                pixelAngle: typeof args.bladePixelAngle === 'number' && args.bladePixelAngle >= 0 ? args.bladePixelAngle : undefined
            };
            if (params.bladeHeightMin !== undefined && params.bladeHeightMax === undefined) params.bladeHeightMax = Math.max(params.bladeHeightMin, 0.14);
            if (params.bladeHeightMax !== undefined && params.bladeHeightMin === undefined) params.bladeHeightMin = Math.min(params.bladeHeightMax, 0.06);
            const near = scanTrianglesNear(scan.mesh.vertices as Float32Array, scan.mesh.indices as Uint32Array, centre.x, centre.z, bandRadiusM + 2);
            const field = await buildGrassField(grassFieldGrid(g, ground, { building: cls ? cls.scores.building : evidence?.building, water: evidence?.water }, near), out.replace(/\.glb$/i, '_blades'), params, { signal: ctx.signal });
            const bladesFile = tiles.glbPath.replace(/(_textured)?\.glb$/i, '_grass_blades.glb');
            const provenance = {
                label: 'generated', measuredGeometry: false, geometry: { label: 'generated', method: `${GRASS_FIELD_VERSION}: GrassClumpGenerator clumps (V-keel blades, droop, splay, senescent tips), instanced on blue-noise samples over the grass mask, kept with each cell's confidence` },
                standing: { label: 'measured', method: `each clump stands on the scan's surface where one lies within 0.75 m of the cell surface (${field.report.stats.snapped} clumps); elsewhere on the estimated ground (${field.report.stats.unsnapped}, generated)` },
                colour: { label: 'photo-inferred', method: 'each instance tinted toward its cell\'s lit top-down photo colour; cells under crowns take the nearest seen grass colour; each blade shaded from a dark root (self-occlusion, generated)' },
                underlayer: { label: 'generated', method: 'a sheet over the grass cells near the centre, on the scan surface, in the photo colour darkened as the lower grass and where clumps stand, fading to the photo colour at the grass edge, with a generated blade-scale detail texture' },
                mask: { ...extras.sb.provenance }, confidence: 0.6
            };
            const bladeChunkM = typeof args.bladeChunkM === 'number' && args.bladeChunkM >= 0 ? args.bladeChunkM : GRASS_CHUNK_M;
            const bladeTriangles = writeGrassFieldGlb(bladesFile, field, { sb: { provenance, version: GRASS_FIELD_VERSION, mask: g.version, band: { centre: [centre.x, centre.z], radiusM: bandRadiusM, radiusReachedM: field.report.stats.radiusReachedM } } }, bladeChunkM);
            const s = field.report.stats;
            blades = { glbPath: bladesFile, instances: field.report.instances, triangles: bladeTriangles, centre: [centre.x, centre.z], centreFrom: centre.from, bandRadiusM, report: field.report, provenance };
            bladeLayer = object(`grass-blades-${stamp}`, bladesFile, { source: GRASS_MAP_TOOL_NAME, layer: 'grass-blades', isGround: false, instanceCount: field.report.instances, triangleCount: bladeTriangles, provenance });
            let seenColour = false;
            for (let c = 0; c < g.mask.length && !seenColour; c++) seenColour = !!g.mask[c] && g.colour[c * 3 + 1] > 0;
            if (!seenColour) summary += ' No grass was seen from above here, so the blades keep their own neutral tone (no photo colour to tint them toward).';
            const rings = new Set(field.variants.map(v => v.ring)).size;
            const under = field.report.underlayer.areaM2 ? ` with a blade-textured sheet under them over ${Math.round(field.report.underlayer.areaM2).toLocaleString()} m² so no bare ground shows between them` : '';
            summary += ` Grew ${field.report.instances.toLocaleString()} grass clumps (generated geometry, photo-inferred colour${rings > 1 ? `; blades widened in ${rings} distance rings so they stay visible farther out` : ''}) over ${Math.round(s.bandGrassM2).toLocaleString()} m² of grass within ${bandRadiusM} m of ${centre.from}${under}${s.overBudget ? `; ${s.overBudget.toLocaleString()} farther ones left out past the instance budget (blades reach ${s.radiusReachedM.toFixed(0)} m)` : ''}; ${s.nearExcluded.toLocaleString()} kept clear of buildings and water. Farther ground stays the tile photo.`;
        }
    }
    const artifact = {
        id: `artifact-3d-${stamp}`, type: '3d-scene', title: `${place} (${bladeLayer ? 'grass' : 'grass map'})`, summary, version: 1,
        data: {
            title: `${place} — ${bladeLayer ? 'grass' : 'grass map'}`,
            subtitle: bladeLayer ? 'Photo-textured Google 3D Tiles with 3D grass grown over the mapped lawns near the place.' : 'Photo-textured Google 3D Tiles with the grass layer: green seen from above, cyan filled under park crowns.',
            renderMode: 'shaded', cameraMode: 'orbit', environment: { skybox: 'studio', lighting: 'studio', ground: false },
            groundTileMode: 'photoreal-textured', geoAnchor: tiles.geoAnchor,
            objects: [
                object(`tile-texture-${stamp}`, tiles.glbPath, { source: 'Google3DTilesFullTexture', isGround: true, metricScale: 1, groundDatumMeters: 0 }),
                bladeLayer ?? layer
            ]
        }
    };
    return {
        status: 'completed',
        summaryResult: summary,
        resultPayload: {
            status: 'success', place, geoAnchor: tiles.geoAnchor, glbPath: out, overlayPng, areaM2: g.areaM2, underCrown: g.underCrown, patches: g.patches.slice(0, 20), stats: g.stats,
            provenance: g.provenance, vector: vectorNote, heldBack: { offPlantedM2: g.stats.offPlanted, pavedM2: g.stats.paved },
            ...(cls ? { ground: { version: cls.version, areaM2: cls.stats.areaM2, greenOffPlantedM2: cls.stats.greenOffPlantedM2, openInFootprintM2: cls.stats.openInFootprintM2, provenance: cls.provenance } } : {}),
            ...(blades ? { blades } : {}), artifact
        } as unknown as ToolResultPayload
    };
};

/** Where the blades are grown around: the place itself when grass lies within the band, else the grass patch nearest it. */
function bladeCentre(g: GrassMask, bandRadiusM: number): { x: number; z: number; from: string } {
    let near = false;
    for (let k = 0; k < g.nz && !near; k++) for (let i = 0; i < g.nx; i++) {
        if (!g.mask[k * g.nx + i]) continue;
        const x = g.x0 + (i + 0.5) * g.cellM, z = g.z0 + (k + 0.5) * g.cellM;
        if (x * x + z * z <= bandRadiusM * bandRadiusM) { near = true; break; }
    }
    if (near) return { x: 0, z: 0, from: 'the place' };
    const p = [...g.patches].sort((a, b) => Math.hypot(...a.centre) - Math.hypot(...b.centre))[0];
    return { x: p.centre[0], z: p.centre[1], from: `the nearest grass, ${Math.round(Math.hypot(...p.centre))} m from the place` };
}
