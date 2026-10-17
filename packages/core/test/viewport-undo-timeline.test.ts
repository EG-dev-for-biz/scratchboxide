/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * One undo/redo timeline for the whole viewport. The edits come from the real pointer handlers
 * (gizmo drag, sculpt stroke), the same scene-edit recording the viewport component uses
 * (ViewportHistoryController), the inspector's mutations and an agent tool call, and every
 * assertion compares actual state: scene data, vertex buffers, transforms.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { attachViewportControls } from '../src/browser/generative-canvas/primitives/scene3d/attachViewportControls';
import type { ViewportControlContext } from '../src/browser/generative-canvas/primitives/scene3d/attachViewportControls';
import { resolveSelectableObject } from '../src/browser/generative-canvas/primitives/scene3d/selection';
import { ViewportHistoryController } from '../src/browser/generative-canvas/primitives/scene3d/viewportHistoryController';
import { ViewportHistory, attachHistoryShortcuts, resolveHistoryShortcut } from '../src/browser/generative-canvas/services/viewport-history';
import type { HistoryEntry } from '../src/browser/generative-canvas/services/viewport-history';
import { ObjectEditCapture, SCENE_BOOKKEEPING_KEYS, SceneEditEntry, createGeometrySwapEdit } from '../src/browser/generative-canvas/services/viewport-history-deltas';
import { DirectDispatchOperatorEngine } from '../src/browser/generative-canvas/services/direct-dispatch-operator-engine';
import type { Scene3DData, SculptSettings } from '../src/browser/generative-canvas/canvas-types';
import type { RendererStack } from '../src/browser/generative-canvas/primitives/scene3d/types';
import { saveViewportSnapshot } from './helpers/scene3d-viewport-snapshot';
import { REPO_ROOT } from './helpers/requirements';
import * as fs from 'fs';
import * as path from 'path';

// The pointer handlers listen on `window`; Node's EventTarget stands in for it.
beforeEach(() => { (globalThis as any).window = new EventTarget(); });
afterEach(() => { delete (globalThis as any).window; });

const W = 800;
const H = 600;
const CX = W / 2;
const CY = H / 2;

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

/** A camera-facing n x n grid of quads built from raw buffers (enough vertices for a brush to bite). */
function gridMesh(name: string, size: number, n: number): THREE.Mesh {
    const positions: number[] = [];
    const h = size / 2;
    const vert = (i: number, j: number) => [-h + (i / n) * size, -h + (j / n) * size, 0];
    for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
            positions.push(...vert(i, j), ...vert(i + 1, j), ...vert(i + 1, j + 1));
            positions.push(...vert(i, j), ...vert(i + 1, j + 1), ...vert(i, j + 1));
        }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
    mesh.name = name;
    return mesh;
}

const baseScene = (): Scene3DData => ({
    title: 'undo-timeline',
    customMeshes: [
        { id: 'cube-1', name: 'cube-1', type: 'box', position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], material: { color: 0x808080, roughness: 0.5, metalness: 0.1 } },
        { id: 'prop-2', name: 'prop-2', type: 'sphere', position: [5, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], material: { color: 0x2255ff, roughness: 0.3, metalness: 0 } }
    ],
    objects: []
});

interface Rig {
    container: FakeViewportElement;
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    ctx: ViewportControlContext;
    cube: THREE.Mesh;
    controller: ViewportHistoryController;
    history: ViewportHistory;
    selection: { id: string | null; restored: Array<string | null> };
    clock: { t: number };
    data: () => Scene3DData;
    setData: (d: Scene3DData) => void;
    /** Mirrors Scene3DPrimitive.mutateSceneData (apply + operator log + record). */
    mutate: ViewportControlContext['mutateSceneData']['current'];
    detach: () => void;
}

