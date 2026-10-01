/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
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
