/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { ChronoSpatialDeductionEngine, type ShadowDeductionInput } from '../../spatial/ChronoSpatialDeductionEngine';
import type { ToolContext, ToolDeclaration, ToolHandler, ToolHandlerOutcome } from './types';

/**
 * Reverse shadow-geolocation: solves the inverse solar ephemeris at a candidate lat/lng for the
 * date/time whose sun position would cast a shadow with the observed azimuth and length/height
 * ratio. Useful for OSINT-style photo geolocation/dating and for verifying a claimed capture time
 * against a photographed shadow, independent of any EXIF timestamp.
 */
export const CHRONO_SHADOW_TOOL_DECLARATIONS: ToolDeclaration[] = [
    {
        name: 'chrono_deduce_datetime_from_shadow',
        description:
            'Solves the inverse solar ephemeris: given a candidate geographic location and a shadow observed in a photo (its compass azimuth and its length-to-object-height ratio), finds the date/time at that location whose sun position would cast exactly that shadow. Useful for OSINT-style photo geolocation and dating (narrowing when a photo at a known or candidate location was taken), and for verifying a claimed capture time against the shadow actually visible in an image. Returns the best-matching date/time plus up to 3 alternative dates (shadow geometry repeats across the year), each with a confidence score.',
        parameters: {
            type: 'OBJECT',
            properties: {
                candidateLat: {
                    type: 'NUMBER',
                    description: 'Candidate location latitude in decimal degrees (WGS-84).'
                },
                candidateLng: {
                    type: 'NUMBER',
                    description: 'Candidate location longitude in decimal degrees (WGS-84).'
                },
                observedShadowAngleDeg: {
                    type: 'NUMBER',
                    description: 'Compass azimuth the shadow points toward, in degrees (0 = North, 90 = East, 180 = South, 270 = West).'
                },
                observedShadowLengthRatio: {
                    type: 'NUMBER',
                    description: 'Observed shadow length divided by the height of the object casting it (shadow_length / object_height). A long thin shadow near sunrise/sunset gives a large ratio; a short shadow near solar noon gives a small one.'
                }
            },
            required: ['candidateLat', 'candidateLng', 'observedShadowAngleDeg', 'observedShadowLengthRatio']
        }
    }
];

function asFiniteNumber(val: unknown, field: string): number {
    if (typeof val !== 'number' || !Number.isFinite(val)) {
        throw new Error(`chrono_deduce_datetime_from_shadow: '${field}' must be a finite number`);
    }
    return val;
}

function serializeAlternative(alt: { date: Date; confidenceScore: number }): { date: string; confidenceScore: number } {
    return { date: alt.date.toISOString(), confidenceScore: alt.confidenceScore };
}

async function deduceDatetimeFromShadowHandler(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolHandlerOutcome> {
    try {
        const input: ShadowDeductionInput = {
            candidateLat: asFiniteNumber(args.candidateLat, 'candidateLat'),
            candidateLng: asFiniteNumber(args.candidateLng, 'candidateLng'),
            observedShadowAngleDeg: asFiniteNumber(args.observedShadowAngleDeg, 'observedShadowAngleDeg'),
            observedShadowLengthRatio: asFiniteNumber(args.observedShadowLengthRatio, 'observedShadowLengthRatio')
        };

        const result = ChronoSpatialDeductionEngine.solveInverseSolar(input);

        if (!result) {
            return {
                status: 'failed',
                resultPayload: {
                    error: 'No solar ephemeris match was found within the solver\'s error bounds for the given shadow angle and length ratio at this location. Verify the shadow azimuth and ratio were measured correctly.'
                },
                summaryResult: 'Shadow deduction failed: no matching sun position found.'
            };
        }

        const estimatedDateIso = result.estimatedDate.toISOString();

        return {
            status: 'completed',
            resultPayload: {
                candidateLat: input.candidateLat,
                candidateLng: input.candidateLng,
                estimatedDate: estimatedDateIso,
                solarAltitudeDeg: result.solarAltitudeDeg,
                solarAzimuthDeg: result.solarAzimuthDeg,
                confidenceScore: result.confidenceScore,
                alternativeDates: result.alternativeDates.map(serializeAlternative)
            },
            summaryResult: `Best match: ${estimatedDateIso}, confidence ${result.confidenceScore.toFixed(2)} (sun alt ${result.solarAltitudeDeg.toFixed(1)}°, az ${result.solarAzimuthDeg.toFixed(1)}°)${result.alternativeDates.length > 0 ? `, ${result.alternativeDates.length} alternative date(s)` : ''}.`
        };
    } catch (e) {
        return { status: 'failed', resultPayload: { error: String(e instanceof Error ? e.message : e) } };
    }
}

export const chronoShadowHandlers: Array<[ToolDeclaration, ToolHandler]> = [
    [CHRONO_SHADOW_TOOL_DECLARATIONS[0], deduceDatetimeFromShadowHandler]
];
