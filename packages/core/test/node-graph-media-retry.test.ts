/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * A node graph media node that failed once and then succeeds must show the new output (and its model note), not the
 * old error. The job result used to be merged over the parameters captured when Generate was clicked, which still
 * held the previous run's error. The last test runs the real NodeGraphPrimitive in headless Chrome (esbuild bundle,
 * stubbed media-jobs API: run 1 fails, run 2 succeeds) and saves a screenshot to test-results/screenshots/.
 */

import { describe, it, expect } from 'vitest';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { spawn } from 'child_process';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { NodeMediaStatus, mediaJobOutcomeParameters } from '../src/browser/generative-canvas/primitives/NodeGraphPrimitive';
import type { GraphNode } from '../src/browser/generative-canvas/canvas-types';
import { REPO_ROOT } from './helpers/requirements';

const substituted = {
    modelUsed: 'gemini-3.1-flash-image',
    requestedModels: ['gemini-3-pro-image', 'gemini-3.1-flash-image'],
    skippedModels: [{ model: 'gemini-3-pro-image', code: 'unsupported' as const, reason: 'not served: 404' }],
    modelNote: 'Generated with gemini-3.1-flash-image, not the requested gemini-3-pro-image: skipped gemini-3-pro-image (not served: 404).'
};

const node = (parameters: Record<string, unknown>) =>
    ({ id: 'n1', label: 'Hero', category: 'image', x: 0, y: 0, parameters } as unknown as GraphNode);

const CHROME = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser']
    .find(p => fs.existsSync(p));

/** Runs headless Chrome until `done(stdout)` holds (checked as output arrives and every 300 ms), it exits, or the timeout. */
function runChrome(args: string[], timeoutMs: number, done: (stdout: string) => boolean): Promise<string> {
    return new Promise(resolve => {
        const proc = spawn(CHROME!, args, { stdio: ['ignore', 'pipe', 'ignore'] });
        let out = '';
        let finished = false;
        const finish = () => {
            if (finished) return;
            finished = true;
            clearTimeout(timer); clearInterval(poll);
            if (proc.exitCode === null) proc.kill('SIGKILL');
            resolve(out);
        };
        proc.stdout.on('data', d => { out += String(d); if (done(out)) finish(); });
        const poll = setInterval(() => { if (done(out)) finish(); }, 300);
        const timer = setTimeout(finish, timeoutMs);
        proc.on('close', finish);
        proc.on('error', finish);
    });
}

