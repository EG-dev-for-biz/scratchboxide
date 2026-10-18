/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * 2D masks of the requested structure in registered views, for tile_refine's multi-view mask voting (object ownership,
 * scratchbox_mask_vote.hpp).
 *
 * Each view (views.txt + <name>.png, written by TileRefineService.renderOwnershipViews or any other registered source)
 * goes to the vision model with one open-ended question: outline the structure the request names, every visible part of
 * it, and nothing else. There are no classes: "the requested structure" against "everything else". The model answers
 * with outline polygons (with holes where the background shows through an opening), normalised [y, x] in 0..1000; they
 * are filled into an 8-bit mask, <name>.mask.png (255 = the structure). Vertex AI does not decode Gemini's native
 * segmentation tokens into mask images, so outlines are what the model can return reliably.
 *
 * A view the model cannot read, or where it says the structure is not visible, gets no mask: it then casts no vote,
 * which is recorded, never guessed.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { VisionModelChain } from '../../gemini/vision-model-chain';
import { encodePng } from './png-encode';
import { decodeImageInMemory } from './tile-texture-transfer';

export interface OwnershipViewEntry { name: string; width: number; height: number }

/** The views listed in `<dir>/views.txt` (name W H ... per line, '#' comments). */
export function readOwnershipViewList(dir: string): OwnershipViewEntry[] {
    return fs.readFileSync(path.join(dir, 'views.txt'), 'utf8').split('\n')
        .filter(l => l.trim() && !l.startsWith('#'))
        .map(l => { const f = l.trim().split(/\s+/); return { name: f[0], width: Number(f[1]), height: Number(f[2]) }; });
}

export type Ring = Array<[number, number]>;
export interface OutlinePolygon { outer: Ring; holes: Ring[] }
export interface OutlineReply { visible: boolean; polygons: OutlinePolygon[] }

const isPoint = (p: unknown): p is [number, number] => Array.isArray(p) && p.length >= 2 && Number.isFinite(Number(p[0])) && Number.isFinite(Number(p[1]));
const ringOf = (r: unknown): Ring | undefined => {
    if (!Array.isArray(r)) return undefined;
    const pts = r.filter(isPoint).map(p => [Number(p[0]), Number(p[1])] as [number, number]);
    return pts.length >= 3 ? pts : undefined;
};

/** Parses the model's outline answer (JSON, possibly fenced). Throws when it is not the asked shape. */
export function parseOutlineReply(text: string): OutlineReply {
    const body = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
    let j: any; // eslint-disable-line @typescript-eslint/no-explicit-any
    try { j = JSON.parse(body); } catch { throw new Error(`the outline answer is not JSON: ${text.slice(0, 120)}`); }
    if (typeof j !== 'object' || j === null || !Array.isArray(j.polygons)) throw new Error('the outline answer has no polygons list');
    const polygons: OutlinePolygon[] = [];
    for (const p of j.polygons) {
        const outer = ringOf(p?.outer);
        if (!outer) continue;
        polygons.push({ outer, holes: Array.isArray(p?.holes) ? p.holes.map(ringOf).filter((r: Ring | undefined): r is Ring => !!r) : [] });
    }
    return { visible: j.visible !== false && polygons.length > 0, polygons };
}

/**
 * Fills outline polygons ([y, x] normalised to 0..1000) into a W x H mask (255 inside). Each polygon is filled even-odd
 * over its outer ring and its holes (sampled at pixel centres); polygons are united.
 */
export function rasterizeOutlines(polygons: OutlinePolygon[], width: number, height: number): Uint8Array {
    const mask = new Uint8Array(width * height);
    const xs: number[] = [];
    for (const poly of polygons) {
        const rings = [poly.outer, ...poly.holes].map(r => r.map(([y, x]) => [x / 1000 * width, y / 1000 * height] as [number, number]));
        let y0 = height, y1 = -1;
        for (const r of rings) for (const [, y] of r) { y0 = Math.min(y0, Math.floor(y)); y1 = Math.max(y1, Math.ceil(y)); }
        for (let py = Math.max(0, y0); py <= Math.min(height - 1, y1); py++) {
            const cy = py + 0.5;
            xs.length = 0;
            for (const r of rings) {
                for (let i = 0; i < r.length; i++) {
                    const [ax, ay] = r[i], [bx, by] = r[(i + 1) % r.length];
                    if ((ay <= cy) === (by <= cy)) continue;
                    xs.push(ax + (cy - ay) / (by - ay) * (bx - ax));
                }
            }
            xs.sort((a, b) => a - b);
            for (let k = 0; k + 1 < xs.length; k += 2) {
                const xa = Math.max(0, Math.ceil(xs[k] - 0.5)), xb = Math.min(width - 1, Math.floor(xs[k + 1] - 0.5));
                for (let px = xa; px <= xb; px++) mask[py * width + px] = 255;
            }
        }
    }
    return mask;
}

