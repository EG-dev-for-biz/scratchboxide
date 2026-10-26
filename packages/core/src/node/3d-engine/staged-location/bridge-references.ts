/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The detail of a rebuilt bridge that its scan cannot resolve (what stands on the parapet, how the parapet is made, the
 * shape of the supports' noses and caps, the band round each arch), read from search-grounded reference images
 * (search-grounded-reference.ts) as continuous numbers scaled by what the scan measured. A reference is generated, never a
 * measurement: a detail is taken only where at least two independent references agree (each number within a tolerance,
 * each profile within a shape tolerance) and the scan does not contradict it (the caller's check); everything else is left
 * out with its reason. Nothing here branches on what an element is called: the reading's words are only kept as labels.
 */

import type { Vec3 } from '../../../common/spatial/staged-location-contracts';

export const BRIDGE_DETAIL_VERSION = 'bridge-detail/1';

/** One reference's reading (metres; colours sRGB 0..255). Every member optional: the reader leaves out what it cannot see. */
export interface BridgeDetailReading {
    posts?: {
        present: boolean;
        /** Standing over each support (true) or at a spacing along the parapet. */
        overSupports?: boolean;
        spacingM?: number;
        /** Above the parapet's top. */
        heightM?: number;
        /** The shaft's meridian, radius over height from its base, base to top. */
        meridian?: Array<[number, number]>;
        heads?: { count: number; armRadiusM: number; atHeightM: number; radiusM: number; lengthM: number };
        colourSrgb?: Vec3;
    };
    rail?: {
        /** 0 a solid wall, 1 wholly open between plinth and coping. */
        openFraction?: number;
        plinthM?: number; copingM?: number; copingProjectionM?: number;
        balusterPitchM?: number;
        /** Radius over height from the plinth, normalised or in metres (rescaled to the open height). */
        balusterMeridian?: Array<[number, number]>;
        colourSrgb?: Vec3;
    };
    supports?: { noseLengthM?: number; pointedness?: number; capHeightM?: number; capProjectionM?: number; pilasterProjectionM?: number; colourSrgb?: Vec3 };
    arches?: { ringWidthM?: number; ringProjectionM?: number };
    structureColourSrgb?: Vec3;
    name?: string;
}

/** What the references agree on, each item with the readings it rests on. */
export interface AgreedBridgeDetail {
    posts?: { overSupports: boolean; spacingM?: number; heightM: number; meridian: Array<[number, number]>; heads?: NonNullable<NonNullable<BridgeDetailReading['posts']>['heads']>; colourSrgb?: Vec3; agreement: number };
    rail?: { openFraction: number; plinthM: number; copingM: number; copingProjectionM: number; balusterPitchM?: number; balusterMeridian?: Array<[number, number]>; colourSrgb?: Vec3; agreement: number };
    supports?: { noseLengthM: number; pointedness: number; capHeightM?: number; capProjectionM?: number; pilasterProjectionM?: number; colourSrgb?: Vec3; agreement: number };
    arches?: { ringWidthM: number; ringProjectionM: number; agreement: number };
    structureColourSrgb?: Vec3;
    /** Items the references did not agree on (or that only one showed), with why. */
    rejected: Array<{ item: string; reason: string }>;
    readings: number;
    names: string[];
}

export function bridgeReferenceSubject(m: { lengthM: number; widthM: number; openings: number; lat: number; lng: number }): string {
    return `the bridge over the river at latitude ${m.lat.toFixed(5)}, longitude ${m.lng.toFixed(5)} (about ${Math.round(m.lengthM)} m long and ${Math.round(m.widthM)} m wide`
        + `${m.openings ? `, with ${m.openings} openings under its deck` : ''})`;
}

export function bridgeDetailPrompt(m: { widthM: number; parapetM: number; deckAboveWaterM: number; openings: number }): string {
    return [
        'This image is a reference of a real bridge (drawn by an image model from photographs found with Google Search; it is not to scale).',
        `Measured facts to scale it by: the deck is ${m.widthM.toFixed(1)} m wide, the road is ${m.deckAboveWaterM.toFixed(1)} m above the water, the parapet stands ${m.parapetM.toFixed(2)} m above the road; it has ${m.openings} openings.`,
        'Read only what the image clearly shows, in metres scaled by those facts; leave out (null) anything it does not show. Reply with JSON only:',
        '{"name": "the bridge\'s name if you know it",',
        ' "posts": {"present": bool (posts, lamp standards or columns standing on or along the parapet), "overSupports": bool (one over each support between openings), "spacingM": n|null,',
        '   "heightM": n (above the parapet top), "meridian": [[radiusM, heightM], ...] 6-14 points of the post\'s outline from its base to its top (the shaft, plinth and capital; not the lamps),',
        '   "heads": {"count": n, "armRadiusM": n (horizontal distance of each lamp from the post axis), "atHeightM": n (above the post base), "radiusM": n, "lengthM": n} | null, "colourSrgb": [r,g,b]},',
        ' "rail": {"openFraction": 0..1 (0 solid wall, 1 open railing), "plinthM": n, "copingM": n, "copingProjectionM": n, "balusterPitchM": n|null, "balusterMeridian": [[radiusM, heightM], ...]|null, "colourSrgb": [r,g,b]},',
        ' "supports": {"noseLengthM": n (how far each support projects past the bridge face), "pointedness": 0..1 (0 square, 1 pointed), "capHeightM": n|null, "capProjectionM": n|null, "pilasterProjectionM": n|null (a projection on the face above the support up to the parapet), "colourSrgb": [r,g,b]},',
        ' "arches": {"ringWidthM": n (the band round each arch on the face), "ringProjectionM": n} | null,',
        ' "structureColourSrgb": [r,g,b]}'
    ].join('\n');
}

const num = (v: unknown, lo = -Infinity, hi = Infinity): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : undefined);
const rgb = (v: unknown): Vec3 | undefined => (Array.isArray(v) && v.length === 3 && v.every(x => typeof x === 'number' && Number.isFinite(x)) ? (v.map(x => Math.max(0, Math.min(255, x))) as Vec3) : undefined);
const meridian = (v: unknown): Array<[number, number]> | undefined => {
    if (!Array.isArray(v)) return undefined;
    const pts = v.filter((p): p is [number, number] => Array.isArray(p) && p.length >= 2 && num(p[0], 0) !== undefined && num(p[1], 0) !== undefined).map(p => [p[0], p[1]] as [number, number]);
    pts.sort((a, b) => a[1] - b[1]);
    return pts.length >= 3 && pts[pts.length - 1][1] > pts[0][1] ? pts : undefined;
};
const strip = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

export function parseBridgeDetail(text: string): BridgeDetailReading | undefined {
    let j: any;
    try { j = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, '')); } catch { return undefined; }
    if (!j || typeof j !== 'object') return undefined;
    const p = j.posts, r = j.rail, s = j.supports, a = j.arches;
    const heads = p?.heads && num(p.heads.count, 1, 12) !== undefined ? strip({ count: Math.round(p.heads.count), armRadiusM: num(p.heads.armRadiusM, 0, 3) ?? 0, atHeightM: num(p.heads.atHeightM, 0, 30) ?? 0, radiusM: num(p.heads.radiusM, 0.02, 1.5) ?? 0.15, lengthM: num(p.heads.lengthM, 0.05, 3) ?? 0.4 }) : undefined;
    return strip({
        name: typeof j.name === 'string' ? j.name.slice(0, 80) : undefined,
        posts: p && typeof p.present === 'boolean' ? strip({ present: p.present, overSupports: typeof p.overSupports === 'boolean' ? p.overSupports : undefined, spacingM: num(p.spacingM, 0.5, 200), heightM: num(p.heightM, 0.3, 30), meridian: meridian(p.meridian), heads, colourSrgb: rgb(p.colourSrgb) }) : undefined,
        rail: r ? strip({ openFraction: num(r.openFraction, 0, 1), plinthM: num(r.plinthM, 0, 3), copingM: num(r.copingM, 0, 1.5), copingProjectionM: num(r.copingProjectionM, 0, 0.6), balusterPitchM: num(r.balusterPitchM, 0.05, 5), balusterMeridian: meridian(r.balusterMeridian), colourSrgb: rgb(r.colourSrgb) }) : undefined,
        supports: s ? strip({ noseLengthM: num(s.noseLengthM, 0, 15), pointedness: num(s.pointedness, 0, 1), capHeightM: num(s.capHeightM, 0, 5), capProjectionM: num(s.capProjectionM, 0, 2), pilasterProjectionM: num(s.pilasterProjectionM, 0, 3), colourSrgb: rgb(s.colourSrgb) }) : undefined,
        arches: a ? strip({ ringWidthM: num(a.ringWidthM, 0, 5), ringProjectionM: num(a.ringProjectionM, 0, 1.5) }) : undefined,
        structureColourSrgb: rgb(j.structureColourSrgb)
    });
}

