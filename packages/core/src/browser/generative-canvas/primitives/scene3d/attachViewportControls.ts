/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as THREE from 'three';
import type { Scene3DData, SculptSettings, TransformGizmoMode, TransformGizmoSpace, ViewportToolMode } from '../../canvas-types';
import { applySculptStroke } from '../../services/mesh-sculpting-engine';
import { ObjectEditCapture } from '../../services/viewport-history-deltas';
import type { LiveEdit } from '../../services/viewport-history-deltas';
import {
    TransformGizmoEngine,
    computeAxisTranslation,
    computePlaneTranslation,
    computeRotationAngle,
    computeScaleFactor
} from '../../services/transform-gizmo-engine';
import type { GizmoHandleType } from '../../services/transform-gizmo-engine';
import type { RendererStack } from './types';
import { externalObjectIdOf, findExternalObjectRoot } from './selection';

type Ref<T> = { current: T };

export interface OrbitState { theta: number; phi: number; distance: number }

/** A press that travels less than this (CSS px) before release is a click (select), not a drag. */
export const CLICK_TRAVEL_PX = 4;
/** Orbit distance scales by exp(deltaY * rate) per wheel event: ~12% per 100 px notch at any scale. */
export const WHEEL_ZOOM_RATE = 0.0012;
const MIN_ORBIT_DISTANCE = 1;
/** Near plane used close-up and in FPS mode (matches createRendererStack). */
const DEFAULT_NEAR = 0.1;
const MAX_NEAR = 5;

/**
 * Everything the pointer/keyboard handlers need. All mutable values are refs so the listeners
 * can be attached once per mount and still observe the latest React state.
 */
export interface ViewportControlContext {
    cameraMode: Ref<'orbit' | 'fps'>;
    toolMode: Ref<ViewportToolMode>;
    transformMode: Ref<TransformGizmoMode>;
    transformSpace: Ref<TransformGizmoSpace>;
    sculptSettings: Ref<SculptSettings>;
    orbit: Ref<OrbitState>;
    /** Orbit pivot; panning translates it in the camera's screen plane. */
    target: Ref<THREE.Vector3>;
    keysPressed: Ref<Record<string, boolean>>;

    gizmoEngine: Ref<TransformGizmoEngine>;
    gizmoGroup: Ref<THREE.Group | null>;
    selectedObject: Ref<THREE.Object3D | null>;
    sculptMesh: Ref<THREE.Mesh | null>;
    brushCursor: Ref<THREE.Mesh | null>;
    selectionBox: Ref<THREE.BoxHelper | null>;
    /** Objects that must never be pick targets (starfield, grid, ...). */
    ignoredPickObjects: () => Array<THREE.Object3D | null | undefined>;
    /**
     * Pointer NDC on the displayed frame -> the NDC whose camera ray shows there. Identity unless a lens-distortion
     * pass bends the frame (ViewportOpticsChain.mapPointerNdc); without it picks and gizmo drags miss off-centre.
     */
    mapPointerNdc?: (ndc: THREE.Vector2) => THREE.Vector2;
    /**
     * While set, a click hands the hit under the cursor (or undefined on a miss) and the event to this callback instead
     * of selecting, and presses skip the gizmo and sculpt tools (the camera panel's "pick focus"). Drags still orbit and pan.
     */
    pointPick?: Ref<((hit: THREE.Intersection | undefined, event: MouseEvent) => void) | null>;

    resolveSelectableObject: (hit: THREE.Object3D, root: THREE.Object3D) => THREE.Object3D;
    selectObject: Ref<(obj: THREE.Object3D | null) => void>;
    /**
     * Writes a scene edit. `options.history` describes the undoable step it is (label, the Three.js side
     * of the edit); pass it for every user edit, `false` for view-only changes.
     */
    mutateSceneData: Ref<(
        mutator: (prev: Scene3DData) => Scene3DData,
        opInfo?: { operator: string; params?: any },
        options?: { history?: { label?: string; live?: LiveEdit | null; scene?: boolean; coalesce?: boolean; requireLive?: boolean; selectionId?: string | null } | false }
    ) => void>;
    /** Records an undoable step that changes no scene data (a sculpt stroke, a part inside a loaded model moved). */
    recordEdit: Ref<(label: string, live: LiveEdit | null, meta?: { selectionId?: string | null }) => void>;
    setSelectedObjectId: (id: string | null) => void;
    setSelectedObjectName: (name: string) => void;
}

