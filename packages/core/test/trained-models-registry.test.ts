/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
    TrainedModelRegistryService,
    SpatialAssetVaultService
} from '../src/node';
import { requireAll, requireAssets, withReason } from './helpers/requirements';

// Every model family the registry discovers is a gitignored local artifact.
const sbhuman = requireAssets(['neutral', 'male', 'female'].map(v => `public/models/sbhuman_${v}.sbhuman`));
const performerPly = requireAssets(
    ['models/performer_4dgs/demos/2785536/human_4dgs.ply'],
    'scripts/regenerate_5_demos.ts (GVHMR body via scripts/run_gvhmr.py)'
);
const performerViewport = requireAll(
    performerPly,
    requireAssets(['public/models/humanoid_2785536.glb'], 'scripts/build_performer_surfaces.ts'),
    requireAssets(['public/models/humanoid_2785536.splat'])
);
const geobox = requireAll(
    requireAssets(['build/geobox_checkpoints/geobox_real_trained.pt'], 'GeoBox training (tools/geobox/train_vertex.py)'),
    requireAssets(['build/geobox_checkpoints/coordinates_100K.npy'], 'tools/geobox/model/gps_gallery/download_100k_gallery.py')
);
const allFamilies = requireAll(sbhuman, performerPly, geobox);

describe('Trained Neural Model Codebase Placement & Integration', () => {
    const registry = new TrainedModelRegistryService();

    it.skipIf(!allFamilies.ok)(withReason('1. should discover trained models across native core families', allFamilies), () => {
        const all = registry.discoverAllModels();
        expect(all.length).toBeGreaterThan(0);

        const summary = registry.getCatalogSummary();
        expect(summary.totalModels).toBeGreaterThan(0);

        // Core families should have models discovered
        expect(summary.families.sbhuman).toBeGreaterThanOrEqual(3);
        expect(summary.families['performer_4dgs']).toBeGreaterThanOrEqual(1);
        expect(summary.families.geobox).toBeGreaterThanOrEqual(2);
    });

    it.skipIf(!sbhuman.ok)(withReason('2. should properly resolve parametric humanoid body models (.sbhuman)', sbhuman), () => {
        const sbNeutral = registry.getSbHumanModel('neutral');
        expect(sbNeutral).toBeDefined();
        expect(fs.existsSync(sbNeutral!)).toBe(true);

        const male = registry.getSbHumanModel('male');
        const female = registry.getSbHumanModel('female');

        expect(male).toBeDefined();
        expect(female).toBeDefined();
        expect(fs.existsSync(male!)).toBe(true);
        expect(fs.existsSync(female!)).toBe(true);
        expect(fs.statSync(sbNeutral!).size).toBeGreaterThan(1024 * 1024); // > 1 MB (.sbhuman is ~1.96 MB)
    });

    it.skipIf(!performerViewport.ok)(withReason('3. should provide Performer 4DGS humanoid avatar manifests and viewport assets', performerViewport), () => {
        const avatar = registry.get4DGSAvatar('2785536');
        expect(avatar).toBeDefined();
        expect(avatar!.id).toBe('2785536');
        expect(fs.existsSync(avatar!.plyPath)).toBe(true);
        expect(avatar!.splatBytes).toBeGreaterThan(1000000);

        // Verify pre-converted .splat and .glb files exist
        expect(avatar!.splatPath).toBeDefined();
        expect(fs.existsSync(avatar!.splatPath!)).toBe(true);
        expect(avatar!.glbPath).toBeDefined();
        expect(fs.existsSync(avatar!.glbPath!)).toBe(true);
    });

    it.skipIf(!geobox.ok)(withReason('4. should resolve GeoBox vision-location checkpoints and spherical coordinates gallery', geobox), () => {
        const pt = registry.getGeoBoxCheckpoint('real_trained');
        const gallery = registry.discoverGeoBoxModels().find(m => m.format === 'npy');

        expect(pt).toBeDefined();
        expect(fs.existsSync(pt!)).toBe(true);
        expect(fs.statSync(pt!).size).toBeGreaterThan(1024 * 1024 * 1024); // > 1 GB

        expect(gallery).toBeDefined();
        expect(fs.existsSync(gallery!.filePath)).toBe(true);
    });

    it('5. should register humanoid splat avatars and SB-Human in SpatialAssetVaultService', () => {
        const vault = new SpatialAssetVaultService();
        const records = vault.listAssets();

        // Check for 4DGS humanoid vault registrations
        const humanoidRecord = records.find(r => r.representation.durableUri === 'vault://humanoid/2785536');
        expect(humanoidRecord).toBeDefined();
        expect(humanoidRecord!.representation.type).toBe('gaussian-splat');
        expect(humanoidRecord!.representation.metadata?.splatCount).toBe(121942);

        // Check for SB-Human parametric body model vault registration
        const sbhumanRecord = records.find(r => r.representation.durableUri === 'vault://body_models/sbhuman/neutral');
        expect(sbhumanRecord).toBeDefined();
        expect(sbhumanRecord!.representation.metadata?.numVertices).toBe(10475);
    });
});
