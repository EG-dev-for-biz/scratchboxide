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
    | 'claymation-miniature'
    | 'neutral-portrait-a-frame';

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
    },
    'neutral-portrait-a-frame': {
        id: 'neutral-portrait-a-frame',
        name: 'Preset 6: Neutral Performer Studio Portrait (Head-to-Toe A-Frame)',
        description: 'Neutral, flat, shadowless, evenly lit studio portrait of a performer from head to toe in an A-frame pose against a plain backdrop with zero context or dramatic lighting.',
        headerStyle: 'A neutral, hyper-realistic, full-body studio portrait of',
        materials: 'Authentic fabric textures, natural skin micro-detail, and realistic footwear without baked environmental shadows or reflections',
        defaultLighting: 'Completely neutral, flat, diffuse, shadowless studio illumination. Uniform even lighting from all angles with high CRI, zero directional keylights, zero harsh specular hotspots, and zero cast shadows',
        cameraDetails: 'Full-body eye-level uncropped portrait lens framing from head to toe (9:16), 50mm prime, pristine neutral color balance, tack-sharp edge-to-edge optical focus across entire figure',
        negativePrompt: 'dramatic lighting, directional sunlight, harsh shadows, stage spotlights, colored gels, rim light, ambient occlusion shadows, contrasty lighting, room, furniture, rug, floorboards, window, wall, stage, concert venue, outdoor, buildings, cropped head, cropped feet, cropped hands, close-up, medium shot, folded arms, crossed legs, dynamic action pose, asymmetrical stance, CGI plastic, cartoon'
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

// ============================================================================
// Neutral Performer Studio Prompt Builders (Zero-Context, Zero-Lighting FX, A-Frame)
// ============================================================================

export interface NeutralPerformerPromptOptions {
    /**
     * Subject or performer description (e.g. "A female vocalist", "A humanoid dancer").
     */
    subject?: string;
    /**
     * Optional detailed clothing/wardrobe description (e.g. "oversized white linen tunic, wide-leg palazzo trousers, chunky white sneakers").
     */
    wardrobe?: string;
    /**
     * Target aspect ratio. Defaults to "9:16" for full-body vertical portraits.
     */
    aspectRatio?: '9:16' | '16:9' | '1:1' | string;
    /**
     * Media target kind: 'image' (still portrait) or 'video' (motion calibration clip). Defaults to 'image'.
     */
    kind?: 'image' | 'video';
    /**
     * Whether to enforce the canonical symmetrical A-frame pose. Defaults to true.
     */
    isAFramePose?: boolean;
    /**
     * Subtle movement instruction if kind === 'video'. Defaults to stationary calibration with subtle natural breathing.
     */
    videoMotion?: string;
    /**
     * Optional additional negative prompt clauses.
     */
    extraNegativePrompt?: string;
}

export interface NeutralPerformerPromptResult {
    prompt: string;
    negativePrompt: string;
    aspectRatio: string;
    kind: 'image' | 'video';
    isAFramePose: boolean;
}

/**
 * Builds a strictly neutral, evenly lit full-body head-to-toe portrait prompt for image or video generation tools.
 * Enforces:
 * 1. Zero Context: Plain solid neutral grey studio backdrop (#808080) with zero scenery or furniture.
 * 2. Zero Lighting FX: Completely flat, neutral, high-CRI, diffuse, shadowless studio illumination with zero directional shadows.
 * 3. Full-Body Framing: Vertical uncropped portrait framing from head to toe with clean top/bottom margins.
 * 4. A-Frame Pose (A-pose): Symmetrical upright stance with arms angled outward 35-45 degrees, legs straight and shoulder-width apart, feet flat on the floor.
 */
export function buildNeutralPerformerPrompt(options: NeutralPerformerPromptOptions = {}): NeutralPerformerPromptResult {
    const kind = options.kind || 'image';
    const aspectRatio = options.aspectRatio || '9:16';
    const isAFrame = options.isAFramePose !== false;

    const subjectStr = options.subject?.trim() || 'A humanoid performer';
    const wardrobeStr = options.wardrobe?.trim()
        ? ` dressed in ${options.wardrobe.trim()}`
        : '';

    const poseBlock = isAFrame
        ? 'Standing upright in an exact symmetrical A-frame pose (A-pose): arms angled outward 35 to 45 degrees from the flanks, open palms facing forward with relaxed fingers, legs straight and shoulder-width apart, feet planted flat on the floor pointing directly forward. Clean separation between arms and torso and between legs, zero limb self-occlusion.'
        : 'Standing upright in a neutral, balanced stance with arms relaxed at sides and feet shoulder-width apart.';

    const framingBlock = 'Full-body head-to-toe vertical framing. The entire figure is fully visible with clear uncropped margins above the top of the head and below the soles of the shoes. Zero cropping of head, limbs, or feet.';

    const lightingBlock = 'Completely flat, neutral, high-CRI, diffuse, shadowless studio illumination. Uniform even lighting from all angles with zero directional keylights, zero harsh specular hotspots, and zero cast shadows on the body or floor.';

    const contextBlock = 'Plain solid neutral grey studio backdrop (#808080), completely blank and devoid of environment, pure seamless cyclorama infinity wall with uniform matte floor.';

    const cameraBlock = 'Eye-level locked camera at chest height, neutral 50mm portrait lens, pristine neutral color balance, tack-sharp edge-to-edge optical focus across the entire figure from head to toe.';

    let promptLines: string[];

    if (kind === 'video') {
        const motionDetail = options.videoMotion?.trim() || 'The subject remains stationary in the calibrated A-frame pose with only subtle natural resting breathing and micro-movements.';
        promptLines = [
            `A full-body studio video portrait of ${subjectStr}${wardrobeStr}.`,
            'Single continuous shot, no scene cuts. Locked-off stationary camera at eye level.',
            framingBlock,
            poseBlock,
            motionDetail,
            lightingBlock,
            contextBlock,
            cameraBlock,
            'Sound design: silence, no music, no dialogue.'
        ];
    } else {
        promptLines = [
            `A full-body, head-to-toe studio portrait of ${subjectStr}${wardrobeStr}.`,
            framingBlock,
            poseBlock,
            lightingBlock,
            contextBlock,
            cameraBlock,
            'High dynamic range, authentic fabric weave and skin micro-detail without baked lighting.'
        ];
    }

    const baseNegative = 'dramatic lighting, directional sunlight, harsh shadows, deep cast shadows, stage spotlights, colored gels, rim light, ambient occlusion shadows, contrasty lighting, chiaroscuro, room, interior, exterior, living room, bedroom, furniture, radiator, windows, parquet floor, wood floor, carpet, rug, stage, concert venue, outdoor, outdoor landscape, street, buildings, trees, sky, cropped head, cropped feet, cropped hands, cropped limbs, close-up, medium shot, half-body shot, folded arms, crossed legs, dynamic action pose, asymmetrical stance, motion blur, CGI plastic, cartoon, illustration, low resolution';

    const negativePrompt = options.extraNegativePrompt?.trim()
        ? `${baseNegative}, ${options.extraNegativePrompt.trim()}`
        : baseNegative;

    return {
        prompt: promptLines.join(' '),
        negativePrompt,
        aspectRatio,
        kind,
        isAFramePose: isAFrame
    };
}

export function buildNeutralPerformerImagePrompt(options: Omit<NeutralPerformerPromptOptions, 'kind'> = {}): NeutralPerformerPromptResult {
    return buildNeutralPerformerPrompt({ ...options, kind: 'image' });
}

export function buildNeutralPerformerVideoPrompt(options: Omit<NeutralPerformerPromptOptions, 'kind'> = {}): NeutralPerformerPromptResult {
    return buildNeutralPerformerPrompt({ ...options, kind: 'video' });
}

export type MultiViewCameraPosition = 'front' | 'left_45' | 'right_45' | 'rear_180' | 'orbit_360';

export type MultiViewCameraRigPreset = '6-view-orbit' | '24-view-dense' | '48-view-multipitch' | '24-view-frontal-arc' | 'custom';

export interface MultiViewCameraRigOptions {
    preset?: MultiViewCameraRigPreset;
    viewsPerLayer?: number;
    layerPitches?: number[];
    startYaw?: number;
    yawSpan?: number;
    orbitRadius?: number;
    elevationM?: number;
    fovDeg?: number;
}

export interface MultiViewCameraEntry {
    index: number;
    yaw: number;
    yawDeg: number;
    pitch: number;
    pitchDeg: number;
    position: [number, number, number];
    lookAt: [number, number, number];
    fovDeg: number;
    label: string;
    transformMatrixOpencv: number[][];
    transformMatrixNerfstudio: number[][];
}

export interface MultiViewCameraRigResult {
    preset: MultiViewCameraRigPreset;
    viewsPerLayer: number;
    layerPitches: number[];
    startYaw: number;
    yawSpan: number;
    orbitRadius: number;
    elevationM: number;
    fovDeg: number;
    radius: number;
    elevation: number;
    fov: number;
    totalCameras: number;
    cameras: MultiViewCameraEntry[];
    camerasJson: {
        camera_angle_x: number;
        camera_angle_y: number;
        fl_x: number;
        fl_y: number;
        cx: number;
        cy: number;
        w: number;
        h: number;
        num_views: number;
        views: Array<{
            view_id: number;
            yaw: number;
            pitch: number;
            position: [number, number, number];
        }>;
    };
}

/**
 * Multi-view camera rig configuration for multi-angle video conditioning and 4DGS capture.
 * Supports:
 * - '6-view-orbit': Standard 6-camera ring (pitch 0°, yaw 0°..360°, 60° step)
 * - '24-view-dense': Dense 24-camera ring (pitch 0°, yaw 0°..360°, 15° step) for 4DGS
 * - '48-view-multipitch': 16 views per layer across 3 pitches [-10°, 15°, 35°]
 * - '24-view-frontal-arc': 12 views per layer across 2 pitches [0°, 30°] from -90° to +90°
 */
export function generateMultiViewCameraRig(
    optionsOrPreset: MultiViewCameraRigOptions | MultiViewCameraRigPreset = {}
): MultiViewCameraRigResult {
    const options: MultiViewCameraRigOptions = typeof optionsOrPreset === 'string'
        ? { preset: optionsOrPreset }
        : optionsOrPreset;
    const preset = options.preset || '6-view-orbit';
    let viewsPerLayer = options.viewsPerLayer;
    let layerPitches = options.layerPitches;
    let startYaw = options.startYaw;
    let yawSpan = options.yawSpan;

    switch (preset) {
        case '24-view-dense':
            viewsPerLayer = viewsPerLayer ?? 24;
            layerPitches = layerPitches ?? [0];
            startYaw = startYaw ?? 0;
            yawSpan = yawSpan ?? 360;
            break;
        case '48-view-multipitch':
            viewsPerLayer = viewsPerLayer ?? 16;
            layerPitches = layerPitches ?? [-10, 15, 35];
            startYaw = startYaw ?? 0;
            yawSpan = yawSpan ?? 360;
            break;
        case '24-view-frontal-arc':
            viewsPerLayer = viewsPerLayer ?? 12;
            layerPitches = layerPitches ?? [0, 30];
            startYaw = startYaw ?? -90;
            yawSpan = yawSpan ?? 180;
            break;
        case '6-view-orbit':
        default:
            viewsPerLayer = viewsPerLayer ?? 6;
            layerPitches = layerPitches ?? [0];
            startYaw = startYaw ?? 0;
            yawSpan = yawSpan ?? 360;
            break;
    }

    const orbitRadius = options.orbitRadius ?? 2.2;
    const elevationM = options.elevationM ?? 1.25;
    const fovDeg = options.fovDeg ?? 50.0;

    const cameras: FourDAnyoneCameraEntry[] = [];
    let idx = 0;

    for (const pitchDeg of layerPitches) {
        const pitchRad = (pitchDeg * Math.PI) / 180.0;
        const cosPitch = Math.cos(pitchRad);
        const sinPitch = Math.sin(pitchRad);

        const step = viewsPerLayer > 1 && yawSpan < 360
            ? yawSpan / (viewsPerLayer - 1)
            : yawSpan / viewsPerLayer;

        for (let i = 0; i < viewsPerLayer; i++) {
            const yawDeg = startYaw + i * step;
            const yawRad = (yawDeg * Math.PI) / 180.0;

            const posX = orbitRadius * Math.sin(yawRad) * cosPitch;
            const posY = elevationM + orbitRadius * sinPitch;
            const posZ = orbitRadius * Math.cos(yawRad) * cosPitch;
            const pos: [number, number, number] = [
                Math.round(posX * 1000) / 1000,
                Math.round(posY * 1000) / 1000,
                Math.round(posZ * 1000) / 1000
            ];
            const lookAtTarget: [number, number, number] = [0, 1.0, 0];

            // Compute camera-to-world (c2w) rotation frame:
            // Camera Z (optical viewing axis pointing towards target)
            const dx = lookAtTarget[0] - posX;
            const dy = lookAtTarget[1] - posY;
            const dz = lookAtTarget[2] - posZ;
            const lenZ = Math.hypot(dx, dy, dz) || 1.0;
            const zx = dx / lenZ;
            const zy = dy / lenZ;
            const zz = dz / lenZ;

            // Camera X (right vector): cross([0, 1, 0], Z)
            let rx = 1.0 * zz - 0.0 * zy;
            let ry = 0.0 * zx - 0.0 * zz;
            let rz = 0.0 * zy - 1.0 * zx;
            const lenR = Math.hypot(rx, ry, rz) || 1.0;
            rx /= lenR;
            ry /= lenR;
            rz /= lenR;

            // Camera Y (down vector in OpenCV): cross(Z, X)
            const yx = zy * rz - zz * ry;
            const yy = zz * rx - zx * rz;
            const yz = zx * ry - zy * rx;

            // OpenCV c2w matrix (+X Right, +Y Down, +Z Forward)
            const transformMatrixOpencv: number[][] = [
                [rx, yx, zx, pos[0]],
                [ry, yy, zy, pos[1]],
                [rz, yz, zz, pos[2]],
                [0, 0, 0, 1]
            ];

            // Nerfstudio / OpenGL c2w matrix (+X Right, +Y Up, -Z Forward): invert columns 1 & 2
            const transformMatrixNerfstudio: number[][] = [
                [rx, -yx, -zx, pos[0]],
                [ry, -yy, -zy, pos[1]],
                [rz, -yz, -zz, pos[2]],
                [0, 0, 0, 1]
            ];

            const yawRounded = Math.round(yawDeg * 100) / 100;
            const pitchRounded = Math.round(pitchDeg * 100) / 100;

            cameras.push({
                index: idx++,
                yaw: yawRounded,
                yawDeg: yawRounded,
                pitch: pitchRounded,
                pitchDeg: pitchRounded,
                position: pos,
                lookAt: lookAtTarget,
                fovDeg,
                label: `Cam_${idx - 1}_Yaw${Math.round(yawDeg)}°_Pitch${Math.round(pitchDeg)}°`,
                transformMatrixOpencv,
                transformMatrixNerfstudio
            });
        }
    }

    // Focal length calculation for 9:16 portrait (2160x3840)
    const fovRad = (fovDeg * Math.PI) / 180.0;
    const fl_x = 2160 / (2 * Math.tan(fovRad / 2));
    const fl_y = fl_x;

    const camerasJson = {
        camera_angle_x: fovRad,
        camera_angle_y: fovRad * (3840 / 2160),
        fl_x: Math.round(fl_x),
        fl_y: Math.round(fl_y),
        cx: 1080,
        cy: 1920,
        w: 2160,
        h: 3840,
        num_views: cameras.length,
        views: cameras.map(c => ({
            view_id: c.index,
            yaw: c.yawDeg,
            pitch: c.pitchDeg,
            position: c.position
        }))
    };

    return {
        preset,
        viewsPerLayer,
        layerPitches,
        startYaw,
        yawSpan,
        orbitRadius,
        elevationM,
        fovDeg,
        radius: orbitRadius,
        elevation: elevationM,
        fov: fovDeg,
        totalCameras: cameras.length,
        cameras,
        camerasJson
    };
}

export interface FrameMotivatedPerformerVideoOptions extends Omit<NeutralPerformerPromptOptions, 'kind'> {
    /**
     * Reference frame tag or path (e.g. '<IMAGE_REF_0>' or 'frame_00.png').
     * The video diffusion model is strictly conditioned on and motivated by this hero frame.
     */
    referenceFrameRef?: string;
    /**
     * Underlying video diffusion backbone. Defaults to 'veo-2.0-generate-001'.
     */
    videoModelBackbone?: 'veo-2.0-generate-001' | 'Wan2.2-TI2V-5B' | 'Wan2.1-I2V' | 'Omni1.1' | string;
    /**
     * Camera position or multi-view capture angle.
     * Front (0°), Left Lateral (45°), Right Lateral (45°), Rear (180°), or full continuous orbit (360°).
     */
    cameraPosition?: MultiViewCameraPosition;
    /**
     * Type of hero pose in the reference frame.
     * 'casual': Natural organic stance extracted from the casual video (NEVER forced into A-pose).
     * 'a-pose': Symmetrical A-frame stance (arms 35-45°).
     * 'as-input': Use the exact pose as supplied in the reference plate.
     */
    heroPoseType?: 'casual' | 'a-pose' | 'as-input';
    /**
     * Optional natural language description of the hero frame pose (e.g. 'arms resting along flanks, relaxed wrists').
     */
    heroPoseDescription?: string;
    /**
     * Whether to enforce strict motion continuity starting from the A-frame stance.
     * When false or when heroPoseType is 'casual', motion starts from the natural casual pose.
     */
    enforceAFrameMotionStart?: boolean;
    /**
     * Multi-view camera rig preset.
     */
    cameraRigPreset?: MultiViewCameraRigPreset;
    /**
     * Optional custom camera rig options.
     */
    cameraRigOptions?: MultiViewCameraRigOptions;
}

export interface FrameMotivatedVideoPromptResult extends NeutralPerformerPromptResult {
    referenceFrameRef: string;
    videoModelBackbone: string;
    cameraPosition: MultiViewCameraPosition;
    firstFrameSyntax: string;
    heroPoseType: 'casual' | 'a-pose' | 'as-input';
    cameraRig?: MultiViewCameraRigResult;
}

/**
 * Builds a frame-motivated, multi-view consistent video prompt for performer capture.
 * Follows the multi-view capture model (Google Veo 2 / Wan2.2 backbone):
 * 1. Frame-Motivated Conditioning: Motion begins seamlessly from the provided hero reference frame (<FIRST_FRAME>).
 * 2. Hero Pose Fidelity: If the hero frame is in a casual or natural posture, conditions strictly on that natural pose without forcing an A-pose.
 * 3. Multi-View Capture Positions: Front 0°, Left 45°, Right 45°, Rear 180°, or Orbit 360° (or full multi-view camera rig).
 * 4. Zero Context & Zero Directional Lighting: Plain solid #808080 grey backdrop, flat diffuse shadowless lighting.
 */
export function buildFrameMotivatedPerformerVideoPrompt(
    options: FrameMotivatedPerformerVideoOptions = {}
): FrameMotivatedVideoPromptResult {
    const referenceFrameRef = options.referenceFrameRef?.trim() || '<IMAGE_REF_0>';
    const videoModelBackbone = options.videoModelBackbone || 'veo-2.0-generate-001';
    const cameraPosition: MultiViewCameraPosition = options.cameraPosition || 'front';

    // Hero pose determination: if heroPoseType is 'casual' or isAFramePose is explicitly false, do NOT enforce A-frame
    const heroPoseType: 'casual' | 'a-pose' | 'as-input' = options.heroPoseType
        ? options.heroPoseType
        : (options.isAFramePose === false ? 'casual' : 'a-pose');

    const isAFrame = heroPoseType === 'a-pose' && options.isAFramePose !== false;

    // Build base neutral performer prompt
    const baseResult = buildNeutralPerformerPrompt({
        ...options,
        kind: 'video',
        isAFramePose: isAFrame
    });

    const firstFrameSyntax = `<FIRST_FRAME>${referenceFrameRef}</FIRST_FRAME>`;

    // Camera viewpoint conditioning
    let cameraViewpointClause: string;
    switch (cameraPosition) {
        case 'left_45':
            cameraViewpointClause = 'Camera capture viewpoint: 45° left lateral oblique perspective angled 45 degrees relative to subject front, locked-off eye-level elevation.';
            break;
        case 'right_45':
            cameraViewpointClause = 'Camera capture viewpoint: 45° right lateral oblique perspective angled 45 degrees relative to subject front, locked-off eye-level elevation.';
            break;
        case 'rear_180':
            cameraViewpointClause = 'Camera capture viewpoint: 180° rear dorsal perspective directly behind subject, locked-off eye-level elevation showing back of head, spine, and rear silhouette.';
            break;
        case 'orbit_360':
            cameraViewpointClause = 'Camera capture trajectory: continuous 360° orbital survey around the subject at constant eye-level radius and elevation.';
            break;
        case 'front':
        default:
            cameraViewpointClause = 'Camera capture viewpoint: front 0° eye-level perspective portrait, locked-off eye-level elevation.';
            break;
    }

    const poseDesc = options.heroPoseDescription || 'casual natural pose';
    const motivationClause = isAFrame
        ? `The video motion is strictly motivated by and begins seamlessly from ${firstFrameSyntax}, originating smoothly from the initial symmetrical A-frame pose (A-pose) established in <FIRST_FRAME> with arms angled downward and outward 35-45 degrees, preserving continuous identity, texture, clothing morphology, and limb boundaries with zero abrupt scene cuts.`
        : `The video motion is strictly motivated by and begins seamlessly from ${firstFrameSyntax}, originating smoothly from the initial ${poseDesc} established in <FIRST_FRAME>, preserving continuous identity, texture, clothing morphology, and limb boundaries with zero abrupt scene cuts.`;

    const modelClause = videoModelBackbone.includes('veo')
        ? `Synthesized via ${videoModelBackbone} closed-loop orbital video conditioning with high-fidelity identity and boundary preservation.`
        : `Synthesized via ${videoModelBackbone} multi-view video diffusion with Reference Context Packing (RCP) and Target Context Routing (TCR) for cross-view consistency.`;

    const fullPrompt = [
        firstFrameSyntax,
        baseResult.prompt,
        motivationClause,
        cameraViewpointClause,
        modelClause
    ].join(' ');

    const negativePromptParts = [
        baseResult.negativePrompt,
        isAFrame ? 'departure from initial A-frame pose in frame 0' : 'departure from initial pose in frame 0',
        'environmental scenery',
        'theatrical lighting'
    ];
    if (options.extraNegativePrompt) {
        negativePromptParts.push(options.extraNegativePrompt);
    }
    const negativePrompt = Array.from(new Set(negativePromptParts.filter(Boolean))).join(', ');

    const cameraRig = options.cameraRigPreset || options.cameraRigOptions
        ? generateMultiViewCameraRig({ preset: options.cameraRigPreset, ...options.cameraRigOptions })
        : undefined;

    return {
        ...baseResult,
        prompt: fullPrompt,
        negativePrompt,
        referenceFrameRef,
        videoModelBackbone,
        cameraPosition,
        firstFrameSyntax,
        heroPoseType,
        cameraRig
    };
}




