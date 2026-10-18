/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * Local SF3D (Stable Fast 3D) Organic Prop Generator Test Suite
 * Validates:
 * 1. Counts and bounds come from the GLB the runner wrote
 * 2. Runner failures (including SF3D not installed) throw LocalSf3DError; no substitute mesh
 * 3. TaskCapabilityResolver routing and tool offering for SF3D
 ********************************************************************************/

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LocalSf3DError, LocalSf3DService, readGlbMeshStats } from '../src/node/3d-engine/local-sf3d-service';
import { localSf3DHandlers } from '../src/node/gemini/tools/local-sf3d-tools';
import { TaskCapabilityResolver } from '../src/node/agent/task-capability-resolver';
import { buildToolDeclarations, createDefaultToolRegistry } from '../src/node/gemini/tool-registry';

describe('Local SF3D Organic Prop Engine (no_pbr)', () => {
    // Outputs go to a temp dir (this used to resolve to packages/build/test-sf3d inside the repo).
    const testOutputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-local-sf3d-'));
    const dummyImagePath = path.join(testOutputDir, 'test_chanterelle.png');
    const outputGlbPath = path.join(testOutputDir, 'test_chanterelle_prop.glb');

    beforeAll(() => {
        // Minimal dummy 1x1 PNG input
        fs.writeFileSync(dummyImagePath, Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082', 'hex'));
    });
    afterAll(() => {
        fs.rmSync(testOutputDir, { recursive: true, force: true });
    });

    /** Minimal binary glTF with one indexed triangle primitive of the given size and POSITION bounds. */
    function buildGlb(vertexCount: number, indexCount: number, min: number[], max: number[]): Buffer {
        const binLength = vertexCount * 12 + indexCount * 4;
        const json = Buffer.from(JSON.stringify({
            asset: { version: '2.0' },
            meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, mode: 4 }] }],
            accessors: [
                { bufferView: 0, componentType: 5126, count: vertexCount, type: 'VEC3', min, max },
                { bufferView: 1, componentType: 5125, count: indexCount, type: 'SCALAR' }
            ],
            bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: vertexCount * 12 }, { buffer: 0, byteOffset: vertexCount * 12, byteLength: indexCount * 4 }],
            buffers: [{ byteLength: binLength }]
        }));
        const jsonPadded = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)]);
        const bin = Buffer.alloc(binLength);
        const header = Buffer.alloc(12);
        header.write('glTF', 0, 'utf8');
        header.writeUInt32LE(2, 4);
        header.writeUInt32LE(12 + 8 + jsonPadded.length + 8 + bin.length, 8);
        const jh = Buffer.alloc(8); jh.writeUInt32LE(jsonPadded.length, 0); jh.writeUInt32LE(0x4e4f534a, 4);
        const bh = Buffer.alloc(8); bh.writeUInt32LE(bin.length, 0); bh.writeUInt32LE(0x004e4942, 4);
        return Buffer.concat([header, jh, jsonPadded, bh, bin]);
    }

    /**
     * Service whose runner script is a stand-in for run_local_sf3d.py. It runs the way the real one does, in a
     * persistent worker that calls its main() per prop (argv: image path, output GLB path, flags).
     */
    function serviceWithRunner(mainBody: string): LocalSf3DService {
        const script = path.join(testOutputDir, `fake_sf3d_runner_${Math.random().toString(36).slice(2)}.py`);
        fs.writeFileSync(script, `import json, shutil, sys\ndef main():\n${mainBody.split('\n').map(l => `    ${l}`).join('\n')}\n`);
        const service = new LocalSf3DService({
            ensureNativeModule: async () => null,
            getPythonExecutable: () => process.env.SCRATCHBOX_PYTHON || 'python3',
            getModuleDirectory: () => ''
        } as any);
        service.resolveScriptPath = () => script;
        return service;
    }

    it('1. Reports vertex/triangle counts and bounds read from the GLB the runner wrote', async () => {
        const glbSource = path.join(testOutputDir, 'runner_output.glb');
        fs.writeFileSync(glbSource, buildGlb(5123, 3 * 9871, [-0.1, 0, -0.12], [0.1, 0.4, 0.12]));
        // The runner's JSON carries no counts or bounds: they must come from the GLB itself.
        const service = serviceWithRunner(
            `shutil.copyfile(${JSON.stringify(glbSource)}, sys.argv[2])\nprint("__LOCAL_SF3D_RESULT_START__")\nprint('{"success": true, "device": "cpu"}')\nprint("__LOCAL_SF3D_RESULT_END__")`
        );
        const out = path.join(testOutputDir, 'counted.glb');
        const result = await service.generateOrganicProp({ imagePath: dummyImagePath, outputGlbPath: out, targetScaleMeters: 0.4 });
        expect(result.vertexCount).toBe(5123);
        expect(result.triangleCount).toBe(9871);
        expect(result.overallBoundingBox.min).toEqual([-0.1, 0, -0.12]);
        expect(result.overallBoundingBox.dimensions[1]).toBeCloseTo(0.4, 6);
        expect(result.overallBoundingBox.dimensions[0]).toBeCloseTo(0.2, 6);
        expect(result.device).toBe('cpu');
        expect(readGlbMeshStats(fs.readFileSync(out)).vertexCount).toBe(5123);
    });

    it('2. A failing runner throws LocalSf3DError even when a stale GLB sits at the target path', async () => {
        const out = path.join(testOutputDir, 'stale.glb');
        fs.writeFileSync(out, buildGlb(10, 3, [0, 0, 0], [1, 1, 1]));
        const service = serviceWithRunner(
            `print("__LOCAL_SF3D_ERROR_START__")\nprint('{"success": false, "code": "SF3D_RUN_FAILED", "error": "CUDA out of memory"}')\nprint("__LOCAL_SF3D_ERROR_END__")\nsys.exit(4)`
        );
        const err = await service.generateOrganicProp({ imagePath: dummyImagePath, outputGlbPath: out }).catch(e => e);
        expect(err).toBeInstanceOf(LocalSf3DError);
        expect(err.code).toBe('SF3D_RUN_FAILED');
        expect(err.message).toContain('CUDA out of memory');
    });

    it('2b. The real runner script exits non-zero with SF3D_NOT_INSTALLED when SF3D is missing (no substitute mesh)', async () => {
        const { execFileSync, spawnSync } = await import('child_process');
        const py = 'python3';
        const probe = spawnSync(py, ['-I', '-c', 'import sf3d'], { encoding: 'utf8' });
        if (probe.status === 0) return; // SF3D installed here: the not-installed path cannot be exercised.
        const script = new LocalSf3DService({} as any).resolveScriptPath();
        const out = path.join(testOutputDir, 'not_installed.glb');
        let status = 0;
        let stdout = '';
        try {
            execFileSync(py, ['-I', script, dummyImagePath, out], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (e: any) {
            status = e.status;
            stdout = e.stdout;
        }
        expect(status).toBe(3);
        expect(stdout).toContain('"code": "SF3D_NOT_INSTALLED"');
        expect(fs.existsSync(out)).toBe(false);
    });

    it('2c. The tool handler fails with the error code when SF3D cannot run', async () => {
        const failing = serviceWithRunner(
            `print("__LOCAL_SF3D_ERROR_START__")\nprint('{"success": false, "code": "SF3D_NOT_INSTALLED", "error": "No module named sf3d"}')\nprint("__LOCAL_SF3D_ERROR_END__")\nsys.exit(3)`
        );
        const prev = (LocalSf3DService as any).instance;
        (LocalSf3DService as any).instance = failing;
        try {
            const res = await localSf3DHandlers.generate_local_sf3d_organic_prop({
                imagePath: dummyImagePath,
                outputGlbPath: path.join(testOutputDir, 'tool.glb')
            }, {} as any);
            expect(res.status).toBe('failed');
            expect(res.resultPayload.code).toBe('SF3D_NOT_INSTALLED');
            expect(res.summaryResult).toContain('No module named sf3d');
            expect(fs.existsSync(path.join(testOutputDir, 'tool.glb'))).toBe(false);
        } finally {
            (LocalSf3DService as any).instance = prev;
        }
    });

    it('3. Routes to LocalSf3DService only when the request names SF3D', () => {
        const named = TaskCapabilityResolver.resolveTaskCapability(
            'run SF3D on my photo of a mushroom to get a 3d mesh without pbr'
        );
        expect(named.canSolveNatively).toBe(true);
        expect(named.primaryNativeEngine).toBe('python-3d-engine');
        expect(named.suggestedNativeAction?.targetTool).toBe('generate_local_sf3d_organic_prop');
        expect(named.suggestedNativeAction?.targetService).toBe('LocalSf3DService');

        // Neural reconstruction is never picked for an object asked for in words (AGENTS.md).
        const unnamed = TaskCapabilityResolver.resolveTaskCapability('generate a small organic prop of a mushroom in 3d');
        expect(unnamed.suggestedNativeAction?.targetTool).not.toBe('generate_local_sf3d_organic_prop');
    });

    it('3b. Is registered but not offered by default; a request naming SF3D gets it', () => {
        const registry = createDefaultToolRegistry();
        expect(registry.has('generate_local_sf3d_organic_prop')).toBe(true);
        const offered = (prompt: string) => (buildToolDeclarations({ prompt, mode: 'agent' } as any, registry) || [])
            .flatMap((t: any) => (t.functionDeclarations || []).map((d: any) => d.name));
        expect(offered('build a 3d model of a small mushroom')).not.toContain('generate_local_sf3d_organic_prop');
        expect(offered('build a 3d model of a small mushroom')).toContain('build_3d_object_from_reference');
        expect(offered('run SF3D on photo.png to make a 3d mesh')).toContain('generate_local_sf3d_organic_prop');
    });

    it('4. Rejects invalid inputs gracefully with structured error', async () => {
        const handler = localSf3DHandlers.generate_local_sf3d_organic_prop;
        const res = await handler({}, {} as any);
        // ToolHandlerOutcome contract (f05f9f2): outcome status 'failed', payload status 'error'.
        expect(res.status).toBe('failed');
        expect(res.summaryResult).toContain('Missing required argument: imagePath');
        expect(res.resultPayload.status).toBe('error');
        expect(res.resultPayload.summary).toContain('Missing required argument: imagePath');
    });
});
