/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * A chat media card's "Apply as 3D Texture" changes the open scene or says why it did not: the scene mesh it targets gets
 * the texture set in its scene data, the viewport's mesh sync draws that set (and drops maps a newer set or an undo removed),
 * and the request reports what the viewport answered, never a success nobody reported.
 */

import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import type { Scene3DData } from '../src/browser/generative-canvas/canvas-types';
import {
    APPLY_MESH_TEXTURE_EVENT,
    NO_VIEWPORT_REASON,
    applyMeshTexture,
    describeMeshTextureOutcome,
    requestMeshTexture,
    textureLoadFailureReason,
    type MeshTextureRequest
} from '../src/browser/generative-canvas/primitives/scene3d/meshTexture';
import { syncCustomMeshes, type CustomMeshRegistry } from '../src/browser/generative-canvas/primitives/scene3d/syncCustomMeshes';
import type { RendererStack } from '../src/browser/generative-canvas/primitives/scene3d/types';
import { EXTERNAL_OBJECT_ROOT_PREFIX } from '../src/browser/generative-canvas/primitives/scene3d/selection';

const IMAGE = '/media/brick-albedo.png';

function scene(): Scene3DData {
    return {
        title: 'Studio',
        renderMode: 'pbr',
        customMeshes: [
            { id: 'pedestal', name: 'Pedestal', type: 'box', material: { color: '#38bdf8', roughness: 0.4, metalness: 0.5 }, pbrTextures: { repeat: [4, 4], normalUrl: '/old-normal.png' } },
            { id: 'orb', type: 'sphere', material: { color: '#ff0000' } }
        ],
        objects: [
            { id: 'statue', content: { type: '3d-model', durableUri: '/models/statue.glb', mimeType: 'model/gltf-binary', metadata: { name: 'Marble statue' } }, space: {} }
        ]
    } as Scene3DData;
}

describe('applyMeshTexture puts the card texture on the targeted scene mesh', () => {
    it('replaces the mesh texture set with the image, keeps its tiling, and whitens the base colour', () => {
        const before = scene();
        const snapshot = JSON.stringify(before);
        const edit = applyMeshTexture(before, 'pedestal', { albedo: IMAGE });
        expect(edit.ok).toBe(true);
        if (!edit.ok) return;
        const pedestal = edit.scene.customMeshes![0];
        expect(pedestal.pbrTextures).toEqual({ repeat: [4, 4], albedoUrl: IMAGE });
        expect(pedestal.material).toEqual({ color: '#ffffff', roughness: 0.4, metalness: 0.5 });
        expect(edit.meshId).toBe('pedestal');
        expect(edit.meshName).toBe('Pedestal');
        expect(edit.channels).toEqual(['albedo']);
        // the other mesh and the input scene are untouched
        expect(edit.scene.customMeshes![1]).toBe(before.customMeshes![1]);
        expect(JSON.stringify(before)).toBe(snapshot);
    });

    it('a full PBR set carries every map and lets the maps set roughness and metalness', () => {
        const edit = applyMeshTexture(scene(), 'orb', {
            albedo: '/a.png', normal: '/n.png', roughness: '/r.png', metallic: '/m.png', ao: '/ao.png'
        });
        expect(edit.ok).toBe(true);
        if (!edit.ok) return;
        const orb = edit.scene.customMeshes![1];
        expect(orb.pbrTextures).toEqual({ albedoUrl: '/a.png', normalUrl: '/n.png', roughnessUrl: '/r.png', metallicUrl: '/m.png', aoUrl: '/ao.png' });
        expect(orb.material).toEqual({ color: '#ffffff', roughness: 1, metalness: 1 });
        expect(edit.meshName).toBe('orb');
        expect(edit.channels).toEqual(['albedo', 'normal', 'roughness', 'metallic', 'ao']);
        expect(describeMeshTextureOutcome({ status: 'applied', meshId: 'orb', meshName: 'orb', channels: edit.channels }))
            .toBe("Applied to 'orb': base colour, normal, roughness, metalness and ambient occlusion maps.");
    });

    it('a mesh without an id is matched by the name the viewport gives it', () => {
        const s = scene();
        s.customMeshes!.push({ name: 'Plinth', type: 'box' } as never, { type: 'torus' } as never);
        const byName = applyMeshTexture(s, 'Plinth', { albedo: IMAGE });
        expect(byName.ok && byName.scene.customMeshes![2].pbrTextures?.albedoUrl).toBe(IMAGE);
        const byIndex = applyMeshTexture(s, 'custom-mesh-3', { albedo: IMAGE });
        expect(byIndex.ok && byIndex.scene.customMeshes![3].pbrTextures?.albedoUrl).toBe(IMAGE);
    });

    it('changes nothing and says why when nothing is selected, the selection is a model, or there is no image', () => {
        const none = applyMeshTexture(scene(), null, { albedo: IMAGE });
        expect(none).toEqual({ ok: false, reason: 'Nothing is selected in the 3D viewport. Select a mesh, then apply again.' });

        const model = applyMeshTexture(scene(), `${EXTERNAL_OBJECT_ROOT_PREFIX}statue`, { albedo: IMAGE });
        expect(model.ok).toBe(false);
        expect(!model.ok && model.reason).toContain("'Marble statue' is not one of the scene's own meshes");
        expect(!model.ok && model.reason).toContain('Nothing was changed.');

        const part = applyMeshTexture(scene(), 'Statue_Head_Mesh', { albedo: IMAGE });
        expect(!part.ok && part.reason).toContain("'Statue_Head_Mesh' is not one of the scene's own meshes");

        const noImage = applyMeshTexture(scene(), 'pedestal', { albedo: '' });
        expect(noImage.ok).toBe(false);
    });

    it('a load failure names the channel and never quotes an inline image', () => {
        expect(textureLoadFailureReason('albedo', 'data:image/png;base64,AAAA')).toBe('The base colour image (an inline image) could not be loaded. Nothing was changed.');
        expect(textureLoadFailureReason('normal', '/n.png')).toBe('The normal image (/n.png) could not be loaded. Nothing was changed.');
    });
});

