/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The camera settings panel's edits as operator commands (sb_set_camera, sb_set_camera_lens) and the thin-lens
 * relations it shows. The scene data stays the single source of truth: every edit runs the real operators, the same
 * ones the agent's camera tools dispatch, so undo/redo and the agent see the same camera.
 */

import type { Scene3DData, SceneCameraLens } from '../../canvas-types';
import type { SetCameraLensParams } from '../../services/operators/lighting-camera-operators';
import { createOperatorEngine } from '../../services/direct-dispatch-operator-engine';
import { DEFAULT_CAMERA_FOV_DEG } from './createRendererStack';

export type SceneCamera = NonNullable<Scene3DData['camera']>;
export type Vec3 = [number, number, number];

export type CameraCommand =
    | { operator: 'sb_set_camera'; params: { position?: Vec3; target?: Vec3; fov?: number; keepPoseOnLoad?: boolean } }
    | { operator: 'sb_set_camera_lens'; params: SetCameraLensParams };

/** Film back assumed when the lens names none (a 36 x 24 mm full-frame sensor); written into the lens when it is used. */
export const ASSUMED_SENSOR_MM = { width: 36, height: 24 } as const;
/** Vertical field of view of a scene camera that sets none (the renderer stack's default). */
export const UNSET_FOV_DEG = DEFAULT_CAMERA_FOV_DEG;

/** Vertical field of view (degrees) of a focal length on a sensor height: 2 atan(h / 2f). */
export function verticalFovDeg(focalLengthMm: number, sensorHeightMm: number): number {
    return (2 * Math.atan(sensorHeightMm / (2 * focalLengthMm)) * 180) / Math.PI;
}

/** Focal length (mm) that gives a vertical field of view on a sensor height. */
export function focalLengthForFov(fovDeg: number, sensorHeightMm: number): number {
    return sensorHeightMm / (2 * Math.tan((fovDeg * Math.PI) / 360));
}

export function cameraFov(camera: SceneCamera | undefined): number {
    const fov = camera?.fov;
    return typeof fov === 'number' && fov > 0 && fov < 180 ? fov : UNSET_FOV_DEG;
}

export function sensorOf(lens: SceneCameraLens | undefined): { width: number; height: number; assumed: boolean } {
    const w = lens?.sensorWidthMm, h = lens?.sensorHeightMm;
    if (w && h) return { width: w, height: h, assumed: false };
    if (h) return { width: h * 1.5, height: h, assumed: false };
    return { width: ASSUMED_SENSOR_MM.width, height: ASSUMED_SENSOR_MM.height, assumed: true };
}

/** The focal length the camera has: the lens's own, else the one its field of view gives on its sensor. */
export function effectiveFocalLength(camera: SceneCamera | undefined): { mm: number; derived: boolean } {
    const f = camera?.lens?.focalLengthMm;
    if (f && f > 0) return { mm: f, derived: false };
    return { mm: focalLengthForFov(cameraFov(camera), sensorOf(camera?.lens).height), derived: true };
}

const round = (v: number, digits = 4): number => Number(v.toFixed(digits));

/** Sensor fields to write with a focal length when the lens has none, so the stored lens says what was assumed. */
function sensorParams(lens: SceneCameraLens | undefined): Pick<SetCameraLensParams, 'sensorWidthMm' | 'sensorHeightMm'> {
    const s = sensorOf(lens);
    return lens?.sensorHeightMm ? {} : { sensorWidthMm: s.width, sensorHeightMm: s.height };
}

/** A new focal length: the field of view follows on the lens's sensor. */
export function focalLengthCommands(camera: SceneCamera | undefined, focalLengthMm: number): CameraCommand[] {
    const fov = verticalFovDeg(focalLengthMm, sensorOf(camera?.lens).height);
    return [
        { operator: 'sb_set_camera', params: { fov: round(fov, 3) } },
        { operator: 'sb_set_camera_lens', params: { focalLengthMm, ...sensorParams(camera?.lens) } }
    ];
}

/** A new sensor (film back): the focal length is kept, so the field of view follows. */
export function sensorCommands(camera: SceneCamera | undefined, widthMm: number, heightMm: number): CameraCommand[] {
    const focal = effectiveFocalLength(camera).mm;
    return [
        { operator: 'sb_set_camera', params: { fov: round(verticalFovDeg(focal, heightMm), 3) } },
        { operator: 'sb_set_camera_lens', params: { sensorWidthMm: widthMm, sensorHeightMm: heightMm, focalLengthMm: round(focal) } }
    ];
}

/**
 * Lens fields for depth of field. The circle of confusion needs a focal length; a lens with none gets the one its
 * field of view already gives (the view does not change).
 */
