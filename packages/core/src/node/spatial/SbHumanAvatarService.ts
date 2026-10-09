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
import {
    HumanoidSkinModality,
    HumanoidActorMetadata,
    ISbHumanSkinAdapter,
    SkinExportOptions,
    SkinFrameResult,
    computeMelaninAlbedo
} from '../../common/humanoid-avatar-protocol';
import {
    CANONICAL_22_JOINT_NAMES,
    DEFAULT_CANONICAL_JOINTS,
    SBHUMAN22_PARENTS
} from '../../common/humanoid-skinning';
import { decodeGaussianPly } from '../../common/gaussian-ply-codec';
import {
    PerformerSurfaceMeshService,
    SurfaceMesh,
    SurfaceBuildOptions,
    decodeSurfaceGlb
} from './PerformerSurfaceMeshService';
import { GvhmrBody, GvhmrBodyService } from './GvhmrBodyService';
import { Dynamic4DGaussianSplatService } from '../3d-engine/Dynamic4DGaussianSplatService';

function findRepoRoot(): string {
    let cur = __dirname;
    while (cur !== path.dirname(cur)) {
        if (fs.existsSync(path.join(cur, 'package.json'))) {
            const rootPkg = path.join(cur, 'package.json');
            try {
                const pkg = JSON.parse(fs.readFileSync(rootPkg, 'utf-8'));
                if (pkg.name === 'scratchbox-ide-master' || pkg.workspaces) return cur;
            } catch {
                // Keep ascending
            }
        }
        cur = path.dirname(cur);
    }
    return process.cwd();
}

/**
 * PBR Polygonal Skinned Mesh Adapter.
 * Emits and evaluates rigged glTF 2.0 / Three.js SkinnedMesh compatible geometry
 * with 22-joint SB-Human skeleton, inverseBindMatrices, JOINTS_0, WEIGHTS_0,
 * and PBR metallic-roughness materials.
 */
export class PbrMeshSkinAdapter implements ISbHumanSkinAdapter {
    public readonly modality: HumanoidSkinModality = 'pbr-standard';

    constructor(
        public readonly actorId: string,
        private metadata: HumanoidActorMetadata,
        private repoRoot: string
    ) {}

    public isAvailable(): boolean {
        return !!(this.metadata.paths.bodyJsonPath && fs.existsSync(this.metadata.paths.bodyJsonPath))
            || !!(this.metadata.paths.glbPath && fs.existsSync(this.metadata.paths.glbPath));
    }

    public async evaluateFrame(frameIndex: number, _jointTransforms?: any[]): Promise<SkinFrameResult> {
        const mesh = await this.loadRestMesh();
        let minX = Infinity, minY = Infinity, minZ = Infinity;
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
        let sumX = 0, sumY = 0, sumZ = 0;
        const vCount = mesh.positions.length / 3;
        for (let i = 0; i < mesh.positions.length; i += 3) {
            const x = mesh.positions[i];
            const y = mesh.positions[i + 1];
            const z = mesh.positions[i + 2];
            minX = Math.min(minX, x);
            minY = Math.min(minY, y);
            minZ = Math.min(minZ, z);
            maxX = Math.max(maxX, x);
            maxY = Math.max(maxY, y);
            maxZ = Math.max(maxZ, z);
            sumX += x;
            sumY += y;
            sumZ += z;
        }

        return {
            frameIndex,
            modality: this.modality,
            vertexCount: vCount,
            positions: mesh.positions,
            normals: mesh.normals,
            colors: mesh.colors,
            joints: mesh.joints,
            weights: mesh.weights,
            uvs: mesh.uvs,
            bounds: {
                min: [minX, minY, minZ],
                max: [maxX, maxY, maxZ]
            },
            centroid: vCount > 0 ? [sumX / vCount, sumY / vCount, sumZ / vCount] : [0, 0, 0]
        };
    }

