import { test } from 'vitest';
/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as assert from 'assert';
import {
    CreativeLocationCastingService,
    castCreativeLocation,
    type CastedLocation
} from '../src/browser/generative-canvas/services/CreativeLocationCastingService';
import {
    synthesizeContextual3DScene,
    synthesizeRawContextual3DScene,
    applyCreativeLocationCasting
} from '../src/browser/generative-canvas/procedural-3d-synthesizer';
import type { Scene3DData } from '../src/browser/generative-canvas/canvas-types';

async function runCreativeLocationCastingTests(): Promise<void> {
    console.log('🚀 Running Creative Location Casting Test Suite...\n');

    // ========================================================================
    // TEST 1: User Example 1 - Bullet Going Through Glass -> Ballistics Proving Ground
    // ========================================================================
    console.log('  Testing Case 1: "bullet going through glass" -> Driving Range / Proving Ground...');
    {
        const prompt = 'bullet going through glass';
        const casted = castCreativeLocation(prompt);

        assert.ok(casted.isRealWorld, 'Should be flagged as real-world castable');
        assert.strictEqual(casted.archetype, 'ballistics_proving_ground');
        assert.ok(
            casted.landmarkName.includes('Angeles Shooting Range') ||
            casted.landmarkName.includes('Topgolf') ||
            casted.landmarkName.includes('Ballistics'),
            `Landmark should be a shooting range or driving range, got: ${casted.landmarkName}`
        );
        assert.ok(casted.lat !== 0 && casted.lng !== 0, 'Coordinates must be authentic non-zero numbers');
        assert.ok(casted.rationale.length > 20, 'Rationale must be descriptive and contextual');
        assert.ok(
            casted.rationale.toLowerCase().includes('ballistic') ||
            casted.rationale.toLowerCase().includes('bullet') ||
            casted.rationale.toLowerCase().includes('range') ||
            casted.rationale.toLowerCase().includes('impact'),
            `Rationale should explain the pairing, got: ${casted.rationale}`
        );
        console.log(`  ✓ Case 1 Passed: "${prompt}" -> ${casted.landmarkName} (${casted.archetype})\n    Rationale: ${casted.rationale}`);
    }

    // ========================================================================
    // TEST 2: User Example 2 - Black Background Stage -> Black Soundstage (Pinewood / Sony)
    // ========================================================================
    console.log('  Testing Case 2: "black background" -> Soundstage with Black Void / TC...');
    {
        const prompt = 'black background with single dramatic spot light';
        const casted = castCreativeLocation(prompt);

        assert.strictEqual(casted.archetype, 'black_box_soundstage');
        assert.ok(
            casted.landmarkName.includes('Pinewood Studios') ||
            casted.landmarkName.includes('Sony Pictures') ||
            casted.landmarkName.includes('Soundstage'),
            `Landmark should be a film soundstage, got: ${casted.landmarkName}`
        );
        assert.ok(casted.lat > 30, 'Latitude must be valid for major film stages');
        assert.ok(
            casted.rationale.toLowerCase().includes('soundstage') ||
            casted.rationale.toLowerCase().includes('black') ||
            casted.rationale.toLowerCase().includes('stage'),
            `Rationale should explain soundstage pairing, got: ${casted.rationale}`
        );
        console.log(`  ✓ Case 2 Passed: "${prompt}" -> ${casted.landmarkName} (${casted.archetype})\n    Rationale: ${casted.rationale}`);
    }

    // ========================================================================
    // TEST 3: High Speed Motorsport / Racing Archetype
    // ========================================================================
    console.log('  Testing Case 3: "supercar drifting at high speed" -> Motorsport Proving Ground...');
    {
        const prompt = 'supercar drifting at 200mph through hairpin turn';
        const casted = castCreativeLocation(prompt);

        assert.strictEqual(casted.archetype, 'high_speed_motorsport');
        assert.ok(
            casted.landmarkName.includes('Nürburgring') ||
            casted.landmarkName.includes('Spa-Francorchamps') ||
            casted.landmarkName.includes('Laguna Seca') ||
            casted.landmarkName.includes('Circuit'),
            `Landmark should be a premier race circuit, got: ${casted.landmarkName}`
        );
        console.log(`  ✓ Case 3 Passed: "${prompt}" -> ${casted.landmarkName} (${casted.archetype})`);
    }

    // ========================================================================
    // TEST 4: Scientific / Subatomic Particle Collision Archetype
    // ========================================================================
    console.log('  Testing Case 4: "quantum subatomic particle accelerator collision" -> CERN...');
    {
        const prompt = 'quantum subatomic particle accelerator collision';
        const casted = castCreativeLocation(prompt);

        assert.strictEqual(casted.archetype, 'scientific_particle_lab');
        assert.ok(
            casted.landmarkName.includes('CERN') ||
            casted.landmarkName.includes('Fermilab') ||
            casted.landmarkName.includes('Accelerator'),
            `Landmark should be a particle physics institute, got: ${casted.landmarkName}`
        );
        console.log(`  ✓ Case 4 Passed: "${prompt}" -> ${casted.landmarkName} (${casted.archetype})`);
    }

    // ========================================================================
    // TEST 5: Explicit Real-World Landmark Prompt Preservation
    // ========================================================================
    console.log('  Testing Case 5: Explicit landmark "Golden Gate Bridge"...');
    {
        const prompt = 'Golden Gate Bridge with morning maritime fog';
        const casted = castCreativeLocation(prompt);

        assert.strictEqual(casted.archetype, 'explicit_landmark');
        assert.ok(casted.landmarkName.includes('Golden Gate Bridge'));
        assert.ok(Math.abs(casted.lat - 37.8199) < 0.1, 'Latitude matches Golden Gate Bridge');
        assert.ok(Math.abs(casted.lng - (-122.4783)) < 0.1, 'Longitude matches Golden Gate Bridge');
        console.log(`  ✓ Case 5 Passed: "${prompt}" preserved explicit landmark anchor.`);
    }

    // ========================================================================
    // TEST 6: End-to-End Synthesizer Integration & C++20 Directive Compliance
    // ========================================================================
    console.log('  Testing Case 6: synthesizeContextual3DScene does not cast unlocated prompts...');
    {
        // Prompts that name no real-world location stay in the grey clay void (AGENTS.md):
        // the synthesizer never casts them onto an unrelated Earth location.
        for (const prompt of ['bullet going through glass', 'black background product pedestal with soft spotlight']) {
            const scene = synthesizeContextual3DScene(prompt);
            assert.strictEqual(scene.geoAnchor, undefined, `"${prompt}" names no place and must not be geo-anchored`);
            assert.ok(
                scene.pythonGenerator?.sourceCode || scene.cppGenerator?.sourceCode,
                `"${prompt}" must still carry a procedural generator`
            );
        }

        console.log('  ✓ Case 6 Passed: synthesizeContextual3DScene leaves unlocated prompts unanchored with a procedural generator.');
    }

    // ========================================================================
    // TEST 7: Multi-modal Context Grounding (Doc Title & Content Influence)
    // ========================================================================
    console.log('  Testing Case 7: Document context grounding for abstract scene prompts...');
    {
        const prompt = 'abstract interactive sculpture';
        // When document title indicates space exploration & cosmic orbit
        const casted = castCreativeLocation(prompt, {
            docTitle: 'Apollo Missions to Lunar Orbit',
            docContent: 'Detailed orbital mechanics and telescope observations.'
        });

        assert.strictEqual(casted.archetype, 'astronomical_cosmic');
        assert.ok(
            casted.landmarkName.includes('Mauna Kea') ||
            casted.landmarkName.includes('ALMA') ||
            casted.landmarkName.includes('Observatories')
        );
        console.log(`  ✓ Case 7 Passed: Document context steered abstract prompt to ${casted.landmarkName} (${casted.archetype}).`);
    }

    console.log('\n🎉 ALL 7 CREATIVE LOCATION CASTING TESTS PASSED SUCCESSFULLY!\n');
}

test('creative-location-casting.test', async () => {
    await runCreativeLocationCastingTests();
}, 60_000);
