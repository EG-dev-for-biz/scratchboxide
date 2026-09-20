import { describe, it, expect } from 'vitest';
import { SplatService } from '../src/node/3d-engine/splat-service';

describe('DepthBox 3DGS 100% Photographic Quality Optics Engine', () => {
    describe('Thin-Lens Physical Depth of Field (Circle of Confusion)', () => {
        it('calculates zero circle of confusion at the exact focus distance', () => {
            const focalMm = 50.0;
            const aperture = 1.4;
            const focusDist = 15.0; // 15 meters
            const depth = 15.0;     // exactly on focal plane

            const coc = SplatService.computeThinLensCoC(depth, focusDist, focalMm, aperture);
            expect(coc).toBeCloseTo(0.0, 5);
        });

        it('produces larger circle of confusion for wider apertures (f/1.4 vs f/8.0)', () => {
            const focalMm = 85.0;
            const focusDist = 10.0;
            const depth = 4.0; // Foreground subject out of focus

            const cocWide = SplatService.computeThinLensCoC(depth, focusDist, focalMm, 1.4);
            const cocNarrow = SplatService.computeThinLensCoC(depth, focusDist, focalMm, 8.0);

            expect(cocWide).toBeGreaterThan(cocNarrow);
            expect(cocWide / cocNarrow).toBeCloseTo(8.0 / 1.4, 1);
        });

        it('produces stronger bokeh for longer telephoto lenses (135mm vs 24mm)', () => {
            const focusDist = 20.0;
            const depth = 60.0; // Background mountain out of focus
            const aperture = 2.8;

            const cocTele = SplatService.computeThinLensCoC(depth, focusDist, 135.0, aperture);
            const cocWide = SplatService.computeThinLensCoC(depth, focusDist, 24.0, aperture);

            expect(cocTele).toBeGreaterThan(cocWide * 5);
        });
    });

    describe('ACES Filmic Tone Mapping', () => {
        it('compresses overexposed HDR highlights smoothly within [0.0, 1.0] without hard clipping', () => {
            const superBright: [number, number, number] = [3.5, 2.8, 4.2];
            const mapped = SplatService.acesFilmicToneMap(superBright);

            expect(mapped[0]).toBeGreaterThan(0.9);
            expect(mapped[0]).toBeLessThanOrEqual(1.0);
            expect(mapped[1]).toBeGreaterThan(0.85);
            expect(mapped[1]).toBeLessThanOrEqual(1.0);
            expect(mapped[2]).toBeGreaterThan(0.92);
            expect(mapped[2]).toBeLessThanOrEqual(1.0);
        });

        it('preserves black point and shadow nuance', () => {
            const nearBlack: [number, number, number] = [0.02, 0.03, 0.01];
            const mapped = SplatService.acesFilmicToneMap(nearBlack);

            expect(mapped[0]).toBeGreaterThan(0.0);
            expect(mapped[0]).toBeLessThan(0.1);
            expect(mapped[1]).toBeGreaterThan(0.0);
            expect(mapped[2]).toBeGreaterThan(0.0);
        });
    });

    describe('View-Dependent Spherical Harmonics (Degree 1) Radiance', () => {
        it('modulates surface radiance as view direction reflects off normal', () => {
            const baseColor: [number, number, number] = [0.5, 0.5, 0.5];
            const normal: [number, number, number] = [0, 0, 1]; // facing +Z

            // View 1: Looking directly into specular reflection
            const viewDirReflect: [number, number, number] = [0, 0.7071, 0.7071];
            const lit1 = SplatService.evaluateSH1Radiance(baseColor, normal, viewDirReflect, 0.8);

            // View 2: Grazing glance away from reflection
            const viewDirGlance: [number, number, number] = [0.9, 0, 0.435];
            const lit2 = SplatService.evaluateSH1Radiance(baseColor, normal, viewDirGlance, 0.8);

            expect(lit1[0]).not.toEqual(lit2[0]);
            expect(lit1[1]).toBeGreaterThan(baseColor[1]);
        });
    });
});
