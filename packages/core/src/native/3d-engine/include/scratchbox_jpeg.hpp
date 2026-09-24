/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

#ifndef SCRATCHBOX_JPEG_HPP
#define SCRATCHBOX_JPEG_HPP

#include "scratchbox_texture.hpp"
#include <algorithm>
#include <array>
#include <climits>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <fstream>
#include <string>
#include <vector>

namespace scratchbox {
namespace jpeg {

enum class OutputFormat {
    Auto, // 1 channel for grayscale files, 3 channels for color files
    Rgb,  // always 3 channels
    Luma  // always 1 channel (the decoded Y plane for color files)
};

struct DecodeResult {
    bool ok{false};
    std::string error;
    texture::ImageBuffer image;
};

namespace detail {

constexpr int kNaturalOrder[64] = {
     0,  1,  8, 16,  9,  2,  3, 10, 17, 24, 32, 25, 18, 11,  4,  5,
    12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13,  6,  7, 14, 21, 28,
    35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51,
    58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63
};

constexpr int kLookupBits = 9;

struct HuffmanTable {
    bool defined{false};
    std::array<uint8_t, 1 << kLookupBits> lookupLength{};
    std::array<uint8_t, 1 << kLookupBits> lookupSymbol{};
    std::array<int32_t, 18> maxCode{};
    std::array<int32_t, 17> valueOffset{};
    std::array<uint8_t, 256> symbols{};

    bool build(const uint8_t counts[16], const uint8_t* values, int valueCount) {
        if (valueCount > 256) return false;
        std::memcpy(symbols.data(), values, static_cast<size_t>(valueCount));
        lookupLength.fill(0);
        lookupSymbol.fill(0);
        int32_t code = 0;
        int k = 0;
        for (int length = 1; length <= 16; ++length) {
            valueOffset[length] = k - code;
            for (int i = 0; i < counts[length - 1]; ++i) {
                if (length <= kLookupBits) {
                    int shift = kLookupBits - length;
                    for (int suffix = 0; suffix < (1 << shift); ++suffix) {
                        int slot = (code << shift) | suffix;
                        lookupLength[slot] = static_cast<uint8_t>(length);
                        lookupSymbol[slot] = symbols[k];
                    }
                }
                ++code;
                ++k;
            }
            maxCode[length] = counts[length - 1] ? code - 1 : -1;
            code <<= 1;
        }
        maxCode[17] = INT32_MAX;
        defined = true;
        return true;
    }
};

struct Component {
    int id{0};
    int h{1};
    int v{1};
    int quantTable{0};
    int dcTable{0};
    int acTable{0};
    int width{0};          // real sample width of this component
    int height{0};         // real sample height of this component
    int blocksPerLine{0};  // padded to whole MCUs
    int blocksPerColumn{0};
    int dcPredictor{0};
    std::vector<uint8_t> plane;
    int stride() const { return blocksPerLine * 8; }
};

class BitReader {
public:
    BitReader(const uint8_t* data, size_t size, size_t pos) : data_(data), size_(size), pos_(pos) {}

    uint32_t peek(int n) {
        if (bits_ < n) fill();
        return buffer_ >> (32 - n);
    }

    void consume(int n) {
        buffer_ <<= n;
        bits_ -= n;
    }

    uint32_t get(int n) {
        if (n == 0) return 0;
        uint32_t value = peek(n);
        consume(n);
        return value;
    }

    int receiveExtend(int s) {
        if (s == 0) return 0;
        int value = static_cast<int>(get(s));
        if (value < (1 << (s - 1))) value = value - (1 << s) + 1;
        return value;
    }

    int decode(const HuffmanTable& table) {
        uint32_t look = peek(kLookupBits);
        int length = table.lookupLength[look];
        if (length) {
            consume(length);
            return table.lookupSymbol[look];
        }
        uint32_t bits16 = peek(16);
        for (int l = kLookupBits + 1; l <= 16; ++l) {
            int32_t code = static_cast<int32_t>(bits16 >> (16 - l));
            if (code <= table.maxCode[l]) {
                consume(l);
                int index = code + table.valueOffset[l];
                if (index < 0 || index > 255) return -1;
                return table.symbols[index];
            }
        }
        return -1;
    }

