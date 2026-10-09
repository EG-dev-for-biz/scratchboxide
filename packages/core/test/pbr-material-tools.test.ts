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
import * as path from 'path';
import * as os from 'os';
import {
    PBR_MATERIAL_TOOL_DECLARATIONS,
    pbrMaterialHandlers
} from '../src/node/gemini/tools/pbr-material-tools';

describe('PBR Material Gemini Tools & Multi-Resolution Engine', () => {
    it('should export valid tool declarations for PBR materials', () => {
        expect(PBR_MATERIAL_TOOL_DECLARATIONS.length).toBe(3);
        const names = PBR_MATERIAL_TOOL_DECLARATIONS.map(d => d.name);
        expect(names).toContain('pbr_synthesize_material');
        expect(names).toContain('pbr_get_material_catalog');
        expect(names).toContain('pbr_interpolate_materials');

        const synthTool = PBR_MATERIAL_TOOL_DECLARATIONS.find(d => d.name === 'pbr_synthesize_material');
        expect(synthTool?.parameters?.properties?.resolution?.enum).toEqual(['1K', '2K', '4K', '8K', '12K']);
    });

    it('should retrieve biophysical material catalog with 50 archetypes', async () => {
        const handler = pbrMaterialHandlers.pbr_get_material_catalog;
        const res = await handler({}, {} as any);
        expect(res.summaryResult).toContain('50 biophysical PBR material archetypes');
        const payload = res.resultPayload as any;
        expect(payload.totalCount).toBe(50);
        expect(payload.categories.length).toBe(7);

        // Filter by category
        const stonesRes = await handler({ category: 'stones' }, {} as any);
        const stonesPayload = stonesRes.resultPayload as any;
        expect(stonesPayload.totalCount).toBeGreaterThan(0);
        expect(stonesPayload.archetypes.every((a: any) => a.category.toLowerCase().includes('stone'))).toBe(true);
    });

    it('should interpolate two continuous material descriptors in R^20 (ADA Compliance)', async () => {
        const handler = pbrMaterialHandlers.pbr_interpolate_materials;
        const res = await handler({
            materialA: 'carrara_marble',
            materialB: 'brushed_titanium',
            alpha: 0.5
        }, {} as any);

        const payload = res.resultPayload as any;
        expect(payload.alpha).toBe(0.5);
        expect(payload.descriptor).toBeDefined();
        // Carrara marble conduction = 0.0, brushed titanium = 1.0 => alpha 0.5 conduction = 0.5
        expect(payload.descriptor.conduction).toBeCloseTo(0.5, 1);
        expect(res.summaryResult).toContain('alpha=0.50');
    });

    it('should synthesize a PBR material PNG pack via native C++20 kernel', async () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pbr_tool_test_'));
        try {
            const handler = pbrMaterialHandlers.pbr_synthesize_material;
            const res = await handler({
                resolution: 128,
                archetype: 'carrara_marble',
                format: 'png_pack',
                outputDir: tmpDir,
                outputFileName: 'marble_128'
            }, {} as any);

            const payload = res.resultPayload as any;
            expect(payload.success).toBe(true);
            expect(payload.resolution).toBe('128x128');
            expect(payload.files.albedo).toBeDefined();
            expect(payload.files.normal).toBeDefined();
            expect(payload.files.orm).toBeDefined();
            expect(payload.files.height).toBeDefined();

            expect(fs.existsSync(payload.files.albedo)).toBe(true);
            expect(fs.existsSync(payload.files.normal)).toBe(true);
            expect(fs.existsSync(payload.files.orm)).toBe(true);
            expect(fs.existsSync(payload.files.height)).toBe(true);

            expect(fs.statSync(payload.files.albedo).size).toBeGreaterThan(100);
            expect(fs.statSync(payload.files.normal).size).toBeGreaterThan(100);
            expect(fs.statSync(payload.files.orm).size).toBeGreaterThan(100);
            expect(fs.statSync(payload.files.height).size).toBeGreaterThan(100);
        } finally {
            try {
                fs.rmSync(tmpDir, { recursive: true, force: true });
            } catch {}
        }
    }, 120000);

    it('should synthesize a PBR material and pack it into a binary glTF (.glb) plane', async () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pbr_tool_glb_test_'));
        try {
            const handler = pbrMaterialHandlers.pbr_synthesize_material;
            const res = await handler({
                resolution: 128,
                archetype: 'cor_ten_steel',
                format: 'glb',
                outputDir: tmpDir,
                outputFileName: 'steel_preview',
                planeWidthMeters: 3.0,
                displacementScaleMeters: 0.05
            }, {} as any);

            const payload = res.resultPayload as any;
            expect(payload.success).toBe(true);
            expect(payload.files.glb).toBeDefined();
            expect(fs.existsSync(payload.files.glb)).toBe(true);

            const glbBuf = fs.readFileSync(payload.files.glb);
            // Verify GLB magic header 0x46546C67 ("glTF")
            expect(glbBuf.readUInt32LE(0)).toBe(0x46546C67);
            expect(glbBuf.readUInt32LE(4)).toBe(2);
            expect(glbBuf.length).toBeGreaterThan(1000);
        } finally {
            try {
                fs.rmSync(tmpDir, { recursive: true, force: true });
            } catch {}
        }
    }, 120000);
});
