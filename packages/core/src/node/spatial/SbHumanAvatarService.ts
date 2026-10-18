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
    SBHUMAN22_PARENTS,
    Vec3,
    applyMat3,
    computeBoneRotations,
    skinPoint
} from '../../common/humanoid-skinning';
import { PipelineError } from '../../common/errors/pipeline-errors';
import { decodeGaussianPly } from '../../common/gaussian-ply-codec';
import {
    PerformerSurfaceMeshService,
    SurfaceMesh,
    SurfaceBuildOptions,
    decodeSurfaceGlb
} from './PerformerSurfaceMeshService';
import { GvhmrBody, GvhmrBodyService } from './GvhmrBodyService';
import { Dynamic4DGaussianSplatService, HumanoidMotionData } from '../3d-engine/Dynamic4DGaussianSplatService';

/** The actor lacks the data needed to pose it (skin weights, a motion track, or canonical joints). */
export class AvatarSkinningDataMissingError extends PipelineError {
    readonly code = 'avatar_skinning_data_missing';

    constructor(readonly actorId: string, readonly missing: string, detail?: string) {
        super(`Cannot pose actor "${actorId}": ${missing} is missing${detail ? ` (${detail})` : ''}`);
        this.name = 'AvatarSkinningDataMissingError';
    }
}

/** The requested frame is outside the actor's motion track. */
export class AvatarFrameOutOfRangeError extends PipelineError {
    readonly code = 'avatar_frame_out_of_range';

    constructor(readonly actorId: string, readonly frameIndex: number, readonly frameCount: number) {
        super(`Actor "${actorId}" has ${frameCount} motion frames; frame ${frameIndex} does not exist (valid: 0..${frameCount - 1})`);
        this.name = 'AvatarFrameOutOfRangeError';
    }
}

/** No skin adapter implements the requested modality. */
export class UnsupportedSkinModalityError extends PipelineError {
    readonly code = 'unsupported_skin_modality';

    constructor(readonly modality: string, readonly supported: readonly string[]) {
        super(`Skin modality "${modality}" is not implemented; supported modalities: ${supported.join(', ')}`);
        this.name = 'UnsupportedSkinModalityError';
    }
}

/** Modalities with a real adapter. Others are rejected rather than routed to a different one. */
export const SUPPORTED_SKIN_MODALITIES: readonly HumanoidSkinModality[] = [
    'pbr-standard',
    'pbr-melanin',
    'pbr-video-projected',
    '4dgs-radiance',
    '2dgs-planar-surfel'
];

