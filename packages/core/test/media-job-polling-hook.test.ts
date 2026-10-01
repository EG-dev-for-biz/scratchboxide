import { test } from 'vitest';
/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import {
    pollMediaJobOnce,
    startMediaJobPolling,
    buildMediaJobStatusUrl
} from '../src/browser/generative-canvas/hooks/useMediaJobPolling';

const GC_DIR = path.resolve(__dirname, '../src/browser/generative-canvas');

function makeFetch(responses: Array<{ ok?: boolean; status?: number; body: any }>): { fetchImpl: typeof fetch; calls: Array<{ url: string; signal?: AbortSignal | null }> } {
    const calls: Array<{ url: string; signal?: AbortSignal | null }> = [];
    let idx = 0;
    const fetchImpl = (async (input: any, init?: any) => {
        calls.push({ url: String(input), signal: init?.signal });
        const r = responses[Math.min(idx, responses.length - 1)];
        idx++;
        return {
            ok: r.ok !== false,
            status: r.status ?? 200,
            json: async () => r.body
        } as any;
    }) as unknown as typeof fetch;
    return { fetchImpl, calls };
}

async function runMediaJobPollingTests() {
    console.log('🧪 Running Media Job Polling Hook Test Suite...\n');

    // -------------------------------------------------------------
    // Test 1: Hook module exists and exposes the hook + pure helpers
    // -------------------------------------------------------------
    console.log('  Testing hook module surface...');
    const hookPath = path.join(GC_DIR, 'hooks/useMediaJobPolling.ts');
    assert.ok(fs.existsSync(hookPath), 'hooks/useMediaJobPolling.ts must exist');
    const hookSource = fs.readFileSync(hookPath, 'utf-8');
    assert.ok(/export function useMediaJobPolling\(/.test(hookSource), 'Must export useMediaJobPolling hook');
    assert.ok(/export function useMediaJobPoller\(/.test(hookSource), 'Must export imperative useMediaJobPoller hook');
    assert.ok(hookSource.includes('AbortController'), 'Hook must use an AbortController');
    assert.ok(/cancelled/.test(hookSource), 'Hook must guard with a cancelled flag');
    assert.ok(hookSource.includes('clearInterval') || hookSource.includes('clearTimeout'), 'Hook must clear timers on unmount');
    assert.ok(hookSource.includes('/media/jobs/'), 'Hook must poll the /media/jobs/:id endpoint');
    console.log('  ✓ Test 1 Passed: hook module surface is complete.');

    // -------------------------------------------------------------
    // Test 2: URL construction matches the MediaGenerationClient shape
    // -------------------------------------------------------------
    console.log('  Testing status URL shape...');
    const url = buildMediaJobStatusUrl('/gemini', 'job 1', '/Users/x/ws');
    assert.strictEqual(url, '/gemini/media/jobs/job%201?workspaceRoot=%2FUsers%2Fx%2Fws');
    console.log('  ✓ Test 2 Passed: URL shape matches /media/jobs/:id?workspaceRoot=.');

    // -------------------------------------------------------------
    // Test 3: pollMediaJobOnce pure step
    // -------------------------------------------------------------
    console.log('  Testing pollMediaJobOnce...');
    const { fetchImpl: okFetch, calls: okCalls } = makeFetch([
        { body: { success: true, job: { id: 'j1', status: 'completed', result: { asset: { uri: 'file:///a.png' } } } } }
    ]);
    const done = await pollMediaJobOnce(okFetch, { jobId: 'j1', workspaceRoot: '/ws', baseUrl: '/gemini' });
    assert.strictEqual(done.kind, 'completed');
    assert.strictEqual(done.job?.id, 'j1');
    assert.ok(okCalls[0].url.startsWith('/gemini/media/jobs/j1?workspaceRoot='));

    const { fetchImpl: pendingFetch } = makeFetch([{ body: { success: true, job: { id: 'j1', status: 'running' } } }]);
    const pending = await pollMediaJobOnce(pendingFetch, { jobId: 'j1', workspaceRoot: '/ws', baseUrl: '/gemini' });
    assert.strictEqual(pending.kind, 'pending');

    const { fetchImpl: failFetch } = makeFetch([{ body: { success: true, job: { id: 'j1', status: 'failed', error: { message: 'quota' } } } }]);
    const failed = await pollMediaJobOnce(failFetch, { jobId: 'j1', workspaceRoot: '/ws', baseUrl: '/gemini' });
    assert.strictEqual(failed.kind, 'failed');
    assert.strictEqual(failed.error?.message, 'quota');

    const { fetchImpl: httpErrFetch } = makeFetch([{ ok: false, status: 500, body: {} }]);
    const httpErr = await pollMediaJobOnce(httpErrFetch, { jobId: 'j1', workspaceRoot: '/ws', baseUrl: '/gemini' });
    assert.strictEqual(httpErr.kind, 'error');

    // Completed-with-no-asset must keep polling (matches the original inline semantics)
    const { fetchImpl: noAssetFetch } = makeFetch([{ body: { success: true, job: { id: 'j1', status: 'completed', result: {} } } }]);
    const noAsset = await pollMediaJobOnce(noAssetFetch, { jobId: 'j1', workspaceRoot: '/ws', baseUrl: '/gemini' });
    assert.strictEqual(noAsset.kind, 'pending');
    console.log('  ✓ Test 3 Passed: pollMediaJobOnce classifies completed / pending / failed / error.');

    // -------------------------------------------------------------
    // Test 4: startMediaJobPolling stops after completion and honours stop()/abort
    // -------------------------------------------------------------
    console.log('  Testing startMediaJobPolling lifecycle...');
    const { fetchImpl: seqFetch, calls: seqCalls } = makeFetch([
        { body: { success: true, job: { id: 'j2', status: 'running' } } },
        { body: { success: true, job: { id: 'j2', status: 'running' } } },
        { body: { success: true, job: { id: 'j2', status: 'completed', result: { asset: { uri: 'x' } } } } }
    ]);
    const completedJobs: string[] = [];
    await new Promise<void>((resolve) => {
        startMediaJobPolling({
            jobId: 'j2',
            workspaceRoot: '/ws',
            baseUrl: '/gemini',
            intervalMs: 5,
            fetchImpl: seqFetch,
            onComplete: (job) => { completedJobs.push(job.id); resolve(); },
            onError: (err) => { throw err; }
        });
    });
    await new Promise(r => setTimeout(r, 30));
    assert.deepStrictEqual(completedJobs, ['j2']);
    assert.strictEqual(seqCalls.length, 3, `Polling must stop after completion (got ${seqCalls.length} calls)`);

    // stop() before completion must abort and never invoke callbacks
    const { fetchImpl: foreverFetch, calls: foreverCalls } = makeFetch([{ body: { success: true, job: { id: 'j3', status: 'running' } } }]);
    let cbCount = 0;
    const stop = startMediaJobPolling({
        jobId: 'j3',
        workspaceRoot: '/ws',
        baseUrl: '/gemini',
        intervalMs: 5,
        fetchImpl: foreverFetch,
        onComplete: () => { cbCount++; },
        onError: () => { cbCount++; }
    });
    await new Promise(r => setTimeout(r, 25));
    const callsBeforeStop = foreverCalls.length;
    assert.ok(callsBeforeStop >= 2, 'Should have polled multiple times before stop');
    stop();
    await new Promise(r => setTimeout(r, 30));
    assert.strictEqual(foreverCalls.length, callsBeforeStop, 'No polls after stop()');
    assert.strictEqual(cbCount, 0, 'No callbacks after stop()');
    assert.ok(foreverCalls[0].signal && foreverCalls[0].signal.aborted, 'AbortSignal passed to fetch must be aborted on stop()');
    console.log('  ✓ Test 4 Passed: polling stops on completion and on stop().');

    // -------------------------------------------------------------
    // Test 5: Primitives adopt the hook; no inline setInterval polling remains for media jobs
    // -------------------------------------------------------------
    console.log('  Testing primitive adoption...');
    const nodeGraphSrc = fs.readFileSync(path.join(GC_DIR, 'primitives/NodeGraphPrimitive.tsx'), 'utf-8');
    const markdownSrc = fs.readFileSync(path.join(GC_DIR, 'primitives/MarkdownDocumentPrimitive.tsx'), 'utf-8');
    for (const [name, src] of [['NodeGraphPrimitive', nodeGraphSrc], ['MarkdownDocumentPrimitive', markdownSrc]] as const) {
        assert.ok(/from '\.\.\/hooks\/useMediaJobPolling'/.test(src), `${name} must import from hooks/useMediaJobPolling`);
        assert.ok(!/const pollInterval = setInterval\(/.test(src), `${name} must not keep the copy-pasted setInterval media polling block`);
        assert.ok(/useMediaJobPoller\(/.test(src), `${name} must instantiate useMediaJobPoller`);
    }
    console.log('  ✓ Test 5 Passed: NodeGraph & MarkdownDocument use the shared hook.');

    // -------------------------------------------------------------
    // Test 6: InteractiveBrowserPrimitive only polls pending actions while visible/active
    // -------------------------------------------------------------
    console.log('  Testing InteractiveBrowserPrimitive pending-action polling guard...');
    const browserSrc = fs.readFileSync(path.join(GC_DIR, 'primitives/InteractiveBrowserPrimitive.tsx'), 'utf-8');
    const pollIdx = browserSrc.indexOf('/api/browser/pending-actions');
    assert.ok(pollIdx > 0, 'pending-actions polling must still exist');
    const window = browserSrc.slice(Math.max(0, pollIdx - 3000), pollIdx + 4000);
    assert.ok(/visibilityState|isActive|isVisible/.test(window), 'Pending-action polling must be gated on visibility/active state');
    assert.ok(/AbortController|cancelled/.test(window), 'Pending-action polling must guard in-flight fetches on cleanup');
    assert.ok(/clearInterval\(/.test(window), 'Pending-action polling must clear its interval on cleanup');
    console.log('  ✓ Test 6 Passed: browser polling is gated and cleaned up.');

    console.log('\n🎉 ALL MEDIA JOB POLLING HOOK TESTS PASSED SUCCESSFULLY!');
}

test('media-job-polling-hook.test', async () => {
    await runMediaJobPollingTests();
}, 60_000);
