/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Detail of a rebuilt solid of revolution that the scan cannot resolve (ribs narrower than the tiles' geometric error),
 * from search-grounded references: several independent answers from Gemini with Google Search grounding, each asked the
 * same structured question about the part at its measured place and size. Only what the answers agree on is taken as
 * agreed; a count they disagree on may still be filled with a plausible estimate (their median, snapped to the period
 * the scan does measure), labelled as an estimate with every answer kept. Geometry and dimensions stay the scan's: a
 * reference only adds what the scan cannot see and does not contradict.
 */

import type { GenerateContentParameters, GenerateContentResponse } from '@google/genai';
import type { RevolutionRecord } from './revolution-fit';

export const REVOLUTION_REFERENCE_VERSION = 'revolution-reference/1';

export interface ReferenceClient { models: { generateContent(params: GenerateContentParameters): Promise<GenerateContentResponse> } }

/** One model's structured answer (null: it did not say). */
export interface ReferenceAnswer {
    model: string;
    ribCount: number | null;
    ribsRaised: boolean | null;
    ribWidthM: number | null;
    ribHeightM: number | null;
    majorRibCount: number | null;
    lanternWindowCount: number | null;
    lanternHasCupola: boolean | null;
    lanternHasFinial: boolean | null;
    finialKind: string | null;
    evidence: string;
    queries: string[];
    sources: string[];
    error?: string;
}

export interface RevolutionReference {
    version: string;
    /** The question, as asked. */
    prompt: string;
    answers: ReferenceAnswer[];
    /** Fields every answer that gave one agrees on (counts within 25%), with the agreed value. */
    agreed: Record<string, number | boolean>;
    /** Fields the answers disagree on, with every value given. */
    disagreed: Record<string, Array<number | boolean | null>>;
    /** The ribs to add, or why none are added. */
    ribs: { K: number; widthM: number; heightM: number; exponent: number; countBasis: string; widthBasis: string; heightBasis: string } | { none: string };
}

const FIELDS = ['ribCount', 'ribsRaised', 'ribWidthM', 'ribHeightM', 'majorRibCount', 'lanternWindowCount', 'lanternHasCupola', 'lanternHasFinial'] as const;

/** The question for a part at (lat, lng) of the measured radius and height, near the named place. */
export function referencePrompt(where: { place: string; lat: number; lng: number; radiusM: number; heightM: number }): string {
    return `Use Google Search. At ${where.lat.toFixed(5)}, ${where.lng.toFixed(5)} (near ${where.place}) a building carries a round roof part, a solid of revolution about ${(2 * where.radiusM).toFixed(0)} m across and ${where.heightM.toFixed(0)} m tall (a dome, cupola or spire). Identify it, and from photographs and descriptions of it answer only with JSON:
{"ribCount": number|null (total raised ribs or seams around the whole part, base to top; estimate from photos if not stated), "ribsRaised": boolean|null, "ribWidthM": number|null, "ribHeightM": number|null, "majorRibCount": number|null (if some ribs are larger), "lanternWindowCount": number|null (openings around a lantern on top), "lanternHasCupola": boolean|null, "lanternHasFinial": boolean|null, "finialKind": string|null, "evidence": string}`;
}

function parseAnswer(model: string, text: string): Omit<ReferenceAnswer, 'queries' | 'sources'> {
    const m = text.match(/\{[\s\S]*\}/);
    const j = m ? JSON.parse(m[0]) : {};
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    const bool = (v: unknown) => (typeof v === 'boolean' ? v : null);
    return {
        model, ribCount: num(j.ribCount), ribsRaised: bool(j.ribsRaised), ribWidthM: num(j.ribWidthM), ribHeightM: num(j.ribHeightM), majorRibCount: num(j.majorRibCount),
        lanternWindowCount: num(j.lanternWindowCount), lanternHasCupola: bool(j.lanternHasCupola), lanternHasFinial: bool(j.lanternHasFinial),
        finialKind: typeof j.finialKind === 'string' ? j.finialKind : null, evidence: typeof j.evidence === 'string' ? j.evidence.slice(0, 600) : ''
    };
}

/** Asks each model (a model may be listed twice for a second independent answer); a failed answer is kept with its error. */
export async function askRevolutionReference(client: ReferenceClient, models: string[], prompt: string): Promise<ReferenceAnswer[]> {
    return Promise.all(models.map(async model => {
        try {
            const r = await client.models.generateContent({ model, contents: [{ role: 'user', parts: [{ text: prompt }] }], config: { tools: [{ googleSearch: {} }] } });
            const parts = r.candidates?.[0]?.content?.parts ?? [];
            const g: any = r.candidates?.[0]?.groundingMetadata;
            const text = parts.filter(p => p.text && !p.thought).map(p => p.text).join(' ');
            return {
                ...parseAnswer(model, text),
                queries: (g?.webSearchQueries ?? []).slice(0, 40),
                sources: (g?.groundingChunks ?? []).map((c: any) => c.web?.uri ?? c.web?.title).filter(Boolean).slice(0, 20)
            };
        } catch (err) {
            return { model, ribCount: null, ribsRaised: null, ribWidthM: null, ribHeightM: null, majorRibCount: null, lanternWindowCount: null, lanternHasCupola: null, lanternHasFinial: null, finialKind: null, evidence: '', queries: [], sources: [], error: (err as Error).message.slice(0, 300) };
        }
    }));
}

const median = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s.length % 2 ? s[s.length >> 1] : 0.5 * (s[s.length / 2 - 1] + s[s.length / 2]); };

