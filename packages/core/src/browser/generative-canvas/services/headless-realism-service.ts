/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as THREE from 'three';

// ============================================================================
// Types & Mathematical Interfaces
// ============================================================================

export interface CurvatureMetrics {
    k1: number[];
    k2: number[];
    meanCurvature: number[];
    gaussianCurvature: number[];
    shapeIndex: number[];
    curvedness: number[];
}

export interface HeadlessWearOptions {
    convexitySensitivity?: number;     // Amplifies edge wear (S > 0)
    concavityOcclusionWeight?: number; // Amplifies crevice grime (S < 0)
    microNoiseScale?: number;          // Spatial frequency of micro-chipping
    wearExposure?: number;              // Continuous bias [-1.0, 1.0]
    layerTransitionSharpness?: number;  // Sigmoid sharpness
    primerThreshold?: number;          // Topcoat -> Primer boundary
    substrateThreshold?: number;       // Primer -> Substrate metal boundary
    topcoatAlbedo?: [number, number, number, number];
    primerAlbedo?: [number, number, number, number];
    substrateAlbedo?: [number, number, number, number];
    topcoatRoughness?: number;
    primerRoughness?: number;
    substrateRoughness?: number;
    topcoatMetallic?: number;
    substrateMetallic?: number;
}

export interface WeightedNormalOptions {
    areaWeightPower?: number;        // Exponent on face area (default 1.0)
    angleWeightPower?: number;       // Exponent on corner angle (default 1.0)
    thresholdAngleDeg?: number;     // Dihedral cutoff for sharp edges (default 45)
    keepSharpEdges?: boolean;
}

export interface GeomorphologyErosionOptions {
    iterations?: number;
    erodibility?: number;           // Stream power K constant
    diffusionRate?: number;         // Laplacian diffusion
    talusReposeAngleDeg?: number;    // Scree repose angle (default 35)
    talusDiffusionRate?: number;     // Scree relaxation rate
}

export interface CanopyTransferOptions {
    proxyCenter?: [number, number, number];
    proxyRadii?: [number, number, number];
    blendFactor?: number;
    skyHemisphereBias?: number;
}

export interface ThinFilmOptions {
    thicknessNm?: number;
    nMedium?: number;
    nFilm?: number;
    nSubstrate?: number;
}

// ============================================================================
// 1. Headless Curvature Operator
// ============================================================================

export function estimateDifferentialCurvature(geometry: THREE.BufferGeometry): CurvatureMetrics {
    const posAttr = geometry.getAttribute('position') as THREE.BufferAttribute;
    const normAttr = geometry.getAttribute('normal') as THREE.BufferAttribute;
    const vertexCount = posAttr ? posAttr.count : 0;

    const metrics: CurvatureMetrics = {
        k1: new Array(vertexCount).fill(0),
        k2: new Array(vertexCount).fill(0),
        meanCurvature: new Array(vertexCount).fill(0),
        gaussianCurvature: new Array(vertexCount).fill(0),
        shapeIndex: new Array(vertexCount).fill(0),
        curvedness: new Array(vertexCount).fill(0)
    };

    if (vertexCount === 0) return metrics;

    const indices = geometry.index ? Array.from(geometry.index.array) : [];
    if (indices.length === 0) {
        // Fallback: estimate from consecutive triangles
        for (let i = 0; i < vertexCount; i++) indices.push(i);
    }

    // Build adjacency list
    const adj: Set<number>[] = Array.from({ length: vertexCount }, () => new Set<number>());
    for (let i = 0; i + 2 < indices.length; i += 3) {
        const i0 = indices[i];
        const i1 = indices[i + 1];
        const i2 = indices[i + 2];
        adj[i0].add(i1); adj[i0].add(i2);
        adj[i1].add(i0); adj[i1].add(i2);
        adj[i2].add(i0); adj[i2].add(i1);
    }

    const pI = new THREE.Vector3();
    const nI = new THREE.Vector3();
    const pNbr = new THREE.Vector3();
    const edge = new THREE.Vector3();

    for (let i = 0; i < vertexCount; i++) {
        pI.fromBufferAttribute(posAttr, i);
        if (normAttr) {
            nI.fromBufferAttribute(normAttr, i);
        } else {
            nI.set(0, 1, 0);
        }

        let minKappa = 1e8;
        let maxKappa = -1e8;
        let count = 0;

        for (const nbr of adj[i]) {
            pNbr.fromBufferAttribute(posAttr, nbr);
            edge.subVectors(pNbr, pI);
            const distSq = edge.lengthSq();
            if (distSq < 1e-10) continue;

            const kappa = (2.0 * edge.dot(nI)) / distSq;
            minKappa = Math.min(minKappa, kappa);
            maxKappa = Math.max(maxKappa, kappa);
            count++;
        }

        if (count > 0) {
            const k1 = maxKappa;
            const k2 = minKappa;
            const H = 0.5 * (k1 + k2);
            const K = k1 * k2;
            const diff = k1 - k2;
            let S = 0;
            if (Math.abs(diff) > 1e-6) {
                S = (2.0 / Math.PI) * Math.atan((k1 + k2) / diff);
            }
            const C = Math.sqrt(0.5 * (k1 * k1 + k2 * k2));

            metrics.k1[i] = k1;
            metrics.k2[i] = k2;
            metrics.meanCurvature[i] = H;
            metrics.gaussianCurvature[i] = K;
            metrics.shapeIndex[i] = Math.max(-1.0, Math.min(1.0, S));
            metrics.curvedness[i] = C;
        }
    }

    return metrics;
}

