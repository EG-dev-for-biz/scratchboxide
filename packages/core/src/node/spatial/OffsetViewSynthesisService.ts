/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as fs from 'fs-extra';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { inpaintPanorama } from './Google360PanoramaPipelineService';
import { PanoramaDepthService } from './PanoramaDepthService';
import { SplatService } from '../3d-engine/splat-service';
import { BakedGaussian } from '../../common/geospatial-4d-protocol';

const execAsync = promisify(exec);

export interface OffsetSynthesisOptions {
    radius?: number;           // Radius of offset ring (default: 1.25m)
    numPoses?: number;         // Number of camera poses on the ring (default: 6)
    prompt?: string;           // Prompt for Imagen inpainting
    eyeHeight?: number;        // Camera eye height in meters (default 1.7)
    voxelSize?: number;        // Voxel size for final splat decimation merge (default 0.04m)
    mockExecution?: boolean;   // Mock mode for testing without real Imagen/GPU
    outDir?: string;
    skipOffsets?: boolean;     // Fast path skipping offset view synthesis
    sceneType?: 'indoor' | 'outdoor';
}

export interface OffsetSynthesisResult {
    success: boolean;
    fusedSplatPath: string;    // Path to the final merged and decimated .splat file
    fusedSpzPath: string;      // Path to the final merged .spz file
    originalSplatPath: string;  // Path to the original un-offset splats
    metaPath: string;           // Sidecar JSON (eyeHeight, walkRadius, counts) next to the .spz
    numOriginalSplats: number;
    numFusedSplats: number;
    activePoses: Array<{ x: number, y: number, z: number, disocclusionPercent: number }>;
}

/** Sidecar written next to every produced .spz so viewers can place the camera at the true capture height. */
export interface SplatWorldMeta {
    eyeHeight: number;
    walkRadius: number;
    numSplats: number;
    numOriginalSplats: number;
    poses: Array<{ x: number, y: number, z: number, disocclusionPercent: number }>;
    sourcePanorama: string;
}

/**
 * Service to synthesize multi-perspective offset viewpoints using depth meshes,
 * Google Vertex AI Imagen 3 disocclusion inpainting, and volumetric voxel-hash decimation.
 * Emulates World Labs Marble's walkable world "disocclusion fill" capability.
 */
export class OffsetViewSynthesisService {
    private offsetRendererBin: string;
    private splatCompilerBin: string;
    private depthService: PanoramaDepthService;

    constructor() {
        this.offsetRendererBin = path.resolve(process.cwd(), 'build/render_offset_panorama');
        this.splatCompilerBin = path.resolve(process.cwd(), 'build/panorama_to_3dgs_spz');
        this.depthService = new PanoramaDepthService();
    }

