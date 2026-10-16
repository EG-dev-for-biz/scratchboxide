/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Anchoring: a photo reading's sizes are estimates, the scan's geometry is measured.
 *
 * A repeat's count × pitch is held against the length of the run the survey located on the fitted face (a dentil
 * course against the fitted cornice's length), and everything is held against the slot it lives in. The
 * model's scale in an answer is only an estimate, so:
 *   - when the disagreement is within the photo-correction tolerance (0.31 m, the same one primitives use) the value is
 *     snapped to the scan-anchored one, and the element is labelled photo-corrected with the error it carried;
 *   - when an element runs past its slot by no more than that, it is clipped back into the slot (the same label);
 *   - when the disagreement is larger, nothing is snapped: the problem goes back to the model once, with the numbers,
 *     which is the only case that costs a second call.
 * Elements outside a slot by more than the tolerance are left to the slot rules, as before. Nothing here knows what an
 * element is called: only its operator, its numbers and the geometry it was located on.
 */

import { PHOTO_CORRECTION_TOLERANCE_M, PROVENANCE, type OperatorSpec, type OrnamentSlot, type StructureFit, type Vec2 } from '../../../common/spatial/staged-location-contracts';
import type { ExpandedElement } from './ornament-expand';
import { bbox, footprint, pointInPolygon } from './ornament-vision';
import type { LocatedElement } from './survey-detail';

export interface AnchorNote {
    elementId: string;
    slotId: string;
    kind: 'run-snapped' | 'pitch-snapped' | 'count-clipped' | 'clipped-to-slot' | (string & {});
    /** How far the model's value was from the scan-anchored one, metres. */
    errorM: number;
    toleranceM: number;
    before: string;
    after: string;
    note: string;
}

export interface AnchorResult { notes: AnchorNote[]; problems: Map<number, string[]> }

const mm = (m: number) => `${Math.round(m * 1000)} mm`;
const r3 = (v: number) => Math.round(v * 1000) / 1000;

function pickRun(l: LocatedElement[], count: number): LocatedElement | undefined {
    const withRun = l.filter(x => x.runAlongM && x.runAlongM[1] - x.runAlongM[0] > 0.05);
    const repeats = withRun.filter(x => x.repeat);
    const pool = repeats.length ? repeats : withRun;
    return [...pool].sort((a, b) => Math.abs((a.repeat?.count ?? count) - count) - Math.abs((b.repeat?.count ?? count) - count) || (b.runAlongM![1] - b.runAlongM![0]) - (a.runAlongM![1] - a.runAlongM![0]))[0];
}

function pickLattice(l: LocatedElement[], surfaceId: string, axisCounts: [number, number]): LocatedElement | undefined {
    const pool = l.filter(x => x.surfaceId === surfaceId && x.repeat);
    return [...pool].sort((a, b) => Math.abs(a.repeat!.count - Math.max(...axisCounts)) - Math.abs(b.repeat!.count - Math.max(...axisCounts)))[0];
}

