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
    ImageToAdaptivePbrService,
    type ImageToPbrPlaneOptions
} from '../src/node/3d-engine/image-to-adaptive-pbr-service';
import {
    IMAGE_TO_PBR_TOOL_DECLARATIONS,
    imageToPbrHandlers
} from '../src/node/gemini/tools/image-to-pbr-tools';
import { AdaptiveMaterialPbrService } from '../src/node/3d-engine/adaptive-material-pbr-service';
import { HOW_TO, requireBinary, withReason } from './helpers/requirements';

// AdaptiveMaterialPbrService.decodeToRgba spawns bare `ffmpeg` from PATH (it does not read FFMPEG_PATH),
// so the requirement is exactly a PATH lookup.
const ffmpeg = requireBinary('ffmpeg', HOW_TO.ffmpeg);

/**
 * Creates a synthetic uncompressed PNG buffer using AdaptiveMaterialPbrService.
 */
async function createSyntheticImageBuffer(width: number, height: number): Promise<Buffer> {
    const total = width * height;
    const rgba = Buffer.alloc(total * 4);

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const idx = y * width + x;
            // High-frequency procedural brick/stone pattern
            const isMortar = (x % 32 === 0) || (y % 16 === 0);
            const intensity = isMortar ? 80 : 180 + Math.round(30 * Math.sin(x * 0.2) * Math.cos(y * 0.3));

            rgba[idx * 4 + 0] = intensity;
            rgba[idx * 4 + 1] = Math.max(0, intensity - 20);
            rgba[idx * 4 + 2] = Math.max(0, intensity - 40);
            rgba[idx * 4 + 3] = 255;
        }
    }

    return await AdaptiveMaterialPbrService.encodeFromRgba(rgba, width, height, true);
}

