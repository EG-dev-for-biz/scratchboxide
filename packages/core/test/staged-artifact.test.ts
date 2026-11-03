/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The staged scene artifact: its id survives the end-of-turn commit (no remount), its camera is fixed for the run and
 * kept by the viewport's own framing on every layer attach, layers map to objects[] one to one, and superseded large
 * layers are retired at finish (never the ground).
 */

import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    composeStagedArtifact, glbBounds, layerObjectId, retireSupersededLayers, stagedArtifactId, stagedCamera, RETIRE_SUPERSEDED_BYTES
} from '../src/node/3d-engine/staged-location/staged-artifact';
import { writeStagedGlbFile } from '../src/node/3d-engine/staged-location/staged-glb-writer';
import { LOCATION_SCENE_WEATHER, normalizeWeather, weatherSun } from '../src/browser/generative-canvas/services/atmosphere/scene-weather';
import { resolveCanvasArtifactId, registerCanvasArtifact } from '../src/browser/generative-canvas/project-artifact-adapter';
import { calculateStandoffCamera } from '../src/browser/generative-canvas/primitives/scene3d/autoFraming';
import { ProjectArtifactGraphEngine, createEmptyProjectGraph } from '../src/common/project-artifact-graph-protocol';
import { validateContract } from '../src/common/spatial/staged-location-contracts';
import { layers, stagedBuildState } from './helpers/staged-location-fixtures';

const actor = { id: 'user-test', displayName: 'Test', kind: 'user' as const };

function bounds(min: [number, number, number], max: [number, number, number]) {
    const box = new THREE.Box3(new THREE.Vector3(...min), new THREE.Vector3(...max));
    const sphere = new THREE.Sphere();
    box.getBoundingSphere(sphere);
    return { box, sphere, hasGeometry: true };
}

