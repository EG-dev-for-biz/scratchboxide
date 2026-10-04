/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * Python 3D Procedural Scripting Tools
 * Exposes NativePythonRunnerService to Gemini agents, allowing Blender-style
 * procedural Python scripting (import scratchbox as sb) backed by native C++20
 * Astro engine nanobind bindings to stream binary .glb directly into the viewport.
 * Supports analytical AABB dynamic camera auto-framing and geospatial shape extraction.
 ********************************************************************************/

import * as fs from 'fs';
import * as path from 'path';
import type { ToolDeclaration, ToolHandlerOutcome } from './types';
import { NativePythonRunnerService } from '../../3d-engine/native-python-runner-service';
import { GeospatialTileExtractionBridge, ExtractedLocationManifest } from '../../spatial/GeospatialTileExtractionBridge';

export interface GlbAabbBounds {
    min: [number, number, number];
    max: [number, number, number];
    center: [number, number, number];
    dimensions: [number, number, number];
    radius: number;
}

/**
 * Rapidly parse glTF 2.0 JSON chunk from binary GLB buffer to extract accurate AABB
 * bounding box without decoding heavy vertex buffers.
 */
export function extractGlbAabb(glbBuffer: Buffer): GlbAabbBounds | null {
    try {
        if (!glbBuffer || glbBuffer.length < 20) return null;
        const magic = glbBuffer.toString('utf8', 0, 4);
        if (magic !== 'glTF') return null;

        const jsonLength = glbBuffer.readUInt32LE(12);
        const jsonStr = glbBuffer.toString('utf8', 20, 20 + jsonLength);
        const gltf = JSON.parse(jsonStr);

        let minX = Infinity, minY = Infinity, minZ = Infinity;
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
        let found = false;

        if (Array.isArray(gltf.accessors)) {
            for (const acc of gltf.accessors) {
                if (acc.type === 'VEC3' && Array.isArray(acc.min) && Array.isArray(acc.max)) {
                    minX = Math.min(minX, acc.min[0]);
                    minY = Math.min(minY, acc.min[1]);
                    minZ = Math.min(minZ, acc.min[2]);
                    maxX = Math.max(maxX, acc.max[0]);
                    maxY = Math.max(maxY, acc.max[1]);
                    maxZ = Math.max(maxZ, acc.max[2]);
                    found = true;
                }
            }
        }

        if (!found || !isFinite(minX)) return null;

        const center: [number, number, number] = [
            (minX + maxX) * 0.5,
            (minY + maxY) * 0.5,
            (minZ + maxZ) * 0.5
        ];
        const dimensions: [number, number, number] = [
            Math.max(0.1, maxX - minX),
            Math.max(0.1, maxY - minY),
            Math.max(0.1, maxZ - minZ)
        ];
        const radius = Math.max(0.1, Math.sqrt(dimensions[0] ** 2 + dimensions[1] ** 2 + dimensions[2] ** 2) * 0.5);

        return {
            min: [minX, minY, minZ],
            max: [maxX, maxY, maxZ],
            center,
            dimensions,
            radius
        };
    } catch {
        return null;
    }
}

export const PYTHON_3D_TOOL_DECLARATIONS: ToolDeclaration[] = [
    {
        name: 'execute_3d_python_script',
        description: 'Universal 3D scene execution bus. Executes a procedural Python 3 script using the Scratchbox 3D Engine (import scratchbox as sb) for both procedural world synthesis and real-world locations. Generates architecture (mansard roofs, townhouses, facades), nature (space colonization trees, foliage), and procedural geometry. When a location is specified, passes Google 3D tile data through a shape extraction pipeline (separating terrain, architecture, and vegetation anchors like SB-Veggie) to allow procedural augmentation and populating.',
        parameters: {
            type: 'OBJECT',
            properties: {
                script: {
                    type: 'STRING',
                    description: 'The procedural Python 3 script. Must import scratchbox as sb and write the resulting scene to OUTPUT_GLB_PATH via sb.io.write_glb(OUTPUT_GLB_PATH, scene).'
                },
                location: {
                    type: 'STRING',
                    description: 'Optional real-world location query or coordinates (e.g. "Eiffel Tower, Paris", "Colosseum, Rome"). When provided, the engine automatically ingests leaf-LOD 3D tiles, runs the shape extraction pipeline to segment terrain, buildings, and vegetation clusters, and injects them into sb.geospatial.load_location() for procedural population.'
                },
                description: {
                    type: 'STRING',
                    description: 'Optional human-readable description of the 3D scene or asset being generated.'
                },
                timeoutMs: {
                    type: 'NUMBER',
                    description: 'Execution timeout in milliseconds (default 45000).'
                }
            },
            required: ['script']
        }
    }
];

