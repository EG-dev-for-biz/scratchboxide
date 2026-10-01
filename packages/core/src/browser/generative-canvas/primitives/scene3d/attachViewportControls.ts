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
import { applySculptStroke, MeshHistoryStack } from '../../services/mesh-sculpting-engine';
import {
    TransformGizmoEngine,
    computeAxisTranslation,
    computePlaneTranslation,
    computeRotationAngle,
    computeScaleFactor
} from '../../services/transform-gizmo-engine';
import type { GizmoHandleType } from '../../services/transform-gizmo-engine';
import type { RendererStack } from './types';

type Ref<T> = { current: T };

export interface OrbitState { theta: number; phi: number; distance: number }

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
    keysPressed: Ref<Record<string, boolean>>;

    gizmoEngine: Ref<TransformGizmoEngine>;
    gizmoGroup: Ref<THREE.Group | null>;
    selectedObject: Ref<THREE.Object3D | null>;
    sculptMesh: Ref<THREE.Mesh | null>;
    brushCursor: Ref<THREE.Mesh | null>;
    selectionBox: Ref<THREE.BoxHelper | null>;
    /** Objects that must never be pick targets (starfield, grid, ...). */
    ignoredPickObjects: () => Array<THREE.Object3D | null | undefined>;
    history: Ref<MeshHistoryStack>;

    resolveSelectableObject: (hit: THREE.Object3D, root: THREE.Object3D) => THREE.Object3D;
    selectObject: Ref<(obj: THREE.Object3D | null) => void>;
    mutateSceneData: Ref<(mutator: (prev: Scene3DData) => Scene3DData, opInfo?: { operator: string; params?: any }) => void>;
    setSelectedObjectId: (id: string | null) => void;
    setSelectedObjectName: (name: string) => void;
    setCanUndo: (v: boolean) => void;
    setCanRedo: (v: boolean) => void;
}

const vec3 = (o: THREE.Vector3): [number, number, number] => [o.x, o.y, o.z];
const euler3 = (e: THREE.Euler): [number, number, number] => [e.x, e.y, e.z];

/**
 * Attaches sculpt / transform-gizmo / orbit-FPS pointer handling plus FPS key tracking to the
 * viewport. Returns a detach function. Attach once per renderer stack.
 */
