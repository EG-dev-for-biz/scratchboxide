/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The viewport's parts view (scene3d/modelParts.ts): the parts of a building and an object read from their extras,
 * grouped by what identifies them, an unknown `sb*` key making a group of its own; hiding, solo and restore reach the
 * meshes (a merged staged part's triangles collapsed); a ray picks a part, a merged one by its triangle.
 */

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { applyModelPartsView, collectModelParts, groupLabel, ModelPartsOverlay, partByKey, pickModelPart, restoreModelParts } from '../src/browser/generative-canvas/primitives/scene3d/modelParts';
import { mergeStagedParts, mergedPartsOf } from '../src/browser/generative-canvas/primitives/scene3d/stagedBuild/mergeStagedParts';
import { partShown } from '../src/common/spatial/model-parts-view';

/** A unit quad at x offset `dx`, facing +z. */
function quad(dx: number, name: string, material = new THREE.MeshStandardMaterial()): THREE.Mesh {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([dx, 0, 0, dx + 1, 0, 0, dx + 1, 1, 0, dx, 1, 0], 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1], 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    const m = new THREE.Mesh(g, material);
    m.name = name;
    return m;
}

function building(): THREE.Object3D {
    const root = new THREE.Group();
    root.name = 'external-object-b1';
    const facade = new THREE.Group();
    facade.name = 'FacadeLattice_3';
    facade.userData.sbFacadeLattice = { facadeId: 3, measuredShare: 0.8, windows: { uv: [0, 0, 0.1, 0.1, 0.2, 0, 0.3, 0.1], panes: [0, 0, 0.1, 0.1] }, provenance: { lines: 'photo-inferred', depth: 'measured', texture: 'measured' } };
    facade.add(quad(0, 'facade_lattice_3'));
    const skirt = new THREE.Group();
    skirt.name = 'BaseSkirt';
    skirt.userData.sbBaseSkirt = { version: 1, provenance: { label: 'generated', method: 'the base closed from the ground' } };
    skirt.add(quad(2, 'base_skirt'));
    const scan = quad(4, 'tile_7');
    scan.geometry.userData.sbFootprintClip = { version: 1, provenance: 'as-scanned, clipped' };
    const alien = quad(6, 'thing');
    alien.userData.sbMethaneGeyser = { version: 1, provenance: 'generated', pressure: 3 };
    const plain = quad(8, 'mesh_9');
    // the viewer's own hooks on userData make no group
    plain.userData.sbProbeTarget = true;
    plain.userData.sbLodBase = { mesh: 'not a record the file wrote' };
    root.add(facade, skirt, scan, alien, plain);
    return root;
}

function object(): THREE.Object3D {
    const root = new THREE.Group();
    root.name = 'external-object-o1';
    for (const [i, id] of ['hull', 'strut_1', 'nozzle'].entries()) {
        const mat = new THREE.MeshStandardMaterial({ roughness: 0.3 + i * 0.1, metalness: i ? 0.9 : 0 });
        mat.userData.scratchbox = { partId: id, provenance: 'generated', description: `the ${id}` };
        root.add(quad(10 + i * 2, id, mat));
    }
    return root;
}

function stagedLayer(): THREE.Object3D {
    const root = new THREE.Group();
    root.name = 'external-object-s1';
    const mat = new THREE.MeshStandardMaterial();
    for (let i = 0; i < 10; i++) {
        const n = new THREE.Group();
        n.name = `surface_${i}`;
        n.userData.sb = { schema: 'scratchbox.staged-node/2', stage: 'massing', provenance: { label: i < 6 ? 'measured' : 'generated', confidence: 0.5 + i / 20 }, ids: { surfaceId: `s${i}` } };
        n.add(quad(20 + i * 2, `m_${i}`, mat));
        root.add(n);
    }
    root.updateMatrixWorld(true);
    expect(mergeStagedParts(root)).toBeDefined();
    return root;
}

describe('the parts view of a model', () => {
    it('reads a building, an object and a staged layer into groups by what identifies each part, unknown keys included', () => {
        const groups = collectModelParts([building(), object(), stagedLayer()]);
        const byKey = Object.fromEntries(groups.map(g => [g.key, g]));
        expect(Object.keys(byKey)).toEqual(['sbFacadeLattice', 'sbBaseSkirt', 'sbFootprintClip', 'sbMethaneGeyser', 'mesh', 'objectPart', 'staged:measured', 'staged:generated']);
        const facade = byKey.sbFacadeLattice.parts[0];
        expect(facade.label).toBe('Facade 3');
        expect(facade.detail).toBe('80% measured · 2 windows · 1 panes');
        expect(facade.provenance?.label).toBe('lines photo-inferred, depth measured, texture measured');
        expect(facade.triangles).toBe(2);
        expect(byKey.sbBaseSkirt.parts[0].provenance).toEqual({ label: 'generated', method: 'the base closed from the ground' });
        expect(byKey.sbFootprintClip.parts[0].provenance?.label).toBe('as-scanned, clipped');
        expect(byKey.sbMethaneGeyser.label).toBe('Methane geyser');
        expect(byKey.sbMethaneGeyser.parts[0].provenance?.label).toBe('generated');
        expect(byKey.mesh.parts.map(p => p.label)).toEqual(['mesh_9']);
        // colours three.js can read (an hsl() with commas)
        expect(new THREE.Color(facade.colour).getHex()).not.toBe(0xffffff);
        expect(groupLabel('staged:measured')).toBe('Staged, measured');
        expect(byKey.objectPart.parts.map(p => p.label)).toEqual(['hull', 'strut_1', 'nozzle']);
        expect(byKey.objectPart.parts[2].detail).toBe('the nozzle · roughness 0.5, metalness 0.9');
        expect(byKey['staged:measured'].parts).toHaveLength(6);
        expect(byKey['staged:generated'].parts).toHaveLength(4);
        expect(byKey['staged:measured'].parts.every(p => p.merged)).toBe(true);
        // every part its own colour, every group its own
        const colours = groups.flatMap(g => g.parts.map(p => p.colour));
        expect(new Set(colours).size).toBe(colours.length);
        expect(new Set(groups.map(g => g.colour)).size).toBe(groups.length);
    });

    it('hides, shows alone and restores parts on the meshes, a merged part by collapsing its triangles', () => {
        const b = building(), s = stagedLayer();
        const groups = collectModelParts([b, s]);
        const skirt = partByKey(groups, groups.find(g => g.key === 'sbBaseSkirt')!.parts[0].key)!;
        const staged = groups.find(g => g.key === 'staged:generated')!.parts[0];
        const merged = staged.merged!.mesh, index = (merged.geometry as THREE.BufferGeometry).index!;
        const before = Array.from(index.array);
        const hidden = applyModelPartsView(groups, { hidden: [skirt.key, staged.key] });
        expect(hidden).toEqual([skirt.key, staged.key]);
        expect(skirt.mesh.visible).toBe(false);
        expect(mergedPartsOf(merged)!.visible[staged.merged!.index]).toBe(0);
        const from = staged.merged!.triStart * 3;
        expect(Array.from(index.array).slice(from, from + 6)).toEqual([before[from], before[from], before[from], before[from + 3], before[from + 3], before[from + 3]]);
        // solo: one part shown, the rest hidden
        const facade = groups.find(g => g.key === 'sbFacadeLattice')!.parts[0];
        applyModelPartsView(groups, { hidden: [skirt.key], solo: facade.key });
        expect(facade.mesh.visible).toBe(true);
        expect(skirt.mesh.visible).toBe(false);
        expect(groups.find(g => g.key === 'mesh')!.parts[0].mesh.visible).toBe(false);
        expect(partShown({ solo: facade.key }, skirt.key)).toBe(false);
        expect(mergedPartsOf(merged)!.visible.every(v => v === 0)).toBe(true);
        restoreModelParts(groups);
        expect(groups.every(g => g.parts.every(p => p.mesh.visible))).toBe(true);
        expect(mergedPartsOf(merged)!.visible.every(v => v === 1)).toBe(true);
        expect(Array.from(index.array)).toEqual(before);
    });

    it('picks the part under a ray, a merged part by its triangle, and never a hidden one', () => {
        const b = building(), s = stagedLayer();
        [b, s].forEach(r => r.updateMatrixWorld(true));
        const groups = collectModelParts([b, s]);
        const ray = (x: number) => { const r = new THREE.Raycaster(); r.set(new THREE.Vector3(x, 0.5, 5), new THREE.Vector3(0, 0, -1)); return r; };
        expect(pickModelPart(ray(2.5), groups)?.label).toBe('BaseSkirt');
        expect(pickModelPart(ray(0.5), groups)?.label).toBe('Facade 3');
        // the staged layer's quads sit at x = 20 + 2 i; part 7 is generated
        const hit = pickModelPart(ray(34.5), groups)!;
        expect(hit.label).toBe('surface_7');
        expect(hit.group).toBe('staged:generated');
        applyModelPartsView(groups, { hidden: [hit.key] });
        expect(pickModelPart(ray(34.5), groups)).toBeUndefined();
        expect(pickModelPart(ray(100), groups)).toBeUndefined();
    });

    it('draws one overlay mesh per part over the model, the highlighted one brightest, none when tint is off and nothing is lit', () => {
        const b = building(), s = stagedLayer();
        [b, s].forEach(r => r.updateMatrixWorld(true));
        const scene = new THREE.Scene();
        scene.add(b, s);
        const groups = collectModelParts([b, s]);
        const overlay = new ModelPartsOverlay(scene);
        const facade = groups.find(g => g.key === 'sbFacadeLattice')!.parts[0];
        overlay.sync(groups, { tint: true, cfg: undefined, highlight: facade.key });
        const meshes = overlay.root.children as THREE.Mesh[];
        expect(meshes).toHaveLength(groups.reduce((a, g) => a + g.parts.length, 0));
        const lit = meshes.find(m => m.name === `sb-parts-overlay:${facade.label}`)!;
        expect((lit.material as THREE.MeshBasicMaterial).opacity).toBeGreaterThan((meshes.find(m => m !== lit)!.material as THREE.MeshBasicMaterial).opacity);
        // a merged part's overlay holds only its triangles, over the mesh's own attributes
        const staged = groups.find(g => g.key === 'staged:measured')!.parts[0];
        const o = meshes.find(m => m.name === `sb-parts-overlay:${staged.label}`)!;
        expect((o.geometry as THREE.BufferGeometry).index!.count).toBe(staged.merged!.triCount * 3);
        expect((o.geometry as THREE.BufferGeometry).getAttribute('position')).toBe((staged.merged!.mesh.geometry as THREE.BufferGeometry).getAttribute('position'));
        overlay.sync(groups, { tint: false, cfg: { hidden: [facade.key] }, highlight: undefined });
        expect(meshes.every(m => !m.visible)).toBe(true);
        overlay.sync(groups, { tint: false, cfg: undefined, highlight: staged.key });
        expect(meshes.filter(m => m.visible).map(m => m.name)).toEqual([`sb-parts-overlay:${staged.label}`]);
        overlay.dispose();
        expect(scene.getObjectByName('sb-parts-overlay')).toBeUndefined();
    });
});
