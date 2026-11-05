/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * A finished district build kept as a world (cloud-store/district-world.ts, scripts/publish_district_world.ts): every model
 * its scene names moves under the world's folder, nothing else changes, and the 3D Scene starter opens it.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { districtWorldScene, publishDistrictWorld } from '../src/node/cloud-store/district-world';
import { DirectoryCloudBucket } from '../src/node/cloud-store/cloud-bucket';
import { readWorldIndex } from '../src/node/cloud-store/world-cache';
import { openWorld } from '../src/node/cloud-store/world-scenes';
import { districtWorldSlug } from '../src/node/3d-engine/staged-location/orchestrator';
import { STARTER_BUTTONS } from '../src/browser/generative-canvas/studio/starterPrompts';

describe('a district kept as a world', () => {
    it('moves every model the scene names under the world, keeps the rest, and lists each model once', () => {
        const artifact = {
            data: {
                title: 'Penn', camera: { position: [1, 2, 3] },
                objects: [
                    { id: 'a', content: { type: '3d-model', durableUri: '/models/ground_0.glb', metadata: { provenance: 'measured', note: 'not /models/x.glb in prose' } } },
                    { id: 'b', content: { type: '3d-model', durableUri: '/models/b.glb' } }
                ],
                stagedBuild: { runId: 'abcd1234', layers: [{ url: '/models/b.glb', textured: '/models/b_tex.glb' }] }
            }
        };
        const { scene, models } = districtWorldScene(artifact, 'penn_x');
        expect(models).toEqual(['b.glb', 'b_tex.glb', 'ground_0.glb']);
        const s = scene as any;
        expect(s.objects[0].content.durableUri).toBe('/tilesets/penn_x/models/ground_0.glb');
        expect(s.stagedBuild.layers[0]).toEqual({ url: '/tilesets/penn_x/models/b.glb', textured: '/tilesets/penn_x/models/b_tex.glb' });
        // a path inside prose is not a whole value and is left as written
        expect(s.objects[0].content.metadata.note).toBe('not /models/x.glb in prose');
        expect(s.camera).toEqual({ position: [1, 2, 3] });
        expect(s.world).toEqual({ slug: 'penn_x' });
        // its layers have textured twins: it opens textured, under the title given
        expect(s.renderMode).toBe('pbr');
        expect((districtWorldScene({ data: { ...artifact.data, renderMode: 'clay' } }, 'penn_x', { title: 'Penn district' }).scene as any).title).toBe('Penn district');
        // no textured twin: the scene's own mode stays
        expect((districtWorldScene({ data: { renderMode: 'clay', stagedBuild: { layers: [{ url: '/models/c.glb' }] } } }, 'penn_x').scene as any).renderMode).toBe('clay');
        expect(() => districtWorldScene({}, 'penn_x')).toThrow(/no scene data/);
    });

    it('the 3D Scene starter opens the massed Penn district, and keeps its build prompts for a machine without it', () => {
        const b = STARTER_BUTTONS.find(x => x.label === '3D Scene')!;
        expect(b.world?.slug).toBe('penn_station_district_2_penn_plaza');
        expect(b.world?.scenePath).toBe('/tilesets/penn_station_district_2_penn_plaza/scene3d.json');
        expect(b.prompts.length).toBeGreaterThanOrEqual(8);
    });
});

describe('a district world backed up to the world cache', () => {
    it('publishes a district with a link per model, stores it, and a machine without it opens it from the cloud', async () => {
        const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-district-world-'));
        const models = path.join(work, 'run', 'public', 'models');
        fs.mkdirSync(models, { recursive: true });
        fs.writeFileSync(path.join(models, 'a.glb'), Buffer.from('glTFa'));
        fs.writeFileSync(path.join(models, 'b.glb'), Buffer.from('glTFbb'));
        fs.writeFileSync(path.join(models, 'unused.glb'), Buffer.from('not named by the scene'));
        const artifact = { data: { title: 'T', objects: [{ content: { durableUri: '/models/a.glb' } }], stagedBuild: { runId: 'abcd1234', layers: [{ url: '/models/a.glb', textured: '/models/b.glb' }] } } };
        const bucket = new DirectoryCloudBucket(path.join(work, 'bucket'));
        const tilesets = path.join(work, 'tilesets');
        const out = await publishDistrictWorld({ artifact, modelsDir: models, slug: 'district_test_abcd1234', worldsDir: tilesets, runId: 'abcd1234', bucket });
        expect(out.models).toBe(2);
        // only the models the scene names are linked, each where the build left it
        expect(fs.readdirSync(path.join(tilesets, 'district_test_abcd1234', 'models')).sort()).toEqual(['a.glb', 'b.glb']);
        expect(fs.lstatSync(path.join(tilesets, 'district_test_abcd1234', 'models', 'a.glb')).isSymbolicLink()).toBe(true);
        // the cloud holds the files themselves (the links followed), indexed by the world's name
        expect(out.stored?.files).toBe(3);
        expect(await readWorldIndex(bucket, 'district_test_abcd1234')).toBe(out.stored?.key);
        // another machine: no local world; opening it fetches the scene and both models
        const elsewhere = path.join(work, 'elsewhere');
        const opened = await openWorld<Record<string, any>>('district_test_abcd1234', elsewhere, bucket);
        // fetched from the cloud, then read from the copy it fetched (no later saved version)
        expect(opened.fetchedFiles).toBe(3);
        expect(opened.scene.objects[0].content.durableUri).toBe('/tilesets/district_test_abcd1234/models/a.glb');
        expect(fs.readFileSync(path.join(elsewhere, 'district_test_abcd1234', 'models', 'b.glb'), 'utf8')).toBe('glTFbb');
        // a model the scene names that is not there: nothing written
        fs.unlinkSync(path.join(models, 'b.glb'));
        await expect(publishDistrictWorld({ artifact, modelsDir: models, slug: 'district_test_2', worldsDir: tilesets })).rejects.toThrow(/1 of the 2 models/);
        expect(fs.existsSync(path.join(tilesets, 'district_test_2'))).toBe(false);
        fs.rmSync(work, { recursive: true, force: true });
    });

    it('names a district world by its place and run', () => {
        expect(districtWorldSlug('2 Penn Plaza, New York', '8e3a912b')).toBe('district_2_penn_plaza_new_york_8e3a912b');
    });
});
