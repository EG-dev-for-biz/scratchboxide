/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as THREE from 'three';
import { kelvinToRGB } from './kelvin';
import { calculateNOAASolarPosition } from './solar-position';
import { anglesToDirection } from './sky-photometry';
import { classifyDiurnalPhase } from './diurnal-lighting';
import { MissingInputError } from '../../../../common/errors/pipeline-errors';
import { assertUsableCoordinates } from '../../../../common/coordinate/parse-coordinates';
import { PHOTOGRAMMETRIC_DELIGHT as PD } from '../../../../common/spatial/photogrammetric-delight';

const glslFloat = (x: number): string => (Number.isInteger(x) ? x.toFixed(1) : String(x));

export type StoneType = 'travertine' | 'limestone' | 'sandstone' | 'granite' | 'terracotta' | 'marble' | 'concrete' | 'neutral' | 'asphalt' | 'brick' | 'glass_metal';

export interface DelightUniformsConfig {
    uDelightEnabled: boolean;
    uRealDelightEnabled?: boolean;
    uMeshShading?: number;
    uShadowLift: number;
    uHighlightCompress: number;
    uStoneAlbedoTint: [number, number, number];
    uTwilightSkyTint: [number, number, number];
    uGroundBounceTint: [number, number, number];
    uGroundDeWash: number;
}

export interface AtmosphereSceneLightingConfig {
    ambientLight: { color: string; intensity: number };
    hemiLight: { skyColor: string; groundColor: string; intensity: number };
    sunLight: { color: string; intensity: number; position: [number, number, number] };
    fillLight: { color: string; intensity: number; position: [number, number, number] };
    skyGradient: {
        zenithColor: string;
        midColor: string;
        horizonColor: string;
        nadirColor?: string;
    };
}

export interface ArchitecturalPortalFixtureConfig {
    id: string;
    name: string;
    position: [number, number, number];
    targetPosition: [number, number, number];
    color: string;
    kelvinTemperature: number;
    intensity: number;
    distance: number;
    decay: number;
    type: 'spot' | 'point' | 'rect';
    angle?: number;
    penumbra?: number;
}

export interface LocationShaderGLSLChunk {
    fragmentShaderChunk: string;
    vertexShaderChunk: string;
    uniformsDefinition: Record<string, { value: any }>;
}

/**
 * A window or portal opening the caller has located on the model (scene metres, Y up, -Z north): the light sits at
 * `position` behind the opening and aims at `targetPosition` outside it. Unset fixture properties take the
 * incandescent-practical values listed in PORTAL_FIXTURE_DEFAULTS, and the result says which were applied.
 */
export interface ArchitecturalPortalInput {
    id?: string;
    name?: string;
    position: [number, number, number];
    targetPosition: [number, number, number];
    kelvinTemperature?: number;
    intensity?: number;
    distance?: number;
    decay?: number;
    angle?: number;
    penumbra?: number;
}

/** Fixture values used for any property a portal does not set (a 2850 K incandescent spot). */
export const PORTAL_FIXTURE_DEFAULTS = { kelvinTemperature: 2850, intensity: 8.5, distance: 28.0, decay: 1.8, angle: 0.58, penumbra: 0.75 } as const;

export interface LocationObjectAtmosphereRequest {
    landmarkName?: string;
    latitude?: number;
    longitude?: number;
    /** ISO 8601 instant the sun is computed for. Required: no date is assumed. */
    isoDate?: string;
    preset?: 'civil_twilight_dusk' | 'golden_hour' | 'blue_hour' | 'midday_clear' | 'night_monumental';
    stoneType?: StoneType;
    /** Window/portal openings on the model. Backlighting fixtures are created only for these; none are invented. */
    portals?: ArchitecturalPortalInput[];
    customDelightParams?: Partial<DelightUniformsConfig>;
}

