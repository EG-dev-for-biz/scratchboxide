/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as path from 'path';
import * as fs from 'fs-extra';
import { SurveySplatPipelineService } from '../packages/core/src/node/spatial/SurveySplatPipelineService';
import { resolveSurveyPreset } from '../packages/core/src/node/spatial/survey-router';
import { createArchitecturalStationGenerator } from '../packages/core/src/node/spatial/BeautifyStationService';

async function main() {
    console.log('🏛️ Rebaking Colosseum Survey 3DGS centered at monument centroid [-43.42, 24.0, 62.54]...');

    const workspaceRoot = process.cwd();
    const preset = resolveSurveyPreset({
        location: 'Rome Colosseum',
        surveyPattern: 'geographic-3dtiles-survey',
        cameraCount: 24,
        forceRebake: true
    }, workspaceRoot);

    console.log(`📍 Geodetic Anchor: Lat ${preset.anchor.lat}, Lng ${preset.anchor.lng}, Elev ${preset.anchor.elevationMeters}m`);
    console.log(`📐 Stations count: ${preset.stations.length}`);
    console.log(`🎯 Station 1 Eye: ${preset.stations[0].positionLocalENU.map(v => v.toFixed(2)).join(', ')}`);
    console.log(`🎯 Station 1 Fwd: ${preset.stations[0].forwardVector.map(v => v.toFixed(2)).join(', ')}`);
    console.log(`📦 Bounding Box: min=[${preset.cropBox?.min.join(', ')}], max=[${preset.cropBox?.max.join(', ')}]`);

    const generator = createArchitecturalStationGenerator();
    const service = new SurveySplatPipelineService({ generator });

    const result = await service.run({
        glbPath: preset.glbPath,
        anchor: preset.anchor,
        stations: preset.stations,
        outDir: preset.outDir,
        beautify: preset.beautify,
        mode: 'chained',
        maxStations: 24,
        renderWidth: 960,
        bakeStride: 1,
        sigmaScale: 0.85,
        voxelSizeMeters: 0.08,
        forceRebake: true,
        clean: true,
        cropRadius: preset.cropRadius,
        cropBox: preset.cropBox,
        dropFoliage: true,
        dropInconsistent: true,
        colorConsistencyThresh: 35.0,
        stoneType: 'travertine'
    }, (progress, message) => {
        console.log(`  [${(progress * 100).toFixed(0)}%] ${message}`);
    });

    console.log('\n✅ REBAKE SUCCESSFUL!');
    console.log(`   Fused Splats: ${result.fusedSplatCount.toLocaleString()}`);
    console.log(`   Splat File: ${result.fusedSplatPath}`);
    console.log(`   Tileset: ${result.tilesetPath}`);
    console.log(`   Duration: ${(result.durationMs / 1000).toFixed(1)}s`);
}

main().catch(err => {
    console.error('Rebake error:', err);
    process.exit(1);
});
