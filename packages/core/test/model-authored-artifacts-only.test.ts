/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Canvas artifacts are what the model wrote, in every mode and on every path.
 *
 * - parseOrSynthesizeArtifact built template scenes, documents, apps and timelines from prompt keywords whenever the
 *   request was not in agent/plan/ask mode, and even in those modes replaced a model document with a synthesized one
 *   when the prompt said "write" (and filled its headings, callouts and subtitles with canned text).
 * - mount_canvas_primitive reported success with a made-up 50,000/30,000 vertex count when the scene's Python script
 *   failed, and filled video timelines from a prompt-keyword template.
 * - The chat client swapped the model's artifact for a template sandbox or video timeline when the prompt matched a
 *   regex ("build a garden tool shed in clay" matched the sandbox one).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseOrSynthesizeArtifact, extractCodeSandboxArtifact, extractDocumentTitle } from '../src/node/gemini/artifact-synthesis';
import { MarkdownDocumentPrimitive } from '../src/browser/generative-canvas/primitives/MarkdownDocumentPrimitive';
import { DocumentCodeSurfaces } from '../src/browser/generative-canvas/studio/CanvasCardBody';
import { canvasHandlers } from '../src/node/gemini/tools/canvas-tools';
import { NativePythonRunnerService } from '../src/node/3d-engine/native-python-runner-service';
import { useSendMessage, type SendMessageDeps, type UseSendMessageResult } from '../src/browser/generative-canvas/hooks/useSendMessage';
import { GeminiClient as BrowserGeminiClient } from '../src/browser/generative-canvas/gemini-client';
import { WorkspaceConfigClient, type FullWorkspaceConfig } from '../src/browser/generative-canvas/workspace-config-client';
import type { ProjectArtifactController } from '../src/browser/generative-canvas/project-artifact-controller';
import type { ProjectItem } from '../src/browser/generative-canvas/ProjectsModal';
import type { CanvasArtifact, ChatSession, MarkdownDocumentData, Scene3DData } from '../src/browser/generative-canvas/canvas-types';
import type { VideoTimelineData } from '../src/browser/generative-canvas/services/video/videoTypes';

afterEach(() => vi.restoreAllMocks());

const json = (v: unknown) => '```json\n' + JSON.stringify(v) + '\n```';

describe('parseOrSynthesizeArtifact builds only what the model wrote, in every mode', () => {
    for (const mode of [undefined, 'studio', 'agent'] as const) {
        it(`a prose reply yields no artifact (mode ${mode ?? 'unset'})`, () => {
            for (const prompt of ['Build a 3D cyberpunk city with neon towers', 'Write a research report on 1776', 'Make a calculator app', 'Split the active clip at the playhead']) {
                expect(parseOrSynthesizeArtifact(prompt, 'Here is what I would do next.', { prompt, mode } as any, [])).toBeUndefined();
            }
        });
    }

    it('keeps the model\'s two-section document when the prompt says "write" (no synthesized replacement or canned text)', () => {
        const prompt = 'Write a short report on the 1776 crossing of the Delaware';
        const sections = [
            { id: 'h', type: 'heading', level: 1, content: 'Crossing the Delaware' },
            { id: 'p', type: 'paragraph', content: 'Washington crossed on the night of 25 December.' }
        ];
        const art = parseOrSynthesizeArtifact(prompt, json({ type: 'markdown-document', title: 'Delaware', data: { title: 'Delaware', sections } }), { prompt, mode: 'studio' } as any, [])!;
        const doc = art.data as MarkdownDocumentData;
        expect(doc.sections).toEqual(sections);
        expect(doc.subtitle).toBeUndefined();
        expect(JSON.stringify(doc)).not.toContain('Birth of a Nation');
    });

    it('leaves an empty heading empty instead of writing a template heading into it', () => {
        const prompt = 'Write the security spec';
        const art = parseOrSynthesizeArtifact(prompt, json({ type: 'markdown-document', data: { sections: [{ type: 'heading', content: '' }, { type: 'callout', content: 'Rotate keys daily.' }] } }), { prompt } as any, [])!;
        const doc = art.data as MarkdownDocumentData;
        expect(doc.sections[0]).toMatchObject({ type: 'heading', content: '' });
        expect(doc.sections[1]).toMatchObject({ type: 'callout', calloutTitle: '', content: 'Rotate keys daily.' });
    });

    it('takes a 3D scene from the model only: no template camera, generator, meshes or anchor', () => {
        const prompt = 'Build a 3D lighthouse on a rocky island';
        const art = parseOrSynthesizeArtifact(prompt, json({ type: '3d-scene', title: 'Lighthouse', data: { objects: [] } }), { prompt, mode: 'studio' } as any, [])!;
        const scene = art.data as Scene3DData;
        expect(art.title).toBe('Lighthouse');
        expect(scene.pythonGenerator).toBeUndefined();
        expect(scene.cppGenerator).toBeUndefined();
        expect(scene.customScript).toBeUndefined();
        expect(scene.customMeshes).toBeUndefined();
        expect(scene.geoAnchor).toBeUndefined();
        expect(scene.camera).toBeUndefined();
        expect(scene.objects).toEqual([]);
        expect(scene.renderMode).toBe('clay');
    });

    it('takes a video timeline\'s tracks from the model only', () => {
        const prompt = 'Split active clip at playhead and ripple delete';
        const tracks = [{ id: 't1', type: 'video', name: 'V1', clips: [{ id: 'c1', startTime: 0, duration: 4 }] }];
        const art = parseOrSynthesizeArtifact(prompt, json({ type: 'video-timeline', title: 'Cut', data: { tracks } }), { prompt } as any, [])!;
        const tl = art.data as VideoTimelineData;
        expect(tl.tracks).toEqual(tracks);
        expect(tl.mediaAssets).toEqual([]);
        expect(tl.duration).toBe(4);
    });

    it('a reply without runnable code is no sandbox (no template app)', () => {
        expect(extractCodeSandboxArtifact('Make a calculator app', 'I can build that for you.')).toBeNull();
        const withCode = extractCodeSandboxArtifact('Make a calculator app', '```tsx\nexport default function App() { return <div>1+1</div>; }\n```');
        expect(withCode?.artifact.type).toBe('live-code-sandbox');
    });
});

