import { afterEach, describe, expect, it, vi } from 'vitest';
import { panoramaHandlers } from '../src/node/gemini/tools/spatial-tools';
import { Location3DGaussianSplatService } from '../src/node/spatial/Location3DGaussianSplatService';

/**
 * location_generate_3dgs hands the street vantage and refresh to the world build. They once landed in the tool's result
 * payload instead, so a vantage asked for in the chat built a world with no Street View station at all (2026-11-09).
 */
describe('location_generate_3dgs passes the vantage and refresh to the build', () => {
    afterEach(() => vi.restoreAllMocks());

    it('gives generate() the vantage, its Street View services and refresh', async () => {
        const seen: any[] = [];
        vi.spyOn(Location3DGaussianSplatService.prototype, 'generate').mockImplementation(async (req: any) => {
            seen.push(req);
            return { success: true, locationName: 'x', geoAnchor: { lat: 0, lng: 0 }, splatUrl: '', splatPath: '', splatCount: 0, stationCount: 0, acceptedStations: 0, glbPath: '', durationMs: 0, modelsUsed: [], imageSources: [], scene3DData: {} } as any;
        });
        await panoramaHandlers.location_generate_3dgs({ location: '7th Avenue and West 32nd Street, New York', vantageSideDeg: 270, vantageHeadingDeg: 90, refresh: true }, { workspaceRoot: process.cwd() } as any);
        expect(seen).toHaveLength(1);
        expect(seen[0].vantage).toEqual({ headingDeg: 90, sideDeg: 270 });
        expect(seen[0].streetView).toBeDefined();
        expect(seen[0].refresh).toBe(true);
    });

    it('asks for no vantage when none is given', async () => {
        const seen: any[] = [];
        vi.spyOn(Location3DGaussianSplatService.prototype, 'generate').mockImplementation(async (req: any) => { seen.push(req); return { success: true, locationName: 'x', geoAnchor: { lat: 0, lng: 0 }, splatCount: 0, stationCount: 0, acceptedStations: 0, durationMs: 0, imageSources: [], modelsUsed: [], scene3DData: {} } as any; });
        await panoramaHandlers.location_generate_3dgs({ location: 'somewhere' }, { workspaceRoot: process.cwd() } as any);
        expect(seen[0].vantage).toBeUndefined();
        expect(seen[0].refresh).toBeUndefined();
    });
});
