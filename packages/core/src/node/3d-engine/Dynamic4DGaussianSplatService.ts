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
import { BakedGaussian } from '../../common/geospatial-4d-protocol';
import { Decomposed4DSplatScene, DynamicGaussianTrajectory } from '../../common/tracking/tapir-tracking-protocol';
import { SplatService } from './splat-service';
import { decodeGaussianPly } from '../../common/gaussian-ply-codec';
import { Vec3, computeBoneRotations, mat3ToQuat, quatMultiply, skinPoint } from '../../common/humanoid-skinning';

export interface HumanoidMotionFrame {
    frame_index: number;
    timestamp: number;
    root_translation: [number, number, number];
    root_rotation_quat: [number, number, number, number]; // [x, y, z, w]
    joint_positions_3d: Array<[number, number, number]>;
    joint_rotations_quat?: Array<[number, number, number, number]>;
    confidence?: number;
}

export interface HumanoidMotionData {
    clip_id?: string;
    body_model?: string;
    fps: number;
    num_frames: number;
    num_joints: number;
    joints_name: string[];
    kintree_parents: number[];
    canonical_joints: Array<[number, number, number]>;
    frames: HumanoidMotionFrame[];
    /** 'mediapipe_pose_track' for video-tracked motion, 'synthetic_idle' for the procedural sway fallback. */
    motion_source?: string;
    source_video?: string;
    /** Rotation from the tracking camera's frame to the gravity-aligned avatar world (row-major 3x3). */
    camera_to_world?: [[number, number, number], [number, number, number], [number, number, number]];
}

export interface SkinWeightedGaussian extends BakedGaussian {
    boneIndices: [number, number, number, number];
    boneWeights: [number, number, number, number];
    normal?: [number, number, number];
}

export interface DeformedGaussianFrame {
    avatarId: string;
    frameIndex: number;
    timestamp: number;
    numSplats: number;
    splats: BakedGaussian[];
    bounds: {
        min: [number, number, number];
        max: [number, number, number];
    };
    centroid: [number, number, number];
    rootTranslation: [number, number, number];
    rootRotation: [number, number, number, number];
}

export interface Avatar4DGSDetails {
    id: string;
    title: string;
    numFrames: number;
    fps: number;
    numJoints: number;
    numSplats: number;
    hasMotion: boolean;
    hasCameras: boolean;
    hasGeoManifest: boolean;
    plyPath: string;
    motionPath?: string;
    camerasPath?: string;
    geoManifestPath?: string;
    canonicalFramePath?: string;
    geoAnchor?: {
        latitude: number;
        longitude: number;
        altitude: number;
    };
}

function findRepoRoot(startDir: string = process.cwd()): string {
    let cur = startDir;
    while (cur !== path.dirname(cur)) {
        if (fs.existsSync(path.join(cur, 'models/performer_4dgs/demos'))) {
            return cur;
        }
        cur = path.dirname(cur);
    }
    let fromDirname = __dirname;
    while (fromDirname !== path.dirname(fromDirname)) {
        if (fs.existsSync(path.join(fromDirname, 'models/performer_4dgs/demos'))) {
            return fromDirname;
        }
        fromDirname = path.dirname(fromDirname);
    }
    return process.cwd();
}

/**
 * Service for runtime loading, skinning, and deformation of Performer 4D Gaussian Splatting avatars.
 */
export class Dynamic4DGaussianSplatService {
    private repoRoot: string;
    private demosDir: string;
    private avatarCache = new Map<string, {
        gaussians: SkinWeightedGaussian[];
        motion: HumanoidMotionData;
        details: Avatar4DGSDetails;
    }>();

    constructor(customRepoRoot?: string) {
        this.repoRoot = customRepoRoot || findRepoRoot();
        this.demosDir = path.join(this.repoRoot, 'models', 'performer_4dgs', 'demos');
    }

