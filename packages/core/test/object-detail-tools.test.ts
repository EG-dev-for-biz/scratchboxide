/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * object_detail_pass on an open object scene (object-detail-tools.ts), with a private asset store and models folder:
 * - the scene is updated in place to draw the new version: the object's file, the generator's file name and inline
 *   copy (so the viewport draws it once, live and after a reload), data.objectBuild.detailPass;
 * - versions are kept in the scene object store: the object as built is version 1 (its engine-rounded POSITION bounds,
 *   which the store's check refuses, measured from the data), each new recipe a new version, the same recipe the
 *   version it already made, and restoreVersion shows version 1 again;
 * - decals are added to the recipe and wear is not baked twice;
 * - scanned or measured objects and scenes without a generated object are refused with the reason.
 */

import { afterAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DurableAssetStore } from '../src/node/asset-store/durable-asset-store';
import { SceneObjectStore } from '../src/node/asset-store/scene-object-store';
import { OBJECT_BUILD_SOURCE } from '../src/common/spatial/object-build-spec';
import { createObjectDetailHandlers, OBJECT_DETAIL_TOOL } from '../src/node/gemini/tools/object-detail-tools';
import { createDefaultToolRegistry } from '../src/node/gemini/tool-registry';
import { assembleGlb, parseGlbBytes } from '../src/node/3d-engine/staged-location/glb-bytes';
import { checkGlbBytes } from '../src/node/3d-engine/staged-location/glb-integrity';
import { exactPositionBounds } from '../src/node/3d-engine/object-detail-pass';
import type { ToolContext } from '../src/node/gemini/tools/types';
import { buildFixtureGlb } from './helpers/uv-rewrap-fixtures';
import { encodePng } from '../src/node/texture-processing';

const TIMEOUT = 900_000;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'object-detail-tools-'));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

