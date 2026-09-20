/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs-extra';
import {
    Google360PanoramaPipelineService,
    generate4KMonumentalPanorama,
    generate360Panorama
} from '../src/index';
import { createDefaultToolRegistry } from '../src/node/gemini/tool-registry';
import { TaskCapabilityResolver } from '../src/node/agent/task-capability-resolver';

describe('4K Monumental 360 Panorama Generator Pipeline & Agent Tool', () => {

    it('generates a 4K UHD (4096x2048) monumental panorama with Laplacian 2-band seam equalization and circle-free polar collapse', async () => {
        const tmpDir = path.join(os.tmpdir(), `test_4k_pano_${Date.now()}`);
        const outPath = path.join(tmpDir, 'monumental_atrium_4k.png');

        const result = await generate4KMonumentalPanorama({
            prompt: 'Monumental futuristic glass atrium rotunda with towering white marble fluted colonnades and crystalline domed oculus',
            style: 'architectural photography, natural zenith sunlight, 8k resolution',
            width: 4096,
            height: 2048,
            seamEqualization: 'laplacian_2band',
            enablePolarCaps: false, // Strict circle-free guarantee
            enforcePolarSingularity: true,
            outputImagePath: outPath,
            mockExecution: true
        });

        expect(result.success).toBe(true);
        expect(result.width).toBe(4096);
        expect(result.height).toBe(2048);
        expect(result.seamEqualized).toBe(true);
        expect(result.polarCapsRemoved).toBe(true);
        expect(result.polarSingularityCollapsed).toBe(true);
        expect(result.outputBuffer.length).toBeGreaterThan(10000);
        expect(result.outputImagePath).toBe(outPath);

        // Verify file written to disk
        expect(await fs.pathExists(outPath)).toBe(true);
        const stats = await fs.stat(outPath);
        expect(stats.size).toBeGreaterThan(10000);

        // Verify automated QC audit
        expect(result.qcReport).toBeDefined();
        expect(result.qcReport.pass).toBe(true);
        expect(result.qualityScore).toBe(100);
        expect(result.qcReport.metrics.meridianRms).toBeLessThanOrEqual(1.0);
        expect(result.qcReport.metrics.meridianMaxDelta).toBeLessThanOrEqual(2.0);
        expect(result.qcReport.metrics.zenithStdDev).toBeLessThanOrEqual(1.0);
        expect(result.qcReport.metrics.nadirStdDev).toBeLessThanOrEqual(1.0);

        await fs.remove(tmpDir);
    });

    it('delegates from generate360Panorama to 4K monumental pipeline when width is 4096', async () => {
        const result = await generate360Panorama({
            prompt: 'Gothic cathedral octagonal chapter house with central clustered limestone pillar',
            width: 4096,
            height: 2048,
            mockExecution: true
        });

        expect(result.success).toBe(true);
        expect(result.width).toBe(4096);
        expect(result.height).toBe(2048);
        expect(result.seamHealed).toBe(true);
        expect(result.outputBuffer.length).toBeGreaterThan(10000);
    });

    it('enforces zero polar discs by default and verifies infinitesimal singularity collapse', async () => {
        const service = new Google360PanoramaPipelineService();

        // 1. Circle-free execution (default)
        const cleanResult = await service.generate4KMonumentalPanorama({
            prompt: 'Ancient Roman Pantheon rotunda interior',
            width: 1024, // Test scaled dimensions
            height: 512,
            enablePolarCaps: false,
            enforcePolarSingularity: true,
            mockExecution: true
        });

        expect(cleanResult.polarCapsRemoved).toBe(true);
        expect(cleanResult.qcReport.metrics.zenithStdDev).toBe(0);
        expect(cleanResult.qcReport.metrics.nadirStdDev).toBe(0);
        expect(cleanResult.qcReport.pass).toBe(true);

        // 2. Explicit polar caps toggle
        const cappedResult = await service.generate4KMonumentalPanorama({
            prompt: 'Ancient Roman Pantheon rotunda interior',
            width: 1024,
            height: 512,
            enablePolarCaps: true,
            enforcePolarSingularity: true,
            mockExecution: true
        });

        expect(cappedResult.polarCapsRemoved).toBe(false);
    });

    it('registers panorama_generate_4k agent tool in default tool declarations', () => {
        const registry = createDefaultToolRegistry();
        const decls = registry.declarations();
        const toolDecl = decls.find(d => d.name === 'panorama_generate_4k');

        expect(toolDecl).toBeDefined();
        expect(toolDecl?.name).toBe('panorama_generate_4k');
        expect(toolDecl?.description).toContain('4K UHD 360 equirectangular panorama');
        expect(toolDecl?.parameters?.properties?.prompt).toBeDefined();
        expect(toolDecl?.parameters?.properties?.width).toBeDefined();
        expect(toolDecl?.parameters?.properties?.enablePolarCaps).toBeDefined();
    });

    it('dispatches panorama_generate_4k via agent tool registry and receives certified 100/100 payload', async () => {
        const registry = createDefaultToolRegistry();
        const outcome = await registry.dispatch(
            'panorama_generate_4k',
            {
                prompt: 'Neo-futuristic circular sky lounge with panoramic 360 glass curtain wall',
                width: 2048,
                height: 1024,
                mockExecution: true
            },
            {} as any
        );

        expect(outcome.exec.status).toBe('completed');
        expect(outcome.resultPayload).toBeDefined();
        const payload = outcome.resultPayload as any;
        expect(payload.success).toBe(true);
        expect(payload.width).toBe(2048);
        expect(payload.height).toBe(1024);
        expect(payload.seamEqualized).toBe(true);
        expect(payload.polarCapsRemoved).toBe(true);
        expect(payload.qualityScore).toBe(100);
        expect(payload.qcPass).toBe(true);
        expect(payload.summary).toContain('Generated 4K Monumental 360 Panorama');
    });

    it('routes 4K monumental panorama generation to Tier 1 Native Google Models', () => {
        const resolution = TaskCapabilityResolver.resolveTaskCapability(
            'Synthesize a 4K monumental 360 panorama of an ancient Roman basilica with marble vaulting and circular oculus',
            { domainHint: '3d' }
        );

        expect(resolution.recommendedResolutionRoute).toBe('tier1-native');
        expect(resolution.tier1Assessment.canSolveNatively).toBe(true);
        expect(resolution.tier1Assessment.primaryNativeEngine).toBe('google-models');
        expect(resolution.tier1Assessment.nativeCapabilitiesUsed.some(c => c.includes('4K Monumental 360 Panorama Generator'))).toBe(true);
    });

});
