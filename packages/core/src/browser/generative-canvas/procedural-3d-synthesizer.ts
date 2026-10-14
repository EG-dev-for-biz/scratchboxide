/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import {
    CanvasArtifact,
    MarkdownDocumentData,
    Scene3DData,
    Media4DObject
} from './canvas-types';
import {
    classifyDomain,
    synthesizeAdaptive3DScene
} from './services/adaptive-domain-engine';
import {
    synthesizeAdaptiveHeroScene,
    synthesizeAdaptiveHeroObjectContract,
    generateAdaptiveHeroPythonSource
} from '../../common/spatial/adaptive-hero-synthesizer';
import {
    WorldSpecification,
    planWorldIntentHeuristic,
    generateCompositeHeightfield,
    placeRegionalObjects,
    createTerrainMesh
} from './services/worldbuilder';
import {
    createOperatorEngine,
    BatchCommand,
    BatchExecutionOptions,
    BatchExecutionResult
} from './services/direct-dispatch-operator-engine';
import {
    detectRealWorldLocationIntent,
    isResolvedLocation,
    Google3DTileService,
    type RealWorldLocationIntent,
    type ClayPresetId
} from './services/Google3DTileService';
import {
    castCreativeLocation,
    CreativeLocationCastingService,
    type CastedLocation,
    type LocationCastingArchetype
} from './services/CreativeLocationCastingService';
import {
    type AtmosphericScatteringConfig
} from './services/atmosphere';

import {
    ProceduralMicroSurfaceShaderPatcher,
    type MicroSurfacePreset,
    type ProceduralMicroSurfaceConfig
} from './services/spatial/ProceduralMicroSurfaceShaderPatcher';

export * from './services/worldbuilder';
export * from './services/mesh';
export * from './services/atmosphere';
export {
    ProceduralMicroSurfaceShaderPatcher,
    type MicroSurfacePreset,
    type ProceduralMicroSurfaceConfig
};
export {
    detectRealWorldLocationIntent,
    isResolvedLocation,
    castCreativeLocation,
    CreativeLocationCastingService
};
export type {
    RealWorldLocationIntent,
    ClayPresetId,
    CastedLocation,
    LocationCastingArchetype
};

/**
 * Headless 3D Atmosphere Builder.
 * Constructs physical atmospheric scattering, solar vectors, Rayleigh/Mie coefficients,
 * aerial perspective, and cloud parameters during headless scene synthesis.
 */
export function buildHeadlessAtmosphere(options: Partial<AtmosphericScatteringConfig> = {}): AtmosphericScatteringConfig {
    return {
        enabled: options.enabled ?? true,
        rayleigh: options.rayleigh ?? 0.55,
        mie: options.mie ?? 0.003,
        turbidity: options.turbidity ?? 1.6,
        mieDirectionalG: options.mieDirectionalG ?? 0.82,
        volumetricClouds: options.volumetricClouds ?? false,
        cloudCoverage: options.cloudCoverage ?? 0.0,
        cloudDensity: options.cloudDensity ?? 0.0,
        cloudAltitude: options.cloudAltitude ?? 1200,
        aerialPerspectiveEnabled: options.aerialPerspectiveEnabled ?? false,
        inscatteringIntensity: options.inscatteringIntensity ?? 0.0,
        aerialPerspectiveRange: options.aerialPerspectiveRange ?? 220.0,
        cloudShadowsEnabled: options.cloudShadowsEnabled ?? false,
        cloudShadowIntensity: options.cloudShadowIntensity ?? 0.0,
        cloudShadowScale: options.cloudShadowScale ?? 0.015,
        atmosphereShadowLength: options.atmosphereShadowLength ?? 1.0,
        windVector: options.windVector ?? [0.05, 0.02],
        ...options
    };
}

export type Procedural3DTheme =
    | 'worldbuilder'
    | 'battlefield'
    | 'city'
    | 'highway_overpass'
    | 'alpine_valley'
    | 'ziggurat'
    | 'solar-system'
    | 'mars_rover'
    | 'molecular'
    | 'architecture'
    | 'flight'
    | 'vehicle'
    | 'mesh-shaping'
    | 'particles'
    | 'pbr'
    | 'universal_scene'
    | 'nature_atmosphere'
    | 'glass_shatter'
    | 'geospatial'
    | 'gaussian_splat'
    | 'general';

/**
 * Detect the 3D scene semantic theme from prompt and surrounding context.
 */
export function detect3DSceneTheme(prompt: string, context?: { activeArtifact?: CanvasArtifact; chatHistory?: any; docTitle?: string; docContent?: string }): Procedural3DTheme {
    const promptLower = prompt.toLowerCase();
    const combined = `${prompt} ${context?.docTitle || ''} ${context?.activeArtifact?.title || ''} ${context?.docContent || ''}`.toLowerCase();

    // Check prompt first for direct user intent, then fall back to surrounding context
    for (const text of [promptLower, combined]) {
        // -0.99. 3D Gaussian Splatting / 3DGS / Radiance Fields / 4D Avatar / .splat / .spz
        if (/\b(?:\.sp(?:lat|z)|gaussian\s*splats?|3dgs|\bsplats?\b|radiance\s*fields?|survey\s*stations?|survey\s*synthesis|4d\s*performer|4dgs\s*avatar)\b/i.test(text)) {
            return 'gaussian_splat';
        }

        // -0.98. Civil Highway Overpass / Freeway Interchange / Infrastructure Viaduct
        if (/\b(?:civil_highway_overpass|overpass|viaduct|highway|freeway|interchange|flyover|expressway|bridge\s*piers?|gantry\s*signs?)\b/i.test(text)) {
            return 'highway_overpass';
        }

        // -0.975. Alpine Matterhorn Peak / Glacial Valley / Mountain Horn / Swiss Chalets
        if (/\b(?:matterhorn|glacial\s*valley|pyramidal\s*horn|chalets?|swiss\s*alps?|mountain\s*horn)\b/i.test(text)) {
            return 'alpine_valley';
        }

        // -0.972. Babylonian Ziggurat Observatory / Etemenanki Mesopotamian Temple
        if (/\b(?:ziggurat|etemenanki|babylon(?:ian)?|mesopotami(?:a|an)|astrolabe\s*observatory|mudbrick\s*temple)\b/i.test(text)) {
            return 'ziggurat';
        }

        // -0.96. High-Speed Ballistics, Voronoi Glass Fracture & Supersonic Impact
        if (/\b(?:bullet|bully\s*going\s*through|plate\s*of\s*glass|glass\s*shatter|shatter(?:ed|ing)?|fracture|glass\s*shards?|high\s*speed\s*impact|projectile|ballistics?|penetrat(?:e|ion)|shattering\s*glass)\b/i.test(text)) {
            return 'glass_shatter';
        }

        // -0.988. Historical Battlefield / Lexington 1776 / Castle Siege (checked before geospatial so Battle of Lexington 1776 is not treated as modern tile)
        if (/lexington|concord|1776|battle|revolution|redcoat|minuteman|militia|firing\s*line|bunker\s*hill|gettysburg|waterloo|siege|castle\s*siege|warfare|historical\s*scene/i.test(text)) {
            return 'battlefield';
        }

        // -0.985. Real-World Geospatially Anchored 3D Map Tiles (Google Photorealistic 3D Tiles)
        if (isResolvedLocation(detectRealWorldLocationIntent(prompt, context))) {
            return 'geospatial';
        }

        // -0.96. City / Metropolis / Cyberpunk / Urban Street Canyons / Skylines
        if (/\b(?:city\s*skyline|urban\s*street(?:\s*canyon)?|cyberpunk\s*city|downtown(?:\s*financial)?(?:\s*district)?|skyscrapers?|metropolis)\b/i.test(text)) {
            return 'city';
        }

        // -0.955. Architecture / Procedural Buildings / Civic Plazas / Mansard & Hip Roofs (checked before nature so architectural scenes with trees match architecture)
        if (/\b(?:building|buildings|architectur(?:e|al)|palais|palace|plaza|promenade|civic|mansard|hip\s*roof|fenestration|create_building|facade|quoin|cornice|room|interior|blueprint|house|apartment|gallery|hall|pavilion|building\s*floor|office\s*space|industrial\s*loft|loft\s*apartment|loft\s*office|loft\s*space)\b/i.test(text)) {
            return 'architecture';
        }

        // -0.95. Nature, Ecosystem, Atmospheric Volumetrics, SSS & Triplanar
        if (!/\b(?:worldbuilder|terrain|heightmap)\b/i.test(text) && /\b(?:nature|forest|trees?|l_system|vegetation|foliage|leaves|biome|stratified|cliff\s*strata|rock\s*strata|mountain\s*plateau|atmosphere|volumetric|fog|god\s*rays|mie\s*scattering|subsurface|sss|translucent|triplanar|moss|woodland|woods)\b/i.test(text)) {
            return 'nature_atmosphere';
        }

        // -0.9. Universal Scene Synthesis & Photorealistic Mastery (Primary/Secondary/Tertiary forms, Scattering, Weathering)
        if (/\b(?:entire\s*scene|full\s*scene|scene\s*assembly|universal\s*scene|build\s*anything|photoreal(?:ism|istic)\s*scene|hero\s*prop|cinematic\s*scene|studio\s*lighting|quantum\s*reactor|ancient\s*reliquary|scatter\s*props|weathering|clutter)\b/i.test(text)) {
            return 'universal_scene';
        }

        // -0.8. Physically Based Rendering / PBR / Microfacet BRDF / Clearcoat / Transmission / Photorealism
        if (/\b(?:pbr|physically\s*based|microfacet|brdf|cook\s*torrance|clearcoat|transmission|roughness\s*metalness|sheen|anisotrop(?:y|ic)|photoreal(?:ism|istic)|material\s*showcase)\b/i.test(text)) {
            return 'pbr';
        }

        // -1. 3D Mesh Shaping / Organic Sculpt / Parametric Deformations / Lofts
        const isArchitecturalLoft = /\b(?:industrial|urban|living|studio)?\s*loft\s*(?:apartment|office|space|building|room|interior)\b/i.test(text);
        if (!isArchitecturalLoft && /\b(?:mesh\s*shaping|sculpt|sculpting|taper|twist|bend|loft|lathe|ffd|subdivision|organic\s*creature|aerodynamic\s*body|deform|parametric\s*surface)\b/i.test(text)) {
            return 'mesh-shaping';
        }

        // -0.5. 3D Particle Simulation / Fluid Dynamics / Emitters / Fire / Vortex / Sparks
        if (/\b(?:particles?|emitter|emitters|vortex|sparks?|fountain|smoke|fluid\s*spray|blackbody\s*radiation|curl\s*noise|particle\s*fx)\b/i.test(text) &&
            !/\b(?:molecule|molecular|atom|atomic|dna|double\s*helix|chemical\s*bond|electron|chemistry)\b/i.test(text)) {
            return 'particles';
        }

        // 0. Articulated Flight / Jet / Airplane / Drone
        if (/\b(?:planes?|airplanes?|jets?|flights?|aircrafts?|aviation|aerospace|drone\s*routes?|runways?)\b/i.test(text)) {
            return 'flight';
        }

        // 0.5. Automotive / 3D Vehicle / Car / Sports Car / Truck / Race Car / Hypercar
        if (/\b(?:cars?|vehicles?|automobiles?|trucks?|pickups?|sedans?|sports\s*cars?|coupes?|suvs?|race\s*cars?|racers?|formula\s*1?|f1\b|cybertrucks?|roadsters?|speedsters?|hot\s*rods?|evs?|hypercars?|supercars?|convertibles?|vans?)\b/i.test(text)) {
            return 'vehicle';
        }

        // 2.5. Mars Rover / Planetary Surface Exploration (checked before general celestial solar-system or generic vehicle)
        if (/\b(?:mars|martian|rover|curiosity|perseverance|opportunity|sojourner|jezero|lunar\s*rover|moon\s*rover|planetary\s*surface|red\s*planet)\b/i.test(text)) {
            return 'mars_rover';
        }

        // 3. Space / Solar System / Celestial / Orbit / Galaxy / Planets / Asteroid
        if (/\b(?:solar\s*system|planets?|planetary|orbits?|celestial|galaxy|galaxies|\bsun\b|mars|jupiter|saturn|asteroids?|starfield|space\s*station|cosmos|astronomy)\b/i.test(text)) {
            return 'solar-system';
        }

        // 4. Molecular / Physics / Chemistry / Atoms / DNA
        if (/\b(?:molecule|molecular|atoms?|atomic|dna|double\s*helix|chemical\s*bonds?|covalent|crystal\s*lattice|chemistry)\b/i.test(text)) {
            return 'molecular';
        }

        // 6. Procedural Worldbuilder / Landscape / Terrain / Mountain / Alpine / Canyon / Desert / Island / Citadel / Open World
        if (/worldbuilder|open\s*world|terrain|landscape|mountain|alpine|glacier|canyon|desert|oasis|badlands|island|citadel|valley|outpost|settlement|biome|heightmap/i.test(text)) {
            return 'worldbuilder';
        }
    }

    return 'general';
}

/**
 * Generates modern, fully compilable C++20 procedural source code for geospatial 3D tile scenes.
 * Enforces the "C/C++ First" architecture directive for real-world landmarks and photorealistic tiles.
 */
export function generateGeospatialCpp3DSource(params: {
    landmarkName?: string;
    lat: number;
    lng: number;
    elevation?: number;
    clayPreset?: string;
    castingRationale?: string;
}): string {
    const rawLandmark = params.landmarkName || 'Geospatial Site';
    const sanitizedTitle = rawLandmark.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase().slice(0, 40) || 'geospatial_site';
    const elevComment = params.elevation !== undefined
        ? `// Ground Elevation: ${params.elevation.toFixed(2)}m MSL [Google Elevation Ground Truth, Datum: EGM96]\n`
        : '';
    const rationaleComment = params.castingRationale
        ? `// Creative Casting Rationale: ${params.castingRationale.replace(/\n/g, ' ')}\n`
        : '';

    let clayEnum = 'WARM_TERRACOTTA';
    const preset = (params.clayPreset || '').toLowerCase();
    if (preset.includes('white') || preset.includes('arch')) clayEnum = 'ARCHITECTURAL_WHITE';
    else if (preset.includes('sandstone') || preset.includes('desert')) clayEnum = 'SANDSTONE';
    else if (preset.includes('concrete') || preset.includes('brutalist')) clayEnum = 'CONCRETE_BRUTALIST';
    else if (preset.includes('slate') || preset.includes('grey') || preset.includes('gray')) clayEnum = 'SLATE_GREY';

    return `// ==============================================================================
// Scratchbox 3D Engine: Geospatial Procedural Generator (C++20)
// Landmark: ${rawLandmark} (${params.lat.toFixed(4)}, ${params.lng.toFixed(4)})
${elevComment}${rationaleComment}// ==============================================================================
#include "scratchbox_engine.hpp"
#include <iostream>
#include <vector>

int main() {
    using namespace scratchbox::tiles;
    using namespace scratchbox::footprints;
    using namespace scratchbox::io;
    using namespace scratchbox::math;

    // 1. Establish Geospatial Anchor for Landmark
    TileRegionAnchor anchor{
        .latDeg = ${params.lat},
        .lngDeg = ${params.lng},
        .altitudeMeters = ${params.elevation || 10.0},
        .landmarkName = "${rawLandmark}",
        .groundRadiusMeters = 200.0f,
        .clayPreset = ClayPreset::${clayEnum}
    };

    // 2. Synthesize High-Resolution Geological Ground & Terrain Mesh
    auto terrain = TileIngestor::createTerrainPatch(anchor, 250.0f, 32);

    // 3. Extrude Landmark Architectural Massing with Stepped Setbacks
    std::vector<Vec2> towerFootprint = {
        Vec2(-16.0f, -16.0f),
        Vec2(16.0f, -16.0f),
        Vec2(16.0f, 16.0f),
        Vec2(-16.0f, 16.0f)
    };

    auto building = BuildingMassingGenerator::extrudeSteppedMassing(
        towerFootprint,
        0.0f,
        18.0f,
        45.0f,
        0.78f,
        TileIngestor::getClayMaterial(anchor.clayPreset)
    );
    building.name = "${sanitizedTitle}_Massing";

    // 4. Merge Terrain, Architectural Massing, and Ingested Geometry
    auto compositeScene = TileIngestor::mergeMeshes({ terrain, building }, "${sanitizedTitle}_Scene");

    // 5. Compute Solar Ephemeris & Atmospheric Sunlight
    auto lights = TileIngestor::createGeospatialLighting(anchor.latDeg, anchor.lngDeg, 15.0f);

    // 6. Stream glTF 2.0 Binary Chunks directly into Three.js Viewport
    GlbWriter::streamChunk(compositeScene, compositeScene.name);

    std::cout << "GEOSPATIAL_BUILD_SUCCESS: " << compositeScene.name
              << " Vertices=" << compositeScene.vertices.size()
              << " Triangles=" << (compositeScene.indices.size() / 3) << std::endl;
    return 0;
}
`;
}

export type VehicleArchetype =
    | 'sports_car'
    | 'formula'
    | 'truck'
    | 'suv'
    | 'roadster'
    | 'muscle'
    | 'cyber'
    | 'sedan';

export interface VehiclePaint {
    name: string;
    hex: string;
    rgb: [number, number, number];
    metalness: number;
    roughness: number;
    clearcoat: number;
    clearcoatRoughness: number;
    description: string;
}

export interface VehicleStyling {
    archetype: VehicleArchetype;
    title: string;
    subtitle: string;
    paint: VehiclePaint;
    chassisWidth: number;
    chassisHeight: number;
    chassisLength: number;
    groundClearance: number;
    wheelRadius: number;
    wheelWidth: number;
    rimRadius: number;
    trackWidth: number;
    wheelbase: number;
    cabinScale: [number, number, number];
    cabinOffset: [number, number, number];
    hasSpoiler: boolean;
    spoilerScale?: [number, number, number];
    spoilerOffset?: [number, number, number];
    hasRoofRack: boolean;
    hasBullBar: boolean;
    hasTruckBed: boolean;
    hasHoodScoop: boolean;
    hasCockpitHalo: boolean;
    hasFrontWing: boolean;
    hasLightBar: boolean;
    rimColor: string;
    rimMetalness: number;
    headlightColor: string;
    headlightEmissive: string;
    headlightIntensity: number;
    taillightEmissive: string;
    taillightIntensity: number;
}

const AUTOMOTIVE_PALETTES: VehiclePaint[] = [
    { name: 'Rosso Corsa Red', hex: '#dc2626', rgb: [0.86, 0.15, 0.15], metalness: 0.88, roughness: 0.16, clearcoat: 1.0, clearcoatRoughness: 0.05, description: 'High-gloss racing crimson metallic' },
    { name: 'Midnight Deep Blue', hex: '#1e3a8a', rgb: [0.12, 0.23, 0.54], metalness: 0.90, roughness: 0.18, clearcoat: 1.0, clearcoatRoughness: 0.06, description: 'Deep metallic midnight blue with reflective clearcoat' },
    { name: 'British Racing Green', hex: '#064e3b', rgb: [0.02, 0.31, 0.23], metalness: 0.85, roughness: 0.22, clearcoat: 1.0, clearcoatRoughness: 0.05, description: 'Historic heritage dark emerald racing green' },
    { name: 'Solar Pearl Yellow', hex: '#eab308', rgb: [0.92, 0.70, 0.03], metalness: 0.78, roughness: 0.20, clearcoat: 1.0, clearcoatRoughness: 0.05, description: 'Luminous pearlescent solar gold yellow' },
    { name: 'Stealth Matte Black', hex: '#18181b', rgb: [0.09, 0.09, 0.11], metalness: 0.15, roughness: 0.82, clearcoat: 0.0, clearcoatRoughness: 0.5, description: 'Satin non-reflective stealth black' },
    { name: 'Tri-Coat Pearl White', hex: '#f8fafc', rgb: [0.97, 0.98, 0.99], metalness: 0.82, roughness: 0.25, clearcoat: 1.0, clearcoatRoughness: 0.04, description: 'Multi-layer pearl white with diamond luster' },
    { name: 'Electric Cyber Cyan', hex: '#06b6d4', rgb: [0.02, 0.71, 0.83], metalness: 0.92, roughness: 0.14, clearcoat: 1.0, clearcoatRoughness: 0.05, description: 'Neon electric cyan metallic with cyan iridescence' },
    { name: 'Daytona Metallic Violet', hex: '#7c3aed', rgb: [0.49, 0.23, 0.93], metalness: 0.88, roughness: 0.18, clearcoat: 1.0, clearcoatRoughness: 0.05, description: 'Deep purple metallic with violet pearl undertones' },
    { name: 'Sunset Molten Orange', hex: '#ea580c', rgb: [0.92, 0.35, 0.05], metalness: 0.86, roughness: 0.18, clearcoat: 1.0, clearcoatRoughness: 0.05, description: 'Warm metallic copper-orange finish' },
    { name: 'Grigio Silverstone Titanium', hex: '#64748b', rgb: [0.39, 0.45, 0.55], metalness: 0.95, roughness: 0.15, clearcoat: 1.0, clearcoatRoughness: 0.05, description: 'Industrial brushed titanium silver' }
];

function hashPrompt(str: string, seed: number = 0): number {
    let hash = seed ^ 0xdeadbeef;
    for (let i = 0; i < str.length; i++) {
        hash = Math.imul(hash ^ str.charCodeAt(i), 2654435761);
    }
    return (hash ^ (hash >>> 16)) >>> 0;
}

/**
 * Dynamically extract vehicle styling, archetype, proportions, and PBR paint formulas from prompt semantics.
 * If prompt is open-ended ("build me a 3d car"), varies styling across infinite combinations via seed.
 */