const vec3 = (o: THREE.Vector3): [number, number, number] => [o.x, o.y, o.z];
const euler3 = (e: THREE.Euler): [number, number, number] => [e.x, e.y, e.z];
const _poseScale = new THREE.Vector3();

/**
 * World-space position and orientation of `obj`. The gizmo is a scene-level group, so it must be
 * placed from this pose: a selected part inside a translated / rotated / ground-snapped model root
 * has a local transform that says nothing about where it is drawn.
 */
export function readWorldPose(obj: THREE.Object3D, outPosition: THREE.Vector3, outQuaternion: THREE.Quaternion): void {
    obj.updateWorldMatrix(true, false);
    obj.matrixWorld.decompose(outPosition, outQuaternion, _poseScale);
}

/** objects[].space.spatial3d stores rotation in degrees (the loader converts back to radians). */
const spatial3dOf = (o: THREE.Object3D) => ({
    x: o.position.x, y: o.position.y, z: o.position.z,
    pitch: THREE.MathUtils.radToDeg(o.rotation.x),
    yaw: THREE.MathUtils.radToDeg(o.rotation.y),
    roll: THREE.MathUtils.radToDeg(o.rotation.z)
});

/**
 * Attaches sculpt / transform-gizmo / orbit-FPS pointer handling plus FPS key tracking to the
 * viewport. Returns a detach function. Attach once per renderer stack.
 *
 * Orbit: left-drag rotates, shift-drag / right-drag / middle-drag pans, the wheel zooms
 * exponentially. Selection happens on a primary-button click (press + release within
 * CLICK_TRAVEL_PX, shift allowed), so orbit and pan drags never raycast or re-select. A click
 * picks the part under the cursor; alt-click picks the whole loaded model it belongs to. Gizmo
 * drags work in world space and are written back into the selection's parent frame.
 */
