/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import { GeminiService } from '../src/node/gemini-service';
import { createDefaultToolRegistry } from '../src/node/gemini/tool-registry';
import { TaskCapabilityResolver } from '../src/node/agent/task-capability-resolver';
import type { GeminiGenerateRequest } from '../src/common/gemini-protocol';

describe('WebXR Geospatial Agent Tools & Capability Resolution', () => {
    it('exposes WebXR geospatial tools in Gemini tool declarations', () => {
        const geminiService = new GeminiService();
        const request: GeminiGenerateRequest = {
            prompt: 'Align WebXR local-floor metric space with geodetic anchor',
            enableWorkspaceTools: true
        };

        const toolDeclarations = (geminiService as any).buildToolDeclarations(request);
        expect(toolDeclarations).toBeDefined();

        const fnDeclsContainer = toolDeclarations.find((t: any) => t.functionDeclarations);
        expect(fnDeclsContainer).toBeDefined();

        const fnDecls: any[] = fnDeclsContainer.functionDeclarations;
        const toolNames = fnDecls.map((d: any) => d.name);

        expect(toolNames).toContain('webxr_geospatial_align_coordinates');
        expect(toolNames).toContain('webxr_geospatial_calibrate');
        expect(toolNames).toContain('webxr_geospatial_project_vectors');

        const alignTool = fnDecls.find((d: any) => d.name === 'webxr_geospatial_align_coordinates');
        expect(alignTool.parameters.required).toContain('originAnchor');
        expect(alignTool.description).toMatch(/WGS-84 geodetic GPS.*WebXR metric space/i);

        const calibrateTool = fnDecls.find((d: any) => d.name === 'webxr_geospatial_calibrate');
        expect(calibrateTool.parameters.required).toContain('originAnchor');
        expect(calibrateTool.parameters.required).toContain('mode');
        expect(calibrateTool.description).toMatch(/anchor origin|sensor fusion|manual pin/i);

        const vectorsTool = fnDecls.find((d: any) => d.name === 'webxr_geospatial_project_vectors');
        expect(vectorsTool.parameters.required).toContain('originAnchor');
        expect(vectorsTool.description).toMatch(/road centerlines|parcel boundaries/i);
    });

    it('executes webxr_geospatial_align_coordinates tool via tool registry', async () => {
        const registry = createDefaultToolRegistry();
        const outcome = await registry.dispatch(
            'webxr_geospatial_align_coordinates',
            {
                originAnchor: {
                    latitude: 37.774929,
                    longitude: -122.419416,
                    altitudeMsl: 15.0
                },
                targetGeodetic: {
                    latitude: 37.775828,
                    longitude: -122.419416,
                    altitudeMsl: 25.0
                },
                headingDeg: 90.0,
                webXRPosition: [0, 0, 0]
            },
            {} as any
        );

        expect(outcome.exec.status).toBe('completed');
        const payload: any = outcome.resultPayload;
        expect(payload.success).toBe(true);
        expect(payload.webXRPosition).toBeDefined();
        // 0.000899 degrees north is approximately 100 meters north (-Z in ENU/WebXR)
        expect(payload.webXRPosition.z).toBeCloseTo(-100, 0);
        expect(payload.webXRPosition.y).toBeCloseTo(10, 0);

        // Heading 90 degrees (East) -> quaternion
        expect(payload.quaternion).toBeDefined();
        expect(payload.quaternion).toHaveLength(4);

        // Inverse conversion of [0, 0, 0] should return origin coordinates
        expect(payload.convertedGeodetic).toBeDefined();
        expect(payload.convertedGeodetic.latitude).toBeCloseTo(37.774929, 5);
        expect(payload.convertedGeodetic.longitude).toBeCloseTo(-122.419416, 5);
        expect(payload.convertedGeodetic.altitudeMsl).toBeCloseTo(15.0, 1);
    });

    it('executes webxr_geospatial_calibrate tool via tool registry', async () => {
        const registry = createDefaultToolRegistry();

        // 1. Anchor origin mode
        const originOutcome = await registry.dispatch(
            'webxr_geospatial_calibrate',
            {
                originAnchor: {
                    latitude: 37.774929,
                    longitude: -122.419416
                },
                mode: 'anchor-origin',
                headingOffsetDeg: 15.0
            },
            {} as any
        );

        expect(originOutcome.exec.status).toBe('completed');
        const originPayload: any = originOutcome.resultPayload;
        expect(originPayload.success).toBe(true);
        expect(originPayload.mode).toBe('anchor-origin');
        expect(originPayload.alignmentState.isAligned).toBe(true);
        expect(originPayload.alignmentState.calibrationSource).toBe('anchor-origin');
        expect(originPayload.alignmentState.headingOffsetDeg).toBeCloseTo(15.0, 4);
        // the alignment is returned, not held by any XR session: the result says so
        expect(originPayload.applied).toBe(false);
        expect(originOutcome.exec.summaryResult).toMatch(/^NOT applied: computed only\. WebXR geospatial alignment via anchor-origin mode/);
        expect(originOutcome.exec.summaryResult).toMatch(/webxr_geospatial_align_coordinates/);

        // 2. Sensors mode
        const sensorsOutcome = await registry.dispatch(
            'webxr_geospatial_calibrate',
            {
                originAnchor: {
                    latitude: 37.774929,
                    longitude: -122.419416
                },
                mode: 'sensors',
                sensorSample: {
                    latitude: 37.774935,
                    longitude: -122.419420,
                    accuracyMeters: 3.0,
                    headingDeg: 45.0
                },
                viewerPose: {
                    position: [1.0, 0.0, -2.0],
                    quaternion: [0, 0, 0, 1]
                }
            },
            {} as any
        );

        expect(sensorsOutcome.exec.status).toBe('completed');
        const sensorsPayload: any = sensorsOutcome.resultPayload;
        expect(sensorsPayload.success).toBe(true);
        expect(sensorsPayload.mode).toBe('sensors');
        expect(sensorsPayload.alignmentState.calibrationSource).toBe('sensor');
        expect(sensorsPayload.alignmentState.headingOffsetDeg).toBeCloseTo(45.0, 4);
    });

    it('executes webxr_geospatial_project_vectors tool via tool registry', async () => {
        const registry = createDefaultToolRegistry();
        const outcome = await registry.dispatch(
            'webxr_geospatial_project_vectors',
            {
                originAnchor: {
                    latitude: 37.774929,
                    longitude: -122.419416
                },
                roadCorridors: [
                    {
                        id: 'corridor-market',
                        name: 'Market St',
                        type: 'arterial',
                        coordinatesWGS84: [
                            [-122.419416, 37.774929],
                            [-122.418280, 37.775828]
                        ]
                    }
                ],
                parcels: [
                    {
                        id: 'parcel-block1',
                        name: 'Civic Building',
                        heightMeters: 30,
                        isLandmark: true,
                        polygonWGS84: [
                            [-122.419400, 37.774900],
                            [-122.419100, 37.774900],
                            [-122.419100, 37.775200],
                            [-122.419400, 37.775200]
                        ]
                    }
                ]
            },
            {} as any
        );

        expect(outcome.exec.status).toBe('completed');
        const payload: any = outcome.resultPayload;
        expect(payload.success).toBe(true);
        expect(payload.roadCount).toBe(1);
        expect(payload.parcelCount).toBe(1);
        expect(payload.projectedRoads[0].name).toBe('Market St');
        expect(payload.projectedRoads[0].pointCount).toBe(2);
        expect(payload.projectedParcels[0].name).toBe('Civic Building');
        expect(payload.projectedParcels[0].heightMeters).toBe(30);
    });

    it('resolves WebXR and ARCore geospatial tasks to Tier 1 native engine in TaskCapabilityResolver', () => {
        const result = TaskCapabilityResolver.resolveTaskCapability(
            'Align WebXR metric space with geodetic anchor and eliminate GPS drift via sensor fusion'
        );

        expect(result.taskDomain).toBe('3d');
        expect(result.canSolveNatively).toBe(true);
        expect(result.tier1Assessment.canSolveNatively).toBe(true);
        expect(result.tier1Assessment.primaryNativeEngine).toBe('threejs-webgl');
        expect(result.tier1Assessment.nativeCapabilitiesUsed).toContain('WebXR Geospatial Anchor Bridge (WebXRGeospatialAnchorBridge)');
        expect(result.tier1Assessment.suggestedNativeAction?.primitiveType).toBe('3d-scene');
    });
});

