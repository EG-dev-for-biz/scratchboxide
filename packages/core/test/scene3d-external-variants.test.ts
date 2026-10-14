/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Variant sets over Scene3DData.objects[] (open grouping key, no closed taxonomy) and the deep
 * disposal used when loaded models are removed or the viewport unmounts.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as THREE from 'three';
import {
    groupVariantSets,
    resolveActiveVariants,
    isActiveVariant,
    variantSetKeyOf
} from '../src/browser/generative-canvas/primitives/scene3d/variantSets';
import { disposeObject3DDeep, releaseObject3D } from '../src/browser/generative-canvas/primitives/scene3d/disposeObject';
import { applyClayRenderMode } from '../src/browser/generative-canvas/primitives/scene3d/clayRenderMode';
import { isAttachedTo } from '../src/browser/generative-canvas/primitives/scene3d/selection';
import type { Media4DObject } from '../src/browser/generative-canvas/canvas-types';
import { saveViewportSnapshot } from './helpers/scene3d-viewport-snapshot';

function model(id: string, metadata: Record<string, unknown> = {}): Media4DObject {
    return {
        id,
        content: { type: '3d-model', durableUri: `/models/${id}.glb`, mimeType: 'model/gltf-binary', metadata },
        space: { spatial3d: { x: 0, y: 0, z: 0 } }
    };
}

