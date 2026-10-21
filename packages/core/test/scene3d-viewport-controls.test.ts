/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Behavioural tests for the Scene3D viewport pointer controls, driven through real listeners
 * on a minimal DOM stand-in (Node's EventTarget) with a real camera, scene graph and raycaster.
 * No WebGL context is needed: picking, orbit and gizmo commits are pure three.js math.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
    attachViewportControls,
    readWorldPose,
    stepCamera,
    CLICK_TRAVEL_PX,
    WHEEL_ZOOM_RATE
} from '../src/browser/generative-canvas/primitives/scene3d/attachViewportControls';
import type { ViewportControlContext } from '../src/browser/generative-canvas/primitives/scene3d/attachViewportControls';
import { resolveSelectableObject, EXTERNAL_OBJECT_ROOT_PREFIX } from '../src/browser/generative-canvas/primitives/scene3d/selection';
import type { Scene3DData, SculptSettings } from '../src/browser/generative-canvas/canvas-types';
import type { RendererStack } from '../src/browser/generative-canvas/primitives/scene3d/types';
import { saveViewportSnapshot } from './helpers/scene3d-viewport-snapshot';

const W = 800;
const H = 600;
const CX = W / 2;
const CY = H / 2;

/** The layout reads attachViewportControls performs on its container, on top of a real EventTarget. */
class FakeViewportElement extends EventTarget {
    clientWidth = W;
    clientHeight = H;
    getBoundingClientRect() {
        return { left: 0, top: 0, right: W, bottom: H, width: W, height: H, x: 0, y: 0, toJSON: () => ({}) };
    }
}

function fire(target: EventTarget, type: string, init: Record<string, unknown> = {}): Event {
    const ev = new Event(type, { cancelable: true });
    Object.assign(ev, { clientX: CX, clientY: CY, button: 0, shiftKey: false, deltaY: 0, deltaMode: 0, ...init });
    target.dispatchEvent(ev);
    return ev;
}

/** A camera-facing square built from raw buffers (no primitive constructors). */
function quad(name: string, size: number, z: number): THREE.Mesh {
    const h = size / 2;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([
        -h, -h, 0, h, -h, 0, h, h, 0,
        -h, -h, 0, h, h, 0, -h, h, 0
    ], 3));
    const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
    mesh.name = name;
    mesh.position.z = z;
    return mesh;
}

function modelRoot(objectId: string, ...parts: THREE.Object3D[]): THREE.Group {
    const root = new THREE.Group();
    root.name = `${EXTERNAL_OBJECT_ROOT_PREFIX}${objectId}`;
    parts.forEach(p => root.add(p));
    return root;
}

interface Harness {
    container: FakeViewportElement;
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    ctx: ViewportControlContext;
    selections: Array<THREE.Object3D | null>;
    mutations: Array<{ operator?: string }>;
    data: () => Scene3DData;
    detach: () => void;
}

function createHarness(initialData: Partial<Scene3DData> = {}): Harness {
    const container = new FakeViewportElement();
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, W / H, 0.1, 20000);
    camera.position.set(0, 0, 10);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    camera.updateProjectionMatrix();

    let data: Scene3DData = { title: 'controls-test', ...initialData };
    const selections: Array<THREE.Object3D | null> = [];
    const mutations: Array<{ operator?: string }> = [];
    const selectedObject = { current: null as THREE.Object3D | null };

    const ctx: ViewportControlContext = {
        cameraMode: { current: 'orbit' },
        toolMode: { current: 'view' },
        transformMode: { current: 'translate' },
        transformSpace: { current: 'world' },
        sculptSettings: { current: { brush: 'draw', falloff: 'gaussian', radius: 2, strength: 0.5, symmetry: { x: false, y: false, z: false } } as SculptSettings },
        orbit: { current: { theta: 0, phi: Math.PI / 2, distance: 10 } },
        target: { current: new THREE.Vector3() },
        keysPressed: { current: {} },
        gizmoEngine: { current: { hitTest: () => null } as any },
        gizmoGroup: { current: null },
        selectedObject,
        sculptMesh: { current: null },
        brushCursor: { current: null },
        selectionBox: { current: null },
        ignoredPickObjects: () => [],
        resolveSelectableObject,
        selectObject: { current: (obj) => { selections.push(obj); selectedObject.current = obj; } },
        mutateSceneData: { current: (mutator, opInfo) => { data = mutator(data); mutations.push({ operator: opInfo?.operator }); } },
        setSelectedObjectId: () => undefined,
        setSelectedObjectName: () => undefined,
        recordEdit: { current: () => undefined }
    };

    const stack = { container, scene, camera } as unknown as RendererStack;
    const detach = attachViewportControls(stack, ctx);
    return { container, scene, camera, ctx, selections, mutations, data: () => data, detach };
}

