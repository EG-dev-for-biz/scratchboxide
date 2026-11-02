/**
 * Saving the project artifact graph posts every revision of every artifact. A 3D scene revision used to embed
 * its generator's model as base64 (25 MB for the template outpost the mount added to agent scenes), so two such
 * revisions pushed POST /workspace/project-artifacts past the server's 50 MB body limit and it answered 413.
 * Saves now carry file references; the in-memory scene keeps the bytes.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { canvasHandlers } from '../src/node/gemini/tools/canvas-tools';
import { NativePythonRunnerService } from '../src/node/3d-engine/native-python-runner-service';
import { ProjectArtifactController } from '../src/browser/generative-canvas/project-artifact-controller';
import { loadServedGeneratorGlb, servedGeneratorGlbUrl } from '../src/common/strip-embedded-glb';
import { createEmptyProjectGraph } from '../src/common/project-artifact-graph-protocol';
import type { CanvasArtifact } from '../src/browser/generative-canvas/canvas-types';

/** As large as the generated model base64 that filled the real graph (two of these exceeded 50 MB). */
const LARGE_GLB_BASE64 = Buffer.alloc(18 * 1024 * 1024, 7).toString('base64');
const actor = { id: 'user-test', displayName: 'Test User', kind: 'user' as const };

/**
 * A controller loaded from the server, as the app loads it (a project the server never gave this window is not saved
 * there), and the bodies the store client posts after that, as the server would receive them. The load answers with a
 * new project's empty graph.
 */
async function loadedController(): Promise<{ controller: ProjectArtifactController; bodies: string[] }> {
    const bodies: string[] = [];
    (globalThis as any).fetch = async (_url: string, init?: { method?: string; body?: string }) => {
        if (init?.method === 'POST' && typeof init.body === 'string') bodies.push(init.body);
        return { ok: true, json: async () => (init?.method === 'POST' ? { success: true } : createEmptyProjectGraph('project-save-test')) };
    };
    const controller = new ProjectArtifactController('project-save-test', actor);
    await controller.initialize([], '/workspace');
    bodies.length = 0;
    return { controller, bodies };
}

const originalFetch = globalThis.fetch;
afterEach(() => {
    vi.restoreAllMocks();
    globalThis.fetch = originalFetch;
});