describe('variant sets', () => {
    // A set key nobody anticipated works without code changes (ADA "alien planet" test).
    const SET = 'bioluminescent-mycelium-growth-phases';

    it('groups by the open variantSet key and orders members by variantOrder', () => {
        const objects = [
            model('hero-prop'),
            model('phase-late', { variantSet: SET, variantOrder: 3 }),
            model('phase-early', { variantSet: SET, variantOrder: 1 }),
            model('other-a', { variantSet: 'lighting-passes' }),
            model('phase-mid', { variantSet: SET, variantOrder: 2 }),
            model('other-b', { variantSet: 'lighting-passes' })
        ];
        const sets = groupVariantSets(objects);
        expect(sets.map(s => s.key)).toEqual([SET, 'lighting-passes']);
        expect(sets[0].members.map(m => m.id)).toEqual(['phase-early', 'phase-mid', 'phase-late']);
        // Unordered members keep declaration order.
        expect(sets[1].members.map(m => m.id)).toEqual(['other-a', 'other-b']);
        expect(variantSetKeyOf(objects[0])).toBeUndefined();
        expect(groupVariantSets(undefined)).toEqual([]);
    });

    it('activates the viewer choice, else variantDefault, else the first member', () => {
        const sets = groupVariantSets([
            model('a', { variantSet: SET, variantOrder: 1 }),
            model('b', { variantSet: SET, variantOrder: 2 }),
            model('c', { variantSet: SET, variantOrder: 3, variantDefault: true }),
            model('x', { variantSet: 'two' }),
            model('y', { variantSet: 'two' })
        ]);
        expect(resolveActiveVariants(sets, {})).toEqual({ [SET]: 'c', two: 'x' });
        expect(resolveActiveVariants(sets, { [SET]: 'a', two: 'y' })).toEqual({ [SET]: 'a', two: 'y' });
        // A stale choice (member no longer declared) falls back instead of hiding the whole set.
        expect(resolveActiveVariants(sets, { [SET]: 'gone' })).toEqual({ [SET]: 'c', two: 'x' });
    });

    it('only the active member of a set is shown; objects outside sets always are', () => {
        const active = { [SET]: 'b' };
        expect(isActiveVariant(model('free'), active)).toBe(true);
        expect(isActiveVariant(model('b', { variantSet: SET }), active)).toBe(true);
        expect(isActiveVariant(model('a', { variantSet: SET }), active)).toBe(false);
    });

    it('no code branches on variant-set keys or member ids', () => {
        const primitiveSrc = fs.readFileSync(path.resolve(__dirname, '../src/browser/generative-canvas/primitives/Scene3DPrimitive.tsx'), 'utf-8');
        const helperSrc = fs.readFileSync(path.resolve(__dirname, '../src/browser/generative-canvas/primitives/scene3d/variantSets.ts'), 'utf-8');
        for (const src of [primitiveSrc, helperSrc]) {
            expect(src).not.toMatch(/variantSet\s*===\s*['"]/);
            expect(src).not.toMatch(/omnispatial|stage[-_ ]?[123]/i);
        }
    });
});

/** Records every dispose() dispatched by three resources under test. */
function trackDisposals(): { track: <T extends THREE.EventDispatcher<any>>(r: T, label: string) => T; disposed: string[] } {
    const disposed: string[] = [];
    return {
        disposed,
        track: (r, label) => {
            r.addEventListener('dispose', () => disposed.push(label));
            return r;
        }
    };
}

describe('disposeObject3DDeep', () => {
    it('frees geometry, materials, their textures and the authored materials stashed by clay mode', () => {
        const { track, disposed } = trackDisposals();
        const sharedTexture = track(new THREE.Texture(), 'tex:shared');
        const envMap = track(new THREE.Texture(), 'tex:env');

        const geometry = track(new THREE.BufferGeometry(), 'geo:a');
        geometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
        const authored = track(new THREE.MeshStandardMaterial({
            map: sharedTexture,
            normalMap: track(new THREE.Texture(), 'tex:normal'),
            envMap
        }), 'mat:authored');
        const partA = new THREE.Mesh(geometry, authored);

        const geometryB = track(new THREE.BufferGeometry(), 'geo:b');
        geometryB.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
        const partB = new THREE.Mesh(geometryB, [
            track(new THREE.MeshStandardMaterial({ map: sharedTexture }), 'mat:b0'),
            track(new THREE.MeshBasicMaterial({ alphaMap: track(new THREE.Texture(), 'tex:alpha') }), 'mat:b1')
        ]);

        const root = new THREE.Group();
        root.add(partA, partB);

        // Clay mode swaps partA's authored material out and stashes it in userData.
        applyClayRenderMode([partA], true);
        const clay = track(partA.material as THREE.Material, 'mat:clay');
        expect(partA.material).not.toBe(authored);

        disposeObject3DDeep(root);

        expect(disposed.sort()).toEqual([
            'geo:a', 'geo:b',
            'mat:authored', 'mat:b0', 'mat:b1', 'mat:clay',
            'tex:alpha', 'tex:normal', 'tex:shared'
        ]);
        expect(clay).toBeDefined();
        // Each resource is released once even when shared, and scene-level environment maps survive.
        expect(disposed.filter(d => d === 'tex:shared')).toHaveLength(1);
        expect(disposed).not.toContain('tex:env');
    });

    it('is a no-op for null roots', () => {
        expect(() => disposeObject3DDeep(null)).not.toThrow();
        expect(() => releaseObject3D(null)).not.toThrow();
    });
});

/** A one-triangle binary glTF (JSON + BIN chunks) with a named node and one material, no images. */
function buildTriangleGlb(nodeName: string): ArrayBuffer {
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const gltf = {
        asset: { version: '2.0' },
        scene: 0,
        scenes: [{ nodes: [0] }],
        nodes: [{ name: nodeName, mesh: 0 }],
        meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
        materials: [{ pbrMetallicRoughness: { baseColorFactor: [0.8, 0.85, 0.9, 1] } }],
        accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }],
        bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: positions.byteLength }],
        buffers: [{ byteLength: positions.byteLength }]
    };
    const pad4 = (n: number) => (n + 3) & ~3;
    const json = new TextEncoder().encode(JSON.stringify(gltf));
    const jsonLen = pad4(json.length);
    const binLen = pad4(positions.byteLength);
    const out = new ArrayBuffer(12 + 8 + jsonLen + 8 + binLen);
    const view = new DataView(out);
    const bytes = new Uint8Array(out);
    view.setUint32(0, 0x46546c67, true); // 'glTF'
    view.setUint32(4, 2, true);
    view.setUint32(8, out.byteLength, true);
    view.setUint32(12, jsonLen, true);
    view.setUint32(16, 0x4e4f534a, true); // 'JSON'
    bytes.fill(0x20, 20, 20 + jsonLen);
    bytes.set(json, 20);
    view.setUint32(20 + jsonLen, binLen, true);
    view.setUint32(24 + jsonLen, 0x004e4942, true); // 'BIN\0'
    bytes.set(new Uint8Array(positions.buffer), 28 + jsonLen);
    return out;
}