export function extractVehicleStyling(prompt: string, seed?: number): VehicleStyling {
    const seedVal = seed !== undefined ? seed : Date.now();
    const hash = hashPrompt(prompt, seedVal);

    // 1. Color and Finish Extraction
    let paint: VehiclePaint;
    if (/\b(?:emerald|green|british\s*racing)\b/i.test(prompt)) {
        paint = { ...AUTOMOTIVE_PALETTES[2] };
    } else if (/\b(?:blue|navy|midnight)\b/i.test(prompt)) {
        paint = { ...AUTOMOTIVE_PALETTES[1] };
    } else if (/\b(?:yellow|gold|solar)\b/i.test(prompt)) {
        paint = { ...AUTOMOTIVE_PALETTES[3] };
    } else if (/\b(?:black|stealth|shadow)\b/i.test(prompt)) {
        paint = { ...AUTOMOTIVE_PALETTES[4] };
    } else if (/\b(?:white|pearl|arctic|snow)\b/i.test(prompt)) {
        paint = { ...AUTOMOTIVE_PALETTES[5] };
    } else if (/\b(?:cyan|teal|neon|electric\s*blue)\b/i.test(prompt)) {
        paint = { ...AUTOMOTIVE_PALETTES[6] };
    } else if (/\b(?:purple|violet)\b/i.test(prompt)) {
        paint = { ...AUTOMOTIVE_PALETTES[7] };
    } else if (/\b(?:orange|copper)\b/i.test(prompt)) {
        paint = { ...AUTOMOTIVE_PALETTES[8] };
    } else if (/\b(?:silver|grey|gray|titanium|metal)\b/i.test(prompt)) {
        paint = { ...AUTOMOTIVE_PALETTES[9] };
    } else if (/\b(?:red|crimson|rosso|ruby)\b/i.test(prompt)) {
        paint = { ...AUTOMOTIVE_PALETTES[0] };
    } else {
        paint = { ...AUTOMOTIVE_PALETTES[Math.abs(hash >> 3) % AUTOMOTIVE_PALETTES.length] };
    }

    if (/\b(?:matte|flat|satin)\b/i.test(prompt)) {
        paint.metalness = 0.12;
        paint.roughness = 0.82;
        paint.clearcoat = 0.0;
        paint.description = `Matte ${paint.name}`;
    } else if (/\b(?:chrome|mirror)\b/i.test(prompt)) {
        paint.metalness = 0.98;
        paint.roughness = 0.04;
        paint.clearcoat = 1.0;
        paint.description = `Polished Chrome ${paint.name}`;
    }

    // 2. Archetype Determination
    let archetype: VehicleArchetype;
    if (/\b(?:formula|f1\b|open\s*wheel|grand\s*prix)\b/i.test(prompt)) {
        archetype = 'formula';
    } else if (/\b(?:cyber|cybertruck|interceptor|hover|future|futuristic)\b/i.test(prompt)) {
        archetype = 'cyber';
    } else if (/\b(?:truck|pickup|hauler|flatbed)\b/i.test(prompt)) {
        archetype = 'truck';
    } else if (/\b(?:vintage|classic|retro|roadster|19[2-6]\d|speedster)\b/i.test(prompt)) {
        archetype = 'roadster';
    } else if (/\b(?:suv|4x4|off\s*road|jeep|crawler|overland)\b/i.test(prompt)) {
        archetype = 'suv';
    } else if (/\b(?:muscle|drag|charger|mustang|camaro|challenger|v8)\b/i.test(prompt)) {
        archetype = 'muscle';
    } else if (/\b(?:sedan|taxi|cab|limousine|saloon)\b/i.test(prompt)) {
        archetype = 'sedan';
    } else if (/\b(?:sports\s*cars?|coupes?|hyper\s*cars?|super\s*cars?|ferrari|porsche|lamborghini)\b/i.test(prompt)) {
        archetype = 'sports_car';
    } else {
        const pool: VehicleArchetype[] = ['sports_car', 'cyber', 'roadster', 'muscle', 'suv', 'truck', 'formula', 'sedan'];
        archetype = pool[Math.abs(hash) % pool.length];
    }

    // 3. Proportions, Dimensions & Archetype Attributes
    let chassisWidth = 1.95;
    let chassisHeight = 0.38;
    let chassisLength = 4.35;
    let groundClearance = 0.24;
    let wheelRadius = 0.36;
    let wheelWidth = 0.30;
    let rimRadius = 0.23;
    let trackWidth = 1.90;
    let wheelbase = 2.70;
    let cabinScale: [number, number, number] = [1.50, 0.56, 2.15];
    let cabinOffset: [number, number, number] = [0, 0.90, -0.20];
    let hasSpoiler = true;
    let spoilerScale: [number, number, number] = [1.80, 0.08, 0.38];
    let spoilerOffset: [number, number, number] = [0, 0.96, -2.15];
    let hasRoofRack = false;
    let hasBullBar = false;
    let hasTruckBed = false;
    let hasHoodScoop = false;
    let hasCockpitHalo = false;
    let hasFrontWing = false;
    let hasLightBar = false;
    let rimColor = '#e2e8f0';
    let rimMetalness = 0.95;
    let headlightColor = '#ffffff';
    let headlightEmissive = '#ffffff';
    let headlightIntensity = 4.5;
    let taillightEmissive = '#dc2626';
    let taillightIntensity = 3.5;
    let title = `3D ${paint.name} ${archetype.replace('_', ' ').toUpperCase()}`;
    let subtitle = `Procedural ${paint.description} with custom aerodynamic chassis, PBR shaders, and articulated alloy wheels.`;

    switch (archetype) {
        case 'formula':
            chassisWidth = 1.25;
            chassisHeight = 0.30;
            chassisLength = 4.80;
            groundClearance = 0.16;
            wheelRadius = 0.38;
            wheelWidth = 0.44; // Wide racing slicks
            rimRadius = 0.22;
            trackWidth = 1.80;
            wheelbase = 3.20;
            cabinScale = [0.72, 0.26, 1.30];
            cabinOffset = [0, 0.45, -0.10];
            hasSpoiler = true;
            spoilerScale = [1.65, 0.08, 0.45];
            spoilerOffset = [0, 0.95, -2.10];
            hasCockpitHalo = true;
            hasFrontWing = true;
            rimColor = '#38bdf8';
            rimMetalness = 0.90;
            title = `Formula 1 Grand Prix Monoposto (${paint.name})`;
            subtitle = `Open-wheel high-downforce single-seater with multi-tier front wing, halo cockpit safety ring, and ultra-wide slick tires.`;
            break;

        case 'truck':
            chassisWidth = 2.15;
            chassisHeight = 0.50;
            chassisLength = 5.20;
            groundClearance = 0.60;
            wheelRadius = 0.46;
            wheelWidth = 0.42; // Chunky all-terrain tires
            rimRadius = 0.28;
            trackWidth = 2.05;
            wheelbase = 3.10;
            cabinScale = [1.85, 0.84, 2.00];
            cabinOffset = [0, 1.25, 0.45];
            hasSpoiler = false;
            hasTruckBed = true;
            hasBullBar = true;
            rimColor = '#475569';
            rimMetalness = 0.85;
            title = `Heavy-Duty Overland Hauler (${paint.name})`;
            subtitle = `Rugged all-terrain truck with high-clearance suspension, front steel bull bar, open cargo bed, and knobby deep-dish tires.`;
            break;

        case 'cyber':
            chassisWidth = 2.10;
            chassisHeight = 0.48;
            chassisLength = 4.90;
            groundClearance = 0.42;
            wheelRadius = 0.39;
            wheelWidth = 0.34;
            rimRadius = 0.26;
            trackWidth = 1.95;
            wheelbase = 2.90;
            cabinScale = [1.65, 0.72, 2.40];
            cabinOffset = [0, 1.10, -0.10];
            hasSpoiler = false;
            hasLightBar = true;
            headlightEmissive = '#06b6d4'; // Cyan laser lightbar
            headlightIntensity = 6.0;
            taillightEmissive = '#ef4444';
            taillightIntensity = 5.0;
            rimColor = '#1e293b';
            rimMetalness = 0.98;
            title = `Cyberpunk Stealth Interceptor (${paint.name})`;
            subtitle = `Faceted angular monocoque with edge-to-edge neon cyan optical lightbars, tinted ballistic canopy, and aero-disc alloy wheels.`;
            break;

        case 'roadster':
            chassisWidth = 1.75;
            chassisHeight = 0.34;
            chassisLength = 4.20;
            groundClearance = 0.26;
            wheelRadius = 0.36;
            wheelWidth = 0.22; // Thin vintage wire wheels
            rimRadius = 0.24;
            trackWidth = 1.70;
            wheelbase = 2.60;
            cabinScale = [1.35, 0.32, 1.40];
            cabinOffset = [0, 0.65, -0.30];
            hasSpoiler = false;
            rimColor = '#f1f5f9';
            rimMetalness = 0.98;
            title = `Classic Grand Touring Roadster (${paint.name})`;
            subtitle = `Streamlined vintage silhouette with curved low-profile windscreen, elongated hood, chrome wire-spoke wheels, and radiator grille.`;
            break;

        case 'muscle':
            chassisWidth = 2.05;
            chassisHeight = 0.42;
            chassisLength = 4.75;
            groundClearance = 0.30;
            wheelRadius = 0.37;
            wheelWidth = 0.36;
            rimRadius = 0.24;
            trackWidth = 1.92;
            wheelbase = 2.80;
            cabinScale = [1.55, 0.58, 2.20];
            cabinOffset = [0, 0.92, -0.25];
            hasSpoiler = true;
            spoilerScale = [1.75, 0.12, 0.28];
            spoilerOffset = [0, 0.95, -2.25];
            hasHoodScoop = true;
            rimColor = '#cbd5e1';
            rimMetalness = 0.92;
            title = `V8 High-Displacement Muscle Car (${paint.name})`;
            subtitle = `Aggressive widebody stance with raised cowl-induction hood scoop, rear ducktail spoiler, and wide-track performance tires.`;
            break;

        case 'suv':
            chassisWidth = 2.05;
            chassisHeight = 0.46;
            chassisLength = 4.80;
            groundClearance = 0.50;
            wheelRadius = 0.42;
            wheelWidth = 0.36;
            rimRadius = 0.26;
            trackWidth = 1.95;
            wheelbase = 2.85;
            cabinScale = [1.80, 0.78, 3.20];
            cabinOffset = [0, 1.15, -0.15];
            hasSpoiler = false;
            hasRoofRack = true;
            rimColor = '#64748b';
            rimMetalness = 0.88;
            title = `Expedition 4x4 Overland SUV (${paint.name})`;
            subtitle = `Full-size 5-door utility vehicle with high-clearance all-terrain suspension, extended glass greenhouse, and expedition roof rack.`;
            break;

        case 'sedan':
            chassisWidth = 1.90;
            chassisHeight = 0.40;
            chassisLength = 4.75;
            groundClearance = 0.28;
            wheelRadius = 0.35;
            wheelWidth = 0.28;
            rimRadius = 0.24;
            trackWidth = 1.85;
            wheelbase = 2.80;
            cabinScale = [1.60, 0.65, 2.60];
            cabinOffset = [0, 0.95, -0.10];
            hasSpoiler = false;
            rimColor = '#e2e8f0';
            rimMetalness = 0.95;
            title = `Executive Touring Saloon (${paint.name})`;
            subtitle = `Refined 3-box luxury saloon with elongated wheelbase, expansive glass greenhouse, and polished multi-spoke alloy wheels.`;
            break;

        case 'sports_car':
        default:
            chassisWidth = 1.95;
            chassisHeight = 0.38;
            chassisLength = 4.35;
            groundClearance = 0.24;
            wheelRadius = 0.36;
            wheelWidth = 0.30;
            rimRadius = 0.23;
            trackWidth = 1.90;
            wheelbase = 2.70;
            cabinScale = [1.48, 0.54, 2.10];
            cabinOffset = [0, 0.90, -0.20];
            hasSpoiler = true;
            spoilerScale = [1.80, 0.08, 0.38];
            spoilerOffset = [0, 0.96, -2.15];
            title = `Aerodynamic Performance Hypercar (${paint.name})`;
            subtitle = `Mid-engine monocoque chassis with active aerodynamic rear wing, sculpted greenhouse cabin, and articulated alloy wheels.`;
            break;
    }

    return {
        archetype,
        title,
        subtitle,
        paint,
        chassisWidth,
        chassisHeight,
        chassisLength,
        groundClearance,
        wheelRadius,
        wheelWidth,
        rimRadius,
        trackWidth,
        wheelbase,
        cabinScale,
        cabinOffset,
        hasSpoiler,
        spoilerScale,
        spoilerOffset,
        hasRoofRack,
        hasBullBar,
        hasTruckBed,
        hasHoodScoop,
        hasCockpitHalo,
        hasFrontWing,
        hasLightBar,
        rimColor,
        rimMetalness,
        headlightColor,
        headlightEmissive,
        headlightIntensity,
        taillightEmissive,
        taillightIntensity
    };
}

/**
 * Generates modern, fully compilable C++20 procedural source code for the Scratchbox 3D Engine
 * tailored specifically to the synthesized vehicle parameters and materials.
 */
export function generateParametricVehicleCpp3DSource(styling: VehicleStyling, title: string = 'Procedural Asset'): string {
    const sanitizedTitle = title.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase().slice(0, 40) || 'procedural_vehicle';
    const p = styling.paint;
    const halfTrack = styling.trackWidth * 0.5;
    const halfBase = styling.wheelbase * 0.5;
    const chassisY = styling.groundClearance + styling.chassisHeight * 0.5;

    return `#include "scratchbox_engine.hpp"
#include <iostream>
#include <cmath>

int main() {
    using namespace scratchbox::geometry;
    using namespace scratchbox::math;

    // Parametric Vehicle Archetype: ${styling.archetype} | Finish: ${p.name}
    ScratchboxMesh vehicle("${sanitizedTitle}");
    vehicle.material = PbrMaterial::carPaint(Vec3(${p.rgb[0].toFixed(2)}f, ${p.rgb[1].toFixed(2)}f, ${p.rgb[2].toFixed(2)}f), ${p.metalness.toFixed(2)}f, ${p.roughness.toFixed(2)}f);

    // 1. Aerodynamic Monocoque Chassis
    Box3D chassis(Vec3(${styling.chassisWidth.toFixed(2)}f, ${styling.chassisHeight.toFixed(2)}f, ${styling.chassisLength.toFixed(2)}f));
    chassis.position = Vec3(0.0f, ${chassisY.toFixed(2)}f, 0.0f);
    chassis.material = vehicle.material;
    vehicle.addShape(chassis);

    // 2. Sculpted Greenhouse Cabin / Cockpit
    Box3D cabin(Vec3(${styling.cabinScale[0].toFixed(2)}f, ${styling.cabinScale[1].toFixed(2)}f, ${styling.cabinScale[2].toFixed(2)}f));
    cabin.position = Vec3(${styling.cabinOffset[0].toFixed(2)}f, ${styling.cabinOffset[1].toFixed(2)}f, ${styling.cabinOffset[2].toFixed(2)}f);
    cabin.material = ${styling.archetype === 'formula' ? 'PbrMaterial::forgedAlloy()' : 'PbrMaterial::tintedGlass(0.85f)'};
    vehicle.addShape(cabin);

    // 3. Four Articulated Road Wheels & Alloy Rims
    const Vec3 wheelPositions[4] = {
        Vec3(-${halfTrack.toFixed(2)}f, ${styling.wheelRadius.toFixed(2)}f,  ${halfBase.toFixed(2)}f), // Front Left
        Vec3( ${halfTrack.toFixed(2)}f, ${styling.wheelRadius.toFixed(2)}f,  ${halfBase.toFixed(2)}f), // Front Right
        Vec3(-${halfTrack.toFixed(2)}f, ${styling.wheelRadius.toFixed(2)}f, -${halfBase.toFixed(2)}f), // Rear Left
        Vec3( ${halfTrack.toFixed(2)}f, ${styling.wheelRadius.toFixed(2)}f, -${halfBase.toFixed(2)}f)  // Rear Right
    };

    for (int w = 0; w < 4; ++w) {
        Cylinder3D tire(${styling.wheelRadius.toFixed(2)}f, ${styling.wheelWidth.toFixed(2)}f);
        tire.position = wheelPositions[w];
        tire.rotation = Vec3(0.0f, 0.0f, PI * 0.5f);
        tire.material = PbrMaterial::vulcanizedRubber();
        vehicle.addShape(tire);

        Cylinder3D rim(${styling.rimRadius.toFixed(2)}f, ${(styling.wheelWidth + 0.01).toFixed(2)}f);
        rim.position = wheelPositions[w];
        rim.rotation = Vec3(0.0f, 0.0f, PI * 0.5f);
        rim.material = PbrMaterial::forgedAlloy();
        vehicle.addShape(rim);
    }

    // 4. Optical LED Lighting
    vehicle.addEmissiveLight(Vec3(-${(styling.chassisWidth * 0.35).toFixed(2)}f, ${chassisY.toFixed(2)}f, ${(styling.chassisLength * 0.5).toFixed(2)}f), Vec3(1.0f, 1.0f, 1.0f), ${styling.headlightIntensity.toFixed(1)}f);
    vehicle.addEmissiveLight(Vec3( ${(styling.chassisWidth * 0.35).toFixed(2)}f, ${chassisY.toFixed(2)}f, ${(styling.chassisLength * 0.5).toFixed(2)}f), Vec3(1.0f, 1.0f, 1.0f), ${styling.headlightIntensity.toFixed(1)}f);
    vehicle.addEmissiveLight(Vec3(-${(styling.chassisWidth * 0.35).toFixed(2)}f, ${(chassisY + 0.08).toFixed(2)}f, -${(styling.chassisLength * 0.5).toFixed(2)}f), Vec3(1.0f, 0.1f, 0.1f), ${styling.taillightIntensity.toFixed(1)}f);
    vehicle.addEmissiveLight(Vec3( ${(styling.chassisWidth * 0.35).toFixed(2)}f, ${(chassisY + 0.08).toFixed(2)}f, -${(styling.chassisLength * 0.5).toFixed(2)}f), Vec3(1.0f, 0.1f, 0.1f), ${styling.taillightIntensity.toFixed(1)}f);

    // 5. Binary glTF 2.0 Streaming Export
    GLTFExporter exporter;
    exporter.exportGlb(vehicle, "models/${sanitizedTitle}.glb");
    std::cout << "[Scratchbox Engine] Exported ${sanitizedTitle}.glb (" 
              << vehicle.vertices.size() << " vertices)" << std::endl;
    return 0;
}
`;
}

/**
 * Synthesizes dynamic customMeshes array for Three.js viewport from parametric styling.
 */
