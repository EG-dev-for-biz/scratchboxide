/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { test } from 'vitest';
import * as assert from 'assert';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs-extra';
import {
    buildOmniVideoRestylePrompt,
    buildDualConditionedOmniVideoRequest,
    buildMinimalOmniVideoPrompt,
    buildSimplifiedOmniPrompt,
    buildGeospatialOmniPipelinePlan,
    buildBlockoutOmniPipelinePlan,
    buildBlockoutNanoBananaPrompt,
    HIGH_QUALITY_TILE_STREAMING_CONFIG,
    getOmniStylePreset,
    listOmniStylePresets,
    OmniVideoPromptContext
} from '../src/browser/generative-canvas/services/video/omniVideoPromptService';
import {
    CAPTURE_HIGH_ERROR_TARGET,
    TILE_DRAIN_MAX_FRAMES
} from '../src/browser/generative-canvas/services/location-beautify-service';
import { GoogleMediaGenerationService } from '../src/node/google-media-generation-service';
import { MediaAssetStore } from '../src/node/media-asset-store';
import { MediaAssetRef } from '../src/common/media-generation-protocol';

async function runOmniVideoPromptPipelineTests() {
    console.log('🧪 Running Omni 1.1 Video Restyle & Dual-Conditioning Prompt Pipeline Tests...\n');

    // --------------------------------------------------------------------------
    // Test 1: Style Presets Catalog Verification
    // --------------------------------------------------------------------------
    console.log('  Testing Omni Style Presets Catalog...');
    const presets = listOmniStylePresets();
    assert.strictEqual(presets.length, 6, 'Must provide 6 style presets (5 foundational + neutral performer portrait)');

    const urbanPreset = getOmniStylePreset('photoreal-urban');
    assert.strictEqual(urbanPreset.id, 'photoreal-urban');
    assert.ok(urbanPreset.name.includes('Preset 1: Photorealistic Urban Flight'));
    assert.ok(urbanPreset.materials.includes('Authentic architectural surface finishes'));
    assert.ok(!urbanPreset.materials.includes('Indiana limestone'), 'Must NOT contain hardcoded Indiana limestone');
    assert.ok(!urbanPreset.materials.includes('reflective glass curtain walls'), 'Must NOT contain hardcoded reflective glass curtain walls');
    assert.ok(!urbanPreset.materials.includes('asphalt crosswalk markings'), 'Must NOT contain hardcoded asphalt crosswalk markings');
    assert.ok(urbanPreset.cameraDetails.includes('35mm anamorphic prime lens'));
    assert.ok(urbanPreset.negativePrompt.includes('CGI look'));

    const neutralPreset = getOmniStylePreset('neutral-portrait-a-frame');
    assert.strictEqual(neutralPreset.id, 'neutral-portrait-a-frame');
    assert.ok(neutralPreset.name.includes('Preset 6: Neutral Performer Studio Portrait'));
    assert.ok(neutralPreset.defaultLighting.includes('flat, diffuse, shadowless studio illumination'));
    assert.ok(neutralPreset.cameraDetails.includes('Full-body eye-level uncropped portrait lens framing from head to toe'));
    assert.ok(neutralPreset.negativePrompt.includes('dramatic lighting'));
    console.log('  ✓ Test 1 Passed: Omni style presets verified');

    // --------------------------------------------------------------------------
    // Test 2: Preset 1 - Photorealistic Urban Flight (Single-Video Mode)
    // --------------------------------------------------------------------------
    console.log('  Testing Preset 1 in Single-Video Mode (<VIDEO_REF_0> only)...');
    const singleVideoContext: OmniVideoPromptContext = {
        stylePreset: 'photoreal-urban',
        primarySubject: 'Manhattan skyscraper canyon along 5th Avenue and 34th Street',
        coordinates: { lat: 40.748817, lng: -73.985428 },
        useStartFrame: false,
        blockoutVideoRef: '<VIDEO_REF_0>'
    };

    const singlePrompt = buildOmniVideoRestylePrompt(singleVideoContext);
    assert.ok(singlePrompt.includes('A photorealistic, hyper-detailed cinematic aerial flyover shot of Manhattan skyscraper canyon along 5th Avenue and 34th Street'));
    assert.ok(singlePrompt.includes('coordinates: 40.748817, -73.985428'));
    assert.ok(singlePrompt.includes('Materials & Textures: Authentic architectural surface finishes'));
    // Crucial check: Ensure we scratched hardcoded material catalogs from prompts
    assert.ok(!singlePrompt.includes('Indiana limestone'), 'Prompt must NOT contain Indiana limestone');
    assert.ok(!singlePrompt.includes('reflective glass curtain walls'), 'Prompt must NOT contain reflective glass curtain walls');
    assert.ok(!singlePrompt.includes('asphalt crosswalk markings'), 'Prompt must NOT contain asphalt crosswalk markings');
    assert.ok(singlePrompt.includes('Lighting & Atmosphere: Late afternoon golden hour'));
    assert.ok(singlePrompt.includes('Camera Details: Shot on 35mm anamorphic prime lens'));
    assert.ok(singlePrompt.includes('Follow the structure, depth, and spatial geometry of <VIDEO_REF_0>.'));
    // Ensure it does NOT reference <IMAGE_REF_0> when start frame is disabled
    assert.ok(!singlePrompt.includes('<IMAGE_REF_0>'));
    console.log('  ✓ Test 2 Passed: Single-video mode correctly maps textures onto <VIDEO_REF_0>');

    // --------------------------------------------------------------------------
    // Test 3: Preset 1 - Dual-Conditioned Mode (<IMAGE_REF_0> + <VIDEO_REF_0>)
    // --------------------------------------------------------------------------
    console.log('  Testing Preset 1 in Dual-Conditioned Mode (<IMAGE_REF_0> + <VIDEO_REF_0>)...');
    const dualConditionedContext: OmniVideoPromptContext = {
        stylePreset: 'photoreal-urban',
        primarySubject: 'Midtown Manhattan skyline and Empire State Building',
        coordinates: { lat: 40.7484, lng: -73.9857 },
        useStartFrame: true,
        startFrameRef: '<IMAGE_REF_0>',
        blockoutVideoRef: '<VIDEO_REF_0>',
        solarEphemeris: {
            elevationDeg: 18.2,
            azimuthDeg: 242.5,
            colorTempK: 2800
        },
        weather: {
            condition: 'recent rain shower',
            fogDensity: 0.12,
            surfaceWetness: 0.85
        },
        pbrMaterials: [
            'Polished Black Granite Base',
            'Fluted Cast Aluminum Mullions',
            'Rain-Slick Bituminous Asphalt'
        ]
    };

    const dualPrompt = buildOmniVideoRestylePrompt(dualConditionedContext);

    // Verify header & coordinates
    assert.ok(dualPrompt.includes('Midtown Manhattan skyline and Empire State Building (coordinates: 40.748400, -73.985700)'));

    // Verify dual conditioning bindings
    assert.ok(dualPrompt.includes('Visual Identity & Materials: Strictly preserve and propagate the exact architectural detailing, surface finishes, material reflectivity, and color science established in <IMAGE_REF_0>.'));
    assert.ok(dualPrompt.includes('Lighting & Atmosphere: Maintain the lighting vector, shadow contrast, color temperature, and atmospheric mood established in <IMAGE_REF_0>.'));

    // Verify PBR materials injection
    assert.ok(dualPrompt.includes('Featuring physical PBR materials: Polished Black Granite Base, Fluted Cast Aluminum Mullions, Rain-Slick Bituminous Asphalt'));

    // Verify calculated solar ephemeris and weather physics
    assert.ok(dualPrompt.includes('18.2° elevation and 242.5° azimuth'));
    assert.ok(dualPrompt.includes('blackbody color temperature 2800K'));
    assert.ok(dualPrompt.includes('under recent rain shower atmospheric conditions'));
    assert.ok(dualPrompt.includes('12% volumetric atmospheric fog'));
    assert.ok(dualPrompt.includes('85% road/surface wetness reflections'));

    // Verify motion propagation binding
    assert.ok(dualPrompt.includes('Motion & Spatial Guidance: Follow the 6-DoF camera trajectory, depth parallax, vanishing points, and geometric boundaries of <VIDEO_REF_0>.'));
    assert.ok(dualPrompt.includes('Smoothly propagate the visual identity and surface textures of <IMAGE_REF_0> across the entire camera move without morphing, warping, or style drift.'));
    assert.ok(dualPrompt.includes('A single continuous uninterrupted camera take from start to finish. Strictly seamless camera movement with zero scene transitions, no camera switching, and no montage edits.'));
    assert.ok(dualPrompt.includes('Strictly adhere to the exact 3-second timing, pace, and continuous camera kinematics of <VIDEO_REF_0>.'));

    // Verify that preset material catalogues are NOT injected into dual prompt
    assert.ok(!dualPrompt.includes('Indiana limestone'), 'Dual prompt must NOT contain preset Indiana limestone');
    assert.ok(!dualPrompt.includes('reflective glass curtain walls'), 'Dual prompt must NOT contain reflective glass curtain walls');
    assert.ok(!dualPrompt.includes('asphalt crosswalk markings'), 'Dual prompt must NOT contain asphalt crosswalk markings');

    console.log('  ✓ Test 3 Passed: Dual-conditioned mode perfectly binds <IMAGE_REF_0> identity with <VIDEO_REF_0> spatial motion');

    // --------------------------------------------------------------------------
    // Test 4: Request Assembly & Google Media Service Dispatch
    // --------------------------------------------------------------------------
    console.log('  Testing VideoGenerationRequest Payload Assembly & Dispatch...');
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'scratchbox-omni-test-'));

    try {
        const assetStore = new MediaAssetStore();
        const startImageAsset = await assetStore.put(workspaceRoot, Buffer.from('fake-png-start-frame'), 'image/png');
        const blockoutVideoAsset = await assetStore.put(workspaceRoot, Buffer.from('fake-mp4-blockout-video'), 'video/mp4');

        const request = buildDualConditionedOmniVideoRequest({
            context: dualConditionedContext,
            workspaceRoot,
            idempotencyKey: 'test-manhattan-flight-01',
            startImageAsset,
            blockoutVideoAsset,
            durationSeconds: 6,
            aspectRatio: '16:9',
            resolution: '1080p'
        });

        assert.strictEqual(request.kind, 'video');
        assert.strictEqual(request.idempotencyKey, 'test-manhattan-flight-01');
        assert.strictEqual(request.durationSeconds, 6);
        assert.strictEqual(request.aspectRatio, '16:9');
        assert.strictEqual(request.resolution, '1080p');
        assert.strictEqual(request.sourceAsset?.uri, startImageAsset.uri);
        assert.strictEqual(request.referenceAssets?.[0]?.uri, blockoutVideoAsset.uri);
        assert.strictEqual(request.modelPriority?.[0], 'google/omni-1.1');
        assert.ok(request.negativePrompt?.includes('CGI look'));

        // Mock GoogleMediaGenerationService execution
        const recordedCalls: { model: string; prompt: string; image?: any }[] = [];
        const fakeClient: any = {
            models: {
                get: async ({ model }: { model: string }) => ({
                    name: model,
                    supportedActions: ['generateVideos', 'predictLongRunning']
                }),
                generateVideos: async (args: any) => {
                    recordedCalls.push(args);
                    return {
                        name: `operations/${args.model}`,
                        done: false
                    };
                }
            },
            operations: {
                getVideosOperation: async ({ operation }: any) => ({
                    ...operation,
                    done: true,
                    response: {
                        generatedVideos: [{
                            video: {
                                videoBytes: Buffer.from('generated-photoreal-manhattan-mp4').toString('base64'),
                                mimeType: 'video/mp4'
                            }
                        }]
                    }
                })
            }
        };

        const service = new GoogleMediaGenerationService(
            assetStore,
            async () => fakeClient,
            { pollIntervalMs: 1, maxPollAttempts: 3 }
        );

        const result = await service.generateVideo(request);

        assert.strictEqual(result.modelUsed, 'google/omni-1.1', 'Omni 1.1 must be selected as the #1 priority route');
        assert.strictEqual(result.operationName, 'operations/google/omni-1.1');
        assert.strictEqual(recordedCalls.length, 1);
        assert.strictEqual(recordedCalls[0].model, 'google/omni-1.1');
        assert.ok(recordedCalls[0].prompt.includes('Midtown Manhattan skyline'));
        assert.ok(recordedCalls[0].prompt.includes('Visual Identity & Materials: Strictly preserve and propagate'));
        assert.ok(recordedCalls[0].prompt.includes('Motion & Spatial Guidance: Follow the 6-DoF camera trajectory'));
        assert.ok(recordedCalls[0].image, 'Start frame image must be passed as conditioning input');
        assert.strictEqual(recordedCalls[0].image.mimeType, 'image/png');
        assert.strictEqual(
            recordedCalls[0].image.imageBytes,
            Buffer.from('fake-png-start-frame').toString('base64'),
            'Start frame bytes must match input asset'
        );

        // Verify generated video asset saved to workspace
        const outputPath = path.join(workspaceRoot, result.asset.relativePath);
        assert.ok(await fs.pathExists(outputPath), 'Generated video asset must be written to disk');
        const outputBytes = await fs.readFile(outputPath);
        assert.strictEqual(outputBytes.toString(), 'generated-photoreal-manhattan-mp4');

        console.log('  ✓ Test 4 Passed: End-to-end Omni 1.1 dual-conditioned video generation successfully dispatched and resolved');
    } finally {
        await fs.remove(workspaceRoot);
    }

    // --------------------------------------------------------------------------
    // Test 5: Strict 3-Stage Ordered Pipeline Verification
    // Order:
    // 1. Stream in 3D tiles (CAPTURE_HIGH_ERROR_TARGET = 0.5, TILE_DRAIN_MAX_FRAMES = 120)
    // 2. Restyle that perspective with standard Nano Banana prompt design (no hardcoded materials) -> <IMAGE_REF_0>
    // 3. Give Omni minimal direction: "Follow the structure, depth, and spatial geometry of <VIDEO_REF_0>."
    // --------------------------------------------------------------------------
    console.log('  Testing Strict 3-Stage Ordered Pipeline (Tiles -> Nano Banana Start Frame -> Minimal Omni)...');

    const fakeStartAsset: MediaAssetRef = {
        uri: 'sb-asset://media/nano_banana_still.png',
        contentHash: 'hash-nano-banana-001',
        mimeType: 'image/png',
        byteLength: 4096,
        relativePath: '.scratchbox/media/hash-nano-banana-001.png'
    };

    const fakeBlockoutAsset: MediaAssetRef = {
        uri: 'sb-asset://media/threejs_blockout.mp4',
        contentHash: 'hash-blockout-002',
        mimeType: 'video/mp4',
        byteLength: 20480,
        relativePath: '.scratchbox/media/hash-blockout-002.mp4'
    };

    const pipelinePlan = buildGeospatialOmniPipelinePlan({
        locationName: 'Manhattan Skyscraper Canyon along 5th Avenue and 34th Street',
        coordinates: { lat: 40.748817, lng: -73.985428 },
        heading: 0,
        altitudeM: 250,
        aspectRatio: '16:9',
        stylePreset: 'cinematic-film',
        mood: 'golden-hour',
        workspaceRoot: '/tmp/scratchbox-workspace',
        idempotencyKey: 'pipeline-run-001',
        startImageAsset: fakeStartAsset,
        blockoutVideoAsset: fakeBlockoutAsset
    });

    // Stage 1 Verification: Tile Streamer Error Target & Queue Drain
    assert.strictEqual(pipelinePlan.stage1TileStream.streamingConfig.errorTarget, 0.5);
    assert.strictEqual(pipelinePlan.stage1TileStream.streamingConfig.drainMaxFrames, 120);
    assert.strictEqual(pipelinePlan.stage1TileStream.coordinates.lat, 40.748817);
    assert.strictEqual(pipelinePlan.stage1TileStream.coordinates.lng, -73.985428);
    assert.strictEqual(pipelinePlan.stage1TileStream.heading, 0);

    // Stage 2 Verification: Standard Nano Banana Prompt Design
    const nbPrompt = pipelinePlan.stage2NanoBananaPrompt;
    assert.ok(nbPrompt.includes('Transform this photorealistic 3D tiles rendering of Manhattan Skyscraper Canyon along 5th Avenue and 34th Street'));
    assert.ok(nbPrompt.includes('camera at coordinates 40.748817, -73.985428, facing 0°'));
    assert.ok(nbPrompt.includes('Map reference: https://earth.google.com/web/@40.748817,-73.985428'));
    assert.ok(nbPrompt.includes('CRITICAL FRAMING RULES — non-negotiable:'));
    assert.ok(nbPrompt.includes('(1) Output MUST use exactly 16:9 aspect ratio, matching the reference image canvas.'));
    assert.ok(nbPrompt.includes('(2) Preserve the EXACT same camera angle, pitch, yaw, viewpoint, composition, focal length, and field of view as the reference.'));
    assert.ok(nbPrompt.includes('(3) Every building, street, and rooftop must stay in the same on-image position — do not pan, zoom, crop, recompose, or change the horizon line.'));
    assert.ok(nbPrompt.includes('(4) Do not invent or add buildings, landmarks, or features that are not visible in the reference.'));
    assert.ok(nbPrompt.includes('No map insets, compass overlays, mini-maps, navigation UI, coordinate labels, or any graphical overlays — clean photograph only.'));

    // Crucial check: Ensure we do NOT inject hardcoded material lists in the prompt
    assert.ok(!nbPrompt.includes('Indiana limestone masonry seams'), 'Must NOT inject hardcoded Indiana limestone masonry seams');
    assert.ok(!nbPrompt.includes('Art Deco stainless steel mullions'), 'Must NOT inject hardcoded Art Deco stainless steel mullions');

    // Stage 3 Verification: Minimal Omni Direction
    const omniReq = pipelinePlan.stage3OmniVideoRequest;
    assert.strictEqual(omniReq.sourceAsset?.uri, fakeStartAsset.uri, 'Omni must use the Nano Banana output as start frame <IMAGE_REF_0>');
    assert.strictEqual(omniReq.referenceAssets?.[0]?.uri, fakeBlockoutAsset.uri, 'Omni must use the 3D blockout as <VIDEO_REF_0>');
    assert.ok(omniReq.prompt.includes('Follow the structure, depth, and spatial geometry of <VIDEO_REF_0>.'));
    // Ensure Omni prompt is minimal and free of verbose material essays
    assert.ok(!omniReq.prompt.includes('Indiana limestone masonry seams'));
    assert.ok(!omniReq.prompt.includes('Art Deco stainless steel mullions'));
    assert.ok(!omniReq.prompt.includes('weathered terracotta'));

    console.log('  ✓ Test 5 Passed: 3-stage ordered pipeline fully verified with zero material hardcoding and minimal Omni direction');

    // --------------------------------------------------------------------------
    // --------------------------------------------------------------------------
    // Test 6: Blockout Dual-Conditioning Pipeline (<IMAGE_REF_0> + <VIDEO_REF_0> -> "Polished Omni Render")
    // Verification that:
    // 1. Frame 1 of blockout video is extracted at the start of the pipeline
    // 2. Frame 1 is restyled with Nano Banana into a photorealistic image using strict framing rules -> <IMAGE_REF_0>
    // 3. Blockout video is set as <VIDEO_REF_0>
    // 4. Both <IMAGE_REF_0> and <VIDEO_REF_0> are fed into Omni (sourceAsset + referenceAssets)
    // 5. Returned video is designated as "Polished Omni Render"
    // --------------------------------------------------------------------------
    console.log('--- Test 6: Blockout Dual-Conditioning Pipeline (Nano Banana Restyled <IMAGE_REF_0> + <VIDEO_REF_0> -> "Polished Omni Render") ---');
    const fakeBlockoutFrame1Asset: MediaAssetRef = {
        id: 'asset-blockout-frame-1',
        uri: 'file:///workspace/public/models/blockout_first_frame.jpg',
        mimeType: 'image/jpeg',
        kind: 'image',
        contentHash: 'hash-blockout-frame-1',
        byteLength: 4096,
        relativePath: '.scratchbox/media/blockout_first_frame.jpg',
        createdAt: Date.now()
    };
    const fakeRestyledImageAsset: MediaAssetRef = {
        id: 'asset-restyled-frame-1',
        uri: 'file:///workspace/public/images/start_frame_01_omni.png',
        mimeType: 'image/png',
        kind: 'image',
        contentHash: 'hash-restyled-frame-1',
        byteLength: 8192,
        relativePath: '.scratchbox/media/start_frame_01_omni.png',
        createdAt: Date.now()
    };
    const fakeBlockoutVideoAsset: MediaAssetRef = {
        id: 'asset-blockout-video',
        uri: 'file:///workspace/public/videos/google_tiles_clay_blockout_camera.mp4',
        mimeType: 'video/mp4',
        kind: 'video',
        contentHash: 'hash-blockout-vid-002',
        byteLength: 20480,
        relativePath: '.scratchbox/media/google_tiles_clay_blockout_camera.mp4',
        createdAt: Date.now()
    };

    const blockoutPlan = buildBlockoutOmniPipelinePlan({
        locationName: 'Manhattan 5th Avenue Skyscraper Canyon',
        coordinates: { lat: 40.748817, lng: -73.985428 },
        heading: 0,
        workspaceRoot: '/tmp/scratchbox-workspace',
        idempotencyKey: 'blockout-run-001',
        blockoutFrame1Asset: fakeBlockoutFrame1Asset,
        restyledImageAsset: fakeRestyledImageAsset,
        blockoutVideoAsset: fakeBlockoutVideoAsset,
        stylePreset: 'photoreal-urban'
    });

    // Verification 1: Stage 1 extracts Frame 1 from 3D blockout
    assert.strictEqual(blockoutPlan.stage1BlockoutFrameExtraction.rawFrame1Asset?.uri, fakeBlockoutFrame1Asset.uri);

    // Verification 2: Stage 2 restyles Frame 1 with Nano Banana using strict framing prompt
    const blockoutNbPrompt = blockoutPlan.nanoBananaPrompt;
    assert.ok(blockoutNbPrompt.includes('Transform this photorealistic 3D tiles rendering of Manhattan 5th Avenue Skyscraper Canyon (camera at coordinates 40.748817, -73.985428, facing 0°) into a photorealistic photograph.'));
    assert.ok(blockoutNbPrompt.includes('Map reference: https://earth.google.com/web/@40.748817,-73.985428'));
    assert.ok(blockoutNbPrompt.includes('This is a real location — the reference image shows the actual 3D-rendered buildings, streets, and terrain at these exact coordinates.'));
    assert.ok(blockoutNbPrompt.includes('CRITICAL FRAMING RULES — non-negotiable:'));
    assert.ok(blockoutNbPrompt.includes('(1) Output MUST use exactly 16:9 aspect ratio, matching the reference image canvas.'));
    assert.ok(blockoutNbPrompt.includes('(2) Preserve the EXACT same camera angle, pitch, yaw, viewpoint, composition, focal length, and field of view as the reference.'));
    assert.ok(blockoutNbPrompt.includes('(3) Every building, street, and rooftop must stay in the same on-image position — do not pan, zoom, crop, recompose, or change the horizon line.'));
    assert.ok(blockoutNbPrompt.includes('(4) Do not invent or add buildings, landmarks, or features that are not visible in the reference. Add realistic textures, materials, atmospheric haze, natural lighting, and fine architectural detail to make this look like a real photograph taken from this exact vantage point.'));

    // Verification 3: Stage 2 designates output as <IMAGE_REF_0>
    assert.strictEqual(blockoutPlan.imageRef, '<IMAGE_REF_0>');
    assert.strictEqual(blockoutPlan.stage2NanoBananaRestyle.imageRef, '<IMAGE_REF_0>');
    assert.strictEqual(blockoutPlan.omniVideoRequest.sourceAsset?.uri, fakeRestyledImageAsset.uri);

    // Verification 4: Stage 3 designates blockout video as <VIDEO_REF_0>
    assert.strictEqual(blockoutPlan.videoRef, '<VIDEO_REF_0>');
    assert.strictEqual(blockoutPlan.omniVideoRequest.referenceAssets?.[0]?.uri, fakeBlockoutVideoAsset.uri);

    // Verification 5: Dual-conditioned prompt feeds both <IMAGE_REF_0> and <VIDEO_REF_0> into Omni
    const blockoutPrompt = blockoutPlan.omniVideoRequest.prompt;
    assert.ok(blockoutPrompt.includes('<IMAGE_REF_0>'), 'Prompt must reference restyled photorealistic image <IMAGE_REF_0>');
    assert.ok(blockoutPrompt.includes('<VIDEO_REF_0>'), 'Prompt must reference Blockout video <VIDEO_REF_0>');
    assert.ok(blockoutPrompt.includes('Follow the 6-DoF camera trajectory, depth parallax, vanishing points, and geometric boundaries of <VIDEO_REF_0>.'));
    assert.ok(blockoutPrompt.includes('Smoothly propagate the visual identity and surface textures of <IMAGE_REF_0> across the entire camera move'));

    // Verification 6: Returned video is designated as "Polished Omni Render"
    assert.strictEqual(blockoutPlan.outputVideoTitle, 'Polished Omni Render');
    assert.strictEqual(blockoutPlan.stage3DualOmniGeneration.outputVideoTitle, 'Polished Omni Render');

    console.log('  ✓ Test 6 Passed: Frame 1 restyled with Nano Banana into <IMAGE_REF_0>, blockout video as <VIDEO_REF_0>, both fed into Omni, output designated "Polished Omni Render"');

    // --------------------------------------------------------------------------
    // Test 7: Simplified Zero-Hallucination Omni Prompt (User Directive)
    // --------------------------------------------------------------------------
    console.log('\nStarting Test 7: Simplified Zero-Hallucination Omni Prompt...');

    const expectedSimplifiedPrompt = [
        'Motion & Spatial Guidance: Follow the EXACT 6-DoF camera trajectory, depth parallax, vanishing points, and geometric boundaries of the provided blockout video (<VIDEO_REF_0>). Smoothly propagate the visual identity and surface textures of the start frame image (<IMAGE_REF_0>) across the entire camera move without morphing, warping, or style drift.',
        'Shot Continuity & Timing: A single continuous uninterrupted camera take from start to finish. Strictly seamless camera movement with zero scene transitions, no camera switching, and no montage edits. Strictly follow the continuous flight trajectory and exact 3.0-second timing and pace of the provided blockout video (<VIDEO_REF_0>) without any interruption.'
    ].join('\n\n');

    // Test direct generator function
    const directPrompt = buildSimplifiedOmniPrompt();
    assert.strictEqual(directPrompt, expectedSimplifiedPrompt, 'Direct buildSimplifiedOmniPrompt must match exact 2-paragraph string');

    // Test with custom options
    const customPrompt = buildSimplifiedOmniPrompt({
        blockoutVideoRef: '<VIDEO_REF_1>',
        startFrameRef: '<IMAGE_REF_2>',
        durationSeconds: 4.5
    });
    assert.ok(customPrompt.includes('<VIDEO_REF_1>'));
    assert.ok(customPrompt.includes('<IMAGE_REF_2>'));
    assert.ok(customPrompt.includes('exact 4.5-second timing'));

    // Test through buildOmniVideoRestylePrompt with simplifiedPrompt: true flag
    const simplifiedContextPrompt = buildOmniVideoRestylePrompt({
        ...dualConditionedContext,
        simplifiedPrompt: true
    });
    assert.strictEqual(simplifiedContextPrompt, expectedSimplifiedPrompt, 'buildOmniVideoRestylePrompt with simplifiedPrompt: true must match exact simplified prompt');

    // Verify zero hallucinations: must NOT contain lens specs, solar ephemeris, or material overrides
    assert.ok(!simplifiedContextPrompt.includes('35mm'), 'Simplified prompt must NOT contain 35mm lens');
    assert.ok(!simplifiedContextPrompt.includes('Granite'), 'Simplified prompt must NOT contain Granite');
    assert.ok(!simplifiedContextPrompt.includes('Mullions'), 'Simplified prompt must NOT contain Mullions');
    assert.ok(!simplifiedContextPrompt.includes('solar'), 'Simplified prompt must NOT contain solar angle text');
    assert.ok(!simplifiedContextPrompt.includes('4K Ultra High Definition'), 'Simplified prompt must NOT contain 4K text');

    console.log('  ✓ Test 7 Passed: Simplified Omni prompt strictly enforces 6-DoF trajectory and shot continuity with zero hallucinated materials');

    console.log('\n🎉 ALL OMNI 1.1 PROMPT PIPELINE & 3-STAGE PIPELINE TESTS PASSED SUCCESSFULLY!\n');
}

export { runOmniVideoPromptPipelineTests };

test('omni-video-prompt-pipeline.test', async () => {
    await runOmniVideoPromptPipelineTests();
}, 180_000);
