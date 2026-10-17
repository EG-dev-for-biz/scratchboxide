/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The targeted second pass for repeating runs and bands (run-reading.ts): which survey elements become targets (by repeat and
 * proportions, never by name), where the narrow crops are aimed on the real arch fit, and one small focused reading per run,
 * with a fake vision model that READS ITS PROMPT, a fake grounding service and no billed call.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { VisionModelChain } from '../src/node/gemini/vision-model-chain';
import { planRunViews, readRuns, selectRunTargets, RUN_FOV_MAX_DEG, RUN_FOV_MIN_DEG } from '../src/node/3d-engine/staged-location/run-reading';
import { chartNormal } from '../src/node/3d-engine/staged-location/slot-projection';
import { readGlbScene, sceneToRenderMesh } from '../src/node/spatial/StreetViewPoseRegistrar';
import type { LocatedElement } from '../src/node/3d-engine/staged-location/survey-detail';
import type { OrnamentSpec, StructureFit, Vec3 } from '../src/common/spatial/staged-location-contracts';
import { STAGED_VISION_MODEL_DEFAULT } from '../src/common/spatial/staged-location-contracts';
import { findArchFit } from './helpers/real-arch-data';
import { bandJpeg, GREY, SKY, STONE } from './helpers/photo-ornament-fixtures';

const real = findArchFit();

function located(over: Partial<LocatedElement>): LocatedElement {
    return {
        id: 'f0.e0', faceId: 'f0', headingDeg: 0, panoId: 'P', imageIndex: 0, kind: 'k', box: [0, 0, 100, 100], slotId: 'S1', slotOverlap: 1, surfaceId: 's0',
        regionUv: { u0: 0, u1: 3, v0: 0, v1: 2 }, widthM: 3, heightM: 2, centre: [0, 5, 0], metresPerPx: 0.02, material: 'stone', weathering: 'none', confidence: 70, distanceM: 20,
        locationUncertaintyM: 0.3, placeSource: 'x', ...over
    };
}

describe('run targets', () => {
    it('takes a repeating run and a band, by repeat and proportion, and leaves a plain panel; the survey\'s word for it is never read', () => {
        const els = [
            located({ id: 'a', kind: 'zzz-unheard-of-1', repeat: { count: 12, pitchM: 0.3, axis: 'h' }, slotId: 'S1' }),
            located({ id: 'b', kind: 'zzz-unheard-of-2', widthM: 9, heightM: 1.2, slotId: 'S2' }),
            located({ id: 'c', kind: 'cornice', widthM: 2.5, heightM: 2, slotId: 'S3' }),
            located({ id: 'd', kind: 'zzz-3', widthM: 1, heightM: 1, runAlongM: [0.5, 4.5], slotId: 'S4' })
        ];
        const t = selectRunTargets(els);
        expect(t.map(x => x.id).sort()).toEqual(['a', 'b', 'd']);
        expect(t.find(x => x.id === 'a')!.because).toMatch(/repeating run of about 12/);
        expect(t.find(x => x.id === 'b')!.because).toMatch(/band/);
    });

    it('keeps the more confident of two readings of the same run on one slot', () => {
        const els = [
            located({ id: 'lo', repeat: { count: 10, pitchM: 0.3, axis: 'h' }, runAlongM: [0.5, 3.5], confidence: 50 }),
            located({ id: 'hi', repeat: { count: 11, pitchM: 0.3, axis: 'h' }, runAlongM: [0.6, 3.6], confidence: 85 })
        ];
        expect(selectRunTargets(els).map(x => x.id)).toEqual(['hi']);
    });
});