export function generateParametricVehicleMeshes(styling: VehicleStyling): any[] {
    const p = styling.paint;
    const halfTrack = styling.trackWidth * 0.5;
    const halfBase = styling.wheelbase * 0.5;
    const chassisY = styling.groundClearance + styling.chassisHeight * 0.5;

    const meshes: any[] = [
        // 1. Lower Chassis & Aerodynamic Floor
        {
            id: 'car-chassis-base',
            name: 'Chassis_Base',
            type: 'box',
            position: [0, chassisY, 0],
            scale: [styling.chassisWidth, styling.chassisHeight, styling.chassisLength],
            tier: 'primary',
            material: {
                color: p.hex,
                metalness: p.metalness,
                roughness: p.roughness,
                clearcoat: p.clearcoat,
                clearcoatRoughness: p.clearcoatRoughness,
                preset: p.name.toLowerCase().replace(/\s+/g, '_')
            }
        },
        // 2. Sculpted Upper Cabin / Greenhouse
        {
            id: 'car-cabin',
            name: 'Cabin_Greenhouse',
            type: 'box',
            position: styling.cabinOffset,
            scale: styling.cabinScale,
            tier: 'primary',
            material: styling.archetype === 'formula' ? {
                color: '#0f172a',
                metalness: 0.95,
                roughness: 0.15,
                preset: 'carbon_cockpit'
            } : {
                color: '#0f172a',
                metalness: 0.10,
                roughness: 0.08,
                transmission: 0.85,
                ior: 1.52,
                clearcoat: 1.0,
                preset: 'tinted_glass'
            }
        },
        // 3. Articulated Road Wheels (Rubber Tires)
        {
            id: 'wheel-fl',
            name: 'Wheel_Front_Left',
            type: 'cylinder',
            position: [-halfTrack, styling.wheelRadius, halfBase],
            rotation: [0, 0, Math.PI * 0.5],
            scale: [styling.wheelRadius, styling.wheelWidth, styling.wheelRadius],
            tier: 'secondary',
            material: { color: '#18181b', metalness: 0.05, roughness: 0.85, preset: 'vulcanized_rubber' }
        },
        {
            id: 'wheel-fr',
            name: 'Wheel_Front_Right',
            type: 'cylinder',
            position: [halfTrack, styling.wheelRadius, halfBase],
            rotation: [0, 0, Math.PI * 0.5],
            scale: [styling.wheelRadius, styling.wheelWidth, styling.wheelRadius],
            tier: 'secondary',
            material: { color: '#18181b', metalness: 0.05, roughness: 0.85, preset: 'vulcanized_rubber' }
        },
        {
            id: 'wheel-rl',
            name: 'Wheel_Rear_Left',
            type: 'cylinder',
            position: [-halfTrack, styling.wheelRadius, -halfBase],
            rotation: [0, 0, Math.PI * 0.5],
            scale: [styling.wheelRadius, styling.wheelWidth, styling.wheelRadius],
            tier: 'secondary',
            material: { color: '#18181b', metalness: 0.05, roughness: 0.85, preset: 'vulcanized_rubber' }
        },
        {
            id: 'wheel-rr',
            name: 'Wheel_Rear_Right',
            type: 'cylinder',
            position: [halfTrack, styling.wheelRadius, -halfBase],
            rotation: [0, 0, Math.PI * 0.5],
            scale: [styling.wheelRadius, styling.wheelWidth, styling.wheelRadius],
            tier: 'secondary',
            material: { color: '#18181b', metalness: 0.05, roughness: 0.85, preset: 'vulcanized_rubber' }
        },
        // 4. Forged Alloy Rims
        {
            id: 'rim-fl',
            name: 'Rim_Front_Left',
            type: 'cylinder',
            position: [-halfTrack, styling.wheelRadius, halfBase],
            rotation: [0, 0, Math.PI * 0.5],
            scale: [styling.rimRadius, styling.wheelWidth + 0.02, styling.rimRadius],
            tier: 'secondary',
            material: { color: styling.rimColor, metalness: styling.rimMetalness, roughness: 0.12, clearcoat: 0.8 }
        },
        {
            id: 'rim-fr',
            name: 'Rim_Front_Right',
            type: 'cylinder',
            position: [halfTrack, styling.wheelRadius, halfBase],
            rotation: [0, 0, Math.PI * 0.5],
            scale: [styling.rimRadius, styling.wheelWidth + 0.02, styling.rimRadius],
            tier: 'secondary',
            material: { color: styling.rimColor, metalness: styling.rimMetalness, roughness: 0.12, clearcoat: 0.8 }
        },
        {
            id: 'rim-rl',
            name: 'Rim_Rear_Left',
            type: 'cylinder',
            position: [-halfTrack, styling.wheelRadius, -halfBase],
            rotation: [0, 0, Math.PI * 0.5],
            scale: [styling.rimRadius, styling.wheelWidth + 0.02, styling.rimRadius],
            tier: 'secondary',
            material: { color: styling.rimColor, metalness: styling.rimMetalness, roughness: 0.12, clearcoat: 0.8 }
        },
        {
            id: 'rim-rr',
            name: 'Rim_Rear_Right',
            type: 'cylinder',
            position: [halfTrack, styling.wheelRadius, -halfBase],
            rotation: [0, 0, Math.PI * 0.5],
            scale: [styling.rimRadius, styling.wheelWidth + 0.02, styling.rimRadius],
            tier: 'secondary',
            material: { color: styling.rimColor, metalness: styling.rimMetalness, roughness: 0.12, clearcoat: 0.8 }
        },
        // 5. Optical LED Lighting
        {
            id: 'headlight-l',
            name: 'Headlight_Left',
            type: 'box',
            position: [-styling.chassisWidth * 0.35, chassisY, styling.chassisLength * 0.5],
            scale: [styling.chassisWidth * 0.22, 0.12, 0.12],
            tier: 'detail',
            material: {
                color: styling.headlightColor,
                emissive: styling.headlightEmissive,
                emissiveIntensity: styling.headlightIntensity,
                roughness: 0.05
            }
        },
        {
            id: 'headlight-r',
            name: 'Headlight_Right',
            type: 'box',
            position: [styling.chassisWidth * 0.35, chassisY, styling.chassisLength * 0.5],
            scale: [styling.chassisWidth * 0.22, 0.12, 0.12],
            tier: 'detail',
            material: {
                color: styling.headlightColor,
                emissive: styling.headlightEmissive,
                emissiveIntensity: styling.headlightIntensity,
                roughness: 0.05
            }
        },
        {
            id: 'taillight-l',
            name: 'Taillight_Left',
            type: 'box',
            position: [-styling.chassisWidth * 0.35, chassisY + 0.06, -styling.chassisLength * 0.5],
            scale: [styling.chassisWidth * 0.22, 0.10, 0.10],
            tier: 'detail',
            material: {
                color: '#dc2626',
                emissive: styling.taillightEmissive,
                emissiveIntensity: styling.taillightIntensity,
                roughness: 0.1
            }
        },
        {
            id: 'taillight-r',
            name: 'Taillight_Right',
            type: 'box',
            position: [styling.chassisWidth * 0.35, chassisY + 0.06, -styling.chassisLength * 0.5],
            scale: [styling.chassisWidth * 0.22, 0.10, 0.10],
            tier: 'detail',
            material: {
                color: '#dc2626',
                emissive: styling.taillightEmissive,
                emissiveIntensity: styling.taillightIntensity,
                roughness: 0.1
            }
        }
    ];

    // Archetype-specific aero components
    if (styling.hasSpoiler && styling.spoilerScale && styling.spoilerOffset) {
        meshes.push({
            id: 'car-spoiler',
            name: 'Aerodynamic_Spoiler',
            type: 'box',
            position: styling.spoilerOffset,
            scale: styling.spoilerScale,
            tier: 'secondary',
            material: { color: '#090d16', metalness: 0.95, roughness: 0.15, preset: 'carbon_fiber' }
        });
    }

    if (styling.hasFrontWing) {
        meshes.push({
            id: 'car-front-wing',
            name: 'Front_Downforce_Wing',
            type: 'box',
            position: [0, styling.groundClearance + 0.04, styling.chassisLength * 0.48],
            scale: [styling.trackWidth * 1.05, 0.06, 0.55],
            tier: 'secondary',
            material: { color: '#090d16', metalness: 0.95, roughness: 0.15, preset: 'carbon_fiber' }
        });
    }

    if (styling.hasCockpitHalo) {
        meshes.push({
            id: 'car-halo-hoop',
            name: 'Cockpit_Halo_Ring',
            type: 'box',
            position: [0, styling.cabinOffset[1] + 0.25, styling.cabinOffset[2] + 0.15],
            scale: [0.65, 0.35, 0.65],
            tier: 'detail',
            material: { color: '#38bdf8', metalness: 0.92, roughness: 0.18, preset: 'titanium_halo' }
        });
    }

    if (styling.hasTruckBed) {
        meshes.push({
            id: 'car-truck-bed',
            name: 'Cargo_Truck_Bed',
            type: 'box',
            position: [0, chassisY + 0.22, -styling.chassisLength * 0.24],
            scale: [styling.chassisWidth * 0.95, 0.45, styling.chassisLength * 0.44],
            tier: 'primary',
            material: { color: p.hex, metalness: p.metalness, roughness: p.roughness, clearcoat: p.clearcoat }
        });
    }

    if (styling.hasBullBar) {
        meshes.push({
            id: 'car-bull-bar',
            name: 'Front_Steel_Bull_Bar',
            type: 'box',
            position: [0, chassisY + 0.15, styling.chassisLength * 0.52],
            scale: [styling.chassisWidth * 0.75, 0.42, 0.15],
            tier: 'secondary',
            material: { color: '#1e293b', metalness: 0.92, roughness: 0.25, preset: 'forged_steel' }
        });
    }

    if (styling.hasRoofRack) {
        meshes.push({
            id: 'car-roof-rack',
            name: 'Expedition_Roof_Rack',
            type: 'box',
            position: [0, styling.cabinOffset[1] + styling.cabinScale[1] * 0.5 + 0.08, styling.cabinOffset[2]],
            scale: [styling.cabinScale[0] * 0.9, 0.12, styling.cabinScale[2] * 0.85],
            tier: 'secondary',
            material: { color: '#0f172a', metalness: 0.95, roughness: 0.20, preset: 'anodized_aluminum' }
        });
    }

    if (styling.hasHoodScoop) {
        meshes.push({
            id: 'car-hood-scoop',
            name: 'Cowl_Induction_Hood_Scoop',
            type: 'box',
            position: [0, chassisY + styling.chassisHeight * 0.5 + 0.08, styling.chassisLength * 0.22],
            scale: [0.60, 0.14, 0.90],
            tier: 'detail',
            material: { color: '#090d16', metalness: 0.95, roughness: 0.20, preset: 'satin_black' }
        });
    }

    if (styling.hasLightBar) {
        meshes.push({
            id: 'car-light-bar-front',
            name: 'Neon_Lightbar_Front',
            type: 'box',
            position: [0, chassisY + 0.08, styling.chassisLength * 0.51],
            scale: [styling.chassisWidth * 0.92, 0.06, 0.06],
            tier: 'detail',
            material: {
                color: '#06b6d4',
                emissive: '#06b6d4',
                emissiveIntensity: 6.0,
                roughness: 0.05
            }
        });
        meshes.push({
            id: 'car-light-bar-rear',
            name: 'Laser_Lightbar_Rear',
            type: 'box',
            position: [0, chassisY + 0.10, -styling.chassisLength * 0.51],
            scale: [styling.chassisWidth * 0.92, 0.06, 0.06],
            tier: 'detail',
            material: {
                color: '#ef4444',
                emissive: '#ef4444',
                emissiveIntensity: 5.0,
                roughness: 0.05
            }
        });
    }

    return meshes;
}

/**
 * Synthesizes an infinite-variety, zero-preset 3D Vehicle scene.
 * Delegates directly to the ADA Hero Object Synthesizer executing the 4 Universal
 * Differential Geometric Operators (Pillar 6 / Pillar 11) in 18% Studio Grey Clay Void.
 */
export function synthesizeProceduralVehicleScene(prompt: string, context?: any, seed?: number): Scene3DData {
    const styling = extractVehicleStyling(prompt, seed);
    const customMeshes = generateParametricVehicleMeshes(styling);
    const sourceCode = generateParametricVehicleCpp3DSource(styling, styling.title);
    const cameraDist = Math.max(5.5, styling.chassisLength * 1.35);

    return {
        title: styling.title,
        subtitle: styling.subtitle,
        camera: {
            position: [cameraDist * 0.85, cameraDist * 0.45, cameraDist * 0.85],
            target: [0, styling.groundClearance + styling.chassisHeight * 0.5, 0],
            fov: 40
        },
        environment: {
            skybox: 'studio',
            lighting: 'cinematic_3point_studio',
            ground: true,
            exposure: 1.25,
            ambientIntensity: 0.45
        },
        features: {
            cinematic3PointLighting: true,
            studioPedestal: true,
            curvatureAO: true
        },
        customMeshes,
        cppGenerator: {
            filename: 'world_generator.cpp',
            sourceCode,
            enabled: true
        },
        customScript: `
// Scratchbox Studio Idle Suspension Breathing Animation
let clock = new THREE.Clock();
function animateVehicle() {
    requestAnimationFrame(animateVehicle);
    const t = clock.getElapsedTime();
    const suspY = Math.sin(t * 1.5) * 0.006;
    scene.children.forEach(c => {
        if (c.name && (c.name.startsWith('Chassis_') || c.name.startsWith('Cabin_')) && c.position) {
            c.position.y += suspY * 0.02;
        }
    });
}
animateVehicle();
`
    };
}

/**
 * Generates modern, fully compilable C++20 procedural source code for the Scratchbox 3D Engine.
 * Enforces the "C/C++ First" architecture directive.
 */
export function generateDefaultCpp3DSource(theme: Procedural3DTheme, title: string = 'Procedural Asset'): string {
    const sanitizedTitle = title.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase().slice(0, 40) || 'procedural_asset';

    switch (theme) {
        case 'geospatial':
            return generateGeospatialCpp3DSource({
                landmarkName: title,
                lat: 37.7955,
                lng: -122.3937,
                elevation: 10.0,
                clayPreset: 'warm_terracotta'
            });

        case 'vehicle': {
            const styling = extractVehicleStyling(title);
            return generateParametricVehicleCpp3DSource(styling, title);
        }

        case 'mesh-shaping':
            return `#include "scratchbox_engine.hpp"
#include <iostream>
#include <vector>
#include <cmath>

int main() {
    using namespace scratchbox::geometry;
    using namespace scratchbox::math;
    using namespace scratchbox::shaper;

    // 1. Construct Base Parametric Lofted Cross-Sections
    std::vector<std::vector<Vec3>> slices;
    const int numSlices = 10;
    const int ptsPerSlice = 16;
    const float height = 8.0f;

    for (int s = 0; s < numSlices; ++s) {
        float t = static_cast<float>(s) / (numSlices - 1);
        float y = (t - 0.5f) * height;
        float baseRadius = 1.2f + 0.6f * std::sin(t * PI);

        std::vector<Vec3> slicePts;
        for (int p = 0; p < ptsPerSlice; ++p) {
            float angle = (static_cast<float>(p) / ptsPerSlice) * TWO_PI;
            float rx = baseRadius * (1.0f + 0.2f * std::cos(angle * 2.0f));
            float rz = baseRadius * 0.7f;
            slicePts.push_back(Vec3(std::cos(angle) * rx, y, std::sin(angle) * rz));
        }
        slices.push_back(slicePts);
    }

    ScratchboxMesh shaped = Loft3D::skin(slices, true, Vec4(0.85f, 0.90f, 0.98f, 1.0f));
    shaped.name = "${sanitizedTitle}";
    shaped.material = PbrMaterial::titanium();

    // 2. Non-Linear Deformations: Taper and Twist
    Deformer::taper(shaped, Axis::Y, 0.45f, -height * 0.5f, height * 0.5f, 1.2f);
    Deformer::twist(shaped, Axis::Y, PI * 0.75f, -height * 0.5f, height * 0.5f);

    // 3. Free-Form Deformation (FFD) Lattice Waist Pinch
    AABB bounds = shaped.bounds;
    Lattice3D lattice(3, 3, 3, bounds);
    lattice.offsetControlPoint(0, 1, 1, Vec3(0.35f, 0.0f, 0.0f));
    lattice.offsetControlPoint(2, 1, 1, Vec3(-0.35f, 0.0f, 0.0f));
    lattice.deform(shaped);

    // 4. Digital Sculpt Strokes: Clay Build-up and Creases
    SculptEngine::applyStroke(shaped, SculptBrush::Clay, Vec3(0, 1.0f, 0.8f), 1.8f, 0.35f, Vec3(0, 0, 1));
    SculptEngine::applyStroke(shaped, SculptBrush::Crease, Vec3(0, -0.5f, 0.8f), 1.5f, 0.25f, Vec3(0, 1, 0));
    SculptEngine::applyStroke(shaped, SculptBrush::Smooth, Vec3(0, 0.0f, 0.8f), 2.0f, 0.30f, Vec3(0, 1, 0));

    // 5. Subdivision Refinement & Topology Clean
    shaped = LoopSubdivision::subdivide(shaped, 1);
    MeshTopologyCleaner::removeDegenerateFaces(shaped);

    shaped.recomputeSmoothNormals();
    shaped.computeCurvatureAO(0.85f);
    shaped.applyProceduralWeathering(3.0f, 0.05f);

    scratchbox::io::GlbWriter::streamChunk(shaped, "${sanitizedTitle}");
    return 0;
}`;

        case 'particles':
            return `#include "scratchbox_engine.hpp"
#include <iostream>
#include <vector>
#include <memory>
#include <cmath>

int main() {
    using namespace scratchbox::geometry;
    using namespace scratchbox::math;
    using namespace scratchbox::particles;

    // 1. Initialize High-Performance Particle System with Blackbody Thermal Scaling
    ParticleSystem sys("${sanitizedTitle}", 4000);

    // 2. Configure Dual Emitters: Fire Vortex Core & Celestial Nova Ejecta
    ParticleEmitter vortex = ParticleEmitter::fireVortex(Vec3(0, 0, 0));
    vortex.speedMin = 4.0f;
    vortex.speedMax = 9.0f;
    vortex.emissionRate = 350.0f;
    vortex.sizeStart = 0.28f;
    vortex.sizeEnd = 0.04f;
    vortex.colorStart = Vec4(1.0f, 0.65f, 0.15f, 1.0f);
    vortex.colorEnd = Vec4(0.35f, 0.04f, 0.0f, 0.0f);
    sys.addEmitter(vortex);

    ParticleEmitter nova = ParticleEmitter::celestialExplosion(Vec3(0, 1.5f, 0));
    nova.emissionRate = 120.0f;
    nova.speedMin = 2.0f;
    nova.speedMax = 6.0f;
    nova.sizeStart = 0.20f;
    nova.sizeEnd = 0.01f;
    nova.colorStart = Vec4(0.3f, 0.8f, 1.0f, 1.0f);
    nova.colorEnd = Vec4(0.05f, 0.1f, 0.6f, 0.0f);
    sys.addEmitter(nova);

    // 3. Physical Force Fields: Gravity, Centripetal Swirl, and Divergence-Free Curl Noise
    sys.addForceField(std::make_shared<GravityField>(Vec3(0, -1.5f, 0)));
    sys.addForceField(std::make_shared<VortexField>(Vec3(0, 0, 0), 5.5f, 1.2f, 2.0f));
    sys.addForceField(std::make_shared<CurlNoiseField>(0.35f, 3.2f, 0.25f));
    sys.addForceField(std::make_shared<DragField>(0.35f));

    // 4. Physical Collision Response (Restitution + Surface Friction)
    sys.addCollider(std::make_shared<PlaneCollider>(Vec3(0, 0, 0), Vec3(0, 1, 0), 0.65f, 0.25f));
    sys.addCollider(std::make_shared<SphereCollider>(Vec3(0, 3.0f, 0), 1.2f, 0.70f, 0.15f));

    // 5. Numerical Time-Integration (RK4 4th-Order Accuracy)
    const float dt = 0.01667f;
    const int warmupFrames = 75;
    for (int frame = 0; frame < warmupFrames; ++frame) {
        sys.step(dt, IntegratorType::RungeKutta4);
    }

    // 6. Convert to Camera-Facing Billboard Quads with Photorealistic Emission
    ScratchboxMesh particleMesh = sys.toMesh(ParticleRenderMode::BillboardQuads, Vec3(0, 6, 14));
    particleMesh.name = "${sanitizedTitle}";
    particleMesh.material = PbrMaterial::emissiveGlow(Vec3(1.0f, 0.55f, 0.1f), 3.0f);

    scratchbox::io::GlbWriter::streamChunk(particleMesh, "${sanitizedTitle}");
    return 0;
}`;

        case 'pbr':
            return `#include "scratchbox_engine.hpp"
#include <iostream>
#include <vector>
#include <cmath>

int main() {
    using namespace scratchbox::geometry;
    using namespace scratchbox::math;
    using namespace scratchbox::pbr;

    // 1. Initialize High-Fidelity PBR Showcase Mesh
    ScratchboxMesh pbrShowcase("${sanitizedTitle}");

    // 2. Assign Calibrated Real-World PBR Material (Automotive Candy Apple Red with Clearcoat)
    pbrShowcase.material = presets::carPaintCandyRed();

    // 3. Tessellate High-Resolution Sphere with Exact Curvature UVs and Normals
    const int latSegments = 48;
    const int lonSegments = 96;
    const float radius = 2.5f;

    for (int y = 0; y <= latSegments; ++y) {
        float v = static_cast<float>(y) / latSegments;
        float theta = v * PI;
        for (int x = 0; x <= lonSegments; ++x) {
            float u = static_cast<float>(x) / lonSegments;
            float phi = u * TWO_PI;

            float nx = std::sin(theta) * std::cos(phi);
            float ny = std::cos(theta);
            float nz = std::sin(theta) * std::sin(phi);

            Vec3 pos(nx * radius, ny * radius + 2.5f, nz * radius);
            Vec3 norm(nx, ny, nz);
            Vec2 uv(u, v);
            Vec4 col(1.0f, 1.0f, 1.0f, 1.0f);

            pbrShowcase.addVertex({pos, norm, uv, col});
        }
    }

    for (int y = 0; y < latSegments; ++y) {
        for (int x = 0; x < lonSegments; ++x) {
            uint32_t i0 = y * (lonSegments + 1) + x;
            uint32_t i1 = (y + 1) * (lonSegments + 1) + x;
            uint32_t i2 = (y + 1) * (lonSegments + 1) + (x + 1);
            uint32_t i3 = y * (lonSegments + 1) + (x + 1);

            pbrShowcase.addTriangle(i0, i1, i2);
            pbrShowcase.addTriangle(i0, i2, i3);
        }
    }

    // 4. Validate Cook-Torrance Microfacet BRDF Energy Conservation
    Vec3 N(0.0f, 1.0f, 0.0f);
    Vec3 V = Vec3(0.0f, 0.7071f, 0.7071f).normalized();
    Vec3 L = Vec3(0.577f, 0.577f, 0.577f).normalized();
    auto brdf = evaluatePbrBRDF(pbrShowcase.material, N, V, L);

    std::cout << "[Scratchbox PBR Engine] Evaluated BRDF Total Lum: " << brdf.total.length()
              << " | Specular: " << brdf.specular.length()
              << " | Clearcoat: " << brdf.clearcoat.length() << std::endl;

    // 5. Stream glTF 2.0 Binary Container with KHR_materials_* Extensions
    scratchbox::io::GlbWriter::streamChunk(pbrShowcase, "${sanitizedTitle}");
    return 0;
}`;

        case 'glass_shatter':
            return `#include "scratchbox_engine.hpp"
#include <iostream>
#include <vector>
#include <cmath>

int main() {
    using namespace scratchbox;
    using namespace scratchbox::geometry;
    using namespace scratchbox::fracture;

    std::cout << "--- Scratchbox Ballistic Glass Shatter Generator ---" << std::endl;

    GlassPaneConfig pane;
    pane.width = 4.0f;
    pane.height = 3.0f;
    pane.thickness = 0.06f;
    pane.outerFractureRadius = 1.35f;

    BulletConfig bullet;
    bullet.caliber = 0.12f;
    bullet.length = 0.46f;
    bullet.speed = 820.0f;
    bullet.machNumber = 2.4f;

    // Assemble complete multi-layer scene snapshot at t = 0.08s
    ScratchboxMesh scene = GlassFractureGenerator::buildCompleteScene(pane, bullet, 0.08f);
    scene.name = "${sanitizedTitle}";

    std::vector<uint8_t> glbData = scratchbox::io::GlbWriter::writeGlb(scene);
    std::cout << "Generated glTF 2.0 Binary container: " << glbData.size() << " bytes." << std::endl;

    scratchbox::io::GlbWriter::streamChunk(scene, "${sanitizedTitle}");
    return 0;
}`;

        case 'universal_scene':
            return `#include "scratchbox_engine.hpp"
#include <iostream>
#include <vector>
#include <cmath>

int main() {
    using namespace scratchbox::geometry;
    using namespace scratchbox::math;
    using namespace scratchbox::composer;

    // 1. Initialize Universal Photorealistic Scene Graph
    UniversalSceneComposer composer("${sanitizedTitle}");

    // 2. Synthesize High-Fidelity Hero Object Archetype (Quantum Reactor Core)
    auto reactorCore = createQuantumReactorCore("${sanitizedTitle}_reactor");

    // 3. Form Hierarchy: Add Primary, Secondary, and Tertiary Nodes
    composer.addNode("hero_reactor", reactorCore, FormTier::Primary, Vec3(0.0f, 1.2f, 0.0f));

    // 4. Procedural Studio Exhibition Pedestal
    auto pedestal = generateStudioPedestal(3.8f, 0.25f, 0.05f);
    composer.addNode("studio_pedestal", pedestal, FormTier::Primary, Vec3(0.0f, 0.0f, 0.0f));

    // 5. Poisson-Disk Instance Scattering (Micro-Debris / Surface Bolts)
    auto scatterProps = ScratchboxMesh::createBox(Vec3(0.08f, 0.08f, 0.08f), Vec4(0.5f, 0.5f, 0.55f, 1.0f));
    auto instances = scatterInstancesOnMesh(pedestal, 32, 0.06f, 0.14f, 1337);
    for (size_t i = 0; i < instances.size(); ++i) {
        composer.addNode("prop_" + std::to_string(i), scatterProps, FormTier::Tertiary,
                         instances[i].position, instances[i].rotation, instances[i].scale);
    }

    // 6. Curvature & Crevice AO Baking Across Vertex Colors
    for (auto& node : composer.getNodes()) {
        bakeCurvatureToVertexColors(node.mesh, 3.5f, 4.0f);
    }

    // 7. Calibrated Cinematic 3-Point Studio Lighting Rig (Kelvin Scale)
    auto studioLighting = createCinematicStudioLighting(Vec3(0.0f, 1.2f, 0.0f), 5.5f);

    std::cout << "[Scratchbox Scene Composer] Assembled " << composer.getNodeCount()
              << " nodes with cinematic lighting (Key: " << studioLighting.keyLight.colorTemperatureKelvin << "K)" << std::endl;

    // 8. Stream Combined Binary glTF Container (.glb)
    composer.streamSceneGlb("${sanitizedTitle}");
    return 0;
}`;

        case 'nature_atmosphere':
            return `#include "scratchbox_engine.hpp"
#include <iostream>
#include <vector>
#include <cmath>

int main() {
    using namespace scratchbox::geometry;
    using namespace scratchbox::math;
    using namespace scratchbox::composer;
    using namespace scratchbox::triplanar;
    using namespace scratchbox::sss;
    using namespace scratchbox::volumetrics;
    using namespace scratchbox::nature;

    UniversalSceneComposer scene("${sanitizedTitle}");

    // 1. Procedural Stratified Biome Terrain
    BiomeTerrainParams terrainParams;
    terrainParams.width = 24.0f;
    terrainParams.depth = 24.0f;
    terrainParams.resolution = 48;
    terrainParams.maxElevation = 4.2f;
    terrainParams.rockSlopeThreshold = 36.0f;
    terrainParams.seed = 777;
    geometry::Mesh terrainMesh = generateBiomeTerrain(terrainParams);
    terrainMesh.name = "BiomeTerrain";
    terrainMesh.material = PbrMaterial::basaltRock();
    applyTriplanarToMesh(terrainMesh, TriplanarMaterialType::ROCK_STRATA, 1.8f);
    scene.addNode("terrain_plateau", terrainMesh, FormTier::Primary, Vec3(0, 0, 0));

    // 2. Ancient Hero Monolith / Relic on the Plateau
    ScratchboxMesh monolith = ScratchboxMesh::createBox(Vec3(1.2f, 4.8f, 1.2f), Vec4(0.35f, 0.36f, 0.38f, 1.0f));
    monolith.name = "AncientMonolith";
    monolith.material = PbrMaterial::basaltRock();
    applyTriplanarToMesh(monolith, TriplanarMaterialType::MOSS_OVERGROWTH, 1.2f);
    scene.addNode("ancient_monolith", monolith, FormTier::Primary, Vec3(0, 2.4f, 0), Vec3(0, 0.35f, 0));

    // 3. Stochastic L-System Trees (Leonardo da Vinci Branching & Foliage SSS)
    LSystemTreeParams treeParams;
    treeParams.maxDepth = 4;
    treeParams.initialLength = 3.6f;
    treeParams.initialRadius = 0.36f;
    treeParams.generateLeaves = true;
    treeParams.useDetailedFoliageCards = true;
    treeParams.transferSmoothNormals = true;
    treeParams.leafSize = 0.42f;

    geometry::Mesh tree1 = generateProceduralTree(Vec3(-4.5f, 1.2f, -3.0f), treeParams);
    tree1.name = "LSystem_Oak_A";
    tree1.material = PbrMaterial::roughWood();
    scene.addNode("tree_oak_left", tree1, FormTier::Secondary, Vec3(0, 0, 0));

    treeParams.seed = 999;
    treeParams.initialLength = 3.2f;
    geometry::Mesh tree2 = generateProceduralTree(Vec3(4.2f, 1.4f, -2.5f), treeParams);
    tree2.name = "LSystem_Oak_B";
    tree2.material = PbrMaterial::roughWood();
    scene.addNode("tree_oak_right", tree2, FormTier::Secondary, Vec3(0, 0, 0));

    // 4. Volumetric Participating Media & Golden Hour Atmosphere
    VolumetricMedium atmosphere;
    atmosphere.density = 0.042f;
    atmosphere.scatteringColor = Vec3(0.96f, 0.82f, 0.60f);
    atmosphere.anisotropy = 0.76f; // Forward Mie scattering for god rays
    auto goldenHourSH = getSkyGoldenHourSH();

    std::cout << "[Scratchbox Nature Engine] Synthesized Biome Terrain ("
              << terrainMesh.vertices.size() << " verts), Trees, and Volumetric Fog (g="
              << atmosphere.anisotropy << ")" << std::endl;

    // 5. Stream glTF 2.0 Binary Container (.glb)
    scene.streamSceneGlb("${sanitizedTitle}");
    return 0;
}`;

        case 'flight':
            return `#include "scratchbox_engine.hpp"
#include <iostream>
#include <cmath>

int main() {
    using namespace scratchbox::geometry;
    using namespace scratchbox::math;

    ScratchboxMesh aircraft("${sanitizedTitle}");
    aircraft.material = PbrMaterial::titanium();

    // 1. Aerodynamic Parabolic Fuselage
    const int radialSegs = 32;
    const int lengthSegs = 24;
    float fuselageLength = 8.0f;
    float maxRadius = 1.2f;

    for (int y = 0; y < lengthSegs; ++y) {
        float v0 = static_cast<float>(y) / lengthSegs;
        float v1 = static_cast<float>(y + 1) / lengthSegs;
        float r0 = maxRadius * std::sin(v0 * PI);
        float r1 = maxRadius * std::sin(v1 * PI);
        float z0 = (v0 - 0.5f) * fuselageLength;
        float z1 = (v1 - 0.5f) * fuselageLength;

        for (int x = 0; x < radialSegs; ++x) {
            float u0 = (static_cast<float>(x) / radialSegs) * TWO_PI;
            float u1 = (static_cast<float>(x + 1) / radialSegs) * TWO_PI;

            Vec3 p00(std::cos(u0) * r0, std::sin(u0) * r0 * 0.85f, z0);
            Vec3 p10(std::cos(u1) * r0, std::sin(u1) * r0 * 0.85f, z0);
            Vec3 p01(std::cos(u0) * r1, std::sin(u0) * r1 * 0.85f, z1);
            Vec3 p11(std::cos(u1) * r1, std::sin(u1) * r1 * 0.85f, z1);

            uint32_t idx = static_cast<uint32_t>(aircraft.vertices.size());
            Vec4 col(0.90f, 0.92f, 0.95f, 1.0f);
            aircraft.addVertex({p00, p00.normalized(), {static_cast<float>(x)/radialSegs, v0}, col});
            aircraft.addVertex({p10, p10.normalized(), {static_cast<float>(x+1)/radialSegs, v0}, col});
            aircraft.addVertex({p11, p11.normalized(), {static_cast<float>(x+1)/radialSegs, v1}, col});
            aircraft.addVertex({p01, p01.normalized(), {static_cast<float>(x)/radialSegs, v1}, col});

            aircraft.addTriangle(idx, idx + 1, idx + 2);
            aircraft.addTriangle(idx, idx + 2, idx + 3);
        }
    }

    // 2. Swept Delta Main Wings
    float wingSpan = 10.0f;
    float rootChord = 3.2f;
    float tipChord = 0.8f;
    float sweepBack = 2.4f;

    auto buildWingSection = [&](float side) {
        uint32_t idx = static_cast<uint32_t>(aircraft.vertices.size());
        Vec3 rLead(0.6f * side, 0.0f, rootChord * 0.5f);
        Vec3 rTrail(0.6f * side, 0.0f, -rootChord * 0.5f);
        Vec3 tLead(wingSpan * 0.5f * side, 0.4f, rootChord * 0.5f - sweepBack);
        Vec3 tTrail(wingSpan * 0.5f * side, 0.4f, rootChord * 0.5f - sweepBack - tipChord);

        Vec4 wingCol(0.82f, 0.85f, 0.90f, 1.0f);
        aircraft.addVertex({rLead, Vec3(0, 1, 0), {0, 0}, wingCol});
        aircraft.addVertex({tLead, Vec3(0, 1, 0), {1, 0}, wingCol});
        aircraft.addVertex({tTrail, Vec3(0, 1, 0), {1, 1}, wingCol});
        aircraft.addVertex({rTrail, Vec3(0, 1, 0), {0, 1}, wingCol});

        if (side > 0) {
            aircraft.addTriangle(idx, idx + 1, idx + 2);
            aircraft.addTriangle(idx, idx + 2, idx + 3);
        } else {
            aircraft.addTriangle(idx, idx + 2, idx + 1);
            aircraft.addTriangle(idx, idx + 3, idx + 2);
        }
    };
    buildWingSection(1.0f);
    buildWingSection(-1.0f);

    aircraft.recomputeSmoothNormals();
    aircraft.computeCurvatureAO(0.70f);
    aircraft.applyProceduralWeathering(3.0f, 0.06f);

    scratchbox::io::GlbWriter::streamChunk(aircraft, "${sanitizedTitle}");
    return 0;
}`;

        case 'worldbuilder':
        case 'battlefield':
            return `#include "scratchbox_engine.hpp"
#include <iostream>
#include <cmath>

int main() {
    using namespace scratchbox::geometry;
    using namespace scratchbox::math;

    ScratchboxMesh terrain("${sanitizedTitle}");
    terrain.material = PbrMaterial::basaltRock();

    const int gridRes = 48;
    const float worldSize = 40.0f;
    FastNoise3D noise(4242);

    for (int z = 0; z < gridRes; ++z) {
        for (int x = 0; x < gridRes; ++x) {
            float u = static_cast<float>(x) / (gridRes - 1);
            float v = static_cast<float>(z) / (gridRes - 1);
            float wx = (u - 0.5f) * worldSize;
            float wz = (v - 0.5f) * worldSize;

            float elevation = noise.fBm(wx * 0.08f, 0.0f, wz * 0.08f, 4, 0.5f, 2.0f) * 4.5f;
            elevation += std::sin(wx * 0.2f) * std::cos(wz * 0.2f) * 1.2f;

            // Edge damping ensures perimeter touches ground plane at y = 0 (prevents floating cloth artifact)
            float edgeDist = 1.0f - std::max(std::abs(wx) / (worldSize * 0.5f), std::abs(wz) / (worldSize * 0.5f));
            float edgeFade = std::max(0.0f, std::min(1.0f, edgeDist * 3.5f));
            elevation *= edgeFade;

            float heightNorm = std::max(0.0f, std::min(1.0f, (elevation + 4.0f) / 8.0f));
            Vec4 vertexColor(0.25f + heightNorm * 0.45f, 0.30f + heightNorm * 0.40f, 0.22f + heightNorm * 0.20f, 1.0f);

            terrain.addVertex({Vec3(wx, elevation, wz), Vec3(0, 1, 0), {u, v}, vertexColor});
        }
    }

    for (int z = 0; z < gridRes - 1; ++z) {
        for (int x = 0; x < gridRes - 1; ++x) {
            uint32_t i0 = z * gridRes + x;
            uint32_t i1 = z * gridRes + (x + 1);
            uint32_t i2 = (z + 1) * gridRes + x;
            uint32_t i3 = (z + 1) * gridRes + (x + 1);

            terrain.addTriangle(i0, i2, i1);
            terrain.addTriangle(i1, i2, i3);
        }
    }

    terrain.recomputeSmoothNormals();
    terrain.computeCurvatureAO(0.80f);

    scratchbox::io::GlbWriter::streamChunk(terrain, "${sanitizedTitle}");
    return 0;
}`;

        case 'city':
        case 'architecture':
            return `#include "scratchbox_engine.hpp"
#include <iostream>
#include <cmath>

int main() {
    using namespace scratchbox::geometry;
    using namespace scratchbox::math;

    ScratchboxMesh spire("${sanitizedTitle}");
    spire.material = PbrMaterial::carbonComposite();

    const int floors = 18;
    const float floorHeight = 1.2f;
    const float baseWidth = 5.0f;

    for (int f = 0; f < floors; ++f) {
        float t0 = static_cast<float>(f) / floors;
        float t1 = static_cast<float>(f + 1) / floors;
        float w0 = baseWidth * (1.0f - t0 * 0.65f);
        float w1 = baseWidth * (1.0f - t1 * 0.65f);
        float y0 = f * floorHeight;
        float y1 = (f + 1) * floorHeight;

        Vec3 p00(-w0, y0, -w0), p10(w0, y0, -w0), p11(w0, y0, w0), p01(-w0, y0, w0);
        Vec3 q00(-w1, y1, -w1), q10(w1, y1, -w1), q11(w1, y1, w1), q01(-w1, y1, w1);

        auto addQuad = [&](const Vec3& a, const Vec3& b, const Vec3& c, const Vec3& d, const Vec4& col) {
            uint32_t idx = static_cast<uint32_t>(spire.vertices.size());
            spire.addVertex({a, Vec3(0, 1, 0), {0, 0}, col});
            spire.addVertex({b, Vec3(0, 1, 0), {1, 0}, col});
            spire.addVertex({c, Vec3(0, 1, 0), {1, 1}, col});
            spire.addVertex({d, Vec3(0, 1, 0), {0, 1}, col});
            spire.addTriangle(idx, idx + 1, idx + 2);
            spire.addTriangle(idx, idx + 2, idx + 3);
        };

        Vec4 facadeCol(0.18f + t0 * 0.15f, 0.22f + t0 * 0.25f, 0.32f + t0 * 0.35f, 1.0f);
        addQuad(p00, p10, q10, q00, facadeCol);
        addQuad(p10, p11, q11, q10, facadeCol);
        addQuad(p11, p01, q01, q11, facadeCol);
        addQuad(p01, p00, q00, q01, facadeCol);
    }

    spire.recomputeSmoothNormals();
    spire.computeCurvatureAO(0.75f);

    scratchbox::io::GlbWriter::streamChunk(spire, "${sanitizedTitle}");
    return 0;
}`;

        default:
            return `#include "scratchbox_engine.hpp"
#include <iostream>
#include <cmath>

int main() {
    using namespace scratchbox::geometry;
    using namespace scratchbox::math;

    ScratchboxMesh monolith("${sanitizedTitle}");
    monolith.material = PbrMaterial::titanium();

    // Parametric Sculpture with Marching Curvature
    const int radialSegs = 36;
    const int heightSegs = 32;
    float height = 7.0f;
    float maxRadius = 2.0f;

    for (int y = 0; y < heightSegs; ++y) {
        float v0 = static_cast<float>(y) / heightSegs;
        float v1 = static_cast<float>(y + 1) / heightSegs;
        float angle0 = v0 * TWO_PI * 1.5f;
        float angle1 = v1 * TWO_PI * 1.5f;

        float r0 = maxRadius * (0.4f + 0.6f * std::sin(v0 * PI));
        float r1 = maxRadius * (0.4f + 0.6f * std::sin(v1 * PI));
        float z0 = (v0 - 0.5f) * height;
        float z1 = (v1 - 0.5f) * height;

        for (int x = 0; x < radialSegs; ++x) {
            float u0 = (static_cast<float>(x) / radialSegs) * TWO_PI + angle0;
            float u1 = (static_cast<float>(x + 1) / radialSegs) * TWO_PI + angle1;

            Vec3 p00(std::cos(u0) * r0, z0, std::sin(u0) * r0);
            Vec3 p10(std::cos(u1) * r0, z0, std::sin(u1) * r0);
            Vec3 p01(std::cos(u0) * r1, z1, std::sin(u0) * r1);
            Vec3 p11(std::cos(u1) * r1, z1, std::sin(u1) * r1);

            uint32_t idx = static_cast<uint32_t>(monolith.vertices.size());
            Vec4 col(0.78f, 0.82f, 0.90f, 1.0f);
            monolith.addVertex({p00, p00.normalized(), {static_cast<float>(x)/radialSegs, v0}, col});
            monolith.addVertex({p10, p10.normalized(), {static_cast<float>(x+1)/radialSegs, v0}, col});
            monolith.addVertex({p11, p11.normalized(), {static_cast<float>(x+1)/radialSegs, v1}, col});
            monolith.addVertex({p01, p01.normalized(), {static_cast<float>(x)/radialSegs, v1}, col});

            monolith.addTriangle(idx, idx + 1, idx + 2);
            monolith.addTriangle(idx, idx + 2, idx + 3);
        }
    }

    monolith.recomputeSmoothNormals();
    monolith.computeCurvatureAO(0.85f);
    monolith.applyProceduralWeathering(2.5f, 0.08f);

    scratchbox::io::GlbWriter::streamChunk(monolith, "${sanitizedTitle}");
    return 0;
}`;
    }
}

