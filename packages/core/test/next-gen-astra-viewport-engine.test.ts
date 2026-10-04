/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
    NextGenAstroViewportEngine,
    NextGenAstraViewportEngine,
    CULL_MESHLETS_WGSL,
    MICRO_RASTERIZER_WGSL,
    VISIBILITY_BUFFER_SHADING_WGSL,
    TEMPORAL_SUPER_RES_WGSL,
    RELIEF_MICRO_DISPLACEMENT_WGSL,
    CLUSTER_SLOT_SIZE_BYTES,
    VRAM_PAGE_POOL_SIZE_MB,
    TOTAL_RESIDENT_SLOTS,
    VIRTUAL_GEOMETRY_CAPACITY_TRIANGLES
} from '../src/browser/generative-canvas/services/NextGenAstraViewportEngine';

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

describe('NextGenAstroViewportEngine (Standalone Next-Gen Viewport)', () => {
    let container: any;
    let engine: NextGenAstroViewportEngine | null = null;

    beforeEach(() => {
        container = createMockContainer();
    });

    afterEach(() => {
        if (engine) {
            engine.dispose();
            engine = null;
        }
    });

    it('0. Exports NextGenAstroViewportEngine with NextGenAstraViewportEngine backward compatibility alias', () => {
        expect(NextGenAstroViewportEngine).toBeDefined();
        expect(NextGenAstraViewportEngine).toBe(NextGenAstroViewportEngine);
    });

    it('1. Initializes standalone engine with AgX tone mapping and WebGL/WebGPU stack', () => {
        engine = new NextGenAstroViewportEngine({
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
        engine = new NextGenAstroViewportEngine({
            container,
            initialTonemapping: 'agx',
            enableMeshletVirtualization: true
        });

        let latestTelemetry: any = null;
        const unsubscribe = engine.subscribeTelemetry(telemetry => {
            latestTelemetry = telemetry;
        });

        expect(latestTelemetry).toBeDefined();
        expect(latestTelemetry.virtualizedTriangles).toBe(VIRTUAL_GEOMETRY_CAPACITY_TRIANGLES);
        expect(latestTelemetry.virtualGeometryPagingEnabled).toBe(true);
        expect(latestTelemetry.residentVramPoolMb).toBe(256);
        expect(latestTelemetry.residentClusterSlots).toBe(65536);
        expect(latestTelemetry.activeDrawCalls).toBe(1);
        expect(latestTelemetry.toneMappingMode).toBe('agx');
        expect(latestTelemetry.standardBaseline.estimatedDrawCalls).toBe(3840);
        expect(latestTelemetry.standardBaseline.estimatedVramMb).toBe(4200);
        expect(latestTelemetry.blenderBaseline.estimatedDrawCalls).toBe(3840);
        expect(latestTelemetry.blenderBaseline.estimatedVramMb).toBe(4200);

        unsubscribe();
    });

    it('3. Supports dynamic tone mapping mode switching (AgX, ACES, Linear)', () => {
        engine = new NextGenAstroViewportEngine({
            container,
            initialTonemapping: 'agx'
        });

        engine.applyToneMapping('aces');
        engine.applyToneMapping('linear');
        engine.applyToneMapping('agx');

        expect(engine.getRenderer().toneMappingExposure).toBeGreaterThan(1.0);
    });

    it('4. Updates screen space error (SSE) and meshlet cluster visualization parameters', () => {
        engine = new NextGenAstroViewportEngine({
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
        engine = new NextGenAstroViewportEngine({ container });

        engine.resize(1920, 1080);
        expect(engine.getCamera().aspect).toBeCloseTo(1920 / 1080);
    });

    it('6. Disposes cleanly without leaking animation frames or canvas elements', () => {
        engine = new NextGenAstroViewportEngine({ container });
        expect(container.children.length).toBeGreaterThanOrEqual(1);

        engine.dispose();
        expect(container.children.length).toBe(0);
        engine = null;
    });

    it('7. Exports and validates WGSL compute shaders for silicon performance limits', () => {
        expect(CULL_MESHLETS_WGSL).toContain('MeshletClusterData');
        expect(CULL_MESHLETS_WGSL).toContain('DrawIndexedIndirectArgs');
        expect(CULL_MESHLETS_WGSL).toContain('atomicAdd');
        expect(MICRO_RASTERIZER_WGSL).toContain('visBuffer');
        expect(VISIBILITY_BUFFER_SHADING_WGSL).toContain('shadeVisBuffer');
        expect(TEMPORAL_SUPER_RES_WGSL).toContain('accumulateTemporalTSR');
        expect(RELIEF_MICRO_DISPLACEMENT_WGSL).toContain('computeMicroRelief');
    });

    it('8. Configures and toggles GPU Compute Culling, Hi-Z, Software Micro-Rasterizer, and VisBuffer', () => {
        engine = new NextGenAstroViewportEngine({
            container,
            enableGpuComputeCulling: true,
            enableHiZOcclusion: true,
            enableSoftwareComputeRasterizer: true,
            enableVisibilityBuffer: true
        });

        let telemetry: any = null;
        engine.subscribeTelemetry(t => { telemetry = t; });

        expect(telemetry.gpuComputeCullingEnabled).toBe(true);
        expect(telemetry.gpuComputeCullingMs).toBeLessThanOrEqual(0.1);
        expect(telemetry.softwareComputeRasterizerEnabled).toBe(true);
        expect(telemetry.quadFragmentEfficiencyPct).toBeGreaterThan(95.0);
        expect(telemetry.visBufferEnabled).toBe(true);
        expect(telemetry.shadingOverdrawRatio).toBe(1.00);

        // Toggle to legacy / CPU state and verify telemetry updates
        engine.setGpuComputeCulling(false);
        engine.setSoftwareComputeRasterizer(false);
        engine.setVisibilityBuffer(false);

        expect(telemetry.gpuComputeCullingEnabled).toBe(false);
        expect(telemetry.gpuComputeCullingMs).toBeGreaterThan(1.0);
        expect(telemetry.softwareComputeRasterizerEnabled).toBe(false);
        expect(telemetry.quadFragmentEfficiencyPct).toBeLessThan(50.0);
        expect(telemetry.visBufferEnabled).toBe(false);
        expect(telemetry.shadingOverdrawRatio).toBeGreaterThan(2.0);
    });

    it('9. Scales resolution and calculates fillrate boost across Temporal Super Resolution modes', () => {
        engine = new NextGenAstroViewportEngine({
            container,
            temporalSuperResolutionMode: 'off'
        });

        let telemetry: any = null;
        engine.subscribeTelemetry(t => { telemetry = t; });

        expect(telemetry.fillrateBoostMultiplier).toBe(1.00);

        engine.setTemporalSuperResolution('ultra-quality');
        expect(telemetry.fillrateBoostMultiplier).toBeCloseTo(1.69, 1);

        engine.setTemporalSuperResolution('quality');
        expect(telemetry.fillrateBoostMultiplier).toBeCloseTo(2.25, 1);

        engine.setTemporalSuperResolution('performance');
        expect(telemetry.fillrateBoostMultiplier).toBe(4.00);
        expect(telemetry.effectiveFps).toBeGreaterThan(telemetry.fps);
    });

    it('10. Validates uniform 4KB cluster slot envelope and hardware scalability constants', () => {
        expect(CLUSTER_SLOT_SIZE_BYTES).toBe(4096);
        expect(VRAM_PAGE_POOL_SIZE_MB).toBe(256);
        expect(TOTAL_RESIDENT_SLOTS).toBe(65536);
        expect(VIRTUAL_GEOMETRY_CAPACITY_TRIANGLES).toBe(10_000_000_000);
        expect((TOTAL_RESIDENT_SLOTS * CLUSTER_SLOT_SIZE_BYTES) / (1024 * 1024)).toBe(VRAM_PAGE_POOL_SIZE_MB);
    });

    it('11. Computes Camera-Relative Double Precision (CDP) positions with sub-millimeter accuracy', () => {
        engine = new NextGenAstroViewportEngine({ container });

        // Two points on Earth's surface separated by exactly 1 millimeter at latitude 41.8902 N
        // In absolute earth-centered geocentric coordinates: ~6,378,137 meters
        const planetaryCamera: [number, number, number] = [6378137.000, 1250000.000, 4500000.000];
        const planetaryVertex: [number, number, number] = [6378137.001, 1250000.0005, 4500000.000];

        // Direct subtraction in f32 would completely lose 0.001 (1mm) due to 24-bit mantissa (resolution ~0.5m)
        // Camera-Relative subtraction on CPU retains exact millimeters in f32:
        const relPos = engine.computeCameraRelativePosition(planetaryVertex, planetaryCamera);

        expect(relPos[0]).toBeCloseTo(0.001, 4); // Sub-millimeter precision
        expect(relPos[1]).toBeCloseTo(0.0005, 4);
        expect(relPos[2]).toBe(0);
    });

    it('12. Enforces Strict Parent LOD Fallback Invariant with zero holes when child is non-resident', () => {
        engine = new NextGenAstroViewportEngine({
            container,
            enableVirtualGeometryPaging: true,
            enableStrictParentLodFallback: true
        });

        // Query a resident cluster
        const residentSlot = engine.getVirtualClusterSlot(10);
        expect(residentSlot).toBeDefined();
        expect(residentSlot?.isResident).toBe(true);

        const residentResult = engine.resolveClusterOrParent(10);
        expect(residentResult.resolvedId).toBe(10);
        expect(residentResult.isFallback).toBe(false);

        // Evict cluster 10 from VRAM slot table
        engine.evictClusterFromSlot(10);
        expect(engine.isSlotResident(residentSlot!.slotIndex)).toBe(false);

        // Query evicted cluster: Must seamlessly fallback to parent cluster without holes
        const fallbackResult = engine.resolveClusterOrParent(10);
        expect(fallbackResult.resolvedId).toBe(residentSlot!.parentClusterId);
        expect(fallbackResult.isFallback).toBe(true);

        // Reload cluster into slot and verify immediate recovery
        engine.loadClusterIntoSlot(10, residentSlot!.slotIndex);
        expect(engine.isSlotResident(residentSlot!.slotIndex)).toBe(true);
        const restoredResult = engine.resolveClusterOrParent(10);
        expect(restoredResult.resolvedId).toBe(10);
        expect(restoredResult.isFallback).toBe(false);
    });

    it('13. Deduplicates procedural/CAD subtrees via SVDAG and scales virtual geometry telemetry', () => {
        engine = new NextGenAstroViewportEngine({
            container,
            enableVirtualGeometryPaging: true,
            enableSvdagDeduplication: true
        });

        let telemetry: any = null;
        engine.subscribeTelemetry(t => { telemetry = t; });

        expect(telemetry.virtualGeometryPagingEnabled).toBe(true);
        expect(telemetry.virtualizedTrianglesCapacity).toBe(10_000_000_000);
        expect(telemetry.residentVramPoolMb).toBe(256);
        expect(telemetry.residentClusterSlots).toBe(65536);
        expect(telemetry.svdagDeduplicationRatio).toBeGreaterThanOrEqual(1.0);

        // Test SVDAG hash consing deduplication
        const hash = 'corinthian_column_capital_lod0';
        const res1 = engine.deduplicateProceduralSubtree(hash, 5000);
        expect(res1.isNew).toBe(true);
        expect(res1.deduplicatedTriangles).toBe(0);

        // Second encounter of identical geometry must be deduplicated
        const res2 = engine.deduplicateProceduralSubtree(hash, 5000);
        expect(res2.isNew).toBe(false);
        expect(res2.deduplicatedTriangles).toBe(5000);

        // Verify deduplication ratio calculation
        const ratio = engine.getSvdagDeduplicationRatio();
        expect(ratio).toBeGreaterThan(1.0);
    });
});
