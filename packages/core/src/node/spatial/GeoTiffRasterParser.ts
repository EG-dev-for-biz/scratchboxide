/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as zlib from 'zlib';
import { GeoTiffRasterMetadata } from '../../common/spatial/GoogleSolarDataLayersTypes';

/**
 * Standard TIFF Tag IDs
 */
export const TIFF_TAGS = {
  ImageWidth: 256,
  ImageLength: 257,
  BitsPerSample: 258,
  Compression: 259,
  PhotometricInterpretation: 262,
  StripOffsets: 273,
  SamplesPerPixel: 277,
  RowsPerStrip: 278,
  StripByteCounts: 279,
  PlanarConfiguration: 284,
  SampleFormat: 339,
  ModelPixelScale: 33550,
  ModelTiepoint: 33922,
  GeoKeyDirectory: 34735,
  GDALNoData: 42113
};

/**
 * TIFF Field Data Types
 */
export const TIFF_TYPES = {
  BYTE: 1,
  ASCII: 2,
  SHORT: 3,
  LONG: 4,
  RATIONAL: 5,
  SBYTE: 6,
  UNDEFINED: 7,
  SSHORT: 8,
  SLONG: 9,
  SRATIONAL: 10,
  FLOAT: 11,
  DOUBLE: 12
};

export interface DecodedTiffIfd {
  width: number;
  height: number;
  bitsPerSample: number[];
  compression: number;
  samplesPerPixel: number;
  sampleFormat: number[];
  stripOffsets: number[];
  stripByteCounts: number[];
  rowsPerStrip: number;
  planarConfig: number;
  modelPixelScale?: [number, number, number];
  modelTiepoint?: [number, number, number, number, number, number];
  noDataValue?: number;
}

/**
 * High-performance, zero-external-dependency GeoTIFF raster decoder and builder.
 */
