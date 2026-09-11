/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import {
    CanvasArtifact,
    MarkdownDocumentData,
    Scene3DData
} from './canvas-types';
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
    Google3DTileService,
    type RealWorldLocationIntent,
    type ClayPresetId
} from './services/Google3DTileService';

export * from './services/worldbuilder';
export * from './services/mesh';
export * from './services/atmosphere';
export {
    detectRealWorldLocationIntent
};
export type {
    RealWorldLocationIntent,
    ClayPresetId
};

export type Procedural3DTheme =
    | 'worldbuilder'
    | 'battlefield'
    | 'city'
    | 'solar-system'
    | 'molecular'
    | 'architecture'
    | 'flight'
    | 'general';

/**
 * Detect the 3D scene semantic theme from prompt and surrounding context.
 */
export function detect3DSceneTheme(prompt: string, context?: { activeArtifact?: CanvasArtifact; chatHistory?: any; docTitle?: string; docContent?: string }): Procedural3DTheme {
    const promptLower = prompt.toLowerCase();
    const combined = `${prompt} ${context?.docTitle || ''} ${context?.activeArtifact?.title || ''} ${context?.docContent || ''}`.toLowerCase();

    // Check prompt first for direct user intent, then fall back to surrounding context
    for (const text of [promptLower, combined]) {
        // 0. Articulated Flight / Jet / Airplane / Drone
        if (/\b(?:planes?|airplanes?|jets?|flights?|aircrafts?|aviation|aerospace|drone\s*routes?|runways?)\b/i.test(text)) {
            return 'flight';
        }

        // 1. Historical Battlefield / Lexington / 1776 / Military / Castle Siege
        if (/lexington|concord|1776|battle|revolution|redcoat|minuteman|militia|firing line|bunker hill|gettysburg|waterloo|siege|castle|fortress|warfare|historical scene/i.test(text)) {
            return 'battlefield';
        }

        // 2. City / Metropolis / Cyberpunk / Architecture Skyline / Urban
        if (/city|metropolis|skyline|skyscraper|urban|cyberpunk city|downtown|traffic|street|futuristic city|highway/i.test(text)) {
            return 'city';
        }

        // 3. Space / Solar System / Celestial / Orbit / Galaxy / Planets / Asteroid
        if (/\b(?:solar system|planets?|planetary|orbits?|celestial|galaxy|galaxies|\bsun\b|mars|jupiter|saturn|asteroids?|starfield|space station|cosmos|astronomy)\b/i.test(text)) {
            return 'solar-system';
        }

        // 4. Molecular / Physics / Chemistry / Atoms / DNA / Quantum
        if (/molecule|molecular|atom|atomic|dna|double helix|chemical bond|physics simulation|particle|quantum|electron|lattice|chemistry/i.test(text)) {
            return 'molecular';
        }

        // 5. Architecture / Interior Room / Blueprint / House / Building Interior
        if (/room|interior|blueprint|architectur(e|al)|house|apartment|gallery|hall|pavilion|building floor|office space/i.test(text)) {
            return 'architecture';
        }

        // 6. Procedural Worldbuilder / Landscape / Terrain / Mountain / Alpine / Canyon / Desert / Island / Citadel / Open World
        if (/worldbuilder|open world|terrain|landscape|mountain|alpine|glacier|canyon|desert|oasis|badlands|island|citadel|valley|outpost|settlement|biome|heightmap/i.test(text)) {
            return 'worldbuilder';
        }
    }

    return 'general';
}

/**
 * Initializes and populates an operator stack for a 3D scene.
 */
