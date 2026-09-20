/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import {
    VideoGenerationRequest,
    MediaAssetRef,
    VIDEO_MODEL_PRIORITY
} from '../../../../common/media-generation-protocol';
import {
    buildLocationBeautifyPrompt,
    buildBeautifyPrompt,
    buildHybridBeautifyPrompt,
    buildHybridPrompt,
    buildHybridPromptPayload,
    type BeautifyPromptOptions,
    type HybridPromptPayload,
    type SpatialEnvelopeLock,
    type CameraPoseLock,
    type GeometricInvariants,
    type BuildHybridPromptOptions,
    CAPTURE_HIGH_ERROR_TARGET,
    TILE_DRAIN_MAX_FRAMES,
    type LocationMood,
    type LocationBeautifyContext
} from '../location-beautify-service';

export {
    buildBeautifyPrompt,
    buildHybridBeautifyPrompt,
    buildHybridPrompt,
    buildHybridPromptPayload
};
export type {
    BeautifyPromptOptions,
    HybridPromptPayload,
    SpatialEnvelopeLock,
    CameraPoseLock,
    GeometricInvariants,
    BuildHybridPromptOptions
};

export type OmniStylePresetId =
    | 'photoreal-urban'
    | 'historical-colonial'
    | 'cyberpunk-scifi'
    | 'architectural-digest'
    | 'claymation-miniature';

export interface OmniStylePreset {
    id: OmniStylePresetId;
    name: string;
    description: string;
    headerStyle: string;
    materials: string;
    defaultLighting: string;
    cameraDetails: string;
    negativePrompt: string;
}

export const OMNI_STYLE_PRESETS: Record<OmniStylePresetId, OmniStylePreset> = {
    'photoreal-urban': {
        id: 'photoreal-urban',
        name: 'Preset 1: Photorealistic Urban Flight (Google 3D Tiles / Manhattan)',
        description: 'Cinematic aerial flyover of dense architectural metropolis with authentic stone masonry, glass reflectivity, and asphalt textures.',
        headerStyle: 'A photorealistic, hyper-detailed cinematic aerial flyover shot',
        materials: 'Authentic architectural surface finishes, physically grounded material reflectivity, and natural environmental weathering',
        defaultLighting: 'Late afternoon golden hour sunlight cutting between high-rise towers at a low 18° angle, deep street-canyon shadows, warm 2800K direct sunlight contrasting against cool 7000K skylight ambient fill, with light atmospheric heat shimmer and airborne dust motes',
        cameraDetails: 'Shot on 35mm anamorphic prime lens, Arri Alexa Mini LF, natural motion blur, rich Kodachrome-inspired filmic color science with deep blacks and unclipped highlights',
        negativePrompt: 'cartoon, CGI look, plastic surfaces, blurry textures, camera jitter, warped geometry, floating objects, glitch, low resolution, amateur video, scene transitions, camera switching, montage, scene change'
    },
    'historical-colonial': {
        id: 'historical-colonial',
        name: 'Preset 2: Historical Era Reconstruction (1776 Colonial Philadelphia)',
        description: 'Authentic 18th-century revolutionary streetscape with lime mortar brickwork, timber woodwork, and dirt/cobblestone roads.',
        headerStyle: 'An authentic, museum-grade historical cinematic shot',
        materials: 'Authentic period-accurate masonry, traditional timber framing, and historical ground surfaces with natural age and patina',
        defaultLighting: 'Crisp autumn early morning light, soft 5400K daylight raking across red brick surfaces, gentle chimney woodsmoke drifting from residential hearths across the rooftops, and subtle ground mist burning off the cobblestones',
        cameraDetails: '50mm spherical cinema prime, rich 18th-century chiaroscuro tonal depth, classical oil-painting-inspired color grade with deep raw umbers, antique parchment tones, and muted earth pigments',
        negativePrompt: 'modern vehicles, asphalt roads, electric wires, power lines, antennas, plastic, neon, modern signage, automobiles, air conditioners, modern clothing'
    },
    'cyberpunk-scifi': {
        id: 'cyberpunk-scifi',
        name: 'Preset 3: Hard-Surface Cyberpunk Megacity (Astra Blockout)',
        description: 'Vertical multi-tier sci-fi canyon with carbon-fiber cladding, holographic ribbons, and wet asphalt reflections.',
        headerStyle: 'A photorealistic, hyper-detailed cinematic shot',
        materials: 'Weathered composite architectural cladding, industrial structural framework, and illuminated reflective surfaces',
        defaultLighting: 'High-contrast nighttime atmospheric illumination, piercing magenta and electric cyan neon light slicing through heavy industrial rain squalls, rising thermal steam from street grates, and dense volumetric atmospheric fog',
        cameraDetails: 'Shot on vintage anamorphic lens, characteristic horizontal blue streak flares, high dynamic range digital cinema look with deep inky blacks and vibrant saturated neon highlights',
        negativePrompt: 'blurry, low poly, oversaturated bloom, daylight, sunny, flat shading, dated CGI, cartoon'
    },
    'architectural-digest': {
        id: 'architectural-digest',
        name: 'Preset 4: Architectural Digest / Clean Scandinavian Reveal',
        description: 'Contemporary architectural presentation with fair-face board-formed concrete, untreated larch wood, and low-iron structural glass.',
        headerStyle: 'A pristine, contemporary architectural editorial film shot',
        materials: 'Clean architectural surfaces, board-formed finishes, natural timber accents, and pristine structural glazing',
        defaultLighting: 'Clean, soft 5500K overcast architectural daylight, soft contact ambient occlusion under cantilevered roof slabs, zero harsh specular hotspots, and crisp, pristine Scandinavian air',
        cameraDetails: 'Large-format architectural tilt-shift lens perspective, tack-sharp edge-to-edge optical clarity, neutral commercial grading with pristine white balance and delicate silver mid-tones',
        negativePrompt: 'harsh shadows, lens distortion, dirty walls, weathering, graffiti, lens flares, dramatic vignetting'
    },
    'claymation-miniature': {
        id: 'claymation-miniature',
        name: 'Preset 5: Tactile Claymation / Architectural Miniature Diorama',
        description: 'Charming stop-motion miniature diorama with fingerprint clay textures, balsa wood beams, and tilt-shift depth of field.',
        headerStyle: 'A charming, high-fidelity stop-motion claymation animated short scene',
        materials: 'Hand-sculpted artisan modeling clay with tactile surface impressions and handcrafted miniature scenic elements',
        defaultLighting: 'Warm, cozy desktop studio work-lamp illumination at 3000K, soft circular light falloff, gentle bounce card fill, and a friendly, whimsical atmosphere',
        cameraDetails: 'Extreme macro lens focus, shallow depth of field with creamy miniature tilt-shift background blur, vibrant pastel color palette, and authentic 12fps stop-motion cadence',
        negativePrompt: 'photorealistic human, CGI, digital smoothness, motion blur, cold lighting, sharp metallic surfaces'
    }
};

