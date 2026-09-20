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
import { SpatialRepository } from '../state/spatial-repository';
import { Entity4D } from '@scratchbox/core/common';

export async function attachCommand(args: string[]): Promise<void> {
  const filePath = args[0];
  if (!filePath) {
    console.error('Error: Model file path required.');
    console.error('Usage: sbox attach <file.glb> --lat <lat> --lng <lng> [--alt <meters>] [--heading <deg>] [--name <name>]');
    process.exitCode = 1;
    return;
  }

  const getArg = (flag: string): string | undefined => {
    const idx = args.indexOf(flag);
    return idx !== -1 && args[idx + 1] ? args[idx + 1] : undefined;
  };

  const latStr = getArg('--lat');
  const lngStr = getArg('--lng');

  if (!latStr || !lngStr) {
    console.error('Error: Geodetic coordinates required (--lat <degrees> --lng <degrees>)');
    process.exitCode = 1;
    return;
  }

  const lat = parseFloat(latStr);
  const lng = parseFloat(lngStr);
  const alt = getArg('--alt') ? parseFloat(getArg('--alt')!) : 0;
  const heading = getArg('--heading') ? parseFloat(getArg('--heading')!) : 0;
  const pitch = getArg('--pitch') ? parseFloat(getArg('--pitch')!) : 0;

  if (isNaN(lat) || isNaN(lng)) {
    console.error('Error: Coordinates --lat and --lng must be valid numbers.');
    process.exitCode = 1;
    return;
  }

  const { state, manager, rootDir } = await SpatialRepository.load();

  const resolvedPath = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
  const entityName = getArg('--name') || path.basename(filePath);
  const isSplat = filePath.endsWith('.splat') || filePath.endsWith('.spz');
  const isCpp = filePath.endsWith('.cpp');

  const newEntity: Entity4D = {
    id: `entity-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
    name: entityName,
    space: {
      geoAnchor: {
        lat,
        lng,
        alt,
        heading,
        pitch
      },
      localTransform: {
        position: [0, 0, 0],
        scale: [1, 1, 1]
      }
    },
    time: {
      startMs: 0,
      durationMs: 0
    },
    environment: {},
    content: {
      type: isSplat ? 'gaussian-splat' : isCpp ? 'mesh-sculptable' : 'mesh-glb',
      durableUri: path.relative(rootDir, resolvedPath)
    },
    behavior: {},
    lineage: {
      worldBranchId: state.activeBranch,
      version: 1,
      provenance: {
        authorAgent: 'Scratchbox CLI User',
        timestamp: new Date().toISOString()
      }
    }
  };

  state.stagedEntities.push(newEntity);
  await SpatialRepository.save(rootDir, state, manager);

  console.log(`Staged 3D entity: '${entityName}' [${newEntity.content.type}]`);
  console.log(`Geo-anchor: Lat ${lat.toFixed(6)}, Lng ${lng.toFixed(6)}, Alt ${alt}m, Heading ${heading}°`);
  console.log(`Active branch: ${state.activeBranch}`);
  console.log(`Run 'sbox commit -m "<message>"' to record spatial commit.`);
}
