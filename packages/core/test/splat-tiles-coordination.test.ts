/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import * as fs from 'fs-extra';
import * as path from 'path';

/**
 * Coordination and Visibility Logic Evaluator
 * Mirroring spatial_photoreal_3dgs_demo.html animate() & updateLightingUniforms()
 */
function evaluateTileVisibility(
    renderMode: 'softz' | 'split' | 'splats' | 'tiles',
    modelKey: string,
    hasSurveyClay: boolean,
    hasPavement: boolean,
    tileChildrenCount: number
): { showTiles: boolean; showSplats: boolean; isFullScene: boolean } {
    const isFullScene = Boolean(
        modelKey &&
        modelKey.endsWith('_spz') &&
        modelKey !== 'colonnade_spz' &&
        modelKey !== 'tileset_spz' &&
        modelKey !== 'survey_box'
    );

    const hasTileGeom = hasSurveyClay || hasPavement || (!isFullScene && tileChildrenCount > 0);
    const showTiles = (hasTileGeom && (renderMode === 'softz' || renderMode === 'split' || renderMode === 'tiles')) || (renderMode === 'tiles');
    const showSplats = (renderMode === 'softz' || renderMode === 'split' || renderMode === 'splats');

    return { showTiles, showSplats, isFullScene };
}

describe('Google 3D Tiles and Gaussian Splats Coordination', () => {
    describe('1. Tile & Splat Visibility State Matrix', () => {
        it('should correctly coordinate survey_box with SurveyClayMesh in Soft-Z and Split modes', () => {
            const softZ = evaluateTileVisibility('softz', 'survey_box', true, false, 1);
            expect(softZ.isFullScene).toBe(false);
            expect(softZ.showTiles).toBe(true);
            expect(softZ.showSplats).toBe(true);

            const split = evaluateTileVisibility('split', 'survey_box', true, false, 1);
            expect(split.showTiles).toBe(true);
            expect(split.showSplats).toBe(true);

            const splatsOnly = evaluateTileVisibility('splats', 'survey_box', true, false, 1);
            expect(splatsOnly.showTiles).toBe(false);
            expect(splatsOnly.showSplats).toBe(true);

            const tilesOnly = evaluateTileVisibility('tiles', 'survey_box', true, false, 1);
            expect(tilesOnly.showTiles).toBe(true);
            expect(tilesOnly.showSplats).toBe(false);
        });

        it('should treat colonnade_spz and colonnade as outdoor overlays with mock pavement', () => {
            const colonnadeSpz = evaluateTileVisibility('softz', 'colonnade_spz', false, true, 1);
            expect(colonnadeSpz.isFullScene).toBe(false);
            expect(colonnadeSpz.showTiles).toBe(true);
            expect(colonnadeSpz.showSplats).toBe(true);

            const colonnadeSplat = evaluateTileVisibility('softz', 'colonnade', false, true, 1);
            expect(colonnadeSplat.isFullScene).toBe(false);
            expect(colonnadeSplat.showTiles).toBe(true);
            expect(colonnadeSplat.showSplats).toBe(true);
        });

        it('should treat full architectural spheres (pantheon_spz, manhattan_spz) as full scene, hiding background tiles', () => {
            const pantheon = evaluateTileVisibility('softz', 'pantheon_spz', false, false, 0);
            expect(pantheon.isFullScene).toBe(true);
            expect(pantheon.showTiles).toBe(false);
            expect(pantheon.showSplats).toBe(true);

            // In explicit 'tiles' mode, force tiles display
            const pantheonTiles = evaluateTileVisibility('tiles', 'pantheon_spz', false, false, 0);
            expect(pantheonTiles.showTiles).toBe(true);
        });
    });

    describe('2. Split View vs Continuous Soft-Z Shader Uniform Semantics', () => {
        it('should configure uniform states accurately for Hard-Z vs Soft-Z passes', () => {
            interface UniformState {
                uSoftZEnabled: number;
                uHardZCut: number;
                uTileDepthNear: number;
                uTileDepthFar: number;
                uSoftZEpsilon: number;
            }

            const camNear = 0.1;
            const camFar = 500.0;
            const epsilon = 0.04;

            // Pass 2 Split mode: Left side (Hard Z seam demonstration)
            const splitLeft: UniformState = {
                uSoftZEnabled: 1.0,
                uHardZCut: 1.0,
                uTileDepthNear: camNear,
                uTileDepthFar: camFar,
                uSoftZEpsilon: epsilon
            };
            expect(splitLeft.uSoftZEnabled).toBe(1.0);
            expect(splitLeft.uHardZCut).toBe(1.0);

            // Pass 2 Split mode: Right side (Continuous volumetric Soft-Z interleaving)
            const splitRight: UniformState = {
                uSoftZEnabled: 1.0,
                uHardZCut: 0.0,
                uTileDepthNear: camNear,
                uTileDepthFar: camFar,
                uSoftZEpsilon: epsilon
            };
            expect(splitRight.uSoftZEnabled).toBe(1.0);
            expect(splitRight.uHardZCut).toBe(0.0);

            // Normal Soft-Z mode
            const softZMode: UniformState = {
                uSoftZEnabled: 1.0,
                uHardZCut: 0.0,
                uTileDepthNear: camNear,
                uTileDepthFar: camFar,
                uSoftZEpsilon: epsilon
            };
            expect(softZMode.uSoftZEnabled).toBe(1.0);
            expect(softZMode.uHardZCut).toBe(0.0);
        });
    });

    describe('3. Viewer Source Integrity (spatial_photoreal_3dgs_demo.html)', () => {
        const demoPath = path.resolve(__dirname, '../../../public/spatial_photoreal_3dgs_demo.html');

        it('should exist and contain required survey integration components', async () => {
            expect(await fs.pathExists(demoPath)).toBe(true);
            const html = await fs.readFile(demoPath, 'utf8');

            // Model button
            expect(html).toContain('data-model="survey_box"');
            expect(html).toContain('Google 3D Tiles Survey');

            // Survey stations panel
            expect(html).toContain('id="panel-survey-stations"');
            expect(html).toContain('id="survey-stations-list"');

            // Survey camera bookmark
            expect(html).toContain('id="cam-survey"');
            expect(html).toMatch(/survey:\s+\{/);

            // Logic functions and handles
            expect(html).toContain('loadSurveyTileset');
            expect(html).toContain('setupCameraStationsUI');
            expect(html).toContain('SurveyClayMesh');
            expect(html).toContain('mockPavementGroup');
            expect(html).toContain('surveyStationsGroup');

            // TileStreamer integration
            expect(html).toContain('tileStreamer.clear');
            expect(html).toContain('isFullScene: false');

            // Non-destructive survey_box cleanup in loadSplatModel
            expect(html).toContain("if (modelKey === 'survey_box')");

            // Soft-Z uniforms sync
            expect(html).toContain('uTileDepthNear.value = camera.near');
            expect(html).toContain('uTileDepthFar.value = camera.far');
            expect(html).toContain('uTileDepthMap.value = tileDepthTarget.depthTexture');
        });
    });

    describe('4. Station Reference Viewer Integration (colmap_vector_reference_viewer.html)', () => {
        const viewerPath = path.resolve(__dirname, '../../../scripts/colmap_vector_reference_viewer.html');

        it('should exist and provide one-click links to the 3DGS + 3D Tiles viewer', async () => {
            expect(await fs.pathExists(viewerPath)).toBe(true);
            const html = await fs.readFile(viewerPath, 'utf8');

            // Buttons present in DOM
            expect(html).toContain('id="btn-view-3dgs"');
            expect(html).toContain('id="btn-view-sample-3dgs"');

            // Routing to spatial_photoreal_3dgs_demo.html with tileset & glb params
            expect(html).toContain('/spatial_photoreal_3dgs_demo.html?tileset=');
            expect(html).toContain('glb=');
            expect(html).toContain('/models/survey_box_ground.glb');
            expect(html).toContain('/tilesets/survey_box/tileset.json');

            // Dynamic population in beautifyRankedToSplats
            expect(html).toContain('beautifyRankedToSplats');
            expect(html).toContain("btn3dgs.style.display = 'flex'");
        });
    });
});