describe('the document view writes nothing into the model\'s document', () => {
    const render = (data: MarkdownDocumentData) => renderToStaticMarkup(React.createElement(MarkdownDocumentPrimitive, { data, readOnly: true }));

    it('an empty document stays empty (no template document is generated from its title)', () => {
        const html = render({ title: 'The 1776 crossing of the Delaware', sections: [] });
        expect(html).toContain('The 1776 crossing of the Delaware');
        expect(html).not.toMatch(/Historical Context &amp; Genesis|Strategic overview, architectural pillars|Birth of a Nation|Executive Overview/);
        // The title is the only heading; no section is drawn.
        expect(html.match(/<h[1-6][\s>]/g)).toHaveLength(1);
        expect(html).toMatch(/<h1 class="sb-doc-main-title">The 1776 crossing of the Delaware/);
    });

    it('an empty heading, callout title and subtitle stay empty (no canned text by keyword)', () => {
        const html = render({ title: 'Zero-trust auth spec', sections: [
            { id: 'h', type: 'heading', level: 1, content: '' },
            { id: 'c', type: 'callout', content: 'Rotate keys daily.' } as any
        ] });
        expect(html).toContain('Rotate keys daily.');
        expect(html).not.toMatch(/Overview &amp; Fundamental Principles|System Overview &amp; Core Objectives|Security Guardrail|Core Architecture Insight|Comprehensive Architecture, Protocol Specifications/);
    });

    it('a document without a title gets one from the request\'s words, never a canned title', () => {
        expect(extractDocumentTitle('write a document about 1776')).toBe('1776');
        expect(extractDocumentTitle('Draft an OAuth security spec')).not.toContain('Zero-Trust Identity Infrastructure');
        // Nothing left after the request words: a neutral label, not "Strategic Specification & Notes".
        for (const prompt of ['write a document', 'hi', 'a report']) {
            expect(extractDocumentTitle(prompt)).toBe('Untitled document');
        }
        const art = parseOrSynthesizeArtifact('write a document', json({ type: 'markdown-document', data: { sections: [{ id: 'p', type: 'paragraph', content: 'Body.' }] } }), { prompt: 'write a document' } as any, [])!;
        expect(art.title).toBe('Untitled document');
    });

    it('the open document view renders the model\'s sections only, and an empty document empty', () => {
        const surface = (data: MarkdownDocumentData) => renderToStaticMarkup(React.createElement(DocumentCodeSurfaces, {
            layoutMode: 'document', docReadOnly: true, isGenerating: false, activeWorkspace: { path: '/tmp/ws', name: 'ws' },
            activeArtifact: { id: 'd', type: 'markdown-document', title: data.title, summary: '', version: 1, createdAt: 'now', data }
        } as any));
        const empty = surface({ title: 'Quarterly Revenue Review', sections: [] });
        expect(empty).toContain('Quarterly Revenue Review');
        expect(empty).not.toMatch(/Strategic Overview|Market Pillars|KPI Scorecard|Delivery Milestones/);
        expect(empty.match(/<h[1-6][\s>]/g)).toHaveLength(1);
        const one = surface({ title: 'Notes', sections: [{ id: 'p', type: 'paragraph', content: 'Only this paragraph.' }] });
        expect(one).toContain('Only this paragraph.');
        expect(one).not.toMatch(/Strategic Overview|Market Pillars/);
    });

    it('a document sent as markdown keeps its markdown (content / markdown field), never a template', () => {
        for (const field of ['content', 'markdown']) {
            const art = parseOrSynthesizeArtifact('write it', json({ type: 'markdown-document', title: 'Quarterly Revenue Review', data: { title: 'Quarterly Revenue Review', [field]: '# Revenue\n\nUp 4% on Q2.' } }), { prompt: 'write it' } as any, [])!;
            const doc = art.data as MarkdownDocumentData;
            expect(doc.sections.map(sec => sec.content)).toEqual(['Revenue', 'Up 4% on Q2.']);
        }
    });
});

