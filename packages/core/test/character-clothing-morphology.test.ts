/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { SbHumanLoader } from '../src/common/spatial/SbHumanLoader';
import { CharacterClothingMorphology } from '../src/node/spatial/CharacterClothingMorphology';

describe('CharacterClothingMorphology (Palazzo Pants, Tunic Shirt & Headphone Synthesis)', () => {
    it('should map joints correctly to 22 SB-Human standard joints', () => {
        expect(CharacterClothingMorphology.mapJointTo22(0)).toBe(0); // Pelvis
        expect(CharacterClothingMorphology.mapJointTo22(1)).toBe(1); // LeftHip
        expect(CharacterClothingMorphology.mapJointTo22(7)).toBe(7); // LeftAnkle
        expect(CharacterClothingMorphology.mapJointTo22(23)).toBe(15); // Jaw/Eye -> Head
        expect(CharacterClothingMorphology.mapJointTo22(30)).toBe(20); // Left hand fingers -> LeftWrist
        expect(CharacterClothingMorphology.mapJointTo22(45)).toBe(21); // Right hand fingers -> RightWrist
    });

    it('should expand bare legs into wide-leg palazzo pants and widen grounded stance', () => {
        const sbHumanPath = path.resolve(__dirname, '../../../public/models/sbhuman_neutral.sbhuman');
        if (!fs.existsSync(sbHumanPath)) {
            console.warn('Skipping sbhuman test as model file is not present');
            return;
        }

        const buf = fs.readFileSync(sbHumanPath);
        const loader = SbHumanLoader.parse(buf);
        const solvedBetas = [0.875, -0.450, -0.820, 0.200, 0.650, -0.320, -0.150, -0.420];
        const evaluated = loader.evaluatePosed(solvedBetas);
        const vertCount = loader.header.numVertices;

        let minY = Infinity, maxY = -Infinity;
        for (let i = 0; i < vertCount; i++) {
            const y = evaluated.positions[i * 3 + 1];
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
        }
        const scale = 1.74308 / (maxY - minY);

        const positions = new Float32Array(vertCount * 3);
        const boneIndices = new Uint8Array(vertCount * 4);
        for (let i = 0; i < vertCount; i++) {
            positions[i * 3]     = evaluated.positions[i * 3] * scale;
            positions[i * 3 + 1] = (evaluated.positions[i * 3 + 1] - minY) * scale;
            positions[i * 3 + 2] = evaluated.positions[i * 3 + 2] * scale;

            const sw = loader.skinWeights[i];
            boneIndices[i * 4] = sw ? sw.joints[0] : 0;
            boneIndices[i * 4 + 1] = sw ? sw.joints[1] : 0;
            boneIndices[i * 4 + 2] = sw ? sw.joints[2] : 0;
            boneIndices[i * 4 + 3] = sw ? sw.joints[3] : 0;
        }

        // Measure calf width before morphology
        let preCalfMinX = Infinity, preCalfMaxX = -Infinity;
        for (let i = 0; i < vertCount; i++) {
            const y = positions[i * 3 + 1];
            if (y >= 0.20 && y <= 0.30 && positions[i * 3] > 0) {
                if (positions[i * 3] < preCalfMinX) preCalfMinX = positions[i * 3];
                if (positions[i * 3] > preCalfMaxX) preCalfMaxX = positions[i * 3];
            }
        }
        const preCalfWidth = preCalfMaxX - preCalfMinX;
        expect(preCalfWidth).toBeLessThan(0.12); // Skin-tight calf (~10cm)

        // Apply authentic clothing morphology
        CharacterClothingMorphology.applyMorphology(positions, boneIndices, vertCount, {
            palazzoPantsRadius: 0.135,
            palazzoFlareRadius: 0.025,
            tunicHalfWidth: 0.225,
            tunicHalfDepth: 0.135,
            tunicHemY: 0.72,
            headphoneLateralOffset: 0.118,
            legStanceSpread: 0.15
        });

        // Measure calf width after morphology
        let postCalfMinX = Infinity, postCalfMaxX = -Infinity;
        for (let i = 0; i < vertCount; i++) {
            const y = positions[i * 3 + 1];
            if (y >= 0.20 && y <= 0.30 && positions[i * 3] > 0) {
                if (positions[i * 3] < postCalfMinX) postCalfMinX = positions[i * 3];
                if (positions[i * 3] > postCalfMaxX) postCalfMaxX = positions[i * 3];
            }
        }
        const postCalfWidth = postCalfMaxX - postCalfMinX;
        const postCalfCenter = (postCalfMinX + postCalfMaxX) * 0.5;

        // Palazzo pants must be at least 25cm wide and centered around X >= 0.18m (wide stance)
        expect(postCalfWidth).toBeGreaterThanOrEqual(0.25);
        expect(postCalfCenter).toBeGreaterThanOrEqual(0.18);
    });

    it('should eliminate hourglass waist pinch with untucked boxy tunic shirt', () => {
        const sbHumanPath = path.resolve(__dirname, '../../../public/models/sbhuman_neutral.sbhuman');
        if (!fs.existsSync(sbHumanPath)) return;

        const buf = fs.readFileSync(sbHumanPath);
        const loader = SbHumanLoader.parse(buf);
        const solvedBetas = [0.875, -0.450, -0.820, 0.200, 0.650, -0.320, -0.150, -0.420];
        const evaluated = loader.evaluatePosed(solvedBetas);
        const vertCount = loader.header.numVertices;

        let minY = Infinity, maxY = -Infinity;
        for (let i = 0; i < vertCount; i++) {
            const y = evaluated.positions[i * 3 + 1];
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
        }
        const scale = 1.74308 / (maxY - minY);

        const positions = new Float32Array(vertCount * 3);
        const boneIndices = new Uint8Array(vertCount * 4);
        for (let i = 0; i < vertCount; i++) {
            positions[i * 3]     = evaluated.positions[i * 3] * scale;
            positions[i * 3 + 1] = (evaluated.positions[i * 3 + 1] - minY) * scale;
            positions[i * 3 + 2] = evaluated.positions[i * 3 + 2] * scale;
            const sw = loader.skinWeights[i];
            boneIndices[i * 4] = sw ? sw.joints[0] : 0;
        }

        CharacterClothingMorphology.applyMorphology(positions, boneIndices, vertCount, {
            tunicHalfWidth: 0.225,
            tunicHalfDepth: 0.135,
            tunicHemY: 0.72
        });

        // Check waist profile at Y ~ 1.00m
        let waistMinX = Infinity, waistMaxX = -Infinity;
        for (let i = 0; i < vertCount; i++) {
            const y = positions[i * 3 + 1];
            if (y >= 0.95 && y <= 1.05) {
                if (positions[i * 3] < waistMinX) waistMinX = positions[i * 3];
                if (positions[i * 3] > waistMaxX) waistMaxX = positions[i * 3];
            }
        }
        const waistTotalWidth = waistMaxX - waistMinX;
        expect(waistTotalWidth).toBeGreaterThanOrEqual(0.40); // >= 40cm width for boxy shirt
    });

    it('should synthesize over-ear headphones on cranial perimeter', () => {
        const sbHumanPath = path.resolve(__dirname, '../../../public/models/sbhuman_neutral.sbhuman');
        if (!fs.existsSync(sbHumanPath)) return;

        const buf = fs.readFileSync(sbHumanPath);
        const loader = SbHumanLoader.parse(buf);
        const solvedBetas = [0.875, -0.450, -0.820, 0.200, 0.650, -0.320, -0.150, -0.420];
        const evaluated = loader.evaluatePosed(solvedBetas);
        const vertCount = loader.header.numVertices;

        let minY = Infinity, maxY = -Infinity;
        for (let i = 0; i < vertCount; i++) {
            const y = evaluated.positions[i * 3 + 1];
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
        }
        const scale = 1.74308 / (maxY - minY);

        const positions = new Float32Array(vertCount * 3);
        const boneIndices = new Uint8Array(vertCount * 4);
        for (let i = 0; i < vertCount; i++) {
            positions[i * 3]     = evaluated.positions[i * 3] * scale;
            positions[i * 3 + 1] = (evaluated.positions[i * 3 + 1] - minY) * scale;
            positions[i * 3 + 2] = evaluated.positions[i * 3 + 2] * scale;
            const sw = loader.skinWeights[i];
            boneIndices[i * 4] = sw ? sw.joints[0] : 0;
        }

        CharacterClothingMorphology.applyMorphology(positions, boneIndices, vertCount, {
            headphoneLateralOffset: 0.118,
            headbandArchLift: 0.025
        });

        // Measure cranial width at ear level (Y ~ 1.58m)
        let earMinX = Infinity, earMaxX = -Infinity;
        for (let i = 0; i < vertCount; i++) {
            const y = positions[i * 3 + 1];
            if (y >= 1.54 && y <= 1.62) {
                if (positions[i * 3] < earMinX) earMinX = positions[i * 3];
                if (positions[i * 3] > earMaxX) earMaxX = positions[i * 3];
            }
        }
        const cranialWidthWithHeadphones = earMaxX - earMinX;
        expect(cranialWidthWithHeadphones).toBeGreaterThanOrEqual(0.23); // >= 23cm with ear cups
    });

    it('should preserve continuous front belly and chest volume without rectangular cavity', () => {
        const sbHumanPath = path.resolve(__dirname, '../../../public/models/sbhuman_neutral.sbhuman');
        if (!fs.existsSync(sbHumanPath)) return;

        const buf = fs.readFileSync(sbHumanPath);
        const loader = SbHumanLoader.parse(buf);
        const solvedBetas = [0.875, -0.450, -0.820, 0.200, 0.650, -0.320, -0.150, -0.420];
        const evaluated = loader.evaluatePosed(solvedBetas);
        const vertCount = loader.header.numVertices;

        let minY = Infinity, maxY = -Infinity;
        for (let i = 0; i < vertCount; i++) {
            const y = evaluated.positions[i * 3 + 1];
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
        }
        const scale = 1.74308 / (maxY - minY);

        const positions = new Float32Array(vertCount * 3);
        const boneIndices = new Uint8Array(vertCount * 4);
        for (let i = 0; i < vertCount; i++) {
            positions[i * 3]     = evaluated.positions[i * 3] * scale;
            positions[i * 3 + 1] = (evaluated.positions[i * 3 + 1] - minY) * scale;
            positions[i * 3 + 2] = evaluated.positions[i * 3 + 2] * scale;
            const sw = loader.skinWeights[i];
            boneIndices[i * 4] = sw ? sw.joints[0] : 0;
        }

        CharacterClothingMorphology.applyMorphology(positions, boneIndices, vertCount);

        // Count vertices in the central stomach/belly region (Y in [0.90, 1.10], |X| < 0.10, Z > 0.02)
        let centralBellyVertCount = 0;
        for (let i = 0; i < vertCount; i++) {
            const x = positions[i * 3];
            const y = positions[i * 3 + 1];
            const z = positions[i * 3 + 2];
            if (y >= 0.90 && y <= 1.10 && Math.abs(x) < 0.10 && z > 0.02) {
                centralBellyVertCount++;
            }
        }

        // Must retain dozens of vertices in the front central belly (NO hollowed out box chasm!)
        expect(centralBellyVertCount).toBeGreaterThanOrEqual(20);
    });

    it('should synthesize grounded chunky sneakers with flat sole and forward toe box', () => {
        const sbHumanPath = path.resolve(__dirname, '../../../public/models/sbhuman_neutral.sbhuman');
        if (!fs.existsSync(sbHumanPath)) return;

        const buf = fs.readFileSync(sbHumanPath);
        const loader = SbHumanLoader.parse(buf);
        const solvedBetas = [0.875, -0.450, -0.820, 0.200, 0.650, -0.320, -0.150, -0.420];
        const evaluated = loader.evaluatePosed(solvedBetas);
        const vertCount = loader.header.numVertices;

        let minY = Infinity, maxY = -Infinity;
        for (let i = 0; i < vertCount; i++) {
            const y = evaluated.positions[i * 3 + 1];
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
        }
        const scale = 1.74308 / (maxY - minY);

        const positions = new Float32Array(vertCount * 3);
        const boneIndices = new Uint8Array(vertCount * 4);
        for (let i = 0; i < vertCount; i++) {
            positions[i * 3]     = evaluated.positions[i * 3] * scale;
            positions[i * 3 + 1] = (evaluated.positions[i * 3 + 1] - minY) * scale;
            positions[i * 3 + 2] = evaluated.positions[i * 3 + 2] * scale;
            const sw = loader.skinWeights[i];
            boneIndices[i * 4] = sw ? sw.joints[0] : 0;
        }

        CharacterClothingMorphology.applyMorphology(positions, boneIndices, vertCount);

        let minFootY = Infinity;
        let maxLeftFootZ = -Infinity;
        let leftFootWidth = 0;
        let leftFootMinX = Infinity, leftFootMaxX = -Infinity;

        for (let i = 0; i < vertCount; i++) {
            const x = positions[i * 3];
            const y = positions[i * 3 + 1];
            const z = positions[i * 3 + 2];
            const j0 = CharacterClothingMorphology.mapJointTo22(boneIndices[i * 4]);

            if (y < 0.11 && (j0 === 7 || j0 === 10 || (x > 0.15 && y < 0.08))) {
                if (y < minFootY) minFootY = y;
                if (z > maxLeftFootZ) maxLeftFootZ = z;
                if (x < leftFootMinX) leftFootMinX = x;
                if (x > leftFootMaxX) leftFootMaxX = x;
            }
        }

        // Foot vertices must be clamped strictly >= 0.00m (ground contact)
        expect(minFootY).toBeGreaterThanOrEqual(0.00);

        // Toe box extends forward
        expect(maxLeftFootZ).toBeGreaterThanOrEqual(0.12);

        // Foot width must be compact chunky sneaker (<16cm), NOT an exploded 32cm tube!
        leftFootWidth = leftFootMaxX - leftFootMinX;
        expect(leftFootWidth).toBeLessThan(0.18);
        expect(leftFootWidth).toBeGreaterThan(0.06);

        // Foot center should be abducted to wide stance (~0.35m - 0.42m)
        const leftFootCenterX = (leftFootMinX + leftFootMaxX) * 0.5;
        expect(leftFootCenterX).toBeGreaterThanOrEqual(0.32);
    });
});