describe('staged artifact', () => {
    it('keeps its id through resolveCanvasArtifactId and registerCanvasArtifact for any run id', () => {
        const graph = createEmptyProjectGraph('project-test', { grants: [{ capability: 'artifact.write', effect: 'allow' }, { capability: 'artifact.link', effect: 'allow' }] });
        const engine = new ProjectArtifactGraphEngine(graph);
        for (let i = 0; i < 300; i++) {
            const runId = (Math.floor(Math.random() * 0xffffffff) >>> 0).toString(16).padStart(8, '0');
            const id = stagedArtifactId(runId);
            expect(id).not.toMatch(/\d{10,}$/);
            expect(resolveCanvasArtifactId('project-test', { id, type: '3d-scene', title: 't', data: {}, version: 1 } as any)).toBe(id);
        }
        // the all-digit run id is the worst case: 8 digits after "scene-stg-"
        expect(stagedArtifactId('12345678')).toBe('scene-stg-12345678');
        const registered = registerCanvasArtifact(engine, { id: 'scene-stg-12345678', type: '3d-scene', title: 'Arch', data: { objects: [] }, version: 1 } as any, actor, 'c1');
        expect(registered.id).toBe('scene-stg-12345678');
        // staging into a scene keeps its id, unless the commit would re-key it anyway
        expect(stagedArtifactId('a1b2c3d4', 'scene-arch-1')).toBe('scene-arch-1');
        expect(stagedArtifactId('a1b2c3d4', 'artifact-3d-1760540000000')).toBe('artifact-3d-1760540000000-s');
        expect(resolveCanvasArtifactId('p', { id: 'artifact-3d-1760540000000-s', type: '3d-scene', title: 't', data: {}, version: 1 } as any)).toBe('artifact-3d-1760540000000-s');
        expect(() => stagedArtifactId('nothex!!')).toThrow(/8 hex/);
    });

    it('fixes a camera outside L1 that the viewport keeps on every later attach, for an isolated structure and a district', () => {
        // the arch probe: L1 52 x 30 x 52 m; the structure 26 x 24 x 11 m around the footprint centroid
        const archL1 = { min: [-26, -2, -26] as [number, number, number], max: [26, 28, 26] as [number, number, number] };
        const arch = stagedCamera(archL1, [0.4, 12, -1.2], Math.hypot(13, 12, 5.5));
        // Central Park r250: L1 520 x 80 x 520 m around the anchor on the ground
        const cpL1 = { min: [-260, -15, -260] as [number, number, number], max: [260, 65, 260] as [number, number, number] };
        const cp = stagedCamera(cpL1, [0, 0, 0], 250);
        for (const [cam, l1] of [[arch, archL1], [cp, cpL1]] as const) {
            const later = [l1, { min: [l1.min[0] / 2, l1.min[1], l1.min[2] / 2], max: [l1.max[0] / 2, l1.max[1], l1.max[2] / 2] }, { min: [-5, 0, -5], max: [5, 20, 5] }];
            for (const b of later) {
                const framed = calculateStandoffCamera(bounds(b.min as any, b.max as any), cam);
                expect(framed?.autoFramed).toBe(false);
                expect(framed?.position).toEqual(cam.position);
                expect(framed?.target).toEqual(cam.target);
            }
            expect(cam.position.every((v, k) => v >= l1.min[k] && v <= l1.max[k])).toBe(false);
        }
        // identical inputs give the identical camera (it is computed once per run, and never re-computed differently)
        expect(stagedCamera(archL1, [0.4, 12, -1.2], Math.hypot(13, 12, 5.5))).toEqual(arch);
    });

    it('composes one object per unretired layer, with the state, the camera and the place\'s partly cloudy, low-sun sky', () => {
        const state = stagedBuildState();
        const camera = stagedCamera({ min: [-26, -2, -26], max: [26, 28, 26] }, [0, 12, 0], 20);
        const meta = Object.fromEntries(state.layers.map(l => [l.objectId, { source: l.stage === 'trees' ? 'Google3DTilesClay' : 'Google3DTilesClay', isGround: l.layer === 'l2', resolvedAddress: state.place.resolvedAddress }]));
        const art = composeStagedArtifact({ state, camera, layerMeta: meta, geoAnchor: { lat: state.place.lat, lng: state.place.lng }, summary: 'x', version: 3 }) as any;
        expect(art.id).toBe('scene-stg-a1b2c3d4');
        expect(art.data.objects.map((o: any) => o.id)).toEqual(state.layers.map(l => l.objectId));
        expect(art.data.objects.filter((o: any) => o.content.metadata.isGround).map((o: any) => o.id)).toEqual(['stg-90e96133-l2']);
        expect(art.data.objects.every((o: any) => o.content.metadata.role === 'environment')).toBe(true);
        // the sky of the run's day at the place (user decision 2026-11-02), the studio kept for the Weather tool's Off
        const day = new Date(Math.min(...state.stages.map(s => s.timings.startedAtMs), state.updatedAtMs)).toISOString().slice(0, 10);
        expect(art.data.weather).toMatchObject({ cloudCover: LOCATION_SCENE_WEATHER.cloudCover, date: day, prior: { skybox: 'studio' } });
        expect(art.data.environment).toMatchObject({ skybox: 'sky', lighting: 'studio', ground: false });
        const sun = weatherSun(normalizeWeather(art.data.weather), { lat: state.place.lat, lng: state.place.lng });
        expect(sun.source).toBe('ephemeris');
        expect(sun.elevationDeg).toBeCloseTo(LOCATION_SCENE_WEATHER.sunElevationDeg, 1);
        expect(art.data.weather.timeOfDay).toBeGreaterThan(12);
        expect(art.data.features.atmosphericScattering).toMatchObject({ enabled: true, cloudCoverage: LOCATION_SCENE_WEATHER.cloudCover, latitude: state.place.lat });
        // the same sky on every compose of the run
        expect(composeStagedArtifact({ state: { ...state, updatedAtMs: state.updatedAtMs + 3_600_000 }, camera, layerMeta: meta, geoAnchor: { lat: state.place.lat, lng: state.place.lng }, summary: 'x', version: 4 }).data).toMatchObject({ weather: art.data.weather });
        expect(art.data.renderMode).toBe('clay');
        expect(art.data.camera).toEqual(camera);
        expect(validateContract('StagedBuildState', art.data.stagedBuild)).toEqual([]);

        // into the active scene: its own objects stay, earlier location layers go
        const active = { id: 'scene-arch-1', type: '3d-scene', title: 'Mine', version: 4, data: { objects: [
            { id: 'statue', content: { metadata: { source: 'object-build' } } },
            { id: 'old-tiles', content: { metadata: { source: 'Google3DTilesClay', role: 'environment' } } }
        ] } } as any;
        const merged = composeStagedArtifact({ state: { ...state, artifactId: 'scene-arch-1' }, camera, layerMeta: meta, geoAnchor: { lat: 0, lng: 0 }, activeScene: active, summary: 'x', version: 5 }) as any;
        expect(merged.id).toBe('scene-arch-1');
        expect(merged.data.objects.map((o: any) => o.id)).toEqual(['statue', ...state.layers.map(l => l.objectId)]);
        // staged into an open scene, that scene's own sky is kept
        expect(merged.data.weather).toBeUndefined();
    });

    it('retires superseded layers over 8 MB at finish, never the ground', () => {
        const ls = layers();
        ls[0] = { ...ls[0], bytes: RETIRE_SUPERSEDED_BYTES + 1 };                   // L1, superseded by L2
        ls[1] = { ...ls[1], bytes: RETIRE_SUPERSEDED_BYTES + 1 };                   // L2, superseded by nothing here
        const withL3 = ls.map(l => (l.layer === 'l3b' ? { ...l, supersedes: ['stg-90e96133-l2'] } : l));
        const retired = retireSupersededLayers(withL3, new Set(['stg-90e96133-l2']));
        expect(retired.filter(l => l.retired).map(l => l.objectId)).toEqual(['stg-5d6c8812-l1']);
        expect(layerObjectId('5d6c8812ffffffff', 'l1')).toBe('stg-5d6c8812-l1');
    });

    it('reads a GLB\'s bounds from its accessors', () => {
        const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-bounds-')), 'b.glb');
        writeStagedGlbFile(file, [{ positions: Float32Array.from([-3, 0, 2, 5, 1, -4, 0, 9, 0]) }]);
        expect(glbBounds(file)).toEqual({ min: [-3, 0, -4], max: [5, 9, 2] });
    });
});
