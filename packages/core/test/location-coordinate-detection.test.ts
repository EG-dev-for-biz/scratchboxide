import { describe, it, expect } from 'vitest';
import { assertUsableCoordinates, parseCoordinateText } from '../src/common/coordinate/parse-coordinates';
import { LocationUnresolvedError } from '../src/common/errors/pipeline-errors';

// Only text that is entirely a coordinate pair is read as coordinates. A substring match once turned
// "Pier 39, 2 Beach St, San Francisco" into (39, 2) and sent tile extraction to the ocean; prompts are
// never scanned for coordinates or place names at all (the model passes locations to the tools).
describe('whole-input coordinate parsing', () => {
    it.each([
        'High-density procedural wooden four-legged stool with turned baluster legs and ergonomic saddle seat exceeding 10,000 vertices',
        'Lunar rover in clay, color [0.55, 0.57, 0.60], roughness 0.85',
        'A stool 1.5 2.0 meters tall with 4 legs, 2 stretchers',
        '3D scene at 40.7644, -73.9744',
        'Pier 39, 2 Beach St, San Francisco',
        'Building 10, 5 Main St, Cambridge',
        'Midtown Manhattan, coordinates: 40.748400, -73.985700',
        'gondola in venice'
    ])('is not a coordinate: %s', text => {
        expect(parseCoordinateText(text)).toBeUndefined();
    });

    it.each([
        ['40.7644, -73.9744', 40.7644, -73.9744, undefined],
        ['[43.7384, 7.4246]', 43.7384, 7.4246, undefined],
        ['lat: 40.7308, lng: -73.9973', 40.7308, -73.9973, undefined],
        ['48.8584° N, 2.2945° E', 48.8584, 2.2945, undefined],
        ['33.8568° S, 151.2153° E', -33.8568, 151.2153, undefined],
        ['40.7411 -73.9897', 40.7411, -73.9897, undefined],
        ['40.764632, -73.974325, 18.66', 40.764632, -73.974325, 18.66]
    ])('reads %s', (text, lat, lng, elevation) => {
        const hit = parseCoordinateText(text);
        expect(hit?.lat).toBeCloseTo(lat as number, 6);
        expect(hit?.lng).toBeCloseTo(lng as number, 6);
        expect(hit?.elevation).toBe(elevation);
    });

    it('rejects (0, 0) and out-of-range values with LocationUnresolvedError', () => {
        expect(() => assertUsableCoordinates(0, 0, '0, 0')).toThrow(LocationUnresolvedError);
        expect(() => assertUsableCoordinates(95, 10, '95, 10')).toThrow(/outside the valid range/);
        expect(() => assertUsableCoordinates(10, -195, '10, -195')).toThrow(/outside the valid range/);
        expect(() => assertUsableCoordinates(NaN, 10, 'NaN, 10')).toThrow(/finite/);
        expect(() => assertUsableCoordinates(40.7411, -73.9897, 'ok')).not.toThrow();
    });
});
