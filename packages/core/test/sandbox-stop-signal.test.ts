/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The chat's Stop (or a tool's time limit) must end a workspace_run_command process and everything its shell
 * started; killing only the shell left e.g. a dev server running and holding its port.
 */
import { test, expect } from 'vitest';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { ContainerSandboxService } from '../src/node/container-sandbox-service';

const running = (pattern: string) => {
    try { return execFileSync('pgrep', ['-f', pattern], { encoding: 'utf8' }).trim().length > 0; } catch { return false; }
};

test.skipIf(process.platform === 'win32')('aborting a command kills its whole process tree', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sb-stop-'));
    const sandbox = new ContainerSandboxService();
    await sandbox.createEnvironment({ environmentId: 'stop-test', isolationLevel: 'process-jail', workspaceRoot: root, timeoutMs: 60_000 } as any);
    const stop = new AbortController();
    const started = Date.now();
    // A duration unique to this run, so pgrep cannot match some other process's command line.
    const marker = `sleep ${40 + Math.floor(Math.random() * 1000) / 1000}`;
    setTimeout(() => stop.abort(), 400);
    try {
        // The shell runs sleep as its child; a plain kill of the shell leaves the sleep orphaned.
        const res = await sandbox.executeCommand('stop-test', { command: `${marker} && echo done`, timeoutMs: 60_000, signal: stop.signal });
        expect(Date.now() - started).toBeLessThan(5000);
        expect(res.stdout).not.toContain('done');
        expect(res.stderr).toContain('stopped before it finished');
        await new Promise(r => setTimeout(r, 200));
        expect(running(marker)).toBe(false);
    } finally {
        if (running(marker)) execFileSync('pkill', ['-f', marker]);
        await fs.remove(root);
    }
});