export interface LocationObjectAtmosphereResult {
    success: boolean;
    preset: string;
    diurnalPhase: string;
    solarEphemeris: {
        elevationDeg: number;
        azimuthDeg: number;
        distanceAu?: number;
        sunVector: [number, number, number];
    };
    solarElevationDeg: number;
    solarAzimuthDeg: number;
    delightUniforms: DelightUniformsConfig;
    sceneLighting: AtmosphereSceneLightingConfig;
    architecturalFixtures: ArchitecturalPortalFixtureConfig[];
    shaderGLSL: {
        vertexShaderChunk: string;
        fragmentShaderChunk: string;
        uniformsDefinition?: Record<string, { value: any }>;
    };
    landmarkContext?: {
        name: string;
        coordinates?: { lat: number; lng: number };
        /** The instant the sun was computed for. */
        isoDate?: string;
    };
    /** Portal fixture properties filled from PORTAL_FIXTURE_DEFAULTS because the caller did not set them. */
    portalDefaultsApplied?: string[];
}

/**
 * Standard calibrated stone & architectural surface albedo reflectance profiles.
 */
export const STONE_ALBEDO_PROFILES: Record<StoneType, [number, number, number]> = {
    neutral: [0.80, 0.80, 0.80],     // Photometrically neutral architectural reflectance
    concrete: [0.75, 0.75, 0.75],    // Modern architectural Portland concrete
    asphalt: [0.35, 0.35, 0.35],     // Dark roadway / asphalt pavement
    brick: [0.78, 0.45, 0.35],       // Urban architectural brickwork
    glass_metal: [0.90, 0.92, 0.95], // Architectural reflective glass / steel
    travertine: [0.86, 0.82, 0.78],  // Calibrated Roman travertine limestone
    limestone: [0.88, 0.85, 0.80],   // Neutral French/German limestone
    sandstone: [0.89, 0.76, 0.62],   // Warm ochre/reddish sandstone
    granite: [0.72, 0.71, 0.70],     // Neutral grey/salt-and-pepper granite
    terracotta: [0.82, 0.48, 0.36],  // Mediterranean terracotta brick/tile
    marble: [0.92, 0.92, 0.94]       // Carrara white marble
};

/** Builds spot fixtures for the portals the caller located; nothing is placed where no portal was given. */
export function buildPortalFixtures(portals: ArchitecturalPortalInput[]): { fixtures: ArchitecturalPortalFixtureConfig[]; defaultsApplied: string[] } {
    const defaultsApplied = new Set<string>();
    const fixtures = portals.map((p, i): ArchitecturalPortalFixtureConfig => {
        const valid = (v: unknown): v is [number, number, number] => Array.isArray(v) && v.length === 3 && v.every(n => typeof n === 'number' && Number.isFinite(n));
        if (!valid(p.position) || !valid(p.targetPosition)) {
            throw new MissingInputError('geobox_harmonize_location_lighting', `portals[${i}].position and targetPosition`, 'each portal needs [x, y, z] for the light and the opening it shines through');
        }
        const pick = <K extends keyof typeof PORTAL_FIXTURE_DEFAULTS>(key: K): number => {
            const v = p[key];
            if (typeof v === 'number' && Number.isFinite(v)) return v;
            defaultsApplied.add(key);
            return PORTAL_FIXTURE_DEFAULTS[key];
        };
        const kelvin = pick('kelvinTemperature');
        return {
            id: p.id || `portal_${i + 1}`,
            name: p.name || `Portal ${i + 1}`,
            position: [...p.position],
            targetPosition: [...p.targetPosition],
            color: '#' + kelvinToRGB(kelvin).getHexString(),
            kelvinTemperature: kelvin,
            intensity: pick('intensity'),
            distance: pick('distance'),
            decay: pick('decay'),
            type: 'spot',
            angle: pick('angle'),
            penumbra: pick('penumbra')
        };
    });
    return { fixtures, defaultsApplied: [...defaultsApplied] };
}

/**
 * GLSL fragment shader code snippet for photogrammetric de-lighting and atmospheric irradiance injection.
 */
