/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { cameraPoseAt, normalizeCameraKeys, type CameraPose } from '../../../../common/spatial/camera-path';
import type { Scene3DData } from '../../canvas-types';

/** The orbit (target, distance and angles, as stepCamera reads them) that puts the camera at `position` looking at `target`. */
export function orbitFromPose(position: [number, number, number], target: [number, number, number]): { theta: number; phi: number; distance: number } {
    const dx = position[0] - target[0], dy = position[1] - target[1], dz = position[2] - target[2];
    const distance = Math.max(1e-3, Math.hypot(dx, dy, dz));
    return { theta: Math.atan2(dx, dz), phi: Math.acos(Math.max(-1, Math.min(1, dy / distance))), distance };
}

/** The scene's camera move (timeline.camera, sb.camera_move) at tMs, or null when the scene has no move of two keys or more. */
export function sceneCameraMovePose(scene: Pick<Scene3DData, 'timeline'> | undefined, tMs: number): CameraPose | null {
    const keys = normalizeCameraKeys(scene?.timeline?.camera?.keys);
    return keys.length >= 2 ? cameraPoseAt(keys, tMs) : null;
}
