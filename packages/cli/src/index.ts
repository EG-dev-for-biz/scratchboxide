/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { initCommand } from './commands/init';
import { branchCommand } from './commands/branch';
import { statusCommand } from './commands/status';
import { attachCommand } from './commands/attach';
import { commitCommand } from './commands/commit';
import { diffCommand } from './commands/diff';
import { bakeCommand } from './commands/bake';
import { generateCommand } from './commands/generate';
import { qaCommand } from './commands/qa';
import { splatCommand } from './commands/splat';
import { matchmoveCommand } from './commands/matchmove';

export async function runCli(argv: string[] = process.argv.slice(2)): Promise<void> {
  const command = argv[0];
  const args = argv.slice(1);

  if (!command || command === '--help' || command === '-h' || command === 'help') {
    printHelp();
    return;
  }

  if (command === '--version' || command === '-v') {
    console.log('sbox (Scratchbox CLI) version 1.0.0');
    return;
  }

  try {
    switch (command) {
      case 'init':
        await initCommand(args);
        break;
      case 'branch':
        await branchCommand(args);
        break;
      case 'status':
        await statusCommand(args);
        break;
      case 'attach':
        await attachCommand(args);
        break;
      case 'commit':
        await commitCommand(args);
        break;
      case 'diff':
        await diffCommand(args);
        break;
      case 'bake':
        await bakeCommand(args);
        break;
      case 'generate':
        await generateCommand(args);
        break;
      case 'qa':
        await qaCommand(args);
        break;
      case 'splat':
        await splatCommand(args);
        break;
      case 'matchmove':
      case 'geo-matchmove':
        await matchmoveCommand(args);
        break;
      default:
        console.error(`Unknown command: '${command}'`);
        printHelp();
        process.exitCode = 1;
        break;
    }
  } catch (err: any) {
    console.error(`\nError: ${err.message}`);
    process.exitCode = 1;
  }
}

function printHelp(): void {
  console.log(`
Scratchbox CLI (sbox) — Git for the Physical World & 3D Procedural Engine

Usage:
  sbox <command> [options]

Spatial Version Control Commands:
  init [dir]                     Initialize a new Scratchbox spatial workspace
  branch                         List spatial branches (multiverse timelines)
  branch create <name> [--from]  Fork a new spatial timeline
  branch checkout <name>         Switch active spatial branch
  status                         Show active branch, latest commit, and staged 3D assets
  attach <file.glb>              Stage a 3D asset to the physical world with geodetic anchor
    --lat <deg> --lng <deg>      (Required) Latitude & Longitude
    [--alt <m>]                  Elevation in meters (default: 0)
    [--heading <deg>]            Rotation compass heading in degrees (0-360)
    [--name <name>]              Asset identifier
  commit -m "<message>"          Commit staged spatial assets to active branch
  diff <targetBranch> [source]   Compute geometric and anchor differences between branches

Autonomous 3D Engine & Procedural Baking Commands:
  bake <generator.cpp>           Compile C++20 procedural code with Clang and bake glTF 2.0 (.glb)
    [-o <output.glb>]            Target output binary glTF path
    [--opt -O3]                  Optimization level (-O0, -O1, -O2, -O3)
  generate "<prompt>"            Synthesize native C++20 3D procedural generator using Gemini
    [--output <file.cpp>]        Target C++ source file path
    [--bake]                     Immediately compile with Clang into .glb
    [--lat <lat> --lng <lng>]    Stage generated geometry to geodetic coordinates
  splat <input.splat|.spz>       Process, convert, or voxelize 3D Gaussian Splats
    [--to-glb <output.glb>]      Bake splat surfel mesh into glTF 2.0 (.glb)
    [--to-spz <output.spz>]      Compress to quantized scaniverse .spz
    [--to-splat <output.splat>]  Export standard 32-byte .splat
    [--voxelize <leafSize>]      Spatial octree/voxel grid downsampling
  qa [asset.glb]                 Evaluate photorealism metrics (density, normals, AO, PBR)
    [--branch <name>]            Run QA across all assets in target branch
  matchmove <video.mp4>          Match camera motion from video in target geography
    [--landmark <name>]          Iconic landmark (e.g. "The Plaza Hotel", "Empire State Building")
    [--lat <deg> --lng <deg>]    Target geographic coordinates
    [--alt <meters>]             Elevation MSL (default: landmark or 0)
    [--heading <deg>]            Street/facade grid heading (default: landmark or 0)
    [--motion <preset>]          crane-descent-to-nadir (default), orbital-inspection, canyon-flythrough
    [--render-mode <mode>]       textured (default) or clay
    [--resolution <4k|1080p>]    4k (3840x2160, default) or 1080p
    [--dry-run]                  Solve 6-DoF trajectory JSON without launching 3D browser render

Examples:
  sbox init
  sbox branch create earth/paris-2050
  sbox bake packages/core/src/native/3d-engine/generators/eiffel_spire.cpp -o eiffel.glb
  sbox attach eiffel.glb --lat 48.8584 --lng 2.2945 --name "Eiffel Spire"
  sbox commit -m "Erected procedural Eiffel Spire"
  sbox diff earth/paris-2050 earth/main
  sbox matchmove reference.mp4 --landmark "The Plaza Hotel" --dry-run
  sbox qa eiffel.glb
`);
}

// Auto-run when executed directly as entrypoint
if (require.main === module) {
  runCli();
}
