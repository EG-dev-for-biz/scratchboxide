/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Native mesh reshaping takes a given mesh and explicit operations whose positions and magnitudes are fractions of
 * the mesh's measured bounds. Nothing is read from prose, nothing is applied by default, and no stand-in mesh is
 * built. Input meshes are test fixtures written to GLB; renders of the results go to test-results/screenshots/.
 */

import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { MissingInputError } from '../src/common/errors/pipeline-errors';
import * as ReshaperModule from '../src/node/3d-engine/native-mesh-reshaper-service';
import { NativeMeshReshaperService, MeshReshapingService } from '../src/node/3d-engine/native-mesh-reshaper-service';
import { MESH_SHAPING_TOOL_DECLARATIONS, meshShapingHandlers } from '../src/node/gemini/tools/mesh-shaping-tools';
import { createDefaultToolRegistry } from '../src/node/gemini/tool-registry';
import { resolveTaskCapability } from '../src/node/agent/task-capability-resolver';
import { createOperatorEngine } from '../src/browser/generative-canvas/services/direct-dispatch-operator-engine';
import { HeadlessMeshSilhouetteRenderer } from '../src/node/spatial/HeadlessMeshSilhouetteRenderer';
import { cylinderMesh, readGlbJson, readGlbPositions, rewriteGlbJson, writeFixtureGlb, type FixtureMesh } from './helpers/mesh-glb-fixtures';
import { rawMeshReadIssues } from '../src/node/3d-engine/native-pipeline-binary';

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-mesh-reshape-'));
const SHOTS = path.resolve(__dirname, '../../../test-results/screenshots');
afterAll(() => fs.rmSync(WORK, { recursive: true, force: true }));

/** The cylinder fixture scaled by `scale` and moved to `offset`: the same shape at another size and place. */
function placedCylinder(scale: number, offset: [number, number, number]): FixtureMesh {
    const c = cylinderMesh();
    return { ...c, positions: c.positions.map((v, i) => v * scale + offset[i % 3]) };
}

/** Max horizontal distance from (cx, cz) among vertices within `tol` of height y. */
function ringRadius(positions: Float32Array, y: number, tol: number, cx: number, cz: number): number {
    let r = 0;
    for (let i = 0; i < positions.length; i += 3) {
        if (Math.abs(positions[i + 1] - y) <= tol) r = Math.max(r, Math.hypot(positions[i] - cx, positions[i + 2] - cz));
    }
    return r;
}

function saveRender(name: string, glbPath: string): void {
    const mesh = HeadlessMeshSilhouetteRenderer.loadMeshFromGlb(glbPath);
    const { min, max } = readGlbPositions(glbPath);
    const c = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
    const span = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
    const shot = HeadlessMeshSilhouetteRenderer.renderShadedMesh(mesh, {
        x: c[0] + span * 1.2, y: c[1] + span * 0.6, z: c[2] + span * 1.6, targetX: c[0], targetY: c[1], targetZ: c[2], fov: 45
    }, 320, 320, { clayColor: [150, 155, 160] });
    fs.mkdirSync(SHOTS, { recursive: true });
    HeadlessMeshSilhouetteRenderer.exportPngToFile(path.join(SHOTS, name), 320, 320, shot.rgba);
}

