/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The vision model's compact, slot-relative reply (prompt ornament/v2) expanded into operator specs in each element's
 * host chart (u, v, n), metres:
 * - integer millimetres become metres, per-mille becomes a fraction, a 0-100 confidence becomes 0-1;
 * - a sweep's `t` becomes a slot carrier along the edge slot's crease, a sweep's `path` a chart carrier;
 * - a revolve's `at` and `axis` become its axis in (u, v, n);
 * - a relief's `box` or `poly` becomes its region, on the slot's host surface;
 * - a replicate's `along` becomes a slot-carrier domain, its `grid` a lattice;
 * - an evidence index becomes the image id.
 * A replicate's seed is in the instance's own frame (the builder places it at each instance). Nothing here depends on
 * what an element is called: labels are carried as diagnostics only.
 */

import {
    ORNAMENT_REPLICATE_MAX_COUNT,
    PROVENANCE,
    type CompactBox,
    type CompactElement,
    type CompactLeafOp,
    type CompactOp,
    type ElementEvidence,
    type EvidenceImageRef,
    type LeafOperatorSpec,
    type OperatorSpec,
    type OrnamentElement,
    type OrnamentSlot,
    type StructureFit,
    type Vec2,
    type Vec3
} from '../../../common/spatial/staged-location-contracts';

const mm = (v: number) => v / 1000;

/** [a, b, c, d, …] mm as [[a, b], [c, d], …] m. */
export function pairsM(flat: number[]): Vec2[] {
    const out: Vec2[] = [];
    for (let i = 0; i + 1 < flat.length; i += 2) out.push([mm(flat[i]), mm(flat[i + 1])]);
    return out;
}

/** The surface an element's chart coordinates live on: the surface slot's host, or an edge slot's first surface. */
export function slotSurfaceId(slot: OrnamentSlot): string | undefined {
    return 'surface' in slot.host ? slot.host.surface.surfaceId : slot.host.edge.surfaceIds[0];
}

export interface ExpandContext {
    slot: OrnamentSlot;
    /** The finest feature the relief re-tessellation targets (m). */
    reliefMaxEdgeM: number;
}

function leafSpec(op: CompactLeafOp, ctx: ExpandContext): LeafOperatorSpec {
    if ('sweep' in op) {
        const s = op.sweep;
        const carrier = s.path
            ? { chart: { pointsUv: pairsM(s.path), closed: !!s.closed } }
            : { slot: { slotId: ctx.slot.id, t0: (s.t?.[0] ?? 0) / 1000, t1: (s.t?.[1] ?? 1000) / 1000, offset: [mm(s.offset?.[0] ?? 0), mm(s.offset?.[1] ?? 0)] as Vec2 } };
        return { operator: 'sweep', sweep: { carrier, profile: { outer: pairsM(s.profile) }, miterLimit: 4, caps: true } };
    }
    if ('revolve' in op) {
        const r = op.revolve;
        const axisDir: Vec3 = r.axis === 'n' ? [0, 0, 1] : r.axis === 'u' ? [1, 0, 0] : [0, 1, 0];
        return {
            operator: 'revolve',
            revolve: {
                axisOrigin: [mm(r.at[0]), mm(r.at[1]), 0], axisDir, profile: pairsM(r.profile),
                lobes: r.lobes ?? 0, lobeAmplitude: (r.lobeAmp ?? 0) / 1000, helixTurns: 0,
                startAngleDeg: 0, sweepAngleDeg: r.sweepDeg ?? 360, segments: 32
            }
        };
    }
    const rl = op.relief;
    const outer: Vec2[] = rl.box
        ? [[mm(rl.box[0]), mm(rl.box[1])], [mm(rl.box[2]), mm(rl.box[1])], [mm(rl.box[2]), mm(rl.box[3])], [mm(rl.box[0]), mm(rl.box[3])]]
        : pairsM(rl.poly ?? []);
    const minU = Math.min(...outer.map(p => p[0])), minV = Math.min(...outer.map(p => p[1]));
    const height = rl.grid
        ? { grid: { cols: rl.grid.cols, rows: rl.grid.rows, cellM: mm(rl.grid.cell), originUv: [minU, minV] as Vec2, heightsM: rl.grid.heights.map(mm) } }
        : {
            panel: {
                depthM: mm(rl.depth ?? 0), edgeWidthM: mm(rl.edge ?? 0),
                edgeProfile: rl.edgeProfile ? rl.edgeProfile.reduce<Vec2[]>((acc, v, i, a) => (i % 2 === 0 && i + 1 < a.length ? [...acc, [v / 1000, a[i + 1] / 1000]] : acc), []) : [[0, 0], [1, 1]] as Vec2[]
            }
        };
    return { operator: 'relief', relief: { surfaceId: slotSurfaceId(ctx.slot) ?? '', region: { outer }, height, maxEdgeM: ctx.reliefMaxEdgeM } };
}

