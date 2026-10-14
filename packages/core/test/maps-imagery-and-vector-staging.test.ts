import { describe, it, expect } from 'vitest';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import {
    MapsImageryGroundingService,
    MapsImageryChunk
} from '../src/node/spatial/MapsImageryGroundingService';
import {
    GoogleVectorTileService,
    mvtPointToLatLng,
    latLngToTile,
    wgs84ToLocalEnu,
    EarClippingTriangulator
} from '../src/node/spatial/GoogleVectorTileService';
import { HeadlessMeshSilhouetteRenderer } from '../src/node/spatial/HeadlessMeshSilhouetteRenderer';

describe('MapsImageryGroundingService (MIG via PanoID & 360 abilities)', () => {
    it('correctly parses and extracts grounding chunks from Vertex AI MIG payload', async () => {
        const mockPanoId = 'CAoSF0NJSE0wb2dLRUlDQWdJRHE4NkMtbXdF';
        const mockFetch: typeof fetch = async (url: any, init?: any) => {
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    candidates: [
                        {
                            content: {
                                parts: [{ text: 'Found Street View imagery at Shibuya Crossing.' }]
                            },
                            groundingMetadata: {
                                groundingChunks: [
                                    {
                                        mapsImagery: {
                                            panoId: mockPanoId,
                                            captureDate: '2024-05',
                                            uri: 'https://streetviewpixels-pa.googleapis.com/...',
                                            latLng: {
                                                latitude: 35.6595,
                                                longitude: 139.7005
                                            }
                                        }
                                    }
                                ]
                            }
                        }
                    ]
                }),
                text: async () => ''
            } as any;
        };

        const result = await MapsImageryGroundingService.queryVertexMapsImagery('Shibuya Crossing scramble', {
            fetchImpl: mockFetch
        });

        expect(result.text).toContain('Shibuya Crossing');
        expect(result.groundingChunks.length).toBe(1);
        expect(result.groundingChunks[0].panoId).toBe(mockPanoId);
        expect(result.groundingChunks[0].latLng?.latitude).toBeCloseTo(35.6595);
    });

    it('projects Street View pano via direct PanoID into 2:1 ERP equirectangular canvas', async () => {
        const testPanoId = 'test_pano_shibuya_123';
        const mockFetch: typeof fetch = async (url: any) => {
            const urlStr = String(url);
            if (urlStr.includes('metadata')) {
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({
                        status: 'OK',
                        pano_id: testPanoId,
                        date: '2024-06',
                        location: { lat: 35.6595, lng: 139.7005 },
                        copyright: '© 2024 Google'
                    })
                } as any;
            }
            // Mock 1x1 white PNG response for perspective faces
            const dummyPng = Buffer.from(
                'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
                'base64'
            );
            return {
                ok: true,
                status: 200,
                arrayBuffer: async () => dummyPng.buffer.slice(dummyPng.byteOffset, dummyPng.byteOffset + dummyPng.byteLength)
            } as any;
        };

        const tmpOutDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-mig-projection-'));
        const tmpOutPath = path.join(tmpOutDir, 'test_mig_projection.png');
        const projResult = await MapsImageryGroundingService.groundAndProjectStreetViewPanorama({
            panoId: testPanoId,
            // fetch is mocked, so any non-empty key works. Commit 319c3e1 removed the hard-coded default key, so
            // without GOOGLE_MAPS_API_KEY / MAP_TILES_API_KEY the service would refuse before calling fetch.
            apiKey: 'TEST_KEY_mocked_fetch',
            canvasWidth: 256,
            canvasHeight: 128,
            outputPath: tmpOutPath,
            fetchImpl: mockFetch
        });

        expect(projResult.success).toBe(true);
        expect(projResult.panoId).toBe(testPanoId);
        expect(projResult.erpWidth).toBe(256);
        expect(projResult.erpHeight).toBe(128);
        expect(projResult.lat).toBeCloseTo(35.6595);
        expect(projResult.year).toBe(2024);
        expect(projResult.month).toBe(6);
        expect(fs.existsSync(tmpOutPath)).toBe(true);

        // Cleanup
        await fs.remove(tmpOutDir);
    });
});

