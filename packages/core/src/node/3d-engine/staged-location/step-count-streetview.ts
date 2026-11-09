/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * A melted flight's step count from Street View (ground-steps.ts StepCounter). Panos near the flight are found by the
 * free metadata query at points across its front and off its sides (Google's own captures only); the nearest that see it
 * (from its side, where the step profile shows, and from its front, where the risers show as lines, then the next nearest)
 * are fetched through the Maps Imagery Grounding API, at most four, in memory only, as the streetview-evidence.ts route
 * has them (no decode, no write, no log). A vision model counts the risers on each, told what the scan measured (the
 * rise, the length, the width). Two counts must agree within one; three or more give their median. */

import type { GenerateContentResponse } from '@google/genai';
import type { GeodeticOrigin } from '../../spatial/StreetViewSurveyPlanner';
import { VisionModelChain, type VisionGenAIClient, type VisionModelChainOptions } from '../../gemini/vision-model-chain';
import { bearingDeg, discoverPanosAt, fetchViews, missingCredentials, type SelectedView, type StreetViewEvidenceDeps } from './streetview-evidence';
import type { InclineReading, StepCount, StepCounter } from './ground-steps';

export const STEP_COUNT_PARAMS = {
    /** A pano sees the flight from this far (m): nearer, it fills the frame; further, the risers blur. */
    minDistanceM: 5, maxDistanceM: 45,
    /** Up to this many views fetched a flight (the nearest, from its side and its front first): the grounding API refuses
     *  some panos, and the counts of all that arrive are combined. */
    views: 4,
    /** The pano's eye above its ground (m). */
    eyeM: 2.5
};

/** The flight's plan corners and centre, in the tile frame. */
function flightPoints(f: InclineReading): { centre: { x: number; z: number }; around: Array<{ x: number; z: number }> } {
    const at = (s: number, b: number) => ({ x: f.cx + f.ux * s + f.vx * b, z: f.cz + f.uz * s + f.vz * b });
    const sm = (f.sFoot + f.sTop) / 2, bm = (f.bMin + f.bMax) / 2;
    // in front of the foot at two distances, across its width (the nearest pano to a point may be a visitor's photosphere,
    // not Google's), and off either side, a street's width away
    const w = f.bMax - f.bMin;
    const front = [10, 18].flatMap(d => [f.bMin + w / 4, bm, f.bMax - w / 4].map(b => at(f.sFoot - d, b)));
    return { centre: at(sm, bm), around: [...front, at(sm, f.bMin - 10), at(sm, f.bMax + 10)] };
}

/** The reply: {"risers": n | null, "confidence": 0..1}. */
export function parseStepCountReply(text: string): { risers?: number; confidence?: number } {
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return {};
    try {
        const j = JSON.parse(m[0]) as { risers?: unknown; confidence?: unknown };
        const risers = typeof j.risers === 'number' && Number.isFinite(j.risers) && j.risers >= 1 ? Math.round(j.risers) : undefined;
        const confidence = typeof j.confidence === 'number' ? Math.max(0, Math.min(1, j.confidence)) : undefined;
        return { ...(risers !== undefined ? { risers } : {}), ...(confidence !== undefined ? { confidence } : {}) };
    } catch {
        return {};
    }
}

/** The counts of the views combined: one, or two within one of each other (the larger: a riser hidden is likelier than one invented). */
export function combineStepCounts(counts: number[]): number | undefined {
    if (!counts.length) return undefined;
    if (counts.length === 1) return counts[0];
    const s = [...counts].sort((a, b) => a - b);
    if (s.length === 2) return s[1] - s[0] <= 1 ? s[1] : undefined;
    return s[Math.floor(s.length / 2)];
}

export function streetViewStepCounter(deps: {
    origin: GeodeticOrigin;
    streetView: StreetViewEvidenceDeps;
    vision: { client: VisionGenAIClient; candidates: string[] };
    groundAt: (x: number, z: number) => number;
    signal?: AbortSignal;
    chainExtras?: Pick<VisionModelChainOptions<string>, 'replyCache' | 'hedgeAfterMs' | 'sleep'>;
    onProgress?: (message: string) => void;
}): StepCounter {
    return async (f: InclineReading): Promise<StepCount> => {
        const missing = missingCredentials(deps.streetView);
        if (missing) return { reason: missing };
        const { centre, around } = flightPoints(f);
        const found = await discoverPanosAt(deps.origin, around, deps.streetView, deps.signal, centre);
        const width = f.bMax - f.bMin, length = f.sTop - f.sFoot, midY = (f.footY + f.topY) / 2;
        // the views: the nearest panos in reach, one from the side (across the slope) and one from the front where both exist
        const ranked = found.panos.map(p => {
            const dx = centre.x - p.x, dz = centre.z - p.z, d = Math.hypot(dx, dz);
            const along = Math.abs((dx * f.ux + dz * f.uz) / Math.max(1e-6, d));
            return { p, d, side: along < 0.5 };
        }).filter(c => c.d >= STEP_COUNT_PARAMS.minDistanceM && c.d <= STEP_COUNT_PARAMS.maxDistanceM).sort((a, b) => a.d - b.d);
        // the nearest from the side and from the front first, then the next nearest
        const first = [ranked.find(c => c.side), ranked.find(c => !c.side)].filter((c): c is NonNullable<typeof c> => !!c);
        const picks = [...first, ...ranked.filter(c => !first.includes(c))].slice(0, STEP_COUNT_PARAMS.views);
        if (!picks.length) return { reason: `no Street View pano within ${STEP_COUNT_PARAMS.maxDistanceM} m sees the flight (${found.panos.length} near it)` };
        const views: SelectedView[] = picks.map(({ p, d }) => {
            const g = deps.groundAt(p.x, p.z), eyeY = (g === g ? g : f.footY) + STEP_COUNT_PARAMS.eyeM;
            const heading = bearingDeg(p.x, p.z, centre.x, centre.z);
            const fov = Math.max(30, Math.min(90, 2 * Math.atan((Math.max(width, length) / 2 + 2) / d) * 180 / Math.PI));
            return { panoId: p.panoId, ...(p.date ? { date: p.date } : {}), ...(p.copyright ? { copyright: p.copyright } : {}), eye: [p.x, eyeY, p.z], facadeHeadingDeg: heading, headingDeg: heading, pitchDeg: Math.atan2(midY - eyeY, d) * 180 / Math.PI, fovDeg: fov, aspectRatio: 'RATIO_4X3', distanceM: d, score: 1 / d };
        });
        deps.onProgress?.(`counting the steps of a melted flight on ${views.length} Street View view${views.length === 1 ? '' : 's'}`);
        const got = await fetchViews(views, deps.streetView, deps.signal);
        if (!got.images.length) return { reason: `the Street View view${views.length === 1 ? '' : 's'} did not arrive (${got.failures.map(x => x.error).join('; ')})` };
        const chain = new VisionModelChain<string>({ client: deps.vision.client, candidates: deps.vision.candidates, ...(deps.signal ? { signal: deps.signal } : {}), ...(deps.chainExtras ?? {}) });
        const prompt = `This Street View image looks at a flight of outdoor steps near its centre. The 3D scan measures it rising ${(f.topY - f.footY).toFixed(2)} m over ${length.toFixed(1)} m, ${width.toFixed(1)} m wide, but cannot tell the single steps apart. Count the risers (the vertical faces) from the ground to the top, counting any landing as level ground, not as a step. Reply only with JSON: {"risers": <count>, "confidence": <0 to 1>}, or {"risers": null} if the steps cannot be counted in this image.`;
        const counts: number[] = [];
        for (const im of got.images) {
            const r = await chain.generate({ contents: [{ role: 'user', parts: [{ inlineData: { mimeType: im.mimeType, data: im.bytes.toString('base64') } }, { text: prompt }] }], config: { responseMimeType: 'application/json', temperature: 0, ...(deps.signal ? { abortSignal: deps.signal } : {}) } }, { stage: 'roads' });
            const text = ((r.response as GenerateContentResponse).candidates?.[0]?.content?.parts ?? []).filter(p => !(p as { thought?: boolean }).thought).map(p => p.text ?? '').join('');
            const parsed = parseStepCountReply(text);
            if (parsed.risers !== undefined) { counts.push(parsed.risers); r.remember(); }
        }
        const count = combineStepCounts(counts);
        if (count === undefined) return { reason: counts.length ? `the views disagree on the count (${counts.join(', ')})` : 'the model could not count the steps on the views' };
        return { count, views: counts.length, note: `counts ${counts.join(', ')}` };
    };
}
