/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

export type RoofType = 'flat' | 'gabled' | 'hipped' | 'mansard' | 'domed' | 'setback';

export interface BuildingFootprintInput {
    id: number | string;
    geometry: { x: number; z: number }[];
    heightMeters: number;
    baseElevationMeters?: number;
    levels?: number;
    roofType?: RoofType;
    roofHeightMeters?: number;
    tags?: Record<string, any>;
}

export interface NativeMeshBufferOutput {
    positions: Float32Array;
    normals: Float32Array;
    uvs: Float32Array;
    colors: Float32Array;
    indices: Uint32Array;
    vertexCount: number;
    indexCount: number;
}

export interface BuildingSculptOptions {
    gridResolution?: number;
    heightSmoothingFactor?: number;
    roofFeaturePreservationThreshold?: number;
    raycastStepSize?: number;
    elevationGrid?: Float32Array;
    windowInsetDepth?: number;
    enableArchitecturalRelief?: boolean;
    sillProjection?: number;
    defaultRoofType?: RoofType;
}

/**
 * Clean footprint ring: deduplicate closing/adjacent vertices & ensure CCW orientation.
 */
export function cleanFootprint(rawPts: { x: number; z: number }[]): { x: number; z: number }[] {
    if (!rawPts || rawPts.length < 3) return [];

    const pts: { x: number; z: number }[] = [];
    for (let i = 0; i < rawPts.length; i++) {
        const pt = rawPts[i];
        if (pts.length > 0) {
            const prev = pts[pts.length - 1];
            const dx = pt.x - prev.x;
            const dz = pt.z - prev.z;
            if (dx * dx + dz * dz < 1e-8) {
                continue;
            }
        }
        pts.push(pt);
    }

    // If first and last points are identical, drop the last duplicate
    if (pts.length > 3) {
        const first = pts[0];
        const last = pts[pts.length - 1];
        const dx = first.x - last.x;
        const dz = first.z - last.z;
        if (dx * dx + dz * dz < 1e-8) {
            pts.pop();
        }
    }

    if (pts.length < 3) return [];

    // Shoelace formula: if clockwise (area < 0), reverse to CCW
    let area = 0;
    for (let i = 0; i < pts.length; i++) {
        const j = (i + 1) % pts.length;
        area += pts[i].x * pts[j].z - pts[j].x * pts[i].z;
    }

    if (area < 0) {
        pts.reverse();
    }

    return pts;
}

/**
 * Calculate centroid of 2D polygon.
 */
export function computeCentroid(pts: { x: number; z: number }[]): { cx: number; cz: number } {
    let sumX = 0;
    let sumZ = 0;
    for (const p of pts) {
        sumX += p.x;
        sumZ += p.z;
    }
    return { cx: sumX / (pts.length || 1), cz: sumZ / (pts.length || 1) };
}

/**
 * Scale 2D polygon vertices relative to centroid.
 */
export function scalePolygon(
    pts: { x: number; z: number }[],
    scaleFactor: number,
    cx: number,
    cz: number
): { x: number; z: number }[] {
    if (scaleFactor === 1.0) return pts;
    return pts.map((p) => ({
        x: cx + (p.x - cx) * scaleFactor,
        z: cz + (p.z - cz) * scaleFactor
    }));
}

/**
 * Compute 3D Photoreal Tile Elevation offset for a point (x, z) within footprint bounds.
 */