describe('GoogleVectorTileService (3D Vector Tiles Staging)', () => {
    it('computes geodetic tile indices and unprojects MVT coordinates', () => {
        const lat = 40.7484; // Empire State Building
        const lng = -73.9857;
        const zoom = 16;

        const tile = latLngToTile(lat, lng, zoom);
        expect(tile.x).toBeGreaterThan(0);
        expect(tile.y).toBeGreaterThan(0);

        const [projLng, projLat] = mvtPointToLatLng(2048, 2048, 4096, tile.x, tile.y, zoom);
        expect(projLat).toBeCloseTo(lat, 1);
        expect(projLng).toBeCloseTo(lng, 1);
    });

    it('triangulates polygon rings using EarClippingTriangulator', () => {
        const poly = [
            { x: 0, z: 0 },
            { x: 10, z: 0 },
            { x: 10, z: 10 },
            { x: 0, z: 10 }
        ];

        const area = EarClippingTriangulator.signedArea(poly);
        expect(Math.abs(area)).toBe(100);

        const indices = EarClippingTriangulator.triangulate(poly);
        expect(indices.length).toBe(6); // 2 triangles
    });

    it('stages a 3D vector world into 18% Studio Grey Clay binary .glb', async () => {
        const lat = 40.7484;
        const lng = -73.9857;

        // A synthetic FeatureTile (vectortiles.featuretiles JSON): one 2.5D building and one road, in the tile's 4096 grid.
        const featureTile = {
            x: 0, y: 0, zoom: 16,
            features: [
                {
                    types: ['FEATURE_TYPE_BUILDING'],
                    geometry: { extrudedAreas: [{ maxZ: 400, area: { type: 'TRIANGLE_FAN', vertexOffsets: { xOffsets: [2048, -100, 200, 0, -200], yOffsets: [2048, -100, 0, 200, 0] } } }] }
                },
                {
                    types: ['FEATURE_TYPE_INFRASTRUCTURE', 'FEATURE_TYPE_ROAD'],
                    geometry: { lines: [{ vertexOffsets: { xOffsets: [0, 4096], yOffsets: [1000, 0] } }] }
                }
            ]
        };
        const mockTileFetch: typeof fetch = async (url: any) => {
            const [, z, x, y] = /featuretiles\/(\d+)\/(\d+)\/(\d+)/.exec(String(url))!;
            const body = { ...featureTile, zoom: Number(z), x: Number(x), y: Number(y) };
            return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => body, text: async () => JSON.stringify(body) } as any;
        };
        const origAuth = GoogleVectorTileService.authProvider;
        GoogleVectorTileService.authProvider = async () => ({ token: 'test-token', project: 'test-project' });

        const tmpGlbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-vector-staging-'));
        const tmpGlb = path.join(tmpGlbDir, 'test_vector_staging.glb');

        try {
            const stagingResult = await GoogleVectorTileService.stage3DVectorWorld({
                latitude: lat,
                longitude: lng,
                zoom: 16,
                radiusTiles: 0, // 1 tile only for test
                outputGlbPath: tmpGlb,
                fetchImpl: mockTileFetch
            });

            expect(stagingResult.success).toBe(true);
            expect(stagingResult.stats.buildingCount).toBe(1);
            expect(stagingResult.stats.roadSegmentCount).toBe(1);
            expect(stagingResult.stats.vertexCount).toBeGreaterThan(10);
            expect(stagingResult.stats.triangleCount).toBeGreaterThan(4);
            expect(fs.existsSync(tmpGlb)).toBe(true);

            // Read generated GLB and verify glTF 2.0 magic 0x46546C67
            const glbBuffer = await fs.readFile(tmpGlb);
            expect(glbBuffer.readUInt32LE(0)).toBe(0x46546c67);
            expect(glbBuffer.readUInt32LE(4)).toBe(2); // glTF version 2

            // Verify Studio Grey Clay material in JSON chunk
            const jsonLen = glbBuffer.readUInt32LE(12);
            const jsonChunk = glbBuffer.slice(20, 20 + jsonLen).toString('utf8');
            expect(jsonChunk).toContain('StudioGreyClay');
            expect(jsonChunk).toContain('0.55'); // baseColorFactor 0.55
            expect(jsonChunk).toContain('0.85'); // roughness 0.85
        } finally {
            GoogleVectorTileService.authProvider = origAuth;
            await fs.remove(tmpGlbDir);
        }
    });

    it('seats the pieces of a modeled building split across two tiles at the same height', async () => {
        const lat = 40.7411, lng = -73.9897, z = 18;
        const n = 2 ** z;
        const cx = Math.floor(((lng + 180) / 360) * n);
        const latR = (lat * Math.PI) / 180;
        const cy = Math.floor(((1 - Math.log(Math.tan(latR) + 1 / Math.cos(latR)) / Math.PI) / 2) * n);
        const deltas = (a: number[]) => a.map((v, i) => (i === 0 ? v : v - a[i - 1]));
        // One wall slab per tile, meeting at the tile seam. In the shared datum the north half reaches down to z 0 and
        // the south half to z 10, and both tops are at z 100.
        const slab = (ys: [number, number], zMin: number) => {
            const xs = [2000, 2100, 2000, 2100, 2000, 2100, 2000, 2100];
            const yy = [ys[0], ys[0], ys[0], ys[0], ys[1], ys[1], ys[1], ys[1]];
            const zz = [zMin, zMin, 100, 100, zMin, zMin, 100, 100];
            return {
                types: ['FEATURE_TYPE_BUILDING'],
                geometry: { modeledVolumes: [{ vertexOffsets: { xOffsets: deltas(xs), yOffsets: deltas(yy), zOffsets: deltas(zz) }, strips: [{ vertexIndices: [0, 1, 2, 3] }, { vertexIndices: [4, 5, 6, 7] }, { vertexIndices: [0, 4, 2, 6] }] }] }
            };
        };
        const mockTileFetch: typeof fetch = async (url: any) => {
            const [, tz, tx, ty] = /featuretiles\/(\d+)\/(\d+)\/(\d+)/.exec(String(url))!.map(Number);
            const features = tx !== cx ? [] : ty === cy ? [slab([4080, 4096], 0)] : ty === cy + 1 ? [slab([0, 16], 10)] : [];
            const body = { x: tx, y: ty, zoom: tz, features };
            return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => body, text: async () => JSON.stringify(body) } as any;
        };
        const origAuth = GoogleVectorTileService.authProvider;
        GoogleVectorTileService.authProvider = async () => ({ token: 'test-token', project: 'test-project' });
        const tmpGlbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-vector-split-'));
        const tmpGlb = path.join(tmpGlbDir, 'split.glb');
        try {
            const res = await GoogleVectorTileService.stage3DVectorWorld({
                latitude: lat, longitude: lng, zoom: z, radiusTiles: 1, outputGlbPath: tmpGlb, fetchImpl: mockTileFetch,
                includeRoads: false, includeWater: false
            } as any);
            expect(res.success).toBe(true);
            expect(res.stats.modeledVolumeCount).toBe(2);
            expect(res.stats.buildingCount).toBe(1); // two pieces, one building
            // Split the vertices at the seam (local z: north is negative) and compare each half's top
            const mesh = HeadlessMeshSilhouetteRenderer.loadMeshFromGlb(tmpGlb);
            const pts: Array<[number, number]> = [];
            let groundY = Infinity;
            for (let i = 1; i < mesh.vertices.length; i += 3) groundY = Math.min(groundY, mesh.vertices[i]);
            // only the upper parts of the slabs (the staged scene also has a ground plane)
            for (let i = 0; i < mesh.vertices.length; i += 3) if (mesh.vertices[i + 1] > groundY + 1) pts.push([mesh.vertices[i + 1], mesh.vertices[i + 2]]);
            const zs = pts.map(p => p[1]).sort((a, b) => a - b);
            const seamZ = (zs[0] + zs[zs.length - 1]) / 2;
            // both slabs touch the seam, so leave out a band around it
            const northTop = Math.max(...pts.filter(p => p[1] < seamZ - 0.1).map(p => p[0]));
            const southTop = Math.max(...pts.filter(p => p[1] > seamZ + 0.1).map(p => p[0]));
            expect(Math.abs(northTop - southTop)).toBeLessThan(1e-3);
        } finally {
            GoogleVectorTileService.authProvider = origAuth;
            await fs.remove(tmpGlbDir);
        }
    });
});