export interface OmniSolarEphemeris {
    elevationDeg: number;
    azimuthDeg: number;
    colorTempK?: number;
}

export interface OmniWeatherCondition {
    condition: string;
    fogDensity?: number;
    surfaceWetness?: number;
}

export interface OmniVideoPromptContext {
    stylePreset: OmniStylePresetId;
    primarySubject: string;
    coordinates?: { lat: number; lng: number };
    customMaterials?: string;
    pbrMaterials?: string[];
    solarEphemeris?: OmniSolarEphemeris;
    weather?: OmniWeatherCondition;
    useStartFrame?: boolean;
    startFrameRef?: string;      // Defaults to '<IMAGE_REF_0>' when useStartFrame is true
    blockoutVideoRef?: string;   // Defaults to '<VIDEO_REF_0>'
    cameraDetailsOverride?: string;
    negativePrompt?: string;
    simplifiedPrompt?: boolean;
}

export function getOmniStylePreset(id: OmniStylePresetId): OmniStylePreset {
    const preset = OMNI_STYLE_PRESETS[id];
    if (!preset) {
        throw new Error(`Unknown Omni style preset: ${id}`);
    }
    return preset;
}

export function listOmniStylePresets(): OmniStylePreset[] {
    return Object.values(OMNI_STYLE_PRESETS);
}

/**
 * Builds a structured, physically grounded prompt for Google Omni 1.1 / Veo.
 * When useStartFrame is enabled, the prompt configures dual-conditioning:
 * binding materials and identity to <IMAGE_REF_0> while locking motion/geometry to <VIDEO_REF_0>.
 */
