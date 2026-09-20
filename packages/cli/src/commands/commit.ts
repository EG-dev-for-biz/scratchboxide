/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { SpatialRepository } from '../state/spatial-repository';

export async function commitCommand(args: string[]): Promise<void> {
  const mIndex = args.indexOf('-m');
  const message = mIndex !== -1 && args[mIndex + 1] ? args[mIndex + 1] : undefined;

  if (!message) {
    console.error('Error: Commit message required. Usage: sbox commit -m "<message>" [--author <name>]');
    process.exitCode = 1;
    return;
  }

  const authorIdx = args.indexOf('--author');
  const author = authorIdx !== -1 && args[authorIdx + 1] ? args[authorIdx + 1] : 'Scratchbox World Builder';

  const { state, manager, rootDir } = await SpatialRepository.load();

  if (!state.stagedEntities || state.stagedEntities.length === 0) {
    console.error('No changes staged for commit. Stage assets first using "sbox attach".');
    process.exitCode = 1;
    return;
  }

  // Retrieve current active branch's existing entities
  const latestCommit = manager.getLatestCommit(state.activeBranch);
  const existingEntities = latestCommit ? [...latestCommit.entitiesSnapshot] : [];

  // Merge staged entities (replacing any with matching IDs or appending)
  const stagedIds = new Set(state.stagedEntities.map(e => e.id));
  const combined = existingEntities.filter(e => !stagedIds.has(e.id)).concat(state.stagedEntities);

  try {
    const commit = manager.commit(state.activeBranch, message, author, combined);
    const stagedCount = state.stagedEntities.length;
    state.stagedEntities = []; // clear staged

    await SpatialRepository.save(rootDir, state, manager);

    console.log(`[${state.activeBranch} ${commit.id.slice(0, 15)}] ${message}`);
    console.log(`Committed ${stagedCount} staged spatial attachment(s). Total branch assets: ${combined.length}`);
  } catch (err: any) {
    console.error(`Commit failed: ${err.message}`);
    process.exitCode = 1;
  }
}
