import { test, expect } from 'vitest';
/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
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

# 2. Nature: Space Colonization Tree
tree_cfg = sb.nature.SpaceColonizationConfig()
tree_cfg.attractor_count = 120
tree_cfg.crown_center = sb.math.Vec3(0, 7.5, 0)
tree_cfg.crown_extents = sb.math.Vec3(2.5, 3.5, 2.5)
tree = sb.nature.generate_tree(tree_cfg)

# 3. Geometry: Studio Pedestal
pedestal = sb.geometry.create_studio_pedestal(7.0, 0.35, 0.05, 48)

# 4. Scene Composition
scene = sb.geometry.Mesh("ProceduralScene")
scene.append(pedestal)
scene.append(building)
scene.append(tree)

print(f"Generated Scene: {scene.vertex_count} vertices, {scene.triangle_count} triangles")

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
