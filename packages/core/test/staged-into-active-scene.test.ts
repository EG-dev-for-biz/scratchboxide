/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Staging the surroundings into a scene that holds a structure rebuild (the survey's "Washington Square Arch, then add
 * the surroundings"): the rebuild and its textured twins stay, moved into the district's frame; the district's own scan
 * of the structure is taken out where the rebuild stands; the earlier location layers are replaced; and the result says
 * exactly which layers were kept and which removed. No network: the synthetic world and stand-in stages of the
 * orchestrator tests.
 */

import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runStagedLocation, type StagedLocationDeps } from '../src/node/3d-engine/staged-location/orchestrator';
import { StageCache } from '../src/node/3d-engine/staged-location/stage-cache';
import { composeStagedArtifact, stagedCamera } from '../src/node/3d-engine/staged-location/staged-artifact';
import { anchorOffset, hideFootprintInGlb, partitionActiveScene, structureFootprint } from '../src/node/3d-engine/staged-location/kept-structure';
import { validateContract, type StagedLayer } from '../src/common/spatial/staged-location-contracts';
import type { CanvasArtifact } from '../src/browser/generative-canvas/canvas-types';
import { building, fakeNative, groundGrid, readTris, writeTris, type WorldSpec } from './helpers/staged-synthetic-world';
import { readGlbTriangles, renderClayPng } from './helpers/clay-glb-render';
import { STAGED_SCREENSHOT_DIR } from './helpers/staged-real-data';
import { stagedBuildState } from './helpers/staged-location-fixtures';

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-staged-into-')));
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));
const SHOTS = path.join(STAGED_SCREENSHOT_DIR, '..', 'staging_honesty');

/** The district around the arch: ground, the arch as the scan has it (26 x 11 m, 22 m tall), a building further off. */
const DISTRICT: WorldSpec = { ground: 80, buildings: [[-13, 13, -6, 5, 22], [30, 44, 30, 40, 9]], trees: [{ x: -20, z: -20, r: 4, h: 7, id: 3 }] };

function layer(objectId: string, layerName: string, url: string, extra: Partial<StagedLayer> = {}): StagedLayer {
    return {
        objectId, stage: 'fit', layer: layerName, order: 4, url, bytes: 100,
        provenance: { label: 'fitted', measuredGeometry: true, method: 'scan_fit', sources: [] }, provenanceLabels: ['fitted'],
        supersedes: [], revealAfter: [], reveal: { durationMs: 900, stagger: 1, crossfadeFrom: [] }, cached: false, builtAtMs: 0,
        counts: { vertices: 8, triangles: 12 }, ...extra
    } as StagedLayer;
}

/** The scene an isolated build of the arch leaves: its rebuild (fitted body, textured), its own tiles and remesh, its anchor 1 m above the district's. */
function archScene(modelsDir: string): CanvasArtifact {
    fs.mkdirSync(modelsDir, { recursive: true });
    // the rebuild sits 1 m lower in its own frame than the scan does in the district's (its frame's ground is 1 m higher)
    writeTris(path.join(modelsDir, 'arch_l3b.glb'), building(-13, 13, -6, 5, 22).map(t => t.map((v, i) => (i % 3 === 1 ? v - 1 : v))) as never);
    const obj = (id: string, url: string, source: string, extra: Record<string, unknown> = {}) => ({
        id, content: { type: '3d-model', durableUri: url, mimeType: 'model/gltf-binary', metadata: { source, role: 'environment', ...extra } },
        space: { spatial3d: { x: 0, y: 0, z: 0 } }
    });
    const l3b = layer('stg-11111111-l3b', 'l3b', '/models/arch_l3b.glb', {
        supersedes: ['stg-22222222-l2'], revealAfter: ['stg-22222222-l2'], reveal: { durationMs: 900, stagger: 1, crossfadeFrom: ['stg-22222222-l2'] },
        textured: { url: '/models/arch_l3b_tex.glb', bytes: 10, ladderRung: 1, rungShares: [0, 1, 0, 0, 0, 0], provenance: [], confidenceChannels: 'x', builtAtMs: 0, cached: false }
    });
    const l2 = layer('stg-22222222-l2', 'l2', '/models/arch_l2.glb', { stage: 'remesh' });
    const state = { ...stagedBuildState(), runId: '498c306f', artifactId: 'scene-stg-498c306f', layers: [l2, l3b], materialMode: 'textured' };
    return {
        id: 'scene-stg-498c306f', type: '3d-scene', title: 'Washington Square Arch', version: 7,
        data: {
            geoAnchor: { lat: 40.73122, lng: -73.99709, elevation: 10.2 },
            stagedBuild: state,
            objects: [
                obj('stg-22222222-l2', '/models/arch_l2.glb', 'Google3DTilesClay', { isGround: true }),
                obj('stg-11111111-l3b', '/models/arch_l3b.glb', 'scan_fit'),
                obj('my-statue', '/models/statue.glb', 'object-build', { role: 'hero' })
            ]
        }
    } as unknown as CanvasArtifact;
}

