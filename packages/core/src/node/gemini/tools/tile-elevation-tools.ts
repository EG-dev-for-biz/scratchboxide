/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as fs from 'fs';
import { glbToTriangleSoupAsync } from '../../3d-engine/part-connectivity';
import { TileMeshRaycaster, type TileMeshFrame } from '../../spatial/tile-mesh-raycast';
import type { ToolContext, ToolDeclaration, ToolHandler, ToolHandlerOutcome } from './types';

/**
 * Answers "what is the true sea-level ground/surface elevation at this lat/lng" for an extracted
 * Google 3D Tiles mesh. Builds a grid-bucketed vertical raycaster (TileMeshRaycaster) over the
 * mesh's triangle soup, with EGM96 geoid correction baked into the mesh-to-MSL conversion — more
 * accurate for geographic elevation than a generic mesh raycast against the ellipsoid.
 */
export const TILE_ELEVATION_TOOL_DECLARATIONS: ToolDeclaration[] = [
    {
        name: 'tile_mesh_elevation_query',
        description:
            'Queries the true sea-level (MSL) ground/surface elevation at one or more lat/lng points against an extracted Google Photorealistic 3D Tiles mesh (.glb). Builds a grid-bucketed vertical raycaster over the mesh and casts straight down at each point, returning the highest surface hit converted to meters above sea level with EGM96 geoid correction baked in — more accurate for geographic elevation than a generic mesh/BVH raycast, which only knows local mesh-relative heights. Use this to read ground height, roofline height, or terrain elevation directly off a tile extraction.',
        parameters: {
            type: 'OBJECT',
            properties: {
                glbPath: {
                    type: 'STRING',
                    description: 'Path to the extracted Google 3D Tiles .glb mesh.'
                },
                anchorLat: {
                    type: 'NUMBER',
                    description: 'Latitude (decimal degrees, WGS-84) of the tile extraction\'s local ENU anchor.'
                },
                anchorLng: {
                    type: 'NUMBER',
                    description: 'Longitude (decimal degrees, WGS-84) of the tile extraction\'s local ENU anchor.'
                },
                originEllipsoidalHeightM: {
                    type: 'NUMBER',
                    description: 'Ellipsoidal height (meters, WGS-84 ellipsoid) of the mesh\'s local Y=0 plane, as reported by the original tile extraction (frame.originEllipsoidalHeightM).'
                },
                queries: {
                    type: 'ARRAY',
                    items: {
                        type: 'OBJECT',
                        properties: {
                            lat: { type: 'NUMBER', description: 'Query point latitude in decimal degrees.' },
                            lng: { type: 'NUMBER', description: 'Query point longitude in decimal degrees.' }
                        },
                        required: ['lat', 'lng']
                    },
                    description: 'Lat/lng points to query the mesh elevation at.'
                }
            },
            required: ['glbPath', 'anchorLat', 'anchorLng', 'originEllipsoidalHeightM', 'queries']
        }
    }
];

interface TileElevationQueryRequest {
    glbPath: string;
    anchorLat: number;
    anchorLng: number;
    originEllipsoidalHeightM: number;
    queries: Array<{ lat: number; lng: number }>;
}

async function tileMeshElevationQueryHandler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolHandlerOutcome> {
    const request = args as unknown as TileElevationQueryRequest;
    try {
        const { glbPath, anchorLat, anchorLng, originEllipsoidalHeightM, queries } = request;

        if (!glbPath || typeof glbPath !== 'string') {
            return { status: 'failed', resultPayload: { error: 'glbPath is required' } };
        }
        if (!fs.existsSync(glbPath)) {
            return { status: 'failed', resultPayload: { error: `GLB file not found: ${glbPath}` } };
        }
        if (typeof anchorLat !== 'number' || typeof anchorLng !== 'number' || typeof originEllipsoidalHeightM !== 'number') {
            return { status: 'failed', resultPayload: { error: 'anchorLat, anchorLng and originEllipsoidalHeightM must all be numbers' } };
        }
        if (!Array.isArray(queries) || queries.length === 0) {
            return { status: 'failed', resultPayload: { error: 'queries must be a non-empty array of { lat, lng } points' } };
        }

        const glbBuf = fs.readFileSync(glbPath);
        const soup = await glbToTriangleSoupAsync(glbBuf, { colors: false, signal: ctx.signal });
        if (!soup) {
            return { status: 'failed', resultPayload: { error: `Could not read a triangle mesh out of GLB: ${glbPath}` } };
        }

        const frame: TileMeshFrame = { soup, anchorLat, anchorLng, originEllipsoidalHeightM };
        const raycaster = new TileMeshRaycaster(frame);

        const results = queries.map(q => {
            const elevationMsl = raycaster.topHitMsl(q.lat, q.lng);
            return { lat: q.lat, lng: q.lng, elevationMsl: elevationMsl === undefined ? null : elevationMsl };
        });

        const hitCount = results.filter(r => r.elevationMsl !== null).length;

        return {
            status: 'completed',
            resultPayload: { glbPath, queryCount: queries.length, hitCount, results },
            summaryResult: `Tile elevation query: ${hitCount}/${queries.length} points hit the mesh (MSL, EGM96-corrected).`
        };
    } catch (e) {
        return { status: 'failed', resultPayload: { error: String(e instanceof Error ? e.message : e) } };
    }
}

export const tileElevationHandlers: Array<[ToolDeclaration, ToolHandler]> = [
    [TILE_ELEVATION_TOOL_DECLARATIONS[0], tileMeshElevationQueryHandler]
];
