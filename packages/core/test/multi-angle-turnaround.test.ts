/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { MultiAngleTurnaroundService } from '../src/node/spatial/MultiAngleTurnaroundService';
import { GoogleMediaCredentialsService } from '../src/node/google-media-credentials-service';
import { MediaModelUnavailableError, MissingInputError } from '../src/common/errors/pipeline-errors';
import { encodePng } from '../src/node/texture-processing';

/**
 * A fake Gen AI image client (no network): answers each call with a distinct small PNG and records the model,
 * the prompt and how many reference images came with it. Models outside `served` answer 404.
 */
function fakeTurnaroundClient(served = ['gemini-3.1-flash-lite-image', 'gemini-3.1-flash-image']) {
    const calls: Array<{ model: string; prompt: string; referenceCount: number }> = [];
    const images: Buffer[] = [];
    const client: any = {
        models: {
            generateContent: async ({ model, contents }: { model: string; contents: any[] }) => {
                calls.push({ model, prompt: contents[0]?.text || '', referenceCount: contents.filter(c => c.inlineData).length });
                if (!served.includes(model)) {
                    throw Object.assign(new Error(`models/${model} is not found`), { status: 404 });
                }
                const png = encodePng(8, 8, Buffer.alloc(8 * 8 * 4, 40 + images.length * 30));
                images.push(png);
                return { candidates: [{ content: { parts: [{ inlineData: { data: png.toString('base64'), mimeType: 'image/png' } }] } }] };
            }
        }
    };
    return { client, calls, images };
}
import {
    TURNAROUND_TOOL_DECLARATIONS,
    turnaroundHandlers
} from '../src/node/gemini/tools/turnaround-tools';
import { DEFAULT_TOOL_DECLARATIONS, DEFAULT_TOOL_HANDLERS } from '../src/node/gemini/tools';
import { MESH_SURFACE_PACK } from '../src/node/gemini/domain-tool-packs';
import { inferToolGroup } from '../src/node/gemini/tool-registry';

