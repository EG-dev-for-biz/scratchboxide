/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The deep-write bundle holds what the pipeline produced. It used to mount a keyword template 3D scene picked from
 * the project name (synthesizeContextual3DScene) and, when the name matched /tool|studio|blocking|pre-viz|editor/ or
 * no files were written, a template tool app (synthesizeVibeToolSandbox).
 */
import { describe, expect, it } from 'vitest';
import { PrimitiveSynthesizer } from '../src/node/deep-write/primitive-synthesizer';
import { DynamicDagPlanner } from '../src/node/deep-write/dynamic-dag-planner';
import { GeminiService } from '../src/node/gemini-service';
import type { DiscoveredGoalPlan } from '../src/common/deep-write/deep-write-protocol';

const plan = (primitives: string[]): DiscoveredGoalPlan => ({
    goal: 'Plan a drone inspection studio',
    domains: ['robotics'],
    stages: [{ id: 's1', name: 'Survey', description: 'Survey the site', assignedAgentRole: 'planner', isCheckpoint: false }],
    deliverables: { primitives, filePaths: ['src/main.ts'], config: { platforms: ['web'], toolchain: 'vite' } }
} as any);

describe('deep-write bundle', () => {
    it('makes no template scene or app for a name like "drone inspection studio" and says what it did not make', () => {
        const bundle = new PrimitiveSynthesizer().synthesizeBundle('Drone Inspection Studio', plan(['markdown-document', '3d-scene', 'live-code-sandbox']), {}, {});
        expect(bundle.artifacts.map(a => a.type)).toEqual(['markdown-document']);
        expect(bundle.summary).toBe('Deliverables for the goal "Plan a drone inspection studio". Not made: a 3D scene (the pipeline produced no scene geometry); a runtime sandbox (the pipeline wrote no files).');
    });

    it('shows the files the pipeline wrote, whatever the project is called', () => {
        const files = { 'src/main.ts': 'export const x = 1;', 'shaders/blur.wgsl': '@fragment fn main() {}' };
        const bundle = new PrimitiveSynthesizer().synthesizeBundle('Blocking Tool Editor', plan(['live-code-sandbox']), {}, files);
        expect(bundle.artifacts).toHaveLength(1);
        const sandbox = bundle.artifacts[0].data;
        expect(sandbox.files.map((f: any) => [f.path, f.language, f.content])).toEqual([
            ['src/main.ts', 'typescript', 'export const x = 1;'],
            ['shaders/blur.wgsl', 'wgsl', '@fragment fn main() {}']
        ]);
        expect(sandbox.viewMode).toBe('code');
        expect(bundle.summary).not.toContain('Not made');
    });

    it('the spec table invents no role for each file', () => {
        const bundle = new PrimitiveSynthesizer().synthesizeBundle('X', plan(['markdown-document']), {}, {});
        const table = bundle.artifacts[0].data.sections.find((s: any) => s.type === 'table');
        expect(table.tableHeaders).toEqual(['File', 'Build Platform', 'Toolchain']);
        expect(JSON.stringify(table)).not.toContain('Core controller logic');
    });
});

describe('deep-write stages', () => {
    const stage = plan(['markdown-document']).stages[0];
    /** A planner whose model replies with `reply` (no network). */
    const plannerReplying = (reply: string) => new DynamicDagPlanner({
        streamGenerate: async (_req: unknown, onEvent: (e: { text?: string }) => void) => { onEvent({ text: reply }); }
    } as any);

    it('a stage with no model connected fails instead of reporting a "deterministic fallback" as done', async () => {
        const res = await new DynamicDagPlanner().executeStage(plan(['markdown-document']), stage, {});
        expect(res.success).toBe(false);
        expect(res.error).toBe('Stage "Survey" was not run: no model service is connected to the planner.');
        expect(JSON.stringify(res)).not.toContain('Deterministic fallback');
    });

    it('a reply that is not the stage JSON fails the stage; the stage JSON is its output', async () => {
        const prose = await plannerReplying('I surveyed the site and everything looks fine.').executeStage(plan(['markdown-document']), stage, {});
        expect(prose.success).toBe(false);
        expect(prose.output.files).toBeUndefined();
        expect(prose.error).toMatch(/^Stage "Survey" did not return its stage JSON \(.+\); the reply began: I surveyed the site/);

        const json = await plannerReplying('{"description":"Surveyed","content":"# Site","files":{"src/main.ts":"export {};"}}').executeStage(plan(['markdown-document']), stage, {});
        expect(json).toEqual({ success: true, output: { description: 'Surveyed', content: '# Site', files: { 'src/main.ts': 'export {};' } } });
    });

    it('the keyword-themed 3D planner (template C++ scene per theme word) is gone from the planner and the facade', () => {
        for (const name of ['generate3DPlanDAG', 'executeAutonomous3DWorkflow', 'execute3DStageWithVerification', 'inspectAndReasonScene']) {
            expect((DynamicDagPlanner.prototype as any)[name]).toBeUndefined();
        }
        for (const name of ['generate3DPlanDAG', 'plan3DAutonomousWorkflow']) {
            expect((GeminiService.prototype as any)[name]).toBeUndefined();
        }
    });
});

