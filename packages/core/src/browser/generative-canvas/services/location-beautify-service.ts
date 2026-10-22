/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { MarkdownSection } from '../canvas-types';
import { DocumentTheme, detectDocumentTheme } from '../document-synthesis-engine';
import type { ColmapCameraPose } from '../../../common/spatial/colmap-vector-reference-types';
export interface NanoBananaStyle {
    id: string;
    label: string;
    hint: string;
    mediumDirective: string;
    opticsDirective: string;
    lightingDirective: string;
    colorGrading: string;
}

export const NANO_BANANA_STYLES: NanoBananaStyle[] = [
    {
        id: 'oil-painting',
        label: 'Classical Oil Painting',
        hint: '18th Century Chiaroscuro Fine Art',
        mediumDirective: 'masterpiece 18th-century classical oil painting on textured linen canvas, visible brushstrokes and luminous impasto glazes, museum-grade fine art collection',
        opticsDirective: 'composed with classical golden ratio framing, soft edge falloff, rich tonal depth',
        lightingDirective: 'dramatic Rembrandt chiaroscuro lighting, warm candlelight and golden afternoon window illumination casting deep painterly shadows',
        colorGrading: 'rich earth umbers, deep Prussian blues, warm ochre highlights, and aged varnish patina'
    },
    {
        id: 'cinematic-film',
        label: 'Cinematic Editorial Film',
        hint: '35mm Anamorphic Atmospheric Still',
        mediumDirective: 'cinematic 35mm motion picture still, authentic film stock grain, production value of an epic historical or high-concept film',
        opticsDirective: 'shot on vintage Panavision C-Series anamorphic prime lenses, 50mm f/1.4, subtle horizontal lens flares, shallow depth of field, creamy background bokeh',
        lightingDirective: 'volumetric atmospheric lighting, natural diffused daylight streaming through high windows, subtle dust motes and soft haze in the air',
        colorGrading: 'Kodachrome and Kodak Vision3 5219 color science, organic rich dynamic range, filmic contrast curve'
    },
    {
        id: 'vintage-engraving',
        label: 'Vintage Engraving',
        hint: 'Archival Copperplate Lithograph',
        mediumDirective: 'intricate 18th-century antique copperplate engraving and intaglio etchings, ultra-fine hand-carved cross-hatching, museum archival print',
        opticsDirective: 'orthographic high-detail illustrative perspective, crisp linework from edge to edge',
        lightingDirective: 'high-contrast black ink on warm antiqued cream laid paper with subtle deckled edges',
        colorGrading: 'monochromatic warm sepia and deep carbon black ink on aged 1776 rag parchment with watermarks'
    },
    {
        id: 'architectural',
        label: 'Architectural Blueprint',
        hint: 'High-Precision Technical Schematic',
        mediumDirective: 'high-precision architectural drafting schematic and elevation blueprint, fine isometric cross-sections, CAD vector clarity',
        opticsDirective: 'precise technical axonometric projection, dimension callouts, clean measurement grid overlays',
        lightingDirective: 'even crisp technical drafting light, high legibility, luminous schematic glow',
        colorGrading: 'deep cyan blueprint vellum with crisp chalk-white and electric cyan vector drafting lines'
    },
    {
        id: 'neural-ai',
        label: 'Neural Network Topology',
        hint: 'Multi-Modal Tensor Vector Glow',
        mediumDirective: 'abstract high-dimensional tensor network visualization, multi-modal transformer attention graphs, subagent DAG orchestration pipelines',
        opticsDirective: 'hyper-detailed volumetric 3D particle rendering, macro depth of field on critical weight pathways',
        lightingDirective: 'bioluminescent synaptic node glow, dynamic fiber optic data pulses, ambient occlusion in dark space',
        colorGrading: 'deep graphite slate backdrop with glowing electric cyan, vivid ultraviolet, and radiant magenta data streams'
    },
    {
        id: 'modern-editorial',
        label: 'Cupertino Studio',
        hint: 'Minimalist Clean Daylight Aesthetic',
        mediumDirective: 'clean modern editorial fine art studio photography, premium Cupertino minimalist design aesthetic, architectural digest standard',
        opticsDirective: 'shot on Hasselblad 100MP medium format camera, 80mm lens, tack-sharp edge-to-edge optical resolution',
        lightingDirective: 'soft 5500K balanced natural morning daylight from floor-to-ceiling glass, subtle ambient bounce fill',
        colorGrading: 'neutral balanced whites, delicate silver and graphite tones, clean unclipped highlights'
    },
    {
        id: 'chiaroscuro',
        label: 'Master Chiaroscuro',
        hint: 'Dramatic Renaissance Shadow & Light',
        mediumDirective: 'dramatic Caravaggio-inspired chiaroscuro masterwork, intense contrast between pitch darkness and concentrated light',
        opticsDirective: 'tight theatrical focal framing, dramatic negative space',
        lightingDirective: 'single focused hard light source slicing through deep shadows, illuminating solemn facial expressions and hands',
        colorGrading: 'deep lampblack, rich cadmium red, and radiant golden amber'
    },
    {
        id: 'watercolor',
        label: 'Archival Watercolor',
        hint: 'Field Illustration & Natural Pigment',
        mediumDirective: 'delicate historical botanical and architectural watercolor on heavy cold-press cotton rag paper, translucent layered washes, organic pigment bleeding',
        opticsDirective: 'expressive painterly composition with soft deckled edges',
        lightingDirective: 'luminous translucent daylight radiating through pure watercolor layers',
        colorGrading: 'natural mineral pigments, raw sienna, cobalt blue, and burnt umber'
    }
];

