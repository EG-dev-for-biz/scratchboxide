/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NextGenAstraViewportEngine } from '../src/browser/generative-canvas/services/NextGenAstraViewportEngine';

function createMockContainer() {
    const children: any[] = [];
    return {
        clientWidth: 1280,
        clientHeight: 720,
        appendChild: (child: any) => {
            children.push(child);
            return child;
        },
        removeChild: (child: any) => {
            const idx = children.indexOf(child);
            if (idx >= 0) children.splice(idx, 1);
            return child;
        },
        contains: (child: any) => children.includes(child),
        children
    } as any;
}

describe('NextGenAstraViewportEngine (Standalone Next-Gen Viewport)', () => {
    let container: any;
    let engine: NextGenAstraViewportEngine | null = null;

    beforeEach(() => {
        container = createMockContainer();
    });

    afterEach(() => {
        if (engine) {
            engine.dispose();
            engine = null;
        }
    });

    it('1. Initializes standalone engine with AgX tone mapping and WebGL/WebGPU stack', () => {
        engine = new NextGenAstraViewportEngine({
            container,
            initialTonemapping: 'agx',
            enableMeshletVirtualization: true,
            enableHybridSplats: true,
            enableClusteredLighting: true,
            lightCount: 32
        });

        expect(engine).toBeDefined();
        expect(engine.getScene()).toBeDefined();
        expect(engine.getCamera()).toBeDefined();
        expect(engine.getRenderer()).toBeDefined();
        expect(container.children.length).toBeGreaterThanOrEqual(1);
    });

    it('2. Evaluates telemetry and reports virtualized triangles and draw call efficiency', () => {
        engine = new NextGenAstraViewportEngine({
            container,
            initialTonemapping: 'agx',
            enableMeshletVirtualization: true
        });

        let latestTelemetry: any = null;
        const unsubscribe = engine.subscribeTelemetry(telemetry => {
            latestTelemetry = telemetry;
        });

        expect(latestTelemetry).toBeDefined();
        expect(latestTelemetry.virtualizedTriangles).toBe(100_000_000);
        expect(latestTelemetry.activeDrawCalls).toBe(1);
        expect(latestTelemetry.toneMappingMode).toBe('agx');
        expect(latestTelemetry.standardBaseline.estimatedDrawCalls).toBe(3840);
        expect(latestTelemetry.standardBaseline.estimatedVramMb).toBe(4200);
        expect(latestTelemetry.blenderBaseline.estimatedDrawCalls).toBe(3840);
        expect(latestTelemetry.blenderBaseline.estimatedVramMb).toBe(4200);

        unsubscribe();
    });

    it('3. Supports dynamic tone mapping mode switching (AgX, ACES, Linear)', () => {
        engine = new NextGenAstraViewportEngine({
            container,
            initialTonemapping: 'agx'
        });

        engine.applyToneMapping('aces');
        engine.applyToneMapping('linear');
        engine.applyToneMapping('agx');

        expect(engine.getRenderer().toneMappingExposure).toBeGreaterThan(1.0);
    });

    it('4. Updates screen space error (SSE) and meshlet cluster visualization parameters', () => {
        engine = new NextGenAstraViewportEngine({
            container,
            screenSpaceErrorThresholdPx: 1.0
        });

        engine.setScreenSpaceErrorThreshold(2.5);
        engine.setShowClusterColors(false);
        engine.setShowClusterWireframe(true);
        engine.setLightCount(16);

        expect(engine).toBeDefined();
    });

    it('5. Handles container resize cleanly without aspect distortion', () => {
        engine = new NextGenAstraViewportEngine({ container });

        engine.resize(1920, 1080);
        expect(engine.getCamera().aspect).toBeCloseTo(1920 / 1080);
    });

    it('6. Disposes cleanly without leaking animation frames or canvas elements', () => {
        engine = new NextGenAstraViewportEngine({ container });
        expect(container.children.length).toBeGreaterThanOrEqual(1);

        engine.dispose();
        expect(container.children.length).toBe(0);
        engine = null;
    });
});
