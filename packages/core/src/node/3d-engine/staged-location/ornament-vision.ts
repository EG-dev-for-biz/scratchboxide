/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Facade detail read from photos: one combined, low-thinking vision call per building (gemini-4-argon at thinking LOW
 * by user decision, any fallback visible), at most one revision pass, and a deterministic check of every reply.
 *
 * The images are the fit's tile orthos (this app's own renders of the tile photo, slot outlines drawn on them) and up
 * to 4 Street View images (sent exactly as the grounding API returned them, with their slot outlines given as text).
 * The reply is compact and slot-relative (VisionOrnamentReply) and is expanded by ornament-expand.
 *
 * Checks, in order (§5.5): 1 finish STOP and JSON; 2 the reply schema; 3 every slot, image, primitive and parameter
 * known; 4 boxes well-formed; 5 inside the slot; 6 within the slot's bounds and edge envelope; 7 repeats fit; 8 no
 * overlap over 10% in a slot unless one contains the other; 9 the cited image shows the slot (visible ≥ 0.3, the box
 * ≥ 50% on the slot's polygon, widened by the pose uncertainty on Street View); 10 the cited image resolves it (smallest
 * in-plane size ≥ 2 × the finest native sample); 11 tile-photo-only evidence must pass the builder's pixel support
 * test (marked here, run by the ornament builder); 12 confidence ≥ 35; 13 a correction names a correctable parameter
 * inside its admissible range, confidence ≥ 70, and its evidence passes rule 9.
 * Rules 1-8 are things the model can fix: they become one revision. Rules 9-12 drop the element with a record (asking
 * again cannot add evidence). Rule 13 rejects the correction (recorded, not a degradation).
 */

import * as crypto from 'crypto';
import type { Content, Part } from '@google/genai';
import {
    PHOTO_CORRECTION_TOLERANCE_M,
    STAGED_VISION_MODEL_DEFAULT,
    schemaClosure,
    validateContract,
    type CompactBox,
    type EvidenceImageRef,
    type OperatorSpec,
    type OrnamentElement,
    type OrnamentSlot,
    type OrnamentSpec,
    type OrthoImage,
    type PrimitiveCorrection,
    type StructureFit,
    type Vec2,
    type VisionModelUse,
    type VisionOrnamentReply
} from '../../../common/spatial/staged-location-contracts';
import { describeThinking, thinkingConfigFor } from '../../gemini/thinking-config';
import type { VisionAttempt, VisionModelChain } from '../../gemini/vision-model-chain';
import { anchorElements, type AnchorNote } from './ornament-anchor';
import { expandElements, expandEvidence, splitOversizeReplicates, type ExpandedElement } from './ornament-expand';
import { surveyHintLines, type LocatedElement } from './survey-detail';
import type { SlotOffer } from './slot-exposure';
import { describeCover, type SlotCover } from './slot-cover';

export const ORNAMENT_PROMPT_VERSION = 'ornament/v5';
/** Thinking tokens asked for: LOW on Gemini 4 (thinkingConfigFor), a 512-token budget on 3.x. */
export const ORNAMENT_THINKING_BUDGET = 512;
export const ORNAMENT_MAX_OUTPUT_TOKENS = 16_384;
/**
 * Per-call timeout. Provisional: the user chose gemini-4-argon at LOW without a benchmark, and an argon object-spec call
 * took 59 s at its default thinking (round1_w4-object-builds), so the limit leaves room above that.
 */
export const ORNAMENT_VISION_TIMEOUT_MS = 120_000;
export const MIN_ELEMENT_CONFIDENCE = 35;
export const MIN_CORRECTION_CONFIDENCE = 70;
export const MIN_SLOT_VISIBLE_FRACTION = 0.3;
export const MIN_BOX_ON_SLOT = 0.5;
export const MAX_ELEMENTS_PER_SLOT = 6;

/** An evidence image with the bytes sent for it (orthos: PNG from the fit; Street View: the grounding bytes, in memory). */
export interface EvidenceInput {
    ref: EvidenceImageRef;
    bytes: Buffer;
    mimeType: string;
    /** "[i] …" caption line in the prompt. */
    caption: string;
}

const DEG = Math.PI / 180;

// ----------------------------------------------------------------------------------------------------------------
// evidence references
// ----------------------------------------------------------------------------------------------------------------

/** A slot's region in an ortho of its host surface, as a polygon in 0-1000 [y, x, …] of the ortho. */
export function orthoSlotPolygon(slot: OrnamentSlot, fit: Pick<StructureFit, 'surfaces'>, ortho: Pick<OrthoImage, 'surfaceId' | 'originUv' | 'gsdM' | 'widthPx' | 'heightPx'>): number[] | undefined {
    const toPx = (u: number, v: number): Vec2 => [(u - ortho.originUv[0]) / ortho.gsdM, (ortho.originUv[1] - v) / ortho.gsdM];
    let uv: Vec2[] = [];
    if ('surface' in slot.host) {
        if (slot.host.surface.surfaceId !== ortho.surfaceId) return undefined;
        uv = slot.host.surface.regionUv;
    } else {
        if (!slot.host.edge.surfaceIds.includes(ortho.surfaceId)) return undefined;
        const surface = fit.surfaces.find(s => s.id === ortho.surfaceId);
        if (!surface || !('plane' in surface.chart)) return undefined;
        const p = surface.chart.plane;
        const toUv = (q: number[]): Vec2 => {
            const d = [q[0] - p.origin[0], q[1] - p.origin[1], q[2] - p.origin[2]];
            return [d[0] * p.u[0] + d[1] * p.u[1] + d[2] * p.u[2], d[0] * p.v[0] + d[1] * p.v[1] + d[2] * p.v[2]];
        };
        const pts = slot.host.edge.carrier.points.map(toUv);
        const vs = slot.host.edge.envelope.map(e => e[1]);
        const [lo, hi] = [Math.min(...vs), Math.max(...vs)];
        const us = pts.map(q => q[0]), vv = pts.map(q => q[1]);
        uv = [[Math.min(...us), Math.min(...vv) + lo], [Math.max(...us), Math.min(...vv) + lo], [Math.max(...us), Math.max(...vv) + hi], [Math.min(...us), Math.max(...vv) + hi]];
    }
    return uv.flatMap(([u, v]) => {
        const [x, y] = toPx(u, v);
        return [Math.max(0, Math.min(1000, Math.round((y / ortho.heightPx) * 1000))), Math.max(0, Math.min(1000, Math.round((x / ortho.widthPx) * 1000)))];
    });
}

