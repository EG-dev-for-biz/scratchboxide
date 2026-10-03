import { describe, it, expect, vi } from 'vitest';
import {
    projectCubicFacesToErpBuffer,
    fetchStreetViewPanoMetadata,
    fetchStreetViewCubicFaces,
    retrieveAndProjectStreetViewPano,
    unprojectCubicFacesToPointCloud,
    parseStreetViewDate,
    type RawFaceImage
} from '../src/node/spatial/StreetViewPanoramaProjectionService';

function createSolidFace(width: number, height: number, r: number, g: number, b: number): RawFaceImage {
    const rgba = Buffer.alloc(width * height * 4);
    for (let i = 0; i < width * height; i++) {
        rgba[i * 4 + 0] = r;
        rgba[i * 4 + 1] = g;
        rgba[i * 4 + 2] = b;
        rgba[i * 4 + 3] = 255;
    }
    return { width, height, rgba };
}

describe('StreetViewPanoramaProjectionService (spce port & extension)', () => {
    describe('parseStreetViewDate', () => {
        it('parses YYYY-MM and YYYY-MM-DD properly', () => {
            expect(parseStreetViewDate('2024-05')).toEqual({ year: 2024, month: 5 });
            expect(parseStreetViewDate('2019-11-20')).toEqual({ year: 2019, month: 11 });
            expect(parseStreetViewDate(null)).toHaveProperty('year');
        });
    });

    describe('projectCubicFacesToErpBuffer (spce spherical ray-casting projection)', () => {
        it('maps 4 cardinal faces to the exact equirectangular quadrants', () => {
            const S = 64;
            // North = Red, East = Green, South = Blue, West = Yellow
            const faces = {
                North: createSolidFace(S, S, 255, 0, 0),
                East: createSolidFace(S, S, 0, 255, 0),
                South: createSolidFace(S, S, 0, 0, 255),
                West: createSolidFace(S, S, 255, 255, 0)
            };

            const W = 256;
            const H = 128;
            const result = projectCubicFacesToErpBuffer(faces, {
                canvasWidth: W,
                canvasHeight: H,
                fovDegrees: 100,
                fillMode: 'green'
            });

            expect(result.width).toBe(W);
            expect(result.height).toBe(H);
            expect(result.rgba.length).toBe(W * H * 4);
            expect(result.png.length).toBeGreaterThan(100);

            // Equirectangular coordinate mapping:
            // Longitude theta ranges from -PI (left: x=0) to +PI (right: x=W-1).
            // At x = W/2 (theta = 0): pointing North (heading 0) -> Should be RED
            const northIdx = (Math.floor(H / 2) * W + Math.floor(W / 2)) * 4;
            expect(result.rgba[northIdx + 0]).toBe(255); // R
            expect(result.rgba[northIdx + 1]).toBe(0);   // G
            expect(result.rgba[northIdx + 2]).toBe(0);   // B

            // At x = 3*W/4 (theta = PI/2): pointing East (heading 90°) -> Should be GREEN
            const eastIdx = (Math.floor(H / 2) * W + Math.floor((3 * W) / 4)) * 4;
            expect(result.rgba[eastIdx + 0]).toBe(0);
            expect(result.rgba[eastIdx + 1]).toBe(255);
            expect(result.rgba[eastIdx + 2]).toBe(0);

            // At x = W/4 (theta = -PI/2): pointing West (heading 270°) -> Should be YELLOW
            const westIdx = (Math.floor(H / 2) * W + Math.floor(W / 4)) * 4;
            expect(result.rgba[westIdx + 0]).toBe(255);
            expect(result.rgba[westIdx + 1]).toBe(255);
            expect(result.rgba[westIdx + 2]).toBe(0);

            // At x = 0 (theta = -PI): pointing South (heading 180°) -> Should be BLUE
            const southIdx = (Math.floor(H / 2) * W + 0) * 4;
            expect(result.rgba[southIdx + 0]).toBe(0);
            expect(result.rgba[southIdx + 1]).toBe(0);
            expect(result.rgba[southIdx + 2]).toBe(255);
        });

        it('fills polar regions with green chroma key by default for outpainting', () => {
            const S = 32;
            const faces = {
                North: createSolidFace(S, S, 100, 100, 100),
                East: createSolidFace(S, S, 100, 100, 100),
                South: createSolidFace(S, S, 100, 100, 100),
                West: createSolidFace(S, S, 100, 100, 100)
            };

            const W = 64;
            const H = 32;
            const result = projectCubicFacesToErpBuffer(faces, {
                canvasWidth: W,
                canvasHeight: H,
                fovDegrees: 90,
                fillMode: 'green'
            });

            // Very top pixel (zenith y = 0) is beyond 90° FOV of cardinal faces -> should be chroma green [0, 255, 0]
            const zenithIdx = 0;
            expect(result.rgba[zenithIdx + 0]).toBe(0);
            expect(result.rgba[zenithIdx + 1]).toBe(255);
            expect(result.rgba[zenithIdx + 2]).toBe(0);
        });
    });

    describe('fetchStreetViewPanoMetadata', () => {
        it('queries Street View metadata and returns historical panos timeline', async () => {
            const fakeMeta = {
                status: 'OK',
                pano_id: 'CAoSLEFGMVFpcE5jN29tX2ZkZjh5N1Z3T21oX1pYVE9qZzEycFVRV19ocGlZMEFR',
                location: { lat: 35.6595, lng: 139.7005 },
                date: '2024-06',
                copyright: '© 2026 Google',
                historical_panos: [
                    { pano_id: 'pano_2018', date: '2018-04' },
                    { pano_id: 'pano_2021', date: '2021-09' }
                ]
            };

            const fakeFetch = vi.fn(async (url: string) => {
                expect(url).toContain('maps.googleapis.com/maps/api/streetview/metadata');
                expect(url).toContain('source=outdoor');
                return {
                    ok: true,
                    status: 200,
                    json: async () => fakeMeta
                } as any;
            });

            const res = await fetchStreetViewPanoMetadata({
                panoId: fakeMeta.pano_id,
                apiKey: 'test_api_key',
                fetchImpl: fakeFetch
            });

            expect(res.panoId).toBe(fakeMeta.pano_id);
            expect(res.lat).toBe(35.6595);
            expect(res.lng).toBe(139.7005);
            expect(res.year).toBe(2024);
            expect(res.month).toBe(6);
            expect(res.historicalPanos?.length).toBe(3); // 1 primary + 2 historical
            expect(res.historicalPanos?.[1]?.panoId).toBe('pano_2018');
        });
    });

    describe('fetchStreetViewCubicFaces', () => {
        it('fetches 4 cardinal perspective faces matching spce facesConfig', async () => {
            const faceUrls: string[] = [];
            const fakeFetch = vi.fn(async (url: string) => {
                if (url.includes('/metadata')) {
                    return {
                        ok: true,
                        json: async () => ({
                            status: 'OK',
                            pano_id: 'CAoS_TEST_PANO_ID',
                            location: { lat: 40.758, lng: -73.9855 },
                            date: '2023-10'
                        })
                    } as any;
                }
                faceUrls.push(url);
                const rawFace = createSolidFace(32, 32, 120, 140, 160);
                return {
                    ok: true,
                    arrayBuffer: async () => rawFace.rgba.buffer
                } as any;
            });

            const { metadata, faces } = await fetchStreetViewCubicFaces({
                panoId: 'CAoS_TEST_PANO_ID',
                apiKey: 'test_key',
                faceSize: 512,
                fovDegrees: 100,
                fetchImpl: fakeFetch
            });

            expect(metadata.panoId).toBe('CAoS_TEST_PANO_ID');
            expect(faces.North).toBeDefined();
            expect(faces.East).toBeDefined();
            expect(faces.South).toBeDefined();
            expect(faces.West).toBeDefined();
            expect(faceUrls.length).toBe(4);
            expect(faceUrls.some(u => u.includes('heading=0'))).toBe(true);
            expect(faceUrls.some(u => u.includes('heading=90'))).toBe(true);
            expect(faceUrls.some(u => u.includes('heading=180'))).toBe(true);
            expect(faceUrls.some(u => u.includes('heading=270'))).toBe(true);
            expect(faceUrls.every(u => u.includes('fov=100'))).toBe(true);
        });
    });

    describe('unprojectCubicFacesToPointCloud (spce 3D splat unprojector)', () => {
        it('generates 3D points and 32-byte Gaussian splat buffer from faces', () => {
            const S = 32;
            const faces = {
                North: createSolidFace(S, S, 200, 100, 50),
                East: createSolidFace(S, S, 50, 200, 100),
                South: createSolidFace(S, S, 100, 50, 200),
                West: createSolidFace(S, S, 200, 200, 50)
            };

            const cloud = unprojectCubicFacesToPointCloud(faces, {
                cameraHeightMeters: 2.5,
                stepPixels: 8
            });

            expect(cloud.count).toBeGreaterThan(0);
            expect(cloud.positions.length).toBe(cloud.count * 3);
            expect(cloud.colors.length).toBe(cloud.count * 3);
            expect(cloud.splatBuffer).toBeDefined();
            expect(cloud.splatBuffer!.byteLength).toBe(cloud.count * 32);
        });
    });
});
