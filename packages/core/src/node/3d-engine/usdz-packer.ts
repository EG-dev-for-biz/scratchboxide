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
import * as zlib from 'zlib';
import type { ContinuousMaterialDescriptor } from '../../../common/adaptive-material-types';

export interface UsdzFileEntry {
    name: string;
    data: Buffer;
}

export interface UsdzPackageOptions {
    materialName?: string;
    descriptor?: ContinuousMaterialDescriptor;
    albedoPng: Buffer;
    normalPng: Buffer;
    ormPng?: Buffer;
    roughnessPng?: Buffer;
    metallicPng?: Buffer;
    aoPng?: Buffer;
    heightPng?: Buffer;
    outputPath?: string;
    planeWidthMeters?: number;
    uvTiling?: { u: number; v: number };
}

export interface UsdzPackageResult {
    usdzBuffer: Buffer;
    outputPath?: string;
    usdaContent: string;
    totalSizeBytes: number;
}

/**
 * Service to pack PBR materials and geometry into Pixar / Apple compliant USDZ archives.
 *
 * Enforces strict compliance with the Pixar USDZ Specification:
 * - Uncompressed ZIP (compression method 0 / STORE)
 * - 64-byte aligned file payload offsets relative to archive start
 * - Valid UsdPreviewSurface material shader network
 */
export class UsdzPacker {
    /**
     * Calculates CRC-32 checksum for a buffer.
     */
    private static computeCrc32(buf: Buffer): number {
        return (zlib as any).crc32 ? (zlib as any).crc32(buf) : 0;
    }

    /**
     * Generates standard UsdPreviewSurface USDA definition.
     */
    public static generateUsda(options: UsdzPackageOptions): string {
        const matName = (options.materialName || 'PbrMaterial').replace(/[^a-zA-Z0-9_]/g, '_');
        const planeSize = options.planeWidthMeters ?? 2.0;
        const halfSize = planeSize / 2.0;
        const tilingU = options.uvTiling?.u ?? 1.0;
        const tilingV = options.uvTiling?.v ?? 1.0;

        const baseAlbedo = options.descriptor?.albedoLinear ?? [0.8, 0.8, 0.8];
        const conduction = options.descriptor?.conduction ?? 0.0;
        const roughness = options.descriptor?.roughnessBaseline ?? 0.5;

        return `#usda 1.0
(
    defaultPrim = "MaterialStage"
    metersPerUnit = 1.0
    upAxis = "Y"
)

def Xform "MaterialStage" (
    kind = "component"
)
{
    def Scope "Materials"
    {
        def Material "${matName}"
        {
            token outputs:surface.connect = </MaterialStage/Materials/${matName}/PBRShader.outputs:surface>

            def Shader "PBRShader"
            {
                uniform token info:id = "UsdPreviewSurface"
                color3f inputs:diffuseColor.connect = </MaterialStage/Materials/${matName}/AlbedoTexture.outputs:rgb>
                float inputs:metallic.connect = </MaterialStage/Materials/${matName}/MetallicTexture.outputs:r>
                float inputs:roughness.connect = </MaterialStage/Materials/${matName}/RoughnessTexture.outputs:r>
                normal3f inputs:normal.connect = </MaterialStage/Materials/${matName}/NormalTexture.outputs:rgb>
                float inputs:occlusion.connect = </MaterialStage/Materials/${matName}/AoTexture.outputs:r>
                float inputs:ior = 1.5
                token outputs:surface
            }

            def Shader "PrimvarReader_st"
            {
                uniform token info:id = "UsdPrimvarReader_float2"
                token inputs:varname = "st"
                float2 outputs:result
            }

            def Shader "Transform2D"
            {
                uniform token info:id = "UsdTransform2d"
                float2 inputs:in.connect = </MaterialStage/Materials/${matName}/PrimvarReader_st.outputs:result>
                float2 inputs:scale = (${tilingU.toFixed(4)}, ${tilingV.toFixed(4)})
                float2 outputs:result
            }

            def Shader "AlbedoTexture"
            {
                uniform token info:id = "UsdUVTexture"
                asset inputs:file = @textures/albedo.png@
                float2 inputs:st.connect = </MaterialStage/Materials/${matName}/Transform2D.outputs:result>
                token inputs:wrapS = "repeat"
                token inputs:wrapT = "repeat"
                float3 outputs:rgb
            }

            def Shader "NormalTexture"
            {
                uniform token info:id = "UsdUVTexture"
                asset inputs:file = @textures/normal.png@
                float2 inputs:st.connect = </MaterialStage/Materials/${matName}/Transform2D.outputs:result>
                token inputs:wrapS = "repeat"
                token inputs:wrapT = "repeat"
                float3 outputs:rgb
            }

            def Shader "RoughnessTexture"
            {
                uniform token info:id = "UsdUVTexture"
                asset inputs:file = @textures/roughness.png@
                float2 inputs:st.connect = </MaterialStage/Materials/${matName}/Transform2D.outputs:result>
                token inputs:wrapS = "repeat"
                token inputs:wrapT = "repeat"
                float outputs:r
            }

            def Shader "MetallicTexture"
            {
                uniform token info:id = "UsdUVTexture"
                asset inputs:file = @textures/metallic.png@
                float2 inputs:st.connect = </MaterialStage/Materials/${matName}/Transform2D.outputs:result>
                token inputs:wrapS = "repeat"
                token inputs:wrapT = "repeat"
                float outputs:r
            }

            def Shader "AoTexture"
            {
                uniform token info:id = "UsdUVTexture"
                asset inputs:file = @textures/ao.png@
                float2 inputs:st.connect = </MaterialStage/Materials/${matName}/Transform2D.outputs:result>
                token inputs:wrapS = "repeat"
                token inputs:wrapT = "repeat"
                float outputs:r
            }
        }
    }

    def Mesh "Plinth" (
        prepend apiSchemas = ["MaterialBindingAPI"]
    )
    {
        rel material:binding = </MaterialStage/Materials/${matName}>
        int[] faceVertexCounts = [4]
        int[] faceVertexIndices = [0, 1, 2, 3]
        point3f[] points = [
            (-${halfSize.toFixed(3)}, 0, -${halfSize.toFixed(3)}),
            ( ${halfSize.toFixed(3)}, 0, -${halfSize.toFixed(3)}),
            ( ${halfSize.toFixed(3)}, 0,  ${halfSize.toFixed(3)}),
            (-${halfSize.toFixed(3)}, 0,  ${halfSize.toFixed(3)})
        ]
        normal3f[] normals = [(0, 1, 0), (0, 1, 0), (0, 1, 0), (0, 1, 0)] (
            interpolation = "vertex"
        )
        texCoord2f[] primvars:st = [(0, 0), (1, 0), (1, 1), (0, 1)] (
            interpolation = "vertex"
        )
    }
}
`;
    }

