/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Modelling edits in the native engine (mesh_edit): a 2 x 1 x 2 m block drilled through with a cylinder, its +X face
 * inset and extruded into a boss, a sphere merged on a top edge and the front sliced off. Each step is checked by what
 * a solid must satisfy: closed (no open edge), consistently wound (every directed edge once), and the volume a hand
 * calculation gives. A render of the result goes to test-results/screenshots/.
 */

import { afterAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MissingInputError } from '../src/common/errors/pipeline-errors';
import { NativeMeshEditService, type MeshEditOperation } from '../src/node/3d-engine/native-mesh-edit-service';
import { meshShapingHandlers } from '../src/node/gemini/tools/mesh-shaping-tools';
import { resolveTaskCapability } from '../src/node/agent/task-capability-resolver';
import { writeFixtureGlb, type FixtureMesh } from './helpers/mesh-glb-fixtures';
import { readGlbTriangles, renderClayPng } from './helpers/clay-glb-render';

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-mesh-edit-'));
const SHOTS = path.resolve(__dirname, '../../../test-results/screenshots');
afterAll(() => fs.rmSync(WORK, { recursive: true, force: true }));

/** A box [-1, 1] x [-0.5, 0.5] x [-1, 1], one quad per face wound outward. */
function block(): FixtureMesh {
    const c = (x: number, y: number, z: number) => [x, y * 0.5, z];
    const quads = [
        [c(1, -1, -1), c(1, 1, -1), c(1, 1, 1), c(1, -1, 1)], [c(-1, -1, 1), c(-1, 1, 1), c(-1, 1, -1), c(-1, -1, -1)],
        [c(-1, 1, -1), c(-1, 1, 1), c(1, 1, 1), c(1, 1, -1)], [c(-1, -1, 1), c(-1, -1, -1), c(1, -1, -1), c(1, -1, 1)],
        [c(-1, -1, 1), c(1, -1, 1), c(1, 1, 1), c(-1, 1, 1)], [c(1, -1, -1), c(-1, -1, -1), c(-1, 1, -1), c(1, 1, -1)]
    ];
    const positions: number[] = [], indices: number[] = [];
    for (const q of quads) {
        const b = positions.length / 3;
        q.forEach(p => positions.push(...p));
        indices.push(b, b + 1, b + 2, b, b + 2, b + 3);
    }
    return { positions, indices };
}

/** Volume, open edges and doubly-used directed edges, after welding corners within 1e-5 m. */
function solidStats(file: string): { volume: number; open: number; doubled: number; triangles: number } {
    const t = readGlbTriangles(fs.readFileSync(file));
    const ids = new Map<string, number>();
    const id = (i: number) => {
        const k = [0, 1, 2].map(a => Math.round(t.positions[3 * i + a] * 1e5)).join(',');
        if (!ids.has(k)) ids.set(k, ids.size);
        return ids.get(k)!;
    };
    const directed = new Map<string, number>();
    let volume = 0;
    for (let f = 0; f < t.indices.length; f += 3) {
        const [a, b, c] = [0, 1, 2].map(k => t.indices[f + k]);
        const p = (i: number) => [t.positions[3 * i], t.positions[3 * i + 1], t.positions[3 * i + 2]];
        const [P, Q, R] = [p(a), p(b), p(c)];
        volume += (P[0] * (Q[1] * R[2] - Q[2] * R[1]) - P[1] * (Q[0] * R[2] - Q[2] * R[0]) + P[2] * (Q[0] * R[1] - Q[1] * R[0])) / 6;
        const w = [id(a), id(b), id(c)];
        for (let k = 0; k < 3; k++) {
            if (w[k] === w[(k + 1) % 3]) continue;
            const key = `${w[k]}>${w[(k + 1) % 3]}`;
            directed.set(key, (directed.get(key) ?? 0) + 1);
        }
    }
    let open = 0, doubled = 0;
    for (const [k, n] of directed) {
        const [x, y] = k.split('>');
        if (!directed.has(`${y}>${x}`)) open++;
        if (n > 1) doubled++;
    }
    return { volume, open, doubled, triangles: t.indices.length / 3 };
}

const service = new NativeMeshEditService();
const input = writeFixtureGlb(path.join(WORK, 'block.glb'), block());
// a regular 48-gon of radius 0.3 (the cylinder's cross-section)
const holeArea = 0.5 * 48 * 0.09 * Math.sin((2 * Math.PI) / 48);

const DRILL: MeshEditOperation = { type: 'boolean', op: 'subtract', operand: { cylinder: { start: [0, -1, 0], end: [0, 1, 0], radius: 0.3, segments: 48 } } };
const BOSS: MeshEditOperation = { type: 'extrude', select: { direction: [1, 0, 0], coneDeg: 10, regionMin: [0.9, 0, 0] }, distance: 0.4, inset: 0.15 };