/** The evidence reference of a tile ortho (no occlusion: it is a render of the surface itself). */
export function orthoRef(ortho: OrthoImage, index: number, fit: Pick<StructureFit, 'slots' | 'surfaces'>, bytes: Buffer): EvidenceImageRef {
    const slotsShown = fit.slots.flatMap(s => {
        const polygon1000 = orthoSlotPolygon(s, fit, ortho);
        return polygon1000 ? [{ slotId: s.id, polygon1000, visibleFraction: 1 }] : [];
    });
    return {
        id: ortho.id, index, kind: 'tile-ortho', widthPx: ortho.widthPx, heightPx: ortho.heightPx,
        sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
        nativeSampleM: ortho.texelM, surfaceId: ortho.surfaceId, gsdM: ortho.gsdM, texelM: ortho.texelM, slotsShown
    };
}

// ----------------------------------------------------------------------------------------------------------------
// prompt
// ----------------------------------------------------------------------------------------------------------------

const f2 = (v: number) => (Math.round(v * 100) / 100).toString();

export function orthoCaption(ref: EvidenceImageRef, fit: Pick<StructureFit, 'surfaces'>): string {
    const surface = fit.surfaces.find(s => s.id === ref.surfaceId);
    const ext = surface && 'plane' in surface.chart ? surface.chart.plane.extentUv : undefined;
    const w = ext ? Math.max(...ext.map(p => p[0])) - Math.min(...ext.map(p => p[0])) : (ref.widthPx * (ref.gsdM ?? 0));
    const h = ext ? Math.max(...ext.map(p => p[1])) - Math.min(...ext.map(p => p[1])) : (ref.heightPx * (ref.gsdM ?? 0));
    return `[${ref.index}] Orthographic view of fitted surface ${ref.surfaceId}, ${f2(w)} × ${f2(h)} m, from the Google 3D Tiles photo texture resampled to ${f2(ref.gsdM ?? 0)} m per pixel. The photo's own texel here is ${f2(ref.texelM ?? 0)} m, so nothing under ${f2(2 * (ref.texelM ?? 0))} m is visible. Coloured outlines are slots, with their ids.`;
}

export function streetViewCaption(ref: EvidenceImageRef): string {
    return `[${ref.index}] Google Street View image (© Google, ${ref.captureDate ?? 'date unknown'}), looking ${Math.round(ref.headingDeg ?? 0)}° from about ${Math.round(ref.distanceM ?? 0)} m, field of view ${Math.round(ref.fovDeg ?? 0)}°, ${ref.widthPx} × ${ref.heightPx} px; one pixel spans about ${f2(ref.nativeSampleM)} m on the facade. Its slot outlines are listed below as polygons. They come from an approximate camera position and may be off by about ${ref.pose?.uncertaintyM ?? 2} m.`;
}

/** The ornament/v2 prompt text around the images (the images go between the preamble and the tables). */
/** A focused reading: one repeating or banded group, one crop, one slot. */
export interface FocusedReading {
    /** What the survey saw there, in words (its own wording; never matched on). */
    task: string;
}

export function ornamentPromptText(fit: StructureFit, evidence: EvidenceImageRef[], located: LocatedElement[] = [], offer?: SlotOffer, focus?: FocusedReading): { preamble: string; tables: string } {
    const l = fit.sourceLimits;
    const preamble = focus
        ? `You are reading ONE repeating or banded group of ornament on a real structure from one photograph. It will be added as parametric detail to a clay model fitted to a 3D scan, which resolves shapes of about ${f2(l.meshResolvableM)} m. Everything you add is labelled "photo-inferred" with the confidence you give. ${focus.task}\n\nImage (cite it by index):`
        : `You are reading architectural ornament on one real structure from photographs. It will be added as parametric detail to a clay model that was fitted to a 3D scan. The scan resolves shapes of about ${f2(l.meshResolvableM)} m and the tile photos about ${f2(l.photoResolvableM)} m. Everything you add is labelled "photo-inferred" with the confidence you give, and anything smaller than the image you cite can show is discarded.\n\nImages (cite them by index):`;
    // only slots on an open, exterior face that some image shows (slot-exposure.ts) are offered, each with the images that show it and how much
    const offered = offer ? fit.slots.filter(s => offer.offeredIds.has(s.id)) : fit.slots;
    const inImages = (slotId: string) => offer
        ? (offer.entries.find(e => e.slotId === slotId)?.images ?? []).map(i => `${i.index} (${Math.round(i.visibleFraction * 100)}% of the slot visible)`)
        : evidence.filter(e => e.slotsShown.some(s => s.slotId === slotId)).map(e => String(e.index));
    const slots = offered.map(s => {
        const host = 'surface' in s.host ? `surface ${s.host.surface.surfaceId}` : `edge along ${s.host.edge.surfaceIds.join('+')}, ${f2(s.host.edge.carrier.lengthM)} m`;
        const env = 'edge' in s.host ? `, envelope [u out, v up] mm ${JSON.stringify(s.host.edge.envelope.map(p => [Math.round(p[0] * 1000), Math.round(p[1] * 1000)]))}` : '';
        return `${s.id}: ${host}, ${f2(s.sizeM[0])} × ${f2(s.sizeM[1])} m, maxProud ${Math.round(s.bounds.maxProudM * 1000)} mm, maxRecess ${Math.round(s.bounds.maxRecessM * 1000)} mm${env}, in images [${inImages(s.id).join(', ')}]${offer?.covers.get(s.id) ? `; ${describeCover(offer.covers.get(s.id)!)}` : ''}`;
    });
    const polys = evidence.filter(e => e.kind === 'streetview-grounding').map(e => `[${e.index}] ${e.slotsShown.filter(s => !offer || offer.offeredIds.has(s.slotId)).map(s => `${s.slotId} → ${JSON.stringify(s.polygon1000)}`).join('; ') || 'no slot'}`);
    const correctable = fit.primitives.flatMap(p => p.correctable.map(c => `${p.id} (${p.label ?? 'primitive'}): param ${c.param} (${c.key}) = ${c.value} ${c.unit}, admissible ${c.min}–${c.max}; ${c.description}`));
    const rules = [
        '1. Report only elements you can see in an image that shows their slot. Cite each with [image index, y0, x0, y1, x1] in 0–1000.',
        '2. Build each element with one operator: sweep (a profile along the slot\'s edge, or along a path in the slot; a block or a run of blocks on an edge, such as a row of small repeated blocks, is a sweep of its section over a short t span, repeated with replicate), revolve (a profile around an axis, with K lobes), replicate (one seed repeated along the edge or over a grid), or relief (a raised or recessed region). Use integer millimetres in the slot\'s own axes: u along the surface to the right, v up, n out of the surface. Along an edge, t is per-mille of its length.',
        '3. Nothing but a relief may go below the surface: a sweep along a path or a revolve about the normal stays at n >= 0 (z >= 0); a recess is a relief with negative depth. In an edge section [out, up], the quarter with out < 0 and up < 0 is inside the wall: a swept profile stays at out >= 0 or up >= 0. Do not give a size smaller than the image you cite can show. Depths are estimates from shading, shadows or silhouettes. Keep them within the slot bounds, keep edge profiles inside the edge envelope, and say how you judged them (depthBasis).',
        '4. For repeats, count what you see. If a row runs out of view, give the visible count and set beyondView.',
        '5. Figures and lettering are a low relief outline only, at most 50 mm deep.',
        '6. Shadows, stains, trees, people, vehicles and statues standing in front of a wall are not ornament on that wall. Do not add anything you know about this building but cannot see in these images.',
        '7. If a photo clearly contradicts a correctable value, propose a correction inside its admissible range, with evidence. Otherwise propose none.',
        '8. List the slots where you see nothing, or that no image shows, in emptySlots.',
        `9. At most ${MAX_ELEMENTS_PER_SLOT} elements per slot and 60 in all, highest confidence first.`
    ];
    const schema = JSON.stringify(schemaClosure('VisionOrnamentReply'));
    const tables = [
        `Slots offered (${offered.length}${offer ? ` of ${fit.slots.length} fitted; the others are on hidden or interior faces or shown by no image, and are not offered` : ''}):\n${slots.join('\n')}`,
        `Slot polygons in Street View images: ${polys.length ? polys.join('\n') : 'none'}`,
        ...(located.length ? [`Survey: a first look at the whole structure found these, each already placed in its slot by casting its place in the photo onto the fitted face, so you do not place anything: measure it. Its metres come from the scan; the repeat counts are the survey's rough count. Give counts and sizes you can read in the close-up; count × pitch will be held to the run below.\n${surveyHintLines(located, offered).join('\n')}`] : []),
        ...(focus ? [] : [`Correctable fit values: ${correctable.length ? correctable.join('\n') : 'none'}`]),
        `Rules:\n${rules.join('\n')}`,
        `Reply with JSON only, matching this schema: ${schema}`
    ].join('\n\n');
    return { preamble, tables };
}

