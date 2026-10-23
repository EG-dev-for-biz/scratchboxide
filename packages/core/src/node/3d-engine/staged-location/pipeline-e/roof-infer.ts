/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Pipeline E inference (a): the roof read from a top-down render of the photo tile, checked against the scan.
 *
 * The vision model reads, per roof part it sees, continuous numbers: pitch, the ridge's compass direction, whether the ends
 * are hipped, a parapet's height, and boxes of any raised blocks on the roof (dormers, bulkheads). Nothing is a roof type:
 * a pitch of 0 is flat, hips are a yes/no about the ends, the words are the model's own and never read.
 *
 * Each reading becomes geometry only where the scan agrees:
 *   - pitch: planes rising from the part's eave edges (all edges when hipped, the edges along the ridge otherwise) at the
 *     read pitch, from the eave height the scan measures along the walls; kept when the part's roof error against the scan's
 *     top falls by MIN_ROOF_GAIN, and, where Solar measured pitched facets in the part, when the pitch is within
 *     SOLAR_PITCH_TOLERANCE_DEG of their area-weighted median;
 *   - parapet: kept when the scan's top in a band just inside the walls stands at least half the read height above the
 *     roof inside it; built as a sweep (the wall continued up, a coping inward) at the measured height;
 *   - raised blocks: kept when the scan inside the box stands at least MIN_BLOCK_RISE_M above the roof; built as a part at
 *     the measured height.
 *
 * The modelled volume's roof prior (volume-roof-prior.ts), when the massing carries one, is a second source, never the
 * decision: a volume plane whose pitch and fall agree with the reading (within SOLAR_PITCH_TOLERANCE_DEG) corroborates it,
 * and the gain the reading must show against the scan halves (CORROBORATED_ROOF_GAIN); where the reading proposes no pitch
 * the scan keeps, the volume's own planes are a candidate checked exactly like a reading (kept only when they lower the
 * roof's error by MIN_ROOF_GAIN), labelled vector-modelled with the fit's residual.
 */

import { inRing, inLoops, roofAt, roofUnderFloor, type MassingPart, type RoofPlaneSpec } from './massing-spec';
import { azimuthOffRidge, medianPitch, volumePlaneSpec, volumePlanesIn, type VolumeRoofPrior } from './volume-roof-prior';
import type { Vec2 } from '../../../../common/spatial/staged-location-contracts';

export const MIN_ROOF_GAIN = 0.1;
/** The gain a reading must show when the modelled volume's roof corroborates its pitch and fall (two sources agree). */
export const CORROBORATED_ROOF_GAIN = MIN_ROOF_GAIN / 2;
/** A reading's pitch (and a volume plane's) must be at least this to shape a roof. */
export const MIN_READ_PITCH_DEG = 8;
export const SOLAR_PITCH_TOLERANCE_DEG = 10;
export const MIN_BLOCK_RISE_M = 1.0;
export const PARAPET_BAND_M = 0.8;
export const PARAPET_THICKNESS_M = 0.3;

export interface RoofReading { pitchDeg: number; ridgeAzimuthDeg: number; hipped: boolean; parapetM: number; blocks: Array<[number, number, number, number]>; conf: number; notes?: string }

export function roofPrompt(widthM: number, heightM: number): string {
    return [
        `This is a top-down orthophoto of a building's roof (north up), ${widthM.toFixed(1)} m wide and ${heightM.toFixed(1)} m tall, from a photogrammetric scan's photo texture. Flat mid-grey areas are outside the scan.`,
        'Read the roof of the building in the middle as numbers:',
        '- "pitchDeg": the slope of its main roof surfaces in degrees (0 for a flat roof);',
        '- "ridgeAzimuthDeg": the compass direction its ridge runs (0 = north-south, 90 = east-west; 0 if flat);',
        '- "hipped": true when the ends of a pitched roof slope too (no vertical gable ends);',
        '- "parapetM": the height of a low wall running round the roof\'s edge above the roof surface, in metres (0 if none);',
        '- "blocks": boxes of raised blocks standing on the roof (dormers, stair or lift bulkheads, plant rooms), each [x0, y0, x1, y1] in per-mille of the image (x right, y down);',
        '- "conf": 0..100, how sure you are; "notes": one short sentence.',
        'Answer with JSON only: {"pitchDeg":0,"ridgeAzimuthDeg":0,"hipped":false,"parapetM":0,"blocks":[],"conf":0,"notes":"..."}'
    ].join('\n');
}

