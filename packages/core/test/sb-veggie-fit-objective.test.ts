/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildNativeIfStale } from '../src/node/3d-engine/native-build';
import { NativeCppCompilerService } from '../src/node';

/**
 * SbVeggieOptimizer's fit objective must prefer the parameters that generated a scan. The scans here are surface
 * samples (wood + leaf cards, 2 cm noise) of trees generated from random parameters, so the true parameters are known.
 */
const PROBE = String.raw`
#include "scratchbox_sb_veggie_optimizer.hpp"
#include <cstdio>
#include <random>
using namespace scratchbox::math;
using namespace scratchbox::geometry;
using namespace scratchbox::sb_veggie;

static std::vector<Vec3> sample(const ScratchboxMesh& m, int n, unsigned seed, float noise) {
    std::vector<double> cdf; double tot = 0;
    for (size_t t = 0; t + 2 < m.indices.size(); t += 3) {
        Vec3 a = m.vertices[m.indices[t]].position, b = m.vertices[m.indices[t + 1]].position, c = m.vertices[m.indices[t + 2]].position;
        tot += 0.5 * (b - a).cross(c - a).length(); cdf.push_back(tot);
    }
    std::mt19937 rng(seed); std::uniform_real_distribution<double> uT(0, tot); std::uniform_real_distribution<float> u(0, 1);
    std::normal_distribution<float> nz(0.0f, noise);
    std::vector<Vec3> out;
    for (int i = 0; i < n; ++i) {
        size_t k = std::min<size_t>(std::lower_bound(cdf.begin(), cdf.end(), uT(rng)) - cdf.begin(), cdf.size() - 1);
        Vec3 a = m.vertices[m.indices[3 * k]].position, b = m.vertices[m.indices[3 * k + 1]].position, c = m.vertices[m.indices[3 * k + 2]].position;
        float r1 = std::sqrt(u(rng)), r2 = u(rng);
        out.push_back(a * (1 - r1) + b * (r1 * (1 - r2)) + c * (r1 * r2) + Vec3(nz(rng), nz(rng), nz(rng)));
    }
    return out;
}

static double meanDist(const std::vector<Vec3>& a, const std::vector<Vec3>& b) {
    double acc = 0;
    for (auto& x : a) { float m = 1e30f; for (auto& y : b) m = std::min(m, (x - y).lengthSquared()); acc += std::sqrt(m); }
    return acc / a.size();
}

int main() {
    SbVeggieTemplate tmpl = SbVeggieModelBuilder::buildCanonicalTemplate();
    std::mt19937 rng(17);
    std::uniform_real_distribution<float> beta(-1.5f, 1.5f), az(-0.45f, 0.45f), el(-0.35f, 0.35f), re(0.65f, 1.45f);
    std::normal_distribution<float> nrm(0.0f, 1.0f);
    std::printf("[");
    for (int k = 0; k < 12; ++k) {
        SbVeggieParams gt = SbVeggieParams::createNeutral();
        for (int i = 0; i < 8; ++i) gt.beta[i] = beta(rng);
        for (int i = 0; i < 8; ++i) gt.scaffoldIK[i] = SbVeggieScaffoldIK{az(rng), el(rng), re(rng)};
        SbVeggieParams wrong = gt;
        for (int i = 0; i < 8; ++i) wrong.beta[i] = std::clamp(gt.beta[i] + 0.5f * nrm(rng), -3.0f, 3.0f);
        for (int i = 0; i < 8; ++i) {
            wrong.scaffoldIK[i].azimuthOffset = std::clamp(gt.scaffoldIK[i].azimuthOffset + 0.15f * nrm(rng), -0.45f, 0.45f);
            wrong.scaffoldIK[i].elevationOffset = std::clamp(gt.scaffoldIK[i].elevationOffset + 0.12f * nrm(rng), -0.35f, 0.35f);
            wrong.scaffoldIK[i].reachScale = std::clamp(gt.scaffoldIK[i].reachScale + 0.15f * nrm(rng), 0.65f, 1.45f);
        }
        ScratchboxMesh mesh = SbVeggieEvaluator::evaluate(tmpl, gt, true);
        auto scan = sample(mesh, 200, 100 + k, 0.02f);
        auto truth = sample(mesh, 1500, 900 + k, 0.0f);
        const Vec3 origin(0, 0, 0);
        auto fit = SbVeggieOptimizer::fitToScan(scan, tmpl, SbVeggieOptimizerOptions(), &origin);
        auto surface = [&](const SbVeggieParams& p) { return sample(SbVeggieEvaluator::evaluate(tmpl, p, true), 1500, 5, 0.0f); };
        auto fitSurface = surface(fit.fittedParams), neutralSurface = surface(SbVeggieParams::createNeutral());
        std::printf("%s{\"gt\":%g,\"wrong\":%g,\"fit\":%g,\"heldOutFitM\":%g,\"heldOutNeutralM\":%g}", k ? "," : "",
            SbVeggieOptimizer::evaluateChamferDistance(gt, tmpl, scan),
            SbVeggieOptimizer::evaluateChamferDistance(wrong, tmpl, scan),
            SbVeggieOptimizer::evaluateChamferDistance(fit.fittedParams, tmpl, scan),
            0.5 * (meanDist(truth, fitSurface) + meanDist(fitSurface, truth)),
            0.5 * (meanDist(truth, neutralSurface) + meanDist(neutralSurface, truth)));
    }
    std::printf("]\n");
}
`;

interface Case { gt: number; wrong: number; fit: number; heldOutFitM: number; heldOutNeutralM: number }

describe('SB-Veggie fit objective', () => {
    let dir = '';
    let cases: Case[] = [];

    beforeAll(async () => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-veggie-objective-'));
        const source = path.join(dir, 'probe.cpp');
        fs.writeFileSync(source, PROBE);
        const binary = await buildNativeIfStale({
            source,
            binary: path.join(dir, 'probe'),
            includeDir: new NativeCppCompilerService().getSdkIncludePath()
        });
        cases = JSON.parse(execFileSync(binary, { encoding: 'utf8', timeout: 240000 }));
    }, 600000);

    afterAll(() => {
        if (dir) fs.rmSync(dir, { recursive: true, force: true });
    });

    it('scores the generating parameters better than perturbed ones on every scan', () => {
        expect(cases.length).toBe(12);
        for (const c of cases) expect(c.gt).toBeLessThan(c.wrong);
    });

    it('has its minimum near the generating parameters: they score at least as well as the fit on most scans', () => {
        const gtAtLeastAsGood = cases.filter(c => c.gt <= c.fit).length;
        expect(gtAtLeastAsGood).toBeGreaterThanOrEqual(10);
    });

    it('fits a tree whose real surface is closer to the scanned tree than the neutral tree is', () => {
        const mean = (k: keyof Case) => cases.reduce((s, c) => s + c[k], 0) / cases.length;
        expect(mean('heldOutFitM')).toBeLessThan(0.75 * mean('heldOutNeutralM'));
    });
});