export function ornamentContents(fit: StructureFit, evidence: EvidenceInput[], located: LocatedElement[] = [], offer?: SlotOffer, focus?: FocusedReading): Content[] {
    const { preamble, tables } = ornamentPromptText(fit, evidence.map(e => e.ref), located, offer, focus);
    const parts: Part[] = [{ text: preamble }];
    for (const e of evidence) {
        parts.push({ inlineData: { mimeType: e.mimeType, data: e.bytes.toString('base64') } });
        parts.push({ text: e.caption });
    }
    parts.push({ text: tables });
    return [{ role: 'user', parts }];
}

// ----------------------------------------------------------------------------------------------------------------
// geometry of an expanded element in its slot
// ----------------------------------------------------------------------------------------------------------------

export interface Rect { u0: number; v0: number; u1: number; v1: number }
const rectArea = (r: Rect) => Math.max(0, r.u1 - r.u0) * Math.max(0, r.v1 - r.v0);
/** The bounding rectangle of points (a loop: a repeat of thousands of instances has more points than a spread can take). */
export function bbox(pts: Vec2[]): Rect {
    let u0 = Infinity, v0 = Infinity, u1 = -Infinity, v1 = -Infinity;
    for (const p of pts) { if (p[0] < u0) u0 = p[0]; if (p[0] > u1) u1 = p[0]; if (p[1] < v0) v0 = p[1]; if (p[1] > v1) v1 = p[1]; }
    return { u0, v0, u1, v1 };
}
const TOL = 0.01;

export function pointInPolygon(u: number, v: number, poly: Vec2[], tol = TOL): boolean {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const [ui, vi] = poly[i], [uj, vj] = poly[j];
        if ((vi > v) !== (vj > v) && u < ((uj - ui) * (v - vi)) / (vj - vi) + ui) inside = !inside;
    }
    if (inside) return true;
    // on the boundary within tol
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const [ax, ay] = poly[j], [bx, by] = poly[i];
        const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy || 1;
        const t = Math.max(0, Math.min(1, ((u - ax) * dx + (v - ay) * dy) / l2));
        if (Math.hypot(u - (ax + t * dx), v - (ay + t * dy)) <= tol) return true;
    }
    return false;
}

/** Points of a leaf spec's footprint in the slot's 2D frame (chart uv; along an edge: [s metres along, v]). */
function leafFootprint(spec: OperatorSpec, slot: OrnamentSlot, at: Vec2 = [0, 0]): Vec2[] {
    const L = 'edge' in slot.host ? slot.host.edge.carrier.lengthM : 0;
    const sh = (p: Vec2): Vec2 => [p[0] + at[0], p[1] + at[1]];
    if (spec.operator === 'sweep') {
        const c = spec.sweep.carrier;
        const prof = spec.sweep.profile.outer;
        if ('slot' in c) {
            const vs = prof.map(p => p[1] + c.slot.offset[1]);
            const [v0, v1] = [Math.min(...vs), Math.max(...vs)];
            return [sh([c.slot.t0 * L, v0]), sh([c.slot.t1 * L, v0]), sh([c.slot.t1 * L, v1]), sh([c.slot.t0 * L, v1])];
        }
        if ('chart' in c) {
            const half = Math.max(...prof.map(p => Math.abs(p[0])));
            return c.chart.pointsUv.flatMap(p => [sh([p[0] - half, p[1] - half]), sh([p[0] + half, p[1] + half]), sh([p[0] - half, p[1] + half]), sh([p[0] + half, p[1] - half])]);
        }
        return [];
    }
    if (spec.operator === 'revolve') {
        const r = spec.revolve;
        const maxR = Math.max(...r.profile.map(p => Math.abs(p[0])));
        const zs = r.profile.map(p => p[1]);
        const o: Vec2 = [r.axisOrigin[0], r.axisOrigin[1]];
        if (r.axisDir[2] !== 0) return [sh([o[0] - maxR, o[1] - maxR]), sh([o[0] + maxR, o[1] + maxR])];
        if (r.axisDir[0] !== 0) return [sh([o[0] + Math.min(...zs), o[1] - maxR]), sh([o[0] + Math.max(...zs), o[1] + maxR])];
        return [sh([o[0] - maxR, o[1] + Math.min(...zs)]), sh([o[0] + maxR, o[1] + Math.max(...zs)])];
    }
    if (spec.operator === 'relief') return spec.relief.region.outer.map(sh);
    return [];
}