export const LOCATION_DELIGHT_FRAGMENT_CHUNK = `
#ifdef DELIGHT_ENABLED
    vec3 baseRgb = gl_FragColor.rgb;

    #ifdef REAL_DELIGHT_ENABLED
        // Real physical de-lighting: true color = texture / max(shading, epsilon)
        // Cycles Diffuse Color pass split: removes baked illumination
        float meshShading = clamp(uMeshShading, 0.10, 1.0);
        baseRgb = baseRgb / meshShading;
    #else
        // Luminance of photogrammetric diffuse sample
        float dLuma = dot(baseRgb, vec3(${PD.luma.map(glslFloat).join(', ')}));

        // 1. Lift baked shadow crevices toward stone albedo baseline
        float shadowFactor = clamp(1.0 - (dLuma * ${glslFloat(PD.shadowSlope)}), 0.0, 1.0);
        vec3 liftedRgb = baseRgb + (vec3(dLuma * ${glslFloat(PD.liftGain)} + ${glslFloat(PD.liftOffset)}) - baseRgb) * (shadowFactor * uShadowLift);

        // 2. Compress burnt midday solar highlights
        float highlightFactor = smoothstep(${glslFloat(PD.highlightLo)}, ${glslFloat(PD.highlightHi)}, dLuma);
        baseRgb = mix(liftedRgb, liftedRgb * ${glslFloat(PD.highlightScale)}, highlightFactor * uHighlightCompress);
    #endif

    // 3. Apply calibrated stone albedo reflectance tint
    vec3 stoneDelit = baseRgb * uStoneAlbedoTint;

    // 4. Normal-dependent sky dome irradiance catch-light on upward-facing ledges
    vec3 worldNorm = normalize(vDelightNormal);
    float upDot = clamp(worldNorm.y, 0.0, 1.0);
    stoneDelit = mix(stoneDelit, stoneDelit * uTwilightSkyTint * 2.2, upDot * 0.32);

    // 5. Normal-dependent plaza cobblestone bounce on downward-facing overhangs
    float downDot = clamp(-worldNorm.y, 0.0, 1.0);
    stoneDelit = mix(stoneDelit, stoneDelit * uGroundBounceTint * 1.6, downDot * 0.22);

    // 6. Ground plaza de-wash (retains authentic cobblestone/terrain depth)
    if (worldNorm.y > 0.70) {
        stoneDelit = mix(stoneDelit, stoneDelit * vec3(0.68, 0.65, 0.62), uGroundDeWash);
    }

    gl_FragColor = vec4(stoneDelit, gl_FragColor.a);
#endif
`;

export const LOCATION_DELIGHT_VERTEX_CHUNK = `
varying vec3 vDelightNormal;
`;

export const LOCATION_DELIGHT_VERTEX_BODY = `
vDelightNormal = normalize(normalMatrix * normal);
`;

/**
 * Service orchestrating complete de-lighting, atmosphere matching, and architectural illumination
 * for location 3D tiles and models.
 */