describe('Multi-Angle Turnaround Service & Rig Engine', () => {
    describe('Spherical Camera Rig Geometry & Coordinate Mathematics', () => {
        it('computes 4 canonical orthographic stations for dcc-ortho-4', () => {
            const stations = MultiAngleTurnaroundService.computeStations('dcc-ortho-4', undefined, 2.0);
            expect(stations).toHaveLength(4);

            // Station 0: Iso (azimuth 45, elevation 30)
            expect(stations[0].label).toBe('iso');
            expect(stations[0].azimuthDeg).toBe(45);
            expect(stations[0].elevationDeg).toBe(30);
            expect(stations[0].referenceStationIndices).toEqual([]);

            // Station 1: Side (azimuth 90, elevation 0)
            expect(stations[1].label).toBe('side');
            expect(stations[1].azimuthDeg).toBe(90);
            expect(stations[1].elevationDeg).toBe(0);
            expect(stations[1].referenceStationIndices).toEqual([0]);

            // Station 2: Front (azimuth 0, elevation 0)
            expect(stations[2].label).toBe('front');
            expect(stations[2].azimuthDeg).toBe(0);
            expect(stations[2].elevationDeg).toBe(0);
            expect(stations[2].referenceStationIndices).toEqual([0, 1]);

            // Station 3: Rear (azimuth 180, elevation 0)
            expect(stations[3].label).toBe('rear');
            expect(stations[3].azimuthDeg).toBe(180);
            expect(stations[3].referenceStationIndices).toEqual([0, 2]);
        });

        it('computes 8 equidistant stations for turntable-8 with dual-anchor chaining', () => {
            const stations = MultiAngleTurnaroundService.computeStations('turntable-8', undefined, 3.0);
            expect(stations).toHaveLength(8);

            for (let i = 0; i < stations.length; i++) {
                expect(stations[i].azimuthDeg).toBe(i * 45);
                expect(stations[i].elevationDeg).toBe(15);
                if (i === 0) {
                    expect(stations[i].referenceStationIndices).toEqual([]);
                } else if (i === 1) {
                    expect(stations[i].referenceStationIndices).toEqual([0]);
                } else {
                    expect(stations[i].referenceStationIndices).toEqual([0, i - 1]);
                }
            }
        });

        it('computes custom user-defined camera trajectories', () => {
            const custom = [
                { azimuthDeg: 12, elevationDeg: 5, label: 'custom_1' },
                { azimuthDeg: 88, elevationDeg: -10, label: 'custom_2' }
            ];
            const stations = MultiAngleTurnaroundService.computeStations('custom', custom, 1.5);
            expect(stations).toHaveLength(2);
            expect(stations[0].label).toBe('custom_1');
            expect(stations[1].label).toBe('custom_2');
        });
    });

    describe('ADA Prompt Synthesis & Isolation Invariant Enforcements', () => {
        it('synthesizes prompts strictly suppressing ground, cast shadows, and text', () => {
            const stations = MultiAngleTurnaroundService.computeStations('dcc-ortho-4');
            const { positive, negative } = MultiAngleTurnaroundService.buildPrompt(
                'crumpled titanium dropship fuselage',
                stations[0],
                '18-percent-studio-clay',
                { floatingVoid: true, suppressShadows: true, suppressText: true }
            );

            // Positive prompt must enforce floating void, diffuse ambient light, and zero text
            expect(positive).toContain('crumpled titanium dropship fuselage');
            expect(positive).toContain('18 percent neutral studio grey clay');
            expect(positive).toContain('floating freely in the center of an infinite, pure solid white void');
            expect(positive).toContain('No ground plane, no floor, no pedestal');
            expect(positive).toContain('Completely shadow-free, zero cast shadows');
            expect(positive).toContain('No text, no letters, no typography');

            // Negative prompt must contain ground and shadow suppression tokens
            expect(negative).toContain('ground');
            expect(negative).toContain('pedestal');
            expect(negative).toContain('shadow');
            expect(negative).toContain('watermark');
        });

        it('injects reference conditioning prefix for sequential stations', () => {
            const stations = MultiAngleTurnaroundService.computeStations('dcc-ortho-4');
            const { positive: pos1 } = MultiAngleTurnaroundService.buildPrompt('mech arm', stations[1]);
            expect(pos1).toContain('Exact same 3D digital sculpt maquette shown in the reference image(s)');
        });
    });

    describe('End-to-End Execution', () => {
        it('chained: generates every view with the image model, conditioning each on the hero and previous views', async () => {
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-turnaround-'));
            const fake = fakeTurnaroundClient();
            const service = new MultiAngleTurnaroundService({ createClient: async () => fake.client });

            const result = await service.execute({
                conditioning: 'chained',
                subject: 'weathered post-apocalyptic buggy',
                rigPreset: 'dcc-ortho-4',
                stylePreset: '18-percent-studio-clay',
                outputDir: tmpDir,
                downstreamTarget: 'none',
                metricDimensions: { lengthMeters: 4.2, heightMeters: 1.6, widthMeters: 2.1 }
            });

            expect(result.success).toBe(true);
            expect(result.conditioning).toBe('chained');
            expect(result.views).toHaveLength(4);
            expect(result.downstreamGlb).toBeUndefined();
            expect(result.modelUsed).toBe('gemini-3.1-flash-lite-image');
            expect(result.modelNote).toBe('Generated with gemini-3.1-flash-lite-image.');
            // Station 0 from text only; station 1 with the hero view; stations 2 and 3 with hero + previous.
            expect(fake.calls.map(c => c.referenceCount)).toEqual([0, 1, 2, 2]);
            expect(fake.calls[0].prompt).toContain('weathered post-apocalyptic buggy');
            expect(fake.calls[0].prompt).toContain('Avoid:');
            for (const [i, view] of result.views.entries()) {
                // Each file holds the model's answer for that station, not a placeholder header.
                expect(fs.readFileSync(view.imagePath).equals(fake.images[i])).toBe(true);
                expect(view.generatedBy).toBe('gemini-3.1-flash-lite-image');
            }

            await fs.promises.rm(tmpDir, { recursive: true, force: true });
        });

        it('hero-parallel (default): the hero first, then every other view at once conditioned on the hero only; a Stop ends them all', async () => {
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-turnaround-par-'));
            let inFlight = 0, maxInFlight = 0, aborted = 0;
            const order: string[] = [];
            const refs: number[] = [];
            const png = encodePng(8, 8, Buffer.alloc(8 * 8 * 4, 90));
            const delayMs = 150;
            const client: any = {
                models: {
                    generateContent: ({ contents, config }: any) => new Promise((resolve, reject) => {
                        const label = String(contents[0].text).match(/Viewed from ([^.]+)/)?.[1] ?? '?';
                        refs.push(contents.filter((c: any) => c.inlineData).length);
                        order.push(`start ${label}`);
                        inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
                        const ms = (config?.abortSignal as AbortSignal | undefined) && stopAfterHero ? (refs.length === 1 ? 10 : 10_000) : delayMs;
                        let settled = false;
                        const timer = setTimeout(() => { settled = true; inFlight--; order.push(`end ${label}`); resolve({ candidates: [{ content: { parts: [{ inlineData: { data: png.toString('base64'), mimeType: 'image/png' } }] } }] }); }, ms);
                        config?.abortSignal?.addEventListener('abort', () => { if (settled) return; settled = true; clearTimeout(timer); inFlight--; aborted++; reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); }, { once: true });
                    })
                }
            };
            let stopAfterHero = false;
            const service = new MultiAngleTurnaroundService({ createClient: async () => client });
            const t0 = Date.now();
            const result = await service.execute({ subject: 'brass orrery', rigPreset: 'turntable-8', outputDir: tmpDir, signal: new AbortController().signal });
            const wall = Date.now() - t0;
            expect(result.conditioning).toBe('hero-parallel');
            expect(result.views.map(v => v.stationIndex)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
            expect(refs).toEqual([0, 1, 1, 1, 1, 1, 1, 1]);
            expect(order[0]).toMatch(/^start/);
            expect(order[1]).toMatch(/^end/);       // the hero finished before any other view started
            expect(maxInFlight).toBe(7);
            expect(wall).toBeLessThan(4 * delayMs); // chained: 8 x delayMs

            // Stop while the seven views are in flight: every one is cancelled.
            stopAfterHero = true; refs.length = 0; aborted = 0;
            const ctl = new AbortController();
            const p = service.execute({ subject: 'brass orrery', rigPreset: 'turntable-8', outputDir: tmpDir, signal: ctl.signal });
            setTimeout(() => ctl.abort(), 150);
            await expect(p).rejects.toThrow();
            expect(refs).toHaveLength(8);
            expect(aborted).toBe(7);
            expect(inFlight).toBe(0);
            await fs.promises.rm(tmpDir, { recursive: true, force: true });
        });

        it('fails instead of writing placeholder views when no image model can be reached', async () => {
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-turnaround-nocreds-'));
            const service = new MultiAngleTurnaroundService({ createClient: async () => { throw new Error('Google media credentials are not configured'); } });
            await expect(service.execute({ subject: 'drone', outputDir: tmpDir })).rejects.toBeInstanceOf(MediaModelUnavailableError);
            expect(fs.readdirSync(tmpDir)).toEqual([]);
            await fs.promises.rm(tmpDir, { recursive: true, force: true });
        });

        it('walks the default list past an unserved Nano Banana Lite and says so; a named model is the only one tried', async () => {
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-turnaround-models-'));
            const fake = fakeTurnaroundClient(['gemini-3.1-flash-image']);
            const service = new MultiAngleTurnaroundService({ createClient: async () => fake.client });
            const result = await service.execute({ subject: 'drone', outputDir: tmpDir });
            expect(result.modelUsed).toBe('gemini-3.1-flash-image');
            expect(result.skippedModels.map(s => s.model)).toEqual(['gemini-3.1-flash-lite-image']);
            expect(result.modelNote).toContain('not the requested gemini-3.1-flash-lite-image');
            // After the first view, the rig stays on the model that answered.
            expect(fake.calls.map(c => c.model)).toEqual(['gemini-3.1-flash-lite-image', 'gemini-3.1-flash-image', 'gemini-3.1-flash-image', 'gemini-3.1-flash-image', 'gemini-3.1-flash-image']);

            const pinned = fakeTurnaroundClient(['gemini-3.1-flash-image']);
            const pinnedService = new MultiAngleTurnaroundService({ createClient: async () => pinned.client });
            await expect(pinnedService.execute({ subject: 'drone', outputDir: tmpDir, model: 'nano-banana-lite' })).rejects.toBeInstanceOf(MediaModelUnavailableError);
            expect(pinned.calls.map(c => c.model)).toEqual(['gemini-3.1-flash-lite-image']);
            await fs.promises.rm(tmpDir, { recursive: true, force: true });
        });

        it('rejects an unknown rig or an empty custom rig instead of using another rig', () => {
            expect(() => MultiAngleTurnaroundService.computeStations('orbit-99')).toThrow(MissingInputError);
            expect(() => MultiAngleTurnaroundService.computeStations('custom', [])).toThrow(MissingInputError);
        });

        it('uses a style it has no tuned wording for as written, instead of switching to clay', () => {
            const [station] = MultiAngleTurnaroundService.computeStations('dcc-ortho-4');
            const { positive } = MultiAngleTurnaroundService.buildPrompt('lantern', station, 'cel-shaded watercolor');
            expect(positive).toContain('rendered in this style: cel-shaded watercolor');
            expect(positive).not.toContain('grey clay');
        });
    });

    describe('Agent Tool Registration & Tool Pack Integration', () => {
        it('registers generate_multi_angle_turnaround in DEFAULT_TOOL_DECLARATIONS and handlers', () => {
            const tool = DEFAULT_TOOL_DECLARATIONS.find(t => t.name === 'generate_multi_angle_turnaround');
            expect(tool).toBeDefined();
            expect(tool?.parameters.required).toContain('subject');

            const handler = DEFAULT_TOOL_HANDLERS['generate_multi_angle_turnaround'];
            expect(typeof handler).toBe('function');
        });

        it('includes generate_multi_angle_turnaround in MESH_SURFACE_PACK', () => {
            expect(MESH_SURFACE_PACK.toolNames).toContain('generate_multi_angle_turnaround');
            const decl = MESH_SURFACE_PACK.declarations.find(d => d.name === 'generate_multi_angle_turnaround');
            expect(decl).toBeDefined();
        });

        it('infers tool group as workspace', () => {
            expect(inferToolGroup('generate_multi_angle_turnaround')).toBe('workspace');
        });

        it('executes tool handler via dispatch', async () => {
            const handler = turnaroundHandlers['generate_multi_angle_turnaround'];
            const fake = fakeTurnaroundClient();
            vi.spyOn(GoogleMediaCredentialsService.prototype, 'createClient').mockResolvedValue(fake.client);
            // Temp workspace root: the handler writes to <workspaceRoot>/output/turnarounds/<ts>.
            const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-turnaround-ws-'));
            let res;
            try {
                res = await handler(
                    {
                        subject: 'test sci-fi console',
                        rigPreset: 'dcc-ortho-4',
                        // not a tool parameter any more: the views are generated
                        mockExecution: true
                    },
                    { workspaceRoot, activeCanvasType: '3d-scene' }
                );
            } finally {
                vi.restoreAllMocks();
            }

            expect(res.summaryResult).toContain('Captured 4 views of "test sci-fi console"');
            expect(res.summaryResult).toContain('Generated with gemini-3.1-flash-lite-image.');
            expect((res.resultPayload as any).views).toHaveLength(4);
            expect((res.resultPayload as any).views[0].buffer).toBeUndefined();
            expect(fake.calls).toHaveLength(4);
            expect(Object.keys(TURNAROUND_TOOL_DECLARATIONS[0].parameters.properties || {})).not.toContain('mockExecution');

            // Clean up created output dir
            const outViews = (res.resultPayload as any).views;
            if (outViews && outViews.length > 0) {
                const parentDir = path.dirname(outViews[0].imagePath);
                await fs.promises.rm(parentDir, { recursive: true, force: true });
            }
            await fs.promises.rm(workspaceRoot, { recursive: true, force: true });
        });
    });
});
