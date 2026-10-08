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
import { MultiAngleTurnaroundService } from '../src/node/spatial/MultiAngleTurnaroundService';
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

    describe('End-to-End Execution & Downstream Trellis Packaging', () => {
        it('executes turnaround workflow and builds valid binary .glb in mock mode', async () => {
            const tmpDir = path.resolve(process.cwd(), 'output/test_turnaround_' + Date.now());
            const service = new MultiAngleTurnaroundService();

            const result = await service.execute({
                subject: 'weathered post-apocalyptic buggy',
                rigPreset: 'dcc-ortho-4',
                stylePreset: '18-percent-studio-clay',
                outputDir: tmpDir,
                downstreamTarget: 'trellis-cloud-run',
                metricDimensions: { lengthMeters: 4.2, heightMeters: 1.6, widthMeters: 2.1 },
                mockExecution: true
            });

            expect(result.success).toBe(true);
            expect(result.views).toHaveLength(4);
            expect(result.downstreamGlb).toBeDefined();
            expect(result.downstreamGlb?.vertexCount).toBeGreaterThan(0);
            expect(result.downstreamGlb?.boundingBoxMeters).toEqual([4.2, 1.6, 2.1]);

            // Verify file exists on disk
            if (result.downstreamGlb?.path) {
                expect(fs.existsSync(result.downstreamGlb.path)).toBe(true);
                const buf = fs.readFileSync(result.downstreamGlb.path);
                expect(buf.toString('utf8', 0, 4)).toBe('glTF'); // glTF binary magic
            }

            // Cleanup
            await fs.promises.rm(tmpDir, { recursive: true, force: true });
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
            const res = await handler(
                {
                    subject: 'test sci-fi console',
                    rigPreset: 'dcc-ortho-4',
                    mockExecution: true
                },
                { workspaceRoot: process.cwd(), activeCanvasType: '3d-scene' }
            );

            expect(res.summaryResult).toContain('Captured 4 consistent views');
            expect((res.resultPayload as any).views).toHaveLength(4);

            // Clean up created output dir
            const outViews = (res.resultPayload as any).views;
            if (outViews && outViews.length > 0) {
                const parentDir = path.dirname(outViews[0].imagePath);
                await fs.promises.rm(parentDir, { recursive: true, force: true });
            }
        });
    });
});