function createRig(initial: Scene3DData = baseScene()): Rig {
    const container = new FakeViewportElement();
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, W / H, 0.1, 20000);
    camera.position.set(0, 0, 10);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    camera.updateProjectionMatrix();
    const cube = gridMesh('cube-1', 8, 24);
    scene.add(cube);
    scene.updateMatrixWorld(true);

    let data = initial;
    const clock = { t: 1_000 };
    const selection = { id: null as string | null, restored: [] as Array<string | null> };

    const applyMutation = (mutator: (p: Scene3DData) => Scene3DData, opInfo?: { operator: string; params?: any }) => {
        const prev = data;
        let next = mutator(prev);
        if (opInfo) {
            next = { ...next, operatorStack: [...(next.operatorStack || prev.operatorStack || []), { operator: opInfo.operator, params: opInfo.params, timestamp: clock.t }] };
        }
        data = next;
        return { prev, next };
    };
    const history = new ViewportHistory({ now: () => clock.t, onRestoreSelection: id => selection.restored.push(id) });
    const controller = new ViewportHistoryController({
        commit: (update, opInfo) => { applyMutation(update, opInfo); },
        getSelectedId: () => selection.id,
        restoreSelection: id => selection.restored.push(id)
    }, history);
    const mutate: Rig['mutate'] = (mutator, opInfo, options) => {
        const { prev, next } = applyMutation(mutator, opInfo);
        controller.recordSceneEdit(prev, next, opInfo, options?.history);
    };

    const selectedObject = { current: cube as THREE.Object3D | null };
    selection.id = 'cube-1';
    const ctx: ViewportControlContext = {
        cameraMode: { current: 'orbit' },
        toolMode: { current: 'view' },
        transformMode: { current: 'translate' },
        transformSpace: { current: 'world' },
        sculptSettings: { current: { brush: 'draw', falloff: 'gaussian', radius: 1.5, strength: 0.8, symmetry: { x: false, y: false, z: false } } as SculptSettings },
        orbit: { current: { theta: 0, phi: Math.PI / 2, distance: 10 } },
        target: { current: new THREE.Vector3() },
        keysPressed: { current: {} },
        gizmoEngine: { current: { hitTest: () => null } as any },
        gizmoGroup: { current: null },
        selectedObject,
        sculptMesh: { current: cube },
        brushCursor: { current: null },
        selectionBox: { current: null },
        ignoredPickObjects: () => [],
        resolveSelectableObject,
        selectObject: { current: obj => { selectedObject.current = obj; } },
        mutateSceneData: { current: mutate },
        recordEdit: { current: (label, live, meta) => controller.recordLiveEdit(label, live, meta) },
        setSelectedObjectId: () => undefined,
        setSelectedObjectName: () => undefined
    };
    const detach = attachViewportControls({ container, scene, camera } as unknown as RendererStack, ctx);
    return { container, scene, camera, ctx, cube, controller, history, selection, clock, data: () => data, setData: d => { data = d; }, mutate, detach };
}

/** Everything an edit can change that a user would see: scene data, vertex buffer, transform. */
function stateOf(rig: Rig) {
    const data: Record<string, unknown> = { ...rig.data() };
    for (const k of SCENE_BOOKKEEPING_KEYS) delete data[k];
    return {
        data: JSON.parse(JSON.stringify(data)),
        vertices: Array.from(rig.cube.geometry.attributes.position.array as Float32Array),
        position: rig.cube.position.toArray(),
        quaternion: rig.cube.quaternion.toArray(),
        scale: rig.cube.scale.toArray()
    };
}