export function getNanoBananaStyle(styleId?: string): NanoBananaStyle {
    return NANO_BANANA_STYLES.find(s => s.id === styleId) || NANO_BANANA_STYLES[1];
}

export const CAPTURE_HIGH_ERROR_TARGET = 0.5;
export const TILE_DRAIN_MAX_FRAMES = 120;
export const TILE_DRAIN_FRAME_MS = 50;
export const CAMERA_ALTITUDE_M = 250;
export const CAMERA_TILT_DEG = 45;

/**
 * What a 3D tiles render is, said plainly in every Beautify prompt: the image model was told it was a "photorealistic"
 * rendering and kept its melted shapes, or drew the place from memory instead. Calling it malformed photogrammetry asks it
 * to repair the surfaces it is given.
 */
export const TILES_RENDER_SUBJECT = 'malformed 3D photogrammetry render';
export const TILES_RENDER_NOTE = 'It is a mesh rebuilt automatically from aerial photographs: the shapes are roughly right but melted, warped and smeared, edges are rounded off, small parts are fused into blobs, and the texture is blurred and stretched.';

export type LocationMood = 'dawn' | 'golden-hour' | 'midday' | 'overcast' | 'dusk' | 'night';

export interface LocationCoordinates {
    lat: number;
    lng: number;
    elevationM?: number;
}

export interface LocationBeautifyContext {
    locationName: string;
    coordinates: LocationCoordinates;
    heading?: number;
    altitudeM?: number;
    aspectRatio?: string;
    eraContext?: string;
    stylePreset?: string;
    mood?: LocationMood;
    subjectDistance?: number;
    tileSnapshotBase64?: string;
}

const MOOD_LIGHTING_DIRECTIVES: Record<LocationMood, string> = {
    dawn: 'early dawn lighting, soft pink-orange sky on the horizon, first light of day, cool blue morning shadows',
    'golden-hour': 'golden hour illumination, warm amber sunlight raking across building facades, long dramatic shadows, rich warm architectural tones',
    midday: 'bright midday sunlight, crisp natural contrast, clear sky, neutral balanced daylight',
    overcast: 'overcast sky, diffuse soft daylight, muted colors, soft ambient bounce, grey clouds',
    dusk: 'dusk atmosphere, deep purple and orange twilight sky, fading ambient light, period street lamps beginning to glow',
    night: 'nighttime scene, dark atmospheric sky, warm lantern and torchlight glow from windows and streets, deep rich shadows'
};

export function googleEarthUrl(lat: number, lng: number, heading = 0, tilt = 45): string {
    return `https://earth.google.com/web/@${lat.toFixed(6)},${lng.toFixed(6)},0a,400d,35y,${Math.round(heading)}h,${Math.round(tilt)}t,0r`;
}

export interface GeodeticCoordinate {
    latitude: number;
    longitude: number;
    altitudeMeters: number;
    datum?: 'WGS-84' | 'EGM96';
}

export interface CameraPoseLock {
    headingDegrees: number;        // 0° to 360° (clockwise from True North)
    pitchDegrees: number;          // -90° (nadir) to +90° (zenith)
    rollDegrees?: number;          // Typically 0.0°
    standoffDistanceMeters: number;// Distance to primary focus landmark
    fieldOfViewDegrees?: number;   // Horizontal FOV (typically 60° - 75°)
    focalLengthMm?: number;        // Sensor equivalent (e.g., 35mm, 50mm)
}

export interface GeometricInvariants {
    foregroundStructure: string;   // e.g., "French Renaissance mansard dormer roof occluding left 35%"
    primaryLandmark: string;       // e.g., "The Plaza Hotel limestone facade and Pulitzer Fountain court"
    horizonLine?: string;          // e.g., "Upper third of frame, level at y = 0.32"
    backgroundSkyline?: string;    // e.g., "Existing 6th Avenue and 58th Street silhouettes; no new towers"
}

export interface SpatialEnvelopeLock {
    geodetic: GeodeticCoordinate;
    camera_pose: CameraPoseLock;
    cameraPose?: CameraPoseLock;
    geometric_invariants: GeometricInvariants;
    geometricInvariants?: GeometricInvariants;
    framing_rules: string[];
    framingRules?: string[];
    viewport_crop_lock?: {
        reference_tensor: string;
        aspect_ratio: string;
        enforcement_mode: string;
    };
    solar_ephemeris?: { azimuthDegrees: number; elevationDegrees: number };
    viewportCropLock?: {
        referenceTensor: string;
        aspectRatio: string;
        enforcementMode: string;
    };
}

/**
 * Generates the empirical double-bracket framing anchor to lock the viewport crop
 * against recency decay in the text-encoder attention layers.
 */
export function buildDoubleBracketFramingSuffix(aspectRatio: string = '16:9', imageRef: string = '@image1'): string {
    const clause = `CRITICAL FRAMING RULES: Output MUST use the ${aspectRatio} aspect ratio, matching the horizontal primary reference canvas, locked to ${imageRef} viewport crop.`;
    return `Style: ${clause} (${clause})`;
}

/**
 * Camera facts read straight off a survey station (see SurveySynthesisEngine / enrichStations).
 * When any of these are present the prompt gains a "Camera lock" clause and, with `solar`, a
 * "Sun" clause; otherwise the template output is byte-identical to the legacy form.
 */