describe('a 3d-scene envelope with a scene open updates that scene; no prompt wording decides what is kept', () => {
    const GEN = { enabled: true, filename: 'cottage.py', sourceCode: 'import scratchbox as sb\n# cottage', glbBase64: 'Z2xURg==' };
    const HERO = { id: 'hero', content: { type: '3d-model', durableUri: '/models/hero.glb', mimeType: 'model/gltf-binary' }, space: { spatial3d: { x: 0, y: 0, z: 0 } } };
    const SITE = { id: 'site', content: { type: '3d-model', durableUri: '/models/site_clay.glb', mimeType: 'model/gltf-binary', metadata: { isGround: true } }, space: { spatial3d: { x: 0, y: 0, z: 0 } } };
    const open = (data: Partial<Scene3DData> = {}): CanvasArtifact => ({
        id: 'art-cottage', type: '3d-scene', title: 'Cottage', summary: '', version: 2, createdAt: 'now',
        data: { title: 'Cottage', renderMode: 'clay', pythonGenerator: GEN, objects: [HERO, SITE], ...data } as Scene3DData
    });
    const reply = (data: Record<string, unknown>) => json({ type: '3d-scene', title: 'Cottage', data });

    it('keeps the generator and objects the model left out, whatever the wording', () => {
        for (const prompt of ['make the roof red', 'make the roof color red', 'raise the chimney', 'move the chimney',
            'build a stone chimney on the cottage', 'put a timber roof on it', 'construct a timber roof on it', 'make it a sedan', 'add a colosseum arch next to it']) {
            const art = parseOrSynthesizeArtifact(prompt, reply({ features: {} }), { prompt, activeArtifact: open() } as any, [])!;
            const scene = art.data as Scene3DData;
            expect(art.id, prompt).toBe('art-cottage');
            expect(scene.pythonGenerator?.sourceCode, prompt).toBe(GEN.sourceCode);
            expect(scene.objects?.map(o => o.id), prompt).toEqual(['hero', 'site']);
            expect(scene.renderMode, prompt).toBe('clay');
        }
    });

    it('takes what the model sends: a new generator replaces the old one, objects: [] clears them', () => {
        const newGen = { sourceCode: 'import scratchbox as sb\n# sedan', glbBase64: 'AAAA' };
        const art = parseOrSynthesizeArtifact('now a sedan', reply({ pythonGenerator: newGen, objects: [] }), { prompt: 'now a sedan', activeArtifact: open({ cppGenerator: { sourceCode: '// old', glbBase64: 'BBBB' } as any }) } as any, [])!;
        const scene = art.data as Scene3DData;
        expect(scene.pythonGenerator?.sourceCode).toBe(newGen.sourceCode);
        expect(scene.cppGenerator).toBeUndefined();
        expect(scene.objects).toEqual([]);
    });

    it('a follow-up leaves clay only when the model sets renderMode', () => {
        const kept = parseOrSynthesizeArtifact('make the roof red', reply({}), { prompt: 'make the roof red', activeArtifact: open() } as any, [])!;
        expect((kept.data as Scene3DData).renderMode).toBe('clay');
        const changed = parseOrSynthesizeArtifact('make it look real', reply({ renderMode: 'pbr' }), { prompt: 'make it look real', activeArtifact: open() } as any, [])!;
        expect((changed.data as Scene3DData).renderMode).toBe('pbr');
    });

    it('a first scene is clay in a studio whatever colour words the prompt has', () => {
        for (const prompt of ['build the Blue Mosque in Istanbul', 'build the Hagia Sophia in Istanbul', 'build a red double-decker bus', 'build a double-decker bus']) {
            const art = parseOrSynthesizeArtifact(prompt, reply({ renderMode: 'pbr', objects: [HERO] }), { prompt } as any, [])!;
            const scene = art.data as Scene3DData;
            expect(scene.renderMode, prompt).toBe('clay');
            expect(scene.environment, prompt).toMatchObject({ lighting: 'studio', skybox: 'studio' });
        }
    });

    it('adds no atmosphere the model did not send, even when the prompt names one', () => {
        const art = parseOrSynthesizeArtifact('add god rays and atmospheric scattering', reply({}), { prompt: 'add god rays and atmospheric scattering', activeArtifact: open() } as any, [])!;
        const scene = art.data as Scene3DData;
        expect(scene.features?.atmosphericScattering).toBeUndefined();
        expect(scene.features?.godRays).toBeUndefined();
        expect(scene.environment?.skybox).toBe('studio');
    });
});

