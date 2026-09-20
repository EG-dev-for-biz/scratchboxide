/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { SpatialRepository } from '../state/spatial-repository';

export async function branchCommand(args: string[]): Promise<void> {
  const { state, manager, rootDir } = await SpatialRepository.load();

  const sub = args[0];

  if (!sub || sub === 'list') {
    // List all branches
    const branchNames = manager.getBranchNames();
    console.log('\nScratchbox Spatial Multiverse Branches:');
    for (const name of branchNames) {
      const isCurrent = name === state.activeBranch;
      const history = manager.getBranchHistory(name) || [];
      const latest = history[history.length - 1];
      const entityCount = latest?.entitiesSnapshot?.length || 0;
      const marker = isCurrent ? '* ' : '  ';
      console.log(`${marker}${name.padEnd(25)} (${entityCount} entities, commit: ${latest?.id?.slice(0, 15) || 'none'})`);
    }
    console.log('');
    return;
  }

  if (sub === 'create') {
    const branchName = args[1];
    if (!branchName) {
      console.error('Error: branch name required. Usage: sbox branch create <name> [--from <parent>]');
      process.exitCode = 1;
      return;
    }

    let parentBranch = state.activeBranch;
    const fromIndex = args.indexOf('--from');
    if (fromIndex !== -1 && args[fromIndex + 1]) {
      parentBranch = args[fromIndex + 1];
    }

    try {
      manager.createBranch(branchName, parentBranch);
      await SpatialRepository.save(rootDir, state, manager);
      console.log(`Forked spatial branch '${branchName}' from '${parentBranch}'`);
    } catch (err: any) {
      console.error(`Failed to create branch: ${err.message}`);
      process.exitCode = 1;
    }
    return;
  }

  if (sub === 'checkout' || sub === 'switch') {
    const branchName = args[1];
    if (!branchName) {
      console.error('Error: branch name required. Usage: sbox branch checkout <name>');
      process.exitCode = 1;
      return;
    }

    const branchNames = manager.getBranchNames();
    if (!branchNames.includes(branchName)) {
      console.error(`Error: branch '${branchName}' does not exist.`);
      process.exitCode = 1;
      return;
    }

    state.activeBranch = branchName;
    await SpatialRepository.save(rootDir, state, manager);
    console.log(`Switched to spatial branch '${branchName}'`);
    return;
  }

  console.error(`Unknown branch subcommand: '${sub}'. Valid: list, create, checkout`);
  process.exitCode = 1;
}