describe('Native mesh reshaping takes explicit operations on a given mesh', () => {
    it('there is no prompt parser and no default operation: a missing mesh or empty operation list is refused', async () => {
        expect((ReshaperModule as any).parsePromptToMeshOperations).toBeUndefined();
        expect((NativeMeshReshaperService as any).parsePromptToOperations).toBeUndefined();
        const input = writeFixtureGlb(path.join(WORK, 'cyl.glb'), cylinderMesh());
        await expect(NativeMeshReshaperService.reshapeMesh({ inputGlbPath: input, operations: [] })).rejects.toBeInstanceOf(MissingInputError);
        await expect(NativeMeshReshaperService.reshapeMesh({ operations: [{ type: 'twist', axis: 'Y', angleDeg: 30, range: [0, 1] }] } as any)).rejects.toThrow('needs inputGlbPath');
        await expect(NativeMeshReshaperService.reshapeMesh({ prompt: 'taper the top', inputGlbPath: input } as any)).rejects.toThrow('needs operations');
    });

    it('the native pipeline requires --input and builds no stand-in mesh', async () => {
        const bin = await new NativeMeshReshaperService().ensureBinary();
        const run = await promisify(execFile)(bin, ['--output', path.join(WORK, 'none.glb'), '--operationsJson', '[{"type":"repair"}]']).catch(e => e);
        expect(run.code).toBe(2);
        expect(String(run.stderr)).toContain('--input <mesh.glb> is required');
        expect(fs.existsSync(path.join(WORK, 'none.glb'))).toBe(false);
        const benchmark = await promisify(execFile)(bin, ['--benchmark', 'cylinder', '--output', path.join(WORK, 'none.glb')]).catch(e => e);
        expect(benchmark.code).toBe(2);
    });

    it('a taper is relative to the measured bounds: the same operation shapes a 4 m and a 60 m cylinder alike, about its own centre line', async () => {
        const operations = [{ type: 'taper', axis: 'Y', factor: 0.5, range: [0, 1] as [number, number] }];
        const small = writeFixtureGlb(path.join(WORK, 'small.glb'), placedCylinder(1, [0, 0, 0]));
        const big = writeFixtureGlb(path.join(WORK, 'big.glb'), placedCylinder(15, [500, 20, -300]));

        const smallOut = await MeshReshapingService.reshapeMesh({ inputGlbPath: small, operations, outputGlbPath: path.join(WORK, 'small_taper.glb') });
        const bigOut = await MeshReshapingService.reshapeMesh({ inputGlbPath: big, operations, outputGlbPath: path.join(WORK, 'big_taper.glb') });
        expect(smallOut.success).toBe(true);
        expect(smallOut.glbBuffer!.readUInt32LE(0)).toBe(0x46546c67);
        expect(bigOut.telemetry.inputBoundsMin).toEqual([485, -10, -315]);
        expect(bigOut.telemetry.inputBoundsMax).toEqual([515, 50, -285]);

        const s = readGlbPositions(smallOut.outputGlbPath).positions;
        const b = readGlbPositions(bigOut.outputGlbPath).positions;
        expect(ringRadius(s, -2, 0.01, 0, 0)).toBeCloseTo(1, 2);
        expect(ringRadius(s, 2, 0.01, 0, 0)).toBeCloseTo(0.5, 2);
        // Scaled by 15 and moved: the top ring is half the radius and still centred on the cylinder's own axis.
        expect(ringRadius(b, -10, 0.1, 500, -300)).toBeCloseTo(15, 1);
        expect(ringRadius(b, 50, 0.1, 500, -300)).toBeCloseTo(7.5, 1);
        saveRender('mesh_apply_deformers_taper_60m.png', bigOut.outputGlbPath);
    });

    it('a bend turns the whole extent through the given angle, keeping its base fixed', async () => {
        const input = writeFixtureGlb(path.join(WORK, 'bend_in.glb'), cylinderMesh(0.2, 4));
        const out = await NativeMeshReshaperService.reshapeMesh({
            inputGlbPath: input,
            operations: [{ type: 'bend', axis: 'Y', secondaryAxis: 'X', angleDeg: 90 }],
            outputGlbPath: path.join(WORK, 'bend_out.glb')
        });
        const p = readGlbPositions(out.outputGlbPath);
        // Arc length 4 over 90 degrees: radius 4 / (pi / 2). The base stays at y = -2; the top end ends up at
        // y = -2 + R and x = R, pointing along +X.
        const R = 4 / (Math.PI / 2);
        expect(p.min[1]).toBeCloseTo(-2, 1);
        expect(p.max[0]).toBeGreaterThan(R - 0.05);
        expect(p.max[0]).toBeLessThan(R + 0.25);
        expect(p.max[1]).toBeLessThan(-2 + R + 0.25);
        saveRender('mesh_apply_deformers_bend_90.png', out.outputGlbPath);
    });

    it('an invalid or unknown operation fails with the reason, and nothing is written', async () => {
        const input = writeFixtureGlb(path.join(WORK, 'invalid_in.glb'), cylinderMesh());
        const out = path.join(WORK, 'invalid_out.glb');
        await expect(NativeMeshReshaperService.reshapeMesh({ inputGlbPath: input, outputGlbPath: out, operations: [{ type: 'taper', axis: 'Y', factor: 0.5 }] }))
            .rejects.toThrow('operation 0: taper needs range');
        await expect(NativeMeshReshaperService.reshapeMesh({ inputGlbPath: input, outputGlbPath: out, operations: [{ type: 'twist', axis: 'Y', angleDeg: 20, range: [0, 1] }, { type: 'squash', factor: 0.7 }] }))
            .rejects.toThrow('operation 1: unknown operation type "squash"');
        await expect(NativeMeshReshaperService.reshapeMesh({ inputGlbPath: input, outputGlbPath: out, operations: [{ type: 'bulge', center: [0.5, 0.5, 0.5], radius: 0.3 }] }))
            .rejects.toBeInstanceOf(MissingInputError);
        expect(fs.existsSync(out)).toBe(false);
    });
});

