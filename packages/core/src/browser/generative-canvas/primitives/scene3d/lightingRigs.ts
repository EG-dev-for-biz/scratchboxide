/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as THREE from 'three';

export interface PhysicalLightConfig {
    name: string;
    type: 'directional' | 'point' | 'spot';
    position: [number, number, number];
    direction?: [number, number, number];
    color?: number | [number, number, number];
    kelvin?: number;
    intensity: number;
    range?: number;
    innerConeAngle?: number;
    outerConeAngle?: number;
    castShadow?: boolean;
    shadowBias?: number;
}

export interface CinematicRigDefinition {
    name: string;
    label: string;
    description: string;
    ambientColor: number;
    ambientIntensity: number;
    lights: PhysicalLightConfig[];
}

/**
 * Converts blackbody temperature in Kelvin (1000K to 15000K) to linear THREE.Color.
 * Analytic Planckian locus polynomial approximation.
 */
export function kelvinToRgb(kelvin: number): THREE.Color {
    const k = Math.min(Math.max(kelvin, 1000), 15000) / 100;
    let r = 0;
    let g = 0;
    let b = 0;

    // Red
    if (k <= 66) {
        r = 1.0;
    } else {
        r = (329.698727446 * Math.pow(k - 60, -0.1332047592)) / 255.0;
    }

    // Green
    if (k <= 66) {
        g = (99.4708025861 * Math.log(k) - 161.1195681661) / 255.0;
    } else {
        g = (288.1221695283 * Math.pow(k - 60, -0.0755148492)) / 255.0;
    }

    // Blue
    if (k >= 66) {
        b = 1.0;
    } else if (k <= 19) {
        b = 0.0;
    } else {
        b = (138.5177312231 * Math.log(k - 10) - 305.0447927307) / 255.0;
    }

    r = Math.min(Math.max(r, 0), 1);
    g = Math.min(Math.max(g, 0), 1);
    b = Math.min(Math.max(b, 0), 1);

    // sRGB to Linear conversion
    const toLinear = (c: number) => c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);

    return new THREE.Color(toLinear(r), toLinear(g), toLinear(b));
}

/**
 * Calibrated Cinematic & Studio Lighting Rigs
 */