describe('saving a scene whose objects reference a large GLB by URL', () => {
    it('posts a small graph after mounting it', async () => {
        // The runner answers like the template run did: a 25 MB model written to the Python output directory.
        vi.spyOn(NativePythonRunnerService.prototype, 'runScript').mockImplementation(async () => ({
            success: true, exitCode: 0, stdout: '', stderr: '', executionTimeMs: 1,
            glbBase64: LARGE_GLB_BASE64, glbPath: '/repo/build/3d-python/scene_1792002545057_2tb5ut.glb'
        }) as any);
        const res: any = await canvasHandlers.mount_canvas_primitive({
            primitiveType: '3d-scene',
            title: 'Hall interior comparison',
            payload: {
                objects: [{ id: 'hall', content: { type: '3d-model', durableUri: '/models/hall_interior_export.glb', mimeType: 'model/gltf-binary' }, space: { spatial3d: { x: 0, y: 0, z: 0 } } }]
            }
        }, { request: { prompt: 'Compare the hall interior based on the earlier export', chatHistory: [] } } as any);

        const { controller, bodies } = await loadedController();
        controller.registerArtifact(res.resultPayload.artifact as CanvasArtifact, 'test-mount');
        await controller.persist('/workspace');

        expect(bodies).toHaveLength(1);
        expect(bodies[0].length).toBeLessThan(64 * 1024);
        expect(bodies[0]).toContain('/models/hall_interior_export.glb');
    });

    it('posts a small graph for a revision that already embeds a generated model next to its objects', async () => {
        // The shape of the revisions in the graph that drew 413s: the objects load files by URL, and the
        // generator holds the base64 of a different file in the Python output directory.
        const scene: CanvasArtifact = {
            id: 'art-1792002545243-kzx3i', type: '3d-scene', title: 'Flatiron AI retexture', summary: '', version: 1, createdAt: 'now',
            data: {
                title: 'Flatiron AI retexture',
                objects: [{ id: 'flatiron', content: { type: '3d-model', durableUri: '/models/flatiron_retextured_chat.glb', mimeType: 'model/gltf-binary' }, space: { spatial3d: { x: 0, y: 0, z: 0 } } }],
                pythonGenerator: {
                    enabled: true, filename: 'procedural_scene.py', sourceCode: 'import scratchbox as sb\n',
                    glbPath: '/Users/someone/scratchbox/build/3d-python/scene_1792002545057_2tb5ut.glb', glbBase64: LARGE_GLB_BASE64
                }
            } as any
        };
        const { controller, bodies } = await loadedController();
        controller.registerArtifact(scene, 'test-legacy');
        controller.registerArtifact({ ...scene, version: 2, title: 'Flatiron AI retexture v2', data: { ...(scene.data as any), title: 'v2' } }, 'test-legacy-2');
        await controller.persist('/workspace');

        expect(bodies[0].length).toBeLessThan(64 * 1024);
        const saved = JSON.parse(bodies[0]).graph;
        const generators = Object.values(saved.revisions)
            .filter((r: any) => saved.artifacts[r.artifactId]?.kind === '3d-scene')
            .map((r: any) => r.payload.pythonGenerator);
        expect(generators).toHaveLength(2);
        for (const gen of generators) {
            expect(gen.glbBase64).toBeUndefined();
            expect(gen.glbPath).toBe('/Users/someone/scratchbox/build/3d-python/scene_1792002545057_2tb5ut.glb');
            expect(gen.sourceCode).toBe('import scratchbox as sb\n');
        }
        expect((scene.data as any).pythonGenerator.glbBase64).toBe(LARGE_GLB_BASE64);
    });
});

describe('loading a saved generator model from its file', () => {
    const glb = Buffer.concat([Buffer.from('glTF'), Buffer.from([2, 0, 0, 0, 20, 0, 0, 0]), Buffer.alloc(8, 1)]);

    it('maps an output file of the Python runner to the URL the app serves it at', () => {
        expect(servedGeneratorGlbUrl('/Users/me/repo/build/3d-python/scene_1_ab.glb')).toBe('/build/3d-python/scene_1_ab.glb');
        expect(servedGeneratorGlbUrl('C:\\repo\\desktop-app\\build\\3d-python\\scene 2.glb')).toBe('/build/3d-python/scene%202.glb');
        expect(servedGeneratorGlbUrl('/repo/desktop-app/build/3d-native/scene_1.glb')).toBeUndefined();
        expect(servedGeneratorGlbUrl('/repo/build/3d-python/nested/scene_1.glb')).toBeUndefined();
        expect(servedGeneratorGlbUrl(undefined)).toBeUndefined();
    });

    it('returns the served file as base64, and nothing for a missing file, an HTML fallback or an unserved path', async () => {
        const requested: string[] = [];
        const serve = (status: number, body: Buffer) => (async (url: string) => {
            requested.push(url);
            return { ok: status === 200, arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.length) };
        }) as unknown as typeof fetch;

        expect(await loadServedGeneratorGlb('/repo/build/3d-python/scene_1.glb', serve(200, glb))).toBe(glb.toString('base64'));
        expect(requested).toEqual(['/build/3d-python/scene_1.glb']);
        expect(await loadServedGeneratorGlb('/repo/build/3d-python/scene_1.glb', serve(404, Buffer.from('Not Found')))).toBeUndefined();
        expect(await loadServedGeneratorGlb('/repo/build/3d-python/scene_1.glb', serve(200, Buffer.from('<!doctype html><html></html>')))).toBeUndefined();
        expect(await loadServedGeneratorGlb('/repo/build/3d-native/scene_1.glb', serve(200, glb))).toBeUndefined();
        expect(requested).toHaveLength(3);
    });
});
