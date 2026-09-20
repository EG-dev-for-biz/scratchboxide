/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import { GaussianSplat4DService } from '../src/node/3d-engine/gaussian-splat-4d-service';
import type { BakedGaussian } from '../src/common/geospatial-4d-protocol';
import type { VideoFrameData } from '../src/common/tracking/tapir-tracking-protocol';
import { tapir4dgsHandlers } from '../src/node/gemini/tools/spatial-tools';

function createDummyGaussian(
    x: number,
    y: number,
    z: number,
    r: number = 0.8,
    g: number = 0.2,
    b: number = 0.1
): BakedGaussian {
    return {
        position: [x, y, z],
        colorRgb: [r, g, b],
        scale: [0.05, 0.05, 0.05],
        opacity: 0.9,
        quaternion: [0, 0, 0, 1]
    };
}

function createDummyFrames(numFrames: number = 4, width: number = 64, height: number = 48): VideoFrameData[] {
    const frames: VideoFrameData[] = [];
    for (let t = 0; t < numFrames; t++) {
        const data = new Uint8Array(width * height * 3);
        for (let i = 0; i < data.length; i += 3) {
            data[i] = 200;
            data[i + 1] = 50;
            data[i + 2] = 25;
        }
        frames.push({ width, height, data, channels: 3, frameIndex: t });
    }
    return frames;
}

describe('GaussianSplat4DService (Intrinsics, Projection & Color Sampling)', () => {
    it('resolves focal length from horizontal/vertical FOV', () => {
        const intrinsics = GaussianSplat4DService.resolveIntrinsics({
            width: 640,
            height: 480,
            fovDegrees: 60.0
        });

        expect(intrinsics.cx).toBeCloseTo(319.5, 1);
        expect(intrinsics.cy).toBeCloseTo(239.5, 1);
        // f = (0.5 * 480) / tan(30 deg) = 240 / 0.57735 = 415.69
        expect(intrinsics.fx).toBeCloseTo(415.69, 1);
        expect(intrinsics.fy).toBeCloseTo(415.69, 1);
    });

    it('projects 3D camera coordinates to normalized 2D screen coordinates', () => {
        const intrinsics = { fx: 400, fy: 400, cx: 320, cy: 240 };
        // Center point at z = 2.0
        const pNorm = GaussianSplat4DService.project3DToNormalized2D([0, 0, 2.0], intrinsics, 640, 480);
        expect(pNorm[0]).toBeCloseTo(320 / 639, 2);
        expect(pNorm[1]).toBeCloseTo(240 / 479, 2);
    });

    it('samples sub-pixel color using bilinear interpolation', () => {
        const frame: VideoFrameData = {
            width: 2,
            height: 2,
            data: new Uint8Array([
                255, 0, 0,    0, 255, 0,
                0, 0, 255,    255, 255, 255
            ]),
            channels: 3
        };

        // Sample top-left exactly
        const c00 = GaussianSplat4DService.sampleBilinearColor(frame, 0.0, 0.0);
        expect(c00[0]).toBeCloseTo(1.0, 2);
        expect(c00[1]).toBeCloseTo(0.0, 2);

        // Sample center (0.5, 0.5)
        const cMid = GaussianSplat4DService.sampleBilinearColor(frame, 0.5, 0.5);
        // Average of the 4 pixels
        expect(cMid[0]).toBeCloseTo((1.0 + 0.0 + 0.0 + 1.0) / 4.0, 2);
    });
});

describe('GaussianSplat4DService.build4DSceneFromCanonical', () => {
    it('preserves strict canonical "frame of truth" invariant with zero hero delta', async () => {
        const subject: BakedGaussian[] = [
            createDummyGaussian(-0.2, 0.1, 2.0),
            createDummyGaussian(0.2, 0.1, 2.0),
            createDummyGaussian(0.0, -0.2, 2.0)
        ];
        const frames = createDummyFrames(5, 64, 48);

        const service = new GaussianSplat4DService();
        const heroFrameIndex = 2;

        const scene = await service.build4DSceneFromCanonical({
            canonicalSubject: subject,
            videoFrames: frames,
            heroFrameIndex,
            trackingConfig: { backend: 'mock' }
        });

        expect(scene.numFrames).toBe(5);
        expect(scene.heroFrameIndex).toBe(2);
        expect(scene.trajectories.length).toBe(3);

        // Verify Hero Frame Invariant: timeDelta is EXACTLY [0, 0, 0]
        for (const traj of scene.trajectories) {
            const heroDelta = traj.timeDeltas[heroFrameIndex];
            expect(heroDelta[0]).toBe(0);
            expect(heroDelta[1]).toBe(0);
            expect(heroDelta[2]).toBe(0);
        }
    });

    it('enforces ARAP local rigidity regularization and generates velocity tangents', async () => {
        const subject: BakedGaussian[] = [
            createDummyGaussian(0.0, 0.0, 2.0),
            createDummyGaussian(0.1, 0.0, 2.0),
            createDummyGaussian(0.0, 0.1, 2.0),
            createDummyGaussian(0.1, 0.1, 2.0)
        ];
        const frames = createDummyFrames(4, 64, 48);

        const service = new GaussianSplat4DService();
        const scene = await service.build4DSceneFromCanonical({
            canonicalSubject: subject,
            videoFrames: frames,
            useLocalRigidity: true,
            kNeighbors: 3,
            trackingConfig: { backend: 'mock' }
        });

        expect(scene.trajectories.length).toBe(4);
        for (const traj of scene.trajectories) {
            expect(traj.velocityTangents.length).toBe(4);
            expect(traj.quaternions.length).toBe(4);
            // Tangent velocity should be non-null 3D vectors
            expect(traj.velocityTangents[0].length).toBe(3);
        }

        expect(scene.telemetry.numDynamicGaussians).toBe(4);
        expect(scene.telemetry.trackerUsed).toBe('mock');
    });

    it('evaluates photometric error against canonical base color', async () => {
        // Create Gaussian with color [0.8, 0.2, 0.1] (matches dummy frame [200, 50, 25] ~ [0.78, 0.2, 0.1])
        const subject: BakedGaussian[] = [
            createDummyGaussian(0.0, 0.0, 2.0, 0.78, 0.2, 0.1)
        ];
        const frames = createDummyFrames(3, 64, 48);

        const service = new GaussianSplat4DService();
        const scene = await service.build4DSceneFromCanonical({
            canonicalSubject: subject,
            videoFrames: frames,
            trackingErrorThresh: 0.1,
            trackingConfig: { backend: 'mock' }
        });

        // Photometric error should be small since frame color matches gaussian color
        expect(scene.telemetry.meanPhotometricError).toBeLessThan(0.1);
    });
});

describe('Gemini Agent Tool: build_4dgs_from_video', () => {
    it('executes 4DGS deformation tool handler and returns decomposed scene telemetry', async () => {
        const subject: BakedGaussian[] = [
            createDummyGaussian(0.0, 0.0, 2.0)
        ];

        const res = await tapir4dgsHandlers.build_4dgs_from_video({
            canonicalSubject: subject,
            numFrames: 4,
            heroFrameIndex: 0,
            trackingBackend: 'mock',
            useLocalRigidity: true
        });

        expect(res.summaryResult).toContain('Built 4DGS scene: 1 dynamic subject Gaussians deformed across 4 frames');
        expect(res.summaryResult).toContain('hero frame 0 timeDelta=[0,0,0]');
        expect((res.resultPayload as any).telemetry.numDynamicGaussians).toBe(1);
    });
});
