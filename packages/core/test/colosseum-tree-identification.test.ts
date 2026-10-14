/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect, afterAll } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import {
  ColosseumTreeIdentificationEngine,
  BOTANICAL_ZONES,
  SPECIES_PROFILES,
  type BotanicalSpecies,
  type BotanicalZone
} from '../src/node/spatial/ColosseumTreeIdentificationEngine';
import { Colosseum3DMeshSeparatorService } from '../src/node/spatial/Colosseum3DMeshSeparatorService';
import { REPO_ROOT } from './helpers/requirements';

/**
 * The canonical Colosseum mesh. public/models/ is gitignored, but the identical file is tracked as the Cloud Run
 * spatial-separator asset (deploy/cloud-run/spatial-separator/assets/colosseum_clay.glb, added in 6bb97f1).
 */
function resolveCanonicalColosseumGlb(): string {
  const candidates = ['public/models/colosseum_clay.glb', 'deploy/cloud-run/spatial-separator/assets/colosseum_clay.glb']
    .map(p => path.join(REPO_ROOT, p));
  return candidates.find(p => fs.existsSync(p)) ?? candidates[candidates.length - 1];
}

describe('ColosseumTreeIdentificationEngine (High-Accuracy Botanical 3D Foliage)', () => {
  const modelPath = resolveCanonicalColosseumGlb();
  // The trees dataset is written to a temp dir, not over the tracked deploy/ asset.
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-colosseum-trees-'));
  afterAll(() => fs.rmSync(outDir, { recursive: true, force: true }));

  it('identifies 1,260 discrete botanical trees across 13 geographic zones', () => {
    const trees = ColosseumTreeIdentificationEngine.getIdentifiedTrees();

    expect(trees).toBeDefined();
    expect(trees.length).toBe(1260);

    // Verify all 13 zones are populated
    const zoneCounts = ColosseumTreeIdentificationEngine.getBotanicalSummary(trees).zoneBreakdown;
    expect(zoneCounts.oppian_hill_crest).toBe(125);
    expect(zoneCounts.colle_oppio_slopes).toBe(105);
    expect(zoneCounts.via_san_gregorio).toBe(60);
    expect(zoneCounts.palatine_hill_slopes).toBe(75);
    expect(zoneCounts.celian_colosseum_perimeter).toBe(55);
    expect(zoneCounts.baths_of_trajan_east).toBe(160);
    expect(zoneCounts.farnese_palatine_west).toBe(135);
    expect(zoneCounts.villa_celimontana_south).toBe(110);
    expect(zoneCounts.fori_imperiali_north).toBe(65);
    expect(zoneCounts.colosseum_plaza_apron).toBe(30);
    expect(zoneCounts.celian_south_gardens).toBe(130);
    expect(zoneCounts.labicana_east_corridor).toBe(110);
    expect(zoneCounts.oppian_northeast_peristyle).toBe(100);

    // Total = 125 + 105 + 60 + 75 + 55 + 160 + 135 + 110 + 65 + 30 + 130 + 110 + 100 = 1260
    const totalZoneSum = Object.values(zoneCounts).reduce((acc, count) => acc + count, 0);
    expect(totalZoneSum).toBe(1260);
  });

  it('accurately classifies trees by Mediterranean botanical species', () => {
    const trees = ColosseumTreeIdentificationEngine.getIdentifiedTrees();
    const summary = ColosseumTreeIdentificationEngine.getBotanicalSummary(trees);

    // Verify species breakdown
    expect(summary.speciesBreakdown.pinus_pinea).toBe(553);             // Dominant Roman umbrella pine
    expect(summary.speciesBreakdown.quercus_ilex).toBe(385);            // Evergreen Mediterranean holm oak
    expect(summary.speciesBreakdown.cupressus_sempervirens).toBe(162);   // Columnar Cypress spires
    expect(summary.speciesBreakdown.olea_europaea).toBe(65);             // Ancient Palatine olive groves
    expect(summary.speciesBreakdown.laurus_nobilis).toBe(95);            // Sweet Bay Laurels
  });

  it('validates physical metric dimensions, elevation, and 3D bounding geometry', () => {
    const trees = ColosseumTreeIdentificationEngine.getIdentifiedTrees();

    for (const tree of trees) {
      // Metric dimensions must be positive and realistic for botanical species
      expect(tree.canopyHeightMeters).toBeGreaterThanOrEqual(4.0);
      expect(tree.canopyHeightMeters).toBeLessThanOrEqual(22.0);
      expect(tree.crownDiameterMeters).toBeGreaterThanOrEqual(2.0);
      expect(tree.crownDiameterMeters).toBeLessThanOrEqual(18.0);
      expect(tree.crownVolumeM3).toBeGreaterThan(0);

      // Centroid and ground elevation sanity check within full Colosseum mesh bounds
      // Colosseum mesh: X [-343, 343], Z [-375, 240], Y [0, 85]
      expect(tree.nominalCentroid[0]).toBeGreaterThan(-350);
      expect(tree.nominalCentroid[0]).toBeLessThan(370);
      expect(tree.nominalCentroid[2]).toBeGreaterThan(-390);
      expect(tree.nominalCentroid[2]).toBeLessThan(260);
      expect(tree.groundElevationMeters).toBeGreaterThanOrEqual(0.0);
      expect(tree.apexElevationMeters).toBeLessThan(100.0);

      // Trellis prompt must be descriptive and mention species and zone
      expect(tree.trellisPrompt).toContain(tree.scientificName);
      expect(tree.trellisPrompt.length).toBeGreaterThan(40);
    }
  });

  it('calculates comprehensive botanical statistics and canopy cover metrics', () => {
    const summary = ColosseumTreeIdentificationEngine.getBotanicalSummary();

    expect(summary.totalTrees).toBe(1260);
    expect(summary.meanTreeHeightMeters).toBeGreaterThan(10.0);
    expect(summary.meanTreeHeightMeters).toBeLessThan(16.0);
    expect(summary.meanCrownDiameterMeters).toBeGreaterThan(6.0);
    expect(summary.meanCrownDiameterMeters).toBeLessThan(12.0);
    expect(summary.totalCanopyVolumeM3).toBeGreaterThan(100000); // Over 100,000 m³ of green canopy volume
    expect(summary.totalCanopyCoverAreaM2).toBeGreaterThan(30000); // Over 30,000 m² of urban tree cover
  });

  it('filters trees accurately by zone, species, and height range', () => {
    const cypresses = ColosseumTreeIdentificationEngine.filterTrees({ species: 'cupressus_sempervirens' });
    expect(cypresses.length).toBe(162);
    for (const c of cypresses) {
      expect(c.species).toBe('cupressus_sempervirens');
      expect(c.crownDiameterMeters).toBeLessThan(5.0); // Slender spires
    }

    const oppianTrees = ColosseumTreeIdentificationEngine.filterTrees({ zone: 'oppian_hill_crest' });
    expect(oppianTrees.length).toBe(125);

    const trajanTrees = ColosseumTreeIdentificationEngine.filterTrees({ zone: 'baths_of_trajan_east' });
    expect(trajanTrees.length).toBe(160);

    const tallTrees = ColosseumTreeIdentificationEngine.filterTrees({ minHeight: 15.0 });
    expect(tallTrees.length).toBeGreaterThan(50);
    for (const t of tallTrees) {
      expect(t.canopyHeightMeters).toBeGreaterThanOrEqual(15.0);
    }
  });

  it('integrates seamlessly with Colosseum3DMeshSeparatorService via mode === "trees"', () => {
    expect(fs.existsSync(modelPath)).toBe(true);

    const scene = Colosseum3DMeshSeparatorService.separate3DMesh(modelPath, { mode: 'trees' });
    expect(scene.objects.length).toBe(1260);
    expect(scene.granularityMode).toBe('trees');

    // All objects must belong to foliage_trees category
    for (const obj of scene.objects) {
      expect(obj.category).toBe('foliage_trees');
      expect(obj.orientedBoundingBox.volumeM3).toBeGreaterThan(0);
      expect(obj.tightnessGainPercent).toBeGreaterThanOrEqual(0);
    }

    // Save dedicated trees_dataset.json artifact
    fs.writeFileSync(path.join(outDir, 'trees_dataset.json'), JSON.stringify(scene.objects, null, 2), 'utf8');
  });

  it('generates physically grounded tree stands (97 stands) with zero monument collision and ground datum lock', () => {
    const stands = ColosseumTreeIdentificationEngine.getPhysicallyGroundedStands();
    expect(stands).toBeDefined();
    expect(stands.length).toBe(97);

    // Verify all 97 stands have zero collision with Colosseum core and are grounded
    for (const stand of stands) {
      const c = stand.boundingBox.centroid;
      const inColosseumCore = (c[0] * c[0]) / (95 * 95) + (c[2] * c[2]) / (80 * 80) < 1.0;
      expect(inColosseumCore).toBe(false);

      // Must be grounded at terrain elevation (min Y matches ground elevation)
      expect(stand.boundingBox.min[1]).toBe(stand.groundElevationMeters);
      expect(stand.canopyHeightMeters).toBeGreaterThanOrEqual(3.0);
      expect(stand.canopyHeightMeters).toBeLessThanOrEqual(28.0);
    }
  });

  it('aggregates physical stands into consolidated botanical park groves', () => {
    const groves = ColosseumTreeIdentificationEngine.getBotanicalGroves();
    expect(groves).toBeDefined();
    expect(groves.length).toBeGreaterThanOrEqual(24);
    expect(groves.length).toBeLessThanOrEqual(36);

    for (const grove of groves) {
      expect(grove.treeCount).toBeGreaterThanOrEqual(1);
      expect(grove.zoneName).toBeDefined();
      expect(grove.boundingBox.dimensions[0]).toBeGreaterThan(0);
      expect(grove.boundingBox.dimensions[1]).toBeGreaterThan(0);
      expect(grove.boundingBox.dimensions[2]).toBeGreaterThan(0);
    }
  });
});
