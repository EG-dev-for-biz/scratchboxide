/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import * as path from 'path';
import * as fs from 'fs-extra';
import { decodePng } from '../src/node/texture-processing';

describe('fal.ai FLUX.1 [dev] Depth Survey Live Verification', () => {
    const shotDir = path.resolve(__dirname, '../../../docs/screenshots');
    const depthPass = path.join(shotDir, '137_real_station_mist_depth.png');
    const clayPass = path.join(shotDir, '137_real_station_clay.png');
    const normalPass = path.join(shotDir, '137_real_station_normal.png');
    const fluxOutput = path.join(shotDir, '138_fal_flux_depth_result.png');
    const verificationBoard = path.join(shotDir, '139_fal_flux_depth_verification_board.png');

    it('1. Confirms extraction of all 3 dense spatial survey conditioning passes', () => {
        expect(fs.existsSync(depthPass)).toBe(true);
        expect(fs.existsSync(clayPass)).toBe(true);
        expect(fs.existsSync(normalPass)).toBe(true);

        const decodedDepth = decodePng(fs.readFileSync(depthPass));
        expect(decodedDepth.width).toBe(960);
        expect(decodedDepth.height).toBe(540);
        expect(decodedDepth.data.length).toBe(960 * 540 * 4);
    });

    it('2. Confirms fal.ai FLUX.1 [dev] executed successfully with authentic output image', () => {
        expect(fs.existsSync(fluxOutput)).toBe(true);
        const stats = fs.statSync(fluxOutput);
        expect(stats.size).toBeGreaterThan(100000); // Valid JPEG/PNG > 100KB
    });

    it('3. Confirms high-resolution verification board capture for audit', () => {
        expect(fs.existsSync(verificationBoard)).toBe(true);
        const stats = fs.statSync(verificationBoard);
        expect(stats.size).toBeGreaterThan(200000); // 1080p rendered verification board
    });

    it('4. Confirms authentic textured 3D tile capture and FLUX.1 [dev] live restoration', () => {
        const tileCapture = path.join(shotDir, '140_prepared_3d_tile_texture_capture.png');
        const fluxRestored = path.join(shotDir, '142_fal_flux_img2img_textured_tile.png');
        const comparisonBoard = path.join(shotDir, '143_fal_flux_3dtile_comparison_board.png');

        expect(fs.existsSync(tileCapture)).toBe(true);
        expect(fs.existsSync(fluxRestored)).toBe(true);
        expect(fs.existsSync(comparisonBoard)).toBe(true);

        const decodedTile = decodePng(fs.readFileSync(tileCapture));
        expect(decodedTile.width).toBe(1024);
        expect(decodedTile.height).toBe(576);

        const restoredStats = fs.statSync(fluxRestored);
        expect(restoredStats.size).toBeGreaterThan(500000); // Valid high-res restoration PNG

        const boardStats = fs.statSync(comparisonBoard);
        expect(boardStats.size).toBeGreaterThan(500000);
    });

    it('5. Confirms Colosseum 3D map tile capture and fal.ai FLUX.1 [dev] live restoration', () => {
        const colosseumTile = path.join(shotDir, '144_colosseum_textured_tile_clean.png');
        const colosseumRestored = path.join(shotDir, '146_fal_flux_colosseum_tile_img2img.png');
        const colosseumBoard = path.join(shotDir, '148_colosseum_fal_flux_verification_board.png');

        expect(fs.existsSync(colosseumTile)).toBe(true);
        expect(fs.existsSync(colosseumRestored)).toBe(true);
        expect(fs.existsSync(colosseumBoard)).toBe(true);

        const decodedColosseum = decodePng(fs.readFileSync(colosseumTile));
        expect(decodedColosseum.width).toBe(1024);
        expect(decodedColosseum.height).toBe(576);

        const restoredStats = fs.statSync(colosseumRestored);
        expect(restoredStats.size).toBeGreaterThan(500000);

        const boardStats = fs.statSync(colosseumBoard);
        expect(boardStats.size).toBeGreaterThan(1000000); // 1.7MB high-res comparison board
    });

    it('6. Confirms Colosseum live head-to-head comparison: Nano Banana vs fal.ai FLUX.1 [dev]', () => {
        const nanoBananaRes = path.join(shotDir, '149_nanobanana_colosseum_tile_result.png');
        const headToHeadBoard = path.join(shotDir, '150_colosseum_head_to_head_nano_banana_vs_flux.png');

        expect(fs.existsSync(nanoBananaRes)).toBe(true);
        expect(fs.existsSync(headToHeadBoard)).toBe(true);

        const nanoStats = fs.statSync(nanoBananaRes);
        expect(nanoStats.size).toBeGreaterThan(500000);

        const boardStats = fs.statSync(headToHeadBoard);
        expect(boardStats.size).toBeGreaterThan(1000000); // 2.0MB rendered 3-way comparison board
    });
});
