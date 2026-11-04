/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Openings read from a blueprint's drawings: the areas set into an object's surface (openings, recessed panels, glass
 * behind frames, vents) in its front and side views, in metres in the object build frame. The views are orthographic,
 * so a pixel maps straight to (x, y) in the front view and (z, y) in the side view, by the same scaling as the outlines.
 *
 *   1. A vision model boxes each such area in the two drawings, in its own words (no list of kinds).
 *   2. The object segmenter (ObjectSegmenterService: MediaPipe, refined by GrabCut) traces the region inside each box;
 *      its extent replaces the box. The vision model's own masks are never used (they are invented). A region the
 *      segmenter cannot trace keeps its box and says why.
 *   3. Each extent is converted to metres: in the front view the object's right (+X) is on the viewer's left.
 *
 * Every opening is labelled generated: it is read from generated drawings.
 */

import type { GenerateContentClient } from './reference-object-builder';
import type { Silhouette, Vec3 } from './blueprint-outlines';

/** [x0, y0, x1, y1] as fractions of an image's width and height. */
export type NormBox = [number, number, number, number];

export interface BlueprintOpening {
    view: 'front' | 'side';
    /** What the vision model saw there, in its words (a label only; nothing branches on it). */
    label: string;
    /** The extent across the view in metres: x in the front view (+X the object's right), z in the side view (+Z its front). */
    across: [number, number];
    /** The extent up the view in metres, from the ground. */
    height: [number, number];
    /** True when the segmenter traced the region; false when only the vision model's box stands, with the reason. */
    traced: boolean;
    note?: string;
    provenance: 'generated';
}

export const OPENINGS_VISION_MODELS = ['gemini-3.8-flash', 'gemini-4-argon'];

export function openingsPrompt(subject: string): string {
    return [
        `Image 1 is an orthographic front view and image 2 an orthographic side view (its front to the right) of: ${subject}.`,
        'List every area set into the object\'s surface rather than flush with it: openings, recessed panels, grilles, vents, intakes, outlets, glass behind its frames. Only areas inside the object\'s outline, each one separately (a left and a right one are two).',
        'For each give view ("front" for image 1, "side" for image 2), label (a few words of what it is) and box [x0, y0, x1, y1] as fractions of that image\'s width and height, tight around the area.',
        'Reply with JSON only: {"regions": [{"view": "front", "label": "...", "box": [0.1, 0.5, 0.3, 0.6]}]}.'
    ].join('\n');
}

/** The regions in a model's reply, keeping only well-formed ones (view, label, a box of four fractions in order). */
export function parseRegions(text: string): Array<{ view: 'front' | 'side'; label: string; box: NormBox }> {
    const start = text.indexOf('{'), end = text.lastIndexOf('}');
    if (start < 0 || end <= start) return [];
    let value: unknown;
    try { value = JSON.parse(text.slice(start, end + 1)); } catch { return []; }
    const regions = (value as { regions?: unknown })?.regions;
    if (!Array.isArray(regions)) return [];
    return regions.flatMap(r => {
        const v = r as Record<string, unknown>;
        const box = v.box;
        if ((v.view !== 'front' && v.view !== 'side') || typeof v.label !== 'string' || !Array.isArray(box) || box.length !== 4
            || !box.every(n => typeof n === 'number' && n >= 0 && n <= 1) || box[2] <= box[0] || box[3] <= box[1]) return [];
        return [{ view: v.view, label: v.label.slice(0, 80), box: box as NormBox }];
    });
}

/** A normalised box in a view, in metres in the build frame, by the outlines' scaling (sizeMeters [W, H, L]). */
export function boxToMeters(view: 'front' | 'side', box: NormBox, s: Silhouette, sizeMeters: Vec3): { across: [number, number]; height: [number, number] } {
    const [W, H, L] = sizeMeters;
    const w = s.box.x1 - s.box.x0 + 1, h = s.box.y1 - s.box.y0 + 1;
    const px = (f: number) => f * s.width, py = (f: number) => f * s.height;
    const up = (f: number) => Math.max(0, Math.min(H, (s.box.y1 + 1 - py(f)) / h * H));
    const r = (v: number) => Math.round(v * 1000) / 1000;
    const height: [number, number] = [r(up(box[3])), r(up(box[1]))];
    if (view === 'side') {
        const z = (f: number) => Math.max(-L / 2, Math.min(L / 2, (px(f) - s.box.x0) / w * L - L / 2));
        return { across: [r(z(box[0])), r(z(box[2]))], height };
    }
    // the front view faces the object: its right (+X) is on the viewer's left
    const x = (f: number) => Math.max(-W / 2, Math.min(W / 2, -((px(f) - s.box.x0) / w * W - W / 2)));
    return { across: [r(x(box[2])), r(x(box[0]))], height };
}

export interface FindOpeningsDeps {
    /** Traces the region in a box of the image at imagePath; resolves to its extent as a normalised box. */
    segment: (imagePath: string, box: NormBox) => Promise<NormBox>;
    models?: string[];
    signal?: AbortSignal;
}

export async function findOpenings(
    client: GenerateContentClient,
    subject: string,
    views: { front: { image: { data: Buffer; mimeType: string }; path: string; silhouette: Silhouette }; side: { image: { data: Buffer; mimeType: string }; path: string; silhouette: Silhouette } },
    sizeMeters: Vec3,
    deps: FindOpeningsDeps
): Promise<{ openings: BlueprintOpening[]; model: string }> {
    let text = '', model = '';
    const skipped: string[] = [];
    for (const m of deps.models ?? OPENINGS_VISION_MODELS) {
        try {
            const res = await client.models.generateContent({
                model: m,
                contents: [{ role: 'user', parts: [
                    { inlineData: { data: views.front.image.data.toString('base64'), mimeType: views.front.image.mimeType } },
                    { inlineData: { data: views.side.image.data.toString('base64'), mimeType: views.side.image.mimeType } },
                    { text: openingsPrompt(subject) }
                ] }],
                config: { responseMimeType: 'application/json', abortSignal: deps.signal }
            });
            text = res.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') ?? '';
            model = res.modelVersion || m;
            break;
        } catch (err) {
            skipped.push(`${m}: ${(err as Error)?.message || err}`);
        }
    }
    if (!model) throw new Error(`No vision model read the openings (${skipped.join('; ')}).`);
    const openings: BlueprintOpening[] = [];
    for (const region of parseRegions(text)) {
        const view = views[region.view];
        let box = region.box, traced = false, note: string | undefined;
        try {
            box = await deps.segment(view.path, region.box);
            traced = true;
        } catch (err) {
            note = `not traced (${(err as Error)?.message || err}); the vision model's box stands`;
        }
        const m = boxToMeters(region.view, box, view.silhouette, sizeMeters);
        openings.push({ view: region.view, label: region.label, ...m, traced, ...(note ? { note } : {}), provenance: 'generated' });
    }
    return { openings, model };
}
