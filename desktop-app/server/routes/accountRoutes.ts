/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Sign in with scratchbox.ai (packages/core/src/node/scratchbox-account), mounted under `/api` behind the launch token
 * and the allowed-origin check. Tokens never leave the server: the UI gets status and the consent page's URL only.
 *
 * - `/api/account`: `POST /sign-in` (starts a connection; answers the consent URL to open, then finishes in the
 *   background when the browser comes back to the account's own loopback listener), `POST /cancel`, `GET /status`,
 *   `POST /sign-out` (revokes this device on scratchbox.ai, then forgets it).
 * - `/api/studio`: the connected workspace's hosted tools for the agent and UI: `GET /status`, `GET /identity`,
 *   `GET /tools` (`cursor`), `POST /tools/call` (`{name, arguments}`), `POST /media` (`{storagePath}` → a signed URL).
 *   The server's tool discovery is authoritative; nothing here retries a failed call.
 */

import { Request, Response, Router } from 'express';
import { getScratchboxAccount } from '../../../packages/core/src/node/scratchbox-account/account-service';
import type { DesktopAccount } from '../../../packages/core/src/node/scratchbox-account/desktop-account';
import { callStudioRequest, callStudioTool } from '../../../packages/core/src/node/scratchbox-studio/studio-mcp-client';
import { RouteContext } from './types';

/** Only the account's own fixed messages reach the UI, never a server's answer or a URL. */
const FIXED = /^(Scratchbox |Secure OS|Saved Scratchbox|Finish or cancel|Disconnect the current|The saved Scratchbox)/;
const messageOf = (err: unknown) => (err instanceof Error && FIXED.test(err.message) ? err.message : 'Scratchbox request failed. Connect again or manage this device on scratchbox.ai.');

export function createAccountRouter(ctx: RouteContext, account: () => DesktopAccount = getScratchboxAccount): Router {
    const router = Router();
    router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });

    router.post('/sign-in', async (_req: Request, res: Response) => {
        let opened!: (url: string) => void;
        const consentUrl = new Promise<string>(resolve => { opened = resolve; });
        const connecting = account().connect(async url => { opened(url); });
        connecting.catch(() => undefined); // its outcome shows in the status
        try {
            const url = await Promise.race([consentUrl, connecting.then(() => { throw new Error('Scratchbox sign-in finished before the browser opened.'); })]);
            res.json({ success: true, url, status: account().status() });
        } catch (err) {
            res.status(409).json({ success: false, error: messageOf(err), status: account().status() });
        }
    });

    router.post('/cancel', async (_req: Request, res: Response) => {
        try {
            await account().cancel();
            res.json({ success: true, status: account().status() });
        } catch (err) {
            ctx.sendError(res, err);
        }
    });

    router.get('/status', (_req: Request, res: Response) => {
        res.json({ success: true, status: account().status() });
    });

    router.post('/sign-out', async (_req: Request, res: Response) => {
        try {
            const { revoked } = await account().disconnect();
            res.json({ success: true, revoked, status: account().status() });
        } catch (err) {
            res.status(500).json({ success: false, error: messageOf(err), status: account().status() });
        }
    });

    return router;
}

export function createStudioRouter(account: () => DesktopAccount = getScratchboxAccount): Router {
    const router = Router();
    router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
    const handle = (operation: (req: Request) => Promise<unknown>) => async (req: Request, res: Response) => {
        try { res.json(await operation(req)); }
        catch (err) {
            const known = err instanceof Error && (FIXED.test(err.message) || err.name === 'StudioMcpError');
            res.status(502).json({ error: known ? (err as Error).message : 'Scratchbox request did not finish successfully. It was not retried; check its operation before repeating a change.' });
        }
    };
    const config = () => {
        const c = account().studioConfig();
        if (!c) throw new Error('Scratchbox workspace not connected: connect one in Settings > Account.');
        return c;
    };
    router.get('/status', (_req, res) => { res.json(account().status()); });
    router.get('/identity', handle(() => account().identity()));
    router.get('/tools', handle(req => {
        const cursor = req.query.cursor;
        if (cursor !== undefined && (typeof cursor !== 'string' || cursor.length > 2048)) throw new Error('Scratchbox tools cursor is invalid.');
        return callStudioRequest(config(), 'tools/list', cursor ? { cursor } : {});
    }));
    router.post('/tools/call', handle(req => {
        const { name, arguments: args } = req.body ?? {};
        if (typeof name !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(name) || !args || typeof args !== 'object' || Array.isArray(args)) {
            throw new Error('Scratchbox tool call is invalid: give a tool name and an arguments object.');
        }
        return callStudioTool(config(), name, args);
    }));
    router.post('/media', handle(req => {
        if (typeof req.body?.storagePath !== 'string' || req.body.storagePath.length > 2048) throw new Error('Scratchbox media path is invalid.');
        return account().mediaUrl(req.body.storagePath).then(url => ({ url }));
    }));
    return router;
}