export function initializeSceneOperatorStack(scene: Scene3DData): Scene3DData {
    if (scene.operatorStack && scene.operatorStack.length > 0) {
        return scene;
    }

    const engine = createOperatorEngine(scene);

    // 0. Import 3D tile if present
    const mapTileObj = scene.objects?.find(o => o.content?.type === 'map-3d');
    if (mapTileObj && scene.geoAnchor) {
        engine.dispatch('sb_import_3d_tile', {
            query: mapTileObj.lineage?.generation?.prompt || scene.geoAnchor.landmarkName || '3D Map Tile',
            lat: scene.geoAnchor.lat,
            lng: scene.geoAnchor.lng,
            clayPreset: mapTileObj.lineage?.generation?.params?.clayPreset || 'warm-clay'
        });
    }

    // 1. Setup lighting
    if (scene.environment?.lighting) {
        engine.dispatch('sb_setup_lighting', {
            preset: scene.environment.lighting,
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
                engine.dispatch('sb_create_material', {
                    materialId: matId,
                    name: `${m.name || m.id} Material`,
                    color: m.material.color,
                    roughness: m.material.roughness,
                    metalness: m.material.metalness,
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

function synthesizeRawContextual3DScene(
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

    const hasGodRays = /god\s*ray|crepuscular|light\s*shaft|volumetric/i.test(prompt) || !!existingFeatures?.godRays;
    const hasAtmosphere = /atmosphere|scattering|rayleigh|sunlight|realistic\s*sky|aerial|haze|cloud\s*shadow|landscape|mountain|terrain|valley|outdoor/i.test(prompt) || !!existingFeatures?.atmosphericScattering;
    const hasContrails = /contrail|vapor|vortex/i.test(prompt) || !!existingFeatures?.contrails;
    const hasControlSurfaces = /control\s*surface|aileron|elevator|rudder/i.test(prompt) || !!existingFeatures?.controlSurfaces;

    const atmosphericConfig = (hasAtmosphere || theme === 'worldbuilder' || theme === 'battlefield' || theme === 'city') ? {
        enabled: true,
        rayleigh: 0.55,
        mie: 0.003,
        turbidity: 1.6,
        mieDirectionalG: 0.82,
        volumetricClouds: true,
        cloudCoverage: 0.38,
        cloudDensity: 0.48,
        aerialPerspectiveEnabled: true,
        inscatteringIntensity: 1.1,
        aerialPerspectiveRange: 220.0,
        cloudShadowsEnabled: true,
        cloudShadowIntensity: 0.65,
        cloudShadowScale: 0.015,
        atmosphereShadowLength: 1.0,
        windVector: [0.05, 0.02] as [number, number]
    } : undefined;

    const baseFeatures = {
        ...(existingFeatures || {}),
        ...(hasGodRays ? { godRays: true } : {}),
        ...(atmosphericConfig ? { atmosphericScattering: atmosphericConfig } : {}),
        ...(hasContrails ? { contrails: true } : {}),
        ...(hasControlSurfaces ? { controlSurfaces: true } : {})
    };

    // Check if the prompt asks for a real-world location or landmark
    const realWorldLoc = detectRealWorldLocationIntent(prompt, context);
    if (realWorldLoc && realWorldLoc.isRealWorld) {
        // Extract clay preset preference if specified
        let clayPreset: ClayPresetId = 'warm-clay';
        if (/alabaster|white\s*clay|plaster/i.test(prompt)) clayPreset = 'alabaster';
        else if (/terracotta|brick\s*clay/i.test(prompt)) clayPreset = 'terracotta';
        else if (/obsidian|black\s*clay|dark\s*clay|slate/i.test(prompt)) clayPreset = 'obsidian';
        else if (/studio\s*grey|neutral\s*clay|grey\s*clay/i.test(prompt)) clayPreset = 'studio-grey';
        else if (/porcelain|ceramic/i.test(prompt)) clayPreset = 'porcelain';
        else if (/concrete|brutalist/i.test(prompt)) clayPreset = 'concrete';

        const tileService = Google3DTileService.getInstance();
        const tileResult = tileService.ingestTileRegionSync({
            query: realWorldLoc.landmarkName || realWorldLoc.query,
            lat: realWorldLoc.lat,
            lng: realWorldLoc.lng,
            elevation: realWorldLoc.elevation,
            clayPreset,
            detailLevel: 'high',
            includeBuildings: true,
            includeTerrain: true
        });

        // For real-world scenes anchored to 3D tiles, Google 3D Tiles provides the persistent real-world
        // architecture, trees, streets, and terrain. We attach the custom mesh definition and building meshes.
        const customMeshes: NonNullable<Scene3DData['customMeshes']> = [
            tileResult.customMeshDefinition,
            ...(tileResult.buildingMeshes || [])
        ];

        // If historical battlefield or tactical context, ground thematic actor figures on top of the real 3D tiles
        if (theme === 'battlefield') {
            customMeshes.push(
                {
                    id: 'mesh-minutemen-line',
                    name: 'Colonial Minutemen Militia Formation',
                    type: 'cylinder' as any,
                    position: [-8, 1.2, 5],
                    rotation: [0, Math.PI / 4, 0],
                    scale: [12, 2.2, 1.5],
                    material: { color: 0x2b4c7e, roughness: 0.6, metalness: 0.2 }
                },
                {
                    id: 'mesh-british-regiment',
                    name: 'British 10th Regiment of Foot Formation',
                    type: 'box' as any,
                    position: [12, 1.2, -5],
                    rotation: [0, -Math.PI / 6, 0],
                    scale: [14, 2.4, 2.0],
                    material: { color: 0xc82a2a, roughness: 0.5, metalness: 0.1 }
                }
            );
        }

        const sceneTitle = theme === 'battlefield'
            ? `Battle of ${realWorldLoc.landmarkName} (1775) — 3D Photorealistic Map Tile & Historical Model`
            : `${realWorldLoc.landmarkName} — 3D Real-World Clay Model`;

        return {
            title: sceneTitle,
            subtitle: `Geospatially grounded 3D architectural model at Lat ${realWorldLoc.lat.toFixed(4)}°, Lng ${realWorldLoc.lng.toFixed(4)}° (${tileResult.stats.buildingCount} structures, ${tileResult.stats.vertexCount} vertices, ${clayPreset} PBR shading).`,
            worldBranch: `real-world/${realWorldLoc.landmarkName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
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
                position: [0, 25, 45],
                target: [0, 2, 0],
                fov: 45
            },
            environment: {
                skybox: 'golden_hour',
                lighting: 'golden_hour',
                ground: false
            },
            geoAnchor: {
                lat: realWorldLoc.lat,
                lng: realWorldLoc.lng,
                elevation: realWorldLoc.elevation,
                active: true,
                landmarkName: realWorldLoc.landmarkName
            },
            customMeshes,
            objects: [tileResult.media4DObject],
            features: {
                ...baseFeatures,
                atmosphericScattering: {
                    enabled: true,
                    rayleigh: 0.55,
                    mie: 0.003,
                    turbidity: 1.6,
                    sunElevation: 28,
                    sunAzimuth: 145,
                    latitude: realWorldLoc.lat,
                    longitude: realWorldLoc.lng,
                    aerialPerspectiveEnabled: true,
                    inscatteringIntensity: 1.0,
                    cloudShadowsEnabled: true,
                    cloudShadowIntensity: 0.65
                },
                godRays: true
            }
        };
    }

    if (theme === 'worldbuilder') {
        const spec = planWorldIntentHeuristic(prompt);
        const grid = generateCompositeHeightfield(spec, 32);
        const actors = placeRegionalObjects(spec, grid, 1337);

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

        const customMeshes = actors.slice(0, 16).map(actor => ({
            id: `mesh-${actor.id}`,
            name: actor.name,
            type: (actor.type === 'Cube' ? 'box' : actor.type === 'Cylinder' ? 'cylinder' : actor.type === 'Cone' ? 'cylinder' : actor.type === 'Sphere' ? 'sphere' : 'box') as any,
            position: [actor.position.x, actor.position.y, actor.position.z] as [number, number, number],
            rotation: [actor.rotation.x, actor.rotation.y, actor.rotation.z] as [number, number, number],
            scale: [actor.scale.x * 2, actor.scale.y * 2, actor.scale.z * 2] as [number, number, number],
            material: {
                color: actor.material?.color || 0x38bdf8,
                roughness: actor.material?.roughness ?? 0.7,
                metalness: actor.material?.metalness ?? 0.1
            }
        }));

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
                position: [0, 35, 65],
                target: [0, 5, 0],
                fov: 50
            },
            environment: {
                skybox: spec.atmosphere?.skybox || 'daylight',
                lighting: spec.atmosphere?.lighting || 'daylight',
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
            geoAnchor: {
                lat: 40.7812,
                lng: -73.9665,
                elevation: grid.elevations[0] || 10.0,
                active: true,
                landmarkName: spec.name
            },
            customMeshes,
            customScript,
            code: customScript
        };
    }

    if (theme === 'battlefield') {
        const isLexington = /lexington/i.test(prompt) || /lexington/i.test(docTitle) || /1776|1775|revolution/i.test(prompt) || /1776|1775|revolution/i.test(docTitle);
        const title = isLexington
            ? 'Battle of Lexington (April 19, 1775) — 3D Battlefield Simulation'
            : 'Historical Battlefield & Landscape Simulation';
        const subtitle = isLexington
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

        return {
            title,
            subtitle,
            worldBranch: isLexington ? 'history/lexington-1775' : 'history/battlefield',
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
            geoAnchor: {
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
            customMeshes: [
                {
                    id: 'mesh-buckman-tavern',
                    name: 'Buckman Tavern (Colonial Timber Frame)',
                    type: 'box',
                    position: [-22, 4, -14],
                    scale: [12, 8, 14],
                    material: { color: 0x8b5a2b, roughness: 0.8, metalness: 0.1 }
                },
                {
                    id: 'mesh-meetinghouse',
                    name: 'Lexington Meetinghouse & Belfry',
                    type: 'box',
                    position: [18, 7, -20],
                    scale: [14, 14, 18],
                    material: { color: 0xd4c5b9, roughness: 0.7, metalness: 0.1 }
                },
                {
                    id: 'mesh-minutemen-line',
                    name: 'Colonial Minutemen Firing Line (Capt. John Parker)',
                    type: 'cylinder',
                    position: [-6, 1.2, 5],
                    scale: [14, 2.2, 1.5],
                    material: { color: 0x2b4c7e, roughness: 0.6, metalness: 0.2 }
                },
                {
                    id: 'mesh-redcoat-formation',
                    name: 'British 10th Regiment of Foot (Major John Pitcairn)',
                    type: 'cylinder',
                    position: [8, 1.2, 12],
                    scale: [18, 2.2, 1.8],
                    material: { color: 0xb22222, roughness: 0.5, metalness: 0.3 }
                },
                {
                    id: 'mesh-stone-wall',
                    name: 'Colonial Fieldstone Boundary Wall',
                    type: 'box',
                    position: [-10, 0.6, -2],
                    scale: [28, 1.2, 1.2],
                    material: { color: 0x708090, roughness: 0.9, metalness: 0.05 }
                }
            ],
            customScript,
            code: customScript
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
            code: customScript
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
                    material: { color: 0xffaa00, roughness: 0.1, metalness: 0.1 }
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
                    scale: [2, 2, 2],
                    material: { color: 0x38bdf8, roughness: 0.3, metalness: 0.6 }
                }
            ],
            customScript,
            code: customScript
        };
    }

    if (theme === 'architecture') {
        const title = 'Architectural Blueprint & Spatial Interior';
        const subtitle = '3D structural pavilion, spatial interior layout, structural columns, lighting bays, and holographic blueprint grid.';

        const customScript = `
const arch = createArchitecturalRoomScene(scene, THREE, {
    showBlueprintGrid: true,
    showFurniturePlinths: true
});

onFrame((time, delta) => {
    if (arch && arch.userData && typeof arch.userData.update === 'function') {
        arch.userData.update(time, delta);
    }
});
`;

        return {
            title,
            subtitle,
            worldBranch: 'architecture/pavilion',
            sceneType: 'architecture',
            renderMode: 'pbr',
            cameraMode: 'orbit',
            animation: 'idle',
            camera: {
                position: [20, 18, 25],
                target: [0, 4, 0],
                fov: 50
            },
            environment: {
                skybox: 'daylight',
                lighting: 'spotlight',
                ground: true
            },
            customMeshes: [
                {
                    id: 'mesh-room-floor',
                    name: 'Polished Concrete Foundation',
                    type: 'plane',
                    position: [0, 0, 0],
                    scale: [30, 30, 1],
                    material: { color: 0x1e293b, roughness: 0.2, metalness: 0.8 }
                }
            ],
            customScript,
            code: customScript
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
                skybox: 'realistic-sky',
                lighting: 'daylight',
                ground: true
            },
            features: {
                controlSurfaces: true,
                contrails: true,
                godRays: true,
                atmosphericScattering: true
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

    // Default General Procedural Spatial Scene
    const generalTitle = prompt.length > 3 ? `3D Scene: ${prompt.slice(0, 50)}` : 'Interactive 3D Spatial Scene';
    return {
        title: generalTitle,
        subtitle: 'Contextually generated procedural 3D environment and spatial geometry.',
        worldBranch: 'spatial/general',
        sceneType: 'general',
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
            position: [18, 14, 22],
            target: [0, 2, 0],
            fov: 45
        },
        environment: {
            skybox: 'cyberpunk',
            lighting: 'daylight',
            ground: true
        },
        customMeshes: [
            {
                id: 'mesh-spatial-core',
                name: 'Central Spatial Monolith',
                type: 'box',
                position: [0, 3, 0],
                scale: [4, 6, 4],
                material: { color: 0x00f3ff, roughness: 0.2, metalness: 0.9 }
            }
        ]
    };
}

// =======================================================================
// Three.js Procedural Scene Builders (Executed in Browser / WebGL Context)
// =======================================================================

/**
 * Procedural Historical Battlefield (Lexington Green with Tavern, Meetinghouse, Formations, and Smoke).
 */
export function createHistoricalBattlefieldScene(
    scene: any,
    THREE: any,
    options?: {
        ground?: boolean;
        trees?: boolean;
        tavern?: boolean;
        meetinghouse?: boolean;
        stoneWalls?: boolean;
        minutemenCount?: number;
        redcoatCount?: number;
        smokeParticles?: boolean;
    }
): any {
    const group = new THREE.Group();
    group.name = 'historical-battlefield';

    // 1. Terrain Grass Floor with Morning Mist Tone
    if (options?.ground !== false) {
        const groundGeo = new THREE.PlaneGeometry(120, 120, 32, 32);
        groundGeo.rotateX(-Math.PI / 2);
        
        // Add subtle elevation undulation
        const posAttr = groundGeo.attributes.position;
        if (posAttr) {
            for (let i = 0; i < posAttr.count; i++) {
                const x = posAttr.getX(i);
                const z = posAttr.getZ(i);
                const y = Math.sin(x * 0.08) * Math.cos(z * 0.08) * 0.6 + Math.sin(x * 0.03 + z * 0.02) * 1.0;
                posAttr.setY(i, y);
            }
            groundGeo.computeVertexNormals();
        }

        const groundMat = new THREE.MeshStandardMaterial({
            color: 0x3d5a2d,
            roughness: 0.9,
            metalness: 0.05
        });
        const groundMesh = new THREE.Mesh(groundGeo, groundMat);
        groundMesh.name = 'Lexington Green Ground';
        groundMesh.receiveShadow = true;
        group.add(groundMesh);
    }

    // 2. Buckman Tavern (Colonial 2-Story Building)
    if (options?.tavern !== false) {
        const tavernGroup = new THREE.Group();
        tavernGroup.name = 'Buckman Tavern';
        tavernGroup.position.set(-24, 0, -18);

        // Main Timber House Body
        const bodyMat = new THREE.MeshStandardMaterial({ color: 0x8b5a2b, roughness: 0.85, metalness: 0.05 });
        const bodyGeo = new THREE.BoxGeometry(14, 8, 12);
        const bodyMesh = new THREE.Mesh(bodyGeo, bodyMat);
        bodyMesh.position.y = 4;
        tavernGroup.add(bodyMesh);

        // Pitched Gable Roof
        const roofMat = new THREE.MeshStandardMaterial({ color: 0x3e2723, roughness: 0.9, metalness: 0.05 });
        const roofGeo = new THREE.ConeGeometry(10, 5, 4);
        roofGeo.rotateY(Math.PI / 4);
        const roofMesh = new THREE.Mesh(roofGeo, roofMat);
        roofMesh.position.y = 10.5;
        roofMesh.scale.set(1.1, 1, 0.9);
        tavernGroup.add(roofMesh);

        // Brick Chimney
        const chimMat = new THREE.MeshStandardMaterial({ color: 0x8b2500, roughness: 0.92, metalness: 0.0 });
        const chimGeo = new THREE.BoxGeometry(1.5, 6, 1.5);
        const chimMesh = new THREE.Mesh(chimGeo, chimMat);
        chimMesh.position.set(3, 11, 0);
        tavernGroup.add(chimMesh);

        // Windows (multi-pane glowing amber)
        const winMat = new THREE.MeshStandardMaterial({ color: 0xffe082, emissive: 0xd97706, emissiveIntensity: 0.25 });
        for (let row = 0; row < 2; row++) {
            for (let col = -2; col <= 2; col += 2) {
                const winGeo = new THREE.PlaneGeometry(1.4, 1.8);
                const win = new THREE.Mesh(winGeo, winMat);
                win.position.set(col * 2.5, 2.5 + row * 3.5, 6.05);
                tavernGroup.add(win);
            }
        }

        group.add(tavernGroup);
    }

    // 3. Lexington Meetinghouse & Belfry
    if (options?.meetinghouse !== false) {
        const meetingGroup = new THREE.Group();
        meetingGroup.name = 'Lexington Meetinghouse';
        meetingGroup.position.set(22, 0, -22);

        // White Weathered Clapboard Meetinghouse Body (balanced PBR roughness to prevent direct sunlight blowout)
        const churchMat = new THREE.MeshStandardMaterial({ color: 0xdcd8d0, roughness: 0.85, metalness: 0.02 });
        const bodyGeo = new THREE.BoxGeometry(16, 12, 18);
        const bodyMesh = new THREE.Mesh(bodyGeo, churchMat);
        bodyMesh.position.y = 6;
        meetingGroup.add(bodyMesh);

        // Meetinghouse Roof
        const roofMat = new THREE.MeshStandardMaterial({ color: 0x374151, roughness: 0.88, metalness: 0.05 });
        const roofGeo = new THREE.ConeGeometry(13, 6, 4);
        roofGeo.rotateY(Math.PI / 4);
        const roofMesh = new THREE.Mesh(roofGeo, roofMat);
        roofMesh.position.y = 15;
        roofMesh.scale.set(1.0, 1.0, 1.1);
        meetingGroup.add(roofMesh);

        // Steeple / Belfry Tower
        const steepleGeo = new THREE.ConeGeometry(2.5, 12, 8);
        const steepleMat = new THREE.MeshStandardMaterial({ color: 0xdcd8d0, roughness: 0.82, metalness: 0.02 });
        const steepleMesh = new THREE.Mesh(steepleGeo, steepleMat);
        steepleMesh.position.set(0, 24, 6);
        meetingGroup.add(steepleMesh);

        group.add(meetingGroup);
    }

    // 4. Low Stone Walls & Wooden Split-Rail Fences
    if (options?.stoneWalls !== false) {
        const wallGroup = new THREE.Group();
        wallGroup.name = 'Stone Walls & Rail Fences';
        const wallMat = new THREE.MeshStandardMaterial({ color: 0x64748b, roughness: 0.95, metalness: 0.05 });
        for (let w = -20; w <= 20; w += 4) {
            const stoneGeo = new THREE.BoxGeometry(3.8, 0.9, 0.8);
            const stoneMesh = new THREE.Mesh(stoneGeo, wallMat);
            stoneMesh.name = `Stone Wall Segment ${Math.floor((w + 20) / 4) + 1}`;
            stoneMesh.position.set(w, 0.45, -4 + (w % 3) * 0.2);
            stoneMesh.rotation.y = (Math.random() - 0.5) * 0.1;
            wallGroup.add(stoneMesh);
        }
        group.add(wallGroup);
    }

    // 5. Colonial Elm Trees
    if (options?.trees !== false) {
        const treeMat = new THREE.MeshStandardMaterial({ color: 0x2d6a4f, roughness: 0.85, metalness: 0.0 });
        const trunkMat = new THREE.MeshStandardMaterial({ color: 0x4a3728, roughness: 0.92, metalness: 0.0 });
        const treePositions = [
            [-32, 0, 8], [-18, 0, 22], [28, 0, 12], [35, 0, -8], [-5, 0, -28]
        ];
        let treeIdx = 0;
        for (const [tx, ty, tz] of treePositions) {
            const treeGroup = new THREE.Group();
            treeGroup.name = `Colonial Elm Tree ${treeIdx + 1}`;
            treeIdx++;
            treeGroup.position.set(tx, ty, tz);

            const trunkGeo = new THREE.CylinderGeometry(0.5, 0.8, 6, 8);
            const trunk = new THREE.Mesh(trunkGeo, trunkMat);
            trunk.position.y = 3;
            treeGroup.add(trunk);

            const canopyGeo = new THREE.SphereGeometry(3.5, 12, 12);
            canopyGeo.scale(1, 1.3, 1);
            const canopy = new THREE.Mesh(canopyGeo, treeMat);
            canopy.position.y = 8;
            treeGroup.add(canopy);

            group.add(treeGroup);
        }
    }

    // 6. Minutemen Firing Line (Colonial Militia)
    const minutemenGroup = new THREE.Group();
    minutemenGroup.name = 'Minutemen Militia Line';
    const mCount = options?.minutemenCount ?? 12;
    const militiaCoatMat = new THREE.MeshStandardMaterial({ color: 0x1e3a8a, roughness: 0.75, metalness: 0.05 });
    const hatMat = new THREE.MeshStandardMaterial({ color: 0x1e293b, roughness: 0.85, metalness: 0.0 });
    const musketMat = new THREE.MeshStandardMaterial({ color: 0x3e2723, metalness: 0.4, roughness: 0.5 });

    for (let i = 0; i < mCount; i++) {
        const soldier = new THREE.Group();
        soldier.name = `Minuteman Soldier ${i + 1}`;
        const offset = (i - mCount / 2) * 2.2;
        soldier.position.set(-8 + offset * 0.8, 0, 4 + (i % 2) * 0.8);
        soldier.rotation.y = Math.PI / 4; // Facing across the green

        // Torso / Blue Coat
        const body = new THREE.Mesh(new THREE.BoxGeometry(0.7, 1.2, 0.4), militiaCoatMat);
        body.position.y = 1.3;
        soldier.add(body);

        // Head
        const head = new THREE.Mesh(new THREE.SphereGeometry(0.24, 8, 8), new THREE.MeshStandardMaterial({ color: 0xffccaa, roughness: 0.8 }));
        head.position.y = 2.1;
        soldier.add(head);

        // Tricorn Hat
        const hat = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.25, 0.2, 3), hatMat);
        hat.position.y = 2.35;
        soldier.add(hat);

        // Musket pointing forward
        const musket = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 2.6), musketMat);
        musket.rotation.x = Math.PI / 2.2;
        musket.position.set(0.3, 1.4, 0.8);
        soldier.add(musket);

        minutemenGroup.add(soldier);
    }
    group.add(minutemenGroup);

    // 7. British Redcoat Regiment (Scarlet Line)
    const redcoatGroup = new THREE.Group();
    redcoatGroup.name = 'British Redcoat Regiment';
    const rCount = options?.redcoatCount ?? 16;
    const scarletMat = new THREE.MeshStandardMaterial({ color: 0xb91c1c, roughness: 0.65, metalness: 0.05 });
    const whiteBeltsMat = new THREE.MeshStandardMaterial({ color: 0xe2e8f0, roughness: 0.6, metalness: 0.02 });
    const redcoatHatMat = new THREE.MeshStandardMaterial({ color: 0x1e293b, roughness: 0.85, metalness: 0.0 });

    for (let i = 0; i < rCount; i++) {
        const soldier = new THREE.Group();
        soldier.name = `British Redcoat Soldier ${i + 1}`;
        const rank = Math.floor(i / 8);
        const col = i % 8;
        const offset = (col - 4) * 2.0;
        soldier.position.set(8 + offset * 0.8, 0, 14 + rank * 2.2);
        soldier.rotation.y = -Math.PI / 1.3; // Facing Minutemen

        // Red Coat
        const body = new THREE.Mesh(new THREE.BoxGeometry(0.7, 1.2, 0.4), scarletMat);
        body.position.y = 1.3;
        soldier.add(body);

        // White Crossbelt
        const belt = new THREE.Mesh(new THREE.BoxGeometry(0.74, 0.2, 0.42), whiteBeltsMat);
        belt.position.y = 1.3;
        soldier.add(belt);

        // Head
        const head = new THREE.Mesh(new THREE.SphereGeometry(0.24, 8, 8), new THREE.MeshStandardMaterial({ color: 0xffccaa }));
        head.position.y = 2.1;
        soldier.add(head);

        // Tall Military Mitre / Shako Cap
        const hat = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.25, 0.5, 8), redcoatHatMat);
        hat.position.y = 2.45;
        soldier.add(hat);

        // Musket with Bayonet
        const musket = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 2.8), musketMat);
        musket.rotation.x = Math.PI / 2.2;
        musket.position.set(0.3, 1.4, 0.9);
        soldier.add(musket);

        redcoatGroup.add(soldier);
    }
    group.add(redcoatGroup);

    // 8. Musket Smoke Particle System
    let smokePoints: any = null;
    if (options?.smokeParticles !== false) {
        const sCount = 180;
        const sGeo = new THREE.BufferGeometry();
        const sPos = new Float32Array(sCount * 3);
        const sVel = new Float32Array(sCount * 3);

        for (let i = 0; i < sCount; i++) {
            sPos[i * 3] = (Math.random() - 0.5) * 25;
            sPos[i * 3 + 1] = 1.2 + Math.random() * 4.0;
            sPos[i * 3 + 2] = 2 + (Math.random() - 0.5) * 14;

            sVel[i * 3] = 0.2 + Math.random() * 0.5; // Wind drift east
            sVel[i * 3 + 1] = 0.1 + Math.random() * 0.3; // Rise
            sVel[i * 3 + 2] = (Math.random() - 0.5) * 0.2;
        }

        sGeo.setAttribute('position', new THREE.BufferAttribute(sPos, 3));
        const sMat = new THREE.PointsMaterial({
            color: 0xe0e7ff,
            size: 1.8,
            transparent: true,
            opacity: 0.45,
            depthWrite: false
        });
        smokePoints = new THREE.Points(sGeo, sMat);
        smokePoints.name = 'Musket Smoke Particle Emitter';
        group.add(smokePoints);
    }

    // 9. Dawn Directional Sunlight & Morning Mist Fog
    const dawnLight = new THREE.DirectionalLight(0xffb74d, 1.4);
    dawnLight.position.set(-40, 25, 40);
    dawnLight.castShadow = true;
    group.add(dawnLight);

    const ambientLight = new THREE.AmbientLight(0x7986cb, 0.6);
    group.add(ambientLight);

    // Attach frame update hook to group userData
    group.userData.update = (_time: number, delta: number) => {
        if (smokePoints && smokePoints.geometry) {
            const pos = smokePoints.geometry.attributes.position;
            if (pos) {
                for (let i = 0; i < pos.count; i++) {
                    let x = pos.getX(i) + delta * 0.8;
                    let y = pos.getY(i) + delta * 0.3;
                    if (x > 30 || y > 10) {
                        x = -15 + (Math.random() - 0.5) * 10;
                        y = 1.0 + Math.random() * 1.5;
                    }
                    pos.setX(i, x);
                    pos.setY(i, y);
                }
                pos.needsUpdate = true;
            }
        }
    };

    scene.add(group);
    return group;
}

/**
 * Procedural City with Skyscrapers, Streets, Streetlights, and Traffic.
 */
export function createProceduralCityScene(
    scene: any,
    THREE: any,
    options?: {
        buildingCount?: number;
        animatedVehicles?: boolean;
        cyberpunk?: boolean;
    }
): any {
    const group = new THREE.Group();
    group.name = 'procedural-city';

    const bCount = options?.buildingCount ?? 28;
    const isCyberpunk = !!options?.cyberpunk;

    // Road Grid Ground
    const groundMat = new THREE.MeshStandardMaterial({
        color: isCyberpunk ? 0x0a0a14 : 0x1e293b,
        roughness: 0.4,
        metalness: 0.6
    });
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(160, 160), groundMat);
    ground.name = 'City Grid Ground';
    ground.rotateX(-Math.PI / 2);
    group.add(ground);

    // Procedural Skyscrapers
    const buildingMat = new THREE.MeshStandardMaterial({
        color: isCyberpunk ? 0x0f172a : 0x334155,
        roughness: 0.2,
        metalness: 0.8
    });
    const windowMat = new THREE.MeshStandardMaterial({
        color: isCyberpunk ? 0x00f3ff : 0xfef08a,
        emissive: isCyberpunk ? 0x00d2ff : 0xfde047,
        emissiveIntensity: isCyberpunk ? 0.8 : 0.4
    });

    const buildings: any[] = [];
    for (let i = 0; i < bCount; i++) {
        const bGroup = new THREE.Group();
        bGroup.name = `City Skyscraper ${i + 1}`;
        const gridX = ((i % 6) - 2.5) * 16 + (Math.random() - 0.5) * 4;
        const gridZ = (Math.floor(i / 6) - 2.5) * 16 + (Math.random() - 0.5) * 4;
        const height = 12 + Math.random() * 32;
        const width = 6 + Math.random() * 5;
        const depth = 6 + Math.random() * 5;

        const body = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), buildingMat);
        body.position.y = height / 2;
        bGroup.add(body);

        // Window Bands
        const bandCount = Math.floor(height / 4);
        for (let b = 1; b < bandCount; b++) {
            const band = new THREE.Mesh(new THREE.BoxGeometry(width * 1.02, 0.8, depth * 1.02), windowMat);
            band.position.y = b * 4;
            bGroup.add(band);
        }

        bGroup.position.set(gridX, 0, gridZ);
        group.add(bGroup);
        buildings.push(bGroup);
    }

    // Animated Floating Traffic / Vehicles
    const vehicles: any[] = [];
    if (options?.animatedVehicles !== false) {
        const vCount = 14;
        const vMat = new THREE.MeshBasicMaterial({ color: isCyberpunk ? 0xff007f : 0x38bdf8 });
        for (let v = 0; v < vCount; v++) {
            const veh = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.4, 3.0), vMat);
            veh.name = `Hover Vehicle ${v + 1}`;
            veh.position.set(
                (Math.random() - 0.5) * 70,
                1.5 + Math.random() * 8.0,
                (Math.random() - 0.5) * 70
            );
            veh.userData.speed = 10 + Math.random() * 20;
            veh.userData.axis = v % 2 === 0 ? 'x' : 'z';
            group.add(veh);
            vehicles.push(veh);
        }
    }

    // Ambient & Directional Lighting
    const light = new THREE.DirectionalLight(isCyberpunk ? 0x00f3ff : 0xffffff, 1.2);
    light.position.set(30, 60, 40);
    group.add(light);

    const amb = new THREE.AmbientLight(isCyberpunk ? 0x4c1d95 : 0x64748b, 0.8);
    group.add(amb);

    group.userData.update = (_time: number, delta: number) => {
        for (const v of vehicles) {
            const axis = v.userData.axis;
            if (axis === 'x') {
                v.position.x += delta * v.userData.speed;
                if (v.position.x > 45) v.position.x = -45;
            } else {
                v.position.z += delta * v.userData.speed;
                if (v.position.z > 45) v.position.z = -45;
            }
        }
    };

    scene.add(group);
    return group;
}

/**
 * Procedural Solar System with Central Star, Planets, Orbit Rings, and Asteroid Belt.
 */
export function createSolarSystemScene(
    scene: any,
    THREE: any,
    options?: {
        includeAsteroidBelt?: boolean;
        includeMoons?: boolean;
    }
): any {
    const group = new THREE.Group();
    group.name = 'solar-system';

    // 1. Central Glowing Sun
    const sunGeo = new THREE.SphereGeometry(5, 32, 32);
    const sunMat = new THREE.MeshBasicMaterial({ color: 0xffb703 });
    const sun = new THREE.Mesh(sunGeo, sunMat);
    sun.name = 'The Sun';
    group.add(sun);

    // Sun Point Light
    const sunLight = new THREE.PointLight(0xffffff, 2.5, 300);
    sunLight.name = 'Sun Light';
    group.add(sunLight);

    // 2. Planets Data
    const planetDefs = [
        { name: 'Mercury', radius: 0.6, dist: 9, speed: 1.8, color: 0xa8a29e },
        { name: 'Venus', radius: 1.1, dist: 14, speed: 1.3, color: 0xfde047 },
        { name: 'Earth', radius: 1.2, dist: 20, speed: 1.0, color: 0x38bdf8 },
        { name: 'Mars', radius: 0.8, dist: 26, speed: 0.8, color: 0xef4444 },
        { name: 'Jupiter', radius: 2.8, dist: 38, speed: 0.45, color: 0xd97706, hasRings: true },
        { name: 'Saturn', radius: 2.2, dist: 50, speed: 0.35, color: 0xfef08a, hasRings: true },
        { name: 'Uranus', radius: 1.6, dist: 60, speed: 0.25, color: 0x22d3ee },
        { name: 'Neptune', radius: 1.5, dist: 70, speed: 0.18, color: 0x3b82f6 }
    ];

    const planets: any[] = [];
    for (const p of planetDefs) {
        const pGroup = new THREE.Group();
        pGroup.name = `Planet ${p.name}`;

        // Orbit Line Ring
        const ringGeo = new THREE.RingGeometry(p.dist - 0.05, p.dist + 0.05, 64);
        ringGeo.rotateX(Math.PI / 2);
        const ringMat = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide, transparent: true, opacity: 0.15 });
        const ring = new THREE.Mesh(ringGeo, ringMat);
        ring.name = `${p.name} Orbit Ring`;
        group.add(ring);

        // Planet Mesh
        const pMesh = new THREE.Mesh(
            new THREE.SphereGeometry(p.radius, 24, 24),
            new THREE.MeshStandardMaterial({ color: p.color, roughness: 0.5, metalness: 0.1 })
        );
        pMesh.name = `${p.name} Body`;
        pMesh.position.x = p.dist;
        pGroup.add(pMesh);

        // Optional Rings for Saturn/Jupiter
        if (p.hasRings) {
            const pRingGeo = new THREE.RingGeometry(p.radius * 1.4, p.radius * 2.3, 32);
            pRingGeo.rotateX(Math.PI / 2.5);
            const pRing = new THREE.Mesh(
                pRingGeo,
                new THREE.MeshBasicMaterial({ color: p.color, side: THREE.DoubleSide, transparent: true, opacity: 0.6 })
            );
            pRing.name = `${p.name} Planetary Rings`;
            pRing.position.x = p.dist;
            pGroup.add(pRing);
        }

        pGroup.userData = { speed: p.speed, dist: p.dist };
        group.add(pGroup);
        planets.push(pGroup);
    }

    // 3. Asteroid Belt
    if (options?.includeAsteroidBelt !== false) {
        const aCount = 150;
        const aGeo = new THREE.DodecahedronGeometry(0.2, 0);
        const aMat = new THREE.MeshStandardMaterial({ color: 0x78716c, roughness: 0.9 });
        for (let a = 0; a < aCount; a++) {
            const angle = Math.random() * Math.PI * 2;
            const dist = 30 + (Math.random() - 0.5) * 4;
            const ast = new THREE.Mesh(aGeo, aMat);
            ast.position.set(Math.cos(angle) * dist, (Math.random() - 0.5) * 1.5, Math.sin(angle) * dist);
            group.add(ast);
        }
    }

    group.userData.update = (time: number, _delta: number) => {
        for (const p of planets) {
            p.rotation.y = time * 0.4 * p.userData.speed;
        }
    };

    scene.add(group);
    return group;
}

/**
 * Procedural Molecular Lattice & Quantum Physics Simulation.
 */
export function createMolecularPhysicsScene(
    scene: any,
    THREE: any,
    options?: {
        latticeType?: 'dna' | 'caffeine' | 'lattice';
        showElectronCloud?: boolean;
    }
): any {
    const group = new THREE.Group();
    group.name = 'molecular-physics';

    const isDna = options?.latticeType === 'dna';

    if (isDna) {
        // DNA Double Helix Spiral
        const rCount = 24;
        const radius = 4;
        const pitch = 0.8;
        const strand1Mat = new THREE.MeshStandardMaterial({ color: 0xef4444, metalness: 0.3, roughness: 0.4 });
        const strand2Mat = new THREE.MeshStandardMaterial({ color: 0x3b82f6, metalness: 0.3, roughness: 0.4 });
        const rungMat = new THREE.MeshStandardMaterial({ color: 0x10b981, metalness: 0.5, roughness: 0.2 });

        for (let i = 0; i < rCount; i++) {
            const angle = i * 0.4;
            const y = (i - rCount / 2) * pitch;

            const x1 = Math.cos(angle) * radius;
            const z1 = Math.sin(angle) * radius;
            const x2 = Math.cos(angle + Math.PI) * radius;
            const z2 = Math.sin(angle + Math.PI) * radius;

            // Atom 1
            const atom1 = new THREE.Mesh(new THREE.SphereGeometry(0.45, 16, 16), strand1Mat);
            atom1.position.set(x1, y, z1);
            group.add(atom1);

            // Atom 2
            const atom2 = new THREE.Mesh(new THREE.SphereGeometry(0.45, 16, 16), strand2Mat);
            atom2.position.set(x2, y, z2);
            group.add(atom2);

            // Connecting Rung Cylinder
            const rung = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, radius * 2), rungMat);
            rung.position.set(0, y, 0);
            rung.rotation.z = Math.PI / 2;
            rung.rotation.y = -angle;
            group.add(rung);
        }
    } else {
        // Molecular Lattice / Buckyball Cluster
        const atoms = [
            { x: 0, y: 0, z: 0, color: 0x1f2937, size: 0.9 }, // Carbon
            { x: 2.2, y: 1.2, z: 0, color: 0x3b82f6, size: 0.75 }, // Nitrogen
            { x: -2.2, y: 1.2, z: 0, color: 0xef4444, size: 0.75 }, // Oxygen
            { x: 0, y: 2.4, z: 1.5, color: 0x10b981, size: 0.6 },
            { x: 0, y: -2.4, z: -1.5, color: 0xf59e0b, size: 0.6 }
        ];

        for (const a of atoms) {
            const mesh = new THREE.Mesh(
                new THREE.SphereGeometry(a.size, 24, 24),
                new THREE.MeshStandardMaterial({ color: a.color, metalness: 0.4, roughness: 0.2 })
            );
            mesh.position.set(a.x, a.y, a.z);
            group.add(mesh);
        }
    }

    // Electron Probability Cloud Particles
    const pCount = 200;
    const pGeo = new THREE.BufferGeometry();
    const pPos = new Float32Array(pCount * 3);
    for (let i = 0; i < pCount; i++) {
        const u = Math.random();
        const v = Math.random();
        const theta = u * 2.0 * Math.PI;
        const phi = Math.acos(2.0 * v - 1.0);
        const r = 5.5 + Math.random() * 2.5;
        pPos[i * 3] = r * Math.sin(phi) * Math.cos(theta);
        pPos[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
        pPos[i * 3 + 2] = r * Math.cos(phi);
    }
    pGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3));
    const pMat = new THREE.PointsMaterial({ color: 0x00f3ff, size: 0.3, transparent: true, opacity: 0.5 });
    const cloud = new THREE.Points(pGeo, pMat);
    group.add(cloud);

    const light = new THREE.PointLight(0xffffff, 1.8, 50);
    light.position.set(10, 15, 10);
    group.add(light);

    group.userData.update = (time: number, _delta: number) => {
        group.rotation.y = time * 0.5;
        cloud.rotation.x = time * 0.2;
    };

    scene.add(group);
    return group;
}

/**
 * Procedural Architectural Room / Interior Studio Scene.
 */
export function createArchitecturalRoomScene(
    scene: any,
    THREE: any,
    _options?: any
): any {
    const group = new THREE.Group();
    group.name = 'architectural-room';

    // 1. Polished Concrete Floor
    const floor = new THREE.Mesh(
        new THREE.PlaneGeometry(36, 36),
        new THREE.MeshStandardMaterial({ color: 0x0f172a, roughness: 0.2, metalness: 0.8 })
    );
    floor.name = 'Polished Studio Floor';
    floor.rotateX(-Math.PI / 2);
    group.add(floor);

    // 2. Structural Minimalist Walls
    const wallMat = new THREE.MeshStandardMaterial({ color: 0xf8fafc, roughness: 0.8 });
    const backWall = new THREE.Mesh(new THREE.BoxGeometry(36, 14, 1), wallMat);
    backWall.name = 'Structural Back Wall';
    backWall.position.set(0, 7, -18);
    group.add(backWall);

    const leftWall = new THREE.Mesh(new THREE.BoxGeometry(1, 14, 36), wallMat);
    leftWall.name = 'Structural Left Wall';
    leftWall.position.set(-18, 7, 0);
    group.add(leftWall);

    // 3. Architectural Pillars
    const pillarMat = new THREE.MeshStandardMaterial({ color: 0x334155, metalness: 0.7, roughness: 0.3 });
    let pIdx = 1;
    for (const px of [-10, 10]) {
        for (const pz of [-10, 10]) {
            const pillar = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.6, 14, 16), pillarMat);
            pillar.name = `Architectural Pillar ${pIdx++}`;
            pillar.position.set(px, 7, pz);
            group.add(pillar);
        }
    }

    // 4. Central Holographic Blueprint Plinth
    const plinth = new THREE.Mesh(
        new THREE.CylinderGeometry(3, 3.5, 1.2, 32),
        new THREE.MeshStandardMaterial({ color: 0x1e293b, metalness: 0.9, roughness: 0.1 })
    );
    plinth.name = 'Holographic Plinth';
    plinth.position.set(0, 0.6, 0);
    group.add(plinth);

    // Holographic Wireframe Cube on Plinth
    const wire = new THREE.Mesh(
        new THREE.BoxGeometry(3.5, 3.5, 3.5),
        new THREE.MeshBasicMaterial({ color: 0x00f3ff, wireframe: true })
    );
    wire.name = 'Holographic Blueprint Prism';
    wire.position.set(0, 3.8, 0);
    group.add(wire);

    // Spotlights
    const spot = new THREE.SpotLight(0xffffff, 2.0, 40, Math.PI / 4, 0.3);
    spot.position.set(0, 13, 0);
    spot.target = plinth;
    group.add(spot);

    group.userData.update = (time: number, _delta: number) => {
        wire.rotation.y = time * 0.6;
        wire.rotation.x = time * 0.3;
    };

    scene.add(group);
    return group;
}

/**
 * Procedural Open World & Terrain Foundation Builder.
 * Synthesizes terrain heightfield mesh, placed regional actors (structures, flora, props), and dynamic atmospheric sun lighting.
 */
export function createWorldBuilderScene(
    scene: any,
    THREE: any,
    options?: {
        spec?: WorldSpecification;
        prompt?: string;
        resolution?: number;
        seed?: number;
    }
): any {
    const spec = options?.spec || planWorldIntentHeuristic(options?.prompt || 'Scenic alpine mountain valley with settlements and forests');
    const resolution = options?.resolution || 32;
    const grid = generateCompositeHeightfield(spec, resolution);
    const actors = placeRegionalObjects(spec, grid, options?.seed || 1337);

    const group = new THREE.Group();
    group.name = 'procedural-worldbuilder';

    // 1. Terrain Mesh
    const terrainMesh = createTerrainMesh(grid, THREE, {
        width: 160,
        depth: 160,
        color: spec.terrain.baseMaterial.color,
        roughness: spec.terrain.baseMaterial.roughness,
        metalness: spec.terrain.baseMaterial.metalness,
        wireframe: !!spec.terrain.baseMaterial.wireframe
    });
    group.add(terrainMesh);

    // 2. Placed Actors (Structures, towers, trees, rocks, props)
    for (const actor of actors) {
        let actorMesh: any;
        const colorHex = actor.material?.color ? Number(String(actor.material.color).replace('#', '0x')) : 0x38bdf8;
        const mat = new THREE.MeshStandardMaterial({
            color: isNaN(colorHex) ? 0x38bdf8 : colorHex,
            roughness: actor.material?.roughness ?? 0.7,
            metalness: actor.material?.metalness ?? 0.1
        });

        if (actor.type === 'Cube' || actor.type === 'Box') {
            actorMesh = new THREE.Mesh(new THREE.BoxGeometry(actor.scale.x * 2, actor.scale.y * 2, actor.scale.z * 2), mat);
        } else if (actor.type === 'Cylinder') {
            actorMesh = new THREE.Mesh(new THREE.CylinderGeometry(actor.scale.x, actor.scale.x * 1.1, actor.scale.y * 2, 16), mat);
        } else if (actor.type === 'Cone') {
            actorMesh = new THREE.Mesh(new THREE.ConeGeometry(actor.scale.x * 1.4, actor.scale.y * 2.2, 8), mat);
        } else if (actor.type === 'Sphere') {
            actorMesh = new THREE.Mesh(new THREE.SphereGeometry(actor.scale.x, 16, 16), mat);
        } else {
            actorMesh = new THREE.Mesh(new THREE.BoxGeometry(actor.scale.x * 2, actor.scale.y * 2, actor.scale.z * 2), mat);
        }

        actorMesh.position.set(actor.position.x, actor.position.y, actor.position.z);
        actorMesh.rotation.set(
            (actor.rotation.x * Math.PI) / 180,
            (actor.rotation.y * Math.PI) / 180,
            (actor.rotation.z * Math.PI) / 180
        );
        actorMesh.castShadow = true;
        actorMesh.receiveShadow = true;
        group.add(actorMesh);
    }

    // 3. Directional Atmospheric Sun Lighting
    const lightColorHex = spec.atmosphere?.lightColor ? Number(spec.atmosphere.lightColor.replace('#', '0x')) : 0xffeedd;
    const sun = new THREE.DirectionalLight(isNaN(lightColorHex) ? 0xffffff : lightColorHex, spec.atmosphere?.sunIntensity ?? 1.5);
    sun.position.set(40, 65, 40);
    sun.castShadow = true;
    group.add(sun);

    const ambient = new THREE.AmbientLight(0x64748b, 0.6);
    group.add(ambient);

    group.userData = {
        spec,
        grid,
        actors,
        update: (_time: number, _delta: number) => {
            // Environmental update hook
        }
    };

    scene.add(group);
    return group;
}

/**
 * General Procedural Spatial Geometry (Clean geometric focal center).
 */
export function createProceduralSpatialScene(
    scene: any,
    THREE: any,
    _options?: any
): any {
    const group = new THREE.Group();
    group.name = 'procedural-spatial';

    // Ground Grid
    const grid = new THREE.GridHelper(40, 40, 0x00f3ff, 0x1e293b);
    grid.name = 'Spatial Grid Floor';
    grid.position.y = 0;
    group.add(grid);

    // Central Floating Crystal Monolith
    const crystalGeo = new THREE.OctahedronGeometry(2.8, 0);
    const crystalMat = new THREE.MeshStandardMaterial({
        color: 0x38bdf8,
        emissive: 0x0284c7,
        emissiveIntensity: 0.3,
        roughness: 0.1,
        metalness: 0.9
    });
    const crystal = new THREE.Mesh(crystalGeo, crystalMat);
    crystal.name = 'Quantum Monolith Prism';
    crystal.position.y = 4.5;
    group.add(crystal);

    // Orbiting Data Rings
    const ringMat = new THREE.MeshBasicMaterial({ color: 0x00f3ff, wireframe: true });
    const ring1 = new THREE.Mesh(new THREE.TorusGeometry(4.5, 0.08, 16, 64), ringMat);
    ring1.name = 'Inner Flux Ring';
    ring1.position.y = 4.5;
    ring1.rotateX(Math.PI / 3);
    group.add(ring1);

    const ring2 = new THREE.Mesh(new THREE.TorusGeometry(5.2, 0.08, 16, 64), ringMat);
    ring2.name = 'Outer Flux Ring';
    ring2.position.y = 4.5;
    ring2.rotateY(Math.PI / 3);
    group.add(ring2);

    const light = new THREE.PointLight(0x00f3ff, 1.8, 40);
    light.position.set(0, 6, 0);
    group.add(light);

    group.userData.update = (time: number, _delta: number) => {
        crystal.rotation.y = time * 0.8;
        crystal.position.y = 4.5 + Math.sin(time * 2) * 0.4;
        ring1.rotation.z = time * 0.5;
        ring2.rotation.x = time * 0.4;
    };

    scene.add(group);
    return group;
}
