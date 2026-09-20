import { describe, it, expect } from 'vitest';
import {
    ImageToSplatService,
    SplatService,
    VideoKeyframeInput
} from '../src/node';

describe('Image, Group, and Video to 3D Gaussian Splat Environment Pipeline', () => {
    it('returns a comprehensive public sources catalog with images, groups, and videos', () => {
        const catalog = ImageToSplatService.getPublicSourceCatalog();
        expect(catalog.singleImages.length).toBeGreaterThanOrEqual(4);
        expect(catalog.imageGroups.length).toBeGreaterThanOrEqual(3);
        expect(catalog.videos.length).toBeGreaterThanOrEqual(3);

        const alpineGroup = catalog.imageGroups.find(g => g.id === 'alpine_orbit_group');
        expect(alpineGroup).toBeDefined();
        expect(alpineGroup?.paths?.length).toBe(6);

        const droneVideo = catalog.videos.find(v => v.id === 'drone_survey_video');
        expect(droneVideo).toBeDefined();
        expect(droneVideo?.path).toContain('interaction_input_video.mp4');
    });

    it('converts a single 2D image into oriented 3D Gaussian splats', () => {
        const W = 32;
        const H = 32;
        const rgb = new Uint8Array(W * H * 3);
        const depths = new Float32Array(W * H);

        for (let y = 0; y < H; ++y) {
            for (let x = 0; x < W; ++x) {
                const idx = y * W + x;
                rgb[idx * 3 + 0] = Math.round((x / W) * 255);
                rgb[idx * 3 + 1] = 120;
                rgb[idx * 3 + 2] = Math.round((y / H) * 255);
                depths[idx] = 5.0 + (y / H) * 15.0; // Gradient from 5m to 20m
            }
        }

        const splats = ImageToSplatService.convertSingleImageToSplat({
            rgbPixels: rgb,
            width: W,
            height: H,
            channels: 3,
            metricDepths: depths,
            stride: 1,
            edgeTau: 0.08
        });

        expect(splats.length).toBe(W * H);
        expect(splats[0].position[2]).toBeLessThan(0); // Camera looks down -Z in camera space
        expect(splats[0].opacity).toBeGreaterThan(0.5);
        expect(splats[0].scale[0]).toBeGreaterThan(0);
    });

    it('fuses a group of related multi-view images with voxel grid decimation', () => {
        const W = 20;
        const H = 20;
        const rgbA = new Uint8Array(W * H * 3).fill(160);
        const rgbB = new Uint8Array(W * H * 3).fill(190);
        const rgbC = new Uint8Array(W * H * 3).fill(220);
        const depths = new Float32Array(W * H).fill(8.0);

        const views = [
            {
                rgbPixels: rgbA,
                width: W,
                height: H,
                metricDepths: depths,
                pose: { position: [-0.5, 1.7, 0] as [number, number, number] }
            },
            {
                rgbPixels: rgbB,
                width: W,
                height: H,
                metricDepths: depths,
                pose: { position: [0.0, 1.7, 0] as [number, number, number] }
            },
            {
                rgbPixels: rgbC,
                width: W,
                height: H,
                metricDepths: depths,
                pose: { position: [0.5, 1.7, 0] as [number, number, number] }
            }
        ];

        const fusedSplats = ImageToSplatService.convertMultiViewImagesToSplat({
            views,
            voxelSize: 0.15
        });

        // 3 views without voxel decimation would be 3 * 400 = 1200 splats.
        // With voxel decimation, overlapping spatial points should be merged.
        expect(fusedSplats.length).toBeLessThan(W * H * 3);
        expect(fusedSplats.length).toBeGreaterThan(50);
    });

    it('converts a video keyframe group with orbit turntable trajectory into a 3DGS environment', () => {
        const W = 16;
        const H = 16;
        const numFrames = 5;
        const keyframes: VideoKeyframeInput[] = [];

        for (let f = 0; f < numFrames; ++f) {
            const rgb = new Uint8Array(W * H * 3);
            const depths = new Float32Array(W * H);
            for (let i = 0; i < W * H; ++i) {
                rgb[i * 3 + 0] = 50 + f * 30;
                rgb[i * 3 + 1] = 100;
                rgb[i * 3 + 2] = 200 - f * 20;
                depths[i] = 10.0;
            }
            keyframes.push({
                frameIndex: f,
                timestampSeconds: f * 0.5,
                rgbPixels: rgb,
                width: W,
                height: H,
                channels: 3,
                metricDepths: depths
            });
        }

        const splats = ImageToSplatService.convertVideoKeyframesToSplat({
            keyframes,
            trajectoryType: 'orbit',
            orbitRadius: 10.0,
            orbitSweepDegrees: 60.0,
            voxelSize: 1.5
        });

        expect(splats.length).toBeGreaterThan(0);
        // All keyframes fused
        expect(splats.length).toBeLessThan(W * H * numFrames);

        // Check that splats span a 3D volume around world origin
        let minX = Infinity, maxX = -Infinity;
        let minZ = Infinity, maxZ = -Infinity;
        for (const s of splats) {
            minX = Math.min(minX, s.position[0]);
            maxX = Math.max(maxX, s.position[0]);
            minZ = Math.min(minZ, s.position[2]);
            maxZ = Math.max(maxZ, s.position[2]);
        }
        expect(maxX - minX).toBeGreaterThan(1.0);
        expect(maxZ - minZ).toBeGreaterThan(1.0);
    });

    it('converts a video keyframe group with forward dolly trajectory into a 3DGS environment', () => {
        const W = 16;
        const H = 16;
        const numFrames = 4;
        const keyframes: VideoKeyframeInput[] = [];

        for (let f = 0; f < numFrames; ++f) {
            const rgb = new Uint8Array(W * H * 3).fill(128);
            const depths = new Float32Array(W * H).fill(12.0);
            keyframes.push({
                frameIndex: f,
                timestampSeconds: f * 1.0,
                rgbPixels: rgb,
                width: W,
                height: H,
                metricDepths: depths
            });
        }

        const splats = ImageToSplatService.convertVideoKeyframesToSplat({
            keyframes,
            trajectoryType: 'dolly',
            dollyDistance: 10.0,
            voxelSize: 2.0
        });

        expect(splats.length).toBeGreaterThan(0);
        expect(splats.length).toBeLessThan(W * H * numFrames);
    });

    it('serializes video 3DGS splats to binary .splat buffer with valid 32-byte layout', () => {
        const testSplats = [
            {
                position: [0.0, 1.7, -5.0] as [number, number, number],
                scale: [0.08, 0.08, 0.02] as [number, number, number],
                colorRgb: [0.9, 0.5, 0.2] as [number, number, number],
                opacity: 0.9,
                quaternion: [0, 0, 0, 1] as [number, number, number, number]
            }
        ];

        const buffer = ImageToSplatService.serializeToSplatBuffer(testSplats);
        expect(buffer.length).toBe(32);
        const parsed = SplatService.parseSplatBuffer(buffer);
        expect(parsed.length).toBe(1);
        expect(parsed[0].position[1]).toBeCloseTo(1.7, 3);
    });
});