describe('viewport undo/redo: one ordered timeline across tools', () => {
    let rig: Rig;
    afterEach(() => { rig?.detach(); });

    function gizmoMove(px = 60) {
        rig.ctx.toolMode.current = 'transform';
        rig.ctx.gizmoGroup.current = new THREE.Group();
        rig.ctx.gizmoEngine.current = { hitTest: () => ({ handleType: 'axis-x' }) } as any;
        rig.ctx.selectedObject.current = rig.cube;
        fire(rig.container, 'mousedown', { clientX: CX, clientY: CY });
        fire(rig.container, 'mousemove', { clientX: CX + px / 2, clientY: CY });
        fire(rig.container, 'mousemove', { clientX: CX + px, clientY: CY });
        fire(window, 'mouseup', { clientX: CX + px, clientY: CY });
        rig.clock.t += 5_000;
    }
    function sculptStroke() {
        rig.ctx.toolMode.current = 'sculpt';
        fire(rig.container, 'mousedown', { clientX: CX, clientY: CY });
        fire(rig.container, 'mousemove', { clientX: CX + 10, clientY: CY + 4 });
        fire(rig.container, 'mousemove', { clientX: CX + 20, clientY: CY + 8 });
        fire(window, 'mouseup', { clientX: CX + 20, clientY: CY + 8 });
        rig.clock.t += 5_000;
    }
    function materialChange() {
        rig.mutate(prev => ({
            ...prev,
            customMeshes: prev.customMeshes!.map(m => m.id === 'cube-1' ? { ...m, material: { ...m.material, color: 0xff0000, roughness: 0.9 } } : m)
        }), { operator: 'sb_set_material', params: { objectId: 'cube-1', color: '#ff0000', roughness: 0.9 } });
        rig.clock.t += 5_000;
    }
    function deleteProp() {
        rig.mutate(prev => ({ ...prev, customMeshes: prev.customMeshes!.filter(m => m.id !== 'prop-2') }), { operator: 'sb_delete_mesh', params: { objectId: 'prop-2' } });
        rig.clock.t += 5_000;
    }
    /** An agent tool call as scene_3d_dispatch_operators runs it: an engine over the open scene, then the data update. */
    function agentOperatorEdit() {
        const prev = rig.data();
        const engine = new DirectDispatchOperatorEngine(prev);
        const result = engine.executeBatch([
            { operator: 'sb_translate', params: { objectId: 'cube-1', delta: [0, 2, 0] } },
            { operator: 'sb_scale', params: { objectId: 'cube-1', scale: [2, 2, 2] } }
        ], { atomic: true });
        expect(result.success).toBe(true);
        const next = { ...prev, ...engine.getSceneData() };
        rig.controller.recordExternalChange(prev, next);
        rig.setData(next);
        rig.clock.t += 5_000;
    }

    it('gizmo move, sculpt stroke, material change, delete and an agent operator edit undo and redo in exact reverse / forward order', () => {
        rig = createRig();
        const states = [stateOf(rig)];
        const expectedLabels: string[] = [];

        gizmoMove(); states.push(stateOf(rig)); expectedLabels.push('Move cube-1');
        sculptStroke(); states.push(stateOf(rig)); expectedLabels.push('Sculpt draw: cube-1');
        materialChange(); states.push(stateOf(rig)); expectedLabels.push('Set material: cube-1');
        deleteProp(); states.push(stateOf(rig)); expectedLabels.push('Delete mesh: prop-2');
        agentOperatorEdit(); states.push(stateOf(rig)); expectedLabels.push('Agent: Translate, Scale');

        // every step really changed something the user can see
        for (let i = 1; i < states.length; i++) expect(states[i]).not.toEqual(states[i - 1]);
        expect(states[1].position[0]).toBeGreaterThan(0.3);
        expect(states[2].vertices).not.toEqual(states[1].vertices);
        expect(rig.history.labels().undo).toEqual(expectedLabels);
        expect(rig.history.getSnapshot().undoLabel).toBe('Agent: Translate, Scale');

        for (let k = 1; k <= 5; k++) {
            expect(rig.controller.undo()).toBe(true);
            expect(stateOf(rig)).toEqual(states[5 - k]);
        }
        expect(rig.controller.undo()).toBe(false);
        expect(rig.history.canUndo()).toBe(false);

        for (let k = 1; k <= 5; k++) {
            expect(rig.controller.redo()).toBe(true);
            expect(stateOf(rig)).toEqual(states[k]);
        }
        expect(rig.controller.redo()).toBe(false);
    });

    it('a new edit after an undo clears redo', () => {
        rig = createRig();
        gizmoMove();
        materialChange();
        rig.controller.undo();
        expect(rig.history.canRedo()).toBe(true);
        deleteProp();
        expect(rig.history.canRedo()).toBe(false);
        expect(rig.controller.redo()).toBe(false);
        expect(rig.history.labels().undo).toEqual(['Move cube-1', 'Delete mesh: prop-2']);
    });

    it('a drag or stroke is one entry however many pointer moves it had; two quick drags stay two entries', () => {
        rig = createRig();
        gizmoMove(80);
        expect(rig.history.getSnapshot().undoCount).toBe(1);
        rig.clock.t -= 4_900; // the second drag lands well inside the coalescing window
        gizmoMove(40);
        expect(rig.history.getSnapshot().undoCount).toBe(2);
        sculptStroke();
        expect(rig.history.getSnapshot().undoCount).toBe(3);
    });

    it('a click on the gizmo that moves nothing records nothing', () => {
        rig = createRig();
        gizmoMove(0);
        expect(rig.history.canUndo()).toBe(false);
    });

    it('the undo is told to the agent: the operator log carries the undone label, and the scene no longer has the change', () => {
        rig = createRig();
        materialChange();
        rig.controller.undo();
        const log = rig.data().operatorStack!;
        const last = log[log.length - 1];
        expect(last.operator).toBe('sb_undo');
        expect(last.params.label).toBe('Set material: cube-1');
        expect(last.params.note).toMatch(/no longer contains that change/);
        expect(rig.data().customMeshes![0].material!.color).toBe(0x808080);
        rig.controller.redo();
        expect(rig.data().operatorStack![rig.data().operatorStack!.length - 1].operator).toBe('sb_redo');
        expect(rig.data().customMeshes![0].material!.color).toBe(0xff0000);
    });

    it('selection is restored: undo re-selects what was selected, redo what the edit targeted', () => {
        rig = createRig();
        rig.selection.id = 'prop-2';
        deleteProp();
        rig.selection.id = null;
        rig.controller.undo();
        rig.controller.redo();
        expect(rig.selection.restored).toEqual(['prop-2', 'prop-2']);
    });

    it('view-only changes (history: false) and replayed edits are never recorded', () => {
        rig = createRig();
        rig.mutate(prev => ({ ...prev, camera: { position: [1, 2, 3], target: [0, 0, 0] } }), { operator: 'sb_set_camera' }, { history: false });
        expect(rig.history.canUndo()).toBe(false);
        materialChange();
        rig.controller.undo();
        expect(rig.history.getSnapshot().undoCount).toBe(0); // the undo's own scene write did not add an entry
        expect(rig.history.getSnapshot().redoCount).toBe(1);
    });

    it('a sculpt stroke on a mesh the rebuilt content detached is dropped on undo, not applied to a ghost', () => {
        rig = createRig();
        materialChange();
        sculptStroke();
        const before = Array.from(rig.cube.geometry.attributes.position.array as Float32Array);
        rig.scene.remove(rig.cube); // the viewport rebuilt its content
        expect(rig.controller.undo()).toBe(true); // skips the dead stroke, reverses the material change
        expect(rig.data().customMeshes![0].material!.color).toBe(0x808080);
        expect(Array.from(rig.cube.geometry.attributes.position.array as Float32Array)).toEqual(before);
        expect(rig.history.labels().redo).toEqual(['Set material: cube-1']);
    });
});

