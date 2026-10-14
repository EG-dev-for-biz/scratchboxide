/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * sb.object_spec.build, run in the native Python engine on one spec per operator. Each case checks the GLB
 * (magic, vertex counts, per-part meshes), part connectivity against expectedBodies, and saves a clay render to
 * test-results/screenshots/object_spec_<case>.png (gitignored).
 */

import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NativePythonRunnerService } from '../src/node/3d-engine/native-python-runner-service';
import { analyzePartConnectivity, glbToTriangleSoup } from '../src/node/3d-engine/part-connectivity';
import { renderReviewViews } from '../src/node/3d-engine/visual-review';
import { extractGlbAnalysis } from '../src/node/gemini/tools/python-3d-tools';
import { buildObjectSpecScript, validateObjectBuildSpec, type ObjectBuildSpec } from '../src/common/spatial/object-build-spec';
import { interpreterSpecProblems, measureBuild, passedEveryCheck } from '../src/node/3d-engine/reference-object-builder';
import { REPO_ROOT } from './helpers/requirements';

const SCREENSHOT_DIR = path.join(REPO_ROOT, 'test-results/screenshots');
const OUT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-object-spec-'));
afterAll(() => fs.rmSync(OUT_DIR, { recursive: true, force: true }));

const revolve = (meridian: Array<[number, number]>, over: Record<string, unknown> = {}) => ({
    axisOrigin: [0, 0, 0], axisDirection: [0, 1, 0], meridian, smoothing: 0, lobeCount: 0, lobeDepthRatio: 0, helixPitchMeters: 0, ...over
}) as any;

async function build(name: string, spec: ObjectBuildSpec) {
    expect(validateObjectBuildSpec(spec)).toEqual([]);
    const res = await NativePythonRunnerService.getInstance().runScript(buildObjectSpecScript(spec), { outputDir: OUT_DIR, timeoutMs: 120_000 });
    expect(res.exitCode, res.stderr).toBe(0);
    const glb = fs.readFileSync(res.glbPath!);
    expect(glb.toString('ascii', 0, 4)).toBe('glTF');
    const analysis = extractGlbAnalysis(glb);
    const soup = glbToTriangleSoup(glb)!;
    const connectivity = analyzePartConnectivity(soup);
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    const [view] = renderReviewViews(soup, 512, { views: [{ label: 'three-quarter view', azimuthDeg: 35, elevationDeg: 22 }] });
    fs.writeFileSync(path.join(SCREENSHOT_DIR, `object_spec_${name}.png`), view.png);
    const meshes = new Map(analysis.metrics!.submeshes.map(m => [m.name, m]));
    return { glb, analysis, soup, connectivity, meshes };
}

/** Distances from the Y axis of the vertices whose height is within `tol` of `y`. */
function radiiAt(soup: { positions: Float32Array }, y: number, tol: number): number[] {
    const out: number[] = [];
    for (let i = 0; i < soup.positions.length; i += 3) {
        if (Math.abs(soup.positions[i + 1] - y) < tol) out.push(Math.hypot(soup.positions[i], soup.positions[i + 2]));
    }
    return out;
}