function box(name: string, size: [number, number, number], center: [number, number, number], material: number) {
    const faces = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
    const positions: number[] = [], normals: number[] = [], indices: number[] = [];
    for (const n of faces) {
        const a = n.findIndex(v => v !== 0), [b, c] = [0, 1, 2].filter(k => k !== a);
        const base = positions.length / 3;
        for (const [su, sv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
            const p = [0, 0, 0];
            p[a] = n[a]; p[b] = su; p[c] = sv;
            positions.push(...p.map((v, k) => center[k] + v * size[k] / 2));
            normals.push(...n);
        }
        // wound outwards
        const flip = n[a] * ((a === 0 ? 1 : a === 1 ? -1 : 1)) < 0;
        indices.push(...(flip ? [base, base + 2, base + 1, base, base + 3, base + 2] : [base, base + 1, base + 2, base, base + 2, base + 3]));
    }
    return { positions, normals, indices, material, name };
}

/** The engine's GLB writer rounds POSITION min/max to six significant digits; the store's check refuses that. */
function engineRounded(glb: Buffer): Buffer {
    const g = parseGlbBytes(new Uint8Array(glb));
    for (const a of g.json.accessors) if (a.min) { a.min = a.min.map((x: number) => Number(x.toPrecision(6))); a.max = a.max.map((x: number) => Number(x.toPrecision(6))); }
    return assembleGlb(g.json, g.bin);
}

function objectScene(models: string, id = 'hero-1') {
    const glb = engineRounded(buildFixtureGlb({
        primitives: [box('body', [0.61234567, 0.61234567, 0.61234567], [0, 1.050724, 0], 0), box('base', [1, 0.1, 1], [0, 0.05, 0], 1)],
        materials: [
            { name: 'gold_foil', pbrMetallicRoughness: { baseColorFactor: [0.9, 0.55, 0.12, 1], roughnessFactor: 0.3, metallicFactor: 1 } },
            { name: 'white_paint', pbrMetallicRoughness: { baseColorFactor: [0.8, 0.8, 0.78, 1], roughnessFactor: 0.6, metallicFactor: 0 } }
        ]
    }));
    expect(checkGlbBytes(glb).ok).toBe(false);
    fs.mkdirSync(models, { recursive: true });
    fs.writeFileSync(path.join(models, 'object_1.glb'), glb);
    const hero = {
        id, content: { type: '3d-model', durableUri: '/models/object_1.glb', mimeType: 'model/gltf-binary', metadata: { role: 'hero', description: 'test lander', source: OBJECT_BUILD_SOURCE, originalPath: '/elsewhere/build/3d-python/object_1.glb', objectBuild: { spec: {} } } },
        space: { spatial3d: { x: 0, y: 0, z: 0 } }, lineage: { version: 1 }
    };
    return {
        glb,
        artifact: {
            id: 'artifact-3d-1', type: '3d-scene', title: 'test lander', summary: '', version: 1, createdAt: new Date().toISOString(),
            data: {
                title: 'test lander', objects: [hero], objectBuild: { objectId: id, spec: {} },
                pythonGenerator: { enabled: true, filename: 'object_spec_build.py', sourceCode: '# built', glbBase64: glb.toString('base64'), glbPath: '/elsewhere/build/3d-python/object_1.glb' }
            }
        } as any
    };
}

const ctxOf = (artifact: unknown) => ({ request: { activeArtifact: artifact }, workspaceRoot: root } as unknown as ToolContext);
const hero = (a: any) => a.data.objects.find((o: any) => o.content.metadata.role === 'hero');

describe('object_detail_pass on the open scene', () => {
    it('is registered', () => {
        expect(createDefaultToolRegistry().has(OBJECT_DETAIL_TOOL)).toBe(true);
    });

    it('mounts each new version in the open scene, keeps every version, and restores the object as built', async () => {
        const models = path.join(root, 'a', 'public', 'models');
        const store = new DurableAssetStore(path.join(root, 'a', 'home'));
        const tool = createObjectDetailHandlers({ publicModelsDir: models, assetStore: () => store, targetTexels: 256 * 256 })[OBJECT_DETAIL_TOOL];
        const { glb: built, artifact } = objectScene(models);

        const r1 = await tool({ weathering: { edgeWear: 0.8, grime: 0.5 } }, ctxOf(artifact));
        expect(r1.status).toBe('completed');
        const a1 = r1.resultPayload.artifact as any;
        expect(a1.id).toBe(artifact.id);
        expect(a1.version).toBe(2);
        const h1 = hero(a1);
        expect(h1.content.durableUri).toMatch(/^\/models\/objects\/object\/hero-1~[0-9a-f]{8}\/[0-9a-f]{16}\/[0-9a-f]{16}\.glb$/);
        const file1 = path.join(models, h1.content.durableUri.replace('/models/', ''));
        expect(fs.existsSync(file1)).toBe(true);
        expect(h1.content.metadata.originalPath).toBe(file1);
        // the viewport draws the generator's inline copy under the object's file name: both are this version
        expect(path.basename(a1.data.pythonGenerator.glbPath)).toBe(path.basename(h1.content.durableUri));
        expect(Buffer.from(a1.data.pythonGenerator.glbBase64, 'base64').equals(fs.readFileSync(file1))).toBe(true);
        const g1 = parseGlbBytes(new Uint8Array(fs.readFileSync(file1))).json;
        expect(g1.extras.sbDetailPass.label).toBe('generated');
        expect(g1.materials.map((m: any) => m.name)).toEqual(['gold_foil', 'white_paint']);
        expect(h1.content.metadata.detailPass.version).toBe(2);
        expect(h1.content.metadata.detailPass.versions.map((v: any) => v.version)).toEqual([1, 2]);
        expect(a1.data.objectBuild.detailPass.version).toBe(2);
        expect(r1.resultPayload.imageCalls).toBe(0);
        const objects = new SceneObjectStore(store);
        const key = h1.content.metadata.detailPass.objectKey;
        expect(objects.versions(key).map(v => v.version)).toEqual([1, 2]);
        expect(objects.current(key)!.version).toBe(2);
        // the store serves it at the same path
        expect(store.lookup(h1.content.durableUri)).toBeDefined();

        // a decal is added to the recipe; the wear is baked once, from the object as built
        const label = encodePng(16, 8, Buffer.from(new Uint8Array(16 * 8 * 4).map((_, i) => (i % 4 === 1 ? 0 : 255))));
        const r2 = await tool({ decals: [{ parts: ['body'], imageUrl: `data:image/png;base64,${label.toString('base64')}`, facing: [0, 0, 1], sizeM: [0.3, 0.15] }] }, ctxOf(a1));
        const a2 = r2.resultPayload.artifact as any;
        const dp2 = hero(a2).content.metadata.detailPass;
        expect(dp2.version).toBe(3);
        expect(dp2.recipe.wear).toEqual({ edgeWear: 0.8, grime: 0.5 });
        expect(dp2.recipe.decals).toHaveLength(1);
        expect(dp2.recipe.decals[0].label).toBe('photo-inferred');
        expect(r2.resultPayload.decals[0].texels).toBeGreaterThan(50);

        // the same recipe again: the kept version, nothing baked
        const r3 = await tool({}, ctxOf(a2));
        expect(r3.resultPayload.reusedVersion).toBe(true);
        expect(r3.resultPayload.version).toBe(3);
        expect(r3.resultPayload.timings).toBeUndefined();

        // version 1 is the object as built: the same bytes but for its POSITION bounds, measured from the data
        const r4 = await tool({ restoreVersion: 1 }, ctxOf(r3.resultPayload.artifact));
        const h4 = hero(r4.resultPayload.artifact as any);
        const v1 = fs.readFileSync(path.join(models, h4.content.durableUri.replace('/models/', '')));
        expect(v1.equals(exactPositionBounds(built))).toBe(true);
        expect(checkGlbBytes(v1).ok).toBe(true);
        expect(Buffer.from(parseGlbBytes(new Uint8Array(v1)).bin).equals(Buffer.from(parseGlbBytes(new Uint8Array(built)).bin))).toBe(true);
        expect(h4.content.metadata.detailPass.version).toBe(1);
        expect(objects.current(key)!.version).toBe(1);
        await expect(tool({ restoreVersion: 9 }, ctxOf(r4.resultPayload.artifact))).rejects.toThrow(/no version 9.*kept: 1, 2, 3/);
        store.close();
    }, TIMEOUT);

    it('keeps versions as files when there is no asset store', async () => {
        const models = path.join(root, 'b', 'public', 'models');
        const tool = createObjectDetailHandlers({ publicModelsDir: models, assetStore: () => undefined, targetTexels: 256 * 256 })[OBJECT_DETAIL_TOOL];
        const { artifact } = objectScene(models);
        const r = await tool({ weathering: { dust: 1, edgeWear: 0 } }, ctxOf(artifact));
        const h = hero(r.resultPayload.artifact as any);
        expect(h.content.metadata.detailPass.versions.map((v: any) => v.version)).toEqual([1, 2]);
        for (const v of h.content.metadata.detailPass.versions) expect(fs.existsSync(path.join(models, v.uri.replace('/models/', '')))).toBe(true);
    }, TIMEOUT);

    it('refuses scanned or measured content and scenes without a generated object', async () => {
        const models = path.join(root, 'c', 'public', 'models');
        const tool = createObjectDetailHandlers({ publicModelsDir: models, assetStore: () => undefined })[OBJECT_DETAIL_TOOL];
        await expect(tool({}, ctxOf(undefined))).rejects.toThrow(/no 3D scene is open/);
        const { artifact } = objectScene(models);
        const scanned = { ...artifact, data: { ...artifact.data, objects: [{ id: 'tiles-1', content: { type: '3d-model', durableUri: '/models/tiles_isolated.glb', metadata: { role: 'environment', layer: 'isolated-structure', source: 'google_3d_tiles_get_clay' } } }] } };
        await expect(tool({ objectId: 'tiles-1' }, ctxOf(scanned))).rejects.toThrow(/scanned or measured content/);
        await expect(tool({}, ctxOf(scanned))).rejects.toThrow(/no generated object/);
    });

    it('runs the material path as part of the object\'s recipe: alone on a clean object, after the wear on a weathered one, kept until changed', async () => {
        const models = path.join(root, 'm', 'public', 'models');
        const store = new DurableAssetStore(path.join(root, 'm', 'home'));
        const calls: number[] = [];
        // the path itself is tested in object-material-path.test.ts: here, where it runs and what it is given
        const objectMaterials = (async (glb: Buffer | Uint8Array) => {
            calls.push(parseGlbBytes(new Uint8Array(glb)).json.materials.filter((m: any) => m.extras?.sbDetailPass).length);
            return { glb: Buffer.from(glb), report: { version: 'object-material-path/1', label: 'generated', objectSizeM: [1, 1, 1], texelM: 0.01, tile: { wantM: 1, maxM: 4 }, heightCapM: 0.01, classes: [], materials: [], ms: 1 } };
        }) as never;
        const tool = createObjectDetailHandlers({ publicModelsDir: models, assetStore: () => store, targetTexels: 256 * 256, objectMaterials })[OBJECT_DETAIL_TOOL];
        const { artifact } = objectScene(models);
        // materials alone: no wear is added, the path is given the object as built
        const r1 = await tool({ materials: true }, ctxOf(artifact));
        const a1 = r1.resultPayload.artifact as any;
        expect(r1.resultPayload.recipe).toMatchObject({ wear: null, decals: [], materials: true });
        expect(calls).toEqual([0]);
        expect(r1.summaryResult).toMatch(/each part's detected material/);
        expect(r1.resultPayload.materialPath).toBeDefined();
        // weathering later: the materials stay in the recipe and run on the weathered object
        const r2 = await tool({ weathering: { edgeWear: 0.7 } }, ctxOf(a1));
        expect(r2.resultPayload.recipe.materials).toBe(true);
        expect(calls[1]).toBe(2);
        expect(r2.resultPayload.version).toBeGreaterThan(r1.resultPayload.version as number);
        // and false removes them
        const r3 = await tool({ materials: false }, ctxOf(r2.resultPayload.artifact));
        expect(r3.resultPayload.recipe.materials).toBeUndefined();
        expect(calls.length).toBe(2);
        await expect(tool({ materials: false }, ctxOf(objectScene(path.join(root, 'm2', 'public', 'models')).artifact))).resolves.toBeDefined();
    }, TIMEOUT);
});
