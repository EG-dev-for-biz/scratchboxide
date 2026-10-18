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

function get(router: Router, url: string, query: Record<string, any>): Promise<{ status: number; json: any }> {
    return new Promise(resolve => {
        const req: any = { method: 'GET', url, query, body: {}, headers: {} };
        const res: any = { statusCode: 200, status(c: number) { this.statusCode = c; return this; }, json(p: any) { resolve({ status: this.statusCode, json: p }); } };
        router(req, res, (err?: any) => resolve({ status: err ? 500 : 404, json: { error: err?.message } }));
    });
}

/** What /status reported from two calls (rev-parse + porcelain v1), for comparison. */
async function v1Status(cwd: string, env: NodeJS.ProcessEnv) {
    const branch = (await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, env })).stdout.trim() || 'main';
    const staged: any[] = [], unstaged: any[] = [], untracked: string[] = [];
    for (const line of (await execFileAsync('git', ['status', '--porcelain=v1', '-u'], { cwd, env })).stdout.split('\n').filter(Boolean)) {
        // v1 quotes the two sides of a rename that contain spaces; v2 does not (the route now reports them unquoted).
        const x = line[0], y = line[1], p = line.substring(3).trim().split(' -> ').map(q => q.replace(/^"(.*)"$/, '$1')).join(' -> ');
        if (x === '?' && y === '?') untracked.push(p);
        else { if (x !== ' ') staged.push({ path: p, status: x }); if (y !== ' ') unstaged.push({ path: p, status: y }); }
    }
    return { branch, staged, unstaged, untracked };
}

test('/status runs git once (porcelain v2 --branch) and reports what the two-call version did', async () => {
    const repo = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'sb-status-v2-')));
    const shimDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sb-git-shim-'));
    const log = path.join(shimDir, 'calls.log');
    const realGit = (await execFileAsync('/usr/bin/which', ['git'])).stdout.trim();
    await fs.writeFile(path.join(shimDir, 'git'), `#!/bin/sh\necho "$1" >> "${log}"\nexec "${realGit}" "$@"\n`, { mode: 0o755 });
    const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', HOME: repo };
    const savedPath = process.env.PATH;
    try {
        const g = (...args: string[]) => execFileAsync('git', args, { cwd: repo, env });
        await g('init', '-b', 'main');
        await g('config', 'user.name', 'T'); await g('config', 'user.email', 't@example.test');
        for (const f of ['a.txt', 'b.txt', 'old name.txt', 'gone.txt']) await fs.writeFile(path.join(repo, f), `${f}\n`);
        await g('add', '.'); await g('commit', '-m', 'init');
        await fs.writeFile(path.join(repo, 'a.txt'), 'staged\n'); await g('add', 'a.txt');
        await fs.writeFile(path.join(repo, 'a.txt'), 'staged then edited\n');
        await fs.writeFile(path.join(repo, 'b.txt'), 'unstaged\n');
        await g('mv', 'old name.txt', 'new name.txt');
        await fs.remove(path.join(repo, 'gone.txt'));
        await fs.ensureDir(path.join(repo, 'dir'));
        await fs.writeFile(path.join(repo, 'dir', 'untracked file.md'), 'x');

        const router = createGitRouter({
            allowedWorkspaceRoots: [repo],
            requireWorkspaceRoot: (c: unknown) => assertWorkspaceRoot(String(c ?? ''), [repo]),
            sendError: (res: Response, err: any) => res.status(500).json({ error: err.message }),
            isPathError
        });
        const expected = await v1Status(repo, env);
        process.env.PATH = `${shimDir}:${savedPath}`;
        await fs.remove(log);
        const r = await get(router, '/status', { root: repo });
        const calls = (await fs.readFile(log, 'utf8')).trim().split('\n');
        assert.deepStrictEqual(calls, ['status'], `git calls: ${calls.join(', ')}`);
        assert.strictEqual(r.status, 200, JSON.stringify(r.json));
        assert.strictEqual(r.json.branch, expected.branch);
        assert.deepStrictEqual(r.json.staged, expected.staged);
        assert.deepStrictEqual(r.json.unstaged, expected.unstaged);
        assert.deepStrictEqual(r.json.untracked, expected.untracked);
        assert.strictEqual(r.json.clean, false);

        // Detached HEAD reads as 'HEAD', as rev-parse --abbrev-ref says.
        process.env.PATH = savedPath;
        await g('stash', '-u'); await g('checkout', '--detach');
        const detached = await get(router, '/status', { root: repo });
        assert.strictEqual(detached.json.branch, 'HEAD');
        assert.strictEqual(detached.json.clean, true);
    } finally {
        process.env.PATH = savedPath;
        await fs.remove(repo); await fs.remove(shimDir);
    }
});