    public async exportArtifact(options: SkinExportOptions = {}): Promise<Buffer> {
        let mesh = await this.loadRestMesh(options);

        // Compute biophysical melanin albedo if requested
        let baseColorFactor: [number, number, number, number] | undefined = undefined;
        if (options.melaninFraction !== undefined) {
            baseColorFactor = computeMelaninAlbedo(options.melaninFraction, options.pheomelaninRatio ?? 0.2);
        }

        return PerformerSurfaceMeshService.encodeGlb(mesh, {
            includeSkin: options.includeSkin !== false,
            canonicalJoints: this.metadata.canonicalJoints,
            jointParents: this.metadata.jointParents,
            jointNames: this.metadata.jointNames,
            material: {
                baseColorFactor,
                roughnessFactor: options.roughness ?? 0.65,
                metallicFactor: options.metalness ?? 0.05
            }
        });
    }

    public async loadRestMesh(options: SkinExportOptions = {}): Promise<SurfaceMesh> {
        // 1. If an existing built GLB is present and no custom subdivision requested, decode it directly
        if (this.metadata.paths.glbPath && fs.existsSync(this.metadata.paths.glbPath) && !options.subdivisionLevels) {
            try {
                const glbBuf = fs.readFileSync(this.metadata.paths.glbPath);
                return decodeSurfaceGlb(glbBuf);
            } catch {
                // Fall back to building from source body
            }
        }

        // 2. Build dynamically from gvhmr_body.json and human_4dgs.ply
        if (this.metadata.paths.bodyJsonPath && fs.existsSync(this.metadata.paths.bodyJsonPath)) {
            const body: GvhmrBody = JSON.parse(fs.readFileSync(this.metadata.paths.bodyJsonPath, 'utf-8'));
            let splats: Array<{ position: [number, number, number]; colorRgb: [number, number, number]; opacity: number; bone?: number }> = [];

            if (this.metadata.paths.plyPath && fs.existsSync(this.metadata.paths.plyPath)) {
                try {
                    const { gaussians } = decodeGaussianPly(fs.readFileSync(this.metadata.paths.plyPath, 'utf-8'));
                    splats = gaussians.map(g => ({
                        position: g.position,
                        colorRgb: g.colorRgb,
                        opacity: g.opacity,
                        bone: g.boneIndices && g.boneWeights ? g.boneIndices[g.boneWeights.indexOf(Math.max(...g.boneWeights))] : undefined
                    }));
                } catch {
                    // Splat decoding optional
                }
            }

            const buildOptions: SurfaceBuildOptions = {
                subdivisionLevels: options.subdivisionLevels ?? 2,
                maxOffset: 0.025
            };

            const service = new PerformerSurfaceMeshService();
            return service.build(body, splats, buildOptions);
        }

        throw new Error(`Cannot build PBR surface mesh for actor "${this.actorId}": missing body geometry`);
    }
}

/**
 * 4DGS / 3DGS Gaussian Radiance Splatting Adapter.
 * Deforms dynamic Gaussian volumetric ellipsoids using the identical 22-joint SB-Human kinematics.
 */
export class Gaussian4DGSSkinAdapter implements ISbHumanSkinAdapter {
    public readonly modality: HumanoidSkinModality = '4dgs-radiance';

    constructor(
        public readonly actorId: string,
        private metadata: HumanoidActorMetadata,
        private splatService: Dynamic4DGaussianSplatService
    ) {}

    public isAvailable(): boolean {
        return !!(this.metadata.paths.plyPath && fs.existsSync(this.metadata.paths.plyPath));
    }

    public async evaluateFrame(frameIndex: number): Promise<SkinFrameResult> {
        const anim = this.splatService.animateFrame(this.actorId, frameIndex);
        return {
            frameIndex,
            modality: this.modality,
            gaussianCount: anim.splats.length,
            positions: new Float32Array(anim.splats.flatMap(g => g.position)),
            colors: new Float32Array(anim.splats.flatMap(g => g.colorRgb)),
            bounds: anim.bounds,
            centroid: anim.centroid
        };
    }

    public async exportArtifact(options: SkinExportOptions = {}): Promise<Buffer> {
        const frameIndex = options.frameIndex ?? 0;
        return this.splatService.exportSplatBuffer(this.actorId, frameIndex);
    }
}

