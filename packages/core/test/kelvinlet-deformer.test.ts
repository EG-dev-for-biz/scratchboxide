/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Kelvinlet deformation (scratchbox_kelvinlet.hpp) on real meshes: the native checks in test_kelvinlet.cpp (a UV
 * sphere and a revolved vase), and the kelvinlet operation of mesh_apply_deformers. Renders of the plain-falloff
 * brushes against the Kelvinlet loads go to test-results/screenshots/kelvinlet/.
 */

import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { compileNativeCached, defaultNativeFlags } from '../src/node/3d-engine/native-build-cache';
import { NativeMeshReshaperService } from '../src/node/3d-engine/native-mesh-reshaper-service';
import { MESH_SHAPING_TOOL_DECLARATIONS } from '../src/node/gemini/tools/mesh-shaping-tools';
import { MissingInputError } from '../src/common/errors/pipeline-errors';
import { HeadlessMeshSilhouetteRenderer } from '../src/node/spatial/HeadlessMeshSilhouetteRenderer';
import { cylinderMesh, readGlbPositions, writeFixtureGlb } from './helpers/mesh-glb-fixtures';

const REPO = path.resolve(__dirname, '../../..');
const ENGINE = path.join(REPO, 'packages/core/src/native/3d-engine');
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-kelvinlet-'));
const SHOTS = path.join(REPO, 'test-results/screenshots/kelvinlet');
afterAll(() => fs.rmSync(WORK, { recursive: true, force: true }));

let checks: any;
async function runNativeChecks(): Promise<any> {
    if (checks) return checks;
    const built = await compileNativeCached({
        sourcePath: path.join(ENGINE, 'test_kelvinlet.cpp'),
        includeDirs: [path.join(ENGINE, 'include')],
        flags: defaultNativeFlags(),
        libs: ['-lz'],
        name: 'test_kelvinlet',
        timeoutMs: 600_000
    });
    // Opt-in proof on real data: SCRATCHBOX_KELVINLET_REAL="name:/path/a.glb;name2:/path/b.glb:u,v,w" (copies cut from cached tiles or builds).
    const real = (process.env.SCRATCHBOX_KELVINLET_REAL || '').split(';').filter(Boolean);
    checks = JSON.parse(execFileSync(built.binaryPath, [path.join(WORK, 'proof'), ...real], { encoding: 'utf8', maxBuffer: 1 << 24 }));
    return checks;
}