export function buildOmniVideoRestylePrompt(ctx: OmniVideoPromptContext): string {
    const preset = getOmniStylePreset(ctx.stylePreset);
    const videoRef = ctx.blockoutVideoRef || '<VIDEO_REF_0>';
    const imageRef = ctx.startFrameRef || '<IMAGE_REF_0>';
    const useStartFrame = ctx.useStartFrame ?? true;

    if (ctx.simplifiedPrompt) {
        return buildSimplifiedOmniPrompt({
            blockoutVideoRef: videoRef,
            startFrameRef: imageRef
        });
    }

    // Build subject line with geographic coordinates if provided
    let subjectLine = `${preset.headerStyle} of ${ctx.primarySubject}.`;
    if (ctx.coordinates) {
        subjectLine = `${preset.headerStyle} of ${ctx.primarySubject} (coordinates: ${ctx.coordinates.lat.toFixed(6)}, ${ctx.coordinates.lng.toFixed(6)}).`;
    }

    // Material description synthesis for single-video mode or when explicitly customized
    let materialDescription = ctx.customMaterials || preset.materials;
    if (ctx.pbrMaterials && ctx.pbrMaterials.length > 0) {
        materialDescription = materialDescription
            ? `${materialDescription}. Featuring physical PBR materials: ${ctx.pbrMaterials.join(', ')}.`
            : `Featuring physical PBR materials: ${ctx.pbrMaterials.join(', ')}.`;
    }

    // Lighting and atmospheric calculation from solar ephemeris and weather
    let lightingDescription = preset.defaultLighting;
    if (ctx.solarEphemeris) {
        const alt = ctx.solarEphemeris.elevationDeg;
        const az = ctx.solarEphemeris.azimuthDeg;
        const defaultColorTemp = alt < 15 ? 2400 : (alt < 30 ? 3200 : 5500);
        const temp = ctx.solarEphemeris.colorTempK || defaultColorTemp;

        const weatherStr = ctx.weather?.condition ? `under ${ctx.weather.condition} atmospheric conditions` : 'under clear skies';
        const fogStr = ctx.weather?.fogDensity && ctx.weather.fogDensity > 0
            ? `, with ${(ctx.weather.fogDensity * 100).toFixed(0)}% volumetric atmospheric fog`
            : '';
        const wetnessStr = ctx.weather?.surfaceWetness && ctx.weather.surfaceWetness > 0
            ? ` and ${(ctx.weather.surfaceWetness * 100).toFixed(0)}% road/surface wetness reflections`
            : '';

        lightingDescription = `Physically grounded directional solar illumination at ${alt.toFixed(1)}° elevation and ${az.toFixed(1)}° azimuth, blackbody color temperature ${temp}K, ${weatherStr}${fogStr}${wetnessStr}`;
    }

    const cameraDetails = ctx.cameraDetailsOverride || preset.cameraDetails;

    const sections: string[] = [subjectLine, ''];

    if (useStartFrame) {
        // Dual-conditioned prompt: explicitly propagate visual identity from <IMAGE_REF_0>
        // onto the motion and spatial trajectory of <VIDEO_REF_0>.
        // Avoid canned material catalogs — visual identity and materials are established by <IMAGE_REF_0>.
        let visualIdentityLine = `Visual Identity & Materials: Strictly preserve and propagate the exact architectural detailing, surface finishes, material reflectivity, and color science established in ${imageRef}.`;
        if (ctx.customMaterials) {
            visualIdentityLine += ` ${ctx.customMaterials}.`;
        }
        if (ctx.pbrMaterials && ctx.pbrMaterials.length > 0) {
            visualIdentityLine += ` Featuring physical PBR materials: ${ctx.pbrMaterials.join(', ')}.`;
        }
        sections.push(visualIdentityLine);
        sections.push(
            `Lighting & Atmosphere: Maintain the lighting vector, shadow contrast, color temperature, and atmospheric mood established in ${imageRef}. ${lightingDescription}.`
        );
        sections.push(
            `Camera Details: ${cameraDetails}.`
        );
        sections.push('');
        sections.push(
            `Motion & Spatial Guidance: Follow the 6-DoF camera trajectory, depth parallax, vanishing points, and geometric boundaries of ${videoRef}. Smoothly propagate the visual identity and surface textures of ${imageRef} across the entire camera move without morphing, warping, or style drift.\nShot Structure & Timing: A single continuous uninterrupted camera take from start to finish. Strictly seamless camera movement with zero scene transitions, no camera switching, and no montage edits. Strictly adhere to the exact 3-second timing, pace, and continuous camera kinematics of ${videoRef}.`
        );
    } else {
        // Single-video blockout prompt: describe materials and lighting directly
        if (materialDescription) {
            sections.push(`Materials & Textures: ${materialDescription}.`);
        }
        sections.push(`Lighting & Atmosphere: ${lightingDescription}.`);
        sections.push(`Camera Details: ${cameraDetails}.`);
        sections.push('');
        sections.push(`Follow the structure, depth, and spatial geometry of ${videoRef}. A single continuous uninterrupted camera take with zero scene transitions, strictly adhering to the timing and kinematics of ${videoRef}.`);
    }

    return sections.join('\n');
}

