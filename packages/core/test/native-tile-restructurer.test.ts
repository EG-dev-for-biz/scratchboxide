/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
    NativeTileRestructurerService,
    TileRestructurerService,
    type TileRestructureConfig,
    type TerraformingOp,
    type PrimitiveGraft
} from '../src/node/3d-engine/native-tile-restructurer-service';
import {
    MESH_SHAPING_TOOL_DECLARATIONS,
    meshShapingHandlers
} from '../src/node/gemini/tools/mesh-shaping-tools';
import {
    createOperatorEngine
} from '../src/browser/generative-canvas/services/direct-dispatch-operator-engine';

describe('Native 3D Tile Terraforming & Primitive Restructuring Pipeline (Tier 1)', () => {
    it('1. should parse natural language prompts into structured terraforming and primitive placement rules', () => {
        const prompt1 = 'Restructure this tile into an ancient solarpunk citadel: terrace the hillside with 4 stepped tiers, level a central sun plaza at elevation 8m, and place 4 solar obelisks at the perimeter corners and a bio-dome at the apex';
        const config1 = NativeTileRestructurerService.parsePromptToConfig(prompt1);

        expect(config1.style).toBe('SolarpunkCitadel');
        expect(config1.terraforming.length).toBeGreaterThanOrEqual(2);
        
        const terraceOp = config1.terraforming.find(o => o.type === 'terrace');
        expect(terraceOp).toBeDefined();
        expect(terraceOp?.stepCount).toBeGreaterThanOrEqual(3);

        const levelOp = config1.terraforming.find(o => o.type === 'plateau_level');
        expect(levelOp).toBeDefined();
        expect(levelOp?.targetElevation).toBe(8.0);

        expect(config1.primitives.length).toBeGreaterThanOrEqual(2);
        const obeliskGraft = config1.primitives.find(p => p.type === 'obelisk');
        expect(obeliskGraft).toBeDefined();
        expect(obeliskGraft?.count).toBe(4);
        expect(obeliskGraft?.anchor).toBe('corners');

        const domeGraft = config1.primitives.find(p => p.type === 'dome');
        expect(domeGraft).toBeDefined();
        expect(domeGraft?.anchor).toBe('apex');

        // Brutalist fortress with moat and monolith pylons in studio clay mode
        const prompt2 = 'Turn this tile into a brutalist fortress massing in studio clay: carve a perimeter moat trench, flatten the center, and place 6 heavy monolith pylons';
        const config2 = NativeTileRestructurerService.parsePromptToConfig(prompt2);

        expect(config2.style).toBe('BrutalistFortress');
        expect(config2.materialMode).toBe('studio_clay');
        expect(config2.terraforming.some(o => o.type === 'trench_moat')).toBe(true);
        expect(config2.terraforming.some(o => o.type === 'plateau_level')).toBe(true);
        expect(config2.primitives.some(p => p.type === 'column_colonnade' || p.type === 'pylon_gate')).toBe(true);
    });

    it('2. should execute native C++20 restructuring pipeline on benchmark tile and produce valid binary GLB', async () => {
        const outGlb = path.join(process.cwd(), 'build', '3d-native', 'test_tile_restructured.glb');
        if (fs.existsSync(outGlb)) {
            fs.unlinkSync(outGlb);
        }

        const result = await NativeTileRestructurerService.restructureTile({
            benchmark: 'hillside_monument',
            prompt: 'Terrace the hillside into 3 steps, level the plaza, and graft 4 obelisks at the corners',
            outputGlbPath: outGlb,
            materialMode: 'stylized_pbr'
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
        expect(result.telemetry.terraformingOpsApplied).toBeGreaterThanOrEqual(1);
        expect(result.telemetry.primitivesGrafted).toBeGreaterThanOrEqual(4);
        expect(result.telemetry.outputVertexCount).toBeGreaterThan(0);
        expect(result.telemetry.outputTriangleCount).toBeGreaterThan(0);
        expect(result.telemetry.executionTimeMs).toBeGreaterThan(0);
        expect(result.telemetry.cleanManifold).toBe(true);
    });

    it('3. should support explicit parametric terraforming and primitive placement via TileRestructurerService alias', async () => {
        const terraforming: TerraformingOp[] = [
            { type: 'terrace', stepHeight: 2.5, stepCount: 4 },
            { type: 'plateau_level', center: [0, 4, 0], radius: 12.0, targetElevation: 4.0 }
        ];

        const primitives: PrimitiveGraft[] = [
            { type: 'stepped_pyramid', position: [0, 4, 0], scale: [10, 3, 10], anchor: 'center' },
            { type: 'column_colonnade', position: [0, 7, 0], count: 8, radius: 4.0, anchor: 'plaza' }
        ];

        const outGlb = path.join(process.cwd(), 'build', '3d-native', 'test_tile_parametric.glb');
        const result = await TileRestructurerService.restructureTile({
            benchmark: 'city_district',
            config: {
                style: 'NeoclassicalMonument',
                materialMode: 'studio_clay',
                clayPreset: 'Sandstone',
                terraforming,
                primitives
            },
            outputGlbPath: outGlb
        });

        expect(result.success).toBe(true);
        expect(result.telemetry.terraformingOpsApplied).toBe(2);
        expect(result.telemetry.primitivesGrafted).toBeGreaterThanOrEqual(9); // 1 pyramid + 8 columns
        expect(fs.existsSync(outGlb)).toBe(true);
    });

    it('4. should correctly dispatch Gemini agent tools tile_restructure_via_prompt & tile_apply_terraforming_and_primitives', async () => {
        const restructurePromptTool = MESH_SHAPING_TOOL_DECLARATIONS.find(t => t.name === 'tile_restructure_via_prompt');
        expect(restructurePromptTool).toBeDefined();

        const parametricTool = MESH_SHAPING_TOOL_DECLARATIONS.find(t => t.name === 'tile_apply_terraforming_and_primitives');
        expect(parametricTool).toBeDefined();

        // Dispatch tile_restructure_via_prompt
        const promptOutcome = await meshShapingHandlers.tile_restructure_via_prompt({
            prompt: 'Terrace hillside and place 4 obelisks',
            benchmark: 'hillside_monument',
            materialMode: 'studio_clay'
        }, {} as any);

        expect(promptOutcome.status).toBe('completed');
        expect(promptOutcome.resultPayload.status).toBe('success');
        expect(promptOutcome.summaryResult).toContain('Successfully restructured 3D tile');

        // Dispatch tile_apply_terraforming_and_primitives
        const parametricOutcome = await meshShapingHandlers.tile_apply_terraforming_and_primitives({
            benchmark: 'hillside_monument',
            style: 'NeoclassicalMonument',
            terraforming: [{ type: 'terrace', stepHeight: 3.0, stepCount: 3 }],
            primitives: [{ type: 'obelisk', count: 4, anchor: 'corners' }]
        }, {} as any);

        expect(parametricOutcome.status).toBe('completed');
        expect(parametricOutcome.resultPayload.status).toBe('success');
    });

    it('5. should execute direct-dispatch operator sb_restructure_tile_mesh in generative canvas engine', () => {
        const engine = createOperatorEngine({
            title: 'Tile Restructure Test',
            renderMode: 'pbr',
            customMeshes: [
                {
                    id: 'tile-mesh-01',
                    name: 'Rome District Tile',
                    type: 'box' as any,
                    position: [0, 0, 0],
                    rotation: [0, 0, 0],
                    scale: [20, 5, 20]
                }
            ],
            objects: []
        });

        const result = engine.dispatch('sb_restructure_tile_mesh', {
            objectId: 'tile-mesh-01',
            prompt: 'Terrace hillside into 3 tiers, level central plaza, and graft 4 obelisks',
            style: 'SolarpunkCitadel',
            materialMode: 'stylized_pbr'
        });

        expect(result.success).toBe(true);
        expect(result.data.appliedTerraforming.length).toBeGreaterThanOrEqual(1);
        expect(result.data.graftedPrimitivesCount).toBeGreaterThanOrEqual(1);
        expect(result.data.style).toBe('SolarpunkCitadel');
    });
});