export function expandOp(op: CompactOp, ctx: ExpandContext): OperatorSpec {
    if ('replicate' in op) {
        const r = op.replicate;
        const seed = leafSpec(r.seed, ctx);
        const domain = r.along
            ? { along: { carrier: { slot: { slotId: ctx.slot.id, t0: r.along[0] / 1000, t1: 1, offset: [0, 0] as Vec2 } }, pitchM: mm(r.along[1]), count: r.along[2], startOffsetM: 0 } }
            : { lattice: { originUv: [mm(r.grid![0]), mm(r.grid![1])] as Vec2, pitchUv: [mm(r.grid![2]), mm(r.grid![3])] as Vec2, counts: [r.grid![4], r.grid![5]] as [number, number], rowOffsetU: mm(r.grid![6]) } };
        return { operator: 'replicate', replicate: { seed, domain, alignToSurface: true } };
    }
    return leafSpec(op, ctx);
}

export function expandEvidence(boxes: CompactBox[], images: Pick<EvidenceImageRef, 'id' | 'index'>[]): ElementEvidence[] {
    return boxes.map(([index, y0, x0, y1, x1]) => {
        const img = images.find(i => i.index === index);
        return { imageId: img ? img.id : `unknown:${index}`, box1000: [y0, x0, y1, x1] };
    });
}

export interface ExpandedElement {
    element: OrnamentElement;
    /** Index in the reply's elements list (for revision problems). */
    replyIndex: number;
}

/**
 * Every compact element of the reply as an OrnamentElement (ids e000…, in reply order); elements naming an unknown
 * slot are left out (rule 3 reports them). Build order: by the fitter's slot order, then the reply's order in a slot.
 */
export function expandElements(elements: CompactElement[], fit: Pick<StructureFit, 'slots' | 'sourceLimits'>, images: Pick<EvidenceImageRef, 'id' | 'index' | 'kind'>[], method: string): ExpandedElement[] {
    const slotOrder = new Map(fit.slots.map((s, i) => [s.id, i]));
    const reliefMaxEdgeM = Math.max(0.02, Math.min(0.1, fit.sourceLimits.photoResolvableM / 4 || 0.05));
    const out: ExpandedElement[] = [];
    elements.forEach((e, replyIndex) => {
        const slot = fit.slots.find(s => s.id === e.slot);
        if (!slot) return;
        const evidence = expandEvidence(e.ev, images);
        const confidence = Math.max(0, Math.min(1, e.conf / 100));
        out.push({
            replyIndex,
            element: {
                id: `e${String(replyIndex).padStart(3, '0')}`,
                slotId: slot.id,
                ...(e.label ? { label: e.label } : {}),
                spec: expandOp(e.op, { slot, reliefMaxEdgeM }),
                confidence,
                depthBasis: e.depthBasis,
                ...(e.beyondView ? { continuesBeyondView: true } : {}),
                evidence,
                checks: { slotOverlap: 0, minFeatureM: 0, nativeSampleM: 0 },
                provenance: {
                    label: PROVENANCE.photoInferred, measuredGeometry: false, confidence, method,
                    sources: evidence.map(ev => {
                        const img = images.find(i => i.id === ev.imageId);
                        return { kind: img?.kind ?? 'unknown', id: ev.imageId };
                    })
                },
                buildOrder: 0
            }
        });
    });
    const sorted = [...out].sort((a, b) => (slotOrder.get(a.element.slotId)! - slotOrder.get(b.element.slotId)!) || a.replyIndex - b.replyIndex);
    sorted.forEach((x, i) => { x.element.buildOrder = i; });
    return out;
}