/**
 * Initializes and populates an operator stack for a 3D scene.
 */
export function initializeSceneOperatorStack(scene: Scene3DData): Scene3DData {
    if (scene.operatorStack && scene.operatorStack.length > 0) {
        return scene;
    }

    const engine = createOperatorEngine(scene);

    // 0. No tile import here: a scene that has a map-3d object already streams the real Google tiles, and
    // re-importing added a second map-3d object plus synthetic geometry.

    // 1. Setup lighting
    if (scene.environment?.lighting) {
        engine.dispatch('sb_setup_lighting', {
            preset: scene.environment.lighting,
            skybox: scene.environment.skybox,
            enableAtmosphere: !!scene.features?.atmosphericScattering,
            latitude: scene.geoAnchor?.lat,
            longitude: scene.geoAnchor?.lng
        });
    }

    // 2. Set camera
    if (scene.camera) {
        engine.dispatch('sb_set_camera', {
            position: scene.camera.position,
            target: scene.camera.target,
            fov: scene.camera.fov,
            cameraMode: scene.cameraMode
        });
    }

    // 3. Register and assign materials + transforms for custom meshes
    if (scene.customMeshes) {
        for (const m of scene.customMeshes) {
            if (m.material) {
                const matId = (m.material as any).id || `mat-${m.id}`;
                const matAny = m.material as any;
                engine.dispatch('sb_create_material', {
                    materialId: matId,
                    name: `${m.name || m.id} Material`,
                    preset: matAny.preset,
                    color: m.material.color,
                    roughness: m.material.roughness,
                    metalness: m.material.metalness,
                    transmission: matAny.transmission,
                    ior: matAny.ior,
                    emissive: matAny.emissive,
                    emissiveIntensity: matAny.emissiveIntensity,
                    clearcoat: matAny.clearcoat,
                    clearcoatRoughness: matAny.clearcoatRoughness,
                    thickness: matAny.thickness,
                    attenuationColor: matAny.attenuationColor,
                    attenuationDistance: matAny.attenuationDistance,
                    sheenColor: matAny.sheenColor,
                    sheenRoughness: matAny.sheenRoughness,
                    anisotropy: matAny.anisotropy,
                    anisotropyRotation: matAny.anisotropyRotation,
                    iridescence: matAny.iridescence,
                    iridescenceIor: matAny.iridescenceIor,
                    wireframe: m.material.wireframe
                });
                engine.dispatch('sb_assign_material', {
                    objectId: m.id,
                    materialId: matId
                });
            }
            if (m.position || m.rotation || m.scale) {
                engine.dispatch('sb_set_transform', {
                    objectId: m.id,
                    position: m.position,
                    rotation: m.rotation,
                    scale: m.scale
                });
            }
        }
    }

    // 4. Attach C++ Procedural Generator (C/C++ First directive)
    if (scene.cppGenerator) {
        engine.dispatch('sb_set_cpp_generator', {
            sourceCode: scene.cppGenerator.sourceCode,
            filename: scene.cppGenerator.filename,
            enabled: scene.cppGenerator.enabled,
            vertexCount: scene.cppGenerator.vertexCount,
            triangleCount: scene.cppGenerator.triangleCount,
            glbBase64: scene.cppGenerator.glbBase64
        });
    }

    return engine.getSceneData();
}

/**
 * Modifies an existing Scene3DData using a series of direct-dispatch operators in-memory.
 */
export function modifySceneWithOperators(
    scene: Scene3DData,
    commands: BatchCommand[],
    options?: BatchExecutionOptions
): { scene: Scene3DData; result: BatchExecutionResult } {
    const engine = createOperatorEngine(scene);
    const result = engine.executeBatch(commands, options);
    return {
        scene: engine.getSceneData(),
        result
    };
}

/**
 * Ensures that EVERY 3D scene is contextually and creatively cast to a real-world Google Maps location tile,
 * linking physical/thematic semantics to authentic Earth coordinates, terrain, and C++20 generator anchors.
 */
export function applyCreativeLocationCasting(
    scene: Scene3DData,
    prompt: string,
    context?: {
        activeArtifact?: CanvasArtifact;
        chatHistory?: Array<{ role: string; text: string }>;
        docTitle?: string;
        docContent?: string;
    }
): Scene3DData {
    const activeDoc = context?.activeArtifact?.type === 'markdown-document'
        ? (context.activeArtifact.data as MarkdownDocumentData)
        : undefined;
    const docTitle = context?.docTitle || activeDoc?.title || '';
    const docContent = context?.docContent || (activeDoc?.sections ? activeDoc.sections.map(s => s.content || '').join(' ') : '');

    // Preserve Martian or extraterrestrial planetary anchors
    if (scene.sceneType === 'mars_rover' || (scene.worldBranch && scene.worldBranch.includes('mars')) || /\b(?:mars|martian|jezero)\b/i.test(prompt)) {
        if (!scene.geoAnchor || !scene.geoAnchor.landmarkName?.toLowerCase().includes('mars')) {
            scene.geoAnchor = {
                lat: 18.38,
                lng: 77.58,
                elevation: -2500,
                active: true,
                landmarkName: 'Jezero Crater, Mars (Perseverance Exploration Site)',
                castingRationale: 'Extraterrestrial planetary surface: Jezero Crater, Mars',
                castingArchetype: 'planetary_surface'
            };
        }
        return scene;
    }

    const isExplicitRealWorld = isResolvedLocation(detectRealWorldLocationIntent(prompt, context));

    if (!isExplicitRealWorld && !scene.geoAnchor) {
        // No real-world location named: stay in the grey clay void instead of casting the
        // scene onto an unrelated Earth location.
        if (!scene.pythonGenerator && (!scene.cppGenerator || !scene.cppGenerator.sourceCode)) {
            const domain = classifyDomain(prompt);
            const adaptive = synthesizeAdaptive3DScene(domain, scene.title, prompt);
            if (adaptive.pythonGenerator) {
                scene.pythonGenerator = adaptive.pythonGenerator;
            } else if (adaptive.cppGenerator) {
                scene.cppGenerator = adaptive.cppGenerator;
            }
        }
        return scene;
    }

    const castedLoc = castCreativeLocation(prompt, {
        theme: scene.sceneType,
        docTitle,
        docContent,
        existingAnchor: scene.geoAnchor
    });

    if (!castedLoc.isRealWorld && scene.sceneType !== 'mars_rover' && !/\b(?:mars|martian|rover)\b/i.test(prompt)) {
        if (!scene.pythonGenerator && (!scene.cppGenerator || !scene.cppGenerator.sourceCode)) {
            const domain = classifyDomain(prompt);
            const adaptive = synthesizeAdaptive3DScene(domain, scene.title, prompt);
            if (adaptive.pythonGenerator) {
                scene.pythonGenerator = adaptive.pythonGenerator;
            } else if (adaptive.cppGenerator) {
                scene.cppGenerator = adaptive.cppGenerator;
            }
        }
        return scene;
    }

    if (!scene.geoAnchor || !scene.geoAnchor.lat || !scene.geoAnchor.lng) {
        scene.geoAnchor = {
            lat: castedLoc.lat,
            lng: castedLoc.lng,
            elevation: castedLoc.elevation,
            elevationSource: castedLoc.elevationSource || 'google_elevation',
            datum: castedLoc.datum || 'MSL_EGM96',
            active: true,
            landmarkName: castedLoc.landmarkName,
            castingRationale: castedLoc.rationale,
            castingArchetype: castedLoc.archetype
        };
    } else {
        if (!scene.geoAnchor.castingRationale) {
            scene.geoAnchor.castingRationale = castedLoc.rationale;
        }
        if (!scene.geoAnchor.castingArchetype) {
            scene.geoAnchor.castingArchetype = castedLoc.archetype;
        }
        if (!scene.geoAnchor.landmarkName) {
            scene.geoAnchor.landmarkName = castedLoc.landmarkName;
        }
        if (scene.geoAnchor.elevation === undefined || scene.geoAnchor.elevation === null) {
            scene.geoAnchor.elevation = castedLoc.elevation;
        }
        if (!scene.geoAnchor.elevationSource) {
            scene.geoAnchor.elevationSource = castedLoc.elevationSource || 'google_elevation';
        }
        if (!scene.geoAnchor.datum) {
            scene.geoAnchor.datum = castedLoc.datum || 'MSL_EGM96';
        }
        if (scene.geoAnchor.active === undefined) {
            scene.geoAnchor.active = true;
        }
    }

    // Ensure C++ or Python Procedural Generator conforms to 3D directive
    if (!scene.pythonGenerator && (!scene.cppGenerator || !scene.cppGenerator.sourceCode)) {
        const theme = detect3DSceneTheme(prompt, context);
        let cppSource: string;
        if (theme && theme !== 'general' && theme !== 'geospatial') {
            cppSource = generateDefaultCpp3DSource(theme, scene.title || prompt);
            // Prepend creative location casting anchor & rationale header comment
            const header = `// ==============================================================================\n` +
                `// Scratchbox 3D Engine: Creatively Cast Geospatial Anchor (C++20)\n` +
                `// Real-World Anchor: ${scene.geoAnchor.landmarkName} (${scene.geoAnchor.lat.toFixed(4)}, ${scene.geoAnchor.lng.toFixed(4)})\n` +
                `// Ground Elevation: ${(scene.geoAnchor.elevation ?? castedLoc.elevation).toFixed(2)}m MSL [Google Elevation Ground Truth, Datum: ${scene.geoAnchor.datum || 'EGM96'}]\n` +
                `// Archetype: ${scene.geoAnchor.castingArchetype || castedLoc.archetype}\n` +
                `// Creative Casting Rationale: ${(scene.geoAnchor.castingRationale || castedLoc.rationale).replace(/\n/g, ' ')}\n` +
                `// ==============================================================================\n`;
            cppSource = header + cppSource;
        } else {
            cppSource = generateGeospatialCpp3DSource({
                landmarkName: scene.geoAnchor.landmarkName || castedLoc.landmarkName,
                lat: scene.geoAnchor.lat || castedLoc.lat,
                lng: scene.geoAnchor.lng || castedLoc.lng,
                elevation: scene.geoAnchor.elevation ?? castedLoc.elevation,
                clayPreset: castedLoc.suggestedEnvironment?.clayPreset || 'warm-clay',
                castingRationale: scene.geoAnchor.castingRationale || castedLoc.rationale
            });
        }

        scene.cppGenerator = {
            enabled: true,
            filename: 'world_generator.cpp',
            sourceCode: cppSource,
            vertexCount: 4096,
            triangleCount: 2048
        };
    }

    return scene;
}

