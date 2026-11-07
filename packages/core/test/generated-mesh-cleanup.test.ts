/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { assertGeneratedSource, cleanupGeneratedGlb } from '../src/node/3d-engine/generated-mesh-cleanup-service';

/** A one-mesh binary glTF from positions and indices (optional mesh extras). */
function glbOf(positions: number[], indices: number[], extras?: Record<string, unknown>): Buffer {
    const pos = Buffer.from(new Float32Array(positions).buffer), idx = Buffer.from(new Uint32Array(indices).buffer);
    const min = [0, 1, 2].map(k => Math.min(...positions.filter((_, i) => i % 3 === k)));
    const max = [0, 1, 2].map(k => Math.max(...positions.filter((_, i) => i % 3 === k)));
    const json: any = {
        asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
        meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }], ...(extras ? { extras } : {}) }],
        buffers: [{ byteLength: pos.length + idx.length }],
        bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: pos.length }, { buffer: 0, byteOffset: pos.length, byteLength: idx.length }],
        accessors: [
            { bufferView: 0, componentType: 5126, count: positions.length / 3, type: 'VEC3', min, max },
            { bufferView: 1, componentType: 5125, count: indices.length, type: 'SCALAR' }
        ]
    };
    let text = JSON.stringify(json);
    while (text.length % 4) text += ' ';
    const jsonBuf = Buffer.from(text), bin = Buffer.concat([pos, idx]);
    const head = Buffer.alloc(12);
    head.writeUInt32LE(0x46546c67, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(12 + 8 + jsonBuf.length + 8 + bin.length, 8);
    const c0 = Buffer.alloc(8); c0.writeUInt32LE(jsonBuf.length, 0); c0.writeUInt32LE(0x4e4f534a, 4);
    const c1 = Buffer.alloc(8); c1.writeUInt32LE(bin.length, 0); c1.writeUInt32LE(0x004e4942, 4);
    return Buffer.concat([head, c0, jsonBuf, c1, bin]);
}

/** A torus (genus 1) with a strip of triangles removed: an open, generated-looking shell. */
function punchedTorus(R = 1, r = 0.35, nu = 120, nv = 48): { positions: number[]; indices: number[] } {
    const positions: number[] = [], indices: number[] = [];
    for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) {
        const u = (i / nu) * Math.PI * 2, v = (j / nv) * Math.PI * 2;
        positions.push((R + r * Math.cos(v)) * Math.cos(u), r * Math.sin(v), (R + r * Math.cos(v)) * Math.sin(u));
    }
    for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) {
        if (i >= 10 && i < 12 && j >= 4 && j < 9) continue;  // the hole: about 4 cm across
        const a = i * nv + j, b = ((i + 1) % nu) * nv + j, c = ((i + 1) % nu) * nv + ((j + 1) % nv), d = i * nv + ((j + 1) % nv);
        indices.push(a, c, b, a, d, c);
    }
    return { positions, indices };
}

describe('generated mesh cleanup (voxel -> quad -> subdivision -> projection)', () => {
    it('refuses anything not labelled generated, by the caller or by the GLB', () => {
        const t = punchedTorus(1, 0.35, 12, 8);
        expect(() => assertGeneratedSource(glbOf(t.positions, t.indices), 'measured')).toThrow(/refused/);
        expect(() => assertGeneratedSource(glbOf(t.positions, t.indices, { provenance: 'measured' }), 'generated')).toThrow(/measured/);
        expect(() => assertGeneratedSource(glbOf(t.positions, t.indices, { provenance: 'generated' }), 'generated')).not.toThrow();
    });

    it('closes a punched torus into one watertight genus-1 surface within distance bounds', async () => {
        const t = punchedTorus();
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-gen-cleanup-test-'));
        const r = await cleanupGeneratedGlb(glbOf(t.positions, t.indices), { provenance: 'generated', targetQuads: 1500, subdivisions: 1, transferTextures: false, workDir: dir });
        const rep = r.report;
        expect(rep.ok).toBe(true);
        // the source is open (the punched strip); the result is closed, manifold, consistently oriented, genus 1
        expect(rep.before.openEdges).toBeGreaterThan(10);
        expect(rep.after!.openEdges).toBe(0);
        expect(rep.after!.nonManifoldEdges).toBe(0);
        expect(rep.after!.nonManifoldVertices).toBe(0);
        expect(rep.after!.watertight).toBe(true);
        expect(rep.after!.genus).toBe(1);
        expect(rep.after!.components).toBe(1);
        // geometry: the result lies on the source (95% within 0.2% of the diagonal); worst case is the sealed hole
        const diag = rep.hausdorff!.diagonal;
        expect(rep.hausdorff!.resultToSource.p95).toBeLessThan(0.002 * diag);
        expect(rep.hausdorff!.sourceToResult.p95).toBeLessThan(0.002 * diag);
        expect(rep.hausdorff!.max).toBeLessThan(0.03 * diag);
        // the quad stage: mostly quads, far fewer irregular vertices than faces, and Catmull-Clark made it all quads
        expect(rep.report.quad.quads / rep.report.quad.polygons).toBeGreaterThan(0.9);
        expect(rep.report.quad.singularities).toBeLessThan(0.08 * rep.report.quad.polygons);
        expect(rep.report.subdividedFaces).toBeGreaterThanOrEqual(4 * rep.report.quad.quads);
        expect(rep.after!.triangles).toBeGreaterThanOrEqual(2 * rep.report.subdividedFaces);
        // a labelled glTF
        expect(r.glb.toString('utf8', 0, 4)).toBe('glTF');
        const json = JSON.parse(r.glb.subarray(20, 20 + r.glb.readUInt32LE(12)).toString('utf8'));
        expect(json.meshes.every((m: any) => m.extras?.provenance === 'generated')).toBe(true);
        expect(r.provenance).toBe('generated');
        fs.rmSync(dir, { recursive: true, force: true });
    }, 600_000);

    it('refuses its own result when it strays past the fidelity gate (the model is kept as built)', async () => {
        const t = punchedTorus(1, 0.35, 60, 24);
        await expect(cleanupGeneratedGlb(glbOf(t.positions, t.indices), { provenance: 'generated', targetQuads: 400, transferTextures: false, maxP95Fraction: 1e-7 }))
            .rejects.toThrow(/refused its own result/);
    }, 600_000);
});
