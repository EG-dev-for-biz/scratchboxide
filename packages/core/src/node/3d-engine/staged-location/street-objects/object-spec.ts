/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Street objects, step 5 (the spec): one family's measures as an ObjectBuildSpec (common/spatial/object-build-spec.ts) the
 * native interpreter builds, with every number labelled by where it came from.
 *
 * - Height, plan, plan heading and where each member stands: the scan (measured).
 * - The profile along the height and any part standing off the axis (a panel, an arm): the Street View silhouettes,
 *   scaled to the scan's height (photo-inferred, silhouette-profile.ts).
 * - Surface factors per height band (colour, roughness, metalness) and the plan section's squareness: the vision read of
 *   the same views, as numbers (photo-inferred); the words it gave are kept as labels and select nothing.
 * - Heights no view resolved: continued from the nearest read height (generated, with that reason).
 *
 * The operator follows the numbers: a plan section the read calls round (superellipse exponent near 2) and the views
 * agree is wide the same from every side is a solid of revolution through the measured meridian (operator 2); anything
 * else is a section swept up a vertical carrier (operator 1) at the scan's plan aspect and the photo's taper. A colour
 * band is a part stacked on the one below it; an off-axis run of the silhouette is a thin panel through the axis, facing
 * the view that saw it widest. The object's frame is the tile frame's axes (x east, y up, z south) with its origin at the
 * foot, so its members are placed by translation alone.
 */

import type { ObjectBuildSpec, ObjectPartSpec, PartMaterial, Vec3 } from '../../../../common/spatial/object-build-spec';
import { OBJECT_SPEC_LIMITS } from '../../../../common/spatial/object-build-spec';
import type { StreetObjectFamily } from './families';
import { filledHalfWidths, meridianOf, type CombinedProfile } from './silhouette-profile';

export type ProvenanceLabel = 'measured' | 'vector-modelled' | 'photo-inferred' | 'generated';

/** What the vision model read of the object from its views: numbers that build, words that only label. */
export interface ObjectLook {
    /** The object in the model's own words (a label; nothing reads it). */
    description: string;
    /** The plan section's squareness as the photos show it: 2 round, 4 a rounded square, 8 or more square-cornered. */
    sectionExponent?: number;
    /** Depth over width of the plan section (1 round or square). */
    sectionAspect?: number;
    /** Surface bands from the foot (t 0) to the top (t 1), each with physical factors (sRGB 0..255 colour as the photo shows it). */
    bands?: Array<{ fromT: number; toT: number; label?: string; srgb: [number, number, number]; roughness: number; metalness: number }>;
    /** Panels' thickness, when the read gives one. */
    panelThicknessM?: number;
    /** Markings, text and symbols seen, in words (labels only; no lettering is generated). */
    markings?: string[];
    confidence?: number;
}

export interface NumberProvenance { field: string; label: ProvenanceLabel; source: string; confidence?: number; reason?: string }

export interface StreetObjectSpec {
    spec: ObjectBuildSpec;
    operator: 'revolve' | 'sweep';
    /** Why that operator, from the numbers. */
    operatorReason: string;
    provenance: NumberProvenance[];
    /** Members' placements in the tile frame: the foot each copy stands on (translation only, see the header). */
    placements: Array<{ clusterId: number; foot: [number, number, number] }>;
}

export const OBJECT_SPEC_PARAMS = {
    /** A section exponent within this of 2 is round. */
    roundExponentTol: 0.6,
    /** Views from two sides or more that disagree on the width by more than this share are not round. */
    maxRoundSpread: 0.25,
    /** A plan aspect under this is not round. */
    minRoundAspect: 0.6,
    /** A run of heights whose middle stands off the axis by more than this share of the body's half-width (and at least offPanelMinM) is a panel. */
    offPanelShare: 0.6,
    offPanelMinM: 0.05,
    /** At least this many height samples make a panel. */
    panelMinBins: 2,
    /** A panel the read gives no thickness for (generated). */
    panelThicknessM: 0.03,
    /** Two bands whose colours differ by less than this (CIE76 in Lab) are one. */
    bandMergeDeltaE: 10,
    defaultExponent: 4,
    defaultRoughness: 0.6
};

