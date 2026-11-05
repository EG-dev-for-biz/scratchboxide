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
import { districtWorldScene } from '../src/node/cloud-store/district-world';
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