export const CINEMATIC_RIGS: Record<string, CinematicRigDefinition> = {
    // The default for `lighting: 'studio'`: a neutral CAD/DCC viewport light. White directional key, fill and
    // top light plus neutral ambient, so surfaces show their true color at any model size. Levels are set so a mid-grey
    // (sRGB 128) Lambertian surface averages about sRGB 128 over its lit and shaded faces after ACES tone mapping
    // (measured on the staged Washington Square Arch and the staged fixture; staged-texture-viewport-lighting.test.ts).
    studio: {
        name: 'studio',
        label: 'Neutral Studio',
        description: 'Neutral white key, fill and top light with white ambient; true-color, size-independent.',
        ambientColor: 0xffffff,
        ambientIntensity: 1.0,
        lights: [
            { name: 'Studio_Key', type: 'directional', position: [4, 6, 5], color: 0xffffff, intensity: 2.25 },
            { name: 'Studio_Fill', type: 'directional', position: [-5, 2.5, 3], color: 0xffffff, intensity: 0.7 },
            { name: 'Studio_Top', type: 'directional', position: [0, 6, -4], color: 0xffffff, intensity: 0.5 }
        ]
    },
    three_point_studio: {
        name: 'three_point_studio',
        label: '3-Point Studio Rig',
        description: 'Key (5600K Daylight), Cool Sky Fill, Rim Kicker, and Warm Floor Bounce.',
        ambientColor: 0x141824,
        ambientIntensity: 0.15,
        lights: [
            {
                name: 'Key_Light',
                type: 'point',
                position: [3.5, 3.25, 3.5],
                kelvin: 5600,
                intensity: 18.0,
                range: 25.0,
                castShadow: true
            },
            {
                name: 'Fill_Light',
                type: 'point',
                position: [-4.25, 1.75, 2.5],
                kelvin: 7500,
                intensity: 6.5,
                range: 25.0,
                castShadow: false
            },
            {
                name: 'Rim_Kicker',
                type: 'point',
                position: [-1.5, 4.0, -4.5],
                color: 0xf5f8ff,
                intensity: 24.0,
                range: 20.0,
                castShadow: true
            },
            {
                name: 'Floor_Bounce',
                type: 'point',
                position: [0, -2.0, 0],
                kelvin: 2800,
                intensity: 3.5,
                range: 15.0,
                castShadow: false
            }
        ]
    },
    rembrandt_chiaroscuro: {
        name: 'rembrandt_chiaroscuro',
        label: 'Rembrandt Chiaroscuro',
        description: 'Steep 45° Key Spot casting signature triangular cheek catchlight and rich painterly shadows.',
        ambientColor: 0x05060a,
        ambientIntensity: 0.05,
        lights: [
            {
                name: 'Rembrandt_Key_Spot',
                type: 'spot',
                position: [4.25, 4.5, 4.25],
                direction: [-4.25, -4.5, -4.25],
                kelvin: 4200,
                intensity: 35.0,
                range: 30.0,
                innerConeAngle: 0.28,
                outerConeAngle: 0.58,
                castShadow: true
            },
            {
                name: 'Rembrandt_Shadow_Fill',
                type: 'point',
                position: [-4.5, 1.0, 2.0],
                kelvin: 7500,
                intensity: 2.8,
                range: 25.0,
                castShadow: false
            },
            {
                name: 'Rembrandt_Hair_Edge',
                type: 'point',
                position: [-2.0, 5.5, -4.0],
                color: 0xe5d8be,
                intensity: 15.0,
                range: 20.0,
                castShadow: true
            }
        ]
    },
    paramount_glamour: {
        name: 'paramount_glamour',
        label: 'Paramount Glamour',
        description: 'High frontal butterfly key with soft clamshell reflector bounce and symmetrical hair kickers.',
        ambientColor: 0x1a1a24,
        ambientIntensity: 0.2,
        lights: [
            {
                name: 'Butterfly_High_Key',
                type: 'spot',
                position: [0, 5.75, 5.0],
                direction: [0, -5.75, -5.0],
                kelvin: 5400,
                intensity: 26.0,
                range: 25.0,
                innerConeAngle: 0.35,
                outerConeAngle: 0.65,
                castShadow: true
            },
            {
                name: 'Clamshell_Reflector',
                type: 'point',
                position: [0, -1.75, 4.25],
                color: 0xfffaf2,
                intensity: 8.5,
                range: 20.0,
                castShadow: false
            },
            {
                name: 'Left_Hair_Rim',
                type: 'point',
                position: [-3.5, 4.5, -3.5],
                kelvin: 6500,
                intensity: 10.5,
                range: 20.0,
                castShadow: true
            },
            {
                name: 'Right_Hair_Rim',
                type: 'point',
                position: [3.5, 4.5, -3.5],
                kelvin: 6500,
                intensity: 10.5,
                range: 20.0,
                castShadow: true
            }
        ]
    },
    film_noir_split: {
        name: 'film_noir_split',
        label: 'Film Noir Split',
        description: 'Hard lateral 90° key dividing subject down the middle with razor shadows and cold back kicker.',
        ambientColor: 0x020205,
        ambientIntensity: 0.02,
        lights: [
            {
                name: 'Noir_Split_Key',
                type: 'spot',
                position: [6.25, 1.25, 0],
                direction: [-6.25, -1.25, 0],
                color: 0xfff8eb,
                intensity: 45.0,
                range: 30.0,
                innerConeAngle: 0.22,
                outerConeAngle: 0.48,
                castShadow: true
            },
            {
                name: 'Noir_Back_Kicker',
                type: 'point',
                position: [-4.0, 3.5, -4.5],
                kelvin: 9000,
                intensity: 7.5,
                range: 20.0,
                castShadow: true
            }
        ]
    },
    golden_hour_sunset: {
        name: 'golden_hour_sunset',
        label: 'Golden Hour Sunset',
        description: 'Low 2400K solar directional key with long shadows, azure sky fill, and warm terrain bounce.',
        ambientColor: 0x14172e,
        ambientIntensity: 0.25,
        lights: [
            {
                name: 'Golden_Hour_Sun',
                type: 'directional',
                position: [-15.0, 4.5, -8.0],
                direction: [15.0, -4.5, 8.0],
                kelvin: 2400,
                intensity: 8.5,
                castShadow: true
            },
            {
                name: 'Azure_Sky_Dome_Fill',
                type: 'directional',
                position: [0, 20.0, 0],
                direction: [0, -1.0, 0],
                kelvin: 8500,
                intensity: 1.6,
                castShadow: false
            },
            {
                name: 'Terrain_Warm_Bounce',
                type: 'point',
                position: [0, -2.5, 0],
                color: 0xa6612e,
                intensity: 4.0,
                range: 30.0,
                castShadow: false
            }
        ]
    },
    cyberpunk_dual_rim: {
        name: 'cyberpunk_dual_rim',
        label: 'Cyberpunk Dual-Rim',
        description: 'Opposing electric cyan (#00f3ff) and astral magenta (#ff00aa) kickers with subtle fill.',
        ambientColor: 0x050814,
        ambientIntensity: 0.1,
        lights: [
            {
                name: 'Electric_Cyan_Kicker',
                type: 'spot',
                position: [-4.75, 3.75, -4.0],
                direction: [4.75, -3.75, 4.0],
                color: 0x00f3ff,
                intensity: 32.0,
                range: 25.0,
                innerConeAngle: 0.32,
                outerConeAngle: 0.65,
                castShadow: true
            },
            {
                name: 'Astral_Magenta_Kicker',
                type: 'spot',
                position: [4.75, 3.75, -4.0],
                direction: [-4.75, -3.75, 4.0],
                color: 0xff00aa,
                intensity: 32.0,
                range: 25.0,
                innerConeAngle: 0.32,
                outerConeAngle: 0.65,
                castShadow: true
            },
            {
                name: 'Cyberpunk_Key_Fill',
                type: 'point',
                position: [0, 2.0, 4.5],
                color: 0xbfe0ff,
                intensity: 8.0,
                range: 20.0,
                castShadow: false
            }
        ]
    },
    torchlight_campfire: {
        name: 'torchlight_campfire',
        label: 'Torchlight Campfire',
        description: 'Warm flickering 1850K flame key with cold midnight moonlight fill.',
        ambientColor: 0x03050d,
        ambientIntensity: 0.05,
        lights: [
            {
                name: 'Torch_Flame_Key',
                type: 'point',
                position: [0.15, -0.5, 2.25],
                kelvin: 1850,
                intensity: 22.0,
                range: 18.0,
                castShadow: true
            },
            {
                name: 'Cold_Moonlight_Fill',
                type: 'directional',
                position: [5.0, 15.0, 3.0],
                direction: [-5.0, -15.0, -3.0],
                kelvin: 4100,
                intensity: 0.75,
                castShadow: true
            }
        ]
    },
    high_key_product: {
        name: 'high_key_product',
        label: 'High-Key Product Commercial',
        description: 'Even, shadowless 3-point wrap lighting optimized for product and model inspection.',
        ambientColor: 0x404040,
        ambientIntensity: 0.4,
        lights: [
            {
                name: 'High_Key_Wrap_1',
                type: 'point',
                position: [0, 3.25, 5.5],
                kelvin: 5800,
                intensity: 14.0,
                range: 25.0,
                castShadow: true
            },
            {
                name: 'High_Key_Wrap_2',
                type: 'point',
                position: [-4.76, 3.25, -2.75],
                kelvin: 5800,
                intensity: 14.0,
                range: 25.0,
                castShadow: false
            },
            {
                name: 'High_Key_Wrap_3',
                type: 'point',
                position: [4.76, 3.25, -2.75],
                kelvin: 5800,
                intensity: 14.0,
                range: 25.0,
                castShadow: false
            }
        ]
    }
};

