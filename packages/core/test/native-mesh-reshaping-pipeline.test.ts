/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MissingInputError } from '../src/common/errors/pipeline-errors';
import {
    NativeMeshReshaperService,
    MeshReshapingService,
    type MeshDeformOperation
} from '../src/node/3d-engine/native-mesh-reshaper-service';
import {
    MESH_SHAPING_TOOL_DECLARATIONS,
    meshShapingHandlers
} from '../src/node/gemini/tools/mesh-shaping-tools';
import {
    resolveTaskCapability
} from '../src/node/agent/task-capability-resolver';
import {
    createOperatorEngine
} from '../src/browser/generative-canvas/services/direct-dispatch-operator-engine';

describe('Native Prompt-Driven Mesh Reshaping Pipeline (Tier 1)', () => {

    it('1. should parse natural language prompts into structured MeshDeformOperation pipelines', () => {
        // Taper and twist
        const prompt1 = 'Taper the top by 50% and twist 45 degrees around the Y axis';
        const ops1 = NativeMeshReshaperService.parsePromptToOperations(prompt1);
        expect(ops1.length).toBeGreaterThanOrEqual(2);
        
        const taperOp = ops1.find(o => o.type === 'taper');
        expect(taperOp).toBeDefined();
        expect(taperOp?.factor).toBeCloseTo(0.5, 2);

        const twistOp = ops1.find(o => o.type === 'twist');
        expect(twistOp).toBeDefined();
        expect(twistOp?.angle).toBeCloseTo(45.0, 1);

        // Bulge, squash, and bend
        const prompt2 = 'Bulge the waist by 0.4, squash by 0.7, and bend 30 degrees along X';
        const ops2 = NativeMeshReshaperService.parsePromptToOperations(prompt2);
        expect(ops2.some(o => o.type === 'bulge')).toBe(true);
        expect(ops2.some(o => o.type === 'squash')).toBe(true);
        expect(ops2.some(o => o.type === 'bend')).toBe(true);

        // Sculpt and weathering
        const prompt3 = 'Sculpt crease lines along the side and weather the surface with stone erosion';
        const ops3 = NativeMeshReshaperService.parsePromptToOperations(prompt3);
        expect(ops3.some(o => o.type === 'sculpt')).toBe(true);
        expect(ops3.some(o => o.type === 'weathering' || (o.type as string) === 'weather')).toBe(true);
    });

    it('2. should execute native C++20 reshaping pipeline on cylinder benchmark and produce valid GLB', async () => {
        const outGlb = path.join(process.cwd(), 'build', '3d-native', 'test_cylinder_reshaped.glb');
        if (fs.existsSync(outGlb)) {
            fs.unlinkSync(outGlb);
        }

        const result = await NativeMeshReshaperService.reshapeMesh({
            benchmark: 'cylinder',
            prompt: 'Taper the top to 30% width and twist 60 degrees',
            outputGlbPath: outGlb
        });

        expect(result.success).toBe(true);
        expect(result.glbPath).toBe(outGlb);
        expect(fs.existsSync(outGlb)).toBe(true);

        // Validate GLB magic header 0x46546C67 ('glTF')
        const buffer = fs.readFileSync(outGlb);
        expect(buffer.length).toBeGreaterThan(1000);
        const magic = buffer.readUInt32LE(0);
        expect(magic).toBe(0x46546C67);

        // Telemetry assertions
        expect(result.telemetry).toBeDefined();
        expect(result.telemetry.operationsApplied).toBeGreaterThanOrEqual(2);
        expect(result.telemetry.outputVertexCount).toBeGreaterThan(0);
        expect(result.telemetry.outputTriangleCount).toBeGreaterThan(0);
        expect(result.telemetry.executionTimeMs).toBeGreaterThan(0);
        expect(result.telemetry.cleanManifold).toBe(true);
    });

    it('3. should support explicit parametric operations via MeshReshapingService alias', async () => {
        const operations: MeshDeformOperation[] = [
            { type: 'taper', factor: 0.4, axis: 'y' },
            { type: 'twist', angle: 30, axis: 'y' },
            { type: 'bulge', factor: 0.25, axis: 'y' }
        ];

        const outGlb = path.join(process.cwd(), 'build', '3d-native', 'test_sculpture_parametric.glb');
        const result = await MeshReshapingService.reshapeMesh({
            benchmark: 'sculpture',
            operations,
            outputGlbPath: outGlb
        });

        expect(result.success).toBe(true);
        expect(result.telemetry.operationsApplied).toBe(3);
        expect(fs.existsSync(outGlb)).toBe(true);
    });

    it('4. should correctly dispatch Gemini agent tools mesh_reshape_via_prompt & mesh_apply_deformers on a given GLB', async () => {
        expect(MESH_SHAPING_TOOL_DECLARATIONS.length).toBeGreaterThanOrEqual(2);
        // Input mesh for the tools: the service writes its cylinder benchmark to a GLB file.
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-mesh-tools-'));
        const inputGlbPath = path.join(dir, 'cylinder.glb');
        await NativeMeshReshaperService.reshapeMesh({ benchmark: 'cylinder', operations: [{ type: 'taper', factor: 0.9, axis: 'y' }], outputGlbPath: inputGlbPath });
        expect(fs.existsSync(inputGlbPath)).toBe(true);

        try {
            // mesh_reshape_via_prompt
            const promptOutcome = await meshShapingHandlers.mesh_reshape_via_prompt({
                prompt: 'Taper by 0.5 and twist 45 degrees',
                inputGlbPath,
                outputGlbPath: path.join(dir, 'reshaped.glb')
            }, {} as any);

            expect(promptOutcome.status).toBe('completed');
            expect(promptOutcome.resultPayload.status).toBe('success');
            expect(promptOutcome.summaryResult).toContain('Successfully reshaped mesh');
            expect((promptOutcome.resultPayload.telemetry as any).inputVertices).toBeGreaterThan(0);
            expect(fs.readFileSync(path.join(dir, 'reshaped.glb')).readUInt32LE(0)).toBe(0x46546C67);

            // mesh_apply_deformers
            const deformersOutcome = await meshShapingHandlers.mesh_apply_deformers({
                inputGlbPath,
                outputGlbPath: path.join(dir, 'deformed.glb'),
                operations: [
                    { type: 'taper', factor: 0.6, axis: 'y' },
                    { type: 'twist', angle: 30, axis: 'y' }
                ]
            }, {} as any);

            expect(deformersOutcome.status).toBe('completed');
            expect(deformersOutcome.resultPayload.status).toBe('success');
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('4b. mesh tools fail instead of deforming a stand-in mesh or inventing operations', async () => {
        await expect(meshShapingHandlers.mesh_reshape_via_prompt({ prompt: 'Taper by 0.5', benchmark: 'cylinder' }, {} as any))
            .rejects.toBeInstanceOf(MissingInputError);
        await expect(meshShapingHandlers.mesh_apply_deformers({ operations: [{ type: 'taper', factor: 0.6 }], inputGlbPath: path.join(os.tmpdir(), 'no-such-mesh.glb') }, {} as any))
            .rejects.toThrow('does not exist');
        await expect(meshShapingHandlers.mesh_apply_deformers({ operations: [], inputGlbPath: 'x.glb' }, {} as any))
            .rejects.toThrow('mesh_apply_deformers needs operations');

        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-mesh-noop-'));
        const inputGlbPath = path.join(dir, 'in.glb');
        fs.writeFileSync(inputGlbPath, Buffer.from('glTF'));
        try {
            // A prompt with no deformation in it is refused (the service would otherwise apply a stock taper and twist).
            await expect(meshShapingHandlers.mesh_reshape_via_prompt({ prompt: 'make it nicer', inputGlbPath }, {} as any))
                .rejects.toThrow('no deformation');
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
        for (const decl of MESH_SHAPING_TOOL_DECLARATIONS) {
            expect(decl.parameters.required, decl.name).toContain('inputGlbPath');
            expect(Object.keys(decl.parameters.properties || {}), decl.name).not.toContain('benchmark');
        }
    });

    it('5. should route mesh deformation prompts natively to cpp-3d-engine via TaskCapabilityResolver', () => {
        const capability = resolveTaskCapability('I want to reshape this 3D mesh by tapering the top and twisting it 45 degrees');
        expect(capability.canSolveNatively).toBe(true);
        expect(capability.tier1Assessment.canSolveNatively).toBe(true);
        expect(capability.tier1Assessment.primaryNativeEngine).toBe('cpp-3d-engine');
        expect(capability.tier1Assessment.suggestedNativeAction?.serviceOrTool).toContain('mesh_reshape_via_prompt');
        expect(capability.tier1Assessment.rationale).toContain('Astro');
    });

    it('6. should execute direct-dispatch operator sb_reshape_mesh in browser operator engine', () => {
        const engine = createOperatorEngine({
            title: 'Reshaper Canvas Test',
            renderMode: 'pbr',
            customMeshes: [
                {
                    id: 'mesh-pillar',
                    name: 'Ionic Pillar',
                    type: 'cylinder' as any,
                    position: [0, 0, 0],
                    rotation: [0, 0, 0],
                    scale: [1, 2, 1]
                }
            ],
            objects: []
        });

        const result = engine.dispatch('sb_reshape_mesh', {
            objectId: 'mesh-pillar',
            prompt: 'Taper the top by 50% and twist 45 degrees'
        });

        expect(result.success).toBe(true);
        expect(result.data.appliedOperations.length).toBeGreaterThanOrEqual(2);
        expect(result.data.prompt).toContain('Taper');
    });
});