describe('Node graph media retry after a failure', () => {
    it('a successful run clears the previous run\'s error and shows its own model note', () => {
        const afterFailure = mediaJobOutcomeParameters({ prompt: 'a red car', model: 'gemini-3-pro-image' }, { error: 'Media model gemini-3-pro-image is unavailable: quota (run 1)' });
        expect(afterFailure.generationError).toContain('quota (run 1)');

        const afterSuccess = mediaJobOutcomeParameters(afterFailure, { resultUrl: '/media/jobs/job2/content', result: substituted });
        expect(afterSuccess.generationError).toBeUndefined();
        expect(afterSuccess.imageUrl).toBe('/media/jobs/job2/content');
        expect(afterSuccess.modelNote).toBe(substituted.modelNote);
        expect(afterSuccess.prompt).toBe('a red car');

        const shown = renderToStaticMarkup(React.createElement(NodeMediaStatus, { node: node(afterSuccess) }));
        expect(shown).not.toContain('sb-node-media-error');
        expect(shown).toContain('not the requested gemini-3-pro-image');
    });

    it('a failed run shows its error and drops the previous output\'s model note', () => {
        const ok = mediaJobOutcomeParameters({}, { resultUrl: '/a', result: substituted });
        const failed = mediaJobOutcomeParameters(ok, { error: 'Media model x is unavailable: quota' });
        expect(failed.modelNote).toBeUndefined();
        expect(renderToStaticMarkup(React.createElement(NodeMediaStatus, { node: node(failed) }))).toContain('sb-node-media-error');
    });

    it.skipIf(!CHROME)('in the real component, retrying after a failure shows the new image without the old error', async () => {
        const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-nodegraph-retry-'));
        try {
            const primitive = path.join(REPO_ROOT, 'packages/core/src/browser/generative-canvas/primitives/NodeGraphPrimitive');
            fs.writeFileSync(path.join(work, 'harness.tsx'), `
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { NodeGraphPrimitive } from ${JSON.stringify(primitive)};
const log: string[] = [];
let jobN = 0;
const json = (b: any) => new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } });
(window as any).fetch = async (url: any, init?: any) => {
    const u = String(url);
    if (init?.method === 'POST' && /\\/media\\/jobs$/.test(u)) { jobN++; return json({ success: true, job: { id: 'job' + jobN, status: 'queued' } }); }
    const m = u.match(/media\\/jobs\\/([^/?]+)\\?/);
    if (m && m[1] === 'job1') return json({ success: true, job: { id: 'job1', status: 'failed', error: { code: 'quota', message: 'Media model gemini-3-pro-image is unavailable: Resource exhausted (run 1)', retryable: true } } });
    if (m) return json({ success: true, job: { id: m[1], status: 'completed', result: ${JSON.stringify({ asset: { uri: 'media://ok', contentHash: 'x', mimeType: 'image/png', byteLength: 1, relativePath: 'a.png' }, ...substituted })} } });
    return json({ success: false });
};
const data: any = { title: 'Flow', nodes: [{ id: 'n1', label: 'Hero', category: 'image', x: 40, y: 40, parameters: { prompt: 'a red car', model: 'gemini-3-pro-image' } }], edges: [] };
createRoot(document.getElementById('root')!).render(React.createElement(NodeGraphPrimitive as any, { data, workspacePath: '/ws' }));
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const state = () => ({
    error: document.querySelector('[data-testid="sb-node-media-error"]')?.textContent || null,
    note: document.querySelector('[data-testid="sb-media-model-note"]')?.textContent || null,
    img: !!document.querySelector('img[src*="/media/jobs/job2"]')
});
(async () => {
    await sleep(500);
    (document.querySelector('.sb-node-prompt-btn') as HTMLButtonElement).click();
    await sleep(3000);
    log.push('run1 ' + JSON.stringify(state()));
    (document.querySelector('.sb-node-prompt-btn') as HTMLButtonElement).click();
    await sleep(3000);
    log.push('run2 ' + JSON.stringify(state()));
    const pre = document.createElement('pre'); pre.id = 'result'; pre.textContent = log.join('\\n');
    pre.setAttribute('style', 'position:fixed;left:8px;right:8px;top:8px;margin:0;padding:8px;font:12px monospace;white-space:pre-wrap;color:#e5e7eb;background:#1f2937;z-index:9999');
    document.body.appendChild(pre);
})();
`);
            const esbuild = await import('esbuild');
            await esbuild.build({
                entryPoints: [path.join(work, 'harness.tsx')], bundle: true, outfile: path.join(work, 'bundle.js'), platform: 'browser',
                format: 'iife', logLevel: 'silent', nodePaths: [path.join(REPO_ROOT, 'node_modules')],
                define: { 'process.env.NODE_ENV': '"production"', global: 'window' }, loader: { '.css': 'empty', '.svg': 'dataurl', '.png': 'dataurl' }
            });
            const page = path.join(work, 'index.html');
            fs.writeFileSync(page, '<!doctype html><html><head><meta charset="utf-8"></head><body style="background:#111;margin:0"><div id="root" style="width:900px;height:600px;position:relative"></div><script src="bundle.js"></script></body></html>');
            const common = ['--headless=new', '--disable-gpu', '--no-first-run', '--use-mock-keychain', '--hide-scrollbars', '--window-size=900,600',
                '--allow-file-access-from-files', '--virtual-time-budget=15000'];
            const dom = await runChrome([...common, `--user-data-dir=${path.join(work, 'p1')}`, '--dump-dom', `file://${page}`], 90_000, out => out.includes('</html>'));
            const result = dom.match(/<pre id="result"[^>]*>([\s\S]*?)<\/pre>/)?.[1] ?? '';
            const run1 = JSON.parse(result.match(/run1 (\{.*\})/)?.[1] ?? 'null');
            const run2 = JSON.parse(result.match(/run2 (\{.*\})/)?.[1] ?? 'null');
            expect(run1, dom.slice(-400)).toMatchObject({ error: expect.stringContaining('Resource exhausted (run 1)'), img: false });
            expect(run2).toMatchObject({ error: null, img: true, note: expect.stringContaining('not the requested gemini-3-pro-image') });

            const shotDir = path.join(REPO_ROOT, 'test-results/screenshots');
            await fs.ensureDir(shotDir);
            const shot = path.join(shotDir, 'node_graph_media_retry_after_failure.png');
            await fs.remove(shot);
            let lastSize = -1;
            await runChrome([...common, `--user-data-dir=${path.join(work, 'p2')}`, `--screenshot=${shot}`, `file://${page}`], 90_000, () => {
                const size = fs.existsSync(shot) ? fs.statSync(shot).size : -1;
                const stable = size > 0 && size === lastSize;
                lastSize = size;
                return stable;
            });
            expect(fs.existsSync(shot)).toBe(true);
        } finally {
            await fs.remove(work);
        }
    }, 240_000);
});
