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
import { buildPendingPythonGenerator, parseOrSynthesizeArtifact, extractCodeSandboxArtifact, extractDocumentTitle, openArtifactUpdateRule, withOpenArtifactRule } from '../src/node/gemini/artifact-synthesis';
import { MarkdownDocumentPrimitive } from '../src/browser/generative-canvas/primitives/MarkdownDocumentPrimitive';
import { DocumentCodeSurfaces } from '../src/browser/generative-canvas/studio/CanvasCardBody';
import { canvasHandlers } from '../src/node/gemini/tools/canvas-tools';
import { GeminiService } from '../src/node/gemini-service';
import { NativePythonRunnerService } from '../src/node/3d-engine/native-python-runner-service';
import { useSendMessage, type SendMessageDeps, type UseSendMessageResult } from '../src/browser/generative-canvas/hooks/useSendMessage';
import { GeminiClient as BrowserGeminiClient } from '../src/browser/generative-canvas/gemini-client';
import { WorkspaceConfigClient, type FullWorkspaceConfig } from '../src/browser/generative-canvas/workspace-config-client';
import type { ProjectArtifactController } from '../src/browser/generative-canvas/project-artifact-controller';
import type { ProjectItem } from '../src/browser/generative-canvas/ProjectsModal';
import type { CanvasArtifact, ChatSession, MarkdownDocumentData, Scene3DData } from '../src/browser/generative-canvas/canvas-types';
import type { VideoTimelineData } from '../src/browser/generative-canvas/services/video/videoTypes';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { writeBoxGroundGlb } from './helpers/box-ground-glb';

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

