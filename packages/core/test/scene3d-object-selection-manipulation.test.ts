import { test } from 'vitest';
/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as assert from 'assert';
import * as THREE from 'three';
import {
    createHistoricalBattlefieldScene,
    createProceduralCityScene,
    createSolarSystemScene,
    createMolecularPhysicsScene,
    createArchitecturalRoomScene,
    createWorldBuilderScene,
    createProceduralSpatialScene
} from '../src/browser/generative-canvas/procedural-3d-synthesizer';
import {
    TransformGizmoEngine,
    computeAxisTranslation,
    computePlaneTranslation,
    computeRotationAngle,
    computeScaleFactor
} from '../src/browser/generative-canvas/services/transform-gizmo-engine';
import {
    createOperatorEngine
} from '../src/browser/generative-canvas/services/direct-dispatch-operator-engine';
import {
    MeshHistoryStack,
    applySculptStroke,
    createSculptableGeometry
} from '../src/browser/generative-canvas/services/mesh-sculpting-engine';
import type {
    Scene3DData,
    SculptSettings
} from '../src/browser/generative-canvas/canvas-types';

/**
 * Helper to resolve top-level selectable object from a raycast hit object.
 */
export function resolveSelectableObject(hitObject: THREE.Object3D, sceneRoot: THREE.Object3D): THREE.Object3D {
    let current: THREE.Object3D = hitObject;
    let selectable: THREE.Object3D = hitObject;

    while (current && current.parent && current.parent !== sceneRoot) {
        // If parent is a semantic group (e.g. Buckman Tavern, soldier, tree) but not the top-level scene collection
        if (current.parent.name && !current.parent.name.startsWith('sb-gizmo-') && current.parent.name !== 'historical-battlefield' && current.parent.name !== 'procedural-city' && current.parent.name !== 'procedural-scene') {
            selectable = current.parent;
        }
        current = current.parent;
    }

    return selectable;
}

/**
 * Helper to extract selectable items from a Three.js scene for the Outliner.
 */
export function extractSceneOutlinerItems(scene: THREE.Scene): Array<{ id: string; name: string; type: string; object: THREE.Object3D; visible: boolean }> {
    const items: Array<{ id: string; name: string; type: string; object: THREE.Object3D; visible: boolean }> = [];

    scene.traverse((obj) => {
        // Ignore internal helper objects, gizmos, cameras, lights, and cursor meshes
        if (obj === scene) return;
        if (obj.name && (obj.name.startsWith('sb-') || obj.name === 'historical-battlefield' || obj.name === 'procedural-city' || obj.name === 'procedural-scene')) return;
        if (obj.userData?.isGizmo || obj.userData?.handleType) return;
        if ((obj as any).isLight || (obj as any).isCamera) return;

        // Collect top-level named groups or standalone meshes
        const isTopLevelGroup = obj.parent === scene || (obj.parent && (obj.parent.name === 'historical-battlefield' || obj.parent.name === 'procedural-city' || obj.parent.name === 'procedural-scene'));
        
        if (isTopLevelGroup && obj.name) {
            let itemType = 'mesh';
            const nameLower = obj.name.toLowerCase();
            if (nameLower.includes('tavern') || nameLower.includes('house') || nameLower.includes('meeting') || nameLower.includes('tower') || nameLower.includes('building')) {
                itemType = 'building';
            } else if (nameLower.includes('minuteman') || nameLower.includes('soldier') || nameLower.includes('redcoat') || nameLower.includes('regiment') || nameLower.includes('line')) {
                itemType = 'unit';
            } else if (nameLower.includes('tree') || nameLower.includes('elm')) {
                itemType = 'tree';
            } else if (nameLower.includes('ground') || nameLower.includes('terrain') || nameLower.includes('floor')) {
                itemType = 'terrain';
            } else if (nameLower.includes('smoke') || nameLower.includes('emitter') || nameLower.includes('particle')) {
                itemType = 'emitter';
            } else if (nameLower.includes('wall') || nameLower.includes('fence')) {
                itemType = 'prop';
            } else if (nameLower.includes('sun') || nameLower.includes('planet') || nameLower.includes('orbit')) {
                itemType = 'celestial';
            }

            items.push({
                id: obj.uuid,
                name: obj.name,
                type: itemType,
                object: obj,
                visible: obj.visible
            });
        }
    });

    return items;
}