    // Discards buffered bits and steps over the RSTn marker that ends the current interval.
    bool restart() {
        buffer_ = 0;
        bits_ = 0;
        hitMarker_ = false;
        while (pos_ + 1 < size_) {
            if (data_[pos_] == 0xFF && data_[pos_ + 1] >= 0xD0 && data_[pos_ + 1] <= 0xD7) {
                pos_ += 2;
                return true;
            }
            ++pos_;
        }
        return false;
    }

    size_t position() const { return pos_; }

private:
    void fill() {
        while (bits_ <= 24) {
            uint32_t byte = 0;
            if (!hitMarker_ && pos_ < size_) {
                byte = data_[pos_];
                if (byte == 0xFF) {
                    uint8_t next = pos_ + 1 < size_ ? data_[pos_ + 1] : 0;
                    if (next == 0x00) {
                        pos_ += 2;
                    } else {
                        hitMarker_ = true;
                        byte = 0;
                    }
                } else {
                    ++pos_;
                }
            }
            buffer_ |= byte << (24 - bits_);
            bits_ += 8;
        }
    }

    const uint8_t* data_;
    size_t size_;
    size_t pos_;
    uint32_t buffer_{0};
    int bits_{0};
    bool hitMarker_{false};
};

inline const std::array<float, 64>& idctBasis() {
    static const std::array<float, 64> basis = [] {
        std::array<float, 64> m{};
        for (int x = 0; x < 8; ++x) {
            for (int u = 0; u < 8; ++u) {
                double c = u == 0 ? std::sqrt(0.5) : 1.0;
                m[x * 8 + u] = static_cast<float>(0.5 * c * std::cos((2.0 * x + 1.0) * u * 3.14159265358979323846 / 16.0));
            }
        }
        return m;
    }();
    return basis;
}

inline void inverseDct(const float coeffs[64], uint8_t* out, int stride) {
    bool dcOnly = true;
    for (int i = 1; i < 64; ++i) {
        if (coeffs[i] != 0.0f) {
            dcOnly = false;
            break;
        }
    }
    if (dcOnly) {
        int value = static_cast<int>(std::lround(coeffs[0] / 8.0f + 128.0f));
        uint8_t v = static_cast<uint8_t>(std::clamp(value, 0, 255));
        for (int y = 0; y < 8; ++y) std::memset(out + y * stride, v, 8);
        return;
    }
    const auto& m = idctBasis();
    float rows[64];
    for (int v = 0; v < 8; ++v) {
        const float* f = coeffs + v * 8;
        for (int x = 0; x < 8; ++x) {
            const float* b = m.data() + x * 8;
            rows[v * 8 + x] = b[0] * f[0] + b[1] * f[1] + b[2] * f[2] + b[3] * f[3]
                            + b[4] * f[4] + b[5] * f[5] + b[6] * f[6] + b[7] * f[7];
        }
    }
    for (int y = 0; y < 8; ++y) {
        const float* b = m.data() + y * 8;
        for (int x = 0; x < 8; ++x) {
            float sum = b[0] * rows[x] + b[1] * rows[8 + x] + b[2] * rows[16 + x] + b[3] * rows[24 + x]
                      + b[4] * rows[32 + x] + b[5] * rows[40 + x] + b[6] * rows[48 + x] + b[7] * rows[56 + x];
            int value = static_cast<int>(std::lround(sum + 128.0f));
            out[y * stride + x] = static_cast<uint8_t>(std::clamp(value, 0, 255));
        }
    }
}

// Triangle-filter chroma reconstruction for 2x2 subsampling, bit-matching the classic libjpeg filter.
inline std::vector<uint8_t> upsampleH2V2(const Component& c, int outWidth, int outHeight) {
    std::vector<uint8_t> out(static_cast<size_t>(outWidth) * outHeight);
    const int w = c.width;
    const int h = c.height;
    const int stride = c.stride();
    std::vector<int> colsum(static_cast<size_t>(w));
    for (int oy = 0; oy < outHeight; ++oy) {
        int row = std::min(oy / 2, h - 1);
        int farRow = (oy & 1) ? std::min(row + 1, h - 1) : std::max(row - 1, 0);
        const uint8_t* nearPtr = c.plane.data() + static_cast<size_t>(row) * stride;
        const uint8_t* farPtr = c.plane.data() + static_cast<size_t>(farRow) * stride;
        for (int x = 0; x < w; ++x) colsum[x] = nearPtr[x] * 3 + farPtr[x];
        uint8_t* dst = out.data() + static_cast<size_t>(oy) * outWidth;
        auto put = [&](int ox, int value) {
            if (ox < outWidth) dst[ox] = static_cast<uint8_t>(value);
        };
        if (w == 1) {
            put(0, (colsum[0] * 4 + 8) >> 4);
            put(1, (colsum[0] * 4 + 7) >> 4);
            continue;
        }
        put(0, (colsum[0] * 4 + 8) >> 4);
        put(1, (colsum[0] * 3 + colsum[1] + 7) >> 4);
        for (int x = 1; x < w - 1; ++x) {
            put(2 * x, (colsum[x] * 3 + colsum[x - 1] + 8) >> 4);
            put(2 * x + 1, (colsum[x] * 3 + colsum[x + 1] + 7) >> 4);
        }
        put(2 * (w - 1), (colsum[w - 1] * 3 + colsum[w - 2] + 8) >> 4);
        put(2 * (w - 1) + 1, (colsum[w - 1] * 4 + 7) >> 4);
    }
    return out;
}

inline std::vector<uint8_t> upsampleH2V1(const Component& c, int outWidth, int outHeight) {
    std::vector<uint8_t> out(static_cast<size_t>(outWidth) * outHeight);
    const int w = c.width;
    for (int y = 0; y < outHeight; ++y) {
        const uint8_t* src = c.plane.data() + static_cast<size_t>(std::min(y, c.height - 1)) * c.stride();
        uint8_t* dst = out.data() + static_cast<size_t>(y) * outWidth;
        for (int x = 0; x < w; ++x) {
            int left = src[std::max(x - 1, 0)];
            int right = src[std::min(x + 1, w - 1)];
            int a = x == 0 ? src[0] : (src[x] * 3 + left + 1) >> 2;
            int b = x == w - 1 ? src[x] : (src[x] * 3 + right + 2) >> 2;
            if (2 * x < outWidth) dst[2 * x] = static_cast<uint8_t>(a);
            if (2 * x + 1 < outWidth) dst[2 * x + 1] = static_cast<uint8_t>(b);
        }
    }
    return out;
}

inline std::vector<uint8_t> upsampleNearest(const Component& c, int hFactor, int vFactor, int outWidth, int outHeight) {
    std::vector<uint8_t> out(static_cast<size_t>(outWidth) * outHeight);
    for (int y = 0; y < outHeight; ++y) {
        const uint8_t* src = c.plane.data() + static_cast<size_t>(std::min(y / vFactor, c.height - 1)) * c.stride();
        uint8_t* dst = out.data() + static_cast<size_t>(y) * outWidth;
        for (int x = 0; x < outWidth; ++x) dst[x] = src[std::min(x / hFactor, c.width - 1)];
    }
    return out;
}

class Decoder {
public:
    Decoder(const uint8_t* data, size_t size) : data_(data), size_(size) {}

