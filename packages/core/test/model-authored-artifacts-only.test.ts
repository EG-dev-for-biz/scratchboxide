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
    return { reply, active };
}
