/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { GoogleGenAI, Type } from '@google/genai';
import {
    WorldSpecification,
    SwarmTaskBucket
} from './worldbuilder-types';

const worldSpecificationSchema = {
    type: Type.OBJECT,
    properties: {
        name: { type: Type.STRING, description: 'Name of the generated world' },
        theme: { type: Type.STRING, description: 'Theme and core narrative of the world' },
        mood: { type: Type.STRING, description: 'Atmospheric or lighting mood of the world' },
        timeOfDay: { type: Type.NUMBER, description: 'Time of day in decimal hours (0.0 to 24.0, e.g. 18.0 for sunset)' },
        regions: {
            type: Type.ARRAY,
            description: 'Major regions within the open world (3 to 6 regions)',
            items: {
                type: Type.OBJECT,
                properties: {
                    id: { type: Type.STRING, description: 'Unique identifier for the region (e.g. region_north, settlement_center)' },
                    name: { type: Type.STRING, description: 'Display name of the region' },
                    category: {
                        type: Type.STRING,
                        enum: ['mountain', 'canyon', 'desert', 'valley', 'coast', 'settlement', 'forest', 'river', 'plain', 'island', 'citadel', 'spaceport', 'ruins']
                    },
                    description: { type: Type.STRING, description: 'Brief visual description of the landscape, layout, and purpose' },
                    relativePosition: {
                        type: Type.STRING,
                        enum: ['north', 'south', 'east', 'west', 'center', 'northeast', 'northwest', 'southeast', 'southwest']
                    },
                    baseElevation: { type: Type.NUMBER, description: 'Approximate base elevation/height offset of this region in meters' }
                },
                required: ['id', 'name', 'category', 'description', 'relativePosition', 'baseElevation']
            }
        },
        terrain: {
            type: Type.OBJECT,
            description: 'Global terrain characteristics',
            properties: {
                elevationMin: { type: Type.NUMBER, description: 'Minimum elevation boundary in meters' },
                elevationMax: { type: Type.NUMBER, description: 'Maximum elevation boundary in meters' },
                erosionWeight: { type: Type.NUMBER, description: 'Amount of geomorphic hydraulic erosion or relief (0.0 to 1.0)' },
                terracation: { type: Type.NUMBER, description: 'Terracing step factor to create flat shelves (0.0 to 1.0)' },
                noiseScale: { type: Type.NUMBER, description: 'FBM noise frequency scale for terrain variations' },
                baseMaterial: {
                    type: Type.OBJECT,
                    properties: {
                        color: { type: Type.STRING, description: 'Primary hex color for ground terrain (#RRGGBB)' },
                        roughness: { type: Type.NUMBER, description: 'Roughness of terrain surface (0.0 to 1.0)' },
                        metalness: { type: Type.NUMBER, description: 'Metalness of terrain surface (0.0 to 1.0)' }
                    },
                    required: ['color', 'roughness', 'metalness']
                }
            },
            required: ['elevationMin', 'elevationMax', 'erosionWeight', 'terracation', 'noiseScale', 'baseMaterial']
        },
        objects: {
            type: Type.ARRAY,
            description: 'List of key 3D actors or groups of objects to scatter and place',
            items: {
                type: Type.OBJECT,
                properties: {
                    id: { type: Type.STRING, description: 'Unique identifier for this object requirement' },
                    category: { type: Type.STRING, description: 'Object type or model name (e.g. tree, rock, tower, house, cart, bridge, outpost, beacon)' },
                    regionId: { type: Type.STRING, description: 'ID of the region this object should reside in' },
                    density: { type: Type.NUMBER, description: 'Quantity of this object to generate in this region' },
                    scale: { type: Type.NUMBER, description: 'Uniform scale multiplier' },
                    placementRule: {
                        type: Type.STRING,
                        enum: ['on_ground', 'scattered', 'centered', 'slope_aligned', 'perimeter', 'grid']
                    }
                },
                required: ['id', 'category', 'regionId', 'density', 'scale', 'placementRule']
            }
        }
    },
    required: ['name', 'theme', 'mood', 'timeOfDay', 'regions', 'terrain', 'objects']
};

/**
 * Deterministic Heuristic World Intent Planner (In-Tree Offline Fallback).
 * Deconstructs natural language world prompts across diverse themes into production-grade WorldSpecification.
 */