describe('viewport undo/redo: repeated tweaks coalesce, structure edits do not', () => {
    it('ten roughness slider events on one object are one entry; undo restores the value from before the first', () => {
        const rig = createRig();
        for (let i = 1; i <= 10; i++) {
            rig.mutate(prev => ({
                ...prev,
                customMeshes: prev.customMeshes!.map(m => m.id === 'cube-1' ? { ...m, material: { ...m.material, roughness: 0.5 + i * 0.04 } } : m)
            }), { operator: 'sb_set_material', params: { objectId: 'cube-1', roughness: 0.5 + i * 0.04 } });
            rig.clock.t += 80;
        }
        expect(rig.history.getSnapshot().undoCount).toBe(1);
        expect(rig.data().customMeshes![0].material!.roughness).toBeCloseTo(0.9, 9);
        rig.controller.undo();
        expect(rig.data().customMeshes![0].material!.roughness).toBe(0.5);
        rig.controller.redo();
        expect(rig.data().customMeshes![0].material!.roughness).toBeCloseTo(0.9, 9);
        rig.detach();
    });

    it('the same slider after the window, a different object, or an add / delete is a new entry', () => {
        const rig = createRig();
        const tweak = (id: string, r: number) => rig.mutate(prev => ({
            ...prev, customMeshes: prev.customMeshes!.map(m => m.id === id ? { ...m, material: { ...m.material, roughness: r } } : m)
        }), { operator: 'sb_set_material', params: { objectId: id, roughness: r } });
        tweak('cube-1', 0.6); rig.clock.t += 100;
        tweak('prop-2', 0.6); rig.clock.t += 100; // other object
        expect(rig.history.getSnapshot().undoCount).toBe(2);
        tweak('prop-2', 0.7); rig.clock.t += 2_000; // folds into prop-2's entry
        expect(rig.history.getSnapshot().undoCount).toBe(2);
        tweak('prop-2', 0.8); // past the 750 ms window
        expect(rig.history.getSnapshot().undoCount).toBe(3);
        rig.mutate(prev => ({ ...prev, customMeshes: [...prev.customMeshes!, { id: 'n1', name: 'n1', type: 'box' }] }), { operator: 'sb_create_mesh', params: { mesh: { id: 'n1' } } });
        rig.clock.t += 10;
        rig.mutate(prev => ({ ...prev, customMeshes: [...prev.customMeshes!, { id: 'n2', name: 'n2', type: 'box' }] }), { operator: 'sb_create_mesh', params: { mesh: { id: 'n2' } } });
        expect(rig.history.getSnapshot().undoCount).toBe(5);
        rig.detach();
    });
});