describe('mount_canvas_primitive mounts what the model sent or fails', () => {
    const ctx = { request: { prompt: 'Build a brass telescope', chatHistory: [] } } as any;

    it('a failing Python script fails the mount with the interpreter\'s stderr', async () => {
        vi.spyOn(NativePythonRunnerService.getInstance(), 'runScript').mockResolvedValue({
            success: false, exitCode: 1, stdout: '', executionTimeMs: 12,
            stderr: 'Traceback (most recent call last):\n  File "scene.py", line 3, in <module>\nAttributeError: module \'scratchbox\' has no attribute \'make_tube\''
        });
        const res: any = await canvasHandlers.mount_canvas_primitive({ primitiveType: '3d-scene', title: 'Telescope', payload: { script: 'import scratchbox as sb\nsb.make_tube()' } }, ctx);
        expect(res.status).toBe('failed');
        expect(res.resultPayload.success).toBe(false);
        expect(res.resultPayload.error).toContain("has no attribute 'make_tube'");
        expect(res.resultPayload.artifact).toBeUndefined();
        expect(res.summaryResult).toContain("AttributeError: module 'scratchbox' has no attribute 'make_tube'");
    });

    it('a script that runs but writes no model also fails', async () => {
        vi.spyOn(NativePythonRunnerService.getInstance(), 'runScript').mockResolvedValue({ success: true, exitCode: 0, stdout: 'done', stderr: '', executionTimeMs: 5 });
        const res: any = await canvasHandlers.mount_canvas_primitive({ primitiveType: '3d-scene', title: 'Telescope', payload: { script: 'print(1)' } }, ctx);
        expect(res.status).toBe('failed');
        expect(res.resultPayload.error).toContain('wrote no model (GLB)');
    });

    it('a GLB without stated counts gets none made up', async () => {
        const res: any = await canvasHandlers.mount_canvas_primitive({ primitiveType: '3d-scene', title: 'Telescope', payload: { cppGenerator: { glbBase64: 'Z2xURg==' } } }, ctx);
        const scene = res.resultPayload.artifact.data as Scene3DData;
        expect(scene.cppGenerator?.glbBase64).toBe('Z2xURg==');
        expect(scene.cppGenerator?.vertexCount).toBeUndefined();
        expect(scene.cppGenerator?.triangleCount).toBeUndefined();
        expect(scene.camera).toBeUndefined();
        expect(scene.environment).toBeDefined(); // the clay baseline's neutral studio, not a template's
        expect(scene.environment).toMatchObject({ skybox: 'studio', lighting: 'studio' });
    });

    it('mounts the first scene in clay whatever colour words the prompt has, and keeps an open scene\'s mode', async () => {
        for (const prompt of ['build the Blue Mosque in Istanbul', 'build the Hagia Sophia in Istanbul', 'build a red double-decker bus', 'build a double-decker bus']) {
            const res: any = await canvasHandlers.mount_canvas_primitive({ primitiveType: '3d-scene', title: 'X', payload: { renderMode: 'pbr', cppGenerator: { glbBase64: 'Z2xURg==' } } }, { request: { prompt, chatHistory: [] } } as any);
            expect(res.resultPayload.artifact.data.renderMode, prompt).toBe('clay');
        }
        const openClay = { id: 'o', type: '3d-scene', data: { renderMode: 'clay' } };
        const kept: any = await canvasHandlers.mount_canvas_primitive({ primitiveType: '3d-scene', title: 'X', payload: { cppGenerator: { glbBase64: 'Z2xURg==' } } }, { request: { prompt: 'make the bus red', activeArtifact: openClay, chatHistory: [] } } as any);
        expect(kept.resultPayload.artifact.data.renderMode).toBe('clay');
        const pbr: any = await canvasHandlers.mount_canvas_primitive({ primitiveType: '3d-scene', title: 'X', payload: { renderMode: 'pbr', cppGenerator: { glbBase64: 'Z2xURg==' } } }, { request: { prompt: 'make the bus red', activeArtifact: openClay, chatHistory: [] } } as any);
        expect(pbr.resultPayload.artifact.data.renderMode).toBe('pbr');
    });

    it('a payload that is not an object fails the mount instead of mounting {}', async () => {
        for (const payload of ['# Heading\n\nBody', undefined, [1, 2]]) {
            const res: any = await canvasHandlers.mount_canvas_primitive({ primitiveType: 'markdown-document', title: 'Notes', payload }, ctx);
            expect(res.status).toBe('failed');
            expect(res.resultPayload.error).toContain('payload must be a JSON object');
            expect(res.resultPayload.artifact).toBeUndefined();
        }
    });

    it('a document mount holds the model\'s sections or markdown, and an empty one fails', async () => {
        const empty: any = await canvasHandlers.mount_canvas_primitive({ primitiveType: 'markdown-document', title: 'Quarterly Revenue Review', payload: { title: 'Quarterly Revenue Review', sections: [] } }, ctx);
        expect(empty.status).toBe('failed');
        expect(empty.resultPayload.error).toContain('has no content');
        const md: any = await canvasHandlers.mount_canvas_primitive({ primitiveType: 'markdown-document', title: 'Q3', payload: { markdown: '# Revenue\n\nUp 4% on Q2.' } }, ctx);
        expect(md.resultPayload.status).toBe('success');
        expect(md.resultPayload.artifact.data.sections.map((sec: any) => sec.content)).toEqual(['Revenue', 'Up 4% on Q2.']);
        expect(md.resultPayload.artifact.title).toBe('Q3');
    });

    it('a video timeline mount holds only the model\'s tracks', async () => {
        const res: any = await canvasHandlers.mount_canvas_primitive({ primitiveType: 'video-timeline', title: 'Edit', payload: { tracks: [] } },
            { request: { prompt: 'Split active clip at playhead and ripple delete the gap', chatHistory: [] } } as any);
        const tl = res.resultPayload.artifact.data as VideoTimelineData;
        expect(tl.tracks).toEqual([]);
        expect(tl.mediaAssets).toEqual([]);
        expect(tl.title).toBe('Edit');
    });
});