describe.skipIf(!real)('the focused pass on the real arch fit', () => {
    const fit = (() => {
        const f = JSON.parse(fs.readFileSync(real!.fitPath, 'utf8')) as StructureFit;
        f.outputs.fittedGlb = path.join(real!.dir, 'fitted.glb');
        f.outputs.passThroughGlb = path.join(real!.dir, 'passthrough.glb');
        return f;
    })();
    const occluder = () => sceneToRenderMesh([...readGlbScene(fit.outputs.fittedGlb), ...readGlbScene(fit.outputs.passThroughGlb!)]);
    // the arch's top edge band slot: a run of dentils along it, as the survey would have located it
    const slotId = 'S69';
    const slot = fit.slots.find(s => s.id === slotId)!;
    const edge = 'edge' in slot.host ? slot.host.edge : undefined;
    const surface = fit.surfaces.find(s => s.id === edge!.surfaceIds[0])!;
    const normal = chartNormal(surface.chart, 0);
    const pts = edge!.carrier.points as Vec3[];
    const mid: Vec3 = [(pts[0][0] + pts[pts.length - 1][0]) / 2, pts[0][1] - 0.3, (pts[0][2] + pts[pts.length - 1][2]) / 2];
    const element = located({
        id: 'f1.e0', kind: 'a word the code has never met', slotId, surfaceId: surface.id, centre: mid, widthM: 4.9, heightM: 0.5, runAlongM: [0.3, 5.2],
        repeat: { count: 12, pitchM: 0.41, axis: 'h' }, confidence: 80, regionUv: { u0: 0, u1: 4.9, v0: 0, v1: 0.5 }
    });
    const eyeY = fit.ground.baseY + 2.5;
    const panos = [-35, 0, 35, 75].map((deg, k) => {
        const a = Math.atan2(normal[0], normal[2]) + (deg * Math.PI) / 180;
        return { panoId: `PANO${k}`, lat: 0, lng: 0, date: '2025-06', copyright: '© Google', x: mid[0] + 26 * Math.sin(a), z: mid[2] + 26 * Math.cos(a) };
    });

    it('aims narrow crops at the run from panos that face it squarely, 1-2 of them, with the slot unoccluded', () => {
        const views = planRunViews(
            { id: element.id, located: element, slotId, because: 'x' },
            panos.map(p => ({ panoId: p.panoId, date: p.date, copyright: p.copyright, eye: [p.x, eyeY, p.z] as Vec3 })), fit, occluder(), undefined
        );
        expect(views.length).toBeGreaterThan(0);
        expect(views.length).toBeLessThanOrEqual(2);
        for (const v of views) {
            expect(v.view.fovDeg).toBeGreaterThanOrEqual(RUN_FOV_MIN_DEG);
            expect(v.view.fovDeg).toBeLessThanOrEqual(RUN_FOV_MAX_DEG);
            expect(v.visibleFraction).toBeGreaterThanOrEqual(0.3);
            expect(v.view.aimedSlotIds).toEqual([slotId]);
        }
    });

    it('reads one run alone with a small prompt (one slot, one crop, no corrections), builds the dentils on the located run, and keeps them photo-inferred with the anchoring error', async () => {
        const calls: Array<{ text: string; images: number }> = [];
        const client = {
            models: {
                generateContent: async () => { throw new Error('streaming expected'); },
                generateContentStream: async (params: any) => {
                    const parts = params.contents[0].parts as any[];
                    const text = parts.filter(p => p.text).map(p => p.text).join('\n');
                    calls.push({ text, images: parts.filter(p => p.inlineData).length });
                    // the polygon of the slot in the crop, as the prompt gives it
                    const m = text.match(new RegExp(`\\[0\\] ${'[^\\n]*?'}${slotId} → (\\[[\\d,]+\\])`));
                    const poly: number[] = m ? JSON.parse(m[1]) : [0, 0, 1000, 1000];
                    const ys = poly.filter((_, i) => i % 2 === 0), xs = poly.filter((_, i) => i % 2 === 1);
                    const box = [0, Math.min(...ys), Math.min(...xs), Math.max(...ys), Math.max(...xs)];
                    // 12 dentils a few per cent off the located 4.9 m run, as an estimate is
                    const reply = { elements: [{ slot: slotId, op: { replicate: { seed: { sweep: { t: [0, 8], profile: [0, 0, 160, 0, 160, 110, 0, 110] } }, along: [Math.round((0.3 / edge!.carrier.lengthM) * 1000), 415, 12] } }, conf: 74, depthBasis: 'shadow in the gaps', ev: [box], label: 'repeats' }], corrections: [], emptySlots: [] };
                    return (async function* () { yield { candidates: [{ content: { parts: [{ text: JSON.stringify(reply) }] }, finishReason: 'STOP' }], modelVersion: `${params.model}-001`, usageMetadata: { promptTokenCount: 3000, candidatesTokenCount: 400, thoughtsTokenCount: 50 } } as any; })();
                }
            }
        };
        const grounding = {
            retrieveGroundingImage: async (req: any) => ({ image: bandJpeg([SKY, STONE, STONE, GREY], 320, 240), mimeType: 'image/jpeg', panoId: req.panoId, headingDegree: req.headingDegree, pitchDegree: req.pitchDegree, fovDegree: req.fovDegree })
        };
        const chain = new VisionModelChain<string>({ client: client as never, candidates: [STAGED_VISION_MODEL_DEFAULT.model], sleep: async () => undefined });
        const base: OrnamentSpec = {
            schema: 'scratchbox.ornament-spec/2', buildingId: fit.buildingId, structureFitSha256: 'x', promptVersion: 'p', evidence: [], elements: [], corrections: [], emptySlots: [],
            model: { requested: 'm', used: 'm', answered: 'm', thinking: { budget: 0 }, skipped: [], backend: 'x', ms: 1, outcome: 'answered', selection: 's' } as any, revision: { passes: 0, problems: [] }, dropped: []
        };
        const res = await readRuns({
            fit, fitSha256: 'x', base, located: [element], panos, groundAt: () => fit.ground.baseY, fallbackGroundY: fit.ground.baseY, occluder: occluder(),
            streetView: { grounding } as never, chain
        });
        expect(res.report.targets).toBe(1);
        expect(res.report.read).toBe(1);
        expect(calls.length).toBe(1);
        // a small prompt: one image, one slot, no corrections table
        expect(calls[0].images).toBeLessThanOrEqual(2);
        expect(calls[0].text).toContain('reading ONE repeating or banded group');
        expect(calls[0].text).toContain(`Slots offered (1 of ${fit.slots.length} fitted`);
        expect(calls[0].text).not.toContain('Correctable fit values');
        expect(calls[0].text.length).toBeLessThan(9000);
        // the dentils: built from the focused reading, on the located run, snapped to it with the error carried
        expect(res.spec.elements.length).toBe(1);
        const el = res.spec.elements[0];
        expect(el.id.startsWith('r0.')).toBe(true);
        expect(el.slotId).toBe(slotId);
        expect(el.provenance.label).toMatch(/photo/);
        expect(el.confidence).toBeGreaterThan(0.5);
        expect(el.spec.operator).toBe('replicate');
        expect(res.spec.evidence.length).toBeGreaterThan(0);
        expect(res.spec.evidence.every(e => e.kind === 'streetview-grounding')).toBe(true);
    });
});