export class LocationObjectLightingService {
    /**
     * Calculates the complete harmonized atmosphere and lighting parameters for a 3D location mesh.
     */
    public static harmonizeLocationObjectAtmosphere(request: LocationObjectAtmosphereRequest = {}): LocationObjectAtmosphereResult {
        const stoneType: StoneType = request.stoneType || 'travertine';
        const stoneAlbedo = STONE_ALBEDO_PROFILES[stoneType] || STONE_ALBEDO_PROFILES.travertine;

        // The sun is computed for the coordinates given. A place name is never matched against a table or scanned
        // for numbers here, and there is no default latitude: resolve the place first (the tool handlers do this
        // with Google Places) or pass latitude/longitude.
        const lat = request.latitude;
        const lng = request.longitude;
        if (typeof lat !== 'number' || typeof lng !== 'number') {
            throw new MissingInputError('geobox_harmonize_location_lighting', 'latitude and longitude', `the sun position needs the place's coordinates${request.landmarkName ? ` (resolve "${request.landmarkName}" first)` : ''}; no default location is used`);
        }
        assertUsableCoordinates(lat, lng, `${lat}, ${lng}`);
        if (!request.isoDate) {
            throw new MissingInputError('geobox_harmonize_location_lighting', 'isoDate', 'the sun position depends on the date and time, and none is assumed');
        }
        const isoDate = request.isoDate;
        const dateObj = new Date(isoDate);
        if (isNaN(dateObj.getTime())) throw new MissingInputError('geobox_harmonize_location_lighting', 'a valid isoDate', `'${isoDate}' is not an ISO 8601 date-time`);
        const ephemeris = calculateNOAASolarPosition(dateObj, lat, lng);
        const diurnalPhase = classifyDiurnalPhase(ephemeris.elevationDeg);
        const sunVec = anglesToDirection(ephemeris.elevationDeg, ephemeris.azimuthDeg);

        // Determine preset
        let preset = request.preset;
        if (!preset) {
            // From the computed sun only (words in the image's file name do not pick a preset).
            if (ephemeris.elevationDeg < 0 && ephemeris.elevationDeg > -6.0) {
                preset = 'civil_twilight_dusk';
            } else if (ephemeris.elevationDeg <= -6.0) {
                preset = 'blue_hour';
            } else if (ephemeris.elevationDeg < 12.0) {
                preset = 'golden_hour';
            } else {
                preset = 'midday_clear'; // a sun 12 deg or more above the horizon is daylight, not dusk
            }
        }

        // Calibrated baseline configs
        let delightUniforms: DelightUniformsConfig;
        let sceneLighting: AtmosphereSceneLightingConfig;

        switch (preset) {
            case 'golden_hour':
                delightUniforms = {
                    uDelightEnabled: true,
                    uShadowLift: 0.40,
                    uHighlightCompress: 0.30,
                    uStoneAlbedoTint: [stoneAlbedo[0] * 1.05, stoneAlbedo[1] * 1.02, stoneAlbedo[2] * 0.95],
                    uTwilightSkyTint: [0.55, 0.65, 0.85],
                    uGroundBounceTint: [0.52, 0.42, 0.30],
                    uGroundDeWash: 0.20
                };
                sceneLighting = {
                    ambientLight: { color: '#6e5a48', intensity: 0.60 },
                    hemiLight: { skyColor: '#7ea2d4', groundColor: '#5a4228', intensity: 0.65 },
                    sunLight: { color: '#ffb266', intensity: 1.20, position: [-180, 25, -90] },
                    fillLight: { color: '#4a6885', intensity: 0.30, position: [120, 40, 90] },
                    skyGradient: { zenithColor: '#3b6998', midColor: '#9abfd8', horizonColor: '#e6b87d' }
                };
                break;

            case 'midday_clear':
                delightUniforms = {
                    uDelightEnabled: true,
                    uShadowLift: 0.25,
                    uHighlightCompress: 0.60,
                    uStoneAlbedoTint: [...stoneAlbedo],
                    uTwilightSkyTint: [0.45, 0.65, 0.95],
                    uGroundBounceTint: [0.50, 0.48, 0.45],
                    uGroundDeWash: 0.15
                };
                sceneLighting = {
                    ambientLight: { color: '#809bb8', intensity: 0.50 },
                    hemiLight: { skyColor: '#6ea0db', groundColor: '#60584a', intensity: 0.80 },
                    sunLight: { color: '#fff8ee', intensity: 1.50, position: [-50, 200, -50] },
                    fillLight: { color: '#6a88a5', intensity: 0.40, position: [80, 100, 80] },
                    skyGradient: { zenithColor: '#245899', midColor: '#5a94d4', horizonColor: '#b2d4f5' }
                };
                break;

            case 'blue_hour':
                delightUniforms = {
                    uDelightEnabled: true,
                    uShadowLift: 0.70,
                    uHighlightCompress: 0.20,
                    uStoneAlbedoTint: [stoneAlbedo[0] * 0.95, stoneAlbedo[1] * 0.98, stoneAlbedo[2] * 1.08],
                    uTwilightSkyTint: [0.22, 0.45, 0.85],
                    uGroundBounceTint: [0.25, 0.28, 0.35],
                    uGroundDeWash: 0.50
                };
                sceneLighting = {
                    ambientLight: { color: '#224477', intensity: 0.65 },
                    hemiLight: { skyColor: '#2d5a99', groundColor: '#1c2233', intensity: 0.60 },
                    sunLight: { color: '#4d78b8', intensity: 0.20, position: [-150, 15, -120] },
                    fillLight: { color: '#1a3055', intensity: 0.30, position: [100, 25, 80] },
                    skyGradient: { zenithColor: '#122544', midColor: '#204575', horizonColor: '#3c6ea6' }
                };
                break;

            case 'night_monumental':
                delightUniforms = {
                    uDelightEnabled: true,
                    uShadowLift: 0.80,
                    uHighlightCompress: 0.10,
                    uStoneAlbedoTint: [stoneAlbedo[0] * 0.85, stoneAlbedo[1] * 0.88, stoneAlbedo[2] * 0.95],
                    uTwilightSkyTint: [0.10, 0.15, 0.30],
                    uGroundBounceTint: [0.15, 0.15, 0.18],
                    uGroundDeWash: 0.60
                };
                sceneLighting = {
                    ambientLight: { color: '#0d1526', intensity: 0.40 },
                    hemiLight: { skyColor: '#152240', groundColor: '#0a0e18', intensity: 0.35 },
                    sunLight: { color: '#1c2848', intensity: 0.10, position: [-100, 30, -100] },
                    fillLight: { color: '#10182c', intensity: 0.15, position: [80, 20, 60] },
                    skyGradient: { zenithColor: '#050810', midColor: '#0b1220', horizonColor: '#142035' }
                };
                break;

            case 'civil_twilight_dusk':
                // Our exact calibrated and verified ground truth settings
                delightUniforms = {
                    uDelightEnabled: true,
                    uShadowLift: 0.60,
                    uHighlightCompress: 0.45,
                    uStoneAlbedoTint: [...stoneAlbedo],
                    uTwilightSkyTint: [0.34, 0.71, 0.90],
                    uGroundBounceTint: [0.38, 0.35, 0.32],
                    uGroundDeWash: 0.42
                };
                sceneLighting = {
                    ambientLight: { color: '#3a7ea5', intensity: 0.75 },
                    hemiLight: { skyColor: '#56b5e6', groundColor: '#383025', intensity: 0.70 },
                    sunLight: { color: '#b8dcfa', intensity: 0.35, position: [-160, 40, -120] },
                    fillLight: { color: '#2d688c', intensity: 0.25, position: [100, 30, 80] },
                    skyGradient: { zenithColor: '#48a3d6', midColor: '#56b5e6', horizonColor: '#8ec7df' }
                };
                break;

            default:
                throw new MissingInputError('geobox_harmonize_location_lighting', 'a known preset', `'${preset}' is not one of civil_twilight_dusk, golden_hour, midday_clear, blue_hour, night_monumental`);
        }

        // The key light comes from the computed sun, at the preset rig's distance.
        const sunDistance = Math.hypot(...sceneLighting.sunLight.position);
        sceneLighting.sunLight.position = [sunVec[0] * sunDistance, sunVec[1] * sunDistance, sunVec[2] * sunDistance];

        // Apply custom overrides if supplied
        if (request.customDelightParams) {
            delightUniforms = {
                ...delightUniforms,
                ...request.customDelightParams
            };
        }

        // Portal backlighting only where the caller located openings on the model.
        const portals = request.portals ?? [];
        const { fixtures: architecturalFixtures, defaultsApplied } = buildPortalFixtures(portals);

        return {
            success: true,
            preset,
            diurnalPhase,
            solarEphemeris: {
                elevationDeg: ephemeris.elevationDeg,
                azimuthDeg: ephemeris.azimuthDeg,
                distanceAu: ephemeris.distanceAU,
                sunVector: sunVec
            },
            solarElevationDeg: Number(ephemeris.elevationDeg.toFixed(2)),
            solarAzimuthDeg: Number(ephemeris.azimuthDeg.toFixed(2)),
            delightUniforms,
            sceneLighting,
            architecturalFixtures,
            shaderGLSL: {
                vertexShaderChunk: `${LOCATION_DELIGHT_VERTEX_CHUNK}\n${LOCATION_DELIGHT_VERTEX_BODY}`,
                fragmentShaderChunk: LOCATION_DELIGHT_FRAGMENT_CHUNK
            },
            landmarkContext: {
                name: request.landmarkName || `${lat.toFixed(6)}, ${lng.toFixed(6)}`,
                coordinates: { lat, lng },
                isoDate
            },
            ...(defaultsApplied.length ? { portalDefaultsApplied: defaultsApplied } : {})
        };
    }

