/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as path from 'path';
import * as fs from 'fs-extra';
import { PhotorealismEvaluator } from '@scratchbox/core/node';
import { SpatialRepository } from '../state/spatial-repository';

export async function qaCommand(args: string[]): Promise<void> {
  let targetFile: string | undefined = args[0] && !args[0].startsWith('--') ? args[0] : undefined;

  const branchIdx = args.indexOf('--branch');
  const targetBranch = branchIdx !== -1 && args[branchIdx + 1] ? args[branchIdx + 1] : undefined;

  if (targetFile) {
    const resolved = path.resolve(process.cwd(), targetFile);
    if (!(await fs.pathExists(resolved))) {
      console.error(`Error: File '${resolved}' not found.`);
      process.exitCode = 1;
      return;
    }

    await evaluateGlbFile(resolved);
    return;
  }

  // Evaluate assets in current or target branch
  const { state, manager, rootDir } = await SpatialRepository.load();
  const branchName = targetBranch || state.activeBranch;
  const latest = manager.getLatestCommit(branchName);

  if (!latest || latest.entitiesSnapshot.length === 0) {
    console.log(`No assets found on branch '${branchName}' to run QA against.`);
    console.log(`Use 'sbox attach' or pass a direct glb file: 'sbox qa <model.glb>'`);
    return;
  }

  console.log(`\nRunning Autonomous Photorealism QA on branch '${branchName}' (${latest.entitiesSnapshot.length} entities)...`);

  let passedCount = 0;
  let totalEvaluated = 0;

  for (const ent of latest.entitiesSnapshot) {
    if (ent.content.type === 'mesh-glb' || ent.content.durableUri.endsWith('.glb')) {
      const glbPath = path.isAbsolute(ent.content.durableUri)
        ? ent.content.durableUri
        : path.resolve(rootDir, ent.content.durableUri);

      if (await fs.pathExists(glbPath)) {
        totalEvaluated++;
        const passed = await evaluateGlbFile(glbPath, ent.name);
        if (passed) passedCount++;
      }
    }
  }

  if (totalEvaluated === 0) {
    console.log('No local GLB assets found for branch entities.');
  } else {
    console.log(`\nQA Summary: ${passedCount}/${totalEvaluated} assets met photorealism standards (score >= 90/100).`);
  }
}

async function evaluateGlbFile(filePath: string, name?: string): Promise<boolean> {
  const assetName = name || path.basename(filePath);
  console.log(`\n======================================================`);
  console.log(`Evaluating 3D Asset: ${assetName} (${path.basename(filePath)})`);
  console.log(`======================================================`);

  try {
    const buffer = await fs.readFile(filePath);
    const evaluator = new PhotorealismEvaluator();
    const report = evaluator.evaluateGlb(assetName, buffer);

    console.log(`Geometry:   ${report.vertexCount.toLocaleString()} vertices, ${report.triangleCount.toLocaleString()} triangles`);
    console.log(`Dimensions: ${report.boundingDimensions.x.toFixed(2)}m x ${report.boundingDimensions.y.toFixed(2)}m x ${report.boundingDimensions.z.toFixed(2)}m`);
    console.log(`Material:   ${report.materialSummary.name} (metallic: ${report.materialSummary.metallic}, roughness: ${report.materialSummary.roughness})`);
    console.log(`\nPhotorealism Breakdown (Threshold: 90 / 100):`);
    console.log(`  - Density Score:            ${report.densityScore} / 25`);
    console.log(`  - Normal Smoothness:        ${report.normalSmoothnessScore} / 25`);
    console.log(`  - Crevice AO & Weathering:  ${report.aoWeatheringScore} / 25`);
    console.log(`  - Physical PBR Accuracy:    ${report.pbrMaterialScore} / 25`);
    console.log(`  -----------------------------------------`);
    console.log(`  TOTAL SCORE:                ${report.totalScore} / 100 [${report.isPhotorealistic ? 'PASS' : 'FAIL'}]`);

    if (report.diagnostics.length > 0) {
      console.log(`\nDiagnostics:`);
      for (const diag of report.diagnostics) {
        console.log(`  * ${diag}`);
      }
    }

    return report.isPhotorealistic;
  } catch (err: any) {
    console.error(`Failed to evaluate '${filePath}': ${err.message}`);
    return false;
  }
}