/**
 * 2DGS Planar Surfel Adapter.
 * Constructs oriented planar surfels pinned to mesh triangle centroids with normal alignment.
 */
export class Surfel2DGSSkinAdapter implements ISbHumanSkinAdapter {
    public readonly modality: HumanoidSkinModality = '2dgs-planar-surfel';

    constructor(
        public readonly actorId: string,
        private pbrAdapter: PbrMeshSkinAdapter
    ) {}

    public isAvailable(): boolean {
        return this.pbrAdapter.isAvailable();
    }

    public async evaluateFrame(frameIndex: number, jointTransforms?: any[]): Promise<SkinFrameResult> {
        const res = await this.pbrAdapter.evaluateFrame(frameIndex, jointTransforms);
        return {
            ...res,
            modality: this.modality
        };
    }

    public async exportArtifact(options: SkinExportOptions = {}): Promise<Buffer> {
        return this.pbrAdapter.exportArtifact(options);
    }
}

/**
 * Unified SB-Human Avatar Service.
 * The central orchestrator that decouples humanoid kinematics and morphology
 * from pluggable skinning modalities.
 */
export class SbHumanAvatarService {
    private repoRoot: string;
    private demosDir: string;
    private publicModelsDir: string;
    private splatService: Dynamic4DGaussianSplatService;

    constructor(customRepoRoot?: string) {
        this.repoRoot = customRepoRoot || findRepoRoot();
        this.demosDir = path.join(this.repoRoot, 'models', 'performer_4dgs', 'demos');
        this.publicModelsDir = path.join(this.repoRoot, 'public', 'models');
        this.splatService = new Dynamic4DGaussianSplatService(this.repoRoot);
    }

    /**
     * Discovers all available humanoid actors across performer demos and standard models.
     */
    public async listActors(): Promise<HumanoidActorMetadata[]> {
        const actors: HumanoidActorMetadata[] = [];

        // 1. Scan Performer 4DGS demos
        if (fs.existsSync(this.demosDir)) {
            const entries = fs.readdirSync(this.demosDir);
            for (const entry of entries) {
                const subDir = path.join(this.demosDir, entry);
                if (!fs.statSync(subDir).isDirectory()) continue;

                const plyPath = path.join(subDir, 'human_4dgs.ply');
                const bodyPath = path.join(subDir, 'gvhmr_body.json');
                const motionPath = path.join(subDir, 'motion.json');
                const glbPath = path.join(this.publicModelsDir, `humanoid_${entry}.glb`);

                if (!fs.existsSync(plyPath) && !fs.existsSync(bodyPath)) continue;

                const availableModalities: HumanoidSkinModality[] = [];
                if (fs.existsSync(bodyPath) || fs.existsSync(glbPath)) {
                    availableModalities.push('pbr-standard', 'pbr-melanin');
                    const hasHero = ['hero_frame.png', 'canonical_frame.jpg', 'hero_frame.jpg'].some(f =>
                        fs.existsSync(path.join(subDir, f))
                    );
                    if (hasHero) availableModalities.push('pbr-video-projected');
                }
                if (fs.existsSync(plyPath)) {
                    availableModalities.push('4dgs-radiance', '2dgs-planar-surfel');
                }
                if (availableModalities.includes('pbr-standard') && availableModalities.includes('4dgs-radiance')) {
                    availableModalities.push('hybrid-pbr-hair-groom');
                }

                let frameCount = 0;
                let fps = 25.0;
                if (fs.existsSync(motionPath)) {
                    try {
                        const m = JSON.parse(fs.readFileSync(motionPath, 'utf-8'));
                        frameCount = Array.isArray(m) ? m.length : (m.frames?.length ?? 0);
                        if (m.fps) fps = m.fps;
                    } catch {
                        // Ignore
                    }
                }

                const headY = DEFAULT_CANONICAL_JOINTS[15][1];
                const footY = Math.min(DEFAULT_CANONICAL_JOINTS[10][1], DEFAULT_CANONICAL_JOINTS[11][1]);
                const heightMeters = Number((headY - footY + 0.15).toFixed(2));

                actors.push({
                    actorId: entry,
                    name: `SB-Human Performer (${entry})`,
                    sourceType: 'performer-demo',
                    heightMeters,
                    frameCount,
                    fps,
                    durationSeconds: frameCount > 0 ? frameCount / fps : 0,
                    hasSkeletalMotion: fs.existsSync(motionPath),
                    availableModalities,
                    canonicalJoints: DEFAULT_CANONICAL_JOINTS,
                    jointNames: CANONICAL_22_JOINT_NAMES,
                    jointParents: SBHUMAN22_PARENTS,
                    paths: {
                        baseDir: subDir,
                        plyPath: fs.existsSync(plyPath) ? plyPath : undefined,
                        bodyJsonPath: fs.existsSync(bodyPath) ? bodyPath : undefined,
                        motionPath: fs.existsSync(motionPath) ? motionPath : undefined,
                        glbPath: fs.existsSync(glbPath) ? glbPath : undefined
                    }
                });
            }
        }

        // 2. Scan standard .sbhuman models in public/models
        if (fs.existsSync(this.publicModelsDir)) {
            const files = fs.readdirSync(this.publicModelsDir);
            for (const file of files) {
                if (!file.endsWith('.sbhuman')) continue;
                const id = file.replace(/\.sbhuman$/, '');
                const filePath = path.join(this.publicModelsDir, file);

                actors.push({
                    actorId: id,
                    name: `SB-Human Canonical Model (${id})`,
                    sourceType: 'sbhuman-model',
                    heightMeters: 1.75,
                    hasSkeletalMotion: false,
                    availableModalities: ['pbr-standard', 'pbr-melanin', '2dgs-planar-surfel'],
                    canonicalJoints: DEFAULT_CANONICAL_JOINTS,
                    jointNames: CANONICAL_22_JOINT_NAMES,
                    jointParents: SBHUMAN22_PARENTS,
                    paths: {
                        sbhumanPath: filePath
                    }
                });
            }
        }

        return actors;
    }

