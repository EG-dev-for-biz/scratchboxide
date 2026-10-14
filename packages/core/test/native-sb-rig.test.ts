/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * SB-Rig (scratchbox_sb_rig.hpp) end to end: the real runner is compiled with clang++ and executed
 * on synthetic SDF shapes with analytic ground truth and on real GLBs. Skin data is checked with an
 * independent reader and CPU linear-blend skinning (helpers/skinned-glb-preview.ts), and every case
 * writes a verification screenshot to test-results/screenshots/ (gitignored).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { NativeCppCompilerService } from '../src/node/3d-engine/native-compiler-service';
import { parseGlb, serializeGlb, readSceneGeometry } from '../src/node/3d-engine/glb-geometry-patcher';
import { readSkinnedGlb, skinPositions, renderPreviewPng, parseGlbChunks, principalAxes, SkinnedGlb } from './helpers/skinned-glb-preview';
import { encodePng } from '../src/node/texture-processing';

const REPO = path.resolve(__dirname, '../../..');
const WORK = path.join(REPO, 'test-results/sb-rig');
const SHOTS = path.join(REPO, 'test-results/screenshots');
// The SB-Human hand GLBs are gitignored local assets. When they are absent the hand cases run on fixtures built
// in beforeAll from the runner's own synthetic 5-digit claw: one with an embedded PNG baseColorTexture (textured
// asset) and one with an extra detached part (two-component asset).
const REAL_HAND = path.join(REPO, 'public/models/sbhuman_hand_hyperreal.glb');
const REAL_HAND_TWO_PARTS = path.join(REPO, 'public/models/sbhuman_hand_recreation.glb');
let HAND = REAL_HAND;
let HAND_TWO_PARTS = REAL_HAND_TWO_PARTS;

