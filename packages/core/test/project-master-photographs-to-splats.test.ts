import { describe, it, expect } from 'vitest';
import * as path from 'path';
import * as fs from 'fs-extra';
import { exec } from 'child_process';
import { promisify } from 'util';
import { SurveyStationRenderService } from '../src/node/spatial/SurveyStationRenderService';
import { SurveySynthesisEngine } from '../src/common/spatial/SurveySynthesisEngine';
import { Splat3DTilesService } from '../src/node/spatial/Splat3DTilesService';

const execAsync = promisify(exec);

describe('Project Master Photographs to Gaussian Splats', () => {
    it('unprojects master beautified photographs into 3D Gaussian Splats and fuses tileset', async () => {
        const rootDir = path.resolve(__dirname, '../../../');
        const glbPath = path.join(rootDir, 'public/models/colosseum_grounded.glb');
        const sourceStationsDir = path.join(rootDir, 'public/tilesets/colosseum/stations');
        const outDir = path.join(rootDir, 'build/test_colosseum_splats');
        const stationsDir = path.join(outDir, 'stations');
        await fs.ensureDir(stationsDir);
        const baker = path.join(rootDir, 'build/station_to_splats');

        const anchor = {
            lat: 41.8902,
            lng: 12.4922,
            elevationMeters: 22.0,
            headingDeg: 0,
            formattedAddress: 'Colosseum, Rome'
        };

        const engine = new SurveySynthesisEngine();
        const stations = engine.synthesize(anchor, {
            type: 'orbital-multi-tier',
            cameraCount: 24,
            targetRadiusMeters: 220,
            altitudeTiersMeters: [anchor.elevationMeters + 20, anchor.elevationMeters + 55, anchor.elevationMeters + 110],
            lookAtOffsetLocalENU: [0, 24, 0]
        });

        console.log(`Loading mesh from: ${glbPath}`);
        const renderer = new SurveyStationRenderService();
        await renderer.loadMesh(glbPath);

        // Stations with master beautified photographs
        const targetStationIds = [14, 17, 18, 21, 24];
        const bakedSplats: string[] = [];

        for (const st of stations) {
            const sidStr = String(st.id).padStart(3, '0');
            const beautifiedPng = path.join(sourceStationsDir, `station_${sidStr}_beautified.png`);
            const splatPath = path.join(stationsDir, `station_${sidStr}.splat`);

            if (!fs.existsSync(beautifiedPng)) {
                if (fs.existsSync(splatPath)) {
                    bakedSplats.push(splatPath);
                }
                continue;
            }

            const isTarget = targetStationIds.includes(st.id);
            console.log(`Processing Station ${st.id} (${st.name})${isTarget ? ' [MASTER PHOTOGRAPH]' : ''}...`);

            // 1. Render mesh depth buffer at 960x540
            const blockout = renderer.renderStationBlockout(st, { width: 960, height: 540 });
            const depthBuffer = Buffer.from(blockout.depth.buffer, blockout.depth.byteOffset, blockout.depth.byteLength);

            const depthPath = path.join(stationsDir, `temp_station_${sidStr}.depth.f32`);
            const rgbPath = path.join(stationsDir, `temp_station_${sidStr}.rgb`);
            const posePath = path.join(stationsDir, `temp_station_${sidStr}.pose.json`);

            await fs.writeFile(depthPath, depthBuffer);

            // Write matching 960x540 camera intrinsics to temporary pose file
            const { right, up, forward } = cameraBasis(st.forwardVector, st.upVector || [0, 1, 0]);
            await fs.writeJson(posePath, {
                fx: blockout.intrinsics.fx,
                fy: blockout.intrinsics.fy,
                cx: blockout.intrinsics.cx,
                cy: blockout.intrinsics.cy,
                eye: st.positionLocalENU,
                right,
                up,
                forward,
                cameraAltitude: st.positionLocalENU[1],
                depthKind: 'camera-z'
            });

            // 2. Decode beautified image to 960x540 RGB raw using ffmpeg
            const decodeCmd = `ffmpeg -y -v error -i "${beautifiedPng}" -vf "scale=960:540" -f rawvideo -pix_fmt rgb24 "${rgbPath}"`;
            await execAsync(decodeCmd);

            // Step 5: Multi-View Radiometric Luminance Equalization (harmonize stations 14, 17, 21, 24 with anchor 18)
            const rawRgb = await fs.readFile(rgbPath);
            const pixelCount = rawRgb.length / 3;
            let sumR = 0, sumG = 0, sumB = 0;
            for (let p = 0; p < pixelCount; p++) {
                sumR += rawRgb[p * 3 + 0];
                sumG += rawRgb[p * 3 + 1];
                sumB += rawRgb[p * 3 + 2];
            }
            const meanR = sumR / pixelCount;
            const meanG = sumG / pixelCount;
            const meanB = sumB / pixelCount;
            const targetR = 125.0; // Anchor Station 18 travertine albedo
            const targetG = 100.0;
            const targetB = 71.0;
            const gainR = Math.min(1.20, Math.max(0.80, targetR / Math.max(1, meanR)));
            const gainG = Math.min(1.20, Math.max(0.80, targetG / Math.max(1, meanG)));
            const gainB = Math.min(1.20, Math.max(0.80, targetB / Math.max(1, meanB)));
            if (st.id !== 18) {
                for (let p = 0; p < pixelCount; p++) {
                    rawRgb[p * 3 + 0] = Math.min(255, Math.max(0, Math.round(rawRgb[p * 3 + 0] * gainR)));
                    rawRgb[p * 3 + 1] = Math.min(255, Math.max(0, Math.round(rawRgb[p * 3 + 1] * gainG)));
                    rawRgb[p * 3 + 2] = Math.min(255, Math.max(0, Math.round(rawRgb[p * 3 + 2] * gainB)));
                }
                await fs.writeFile(rgbPath, rawRgb);
                console.log(`  -> Radiometric Equalization: gainR=${gainR.toFixed(3)}, gainG=${gainG.toFixed(3)}, gainB=${gainB.toFixed(3)}`);
            }

            // 3. Unproject into 3D Gaussian Splats via native C++ station_to_splats
            // Includes:
            //   - Step 3: Analytical Depth Cavity Inpainting (--cavity-depth 3.5 --cavity-lum 0.18)
            //   - Step 4: Strict Grazing Cutoff (--min-cos-incidence 0.15)
            //   - Step 2: Semantic Foliage / Tree Decoupling (--drop-foliage)
            const unprojectCmd = `"${baker}" --rgb "${rgbPath}" --depth "${depthPath}" --width 960 --height 540 --pose "${posePath}" --out-splat "${splatPath}" --stride 1 --sigma-scale 0.95 --min-cos-incidence 0.15 --cavity-depth 3.5 --cavity-lum 0.18 --exclude-underside --drop-foliage --json`;
            const { stdout } = await execAsync(unprojectCmd);
            const parsed = JSON.parse(stdout.trim());
            console.log(`  -> Unprojected Station ${st.id}: ${parsed.numSplats ?? (parsed.splatBytes / 32)} splats, cavitiesCarved=${parsed.cavitiesCarved ?? 0}`);

            // Clean up temporary buffers
            await fs.remove(depthPath);
            await fs.remove(rgbPath);
            await fs.remove(posePath);

            bakedSplats.push(splatPath);
        }

        expect(bakedSplats.length).toBeGreaterThanOrEqual(5);

        // 4. Fuse all station splats into fused.splat
        console.log(`Fusing ${bakedSplats.length} station splats...`);
        const listPath = path.join(outDir, 'stations_to_fuse.txt');
        await fs.outputFile(listPath, bakedSplats.join('\n'));

        const fusedSplatPath = path.join(outDir, 'fused.splat');
        const fuseCmd = `"${baker}" --fuse-list "${listPath}" --voxel-size 0.20 --crop-radius 115.0 --drop-foliage --exclude-underside --out-splat "${fusedSplatPath}" --out-spz "${path.join(outDir, 'fused.spz')}" --json`;
        const { stdout: fuseStdout } = await execAsync(fuseCmd);
        const fuseRes = JSON.parse(fuseStdout.trim());
        console.log(`  -> Fused Splat Count: ${fuseRes.fusedSplatCount} (total input: ${fuseRes.totalInputSplats})`);
        await fs.remove(listPath);

        // 5. Re-tile 3D Tiles pyramid
        console.log('Building 3D Tiles 1.1 pyramid (tileset.json + tiles/)...');
        const tiles = new Splat3DTilesService();
        const tileRes = await tiles.convert({
            inputPath: fusedSplatPath,
            outDir,
            origin: anchor,
            headingDeg: 0,
            maxDepth: 5
        });

        console.log(`  -> 3D Tiles build: success=${tileRes.success}, tiles=${tileRes.tileCount}, levels=${tileRes.levels}`);
        expect(tileRes.success).toBe(true);

        // 6. Update tileset.meta.json
        const metaPath = path.join(outDir, 'tileset.meta.json');
        if (fs.existsSync(metaPath)) {
            const meta = await fs.readJson(metaPath);
            meta.fusedSplatCount = fuseRes.fusedSplatCount;
            meta.updatedAt = new Date().toISOString();
            meta.tiles = {
                tileCount: tileRes.tileCount,
                levels: tileRes.levels,
                tileBytes: tileRes.tileBytes
            };
            await fs.writeJson(metaPath, meta, { spaces: 2 });
            console.log(`  -> Updated metadata at ${metaPath}`);
        }
    }, 180000);
});