/** A viewport that answers the way Scene3DPrimitive does, over real scene data (no image loading in node). */
function viewport(target: EventTarget, state: { scene: Scene3DData; selected: string | null }): void {
    target.addEventListener(APPLY_MESH_TEXTURE_EVENT, e => {
        const request = (e as CustomEvent<MeshTextureRequest>).detail;
        if (request.claimed) return;
        const targetId = request.targetId ?? state.selected;
        const edit = applyMeshTexture(state.scene, targetId, request.channels);
        if (!edit.ok) {
            request.decline(edit.reason, !!targetId);
            return;
        }
        state.scene = edit.scene;
        request.claim(Promise.resolve({ status: 'applied', meshId: edit.meshId, meshName: edit.meshName, channels: edit.channels }));
    });
}

describe('requestMeshTexture reports what the open viewport answered', () => {
    it('says no 3D scene is open when no viewport answers', async () => {
        expect(await requestMeshTexture({ albedo: IMAGE }, undefined, new EventTarget())).toEqual({ status: 'failed', reason: NO_VIEWPORT_REASON });
    });

    it('the viewport with the selected mesh applies it once, and its scene carries the texture', async () => {
        const target = new EventTarget();
        const first = { scene: scene(), selected: 'pedestal' as string | null };
        const second = { scene: scene(), selected: 'orb' as string | null };
        viewport(target, first);
        viewport(target, second);
        const outcome = await requestMeshTexture({ albedo: IMAGE }, undefined, target);
        expect(outcome).toEqual({ status: 'applied', meshId: 'pedestal', meshName: 'Pedestal', channels: ['albedo'] });
        expect(first.scene.customMeshes![0].pbrTextures?.albedoUrl).toBe(IMAGE);
        // the request was claimed, so the second viewport left its scene alone
        expect(second.scene.customMeshes![1].pbrTextures).toBeUndefined();
        expect(describeMeshTextureOutcome(outcome)).toBe("Applied to 'Pedestal': base colour map.");
    });

    it('a named target wins over the selection', async () => {
        const target = new EventTarget();
        const state = { scene: scene(), selected: 'pedestal' as string | null };
        viewport(target, state);
        const outcome = await requestMeshTexture({ albedo: IMAGE }, 'orb', target);
        expect(outcome.status === 'applied' && outcome.meshId).toBe('orb');
        expect(state.scene.customMeshes![1].pbrTextures?.albedoUrl).toBe(IMAGE);
        expect(state.scene.customMeshes![0].pbrTextures?.albedoUrl).toBeUndefined();
    });

    it('when no viewport can apply it, the reason of one that had a selection is shown', async () => {
        const target = new EventTarget();
        viewport(target, { scene: scene(), selected: null });
        viewport(target, { scene: scene(), selected: `${EXTERNAL_OBJECT_ROOT_PREFIX}statue` });
        const outcome = await requestMeshTexture({ albedo: IMAGE }, undefined, target);
        expect(outcome.status).toBe('failed');
        expect(describeMeshTextureOutcome(outcome)).toContain("'Marble statue' is not one of the scene's own meshes");
    });

    it('a claimed apply that throws is a failure, not a success', async () => {
        const target = new EventTarget();
        target.addEventListener(APPLY_MESH_TEXTURE_EVENT, e => {
            (e as CustomEvent<MeshTextureRequest>).detail.claim(Promise.reject(new Error('viewport closed')));
        });
        expect(await requestMeshTexture({ albedo: IMAGE }, undefined, target)).toEqual({ status: 'failed', reason: 'The texture was not applied: viewport closed' });
    });
});