describe('Kelvinlet deformer (native, on a sphere and a revolved vase)', () => {
    it('a grab moves the load point by exactly the asked displacement, even a large one, in several steps', async () => {
        const c = await runNativeChecks();
        expect(c.grab.error).toBeLessThan(1e-5);
        expect(c.grab.steps).toBeGreaterThan(1);
    }, 600_000);

    it('displacement decays with distance as the closed form predicts; more scales decay faster (1/r, 1/r^3, 1/r^5)', async () => {
        const c = await runNativeChecks();
        expect(c.decay.maxRelErr).toBeLessThan(1e-5);
        for (const s of c.decay.samples) {
            expect(s.perp).toBeCloseTo(s.perpFormula, 6);
            expect(s.along).toBeCloseTo(s.alongFormula, 6);
        }
        const perp = c.decay.samples.map((s: any) => s.perp);
        for (let i = 1; i < perp.length; i++) expect(perp[i]).toBeLessThan(perp[i - 1]);
        expect(c.decay.slopes[0]).toBeCloseTo(-1, 1);
        expect(c.decay.slopes[1]).toBeCloseTo(-3, 1);
        expect(c.decay.slopes[2]).toBeCloseTo(-5, 1);
        // A small integrated grab on the mesh matches the closed form at every vertex.
        expect(c.decay.meshVsFormula).toBeLessThan(1e-2);
    }, 600_000);

    it('with Poisson ratio 0.5 the volume is kept; a compressible material changes it', async () => {
        const c = await runNativeChecks();
        expect(Math.abs(c.volume.nu50.grab)).toBeLessThan(1e-3);
        expect(Math.abs(c.volume.nu50.pinch)).toBeLessThan(1e-3);
        expect(Math.abs(c.volume.nu20.grab)).toBeGreaterThan(0.01);
    }, 600_000);

    it('a twist keeps every point\'s distance to the axis and its height along it', async () => {
        const c = await runNativeChecks();
        for (const shape of ['sphere', 'vase']) {
            expect(c.twist[shape].maxMove).toBeGreaterThan(0.2);
            expect(c.twist[shape].radialError).toBeLessThan(1e-5);
            expect(c.twist[shape].axialError).toBeLessThan(1e-5);
        }
    }, 600_000);

    it('scale and pinch do what was asked at the load point; a uniform scale of an incompressible medium is refused', async () => {
        const c = await runNativeChecks();
        expect(c.affine.scaleGot).toBeCloseTo(c.affine.scaleAsked, 2);
        expect(c.affine.pinchAlong).toBeCloseTo(c.affine.pinchAlongAsked, 2);
        expect(c.affine.pinchAcross).toBeCloseTo(c.affine.pinchAcrossAsked, 2);
        expect(c.affine.incompressibleScale).toContain('compressible material');
    }, 600_000);

    it('the sharp (bi- and tri-scale) versions localise, and weights hold masked vertices still', async () => {
        const c = await runNativeChecks();
        const [one, two, three] = c.localise;
        expect(one).toBeGreaterThan(0.9);
        expect(two).toBeLessThan(one * 0.7);
        expect(three).toBeLessThan(two * 0.8);
        expect(c.maskedMaxMove).toBe(0);
    }, 600_000);

    it('renders the plain-falloff brushes against the Kelvinlet loads (sphere, vase and any real meshes given)', async () => {
        await runNativeChecks();
        fs.mkdirSync(SHOTS, { recursive: true });
        const shapes = fs.readdirSync(path.join(WORK, 'proof')).filter(f => f.endsWith('_load.json')).map(f => f.replace(/_load\.json$/, ''));
        expect(shapes).toEqual(expect.arrayContaining(['sphere', 'vase']));
        for (const shape of shapes) {
            const { min, max } = readGlbPositions(path.join(WORK, 'proof', `${shape}_original.glb`));
            let cx = (min[0] + max[0]) / 2, cy = (min[1] + max[1]) / 2, cz = (min[2] + max[2]) / 2;
            let span = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
            const load = JSON.parse(fs.readFileSync(path.join(WORK, 'proof', `${shape}_load.json`), 'utf8'));
            // A shape much larger than its load is framed on the load point, 12 epsilon across.
            if (12 * load.epsilon < span) {
                [cx, cy, cz] = load.point as number[];
                span = 12 * load.epsilon;
            }
            const camera = { x: cx + span * 1.05, y: cy + span * 0.45, z: cz + span * 1.4, targetX: cx, targetY: cy, targetZ: cz, fov: 45 };
            // The side view: looking across the load's normal, so a grab along it shows on the silhouette.
            const n = load.normal as number[];
            const sx = n[2], sz = -n[0], sl = Math.hypot(sx, sz) || 1;  // horizontal, perpendicular to the normal
            const side = { x: cx + (sx / sl) * span * 1.9, y: cy + span * 0.15, z: cz + (sz / sl) * span * 1.9, targetX: cx + n[0] * span * 0.15, targetY: cy, targetZ: cz + n[2] * span * 0.15, fov: 45 };
            const views: Array<[string, typeof camera]> = [['front', camera], ['side', side]];
            for (const variant of ['original', 'grab_plain', 'grab_kelvinlet', 'twist_plain', 'twist_kelvinlet', 'pinch_plain', 'pinch_kelvinlet']) {
                const mesh = HeadlessMeshSilhouetteRenderer.loadMeshFromGlb(path.join(WORK, 'proof', `${shape}_${variant}.glb`));
                for (const [view, cam] of views) {
                    const shot = HeadlessMeshSilhouetteRenderer.renderShadedMesh(mesh, cam, 480, 480, { clayColor: [168, 172, 178] });
                    const file = path.join(SHOTS, `${shape}_${variant}_${view}.png`);
                    HeadlessMeshSilhouetteRenderer.exportPngToFile(file, 480, 480, shot.rgba);
                    expect(fs.statSync(file).size).toBeGreaterThan(1000);
                }
            }
        }
    }, 600_000);
});

