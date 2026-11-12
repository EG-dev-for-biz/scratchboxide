/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Sign in with scratchbox.ai (packages/core/src/node/scratchbox-account). Under `/api/account`, behind the launch token:
 * `POST /sign-in` (the consent page's URL to open), `GET /status` (who, where, until when; never the credential) and
 * `POST /sign-out`. The browser's way back, `GET /auth/scratchbox/callback`, cannot carry the launch token: it is an open
 * route, and only a sign-in this server started (its one-time `state`) can complete there.
 */

import { Request, RequestHandler, Response, Router } from 'express';
import { AccountError, ScratchboxAccount, getScratchboxAccount } from '../../../packages/core/src/node/scratchbox-account/scratchbox-account';
import { RouteContext } from './types';

export function createAccountRouter(ctx: RouteContext, account: ScratchboxAccount = getScratchboxAccount()): Router {
    const router = Router();

    router.post('/sign-in', (req: Request, res: Response) => {
        try {
            const port = req.socket.localPort;
            if (!port) throw new AccountError('invalid_request', 'The server could not tell which port it is listening on.');
            const { url } = account.start({ port });
            res.setHeader('Cache-Control', 'no-store');
            res.json({ success: true, url });
        } catch (err) {
            if (err instanceof AccountError) { res.status(400).json({ success: false, error: err.message, code: err.code }); return; }
            ctx.sendError(res, err);
        }
    });

    router.get('/status', async (_req: Request, res: Response) => {
        try {
            res.setHeader('Cache-Control', 'no-store');
            res.json({ success: true, status: await account.status() });
        } catch (err) {
            ctx.sendError(res, err);
        }
    });

    router.post('/sign-out', async (_req: Request, res: Response) => {
        try {
            const { revoked } = await account.signOut();
            res.json({ success: true, revoked, status: await account.status() });
        } catch (err) {
            ctx.sendError(res, err);
        }
    });

    return router;
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

/** The page the browser lands on; `closeSelf` closes it when the browser allows (a tab a script opened), else the text says to. */
function resultPage(title: string, body: string, closeSelf = false): string {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>`
        + '<style>body{font-family:-apple-system,system-ui,sans-serif;background:#18181b;color:#f4f4f5;display:grid;place-items:center;min-height:100vh;margin:0}'
        + 'main{max-width:420px;padding:32px;text-align:center}h1{font-size:20px;margin:0 0 12px}p{color:#a1a1aa;line-height:1.5;margin:0}</style></head>'
        + `<body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p></main>${closeSelf ? '<script>setTimeout(function(){window.close()},1500)</script>' : ''}</body></html>`;
}

/** The browser's return from scratchbox.ai's consent page: completes the sign-in and tells the user to go back to the IDE. */
export function createAccountCallbackHandler(account: ScratchboxAccount = getScratchboxAccount()): RequestHandler {
    return async (req: Request, res: Response) => {
        const q = (k: string) => (typeof req.query[k] === 'string' ? (req.query[k] as string) : undefined);
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Referrer-Policy', 'no-referrer');
        try {
            const profile = await account.complete({ code: q('code'), state: q('state'), error: q('error') });
            res.type('html').send(resultPage('Signed in to Scratchbox IDE', `You are signed in as ${profile.user.username} for the workspace ${profile.workspace.name}. You can close this tab and return to Scratchbox IDE.`, true));
        } catch (err) {
            const message = err instanceof AccountError ? err.message : 'The sign-in could not be completed. Start it again from Scratchbox IDE.';
            res.status(err instanceof AccountError && err.code === 'access_denied' ? 200 : 400).type('html').send(resultPage('Not signed in', message));
        }
    };
}