    /**
     * Injects photogrammetric de-lighting GLSL code and uniforms into a Three.js material.
     */
    public static applyPhotogrammetricDelightShader(
        material: THREE.Material,
        config?: Partial<DelightUniformsConfig>
    ): void {
        const u = {
            uDelightEnabled: { value: config?.uDelightEnabled !== false ? 1.0 : 0.0 },
            // Default to physical C++ de-lighting model (TextureDeLighter / Cycles Diffuse Split)
            uRealDelightEnabled: { value: config?.uRealDelightEnabled !== false ? 1.0 : 0.0 },
            uMeshShading: { value: config?.uMeshShading ?? 1.0 },
            // Legacy heuristic GLSL fallbacks (deprecated in favor of C++20 NativeTileLightingService)
            uShadowLift: { value: config?.uShadowLift ?? PD.defaults.shadowLift },
            uHighlightCompress: { value: config?.uHighlightCompress ?? PD.defaults.highlightCompress },
            uStoneAlbedoTint: {
                value: new THREE.Color(
                    config?.uStoneAlbedoTint ? config.uStoneAlbedoTint[0] : 0.86,
                    config?.uStoneAlbedoTint ? config.uStoneAlbedoTint[1] : 0.82,
                    config?.uStoneAlbedoTint ? config.uStoneAlbedoTint[2] : 0.78
                )
            },
            uTwilightSkyTint: {
                value: new THREE.Color(
                    config?.uTwilightSkyTint ? config.uTwilightSkyTint[0] : 0.34,
                    config?.uTwilightSkyTint ? config.uTwilightSkyTint[1] : 0.71,
                    config?.uTwilightSkyTint ? config.uTwilightSkyTint[2] : 0.90
                )
            },
            uGroundBounceTint: {
                value: new THREE.Color(
                    config?.uGroundBounceTint ? config.uGroundBounceTint[0] : 0.38,
                    config?.uGroundBounceTint ? config.uGroundBounceTint[1] : 0.35,
                    config?.uGroundBounceTint ? config.uGroundBounceTint[2] : 0.32
                )
            },
            uGroundDeWash: { value: config?.uGroundDeWash ?? 0.42 }
        };

        (material as any).userData.delightUniforms = u;

        const prevOnBeforeCompile = material.onBeforeCompile;
        material.onBeforeCompile = (shader, renderer) => {
            if (typeof prevOnBeforeCompile === 'function') {
                prevOnBeforeCompile(shader, renderer);
            }

            Object.assign(shader.uniforms, u);

            // Inject vertex normal varying
            shader.vertexShader = `
                varying vec3 vDelightNormal;
                ${shader.vertexShader}
            `;
            shader.vertexShader = shader.vertexShader.replace(
                '#include <beginnormal_vertex>',
                `
                #include <beginnormal_vertex>
                vDelightNormal = normalize(normalMatrix * objectNormal);
                `
            );

            // Inject fragment de-lighting chunk
            shader.fragmentShader = `
                #define DELIGHT_ENABLED 1
                ${config?.uRealDelightEnabled ? '#define REAL_DELIGHT_ENABLED 1' : ''}
                uniform float uRealDelightEnabled;
                uniform float uMeshShading;
                uniform float uShadowLift;
                uniform float uHighlightCompress;
                uniform vec3 uStoneAlbedoTint;
                uniform vec3 uTwilightSkyTint;
                uniform vec3 uGroundBounceTint;
                uniform float uGroundDeWash;
                varying vec3 vDelightNormal;
                ${shader.fragmentShader}
            `;

            shader.fragmentShader = shader.fragmentShader.replace(
                '#include <dithering_fragment>',
                `
                #include <dithering_fragment>
                ${LOCATION_DELIGHT_FRAGMENT_CHUNK.replace('uTravertineTint', 'uStoneAlbedoTint')}
                `
            );
        };

        material.needsUpdate = true;
    }

