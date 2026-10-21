/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The chat warm-up builds a first turn's payload once at the default workspace root, calls no model, never throws, and
 * can be turned off; the workspace pattern cache it primes is then served without a rescan on the turn.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GeminiService } from '../src/node/gemini-service';
import { chatWarmupRequest, warmChatPrompt } from '../src/node/gemini/chat-prompt-warmup';
import { CodebasePatternEngine, PATTERN_ANALYSIS_FRESH_MS } from '../src/node/codebase-pattern-engine';

afterEach(() => vi.restoreAllMocks());

function workspace(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-chat-warmup-'));
    fs.writeFileSync(path.join(root, 'index.ts'), 'export function helloWorld(): string { return "hi"; }\n');
    fs.writeFileSync(path.join(root, 'service.ts'), 'export class HelloService { run() { try { return 1; } catch (e) { throw e; } } }\n');
    return root;
}

describe('warmChatPrompt', () => {
    it('builds the first-call payload for the workspace root once, sends nothing, and logs its time and shape', async () => {
        const root = workspace();
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => { throw new Error('the warm-up must not call out'); });
        const logs: string[] = [];
        const service = new GeminiService();
        const report = await service.warmChatPrompt({ workspaceRoot: root, log: m => logs.push(m) });
        expect(report.error).toBeUndefined();
        expect(report.skipped).toBeUndefined();
        expect(report.workspaceRoot).toBe(root);
        expect(report.systemChars).toBeGreaterThan(10_000);
        expect(report.toolCount).toBeGreaterThan(5);
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(logs).toHaveLength(1);
        expect(logs[0]).toMatch(/^\[chat warm-up\] first-call payload ready in \d+\.\d\d s \(system [\d,]+ chars, \d+ tools; workspace /);
        // the workspace pattern scan the first turn would run is done: the engine holds the root's analysis
        expect(service.getPatternEngine().getLastAnalysis()?.workspaceRoot).toBe(root);
        fs.rmSync(root, { recursive: true, force: true });
    });

    it('is off with SCRATCHBOX_CHAT_WARMUP=0, and a failing build is logged, not thrown', async () => {
        const logs: string[] = [];
        const off = await warmChatPrompt(async () => { throw new Error('never built'); }, { env: { SCRATCHBOX_CHAT_WARMUP: '0' } as NodeJS.ProcessEnv, log: m => logs.push(m), workspaceRoot: '/w' });
        expect(off.skipped).toBe('SCRATCHBOX_CHAT_WARMUP=0');
        expect(logs).toEqual(['[chat warm-up] off (SCRATCHBOX_CHAT_WARMUP=0)']);
        const failed = await warmChatPrompt(async () => { throw new Error('the prompt builder broke'); }, { env: {} as NodeJS.ProcessEnv, log: m => logs.push(m), workspaceRoot: '/w' });
        expect(failed.error).toBe('the prompt builder broke');
        expect(logs[1]).toMatch(/^\[chat warm-up\] failed after \d+\.\d\d s: the prompt builder broke$/);
        const req = chatWarmupRequest('/w');
        expect(req).toMatchObject({ mode: 'agent', workspaceRoot: '/w', chatHistory: [] });
    });
});

describe('the workspace pattern cache', () => {
    it('serves a cached analysis at once and rescans behind it once it is older than PATTERN_ANALYSIS_FRESH_MS, one scan per root at a time', async () => {
        const root = workspace();
        const engine = new CodebasePatternEngine();
        const first = await engine.analyzeWorkspacePatterns(root, { maxExemplars: 3 });
        expect(first.workspaceRoot).toBe(root);
        // fresh: the same object, no scan
        const walk = vi.spyOn(fs.promises, 'readdir');
        expect(await engine.analyzeWorkspacePatterns(root)).toBe(first);
        expect(walk).not.toHaveBeenCalled();
        // stale: the turn gets the old analysis at once; the rescan runs behind it and replaces it
        first.lastAnalyzed = Date.now() - PATTERN_ANALYSIS_FRESH_MS - 1;
        const t0 = Date.now();
        const served = await engine.analyzeWorkspacePatterns(root);
        expect(served).toBe(first);
        expect(Date.now() - t0).toBeLessThan(50);
        await new Promise(r => setTimeout(r, 200));
        const refreshed = await engine.analyzeWorkspacePatterns(root);
        expect(refreshed).not.toBe(first);
        expect(refreshed.lastAnalyzed).toBeGreaterThan(first.lastAnalyzed);
        // two cold calls at a new root share one scan
        const other = workspace();
        const [a, b] = await Promise.all([engine.analyzeWorkspacePatterns(other), engine.analyzeWorkspacePatterns(other)]);
        expect(a).toBe(b);
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(other, { recursive: true, force: true });
    });
});