describe('the model starts a new artifact by saying so, never by prompt wording', () => {
    // An open Paris scene: live tiles at its anchor, a tiles object, a drone route and playback.
    const paris: CanvasArtifact = {
        id: 'art-eiffel', type: '3d-scene', title: 'Eiffel Tower', summary: '', version: 3, createdAt: 'now',
        data: {
            title: 'Eiffel Tower', renderMode: 'clay',
            geoAnchor: { lat: 48.8584, lng: 2.2945, elevation: 35, active: true },
            objects: [{ id: 'tiles', content: { type: 'model', durableUri: '/models/eiffel_clay.glb', mimeType: 'model/gltf-binary', metadata: { source: 'google3dtilesclay', role: 'environment' } }, space: { spatial3d: { x: 0, y: 0, z: 0 } } }],
            droneRoute: { active: true, pinA: { lat: 48.858, lng: 2.29 }, pinB: { lat: 48.86, lng: 2.3 } },
            timeline: { isPlaying: true }
        } as any
    };
    const teapot = { title: 'Teapot', pythonGenerator: { sourceCode: 'import scratchbox as sb\n# teapot', glbBase64: 'Z2xURg==' } };
    const expectFresh = (art: CanvasArtifact | undefined) => {
        const d = art!.data as Scene3DData;
        expect(art!.id).not.toBe('art-eiffel');
        expect(art!.version).toBe(1);
        expect(art!.title).toBe('Teapot');
        expect(d.geoAnchor).toBeUndefined();
        expect(d.objects).toEqual([]);
        expect(d.droneRoute).toBeUndefined();
        expect(d.timeline).toBeUndefined();
        expect(d.pythonGenerator?.sourceCode).toBe(teapot.pythonGenerator.sourceCode);
        expect(d.renderMode).toBe('clay');
    };

    it('an envelope with "newArtifact": true is a new scene: nothing of the open place is kept', () => {
        const text = 'Here is a teapot.\n' + json({ type: '3d-scene', title: 'Teapot', newArtifact: true, data: teapot });
        expectFresh(parseOrSynthesizeArtifact('now model a teapot', text, { prompt: 'now model a teapot', activeArtifact: paris } as any, []));
    });

    it('an id other than the open artifact\'s is a new artifact too; the open id continues it', () => {
        const other = json({ type: '3d-scene', title: 'Teapot', id: 'art-teapot', data: teapot });
        const art = parseOrSynthesizeArtifact('now model a teapot', other, { prompt: 'now model a teapot', activeArtifact: paris } as any, []);
        expectFresh(art);
        expect(art!.id).toBe('art-teapot');
        const same = parseOrSynthesizeArtifact('add a fountain', json({ type: '3d-scene', id: 'art-eiffel', data: { objects: [] } }), { prompt: 'add a fountain', activeArtifact: paris } as any, [])!;
        expect(same.id).toBe('art-eiffel');
        expect(same.version).toBe(4);
        expect((same.data as Scene3DData).geoAnchor).toMatchObject({ lat: 48.8584 });
    });

    it('a tag with newArtifact="true" is a new scene', () => {
        const text = `<scratchboxPrimitive type="3d-scene" title="Teapot" newArtifact="true">\n${json(teapot)}\n</scratchboxPrimitive>`;
        expectFresh(parseOrSynthesizeArtifact('now model a teapot', text, { prompt: 'now model a teapot', activeArtifact: paris } as any, []));
    });

    it('without either, the envelope is the next version of the open scene, whatever the prompt says', () => {
        const art = parseOrSynthesizeArtifact('now model a teapot', json({ type: '3d-scene', title: 'Teapot', data: teapot }), { prompt: 'now model a teapot', activeArtifact: paris } as any, [])!;
        expect(art.id).toBe('art-eiffel');
        expect((art.data as Scene3DData).geoAnchor).toMatchObject({ lat: 48.8584 });
    });

    it('a new document is not named after, or merged into, the open one', () => {
        const openDoc: CanvasArtifact = { id: 'art-doc', type: 'markdown-document', title: 'Q3 Review', summary: '', version: 2, createdAt: 'now', data: { title: 'Q3 Review', sections: [{ id: 's', type: 'paragraph', content: 'Revenue up.' }] } as any };
        const art = parseOrSynthesizeArtifact('write a packing list', json({ type: 'markdown-document', newArtifact: true, data: { markdown: '# Packing list\n\n- tent' } }), { prompt: 'write a packing list', activeArtifact: openDoc } as any, [])!;
        expect(art.id).not.toBe('art-doc');
        expect(art.title).toBe('Packing list');
    });

    it('the model is told how while an artifact is open, and not otherwise', () => {
        const rule = openArtifactUpdateRule(paris)!;
        expect(rule).toContain('"Eiffel Tower" (3d-scene, id "art-eiffel")');
        expect(rule).toContain('newArtifact="true"');
        expect(rule).toContain('"newArtifact": true');
        expect(withOpenArtifactRule('SYSTEM', paris)).toBe(`SYSTEM\n\n${rule}`);
        expect(withOpenArtifactRule('SYSTEM', undefined)).toBe('SYSTEM');
    });

    it('a streamed turn sends the rule in its system instruction while an artifact is open', async () => {
        const service = new GeminiService();
        (service as any).auth = { getClient: async () => ({ getAccessToken: async () => ({ token: 'mock-token' }) }) };
        (service as any).cachedProjectId = 'mock-project';
        const bodies: any[] = [];
        const savedFetch = (globalThis as any).fetch;
        (globalThis as any).fetch = async (_url: string, init: any) => {
            bodies.push(JSON.parse(init.body));
            const body = `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] })}\ndata: [DONE]`;
            return { ok: true, status: 200, text: async () => body, json: async () => ({}), body: null };
        };
        try {
            await service.streamGenerate({ prompt: 'now model a teapot', model: 'gemini-3.8-flash', mode: 'ask', activeArtifact: paris } as any, () => {});
            await service.streamGenerate({ prompt: 'model a teapot', model: 'gemini-3.8-flash', mode: 'ask' } as any, () => {});
        } finally {
            (globalThis as any).fetch = savedFetch;
        }
        const systemText = (b: any) => (b.systemInstruction?.parts || []).map((p: any) => p.text).join('');
        expect(systemText(bodies[0])).toContain(openArtifactUpdateRule(paris)!);
        expect(systemText(bodies[1])).not.toContain('OPEN ARTIFACT:');
    });
});

