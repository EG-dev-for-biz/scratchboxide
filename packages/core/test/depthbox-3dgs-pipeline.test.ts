import { describe, it, expect } from 'vitest';
import { SplatService } from '../src/node/3d-engine/splat-service';
import { DepthBoxInferenceService } from '../src/node/3d-engine/depthbox-inference-service';

describe('DepthBox 3DGS Pipeline: Depth-Ray to 3D Gaussian Splats', () => {
    it('synthesizes oriented Gaussian splats from depth-ray field', () => {
        const width = 32;
        const height = 32;
        const totalPixels = width * height;

        // Generate synthetic RGB pixels
        const rgbPixels = new Uint8Array(totalPixels * 3);
        for (let i = 0; i < totalPixels; i++) {
            rgbPixels[i * 3 + 0] = 180; // R
            rgbPixels[i * 3 + 1] = 140; // G
            rgbPixels[i * 3 + 2] = 220; // B
        }

        // Generate pinhole ray field
        const service = new DepthBoxInferenceService();
        const rayMap = service.computePinholeRayField(width, height, 60.0);
        expect(rayMap.length).toBe(totalPixels * 3);

        // Generate synthetic metric depths (planar wall at 15m with gradient)
        const metricDepths = new Float32Array(totalPixels);
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                metricDepths[y * width + x] = 12.0 + (y / height) * 6.0;
            }
        }

        const splats = SplatService.generateSplatsFromDepthRayField({
            width,
            height,
            rgbPixels,
            channels: 3,
            metricDepths,
            rayMap,
            stride: 2,
            edgeSeveranceTau: 0.1
        });

        expect(splats.length).toBeGreaterThan(0);
        expect(splats.length).toBe((width / 2) * (height / 2));

        const sample = splats[0];
        // 1. Verify 3D position
        expect(sample.position.length).toBe(3);
        expect(Number.isFinite(sample.position[0])).toBe(true);
        expect(Number.isFinite(sample.position[1])).toBe(true);
        expect(Number.isFinite(sample.position[2])).toBe(true);

        // 2. Verify anisotropic scale (surfel disk: sz <= sx and sz <= sy)
        expect(sample.scale[0]).toBeGreaterThan(0);
        expect(sample.scale[1]).toBeGreaterThan(0);
        expect(sample.scale[2]).toBeGreaterThan(0);
        expect(sample.scale[2]).toBeLessThanOrEqual(sample.scale[0]);
        expect(sample.scale[2]).toBeLessThanOrEqual(sample.scale[1]);

        // 3. Verify quaternion is normalized unit quaternion
        expect(sample.quaternion).toBeDefined();
        if (sample.quaternion) {
            const [qx, qy, qz, qw] = sample.quaternion;
            const norm = Math.hypot(qx, qy, qz, qw);
            expect(norm).toBeCloseTo(1.0, 3);
        }

        // 4. Verify RGB color fidelity
        expect(sample.colorRgb[0]).toBe(180);
        expect(sample.colorRgb[1]).toBe(140);
        expect(sample.colorRgb[2]).toBe(220);
        expect(sample.opacity).toBeGreaterThan(0.5);
    });

    it('round-trips binary .splat encoding and decoding', () => {
        const dummySplats = [
            {
                position: [12.5, -4.2, 38.0] as [number, number, number],
                scale: [0.45, 0.55, 0.08] as [number, number, number],
                colorRgb: [255, 128, 64] as [number, number, number],
                opacity: 0.95,
                quaternion: [0, 0, 0, 1] as [number, number, number, number]
            },
            {
                position: [-8.1, 15.3, 22.4] as [number, number, number],
                scale: [0.32, 0.38, 0.05] as [number, number, number],
                colorRgb: [50, 200, 250] as [number, number, number],
                opacity: 0.88,
                quaternion: [0, 0.7071, 0, 0.7071] as [number, number, number, number]
            }
        ];

        const splatBuffer = SplatService.serializeSplatBuffer(dummySplats);
        expect(splatBuffer.length).toBe(dummySplats.length * 32);

        const decoded = SplatService.parseSplatBuffer(splatBuffer);
        expect(decoded.length).toBe(2);

        expect(decoded[0].position[0]).toBeCloseTo(12.5, 2);
        expect(decoded[0].position[1]).toBeCloseTo(-4.2, 2);
        expect(decoded[0].position[2]).toBeCloseTo(38.0, 2);

        expect(decoded[0].scale[0]).toBeCloseTo(0.45, 2);
        expect(decoded[0].scale[1]).toBeCloseTo(0.55, 2);
        expect(decoded[0].scale[2]).toBeCloseTo(0.08, 2);

        expect(decoded[0].colorRgb[0]).toBe(255);
        expect(decoded[0].colorRgb[1]).toBe(128);
        expect(decoded[0].colorRgb[2]).toBe(64);
        expect(decoded[0].opacity).toBeCloseTo(0.95, 1);
    });
});