export interface DualConditionedOmniVideoOptions {
    context: OmniVideoPromptContext;
    workspaceRoot: string;
    idempotencyKey: string;
    startImageAsset?: MediaAssetRef;
    blockoutVideoAsset?: MediaAssetRef;
    durationSeconds?: 4 | 6 | 8;
    aspectRatio?: '16:9' | '9:16';
    resolution?: '720p' | '1080p' | '4k';
    generateAudio?: boolean;
    modelPriority?: string[];
}

/**
 * Packages a complete, validated VideoGenerationRequest for GoogleMediaGenerationService
 * prioritizing Google Omni 1.1 with dual start-frame and blockout video conditioning.
 */
export function buildDualConditionedOmniVideoRequest(options: DualConditionedOmniVideoOptions): VideoGenerationRequest {
    const prompt = buildOmniVideoRestylePrompt({
        ...options.context,
        useStartFrame: !!options.startImageAsset,
        startFrameRef: options.startImageAsset ? '<IMAGE_REF_0>' : undefined,
        blockoutVideoRef: options.blockoutVideoAsset ? '<VIDEO_REF_0>' : undefined
    });

    const preset = getOmniStylePreset(options.context.stylePreset);
    const negativePrompt = options.context.negativePrompt || preset.negativePrompt;

    return {
        kind: 'video',
        prompt,
        workspaceRoot: options.workspaceRoot,
        idempotencyKey: options.idempotencyKey,
        sourceAsset: options.startImageAsset,
        referenceAssets: options.blockoutVideoAsset ? [options.blockoutVideoAsset] : undefined,
        durationSeconds: options.durationSeconds || 6,
        aspectRatio: options.aspectRatio || '16:9',
        resolution: options.resolution || '1080p',
        generateAudio: options.generateAudio ?? false,
        modelPriority: options.modelPriority || VIDEO_MODEL_PRIORITY,
        negativePrompt
    };
}

export interface SimplifiedOmniPromptOptions {
    blockoutVideoRef?: string;
    startFrameRef?: string;
    durationSeconds?: number;
}

/**
 * Builds the simplified, non-hallucinatory prompt for Google Omni 1.1 / Veo.
 * Strictly focuses on exact 6-DoF camera kinematics and seamless texture propagation
 * from <IMAGE_REF_0>, eliminating all hallucinated material or environmental details.
 */
export function buildSimplifiedOmniPrompt(options: SimplifiedOmniPromptOptions = {}): string {
    const videoRef = options.blockoutVideoRef || '<VIDEO_REF_0>';
    const imageRef = options.startFrameRef || '<IMAGE_REF_0>';
    const duration = options.durationSeconds ? options.durationSeconds.toFixed(1) : '3.0';

    return [
        `Motion & Spatial Guidance: Follow the EXACT 6-DoF camera trajectory, depth parallax, vanishing points, and geometric boundaries of the provided blockout video (${videoRef}). Smoothly propagate the visual identity and surface textures of the start frame image (${imageRef}) across the entire camera move without morphing, warping, or style drift.`,
        `Shot Continuity & Timing: A single continuous uninterrupted camera take from start to finish. Strictly seamless camera movement with zero scene transitions, no camera switching, and no montage edits. Strictly follow the continuous flight trajectory and exact ${duration}-second timing and pace of the provided blockout video (${videoRef}) without any interruption.`
    ].join('\n\n');
}

