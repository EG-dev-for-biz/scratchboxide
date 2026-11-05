/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Reader for the streamable virtual geometry file written by
 * `scratchbox_virtual_geometry.hpp` (`writeSbvg`). See that header for the layout; the constants
 * here must match it.
 */

export const SBVG_MAGIC = 0x47564253; // 'SBVG'
/**
 * Version the builder writes. Version 6 names a baked emission atlas per re-textured level and the peak
 * radiance it is scaled by, so coarse levels keep their emitters. Version 5 names a baked normal atlas per re-textured level beside the
 * colour atlas of version 4 (whose atlas table names the PNGs of the re-textured coarse levels, one
 * material each, appended after the glTF materials); version 3 vertices carry a uv and every level
 * block ends with one material index per triangle; version 2 has 64-bit level block offsets;
 * versions 1 to 4 are still read.
 */
export const SBVG_VERSION = 6;
export const SBVG_HEADER_BYTES = 128;
export const SBVG_LEVEL_WORDS = 16;
/** Level row size of version 1 files (32-bit block offset and length at words 9 and 10). */
export const SBVG_V1_LEVEL_WORDS = 12;
export const SBVG_CLUSTER_WORDS = 32;
export const SBVG_CLUSTER_BYTES = SBVG_CLUSTER_WORDS * 4;
/** position xyz, normal xyz, uv (version 3); versions 1 and 2 store 6 floats without the uv. */
export const SBVG_VERTEX_FLOATS = 8;
export const SBVG_VERTEX_BYTES = SBVG_VERTEX_FLOATS * 4;
/** Material of a triangle whose primitive named no glTF material. */
export const SBVG_NO_MATERIAL = 0xffffffff;

/** Floats per vertex as stored in a file of this version. */
export function sbvgFileVertexFloats(version: number): number {
    return version >= 3 ? SBVG_VERTEX_FLOATS : 6;
}

export interface SbvgLevel {
    /** DAG level, 0 = full detail. Levels are stored coarsest first. */
    level: number;
    clusterStart: number;
    clusterCount: number;
    vertexStart: number;
    vertexCount: number;
    refStart: number;
    refCount: number;
    triangleStart: number;
    triangleCount: number;
    /** Bytes from the start of the file (64-bit in the file; exact in a JS number below 2^53). */
    byteOffset: number;
    byteLength: number;
}

export interface SbvgHeader {
    version: number;
    headerBytes: number;
    levelCount: number;
    vertexCount: number;
    clusterCount: number;
    refCount: number;
    /** Triangles across all levels of the DAG. */
    triangleCount: number;
    /** Triangles at full detail (level 0). */
    leafTriangleCount: number;
    sourceTriangleCount: number;
    /** Primitives of the source left out of the build (points, lines, no POSITION); 0 in version 1 files. */
    skippedPrimitives: number;
    /** Degenerate source triangles dropped while welding; 0 in version 1 files. */
    droppedDegenerate: number;
    /** Length of the source glTF's materials array; 0 before version 3. */
    materialCount: number;
    /** Re-textured coarse levels with an atlas PNG next to the file; 0 before version 4. */
    atlasCount: number;
    maxClusterVertices: number;
    maxClusterTriangles: number;
    aabbMin: [number, number, number];
    aabbMax: [number, number, number];
    /** World position of the local origin all vertex positions are relative to. */
    origin: [number, number, number];
    /** Coarsest level first, matching file order. */
    levels: SbvgLevel[];
    /** Total file size implied by the level table. */
    fileBytes: number;
}

export class SbvgFormatError extends Error {}

/** Bytes needed before `parseSbvgHeader` can succeed (0 when the first 16 bytes are not yet known). */
export function sbvgHeaderBytesNeeded(prefix: Uint8Array): number {
    if (prefix.byteLength < 16) return 0;
    const view = new DataView(prefix.buffer, prefix.byteOffset, prefix.byteLength);
    return view.getUint32(8, true);
}