export interface StationLockOptions {
    fovDegrees?: number;           // horizontal
    focalLengthMm?: number;
    pitchDegrees?: number;
    cameraHeightMeters?: number;
    horizonRowFraction?: number;   // 0 = top of frame
    solar?: { azimuthDegrees: number; elevationDegrees: number };
}

/** Builds the optional station lock clause (" Camera lock: ... Sun: ...") or "" when no station facts are given. */
export function buildStationLockHint(o: StationLockOptions): string {
    const hasLock = o.fovDegrees !== undefined || o.focalLengthMm !== undefined || o.pitchDegrees !== undefined || o.cameraHeightMeters !== undefined || o.horizonRowFraction !== undefined;
    let out = '';
    if (hasLock) {
        const parts: string[] = [];
        if (o.focalLengthMm !== undefined) parts.push(`${Number(o.focalLengthMm.toFixed(o.focalLengthMm % 1 ? 1 : 0))}mm lens`);
        if (o.fovDegrees !== undefined) parts.push(`${o.fovDegrees.toFixed(1)}° horizontal field of view`);
        if (o.pitchDegrees !== undefined) parts.push(`pitch ${o.pitchDegrees.toFixed(1)}°`);
        if (o.cameraHeightMeters !== undefined) parts.push(`${Number(o.cameraHeightMeters.toFixed(1))} m above ground`);
        out += ` Camera lock: ${parts.join(', ')}`;
        if (o.horizonRowFraction !== undefined) out += `; the horizon sits at ${Math.round(o.horizonRowFraction * 100)}% of the frame height from the top`;
        out += '.';
    }
    if (o.solar) {
        out += ` Sun: azimuth ${Math.round(o.solar.azimuthDegrees)}° clockwise from north, elevation ${Math.round(o.solar.elevationDegrees)}° above the horizon; cast shadows accordingly.`;
    }
    return out;
}

export interface HybridPromptPayload {
    spatial_envelope_lock: SpatialEnvelopeLock;
    rendering_instruction: string;
    generation_parameters: {
        aspect_ratio: string;
        input_references: string[];
        target_engine?: 'google-imagen-3' | 'google-omni-1.1' | 'google-veo';
    };
}

export interface BuildHybridPromptOptions extends StationLockOptions {
    locationName: string;
    coordinates: { lat: number; lng: number; altitudeM?: number };
    heading: number;
    pitch?: number;
    standoffDistanceM?: number;
    aspectRatio?: '16:9' | '9:16' | '1:1' | '4:3' | string;
    foregroundInvariant: string;
    primaryLandmarkInvariant: string;
    backgroundInvariant?: string;
    atmosphereNarrative: string;
    styleSuffix?: string;
    earthUrl?: string;
    targetEngine?: 'google-imagen-3' | 'google-omni-1.1' | 'google-veo';
    viewportCropLock?: boolean;
    imageRef?: string;
}

/**
 * Builds the complete HybridPromptPayload object conforming to the Hybrid Prompting Architecture.
 */
