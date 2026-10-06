/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { buildThreeJsLightingRig } from '../src/browser/generative-canvas/primitives/scene3d/lightingRigs';
import { resolveStudioRigScale } from '../src/browser/generative-canvas/primitives/scene3d/syncAtmosphere';

function irradianceAtOrigin(lights: THREE.Light[]): number {
    let e = 0;
    for (const l of lights) {
        const p = l as THREE.PointLight;
        if (!p.isPointLight) continue;
        const d = p.position.length();
        if (p.distance > 0 && d >= p.distance) continue;
        e += p.intensity / Math.max(d * d, 1e-6);
    }
    return e;
}

describe('Studio lighting rig scales continuously with loaded content size', () => {
    it('keeps the authored rig for object-sized content and never shrinks it', () => {
        expect(resolveStudioRigScale({ isLargeScale: false })).toBe(1);
        expect(resolveStudioRigScale({ isLargeScale: false, contentRadiusMeters: 2 })).toBe(1);
        expect(resolveStudioRigScale({ isLargeScale: true })).toBe(100);
    });

    it('a 50 m outpost gets lights whose range covers its whole bounding sphere', () => {
        const radius = 50;
        const scale = resolveStudioRigScale({ isLargeScale: false, contentRadiusMeters: radius });
        expect(scale).toBeGreaterThan(5);

        const lights = buildThreeJsLightingRig('studio', { scale });
        const points = lights.filter(l => (l as THREE.PointLight).isPointLight) as THREE.PointLight[];
        expect(points.length).toBeGreaterThan(0);
        for (const p of points) {
            expect(p.distance).toBeGreaterThan(radius + p.position.length() * 0.5);
        }

        const authored = irradianceAtOrigin(buildThreeJsLightingRig('studio', { scale: 1 }));
        const scaled = irradianceAtOrigin(lights);
        expect(scaled / authored).toBeGreaterThan(0.9);
        expect(scaled / authored).toBeLessThan(1.1);
    });
});
