/**
 * The temporary 3D/VFX product gate (common/product-scope.ts). With SCRATCHBOX_PRODUCT_SCOPE=3d-vfx the model is told
 * about 3D scenes and video timelines only, its tools refuse every other canvas type, a tag of another type in its reply
 * is not opened, and the chat says why. Unset, nothing changes.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    canCreatePrimitive,
    canShowLayoutMode,
    canShowPrimitive,
    primitiveOutOfScopeReason,
    productScope
} from '../src/common/product-scope';
import { canvasHandlers } from '../src/node/gemini/tools/canvas-tools';
import { buildSystemInstruction, scopedCanvasSpecification, CANVAS_PRIMITIVES_SPECIFICATION } from '../src/node/gemini/prompt-builder';
import { GeminiService } from '../src/node/gemini-service';
import type { GeminiStreamEvent } from '../src/common/gemini-protocol';
import type { CanvasArtifact } from '../src/browser/generative-canvas/canvas-types';
import { visibleStarterButtons } from '../src/browser/generative-canvas/studio/starterPrompts';
import { sanitizeLayoutMode } from '../src/browser/generative-canvas/guardrails-service';

const ENV = 'SCRATCHBOX_PRODUCT_SCOPE';
let saved: string | undefined;
beforeEach(() => { saved = process.env[ENV]; delete process.env[ENV]; });
afterEach(() => { if (saved === undefined) delete process.env[ENV]; else process.env[ENV] = saved; });
const scopeOn = () => { process.env[ENV] = '3d-vfx'; };

const ctx = (activeArtifact?: CanvasArtifact): any => ({ request: { activeArtifact, prompt: '', chatHistory: [] } });

describe('the scope switch', () => {
    it('is off unless the environment names 3d-vfx', () => {
        expect(productScope()).toBe('all');
        for (const type of ['markdown-document', 'kanban-board', 'live-code-sandbox', '3d-scene']) {
            expect(canCreatePrimitive(type)).toBe(true);
        }
        process.env[ENV] = 'something-else';
        expect(productScope()).toBe('all');
        process.env[ENV] = ' 3D-VFX ';
        expect(productScope()).toBe('3d-vfx');
    });

    it('creates 3D scenes and video timelines, shows their companions, and hides the rest', () => {
        scopeOn();
        expect(['3d-scene', 'video-timeline'].map(t => canCreatePrimitive(t))).toEqual([true, true]);
        expect(['node-graph', 'interactive-browser', 'browser'].map(t => [canCreatePrimitive(t), canShowPrimitive(t)])).toEqual([[false, true], [false, true], [false, true]]);
        for (const type of ['markdown-document', 'kanban-board', 'live-code-sandbox', 'metric-dashboard', 'mind-map', 'checklist', 'interactive-form', 'skills-hub', 'mcp-hub']) {
            expect(canShowPrimitive(type), type).toBe(false);
            expect(primitiveOutOfScopeReason(type), type).toContain(`no ${type} was created`);
        }
        expect(['chat', '3d', 'video', 'automation', 'browser'].every(m => canShowLayoutMode(m))).toBe(true);
        expect(['code', 'document', 'kanban', 'canvas'].some(m => canShowLayoutMode(m))).toBe(false);
    });
});

describe('the canvas tools', () => {
    const kanban = { columns: [{ id: 'c1', title: 'Todo', cards: [{ id: 'k1', title: 'Shot 1' }] }] };

    it('mount_canvas_primitive refuses an out-of-scope type with the reason, and mounts it when the gate is off', async () => {
        scopeOn();
        const refused: any = await canvasHandlers.mount_canvas_primitive({ primitiveType: 'kanban-board', title: 'Shots', payload: kanban }, ctx());
        expect(refused.status).toBe('failed');
        expect(refused.resultPayload.error).toContain('limited to 3D and VFX projects');
        expect(refused.resultPayload.artifact).toBeUndefined();

        delete process.env[ENV];
        const mounted: any = await canvasHandlers.mount_canvas_primitive({ primitiveType: 'kanban-board', title: 'Shots', payload: kanban }, ctx());
        expect(mounted.status).not.toBe('failed');
        expect(mounted.resultPayload.artifact.type).toBe('kanban-board');
    });

    it('mount_canvas_primitive still mounts a video timeline in scope', async () => {
        scopeOn();
        const payload = { tracks: [{ id: 't1', name: 'A-roll', type: 'video', elements: [{ id: 'e1', name: 'Plate', type: 'video', startTime: 0, duration: 4 }] }] };
        const out: any = await canvasHandlers.mount_canvas_primitive({ primitiveType: 'video-timeline', title: 'Cut', payload }, ctx());
        expect(out.status).not.toBe('failed');
        expect(out.resultPayload.artifact.type).toBe('video-timeline');
        expect(out.resultPayload.artifact.data.tracks[0].elements[0].name).toBe('Plate');
    });

    it('morph_canvas_primitive refuses an out-of-scope target and an unknown one', async () => {
        const scene: CanvasArtifact = { id: 'art-s', type: '3d-scene', title: 'Scene', summary: '', data: { title: 'Scene', objects: [] } as any, createdAt: '', version: 1 };
        const unknown: any = await canvasHandlers.morph_canvas_primitive({ targetType: 'spreadsheet' }, ctx(scene));
        expect(unknown.status).toBe('failed');
        expect(unknown.resultPayload.message).toContain('Unknown targetType "spreadsheet"');

        scopeOn();
        for (const targetType of ['markdown-document', 'node-graph', 'document']) {
            const out: any = await canvasHandlers.morph_canvas_primitive({ targetType }, ctx(scene));
            expect(out.status, targetType).toBe('failed');
            expect(out.resultPayload.message, targetType).toContain('limited to 3D and VFX projects');
        }
    });
});

describe('the system prompt', () => {
    it('describes only the 3D scene and video timeline in the creating modes, with pictures in the chat', async () => {
        scopeOn();
        const agent = await buildSystemInstruction({ prompt: 'make something', mode: 'agent' } as any, {});
        const studio = await buildSystemInstruction({ prompt: 'make something' } as any, {});
        for (const text of [agent, studio]) {
            expect(text).toContain('### PRODUCT SCOPE (THIS BUILD: 3D AND VFX ONLY):');
            expect(text).toContain('1. "3d-scene"');
            expect(text).toContain('2. "video-timeline"');
            for (const gone of ['"kanban-board":', '"live-code-sandbox" (or', '"markdown-document" (or', 'UNBOUNDED GENERATIVE MICRO-APPS',
                'You MUST switch to type: "markdown-document"', 'CODE-FIRST UNIVERSAL APPLICATION CREATION', 'Gravity Simulator']) {
                expect(text, gone).not.toContain(gone);
            }
            expect(text).toContain('show it in your chat reply as a markdown image ![title](url)');
            expect(text).toContain('### UNIFIED ARTIFACT TAG SPECIFICATION:');
            expect(text).toContain('### ARTIFACT JSON STRUCTURE:');
        }
        expect(agent).toContain('mount_canvas_primitive: Declaratively mount an interactive visual canvas primitive on the stage (3D scene or video timeline).');
    });

    it('leaves Plan and Ask, and every mode with the gate off, as they were', async () => {
        scopeOn();
        const plan = await buildSystemInstruction({ prompt: 'p', mode: 'plan' } as any, {});
        expect(plan).not.toContain('PRODUCT SCOPE');
        delete process.env[ENV];
        const agent = await buildSystemInstruction({ prompt: 'make something', mode: 'agent' } as any, {});
        expect(agent).not.toContain('PRODUCT SCOPE');
        expect(agent).toContain(CANVAS_PRIMITIVES_SPECIFICATION);
    });

    it('keeps every line of the 3D scene and video timeline entries except the two media rules', () => {
        const scoped = scopedCanvasSpecification();
        const full = CANVAS_PRIMITIVES_SPECIFICATION;
        const entry = (text: string, head: RegExp, next: RegExp) => {
            const lines = text.split('\n');
            const start = lines.findIndex(l => head.test(l));
            const end = lines.findIndex((l, i) => i > start && next.test(l));
            return lines.slice(start + 1, end);
        };
        const fullTimeline = entry(full, /^12\. "video-timeline"/, /^### /);
        const scopedTimeline = entry(scoped, /^2\. "video-timeline"/, /^### /);
        expect(scopedTimeline).toEqual(fullTimeline);
        const fullScene = entry(full, /^11\. "3d-scene"/, /^12\. /);
        const scopedScene = entry(scoped, /^1\. "3d-scene"/, /^2\. /);
        expect(fullScene.length - scopedScene.length).toBeGreaterThan(0);
        expect(scopedScene.filter(l => !fullScene.includes(l)).join('\n')).toContain('generate_image');
    });
});

describe('a streamed reply', () => {
    async function streamReply(text: string): Promise<GeminiStreamEvent[]> {
        const service = new GeminiService();
        (service as any).auth = { getClient: async () => ({ getAccessToken: async () => ({ token: 'mock-token' }) }) };
        (service as any).cachedProjectId = 'mock-project';
        const savedFetch = (globalThis as any).fetch;
        (globalThis as any).fetch = async () => {
            const body = `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }] })}\ndata: [DONE]`;
            return { ok: true, status: 200, text: async () => body, json: async () => ({}), body: null };
        };
        const events: GeminiStreamEvent[] = [];
        try {
            await service.streamGenerate({ prompt: 'plan the shoot', model: 'gemini-3.8-flash', mode: 'ask' } as any, e => events.push(e));
        } finally {
            (globalThis as any).fetch = savedFetch;
        }
        return events;
    }
    const kanbanTag = '<scratchboxPrimitive type="kanban-board" title="Shoot">\n```json\n{"columns":[{"id":"c1","title":"Todo","cards":[{"id":"k1","title":"Shot 1"}]}]}\n```\n</scratchboxPrimitive>';

    it('does not open a canvas the build cannot make, and says why', async () => {
        scopeOn();
        const events = await streamReply(`Here is the board.\n${kanbanTag}`);
        expect(events.some(e => e.type === 'artifact_complete')).toBe(false);
        expect((events.find(e => e.type === 'done') as any)?.artifact).toBeUndefined();
        const status = events.find(e => e.type === 'status' && /limited to 3D and VFX/.test((e as any).text || ''));
        expect((status as any)?.text).toContain('no kanban-board was created');
    });

    it('opens it as before with the gate off', async () => {
        const events = await streamReply(`Here is the board.\n${kanbanTag}`);
        expect((events.find(e => e.type === 'artifact_complete') as any)?.artifact?.type).toBe('kanban-board');
    });
});

describe('the studio', () => {
    it('offers only the starter buttons that make a 3D scene or a timeline', () => {
        expect(visibleStarterButtons().map(b => b.label)).toEqual(['Interactive App', '3D Scene', '3D Building', '3D World', 'Video NLE']);
        scopeOn();
        expect(visibleStarterButtons().map(b => b.label)).toEqual(['3D Scene', '3D Building', '3D World', 'Video NLE']);
    });

    it('restores a saved document or sandbox mode as chat, and leaves 3D, video and companions alone', () => {
        const kanban: CanvasArtifact = { id: 'art-k', type: 'kanban-board', title: 'Board', summary: '', data: { columns: [] } as any, createdAt: '', version: 1 };
        expect(sanitizeLayoutMode('document')).toBe('document');
        expect(sanitizeLayoutMode(undefined, kanban)).toBe('kanban');
        scopeOn();
        expect(['document', 'code', 'canvas', 'kanban'].map(m => sanitizeLayoutMode(m))).toEqual(['chat', 'chat', 'chat', 'chat']);
        expect(sanitizeLayoutMode(undefined, kanban)).toBe('chat');
        expect(['3d', 'video', 'automation', 'browser', 'chat'].map(m => sanitizeLayoutMode(m))).toEqual(['3d', 'video', 'automation', 'browser', 'chat']);
    });
});