const r3 = (v: number) => Math.round(v * 1000) / 1000;
const median = (a: number[]) => { const s = a.filter(Number.isFinite).sort((x, y) => x - y); return s.length ? (s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN; };

/** sRGB 0..255 to linear 0..1. */
export const srgbToLinear = (v: number) => { const c = Math.max(0, Math.min(255, v)) / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };

/** CIE L*a*b* of an sRGB 0..255 colour (D65). */
export function srgbToLab(rgb: [number, number, number]): [number, number, number] {
    const [r, g, b] = rgb.map(srgbToLinear);
    const x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047, y = 0.2126 * r + 0.7152 * g + 0.0722 * b, z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
    const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
    return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}
export const deltaE76 = (a: [number, number, number], b: [number, number, number]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

function materialOf(band: NonNullable<ObjectLook['bands']>[number] | undefined, P = OBJECT_SPEC_PARAMS): PartMaterial {
    if (!band) return { baseColor: [0.18, 0.18, 0.18], roughness: P.defaultRoughness, metalness: 0, transmission: 0, description: 'no colour read (generated mid grey)' };
    return {
        baseColor: band.srgb.map(v => r3(srgbToLinear(v))) as Vec3, roughness: r3(Math.max(0, Math.min(1, band.roughness))), metalness: r3(Math.max(0, Math.min(1, band.metalness))), transmission: 0,
        ...(band.label ? { description: band.label } : {})
    };
}

/** Bands sorted, clipped to 0..1, neighbours of nearly one colour merged. */
export function cleanBands(bands: NonNullable<ObjectLook['bands']>, P = OBJECT_SPEC_PARAMS): NonNullable<ObjectLook['bands']> {
    const s = bands.filter(b => b.toT > b.fromT).map(b => ({ ...b, fromT: Math.max(0, b.fromT), toT: Math.min(1, b.toT) })).filter(b => b.toT - b.fromT > 0.01).sort((a, b) => a.fromT - b.fromT);
    const out: typeof s = [];
    for (const b of s) {
        const last = out[out.length - 1];
        if (last && deltaE76(srgbToLab(last.srgb), srgbToLab(b.srgb)) < P.bandMergeDeltaE && Math.abs(last.metalness - b.metalness) < 0.5) last.toT = b.toT;
        else out.push({ ...b });
    }
    if (out.length) { out[0].fromT = 0; out[out.length - 1].toT = 1; for (let i = 1; i < out.length; i++) out[i].fromT = out[i - 1].toT; }
    return out;
}

/** The members' common plan heading (0..180, clockwise from north): the mean of the doubled angles, so 179 and 1 agree. */
export function planHeadingOf(headingsDeg: number[]): number {
    if (!headingsDeg.length) return 0;
    const c = headingsDeg.reduce((s, h) => s + Math.cos((2 * h * Math.PI) / 180), 0), s2 = headingsDeg.reduce((s, h) => s + Math.sin((2 * h * Math.PI) / 180), 0);
    return Math.round(((((Math.atan2(s2, c) * 180) / Math.PI / 2) % 180) + 180) % 180 * 100) / 100;
}

/** Runs of heights whose silhouette middle stands well off the axis: the panels (each with its heights, its offset and its half-width). */
export function offAxisRuns(profile: CombinedProfile, bodyHalfM: number, P = OBJECT_SPEC_PARAMS): Array<{ fromT: number; toT: number; offsetM: number; halfWidthM: number }> {
    const lim = Math.max(P.offPanelMinM, P.offPanelShare * bodyHalfM);
    const runs: Array<{ k0: number; k1: number }> = [];
    profile.samples.forEach((s, k) => {
        const off = Number.isFinite(s.offsetM) && Math.abs(s.offsetM) > lim;
        const last = runs[runs.length - 1];
        if (off) { if (last && last.k1 === k - 1) last.k1 = k; else runs.push({ k0: k, k1: k }); }
    });
    const N = profile.samples.length;
    return runs.filter(r => r.k1 - r.k0 + 1 >= P.panelMinBins).map(r => {
        const ss = profile.samples.slice(r.k0, r.k1 + 1);
        return { fromT: r.k0 / N, toT: (r.k1 + 1) / N, offsetM: r3(median(ss.map(s => s.offsetM))), halfWidthM: r3(median(ss.map(s => s.halfWidthM))) };
    });
}

/**
 * The family's spec. `profile` is the combined silhouette profile of its members' views (scan-scaled); `look` the vision
 * read; `panelRightDir` the plan direction (x, z) the lead view's right points along (a panel lies along it).
 */
export function streetObjectSpec(input: {
    family: StreetObjectFamily; profile: CombinedProfile; look?: ObjectLook; panelRightDir?: [number, number]; radialSymmetry?: number; params?: Partial<typeof OBJECT_SPEC_PARAMS>;
}): StreetObjectSpec {
    const P = { ...OBJECT_SPEC_PARAMS, ...(input.params ?? {}) };
    const fam = input.family, look = input.look, prof = input.profile;
    const H = fam.heightM;
    const prov: NumberProvenance[] = [
        { field: 'height', label: 'measured', source: `scan: median of ${fam.members.length} member${fam.members.length === 1 ? '' : 's'}' tops above their support` },
        { field: 'placement', label: 'measured', source: 'scan: each member\'s foot (its plan centre on its support)' },
        { field: 'plan', label: 'measured', source: 'scan: the cluster frame\'s plan extents and heading' }
    ];
    const read = prof.samples.filter(s => s.views > 0).length;
    const half = filledHalfWidths(prof.samples);
    if (read < prof.samples.length) prov.push({ field: 'profile (unread heights)', label: 'generated', source: 'continued from the nearest height a view read', reason: `${prof.samples.length - read} of ${prof.samples.length} heights hidden or unresolved in every view` });
    prov.push({ field: 'profile', label: 'photo-inferred', source: `Street View silhouettes, ${prof.views} view${prof.views === 1 ? '' : 's'} from ${prof.distinctSides} side${prof.distinctSides === 1 ? '' : 's'}, scaled to the scan's height`, confidence: r3(Math.min(1, read / prof.samples.length)) });
    // panels first: their heights are not the body's width
    const bodyHalf = median(half.slice(0, Math.max(1, Math.floor(half.length * 0.25))));
    const panels = offAxisRuns(prof, bodyHalf, P);
    const bodyHalfAt = half.map((h, k) => {
        const t = (k + 0.5) / half.length;
        return panels.some(p => t >= p.fromT && t < p.toT) ? NaN : h;
    });
    const body = filledHalfWidths(bodyHalfAt.map(h => ({ halfWidthM: h })));
    // the operator, from the numbers
    const e = look?.sectionExponent ?? (input.radialSymmetry !== undefined && input.radialSymmetry >= 0.5 ? 2 : P.defaultExponent);
    const [L, W] = fam.planM;
    const aspect = look?.sectionAspect ?? (Math.max(L, W) > 0 ? Math.min(L, W) / Math.max(L, W) : 1);
    const spreadOk = prof.distinctSides < 2 || prof.viewSpread <= P.maxRoundSpread;
    const round = Math.abs(e - 2) <= P.roundExponentTol && spreadOk && aspect >= P.minRoundAspect;
    const operatorReason = round
        ? `round: section exponent ${r3(e)} (${look?.sectionExponent !== undefined ? 'read' : 'from the scan\'s radial symmetry'}), aspect ${r3(aspect)}, ${prof.distinctSides >= 2 ? `widths across ${prof.distinctSides} sides within ${Math.round(prof.viewSpread * 100)}%` : 'seen from one side'}`
        : `not round: section exponent ${r3(e)}, aspect ${r3(aspect)}${!spreadOk ? `, widths across ${prof.distinctSides} sides differ by ${Math.round(prof.viewSpread * 100)}%` : ''}`;
    prov.push({ field: 'section', label: look?.sectionExponent !== undefined ? 'photo-inferred' : 'measured', source: operatorReason });
    const heading = planHeadingOf(fam.members.map(m => m.planHeadingDeg));
    const twist = r3(90 - heading);
    const bands = look?.bands?.length ? cleanBands(look.bands, P) : [];
    if (bands.length) prov.push({ field: 'materials', label: 'photo-inferred', source: `vision read of the views: ${bands.length} band${bands.length === 1 ? '' : 's'}`, ...(look?.confidence !== undefined ? { confidence: look.confidence } : {}) });
    else prov.push({ field: 'materials', label: 'generated', source: 'mid grey, roughness 0.6', reason: 'no colour was read from any view' });
    const spans = bands.length ? bands : [{ fromT: 0, toT: 1, srgb: [0, 0, 0] as [number, number, number], roughness: P.defaultRoughness, metalness: 0 }];
    const parts: ObjectPartSpec[] = [];
    const N = body.length;
    spans.forEach((b, i) => {
        const z0 = b.fromT * H, z1 = b.toT * H;
        const k0 = Math.max(0, Math.floor(b.fromT * N)), k1 = Math.min(N, Math.max(k0 + 1, Math.ceil(b.toT * N)));
        const seg = body.slice(k0, k1);
        const id = `band${i}`, material = materialOf(bands.length ? b : undefined, P);
        const link = i ? { parentId: `band${i - 1}`, attach: { u: 1, angleDeg: 0, normalOffsetMeters: 0 } } : {};
        if (round) {
            const meridian = meridianOf(seg, z1 - z0, { maxPoints: Math.min(OBJECT_SPEC_LIMITS.maxPoints, 40) });
            parts.push({ id, label: b.label ?? `band ${i}`, material, ...link, revolve: { axisOrigin: i ? [0, 0, 0] : [0, z0, 0], axisDirection: [0, 1, 0], meridian, smoothing: 0, lobeCount: 0, lobeDepthRatio: 0, helixPitchMeters: 0 } });
        } else {
            // the photo's taper times the scan's plan section: widths across the plan axis (x) and along it (z)
            const ref = median(body);
            const keysN = Math.min(OBJECT_SPEC_LIMITS.maxProfileKeys, Math.max(2, seg.length));
            const sx = Math.max(L, W), sz = Math.max(0.02, Math.max(L, W) * aspect);
            const profile = Array.from({ length: keysN }, (_, j) => {
                const t = keysN === 1 ? 0 : j / (keysN - 1);
                const h = seg[Math.min(seg.length - 1, Math.round(t * (seg.length - 1)))];
                const s = ref > 0 ? h / ref : 1;
                return { t: r3(t), widthMeters: r3(Math.max(0.01, sx * s)), heightMeters: r3(Math.max(0.01, sz * s)), exponent: r3(Math.max(0.5, Math.min(12, e))) };
            });
            // a vertical carrier's section has its width along x and its height along z; the twist turns the width onto the plan heading
            parts.push({ id, label: b.label ?? `band ${i}`, material, ...link, sweep: { controlPoints: i ? [[0, 0, 0], [0, z1 - z0, 0]] : [[0, z0, 0], [0, z1, 0]], closedLoop: false, smoothing: 0, profile, twistDegAlong: [[0, twist], [1, twist]] } });
        }
    });
    if (!round) prov.push({ field: 'plan section size', label: 'photo-inferred', source: 'the scan\'s plan aspect and heading, scaled along the height by the silhouette\'s taper' });
    // panels: thin sweeps through the axis along the lead view's right, at their heights (root parts crossing the body)
    const dir = input.panelRightDir ?? [1, 0];
    const thick = look?.panelThicknessM ?? P.panelThicknessM;
    panels.forEach((p, i) => {
        const z0 = p.fromT * H, z1 = p.toT * H;
        const a = Math.min(0, p.offsetM - p.halfWidthM), b = Math.max(0, p.offsetM + p.halfWidthM);
        const band = bands.find(x => (p.fromT + p.toT) / 2 >= x.fromT && (p.fromT + p.toT) / 2 < x.toT);
        parts.push({
            id: `panel${i}`, label: `off-axis run ${i}`, material: materialOf(band, P),
            sweep: {
                controlPoints: [[r3(dir[0] * a), r3((z0 + z1) / 2), r3(dir[1] * a)], [r3(dir[0] * b), r3((z0 + z1) / 2), r3(dir[1] * b)]], closedLoop: false, smoothing: 0,
                profile: [{ t: 0, widthMeters: r3(thick), heightMeters: r3(Math.max(0.02, z1 - z0)), exponent: 8 }, { t: 1, widthMeters: r3(thick), heightMeters: r3(Math.max(0.02, z1 - z0)), exponent: 8 }]
            }
        });
    });
    if (panels.length) {
        prov.push({ field: 'panels', label: 'photo-inferred', source: `${panels.length} run${panels.length === 1 ? '' : 's'} of the silhouette standing off the axis, lying along the lead view's right` });
        if (look?.panelThicknessM === undefined) prov.push({ field: 'panel thickness', label: 'generated', source: `${P.panelThicknessM} m`, reason: 'no view resolves a panel\'s thickness' });
    }
    const maxHalf = Math.max(...body.filter(Number.isFinite), ...panels.map(p => Math.abs(p.offsetM) + p.halfWidthM), 0.02);
    const bx = round ? 2 * maxHalf : Math.max(L, W), bz = round ? 2 * maxHalf : Math.max(0.02, Math.max(L, W) * aspect);
    const spec: ObjectBuildSpec = {
        subject: look?.description ?? `street object ${fam.id}`,
        boundingMeters: [r3(Math.max(bx, 0.02)), r3(H), r3(Math.max(bz, 0.02))],
        expectedBodies: 1,
        observations: [fam.reason, operatorReason, ...(look?.markings?.length ? [`markings seen (not drawn): ${look.markings.join('; ')}`] : [])],
        parts
    };
    return { spec, operator: round ? 'revolve' : 'sweep', operatorReason, provenance: prov, placements: fam.members.map(m => ({ clusterId: m.clusterId, foot: m.foot })) };
}
