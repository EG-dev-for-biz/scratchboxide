/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as fs from 'fs';
import * as path from 'path';
import { vi } from 'vitest';
import { Google3DTileBlockoutPipelineService, type GeoAnchor } from '../../src/node/spatial/Google3DTileBlockoutPipelineService';
import { Google3DTileCrawlerBaker } from '../../src/node/spatial/Google3DTileCrawlerBaker';

/**
 * Tests run without network or Maps credentials, so code that extracts Google 3D Tiles gets this injected
 * extraction instead: a synthetic geodetic tile written where the caller asked, at the caller's coordinates.
 * The returned spy records each request (anchor, mode, options); the result is marked `mock: true`.
 */
export function injectTileExtraction() {
    return vi.spyOn(Google3DTileBlockoutPipelineService.prototype, 'fetch3DObject').mockImplementation(
        async (query: string | GeoAnchor, mode: 'full-texture' | 'clay', options?: { outputGlbPath?: string; radiusMeters?: number }) => {
            if (typeof query !== 'object' || !options?.outputGlbPath) {
                throw new Error('injectTileExtraction expects explicit coordinates and an outputGlbPath');
            }
            const origin = { lat: query.lat, lng: query.lng, alt: query.elevation ?? 0 };
            const tile = Google3DTileCrawlerBaker.createSyntheticGeodeticTile(origin, options.radiusMeters ?? 200);
            const glbBuffer = Google3DTileCrawlerBaker.mergeTileMeshes([tile], origin).glbBuffer;
            fs.mkdirSync(path.dirname(options.outputGlbPath), { recursive: true });
            fs.writeFileSync(options.outputGlbPath, glbBuffer);
            return {
                success: true,
                mock: true,
                mode,
                geoAnchor: { ...query },
                resolvedAddress: query.landmarkName,
                glbBuffer,
                glbPath: options.outputGlbPath
            } as any;
        }
    );
}
