/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Street objects, step 3 (identify and describe): one vision read per family, over its registered Street View views.
 *
 * The model is shown the photos exactly as the grounding API returned them (no crop, no re-encode) with, per photo, the
 * box the registered pose projects the scanned member into and its measured height. It answers per photo whether the
 * object is there and clear, its tight box, whether its foot shows, and, for the object as a whole, in its own words and in numbers: what it is (a label),
 * whether it is installed to stay, its plan section's squareness and aspect, its surface bands from foot to top (sRGB as
 * the photo shows them, roughness, metalness), a panel's thickness, and markings. The words label; only the numbers build.
 * Where the box holds several separate alike pieces (a row of bollards the coarse scan melted into one blob), each piece
 * comes back with its own box and mask, and the count of them (run.ts splits the member along the scan's line by them).
 *
 * Photo-inferred throughout. A reply that cannot be parsed is reported, never guessed. The masks are cut from the boxes by
 * the app's segmenter (ObjectSegmenterService.segmentBytes, in memory); a model that returns a real mask PNG over its box
 * (Gemini's box_2d + mask format) has it decoded here instead. Nothing here writes a photo or a mask of one.
 */

import { decodeImageInMemory } from '../tile-texture-transfer';
import type { ObjectLook } from './object-spec';

export const READ_PARAMS = {
    /** Segmentation masks come out best without thinking (Gemini's own guidance for box_2d + mask). */
    thinkingBudget: 0,
    maxOutputTokens: 16384,
    timeoutMs: 120_000,
    /** A mask pixel at or above this probability (0..255) is the object. */
    maskThreshold: 127
};

export interface ReadViewPrompt {
    /** The box [ymin, xmin, ymax, xmax] (0..1000) the registered pose projects the scanned member into. */
    box: [number, number, number, number];
    heightM: number;
    rangeM: number;
}

export interface ViewReading {
    image: number;
    visible: boolean;
    /** The object's own box (0..1000) and its mask as one byte a pixel over the whole image (1: the object). */
    box?: [number, number, number, number];
    mask?: Uint8Array;
    maskPixels?: number;
    footVisible: boolean;
    hiddenShare: number;
    /** The model's word on whether this is the object the box points at. */
    sameObject: boolean;
    /** When the box holds several separate alike pieces (a row the scan melted into one blob): each one's box, and its mask once segmented. */
    pieces?: Array<{ box: [number, number, number, number]; mask?: Uint8Array; pixels?: number }>;
    error?: string;
}

export interface FamilyReading {
    views: ViewReading[];
    look: ObjectLook;
    permanent: boolean;
    /** Whether the members the photos show look alike (the model's answer, for a row). */
    membersAlike?: boolean;
    /** How many separate alike pieces stand where the scan has this object (1 when it is one). */
    pieceCount: number;
}

export function familyReadPrompt(views: ReadViewPrompt[], members: number): string {
    return [
        `These ${views.length} photos are Google Street View captures of ${members > 1 ? `one of a row of ${members} alike objects standing in a street (the photos may show different members of the row)` : 'one object standing in a street'}.`,
        'In each photo the object stands inside or near a box given as [ymin, xmin, ymax, xmax] on a 0-1000 scale. The box comes from a coarse 3D scan seen from a camera pose good to about 2 m, so the object can stand well beside it; it is the thing of about the given height standing on the ground nearest the box.',
        ...views.map((v, i) => `Photo ${i + 1}: box ${JSON.stringify(v.box.map(Math.round))}, about ${v.heightM.toFixed(2)} m tall, ${v.rangeM.toFixed(0)} m from the camera.`),
        'For each photo give:',
        '- "image": its number;',
        '- "visible": true when the object is in the photo and at least half of it can be seen;',
        '- "box_2d": [ymin, xmin, ymax, xmax] (0-1000), tight around the whole object, foot to top, with anything fixed to it (a sign, an arm, a lamp head);',
        '- "footVisible": true when the point where it meets the ground can be seen;',
        '- "hiddenShare": 0 to 1, how much of it something in front hides;',
        '- "sameObject": true when this is the object at the given box (false when the box points at something else, e.g. a person or car standing there in this capture);',
        '- "pieces": only when the box holds several separate objects alike to one another standing in a row or group (bollards, posts, planters, poles), each one as {"box_2d": [...]} tight around it, nearest first; omit it otherwise.',
        'Then, for the object itself, read from all the photos:',
        '- "pieceCount": how many separate alike objects stand where the box is (1 when it is one object; a row of 6 bollards is 6);',
        '- "description": what it is (one of the pieces, when there are several), in a few plain words;',
        '- "permanent": true when it is installed to stay; false when put out for a while (a cone, an A-frame sign, a barrier for works);',
        '- "sectionExponent": the squareness of its cross-section seen from above: 2 round, 4 a rounded square, 8 or more square-cornered;',
        '- "sectionAspect": its depth over its width seen from above (1 for round or square);',
        '- "bands": its surface from the foot (fromT 0) to the top (toT 1), one entry per band of different colour or material: "fromT", "toT", "label" (a few words), "srgb" ([r, g, b] 0-255, the colour the photo shows), "roughness" (0 mirror, 0.3 satin, 0.6 matte, 1 chalky), "metalness" (1 bare metal, 0 anything else: paint, plastic, stone, concrete);',
        '- "panelThicknessM": only when it carries a flat panel (a sign face, a board): its thickness in metres;',
        '- "markings": any text, symbols or stripes on it, in words (an empty list when none);',
        ...(members > 1 ? ['- "membersAlike": true when the row\'s members in the photos look the same;'] : []),
        '- "confidence": 0 to 1, how sure you are of the description.',
        'Reply with JSON only: {"views": [...], "description": "...", "permanent": true, "sectionExponent": 2, "sectionAspect": 1, "bands": [...], "markings": [], "confidence": 0.8}'
    ].join('\n');
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/**
 * A Gemini mask (a PNG over box_2d, base64, with or without a data: prefix) as one byte a pixel over the whole image:
 * the PNG resampled onto the box's pixels (nearest), thresholded.
 */
export function maskFromReply(maskB64: string, box: [number, number, number, number], width: number, height: number, threshold = READ_PARAMS.maskThreshold): { mask: Uint8Array; pixels: number } | undefined {
    const b64 = maskB64.replace(/^data:image\/png;base64,/, '').trim();
    let png: { width: number; height: number; rgba: Uint8Array };
    try { png = decodeImageInMemory(Buffer.from(b64, 'base64')); } catch { return undefined; }
    if (!png.width || !png.height) return undefined;
    const [y0, x0, y1, x1] = box;
    const px0 = Math.max(0, Math.floor((x0 / 1000) * width)), px1 = Math.min(width, Math.ceil((x1 / 1000) * width));
    const py0 = Math.max(0, Math.floor((y0 / 1000) * height)), py1 = Math.min(height, Math.ceil((y1 / 1000) * height));
    if (px1 <= px0 || py1 <= py0) return undefined;
    const mask = new Uint8Array(width * height);
    let pixels = 0;
    for (let y = py0; y < py1; y++) {
        const sy = Math.min(png.height - 1, Math.floor(((y - py0 + 0.5) / (py1 - py0)) * png.height));
        for (let x = px0; x < px1; x++) {
            const sx = Math.min(png.width - 1, Math.floor(((x - px0 + 0.5) / (px1 - px0)) * png.width));
            // a grey PNG decodes to r = g = b; a coloured one is read by its red channel
            if (png.rgba[(sy * png.width + sx) * 4] >= threshold) { mask[y * width + x] = 1; pixels++; }
        }
    }
    return { mask, pixels };
}

/** Parses the reply; `sizes` are the photos' pixel sizes, in order. */
export function parseFamilyReading(text: string, sizes: Array<{ width: number; height: number }>): FamilyReading | { error: string } {
    let j: Record<string, unknown>;
    try { j = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, '')) as Record<string, unknown>; } catch (e) { return { error: `the reply is not JSON (${(e as Error).message})` }; }
    if (!j || typeof j !== 'object') return { error: 'the reply is not a JSON object' };
    const views: ViewReading[] = sizes.map((_, i) => ({ image: i + 1, visible: false, footVisible: false, hiddenShare: 1, sameObject: false, error: 'not in the reply' }));
    for (const v of (Array.isArray(j.views) ? j.views : []) as Array<Record<string, unknown>>) {
        const i = (num(v?.image) ?? 0) - 1;
        if (i < 0 || i >= sizes.length) continue;
        const r: ViewReading = { image: i + 1, visible: v.visible === true, footVisible: v.footVisible === true, hiddenShare: clamp01(num(v.hiddenShare) ?? 0), sameObject: v.sameObject !== false };
        const pieces = (Array.isArray(v.pieces) ? v.pieces : []) as Array<Record<string, unknown>>;
        for (const pc of pieces) {
            const pb = pc?.box_2d;
            if (!Array.isArray(pb) || pb.length !== 4 || !pb.every(x => typeof x === 'number')) continue;
            const box = (pb as number[]).map(x => Math.max(0, Math.min(1000, x))) as [number, number, number, number];
            if (box[2] > box[0] && box[3] > box[1]) (r.pieces ??= []).push({ box });
        }
        const b = v.box_2d;
        if (Array.isArray(b) && b.length === 4 && b.every(x => typeof x === 'number')) {
            const box = (b as number[]).map(x => Math.max(0, Math.min(1000, x))) as [number, number, number, number];
            if (box[2] > box[0] && box[3] > box[1]) {
                r.box = box;
                // a model that segments answers with a real PNG over the box; one that does not writes bytes that do not decode
                // (gemini-3.8-flash, 2026-11-03: CRCs and inflate fail), and the segmenter cuts the mask from the box instead
                if (typeof v.mask === 'string' && v.mask.length > 16) {
                    const m = maskFromReply(v.mask, box, sizes[i].width, sizes[i].height);
                    if (m && m.pixels) { r.mask = m.mask; r.maskPixels = m.pixels; }
                }
            }
        }
        views[i] = r;
    }
    const bands = (Array.isArray(j.bands) ? j.bands : []) as Array<Record<string, unknown>>;
    const look: ObjectLook = {
        description: typeof j.description === 'string' && j.description.trim() ? j.description.trim().slice(0, 120) : 'not described',
        ...(num(j.sectionExponent) !== undefined ? { sectionExponent: Math.max(0.5, Math.min(12, num(j.sectionExponent)!)) } : {}),
        ...(num(j.sectionAspect) !== undefined ? { sectionAspect: Math.max(0.05, Math.min(1, num(j.sectionAspect)!)) } : {}),
        bands: bands.map(b => {
            const rgb = Array.isArray(b.srgb) && b.srgb.length === 3 && b.srgb.every(x => typeof x === 'number') ? (b.srgb as number[]).map(x => Math.max(0, Math.min(255, x))) as [number, number, number] : undefined;
            const fromT = num(b.fromT), toT = num(b.toT);
            if (!rgb || fromT === undefined || toT === undefined) return undefined;
            return { fromT: clamp01(fromT), toT: clamp01(toT), ...(typeof b.label === 'string' ? { label: b.label.slice(0, 60) } : {}), srgb: rgb, roughness: clamp01(num(b.roughness) ?? 0.6), metalness: clamp01(num(b.metalness) ?? 0) };
        }).filter((b): b is NonNullable<typeof b> => !!b),
        ...(num(j.panelThicknessM) !== undefined && num(j.panelThicknessM)! > 0 ? { panelThicknessM: Math.min(0.5, num(j.panelThicknessM)!) } : {}),
        markings: (Array.isArray(j.markings) ? j.markings : []).filter((m): m is string => typeof m === 'string').map(m => m.slice(0, 120)).slice(0, 12),
        ...(num(j.confidence) !== undefined ? { confidence: clamp01(num(j.confidence)!) } : {})
    };
    return { views, look, permanent: j.permanent !== false, ...(typeof j.membersAlike === 'boolean' ? { membersAlike: j.membersAlike } : {}), pieceCount: Math.max(1, Math.round(num(j.pieceCount) ?? 1)) };
}