/**
 * Creates Three.js lights for a given cinematic rig definition.
 */
export function buildThreeJsLightingRig(
    rigKey: string = 'three_point_studio',
    options?: { kelvin?: number; scale?: number; isLargeScale?: boolean }
): THREE.Light[] {
    const key = rigKey.toLowerCase().replace(/[-\s]/g, '_');
    const rig = CINEMATIC_RIGS[key] || CINEMATIC_RIGS.three_point_studio;
    const lights: THREE.Light[] = [];

    // Ambient light baseline (boosted for large geospatial scenes). Its colour is the rig's own: a sky-blue fill here tinted
    // every neutral studio scene with a geo anchor (the staged locations drew navy clay and blue photo textures), and a sky is
    // opt-in (AGENTS.md, zero uninvited atmosphere).
    const ambientColor = rig.ambientColor;
    const ambientIntensity = options?.isLargeScale
        ? Math.max(rig.ambientIntensity, 0.6)
        : rig.ambientIntensity;
    const ambient = new THREE.AmbientLight(ambientColor, ambientIntensity);
    ambient.name = `${rig.name}_ambient`;
    lights.push(ambient);

    const scale = options?.scale ?? 1.0;
    // When scaled up, point and spot light intensity scales with distance squared to preserve lux
    const intensityMultiplier = scale > 1.0 ? Math.min(10000, scale * scale) : 1.0;

    for (const cfg of rig.lights) {
        let color: THREE.Color;
        if (options?.kelvin && cfg.kelvin) {
            color = kelvinToRgb(options.kelvin);
        } else if (cfg.kelvin) {
            color = kelvinToRgb(cfg.kelvin);
        } else if (typeof cfg.color === 'number') {
            color = new THREE.Color(cfg.color);
        } else if (Array.isArray(cfg.color)) {
            color = new THREE.Color(cfg.color[0], cfg.color[1], cfg.color[2]);
        } else {
            color = new THREE.Color(0xffffff);
        }

        if (cfg.type === 'directional') {
            const dir = new THREE.DirectionalLight(color, cfg.intensity);
            dir.name = cfg.name;
            dir.position.set(cfg.position[0] * scale, cfg.position[1] * scale, cfg.position[2] * scale);
            if (cfg.direction) {
                const target = new THREE.Object3D();
                target.position.set(
                    dir.position.x + cfg.direction[0],
                    dir.position.y + cfg.direction[1],
                    dir.position.z + cfg.direction[2]
                );
                dir.target = target;
                lights.push(target as any);
            }
            if (cfg.castShadow) {
                dir.castShadow = true;
                dir.shadow.mapSize.width = 1024;
                dir.shadow.mapSize.height = 1024;
                dir.shadow.bias = cfg.shadowBias ?? -0.0005;
            }
            lights.push(dir);
        } else if (cfg.type === 'spot') {
            const spot = new THREE.SpotLight(
                color,
                cfg.intensity * intensityMultiplier,
                (cfg.range ?? 20) * scale,
                cfg.outerConeAngle ?? 0.6,
                cfg.innerConeAngle ? 1.0 - (cfg.innerConeAngle / (cfg.outerConeAngle ?? 0.6)) : 0.4
            );
            spot.name = cfg.name;
            spot.position.set(cfg.position[0] * scale, cfg.position[1] * scale, cfg.position[2] * scale);
            if (cfg.direction) {
                const target = new THREE.Object3D();
                target.position.set(
                    spot.position.x + cfg.direction[0],
                    spot.position.y + cfg.direction[1],
                    spot.position.z + cfg.direction[2]
                );
                spot.target = target;
                lights.push(target as any);
            }
            if (cfg.castShadow) {
                spot.castShadow = true;
                spot.shadow.mapSize.width = 1024;
                spot.shadow.mapSize.height = 1024;
                spot.shadow.bias = cfg.shadowBias ?? -0.0005;
            }
            lights.push(spot);
        } else {
            const point = new THREE.PointLight(
                color,
                cfg.intensity * intensityMultiplier,
                (cfg.range ?? 20) * scale,
                2.0 // inverse square decay
            );
            point.name = cfg.name;
            point.position.set(cfg.position[0] * scale, cfg.position[1] * scale, cfg.position[2] * scale);
            if (cfg.castShadow) {
                point.castShadow = true;
                point.shadow.mapSize.width = 1024;
                point.shadow.mapSize.height = 1024;
                point.shadow.bias = cfg.shadowBias ?? -0.0005;
            }
            lights.push(point);
        }
    }

    return lights;
}

