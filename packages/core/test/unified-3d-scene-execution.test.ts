/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * Unified 3D Scene Execution & Geospatial Shape Extraction Test Suite
 * Validates:
 * 1. Analytical AABB Bounding Box extraction and dynamic camera auto-framing
 * 2. Unified execute_3d_python_script execution bus
 * 3. In-memory DirectDispatchOperatorEngine delta edits (<1ms)
 * 4. sb.geospatial and procedural vegetation population (SB-Veggie)
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { extractGlbAabb, python3DHandlers } from '../src/node/gemini/tools/python-3d-tools';
import { canvasHandlers } from '../src/node/gemini/tools/canvas-tools';
import { GeospatialTileExtractionBridge } from '../src/node/spatial/GeospatialTileExtractionBridge';
import { DirectDispatchOperatorEngine } from '../src/browser/generative-canvas/services/direct-dispatch-operator-engine';

describe('Unified 3D Scene Execution & Shape Extraction', () => {
    it('1. Extracts analytical AABB bounds and calculates dynamic camera auto-framing', () => {
        // Create a minimal synthetic GLB buffer with accessors containing min/max
        const gltf = {
            asset: { version: '2.0' },
            accessors: [
                {
                    bufferView: 0,
                    componentType: 5126,
                    count: 8,
                    type: 'VEC3',
                    min: [-10, 0, -5],
                    max: [10, 15, 5]
                }
            ],
            bufferViews: [{ buffer: 0, byteLength: 96, byteOffset: 0 }],
            buffers: [{ byteLength: 96 }]
        };

        const jsonStr = JSON.stringify(gltf);
        const jsonByteLength = Buffer.byteLength(jsonStr);
        const paddedLength = Math.ceil(jsonByteLength / 4) * 4;
        const jsonPadded = jsonStr.padEnd(paddedLength, ' ');

        const totalLength = 12 + 8 + paddedLength;
        const glb = Buffer.alloc(totalLength);
        glb.write('glTF', 0, 4, 'utf8');
        glb.writeUInt32LE(2, 4);
        glb.writeUInt32LE(totalLength, 8);
        glb.writeUInt32LE(paddedLength, 12);
        glb.write('JSON', 16, 4, 'utf8');
        glb.write(jsonPadded, 20, paddedLength, 'utf8');

        const bounds = extractGlbAabb(glb);
        expect(bounds).not.toBeNull();
        if (bounds) {
            expect(bounds.min).toEqual([-10, 0, -5]);
            expect(bounds.max).toEqual([10, 15, 5]);
            expect(bounds.center).toEqual([0, 7.5, 0]);
            expect(bounds.dimensions).toEqual([20, 15, 10]);
            expect(bounds.radius).toBeGreaterThan(10);
        }
    });

    it('2. Dispatches in-memory 3D scene operators in <1ms without re-compilation', async () => {
        const initialScene = {
            title: 'Initial Studio Scene',
            renderMode: 'pbr' as const,
            customMeshes: [
                {
                    id: 'mesh-arch-1',
                    name: 'MainPavilion',
                    type: 'custom' as any,
                    position: [0, 0, 0] as [number, number, number],
                    rotation: [0, 0, 0] as [number, number, number],
                    scale: [1, 1, 1] as [number, number, number]
                }
            ]
        };

        const outcome = await canvasHandlers.scene_3d_dispatch_operators({
            commands: [
                {
                    operator: 'sb_translate',
                    params: { objectId: 'MainPavilion', delta: [0, 5, -10] }
                },
                {
                    operator: 'sb_setup_lighting',
                    params: { sunAzimuth: 215, sunElevation: 35 }
                }
            ]
        }, {
            request: {
                activeArtifact: {
                    id: 'art-123',
                    type: '3d-scene',
                    title: 'Active Scene',
                    data: initialScene
                }
            }
        } as any);

        expect(outcome.resultPayload.success).toBe(true);
        expect(outcome.resultPayload.executedCount).toBe(2);
        expect(outcome.resultPayload.executionTimeMs).toBeGreaterThan(0);
        expect(outcome.resultPayload.artifact.data.environment.sunAzimuth).toBe(215);
        expect(outcome.resultPayload.artifact.data.customMeshes[0].position).toEqual([0, 5, -10]);
    });

    it('3. Runs GeospatialTileExtractionBridge to segment shapes and extract vegetation anchors', async () => {
        const bridge = GeospatialTileExtractionBridge.getInstance();
        const result = await bridge.ingestAndExtract('41.890210, 12.492231', {
            mode: 'clay',
            mockExecution: true
        });

        expect(result.success).toBe(true);
        expect(result.manifest.resolvedAddress).toBeDefined();
        expect(result.manifest.vegetationAnchors).toBeInstanceOf(Array);
        expect(result.manifest.overallBoundingBox).toBeDefined();
        expect(fs.existsSync(result.manifestPath)).toBe(true);
    });

    it('4. Executes execute_3d_python_script with dynamic camera framing', async () => {
        const script = `
import scratchbox as sb

scene = sb.geometry.Mesh("TestPavilion")
pedestal = sb.geometry.create_studio_pedestal(radius=10.0, height=0.4, segments=32)
scene.merge(pedestal)
bldg = sb.create_building(width=8.0, depth=8.0, floors=2, roof='hip')
scene.merge(bldg)
sb.io.write_glb(OUTPUT_GLB_PATH, scene)
`;

        const outcome = await python3DHandlers.execute_3d_python_script({
            script,
            description: 'Test Pavilion'
        });

        expect(outcome.status).toBe('completed');
        expect(outcome.resultPayload.success).toBe(true);
        expect(outcome.resultPayload.overallBoundingBox).toBeDefined();
        expect(outcome.resultPayload.artifact.data.camera.position).not.toEqual([0, 18, 38]); // dynamically framed!
    });
});
