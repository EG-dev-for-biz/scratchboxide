/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * Tile Occupancy Mask.
 * Computes a 2D XZ-plane signed-depth residual classification mask from a
 * Google Photorealistic 3D Tile GLB. Each cell is labelled FREE (inside tile
 * coverage), BOUNDARY, or OPEN (synthesize here) — a 2D projection of the
 * paper's signed depth residual s(v) = clamp(z_cam(v) - D(π(v)), -δ, δ).
 *
 * Used when extending a tile scene with synthesized C++ geometry: the C++
 * generator queries the mask before placing any structure or vegetation to
 * avoid interpenetrating the photogrammetric tile.
 ********************************************************************************/

export enum OccupancyCell {
    FREE     = 0,   // tile occupies this space — do not synthesize
    BOUNDARY = 1,   // edge of tile coverage
    OPEN     = 2    // outside tile — free to synthesize
}

export interface TileOccupancyMask {
    cells: Uint8Array;
    gridWidth: number;
    gridHeight: number;
    /** World-space X of cell (0, 0) */
    originX: number;
    /** World-space Z of cell (0, 0) */
    originZ: number;
    cellSizeMeters: number;
    query(worldX: number, worldZ: number): OccupancyCell;
}

export class TileOccupancyMaskBuilder {
    /**
     * Builds a top-down XZ occupancy mask by rasterising every triangle from the
     * tile's POSITION accessor onto a 2D grid.
     */
    build(glbBuffer: Buffer, cellSizeMeters = 1.0): TileOccupancyMask {
        const positions = this.extractPositions(glbBuffer);
        if (positions.length === 0) {
            throw new Error('TileOccupancyMask: no POSITION data found in GLB');
        }

        // XZ bounds
        let minX = Infinity, maxX = -Infinity;
        let minZ = Infinity, maxZ = -Infinity;
        for (let i = 0; i < positions.length; i += 3) {
            if (positions[i]   < minX) minX = positions[i];
            if (positions[i]   > maxX) maxX = positions[i];
            if (positions[i+2] < minZ) minZ = positions[i+2];
            if (positions[i+2] > maxZ) maxZ = positions[i+2];
        }

        // Grid origin is 1 cell outside the bounds so boundary detection works cleanly
        const originX = minX - cellSizeMeters;
        const originZ = minZ - cellSizeMeters;
        const gridW = Math.ceil((maxX - minX) / cellSizeMeters) + 3;
        const gridH = Math.ceil((maxZ - minZ) / cellSizeMeters) + 3;

        const cells = new Uint8Array(gridW * gridH).fill(OccupancyCell.OPEN);

        const cellOf = (wx: number, wz: number): [number, number] => [
            Math.floor((wx - originX) / cellSizeMeters),
            Math.floor((wz - originZ) / cellSizeMeters)
        ];

        // Rasterise each triangle footprint onto XZ grid
        const triCount = Math.floor(positions.length / 9);
        for (let t = 0; t < triCount; t++) {
            const base = t * 9;
            this.rasteriseTriangle(
                cells, gridW, gridH, originX, originZ, cellSizeMeters,
                positions[base],   positions[base+2],
                positions[base+3], positions[base+5],
                positions[base+6], positions[base+8]
            );
        }

        // Second pass: mark OPEN cells adjacent to FREE cells as BOUNDARY
        const copy = new Uint8Array(cells);
        for (let gz = 1; gz < gridH - 1; gz++) {
            for (let gx = 1; gx < gridW - 1; gx++) {
                if (copy[gz * gridW + gx] !== OccupancyCell.OPEN) continue;
                const neighbours = [
                    copy[(gz-1) * gridW + gx],
                    copy[(gz+1) * gridW + gx],
                    copy[gz * gridW + (gx-1)],
                    copy[gz * gridW + (gx+1)]
                ];
                if (neighbours.some(n => n === OccupancyCell.FREE)) {
                    cells[gz * gridW + gx] = OccupancyCell.BOUNDARY;
                }
            }
        }

        return {
            cells, gridWidth: gridW, gridHeight: gridH,
            originX, originZ, cellSizeMeters,
            query(worldX: number, worldZ: number): OccupancyCell {
                const gx = Math.floor((worldX - originX) / cellSizeMeters);
                const gz = Math.floor((worldZ - originZ) / cellSizeMeters);
                if (gx < 0 || gx >= gridW || gz < 0 || gz >= gridH) return OccupancyCell.OPEN;
                return cells[gz * gridW + gx] as OccupancyCell;
            }
        };
    }

    /** Serialises the mask to a flat binary file readable by C++ generated code. */
    serialise(mask: TileOccupancyMask): Buffer {
        // Header: 4×float32 (originX, originZ, cellSize, padding) + 2×int32 (gridW, gridH)
        const headerBytes = 4 * 4 + 2 * 4;  // 24 bytes
        const buf = Buffer.allocUnsafe(headerBytes + mask.cells.length);
        buf.writeFloatLE(mask.originX,        0);
        buf.writeFloatLE(mask.originZ,        4);
        buf.writeFloatLE(mask.cellSizeMeters, 8);
        buf.writeFloatLE(0,                  12);  // padding
        buf.writeInt32LE(mask.gridWidth,     16);
        buf.writeInt32LE(mask.gridHeight,    20);
        buf.set(mask.cells, headerBytes);
        return buf;
    }

