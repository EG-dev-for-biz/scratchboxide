import { describe, it, expect } from 'vitest';
import * as fs from 'fs-extra';
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

        const tmpOutPath = path.resolve(process.cwd(), 'public/panoramas/test_mig_projection.png');
        const projResult = await MapsImageryGroundingService.groundAndProjectStreetViewPanorama({
            panoId: testPanoId,
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
        await fs.remove(tmpOutPath);
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

        // Mock fetchVectorTile to return sample buildings and road features
        const mockTileFetch: typeof fetch = async (url: any) => {
            return {
                ok: true,
                status: 200,
                arrayBuffer: async () => new ArrayBuffer(0) // empty pbf
            } as any;
        };

        const tmpGlb = path.resolve(process.cwd(), 'public/models/test_vector_staging.glb');

        // Spy / override decodeTileBuffer on test run
        const origDecode = GoogleVectorTileService.decodeTileBuffer;
        GoogleVectorTileService.decodeTileBuffer = () => ({
            buildings: [
                {
                    id: 'bldg-1',
                    type: 'Polygon',
                    ring: [
                        [lng - 0.0005, lat - 0.0005],
                        [lng + 0.0005, lat - 0.0005],
                        [lng + 0.0005, lat + 0.0005],
                        [lng - 0.0005, lat + 0.0005]
                    ],
                    properties: { height: '35.0' }
                }
            ],
            roads: [
                {
                    id: 'road-1',
                    type: 'LineString',
                    points: [
                        [lng - 0.001, lat],
                        [lng + 0.001, lat]
                    ],
                    properties: { class: 'road' }
                }
            ],
            water: [],
            landuse: []
        });

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
            GoogleVectorTileService.decodeTileBuffer = origDecode;
            await fs.remove(tmpGlb);
        }
    });
});
