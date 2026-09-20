/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import type { OperatorDefinition } from './types';

export const MODIFIER_OPERATORS: OperatorDefinition[] = [
    {
        name: 'sb_add_modifier',
        category: 'modifiers',
        description: 'Appends a procedural modifier to an object stack.',
        execute: (ctx, params: { objectId: string; modifierType: string; params?: any }) => {
            const found = ctx.findObject(params.objectId);
            if (!found) throw new Error(`Object with id '${params.objectId}' not found.`);

            const obj = found.object;
            if (!obj.modifiers) obj.modifiers = [];

            const modifierId = `mod-${params.modifierType}-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
            const modifier = {
                modifierId,
                type: params.modifierType,
                params: params.params || {},
                enabled: true
            };

            obj.modifiers.push(modifier);

            return { objectId: params.objectId, modifierId, modifierType: params.modifierType, params: modifier.params };
        }
    },
    {
        name: 'sb_apply_modifier',
        category: 'modifiers',
        description: 'Bakes procedural modifier into mesh base geometry and removes from stack.',
        execute: (ctx, params: { objectId: string; modifierId: string }) => {
            const found = ctx.findObject(params.objectId);
            if (!found) throw new Error(`Object with id '${params.objectId}' not found.`);

            const obj = found.object;
            if (!obj.modifiers) throw new Error(`Object '${params.objectId}' has no active modifiers.`);

            const index = obj.modifiers.findIndex((m: any) => m.modifierId === params.modifierId);
            if (index === -1) throw new Error(`Modifier with id '${params.modifierId}' not found.`);

            const removed = obj.modifiers.splice(index, 1)[0];

            return { success: true, objectId: params.objectId, modifierId: params.modifierId, bakedModifier: removed };
        }
    },
    {
        name: 'sb_remove_modifier',
        category: 'modifiers',
        description: 'Discards a modifier from the stack without baking.',
        execute: (ctx, params: { objectId: string; modifierId: string }) => {
            const found = ctx.findObject(params.objectId);
            if (!found) throw new Error(`Object with id '${params.objectId}' not found.`);

            const obj = found.object;
            if (!obj.modifiers) return { success: true, objectId: params.objectId, modifierId: params.modifierId };

            const index = obj.modifiers.findIndex((m: any) => m.modifierId === params.modifierId);
            if (index !== -1) {
                obj.modifiers.splice(index, 1);
            }

            return { success: true, objectId: params.objectId, modifierId: params.modifierId };
        }
    }
];
