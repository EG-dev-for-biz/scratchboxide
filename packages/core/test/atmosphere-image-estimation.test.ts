import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { encodePng } from '../src/node/texture-processing';
import { MissingInputError } from '../src/common/errors/pipeline-errors';
import {
    fitPlanckianKelvinTemperature,
    computeSkyAtmosphereMetrics,
    AtmosphereImageEstimationService,
    AtmosphereService,
    atmosphereHandlers
} from '../src/node';

describe('Atmosphere Image Estimation Service & Pipeline', () => {
    describe('fitPlanckianKelvinTemperature (McCamy Cubic Approximation)', () => {
        it('should estimate warm Kelvin temperature for warm afternoon/sunset light', () => {
            // Warm golden sunlight: strong red, moderate green, low blue
            const warmKelvin = fitPlanckianKelvinTemperature(255, 200, 140);
            expect(warmKelvin).toBeGreaterThanOrEqual(3000);
            expect(warmKelvin).toBeLessThanOrEqual(5800);
        });

        it('should estimate ~6500K for standard D65 neutral white daylight', () => {
            const middayKelvin = fitPlanckianKelvinTemperature(245, 245, 255);
            expect(middayKelvin).toBeGreaterThan(5800);
            expect(middayKelvin).toBeLessThan(7500);
        });

        it('should estimate high Kelvin temperature (>8000K) for zenith blue skylight', () => {
            const blueSkyKelvin = fitPlanckianKelvinTemperature(100, 160, 255);
            expect(blueSkyKelvin).toBeGreaterThan(8000);
        });
    });

    describe('computeSkyAtmosphereMetrics (Photometric Pixel Sampling)', () => {
        it('should correctly extract zenith/horizon slices, glare locus, and cloud fraction', () => {
            const width = 100;
            const height = 100;
            const pixels = new Uint8Array(width * height * 4);

            // Populate top 35 rows as blue sky, with a bright sun spot around (x=60, y=10)
            for (let y = 0; y < height; y++) {
                for (let x = 0; x < width; x++) {
                    const idx = (y * width + x) * 4;
                    if (y < 35) {
                        // Sky region: blueish
                        const distToSun = Math.hypot(x - 60, y - 10);
                        if (distToSun < 5) {
                            // Bright solar disc / glare
                            pixels[idx] = 255;
                            pixels[idx + 1] = 250;
                            pixels[idx + 2] = 230;
                            pixels[idx + 3] = 255;
                        } else {
                            // Sky gradient: darker blue at zenith (y=0..10), lighter cyan at horizon (y=25..35)
                            const t = y / 35;
                            pixels[idx] = Math.round(100 + 70 * t);
                            pixels[idx + 1] = Math.round(150 + 60 * t);
                            pixels[idx + 2] = Math.round(230 + 20 * t);
                            pixels[idx + 3] = 255;
                        }
                    } else {
                        // Ground region: warm stone/travertine
                        pixels[idx] = 180;
                        pixels[idx + 1] = 160;
                        pixels[idx + 2] = 130;
                        pixels[idx + 3] = 255;
                    }
                }
            }

            const metrics = computeSkyAtmosphereMetrics(pixels, width, height);

            expect(metrics.skyPixels).toBeGreaterThan(0);
            expect(metrics.zenithRgb.b).toBeGreaterThan(metrics.zenithRgb.r);
            expect(metrics.skyGradientRatio).toBeGreaterThan(0.5);
            expect(metrics.glareLocusX).toBeGreaterThan(0.5); // centered around x=60/100 -> 0.6
            expect(metrics.glareLocusY).toBeLessThan(0.3); // centered around y=10/100 -> 0.1
        });
    });

    describe('AtmosphereImageEstimationService.estimateFromPixels', () => {
        it('should synthesize physically grounded atmospheric config from image buffer', () => {
            const width = 80;
            const height = 80;
            const pixels = new Uint8Array(width * height * 4);

            // Afternoon Mediterranean scene: bright warm sun on top-right, clear blue sky
            for (let y = 0; y < height; y++) {
                for (let x = 0; x < width; x++) {
                    const idx = (y * width + x) * 4;
                    if (y < 30) {
                        const dist = Math.hypot(x - 55, y - 8);
                        if (dist < 4) {
                            pixels[idx] = 255;
                            pixels[idx + 1] = 245;
                            pixels[idx + 2] = 210;
                            pixels[idx + 3] = 255;
                        } else {
                            pixels[idx] = 120;
                            pixels[idx + 1] = 180;
                            pixels[idx + 2] = 240;
                            pixels[idx + 3] = 255;
                        }
                    } else {
                        pixels[idx] = 160;
                        pixels[idx + 1] = 140;
                        pixels[idx + 2] = 100;
                        pixels[idx + 3] = 255;
                    }
                }
            }

            const result = AtmosphereImageEstimationService.estimateFromPixels({
                pixels,
                width,
                height,
                cameraHeadingDeg: 108.0,
                cameraPitchDeg: 6.0
            });

            expect(result.kelvinTemperature).toBeGreaterThanOrEqual(4000);
            expect(result.kelvinTemperature).toBeLessThanOrEqual(7500);
            expect(result.turbidity).toBeGreaterThanOrEqual(1.8);
            expect(result.turbidity).toBeLessThanOrEqual(7.5);
            expect(result.rayleighScattering).toBeGreaterThanOrEqual(1.6);
            expect(result.rayleighScattering).toBeLessThanOrEqual(4.2);
            expect(result.sunElevation).toBeGreaterThan(20);
            expect(result.sunElevation).toBeLessThan(75);
            expect(result.aerialPerspectiveRange).toBeGreaterThan(5000);
            expect(result.aerialPerspectiveRange).toBeLessThanOrEqual(30000);

            // Verify suggestedAtmosphereConfig matches AtmosphereService contracts
            const cfg = result.suggestedAtmosphereConfig;
            expect(cfg.turbidity).toBe(result.turbidity);
            expect(cfg.rayleigh).toBe(result.rayleighScattering);
            expect(cfg.sunPosition.length).toBe(3);
            expect(cfg.aerialPerspectiveEnabled).toBe(true);
            expect(cfg.aerialPerspectiveExtinctionRange).toBe(result.aerialPerspectiveRange);
        });
    });

    describe('AtmosphereImageEstimationService.estimateFromImage: the photo\'s pixels or an error', () => {
        it('estimates from the pixels and grounds the sun with NOAA ephemeris at the given coordinates', async () => {
            const sky = skyImage(80, 80);
            const result = await AtmosphereImageEstimationService.estimateFromImage({
                pixels: sky.pixels,
                width: sky.width,
                height: sky.height,
                knownCoords: { lat: 41.8902, lng: 12.4922 },
                timestampIso: '2026-09-28T15:30:00Z',
                cameraHeadingDeg: 108.0,
                cameraPitchDeg: 6.0
            });

            expect(result.landmarkHint).toBeUndefined();
            expect(result.diurnalPhase.toLowerCase()).toBe('afternoon');
            expect(result.sunElevation).toBeGreaterThan(25);
            expect(result.sunAzimuth).toBeGreaterThan(100);
            expect(result.sunAzimuth).toBeLessThan(260);
        });

        it('never synthesizes an estimate without pixels, and never maps a hint to a landmark', async () => {
            // It used to place any photo at the Colosseum (or a regex-matched landmark) with constant "measured" metrics.
            await expect(AtmosphereImageEstimationService.estimateFromImage({ promptHint: 'Colosseum Rome sunny afternoon', imagePath: 'unread.jpg' }))
                .rejects.toThrow(MissingInputError);
            const sky = skyImage(80, 80);
            const hinted = AtmosphereImageEstimationService.estimateFromPixels({ pixels: sky.pixels, width: sky.width, height: sky.height, promptHint: 'Eiffel Tower, Paris', timestampIso: '2026-09-28T15:30:00Z' });
            expect((hinted.suggestedAtmosphereConfig as any).latitude).toBeUndefined();
        });
    });

    describe('In-App Gemini Tool Handler: atmosphere_estimate_from_image', () => {
        it('decodes the photograph it is given and estimates from it', async () => {
            const handler = atmosphereHandlers.atmosphere_estimate_from_image;
            const sky = skyImage(96, 72);
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-atmo-'));
            const imagePath = path.join(dir, 'plaza.png');
            fs.writeFileSync(imagePath, encodePng(sky.width, sky.height, Buffer.from(sky.pixels)));
            try {
                const execution = await handler({
                    imagePath,
                    latitude: 41.8902,
                    longitude: 12.4922,
                    isoDate: '2026-09-28T15:30:00Z',
                    cameraHeadingDeg: 108.0
                }, {} as any);
                const payload = execution.resultPayload as any;
                expect(payload.diurnalPhase.toLowerCase()).toBe('afternoon');
                expect(execution.summaryResult).toContain('Estimated physical atmosphere matching image');
                expect(execution.summaryResult).toContain(`${payload.kelvinTemperature}K`);

                await expect(handler({ promptHint: 'Piazza del Colosseo Rome afternoon', latitude: 41.8902, longitude: 12.4922 }, {} as any)).rejects.toThrow(MissingInputError);
                await expect(handler({ imagePath: path.join(dir, 'missing.png') }, {} as any)).rejects.toThrow(/does not exist/);
            } finally {
                fs.rmSync(dir, { recursive: true, force: true });
            }
        });
    });

    describe('AtmosphereService Facade Integration', () => {
        it('should accept and apply atmospheric estimation result seamlessly', async () => {
            const atmosphereService = new AtmosphereService();
            const sky = skyImage(80, 80);
            const estimation = await AtmosphereImageEstimationService.estimateFromImage({
                pixels: sky.pixels,
                width: sky.width,
                height: sky.height,
                knownCoords: { lat: 41.8902, lng: 12.4922 }
            });

            atmosphereService.applyEstimationResult(estimation);
            const currentConfig = atmosphereService.getConfig();

            expect(currentConfig.turbidity).toBe(estimation.turbidity);
            expect(currentConfig.rayleigh).toBe(estimation.rayleighScattering);
            expect(currentConfig.aerialPerspectiveExtinctionRange).toBe(estimation.aerialPerspectiveRange);
        });
    });
});

/** A clear afternoon sky over warm stone with a sun disc at the upper right (RGBA8). */
function skyImage(width: number, height: number): { pixels: Uint8Array; width: number; height: number } {
    const pixels = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const i = (y * width + x) * 4;
            const sky = y < height * 0.38;
            const sun = Math.hypot(x - width * 0.7, y - height * 0.1) < Math.max(3, width * 0.05);
            const rgb = sun ? [255, 245, 210] : sky ? [120, 180, 240] : [170, 150, 110];
            pixels[i] = rgb[0]; pixels[i + 1] = rgb[1]; pixels[i + 2] = rgb[2]; pixels[i + 3] = 255;
        }
    }
    return { pixels, width, height };
}
