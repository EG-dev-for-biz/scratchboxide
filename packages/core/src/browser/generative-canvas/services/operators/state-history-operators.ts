/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import type { Scene3DData } from '../../canvas-types';
import type { OperatorDefinition } from './types';

export const STATE_HISTORY_OPERATORS: OperatorDefinition[] = [
    {
        name: 'sb_undo',
        category: 'state_history',
        description: 'Rolls back the last scene mutation from history.',
        execute: (ctx) => {
            const undone = ctx.undo();
            return { success: undone, currentSceneTitle: ctx.getSceneData().title };
        }
    },
    {
        name: 'sb_redo',
        category: 'state_history',
        description: 'Reapplies the next scene mutation in history.',
        execute: (ctx) => {
            const redone = ctx.redo();
            return { success: redone, currentSceneTitle: ctx.getSceneData().title };
        }
    },
    {
        name: 'sb_reset_scene',
        category: 'state_history',
        description: 'Resets scene to initial empty/default state.',
        execute: (ctx, params?: Partial<Scene3DData>) => {
            ctx.resetScene(params);
            return { success: true, scene: ctx.getSceneData() };
        }
    }
];