/** Two numbers agree within `rel` of their mean or `absM`, whichever is looser. */
export function numbersAgree(a: number, b: number, rel = 0.35, absM = 0.15): boolean {
    return Math.abs(a - b) <= Math.max(absM, rel * (Math.abs(a) + Math.abs(b)) / 2);
}

/** A meridian resampled at n heights over [0, 1] of its own height, radii as a share of its largest radius. */
export function normaliseMeridian(m: Array<[number, number]>, n = 12): number[] {
    const z0 = m[0][1], z1 = m[m.length - 1][1], rmax = Math.max(1e-6, ...m.map(p => p[0]));
    const out: number[] = [];
    for (let i = 0; i < n; i++) {
        const z = z0 + ((z1 - z0) * i) / (n - 1);
        let k = 1; while (k < m.length - 1 && m[k][1] < z) k++;
        const [ra, za] = m[k - 1], [rb, zb] = m[k];
        const f = zb > za ? Math.min(1, Math.max(0, (z - za) / (zb - za))) : 0;
        out.push((ra + (rb - ra) * f) / rmax);
    }
    return out;
}

/** Mean absolute difference of two normalised meridians (0 identical, 1 nothing alike). */
export function meridianDistance(a: Array<[number, number]>, b: Array<[number, number]>): number {
    const p = normaliseMeridian(a), q = normaliseMeridian(b);
    return p.reduce((s, v, i) => s + Math.abs(v - q[i]), 0) / p.length;
}

