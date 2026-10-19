/**
 * One scene request opened two viewport tabs with the same title: each execute_3d_python_script call in the turn
 * minted its own clock id ("artifact-3d-<ms>"), so a retry was a second artifact, and the end-of-turn commit re-keyed
 * the last one (resolveCanvasArtifactId) without dropping the tab it streamed into.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { GeminiService } from '../src/node/gemini-service';
import { StreamingEngine } from '../src/node/gemini/streaming';
import type { GeminiStreamEvent } from '../src/common/gemini-protocol';
import type { CanvasArtifact } from '../src/browser/generative-canvas/canvas-types';
import { committedSessionCanvas, withCommittedArtifact } from '../src/browser/generative-canvas/hooks/toolStepState';
import { ProjectArtifactGraphEngine, createEmptyProjectGraph } from '../src/common/project-artifact-graph-protocol';
import { registerCanvasArtifact } from '../src/browser/generative-canvas/project-artifact-adapter';

const realFetch = globalThis.fetch;
afterEach(() => { (globalThis as any).fetch = realFetch; vi.restoreAllMocks(); });

function makeService(): GeminiService {
    const service = new GeminiService();
    (service as any).auth = { getClient: async () => ({ getAccessToken: async () => ({ token: 'mock-token' }) }) };
    (service as any).cachedProjectId = 'mock-project';
    return service;
}

const call = (name: string, args: Record<string, unknown>) =>
    `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ functionCall: { name, args } }] }, finishReason: 'STOP' }] })}\ndata: [DONE]`;

const scene = (id: string, title: string, extra: Partial<CanvasArtifact> = {}): CanvasArtifact => ({
    id, type: '3d-scene', title, summary: '', data: { title, objects: [{ id: `${id}-obj` }] } as any, ...extra
});

describe('one scene request, one viewport tab', () => {
    it('a second build in the same turn is the next version of the turn\'s scene, not a new artifact', async () => {
        const turns = [
            call('execute_3d_python_script', { description: 'first' }),
            call('execute_3d_python_script', { description: 'second' }),
            'data: {"candidates":[{"content":{"parts":[{"text":"Built the lander."}]},"finishReason":"STOP"}]}\ndata: [DONE]'
        ];
        let i = 0;
        (globalThis as any).fetch = async () => ({ ok: true, body: null, text: async () => turns[i++] });
        // Each call mints a clock id and its own title, as execute_3d_python_script does.
        const built = [
            scene('artifact-3d-1792368727365', 'Procedural 3D sci-fi exploration environment: crashed lander'),
            scene('artifact-3d-1792368841807', 'Procedural 3D sci-fi exploration environment, rebuilt with struts')
        ];
        const payloadsSeenByModel: unknown[] = [];
        let n = 0;
        vi.spyOn(StreamingEngine.prototype, 'executeToolCall').mockImplementation(async (toolCall) => {
            const resultPayload = { success: true, artifact: built[n++] };
            payloadsSeenByModel.push(resultPayload);
            return { exec: { id: `e${n}`, mcpServerId: 's', mcpName: 'S', toolName: toolCall.name || '', status: 'completed', timestamp: '' } as any, resultPayload };
        });

        const events: GeminiStreamEvent[] = [];
        const response = await makeService().streamGenerate({ prompt: 'Build a procedural 3D sci-fi exploration environment', model: 'gemini-3.7-flash', mode: 'agent' }, e => events.push(e));

        const mounted = events.filter(e => e.type === 'artifact_start').map(e => e.artifact!);
        expect(mounted.map(a => a.id)).toEqual(['artifact-3d-1792368727365', 'artifact-3d-1792368727365']);
        expect(mounted.map(a => a.version || 1)).toEqual([1, 2]);
        expect(mounted[1].title).toBe('Procedural 3D sci-fi exploration environment, rebuilt with struts');
        expect(response.artifact?.id).toBe('artifact-3d-1792368727365');
        // The model is told the id the canvas shows.
        expect((payloadsSeenByModel[1] as any).artifact.id).toBe('artifact-3d-1792368727365');
        // Every artifact the stream sent names one id: the Studio keeps one tab (useSendMessage dedupes by id).
        const ids = new Set(events.filter(e => e.artifact).map(e => e.artifact!.id));
        expect([...ids]).toEqual(['artifact-3d-1792368727365']);
    });

    it('a staged run keeps its own id, and a deliberate id is not taken over', async () => {
        const turns = [
            call('execute_3d_python_script', {}),
            call('stage_location', {}),
            'data: {"candidates":[{"content":{"parts":[{"text":"Staged."}]},"finishReason":"STOP"}]}\ndata: [DONE]'
        ];
        let i = 0;
        (globalThis as any).fetch = async () => ({ ok: true, body: null, text: async () => turns[i++] });
        const built = [scene('artifact-3d-1792368727365', 'Arch'), scene('scene-stg-0a1b2c3d', 'Washington Square Arch')];
        let n = 0;
        vi.spyOn(StreamingEngine.prototype, 'executeToolCall').mockImplementation(async (toolCall) => (
            { exec: { id: `e${n}`, mcpServerId: 's', mcpName: 'S', toolName: toolCall.name || '', status: 'completed', timestamp: '' } as any, resultPayload: { success: true, artifact: built[n++] } }
        ));
        const events: GeminiStreamEvent[] = [];
        const response = await makeService().streamGenerate({ prompt: 'arch', model: 'gemini-3.7-flash', mode: 'agent' }, e => events.push(e));
        expect(events.filter(e => e.type === 'artifact_start').map(e => e.artifact!.id)).toEqual(['artifact-3d-1792368727365', 'scene-stg-0a1b2c3d']);
        expect(response.artifact?.id).toBe('scene-stg-0a1b2c3d');
    });

    it('the end-of-turn commit replaces the tab the artifact streamed into', () => {
        const engine = new ProjectArtifactGraphEngine(createEmptyProjectGraph('p1', { grants: (['artifact.read', 'artifact.write', 'artifact.link', 'artifact.select'] as const).map(capability => ({ capability, effect: 'allow' as const })) }));
        const streamed = scene('artifact-3d-1792368727365', 'Procedural 3D sci-fi exploration environment');
        const committed = registerCanvasArtifact(engine, streamed, { kind: 'user', id: 'u' }, 'c1');
        expect(committed.id).not.toBe(streamed.id); // the commit gives a clock id its project id

        const visibleHistory = [streamed];
        const canvas = committedSessionCanvas({
            targetVisible: true,
            visible: { artifactHistory: visibleHistory, layoutMode: '3d' },
            finalArtifact: committed,
            finalArtifactMode: '3d',
            streamedArtifactId: streamed.id
        });
        expect(canvas.artifactHistory.map(a => a.id)).toEqual([committed.id]);
        expect(withCommittedArtifact(visibleHistory, committed, streamed.id).map(a => a.id)).toEqual([committed.id]);
        // Another artifact the user had open stays.
        const other = scene('scene-stg-0a1b2c3d', 'Washington Square Arch');
        expect(withCommittedArtifact([streamed, other], committed, streamed.id).map(a => a.id)).toEqual([committed.id, other.id]);
    });
});