    DecodeResult run(OutputFormat format) {
        DecodeResult result;
        if (size_ < 4 || data_[0] != 0xFF || data_[1] != 0xD8) {
            result.error = "not a JPEG file (missing SOI marker)";
            return result;
        }
        size_t pos = 2;
        bool frameSeen = false;
        bool scanSeen = false;
        while (pos + 1 < size_) {
            if (data_[pos] != 0xFF) {
                ++pos;
                continue;
            }
            uint8_t marker = data_[pos + 1];
            pos += 2;
            if (marker == 0xFF) {
                --pos;
                continue;
            }
            if (marker == 0xD8 || (marker >= 0xD0 && marker <= 0xD7) || marker == 0x01) continue;
            if (marker == 0xD9) break;
            if (pos + 2 > size_) break;
            size_t length = (static_cast<size_t>(data_[pos]) << 8) | data_[pos + 1];
            if (length < 2 || pos + length > size_) {
                result.error = "truncated JPEG segment";
                return result;
            }
            const uint8_t* seg = data_ + pos + 2;
            size_t segLen = length - 2;
            switch (marker) {
                case 0xC0:
                case 0xC1:
                    if (!parseFrame(seg, segLen, result.error)) return result;
                    frameSeen = true;
                    break;
                case 0xC2:
                case 0xC6:
                case 0xCA:
                case 0xCE:
                    result.error = "progressive JPEG is not supported";
                    return result;
                case 0xC3: case 0xC5: case 0xC7: case 0xC9: case 0xCB: case 0xCD: case 0xCF:
                    result.error = "unsupported JPEG coding process (lossless or arithmetic)";
                    return result;
                case 0xC4:
                    if (!parseHuffman(seg, segLen, result.error)) return result;
                    break;
                case 0xDB:
                    if (!parseQuant(seg, segLen, result.error)) return result;
                    break;
                case 0xDD:
                    if (segLen >= 2) restartInterval_ = (seg[0] << 8) | seg[1];
                    break;
                case 0xEE:
                    if (segLen >= 12 && std::memcmp(seg, "Adobe", 5) == 0) {
                        adobeTransform_ = seg[11];
                        adobeSeen_ = true;
                    }
                    break;
                case 0xDA: {
                    if (!frameSeen) {
                        result.error = "scan before frame header";
                        return result;
                    }
                    size_t entropyStart = pos + length;
                    size_t next = 0;
                    if (!decodeScan(seg, segLen, entropyStart, next, result.error)) return result;
                    scanSeen = true;
                    pos = next;
                    continue;
                }
                default:
                    break;
            }
            pos += length;
        }
        if (!frameSeen || !scanSeen) {
            result.error = "JPEG contains no decodable frame";
            return result;
        }
        return assemble(format);
    }

private:
    bool parseFrame(const uint8_t* s, size_t len, std::string& error) {
        if (len < 6) { error = "short SOF segment"; return false; }
        if (s[0] != 8) { error = "only 8-bit JPEG precision is supported"; return false; }
        height_ = (s[1] << 8) | s[2];
        width_ = (s[3] << 8) | s[4];
        int count = s[5];
        if (width_ <= 0 || height_ <= 0) { error = "JPEG with zero or deferred dimensions is not supported"; return false; }
        if ((count != 1 && count != 3) || len < 6 + static_cast<size_t>(count) * 3) {
            error = "only 1- or 3-component JPEGs are supported";
            return false;
        }
        components_.assign(static_cast<size_t>(count), Component{});
        hMax_ = 1;
        vMax_ = 1;
        for (int i = 0; i < count; ++i) {
            Component& c = components_[i];
            c.id = s[6 + i * 3];
            c.h = s[7 + i * 3] >> 4;
            c.v = s[7 + i * 3] & 15;
            c.quantTable = s[8 + i * 3] & 3;
            if (c.h < 1 || c.h > 4 || c.v < 1 || c.v > 4) { error = "invalid sampling factor"; return false; }
            hMax_ = std::max(hMax_, c.h);
            vMax_ = std::max(vMax_, c.v);
        }
        mcusX_ = (width_ + 8 * hMax_ - 1) / (8 * hMax_);
        mcusY_ = (height_ + 8 * vMax_ - 1) / (8 * vMax_);
        for (Component& c : components_) {
            c.width = (width_ * c.h + hMax_ - 1) / hMax_;
            c.height = (height_ * c.v + vMax_ - 1) / vMax_;
            c.blocksPerLine = mcusX_ * c.h;
            c.blocksPerColumn = mcusY_ * c.v;
            c.plane.assign(static_cast<size_t>(c.blocksPerLine) * 8 * c.blocksPerColumn * 8, 0);
        }
        return true;
    }

