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
        description: 'Generates a geometrically consistent multi-angle turnaround image set of an object, prop, vehicle or structure with an image model (Nano Banana Lite first by default). By default the hero view is generated first and every other view at once, each conditioned on the hero view (fast: about two image calls of wall time); conditioning "chained" instead generates one view at a time, each conditioned on the hero view and the previous view (slower, tighter detail between neighbouring views). Uses continuous spherical camera orbit mathematics and strict isolation (no ground/pedestal, no cast shadows, no text/labels). Optionally sends the views to Trellis on Fal.ai for a GLB (only when downstreamTarget is "trellis-fal"). The result names the image model that produced the views and why any earlier model was skipped; a step that fails fails the tool.',
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
                    description: 'Visual style: "18-percent-studio-clay" (default), "pbr-delighted", "photorealistic", or any other style description, which is used as written.'
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
                    description: 'Downstream 3D reconstruction: "none" (default) or "trellis-fal" (Trellis on Fal.ai); needs FAL_KEY, and only when the user asks for a reconstruction.'
                },
                conditioning: {
                    type: 'STRING',
                    description: '"hero-parallel" (default): every view after the hero at once, each conditioned on the hero view only. "chained": one view at a time, each conditioned on the hero and the previous view; about N/2 times slower for an N-view rig, but adjacent views agree more closely in fine detail.'
                },
                model: {
                    type: 'STRING',
                    description: 'Image model id for the views. When given, only that model is used; omit it to try Nano Banana Lite (gemini-3.1-flash-lite-image) and then the default image models in order.'
                },
                lengthMeters: {
                    type: 'NUMBER',
                    description: 'Optional real-world length of the subject in meters, returned with the GLB as its target size (the GLB is not rescaled).'
                },
                widthMeters: {
                    type: 'NUMBER',
                    description: 'Optional real-world width of the subject in meters, returned with the GLB as its target size.'
                },
                heightMeters: {
                    type: 'NUMBER',
                    description: 'Optional real-world height of the subject in meters, returned with the GLB as its target size.'
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
        const downstreamTarget = (asString(args.downstreamTarget) || 'none') as 'trellis-fal' | 'trellis' | 'none';
        // Meshy was removed from the codebase (user decision, 2026-11-02): a saved call that still asks for it is refused, not rerouted
        if ((downstreamTarget as string) === 'meshy-7.1-fal') throw new Error('generate_multi_angle_turnaround: downstreamTarget "meshy-7.1-fal" is no longer available (Meshy was removed on 2026-11-02); use "trellis-fal".');
        const model = asString(args.model) || undefined;

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
            model,
            // Stop (or the tool time limit) ends the capture before the next station or the Trellis upload.
            signal: ctx.signal,
            conditioning: asString(args.conditioning) === 'chained' ? 'chained' : 'hero-parallel',
            onProgress: (fraction, message) => ctx.reportProgress?.(message, fraction)
        });

        const downstreamSummary = result.downstreamGlb
            ? ` Trellis reconstructed ${result.downstreamGlb.path} (${result.downstreamGlb.vertexCount} vertices, ${result.downstreamGlb.triangleCount} triangles).`
            : '';
        const { views, ...rest } = result;

        return {
            resultPayload: {
                ...rest,
                // Image bytes stay on disk; the payload carries their paths.
                views: views.map(({ buffer, ...view }) => view)
            } as unknown as Record<string, unknown>,
            summaryResult: `Captured ${views.length} views of "${subject}" on rig "${rigPreset}" (${result.conditioning === 'chained' ? 'chained: each view conditioned on the hero and the previous view' : 'every view after the hero generated at once, conditioned on the hero view'}) in ${result.totalDurationMs}ms into ${outputDir}. ${result.modelNote}${downstreamSummary}`
        };
    }
};
