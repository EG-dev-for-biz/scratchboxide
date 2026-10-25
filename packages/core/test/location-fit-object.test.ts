/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * location_fit_object on synthetic clusters (no native audit, no network): a slender constant-section vertical member
 * classifies as a single sweep candidate, a slender periodic one as a radial bundle, and a short or horizontal one as
 * neither. The tool wrapper reads a hand-written residual_audit.json, same shape runFitObjectTool reads in the app.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { fitObjectFromCluster, runFitObjectTool, FitObjectToolError } from '../src/node/gemini/tools/location-evidence/fit-object';
import type { AuditedCluster, ResidualAuditResult } from '../src/node/3d-engine/staged-location/residual-audit';

/** A minimal AuditedCluster: a vertical member from y=0 to y=heightM, slices spaced 0.5 m apart. */
function member(opts: {
    id?: number; heightM: number; radiusM: number; wobbleM?: number; verticality?: number; crossSectionConstancy?: number; periodicity?: number; periodM?: number; radialSymmetry?: number; verdict?: AuditedCluster['verdict'];
}): AuditedCluster {
    const { id = 1, heightM, radiusM, wobbleM = 0, verticality = 0.95, crossSectionConstancy = 0.8, periodicity = 0.1, periodM = 0, radialSymmetry = 0.6, verdict = 'real-object' } = opts;
    const slices: AuditedCluster['slices'] = [];
    for (let y = 0; y <= heightM; y += 0.5) slices.push({ y, cx: Math.sin(y) * wobbleM, cz: Math.cos(y) * wobbleM, r: radiusM, rmsRel: 0.05, sectors: 8, size: 10, points: 40 });
    const zero3: [number, number, number] = [0, 0, 0];
    return {
        id, triangles: 200, areaM2: 2 * Math.PI * radiusM * heightM, lo: [-radiusM, 0, -radiusM], hi: [radiusM, heightM, radiusM],
        frame: { origin: zero3, xAxis: [1, 0, 0], yAxis: [0, 1, 0], zAxis: [0, 0, 1], extentsM: [radiusM * 2, heightM, radiusM * 2] },
        principal: { axes: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], extentsM: [radiusM * 2, heightM, radiusM * 2] },
        shape: { thinness: 0.1, elongation: 1, mainAxisVerticality: verticality, sheetNormalVerticality: 0 },
        surface: { qualityMedian: 0.8, sliverShare: 0, maxEdgeM: 0.2, normalCoherence: 0.5, upShare: 0.1, downShare: 0, sideShare: 0.9, boundaryEdgeShare: 0.1, copyShare: 0 },
        volume: { envelopeM3: Math.PI * radiusM * radiusM * heightM, boxM3: radiusM * 2 * radiusM * 2 * heightM, fill: 0.7, cellM: 0.25 },
        attachment: {
            minGapToSolidM: 0, medianGapToSolidM: 0, contactShare: 0.1, contactAlongShare: 0, insideShare: 0, gapToGroundM: 0, footprintCells: 4, groundedShare: 0.5, enclosedShare: 0, openBelowShare: 0.4,
            overhangShare: 0, medianDropM: 0, maxDropM: 1, supportY: 0, baseAboveSupportM: 0, topAboveSupportM: heightM, baseAboveGroundM: 0, topAboveGroundM: heightM
        },
        symmetry: { radialSymmetry, radiusMedianM: radiusM, slicesUsed: slices.length, crossSectionConstancy, periodicity, periodM },
        slices, photo: null, triangleIds: [],
        verdict, confidence: 0.8, reason: 'synthetic fixture', scores: { spike: 0, sliver: 0, floating: 0, curtain: 0, offset: 0, sky: 0, artefact: 0, real: 0.8 },
        skyShare: null, typeLabels: [],
        feature: { schema: 'sb-feature/1', id: `residual/${id}`, types: [], typeLabels: [], description: '', geometry: { boundingBox: { lo: [-radiusM, 0, -radiusM], hi: [radiusM, heightM, radiusM], frame: 'tile' } }, measurements: {}, provenance: { label: 'measured', confidence: 0.8, sources: [], method: '' }, frame: { kind: 'local', origin: zero3, xAxis: [1, 0, 0], yAxis: [0, 1, 0], zAxis: [0, 0, 1], parent: 'tile' } } as AuditedCluster['feature']
    };
}