describe('releaseObject3D (the release path for removed / unmounted external objects)', () => {
    it('deep-disposes a real GLTFLoader root even though Group inherits a dispose() that frees nothing', async () => {
        const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
        const gltf = await new GLTFLoader().parseAsync(buildTriangleGlb('Hero_Part'), '');
        const root = gltf.scene;
        // The trap: a "has dispose()" check is always true for glTF roots in three r186.
        expect(typeof root.dispose).toBe('function');
        expect(root.dispose).toBe(THREE.Object3D.prototype.dispose);

        const part = root.getObjectByName('Hero_Part') as THREE.Mesh;
        expect(part?.isMesh).toBe(true);
        const { track, disposed } = trackDisposals();
        track(part.geometry, 'geo');
        const authored = track(part.material as THREE.MeshStandardMaterial, 'mat:authored');
        // Stands in for an embedded photo texture (decoding images needs a DOM).
        authored.map = track(new THREE.Texture(), 'tex:photo');
        const rootDisposeEvents: string[] = [];
        root.addEventListener('dispose', () => rootDisposeEvents.push(root.name));

        const scene = new THREE.Scene();
        root.name = 'external-object-hero';
        scene.add(root);
        applyClayRenderMode([root], true);
        track(part.material as THREE.Material, 'mat:clay');
        const camera = new THREE.PerspectiveCamera(45, 4 / 3, 0.1, 100);
        camera.position.set(0.3, 0.3, 3);
        camera.lookAt(0.3, 0.3, 0);
        const before = saveViewportSnapshot('scene3d_release_object_gltf_root_before', scene, camera, { highlight: root });

        releaseObject3D(root);

        const after = saveViewportSnapshot('scene3d_release_object_gltf_root_after', scene, camera);
        expect(before.highlightPixels).toBeGreaterThan(0);
        expect(after.drawnPixels).toBe(0);
        expect(root.parent).toBeNull();
        expect(disposed.sort()).toEqual(['geo', 'mat:authored', 'mat:clay', 'tex:photo']);
        // Listeners on the root's own 'dispose' event still fire.
        expect(rootDisposeEvents).toEqual(['external-object-hero']);
    });

    it('lets a class that overrides dispose() release itself, so scene-level textures it references survive', () => {
        const { track, disposed } = trackDisposals();
        const sharedDepthMap = track(new THREE.Texture(), 'tex:shared-depth');
        const ownGeometry = track(new THREE.BufferGeometry(), 'geo:own');
        const ownMaterial = track(new THREE.ShaderMaterial({ uniforms: { uDepth: { value: sharedDepthMap } } }), 'mat:own');

        class SelfReleasingSplat extends THREE.Group {
            readonly mesh = new THREE.Mesh(ownGeometry, ownMaterial);
            constructor() {
                super();
                this.add(this.mesh);
            }
            override dispose(): void {
                ownGeometry.dispose();
                ownMaterial.dispose();
            }
        }

        const scene = new THREE.Scene();
        const splat = new SelfReleasingSplat();
        scene.add(splat);
        releaseObject3D(splat);

        expect(splat.parent).toBeNull();
        expect(disposed.sort()).toEqual(['geo:own', 'mat:own']);
    });

    it('Scene3DPrimitive routes every external-object release through releaseObject3D', () => {
        const src = fs.readFileSync(path.resolve(__dirname, '../src/browser/generative-canvas/primitives/Scene3DPrimitive.tsx'), 'utf-8');
        // Deciding by `typeof x.dispose === 'function'` silently skips deep disposal for glTF roots.
        expect(src).not.toMatch(/typeof\s*\(?\s*\w+(\s+as\s+any)?\s*\)?\.dispose\s*[!=]==?\s*['"]function['"]/);
        expect(src.match(/releaseObject3D\(/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
    });
});

/** A camera-facing square of side `size` built from raw buffers (no primitive constructors). */
function square(size: number): THREE.Mesh {
    const h = size / 2;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([-h, -h, 0, h, -h, 0, h, h, 0, -h, -h, 0, h, h, 0, -h, h, 0], 3));
    return new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
}

describe('co-registered variant members', () => {
    it('only the attached (active) member is drawn, and switching back re-attaches the cached root', () => {
        const SET = 'erosion-epochs';
        const defs = [
            model('epoch-a', { variantSet: SET, variantOrder: 1 }),
            model('epoch-b', { variantSet: SET, variantOrder: 2, variantDefault: true })
        ];
        // Same origin, different footprints, so the drawn area tells which one is in the scene.
        const roots = new Map<string, THREE.Group>([['epoch-a', new THREE.Group()], ['epoch-b', new THREE.Group()]]);
        roots.get('epoch-a')!.add(square(2));
        roots.get('epoch-b')!.add(square(5));
        const scene = new THREE.Scene();
        const camera = new THREE.PerspectiveCamera(45, 4 / 3, 0.1, 100);
        camera.position.set(0, 0, 10);
        camera.lookAt(0, 0, 0);

        // Mirrors the loader: active members are attached, the rest detached but kept cached.
        const apply = (choice: Record<string, string>) => {
            const active = resolveActiveVariants(groupVariantSets(defs), choice);
            for (const def of defs) {
                const root = roots.get(def.id)!;
                if (isActiveVariant(def, active)) scene.add(root);
                else root.parent?.remove(root);
            }
        };

        apply({});
        const withDefault = saveViewportSnapshot('scene3d_external_variants_default_member_attached', scene, camera, { highlight: roots.get('epoch-b') });
        apply({ [SET]: 'epoch-a' });
        const switched = saveViewportSnapshot('scene3d_external_variants_switched_member_attached', scene, camera, { highlight: roots.get('epoch-a') });
        const cachedB = roots.get('epoch-b')!;
        expect(isAttachedTo(cachedB, scene)).toBe(false);
        apply({ [SET]: 'epoch-b' });

        // Every drawn pixel belongs to the active member, never to the detached one.
        expect(withDefault.drawnPixels).toBeGreaterThan(0);
        expect(withDefault.highlightPixels).toBe(withDefault.drawnPixels);
        expect(switched.highlightPixels).toBe(switched.drawnPixels);
        // Footprint ratio 5^2 / 2^2 = 6.25 (edge pixels make it approximate).
        expect(withDefault.drawnPixels / switched.drawnPixels).toBeGreaterThan(5);
        expect(withDefault.drawnPixels / switched.drawnPixels).toBeLessThan(7.5);
        // The same cached root object comes back: no reload.
        expect(scene.children).toEqual([cachedB]);
    });
});

describe('isAttachedTo', () => {
    it('is false once a variant root is detached from the scene', () => {
        const scene = new THREE.Scene();
        const root = new THREE.Group();
        const part = new THREE.Group();
        root.add(part);
        scene.add(root);
        expect(isAttachedTo(part, scene)).toBe(true);
        scene.remove(root);
        expect(isAttachedTo(part, scene)).toBe(false);
        expect(isAttachedTo(null, scene)).toBe(false);
    });
});