/** Result of posing a frame, with the provenance of the motion that drove it. */
export interface PosedSkinFrameResult extends SkinFrameResult {
    /** `motion_source` from motion.json (e.g. 'mediapipe_pose_track', or 'synthetic_idle' for procedural motion). */
    motionSource?: string;
    timestamp?: number;
}

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

    /**
     * Poses the rest mesh at `frameIndex` with 4-bone linear blend skinning driven by the actor's
     * motion track (motion.json): per-joint rotations canonical -> posed, then
     * v' = sum_k w_k (J_posed[j_k] + R_jk (v - J_canon[j_k])), normals rotated the same way.
     * Throws when the mesh has no skin weights, the actor has no motion track, or the frame is out of range.
     */
    public async evaluateFrame(frameIndex: number, _jointTransforms?: any[]): Promise<PosedSkinFrameResult> {
        const mesh = await this.loadRestMesh();
        const vCount = mesh.positions.length / 3;
        const skinIdx = mesh.skinIndices;
        const skinW = mesh.skinWeights;
        if (!skinIdx || !skinW || skinIdx.length !== vCount * 4 || skinW.length !== vCount * 4) {
            throw new AvatarSkinningDataMissingError(this.actorId, 'per-vertex JOINTS_0/WEIGHTS_0 skin data',
                `mesh has ${vCount} vertices, ${skinIdx?.length ?? 0} joint indices, ${skinW?.length ?? 0} weights`);
        }

        const motionPath = this.metadata.paths.motionPath;
        if (!motionPath || !fs.existsSync(motionPath)) {
            throw new AvatarSkinningDataMissingError(this.actorId, 'motion track (motion.json)',
                'run the performer pipeline on a video to track motion for this actor');
        }
        const motion: HumanoidMotionData = JSON.parse(fs.readFileSync(motionPath, 'utf-8'));
        const frames = Array.isArray(motion.frames) ? motion.frames : [];
        if (!Number.isInteger(frameIndex) || frameIndex < 0 || frameIndex >= frames.length) {
            throw new AvatarFrameOutOfRangeError(this.actorId, frameIndex, frames.length);
        }
        const canonical = motion.canonical_joints as Vec3[] | undefined;
        const posed = frames[frameIndex].joint_positions_3d as Vec3[] | undefined;
        if (!canonical || canonical.length < SBHUMAN22_PARENTS.length) {
            throw new AvatarSkinningDataMissingError(this.actorId, 'canonical_joints in motion.json',
                `need ${SBHUMAN22_PARENTS.length}, found ${canonical?.length ?? 0}`);
        }
        if (!posed || posed.length < SBHUMAN22_PARENTS.length) {
            throw new AvatarSkinningDataMissingError(this.actorId, `joint_positions_3d for frame ${frameIndex}`,
                `need ${SBHUMAN22_PARENTS.length}, found ${posed?.length ?? 0}`);
        }

        const rotations = computeBoneRotations(canonical, posed);
        const positions = new Float32Array(mesh.positions.length);
        const normals = mesh.normals ? new Float32Array(mesh.normals.length) : undefined;
        let minX = Infinity, minY = Infinity, minZ = Infinity;
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
        let sumX = 0, sumY = 0, sumZ = 0;
        for (let v = 0; v < vCount; v++) {
            const o = v * 3;
            const bi = skinIdx.subarray(v * 4, v * 4 + 4);
            const bw = skinW.subarray(v * 4, v * 4 + 4);
            const [x, y, z] = skinPoint(
                [mesh.positions[o], mesh.positions[o + 1], mesh.positions[o + 2]],
                bi, bw, canonical, posed, rotations
            );
            positions[o] = x;
            positions[o + 1] = y;
            positions[o + 2] = z;
            minX = Math.min(minX, x); maxX = Math.max(maxX, x);
            minY = Math.min(minY, y); maxY = Math.max(maxY, y);
            minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
            sumX += x; sumY += y; sumZ += z;

            if (normals && mesh.normals) {
                const n: Vec3 = [mesh.normals[o], mesh.normals[o + 1], mesh.normals[o + 2]];
                let nx = 0, ny = 0, nz = 0;
                for (let k = 0; k < 4; k++) {
                    const w = bw[k];
                    const j = bi[k];
                    if (!(w > 1e-6) || j >= rotations.length) continue;
                    const r = applyMat3(rotations[j], n);
                    nx += w * r[0]; ny += w * r[1]; nz += w * r[2];
                }
                const len = Math.hypot(nx, ny, nz);
                if (len > 1e-9) {
                    normals[o] = nx / len; normals[o + 1] = ny / len; normals[o + 2] = nz / len;
                } else {
                    normals[o] = n[0]; normals[o + 1] = n[1]; normals[o + 2] = n[2];
                }
            }
        }

        return {
            frameIndex,
            modality: this.modality,
            vertexCount: vCount,
            positions,
            normals,
            colors: mesh.colors,
            joints: skinIdx,
            weights: skinW,
            uvs: mesh.uvs,
            bounds: {
                min: [minX, minY, minZ],
                max: [maxX, maxY, maxZ]
            },
            centroid: vCount > 0 ? [sumX / vCount, sumY / vCount, sumZ / vCount] : [0, 0, 0],
            motionSource: motion.motion_source,
            timestamp: frames[frameIndex].timestamp
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

    public async evaluateFrame(frameIndex: number): Promise<PosedSkinFrameResult> {
        const { motion } = this.splatService.loadAvatar(this.actorId);
        const frameCount = motion.frames?.length ?? 0;
        if (!Number.isInteger(frameIndex) || frameIndex < 0 || frameIndex >= frameCount) {
            throw new AvatarFrameOutOfRangeError(this.actorId, frameIndex, frameCount);
        }
        const anim = this.splatService.animateFrame(this.actorId, frameIndex);
        return {
            frameIndex: anim.frameIndex,
            modality: this.modality,
            motionSource: motion.motion_source,
            timestamp: anim.timestamp,
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
 * Constructs oriented planar surfels pinned to the posed mesh's triangle centroids, oriented by the
 * face normals: one surfel per triangle (positions = centroids, normals = unit face normals,
 * colors = mean of the three vertex colors).
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

    public async evaluateFrame(frameIndex: number, jointTransforms?: any[]): Promise<PosedSkinFrameResult> {
        const posed = await this.pbrAdapter.evaluateFrame(frameIndex, jointTransforms);
        const { indices } = await this.pbrAdapter.loadRestMesh();
        const p = posed.positions!;
        const c = posed.colors;
        const triCount = indices.length / 3;
        const positions = new Float32Array(triCount * 3);
        const normals = new Float32Array(triCount * 3);
        const colors = c ? new Float32Array(triCount * 3) : undefined;
        let minX = Infinity, minY = Infinity, minZ = Infinity;
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
        let sumX = 0, sumY = 0, sumZ = 0;
        for (let t = 0; t < triCount; t++) {
            const a = indices[t * 3] * 3, b = indices[t * 3 + 1] * 3, d = indices[t * 3 + 2] * 3;
            const cx = (p[a] + p[b] + p[d]) / 3;
            const cy = (p[a + 1] + p[b + 1] + p[d + 1]) / 3;
            const cz = (p[a + 2] + p[b + 2] + p[d + 2]) / 3;
            positions[t * 3] = cx; positions[t * 3 + 1] = cy; positions[t * 3 + 2] = cz;
            const e1x = p[b] - p[a], e1y = p[b + 1] - p[a + 1], e1z = p[b + 2] - p[a + 2];
            const e2x = p[d] - p[a], e2y = p[d + 1] - p[a + 1], e2z = p[d + 2] - p[a + 2];
            const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
            const len = Math.hypot(nx, ny, nz) || 1;
            normals[t * 3] = nx / len; normals[t * 3 + 1] = ny / len; normals[t * 3 + 2] = nz / len;
            if (colors && c) {
                for (let k = 0; k < 3; k++) colors[t * 3 + k] = (c[a + k] + c[b + k] + c[d + k]) / 3;
            }
            minX = Math.min(minX, cx); maxX = Math.max(maxX, cx);
            minY = Math.min(minY, cy); maxY = Math.max(maxY, cy);
            minZ = Math.min(minZ, cz); maxZ = Math.max(maxZ, cz);
            sumX += cx; sumY += cy; sumZ += cz;
        }
        return {
            frameIndex: posed.frameIndex,
            modality: this.modality,
            gaussianCount: triCount,
            positions,
            normals,
            colors,
            bounds: { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] },
            centroid: triCount > 0 ? [sumX / triCount, sumY / triCount, sumZ / triCount] : [0, 0, 0],
            motionSource: posed.motionSource,
            timestamp: posed.timestamp
        };
    }

    /** Exports the rigged PBR source mesh the surfels are derived from (no surfel-specific file format yet). */
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

        // The modality is a requested adapter id, not a domain taxonomy: anything without an adapter is
        // rejected instead of being served by a different one.
        if (!SUPPORTED_SKIN_MODALITIES.includes(modality)) {
            throw new UnsupportedSkinModalityError(modality, SUPPORTED_SKIN_MODALITIES);
        }
        if (modality === '4dgs-radiance') return g4d;
        if (modality === '2dgs-planar-surfel') return new Surfel2DGSSkinAdapter(actorId, pbr);
        // pbr-standard / pbr-melanin / pbr-video-projected share the skinned PBR surface mesh.
        return pbr;
    }

    /**
     * Evaluates a frame of animation using the requested skin modality.
     */
    public async evaluateActorFrame(
        actorId: string,
        frameIndex: number,
        modality: HumanoidSkinModality = 'pbr-standard'
    ): Promise<PosedSkinFrameResult> {
        const adapter = await this.getSkinAdapter(actorId, modality);
        return adapter.evaluateFrame(frameIndex) as Promise<PosedSkinFrameResult>;
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