    /**
     * Builds Three.js Light instances matching the location atmosphere config.
     */
    public static createLocationAtmosphereLights(config: AtmosphereSceneLightingConfig): {
        ambient: THREE.AmbientLight;
        hemi: THREE.HemisphereLight;
        sun: THREE.DirectionalLight;
        fill: THREE.DirectionalLight;
    } {
        const ambient = new THREE.AmbientLight(
            new THREE.Color(config.ambientLight.color),
            config.ambientLight.intensity
        );
        ambient.name = 'LocationAmbientLight';

        const hemi = new THREE.HemisphereLight(
            new THREE.Color(config.hemiLight.skyColor),
            new THREE.Color(config.hemiLight.groundColor),
            config.hemiLight.intensity
        );
        hemi.position.set(0, 50, 0);
        hemi.name = 'LocationHemiLight';

        const sun = new THREE.DirectionalLight(
            new THREE.Color(config.sunLight.color),
            config.sunLight.intensity
        );
        sun.position.set(
            config.sunLight.position[0],
            config.sunLight.position[1],
            config.sunLight.position[2]
        );
        sun.name = 'LocationSunLight';

        const fill = new THREE.DirectionalLight(
            new THREE.Color(config.fillLight.color),
            config.fillLight.intensity
        );
        fill.position.set(
            config.fillLight.position[0],
            config.fillLight.position[1],
            config.fillLight.position[2]
        );
        fill.name = 'LocationFillLight';

        return { ambient, hemi, sun, fill };
    }