export class GeoTiffRasterParser {
  /**
   * Parse a TIFF buffer header and Image File Directory (IFD).
   */
  public static parseIfd(buffer: Buffer): { ifd: DecodedTiffIfd; isLittleEndian: boolean } {
    if (buffer.length < 8) {
      throw new Error('Invalid TIFF buffer: length is less than 8 bytes');
    }

    // 1. Byte order check
    const byteOrder = buffer.toString('ascii', 0, 2);
    let isLittleEndian: boolean;
    if (byteOrder === 'II') {
      isLittleEndian = true;
    } else if (byteOrder === 'MM') {
      isLittleEndian = false;
    } else {
      throw new Error(`Invalid TIFF byte order indicator: "${byteOrder}"`);
    }

    // 2. Magic number verification (42)
    const magic = isLittleEndian ? buffer.readUInt16LE(2) : buffer.readUInt16BE(2);
    if (magic !== 42) {
      throw new Error(`Invalid TIFF magic number: ${magic} (expected 42)`);
    }

    // 3. First IFD offset
    const firstIfdOffset = isLittleEndian ? buffer.readUInt32LE(4) : buffer.readUInt32BE(4);
    if (firstIfdOffset >= buffer.length) {
      throw new Error(`Invalid IFD offset: ${firstIfdOffset} exceeds buffer size ${buffer.length}`);
    }

    // 4. Read IFD entries
    let offset = firstIfdOffset;
    const numEntries = isLittleEndian ? buffer.readUInt16LE(offset) : buffer.readUInt16BE(offset);
    offset += 2;

    const readVal = (type: number, dataOffset: number): number => {
      switch (type) {
        case TIFF_TYPES.BYTE:
          return buffer.readUInt8(dataOffset);
        case TIFF_TYPES.SHORT:
          return isLittleEndian ? buffer.readUInt16LE(dataOffset) : buffer.readUInt16BE(dataOffset);
        case TIFF_TYPES.LONG:
          return isLittleEndian ? buffer.readUInt32LE(dataOffset) : buffer.readUInt32BE(dataOffset);
        case TIFF_TYPES.FLOAT:
          return isLittleEndian ? buffer.readFloatLE(dataOffset) : buffer.readFloatBE(dataOffset);
        case TIFF_TYPES.DOUBLE:
          return isLittleEndian ? buffer.readDoubleLE(dataOffset) : buffer.readDoubleBE(dataOffset);
        default:
          return isLittleEndian ? buffer.readUInt32LE(dataOffset) : buffer.readUInt32BE(dataOffset);
      }
    };

    const readArray = (type: number, count: number, valOrOffset: number): number[] => {
      const typeSize = this.getTypeSize(type);
      const totalBytes = count * typeSize;
      const targetOffset = totalBytes <= 4 ? offset - 4 : valOrOffset;

      const result: number[] = [];
      for (let i = 0; i < count; i++) {
        const itemOffset = targetOffset + i * typeSize;
        if (itemOffset + typeSize <= buffer.length) {
          result.push(readVal(type, itemOffset));
        }
      }
      return result;
    };

    const tags = new Map<number, { type: number; count: number; value: any }>();

    for (let i = 0; i < numEntries; i++) {
      if (offset + 12 > buffer.length) break;
      const tag = isLittleEndian ? buffer.readUInt16LE(offset) : buffer.readUInt16BE(offset);
      const type = isLittleEndian ? buffer.readUInt16LE(offset + 2) : buffer.readUInt16BE(offset + 2);
      const count = isLittleEndian ? buffer.readUInt32LE(offset + 4) : buffer.readUInt32BE(offset + 4);
      const valOrOffset = isLittleEndian ? buffer.readUInt32LE(offset + 8) : buffer.readUInt32BE(offset + 8);
      offset += 12;

      const typeSize = this.getTypeSize(type);
      let parsedValue: any;

      if (count === 1 && typeSize <= 4) {
        parsedValue = valOrOffset;
      } else if (type === TIFF_TYPES.ASCII) {
        const strOffset = count <= 4 ? offset - 4 : valOrOffset;
        parsedValue = buffer.toString('ascii', strOffset, Math.min(buffer.length, strOffset + count)).replace(/\0+$/, '');
      } else {
        parsedValue = readArray(type, count, valOrOffset);
      }

      tags.set(tag, { type, count, value: parsedValue });
    }

    const width = tags.get(TIFF_TAGS.ImageWidth)?.value || 0;
    const height = tags.get(TIFF_TAGS.ImageLength)?.value || 0;
    const bitsPerSampleRaw = tags.get(TIFF_TAGS.BitsPerSample)?.value ?? 8;
    const bitsPerSample = Array.isArray(bitsPerSampleRaw) ? bitsPerSampleRaw : [bitsPerSampleRaw];
    const compression = tags.get(TIFF_TAGS.Compression)?.value ?? 1;
    const samplesPerPixel = tags.get(TIFF_TAGS.SamplesPerPixel)?.value ?? 1;
    const sampleFormatRaw = tags.get(TIFF_TAGS.SampleFormat)?.value ?? 1;
    const sampleFormat = Array.isArray(sampleFormatRaw) ? sampleFormatRaw : [sampleFormatRaw];

    const stripOffsetsRaw = tags.get(TIFF_TAGS.StripOffsets)?.value ?? [];
    const stripOffsets = Array.isArray(stripOffsetsRaw) ? stripOffsetsRaw : [stripOffsetsRaw];

    const stripByteCountsRaw = tags.get(TIFF_TAGS.StripByteCounts)?.value ?? [];
    const stripByteCounts = Array.isArray(stripByteCountsRaw) ? stripByteCountsRaw : [stripByteCountsRaw];

    const rowsPerStrip = tags.get(TIFF_TAGS.RowsPerStrip)?.value ?? height;
    const planarConfig = tags.get(TIFF_TAGS.PlanarConfiguration)?.value ?? 1;

    const pixelScale = tags.get(TIFF_TAGS.ModelPixelScale)?.value as [number, number, number] | undefined;
    const tiepoint = tags.get(TIFF_TAGS.ModelTiepoint)?.value as [number, number, number, number, number, number] | undefined;

    let noDataValue: number | undefined;
    const noDataTag = tags.get(TIFF_TAGS.GDALNoData);
    if (noDataTag && typeof noDataTag.value === 'string') {
      noDataValue = parseFloat(noDataTag.value);
    }

    const ifd: DecodedTiffIfd = {
      width,
      height,
      bitsPerSample,
      compression,
      samplesPerPixel,
      sampleFormat,
      stripOffsets,
      stripByteCounts,
      rowsPerStrip,
      planarConfig,
      modelPixelScale: pixelScale,
      modelTiepoint: tiepoint,
      noDataValue
    };

    return { ifd, isLittleEndian };
  }

  /**
   * Extract decompressed raw bytes across all strips in the TIFF image.
   */
  public static extractRawBytes(buffer: Buffer, ifd: DecodedTiffIfd): Buffer {
    const decompressedStrips: Buffer[] = [];

    for (let i = 0; i < ifd.stripOffsets.length; i++) {
      const offset = ifd.stripOffsets[i];
      const byteCount = ifd.stripByteCounts[i];
      const slice = buffer.subarray(offset, offset + byteCount);

      if (ifd.compression === 1) {
        // Uncompressed (RAW)
        decompressedStrips.push(slice);
      } else if (ifd.compression === 8 || ifd.compression === 32946) {
        // Deflate / zlib
        decompressedStrips.push(zlib.inflateSync(slice));
      } else {
        throw new Error(`Unsupported TIFF compression format: ${ifd.compression}`);
      }
    }

    return Buffer.concat(decompressedStrips);
  }

