/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as fs from 'fs';
import * as path from 'path';

/**
 * Result returned from binary glTF (GLB) packing.
 */
export interface GltfPackingResult {
    /** The complete binary glTF (.glb) buffer ready for disk write or network streaming. */
    glbBuffer: Buffer;
    /** 4-byte aligned start offsets for each bufferView inside the BIN chunk. */
    alignedOffsets: number[];
    /** Total byte length of the padded BIN chunk. */
    totalBinLength: number;
    /** Total byte length of the padded JSON chunk. */
    jsonChunkLength: number;
}

/**
 * Unified Canonical GLB 2.0 Binary Packer.
 *
 * Directives Compliance:
 * - 4-Byte Standard glTF 2.0 Alignment Invariant: Every bufferView in the BIN chunk
 *   is padded to a multiple of 4 bytes.
 * - JSON Chunk Padding: JSON string is padded with spaces (0x20) to a 4-byte boundary.
 * - Zero-Copy Streaming: Assembles glTF header (0x46546C67), JSON chunk (0x4E4F534A),
 *   and BIN chunk (0x004E4942) without third-party dependencies.
 */
export class GltfBinaryPacker {
    /**
     * Packs a glTF JSON structure and an array of raw BufferViews into a standardized .glb buffer.
     *
     * @param gltf glTF JSON document structure.
     * @param bufferViews Array of Buffer slices corresponding to each bufferView index.
     * @param updateBufferViews If true, automatically populates `bufferView.buffer = 0`, `byteOffset`, and `byteLength`.
     */
    public static packGlb(
        gltf: any,
        bufferViews: Buffer[],
        updateBufferViews = true
    ): GltfPackingResult {
        let totalBinLength = 0;
        const alignedOffsets: number[] = [];

        // 1. Calculate 4-byte aligned offsets for every bufferView
        for (let i = 0; i < bufferViews.length; i++) {
            const pad = (4 - (totalBinLength % 4)) % 4;
            totalBinLength += pad;
            alignedOffsets.push(totalBinLength);
            totalBinLength += bufferViews[i].length;
        }

        // 2. Assemble contiguous BIN chunk
        const binChunk = Buffer.alloc(totalBinLength);
        for (let i = 0; i < bufferViews.length; i++) {
            const offset = alignedOffsets[i];
            bufferViews[i].copy(binChunk, offset);

            if (updateBufferViews && gltf.bufferViews && gltf.bufferViews[i]) {
                gltf.bufferViews[i].buffer = 0;
                gltf.bufferViews[i].byteOffset = offset;
                gltf.bufferViews[i].byteLength = bufferViews[i].length;
            }
        }

        gltf.buffers = [{ byteLength: binChunk.length }];

        // 3. Serialize JSON Chunk with 4-byte space padding (0x20)
        let jsonBuf = Buffer.from(JSON.stringify(gltf), 'utf8');
        const jsonPadding = (4 - (jsonBuf.length % 4)) % 4;
        if (jsonPadding > 0) {
            jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc(jsonPadding, 0x20)]);
        }

        // 4. Assemble standard GLB 12-byte header + 2 chunks
        const totalGlbLength = 12 + 8 + jsonBuf.length + 8 + binChunk.length;
        const glbBuffer = Buffer.alloc(totalGlbLength);

        // Header
        glbBuffer.writeUInt32LE(0x46546C67, 0); // Magic: 'glTF'
        glbBuffer.writeUInt32LE(2, 4);          // Version 2
        glbBuffer.writeUInt32LE(totalGlbLength, 8); // Total length

        // Chunk 0: JSON (0x4E4F534A)
        glbBuffer.writeUInt32LE(jsonBuf.length, 12);
        glbBuffer.writeUInt32LE(0x4E4F534A, 16);
        jsonBuf.copy(glbBuffer, 20);

        // Chunk 1: BIN (0x004E4942)
        const binHeaderPos = 20 + jsonBuf.length;
        glbBuffer.writeUInt32LE(binChunk.length, binHeaderPos);
        glbBuffer.writeUInt32LE(0x004E4942, binHeaderPos + 4);
        binChunk.copy(glbBuffer, binHeaderPos + 8);

        return {
            glbBuffer,
            alignedOffsets,
            totalBinLength,
            jsonChunkLength: jsonBuf.length
        };
    }

    /**
     * Packs glTF buffers and writes directly to disk atomically.
     */
    public static writeGlb(
        outputPath: string,
        gltf: any,
        bufferViews: Buffer[],
        updateBufferViews = true
    ): GltfPackingResult {
        const result = this.packGlb(gltf, bufferViews, updateBufferViews);
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        fs.writeFileSync(outputPath, result.glbBuffer);
        return result;
    }
}