    // -------------------------------------------------------------------------
    // Private
    // -------------------------------------------------------------------------

    /**
     * Parses a binary glTF 2.0 GLB and extracts interleaved XYZ float32 positions
     * from the first mesh primitive's POSITION accessor, returned as a flat Float32Array
     * (length = vertexCount × 3, indices not expanded — each 9 floats = one triangle).
     */
    private extractPositions(glbBuffer: Buffer): Float32Array {
        if (glbBuffer.readUInt32LE(0) !== 0x46546C67) {
            throw new Error('TileOccupancyMask: not a valid GLB file (bad magic)');
        }
        const jsonChunkLen  = glbBuffer.readUInt32LE(12);
        const jsonStart     = 20;
        const jsonStr       = glbBuffer.slice(jsonStart, jsonStart + jsonChunkLen).toString('utf8');
        const gltf          = JSON.parse(jsonStr);

        const binChunkStart = jsonStart + jsonChunkLen;
        const binDataStart  = binChunkStart + 8;  // skip chunkLength + chunkType

        // Find POSITION accessor from first mesh primitive
        const prim = gltf.meshes?.[0]?.primitives?.[0];
        if (!prim) return new Float32Array(0);

        const posAccessorIdx = prim.attributes?.POSITION;
        if (posAccessorIdx === undefined) return new Float32Array(0);

        const accessor   = gltf.accessors[posAccessorIdx];
        const bufView    = gltf.bufferViews[accessor.bufferView];
        const byteOffset = (bufView.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
        const byteLen    = accessor.count * 3 * 4;  // count × VEC3 × float32

        const posBuffer = glbBuffer.slice(binDataStart + byteOffset, binDataStart + byteOffset + byteLen);
        const result    = new Float32Array(accessor.count * 3);
        for (let i = 0; i < accessor.count * 3; i++) {
            result[i] = posBuffer.readFloatLE(i * 4);
        }

        // If index accessor present, expand to unindexed triangles
        const idxAccessorIdx = prim.indices;
        if (idxAccessorIdx === undefined) return result;

        const idxAccessor = gltf.accessors[idxAccessorIdx];
        const idxView     = gltf.bufferViews[idxAccessor.bufferView];
        const idxOffset   = (idxView.byteOffset ?? 0) + (idxAccessor.byteOffset ?? 0);
        const triCount    = idxAccessor.count / 3;
        const expanded    = new Float32Array(idxAccessor.count * 3);
        const stride      = idxAccessor.componentType === 5123 ? 2 : 4;  // UNSIGNED_SHORT vs UNSIGNED_INT

        for (let t = 0; t < triCount; t++) {
            for (let v = 0; v < 3; v++) {
                const idxByte = binDataStart + idxOffset + (t * 3 + v) * stride;
                const vi = stride === 2
                    ? glbBuffer.readUInt16LE(idxByte)
                    : glbBuffer.readUInt32LE(idxByte);
                expanded[(t * 3 + v) * 3 + 0] = result[vi * 3 + 0];
                expanded[(t * 3 + v) * 3 + 1] = result[vi * 3 + 1];
                expanded[(t * 3 + v) * 3 + 2] = result[vi * 3 + 2];
            }
        }
        return expanded;
    }

    private rasteriseTriangle(
        cells: Uint8Array, gridW: number, gridH: number,
        originX: number, originZ: number, cellSize: number,
        x0: number, z0: number,
        x1: number, z1: number,
        x2: number, z2: number
    ): void {
        const toGrid = (wx: number, wz: number): [number, number] => [
            Math.floor((wx - originX) / cellSize),
            Math.floor((wz - originZ) / cellSize)
        ];

        const [gx0, gz0] = toGrid(x0, z0);
        const [gx1, gz1] = toGrid(x1, z1);
        const [gx2, gz2] = toGrid(x2, z2);

        const minGx = Math.max(0, Math.min(gx0, gx1, gx2));
        const maxGx = Math.min(gridW - 1, Math.max(gx0, gx1, gx2));
        const minGz = Math.max(0, Math.min(gz0, gz1, gz2));
        const maxGz = Math.min(gridH - 1, Math.max(gz0, gz1, gz2));

        // Edge function rasterisation in XZ grid space
        const sign = (ax: number, az: number, bx: number, bz: number, px: number, pz: number): number =>
            (bx - ax) * (pz - az) - (bz - az) * (px - ax);

        for (let gz = minGz; gz <= maxGz; gz++) {
            for (let gx = minGx; gx <= maxGx; gx++) {
                const cx = gx + 0.5, cz = gz + 0.5;
                const d0 = sign(gx0, gz0, gx1, gz1, cx, cz);
                const d1 = sign(gx1, gz1, gx2, gz2, cx, cz);
                const d2 = sign(gx2, gz2, gx0, gz0, cx, cz);
                const inside = (d0 >= 0 && d1 >= 0 && d2 >= 0) || (d0 <= 0 && d1 <= 0 && d2 <= 0);
                if (inside) {
                    cells[gz * gridW + gx] = OccupancyCell.FREE;
                }
            }
        }
    }
}
