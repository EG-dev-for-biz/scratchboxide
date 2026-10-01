/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { SpatialRepository } from '../state/spatial-repository';

export async function diffCommand(args: string[]): Promise<void> {
  const { state, manager } = await SpatialRepository.load();

  const targetBranch = args[0];
  if (!targetBranch) {
    console.error('Error: Target branch required.');
    console.error('Usage: sbox diff <targetBranch> [sourceBranch]');
    process.exitCode = 1;
    return;
  }

  const sourceBranch = args[1] || state.activeBranch;

  try {
    const diff = manager.computeDiff(targetBranch, sourceBranch);

    console.log(`\n=== Spatial Diff: ${sourceBranch} -> ${targetBranch} ===\n`);

    if (diff.added.length === 0 && diff.modified.length === 0 && diff.deleted.length === 0) {
      console.log('No spatial differences between branches.\n');
      return;
    }

    if (diff.added.length > 0) {
      console.log(`+ Added in ${targetBranch} (${diff.added.length}):`);
      for (const ent of diff.added) {
        const anchor = ent.space.geoAnchor;
        const coords = anchor ? `(lat: ${anchor.lat.toFixed(5)}, lng: ${anchor.lng.toFixed(5)}, alt: ${anchor.alt || 0}m)` : '';
        console.log(`  + [${ent.content.type}] ${ent.name} -> ${ent.content.durableUri} ${coords}`);
      }
      console.log('');
    }

    if (diff.modified.length > 0) {
      console.log(`~ Modified in ${targetBranch} (${diff.modified.length}):`);
      for (const ent of diff.modified) {
        console.log(`  ~ [${ent.content.type}] ${ent.name} (Transform/URI delta: ${ent.content.durableUri})`);
      }
      console.log('');
    }

    if (diff.deleted.length > 0) {
      console.log(`- Removed in ${targetBranch} (${diff.deleted.length}):`);
      for (const id of diff.deleted) {
        console.log(`  - Entity ID: ${id}`);
      }
      console.log('');
    }
  } catch (err: any) {
    console.error(`Diff failed: ${err.message}`);
    process.exitCode = 1;
  }
}