export function lensCommands(camera: SceneCamera | undefined, params: SetCameraLensParams): CameraCommand[] {
    const needsFocal = !camera?.lens?.focalLengthMm && params.focalLengthMm === undefined && !params.clear
        && (params.depthOfField === true || params.apertureFStop != null || params.focusDistanceMeters != null || params.focusObjectId != null
            || params.focusPoint != null || (params.focusMode != null && params.focusMode !== 'manual'));
    const extra: SetCameraLensParams = needsFocal ? { focalLengthMm: round(effectiveFocalLength(camera).mm), ...sensorParams(camera?.lens) } : {};
    return [{ operator: 'sb_set_camera_lens', params: { ...extra, ...params } }];
}

/** Removes the lens (an ideal pinhole again) and puts the field of view back to the unset default. */
export function resetCameraCommands(): CameraCommand[] {
    return [
        { operator: 'sb_set_camera_lens', params: { clear: true } },
        { operator: 'sb_set_camera', params: { fov: UNSET_FOV_DEG, keepPoseOnLoad: false } }
    ];
}

type XYZ = Vec3 | { x: number; y: number; z: number };
const xyz = (v: XYZ): Vec3 => Array.isArray(v) ? v : [v.x, v.y, v.z];

/** Whether the live view stands at a stored pose (to 1e-4 relative, the precision the panel stores poses at). */
export function liveViewMatches(livePosition: XYZ, liveTarget: XYZ, position: Vec3, target: Vec3): boolean {
    const same = (a: Vec3, b: Vec3) => a.every((v, i) => Math.abs(v - b[i]) <= 1e-4 * Math.max(1, Math.abs(b[i])));
    return same(xyz(livePosition), position) && same(xyz(liveTarget), target);
}

/**
 * Puts the live view's pose on the first sb_set_camera command (or a new one in front): an edit from the panel is an
 * edit of the camera the user is looking through, so the stored pose, the agent's tools and a reload agree with it.
 */
export function withLivePose(commands: CameraCommand[], camera: SceneCamera | undefined, live: { position: Vec3; target: Vec3 } | null): CameraCommand[] {
    if (!live) return commands;
    if (camera?.position && camera.target && liveViewMatches(live.position, live.target, camera.position, camera.target)) return commands;
    const pose = { position: live.position.map(v => round(v)) as Vec3, target: live.target.map(v => round(v)) as Vec3 };
    const i = commands.findIndex(c => c.operator === 'sb_set_camera');
    if (i >= 0) return commands.map((c, k) => k === i ? { operator: 'sb_set_camera', params: { ...pose, ...c.params } } as CameraCommand : c);
    return [{ operator: 'sb_set_camera', params: pose }, ...commands];
}

export type CameraCommandResult =
    | { ok: true; camera: SceneCamera | undefined; cameraMode: Scene3DData['cameraMode']; issues: string[] }
    | { ok: false; error: string };

/**
 * Runs the commands with the real operators on a copy of the scene's camera; all or nothing (a refused command, such
 * as distortion that folds back, changes nothing). The caller writes the resulting camera as one undoable step.
 */
export function runCameraCommands(scene: Scene3DData, commands: CameraCommand[]): CameraCommandResult {
    const engine = createOperatorEngine({
        title: scene.title,
        ...(scene.camera ? { camera: JSON.parse(JSON.stringify(scene.camera)) } : {}),
        ...(scene.cameraMode ? { cameraMode: scene.cameraMode } : {})
    } as Scene3DData);
    const issues: string[] = [];
    for (const cmd of commands) {
        const res = engine.dispatch(cmd.operator, cmd.params, { recordHistory: false });
        if (!res.success) return { ok: false, error: res.error || `${cmd.operator} failed` };
        const found = (res.data as { issues?: string[] } | undefined)?.issues;
        if (Array.isArray(found)) issues.push(...found);
    }
    const out = engine.getSceneData();
    return { ok: true, camera: out.camera, cameraMode: out.cameraMode, issues };
}

/**
 * Whether a generated model arriving in the viewport keeps the scene's camera instead of re-framing it. A scene built
 * for a declared shot (sb.shot: `shots`, the camera saved on purpose) always opens on that shot, whether it arrives
 * from the chat into an open viewport or loads on a reload; any other stored pose is kept only for the first model of
 * a mount (a reload), and new generated content re-frames.
 */
export function keepsPoseForGeneratedModel(camera: SceneCamera | undefined, shots: readonly unknown[] | undefined, firstModelOfMount: boolean): boolean {
    if (camera?.position && camera.keepPoseOnLoad && Array.isArray(shots) && shots.length > 0) return true;
    return firstModelOfMount && keepsStoredPose(camera);
}

/** Whether loading the scene should open on its stored pose rather than re-frame generated content. */
export function keepsStoredPose(camera: SceneCamera | undefined): boolean {
    return !!camera?.position && (!!camera.keepPoseOnLoad || !!camera.lens);
}