    /**
     * Lists all discovered Performer avatars in the local catalog.
     */
    public listAvatars(): Avatar4DGSDetails[] {
        const results: Avatar4DGSDetails[] = [];
        if (!fs.existsSync(this.demosDir)) return results;

        const catalogPath = path.join(this.demosDir, 'demos_catalog.json');
        let catalogList: any[] = [];
        if (fs.existsSync(catalogPath)) {
            try {
                const parsed = JSON.parse(fs.readFileSync(catalogPath, 'utf-8'));
                catalogList = parsed.demos || [];
            } catch {
                // Ignore parse errors
            }
        }

        const entries = fs.readdirSync(this.demosDir);
        for (const entry of entries) {
            const subDir = path.join(this.demosDir, entry);
            if (!fs.statSync(subDir).isDirectory()) continue;

            const plyPath = path.join(subDir, 'human_4dgs.ply');
            if (!fs.existsSync(plyPath)) continue;

            const motionPath = path.join(subDir, 'motion.json');
            const camerasPath = path.join(subDir, 'cameras.json');
            const geoPath = path.join(subDir, 'geo_manifest.json');
            const framePath = path.join(subDir, 'canonical_frame.jpg');

            const catEntry = catalogList.find((d: any) => d.id === entry);
            let numFrames = 0;
            let fps = 25.0;
            let numJoints = 22;
            let geoAnchor: { latitude: number; longitude: number; altitude: number } | undefined;

            if (fs.existsSync(motionPath)) {
                try {
                    const m = JSON.parse(fs.readFileSync(motionPath, 'utf-8'));
                    numFrames = Array.isArray(m.frames) ? m.frames.length : (m.num_frames || 0);
                    fps = m.fps || fps;
                    numJoints = m.num_joints || numJoints;
                } catch {
                    // Leave defaults for unreadable motion
                }
            }

            if (fs.existsSync(geoPath)) {
                try {
                    const geo = JSON.parse(fs.readFileSync(geoPath, 'utf-8'));
                    if (geo.geographic_anchor) {
                        geoAnchor = {
                            latitude: geo.geographic_anchor.latitude,
                            longitude: geo.geographic_anchor.longitude,
                            altitude: geo.geographic_anchor.altitude
                        };
                    }
                } catch {
                    // Ignore geo parse errors
                }
            }

            results.push({
                id: entry,
                title: catEntry?.title || `Performer Avatar ${entry}`,
                numFrames,
                fps,
                numJoints,
                numSplats: this.readPlyVertexCount(plyPath),
                hasMotion: fs.existsSync(motionPath),
                hasCameras: fs.existsSync(camerasPath),
                hasGeoManifest: fs.existsSync(geoPath),
                plyPath,
                motionPath: fs.existsSync(motionPath) ? motionPath : undefined,
                camerasPath: fs.existsSync(camerasPath) ? camerasPath : undefined,
                geoManifestPath: fs.existsSync(geoPath) ? geoPath : undefined,
                canonicalFramePath: fs.existsSync(framePath) ? framePath : undefined,
                geoAnchor
            });
        }

        return results;
    }

