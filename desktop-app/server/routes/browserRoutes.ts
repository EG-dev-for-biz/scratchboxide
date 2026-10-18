/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { Request, Response, Router } from 'express';
import { BrowserProxyService } from '../../../packages/core/src/node';
import { NoActiveBrowserPageError } from '../../../packages/core/src/node/browser-proxy-service';

export function createBrowserRouter(browserProxy: BrowserProxyService): Router {
    const router = Router();

    router.get('/status', (_req: Request, res: Response) => {
        res.json({
            success: true,
            engine: 'Chromium Proxy Gateway',
            status: 'ready',
            timestamp: Date.now()
        });
    });

    router.get('/state', (_req: Request, res: Response) => {
        const state = browserProxy.getActiveState();
        if (!state) {
            const err = new NoActiveBrowserPageError();
            res.status(404).json({ success: false, code: err.code, error: err.message });
            return;
        }
        res.json(state);
    });

    router.post('/state', (req: Request, res: Response) => {
        try {
            browserProxy.updateState(req.body);
        } catch (err) {
            if (err instanceof NoActiveBrowserPageError) {
                res.status(400).json({ success: false, code: err.code, error: err.message });
                return;
            }
            throw err;
        }
        res.json({ success: true });
    });

    router.get('/pending-actions', (_req: Request, res: Response) => {
        res.json(browserProxy.getPendingActions());
    });

    router.post('/action-result', (req: Request, res: Response) => {
        const { id, success, result, error } = req.body;
        const resolved = browserProxy.resolveAction(id, success, result, error);
        res.json({ success: true, resolved });
    });

    router.post('/action', async (req: Request, res: Response) => {
        const { action, params } = req.body;
        try {
            const result = await browserProxy.queueAction(action, params);
            res.json({ success: true, result });
        } catch (err: any) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    router.all('/proxy', async (req: Request, res: Response) => {
        const targetUrlRaw = (req.query.url as string) || (req.body && req.body.url);
        if (!targetUrlRaw) {
            res.status(400).send(`
                <!DOCTYPE html>
                <html>
                <head><title>Scratchbox Browser Proxy Error</title></head>
                <body style="font-family: -apple-system, sans-serif; padding: 40px; background: #0f1015; color: #e2e8f0;">
                    <h2>Missing target URL parameter</h2>
                    <p>Usage: <code>/api/browser/proxy?url=https://example.com</code></p>
                </body>
                </html>
            `);
            return;
        }

        try {
            const targetUrl = browserProxy.normalizeUrl(targetUrlRaw);
            const result = await browserProxy.fetchTarget(targetUrl, {
                method: req.method,
                headers: req.headers as Record<string, string>,
                body: req.body
            });

            res.status(result.statusCode);
            res.set('Content-Type', result.contentType);
            res.set('X-Scratchbox-Resolved-Url', result.resolvedUrl);
            res.send(result.body);
        } catch (err: any) {
            res.status(502).send(`
                <!DOCTYPE html>
                <html>
                <head><title>Proxy Gateway Failed</title></head>
                <body style="font-family: -apple-system, sans-serif; padding: 40px; background: #0f1015; color: #e2e8f0;">
                    <h2>Proxy Gateway Error</h2>
                    <p>${err.message}</p>
                </body>
                </html>
            `);
        }
    });

    return router;
}