export function planWorldIntentHeuristic(prompt: string): WorldSpecification {
    const p = prompt.toLowerCase();

    // 1. Sci-Fi City / Cyberpunk / Metropolis / Space Station
    if (/cyberpunk|sci-fi|scifi|futuristic|metropolis|city|skyline|neon|space station|orbital/i.test(p)) {
        const isCyber = /cyberpunk|neon|night/i.test(p);
        return {
            name: isCyber ? 'Neo-Tokyo Cyberpunk Sector' : 'Futuristic Megacity Hub',
            theme: isCyber ? 'Cyberpunk metropolis with neon spires and transit corridors' : 'Futuristic high-density architectural metropolis',
            mood: isCyber ? 'Rain-soaked night with vivid neon emission' : 'Clear daylight with glass and titanium reflections',
            timeOfDay: isCyber ? 21.5 : 14.0,
            regions: [
                {
                    id: 'reg_downtown',
                    name: 'Central Plaza & Spire',
                    category: 'settlement',
                    description: 'High-density commercial core with towering megastructures',
                    relativePosition: 'center',
                    baseElevation: 0.0
                },
                {
                    id: 'reg_north_towers',
                    name: 'North Sky-Rises',
                    category: 'settlement',
                    description: 'Tiered skyscraper towers and transit lines',
                    relativePosition: 'north',
                    baseElevation: 12.0
                },
                {
                    id: 'reg_industrial_east',
                    name: 'East Energy Outpost',
                    category: 'citadel',
                    description: 'Power generation plants and transmission pylons',
                    relativePosition: 'east',
                    baseElevation: 4.0
                },
                {
                    id: 'reg_west_docks',
                    name: 'West Spaceport Docks',
                    category: 'spaceport',
                    description: 'Landing pads and autonomous cargo bays',
                    relativePosition: 'west',
                    baseElevation: 2.0
                }
            ],
            terrain: {
                elevationMin: -2.0,
                elevationMax: 35.0,
                erosionWeight: 0.05,
                terracation: 0.85,
                noiseScale: 0.6,
                baseMaterial: {
                    color: isCyber ? '#0b0f19' : '#1e293b',
                    roughness: 0.3,
                    metalness: 0.7
                }
            },
            objects: [
                {
                    id: 'obj_spire',
                    category: 'tower',
                    regionId: 'reg_downtown',
                    density: 3,
                    scale: 3.5,
                    placementRule: 'centered'
                },
                {
                    id: 'obj_skyscrapers',
                    category: 'house',
                    regionId: 'reg_north_towers',
                    density: 8,
                    scale: 2.2,
                    placementRule: 'scattered'
                },
                {
                    id: 'obj_pylons',
                    category: 'tower',
                    regionId: 'reg_industrial_east',
                    density: 4,
                    scale: 1.8,
                    placementRule: 'slope_aligned'
                },
                {
                    id: 'obj_beacons',
                    category: 'beacon',
                    regionId: 'reg_west_docks',
                    density: 6,
                    scale: 1.0,
                    placementRule: 'scattered'
                }
            ],
            atmosphere: {
                skybox: isCyber ? 'cyberpunk' : 'daylight',
                lighting: isCyber ? 'neon' : 'daylight',
                timeOfDay: isCyber ? 21.5 : 14.0,
                lightColor: isCyber ? '#00f3ff' : '#ffffff',
                lightTemperature: isCyber ? 8500 : 6500,
                sunIntensity: isCyber ? 0.4 : 1.5
            }
        };
    }

    // 2. Historical Battlefield / Lexington / Medieval Siege / Castle
    if (/battle|battlefield|lexington|revolution|1776|1775|minuteman|redcoat|castle|medieval|fortress|siege|ruins/i.test(p)) {
        const isCastle = /castle|medieval|fortress|siege/i.test(p);
        return {
            name: isCastle ? 'Medieval Fortress & Outer Bailey' : 'Historic Lexington Battle Green',
            theme: isCastle ? 'Medieval citadel perched atop defensive terrain' : 'Historical revolutionary colonial landscape with tactical lines',
            mood: isCastle ? 'Overcast dramatic medieval dawn' : 'Crisp morning mist with early sunlight',
            timeOfDay: 6.8,
            regions: [
                {
                    id: 'reg_fortress_center',
                    name: isCastle ? 'Keep & Courtyard' : 'Village Green',
                    category: isCastle ? 'citadel' : 'plain',
                    description: isCastle ? 'Fortified inner ward with stone battlements' : 'Open grassy commons surrounded by colonial timber structures',
                    relativePosition: 'center',
                    baseElevation: isCastle ? 18.0 : 2.0
                },
                {
                    id: 'reg_north_ridge',
                    name: isCastle ? 'North Mountain Escarpment' : 'North Ridge & Buckman Tavern',
                    category: isCastle ? 'mountain' : 'valley',
                    description: isCastle ? 'Steep crags offering natural defense' : 'Wooded ridge line with historic tavern and split-rail fences',
                    relativePosition: 'north',
                    baseElevation: isCastle ? 32.0 : 6.0
                },
                {
                    id: 'reg_south_approach',
                    name: 'South Road & River Crossing',
                    category: 'river',
                    description: 'Approaching gravel road with stone boundary bridge',
                    relativePosition: 'south',
                    baseElevation: 0.0
                },
                {
                    id: 'reg_east_flank',
                    name: 'East Tree Grove',
                    category: 'forest',
                    description: 'Dense deciduous elm and oak woodland',
                    relativePosition: 'east',
                    baseElevation: 4.0
                }
            ],
            terrain: {
                elevationMin: -1.0,
                elevationMax: isCastle ? 45.0 : 15.0,
                erosionWeight: 0.25,
                terracation: isCastle ? 0.6 : 0.2,
                noiseScale: 1.2,
                baseMaterial: {
                    color: '#3d5a2d',
                    roughness: 0.85,
                    metalness: 0.05
                }
            },
            objects: [
                {
                    id: 'obj_main_structure',
                    category: isCastle ? 'tower' : 'house',
                    regionId: 'reg_fortress_center',
                    density: isCastle ? 4 : 2,
                    scale: isCastle ? 3.0 : 1.8,
                    placementRule: 'centered'
                },
                {
                    id: 'obj_perimeter_trees',
                    category: 'tree',
                    regionId: 'reg_east_flank',
                    density: 16,
                    scale: 1.3,
                    placementRule: 'scattered'
                },
                {
                    id: 'obj_boundary_rocks',
                    category: 'rock',
                    regionId: 'reg_north_ridge',
                    density: 8,
                    scale: 1.5,
                    placementRule: 'slope_aligned'
                },
                {
                    id: 'obj_approach_props',
                    category: 'house',
                    regionId: 'reg_south_approach',
                    density: 2,
                    scale: 1.2,
                    placementRule: 'on_ground'
                }
            ],
            atmosphere: {
                skybox: 'dawn-mist',
                lighting: 'dawn',
                timeOfDay: 6.8,
                lightColor: '#ffb74d',
                lightTemperature: 3800,
                sunIntensity: 1.4
            }
        };
    }

    // 3. Alpine Village / Mountains / Glaciers / Winter
    if (/alpine|mountain|glacier|snow|frozen|fjord|peak|valley|everest/i.test(p)) {
        return {
            name: 'Alpine Glacial Valley & Chalets',
            theme: 'Dramatic snow-capped peaks embracing a serene mountain valley',
            mood: 'Pristine crisp alpine atmosphere with bright sun on snow',
            timeOfDay: 11.0,
            regions: [
                {
                    id: 'reg_valley_floor',
                    name: 'Valley Basin & Village',
                    category: 'valley',
                    description: 'Sheltered meadow along a glacial stream',
                    relativePosition: 'center',
                    baseElevation: 4.0
                },
                {
                    id: 'reg_north_peak',
                    name: 'North Jagged Summit',
                    category: 'mountain',
                    description: 'Sheer granite peaks and snow fields',
                    relativePosition: 'north',
                    baseElevation: 42.0
                },
                {
                    id: 'reg_west_glacier',
                    name: 'West Glacial Moraine',
                    category: 'mountain',
                    description: 'Terraced ice flow and boulder fields',
                    relativePosition: 'west',
                    baseElevation: 28.0
                },
                {
                    id: 'reg_south_pines',
                    name: 'South Pine Forest Slopes',
                    category: 'forest',
                    description: 'Dense evergreen coniferous forest',
                    relativePosition: 'south',
                    baseElevation: 14.0
                }
            ],
            terrain: {
                elevationMin: 0.0,
                elevationMax: 65.0,
                erosionWeight: 0.45,
                terracation: 0.4,
                noiseScale: 1.8,
                baseMaterial: {
                    color: '#e2e8f0',
                    roughness: 0.7,
                    metalness: 0.1
                }
            },
            objects: [
                {
                    id: 'obj_chalets',
                    category: 'house',
                    regionId: 'reg_valley_floor',
                    density: 6,
                    scale: 1.5,
                    placementRule: 'scattered'
                },
                {
                    id: 'obj_pines',
                    category: 'tree',
                    regionId: 'reg_south_pines',
                    density: 22,
                    scale: 1.4,
                    placementRule: 'slope_aligned'
                },
                {
                    id: 'obj_crags',
                    category: 'rock',
                    regionId: 'reg_north_peak',
                    density: 12,
                    scale: 2.5,
                    placementRule: 'slope_aligned'
                }
            ],
            atmosphere: {
                skybox: 'daylight',
                lighting: 'daylight',
                timeOfDay: 11.0,
                lightColor: '#f8fafc',
                lightTemperature: 6800,
                sunIntensity: 1.8
            }
        };
    }

    // 4. Desert Canyons / Dunes / Badlands / Oasis
    if (/desert|canyon|dune|sahara|oasis|badlands|mesa|arid|sand/i.test(p)) {
        return {
            name: 'Sun-Baked Canyon & Desert Outpost',
            theme: 'Carved sandstone mesas and wind-swept sand dunes',
            mood: 'Blazing afternoon heat haze with rich ochre shadows',
            timeOfDay: 16.5,
            regions: [
                {
                    id: 'reg_canyon_floor',
                    name: 'Wadi Canyon Basin',
                    category: 'canyon',
                    description: 'Flat dry riverbed flanked by sheer rock shelves',
                    relativePosition: 'center',
                    baseElevation: 2.0
                },
                {
                    id: 'reg_north_mesa',
                    name: 'North Sandstone Mesa',
                    category: 'mountain',
                    description: 'Broad flat-topped table mountain',
                    relativePosition: 'north',
                    baseElevation: 30.0
                },
                {
                    id: 'reg_east_dunes',
                    name: 'East Shifting Dunes',
                    category: 'desert',
                    description: 'Rolling sand dunes with sharp wind-rippled crests',
                    relativePosition: 'east',
                    baseElevation: 10.0
                }
            ],
            terrain: {
                elevationMin: -2.0,
                elevationMax: 45.0,
                erosionWeight: 0.35,
                terracation: 0.7,
                noiseScale: 1.4,
                baseMaterial: {
                    color: '#c27a3e',
                    roughness: 0.88,
                    metalness: 0.05
                }
            },
            objects: [
                {
                    id: 'obj_desert_outpost',
                    category: 'house',
                    regionId: 'reg_canyon_floor',
                    density: 4,
                    scale: 1.6,
                    placementRule: 'centered'
                },
                {
                    id: 'obj_watchtower',
                    category: 'tower',
                    regionId: 'reg_north_mesa',
                    density: 2,
                    scale: 2.2,
                    placementRule: 'slope_aligned'
                },
                {
                    id: 'obj_boulders',
                    category: 'rock',
                    regionId: 'reg_east_dunes',
                    density: 10,
                    scale: 1.4,
                    placementRule: 'scattered'
                }
            ],
            atmosphere: {
                skybox: 'sunset',
                lighting: 'daylight',
                timeOfDay: 16.5,
                lightColor: '#f97316',
                lightTemperature: 4500,
                sunIntensity: 1.6
            }
        };
    }

    // 5. Default General Procedural World
    return {
        name: `Procedural 3D World: ${prompt.slice(0, 40)}`,
        theme: prompt || 'Diverse natural terrain with architectural focal points',
        mood: 'Natural open-air daylight',
        timeOfDay: 12.0,
        regions: [
            {
                id: 'reg_center',
                name: 'Central Plain',
                category: 'plain',
                description: 'Open expanses for focal structures and activity',
                relativePosition: 'center',
                baseElevation: 2.0
            },
            {
                id: 'reg_north_hills',
                name: 'North Highlands',
                category: 'mountain',
                description: 'Elevated hills and vantage points',
                relativePosition: 'north',
                baseElevation: 18.0
            },
            {
                id: 'reg_south_woods',
                name: 'South Woodland',
                category: 'forest',
                description: 'Lush greenery and natural vegetation',
                relativePosition: 'south',
                baseElevation: 4.0
            }
        ],
        terrain: {
            elevationMin: -2.0,
            elevationMax: 30.0,
            erosionWeight: 0.15,
            terracation: 0.3,
            noiseScale: 1.0,
            baseMaterial: {
                color: '#475569',
                roughness: 0.7,
                metalness: 0.1
            }
        },
        objects: [
            {
                id: 'obj_core_structure',
                category: 'house',
                regionId: 'reg_center',
                density: 3,
                scale: 1.8,
                placementRule: 'centered'
            },
            {
                id: 'obj_trees',
                category: 'tree',
                regionId: 'reg_south_woods',
                density: 12,
                scale: 1.2,
                placementRule: 'scattered'
            },
            {
                id: 'obj_boulders',
                category: 'rock',
                regionId: 'reg_north_hills',
                density: 6,
                scale: 1.5,
                placementRule: 'slope_aligned'
            }
        ],
        atmosphere: {
            skybox: 'daylight',
            lighting: 'daylight',
            timeOfDay: 12.0,
            lightColor: '#ffffff',
            lightTemperature: 6500,
            sunIntensity: 1.5
        }
    };
}

