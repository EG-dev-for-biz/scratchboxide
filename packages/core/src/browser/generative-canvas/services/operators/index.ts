/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import type { OperatorDefinition } from './types';
import { INSPECT_OPERATORS } from './inspect-operators';
import { TRANSFORM_OPERATORS } from './transform-operators';
import { MESH_EDIT_OPERATORS } from './mesh-edit-operators';
import { MATERIAL_PBR_OPERATORS, PBR_PRESETS } from './material-pbr-operators';
import { LIGHTING_CAMERA_OPERATORS } from './lighting-camera-operators';
import { PHYSICS_ANIMATION_OPERATORS } from './physics-animation-operators';
import { STATE_HISTORY_OPERATORS } from './state-history-operators';
import { NATURE_ATMOSPHERE_OPERATORS } from './nature-atmosphere-operators';
import { ADVANCED_REALISM_OPERATORS } from './advanced-realism-operators';

export * from './types';
export * from './mesh-topology';
export * from './inspect-operators';
export * from './transform-operators';
export * from './mesh-edit-operators';
export * from './material-pbr-operators';
export * from './lighting-camera-operators';
export * from './physics-animation-operators';
export * from './state-history-operators';
export * from './nature-atmosphere-operators';
export * from './advanced-realism-operators';

/**
 * Complete set of all core direct-dispatch operators for Scratchbox 3D Engine.
 */
export const ALL_CORE_OPERATORS: OperatorDefinition[] = [
    ...INSPECT_OPERATORS,
    ...TRANSFORM_OPERATORS,
    ...MESH_EDIT_OPERATORS,
    ...MATERIAL_PBR_OPERATORS,
    ...LIGHTING_CAMERA_OPERATORS,
    ...PHYSICS_ANIMATION_OPERATORS,
    ...STATE_HISTORY_OPERATORS,
    ...NATURE_ATMOSPHERE_OPERATORS,
    ...ADVANCED_REALISM_OPERATORS
];