/** The mean meridian of agreeing ones, at `heightM`, radii scaled by their mean largest radius. */
function meanMeridian(ms: Array<Array<[number, number]>>, heightM: number, n = 12): Array<[number, number]> {
    const norm = ms.map(m => normaliseMeridian(m, n));
    const rmax = ms.reduce((s, m) => s + Math.max(...m.map(p => p[0])), 0) / ms.length;
    return Array.from({ length: n }, (_, i) => [rmax * norm.reduce((s, r) => s + r[i], 0) / norm.length, (heightM * i) / (n - 1)] as [number, number]);
}

const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
const meanRgb = (cs: Array<Vec3 | undefined>): Vec3 | undefined => { const k = cs.filter((c): c is Vec3 => !!c); return k.length ? [0, 1, 2].map(i => Math.round(mean(k.map(c => c[i])))) as Vec3 : undefined; };

/**
 * The largest set of readings that agree pairwise on `fields` (numbers present in all of them, within tolerance), as long
 * as it holds at least two; else undefined with the reason.
 */
function agreeingSet<T>(items: T[], agree: (a: T, b: T) => string | undefined): { set: T[] } | { reason: string } {
    if (items.length < 2) return { reason: items.length ? 'only one reference showed it' : 'no reference showed it' };
    let best: T[] = [], why = '';
    for (let i = 0; i < items.length; i++) {
        const set = [items[i]];
        for (let j = 0; j < items.length; j++) {
            if (j === i) continue;
            const w = set.map(s => agree(s, items[j])).find(Boolean);
            if (!w) set.push(items[j]); else why = w;
        }
        if (set.length > best.length) best = set;
    }
    return best.length >= 2 ? { set: best } : { reason: `the references disagree (${why})` };
}