/** The question for one view: open-ended, the structure the request names against everything else. */
export function outlinePrompt(target: string, width: number, height: number): string {
    return `This is a ${width} × ${height} px view of a 3D scan. Outline "${target}": the one structure the request names, standing near the centre of the image. ` +
        'Include every visible part of it and nothing else: not the ground or pavement it stands on, and not anything in front of it, touching it, attached to its base or behind it ' +
        '(whatever that is), unless it is built as part of the structure itself. Where something in front hides part of it, leave that part out. ' +
        'Follow the silhouette closely (corners, cornices, steps in the outline), with at least 16 points per outline; where the background shows through an opening in it, give that opening as a hole. ' +
        'Answer with JSON only: {"visible": boolean, "polygons": [{"outer": [[y, x], ...], "holes": [[[y, x], ...], ...]}]}, coordinates normalised to 0-1000 ([y, x] order, like box_2d).';
}

export interface SegmentOwnershipResult {
    /** Where views.txt and the masks are (a copy of the views list next to the masks). */
    masksDir: string;
    masks: number;
    views: number;
    skipped: Array<{ view: string; reason: string }>;
    model?: string;
    ms: number;
}

/**
 * Asks the vision model for the target's outline in every view of `viewsDir` and writes `<masksDir>/<name>.mask.png` (and
 * a copy of views.txt). Views are asked `concurrency` at a time.
 */
export async function segmentOwnershipViews(opts: {
    viewsDir: string; masksDir: string; target: string; chain: VisionModelChain<string>; concurrency?: number; onProgress?: (m: string) => void;
}): Promise<SegmentOwnershipResult> {
    const t0 = Date.now();
    const views = readOwnershipViewList(opts.viewsDir);
    fs.mkdirSync(opts.masksDir, { recursive: true });
    fs.copyFileSync(path.join(opts.viewsDir, 'views.txt'), path.join(opts.masksDir, 'views.txt'));
    const skipped: SegmentOwnershipResult['skipped'] = [];
    let masks = 0, done = 0, model: string | undefined;
    let next = 0;
    const work = async () => {
        for (let i; (i = next++) < views.length;) {
            const v = views[i];
            const out = path.join(opts.masksDir, `${v.name}.mask.png`);
            try {
                const png = fs.readFileSync(path.join(opts.viewsDir, `${v.name}.png`));
                const img = decodeImageInMemory(png);
                if (img.width !== v.width || img.height !== v.height) throw new Error(`the view image is ${img.width}x${img.height}, views.txt says ${v.width}x${v.height}`);
                const r = await opts.chain.generate({
                    contents: [{ role: 'user', parts: [{ inlineData: { mimeType: 'image/png', data: png.toString('base64') } }, { text: outlinePrompt(opts.target, v.width, v.height) }] }],
                    config: { responseMimeType: 'application/json', temperature: 0 }
                }, { stage: 'ownership' });
                const text = r.response.candidates?.[0]?.content?.parts?.map(p => p.text ?? '').join('') ?? '';
                const reply = parseOutlineReply(text);
                r.remember();
                model = r.model;
                if (!reply.visible) { skipped.push({ view: v.name, reason: 'the model did not find the structure in this view' }); continue; }
                fs.writeFileSync(out, encodePng(v.width, v.height, rasterizeOutlines(reply.polygons, v.width, v.height), 1));
                masks++;
            } catch (err) {
                skipped.push({ view: v.name, reason: err instanceof Error ? err.message : String(err) });
            } finally {
                opts.onProgress?.(`outlining the structure: ${++done} of ${views.length} views`);
            }
        }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(opts.concurrency ?? 4, views.length)) }, work));
    return { masksDir: opts.masksDir, masks, views: views.length, skipped, model, ms: Date.now() - t0 };
}
