/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * A staged build streams each stage's status change through ctx.emitStage: a status event on the chat SSE carrying
 * the running card (one id, updated in place) and the stageEvent, plus the scene artifact only when the stage
 * committed, degraded or finished. It restarts the tool's idle limit, and a call after the tool call settled is
 * dropped. The model is a fake fetch; the tool is registered on the real service.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { GeminiService } from '../src/node/gemini-service';
import { TOOL_TIME_BUDGETS } from '../src/node/gemini/tool-time-budgets';
import type { GeminiStreamEvent } from '../src/common/gemini-protocol';
import type { ToolContext } from '../src/node/gemini/tools/types';
import type { CanvasArtifact } from '../src/browser/generative-canvas/canvas-types';
import { stageEvent } from './helpers/staged-location-fixtures';

const TOOL_CALL = (name: string) => `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ functionCall: { name, args: { query: 'x' } } }] }, finishReason: 'STOP' }] })}\ndata: [DONE]`;
const TEXT = (t: string) => `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: t }] }, finishReason: 'STOP' }] })}\ndata: [DONE]`;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function makeService(turns: string[]) {
    const service = new GeminiService();
    (service as any).auth = { getClient: async () => ({ getAccessToken: async () => ({ token: 'token' }) }) };
    (service as any).cachedProjectId = 'mock-project';
    let i = 0;
    (globalThis as any).fetch = async () => ({ ok: true, status: 200, text: async () => turns[i++] ?? TEXT('done'), body: null });
    const register = (name: string, handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<any>) =>
        (service as any).toolRegistry.register(name, { name, description: name, parameters: { type: 'OBJECT', properties: {} } }, handler, 'workspace');
    return { service, register };
}

const budgets = TOOL_TIME_BUDGETS as Record<string, unknown>;
afterEach(() => {
    delete budgets.test_staged_tool;
    delete process.env.SCRATCHBOX_TOOL_TIMEOUT_MS;
});

const SCENE = { id: 'scene-stg-a1b2c3d4', type: '3d-scene', title: 'Arch', version: 1, data: { title: 'Arch', objects: [] } } as unknown as CanvasArtifact;

describe('ctx.emitStage', () => {
    it('streams a status event with the running card and the stageEvent, and the artifact only when one is passed', async () => {
        const { service, register } = makeService([TOOL_CALL('test_staged_tool'), TEXT('Built.')]);
        register('test_staged_tool', async (_args, ctx) => {
            ctx.emitStage?.({ ...stageEvent(), seq: 1, stage: 'tiles', status: 'running', title: 'Google 3D Tiles' });
            ctx.emitStage?.({ ...stageEvent(), seq: 2, stage: 'tiles', status: 'committed', title: 'Google 3D Tiles' }, SCENE);
            return { resultPayload: { success: true }, status: 'completed', summaryResult: 'staged' };
        });
        const events: GeminiStreamEvent[] = [];
        const res = await service.streamGenerate({ prompt: 'arch', model: 'gemini-3.7-flash', mode: 'agent' }, e => events.push(e));
        expect(res.success).toBe(true);
        const staged = events.filter(e => e.stageEvent);
        expect(staged).toHaveLength(2);
        expect(staged.every(e => e.type === 'status')).toBe(true);
        expect(staged.map(e => [e.stageEvent!.seq, e.stageEvent!.status])).toEqual([[1, 'running'], [2, 'committed']]);
        // the running event moves no focus: it carries no artifact; the commit carries the scene
        expect(staged[0].artifact).toBeUndefined();
        expect(staged[1].artifact?.id).toBe('scene-stg-a1b2c3d4');
        expect(staged[1].text).toBe('test_staged_tool: Google 3D Tiles — committed');
        // the same card as every other progress event and as the result, updated in place
        const result = events.find(e => e.type === 'tool_result');
        expect(new Set(staged.map(e => e.mcpExecution?.id))).toEqual(new Set([result!.mcpExecution!.id]));
        expect(staged[1].mcpExecution).toMatchObject({ status: 'running', summaryResult: expect.stringMatching(/^Google 3D Tiles — committed \(\d+s\)$/) });
    });

    it('restarts the idle limit, so a tool that only emits stages keeps running past it', async () => {
        process.env.SCRATCHBOX_TOOL_TIMEOUT_MS = '300';
        budgets.test_staged_tool = { maxMs: 5000, idleMs: 350 };
        const { service, register } = makeService([TOOL_CALL('test_staged_tool'), TEXT('Built.')]);
        register('test_staged_tool', async (_args, ctx) => {
            for (let i = 1; i <= 6; i++) { await sleep(150); ctx.emitStage?.({ ...stageEvent(), seq: i, status: 'running' }); }
            return { resultPayload: { success: true }, status: 'completed' };
        });
        const events: GeminiStreamEvent[] = [];
        const started = Date.now();
        await service.streamGenerate({ prompt: 'arch', model: 'gemini-3.7-flash', mode: 'agent' }, e => events.push(e));
        expect(Date.now() - started).toBeGreaterThan(800);
        expect(events.find(e => e.type === 'tool_result')?.mcpExecution?.status).toBe('completed');
        expect(events.filter(e => e.stageEvent)).toHaveLength(6);
    });

    it('drops a stage event emitted after the tool call settled', async () => {
        const { service, register } = makeService([TOOL_CALL('test_staged_tool'), TEXT('Built.')]);
        let late: (() => void) | undefined;
        register('test_staged_tool', async (_args, ctx) => {
            late = () => ctx.emitStage?.({ ...stageEvent(), seq: 99, status: 'committed' }, SCENE);
            return { resultPayload: { success: true }, status: 'completed' };
        });
        const events: GeminiStreamEvent[] = [];
        await service.streamGenerate({ prompt: 'arch', model: 'gemini-3.7-flash', mode: 'agent' }, e => events.push(e));
        const before = events.length;
        late!();
        expect(events.length).toBe(before);
        expect(events.some(e => e.stageEvent?.seq === 99)).toBe(false);
    });

    it('compiles with the merged extras shape the computer-use plan adds beside it', () => {
        type Merged = Pick<ToolContext, 'signal' | 'reportProgress' | 'emitStage'> & {
            requestUserConfirmation?: (req: unknown, signal?: AbortSignal) => Promise<boolean>;
            remainingMs?: () => number;
        };
        const extras: Merged = { emitStage: () => undefined, reportProgress: () => undefined, remainingMs: () => 1000 };
        expect(typeof extras.emitStage).toBe('function');
    });
});