/**
 * What the answers agree on, and the ribs to add: only when every answer that says so agrees the ribs are raised, at
 * least two answers give a count, and the scan does not contradict it (the count is snapped to a multiple of the scan's
 * own period when it measures one: its 2 m geometry sees the major ribs as a coarser period). A count the answers
 * disagree on is filled, labelled an estimate, only when most of them cluster (at least three, `clusterShare` within 35%
 * of their median); rib width and height, when no answer gives
 * them, are plausible estimates (2.5% and 1.2% of the radius), labelled so.
 */
export function referenceConsensus(answers: ReferenceAnswer[], r: Pick<RevolutionRecord, 'stacks'>, prompt = '', clusterShare = 0.6): RevolutionReference {
    const ok = answers.filter(a => !a.error);
    const agreed: RevolutionReference['agreed'] = {};
    const disagreed: RevolutionReference['disagreed'] = {};
    for (const f of FIELDS) {
        const vals = ok.map(a => a[f]).filter((v): v is number | boolean => v !== null);
        if (vals.length < 2) { if (ok.length) disagreed[f] = ok.map(a => a[f]); continue; }
        if (typeof vals[0] === 'boolean') {
            if (vals.every(v => v === vals[0])) agreed[f] = vals[0]; else disagreed[f] = ok.map(a => a[f]);
        } else {
            const n = vals as number[];
            if (Math.max(...n) <= 1.25 * Math.min(...n)) agreed[f] = Math.round(median(n) * 1000) / 1000; else disagreed[f] = ok.map(a => a[f]);
        }
    }
    const cap = r.stacks[0]?.cap;
    const scanK = r.stacks[0]?.capModulation.K ?? 0;
    const base: Omit<RevolutionReference, 'ribs'> = { version: REVOLUTION_REFERENCE_VERSION, prompt, answers, agreed, disagreed };
    if (!cap) return { ...base, ribs: { none: 'the part has no cap to carry ribs' } };
    if (agreed.ribsRaised !== true) return { ...base, ribs: { none: 'the references do not agree that the part has raised ribs' } };
    const counts = ok.map(a => a.ribCount).filter((v): v is number => v !== null && v >= 3);
    if (counts.length < 2) return { ...base, ribs: { none: 'fewer than two references give a rib count' } };
    let K: number, countBasis: string;
    if (typeof agreed.ribCount === 'number') { K = Math.round(agreed.ribCount); countBasis = `agreed by ${counts.length} search-grounded references (${counts.join(', ')})`; }
    else {
        // a count the answers disagree on is filled only when most of them cluster: at least three counts, and at least
        // `clusterShare` of them within 35% of their median; else the answers are too scattered to fill anything from
        const m0 = median(counts);
        const near = counts.filter(c => Math.abs(c - m0) <= 0.35 * m0);
        if (counts.length < 3 || near.length < Math.ceil(clusterShare * counts.length)) return { ...base, ribs: { none: `the search-grounded references disagree on the rib count too widely to fill it (${counts.join(', ')})` } };
        K = Math.round(median(near));
        countBasis = `estimated: the median of the ${near.length} of ${counts.length} search-grounded counts that cluster (${counts.join(', ')})`;
    }
    if (scanK) {
        const snapped = Math.max(scanK, Math.round(K / scanK) * scanK);
        if (snapped !== K) countBasis += `, snapped to ${snapped}, a multiple of the ${scanK}-fold period the scan measures`;
        K = snapped;
    }
    const widths = ok.map(a => a.ribWidthM).filter((v): v is number => v !== null && v > 0 && v < 2);
    const heights = ok.map(a => a.ribHeightM).filter((v): v is number => v !== null && v > 0 && v < 1);
    const widthM = widths.length ? median(widths) : 0.025 * cap.R0;
    const heightM = heights.length ? median(heights) : 0.012 * cap.R0;
    return {
        ...base,
        ribs: {
            K, widthM: Math.round(widthM * 1000) / 1000, heightM: Math.round(heightM * 1000) / 1000, exponent: 8, countBasis,
            widthBasis: widths.length ? `the median of ${widths.length} reference${widths.length > 1 ? 's' : ''} (${widths.join(', ')} m)` : 'a plausible estimate (2.5% of the radius): no reference gave it',
            heightBasis: heights.length ? `the median of ${heights.length} reference${heights.length > 1 ? 's' : ''} (${heights.join(', ')} m)` : 'a plausible estimate (1.2% of the radius): no reference gave it'
        }
    };
}