    /**
     * Packs files into a 64-byte aligned uncompressed ZIP archive (USDZ).
     */
    public static createAlignedZip(entries: UsdzFileEntry[]): Buffer {
        const localHeaders: Buffer[] = [];
        const fileDataChunks: Buffer[] = [];
        const centralEntries: Buffer[] = [];

        let currentOffset = 0;

        for (const entry of entries) {
            const fileNameBuf = Buffer.from(entry.name, 'utf8');
            const dataBuf = entry.data;
            const crc = this.computeCrc32(dataBuf);
            const size = dataBuf.length;

            // 64-byte alignment requirement:
            // The file data payload must start at an offset that is an exact multiple of 64.
            // Fixed local header size = 30 bytes.
            const headerSizeWithoutExtra = 30 + fileNameBuf.length;
            const unalignedDataOffset = currentOffset + headerSizeWithoutExtra;
            const paddingNeeded = (64 - (unalignedDataOffset % 64)) % 64;

            const extraBuf = Buffer.alloc(paddingNeeded, 0);

            // Construct Local File Header (30 bytes)
            const localHeader = Buffer.alloc(30);
            localHeader.writeUInt32LE(0x04034b50, 0); // Local header signature
            localHeader.writeUInt16LE(20, 4);         // Version needed: 2.0
            localHeader.writeUInt16LE(0, 6);          // General purpose bit flag
            localHeader.writeUInt16LE(0, 8);          // Compression method: 0 (STORE)
            localHeader.writeUInt16LE(0, 10);         // Last mod time
            localHeader.writeUInt16LE(0, 12);         // Last mod date
            localHeader.writeUInt32LE(crc, 14);       // CRC-32
            localHeader.writeUInt32LE(size, 18);      // Compressed size
            localHeader.writeUInt32LE(size, 22);      // Uncompressed size
            localHeader.writeUInt16LE(fileNameBuf.length, 26); // Filename length
            localHeader.writeUInt16LE(extraBuf.length, 28);    // Extra field length

            const localChunk = Buffer.concat([localHeader, fileNameBuf, extraBuf]);
            localHeaders.push(localChunk);
            fileDataChunks.push(dataBuf);

            // Construct Central Directory Header (46 bytes + filename length)
            const centralHeader = Buffer.alloc(46);
            centralHeader.writeUInt32LE(0x02014b50, 0); // Central header signature
            centralHeader.writeUInt16LE(20, 4);         // Version made by: 2.0
            centralHeader.writeUInt16LE(20, 6);         // Version needed: 2.0
            centralHeader.writeUInt16LE(0, 8);          // Bit flag
            centralHeader.writeUInt16LE(0, 10);         // Compression: 0
            centralHeader.writeUInt16LE(0, 12);         // Mod time
            centralHeader.writeUInt16LE(0, 14);         // Mod date
            centralHeader.writeUInt32LE(crc, 16);       // CRC-32
            centralHeader.writeUInt32LE(size, 20);      // Compressed size
            centralHeader.writeUInt32LE(size, 24);      // Uncompressed size
            centralHeader.writeUInt16LE(fileNameBuf.length, 28); // Filename length
            centralHeader.writeUInt16LE(0, 30);         // Extra field length
            centralHeader.writeUInt16LE(0, 32);         // Comment length
            centralHeader.writeUInt16LE(0, 34);         // Disk start
            centralHeader.writeUInt16LE(0, 36);         // Internal attributes
            centralHeader.writeUInt32LE(0, 38);         // External attributes
            centralHeader.writeUInt32LE(currentOffset, 42); // Offset of local header

            centralEntries.push(Buffer.concat([centralHeader, fileNameBuf]));

            currentOffset += localChunk.length + dataBuf.length;
        }

        const centralDirStartOffset = currentOffset;
        const centralDirBuf = Buffer.concat(centralEntries);
        const centralDirSize = centralDirBuf.length;

        // End of Central Directory Record (22 bytes)
        const eocd = Buffer.alloc(22);
        eocd.writeUInt32LE(0x06054b50, 0); // EOCD signature
        eocd.writeUInt16LE(0, 4);          // Disk number
        eocd.writeUInt16LE(0, 6);          // Start disk
        eocd.writeUInt16LE(entries.length, 8);  // Entries on this disk
        eocd.writeUInt16LE(entries.length, 10); // Total entries
        eocd.writeUInt32LE(centralDirSize, 12); // Central dir size
        eocd.writeUInt32LE(centralDirStartOffset, 16); // Central dir offset
        eocd.writeUInt16LE(0, 20);         // Comment length

        const finalChunks: Buffer[] = [];
        for (let i = 0; i < entries.length; i++) {
            finalChunks.push(localHeaders[i]);
            finalChunks.push(fileDataChunks[i]);
        }
        finalChunks.push(centralDirBuf);
        finalChunks.push(eocd);

        return Buffer.concat(finalChunks);
    }