  /**
   * Decode GeoTIFF metadata from parsed IFD tags.
   */
  public static buildMetadata(ifd: DecodedTiffIfd): GeoTiffRasterMetadata {
    const scaleX = ifd.modelPixelScale ? ifd.modelPixelScale[0] : 0.1;
    const scaleY = ifd.modelPixelScale ? ifd.modelPixelScale[1] : 0.1;
    const scaleZ = ifd.modelPixelScale ? ifd.modelPixelScale[2] : 1.0;

    const tieX = ifd.modelTiepoint ? ifd.modelTiepoint[3] : 0.0;
    const tieY = ifd.modelTiepoint ? ifd.modelTiepoint[4] : 0.0;
    const tieZ = ifd.modelTiepoint ? ifd.modelTiepoint[5] : 0.0;

    const eastSpan = ifd.width * scaleX;
    const northSpan = ifd.height * scaleY;

    // Standard GeoTIFF tie point convention: top-left corner is (tieX, tieY)
    const swLat = tieY - northSpan;
    const swLng = tieX;
    const neLat = tieY;
    const neLng = tieX + eastSpan;

    return {
      width: ifd.width,
      height: ifd.height,
      pixelScale: { scaleX, scaleY, scaleZ },
      tiePoint: {
        i: ifd.modelTiepoint ? ifd.modelTiepoint[0] : 0,
        j: ifd.modelTiepoint ? ifd.modelTiepoint[1] : 0,
        k: ifd.modelTiepoint ? ifd.modelTiepoint[2] : 0,
        x: tieX,
        y: tieY,
        z: tieZ
      },
      boundingBox: {
        sw: { latitude: swLat, longitude: swLng },
        ne: { latitude: neLat, longitude: neLng }
      },
      noDataValue: ifd.noDataValue ?? -9999
    };
  }

  /**
   * Decode a 32-bit floating point Digital Surface Model (DSM) GeoTIFF.
   */
  public static decodeFloat32Dsm(buffer: Buffer): {
    data: Float32Array;
    width: number;
    height: number;
    metadata: GeoTiffRasterMetadata;
  } {
    const { ifd, isLittleEndian } = this.parseIfd(buffer);
    const rawBytes = this.extractRawBytes(buffer, ifd);
    const numPixels = ifd.width * ifd.height;
    const data = new Float32Array(numPixels);

    if (isLittleEndian) {
      for (let i = 0; i < numPixels; i++) {
        data[i] = rawBytes.readFloatLE(i * 4);
      }
    } else {
      for (let i = 0; i < numPixels; i++) {
        data[i] = rawBytes.readFloatBE(i * 4);
      }
    }

    const metadata = this.buildMetadata(ifd);
    return { data, width: ifd.width, height: ifd.height, metadata };
  }

  /**
   * Decode an 8-bit 3-channel RGB aerial/satellite orthophoto GeoTIFF.
   */
  public static decodeRgbOrthophoto(buffer: Buffer): {
    r: Uint8Array;
    g: Uint8Array;
    b: Uint8Array;
    width: number;
    height: number;
    metadata: GeoTiffRasterMetadata;
  } {
    const { ifd } = this.parseIfd(buffer);
    const rawBytes = this.extractRawBytes(buffer, ifd);
    const numPixels = ifd.width * ifd.height;

    const r = new Uint8Array(numPixels);
    const g = new Uint8Array(numPixels);
    const b = new Uint8Array(numPixels);

    if (ifd.planarConfig === 2) {
      // Planar RGB (RRR... GGG... BBB...)
      r.set(rawBytes.subarray(0, numPixels));
      g.set(rawBytes.subarray(numPixels, numPixels * 2));
      b.set(rawBytes.subarray(numPixels * 2, numPixels * 3));
    } else {
      // Interleaved RGB (RGBRGBRGB...)
      const stride = ifd.samplesPerPixel >= 3 ? ifd.samplesPerPixel : 3;
      for (let i = 0; i < numPixels; i++) {
        const offset = i * stride;
        r[i] = rawBytes[offset];
        g[i] = rawBytes[offset + 1];
        b[i] = rawBytes[offset + 2];
      }
    }

    const metadata = this.buildMetadata(ifd);
    return { r, g, b, width: ifd.width, height: ifd.height, metadata };
  }