    /**
     * Synthesizes walkable offset perspectives and fuses them into a single watertight 3DGS world.
     */
    public async synthesizeOffsetViews(
        sourceRgbPath: string,
        sourceDepthPath: string,
        options: OffsetSynthesisOptions = {}
    ): Promise<OffsetSynthesisResult> {
        const outDir = options.outDir || path.resolve(process.cwd(), 'build/offset_views');
        await fs.ensureDir(outDir);

        const timestamp = Date.now();
        const baseName = path.basename(sourceRgbPath, path.extname(sourceRgbPath));
        const finalSplatPath = path.join(outDir, `${baseName}_fused_${timestamp}.splat`);
        const finalSpzPath = path.join(outDir, `${baseName}_fused_${timestamp}.spz`);
        const metaPath = finalSpzPath.replace(/\.spz$/, '.meta.json');
        const writeMeta = async (numSplats: number, numOriginalSplats: number, poses: SplatWorldMeta['poses']) => {
            const meta: SplatWorldMeta = {
                eyeHeight, walkRadius: poses.length > 0 ? radius : 0, numSplats, numOriginalSplats, poses, sourcePanorama: sourceRgbPath
            };
            await fs.outputJson(metaPath, meta, { spaces: 2 });
        };

        const eyeHeight = options.eyeHeight ?? 1.70; // callers should pass PanoramaDepthResult.eyeHeight
        const radius = options.radius ?? 1.25;
        const numPoses = options.numPoses ?? 6;
        const voxelSize = options.voxelSize ?? 0.04;
        const skipOffsets = options.skipOffsets ?? false;
        const mockExecution = options.mockExecution ?? false;

        console.log(`[OffsetSynthesis] Initializing view synthesis. Base: ${baseName} SkipOffsets: ${skipOffsets}`);

        // 1. Generate primary source splats first
        const originalSplatPath = path.join(outDir, `${baseName}_original_${timestamp}.splat`);
        const originalSpzPath = path.join(outDir, `${baseName}_original_${timestamp}.spz`);
        
        await execAsync(`"${this.splatCompilerBin}" --input "${sourceRgbPath}" --depth "${sourceDepthPath}" --out-splat "${originalSplatPath}" --out-spz "${originalSpzPath}" --eye-height ${eyeHeight} --stride 4`);
        
        const originalBuf = await fs.readFile(originalSplatPath);
        const originalSplats = SplatService.parseSplatBuffer(originalBuf);
        
        if (skipOffsets) {
            console.log(`[OffsetSynthesis] Fast path requested. Skipping disocclusion fill.`);
            await fs.copy(originalSplatPath, finalSplatPath);
            await fs.copy(originalSpzPath, finalSpzPath);
            await writeMeta(originalSplats.length, originalSplats.length, []);
            return {
                success: true,
                fusedSplatPath: finalSplatPath,
                fusedSpzPath: finalSpzPath,
                originalSplatPath,
                metaPath,
                numOriginalSplats: originalSplats.length,
                numFusedSplats: originalSplats.length,
                activePoses: []
            };
        }

        // Generate N camera offset poses on a horizontal ring
        const poses: Array<{ x: number, y: number, z: number }> = [];
        for (let i = 0; i < numPoses; i++) {
            const angle = (i * 2 * Math.PI) / numPoses;
            poses.push({
                x: Math.sin(angle) * radius,
                y: 0,
                z: -Math.cos(angle) * radius
            });
        }

        const activePosesReport: Array<{ x: number, y: number, z: number, disocclusionPercent: number }> = [];
        const allSplatSets: BakedGaussian[][] = [originalSplats];

        // 2. Iterate over the poses, warp, inpaint, estimate depth, compile splats
        for (let i = 0; i < poses.length; i++) {
            const pose = poses[i];
            const poseDir = path.join(outDir, `pose_${i}_${timestamp}`);
            await fs.ensureDir(poseDir);

            const offsetRgb = path.join(poseDir, `offset_rgb.png`);
            const offsetMask = path.join(poseDir, `offset_mask.png`);
            const offsetDepth = path.join(poseDir, `offset_depth.f32`);

            console.log(`[OffsetSynthesis] [Pose ${i}] Warping source to offset (${pose.x.toFixed(2)}, ${pose.y.toFixed(2)}, ${pose.z.toFixed(2)})`);

            // Execute the native C++ forward-warper
            const warpCmd = `"${this.offsetRendererBin}" --input "${sourceRgbPath}" --depth "${sourceDepthPath}" --offset-x ${pose.x} --offset-y ${pose.y} --offset-z ${pose.z} --out-rgb "${offsetRgb}" --out-mask "${offsetMask}" --out-depth "${offsetDepth}" --eye-height ${eyeHeight} --json`;
            const { stdout } = await execAsync(warpCmd);
            const warpStats = JSON.parse(stdout.trim());
            const disocclusionPercent = warpStats.disocclusionPercent ?? 0;

            activePosesReport.push({ ...pose, disocclusionPercent });

            // Only perform expensive inpainting if there are significant disocclusion holes
            if (disocclusionPercent < 0.1) {
                console.log(`[OffsetSynthesis] [Pose ${i}] Negligible disocclusion holes (${disocclusionPercent.toFixed(2)}%). Skipping inpaint.`);
                continue;
            }

            console.log(`[OffsetSynthesis] [Pose ${i}] Disocclusion holes found: ${disocclusionPercent.toFixed(2)}%. Triggering Vertex AI Imagen 3 inpainting...`);

            const inpaintedRgb = path.join(poseDir, `inpainted_rgb.png`);

            if (mockExecution) {
                // Copy warped rgb directly in mock mode
                await fs.copy(offsetRgb, inpaintedRgb);
            } else {
                try {
                    const prompt = options.prompt || 'Seamless highly detailed continuous background under consistent cinematic lighting, photorealistic matching albedo';
                    const inpaintRes = await inpaintPanorama({
                        inputImagePath: offsetRgb,
                        maskImagePath: offsetMask,
                        prompt,
                        outputImagePath: inpaintedRgb,
                        mockExecution: false
                    });

                    if (!inpaintRes.success) {
                        throw new Error('Imagen inpaint failed');
                    }
                } catch (e: any) {
                    console.warn(`[OffsetSynthesis] [Pose ${i}] Imagen inpainting failed: ${e.message}. Falling back to warped image.`);
                    await fs.copy(offsetRgb, inpaintedRgb);
                }
            }

            console.log(`[OffsetSynthesis] [Pose ${i}] Generating depth map for inpainted view...`);
            const inpaintedDepthRes = await this.depthService.generatePanoramaDepth(inpaintedRgb, {
                sceneType: options.sceneType || 'outdoor',
                eyeHeight,
                mock: mockExecution
            });

            console.log(`[OffsetSynthesis] [Pose ${i}] Converting disoccluded regions to mask-gated Gaussian splats...`);
            const offsetSplat = path.join(poseDir, `offset.splat`);
            const offsetSpz = path.join(poseDir, `offset.spz`);

            // Run splat compiler with mask-gating: only pixels that were originally disoccluded get splats!
            const compileCmd = `"${this.splatCompilerBin}" --input "${inpaintedRgb}" --depth "${inpaintedDepthRes.depthPath}" --mask "${offsetMask}" --out-splat "${offsetSplat}" --out-spz "${offsetSpz}" --eye-height ${eyeHeight} --stride 4`;
            await execAsync(compileCmd);

            if (await fs.pathExists(offsetSplat)) {
                const splatBuf = await fs.readFile(offsetSplat);
                const poseSplats = SplatService.parseSplatBuffer(splatBuf);
                
                // Adjust position of offset splats by camera translation relative to capture center [0,0,0]
                // Since our renderer warps relative to offset, the resulting coordinates must be shifted back
                // into world coordinates centered at [0,0,0].
                for (const s of poseSplats) {
                    s.position[0] += pose.x;
                    s.position[1] += pose.y;
                    s.position[2] += pose.z;
                }
                
                allSplatSets.push(poseSplats);
                console.log(`[OffsetSynthesis] [Pose ${i}] Generated ${poseSplats.length} mask-gated splats.`);
            }
        }

        // 3. Volumetric Voxel-Hash Decimation and Fusion Merge of all splat sets
        console.log(`[OffsetSynthesis] Fusing ${allSplatSets.length} splat sets into watertight world coordinate space...`);
        const fusedSplats = this.fuseMultiViewSplats(allSplatSets, voxelSize);

        // 4. Save fused standard binary .splat and compressed .spz
        const fusedBuf = SplatService.serializeSplatBuffer(fusedSplats);
        await fs.outputFile(finalSplatPath, fusedBuf);

        const fusedSpzBuf = SplatService.serializeSpzBuffer(fusedSplats);
        await fs.outputFile(finalSpzPath, fusedSpzBuf);
        await writeMeta(fusedSplats.length, originalSplats.length, activePosesReport);

        console.log(`[OffsetSynthesis] Watertight world complete. Original: ${originalSplats.length} Fused: ${fusedSplats.length} VoxelSize: ${voxelSize}m`);

        return {
            success: true,
            fusedSplatPath: finalSplatPath,
            fusedSpzPath: finalSpzPath,
            originalSplatPath,
            metaPath,
            numOriginalSplats: originalSplats.length,
            numFusedSplats: fusedSplats.length,
            activePoses: activePosesReport
        };
    }