export function attachViewportControls(stack: RendererStack, ctx: ViewportControlContext): () => void {
    const { container, camera, scene } = stack;
    const raycaster = new THREE.Raycaster();

    let isDragging = false;
    let isPanning = false;
    let pendingPick = false;
    let downX = 0;
    let downY = 0;
    let isSculpting = false;
    let isGizmoDragging = false;
    // Local transform of the selection when the drag began; the whole drag is one history step.
    let gizmoCapture: ObjectEditCapture | null = null;
    // Position buffers when the stroke began; the stroke's changed vertices are one history step.
    let sculptCapture: ObjectEditCapture | null = null;
    let activeHandle: GizmoHandleType | null = null;
    let dragStartRay: { origin: THREE.Vector3; dir: THREE.Vector3 } | null = null;
    // Drag start pose of the selection in WORLD space, plus the inverse world rotation of its parent
    // for converting the dragged world pose back into the local transform.
    const dragInitialPos = new THREE.Vector3();
    const dragInitialQuat = new THREE.Quaternion();
    const dragInitialScale = new THREE.Vector3(1, 1, 1);
    const dragParentQuatInv = new THREE.Quaternion();
    let lastSculptHit: THREE.Vector3 | null = null;
    let previousMouse = { x: 0, y: 0 };

    const setRayFromEvent = (e: MouseEvent) => {
        const rect = container.getBoundingClientRect();
        const ndcX = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        const ndcY = -((e.clientY - rect.top) / rect.height) * 2 + 1;
        const ndc = new THREE.Vector2(ndcX, ndcY);
        raycaster.setFromCamera(ctx.mapPointerNdc ? ctx.mapPointerNdc(ndc) : ndc, camera);
    };

    const isPickable = (item: THREE.Intersection): boolean => {
        let cur: THREE.Object3D | null = item.object;
        if (!cur || !cur.visible) return false;
        if (cur === ctx.gizmoGroup.current || cur.userData?.isGizmo || cur.userData?.handleType) return false;
        const ignored = ctx.ignoredPickObjects();
        if (cur === ctx.brushCursor.current || cur === ctx.selectionBox.current || ignored.includes(cur)) return false;
        while (cur) {
            // three's Raycaster ignores `visible`, so a hidden ancestor must veto the hit here.
            if (!cur.visible) return false;
            if (cur.name && (cur.name.startsWith('sb-gizmo-') || cur.name.startsWith('sb-selection-helper'))) return false;
            if (cur.userData?.isGizmo) return false;
            cur = cur.parent;
        }
        return true;
    };

    const pickSceneHit = (): THREE.Intersection | undefined =>
        raycaster.intersectObjects(scene.children, true).find(isPickable);

    const surfaceNormal = (hit: THREE.Intersection, mesh: THREE.Object3D) =>
        hit.face ? hit.face.normal.clone().transformDirection(mesh.matrixWorld) : new THREE.Vector3(0, 1, 0);

    const placeBrushCursor = (point: THREE.Vector3, normal: THREE.Vector3) => {
        const cursor = ctx.brushCursor.current;
        if (!cursor) return;
        cursor.position.copy(point);
        cursor.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);
        cursor.visible = true;
    };

    const handleMouseDown = (e: MouseEvent) => {
        setRayFromEvent(e);
        pendingPick = false;
        isPanning = false;

        const pointPicking = !!ctx.pointPick?.current;
        // 1. Transform gizmo handle hit
        const selected = ctx.selectedObject.current;
        if (!pointPicking && ctx.toolMode.current === 'transform' && ctx.gizmoGroup.current && selected) {
            const hit = ctx.gizmoEngine.current.hitTest(raycaster, ctx.gizmoGroup.current);
            if (hit) {
                isGizmoDragging = true;
                isDragging = false;
                gizmoCapture = new ObjectEditCapture([selected], { geometry: false });
                activeHandle = hit.handleType;
                dragStartRay = { origin: raycaster.ray.origin.clone(), dir: raycaster.ray.direction.clone() };
                readWorldPose(selected, dragInitialPos, dragInitialQuat);
                if (selected.parent) selected.parent.getWorldQuaternion(dragParentQuatInv).invert();
                else dragParentQuatInv.identity();
                dragInitialScale.copy(selected.scale);
                return;
            }
        }

        // 2. Sculpt stroke start (the only press that needs a scene raycast up front)
        if (!pointPicking && ctx.toolMode.current === 'sculpt') {
            const validHit = pickSceneHit();
            const targetMesh = (validHit && (validHit.object as any).isMesh) ? (validHit.object as THREE.Mesh) : ctx.sculptMesh.current;
            if (targetMesh && targetMesh.geometry && validHit) {
                ctx.sculptMesh.current = targetMesh;
                ctx.selectedObject.current = targetMesh;
                ctx.setSelectedObjectId(targetMesh.name || targetMesh.uuid);
                ctx.setSelectedObjectName(targetMesh.name || 'Sculpt Target Mesh');

                isSculpting = true;
                isDragging = false;
                lastSculptHit = validHit.point.clone();

                sculptCapture = new ObjectEditCapture([targetMesh], { transform: false });

                applySculptStroke(targetMesh.geometry, validHit.point, surfaceNormal(validHit, targetMesh), ctx.sculptSettings.current);
                return;
            }
        }

        // 3. Orbit / pan drag. Selection is deferred to mouseup so that a drag neither raycasts the
        //    scene nor re-selects (selecting persists the artifact through onUpdate).
        if (e.button === 1) e.preventDefault(); // suppress middle-click autoscroll
        isPanning = ctx.cameraMode.current === 'orbit' && (e.button === 1 || e.button === 2 || e.shiftKey);
        // Shift only turns a primary DRAG into a pan; a shift-click without travel still selects.
        pendingPick = e.button === 0;
        downX = e.clientX;
        downY = e.clientY;
        isDragging = true;
        previousMouse = { x: e.clientX, y: e.clientY };
    };

    const panRight = new THREE.Vector3();
    const panUp = new THREE.Vector3();
    /** Translates the orbit pivot so the point under the cursor follows the pointer. */
    const panOrbitTarget = (dx: number, dy: number) => {
        const height = container.clientHeight || container.getBoundingClientRect().height || 1;
        const worldPerPx = (2 * ctx.orbit.current.distance * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) / height;
        camera.updateMatrixWorld();
        panRight.setFromMatrixColumn(camera.matrixWorld, 0);
        panUp.setFromMatrixColumn(camera.matrixWorld, 1);
        ctx.target.current.addScaledVector(panRight, -dx * worldPerPx).addScaledVector(panUp, dy * worldPerPx);
    };

    /** Moves `obj` to a world-space position (its `position` lives in the parent's frame). */
    const setWorldPosition = (obj: THREE.Object3D, world: THREE.Vector3) => {
        obj.position.copy(world);
        if (obj.parent) obj.parent.worldToLocal(obj.position);
    };

    const dragGizmo = () => {
        const selected = ctx.selectedObject.current;
        if (!selected || !dragStartRay || !activeHandle) return;
        const handle = activeHandle;
        // World-space drag frame: the gizmo is drawn at the selection's world pose (it may be a part
        // nested in a moved model root), and the picking rays are world-space too.
        const targetPos = dragInitialPos;
        const targetQuat = dragInitialQuat;
        const rayStart = raycaster.ray.origin;
        const rayDir1 = dragStartRay.dir;
        const rayDir2 = raycaster.ray.direction;
        const local = ctx.transformSpace.current === 'local';

        if (handle.startsWith('axis-')) {
            const axis = new THREE.Vector3(1, 0, 0);
            if (handle === 'axis-y') axis.set(0, 1, 0);
            else if (handle === 'axis-z') axis.set(0, 0, 1);
            if (local) axis.applyQuaternion(targetQuat);
            setWorldPosition(selected, targetPos.clone().add(computeAxisTranslation(rayStart, rayDir1, rayDir2, targetPos, axis)));
        } else if (handle.startsWith('plane-')) {
            const normal = new THREE.Vector3(0, 0, 1);
            if (handle === 'plane-xz') normal.set(0, 1, 0);
            else if (handle === 'plane-yz') normal.set(1, 0, 0);
            if (local) normal.applyQuaternion(targetQuat);
            setWorldPosition(selected, targetPos.clone().add(computePlaneTranslation(rayStart, rayDir1, rayDir2, targetPos, normal)));
        } else if (handle.startsWith('rot-')) {
            const rotAxis = new THREE.Vector3(1, 0, 0);
            if (handle === 'rot-y') rotAxis.set(0, 1, 0);
            else if (handle === 'rot-z') rotAxis.set(0, 0, 1);
            if (local) rotAxis.applyQuaternion(targetQuat);
            const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(rotAxis, targetPos);
            const p1 = new THREE.Vector3();
            const p2 = new THREE.Vector3();
            if (new THREE.Ray(rayStart, rayDir1).intersectPlane(plane, p1) && raycaster.ray.intersectPlane(plane, p2)) {
                const angle = computeRotationAngle(p1, p2, targetPos, rotAxis);
                const worldQuat = new THREE.Quaternion().setFromAxisAngle(rotAxis, angle).multiply(targetQuat);
                selected.quaternion.copy(dragParentQuatInv).multiply(worldQuat);
            }
        } else if (handle.startsWith('scale-')) {
            const dist2 = raycaster.ray.origin.distanceTo(targetPos);
            const dist1 = dragStartRay.origin.distanceTo(targetPos);
            const rawScale = computeScaleFactor(dist1, dist2);
            if (handle === 'scale-uniform') selected.scale.copy(dragInitialScale.clone().multiplyScalar(rawScale));
            else if (handle === 'scale-x') selected.scale.x = dragInitialScale.x * rawScale;
            else if (handle === 'scale-y') selected.scale.y = dragInitialScale.y * rawScale;
            else if (handle === 'scale-z') selected.scale.z = dragInitialScale.z * rawScale;
        }
    };

    const handleMouseMove = (e: MouseEvent) => {
        setRayFromEvent(e);

        // 1. Gizmo drag
        if (isGizmoDragging) {
            dragGizmo();
            return;
        }

        // 2. Continuous sculpt stroke
        const sculptMesh = ctx.sculptMesh.current;
        if (isSculpting && sculptMesh) {
            const intersects = raycaster.intersectObject(sculptMesh, false);
            if (intersects.length > 0) {
                const first = intersects[0];
                const mouseDelta = lastSculptHit ? first.point.clone().sub(lastSculptHit) : new THREE.Vector3();
                const normal = surfaceNormal(first, sculptMesh);
                applySculptStroke(sculptMesh.geometry, first.point, normal, { ...ctx.sculptSettings.current, mouseDelta });
                lastSculptHit = first.point.clone();
                placeBrushCursor(first.point, normal);
            }
            return;
        }

        // 3. Hover brush cursor in sculpt mode
        if (ctx.toolMode.current === 'sculpt' && sculptMesh && ctx.brushCursor.current) {
            const intersects = raycaster.intersectObject(sculptMesh, false);
            if (intersects.length > 0) {
                placeBrushCursor(intersects[0].point, surfaceNormal(intersects[0], sculptMesh));
            } else {
                ctx.brushCursor.current.visible = false;
            }
        } else if (ctx.brushCursor.current) {
            ctx.brushCursor.current.visible = false;
        }

        // 4. Camera rotation / pan
        if (!isDragging) return;
        const deltaX = e.clientX - previousMouse.x;
        const deltaY = e.clientY - previousMouse.y;
        previousMouse = { x: e.clientX, y: e.clientY };

        if (ctx.cameraMode.current === 'orbit' && isPanning) {
            panOrbitTarget(deltaX, deltaY);
        } else if (ctx.cameraMode.current === 'orbit') {
            const rot = ctx.orbit.current;
            rot.theta -= deltaX * 0.005;
            rot.phi -= deltaY * 0.005;
            rot.phi = Math.max(0.05, Math.min(Math.PI - 0.05, rot.phi));
        } else {
            camera.rotation.order = 'YXZ';
            camera.rotation.y -= deltaX * 0.003;
            camera.rotation.x -= deltaY * 0.003;
            camera.rotation.x = Math.max(-Math.PI / 2.2, Math.min(Math.PI / 2.2, camera.rotation.x));
        }
    };

    const commitSculptStroke = () => {
        isSculpting = false;
        const sculptMesh = ctx.sculptMesh.current;
        const objId = sculptMesh?.name || 'sb-sculptable-mesh';
        const settings = ctx.sculptSettings.current;
        // The stroke's vertex edit and the mesh record the write below syncs are one undoable step.
        const strokeEdit = sculptCapture?.finish() ?? null;
        sculptCapture = null;
        ctx.mutateSceneData.current(prev => {
            // Parts of a loaded model are not customMeshes; an entry for them would be rebuilt as a
            // placeholder primitive whenever it syncs before the model has loaded.
            if (findExternalObjectRoot(sculptMesh)) return { ...prev, sculptSettings: settings };
            const meshes = Array.isArray(prev.customMeshes) ? [...prev.customMeshes] : [];
            const idx = meshes.findIndex(m => m.id === objId || m.name === objId);
            const meshData = {
                id: objId,
                name: sculptMesh?.name || 'Sculpt Mesh',
                type: 'custom' as any,
                position: sculptMesh ? vec3(sculptMesh.position) : [0, 0, 0] as [number, number, number],
                rotation: sculptMesh ? euler3(sculptMesh.rotation) : [0, 0, 0] as [number, number, number],
                scale: sculptMesh ? vec3(sculptMesh.scale) : [1, 1, 1] as [number, number, number]
            };
            if (idx >= 0) meshes[idx] = { ...meshes[idx], ...meshData };
            else meshes.push(meshData);
            return { ...prev, customMeshes: meshes, sculptSettings: settings };
        }, {
            operator: 'sb_deform_vertices',
            params: { objectId: objId, brush: settings.brush, radius: settings.radius, strength: settings.strength, falloff: settings.falloff }
        }, {
            history: { label: `Sculpt ${settings.brush}: ${objId}`, live: strokeEdit, coalesce: false, requireLive: true, selectionId: objId }
        });
    };

    const commitGizmoTransform = (selObj: THREE.Object3D) => {
        isGizmoDragging = false;
        activeHandle = null;
        const currentMode = ctx.transformMode.current;
        const verb = currentMode === 'rotate' ? 'Rotate' : currentMode === 'scale' ? 'Scale' : 'Move';
        const dragEdit = gizmoCapture?.finish() ?? null;
        gizmoCapture = null;
        const historyMeta = (label: string) => ({ label: `${verb} ${label}`, live: dragEdit, coalesce: false });
        const opName = currentMode === 'rotate' ? 'sb_rotate' : currentMode === 'scale' ? 'sb_scale' : 'sb_translate';
        const transformParams = { position: vec3(selObj.position), rotation: euler3(selObj.rotation), scale: vec3(selObj.scale) };

        // Loaded models persist through their objects[] entry. Parts inside a model have no schema
        // slot: the edit stays live in the viewport and nothing is written for it.
        const externalRoot = findExternalObjectRoot(selObj);
        if (externalRoot) {
            if (externalRoot !== selObj) {
                // A part inside a loaded model has no schema slot; its move is still one undoable step.
                ctx.recordEdit.current(`${verb} ${selObj.name || 'part'}`, dragEdit, { selectionId: selObj.name || selObj.uuid });
                return;
            }
            const objectId = externalObjectIdOf(externalRoot);
            ctx.mutateSceneData.current(prev => ({
                ...prev,
                objects: (prev.objects || []).map(o => o.id === objectId
                    ? { ...o, space: { ...o.space, spatial3d: spatial3dOf(selObj) } }
                    : o)
            }), { operator: opName, params: { objectId, ...transformParams } }, { history: historyMeta(objectId) });
            return;
        }

        const objId = selObj.name || selObj.uuid;
        ctx.mutateSceneData.current(prev => {
            // Only update an existing definition: a fabricated entry for an object this schema does
            // not own would be rebuilt by syncCustomMeshes as a placeholder primitive.
            let customMeshes = prev.customMeshes;
            const idx = customMeshes ? customMeshes.findIndex(m => m.id === objId || m.name === objId) : -1;
            if (customMeshes && idx >= 0) {
                customMeshes = [...customMeshes];
                customMeshes[idx] = { ...customMeshes[idx], ...transformParams };
            }
            const objects = prev.objects?.map(o => (o.id === objId || o.content?.durableUri === objId)
                ? { ...o, space: { ...o.space, spatial3d: spatial3dOf(selObj) } }
                : o);
            return { ...prev, customMeshes, objects, selectedMeshId: objId };
        }, {
            operator: opName,
            params: { objectId: objId, ...transformParams }
        }, { history: historyMeta(objId) });
    };

    const handleMouseUp = (e: MouseEvent) => {
        if (isSculpting) commitSculptStroke();
        if (isGizmoDragging && ctx.selectedObject.current) commitGizmoTransform(ctx.selectedObject.current);

        // Click (not drag): select what is under the cursor, or clear a visible selection on a miss.
        // Alt-click selects the whole loaded model instead of the part (its root is a pick-through
        // container otherwise, and the only target whose move persists to objects[]).
        if (pendingPick && Math.hypot(e.clientX - downX, e.clientY - downY) < CLICK_TRAVEL_PX) {
            setRayFromEvent(e);
            const hit = pickSceneHit();
            const pointPick = ctx.pointPick?.current;
            if (pointPick) {
                pointPick(hit, e);
            } else if (hit) {
                const modelRoot = e.altKey ? findExternalObjectRoot(hit.object) : null;
                ctx.selectObject.current(modelRoot || ctx.resolveSelectableObject(hit.object, scene));
            } else if (ctx.selectionBox.current?.visible) {
                ctx.selectObject.current(null);
            }
        }
        pendingPick = false;
        isPanning = false;
        isDragging = false;
    };

    const handleWheel = (e: WheelEvent) => {
        if (ctx.cameraMode.current !== 'orbit') return;
        e.preventDefault();
        const rot = ctx.orbit.current;
        const deltaPx = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * (container.clientHeight || 800) : e.deltaY;
        const next = rot.distance * Math.exp(deltaPx * WHEEL_ZOOM_RATE);
        // Never pull an already-farther camera inward when zooming out past the cap.
        const maxDistance = Math.max(2500, camera.far * 0.25, Math.min(rot.distance, next));
        rot.distance = THREE.MathUtils.clamp(next, MIN_ORBIT_DISTANCE, maxDistance);
    };

    // Right-drag pans in orbit mode only; FPS mode keeps the native context menu.
    const handleContextMenu = (e: Event) => {
        if (ctx.cameraMode.current === 'orbit') e.preventDefault();
    };
    const handleKeyDown = (e: KeyboardEvent) => { ctx.keysPressed.current[e.key] = true; };
    const handleKeyUp = (e: KeyboardEvent) => { ctx.keysPressed.current[e.key] = false; };

    container.addEventListener('mousedown', handleMouseDown);
    container.addEventListener('mousemove', handleMouseMove);
    container.addEventListener('contextmenu', handleContextMenu);
    window.addEventListener('mouseup', handleMouseUp);
    container.addEventListener('wheel', handleWheel, { passive: false });
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);

    return () => {
        container.removeEventListener('mousedown', handleMouseDown);
        container.removeEventListener('mousemove', handleMouseMove);
        container.removeEventListener('contextmenu', handleContextMenu);
        window.removeEventListener('mouseup', handleMouseUp);
        container.removeEventListener('wheel', handleWheel);
        window.removeEventListener('keydown', handleKeyDown);
        window.removeEventListener('keyup', handleKeyUp);
    };
}

