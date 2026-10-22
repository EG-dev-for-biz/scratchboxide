/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Revolution fit on synthetic scans with a known truth: a ribbed dome on a drum with a cornice ring and a lantern, standing
 * on a flat roof beside a plain box building, its surface dented by smooth blobs and per-vertex noise as a coarse scan is.
 * The native tool must find the dome from its sections alone (not the box), recover the axis and the profile, find the 12
 * ribs as a periodic modulation, stack the lantern as its own revolution, and rebuild a surface that keeps none of the
 * dents. A plain noisy dome must come back with no ribs at all.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { cutRevolutionsFromGlb, revolutionColourAtlas, revolutionCutMask, runRevolutionFit, writeRevolutionsGlb, type RevolutionFitRun } from '../src/node/3d-engine/staged-location/revolution-fit';
import { writeStagedGlbFile } from '../src/node/3d-engine/staged-location/staged-glb-writer';
import { askRevolutionReference, referenceConsensus, referenceDetailLine, type ReferenceClient } from '../src/node/3d-engine/staged-location/revolution-reference';
import { readGlbTriangles } from './helpers/clay-glb-render';
import { AXIS, DOME, DRUM, LANTERN, MAST, RIBS, RING, ROOF_Y, domeR, syntheticScan } from './helpers/synthetic-dome';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'revolution-fit-'));