// ============================================================================
// 2. Headless Stratified Wear Operator
// ============================================================================

export function computeStratifiedWear(
    geometry: THREE.BufferGeometry,
    options: HeadlessWearOptions = {}
): { wearExposures: Float32Array; averageWear: number } {
    const posAttr = geometry.getAttribute('position') as THREE.BufferAttribute;
    const vertexCount = posAttr ? posAttr.count : 0;
    const wearExposures = new Float32Array(vertexCount);
    if (vertexCount === 0) return { wearExposures, averageWear: 0 };

    const curvature = estimateDifferentialCurvature(geometry);
    const convSens = options.convexitySensitivity ?? 1.8;
    const noiseScale = options.microNoiseScale ?? 32.0;
    const exposure = options.wearExposure ?? 0.0;
    const sharpness = options.layerTransitionSharpness ?? 8.0;

    const topAlbedo = options.topcoatAlbedo ?? [0.15, 0.45, 0.85, 1.0];
    const primerAlbedo = options.primerAlbedo ?? [0.65, 0.62, 0.58, 1.0];
    const subAlbedo = options.substrateAlbedo ?? [0.88, 0.88, 0.90, 1.0];

    const colors = new Float32Array(vertexCount * 4);
    let totalWear = 0;
    const p = new THREE.Vector3();

    for (let i = 0; i < vertexCount; i++) {
        p.fromBufferAttribute(posAttr, i);
        const S = curvature.shapeIndex[i];

        // Micro-chipping noise
        const nx = Math.sin(p.x * noiseScale * 1.3);
        const ny = Math.cos(p.y * noiseScale * 1.7);
        const nz = Math.sin(p.z * noiseScale * 2.1);
        const microNoise = (nx + ny + nz) / 3.0;

        const convexity = Math.max(0, S);
        const rawWear = convexity * convSens + microNoise * 0.4 + exposure;
        const w = 1.0 / (1.0 + Math.exp(-sharpness * (rawWear - 0.5)));
        const wear = Math.max(0.0, Math.min(1.0, w));
        wearExposures[i] = wear;
        totalWear += wear;

        // Substratum color blending
        let r: number, g: number, b: number, a: number;
        const primerThresh = options.primerThreshold ?? 0.35;
        if (wear < primerThresh) {
            const t = wear / Math.max(1e-4, primerThresh);
            r = topAlbedo[0] * (1 - t) + primerAlbedo[0] * t;
            g = topAlbedo[1] * (1 - t) + primerAlbedo[1] * t;
            b = topAlbedo[2] * (1 - t) + primerAlbedo[2] * t;
            a = topAlbedo[3] * (1 - t) + primerAlbedo[3] * t;
        } else {
            const t = Math.min(1.0, (wear - primerThresh) / Math.max(1e-4, 1.0 - primerThresh));
            r = primerAlbedo[0] * (1 - t) + subAlbedo[0] * t;
            g = primerAlbedo[1] * (1 - t) + subAlbedo[1] * t;
            b = primerAlbedo[2] * (1 - t) + subAlbedo[2] * t;
            a = primerAlbedo[3] * (1 - t) + subAlbedo[3] * t;
        }

        const idx = i * 4;
        colors[idx] = r;
        colors[idx + 1] = g;
        colors[idx + 2] = b;
        colors[idx + 3] = a;
    }

    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 4));
    geometry.attributes.color.needsUpdate = true;

    return {
        wearExposures,
        averageWear: totalWear / vertexCount
    };
}