describe('Agent tools and routing', () => {
    it('mesh_apply_deformers is the only mesh tool; mesh_reshape_via_prompt and the tile restructure tools are gone', () => {
        expect(MESH_SHAPING_TOOL_DECLARATIONS.map(d => d.name)).toEqual(['mesh_apply_deformers']);
        expect(Object.keys(meshShapingHandlers)).toEqual(['mesh_apply_deformers']);
        const names = createDefaultToolRegistry().names();
        for (const removed of ['mesh_reshape_via_prompt', 'tile_restructure_via_prompt', 'tile_apply_terraforming_and_primitives']) {
            expect(names).not.toContain(removed);
        }
        const decl = MESH_SHAPING_TOOL_DECLARATIONS[0];
        expect(decl.parameters!.required).toEqual(['operations', 'inputGlbPath']);
        expect(decl.description).toContain('fractions of the mesh\'s measured bounding box');
    });

    it('dispatches mesh_apply_deformers on a given GLB and reports the measured bounds', async () => {
        const inputGlbPath = writeFixtureGlb(path.join(WORK, 'tool_in.glb'), placedCylinder(3, [10, 0, 0]));
        const outcome = await meshShapingHandlers.mesh_apply_deformers({
            inputGlbPath,
            outputGlbPath: path.join(WORK, 'tool_out.glb'),
            operations: [{ type: 'twist', axis: 'Y', angleDeg: 90, range: [0.5, 1] }]
        }, {} as any);
        expect(outcome.status).toBe('completed');
        expect((outcome.resultPayload as any).telemetry.inputVertices).toBeGreaterThan(0);
        expect(outcome.summaryResult).toContain('measured bounds [7, -6, -3] to [13, 6, 3]');
        expect(fs.readFileSync(path.join(WORK, 'tool_out.glb')).readUInt32LE(0)).toBe(0x46546c67);

        await expect(meshShapingHandlers.mesh_apply_deformers({ operations: [{ type: 'repair' }], inputGlbPath: path.join(WORK, 'missing.glb') }, {} as any))
            .rejects.toThrow('does not exist');
        await expect(meshShapingHandlers.mesh_apply_deformers({ operations: [], inputGlbPath }, {} as any))
            .rejects.toThrow('mesh_apply_deformers needs operations');
    });

    it('refuses a GLB the native reader would misplace or the writer would strip, instead of returning it moved or untextured', async () => {
        const moved = rewriteGlbJson(writeFixtureGlb(path.join(WORK, 'moved.glb'), cylinderMesh(1, 4)), g => {
            g.nodes[0].translation = [100, 0, 50];
            g.nodes[0].scale = [10, 10, 10];
        });
        const issues = rawMeshReadIssues(fs.readFileSync(moved));
        expect(issues.geometry[0]).toContain('places its mesh with translation [100,0,50], scale [10,10,10]');
        await expect(meshShapingHandlers.mesh_apply_deformers({ inputGlbPath: moved, operations: [{ type: 'repair' }] }, {} as any))
            .rejects.toThrow(/cannot be reshaped faithfully: node 0 places its mesh with translation \[100,0,50\]/);

        const textured = rewriteGlbJson(writeFixtureGlb(path.join(WORK, 'textured.glb'), cylinderMesh(1, 4)), g => {
            g.images = [{ uri: 'data:image/png;base64,AA==' }];
            g.textures = [{ source: 0 }];
            g.materials = [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }];
        });
        await expect(meshShapingHandlers.mesh_apply_deformers({ inputGlbPath: textured, operations: [{ type: 'repair' }] }, {} as any))
            .rejects.toThrow(/1 texture\(s\), which the native writer does not carry over/);

        const instanced = rewriteGlbJson(writeFixtureGlb(path.join(WORK, 'instanced.glb'), cylinderMesh(1, 4)), g => {
            g.nodes.push({ mesh: 0 });
            g.scenes[0].nodes.push(1);
        });
        expect(rawMeshReadIssues(fs.readFileSync(instanced)).geometry).toContain('mesh 0 is instanced by 2 nodes');
        // A plain GLB, and an explicit identity transform, read faithfully.
        const identity = rewriteGlbJson(writeFixtureGlb(path.join(WORK, 'identity.glb'), cylinderMesh(1, 4)), g => { g.nodes[0].translation = [0, 0, 0]; });
        expect(rawMeshReadIssues(fs.readFileSync(identity))).toEqual({ geometry: [], content: [] });
    });

    it('refuses a rigged, morphed or animated GLB, or one with extra attribute sets, instead of returning it static and stripped', async () => {
        const rigged = rewriteGlbJson(writeFixtureGlb(path.join(WORK, 'rigged.glb'), cylinderMesh(1, 4)), g => {
            const prim = g.meshes[0].primitives[0];
            // Accessor indices only matter to the JSON-level check: the GLB is refused before the native reader runs.
            prim.attributes.JOINTS_0 = prim.attributes.POSITION;
            prim.attributes.WEIGHTS_0 = prim.attributes.NORMAL;
            prim.attributes.TEXCOORD_1 = prim.attributes.NORMAL;
            prim.targets = [{ POSITION: prim.attributes.POSITION }];
            g.meshes[0].weights = [0];
            g.skins = [{ joints: [0] }];
            g.nodes[0].skin = 0;
            g.animations = [{ channels: [], samplers: [] }];
        });
        const issues = rawMeshReadIssues(fs.readFileSync(rigged));
        expect(issues.geometry).toEqual([]);
        expect(issues.content.join('\n')).toContain('JOINTS_0 (1 primitive), WEIGHTS_0 (1 primitive), TEXCOORD_1 (1 primitive), which the native writer does not write');
        expect(issues.content.join('\n')).toContain('1 primitive(s) have morph targets');
        expect(issues.content.join('\n')).toContain('1 skin(s) (a rig with joints)');
        expect(issues.content.join('\n')).toContain('1 animation(s)');
        await expect(meshShapingHandlers.mesh_apply_deformers({ inputGlbPath: rigged, outputGlbPath: path.join(WORK, 'rigged_out.glb'), operations: [{ type: 'taper', axis: 'Y', factor: 0.5, range: [0, 1] }] }, {} as any))
            .rejects.toThrow(/cannot be reshaped faithfully: .*1 skin\(s\)/);
        expect(fs.existsSync(path.join(WORK, 'rigged_out.glb'))).toBe(false);

        // A mesh shown with non-zero morph weights is not its base shape, which is all the reader sees.
        const posed = rewriteGlbJson(writeFixtureGlb(path.join(WORK, 'posed.glb'), cylinderMesh(1, 4)), g => {
            g.meshes[0].primitives[0].targets = [{ POSITION: g.meshes[0].primitives[0].attributes.POSITION }];
            g.meshes[0].weights = [0.6];
        });
        expect(rawMeshReadIssues(fs.readFileSync(posed)).geometry).toContain('mesh 0 is shown with morph target weights [0.6], and the reader reads only its base shape');
    });

    it('keeps the input\'s own clay material on the output instead of the native writer\'s stock material', async () => {
        const clay = { name: 'studio_clay', pbrMetallicRoughness: { baseColorFactor: [0.55, 0.57, 0.6, 1], metallicFactor: 0, roughnessFactor: 0.85 } };
        const inputGlbPath = rewriteGlbJson(writeFixtureGlb(path.join(WORK, 'clay_in.glb'), cylinderMesh(1, 4)), g => {
            g.materials = [clay];
            g.meshes[0].primitives[0].material = 0;
        });
        const outputGlbPath = path.join(WORK, 'clay_out.glb');
        const outcome = await meshShapingHandlers.mesh_apply_deformers({
            inputGlbPath, outputGlbPath, operations: [{ type: 'taper', axis: 'Y', factor: 0.5, range: [0, 1] }]
        }, {} as any);
        expect(outcome.status).toBe('completed');
        const out = readGlbJson(outputGlbPath);
        expect(out.materials).toEqual([clay]);
        expect(out.meshes[0].primitives.every((p: any) => p.material === 0)).toBe(true);

        // An input with no material keeps none (the viewer's default), rather than gaining the writer's bluish one.
        const bare = writeFixtureGlb(path.join(WORK, 'bare_in.glb'), cylinderMesh(1, 4));
        await meshShapingHandlers.mesh_apply_deformers({ inputGlbPath: bare, outputGlbPath: path.join(WORK, 'bare_out.glb'), operations: [{ type: 'repair' }] }, {} as any);
        const bareOut = readGlbJson(path.join(WORK, 'bare_out.glb'));
        expect(bareOut.materials).toBeUndefined();
        expect(bareOut.meshes[0].primitives[0].material).toBeUndefined();
    });

    it('refuses several materials, non-triangle primitives and an unreadable GLB with an error that names the file', async () => {
        const twoMaterials = rewriteGlbJson(writeFixtureGlb(path.join(WORK, 'two_mat.glb'), cylinderMesh(1, 4)), g => {
            g.materials = [{ name: 'studio_clay' }, { name: 'clay_accent' }];
            g.meshes[0].primitives = [{ ...g.meshes[0].primitives[0], material: 0 }, { ...g.meshes[0].primitives[0], material: 1 }];
        });
        await expect(meshShapingHandlers.mesh_apply_deformers({ inputGlbPath: twoMaterials, operations: [{ type: 'repair' }] }, {} as any))
            .rejects.toThrow(/use 2 different materials \(0, 1\), and the native writer writes one/);

        const lines = rewriteGlbJson(writeFixtureGlb(path.join(WORK, 'lines.glb'), cylinderMesh(1, 4)), g => { g.meshes[0].primitives[0].mode = 1; });
        expect(rawMeshReadIssues(fs.readFileSync(lines)).geometry[0]).toContain('primitive mode 1 (not a triangle list)');

        const truncated = path.join(WORK, 'truncated.glb');
        const whole = fs.readFileSync(writeFixtureGlb(path.join(WORK, 'whole.glb'), cylinderMesh(1, 4)));
        fs.writeFileSync(truncated, Buffer.concat([whole.subarray(0, 20), Buffer.from('{"asset":{"vers', 'utf8')]));
        let error: any;
        try {
            await meshShapingHandlers.mesh_apply_deformers({ inputGlbPath: truncated, operations: [{ type: 'repair' }] }, {} as any);
        } catch (err) {
            error = err;
        }
        expect(error?.name).toBe('MissingInputError');
        expect(error.message).toContain(truncated);
        expect(error.message).toMatch(/truncated|not valid JSON/);
    });

    it('routes mesh deformation requests to mesh_apply_deformers', () => {
        const capability = resolveTaskCapability('I want to reshape this 3D mesh by tapering the top and twisting it 45 degrees');
        expect(capability.canSolveNatively).toBe(true);
        expect(capability.tier1Assessment.primaryNativeEngine).toBe('cpp-3d-engine');
        expect(capability.tier1Assessment.suggestedNativeAction?.targetTool).toBe('mesh_apply_deformers');
    });

    it('the viewport operator sb_reshape_mesh needs explicit operations: a prompt alone is not turned into stock magnitudes', () => {
        const engine = createOperatorEngine({
            title: 'Reshaper Canvas Test',
            renderMode: 'pbr',
            customMeshes: [{ id: 'mesh-pillar', name: 'Ionic Pillar', type: 'cylinder' as any, position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 2, 1] }],
            objects: []
        });
        const promptOnly = engine.dispatch('sb_reshape_mesh', { objectId: 'mesh-pillar', prompt: 'Taper the top by 50% and twist 45 degrees' });
        expect(promptOnly.success).toBe(false);
        expect(String(promptOnly.error)).toContain('needs operations');
        const unsupported = engine.dispatch('sb_reshape_mesh', { objectId: 'mesh-pillar', operations: [{ type: 'squash', factor: 0.6 }] });
        expect(unsupported.success).toBe(false);
        expect(String(unsupported.error)).toContain('cannot apply "squash"');
        const missingValue = engine.dispatch('sb_reshape_mesh', { objectId: 'mesh-pillar', operations: [{ type: 'twist' }] });
        expect(String(missingValue.error)).toContain('twist needs a number angle');
    });
});