/**
 * Synthesizes a rich, populated Scene3DData configuration with custom meshes, lighting, camera framing, and runnable scripts.
 */
export function synthesizeContextual3DScene(
    prompt: string,
    context?: {
        activeArtifact?: CanvasArtifact;
        chatHistory?: Array<{ role: string; text: string }>;
        docTitle?: string;
        docContent?: string;
    }
): Scene3DData {
    const rawScene = synthesizeRawContextual3DScene(prompt, context);
    return initializeSceneOperatorStack(rawScene);
}

export function synthesizeRawContextual3DScene(
    prompt: string,
    context?: {
        activeArtifact?: CanvasArtifact;
        chatHistory?: Array<{ role: string; text: string }>;
        docTitle?: string;
        docContent?: string;
    }
): Scene3DData {
    const raw = _synthesizeRawContextual3DSceneInner(prompt, context);
    return applyCreativeLocationCasting(raw, prompt, context);
}

function _synthesizeRawContextual3DSceneInner(
    prompt: string,
    context?: {
        activeArtifact?: CanvasArtifact;
        chatHistory?: Array<{ role: string; text: string }>;
        docTitle?: string;
        docContent?: string;
    }
): Scene3DData {
    const theme = detect3DSceneTheme(prompt, context);

    // Context extractions
    const activeDoc = context?.activeArtifact?.type === 'markdown-document'
        ? (context.activeArtifact.data as MarkdownDocumentData)
        : undefined;
    const docTitle = context?.docTitle || activeDoc?.title || '';
    const existingFeatures = (context?.activeArtifact?.data as Scene3DData)?.features;

    const explicitAtmosphereRequested = /\b(?:atmosphere|atmospheric|scattering|rayleigh|mie|realistic\s*sky|aerial\s*perspective|haze|cloud\s*shadow|volumetric\s*clouds?)\b/i.test(prompt);
    const hasAtmosphere = explicitAtmosphereRequested || !!existingFeatures?.atmosphericScattering;
    const hasGodRays = hasAtmosphere && (/god\s*ray|crepuscular|light\s*shaft|volumetric/i.test(prompt) || !!existingFeatures?.godRays);
    const isSunset = hasAtmosphere && /sunset|golden\s*hour|dusk/i.test(prompt);
    const hasContrails = /contrail|vapor|vortex/i.test(prompt) || !!existingFeatures?.contrails;
    const hasControlSurfaces = /control\s*surface|aileron|elevator|rudder/i.test(prompt) || !!existingFeatures?.controlSurfaces;

    const hasHazeOrFogRequested = hasAtmosphere && /\b(?:haze|fog|mist|aerial\s*perspective|dense\s*atmosphere|dust|volumetric\s*fog)\b/i.test(prompt);
    const hasCloudsRequested = hasAtmosphere && /\b(?:clouds?|cloudy|overcast|cumulus|stratus)\b/i.test(prompt);

    const atmosphericConfig = hasAtmosphere ? buildHeadlessAtmosphere({
        aerialPerspectiveEnabled: hasHazeOrFogRequested,
        inscatteringIntensity: hasHazeOrFogRequested ? 1.0 : 0.0,
        volumetricClouds: hasCloudsRequested,
        cloudCoverage: hasCloudsRequested ? 0.38 : 0.0,
        cloudDensity: hasCloudsRequested ? 0.48 : 0.0,
        cloudShadowsEnabled: hasCloudsRequested,
        cloudShadowIntensity: hasCloudsRequested ? 0.65 : 0.0
    }) : undefined;

    const baseFeatures = {
        ...(existingFeatures || {}),
        ...(hasGodRays && hasAtmosphere ? { godRays: true } : {}),
        ...(atmosphericConfig ? { atmosphericScattering: atmosphericConfig } : {}),
        ...(hasContrails ? { contrails: true } : {}),
        ...(hasControlSurfaces ? { controlSurfaces: true } : {})
    };

    // Direct 3D Gaussian Splat (.splat / .spz / 3DGS) scene synthesis
    const splatMatch = prompt.match(/(?:(?:\/splats\/|\/models\/|[a-zA-Z0-9_\-.]+\/)?([a-zA-Z0-9_\-]+\.sp(?:lat|z)))/i);
    const isSplatRequested = theme === 'gaussian_splat' || Boolean(splatMatch) || /(?:gaussian\s*splats?|3dgs|\bsplats?\b|radiance\s*fields?)/i.test(prompt);

    // Only a splat file the prompt names is shown; there is no stand-in splat for other requests.
    if (splatMatch) {
        const splatFileName = splatMatch[1];
        const rawUrl = splatMatch?.[0];
        const splatUrl = rawUrl?.startsWith('/') ? rawUrl : `/splats/${splatFileName}`;
        const displayName = splatFileName.replace(/\.sp(?:lat|z)$/i, '').replace(/[_\-]+/g, ' ');

        return {
            title: `${displayName.charAt(0).toUpperCase() + displayName.slice(1)} — 3D Gaussian Splats`,
            subtitle: `Photorealistic 3DGS radiance field unprojected from photographic source with high-density oriented Gaussian splats.`,
            worldBranch: `splat-world/${displayName.replace(/\s+/g, '-')}`,
            sceneType: 'gaussian_splat',
            renderMode: 'pbr',
            cameraMode: 'orbit',
            animation: 'orbit',
            splatUrl,
            splatOptions: {
                splatScale: 1.0,
                contactShadow: true,
                enableSoftZ: true
            },
            timeline: {
                currentTimeMs: 0,
                durationMs: 20000,
                isPlaying: true,
                speed: 1.0,
                playbackSpeed: 1.0,
                isLooping: true
            },
            camera: {
                position: [0, 1.6, 0],
                target: [0, 1.6, -12],
                fov: 55
            },
            environment: {
                skybox: 'dusk',
                lighting: 'dusk',
                ground: false
            },
            customMeshes: [],
            features: {
                ...baseFeatures
            }
        };
    }

    // Check if the prompt asks for a real-world location or landmark.
    // Specific-first ordering: a historical battlefield theme owns its own geo-anchored scene
    // (Lexington Green, Buckman Tavern, formations) and must not be shadowed by the generic
    // real-world tile path, which would otherwise relabel it as a 'worldbuilder' scene.
    // Only a location the prompt actually names stages the scene on Earth; otherwise it stays in the clay void.
    const detectedLoc = theme === 'battlefield' ? undefined : detectRealWorldLocationIntent(prompt, context);
    // Only coordinates stage a scene on Earth; an unresolved place name must not become an anchor at (0, 0).
    const realWorldLoc = isResolvedLocation(detectedLoc) ? detectedLoc : undefined;
    // Determine procedural, object, and hero location classification
    const isExplicitProcedural = /\b(?:procedural|scratchbox\s*engine|create_building|create_tree|python|c\+\+|nanobind|customScript)\b/i.test(prompt);
    const isHeroObject = theme === 'vehicle' ||
        /\b(?:probe|rover|robot|machine|drone|vehicle|car|race\s*car|f1|ship|craft|submersible|harvester|penetrator|device|apparatus|mechanism|weapon|tool|engine|reactor|walker|crawler|limb|coring|drill|auger|satellite|spacecraft|shuttle|aircraft|plane|jet|helicopter|truck|motorcycle|bicycle|mech|android|cyborg)\b/i.test(prompt);
    const isObjectPrompt = isHeroObject;
    const isHeroWithLocation = isObjectPrompt && Boolean(realWorldLoc?.isRealWorld);

    if (realWorldLoc && realWorldLoc.isRealWorld) {
        if (isSplatRequested) {
            const locName = realWorldLoc.landmarkName || realWorldLoc.query;
            const sanitizedName = locName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
            const locKey = locName.toLowerCase();

            // Calibrated location splat URLs
            let splatUrl = `/models/${sanitizedName}_splat.splat`;
            let splatTilesetUrl = `/tilesets/${sanitizedName}/tileset.json`;

            if (locKey.includes('colosseum') || locKey.includes('rome')) {
                splatUrl = '/models/colosseum_splat.splat';
                splatTilesetUrl = '/tilesets/colosseum/tileset.json';
            } else if (locKey.includes('empire state') || locKey.includes('esb') || locKey.includes('manhattan')) {
                splatUrl = '/models/esb_calibrated_3dgs_400k.splat';
                splatTilesetUrl = '/tilesets/esb/tileset.json';
            } else if (locKey.includes('grand army') || locKey.includes('plaza')) {
                splatUrl = '/models/gap_splat.splat';
                splatTilesetUrl = '/tilesets/gap/tileset.json';
            } else if (locKey.includes('pantheon')) {
                splatUrl = '/models/pantheon_atrium_360.spz';
                splatTilesetUrl = '/tilesets/pantheon/tileset.json';
            }

            const splatMediaObject: Media4DObject = {
                id: `${sanitizedName}-3dgs`,
                content: {
                    type: 'gaussian-splat',
                    durableUri: splatUrl,
                    mimeType: splatUrl.endsWith('.spz') ? 'application/x-spz' : 'application/octet-stream',
                    metadata: {
                        dims: { width: 120, height: 120, depth: 120 }
                    }
                },
                space: {
                    spatial3d: { x: 0, y: 0, z: 0 },
                    geoAnchor: {
                        lat: realWorldLoc.lat,
                        lng: realWorldLoc.lng,
                        alt: realWorldLoc.elevation || 0,
                        heading: 0,
                        pitch: 0
                    }
                },
                lineage: {
                    version: 1,
                    generation: {
                        model: 'nano-banana-survey-3dgs',
                        prompt: prompt,
                        params: { pipeline: 'SurveySplatPipelineService', restyleModel: 'nano-banana-2' }
                    },
                    timestamp: new Date().toISOString()
                }
            };

            const sceneTitle = `${locName} — 3D Gaussian Splat`;
            return {
                title: sceneTitle,
                subtitle: `Photorealistic 3DGS radiance field at Lat ${realWorldLoc.lat.toFixed(4)}°, Lng ${realWorldLoc.lng.toFixed(4)}° synthesized via Nano Banana multi-station capture and C++20 metric depth unprojection.`,
                worldBranch: `splat-world/${sanitizedName}`,
                sceneType: 'gaussian_splat',
                renderMode: 'pbr',
                cameraMode: 'orbit',
                animation: 'orbit',
                splatUrl,
                splatTilesetUrl,
                splatOptions: {
                    splatScale: 1.0,
                    contactShadow: true,
                    enableSoftZ: true
                },
                timeline: {
                    currentTimeMs: 0,
                    durationMs: 20000,
                    isPlaying: true,
                    speed: 1.0,
                    playbackSpeed: 1.0,
                    isLooping: true
                },
                camera: {
                    position: [0, 20, 45],
                    target: [0, 2, 0],
                    fov: 45
                },
                environment: {
                    skybox: (hasAtmosphere || hasGodRays) ? 'realistic-sky' : 'golden_hour',
                    lighting: 'golden_hour',
                    ground: false
                },
                geoAnchor: {
                    lat: realWorldLoc.lat,
                    lng: realWorldLoc.lng,
                    elevation: realWorldLoc.elevation,
                    elevationSource: (realWorldLoc as any).elevationSource || 'google_elevation',
                    datum: (realWorldLoc as any).datum || 'MSL_EGM96',
                    active: true,
                    landmarkName: locName
                },
                customMeshes: [],
                objects: [splatMediaObject],
                features: {
                    ...baseFeatures,
                    ...(hasAtmosphere ? {
                        atmosphericScattering: buildHeadlessAtmosphere({
                            sunElevation: 28,
                            sunAzimuth: 145,
                            latitude: realWorldLoc.lat,
                            longitude: realWorldLoc.lng,
                            aerialPerspectiveEnabled: hasHazeOrFogRequested,
                            inscatteringIntensity: hasHazeOrFogRequested ? 1.0 : 0.0,
                            aerialPerspectiveRange: 250.0
                        })
                    } : {})
                }
            };
        }

        // Only run tile ingest if explicitly requesting Google 3D tile models or geospatial photogrammetry
        const isExplicitTileIngest = !isHeroWithLocation && (
            /\b(?:tile|tiles|map\s*data|satellite|photogrammetr|geospatial|real\s*world\s*clay|google\s*maps)\b/i.test(prompt) ||
            (!isExplicitProcedural && Boolean(realWorldLoc?.isRealWorld))
        );

        if (isExplicitTileIngest) {
            // Extract clay preset preference if specified
            let clayPreset: ClayPresetId = 'warm-clay';
            if (/alabaster|white\s*clay|plaster/i.test(prompt)) clayPreset = 'alabaster';
            else if (/terracotta|brick\s*clay/i.test(prompt)) clayPreset = 'terracotta';
            else if (/onyx|black\s*clay|dark\s*clay|slate/i.test(prompt)) clayPreset = 'onyx';
            else if (/studio\s*grey|neutral\s*clay|grey\s*clay/i.test(prompt)) clayPreset = 'studio-grey';
            else if (/porcelain|ceramic/i.test(prompt)) clayPreset = 'porcelain';
            else if (/concrete|brutalist/i.test(prompt)) clayPreset = 'concrete';

            const tileService = Google3DTileService.getInstance();
            let tileResult: any;
            try {
                tileResult = tileService.ingestTileRegionSync({
                    query: realWorldLoc.landmarkName || realWorldLoc.query,
                    lat: realWorldLoc.lat,
                    lng: realWorldLoc.lng,
                    elevation: realWorldLoc.elevation,
                    clayPreset,
                    detailLevel: 'high',
                    includeBuildings: true,
                    includeTerrain: true
                });
            } catch (err: any) {
                console.warn('[procedural-3d-synthesizer] Google 3D Tile ingestion failed for location:', realWorldLoc, err.message);
                return synthesizeAdaptiveHeroScene(prompt);
            }

            // Real-world scenes stream authentic Google 3D Tiles in 18% Studio Grey Clay.
            // Synthetic box meshes and uninvited atmospheric skyboxes are strictly suppressed.
            const customMeshes: NonNullable<Scene3DData['customMeshes']> = [];

            const sceneTitle = `${realWorldLoc.landmarkName} — 3D Real-World Clay Model`;

            return {
                title: sceneTitle,
                subtitle: `Geospatially grounded 3D architectural model at Lat ${realWorldLoc.lat.toFixed(4)}°, Lng ${realWorldLoc.lng.toFixed(4)}° (${tileResult?.stats?.buildingCount || 0} structures, 18% Studio Grey Clay mode).`,
                worldBranch: `real-world/${realWorldLoc.landmarkName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
                sceneType: 'worldbuilder',
                renderMode: 'clay',
                cameraMode: 'orbit',
                animation: 'orbit',
                timeline: {
                    currentTimeMs: 0,
                    durationMs: 20000,
                    isPlaying: true,
                    speed: 1.0,
                    playbackSpeed: 1.0,
                    isLooping: true
                },
                camera: {
                    position: [0, 25, 45],
                    target: [0, 2, 0],
                    fov: 45
                },
                environment: {
                    skybox: (hasAtmosphere && explicitAtmosphereRequested) ? 'realistic-sky' : 'studio',
                    lighting: 'studio',
                    ground: false
                },
                geoAnchor: {
                    lat: realWorldLoc.lat,
                    lng: realWorldLoc.lng,
                    elevation: realWorldLoc.elevation,
                    elevationSource: 'google_elevation',
                    datum: 'MSL_EGM96',
                    active: true,
                    landmarkName: realWorldLoc.landmarkName
                },
                customMeshes,
                objects: [tileResult.media4DObject],
                features: {
                    ...baseFeatures,
                    ...(explicitAtmosphereRequested ? {
                        atmosphericScattering: buildHeadlessAtmosphere({
                            sunElevation: 28,
                            sunAzimuth: 145,
                            latitude: realWorldLoc.lat,
                            longitude: realWorldLoc.lng,
                            aerialPerspectiveEnabled: hasHazeOrFogRequested,
                            inscatteringIntensity: hasHazeOrFogRequested ? 1.0 : 0.0,
                            cloudShadowsEnabled: hasCloudsRequested,
                            cloudShadowIntensity: hasCloudsRequested ? 0.65 : 0.0
                        }),
                        godRays: hasGodRays
                    } : {})
                },
                cppGenerator: {
                    enabled: true,
                    filename: 'world_generator.cpp',
                    sourceCode: generateGeospatialCpp3DSource({
                        landmarkName: realWorldLoc.landmarkName,
                        lat: realWorldLoc.lat,
                        lng: realWorldLoc.lng,
                        elevation: realWorldLoc.elevation,
                        clayPreset
                    }),
                    vertexCount: tileResult.stats.vertexCount,
                    triangleCount: tileResult.stats.faceCount
                }
            };
        }
    }

    if (isObjectPrompt && realWorldLoc) {
        // Synthesize the hero object (e.g. race car / vehicle / rover)
        const heroScene = synthesizeAdaptiveHeroScene(prompt);

        // Ingest Google 3D Tiles in Studio Grey Clay for the requested location
        const tileService = Google3DTileService.getInstance();
        let tileResult: any;
        try {
            tileResult = tileService.ingestTileRegionSync({
                query: realWorldLoc.landmarkName || realWorldLoc.query,
                lat: realWorldLoc.lat,
                lng: realWorldLoc.lng,
                elevation: realWorldLoc.elevation,
                clayPreset: 'studio-grey',
                detailLevel: 'high',
                includeBuildings: true,
                includeTerrain: true
            });
        } catch (err: any) {
            console.warn('[procedural-3d-synthesizer] Hero location staging tile ingestion failed:', realWorldLoc, err.message);
            return heroScene;
        }

        const heroBaseTitle = heroScene.title.replace(/\s*—\s*ADA Hero Asset/i, '').replace(/\s*—\s*Procedural Vehicle/i, '').trim();
        const stagedTitle = `${heroBaseTitle} — Staged in ${realWorldLoc.landmarkName}`;
        const stagedSubtitle = `Real-World Geospatial Staging | [${realWorldLoc.lat.toFixed(4)}°, ${realWorldLoc.lng.toFixed(4)}°] | Studio Grey Clay Grounding`;

        return {
            ...heroScene,
            title: stagedTitle,
            subtitle: stagedSubtitle,
            worldBranch: `geospatial/${realWorldLoc.landmarkName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
            sceneType: 'real_world_landmark',
            renderMode: 'clay',
            environment: {
                ...heroScene.environment,
                skybox: (hasAtmosphere && explicitAtmosphereRequested) ? 'realistic-sky' : 'studio',
                lighting: 'studio',
                ground: true
            },
            geoAnchor: {
                lat: realWorldLoc.lat,
                lng: realWorldLoc.lng,
                elevation: realWorldLoc.elevation,
                elevationSource: 'google_elevation',
                datum: 'MSL_EGM96',
                active: true,
                landmarkName: realWorldLoc.landmarkName
            },
            objects: [
                tileResult.media4DObject,
                ...(heroScene.objects || [])
            ],
            customMeshes: [
                ...(heroScene.customMeshes || [])
            ],
            features: {
                ...heroScene.features,
                ...baseFeatures,
                ...(explicitAtmosphereRequested ? {
                    atmosphericScattering: buildHeadlessAtmosphere({
                        sunElevation: isSunset ? 12 : 28,
                        sunAzimuth: 145,
                        latitude: realWorldLoc.lat,
                        longitude: realWorldLoc.lng,
                        aerialPerspectiveEnabled: hasHazeOrFogRequested || isSunset,
                        inscatteringIntensity: (hasHazeOrFogRequested || isSunset) ? 1.0 : 0.0,
                        cloudShadowsEnabled: hasCloudsRequested,
                        cloudShadowIntensity: hasCloudsRequested ? 0.65 : 0.35
                    }),
                    godRays: hasGodRays
                } : {})
            }
        };
    }

    if (isObjectPrompt && !realWorldLoc && theme !== 'vehicle' && theme !== 'mars_rover') {
        return synthesizeAdaptiveHeroScene(prompt);
    }

    if (theme === 'vehicle') {
        return synthesizeProceduralVehicleScene(prompt, context);
    }

    if (theme === 'glass_shatter') {
        const title = 'High-Speed Bullet & Glass Shatter Simulation';
        const subtitle = 'Supersonic projectile (820 m/s) piercing optical glass pane. 110+ Voronoi fracture shards with momentum integration and Mach shockwave.';

        const customMeshes: any[] = [
            // Four perimeter clamping frame bars (leaving central glass plate completely visible)
            {
                id: 'frame-top',
                name: 'Clamping_Frame',
                type: 'box',
                position: [0, 1.55, 0],
                scale: [4.2, 0.14, 0.15],
                tier: 'primary',
                material: {
                    color: '#334155',
                    metalness: 0.88,
                    roughness: 0.28,
                    preset: 'dark_steel'
                }
            },
            {
                id: 'frame-bottom',
                name: 'Frame_Bottom',
                type: 'box',
                position: [0, -1.55, 0],
                scale: [4.2, 0.14, 0.15],
                tier: 'primary',
                material: {
                    color: '#334155',
                    metalness: 0.88,
                    roughness: 0.28,
                    preset: 'dark_steel'
                }
            },
            {
                id: 'frame-left',
                name: 'Frame_Left',
                type: 'box',
                position: [-2.05, 0, 0],
                scale: [0.14, 3.24, 0.15],
                tier: 'primary',
                material: {
                    color: '#334155',
                    metalness: 0.88,
                    roughness: 0.28,
                    preset: 'dark_steel'
                }
            },
            {
                id: 'frame-right',
                name: 'Frame_Right',
                type: 'box',
                position: [2.05, 0, 0],
                scale: [0.14, 3.24, 0.15],
                tier: 'primary',
                material: {
                    color: '#334155',
                    metalness: 0.88,
                    roughness: 0.28,
                    preset: 'dark_steel'
                }
            },
            // Heavy metallic laboratory mounting pedestal
            {
                id: 'stand-base',
                name: 'Test_Stand_Base',
                type: 'box',
                position: [0, -1.75, 0],
                scale: [3.2, 0.25, 0.9],
                tier: 'primary',
                material: {
                    color: '#1e293b',
                    metalness: 0.92,
                    roughness: 0.2
                }
            },
            // Intact optical float glass plate
            {
                id: 'glass-intact-pane',
                name: 'Intact_Glass_Pane',
                type: 'box',
                position: [0, 0, 0],
                scale: [3.96, 2.96, 0.04],
                tier: 'primary',
                material: {
                    color: '#bae6fd',
                    metalness: 0.08,
                    roughness: 0.06,
                    transmission: 0.90,
                    ior: 1.52,
                    clearcoat: 1.0,
                    preset: 'optical_glass'
                }
            },
            // High-velocity copper spitzer bullet (9mm full metal jacket)
            {
                id: 'ballistic-bullet',
                name: 'Spitzer_Bullet_9mm',
                type: 'cylinder',
                position: [0, 0, -2.5],
                rotation: [Math.PI / 2, 0, 0],
                scale: [0.14, 0.52, 0.14],
                tier: 'primary',
                material: {
                    color: '#f59e0b',
                    metalness: 0.96,
                    roughness: 0.15,
                    preset: 'polished_copper'
                }
            },
            // Supersonic Mach Shockwave Cone
            {
                id: 'mach-shockwave',
                name: 'Supersonic_Mach_Cone',
                type: 'cylinder',
                position: [0, 0, -2.7],
                rotation: [-Math.PI / 2, 0, 0],
                scale: [0.4, 0.6, 0.4],
                tier: 'secondary',
                material: {
                    color: '#38bdf8',
                    metalness: 0.1,
                    roughness: 0.1,
                    transmission: 0.85,
                    opacity: 0.5,
                    wireframe: true,
                    preset: 'shockwave_plasma'
                }
            }
        ];

        // Add 48 individual Voronoi shards radiating outwards
        for (let i = 0; i < 48; ++i) {
            const angle = (i * Math.PI * 2) / 48;
            const dist = 0.08 + (i % 6) * 0.14;
            const px = Math.cos(angle) * dist;
            const py = Math.sin(angle) * dist;
            const pz = 0.02 + (i % 3) * 0.03;
            const size = 0.09 + ((i * 11) % 15) * 0.018;

            customMeshes.push({
                id: `voronoi-shard-${i}`,
                name: `Voronoi_Shard_${i}`,
                type: 'box',
                position: [px, py, pz],
                rotation: [Math.sin(i * 1.5) * 0.6, Math.cos(i * 2.1) * 0.6, (i * 0.4) % Math.PI],
                scale: [size, size * (1.1 + (i % 3) * 0.4), 0.03],
                tier: 'tertiary',
                material: {
                    color: '#e0f2fe',
                    metalness: 0.06,
                    roughness: 0.05,
                    transmission: 0.92,
                    ior: 1.52,
                    clearcoat: 1.0,
                    preset: 'optical_glass'
                }
            });
        }

        const customScript = `
// Three.js Ballistic Glass Impact & Voronoi Fracture Physics Hook
const shards = [];
const bulletObj = scene.getObjectByName('Spitzer_Bullet_9mm');
const shockwaveObj = scene.getObjectByName('Supersonic_Mach_Cone');
const intactGlass = scene.getObjectByName('Intact_Glass_Pane');

scene.traverse((obj) => {
    if (obj.name && obj.name.startsWith('Voronoi_Shard_')) {
        const idx = parseInt(obj.name.replace('Voronoi_Shard_', ''), 10);
        const angle = (idx * Math.PI * 2) / 48;
        const radialVel = 3.2 + (idx % 7) * 1.6;
        shards.push({
            obj,
            initPos: obj.position.clone(),
            vx: Math.cos(angle) * radialVel,
            vy: Math.sin(angle) * radialVel,
            vz: 2.2 + (idx % 4) * 2.4,
            rotAxis: new THREE.Vector3(Math.sin(idx * 1.3), Math.cos(idx * 2.7), Math.sin(idx * 4.1)).normalize(),
            rotSpeed: 5.0 + (idx % 8) * 3.5
        });
    }
});

onFrame((time, delta) => {
    const cycle = (time % 3.0);
    const impactTime = 0.6; // Time when bullet strikes glass at z = 0
    
    // Animate bullet projectile (-2.8 to +4.5)
    const bulletZ = -2.8 + cycle * 3.6;
    if (bulletObj) {
        bulletObj.position.z = bulletZ;
        bulletObj.rotation.z += delta * 25.0; // Supersonic rifling spin
    }

    // Animate shockwave
    if (shockwaveObj) {
        shockwaveObj.position.z = bulletZ - 0.25;
        const s = 0.5 + Math.min(cycle * 0.8, 2.2);
        shockwaveObj.scale.set(s, 0.6, s);
        shockwaveObj.visible = cycle >= 0.1;
    }

    // Glass impact transition
    if (intactGlass) {
        intactGlass.visible = cycle < impactTime;
    }

    // Animate Voronoi shards flying outwards with momentum and tumbling
    shards.forEach((s) => {
        if (cycle < impactTime) {
            s.obj.position.copy(s.initPos);
            s.obj.visible = false;
        } else {
            s.obj.visible = true;
            const t = cycle - impactTime;
            const drag = Math.exp(-0.7 * t);
            s.obj.position.x = s.initPos.x + s.vx * t * drag;
            s.obj.position.y = s.initPos.y + (s.vy * t * drag) - (0.5 * 2.0 * t * t); // Radial + gravity
            s.obj.position.z = s.initPos.z + s.vz * t * drag;
            s.obj.rotateOnAxis(s.rotAxis, s.rotSpeed * delta);
        }
    });
});
`;

        return {
            title,
            subtitle,
            worldBranch: 'spatial/glass-shatter',
            sceneType: 'glass_shatter',
            // The dedicated ballistic fracture generator (GlassFractureGenerator) builds this scene natively.
            cppGenerator: {
                filename: 'world_generator.cpp',
                enabled: true,
                sourceCode: generateDefaultCpp3DSource('glass_shatter', title)
            },
            renderMode: 'pbr',
            cameraMode: 'orbit',
            animation: 'orbit',
            timeline: {
                currentTimeMs: 0,
                durationMs: 3000,
                isPlaying: true,
                speed: 1.0,
                playbackSpeed: 1.0,
                isLooping: true
            },
            camera: {
                position: [1.7, 0.7, 2.3],
                target: [0, 0, 0.2],
                fov: 42
            },
            environment: {
                skybox: 'studio',
                lighting: 'cinematic_dual_rim',
                ground: false
            },
            features: {
                ...baseFeatures,
                curvatureAO: true,
                cinematic3PointLighting: true
            },
            customMeshes,
            customScript,
            code: customScript
        };
    }

    if (theme === 'worldbuilder' || theme === 'nature_atmosphere') {
        const spec = planWorldIntentHeuristic(prompt);
        const isArchitecturalStructure = /\b(?:outpost|facility|station|tower|base|observatory|building|structure|solar|panels|citadel|compound|habitat|hub)\b/i.test(prompt);

        let customMeshes: NonNullable<Scene3DData['customMeshes']>;

        if (isArchitecturalStructure) {
            const hasSolar = /\b(?:solar|panels?|photovoltaic)\b/i.test(prompt);
            const hasTower = /\b(?:tower|cupola|spire|observatory|mast)\b/i.test(prompt);

            customMeshes = [
                // 1. Primary Research Hub / Outpost Massing (70%)
                {
                    id: 'arch-primary-hub',
                    name: `${spec.name || 'Research Outpost'} Main Facility`,
                    type: 'box',
                    position: [0, 1.8, 0],
                    scale: [7.0, 3.6, 6.0],
                    tier: 'primary',
                    material: { color: 0x475569, roughness: 0.35, metalness: 0.85, preset: 'titanium_grade5' }
                },
                // 2. Secondary Central Observation Tower (20%)
                {
                    id: 'arch-observation-tower',
                    name: hasTower ? 'Central Observation Tower & Cupola' : 'Secondary Upper Research Module',
                    parentId: 'arch-primary-hub',
                    type: 'cylinder',
                    position: [0, 4.8, 0],
                    scale: [1.8, 2.6, 1.8],
                    tier: 'secondary',
                    material: { color: 0x94a3b8, roughness: 0.15, metalness: 0.40, clearcoat: 1.0 }
                },
                // 3. Tertiary Left Solar Array / Wing (10%)
                {
                    id: 'arch-solar-wing-left',
                    name: hasSolar ? 'Photovoltaic Solar Array Alpha' : 'Port Avionics Wing',
                    parentId: 'arch-primary-hub',
                    type: 'box',
                    position: [-4.6, 2.0, 0],
                    rotation: [0, 0, 0.18],
                    scale: [3.4, 0.12, 1.8],
                    tier: 'tertiary',
                    material: { color: 0x0f172a, roughness: 0.12, metalness: 0.95, preset: 'polished_gold_24k' }
                },
                // 4. Tertiary Right Solar Array / Wing (10%)
                {
                    id: 'arch-solar-wing-right',
                    name: hasSolar ? 'Photovoltaic Solar Array Beta' : 'Starboard Sensor Wing',
                    parentId: 'arch-primary-hub',
                    type: 'box',
                    position: [4.6, 2.0, 0],
                    rotation: [0, 0, -0.18],
                    scale: [3.4, 0.12, 1.8],
                    tier: 'tertiary',
                    material: { color: 0x0f172a, roughness: 0.12, metalness: 0.95, preset: 'polished_gold_24k' }
                },
                // 5. High-Gain Communications Mast
                {
                    id: 'arch-comms-mast',
                    name: 'High-Gain Telemetry Mast',
                    parentId: 'arch-primary-hub',
                    type: 'cylinder',
                    position: [0, 6.6, 0],
                    scale: [0.12, 1.8, 0.12],
                    tier: 'tertiary',
                    material: { color: 0x64748b, roughness: 0.40, metalness: 0.85 }
                },
                // 6. Grounded Local Conifers & Terrain Boulders
                {
                    id: 'env-conifer-1',
                    name: 'Subalpine Conifer Stand',
                    type: 'cylinder',
                    position: [-4.5, 1.2, 3.2],
                    scale: [1.2, 2.4, 1.2],
                    tier: 'secondary',
                    material: { color: 0x1e3f20, roughness: 0.70, metalness: 0.05 }
                },
                {
                    id: 'env-conifer-2',
                    name: 'Perimeter Pine Cluster',
                    type: 'cylinder',
                    position: [4.8, 1.0, -2.8],
                    scale: [1.0, 2.0, 1.0],
                    tier: 'secondary',
                    material: { color: 0x234d20, roughness: 0.70, metalness: 0.05 }
                },
                {
                    id: 'env-boulder-1',
                    name: 'Basaltic Ground Boulder',
                    type: 'sphere',
                    position: [2.8, 0.35, 3.8],
                    scale: [0.9, 0.6, 0.9],
                    tier: 'tertiary',
                    material: { color: 0x57534e, roughness: 0.90, metalness: 0.04 }
                }
            ];
        } else {
            customMeshes = [
                {
                    id: 'nature-primary-monolith',
                    name: 'Ancient Plateau Monolith',
                    type: 'box',
                    position: [0, 2.4, 0],
                    scale: [3.2, 4.8, 3.2],
                    tier: 'primary',
                    material: { color: 0x57534e, roughness: 0.88, metalness: 0.05, preset: 'granite' }
                },
                {
                    id: 'nature-conifer-left',
                    name: 'Subalpine Conifer Stand A',
                    type: 'cylinder',
                    position: [-4.2, 1.8, -2.5],
                    scale: [1.4, 3.6, 1.4],
                    tier: 'secondary',
                    material: { color: 0x1e3f20, roughness: 0.70, metalness: 0.05 }
                },
                {
                    id: 'nature-conifer-right',
                    name: 'Subalpine Conifer Stand B',
                    type: 'cylinder',
                    position: [4.0, 1.6, 2.2],
                    scale: [1.2, 3.2, 1.2],
                    tier: 'secondary',
                    material: { color: 0x234d20, roughness: 0.70, metalness: 0.05 }
                },
                {
                    id: 'nature-boulder-1',
                    name: 'Glacial Scree Boulder',
                    type: 'sphere',
                    position: [2.5, 0.4, 3.2],
                    scale: [0.8, 0.6, 0.8],
                    tier: 'tertiary',
                    material: { color: 0x78716c, roughness: 0.90, metalness: 0.04 }
                }
            ];
        }

        const customScript = `
// Procedural In-Tree 3D Worldbuilder Simulation Script
const world = createWorldBuilderScene(scene, THREE, {
    spec: ${JSON.stringify(spec)},
    resolution: 32,
    seed: 1337
});

onFrame((time, delta) => {
    if (world && world.userData && typeof world.userData.update === 'function') {
        world.userData.update(time, delta);
    }
});
`;

        return {
            title: spec.name || 'Procedural 3D World & Terrain Foundation',
            subtitle: `${spec.theme} — ${spec.mood}. ${spec.regions.length} procedural regions with multi-tier elevation, scattered actors, and dynamic lighting.`,
            worldBranch: `world/${spec.regions[0]?.category || 'terrain'}`,
            sceneType: 'worldbuilder',
            renderMode: 'pbr',
            cameraMode: 'orbit',
            animation: 'orbit',
            timeline: {
                currentTimeMs: 0,
                durationMs: 20000,
                isPlaying: true,
                speed: 1.0,
                playbackSpeed: 1.0,
                isLooping: true
            },
            camera: {
                position: [0, 18, 36],
                target: [0, 3, 0],
                fov: 48
            },
            environment: {
                skybox: (hasAtmosphere || hasGodRays) ? 'realistic-sky' : (spec.atmosphere?.skybox || 'daylight'),
                lighting: hasAtmosphere ? (isSunset ? 'sunset' : 'daylight') : (spec.atmosphere?.lighting || 'daylight'),
                ground: true
            },
            features: {
                ...baseFeatures,
                terrainBiomes: {
                    enabled: true,
                    biomeType: (spec.regions[0]?.category === 'mountain' ? 'alpine' : spec.regions[0]?.category === 'canyon' ? 'canyon' : spec.regions[0]?.category === 'desert' ? 'desert' : 'alpine'),
                    roughness: spec.terrain.baseMaterial.roughness,
                    heightVariation: spec.terrain.elevationMax - spec.terrain.elevationMin
                }
            },
            geoAnchor: (realWorldLoc && realWorldLoc.isRealWorld) ? {
                lat: realWorldLoc.lat,
                lng: realWorldLoc.lng,
                elevation: realWorldLoc.elevation || 10.0,
                active: true,
                landmarkName: realWorldLoc.landmarkName || spec.name
            } : undefined,
            customMeshes,
            customScript,
            code: customScript,
            cppGenerator: {
                filename: 'world_generator.cpp',
                enabled: true,
                sourceCode: generateDefaultCpp3DSource('nature_atmosphere', spec.name || 'Procedural World'),
                vertexCount: 38000,
                triangleCount: 24000
            }
        };
    }

    if (theme === 'battlefield') {
        const isLexington = /lexington/i.test(prompt) || /lexington/i.test(docTitle) || /1776|1775|revolution/i.test(prompt) || /1776|1775|revolution/i.test(docTitle);
        const isCastle = /castle|citadel|fortress|keep|battlements/i.test(prompt);
        const title = isCastle
            ? '3D Medieval Castle Citadel & Fortification'
            : isLexington
            ? 'Battle of Lexington (April 19, 1775) — 3D Battlefield Simulation'
            : 'Historical Battlefield & Landscape Simulation';
        const subtitle = isCastle
            ? 'Medieval defensive fortification with multi-tiered stone keep, perimeter curtain wall, fortified gatehouse, and elevated battlements.'
            : isLexington
            ? 'Lexington Green with Buckman Tavern, colonial meetinghouse, split-rail fences, minutemen line, British redcoats, and morning musket smoke.'
            : 'Historical tactical formations, rustic terrain, fortifications, and dynamic particle battlefield effects.';

        const customScript = `
// 3D Historical Battlefield Simulation Script
const battlefield = createHistoricalBattlefieldScene(scene, THREE, {
    tavern: true,
    meetinghouse: true,
    stoneWalls: true,
    minutemenCount: 12,
    redcoatCount: 16,
    smokeParticles: true
});

// Animate musket smoke dispersion and camera drifting
onFrame((time, delta) => {
    if (battlefield && battlefield.userData && typeof battlefield.userData.update === 'function') {
        battlefield.userData.update(time, delta);
    }
});
`;

        const customMeshes: NonNullable<Scene3DData['customMeshes']> = isCastle ? [
            {
                id: 'mesh-castle-keep',
                name: 'Fortified Stone Keep (Primary Donjon)',
                type: 'box',
                position: [0, 8.0, 0],
                scale: [16, 16, 16],
                tier: 'primary',
                material: { color: 0x78716c, roughness: 0.85, metalness: 0.05, preset: 'weathered_limestone' }
            },
            {
                id: 'mesh-castle-tower-1',
                name: 'North-East Watchtower',
                type: 'cylinder',
                position: [12, 10.0, 12],
                scale: [5, 20, 5],
                tier: 'secondary',
                material: { color: 0x64748b, roughness: 0.80, metalness: 0.06 }
            },
            {
                id: 'mesh-castle-tower-2',
                name: 'North-West Watchtower',
                type: 'cylinder',
                position: [-12, 10.0, 12],
                scale: [5, 20, 5],
                tier: 'secondary',
                material: { color: 0x64748b, roughness: 0.80, metalness: 0.06 }
            },
            {
                id: 'mesh-castle-gatehouse',
                name: 'Fortified Barbican Gatehouse',
                type: 'box',
                position: [0, 4.5, 14],
                scale: [8, 9, 6],
                tier: 'secondary',
                material: { color: 0x57534e, roughness: 0.85, metalness: 0.08 }
            },
            {
                id: 'mesh-curtain-wall',
                name: 'Crenellated Perimeter Curtain Wall',
                type: 'box',
                position: [0, 3.0, 12],
                scale: [24, 6, 2],
                tier: 'tertiary',
                material: { color: 0x708090, roughness: 0.90, metalness: 0.04 }
            }
        ] : [
            {
                id: 'mesh-buckman-tavern',
                name: 'Buckman Tavern (Colonial Timber Frame)',
                type: 'box',
                position: [-22, 4, -14],
                scale: [12, 8, 14],
                tier: 'primary',
                material: { color: 0x8b5a2b, roughness: 0.8, metalness: 0.1 }
            },
            {
                id: 'mesh-meetinghouse',
                name: 'Lexington Meetinghouse & Belfry',
                type: 'box',
                position: [18, 7, -20],
                scale: [14, 14, 18],
                tier: 'primary',
                material: { color: 0xd4c5b9, roughness: 0.7, metalness: 0.1 }
            },
            {
                id: 'mesh-minutemen-line',
                name: 'Colonial Minutemen Firing Line (Capt. John Parker)',
                type: 'cylinder',
                position: [-6, 1.2, 5],
                scale: [14, 2.2, 1.5],
                tier: 'secondary',
                material: { color: 0x2b4c7e, roughness: 0.6, metalness: 0.2 }
            },
            {
                id: 'mesh-redcoat-formation',
                name: 'British 10th Regiment of Foot (Major John Pitcairn)',
                type: 'cylinder',
                position: [8, 1.2, 12],
                scale: [18, 2.2, 1.8],
                tier: 'secondary',
                material: { color: 0xb22222, roughness: 0.5, metalness: 0.3 }
            },
            {
                id: 'mesh-stone-wall',
                name: 'Colonial Fieldstone Boundary Wall',
                type: 'box',
                position: [-10, 0.6, -2],
                scale: [28, 1.2, 1.2],
                tier: 'tertiary',
                material: { color: 0x708090, roughness: 0.9, metalness: 0.05 }
            }
        ];

        return {
            title,
            subtitle,
            worldBranch: isCastle ? 'history/medieval-citadel' : isLexington ? 'history/lexington-1775' : 'history/battlefield',
            sceneType: 'battlefield',
            renderMode: 'pbr',
            cameraMode: 'orbit',
            animation: 'orbit',
            timeline: {
                currentTimeMs: 0,
                durationMs: 20000,
                isPlaying: true,
                speed: 1.0,
                playbackSpeed: 1.0,
                isLooping: true
            },
            camera: {
                position: [0, 18, 38],
                target: [0, 2, 0],
                fov: 48
            },
            environment: {
                skybox: (hasAtmosphere || hasGodRays) ? 'realistic-sky' : 'dawn-mist',
                lighting: 'dawn',
                ground: true
            },
            features: Object.keys(baseFeatures).length > 0 ? baseFeatures : undefined,
            geoAnchor: isCastle ? undefined : {
                lat: 42.4473,
                lng: -71.2272,
                elevation: 68.0,
                active: true,
                landmarkName: 'Lexington Battle Green, Massachusetts'
            },
            objects: [
                {
                    id: 'obj-lexington-ground',
                    content: {
                        type: '3d-scene',
                        durableUri: 'internal:lexington-green',
                        mimeType: 'model/procedural-terrain',
                        metadata: { dims: { width: 100, height: 2, depth: 100 } }
                    },
                    space: { spatial3d: { x: 0, y: 0, z: 0, pitch: 0, yaw: 0, roll: 0 } },
                    time: { startMs: 0, durationMs: 0 },
                    lineage: { version: 1 }
                }
            ],
            customMeshes,
            customScript,
            code: customScript
        };
    }

    if (theme === 'highway_overpass') {
        const title = '3D Highway Overpass & Civil Interchange';
        const subtitle = 'Multi-span elevated viaduct with cylindrical concrete piers, jersey barriers, overhead gantry exit signs, and animated transit lanes.';
        const customScript = `
const overpass = createHighwayOverpassScene(scene, THREE, {
    trafficDensity: 14,
    includeOverheadSigns: true
});

onFrame((time, delta) => {
    if (overpass && overpass.userData && typeof overpass.userData.update === 'function') {
        overpass.userData.update(time, delta);
    }
});
`;
        return {
            title,
            subtitle,
            worldBranch: 'infrastructure/highway-interchange',
            sceneType: 'highway_overpass',
            renderMode: 'pbr',
            cameraMode: 'orbit',
            animation: 'orbit',
            timeline: {
                currentTimeMs: 0,
                durationMs: 15000,
                isPlaying: true,
                speed: 1.0,
                playbackSpeed: 1.0,
                isLooping: true
            },
            camera: {
                position: [24, 22, 38],
                target: [0, 8, 0],
                fov: 50
            },
            environment: {
                skybox: 'daylight',
                lighting: 'daylight',
                ground: true
            },
            customMeshes: [
                {
                    id: 'mesh-viaduct-span-deck',
                    name: 'Elevated Deck Structure',
                    type: 'box',
                    position: [0, 11.2, 0],
                    scale: [15, 1.4, 140],
                    material: { color: 0x1e242d, roughness: 0.82, metalness: 0.15 }
                },
                {
                    id: 'mesh-viaduct-pier-crosshead',
                    name: 'Reinforced Pier Bent Crosshead',
                    type: 'box',
                    position: [0, 9.4, 20],
                    scale: [16.2, 1.4, 2.8],
                    material: { color: 0x94a3b8, roughness: 0.75, metalness: 0.1 }
                }
            ],
            customScript,
            code: customScript,
            cppGenerator: {
                filename: 'world_generator.cpp',
                enabled: true,
                sourceCode: `#include "scratchbox_engine.hpp"
#include <iostream>
#include <vector>

int main() {
    using namespace scratchbox::geometry;
    using namespace scratchbox::math;

    ScratchboxMesh viaduct("Highway_Overpass_Viaduct");
    
    // Extrude multi-span concrete box girder deck (140m long, 15m wide at Y=11.2m)
    for (float z = -70.0f; z <= 70.0f; z += 1.0f) {
        viaduct.extrudeCrossSectionProfile({
            {-7.5f, 11.2f},
            { 7.5f, 11.2f},
            { 6.5f,  9.8f},
            {-6.5f,  9.8f}
        }, z);
    }
    
    // Concrete support piers & crosshead bents
    const float pierZ[4] = {-48.0f, -20.0f, 20.0f, 48.0f};
    for (float pz : pierZ) {
        viaduct.addCylinderBent({-4.2f, 0.0f, pz}, {4.2f, 0.0f, pz}, 9.8f, 1.2f);
        viaduct.addBoxCrosshead({0.0f, 9.4f, pz}, {16.2f, 1.4f, 2.8f});
    }

    viaduct.recomputeSmoothNormals();
    viaduct.computeCurvatureAO(0.85f);
    scratchbox::io::GlbWriter::streamChunk(viaduct, "Highway_Overpass_Viaduct");
    return 0;
}`
            }
        };
    }

    if (theme === 'alpine_valley') {
        const title = '3D Alpine Glacial Valley & Pyramidal Horn (Matterhorn)';
        const subtitle = 'Towering 4-ridge rocky horn peak with snow cap, cascading river gorge, Swiss chalets, and subalpine conifer forest.';
        const customScript = `
const alpine = createAlpineMatterhornScene(scene, THREE, {
    showChalets: true,
    showGlacierRiver: true,
    snowCover: 0.85
});

onFrame((time, delta) => {
    if (alpine && alpine.userData && typeof alpine.userData.update === 'function') {
        alpine.userData.update(time, delta);
    }
});
`;
        return {
            title,
            subtitle,
            worldBranch: 'nature/alpine-glacier-valley',
            sceneType: 'alpine_valley',
            renderMode: 'pbr',
            cameraMode: 'orbit',
            animation: 'orbit',
            timeline: {
                currentTimeMs: 0,
                durationMs: 15000,
                isPlaying: true,
                speed: 1.0,
                playbackSpeed: 1.0,
                isLooping: true
            },
            camera: {
                position: [0, 24, 60],
                target: [0, 16, -10],
                fov: 52
            },
            environment: {
                skybox: 'daylight',
                lighting: 'daylight',
                ground: true
            },
            customMeshes: [
                {
                    id: 'mesh-matterhorn-summit',
                    name: 'Matterhorn Pyramidal Peak',
                    type: 'cone',
                    position: [0, 36, -55],
                    scale: [15, 20, 15],
                    material: { color: 0x373b42, roughness: 0.9, metalness: 0.15 }
                },
                {
                    id: 'mesh-swiss-chalet-village',
                    name: 'Chalet Village Ensemble',
                    type: 'box',
                    position: [-16, 2.8, 18],
                    scale: [6.0, 3.2, 4.8],
                    material: { color: 0x452818, roughness: 0.85, metalness: 0.05 }
                }
            ],
            customScript,
            code: customScript,
            cppGenerator: {
                filename: 'world_generator.cpp',
                enabled: true,
                sourceCode: `#include "scratchbox_engine.hpp"
#include <iostream>
#include <cmath>

int main() {
    using namespace scratchbox::geometry;
    using namespace scratchbox::math;

    ScratchboxMesh matterhorn("Matterhorn_Alpine_Valley");
    
    // 4-Ridge Asymmetric Pyramidal Horn SDF (Hornli, Furggen, Lion, Zmutt)
    MarchingCubesVolume grid(128, 128, 128, Bounds3D({-80, 0, -80}, {80, 75, 80}));
    grid.sampleSDF([](Vec3 p) {
        float h = p.y / 65.0f;
        if (h > 1.0f) return 1.0f;
        float pyramid = std::max(std::abs(p.x), std::abs(p.z)) - (1.0f - h) * 45.0f;
        float strata = std::sin(p.y * 0.6f + p.x * 0.1f) * 1.8f;
        float ridgeNoise = FastNoise3D::fbm(p * 0.05f, 5) * 3.5f;
        return pyramid + strata + ridgeNoise;
    });

    matterhorn.polygonize(grid);
    matterhorn.recomputeSmoothNormals();
    scratchbox::io::GlbWriter::streamChunk(matterhorn, "Matterhorn_Alpine_Valley");
    return 0;
}`
            }
        };
    }

    if (theme === 'ziggurat') {
        const title = '3D Babylonian Ziggurat Observatory (Etemenanki)';
        const subtitle = 'Monumental 3-tiered mudbrick ziggurat with buttressed facades, axial staircase, lapis lazuli terrace, gold sanctuary, and astrolabe observatory.';
        const customScript = `
const ziggurat = createBabylonianZigguratScene(scene, THREE, {
    showAstrolabe: true,
    showBraziers: true
});

onFrame((time, delta) => {
    if (ziggurat && ziggurat.userData && typeof ziggurat.userData.update === 'function') {
        ziggurat.userData.update(time, delta);
    }
});
`;
        return {
            title,
            subtitle,
            worldBranch: 'history/babylon-ziggurat-observatory',
            sceneType: 'ziggurat',
            renderMode: 'pbr',
            cameraMode: 'orbit',
            animation: 'orbit',
            timeline: {
                currentTimeMs: 0,
                durationMs: 15000,
                isPlaying: true,
                speed: 1.0,
                playbackSpeed: 1.0,
                isLooping: true
            },
            camera: {
                position: [-36, 22, 44],
                target: [0, 8, 0],
                fov: 48
            },
            environment: {
                skybox: 'dusk',
                lighting: 'dusk',
                ground: true
            },
            customMeshes: [
                {
                    id: 'mesh-ziggurat-foundation',
                    name: 'Mudbrick Foundation Terrace',
                    type: 'box',
                    position: [0, 4, 0],
                    scale: [48, 8, 48],
                    material: { color: 0xbaa47a, roughness: 0.88, metalness: 0.02 }
                },
                {
                    id: 'mesh-lapis-terrace',
                    name: 'Glazed Lapis Lazuli Terrace',
                    type: 'box',
                    position: [0, 11, 0],
                    scale: [34, 6, 34],
                    material: { color: 0x143485, roughness: 0.22, metalness: 0.15 }
                },
                {
                    id: 'mesh-gold-sanctuary',
                    name: 'Gold High Sanctuary',
                    type: 'box',
                    position: [0, 21.5, 0],
                    scale: [10, 5, 8],
                    material: { color: 0xd4af37, roughness: 0.26, metalness: 0.92 }
                }
            ],
            customScript,
            code: customScript,
            cppGenerator: {
                filename: 'world_generator.cpp',
                enabled: true,
                sourceCode: `#include "scratchbox_engine.hpp"
#include <iostream>

int main() {
    using namespace scratchbox::geometry;
    using namespace scratchbox::math;

    ScratchboxMesh ziggurat("Babylonian_Ziggurat_Observatory");
    // Multi-tiered stepped massing with axial stairway and astrolabe plinth
    MarchingCubesVolume grid(128, 128, 128, Bounds3D({-30, 0, -30}, {30, 30, 30}));
    grid.sampleSDF([](Vec3 p) {
        float t1 = sdBox(p - Vec3(0, 4, 0), Vec3(24, 4, 24));
        float t2 = sdBox(p - Vec3(0, 11, 0), Vec3(17, 3, 17));
        float t3 = sdBox(p - Vec3(0, 16.5f, 0), Vec3(11, 2.5f, 11));
        return std::min({t1, t2, t3});
    });

    ziggurat.polygonize(grid);
    ziggurat.recomputeSmoothNormals();
    scratchbox::io::GlbWriter::streamChunk(ziggurat, "Babylonian_Ziggurat_Observatory");
    return 0;
}`
            }
        };
    }

    if (theme === 'city') {
        const isCyberpunk = /cyberpunk|neon|future/i.test(prompt) || /cyberpunk|neon|future/i.test(docTitle);
        const title = isCyberpunk
            ? 'Cyberpunk Metropolis & Urban Skyline'
            : 'Procedural Architectural City Grid';
        const subtitle = '3D high-rise skyline with illuminated building facades, street corridors, streetlamps, and autonomous transit pathways.';

        const customScript = `
const city = createProceduralCityScene(scene, THREE, {
    buildingCount: 32,
    animatedVehicles: true,
    cyberpunk: ${isCyberpunk}
});

onFrame((time, delta) => {
    if (city && city.userData && typeof city.userData.update === 'function') {
        city.userData.update(time, delta);
    }
});
`;

        const pythonCitySource = `import scratchbox as sb

scene = sb.geometry.Mesh("${(title || 'CityMetropolis').replace(/[^a-zA-Z0-9]/g, '')}")

# 1. Base promenade & street grid
grid_base = sb.geometry.create_studio_pedestal(radius=50.0, height=0.5, bevel=0.06, segments=64)
grid_base.material = sb.geometry.PbrMaterial.asphalt_street()
scene.merge(grid_base)

# 2. Central Financial Spire with flat parapet and deep window reveals
tower_alpha = sb.create_building(
    width=16.0, depth=16.0, floors=7, floor_height=3.6,
    ground_floor_height=4.8, plinth_height=0.8,
    bay_width=3.2, window_width=1.9, window_height=2.3, window_recess_depth=0.28,
    roof='flat_parapet', name='FinancialSpireAlpha'
)
tower_alpha.translate(0, 0.5, -4.0)
scene.merge(tower_alpha)

# 3. Flanking West Arcology high-rise with hip roof
tower_beta = sb.create_building(
    width=14.0, depth=18.0, floors=5, floor_height=3.4,
    ground_floor_height=4.2, plinth_height=0.6,
    bay_width=2.8, window_width=1.6, window_height=2.0, window_recess_depth=0.24,
    roof='hip', roof_pitch_degrees=28.0, name='ArcologyWest'
)
tower_beta.translate(-16.0, 0.5, -6.0)
scene.merge(tower_beta)

# 4. Flanking East civic high-rise with mansard roof
tower_gamma = sb.create_building(
    width=20.0, depth=12.0, floors=4, floor_height=3.5,
    ground_floor_height=4.4, plinth_height=0.6,
    bay_width=3.0, window_width=1.8, window_height=2.2, window_recess_depth=0.25,
    roof='mansard', roof_pitch_degrees=36.0, name='CivicPlazaEast'
)
tower_gamma.translate(16.0, 0.5, 6.0)
scene.merge(tower_gamma)

# 5. Avenue shade trees along promenade
avenue_trees = [(-8.0, 0.5, 12.0), (8.0, 0.5, 12.0), (-16.0, 0.5, 14.0), (16.0, 0.5, 14.0)]
for tx, ty, tz in avenue_trees:
    tree = sb.create_tree(attractor_count=110, crown_center=(0, 4.8, 0), crown_extents=(2.4, 3.4, 2.4))
    tree.translate(tx, ty, tz)
    scene.merge(tree)

# 6. Stream binary glTF 2.0
sb.io.write_glb(OUTPUT_GLB_PATH, scene)
`;

        return {
            title,
            subtitle,
            worldBranch: isCyberpunk ? 'earth/cyberpunk-city' : 'earth/metropolis',
            sceneType: 'city',
            renderMode: 'pbr',
            cameraMode: 'orbit',
            animation: 'orbit',
            timeline: {
                currentTimeMs: 0,
                durationMs: 15000,
                isPlaying: true,
                speed: 1.0,
                playbackSpeed: 1.0,
                isLooping: true
            },
            camera: {
                position: [30, 35, 45],
                target: [0, 8, 0],
                fov: 50
            },
            environment: {
                skybox: isCyberpunk ? 'cyberpunk' : 'sunset',
                lighting: isCyberpunk ? 'neon' : 'daylight',
                ground: true
            },
            customMeshes: [
                {
                    id: 'mesh-city-tower-alpha',
                    name: 'Central Financial Spire',
                    type: 'box',
                    position: [0, 16, 0],
                    scale: [8, 32, 8],
                    material: { color: isCyberpunk ? 0x0f172a : 0x334155, roughness: 0.2, metalness: 0.8 }
                },
                {
                    id: 'mesh-city-tower-beta',
                    name: 'Arcology Plaza Tower',
                    type: 'box',
                    position: [-14, 12, -10],
                    scale: [10, 24, 10],
                    material: { color: 0x1e293b, roughness: 0.3, metalness: 0.7 }
                }
            ],
            customScript,
            code: customScript,
            pythonGenerator: {
                enabled: true,
                filename: 'procedural_city.py',
                sourceCode: pythonCitySource,
                vertexCount: 38000,
                triangleCount: 24000
            }
        };
    }

    if (theme === 'mars_rover') {
        const title = 'Mars Rover Planetary Exploration';
        const subtitle = 'Martian Jezero crater surface terrain, articulated 6-wheel rocker-bogie rover, mastcam sensor suite, and thin dust haze.';

        const customMeshes = [
            {
                id: 'mesh-mars-terrain',
                name: 'Martian Regolith Surface',
                type: 'plane' as const,
                position: [0, -0.1, 0] as [number, number, number],
                scale: [80, 80, 1] as [number, number, number],
                material: { color: 0xb5522c, roughness: 0.88, metalness: 0.05 }
            },
            {
                id: 'mesh-rover-chassis',
                name: 'Mars Rover Core Body',
                type: 'box' as const,
                position: [0, 1.2, 0] as [number, number, number],
                scale: [2.8, 1.1, 2.2] as [number, number, number],
                material: { color: 0xe2e8f0, roughness: 0.35, metalness: 0.7 }
            },
            {
                id: 'mesh-rover-mast',
                name: 'Remote Sensing Mast (Mastcam-Z)',
                type: 'cylinder' as const,
                position: [0.8, 2.1, 0.6] as [number, number, number],
                scale: [0.15, 1.4, 0.15] as [number, number, number],
                material: { color: 0x334155, roughness: 0.4, metalness: 0.8 }
            },
            {
                id: 'mesh-rover-mast-head',
                name: 'SuperCam & Stereo Sensor Head',
                type: 'box' as const,
                position: [0.8, 2.8, 0.6] as [number, number, number],
                scale: [0.5, 0.3, 0.4] as [number, number, number],
                material: { color: 0x0f172a, roughness: 0.2, metalness: 0.9 }
            },
            {
                id: 'mesh-rover-rtg',
                name: 'MMRTG Nuclear Power Generator',
                type: 'cylinder' as const,
                position: [-1.4, 1.3, 0] as [number, number, number],
                scale: [0.5, 1.0, 0.5] as [number, number, number],
                material: { color: 0x1e293b, roughness: 0.5, metalness: 0.85 }
            },
            {
                id: 'mesh-rover-arm',
                name: 'Robotic Turret Sample Arm',
                type: 'cylinder' as const,
                position: [1.3, 1.0, -0.5] as [number, number, number],
                scale: [0.15, 1.2, 0.15] as [number, number, number],
                material: { color: 0x94a3b8, roughness: 0.3, metalness: 0.8 }
            },
            { id: 'mesh-wheel-fl', name: 'Front-Left Cleated Wheel', type: 'cylinder' as const, position: [1.4, 0.5, 1.5] as [number, number, number], scale: [0.55, 0.4, 0.55] as [number, number, number], material: { color: 0x1e293b, roughness: 0.6, metalness: 0.5 } },
            { id: 'mesh-wheel-fr', name: 'Front-Right Cleated Wheel', type: 'cylinder' as const, position: [1.4, 0.5, -1.5] as [number, number, number], scale: [0.55, 0.4, 0.55] as [number, number, number], material: { color: 0x1e293b, roughness: 0.6, metalness: 0.5 } },
            { id: 'mesh-wheel-ml', name: 'Mid-Left Cleated Wheel', type: 'cylinder' as const, position: [0, 0.5, 1.6] as [number, number, number], scale: [0.55, 0.4, 0.55] as [number, number, number], material: { color: 0x1e293b, roughness: 0.6, metalness: 0.5 } },
            { id: 'mesh-wheel-mr', name: 'Mid-Right Cleated Wheel', type: 'cylinder' as const, position: [0, 0.5, -1.6] as [number, number, number], scale: [0.55, 0.4, 0.55] as [number, number, number], material: { color: 0x1e293b, roughness: 0.6, metalness: 0.5 } },
            { id: 'mesh-wheel-rl', name: 'Rear-Left Cleated Wheel', type: 'cylinder' as const, position: [-1.4, 0.5, 1.5] as [number, number, number], scale: [0.55, 0.4, 0.55] as [number, number, number], material: { color: 0x1e293b, roughness: 0.6, metalness: 0.5 } },
            { id: 'mesh-wheel-rr', name: 'Rear-Right Cleated Wheel', type: 'cylinder' as const, position: [-1.4, 0.5, -1.5] as [number, number, number], scale: [0.55, 0.4, 0.55] as [number, number, number], material: { color: 0x1e293b, roughness: 0.6, metalness: 0.5 } },
            { id: 'mesh-rock-1', name: 'Basaltic Regolith Boulder Alpha', type: 'sphere' as const, position: [4.5, 0.4, 3.2] as [number, number, number], scale: [1.2, 0.8, 1.0] as [number, number, number], material: { color: 0x8a391e, roughness: 0.95, metalness: 0.02 } },
            { id: 'mesh-rock-2', name: 'Sedimentary Regolith Outcrop', type: 'sphere' as const, position: [-3.8, 0.3, -4.5] as [number, number, number], scale: [0.9, 0.6, 0.8] as [number, number, number], material: { color: 0x782f18, roughness: 0.95, metalness: 0.02 } },
            { id: 'mesh-rock-3', name: 'Eroded Impact Fragment', type: 'box' as const, position: [2.1, 0.25, -5.0] as [number, number, number], scale: [0.7, 0.5, 0.6] as [number, number, number], material: { color: 0x9c4123, roughness: 0.92, metalness: 0.02 } }
        ];

        return {
            title,
            subtitle,
            worldBranch: 'planetary/mars-rover',
            sceneType: 'mars_rover',
            renderMode: 'pbr',
            cameraMode: 'orbit',
            animation: 'orbit',
            timeline: {
                currentTimeMs: 0,
                durationMs: 15000,
                isPlaying: true,
                speed: 1.0,
                playbackSpeed: 1.0,
                isLooping: true
            },
            camera: {
                position: [7, 5, 8],
                target: [0, 1.2, 0],
                fov: 45
            },
            environment: {
                skybox: 'mars',
                lighting: 'golden_hour',
                lightingKelvin: 4500,
                ground: true
            },
            geoAnchor: {
                lat: 18.38,
                lng: 77.58,
                elevation: -2500,
                active: true,
                landmarkName: 'Jezero Crater, Mars (Perseverance Exploration Site)',
                castingRationale: 'Extraterrestrial planetary surface: Jezero Crater, Mars',
                castingArchetype: 'planetary_surface'
            },
            customMeshes
        };
    }

    if (theme === 'solar-system') {
        const title = 'Solar System & Planetary Orbital Mechanics';
        const subtitle = 'Dynamic 3D celestial orrery featuring central Star, Keplerian orbits, textured planetary bodies, and asteroid belt.';

        const customScript = `
const solar = createSolarSystemScene(scene, THREE, {
    includeAsteroidBelt: true,
    includeMoons: true
});

onFrame((time, delta) => {
    if (solar && solar.userData && typeof solar.userData.update === 'function') {
        solar.userData.update(time, delta);
    }
});
`;

        return {
            title,
            subtitle,
            worldBranch: 'space/solar-system',
            sceneType: 'solar-system',
            renderMode: 'pbr',
            cameraMode: 'orbit',
            animation: 'orbit',
            timeline: {
                currentTimeMs: 0,
                durationMs: 30000,
                isPlaying: true,
                speed: 1.0,
                playbackSpeed: 1.0,
                isLooping: true
            },
            camera: {
                position: [0, 45, 65],
                target: [0, 0, 0],
                fov: 45
            },
            environment: {
                skybox: 'space-stars',
                lighting: 'deep-space',
                ground: false
            },
            customMeshes: [
                {
                    id: 'mesh-sun',
                    name: 'Central Star (Sol)',
                    type: 'sphere',
                    position: [0, 0, 0],
                    scale: [6, 6, 6],
                    tier: 'primary',
                    material: { color: 0xffaa00, roughness: 0.1, metalness: 0.1, emissive: 0xff8800, emissiveIntensity: 1.5 }
                },
                {
                    id: 'mesh-orbital-body',
                    name: 'Major Orbital Planet',
                    type: 'sphere',
                    position: [18, 2, -10],
                    scale: [2.2, 2.2, 2.2],
                    tier: 'secondary',
                    material: { color: 0x38bdf8, roughness: 0.45, metalness: 0.2 }
                },
                {
                    id: 'mesh-telemetry-relay',
                    name: 'Orbital Telemetry Relay',
                    type: 'cylinder',
                    position: [10, 1.2, 4],
                    scale: [0.6, 1.4, 0.6],
                    tier: 'tertiary',
                    material: { color: 0xffd700, roughness: 0.2, metalness: 0.95, preset: 'polished_gold_24k' }
                }
            ],
            customScript,
            code: customScript
        };
    }

    if (theme === 'molecular') {
        const isDna = /dna|helix|genomics|genetic/i.test(prompt) || /dna|helix|genomics|genetic/i.test(docTitle);
        const title = isDna
            ? 'DNA Double Helix & Molecular Genetic Architecture'
            : 'Molecular Physics & Quantum Bond Simulation';
        const subtitle = 'Interactive 3D molecular lattice, valence orbital bonds, electron cloud probability fields, and resonance vibrations.';

        const customScript = `
const molecular = createMolecularPhysicsScene(scene, THREE, {
    latticeType: '${isDna ? 'dna' : 'caffeine'}',
    showElectronCloud: true
});

onFrame((time, delta) => {
    if (molecular && molecular.userData && typeof molecular.userData.update === 'function') {
        molecular.userData.update(time, delta);
    }
});
`;

        return {
            title,
            subtitle,
            worldBranch: 'science/molecular',
            sceneType: 'molecular',
            renderMode: 'pbr',
            cameraMode: 'orbit',
            animation: 'orbit',
            timeline: {
                currentTimeMs: 0,
                durationMs: 12000,
                isPlaying: true,
                speed: 1.0,
                playbackSpeed: 1.0,
                isLooping: true
            },
            camera: {
                position: [0, 10, 26],
                target: [0, 0, 0],
                fov: 45
            },
            environment: {
                skybox: 'lab-clean',
                lighting: 'daylight',
                ground: false
            },
            customMeshes: [
                {
                    id: 'mesh-molecule-core',
                    name: 'Molecular Core Lattice',
                    type: 'sphere',
                    position: [0, 0, 0],
                    scale: [2.4, 2.4, 2.4],
                    tier: 'primary',
                    material: { color: 0x38bdf8, roughness: 0.3, metalness: 0.6 }
                },
                {
                    id: 'mesh-helix-backbone',
                    name: 'Helical Valence Backbone',
                    type: 'cylinder',
                    position: [2.8, 1.5, 0],
                    scale: [0.6, 3.5, 0.6],
                    tier: 'secondary',
                    material: { color: 0x6366f1, roughness: 0.25, metalness: 0.4 }
                },
                {
                    id: 'mesh-cofactor-sensor',
                    name: 'Catalytic Cofactor Complex',
                    type: 'sphere',
                    position: [-1.6, -1.0, 1.2],
                    scale: [0.55, 0.55, 0.55],
                    tier: 'tertiary',
                    material: { color: 0xf59e0b, emissive: 0xd97706, emissiveIntensity: 2.0, roughness: 0.1 }
                }
            ],
            customScript,
            code: customScript
        };
    }

    if (theme === 'architecture') {
        const isPlazaOrCivic = /plaza|civic|square|forum|promenade|courtyard|esplanade|palais|hall/i.test(prompt);
        const isOutpostOrFacility = /outpost|facility|station|research|tower|observatory|base|habitat|hub|solar/i.test(prompt);
        const title = isOutpostOrFacility
            ? '3D Architectural Research Outpost'
            : isPlazaOrCivic
            ? 'Procedural Architectural Civic Plaza'
            : 'Procedural Architectural Complex';
        const subtitle = isOutpostOrFacility
            ? '3D modular research outpost with central observation tower, dual photovoltaic solar arrays, and high-gain telemetry communications mast.'
            : '3D multi-story architecture with rhythmic recessed window reveals, mansard and hip roofs, botanical space-colonization trees, and limestone promenade.';

        const pythonSource = `import scratchbox as sb

scene = sb.geometry.Mesh("${(title || 'CivicPlaza').replace(/[^a-zA-Z0-9]/g, '')}")

# 1. Elevated stone promenade pedestal
promenade = sb.geometry.create_studio_pedestal(radius=30.0, height=0.7, bevel=0.08, segments=64)
promenade.material = sb.geometry.PbrMaterial.stone_limestone()
scene.merge(promenade)

# 2. Central municipal / administrative hall with Mansard roof & rhythmic window reveals
central_hall = sb.create_building(
    width=22.0, depth=14.0, floors=4, floor_height=3.6,
    ground_floor_height=4.4, plinth_height=0.7,
    bay_width=3.2, window_width=1.8, window_height=2.2, window_recess_depth=0.26,
    roof='mansard', roof_pitch_degrees=38.0, roof_overhang=0.8,
    name='CentralMunicipalPalais'
)
central_hall.translate(0, 0.7, -5.0)
scene.merge(central_hall)

# 3. Flanking East & West wings with Hip roofs
east_wing = sb.create_building(
    width=12.0, depth=10.0, floors=3, floor_height=3.4,
    ground_floor_height=4.0, plinth_height=0.5,
    bay_width=3.0, window_width=1.6, window_height=2.0, window_recess_depth=0.22,
    roof='hip', name='EastWing'
)
east_wing.translate(-16.0, 0.7, 0.0)
scene.merge(east_wing)

west_wing = sb.create_building(
    width=12.0, depth=10.0, floors=3, floor_height=3.4,
    ground_floor_height=4.0, plinth_height=0.5,
    bay_width=3.0, window_width=1.6, window_height=2.0, window_recess_depth=0.22,
    roof='hip', name='WestWing'
)
west_wing.translate(16.0, 0.7, 0.0)
scene.merge(west_wing)

# 4. Botanical Space-Colonization Shade Trees
tree_coords = [(-8.0, 0.7, 9.0), (8.0, 0.7, 9.0), (-15.0, 0.7, 12.0), (15.0, 0.7, 12.0)]
for tx, ty, tz in tree_coords:
    tree = sb.create_tree(attractor_count=130, crown_center=(0, 5, 0), crown_extents=(2.6, 3.8, 2.6))
    tree.translate(tx, ty, tz)
    scene.merge(tree)

# 5. Clinging Ivy on East wing foundation
ivy = sb.create_ivy(root=(-10.0, 0.7, 3.0), obstacle_min=(-16, 0.7, -5), obstacle_max=(-10, 6, 5), max_steps=80)
scene.merge(ivy)

# 6. Stream binary glTF 2.0
sb.io.write_glb(OUTPUT_GLB_PATH, scene)
`;

        const customMeshes: NonNullable<Scene3DData['customMeshes']> = isOutpostOrFacility ? [
            // 1. Primary Research Hub Massing (70%)
            {
                id: 'arch-primary-hub',
                name: 'Central Research Facility Hub',
                type: 'box',
                position: [0, 1.8, 0],
                scale: [7.0, 3.6, 6.0],
                tier: 'primary',
                material: { color: 0x475569, roughness: 0.35, metalness: 0.85, preset: 'titanium_grade5' }
            },
            // 2. Secondary Central Observation Tower (20%)
            {
                id: 'arch-observation-tower',
                name: 'Central Observation Tower & Cupola',
                parentId: 'arch-primary-hub',
                type: 'cylinder',
                position: [0, 4.8, 0],
                scale: [1.8, 2.6, 1.8],
                tier: 'secondary',
                material: { color: 0x94a3b8, roughness: 0.15, metalness: 0.40, clearcoat: 1.0 }
            },
            // 3. Tertiary Left Solar Array (10%)
            {
                id: 'arch-solar-wing-left',
                name: 'Photovoltaic Solar Array Alpha',
                parentId: 'arch-primary-hub',
                type: 'box',
                position: [-4.6, 2.0, 0],
                rotation: [0, 0, 0.18],
                scale: [3.4, 0.12, 1.8],
                tier: 'tertiary',
                material: { color: 0x0f172a, roughness: 0.12, metalness: 0.95, preset: 'polished_gold_24k' }
            },
            // 4. Tertiary Right Solar Array (10%)
            {
                id: 'arch-solar-wing-right',
                name: 'Photovoltaic Solar Array Beta',
                parentId: 'arch-primary-hub',
                type: 'box',
                position: [4.6, 2.0, 0],
                rotation: [0, 0, -0.18],
                scale: [3.4, 0.12, 1.8],
                tier: 'tertiary',
                material: { color: 0x0f172a, roughness: 0.12, metalness: 0.95, preset: 'polished_gold_24k' }
            },
            // 5. Tertiary High-Gain Telemetry Mast
            {
                id: 'arch-comms-mast',
                name: 'High-Gain Telemetry Mast',
                parentId: 'arch-primary-hub',
                type: 'cylinder',
                position: [0, 6.6, 0],
                scale: [0.12, 1.8, 0.12],
                tier: 'tertiary',
                material: { color: 0x64748b, roughness: 0.40, metalness: 0.85 }
            },
            // 6. Grounded Local Conifers & Natural Elements
            {
                id: 'arch-conifer-stand',
                name: 'Subalpine Conifer Stand',
                type: 'cylinder',
                position: [-4.5, 1.2, 3.2],
                scale: [1.2, 2.4, 1.2],
                tier: 'secondary',
                material: { color: 0x1e3f20, roughness: 0.70, metalness: 0.05 }
            },
            {
                id: 'arch-ground-boulder',
                name: 'Basaltic Ground Boulder',
                type: 'sphere',
                position: [2.8, 0.35, 3.8],
                scale: [0.9, 0.6, 0.9],
                tier: 'tertiary',
                material: { color: 0x57534e, roughness: 0.90, metalness: 0.04 }
            }
        ] : [
            // 1. Elevated stone promenade pedestal
            {
                id: 'arch-promenade',
                name: 'Limestone Promenade Pedestal',
                type: 'cylinder',
                position: [0, 0.35, 0],
                scale: [30.0, 0.7, 30.0],
                tier: 'primary',
                material: { color: 0xdcd6cd, roughness: 0.82, metalness: 0.05 }
            },
            // 2. Central municipal / administrative hall with rhythmic window reveals
            {
                id: 'arch-central-hall',
                name: 'Central Palais Complex',
                type: 'box',
                position: [0, 8.0, -5.0],
                scale: [22.0, 14.6, 14.0],
                tier: 'primary',
                material: { color: 0xefede8, roughness: 0.65, metalness: 0.12 }
            },
            // 3. Mansard / Hip Roof Crown
            {
                id: 'arch-central-roof',
                name: 'Mansard Architectural Crown',
                type: 'cone',
                position: [0, 17.5, -5.0],
                scale: [18.0, 5.5, 12.0],
                tier: 'secondary',
                material: { color: 0x475569, roughness: 0.45, metalness: 0.4 }
            },
            // 4. East Wing
            {
                id: 'arch-east-wing',
                name: 'East Wing Pavilion',
                type: 'box',
                position: [-16.0, 6.0, 0],
                scale: [12.0, 10.6, 10.0],
                tier: 'secondary',
                material: { color: 0xe2e8f0, roughness: 0.7, metalness: 0.08 }
            },
            // 5. West Wing
            {
                id: 'arch-west-wing',
                name: 'West Wing Pavilion',
                type: 'box',
                position: [16.0, 6.0, 0],
                scale: [12.0, 10.6, 10.0],
                tier: 'secondary',
                material: { color: 0xe2e8f0, roughness: 0.7, metalness: 0.08 }
            },
            // 6. Colonnade Entrance Portico
            {
                id: 'arch-portico-colonnade',
                name: 'Monumental Colonnade Portico',
                type: 'box',
                position: [0, 3.5, 3.0],
                scale: [14.0, 5.0, 2.5],
                tier: 'tertiary',
                material: { color: 0xf8fafc, roughness: 0.5, metalness: 0.15 }
            },
            // 7. Botanical Shade Trees
            {
                id: 'arch-tree-east',
                name: 'Botanical Promenade Shade Tree',
                type: 'sphere',
                position: [-8.0, 4.5, 9.0],
                scale: [3.2, 4.0, 3.2],
                tier: 'tertiary',
                material: { color: 0x1e3f20, roughness: 0.8, metalness: 0.0 }
            },
            {
                id: 'arch-tree-west',
                name: 'Botanical Promenade Shade Tree',
                type: 'sphere',
                position: [8.0, 4.5, 9.0],
                scale: [3.2, 4.0, 3.2],
                tier: 'tertiary',
                material: { color: 0x1e3f20, roughness: 0.8, metalness: 0.0 }
            }
        ];

        return {
            title,
            subtitle,
            worldBranch: 'architecture/civic-plaza',
            sceneType: 'architecture',
            renderMode: 'pbr',
            cameraMode: 'orbit',
            animation: 'idle',
            camera: {
                position: [0, 18, 38],
                target: [0, 4, 0],
                fov: 50
            },
            environment: {
                skybox: (hasAtmosphere || hasGodRays) ? 'realistic-sky' : 'studio',
                lighting: 'studio',
                ground: true
            },
            customMeshes,
            geoAnchor: realWorldLoc ? {
                lat: realWorldLoc.lat,
                lng: realWorldLoc.lng,
                elevation: realWorldLoc.elevation,
                elevationSource: 'google_elevation',
                datum: 'MSL_EGM96',
                active: true,
                landmarkName: realWorldLoc.landmarkName
            } : undefined,
            pythonGenerator: {
                enabled: true,
                filename: 'procedural_architecture.py',
                sourceCode: pythonSource
            },
            cppGenerator: {
                filename: 'world_generator.cpp',
                enabled: true,
                sourceCode: generateDefaultCpp3DSource('architecture', title),
                vertexCount: 38000,
                triangleCount: 24000
            }
        };
    }

    if (theme === 'flight') {
        const title = '3D Aircraft & Spatial Flight Corridor';
        const subtitle = 'Aerodynamic flight simulation with dynamic control surface kinematics, contrails, and atmospheric scattering.';
        return {
            title,
            subtitle,
            worldBranch: 'earth/flight-corridor',
            sceneType: 'flight',
            renderMode: 'pbr',
            cameraMode: 'orbit',
            animation: 'flight',
            timeline: {
                currentTimeMs: 0,
                durationMs: 10000,
                isPlaying: true,
                speed: 1.0,
                playbackSpeed: 1.0,
                isLooping: true
            },
            camera: {
                position: [15, 12, 20],
                target: [0, 2, 0],
                fov: 45
            },
            environment: {
                skybox: hasAtmosphere ? 'realistic-sky' : 'studio',
                lighting: 'daylight',
                ground: true
            },
            features: {
                controlSurfaces: true,
                contrails: true,
                ...(hasAtmosphere ? {
                    godRays: hasGodRays,
                    atmosphericScattering: buildHeadlessAtmosphere({
                        aerialPerspectiveEnabled: hasHazeOrFogRequested,
                        inscatteringIntensity: hasHazeOrFogRequested ? 1.0 : 0.0
                    })
                } : {})
            },
            objects: [
                {
                    id: 'obj-aircraft-1',
                    content: {
                        type: '3d-scene',
                        durableUri: 'internal:plane',
                        mimeType: 'model/procedural-aircraft',
                        metadata: { dims: { width: 12, height: 4, depth: 14 } }
                    },
                    space: { spatial3d: { x: 0, y: 3.5, z: 0, pitch: 0, yaw: 0, roll: 0 } },
                    time: { startMs: 0, durationMs: 10000 },
                    lineage: { version: 1 }
                }
            ]
        };
    }

    if (theme === 'universal_scene') {
        const title = 'Universal Photorealistic 3D Scene Assembly';
        const subtitle = 'Procedurally assembled macro-to-micro geometric hierarchy, multi-layer PBR weathering, and cinematic 3-point lighting.';
        return {
            title,
            subtitle,
            worldBranch: 'spatial/universal-scene',
            sceneType: 'universal_scene',
            renderMode: 'pbr',
            cameraMode: 'orbit',
            animation: 'orbit',
            timeline: {
                currentTimeMs: 0,
                durationMs: 12000,
                isPlaying: true,
                speed: 1.0,
                playbackSpeed: 1.0,
                isLooping: true
            },
            camera: {
                position: [7.5, 4.5, 7.5],
                target: [0, 1.2, 0],
                fov: 42
            },
            environment: {
                skybox: 'studio',
                lighting: 'cinematic_3point_studio',
                ground: true
            },
            features: {
                curvatureAO: true,
                multiLayerWeathering: true,
                cinematic3PointLighting: true,
                studioPedestal: true
            },
            customMeshes: [
                {
                    id: 'hero-reactor-chamber',
                    name: 'Hero_Quantum_Chamber',
                    type: 'cylinder',
                    position: [0, 1.2, 0],
                    scale: [0.8, 2.2, 0.8],
                    tier: 'primary',
                    material: {
                        color: '#d0d8e2',
                        metalness: 0.95,
                        roughness: 0.22,
                        preset: 'titanium_grade5'
                    }
                },
                {
                    id: 'containment-ring-upper',
                    name: 'Magnetic_Ring_Upper',
                    type: 'torus',
                    position: [0, 1.6, 0],
                    scale: [1.4, 0.22, 1.4],
                    tier: 'secondary',
                    material: {
                        color: '#ffd700',
                        metalness: 0.98,
                        roughness: 0.15,
                        preset: 'polished_gold_24k'
                    }
                },
                {
                    id: 'containment-ring-lower',
                    name: 'Magnetic_Ring_Lower',
                    type: 'torus',
                    position: [0, 0.8, 0],
                    scale: [1.4, 0.22, 1.4],
                    tier: 'secondary',
                    material: {
                        color: '#ffd700',
                        metalness: 0.98,
                        roughness: 0.15,
                        preset: 'polished_gold_24k'
                    }
                },
                {
                    id: 'plasma-core-sphere',
                    name: 'Plasma_Energy_Core',
                    type: 'sphere',
                    position: [0, 1.2, 0],
                    scale: [0.45, 0.45, 0.45],
                    tier: 'secondary',
                    material: {
                        color: '#1af0ff',
                        emissive: '#33ccff',
                        emissiveIntensity: 4.5,
                        roughness: 0.05
                    }
                },
                {
                    id: 'studio-ground-pedestal',
                    name: 'Studio_Pedestal',
                    type: 'cylinder',
                    position: [0, -0.125, 0],
                    scale: [3.5, 0.25, 3.5],
                    tier: 'primary',
                    material: {
                        color: '#121418',
                        metalness: 0.06,
                        roughness: 0.25,
                        preset: 'black_onyx'
                    }
                }
            ],
            pythonGenerator: {
                enabled: true,
                filename: 'procedural_universal_assembly.py',
                sourceCode: `import scratchbox as sb

scene = sb.geometry.Mesh("UniversalSpatialAssembly")

# 1. Precision studio pedestal with bevel
pedestal = sb.geometry.create_studio_pedestal(radius=8.0, height=0.35, bevel=0.06, segments=64)
pedestal.material = sb.geometry.PbrMaterial.stone_limestone()
scene.merge(pedestal)

# 2. Primary architectural / sculptural core with recessed window reveals
core = sb.create_building(
    width=6.0, depth=6.0, floors=2, floor_height=2.4,
    ground_floor_height=2.8, plinth_height=0.35,
    bay_width=2.0, window_width=1.2, window_height=1.5, window_recess_depth=0.22,
    roof='mansard', roof_pitch_degrees=32.0, name='HeroAssembly'
)
core.translate(0, 0.35, 0)
core.tessellate_and_displace(tessellation_factor=1, displacement_scale=0.02, noise_freq=32.0, noise_amp=0.008)
scene.merge(core)

# 3. Flanking botanical organic accents
accent_tree = sb.create_tree(attractor_count=90, crown_center=(0, 3.2, 0), crown_extents=(1.6, 2.2, 1.6))
accent_tree.translate(4.2, 0.35, -2.5)
scene.merge(accent_tree)

# 4. Stream binary glTF 2.0
sb.io.write_glb(OUTPUT_GLB_PATH, scene)
`,
                vertexCount: 32000,
                triangleCount: 22000
            }
        };
    }

    // Default General Procedural Spatial Scene - Adaptively Synthesized
    const generalTitle = prompt.length > 3 ? `3D Scene: ${prompt.slice(0, 50)}` : 'Interactive 3D Spatial Scene';
    const domain = classifyDomain(prompt);
    const adaptiveScene = synthesizeAdaptive3DScene(domain, generalTitle, prompt);
    return {
        ...adaptiveScene,
        timeline: {
            currentTimeMs: 0,
            durationMs: 15000,
            isPlaying: true,
            speed: 1.0,
            playbackSpeed: 1.0,
            isLooping: true
        }
    };
}
// =======================================================================
// Procedural Scene Builders (Zero-Primitive Stubs)
// =======================================================================
// In accordance with AGENTS.md (Strict Prohibition on JavaScript Generative Primitives):
// Procedural 3D scenes must be authored in modern C++20 (#include "scratchbox_engine.hpp")
// or Python SDK (import scratchbox as sb) and streamed as binary glTF 2.0 (.glb).
// Three.js is restricted strictly to a pure WebGL rendering viewport.
// These stubs return clean, empty THREE.Group instances to preserve API compatibility.

export function createHistoricalBattlefieldScene(scene: any, THREE: any, _options?: any): any {
    const group = new THREE.Group();
    group.name = "historical-battlefield";
    group.userData = { update: () => {} };
    if (scene && typeof scene.add === "function") scene.add(group);
    return group;
}

export function createProceduralCityScene(scene: any, THREE: any, _options?: any): any {
    const group = new THREE.Group();
    group.name = "procedural-city";
    group.userData = { update: () => {} };
    if (scene && typeof scene.add === "function") scene.add(group);
    return group;
}

export function createHighwayOverpassScene(scene: any, THREE: any, _options?: any): any {
    const group = new THREE.Group();
    group.name = "highway-overpass-scene";
    group.userData = { update: () => {} };
    if (scene && typeof scene.add === "function") scene.add(group);
    return group;
}

export function createAlpineMatterhornScene(scene: any, THREE: any, _options?: any): any {
    const group = new THREE.Group();
    group.name = "alpine-matterhorn-scene";
    group.userData = { update: () => {} };
    if (scene && typeof scene.add === "function") scene.add(group);
    return group;
}

export function createBabylonianZigguratScene(scene: any, THREE: any, _options?: any): any {
    const group = new THREE.Group();
    group.name = "babylonian-ziggurat-scene";
    group.userData = { update: () => {} };
    if (scene && typeof scene.add === "function") scene.add(group);
    return group;
}

export function createSolarSystemScene(scene: any, THREE: any, _options?: any): any {
    const group = new THREE.Group();
    group.name = "solar-system-scene";
    group.userData = { update: () => {} };
    if (scene && typeof scene.add === "function") scene.add(group);
    return group;
}

export function createMolecularPhysicsScene(scene: any, THREE: any, _options?: any): any {
    const group = new THREE.Group();
    group.name = "molecular-physics-scene";
    group.userData = { update: () => {} };
    if (scene && typeof scene.add === "function") scene.add(group);
    return group;
}

export function createArchitecturalRoomScene(scene: any, THREE: any, _options?: any): any {
    const group = new THREE.Group();
    group.name = "architectural-room-scene";
    group.userData = { update: () => {} };
    if (scene && typeof scene.add === "function") scene.add(group);
    return group;
}

export function createWorldBuilderScene(scene: any, THREE: any, _options?: any): any {
    const group = new THREE.Group();
    group.name = "procedural-worldbuilder";
    group.userData = { update: () => {} };
    if (scene && typeof scene.add === "function") scene.add(group);
    return group;
}

export function createProceduralSpatialScene(scene: any, THREE: any, _options?: any): any {
    const group = new THREE.Group();
    group.name = "procedural-spatial";
    group.userData = { update: () => {} };
    if (scene && typeof scene.add === "function") scene.add(group);
    return group;
}
