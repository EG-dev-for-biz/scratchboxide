/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect, vi, afterEach } from 'vitest';
import { AdaptiveMaterialPbrService } from '../src/node/3d-engine/adaptive-material-pbr-service';
import { PbrUnknownArchetypeError, AdaptivePbrMaterialSpecError } from '../src/node/3d-engine/adaptive-pbr-errors';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
    PBR_MATERIAL_TOOL_DECLARATIONS,
    pbrMaterialHandlers
} from '../src/node/gemini/tools/pbr-material-tools';

describe('PBR Material Gemini Tools & Multi-Resolution Engine', () => {
    it('should export valid tool declarations for PBR materials', () => {
        expect(PBR_MATERIAL_TOOL_DECLARATIONS.length).toBe(4);
        const names = PBR_MATERIAL_TOOL_DECLARATIONS.map(d => d.name);
        expect(names).toContain('pbr_synthesize_material');
        expect(names).toContain('pbr_get_material_catalog');
        expect(names).toContain('pbr_interpolate_materials');
        expect(names).toContain('pbr_probe_mesh_topology');

        const synthTool = PBR_MATERIAL_TOOL_DECLARATIONS.find(d => d.name === 'pbr_synthesize_material');
        expect(synthTool?.parameters?.properties?.resolution?.enum).toEqual(['1K', '2K', '4K', '8K', '12K']);
        expect(synthTool?.parameters?.properties?.targetMeshPath).toBeDefined();
        expect(synthTool?.parameters?.properties?.domain?.enum).toEqual(['organic', 'nonorganic']);
    });

    it('lists 50 example descriptors as data (each with its full descriptor) and narrows them by free text', async () => {
        const handler = pbrMaterialHandlers.pbr_get_material_catalog;
        const res = await handler({}, {} as any);
        expect(res.summaryResult).toMatch(/Listed 50 example material descriptors\. They are reference points .* not a closed list/);
        const payload = res.resultPayload as any;
        expect(payload.totalCount).toBe(50);
        expect(payload.requiredDescriptorFields).toEqual(['albedoLinear', 'conduction', 'roughnessBaseline']);
        for (const e of payload.examples) {
            expect(e.descriptor.albedoLinear).toHaveLength(3);
            expect(Object.keys(e.descriptor)).toHaveLength(16); // 16 fields = 20 floats (two RGB triples)
        }

        const marble = (await handler({ query: 'marble' }, {} as any)).resultPayload as any;
        expect(marble.totalCount).toBeGreaterThan(0);
        expect(marble.examples.every((a: any) => `${a.key} ${a.displayName} ${a.description} ${a.group}`.toLowerCase().includes('marble'))).toBe(true);
        // The older parameter name still narrows the list
        expect(((await handler({ category: 'stones' }, {} as any)).resultPayload as any).totalCount).toBeGreaterThan(0);
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
                archetype: 'corten_steel',
                format: 'glb',
                outputDir: tmpDir,
                outputFileName: 'steel_preview',
                planeWidthMeters: 3.0,
                displacementScaleMeters: 0.05
            }, {} as any);

            const payload = res.resultPayload as any;
            expect(payload.success).toBe(true);
            expect(payload.archetype).toBe('corten_steel');
            expect(payload.synthesizer).toBe('native-cpp20');
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

    it('should synthesize an OpenPBR compliant MaterialX (.mtlx) document with tiled texture coordinates', async () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pbr_tool_mtlx_test_'));
        try {
            const handler = pbrMaterialHandlers.pbr_synthesize_material;
            const res = await handler({
                resolution: 128,
                archetype: 'carrara_marble',
                format: 'materialx',
                outputDir: tmpDir,
                outputFileName: 'marble_openpbr',
                uvTilingX: 3.5,
                uvTilingY: 3.5
            }, {} as any);

            const payload = res.resultPayload as any;
            expect(payload.success).toBe(true);
            expect(payload.files.materialx).toBeDefined();
            expect(fs.existsSync(payload.files.materialx)).toBe(true);
            expect(payload.files.albedo).toBeDefined();
            expect(payload.files.normal).toBeDefined();
            expect(payload.files.roughness).toBeDefined();
            expect(payload.files.metallic).toBeDefined();

            const xml = fs.readFileSync(payload.files.materialx, 'utf8');
            expect(xml).toContain('<materialx version="1.38">');
            expect(xml).toContain('<open_pbr_surface');
            expect(xml).toContain('<standard_surface');
            expect(xml).toContain('<surfacematerial');
            expect(xml).toContain('3.5000, 3.5000');
            expect(xml).toContain('marble_openpbr_albedo.png');
            expect(xml).toContain('marble_openpbr_normal.png');
        } finally {
            try {
                fs.rmSync(tmpDir, { recursive: true, force: true });
            } catch {}
        }
    }, 120000);

    it('should synthesize and package a 64-byte aligned USDZ archive conforming to Pixar / Apple specs', async () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pbr_tool_usdz_test_'));
        try {
            const handler = pbrMaterialHandlers.pbr_synthesize_material;
            const res = await handler({
                resolution: 128,
                archetype: 'brushed_titanium',
                format: 'usdz',
                outputDir: tmpDir,
                outputFileName: 'titanium_stage',
                planeWidthMeters: 2.5
            }, {} as any);

            const payload = res.resultPayload as any;
            expect(payload.success).toBe(true);
            expect(payload.files.usdz).toBeDefined();
            expect(fs.existsSync(payload.files.usdz)).toBe(true);

            const usdzBuf = fs.readFileSync(payload.files.usdz);
            // Verify ZIP header signature 0x04034b50
            expect(usdzBuf.readUInt32LE(0)).toBe(0x04034b50);

            // Verify compression method is 0 (STORE / uncompressed for USDZ)
            expect(usdzBuf.readUInt16LE(8)).toBe(0);

            // Verify 64-byte alignment of the first file payload
            const fileNameLen = usdzBuf.readUInt16LE(26);
            const extraLen = usdzBuf.readUInt16LE(28);
            const dataOffset = 30 + fileNameLen + extraLen;
            expect(dataOffset % 64).toBe(0);

            // Verify USDA content in archive
            const fileString = usdzBuf.toString('utf8');
            expect(fileString).toContain('#usda 1.0');
            expect(fileString).toContain('UsdPreviewSurface');
            expect(fileString).toContain('def Mesh "Plinth"');
        } finally {
            try {
                fs.rmSync(tmpDir, { recursive: true, force: true });
            } catch {}
        }
    }, 120000);

    describe('only the maps that are written are encoded, and the timings are measured', () => {
        afterEach(() => vi.restoreAllMocks());
        const encodedFor = async (format: string) => {
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pbr_tool_encode_'));
            const spy = vi.spyOn(AdaptiveMaterialPbrService, 'encodePngAsync');
            try {
                const res: any = await pbrMaterialHandlers.pbr_synthesize_material({ resolution: 64, archetype: 'carrara_marble', format, outputDir: dir, outputFileName: 'm' }, {} as any);
                const pngs = fs.readdirSync(dir).filter(f => f.endsWith('.png')).sort();
                return { calls: spy.mock.calls.length, pngs, payload: res.resultPayload, summary: res.summaryResult as string };
            } finally {
                fs.rmSync(dir, { recursive: true, force: true });
            }
        };

        it('png_pack encodes and writes four maps; materialx encodes and writes seven', async () => {
            const pack = await encodedFor('png_pack');
            expect(pack.pngs).toEqual(['m_albedo.png', 'm_height.png', 'm_normal.png', 'm_orm.png']);
            expect(pack.calls).toBe(4);
            const mtlx = await encodedFor('materialx');
            expect(mtlx.pngs).toHaveLength(7);
            expect(mtlx.calls).toBe(7);
        }, 60000);

        it('the result reports the native kernel and its measured phases, not a constant', async () => {
            const { payload, summary } = await encodedFor('png_pack');
            expect(payload.synthesizer).toBe('native-cpp20');
            expect(payload.nativeTimingsMs.kernel).toBeGreaterThanOrEqual(0);
            expect(payload.nativeTimingsMs.total).toBeGreaterThanOrEqual(payload.nativeTimingsMs.kernel);
            expect(payload).not.toHaveProperty('cCompilerTimeMs');
            expect(summary).toMatch(/native C\+\+20 kernel \d+ms/);
            expect(payload.materialSource).toBe('archetype');
        }, 60000);

        it('an unknown archetype fails with the catalog keys instead of synthesizing limestone', async () => {
            const err: any = await pbrMaterialHandlers.pbr_synthesize_material({ resolution: 64, archetype: 'cor_ten_steel', format: 'png_pack' }, {} as any).catch(e => e);
            expect(err).toBeInstanceOf(PbrUnknownArchetypeError);
            expect(err.validArchetypes).toContain('corten_steel');
            const interp: any = await pbrMaterialHandlers.pbr_interpolate_materials({ materialA: 'carrara_marble', materialB: 'no_such_material', alpha: 0.5 }, {} as any).catch(e => e);
            expect(interp).toBeInstanceOf(PbrUnknownArchetypeError);
        });

        it('assumes no material: neither archetype nor a descriptor with its required fields is an error, not limestone', async () => {
            const none: any = await pbrMaterialHandlers.pbr_synthesize_material({ resolution: 64, format: 'png_pack' }, {} as any).catch(e => e);
            expect(none).toBeInstanceOf(AdaptivePbrMaterialSpecError);
            expect(none.message).toMatch(/give albedoLinear, conduction, roughnessBaseline .*missing albedoLinear, conduction, roughnessBaseline/);
            const partial: any = await pbrMaterialHandlers.pbr_synthesize_material({ resolution: 64, format: 'png_pack', descriptor: { albedoLinear: [0.2, 0.6, 0.3], conduction: 0 } }, {} as any).catch(e => e);
            expect(partial).toBeInstanceOf(AdaptivePbrMaterialSpecError);
            expect(partial.message).toMatch(/missing roughnessBaseline/);
            const interp: any = await pbrMaterialHandlers.pbr_interpolate_materials({ materialA: 'carrara_marble', materialB: { conduction: 1 }, alpha: 0.5 }, {} as any).catch(e => e);
            expect(interp).toBeInstanceOf(AdaptivePbrMaterialSpecError);
        });

        it('interpolates an example with a descriptor nobody catalogued (read from words), field by field', async () => {
            // "a glossy bioluminescent teal chitin": the model fills the fields; no catalog entry is involved
            const chitin = { albedoLinear: [0.05, 0.55, 0.5], conduction: 0.1, roughnessBaseline: 0.15, anisotropyStrength: 0.6 };
            const res = await pbrMaterialHandlers.pbr_interpolate_materials({ materialA: 'carrara_marble', materialB: chitin, alpha: 1 }, {} as any);
            const d = (res.resultPayload as any).descriptor;
            [0.05, 0.55, 0.5].forEach((v, i) => expect(d.albedoLinear[i]).toBeCloseTo(v, 9));
            expect(d.roughnessBaseline).toBeCloseTo(0.15, 6);
            expect(d.anisotropyStrength).toBeCloseTo(0.6, 6);
            expect(d.microPorosity).toBeCloseTo(0.15 * 0.45, 6); // neutral completion from its own roughness, not marble's
        });
    });
});