type V3 = number[];
const dist = (a: V3, b: V3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

interface Report {
    joints: { name: string; parent: string | null; position: V3; tip: boolean }[];
    chains: { name: string; parentJoint: string | null; joints: string[]; leaf: boolean; hinted: boolean; endPosition: V3; basePosition: V3 }[];
    stats: Record<string, any>;
}

interface RigRun {
    exitCode: number;
    stdout: string;
    stderr: string;
    report: Report;
    glb: SkinnedGlb;
    output: string;
    truth?: any;
}

const compiler = new NativeCppCompilerService();
let binary = '';

async function rig(name: string, args: string[], { synthetic = false, expectFailure = false } = {}): Promise<RigRun> {
    const output = path.join(WORK, `${name}_rigged.glb`);
    const full = [...args, '--output', output];
    if (synthetic) full.push('--synthetic-out', path.join(WORK, `${name}.glb`), '--synthetic-truth', path.join(WORK, `${name}.truth.json`));
    const exec = await compiler.executeBinary(binary, full, WORK);
    if (expectFailure) return { exitCode: exec.exitCode, stdout: exec.stdout, stderr: exec.stderr } as RigRun;
    expect(exec.exitCode, exec.stderr).toBe(0);
    expect(exec.stdout).toContain('[TELEMETRY] status=success');
    const report: Report = JSON.parse(fs.readFileSync(output.replace(/\.glb$/, '.sbrig.json'), 'utf8'));
    const glb = readSkinnedGlb(fs.readFileSync(output));
    const truth = synthetic ? JSON.parse(fs.readFileSync(path.join(WORK, `${name}.truth.json`), 'utf8')) : undefined;
    return { exitCode: exec.exitCode, stdout: exec.stdout, stderr: exec.stderr, report, glb, output, truth };
}

/** Adds an embedded PNG image as the base colour texture of material 0 (the claw already carries TEXCOORD_0). */
function withPngTexture(src: string, dst: string) {
    const doc = parseGlb(fs.readFileSync(src));
    const W = 16, H = 16;
    const rgba = Buffer.alloc(W * H * 4);
    for (let i = 0; i < W * H; i++) rgba.set([180 + (i % 5) * 10, 140, 120 + (i % 3) * 20, 255], i * 4);
    const png = encodePng(W, H, rgba);
    const offset = (doc.bin.length + 3) & ~3;
    const bin = Buffer.concat([doc.bin, Buffer.alloc(offset - doc.bin.length), png]);
    doc.json.bufferViews!.push({ buffer: 0, byteOffset: offset, byteLength: png.length } as any);
    doc.json.images = [{ bufferView: doc.json.bufferViews!.length - 1, mimeType: 'image/png' }];
    (doc.json as any).textures = [{ source: 0 }];
    const materials = (doc.json as any).materials;
    materials[0].pbrMetallicRoughness = { ...materials[0].pbrMetallicRoughness, baseColorTexture: { index: 0, texCoord: 0 } };
    doc.json.buffers![0].byteLength = bin.length;
    doc.bin = bin;
    fs.writeFileSync(dst, serializeGlb(doc));
}

/** Adds a small detached octahedron just beyond the highest vertex as a second primitive (a second component). */
function withDetachedPart(src: string, dst: string) {
    const doc = parseGlb(fs.readFileSync(src));
    const positions = readSceneGeometry(doc).positions;
    let top = 0;
    let minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < positions.length / 3; i++) {
        const y = positions[i * 3 + 1];
        if (y > positions[top * 3 + 1]) top = i;
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
    }
    const r = (maxY - minY) * 0.02;
    const c = [positions[top * 3], positions[top * 3 + 1] + 2 * r, positions[top * 3 + 2]];
    const verts = new Float32Array([
        c[0] + r, c[1], c[2], c[0] - r, c[1], c[2], c[0], c[1] + r, c[2],
        c[0], c[1] - r, c[2], c[0], c[1], c[2] + r, c[0], c[1], c[2] - r
    ]);
    const idx = new Uint32Array([0, 2, 4, 2, 1, 4, 1, 3, 4, 3, 0, 4, 2, 0, 5, 1, 2, 5, 3, 1, 5, 0, 3, 5]);
    const vertOffset = (doc.bin.length + 3) & ~3;
    const idxOffset = vertOffset + verts.byteLength;
    const bin = Buffer.concat([doc.bin, Buffer.alloc(vertOffset - doc.bin.length), Buffer.from(verts.buffer), Buffer.from(idx.buffer)]);
    const views = doc.json.bufferViews!;
    views.push({ buffer: 0, byteOffset: vertOffset, byteLength: verts.byteLength, target: 34962 } as any);
    views.push({ buffer: 0, byteOffset: idxOffset, byteLength: idx.byteLength, target: 34963 } as any);
    const accessors = doc.json.accessors!;
    accessors.push({ bufferView: views.length - 2, componentType: 5126, count: 6, type: 'VEC3',
        min: [c[0] - r, c[1] - r, c[2] - r], max: [c[0] + r, c[1] + r, c[2] + r] } as any);
    accessors.push({ bufferView: views.length - 1, componentType: 5125, count: idx.length, type: 'SCALAR' } as any);
    (doc.json.meshes![0] as any).primitives.push({ attributes: { POSITION: accessors.length - 2 }, indices: accessors.length - 1, material: 0 });
    doc.json.buffers![0].byteLength = bin.length;
    doc.bin = bin;
    fs.writeFileSync(dst, serializeGlb(doc));
}

function leafChains(r: Report) {
    return r.chains.filter(c => c.leaf);
}

function chainNearest(r: Report, point: V3) {
    return leafChains(r).reduce((best, c) => (dist(c.endPosition, point) < dist(best.endPosition, point) ? c : best));
}

function screenshot(file: string, glb: SkinnedGlb, pose?: Record<string, { axis: number[]; angleRad: number }>) {
    fs.mkdirSync(SHOTS, { recursive: true });
    const [major, middle, minor] = principalAxes(glb.positions);
    const up = major, right = middle.map(x => -x);
    const panels: any[] = [{ doc: glb, right, up }, { doc: glb, right: minor, up }];
    if (pose) panels.push({ doc: glb, pose, right, up, highlightJoints: Object.keys(pose) });
    fs.writeFileSync(path.join(SHOTS, file), renderPreviewPng(panels, 480));
}

function expectValidWeights(glb: SkinnedGlb) {
    const n = glb.weights.length / 4;
    const bad: string[] = [];
    for (let v = 0; v < n && bad.length < 5; v++) {
        let sum = 0;
        for (let k = 0; k < 4; k++) {
            const w = glb.weights[v * 4 + k];
            if (!Number.isFinite(w) || w < 0) bad.push(`vertex ${v} weight ${k} = ${w}`);
            if (glb.joints[v * 4 + k] >= glb.jointNames.length) bad.push(`vertex ${v} joint ${k} out of range`);
            sum += w;
        }
        if (Math.abs(sum - 1) >= 1e-5) bad.push(`vertex ${v} weights sum to ${sum}`);
    }
    expect(bad).toEqual([]);
}

