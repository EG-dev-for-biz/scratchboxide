/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { SpatialRepository } from '../state/spatial-repository';

export async function statusCommand(_args: string[]): Promise<void> {
  const { state, manager } = await SpatialRepository.load();

  console.log(`On spatial branch: ${state.activeBranch}`);
  const latest = manager.getLatestCommit(state.activeBranch);
  if (latest) {
    console.log(`Latest commit:     ${latest.id}`);
    console.log(`Message:           ${latest.message}`);
    console.log(`Committed assets:  ${latest.entitiesSnapshot.length} entities`);
  } else {
    console.log(`No commits on this branch yet.`);
  }

  console.log('\nStaged 3D Entities for commit:');
  if (!state.stagedEntities || state.stagedEntities.length === 0) {
    console.log('  (no entities staged — use "sbox attach <model.glb> --lat <lat> --lng <lng>" to stage assets)');
  } else {
    for (const ent of state.stagedEntities) {
      const anchor = ent.space.geoAnchor;
      const posStr = anchor ? `(lat: ${anchor.lat}, lng: ${anchor.lng}, alt: ${anchor.alt || 0}m)` : '(no geo-anchor)';
      console.log(`  + [${ent.content.type}] ${ent.name} -> ${posStr}`);
    }
    console.log(`\n${state.stagedEntities.length} entities staged. Run 'sbox commit -m "<message>"' to commit.`);
  }
}