describe('revolution fit (synthetic dome with a lantern and 12 ribs)', () => {
    let run: RevolutionFitRun;
    let scan: ReturnType<typeof syntheticScan>;

    it('finds the dome from its sections alone (not the box beside it) and recovers its axis and profile', async () => {
        scan = syntheticScan({ ribs: true, lantern: true, seed: 7 });
        run = await runRevolutionFit(scan, tmp());
        const acc = run.report.revolutions.filter(r => r.accepted);
        expect(acc.length, JSON.stringify(run.report.revolutions.map(r => [r.plan, r.reason]))).toBe(1);
        const r = acc[0];
        // axis
        expect(Math.hypot(r.axis.x - AXIS.x, r.axis.z - AXIS.z)).toBeLessThan(0.1);
        expect(r.axis.errM).toBeLessThan(0.15);
        expect(r.axis.tiltDeg).toBeLessThan(2);
        // the box building is a summit but no round stack
        expect(run.report.revolutions.some(x => x.plan.x > AXIS.x + 20 && x.accepted)).toBe(false);
        // profile: the drum, the ring standing proud of it, the dome cap
        const s0 = r.stacks[0];
        const cap = s0.cap!;
        expect(cap).not.toBeNull();
        expect(Math.abs(cap.R0 - DOME.R0) / DOME.R0).toBeLessThan(0.05);
        expect(Math.abs(cap.y0 - DOME.y0)).toBeLessThan(0.5);
        expect(Math.abs(cap.H - DOME.H) / DOME.H).toBeLessThan(0.12);
        // an ellipse family member: the fitted meridian stays within 15 cm of the true one over the cap's lower 85%
        for (let t = 0; t <= 0.85; t += 0.05) {
            const y = DOME.y0 + t * DOME.H;
            const tc = (y - cap.y0) / cap.H;
            const rc = cap.R0 * Math.pow(Math.max(0, 1 - Math.pow(tc, cap.q)), 1 / cap.p) * (1 + cap.b * 4 * tc * (1 - tc));
            expect(Math.abs(rc - domeR(y, 0, false)), `cap at t=${t.toFixed(2)}`).toBeLessThan(0.15);
        }
        const drum = s0.bands.find(b => b.y1 - b.y0 > 2);
        expect(drum, JSON.stringify(s0.bands)).toBeDefined();
        expect(Math.abs((drum!.r0 + drum!.r1) / 2 - DRUM.r)).toBeLessThan(0.15);
        const ring = s0.bands.find(b => (b.r0 + b.r1) / 2 > DRUM.r + 0.3);
        expect(ring, JSON.stringify(s0.bands)).toBeDefined();
        expect(Math.abs((ring!.r0 + ring!.r1) / 2 - RING.r)).toBeLessThan(0.2);
        expect(ring!.y1 - ring!.y0).toBeLessThan(1.2);
        // the lantern: a second revolution stacked above the cap
        expect(r.stacks.length).toBeGreaterThanOrEqual(2);
        const s1 = r.stacks[1];
        const lr = s1.bands.length ? (s1.bands[0].r0 + s1.bands[0].r1) / 2 : s1.cap!.R0;
        expect(Math.abs(lr - LANTERN.r)).toBeLessThan(0.25);
        expect(s1.yTop).toBeGreaterThan(LANTERN.y1 + 0.5);
    }, 180_000);

    it('detects the 12 ribs as a periodic modulation of the cap', () => {
        const r = run.report.revolutions.find(x => x.accepted)!;
        const m = r.stacks[0].capModulation;
        expect(m.K, JSON.stringify(m)).toBe(RIBS.K);
        expect(m.significance).toBeGreaterThan(4);
        // phase: a rib crest at theta = 0 (cos(12 theta) = 1)
        const crest = m.harmonics.reduce((a, [k, ca, cb]) => a + ca * Math.cos(k * 0) + cb * Math.sin(k * 0), 0);
        const trough = m.harmonics.reduce((a, [k, ca, cb]) => a + ca * Math.cos(k * Math.PI / 12) + cb * Math.sin(k * Math.PI / 12), 0);
        expect(crest).toBeGreaterThan(trough);
        // the drum carries no ribs of its own
        expect(r.stacks[0].bandModulation.K === 0 || r.stacks[0].bandModulation.K === RIBS.K).toBe(true);
    });

    it('rebuilds a surface that keeps the ribs and none of the dents', () => {
        const r = run.report.revolutions.find(x => x.accepted)!;
        const mesh = run.meshes.find(m => m.id === r.id)!;
        expect(mesh.indices.length).toBeGreaterThan(3000);
        // every rebuilt vertex on the dome (clear of the ring and the lantern) against the true ribbed surface
        let ss = 0, n = 0, worst = 0;
        for (let v = 0; v < mesh.positions.length / 3; v++) {
            const x = mesh.positions[v * 3], y = mesh.positions[v * 3 + 1], z = mesh.positions[v * 3 + 2];
            if (y < DOME.y0 + 0.4 || y > DOME.y0 + 0.75 * DOME.H) continue;
            const th = Math.atan2(z - AXIS.z, x - AXIS.x);
            const d = Math.hypot(x - AXIS.x, z - AXIS.z) - domeR(y, th, true);
            ss += d * d; n++; worst = Math.max(worst, Math.abs(d));
        }
        const rms = Math.sqrt(ss / n);
        // the scan's own departure from the truth (dents + noise) is several times larger than the rebuild's
        expect(scan.noiseRms).toBeGreaterThan(0.08);
        expect(rms, `rebuilt RMS ${rms.toFixed(3)} vs scan noise ${scan.noiseRms.toFixed(3)}`).toBeLessThan(0.5 * scan.noiseRms);
        expect(worst).toBeLessThan(0.3);
        // the fit's own residual against the scan reflects the dents, honestly
        expect(r.fit.rmsM).toBeGreaterThan(0.05);
        expect(r.fit.within25cm).toBeGreaterThan(0.7);
        // a closed, outward-facing solid: the signed volume is positive and near the true one
        let vol = 0;
        for (let t = 0; t < mesh.indices.length; t += 3) {
            const a = mesh.indices[t] * 3, b = mesh.indices[t + 1] * 3, c = mesh.indices[t + 2] * 3;
            const P = mesh.positions;
            vol += (P[a] * (P[b + 1] * P[c + 2] - P[b + 2] * P[c + 1]) - P[a + 1] * (P[b] * P[c + 2] - P[b + 2] * P[c]) + P[a + 2] * (P[b] * P[c + 1] - P[b + 1] * P[c])) / 6;
        }
        const trueVol = Math.PI * DRUM.r ** 2 * (DRUM.y1 - DRUM.y0) + Math.PI * RING.r ** 2 * (RING.y1 - RING.y0) + (2 / 3) * Math.PI * DOME.R0 ** 2 * DOME.H;
        expect(vol).toBeGreaterThan(0.85 * trueVol);
        expect(vol).toBeLessThan(1.25 * trueVol);
    });

    it('cuts the scan inside the rebuilt solid and nothing outside it, and writes a labelled GLB', () => {
        const keep = revolutionCutMask(run.report.revolutions, scan.positions, scan.indices);
        let cutDome = 0, cutElsewhere = 0;
        for (let t = 0; t < keep.length; t++) {
            if (keep[t]) continue;
            const a = scan.indices[t * 3] * 3;
            const x = scan.positions[a], y = scan.positions[a + 1], z = scan.positions[a + 2];
            if (Math.hypot(x - AXIS.x, z - AXIS.z) < 7.8 && y > ROOF_Y) cutDome++; else cutElsewhere++;
        }
        expect(cutDome).toBeGreaterThan(5000);
        expect(cutElsewhere).toBe(0);
        const dir = tmp();
        const out = writeRevolutionsGlb(path.join(dir, 'rev.glb'), run);
        const buf = fs.readFileSync(out.path);
        expect(buf.readUInt32LE(0)).toBe(0x46546c67);
        const json = JSON.parse(buf.toString('utf8', 20, 20 + buf.readUInt32LE(12)));
        const extras = json.nodes.find((n: any) => n.extras?.provenance)?.extras;
        expect(extras.provenance).toBe('generated');
        expect(extras.fit.rmsM).toBeCloseTo(run.report.revolutions.find(x => x.accepted)!.fit.rmsM, 5);
        expect(extras.confidence).toBeGreaterThan(0.5);
    });

    it('cuts the same volume out of a GLB layer, and colours each height from the photo around it', () => {
        const dir = tmp();
        const f = path.join(dir, 'scan.glb');
        writeStagedGlbFile(f, [{ name: 'scan', positions: scan.positions, indices: scan.indices }]);
        const before = readGlbTriangles(fs.readFileSync(f)).indices.length / 3;
        const cut = cutRevolutionsFromGlb(fs.readFileSync(f), run.report.revolutions);
        const after = readGlbTriangles(cut.glb).indices.length / 3;
        const mask = revolutionCutMask(run.report.revolutions, scan.positions, scan.indices);
        expect(cut.removedTriangles).toBe(mask.length - mask.reduce((a, b) => a + b, 0));
        expect(after).toBe(before - cut.removedTriangles);
        // a photo that is red above 18 m and blue below: the atlas column reads red at the top rows, blue at the bottom
        const atlas = revolutionColourAtlas(run, { sample: (p: readonly number[]) => ({ rgb: p[1] > 18 ? [200, 30, 30] : [30, 30, 200], distanceM: 0.1, cosNormal: 1 }) as any });
        expect(atlas.sampledShare).toBeGreaterThan(0.8);
        const px = (row: number) => Array.from(atlas.rgb.subarray((row * atlas.width + 1) * 3, (row * atlas.width + 1) * 3 + 3));
        expect(px(5)).toEqual([200, 30, 30]);
        expect(px(atlas.height - 5)).toEqual([30, 30, 200]);
        const mesh = run.meshes[0], uv = atlas.uv.get(mesh.id)!;
        for (let v = 0; v < mesh.positions.length / 3; v += 97) {
            const row = Math.min(atlas.height - 1, Math.floor(uv[v * 2 + 1] * atlas.height));
            if (Math.abs(mesh.positions[v * 3 + 1] - 18) < 0.5) continue;
            expect(px(row)[0] > 100).toBe(mesh.positions[v * 3 + 1] > 18);
        }
    });

    it('reads the 12 ribs as narrow raised ribs on a smooth shell, not a sinusoidal swing', () => {
        const m = run.report.revolutions.find(x => x.accepted)!.stacks[0].capModulation;
        expect(m.shape.bumpAmp, JSON.stringify(m.shape)).toBeGreaterThan(0);
        expect(m.shape.cosAmp).toBe(0);
        expect(m.shape.facetAmp).toBe(0);
        expect(m.shape.bumpCentre).toBe(0);
        // the true rib: cos^6 of 12 theta, e^-1 of its crest at 0.56 rad of phase: a width of 0.18 of half a period
        expect(m.shape.bumpWidth).toBeGreaterThan(0.1);
        expect(m.shape.bumpWidth).toBeLessThan(0.3);
        expect(m.shape.bumpAmp).toBeGreaterThan(0.5 * RIBS.ampRel);
        expect(m.shape.bumpAmp).toBeLessThan(1.5 * RIBS.ampRel);
    });

    it('reads flat facets as facets with sharp corners, and stands a thin mast on the lantern as a pole, not a cap', async () => {
        const scanF = syntheticScan({ ribs: false, lantern: true, seed: 5, facets: 8, mast: true });
        const runF = await runRevolutionFit(scanF, tmp());
        const r = runF.report.revolutions.filter(x => x.accepted);
        expect(r.length).toBe(1);
        const m = r[0].stacks[0].capModulation;
        expect(m.K, JSON.stringify(m)).toBe(8);
        // the flat-facet family, or a cusp-edged bump (exponent at most 1.5) where it fits better: a corner, not a lobe
        expect(m.shape.cosAmp).toBe(0);
        expect(m.shape.facetAmp > 0 || (m.shape.bumpAmp > 0 && m.shape.bumpExponent <= 1.5), JSON.stringify(m.shape)).toBe(true);
        // the rebuilt surface follows the true facets
        const mesh = runF.meshes[0];
        let ss = 0, n = 0;
        for (let v = 0; v < mesh.positions.length / 3; v++) {
            const x = mesh.positions[v * 3], y = mesh.positions[v * 3 + 1], z = mesh.positions[v * 3 + 2];
            if (y < DOME.y0 + 0.4 || y > DOME.y0 + 0.75 * DOME.H) continue;
            const th = Math.atan2(z - AXIS.z, x - AXIS.x);
            const d = Math.hypot(x - AXIS.x, z - AXIS.z) - domeR(y, th, false, 8);
            ss += d * d; n++;
        }
        expect(Math.sqrt(ss / n)).toBeLessThan(0.6 * scanF.noiseRms);
        // the mast: the last stack, bands only (no cap invented on it), at the measured radius and height
        const stacks = r[0].stacks;
        const mast = stacks[stacks.length - 1];
        expect(mast.bandsOnly, JSON.stringify(stacks.map(s => [s.bandsOnly, s.mastAbove, s.slenderness, s.cap]))).toBe(true);
        expect(mast.cap).toBeNull();
        const mr = mast.bands.reduce((a, b) => a + (b.r0 + b.r1) / 2, 0) / mast.bands.length;
        expect(Math.abs(mr - MAST.r)).toBeLessThan(0.12);
        expect(Math.abs(mast.yTop - MAST.y1)).toBeLessThan(0.5);
        expect(mast.slenderness).toBeGreaterThan(8);
        // the lantern's cap is cut flat where the mast stands
        const lantern = stacks[stacks.length - 2];
        expect(lantern.mastAbove).toBe(true);
        expect(lantern.cap!.cut).toBeLessThan(MAST.y1 - 1);
        expect(lantern.cap!.cut).toBeGreaterThan(LANTERN.y1);
    }, 180_000);

    it('adds ribs the scan cannot resolve only from what search-grounded references agree on, labelled as such', async () => {
        const plain = syntheticScan({ ribs: false, lantern: false, seed: 11 });
        const first = await runRevolutionFit(plain, tmp());
        const r = first.report.revolutions.find(x => x.accepted)!;
        // three answers (a fake client: tests never bill): raised ribs agreed, counts disagree (32, 20, 64)
        const said = [{ ribCount: 32, ribsRaised: true, lanternHasFinial: true }, { ribCount: 28, ribsRaised: true, lanternHasFinial: true }, { ribCount: 64, ribsRaised: true, ribWidthM: 0.2, ribHeightM: 0.1, lanternHasFinial: true }];
        let call = 0;
        const client: ReferenceClient = { models: { generateContent: async (p: any) => {
            expect(p.config.tools).toEqual([{ googleSearch: {} }]);
            const a = said[call++];
            return { candidates: [{ content: { parts: [{ text: '```json\n' + JSON.stringify({ ...a, evidence: 'test' }) + '\n```' }] }, groundingMetadata: { webSearchQueries: ['dome ribs'], groundingChunks: [{ web: { uri: 'https://example.org/dome' } }] } }] } as any;
        } } };
        const answers = await askRevolutionReference(client, ['m1', 'm2', 'm1'], 'prompt');
        expect(answers.map(a => a.ribCount)).toEqual([32, 28, 64]);
        expect(answers[0].queries).toEqual(['dome ribs']);
        const ref = referenceConsensus(answers, r);
        expect(ref.agreed.ribsRaised).toBe(true);
        expect(ref.agreed.lanternHasFinial).toBe(true);
        expect(ref.disagreed.ribCount).toEqual([32, 28, 64]);
        // two of three cluster (32, 28): their median, 30, labelled an estimate
        expect('K' in ref.ribs && ref.ribs.K).toBe(30);
        expect('K' in ref.ribs && ref.ribs.countBasis).toMatch(/estimated/);
        expect('K' in ref.ribs && ref.ribs.widthM).toBe(0.2);
        // the fit run again with the detail: 32 narrow ribs on the cap, the measured profile unchanged
        const second = await runRevolutionFit(plain, tmp(), {}, { detailLines: [referenceDetailLine(r, ref)!] });
        const r2 = second.report.revolutions.find(x => x.accepted)!;
        expect(r2.stacks[0].capModulation.reference?.K).toBe(30);
        expect(r2.stacks[0].cap).toEqual(r.stacks[0].cap);
        const mesh = second.meshes[0];
        // count the ribs on a ring of vertices half way up the cap: radial maxima standing out of the shell
        const cap = r2.stacks[0].cap!;
        const yRing = cap.y0 + 0.4 * cap.H;
        const ring: Array<[number, number]> = [];
        for (let v = 0; v < mesh.positions.length / 3; v++) if (Math.abs(mesh.positions[v * 3 + 1] - yRing) < 0.06) ring.push([Math.atan2(mesh.positions[v * 3 + 2] - r2.axis.z, mesh.positions[v * 3] - r2.axis.x), Math.hypot(mesh.positions[v * 3] - r2.axis.x, mesh.positions[v * 3 + 2] - r2.axis.z)]);
        ring.sort((a, b) => a[0] - b[0]);
        const shell = [...ring.map(q => q[1])].sort((a, b) => a - b)[ring.length >> 1];
        let ribs = 0, inRib = false;
        for (const [, rr] of ring) { const up = rr > shell + 0.04; if (up && !inRib) ribs++; inRib = up; }
        if (ring[0][1] > shell + 0.04 && ring[ring.length - 1][1] > shell + 0.04) ribs--;  // a rib across the +-pi seam
        expect(ring.length).toBeGreaterThan(200);
        expect(ribs).toBe(30);
        // counts too scattered (32, 20, 64): nothing is filled
        const scattered = referenceConsensus([answers[0], { ...answers[1], ribCount: 20 }, answers[2]], r);
        expect('none' in scattered.ribs && scattered.ribs.none).toMatch(/too widely/);
        // no agreement that the ribs are raised: nothing is added
        const none = referenceConsensus([{ ...answers[0], ribsRaised: true }, { ...answers[1], ribsRaised: false }], r);
        expect('none' in none.ribs).toBe(true);
    }, 180_000);

    it('finds no ribs on a plain dented dome (the noise is not read as a period)', async () => {
        const plain = syntheticScan({ ribs: false, lantern: false, seed: 11 });
        const r = (await runRevolutionFit(plain, tmp())).report.revolutions.filter(x => x.accepted);
        expect(r.length).toBe(1);
        expect(r[0].stacks.length).toBe(1);
        expect(r[0].stacks[0].capModulation.K, JSON.stringify(r[0].stacks[0].capModulation)).toBe(0);
        expect(r[0].stacks[0].bandModulation.K).toBe(0);
    }, 180_000);
});
