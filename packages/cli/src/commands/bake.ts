/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as path from 'path';
import * as fs from 'fs-extra';
import { NativeCppCompilerService } from '@scratchbox/core/node';

export async function bakeCommand(args: string[]): Promise<void> {
  const sourceFile = args[0];
  if (!sourceFile) {
    console.error('Error: Source C++ generator file required.');
    console.error('Usage: sbox bake <generator.cpp> [-o output.glb] [--opt -O3]');
    process.exitCode = 1;
    return;
  }

  const resolvedSource = path.resolve(process.cwd(), sourceFile);
  if (!(await fs.pathExists(resolvedSource))) {
    console.error(`Error: Source file '${resolvedSource}' not found.`);
    process.exitCode = 1;
    return;
  }

  const oIndex = args.indexOf('-o') !== -1 ? args.indexOf('-o') : args.indexOf('--output');
  const targetGlb = oIndex !== -1 && args[oIndex + 1] ? path.resolve(process.cwd(), args[oIndex + 1]) : undefined;

  const optIndex = args.indexOf('--opt');
  const optimization = (optIndex !== -1 && args[optIndex + 1] ? args[optIndex + 1] : '-O3') as any;

  console.log(`Compiling native C++20 procedural generator: ${path.basename(resolvedSource)}...`);
  const compiler = new NativeCppCompilerService();

  const sourceCode = await fs.readFile(resolvedSource, 'utf8');
  const outputDir = path.resolve(process.cwd(), 'build/3d-native');

  const compResult = await compiler.compileSource(sourceCode, {
    outputDir,
    outputBinaryName: path.basename(sourceFile, path.extname(sourceFile)),
    optimization
  });

  if (!compResult.success || !compResult.binaryPath) {
    console.error(`\nCompilation Failed (${compResult.compilationTimeMs}ms):`);
    if (compResult.diagnostics.length > 0) {
      for (const diag of compResult.diagnostics) {
        console.error(`  [${diag.severity.toUpperCase()}] ${diag.file}:${diag.line}:${diag.column} - ${diag.message}`);
      }
    } else {
      console.error(compResult.compilerOutput);
    }
    process.exitCode = 1;
    return;
  }

  console.log(`Compiled binary in ${compResult.compilationTimeMs}ms -> ${compResult.binaryPath}`);
  console.log(`Executing generator binary to bake 3D geometry...`);

  const execResult = await compiler.executeBinary(compResult.binaryPath, [], outputDir);

  if (!execResult.success) {
    console.error(`Execution failed (${execResult.executionTimeMs}ms, code ${execResult.exitCode}):`);
    console.error(execResult.stderr || execResult.stdout);
    process.exitCode = 1;
    return;
  }

  let finalGlb = execResult.glbPath;
  if (!finalGlb && execResult.glbBase64) {
    const defaultGlbPath = path.join(outputDir, `${path.basename(sourceFile, path.extname(sourceFile))}.glb`);
    await fs.writeFile(defaultGlbPath, Buffer.from(execResult.glbBase64, 'base64'));
    finalGlb = defaultGlbPath;
  }

  if (targetGlb && finalGlb) {
    await fs.copy(finalGlb, targetGlb);
    finalGlb = targetGlb;
  }

  console.log(`\nSuccessfully baked 3D asset in ${execResult.executionTimeMs}ms!`);
  if (finalGlb) {
    const stats = await fs.stat(finalGlb);
    console.log(`Output GLB:  ${finalGlb} (${(stats.size / 1024).toFixed(1)} KB)`);
  }
  if (execResult.chunks.length > 0) {
    console.log(`Streamed:    ${execResult.chunks.length} 3D geometry chunk(s)`);
  }
  console.log(`Use 'sbox attach ${finalGlb ? path.relative(process.cwd(), finalGlb) : 'output.glb'} --lat <lat> --lng <lng>' to stage to the world.`);
}