describe('a <scratchboxPrimitive> tag is read exactly like a {type, data} envelope', () => {
    // prompt-builder tells the model to always use the tag, so this is the main path. It used to mount the tag's data
    // as sent: no clay first pass, no merge with the open scene (a follow-up wiped it), no generator reclassification.
    const tag = (type: string, data: unknown, title = 'Bus') => `<scratchboxPrimitive type="${type}" title="${title}">\n${json(data)}\n</scratchboxPrimitive>`;
    const GEN = { enabled: true, filename: 'bus.py', sourceCode: 'import scratchbox as sb\n# bus', glbBase64: 'Z2xURg==' };
    const BUS = { id: 'bus', content: { type: '3d-model', durableUri: '/models/bus.glb', mimeType: 'model/gltf-binary' }, space: { spatial3d: { x: 0, y: 0, z: 0 } } };
    const ANCHOR = { lat: 51.5007, lng: -0.1246, active: true };
    const openBus = (): CanvasArtifact => ({
        id: 'art-bus', type: '3d-scene', title: 'Red Bus', summary: '', version: 3, createdAt: 'now',
        data: { title: 'Red Bus', renderMode: 'clay', pythonGenerator: GEN, objects: [BUS], geoAnchor: ANCHOR } as Scene3DData
    });
    const sameData = (a: CanvasArtifact | undefined, b: CanvasArtifact | undefined) => {
        expect(a).toBeDefined();
        expect(b).toBeDefined();
        expect({ ...a!, createdAt: '', id: '' }).toEqual({ ...b!, createdAt: '', id: '' });
    };

    it('a first scene in the tag is a clay first pass: the model\'s pbr, sky, atmosphere and materials are dropped', () => {
        const prompt = 'build a red bus';
        const data = {
            renderMode: 'pbr', environment: { skybox: 'realistic-sky', lighting: 'golden-hour' },
            features: { atmosphericScattering: true, pbrMaterials: true }, pythonGenerator: GEN
        };
        const viaTag = parseOrSynthesizeArtifact(prompt, tag('3d-scene', data), { prompt } as any, [])!;
        const scene = viaTag.data as Scene3DData;
        expect(scene.renderMode).toBe('clay');
        expect(scene.environment).toMatchObject({ skybox: 'studio', lighting: 'studio' });
        expect(scene.features?.atmosphericScattering).toBeUndefined();
        expect(scene.features?.pbrMaterials).toBeUndefined();
        expect(scene.pythonGenerator?.sourceCode).toBe(GEN.sourceCode);
        sameData(viaTag, parseOrSynthesizeArtifact(prompt, json({ type: '3d-scene', title: 'Bus', data }), { prompt } as any, []));
    });

    it('a follow-up in the tag updates the open scene: what the model left out is kept', () => {
        const prompt = 'move the camera closer';
        const camera = { position: [4, 2, 6], target: [0, 1, 0] };
        const art = parseOrSynthesizeArtifact(prompt, tag('3d-scene', { camera }), { prompt, activeArtifact: openBus() } as any, [])!;
        const scene = art.data as Scene3DData;
        expect(art.id).toBe('art-bus');
        expect(art.version).toBe(4);
        expect(scene.camera).toEqual(camera);
        expect(scene.objects?.map(o => o.id)).toEqual(['bus']);
        expect(scene.geoAnchor).toEqual(ANCHOR);
        expect(scene.pythonGenerator?.sourceCode).toBe(GEN.sourceCode);
        expect(scene.renderMode).toBe('clay');
        sameData(art, parseOrSynthesizeArtifact(prompt, json({ type: '3d-scene', title: 'Bus', data: { camera } }), { prompt, activeArtifact: openBus() } as any, []));
    });

    it('a Python script the model filed under cppGenerator in the tag is run as Python', async () => {
        vi.spyOn(NativePythonRunnerService.getInstance(), 'runScript').mockResolvedValue({ success: true, exitCode: 0, stdout: '', stderr: '', executionTimeMs: 1, glbBase64: 'AAAA', glbPath: '/tmp/bus.glb' } as any);
        const prompt = 'build a bus';
        const art = (await buildPendingPythonGenerator(parseOrSynthesizeArtifact(prompt, tag('3d-scene', { cppGenerator: { sourceCode: 'import scratchbox as sb\n# bus' } }), { prompt } as any, [])))!;
        const scene = art.data as Scene3DData;
        expect(scene.cppGenerator).toBeUndefined();
        expect(scene.pythonGenerator).toMatchObject({ sourceCode: 'import scratchbox as sb\n# bus', glbBase64: 'AAAA' });
    });

    it('a video timeline in the tag keeps only the model\'s tracks, like the envelope', () => {
        const prompt = 'cut the intro';
        const tracks = [{ id: 't1', type: 'video', name: 'V1', clips: [{ id: 'c1', startTime: 0, duration: 3 }] }];
        const art = parseOrSynthesizeArtifact(prompt, tag('video-timeline', { tracks }, 'Intro'), { prompt } as any, [])!;
        expect((art.data as VideoTimelineData).tracks).toEqual(tracks);
        expect((art.data as VideoTimelineData).duration).toBe(3);
        sameData(art, parseOrSynthesizeArtifact(prompt, json({ type: 'video-timeline', title: 'Intro', data: { tracks } }), { prompt } as any, []));
    });

    it('a document tag with no sections or markdown is not mounted', () => {
        const prompt = 'write it up';
        expect(parseOrSynthesizeArtifact(prompt, tag('markdown-document', { sections: [] }, 'Notes'), { prompt } as any, [])).toBeUndefined();
        expect(parseOrSynthesizeArtifact(prompt, '<scratchboxPrimitive type="markdown-document" title="Notes">\n</scratchboxPrimitive>', { prompt } as any, [])).toBeUndefined();
        // Markdown sent in a JSON field is the document, not the JSON text read as markdown.
        const art = parseOrSynthesizeArtifact(prompt, tag('markdown-document', { markdown: '# Q3 Budget\n\nFlat.' }, 'Budget'), { prompt } as any, [])!;
        expect((art.data as MarkdownDocumentData).sections.map(sec => sec.content)).toEqual(['Q3 Budget', 'Flat.']);
    });

    it('an untitled document is not named after a scene that happens to be open', () => {
        const prompt = 'summarise the budget';
        const md = '# Q3 Budget\n\nSpend is flat on Q2.';
        const viaEnvelope = parseOrSynthesizeArtifact(prompt, json({ type: 'markdown-document', data: { markdown: md } }), { prompt, activeArtifact: openBus() } as any, [])!;
        expect(viaEnvelope.title).toBe('Q3 Budget');
        const viaTag = parseOrSynthesizeArtifact(prompt, `<scratchboxPrimitive type="markdown-document">\n${md}\n</scratchboxPrimitive>`, { prompt, activeArtifact: openBus() } as any, [])!;
        expect(viaTag.title).toBe('Q3 Budget');
        // The next version of an open document keeps that document's title.
        const openDoc: CanvasArtifact = { id: 'art-doc', type: 'markdown-document', title: 'Finance notes', summary: '', version: 1, createdAt: 'now', data: { title: 'Finance notes', sections: [] } };
        expect(parseOrSynthesizeArtifact(prompt, json({ type: 'markdown-document', data: { markdown: md } }), { prompt, activeArtifact: openDoc } as any, [])!.title).toBe('Finance notes');
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

    it('stated counts are not stored; counts are measured from the GLB bytes', async () => {
        const glbFile = path.join(os.tmpdir(), `sb_mount_counts_${process.pid}.glb`);
        writeBoxGroundGlb(glbFile, [-5, 0, -5], [5, 20, 5], 100);
        const glbBase64 = fs.readFileSync(glbFile).toString('base64');
        fs.unlinkSync(glbFile);
        const res: any = await canvasHandlers.mount_canvas_primitive({ primitiveType: '3d-scene', title: 'Box', payload: { cppGenerator: { glbBase64, vertexCount: 99, triangleCount: 99 } } }, ctx);
        const scene = res.resultPayload.artifact.data as Scene3DData;
        expect(scene.cppGenerator?.vertexCount).toBe(1620);
        expect(scene.cppGenerator?.triangleCount).toBe(810);
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

    it('customMeshes the model sent are refused with a reason, not dropped while the mount reports success', async () => {
        const res: any = await canvasHandlers.mount_canvas_primitive({ primitiveType: '3d-scene', title: 'X', payload: { customMeshes: [{ id: 'm', type: 'box' }], cppGenerator: { glbBase64: 'Z2xURg==' } } }, ctx);
        expect(res.status).toBe('failed');
        expect(res.resultPayload.error).toContain('payload.customMeshes (1) cannot be mounted');
        expect(res.resultPayload.artifact).toBeUndefined();
        // An empty list is no request for meshes.
        const ok: any = await canvasHandlers.mount_canvas_primitive({ primitiveType: '3d-scene', title: 'X', payload: { customMeshes: [], cppGenerator: { glbBase64: 'Z2xURg==' } } }, ctx);
        expect(ok.resultPayload.status).toBe('success');
    });

    it('a scene that declares nothing to draw fails instead of mounting an empty viewport', async () => {
        for (const payload of [{}, { camera: { position: [0, 2, 5] } }, { objects: [] }]) {
            const res: any = await canvasHandlers.mount_canvas_primitive({ primitiveType: '3d-scene', title: 'X', payload }, ctx);
            expect(res.status, JSON.stringify(payload)).toBe('failed');
            expect(res.resultPayload.error).toContain('has no content to draw');
            expect(res.summaryResult).not.toContain('Mounted');
        }
        // A placeholder URI the model sends is the model's object: the mount names it instead of dropping it.
        const placeholder: any = await canvasHandlers.mount_canvas_primitive({ primitiveType: '3d-scene', title: 'X', payload: { objects: [{ id: 'p', content: { type: '3d-model', durableUri: 'internal:mesh' } }] } }, ctx);
        expect(placeholder.status).toBe('failed');
        expect(placeholder.resultPayload.error).toContain('p (internal:mesh is not a .glb, .gltf, .splat or .spz file)');
        expect(placeholder.summaryResult).not.toContain('Mounted');
        // An anchor the tiles layer would refuse fails with the layer's own reason.
        const badAnchor: any = await canvasHandlers.mount_canvas_primitive({ primitiveType: '3d-scene', title: 'X', payload: { geoAnchor: { lat: 'x', lng: 2 } } }, ctx);
        expect(badAnchor.status).toBe('failed');
        expect(badAnchor.resultPayload.error).toContain('the scene\'s geoAnchor lat/lng are not numbers (lat "x", lng 2)');
        for (const payload of [{ objects: [{ id: 'a', content: { type: '3d-model', durableUri: '/models/a.glb' } }] }, { geoAnchor: { lat: 51.5, lng: -0.12 } },
            { splatUrl: '/models/a.splat' }, { customScript: 'scene.add(x)' }]) {
            const res: any = await canvasHandlers.mount_canvas_primitive({ primitiveType: '3d-scene', title: 'X', payload }, ctx);
            expect(res.resultPayload.status, JSON.stringify(payload)).toBe('success');
        }
    });

    it('a mount reports success only for what the viewport draws', async () => {
        // A generator known only by a server file path: the viewport never loads it (it showed "No geometry").
        const pathOnly: any = await canvasHandlers.mount_canvas_primitive({ primitiveType: '3d-scene', title: 'Lantern', payload: { pythonGenerator: { glbPath: '/tmp/build/3d-python/lantern.glb' } } }, ctx);
        expect(pathOnly.status).toBe('failed');
        expect(pathOnly.resultPayload.error).toContain('pythonGenerator.glbPath (/tmp/build/3d-python/lantern.glb) is a file on the server that the viewport does not load');
        expect(pathOnly.summaryResult).not.toContain('Mounted');
        // Objects the viewport's loader skips: internal:plane (taught by an old schema example), an image, an .obj.
        for (const durableUri of ['internal:plane', 'https://example.com/photo.jpg', '/models/teapot.obj']) {
            const payload = { objects: [{ id: 'hero', content: { type: '3d-model', durableUri, mimeType: 'model/procedural-aircraft' } }] };
            const res: any = await canvasHandlers.mount_canvas_primitive({ primitiveType: '3d-scene', title: 'X', payload }, ctx);
            expect(res.status, durableUri).toBe('failed');
            expect(res.resultPayload.error).toContain(`hero (${durableUri} is not a .glb, .gltf, .splat or .spz file)`);
            expect(res.resultPayload.artifact).toBeUndefined();
        }
        // Next to a drawable model, an undrawable object still fails the mount rather than vanishing.
        const mixed: any = await canvasHandlers.mount_canvas_primitive({ primitiveType: '3d-scene', title: 'X', payload: { objects: [
            { id: 'a', content: { type: '3d-model', durableUri: '/models/a.glb' } },
            { id: 'b', content: { type: '3d-model' } }
        ] } }, ctx);
        expect(mixed.status).toBe('failed');
        expect(mixed.resultPayload.error).toContain('b (it has no content.durableUri)');
        // What the viewport does draw mounts: models, splats, a map-3d object with an anchor, a generator GLB.
        for (const payload of [
            { objects: [{ id: 'a', content: { type: '3d-model', durableUri: '/api/models/a.glb?v=2' } }] },
            { objects: [{ id: 's', content: { type: 'gaussian-splat', durableUri: '/models/s.spz' } }] },
            { objects: [{ id: 'm', content: { type: 'map-3d' }, space: { geoAnchor: { lat: 51.5, lng: -0.12, alt: 10 } } }] },
            { pythonGenerator: { glbPath: '/tmp/x.glb', glbBase64: 'Z2xURg==' } }
        ]) {
            const res: any = await canvasHandlers.mount_canvas_primitive({ primitiveType: '3d-scene', title: 'X', payload }, ctx);
            expect(res.resultPayload.status, JSON.stringify(payload)).toBe('success');
        }
    });

    it('operators dispatched with no scene open start from a clay first pass', async () => {
        const res: any = await canvasHandlers.scene_3d_dispatch_operators({ commands: [] }, { request: { prompt: 'add a key light' } } as any);
        expect(res.resultPayload.artifact.data.renderMode).toBe('clay');
        expect(res.resultPayload.artifact.data.environment).toMatchObject({ skybox: 'studio', lighting: 'studio' });
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

    it('only a slash command starts the deep-write pipeline; words in a message go to the model', async () => {
        for (const prompt of ['Can you deep write the onboarding doc?', 'Do some intensive planning for the launch', 'help me plan a codebase for a todo app']) {
            const deepWrites: string[] = [];
            const { streamed } = await sendWithArtifact(prompt, SCENE, p => deepWrites.push(p));
            expect(deepWrites, prompt).toEqual([]);
            expect(streamed, prompt).toBe(true);
            vi.restoreAllMocks();
        }
        const deepWrites: string[] = [];
        const { streamed } = await sendWithArtifact('/plan a todo app', SCENE, p => deepWrites.push(p));
        expect(deepWrites).toEqual(['a todo app']);
        expect(streamed).toBe(false);
    });

    it('an "animate" follow-up does not switch on playback the model did not set', async () => {
        const scene: CanvasArtifact = { ...SCENE, data: { title: 'Shed', objects: [] } as Scene3DData };
        const { reply } = await sendWithArtifact('animate the shed door', scene);
        expect((reply.artifacts?.[0]?.data as Scene3DData).timeline).toBeUndefined();
        expect((reply.artifacts?.[0]?.data as Scene3DData).animation).toBeUndefined();
    });
});

async function sendWithArtifact(text: string, artifact: CanvasArtifact, onDeepWrite?: (prompt: string) => void) {
    vi.spyOn(WorkspaceConfigClient.getInstance(), 'fetchWorkspaceConfig').mockResolvedValue({ workspaceRoot: '/tmp/ws', rules: [], customSkills: [], customMcpServers: [] } as FullWorkspaceConfig);
    const stream = vi.spyOn(BrowserGeminiClient.getInstance(), 'streamGenerate').mockImplementation(async (_request, onEvent) => {
        onEvent({ type: 'artifact_complete', artifact });
        onEvent({ type: 'done', text: 'Done.', artifact });
    });
    let sessions: ChatSession[] = [{ id: 'S', title: 'Chat', dateCategory: 'Today', updatedAt: 'now', messages: [], artifactHistory: [], layoutMode: '3d' }];
    let active: CanvasArtifact | undefined = artifact;
    const noop = () => undefined;
    const deps: SendMessageDeps = {
        inputValue: '', isGenerating: false, setInputValue: noop,
        executeDeepWritePipeline: async (prompt: string) => { onDeepWrite?.(prompt); }, handleStartAgent: async () => undefined,
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
    return { reply, active, user, streamed: stream.mock.calls.length > 0 };
}
