/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The set-fit regressor: how well a texture library set fits an appearance class (material-regions.ts), learned from the
 * finished textured buildings (user ask, 2026-11-05). Each training row is one class of a finished twin and one of the
 * candidates the pick by appearance was shown for it (material-choice.ts), labelled by that pick (picked, by its
 * confidence, or not), with features measured on the twin itself: the class's colour, its region, its texture energy as
 * the photos show it and its repeat size, against the set's measured colour, finish, relief, tile size and its texture
 * energy at the class's texel. Numbers only: nothing names a material.
 *
 * The model is a logistic regression on standardised features (fitSetFit), kept as data
 * (assets/textures/library/set-fit-model.json, scripts/material_set_fit.ts) and refitted as builds add rows. In a build
 * its probability over the picks' median scales the chosen set's grain (setFitGrain, material-sets.ts), in place of the
 * hand-set tile and energy caps: a set the finished buildings say rarely fits a class like this one is drawn at its
 * finish with little of its pattern.
 */

import * as fs from 'fs';
import * as path from 'path';

export const SET_FIT_VERSION = 'material-set-fit/1';
export const SET_FIT_MODEL_FILE = path.join('assets', 'textures', 'library', 'set-fit-model.json');

/** A class as the regressor sees it (from a finished twin). */
export interface SetFitClass {
    meanLab: [number, number, number];
    openings?: boolean;
    /** Texture energy per band (material-harvest.ts TEXTURE_BANDS_M) as the photos show it. */
    photoEnergy?: number[];
    /** Median shorter side (m) of the repeated element the class holds (material-regions.ts classRepeatSizes). */
    repeatM?: number;
    /** The vision model's finish read (material-finish.ts), when confident. */
    read?: { roughness: number; metalness: number };
}

/** A candidate set as the regressor sees it (from the library's measured statistics and its preview). */
export interface SetFitCandidate {
    /** Its place in the ranking's order (0 the nearest). */
    rank: number;
    colourLab?: [number, number, number];
    roughness?: number; metallic?: number; normalTiltDeg?: number;
    tileM?: [number, number];
    /** Texture energy per band at the class's texel and the set's real size (material-harvest.ts libraryTextureEnergy). */
    energy?: number[];
}

export const SET_FIT_FEATURES = [
    'rank', 'dL', 'dChroma', 'classL', 'openings',
    'energyLog0', 'energyLog1', 'energyLog2', 'energyAbs', 'energyKnown',
    'tileOverRepeat', 'repeatKnown',
    'setRoughness', 'setMetallic', 'setTilt',
    'readRoughnessGap', 'readMetalGap', 'readKnown'
] as const;

const log = (v: number) => Math.log(Math.max(1e-6, v));

/** The features of a class and a candidate, in SET_FIT_FEATURES' order (a missing measurement 0, with its known flag 0). */
export function setFitFeatures(c: SetFitClass, s: SetFitCandidate): number[] {
    const lab = s.colourLab;
    const dL = lab ? Math.abs(lab[0] - c.meanLab[0]) : 0, dC = lab ? Math.hypot(lab[1] - c.meanLab[1], lab[2] - c.meanLab[2]) : 0;
    const e: number[] = [0, 0, 0];
    let known = 0;
    if (c.photoEnergy && s.energy) for (let b = 0; b < 3; b++) if (Number.isFinite(c.photoEnergy[b]) && Number.isFinite(s.energy[b])) { e[b] = log(s.energy[b]) - log(c.photoEnergy[b]); known = 1; }
    const tile = s.tileM ? Math.max(s.tileM[0], s.tileM[1]) : 0;
    const repeat = c.repeatM && c.repeatM > 0 && tile > 0 ? Math.log(tile / c.repeatM) : 0;
    return [
        Math.log1p(s.rank), dL / 10, dC / 10, c.meanLab[0] / 100, c.openings ? 1 : 0,
        e[0], e[1], e[2], (Math.abs(e[0]) + Math.abs(e[1]) + Math.abs(e[2])) / 3, known,
        repeat, c.repeatM && tile ? 1 : 0,
        s.roughness ?? 0.7, s.metallic ?? 0, (s.normalTiltDeg ?? 5) / 10,
        c.read ? Math.abs((s.roughness ?? 0.7) - c.read.roughness) : 0, c.read ? Math.abs((s.metallic ?? 0) - c.read.metalness) : 0, c.read ? 1 : 0
    ];
}