describe('the chat client keeps the model\'s artifact', () => {
    const SCENE: CanvasArtifact = { id: 'art-shed', type: '3d-scene', title: 'Garden tool shed', summary: '', version: 1, createdAt: 'now', data: { title: 'Garden tool shed', objects: [] } as Scene3DData };

    for (const prompt of ['build a garden tool shed in clay', 'make a stone utility building', 'build a flight simulator cockpit']) {
        it(`"${prompt}" keeps the model's 3d-scene (no sandbox template swapped in)`, async () => {
            const { reply, active } = await sendWithArtifact(prompt, SCENE);
            expect(reply.artifacts?.[0]?.type).toBe('3d-scene');
            expect(reply.artifacts?.[0]?.id).toBe('art-shed');
            expect(active?.type).toBe('3d-scene');
        });
    }

    it('a video-editing prompt answered with a document keeps the document', async () => {
        const doc: CanvasArtifact = { id: 'art-doc', type: 'markdown-document', title: 'Edit notes', summary: '', version: 1, createdAt: 'now', data: { title: 'Edit notes', sections: [] } };
        const { reply } = await sendWithArtifact('Split the active clip at the playhead and ripple delete', doc);
        expect(reply.artifacts?.[0]?.type).toBe('markdown-document');
    });

    it('a file name typed in the prompt attaches no bundled test image to the user\'s message', async () => {
        for (const prompt of ['model this from matterhorn.jpg', 'rebuild civil_highway_overpass.png in clay', 'use photo.webp as reference']) {
            const { user } = await sendWithArtifact(prompt, SCENE);
            expect(user?.text, prompt).toBe(prompt);
            expect(user?.imageContent, prompt).toBeUndefined();
        }
    });

    it('an "animate" follow-up does not switch on playback the model did not set', async () => {
        const scene: CanvasArtifact = { ...SCENE, data: { title: 'Shed', objects: [] } as Scene3DData };
        const { reply } = await sendWithArtifact('animate the shed door', scene);
        expect((reply.artifacts?.[0]?.data as Scene3DData).timeline).toBeUndefined();
        expect((reply.artifacts?.[0]?.data as Scene3DData).animation).toBeUndefined();
    });
});