/**
 * Plans a structured open-world 3D scene specification from a natural language prompt.
 * Uses Gemini AI when configured, otherwise gracefully falls back to deterministic heuristic planner.
 */
export async function planWorldIntent(
    prompt: string,
    apiKeyOverride?: string
): Promise<WorldSpecification> {
    const apiKey = apiKeyOverride || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;

    if (!apiKey) {
        return planWorldIntentHeuristic(prompt);
    }

    try {
        const ai = new GoogleGenAI({ apiKey });
        const model = 'gemini-3.7-flash';

        const systemInstruction = `You are an expert 3D World Designer and Scene Architect for Scratchbox IDE.
Your task is to take a natural language world generation prompt (e.g. "medieval harbor under a storm", "desert canyons with robotic outposts", "frozen science research base", "cyberpunk skyline") and compile it into a structured, geomorphically consistent open-world 3D scene specification.

Rules for planning:
1. Divide the world into 3-6 logical regions with continuous topology transitions.
2. For each region, specify its relativePosition (north/south/east/west/center/northeast/northwest/southeast/southwest), base elevation in meters, and description.
3. Configure the global terrain parameters, ensuring base materials align with the theme (e.g., green for grasslands, white/grey for ice, orange/brown for canyon, slate for cities).
4. Specify object requirements mapping each object to its corresponding regionId. Make sure categories match typical assets like "tree", "rock", "house", "tower", "bridge", "beacon" or similar. Ensure reasonable densities and placement rules.`;

        const response = await ai.models.generateContent({
            model,
            contents: `Design a structured open-world 3D scene specification for the prompt: "${prompt}"`,
            config: {
                systemInstruction,
                responseMimeType: 'application/json',
                responseSchema: worldSpecificationSchema,
                temperature: 0.2
            }
        });

        const text = response.text || '{}';
        const parsed = JSON.parse(text) as WorldSpecification;

        if (parsed && parsed.regions && parsed.terrain && parsed.objects) {
            return parsed;
        }
        return planWorldIntentHeuristic(prompt);
    } catch (err) {
        console.warn('[WorldIntentPlanner] Gemini call failed, falling back to heuristic planner:', err);
        return planWorldIntentHeuristic(prompt);
    }
}

