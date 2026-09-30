/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * Universal Botanical Bridge Service Unit Tests
 * Validates ingesting real-world 3D tree entities from the Spatial Separator
 * and generating watertight 1:1 metric replacement trees across species.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import {
    UniversalBotanicalBridgeService,
    SPECIES_ADAPTERS,
    type SpatialTreeEntity
} from '../src/node/spatial/UniversalBotanicalBridgeService';
import { ColosseumTreeIdentificationEngine } from '../src/node/spatial/ColosseumTreeIdentificationEngine';

describe('UniversalBotanicalBridgeService (Spatial Separator to SB-Veggie)', () => {
    const bridge = new UniversalBotanicalBridgeService();

    it('correctly maps tree species and prompt descriptions to botanical adapters', () => {
        const stonePine = UniversalBotanicalBridgeService.resolveSpecies(
            'pinus_pinea',
            'Oppian Crest Italian Stone Pine #1',
            'Mature Italian stone pine (Pinus pinea) with parasol umbrella canopy'
        );
        expect(stonePine.species).toBe('pinus_pinea');
        expect(stonePine.archetype).toBe('conifer');
        expect(stonePine.leafMorphology).toBe(2); // conifer needles
        expect(stonePine.typicalCrownHeightRatio).toBe(0.55);

        const cypress = UniversalBotanicalBridgeService.resolveSpecies(
            'cupressus_sempervirens',
            'Palatine Columnar Cypress #4',
            'Slender flame spire Italian cypress'
        );
        expect(cypress.species).toBe('cupressus_sempervirens');
        expect(cypress.archetype).toBe('columnar');
        expect(cypress.leafMorphology).toBe(3); // scale foliage
        expect(cypress.typicalAspectSpread).toBe(0.22);

        const olive = UniversalBotanicalBridgeService.resolveSpecies(
            'olea_europaea',
            'Palatine Ancient Olive Grove #2'
        );
        expect(olive.species).toBe('olea_europaea');
        expect(olive.leafMorphology).toBe(4); // lanceolate
        expect(olive.reactionWood).toBe(1.80);

        const holmOak = UniversalBotanicalBridgeService.resolveSpecies(
            'quercus_ilex',
            'Celian Hill Holm Oak'
        );
        expect(holmOak.species).toBe('quercus_ilex');
        expect(holmOak.archetype).toBe('decurrent');
        expect(holmOak.leafMorphology).toBe(0); // lobed oak
    });

    it('synthesizes a 1:1 metric replacement model for a stone pine entity from the separator', async () => {
        const sampleTree = ColosseumTreeIdentificationEngine.getIdentifiedTrees()[0];
        expect(sampleTree).toBeDefined();

        const entity: SpatialTreeEntity = {
            id: sampleTree.id,
            name: sampleTree.name,
            species: sampleTree.species,
            nominalDimensions: sampleTree.nominalDimensions,
            nominalCentroid: sampleTree.nominalCentroid,
            canopyHeightMeters: sampleTree.canopyHeightMeters,
            crownDiameterMeters: sampleTree.crownDiameterMeters,
            trellisPrompt: sampleTree.trellisPrompt
        };

        const result = await bridge.synthesizeTreeFromEntity(entity, {
            season: 1.0,
            leafDensity: 0.8 // slightly lighter for fast unit test
        });

        expect(result.glbBuffer && result.glbBuffer.length > 0).toBeTruthy();
        expect(result.treeId).toBe(sampleTree.id);
        expect(result.species).toBe('pinus_pinea');
        expect(result.archetype).toBe('conifer');
        expect(result.fittedHeightMeters).toBe(sampleTree.canopyHeightMeters);
        expect(result.telemetry.outputVertices).toBeGreaterThan(100);
        expect(result.telemetry.outputTriangles).toBeGreaterThan(100);
        expect(fs.existsSync(result.outputGlbPath)).toBe(true);

        // Verify world coordinates are set from nominalCentroid
        expect(result.worldPosition[0]).toBeCloseTo(sampleTree.nominalCentroid[0], 0.1);
        expect(result.worldPosition[2]).toBeCloseTo(sampleTree.nominalCentroid[2], 0.1);
    }, 30000);

    it('synthesizes a winter bare manifold model for a columnar cypress entity', async () => {
        const cypressEntity: SpatialTreeEntity = {
            id: 'test-cypress-001',
            name: 'Via Triumphalis Cypress Spire',
            species: 'cupressus_sempervirens',
            canopyHeightMeters: 14.5,
            crownDiameterMeters: 3.2,
            metricDimensions: [3.2, 14.5, 3.2],
            metricPositionENU: [12.4, 0.0, -45.8]
        };

        const result = await bridge.synthesizeTreeFromEntity(cypressEntity, {
            season: 0.0, // winter bare wood
            leafDensity: 0.0
        });

        expect(result.glbBuffer).toBeDefined();
        expect(result.glbBuffer!.length).toBeGreaterThan(0);
        expect(result.archetype).toBe('columnar');
        expect(result.telemetry.outputTriangles).toBeGreaterThan(50);
    }, 30000);
});