/**
 * A replicate the model read with more repeats than one domain takes (ORNAMENT_REPLICATE_MAX_COUNT per axis) is split
 * into consecutive blocks that place exactly the same instances: a lattice into blocks of at most the limit per axis
 * (each block's origin moved by whole pitches; blocks start on even rows, so the alternate-row offset keeps its phase),
 * a run along an edge into runs whose start offsets continue the pitch. Nothing is dropped or re-measured; the first block
 * keeps the element's id, the others get "-2", "-3"..., and every block's provenance note says it was split.
 */
export function splitOversizeReplicates(elements: OrnamentElement[], max = ORNAMENT_REPLICATE_MAX_COUNT): { elements: OrnamentElement[]; split: Array<{ elementId: string; parts: string[]; before: string }> } {
    if (max % 2) throw new Error('the replicate limit must be even so split lattice blocks keep the row-offset phase');
    const out: OrnamentElement[] = [];
    const split: Array<{ elementId: string; parts: string[]; before: string }> = [];
    for (const el of elements) {
        const spec = el.spec;
        if (spec.operator !== 'replicate') { out.push(el); continue; }
        const d = spec.replicate.domain;
        const blocks: Array<OperatorSpec> = [];
        let before = '';
        if ('lattice' in d && (d.lattice.counts[0] > max || d.lattice.counts[1] > max)) {
            const g = d.lattice;
            before = `${g.counts[0]} × ${g.counts[1]}`;
            for (let j0 = 0; j0 < g.counts[1]; j0 += max) for (let i0 = 0; i0 < g.counts[0]; i0 += max) {
                blocks.push({ operator: 'replicate', replicate: { ...spec.replicate, domain: { lattice: {
                    originUv: [g.originUv[0] + i0 * g.pitchUv[0], g.originUv[1] + j0 * g.pitchUv[1]] as Vec2, pitchUv: [g.pitchUv[0], g.pitchUv[1]] as Vec2,
                    counts: [Math.min(max, g.counts[0] - i0), Math.min(max, g.counts[1] - j0)], rowOffsetU: g.rowOffsetU
                } } } });
            }
        } else if ('along' in d && d.along.count > max) {
            const a = d.along;
            before = `${a.count} along`;
            for (let k0 = 0; k0 < a.count; k0 += max) {
                blocks.push({ operator: 'replicate', replicate: { ...spec.replicate, domain: { along: { ...a, count: Math.min(max, a.count - k0), startOffsetM: a.startOffsetM + k0 * a.pitchM } } } });
            }
        }
        if (!blocks.length) { out.push(el); continue; }
        const parts = blocks.map((_, k) => (k ? `${el.id}-${k + 1}` : el.id));
        const note = `read as one replicate of ${before}; split into ${blocks.length} blocks of at most ${max} per axis (the builder's limit), the same instances at the same places`;
        blocks.forEach((b, k) => out.push({ ...el, id: parts[k], spec: b, provenance: { ...el.provenance, note: el.provenance.note ? `${el.provenance.note}; ${note}` : note } }));
        split.push({ elementId: el.id, parts, before });
    }
    // with a split, build order is renumbered so the blocks of one element follow each other
    if (split.length) [...out].map((e, i) => ({ e, i })).sort((x, y) => (x.e.buildOrder - y.e.buildOrder) || (x.i - y.i)).forEach((x, rank) => { x.e.buildOrder = rank; });
    return { elements: out, split };
}
