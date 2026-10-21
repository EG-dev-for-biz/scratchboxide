/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { availableToolNames } from '../src/node/gemini/tool-catalog';
import { TaskCapabilityResolver } from '../src/node/agent/task-capability-resolver';
import { describe, it, expect, beforeEach } from 'vitest';
import {
    createDefaultToolRegistry,
    buildToolDeclarations,
    resolveDomainToolPacks,
    coerceToolArguments,
    ALL_TOOL_PACKS,
    CORE_WORKSPACE_PACK,
    GEOSPATIAL_3D_PACK,
    VFX_VIDEO_PACK,
    MESH_SURFACE_PACK,
    type ToolRegistry,
    type ToolDeclaration
} from '../src/node/gemini/tool-registry';
import type { GeminiGenerateRequest } from '../src/common/gemini-protocol';

describe('Domain Tool Packs, Capability Resolution & Argument Coercion', () => {
    let registry: ToolRegistry;

    beforeEach(() => {
        registry = createDefaultToolRegistry();
    });

    describe('1. Domain Tool Packs Definitions', () => {
        it('exports structured packs covering all domains', () => {
            expect(ALL_TOOL_PACKS.core_workspace).toBeDefined();
            expect(ALL_TOOL_PACKS.geospatial_3d).toBeDefined();
            expect(ALL_TOOL_PACKS.mesh_surface).toBeDefined();
            expect(ALL_TOOL_PACKS.vfx_video).toBeDefined();
            expect((ALL_TOOL_PACKS as Record<string, unknown>).comfyui).toBeUndefined();
            expect(ALL_TOOL_PACKS.lens).toBeDefined();
            expect(ALL_TOOL_PACKS.browser).toBeDefined();

            expect(CORE_WORKSPACE_PACK.toolNames).toContain('workspace_read_file');
            expect(CORE_WORKSPACE_PACK.toolNames).toContain('mount_canvas_primitive');
            expect(GEOSPATIAL_3D_PACK.toolNames).toContain('google_3d_tiles_get_clay');
            expect(GEOSPATIAL_3D_PACK.toolNames).toContain('utdra_probe_tile');
            expect(MESH_SURFACE_PACK.toolNames).toContain('mesh_apply_deformers');
            expect(MESH_SURFACE_PACK.toolNames).toContain('algorithmic_uv_unwrap_rewrap');
            expect(VFX_VIDEO_PACK.toolNames).toContain('vfx_visual_critic_audit');
            expect(VFX_VIDEO_PACK.toolNames).toContain('optics_configure_lens_distortion');
        });

        it('declarationsForPacks returns bounded, sanitized declarations without cross-domain pollution', () => {
            const vfxDecls = registry.declarationsForPacks(['vfx_video']);
            const vfxNames = vfxDecls.map(d => d.name);

            expect(vfxNames).toContain('vfx_visual_critic_audit');
            expect(vfxNames).toContain('optics_configure_lens_distortion');
            // Must NOT contain unrelated tools from other packs
            expect(vfxNames).not.toContain('browser_navigate');
            expect(vfxNames).not.toContain('lens_project');
        });
    });

    describe('2. Intent-Driven Pre-Flight Capability Resolution (resolveDomainToolPacks)', () => {
        it('selects packs from the request\'s switches only, never from words in the prompt (ADA 1.2)', () => {
            const prompts = [
                'Create a stone Roman aqueduct with water arches and colonnades',
                'Calibrate optical camera lens distortion Brown-Conrady and matchmove video timeline',
                'Spin up Trellis neural diffusion image-to-3d pipeline on a GPU',
                'browse to localhost and project it via lens'
            ];
            for (const prompt of prompts) {
                const res = resolveDomainToolPacks({ prompt });
                expect(res.packs).toEqual(['core_workspace', 'geospatial_3d', 'mesh_surface', 'vfx_video']);
                expect((res as any).capabilityResolution).toBeUndefined();
            }
            expect(resolveDomainToolPacks({ prompt: 'x', enableWorkspaceTools: false }).packs).toEqual([]);
            expect(resolveDomainToolPacks({ prompt: 'x', enableLensTools: true, enableBrowserTools: true }).packs).toEqual(['core_workspace', 'geospatial_3d', 'mesh_surface', 'vfx_video', 'lens', 'browser']);
        });

        it('still reports domains and unsupported tasks through the capability resolver (used by the capability routes)', () => {
            expect(TaskCapabilityResolver.resolveTaskCapability('Create a stone Roman aqueduct with water arches and colonnades').taskDomain).toBe('3d');
            expect(TaskCapabilityResolver.resolveTaskCapability('Calibrate optical camera lens distortion Brown-Conrady and matchmove video timeline').taskDomain).toBe('vfx');
            expect(TaskCapabilityResolver.resolveTaskCapability('Spin up Trellis neural diffusion image-to-3d pipeline on a GPU').canSolveNatively).toBe(false);
        });

        it('honors explicitly requested tool packs', () => {
            const res = resolveDomainToolPacks({
                prompt: 'Do something generic',
                requestedPacks: ['geospatial_3d', 'vfx_video']
            });

            expect(res.packs).toEqual(['geospatial_3d', 'vfx_video']);
        });

        it('includes all workspace domain packs when enableWorkspaceTools is explicitly true', () => {
            const res = resolveDomainToolPacks({
                prompt: 'Inspect workspace',
                enableWorkspaceTools: true
            });

            expect(res.packs).toContain('core_workspace');
            expect(res.packs).toContain('geospatial_3d');
            expect(res.packs).toContain('mesh_surface');
            expect(res.packs).toContain('vfx_video');
        });
    });

    describe('3. Defensive Parameter Coercion (coerceToolArguments)', () => {
        const dummyDecl: ToolDeclaration = {
            name: 'test_tool',
            description: 'Test Tool',
            parameters: {
                type: 'OBJECT',
                properties: {
                    count: { type: 'INTEGER' },
                    ratio: { type: 'NUMBER' },
                    isActive: { type: 'BOOLEAN' },
                    config: { type: 'OBJECT', properties: { nested: { type: 'STRING' } } },
                    items: { type: 'ARRAY', items: { type: 'STRING' } },
                    unspecifiedObj: { type: 'OBJECT' }
                }
            }
        };

        it('coerces stringified JSON objects and arrays', () => {
            const raw = {
                config: '{"nested": "hello_world"}',
                items: '["apple", "banana"]',
                unspecifiedObj: '{"mode": "fast"}'
            };

            const coerced = coerceToolArguments(dummyDecl, raw);
            expect(coerced.config).toEqual({ nested: 'hello_world' });
            expect(coerced.items).toEqual(['apple', 'banana']);
            expect(coerced.unspecifiedObj).toEqual({ mode: 'fast' });
        });

        it('coerces stringified numbers and floats', () => {
            const raw = {
                count: '42',
                ratio: '3.14159'
            };

            const coerced = coerceToolArguments(dummyDecl, raw);
            expect(coerced.count).toBe(42);
            expect(coerced.ratio).toBeCloseTo(3.14159);
        });

        it('coerces stringified booleans', () => {
            const rawTrue = { isActive: 'true' };
            const rawFalse = { isActive: 'false' };

            expect(coerceToolArguments(dummyDecl, rawTrue).isActive).toBe(true);
            expect(coerceToolArguments(dummyDecl, rawFalse).isActive).toBe(false);
        });

        it('coerces comma-delimited strings to string arrays when schema specifies ARRAY', () => {
            const raw = { items: 'alpha, beta, gamma' };
            const coerced = coerceToolArguments(dummyDecl, raw);
            expect(coerced.items).toEqual(['alpha', 'beta', 'gamma']);
        });

        it('preserves native numbers, booleans, and objects intact', () => {
            const raw = {
                count: 100,
                ratio: 0.5,
                isActive: true,
                config: { nested: 'ok' },
                items: ['x', 'y']
            };

            const coerced = coerceToolArguments(dummyDecl, raw);
            expect(coerced).toEqual(raw);
        });
    });

    describe('4. ToolRegistry Dispatch Defense & Sanitization', () => {
        it('automatically coerces arguments during registry.dispatch', async () => {
            let receivedArgs: any = null;

            registry.register('test_param_tool', {
                name: 'test_param_tool',
                description: 'Tests parameter coercion',
                parameters: {
                    type: 'OBJECT',
                    properties: {
                        limit: { type: 'INTEGER' },
                        flag: { type: 'BOOLEAN' },
                        data: { type: 'OBJECT' }
                    }
                }
            }, async (args) => {
                receivedArgs = args;
                return { status: 'completed', resultPayload: { success: true } };
            }, 'workspace');

            const res = await registry.dispatch('test_param_tool', {
                limit: '50',
                flag: 'true',
                data: '{"key": "value"}'
            }, {} as any);

            expect(res.exec.status).toBe('completed');
            expect(receivedArgs.limit).toBe(50);
            expect(receivedArgs.flag).toBe(true);
            expect(receivedArgs.data).toEqual({ key: 'value' });
        });

        it('fails with actionable error payload on unknown browser tools instead of noop fake success', async () => {
            const res = await registry.dispatch('browser_unknown_action', { foo: 'bar' }, {} as any);

            expect(res.exec.status).toBe('failed');
            expect(res.resultPayload).toEqual({
                status: 'failed',
                error: 'Unknown browser tool: browser_unknown_action'
            });
        });
    });

    describe('5. buildToolDeclarations Dynamic Pack Activation', () => {
        it('activates focused tool packs when request.toolPacks is provided', () => {
            const req: GeminiGenerateRequest = {
                prompt: 'Process video clip with VFX',
                toolPacks: ['vfx_video']
            };

            const configs = buildToolDeclarations(req, registry);
            expect(configs).toBeDefined();

            const fnConfig = configs!.find(c => 'functionDeclarations' in c) as any;
            expect(fnConfig).toBeDefined();

            const names = fnConfig.functionDeclarations.map((d: any) => d.name);
            expect(names).toContain('vfx_visual_critic_audit');
            expect(names).toContain('optics_configure_lens_distortion');
            // Must NOT include unrelated browser or lens tools
            expect(names).not.toContain('browser_navigate');
            expect(names).not.toContain('lens_project');
        });

        it('activates 3D and workspace tools for novel 3D prompts not containing legacy keywords', () => {
            const req: GeminiGenerateRequest = {
                prompt: 'Create a stone Roman aqueduct with water arches and colonnades'
            };

            const configs = buildToolDeclarations(req, registry);
            expect(configs).toBeDefined();

            const fnConfig = configs!.find(c => 'functionDeclarations' in c) as any;
            expect(fnConfig).toBeDefined();

            // Declared up front or loadable by name through load_tools (tool-catalog.ts).
            const names = availableToolNames(configs).all;
            expect(names).toContain('mount_canvas_primitive');
            expect(names).toContain('google_3d_tiles_get_clay');
            expect(names).toContain('mesh_apply_deformers');
        });

        it('satisfies the ADA Alien Planet Test for unpredicted alien and architectural biomes without noun dictionaries', () => {
            const alienPrompts = [
                'Construct a subterranean hyperloop terminal with ferroconcrete caissons',
                'Forge a crystalline orbital tether station on Titan',
                'Model a bioluminescent geothermal cavern with liquid methane rivers',
                'Build an ancient stepped ziggurat with obsidian basalt obelisks'
            ];

            for (const prompt of alienPrompts) {
                const res = resolveDomainToolPacks({ prompt });
                expect(res.packs).toContain('geospatial_3d');
                expect(res.packs).toContain('mesh_surface');
                expect(res.packs).toContain('core_workspace');

                const req: GeminiGenerateRequest = { prompt };
                const configs = buildToolDeclarations(req, registry);
                expect(configs).toBeDefined();
                const fnConfig = configs!.find(c => 'functionDeclarations' in c) as any;
                const toolNames = fnConfig.functionDeclarations.map((d: any) => d.name);
                expect(toolNames).toContain('mount_canvas_primitive');
            }
        });
    });
});

