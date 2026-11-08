/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The set-fit regressor (pipeline-k/material-set-fit.ts): features in their declared order; a fit that recovers a planted
 * rule (the pick goes to the candidate whose texture energy matches the photo's, whatever its rank) and ranks held-out
 * candidates by it; the grain it allows capped at 1 at the picks' median; a model file of another version not loaded.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fitSetFit, loadSetFitModel, predictSetFit, SET_FIT_FEATURES, SET_FIT_MODEL_FILE, SET_FIT_VERSION, setFitFeatures, setFitGrain, type SetFitModel } from '../src/node/3d-engine/staged-location/pipeline-k/material-set-fit';

function sampler(seed: number): () => number { let s = seed >>> 0; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296); }

describe('the set-fit regressor', () => {
    it('measures a class against a candidate in the declared order, a missing measurement flagged', () => {
        const x = setFitFeatures({ meanLab: [50, 2, 0], photoEnergy: [0.01, 0.02, 0.04], repeatM: 2 }, { rank: 0, colourLab: [55, 2, 0], energy: [0.01, 0.02, 0.04], tileM: [4, 2], roughness: 0.6 });
        expect(x).toHaveLength(SET_FIT_FEATURES.length);
        const at = (f: (typeof SET_FIT_FEATURES)[number]) => x[SET_FIT_FEATURES.indexOf(f)];
        expect(at('dL')).toBeCloseTo(0.5, 6);
        expect(at('energyAbs')).toBeCloseTo(0, 6);
        expect(at('energyKnown')).toBe(1);
        expect(at('tileOverRepeat')).toBeCloseTo(Math.log(2), 6);
        expect(at('readKnown')).toBe(0);
        expect(setFitFeatures({ meanLab: [50, 0, 0] }, { rank: 3 })[SET_FIT_FEATURES.indexOf('energyKnown')]).toBe(0);
    });

    it('learns which candidates fit from the picks and ranks unseen candidates by it', () => {
        // 120 classes of 10 candidates; the pick is the candidate whose pattern energy matches the photo's (energyAbs
        // smallest), whatever its colour rank
        const rnd = sampler(5), rows: Array<{ x: number[]; y: number; w: number; cls: number; picked: boolean }> = [];
        for (let c = 0; c < 120; c++) {
            const photo = [0.01 + rnd() * 0.05, 0.01 + rnd() * 0.05, 0.01 + rnd() * 0.05];
            const cands = Array.from({ length: 10 }, (_, rank) => ({ rank, energy: photo.map(v => v * Math.exp((rnd() - 0.5) * 4)) }));
            const gap = cands.map(s => s.energy.reduce((a, v, b) => a + Math.abs(Math.log(v / photo[b])), 0));
            const pick = gap.indexOf(Math.min(...gap));
            cands.forEach((s, i) => rows.push({ x: setFitFeatures({ meanLab: [50, 0, 0], photoEnergy: photo }, s), y: i === pick ? 0.8 : 0, w: 1, cls: c, picked: i === pick }));
        }
        const train = rows.filter(r => r.cls < 90), test = rows.filter(r => r.cls >= 90);
        const fit = fitSetFit(train);
        const m: SetFitModel = { version: SET_FIT_VERSION, features: [...SET_FIT_FEATURES], ...fit, trainedOn: { rows: train.length, classes: 90, buildings: 1, atIso: '' }, pickedMedian: 0.3 };
        // the energy mismatch carries the most negative weight
        const w = (f: (typeof SET_FIT_FEATURES)[number]) => m.weights[SET_FIT_FEATURES.indexOf(f)];
        expect(w('energyAbs')).toBeLessThan(-Math.abs(w('rank')));
        // on held-out classes the model's first choice is the pick far more often than the ranking's first (10% by chance)
        let top = 0;
        for (let c = 90; c < 120; c++) {
            const rs = test.filter(r => r.cls === c);
            const p = (x: number[]) => { let z = m.bias; x.forEach((v, i) => (z += m.weights[i] * ((v - m.mean[i]) / m.scale[i]))); return z; };
            if (rs.reduce((a, b) => (p(b.x) > p(a.x) ? b : a)).picked) top++;
        }
        expect(top / 30).toBeGreaterThan(0.5);
        // the grain it allows: in full at or above the picks' median, in proportion below
        const good = { rank: 0, energy: [0.02, 0.02, 0.02] }, cls = { meanLab: [50, 0, 0] as [number, number, number], photoEnergy: [0.02, 0.02, 0.02] };
        const p = predictSetFit(m, cls, good);
        expect(setFitGrain({ ...m, pickedMedian: p / 2 }, cls, good)).toBe(1);
        expect(setFitGrain({ ...m, pickedMedian: p * 2 }, cls, good)).toBeCloseTo(0.5, 6);
    });

    it('loads the committed model only when its version and features match', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'set-fit-'));
        fs.mkdirSync(path.dirname(path.join(root, SET_FIT_MODEL_FILE)), { recursive: true });
        const m = { version: SET_FIT_VERSION, features: [...SET_FIT_FEATURES], mean: [], scale: [], weights: [], bias: 0, trainedOn: { rows: 0, classes: 0, buildings: 0, atIso: '' }, pickedMedian: 0.5 };
        fs.writeFileSync(path.join(root, SET_FIT_MODEL_FILE), JSON.stringify(m));
        expect(loadSetFitModel(root)?.version).toBe(SET_FIT_VERSION);
        fs.writeFileSync(path.join(root, SET_FIT_MODEL_FILE), JSON.stringify({ ...m, version: 'material-set-fit/0' }));
        expect(loadSetFitModel(root)).toBeUndefined();
        expect(loadSetFitModel(path.join(root, 'none'))).toBeUndefined();
    });
});
