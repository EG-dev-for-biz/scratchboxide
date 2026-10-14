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
import * as os from 'os';
import * as fs from 'fs-extra';
import { runCli } from '../src/index';

describe('Scratchbox CLI (sbox) — 3D Gaussian Splatting Command (sbox splat)', () => {
  let tempDir: string;
  let originalCwd: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    // Outside the repo (was packages/.temp-splat-test-*); realpath so cwd-relative paths compare equal on macOS.
    tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'sbx-cli-splat-')));
    process.chdir(tempDir);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await fs.remove(tempDir);
  });

  it('should generate synthetic Gaussian splats and export to .spz, .splat, and .glb via CLI', async () => {
    const outGlb = path.join(tempDir, 'cli_output.glb');
    const outSpz = path.join(tempDir, 'cli_output.spz');
    const outSplat = path.join(tempDir, 'cli_output.splat');

    await runCli([
      'splat',
      '--synthetic',
      '--count', '300',
      '--to-glb', outGlb,
      '--to-spz', outSpz,
      '--to-splat', outSplat
    ]);

    expect(await fs.pathExists(outGlb)).toBe(true);
    expect(await fs.pathExists(outSpz)).toBe(true);
    expect(await fs.pathExists(outSplat)).toBe(true);

    const glbStat = await fs.stat(outGlb);
    const spzStat = await fs.stat(outSpz);
    const splatStat = await fs.stat(outSplat);

    expect(glbStat.size).toBeGreaterThan(1000);
    expect(splatStat.size).toBe(300 * 32);
    // SPZ compression should reduce byte footprint
    expect(spzStat.size).toBeLessThan(splatStat.size);
  });
});