/** Client pixel of a world point as seen through the harness camera. */
function toClient(h: Harness, world: THREE.Vector3): { x: number; y: number } {
    const ndc = world.clone().project(h.camera);
    return { x: (ndc.x * 0.5 + 0.5) * W, y: (1 - (ndc.y * 0.5 + 0.5)) * H };
}

/** A part nested in a model root that was placed by spatial3d (x, yaw) and lifted by a ground snap. */
function movedModelWithPart(h: Harness): { root: THREE.Group; part: THREE.Mesh } {
    const part = quad('Hero_Part', 1.5, 0);
    part.position.set(0, 0, 1); // local offset inside the model
    const root = modelRoot('stage-a', part);
    root.position.set(3, 0.5, 0);
    root.rotation.set(0, Math.PI / 2, 0);
    h.scene.add(root);
    h.scene.updateMatrixWorld(true);
    return { root, part };
}

function click(h: Harness, x = CX, y = CY, init: Record<string, unknown> = {}): void {
    fire(h.container, 'mousedown', { clientX: x, clientY: y, ...init });
    fire(window, 'mouseup', { clientX: x, clientY: y, ...init });
}

describe('Scene3D viewport controls', () => {
    let h: Harness;

    beforeEach(() => {
        (globalThis as any).window = new EventTarget();
    });

    afterEach(() => {
        h?.detach();
        delete (globalThis as any).window;
    });

    it('zooms exponentially: the same wheel delta scales any distance by the same ratio', () => {
        h = createHarness();
        h.ctx.orbit.current.distance = 1000;
        const ev = fire(h.container, 'wheel', { deltaY: -500 });
        expect(ev.defaultPrevented).toBe(true);
        expect(h.ctx.orbit.current.distance).toBeCloseTo(1000 * Math.exp(-500 * WHEEL_ZOOM_RATE), 6);
        expect(h.ctx.orbit.current.distance / 1000).toBeCloseTo(Math.exp(-0.6), 6); // ~0.549

        h.ctx.orbit.current.distance = 3;
        fire(h.container, 'wheel', { deltaY: -500 });
        expect(h.ctx.orbit.current.distance / 3).toBeCloseTo(Math.exp(-0.6), 6);

        // Zooming back out restores the distance; zooming in is floored at 1 m.
        fire(h.container, 'wheel', { deltaY: 500 });
        expect(h.ctx.orbit.current.distance).toBeCloseTo(3, 6);
        fire(h.container, 'wheel', { deltaY: -100000 });
        expect(h.ctx.orbit.current.distance).toBe(1);
    });

    it('never pulls a camera that is already beyond the zoom cap inward on zoom-out', () => {
        h = createHarness();
        h.ctx.orbit.current.distance = 9000; // beyond max(2500, far / 4 = 5000)
        fire(h.container, 'wheel', { deltaY: 300 });
        expect(h.ctx.orbit.current.distance).toBe(9000);
        fire(h.container, 'wheel', { deltaY: -300 });
        expect(h.ctx.orbit.current.distance).toBeLessThan(9000);
    });

    it('a drag orbits the camera and does not select', () => {
        h = createHarness();
        h.scene.add(modelRoot('stage-a', quad('Hero_Part', 4, 0)));
        h.scene.updateMatrixWorld(true);

        fire(h.container, 'mousedown', { clientX: CX, clientY: CY });
        fire(h.container, 'mousemove', { clientX: CX + 20, clientY: CY });
        fire(window, 'mouseup', { clientX: CX + 20, clientY: CY });

        expect(h.selections).toEqual([]);
        expect(h.mutations).toEqual([]);
        expect(h.ctx.orbit.current.theta).toBeCloseTo(-20 * 0.005, 9);
    });

    it('a click (< CLICK_TRAVEL_PX travel) selects the part under the cursor, not the model root', () => {
        h = createHarness();
        const part = quad('Hero_Part', 4, 0);
        h.scene.add(modelRoot('stage-a', part));
        h.scene.updateMatrixWorld(true);

        fire(h.container, 'mousedown', { clientX: CX, clientY: CY });
        fire(window, 'mouseup', { clientX: CX + CLICK_TRAVEL_PX - 1, clientY: CY });

        expect(h.selections).toEqual([part]);
        expect(h.selections[0]?.name).toBe('Hero_Part');
    });

    it('meshes under a hidden ancestor are not pickable; the visible mesh behind them is', () => {
        h = createHarness();
        const hiddenPart = quad('HiddenPart', 4, 2); // nearer the camera
        const hiddenRoot = modelRoot('stage-hidden', hiddenPart);
        hiddenRoot.visible = false;
        const visiblePart = quad('VisiblePart', 4, 0);
        h.scene.add(hiddenRoot, modelRoot('stage-visible', visiblePart));
        h.scene.updateMatrixWorld(true);

        // Sanity: three's raycaster itself ignores `visible`, so the hidden part is the first hit.
        const raycaster = new THREE.Raycaster();
        raycaster.setFromCamera(new THREE.Vector2(0, 0), h.camera);
        expect(raycaster.intersectObjects(h.scene.children, true)[0].object).toBe(hiddenPart);

        click(h);
        expect(h.selections).toEqual([visiblePart]);
    });

    it('userData.isHelper marks an object unpickable (an environment helper, like the atmosphere sky dome, that a user never selects)', () => {
        h = createHarness();
        const helperPart = quad('EnvironmentHelper', 4, 2); // nearer the camera
        helperPart.userData.isHelper = true;
        const visiblePart = quad('VisiblePart', 4, 0);
        h.scene.add(helperPart, modelRoot('stage-visible', visiblePart));
        h.scene.updateMatrixWorld(true);

        // Sanity: three's raycaster has no opinion on userData, so the helper is the first real hit.
        const raycaster = new THREE.Raycaster();
        raycaster.setFromCamera(new THREE.Vector2(0, 0), h.camera);
        expect(raycaster.intersectObjects(h.scene.children, true)[0].object).toBe(helperPart);

        click(h);
        expect(h.selections).toEqual([visiblePart]);
    });

    it('a click on empty space clears a visible selection', () => {
        h = createHarness();
        h.scene.add(modelRoot('stage-a', quad('Hero_Part', 1, 0)));
        h.scene.updateMatrixWorld(true);
        h.ctx.selectionBox.current = { visible: true } as unknown as THREE.BoxHelper;

        click(h, 10, 10);
        expect(h.selections).toEqual([null]);
    });

    it('shift-drag and right-drag pan the orbit target in the screen plane without selecting; shift-click still selects', () => {
        h = createHarness();
        h.scene.add(modelRoot('stage-a', quad('Hero_Part', 4, 0)));
        h.scene.updateMatrixWorld(true);
        const worldPerPx = (2 * 10 * Math.tan(THREE.MathUtils.degToRad(45) / 2)) / H;

        fire(h.container, 'mousedown', { clientX: CX, clientY: CY, shiftKey: true });
        fire(h.container, 'mousemove', { clientX: CX + 100, clientY: CY, shiftKey: true });
        fire(window, 'mouseup', { clientX: CX + 100, clientY: CY, shiftKey: true });
        // Camera looks down -Z with +X to its right: dragging right moves the pivot left.
        expect(h.ctx.target.current.x).toBeCloseTo(-100 * worldPerPx, 6);
        expect(h.ctx.target.current.y).toBeCloseTo(0, 9);
        expect(h.ctx.orbit.current.theta).toBe(0);

        h.ctx.target.current.set(0, 0, 0);
        fire(h.container, 'mousedown', { clientX: CX, clientY: CY, button: 2 });
        fire(h.container, 'mousemove', { clientX: CX, clientY: CY + 50, button: 2 });
        fire(window, 'mouseup', { clientX: CX, clientY: CY + 50, button: 2 });
        // Dragging down moves the pivot up.
        expect(h.ctx.target.current.y).toBeCloseTo(50 * worldPerPx, 6);
        expect(h.ctx.target.current.x).toBeCloseTo(0, 9);

        // A right press-release without travel is not a pick; shift only turns a primary DRAG into
        // a pan, so a shift-click without travel still selects.
        const pivotBefore = h.ctx.target.current.clone();
        click(h, CX, CY, { button: 2 });
        expect(h.selections).toEqual([]);
        click(h, CX, CY, { shiftKey: true });
        expect(h.selections.map(s => s?.name)).toEqual(['Hero_Part']);
        expect(h.ctx.target.current.equals(pivotBefore)).toBe(true);

        // Right-drag pans in orbit mode, so the native menu is suppressed there and only there.
        expect(fire(h.container, 'contextmenu').defaultPrevented).toBe(true);
        h.ctx.cameraMode.current = 'fps';
        expect(fire(h.container, 'contextmenu').defaultPrevented).toBe(false);
    });

    it('a gizmo commit on a model root writes objects[].space.spatial3d in degrees and no customMeshes entry', () => {
        h = createHarness({
            objects: [{
                id: 'stage-a',
                content: { type: '3d-model', durableUri: '/models/stage_a.glb', mimeType: 'model/gltf-binary' },
                space: { spatial3d: { x: 0, y: 0, z: 0 } }
            }]
        });
        const root = modelRoot('stage-a', quad('Hero_Part', 4, 0));
        h.scene.add(root);
        h.scene.updateMatrixWorld(true);
        h.ctx.toolMode.current = 'transform';
        h.ctx.gizmoGroup.current = new THREE.Group();
        h.ctx.gizmoEngine.current = { hitTest: () => ({ handleType: 'axis-x' }) } as any;
        h.ctx.selectedObject.current = root;

        fire(h.container, 'mousedown', { clientX: CX, clientY: CY });
        fire(h.container, 'mousemove', { clientX: CX + 60, clientY: CY });
        expect(root.position.x).toBeGreaterThan(0.5);
        root.rotation.set(0, Math.PI / 2, 0); // a rotation already applied by an earlier drag
        fire(window, 'mouseup', { clientX: CX + 60, clientY: CY });

        const written = h.data();
        expect(h.mutations).toEqual([{ operator: 'sb_translate' }]);
        expect(written.customMeshes).toBeUndefined();
        const s = written.objects![0].space.spatial3d!;
        expect(s.x).toBeCloseTo(root.position.x, 9);
        expect(s.yaw).toBeCloseTo(90, 9);
        expect(s.pitch).toBeCloseTo(0, 9);
        expect(h.selections).toEqual([]); // the gizmo drag is not a pick
    });

    it('a gizmo commit on a part inside a model persists nothing (no phantom customMeshes)', () => {
        h = createHarness({ objects: [] });
        const part = quad('Hero_Part', 4, 0);
        h.scene.add(modelRoot('stage-a', part));
        h.scene.updateMatrixWorld(true);
        h.ctx.toolMode.current = 'transform';
        h.ctx.gizmoGroup.current = new THREE.Group();
        h.ctx.gizmoEngine.current = { hitTest: () => ({ handleType: 'axis-y' }) } as any;
        h.ctx.selectedObject.current = part;

        fire(h.container, 'mousedown', { clientX: CX, clientY: CY });
        fire(h.container, 'mousemove', { clientX: CX, clientY: CY - 40 });
        fire(window, 'mouseup', { clientX: CX, clientY: CY - 40 });

        expect(part.position.y).toBeGreaterThan(0.1); // the live edit still happened
        expect(h.mutations).toEqual([]);
        expect(h.data().customMeshes).toBeUndefined();
    });

    it('places the gizmo at a nested part\'s world pose and drags it along world axes', () => {
        h = createHarness({ objects: [] });
        const { root, part } = movedModelWithPart(h);

        // The viewport places the gizmo from readWorldPose. The part's local position (0, 0, 1) is
        // nowhere near where it is drawn: yaw 90 maps local +Z to world +X, then the root offset applies.
        const gizmoPos = new THREE.Vector3();
        const gizmoQuat = new THREE.Quaternion();
        readWorldPose(part, gizmoPos, gizmoQuat);
        expect(gizmoPos.x).toBeCloseTo(4, 9);
        expect(gizmoPos.y).toBeCloseTo(0.5, 9);
        expect(gizmoPos.z).toBeCloseTo(0, 9);
        expect(gizmoPos.distanceTo(part.position)).toBeGreaterThan(3);
        expect(gizmoQuat.angleTo(root.quaternion)).toBeCloseTo(0, 9);

        h.ctx.toolMode.current = 'transform';
        h.ctx.gizmoGroup.current = new THREE.Group();
        h.ctx.gizmoEngine.current = { hitTest: () => ({ handleType: 'axis-x' }) } as any;
        h.ctx.selectedObject.current = part;
        const start = toClient(h, gizmoPos);
        fire(h.container, 'mousedown', { clientX: start.x, clientY: start.y });
        fire(h.container, 'mousemove', { clientX: start.x + 80, clientY: start.y });
        fire(window, 'mouseup', { clientX: start.x + 80, clientY: start.y });

        // Dragging the world X handle moves the part along WORLD +X only (in the root's local frame
        // the same edit would have sent it along world -Z), and the result is stored parent-relative.
        const after = new THREE.Vector3();
        part.getWorldPosition(after);
        expect(after.x).toBeGreaterThan(4.5);
        expect(after.y).toBeCloseTo(0.5, 6);
        expect(after.z).toBeCloseTo(0, 6);
        expect(part.parent).toBe(root);
        expect(h.mutations).toEqual([]); // a part has no schema slot
        expect(h.selections).toEqual([]);

        // Three-quarter overview (the part faces world +X after the root's yaw): amber = gizmo before
        // the drag, red = gizmo after it, both on the highlighted part.
        const overview = new THREE.PerspectiveCamera(45, W / H, 0.1, 100);
        overview.position.set(9, 4, 7);
        overview.lookAt(4.5, 0.5, 0);
        const shot = saveViewportSnapshot('scene3d_viewport_controls_gizmo_world_space_part_drag', h.scene, overview, {
            highlight: part,
            markers: [{ position: gizmoPos, color: [251, 191, 36] }, { position: after, color: [248, 113, 113] }]
        });
        expect(shot.highlightPixels).toBeGreaterThan(500);
        expect(shot.markerPixels[0]!.x).toBeLessThan(shot.markerPixels[1]!.x - 10); // moved along world +X on screen
        const marker = shot.markerPixels[1]!;
        const bounds = shot.highlightBounds!;
        // The gizmo marker sits on the dragged part in the rendered frame.
        expect(marker.x).toBeGreaterThanOrEqual(bounds.minX);
        expect(marker.x).toBeLessThanOrEqual(bounds.maxX);
        expect(marker.y).toBeGreaterThanOrEqual(bounds.minY);
        expect(marker.y).toBeLessThanOrEqual(bounds.maxY);
    });

    it('rotates a nested part about the world axis of the handle, not its parent-local axis', () => {
        h = createHarness({ objects: [] });
        const { part } = movedModelWithPart(h);
        const p0 = new THREE.Vector3();
        const q0 = new THREE.Quaternion();
        readWorldPose(part, p0, q0);

        h.ctx.toolMode.current = 'transform';
        h.ctx.transformMode.current = 'rotate';
        h.ctx.gizmoGroup.current = new THREE.Group();
        h.ctx.gizmoEngine.current = { hitTest: () => ({ handleType: 'rot-z' }) } as any;
        h.ctx.selectedObject.current = part;
        const c = toClient(h, p0);
        fire(h.container, 'mousedown', { clientX: c.x + 40, clientY: c.y });
        fire(h.container, 'mousemove', { clientX: c.x, clientY: c.y - 40 });
        fire(window, 'mouseup', { clientX: c.x, clientY: c.y - 40 });

        const p1 = new THREE.Vector3();
        const q1 = new THREE.Quaternion();
        readWorldPose(part, p1, q1);
        // World-space delta rotation is purely about world Z (about a quarter turn here).
        const delta = q1.clone().multiply(q0.clone().invert());
        expect(Math.abs(delta.x)).toBeLessThan(1e-6);
        expect(Math.abs(delta.y)).toBeLessThan(1e-6);
        expect(2 * Math.acos(Math.min(1, Math.abs(delta.w)))).toBeGreaterThan(Math.PI / 4);
        expect(p1.distanceTo(p0)).toBeLessThan(1e-9);
        expect(h.mutations).toEqual([]);
    });

    it('alt-click selects the whole loaded model; a plain click selects the part', () => {
        h = createHarness();
        const part = quad('Hero_Part', 4, 0);
        const root = modelRoot('stage-a', part);
        const crate = quad('crate', 1, 0);
        crate.position.set(3.5, 0, 0);
        h.scene.add(root, crate);
        h.scene.updateMatrixWorld(true);

        click(h, CX, CY, { altKey: true });
        click(h);
        // Alt on something that is not part of a loaded model selects it as usual.
        const crateAt = toClient(h, new THREE.Vector3(3.5, 0, 0));
        click(h, crateAt.x, crateAt.y, { altKey: true });
        expect(h.selections).toEqual([root, part, crate]);

        const shot = saveViewportSnapshot('scene3d_viewport_controls_alt_click_selects_model_root', h.scene, h.camera, { highlight: root });
        expect(shot.highlightPixels).toBeGreaterThan(1000);
        expect(shot.drawnPixels).toBeGreaterThan(shot.highlightPixels); // the crate is drawn, unhighlighted
    });

    it('a gizmo commit on a schema custom mesh updates it in place and never appends entries', () => {
        h = createHarness({
            customMeshes: [{ id: 'crate', name: 'crate', type: 'custom', position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } as any]
        });
        const mesh = quad('crate', 4, 0);
        h.scene.add(mesh);
        h.scene.updateMatrixWorld(true);
        h.ctx.toolMode.current = 'transform';
        h.ctx.gizmoGroup.current = new THREE.Group();
        h.ctx.gizmoEngine.current = { hitTest: () => ({ handleType: 'axis-x' }) } as any;
        h.ctx.selectedObject.current = mesh;

        fire(h.container, 'mousedown', { clientX: CX, clientY: CY });
        fire(h.container, 'mousemove', { clientX: CX + 60, clientY: CY });
        fire(window, 'mouseup', { clientX: CX + 60, clientY: CY });

        const meshes = h.data().customMeshes!;
        expect(meshes).toHaveLength(1);
        expect(meshes[0].type).toBe('custom');
        expect(meshes[0].position![0]).toBeCloseTo(mesh.position.x, 9);
    });

    it('a sculpt stroke on a model part does not invent a customMeshes entry', () => {
        h = createHarness();
        const part = quad('Hero_Part', 4, 0);
        h.scene.add(modelRoot('stage-a', part));
        h.scene.updateMatrixWorld(true);
        h.ctx.toolMode.current = 'sculpt';

        fire(h.container, 'mousedown', { clientX: CX, clientY: CY });
        fire(window, 'mouseup', { clientX: CX, clientY: CY });

        expect(h.ctx.sculptMesh.current).toBe(part);
        expect(h.mutations).toEqual([{ operator: 'sb_deform_vertices' }]);
        expect(h.data().customMeshes).toBeUndefined();
        expect(h.data().sculptSettings).toBe(h.ctx.sculptSettings.current);
    });

    it('detach removes every listener', () => {
        h = createHarness();
        h.detach();
        h.ctx.orbit.current.distance = 100;
        fire(h.container, 'wheel', { deltaY: -500 });
        expect(h.ctx.orbit.current.distance).toBe(100);
        h = createHarness(); // afterEach detaches this one
    });
});