    /**
     * Loads avatar metadata and assets, caching canonical Gaussians and motion tracks.
     */
    public loadAvatar(avatarId: string): {
        gaussians: SkinWeightedGaussian[];
        motion: HumanoidMotionData;
        details: Avatar4DGSDetails;
    } {
        const cached = this.avatarCache.get(avatarId);
        if (cached) return cached;

        const avatarDir = path.join(this.demosDir, avatarId);
        if (!fs.existsSync(avatarDir)) {
            throw new Error(`Performer avatar not found: ${avatarId} at ${avatarDir}`);
        }

        const plyPath = path.join(avatarDir, 'human_4dgs.ply');
        const motionPath = path.join(avatarDir, 'motion.json');

        if (!fs.existsSync(plyPath)) {
            throw new Error(`Avatar PLY missing: ${plyPath}`);
        }
        if (!fs.existsSync(motionPath)) {
            throw new Error(`Avatar motion.json missing: ${motionPath}`);
        }

        const motion: HumanoidMotionData = JSON.parse(fs.readFileSync(motionPath, 'utf-8'));
        const { gaussians: decoded } = decodeGaussianPly(fs.readFileSync(plyPath, 'utf-8'));

        const canonicalJoints = motion.canonical_joints || [];
        const parents = motion.kintree_parents || [];
        const hasExactWeights = decoded.length > 0 && decoded.every(g => g.boneIndices && g.boneWeights);
        const skinGaussians: SkinWeightedGaussian[] = hasExactWeights
            ? decoded.map(g => ({
                position: g.position,
                scale: g.scale,
                colorRgb: g.colorRgb,
                opacity: g.opacity,
                quaternion: g.quaternion,
                normal: g.normal,
                boneIndices: g.boneIndices!,
                boneWeights: g.boneWeights!
            }))
            : this.bindBoneWeights(decoded, canonicalJoints, parents);

        const avatars = this.listAvatars();
        const details = avatars.find(a => a.id === avatarId) || {
            id: avatarId,
            title: `Performer Avatar ${avatarId}`,
            numFrames: motion.num_frames,
            fps: motion.fps,
            numJoints: motion.num_joints,
            numSplats: skinGaussians.length,
            hasMotion: true,
            hasCameras: fs.existsSync(path.join(avatarDir, 'cameras.json')),
            hasGeoManifest: fs.existsSync(path.join(avatarDir, 'geo_manifest.json')),
            plyPath,
            motionPath
        };

        const entry = { gaussians: skinGaussians, motion, details };
        this.avatarCache.set(avatarId, entry);
        return entry;
    }

    /**
     * Parses an ASCII 3DGS PLY (SH or legacy RGB colour, either quaternion order) into Gaussians.
     */
    public parsePly(plyText: string, maxGaussians?: number): BakedGaussian[] {
        return decodeGaussianPly(plyText, { maxGaussians }).gaussians.map(g => ({
            position: g.position,
            scale: g.scale,
            colorRgb: g.colorRgb,
            opacity: g.opacity,
            quaternion: g.quaternion
        }));
    }

    private readPlyVertexCount(plyPath: string): number {
        try {
            const fd = fs.openSync(plyPath, 'r');
            const buf = Buffer.alloc(2048);
            fs.readSync(fd, buf, 0, buf.length, 0);
            fs.closeSync(fd);
            const m = /element vertex (\d+)/.exec(buf.toString('latin1'));
            return m ? parseInt(m[1], 10) : 0;
        } catch {
            return 0;
        }
    }

    /**
     * Computes 4-bone influence skinning weights for each Gaussian.
     */
    public bindBoneWeights(
        gaussians: BakedGaussian[],
        canonicalJoints: Array<[number, number, number]>,
        parents: number[],
        radiusFalloff: number = 0.22
    ): SkinWeightedGaussian[] {
        const numJoints = canonicalJoints.length;
        const invTwoSigmaSq = 1.0 / (2.0 * radiusFalloff * radiusFalloff);

        return gaussians.map(g => {
            const dists: Array<{ index: number; dist: number; weight: number }> = [];

            for (let j = 0; j < numJoints; j++) {
                const pIdx = parents[j] !== undefined ? parents[j] : -1;
                let dist: number;

                if (pIdx >= 0 && pIdx < numJoints) {
                    dist = this.distanceToSegment(g.position, canonicalJoints[pIdx], canonicalJoints[j]);
                } else {
                    const c = canonicalJoints[j];
                    const dx = g.position[0] - c[0];
                    const dy = g.position[1] - c[1];
                    const dz = g.position[2] - c[2];
                    dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
                }

                dists.push({
                    index: j,
                    dist,
                    weight: Math.exp(-dist * dist * invTwoSigmaSq)
                });
            }

            // Top 4 nearest joints
            dists.sort((a, b) => a.dist - b.dist);
            const top4 = dists.slice(0, 4);
            const sumWeight = top4.reduce((acc, val) => acc + val.weight, 0);

            const boneIndices: [number, number, number, number] = [
                top4[0].index, top4[1].index, top4[2].index, top4[3].index
            ];
            const boneWeights: [number, number, number, number] = sumWeight > 1e-6 ? [
                top4[0].weight / sumWeight,
                top4[1].weight / sumWeight,
                top4[2].weight / sumWeight,
                top4[3].weight / sumWeight
            ] : [1.0, 0, 0, 0];

            return {
                ...g,
                boneIndices,
                boneWeights
            };
        });
    }

