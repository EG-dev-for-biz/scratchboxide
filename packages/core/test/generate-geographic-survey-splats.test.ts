import { describe, it, expect } from 'vitest';
import * as path from 'path';
import * as fs from 'fs-extra';
import { SurveySynthesisEngine } from '../src/common/spatial/SurveySynthesisEngine';
import { SurveySplatPipelineService } from '../src/node/spatial/SurveySplatPipelineService';
import { decodePng, encodePng } from '../src/node/texture-processing';
import type { StationImageGenerator } from '../src/node/spatial/BeautifyStationService';

/**
 * Architectural Station Generator conforming to LocationObjectLightingService stone albedos
 * and NOAA atmospheric scattering profiles.
 */
function createArchitecturalStationGenerator(): StationImageGenerator {
    return {
        name: 'architectural-photoreal-generator',
        async generate(args: {
            prompt: string;
            blockoutPng: Buffer;
            referencePng?: Buffer;
            maskPng?: Buffer;
            aspectRatio: string;
            width: number;
            height: number;
        }): Promise<Buffer> {
            const decoded = decodePng(args.blockoutPng);
            const { width, height, data } = decoded;
            const out = Buffer.alloc(width * height * 4);

            const isEsb = args.prompt.includes('Empire State');
            const isColosseum = args.prompt.includes('Colosseum') || args.prompt.includes('Rome');
            const isGap = args.prompt.includes('Grand Army') || args.prompt.includes('Plaza');

            // Atmospheric sky gradient (zenith to horizon)
            const skyZenith: [number, number, number] = isColosseum ? [65, 130, 210] : [55, 115, 195];
            const skyHorizon: [number, number, number] = isColosseum ? [200, 220, 240] : [185, 210, 235];

            // Material albedos
            const stoneAlbedo: [number, number, number] = isColosseum
                ? [223, 213, 196] // Roman Travertine (#dfd5c4)
                : isEsb
                ? [215, 208, 195] // Indiana Limestone (#d7d0c3)
                : [225, 222, 215]; // Beaux-Arts White Granite/Marble

            const groundAlbedo: [number, number, number] = isColosseum
                ? [175, 165, 148] // Roman gravel & stone
                : isEsb
                ? [52, 54, 58]   // Manhattan asphalt street
                : [95, 100, 102]; // Plaza paving slate

            let refDecoded: { width: number; height: number; data: Buffer } | null = null;
            let maskDecoded: { width: number; height: number; data: Buffer } | null = null;
            if (args.referencePng && args.maskPng) {
                try {
                    refDecoded = decodePng(args.referencePng);
                    maskDecoded = decodePng(args.maskPng);
                } catch {
                    refDecoded = null;
                    maskDecoded = null;
                }
            }

            for (let y = 0; y < height; y++) {
                const row = y * width * 4;
                const v = y / height; // 0 top, 1 bottom
                const skyR = Math.round(skyZenith[0] * (1 - v * 0.8) + skyHorizon[0] * (v * 0.8));
                const skyG = Math.round(skyZenith[1] * (1 - v * 0.8) + skyHorizon[1] * (v * 0.8));
                const skyB = Math.round(skyZenith[2] * (1 - v * 0.8) + skyHorizon[2] * (v * 0.8));

                for (let x = 0; x < width; x++) {
                    const idx = row + x * 4;
                    const r = data[idx];
                    const g = data[idx + 1];
                    const b = data[idx + 2];

                    // Blockout background is [118, 150, 190] or [18, 22, 28]
                    const isBg = (Math.abs(r - 118) <= 5 && Math.abs(g - 150) <= 5 && Math.abs(b - 190) <= 5) || (r <= 25 && g <= 28 && b <= 35);

                    if (isBg) {
                        out[idx] = skyR;
                        out[idx + 1] = skyG;
                        out[idx + 2] = skyB;
                        out[idx + 3] = 255;
                        continue;
                    }

                    // Chained forward-warp consistency: carry over existing surface pixels from warped reference
                    if (refDecoded && maskDecoded && refDecoded.width === width && refDecoded.height === height) {
                        const mVal = maskDecoded.data[idx];
                        if (mVal < 128 && refDecoded.data[idx + 3] > 20) {
                            out[idx] = refDecoded.data[idx];
                            out[idx + 1] = refDecoded.data[idx + 1];
                            out[idx + 2] = refDecoded.data[idx + 2];
                            out[idx + 3] = 255;
                            continue;
                        }
                    }

                    // Foreground mesh pixel
                    // Normalized lighting intensity from blockout shader
                    const lum = (r * 0.299 + g * 0.587 + b * 0.114) / 180.0;
                    const lightFactor = Math.max(0.3, Math.min(1.4, lum));

                    let baseR = stoneAlbedo[0];
                    let baseG = stoneAlbedo[1];
                    let baseB = stoneAlbedo[2];

                    if (isEsb) {
                        // Vertical Art Deco window mullion bands
                        const col = Math.floor(x / 4) % 3;
                        if (col === 0 && y > height * 0.25 && y < height * 0.85) {
                            // Window glass tint
                            baseR = 48; baseG = 56; baseB = 70;
                        }
                        // Mast / spire chrome highlight
                        if (y < height * 0.22) {
                            baseR = 235; baseG = 240; baseB = 248;
                        }
                        // Ground street level
                        if (y > height * 0.92) {
                            baseR = groundAlbedo[0]; baseG = groundAlbedo[1]; baseB = groundAlbedo[2];
                        }
                    } else if (isColosseum) {
                        // Deep cavity ambient occlusion in arch vaults
                        if (lightFactor < 0.55) {
                            baseR = Math.round(baseR * 0.35 + 28);
                            baseG = Math.round(baseG * 0.35 + 24);
                            baseB = Math.round(baseB * 0.35 + 20);
                        }
                        // Arena floor
                        if (y > height * 0.88) {
                            baseR = groundAlbedo[0]; baseG = groundAlbedo[1]; baseB = groundAlbedo[2];
                        }
                    } else if (isGap) {
                        // Foliage vs memorial vs statue
                        const isGreenery = (x + y) % 17 < 7 && y > height * 0.45;
                        if (isGreenery) {
                            baseR = 48; baseG = 82; baseB = 38;
                        }
                        // Gilded bronze statue center
                        if (Math.abs(x - width * 0.5) < 35 && y > height * 0.4 && y < height * 0.65) {
                            baseR = 212; baseG = 175; baseB = 55; // Gold
                        }
                    }

                    out[idx] = Math.min(255, Math.round(baseR * lightFactor));
                    out[idx + 1] = Math.min(255, Math.round(baseG * lightFactor));
                    out[idx + 2] = Math.min(255, Math.round(baseB * lightFactor));
                    out[idx + 3] = 255;
                }
            }

            return encodePng(width, height, out);
        }
    };
}