describe('viewport undo/redo: memory is bounded and entries are compact', () => {
    function bigMesh(vertexCount: number): THREE.Mesh {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(vertexCount * 3), 3));
        const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial());
        new THREE.Scene().add(mesh);
        return mesh;
    }

    function editVertices(mesh: THREE.Mesh, from: number, count: number, delta: number): HistoryEntry {
        const cap = new ObjectEditCapture([mesh], { transform: false });
        const arr = mesh.geometry.attributes.position.array as Float32Array;
        for (let v = from; v < from + count; v++) arr[v * 3 + 1] += delta;
        const live = cap.finish()!;
        return new SceneEditEntry({ label: `edit ${from}`, delta: null, live, target: { applyDelta: () => undefined } });
    }

    it('an entry stores the changed vertices, not the buffer: 10 vertices of a 300k-vertex mesh is a couple of KB', () => {
        const mesh = bigMesh(300_000);
        const entry = editVertices(mesh, 1_000, 10, 0.5);
        expect(entry.bytes).toBeLessThan(2_000);
        expect((mesh.geometry.attributes.position.array as Float32Array).byteLength).toBe(3_600_000);
    });

    it('the byte cap evicts the oldest entries, the newest is always kept, and what remains still undoes exactly', () => {
        const mesh = bigMesh(20_000);
        const history = new ViewportHistory({ maxBytes: 1_000_000, maxEntries: 1_000 });
        const originals: Float32Array[] = [];
        for (let i = 0; i < 30; i++) {
            originals.push((mesh.geometry.attributes.position.array as Float32Array).slice());
            history.record(editVertices(mesh, i * 100, 5_000, 0.25));
        }
        const snap = history.getSnapshot();
        expect(snap.bytes).toBeLessThanOrEqual(1_000_000);
        expect(snap.undoCount).toBeGreaterThan(3);
        expect(snap.undoCount).toBeLessThan(30);
        expect(snap.undoLabel).toBe('edit 2900'); // newest kept

        const retained = snap.undoCount;
        for (let i = 0; i < retained; i++) history.undo();
        // fully undone: the buffer equals the state just before the oldest retained edit
        expect(Array.from(mesh.geometry.attributes.position.array as Float32Array)).toEqual(Array.from(originals[30 - retained]));
        expect(history.canUndo()).toBe(false);
    });

    it('a single entry bigger than the cap is still kept (an edit is never silently un-undoable)', () => {
        const mesh = bigMesh(20_000);
        const history = new ViewportHistory({ maxBytes: 1_000 });
        history.record(editVertices(mesh, 0, 20_000, 1));
        expect(history.getSnapshot().undoCount).toBe(1);
        history.undo();
        expect(Math.max(...Array.from(mesh.geometry.attributes.position.array as Float32Array))).toBe(0);
    });

    it('the entry cap evicts the oldest and disposes what an evicted entry held', () => {
        const history = new ViewportHistory({ maxEntries: 3 });
        const disposed: string[] = [];
        for (const label of ['a', 'b', 'c', 'd', 'e']) {
            history.record({ label, bytes: 1, apply: () => undefined, revert: () => undefined, dispose: () => { disposed.push(label); } });
        }
        expect(history.labels().undo).toEqual(['c', 'd', 'e']);
        expect(disposed).toEqual(['a', 'b']);
    });

    it('replaced geometry (reset mesh) is undoable, and the geometry that can never be shown again is freed', () => {
        const mesh = bigMesh(100);
        const oldGeo = mesh.geometry;
        const newGeo = new THREE.BufferGeometry();
        newGeo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(300).fill(1), 3));
        mesh.geometry = newGeo;
        let freed = 0;
        oldGeo.addEventListener('dispose', () => { freed++; });
        const swap = createGeometrySwapEdit(mesh, oldGeo, newGeo);
        const history = new ViewportHistory();
        history.record(new SceneEditEntry({ label: 'Reset mesh', delta: null, live: swap, target: { applyDelta: () => undefined } }));
        history.undo();
        expect(mesh.geometry).toBe(oldGeo);
        history.redo();
        expect(mesh.geometry).toBe(newGeo);
        history.undo();
        history.clear(); // dropped while showing oldGeo: newGeo is freed, oldGeo is not
        expect(freed).toBe(0);
        expect(mesh.geometry).toBe(oldGeo);
    });
});