/**
 * Partitions a natural language world prompt into parallel modeling tasks.
 */
export async function planSwarmTasks(
    prompt: string,
    apiKeyOverride?: string
): Promise<SwarmTaskBucket> {
    const fallbackBucket: SwarmTaskBucket = {
        terrainConcept: `Procedural terrain landscape for "${prompt}"`,
        materialsToSynthesize: [
            { name: 'ground_primary', prompt: `Ground terrain material for ${prompt}` },
            { name: 'rock_cliff', prompt: `Cliff wall and rock strata material for ${prompt}` }
        ],
        customAssetsToBuild: [
            { id: 'custom_focal_01', category: 'tower', prompt: `Architectural landmark focal point for ${prompt}` },
            { id: 'custom_dwelling_01', category: 'house', prompt: `Regional structure or dwelling for ${prompt}` }
        ]
    };

    const apiKey = apiKeyOverride || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
    if (!apiKey) {
        return fallbackBucket;
    }

    try {
        const ai = new GoogleGenAI({ apiKey });
        const model = 'gemini-3.7-flash';

        const systemInstruction = `You are an expert World Architect Coordinator.
Your task is to take a natural language world generation prompt and partition it into parallel tasks for specialized sub-agents:
1. Identify 1-2 custom ground materials to synthesize.
2. Identify 1-3 custom architectural/structural assets that need procedural geometry model generation (e.g., watchtower, bridge, satellite dish, temple, habitat).`;

        const response = await ai.models.generateContent({
            model,
            contents: `Partition the following world prompt into specialized parallel tasks: "${prompt}"`,
            config: {
                systemInstruction,
                responseMimeType: 'application/json',
                temperature: 0.2
            }
        });

        const text = response.text || '{}';
        const parsed = JSON.parse(text) as SwarmTaskBucket;
        if (parsed && parsed.materialsToSynthesize && parsed.customAssetsToBuild) {
            return parsed;
        }
        return fallbackBucket;
    } catch {
        return fallbackBucket;
    }
}