/**
 * Real-Time Scene Performance Budget Telemetry
 */
export interface SceneBudgetTelemetry {
    totalVertices: number;
    totalTriangles: number;
    meshCount: number;
    lightCount: number;
    shadowCasters: number;
    estimatedFrameTimeMs: number;
    estimatedFps: number;
    withinWebBudget: boolean;
    recommendations: string[];
}

export function computeSceneBudgetTelemetry(scene: THREE.Scene): SceneBudgetTelemetry {
    let totalVertices = 0;
    let totalTriangles = 0;
    let meshCount = 0;
    let lightCount = 0;
    let shadowCasters = 0;

    scene.traverse((obj) => {
        if ((obj as THREE.Mesh).isMesh) {
            meshCount++;
            const mesh = obj as THREE.Mesh;
            const geo = mesh.geometry;
            if (geo) {
                const pos = geo.attributes.position;
                if (pos) {
                    totalVertices += pos.count;
                }
                if (geo.index) {
                    totalTriangles += geo.index.count / 3;
                } else if (pos) {
                    totalTriangles += pos.count / 3;
                }
            }
        } else if ((obj as THREE.Light).isLight) {
            lightCount++;
            const light = obj as THREE.Light;
            if (light.castShadow) {
                shadowCasters++;
            }
        }
    });

    // Frame time model:
    // 0.00015ms per triangle + 0.85ms per shadow map pass + 0.12ms per draw call + 1.5ms overhead
    const triMs = totalTriangles * 0.00015;
    const shadowMs = shadowCasters * 0.85;
    const drawCalls = meshCount + shadowCasters * 2;
    const drawCallMs = drawCalls * 0.12;
    const estimatedFrameTimeMs = Math.round((1.5 + triMs + shadowMs + drawCallMs) * 10) / 10;
    const estimatedFps = Math.min(60, Math.max(15, Math.round(1000 / Math.max(estimatedFrameTimeMs, 1))));
    const withinWebBudget = estimatedFrameTimeMs <= 16.7 && totalTriangles <= 100000;

    const recommendations: string[] = [];
    if (totalTriangles > 50000) {
        recommendations.push('Apply Garland-Heckbert QEM LOD decimation for background geometry.');
    }
    if (shadowCasters > 2) {
        recommendations.push('Disable shadow casting on secondary fill lights to reduce shadow passes.');
    }
    if (meshCount > 15) {
        recommendations.push('Batch static props using EXT_mesh_gpu_instancing / THREE.InstancedMesh.');
    }

    return {
        totalVertices,
        totalTriangles: Math.round(totalTriangles),
        meshCount,
        lightCount,
        shadowCasters,
        estimatedFrameTimeMs,
        estimatedFps,
        withinWebBudget,
        recommendations
    };
}