    bool parseHuffman(const uint8_t* s, size_t len, std::string& error) {
        size_t p = 0;
        while (p + 17 <= len) {
            int tableClass = s[p] >> 4;
            int tableId = s[p] & 15;
            if (tableClass > 1 || tableId > 3) { error = "invalid Huffman table id"; return false; }
            uint8_t counts[16];
            int total = 0;
            for (int i = 0; i < 16; ++i) {
                counts[i] = s[p + 1 + i];
                total += counts[i];
            }
            if (p + 17 + static_cast<size_t>(total) > len) { error = "truncated Huffman table"; return false; }
            HuffmanTable& table = tableClass == 0 ? dcTables_[tableId] : acTables_[tableId];
            if (!table.build(counts, s + p + 17, total)) { error = "invalid Huffman table"; return false; }
            p += 17 + static_cast<size_t>(total);
        }
        return true;
    }

    bool parseQuant(const uint8_t* s, size_t len, std::string& error) {
        size_t p = 0;
        while (p < len) {
            int precision = s[p] >> 4;
            int id = s[p] & 15;
            if (id > 3) { error = "invalid quantization table id"; return false; }
            size_t bytes = precision ? 128 : 64;
            if (p + 1 + bytes > len) { error = "truncated quantization table"; return false; }
            for (int k = 0; k < 64; ++k) {
                int value = precision ? (s[p + 1 + 2 * k] << 8) | s[p + 2 + 2 * k] : s[p + 1 + k];
                quant_[id][kNaturalOrder[k]] = static_cast<float>(value);
            }
            p += 1 + bytes;
        }
        return true;
    }

