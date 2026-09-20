/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { MarkdownSection } from '../canvas-types';
import { DocumentTheme, detectDocumentTheme } from '../document-synthesis-engine';
import { lookupCuratedNanoBananaImage } from '../nano-banana-service';
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

export type LocationMood = 'dawn' | 'golden-hour' | 'midday' | 'overcast' | 'dusk' | 'night';

export interface LocationCoordinates {
    lat: number;
    lng: number;
    elevationM?: number;
}

export interface ExtractedLocationEra {
    locationName: string;
    coordinates: LocationCoordinates;
    heading: number;
    altitudeM: number;
    eraContext: string;
    theme: DocumentTheme;
    stylePreset: string;
    visualPrompt: string;
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

/**
 * Extract key location coordinates, camera vantage, and historical era directives from paper text.
 */
export function extractLocationAndEraFromContext(prompt: string, title?: string): ExtractedLocationEra {
    const combined = `${prompt} ${title || ''}`.toLowerCase();
    const theme = detectDocumentTheme(prompt, title);

    if (theme === '1776-revolution' || combined.includes('1776') || combined.includes('declaration of independence') || combined.includes('continental congress') || combined.includes('philadelphia')) {
        return {
            locationName: 'Independence Hall (Pennsylvania State House), Philadelphia',
            coordinates: { lat: 39.9489, lng: -75.1500, elevationM: 12 },
            heading: 45,
            altitudeM: 220,
            eraContext: 'July 1776 American Revolutionary period, Georgian colonial red brick architecture, white cupola tower, cobblestone Chestnut Street, horse-drawn carriages, iron railings, gas lamps, no modern vehicles, no asphalt, no electric wires, no antennas, no modern buildings in background',
            theme: '1776-revolution',
            stylePreset: 'oil-painting',
            visualPrompt: 'Authentic 1776 Georgian colonial red brick facade of Independence Hall Philadelphia with white wooden clock tower, cobblestone street, and Revolutionary era citizens in period attire.'
        };
    }

    if (combined.includes('rome') || combined.includes('colosseum') || combined.includes('gladiator') || combined.includes('roman')) {
        return {
            locationName: 'The Flavian Amphitheatre (Colosseum), Rome',
            coordinates: { lat: 41.8902, lng: 12.4922, elevationM: 24 },
            heading: 30,
            altitudeM: 280,
            eraContext: 'Roman Empire antiquity (80 AD), pristine complete travertine marble multi-tier arcade facades, imperial Roman velvet banners, paved Roman stone roads, toga-clad citizens and Roman legionaries, no modern asphalt, no motor vehicles, no modern tourists, no steel scaffolding',
            theme: 'history-antiquity' as DocumentTheme,
            stylePreset: 'oil-painting',
            visualPrompt: 'Imperial Rome 80 AD, the Colosseum in complete pristine travertine glory under golden Mediterranean sunlight with Roman banners.'
        };
    }

    if (combined.includes('1920') || combined.includes('art deco') || combined.includes('chrysler') || combined.includes('roaring twenties')) {
        return {
            locationName: 'Chrysler Building & 42nd Street, Manhattan',
            coordinates: { lat: 40.7516, lng: -73.9755, elevationM: 30 },
            heading: 60,
            altitudeM: 350,
            eraContext: '1920s Roaring Twenties Art Deco era, newly constructed gleaming stainless steel sunburst spire, vintage 1920s Ford Model T and Duesenberg automobiles on rainy asphalt, steam rising from manholes, pedestrians in tailored wool overcoats and fedoras, no modern neon, no modern plastic or digital screens',
            theme: 'general-architecture',
            stylePreset: 'cinematic-film',
            visualPrompt: '1920s Manhattan Art Deco skyscraper streetscape with vintage automobiles and classic period fedoras under dramatic film lighting.'
        };
    }

    if (theme === 'auth-zerotrust-security' || combined.includes('security') || combined.includes('data center') || combined.includes('zero trust')) {
        return {
            locationName: 'Edge Data Center Corridor & Fiber Infrastructure, Ashburn VA',
            coordinates: { lat: 39.0438, lng: -77.4874, elevationM: 85 },
            heading: 90,
            altitudeM: 300,
            eraContext: 'contemporary ultra-secure cloud datacenter, reinforced architectural glass and dark titanium panels, biometric security perimeters, fiber optic conduits, subterranean power cooling grids, pristine modern industrial engineering',
            theme: 'auth-zerotrust-security',
            stylePreset: 'architectural',
            visualPrompt: 'High-security modern enterprise cloud datacenter campus with glass facades and illuminated fiber network topology.'
        };
    }

    if (combined.includes('tokyo') || combined.includes('shibuya') || combined.includes('shinjuku') || combined.includes('cyberpunk')) {
        return {
            locationName: 'Shinjuku & Shibuya Urban Architecture, Tokyo',
            coordinates: { lat: 35.6595, lng: 139.7005, elevationM: 35 },
            heading: 120,
            altitudeM: 400,
            eraContext: 'modern Tokyo high-density metropolis, pristine architectural glass and steel skyscrapers, elevated transit lines, clean urban street grid with illuminated architectural lighting',
            theme: 'general-architecture',
            stylePreset: 'modern-editorial',
            visualPrompt: 'Vibrant modern Tokyo architectural skyline with high-density glass towers and streamlined transit arteries.'
        };
    }

    if (combined.includes('san francisco') || combined.includes('sf') || combined.includes('coit tower') || combined.includes('ferry building') || combined.includes('salesforce')) {
        return {
            locationName: 'San Francisco Financial District & Embarcadero',
            coordinates: { lat: 37.7900, lng: -122.4000, elevationM: 15 },
            heading: 45,
            altitudeM: 350,
            eraContext: 'contemporary San Francisco bay coastal architecture, steep hill grids, historic waterfront piers juxtaposed against modern high-rise architecture under golden bay sunlight',
            theme: 'general-architecture',
            stylePreset: 'modern-editorial',
            visualPrompt: 'San Francisco architectural skyline and waterfront Embarcadero under coastal California golden hour light.'
        };
    }

    // Generic architectural default
    return {
        locationName: title || 'Executive Architectural Landmark',
        coordinates: { lat: 37.7749, lng: -122.4194, elevationM: 20 },
        heading: 0,
        altitudeM: 250,
        eraContext: 'contemporary architectural presentation, clean geometric lines, natural material textures, authentic daylighting and atmospheric perspective',
        theme: 'general-architecture',
        stylePreset: 'modern-editorial',
        visualPrompt: `Authentic architectural photograph of ${title || 'the location'} with realistic textures and refined daylighting.`
    };
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
        `Transform this photorealistic 3D tiles rendering of ${options.locationName} ` +
        `(camera at coordinates ${coordsStr}, facing ${heading}°) into a photorealistic photograph. ` +
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
 * Builds the exact AI Beautify prompt template transforming a 3D tiles rendering into a photorealistic photograph.
 *
 * Exact template:
 * Transform this photorealistic 3D tiles rendering of {locationName} (camera at coordinates {coords}, facing {heading}°) into a photorealistic photograph. Map reference: {earthUrl}. {moodPromptContext}This is a real location — the reference image shows the actual 3D-rendered buildings, streets, and terrain at these exact coordinates. CRITICAL FRAMING RULES — non-negotiable: (1) Output MUST use exactly {aspectRatio} aspect ratio, matching the reference image canvas. (2) Preserve the EXACT same camera angle, pitch, yaw, viewpoint, composition, focal length, and field of view as the reference. (3) Every building, street, and rooftop must stay in the same on-image position — do not pan, zoom, crop, recompose, or change the horizon line. (4) Do not invent or add buildings, landmarks, or features that are not visible in the reference. Add realistic textures, materials, atmospheric haze, natural lighting, and fine architectural detail to make this look like a real photograph taken from this exact vantage point.{subjectDistanceHint}{styleSuffix}
 *
 * When subject distance is available, {subjectDistanceHint} becomes:
 * " Subject distance: approximately {distance} meters from camera (use this for depth-of-field, focus, and aerial-perspective haze)."
 * Otherwise, it is empty.
 *
 * {styleSuffix} contains any selected style and related generation modifiers supplied by the caller verbatim.
 */
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

    return `Transform this photorealistic 3D tiles rendering of ${options.locationName} (camera at coordinates ${coordsStr}, facing ${heading}°) into a photorealistic photograph. Map reference: ${earthUrl}. ${moodPromptContext}This is a real location — the reference image shows the actual 3D-rendered buildings, streets, and terrain at these exact coordinates. CRITICAL FRAMING RULES — non-negotiable: (1) Output MUST use exactly ${aspectRatio} aspect ratio, matching the reference image canvas. (2) Preserve the EXACT same camera angle, pitch, yaw, viewpoint, composition, focal length, and field of view as the reference. (3) Every building, street, and rooftop must stay in the same on-image position — do not pan, zoom, crop, recompose, or change the horizon line. (4) Do not invent or add buildings, landmarks, or features that are not visible in the reference. Add realistic textures, materials, atmospheric haze, natural lighting, and fine architectural detail to make this look like a real photograph taken from this exact vantage point.${subjectDistanceHint}${stationLockHint}${styleSuffix}`;
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

    return `Transform this photorealistic 3D tiles rendering of ${ctx.locationName} (camera at coordinates ${coordsStr}, facing ${heading}°) into a photorealistic photograph. Map reference: ${earthUrl}. ${moodDirective}. ${styleDirective}.${eraDirective} This is a real location — the reference image shows the actual 3D-rendered buildings, streets, and terrain at these exact coordinates. CRITICAL FRAMING RULES — non-negotiable: (1) Output MUST use exactly ${aspectRatio} aspect ratio, matching the reference image canvas. (2) Preserve the EXACT same camera angle, pitch, yaw, viewpoint, composition, focal length, and field of view as the reference. (3) Every building, street, and rooftop must stay in the same on-image position — do not pan, zoom, crop, recompose, or change the horizon line. (4) Do not invent or add buildings, landmarks, or features that are not visible in the reference. Add realistic textures, materials, atmospheric haze, natural lighting, and fine architectural detail to make this look like a real photograph taken from this exact vantage point.${subjectDistanceHint} No map insets, compass overlays, mini-maps, navigation UI, coordinate labels, or any graphical overlays — clean photograph only.`;
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
    const lat = section.coordinates?.lat || 39.9489;
    const lng = section.coordinates?.lng || -75.1500;
    const heading = (section.coordinates as any)?.heading || 45;

    const locContext = extractLocationAndEraFromContext(
        `${section.locationName || ''} ${options.docTitle || ''} ${options.eraOverride || ''}`
    );

    const eraContext = options.eraOverride || locContext.eraContext;
    const styleId = options.styleId || locContext.stylePreset || 'cinematic-film';
    const styleObj = getNanoBananaStyle(styleId);

    const beautifyPrompt = buildLocationBeautifyPrompt({
        locationName: section.locationName || locContext.locationName,
        coordinates: { lat, lng },
        heading,
        aspectRatio: '16:9',
        eraContext,
        stylePreset: styleId,
        mood: options.mood || 'golden-hour'
    });

    const curated = lookupCuratedNanoBananaImage(locContext.theme, section.locationName || options.docTitle, styleId);

    const attribution = curated.attribution
        ? (curated.attribution.includes('Nano Banana') ? curated.attribution : `${curated.attribution} • Nano Banana Pro`)
        : `Photorealistic 3D Tile Beautify • ${locContext.locationName} • Nano Banana Pro`;

    return {
        ...section,
        type: 'location-image',
        locationName: section.locationName || locContext.locationName,
        imageUrl: curated.url || section.imageUrl,
        thumbnailUrl: curated.url || section.imageUrl,
        stylePreset: styleObj.label,
        visualPrompt: beautifyPrompt,
        attribution,
        dateTag: curated.dateTag || (eraContext.includes('1776') ? 'Colonial Era • 1776' : 'Historical Landmark'),
        caption: curated.caption || section.caption || `High-fidelity architectural reconstruction of ${section.locationName || locContext.locationName} with authentic historical textures.`
    };
}