export function parseRoofReply(text: string): RoofReading {
    const a = text.indexOf('{'), b = text.lastIndexOf('}');
    if (a < 0 || b <= a) throw new Error('the reply holds no JSON object');
    const j = JSON.parse(text.slice(a, b + 1));
    const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d);
    const blocks: Array<[number, number, number, number]> = [];
    for (const bx of Array.isArray(j?.blocks) ? j.blocks : []) {
        const arr = Array.isArray(bx) ? bx : Array.isArray(bx?.box) ? bx.box : undefined;
        if (arr?.length === 4 && arr.every((v: unknown) => typeof v === 'number' && Number.isFinite(v))) blocks.push(arr.map((v: number) => Math.max(0, Math.min(1000, v))) as [number, number, number, number]);
    }
    return { pitchDeg: num(j?.pitchDeg, 0, 75, 0), ridgeAzimuthDeg: num(j?.ridgeAzimuthDeg, -360, 360, 0), hipped: j?.hipped === true, parapetM: num(j?.parapetM, 0, 3, 0), blocks, conf: num(j?.conf, 0, 100, 50), ...(typeof j?.notes === 'string' ? { notes: j.notes.slice(0, 200) } : {}) };
}

/** Planes rising inward from a part's eave edges at `pitchDeg`: all edges when hipped, else the edges along the ridge. */
export function eavePlanes(part: Pick<MassingPart, 'loops'>, pitchDeg: number, ridgeAzimuthDeg: number, hipped: boolean, eaveY: number): RoofPlaneSpec[] {
    const k = Math.tan((pitchDeg * Math.PI) / 180);
    const ridge = [Math.sin((ridgeAzimuthDeg * Math.PI) / 180), -Math.cos((ridgeAzimuthDeg * Math.PI) / 180)];  // in (x, z): north = -z
    const outer = part.loops[0];
    const planes: RoofPlaneSpec[] = [];
    for (let i = 0; i < outer.length; i++) {
        const a = outer[i], b = outer[(i + 1) % outer.length];
        const dx = b[0] - a[0], dz = b[1] - a[1], L = Math.hypot(dx, dz);
        if (L < 1) continue;
        const along = Math.abs((dx * ridge[0] + dz * ridge[1]) / L);
        if (!hipped && along < Math.cos((30 * Math.PI) / 180)) continue;
        // inward normal
        let n = [-dz / L, dx / L];
        const m = [(a[0] + b[0]) / 2 + n[0] * 0.05, (a[1] + b[1]) / 2 + n[1] * 0.05];
        if (!inRing(m[0], m[1], outer)) n = [-n[0], -n[1]];
        // y = eave + k * ((p - a) . n)
        const bb = k * n[0], cc = k * n[1];
        planes.push({ a: eaveY - bb * a[0] - cc * a[1], b: bb, c: cc, tag: `eave:${pitchDeg.toFixed(1)}deg` });
    }
    return planes;
}

/** Samples (1 m) inside the part, and those within `band` of its outer loop's edges. */
function partSamples(part: Pick<MassingPart, 'loops'>, band: number): { inner: Vec2[]; rim: Vec2[] } {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const [x, z] of part.loops[0]) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
    const inner: Vec2[] = [], rim: Vec2[] = [];
    const step = 0.5;
    for (let z = z0 + step / 2; z < z1; z += step) for (let x = x0 + step / 2; x < x1; x += step) {
        if (!inLoops(x, z, part.loops)) continue;
        let d = Infinity;
        for (const l of part.loops) for (let i = 0; i < l.length; i++) {
            const a = l[i], b = l[(i + 1) % l.length], ex = b[0] - a[0], ez = b[1] - a[1], L2 = ex * ex + ez * ez || 1e-9;
            const t = Math.max(0, Math.min(1, ((x - a[0]) * ex + (z - a[1]) * ez) / L2));
            d = Math.min(d, Math.hypot(x - a[0] - t * ex, z - a[1] - t * ez));
        }
        if (d <= band) rim.push([x, z]); else if (d >= band + 1) inner.push([x, z]);
    }
    return { inner, rim };
}

const median = (v: number[]) => { if (!v.length) return NaN; const s = [...v].sort((a, b) => a - b); return s[s.length >> 1]; };