describe('location_fit_object', () => {
    it('a slender, constant-section, vertical, non-periodic member reads as a single sweep candidate', () => {
        const c = member({ heightM: 6, radiusM: 0.15, verticality: 0.95, crossSectionConstancy: 0.85, periodicity: 0.05 });
        const fit = fitObjectFromCluster(c);
        expect(fit.kind).toBe('single-member');
        expect(fit.confidence).toBeGreaterThan(0.3);
        expect(fit.measured.carrier.length).toBeGreaterThan(5);
        expect(fit.pythonScript).toMatch(/sweep_curve_profile/);
        expect(fit.pythonScript).toMatch(/^import scratchbox as sb$/m);
        expect(fit.pythonScript).not.toMatch(/replicate_metric_array/);
        expect(fit.estimated).toBeUndefined();
    });

    it('a slender, periodic, vertical member reads as a radial bundle, with estimated (not measured) member count/radius', () => {
        const c = member({ heightM: 8, radiusM: 1.2, verticality: 0.9, crossSectionConstancy: 0.4, periodicity: 0.55, periodM: 0.9, radialSymmetry: 0.5 });
        const fit = fitObjectFromCluster(c);
        expect(fit.kind).toBe('bundle');
        expect(fit.pythonScript).toMatch(/replicate_metric_array/);
        expect(fit.pythonScript).toMatch(/pitch_meters=0\.9/);
        expect(fit.pythonScript).toMatch(/^import scratchbox as sb$/m);
        expect(fit.estimated).toBeDefined();
        expect(fit.estimated!.memberCountGuess).not.toBeNull();
        expect(fit.estimated!.memberCountGuess!).toBeGreaterThanOrEqual(2);
    });

    it('a short, squat or non-vertical cluster is not a sweep candidate', () => {
        const squat = member({ heightM: 0.5, radiusM: 1, verticality: 0.95, crossSectionConstancy: 0.8 });
        expect(fitObjectFromCluster(squat).kind).toBe('none');
        const leaning = member({ heightM: 6, radiusM: 0.15, verticality: 0.3, crossSectionConstancy: 0.8 });
        expect(fitObjectFromCluster(leaning).kind).toBe('none');
    });

    it('reports "none" with a reason, not a crash, when there are too few valid slices', () => {
        const c = member({ heightM: 6, radiusM: 0.15 });
        c.slices = [c.slices[0]];
        const fit = fitObjectFromCluster(c);
        expect(fit.kind).toBe('none');
        expect(fit.pythonScript).toBeUndefined();
        expect(fit.reason).toMatch(/too few/);
    });

    describe('runFitObjectTool', () => {
        const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fit-object-'));
        function writeResult(dir: string, clusters: AuditedCluster[]): string {
            const result: ResidualAuditResult = {
                schema: 'scratchbox.residual-audit-result/1', version: 'test', sources: [], candidateTriangles: 0, solidTriangles: 0, groundY: 0,
                params: {} as ResidualAuditResult['params'], thresholds: {} as ResidualAuditResult['thresholds'], clusters,
                counts: { clusters: clusters.length, realObjects: clusters.filter(c => c.verdict === 'real-object').length, artefacts: clusters.filter(c => c.verdict === 'scan-artefact').length, unsure: 0, removedTriangles: 0, keptTriangles: 0, removedAreaM2: 0 },
                candidates: clusters.filter(c => c.verdict === 'real-object').map(c => c.id), notes: [], ms: 0, dataNote: 'test fixture'
            };
            const file = path.join(dir, 'residual_audit.json');
            fs.writeFileSync(file, JSON.stringify(result));
            return file;
        }

        it('fits a real-object cluster by id, from a result JSON on disk', async () => {
            const dir = tmp();
            const file = writeResult(dir, [member({ id: 7, heightM: 6, radiusM: 0.15, crossSectionConstancy: 0.85, periodicity: 0.05 })]);
            const { summary, payload } = await runFitObjectTool({ resultJson: file, clusterId: 7 }, dir);
            expect(summary).toMatch(/cluster 7/);
            expect(payload.kind).toBe('single-member');
        });

        it('refuses a scan-artefact cluster rather than fit it', async () => {
            const dir = tmp();
            const file = writeResult(dir, [member({ id: 3, heightM: 6, radiusM: 0.15, verdict: 'scan-artefact' })]);
            await expect(runFitObjectTool({ resultJson: file, clusterId: 3 }, dir)).rejects.toThrow(FitObjectToolError);
            await expect(runFitObjectTool({ resultJson: file, clusterId: 3 }, dir)).rejects.toMatchObject({ code: 'not_real' });
        });

        it('errors clearly on an unknown cluster id or a missing result file', async () => {
            const dir = tmp();
            const file = writeResult(dir, [member({ id: 1, heightM: 6, radiusM: 0.15 })]);
            await expect(runFitObjectTool({ resultJson: file, clusterId: 99 }, dir)).rejects.toMatchObject({ code: 'no_cluster' });
            await expect(runFitObjectTool({ resultJson: path.join(dir, 'nope.json'), clusterId: 1 }, dir)).rejects.toMatchObject({ code: 'not_found' });
        });
    });
});
