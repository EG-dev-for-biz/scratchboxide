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
import { blockedAt, coveredAt, coveredBoxes, coveredShare, openStretches, type SlotCover } from './slot-cover';

export interface AnchorNote {
    elementId: string;
    slotId: string;
    kind: 'run-snapped' | 'pitch-snapped' | 'count-clipped' | 'clipped-to-slot' | 'clipped-to-open' | (string & {});
    /** How far the model's value was from the scan-anchored one, metres. */
    errorM: number;
    toleranceM: number;
    before: string;
    after: string;
    note: string;
}

/**
 * A reading whose count × pitch disagrees with the measured span by more than the tolerance is asked about once (the re-read). When
 * the re-read still disagrees, the measured span wins if the reading is within reach of it: the pitch is set to span ÷ count and the
 * element is labelled photo-corrected with the error it carried. Beyond this ratio the reading cannot be the same thing (a row read as
 * 72 m on a 10.5 m span), and it is rejected.
 */
export const PLAUSIBLE_SPAN_RATIO = { min: 0.4, max: 2.5 } as const;
export function plausibleSpan(readM: number, measuredM: number): boolean {
    return measuredM > 0 && readM / measuredM >= PLAUSIBLE_SPAN_RATIO.min && readM / measuredM <= PLAUSIBLE_SPAN_RATIO.max;
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
    toleranceM = PHOTO_CORRECTION_TOLERANCE_M,
    final = false,
    covers?: Map<string, SlotCover>
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
            // The located run is the survey model's own box cast through the nominal pano pose: its place is good to run.locationUncertaintyM.
            // Only a run that is trustworthy to the photo-correction tolerance may overwrite a pitch; a looser one is a cross-check only, and the
            // reading is then held against the fitted edge's length (measured), below.
            const usable = run && run.locationUncertaintyM <= toleranceM;
            if (run && usable) {
                let a = run.runAlongM![0], b = run.runAlongM![1];
                let extended = '';
                if (b - a >= 0.9 * L && b - a < L - 1e-4) { extended = `; the located run (${r3(b - a)} m) was ≥ 90% of the ${r3(L)} m edge and was taken as the whole edge`; a = 0; b = L; }
                const runLen = b - a;
                const error = Math.abs(along.count * along.pitchM - runLen);
                const src = `run from ${run.placeSource}, good to ±${run.locationUncertaintyM} m`;
                const readSpan = along.count * along.pitchM;
                const snapAnyway = error > toleranceM && final && plausibleSpan(readSpan, runLen);
                if (error <= toleranceM || snapAnyway) {
                    const before = `${along.count} × ${mm(along.pitchM)} = ${r3(along.count * along.pitchM)} m`;
                    along.pitchM = r3(runLen / along.count);
                    along.startOffsetM = 0;
                    if (t0Slot) t0Slot.t0 = r3(a / L);
                    if (error > 1e-4 || extended) note(x, { kind: snapAnyway ? 'pitch-snapped' : 'run-snapped', errorM: r3(error + run.locationUncertaintyM), before, after: `${along.count} × ${mm(along.pitchM)} = ${r3(runLen)} m, from ${a.toFixed(2)} m`, note: snapAnyway ? `count × pitch was ${r3(error)} m off the ${r3(runLen)} m ${src} and the re-read agreed with the first reading; the measured span was kept (the pitch is now span ÷ count) and the error is carried in this label${extended}` : `count × pitch was ${r3(error)} m off the ${r3(runLen)} m ${src}; snapped (within ${toleranceM} m); the error carried includes the ±${run.locationUncertaintyM} m of the run's own place${extended}` });
                } else {
                    problem(x, `anchor: the crop was read as ${along.count} repeats × ${mm(along.pitchM)} = ${r3(along.count * along.pitchM)} m, while the ${src} spans ${r3(runLen)} m on ${slot.id}, ${r3(error)} m apart (more than ${toleranceM} m). Look at the image again and re-read the repeat count and the pitch as they appear; do not adjust them to match the span, which is only approximate`);
                }
            } else {
                // no trustworthy located run (none, or one placed more loosely than the tolerance): the repeat must still fit the fitted edge, which is measured
                if (run) {
                    // a cross-check only: it can raise the discrepancy for a re-read, it never changes a number
                    const runLen = run.runAlongM![1] - run.runAlongM![0];
                    const gap = Math.abs(along.count * along.pitchM - runLen);
                    if (!final && gap > toleranceM + run.locationUncertaintyM) problem(x, `anchor: the crop was read as ${along.count} repeats × ${mm(along.pitchM)} = ${r3(along.count * along.pitchM)} m, while the survey's box puts the run at about ${r3(runLen)} m (±${run.locationUncertaintyM} m, from ${run.placeSource}), ${r3(gap)} m apart. Look at the image again and re-read the repeat count and the pitch as they appear; do not adjust them to match that span, which is only approximate`);
                }
                if (along.count * along.pitchM > PLAUSIBLE_SPAN_RATIO.max * L) {
                    // not a measurement error: a row several times the whole edge it lives on is a miscount, and clipping it would make up a row
                    problem(x, `anchor: the crop was read as ${along.count} repeats × ${mm(along.pitchM)} = ${r3(along.count * along.pitchM)} m, but the whole edge ${slot.id} is ${r3(L)} m long. Look at the image again and re-count the repeats and re-read the pitch as they appear`);
                    continue;
                }
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
                    if (error <= toleranceM || (final && plausibleSpan(count * pitch, len))) {
                        if (error > 1e-4) note(x, { kind: error <= toleranceM ? 'run-snapped' : 'pitch-snapped', errorM: r3(error), before: `${count} × ${mm(pitch)} along ${name}`, after: `${count} × ${mm(len / count)}`, note: error <= toleranceM ? `count × pitch along ${name} was ${r3(error)} m off the ${r3(len)} m run the survey located on the fitted face; snapped (within ${toleranceM} m)` : `count × pitch along ${name} was ${r3(error)} m off the ${r3(len)} m run located on the fitted face and the re-read agreed with the first reading; the measured run was kept and the error is carried in this label` });
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
                // after the one re-read, an element that still runs out of its slot by up to a metre is moved back in, and says so (the slot is measured, the box is a photo's)
                const reach = final ? Math.max(toleranceM, 1.0) : toleranceM;
                if (over > 0 && over <= reach) {
                    const fp = bbox(footprint(spec, slot));
                    // shift the element back into the slot's bounding box by the overshoot, then keep it only if it is then inside the region
                    const du = fp.u0 < b.u0 ? b.u0 - fp.u0 : fp.u1 > b.u1 ? b.u1 - fp.u1 : 0;
                    const dv = fp.v0 < b.v0 ? b.v0 - fp.v0 : fp.v1 > b.v1 ? b.v1 - fp.v1 : 0;
                    const moved = shiftSpec(spec, du, dv);
                    if (moved && footprint(spec, slot).every(p => pointInPolygon(p[0], p[1], poly))) {
                        note(x, { kind: 'clipped-to-slot', errorM: r3(over), before: 'ran outside the slot', after: `moved ${mm(du)} in u and ${mm(dv)} in v`, note: over <= toleranceM ? `the element ran ${r3(over)} m outside slot ${slot.id}; moved back inside it (within ${toleranceM} m)` : `the element ran ${r3(over)} m outside slot ${slot.id}, beyond the ${toleranceM} m tolerance, after the re-read; moved back inside it and the error is carried in this label` });
                    } else if (moved) shiftSpec(spec, -du, -dv);
                }
            }
        }

        // where another fitted primitive fills the slot's free space nothing can stand free of the solid: clip into the open part, or send back
        const cover = covers?.get(slot.id);
        if (cover?.kind === 'edge' && 'edge' in slot.host) {
            const L = slot.host.edge.carrier.lengthM;
            if (spec.operator === 'sweep' && 'slot' in spec.sweep.carrier) {
                const c = spec.sweep.carrier.slot;
                const t0 = Math.max(0, c.t0), t1 = Math.min(1, c.t1);
                let hit = false;
                for (let k = 0; k < 24 && !hit; k++) if (blockedAt(cover, t0 + ((t1 - t0) * (k + 0.5)) / 24)) hit = true;
                if (hit) {
                    let best: [number, number] | undefined;
                    for (const [a, b] of openStretches(cover)) {
                        const lo = Math.max(a, t0), hi = Math.min(b, t1);
                        if (hi - lo > (best ? best[1] - best[0] : 0)) best = [lo, hi];
                    }
                    if (best && ((best[1] - best[0]) * L >= 1.0 || (best[1] - best[0]) >= 0.25 * (t1 - t0))) {
                        const lost = ((t1 - t0) - (best[1] - best[0])) * L;
                        note(x, { kind: 'clipped-to-open', errorM: r3(lost), before: `t ${c.t0.toFixed(3)}..${c.t1.toFixed(3)}`, after: `t ${best[0].toFixed(3)}..${best[1].toFixed(3)}`, note: `${r3(lost)} m of the sweep lay where another part of the fitted structure fills the space beside the edge; clipped to the longest free stretch (${r3((best[1] - best[0]) * L)} m)` });
                        c.t0 = best[0]; c.t1 = best[1];
                    } else problem(x, `cover: the sweep along ${slot.id} runs where another part of the structure fills the space beside the edge; the free stretches are t ${openStretches(cover).map(([a, b]) => `${Math.round(a * 1000)}-${Math.round(b * 1000)}`).join(', ') || 'none'} per-mille. Build only inside one of them`);
                }
            } else if (spec.operator === 'replicate' && 'along' in spec.replicate.domain) {
                const along = spec.replicate.domain.along;
                const carrier = along.carrier;
                const t0Slot = 'slot' in carrier ? carrier.slot : undefined;
                const start = (t0Slot?.t0 ?? 0) * L + along.startOffsetM;
                const open: boolean[] = [];
                for (let k = 0; k < along.count; k++) open.push(!blockedAt(cover, Math.min(0.9999, (start + k * along.pitchM) / L)));
                let bestA = -1, bestN = 0;
                for (let k = 0; k < open.length; k++) {
                    if (!open[k]) continue;
                    let n = 0;
                    while (k + n < open.length && open[k + n]) n++;
                    if (n > bestN) { bestN = n; bestA = k; }
                    k += n;
                }
                if (bestN < along.count) {
                    if (bestN >= Math.max(2, Math.ceil(along.count / 2))) {
                        const before = `${along.count} × ${mm(along.pitchM)} from ${start.toFixed(2)} m`;
                        const newStart = start + bestA * along.pitchM;
                        along.count = bestN;
                        along.startOffsetM = r3(newStart - (t0Slot?.t0 ?? 0) * L);
                        note(x, { kind: 'count-clipped', errorM: r3((open.length - bestN) * along.pitchM), before, after: `${along.count} × ${mm(along.pitchM)} from ${newStart.toFixed(2)} m`, note: `${open.length - bestN} of the ${open.length} repeats stood where another part of the fitted structure fills the space beside the edge; the longest free run of ${bestN} was kept` });
                    } else problem(x, `cover: the repeat along ${slot.id} runs where another part of the structure fills the space beside the edge; the free stretches are t ${openStretches(cover).map(([a, b]) => `${Math.round(a * 1000)}-${Math.round(b * 1000)}`).join(', ') || 'none'} per-mille. Count and place only the repeats inside one of them`);
                }
            }
        } else if (cover?.kind === 'surface' && 'surface' in slot.host) {
            if (spec.operator === 'replicate' && 'lattice' in spec.replicate.domain) {
                const g = spec.replicate.domain.lattice;
                const cell = (i: number, j: number) => coveredAt(cover, g.originUv[0] + i * g.pitchUv[0] + (j % 2 ? g.rowOffsetU : 0), g.originUv[1] + j * g.pitchUv[1]);
                const rowAll = (j: number) => Array.from({ length: g.counts[0] }, (_, i) => cell(i, j)).every(Boolean);
                const colAll = (i: number) => Array.from({ length: g.counts[1] }, (_, j) => cell(i, j)).every(Boolean);
                const before = `${g.counts[0]} × ${g.counts[1]}`;
                let trimmed = false;
                for (let guard = 0; guard < 64; guard++) {
                    if (g.counts[1] > 1 && rowAll(0)) { g.originUv[1] += g.pitchUv[1]; g.counts[1]--; trimmed = true; continue; }
                    if (g.counts[1] > 1 && rowAll(g.counts[1] - 1)) { g.counts[1]--; trimmed = true; continue; }
                    if (g.counts[0] > 1 && colAll(0)) { g.originUv[0] += g.pitchUv[0]; g.counts[0]--; trimmed = true; continue; }
                    if (g.counts[0] > 1 && colAll(g.counts[0] - 1)) { g.counts[0]--; trimmed = true; continue; }
                    break;
                }
                let any = false;
                for (let j = 0; j < g.counts[1]; j++) for (let i = 0; i < g.counts[0]; i++) if (cell(i, j)) any = true;
                if (any) problem(x, `cover: the grid on ${slot.id} stands partly over ${coveredBoxes(cover).map(b => `u ${r3(b.u0)}-${r3(b.u1)} m, v ${r3(b.v0)}-${r3(b.v1)} m`).join('; ')}, which another part of the structure covers. Keep every cell out of it`);
                else if (trimmed) note(x, { kind: 'count-clipped', errorM: 0, before, after: `${g.counts[0]} × ${g.counts[1]}`, note: 'rows or columns of the grid stood over a part of the slot that another fitted primitive covers; they were left out' });
            } else if (spec.operator !== 'replicate') {
                const fp = bbox(footprint(spec, slot));
                const share = coveredShare(cover, fp);
                if (share > 0.02) problem(x, `cover: the element on ${slot.id} stands ${Math.round(share * 100)}% over ${coveredBoxes(cover).map(b => `u ${r3(b.u0)}-${r3(b.u1)} m, v ${r3(b.v0)}-${r3(b.v1)} m`).join('; ')}, which another part of the structure covers and nothing can stand there. Move it into the free part of the slot`);
            }
        }

        const mine = notes.filter(n => n.elementId === x.element.id);
        if (mine.length) {
            x.element.checks.anchor = { errorM: Math.max(...mine.map(n => n.errorM)), toleranceM, changes: mine.map(n => n.note) };
            x.element.provenance.label = PROVENANCE.photoCorrected;
            const beyond = mine.some(n => n.errorM > toleranceM);
            x.element.provenance.note = `${x.element.provenance.note ? `${x.element.provenance.note}; ` : ''}${beyond ? `photo-corrected to the measured span (the reading was off by more than the ${toleranceM} m tolerance, and the error is labelled)` : 'photo-corrected inside the scan tolerance'}: ${mine.map(n => n.note).join('; ')}`;
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
