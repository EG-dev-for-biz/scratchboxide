import { describe, it, expect } from 'vitest';
import { detectRealWorldLocationIntent } from '../src/browser/generative-canvas/services/Google3DTileService';

// A false coordinate match launches the Google 3D Tiles pipeline for a spot in the ocean, which
// stalled execute_3d_python_script calls for minutes.
describe('detectRealWorldLocationIntent coordinate parsing', () => {
    it.each([
        'High-density procedural wooden four-legged stool with turned baluster legs and ergonomic saddle seat exceeding 10,000 vertices',
        'High-density procedural 3D ceramic amphora vase with 32-lobe harmonic fluting (15,000+ vertices) in 18% Studio Grey Clay',
        'Lunar rover in clay, color [0.55, 0.57, 0.60], roughness 0.85',
        'A stool 1.5 2.0 meters tall with 4 legs, 2 stretchers'
    ])('ignores numbers that are not coordinates: %s', description => {
        const hit = detectRealWorldLocationIntent(description);
        expect(hit?.elevationSource).not.toBe('explicit_coordinates');
    });

    it.each([
        ['3D scene at 40.7644, -73.9744', 40.7644, -73.9744],
        ['build 3d formula 1 car around [43.7384, 7.4246] in clay', 43.7384, 7.4246],
        ['stage it at lat: 40.7308, lng: -73.9973', 40.7308, -73.9973],
        ['latitude 48 longitude 2', 48, 2]
    ])('still reads real coordinates: %s', (prompt, lat, lng) => {
        const hit = detectRealWorldLocationIntent(prompt);
        expect(hit?.elevationSource).toBe('explicit_coordinates');
        expect(hit?.lat).toBeCloseTo(lat);
        expect(hit?.lng).toBeCloseTo(lng);
    });
});
