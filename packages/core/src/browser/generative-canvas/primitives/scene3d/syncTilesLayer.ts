/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as THREE from 'three';
import { GooglePhotorealistic3DTilesLayer } from '../../services/GooglePhotorealistic3DTilesLayer';
import { TerrainManager } from '../../services/TerrainManager';
import type { RendererStack, Scene3DRenderMode, TilesLayerHandle } from './types';
import type { GroundTileMode } from '../../canvas-types';

export interface TilesLayerInput {
    has3DTiles: boolean;
    geoAnchor?: { lat: number; lng: number; elevation?: number } | null;
    renderMode: Scene3DRenderMode;
    groundTileMode?: GroundTileMode;
}

/** Object names that must be re-grounded whenever new tile LODs stream in. */
export const GROUND_SNAP_TARGET_NAMES = {
    prefixes: ['Minuteman Soldier', 'British Redcoat Soldier', 'Colonial Elm Tree', 'Stone Wall Segment'],
    exact: ['Buckman Tavern', 'Lexington Meetinghouse', 'Minutemen Militia Line', 'British Redcoat Regiment']
};

export function isGroundSnapTarget(obj: THREE.Object3D): boolean {
    const name = obj.name || '';
    return GROUND_SNAP_TARGET_NAMES.prefixes.some(p => name.startsWith(p)) || GROUND_SNAP_TARGET_NAMES.exact.includes(name);
}

/** Snap every ground-target descendant of `group` onto the terrain surface. */
export function snapGroupFiguresToGround(group: THREE.Object3D | null, terrainManager: TerrainManager | null): number {
    if (!group || !terrainManager) return 0;
    let count = 0;
    group.traverse(child => {
        if (isGroundSnapTarget(child)) {
            terrainManager.snapObjectToGround(child, 0);
            count++;
        }
    });
    return count;
}

/**
 * Creates (or tears down) the Google Photorealistic 3D Tiles layer and the TerrainManager used
 * for ground snapping. When tiles are not requested a scene-local TerrainManager is still
 * created so callers always have something to sample ground height from.
 */
export function syncTilesLayer(
    stack: RendererStack,
    input: TilesLayerInput,
    callbacks: { onTileLoaded?: (terrainManager: TerrainManager) => void } = {}
): TilesLayerHandle {
    const { scene } = stack;
    let tilesLayer: any | null = null;
    let terrainManager: TerrainManager | null = null;

    const mode = input.groundTileMode;
    const isSuppressed = mode === 'none' || mode === 'vector-roadmap-blueprint' || mode === 'vector-world-clay';

    if (input.has3DTiles && !isSuppressed) {
        try {
            const originAnchor = input.geoAnchor || { lat: 37.7749, lng: -122.4194, elevation: 0 };
            const isClay = mode === 'photoreal-clay' || (mode !== 'photoreal-textured' && input.renderMode === 'clay');
            tilesLayer = new GooglePhotorealistic3DTilesLayer({
                origin: { lat: originAnchor.lat, lng: originAnchor.lng, alt: originAnchor.elevation ?? 0 },
                renderMode: isClay ? 'clay' : 'textured',
                clayPreset: 'studio-grey'
            });
            scene.add(tilesLayer.group);
            terrainManager = tilesLayer.getTerrainManager(scene);
            const tm = terrainManager;
            tilesLayer.onTileLoaded = () => {
                if (tm) callbacks.onTileLoaded?.(tm);
            };
        } catch (tileErr) {
            console.warn('[Google 3D Tiles Layer Init Error]:', tileErr);
            tilesLayer = null;
        }
    }
    if (!terrainManager) {
        terrainManager = new TerrainManager({ scene });
    }

    return {
        tilesLayer,
        terrainManager,
        dispose: () => {
            if (tilesLayer) {
                try {
                    tilesLayer.onTileLoaded = undefined;
                    if (tilesLayer.group) scene.remove(tilesLayer.group);
                    tilesLayer.dispose?.();
                } catch (e) {
                    console.warn('[Google 3D Tiles Layer Dispose Warning]:', e);
                }
            }
        }
    };
}
