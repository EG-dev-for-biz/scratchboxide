/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as THREE from 'three';
import {
    PhotometricLightConfig,
    PhotometricLightingRigData,
    planckianKelvinToRgb,
    ratioToStops,
    stopsToRatio
} from '../../../../common/spatial/photometric-units';

export interface GafferRigOptions {
    keyToFillRatio?: number; // e.g. 2.0, 4.0, 8.0
    keyKelvin?: number;
    fillKelvin?: number;
    rimKelvin?: number;
    subjectPosition?: [number, number, number];
    distanceScale?: number;
    keyIntensityLux?: number;
    goboCookie?: 'venetian_blinds' | 'window_mullions' | 'tree_canopy';
    penumbraSoftness?: number; // 0.0 (sharp) to 1.0 (diffused softbox)
    motivatedSource?: {
        entityId?: string;
        description: string;
    };
}

export class LightingGafferService {
    /**
     * Builds a calibrated photographic lighting rig adhering to cinematographic grammar.
     */
    public static buildGafferRig(
        style: 'rembrandt' | 'butterfly' | 'split' | 'loop' | 'three_point' | 'high_key' | 'noir',
        options: GafferRigOptions = {}
    ): PhotometricLightingRigData {
        const subPos = options.subjectPosition || [0, 1.0, 0];
        const scale = options.distanceScale || 1.0;

        // Default ratios per style if not explicitly supplied
        let ratio = options.keyToFillRatio;
        if (ratio === undefined) {
            switch (style) {
                case 'high_key': ratio = 1.0; break; // 1:1
                case 'butterfly': ratio = 2.0; break; // 2:1 (+1 stop)
                case 'three_point': ratio = 3.0; break;
                case 'rembrandt': ratio = 4.0; break; // 4:1 (+2 stops)
                case 'loop': ratio = 3.0; break;
                case 'split': ratio = 8.0; break; // 8:1 (+3 stops)
                case 'noir': ratio = 16.0; break; // 16:1 (+4 stops)
                default: ratio = 4.0;
            }
        }

        const stops = ratioToStops(ratio);
        const keyKelvin = options.keyKelvin || (style === 'noir' ? 4000 : 5600);
        const fillKelvin = options.fillKelvin || (style === 'noir' ? 8500 : 7000);
        const rimKelvin = options.rimKelvin || 6500;
        const keyLux = options.keyIntensityLux || 1200.0;
        const fillLux = keyLux / ratio;
        const penumbra = options.penumbraSoftness !== undefined ? options.penumbraSoftness : 0.6;

        const lights: PhotometricLightConfig[] = [];
        const rigId = `gaffer_${style}_${Date.now()}`;

        // 1. Configure Key Light based on geometric style
        let keyPos: [number, number, number] = [subPos[0] + 3.0 * scale, subPos[1] + 3.0 * scale, subPos[2] + 3.0 * scale];
        let keyInner = 0.35;
        let keyOuter = 0.65;

        switch (style) {
            case 'rembrandt':
                // Classic 45° horizontal and 45° vertical angle casting cheek triangle
                keyPos = [subPos[0] + 3.2 * scale, subPos[1] + 3.2 * scale, subPos[2] + 3.2 * scale];
                keyInner = 0.28;
                keyOuter = 0.58;
                break;
            case 'butterfly':
                // High frontal key casting drop shadow under nose
                keyPos = [subPos[0], subPos[1] + 4.5 * scale, subPos[2] + 3.5 * scale];
                keyInner = 0.35;
                keyOuter = 0.65;
                break;
            case 'split':
                // 90° lateral key splitting face into light/dark halves
                keyPos = [subPos[0] + 4.5 * scale, subPos[1] + 1.2 * scale, subPos[2]];
                keyInner = 0.22;
                keyOuter = 0.48;
                break;
            case 'loop':
                // ~30° key casting subtle nose loop shadow towards cheek
                keyPos = [subPos[0] + 2.2 * scale, subPos[1] + 2.8 * scale, subPos[2] + 3.8 * scale];
                keyInner = 0.30;
                keyOuter = 0.60;
                break;
            case 'high_key':
                keyPos = [subPos[0], subPos[1] + 2.5 * scale, subPos[2] + 4.5 * scale];
                keyInner = 0.50;
                keyOuter = 0.85;
                break;
            case 'noir':
                keyPos = [subPos[0] + 4.8 * scale, subPos[1] + 1.0 * scale, subPos[2] + 0.5 * scale];
                keyInner = 0.18;
                keyOuter = 0.40;
                break;
            default: // three_point
                keyPos = [subPos[0] + 3.0 * scale, subPos[1] + 2.8 * scale, subPos[2] + 3.0 * scale];
                break;
        }

        const keyRgb = planckianKelvinToRgb(keyKelvin);
        const keyLight: PhotometricLightConfig = {
            id: `${rigId}_key`,
            name: `${style}_Key_Light`,
            type: 'spot',
            role: 'key',
            position: keyPos,
            target: subPos,
            direction: [subPos[0] - keyPos[0], subPos[1] - keyPos[1], subPos[2] - keyPos[2]],
            cctKelvin: keyKelvin,
            colorLinearRgb: [keyRgb.r, keyRgb.g, keyRgb.b],
            intensityLux: keyLux,
            exposureStopsDelta: 0.0,
            distanceMeters: Math.hypot(keyPos[0] - subPos[0], keyPos[1] - subPos[1], keyPos[2] - subPos[2]),
            beamInnerConeRad: keyInner,
            beamOuterConeRad: keyOuter,
            penumbraSoftness: penumbra,
            castShadow: true,
            shadowBias: -0.0005,
            goboCookieTexture: options.goboCookie,
            motivatedBy: options.motivatedSource
        };
        lights.push(keyLight);

        // 2. Configure Fill Light (Opposite side, soft, NEVER casting conflicting harsh shadow)
        const fillPos: [number, number, number] = [
            subPos[0] - 3.5 * scale,
            subPos[1] + 1.8 * scale,
            subPos[2] + 2.5 * scale
        ];
        const fillRgb = planckianKelvinToRgb(fillKelvin);
        const fillLight: PhotometricLightConfig = {
            id: `${rigId}_fill`,
            name: `${style}_Fill_Light`,
            type: 'point',
            role: 'fill',
            position: fillPos,
            target: subPos,
            cctKelvin: fillKelvin,
            colorLinearRgb: [fillRgb.r, fillRgb.g, fillRgb.b],
            intensityLux: fillLux,
            exposureStopsDelta: -stops,
            distanceMeters: Math.hypot(fillPos[0] - subPos[0], fillPos[1] - subPos[1], fillPos[2] - subPos[2]),
            penumbraSoftness: 1.0, // Ultra diffused fill
            castShadow: false
        };
        lights.push(fillLight);

        // 3. Configure Rim / Backlight Kicker (Subject-to-Background Separation)
        const rimPos: [number, number, number] = [
            subPos[0] - 1.8 * scale,
            subPos[1] + 3.8 * scale,
            subPos[2] - 3.8 * scale
        ];
        const rimRgb = planckianKelvinToRgb(rimKelvin);
        const rimLight: PhotometricLightConfig = {
            id: `${rigId}_rim`,
            name: `${style}_Rim_Kicker`,
            type: 'spot',
            role: 'rim',
            position: rimPos,
            target: subPos,
            direction: [subPos[0] - rimPos[0], subPos[1] - rimPos[1], subPos[2] - rimPos[2]],
            cctKelvin: rimKelvin,
            colorLinearRgb: [rimRgb.r, rimRgb.g, rimRgb.b],
            intensityLux: keyLux * 1.5, // Crisp edge highlight
            exposureStopsDelta: 0.58,
            distanceMeters: Math.hypot(rimPos[0] - subPos[0], rimPos[1] - subPos[1], rimPos[2] - subPos[2]),
            beamInnerConeRad: 0.25,
            beamOuterConeRad: 0.55,
            penumbraSoftness: 0.3,
            castShadow: true
        };
        lights.push(rimLight);

        return {
            rigId,
            name: `Photometric Gaffer Rig (${style.toUpperCase()})`,
            style: style as any,
            keyToFillRatio: ratio,
            keyToFillStops: stops,
            lights
        };
    }