    bool decodeBlock(BitReader& reader, Component& c, int bx, int by) {
        const HuffmanTable& dc = dcTables_[c.dcTable];
        const HuffmanTable& ac = acTables_[c.acTable];
        const float* q = quant_[c.quantTable];
        float coeffs[64] = {};
        int t = reader.decode(dc);
        if (t < 0 || t > 11) return false;
        c.dcPredictor += reader.receiveExtend(t);
        coeffs[0] = static_cast<float>(c.dcPredictor) * q[0];
        for (int k = 1; k < 64;) {
            int rs = reader.decode(ac);
            if (rs < 0) return false;
            int run = rs >> 4;
            int size = rs & 15;
            if (size == 0) {
                if (run != 15) break;
                k += 16;
                continue;
            }
            k += run;
            if (k > 63) return false;
            int natural = kNaturalOrder[k];
            coeffs[natural] = static_cast<float>(reader.receiveExtend(size)) * q[natural];
            ++k;
        }
        uint8_t* dst = c.plane.data() + static_cast<size_t>(by) * 8 * c.stride() + static_cast<size_t>(bx) * 8;
        inverseDct(coeffs, dst, c.stride());
        return true;
    }

    bool decodeScan(const uint8_t* s, size_t len, size_t entropyStart, size_t& nextMarker, std::string& error) {
        if (len < 1) { error = "short SOS segment"; return false; }
        int count = s[0];
        if (count < 1 || count > 4 || len < 1 + static_cast<size_t>(count) * 2 + 3) { error = "invalid SOS segment"; return false; }
        std::vector<Component*> scan;
        for (int i = 0; i < count; ++i) {
            int id = s[1 + i * 2];
            int tables = s[2 + i * 2];
            Component* match = nullptr;
            for (Component& c : components_) {
                if (c.id == id) match = &c;
            }
            if (!match) { error = "scan references unknown component"; return false; }
            match->dcTable = (tables >> 4) & 3;
            match->acTable = tables & 3;
            if (!dcTables_[match->dcTable].defined || !acTables_[match->acTable].defined) {
                error = "scan references undefined Huffman table";
                return false;
            }
            match->dcPredictor = 0;
            scan.push_back(match);
        }

        BitReader reader(data_, size_, entropyStart);
        int mcuCount = 0;
        auto handleRestart = [&]() {
            if (restartInterval_ > 0 && mcuCount > 0 && mcuCount % restartInterval_ == 0) {
                reader.restart();
                for (Component* c : scan) c->dcPredictor = 0;
            }
        };

        if (scan.size() == 1) {
            Component& c = *scan[0];
            int blocksX = (c.width + 7) / 8;
            int blocksY = (c.height + 7) / 8;
            for (int by = 0; by < blocksY; ++by) {
                for (int bx = 0; bx < blocksX; ++bx) {
                    handleRestart();
                    if (!decodeBlock(reader, c, bx, by)) { error = "corrupt JPEG entropy data"; return false; }
                    ++mcuCount;
                }
            }
        } else {
            for (int my = 0; my < mcusY_; ++my) {
                for (int mx = 0; mx < mcusX_; ++mx) {
                    handleRestart();
                    for (Component* c : scan) {
                        for (int v = 0; v < c->v; ++v) {
                            for (int h = 0; h < c->h; ++h) {
                                if (!decodeBlock(reader, *c, mx * c->h + h, my * c->v + v)) {
                                    error = "corrupt JPEG entropy data";
                                    return false;
                                }
                            }
                        }
                    }
                    ++mcuCount;
                }
            }
        }

        size_t p = reader.position();
        while (p + 1 < size_) {
            if (data_[p] == 0xFF && data_[p + 1] != 0x00 && !(data_[p + 1] >= 0xD0 && data_[p + 1] <= 0xD7)) break;
            ++p;
        }
        nextMarker = p;
        return true;
    }

    std::vector<uint8_t> fullResolution(const Component& c) const {
        int hFactor = hMax_ / c.h;
        int vFactor = vMax_ / c.v;
        if (hFactor == 1 && vFactor == 1) {
            std::vector<uint8_t> out(static_cast<size_t>(width_) * height_);
            for (int y = 0; y < height_; ++y) {
                std::memcpy(out.data() + static_cast<size_t>(y) * width_, c.plane.data() + static_cast<size_t>(y) * c.stride(), static_cast<size_t>(width_));
            }
            return out;
        }
        if (hFactor == 2 && vFactor == 2) return upsampleH2V2(c, width_, height_);
        if (hFactor == 2 && vFactor == 1) return upsampleH2V1(c, width_, height_);
        return upsampleNearest(c, std::max(hFactor, 1), std::max(vFactor, 1), width_, height_);
    }

