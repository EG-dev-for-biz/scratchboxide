/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as path from 'path';
import type { ToolDeclaration, ToolHandler } from './types';
import {
    MultiAngleTurnaroundService,
    type RigPreset
} from '../../spatial/MultiAngleTurnaroundService';

function asString(val: unknown): string {
    return typeof val === 'string' ? val : '';
}

function asBoolean(val: unknown, defaultVal = false): boolean {
    if (typeof val === 'boolean') return val;
    if (typeof val === 'string') return val.toLowerCase() === 'true';
    return defaultVal;
}

export const TURNAROUND_TOOL_DECLARATIONS: ToolDeclaration[] = [
    {
        name: 'generate_multi_angle_turnaround',
        description: 'Generates a geometrically consistent multi-angle turnaround image capture set across 3D objects, props, vehicles, or architectural scenes using the Adaptive Multi-Angle Camera Orbit Engine (Nano Banana Lite). Enforces continuous spherical camera orbit mathematics, dual-anchor identity conditioning (Hero Anchor + Adjacent Continuity), and strict negative isolation invariants (zero ground/pedestal, zero cast shadows, zero text/labels) for seamless downstream 3D reconstruction (Cloud Run Trellis, 3DGS, NeRF).',
        parameters: {
            type: 'OBJECT',
            properties: {
                subject: {
                    type: 'STRING',
                    description: 'Natural language description of the subject, prop, vehicle, architectural structure, or scene.'
                },
                rigPreset: {
                    type: 'STRING',
                    description: 'Camera orbit rig preset: "dcc-ortho-4" (default for Trellis CAD), "turntable-8" (for 3DGS/photogrammetry), "dome-hemisphere-12", or "custom".'
                },
                stylePreset: {
                    type: 'STRING',
                    description: 'Visual styling contract: "18-percent-studio-clay" (default), "pbr-delighted", or "photorealistic".'
                },
                floatingVoid: {
                    type: 'BOOLEAN',
                    description: 'Whether subject must float in 100% white void with zero ground, floor, or pedestal (default: true).'
                },
                suppressShadows: {
                    type: 'BOOLEAN',
                    description: 'Whether directional cast shadows must be strictly eliminated in favor of diffuse ambient light (default: true).'
                },
                suppressText: {
                    type: 'BOOLEAN',
                    description: 'Whether text, dimensions, and labels must be strictly eliminated (default: true).'
                },
                downstreamTarget: {
                    type: 'STRING',
                    description: 'Optional downstream 3D reconstruction pipeline: "trellis-cloud-run" or "none".'
                },
                lengthMeters: {
                    type: 'NUMBER',
                    description: 'Optional real-world physical length in meters for downstream .glb scaling.'
                },
                widthMeters: {
                    type: 'NUMBER',
                    description: 'Optional real-world physical width in meters for downstream .glb scaling.'
                },
                heightMeters: {
                    type: 'NUMBER',
                    description: 'Optional real-world physical height in meters for downstream .glb scaling.'
                },
                mockExecution: {
                    type: 'BOOLEAN',
                    description: 'Run in offline emulation mode if no live GPU or network is available.'
                }
            },
            required: ['subject']
        }
    }
];

export const turnaroundHandlers: Record<string, ToolHandler> = {
    generate_multi_angle_turnaround: async (args, ctx) => {
        const subject = asString(args.subject);
        if (!subject) throw new Error('generate_multi_angle_turnaround: "subject" argument is required.');

        const rigPreset = (asString(args.rigPreset) || 'dcc-ortho-4') as RigPreset;
        const stylePreset = (asString(args.stylePreset) || '18-percent-studio-clay');
        const floatingVoid = asBoolean(args.floatingVoid, true);
        const suppressShadows = asBoolean(args.suppressShadows, true);
        const suppressText = asBoolean(args.suppressText, true);
        const downstreamTarget = (asString(args.downstreamTarget) || 'none') as 'trellis-cloud-run' | 'none';
        const mockExecution = asBoolean(args.mockExecution, false);

        const metricDimensions = (args.lengthMeters || args.widthMeters || args.heightMeters)
            ? {
                lengthMeters: typeof args.lengthMeters === 'number' ? args.lengthMeters : undefined,
                widthMeters: typeof args.widthMeters === 'number' ? args.widthMeters : undefined,
                heightMeters: typeof args.heightMeters === 'number' ? args.heightMeters : undefined
            }
            : undefined;

        const outputDir = path.join(ctx.workspaceRoot || process.cwd(), 'output/turnarounds', `${Date.now()}`);

        const service = new MultiAngleTurnaroundService();
        const result = await service.execute({
            subject,
            rigPreset,
            stylePreset,
            isolation: { floatingVoid, suppressShadows, suppressText },
            downstreamTarget,
            metricDimensions,
            outputDir,
            mockExecution
        });

        const downstreamSummary = result.downstreamGlb
            ? `, synthesized downstream .glb at ${result.downstreamGlb.url} (${result.downstreamGlb.vertexCount} verts)`
            : '';

        return {
            resultPayload: result as unknown as Record<string, unknown>,
            summaryResult: `Captured ${result.views.length} consistent views for "${subject}" using rig "${rigPreset}" in ${result.totalDurationMs}ms${downstreamSummary}.`
        };
    }
};
