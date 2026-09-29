/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
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

    it('1. should discover trained models across all 4 core families', () => {
        const all = registry.discoverAllModels();
        expect(all.length).toBeGreaterThan(0);

        const summary = registry.getCatalogSummary();
        expect(summary.totalModels).toBeGreaterThan(0);
        expect(summary.totalSizeBytes).toBeGreaterThan(100 * 1024 * 1024); // Over 100 MB

        // All core families should have models discovered
        expect(summary.families.smplx).toBeGreaterThanOrEqual(3);
        expect(summary.families['4danyone_4dgs']).toBeGreaterThanOrEqual(1);
        expect(summary.families.omniroam).toBeGreaterThanOrEqual(2);
        expect(summary.families.geobox).toBeGreaterThanOrEqual(2);
    });

    it('2. should properly resolve parametric humanoid body models (.sbhuman or smplx)', () => {
        const neutral = registry.getSmplxModel('neutral');
        const male = registry.getSmplxModel('male');
        const female = registry.getSmplxModel('female');

        expect(neutral).toBeDefined();
        expect(male).toBeDefined();
        expect(female).toBeDefined();

        expect(fs.existsSync(neutral!)).toBe(true);
        expect(fs.statSync(neutral!).size).toBeGreaterThan(1024 * 1024); // > 1 MB (.sbhuman is ~1.96 MB, legacy npz is ~108 MB)
    });

    it('3. should provide 4DAnyone 4DGS humanoid avatar manifests and viewport assets', () => {
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

    it('4. should resolve OmniRoam camera navigation foundation checkpoints', () => {
        const preview = registry.getOmniRoamCheckpoint('preview');
        const refine = registry.getOmniRoamCheckpoint('refine');

        expect(preview).toBeDefined();
        expect(refine).toBeDefined();
        expect(fs.existsSync(preview!)).toBe(true);
        expect(fs.existsSync(refine!)).toBe(true);
        expect(fs.statSync(preview!).size).toBeGreaterThan(1024 * 1024 * 1024); // > 1 GB
    });

    it('5. should resolve GeoBox vision-location checkpoints and spherical coordinates gallery', () => {
        const pt = registry.getGeoBoxCheckpoint('real_trained');
        const gallery = registry.discoverGeoBoxModels().find(m => m.format === 'npy');

        expect(pt).toBeDefined();
        expect(fs.existsSync(pt!)).toBe(true);
        expect(fs.statSync(pt!).size).toBeGreaterThan(1024 * 1024 * 1024); // > 1 GB

        expect(gallery).toBeDefined();
        expect(fs.existsSync(gallery!.filePath)).toBe(true);
    });

    it('6. should register humanoid splat avatars and SMPL-X in SpatialAssetVaultService', () => {
        const vault = new SpatialAssetVaultService();
        const records = vault.listAssets();

        // Check for 4DGS humanoid vault registrations
        const humanoidRecord = records.find(r => r.representation.durableUri === 'vault://humanoid/2785536');
        expect(humanoidRecord).toBeDefined();
        expect(humanoidRecord!.representation.type).toBe('gaussian-splat');
        expect(humanoidRecord!.representation.metadata?.splatCount).toBe(121942);

        // Check for SMPL-X body model vault registration
        const smplxRecord = records.find(r => r.representation.durableUri === 'vault://body_models/smplx/neutral');
        expect(smplxRecord).toBeDefined();
        expect(smplxRecord!.representation.metadata?.numVertices).toBe(10475);
    });
});