function expectParentsBeforeChildren(r: Report) {
    const index = new Map(r.joints.map((j, i) => [j.name, i]));
    expect(r.joints.filter(j => j.parent === null)).toHaveLength(1);
    r.joints.forEach((j, i) => {
        if (j.parent !== null) expect(index.get(j.parent)!).toBeLessThan(i);
    });
}

describe('SB-Rig native auto-rigger (C++20)', () => {
    beforeAll(async () => {
        fs.mkdirSync(WORK, { recursive: true });
        const source = fs.readFileSync(path.join(REPO, 'scripts/run_sb_rig_pipeline.cpp'), 'utf8');
        const flags = process.env.SCRATCHBOX_NATIVE_ARCH === '1' ? ['-march=native'] : [];
        const compiled = await compiler.compileSource(source, { outputBinaryName: 'run_sb_rig_pipeline_test', extraFlags: flags });
        expect(compiled.success, compiled.compilerOutput).toBe(true);
        binary = compiled.binaryPath!;

        if (!fs.existsSync(REAL_HAND) || !fs.existsSync(REAL_HAND_TWO_PARTS)) {
            const claw = path.join(WORK, 'fixture_claw5.glb');
            const gen = await compiler.executeBinary(binary, ['--synthetic', 'claw', '--digits', '5', '--synthetic-out', claw,
                '--output', path.join(WORK, 'fixture_claw5_rigged.glb')], WORK);
            expect(gen.exitCode, gen.stderr).toBe(0);
            if (!fs.existsSync(REAL_HAND)) {
                HAND = path.join(WORK, 'fixture_hand_textured.glb');
                withPngTexture(claw, HAND);
            }
            if (!fs.existsSync(REAL_HAND_TWO_PARTS)) {
                HAND_TWO_PARTS = path.join(WORK, 'fixture_hand_two_parts.glb');
                withDetachedPart(claw, HAND_TWO_PARTS);
            }
        }
    }, 300_000);

    it('discovers exactly one leaf chain per appendage for 1, 3, 5 and 7 digits with no code change', async () => {
        for (const [digits, spread] of [[1, 70], [3, 70], [5, 70], [7, 150]]) {
            const run = await rig(`claw${digits}`, ['--synthetic', 'claw', '--digits', String(digits), '--spread-deg', String(spread), '--root-hint', '0,-3.22,0'], { synthetic: true });
            const leaves = leafChains(run.report);
            expect(leaves).toHaveLength(digits);
            for (const d of run.truth.digits) {
                const nearest = Math.min(...leaves.map(c => dist(c.endPosition, d.tip)));
                expect(nearest).toBeLessThan(1.5 * d.radius);
            }
            for (const c of leaves) expect(c.joints.length).toBeGreaterThanOrEqual(4);
            expectParentsBeforeChildren(run.report);
            expectValidWeights(run.glb);
            if (digits === 5) screenshot('sb-rig_claw5.png', run.glb, { [leaves[0].joints[1]]: { axis: [0, 0, 1], angleRad: 1.0 } });
        }
    });

    it('is scale invariant: the same claw at x0.01 and x100 yields the same skeleton up to scale', async () => {
        const base = await rig('scale1', ['--synthetic', 'claw', '--digits', '7', '--spread-deg', '150', '--root-hint', '0,-3.22,0'], { synthetic: true });
        for (const scale of [0.01, 100]) {
            const run = await rig(`scale${scale}`, ['--synthetic', 'claw', '--digits', '7', '--spread-deg', '150', '--scale', String(scale), '--root-hint', [0, -3.22 * scale, 0].join(',')], { synthetic: true });
            expect(run.report.stats.jointCount).toBe(base.report.stats.jointCount);
            expect(run.report.stats.chainCount).toBe(base.report.stats.chainCount);
            run.report.joints.forEach((j, i) => {
                expect(j.name).toBe(base.report.joints[i].name);
                expect(dist(j.position.map(v => v / scale), base.report.joints[i].position)).toBeLessThan(0.02);
            });
        }
    });

    it('builds multi-level hierarchies (rig anything): a twice-forking tree has 4 leaves under 3 branch joints', async () => {
        const run = await rig('tree', ['--synthetic', 'tree', '--root-hint', '0,-3.4,0'], { synthetic: true });
        expect(leafChains(run.report)).toHaveLength(4);
        const childCount = new Map<string, number>();
        run.report.joints.forEach(j => j.parent && childCount.set(j.parent, (childCount.get(j.parent) ?? 0) + 1));
        expect([...childCount.values()].filter(n => n >= 2)).toHaveLength(3);
        for (const leaf of run.truth.leaves) expect(Math.min(...leafChains(run.report).map(c => dist(c.endPosition, leaf)))).toBeLessThan(0.4);
        expectValidWeights(run.glb);
        screenshot('sb-rig_tree.png', run.glb);
    });

    it('cuts a fused loop so a curled digit hangs from its base, not from where its tip touches the palm', async () => {
        const run = await rig('curl', ['--synthetic', 'claw', '--digits', '2', '--curled', '1', '--root-hint', '0,-3.22,0'], { synthetic: true });
        expect(run.report.stats.loopsCut).toBeGreaterThanOrEqual(1);
        const curled = run.truth.digits.find((d: any) => d.curled);
        const chain = chainNearest(run.report, curled.tip);
        const joints = chain.joints.map(n => run.report.joints.find(j => j.name === n)!.position);
        expect(dist(joints[0], curled.base)).toBeLessThan(dist(joints[0], curled.tip));
        expect(Math.min(...joints.map(p => dist(p, curled.apex)))).toBeLessThan(0.35);
        expect(dist(joints[joints.length - 1], curled.tip)).toBeLessThan(2 * curled.radius);
        screenshot('sb-rig_curl.png', run.glb, { [chain.joints[1]]: { axis: [1, 0, 0], angleRad: -0.8 } });
    });

    it('keeps weights off neighbouring digits (geodesic, not Euclidean) along the free length of each digit', async () => {
        const run = await rig('bleed', ['--synthetic', 'claw', '--digits', '5', '--root-hint', '0,-3.22,0'], { synthetic: true });
        const digits = run.truth.digits;
        const chainJoints = digits.map((d: any) => new Set(chainNearest(run.report, d.tip).joints.map(n => run.glb.jointNames.indexOf(n))));
        const P = run.glb.positions;
        let checked = 0, bleed = 0;
        for (let v = 0; v < P.length / 3; v++) {
            const p = [P[v * 3], P[v * 3 + 1], P[v * 3 + 2]];
            digits.forEach((d: any, i: number) => {
                const ab = d.tip.map((x: number, k: number) => x - d.base[k]);
                const len2 = ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2;
                const t = ((p[0] - d.base[0]) * ab[0] + (p[1] - d.base[1]) * ab[1] + (p[2] - d.base[2]) * ab[2]) / len2;
                if (t < 0.6 || t > 0.95) return;
                const onAxis = d.base.map((x: number, k: number) => x + ab[k] * t);
                if (dist(p, onAxis) > d.radius + 0.03) return;
                for (const j of [i - 1, i + 1]) {
                    if (j < 0 || j >= digits.length) continue;
                    for (let k = 0; k < 4; k++) {
                        if (chainJoints[j].has(run.glb.joints[v * 4 + k]) && run.glb.weights[v * 4 + k] >= 1e-6) bleed++;
                    }
                }
                checked++;
            });
        }
        expect(checked).toBeGreaterThan(500);
        expect(bleed).toBe(0);
    });

    it('adds chains along chain hints where geometry alone cannot separate a digit', async () => {
        const paddle = await rig('paddle', ['--synthetic', 'claw', '--digits', '7', '--spread-deg', '60', '--root-hint', '0,-3.22,0'], { synthetic: true });
        const digit = paddle.truth.digits[3];
        const hint = [digit.base, digit.base.map((x: number, k: number) => (x + digit.tip[k]) / 2), digit.tip].map((p: V3) => p.join(',')).join(';');
        const run = await rig('paddle_hint', ['--input', path.join(WORK, 'paddle.glb'), '--root-hint', '0,-3.22,0', '--chain-hint', hint]);
        const hinted = run.report.chains.filter(c => c.hinted);
        expect(hinted).toHaveLength(1);
        expect(run.report.joints.find(j => j.name === hinted[0].parentJoint)).toBeDefined();
        expect(hinted[0].parentJoint!.startsWith(hinted[0].name)).toBe(false);
        expect(hinted[0].joints.length).toBeGreaterThanOrEqual(4);
        const owned = new Set(hinted[0].joints.map(n => run.glb.jointNames.indexOf(n)));
        let dominant = 0;
        for (let v = 0; v < run.glb.weights.length / 4; v++) if (owned.has(run.glb.joints[v * 4])) dominant++;
        expect(dominant).toBeGreaterThan(100);
        expectValidWeights(run.glb);
    });

    it('patches a textured GLB without touching its images, UVs or materials, and reproduces it exactly at rest', async () => {
        const input = fs.readFileSync(HAND);
        const run = await rig('hand', ['--input', HAND]);
        const before = parseGlb(input), after = parseGlb(fs.readFileSync(run.output));
        expect(after.json.images).toEqual(before.json.images);
        expect(after.json.materials).toEqual(before.json.materials);
        expect(after.json.textures).toEqual(before.json.textures);
        before.json.bufferViews!.forEach((view, i) => {
            expect(after.json.bufferViews![i]).toEqual(view);
            const start = view.byteOffset ?? 0;
            expect(after.bin.subarray(start, start + view.byteLength).equals(before.bin.subarray(start, start + view.byteLength))).toBe(true);
        });
        expect(run.glb.jointNames).toHaveLength(run.report.stats.jointCount);
        expectValidWeights(run.glb);
        const original = readSceneGeometry(before).positions;
        const rest = skinPositions(run.glb);
        let worst = 0;
        for (let i = 0; i < rest.length; i++) worst = Math.max(worst, Math.abs(rest[i] - original[i]));
        expect(worst).toBeLessThan(1e-4);
        expect(leafChains(run.report).length).toBeGreaterThanOrEqual(4);
        screenshot('sb-rig_hand_hyperreal.png', run.glb);
    });

    it('re-homes a transformed skinned node so spec viewers and three.js agree at rest', async () => {
        await rig('moved_src', ['--synthetic', 'claw', '--digits', '3'], { synthetic: true });
        const doc = parseGlb(fs.readFileSync(path.join(WORK, 'moved_src.glb')));
        doc.json.nodes![0].translation = [1, 2, 3];
        doc.json.nodes![0].scale = [2, 2, 2];
        const movedPath = path.join(WORK, 'moved.glb');
        fs.writeFileSync(movedPath, serializeGlb(doc));
        const run = await rig('moved', ['--input', movedPath]);
        const { json } = parseGlbChunks(fs.readFileSync(run.output));
        const meshNode = json.nodes.findIndex((n: any) => n.mesh !== undefined);
        expect(json.nodes[meshNode].translation).toBeUndefined();
        expect(json.nodes[meshNode].scale).toBeUndefined();
        expect(json.scenes[json.scene ?? 0].nodes).toContain(meshNode);
        const expected = readSceneGeometry(doc).positions;
        const rest = skinPositions(run.glb);
        let worst = 0;
        for (let i = 0; i < rest.length; i++) worst = Math.max(worst, Math.abs(rest[i] - expected[i]));
        expect(worst).toBeLessThan(1e-4);
    });

    it('binds secondary components rigidly and renames joints through chain prefixes and exact names', async () => {
        const run = await rig('two_parts', ['--input', HAND_TWO_PARTS, '--rename', 'Chain1=LeftForearm', '--rename', 'Root=LeftElbow']);
        expect(run.report.stats.components).toBeGreaterThan(1);
        expect(run.report.stats.secondaryVerticesBound).toBeGreaterThan(0);
        expect(run.glb.jointNames).toContain('LeftElbow');
        expect(run.glb.jointNames).toContain('LeftForearm1');
        expect(run.report.chains[0].name).toBe('LeftForearm');
        expectValidWeights(run.glb);
    });

    it('refuses invalid requests with exit code 2 and an actionable message', async () => {
        const skinned = path.join(WORK, 'hand_rigged.glb');
        const again = await rig('again', ['--input', skinned], { expectFailure: true });
        expect(again.exitCode).toBe(2);
        expect(again.stderr).toContain('already has a skin');
        const dup = await rig('dup', ['--input', HAND, '--rename', 'Root=X', '--rename', 'Chain1Seg1=X'], { expectFailure: true });
        expect(dup.exitCode).toBe(2);
        expect(dup.stderr).toContain('duplicate joint name');
        const param = await rig('param', ['--input', HAND, '--param-noSuchThing', '1'], { expectFailure: true });
        expect(param.exitCode).toBe(2);
        expect(param.stderr).toContain("unknown SB-Rig parameter 'noSuchThing'");
    });
});
