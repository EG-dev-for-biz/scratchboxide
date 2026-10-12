/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import type { OperatorDefinition } from './types';
import type { AnimationKeyframe, ColliderShape, PhysicsBodyConfig, RigidBodyType } from '../../canvas-types';

export const PHYSICS_ANIMATION_OPERATORS: OperatorDefinition[] = [
    {
        name: 'sb_add_physics',
        category: 'physics_animation',
        description: 'Configures rigid body collider physics on an object. Dynamic bodies fall under gravity and bounce/settle against the ground plane every frame in the Scene3D viewport render loop (linear motion + ground contact only — no body-to-body collision or rotational dynamics); static bodies never move; kinematic bodies are unaffected by gravity and are expected to be driven externally (e.g. by sb_insert_keyframe).',
        execute: (ctx, params: { objectId: string; bodyType?: RigidBodyType; mass?: number; friction?: number; restitution?: number; colliderShape?: ColliderShape }) => {
            const found = ctx.findObject(params.objectId);
            if (!found) throw new Error(`Object with id '${params.objectId}' not found.`);

            const physics: PhysicsBodyConfig = {
                bodyType: params.bodyType || 'dynamic',
                mass: params.mass !== undefined ? params.mass : 1.0,
                friction: params.friction !== undefined ? params.friction : 0.5,
                restitution: params.restitution !== undefined ? params.restitution : 0.5,
                colliderShape: params.colliderShape || 'box'
            };
            found.object.physics = physics;

            return { objectId: params.objectId, physics };
        }
    },
    {
        name: 'sb_insert_keyframe',
        category: 'physics_animation',
        description: 'Inserts a keyframe on a position/rotation/scale property (e.g. "position" with a [x,y,z] value, or "position.y" with a number) into an object\'s animation timeline. Every frame, the Scene3D viewport render loop interpolates between keyframes at the current playback time and writes the result directly onto the live object.',
        execute: (ctx, params: { objectId: string; property: string; timeMs: number; value: number | [number, number, number]; easing?: AnimationKeyframe['easing'] }) => {
            const found = ctx.findObject(params.objectId);
            if (!found) throw new Error(`Object with id '${params.objectId}' not found.`);

            const obj = found.object;
            if (!obj.keyframes) obj.keyframes = [];

            const keyframe: AnimationKeyframe = {
                property: params.property,
                timeMs: params.timeMs,
                value: params.value,
                easing: params.easing || 'linear'
            };

            obj.keyframes.push(keyframe);
            obj.keyframes.sort((a: AnimationKeyframe, b: AnimationKeyframe) => a.timeMs - b.timeMs);

            return { objectId: params.objectId, keyframe, keyframeCount: obj.keyframes.length };
        }
    }
];
