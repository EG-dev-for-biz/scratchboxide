/**
 * Keyword templates must never add geometry or titles to agent scenes.
 *
 * The prompt synthesizer (synthesizeContextual3DScene) turns words such as "buildings" or "hall" into a template
 * scene: a Python/C++ generator for a domed tower with trees, JS customMeshes and a title such as
 * "3D Architectural Research Outpost". Agent scenes used to inherit all of it wherever the model's data was
 * empty, so a scene with exactly two objects at x=±60 showed an extra building between them, and a failed tool
 * call followed by an unparseable reply opened a separate "outpost" tab.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { canvasHandlers } from '../src/node/gemini/tools/canvas-tools';
import { parseOrSynthesizeArtifact } from '../src/node/gemini/artifact-synthesis';
import { GeminiService } from '../src/node/gemini-service';
import { NativePythonRunnerService } from '../src/node/3d-engine/native-python-runner-service';
import { glbToTriangleSoup, type TriangleSoup } from '../src/node/3d-engine/part-connectivity';
import { renderReviewViews } from '../src/node/3d-engine/visual-review';
import type { GeminiStreamEvent } from '../src/common/gemini-protocol';
import { PRIMITIVE_TYPES, normalizePrimitiveType, type CanvasArtifact, type Scene3DData } from '../src/browser/generative-canvas/canvas-types';
import * as THREE from 'three';
import { hasNonFallbackObjectContent, syncSceneContent } from '../src/browser/generative-canvas/primitives/scene3d/syncSceneContent';

const SHOTS = path.resolve(__dirname, '../../../test-results/screenshots');

/** A closed axis-aligned box, base on y=0, as a non-indexed GLB. */
function boxGlb(w: number, h: number, d: number): Buffer {
    const x = w / 2, z = d / 2;
    const c = [[-x, 0, -z], [x, 0, -z], [x, h, -z], [-x, h, -z], [-x, 0, z], [x, 0, z], [x, h, z], [-x, h, z]];
    const faces = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [3, 6, 2], [3, 7, 6], [0, 4, 7], [0, 7, 3], [1, 2, 6], [1, 6, 5]];
    const pos = Buffer.alloc(faces.length * 3 * 12);
    let o = 0;
    for (const f of faces) for (const i of f) for (const v of c[i]) { pos.writeFloatLE(v, o); o += 4; }
    const gltf = {
        asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
        meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
        buffers: [{ byteLength: pos.length }], bufferViews: [{ buffer: 0, byteLength: pos.length }],
        accessors: [{ bufferView: 0, componentType: 5126, count: faces.length * 3, type: 'VEC3', min: [-x, 0, -z], max: [x, h, z] }]
    };
    let json = Buffer.from(JSON.stringify(gltf));
    json = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)]);
    const header = Buffer.alloc(12); header.write('glTF', 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(12 + 8 + json.length + 8 + pos.length, 8);
    const jh = Buffer.alloc(8); jh.writeUInt32LE(json.length, 0); jh.write('JSON', 4);
    const bh = Buffer.alloc(8); bh.writeUInt32LE(pos.length, 0); bh.write('BIN\0', 4);
    return Buffer.concat([header, jh, json, bh, pos]);
}

/** The model files the two scene objects load, by URL. */
const MODEL_FILES: Record<string, Buffer> = {
    '/models/base_building.glb': boxGlb(20, 30, 20),
    '/models/revised_building.glb': boxGlb(20, 36, 20)
};
const TWO_OBJECTS = [
    { id: 'base', content: { type: '3d-model', durableUri: '/models/base_building.glb', mimeType: 'model/gltf-binary' }, space: { spatial3d: { x: -60, y: 0, z: 0 } } },
    { id: 'revised', content: { type: '3d-model', durableUri: '/models/revised_building.glb', mimeType: 'model/gltf-binary' }, space: { spatial3d: { x: 60, y: 0, z: 0 } } }
];

/**
 * Everything the viewport draws as geometry for this scene: each object's file at its position, and any
 * generator's model at the origin (where the template's tower and trees appeared).
 */