export const python3DHandlers: Record<string, (args: Record<string, unknown>) => Promise<ToolHandlerOutcome>> = {
    execute_3d_python_script: async (args: Record<string, unknown>): Promise<ToolHandlerOutcome> => {
        const script = typeof args.script === 'string' ? args.script : '';
        const locationQuery = typeof args.location === 'string' ? args.location.trim() : '';
        const timeoutMs = typeof args.timeoutMs === 'number' ? args.timeoutMs : 45000;

        if (!script.trim()) {
            return {
                status: 'failed',
                resultPayload: {
                    success: false,
                    error: 'Empty script provided. Must provide a valid Python script importing scratchbox.'
                },
                summaryResult: 'Failed: script argument was empty.'
            };
        }

        const runner = NativePythonRunnerService.getInstance();
        const customEnv: NodeJS.ProcessEnv = { ...process.env };
        let extractedManifest: ExtractedLocationManifest | undefined;

        // 1. If location is requested, run pre-flight tile extraction pipeline
        if (locationQuery) {
            try {
                const extractionBridge = GeospatialTileExtractionBridge.getInstance();
                const extractResult = await extractionBridge.ingestAndExtract(locationQuery);
                if (extractResult.success) {
                    extractedManifest = extractResult.manifest;
                    customEnv.SCRATCHBOX_LOCATION_QUERY = locationQuery;
                    customEnv.SCRATCHBOX_LOCATION_GLB = extractResult.glbPath;
                    customEnv.SCRATCHBOX_LOCATION_MANIFEST = extractResult.manifestPath;
                }
            } catch (err: any) {
                console.warn(`[execute_3d_python_script] Geospatial extraction warning for "${locationQuery}":`, err?.message || err);
            }
        }

        // 2. Execute Python script
        const result = await runner.runScript(script, {
            timeoutMs,
            env: customEnv
        });

        if (!result.success) {
            return {
                status: 'failed',
                resultPayload: {
                    success: false,
                    exitCode: result.exitCode,
                    stdout: result.stdout,
                    stderr: result.stderr,
                    errorDetails: result.errorDetails,
                    executionTimeMs: result.executionTimeMs
                },
                summaryResult: `Python 3D execution failed: ${result.errorDetails || result.stderr || 'Non-zero exit code'}`
            };
        }

        const desc = (typeof args.description === 'string' && args.description.trim()) ? args.description.trim() : 'Procedural 3D Python Scene';

        // 3. Analytical AABB Bounding Box Calculation for Dynamic Camera Auto-Framing
        let cameraPosition: [number, number, number] = [0, 18, 38];
        let cameraTarget: [number, number, number] = [0, 4, 0];
        const cameraFov = 50;
        let bounds: GlbAabbBounds | null = null;

        if (result.glbBase64) {
            const buffer = Buffer.from(result.glbBase64, 'base64');
            bounds = extractGlbAabb(buffer);
        } else if (result.glbPath && fs.existsSync(result.glbPath)) {
            const buffer = fs.readFileSync(result.glbPath);
            bounds = extractGlbAabb(buffer);
        }

        if (bounds) {
            cameraTarget = [bounds.center[0], bounds.center[1], bounds.center[2]];
            const fovRad = (cameraFov * Math.PI) / 180;
            // Frame camera with 15% comfortable safety margin
            const distance = Math.max(1.8, (bounds.radius / Math.sin(fovRad * 0.5)) * 1.15);
            // 35-degree azimuthal cinematic 3/4 perspective
            cameraPosition = [
                bounds.center[0] + distance * 0.65,
                bounds.center[1] + distance * 0.45,
                bounds.center[2] + distance * 0.85
            ];
        }

        return {
            status: 'completed',
            resultPayload: {
                success: true,
                glbPath: result.glbPath,
                glbBase64: result.glbBase64,
                executionTimeMs: result.executionTimeMs,
                stdout: result.stdout,
                description: desc,
                overallBoundingBox: bounds,
                locationManifest: extractedManifest,
                artifact: {
                    id: `artifact-3d-${Date.now()}`,
                    type: '3d-scene',
                    title: desc,
                    summary: `Generated 3D asset via Scratchbox Python 3 engine (${result.executionTimeMs}ms)`,
                    data: {
                        title: desc,
                        worldBranch: locationQuery ? `geospatial/${locationQuery.toLowerCase().replace(/[^a-z0-9]+/g, '-')}` : 'procedural/python-scene',
                        sceneType: locationQuery ? 'real_world_landmark' : 'custom',
                        renderMode: 'pbr',
                        cameraMode: 'orbit',
                        animation: 'orbit',
                        camera: {
                            position: cameraPosition,
                            target: cameraTarget,
                            fov: cameraFov
                        },
                        environment: {
                            skybox: 'studio',
                            lighting: 'studio',
                            ground: true
                        },
                        pythonGenerator: {
                            enabled: true,
                            filename: 'procedural_scene.py',
                            sourceCode: script,
                            glbBase64: result.glbBase64,
                            glbPath: result.glbPath,
                            lastCompiledTimeMs: Date.now()
                        }
                    }
                }
            },
            summaryResult: `Successfully generated 3D GLB via Python (${result.executionTimeMs}ms). GLB framed dynamically at bounds [${bounds ? bounds.dimensions.map(d => d.toFixed(1) + 'm').join(' x ') : 'default'}].`
        };
    }
};
