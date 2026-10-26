import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToolNodeClient } from '../src/browser/generative-canvas/tool-node-client';
import type { ToolNodeRunEvent } from '../src/common/tool-node-protocol';

// the server's newline-delimited stream, cut into chunks that split lines and a JSON value mid-way, as a network does
function ndjsonResponse(lines: unknown[], chunkSize: number): Response {
    const text = lines.map(l => JSON.stringify(l)).join('\n') + '\n';
    const bytes = new TextEncoder().encode(text);
    const body = new ReadableStream<Uint8Array>({
        start(controller) {
            for (let i = 0; i < bytes.length; i += chunkSize) controller.enqueue(bytes.slice(i, i + chunkSize));
            controller.close();
        }
    });
    return new Response(body, { status: 200, headers: { 'Content-Type': 'application/x-ndjson' } });
}

describe('streamed tool node runs', () => {
    afterEach(() => vi.unstubAllGlobals());
    const artifact = { id: 'scene-stg-02538de5', type: '3d-scene', title: 'Haughwout', version: 1, createdAt: '', data: { stagedBuild: { updatedAtMs: 5 } } };
    const lines = [
        { type: 'progress', message: 'Google 3D Tiles: streaming', fraction: 0.2 },
        { type: 'stage', stage: { stage: 'tiles', status: 'committed', title: 'Google 3D Tiles' }, artifact },
        { type: 'stage', stage: { stage: 'remesh', status: 'running', title: 'Remeshed scan' } },
        { type: 'done', result: { success: true, status: 'completed', resultPayload: { glbPath: 'public/models/h.glb' }, durationMs: 42 } }
    ];

    for (const chunk of [1, 7, 64, 100_000]) {
        it(`hands over every event in order and resolves with the result (chunks of ${chunk} bytes)`, async () => {
            vi.stubGlobal('fetch', vi.fn(async () => ndjsonResponse(lines, chunk)));
            const seen: ToolNodeRunEvent[] = [];
            const res = await new ToolNodeClient().runStream({ name: 'google_3d_tiles_get_clay', args: {}, workspaceRoot: '/w' }, e => seen.push(e));
            expect(seen.map(e => e.type)).toEqual(['progress', 'stage', 'stage']);
            expect((seen[1] as any).artifact.id).toBe('scene-stg-02538de5');
            expect(res).toMatchObject({ status: 'completed', durationMs: 42, resultPayload: { glbPath: 'public/models/h.glb' } });
        });
    }

    it('fails when the stream ends without a result', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => ndjsonResponse(lines.slice(0, 2), 9)));
        await expect(new ToolNodeClient().runStream({ name: 'x', args: {}, workspaceRoot: '/w' }, () => undefined)).rejects.toThrow(/without a result/);
    });
});