    DecodeResult assemble(OutputFormat format) const {
        DecodeResult result;
        const bool color = components_.size() == 3;
        int channels = format == OutputFormat::Luma ? 1 : (format == OutputFormat::Rgb ? 3 : (color ? 3 : 1));
        result.image = texture::ImageBuffer(width_, height_, channels);
        std::vector<uint8_t> c0 = fullResolution(components_[0]);
        const size_t pixelCount = static_cast<size_t>(width_) * height_;

        if (channels == 1 || !color) {
            for (size_t i = 0; i < pixelCount; ++i) {
                for (int ch = 0; ch < channels; ++ch) result.image.data[i * channels + ch] = c0[i];
            }
            result.ok = true;
            return result;
        }

        std::vector<uint8_t> c1 = fullResolution(components_[1]);
        std::vector<uint8_t> c2 = fullResolution(components_[2]);
        bool isRgb = (adobeSeen_ && adobeTransform_ == 0)
            || (components_[0].id == 'R' && components_[1].id == 'G' && components_[2].id == 'B');
        for (size_t i = 0; i < pixelCount; ++i) {
            uint8_t* dst = result.image.data.data() + i * 3;
            if (isRgb) {
                dst[0] = c0[i];
                dst[1] = c1[i];
                dst[2] = c2[i];
                continue;
            }
            float y = c0[i];
            float cb = static_cast<float>(c1[i]) - 128.0f;
            float cr = static_cast<float>(c2[i]) - 128.0f;
            int r = static_cast<int>(std::lround(y + 1.402f * cr));
            int g = static_cast<int>(std::lround(y - 0.344136f * cb - 0.714136f * cr));
            int b = static_cast<int>(std::lround(y + 1.772f * cb));
            dst[0] = static_cast<uint8_t>(std::clamp(r, 0, 255));
            dst[1] = static_cast<uint8_t>(std::clamp(g, 0, 255));
            dst[2] = static_cast<uint8_t>(std::clamp(b, 0, 255));
        }
        result.ok = true;
        return result;
    }

    const uint8_t* data_;
    size_t size_;
    int width_{0};
    int height_{0};
    int hMax_{1};
    int vMax_{1};
    int mcusX_{0};
    int mcusY_{0};
    int restartInterval_{0};
    bool adobeSeen_{false};
    int adobeTransform_{1};
    std::vector<Component> components_;
    HuffmanTable dcTables_[4];
    HuffmanTable acTables_[4];
    float quant_[4][64] = {};
};

} // namespace detail

/**
 * Decodes a baseline (sequential Huffman, 8-bit) JPEG with any integer chroma subsampling.
 * Progressive, lossless and arithmetic-coded files return ok=false with a descriptive error.
 */
inline DecodeResult decode(const uint8_t* data, size_t size, OutputFormat format = OutputFormat::Auto) {
    if (!data || size == 0) {
        DecodeResult result;
        result.error = "empty JPEG buffer";
        return result;
    }
    detail::Decoder decoder(data, size);
    return decoder.run(format);
}

inline DecodeResult decode(const std::vector<uint8_t>& bytes, OutputFormat format = OutputFormat::Auto) {
    return decode(bytes.data(), bytes.size(), format);
}

inline DecodeResult decodeFile(const std::string& path, OutputFormat format = OutputFormat::Auto) {
    std::ifstream file(path, std::ios::binary | std::ios::ate);
    if (!file.is_open()) {
        DecodeResult result;
        result.error = "cannot open " + path;
        return result;
    }
    std::streamsize size = file.tellg();
    file.seekg(0, std::ios::beg);
    std::vector<uint8_t> bytes(static_cast<size_t>(std::max<std::streamsize>(size, 0)));
    if (size > 0 && !file.read(reinterpret_cast<char*>(bytes.data()), size)) {
        DecodeResult result;
        result.error = "cannot read " + path;
        return result;
    }
    return decode(bytes, format);
}

} // namespace jpeg
} // namespace scratchbox

#endif // SCRATCHBOX_JPEG_HPP