export function buildHybridPromptPayload(options: BuildHybridPromptOptions): HybridPromptPayload {
    const coordsStr = `${options.coordinates.lat.toFixed(6)}, ${options.coordinates.lng.toFixed(6)}`;
    const heading = Math.round(options.heading);
    const pitch = options.pitch !== undefined ? options.pitch : -20.0;
    const standoff = options.standoffDistanceM !== undefined ? Math.round(options.standoffDistanceM) : 180;
    const aspectRatio = options.aspectRatio || '16:9';
    const earthUrl = options.earthUrl || googleEarthUrl(options.coordinates.lat, options.coordinates.lng, heading, 45);

    const distanceHint = ` Subject distance: approximately ${standoff} meters from camera (use this for depth-of-field, focus, and aerial-perspective haze).`;
    const stationLockHint = buildStationLockHint(options);
    let styleSuffix = options.styleSuffix || '';
    if (options.viewportCropLock) {
        const doubleBracket = buildDoubleBracketFramingSuffix(aspectRatio, options.imageRef || '@image1');
        if (!styleSuffix.includes('@image1') && !styleSuffix.includes('CRITICAL FRAMING RULES')) {
            styleSuffix = styleSuffix ? `${styleSuffix} ${doubleBracket}` : ` ${doubleBracket}`;
        }
    }
    let atmosphere = options.atmosphereNarrative || '';
    if (atmosphere && !atmosphere.endsWith(' ')) {
        atmosphere += ' ';
    }

    const renderingInstruction =
        `Transform this ${TILES_RENDER_SUBJECT} of ${options.locationName} ` +
        `(camera at coordinates ${coordsStr}, facing ${heading}°) into a photorealistic photograph. ${TILES_RENDER_NOTE} ` +
        `Map reference: ${earthUrl}. ${atmosphere}` +
        `This is a real location — the reference image shows the actual 3D-rendered buildings, streets, and terrain at these exact coordinates. ` +
        `CRITICAL FRAMING RULES — non-negotiable: (1) Output MUST use exactly ${aspectRatio} aspect ratio, matching the reference image canvas. ` +
        `(2) Preserve the EXACT same camera angle, pitch, yaw, viewpoint, composition, focal length, and field of view as the reference. ` +
        `(3) Every building, street, and rooftop must stay in the same on-image position — do not pan, zoom, crop, recompose, or change the horizon line. ` +
        `(4) Do not invent or add buildings, landmarks, or features that are not visible in the reference. ` +
        `Add realistic textures, materials, atmospheric haze, natural lighting, and fine architectural detail to make this look like a real photograph taken from this exact vantage point.` +
        `${distanceHint}${stationLockHint}${styleSuffix}`;

    const cameraPose: CameraPoseLock = {
        headingDegrees: heading,
        pitchDegrees: pitch,
        standoffDistanceMeters: standoff,
        fieldOfViewDegrees: options.fovDegrees !== undefined ? options.fovDegrees : 65.0,
        ...(options.focalLengthMm !== undefined ? { focalLengthMm: options.focalLengthMm } : {})
    };

    const geometricInvariants: GeometricInvariants = {
        foregroundStructure: options.foregroundInvariant,
        primaryLandmark: options.primaryLandmarkInvariant,
        ...(options.horizonRowFraction !== undefined ? { horizonLine: `Level horizon at ${Math.round(options.horizonRowFraction * 100)}% of frame height from the top (y = ${options.horizonRowFraction.toFixed(2)})` } : {}),
        backgroundSkyline: options.backgroundInvariant || 'Preserve existing skyline silhouettes without adding unverified towers.'
    };

    const framingRules = [
        `RULE_1: Output MUST strictly match canvas aspect ratio (${aspectRatio})`,
        'RULE_2: Preserve exact camera angle, pitch, yaw, viewpoint, and composition',
        'RULE_3: Zero pan, zoom, crop, recomposition, or horizon shift',
        'RULE_4: Zero hallucination of buildings or removal of visible blockout geometry'
    ];

    return {
        spatial_envelope_lock: {
            geodetic: {
                latitude: Number(options.coordinates.lat.toFixed(6)),
                longitude: Number(options.coordinates.lng.toFixed(6)),
                altitudeMeters: options.coordinates.altitudeM || 85.0,
                datum: 'WGS-84'
            },
            camera_pose: cameraPose,
            cameraPose,
            geometric_invariants: geometricInvariants,
            geometricInvariants,
            framing_rules: framingRules,
            framingRules,
            ...(options.solar ? { solar_ephemeris: { azimuthDegrees: options.solar.azimuthDegrees, elevationDegrees: options.solar.elevationDegrees } } : {}),
            ...(options.viewportCropLock ? {
                viewport_crop_lock: {
                    reference_tensor: options.imageRef || '@image1',
                    aspect_ratio: aspectRatio,
                    enforcement_mode: 'double_bracket_tail_reinforcement'
                },
                viewportCropLock: {
                    referenceTensor: options.imageRef || '@image1',
                    aspectRatio: aspectRatio,
                    enforcementMode: 'double_bracket_tail_reinforcement'
                }
            } : {})
        },
        rendering_instruction: renderingInstruction,
        generation_parameters: {
            aspect_ratio: aspectRatio,
            input_references: ['<IMAGE_REF_0>'],
            target_engine: options.targetEngine || 'google-imagen-3'
        }
    };
}

/**
 * Builds the canonical serialized JSON string for the Hybrid Prompting Architecture.
 */
export function buildHybridBeautifyPrompt(options: BuildHybridPromptOptions): string {
    return JSON.stringify(buildHybridPromptPayload(options), null, 2);
}

export const buildHybridPrompt = buildHybridBeautifyPrompt;

export interface BeautifyPromptOptions extends StationLockOptions {
    locationName: string;
    coords?: string | { lat: number; lng: number };
    coordinates?: { lat: number; lng: number };
    heading?: number;
    earthUrl?: string;
    aspectRatio?: '16:9' | '9:16' | '1:1' | '4:3' | string;
    moodPromptContext?: string;
    distance?: number;
    subjectDistance?: number;
    subjectDistanceHint?: string;
    styleSuffix?: string;
    format?: 'prose' | 'hybrid';
    foregroundInvariant?: string;
    primaryLandmarkInvariant?: string;
    backgroundInvariant?: string;
    pitch?: number;
    viewportCropLock?: boolean;
    imageRef?: string;
}

/**
 * Builds the exact AI Beautify prompt template transforming a 3D tiles render (malformed photogrammetry) into a photorealistic photograph.
 *
 * Exact template:
 * Transform this malformed 3D photogrammetry render of {locationName} (camera at coordinates {coords}, facing {heading}°) into a photorealistic photograph. {TILES_RENDER_NOTE} Map reference: {earthUrl}. {moodPromptContext}This is a real location — the reference image shows the actual 3D-rendered buildings, streets, and terrain at these exact coordinates. CRITICAL FRAMING RULES — non-negotiable: (1) Output MUST use exactly {aspectRatio} aspect ratio, matching the reference image canvas. (2) Preserve the EXACT same camera angle, pitch, yaw, viewpoint, composition, focal length, and field of view as the reference. (3) Every building, street, and rooftop must stay in the same on-image position — do not pan, zoom, crop, recompose, or change the horizon line. (4) Do not invent or add buildings, landmarks, or features that are not visible in the reference. Add realistic textures, materials, atmospheric haze, natural lighting, and fine architectural detail to make this look like a real photograph taken from this exact vantage point.{subjectDistanceHint}{styleSuffix}
 *
 * When subject distance is available, {subjectDistanceHint} becomes:
 * " Subject distance: approximately {distance} meters from camera (use this for depth-of-field, focus, and aerial-perspective haze)."
 * Otherwise, it is empty.
 *
 * {styleSuffix} contains any selected style and related generation modifiers supplied by the caller verbatim.
 */