describe('sb.object_spec interpreter', () => {
    it('sweep: tapered, twisted and closed carriers, a child joined at its attach point', async () => {
        const spec: ObjectBuildSpec = {
            subject: 'ribbon sculpture', observations: [], boundingMeters: [1.2, 1.4, 0.8], expectedBodies: 1,
            parts: [
                { id: 'post', label: 'post', sweep: { controlPoints: [[0, 0, 0], [0, 0.5, 0.05], [0, 1.0, 0]], closedLoop: false, smoothing: 1,
                    profile: [{ t: 0, widthMeters: 0.12, heightMeters: 0.12, exponent: 2 }, { t: 1, widthMeters: 0.05, heightMeters: 0.05, exponent: 2 }] } },
                { id: 'ribbon', label: 'ribbon loop', parentId: 'post', attach: { u: 0.7, angleDeg: 90, normalOffsetMeters: -0.02 },
                    sweep: { controlPoints: [[0, 0, 0], [0.4, 0.3, 0.1], [0.1, 0.6, -0.2], [-0.2, 0.2, 0.1]], closedLoop: true, smoothing: 1,
                        profile: [{ t: 0, widthMeters: 0.14, heightMeters: 0.015, exponent: 4 }, { t: 1, widthMeters: 0.14, heightMeters: 0.015, exponent: 4 }],
                        twistDegAlong: [[0, 0], [1, 360]] } }
            ]
        };
        const { analysis, connectivity, meshes } = await build('sweep', spec);
        expect(analysis.metrics!.totalVertices).toBeGreaterThan(5000);
        expect([...meshes.keys()]).toEqual(['post', 'ribbon']);
        expect(connectivity.skippedReason).toBeUndefined();
        expect(connectivity.structureCount).toBe(1);
        // The lowest point rests on the ground.
        expect(analysis.bounds!.min[1]).toBeCloseTo(0, 4);
    }, 180_000);

    it('revolve: lobed helical solid with capped and pole ends is one closed body', async () => {
        const spec: ObjectBuildSpec = {
            subject: 'fluted vase', observations: [], boundingMeters: [0.4, 0.6, 0.4], expectedBodies: 1,
            parts: [
                { id: 'vase', label: 'vase', revolve: revolve([[0, 0], [0, 0.12], [0.2, 0.18], [0.45, 0.1], [0.6, 0.14]], { smoothing: 0.8, lobeCount: 10, lobeDepthRatio: 0.15, helixPitchMeters: 0.9 }) },
                { id: 'lid', label: 'lid knob', parentId: 'vase', attach: { u: 1, angleDeg: 0, normalOffsetMeters: -0.01 },
                    revolve: revolve([[-0.02, 0], [-0.02, 0.03], [0.04, 0.025], [0.06, 0]]) }
            ]
        };
        const { analysis, connectivity, meshes } = await build('revolve', spec);
        expect(meshes.get('vase')!.vertexCount).toBeGreaterThan(3000);
        expect(connectivity.structureCount).toBe(1);
        // The vase is 0.6 m tall and the knob adds up to 0.06 m above its top cap.
        const height = analysis.bounds!.max[1] - analysis.bounds!.min[1];
        expect(height).toBeGreaterThan(0.6);
        expect(height).toBeLessThan(0.7);
    }, 180_000);

    it('replicate: ring copies (with what is attached to the seed), path copies and a mirrored pair stay joined', async () => {
        const blade = { controlPoints: [[0, 0, 0], [0, 0, 0.6]], closedLoop: false, smoothing: 0,
            profile: [{ t: 0, widthMeters: 0.08, heightMeters: 0.012, exponent: 4 }, { t: 1, widthMeters: 0.14, heightMeters: 0.01, exponent: 4 }] } as any;
        const spec: ObjectBuildSpec = {
            subject: 'fan', observations: [], boundingMeters: [1.4, 0.6, 1.4], expectedBodies: 1,
            parts: [
                { id: 'hub', label: 'hub', revolve: revolve([[0, 0], [0, 0.1], [0.12, 0.1], [0.5, 0.03], [0.5, 0]], { axisOrigin: [0, 0, 0] }) },
                { id: 'blade', label: 'blade', parentId: 'hub', attach: { u: 0.3, angleDeg: 0, normalOffsetMeters: -0.02 }, sweep: blade },
                { id: 'tip', label: 'blade tip', parentId: 'blade', attach: { u: 1, angleDeg: 0, normalOffsetMeters: -0.003 },
                    revolve: revolve([[-0.005, 0], [-0.005, 0.02], [0.02, 0]], { axisDirection: [0, 0, 1] }) },
                { id: 'blades', label: 'five blades', replicate: { seedPartId: 'blade', ring: { centerMeters: [0, 0, 0], axisDirection: [0, 1, 0], count: 5, spanDeg: 360, risePerCopyMeters: 0 } } },
                { id: 'stud', label: 'stud', parentId: 'hub', attach: { u: 0.99, angleDeg: 0, normalOffsetMeters: -0.002 },
                    revolve: revolve([[-0.005, 0], [-0.005, 0.012], [0.01, 0]]) },
                { id: 'studs', label: 'studs', replicate: { seedPartId: 'stud', path: { points: [[0, 0.5, 0], [0.02, 0.5, 0.02], [0.04, 0.5, 0]], count: 3, orientToPath: true } } },
                { id: 'handle', label: 'handle', parentId: 'hub', attach: { u: 0.55, angleDeg: 90, normalOffsetMeters: -0.01 }, mirrorPlaneNormal: [1, 0, 0],
                    sweep: { controlPoints: [[0, 0, 0], [0.15, 0.05, 0]], closedLoop: false, smoothing: 0, profile: [{ t: 0, widthMeters: 0.03, heightMeters: 0.03, exponent: 2 }] } }
            ]
        };
        const { analysis, connectivity, meshes, soup } = await build('replicate', spec);
        // Five copies of the seed, each still carrying its attached tip; three studs along the path.
        expect(meshes.get('blade')!.vertexCount % 5).toBe(0);
        expect(meshes.get('tip')!.vertexCount % 5).toBe(0);
        expect(meshes.get('tip')!.vertexCount).toBeGreaterThan(0);
        expect(meshes.get('stud')!.vertexCount % 3).toBe(0);
        // Blade ends sit every 72 degrees, starting with the seed as built (toward +Z).
        const sectors = new Set<number>();
        for (let i = 0; i < soup.positions.length; i += 3) {
            const x = soup.positions[i], z = soup.positions[i + 2];
            if (Math.hypot(x, z) > 0.55) sectors.add(Math.round(((Math.atan2(x, z) * 180) / Math.PI + 360) % 360 / 72) % 5);
        }
        expect([...sectors].sort()).toEqual([0, 1, 2, 3, 4]);
        // Copies go all the way round: the blades reach both sides on X and Z.
        expect(analysis.bounds!.min[0]).toBeLessThan(-0.4);
        expect(analysis.bounds!.max[0]).toBeGreaterThan(0.4);
        expect(analysis.bounds!.min[2]).toBeLessThan(-0.4);
        expect(meshes.get('handle')!.bounds!.min[0]).toBeLessThan(-0.2);
        expect(meshes.get('handle')!.bounds!.max[0]).toBeGreaterThan(0.2);
        expect(connectivity.structureCount).toBe(1);
    }, 180_000);

    it('relief: grooves and beads move the surface along its normal by their depth', async () => {
        const cylinder = (relief?: any): ObjectBuildSpec => ({
            subject: 'grooved column', observations: [], boundingMeters: [0.2, 1, 0.2], expectedBodies: 1,
            parts: [
                { id: 'column', label: 'column', revolve: revolve([[0, 0.1], [1, 0.1]]) },
                ...(relief ? [{ id: 'cut', label: 'ring', relief }] : [])
            ]
        });
        const plain = await build('relief_none', cylinder());
        const plainRadii = radiiAt(plain.soup, 0.5, 0.004).filter(r => r > 0.05);
        expect(Math.min(...plainRadii)).toBeGreaterThan(0.0995);

        const groove = await build('relief', cylinder({ targetPartId: 'column', curves: [[[0.5, 0], [0.5, 1]]], widthMeters: 0.03, depthMeters: -0.01, sharpness: 0.5 }));
        const grooveRadii = radiiAt(groove.soup, 0.5, 0.004).filter(r => r > 0.05);
        expect(Math.min(...grooveRadii)).toBeCloseTo(0.09, 3);
        // Away from the curve the surface is untouched.
        expect(Math.min(...radiiAt(groove.soup, 0.2, 0.01).filter(r => r > 0.05))).toBeGreaterThan(0.0995);
        expect(groove.connectivity.structureCount).toBe(1);

        const bead = await build('relief_bead', cylinder({ targetPartId: 'column', curves: [[[0.5, 0], [0.5, 1]]], widthMeters: 0.03, depthMeters: 0.01, sharpness: 0.5 }));
        expect(Math.max(...radiiAt(bead.soup, 0.5, 0.004))).toBeCloseTo(0.11, 3);
    }, 180_000);

    it('reports every problem only the interpreter can see at once, in a form the builder reads back', async () => {
        const flat = revolve([[0, 0], [0, 0.015]]);
        const spec: ObjectBuildSpec = {
            subject: 'two coins', observations: [], boundingMeters: [0.2, 0.05, 0.2], expectedBodies: 2,
            parts: [
                { id: 'coin_a', label: 'a', revolve: flat },
                { id: 'stud', label: 'stud on a', parentId: 'coin_a', attach: { u: 0.5, angleDeg: 0, normalOffsetMeters: 0 }, revolve: revolve([[0, 0], [0, 0.01], [0.01, 0]]) },
                { id: 'coin_b', label: 'b', revolve: { ...flat, axisOrigin: [0.1, 0, 0] } }
            ]
        };
        expect(validateObjectBuildSpec(spec)).toEqual([]);
        const res = await NativePythonRunnerService.getInstance().runScript(buildObjectSpecScript(spec), { outputDir: OUT_DIR, timeoutMs: 120_000 });
        expect(res.success).toBe(false);
        const problems = interpreterSpecProblems(res.stderr);
        // Both roots, once each; the stud fails with its parent's problem and is not listed again.
        expect(problems).toHaveLength(2);
        expect(problems![0]).toMatch(/^part "coin_a" revolve\.meridian: the outline encloses no area with the axis/);
        expect(problems![1]).toMatch(/^part "coin_b" revolve\.meridian:/);
        expect(interpreterSpecProblems('Traceback (most recent call last):\nZeroDivisionError: float division by zero')).toBeUndefined();
    }, 180_000);

    it('measures that every listed part is built and that each child touches its parent', async () => {
        const vase: ObjectBuildSpec = {
            subject: 'vase', observations: [], boundingMeters: [0.36, 0.66, 0.36], expectedBodies: 1,
            parts: [
                { id: 'vase', label: 'vase', revolve: revolve([[0, 0], [0, 0.12], [0.2, 0.18], [0.45, 0.1], [0.6, 0.14]], { smoothing: 0.8 }) },
                { id: 'knob', label: 'knob', parentId: 'vase', attach: { u: 1, angleDeg: 0, normalOffsetMeters: -0.01 }, revolve: revolve([[-0.02, 0], [-0.02, 0.03], [0.04, 0.025], [0.06, 0]]) },
                { id: 'spout', label: 'spout', parentId: 'vase', attach: { u: 0.5, angleDeg: 90, normalOffsetMeters: -0.01 },
                    sweep: { controlPoints: [[0, 0, 0], [0.12, 0.08, 0]], closedLoop: false, smoothing: 0, profile: [{ t: 0, widthMeters: 0.03, heightMeters: 0.03, exponent: 2 }] } },
                { id: 'spouts', label: 'three spouts', replicate: { seedPartId: 'spout', ring: { centerMeters: [0, 0, 0], axisDirection: [0, 1, 0], count: 3, spanDeg: 360, risePerCopyMeters: 0 } } }
            ]
        };
        const joined = await build('checks_joined', vase);
        const ok = measureBuild(vase, joined.glb);
        expect(ok.parts.map(p => [p.id, p.built, p.touchesParent])).toEqual([['vase', true, undefined], ['knob', true, true], ['spout', true, true]]);
        expect(ok.parts.every(p => p.triangles > 0 && Math.max(...p.sizeMeters) > 0.01)).toBe(true);
        expect(passedEveryCheck(ok)).toBe(true);

        // Lift the knob off the vase and count it as a second piece: the piece count matches, the attachment does not.
        const lifted: ObjectBuildSpec = { ...vase, expectedBodies: 2, parts: vase.parts.map(p => p.id === 'knob' ? { ...p, attach: { u: 1, angleDeg: 0, normalOffsetMeters: 0.2 } } : p) };
        const apart = measureBuild(lifted, (await build('checks_lifted', lifted)).glb);
        expect(apart.connectivity.passed).toBe(true);
        expect(apart.detachedParts).toEqual([{ id: 'knob', parentId: 'vase' }]);
        expect(passedEveryCheck(apart)).toBe(false);

        // Spread the replicated spouts off the body: copy 0 still touches, the others float, so the spout is detached.
        const spread: ObjectBuildSpec = { ...vase, parts: vase.parts.map(p => p.id === 'spouts' ? { ...p, replicate: { seedPartId: 'spout', ring: { centerMeters: [0.6, 0, 0], axisDirection: [0, 1, 0], count: 3, spanDeg: 360, risePerCopyMeters: 0 } } } : p) };
        const floating = measureBuild(spread, (await build('checks_spread', spread)).glb);
        expect(floating.detachedParts.map(d => d.id)).toEqual(['spout']);
    }, 180_000);

    it('raises on an invalid spec instead of guessing, naming the field', async () => {
        const res = await NativePythonRunnerService.getInstance().runScript([
            'import scratchbox as sb',
            'spec = {"subject": "x", "observations": [], "boundingMeters": [1, 1, 1], "expectedBodies": 1, "parts": [',
            '  {"id": "a", "label": "a", "revolve": {"axisOrigin": [0,0,0], "axisDirection": [0,1,0], "meridian": [[0,0],[0,0.1],[1,0.1],[1,0]], "smoothing": 0, "lobeCount": 0, "lobeDepthRatio": 0, "helixPitchMeters": 0}},',
            '  {"id": "b", "label": "b", "parentId": "a", "attach": {"u": 0.5, "angleDeg": 0, "normalOffsetMeters": 0},',
            '   "sweep": {"controlPoints": [[0.2,0,0],[0.5,0,0]], "closedLoop": False, "smoothing": 0, "profile": [{"t": 0, "widthMeters": 0.02, "heightMeters": 0.02, "exponent": 2}]}}]}',
            'sb.io.write_glb(OUTPUT_GLB_PATH, sb.object_spec.build(spec))'
        ].join('\n'), { outputDir: OUT_DIR });
        expect(res.success).toBe(false);
        expect(res.stderr).toContain('SpecError');
        expect(res.stderr).toContain('controlPoints[0] must be [0, 0, 0]');
    }, 180_000);
});
