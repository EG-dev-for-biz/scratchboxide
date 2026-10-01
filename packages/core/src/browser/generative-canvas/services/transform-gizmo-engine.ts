/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as THREE from 'three';
import type {
    TransformGizmoMode,
    TransformGizmoSpace
} from '../canvas-types';

export type { TransformGizmoMode, TransformGizmoSpace };

export type GizmoHandleType =
    | 'axis-x'
    | 'axis-y'
    | 'axis-z'
    | 'plane-xy'
    | 'plane-xz'
    | 'plane-yz'
    | 'rot-x'
    | 'rot-y'
    | 'rot-z'
    | 'scale-x'
    | 'scale-y'
    | 'scale-z'
    | 'scale-uniform';

export interface GizmoHitResult {
    handleType: GizmoHandleType;
    hitPoint: THREE.Vector3;
    object: THREE.Object3D;
}

/**
 * Computes constrained 1D axis translation delta from ray directions.
 */
export function computeAxisTranslation(
    rayOrigin: THREE.Vector3,
    rayDir1: THREE.Vector3,
    rayDir2: THREE.Vector3,
    origin: THREE.Vector3,
    axis: THREE.Vector3
): THREE.Vector3 {
    const normalizedAxis = axis.clone().normalize();
    
    // Choose a plane that contains the axis and faces the camera ray
    const camToOrigin = origin.clone().sub(rayOrigin);
    const planeNormal = camToOrigin.clone().cross(normalizedAxis).cross(normalizedAxis).normalize();
    if (planeNormal.lengthSq() < 0.001) {
        // Fallback normal orthogonal to axis
        if (Math.abs(normalizedAxis.y) < 0.9) {
            planeNormal.set(0, 1, 0).cross(normalizedAxis).normalize();
        } else {
            planeNormal.set(1, 0, 0).cross(normalizedAxis).normalize();
        }
    }

    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(planeNormal, origin);
    
    const ray1 = new THREE.Ray(rayOrigin, rayDir1);
    const ray2 = new THREE.Ray(rayOrigin, rayDir2);
    
    const p1 = new THREE.Vector3();
    const p2 = new THREE.Vector3();
    
    const hit1 = ray1.intersectPlane(plane, p1);
    const hit2 = ray2.intersectPlane(plane, p2);
    
    if (!hit1 || !hit2) {
        return new THREE.Vector3(0, 0, 0);
    }
    
    const delta = p2.clone().sub(p1);
    const projection = normalizedAxis.clone().multiplyScalar(delta.dot(normalizedAxis));
    return projection;
}

/**
 * Computes 2D planar translation delta from ray directions intersecting a plane.
 */
export function computePlaneTranslation(
    rayOrigin: THREE.Vector3,
    rayDir1: THREE.Vector3,
    rayDir2: THREE.Vector3,
    origin: THREE.Vector3,
    planeNormal: THREE.Vector3
): THREE.Vector3 {
    const normalizedNormal = planeNormal.clone().normalize();
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normalizedNormal, origin);

    const ray1 = new THREE.Ray(rayOrigin, rayDir1);
    const ray2 = new THREE.Ray(rayOrigin, rayDir2);

    const p1 = new THREE.Vector3();
    const p2 = new THREE.Vector3();

    const hit1 = ray1.intersectPlane(plane, p1);
    const hit2 = ray2.intersectPlane(plane, p2);

    if (!hit1 || !hit2) {
        return new THREE.Vector3(0, 0, 0);
    }

    return p2.clone().sub(p1);
}

/**
 * Computes signed rotation angle around rotation axis.
 */
export function computeRotationAngle(
    p1: THREE.Vector3,
    p2: THREE.Vector3,
    origin: THREE.Vector3,
    rotationAxis: THREE.Vector3
): number {
    const axis = rotationAxis.clone().normalize();
    const v1 = p1.clone().sub(origin);
    const v2 = p2.clone().sub(origin);

    // Project onto plane orthogonal to rotationAxis
    v1.sub(axis.clone().multiplyScalar(v1.dot(axis)));
    v2.sub(axis.clone().multiplyScalar(v2.dot(axis)));

    const l1 = v1.length();
    const l2 = v2.length();
    if (l1 < 0.0001 || l2 < 0.0001) return 0;

    v1.normalize();
    v2.normalize();

    const cross = v1.clone().cross(v2);
    const dot = Math.max(-1, Math.min(1, v1.dot(v2)));
    const angle = Math.atan2(cross.dot(axis), dot);
    return angle;
}

/**
 * Computes scaling ratio from drag distances.
 */