describe('viewport undo/redo: generated staged-location layers are not edits and undo cannot corrupt them', () => {
    const staged = (ids: string[]) => ({
        schema: 'scratchbox.staged-build/2',
        layers: ids.map(objectId => ({ objectId, stage: objectId })),
        events: []
    });
    const layer = (id: string) => ({ id, content: { type: '3d-model', durableUri: `/m/${id}.glb`, mimeType: 'model/gltf-binary' }, space: { spatial3d: { x: 0, y: 0, z: 0 } } });

    it('a layer that arrives between an edit and its undo survives the undo, and the agent turn that adds layers makes no entry', () => {
        const rig = createRig({ ...baseScene(), objects: [layer('terrain')], stagedBuild: staged(['terrain']) } as any);
        rig.mutate(prev => ({ ...prev, customMeshes: prev.customMeshes!.filter(m => m.id !== 'prop-2') }), { operator: 'sb_delete_mesh', params: { objectId: 'prop-2' } });

        // the pipeline commits a second layer while the user keeps working (no operator info: not an edit)
        const prev = rig.data();
        rig.setData({ ...prev, objects: [...prev.objects!, layer('buildings')], stagedBuild: staged(['terrain', 'buildings']) } as any);
        // an agent turn that only reports the layers (it logs an operator, adds a layer, changes nothing else)
        const before = rig.data();
        const after = { ...before, objects: [...before.objects!, layer('roads')], stagedBuild: staged(['terrain', 'buildings', 'roads']), operatorStack: [...(before.operatorStack ?? []), { operator: 'stage_commit' }] } as any;
        rig.controller.recordExternalChange(before, after);
        rig.setData(after);
        expect(rig.history.labels().undo).toEqual(['Delete mesh: prop-2']);

        rig.controller.undo();
        const data = rig.data() as any;
        expect(data.customMeshes.map((m: any) => m.id)).toEqual(['cube-1', 'prop-2']);
        expect(data.objects.map((o: any) => o.id)).toEqual(['terrain', 'buildings', 'roads']);
        expect(data.stagedBuild.layers.map((l: any) => l.objectId)).toEqual(['terrain', 'buildings', 'roads']);
        rig.controller.redo();
        expect((rig.data() as any).objects.map((o: any) => o.id)).toEqual(['terrain', 'buildings', 'roads']);
        rig.detach();
    });

    it('regenerated content (a new generator GLB) resets the history instead of leaving edits made against the old geometry', () => {
        const rig = createRig();
        rig.mutate(prev => ({ ...prev, title: 'renamed' }), { operator: 'sb_rename' });
        expect(rig.history.canUndo()).toBe(true);
        const prev = rig.data();
        rig.controller.recordExternalChange(prev, { ...prev, cppGenerator: { sourceCode: 'int main(){}', glbBase64: 'AAAA' } } as any);
        expect(rig.history.canUndo()).toBe(false);
        rig.detach();
    });

    it('a change that logs no operator (a re-send of the same scene) is not an agent edit', () => {
        const rig = createRig();
        const prev = rig.data();
        rig.controller.recordExternalChange(prev, { ...prev, title: 'sent again', customMeshes: prev.customMeshes!.map(m => ({ ...m })) });
        expect(rig.history.canUndo()).toBe(false);
        rig.detach();
    });
});