export interface SetFitModel {
    version: string;
    features: string[];
    mean: number[]; scale: number[]; weights: number[]; bias: number;
    /** What it was fitted on and how it scored on buildings it never saw (leave-one-building-out). */
    trainedOn: { rows: number; classes: number; buildings: number; atIso: string };
    heldOut?: { top1: number; rankTop1: number; auc: number; buildings: number };
    /** The median probability it gives the candidates the pick confirmed: a set at or above it is drawn with all its grain (setFitGrain). */
    pickedMedian: number;
}

/** The share of a set's grain the model allows: its probability over the picks' median, capped at 1. */
export function setFitGrain(m: SetFitModel, c: SetFitClass, s: SetFitCandidate): number {
    return Math.max(0, Math.min(1, predictSetFit(m, c, s) / Math.max(1e-6, m.pickedMedian)));
}

const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));

/** The probability that the set fits the class (0..1). */
export function predictSetFit(m: SetFitModel, c: SetFitClass, s: SetFitCandidate): number {
    const x = setFitFeatures(c, s);
    let z = m.bias;
    for (let i = 0; i < x.length; i++) z += m.weights[i] * ((x[i] - m.mean[i]) / m.scale[i]);
    return sigmoid(z);
}

/** The committed model, when its version and features match this code; none otherwise (the build then goes without it). */
export function loadSetFitModel(repoRoot: string): SetFitModel | undefined {
    try {
        const m = JSON.parse(fs.readFileSync(path.join(repoRoot, SET_FIT_MODEL_FILE), 'utf8')) as SetFitModel;
        return m.version === SET_FIT_VERSION && m.features.join() === SET_FIT_FEATURES.join() ? m : undefined;
    } catch { return undefined; }
}

/**
 * A logistic regression on standardised features, by full-batch gradient descent with an L2 penalty: rows x (features),
 * y (0..1, the pick's confidence for the picked candidate, else 0) and weight w. Deterministic.
 */
export function fitSetFit(rows: Array<{ x: number[]; y: number; w: number }>, opts: { l2?: number; iterations?: number; rate?: number } = {}): Pick<SetFitModel, 'mean' | 'scale' | 'weights' | 'bias'> {
    const F = SET_FIT_FEATURES.length, n = rows.length, l2 = opts.l2 ?? 0.01, its = opts.iterations ?? 3000, rate = opts.rate ?? 0.5;
    const mean = new Array<number>(F).fill(0), scale = new Array<number>(F).fill(0);
    for (const r of rows) for (let i = 0; i < F; i++) mean[i] += r.x[i] / n;
    for (const r of rows) for (let i = 0; i < F; i++) scale[i] += (r.x[i] - mean[i]) ** 2 / n;
    // a feature constant over the rows (its spread under 1e-9, float noise included) is left unscaled
    for (let i = 0; i < F; i++) scale[i] = Math.sqrt(scale[i]) > 1e-9 ? Math.sqrt(scale[i]) : 1;
    const X = rows.map(r => r.x.map((v, i) => (v - mean[i]) / scale[i])), W = rows.reduce((a, r) => a + r.w, 0) || 1;
    const w = new Array<number>(F).fill(0);
    let b = 0;
    for (let it = 0; it < its; it++) {
        const g = new Array<number>(F).fill(0);
        let gb = 0;
        for (let k = 0; k < n; k++) {
            let z = b;
            for (let i = 0; i < F; i++) z += w[i] * X[k][i];
            const e = (sigmoid(z) - rows[k].y) * rows[k].w;
            gb += e;
            for (let i = 0; i < F; i++) g[i] += e * X[k][i];
        }
        b -= (rate * gb) / W;
        for (let i = 0; i < F; i++) w[i] -= rate * (g[i] / W + l2 * w[i]);
    }
    const r6 = (v: number) => Math.round(v * 1e6) / 1e6;
    return { mean: mean.map(r6), scale: scale.map(r6), weights: w.map(r6), bias: r6(b) };
}