    /**
     * Highly optimized 3D voxel-hash decimation grid.
     * Merges overlapping splat clouds, resolving occlusion boundary seams
     * and maintaining balanced point density.
     */
    private fuseMultiViewSplats(splatSets: BakedGaussian[][], voxelSize: number): BakedGaussian[] {
        const grid: Map<string, BakedGaussian> = new Map();
        const invVoxel = 1.0 / Math.max(0.001, voxelSize);

        for (const set of splatSets) {
            for (const s of set) {
                const bx = Math.floor(s.position[0] * invVoxel);
                const by = Math.floor(s.position[1] * invVoxel);
                const bz = Math.floor(s.position[2] * invVoxel);
                const key = `${bx},${by},${bz}`;

                const existing = grid.get(key);
                if (!existing) {
                    grid.set(key, s);
                } else {
                    // Volume of Gaussian ellipsoid: scale.x * scale.y * scale.z
                    const sVol = s.scale[0] * s.scale[1] * s.scale[2];
                    const existingVol = existing.scale[0] * existing.scale[1] * existing.scale[2];

                    if (sVol < existingVol) {
                        // Keep the higher resolution splat (smaller volume)
                        grid.set(key, s);
                    } else {
                        // Smoothly blend color and keep highest opacity
                        existing.colorRgb[0] = (existing.colorRgb[0] + s.colorRgb[0]) * 0.5;
                        existing.colorRgb[1] = (existing.colorRgb[1] + s.colorRgb[1]) * 0.5;
                        existing.colorRgb[2] = (existing.colorRgb[2] + s.colorRgb[2]) * 0.5;
                        existing.opacity = Math.max(existing.opacity, s.opacity);
                    }
                }
            }
        }

        return Array.from(grid.values());
    }
}
