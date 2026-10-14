/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The agent reports tool failures instead of improvising. In a recorded run one tile_refine failure led to eight
 * minutes of shell commands and file copies: the working method told the model to "change your approach", the failed
 * result carried no stop signal, and an active-scene directive told it to use clay when the user asked for photo
 * texture. Now a failed tool reaches the model wrapped with an instruction to report it (unless the model can fix the
 * cause: its own code, or a workspace edit), and the directives no longer assume intent.
 */

import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GeminiService } from '../src/node/gemini-service';
import { TOOL_FAILURE_INSTRUCTION, toolResultForModel } from '../src/node/gemini/streaming';
import { buildContents, WORKING_METHOD_SECTION } from '../src/node/gemini/prompt-builder';
import type { GeminiGenerateRequest } from '../src/common/gemini-protocol';
import type { ToolContext } from '../src/node/gemini/tools/types';

const TOOL_CALL = (name: string, args: Record<string, unknown> = {}) =>
    `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ functionCall: { name, args } }] }, finishReason: 'STOP' }] })}\ndata: [DONE]`;
const TEXT = (t: string) => `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: t }] }, finishReason: 'STOP' }] })}\ndata: [DONE]`;

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-failure-ws-'));
const realFetch = globalThis.fetch;
afterAll(() => {
    globalThis.fetch = realFetch;
    fs.rmSync(workspace, { recursive: true, force: true });
});

/** A service on the real tool registry whose model answers with `turns` in order; records each model request. */
function makeService(turns: string[]) {
    const service = new GeminiService();
    (service as any).auth = { getClient: async () => ({ getAccessToken: async () => ({ token: 'token' }) }) };
    (service as any).cachedProjectId = 'mock-project';
    const requests: any[] = [];
    (globalThis as any).fetch = async (_url: string, init: any) => {
        requests.push(JSON.parse(init.body));
        return { ok: true, status: 200, text: async () => turns[requests.length - 1] ?? TEXT('done'), body: null };
    };
    const register = (name: string, handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<any>) =>
        (service as any).toolRegistry.register(name, { name, description: name, parameters: { type: 'OBJECT', properties: {} } }, handler);
    return { service, requests, register };
}

/** The status of the first turn's tool call, and what the model was given for it. */
async function modelViewOfToolCall(service: GeminiService, requests: any[]): Promise<{ status?: string; content: any }> {
    const request: GeminiGenerateRequest = { prompt: 'go', model: 'gemini-3.7-flash', mode: 'agent', workspaceRoot: workspace };
    let status: string | undefined;
    await service.streamGenerate(request, e => { if (e.type === 'tool_result') status = e.mcpExecution?.status; });
    return { status, content: requests[1].contents.at(-1).parts[0].functionResponse.response.content };
}

