import { test, expect } from 'vitest';
/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as fs from 'fs';
import { NativePythonRunnerService } from '../src/node/3d-engine/native-python-runner-service';

test('NativePythonRunnerService executes Python scene script and streams binary .glb', async () => {
    const runner = NativePythonRunnerService.getInstance();
    expect(runner).toBeDefined();

    const pythonExe = runner.getPythonExecutable();
    expect(pythonExe).toBeDefined();
    console.log(`[Test] Using Python interpreter: ${pythonExe}`);

    const moduleDir = runner.getModuleDirectory();
    expect(moduleDir).toBeDefined();
    console.log(`[Test] Using native module dir: ${moduleDir}`);

    const pythonScript = `
import scratchbox as sb

# 1. Architecture: Mansard Roof Townhouse
bldg_cfg = sb.architecture.BuildingConfig()
bldg_cfg.width = 12.0
bldg_cfg.depth = 14.0
bldg_cfg.floor_count = 3
bldg_cfg.roof_type = sb.architecture.RoofType.Mansard
building = sb.architecture.generate_building(bldg_cfg, "Townhouse")

# 2. Nature: an SB-Veggie tree (grown natively when the scene is written)
tree = sb.create_tree(position=(9.0, 0.35, 0.0), height=11.0, crown_radius=3.5)

# 3. Geometry: Studio Pedestal
pedestal = sb.geometry.create_studio_pedestal(7.0, 0.35, 0.05, 48)

# 4. Scene Composition
scene = sb.geometry.Mesh("ProceduralScene")
scene.append(pedestal)
scene.append(building)
scene.append(tree)

print(f"Generated Scene: {scene.vertex_count} vertices, {scene.triangle_count} triangles, {len(scene._sb_veggie_trees)} SB-Veggie trees")

# 5. Export to binary glTF 2.0 (.glb)
sb.io.write_glb(OUTPUT_GLB_PATH, scene)
print("GLB export complete.")
`;

    const result = await runner.runScript(pythonScript, {
        timeoutMs: 30000
    });

    console.log(`[Test] Execution result in ${result.executionTimeMs}ms:`, {
        success: result.success,
        exitCode: result.exitCode,
        glbPath: result.glbPath,
        stdout: result.stdout.trim()
    });

    if (!result.success) {
        console.error(`[Test Error Details]:`, result.errorDetails);
    }

    expect(result.success, `Python execution failed: ${result.errorDetails || result.stderr || result.stdout}`).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.glbPath).toBeDefined();
    expect(fs.existsSync(result.glbPath!)).toBe(true);
    expect(result.glbBase64).toBeDefined();

    // Verify glTF 2.0 binary magic header ('glTF' = 0x46546C67)
    const glbBuffer = fs.readFileSync(result.glbPath!);
    expect(glbBuffer.length).toBeGreaterThan(1024);
    const magic = glbBuffer.toString('utf8', 0, 4);
    expect(magic).toBe('glTF');

    const version = glbBuffer.readUInt32LE(4);
    expect(version).toBe(2);

    console.log(`[Test] Verified valid glTF 2.0 binary (${glbBuffer.length} bytes, version: ${version})`);
});

test('5. Executes a Python script source via runScript and returns valid GLB', async () => {
    const runner = NativePythonRunnerService.getInstance();
    const script = `
import scratchbox as sb

pedestal = sb.geometry.create_studio_pedestal(5.0, 0.25, 0.05, 32)
scene = sb.geometry.Mesh("PedestalScene")
scene.append(pedestal)
sb.io.write_glb(OUTPUT_GLB_PATH, scene)
`;
    const result = await runner.runScript(script);
    expect(result.success).toBe(true);
    expect(result.glbPath).toBeDefined();
    expect(fs.existsSync(result.glbPath!)).toBe(true);
    expect(result.glbBase64).toBeDefined();
    const buf = fs.readFileSync(result.glbPath!);
    expect(buf.toString('utf8', 0, 4)).toBe('glTF');
});

test('NativePythonRunnerService refuses to stage assets outside outputDir', async () => {
    const os = await import('os');
    const path = await import('path');
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-py-assets-'));
    const outputDir = path.join(sandbox, 'out');
    const escaped = path.join(sandbox, 'escaped.txt');
    try {
        const runner = NativePythonRunnerService.getInstance();
        await expect(runner.runScript('print(1)', {
            outputDir,
            assets: [{ name: '../escaped.txt', content: 'pwned' }]
        })).rejects.toThrow(/outside the workspace root/);
        await expect(runner.runScript('print(1)', {
            outputDir,
            assets: [{ name: escaped, content: 'pwned' }]
        })).rejects.toThrow(/outside the workspace root/);
        expect(fs.existsSync(escaped)).toBe(false);
    } finally {
        fs.rmSync(sandbox, { recursive: true, force: true });
    }
});

test('NativePythonRunnerService passes args without a shell (no command injection)', async () => {
    const os = await import('os');
    const path = await import('path');
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-py-args-'));
    const marker = path.join(sandbox, 'injected');
    try {
        const runner = NativePythonRunnerService.getInstance();
        const hostile = `x"; touch "${marker}"; echo "$(touch ${marker})`;
        const result = await runner.runScript('import sys, json; print(json.dumps(sys.argv[1:]))', {
            outputDir: sandbox,
            args: [hostile]
        });
        expect(result.success).toBe(true);
        expect(JSON.parse(result.stdout.trim().split('\n').pop() as string)).toEqual([hostile]);
        expect(fs.existsSync(marker)).toBe(false);
    } finally {
        fs.rmSync(sandbox, { recursive: true, force: true });
    }
});
