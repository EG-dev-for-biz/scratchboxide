/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import * as fs from 'fs-extra';
import { SpatialRepository } from '../src/state/spatial-repository';
import { runCli } from '../src/index';
import { NativeCppCompilerService, PhotorealismEvaluator } from '@scratchbox/core/node';

describe('Scratchbox CLI (sbox) — Spatial Multiverse Version Control & 3D Procedural Engine', () => {
  let tempDir: string;
  let originalCwd: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    tempDir = path.resolve(__dirname, `../../.temp-cli-test-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
    await fs.ensureDir(tempDir);
    process.chdir(tempDir);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await fs.remove(tempDir);
  });

  it('should initialize a new spatial repository with earth/main root branch', async () => {
    const { initialized, statePath } = await SpatialRepository.init(tempDir);
    expect(initialized).toBe(true);
    expect(await fs.pathExists(statePath)).toBe(true);

    const { state, manager } = await SpatialRepository.load(tempDir);
    expect(state.activeBranch).toBe('earth/main');
    expect(manager.getBranchNames()).toContain('earth/main');
    expect(state.stagedEntities).toHaveLength(0);
  });

  it('should fork and checkout branches through CLI', async () => {
    await runCli(['init']);

    // Fork branch
    await runCli(['branch', 'create', 'earth/tokyo-2050']);
    const { state, manager } = await SpatialRepository.load(tempDir);
    expect(manager.getBranchNames()).toContain('earth/tokyo-2050');

    // Checkout branch
    await runCli(['branch', 'checkout', 'earth/tokyo-2050']);
    const reloaded = await SpatialRepository.load(tempDir);
    expect(reloaded.state.activeBranch).toBe('earth/tokyo-2050');
  });

  it('should stage 3D entities with geodetic anchors and commit to active branch', async () => {
    await runCli(['init']);
    await runCli(['branch', 'create', 'earth/shinjuku']);
    await runCli(['branch', 'checkout', 'earth/shinjuku']);

    // Create a mock glb file
    const mockGlbPath = path.join(tempDir, 'tower.glb');
    await fs.writeFile(mockGlbPath, Buffer.from('mock-glb-binary-content'));

    // Attach asset to physical world
    await runCli(['attach', 'tower.glb', '--lat', '35.6895', '--lng', '139.6917', '--alt', '45', '--name', 'Tokyo Spire']);

    const staged = await SpatialRepository.load(tempDir);
    expect(staged.state.stagedEntities).toHaveLength(1);
    expect(staged.state.stagedEntities[0].name).toBe('Tokyo Spire');
    expect(staged.state.stagedEntities[0].space.geoAnchor?.lat).toBe(35.6895);
    expect(staged.state.stagedEntities[0].space.geoAnchor?.lng).toBe(139.6917);

    // Commit staged assets
    await runCli(['commit', '-m', 'Add Tokyo Spire landmark', '--author', 'Test Engineer']);

    const committed = await SpatialRepository.load(tempDir);
    expect(committed.state.stagedEntities).toHaveLength(0);
    const latest = committed.manager.getLatestCommit('earth/shinjuku');
    expect(latest).toBeDefined();
    expect(latest?.message).toBe('Add Tokyo Spire landmark');
    expect(latest?.entitiesSnapshot).toHaveLength(1);
    expect(latest?.entitiesSnapshot[0].name).toBe('Tokyo Spire');
  });

  it('should compute spatial branch diffs between multiverse timelines', async () => {
    await runCli(['init']);
    await runCli(['branch', 'create', 'earth/future-city']);
    await runCli(['branch', 'checkout', 'earth/future-city']);

    const mockGlbPath = path.join(tempDir, 'skyscraper.glb');
    await fs.writeFile(mockGlbPath, Buffer.from('skyscraper-glb'));
    await runCli(['attach', 'skyscraper.glb', '--lat', '37.7749', '--lng', '-122.4194', '--name', 'SF Spire']);
    await runCli(['commit', '-m', 'Add SF Spire']);

    const { manager } = await SpatialRepository.load(tempDir);
    const diff = manager.computeDiff('earth/future-city', 'earth/main');

    expect(diff.added).toHaveLength(1);
    expect(diff.added[0].name).toBe('SF Spire');
    expect(diff.deleted).toHaveLength(0);
  });

  it('should compile procedural C++20 code via NativeCppCompilerService and evaluate photorealism', async () => {
    const cppCode = `
#include "scratchbox_engine.hpp"
#include <iostream>

int main() {
    using namespace scratchbox;

    auto mesh = geometry::MarchingCubes::extractIsosurface(
        [](const math::Vec3& p) { return sdf::sdSphere(p, 1.0f); },
        math::AABB({-1.2f, -1.2f, -1.2f}, {1.2f, 1.2f, 1.2f}),
        20,
        0.0f,
        math::Vec4(0.85f, 0.82f, 0.78f, 1.0f)
    );

    io::GlbWriter::streamChunk(mesh, "procedural-sphere");
    return 0;
}
`;
    const cppFile = path.join(tempDir, 'sphere_generator.cpp');
    await fs.writeFile(cppFile, cppCode, 'utf8');

    const compiler = new NativeCppCompilerService();
    const compResult = await compiler.compileSource(cppCode, {
      outputDir: tempDir,
      outputBinaryName: 'sphere_generator'
    });

    if (!compResult.success) {
      console.error('Compiler diagnostics:', compResult.diagnostics);
      console.error('Compiler output:', compResult.compilerOutput);
    }
    expect(compResult.success).toBe(true);
    expect(compResult.binaryPath).toBeDefined();

    const execResult = await compiler.executeBinary(compResult.binaryPath!, [], tempDir);
    expect(execResult.success).toBe(true);

    const glbBase64 = execResult.glbBase64 || (execResult.chunks.length > 0 ? execResult.chunks[0].glbBase64 : undefined);
    expect(glbBase64).toBeDefined();

    const glbBytes = Buffer.from(glbBase64!, 'base64');
    const evaluator = new PhotorealismEvaluator();
    const report = evaluator.evaluateGlb('procedural-sphere', glbBytes);

    // Marching cubes on a 20^3 lattice shares vertices between cells: closed genus-0 sphere, F = 2V - 4.
    expect(report.vertexCount).toBe(1326);
    expect(report.triangleCount).toBe(2648);
    expect(report.densityScore).toBeGreaterThanOrEqual(5);
    expect(report.totalScore).toBeGreaterThanOrEqual(60);
  });
});