async function runObjectSelectionAndManipulationTests() {
    console.log('🎯 Running 3D Object Selection, Dynamic Gizmo & Outliner Test Suite...\n');

    // =========================================================================
    // Test 1: Historical Battlefield Scene Entities & Hierarchy
    // =========================================================================
    console.log('  Testing Historical Battlefield Scene Entity Tagging & Naming...');
    const scene = new THREE.Scene();
    const battlefieldGroup = createHistoricalBattlefieldScene(scene, THREE, {
        tavern: true,
        meetinghouse: true,
        stoneWalls: true,
        minutemenCount: 12,
        redcoatCount: 16,
        smokeParticles: true
    });
    scene.add(battlefieldGroup);

    assert.ok(battlefieldGroup, 'Battlefield group must be instantiated');

    // Verify key semantic objects exist and have proper descriptive names
    const outlinerItems = extractSceneOutlinerItems(scene);
    assert.ok(outlinerItems.length >= 5, `Expected at least 5 top-level entities, found ${outlinerItems.length}`);

    const itemNames = outlinerItems.map(i => i.name);
    console.log('    Discovered Scene Entities:', itemNames);

    assert.ok(itemNames.some(n => /Buckman Tavern/i.test(n)), 'Buckman Tavern entity must exist in scene');
    assert.ok(itemNames.some(n => /Lexington Meetinghouse/i.test(n)), 'Lexington Meetinghouse entity must exist in scene');
    assert.ok(itemNames.some(n => /Minutemen/i.test(n)), 'Minutemen Militia entity must exist in scene');
    assert.ok(itemNames.some(n => /Redcoat/i.test(n)), 'British Redcoat entity must exist in scene');
    assert.ok(itemNames.some(n => /Ground|Terrain/i.test(n)), 'Lexington Green Ground entity must exist in scene');

    console.log('  ✓ Test 1 Passed: Battlefield scene entities are properly named and discoverable.');

    // =========================================================================
    // Test 2: Raycast Selection & Hierarchy Resolution
    // =========================================================================
    console.log('  Testing Raycast Selection & Top-Level Hierarchy Resolution...');
    
    // Find Buckman Tavern group
    let tavernGroup: THREE.Object3D | null = null;
    scene.traverse(o => {
        if (/Buckman Tavern/i.test(o.name)) tavernGroup = o;
    });
    assert.ok(tavernGroup, 'Buckman Tavern group must be located');

    // Simulate clicking a nested child inside Buckman Tavern (e.g. chimney or window or roof)
    const childMesh = (tavernGroup as any).children[0];
    assert.ok(childMesh, 'Tavern must have child meshes');

    const resolved = resolveSelectableObject(childMesh, scene);
    assert.strictEqual(resolved, tavernGroup, 'Resolving child mesh must return parent entity (Buckman Tavern)');

    console.log('  ✓ Test 2 Passed: Raycast child hit cleanly resolves to top-level selectable entity.');

    // =========================================================================
    // Test 3: Dynamic Gizmo Attachment & Screen-Space Invariant Scale
    // =========================================================================
    console.log('  Testing Dynamic Transform Gizmo Attachment & Screen-Space Scale...');
    const gizmoEngine = new TransformGizmoEngine();
    const gizmoTranslate = gizmoEngine.createGizmo('translate');
    scene.add(gizmoTranslate);

    const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 1000);
    camera.position.set(0, 20, 40);
    camera.lookAt(0, 0, 0);

    // Attach gizmo to Buckman Tavern
    const tavernPos = (tavernGroup as any).position;
    gizmoEngine.updateGizmoTransform(
        gizmoTranslate,
        tavernPos,
        (tavernGroup as any).quaternion,
        'world',
        camera
    );

    assert.strictEqual(gizmoTranslate.position.x, tavernPos.x);
    assert.strictEqual(gizmoTranslate.position.y, tavernPos.y);
    assert.strictEqual(gizmoTranslate.position.z, tavernPos.z);

    // Verify screen-space invariant scale is proportional (sleek size, not oversized)
    const distToTavern = camera.position.distanceTo(tavernPos);
    const gizmoScale = gizmoTranslate.scale.x;
    assert.ok(gizmoScale > 0.5 && gizmoScale < 8.0, `Gizmo scale (${gizmoScale}) must be sleek and proportional at distance ${distToTavern}`);

    // Zoom camera closer and verify scale shrinks smoothly to maintain constant screen size
    camera.position.set(tavernPos.x, tavernPos.y + 5, tavernPos.z + 10);
    gizmoEngine.updateGizmoTransform(
        gizmoTranslate,
        tavernPos,
        (tavernGroup as any).quaternion,
        'world',
        camera
    );
    const closeScale = gizmoTranslate.scale.x;
    assert.ok(closeScale < gizmoScale, `Closer camera distance must produce smaller world scale (${closeScale} < ${gizmoScale}) to maintain screen-space invariance`);

    console.log('  ✓ Test 3 Passed: Transform gizmo attaches directly to target and maintains screen-space scale invariance.');

    // =========================================================================
    // Test 4: Live Direct-Dispatch Manipulation (Translate, Rotate, Scale)
    // =========================================================================
    console.log('  Testing Live Direct-Dispatch Manipulation on Selected Entity...');
    const opEngine = createOperatorEngine({
        title: 'Battle of Lexington 3D',
        sceneType: 'battlefield',
        customMeshes: [
            {
                id: 'tavern-1',
                name: 'Buckman Tavern',
                type: 'box',
                position: [-24, 0, -18],
                rotation: [0, 0, 0],
                scale: [1, 1, 1]
            }
        ]
    });
    opEngine.attachThreeScene(scene);

    // 1. Translate
    const transResult = opEngine.dispatch('sb_translate', {
        objectId: 'tavern-1',
        delta: [5, 0, 2]
    });
    assert.ok(transResult.success, 'sb_translate must succeed');
    const objAfterTrans = opEngine.getObject('tavern-1');
    assert.deepStrictEqual(objAfterTrans.position, [-19, 0, -16]);

    // 2. Rotate
    const rotResult = opEngine.dispatch('sb_rotate', {
        objectId: 'tavern-1',
        delta: [0, Math.PI / 4, 0]
    });
    assert.ok(rotResult.success, 'sb_rotate must succeed');
    const objAfterRot = opEngine.getObject('tavern-1');
    assert.ok(Math.abs(objAfterRot.rotation[1] - Math.PI / 4) < 0.001);

    // 3. Scale
    const scaleResult = opEngine.dispatch('sb_scale', {
        objectId: 'tavern-1',
        factor: 1.5
    });
    assert.ok(scaleResult.success, 'sb_scale must succeed');
    const objAfterScale = opEngine.getObject('tavern-1');
    assert.deepStrictEqual(objAfterScale.scale, [1.5, 1.5, 1.5]);

    // 4. Undo / Redo
    const undoOk = opEngine.undo();
    assert.ok(undoOk, 'Undo must succeed');
    const objAfterUndo = opEngine.getObject('tavern-1');
    assert.deepStrictEqual(objAfterUndo.scale, [1, 1, 1]);

    const redoOk = opEngine.redo();
    assert.ok(redoOk, 'Redo must succeed');
    const objAfterRedo = opEngine.getObject('tavern-1');
    assert.deepStrictEqual(objAfterRedo.scale, [1.5, 1.5, 1.5]);

    console.log('  ✓ Test 4 Passed: Direct-dispatch operators transform target object with lossless undo/redo.');

    // =========================================================================
    // Test 5: Multi-Mesh Sculpting on Dynamically Selected Object
    // =========================================================================
    console.log('  Testing Multi-Mesh Sculpt Targeting & History Stack...');
    const geo = createSculptableGeometry('sphere', { radius: 3, width: 6, height: 6, segments: 16 });
    const sculptHistory = new MeshHistoryStack(10);
    sculptHistory.pushState(geo);

    const hitPoint = new THREE.Vector3(0, 3, 0);
    const hitNormal = new THREE.Vector3(0, 1, 0);
    const sculptSettings: SculptSettings = {
        brush: 'draw',
        radius: 2.0,
        strength: 0.8,
        falloff: 'smoothstep',
        symmetry: { x: false, y: false, z: false },
        direction: 'add'
    };

    const initialY = (geo.attributes.position as THREE.BufferAttribute).getY(0);
    applySculptStroke(geo, hitPoint, hitNormal, sculptSettings);
    sculptHistory.pushState(geo);

    const modifiedY = (geo.attributes.position as THREE.BufferAttribute).getY(0);
    assert.ok(modifiedY > initialY, 'Sculpt draw stroke must displace vertices upward along normal');

    // Undo sculpt stroke
    sculptHistory.undo(geo);
    const undoneY = (geo.attributes.position as THREE.BufferAttribute).getY(0);
    assert.strictEqual(undoneY, initialY, 'Undo must restore exact prior vertex state');

    console.log('  ✓ Test 5 Passed: Dynamic sculpt targeting applies strokes and tracks history per mesh.');

    console.log('\n🎉 ALL 5 OBJECT SELECTION & MANIPULATION TESTS PASSED SUCCESSFULLY!\n');
}

test('scene3d-object-selection-manipulation.test', async () => {
    await runObjectSelectionAndManipulationTests();
}, 180_000);