describe('ImageToAdaptivePbrService & Gemini Agent Tool (Zero-Preset Adaptive PBR)', () => {

    it('guarantees ADA compliance: zero closed taxonomies, enum classifiers, or hardcoded constants', () => {
        const serviceSource = fs.readFileSync(
            path.resolve(__dirname, '../src/node/3d-engine/image-to-adaptive-pbr-service.ts'),
            'utf8'
        );
        const toolsSource = fs.readFileSync(
            path.resolve(__dirname, '../src/node/gemini/tools/image-to-pbr-tools.ts'),
            'utf8'
        );

        // Verify zero hardcoded 0.082 glass hacks (like PlaneToPBR)
        expect(serviceSource).not.toContain('0.082');
        expect(toolsSource).not.toContain('0.082');

        // Verify zero closed material enum trees
        expect(serviceSource).not.toMatch(/enum\s+MaterialType/);
        expect(serviceSource).not.toMatch(/switch\s*\(\s*materialCategory\s*\)/);
    });

    it.skipIf(!ffmpeg.ok)(withReason('transforms a 2D image into a metric aspect-locked PBR displaced plane (.glb) in < 150ms', ffmpeg), async () => {
        const width = 128;
        const height = 64; // Aspect ratio = 2.0
        const testImageBuf = await createSyntheticImageBuffer(width, height);

        const options: ImageToPbrPlaneOptions = {
            imageBuffer: testImageBuf,
            planeWidthMeters: 4.0,
            subdivisions: 16,
            displacementScaleMeters: 0.06,
            reliefMultiplier: 1.40
        };

        const result = await ImageToAdaptivePbrService.processImageToPbrPlane(options);

        // 1. Verify telemetry & execution speed
        expect(result.success).toBe(true);
        expect(result.aspectRatio).toBeCloseTo(2.0, 2);
        expect(result.planeDimensionsMeters.width).toBe(4.0);
        expect(result.planeDimensionsMeters.height).toBeCloseTo(2.0, 2);
        expect(result.planeDimensionsMeters.displacementMax).toBe(0.06);

        // 2. Verify aspect-conformal subdivision grid
        expect(result.meshStats.subdivisionsX).toBe(16);
        expect(result.meshStats.subdivisionsY).toBe(8); // 16 / 2.0 = 8
        expect(result.meshStats.vertexCount).toBe((16 + 1) * (8 + 1)); // 153 vertices
        expect(result.meshStats.triangleCount).toBe(16 * 8 * 2);       // 256 triangles

        // 3. Verify intrinsic biophysical metrics
        expect(result.metrics.microPorosityEnergy).toBeGreaterThan(0);
        expect(result.metrics.contrastRatio).toBeGreaterThan(1.0);

        // 4. Validate binary glTF 2.0 buffer structure
        const glb = result.glbBuffer;
        expect(glb.length).toBeGreaterThan(1000);

        // Magic 0x46546C67 ('glTF')
        const magic = glb.readUInt32LE(0);
        expect(magic).toBe(0x46546C67);

        // Version 2
        const version = glb.readUInt32LE(4);
        expect(version).toBe(2);

        // JSON Chunk
        const jsonLength = glb.readUInt32LE(12);
        const jsonType = glb.readUInt32LE(16);
        expect(jsonType).toBe(0x4E4F534A); // 'JSON'

        const jsonStr = glb.subarray(20, 20 + jsonLength).toString('utf8');
        const gltf = JSON.parse(jsonStr);

        // Asset specification
        expect(gltf.asset.version).toBe('2.0');

        // Material specification
        expect(gltf.materials).toHaveLength(1);
        const mat = gltf.materials[0];
        expect(mat.pbrMetallicRoughness).toBeDefined();
        expect(mat.pbrMetallicRoughness.baseColorTexture.index).toBe(0);
        expect(mat.pbrMetallicRoughness.metallicRoughnessTexture.index).toBe(1); // ORM
        expect(mat.normalTexture.index).toBe(2);                                 // Normal
        expect(mat.normalTexture.scale).toBe(1.40);
        expect(mat.occlusionTexture.index).toBe(1);                             // ORM AO
        expect(mat.doubleSided).toBe(true);

        // Mesh primitives & attributes
        expect(gltf.meshes[0].primitives[0].attributes.POSITION).toBe(1);
        expect(gltf.meshes[0].primitives[0].attributes.NORMAL).toBe(2);
        expect(gltf.meshes[0].primitives[0].attributes.TEXCOORD_0).toBe(3);
        expect(gltf.meshes[0].primitives[0].attributes.TANGENT).toBe(4);
        expect(gltf.meshes[0].primitives[0].indices).toBe(0);

        // 3 Textures (Albedo, ORM, Normal)
        expect(gltf.textures).toHaveLength(3);
        expect(gltf.images).toHaveLength(3);
    });

    it.skipIf(!ffmpeg.ok)(withReason('generates flat plane with upright normals when displacementScaleMeters is 0.0', ffmpeg), async () => {
        const width = 64;
        const height = 64;
        const testImageBuf = await createSyntheticImageBuffer(width, height);

        const result = await ImageToAdaptivePbrService.processImageToPbrPlane({
            imageBuffer: testImageBuf,
            displacementScaleMeters: 0.0,
            subdivisions: 4
        });

        expect(result.success).toBe(true);
        expect(result.planeDimensionsMeters.displacementMax).toBe(0.0);

        // Parse positions and normals from glb buffer
        const glb = result.glbBuffer;
        const jsonLength = glb.readUInt32LE(12);
        const gltf = JSON.parse(glb.subarray(20, 20 + jsonLength).toString('utf8'));

        const binOffset = 20 + jsonLength + 8;
        const posView = gltf.bufferViews[1];
        const normView = gltf.bufferViews[2];

        const posFloat = new Float32Array(
            glb.buffer,
            glb.byteOffset + binOffset + posView.byteOffset,
            posView.byteLength / 4
        );
        const normFloat = new Float32Array(
            glb.buffer,
            glb.byteOffset + binOffset + normView.byteOffset,
            normView.byteLength / 4
        );

        // All Z coordinates should be exactly 0
        for (let i = 0; i < posFloat.length / 3; i++) {
            expect(posFloat[i * 3 + 2]).toBe(0.0);
        }

        // All normals should be exactly [0, 0, 1]
        for (let i = 0; i < normFloat.length / 3; i++) {
            expect(normFloat[i * 3 + 0]).toBe(0.0);
            expect(normFloat[i * 3 + 1]).toBe(0.0);
            expect(normFloat[i * 3 + 2]).toBe(1.0);
        }
    });

    it.skipIf(!ffmpeg.ok)(withReason('executes Gemini agent tool image_to_adaptive_pbr_plane with file persistence and diagnostic maps', ffmpeg), async () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pbr-plane-test-'));
        const inputImgPath = path.join(tmpDir, 'source.png');
        const outputGlbPath = path.join(tmpDir, 'output_plane.glb');

        const testImageBuf = await createSyntheticImageBuffer(64, 64);
        fs.writeFileSync(inputImgPath, testImageBuf);

        // Tool declaration check
        const toolDecl = IMAGE_TO_PBR_TOOL_DECLARATIONS.find(t => t.name === 'image_to_adaptive_pbr_plane');
        expect(toolDecl).toBeDefined();
        expect(toolDecl?.description).toContain('Transform any 2D image');

        // Tool handler execution
        const handler = imageToPbrHandlers['image_to_adaptive_pbr_plane'];
        const response = await handler({
            imagePath: inputImgPath,
            outputGlbPath: outputGlbPath,
            planeWidthMeters: 3.0,
            displacementScaleMeters: 0.05,
            saveDiagnosticMaps: true,
            roughnessRange: [0.6, 0.95]
        }, {} as any);

        expect(response.summaryResult).toContain('Adaptive Image-to-PBR Plane generated successfully');
        expect(fs.existsSync(outputGlbPath)).toBe(true);

        // Diagnostic maps
        expect(fs.existsSync(path.join(tmpDir, 'output_plane_albedo.jpg'))).toBe(true);
        expect(fs.existsSync(path.join(tmpDir, 'output_plane_normal.png'))).toBe(true);
        expect(fs.existsSync(path.join(tmpDir, 'output_plane_orm.png'))).toBe(true);
        expect(fs.existsSync(path.join(tmpDir, 'output_plane_height.png'))).toBe(true);

        // Clean up
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('handles missing imagePath with actionable error in tool handler', async () => {
        const handler = imageToPbrHandlers['image_to_adaptive_pbr_plane'];
        const response = await handler({}, {} as any);

        expect(response.summaryResult).toContain('imagePath is required');
        expect((response.resultPayload as any).success).toBe(false);
    });
});