/** What at least two readings agree on (see the file header). */
export function agreeBridgeDetail(readings: BridgeDetailReading[]): AgreedBridgeDetail {
    const rejected: AgreedBridgeDetail['rejected'] = [];
    const out: AgreedBridgeDetail = { rejected, readings: readings.length, names: [...new Set(readings.map(r => r.name).filter((n): n is string => !!n))] };
    const differs = (what: string, a?: number, b?: number, rel?: number, absM?: number) => (a === undefined || b === undefined ? `${what} missing` : numbersAgree(a, b, rel, absM) ? undefined : `${what} ${a} vs ${b}`);

    // posts
    const withPosts = readings.map(r => r.posts).filter((p): p is NonNullable<BridgeDetailReading['posts']> => !!p);
    const present = withPosts.filter(p => p.present), absent = withPosts.filter(p => !p.present);
    if (absent.length >= 2 && present.length < 2) rejected.push({ item: 'posts', reason: 'the references show no posts' });
    else {
        const s = agreeingSet(present, (a, b) => (a.overSupports !== b.overSupports ? 'placement differs' : undefined)
            ?? differs('height', a.heightM, b.heightM)
            ?? (a.meridian && b.meridian ? (meridianDistance(a.meridian, b.meridian) <= 0.25 ? undefined : `outline differs by ${meridianDistance(a.meridian, b.meridian).toFixed(2)}`) : 'outline missing')
            ?? (!a.overSupports ? differs('spacing', a.spacingM, b.spacingM, 0.25, 0.5) : undefined));
        if ('reason' in s) rejected.push({ item: 'posts', reason: s.reason });
        else {
            const set = s.set, heightM = mean(set.map(p => p.heightM!));
            const hs = set.map(p => p.heads).filter((h): h is NonNullable<typeof h> => !!h);
            const headsAgree = hs.length >= 2 && hs.every(h => h.count === hs[0].count) && hs.every(h => numbersAgree(h.atHeightM, hs[0].atHeightM) && numbersAgree(h.armRadiusM, hs[0].armRadiusM, 0.5, 0.2));
            if (!headsAgree && hs.length) rejected.push({ item: 'post heads', reason: hs.length < 2 ? 'only one reference showed them' : 'the references disagree on their count, height or reach' });
            out.posts = {
                overSupports: !!set[0].overSupports, ...(set[0].overSupports ? {} : { spacingM: mean(set.map(p => p.spacingM!)) }), heightM,
                meridian: meanMeridian(set.map(p => p.meridian!), heightM),
                ...(headsAgree ? { heads: { count: hs[0].count, armRadiusM: mean(hs.map(h => h.armRadiusM)), atHeightM: Math.min(heightM, mean(hs.map(h => h.atHeightM))), radiusM: mean(hs.map(h => h.radiusM)), lengthM: mean(hs.map(h => h.lengthM)) } } : {}),
                ...(meanRgb(set.map(p => p.colourSrgb)) ? { colourSrgb: meanRgb(set.map(p => p.colourSrgb)) } : {}),
                agreement: set.length / readings.length
            };
        }
    }

    // rail
    const rails = readings.map(r => r.rail).filter((r): r is NonNullable<BridgeDetailReading['rail']> => !!r && r.openFraction !== undefined);
    const rs = agreeingSet(rails, (a, b) => differs('openness', a.openFraction, b.openFraction, 0, 0.3) ?? differs('plinth', a.plinthM ?? 0, b.plinthM ?? 0, 0.5, 0.2));
    if ('reason' in rs) rejected.push({ item: 'rail', reason: rs.reason });
    else {
        const set = rs.set, open = mean(set.map(r => r.openFraction!));
        const bal = set.filter(r => r.balusterPitchM && r.balusterMeridian);
        const balAgree = open >= 0.5 && bal.length >= 2 && numbersAgree(bal[0].balusterPitchM!, bal[1].balusterPitchM!, 0.35, 0.05) && meridianDistance(bal[0].balusterMeridian!, bal[1].balusterMeridian!) <= 0.3;
        if (open >= 0.5 && !balAgree) rejected.push({ item: 'balusters', reason: bal.length < 2 ? 'fewer than two references showed them' : 'the references disagree on their pitch or outline' });
        out.rail = {
            openFraction: open, plinthM: mean(set.map(r => r.plinthM ?? 0)), copingM: mean(set.map(r => r.copingM ?? 0.15)), copingProjectionM: mean(set.map(r => r.copingProjectionM ?? 0.05)),
            ...(balAgree ? { balusterPitchM: mean(bal.map(r => r.balusterPitchM!)), balusterMeridian: meanMeridian(bal.map(r => r.balusterMeridian!), 1) } : {}),
            ...(meanRgb(set.map(r => r.colourSrgb)) ? { colourSrgb: meanRgb(set.map(r => r.colourSrgb)) } : {}),
            agreement: set.length / readings.length
        };
    }

    // supports
    const sups = readings.map(r => r.supports).filter((s): s is NonNullable<BridgeDetailReading['supports']> => !!s && s.noseLengthM !== undefined);
    const ss = agreeingSet(sups, (a, b) => differs('nose', a.noseLengthM, b.noseLengthM, 0.5, 0.5) ?? differs('pointedness', a.pointedness ?? 0, b.pointedness ?? 0, 0, 0.35));
    if ('reason' in ss) rejected.push({ item: 'supports', reason: ss.reason });
    else {
        const set = ss.set;
        const opt = (k: 'capHeightM' | 'capProjectionM' | 'pilasterProjectionM') => {
            const v = set.map(s => s[k]).filter((x): x is number => x !== undefined && x > 0);
            if (v.length >= 2 && v.every(x => numbersAgree(x, v[0], 0.5, 0.15))) return mean(v);
            if (v.length) rejected.push({ item: `supports ${k}`, reason: v.length < 2 ? 'only one reference showed it' : 'the references disagree' });
            return undefined;
        };
        const capHeightM = opt('capHeightM'), capProjectionM = opt('capProjectionM'), pilasterProjectionM = opt('pilasterProjectionM');
        out.supports = strip({ noseLengthM: mean(set.map(s => s.noseLengthM!)), pointedness: mean(set.map(s => s.pointedness ?? 0)), capHeightM, capProjectionM, pilasterProjectionM, colourSrgb: meanRgb(set.map(s => s.colourSrgb)), agreement: set.length / readings.length });
    }

    // arch rings
    const rings = readings.map(r => r.arches).filter((a): a is NonNullable<BridgeDetailReading['arches']> => !!a && !!a.ringWidthM && !!a.ringProjectionM);
    const ar = agreeingSet(rings, (a, b) => differs('ring width', a.ringWidthM, b.ringWidthM, 0.5, 0.2) ?? differs('ring projection', a.ringProjectionM, b.ringProjectionM, 0.6, 0.08));
    if ('reason' in ar) rejected.push({ item: 'arch rings', reason: ar.reason });
    else out.arches = { ringWidthM: mean(ar.set.map(a => a.ringWidthM!)), ringProjectionM: mean(ar.set.map(a => a.ringProjectionM!)), agreement: ar.set.length / readings.length };

    const sc = meanRgb(readings.map(r => r.structureColourSrgb));
    if (sc) out.structureColourSrgb = sc;
    return out;
}
