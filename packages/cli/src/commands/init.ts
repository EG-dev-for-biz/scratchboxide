/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as path from 'path';
import { SpatialRepository } from '../state/spatial-repository';

export async function initCommand(args: string[]): Promise<void> {
  const targetDir = args[0] ? path.resolve(args[0]) : process.cwd();
  const { initialized, statePath } = await SpatialRepository.init(targetDir);

  if (initialized) {
    console.log(`Initialized empty Scratchbox spatial repository in: ${statePath}`);
    console.log(`Default spatial branch: earth/main`);
    console.log(`Use 'sbox branch' to view or fork spatial layers.`);
  } else {
    console.log(`Existing Scratchbox spatial repository already detected at: ${statePath}`);
  }
}