export function computeScaleFactor(initialDist: number, currentDist: number): number {
    if (Math.abs(initialDist) < 0.0001) return 1.0;
    return currentDist / initialDist;
}

/**
 * Interactive 3D Transform Gizmo Engine.
 */
export class TransformGizmoEngine {
    private colors = {
        x: 0xff3b60,       // Red / Rose
        y: 0x22c55e,       // Green / Emerald
        z: 0x3b82f6,       // Blue / Cyan
        planeX: 0xff3b60,
        planeY: 0x22c55e,
        planeZ: 0x3b82f6,
        white: 0xffffff,
        highlight: 0xffe600
    };

    /**
     * Builds the visual 3D manipulator group for the specified transform mode.
     */
    createGizmo(mode: TransformGizmoMode): THREE.Group {
        const group = new THREE.Group();
        group.name = `sb-gizmo-${mode}`;

        if (mode === 'none') {
            return group;
        }

        switch (mode) {
            case 'translate':
                this.buildTranslateGizmo(group);
                break;
            case 'rotate':
                this.buildRotateGizmo(group);
                break;
            case 'scale':
                this.buildScaleGizmo(group);
                break;
        }

        return group;
    }

    private buildTranslateGizmo(group: THREE.Group): void {
        const length = 1.6;
        const radius = 0.035;
        const arrowLength = 0.38;
        const arrowRadius = 0.12;

        const matX = new THREE.MeshBasicMaterial({ color: this.colors.x, depthTest: false });
        const matY = new THREE.MeshBasicMaterial({ color: this.colors.y, depthTest: false });
        const matZ = new THREE.MeshBasicMaterial({ color: this.colors.z, depthTest: false });

        // X Axis Arrow
        const arrowX = this.createArrow(length, radius, arrowLength, arrowRadius, matX, 'axis-x');
        arrowX.rotateZ(-Math.PI / 2);
        group.add(arrowX);

        // Y Axis Arrow
        const arrowY = this.createArrow(length, radius, arrowLength, arrowRadius, matY, 'axis-y');
        group.add(arrowY);

        // Z Axis Arrow
        const arrowZ = this.createArrow(length, radius, arrowLength, arrowRadius, matZ, 'axis-z');
        arrowZ.rotateX(Math.PI / 2);
        group.add(arrowZ);

        // Planar quad handles
        const planeSize = 0.45;
        const planeOffset = 0.45;

        // XY Plane
        const planeXYMat = new THREE.MeshBasicMaterial({
            color: this.colors.z,
            transparent: true,
            opacity: 0.45,
            side: THREE.DoubleSide,
            depthTest: false
        });
        const planeXY = new THREE.Mesh(new THREE.PlaneGeometry(planeSize, planeSize), planeXYMat);
        planeXY.position.set(planeOffset, planeOffset, 0);
        planeXY.userData = { handleType: 'plane-xy' };
        group.add(planeXY);

        // XZ Plane
        const planeXZMat = new THREE.MeshBasicMaterial({
            color: this.colors.y,
            transparent: true,
            opacity: 0.45,
            side: THREE.DoubleSide,
            depthTest: false
        });
        const planeXZ = new THREE.Mesh(new THREE.PlaneGeometry(planeSize, planeSize), planeXZMat);
        planeXZ.position.set(planeOffset, 0, planeOffset);
        planeXZ.rotateX(Math.PI / 2);
        planeXZ.userData = { handleType: 'plane-xz' };
        group.add(planeXZ);

        // YZ Plane
        const planeYZMat = new THREE.MeshBasicMaterial({
            color: this.colors.x,
            transparent: true,
            opacity: 0.45,
            side: THREE.DoubleSide,
            depthTest: false
        });
        const planeYZ = new THREE.Mesh(new THREE.PlaneGeometry(planeSize, planeSize), planeYZMat);
        planeYZ.position.set(0, planeOffset, planeOffset);
        planeYZ.rotateY(Math.PI / 2);
        planeYZ.userData = { handleType: 'plane-yz' };
        group.add(planeYZ);
    }

    private buildRotateGizmo(group: THREE.Group): void {
        const radius = 1.5;
        const tube = 0.035;
        const segments = 48;

        const matX = new THREE.MeshBasicMaterial({ color: this.colors.x, depthTest: false });
        const matY = new THREE.MeshBasicMaterial({ color: this.colors.y, depthTest: false });
        const matZ = new THREE.MeshBasicMaterial({ color: this.colors.z, depthTest: false });

        // X Ring
        const ringX = new THREE.Mesh(new THREE.TorusGeometry(radius, tube, 12, segments), matX);
        ringX.rotateY(Math.PI / 2);
        ringX.userData = { handleType: 'rot-x' };
        group.add(ringX);

        // Y Ring
        const ringY = new THREE.Mesh(new THREE.TorusGeometry(radius, tube, 12, segments), matY);
        ringY.rotateX(Math.PI / 2);
        ringY.userData = { handleType: 'rot-y' };
        group.add(ringY);

        // Z Ring
        const ringZ = new THREE.Mesh(new THREE.TorusGeometry(radius, tube, 12, segments), matZ);
        ringZ.userData = { handleType: 'rot-z' };
        group.add(ringZ);
    }