export function computePhotogrammetryElevation(
    x: number,
    z: number,
    minX: number,
    maxX: number,
    minZ: number,
    maxZ: number,
    baseY: number,
    topY: number,
    sculptOptions?: BuildingSculptOptions
): number {
    const widthX = Math.max(maxX - minX, 1e-4);
    const depthZ = Math.max(maxZ - minZ, 1e-4);
    const heightSpan = Math.max(topY - baseY, 1.0);

    const normU = Math.min(Math.max((x - minX) / widthX, 0), 1);
    const normV = Math.min(Math.max((z - minZ) / depthZ, 0), 1);

    let rawH = topY;

    if (sculptOptions?.elevationGrid && sculptOptions.gridResolution && sculptOptions.gridResolution > 1) {
        const N = sculptOptions.gridResolution;
        const grid = sculptOptions.elevationGrid;
        const uFloat = normU * (N - 1);
        const vFloat = normV * (N - 1);
        const u0 = Math.floor(uFloat);
        const v0 = Math.floor(vFloat);
        const u1 = Math.min(u0 + 1, N - 1);
        const v1 = Math.min(v0 + 1, N - 1);
        const fu = uFloat - u0;
        const fv = vFloat - v0;

        const h00 = grid[u0 + v0 * N] ?? topY;
        const h10 = grid[u1 + v0 * N] ?? topY;
        const h01 = grid[u0 + v1 * N] ?? topY;
        const h11 = grid[u1 + v1 * N] ?? topY;

        rawH = (1 - fu) * (1 - fv) * h00 + fu * (1 - fv) * h10 + (1 - fu) * fv * h01 + fu * fv * h11;
    } else {
        const stepSize = sculptOptions?.raycastStepSize ?? 0.5;
        const macroVariation = Math.sin((normU - 0.5) * Math.PI) * Math.cos((normV - 0.5) * Math.PI) * Math.min(0.1 * heightSpan, 1.5);
        const microVariation = Math.sin(x * 0.8) * Math.cos(z * 0.8) * stepSize * 0.3;
        rawH = topY + macroVariation + microVariation;
    }

    const distCenterU = Math.abs(normU - 0.5) * 2.0;
    const distCenterV = Math.abs(normV - 0.5) * 2.0;
    const edgeDist = Math.max(distCenterU, distCenterV);

    const stitchT = Math.min(Math.max((edgeDist - 0.8) / 0.2, 0), 1);
    const stitchWeight = 1.0 - (stitchT * stitchT * (3.0 - 2.0 * stitchT));

    const targetY = stitchWeight * rawH + (1.0 - stitchWeight) * topY;

    const deltaY = Math.abs(targetY - topY);
    const preservationThreshold = sculptOptions?.roofFeaturePreservationThreshold ?? 1.5;
    if (deltaY > preservationThreshold) {
        return targetY;
    }

    const blend = Math.min(Math.max(sculptOptions?.heightSmoothingFactor ?? 0.2, 0.0), 1.0);
    return (1 - blend) * topY + blend * targetY;
}

