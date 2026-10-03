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

describe('Trained Neural Model Codebase Placement & Integration', () => {
    const registry = new TrainedModelRegistryService();

    it('1. should discover trained models across native core families', () => {
        const all = registry.discoverAllModels();
        expect(all.length).toBeGreaterThan(0);

        const summary = registry.getCatalogSummary();
        expect(summary.totalModels).toBeGreaterThan(0);

        // Core families should have models discovered
        expect(summary.families.sbhuman).toBeGreaterThanOrEqual(3);
        expect(summary.families['performer_4dgs']).toBeGreaterThanOrEqual(1);
        expect(summary.families.geobox).toBeGreaterThanOrEqual(2);
    });

    it('2. should properly resolve parametric humanoid body models (.sbhuman)', () => {
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

    it('3. should provide Performer 4DGS humanoid avatar manifests and viewport assets', () => {
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

    it('4. should resolve GeoBox vision-location checkpoints and spherical coordinates gallery', () => {
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
