/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
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
