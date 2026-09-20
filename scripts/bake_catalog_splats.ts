/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { ImageToSplatService } from '../packages/core/src/node/3d-engine/image-to-splat-service';

function decodeImageToRgb(relativePath: string, width: number, height: number): Buffer {
    const fullPath = path.resolve(process.cwd(), 'public', relativePath);
    if (!fs.existsSync(fullPath)) {
        throw new Error(`Source image not found: ${fullPath}`);
    }
    const cmd = `ffmpeg -v error -i "${fullPath}" -vf "scale=${width}:${height}" -f rawvideo -pix_fmt rgb24 -`;
    return execSync(cmd, { maxBuffer: 100 * 1024 * 1024 });
}

function ensureDirectory(filePath: string) {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

async function main() {
    console.log('🚀 Starting Photographic 3DGS Asset Baking via ImageToSplatService...');
    const startTime = Date.now();

    const catalog = ImageToSplatService.getPublicSourceCatalog();

    // 1. Bake Multi-View Image Groups
    for (const group of catalog.imageGroups) {
        console.log(`\n📸 Processing Image Group: [${group.id}] ${group.title}`);
        const width = 640;
        const height = 360;

        const keyframes = group.paths.map((p, idx) => {
            console.log(`   - Decoding [${idx + 1}/${group.paths.length}]: ${p}`);
            const rgbPixels = decodeImageToRgb(p, width, height);
            return {
                rgbPixels,
                width,
                height,
                channels: 3,
                fovDegrees: group.suggestedFov ?? 65.0
            };
        });

        console.log(`   - Fusing ${keyframes.length} views with ImageToSplatService...`);
        const trajectory = group.suggestedTrajectory === 'orbit' ? 'orbit' : 'pan';
        const fusedSplats = ImageToSplatService.convertVideoKeyframesToSplat({
            keyframes,
            trajectoryType: trajectory,
            orbitRadius: 18.0,
            orbitSweepDegrees: 55.0,
            panDistance: 6.0,
            voxelSize: 0.035, // High resolution voxel grid
            stride: 1,
            edgeTau: 0.08,
            minDepth: 1.0,
            maxDepth: 150.0
        });

        console.log(`   - Fused Splats Count: ${fusedSplats.length.toLocaleString()}`);

        const splatBuffer = ImageToSplatService.serializeToSplatBuffer(fusedSplats);
        const splatPath = path.resolve(process.cwd(), `public/models/${group.id}.splat`);
        ensureDirectory(splatPath);
        fs.writeFileSync(splatPath, splatBuffer);
        console.log(`   ✅ Wrote: ${splatPath} (${(splatBuffer.length / (1024 * 1024)).toFixed(2)} MB)`);

        // Generate physics collider GLB
        const colliderHulls = ImageToSplatService.extractPhysicsColliders(fusedSplats, {
            groundHeightTau: 0.6,
            obstacleMinHeight: 0.3,
            maxHulls: 32
        });
        const glbBuffer = ImageToSplatService.generatePhysicsColliderGlb(colliderHulls);
        const glbPath = path.resolve(process.cwd(), `public/models/${group.id}_collider.glb`);
        fs.writeFileSync(glbPath, glbBuffer);
        console.log(`   ✅ Wrote Collision Hull: ${glbPath} (${(glbBuffer.length / 1024).toFixed(1)} KB)`);
    }

    // 2. Bake High-Resolution Single Photo Splats
    for (const single of catalog.singleImages.slice(0, 4)) {
        console.log(`\n📷 Processing Single Image: [${single.id}] ${single.title}`);
        const width = 640;
        const height = 480;

        try {
            const rgbPixels = decodeImageToRgb(single.path, width, height);
            const metricDepths = ImageToSplatService.synthesizeMetricDepthsFromLuminance(
                rgbPixels,
                width,
                height,
                3,
                single.nearDepth ?? 2.5,
                single.farDepth ?? 80.0
            );

            const splats = ImageToSplatService.convertSingleImageToSplat({
                rgbPixels,
                width,
                height,
                channels: 3,
                metricDepths,
                fovDegrees: single.suggestedFov ?? 65.0,
                stride: 1,
                edgeTau: 0.08,
                minDepth: single.nearDepth ?? 2.0,
                maxDepth: single.farDepth ?? 100.0
            });

            console.log(`   - Generated Splats Count: ${splats.length.toLocaleString()}`);

            const splatBuffer = ImageToSplatService.serializeToSplatBuffer(splats);
            const splatPath = path.resolve(process.cwd(), `public/models/${single.id}.splat`);
            ensureDirectory(splatPath);
            fs.writeFileSync(splatPath, splatBuffer);
            console.log(`   ✅ Wrote: ${splatPath} (${(splatBuffer.length / (1024 * 1024)).toFixed(2)} MB)`);

            const colliderHulls = ImageToSplatService.extractPhysicsColliders(splats, {
                groundHeightTau: 0.6,
                obstacleMinHeight: 0.3,
                maxHulls: 24
            });
            const glbBuffer = ImageToSplatService.generatePhysicsColliderGlb(colliderHulls);
            const glbPath = path.resolve(process.cwd(), `public/models/${single.id}_collider.glb`);
            fs.writeFileSync(glbPath, glbBuffer);
            console.log(`   ✅ Wrote Collision Hull: ${glbPath} (${(glbBuffer.length / 1024).toFixed(1)} KB)`);
        } catch (err: any) {
            console.warn(`   ⚠️ Skipping ${single.id}: ${err.message}`);
        }
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n✨ All Photographic 3DGS Assets Baked Successfully in ${elapsed}s!`);
}

main().catch((err) => {
    console.error('❌ Error baking catalog splats:', err);
    process.exit(1);
});