export function attachViewportControls(stack: RendererStack, ctx: ViewportControlContext): () => void {
    const { container, camera, scene } = stack;
    const raycaster = new THREE.Raycaster();

    let isDragging = false;
    let isSculpting = false;
    let isGizmoDragging = false;
    let activeHandle: GizmoHandleType | null = null;
    let dragStartRay: { origin: THREE.Vector3; dir: THREE.Vector3 } | null = null;
    const dragInitialPos = new THREE.Vector3();
    const dragInitialQuat = new THREE.Quaternion();
    const dragInitialScale = new THREE.Vector3(1, 1, 1);
    let lastSculptHit: THREE.Vector3 | null = null;
    let previousMouse = { x: 0, y: 0 };

    const setRayFromEvent = (e: MouseEvent) => {
        const rect = container.getBoundingClientRect();
        const ndcX = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        const ndcY = -((e.clientY - rect.top) / rect.height) * 2 + 1;
        raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), camera);
    };

    const isPickable = (item: THREE.Intersection): boolean => {
        let cur: THREE.Object3D | null = item.object;
        if (!cur || !cur.visible) return false;
        if (cur === ctx.gizmoGroup.current || cur.userData?.isGizmo || cur.userData?.handleType) return false;
        const ignored = ctx.ignoredPickObjects();
        if (cur === ctx.brushCursor.current || cur === ctx.selectionBox.current || ignored.includes(cur)) return false;
        while (cur) {
            if (cur.name && (cur.name.startsWith('sb-gizmo-') || cur.name.startsWith('sb-selection-helper'))) return false;
            if (cur.userData?.isGizmo) return false;
            cur = cur.parent;
        }
        return true;
    };

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

        // 1. Transform gizmo handle hit
        const selected = ctx.selectedObject.current;
        if (ctx.toolMode.current === 'transform' && ctx.gizmoGroup.current && selected) {
            const hit = ctx.gizmoEngine.current.hitTest(raycaster, ctx.gizmoGroup.current);
            if (hit) {
                isGizmoDragging = true;
                isDragging = false;
                activeHandle = hit.handleType;
                dragStartRay = { origin: raycaster.ray.origin.clone(), dir: raycaster.ray.direction.clone() };
                dragInitialPos.copy(selected.position);
                dragInitialQuat.copy(selected.quaternion);
                dragInitialScale.copy(selected.scale);
                return;
            }
        }

        // 2. Pick scene geometry
        const intersects = raycaster.intersectObjects(scene.children, true);
        const validHit = intersects.find(isPickable);

        // 3. Sculpt stroke start
        if (ctx.toolMode.current === 'sculpt') {
            const targetMesh = (validHit && (validHit.object as any).isMesh) ? (validHit.object as THREE.Mesh) : ctx.sculptMesh.current;
            if (targetMesh && targetMesh.geometry && validHit) {
                ctx.sculptMesh.current = targetMesh;
                ctx.selectedObject.current = targetMesh;
                ctx.setSelectedObjectId(targetMesh.name || targetMesh.uuid);
                ctx.setSelectedObjectName(targetMesh.name || 'Sculpt Target Mesh');

                isSculpting = true;
                isDragging = false;
                lastSculptHit = validHit.point.clone();

                ctx.history.current.pushState(targetMesh.geometry);
                ctx.setCanUndo(ctx.history.current.canUndo());
                ctx.setCanRedo(ctx.history.current.canRedo());

                applySculptStroke(targetMesh.geometry, validHit.point, surfaceNormal(validHit, targetMesh), ctx.sculptSettings.current);
                return;
            }
        }

        // 4. Direct selection
        if (validHit) {
            ctx.selectObject.current(ctx.resolveSelectableObject(validHit.object, scene));
        }

        isDragging = true;
        previousMouse = { x: e.clientX, y: e.clientY };
    };

    const dragGizmo = () => {
        const selected = ctx.selectedObject.current;
        if (!selected || !dragStartRay || !activeHandle) return;
        const handle = activeHandle;
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
            selected.position.copy(targetPos.clone().add(computeAxisTranslation(rayStart, rayDir1, rayDir2, targetPos, axis)));
        } else if (handle.startsWith('plane-')) {
            const normal = new THREE.Vector3(0, 0, 1);
            if (handle === 'plane-xz') normal.set(0, 1, 0);
            else if (handle === 'plane-yz') normal.set(1, 0, 0);
            if (local) normal.applyQuaternion(targetQuat);
            selected.position.copy(targetPos.clone().add(computePlaneTranslation(rayStart, rayDir1, rayDir2, targetPos, normal)));
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
                selected.quaternion.copy(new THREE.Quaternion().setFromAxisAngle(rotAxis, angle).multiply(targetQuat));
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

        // 4. Camera rotation
        if (!isDragging) return;
        const deltaX = e.clientX - previousMouse.x;
        const deltaY = e.clientY - previousMouse.y;
        previousMouse = { x: e.clientX, y: e.clientY };

        if (ctx.cameraMode.current === 'orbit') {
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
        ctx.setCanUndo(ctx.history.current.canUndo());
        ctx.setCanRedo(ctx.history.current.canRedo());

        const sculptMesh = ctx.sculptMesh.current;
        const objId = sculptMesh?.name || 'sb-sculptable-mesh';
        const settings = ctx.sculptSettings.current;
        ctx.mutateSceneData.current(prev => {
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
        });
    };

    const commitGizmoTransform = (selObj: THREE.Object3D) => {
        isGizmoDragging = false;
        activeHandle = null;
        const objId = selObj.name || selObj.uuid;
        const currentMode = ctx.transformMode.current;
        const opName = currentMode === 'rotate' ? 'sb_rotate' : currentMode === 'scale' ? 'sb_scale' : 'sb_translate';

        ctx.mutateSceneData.current(prev => {
            const meshes = Array.isArray(prev.customMeshes) ? [...prev.customMeshes] : [];
            const idx = meshes.findIndex(m => m.id === objId || m.name === objId);
            const meshData = {
                id: objId,
                name: selObj.name || objId,
                type: (idx >= 0 && meshes[idx].type) ? meshes[idx].type : 'box' as any,
                position: vec3(selObj.position),
                rotation: euler3(selObj.rotation),
                scale: vec3(selObj.scale)
            };
            if (idx >= 0) meshes[idx] = { ...meshes[idx], ...meshData };
            else meshes.push(meshData);

            let objects = prev.objects;
            if (objects && objects.length > 0) {
                objects = objects.map(o => (o.id === objId || o.content?.durableUri === objId)
                    ? {
                        ...o,
                        space: {
                            ...o.space,
                            spatial3d: {
                                x: selObj.position.x, y: selObj.position.y, z: selObj.position.z,
                                pitch: selObj.rotation.x, yaw: selObj.rotation.y, roll: selObj.rotation.z
                            }
                        }
                    }
                    : o);
            }
            return { ...prev, customMeshes: meshes, objects, selectedMeshId: objId };
        }, {
            operator: opName,
            params: { objectId: objId, position: vec3(selObj.position), rotation: euler3(selObj.rotation), scale: vec3(selObj.scale) }
        });
    };

    const handleMouseUp = () => {
        if (isSculpting) commitSculptStroke();
        if (isGizmoDragging && ctx.selectedObject.current) commitGizmoTransform(ctx.selectedObject.current);
        isDragging = false;
    };

    const handleWheel = (e: WheelEvent) => {
        if (ctx.cameraMode.current !== 'orbit') return;
        e.preventDefault();
        const rot = ctx.orbit.current;
        rot.distance = Math.max(5, Math.min(2500, rot.distance + e.deltaY * 0.08));
    };

    const handleKeyDown = (e: KeyboardEvent) => { ctx.keysPressed.current[e.key] = true; };
    const handleKeyUp = (e: KeyboardEvent) => { ctx.keysPressed.current[e.key] = false; };

    container.addEventListener('mousedown', handleMouseDown);
    container.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    container.addEventListener('wheel', handleWheel, { passive: false });
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);

    return () => {
        container.removeEventListener('mousedown', handleMouseDown);
        container.removeEventListener('mousemove', handleMouseMove);
        window.removeEventListener('mouseup', handleMouseUp);
        container.removeEventListener('wheel', handleWheel);
        window.removeEventListener('keydown', handleKeyDown);
        window.removeEventListener('keyup', handleKeyUp);
    };
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
        return;
    }
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
