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
export const SBVG_VERSION = 1;
export const SBVG_HEADER_BYTES = 128;
export const SBVG_LEVEL_WORDS = 12;
export const SBVG_CLUSTER_WORDS = 32;
export const SBVG_CLUSTER_BYTES = SBVG_CLUSTER_WORDS * 4;
export const SBVG_VERTEX_FLOATS = 6;
export const SBVG_VERTEX_BYTES = SBVG_VERTEX_FLOATS * 4;

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
    byteOffset: number;
    byteLength: number;
}

export interface SbvgHeader {
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
    if (u(1) !== SBVG_VERSION) throw new SbvgFormatError(`sbvg: unsupported version ${u(1)}`);
    const headerBytes = u(2);
    const levelCount = u(3);
    if (headerBytes !== SBVG_HEADER_BYTES + levelCount * SBVG_LEVEL_WORDS * 4) throw new SbvgFormatError('sbvg: inconsistent header size');
    if (bytes.byteLength < headerBytes) throw new SbvgFormatError('sbvg: truncated level table');

    const levels: SbvgLevel[] = [];
    let fileBytes = headerBytes;
    for (let i = 0; i < levelCount; i++) {
        const w = SBVG_HEADER_BYTES / 4 + i * SBVG_LEVEL_WORDS;
        const level: SbvgLevel = {
            level: u(w), clusterStart: u(w + 1), clusterCount: u(w + 2),
            vertexStart: u(w + 3), vertexCount: u(w + 4),
            refStart: u(w + 5), refCount: u(w + 6),
            triangleStart: u(w + 7), triangleCount: u(w + 8),
            byteOffset: u(w + 9), byteLength: u(w + 10)
        };
        const expected = level.clusterCount * SBVG_CLUSTER_BYTES + level.vertexCount * SBVG_VERTEX_BYTES + (level.refCount + level.triangleCount) * 4;
        if (expected !== level.byteLength) throw new SbvgFormatError(`sbvg: level ${level.level} block size mismatch`);
        fileBytes = Math.max(fileBytes, level.byteOffset + level.byteLength);
        levels.push(level);
    }
    return {
        headerBytes,
        levelCount,
        vertexCount: u(4),
        clusterCount: u(5),
        refCount: u(6),
        triangleCount: u(7),
        leafTriangleCount: u(8),
        sourceTriangleCount: u(9),
        maxClusterVertices: u(10),
        maxClusterTriangles: u(11),
        aabbMin: [f(12), f(13), f(14)],
        aabbMax: [f(15), f(16), f(17)],
        origin: [view.getFloat64(72, true), view.getFloat64(80, true), view.getFloat64(88, true)],
        levels,
        fileBytes
    };
}

/** The four sections of one level block, as views into `block` (which starts at level.byteOffset). */
export function splitSbvgLevelBlock(level: SbvgLevel, block: Uint8Array) {
    if (block.byteLength < level.byteLength) throw new SbvgFormatError(`sbvg: level ${level.level} block truncated`);
    let at = block.byteOffset;
    const take = (bytes: number) => {
        const view = new Uint8Array(block.buffer, at, bytes);
        at += bytes;
        return view;
    };
    return {
        clusters: take(level.clusterCount * SBVG_CLUSTER_BYTES),
        vertices: take(level.vertexCount * SBVG_VERTEX_BYTES),
        refs: take(level.refCount * 4),
        triangles: take(level.triangleCount * 4)
    };
}