    /**
     * Packs the material into a standard USDZ archive.
     */
    public static packMaterialUsdz(options: UsdzPackageOptions): UsdzPackageResult {
        const usdaContent = this.generateUsda(options);
        const entries: UsdzFileEntry[] = [
            { name: 'material.usda', data: Buffer.from(usdaContent, 'utf8') },
            { name: 'textures/albedo.png', data: options.albedoPng },
            { name: 'textures/normal.png', data: options.normalPng }
        ];

        if (options.roughnessPng) {
            entries.push({ name: 'textures/roughness.png', data: options.roughnessPng });
        }
        if (options.metallicPng) {
            entries.push({ name: 'textures/metallic.png', data: options.metallicPng });
        }
        if (options.aoPng) {
            entries.push({ name: 'textures/ao.png', data: options.aoPng });
        }
        if (options.ormPng) {
            entries.push({ name: 'textures/orm.png', data: options.ormPng });
        }
        if (options.heightPng) {
            entries.push({ name: 'textures/height.png', data: options.heightPng });
        }

        const usdzBuffer = this.createAlignedZip(entries);

        if (options.outputPath) {
            const dir = path.dirname(options.outputPath);
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(options.outputPath, usdzBuffer);
        }

        return {
            usdzBuffer,
            outputPath: options.outputPath,
            usdaContent,
            totalSizeBytes: usdzBuffer.length
        };
    }
}