function fnv1aHash(str: string): number {
    let hash = 2166136261;
    for (let i = 0; i < str.length; i++) {
        hash ^= str.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
}

export function getBuildingColor(fp: BuildingFootprintInput): [number, number, number] {
    const mat = (fp.tags?.['building:material'] || '').toLowerCase();
    const bldType = (fp.tags?.building || '').toLowerCase();

    const palette: [number, number, number][] = [
        [158 / 255, 67 / 255, 52 / 255],   // Brick Red (#9e4334)
        [200 / 255, 185 / 255, 166 / 255], // Sandstone / Limestone Beige (#c8b9a6)
        [92 / 255, 99 / 255, 112 / 255],   // Granite / Dark Stone (#5c6370)
        [74 / 255, 107 / 255, 130 / 255],  // Modern Glass Curtain Wall Tint (#4a6b82)
        [56 / 255, 62 / 255, 74 / 255],    // Steel / Dark Charcoal (#383e4a)
        [220 / 255, 223 / 255, 225 / 255]  // White Stucco / Off-white (#dcdfe1)
    ];

    if (mat.includes('brick')) return palette[0];
    if (mat.includes('stone') || mat.includes('limestone') || mat.includes('sandstone')) return palette[1];
    if (mat.includes('granite') || mat.includes('concrete')) return palette[2];
    if (mat.includes('glass')) return palette[3];
    if (mat.includes('metal') || mat.includes('steel')) return palette[4];
    if (mat.includes('plaster') || mat.includes('stucco')) return palette[5];

    if (bldType === 'commercial' || bldType === 'office') return palette[3];
    if (bldType === 'industrial' || bldType === 'warehouse') return palette[4];

    const key = `${fp.id}_${fp.tags?.building || ''}_${fp.tags?.['building:material'] || ''}`;
    const hash = fnv1aHash(key);
    return palette[hash % palette.length];
}

export class NativeMeshBufferBuilder {
    positions: Float32Array;
    normals: Float32Array;
    uvs: Float32Array;
    colors: Float32Array;
    indices: Uint32Array;
    vertCount = 0;
    indexCount = 0;

    constructor(initialVertCap = 8192, initialIdxCap = 16384) {
        this.positions = new Float32Array(initialVertCap * 3);
        this.normals = new Float32Array(initialVertCap * 3);
        this.uvs = new Float32Array(initialVertCap * 2);
        this.colors = new Float32Array(initialVertCap * 3);
        this.indices = new Uint32Array(initialIdxCap);
    }

    ensureCapacity(additionalVerts: number, additionalIndices: number) {
        const targetVertCap = this.vertCount + additionalVerts;
        const targetIdxCap = this.indexCount + additionalIndices;
        const currentVertCap = this.positions.length / 3;
        const currentIdxCap = this.indices.length;

        if (targetVertCap <= currentVertCap && targetIdxCap <= currentIdxCap) {
            return;
        }

        if (targetVertCap > currentVertCap) {
            const newVertCap = Math.max(targetVertCap * 2, 8192);
            const newPos = new Float32Array(newVertCap * 3);
            newPos.set(this.positions.subarray(0, this.vertCount * 3));
            this.positions = newPos;

            const newNorm = new Float32Array(newVertCap * 3);
            newNorm.set(this.normals.subarray(0, this.vertCount * 3));
            this.normals = newNorm;

            const newUvs = new Float32Array(newVertCap * 2);
            newUvs.set(this.uvs.subarray(0, this.vertCount * 2));
            this.uvs = newUvs;

            const newCol = new Float32Array(newVertCap * 3);
            newCol.set(this.colors.subarray(0, this.vertCount * 3));
            this.colors = newCol;
        }

        if (targetIdxCap > currentIdxCap) {
            const newIdxCap = Math.max(targetIdxCap * 2, 16384);
            const newIdx = new Uint32Array(newIdxCap);
            newIdx.set(this.indices.subarray(0, this.indexCount));
            this.indices = newIdx;
        }
    }

    addQuadRaw(
        x0: number, y0: number, z0: number,
        x1: number, y1: number, z1: number,
        x2: number, y2: number, z2: number,
        x3: number, y3: number, z3: number,
        nx: number, ny: number, nz: number,
        cr: number, cg: number, cb: number,
        u0 = 0, v0 = 0,
        u1 = 1, v1 = 0,
        u2 = 1, v2 = 1,
        u3 = 0, v3 = 1
    ) {
        this.ensureCapacity(4, 6);
        const vIdx = this.vertCount;
        const pOffset = vIdx * 3;
        const uvOffset = vIdx * 2;
        const iOffset = this.indexCount;

        const pos = this.positions;
        pos[pOffset] = x0; pos[pOffset + 1] = y0; pos[pOffset + 2] = z0;
        pos[pOffset + 3] = x1; pos[pOffset + 4] = y1; pos[pOffset + 5] = z1;
        pos[pOffset + 6] = x2; pos[pOffset + 7] = y2; pos[pOffset + 8] = z2;
        pos[pOffset + 9] = x3; pos[pOffset + 10] = y3; pos[pOffset + 11] = z3;

        const norm = this.normals;
        norm[pOffset] = nx; norm[pOffset + 1] = ny; norm[pOffset + 2] = nz;
        norm[pOffset + 3] = nx; norm[pOffset + 4] = ny; norm[pOffset + 5] = nz;
        norm[pOffset + 6] = nx; norm[pOffset + 7] = ny; norm[pOffset + 8] = nz;
        norm[pOffset + 9] = nx; norm[pOffset + 10] = ny; norm[pOffset + 11] = nz;

        const uvs = this.uvs;
        uvs[uvOffset] = u0; uvs[uvOffset + 1] = v0;
        uvs[uvOffset + 2] = u1; uvs[uvOffset + 3] = v1;
        uvs[uvOffset + 4] = u2; uvs[uvOffset + 5] = v2;
        uvs[uvOffset + 6] = u3; uvs[uvOffset + 7] = v3;

        const col = this.colors;
        col[pOffset] = cr; col[pOffset + 1] = cg; col[pOffset + 2] = cb;
        col[pOffset + 3] = cr; col[pOffset + 4] = cg; col[pOffset + 5] = cb;
        col[pOffset + 6] = cr; col[pOffset + 7] = cg; col[pOffset + 8] = cb;
        col[pOffset + 9] = cr; col[pOffset + 10] = cg; col[pOffset + 11] = cb;

        const idx = this.indices;
        idx[iOffset] = vIdx;
        idx[iOffset + 1] = vIdx + 1;
        idx[iOffset + 2] = vIdx + 2;
        idx[iOffset + 3] = vIdx;
        idx[iOffset + 4] = vIdx + 2;
        idx[iOffset + 5] = vIdx + 3;

        this.vertCount += 4;
        this.indexCount += 6;
    }

    addVertexRaw(
        x: number, y: number, z: number,
        nx: number, ny: number, nz: number,
        u: number, v: number,
        cr: number, cg: number, cb: number
    ): number {
        this.ensureCapacity(1, 0);
        const vIdx = this.vertCount;
        const pOffset = vIdx * 3;
        const uvOffset = vIdx * 2;

        this.positions[pOffset] = x;
        this.positions[pOffset + 1] = y;
        this.positions[pOffset + 2] = z;

        this.normals[pOffset] = nx;
        this.normals[pOffset + 1] = ny;
        this.normals[pOffset + 2] = nz;

        this.uvs[uvOffset] = u;
        this.uvs[uvOffset + 1] = v;

        this.colors[pOffset] = cr;
        this.colors[pOffset + 1] = cg;
        this.colors[pOffset + 2] = cb;

        this.vertCount++;
        return vIdx;
    }

    addTriangleIndices(i0: number, i1: number, i2: number) {
        this.ensureCapacity(0, 3);
        const iOffset = this.indexCount;
        this.indices[iOffset] = i0;
        this.indices[iOffset + 1] = i1;
        this.indices[iOffset + 2] = i2;
        this.indexCount += 3;
    }

    toBufferOutput(): NativeMeshBufferOutput {
        return {
            positions: this.positions.subarray(0, this.vertCount * 3),
            normals: this.normals.subarray(0, this.vertCount * 3),
            uvs: this.uvs.subarray(0, this.vertCount * 2),
            colors: this.colors.subarray(0, this.vertCount * 3),
            indices: this.indices.subarray(0, this.indexCount),
            vertexCount: this.vertCount,
            indexCount: this.indexCount
        };
    }
}

/**
 * High-Performance Native Procedural Building Extrusion Engine.
 * Constructs parametric walls, setback tiers, window bays, architectural relief,
 * and parametric roof types (flat, gabled, hipped, mansard, domed).
 */
export function generateNativeBuildingMeshBuffer(
    footprints: BuildingFootprintInput[],
    sculptOptions?: BuildingSculptOptions
): NativeMeshBufferOutput {
    const estVerts = Math.max(8192, footprints.length * 1536);
    const estIdxs = Math.max(16384, footprints.length * 3072);
    const builder = new NativeMeshBufferBuilder(estVerts, estIdxs);

    const windowInsetDepth = sculptOptions?.windowInsetDepth ?? 0.12;
    const enableRelief = sculptOptions?.enableArchitecturalRelief ?? true;
    const sillProj = sculptOptions?.sillProjection ?? 0.12;

    const glassR = 0.29, glassG = 0.42, glassB = 0.51;

    for (const fp of footprints) {
        const pts = cleanFootprint(fp.geometry);
        const count = pts.length;
        if (count < 3) continue;

        const facadeColor = getBuildingColor(fp);
        const fR = facadeColor[0];
        const fG = facadeColor[1];
        const fB = facadeColor[2];

        const rR = fR * 0.85;
        const rG = fG * 0.85;
        const rB = fB * 0.85;

        const baseHeight = fp.baseElevationMeters || 0;
        const height = fp.heightMeters || 10;
        const topY = baseHeight + height;

        // Footprint bounding box and centroid
        let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
        for (const p of pts) {
            if (p.x < minX) minX = p.x;
            if (p.x > maxX) maxX = p.x;
            if (p.z < minZ) minZ = p.z;
            if (p.z > maxZ) maxZ = p.z;
        }

        const { cx, cz } = computeCentroid(pts);
        const widthX = Math.max(maxX - minX, 1.0);
        const depthZ = Math.max(maxZ - minZ, 1.0);

        const roofType: RoofType = fp.roofType || sculptOptions?.defaultRoofType || (height > 25 ? 'setback' : 'flat');
        const roofHeight = fp.roofHeightMeters || Math.min(height * 0.25, 4.0);

        // Tier configurations for setback or single tier
        type TierConfig = { baseY: number; topY: number; scale: number };
        const tiers: TierConfig[] = [];

        if (roofType === 'setback' || height > 30) {
            tiers.push({ baseY: baseHeight, topY: baseHeight + height * 0.45, scale: 1.0 });
            tiers.push({ baseY: baseHeight + height * 0.45, topY: baseHeight + height * 0.75, scale: 0.82 });
            tiers.push({ baseY: baseHeight + height * 0.75, topY: topY, scale: 0.68 });
        } else if (height > 16) {
            tiers.push({ baseY: baseHeight, topY: baseHeight + height * 0.6, scale: 1.0 });
            tiers.push({ baseY: baseHeight + height * 0.6, topY: topY, scale: 0.82 });
        } else {
            tiers.push({ baseY: baseHeight, topY: topY, scale: 1.0 });
        }

        let topTierPts: { x: number; z: number }[] = pts;

        // A. Extrude Multi-Tier Setback Side Walls with Inset Windows & Relief
        for (let tIdx = 0; tIdx < tiers.length; tIdx++) {
            const tier = tiers[tIdx];
            const tierPts = scalePolygon(pts, tier.scale, cx, cz);
            const tCount = tierPts.length;

            if (tIdx === tiers.length - 1) {
                topTierPts = tierPts;
            }

            for (let i = 0; i < tCount; i++) {
                const next = (i + 1) % tCount;
                const x0 = tierPts[i].x;
                const z0 = tierPts[i].z;
                const x1 = tierPts[next].x;
                const z1 = tierPts[next].z;

                const dx = x1 - x0;
                const dz = z1 - z0;
                let len = Math.hypot(dx, dz);
                if (len < 1e-6) len = 1e-6;

                const tx = dx / len;
                const tz = dz / len;
                const nx = dz / len;
                const nz = -dx / len;

                const wallHeight = tier.topY - tier.baseY;
                const floorHeight = 3.5;
                const numFloors = Math.max(1, Math.floor(wallHeight / floorHeight));
                const actualFloorHeight = wallHeight / numFloors;

                const bayWidthTarget = 2.5;
                const numBays = Math.max(1, Math.floor(len / bayWidthTarget));
                const actualBayWidth = len / numBays;

                const getPt = (s: number, y: number, offsetN: number) => ({
                    x: x0 + tx * s + nx * offsetN,
                    y,
                    z: z0 + tz * s + nz * offsetN
                });

                for (let f = 0; f < numFloors; f++) {
                    const yBot = tier.baseY + f * actualFloorHeight;
                    const yTop = yBot + actualFloorHeight;

                    for (let b = 0; b < numBays; b++) {
                        const sStart = b * actualBayWidth;
                        const sEnd = sStart + actualBayWidth;

                        const sW0 = sStart + actualBayWidth * 0.20;
                        const sW1 = sStart + actualBayWidth * 0.80;
                        const yW0 = yBot + actualFloorHeight * 0.18;
                        const yW1 = yBot + actualFloorHeight * 0.78;

                        const sS0 = Math.max(sStart, sW0 - 0.06);
                        const sS1 = Math.min(sEnd, sW1 + 0.06);
                        const ySillMid = yW0 - 0.03;
                        const ySillBot = Math.max(yBot, yW0 - 0.08);

                        const pW0_0 = getPt(sW0, yW0, -windowInsetDepth);
                        const pW0_1 = getPt(sW0, yW1, -windowInsetDepth);
                        const pW1_1 = getPt(sW1, yW1, -windowInsetDepth);
                        const pW1_0 = getPt(sW1, yW0, -windowInsetDepth);

                        // Inset Window Glass Quad
                        builder.addQuadRaw(
                            pW0_0.x, pW0_0.y, pW0_0.z,
                            pW0_1.x, pW0_1.y, pW0_1.z,
                            pW1_1.x, pW1_1.y, pW1_1.z,
                            pW1_0.x, pW1_0.y, pW1_0.z,
                            nx, 0, nz,
                            glassR, glassG, glassB
                        );

                        // Window Frame / Lintel / Jamb Reveals
                        const pW0_1_0 = getPt(sW0, yW1, 0);
                        const pW1_1_0 = getPt(sW1, yW1, 0);
                        builder.addQuadRaw(
                            pW0_1_0.x, pW0_1_0.y, pW0_1_0.z,
                            pW1_1_0.x, pW1_1_0.y, pW1_1_0.z,
                            pW1_1.x, pW1_1.y, pW1_1.z,
                            pW0_1.x, pW0_1.y, pW0_1.z,
                            0, -1, 0,
                            fR, fG, fB
                        );

                        const pW0_0_0 = getPt(sW0, yW0, 0);
                        builder.addQuadRaw(
                            pW0_0_0.x, pW0_0_0.y, pW0_0_0.z,
                            pW0_0.x, pW0_0.y, pW0_0.z,
                            pW0_1.x, pW0_1.y, pW0_1.z,
                            pW0_1_0.x, pW0_1_0.y, pW0_1_0.z,
                            tx, 0, tz,
                            fR, fG, fB
                        );

                        const pW1_0_0 = getPt(sW1, yW0, 0);
                        builder.addQuadRaw(
                            pW1_0.x, pW1_0.y, pW1_0.z,
                            pW1_0_0.x, pW1_0_0.y, pW1_0_0.z,
                            pW1_1_0.x, pW1_1_0.y, pW1_1_0.z,
                            pW1_1.x, pW1_1.y, pW1_1.z,
                            -tx, 0, -tz,
                            fR, fG, fB
                        );

                        // Window Sill Ledge
                        const pS0_W0 = getPt(sS0, yW0, 0);
                        const pS1_W0 = getPt(sS1, yW0, 0);
                        const pS1_Mid = getPt(sS1, ySillMid, sillProj);
                        const pS0_Mid = getPt(sS0, ySillMid, sillProj);
                        const pS0_Bot_P = getPt(sS0, ySillBot, sillProj);
                        const pS1_Bot_P = getPt(sS1, ySillBot, sillProj);
                        const pS0_Bot_0 = getPt(sS0, ySillBot, 0);
                        const pS1_Bot_0 = getPt(sS1, ySillBot, 0);

                        builder.addQuadRaw(
                            pS0_W0.x, pS0_W0.y, pS0_W0.z,
                            pS1_W0.x, pS1_W0.y, pS1_W0.z,
                            pS1_Mid.x, pS1_Mid.y, pS1_Mid.z,
                            pS0_Mid.x, pS0_Mid.y, pS0_Mid.z,
                            nx * 0.7, 0.7, nz * 0.7,
                            fR, fG, fB
                        );
                        builder.addQuadRaw(
                            pS0_Bot_P.x, pS0_Bot_P.y, pS0_Bot_P.z,
                            pS0_Mid.x, pS0_Mid.y, pS0_Mid.z,
                            pS1_Mid.x, pS1_Mid.y, pS1_Mid.z,
                            pS1_Bot_P.x, pS1_Bot_P.y, pS1_Bot_P.z,
                            nx, 0, nz,
                            fR, fG, fB
                        );
                        builder.addQuadRaw(
                            pS0_Bot_0.x, pS0_Bot_0.y, pS0_Bot_0.z,
                            pS1_Bot_0.x, pS1_Bot_0.y, pS1_Bot_0.z,
                            pS1_Bot_P.x, pS1_Bot_P.y, pS1_Bot_P.z,
                            pS0_Bot_P.x, pS0_Bot_P.y, pS0_Bot_P.z,
                            0, -1, 0,
                            fR, fG, fB
                        );

                        // Surrounding Wall Face Quads
                        const pStart_Bot = getPt(sStart, yBot, 0);
                        const pStart_SillBot = getPt(sStart, ySillBot, 0);
                        const pEnd_SillBot = getPt(sEnd, ySillBot, 0);
                        const pEnd_Bot = getPt(sEnd, yBot, 0);
                        builder.addQuadRaw(
                            pStart_Bot.x, pStart_Bot.y, pStart_Bot.z,
                            pStart_SillBot.x, pStart_SillBot.y, pStart_SillBot.z,
                            pEnd_SillBot.x, pEnd_SillBot.y, pEnd_SillBot.z,
                            pEnd_Bot.x, pEnd_Bot.y, pEnd_Bot.z,
                            nx, 0, nz,
                            fR, fG, fB
                        );

                        const pStart_W1 = getPt(sStart, yW1, 0);
                        const pStart_Top = getPt(sStart, yTop, 0);
                        const pEnd_Top = getPt(sEnd, yTop, 0);
                        const pEnd_W1 = getPt(sEnd, yW1, 0);
                        builder.addQuadRaw(
                            pStart_W1.x, pStart_W1.y, pStart_W1.z,
                            pStart_Top.x, pStart_Top.y, pStart_Top.z,
                            pEnd_Top.x, pEnd_Top.y, pEnd_Top.z,
                            pEnd_W1.x, pEnd_W1.y, pEnd_W1.z,
                            nx, 0, nz,
                            fR, fG, fB
                        );

                        const pS0_W1 = getPt(sS0, yW1, 0);
                        const pS0_SillBot = getPt(sS0, ySillBot, 0);
                        builder.addQuadRaw(
                            pStart_SillBot.x, pStart_SillBot.y, pStart_SillBot.z,
                            pStart_W1.x, pStart_W1.y, pStart_W1.z,
                            pS0_W1.x, pS0_W1.y, pS0_W1.z,
                            pS0_SillBot.x, pS0_SillBot.y, pS0_SillBot.z,
                            nx, 0, nz,
                            fR, fG, fB
                        );

                        const pS1_SillBot = getPt(sS1, ySillBot, 0);
                        const pS1_W1 = getPt(sS1, yW1, 0);
                        builder.addQuadRaw(
                            pS1_SillBot.x, pS1_SillBot.y, pS1_SillBot.z,
                            pS1_W1.x, pS1_W1.y, pS1_W1.z,
                            pEnd_W1.x, pEnd_W1.y, pEnd_W1.z,
                            pEnd_SillBot.x, pEnd_SillBot.y, pEnd_SillBot.z,
                            nx, 0, nz,
                            fR, fG, fB
                        );

                        // Architectural Cornice Band & Pilaster
                        if (enableRelief) {
                            if (f > 0) {
                                const corniceProj = 0.08;
                                const corniceH = 0.16;
                                const cY0 = yBot - corniceH * 0.5;
                                const cY1 = yBot + corniceH * 0.5;
                                const pC_Start_0 = getPt(sStart, cY0, corniceProj);
                                const pC_Start_1 = getPt(sStart, cY1, corniceProj);
                                const pC_End_1 = getPt(sEnd, cY1, corniceProj);
                                const pC_End_0 = getPt(sEnd, cY0, corniceProj);

                                builder.addQuadRaw(
                                    pC_Start_0.x, pC_Start_0.y, pC_Start_0.z,
                                    pC_Start_1.x, pC_Start_1.y, pC_Start_1.z,
                                    pC_End_1.x, pC_End_1.y, pC_End_1.z,
                                    pC_End_0.x, pC_End_0.y, pC_End_0.z,
                                    nx, 0, nz,
                                    fR, fG, fB
                                );
                            }

                            const colW = 0.14;
                            const colProj = 0.06;
                            const cS0 = Math.max(0, sStart - colW * 0.5);
                            const cS1 = Math.min(len, sStart + colW * 0.5);
                            if (cS1 > cS0) {
                                const pP_S0_Bot = getPt(cS0, yBot, colProj);
                                const pP_S0_Top = getPt(cS0, yTop, colProj);
                                const pP_S1_Top = getPt(cS1, yTop, colProj);
                                const pP_S1_Bot = getPt(cS1, yBot, colProj);

                                builder.addQuadRaw(
                                    pP_S0_Bot.x, pP_S0_Bot.y, pP_S0_Bot.z,
                                    pP_S0_Top.x, pP_S0_Top.y, pP_S0_Top.z,
                                    pP_S1_Top.x, pP_S1_Top.y, pP_S1_Top.z,
                                    pP_S1_Bot.x, pP_S1_Bot.y, pP_S1_Bot.z,
                                    nx, 0, nz,
                                    fR, fG, fB
                                );
                            }
                        }
                    }
                }
            }

            // Setback ring between tiers
            if (tIdx < tiers.length - 1) {
                const nextTier = tiers[tIdx + 1];
                const nextTierPts = scalePolygon(pts, nextTier.scale, cx, cz);
                for (let i = 0; i < tCount; i++) {
                    const next = (i + 1) % tCount;
                    const a0 = tierPts[i];
                    const a1 = tierPts[next];
                    const b0 = nextTierPts[i];
                    const b1 = nextTierPts[next];

                    builder.addQuadRaw(
                        a0.x, tier.topY, a0.z,
                        b0.x, tier.topY, b0.z,
                        b1.x, tier.topY, b1.z,
                        a1.x, tier.topY, a1.z,
                        0, 1, 0,
                        fR, fG, fB
                    );
                }
            }
        }

        // B. Roof Construction Based on Parametric Roof Type
        const pCount = topTierPts.length;

        if (roofType === 'gabled') {
            // Gabled Roof: Central ridge along primary axis
            const isLongerX = widthX >= depthZ;
            const ridgeY = topY + roofHeight;

            const apex0 = builder.addVertexRaw(
                isLongerX ? minX : cx, ridgeY, isLongerX ? cz : minZ,
                0, 1, 0, 0.5, 1, rR * 0.9, rG * 0.9, rB * 0.9
            );
            const apex1 = builder.addVertexRaw(
                isLongerX ? maxX : cx, ridgeY, isLongerX ? cz : maxZ,
                0, 1, 0, 0.5, 1, rR * 0.9, rG * 0.9, rB * 0.9
            );

            // Connect perimeter vertices to apex ridge line
            const baseStartIdx = builder.vertCount;
            for (let i = 0; i < pCount; i++) {
                builder.addVertexRaw(
                    topTierPts[i].x, topY, topTierPts[i].z,
                    0, 1, 0, topTierPts[i].x * 0.1, topTierPts[i].z * 0.1,
                    rR, rG, rB
                );
            }

            for (let i = 0; i < pCount; i++) {
                const next = (i + 1) % pCount;
                const apexToUse = i < pCount / 2 ? apex0 : apex1;
                builder.addTriangleIndices(baseStartIdx + i, baseStartIdx + next, apexToUse);
            }
        } else if (roofType === 'hipped' || roofType === 'domed') {
            // Hipped / Domed Roof: Central apex vertex
            const apexY = topY + (roofType === 'domed' ? roofHeight * 1.2 : roofHeight);
            const apexIdx = builder.addVertexRaw(
                cx, apexY, cz,
                0, 1, 0, 0.5, 0.5,
                rR * 0.95, rG * 0.95, rB * 0.95
            );

            const baseStartIdx = builder.vertCount;
            for (let i = 0; i < pCount; i++) {
                builder.addVertexRaw(
                    topTierPts[i].x, topY, topTierPts[i].z,
                    0, 1, 0, topTierPts[i].x * 0.1, topTierPts[i].z * 0.1,
                    rR, rG, rB
                );
            }

            for (let i = 0; i < pCount; i++) {
                const next = (i + 1) % pCount;
                builder.addTriangleIndices(baseStartIdx + i, baseStartIdx + next, apexIdx);
            }
        } else if (roofType === 'mansard') {
            // Mansard Roof: Lower steep pitch and upper flat deck
            const mansardBreakPts = scalePolygon(topTierPts, 0.8, cx, cz);
            const midY = topY + roofHeight * 0.7;
            const topMansardY = topY + roofHeight;

            // Lower steep sloped quads
            for (let i = 0; i < pCount; i++) {
                const next = (i + 1) % pCount;
                builder.addQuadRaw(
                    topTierPts[i].x, topY, topTierPts[i].z,
                    mansardBreakPts[i].x, midY, mansardBreakPts[i].z,
                    mansardBreakPts[next].x, midY, mansardBreakPts[next].z,
                    topTierPts[next].x, topY, topTierPts[next].z,
                    0, 1, 0,
                    rR * 0.9, rG * 0.9, rB * 0.9
                );
            }

            // Upper flat deck
            const apexIdx = builder.addVertexRaw(cx, topMansardY, cz, 0, 1, 0, 0.5, 0.5, rR, rG, rB);
            const deckStartIdx = builder.vertCount;
            for (let i = 0; i < pCount; i++) {
                builder.addVertexRaw(
                    mansardBreakPts[i].x, midY, mansardBreakPts[i].z,
                    0, 1, 0, mansardBreakPts[i].x * 0.1, mansardBreakPts[i].z * 0.1,
                    rR, rG, rB
                );
            }
            for (let i = 0; i < pCount; i++) {
                const next = (i + 1) % pCount;
                builder.addTriangleIndices(deckStartIdx + i, deckStartIdx + next, apexIdx);
            }
        } else {
            // Flat / Parapet Roof (Standard commercial / setback style)
            const innerParapetPts = scalePolygon(topTierPts, 0.94, cx, cz);
            const parapetHeight = Math.max(0.6, Math.min(1.2, height * 0.04));

            for (let i = 0; i < pCount; i++) {
                const next = (i + 1) % pCount;
                const o0 = topTierPts[i];
                const o1 = topTierPts[next];
                const in0 = innerParapetPts[i];
                const in1 = innerParapetPts[next];

                const dx = o1.x - o0.x;
                const dz = o1.z - o0.z;
                let len = Math.hypot(dx, dz);
                if (len < 1e-6) len = 1e-6;

                const nx = dz / len;
                const nz = -dx / len;

                // Parapet Top Rim Ring
                builder.addQuadRaw(
                    o0.x, topY + parapetHeight, o0.z,
                    in0.x, topY + parapetHeight, in0.z,
                    in1.x, topY + parapetHeight, in1.z,
                    o1.x, topY + parapetHeight, o1.z,
                    0, 1, 0,
                    fR, fG, fB
                );

                // Inner Parapet Wall Face
                builder.addQuadRaw(
                    in0.x, topY, in0.z,
                    in1.x, topY, in1.z,
                    in1.x, topY + parapetHeight, in1.z,
                    in0.x, topY + parapetHeight, in0.z,
                    -nx, 0, -nz,
                    fR, fG, fB
                );
            }

            // Recessed roof center fan
            const centerVert = builder.addVertexRaw(
                cx, topY, cz,
                0, 1, 0, 0.5, 0.5,
                rR, rG, rB
            );

            const rimStart = builder.vertCount;
            for (let i = 0; i < pCount; i++) {
                const ry = computePhotogrammetryElevation(
                    innerParapetPts[i].x, innerParapetPts[i].z,
                    minX, maxX, minZ, maxZ, baseHeight, topY, sculptOptions
                );
                builder.addVertexRaw(
                    innerParapetPts[i].x, ry, innerParapetPts[i].z,
                    0, 1, 0, innerParapetPts[i].x * 0.1, innerParapetPts[i].z * 0.1,
                    rR, rG, rB
                );
            }

            for (let i = 0; i < pCount; i++) {
                const next = (i + 1) % pCount;
                builder.addTriangleIndices(rimStart + i, rimStart + next, centerVert);
            }
        }
    }

    return builder.toBufferOutput();
}

/**
 * Creates a THREE.BufferGeometry from native building mesh arrays for single-draw-call rendering.
 */
export function buildNativeThreeGeometry(meshBuffer: NativeMeshBufferOutput, THREE?: any): any {
    const ThreeLib = THREE || (typeof window !== 'undefined' && (window as any).THREE) || require('three');
    const geom = new ThreeLib.BufferGeometry();
    geom.setAttribute('position', new ThreeLib.BufferAttribute(meshBuffer.positions, 3));
    geom.setAttribute('normal', new ThreeLib.BufferAttribute(meshBuffer.normals, 3));
    geom.setAttribute('uv', new ThreeLib.BufferAttribute(meshBuffer.uvs, 2));
    if (meshBuffer.colors && meshBuffer.colors.length > 0) {
        geom.setAttribute('color', new ThreeLib.BufferAttribute(meshBuffer.colors, 3));
    }
    geom.setIndex(new ThreeLib.BufferAttribute(meshBuffer.indices, 1));
    return geom;
}
