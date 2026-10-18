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
import { execSync } from 'child_process';
import { ImageToSplatService } from '../packages/core/src/node/3d-engine/image-to-splat-service';
import { PanoramaDepthService } from '../packages/core/src/node/spatial/PanoramaDepthService';
import { shutdownAllPythonWorkerPools } from '../packages/core/src/node/process/persistent-python-worker';

/**
 * Bakes the splat studio's catalog with depth from the local depth model (Depth Anything V2 Small, relative depth).
 * Single images are baked in relative units (median depth 1). Image groups are fused along an orbit or pan in metres,
 * so they need the scene's median distance: pass --median-depth-m <metres>, or the groups are not baked.
 */
const medianArg = process.argv.indexOf('--median-depth-m');
const GROUP_MEDIAN_DEPTH_M = medianArg >= 0 ? Number(process.argv[medianArg + 1]) : undefined;
const depthService = new PanoramaDepthService();

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
    for (const group of (GROUP_MEDIAN_DEPTH_M && GROUP_MEDIAN_DEPTH_M > 0) ? catalog.imageGroups : []) {
        console.log(`\n📸 Processing Image Group: [${group.id}] ${group.title}`);
        const width = 640;
        const height = 360;

        const keyframes = [];
        for (const [idx, p] of (group.paths ?? []).entries()) {
            console.log(`   - Decoding and measuring depth [${idx + 1}/${group.paths!.length}]: ${p}`);
            const rgbPixels = decodeImageToRgb(p, width, height);
            const fovDegrees = group.suggestedFov ?? 65.0;
            const depth = await depthService.generatePixelBufferDepth(rgbPixels, width, height, { channels: 3, fovDegrees, medianDepthMeters: GROUP_MEDIAN_DEPTH_M });
            keyframes.push({ frameIndex: idx, rgbPixels, width, height, channels: 3, fovDegrees, metricDepths: depth.rayDepths });
        }

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
            const fovDegrees = single.suggestedFov ?? 65.0;
            const depth = await depthService.generatePixelBufferDepth(rgbPixels, width, height, { channels: 3, fovDegrees });
            const metricDepths = depth.rayDepths;
            console.log(`   - Depth: ${depth.modelUsed}, ${depth.depthUnits} units, ${depth.farPlanePixels} far-plane pixels`);

            const splats = ImageToSplatService.convertSingleImageToSplat({
                rgbPixels,
                width,
                height,
                channels: 3,
                metricDepths,
                fovDegrees,
                stride: 1,
                edgeTau: 0.08,
                minDepth: 0.05,
                maxDepth: 1000
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

main().then(() => shutdownAllPythonWorkerPools()).catch((err) => {
    console.error('❌ Error baking catalog splats:', err);
    shutdownAllPythonWorkerPools();
    process.exit(1);
});
