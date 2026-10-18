/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * @terminal and @web are backed by real services: @terminal runs the typed command in the workspace sandbox
 * (POST /workspace/run-command, the same jail and command policy as workspace_run_command) and @web makes Google
 * Search grounding required for the turn. No canned items, no canned output.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import * as http from 'http';
import * as path from 'path';
import { resolveContextMentionQuery } from '../src/browser/generative-canvas/context-mention-engine';
import { buildToolDeclarations, createDefaultToolRegistry } from '../src/node/gemini/tool-registry';
import { createWorkspaceRouter } from '../../../desktop-app/server/routes/workspaceRoutes';
import { REPO_ROOT } from './helpers/requirements';

describe('@terminal and @web mentions', () => {
    it('@terminal offers the typed command to run, and nothing canned when nothing is typed', () => {
        expect(resolveContextMentionQuery('terminal', '')).toEqual([]);
        const [item] = resolveContextMentionQuery('terminal', 'git status');
        expect(item.type).toBe('terminal');
        expect(item.payload).toEqual({ command: 'git status' });
    });

    it('@web is a single search item, with no canned news entry', () => {
        const items = resolveContextMentionQuery('web', 'webgpu timestamp queries');
        expect(items).toHaveLength(1);
        expect(items[0].payload).toEqual({ query: 'webgpu timestamp queries' });
    });

    it('requireGoogleSearch puts the search tool on the turn even when grounding is switched off', () => {
        const registry = createDefaultToolRegistry();
        const off = buildToolDeclarations({ prompt: 'hello', enableGoogleSearch: false } as any, registry) || [];
        expect(off.some(t => 'googleSearch' in t)).toBe(false);
        const required = buildToolDeclarations({ prompt: 'hello', enableGoogleSearch: false, requireGoogleSearch: true } as any, registry) || [];
        expect(required.some(t => 'googleSearch' in t)).toBe(true);
    });
});

describe('POST /workspace/run-command', () => {
    let server: http.Server;
    let base = '';
    beforeAll(async () => {
        const app = express();
        app.use(express.json());
        const ctx = {
            allowedWorkspaceRoots: [REPO_ROOT],
            requireWorkspaceRoot: (c: unknown) => { if (path.resolve(String(c)) !== REPO_ROOT) throw new Error('outside'); return REPO_ROOT; },
            sendError: (res: any, err: any) => res.status(500).json({ success: false, error: String(err?.message || err) }),
            isPathError: () => false
        };
        app.use('/workspace', createWorkspaceRouter({} as any, ctx as any));
        server = app.listen(0);
        await new Promise(r => server.once('listening', r));
        base = `http://127.0.0.1:${(server.address() as any).port}`;
    });
    afterAll(() => new Promise<void>(r => server.close(() => r())));

    const run = async (command: string) => {
        const res = await fetch(`${base}/workspace/run-command`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ command }) });
        return { status: res.status, body: await res.json() as any };
    };

    it('runs an allowed command in the workspace and returns its real output and exit code', async () => {
        const { status, body } = await run('git rev-parse --is-inside-work-tree');
        expect(status).toBe(200);
        expect(body.success).toBe(true);
        expect(body.exitCode).toBe(0);
        expect(body.stdout.trim()).toBe('true');
        expect(body.cwd).toBe(REPO_ROOT);
    }, 60_000);

    it('reports a failing command with its exit code and stderr', async () => {
        const { body } = await run('git show no-such-revision-xyz');
        expect(body.success).toBe(true);
        expect(body.exitCode).not.toBe(0);
        expect(body.stderr).toMatch(/no-such-revision-xyz/);
    }, 60_000);

    it('refuses a command the sandbox policy does not allow', async () => {
        const { status, body } = await run('curl https://example.com');
        expect(status).toBe(403);
        expect(body.success).toBe(false);
        expect(body.code).toBe('command_not_allowed');
    }, 60_000);
});

describe('Browser proxy bridge script', () => {
    it('is valid JavaScript (a syntax error would silently disable console, network and agent actions in proxied pages)', async () => {
        const { BrowserProxyService } = await import('../src/node/browser-proxy-service');
        const html = new BrowserProxyService().rewriteHtml('<html><head><title>t</title></head><body><p>x</p></body></html>', 'https://example.com/', 'https://example.com/');
        const scripts = Array.from(html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)).map(m => m[1]);
        expect(scripts.length).toBeGreaterThan(0);
        for (const src of scripts) expect(() => new Function(src)).not.toThrow();
        // The network and error hooks are part of it.
        expect(html).toContain('scratchbox-browser-network');
        expect(html).toContain('unhandledrejection');
    });
});
