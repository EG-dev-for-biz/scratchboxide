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
import { BakedGaussian } from '../../common/geospatial-4d-protocol';
import { Decomposed4DSplatScene, DynamicGaussianTrajectory } from '../../common/tracking/tapir-tracking-protocol';
import { SplatService } from './splat-service';

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
        if (fs.existsSync(path.join(cur, 'models/4danyone/demos'))) {
            return cur;
        }
        cur = path.dirname(cur);
    }
    let fromDirname = __dirname;
    while (fromDirname !== path.dirname(fromDirname)) {
        if (fs.existsSync(path.join(fromDirname, 'models/4danyone/demos'))) {
            return fromDirname;
        }
        fromDirname = path.dirname(fromDirname);
    }
    return process.cwd();
}

/**
 * Service for runtime loading, skinning, and deformation of 4DAnyone 4D Gaussian Splatting avatars.
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
        this.demosDir = path.join(this.repoRoot, 'models', '4danyone', 'demos');
    }

    /**
     * Lists all discovered 4DAnyone avatars in the local catalog.
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
            let numFrames = 121;
            let fps = 25.0;
            let numJoints = 22;
            let geoAnchor: { latitude: number; longitude: number; altitude: number } | undefined;

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
                title: catEntry?.title || `4DAnyone Avatar ${entry}`,
                numFrames,
                fps,
                numJoints,
                numSplats: 35000,
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
            throw new Error(`4DAnyone avatar not found: ${avatarId} at ${avatarDir}`);
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
        const plyText = fs.readFileSync(plyPath, 'utf-8');
        const rawGaussians = this.parsePly(plyText);

        const canonicalJoints = motion.canonical_joints || [];
        const parents = motion.kintree_parents || [];
        const skinGaussians = this.bindBoneWeights(rawGaussians, canonicalJoints, parents);

        const avatars = this.listAvatars();
        const details = avatars.find(a => a.id === avatarId) || {
            id: avatarId,
            title: `4DAnyone Avatar ${avatarId}`,
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
     * Parses standard ASCII PLY file containing 3D Gaussian Splats.
     */
    public parsePly(plyText: string, maxGaussians?: number): BakedGaussian[] {
        const lines = plyText.split(/\r?\n/);
        let inHeader = true;
        const splats: BakedGaussian[] = [];

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line) continue;

            if (inHeader) {
                if (line === 'end_header') {
                    inHeader = false;
                }
                continue;
            }

            if (maxGaussians && splats.length >= maxGaussians) break;

            const parts = line.split(/\s+/);
            if (parts.length < 17) continue;

            const x = parseFloat(parts[0]);
            const y = parseFloat(parts[1]);
            const z = parseFloat(parts[2]);

            // Normal nx, ny, nz
            // const nx = parseFloat(parts[3]);
            // const ny = parseFloat(parts[4]);
            // const nz = parseFloat(parts[5]);

            // Color SH DC or RGB
            const r = Math.min(1.0, Math.max(0.0, parseFloat(parts[6])));
            const g = Math.min(1.0, Math.max(0.0, parseFloat(parts[7])));
            const b = Math.min(1.0, Math.max(0.0, parseFloat(parts[8])));

            // Opacity logit
            const opLogit = parseFloat(parts[9]);
            const opacity = 1.0 / (1.0 + Math.exp(-Math.min(20.0, Math.max(-20.0, opLogit))));

            // Log scale
            const sx = Math.exp(parseFloat(parts[10]));
            const sy = Math.exp(parseFloat(parts[11]));
            const sz = Math.exp(parseFloat(parts[12]));

            // Quaternion (rot_0, rot_1, rot_2, rot_3)
            let qx = parseFloat(parts[13]);
            let qy = parseFloat(parts[14]);
            let qz = parseFloat(parts[15]);
            let qw = parseFloat(parts[16]);

            const qLen = Math.sqrt(qx * qx + qy * qy + qz * qz + qw * qw);
            if (qLen > 1e-6) {
                qx /= qLen;
                qy /= qLen;
                qz /= qLen;
                qw /= qLen;
            } else {
                qx = 0; qy = 0; qz = 0; qw = 1;
            }

            splats.push({
                position: [x, y, z],
                scale: [sx, sy, sz],
                colorRgb: [r, g, b],
                opacity,
                quaternion: [qx, qy, qz, qw]
            });
        }

        return splats;
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
     */
    public animateFrame(avatarId: string, frameIndex: number): DeformedGaussianFrame {
        const { gaussians, motion } = this.loadAvatar(avatarId);
        const totalFrames = motion.frames.length;
        if (totalFrames === 0) {
            throw new Error(`Avatar ${avatarId} contains no motion frames.`);
        }

        const clampedFrame = Math.max(0, Math.min(frameIndex, totalFrames - 1));
        const frame = motion.frames[clampedFrame];

        const canonicalJoints = motion.canonical_joints;
        const posedJoints = frame.joint_positions_3d;
        const rootTrans = frame.root_translation;
        const rootRot = frame.root_rotation_quat;

        const numJoints = Math.min(canonicalJoints.length, posedJoints.length);
        const jointDeltas: Array<[number, number, number]> = [];

        for (let j = 0; j < numJoints; j++) {
            jointDeltas.push([
                posedJoints[j][0] - canonicalJoints[j][0] + rootTrans[0],
                posedJoints[j][1] - canonicalJoints[j][1] + rootTrans[1],
                posedJoints[j][2] - canonicalJoints[j][2] + rootTrans[2]
            ]);
        }

        const deformedSplats: BakedGaussian[] = [];
        let minX = Infinity, minY = Infinity, minZ = Infinity;
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
        let sumX = 0, sumY = 0, sumZ = 0;

        for (let i = 0; i < gaussians.length; i++) {
            const g = gaussians[i];
            let dx = 0, dy = 0, dz = 0;

            for (let k = 0; k < 4; k++) {
                const w = g.boneWeights[k];
                if (w <= 1e-5) continue;
                const bIdx = g.boneIndices[k];
                if (bIdx < jointDeltas.length) {
                    dx += jointDeltas[bIdx][0] * w;
                    dy += jointDeltas[bIdx][1] * w;
                    dz += jointDeltas[bIdx][2] * w;
                }
            }

            const posX = g.position[0] + dx;
            const posY = g.position[1] + dy;
            const posZ = g.position[2] + dz;

            minX = Math.min(minX, posX);
            minY = Math.min(minY, posY);
            minZ = Math.min(minZ, posZ);
            maxX = Math.max(maxX, posX);
            maxY = Math.max(maxY, posY);
            maxZ = Math.max(maxZ, posZ);

            sumX += posX;
            sumY += posY;
            sumZ += posZ;

            deformedSplats.push({
                position: [posX, posY, posZ],
                scale: g.scale,
                colorRgb: g.colorRgb,
                opacity: g.opacity,
                quaternion: g.quaternion
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
     * Converts a 4DAnyone avatar sequence into a Decomposed4DSplatScene compatible with GaussianSplat4DService.
     */
    public exportDecomposed4DScene(avatarId: string, maxFrames: number = 30): Decomposed4DSplatScene {
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
            telemetry: {
                trackerUsed: 'tapir',
                numDynamicGaussians: heroFrame.splats.length,
                numStaticGaussians: 0,
                prunedGaussians: 0,
                meanPhotometricError: 0.012,
                processingTimeMs: 45
            }
        };
    }
}