function sceneSoup(data: Scene3DData): TriangleSoup {
    const parts: Array<{ soup: TriangleSoup; dx: number }> = [];
    for (const o of data.objects || []) {
        const file = MODEL_FILES[o.content?.durableUri || ''];
        const soup = file ? glbToTriangleSoup(file) : null;
        if (soup) parts.push({ soup, dx: o.space?.spatial3d?.x || 0 });
    }
    for (const gen of [data.pythonGenerator, data.cppGenerator]) {
        const soup = gen?.glbBase64 ? glbToTriangleSoup(Buffer.from(gen.glbBase64, 'base64')) : null;
        if (soup) parts.push({ soup, dx: 0 });
    }
    const positions: number[] = [];
    const indices: number[] = [];
    for (const { soup, dx } of parts) {
        const base = positions.length / 3;
        for (let i = 0; i < soup.positions.length; i += 3) positions.push(soup.positions[i] + dx, soup.positions[i + 1], soup.positions[i + 2]);
        for (const idx of soup.indices) indices.push(base + idx);
    }
    return { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
}

// The Python runner is replaced by one that returns a real model at the origin, standing in for what the
// template script built there; tests then show whether anything ran it and whether its model reached the scene.
let runScript: ReturnType<typeof vi.spyOn>;
let runScriptSync: ReturnType<typeof vi.spyOn>;
const originalFetch = globalThis.fetch;
beforeEach(() => {
    const generated = { success: true, exitCode: 0, stdout: '', stderr: '', executionTimeMs: 1, glbBase64: boxGlb(8, 40, 8).toString('base64'), glbPath: '/repo/build/3d-python/scene_template.glb' };
    runScript = vi.spyOn(NativePythonRunnerService.prototype, 'runScript').mockImplementation(async () => generated as any);
    runScriptSync = vi.spyOn(NativePythonRunnerService.prototype, 'runScriptSync').mockImplementation(() => generated as any);
});
afterEach(() => {
    vi.restoreAllMocks();
    globalThis.fetch = originalFetch;
});

describe('mount_canvas_primitive: the scene holds only what the model sent', () => {
    for (const prompt of ['Show the two buildings side by side', 'Compare the hall interior based on the earlier export']) {
        it(`"${prompt}" mounts exactly the two objects, titled from the call`, async () => {
            const res: any = await canvasHandlers.mount_canvas_primitive(
                { primitiveType: '3d-scene', title: 'Two Object Comparison', summary: 'Base and revised model', payload: { objects: TWO_OBJECTS } },
                { request: { prompt, chatHistory: [] } } as any
            );
            const artifact = res.resultPayload.artifact as CanvasArtifact;
            const data = artifact.data as Scene3DData;

            expect(artifact.type).toBe('3d-scene');
            expect(data.objects?.map(o => o.id)).toEqual(['base', 'revised']);
            expect(data.pythonGenerator).toBeUndefined();
            expect(data.cppGenerator).toBeUndefined();
            expect(data.customMeshes ?? []).toHaveLength(0);
            expect(data.customScript).toBeUndefined();
            expect(data.code).toBeUndefined();
            expect(data.geoAnchor).toBeUndefined();
            expect((data.operatorStack || []).map(op => op.operator)).not.toContain('sb_set_cpp_generator');
            expect(runScript).not.toHaveBeenCalled();
            expect(artifact.title).toBe('Two Object Comparison');
            expect(data.title).toBe('Two Object Comparison');
            expect(data.subtitle).toBe('Base and revised model');

            // Nothing is drawn between the two objects (they span |x| 50..70).
            const soup = sceneSoup(data);
            let innermost = Infinity;
            for (let i = 0; i < soup.positions.length; i += 3) innermost = Math.min(innermost, Math.abs(soup.positions[i]));
            expect(innermost).toBeCloseTo(50, 3);

            fs.mkdirSync(SHOTS, { recursive: true });
            const shot = path.join(SHOTS, `agent_scene_model_authored_only_${prompt.split(' ')[0].toLowerCase()}.png`);
            fs.writeFileSync(shot, renderReviewViews(soup, 512)[0].png);
            expect(fs.statSync(shot).size).toBeGreaterThan(1000);
        });
    }

    it('takes the title from the payload, ignoring the placeholder, and never from prompt keywords', async () => {
        const mount = (payloadTitle: string | undefined, argsTitle: string | undefined) => canvasHandlers.mount_canvas_primitive(
            { primitiveType: '3d-scene', title: argsTitle, payload: { title: payloadTitle, objects: TWO_OBJECTS } },
            { request: { prompt: 'Load both building GLBs based on the last export', chatHistory: [] } } as any
        ) as Promise<any>;
        expect((await mount('Massing Study', 'Two Object Comparison')).resultPayload.artifact.title).toBe('Massing Study');
        expect((await mount('4D Scene Workspace', 'Two Object Comparison')).resultPayload.artifact.title).toBe('Two Object Comparison');
        const untitled = (await mount(undefined, undefined)).resultPayload.artifact;
        expect(untitled.title).toBe('3D Scene');
        expect(untitled.data.title).toBe('3D Scene');
    });

    it('runs the Python script the model sent, and only that one', async () => {
        const script = 'import scratchbox as sb\nscene = sb.geometry.Mesh("Pair")\nsb.io.write_glb(OUTPUT_GLB_PATH, scene)\n';
        const res: any = await canvasHandlers.mount_canvas_primitive(
            { primitiveType: '3d-scene', title: 'Pair', payload: { script } },
            { request: { prompt: 'Show the two buildings side by side', chatHistory: [] } } as any
        );
        const data = res.resultPayload.artifact.data as Scene3DData;
        expect(runScript).toHaveBeenCalledTimes(1);
        expect(runScript.mock.calls[0][0]).toBe(script);
        expect(data.pythonGenerator?.sourceCode).toBe(script);
        expect(data.objects).toEqual([]);
    });

    it('leaves a markdown mount a markdown document even when the prompt mentions a 3D scene', async () => {
        const sections = [{ id: 's1', type: 'paragraph', content: 'Notes on the scene.' }];
        const res: any = await canvasHandlers.mount_canvas_primitive(
            { primitiveType: 'markdown-document', title: 'Scene notes', payload: { title: 'Scene notes', sections } },
            { request: { prompt: 'Write notes about the 3d scene mesh', chatHistory: [] } } as any
        );
        const artifact = res.resultPayload.artifact as CanvasArtifact;
        expect(artifact.type).toBe('markdown-document');
        expect((artifact.data as any).sections).toEqual(sections);
        expect(runScript).not.toHaveBeenCalled();
    });
});

describe('parseOrSynthesizeArtifact with modelAuthoredOnly', () => {
    const ACTIVE_SCENE: CanvasArtifact = {
        id: 'art-pair', type: '3d-scene', title: 'Two Object Comparison', summary: 'pair', version: 3, createdAt: 'now',
        data: { title: 'Two Object Comparison', objects: TWO_OBJECTS, environment: { skybox: 'studio', lighting: 'studio', ground: true } } as any
    };

    it('builds nothing from a prose reply, even with a scene open', () => {
        const request = { prompt: 'Show the two buildings side by side', mode: 'agent', activeArtifact: ACTIVE_SCENE } as any;
        const art = parseOrSynthesizeArtifact(request.prompt, 'Both buildings are now side by side.', request, [], undefined, { modelAuthoredOnly: true });
        expect(art).toBeUndefined();
    });

    it('builds a scene from a {type, data} envelope with only the model\'s objects and title', () => {
        const prompt = 'Compare the hall interior based on the earlier export';
        const reply = '```json\n' + JSON.stringify({ type: '3d-scene', title: 'Hall Comparison', data: { objects: TWO_OBJECTS } }) + '\n```';
        const art = parseOrSynthesizeArtifact(prompt, reply, { prompt, mode: 'agent' } as any, [], undefined, { modelAuthoredOnly: true })!;
        const data = art.data as Scene3DData;
        expect(art.type).toBe('3d-scene');
        expect(art.title).toBe('Hall Comparison');
        expect(data.objects?.map(o => o.id)).toEqual(['base', 'revised']);
        expect(data.pythonGenerator).toBeUndefined();
        expect(data.cppGenerator).toBeUndefined();
        expect(data.customMeshes ?? []).toHaveLength(0);
        expect(data.customScript).toBeUndefined();
        expect(data.geoAnchor).toBeUndefined();
        expect(runScriptSync).not.toHaveBeenCalled();
    });

    it('ignores a JSON block that is not an artifact envelope', () => {
        const prompt = 'Show the two buildings side by side';
        const reply = 'The objects I placed:\n```json\n' + JSON.stringify({ objects: TWO_OBJECTS }) + '\n```';
        expect(parseOrSynthesizeArtifact(prompt, reply, { prompt, mode: 'agent' } as any, [], undefined, { modelAuthoredOnly: true })).toBeUndefined();
    });

    it('without modelAuthoredOnly, a failed 3D tool no longer turns a prose reply into a 3D scene', () => {
        const prompt = 'Why did that not work?';
        const failed = [{ id: 'e1', toolName: 'execute_3d_python_script', status: 'failed' } as any];
        const art = parseOrSynthesizeArtifact(prompt, 'The tool failed, sorry.', { prompt, mode: 'chat' } as any, failed);
        expect(art?.type).not.toBe('3d-scene');
    });
});

describe('agent-mode streaming', () => {
    function mockService(turns: string[]): GeminiService {
        const service = new GeminiService();
        (service as any).auth = { getClient: async () => ({ getAccessToken: async () => ({ token: 'mock-token' }) }) };
        (service as any).cachedProjectId = 'mock-project';
        let n = 0;
        (globalThis as any).fetch = async () => ({ ok: true, text: async () => turns[n++], body: null });
        return service;
    }
    const textTurn = (text: string) => `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }] })}\ndata: [DONE]`;

    it('puts nothing on the canvas when a tool fails and the reply\'s primitive tag does not parse', async () => {
        const service = mockService([
            'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"execute_3d_python_script","args":{"script":"import scratchbox as sb\\nboom()"}}}]},"finishReason":"STOP"}]}\ndata: [DONE]',
            textTurn([
                'The Python tool failed. Here is the scene description instead:',
                '<scratchboxPrimitive type="3d-scene" title="Research Station Pair" summary="two objects">',
                '```json',
                '{ "objects": [ /* left */ { "id": "left" }, ], }',
                '```',
                '</scratchboxPrimitive>'
            ].join('\n'))
        ]);
        (service as any).toolRegistry.register('execute_3d_python_script', {
            name: 'execute_3d_python_script', description: 'fails', parameters: { type: 'OBJECT', properties: {} }
        }, async () => { throw new Error('Traceback (most recent call last): NameError: boom'); }, 'workspace');

        const events: GeminiStreamEvent[] = [];
        const response = await service.streamGenerate({
            prompt: 'Load both building GLBs based on the last export: exactly two objects at x=-60 and x=+60, nothing else.',
            model: 'gemini-3.7-flash', mode: 'agent', enableWorkspaceTools: true
        } as any, e => events.push(e));

        expect(response.success).toBe(true);
        expect(events.find(e => e.type === 'tool_result')?.mcpExecution?.status).toBe('failed');
        expect(response.artifact).toBeUndefined();
        expect(events.filter(e => e.type === 'artifact_complete' || (e as any).artifact)).toEqual([]);
    });

    it('leaves the open scene untouched when the reply is prose', async () => {
        const active: CanvasArtifact = {
            id: 'art-pair', type: '3d-scene', title: 'Two Object Comparison', summary: 'pair', version: 2, createdAt: 'now',
            data: { title: 'Two Object Comparison', objects: TWO_OBJECTS } as any
        };
        const before = JSON.stringify(active);
        const service = mockService([textTurn('Both buildings are side by side: the base model on the left, the revision on the right.')]);

        const events: GeminiStreamEvent[] = [];
        const response = await service.streamGenerate({
            prompt: 'Show the two buildings side by side', model: 'gemini-3.7-flash', mode: 'agent', activeArtifact: active
        } as any, e => events.push(e));

        expect(response.success).toBe(true);
        expect(response.text).toContain('side by side');
        expect(response.artifact).toBeUndefined();
        expect(events.some(e => e.type === 'artifact_complete')).toBe(false);
        expect(JSON.stringify(active)).toBe(before);
        expect(runScriptSync).not.toHaveBeenCalled();
    });
});

/**
 * Composes a scene's content the way the viewport does (syncSceneContent) and reports what it drew on its own:
 * splats it made up for the splat viewer and meshes it added to the scene. Files the scene loads (objects,
 * splatUrl) are drawn by other slices and are not counted here.
 */
function composedFallbackContent(data: Scene3DData): { madeUpSplats: number; meshes: string[] } {
    const scene = new THREE.Scene();
    let madeUpSplats = 0;
    const handle = syncSceneContent({ scene } as any, {
        sceneType: data.sceneType,
        title: data.title,
        worldBranch: data.worldBranch || '',
        isAirplane: false,
        hasContrails: false,
        hasActiveScript: false,
        has3DTiles: false,
        hasCustomMeshes: (data.customMeshes?.length ?? 0) > 0,
        hasNonFallbackObjects: hasNonFallbackObjectContent(data),
        hasCppGenerator: false,
        hasPythonGenerator: false,
        selectedShape: 'sphere',
        sculptWireframe: false
    }, null, {
        createDynamicContrails: () => null,
        createSplatViewer: () => ({ group: new THREE.Group(), loadSplatObservation: g => { madeUpSplats += g.length; }, dispose: () => {} })
    });
    const meshes: string[] = [];
    scene.traverse(o => { if ((o as THREE.Mesh).isMesh) meshes.push(o.name || o.type); });
    handle.dispose();
    return { madeUpSplats, meshes };
}

describe('a splat scene holds only the splat the model sent', () => {
    const PROMPT = 'Create a 3D gaussian splat of the Colosseum';
    // The payload shape prompt-builder prescribes for a location splat, with the model's own capture.
    const SPLAT_PAYLOAD = {
        sceneType: 'gaussian_splat',
        splatUrl: '/models/colosseum_station_capture.splat',
        splatTilesetUrl: '/tilesets/colosseum_station_capture/tileset.json',
        splatOptions: { splatScale: 1.0, contactShadow: true, enableSoftZ: true }
    };
    const mountSplat = async (payload: Record<string, unknown>) => {
        const res: any = await canvasHandlers.mount_canvas_primitive(
            { primitiveType: '3d-scene', title: 'Colosseum — 3D Gaussian Splat', payload },
            { request: { prompt: PROMPT, chatHistory: [] } } as any
        );
        return res.resultPayload.artifact.data as Scene3DData;
    };

    it('mounts the model\'s splat with no worldBranch from the synthesizer, and the viewport draws no colonnade', async () => {
        const data = await mountSplat(SPLAT_PAYLOAD);
        expect(data.splatUrl).toBe(SPLAT_PAYLOAD.splatUrl);
        expect(data.splatTilesetUrl).toBe(SPLAT_PAYLOAD.splatTilesetUrl);
        expect(data.splatOptions).toEqual(SPLAT_PAYLOAD.splatOptions);
        expect(data.sceneType).toBe('gaussian_splat');
        expect(data.worldBranch).toBeUndefined();
        expect(data.objects).toEqual([]);
        expect(data.geoAnchor).toBeUndefined();

        const composed = composedFallbackContent(data);
        expect(composed.madeUpSplats).toBe(0);
        expect(composed.meshes).toEqual([]);
    });

    it('adds no landmark splat file the model did not send', async () => {
        const data = await mountSplat({ sceneType: 'gaussian_splat' });
        expect(data.splatUrl).toBeUndefined();
        expect(data.splatTilesetUrl).toBeUndefined();
        expect(data.splatOptions).toBeUndefined();
        expect(data.worldBranch).toBeUndefined();
        expect(data.objects).toEqual([]);
        expect(JSON.stringify(data)).not.toContain('colosseum_splat');
        expect(composedFallbackContent(data).madeUpSplats).toBe(0);
    });

    it('keeps the worldBranch and sceneType the model sent', async () => {
        const data = await mountSplat({ ...SPLAT_PAYLOAD, worldBranch: 'splat-world/colosseum-capture' });
        expect(data.worldBranch).toBe('splat-world/colosseum-capture');
        expect(data.sceneType).toBe('gaussian_splat');
        expect(composedFallbackContent(data).madeUpSplats).toBe(0);
    });

    it('draws nothing for a splat world with no splat file and no objects', () => {
        const composed = composedFallbackContent({ title: 'Colosseum', worldBranch: 'splat-world/colosseum', sceneType: 'gaussian_splat', objects: [] } as Scene3DData);
        expect(composed.madeUpSplats).toBe(0);
        expect(composed.meshes).toEqual([]);
    });

    it('counts a splat file as the scene\'s own content, so no fallback mesh is drawn beside it', () => {
        expect(hasNonFallbackObjectContent({ splatUrl: '/models/x.splat' })).toBe(true);
        expect(hasNonFallbackObjectContent({ splatTilesetUrl: '/tilesets/x/tileset.json' })).toBe(true);
        expect(hasNonFallbackObjectContent({ objects: [] })).toBe(false);
        expect(hasNonFallbackObjectContent({ objects: [{ id: 'm', content: { type: '3d-scene', durableUri: 'internal:mesh' } }] as any })).toBe(false);
        // Without a sceneType the viewport would otherwise add its blue sculpt sphere next to the splat.
        expect(composedFallbackContent({ title: 'Capture', splatUrl: '/models/x.splat' } as Scene3DData).meshes).toEqual([]);
    });
});

describe('a {type, data} envelope under modelAuthoredOnly takes scene state only from the model or the open scene', () => {
    const envelope = (data: Record<string, unknown>) => '```json\n' + JSON.stringify({ type: '3d-scene', title: 'Chalets', data }) + '\n```';

    it('"Make the two mountain chalets red" switches on no biomes or playback and takes no template worldBranch', () => {
        const prompt = 'Make the two mountain chalets red';
        const art = parseOrSynthesizeArtifact(prompt, envelope({ objects: TWO_OBJECTS }), { prompt, mode: 'agent' } as any, [], undefined, { modelAuthoredOnly: true })!;
        const data = art.data as Scene3DData;
        expect(art.type).toBe('3d-scene');
        expect(data.features?.terrainBiomes).toBeUndefined();
        expect(data.features?.contrails).toBeUndefined();
        expect(data.features?.controlSurfaces).toBeUndefined();
        expect(data.timeline?.isPlaying).not.toBe(true);
        expect(data.timeline).toBeUndefined();
        expect(data.animation).toBeUndefined();
        expect(data.worldBranch).toBeUndefined();
        expect(data.sceneType).toBeUndefined();
    });

    it('keeps the open scene\'s worldBranch, sceneType, timeline and features on a follow-up', () => {
        const prompt = 'Make the two mountain chalets a red color';
        const active: CanvasArtifact = {
            id: 'art-chalets', type: '3d-scene', title: 'Chalets', summary: '', version: 1, createdAt: 'now',
            data: {
                title: 'Chalets', objects: TWO_OBJECTS, worldBranch: 'studio/void', sceneType: 'adaptive', animation: 'none',
                timeline: { currentTimeMs: 1200, durationMs: 8000, isPlaying: false, speed: 1, isLooping: false },
                features: { godRays: false }
            } as any
        };
        const art = parseOrSynthesizeArtifact(prompt, envelope({ objects: TWO_OBJECTS }), { prompt, mode: 'agent', activeArtifact: active } as any, [], undefined, { modelAuthoredOnly: true })!;
        const data = art.data as Scene3DData;
        expect(data.worldBranch).toBe('studio/void');
        expect(data.sceneType).toBe('adaptive');
        expect(data.animation).toBe('none');
        expect(data.timeline).toEqual((active.data as Scene3DData).timeline);
        expect(data.features?.terrainBiomes).toBeUndefined();
    });

    it('takes them from the model\'s data when it sends them', () => {
        const prompt = 'Make the two mountain chalets red';
        const timeline = { currentTimeMs: 0, durationMs: 4000, isPlaying: true, speed: 1, isLooping: true };
        const terrainBiomes = { enabled: true, biomeType: 'alpine' };
        const art = parseOrSynthesizeArtifact(prompt, envelope({ objects: TWO_OBJECTS, worldBranch: 'earth/alps', sceneType: 'adaptive', timeline, features: { terrainBiomes } }), { prompt, mode: 'agent' } as any, [], undefined, { modelAuthoredOnly: true })!;
        const data = art.data as Scene3DData;
        expect(data.worldBranch).toBe('earth/alps');
        expect(data.sceneType).toBe('adaptive');
        expect(data.timeline).toEqual(timeline);
        expect(data.features?.terrainBiomes).toEqual(terrainBiomes);
    });
});

describe('only a registered primitive type becomes an artifact', () => {
    it('webhook-shaped JSON in an agent reply is not an artifact', () => {
        const prompt = 'What does the Stripe invoice.paid event look like?';
        const reply = 'A paid invoice arrives like this:\n```json\n' + JSON.stringify({ id: 'evt_1', type: 'invoice.paid', data: { object: { id: 'in_1', amount_paid: 2000 } } }, null, 2) + '\n```';
        expect(parseOrSynthesizeArtifact(prompt, reply, { prompt, mode: 'agent' } as any, [], undefined, { modelAuthoredOnly: true })).toBeUndefined();
    });

    it('a primitive tag of an unknown type is not an artifact under modelAuthoredOnly', () => {
        const prompt = 'Show the payload';
        const reply = '<scratchboxPrimitive type="invoice.paid" title="Invoice">\n```json\n{"data": {"amount_paid": 2000}}\n```\n</scratchboxPrimitive>';
        expect(parseOrSynthesizeArtifact(prompt, reply, { prompt, mode: 'agent' } as any, [], undefined, { modelAuthoredOnly: true })).toBeUndefined();
    });

    it('an alias in the envelope names its primitive', () => {
        const prompt = 'Show the two buildings side by side';
        for (const alias of ['scene-3d', '3d', '3d_scene', '3d-world']) {
            const reply = '```json\n' + JSON.stringify({ type: alias, title: 'Pair', data: { objects: TWO_OBJECTS } }) + '\n```';
            const art = parseOrSynthesizeArtifact(prompt, reply, { prompt, mode: 'agent' } as any, [], undefined, { modelAuthoredOnly: true });
            expect(art?.type).toBe('3d-scene');
        }
    });

    it('normalizePrimitiveType maps exact names and aliases, and nothing else', () => {
        expect(normalizePrimitiveType('3d-scene')).toBe('3d-scene');
        expect(normalizePrimitiveType(' 3D ')).toBe('3d-scene');
        expect(normalizePrimitiveType('video-editor')).toBe('video-timeline');
        expect(normalizePrimitiveType('document')).toBe('markdown-document');
        expect(normalizePrimitiveType('invoice.paid')).toBeUndefined();
        expect(normalizePrimitiveType('3d scene of a hall')).toBeUndefined();
        expect(normalizePrimitiveType('constructor')).toBeUndefined();
        expect(normalizePrimitiveType(undefined)).toBeUndefined();
        expect(PRIMITIVE_TYPES).toContain('3d-scene');
    });
});

describe('mount_canvas_primitive normalizes the primitive type it is given', () => {
    const mount = (primitiveType: unknown, prompt = 'Show the two buildings side by side') => canvasHandlers.mount_canvas_primitive(
        { primitiveType, title: 'Pair', payload: { objects: TWO_OBJECTS } },
        { request: { prompt, chatHistory: [] } } as any
    ) as Promise<any>;

    for (const alias of ['3d', 'scene-3d', '3d_scene', '3d-world']) {
        it(`mounts primitiveType "${alias}" as a 3d-scene`, async () => {
            const res = await mount(alias);
            const artifact = res.resultPayload.artifact as CanvasArtifact;
            expect(res.resultPayload.primitiveType).toBe('3d-scene');
            expect(artifact.type).toBe('3d-scene');
            expect((artifact.data as Scene3DData).objects?.map(o => o.id)).toEqual(['base', 'revised']);
            expect((artifact.data as Scene3DData).customMeshes).toEqual([]);
        });
    }

    it('fails clearly for an unknown or missing type instead of mounting it', async () => {
        const unknown = await mount('hologram');
        expect(unknown.status).toBe('failed');
        expect(unknown.resultPayload.success).toBe(false);
        expect(unknown.resultPayload.error).toContain('Unknown primitiveType "hologram"');
        expect(unknown.resultPayload.error).toContain('3d-scene');
        expect(unknown.resultPayload.artifact).toBeUndefined();

        const missing = await mount(undefined);
        expect(missing.status).toBe('failed');
        expect(missing.resultPayload.error).toContain('primitiveType is required');
        expect(missing.resultPayload.artifact).toBeUndefined();
    });

    it('leaves a markdown mount a markdown document when the prompt talks about cutting a video clip', async () => {
        const sections = [{ id: 's1', type: 'paragraph', content: 'Cut the clip at 0:12.' }];
        const res: any = await canvasHandlers.mount_canvas_primitive(
            { primitiveType: 'markdown-document', title: 'Edit notes', payload: { title: 'Edit notes', sections } },
            { request: { prompt: 'Write notes on where to cut the video clip on the timeline', chatHistory: [] } } as any
        );
        expect(res.resultPayload.artifact.type).toBe('markdown-document');
        expect(res.resultPayload.artifact.data.sections).toEqual(sections);
    });
});

describe('agent turns that end in prose', () => {
    function mockService(body: string): GeminiService {
        const service = new GeminiService();
        (service as any).auth = { getClient: async () => ({ getAccessToken: async () => ({ token: 'mock-token' }) }) };
        (service as any).cachedProjectId = 'mock-project';
        (globalThis as any).fetch = async () => ({ ok: true, text: async () => body, body: null });
        return service;
    }
    const textTurn = (text: string) => `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }] })}\ndata: [DONE]`;
    const ACTIVE: CanvasArtifact = {
        id: 'art-pair', type: '3d-scene', title: 'Two Object Comparison', summary: 'pair', version: 2, createdAt: 'now',
        data: { title: 'Two Object Comparison', objects: TWO_OBJECTS } as any
    };

    it('a Vertex agent interaction never announces artifact_complete without an artifact', async () => {
        const service = mockService(`data: ${JSON.stringify({ id: 'int-1', steps: [{ type: 'model_output', content: [{ text: 'Both buildings are side by side.' }] }] })}`);
        const events: GeminiStreamEvent[] = [];
        const response = await service.streamGenerate({
            prompt: 'Show the two buildings side by side', agent: 'scratchbox-agent', mode: 'agent', activeArtifact: ACTIVE
        } as any, e => events.push(e));

        expect(response.success).toBe(true);
        expect(response.text).toContain('side by side');
        expect(response.artifact).toBeUndefined();
        expect(events.some(e => e.type === 'done')).toBe(true);
        expect(events.filter(e => e.type === 'artifact_complete')).toEqual([]);
    });

    it('generateArtifact returns the open artifact unchanged for a prose reply in agent mode', async () => {
        const before = JSON.stringify(ACTIVE);
        const service = mockService(textTurn('Both buildings are side by side: the base model on the left, the revision on the right.'));
        const response = await service.generateArtifact({ prompt: 'Show the two buildings side by side', model: 'gemini-3.7-flash', mode: 'agent', activeArtifact: ACTIVE } as any);
        expect(response.success).toBe(true);
        expect(response.text).toContain('side by side');
        expect(JSON.stringify(response.artifact)).toBe(before);
        expect(JSON.stringify(ACTIVE)).toBe(before);
        expect(runScriptSync).not.toHaveBeenCalled();
    });

    it('generateArtifact still fails for a prose reply in agent mode with nothing open', async () => {
        const service = mockService(textTurn('Both buildings are side by side.'));
        await expect(service.generateArtifact({ prompt: 'Show the two buildings side by side', model: 'gemini-3.7-flash', mode: 'agent' } as any))
            .rejects.toThrow('AI generation completed without producing an artifact');
    });
});
