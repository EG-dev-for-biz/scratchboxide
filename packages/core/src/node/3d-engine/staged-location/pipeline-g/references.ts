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
 * asked for by this building's name and city when the evidence names it (building-name.ts; the resolved address when it
 * does not: a street address finds far fewer facade photographs than "Flatiron Building, New York"), and by the wall's own
 * size and compass heading, so the model looks the right face up. Every stored reference says which query it was asked with.
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
import { localityOf } from '../building-name';

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

/**
 * The place a wall's reference is searched by: the building's primary name with its locality when the evidence named it,
 * else the resolved address as it is. Pure, so the choice is checked without a model call.
 */
export function referenceQuery(input: { name?: string; address: string }): string {
    const name = input.name?.trim();
    if (!name) return input.address;
    const locality = localityOf(input.address);
    return locality && norm(name) !== norm(locality) && !norm(name).includes(norm(locality)) ? `${name}, ${locality}` : name;
}
const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

export interface WeakWallReference {
    face: string; references: StoredGroundedReference[]; skipped?: string;
    /** What the models were asked to look the wall up by (referenceQuery): the building's name and city, or its address. */
    query: string;
}

/**
 * A search-grounded reference for every plate the check marked weak (the kept reading's own check, after any re-read).
 * One wall failing to fetch does not stop the others or the build; its entry carries `skipped` with why instead.
 */
export async function weakWallReferences(input: {
    client: GroundedReferenceClient;
    /** The search query the building is looked up by (referenceQuery): its name and city, or its address when it has no name. */
    query: string;
    models?: string[]; outputDir: string; workspaceRoot?: string; signal?: AbortSignal;
    plates: Array<{ face: MassingFace; check?: ReadingCheck }>;
}): Promise<WeakWallReference[]> {
    const weak = input.plates.filter(p => p.check?.weak);
    const out: WeakWallReference[] = [];
    for (const p of weak) {
        const { subject, view, questions } = weakWallSubject(p.face);
        try {
            // the request's `place` is the search query: the name and city when the evidence named the building
            const result = await fetchGroundedReferences(input.client, { place: input.query, subject, view, questions }, { models: input.models, signal: input.signal });
            const references = await storeGroundedReferences(result, { place: input.query, subject, view, questions, outputDir: path.join(input.outputDir, p.face.key.replace(/[^a-z0-9]+/gi, '_')), workspaceRoot: input.workspaceRoot });
            out.push({ face: p.face.key, references, query: input.query });
        } catch (err) {
            if (input.signal?.aborted) throw err;
            out.push({ face: p.face.key, references: [], query: input.query, skipped: err instanceof Error ? err.message : String(err) });
        }
    }
    return out;
}