export interface MinimalOmniVideoPromptOptions {
    blockoutVideoRef?: string;
    primarySubject?: string;
    stylePrefix?: string;
}

/**
 * Builds minimal direction for Google Omni 1.1 when paired with a start frame <IMAGE_REF_0>:
 * "Follow the structure, depth, and spatial geometry of <VIDEO_REF_0>."
 * Avoids verbose material hallucination by relying on <IMAGE_REF_0> for textures/materials
 * and <VIDEO_REF_0> for 6-DoF geometry.
 */
export function buildMinimalOmniVideoPrompt(options: MinimalOmniVideoPromptOptions = {}): string {
    const videoRef = options.blockoutVideoRef || '<VIDEO_REF_0>';
    if (options.primarySubject) {
        const prefix = options.stylePrefix
            ? `${options.stylePrefix} cinematic shot of ${options.primarySubject}.`
            : `Cinematic aerial shot of ${options.primarySubject}.`;
        return `${prefix}\n\nFollow the structure, depth, and spatial geometry of ${videoRef}. Single continuous uninterrupted shot with zero cuts or scene transitions, strictly adhering to the timing and kinematics of ${videoRef}.`;
    }
    return `Follow the structure, depth, and spatial geometry of ${videoRef}. Single continuous uninterrupted shot with zero cuts or scene transitions, strictly adhering to the timing and kinematics of ${videoRef}.`;
}

/**
 * High-quality 3D tile streaming configuration parameters.
 */
export interface TileStreamingConfig {
    errorTarget: number;    // e.g. CAPTURE_HIGH_ERROR_TARGET = 0.5
    drainMaxFrames: number; // e.g. TILE_DRAIN_MAX_FRAMES = 120
    drainFrameMs: number;   // e.g. 50ms
}

export const HIGH_QUALITY_TILE_STREAMING_CONFIG: TileStreamingConfig = {
    errorTarget: CAPTURE_HIGH_ERROR_TARGET,
    drainMaxFrames: TILE_DRAIN_MAX_FRAMES,
    drainFrameMs: 50
};

export interface GeospatialOmniPipelineOptions {
    locationName: string;
    coordinates: { lat: number; lng: number };
    heading?: number;
    altitudeM?: number;
    aspectRatio?: '16:9' | '9:16';
    stylePreset?: string;
    mood?: LocationMood;
    eraContext?: string;
    subjectDistance?: number;
    workspaceRoot: string;
    idempotencyKey: string;
    startImageAsset?: MediaAssetRef;
    blockoutVideoAsset?: MediaAssetRef;
    durationSeconds?: 4 | 6 | 8;
    resolution?: '720p' | '1080p' | '4k';
    negativePrompt?: string;
}

export interface GeospatialOmniPipelinePlan {
    stage1TileStream: {
        locationName: string;
        coordinates: { lat: number; lng: number };
        heading: number;
        altitudeM: number;
        streamingConfig: TileStreamingConfig;
        frame1AssetRef?: string;
        blockoutVideoAssetRef?: string;
    };
    stage2NanoBananaPrompt: string;
    stage3OmniVideoRequest: VideoGenerationRequest;
    outputVideoTitle: 'Polished Omni Render';
}

/**
 * Constructs the end-to-end 3-stage geospatial video generation pipeline:
 * 1. Stream in 3D tiles from determined location with CAPTURE_HIGH_ERROR_TARGET = 0.5 & TILE_DRAIN_MAX_FRAMES = 120.
 * 2. Restyle that perspective using the standard Nano Banana prompt design (without hardcoded material lists),
 *    which outputs the start frame <IMAGE_REF_0>.
 * 3. Supply Omni 1.1 with minimal direction: "Follow the structure, depth, and spatial geometry of <VIDEO_REF_0>."
 *    The returned video is designated as the "Polished Omni Render".
 */