  /**
   * Decode a 1-bit or 8-bit building mask raster (1 = rooftop, 0 = non-building).
   */
  public static decodeBuildingMask(buffer: Buffer): {
    mask: Uint8Array;
    width: number;
    height: number;
    metadata: GeoTiffRasterMetadata;
  } {
    const { ifd } = this.parseIfd(buffer);
    const rawBytes = this.extractRawBytes(buffer, ifd);
    const numPixels = ifd.width * ifd.height;
    const mask = new Uint8Array(numPixels);

    const bitsPerSample = ifd.bitsPerSample[0] || 8;

    if (bitsPerSample === 1) {
      // 1-bit packed raster: 8 pixels per byte
      const bytesPerRow = Math.ceil(ifd.width / 8);
      for (let y = 0; y < ifd.height; y++) {
        const rowByteOffset = y * bytesPerRow;
        for (let x = 0; x < ifd.width; x++) {
          const byteIndex = rowByteOffset + Math.floor(x / 8);
          const bitIndex = 7 - (x % 8);
          const bit = (rawBytes[byteIndex] >> bitIndex) & 1;
          mask[y * ifd.width + x] = bit;
        }
      }
    } else {
      // Byte per pixel (0 or 255/1)
      for (let i = 0; i < numPixels; i++) {
        mask[i] = rawBytes[i] > 0 ? 1 : 0;
      }
    }

    const metadata = this.buildMetadata(ifd);
    return { mask, width: ifd.width, height: ifd.height, metadata };
  }