describe('coerceToolArguments unwraps arguments nested under a wrapper key', () => {
    const decl: ToolDeclaration = {
        name: 'execute_3d_python_script',
        description: 'Runs a script',
        parameters: { type: 'OBJECT', properties: { script: { type: 'STRING' }, description: { type: 'STRING' } }, required: ['script'] }
    } as ToolDeclaration;

    it('lifts { parameters: { script } } as Gemini sent it, letting nested values win', () => {
        const args = coerceToolArguments(decl, {
            description: 'Universal 3D scene execution bus...',
            parameters: { description: 'A wooden stool', script: 'import scratchbox as sb' }
        });
        expect(args).toEqual({ description: 'A wooden stool', script: 'import scratchbox as sb' });
    });

    it('accepts a JSON-string wrapper and leaves ordinary or declared-wrapper calls alone', () => {
        expect(coerceToolArguments(decl, { arguments: '{"script":"x"}' })).toEqual({ script: 'x' });
        expect(coerceToolArguments(decl, { script: 'y' })).toEqual({ script: 'y' });
        const withDeclaredWrapper = { ...decl, parameters: { type: 'OBJECT', properties: { parameters: { type: 'OBJECT' } } } } as ToolDeclaration;
        expect(coerceToolArguments(withDeclaredWrapper, { parameters: { script: 'z' } })).toEqual({ parameters: { script: 'z' } });
    });
});