export function buildGeospatialOmniPipelinePlan(options: GeospatialOmniPipelineOptions): GeospatialOmniPipelinePlan {
    const heading = options.heading !== undefined ? options.heading : 0;
    const altitudeM = options.altitudeM || 250;
    const aspectRatio = options.aspectRatio || '16:9';

    // Stage 1: 3D Tile Stream configuration
    const stage1TileStream = {
        locationName: options.locationName,
        coordinates: options.coordinates,
        heading,
        altitudeM,
        streamingConfig: HIGH_QUALITY_TILE_STREAMING_CONFIG,
        frame1AssetRef: options.startImageAsset ? '<IMAGE_REF_0>' : undefined,
        blockoutVideoAssetRef: options.blockoutVideoAsset ? '<VIDEO_REF_0>' : undefined
    };

    // Stage 2: Standard Nano Banana Beautify prompt (no hardcoded material lists)
    const nanoBananaContext: LocationBeautifyContext = {
        locationName: options.locationName,
        coordinates: options.coordinates,
        heading,
        aspectRatio,
        stylePreset: options.stylePreset || 'cinematic-film',
        mood: options.mood || 'golden-hour',
        eraContext: options.eraContext,
        subjectDistance: options.subjectDistance
    };
    const stage2NanoBananaPrompt = buildLocationBeautifyPrompt(nanoBananaContext);

    // Stage 3: Minimal Omni 1.1 Video direction
    const minimalOmniPrompt = buildMinimalOmniVideoPrompt({
        blockoutVideoRef: options.blockoutVideoAsset ? '<VIDEO_REF_0>' : undefined,
        primarySubject: options.locationName
    });

    const stage3OmniVideoRequest: VideoGenerationRequest = {
        kind: 'video',
        prompt: minimalOmniPrompt,
        workspaceRoot: options.workspaceRoot,
        idempotencyKey: options.idempotencyKey,
        sourceAsset: options.startImageAsset,
        referenceAssets: options.blockoutVideoAsset ? [options.blockoutVideoAsset] : undefined,
        durationSeconds: options.durationSeconds || 6,
        aspectRatio,
        resolution: options.resolution || '1080p',
        generateAudio: false,
        modelPriority: VIDEO_MODEL_PRIORITY,
        negativePrompt: options.negativePrompt || 'cartoon, CGI look, plastic surfaces, blurry textures, camera jitter, warped geometry, floating objects, glitch, low resolution, amateur video'
    };

    return {
        stage1TileStream,
        stage2NanoBananaPrompt,
        stage3OmniVideoRequest,
        outputVideoTitle: 'Polished Omni Render'
    };
}

export interface BlockoutNanoBananaPromptOptions {
    locationName: string;
    coordinates?: { lat: number; lng: number };
    heading?: number;
    earthUrl?: string;
    aspectRatio?: '16:9' | '9:16' | string;
    moodPromptContext?: string;
    subjectDistanceHint?: string;
    styleSuffix?: string;
}

/**
 * Builds the Nano Banana restyling prompt that converts Frame 1 of the 3D blockout video
 * into a photorealistic photograph before it becomes <IMAGE_REF_0> in the Omni pipeline.
 */
export function buildBlockoutNanoBananaPrompt(options: BlockoutNanoBananaPromptOptions): string {
    const coordsStr = options.coordinates
        ? `${options.coordinates.lat.toFixed(6)}, ${options.coordinates.lng.toFixed(6)}`
        : '40.748400, -73.985700';
    const heading = options.heading !== undefined ? Math.round(options.heading) : 0;
    const earthUrl = options.earthUrl || (options.coordinates
        ? `https://earth.google.com/web/@${options.coordinates.lat},${options.coordinates.lng}`
        : 'https://earth.google.com/web/@40.7484,-73.9857');
    const aspectRatio = options.aspectRatio || '16:9';
    const moodPromptContext = options.moodPromptContext !== undefined
        ? options.moodPromptContext
        : 'Golden hour warm sunlight casting long dramatic shadows across facade geometries, clear atmospheric perspective. ';
    const subjectDistanceHint = options.subjectDistanceHint !== undefined
        ? options.subjectDistanceHint
        : ' Subject distance: approximately 250 meters from camera (use this for depth-of-field, focus, and aerial-perspective haze).';
    const styleSuffix = options.styleSuffix !== undefined
        ? options.styleSuffix
        : ' Cinematic 35mm film photography, high dynamic range, crisp architectural edge details, authentic glass reflection and atmospheric depth.';

    return buildBeautifyPrompt({
        locationName: options.locationName,
        coords: coordsStr,
        heading,
        earthUrl,
        aspectRatio,
        moodPromptContext,
        subjectDistanceHint,
        styleSuffix
    });
}