export interface ClayRenderBeautifyPromptOptions {
    /** What the render shows (an object, a mesh, a scene); named in the prompt, with no place, coordinates or heading. */
    subject: string;
    aspectRatio?: string;
    moodPromptContext?: string;
    subjectDistanceHint?: string;
    styleSuffix?: string;
}

/**
 * The AI Beautify template for a clay render that is not of a real place (a mesh render, an object, a scene with
 * no coordinates): the same non-negotiable framing rules as buildBeautifyPrompt, with no location, coordinates,
 * heading or map reference, so the model is never told a render is a photograph of somewhere. This is the one
 * template every generation path restyling such a render sends (the mesh render engine and the blockout
 * Nano Banana prompt both read it); buildBeautifyPrompt's own template is unchanged.
 */
export function buildClayRenderBeautifyPrompt(options: ClayRenderBeautifyPromptOptions): string {
    const aspectRatio = options.aspectRatio || '16:9';
    return `Transform this 3D clay rendering of ${options.subject} into a photorealistic photograph. ${options.moodPromptContext ? `${options.moodPromptContext.trimEnd()} ` : ''}CRITICAL FRAMING RULES — non-negotiable: (1) Output MUST use exactly ${aspectRatio} aspect ratio, matching the reference image canvas. (2) Preserve the EXACT same camera angle, pitch, yaw, viewpoint, composition, focal length, and field of view as the reference. (3) Every part of the subject must stay in the same on-image position — do not pan, zoom, crop, recompose, or change the horizon line. (4) Do not invent or add objects or features that are not visible in the reference. Add realistic textures, materials, natural lighting, and fine detail to make this look like a real photograph taken from this exact vantage point.${options.subjectDistanceHint || ''}${options.styleSuffix || ''}`;
}

export function buildBeautifyPrompt(options: BeautifyPromptOptions): string {
    const coordsStr = typeof options.coords === 'string'
        ? options.coords
        : (options.coords
            ? `${options.coords.lat.toFixed(6)}, ${options.coords.lng.toFixed(6)}`
            : (options.coordinates
                ? `${options.coordinates.lat.toFixed(6)}, ${options.coordinates.lng.toFixed(6)}`
                : '0.000000, 0.000000'));

    const heading = options.heading !== undefined ? Math.round(options.heading) : 0;

    let earthUrl = options.earthUrl;
    if (!earthUrl) {
        if (options.coordinates) {
            earthUrl = googleEarthUrl(options.coordinates.lat, options.coordinates.lng, heading, 45);
        } else if (options.coords && typeof options.coords !== 'string') {
            earthUrl = googleEarthUrl(options.coords.lat, options.coords.lng, heading, 45);
        } else {
            const match = coordsStr.match(/(-?\d+\.?\d*)\s*,\s*(-?\d+\.?\d*)/);
            if (match) {
                earthUrl = googleEarthUrl(parseFloat(match[1]), parseFloat(match[2]), heading, 45);
            } else {
                earthUrl = `https://earth.google.com/web/@${coordsStr.replace(/\s+/g, '')}`;
            }
        }
    }

    if (options.format === 'hybrid') {
        let lat = 0;
        let lng = 0;
        if (options.coordinates) {
            lat = options.coordinates.lat;
            lng = options.coordinates.lng;
        } else if (options.coords && typeof options.coords !== 'string') {
            lat = options.coords.lat;
            lng = options.coords.lng;
        } else if (typeof options.coords === 'string') {
            const m = options.coords.match(/(-?\d+\.?\d*)\s*,\s*(-?\d+\.?\d*)/);
            if (m) {
                lat = parseFloat(m[1]);
                lng = parseFloat(m[2]);
            }
        }
        return buildHybridBeautifyPrompt({
            locationName: options.locationName,
            coordinates: { lat, lng },
            heading,
            pitch: options.pitch,
            standoffDistanceM: options.distance !== undefined ? options.distance : options.subjectDistance,
            aspectRatio: options.aspectRatio,
            foregroundInvariant: options.foregroundInvariant || 'Non-negotiable foreground architectural geometry matching blockout frame.',
            primaryLandmarkInvariant: options.primaryLandmarkInvariant || `${options.locationName} structural massing and focal features.`,
            backgroundInvariant: options.backgroundInvariant,
            atmosphereNarrative: options.moodPromptContext || '',
            styleSuffix: options.styleSuffix,
            earthUrl,
            viewportCropLock: options.viewportCropLock,
            imageRef: options.imageRef,
            fovDegrees: options.fovDegrees,
            focalLengthMm: options.focalLengthMm,
            cameraHeightMeters: options.cameraHeightMeters,
            horizonRowFraction: options.horizonRowFraction,
            solar: options.solar
        });
    }

    const aspectRatio = options.aspectRatio || '16:9';

    let moodPromptContext = options.moodPromptContext !== undefined
        ? options.moodPromptContext
        : '';
    if (moodPromptContext && !moodPromptContext.endsWith(' ')) {
        moodPromptContext += ' ';
    }

    const dist = options.distance !== undefined ? options.distance : options.subjectDistance;
    let subjectDistanceHint = '';
    if (options.subjectDistanceHint !== undefined) {
        subjectDistanceHint = options.subjectDistanceHint;
    } else if (dist !== undefined && dist !== null) {
        subjectDistanceHint = ` Subject distance: approximately ${Math.round(dist)} meters from camera (use this for depth-of-field, focus, and aerial-perspective haze).`;
    }

    let styleSuffix = options.styleSuffix !== undefined
        ? options.styleSuffix
        : '';
    if (options.viewportCropLock) {
        const doubleBracket = buildDoubleBracketFramingSuffix(aspectRatio, options.imageRef || '@image1');
        if (!styleSuffix.includes('@image1') && !styleSuffix.includes('CRITICAL FRAMING RULES')) {
            styleSuffix = styleSuffix ? `${styleSuffix} ${doubleBracket}` : ` ${doubleBracket}`;
        }
    }

    // Optional station lock slot: "" unless station camera facts were supplied (template stays byte-identical otherwise)
    const stationLockHint = buildStationLockHint({
        fovDegrees: options.fovDegrees, focalLengthMm: options.focalLengthMm, pitchDegrees: options.pitch,
        cameraHeightMeters: options.cameraHeightMeters, horizonRowFraction: options.horizonRowFraction, solar: options.solar
    });

    return `Transform this ${TILES_RENDER_SUBJECT} of ${options.locationName} (camera at coordinates ${coordsStr}, facing ${heading}°) into a photorealistic photograph. ${TILES_RENDER_NOTE} Map reference: ${earthUrl}. ${moodPromptContext}This is a real location — the reference image shows the actual 3D-rendered buildings, streets, and terrain at these exact coordinates. CRITICAL FRAMING RULES — non-negotiable: (1) Output MUST use exactly ${aspectRatio} aspect ratio, matching the reference image canvas. (2) Preserve the EXACT same camera angle, pitch, yaw, viewpoint, composition, focal length, and field of view as the reference. (3) Every building, street, and rooftop must stay in the same on-image position — do not pan, zoom, crop, recompose, or change the horizon line. (4) Do not invent or add buildings, landmarks, or features that are not visible in the reference. Add realistic textures, materials, atmospheric haze, natural lighting, and fine architectural detail to make this look like a real photograph taken from this exact vantage point.${subjectDistanceHint}${stationLockHint}${styleSuffix}`;
}