/** Instance origins of a replicate in the slot frame. */
export function instances(spec: OperatorSpec, slot: OrnamentSlot): Vec2[] {
    if (spec.operator !== 'replicate') return [[0, 0]];
    const d = spec.replicate.domain;
    const L = 'edge' in slot.host ? slot.host.edge.carrier.lengthM : 0;
    if ('along' in d) {
        const t0 = 'slot' in d.along.carrier ? d.along.carrier.slot.t0 * L : 0;
        return Array.from({ length: d.along.count }, (_, k) => [t0 + d.along.startOffsetM + k * d.along.pitchM, 0] as Vec2);
    }
    const g = d.lattice;
    const out: Vec2[] = [];
    for (let j = 0; j < g.counts[1]; j++) for (let i = 0; i < g.counts[0]; i++) out.push([g.originUv[0] + i * g.pitchUv[0] + (j % 2) * g.rowOffsetU, g.originUv[1] + j * g.pitchUv[1]]);
    return out;
}

export function footprint(spec: OperatorSpec, slot: OrnamentSlot): Vec2[] {
    if (spec.operator === 'replicate') return instances(spec, slot).flatMap(at => leafFootprint(spec.replicate.seed as OperatorSpec, slot, at));
    return leafFootprint(spec, slot);
}

/** The element's smallest in-plane dimension (rule 10). */
export function smallestDimension(spec: OperatorSpec): number {
    if (spec.operator === 'sweep') {
        const b = bbox(spec.sweep.profile.outer);
        return Math.min(b.u1 - b.u0, b.v1 - b.v0);
    }
    if (spec.operator === 'revolve') return 2 * Math.max(...spec.revolve.profile.map(p => Math.abs(p[0])));
    if (spec.operator === 'relief') {
        const b = bbox(spec.relief.region.outer);
        const w = Math.min(b.u1 - b.u0, b.v1 - b.v0);
        const h = spec.relief.height;
        return 'panel' in h && h.panel.edgeWidthM > 0 ? Math.min(w, h.panel.edgeWidthM) : w;
    }
    const d = spec.replicate.domain;
    const pitch = 'along' in d ? d.along.pitchM : Math.min(...d.lattice.pitchUv.filter((v, i) => d.lattice.counts[i] > 1).concat([Infinity]));
    return Math.min(pitch, smallestDimension(spec.replicate.seed as OperatorSpec));
}

/** Depth extremes (+ proud, − recess) of a spec (rule 6). */
/** How far a sweep along a path in a surface slot, or a revolve about the surface normal, goes below the surface: inside the wall, which only a relief can recess into. */
export function sunkBelowSurface(spec: OperatorSpec): number {
    if (spec.operator === 'replicate') return sunkBelowSurface(spec.replicate.seed as OperatorSpec);
    if (spec.operator === 'revolve') return spec.revolve.axisDir[2] !== 0 ? Math.max(0, ...spec.revolve.profile.map(p => -p[1])) : 0;
    if (spec.operator === 'sweep' && 'chart' in spec.sweep.carrier) return Math.max(0, ...spec.sweep.profile.outer.map(p => -p[1]));
    return 0;
}

function depthRange(spec: OperatorSpec): { proud: number; recess: number } {
    if (spec.operator === 'replicate') return depthRange(spec.replicate.seed as OperatorSpec);
    if (spec.operator === 'relief') {
        const h = spec.relief.height;
        const values = 'panel' in h ? [h.panel.depthM] : h.grid.heightsM;
        return { proud: Math.max(0, ...values), recess: Math.max(0, ...values.map(v => -v)) };
    }
    if (spec.operator === 'revolve') {
        const r = spec.revolve;
        const out = r.axisDir[2] !== 0 ? Math.max(...r.profile.map(p => p[1])) : Math.max(...r.profile.map(p => Math.abs(p[0])));
        return { proud: Math.max(0, out), recess: 0 };
    }
    const c = spec.sweep.carrier;
    if ('chart' in c) {
        const vs = spec.sweep.profile.outer.map(p => p[1]);
        return { proud: Math.max(0, ...vs), recess: Math.max(0, ...vs.map(v => -v)) };
    }
    return { proud: 0, recess: 0 };
}

// ----------------------------------------------------------------------------------------------------------------
// rule 9: polygon overlap
// ----------------------------------------------------------------------------------------------------------------

/** Area of polygon ∩ axis-aligned rect (Sutherland-Hodgman). */
function clippedArea(poly: Vec2[], r: Rect): number {
    let out = poly;
    const edges: Array<[(p: Vec2) => boolean, (a: Vec2, b: Vec2) => Vec2]> = [
        [p => p[0] >= r.u0, (a, b) => [r.u0, a[1] + ((b[1] - a[1]) * (r.u0 - a[0])) / (b[0] - a[0])]],
        [p => p[0] <= r.u1, (a, b) => [r.u1, a[1] + ((b[1] - a[1]) * (r.u1 - a[0])) / (b[0] - a[0])]],
        [p => p[1] >= r.v0, (a, b) => [a[0] + ((b[0] - a[0]) * (r.v0 - a[1])) / (b[1] - a[1]), r.v0]],
        [p => p[1] <= r.v1, (a, b) => [a[0] + ((b[0] - a[0]) * (r.v1 - a[1])) / (b[1] - a[1]), r.v1]]
    ];
    for (const [inside, cut] of edges) {
        const input = out;
        out = [];
        for (let i = 0; i < input.length; i++) {
            const cur = input[i], prev = input[(i + input.length - 1) % input.length];
            if (inside(cur)) { if (!inside(prev)) out.push(cut(prev, cur)); out.push(cur); }
            else if (inside(prev)) out.push(cut(prev, cur));
        }
        if (!out.length) return 0;
    }
    let a = 0;
    for (let i = 0; i < out.length; i++) { const [x0, y0] = out[i], [x1, y1] = out[(i + 1) % out.length]; a += x0 * y1 - x1 * y0; }
    return Math.abs(a) / 2;
}

