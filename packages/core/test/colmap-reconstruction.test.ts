/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
    ColmapReconstructionService,
    NativeCppCompilerService
} from '../src/node';

describe('COLMAP & GLOMAP Photogrammetry Pipeline (Native C++20 & TS Service)', () => {
    const service = new ColmapReconstructionService();
    const testDir = path.resolve(process.cwd(), 'build/test_colmap_data');

    beforeAll(() => {
        if (!fs.existsSync(testDir)) {
            fs.mkdirSync(testDir, { recursive: true });
        }
    });

    afterAll(() => {
        if (fs.existsSync(testDir)) {
            fs.rmSync(testDir, { recursive: true, force: true });
        }
    });

    it('1. should verify native C++20 COLMAP SDK headers are accessible', () => {
        const compiler = new NativeCppCompilerService();
        const sdkInclude = compiler.getSdkIncludePath();
        expect(fs.existsSync(sdkInclude)).toBe(true);

        const headerPath = path.join(sdkInclude, 'scratchbox_colmap.hpp');
        expect(fs.existsSync(headerPath)).toBe(true);

        const content = fs.readFileSync(headerPath, 'utf8');
        expect(content).toContain('namespace colmap');
        expect(content).toContain('struct ColmapCamera');
        expect(content).toContain('struct ColmapImage');
        expect(content).toContain('struct ColmapPoint3D');
        expect(content).toContain('struct ColmapReconstruction');
        expect(content).toContain('class ColmapParser');
        expect(content).toContain('class ColmapMeshBuilder');
        expect(content).toContain('getOpenGLCameraToWorldMatrix');
        expect(content).toContain('exportToGlb');
    });

    it('2. should verify master SDK header exposes sb::clm namespace alias', () => {
        const compiler = new NativeCppCompilerService();
        const masterHeader = path.join(compiler.getSdkIncludePath(), 'scratchbox_engine.hpp');
        const content = fs.readFileSync(masterHeader, 'utf8');
        expect(content).toContain('#include "scratchbox_colmap.hpp"');
        expect(content).toContain('namespace clm = scratchbox::colmap;');
    });

    it('3. should verify native CLI binary compiles and executes successfully', async () => {
        const binPath = await service.ensureBinary();
        expect(fs.existsSync(binPath)).toBe(true);

        const outGlb = path.join(testDir, 'synthetic_test.glb');
        const result = await service.convertColmapToGlb({
            synthetic: true,
            outGlbPath: outGlb,
            frustumScale: 0.4,
            pointRadius: 0.02
        });

        expect(result.success).toBe(true);
        expect(result.numCameras).toBe(1);
        expect(result.numImages).toBe(8);
        expect(result.numPoints3D).toBeGreaterThan(50);
        expect(result.glbBytes).toBeGreaterThan(1000);
        expect(fs.existsSync(outGlb)).toBe(true);

        // Verify standard glTF 2.0 binary header: 'glTF' (0x46546C67 in LE = 0x67 0x6C 0x54 0x46)
        const glbBuffer = fs.readFileSync(outGlb);
        const magic = glbBuffer.toString('utf8', 0, 4);
        expect(magic).toBe('glTF');

        const version = glbBuffer.readUInt32LE(4);
        expect(version).toBe(2);

        expect(result.bounds).toBeDefined();
        expect(result.centroid).toBeDefined();
    });

    it('4. should parse custom COLMAP sparse text files accurately', async () => {
        const sparseDir = path.join(testDir, 'sparse_text');
        fs.mkdirSync(sparseDir, { recursive: true });

        // Write cameras.txt
        const camerasTxt = [
            '# Camera list with one line of data per camera:',
            '#   CAMERA_ID, MODEL, WIDTH, HEIGHT, PARAMS[]',
            '1 PINHOLE 1920 1080 1500.0 1500.0 960.0 540.0',
            '2 SIMPLE_RADIAL 1280 720 1000.0 640.0 360.0 -0.05'
        ].join('\n');
        fs.writeFileSync(path.join(sparseDir, 'cameras.txt'), camerasTxt);

        // Write images.txt
        const imagesTxt = [
            '# Image list with two lines of data per image:',
            '#   IMAGE_ID, QW, QX, QY, QZ, TX, TY, TZ, CAMERA_ID, NAME',
            '#   POINTS2D[] as (X, Y, POINT3D_ID)',
            '1 0.92388 0.0 0.38268 0.0 1.2 0.5 -3.4 1 frame_001.jpg',
            '100.5 200.5 1 500.0 600.0 2',
            '2 0.70711 0.0 0.70711 0.0 -2.1 0.8 -4.5 2 frame_002.jpg',
            '300.0 400.0 1'
        ].join('\n');
        fs.writeFileSync(path.join(sparseDir, 'images.txt'), imagesTxt);

        // Write points3D.txt
        const pointsTxt = [
            '# 3D point list with one line of data per point:',
            '#   POINT3D_ID, X, Y, Z, R, G, B, ERROR, TRACK[] as (IMAGE_ID, POINT2D_IDX)',
            '1 0.0 1.5 2.0 255 128 0 0.25 1 0 2 0',
            '2 -1.0 0.5 3.0 100 200 255 0.32 1 1'
        ].join('\n');
        fs.writeFileSync(path.join(sparseDir, 'points3D.txt'), pointsTxt);

        // Execute parsing and GLB generation
        const outGlb = path.join(testDir, 'custom_text_output.glb');
        const summary = await service.convertColmapToGlb({
            sparseDir,
            outGlbPath: outGlb
        });

        expect(summary.success).toBe(true);
        expect(summary.numCameras).toBe(2);
        expect(summary.numImages).toBe(2);
        expect(summary.numPoints3D).toBe(2);
        expect(summary.glbBytes).toBeGreaterThan(500);

        const glbBuffer = fs.readFileSync(outGlb);
        expect(glbBuffer.toString('utf8', 0, 4)).toBe('glTF');
    });

    it('5. should execute native C++20 GLOMAP reconstruction on multi-view street view images', async () => {
        const glomapOutDir = path.join(testDir, 'glomap_test_run');
        const framesDir = path.join(testDir, 'multiview_frames');
        fs.mkdirSync(framesDir, { recursive: true });

        // Copy test multi-view frames
        const testBmp1 = path.resolve(process.cwd(), 'build/test_esb_facade.bmp');
        const testBmp2 = path.resolve(process.cwd(), 'build/esb_west_5thave.bmp');
        if (fs.existsSync(testBmp1)) fs.copyFileSync(testBmp1, path.join(framesDir, 'frame_01.bmp'));
        if (fs.existsSync(testBmp2)) fs.copyFileSync(testBmp2, path.join(framesDir, 'frame_02.bmp'));

        const result = await service.runGlomapReconstruction({
            imageDir: framesDir,
            outputDir: glomapOutDir,
            fov: 55.0
        });

        expect(result.success).toBe(true);
        expect(result.sparseDir).toBeDefined();
        expect(fs.existsSync(path.join(result.sparseDir!, 'cameras.txt'))).toBe(true);
        expect(fs.existsSync(path.join(result.sparseDir!, 'images.txt'))).toBe(true);
        expect(fs.existsSync(path.join(result.sparseDir!, 'points3D.txt'))).toBe(true);

        if (result.glbPath) {
            expect(fs.existsSync(result.glbPath)).toBe(true);
            const glbBuffer = fs.readFileSync(result.glbPath);
            expect(glbBuffer.toString('utf8', 0, 4)).toBe('glTF');
        }
    });
});
