/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { test } from 'vitest';
import * as assert from 'assert';
import {
    buildBeautifyPrompt,
    buildDoubleBracketFramingSuffix,
    buildHybridBeautifyPrompt,
    buildHybridPrompt,
    buildHybridPromptPayload,
    type BuildHybridPromptOptions,
    type HybridPromptPayload
} from '../src/browser/generative-canvas/services/location-beautify-service';
import {
    buildHybridOmniVideoPayload,
    compileHybridOmniVideoPrompt,
    type BuildHybridOmniVideoOptions,
    type HybridOmniVideoPayload
} from '../src/browser/generative-canvas/services/video/omniVideoPromptService';

async function runHybridPromptingArchitectureTests() {
    console.log('🧪 Running Hybrid Prompting Architecture Test Suite...\n');

    // --------------------------------------------------------------------------
    // Test 1: Location Beautify - Hybrid Prompt Payload Contract & Schema
    // --------------------------------------------------------------------------
    console.log('  Testing Location Beautify Hybrid Payload Construction...');

    const sampleOptions: BuildHybridPromptOptions = {
        locationName: 'Grand Army Plaza and The Plaza Hotel',
        coordinates: { lat: 40.7645, lng: -73.9744, altitudeM: 85 },
        heading: 225,
        pitch: -20,
        standoffDistanceM: 180,
        aspectRatio: '16:9',
        foregroundInvariant: 'French Renaissance mansard dormer roof occluding left 35% of frame.',
        primaryLandmarkInvariant: 'The Plaza Hotel limestone facade and Pulitzer Fountain court.',
        backgroundInvariant: 'Existing 6th Avenue and 58th Street silhouettes; no unverified high-rises.',
        atmosphereNarrative: 'Crisp early morning daylight, low 18° sun angle casting golden illumination across eastern facades.',
        styleSuffix: ' Authentic limestone patina, slate shingles, and oxidized green copper trim.'
    };

    const payload: HybridPromptPayload = buildHybridPromptPayload(sampleOptions);

    // Verify spatial_envelope_lock
    assert.ok(payload.spatial_envelope_lock, 'Payload must contain spatial_envelope_lock');
    assert.strictEqual(payload.spatial_envelope_lock.geodetic.latitude, 40.764500);
    assert.strictEqual(payload.spatial_envelope_lock.geodetic.longitude, -73.974400);
    assert.strictEqual(payload.spatial_envelope_lock.geodetic.altitudeMeters, 85);
    assert.strictEqual(payload.spatial_envelope_lock.cameraPose.headingDegrees, 225);
    assert.strictEqual(payload.spatial_envelope_lock.cameraPose.pitchDegrees, -20);
    assert.strictEqual(payload.spatial_envelope_lock.cameraPose.standoffDistanceMeters, 180);

    // Verify geometric invariants
    assert.strictEqual(payload.spatial_envelope_lock.geometricInvariants.foregroundStructure, sampleOptions.foregroundInvariant);
    assert.strictEqual(payload.spatial_envelope_lock.geometricInvariants.primaryLandmark, sampleOptions.primaryLandmarkInvariant);
    assert.strictEqual(payload.spatial_envelope_lock.geometricInvariants.backgroundSkyline, sampleOptions.backgroundInvariant);

    // Verify framing rules
    assert.ok(payload.spatial_envelope_lock.framingRules.length >= 4);
    assert.ok(payload.spatial_envelope_lock.framingRules.some(r => r.includes('canvas aspect ratio (16:9)')));
    assert.ok(payload.spatial_envelope_lock.framingRules.some(r => r.includes('Zero pan, zoom, crop')));

    // Verify rendering_instruction (verbatim de-noising narrative)
    assert.ok(payload.rendering_instruction.startsWith('Transform this photorealistic 3D tiles rendering of Grand Army Plaza and The Plaza Hotel'));
    assert.ok(payload.rendering_instruction.includes('camera at coordinates 40.764500, -73.974400, facing 225°'));
    assert.ok(payload.rendering_instruction.includes('CRITICAL FRAMING RULES — non-negotiable:'));
    assert.ok(payload.rendering_instruction.includes('Subject distance: approximately 180 meters from camera'));
    assert.ok(payload.rendering_instruction.includes('Authentic limestone patina, slate shingles, and oxidized green copper trim.'));

    // Verify generation parameters
    assert.strictEqual(payload.generation_parameters.aspect_ratio, '16:9');
    assert.deepStrictEqual(payload.generation_parameters.input_references, ['<IMAGE_REF_0>']);

    console.log('  ✓ Test 1 Passed: Hybrid payload adheres strictly to schema specifications');

    // --------------------------------------------------------------------------
    // Test 2: JSON Serialization & Parsing Round-Trip
    // --------------------------------------------------------------------------
    console.log('  Testing JSON Serialization & Parsing...');

    const jsonString = buildHybridBeautifyPrompt(sampleOptions);
    assert.doesNotThrow(() => {
        const parsed = JSON.parse(jsonString);
        assert.strictEqual(parsed.spatial_envelope_lock.cameraPose.headingDegrees, 225);
        assert.strictEqual(parsed.generation_parameters.aspect_ratio, '16:9');
    }, 'Serialized prompt must be valid, well-formed JSON');

    console.log('  ✓ Test 2 Passed: Serialized prompt parses cleanly');

    // --------------------------------------------------------------------------
    // Test 3: Backward Compatibility in buildBeautifyPrompt
    // --------------------------------------------------------------------------
    console.log('  Testing buildBeautifyPrompt format routing...');

    // 3.1 Default prose mode (must remain unchanged string)
    const proseResult = buildBeautifyPrompt({
        locationName: 'Colosseum, Rome',
        coords: '41.890200, 12.492200',
        heading: 90
    });
    assert.ok(!proseResult.startsWith('{'), 'Default call must return prose string, not JSON');
    assert.ok(proseResult.includes('Transform this photorealistic 3D tiles rendering of Colosseum, Rome'));

    // 3.2 format: 'hybrid' mode
    const hybridResult = buildBeautifyPrompt({
        locationName: 'Colosseum, Rome',
        coords: '41.890200, 12.492200',
        heading: 90,
        format: 'hybrid',
        foregroundInvariant: 'Outer elliptical travertine arcade intact.',
        primaryLandmarkInvariant: 'Flavian Amphitheatre arena floor and podium.'
    });
    assert.ok(hybridResult.startsWith('{'), 'format: hybrid must return valid JSON string');
    const parsedHybrid = JSON.parse(hybridResult);
    assert.strictEqual(parsedHybrid.spatial_envelope_lock.cameraPose.headingDegrees, 90);
    assert.strictEqual(parsedHybrid.spatial_envelope_lock.geometricInvariants.foregroundStructure, 'Outer elliptical travertine arcade intact.');

    console.log('  ✓ Test 3 Passed: buildBeautifyPrompt handles both prose and hybrid format requests');

    // --------------------------------------------------------------------------
    // Test 4: Omni 1.1 Video Restyle - Hybrid Video Flyover Payload
    // --------------------------------------------------------------------------
    console.log('  Testing Omni Video Flyover Hybrid Payload...');

    const videoOptions: BuildHybridOmniVideoOptions = {
        context: {
            stylePreset: 'photoreal-urban',
            primarySubject: 'Manhattan skyscraper canyon flyover',
            coordinates: { lat: 40.7488, lng: -73.9854 },
            useStartFrame: true,
            startFrameRef: '<IMAGE_REF_0>',
            blockoutVideoRef: '<VIDEO_REF_0>'
        },
        flightPathType: 'catmull_rom_spline',
        startPose: { headingDegrees: 210, pitchDegrees: -15, altitudeMeters: 120 },
        endPose: { headingDegrees: 235, pitchDegrees: -25, altitudeMeters: 90 },
        durationSeconds: 6,
        aspectRatio: '16:9',
        resolution: '4k'
    };

    const videoPayload: HybridOmniVideoPayload = buildHybridOmniVideoPayload(videoOptions);

    assert.ok(videoPayload.spatial_trajectory_lock);
    assert.strictEqual(videoPayload.spatial_trajectory_lock.flight_path_type, 'catmull_rom_spline');
    assert.strictEqual(videoPayload.spatial_trajectory_lock.start_pose.altitudeMeters, 120);
    assert.strictEqual(videoPayload.spatial_trajectory_lock.end_pose?.altitudeMeters, 90);
    assert.strictEqual(videoPayload.spatial_trajectory_lock.total_duration_seconds, 6);

    assert.ok(videoPayload.rendering_instruction.includes('cinematic aerial flyover shot of Manhattan skyscraper canyon'));
    assert.deepStrictEqual(videoPayload.generation_parameters.input_references, ['<IMAGE_REF_0>', '<VIDEO_REF_0>']);
    assert.strictEqual(videoPayload.generation_parameters.resolution, '4k');

    const videoJson = compileHybridOmniVideoPrompt(videoOptions);
    assert.doesNotThrow(() => JSON.parse(videoJson));

    console.log('  ✓ Test 4 Passed: Hybrid Omni Video flyover payload verified');

    // --------------------------------------------------------------------------
    // Test 5: Double-Bracket Framing Anchor & Viewport Crop Lock
    // --------------------------------------------------------------------------
    console.log('  Testing Double-Bracket Framing Anchor & Viewport Crop Lock...');

    const expectedSuffix = 'Style: CRITICAL FRAMING RULES: Output MUST use the 16:9 aspect ratio, matching the horizontal primary reference canvas, locked to @image1 viewport crop. (CRITICAL FRAMING RULES: Output MUST use the 16:9 aspect ratio, matching the horizontal primary reference canvas, locked to @image1 viewport crop.)';
    const computedSuffix = buildDoubleBracketFramingSuffix('16:9');
    assert.strictEqual(computedSuffix, expectedSuffix, 'buildDoubleBracketFramingSuffix must output exact verbatim double-bracket syntax');

    // Test prose format with viewportCropLock: true
    const prosePromptWithLock = buildBeautifyPrompt({
        locationName: '40.7712, -73.9726',
        coordinates: { lat: 40.771057, lng: -73.97252 },
        heading: 329,
        aspectRatio: '16:9',
        distance: 10,
        viewportCropLock: true
    });
    assert.ok(prosePromptWithLock.includes(expectedSuffix), 'Prose prompt with viewportCropLock must include double-bracket suffix');

    // Test hybrid format with viewportCropLock: true
    const hybridPayloadWithLock = buildHybridPromptPayload({
        ...sampleOptions,
        viewportCropLock: true
    });
    assert.ok(hybridPayloadWithLock.spatial_envelope_lock.viewport_crop_lock, 'Hybrid payload must include viewport_crop_lock in spatial_envelope_lock');
    assert.strictEqual(hybridPayloadWithLock.spatial_envelope_lock.viewport_crop_lock.reference_tensor, '@image1');
    assert.strictEqual(hybridPayloadWithLock.spatial_envelope_lock.viewport_crop_lock.enforcement_mode, 'double_bracket_tail_reinforcement');
    assert.ok(hybridPayloadWithLock.rendering_instruction.includes(expectedSuffix), 'Rendering instruction must contain double-bracket suffix');

    console.log('  ✓ Test 5 Passed: Double-bracket framing anchor & viewport crop lock verified');

    console.log('\n🎉 ALL HYBRID PROMPTING ARCHITECTURE TESTS PASSED SUCCESSFULLY!\n');
}

export { runHybridPromptingArchitectureTests };

test('hybrid-prompting-architecture.test', async () => {
    await runHybridPromptingArchitectureTests();
}, 60_000);