describe('failed tool results reach the model with a stop instruction', () => {
    it('wraps a failed tile_refine with toolFailed and the instruction', async () => {
        const { service, requests } = makeService([TOOL_CALL('tile_refine', { tilePath: 'public/models/no_such_flatiron_tile.glb' }), TEXT('It failed.')]);
        const { status, content } = await modelViewOfToolCall(service, requests);
        expect(status).toBe('failed');
        expect(content.toolFailed).toBe(true);
        expect(content.instruction).toBe(TOOL_FAILURE_INSTRUCTION);
        expect(content.result.code).toBe('not_found');
        expect(content.result.message).toContain('no_such_flatiron_tile.glb');
    });

    it('wraps a tool that reports success: false', async () => {
        const { service, requests, register } = makeService([TOOL_CALL('probe_tile_test'), TEXT('ok')]);
        register('probe_tile_test', async () => ({ resultPayload: { success: false, error: 'no tiles at this anchor' }, status: 'completed' }));
        const { content } = await modelViewOfToolCall(service, requests);
        expect(content).toEqual({ toolFailed: true, result: { success: false, error: 'no tiles at this anchor' }, instruction: TOOL_FAILURE_INSTRUCTION });
    });

    it('does not wrap a failure in code the model wrote and passed to the tool', async () => {
        const script = 'import scratchbox as sb\nraise ValueError("bad profile")';
        const { service, requests, register } = makeService([TOOL_CALL('run_generator_test', { script, description: 'arch' }), TEXT('ok')]);
        register('run_generator_test', async () => { throw new Error('Traceback: ValueError: bad profile'); });
        const { status, content } = await modelViewOfToolCall(service, requests);
        expect(status).toBe('failed');
        expect(content.toolFailed).toBeUndefined();
        expect(content.error).toContain('bad profile');
    });

    it('does not wrap a failed workspace_* tool, which the model fixes while editing code', async () => {
        const { service, requests } = makeService([TOOL_CALL('workspace_read_file', { filePath: 'src/missing_module.ts' }), TEXT('ok')]);
        const { status, content } = await modelViewOfToolCall(service, requests);
        expect(status).toBe('failed');
        expect(JSON.stringify(content)).toMatch(/missing_module|ENOENT|not found|No such/i);
        expect(content.toolFailed).toBeUndefined();
    });

    it('leaves successes and timed-out payloads as they were', () => {
        const ok = { success: true, glbPath: '/x.glb' };
        expect(toolResultForModel('google_3d_tiles_get_clay', {}, { status: 'completed' }, ok)).toEqual(ok);
        const timedOut = { success: false, error: 'tile_refine did not finish ... do not call it again unless the user asks.', timedOut: true };
        expect(toolResultForModel('tile_refine', {}, { status: 'failed' }, timedOut)).toEqual(timedOut);
        // a one-line value under a code-like name (a language code) is not code the model wrote
        expect(toolResultForModel('geocode_test', { languageCode: 'en' }, { status: 'failed' }, { status: 'error' }).toolFailed).toBe(true);
        // code nested in a payload, as mount_canvas_primitive passes it
        expect(toolResultForModel('mount_canvas_primitive', { payload: { script: 'a = 1\nb = 2' } }, { status: 'failed' }, { status: 'failed' }).toolFailed).toBeUndefined();
    });
});

describe('working method', () => {
    it('tells the model to report other tool failures instead of changing approach', () => {
        expect(WORKING_METHOD_SECTION).not.toContain('change your approach');
        expect(WORKING_METHOD_SECTION).toContain('stop and tell the user which tool failed, quoting its error');
        expect(WORKING_METHOD_SECTION).toContain('Do not replace the tool with shell commands, scripts, file copies or moves, or a different pipeline unless the user asks');
        expect(WORKING_METHOD_SECTION).toContain('Do only what was asked');
    });
});

describe('scene directives do not assume intent', () => {
    const activeScene = { id: 'artifact-colosseum', type: '3d-scene', title: 'Colosseum', data: {} } as any;
    const userText = (prompt: string, activeArtifact?: any) => {
        const contents = buildContents({ prompt, activeArtifact } as GeminiGenerateRequest);
        return contents[contents.length - 1].parts![0].text as string;
    };

    it('with an active scene, offers full texture, does not mandate clay, and stages only when asked', () => {
        const text = userText('Flatiron Building in full photo texture, 120 m radius', activeScene);
        expect(text).toContain('ACTIVE 3D SCENE');
        expect(text).not.toContain('MANDATORY DIRECT TOOL CALL');
        expect(text).not.toMatch(/IN CLAY MODE|MUST remain 3d-scene|STAGE, GROUND, or ITERATE/);
        expect(text).toContain('google_3d_tiles_get_full_texture when the user asks for photo texture');
        expect(text).toContain('If they ask for a new object or place, start a new scene');
        expect(text).toContain('stageIntoActiveScene: true only when staging the active scene');
    });

    it('for a pure location request, offers full texture instead of a mandatory clay call', () => {
        const text = userText('3d tiles of 40.7411, -73.9897 in full photo texture');
        expect(text).toContain('PURE REAL-WORLD LOCATION QUERY');
        expect(text).not.toContain('MANDATORY DIRECT TOOL CALL');
        expect(text).toContain('google_3d_tiles_get_full_texture({ query:');
    });

    it("keeps the app's own staging pills on the active scene", () => {
        for (const pill of ['Stage at Monaco GP Circuit (Google 3D Tiles Clay)', 'Stage it at Venice Beach', 'Stage on a curved cyclorama cove']) {
            const text = userText(pill, activeScene);
            expect(text.startsWith(pill)).toBe(true);
            expect(text).toContain('If the user asks to stage or change the active scene, work on it');
            expect(text).toContain('google_3d_tiles_get_clay');
            expect(text).toContain('environmental plinth');
        }
    });
});