/** Identifies the texture-plate prompt wording (recorded with every texel it produced). */
export const TEXTURE_PLATE_PROMPT_ID = 'texture-plate/v1';
/** The same prompt with a street-level photograph of the wall as an extra reference (TexturePlatePromptOptions.withStreetView). */
export const TEXTURE_PLATE_STREET_VIEW_PROMPT_ID = 'texture-plate/v1+street-view';
/**
 * The variant for a wall the scan hardly sees (TexturePlatePromptOptions.unseen): its flat mid-grey areas are this same wall
 * hidden from the scan (behind trees, against a neighbour), drawn as the wall continues instead of kept grey.
 */
export const TEXTURE_PLATE_UNSEEN_PROMPT_ID = 'texture-plate/v1+unseen';

export interface TexturePlatePromptOptions {
    locationName: string;
    /** The wall's size in metres (the plate's extent). */
    widthM: number;
    heightM: number;
    /** The plate's pixel size, which the answer must keep. */
    widthPx: number;
    heightPx: number;
    /**
     * The "change nothing else" wording the caller has measured to work (the de-light study's winning sentences, e.g. its
     * keep-every-edge and same-framing sentences); appended verbatim.
     */
    preserveClause: string;
    /** True when a second image (the adjacent wall, already finished) is sent as the reference. */
    withReference?: boolean;
    /**
     * True when a street-level photograph of the same wall follows (after the reference, when there is one), resampled onto
     * the plate's frame: it shows what the lower part of the facade actually looks like; the model follows it for real
     * details and keeps the first image's geometry.
     */
    withStreetView?: boolean;
    /**
     * True for a wall the scan hardly sees: its flat mid-grey areas are not outside the wall but parts of it the scan could
     * not see; the model draws them as the same wall continuing (materials and rhythm from the visible parts and the
     * reference), with nothing that no image shows (no signs, lettering or features).
     */
    unseen?: boolean;
}

/**
 * The AI Beautify prompt's texture-plate variant: the same non-negotiable framing rules as buildBeautifyPrompt, for a flat,
 * straight-on elevation of one facade (a texture plate) instead of a perspective rendering, with even overcast light and
 * no photographic effects. buildBeautifyPrompt's own template is unchanged.
 */
export function buildTexturePlatePrompt(o: TexturePlatePromptOptions): string {
    return `Transform this orthographic texture plate of one wall of ${o.locationName} (a flat, straight-on elevation of the facade, ${o.widthM.toFixed(1)} m wide and ${o.heightM.toFixed(1)} m tall, resampled from a photorealistic 3D tiles scan) into a clean, photorealistic texture plate of the same facade. CRITICAL RULES — non-negotiable: (1) It stays a flat orthographic elevation: no perspective change, no camera tilt, no depth of field, no haze. (2) Keep every window, door, edge and opening exactly where it is, at the same size. ${o.preserveClause} ${o.unseen ? '(3) The flat mid-grey areas are parts of this same wall that the scan could not see (hidden behind trees or against a neighbour): fill every one of them as this wall continues, with the same materials, colours, storey lines and window rhythm as the visible parts of the plate and the reference image; keep what the plate does show where it is; do not add signs, lettering, ornament or any feature that no image shows, and leave nothing mid-grey.' : '(3) Do not invent or add windows, doors, signs, ornament or features that are not visible in the plate; flat mid-grey areas are outside the scan and stay flat mid-grey.'} (4) Give it crisp, realistic materials and architectural detail: the brick, stone, mortar joints, cornices, window frames and glazing that the plate shows, sharp and free of scan blur and smears. (5) Light it evenly, as under a bright overcast sky: diffuse light, no cast shadows, no sun hot spots. Answer with the full plate at ${o.widthPx} x ${o.heightPx} px.${o.withReference ? ' The second image is the adjacent wall of the same building, already finished: match its materials, colours and level of detail across the corner, but take every window, edge and opening from the first image only.' : ''}${o.withStreetView ? ` The ${o.withReference ? 'third' : 'second'} image is a street-level photograph of this same wall, resampled onto the first image's frame (same size and position; grey where the photograph does not show the wall): it shows what the lower part of this facade actually looks like. Follow it for the real details there (materials, openings, what is and is not at street level), and do not draw anything at street level that the photograph does not show; keep the geometry of the first image: every window, edge and opening stays where the first image has it, at the same size.` : ''}`;
}

