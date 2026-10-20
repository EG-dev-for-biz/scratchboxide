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
        description: 'Configures rigid body collider physics on an object. Dynamic bodies simulate full rigid body dynamics: gravity, body-to-body collision (sphere–sphere, box–box, sphere–box), impulse-based velocity resolution with friction and restitution, rotational dynamics (angular velocity + quaternion integration), Baumgarte positional correction, and ground-plane contact. Static bodies never move but participate in collision response. Kinematic bodies are driven externally via sb_insert_keyframe. Optional initialVelocity and angularVelocity seed the simulation on first tick.',
        execute: (ctx, params: { objectId: string; bodyType?: RigidBodyType; mass?: number; friction?: number; restitution?: number; colliderShape?: ColliderShape; inertiaTensor?: number; initialVelocity?: [number, number, number]; angularVelocity?: [number, number, number] }) => {
            const found = ctx.findObject(params.objectId);
            if (!found) throw new Error(`Object with id '${params.objectId}' not found.`);

            const physics: PhysicsBodyConfig = {
                bodyType: params.bodyType || 'dynamic',
                mass: params.mass !== undefined ? params.mass : 1.0,
                friction: params.friction !== undefined ? params.friction : 0.5,
                restitution: params.restitution !== undefined ? params.restitution : 0.5,
                colliderShape: params.colliderShape || 'box',
                ...(params.inertiaTensor !== undefined && { inertiaTensor: params.inertiaTensor }),
                ...(params.initialVelocity  !== undefined && { initialVelocity: params.initialVelocity }),
                ...(params.angularVelocity  !== undefined && { angularVelocity: params.angularVelocity }),
            };
            found.object.physics = physics;

            return { objectId: params.objectId, physics };
        }
    },
    {
        name: 'sb_apply_impulse',
        category: 'physics_animation',
        description: 'Applies an instantaneous linear impulse (in world-space N·s) to a dynamic physics body, immediately changing its velocity. Use to throw, launch, or knock objects at runtime. Optionally applies an angular impulse (torque impulse) to spin the body.',
        execute: (ctx, params: { objectId: string; impulse: [number, number, number]; angularImpulse?: [number, number, number] }) => {
            const found = ctx.findObject(params.objectId);
            if (!found) throw new Error(`Object with id '${params.objectId}' not found.`);
            if (!found.object.physics || found.object.physics.bodyType !== 'dynamic') {
                throw new Error(`sb_apply_impulse: object '${params.objectId}' must have dynamic physics.`);
            }
            const mass = found.object.physics.mass > 0 ? found.object.physics.mass : 1;
            // Store pending impulse on the physics config so the runtime can consume it next tick
            const pending = (found.object.physics as PhysicsBodyConfig & { _pendingImpulse?: [number,number,number]; _pendingAngularImpulse?: [number,number,number] });
            const [ix, iy, iz] = params.impulse;
            pending._pendingImpulse = [ix / mass, iy / mass, iz / mass]; // convert to Δv
            if (params.angularImpulse) pending._pendingAngularImpulse = params.angularImpulse;
            return { objectId: params.objectId, impulse: params.impulse };
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