    /**
     * Attaches location atmosphere lights directly into a Three.js scene.
     */
    public static applyLocationAtmosphereLighting(
        scene: THREE.Scene,
        config: AtmosphereSceneLightingConfig
    ): {
        ambient: THREE.AmbientLight;
        hemi: THREE.HemisphereLight;
        sun: THREE.DirectionalLight;
        fill: THREE.DirectionalLight;
    } {
        // Remove existing location lights if present
        const existingNames = ['LocationAmbientLight', 'LocationHemiLight', 'LocationSunLight', 'LocationFillLight'];
        for (const name of existingNames) {
            const child = scene.getObjectByName(name);
            if (child) scene.remove(child);
        }

        const lights = this.createLocationAtmosphereLights(config);
        scene.add(lights.ambient);
        scene.add(lights.hemi);
        scene.add(lights.sun);
        scene.add(lights.fill);

        return lights;
    }

    /**
     * Builds Three.js Light instances for architectural portal window fixtures.
     */
    public static createArchitecturalPortalLights(fixtures: ArchitecturalPortalFixtureConfig[]): THREE.Group {
        const group = new THREE.Group();
        group.name = 'ArchitecturalPortalFixtures';

        for (const f of fixtures) {
            const lightColor = new THREE.Color(f.color);

            if (f.type === 'spot') {
                const spot = new THREE.SpotLight(
                    lightColor,
                    f.intensity,
                    f.distance,
                    f.angle ?? 0.58,
                    f.penumbra ?? 0.75,
                    f.decay
                );
                spot.position.set(f.position[0], f.position[1], f.position[2]);
                spot.name = f.id;

                if (f.targetPosition) {
                    spot.target.position.set(f.targetPosition[0], f.targetPosition[1], f.targetPosition[2]);
                    group.add(spot.target);
                }
                group.add(spot);

                // Subtle back-glow point light
                const point = new THREE.PointLight(lightColor, f.intensity * 0.35, f.distance * 0.65, f.decay);
                point.position.set(f.position[0], f.position[1], f.position[2]);
                point.name = `${f.id}_point`;
                group.add(point);
            } else {
                const point = new THREE.PointLight(lightColor, f.intensity, f.distance, f.decay);
                point.position.set(f.position[0], f.position[1], f.position[2]);
                point.name = f.id;
                group.add(point);
            }
        }

        return group;
    }

    /**
     * Attaches architectural portal fixtures into a Three.js scene.
     */
    public static applyArchitecturalPortalLights(
        scene: THREE.Scene,
        fixtures: ArchitecturalPortalFixtureConfig[]
    ): THREE.Group {
        const existing = scene.getObjectByName('ArchitecturalPortalFixtures');
        if (existing) scene.remove(existing);

        const group = this.createArchitecturalPortalLights(fixtures);
        scene.add(group);
        return group;
    }

    /**
     * Synthesizes an HTMLCanvasElement with vertical sky gradient suitable for Three.js CanvasTexture.
     */
    public static createSkyGradientCanvas(
        gradient: AtmosphereSceneLightingConfig['skyGradient'],
        width = 512,
        height = 512
    ): any {
        if (typeof document === 'undefined') return null;
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) return null;

        const grad = ctx.createLinearGradient(0, 0, 0, height);
        grad.addColorStop(0.0, gradient.zenithColor);
        grad.addColorStop(0.45, gradient.midColor);
        grad.addColorStop(0.78, gradient.horizonColor);
        grad.addColorStop(1.0, gradient.nadirColor || gradient.horizonColor);

        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, width, height);
        return canvas;
    }
}

/**
 * Convenience standalone function for harmonizing location object atmosphere.
 */
export function harmonizeLocationObjectAtmosphere(
    request: LocationObjectAtmosphereRequest = {}
): LocationObjectAtmosphereResult {
    return LocationObjectLightingService.harmonizeLocationObjectAtmosphere(request);
}