export interface StationBeautifyContext {
    locationName: string;
    moodPromptContext?: string;
    styleSuffix?: string;
    format?: 'prose' | 'hybrid';
    aspectRatio?: string;
    viewportCropLock?: boolean;
    imageRef?: string;
}

/**
 * The canonical AI Beautify prompt for a survey station: every camera fact (coordinates, yaw,
 * pitch, fov, lens, height, horizon, standoff, sun) is read from the station record so the prompt,
 * the blockout render and the depth-to-splat unprojection share one pose.
 */
/** The station template's closing detail ask: on a chained station it is replaced by CHAINED_STATION_STYLE_LOCK. */
export const STATION_DETAIL_SENTENCE = 'Add realistic textures, materials, atmospheric haze, natural lighting, and fine architectural detail to make this look like a real photograph taken from this exact vantage point.';

/**
 * A chained station's look comes from the previous accepted photograph (the second image, re-projected into this view),
 * not from new detail of the model's own: said in place of STATION_DETAIL_SENTENCE.
 */
export const CHAINED_STATION_STYLE_LOCK = 'Style and subject lock: the second image is the previous photograph of this same place, taken from a neighbouring vantage point and re-projected into this view. Take every texture, material, colour, weathering detail, light and the look of the subject from it, and add no texture or detail of your own: where the second image covers the frame, show exactly what it shows, in the first image\'s geometry; only the regions marked white in the third image (mask) are new, and they continue the second image\'s style, as another frame of the same photograph.';

/**
 * What a Street View seed prompt clears from the photograph (said right after "with no obstructions"): street furniture
 * whole, from foot to lamp head, and every other building nearer the camera than the subject, so the one building left in
 * front of the camera is the subject the chain is about. The subject's own fixtures stay.
 */
export function streetViewObstructionsNote(subject: string): string {
    return `The subject is ${subject}. Obstructions are everything standing between the camera and the subject: street lamps whole (the pole, the arm and the lamp head, wherever the head hangs), traffic lights, signs on posts, wires, trees, vehicles, people, scaffolding and sidewalk sheds, and every other building nearer the camera than the subject, including a building at the edge of the frame. Remove them all: where a nearer building stood, show the open street, sidewalk and sky beyond it and the subject continuing behind it. Keep the subject's own fire escapes, shop fronts, awnings and lettering. Each facade continues as it does where nothing covers it.`;
}

/**
 * The AI Beautify prompt for the first image of a chain when that image is a real Street View photograph, not a tile
 * render: the station prompt (buildStationBeautifyPrompt) with the subject said as what it is, obstructions cleared, and
 * the reference described as the Street View capture. Every camera fact (coordinates, heading, pitch, field of view, eye
 * height, aspect) comes from the station the photograph was registered to, so it holds for whatever angle Street View caught.
 */
export function buildStreetViewSeedBeautifyPrompt(station: ColmapCameraPose, ctx: StationBeautifyContext): string {
    const base = buildStationBeautifyPrompt(station, { ...ctx, format: 'prose' });
    const swaps: Array<[string, string]> = [
        [`Transform this ${TILES_RENDER_SUBJECT} of`, 'Transform this Street View photograph of'],
        [`into a photorealistic photograph. ${TILES_RENDER_NOTE}`, `into a photorealistic photograph WITH NO OBSTRUCTIONS. ${streetViewObstructionsNote(ctx.locationName)}`],
        ['the reference image shows the actual 3D-rendered buildings, streets, and terrain at these exact coordinates.', 'the reference image shows the actual buildings, streets, and terrain at these exact coordinates as Street View captured them.'],
        // the template's "every building stays" would forbid clearing a nearer building, so only the kept ones stay put
        ['(3) Every building, street, and rooftop must stay in the same on-image position', '(3) The subject, the streets and every building you keep must stay in the same on-image position']
    ];
    let out = base;
    for (const [from, to] of swaps) {
        if (!out.includes(from)) throw new Error(`buildStreetViewSeedBeautifyPrompt: the station template no longer contains "${from.slice(0, 60)}"`);
        out = out.replace(from, to);
    }
    return out;
}

export function buildStationBeautifyPrompt(station: ColmapCameraPose, ctx: StationBeautifyContext): string {
    const m = station.beautify;
    const aspect = station.aspectRatio ? aspectRatioLabel(station.aspectRatio) : '16:9';
    return buildBeautifyPrompt({
        locationName: ctx.locationName,
        coordinates: { lat: station.coordinatesWGS84.lat, lng: station.coordinatesWGS84.lng },
        heading: station.yawDegrees,
        pitch: station.pitchDegrees,
        aspectRatio: ctx.aspectRatio || aspect,
        moodPromptContext: ctx.moodPromptContext,
        distance: m?.standoffMeters,
        styleSuffix: ctx.styleSuffix,
        format: ctx.format,
        viewportCropLock: ctx.viewportCropLock,
        imageRef: ctx.imageRef,
        fovDegrees: station.fovDegrees,
        focalLengthMm: station.focalLengthMm,
        cameraHeightMeters: station.cameraHeightAboveGround,
        horizonRowFraction: m?.horizonRowFraction,
        solar: m?.solar ? { azimuthDegrees: m.solar.azimuthDegrees, elevationDegrees: m.solar.elevationDegrees } : undefined
    });
}