/** Anchors the expanded elements in place. Returns what was changed (with the error each carried) and what could not be (as problems for the one revision). */
export function anchorElements(
    expanded: ExpandedElement[],
    fit: Pick<StructureFit, 'slots'>,
    located: LocatedElement[],
    toleranceM = PHOTO_CORRECTION_TOLERANCE_M
): AnchorResult {
    const notes: AnchorNote[] = [];
    const problems = new Map<number, string[]>();
    const slotById = new Map(fit.slots.map(s => [s.id, s]));
    const problem = (x: ExpandedElement, text: string) => { problems.set(x.replyIndex, [...(problems.get(x.replyIndex) ?? []), text]); };
    const note = (x: ExpandedElement, n: Omit<AnchorNote, 'elementId' | 'slotId' | 'toleranceM'>) => { notes.push({ elementId: x.element.id, slotId: x.element.slotId, toleranceM, ...n }); };

    for (const x of expanded) {
        const slot: OrnamentSlot | undefined = slotById.get(x.element.slotId);
        if (!slot) continue;
        const spec: OperatorSpec = x.element.spec;
        const here = located.filter(l => l.slotId === slot.id);

        if (spec.operator === 'replicate' && 'along' in spec.replicate.domain && 'edge' in slot.host) {
            const L = slot.host.edge.carrier.lengthM;
            const along = spec.replicate.domain.along;
            const carrier = along.carrier;
            const t0Slot = 'slot' in carrier ? carrier.slot : undefined;
            const run = pickRun(here, along.count);
            if (run) {
                let a = run.runAlongM![0], b = run.runAlongM![1];
                if (b - a >= 0.9 * L) { a = 0; b = L; }
                const runLen = b - a;
                const error = Math.abs(along.count * along.pitchM - runLen);
                if (error <= toleranceM) {
                    const before = `${along.count} × ${mm(along.pitchM)} = ${r3(along.count * along.pitchM)} m`;
                    along.pitchM = r3(runLen / along.count);
                    along.startOffsetM = 0;
                    if (t0Slot) t0Slot.t0 = r3(a / L);
                    if (error > 1e-4) note(x, { kind: 'run-snapped', errorM: r3(error), before, after: `${along.count} × ${mm(along.pitchM)} = ${r3(runLen)} m, from ${a.toFixed(2)} m`, note: `count × pitch was ${r3(error)} m off the ${r3(runLen)} m run the survey located on the fitted edge; snapped (within ${toleranceM} m)` });
                } else {
                    problem(x, `anchor: ${along.count} repeats × ${mm(along.pitchM)} = ${r3(along.count * along.pitchM)} m, but the run located on ${slot.id} from the survey spans ${r3(runLen)} m (${r3(error)} m apart, more than ${toleranceM} m): recount the repeats or re-measure the pitch so count × pitch matches that run`);
                }
            } else {
                // no located run: the repeat must still fit the fitted edge
                const start = (t0Slot?.t0 ?? 0) * L + along.startOffsetM;
                const end = start + (along.count - 1) * along.pitchM;
                if (end > L + 1e-4) {
                    const over = end - L;
                    if (over <= toleranceM && along.count > 1) {
                        const before = `${along.count} × ${mm(along.pitchM)}, last at ${end.toFixed(2)} m of ${L.toFixed(2)} m`;
                        along.pitchM = r3((L - start) / (along.count - 1));
                        note(x, { kind: 'pitch-snapped', errorM: r3(over), before, after: `${along.count} × ${mm(along.pitchM)}`, note: `the last repeat was ${r3(over)} m past the fitted ${L.toFixed(2)} m edge; pitch snapped (within ${toleranceM} m)` });
                    } else {
                        const fits = Math.max(1, Math.floor((L - start) / along.pitchM + 1e-6) + 1);
                        const before = `${along.count} × ${mm(along.pitchM)}`;
                        along.count = Math.min(along.count, fits);
                        note(x, { kind: 'count-clipped', errorM: r3(over), before, after: `${along.count} × ${mm(along.pitchM)}`, note: `${r3(over)} m of the row lay past the fitted ${L.toFixed(2)} m edge; the repeats that fit were kept` });
                    }
                }
            }
        } else if (spec.operator === 'replicate' && 'lattice' in spec.replicate.domain && 'surface' in slot.host) {
            const g = spec.replicate.domain.lattice;
            const region = slot.host.surface.regionUv;
            const b = bbox(region);
            const run = pickLattice(here, slot.host.surface.surfaceId, g.counts);
            if (run) {
                const axis = run.repeat!.axis;
                const snap = (name: 'u' | 'v', count: number, pitch: number, lo: number, hi: number): number | undefined => {
                    const len = Math.max(0, Math.min(hi, name === 'u' ? b.u1 : b.v1) - Math.max(lo, name === 'u' ? b.u0 : b.v0));
                    if (len < 0.05 || count < 2) return undefined;
                    const error = Math.abs(count * pitch - len);
                    if (error <= toleranceM) {
                        if (error > 1e-4) note(x, { kind: 'run-snapped', errorM: r3(error), before: `${count} × ${mm(pitch)} along ${name}`, after: `${count} × ${mm(len / count)}`, note: `count × pitch along ${name} was ${r3(error)} m off the ${r3(len)} m run the survey located on the fitted face; snapped (within ${toleranceM} m)` });
                        return r3(len / count);
                    }
                    problem(x, `anchor: ${count} repeats × ${mm(pitch)} along ${name} = ${r3(count * pitch)} m, but the run located on ${slot.id} spans ${r3(len)} m (${r3(error)} m apart, more than ${toleranceM} m): recount or re-measure`);
                    return undefined;
                };
                if (axis !== 'v') { const p = snap('u', g.counts[0], g.pitchUv[0], run.regionUv.u0, run.regionUv.u1); if (p !== undefined) { g.pitchUv[0] = p; g.originUv[0] = Math.max(b.u0, run.regionUv.u0); } }
                if (axis === 'v' || axis === 'grid') { const p = snap('v', g.counts[1], g.pitchUv[1], run.regionUv.v0, run.regionUv.v1); if (p !== undefined) { g.pitchUv[1] = p; g.originUv[1] = Math.max(b.v0, run.regionUv.v0); } }
            }
            // whatever the survey said, no instance leaves the slot's region by more than it can be clipped
            const before = `${g.counts[0]} × ${g.counts[1]}`;
            let dropped = false;
            for (let i = g.counts[0] - 1; i >= 1; i--) if (g.originUv[0] + (g.counts[0] - 1) * g.pitchUv[0] + g.rowOffsetU > b.u1 + toleranceM && g.counts[0] > 1) { g.counts[0] = Math.max(1, Math.floor((b.u1 + 1e-6 - g.originUv[0] - g.rowOffsetU) / (g.pitchUv[0] || 1)) + 1); dropped = true; break; }
            if (g.originUv[1] + (g.counts[1] - 1) * g.pitchUv[1] > b.v1 + toleranceM && g.counts[1] > 1) { g.counts[1] = Math.max(1, Math.floor((b.v1 + 1e-6 - g.originUv[1]) / (g.pitchUv[1] || 1)) + 1); dropped = true; }
            if (dropped) note(x, { kind: 'count-clipped', errorM: 0, before, after: `${g.counts[0]} × ${g.counts[1]}`, note: 'the grid ran past the slot; the cells that fit were kept' });
        } else if (spec.operator === 'sweep' && 'slot' in spec.sweep.carrier && 'edge' in slot.host) {
            const c = spec.sweep.carrier.slot;
            const L = slot.host.edge.carrier.lengthM;
            const t0 = Math.max(0, c.t0), t1 = Math.min(1, c.t1);
            if ((t0 !== c.t0 || t1 !== c.t1) && t1 > t0) {
                const over = Math.max((c.t0 < 0 ? -c.t0 : 0), (c.t1 > 1 ? c.t1 - 1 : 0)) * L;
                if (over <= toleranceM) {
                    note(x, { kind: 'clipped-to-slot', errorM: r3(over), before: `t ${c.t0.toFixed(3)}..${c.t1.toFixed(3)}`, after: `t ${t0.toFixed(3)}..${t1.toFixed(3)}`, note: `the sweep ran ${r3(over)} m past the fitted edge; clipped to it (within ${toleranceM} m)` });
                    c.t0 = t0; c.t1 = t1;
                }
            }
        } else if ('surface' in slot.host && spec.operator !== 'replicate') {
            const poly: Vec2[] = slot.host.surface.regionUv;
            const outside = footprint(spec, slot).filter(p => !pointInPolygon(p[0], p[1], poly));
            if (outside.length) {
                const b = bbox(poly);
                const over = Math.max(...outside.map(p => Math.max(b.u0 - p[0], p[0] - b.u1, b.v0 - p[1], p[1] - b.v1, 0)));
                if (over > 0 && over <= toleranceM) {
                    const fp = bbox(footprint(spec, slot));
                    // shift the element back into the slot's bounding box by the overshoot, then keep it only if it is then inside the region
                    const du = fp.u0 < b.u0 ? b.u0 - fp.u0 : fp.u1 > b.u1 ? b.u1 - fp.u1 : 0;
                    const dv = fp.v0 < b.v0 ? b.v0 - fp.v0 : fp.v1 > b.v1 ? b.v1 - fp.v1 : 0;
                    const moved = shiftSpec(spec, du, dv);
                    if (moved && footprint(spec, slot).every(p => pointInPolygon(p[0], p[1], poly))) {
                        note(x, { kind: 'clipped-to-slot', errorM: r3(over), before: 'ran outside the slot', after: `moved ${mm(du)} in u and ${mm(dv)} in v`, note: `the element ran ${r3(over)} m outside slot ${slot.id}; moved back inside it (within ${toleranceM} m)` });
                    } else if (moved) shiftSpec(spec, -du, -dv);
                }
            }
        }

        const mine = notes.filter(n => n.elementId === x.element.id);
        if (mine.length) {
            x.element.checks.anchor = { errorM: Math.max(...mine.map(n => n.errorM)), toleranceM, changes: mine.map(n => n.note) };
            x.element.provenance.label = PROVENANCE.photoCorrected;
            x.element.provenance.note = `${x.element.provenance.note ? `${x.element.provenance.note}; ` : ''}photo-corrected inside the scan tolerance: ${mine.map(n => n.note).join('; ')}`;
        }
    }
    return { notes, problems };
}

/** Shifts a leaf spec's chart positions by (du, dv). Returns false when the spec has no positions to shift. */
function shiftSpec(spec: OperatorSpec, du: number, dv: number): boolean {
    if (!du && !dv) return false;
    if (spec.operator === 'relief') { spec.relief.region.outer = spec.relief.region.outer.map(p => [p[0] + du, p[1] + dv] as Vec2); if ('grid' in spec.relief.height) { spec.relief.height.grid.originUv = [spec.relief.height.grid.originUv[0] + du, spec.relief.height.grid.originUv[1] + dv]; } return true; }
    if (spec.operator === 'revolve') { spec.revolve.axisOrigin = [spec.revolve.axisOrigin[0] + du, spec.revolve.axisOrigin[1] + dv, spec.revolve.axisOrigin[2]]; return true; }
    if (spec.operator === 'sweep' && 'chart' in spec.sweep.carrier) { spec.sweep.carrier.chart.pointsUv = spec.sweep.carrier.chart.pointsUv.map(p => [p[0] + du, p[1] + dv] as Vec2); return true; }
    return false;
}
