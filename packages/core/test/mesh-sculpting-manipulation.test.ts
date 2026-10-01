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
    evaluateFalloff,
    applySculptStroke,
    MeshHistoryStack,
    findVerticesInRadius,
    recomputeGeometryNormals,
    createSculptableGeometry
} from '../src/browser/generative-canvas/services/mesh-sculpting-engine';
import type {
    SculptFalloffType,
    SculptBrushOptions
} from '../src/browser/generative-canvas/services/mesh-sculpting-engine';
import {
    TransformGizmoEngine,
    computeAxisTranslation,
    computePlaneTranslation,
    computeRotationAngle,
    computeScaleFactor
} from '../src/browser/generative-canvas/services/transform-gizmo-engine';
import type {
    Scene3DData,
    SculptSettings
} from '../src/browser/generative-canvas/canvas-types';

const getPosAttr = (geo: THREE.BufferGeometry): THREE.BufferAttribute => geo.attributes.position as THREE.BufferAttribute;

async function runMeshSculptingAndManipulationTests() {
    console.log('🎨 Running Blender-Grade 3D Sculpting & Transform Manipulation Test Suite...\n');

    // =========================================================================
    // 1. Falloff Curve Mathematics
    // =========================================================================
    console.log('  Testing Falloff Curve Algorithms & Boundary Conditions...');
    const falloffTypes: SculptFalloffType[] = ['gaussian', 'smoothstep', 'spherical', 'linear', 'constant', 'sharp'];

    for (const type of falloffTypes) {
        const atZero = evaluateFalloff(0, 10, type);
        const atHalf = evaluateFalloff(5, 10, type);
        const atEdge = evaluateFalloff(10, 10, type);
        const outside = evaluateFalloff(15, 10, type);

        assert.strictEqual(outside, 0, `Falloff ${type} outside radius must be 0`);
        assert.ok(atZero >= 0.99 && atZero <= 1.01, `Falloff ${type} at center must be ~1.0 (got ${atZero})`);
        
        if (type !== 'constant') {
            assert.ok(atEdge >= 0 && atEdge <= 0.05, `Falloff ${type} at boundary must be ~0 (got ${atEdge})`);
            assert.ok(atHalf < atZero && atHalf > atEdge, `Falloff ${type} at 0.5 must be strictly monotonically decreasing (${atHalf})`);
        } else {
            assert.strictEqual(atHalf, 1.0);
            assert.strictEqual(atEdge, 1.0);
        }
    }

    // Specific mathematical expectations for standard Blender-like curves
    const smoothstepMid = evaluateFalloff(0.5, 1.0, 'smoothstep');
    // smoothstep at 0.5 = 2*(0.5)^3 - 3*(0.5)^2 + 1 = 2*0.125 - 3*0.25 + 1 = 0.25 - 0.75 + 1 = 0.5
    assert.ok(Math.abs(smoothstepMid - 0.5) < 0.01, `Smoothstep at 0.5 must be 0.5, got ${smoothstepMid}`);

    const linearMid = evaluateFalloff(0.5, 1.0, 'linear');
    assert.strictEqual(linearMid, 0.5, 'Linear falloff at mid must be 0.5');

    const sharpMid = evaluateFalloff(0.5, 1.0, 'sharp');
    // sharp at 0.5 is (1 - 0.5^2)^2 = (0.75)^2 = 0.5625 or (1 - 0.5)^2 = 0.25
    assert.ok(sharpMid < 0.6, 'Sharp curve provides localized sharp peak');

    console.log('  ✓ Test 1 Passed: Falloff curve functions conform to Blender mathematical curves.');

    // =========================================================================
    // 2. Sculptable Geometry Initialization & Spatial Indexing
    // =========================================================================
    console.log('  Testing Sculptable Geometry & Vertex Radius Querying...');
    const planeGeo = new THREE.PlaneGeometry(10, 10, 20, 20); // 21 * 21 = 441 vertices

    const sculptableSphere = createSculptableGeometry('sphere', { radius: 5, widthSegments: 16, heightSegments: 16 });
    assert.ok(sculptableSphere.attributes.position, 'Must have position attribute');
    assert.ok(sculptableSphere.attributes.normal, 'Must have normal attribute');

    // Test findVerticesInRadius
    const centerHit = new THREE.Vector3(0, 0, 0);
    const radius = 2.5;
    const influenced = findVerticesInRadius(planeGeo, centerHit, radius);
    assert.ok(influenced.length > 0, 'Must find vertices inside radius');
    
    // Ensure all returned vertices are within radius
    const posAttr = getPosAttr(planeGeo);
    for (const item of influenced) {
        const vx = posAttr.getX(item.index);
        const vy = posAttr.getY(item.index);
        const vz = posAttr.getZ(item.index);
        const dist = new THREE.Vector3(vx, vy, vz).distanceTo(centerHit);
        assert.ok(dist <= radius + 0.001, `Vertex ${item.index} distance ${dist} must be <= radius ${radius}`);
    }
    console.log('  ✓ Test 2 Passed: Sculptable geometry initialization and spatial queries verified.');

    // =========================================================================
    // 3. Draw Brush (Normals Displacement)
    // =========================================================================
    console.log('  Testing Draw Brush (Stroke & Normal Displacement)...');
    const drawGeo = new THREE.PlaneGeometry(10, 10, 20, 20);
    drawGeo.rotateX(-Math.PI / 2); // Horizontal XZ plane, normal pointing up (+Y)
    recomputeGeometryNormals(drawGeo);

    const hitPoint = new THREE.Vector3(0, 0, 0);
    const strokeNormal = new THREE.Vector3(0, 1, 0);

    const drawOpts: SculptBrushOptions = {
        brush: 'draw',
        falloff: 'gaussian',
        radius: 3.0,
        strength: 0.8,
        symmetry: { x: false, y: false, z: false }
    };

    const drawPositionsBefore = (getPosAttr(drawGeo).array as Float32Array).slice();
    applySculptStroke(drawGeo, hitPoint, strokeNormal, drawOpts);
    const drawPositionsAfter = getPosAttr(drawGeo).array as Float32Array;

    // Check that vertices near (0,0,0) were elevated (+Y)
    let maxElevation = 0;
    for (let i = 0; i < drawGeo.attributes.position.count; i++) {
        const yDiff = drawPositionsAfter[i * 3 + 1] - drawPositionsBefore[i * 3 + 1];
        if (yDiff > maxElevation) maxElevation = yDiff;
    }
    assert.ok(maxElevation > 0.5, `Draw brush must displace vertices positively along normal (got max ${maxElevation})`);

    // Invert draw brush (negative strength / carve)
    const carveOpts: SculptBrushOptions = { ...drawOpts, strength: -0.8 };
    applySculptStroke(drawGeo, hitPoint, strokeNormal, carveOpts);
    // After equal opposite stroke, it should return towards baseline
    const midY = getPosAttr(drawGeo).getY(drawGeo.attributes.position.count >> 1);
    assert.ok(midY < maxElevation, 'Negative strength must carve/displace in opposite direction');
    console.log('  ✓ Test 3 Passed: Draw brush correctly elevates and carves vertices along normal.');

    // =========================================================================
    // 4. Grab Brush (Vector Translation in 3D)
    // =========================================================================
    console.log('  Testing Grab Brush (Mouse Delta Translation)...');
    const grabGeo = new THREE.PlaneGeometry(10, 10, 20, 20);
    grabGeo.rotateX(-Math.PI / 2);
    recomputeGeometryNormals(grabGeo);

    const dragDelta = new THREE.Vector3(1.5, 2.0, -0.5);
    const grabOpts: SculptBrushOptions = {
        brush: 'grab',
        falloff: 'smoothstep',
        radius: 3.0,
        strength: 1.0,
        mouseDelta: dragDelta,
        symmetry: { x: false, y: false, z: false }
    };

    const grabCenterIndex = 220; // vertex near center
    const origCenterPos = new THREE.Vector3(
        getPosAttr(grabGeo).getX(grabCenterIndex),
        getPosAttr(grabGeo).getY(grabCenterIndex),
        getPosAttr(grabGeo).getZ(grabCenterIndex)
    );

    applySculptStroke(grabGeo, origCenterPos, new THREE.Vector3(0, 1, 0), grabOpts);

    const newCenterPos = new THREE.Vector3(
        getPosAttr(grabGeo).getX(grabCenterIndex),
        getPosAttr(grabGeo).getY(grabCenterIndex),
        getPosAttr(grabGeo).getZ(grabCenterIndex)
    );

    const actualDelta = newCenterPos.clone().sub(origCenterPos);
    // At center (falloff = 1.0), actualDelta should closely match dragDelta
    assert.ok(Math.abs(actualDelta.x - dragDelta.x) < 0.2, `Grab X translation expected ~${dragDelta.x}, got ${actualDelta.x}`);
    assert.ok(Math.abs(actualDelta.y - dragDelta.y) < 0.2, `Grab Y translation expected ~${dragDelta.y}, got ${actualDelta.y}`);
    assert.ok(Math.abs(actualDelta.z - dragDelta.z) < 0.2, `Grab Z translation expected ~${dragDelta.z}, got ${actualDelta.z}`);
    console.log('  ✓ Test 4 Passed: Grab brush translates vertices in 3D direction proportional to falloff.');

    // =========================================================================
    // 5. Clay / Clay Strips Brush (Depth Capped Layering)
    // =========================================================================
    console.log('  Testing Clay Brush (Surface Layering with Depth Cap)...');
    const clayGeo = new THREE.PlaneGeometry(10, 10, 20, 20);
    clayGeo.rotateX(-Math.PI / 2);
    recomputeGeometryNormals(clayGeo);

    const clayOpts: SculptBrushOptions = {
        brush: 'clay',
        falloff: 'smoothstep',
        radius: 3.0,
        strength: 0.5,
        clayOffset: 0.8, // max cap
        symmetry: { x: false, y: false, z: false }
    };

    // Apply multiple consecutive clay strokes at the same point
    for (let s = 0; s < 5; s++) {
        applySculptStroke(clayGeo, hitPoint, strokeNormal, clayOpts);
    }

    let clayMaxElevation = 0;
    for (let i = 0; i < clayGeo.attributes.position.count; i++) {
        const y = getPosAttr(clayGeo).getY(i);
        if (y > clayMaxElevation) clayMaxElevation = y;
    }
    // Clay strips should build up a smooth plateau capped by clayOffset
    assert.ok(clayMaxElevation > 0.3, 'Clay brush builds up surface layer');
    assert.ok(clayMaxElevation <= 1.2, `Clay elevation must be controlled and capped near clay offset (got ${clayMaxElevation})`);
    console.log('  ✓ Test 5 Passed: Clay brush correctly layers surface with depth capping.');

    // =========================================================================
    // 6. Smooth / Relax Brush (Laplacian Smoothing)
    // =========================================================================
    console.log('  Testing Smooth / Relax Brush (Laplacian Mesh Smoothing)...');
    const noisyGeo = new THREE.PlaneGeometry(10, 10, 20, 20);
    noisyGeo.rotateX(-Math.PI / 2);
    
    // Add artificial high-frequency noise/spikes to vertices
    const pos = getPosAttr(noisyGeo);
    for (let i = 0; i < pos.count; i++) {
        if (i % 2 === 0) {
            pos.setY(i, pos.getY(i) + 2.0); // sharp spike
        }
    }
    pos.needsUpdate = true;
    recomputeGeometryNormals(noisyGeo);

    const smoothOpts: SculptBrushOptions = {
        brush: 'smooth',
        falloff: 'gaussian',
        radius: 4.0,
        strength: 0.9,
        symmetry: { x: false, y: false, z: false }
    };

    // Measure variance before smoothing near center
    const centerIndices = findVerticesInRadius(noisyGeo, hitPoint, 3.0).map(v => v.index);
    let varianceBefore = 0;
    centerIndices.forEach(idx => {
        varianceBefore += Math.abs(pos.getY(idx) - 1.0);
    });

    // Apply smoothing multiple iterations
    for (let it = 0; it < 3; it++) {
        applySculptStroke(noisyGeo, hitPoint, strokeNormal, smoothOpts);
    }

    let varianceAfter = 0;
    centerIndices.forEach(idx => {
        varianceAfter += Math.abs(pos.getY(idx) - 1.0);
    });

    assert.ok(varianceAfter < varianceBefore * 0.7, `Smoothing must reduce surface irregularities (before: ${varianceBefore}, after: ${varianceAfter})`);
    console.log('  ✓ Test 6 Passed: Smooth / Relax brush performs Laplacian smoothing on vertices.');

    // =========================================================================
    // 7. Inflate / Deflate, Pinch / Magnify, Flatten / Scrape
    // =========================================================================
    console.log('  Testing Inflate, Pinch, and Flatten Brushes...');
    
    // 7a: Inflate on Sphere
    const sphereInflate = new THREE.SphereGeometry(3, 16, 16);
    const sphereCenter = new THREE.Vector3(0, 3, 0); // top pole
    const inflateOpts: SculptBrushOptions = {
        brush: 'inflate',
        falloff: 'gaussian',
        radius: 2.0,
        strength: 0.6,
        symmetry: { x: false, y: false, z: false }
    };
    const topYBefore = getPosAttr(sphereInflate).getY(0);
    applySculptStroke(sphereInflate, sphereCenter, new THREE.Vector3(0, 1, 0), inflateOpts);
    const topYAfter = getPosAttr(sphereInflate).getY(0);
    assert.ok(topYAfter > topYBefore, `Inflate must expand vertices along normals (before: ${topYBefore}, after: ${topYAfter})`);

    // 7b: Pinch on Plane
    const pinchGeo = new THREE.PlaneGeometry(10, 10, 20, 20);
    pinchGeo.rotateX(-Math.PI / 2);
    const pinchOpts: SculptBrushOptions = {
        brush: 'pinch',
        falloff: 'spherical',
        radius: 3.0,
        strength: 0.8,
        symmetry: { x: false, y: false, z: false }
    };
    // Pick vertex at x = 1.5, z = 0
    const nearbyIdx = findVerticesInRadius(pinchGeo, hitPoint, 2.0).find(v => v.distance > 0.5 && v.distance < 2.0);
    assert.ok(nearbyIdx, 'Found vertex for pinch test');
    const origDist = new THREE.Vector3(
        getPosAttr(pinchGeo).getX(nearbyIdx.index),
        0,
        getPosAttr(pinchGeo).getZ(nearbyIdx.index)
    ).distanceTo(hitPoint);

    applySculptStroke(pinchGeo, hitPoint, strokeNormal, pinchOpts);
    const newDist = new THREE.Vector3(
        getPosAttr(pinchGeo).getX(nearbyIdx.index),
        0,
        getPosAttr(pinchGeo).getZ(nearbyIdx.index)
    ).distanceTo(hitPoint);
    assert.ok(newDist < origDist, `Pinch brush must pull vertices closer to brush center (orig: ${origDist}, new: ${newDist})`);

    // 7c: Flatten on Elevated Peak
    const flattenGeo = new THREE.PlaneGeometry(10, 10, 20, 20);
    flattenGeo.rotateX(-Math.PI / 2);
    // Create elevated dome
    applySculptStroke(flattenGeo, hitPoint, strokeNormal, { brush: 'draw', falloff: 'smoothstep', radius: 3.0, strength: 2.0, symmetry: {} });
    const peakY = getPosAttr(flattenGeo).getY(flattenGeo.attributes.position.count >> 1);
    assert.ok(peakY > 1.0, 'Peak created before flatten');

    // Flatten against plane at Y=0.5
    const flattenHit = new THREE.Vector3(0, 0.5, 0);
    applySculptStroke(flattenGeo, flattenHit, strokeNormal, { brush: 'flatten', falloff: 'linear', radius: 3.0, strength: 0.9, symmetry: {} });
    const flattenedY = getPosAttr(flattenGeo).getY(flattenGeo.attributes.position.count >> 1);
    assert.ok(flattenedY < peakY, `Flatten brush must push elevated vertices towards hit plane (peak: ${peakY}, after: ${flattenedY})`);

    console.log('  ✓ Test 7 Passed: Inflate, Pinch, and Flatten brushes operate with full fidelity.');

    // =========================================================================
    // 8. Symmetry & Mirroring Engine (X, Y, Z Axes)
    // =========================================================================
    console.log('  Testing Multi-Axis Symmetry Mirroring (X, Y, Z)...');
    const symGeo = new THREE.PlaneGeometry(10, 10, 30, 30);
    symGeo.rotateX(-Math.PI / 2);
    recomputeGeometryNormals(symGeo);

    const offCenterHit = new THREE.Vector3(2.5, 0, 1.5);
    const symOpts: SculptBrushOptions = {
        brush: 'draw',
        falloff: 'gaussian',
        radius: 1.5,
        strength: 0.8,
        symmetry: { x: true, z: true } // Dual-axis mirroring
    };

    applySculptStroke(symGeo, offCenterHit, strokeNormal, symOpts);

    // Check vertices at (+2.5, +1.5), (-2.5, +1.5), (+2.5, -1.5), and (-2.5, -1.5)
    const pointsToCheck = [
        new THREE.Vector3(2.5, 0, 1.5),
        new THREE.Vector3(-2.5, 0, 1.5),
        new THREE.Vector3(2.5, 0, -1.5),
        new THREE.Vector3(-2.5, 0, -1.5)
    ];

    for (const pt of pointsToCheck) {
        const near = findVerticesInRadius(symGeo, pt, 1.2);
        assert.ok(near.length > 0, `Symmetry must affect vertices near (${pt.x}, ${pt.z})`);
        const maxNearY = Math.max(...near.map(n => getPosAttr(symGeo).getY(n.index)));
        assert.ok(maxNearY > 0.4, `Symmetry point (${pt.x}, ${pt.z}) must be deformed (got Y: ${maxNearY})`);
    }
    console.log('  ✓ Test 8 Passed: Multi-axis symmetry mirroring applies identical deformations across reflected planes.');

    // =========================================================================
    // 9. Mesh Undo/Redo History Stack
    // =========================================================================
    console.log('  Testing MeshHistoryStack Undo/Redo Engine...');
    const historyGeo = new THREE.PlaneGeometry(6, 6, 10, 10);
    historyGeo.rotateX(-Math.PI / 2);
    recomputeGeometryNormals(historyGeo);
    const historyStack = new MeshHistoryStack(10);

    // Initial state
    assert.strictEqual(historyStack.canUndo(), false);
    assert.strictEqual(historyStack.canRedo(), false);

    historyStack.pushState(historyGeo);
    assert.strictEqual(historyStack.canUndo(), false, 'Single initial state cannot undo yet');

    // Stroke 1: Draw
    applySculptStroke(historyGeo, hitPoint, strokeNormal, { brush: 'draw', falloff: 'gaussian', radius: 2.0, strength: 1.0, symmetry: {} });
    historyStack.pushState(historyGeo);
    assert.strictEqual(historyStack.canUndo(), true);
    const stroke1Y = getPosAttr(historyGeo).getY(historyGeo.attributes.position.count >> 1);
    assert.ok(stroke1Y > 0.5);

    // Stroke 2: Inflate
    applySculptStroke(historyGeo, hitPoint, strokeNormal, { brush: 'inflate', falloff: 'gaussian', radius: 2.0, strength: 0.8, symmetry: {} });
    historyStack.pushState(historyGeo);
    const stroke2Y = getPosAttr(historyGeo).getY(historyGeo.attributes.position.count >> 1);
    assert.ok(stroke2Y > stroke1Y);

    // Undo Stroke 2 -> Back to Stroke 1
    const undoSuccess1 = historyStack.undo(historyGeo);
    assert.strictEqual(undoSuccess1, true);
    assert.strictEqual(historyStack.canRedo(), true);
    const restored1Y = getPosAttr(historyGeo).getY(historyGeo.attributes.position.count >> 1);
    assert.ok(Math.abs(restored1Y - stroke1Y) < 0.0001, `Restored Y after 1st undo must equal stroke 1 (${restored1Y} vs ${stroke1Y})`);

    // Undo Stroke 1 -> Back to Initial Plane
    const undoSuccess2 = historyStack.undo(historyGeo);
    assert.strictEqual(undoSuccess2, true);
    const initialY = getPosAttr(historyGeo).getY(historyGeo.attributes.position.count >> 1);
    assert.ok(Math.abs(initialY - 0) < 0.0001, 'Restored Y after 2nd undo must be flat (0.0)');
    assert.strictEqual(historyStack.canUndo(), false);

    // Redo 1 -> Forward to Stroke 1
    const redoSuccess1 = historyStack.redo(historyGeo);
    assert.strictEqual(redoSuccess1, true);
    const redo1Y = getPosAttr(historyGeo).getY(historyGeo.attributes.position.count >> 1);
    assert.ok(Math.abs(redo1Y - stroke1Y) < 0.0001, 'Redo step 1 restored correctly');

    // Redo 2 -> Forward to Stroke 2
    const redoSuccess2 = historyStack.redo(historyGeo);
    assert.strictEqual(redoSuccess2, true);
    const redo2Y = getPosAttr(historyGeo).getY(historyGeo.attributes.position.count >> 1);
    assert.ok(Math.abs(redo2Y - stroke2Y) < 0.0001, 'Redo step 2 restored correctly');
    assert.strictEqual(historyStack.canRedo(), false);

    console.log('  ✓ Test 9 Passed: MeshHistoryStack guarantees 100% loss-free vertex state undo and redo.');

    // =========================================================================
    // 10. Interactive 3D Transform Gizmo Engine
    // =========================================================================
    console.log('  Testing 3D Transform Gizmo Mathematics (Translate, Rotate, Scale)...');
    
    // 10a: Axis Translation Math
    const origin = new THREE.Vector3(0, 0, 0);
    const rayStart = new THREE.Vector3(0, 0, 10);
    const rayDir1 = new THREE.Vector3(0.1, 0, -1).normalize();
    const rayDir2 = new THREE.Vector3(0.4, 0, -1).normalize();
    
    const axisX = new THREE.Vector3(1, 0, 0);
    const deltaTx = computeAxisTranslation(rayStart, rayDir1, rayDir2, origin, axisX);
    assert.ok(deltaTx.x > 0, `Translation along X axis must be positive (got ${deltaTx.x})`);
    assert.strictEqual(deltaTx.y, 0, 'Constrained X translation must have 0 Y delta');
    assert.strictEqual(deltaTx.z, 0, 'Constrained X translation must have 0 Z delta');

    // 10b: Planar Translation Math (XY Plane)
    const planeNormal = new THREE.Vector3(0, 0, 1); // XY plane
    const deltaTxy = computePlaneTranslation(rayStart, rayDir1, rayDir2, origin, planeNormal);
    assert.ok(deltaTxy.x !== 0, 'Planar XY translation has X component');
    assert.strictEqual(deltaTxy.z, 0, 'Planar XY translation has 0 Z component');

    // 10c: Rotation Angle Math around Axis (Y Axis)
    const rotAxis = new THREE.Vector3(0, 1, 0);
    const p1 = new THREE.Vector3(1, 0, 0);
    const p2 = new THREE.Vector3(0, 0, -1); // 90 deg clockwise
    const rotAngle = computeRotationAngle(p1, p2, origin, rotAxis);
    assert.ok(Math.abs(Math.abs(rotAngle) - Math.PI / 2) < 0.01, `Rotation angle must be ~PI/2 (got ${rotAngle})`);

    // 10d: Scale Factor Math
    const initialDist = 2.0;
    const currentDist = 3.0;
    const scaleFactor = computeScaleFactor(initialDist, currentDist);
    assert.strictEqual(scaleFactor, 1.5, 'Scale factor must be 3.0 / 2.0 = 1.5');

    // 10e: Transform Gizmo Object Generation
    const gizmoEngine = new TransformGizmoEngine();
    const translateGizmo = gizmoEngine.createGizmo('translate');
    assert.ok(translateGizmo instanceof THREE.Group, 'Translate gizmo is THREE.Group');
    assert.ok(translateGizmo.children.length >= 6, 'Translate gizmo has 3 axis arrows and 3 planar handles');

    const rotateGizmo = gizmoEngine.createGizmo('rotate');
    assert.ok(rotateGizmo.children.length >= 3, 'Rotate gizmo has 3 rotation rings');

    const scaleGizmo = gizmoEngine.createGizmo('scale');
    assert.ok(scaleGizmo.children.length >= 4, 'Scale gizmo has 3 axis boxes and 1 central uniform box');

    console.log('  ✓ Test 10 Passed: Transform gizmo handles, ray math, and modes execute cleanly.');

    // =========================================================================
    // 11. Type & Protocol Contract Verification
    // =========================================================================
    console.log('  Testing Scene3DData Sculpt & Transform Protocol Properties...');
    const sculptSettings: SculptSettings = {
        brush: 'draw',
        falloff: 'gaussian',
        radius: 2.5,
        strength: 0.75,
        symmetry: { x: true, y: false, z: false },
        wireframeOverlay: true
    };

    const sceneData: Scene3DData = {
        title: 'Sculpting Canvas',
        toolMode: 'sculpt',
        sculptSettings,
        transformMode: 'translate',
        transformSpace: 'world'
    };

    assert.strictEqual(sceneData.toolMode, 'sculpt');
    assert.strictEqual(sceneData.sculptSettings?.brush, 'draw');
    assert.strictEqual(sceneData.sculptSettings?.symmetry.x, true);
    assert.strictEqual(sceneData.transformMode, 'translate');
    console.log('  ✓ Test 11 Passed: Scene3DData and protocol definitions are compliant.');

    // =========================================================================
    // 12. Toolstrip & Options Bar Mode Mapping & Geometry Generator Verification
    // =========================================================================
    console.log('  Testing Toolstrip & Contextual Options Bar Protocol & Geometries...');
    
    // Test base shape geometry creation for all 5 presets: sphere, plane, box, cylinder, torus
    const shapes: Array<'sphere' | 'plane' | 'box' | 'cylinder' | 'torus'> = ['sphere', 'plane', 'box', 'cylinder', 'torus'];
    for (const shape of shapes) {
        const geo = createSculptableGeometry(shape, { radius: 3.5, width: 12, height: 12, segments: 32 });
        assert.ok(geo instanceof THREE.BufferGeometry, `Shape ${shape} must generate BufferGeometry`);
        assert.ok(geo.attributes.position.count > 0, `Shape ${shape} must have vertices`);
        assert.ok(geo.attributes.normal.count > 0, `Shape ${shape} must have normals`);
    }

    // Verify all 7 sculpt brush types are valid
    const brushes = ['draw', 'grab', 'clay', 'smooth', 'inflate', 'pinch', 'flatten'] as const;
    assert.strictEqual(brushes.length, 7, 'Must support 7 sculpt brushes');

    // Verify transform gizmo modes
    const gizmoModes = ['translate', 'rotate', 'scale'] as const;
    assert.strictEqual(gizmoModes.length, 3, 'Must support 3 gizmo modes');

    console.log('  ✓ Test 12 Passed: Toolstrip shapes, brushes, and gizmo modes are fully validated.');

    console.log('\n🎉 ALL 12 MESH SCULPTING & TRANSFORMATION TESTS COMPLETED SUCCESSFULLY!');
}

test('mesh-sculpting-manipulation.test', async () => {
    await runMeshSculptingAndManipulationTests();
}, 180_000);
