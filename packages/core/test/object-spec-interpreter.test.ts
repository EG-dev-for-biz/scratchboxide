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
import { analyzePartConnectivity, analyzePartConnectivityAsync, ConnectivityAnalysisAbortedError, glbToNamedTriangleSoups, glbToTriangleSoup, mergeTriangleSoups } from '../src/node/3d-engine/part-connectivity';
import { renderReviewViews } from '../src/node/3d-engine/visual-review';
import { extractGlbAnalysis } from '../src/node/gemini/tools/python-3d-tools';
import { buildObjectSpecScript, validateObjectBuildSpec, type ObjectBuildSpec } from '../src/common/spatial/object-build-spec';
import { interpreterSpecProblems, measureBuild, passedEveryCheck, ReferenceObjectBuildError } from '../src/node/3d-engine/reference-object-builder';
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

        // A replicate path that turns straight back has no direction there: the problem names the replicate part
        // and its field, not a sweep the spec does not have.
        const reversing: ObjectBuildSpec = {
            subject: 'beads', observations: [], boundingMeters: [0.3, 0.05, 0.05], expectedBodies: 5,
            parts: [
                { id: 'bead', label: 'bead', revolve: revolve([[0, 0], [0, 0.02], [0.04, 0.02], [0.04, 0]]) },
                { id: 'beads', label: 'beads', replicate: { seedPartId: 'bead', path: { points: [[0, 0, 0], [0.2, 0, 0], [0, 0, 0]], count: 5, orientToPath: true } } } as any
            ]
        };
        expect(validateObjectBuildSpec(reversing)).toEqual([]);
        const back = await NativePythonRunnerService.getInstance().runScript(buildObjectSpecScript(reversing), { outputDir: OUT_DIR, timeoutMs: 120_000 });
        expect(back.success).toBe(false);
        expect(interpreterSpecProblems(back.stderr)).toEqual([
            'part "beads": replicate.path.points: the curve turns straight back on itself near [0.2, 0, 0], so it has no direction there; move the points so the curve does not reverse'
        ]);
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
        const ok = await measureBuild(vase, joined.glb);
        expect(ok.parts.map(p => [p.id, p.built, p.touchesParent])).toEqual([['vase', true, undefined], ['knob', true, true], ['spout', true, true]]);
        expect(ok.parts.every(p => p.triangles > 0 && Math.max(...p.sizeMeters) > 0.01)).toBe(true);
        expect(passedEveryCheck(ok)).toBe(true);

        // Lift the knob off the vase and count it as a second piece: the piece count matches, the attachment does not.
        const lifted: ObjectBuildSpec = { ...vase, expectedBodies: 2, parts: vase.parts.map(p => p.id === 'knob' ? { ...p, attach: { u: 1, angleDeg: 0, normalOffsetMeters: 0.2 } } : p) };
        const apart = await measureBuild(lifted, (await build('checks_lifted', lifted)).glb);
        expect(apart.connectivity.passed).toBe(true);
        expect(apart.detachedParts).toEqual([{ id: 'knob', parentId: 'vase' }]);
        expect(passedEveryCheck(apart)).toBe(false);

        // Spread the replicated spouts off the body: copy 0 still touches, the others float, so the spout is detached.
        const spread: ObjectBuildSpec = { ...vase, parts: vase.parts.map(p => p.id === 'spouts' ? { ...p, replicate: { seedPartId: 'spout', ring: { centerMeters: [0.6, 0, 0], axisDirection: [0, 1, 0], count: 3, spanDeg: 360, risePerCopyMeters: 0 } } } : p) };
        const floating = await measureBuild(spread, (await build('checks_spread', spread)).glb);
        expect(floating.detachedParts.map(d => d.id)).toEqual(['spout']);
    }, 180_000);

    it('checks a build of many attached parts with one contact analysis, naming the one child that is off', async () => {
        const studs = Array.from({ length: 40 }, (_, i) => ({
            id: `stud_${i}`, label: 'stud', parentId: 'post',
            // Stud 7 stands 5 cm off the post; the rest sink into it.
            attach: { u: 0.1 + (0.8 * (i % 10)) / 10, angleDeg: (i * 37) % 360, normalOffsetMeters: i === 7 ? 0.05 : -0.003 },
            revolve: revolve([[0, 0], [0, 0.012], [0.024, 0.01], [0.028, 0]], { axisDirection: [Math.cos(i), 0.2, Math.sin(i)] })
        }));
        const post: ObjectBuildSpec = {
            subject: 'studded post', observations: [], boundingMeters: [0.4, 1.2, 0.4], expectedBodies: 1,
            parts: [{ id: 'post', label: 'post', revolve: revolve([[0, 0], [0, 0.15], [1.2, 0.15], [1.2, 0]]) }, ...studs]
        };
        const { glb } = await build('checks_many_parts', post);
        const started = Date.now();
        const checks = await measureBuild(post, glb);
        const ms = Date.now() - started;
        expect(checks.parts).toHaveLength(41);
        expect(checks.parts.filter(p => p.built)).toHaveLength(41);
        expect(checks.detachedParts).toEqual([{ id: 'stud_7', parentId: 'post' }]);
        expect(checks.connectivity).toMatchObject({ bodies: 2, expectedBodies: 1, passed: false });
        // One analysis of the whole build, not one per child: well inside the time a single pass may take.
        expect(ms).toBeLessThan(60_000);
    }, 180_000);

    it('measures in slices that give the event loop back, stops when asked, and agrees with the straight-through run', async () => {
        const vase: ObjectBuildSpec = {
            subject: 'vase', observations: [], boundingMeters: [0.36, 0.66, 0.36], expectedBodies: 1,
            parts: [
                { id: 'vase', label: 'vase', revolve: revolve([[0, 0], [0, 0.12], [0.2, 0.18], [0.45, 0.1], [0.6, 0.14]], { smoothing: 0.8, lobeCount: 10, lobeDepthRatio: 0.15, helixPitchMeters: 0.9 }) },
                { id: 'knob', label: 'knob', parentId: 'vase', attach: { u: 1, angleDeg: 0, normalOffsetMeters: -0.01 }, revolve: revolve([[-0.02, 0], [-0.02, 0.03], [0.04, 0.025], [0.06, 0]]) }
            ]
        };
        const { glb } = await build('checks_sliced', vase);
        const soup = mergeTriangleSoups([...glbToNamedTriangleSoups(glb)!.values()].filter(s => s.indices.length > 0));
        let turns = 0, done = false;
        const tick = () => { turns++; if (!done) setImmediate(tick); };
        setImmediate(tick);
        const sliced = await analyzePartConnectivityAsync(soup, { withGraph: true, sliceMs: 0 });
        done = true;
        expect(turns).toBeGreaterThan(5);
        const straight = analyzePartConnectivity(soup, { withGraph: true });
        expect({ ...sliced, graph: sliced.graph!.touching }).toEqual({ ...straight, graph: straight.graph!.touching });

        const stop = new AbortController();
        setImmediate(() => stop.abort());
        await expect(analyzePartConnectivityAsync(soup, { signal: stop.signal, sliceMs: 0 })).rejects.toBeInstanceOf(ConnectivityAnalysisAbortedError);
        const stopped = await measureBuild(vase, glb, { signal: stop.signal }).catch(err => err);
        expect(stopped).toBeInstanceOf(ReferenceObjectBuildError);
        expect(stopped).toMatchObject({ stage: 'checks', message: 'Stopped by the user.', details: { aborted: true } });
    }, 180_000);

    it('measures a 444k-triangle build of 1,230 overlapping pieces in seconds without holding the event loop', async () => {
        // A spec that passes the validator: nested rings (36 x 35) of a wide, thin sweep. The earlier analysis spent
        // minutes on it in one synchronous block (a ray test against every triangle of every overlapping piece).
        const ribbons: ObjectBuildSpec = {
            subject: 'nested ribbon rings', observations: [], boundingMeters: [1, 1, 1], expectedBodies: 1,
            parts: [
                { id: 'p0', label: 'stem', sweep: { controlPoints: [[-0.382, 0.2235, -0.1309], [-0.4799, 0.5014, 0.0488], [-0.7745, 0.5499, -0.0963]], closedLoop: false, smoothing: 0.4373, profile: [{ t: 0.302, widthMeters: 0.0005, heightMeters: 0.0843, exponent: 0.5 }, { t: 0.899, widthMeters: 0.0005, heightMeters: 0.14, exponent: 4 }] } },
                { id: 'p1', label: 'ribbon', parentId: 'p0', attach: { u: 1, angleDeg: 90, normalOffsetMeters: -0.005 }, sweep: { controlPoints: [[0, 0, 0], [0.2045, -0.0372, 0.0649]], closedLoop: false, smoothing: 0.625, profile: [{ t: 0.217, widthMeters: 0.3, heightMeters: 0.0005, exponent: 4 }, { t: 0.283, widthMeters: 0.0005, heightMeters: 0.0967, exponent: 4 }, { t: 0.654, widthMeters: 0.0005, heightMeters: 0.116, exponent: 2 }, { t: 0.941, widthMeters: 0.0005, heightMeters: 0.1499, exponent: 12 }] } },
                { id: 'p2', label: 'groove', relief: { targetPartId: 'p0', curves: [[[0.624, 0.9], [0.131, 1.684], [0.718, -1.656], [0.145, 0.347]]], widthMeters: 0.0042, depthMeters: -0.0042, sharpness: 0.046 } },
                { id: 'p3', label: 'inner ring', replicate: { seedPartId: 'p1', ring: { centerMeters: [-0.0589, -0.1934, -0.1418], axisDirection: [-0.9619, 0.8002, -0.7394], count: 36, spanDeg: 180, risePerCopyMeters: 0 } } },
                { id: 'p4', label: 'outer ring', replicate: { seedPartId: 'p3', ring: { centerMeters: [-0.0027, 0.1568, 0.0805], axisDirection: [0, 1, 0], count: 35, spanDeg: 180, risePerCopyMeters: 0.00554 } } }
            ]
        };
        expect(validateObjectBuildSpec(ribbons)).toEqual([]);
        const res = await NativePythonRunnerService.getInstance().runScript(buildObjectSpecScript(ribbons), { outputDir: OUT_DIR, timeoutMs: 300_000 });
        expect(res.exitCode, res.stderr).toBe(0);
        const soup = glbToTriangleSoup(fs.readFileSync(res.glbPath!))!;
        fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
        fs.writeFileSync(path.join(SCREENSHOT_DIR, 'object_spec_checks_heavy_rings.png'), renderReviewViews(soup, 512, { views: [{ label: 'three-quarter view', azimuthDeg: 35, elevationDeg: 22 }] })[0].png);
        let last = Date.now(), longestGap = 0;
        const beat = setInterval(() => { const now = Date.now(); longestGap = Math.max(longestGap, now - last); last = now; }, 10);
        await new Promise(resolve => setTimeout(resolve, 30));
        const started = Date.now();
        const report = await analyzePartConnectivityAsync(soup, { withGraph: true });
        const ms = Date.now() - started;
        await new Promise(resolve => setTimeout(resolve, 30));
        clearInterval(beat);
        expect(soup.indices.length / 3).toBeGreaterThan(400_000);
        expect(report.partCount).toBeGreaterThan(1000);
        expect(report.skippedReason).toBeUndefined();
        // Generous bounds for a loaded test machine: the earlier analysis took 380 s and blocked for all of it.
        expect(ms).toBeLessThan(150_000);
        expect(longestGap).toBeLessThan(3_000);
    }, 400_000);

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

    it('the keyword hero synthesizer says plainly that a named seed shape is no longer built, instead of a raw TypeError', async () => {
        // What the remaining AdaptiveHeroObjectSynthesizer callers emit: a replication whose seed is a shape name.
        const res = await NativePythonRunnerService.getInstance().runScript([
            'from scratchbox.adaptive_object import AdaptiveHeroObjectSynthesizer',
            'AdaptiveHeroObjectSynthesizer().synthesize({"name": "x", "metricReplications": [',
            '  {"distributionMode": "POLAR_RING", "guidePoints": [[0, 0, 0.5]], "pitchMeters": 0.16, "seedGeometry": {"shape": "CYLINDRICAL_FASTENER", "dimensions": [0.016, 0.008, 0.016]}}]})'
        ].join('\n'), { outputDir: OUT_DIR });
        expect(res.success).toBe(false);
        expect(res.stderr).toContain("ValueError: AdaptiveHeroObjectSynthesizer cannot build metricReplications[0]: its seedGeometry {'shape': 'CYLINDRICAL_FASTENER'");
        expect(res.stderr).toContain('named seed shapes are no longer built');
        expect(res.stderr).not.toContain('TypeError');
    }, 180_000);
});