function convexHull(points: Vec2[]): Vec2[] {
    const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    if (pts.length < 3) return pts;
    const crossZ = (o: Vec2, a: Vec2, b: Vec2) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lower: Vec2[] = [], upper: Vec2[] = [];
    for (const p of pts) { while (lower.length >= 2 && crossZ(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop(); lower.push(p); }
    for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]; while (upper.length >= 2 && crossZ(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop(); upper.push(p); }
    return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

/** Share of a box (0-1000 [y0, x0, y1, x1]) on a slot's polygon in that image, the polygon widened by (dx, dy). */
export function boxOnSlot(box: [number, number, number, number], polygon1000: number[], dx = 0, dy = 0): number {
    const pts: Vec2[] = [];
    for (let i = 0; i + 1 < polygon1000.length; i += 2) {
        const y = polygon1000[i], x = polygon1000[i + 1];
        if (dx || dy) for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) pts.push([x + sx * dx, y + sy * dy]);
        else pts.push([x, y]);
    }
    const hull = convexHull(pts);
    const rect: Rect = { u0: box[1], v0: box[0], u1: box[3], v1: box[2] };
    const area = rectArea(rect);
    return area > 0 && hull.length >= 3 ? clippedArea(hull, rect) / area : 0;
}

/** The pose uncertainty of a Street View image in 0-1000 units (x, y). */
function uncertainty1000(ref: EvidenceImageRef): [number, number] {
    if (ref.kind !== 'streetview-grounding' || !ref.pose) return [0, 0];
    const fov = (ref.fovDeg ?? 60) * DEG;
    const f = ref.widthPx / (2 * Math.tan(fov / 2));
    const px = f * (ref.pose.uncertaintyM / Math.max(1, ref.distanceM ?? 20) + ref.pose.uncertaintyDeg * DEG);
    return [(px / ref.widthPx) * 1000, (px / ref.heightPx) * 1000];
}

// ----------------------------------------------------------------------------------------------------------------
// the checks
// ----------------------------------------------------------------------------------------------------------------

export interface ReplyCheck {
    /** What anchoring changed (photo-corrected within the scan tolerance). */
    anchored?: AnchorNote[];
    /** Rules 1-8: things the model can fix, numbered for the revision request. */
    problems: string[];
    reply?: VisionOrnamentReply;
    /** Elements that passed every rule. */
    kept: OrnamentElement[];
    /** Elements dropped by rules 9-12 (or, after the revision, rules 3-8). */
    dropped: Array<{ elementId: string; slotId: string; by: 'validator'; problems: string[]; reasonCode: string }>;
    /** Elements whose only evidence is the tile photo: the ornament builder must find them in its pixels (rule 11). */
    supportTestRequired: string[];
    /** Corrections that passed rule 13 (applied by a refit, which checks the residual). */
    corrections: PrimitiveCorrection[];
    rejectedCorrections: PrimitiveCorrection[];
    emptySlots: Array<{ slotId: string; reason: string }>;
}

/**
 * Checks one reply. `final` marks the reply after the revision: problems of rules 3-8 then drop their element instead of
 * asking again.
 */
export function checkReply(text: string, finishReason: string | undefined, fit: StructureFit, evidence: EvidenceImageRef[], method: string, final = false, located: LocatedElement[] = [], covers?: Map<string, SlotCover>): ReplyCheck {
    const result: ReplyCheck = { problems: [], kept: [], dropped: [], supportTestRequired: [], corrections: [], rejectedCorrections: [], emptySlots: [] };
    // rule 1
    if (finishReason && finishReason !== 'STOP') {
        result.problems.push(finishReason === 'MAX_TOKENS' ? 'rule 1: the reply was cut off (MAX_TOKENS)' : `rule 1: the reply ended with ${finishReason}, not STOP`);
        return result;
    }
    let value: unknown;
    try {
        value = JSON.parse(text.trim());
    } catch (err) {
        result.problems.push(`rule 1: the reply is not valid JSON (${(err as Error).message})`);
        return result;
    }
    // rule 2
    const schemaProblems = validateContract('VisionOrnamentReply', value);
    if (schemaProblems.length) {
        result.problems.push(...schemaProblems.slice(0, 12).map(p => `rule 2: ${p}`));
        return result;
    }
    const reply = value as VisionOrnamentReply;
    result.reply = reply;
    const imageByIndex = new Map(evidence.map(e => [e.index, e]));
    const slotById = new Map(fit.slots.map(s => [s.id, s]));

    // rule 3 and 4 over the whole reply
    const elementProblems = new Map<number, string[]>();
    const add = (i: number, p: string) => { const l = elementProblems.get(i) ?? []; l.push(p); elementProblems.set(i, l); };
    const checkBoxes = (boxes: CompactBox[], where: (p: string) => void) => {
        for (const [index, y0, x0, y1, x1] of boxes) {
            if (!imageByIndex.has(index)) where(`rule 3: image index ${index} is not one of the images`);
            if (!(y0 < y1 && x0 < x1)) where(`rule 4: box [${index}, ${y0}, ${x0}, ${y1}, ${x1}] is not well-formed (y0 < y1 and x0 < x1)`);
        }
    };
    const perSlot = new Map<string, number>();
    reply.elements.forEach((e, i) => {
        if (!slotById.has(e.slot)) add(i, `rule 3: slot ${e.slot} is not one of the slots`);
        checkBoxes(e.ev, p => add(i, p));
        perSlot.set(e.slot, (perSlot.get(e.slot) ?? 0) + 1);
    });
    for (const [slot, n] of perSlot) if (n > MAX_ELEMENTS_PER_SLOT) result.problems.push(`rule 9 of the prompt: slot ${slot} has ${n} elements, at most ${MAX_ELEMENTS_PER_SLOT}`);

    const expanded: ExpandedElement[] = expandElements(reply.elements, fit, evidence, method);
    // anchor the model's estimates to the scan's geometry before the slot rules: within the tolerance they are snapped, beyond it they are problems
    const anchored = anchorElements(expanded, fit, located, undefined, final, covers);
    result.anchored = anchored.notes;
    for (const [i, ps] of anchored.problems) for (const p of ps) add(i, p);
    // rules 5-8 per element
    for (const x of expanded) {
        const slot = slotById.get(x.element.slotId)!;
        const spec = x.element.spec;
        const pts = footprint(spec, slot);
        if ('surface' in slot.host) {
            const region = slot.host.surface.regionUv;
            if (spec.operator === 'replicate' && 'along' in spec.replicate.domain) add(x.replyIndex, `rule 5: a repeat along an edge needs an edge slot; ${slot.id} is a surface (use grid)`);
            else if (spec.operator === 'sweep' && 'slot' in spec.sweep.carrier) add(x.replyIndex, `rule 5: a sweep in surface slot ${slot.id} needs a path, not t`);
            else if (pts.some(p => !pointInPolygon(p[0], p[1], region))) add(x.replyIndex, `rule 5: the element runs outside slot ${slot.id}`);
        } else {
            const e = slot.host.edge;
            const L = e.carrier.lengthM;
            if (spec.operator === 'relief' || (spec.operator === 'replicate' && spec.replicate.seed.operator === 'relief')) add(x.replyIndex, `rule 5: a relief needs a surface slot; ${slot.id} is an edge (build a block or a run along an edge as a sweep of its section over a short t span, repeated with replicate)`);
            if (spec.operator === 'sweep' && 'slot' in spec.sweep.carrier) {
                const c = spec.sweep.carrier.slot;
                if (!(c.t0 < c.t1)) add(x.replyIndex, `rule 5: t must run forward along the edge (t0 ${Math.round(c.t0 * 1000)} ≥ t1 ${Math.round(c.t1 * 1000)})`);
                const outside = spec.sweep.profile.outer.filter(p => !pointInPolygon(p[0] + c.offset[0], p[1] + c.offset[1], e.envelope, 0.005));
                if (outside.length) add(x.replyIndex, `rule 6: the profile leaves the edge envelope of ${slot.id} at ${outside.length} point(s)`);
                // an edge section is [out of the face, up]: the part with both below zero is the wall itself, and a swept shell there is inside the fitted solid
                const inWall = spec.sweep.profile.outer.filter(p => p[0] + c.offset[0] < -0.005 && p[1] + c.offset[1] < -0.005);
                if (inWall.length) add(x.replyIndex, `rule 6: ${inWall.length} profile point(s) of the sweep on ${slot.id} lie inside the wall (out < 0 and up < 0 is the fitted solid); keep a swept profile at out >= 0 or up >= 0`);
            }
            if (pts.some(p => p[0] < -TOL || p[0] > L + TOL)) add(x.replyIndex, `rule 7: the element runs past the ${L.toFixed(2)} m edge ${slot.id}`);
        }
        if ('surface' in slot.host) {
            const sunk = sunkBelowSurface(spec);
            if (sunk > 0.005) add(x.replyIndex, `rule 6: the ${spec.operator === 'replicate' ? 'repeated seed' : spec.operator} on ${slot.id} goes ${Math.round(sunk * 1000)} mm below the surface, which is inside the wall; keep sweeps and revolves at n >= 0 (z >= 0) and recess only with a relief of negative depth`);
        }
        const depth = depthRange(spec);
        if (depth.proud > slot.bounds.maxProudM + 1e-6) add(x.replyIndex, `rule 6: ${Math.round(depth.proud * 1000)} mm proud is more than slot ${slot.id} allows (${Math.round(slot.bounds.maxProudM * 1000)} mm)`);
        if (depth.recess > slot.bounds.maxRecessM + 1e-6) add(x.replyIndex, `rule 6: ${Math.round(depth.recess * 1000)} mm recess is more than slot ${slot.id} allows (${Math.round(slot.bounds.maxRecessM * 1000)} mm)`);
        if (spec.operator === 'replicate' && 'lattice' in spec.replicate.domain) {
            const g = spec.replicate.domain.lattice;
            // a single row or column has no pitch to speak of: the builder wants a positive one, and it moves nothing
            for (const k of [0, 1] as const) if (g.counts[k] === 1 && !(g.pitchUv[k] > 0)) g.pitchUv[k] = 1;
            if (!g.counts.every(c => Number.isInteger(c) && c >= 1) || !g.pitchUv.every(v => v > 0)) add(x.replyIndex, `rule 7: a grid needs whole counts of at least 1 and positive pitches (counts ${g.counts.join(' × ')}, pitches ${g.pitchUv.map(v => Math.round(v * 1000)).join(' × ')} mm)`);
        }
        if (spec.operator === 'replicate' && 'lattice' in spec.replicate.domain && 'surface' in slot.host) {
            const b = bbox(slot.host.surface.regionUv);
            const inst = instances(spec, slot);
            if (inst.some(p => p[0] < b.u0 - TOL || p[0] > b.u1 + TOL || p[1] < b.v0 - TOL || p[1] > b.v1 + TOL)) add(x.replyIndex, `rule 7: the grid does not fit slot ${slot.id}`);
        }
    }
    // rule 8: overlaps in one slot
    const bySlot = new Map<string, ExpandedElement[]>();
    for (const x of expanded) bySlot.set(x.element.slotId, [...(bySlot.get(x.element.slotId) ?? []), x]);
    for (const list of bySlot.values()) {
        for (let a = 0; a < list.length; a++) for (let b = a + 1; b < list.length; b++) {
            const ra = bbox(footprint(list[a].element.spec, slotById.get(list[a].element.slotId)!)), rb = bbox(footprint(list[b].element.spec, slotById.get(list[b].element.slotId)!));
            const inter = rectArea({ u0: Math.max(ra.u0, rb.u0), v0: Math.max(ra.v0, rb.v0), u1: Math.min(ra.u1, rb.u1), v1: Math.min(ra.v1, rb.v1) });
            const smaller = Math.min(rectArea(ra), rectArea(rb));
            const contains = (p: Rect, q: Rect) => p.u0 <= q.u0 + TOL && p.v0 <= q.v0 + TOL && p.u1 >= q.u1 - TOL && p.v1 >= q.v1 - TOL;
            if (smaller > 0 && inter > 0.1 * smaller && !contains(ra, rb) && !contains(rb, ra)) {
                add(list[b].replyIndex, `rule 8: element ${list[b].replyIndex} overlaps element ${list[a].replyIndex} in slot ${list[a].element.slotId} by ${Math.round((100 * inter) / smaller)}%`);
            }
        }
    }

    // rules 1-8 found something: one revision, unless this is the reply after it (then those elements are dropped)
    const fixable = [...elementProblems.entries()].filter(([, ps]) => ps.length);
    if (!final && (fixable.length || result.problems.length)) {
        for (const [i, ps] of fixable) for (const p of ps) result.problems.push(`element ${i}: ${p}`);
        return result;
    }
    const failedFixable = new Set(fixable.map(([i]) => i));

    // rules 9-12 per element
    for (const x of expanded) {
        const el = x.element;
        if (failedFixable.has(x.replyIndex)) {
            result.dropped.push({ elementId: el.id, slotId: el.slotId, by: 'validator', problems: elementProblems.get(x.replyIndex)!, reasonCode: 'still_invalid_after_revision' });
            continue;
        }
        const problems: string[] = [];
        let reasonCode = '';
        const cited = el.evidence.map(ev => evidence.find(e => e.id === ev.imageId)!);
        let bestOverlap = 0;
        // an element stands when at least one image it cites shows its slot with the box on it; the citations that do not are removed from it
        // (a model that cites six images for one element is not wrong because two of them look the other way)
        const keep: number[] = [];
        for (let k = 0; k < cited.length; k++) {
            const img = cited[k], ev = el.evidence[k];
            const shown = img.slotsShown.find(s => s.slotId === el.slotId);
            if (!shown || shown.visibleFraction < MIN_SLOT_VISIBLE_FRACTION) {
                problems.push(`rule 9: image ${img.index} does not show slot ${el.slotId}${shown ? ` (only ${Math.round(shown.visibleFraction * 100)}% of it is visible)` : ''}`);
                continue;
            }
            const [dx, dy] = uncertainty1000(img);
            const on = boxOnSlot(ev.box1000, shown.polygon1000, dx, dy);
            if (on < MIN_BOX_ON_SLOT) { problems.push(`rule 9: the box in image ${img.index} lies ${Math.round(on * 100)}% on slot ${el.slotId} (${Math.round(MIN_BOX_ON_SLOT * 100)}% needed)`); continue; }
            bestOverlap = Math.max(bestOverlap, on);
            keep.push(k);
        }
        if (keep.length) {
            // the citations that failed are dropped from the element, not held against it
            problems.length = 0;
            if (keep.length < cited.length) { el.evidence = keep.map(k => el.evidence[k]); cited.splice(0, cited.length, ...keep.map(k => cited[k])); }
        }
        if (problems.length) reasonCode = 'slot_not_shown';
        const finest = Math.min(...cited.map(c => c.nativeSampleM));
        const smallest = smallestDimension(el.spec);
        if (!reasonCode && smallest < 2 * finest) {
            problems.push(`rule 10: its smallest size, ${Math.round(smallest * 1000)} mm, is under twice what its finest cited image can show (${Math.round(2 * finest * 1000)} mm)`);
            reasonCode = 'not_resolvable_in_evidence';
        }
        if (!reasonCode && Math.round(el.confidence * 100) < MIN_ELEMENT_CONFIDENCE) {
            problems.push(`rule 12: confidence ${Math.round(el.confidence * 100)} is under ${MIN_ELEMENT_CONFIDENCE}`);
            reasonCode = 'below_confidence_floor';
        }
        if (reasonCode) {
            result.dropped.push({ elementId: el.id, slotId: el.slotId, by: 'validator', problems, reasonCode });
            continue;
        }
        el.checks = { ...el.checks, slotOverlap: Math.round(bestOverlap * 1000) / 1000, minFeatureM: Math.round(smallest * 1000) / 1000, nativeSampleM: finest };
        if (cited.every(c => c.kind !== 'streetview-grounding')) {
            result.supportTestRequired.push(el.id);
            el.provenance.note = 'cites only the tile photo: kept only if the ornament builder finds it in the photo\'s pixels';
        } else {
            el.provenance.note = 'cites a Street View image, which is not pixel-checked in v1 (its bytes are never decoded); kept on rules 9-10';
        }
        result.kept.push(el);
    }

    // rule 13: corrections
    for (const c of reply.corrections) {
        const prim = fit.primitives.find(p => p.id === c.prim);
        const param = prim?.correctable.find(p => p.param === c.param);
        const evidenceList = expandEvidence(c.ev, evidence);
        const base = (accepted: boolean, why: string): PrimitiveCorrection => ({
            primitiveId: c.prim, param: c.param, key: param?.key ?? `param ${c.param}`, from: param?.value ?? prim?.fitParams.find(p => p.index === c.param)?.value ?? 0, to: c.to,
            confidence: Math.max(0, Math.min(1, c.conf / 100)), reason: c.why, evidence: evidenceList,
            check: { residualBefore: prim?.fit ?? { rmsM: 0, p50M: 0, p95M: 0, maxM: 0, samples: 0, areaM2: 0 }, residualAfter: prim?.fit ?? { rmsM: 0, p50M: 0, p95M: 0, maxM: 0, samples: 0, areaM2: 0 }, toleranceM: Math.min(param?.toleranceM ?? PHOTO_CORRECTION_TOLERANCE_M, PHOTO_CORRECTION_TOLERANCE_M), accepted, why }
        });
        if (!prim || !param) { result.rejectedCorrections.push(base(false, `rule 13: ${c.prim} param ${c.param} is not a correctable value`)); continue; }
        if (!(c.to >= param.min && c.to <= param.max)) { result.rejectedCorrections.push(base(false, `rule 13: ${c.to} is outside the admissible ${param.min}–${param.max}`)); continue; }
        if (c.conf < MIN_CORRECTION_CONFIDENCE) { result.rejectedCorrections.push(base(false, `rule 13: confidence ${c.conf} is under ${MIN_CORRECTION_CONFIDENCE}`)); continue; }
        const slots = fit.slots.filter(s => s.primitiveId === c.prim).map(s => s.id);
        const shows = evidenceList.some(ev => {
            const img = evidence.find(e => e.id === ev.imageId);
            if (!img) return false;
            const [dx, dy] = uncertainty1000(img);
            return img.slotsShown.some(s => slots.includes(s.slotId) && s.visibleFraction >= MIN_SLOT_VISIBLE_FRACTION && boxOnSlot(ev.box1000, s.polygon1000, dx, dy) >= MIN_BOX_ON_SLOT);
        });
        if (!shows) { result.rejectedCorrections.push(base(false, `rule 13: its evidence does not show ${c.prim}`)); continue; }
        result.corrections.push(base(true, 'passed rule 13; the refit checks its scan residual'));
    }
    result.emptySlots = reply.emptySlots.filter(e => slotById.has(e.slot)).map(e => ({ slotId: e.slot, reason: e.why }));
    return result;
}

// ----------------------------------------------------------------------------------------------------------------
// the call
// ----------------------------------------------------------------------------------------------------------------

export class VisionStageError extends Error {
    constructor(message: string, readonly model: VisionModelUse, readonly transient: boolean, readonly reasonCode = 'vision_unavailable') {
        super(message);
        this.name = 'VisionStageError';
    }
}

export interface OrnamentReading {
    spec: OrnamentSpec;
    /** The raw reply texts (ids and boxes only, never image bytes), for the cache. */
    replies: string[];
    supportTestRequired: string[];
    dropped: ReplyCheck['dropped'];
    rejectedCorrections: PrimitiveCorrection[];
    /** What anchoring snapped or clipped, each with the error it carried. */
    anchored: AnchorNote[];
}

function responseText(r: { candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> } }> }): string {
    return (r.candidates?.[0]?.content?.parts ?? []).filter(p => !p.thought).map(p => p.text ?? '').join('');
}

