/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import type { OperatorDefinition } from './types';

export const PHYSICS_ANIMATION_OPERATORS: OperatorDefinition[] = [
    {
        name: 'sb_add_physics',
        category: 'physics_animation',
        description: 'Configures rigid body collider physics parameters on an object.',
        execute: (ctx, params: { objectId: string; bodyType?: 'dynamic' | 'static' | 'kinematic'; mass?: number; friction?: number; restitution?: number; colliderShape?: string }) => {
            const found = ctx.findObject(params.objectId);
            if (!found) throw new Error(`Object with id '${params.objectId}' not found.`);

            (found.object as any).physics = {
                bodyType: params.bodyType || 'dynamic',
                mass: params.mass !== undefined ? params.mass : 1.0,
                friction: params.friction !== undefined ? params.friction : 0.5,
                restitution: params.restitution !== undefined ? params.restitution : 0.5,
                colliderShape: params.colliderShape || 'box'
            };

            return { objectId: params.objectId, physics: (found.object as any).physics };
        }
    },
    {
        name: 'sb_insert_keyframe',
        category: 'physics_animation',
        description: 'Inserts animation keyframe into object animation timeline.',
        execute: (ctx, params: { objectId: string; property: string; timeMs: number; value: any; easing?: string }) => {
            const found = ctx.findObject(params.objectId);
            if (!found) throw new Error(`Object with id '${params.objectId}' not found.`);

            const obj = found.object as any;
            if (!obj.keyframes) obj.keyframes = [];

            const keyframe = {
                property: params.property,
                timeMs: params.timeMs,
                value: params.value,
                easing: params.easing || 'linear'
            };

            obj.keyframes.push(keyframe);
            obj.keyframes.sort((a: any, b: any) => a.timeMs - b.timeMs);

            return { objectId: params.objectId, keyframe, keyframeCount: obj.keyframes.length };
        }
    }
];