export interface RoofDecision {
    part: string;
    pitch: {
        proposed: boolean; accepted: boolean; why: string; planes?: RoofPlaneSpec[]; topY?: number;
        /** Which source the kept planes come from: the reading ('photo-inferred') or the modelled volume ('vector-modelled'). */
        source?: 'photo-inferred' | 'vector-modelled' | (string & {});
        /** The roof's median error against the scan with the kept planes, metres. */
        residualM?: number;
        /** Set when the modelled volume's planes agree with the reading's pitch and fall (a second source). */
        corroborated?: { pitchDeg: number; azimuthOffRidgeDeg: number; planes: number };
    };
    parapet: { proposed: boolean; accepted: boolean; why: string; heightM?: number };
    blocks: Array<{ accepted: boolean; why: string; loop?: Vec2[]; baseY?: number; topY?: number }>;
}

/**
 * Checks one reading against one part. `top(x, z)` is the scan's top surface (the top-down render's height map); `solarPitches`
 * the pitched Solar facets inside the part (pitch, area); `toPlan` maps a per-mille image point to the tile frame (x, z).
 */
export function decideRoof(part: MassingPart, reading: RoofReading, top: (x: number, z: number) => number, solarPitches: Array<{ pitchDeg: number; areaM2: number }>, toPlan: (px: number, py: number) => Vec2, prior?: Pick<VolumeRoofPrior, 'planes'>): RoofDecision {
    const out: RoofDecision = { part: part.id, pitch: { proposed: false, accepted: false, why: '' }, parapet: { proposed: false, accepted: false, why: '' }, blocks: [] };
    const { inner, rim } = partSamples(part, PARAPET_BAND_M);
    const innerTop = inner.map(([x, z]) => top(x, z)).filter(Number.isFinite);
    const err = (p: Pick<MassingPart, 'topY' | 'baseY' | 'planes'>) => median(inner.concat(rim).map(([x, z]) => { const y = top(x, z); return Number.isFinite(y) ? Math.abs(roofAt(p, x, z) - y) : NaN; }).filter(Number.isFinite));
    const eave = median(rim.map(([x, z]) => top(x, z)).filter(Number.isFinite));
    const ridgeY = innerTop.length ? [...innerTop].sort((a, b) => a - b)[Math.floor(0.97 * (innerTop.length - 1))] : NaN;
    const scanHasRoof = Number.isFinite(eave) && Number.isFinite(ridgeY);
    // the modelled volume's pitched planes over this part, and whether they agree with the reading's pitch and fall
    const volPlanes = volumePlanesIn(prior, part.loops, MIN_READ_PITCH_DEG);
    const volMed = medianPitch(volPlanes);
    const volOff = volPlanes.length ? Math.max(...volPlanes.map(p => azimuthOffRidge(p.azimuthDeg, reading.ridgeAzimuthDeg))) : NaN;
    const volAgrees = reading.pitchDeg >= MIN_READ_PITCH_DEG && Number.isFinite(volMed) && Math.abs(volMed - reading.pitchDeg) <= SOLAR_PITCH_TOLERANCE_DEG && volOff <= SOLAR_PITCH_TOLERANCE_DEG;
    // pitch
    if (reading.pitchDeg >= MIN_READ_PITCH_DEG) {
        out.pitch.proposed = true;
        if (!scanHasRoof) out.pitch.why = 'the scan has no roof here to check against';
        else {
            const planes = eavePlanes(part, reading.pitchDeg, reading.ridgeAzimuthDeg, reading.hipped, eave);
            const trial = { ...part, planes, topY: Math.max(ridgeY, eave + 0.5) };
            const before = err(part), after = err(trial);
            const solarMed = medianPitch(solarPitches);
            const solarOk = !Number.isFinite(solarMed) || Math.abs(solarMed - reading.pitchDeg) <= SOLAR_PITCH_TOLERANCE_DEG;
            // two sources agreeing (the reading and the modelled volume) need show half the gain against the scan
            const minGain = volAgrees ? CORROBORATED_ROOF_GAIN : MIN_ROOF_GAIN;
            const gainOk = after <= before * (1 - minGain);
            out.pitch.accepted = planes.length > 0 && solarOk && gainOk;
            out.pitch.why = `roof error against the scan ${before.toFixed(2)} -> ${after.toFixed(2)} m${Number.isFinite(solarMed) ? `; Solar pitch ${solarMed.toFixed(1)} deg against ${reading.pitchDeg.toFixed(1)}` : ''}${volPlanes.length ? `; the modelled volume's roof pitch ${volMed.toFixed(1)} deg, fall ${volOff.toFixed(0)} deg off the ridge's normal (${volAgrees ? 'agrees' : 'disagrees'})` : ''}${!planes.length ? '; no eave edge along the ridge' : ''}`;
            if (out.pitch.accepted) {
                out.pitch.planes = planes; out.pitch.topY = trial.topY; out.pitch.source = 'photo-inferred'; out.pitch.residualM = after;
                if (volAgrees) out.pitch.corroborated = { pitchDeg: volMed, azimuthOffRidgeDeg: volOff, planes: volPlanes.length };
            }
        }
    }
    // the modelled volume's own planes as a candidate where the reading left the roof flat: checked like a reading
    if (!out.pitch.accepted && volPlanes.length && scanHasRoof) {
        const pts = inner.concat(rim);
        const planes = volPlanes.map(volumePlaneSpec).filter(pl => !roofUnderFloor(pl, pts, part.baseY));
        const trial = { ...part, planes, topY: Math.max(ridgeY, eave + 0.5) };
        const before = err(part), after = err(trial);
        const accepted = planes.length > 0 && after <= before * (1 - MIN_ROOF_GAIN);
        const why = `the modelled volume's ${planes.length} pitched plane${planes.length === 1 ? '' : 's'} (median pitch ${volMed.toFixed(1)} deg) as a candidate: roof error against the scan ${before.toFixed(2)} -> ${after.toFixed(2)} m${volPlanes.length > planes.length ? `; ${volPlanes.length - planes.length} under the part's floor, left out` : ''}`;
        out.pitch.why = out.pitch.why ? `${out.pitch.why}; ${why}` : why;
        out.pitch.proposed = true;
        if (accepted) { out.pitch.accepted = true; out.pitch.planes = planes; out.pitch.topY = trial.topY; out.pitch.source = 'vector-modelled'; out.pitch.residualM = after; }
    }
    // parapet
    if (reading.parapetM >= 0.3) {
        out.parapet.proposed = true;
        const rimTop = median(rim.map(([x, z]) => top(x, z)).filter(Number.isFinite)), inTop = median(innerTop);
        const rise = rimTop - inTop;
        out.parapet.accepted = Number.isFinite(rise) && rise >= 0.5 * reading.parapetM && rise <= 2 * reading.parapetM && rise >= 0.25 && rise <= 3;
        out.parapet.why = Number.isFinite(rise) ? `the scan's rim stands ${rise.toFixed(2)} m above the roof inside it (read ${reading.parapetM.toFixed(2)} m)` : 'the scan has no roof here to check against';
        if (out.parapet.accepted) out.parapet.heightM = Math.min(rise, 1.5 * reading.parapetM);
    }
    // raised blocks
    for (const bx of reading.blocks) {
        const corners = [toPlan(bx[0], bx[1]), toPlan(bx[2], bx[1]), toPlan(bx[2], bx[3]), toPlan(bx[0], bx[3])];
        const xs = corners.map(c => c[0]), zs = corners.map(c => c[1]);
        const xa = Math.min(...xs), xb = Math.max(...xs), za = Math.min(...zs), zb = Math.max(...zs);
        if (xb - xa < 0.8 || zb - za < 0.8) { out.blocks.push({ accepted: false, why: 'smaller than 0.8 m' }); continue; }
        const cx = (xa + xb) / 2, cz = (za + zb) / 2;
        if (!inLoops(cx, cz, part.loops)) continue;  // another part's
        const hs: number[] = [];
        for (let z = za + 0.25; z < zb; z += 0.5) for (let x = xa + 0.25; x < xb; x += 0.5) { const y = top(x, z); if (Number.isFinite(y)) hs.push(y); }
        const roof = roofAt(part, cx, cz);
        const h = median(hs);
        const ok = Number.isFinite(h) && h - roof >= MIN_BLOCK_RISE_M;
        out.blocks.push({ accepted: ok, why: Number.isFinite(h) ? `the scan inside it stands ${(h - roof).toFixed(2)} m above the roof` : 'no scan inside it', ...(ok ? { loop: [[xa, za], [xb, za], [xb, zb], [xa, zb]] as Vec2[], baseY: roof - 0.3, topY: h } : {}) });
    }
    return out;
}