/** The native tool's detail line for a revolution's reference ribs. */
export function referenceDetailLine(r: Pick<RevolutionRecord, 'axis'>, ref: RevolutionReference): string | undefined {
    if (!('K' in ref.ribs)) return undefined;
    return `${r.axis.x} ${r.axis.z} ${ref.ribs.K} ${ref.ribs.widthM} ${ref.ribs.heightM} ${ref.ribs.exponent}`;
}

/** The models asked by default: five independent searches from two models. */
export const REVOLUTION_REFERENCE_MODELS = ['gemini-3.1-pro-preview', 'gemini-2.5-pro', 'gemini-3.1-pro-preview', 'gemini-2.5-pro', 'gemini-3.1-pro-preview'];

/** Search-grounded references run in a staged district unless SCRATCHBOX_STAGED_REVOLUTION_REFERENCE=0. */
export function revolutionReferenceEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
    return env.SCRATCHBOX_STAGED_REVOLUTION_REFERENCE !== '0';
}

/** The reference lookup for one district: each accepted revolution asked about at its own place and measured size. */
export function revolutionReferenceFor(input: { client: ReferenceClient; place: string; toLatLng: (x: number, z: number) => { lat: number; lng: number }; models?: string[] }): (r: RevolutionRecord) => Promise<RevolutionReference> {
    return async r => {
        const { lat, lng } = input.toLatLng(r.axis.x, r.axis.z);
        const top = r.stacks.length ? r.stacks[r.stacks.length - 1].yTop : r.plan.peakY;
        const prompt = referencePrompt({ place: input.place, lat, lng, radiusM: r.plan.r, heightM: top - (r.stacks[0]?.yBottom ?? r.plan.baseY) });
        const answers = await askRevolutionReference(input.client, input.models ?? REVOLUTION_REFERENCE_MODELS, prompt);
        return referenceConsensus(answers, r, prompt);
    };
}
