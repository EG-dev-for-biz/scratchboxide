import { describe, it, expect } from 'vitest';
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

    describe('AtmosphereImageEstimationService.estimateFromImage with Landmark & NOAA Ephemeris', () => {
        it('should ground Rome Colosseum afternoon lighting with NOAA solar position', async () => {
            const result = await AtmosphereImageEstimationService.estimateFromImage({
                promptHint: 'Colosseum Rome sunny afternoon',
                knownCoords: { lat: 41.8902, lng: 12.4922 },
                timestampIso: '2026-09-28T15:30:00Z',
                cameraHeadingDeg: 108.0,
                cameraPitchDeg: 6.0
            });

            expect(result.landmarkHint).toContain('Colosseum');
            expect(result.diurnalPhase.toLowerCase()).toBe('afternoon');
            expect(result.kelvinTemperature).toBeGreaterThanOrEqual(5000);
            expect(result.kelvinTemperature).toBeLessThanOrEqual(5800);
            expect(result.sunElevation).toBeGreaterThan(25);
            expect(result.sunAzimuth).toBeGreaterThan(100);
            expect(result.sunAzimuth).toBeLessThan(260);
            expect(result.confidence).toBeGreaterThan(0.8);
        });
    });

    describe('In-App Gemini Tool Handler: atmosphere_estimate_from_image', () => {
        it('should execute atmosphere_estimate_from_image handler and return structured result', async () => {
            const handler = atmosphereHandlers.atmosphere_estimate_from_image;
            expect(handler).toBeDefined();

            const execution = await handler({
                promptHint: 'Piazza del Colosseo Rome afternoon',
                latitude: 41.8902,
                longitude: 12.4922,
                isoDate: '2026-09-28T15:30:00Z',
                cameraHeadingDeg: 108.0
            }, {} as any);

            expect(execution.resultPayload).toBeDefined();
            const payload = execution.resultPayload as any;
            expect(payload.diurnalPhase.toLowerCase()).toBe('afternoon');
            expect(payload.kelvinTemperature).toBeGreaterThan(5000);
            expect(execution.summaryResult).toContain('Estimated physical atmosphere matching image');
            expect(execution.summaryResult).toContain(`${payload.kelvinTemperature}K`);
        });
    });

    describe('AtmosphereService Facade Integration', () => {
        it('should accept and apply atmospheric estimation result seamlessly', async () => {
            const atmosphereService = new AtmosphereService();
            const estimation = await AtmosphereImageEstimationService.estimateFromImage({
                promptHint: 'Colosseum Rome afternoon',
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