    private distanceToSegment(
        p: [number, number, number],
        a: [number, number, number],
        b: [number, number, number]
    ): number {
        const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        const lenSq = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2];
        if (lenSq < 1e-8) {
            const dx = p[0] - a[0], dy = p[1] - a[1], dz = p[2] - a[2];
            return Math.sqrt(dx * dx + dy * dy + dz * dz);
        }

        const ap = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
        const t = Math.max(0.0, Math.min(1.0, (ap[0] * ab[0] + ap[1] * ab[1] + ap[2] * ab[2]) / lenSq));
        const proj = [a[0] + ab[0] * t, a[1] + ab[1] * t, a[2] + ab[2] * t];
        const dx = p[0] - proj[0], dy = p[1] - proj[1], dz = p[2] - proj[2];
        return Math.sqrt(dx * dx + dy * dy + dz * dz);
    }

    /**
     * Evaluates deformed Gaussians for a specific frame index using skeletal Linear Blend Skinning (LBS).
     * Motion joint positions are absolute world coordinates; splat orientations follow their primary bone.
     */
    public animateFrame(avatarId: string, frameIndex: number): DeformedGaussianFrame {
        const { gaussians, motion } = this.loadAvatar(avatarId);
        const totalFrames = motion.frames.length;
        if (totalFrames === 0) {
            throw new Error(`Avatar ${avatarId} contains no motion frames.`);
        }

        const clampedFrame = Math.max(0, Math.min(frameIndex, totalFrames - 1));
        const frame = motion.frames[clampedFrame];

        const canonicalJoints = motion.canonical_joints as Vec3[];
        const posedJoints = frame.joint_positions_3d as Vec3[];
        const rootTrans = frame.root_translation || [0, 0, 0];
        const rootRot = frame.root_rotation_quat || [0, 0, 0, 1];

        const rotations = computeBoneRotations(canonicalJoints, posedJoints);
        const boneQuats = rotations.map(r => mat3ToQuat(r));

        const deformedSplats: BakedGaussian[] = [];
        let minX = Infinity, minY = Infinity, minZ = Infinity;
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
        let sumX = 0, sumY = 0, sumZ = 0;

        for (let i = 0; i < gaussians.length; i++) {
            const g = gaussians[i];
            const [posX, posY, posZ] = skinPoint(g.position, g.boneIndices, g.boneWeights, canonicalJoints, posedJoints, rotations);

            minX = Math.min(minX, posX);
            minY = Math.min(minY, posY);
            minZ = Math.min(minZ, posZ);
            maxX = Math.max(maxX, posX);
            maxY = Math.max(maxY, posY);
            maxZ = Math.max(maxZ, posZ);

            sumX += posX;
            sumY += posY;
            sumZ += posZ;

            const primary = g.boneIndices[0] < boneQuats.length ? g.boneIndices[0] : 0;
            deformedSplats.push({
                position: [posX, posY, posZ],
                scale: g.scale,
                colorRgb: g.colorRgb,
                opacity: g.opacity,
                quaternion: quatMultiply(boneQuats[primary], g.quaternion || [0, 0, 0, 1])
            });
        }

        const count = deformedSplats.length;
        const centroid: [number, number, number] = count > 0 ? [sumX / count, sumY / count, sumZ / count] : [0, 0, 0];

        return {
            avatarId,
            frameIndex: clampedFrame,
            timestamp: frame.timestamp,
            numSplats: count,
            splats: deformedSplats,
            bounds: {
                min: [minX, minY, minZ],
                max: [maxX, maxY, maxZ]
            },
            centroid,
            rootTranslation: rootTrans,
            rootRotation: rootRot
        };
    }

    /**
     * Exports standard 32-byte .splat binary buffer for a specific frame index.
     */
    public exportSplatBuffer(avatarId: string, frameIndex: number): Buffer {
        const frame = this.animateFrame(avatarId, frameIndex);
        return SplatService.serializeSplatBuffer(frame.splats);
    }

    /**
     * Converts a performer avatar sequence into a Decomposed4DSplatScene compatible with GaussianSplat4DService.
     */
    public exportDecomposed4DScene(avatarId: string, maxFrames: number = 30): Decomposed4DSplatScene {
        const startTime = Date.now();
        const { motion } = this.loadAvatar(avatarId);
        const T = Math.min(motion.frames.length, maxFrames);
        const trajectories: DynamicGaussianTrajectory[] = [];

        // Hero frame 0 provides the canonical posed subject for the 4DGS stream
        const heroFrame = this.animateFrame(avatarId, 0);

        // Build trajectories for all subject Gaussians
        for (let i = 0; i < heroFrame.splats.length; i++) {
            const g = heroFrame.splats[i];
            const timeDeltas: Array<[number, number, number]> = [];
            const timeColors: Array<[number, number, number]> = [];
            const visibilities: number[] = [];

            trajectories.push({
                pointIndex: i,
                canonicalPosition: g.position,
                canonicalColor: g.colorRgb,
                canonicalScale: g.scale,
                canonicalOpacity: g.opacity,
                timeDeltas,
                timeColors,
                visibilities
            });
        }

        let globalMin: [number, number, number] = [Infinity, Infinity, Infinity];
        let globalMax: [number, number, number] = [-Infinity, -Infinity, -Infinity];

        for (let t = 0; t < T; t++) {
            const frame = t === 0 ? heroFrame : this.animateFrame(avatarId, t);

            for (let i = 0; i < heroFrame.splats.length; i++) {
                const canon = heroFrame.splats[i].position;
                const posed = frame.splats[i].position;
                trajectories[i].timeDeltas.push([
                    posed[0] - canon[0],
                    posed[1] - canon[1],
                    posed[2] - canon[2]
                ]);
                trajectories[i].timeColors.push(frame.splats[i].colorRgb);
                trajectories[i].visibilities.push(1.0);
            }

            globalMin = [
                Math.min(globalMin[0], frame.bounds.min[0]),
                Math.min(globalMin[1], frame.bounds.min[1]),
                Math.min(globalMin[2], frame.bounds.min[2])
            ];
            globalMax = [
                Math.max(globalMax[0], frame.bounds.max[0]),
                Math.max(globalMax[1], frame.bounds.max[1]),
                Math.max(globalMax[2], frame.bounds.max[2])
            ];
        }

        return {
            staticLayer: [],
            canonicalSubject: heroFrame.splats.map(g => ({
                position: g.position,
                scale: g.scale,
                colorRgb: g.colorRgb,
                opacity: g.opacity,
                quaternion: g.quaternion
            })),
            trajectories,
            numFrames: T,
            heroFrameIndex: 0,
            frameTimestamps: motion.frames.slice(0, T).map(f => f.timestamp),
            bounds: {
                min: globalMin,
                max: globalMax
            },
            // The motion is the avatar's recorded skeletal track (LBS), not point tracking: no tracker ran and no
            // photometric error was measured.
            telemetry: {
                trackerUsed: 'none',
                numDynamicGaussians: heroFrame.splats.length,
                numStaticGaussians: 0,
                prunedGaussians: 0,
                meanPhotometricError: null,
                processingTimeMs: Date.now() - startTime
            }
        };
    }
}
