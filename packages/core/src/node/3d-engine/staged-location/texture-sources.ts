/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The texture stage's shared sources, made once for every layer: the registered Street View views decoded, the
 * photo-textured tile's sampling surface, the scan (occluder) and the full tile mesh (context). It is CPU work (JPEG
 * decodes, a GLB parse with its textures, a BVH over the tile), so the stage runs it in a texture worker thread
 * (texture-worker-pool.ts); the same function runs inline when the workers are off, with the same results.
 */

import * as fs from 'fs';
import type { ProjectionView } from '../../../common/spatial/texture-pass-contracts';
import type { RenderMesh3D } from '../../spatial/HeadlessMeshSilhouetteRenderer';
import { readGlbScene, sceneToRenderMesh } from '../../spatial/StreetViewPoseRegistrar';
import type { Registration } from './pano-registration';
import { sha256File } from './stage-cache';
import type { EvidenceImage } from './streetview-evidence';
import { projectionViewsFromEvidence } from './texture-pass';
import { loadTileSurface, tileSurfaceFromState, tileSurfaceState, type TileSurfaceState, type TileTextureSurface } from './tile-texture-transfer';

/** The images a view is made from: what projectionViewsFromEvidence reads of an EvidenceImage. */
export type TextureSourceImage = Pick<EvidenceImage, 'view' | 'bytes' | 'widthPx' | 'heightPx'>;

export interface TextureSourcesInput {
    images: TextureSourceImage[];
    /** Photo tier A's wide views (survey and ring), the same way. */
    wide: TextureSourceImage[];
    registration?: Registration;
    /** The photo-textured extraction on disk (D's tile). */
    texturedGlb?: string;
    /** The scan (C's occluder) and the full tile mesh (context), GLB files; missing ones are left out. */
    occluderFiles: Array<string | undefined>;
    contextFiles: Array<string | undefined>;
}

export interface TextureSources {
    views: ProjectionView[];
    failures: string[];
    wideViews: ProjectionView[];
    /** The tile surface; absent with `tileUnavailable`. */
    tile?: TileTextureSurface;
    tileUnavailable?: string;
    tileLoadMs: number;
    /** sha256 of the textured extraction, 'no-tile' without a tile. */
    tileSha: string;
    occluder: RenderMesh3D;
    context: RenderMesh3D;
}

/** TextureSources as it crosses a thread: the tile as its state (tileSurfaceState). */
export type TextureSourcesWire = Omit<TextureSources, 'tile'> & { tile?: TileSurfaceState };

function loadMesh(files: Array<string | undefined>): RenderMesh3D {
    const prims = files.filter((f): f is string => !!f && fs.existsSync(f)).flatMap(f => readGlbScene(f));
    return sceneToRenderMesh(prims);
}

/** Makes the stage's sources (see the file comment). Never throws for a missing tile: that is `tileUnavailable`. */
export function prepareTextureSources(input: TextureSourcesInput, now: () => number = Date.now): TextureSources {
    const { views, failures } = projectionViewsFromEvidence(input.images as EvidenceImage[], input.registration);
    const wideViews = projectionViewsFromEvidence(input.wide as EvidenceImage[], input.registration).views;
    let tile: TileTextureSurface | undefined;
    let tileUnavailable: string | undefined;
    const tLoad = now();
    try {
        if (!input.texturedGlb || !fs.existsSync(input.texturedGlb)) throw new Error('the photo-textured extraction is not on disk');
        tile = loadTileSurface(fs.readFileSync(input.texturedGlb));
        if (!tile.textureCount) { tileUnavailable = 'the extraction carries no photo texture'; tile = undefined; }
    } catch (err) {
        tileUnavailable = `the photo-textured tile could not be read (${(err as Error)?.message ?? String(err)})`;
    }
    const tileLoadMs = now() - tLoad;
    const tileSha = tile ? sha256File(input.texturedGlb!) : 'no-tile';
    return {
        views, failures, wideViews, ...(tile ? { tile } : {}), ...(tileUnavailable ? { tileUnavailable } : {}), tileLoadMs, tileSha,
        occluder: loadMesh(input.occluderFiles), context: loadMesh(input.contextFiles)
    };
}

export function textureSourcesToWire(s: TextureSources): TextureSourcesWire {
    const { tile, ...rest } = s;
    const state = tile ? tileSurfaceState(tile) : undefined;
    if (tile && !state) throw new Error('the tile surface carries no state to send to a worker');
    return { ...rest, ...(state ? { tile: state } : {}) };
}

export function textureSourcesFromWire(w: TextureSourcesWire): TextureSources {
    const { tile, ...rest } = w;
    return { ...rest, ...(tile ? { tile: tileSurfaceFromState(tile) } : {}) };
}