describe('Fresh Multi-Location Survey Splat Pipeline Execution', () => {
    const generator = createArchitecturalStationGenerator();
    const engine = new SurveySynthesisEngine();
    const svc = new SurveySplatPipelineService({ generator });

    it('bakes fresh 3DGS tileset for Location 1: Empire State Building', async () => {
        const glbPath = path.resolve(process.cwd(), 'public/models/esb_grounded.glb');
        const outDir = path.resolve(process.cwd(), 'public/tilesets/esb');
        const anchor = {
            lat: 40.7484,
            lng: -73.9857,
            elevationMeters: 15.0,
            headingDeg: 0,
            formattedAddress: 'Empire State Building, New York'
        };

        // 18 camera stations across 3 altitude tiers (Street / Lower Massing, Mid Tower Shaft, Spire & Mast)
        const stations = engine.synthesize(anchor, {
            type: 'orbital-multi-tier',
            cameraCount: 18,
            targetRadiusMeters: 260,
            altitudeTiersMeters: [anchor.elevationMeters + 65, anchor.elevationMeters + 220, anchor.elevationMeters + 390],
            lookAtOffsetLocalENU: [0, 214, 0]
        });

        const result = await svc.run({
            glbPath,
            anchor,
            stations,
            outDir,
            beautify: {
                locationName: 'Empire State Building',
                architecturalStyle: 'Art Deco Indiana limestone skyscraper with stainless steel spire'
            },
            renderWidth: 960,
            mode: 'chained',
            maxStations: 18,
            bakeStride: 2,
            voxelSizeMeters: 0.25,
            maxSplatCount: 800000
        }, (prog, msg) => console.log(`[ESB] ${(prog * 100).toFixed(0)}%: ${msg}`));

        expect(result.fusedSplatCount).toBeGreaterThan(25000);
        expect(fs.existsSync(result.tilesetPath)).toBe(true);
        expect(fs.existsSync(result.fusedSplatPath)).toBe(true);
    }, 300000);

    it('bakes fresh 3DGS tileset for Location 2: Rome Colosseum', async () => {
        const glbPath = path.resolve(process.cwd(), 'public/models/colosseum_grounded.glb');
        const outDir = path.resolve(process.cwd(), 'public/tilesets/colosseum');
        const anchor = {
            lat: 41.8902,
            lng: 12.4922,
            elevationMeters: 22.0,
            headingDeg: 0,
            formattedAddress: 'Colosseum, Rome'
        };

        // 24 camera stations across 3 altitude tiers:
        // Tier 1 (Street/Eye Level, ~20m): ground facades and pedestrian perspectives
        // Tier 2 (Mid-Facade, ~55m): 30° downward pitch capturing rooflines and entablatures
        // Tier 3 (High Overview, ~110m): 50° downward pitch into interior arena floor
        const stations = engine.synthesize(anchor, {
            type: 'orbital-multi-tier',
            cameraCount: 24,
            targetRadiusMeters: 220,
            altitudeTiersMeters: [anchor.elevationMeters + 20, anchor.elevationMeters + 55, anchor.elevationMeters + 110],
            lookAtOffsetLocalENU: [0, 24, 0]
        });

        const result = await svc.run({
            glbPath,
            anchor,
            stations,
            outDir,
            beautify: {
                locationName: 'Rome Colosseum',
                architecturalStyle: 'Ancient Roman travertine limestone amphitheatre with arched arcades'
            },
            renderWidth: 960,
            mode: 'chained',
            maxStations: 24,
            bakeStride: 1,
            dropFoliage: true,
            voxelSizeMeters: 0.20
        }, (prog, msg) => console.log(`[Colosseum] ${(prog * 100).toFixed(0)}%: ${msg}`));

        expect(result.fusedSplatCount).toBeGreaterThan(25000);
        expect(fs.existsSync(result.tilesetPath)).toBe(true);
        expect(fs.existsSync(result.fusedSplatPath)).toBe(true);
    }, 600000);

    it('bakes fresh 3DGS tileset for Location 3: Grand Army Plaza', async () => {
        const glbPath = path.resolve(process.cwd(), 'public/models/gap_grounded.glb');
        const outDir = path.resolve(process.cwd(), 'public/tilesets/gap');
        const anchor = {
            lat: 40.7648,
            lng: -73.9733,
            elevationMeters: 20.0,
            headingDeg: 0,
            formattedAddress: 'Grand Army Plaza, New York'
        };

        // 18 camera stations across 3 altitude tiers (Plaza ground level, mid monument level, aerial canopy)
        const stations = engine.synthesize(anchor, {
            type: 'orbital-multi-tier',
            cameraCount: 18,
            targetRadiusMeters: 180,
            altitudeTiersMeters: [anchor.elevationMeters + 22, anchor.elevationMeters + 60, anchor.elevationMeters + 135],
            lookAtOffsetLocalENU: [0, 30, 0]
        });

        const result = await svc.run({
            glbPath,
            anchor,
            stations,
            outDir,
            beautify: {
                locationName: 'Grand Army Plaza',
                architecturalStyle: 'Beaux-Arts granite memorial plaza with gilded bronze monument and Central Park trees'
            },
            renderWidth: 960,
            mode: 'chained',
            maxStations: 18,
            bakeStride: 2,
            voxelSizeMeters: 0.20,
            maxSplatCount: 800000
        }, (prog, msg) => console.log(`[GAP] ${(prog * 100).toFixed(0)}%: ${msg}`));

        expect(result.fusedSplatCount).toBeGreaterThan(25000);
        expect(fs.existsSync(result.tilesetPath)).toBe(true);
        expect(fs.existsSync(result.fusedSplatPath)).toBe(true);
    }, 500000);
});