/** VisionModelUse from the chain's record. */
export function visionUse(chain: VisionModelChain<string>, outcome: 'answered' | 'failed', extra: Partial<VisionModelUse> = {}, selection: string = STAGED_VISION_MODEL_DEFAULT.selection): VisionModelUse {
    const attempts: VisionAttempt[] = chain.attempts;
    const last = attempts[attempts.length - 1];
    const used = chain.answeredModel ?? last?.model ?? chain.current;
    return {
        requested: chain.requested, used, answered: outcome === 'answered' ? (chain.answered ?? used) : '',
        thinking: last?.thinking ?? chain.thinkingFor(ORNAMENT_THINKING_BUDGET),
        skipped: [...chain.skipped], backend: chain.backend,
        ms: attempts.reduce((s, a) => s + a.ms, 0),
        ...(attempts.find(a => a.ttftMs !== undefined)?.ttftMs !== undefined ? { ttftMs: attempts.find(a => a.ttftMs !== undefined)!.ttftMs } : {}),
        outcome, selection, ...extra
    };
}

export interface ReadOrnamentInput {
    fit: StructureFit;
    fitSha256: string;
    evidence: EvidenceInput[];
    chain: VisionModelChain<string>;
    signal?: AbortSignal;
    onProgress?: (message: string) => void;
    timeoutMs?: number;
    /** The survey's elements, each already placed in a slot: hints in the prompt, and the geometry the measurements are anchored to. */
    located?: LocatedElement[];
    /** The slots worth asking about (exterior, shown by an image); absent: every slot. */
    offer?: SlotOffer;
    /** A small focused reading of one group (no corrections are asked for). */
    focus?: FocusedReading;
}

