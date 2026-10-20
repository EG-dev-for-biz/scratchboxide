/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Routing is the model's decision: no regex on the prompt adds a directive to it (3D, location, video timeline or
 * Gaussian splat), one 3D intent policy reaches every prompt through the system instruction in the modes that offer
 * the 3D tools, an object build on the canvas is changed by rebuilding its spec where it stands, and the long sb
 * script guide is read on demand instead of riding along in every instruction.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { activeObjectBuildContext, buildContents, buildSystemInstruction, scriptingInPlay, SB_PYTHON_SCRIPT_GUIDE, SPATIAL_INTENT_POLICY } from '../src/node/gemini/prompt-builder';
import { OBJECT_REFERENCE_TOOL_DECLARATIONS } from '../src/node/gemini/tools/object-reference-tools';
import { SB_SCRIPT_GUIDE_TOOL_DECLARATIONS, sbScriptGuideHandlers } from '../src/node/gemini/tools/sb-script-guide-tools';
import { buildToolDeclarations, createDefaultToolRegistry } from '../src/node/gemini/tool-registry';
import { CORE_WORKSPACE_PACK } from '../src/node/gemini/domain-tool-packs';
import type { GeminiGenerateRequest } from '../src/common/gemini-protocol';

const PROMPTS = [
    'a vintage brass telescope on a tripod',
    'make me a hand-carved wooden chess knight',
    'build a 3d tower',
    'build a race car in Seattle',
    'build a gondola in venice',
    'Eiffel Tower',
    'an abstract sculpture of intertwined ribbons',
    'a bioluminescent mycelium lantern',
    'a misty alien canyon with stone arches',
    'Split active clip at playhead and ripple delete downstream gap',
    'trim the b-roll on video track 2',
    'Make a gaussian splat of the Colosseum',
    'give me a 3dgs radiance field of Grand Army Plaza',
    'what is the capital of France?',
    'refactor the login handler to use async/await'
];

const SCRIPT_SCENE = { id: 's', type: '3d-scene', title: 'Canyon', data: { title: 'Canyon', pythonGenerator: { sourceCode: 'import scratchbox as sb\n' } } };
const PLAIN_SCENE = { id: 'p', type: '3d-scene', title: 'Vase', data: { title: 'Vase', objects: [] } };

const userText = (request: Partial<GeminiGenerateRequest>) => {
    const contents = buildContents(request as GeminiGenerateRequest);
    return contents[contents.length - 1].parts![0].text as string;
};

