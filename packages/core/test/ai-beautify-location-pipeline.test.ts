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
    extractLocationAndEraFromContext,
    buildLocationBeautifyPrompt,
    buildBeautifyPrompt,
    BeautifyPromptOptions,
    LocationBeautifyContext,
    CAPTURE_HIGH_ERROR_TARGET,
    TILE_DRAIN_MAX_FRAMES,
    beautifyLocationSection
} from '../src/browser/generative-canvas/services/location-beautify-service';
import { MarkdownSection } from '../src/browser/generative-canvas/canvas-types';

async function runAiBeautifyPipelineTests() {
    console.log('🧪 Running AI Beautify & 3D Tile Era Restyling Pipeline Test Suite...\n');

    // -------------------------------------------------------------
    // Test 1: Contextual Location & Historical Era Extraction
    // -------------------------------------------------------------
    console.log('  Testing Location & Historical Era Extraction from Document Prompts...');

    // 1.1 Historical 1776 Revolution Context
    const loc1776 = extractLocationAndEraFromContext('let\'s write a paper about 1776 and the Declaration of Independence');
    assert.strictEqual(loc1776.theme, '1776-revolution');
    assert.ok(loc1776.locationName.includes('Independence Hall') || loc1776.locationName.includes('Philadelphia'));
    assert.ok(Math.abs(loc1776.coordinates.lat - 39.9489) < 0.01, 'Latitude should match Philadelphia Independence Hall');
    assert.ok(Math.abs(loc1776.coordinates.lng - (-75.1500)) < 0.01, 'Longitude should match Philadelphia Independence Hall');
    assert.ok(loc1776.eraContext.toLowerCase().includes('1776') || loc1776.eraContext.toLowerCase().includes('colonial'), 'Era context must capture 1776/colonial');
    assert.ok(loc1776.eraContext.includes('no modern cars') || loc1776.eraContext.includes('no modern'), 'Must include negative constraints for modern objects');

    // 1.2 Ancient Rome / Colosseum Context
    const locRome = extractLocationAndEraFromContext('historical analysis of gladiator battles and architecture in the Roman Colosseum');
    assert.ok(locRome.locationName.includes('Colosseum') || locRome.locationName.includes('Rome'));
    assert.ok(Math.abs(locRome.coordinates.lat - 41.8902) < 0.01, 'Latitude should match Roman Colosseum');
    assert.ok(locRome.eraContext.toLowerCase().includes('roman') || locRome.eraContext.toLowerCase().includes('antiquity'));

    // 1.3 1920s Art Deco Manhattan Context
    const loc1920s = extractLocationAndEraFromContext('essay on 1920s Roaring Twenties architecture in Manhattan Chrysler building');
    assert.ok(loc1920s.locationName.includes('Chrysler') || loc1920s.locationName.includes('Manhattan'));
    assert.ok(Math.abs(loc1920s.coordinates.lat - 40.7516) < 0.01);
    assert.ok(loc1920s.eraContext.includes('1920s') || loc1920s.eraContext.includes('Art Deco'));

    // 1.4 Zero-Trust Security Datacenter Context
    const locSecurity = extractLocationAndEraFromContext('technical specification for zero-trust identity infrastructure and edge server corridors');
    assert.strictEqual(locSecurity.theme, 'auth-zerotrust-security');
    assert.ok(locSecurity.locationName.includes('Data Center') || locSecurity.locationName.includes('Corridor'));
    assert.ok(locSecurity.eraContext.toLowerCase().includes('modern') || locSecurity.eraContext.toLowerCase().includes('cloud') || locSecurity.eraContext.toLowerCase().includes('zero-trust'));

    console.log('  ✓ Test 1 Passed: Context-aware location coordinates and era styling successfully extracted');

    // -------------------------------------------------------------
    // Test 2: AI Beautify Prompt Construction with Non-Negotiable 3D Framing
    // -------------------------------------------------------------
    console.log('  Testing AI Beautify Prompt Generation & Strict 3D Framing Rules...');

    const sampleContext: LocationBeautifyContext = {
        locationName: 'Independence Hall (Pennsylvania State House), Philadelphia',
        coordinates: { lat: 39.9489, lng: -75.1500 },
        heading: 45,
        altitudeM: 250,
        aspectRatio: '16:9',
        eraContext: 'July 1776 American Revolutionary period, Georgian colonial red brick facade, cobblestone streets, horse-drawn carriages, gas lamps, no modern vehicles, wires, or antennas',
        stylePreset: 'oil-painting',
        mood: 'golden-hour',
        subjectDistance: 120
    };

    const beautifyPrompt = buildLocationBeautifyPrompt(sampleContext);
    assert.ok(beautifyPrompt.includes('39.948900, -75.150000'), 'Prompt must contain exact 6-decimal coordinates');
    assert.ok(beautifyPrompt.includes('facing 45°'), 'Prompt must contain camera heading azimuth');
    assert.ok(beautifyPrompt.includes('https://earth.google.com/web/@39.948900,-75.150000'), 'Prompt must include Google Earth reference link');
    assert.ok(beautifyPrompt.includes('CRITICAL FRAMING RULES'), 'Prompt must include strict 3D framing rules');
    assert.ok(beautifyPrompt.includes('Preserve the EXACT same camera angle, pitch, yaw, viewpoint'), 'Must forbid changing camera pitch/yaw');
    assert.ok(beautifyPrompt.includes('16:9 aspect ratio'), 'Must enforce canvas aspect ratio');
    assert.ok(beautifyPrompt.includes('July 1776 American Revolutionary period'), 'Must inject era context into prompt');
    assert.ok(beautifyPrompt.includes('masterpiece 18th-century classical oil painting') || beautifyPrompt.includes('oil-painting'), 'Must apply chosen artistic style');
    assert.ok(beautifyPrompt.includes('golden hour') || beautifyPrompt.includes('warm amber'), 'Must apply atmospheric lighting');
    assert.ok(beautifyPrompt.includes('No map insets, compass overlays, mini-maps, navigation UI'), 'Must forbid UI overlays');

    console.log('  ✓ Test 2 Passed: AI Beautify prompt perfectly enforces 3D tile geometry alignment and era styling');

    // -------------------------------------------------------------
    // Test 3: High-Quality 3D Tile Snapshot Engine Constants & Configuration
    // -------------------------------------------------------------
    console.log('  Testing High-Quality 3D Tile Snapshot Engine Configuration...');

    assert.ok(CAPTURE_HIGH_ERROR_TARGET <= 0.5, 'Error target must be <= 0.5 for High Quality tile level-of-detail');
    assert.ok(TILE_DRAIN_MAX_FRAMES >= 60, 'Drain frames must be >= 60 to ensure full tile resolution convergence');

    console.log('  ✓ Test 3 Passed: 3D Tile LOD error targets and queue drain limits verified for high-quality capture');

    // -------------------------------------------------------------
    // Test 4: Beautify Location Section Mutation & Metadata Enrichment
    // -------------------------------------------------------------
    console.log('  Testing beautifyLocationSection Document Mutation...');

    const originalSection: MarkdownSection = {
        id: 'sec-loc-1',
        type: 'location-image',
        locationName: 'Independence Hall (Pennsylvania State House), Philadelphia',
        coordinates: { lat: 39.9489, lng: -75.1500 },
        caption: 'The Assembly Room in Philadelphia in 1776.',
        imageUrl: 'https://images.unsplash.com/photo-1575881875475-31024b156660'
    };

    const restyledSection = beautifyLocationSection(originalSection, {
        styleId: 'cinematic-film',
        eraOverride: 'Winter 1776 blizzard, snow-covered colonial rooftops, night torchlight',
        docTitle: 'The Pivotal Year: 1776 and the Birth of a Nation'
    });

    assert.strictEqual(restyledSection.type, 'location-image');
    assert.ok(restyledSection.visualPrompt && restyledSection.visualPrompt.includes('Winter 1776 blizzard'));
    assert.ok(restyledSection.stylePreset && restyledSection.stylePreset.includes('Cinematic'));
    assert.ok(restyledSection.attribution && restyledSection.attribution.includes('Nano Banana Pro'));
    assert.ok(restyledSection.dateTag && restyledSection.dateTag.includes('1776'));

    console.log('  ✓ Test 4 Passed: beautifyLocationSection successfully transforms and stamps document location block');

    // -------------------------------------------------------------
    // Test 5: buildBeautifyPrompt Codebase API & Verbatim Template Conformance
    // -------------------------------------------------------------
    console.log('  Testing buildBeautifyPrompt Codebase API & Verbatim Template...');

    // 5.1 Full prompt with distance, mood, and styleSuffix
    const optionsWithDistance: BeautifyPromptOptions = {
        locationName: 'Independence Hall (Pennsylvania State House), Philadelphia',
        coords: '39.948900, -75.150000',
        heading: 45,
        earthUrl: 'https://earth.google.com/web/@39.948900,-75.150000',
        aspectRatio: '16:9',
        moodPromptContext: 'Golden hour warm sunlight casting long dramatic shadows across facade geometries. ',
        distance: 120,
        styleSuffix: ' Masterpiece 18th-century classical oil painting with fine architectural brushwork.'
    };

    const promptWithDist = buildBeautifyPrompt(optionsWithDistance);

    // Verify exact expected string verbatim
    const expectedPrompt = 'Transform this photorealistic 3D tiles rendering of Independence Hall (Pennsylvania State House), Philadelphia (camera at coordinates 39.948900, -75.150000, facing 45°) into a photorealistic photograph. Map reference: https://earth.google.com/web/@39.948900,-75.150000. Golden hour warm sunlight casting long dramatic shadows across facade geometries. This is a real location — the reference image shows the actual 3D-rendered buildings, streets, and terrain at these exact coordinates. CRITICAL FRAMING RULES — non-negotiable: (1) Output MUST use exactly 16:9 aspect ratio, matching the reference image canvas. (2) Preserve the EXACT same camera angle, pitch, yaw, viewpoint, composition, focal length, and field of view as the reference. (3) Every building, street, and rooftop must stay in the same on-image position — do not pan, zoom, crop, recompose, or change the horizon line. (4) Do not invent or add buildings, landmarks, or features that are not visible in the reference. Add realistic textures, materials, atmospheric haze, natural lighting, and fine architectural detail to make this look like a real photograph taken from this exact vantage point. Subject distance: approximately 120 meters from camera (use this for depth-of-field, focus, and aerial-perspective haze). Masterpiece 18th-century classical oil painting with fine architectural brushwork.';

    assert.strictEqual(promptWithDist, expectedPrompt, 'buildBeautifyPrompt must match the exact verbatim template string with distance and styleSuffix');

    // 5.2 Distance hint when distance is omitted (must be empty string)
    const optionsNoDistance: BeautifyPromptOptions = {
        locationName: 'Colosseum, Rome',
        coordinates: { lat: 41.8902, lng: 12.4922 },
        heading: 90,
        aspectRatio: '16:9',
        styleSuffix: ' Ancient Roman travertine stonework, deep cinematic lighting.'
    };

    const promptNoDist = buildBeautifyPrompt(optionsNoDistance);
    assert.strictEqual(promptNoDist.includes('Subject distance:'), false, 'When subject distance is omitted, subjectDistanceHint must be empty');
    assert.ok(promptNoDist.startsWith('Transform this photorealistic 3D tiles rendering of Colosseum, Rome (camera at coordinates 41.890200, 12.492200, facing 90°) into a photorealistic photograph.'));
    assert.ok(promptNoDist.includes('Map reference: https://earth.google.com/web/@41.890200,12.492200'));
    assert.ok(promptNoDist.includes('This is a real location — the reference image shows the actual 3D-rendered buildings'));
    assert.ok(promptNoDist.includes('CRITICAL FRAMING RULES — non-negotiable:'));
    assert.ok(promptNoDist.includes('(1) Output MUST use exactly 16:9 aspect ratio, matching the reference image canvas.'));
    assert.ok(promptNoDist.includes('(2) Preserve the EXACT same camera angle, pitch, yaw, viewpoint, composition, focal length, and field of view as the reference.'));
    assert.ok(promptNoDist.includes('(3) Every building, street, and rooftop must stay in the same on-image position — do not pan, zoom, crop, recompose, or change the horizon line.'));
    assert.ok(promptNoDist.includes('(4) Do not invent or add buildings, landmarks, or features that are not visible in the reference.'));
    assert.ok(promptNoDist.endsWith('Ancient Roman travertine stonework, deep cinematic lighting.'));

    // 5.3 Verify subjectDistance property alias
    const promptAlias = buildBeautifyPrompt({
        locationName: 'Chrysler Building, Manhattan',
        coords: { lat: 40.7516, lng: -73.9755 },
        subjectDistance: 250
    });
    assert.ok(promptAlias.includes('Subject distance: approximately 250 meters from camera (use this for depth-of-field, focus, and aerial-perspective haze).'), 'subjectDistance alias must populate subjectDistanceHint');

    console.log('  ✓ Test 5 Passed: buildBeautifyPrompt codebase API conforms 100% to verbatim template specification');

    console.log('\n🎉 ALL AI BEAUTIFY & 3D TILE ERA RESTYLING TESTS PASSED SUCCESSFULLY!\n');
}


export { runAiBeautifyPipelineTests };

test('ai-beautify-location-pipeline.test', async () => {
    await runAiBeautifyPipelineTests();
}, 180_000);