async function sendWithArtifact(text: string, artifact: CanvasArtifact) {
    vi.spyOn(WorkspaceConfigClient.getInstance(), 'fetchWorkspaceConfig').mockResolvedValue({ workspaceRoot: '/tmp/ws', rules: [], customSkills: [], customMcpServers: [] } as FullWorkspaceConfig);
    vi.spyOn(BrowserGeminiClient.getInstance(), 'streamGenerate').mockImplementation(async (_request, onEvent) => {
        onEvent({ type: 'artifact_complete', artifact });
        onEvent({ type: 'done', text: 'Done.', artifact });
    });
    let sessions: ChatSession[] = [{ id: 'S', title: 'Chat', dateCategory: 'Today', updatedAt: 'now', messages: [], artifactHistory: [], layoutMode: '3d' }];
    let active: CanvasArtifact | undefined = artifact;
    const noop = () => undefined;
    const deps: SendMessageDeps = {
        inputValue: '', isGenerating: false, setInputValue: noop,
        executeDeepWritePipeline: async () => undefined, handleStartAgent: async () => undefined,
        skills: [], selectedSkillIds: [], mcpServers: [], selectedMcpIds: [],
        currentSessionId: 'S', setCurrentSessionId: noop,
        sessions, setSessions: (v: any) => { sessions = typeof v === 'function' ? v(sessions) : v; },
        messages: [], setMessages: noop, setAutocompleteType: noop, setIsGenerating: noop,
        setLiveThinkingText: noop, setLiveThinkingSeconds: noop, setLiveSteps: noop, setLiveStreamedText: noop,
        setActiveStreamingSectionId: noop, liveThinkingText: '', liveThinkingSeconds: 0, liveSteps: [],
        activeSessionRef: { current: 'S' }, googleSearchGrounding: false,
        activeArtifact: artifact, setActiveArtifact: (v: any) => { active = typeof v === 'function' ? v(active) : v; },
        artifactHistory: [], setArtifactHistory: noop,
        layoutMode: '3d', setLayoutMode: noop, setMcpExecutions: noop, setTokenBudget: noop,
        setActiveTerminalError: noop, setShowTerminalErrorToast: noop, recordArtifactVersion: noop,
        attachedDataFile: undefined, setAttachedDataFile: noop, showToast: noop,
        graphControllerRef: { current: { registerArtifact: (a: any) => a } as unknown as ProjectArtifactController },
        setGraphEpoch: noop,
        activeWorkspace: { id: 'ws', name: 'ws', path: '/tmp/ws', lastActive: 'now', tags: [] } as ProjectItem,
        persistSessionsImmediately: noop,
        aiInteractionMode: 'agent'
    };
    let hook: UseSendMessageResult | undefined;
    const Harness = () => { hook = useSendMessage(deps); return null; };
    renderToStaticMarkup(React.createElement(Harness));
    await hook!.sendMessage(text);
    const reply = sessions[0].messages.find(m => m.sender === 'assistant')!;
    const user = sessions[0].messages.find(m => m.sender === 'user');
    return { reply, active, user };
}
