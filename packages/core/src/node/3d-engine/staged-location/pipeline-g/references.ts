/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Pipeline G's outside help for a wall its own survey could not read well: a wall the check (check.ts) marks weak, after
 * its re-read, gets a search-grounded reference (search-grounded-reference.ts) of the real building's matching facade,
 * asked for by this building's name and the wall's own size and compass heading, so the model looks the right face up.
 * Two independent models answer; neither is trusted alone, and nothing here claims the result is a measurement — the
 * references are written into the building brief next to the plate they stand in for (brief.ts), labelled generated, for
 * whoever next works from the brief to look at and use only where the two references agree and the scan does not
 * contradict them. A wall the survey already read well never asks: this is only for where the tile's own photo failed.
 */

import * as path from 'path';
import { fetchGroundedReferences, type GroundedReferenceClient } from '../../../spatial/search-grounded-reference';
import { storeGroundedReferences, type StoredGroundedReference } from '../../../gemini/tools/location-reference-tools';
import type { MassingFace } from '../pipeline-e/native-massing';
import type { ReadingCheck } from './check';

const COMPASS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];

/** The compass heading a face's normal points, in degrees (0 = north, 90 = east), as stations.ts computes it. */
export function headingDeg(normal: readonly number[]): number {
    return ((Math.atan2(normal[0], -normal[2]) * 180) / Math.PI + 360) % 360;
}

/** What to ask for and why, from a weak wall's own size and heading; pure, so it is easy to check without a model call. */
export function weakWallSubject(f: Pick<MassingFace, 'sMax' | 'sMin' | 'tMax' | 'tMin' | 'normal'>): { subject: string; view: string; questions: string[] } {
    const widthM = Math.round(f.sMax - f.sMin), heightM = Math.round(f.tMax - f.tMin);
    const compass = COMPASS[Math.round(headingDeg(f.normal) / 45) % 8];
    return {
        subject: `the ${compass}-facing wall, about ${widthM} m wide and ${heightM} m tall`,
        view: `straight on, from the street`,
        questions: [
            'how many storeys it has and where the floor lines fall',
            'how the window or door openings are arranged across it (rows and columns, any that differ from the rest)',
            'what ornament, bands, piers or other projecting detail it carries, and where'
        ]
    };
}

export interface WeakWallReference { face: string; references: StoredGroundedReference[]; skipped?: string }

/**
 * A search-grounded reference for every plate the check marked weak (the kept reading's own check, after any re-read).
 * One wall failing to fetch does not stop the others or the build; its entry carries `skipped` with why instead.
 */
export async function weakWallReferences(input: {
    client: GroundedReferenceClient; place: string; models?: string[]; outputDir: string; workspaceRoot?: string; signal?: AbortSignal;
    plates: Array<{ face: MassingFace; check?: ReadingCheck }>;
}): Promise<WeakWallReference[]> {
    const weak = input.plates.filter(p => p.check?.weak);
    const out: WeakWallReference[] = [];
    for (const p of weak) {
        const { subject, view, questions } = weakWallSubject(p.face);
        try {
            const result = await fetchGroundedReferences(input.client, { place: input.place, subject, view, questions }, { models: input.models, signal: input.signal });
            const references = await storeGroundedReferences(result, { place: input.place, subject, view, questions, outputDir: path.join(input.outputDir, p.face.key.replace(/[^a-z0-9]+/gi, '_')), workspaceRoot: input.workspaceRoot });
            out.push({ face: p.face.key, references });
        } catch (err) {
            if (input.signal?.aborted) throw err;
            out.push({ face: p.face.key, references: [], skipped: err instanceof Error ? err.message : String(err) });
        }
    }
    return out;
}
