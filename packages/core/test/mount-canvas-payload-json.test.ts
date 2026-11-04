/**
 * mount_canvas_primitive takes its data as payloadJson, a JSON string, because Gemini's function calling loses the
 * nested objects of an untyped OBJECT parameter: asked to mount a model and a splat, gemini-4-argon sent payload {}
 * (2026-11-03), and in a live chat each object's content and space arrived as numbers. These tests send the
 * declaration's own argument shapes through the app's argument coercion and the handler, with a model and a splat.
 */

import { describe, it, expect } from 'vitest';
import { CANVAS_TOOL_DECLARATIONS, canvasHandlers } from '../src/node/gemini/tools/canvas-tools';
import { coerceToolArguments } from '../src/node/gemini/domain-tool-packs';

const mount = CANVAS_TOOL_DECLARATIONS.find(d => d.name === 'mount_canvas_primitive')!;
const ctx = { request: { prompt: 'show the fur ball', chatHistory: [] } } as any;

const scene = {
    title: 'Fur ball',
    renderMode: 'pbr',
    objects: [
        { id: 'body', content: { type: '3d-model', durableUri: '/models/fur_ball_body.glb', mimeType: 'model/gltf-binary' }, space: { spatial3d: { x: 0, y: 0, z: 0 } } },
        { id: 'fur', content: { type: '3d-model', durableUri: '/models/fur_ball_dense.spz' }, space: { spatial3d: { x: 0, y: 0.15, z: 0 } } }
    ]
};

async function run(args: Record<string, unknown>) {
    return await canvasHandlers.mount_canvas_primitive(coerceToolArguments(mount, args), ctx) as any;
}

describe('mount_canvas_primitive payloadJson', () => {
    it('declares payloadJson as a string, steers the model to it, and no longer requires payload', () => {
        const params = mount.parameters as any;
        expect(params.properties.payloadJson.type).toBe('STRING');
        expect(params.properties.payload.description).toMatch(/^Prefer payloadJson/);
        expect(params.required).toEqual(['primitiveType', 'title']);
    });

    it('mounts a model and a splat sent as payloadJson, each with its nested content and space', async () => {
        const res = await run({ primitiveType: '3d-scene', title: 'Fur ball', payloadJson: JSON.stringify(scene) });
        expect(res.status, JSON.stringify(res.resultPayload)).not.toBe('failed');
        const objects = res.resultPayload.artifact.data.objects;
        expect(objects.map((o: any) => [o.id, o.content.durableUri])).toEqual([['body', '/models/fur_ball_body.glb'], ['fur', '/models/fur_ball_dense.spz']]);
        expect(objects[1].space.spatial3d).toEqual({ x: 0, y: 0.15, z: 0 });
        expect(res.resultPayload.artifact.data.renderMode).toBe('pbr');
    });

    it('prefers payloadJson over payload, and still mounts a payload object sent alone', async () => {
        const both = await run({ primitiveType: '3d-scene', title: 'Fur ball', payload: { objects: [{ id: 'fur', content: 1 }] }, payloadJson: JSON.stringify(scene) });
        expect(both.resultPayload.artifact.data.objects).toHaveLength(2);
        const alone = await run({ primitiveType: '3d-scene', title: 'Fur ball', payload: scene });
        expect(alone.resultPayload.artifact.data.objects.map((o: any) => o.content.durableUri)).toEqual(['/models/fur_ball_body.glb', '/models/fur_ball_dense.spz']);
    });

    it('fails with the reason, mounting nothing, on what the model sent when nested objects were lost', async () => {
        // the shape argon sent in the live chat: content and space flattened to numbers
        const lost = await run({ primitiveType: '3d-scene', title: 'Fur ball', payload: { objects: [{ id: 'fur', content: 1, space: 1 }] } });
        expect(lost.status).toBe('failed');
        expect(lost.resultPayload.error).toMatch(/cannot be drawn: fur/);
        const broken = await run({ primitiveType: '3d-scene', title: 'Fur ball', payloadJson: '{"objects": [' });
        expect(broken.status).toBe('failed');
        expect(broken.resultPayload.error).toMatch(/payloadJson is not valid JSON/);
        const none = await run({ primitiveType: '3d-scene', title: 'Fur ball' });
        expect(none.status).toBe('failed');
        expect(none.resultPayload.error).toMatch(/payload must be a JSON object .*payloadJson.*got nothing/);
    });
});
