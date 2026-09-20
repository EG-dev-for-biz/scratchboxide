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
import { WorldBranchManager, BranchCommit } from '@scratchbox/core/node';
import { Entity4D } from '@scratchbox/core/common';

export interface WorkspaceSpatialState {
  version: number;
  activeBranch: string;
  stagedEntities: Entity4D[];
  branches: Record<string, BranchCommit[]>;
}

export class SpatialRepository {
  public static readonly STATE_FILENAME = 'spatial-state.json';
  public static readonly SCRATCHBOX_DIR = '.scratchbox';

  /**
   * Resolves the workspace root directory by locating .scratchbox or package.json upwards.
   */
  public static findWorkspaceRoot(startDir: string = process.cwd()): string {
    let current = path.resolve(startDir);
    while (true) {
      if (fs.existsSync(path.join(current, this.SCRATCHBOX_DIR)) || fs.existsSync(path.join(current, 'package.json'))) {
        return current;
      }
      const parent = path.dirname(current);
      if (parent === current) {
        return path.resolve(startDir);
      }
      current = parent;
    }
  }

  public static getStateFilePath(rootDir: string): string {
    return path.join(rootDir, this.SCRATCHBOX_DIR, this.STATE_FILENAME);
  }

  /**
   * Initializes a new spatial repository state in the target workspace.
   */
  public static async init(rootDir: string = process.cwd()): Promise<{ initialized: boolean; statePath: string }> {
    const sboxDir = path.join(rootDir, this.SCRATCHBOX_DIR);
    const stateFile = path.join(sboxDir, this.STATE_FILENAME);

    await fs.ensureDir(sboxDir);

    if (await fs.pathExists(stateFile)) {
      return { initialized: false, statePath: stateFile };
    }

    const initialManager = new WorldBranchManager();
    const branchesMap: Record<string, BranchCommit[]> = {};
    for (const b of initialManager.getBranchNames()) {
      branchesMap[b] = initialManager.getBranchHistory(b) || [];
    }

    const state: WorkspaceSpatialState = {
      version: 1,
      activeBranch: 'earth/main',
      stagedEntities: [],
      branches: branchesMap
    };

    await fs.writeJson(stateFile, state, { spaces: 2 });
    return { initialized: true, statePath: stateFile };
  }

  /**
   * Loads the current spatial workspace state and reconstructs WorldBranchManager.
   */
  public static async load(rootDir: string = this.findWorkspaceRoot()): Promise<{
    state: WorkspaceSpatialState;
    manager: WorldBranchManager;
    statePath: string;
    rootDir: string;
  }> {
    const statePath = this.getStateFilePath(rootDir);
    if (!(await fs.pathExists(statePath))) {
      throw new Error(
        `Not a Scratchbox spatial repository (or any parent directory).\nRun 'sbox init' to initialize a spatial repository.`
      );
    }

    const state: WorkspaceSpatialState = await fs.readJson(statePath);
    const manager = new WorldBranchManager();

    // Hydrate manager with persisted branches
    for (const [branchId, commits] of Object.entries(state.branches)) {
      if (branchId === 'earth/main') {
        (manager as any).branches.set(branchId, commits);
      } else {
        (manager as any).branches.set(branchId, commits);
      }
    }

    return { state, manager, statePath, rootDir };
  }

  /**
   * Saves the updated spatial workspace state to disk.
   */
  public static async save(
    rootDir: string,
    state: WorkspaceSpatialState,
    manager?: WorldBranchManager
  ): Promise<void> {
    const statePath = this.getStateFilePath(rootDir);
    await fs.ensureDir(path.dirname(statePath));

    if (manager) {
      const branchesMap: Record<string, BranchCommit[]> = {};
      for (const b of manager.getBranchNames()) {
        branchesMap[b] = manager.getBranchHistory(b) || [];
      }
      state.branches = branchesMap;
    }

    await fs.writeJson(statePath, state, { spaces: 2 });
  }
}
