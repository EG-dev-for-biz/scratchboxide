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
        colorGrading: 'deep obsidian slate backdrop with glowing electric cyan, vivid ultraviolet, and radiant magenta data streams'
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