/** One combined call, at most one revision; throws VisionStageError when no usable reply comes. */
export async function readOrnament(input: ReadOrnamentInput): Promise<OrnamentReading> {
    const { fit, chain } = input;
    const refs = input.evidence.map(e => e.ref);
    const timeoutMs = input.timeoutMs ?? ORNAMENT_VISION_TIMEOUT_MS;
    const located = input.located ?? [];
    const first = ornamentContents(fit, input.evidence, located, input.offer, input.focus);
    const replies: string[] = [];
    let usage: { promptTokens?: number; outputTokens?: number; thinkingTokens?: number; finishReason?: string } = {};
    const call = async (contents: Content[]): Promise<{ text: string; finishReason?: string }> => {
        const own = new AbortController();
        const timer = setTimeout(() => own.abort(Object.assign(new Error(`the vision call took longer than ${Math.round(timeoutMs / 1000)} s`), { name: 'TimeoutError' })), timeoutMs);
        const signal = input.signal ? AbortSignal.any([input.signal, own.signal]) : own.signal;
        try {
            const r = await chain.generate({
                contents,
                config: { responseMimeType: 'application/json', temperature: 0.2, maxOutputTokens: ORNAMENT_MAX_OUTPUT_TOKENS, abortSignal: signal }
            }, {
                stage: 'vision', thinkingBudget: ORNAMENT_THINKING_BUDGET, stream: true,
                onFirstToken: ms => input.onProgress?.(`reading the photos (first token after ${(ms / 1000).toFixed(1)} s)`)
            });
            const u = r.response.usageMetadata;
            const finishReason = r.response.candidates?.[0]?.finishReason as string | undefined;
            usage = {
                promptTokens: (usage.promptTokens ?? 0) + (u?.promptTokenCount ?? 0),
                outputTokens: (usage.outputTokens ?? 0) + (u?.candidatesTokenCount ?? 0),
                thinkingTokens: (usage.thinkingTokens ?? 0) + (u?.thoughtsTokenCount ?? 0),
                ...(finishReason ? { finishReason } : {})
            };
            const text = responseText(r.response);
            replies.push(text);
            return { text, finishReason };
        } catch (err) {
            const timedOut = own.signal.aborted && !input.signal?.aborted;
            const message = timedOut ? `the vision call took longer than ${Math.round(timeoutMs / 1000)} s` : (err as Error).message;
            if (input.signal?.aborted) throw err;
            const transient = timedOut || /transient|quota|429|5\d\d|network|fetch failed|None of the chat's models is served/.test(message);
            throw new VisionStageError(message, visionUse(chain, 'failed', { ...usage, error: message }), transient);
        } finally {
            clearTimeout(timer);
        }
    };
    const method = `${chain.current} (${'level' in chain.thinkingFor(ORNAMENT_THINKING_BUDGET) ? 'thinking low' : 'thinking budget 512'}) reading ${refs.length} images, expanded slot-relative`;

    input.onProgress?.(`reading ${refs.length} photos with ${chain.current}`);
    const one = await call(first);
    let check = checkReply(one.text, one.finishReason, fit, refs, method, false, located, input.offer?.covers);
    let passes: 0 | 1 = 0;
    let problems: string[] = [];
    if (check.problems.length) {
        problems = check.problems;
        passes = 1;
        const ask = one.finishReason === 'MAX_TOKENS'
            ? 'Your reply was cut off. Reply with at most 30 elements, highest confidence first.'
            : `These parts cannot be built: ${check.problems.map((p, i) => `${i + 1}. ${p}`).join(' ')} Reply with the complete corrected JSON.`;
        input.onProgress?.(`asking ${chain.answeredModel ?? chain.current} once to fix ${check.problems.length} problem${check.problems.length === 1 ? '' : 's'}`);
        const two = await call([...first, { role: 'model', parts: [{ text: one.text }] }, { role: 'user', parts: [{ text: ask }] }]);
        check = checkReply(two.text, two.finishReason, fit, refs, method, true, located, input.offer?.covers);
        if (!check.reply) {
            const why = `the reply was invalid twice (${check.problems.slice(0, 3).join('; ')})`;
            throw new VisionStageError(why, visionUse(chain, 'failed', { ...usage, error: why }), false, 'vision_invalid_reply');
        }
    }
    const thinking = chain.attempts.length ? chain.attempts[chain.attempts.length - 1].thinking : undefined;
    const model = visionUse(chain, 'answered', { ...usage, ...(thinking ? { thinking } : {}) });
    // a replicate read past the builder's per-axis limit is split into blocks placing the same instances (never clamped)
    const sized = splitOversizeReplicates(check.kept);
    const supportTestRequired = check.supportTestRequired.flatMap(id => sized.split.find(x => x.elementId === id)?.parts ?? [id]);
    const spec: OrnamentSpec = {
        schema: 'scratchbox.ornament-spec/2',
        buildingId: fit.buildingId,
        structureFitSha256: input.fitSha256,
        promptVersion: ORNAMENT_PROMPT_VERSION,
        evidence: refs,
        elements: sized.elements,
        corrections: check.corrections,
        emptySlots: check.emptySlots,
        model,
        revision: { passes, problems },
        dropped: check.dropped.map(d => ({ elementId: d.elementId, slotId: d.slotId, by: d.by, problems: d.problems }))
    };
    return { spec, replies, supportTestRequired, dropped: check.dropped, rejectedCorrections: check.rejectedCorrections, anchored: check.anchored ?? [] };
}

/** The thinking a VisionModelUse records for a model when no call was made (a failure before any attempt). */
export function plannedThinking(model: string): VisionModelUse['thinking'] {
    return describeThinking(thinkingConfigFor(model, ORNAMENT_THINKING_BUDGET));
}

