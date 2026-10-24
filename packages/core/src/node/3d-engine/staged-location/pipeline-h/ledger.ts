/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The evidence ledger of a procedural rebuild (pipeline H): one entry per decision the build took between sources of
 * evidence (which structure, whose footprint, whose height, which roof facets, each wall's reading kept or dropped,
 * which continued openings were built), with every candidate considered and why the chosen one won. No source is the
 * truth on its own (user principle, 2026-10-23): the scan, Google's vector data, the Solar API, the survey readings and
 * the search-grounded references each say something, and the ledger says what the build made of them. Written into
 * the building brief (brief.ts) and returned with the outcome, so the chat and the run record can show it.
 */

export const LEDGER_SCHEMA = 'scratchbox.evidence-ledger/1';

export interface LedgerSource {
    /** Where the candidate came from: scan, vector, solar, reading, re-reading, continuation, native, texture, ... */
    source: string;
    /** The candidate itself, as a short string (a height, a count, a reading's fit). */
    value: string;
    used: boolean;
}

export interface LedgerEntry {
    /** What was decided: 'structure', 'footprint', 'height:<part>', 'roof:<part>', 'reading:<wall>', 'continuation:<wall>', 'rejections', 'textures:<wall>' */
    decision: string;
    chosen: string;
    why: string;
    sources: LedgerSource[];
}

/** A ledger entry from a part's massing notes ('height from the scan (88.7 m); Solar 91.6 m disagreed by more than 2.5 m'). */
export function ledgerFromMassingNote(note: string): LedgerEntry | undefined {
    const m = /^part (\S+): height from (the scan|solar|the vector data|Solar) \(([\d.]+) m\)(.*)$/i.exec(note);
    if (!m) return undefined;
    const [, part, from, h, rest] = m;
    const sources: LedgerSource[] = [{ source: from.replace(/^the /, ''), value: `${h} m`, used: true }];
    for (const o of rest.matchAll(/(Solar|vector) ([\d.]+) m/g)) if (o[1].toLowerCase() !== from.replace(/^the /, '').toLowerCase()) sources.push({ source: o[1].toLowerCase(), value: `${o[2]} m`, used: false });
    return { decision: `height:${part}`, chosen: `${h} m from ${from.replace(/^the /, '')}`, why: rest.replace(/^[;:,]\s*/, '').trim() || 'the only height offered', sources };
}
