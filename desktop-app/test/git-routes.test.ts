/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as assert from 'assert';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import * as util from 'util';
import { test } from 'vitest';
import { Router, Response } from 'express';
import { createGitRouter } from '../server/routes/workspaceRoutes';
import { isPathError } from '../server/routes/types';
import { assertWorkspaceRoot } from '../../packages/core/src/node/security/path-guard';

const execFileAsync = util.promisify(execFile);

function invokeRouter(
    router: Router,
    method: 'GET' | 'POST',
    url: string,
    options: { query?: Record<string, any>; body?: Record<string, any> } = {}
): Promise<{ status: number; json: any }> {
    return new Promise((resolve) => {
        const req: any = {
            method,
            url,
            query: options.query || {},
            body: options.body || {},
            headers: {}
        };
        const res: any = {
            statusCode: 200,
            status(code: number) {
                this.statusCode = code;
                return this;
            },
            json(payload: any) {
                resolve({ status: this.statusCode, json: payload });
            }
        };
        router(req, res, (err?: any) => {
            if (err) {
                resolve({ status: 500, json: { error: err.message } });
            } else {
                resolve({ status: 404, json: { error: 'Not found' } });
            }
        });
    });
}

test('git routes: branches, status, diff, stage, unstage, and commit', async () => {
    const rawTemp = await fs.mkdtemp(path.join(os.tmpdir(), 'sb-git-routes-'));
    const tempRepo = await fs.realpath(rawTemp);
    process.env.SCRATCHBOX_WORKSPACE_ROOTS = `${os.tmpdir()}:${tempRepo}`;

    try {
        const gitEnv = {
            ...process.env,
            GIT_CONFIG_GLOBAL: '/dev/null',
            GIT_CONFIG_NOSYSTEM: '1',
            HOME: tempRepo
        };

        // Initialize git repo
        await execFileAsync('git', ['init', '-b', 'main'], { cwd: tempRepo, env: gitEnv });
        await execFileAsync('git', ['config', 'user.name', 'Scratchbox Tester'], { cwd: tempRepo, env: gitEnv });
        await execFileAsync('git', ['config', 'user.email', 'test@scratchbox.internal'], { cwd: tempRepo, env: gitEnv });

        // Initial commit
        const readmePath = path.join(tempRepo, 'README.md');
        await fs.writeFile(readmePath, '# Test Repo\nInitial content\n', 'utf-8');
        await execFileAsync('git', ['add', 'README.md'], { cwd: tempRepo, env: gitEnv });
        await execFileAsync('git', ['commit', '-m', 'Initial commit'], { cwd: tempRepo, env: gitEnv });

        const router = createGitRouter({
            allowedWorkspaceRoots: [tempRepo],
            requireWorkspaceRoot: (candidate: unknown) => assertWorkspaceRoot(String(candidate ?? ''), [tempRepo]),
            sendError: (res: Response, err: any) => res.status(500).json({ error: err.message, stack: err.stack }),
            isPathError
        });

        const get = (route: string, query: Record<string, any> = {}) =>
            invokeRouter(router, 'GET', route, { query: { root: tempRepo, ...query } });

        const post = (route: string, body: Record<string, any> = {}) =>
            invokeRouter(router, 'POST', route, { body: { workspaceRoot: tempRepo, ...body } });

        // Test 1: GET /branches
        const branchesRes = await get('/branches');
        assert.strictEqual(branchesRes.status, 200, JSON.stringify(branchesRes.json));
        assert.strictEqual(branchesRes.json.success, true);
        assert.strictEqual(branchesRes.json.current, 'main');

        // Test 2: GET /status (initially clean)
        const cleanStatus = await get('/status');
        assert.strictEqual(cleanStatus.status, 200);
        assert.strictEqual(cleanStatus.json.clean, true);
        assert.strictEqual(cleanStatus.json.staged.length, 0);

        // Test 3: Modify README.md and add an untracked file
        await fs.appendFile(readmePath, 'New feature line added\n', 'utf-8');
        const newFilePath = path.join(tempRepo, 'feature.ts');
        await fs.writeFile(newFilePath, 'export const feature = 42;\n', 'utf-8');

        const dirtyStatus = await get('/status');
        assert.strictEqual(dirtyStatus.status, 200);
        assert.strictEqual(dirtyStatus.json.clean, false);
        assert.ok(dirtyStatus.json.unstaged.some((u: any) => u.path === 'README.md'));
        assert.ok(dirtyStatus.json.untracked.includes('feature.ts'));

        // Test 4: GET /diff
        const diffRes = await get('/diff');
        assert.strictEqual(diffRes.status, 200);
        assert.strictEqual(diffRes.json.success, true);
        assert.ok(diffRes.json.changedFiles.includes('README.md'));
        assert.ok(diffRes.json.stats.additions >= 1);
        assert.ok(diffRes.json.rawDiff.includes('+New feature line added'));

        // Test 5: POST /stage
        const stageRes = await post('/stage', { files: ['README.md'] });
        assert.strictEqual(stageRes.status, 200);
        assert.strictEqual(stageRes.json.success, true);

        const postStageStatus = await get('/status');
        assert.ok(postStageStatus.json.staged.some((s: any) => s.path === 'README.md'));

        // Test 6: POST /unstage
        const unstageRes = await post('/unstage', { files: ['README.md'] });
        assert.strictEqual(unstageRes.status, 200);
        assert.strictEqual(unstageRes.json.success, true);

        const postUnstageStatus = await get('/status');
        assert.strictEqual(postUnstageStatus.json.staged.length, 0);

        // Test 7: Stage all and Commit
        const stageAllRes = await post('/stage', { all: true });
        assert.strictEqual(stageAllRes.status, 200);
        assert.strictEqual(stageAllRes.json.stagedAll, true);

        const commitRes = await post('/commit', { message: 'feat: add feature file and update readme' });
        assert.strictEqual(commitRes.status, 200);
        assert.strictEqual(commitRes.json.success, true);

        const finalStatus = await get('/status');
        assert.strictEqual(finalStatus.json.clean, true);
        assert.strictEqual(finalStatus.json.staged.length, 0);
        assert.strictEqual(finalStatus.json.unstaged.length, 0);
        assert.strictEqual(finalStatus.json.untracked.length, 0);
    } finally {
        await fs.remove(tempRepo);
    }
});