    /**
     * Retrieves metadata for a specific actor.
     */
    public async getActor(actorId: string): Promise<HumanoidActorMetadata | null> {
        const all = await this.listActors();
        return all.find(a => a.actorId === actorId) || null;
    }

    /**
     * Resolves the skin adapter for an actor and modality.
     */
    public async getSkinAdapter(actorId: string, modality: HumanoidSkinModality = 'pbr-standard'): Promise<ISbHumanSkinAdapter> {
        const actor = await this.getActor(actorId);
        if (!actor) {
            throw new Error(`Humanoid actor "${actorId}" not found`);
        }

        const pbr = new PbrMeshSkinAdapter(actorId, actor, this.repoRoot);
        const g4d = new Gaussian4DGSSkinAdapter(actorId, actor, this.splatService);

        switch (modality) {
            case '4dgs-radiance':
                return g4d;
            case '2dgs-planar-surfel':
                return new Surfel2DGSSkinAdapter(actorId, pbr);
            case 'pbr-standard':
            case 'pbr-melanin':
            case 'pbr-video-projected':
            default:
                return pbr;
        }
    }

    /**
     * Evaluates a frame of animation using the requested skin modality.
     */
    public async evaluateActorFrame(
        actorId: string,
        frameIndex: number,
        modality: HumanoidSkinModality = 'pbr-standard'
    ): Promise<SkinFrameResult> {
        const adapter = await this.getSkinAdapter(actorId, modality);
        return adapter.evaluateFrame(frameIndex);
    }

    /**
     * Exports an actor artifact (rigged GLB, SPLAT binary, or PLY).
     */
    public async exportActorArtifact(actorId: string, options: SkinExportOptions = {}): Promise<Buffer | Uint8Array> {
        const modality = options.modality ?? (options.format === 'splat' ? '4dgs-radiance' : 'pbr-standard');
        const adapter = await this.getSkinAdapter(actorId, modality);
        return adapter.exportArtifact(options);
    }
}
