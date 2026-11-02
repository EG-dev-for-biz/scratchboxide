/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { Request, Response, Router } from 'express';
import { defaultWorldCacheBucket } from '../../../packages/core/src/node/cloud-store/world-cache';
import { listWorldVersions, openWorld, openWorldVersion, saveWorld, syncWorldScene } from '../../../packages/core/src/node/cloud-store/world-scenes';
import { repoPath } from '../../../packages/core/src/node/process/repo-python';

/** Where built worlds live: the folder the renderer serves as /tilesets. */
const TILESETS_DIR = repoPath('desktop-app', 'public', 'tilesets');

/**
 * Cached splat worlds as scenes (world-scenes.ts): open one by its folder name (from this machine's copy when it is here,
 * else fetched from the world cache) and save the scene, splat edits included, as a new version in the cloud.
 */
export function createWorldRouter(): Router {
    const router = Router();

    /**
     * The newest saved version of the world's scene, else the build's own: { scene, source, version?, savedAt? }. A world
     * on this machine answers from its local copy without waiting on the cloud, which is checked afterwards for a newer save.
     * `?version=<name>` opens that saved version instead, and `?version=built` the build's own scene.
     */
    router.get('/:slug/scene', async (req: Request, res: Response) => {
        try {
            const bucket = defaultWorldCacheBucket();
            const version = typeof req.query.version === 'string' && req.query.version ? req.query.version : undefined;
            if (version) {
                const picked = await openWorldVersion<Record<string, unknown>>(req.params.slug, version, TILESETS_DIR, bucket);
                res.json({ success: true, ...picked, scene: { ...picked.scene, world: { slug: req.params.slug, ...(picked.version ? { version: picked.version, savedAt: picked.savedAt } : {}) } } });
                return;
            }
            const opened = await openWorld<Record<string, unknown>>(req.params.slug, TILESETS_DIR, bucket);
            res.json({ success: true, ...opened, scene: { ...opened.scene, world: { slug: req.params.slug, ...(opened.version ? { version: opened.version, savedAt: opened.savedAt } : {}) } } });
            if (bucket && opened.source !== 'cloud') {
                syncWorldScene(req.params.slug, TILESETS_DIR, bucket)
                    .then(newer => { if (newer) console.log(`[worlds] ${req.params.slug}: newer saved version ${newer.version} kept for the next open`); })
                    .catch(err => console.warn(`[worlds] ${req.params.slug}: could not check the cloud for a newer save: ${err?.message || err}`));
            }
        } catch (err: any) {
            res.status(404).json({ success: false, error: err?.message || String(err) });
        }
    });

    /** Saves body.scene as a new version of the world's scene: { version, savedAt }. */
    router.post('/:slug/scene', async (req: Request, res: Response) => {
        const scene = req.body?.scene;
        if (!scene || typeof scene !== 'object' || Array.isArray(scene)) {
            res.status(400).json({ success: false, error: 'scene (the Scene3DData to save) is required' });
            return;
        }
        try {
            const saved = await saveWorld(req.params.slug, { ...scene, world: { slug: req.params.slug } }, TILESETS_DIR, defaultWorldCacheBucket());
            res.json({ success: true, version: saved.version, savedAt: saved.savedAt });
        } catch (err: any) {
            res.status(400).json({ success: false, error: err?.message || String(err) });
        }
    });

    /** The saved versions of the world's scene, newest first: { versions: [{ version, savedAt }], source }. */
    router.get('/:slug/versions', async (req: Request, res: Response) => {
        try {
            res.json({ success: true, ...(await listWorldVersions(req.params.slug, TILESETS_DIR, defaultWorldCacheBucket())) });
        } catch (err: any) {
            res.status(500).json({ success: false, error: err?.message || String(err) });
        }
    });

    return router;
}