// ============================================================================
// 3. Headless Weighted Normal Modifier
// ============================================================================

export function applyWeightedNormals(
    geometry: THREE.BufferGeometry,
    options: WeightedNormalOptions = {}
): void {
    const posAttr = geometry.getAttribute('position') as THREE.BufferAttribute;
    if (!posAttr) return;
    const vertexCount = posAttr.count;

    const indices = geometry.index ? Array.from(geometry.index.array) : [];
    if (indices.length < 3) return;

    const areaPower = options.areaWeightPower ?? 1.0;
    const anglePower = options.angleWeightPower ?? 1.0;
    const threshDeg = options.thresholdAngleDeg ?? 45.0;
    const keepSharp = options.keepSharpEdges ?? true;
    const threshCos = Math.cos((threshDeg * Math.PI) / 180.0);

    const numFaces = Math.floor(indices.length / 3);
    const faceNormals: THREE.Vector3[] = new Array(numFaces);
    const faceAreas: number[] = new Array(numFaces);

    const p0 = new THREE.Vector3();
    const p1 = new THREE.Vector3();
    const p2 = new THREE.Vector3();
    const e1 = new THREE.Vector3();
    const e2 = new THREE.Vector3();
    const cp = new THREE.Vector3();

    for (let f = 0; f < numFaces; f++) {
        p0.fromBufferAttribute(posAttr, indices[f * 3]);
        p1.fromBufferAttribute(posAttr, indices[f * 3 + 1]);
        p2.fromBufferAttribute(posAttr, indices[f * 3 + 2]);

        e1.subVectors(p1, p0);
        e2.subVectors(p2, p0);
        cp.crossVectors(e1, e2);
        const len = cp.length();

        faceAreas[f] = 0.5 * len;
        faceNormals[f] = len > 1e-8 ? cp.clone().multiplyScalar(1.0 / len) : new THREE.Vector3(0, 1, 0);
    }

    const vertFaces: number[][] = Array.from({ length: vertexCount }, () => []);
    for (let f = 0; f < numFaces; f++) {
        vertFaces[indices[f * 3]].push(f);
        vertFaces[indices[f * 3 + 1]].push(f);
        vertFaces[indices[f * 3 + 2]].push(f);
    }

    const normAttr = geometry.getAttribute('normal') as THREE.BufferAttribute;
    const newNormals = new Float32Array(vertexCount * 3);
    const origNorm = new THREE.Vector3();
    const accum = new THREE.Vector3();
    const pV = new THREE.Vector3();
    const oA = new THREE.Vector3();
    const oB = new THREE.Vector3();
    const vA = new THREE.Vector3();
    const vB = new THREE.Vector3();

    for (let v = 0; v < vertexCount; v++) {
        const faces = vertFaces[v];
        if (faces.length === 0) continue;

        if (normAttr) origNorm.fromBufferAttribute(normAttr, v);
        else origNorm.set(0, 1, 0);

        accum.set(0, 0, 0);
        pV.fromBufferAttribute(posAttr, v);

        for (const f of faces) {
            const fNorm = faceNormals[f];
            if (keepSharp && origNorm.dot(fNorm) < threshCos) continue;

            const i0 = indices[f * 3];
            const i1 = indices[f * 3 + 1];
            const i2 = indices[f * 3 + 2];

            const aIdx = (i0 === v) ? i1 : ((i1 === v) ? i0 : i0);
            const bIdx = (i2 === v) ? i1 : ((i1 === v) ? i2 : i2);

            oA.fromBufferAttribute(posAttr, aIdx);
            oB.fromBufferAttribute(posAttr, bIdx);

            vA.subVectors(oA, pV).normalize();
            vB.subVectors(oB, pV).normalize();
            const cornerAngle = Math.acos(Math.max(-1.0, Math.min(1.0, vA.dot(vB))));

            const weight = Math.pow(Math.max(1e-6, faceAreas[f]), areaPower) *
                           Math.pow(Math.max(1e-6, cornerAngle), anglePower);

            accum.addScaledVector(fNorm, weight);
        }

        if (accum.lengthSq() > 1e-8) accum.normalize();
        else accum.copy(origNorm);

        const idx = v * 3;
        newNormals[idx] = accum.x;
        newNormals[idx + 1] = accum.y;
        newNormals[idx + 2] = accum.z;
    }

    geometry.setAttribute('normal', new THREE.BufferAttribute(newNormals, 3));
    geometry.attributes.normal.needsUpdate = true;
}

