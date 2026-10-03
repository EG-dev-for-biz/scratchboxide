/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { Request, Response, Router } from 'express';
import { UserMemoriesService } from '../../../packages/core/src/node';
import { RouteContext } from './types';

/**
 * Creates the Express router handling all User Memories, Writing Profiles,
 * Style Preferences, and Memory configuration endpoints.
 */
export function createMemoriesRouter(memoriesService: UserMemoriesService, ctx: RouteContext): Router {
    const { requireWorkspaceRoot, sendError } = ctx;
    const router = Router();

    // 1. List memories
    router.get('/', async (req: Request, res: Response) => {
        try {
            const { scope, category, categoryGroup, workspaceRoot } = req.query as Record<string, string>;
            const memories = await memoriesService.listMemories({
                scope: scope as any,
                category: category as any,
                categoryGroup: categoryGroup as any,
                workspaceRoot: workspaceRoot ? requireWorkspaceRoot(workspaceRoot) : undefined
            });
            res.json({ success: true, memories });
        } catch (err: any) {
            sendError(res, err);
        }
    });

    // 2. Create memory (canonical POST / and client alias POST /create)
    const createMemory = async (req: Request, res: Response): Promise<void> => {
        try {
            const { category, key, value, scope, workspaceId, workspaceRoot } = req.body || {};
            if (!category || !key || !value) {
                res.status(400).json({ success: false, error: 'category, key, and value are required' });
                return;
            }
            const memory = await memoriesService.createMemory({
                category,
                key,
                value,
                scope,
                workspaceId,
                workspaceRoot: workspaceRoot ? requireWorkspaceRoot(workspaceRoot) : undefined
            });
            res.json({ success: true, memory });
        } catch (err: any) {
            sendError(res, err);
        }
    };
    router.post('/', createMemory);
    router.post('/create', createMemory);

    // 3. Update memory
    router.post('/update', async (req: Request, res: Response) => {
        try {
            const { id, category, key, value, workspaceRoot } = req.body || {};
            if (!id) {
                res.status(400).json({ success: false, error: 'id is required' });
                return;
            }
            const updated = await memoriesService.updateMemory(id, {
                category,
                key,
                value,
                workspaceRoot: workspaceRoot ? requireWorkspaceRoot(workspaceRoot) : undefined
            });
            if (!updated) {
                res.status(404).json({ success: false, error: 'Memory not found' });
                return;
            }
            res.json({ success: true, memory: updated });
        } catch (err: any) {
            sendError(res, err);
        }
    });

    // 4. Delete memory
    router.post('/delete', async (req: Request, res: Response) => {
        try {
            const { id, workspaceRoot } = req.body || {};
            if (!id) {
                res.status(400).json({ success: false, error: 'id is required' });
                return;
            }
            const deleted = await memoriesService.deleteMemory(id, workspaceRoot ? requireWorkspaceRoot(workspaceRoot) : undefined);
            res.json({ success: deleted });
        } catch (err: any) {
            sendError(res, err);
        }
    });

    // 5. Clear category
    router.post('/clear-category', async (req: Request, res: Response) => {
        try {
            const { category, workspaceRoot } = req.body || {};
            if (!category) {
                res.status(400).json({ success: false, error: 'category is required' });
                return;
            }
            const clearedCount = await memoriesService.clearCategory(category, workspaceRoot ? requireWorkspaceRoot(workspaceRoot) : undefined);
            res.json({ success: true, clearedCount });
        } catch (err: any) {
            sendError(res, err);
        }
    });

    // 6. Writing Profiles
    router.get('/writing-profiles', async (req: Request, res: Response) => {
        try {
            const raw = req.query.workspaceRoot as string | undefined;
            const workspaceRoot = raw ? requireWorkspaceRoot(raw) : undefined;
            const profiles = await memoriesService.listWritingProfiles(workspaceRoot);
            const activeProfile = await memoriesService.getActiveWritingProfile(workspaceRoot);
            res.json({ success: true, profiles, activeProfile });
        } catch (err: any) {
            sendError(res, err);
        }
    });

    router.post('/writing-profiles', async (req: Request, res: Response) => {
        try {
            const { action, id, name, stylePrompt, samples, isActive, scope, workspaceRoot: raw } = req.body || {};
            const workspaceRoot = raw ? requireWorkspaceRoot(raw) : undefined;
            if (action === 'set-active' && id) {
                res.json({ success: await memoriesService.setActiveWritingProfile(id, workspaceRoot) });
                return;
            }
            if (action === 'delete' && id) {
                res.json({ success: await memoriesService.deleteWritingProfile(id, workspaceRoot) });
                return;
            }
            if ((action === 'create' || !action) && name && stylePrompt) {
                const profile = await memoriesService.createWritingProfile({ name, stylePrompt, samples, isActive, scope, workspaceRoot });
                res.json({ success: true, profile });
                return;
            }
            res.status(400).json({ success: false, error: 'Invalid action or parameters for writing profiles' });
        } catch (err: any) {
            sendError(res, err);
        }
    });

    // 7. Style Preferences
    router.get('/style-preferences', async (req: Request, res: Response) => {
        try {
            const raw = req.query.workspaceRoot as string | undefined;
            const preferences = await memoriesService.listStylePreferences({
                category: req.query.category as string | undefined,
                workspaceRoot: raw ? requireWorkspaceRoot(raw) : undefined
            });
            res.json({ success: true, preferences });
        } catch (err: any) {
            sendError(res, err);
        }
    });

    router.post('/style-preferences', async (req: Request, res: Response) => {
        try {
            const { action, id, name, description, stylePrompt, category, isDefault, sortOrder, scope, workspaceRoot: raw } = req.body || {};
            const workspaceRoot = raw ? requireWorkspaceRoot(raw) : undefined;
            if (action === 'delete' && id) {
                res.json({ success: await memoriesService.deleteStylePreference(id, workspaceRoot) });
                return;
            }
            if ((action === 'create' || !action) && name && stylePrompt) {
                const preference = await memoriesService.createStylePreference({
                    name, description, stylePrompt, category, isDefault, sortOrder, scope, workspaceRoot
                });
                res.json({ success: true, preference });
                return;
            }
            res.status(400).json({ success: false, error: 'Invalid action or parameters for style preferences' });
        } catch (err: any) {
            sendError(res, err);
        }
    });

    // 8. Memory Config
    router.get('/config', async (_req: Request, res: Response) => {
        try {
            res.json({ success: true, config: await memoriesService.getConfig() });
        } catch (err: any) {
            sendError(res, err);
        }
    });

    router.post('/config', async (req: Request, res: Response) => {
        try {
            res.json({ success: true, config: await memoriesService.updateConfig(req.body || {}) });
        } catch (err: any) {
            sendError(res, err);
        }
    });

    return router;
}