    /**
     * Synthesizes procedural vector gobo / cookie patterns (blinds, tree dappling, window frames) as SVG data URIs.
     */
    public static createProceduralGoboDataUri(cookieType: 'venetian_blinds' | 'window_mullions' | 'tree_canopy'): string {
        let svg = '';
        switch (cookieType) {
            case 'venetian_blinds': {
                // 12 horizontal slats with light gaps
                let slats = '';
                for (let i = 0; i < 12; i++) {
                    const y = i * 42 + 10;
                    slats += `<rect x="0" y="${y}" width="512" height="24" fill="#000000" />`;
                }
                svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512"><rect width="512" height="512" fill="#ffffff" />${slats}</svg>`;
                break;
            }
            case 'window_mullions': {
                // Classic 4-pane French window cross
                svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512"><rect width="512" height="512" fill="#ffffff" /><path d="M0,0 H512 V512 H0 Z M236,20 H20 V236 H236 Z M492,20 H276 V236 H492 Z M236,276 H20 V492 H236 Z M492,276 H276 V492 H492 Z" fill="#000000" /></svg>`;
                break;
            }
            case 'tree_canopy': {
                // Organic dappled foliage clusters
                let circles = '';
                const clusters = [
                    [120, 140, 45], [180, 110, 60], [280, 160, 55], [350, 120, 40],
                    [150, 260, 50], [240, 290, 70], [360, 270, 55], [420, 200, 45],
                    [200, 400, 65], [310, 390, 50], [100, 360, 40], [420, 370, 45]
                ];
                for (const [cx, cy, r] of clusters) {
                    circles += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="#000000" opacity="0.88" />`;
                }
                svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512"><rect width="512" height="512" fill="#ffffff" />${circles}</svg>`;
                break;
            }
        }
        return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
    }

    /**
     * Converts a PhotometricLightingRigData into active Three.js lights in a scene.
     */
    public static applyGafferRigToThreeScene(
        scene: THREE.Scene,
        rig: PhotometricLightingRigData,
        scale: number = 1.0
    ): THREE.Light[] {
        const threeLights: THREE.Light[] = [];

        for (const cfg of rig.lights) {
            const color = new THREE.Color(cfg.colorLinearRgb[0], cfg.colorLinearRgb[1], cfg.colorLinearRgb[2]);
            const intensity = (cfg.intensityLux || 1000) * 0.02 * (scale > 1.0 ? scale * scale : 1.0);

            if (cfg.type === 'spot') {
                const spot = new THREE.SpotLight(
                    color,
                    intensity,
                    (cfg.distanceMeters || 20) * 2.0 * scale,
                    cfg.beamOuterConeRad || 0.6,
                    cfg.penumbraSoftness !== undefined ? cfg.penumbraSoftness : 0.5
                );
                spot.name = cfg.name;
                spot.position.set(cfg.position[0] * scale, cfg.position[1] * scale, cfg.position[2] * scale);

                if (cfg.target) {
                    const target = new THREE.Object3D();
                    target.position.set(cfg.target[0] * scale, cfg.target[1] * scale, cfg.target[2] * scale);
                    spot.target = target;
                    scene.add(target);
                }

                if (cfg.castShadow) {
                    spot.castShadow = true;
                    spot.shadow.mapSize.width = 1024;
                    spot.shadow.mapSize.height = 1024;
                    spot.shadow.bias = cfg.shadowBias || -0.0005;
                }

                scene.add(spot);
                threeLights.push(spot);
            } else if (cfg.type === 'point') {
                const point = new THREE.PointLight(
                    color,
                    intensity * 0.8,
                    (cfg.distanceMeters || 15) * 2.0 * scale
                );
                point.name = cfg.name;
                point.position.set(cfg.position[0] * scale, cfg.position[1] * scale, cfg.position[2] * scale);
                point.castShadow = cfg.castShadow;
                scene.add(point);
                threeLights.push(point);
            } else if (cfg.type === 'directional') {
                const dir = new THREE.DirectionalLight(color, intensity * 0.5);
                dir.name = cfg.name;
                dir.position.set(cfg.position[0] * scale, cfg.position[1] * scale, cfg.position[2] * scale);
                dir.castShadow = cfg.castShadow;
                scene.add(dir);
                threeLights.push(dir);
            }
        }

        return threeLights;
    }
}