describe('viewport undo/redo: the operator engine shares the timeline (sb_reshape_mesh, sb_undo)', () => {
    it('an engine edit and a user edit undo in order through sb_undo, vertex buffers restored exactly', () => {
        const scene = new THREE.Scene();
        const mesh = gridMesh('tower', 4, 16);
        scene.add(mesh);
        const original = Array.from(mesh.geometry.attributes.position.array as Float32Array);
        const history = new ViewportHistory({ now: () => 1 });

        const engine = new DirectDispatchOperatorEngine({ title: 't', customMeshes: [{ id: 'tower', name: 'tower', type: 'custom', position: [0, 0, 0] }] } as any);
        engine.attachThreeScene(scene);
        engine.attachHistory(history);

        const reshaped = engine.dispatch('sb_reshape_mesh', { objectId: 'tower', operations: [{ type: 'twist', angle: 40 }] });
        expect(reshaped.success).toBe(true);
        const afterReshape = Array.from(mesh.geometry.attributes.position.array as Float32Array);
        expect(afterReshape).not.toEqual(original);

        // the user then moves the object on the same timeline
        const cap = new ObjectEditCapture([mesh], { geometry: false });
        mesh.position.set(3, 0, 0);
        history.record(new SceneEditEntry({ label: 'Move tower', delta: null, live: cap.finish(), target: { applyDelta: () => undefined } }));

        expect(history.labels().undo).toEqual(['Reshape mesh: tower', 'Move tower']);

        expect(engine.dispatch('sb_undo', {}).success).toBe(true); // reverses the user's move, the latest edit
        expect(mesh.position.x).toBe(0);
        expect(Array.from(mesh.geometry.attributes.position.array as Float32Array)).toEqual(afterReshape);

        expect(engine.undo()).toBe(true); // then the agent's reshape
        expect(Array.from(mesh.geometry.attributes.position.array as Float32Array)).toEqual(original);
        expect(engine.undo()).toBe(false);

        expect(engine.dispatch('sb_redo', {}).success).toBe(true);
        expect(Array.from(mesh.geometry.attributes.position.array as Float32Array)).toEqual(afterReshape);
        // a batch is one entry
        engine.executeBatch([
            { operator: 'sb_translate', params: { objectId: 'tower', delta: [1, 0, 0] } },
            { operator: 'sb_translate', params: { objectId: 'tower', delta: [0, 1, 0] } }
        ]);
        expect(history.getSnapshot().redoCount).toBe(0);
        expect(history.labels().undo).toEqual(['Reshape mesh: tower', 'Agent batch: 2 operators']);
    });

    it('without a shared timeline the engine keeps its own scene snapshots (unchanged behaviour)', () => {
        const engine = new DirectDispatchOperatorEngine({ title: 't', customMeshes: [{ id: 'a', name: 'a', type: 'box', position: [0, 0, 0] }] } as any);
        engine.dispatch('sb_translate', { objectId: 'a', delta: [1, 0, 0] });
        expect(engine.undo()).toBe(true);
        expect(engine.getSceneData().customMeshes![0].position![0]).toBe(0);
    });
});

describe('viewport undo/redo: keyboard shortcuts', () => {
    const key = (init: Partial<KeyboardEvent> & { key: string }) => ({ metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...init });

    it('maps Cmd/Ctrl+Z to undo, Shift+Cmd/Ctrl+Z and Ctrl/Cmd+Y to redo, and nothing else', () => {
        expect(resolveHistoryShortcut(key({ key: 'z', metaKey: true }), null)).toBe('undo');
        expect(resolveHistoryShortcut(key({ key: 'z', ctrlKey: true }), null)).toBe('undo');
        expect(resolveHistoryShortcut(key({ key: 'Z', metaKey: true, shiftKey: true }), null)).toBe('redo');
        expect(resolveHistoryShortcut(key({ key: 'y', ctrlKey: true }), null)).toBe('redo');
        expect(resolveHistoryShortcut(key({ key: 'z' }), null)).toBeNull();
        expect(resolveHistoryShortcut(key({ key: 'y', ctrlKey: true, shiftKey: true }), null)).toBeNull();
        expect(resolveHistoryShortcut(key({ key: 'z', ctrlKey: true, altKey: true }), null)).toBeNull();
        expect(resolveHistoryShortcut(key({ key: 'c', metaKey: true }), null)).toBeNull();
    });

    it('is ignored while typing in an input, textarea, select or contenteditable', () => {
        for (const active of [{ tagName: 'INPUT' }, { tagName: 'TEXTAREA' }, { tagName: 'SELECT' }, { tagName: 'DIV', isContentEditable: true }]) {
            expect(resolveHistoryShortcut(key({ key: 'z', metaKey: true }), active)).toBeNull();
        }
        expect(resolveHistoryShortcut(key({ key: 'z', metaKey: true }), { tagName: 'CANVAS' })).toBe('undo');
    });

    it('window keydown events reverse the latest edit, replay it, and are prevented only when handled', () => {
        const target = new EventTarget();
        const rig = createRig();
        let active: { tagName?: string } = { tagName: 'CANVAS' };
        const detach = attachHistoryShortcuts(target, { undo: rig.controller.undo, redo: rig.controller.redo }, () => active);
        rig.mutate(prev => ({ ...prev, title: 'one' }), { operator: 'sb_rename' });
        rig.clock.t += 5_000;
        rig.mutate(prev => ({ ...prev, title: 'two' }), { operator: 'sb_rename' });

        const press = (init: Record<string, unknown>) => fire(target, 'keydown', init);
        expect(press({ key: 'z', metaKey: true }).defaultPrevented).toBe(true);
        expect(rig.data().title).toBe('one');
        active = { tagName: 'INPUT' };
        expect(press({ key: 'z', metaKey: true }).defaultPrevented).toBe(false);
        expect(rig.data().title).toBe('one');
        active = { tagName: 'CANVAS' };
        press({ key: 'z', metaKey: true, shiftKey: true });
        expect(rig.data().title).toBe('two');
        press({ key: 'z', ctrlKey: true });
        press({ key: 'y', ctrlKey: true });
        expect(rig.data().title).toBe('two');
        expect(press({ key: 'q', metaKey: true }).defaultPrevented).toBe(false);

        detach();
        press({ key: 'z', metaKey: true });
        expect(rig.data().title).toBe('two');
        rig.detach();
    });
});

