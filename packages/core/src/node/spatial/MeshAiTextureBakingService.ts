/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { RenderMesh3D } from './HeadlessMeshSilhouetteRenderer';
import { CameraPose6DOF } from './SubPixelEdgeAlignmentOptimizer';
import { NativeAiRenderEngineService } from './NativeAiRenderEngineService';
import { createDefaultStationImageGenerator, StationImageGenerator } from './BeautifyStationService';

export interface OrthogonalCamera {
    name: 'Front' | 'Back' | 'Left' | 'Right' | 'Top' | 'Bottom';
    pose: CameraPose6DOF;
}

export interface BakedView {
    name: 'Front' | 'Back' | 'Left' | 'Right' | 'Top' | 'Bottom';
    image: Buffer;
    pose: CameraPose6DOF;
}

export interface MeshAiTextureBakingServiceOptions {
    generator?: StationImageGenerator;
    workspaceRoot?: string;
}

export class MeshAiTextureBakingService {
    private generator: StationImageGenerator;
    private workspaceRoot: string;

    constructor(options?: MeshAiTextureBakingServiceOptions) {
        this.workspaceRoot = options?.workspaceRoot || process.cwd();
        this.generator = options?.generator || createDefaultStationImageGenerator({
            workspaceRoot: this.workspaceRoot,
            allowProceduralGenerator: true
        });
    }

    /**
     * Computes the axis-aligned bounding box (AABB) of the mesh, and constructs
     * a 6-camera cardinal orthogonal camera rig focusing on the center of the mesh.
     */
    public generateOrthogonalCameraRig(mesh: RenderMesh3D): OrthogonalCamera[] {
        const verts = mesh.vertices;
        let minX = Infinity, minY = Infinity, minZ = Infinity;
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

        const count = verts.length;
        for (let i = 0; i < count; i += 3) {
            const x = verts[i];
            const y = verts[i + 1];
            const z = verts[i + 2];

            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
            if (z < minZ) minZ = z;
            if (z > maxZ) maxZ = z;
        }

        // Handle empty or degenerate mesh bounds safely
        if (minX === Infinity) {
            minX = -1; minY = -1; minZ = -1;
            maxX = 1; maxY = 1; maxZ = 1;
        }

        const centerX = (minX + maxX) / 2;
        const centerY = (minY + maxY) / 2;
        const centerZ = (minZ + maxZ) / 2;

        const dx = maxX - minX;
        const dy = maxY - minY;
        const dz = maxZ - minZ;
        const diagonal = Math.hypot(dx, dy, dz) || 1.0;

        // Ensure cameras are positioned at a safe non-zero standoff distance
        const distance = Math.max(diagonal * 1.5, 2.5);

        const names: ('Front' | 'Back' | 'Left' | 'Right' | 'Top' | 'Bottom')[] = [
            'Front', 'Back', 'Left', 'Right', 'Top', 'Bottom'
        ];

        return names.map((name) => {
            let cx = centerX;
            let cy = centerY;
            let cz = centerZ;
            let up: [number, number, number] = [0, 1, 0];

            switch (name) {
                case 'Front':
                    cz = centerZ + distance;
                    break;
                case 'Back':
                    cz = centerZ - distance;
                    break;
                case 'Left':
                    cx = centerX - distance;
                    break;
                case 'Right':
                    cx = centerX + distance;
                    break;
                case 'Top':
                    cy = centerY + distance;
                    up = [0, 0, -1]; // Facing straight down the -Y axis
                    break;
                case 'Bottom':
                    cy = centerY - distance;
                    up = [0, 0, 1]; // Facing straight up the +Y axis
                    break;
            }

            return {
                name,
                pose: {
                    x: cx,
                    y: cy,
                    z: cz,
                    targetX: centerX,
                    targetY: centerY,
                    targetZ: centerZ,
                    up,
                    fov: 50 // Standard perspective lens
                }
            };
        });
    }

    /**
     * Iterates through the cardinal orthogonal viewpoints of the mesh, renders clay/mist passes
     * for each view, beautifies each view with Nano Banana matching the style prompt, and returns
     * the baked multi-angle photorealistic images.
     */
    public async bakeMeshTexturesWithAi(request: {
        mesh: RenderMesh3D;
        stylePrompt: string;
        width?: number;
        height?: number;
    }): Promise<{ views: BakedView[] }> {
        const width = request.width || 512;
        const height = request.height || 512;

        const rig = this.generateOrthogonalCameraRig(request.mesh);
        const renderer = new NativeAiRenderEngineService({ generator: this.generator, workspaceRoot: this.workspaceRoot });

        const views: BakedView[] = [];

        for (const camera of rig) {
            // Render and restyle the view with Nano Banana
            const beauty = await renderer.renderAiBeautyFrame({
                mesh: request.mesh,
                pose: camera.pose,
                prompt: `A close-up view of ${request.stylePrompt} material surface, high definition, flat uniform studio lighting, perfectly seamless textures. View direction: ${camera.name}`,
                width,
                height
            });

            views.push({
                name: camera.name,
                image: beauty.image,
                pose: camera.pose
            });
        }

        return { views };
    }
}