describe('routing: no prompt-word directives', () => {
    it('passes every prompt on exactly as written when nothing is on the canvas', () => {
        for (const prompt of PROMPTS) expect(userText({ prompt }), prompt).toBe(prompt);
    });

    it('adds the same canvas context for an active timeline whatever the prompt says', () => {
        const timeline = { id: 't', type: 'video-timeline', title: 'Cut', data: { title: 'Cut', duration: 10, tracks: [] } };
        const forClip = userText({ prompt: 'Split active clip at playhead', activeArtifact: timeline as any });
        const forOther = userText({ prompt: 'make it shorter', activeArtifact: timeline as any });
        expect(forClip.replace('Split active clip at playhead', '')).toBe(forOther.replace('make it shorter', ''));
        expect(forClip).not.toContain('CRITICAL DIRECTIVE');
        expect(forClip).toContain('[Active Video Timeline State:');
    });

    it('does not ship the removed directives anywhere in the prompt', async () => {
        for (const prompt of PROMPTS) {
            const system = await buildSystemInstruction({ prompt, mode: 'agent' } as GeminiGenerateRequest);
            const all = system + userText({ prompt });
            expect(all).not.toContain('PURE REAL-WORLD LOCATION QUERY');
            expect(all).not.toContain('HERO OBJECT STAGED AT REAL-WORLD LOCATION');
            expect(all).not.toContain('CRITICAL DIRECTIVE');
            expect(all).not.toContain('latent knowledge');
            expect(all).not.toContain('AdaptiveHeroObjectSynthesizer');
            expect(all).not.toContain("'generate_image'");
            expect(all).not.toContain("splatUrl: '/models/<location>_splat.splat'");
            expect(all).not.toMatch(/ALWAYS (?:use|lean on Python first via) (?:the )?'?execute_3d_python_script/);
        }
    });

    it('has no regular expression or substring test on the prompt left in prompt-builder', () => {
        const source = fs.readFileSync(path.resolve(__dirname, '../src/node/gemini/prompt-builder.ts'), 'utf8');
        expect(source).not.toMatch(/\.test\(/);
        expect(source).not.toMatch(/\.match\(/);
        expect(source).not.toMatch(/prompt[^\n]*\.includes\(/i);
        expect(source).not.toContain('isVideoTimelinePrompt');
        expect(source).not.toContain('isSplatPrompt');
    });
});

describe('3D intent policy', () => {
    it('reaches every prompt in the modes that offer its tools, and no prompt in Plan or Ask, which do not', async () => {
        const registry = createDefaultToolRegistry();
        for (const mode of ['agent', 'plan', 'ask', 'studio', undefined]) {
            for (const prompt of PROMPTS) {
                const request = { prompt, mode } as GeminiGenerateRequest;
                const system = await buildSystemInstruction(request);
                const offered = (buildToolDeclarations(request, registry) || []).flatMap(t => t.functionDeclarations || []).map(d => d.name);
                const offersTools = ['build_3d_object_from_reference', 'execute_3d_python_script', 'google_3d_tiles_get_clay'].every(n => offered.includes(n));
                if (mode === 'plan' || mode === 'ask') {
                    expect(offered, `${mode}: ${prompt}`).not.toContain('build_3d_object_from_reference');
                    expect(system, `${mode}: ${prompt}`).not.toContain(SPATIAL_INTENT_POLICY);
                    expect(system, `${mode}: ${prompt}`).not.toMatch(/call (build_3d_object_from_reference|execute_3d_python_script|google_3d_tiles_get_clay)/);
                } else {
                    expect(system, `${mode}: ${prompt}`).toContain(SPATIAL_INTENT_POLICY);
                    expect(offersTools, `${mode}: ${prompt}`).toBe(true);
                }
            }
        }
    });

    it('changes a built object by rebuilding its edited spec where it stands, not with a script', () => {
        expect(SPATIAL_INTENT_POLICY).toMatch(/To change an object that build_3d_object_from_reference built[^\n]*specJson[^\n]*same location and placement[^\n]*replaceObjectId set to its id/);
        expect(SPATIAL_INTENT_POLICY).not.toContain('editing SPEC');
        expect(SPATIAL_INTENT_POLICY).not.toContain('supporting geometry such as a plinth');
        const params = OBJECT_REFERENCE_TOOL_DECLARATIONS[0].parameters!.properties!;
        expect(params.specJson.type).toBe('STRING');
        expect(OBJECT_REFERENCE_TOOL_DECLARATIONS[0].description).toContain('at a place, pass the same location, its placement (or a new one to move it) and replaceObjectId set to that object\'s id');
        expect(params.replaceObjectId.type).toBe('STRING');
    });

    it('gives a follow-up turn every built object\'s id, placement and whole spec, decided from the scene, not the words', () => {
        const spec = { subject: 'vase', observations: [], boundingMeters: [0.3, 0.6, 0.3], expectedBodies: 1, parts: [{ id: 'body', label: 'body', revolve: { meridian: Array.from({ length: 400 }, (_, i) => [i / 400, 0.1]) } }] };
        const placement = { eastMeters: 12, northMeters: 8, headingDeg: 90, surfaceYMeters: 1.5 };
        const hero = (id: string, record: Record<string, unknown>) => ({
            id, content: { type: '3d-model', durableUri: `/models/${id}.glb`, metadata: { role: 'hero', description: 'vase', source: 'build_3d_object_from_reference', objectBuild: record } },
            space: { spatial3d: { x: 12, y: 0, z: -8, yaw: 90 } }
        });
        const tiles = { id: 'tile-clay-1', content: { type: '3d-model', durableUri: '/models/t.glb', metadata: { source: 'Google3DTilesClay', role: 'environment', isGround: true } } };
        const staged = {
            id: 'o', type: '3d-scene', title: 'Vase at Union Square',
            data: { title: 'Vase', objects: [tiles, hero('hero-1', { spec, placement })], objectBuild: { spec, objectId: 'hero-1', location: { query: 'Union Square, San Francisco' }, placement } }
        };
        const forTaller = userText({ prompt: 'make it taller', activeArtifact: staged as any });
        const forOther = userText({ prompt: 'what is this?', activeArtifact: staged as any });
        expect(forTaller.replace('make it taller', '')).toBe(forOther.replace('what is this?', ''));
        expect(forTaller).toContain(`Spec: ${JSON.stringify(spec)}]`);
        expect(forTaller).toContain('build_3d_object_from_reference built this scene\'s object at location "Union Square, San Francisco"');
        expect(forTaller).toContain('- "vase", id "hero-1" with placement {"eastMeters":12,"northMeters":8,"headingDeg":90}. Spec: ');
        expect(forTaller).toContain('pass the whole spec as specJson to build_3d_object_from_reference, with location "Union Square, San Francisco", its placement (unless the user moves it) and replaceObjectId set to its id');
        expect(forTaller).toContain('To add another object at this place, call build_3d_object_from_reference with location "Union Square, San Francisco" and a placement clear of these; they are kept.');
        expect(forTaller).toContain('add the plinth as parts of that object\'s spec and rebuild it with build_3d_object_from_reference (specJson)');
        // Two objects at the place: both are listed.
        const two = { ...staged.data, objects: [...staged.data.objects, hero('hero-2', { spec: { ...spec, subject: 'bench' }, placement: { ...placement, eastMeters: 20 } })] };
        const both = activeObjectBuildContext(two as any);
        expect(both).toContain('built these 2 objects in this scene');
        expect(both).toContain('id "hero-1"');
        expect(both).toContain('id "hero-2" with placement {"eastMeters":20,"northMeters":8,"headingDeg":90}');
        // A studio void object changes through its spec alone.
        const studio = activeObjectBuildContext({ objects: [hero('hero-3', { spec })], objectBuild: { spec } } as any);
        expect(studio).toContain('in a studio void');
        expect(studio).not.toContain('replaceObjectId');
        expect(userText({ prompt: 'make it taller', activeArtifact: PLAIN_SCENE as any })).not.toContain('Active object build');
    });

    it('names one tool for each kind of request and leaves geocoding to the tools', () => {
        expect(SPATIAL_INTENT_POLICY).toContain('not from particular words');
        expect(SPATIAL_INTENT_POLICY).toContain('One specific object or an abstract form');
        expect(SPATIAL_INTENT_POLICY).toMatch(/One specific object or an abstract form[^\n]*call build_3d_object_from_reference/);
        expect(SPATIAL_INTENT_POLICY).toMatch(/An imagined environment, a landscape, or a scene of several objects[^\n]*execute_3d_python_script/);
        expect(SPATIAL_INTENT_POLICY).toMatch(/A real-world place[^\n]*call google_3d_tiles_get_clay/);
        expect(SPATIAL_INTENT_POLICY).toContain('isolate: true');
        expect(SPATIAL_INTENT_POLICY).toMatch(/One object at a real-world place: call build_3d_object_from_reference with location[^\n]*placement/);
        expect(SPATIAL_INTENT_POLICY).toMatch(/Several objects at a real-world place: call build_3d_object_from_reference once per object, each with the same location and its own placement[^\n]*adds its object beside the objects already there/);
        expect(SPATIAL_INTENT_POLICY).toContain('Never supply coordinates from memory');
    });

    it('says a place comes back remeshed with its measured trees, clay first then its real textures, and reports only what the result contains', () => {
        // google_3d_tiles_get_clay remeshes the tiles and regrows the trees measured in them (trees defaults to true);
        // a tile with no measurable canopy has none, so the model reports the result rather than promising trees.
        expect(SPATIAL_INTENT_POLICY).toMatch(/A real-world place[^\n]*remeshed, with the trees measured in the tiles regrown in place as SB-Veggie trees; the clay massing shows first and the viewport crossfades to the real textures on its own/);
        expect(SPATIAL_INTENT_POLICY).toContain('pass trees: false only when the user asks for no trees');
        // textured by default, clay on request; the follow-ups offer a clay view and material refinement, not "add textures"
        expect(SPATIAL_INTENT_POLICY).toContain('New objects and places are textured by default');
        expect(SPATIAL_INTENT_POLICY).toContain('Use studio grey clay only when the user asks for it');
        expect(SPATIAL_INTENT_POLICY).toMatch(/views and material refinement \(a clay view for reviewing the shape/);
        expect(SPATIAL_INTENT_POLICY).not.toMatch(/start in studio grey clay/);
        expect(SPATIAL_INTENT_POLICY).toContain('tell the user the address it resolved and what its result says it contains');
    });

    it('scopes the object tool to one object and points scenes and places elsewhere', () => {
        const description = OBJECT_REFERENCE_TOOL_DECLARATIONS[0].description;
        expect(description).not.toContain('anything to build that is not a real-world place');
        expect(description).toContain('Build one specific object or an abstract form');
        expect(description).toMatch(/imagined environment, a landscape or several objects with no real place, write a script for execute_3d_python_script/);
        expect(description).toContain('for a real place alone, use google_3d_tiles_get_clay');
        expect(description).toContain('Several objects at one real place take one call each with the same location');
        const params = OBJECT_REFERENCE_TOOL_DECLARATIONS[0].parameters!.properties!;
        expect(params.placement.required).toEqual(['eastMeters', 'northMeters', 'headingDeg']);
        // The model says when an object joins the place the active scene already shows; nothing guesses it from names.
        expect(params.addToActiveScene.type).toBe('BOOLEAN');
        expect(description).toContain('pass addToActiveScene: true to add it there without staging the place again');
        expect(description).toContain('a build that would pass through a crown, a trunk, another object or a wall of the tiles fails with its spec and the nearest spots where it fits');
        expect(SPATIAL_INTENT_POLICY).toMatch(/One object at a real-world place:[^\n]*When the active scene already shows that place[^\n]*pass addToActiveScene: true/);
    });

    it('sends objects at a place on an active scene to the reference builder with a placement', () => {
        const text = userText({ prompt: 'put a bench here', activeArtifact: PLAIN_SCENE as any });
        expect(text).toContain('To build an object at a place, call build_3d_object_from_reference with location and placement.');
        expect(text).toContain('except an object at the real place this scene shows: build_3d_object_from_reference with that location, a placement and addToActiveScene: true adds it to this scene (no new staging).');
        expect(text).not.toContain('execute_3d_python_script({ location');
        // A plinth goes under an object through the tool that built it; a mesh neither tool built is said to be out of
        // reach instead of being swapped for a script's own geometry (each script run opens a new scene).
        expect(text).toContain('When a script built the scene (its pythonGenerator holds the script), write one script that builds that geometry again from the script plus the plinth');
        expect(text).toContain('Neither tool can load a mesh it did not build (an imported, scanned or generated model): say so instead of rebuilding a different object.');
        expect(text).not.toContain('set the hero asset on it with sb.layout');
    });
});

describe('sb script guide', () => {
    it('is not in the system instruction of an unrelated or a fresh 3D request', async () => {
        for (const mode of ['agent', 'studio', undefined]) {
            for (const prompt of ['refactor the login handler', 'a misty alien canyon with stone arches']) {
                const system = await buildSystemInstruction({ prompt, mode } as GeminiGenerateRequest);
                expect(system, `${mode}: ${prompt}`).not.toContain(SB_PYTHON_SCRIPT_GUIDE);
                expect(system).toContain('read_sb_script_guide');
            }
        }
    });

    it('is included while a script-built scene is active, decided from the scene and not the words', async () => {
        expect(scriptingInPlay({ activeArtifact: SCRIPT_SCENE as any })).toBe(true);
        expect(scriptingInPlay({ activeArtifact: PLAIN_SCENE as any })).toBe(false);
        expect(scriptingInPlay({ activeArtifact: undefined })).toBe(false);
        const scripted = await buildSystemInstruction({ prompt: 'ok', mode: 'agent', activeArtifact: SCRIPT_SCENE } as any);
        const plain = await buildSystemInstruction({ prompt: 'write an sb python script', mode: 'agent', activeArtifact: PLAIN_SCENE } as any);
        expect(scripted).toContain(SB_PYTHON_SCRIPT_GUIDE);
        expect(plain).not.toContain(SB_PYTHON_SCRIPT_GUIDE);
        const plan = await buildSystemInstruction({ prompt: 'ok', mode: 'plan', activeArtifact: SCRIPT_SCENE } as any);
        expect(plan).not.toContain(SB_PYTHON_SCRIPT_GUIDE);
    });

    it('is left out for an object build\'s scene, whose script is generated from its spec', async () => {
        // build_3d_object_from_reference keeps the script it ran, but the object changes through specJson.
        const objectScene = {
            id: 'o', type: '3d-scene', title: 'Vase',
            data: { title: 'Vase', objectBuild: { spec: { subject: 'vase', parts: [] } }, pythonGenerator: { sourceCode: 'import scratchbox as sb\nsb.object_spec.build(SPEC)\n' } }
        };
        expect(scriptingInPlay({ activeArtifact: objectScene as any })).toBe(false);
        const followUp = await buildSystemInstruction({ prompt: 'make it taller', mode: 'agent', activeArtifact: objectScene } as any);
        const unrelated = await buildSystemInstruction({ prompt: 'refactor the login handler', mode: 'agent' } as GeminiGenerateRequest);
        expect(followUp).not.toContain(SB_PYTHON_SCRIPT_GUIDE);
        expect(followUp.length).toBe(unrelated.length);
    });

    it('keeps the unrelated agent instruction at least the guide\'s size smaller than before', async () => {
        const unrelated = await buildSystemInstruction({ prompt: 'refactor the login handler', mode: 'agent' } as GeminiGenerateRequest);
        const scripted = await buildSystemInstruction({ prompt: 'refactor the login handler', mode: 'agent', activeArtifact: SCRIPT_SCENE } as any);
        expect(SB_PYTHON_SCRIPT_GUIDE.length).toBeGreaterThan(14_000);
        expect(scripted.length - unrelated.length).toBeGreaterThanOrEqual(SB_PYTHON_SCRIPT_GUIDE.length);
        expect(unrelated.length).toBeLessThan(50_000);
    });

    it('is served by read_sb_script_guide, offered next to execute_3d_python_script', async () => {
        expect(SB_SCRIPT_GUIDE_TOOL_DECLARATIONS[0].name).toBe('read_sb_script_guide');
        const out = await sbScriptGuideHandlers.read_sb_script_guide({}, {} as any);
        expect((out as any).resultPayload.guide).toBe(SB_PYTHON_SCRIPT_GUIDE.trim());
        expect(SB_PYTHON_SCRIPT_GUIDE).toContain('Pattern 1');
        expect(SB_PYTHON_SCRIPT_GUIDE).not.toContain('Pattern 3');
        expect(CORE_WORKSPACE_PACK.toolNames).toEqual(expect.arrayContaining(['read_sb_script_guide', 'execute_3d_python_script']));
        const registry = createDefaultToolRegistry();
        expect(registry.declarations(['workspace']).some(d => d.name === 'read_sb_script_guide')).toBe(true);
    });
});