// ============================================================================
// 4. Headless Geomorphological PDE Solver
// ============================================================================

export function simulateGeomorphologyOnGeometry(
    geometry: THREE.BufferGeometry,
    options: GeomorphologyErosionOptions = {}
): void {
    const posAttr = geometry.getAttribute('position') as THREE.BufferAttribute;
    if (!posAttr) return;

    const iterations = options.iterations ?? 10;
    const erodibility = options.erodibility ?? 0.08;
    const diffRate = options.diffusionRate ?? 0.015;
    const reposeAngle = options.talusReposeAngleDeg ?? 35.0;
    const tanRepose = Math.tan((reposeAngle * Math.PI) / 180.0);
    const talusRate = options.talusDiffusionRate ?? 0.05;

    const vertexCount = posAttr.count;
    const heights = new Float32Array(vertexCount);
    for (let i = 0; i < vertexCount; i++) heights[i] = posAttr.getY(i);

    const indices = geometry.index ? Array.from(geometry.index.array) : [];
    const adj: Set<number>[] = Array.from({ length: vertexCount }, () => new Set<number>());
    for (let i = 0; i + 2 < indices.length; i += 3) {
        adj[indices[i]].add(indices[i + 1]);
        adj[indices[i + 1]].add(indices[i + 2]);
        adj[indices[i + 2]].add(indices[i]);
    }

    const pI = new THREE.Vector3();
    const pNbr = new THREE.Vector3();

    for (let iter = 0; iter < iterations; iter++) {
        for (let i = 0; i < vertexCount; i++) {
            const neighbors = adj[i];
            if (neighbors.size === 0) continue;

            pI.fromBufferAttribute(posAttr, i);
            let avgNbrHeight = 0;
            let maxSlope = 0;

            for (const nbr of neighbors) {
                pNbr.fromBufferAttribute(posAttr, nbr);
                avgNbrHeight += heights[nbr];
                const dx = Math.hypot(pNbr.x - pI.x, pNbr.z - pI.z);
                if (dx > 1e-4) {
                    const slope = (heights[i] - heights[nbr]) / dx;
                    maxSlope = Math.max(maxSlope, slope);
                }
            }

            avgNbrHeight /= neighbors.size;
            const laplacian = avgNbrHeight - heights[i];

            // Stream power erosion
            const erosion = erodibility * Math.max(0, maxSlope);
            // Laplacian diffusion
            const diffusion = diffRate * laplacian;
            // Talus scree relaxation
            const screeExcess = Math.max(0, maxSlope - tanRepose);
            const scree = -talusRate * screeExcess;

            heights[i] += (-erosion + diffusion + scree);
        }
    }

    for (let i = 0; i < vertexCount; i++) posAttr.setY(i, heights[i]);
    posAttr.needsUpdate = true;
    geometry.computeVertexNormals();
}

// ============================================================================
// 5. Headless Canopy Normal Transfer Operator
// ============================================================================

export function transferCanopyNormals(
    geometry: THREE.BufferGeometry,
    options: CanopyTransferOptions = {}
): void {
    const posAttr = geometry.getAttribute('position') as THREE.BufferAttribute;
    const normAttr = geometry.getAttribute('normal') as THREE.BufferAttribute;
    if (!posAttr || !normAttr) return;

    const center = new THREE.Vector3(...(options.proxyCenter ?? [0, 2, 0]));
    const radii = new THREE.Vector3(...(options.proxyRadii ?? [1.5, 2.0, 1.5]));
    const blend = options.blendFactor ?? 0.85;
    const skyBias = options.skyHemisphereBias ?? 0.25;

    const p = new THREE.Vector3();
    const n = new THREE.Vector3();
    const proxyNorm = new THREE.Vector3();

    for (let i = 0; i < posAttr.count; i++) {
        p.fromBufferAttribute(posAttr, i);
        n.fromBufferAttribute(normAttr, i);

        proxyNorm.set(
            (p.x - center.x) / Math.max(1e-4, radii.x),
            (p.y - center.y) / Math.max(1e-4, radii.y),
            (p.z - center.z) / Math.max(1e-4, radii.z)
        );

        if (proxyNorm.lengthSq() < 1e-6) proxyNorm.set(0, 1, 0);
        else proxyNorm.normalize();

        proxyNorm.y += skyBias;
        proxyNorm.normalize();

        n.lerp(proxyNorm, blend).normalize();
        normAttr.setXYZ(i, n.x, n.y, n.z);
    }

    normAttr.needsUpdate = true;
}

