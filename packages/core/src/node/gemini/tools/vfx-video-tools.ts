/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { buildBeautifyPrompt } from '../../../browser/generative-canvas/services/location-beautify-service';
import type { ToolDeclaration, ToolHandler } from './types';

function asString(val: unknown): string {
    return typeof val === 'string' ? val : '';
}

export const AI_BEAUTIFY_TOOL_DECLARATIONS: ToolDeclaration[] = [
    {
        name: 'build_beautify_prompt',
        description: 'Construct the exact AI Beautify instruction prompt to transform a photorealistic 3D tiles rendering into a photorealistic photograph with non-negotiable 3D camera framing rules, matching canvas aspect ratio, and authentic physical materials.',
        parameters: {
            type: 'OBJECT',
            properties: {
                locationName: {
                    type: 'STRING',
                    description: 'Name of the geographic location or architectural landmark (e.g. "Independence Hall, Philadelphia", "Midtown Manhattan Empire State Building")'
                },
                coords: {
                    type: 'STRING',
                    description: 'Camera geographic coordinates formatted as "latitude, longitude" (e.g. "39.948900, -75.150000")'
                },
                heading: {
                    type: 'NUMBER',
                    description: 'Camera heading azimuth in degrees (0 = North, 90 = East, 180 = South, 270 = West)'
                },
                earthUrl: {
                    type: 'STRING',
                    description: 'Optional Google Earth web vantage reference link'
                },
                aspectRatio: {
                    type: 'STRING',
                    description: 'Canvas aspect ratio (e.g. "16:9", "9:16", "1:1", "4:3")'
                },
                moodPromptContext: {
                    type: 'STRING',
                    description: 'Optional atmospheric lighting and environmental mood context'
                },
                distance: {
                    type: 'NUMBER',
                    description: 'Optional approximate subject distance in meters from camera for depth-of-field and aerial perspective'
                },
                styleSuffix: {
                    type: 'STRING',
                    description: 'Optional caller-supplied artistic style and related generation modifiers'
                }
            },
            required: ['locationName']
        }
    }
];

export const aiBeautifyHandlers: Record<string, ToolHandler> = {
    build_beautify_prompt: (args, _ctx) => {
        const locationName = asString(args.locationName);
        if (!locationName) throw new Error('build_beautify_prompt: "locationName" argument is required.');

        const coords = asString(args.coords) || undefined;
        const heading = typeof args.heading === 'number' ? args.heading : (args.heading ? parseFloat(String(args.heading)) : undefined);
        const earthUrl = asString(args.earthUrl) || undefined;
        const aspectRatio = asString(args.aspectRatio) || '16:9';
        const moodPromptContext = asString(args.moodPromptContext) || undefined;
        const distance = typeof args.distance === 'number' ? args.distance : (args.distance ? parseFloat(String(args.distance)) : undefined);
        const styleSuffix = asString(args.styleSuffix) || undefined;

        const prompt = buildBeautifyPrompt({
            locationName,
            coords,
            heading,
            earthUrl,
            aspectRatio,
            moodPromptContext,
            distance,
            styleSuffix
        });

        return {
            resultPayload: {
                success: true,
                prompt,
                locationName,
                coords: coords || '0.000000, 0.000000',
                heading: heading !== undefined ? Math.round(heading) : 0,
                aspectRatio
            },
            summaryResult: `Constructed AI Beautify prompt for ${locationName} with non-negotiable 3D framing rules.`
        };
    }
};