/** Updates the near plane only when it moves by more than 5% (projection rebuilds are not free). */
function setNearPlane(camera: THREE.PerspectiveCamera, near: number): void {
    if (Math.abs(camera.near - near) > near * 0.05) {
        camera.near = near;
        camera.updateProjectionMatrix();
    }
}

/** Applies orbit or FPS camera motion for one frame. */
export function stepCamera(
    camera: THREE.PerspectiveCamera,
    cameraMode: 'orbit' | 'fps',
    orbit: OrbitState,
    target: THREE.Vector3,
    keys: Record<string, boolean>
): void {
    if (cameraMode === 'orbit') {
        camera.position.x = target.x + orbit.distance * Math.sin(orbit.phi) * Math.sin(orbit.theta);
        camera.position.y = target.y + orbit.distance * Math.cos(orbit.phi);
        camera.position.z = target.z + orbit.distance * Math.sin(orbit.phi) * Math.cos(orbit.theta);
        camera.lookAt(target);
        // Depth precision is governed by near/far: keep near proportional to the viewing distance so
        // km-scale scenes do not z-fight, while close-up work (< 100 m) keeps the default.
        setNearPlane(camera, THREE.MathUtils.clamp(orbit.distance / 1000, DEFAULT_NEAR, MAX_NEAR));
        return;
    }
    setNearPlane(camera, DEFAULT_NEAR);
    const speed = 0.22;
    const dir = new THREE.Vector3();
    camera.getWorldDirection(dir);
    const right = new THREE.Vector3().crossVectors(camera.up, dir).normalize();
    if (keys['w'] || keys['W'] || keys['ArrowUp']) camera.position.addScaledVector(dir, speed);
    if (keys['s'] || keys['S'] || keys['ArrowDown']) camera.position.addScaledVector(dir, -speed);
    if (keys['a'] || keys['A'] || keys['ArrowLeft']) camera.position.addScaledVector(right, speed);
    if (keys['d'] || keys['D'] || keys['ArrowRight']) camera.position.addScaledVector(right, -speed);
    if (keys['q'] || keys['Q']) camera.position.y -= speed * 0.8;
    if (keys['e'] || keys['E']) camera.position.y += speed * 0.8;
}