export interface BlockoutOmniPipelineOptions {
    locationName: string;
    coordinates?: { lat: number; lng: number };
    heading?: number;
    earthUrl?: string;
    workspaceRoot: string;
    idempotencyKey: string;
    frame1ImageAsset?: MediaAssetRef;      // Frame 1 asset or restyled image (<IMAGE_REF_0>)
    blockoutFrame1Asset?: MediaAssetRef;  // Explicit Frame 1 of blockout video before restyling
    restyledImageAsset?: MediaAssetRef;   // Explicit restyled photorealistic image (<IMAGE_REF_0>)
    blockoutVideoAsset: MediaAssetRef;    // Full blockout video (<VIDEO_REF_0>)
    moodPromptContext?: string;
    subjectDistanceHint?: string;
    styleSuffix?: string;
    stylePreset?: OmniStylePresetId;
    customMaterials?: string;
    pbrMaterials?: string[];
    solarEphemeris?: OmniSolarEphemeris;
    weather?: OmniWeatherCondition;
    cameraDetailsOverride?: string;
    durationSeconds?: 4 | 6 | 8;
    aspectRatio?: '16:9' | '9:16';
    resolution?: '720p' | '1080p' | '4k';
    negativePrompt?: string;
}

export interface BlockoutOmniPipelinePlan {
    imageRef: '<IMAGE_REF_0>';
    videoRef: '<VIDEO_REF_0>';
    outputVideoTitle: 'Polished Omni Render';
    nanoBananaPrompt: string;
    stage1BlockoutFrameExtraction: {
        rawFrame1Asset?: MediaAssetRef;
        description: string;
    };
    stage2NanoBananaRestyle: {
        prompt: string;
        imageRef: '<IMAGE_REF_0>';
        description: string;
    };
    stage3DualOmniGeneration: {
        imageRef: '<IMAGE_REF_0>';
        videoRef: '<VIDEO_REF_0>';
        omniVideoRequest: VideoGenerationRequest;
        outputVideoTitle: 'Polished Omni Render';
    };
    omniVideoRequest: VideoGenerationRequest;
}

/**
 * Builds the pipeline request where Frame 1 of the 3D blockout video is extracted
 * at the start of the pipeline and restyled with Nano Banana into a photorealistic photograph
 * before it becomes <IMAGE_REF_0> in the Omni pipeline.
 * The blockout video is set as <VIDEO_REF_0>, both are fed into Omni 1.1, and the
 * returned video is designated as the "Polished Omni Render".
 */
export function buildBlockoutOmniPipelinePlan(options: BlockoutOmniPipelineOptions): BlockoutOmniPipelinePlan {
    const preset = getOmniStylePreset(options.stylePreset || 'photoreal-urban');
    const aspectRatio = options.aspectRatio || '16:9';

    const nanoBananaPrompt = buildBlockoutNanoBananaPrompt({
        locationName: options.locationName,
        coordinates: options.coordinates,
        heading: options.heading,
        earthUrl: options.earthUrl,
        aspectRatio,
        moodPromptContext: options.moodPromptContext,
        subjectDistanceHint: options.subjectDistanceHint,
        styleSuffix: options.styleSuffix
    });

    const prompt = buildOmniVideoRestylePrompt({
        stylePreset: options.stylePreset || 'photoreal-urban',
        primarySubject: options.locationName,
        coordinates: options.coordinates,
        customMaterials: options.customMaterials,
        pbrMaterials: options.pbrMaterials,
        solarEphemeris: options.solarEphemeris,
        weather: options.weather,
        cameraDetailsOverride: options.cameraDetailsOverride,
        useStartFrame: true,
        startFrameRef: '<IMAGE_REF_0>',
        blockoutVideoRef: '<VIDEO_REF_0>',
        negativePrompt: options.negativePrompt
    });

    const activeStartAsset = options.restyledImageAsset || options.frame1ImageAsset || options.blockoutFrame1Asset;

    const omniVideoRequest: VideoGenerationRequest = {
        kind: 'video',
        prompt,
        workspaceRoot: options.workspaceRoot,
        idempotencyKey: options.idempotencyKey,
        sourceAsset: activeStartAsset,
        referenceAssets: [options.blockoutVideoAsset],
        durationSeconds: options.durationSeconds || 6,
        aspectRatio,
        resolution: options.resolution || '1080p',
        generateAudio: false,
        modelPriority: VIDEO_MODEL_PRIORITY,
        negativePrompt: options.negativePrompt || preset.negativePrompt
    };

    return {
        imageRef: '<IMAGE_REF_0>',
        videoRef: '<VIDEO_REF_0>',
        outputVideoTitle: 'Polished Omni Render',
        nanoBananaPrompt,
        stage1BlockoutFrameExtraction: {
            rawFrame1Asset: options.blockoutFrame1Asset || options.frame1ImageAsset,
            description: 'Extract Frame 1 from watertight 3D blockout video at t=0.0s.'
        },
        stage2NanoBananaRestyle: {
            prompt: nanoBananaPrompt,
            imageRef: '<IMAGE_REF_0>',
            description: 'Restyle blockout Frame 1 with Nano Banana to convert into photorealistic photograph <IMAGE_REF_0>.'
        },
        stage3DualOmniGeneration: {
            imageRef: '<IMAGE_REF_0>',
            videoRef: '<VIDEO_REF_0>',
            omniVideoRequest,
            outputVideoTitle: 'Polished Omni Render'
        },
        omniVideoRequest
    };
}

