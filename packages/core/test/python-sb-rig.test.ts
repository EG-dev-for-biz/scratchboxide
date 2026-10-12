/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * `sb.rig` from the Python scripter: real scripts run through NativePythonRunnerService (the same
 * path as the execute_3d_python_script tool) against the compiled scratchbox_native module.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { NativePythonRunnerService } from '../src/node/3d-engine/native-python-runner-service';
import { readSkinnedGlb, renderPreviewPng, principalAxes } from './helpers/skinned-glb-preview';

const REPO = path.resolve(__dirname, '../../..');
const WORK = path.join(REPO, 'test-results/sb-rig-python');
const HAND = path.join(REPO, 'public/models/sbhuman_hand_hyperreal.glb');

function lastJsonLine(stdout: string): any {
    const line = stdout.trim().split('\n').reverse().find(l => l.startsWith('{'));
    if (!line) throw new Error(`no JSON summary in stdout:\n${stdout}`);
    return JSON.parse(line);
}

describe('sb.rig (Python scripter)', () => {
    const runner = new NativePythonRunnerService();

    it('solves an in-memory mesh, renames joints and exports a skinned GLB', async () => {
        fs.mkdirSync(WORK, { recursive: true });
        const out = path.join(WORK, 'loft_rigged.glb');
        const script = `
import json, math
import scratchbox as sb
from scratchbox_native.math import Vec3, Vec4

assert sb.rig is not None, "sb.rig is not available in scratchbox_native"

# A bent, knobbly tube: lofted circles along a quarter arc with radius bulges.
slices = []
for i in range(61):
    t = i / 60.0
    a = t * math.pi / 2
    centre = Vec3((1 - math.cos(a)) * 3.0, math.sin(a) * 3.0, 0.0)
    tangent = (math.sin(a), math.cos(a))
    normal = (-tangent[1], tangent[0])
    r = 0.35 + 0.08 * math.sin(t * math.pi * 6)
    ring = []
    for k in range(24):
        phi = 2 * math.pi * k / 24
        ring.append(Vec3(centre.x + normal[0] * r * math.cos(phi), centre.y + normal[1] * r * math.cos(phi), r * math.sin(phi)))
    slices.append(ring)
mesh = sb.geometry.create_loft(slices, True, Vec4(0.55, 0.57, 0.6, 1.0))

params = sb.rig.Params()
params.root_hint = (0.0, 0.0, 0.0)
result = sb.rig.solve(mesh, params)
result.rename({"Chain1": "Tail", "Root": "TailBase"})
weights = result.joint_weights
sums = [sum(weights[i:i + 4]) for i in range(0, len(weights), 4)]
data = sb.rig.export_skinned_glb_bytes(mesh, result)
open(${JSON.stringify(out)}, "wb").write(data)

errors = []
bad = sb.rig.Params()
bad.min_branch_frac = -1.0
try:
    sb.rig.solve(mesh, bad)
except ValueError as e:
    errors.append(str(e))
try:
    result.rename({"NoSuchChain": "X"})
except ValueError as e:
    errors.append(str(e))

print(json.dumps({
    "joints": result.joint_names,
    "parents": result.parents,
    "leaves": result.leaf_count,
    "vertices": len(result.vertex_owner),
    "meshVertices": len(mesh.vertices),
    "minSum": min(sums), "maxSum": max(sums),
    "tips": result.tip_joints,
    "glbBytes": len(data),
    "errors": errors,
}))
`;
        const res = await runner.runScript(script, { outputDir: WORK });
        expect(res.exitCode, res.stderr).toBe(0);
        const summary = lastJsonLine(res.stdout);
        expect(summary.joints[0]).toBe('TailBase');
        expect(summary.joints).toContain('Tail1');
        expect(summary.leaves).toBeGreaterThanOrEqual(1);
        expect(summary.vertices).toBe(summary.meshVertices);
        expect(Math.abs(summary.minSum - 1)).toBeLessThan(1e-5);
        expect(Math.abs(summary.maxSum - 1)).toBeLessThan(1e-5);
        expect(summary.tips.some((t: boolean) => t)).toBe(true);
        summary.parents.forEach((p: number, i: number) => expect(p).toBeLessThan(i));
        expect(summary.errors).toHaveLength(2);
        expect(summary.errors[0]).toContain('minBranchFrac');
        expect(summary.errors[1]).toContain('NoSuchChain');

        const glb = readSkinnedGlb(fs.readFileSync(out));
        expect(glb.jointNames).toEqual(summary.joints);
        const [major, middle] = principalAxes(glb.positions);
        fs.mkdirSync(path.join(REPO, 'test-results/screenshots'), { recursive: true });
        fs.writeFileSync(path.join(REPO, 'test-results/screenshots/sb-rig-python_loft.png'), renderPreviewPng([
            { doc: glb, right: middle, up: major },
            { doc: glb, right: middle, up: major, pose: { Tail2: { axis: [0, 0, 1], angleRad: 0.8 } }, highlightJoints: ['Tail2'] },
        ], 480));
    });

    it('rigs a textured GLB file with rig_glb and writes the report', async () => {
        const out = path.join(WORK, 'hand_rigged.glb');
        const report = path.join(WORK, 'hand_rigged.sbrig.json');
        const script = `
import json
import scratchbox as sb
result = sb.rig.rig_glb(${JSON.stringify(HAND)}, ${JSON.stringify(out)}, sb.rig.Params(), {"Root": "Palm"}, ${JSON.stringify(report)})
print(json.dumps({"leaves": result.leaf_count, "joints": len(result.joint_names), "first": result.joint_names[0]}))
`;
        const res = await runner.runScript(script, { outputDir: WORK });
        expect(res.exitCode, res.stderr).toBe(0);
        const summary = lastJsonLine(res.stdout);
        expect(summary.first).toBe('Palm');
        expect(summary.leaves).toBeGreaterThanOrEqual(5);
        const written = JSON.parse(fs.readFileSync(report, 'utf8'));
        expect(written.stats.jointCount).toBe(summary.joints);
        const glb = readSkinnedGlb(fs.readFileSync(out));
        expect(glb.jointNames[0]).toBe('Palm');
    });
});
