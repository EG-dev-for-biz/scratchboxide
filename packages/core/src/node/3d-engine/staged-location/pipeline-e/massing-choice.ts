/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Which massing candidate a structure gets: the simplest one that explains the scan within tolerance. Candidates come
 * ordered simplest first (an extruded block, then stacked scan sections, then lofted sections ...); each is measured
 * against the scan by surface-agreement.ts, height-balanced, and accepted when it covers `minCoverage` of the scan and
 * `minPrecision` of its own surface (the part the scan could have seen) is supported. The first accepted wins. When
 * none is, the best height-balanced F wins and the result says it fell short. The scan always leads; a more detailed
 * candidate is chosen only when the simpler ones fail to explain it, so a plain block stays a block and a needle, a dome
 * or anything nobody anticipated gets the shape its scan demands. No structure type is consulted.
 */

import type { SurfaceAgreement } from './surface-agreement';

export const MASSING_CHOICE_PARAMS = {
    /** Least height-balanced coverage of the scan for a candidate to explain it. */
    minCoverage: 0.9,
    /** Least height-balanced precision (supported share of the candidate's visible surface). */
    minPrecision: 0.85
};

export interface MassingCandidateScore {
    label: string;
    /** Triangles (or another monotone measure of detail): reported, and the order is simplest first. */
    complexity: number;
    agreement: SurfaceAgreement;
}

export interface MassingChoice {
    chosen: string;
    /** Whether the chosen candidate met both thresholds (false: none did, the best F was taken). */
    explains: boolean;
    why: string;
    candidates: Array<{ label: string; complexity: number; coverage: number; precision: number; f: number; accepted: boolean; reason: string }>;
}

export function chooseMassing(ordered: MassingCandidateScore[], P = MASSING_CHOICE_PARAMS): MassingChoice {
    if (!ordered.length) throw new Error('chooseMassing: no candidates');
    const rows = ordered.map(c => {
        const { coverage, precision, f } = c.agreement.banded;
        const short: string[] = [];
        if (coverage < P.minCoverage) short.push(`covers ${coverage} of the scan (< ${P.minCoverage})`);
        if (precision < P.minPrecision) short.push(`${precision} of its surface is supported (< ${P.minPrecision})`);
        return { label: c.label, complexity: c.complexity, coverage, precision, f, accepted: !short.length, reason: short.length ? short.join('; ') : `explains the scan (coverage ${coverage}, precision ${precision})` };
    });
    const first = rows.find(r => r.accepted);
    if (first) {
        const simpler = rows.slice(0, rows.indexOf(first));
        return { chosen: first.label, explains: true, why: `${first.label}: the simplest candidate that ${first.reason}${simpler.length ? `; simpler ones fell short (${simpler.map(r => `${r.label}: ${r.reason}`).join('; ')})` : ''}`, candidates: rows };
    }
    const best = rows.reduce((a, b) => (b.f > a.f ? b : a));
    return { chosen: best.label, explains: false, why: `no candidate explains the scan within tolerance; ${best.label} fits best (height-balanced F ${best.f})`, candidates: rows };
}
