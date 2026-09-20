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
import { GeminiService } from '@scratchbox/core/node';
import { bakeCommand } from './bake';
import { attachCommand } from './attach';

export async function generateCommand(args: string[]): Promise<void> {
  const prompt = args[0];
  if (!prompt || prompt.startsWith('--')) {
    console.error('Error: Natural language prompt required.');
    console.error('Usage: sbox generate "<prompt>" [--output <generator.cpp>] [--bake] [--lat <lat> --lng <lng>]');
    process.exitCode = 1;
    return;
  }

  const getArg = (flag: string): string | undefined => {
    const idx = args.indexOf(flag);
    return idx !== -1 && args[idx + 1] ? args[idx + 1] : undefined;
  };

  const outputPath = getArg('--output') || path.resolve(process.cwd(), 'build/3d-native/world_generator.cpp');
  const shouldBake = args.includes('--bake');
  const latStr = getArg('--lat');
  const lngStr = getArg('--lng');

  console.log(`\nSynthesizing 3D procedural generator with Google Gemini...`);
  console.log(`Prompt: "${prompt}"`);

  const gemini = new GeminiService();

  try {
    const response = await gemini.generateArtifact({
      prompt: `Create a native modern C++20 3D procedural generator using #include "scratchbox_engine.hpp" for: ${prompt}. Return a 3d-scene artifact with high-fidelity cppGenerator sourceCode.`,
      chatHistory: [],
      workspaceRoot: process.cwd(),
      model: 'gemini-2.5-pro'
    });

    const sceneData = response.artifact?.data as any;
    const cppSource = sceneData?.cppGenerator?.sourceCode;

    if (!cppSource) {
      console.error('Gemini generated a response, but no C++20 procedural source was attached.');
      if (response.text) {
        console.log('\nAI Model Output:\n' + response.text);
      }
      return;
    }

    await fs.ensureDir(path.dirname(outputPath));
    await fs.writeFile(outputPath, cppSource, 'utf8');
    console.log(`\nGenerated C++20 procedural code saved to: ${outputPath}`);

    if (shouldBake) {
      console.log('\n--bake flag detected. Compiling procedural generator with Clang...');
      const glbTarget = path.join(path.dirname(outputPath), `${path.basename(outputPath, '.cpp')}.glb`);
      await bakeCommand([outputPath, '-o', glbTarget]);

      if (latStr && lngStr) {
        console.log('\nGeodetic coordinates detected. Staging asset to spatial branch...');
        await attachCommand([glbTarget, '--lat', latStr, '--lng', lngStr, '--name', path.basename(outputPath, '.cpp')]);
      }
    } else {
      console.log(`Run 'sbox bake ${path.relative(process.cwd(), outputPath)}' to compile into binary glTF 2.0.`);
    }
  } catch (err: any) {
    console.error(`AI Generation failed: ${err.message}`);
    process.exitCode = 1;
  }
}