function aspectRatioLabel(r: number): string {
    const known: Array<[number, string]> = [[16 / 9, '16:9'], [9 / 16, '9:16'], [1, '1:1'], [4 / 3, '4:3'], [3 / 2, '3:2'], [21 / 9, '21:9']];
    for (const [v, label] of known) if (Math.abs(v - r) < 0.01) return label;
    return `${r.toFixed(3)}:1`;
}

/**
 * Build the AI Beautify instruction prompt: transform the 3D tile rendering into an era-accurate photorealistic image.
 */
export function buildLocationBeautifyPrompt(ctx: LocationBeautifyContext): string {
    const coordsStr = `${ctx.coordinates.lat.toFixed(6)}, ${ctx.coordinates.lng.toFixed(6)}`;
    const heading = ctx.heading !== undefined ? Math.round(ctx.heading) : 0;
    const earthUrl = googleEarthUrl(ctx.coordinates.lat, ctx.coordinates.lng, heading, 45);
    const aspectRatio = ctx.aspectRatio || '16:9';

    const styleObj = NANO_BANANA_STYLES.find(s => s.id === ctx.stylePreset) || NANO_BANANA_STYLES[1]; // default cinematic film
    const styleDirective = `${styleObj.mediumDirective}. ${styleObj.opticsDirective}. ${styleObj.colorGrading}`;

    const moodKey = ctx.mood || 'golden-hour';
    const moodDirective = MOOD_LIGHTING_DIRECTIVES[moodKey] || MOOD_LIGHTING_DIRECTIVES['golden-hour'];

    const subjectDistanceHint = ctx.subjectDistance
        ? ` Subject distance: approximately ${Math.round(ctx.subjectDistance)} meters from camera (apply natural depth-of-field, focus falloff, and aerial-perspective haze).`
        : '';

    const eraDirective = ctx.eraContext ? ` Era and period styling: ${ctx.eraContext}.` : '';

    return `Transform this ${TILES_RENDER_SUBJECT} of ${ctx.locationName} (camera at coordinates ${coordsStr}, facing ${heading}°) into a photorealistic photograph. ${TILES_RENDER_NOTE} Map reference: ${earthUrl}. ${moodDirective}. ${styleDirective}.${eraDirective} This is a real location — the reference image shows the actual 3D-rendered buildings, streets, and terrain at these exact coordinates. CRITICAL FRAMING RULES — non-negotiable: (1) Output MUST use exactly ${aspectRatio} aspect ratio, matching the reference image canvas. (2) Preserve the EXACT same camera angle, pitch, yaw, viewpoint, composition, focal length, and field of view as the reference. (3) Every building, street, and rooftop must stay in the same on-image position — do not pan, zoom, crop, recompose, or change the horizon line. (4) Do not invent or add buildings, landmarks, or features that are not visible in the reference. Add realistic textures, materials, atmospheric haze, natural lighting, and fine architectural detail to make this look like a real photograph taken from this exact vantage point.${subjectDistanceHint} No map insets, compass overlays, mini-maps, navigation UI, coordinate labels, or any graphical overlays — clean photograph only.`;
}

export interface BeautifySectionOptions {
    styleId?: string;
    eraOverride?: string;
    docTitle?: string;
    mood?: LocationMood;
}

/**
 * Mutate a document location-image section with beautified era styling and enriched metadata.
 */
export function beautifyLocationSection(
    section: MarkdownSection,
    options: BeautifySectionOptions = {}
): MarkdownSection {
    // The place, era and style are only what the section and caller give: no keyword table maps words to a place,
    // coordinates or period, and a section without coordinates keeps its prompt instead of getting invented ones.
    const coordinates = section.coordinates && Number.isFinite(section.coordinates.lat) && Number.isFinite(section.coordinates.lng)
        ? section.coordinates
        : undefined;
    const locContext = {
        locationName: section.locationName || options.docTitle || 'the location',
        theme: detectDocumentTheme(section.locationName || '', options.docTitle)
    };

    const eraContext = options.eraOverride || '';
    const styleId = options.styleId || 'cinematic-film';
    const styleObj = getNanoBananaStyle(styleId);

    const beautifyPrompt = coordinates
        ? buildLocationBeautifyPrompt({
            locationName: locContext.locationName,
            coordinates: { lat: coordinates.lat, lng: coordinates.lng },
            ...(typeof (coordinates as any).heading === 'number' ? { heading: (coordinates as any).heading } : {}),
            aspectRatio: '16:9',
            eraContext,
            stylePreset: styleId,
            mood: options.mood || 'golden-hour'
        })
        : section.visualPrompt;

    // The restyle prompt only: the section keeps its own image, credit and date tag until a generation replaces
    // them (no catalog image is swapped in and credited to a model, and no era label is made up for the place).
    return {
        ...section,
        type: 'location-image',
        locationName: section.locationName || locContext.locationName,
        stylePreset: styleObj.label,
        visualPrompt: beautifyPrompt
    };
}
