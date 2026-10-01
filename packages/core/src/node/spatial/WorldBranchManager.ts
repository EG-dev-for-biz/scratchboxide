/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { Entity4D } from '../../common/geospatial-4d-protocol';

export interface BranchCommit {
  id: string;                         // Commit hash
  parentCommitId?: string;
  message: string;
  timestamp: string;
  author: string;
  entitiesSnapshot: Entity4D[];       // Flat immutable snapshot of all branch entities
}

export class WorldBranchManager {
  private branches: Map<string, BranchCommit[]> = new Map();

  constructor() {
    // Seed default main branch and its initial empty commit
    this.branches.set('earth/main', [
      {
        id: 'commit-main-root-00000000',
        message: 'Initial real-world baseline grounding layer',
        timestamp: new Date().toISOString(),
        author: 'Scratchbox Geospatial System',
        entitiesSnapshot: []
      }
    ]);
  }

  /**
   * Forks an existing branch to create an alternate multiverse world layer.
   * Standard branches: earth/cyberpunk, earth/post-apocalypse, earth/mars-colony-2150
   */
  public createBranch(newBranchId: string, parentBranchId: string = 'earth/main'): void {
    const parentHistory = this.branches.get(parentBranchId);
    if (!parentHistory || parentHistory.length === 0) {
      throw new Error(`Parent branch ${parentBranchId} does not exist in multiverse`);
    }

    if (this.branches.has(newBranchId)) {
      throw new Error(`Branch ${newBranchId} already exists`);
    }

    const latestParentCommit = parentHistory[parentHistory.length - 1];

    // Copy-on-write commit history pointing to parent
    this.branches.set(newBranchId, [
      {
        id: `commit-${Math.abs(this.hashCode(newBranchId + Date.now())).toString(16)}`,
        parentCommitId: latestParentCommit.id,
        message: `Branch created from ${parentBranchId} latest state`,
        timestamp: new Date().toISOString(),
        author: 'Multiverse Branching Manager',
        entitiesSnapshot: [...latestParentCommit.entitiesSnapshot] // shallow copy of entity references
      }
    ]);
  }

  /**
   * Commits the current world state to a branch.
   */
  public commit(
    branchId: string,
    message: string,
    author: string,
    entities: Entity4D[]
  ): BranchCommit {
    const history = this.branches.get(branchId);
    if (!history || history.length === 0) {
      throw new Error(`Branch ${branchId} does not exist`);
    }

    const latestCommit = history[history.length - 1];
    const hashSeed = `${branchId}-${message}-${Date.now()}`;
    const commitId = `commit-${Math.abs(this.hashCode(hashSeed)).toString(16)}`;

    // Create immutable deep-cloned state of committed entities bound to this branch
    const committedEntities = entities.map(ent => ({
      ...ent,
      lineage: {
        ...ent.lineage,
        worldBranchId: branchId,
        version: ent.lineage.worldBranchId === branchId ? ent.lineage.version + 1 : 1,
        parentCommitHash: latestCommit.id
      }
    }));

    const newCommit: BranchCommit = {
      id: commitId,
      parentCommitId: latestCommit.id,
      message,
      timestamp: new Date().toISOString(),
      author,
      entitiesSnapshot: committedEntities
    };

    history.push(newCommit);
    this.branches.set(branchId, history);
    return newCommit;
  }

  /**
   * Calculates structural diffs of entities between two multiverse branches.
   */
  public computeDiff(
    targetBranchId: string,
    sourceBranchId: string = 'earth/main'
  ): {
    added: Entity4D[];
    modified: Entity4D[];
    deleted: string[]; // List of entity IDs
  } {
    const targetHistory = this.branches.get(targetBranchId);
    const sourceHistory = this.branches.get(sourceBranchId);

    if (!targetHistory || targetHistory.length === 0) {
      throw new Error(`Target branch ${targetBranchId} does not exist`);
    }
    if (!sourceHistory || sourceHistory.length === 0) {
      throw new Error(`Source branch ${sourceBranchId} does not exist`);
    }

    const targetSnap = targetHistory[targetHistory.length - 1].entitiesSnapshot;
    const sourceSnap = sourceHistory[sourceHistory.length - 1].entitiesSnapshot;

    const added: Entity4D[] = [];
    const modified: Entity4D[] = [];
    const deleted: string[] = [];

    const sourceMap = new Map(sourceSnap.map(e => [e.id, e]));
    const targetMap = new Map(targetSnap.map(e => [e.id, e]));

    // Determine added and modified
    for (const [id, ent] of targetMap.entries()) {
      const sourceEnt = sourceMap.get(id);
      if (!sourceEnt) {
        added.push(ent);
      } else {
        // Simple comparison of payload URIs or transforms
        if (
          sourceEnt.content.durableUri !== ent.content.durableUri ||
          JSON.stringify(sourceEnt.space.localTransform) !== JSON.stringify(ent.space.localTransform)
        ) {
          modified.push(ent);
        }
      }
    }

    // Determine deleted
    for (const sourceId of sourceMap.keys()) {
      if (!targetMap.has(sourceId)) {
        deleted.push(sourceId);
      }
    }

    return { added, modified, deleted };
  }

  /**
   * Merges modifications of a geodetic spatial window from one branch back into another.
   */
  public mergeRegion(
    sourceBranchId: string,
    targetBranchId: string,
    boundingRegion: {
      minLat: number; maxLat: number;
      minLng: number; maxLng: number;
    },
    message: string,
    author: string
  ): BranchCommit {
    const sourceHistory = this.branches.get(sourceBranchId);
    const targetHistory = this.branches.get(targetBranchId);

    if (!sourceHistory || !targetHistory) {
      throw new Error('Both source and target branches must exist to perform region merge');
    }

    const sourceSnap = sourceHistory[sourceHistory.length - 1].entitiesSnapshot;
    const targetSnap = targetHistory[targetHistory.length - 1].entitiesSnapshot;

    // Filter entities falling inside spatial geodetic bounding box
    const isInsideRegion = (ent: Entity4D) => {
      const g = ent.space.geoAnchor;
      if (!g) return false;
      return g.lat >= boundingRegion.minLat && g.lat <= boundingRegion.maxLat &&
             g.lng >= boundingRegion.minLng && g.lng <= boundingRegion.maxLng;
    };

    const sourceInRegion = sourceSnap.filter(isInsideRegion);
    const targetOutsideRegion = targetSnap.filter(ent => !isInsideRegion(ent));

    // Combine: keep everything outside region from target, and override everything in region from source
    const mergedEntities = [...targetOutsideRegion, ...sourceInRegion];

    return this.commit(targetBranchId, message, author, mergedEntities);
  }

  public getLatestCommit(branchId: string): BranchCommit | null {
    const history = this.branches.get(branchId);
    return (history && history.length > 0) ? history[history.length - 1] : null;
  }

  /**
   * Retrieves the full commit history of a branch.
   */
  public getBranchHistory(branchId: string): BranchCommit[] | undefined {
    return this.branches.get(branchId);
  }

  /**
   * List all branched world layer names.
   */
  public getBranchNames(): string[] {
    return Array.from(this.branches.keys());
  }

  private hashCode(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = (hash << 5) - hash + str.charCodeAt(i);
      hash |= 0;
    }
    return hash;
  }
}