export function parseSbvgHeader(bytes: Uint8Array): SbvgHeader {
    if (bytes.byteLength < SBVG_HEADER_BYTES) throw new SbvgFormatError('sbvg: truncated header');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const u = (word: number) => view.getUint32(word * 4, true);
    const f = (word: number) => view.getFloat32(word * 4, true);
    if (u(0) !== SBVG_MAGIC) throw new SbvgFormatError('sbvg: bad magic (not a virtual geometry file)');
    const version = u(1);
    if (version < 1 || version > 6) {
        throw new SbvgFormatError(`sbvg: unsupported version ${version} (this reader handles 1 to 6); rebuild the file from its GLB`);
    }
    const vertexBytes = sbvgFileVertexFloats(version) * 4;
    const materialBytesPerTriangle = version >= 3 ? 4 : 0;
    const levelWords = version === 1 ? SBVG_V1_LEVEL_WORDS : SBVG_LEVEL_WORDS;
    // A 64-bit field as a JS number; offsets past 2^53 bytes cannot be addressed and are refused.
    const u64 = (word: number) => {
        const v = u(word) + u(word + 1) * 4294967296;
        if (!Number.isSafeInteger(v)) throw new SbvgFormatError('sbvg: offset beyond 2^53 bytes');
        return v;
    };
    const headerBytes = u(2);
    const levelCount = u(3);
    if (headerBytes !== SBVG_HEADER_BYTES + levelCount * levelWords * 4) throw new SbvgFormatError('sbvg: inconsistent header size');
    if (bytes.byteLength < headerBytes) throw new SbvgFormatError('sbvg: truncated level table');

    const levels: SbvgLevel[] = [];
    let fileBytes = headerBytes;
    for (let i = 0; i < levelCount; i++) {
        const w = SBVG_HEADER_BYTES / 4 + i * levelWords;
        const level: SbvgLevel = {
            level: u(w), clusterStart: u(w + 1), clusterCount: u(w + 2),
            vertexStart: u(w + 3), vertexCount: u(w + 4),
            refStart: u(w + 5), refCount: u(w + 6),
            triangleStart: u(w + 7), triangleCount: u(w + 8),
            byteOffset: version === 1 ? u(w + 9) : u64(w + 9),
            byteLength: version === 1 ? u(w + 10) : u64(w + 11)
        };
        const expected = level.clusterCount * SBVG_CLUSTER_BYTES + level.vertexCount * vertexBytes + level.refCount * 4 + level.triangleCount * (4 + materialBytesPerTriangle);
        if (expected !== level.byteLength) throw new SbvgFormatError(`sbvg: level ${level.level} block size mismatch`);
        fileBytes = Math.max(fileBytes, level.byteOffset + level.byteLength);
        levels.push(level);
    }
    // Version 4 appends the atlas table after the level blocks; the header says where the file ends.
    if (version >= 4) fileBytes = Math.max(fileBytes, u64(30));
    return {
        version,
        headerBytes,
        levelCount,
        vertexCount: u(4),
        clusterCount: u(5),
        refCount: u(6),
        triangleCount: u(7),
        leafTriangleCount: u(8),
        sourceTriangleCount: u(9),
        skippedPrimitives: version === 1 ? 0 : u(24),
        droppedDegenerate: version === 1 ? 0 : u(25),
        materialCount: version >= 3 ? u(26) : 0,
        atlasCount: version >= 4 ? u(27) : 0,
        maxClusterVertices: u(10),
        maxClusterTriangles: u(11),
        aabbMin: [f(12), f(13), f(14)],
        aabbMax: [f(15), f(16), f(17)],
        origin: [view.getFloat64(72, true), view.getFloat64(80, true), view.getFloat64(88, true)],
        levels,
        fileBytes
    };
}

/**
 * The sections of one level block, as views into `block` (which starts at level.byteOffset).
 * `vertices` always holds SBVG_VERTEX_FLOATS floats per vertex: a file older than version 3 is
 * repacked with uv (0, 0), so renderers see one layout. `materials` is empty before version 3.
 */
export function splitSbvgLevelBlock(level: SbvgLevel, block: Uint8Array, version: number = SBVG_VERSION) {
    if (block.byteLength < level.byteLength) throw new SbvgFormatError(`sbvg: level ${level.level} block truncated`);
    let at = block.byteOffset;
    const take = (bytes: number) => {
        const view = new Uint8Array(block.buffer, at, bytes);
        at += bytes;
        return view;
    };
    const fileFloats = sbvgFileVertexFloats(version);
    const clusters = take(level.clusterCount * SBVG_CLUSTER_BYTES);
    let vertices = take(level.vertexCount * fileFloats * 4);
    if (fileFloats !== SBVG_VERTEX_FLOATS) {
        const src = new Float32Array(vertices.buffer, vertices.byteOffset, level.vertexCount * fileFloats);
        const dst = new Float32Array(level.vertexCount * SBVG_VERTEX_FLOATS);
        for (let v = 0; v < level.vertexCount; v++) dst.set(src.subarray(v * fileFloats, v * fileFloats + fileFloats), v * SBVG_VERTEX_FLOATS);
        vertices = new Uint8Array(dst.buffer);
    }
    const refs = take(level.refCount * 4);
    const triangles = take(level.triangleCount * 4);
    const materials = version >= 3 ? take(level.triangleCount * 4) : new Uint8Array(0);
    return { clusters, vertices, refs, triangles, materials };
}