describe('stepCamera near plane', () => {
    it('keeps near proportional to the orbit distance (clamped to [0.1, 5]) and resets it for FPS', () => {
        const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 20000);
        const target = new THREE.Vector3(0, 180, 0);

        stepCamera(camera, 'orbit', { theta: 0.7, phi: 1.1, distance: 700 }, target, {});
        expect(camera.near).toBeCloseTo(0.7, 9);
        expect(camera.position.distanceTo(target)).toBeCloseTo(700, 6);
        const projectionAt700 = camera.projectionMatrix.clone();

        stepCamera(camera, 'orbit', { theta: 0.7, phi: 1.1, distance: 710 }, target, {});
        expect(camera.near).toBeCloseTo(0.7, 9); // < 5% change: projection not rebuilt
        expect(camera.projectionMatrix.equals(projectionAt700)).toBe(true);

        stepCamera(camera, 'orbit', { theta: 0.7, phi: 1.1, distance: 50 }, target, {});
        expect(camera.near).toBeCloseTo(0.1, 9);
        stepCamera(camera, 'orbit', { theta: 0.7, phi: 1.1, distance: 12000 }, target, {});
        expect(camera.near).toBe(5);

        stepCamera(camera, 'fps', { theta: 0, phi: 1, distance: 12000 }, target, {});
        expect(camera.near).toBeCloseTo(0.1, 9);
    });
});