// ============================================================================
// 6. Headless Wave Optics Airy Solver
// ============================================================================

export function evaluateAiryThinFilm(
    thicknessNm: number,
    cosThetaI: number,
    nFilm: number = 1.33,
    nSubstrate: number = 1.50,
    nMedium: number = 1.0
): [number, number, number] {
    const sinThetaI = Math.sqrt(Math.max(0, 1.0 - cosThetaI * cosThetaI));
    const sinThetaT = (nMedium / nFilm) * sinThetaI;
    if (sinThetaT >= 1.0) return [1.0, 1.0, 1.0];

    const cosThetaT = Math.sqrt(Math.max(0, 1.0 - sinThetaT * sinThetaT));
    const opd = 2.0 * nFilm * thicknessNm * cosThetaT;

    const r12 = (nMedium - nFilm) / (nMedium + nFilm);
    const r23 = (nFilm - nSubstrate) / (nFilm + nSubstrate);

    const calcR = (lambdaNm: number) => {
        let phase = (2.0 * Math.PI * opd) / lambdaNm;
        if (nMedium < nFilm) phase += Math.PI;
        if (nFilm < nSubstrate) phase += Math.PI;

        const cosD = Math.cos(phase);
        const num = r12 * r12 + r23 * r23 + 2.0 * r12 * r23 * cosD;
        const den = 1.0 + r12 * r12 * r23 * r23 + 2.0 * r12 * r23 * cosD;
        return Math.max(0, Math.min(1.0, num / Math.max(1e-6, den)));
    };

    return [calcR(650), calcR(532), calcR(450)];
}

// ============================================================================
// 7. Headless Photometric Radiance Solver
// ============================================================================

export function blackbodyKelvinToLinearRgb(kelvin: number): [number, number, number] {
    const temp = Math.max(1000, Math.min(25000, kelvin)) / 100.0;
    let r: number, g: number, b: number;

    if (temp <= 66.0) {
        r = 1.0;
        g = Math.max(0, Math.min(1.0, (99.4708025861 * Math.log(temp) - 161.1195681661) / 255.0));
    } else {
        r = Math.max(0, Math.min(1.0, 329.698727446 * Math.pow(temp - 60.0, -0.1332047592) / 255.0));
        g = Math.max(0, Math.min(1.0, 288.1221695283 * Math.pow(temp - 60.0, -0.0755148492) / 255.0));
    }

    if (temp >= 66.0) {
        b = 1.0;
    } else if (temp <= 19.0) {
        b = 0.0;
    } else {
        b = Math.max(0, Math.min(1.0, (138.5177312231 * Math.log(temp - 10.0) - 305.0447927307) / 255.0));
    }

    const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
    return [srgbToLinear(r), srgbToLinear(g), srgbToLinear(b)];
}

export function evaluateAnalyticalGobo(
    u: number,
    v: number,
    timeSeconds: number = 0,
    mode: number = 0,
    frequency: number = 4.0
): number {
    if (mode === 0) {
        const windU = u + 0.04 * Math.sin(timeSeconds * 1.5 + v * 3.0);
        const windV = v + 0.03 * Math.cos(timeSeconds * 1.2 + u * 2.5);
        const n1 = 0.5 * (1.0 + Math.sin(windU * frequency * 6.283) * Math.cos(windV * frequency * 6.283));
        const n2 = 0.5 * (1.0 + Math.sin(windU * frequency * 13.7 + 1.2) * Math.sin(windV * frequency * 11.3));
        const canopy = n1 * 0.6 + n2 * 0.4;
        return Math.max(0, Math.min(1.0, (canopy - 0.35) / 0.30));
    } else {
        const slit = Math.sin(v * frequency * 2.0 * Math.PI);
        return Math.max(0, Math.min(1.0, (slit + 0.2) / 0.5));
    }
}