describe('the viewport mesh sync draws the texture set the scene data carries', () => {
    const stack = { scene: new THREE.Scene() } as unknown as RendererStack;
    const options = { terrainManager: null, has3DTiles: false };

    it('applies the texture set, drops maps a newer set leaves out, and clears them when the set is undone', () => {
        const registry: CustomMeshRegistry = new Map();
        const base = scene();
        syncCustomMeshes(stack, base.customMeshes as never, registry, options);
        const mesh = registry.get('orb')!.mesh as THREE.Mesh;
        expect((mesh.material as THREE.MeshStandardMaterial).color.getHexString()).toBe('ff0000');

        const full = applyMeshTexture(base, 'orb', { albedo: '/a.png', normal: '/n.png', roughness: '/r.png' });
        if (!full.ok) throw new Error(full.reason);
        syncCustomMeshes(stack, full.scene.customMeshes as never, registry, options);
        const mat = mesh.material as THREE.MeshPhysicalMaterial;
        expect(mat).toBeInstanceOf(THREE.MeshPhysicalMaterial);
        expect(mat.color.getHexString()).toBe('ffffff');
        expect(mat.roughness).toBe(1);
        // what the image loads would have set (node has no image decoder)
        mat.map = new THREE.Texture();
        mat.normalMap = new THREE.Texture();
        mat.roughnessMap = new THREE.Texture();

        const albedoOnly = applyMeshTexture(full.scene, 'orb', { albedo: '/b.png' });
        if (!albedoOnly.ok) throw new Error(albedoOnly.reason);
        // the roughness factor was 1 only to multiply the roughness map: it goes with it, and the viewport default stands in
        expect(albedoOnly.scene.customMeshes![1].material).toEqual({ color: '#ffffff' });
        syncCustomMeshes(stack, albedoOnly.scene.customMeshes as never, registry, options);
        expect(mesh.material).toBe(mat);
        expect(mat.map).not.toBeNull();
        expect(mat.normalMap).toBeNull();
        expect(mat.roughnessMap).toBeNull();
        expect(mat.roughness).toBe(0.5);

        // undo: the scene as it was before any texture
        syncCustomMeshes(stack, base.customMeshes as never, registry, options);
        expect(mat.map).toBeNull();
        expect(mat.color.getHexString()).toBe('ff0000');
    });
});