export interface HybridOmniVideoPayload {
    spatial_trajectory_lock: {
        flight_path_type: 'catmull_rom_spline' | 'linear_orbit' | 'straight_dolly';
        start_pose: {
            headingDegrees: number;
            pitchDegrees: number;
            altitudeMeters: number;
        };
        end_pose?: {
            headingDegrees: number;
            pitchDegrees: number;
            altitudeMeters: number;
        };
        total_duration_seconds: number;
        framing_rules: string[];
    };
    rendering_instruction: string;
    generation_parameters: {
        aspect_ratio: string;
        resolution: string;
        input_references: string[];
        target_engine: 'google-omni-1.1' | 'google-veo';
        negative_prompt: string;
    };
}

export interface BuildHybridOmniVideoOptions {
    context: OmniVideoPromptContext;
    flightPathType?: 'catmull_rom_spline' | 'linear_orbit' | 'straight_dolly';
    startPose?: { headingDegrees: number; pitchDegrees: number; altitudeMeters: number };
    endPose?: { headingDegrees: number; pitchDegrees: number; altitudeMeters: number };
    durationSeconds?: number;
    aspectRatio?: string;
    resolution?: string;
}

/**
 * Builds the canonical Hybrid JSON payload for Google Omni 1.1 / Veo video flyover generation.
 * Encapsulates the 6-DOF spline flight path in spatial_trajectory_lock and rich de-noising
 * narrative in rendering_instruction.
 */
export function buildHybridOmniVideoPayload(options: BuildHybridOmniVideoOptions): HybridOmniVideoPayload {
    const rawInstruction = buildOmniVideoRestylePrompt(options.context);
    const preset = getOmniStylePreset(options.context.stylePreset);
    const negativePrompt = options.context.negativePrompt || preset.negativePrompt;

    const startPose = options.startPose || {
        headingDegrees: options.context.coordinates ? 45 : 0,
        pitchDegrees: -20,
        altitudeMeters: 85
    };

    return {
        spatial_trajectory_lock: {
            flight_path_type: options.flightPathType || 'catmull_rom_spline',
            start_pose: startPose,
            end_pose: options.endPose,
            total_duration_seconds: options.durationSeconds || 6,
            framing_rules: [
                'RULE_1: Strictly maintain continuous 6-DOF camera trajectory from blockout video without sudden jumps or cuts.',
                'RULE_2: Preserve the horizon pitch, field of view, and perspective vanishing points established by the camera path.',
                'RULE_3: Zero scene cuts, zero dissolves, zero montage cuts — continuous single-shot sequence only.'
            ]
        },
        rendering_instruction: rawInstruction,
        generation_parameters: {
            aspect_ratio: options.aspectRatio || '16:9',
            resolution: options.resolution || '1080p',
            input_references: options.context.useStartFrame ? ['<IMAGE_REF_0>', '<VIDEO_REF_0>'] : ['<VIDEO_REF_0>'],
            target_engine: 'google-omni-1.1',
            negative_prompt: negativePrompt
        }
    };
}

/**
 * Serializes the Hybrid Omni Video payload to a standard JSON string.
 */
export function compileHybridOmniVideoPrompt(options: BuildHybridOmniVideoOptions): string {
    return JSON.stringify(buildHybridOmniVideoPayload(options), null, 2);
}


