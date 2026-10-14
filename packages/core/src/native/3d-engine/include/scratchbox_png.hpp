/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

#ifndef SCRATCHBOX_PNG_HPP
#define SCRATCHBOX_PNG_HPP

#include "scratchbox_texture.hpp"
#include <vector>
#include <string>
#include <cstdint>
#include <cstring>
#include <cmath>
#include <algorithm>
#include <zlib.h>

namespace scratchbox {
namespace png {

enum class OutputFormat {
    Auto,
    Rgb,
    Rgba,
    Luma
};

struct DecodeResult {
    bool ok{false};
    std::string error;
    texture::ImageBuffer image;
};

namespace detail {

inline uint32_t readBE32(const uint8_t* p) {
    return (static_cast<uint32_t>(p[0]) << 24) |
           (static_cast<uint32_t>(p[1]) << 16) |
           (static_cast<uint32_t>(p[2]) << 8)  |
            static_cast<uint32_t>(p[3]);
}

inline uint8_t paethPredictor(int a, int b, int c) {
    int p = a + b - c;
    int pa = std::abs(p - a);
    int pb = std::abs(p - b);
    int pc = std::abs(p - c);
    if (pa <= pb && pa <= pc) return static_cast<uint8_t>(a);
    if (pb <= pc) return static_cast<uint8_t>(b);
    return static_cast<uint8_t>(c);
}

} // namespace detail

/**
 * High-performance, RFC-compliant PNG decoder powered by zlib inflate.
 * Supports Color Types:
 *   0: Grayscale (8-bit)
 *   2: Truecolor RGB (8-bit)
 *   3: Indexed / Palette (8-bit)
 *   4: Grayscale + Alpha (8-bit)
 *   6: Truecolor RGBA (8-bit)
 */
inline DecodeResult decode(const uint8_t* data, size_t size, OutputFormat format = OutputFormat::Rgb) {
    DecodeResult res;
    if (!data || size < 29) {
        res.error = "data too small to be a valid PNG";
        return res;
    }

    // Verify PNG signature
    const uint8_t signature[8] = {0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A};
    if (std::memcmp(data, signature, 8) != 0) {
        res.error = "invalid PNG signature";
        return res;
    }

    size_t offset = 8;
    int width = 0;
    int height = 0;
    int bitDepth = 0;
    int colorType = -1;
    bool hasIhdr = false;

    std::vector<uint8_t> palette;
    std::vector<uint8_t> idatStream;

    while (offset + 8 <= size) {
        uint32_t chunkLen = detail::readBE32(data + offset);
        const char* chunkType = reinterpret_cast<const char*>(data + offset + 4);
        offset += 8;

        if (offset + chunkLen + 4 > size) {
            res.error = "truncated PNG chunk";
            return res;
        }

        const uint8_t* chunkData = data + offset;

        if (std::memcmp(chunkType, "IHDR", 4) == 0) {
            if (chunkLen < 13) {
                res.error = "corrupted IHDR chunk";
                return res;
            }
            width = static_cast<int>(detail::readBE32(chunkData));
            height = static_cast<int>(detail::readBE32(chunkData + 4));
            bitDepth = chunkData[8];
            colorType = chunkData[9];
            int compression = chunkData[10];
            int filter = chunkData[11];
            int interlace = chunkData[12];

            if (width <= 0 || height <= 0 || width > 16384 || height > 16384) {
                res.error = "unsupported image dimensions";
                return res;
            }
            if (bitDepth != 8) {
                res.error = "only 8-bit PNGs are supported";
                return res;
            }
            if (compression != 0 || filter != 0) {
                res.error = "unsupported compression or filter method";
                return res;
            }
            if (interlace != 0) {
                res.error = "interlaced PNGs are not supported";
                return res;
            }
            hasIhdr = true;
        } else if (std::memcmp(chunkType, "PLTE", 4) == 0) {
            palette.assign(chunkData, chunkData + chunkLen);
        } else if (std::memcmp(chunkType, "IDAT", 4) == 0) {
            idatStream.insert(idatStream.end(), chunkData, chunkData + chunkLen);
        } else if (std::memcmp(chunkType, "IEND", 4) == 0) {
            break;
        }

        offset += chunkLen + 4; // skip data + 4-byte CRC
    }

    if (!hasIhdr || idatStream.empty()) {
        res.error = "missing IHDR or IDAT chunks";
        return res;
    }

    int srcChannels = 0;
    switch (colorType) {
        case 0: srcChannels = 1; break; // Grayscale
        case 2: srcChannels = 3; break; // RGB
        case 3: srcChannels = 1; break; // Indexed
        case 4: srcChannels = 2; break; // Gray + Alpha
        case 6: srcChannels = 4; break; // RGBA
        default:
            res.error = "unsupported PNG color type: " + std::to_string(colorType);
            return res;
    }

    size_t scanlineBytes = static_cast<size_t>(width * srcChannels);
    size_t expectedUncompressedLen = static_cast<size_t>(height) * (1 + scanlineBytes);
    std::vector<uint8_t> uncompressed(expectedUncompressedLen);

    uLongf destLen = static_cast<uLongf>(expectedUncompressedLen);
    int zerr = uncompress(uncompressed.data(), &destLen, idatStream.data(), static_cast<uLong>(idatStream.size()));
    if (zerr != Z_OK || destLen != expectedUncompressedLen) {
        res.error = "zlib inflate failed on IDAT stream (code " + std::to_string(zerr) + ")";
        return res;
    }

    // Determine target format
    int outChannels = 3;
    if (format == OutputFormat::Rgba) {
        outChannels = 4;
    } else if (format == OutputFormat::Luma) {
        outChannels = 1;
    } else if (format == OutputFormat::Auto) {
        outChannels = (colorType == 6 || colorType == 4) ? 4 : (colorType == 0 ? 1 : 3);
    } else {
        outChannels = 3; // Rgb default
    }

    res.image = texture::ImageBuffer(width, height, outChannels);
    uint8_t* outPixels = res.image.data.data();

    std::vector<uint8_t> priorScanline(scanlineBytes, 0);
    std::vector<uint8_t> currentScanline(scanlineBytes, 0);

    const uint8_t* srcPtr = uncompressed.data();

    for (int y = 0; y < height; ++y) {
        uint8_t filterType = *srcPtr++;

        for (size_t x = 0; x < scanlineBytes; ++x) {
            uint8_t raw = *srcPtr++;
            uint8_t a = (x >= static_cast<size_t>(srcChannels)) ? currentScanline[x - srcChannels] : 0;
            uint8_t b = priorScanline[x];
            uint8_t c = (x >= static_cast<size_t>(srcChannels)) ? priorScanline[x - srcChannels] : 0;

            uint8_t filtered = 0;
            switch (filterType) {
                case 0: // None
                    filtered = raw;
                    break;
                case 1: // Sub
                    filtered = static_cast<uint8_t>(raw + a);
                    break;
                case 2: // Up
                    filtered = static_cast<uint8_t>(raw + b);
                    break;
                case 3: // Average
                    filtered = static_cast<uint8_t>(raw + ((a + b) >> 1));
                    break;
                case 4: // Paeth
                    filtered = static_cast<uint8_t>(raw + detail::paethPredictor(a, b, c));
                    break;
                default:
                    filtered = raw;
                    break;
            }
            currentScanline[x] = filtered;
        }

        // Copy / convert currentScanline to outPixels
        size_t rowDstOffset = static_cast<size_t>(y * width * outChannels);
        uint8_t* dstRow = outPixels + rowDstOffset;

        for (int x = 0; x < width; ++x) {
            uint8_t r = 0, g = 0, b = 0, a = 255;

            if (colorType == 0) { // Grayscale
                r = g = b = currentScanline[x];
            } else if (colorType == 2) { // RGB
                r = currentScanline[x * 3];
                g = currentScanline[x * 3 + 1];
                b = currentScanline[x * 3 + 2];
            } else if (colorType == 3) { // Palette
                size_t palIdx = static_cast<size_t>(currentScanline[x]) * 3;
                if (palIdx + 2 < palette.size()) {
                    r = palette[palIdx];
                    g = palette[palIdx + 1];
                    b = palette[palIdx + 2];
                }
            } else if (colorType == 4) { // Grayscale + Alpha
                r = g = b = currentScanline[x * 2];
                a = currentScanline[x * 2 + 1];
            } else if (colorType == 6) { // RGBA
                r = currentScanline[x * 4];
                g = currentScanline[x * 4 + 1];
                b = currentScanline[x * 4 + 2];
                a = currentScanline[x * 4 + 3];
            }

            if (outChannels == 3) {
                dstRow[x * 3]     = r;
                dstRow[x * 3 + 1] = g;
                dstRow[x * 3 + 2] = b;
            } else if (outChannels == 4) {
                dstRow[x * 4]     = r;
                dstRow[x * 4 + 1] = g;
                dstRow[x * 4 + 2] = b;
                dstRow[x * 4 + 3] = a;
            } else if (outChannels == 1) {
                // Grayscale sources pass through exactly; otherwise round, since the
                // float weights can land just under an integer (52 -> 51.999 -> 51).
                dstRow[x] = (r == g && g == b) ? r : static_cast<uint8_t>(0.2126f * r + 0.7152f * g + 0.0722f * b + 0.5f);
            }
        }

        priorScanline = currentScanline;
    }

    res.ok = true;
    return res;
}

/**
 * Compressed PNG encoder (zlib deflate + per-scanline adaptive filtering).
 * texture::encodePng stays dependency-free and writes stored blocks; use this
 * where the build links zlib and output size matters (e.g. textures in GLBs).
 */
inline std::vector<uint8_t> encode(const texture::ImageBuffer& img, int level = 6) {
    if (img.empty() || (img.channels != 1 && img.channels != 3 && img.channels != 4)) return {};

    const size_t bpp = static_cast<size_t>(img.channels);
    const size_t rowLen = static_cast<size_t>(img.width) * bpp;
    std::vector<uint8_t> filtered;
    filtered.reserve(static_cast<size_t>(img.height) * (rowLen + 1));

    std::vector<uint8_t> candidate(rowLen), best(rowLen);
    const std::vector<uint8_t> zeroRow(rowLen, 0);
    for (int y = 0; y < img.height; ++y) {
        const uint8_t* cur = img.data.data() + static_cast<size_t>(y) * rowLen;
        const uint8_t* up = y > 0 ? cur - rowLen : zeroRow.data();
        uint8_t bestType = 0;
        uint64_t bestCost = UINT64_MAX;
        // PNG filter types 0..4; keep the one with the smallest sum of |signed residual|.
        for (uint8_t type = 0; type <= 4; ++type) {
            uint64_t cost = 0;
            for (size_t i = 0; i < rowLen; ++i) {
                int a = i >= bpp ? cur[i - bpp] : 0;
                int b = up[i];
                int c = i >= bpp ? up[i - bpp] : 0;
                int pred = type == 0 ? 0 : type == 1 ? a : type == 2 ? b : type == 3 ? (a + b) / 2 : detail::paethPredictor(a, b, c);
                uint8_t r = static_cast<uint8_t>(cur[i] - pred);
                candidate[i] = r;
                cost += static_cast<uint64_t>(std::abs(static_cast<int8_t>(r)));
            }
            if (cost < bestCost) {
                bestCost = cost;
                bestType = type;
                best.swap(candidate);
                candidate.resize(rowLen);
            }
        }
        filtered.push_back(bestType);
        filtered.insert(filtered.end(), best.begin(), best.end());
    }

    uLongf compLen = compressBound(static_cast<uLong>(filtered.size()));
    std::vector<uint8_t> idat(compLen);
    if (compress2(idat.data(), &compLen, filtered.data(), static_cast<uLong>(filtered.size()), level) != Z_OK) return {};
    idat.resize(compLen);

    std::vector<uint8_t> out = {0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A};
    auto be32 = [&](uint32_t v) {
        out.push_back(static_cast<uint8_t>(v >> 24)); out.push_back(static_cast<uint8_t>(v >> 16));
        out.push_back(static_cast<uint8_t>(v >> 8));  out.push_back(static_cast<uint8_t>(v));
    };
    auto chunk = [&](const char* type, const uint8_t* data, size_t len) {
        be32(static_cast<uint32_t>(len));
        size_t start = out.size();
        out.insert(out.end(), type, type + 4);
        if (len) out.insert(out.end(), data, data + len);
        be32(static_cast<uint32_t>(crc32(0L, out.data() + start, static_cast<uInt>(len + 4))));
    };
    uint8_t ihdr[13] = {
        static_cast<uint8_t>(img.width >> 24), static_cast<uint8_t>(img.width >> 16),
        static_cast<uint8_t>(img.width >> 8), static_cast<uint8_t>(img.width),
        static_cast<uint8_t>(img.height >> 24), static_cast<uint8_t>(img.height >> 16),
        static_cast<uint8_t>(img.height >> 8), static_cast<uint8_t>(img.height),
        8, static_cast<uint8_t>(img.channels == 4 ? 6 : img.channels == 3 ? 2 : 0), 0, 0, 0
    };
    chunk("IHDR", ihdr, sizeof(ihdr));
    chunk("IDAT", idat.data(), idat.size());
    chunk("IEND", nullptr, 0);
    return out;
}

} // namespace png
} // namespace scratchbox

#endif // SCRATCHBOX_PNG_HPP