describe('mesh_edit: booleans, cuts and extrusions on a given mesh', () => {
    it('drills a hole through the block: closed, and the volume less the hole', async () => {
        const r = await service.edit({ inputGlbPath: input, outputGlbPath: path.join(WORK, 'drilled.glb'), operations: [DRILL] });
        const s = solidStats(r.outputGlbPath);
        expect(r.openEdges).toBe(0);
        expect(s.open).toBe(0);
        expect(s.doubled).toBe(0);
        expect(s.volume).toBeCloseTo(4 - holeArea * 1, 4);
        // the faces away from the hole are not broken up by the cut: the +X face is still a handful of triangles
        const t = readGlbTriangles(fs.readFileSync(r.outputGlbPath));
        let plusX = 0;
        for (let f = 0; f < t.indices.length; f += 3) if ([0, 1, 2].every(k => Math.abs(t.positions[3 * t.indices[f + k]] - 1) < 1e-6)) plusX++;
        expect(plusX).toBeLessThan(24);
    }, 120_000);

    it('insets and extrudes the +X face into a boss: a ring in the face and straight walls', async () => {
        const r = await service.edit({ inputGlbPath: input, outputGlbPath: path.join(WORK, 'boss.glb'), operations: [DRILL, BOSS] });
        const s = solidStats(r.outputGlbPath);
        expect(s.open).toBe(0);
        expect(s.doubled).toBe(0);
        // the boss is (2 - 0.3) x (1 - 0.3) x 0.4 m
        expect(s.volume).toBeCloseTo(4 - holeArea + 1.7 * 0.7 * 0.4, 4);
        expect(r.boundsMax[0]).toBeCloseTo(1.4, 5);
        expect(r.operations[1]).toMatchObject({ type: 'extrude', selectedFaces: expect.any(Number) });
    }, 120_000);

    it('a direction alone also catches the far wall of the hole, and the counts say so', async () => {
        const r = await service.edit({ inputGlbPath: input, outputGlbPath: path.join(WORK, 'wide.glb'), operations: [DRILL, { ...BOSS, select: { direction: [1, 0, 0], coneDeg: 10 } } as MeshEditOperation] });
        const narrow = await service.edit({ inputGlbPath: input, outputGlbPath: path.join(WORK, 'narrow.glb'), operations: [DRILL, BOSS] });
        expect(Number(r.operations[1].selectedFaces)).toBeGreaterThan(Number(narrow.operations[1].selectedFaces));
    }, 120_000);

    it('merges a sphere and slices the front off: still closed, and renders', async () => {
        const r = await service.edit({
            inputGlbPath: input, outputGlbPath: path.join(WORK, 'final.glb'),
            operations: [DRILL, BOSS, { type: 'boolean', op: 'union', operand: { sphere: { center: [-1, 0.5, 0], radius: 0.4 } } }, { type: 'cut', point: [0, 0, 0.8], normal: [0, 0, 1] }]
        });
        const s = solidStats(r.outputGlbPath);
        expect(r.openEdges).toBe(0);
        expect(s.open).toBe(0);
        expect(r.boundsMax[2]).toBeCloseTo(0.8, 5);
        expect(r.boundsMin[0]).toBeCloseTo(-1.4, 2);
        expect(r.boundsMax[1]).toBeCloseTo(0.9, 2);
        // three quarters of the sphere stand outside the block; the slice takes the block's front 0.2 m and the boss's 0.05 m
        const sphere = s.volume - (4 - holeArea + 1.7 * 0.7 * 0.4 - (2 * 1 - holeArea * 0) * 0.2 - 0.7 * 0.4 * 0.05);
        expect(sphere).toBeGreaterThan(0.75 * (4 / 3) * Math.PI * 0.064 * 0.9);
        expect(sphere).toBeLessThan(0.75 * (4 / 3) * Math.PI * 0.064 * 1.01);
        const t = readGlbTriangles(fs.readFileSync(r.outputGlbPath));
        fs.mkdirSync(SHOTS, { recursive: true });
        fs.writeFileSync(path.join(SHOTS, 'mesh-edit-block.png'), renderClayPng([{ positions: t.positions, indices: t.indices }], { kind: 'aerial', width: 900, height: 640, bearingDeg: 150, elevationDeg: 35 }));
    }, 120_000);

    it('refuses what it cannot do faithfully, with the reason', async () => {
        await expect(service.edit({ inputGlbPath: input, operations: [] })).rejects.toBeInstanceOf(MissingInputError);
        await expect(service.edit({ inputGlbPath: path.join(WORK, 'none.glb'), operations: [DRILL] })).rejects.toBeInstanceOf(MissingInputError);
        await expect(service.edit({ inputGlbPath: input, operations: [{ type: 'boolean', op: 'subtract', operand: { sphere: { center: [9, 9, 9], radius: 0.1 } } }, { type: 'cut', point: [0, -2, 0], normal: [0, 1, 0] }] }))
            .rejects.toThrow(/left nothing/);
        await expect(service.edit({ inputGlbPath: input, operations: [{ type: 'extrude', select: { direction: [0, 0, 0] } } as MeshEditOperation] })).rejects.toThrow(/distance or an inset/);
    }, 120_000);

    it('the tool runs the same edits and says whether the result is closed', async () => {
        const res = await meshShapingHandlers.mesh_edit({ inputGlbPath: input, outputGlbPath: path.join(WORK, 'tool.glb'), operations: [DRILL] }, {} as never);
        expect(res.status).toBe('completed');
        expect(res.summaryResult).toMatch(/a closed solid/);
    }, 120_000);

    it('modelling requests are routed to mesh_edit, deformations still to mesh_apply_deformers', () => {
        for (const ask of ['drill a hole through this mesh', 'extrude the top face of the mesh by 20 cm', 'subtract a cylinder from this mesh', 'slice this 3D mesh in half with a plane']) {
            expect(resolveTaskCapability(ask).tier1Assessment.suggestedNativeAction?.targetTool, ask).toBe('mesh_edit');
        }
        // with a 3D scene open, a request that never says "mesh" goes there too
        expect(resolveTaskCapability('drill a hole through this block', { activeArtifact: { type: '3d-scene' } } as never).tier1Assessment.suggestedNativeAction?.targetTool).toBe('mesh_edit');
        expect(resolveTaskCapability('taper the top of this mesh and twist it 45 degrees').tier1Assessment.suggestedNativeAction?.targetTool).toBe('mesh_apply_deformers');
    });
});