describe('mesh_apply_deformers kelvinlet operation', () => {
    it('is declared with its continuous parameters', () => {
        const decl = MESH_SHAPING_TOOL_DECLARATIONS.find(d => d.name === 'mesh_apply_deformers')!;
        expect(decl.description).toContain('kelvinlet {center, radius');
        const props = (decl.parameters.properties!.operations as any).items.properties;
        for (const key of ['displacement', 'twistDeg', 'twistAxis', 'scaleFactor', 'pinchStrength', 'pinchDirection', 'poissonRatio', 'falloffScales']) {
            expect(props[key]).toBeDefined();
        }
    });

    it('a grab at a vertex on the top rim of a tube moves that vertex by the asked fraction of the diagonal', async () => {
        // The open tube's rim vertex at angle 0 is (1, 2, 0): fractions [1, 1, 0.5] of its bounds.
        const input = writeFixtureGlb(path.join(WORK, 'cyl.glb'), cylinderMesh(1, 4, 48, 32));
        const before = readGlbPositions(input);
        const diag = Math.hypot(before.max[0] - before.min[0], before.max[1] - before.min[1], before.max[2] - before.min[2]);
        const r = await NativeMeshReshaperService.reshapeMesh({
            inputGlbPath: input, outputGlbPath: path.join(WORK, 'cyl_kelvinlet.glb'),
            operations: [{ type: 'kelvinlet', center: [1, 1, 0.5], radius: 0.1, displacement: [0, 0.2, 0] }]
        });
        const after = readGlbPositions(r.outputGlbPath);
        let top = 0;
        for (let i = 1; i < after.positions.length; i += 3) if (after.positions[i] > after.positions[top * 3 + 1]) top = (i - 1) / 3;
        const p = [after.positions[top * 3], after.positions[top * 3 + 1], after.positions[top * 3 + 2]];
        expect(p[0]).toBeCloseTo(1, 3);
        expect(p[1]).toBeCloseTo(2 + 0.2 * diag, 3);
        expect(p[2]).toBeCloseTo(0, 3);
        // The far end barely moves: the elastic field decays with distance.
        expect(Math.abs(after.min[1] - before.min[1])).toBeLessThan(0.05 * diag);
    }, 600_000);

    it('refuses an operation with no load, and a uniform scale of an incompressible medium, with the reason', async () => {
        const input = writeFixtureGlb(path.join(WORK, 'cyl2.glb'), cylinderMesh());
        await expect(NativeMeshReshaperService.reshapeMesh({ inputGlbPath: input, operations: [{ type: 'kelvinlet', center: [0.5, 0.5, 0.5], radius: 0.2 }] }))
            .rejects.toThrow('kelvinlet needs at least one load');
        await expect(NativeMeshReshaperService.reshapeMesh({ inputGlbPath: input, operations: [{ type: 'kelvinlet', center: [0.5, 0.5, 0.5], radius: 0.2, scaleFactor: 1.5 }] }))
            .rejects.toBeInstanceOf(MissingInputError);
        const ok = await NativeMeshReshaperService.reshapeMesh({
            inputGlbPath: input,
            operations: [{ type: 'kelvinlet', center: [0.5, 0.5, 0.5], radius: 0.2, scaleFactor: 1.5, poissonRatio: 0.3 }]
        });
        expect(ok.telemetry.outputVertices).toBe(ok.telemetry.inputVertices);
    }, 600_000);

    it('the falloff sculpt grab and pinch it replaced are refused, naming the kelvinlet operation', async () => {
        const input = writeFixtureGlb(path.join(WORK, 'cyl3.glb'), cylinderMesh());
        for (const brush of ['grab', 'pinch']) {
            await expect(NativeMeshReshaperService.reshapeMesh({
                inputGlbPath: input,
                operations: [{ type: 'sculpt', sculptBrush: brush as any, center: [0.5, 1, 0.5], radius: 0.2, strength: 0.05, direction: [0, 1, 0] }]
            })).rejects.toThrow('is now the kelvinlet operation');
        }
    }, 600_000);
});