describe('staging into a scene that holds a structure rebuild', () => {
    it('keeps the rebuild (with its textured twin and mode), moves it into the new frame, and replaces only the location layers', () => {
        const active = archScene(path.join(TMP, 'compose', 'public', 'models'));
        const carried = partitionActiveScene(active);
        expect(carried.structure.map(o => o.id)).toEqual(['stg-11111111-l3b']);
        expect(carried.removed.map(r => r.objectId)).toEqual(['stg-22222222-l2']);
        expect(carried.other.map(o => o.id)).toEqual(['my-statue']);
        // what it superseded is gone, so it shows at once and points at nothing outside the kept set
        expect(carried.structureLayers[0]).toMatchObject({ supersedes: [], revealAfter: [], reveal: { durationMs: 0, crossfadeFrom: [] }, keptFrom: { runId: '498c306f' } });

        const state = { ...stagedBuildState(), artifactId: 'scene-stg-498c306f' };
        const camera = stagedCamera({ min: [-60, -2, -60], max: [60, 30, 60] }, [0, 0, 0], 60);
        const meta = Object.fromEntries(state.layers.map(l => [l.objectId, { source: 'Google3DTilesClay', resolvedAddress: 'x' }]));
        const art = composeStagedArtifact({ state, camera, layerMeta: meta, geoAnchor: { lat: 40.73122, lng: -73.99709, elevation: 9.2 }, activeScene: active, summary: 's', version: 8 }) as any;
        const ids = art.data.objects.map((o: any) => o.id);
        expect(ids).toContain('stg-11111111-l3b');
        expect(ids).toContain('my-statue');
        expect(ids).not.toContain('stg-22222222-l2');
        // moved up by the anchors' height difference (10.2 - 9.2 m)
        expect(art.data.objects.find((o: any) => o.id === 'stg-11111111-l3b').space.spatial3d.y).toBeCloseTo(1, 6);
        // its layer record (and so its textured twin) is in the new state, and the scene stays textured
        const kept = art.data.stagedBuild.layers.find((l: StagedLayer) => l.objectId === 'stg-11111111-l3b');
        expect(kept.textured.url).toBe('/models/arch_l3b_tex.glb');
        expect(art.data.stagedBuild.materialMode).toBe('textured');
        expect(validateContract('StagedBuildState', art.data.stagedBuild)).toEqual([]);
        // a rebuild at the same place replaces it
        expect(partitionActiveScene(active, { lat: 40.73122, lng: -73.99709 }).structure).toEqual([]);
        expect(anchorOffset({ lat: 40.73122, lng: -73.99709, elevation: 10.2 }, { lat: 40.73122, lng: -73.99709, elevation: 9.2 })).toEqual([0, 1, 0]);
    });

    it('takes the district\'s own scan of the structure out where the rebuild stands, and keeps the ground under it', () => {
        const dir = path.join(TMP, 'carve');
        fs.mkdirSync(dir, { recursive: true });
        const hero = writeTris(path.join(dir, 'hero.glb'), building(-13, 13, -6, 5, 22));
        const district = writeTris(path.join(dir, 'district.glb'), [...groundGrid(40), ...building(-13, 13, -6, 5, 22), ...building(20, 30, 20, 30, 9)]);
        const fp = structureFootprint([fs.readFileSync(hero)], [0, 0, 0]);
        const out = hideFootprintInGlb(fs.readFileSync(district), fp);
        const before = readTris(district), after = readGlbTriangles(out.glb);
        expect(out.removedTriangles).toBe(building(-13, 13, -6, 5, 22).length);
        expect(after.indices.length / 3).toBe(before.length - out.removedTriangles);
        // the ground inside the footprint and the other building stay
        const inFoot = (x: number, z: number) => x > -13.5 && x < 13.5 && z > -6.5 && z < 5.5;
        let groundInside = 0, raisedInside = 0;
        for (let t = 0; t < after.indices.length; t += 3) {
            const c = [0, 1, 2].map(k => [0, 1, 2].reduce((s, j) => s + after.positions[after.indices[t + j] * 3 + k], 0) / 3);
            if (inFoot(c[0], c[2])) { if (c[1] < 0.01) groundInside++; else raisedInside++; }
        }
        expect(groundInside).toBeGreaterThan(0);
        expect(raisedInside).toBe(0);
    });

    it('a district staged into the arch scene keeps the arch, cuts its scan, and the result and summary say what was kept and removed', async () => {
        const root = path.join(TMP, 'run');
        const native = fakeNative(path.join(root, 'native'), DISTRICT);
        const cache = new StageCache({ workspaceRoot: root });
        const deps: StagedLocationDeps = {
            cache, geocode: async q => ({ lat: 40.73122, lng: -73.99709, formattedAddress: `${q}, New York, NY` }),
            extract: native.deps.extract, vegetation: native.deps.vegetation, refine: native.deps.refine,
            newRunId: () => '5fcf417f', sleep: async () => undefined
        };
        const active = archScene(path.join(root, 'public', 'models'));
        const { result } = await runStagedLocation({ query: 'Washington Square Arch', isolate: false, radiusM: 60, trees: true, stageIntoActiveScene: true }, deps, { activeArtifact: active });
        expect(validateContract('StagedLocationResult', result)).toEqual([]);
        const art = result.artifact as any;
        expect(art.id).toBe('scene-stg-498c306f');
        const ids = art.data.objects.map((o: any) => o.id);
        expect(ids).toContain('stg-11111111-l3b');
        expect(ids).toContain('my-statue');
        expect(ids).not.toContain('stg-22222222-l2');
        expect(art.data.stagedBuild.materialMode).toBe('textured');

        // the report, by id
        expect(result.activeScene).toMatchObject({
            artifactId: 'scene-stg-498c306f', keptFromRunId: '498c306f', otherObjectsKept: 1, materialMode: 'textured', offsetM: [0, 1, 0],
            kept: [{ objectId: 'stg-11111111-l3b', layer: 'l3b', source: 'scan_fit', textured: true }],
            removed: [{ objectId: 'stg-22222222-l2', source: 'google3dtilesclay' }]
        });
        const hidden = result.activeScene!.footprintHidden!;
        expect(hidden.layers.length).toBeGreaterThan(0);
        expect(hidden.layers.every(l => l.removedTriangles > 0)).toBe(true);
        expect(result.summary).toMatch(/^Staged into the active scene: KEPT the earlier structure rebuild of run 498c306f \(1 layer: l3b; 1 of them has real textures, shown textured\)/);
        expect(result.summary).toContain('REMOVED the 1 earlier location layer (stg-22222222-l2)');

        // the published district remesh has no raised triangle inside the arch's footprint; the ground there stays
        const l2 = art.data.stagedBuild.layers.find((l: StagedLayer) => l.layer === 'l2' && !l.keptFrom);
        expect(l2.url).toMatch(/_around_[0-9a-f]{8}\.glb$/);
        expect(l2.provenance.note).toMatch(/triangles inside the kept structure's footprint/);
        const remesh = readGlbTriangles(fs.readFileSync(path.join(root, 'public', 'models', path.basename(l2.url))));
        let raised = 0;
        for (let t = 0; t < remesh.indices.length; t += 3) {
            const c = [0, 1, 2].map(k => [0, 1, 2].reduce((s, j) => s + remesh.positions[remesh.indices[t + j] * 3 + k], 0) / 3);
            if (c[0] > -12.5 && c[0] < 12.5 && c[2] > -5.5 && c[2] < 4.5 && c[1] > 1.5) raised++;
        }
        expect(raised).toBe(0);

        // screenshot: the district (clay) with the kept arch (orange) standing in the gap its scan left
        const arch = readGlbTriangles(fs.readFileSync(path.join(root, 'public', 'models', 'arch_l3b.glb')));
        const lifted = Float32Array.from(arch.positions, (v, i) => (i % 3 === 1 ? v + 1 : v));
        fs.mkdirSync(SHOTS, { recursive: true });
        fs.writeFileSync(path.join(SHOTS, 'unit_district_around_kept_arch.png'), renderClayPng([
            { positions: remesh.positions, indices: remesh.indices },
            { positions: lifted, indices: arch.indices, color: [0.9, 0.55, 0.15] }
        ], { kind: 'aerial', width: 900, height: 600, region: [-40, -40, 40, 40], bearingDeg: 200, elevationDeg: 35 }));
    });
});