    private buildScaleGizmo(group: THREE.Group): void {
        const length = 1.5;
        const radius = 0.035;
        const boxSize = 0.22;

        const matX = new THREE.MeshBasicMaterial({ color: this.colors.x, depthTest: false });
        const matY = new THREE.MeshBasicMaterial({ color: this.colors.y, depthTest: false });
        const matZ = new THREE.MeshBasicMaterial({ color: this.colors.z, depthTest: false });
        const matCenter = new THREE.MeshBasicMaterial({ color: this.colors.white, depthTest: false });

        // X Scale Box Handle
        const stemX = this.createStemWithBox(length, radius, boxSize, matX, 'scale-x');
        stemX.rotateZ(-Math.PI / 2);
        group.add(stemX);

        // Y Scale Box Handle
        const stemY = this.createStemWithBox(length, radius, boxSize, matY, 'scale-y');
        group.add(stemY);

        // Z Scale Box Handle
        const stemZ = this.createStemWithBox(length, radius, boxSize, matZ, 'scale-z');
        stemZ.rotateX(Math.PI / 2);
        group.add(stemZ);

        // Center Uniform Box Handle
        const centerBox = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.28, 0.28), matCenter);
        centerBox.userData = { handleType: 'scale-uniform' };
        group.add(centerBox);
    }

    private createArrow(
        length: number,
        radius: number,
        headLength: number,
        headRadius: number,
        material: THREE.Material,
        handleType: GizmoHandleType
    ): THREE.Group {
        const group = new THREE.Group();
        group.userData = { handleType };

        const stem = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, length, 12), material);
        stem.position.y = length / 2;
        stem.userData = { handleType };

        const head = new THREE.Mesh(new THREE.ConeGeometry(headRadius, headLength, 16), material);
        head.position.y = length + headLength / 2;
        head.userData = { handleType };

        group.add(stem);
        group.add(head);
        return group;
    }

    private createStemWithBox(
        length: number,
        radius: number,
        boxSize: number,
        material: THREE.Material,
        handleType: GizmoHandleType
    ): THREE.Group {
        const group = new THREE.Group();
        group.userData = { handleType };

        const stem = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, length, 12), material);
        stem.position.y = length / 2;
        stem.userData = { handleType };

        const box = new THREE.Mesh(new THREE.BoxGeometry(boxSize, boxSize, boxSize), material);
        box.position.y = length + boxSize / 2;
        box.userData = { handleType };

        group.add(stem);
        group.add(box);
        return group;
    }

    /**
     * Updates the gizmo position, orientation, and screen-space invariant scale.
     */
    updateGizmoTransform(
        gizmo: THREE.Group,
        targetPos: THREE.Vector3,
        targetQuat: THREE.Quaternion,
        space: TransformGizmoSpace,
        camera: THREE.Camera
    ): void {
        gizmo.position.copy(targetPos);

        if (space === 'local') {
            gizmo.quaternion.copy(targetQuat);
        } else {
            gizmo.quaternion.set(0, 0, 0, 1);
        }

        // Screen-space constant scale based on camera distance
        if (camera) {
            const distance = camera.position.distanceTo(targetPos);
            const scale = Math.max(0.1, distance * 0.08);
            gizmo.scale.set(scale, scale, scale);
        }
    }

    /**
     * Raycasts against gizmo handles and returns the hit handle if any.
     */
    hitTest(raycaster: THREE.Raycaster, gizmo: THREE.Group): GizmoHitResult | null {
        const intersects = raycaster.intersectObjects(gizmo.children, true);
        if (intersects.length > 0) {
            const first = intersects[0];
            let obj: THREE.Object3D | null = first.object;
            let handleType: GizmoHandleType | undefined = obj.userData?.handleType;

            while (obj && !handleType && obj !== gizmo) {
                obj = obj.parent;
                if (obj) handleType = obj.userData?.handleType;
            }

            if (handleType) {
                return {
                    handleType,
                    hitPoint: first.point,
                    object: first.object
                };
            }
        }
        return null;
    }
}