  /**
   * Helper to serialize raw arrays into a fully compliant, standardized Little-Endian GeoTIFF Buffer.
   * Useful for generating deterministic offline test fixtures and caching.
   */
  public static encodeGeoTiff(options: {
    width: number;
    height: number;
    data: Float32Array | Uint8Array;
    channels: 1 | 3;
    bitsPerSample: 8 | 32;
    sampleFormat?: 1 | 3; // 1 = uint, 3 = float
    pixelScale?: [number, number, number];
    tiePoint?: [number, number, number, number, number, number];
    compressDeflate?: boolean;
  }): Buffer {
    const { width, height, data, channels, bitsPerSample, sampleFormat = bitsPerSample === 32 ? 3 : 1 } = options;
    const pixelScale = options.pixelScale || [0.1, 0.1, 0.0];
    const tiePoint = options.tiePoint || [0, 0, 0, 12.4923, 41.8902, 0.0];

    // Raw payload bytes
    let rawPayload: Buffer;
    if (data instanceof Float32Array) {
      rawPayload = Buffer.alloc(data.length * 4);
      for (let i = 0; i < data.length; i++) {
        rawPayload.writeFloatLE(data[i], i * 4);
      }
    } else {
      rawPayload = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    }

    const compressionTag = options.compressDeflate ? 8 : 1;
    const stripPayload = options.compressDeflate ? zlib.deflateSync(rawPayload) : rawPayload;

    const entries: Array<{ tag: number; type: number; count: number; valueOrData: number | number[] | string }> = [
      { tag: TIFF_TAGS.ImageWidth, type: TIFF_TYPES.LONG, count: 1, valueOrData: width },
      { tag: TIFF_TAGS.ImageLength, type: TIFF_TYPES.LONG, count: 1, valueOrData: height },
      {
        tag: TIFF_TAGS.BitsPerSample,
        type: TIFF_TYPES.SHORT,
        count: channels,
        valueOrData: channels === 1 ? bitsPerSample : [bitsPerSample, bitsPerSample, bitsPerSample]
      },
      { tag: TIFF_TAGS.Compression, type: TIFF_TYPES.SHORT, count: 1, valueOrData: compressionTag },
      {
        tag: TIFF_TAGS.PhotometricInterpretation,
        type: TIFF_TYPES.SHORT,
        count: 1,
        valueOrData: channels === 3 ? 2 : 1
      },
      { tag: TIFF_TAGS.StripOffsets, type: TIFF_TYPES.LONG, count: 1, valueOrData: 0 }, // Populated later
      { tag: TIFF_TAGS.SamplesPerPixel, type: TIFF_TYPES.SHORT, count: 1, valueOrData: channels },
      { tag: TIFF_TAGS.RowsPerStrip, type: TIFF_TYPES.LONG, count: 1, valueOrData: height },
      { tag: TIFF_TAGS.StripByteCounts, type: TIFF_TYPES.LONG, count: 1, valueOrData: stripPayload.length },
      {
        tag: TIFF_TAGS.SampleFormat,
        type: TIFF_TYPES.SHORT,
        count: channels,
        valueOrData: channels === 1 ? sampleFormat : [sampleFormat, sampleFormat, sampleFormat]
      },
      { tag: TIFF_TAGS.ModelPixelScale, type: TIFF_TYPES.DOUBLE, count: 3, valueOrData: pixelScale },
      { tag: TIFF_TAGS.ModelTiepoint, type: TIFF_TYPES.DOUBLE, count: 6, valueOrData: tiePoint }
    ];

    // Sort entries by tag ID ascending (strictly required by TIFF 6.0 specification)
    entries.sort((a, b) => a.tag - b.tag);

    // Calculate layout:
    // Header: 8 bytes
    // IFD: 2 bytes (count) + 12 * entries.length + 4 bytes (next IFD = 0)
    const ifdOffset = 8;
    const ifdLength = 2 + entries.length * 12 + 4;
    let extraDataOffset = ifdOffset + ifdLength;

    // Pre-calculate extra data offsets (for values > 4 bytes)
    const entryDataBuffers: Buffer[] = [];
    for (const entry of entries) {
      const typeSize = this.getTypeSize(entry.type);
      const totalBytes = entry.count * typeSize;

      if (totalBytes > 4) {
        const buf = Buffer.alloc(totalBytes);
        if (Array.isArray(entry.valueOrData)) {
          const arr = entry.valueOrData as number[];
          for (let i = 0; i < arr.length; i++) {
            if (entry.type === TIFF_TYPES.SHORT) buf.writeUInt16LE(arr[i], i * 2);
            else if (entry.type === TIFF_TYPES.LONG) buf.writeUInt32LE(arr[i], i * 4);
            else if (entry.type === TIFF_TYPES.DOUBLE) buf.writeDoubleLE(arr[i], i * 8);
          }
        }
        entryDataBuffers.push(buf);
      }
    }

    const extraDataLength = entryDataBuffers.reduce((acc, b) => acc + b.length, 0);
    const stripOffset = extraDataOffset + extraDataLength;

    // Update StripOffsets value
    const stripOffsetEntry = entries.find(e => e.tag === TIFF_TAGS.StripOffsets);
    if (stripOffsetEntry) {
      stripOffsetEntry.valueOrData = stripOffset;
    }

    // Allocate final output buffer
    const totalFileSize = stripOffset + stripPayload.length;
    const out = Buffer.alloc(totalFileSize);

    // 1. Header: II + 42 + ifdOffset
    out.write('II', 0, 'ascii');
    out.writeUInt16LE(42, 2);
    out.writeUInt32LE(ifdOffset, 4);

    // 2. IFD entries
    out.writeUInt16LE(entries.length, ifdOffset);
    let entryOffset = ifdOffset + 2;
    let currentExtraOffset = extraDataOffset;

    for (const entry of entries) {
      out.writeUInt16LE(entry.tag, entryOffset);
      out.writeUInt16LE(entry.type, entryOffset + 2);
      out.writeUInt32LE(entry.count, entryOffset + 4);

      const typeSize = this.getTypeSize(entry.type);
      const totalBytes = entry.count * typeSize;

      if (totalBytes <= 4) {
        if (typeof entry.valueOrData === 'number') {
          if (entry.type === TIFF_TYPES.SHORT) out.writeUInt16LE(entry.valueOrData, entryOffset + 8);
          else out.writeUInt32LE(entry.valueOrData, entryOffset + 8);
        }
      } else {
        out.writeUInt32LE(currentExtraOffset, entryOffset + 8);
        const dataBuf = entryDataBuffers.shift()!;
        dataBuf.copy(out, currentExtraOffset);
        currentExtraOffset += dataBuf.length;
      }

      entryOffset += 12;
    }

    // Next IFD = 0
    out.writeUInt32LE(0, entryOffset);

    // 3. Write strip payload
    stripPayload.copy(out, stripOffset);

    return out;
  }

  private static getTypeSize(type: number): number {
    switch (type) {
      case TIFF_TYPES.BYTE:
      case TIFF_TYPES.ASCII:
      case TIFF_TYPES.SBYTE:
      case TIFF_TYPES.UNDEFINED:
        return 1;
      case TIFF_TYPES.SHORT:
      case TIFF_TYPES.SSHORT:
        return 2;
      case TIFF_TYPES.LONG:
      case TIFF_TYPES.SLONG:
      case TIFF_TYPES.FLOAT:
        return 4;
      case TIFF_TYPES.RATIONAL:
      case TIFF_TYPES.SRATIONAL:
      case TIFF_TYPES.DOUBLE:
        return 8;
      default:
        return 4;
    }
  }
}