describe('viewport undo/redo: snapshot for the toolbar', () => {
    it('reports disabled states, labels and counts, and notifies subscribers once per change', () => {
        const history = new ViewportHistory({ now: () => 0 });
        let notified = 0;
        history.subscribe(() => { notified++; });
        expect(history.getSnapshot()).toMatchObject({ canUndo: false, canRedo: false, undoLabel: null, redoLabel: null, undoCount: 0, redoCount: 0 });
        const e = (label: string): HistoryEntry => ({ label, bytes: 1, apply: () => undefined, revert: () => undefined });
        history.record(e('Move cube')); history.record(e('Delete wall'));
        expect(history.getSnapshot()).toMatchObject({ canUndo: true, undoLabel: 'Delete wall', undoCount: 2 });
        history.undo();
        expect(history.getSnapshot()).toMatchObject({ canRedo: true, redoLabel: 'Delete wall', undoLabel: 'Move cube', undoCount: 1, redoCount: 1 });
        expect(history.getSnapshot()).toBe(history.getSnapshot()); // stable between changes (useSyncExternalStore)
        history.clear();
        expect(history.getSnapshot()).toMatchObject({ canUndo: false, canRedo: false, undoCount: 0 });
        expect(notified).toBe(4);
    });
});

describe('viewport undo/redo: screenshot of a mesh before and after undo', () => {
    it('saves the sculpted mesh, the same mesh after undo, and after redo', () => {
        const rig = createRig();
        const shot = (name: string) => saveViewportSnapshot(`viewport_undo/${name}`, rig.scene, rig.camera, {
            width: 360, height: 270, highlight: rig.cube, background: 0x1a1d24
        });
        const rowOf = (s: ReturnType<typeof saveViewportSnapshot>) => Array.from(s.rgba.subarray(0, 64)).join(',');
        const fresh = shot('1_before_edits');
        const keep = (r: ReturnType<typeof saveViewportSnapshot>, name: string) => {
            const dir = path.join(REPO_ROOT, 'test-results', 'screenshots', 'viewport_undo');
            fs.mkdirSync(dir, { recursive: true });
            fs.copyFileSync(r.path, path.join(dir, name));
        };
        keep(fresh, 'mesh_1_before_edits.png');
        rig.ctx.toolMode.current = 'sculpt';
        rig.ctx.sculptSettings.current = { ...rig.ctx.sculptSettings.current, strength: 2.5, radius: 2.5 };
        fire(rig.container, 'mousedown', { clientX: CX, clientY: CY });
        fire(window, 'mouseup', { clientX: CX, clientY: CY });
        rig.ctx.selectedObject.current = rig.cube;
        const moved = (() => {
            rig.ctx.toolMode.current = 'transform';
            rig.ctx.gizmoGroup.current = new THREE.Group();
            rig.ctx.gizmoEngine.current = { hitTest: () => ({ handleType: 'axis-x' }) } as any;
            fire(rig.container, 'mousedown', { clientX: CX, clientY: CY });
            fire(rig.container, 'mousemove', { clientX: CX + 90, clientY: CY });
            fire(window, 'mouseup', { clientX: CX + 90, clientY: CY });
            return shot('2_after_sculpt_and_move');
        })();
        keep(moved, 'mesh_2_after_sculpt_and_move.png');
        rig.controller.undo();
        rig.controller.undo();
        const undone = shot('3_after_two_undos');
        keep(undone, 'mesh_3_after_two_undos.png');
        rig.controller.redo();
        rig.controller.redo();
        const redone = shot('4_after_two_redos');
        keep(redone, 'mesh_4_after_two_redos.png');

        // Pixel-level evidence: the undone frame is the fresh frame; the redone frame is the edited frame.
        expect(Buffer.compare(undone.rgba, fresh.rgba)).toBe(0);
        expect(Buffer.compare(redone.rgba, moved.rgba)).toBe(0);
        expect(Buffer.compare(moved.rgba, fresh.rgba)).not.toBe(0);
        expect(fresh.drawnPixels).toBeGreaterThan(5_000);
        expect(rowOf(fresh)).toBeTruthy();
        rig.detach();
    });
});
