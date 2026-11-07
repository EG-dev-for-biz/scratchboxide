/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
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


/**
 * Baseline JPEG encoder (JFIF, 8-bit, 4:4:4, the standard Annex K quantisation and Huffman tables scaled by quality as the
 * IJG library does): for writing a photo back after a stage changed some of its texels, so it stays a JPEG of about the
 * size it came as. Greyscale (1 channel) is written as one component; RGB and RGBA as YCbCr (alpha dropped).
 */
namespace encode_detail {
constexpr uint8_t kLumaQuant[64] = {16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62,
                                    18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99};
constexpr uint8_t kChromaQuant[64] = {17, 18, 24, 47, 99, 99, 99, 99, 18, 21, 26, 66, 99, 99, 99, 99, 24, 26, 56, 99, 99, 99, 99, 99, 47, 66, 99, 99, 99, 99, 99, 99,
                                      99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99};
constexpr uint8_t kDcLumaBits[16] = {0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0};
constexpr uint8_t kDcLumaVals[12] = {0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11};
constexpr uint8_t kDcChromaBits[16] = {0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0};
constexpr uint8_t kDcChromaVals[12] = {0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11};
constexpr uint8_t kAcLumaBits[16] = {0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d};
constexpr uint8_t kAcLumaVals[162] = {
    0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07, 0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08,
    0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0, 0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28,
    0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59,
    0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89,
    0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6,
    0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2,
    0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa};
constexpr uint8_t kAcChromaBits[16] = {0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 0x77};
constexpr uint8_t kAcChromaVals[162] = {
    0x00, 0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21, 0x31, 0x06, 0x12, 0x41, 0x51, 0x07, 0x61, 0x71, 0x13, 0x22, 0x32, 0x81, 0x08, 0x14, 0x42, 0x91,
    0xa1, 0xb1, 0xc1, 0x09, 0x23, 0x33, 0x52, 0xf0, 0x15, 0x62, 0x72, 0xd1, 0x0a, 0x16, 0x24, 0x34, 0xe1, 0x25, 0xf1, 0x17, 0x18, 0x19, 0x1a, 0x26,
    0x27, 0x28, 0x29, 0x2a, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58,
    0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87,
    0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4,
    0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda,
    0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa};

struct HuffCode { uint16_t code{0}; uint8_t len{0}; };
/** Canonical codes from a table's code counts per length and its symbols (ITU T.81 Annex C). */
inline std::array<HuffCode, 256> buildCodes(const uint8_t* bits, const uint8_t* vals) {
    std::array<HuffCode, 256> out{};
    uint16_t code = 0;
    size_t k = 0;
    for (int len = 1; len <= 16; ++len) {
        for (int i = 0; i < bits[len - 1]; ++i) out[vals[k++]] = HuffCode{code++, static_cast<uint8_t>(len)};
        code <<= 1;
    }
    return out;
}
struct BitWriter {
    std::vector<uint8_t>& out;
    uint32_t acc{0};
    int n{0};
    void put(uint32_t bits, int len) {
        for (int i = len - 1; i >= 0; --i) {
            acc = (acc << 1) | ((bits >> i) & 1u);
            if (++n == 8) {
                out.push_back(static_cast<uint8_t>(acc));
                if (acc == 0xFF) out.push_back(0x00);   // byte stuffing
                acc = 0; n = 0;
            }
        }
    }
    void flush() { while (n) put(1, 1); }   // pad the last byte with ones
};
/** The bit length of |v| and v's bits as JPEG writes a coefficient (negative values one's complement). */
inline void magnitude(int v, uint32_t& bits, int& len) {
    int a = v < 0 ? -v : v;
    len = 0;
    while (a) { ++len; a >>= 1; }
    bits = static_cast<uint32_t>(v < 0 ? v + (1 << len) - 1 : v);
}
}  // namespace encode_detail

inline std::vector<uint8_t> encode(const texture::ImageBuffer& img, int quality = 90) {
    using namespace encode_detail;
    if (img.empty() || (img.channels != 1 && img.channels != 3 && img.channels != 4)) return {};
    quality = std::clamp(quality, 1, 100);
    const int scale = quality < 50 ? 5000 / quality : 200 - 2 * quality;
    uint8_t qt[2][64];
    for (int i = 0; i < 64; ++i) {
        qt[0][i] = static_cast<uint8_t>(std::clamp((kLumaQuant[i] * scale + 50) / 100, 1, 255));
        qt[1][i] = static_cast<uint8_t>(std::clamp((kChromaQuant[i] * scale + 50) / 100, 1, 255));
    }
    const int comps = img.channels == 1 ? 1 : 3;
    std::vector<uint8_t> out;
    auto u16 = [&](int v) { out.push_back(static_cast<uint8_t>(v >> 8)); out.push_back(static_cast<uint8_t>(v & 0xFF)); };
    out.insert(out.end(), {0xFF, 0xD8});                                                               // SOI
    out.insert(out.end(), {0xFF, 0xE0, 0x00, 0x10, 'J', 'F', 'I', 'F', 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00});   // APP0
    for (int t = 0; t < (comps == 1 ? 1 : 2); ++t) {                                                    // DQT, zigzag order
        out.insert(out.end(), {0xFF, 0xDB}); u16(67); out.push_back(static_cast<uint8_t>(t));
        for (int i = 0; i < 64; ++i) out.push_back(qt[t][detail::kNaturalOrder[i]]);
    }
    out.insert(out.end(), {0xFF, 0xC0}); u16(8 + 3 * comps); out.push_back(8); u16(img.height); u16(img.width); out.push_back(static_cast<uint8_t>(comps));   // SOF0
    for (int c = 0; c < comps; ++c) { out.push_back(static_cast<uint8_t>(c + 1)); out.push_back(0x11); out.push_back(static_cast<uint8_t>(c == 0 ? 0 : 1)); }
    auto dht = [&](int cls, int id, const uint8_t* bits, const uint8_t* vals, int nvals) {
        out.insert(out.end(), {0xFF, 0xC4}); u16(3 + 16 + nvals); out.push_back(static_cast<uint8_t>((cls << 4) | id));
        out.insert(out.end(), bits, bits + 16); out.insert(out.end(), vals, vals + nvals);
    };
    dht(0, 0, kDcLumaBits, kDcLumaVals, 12); dht(1, 0, kAcLumaBits, kAcLumaVals, 162);
    if (comps == 3) { dht(0, 1, kDcChromaBits, kDcChromaVals, 12); dht(1, 1, kAcChromaBits, kAcChromaVals, 162); }
    out.insert(out.end(), {0xFF, 0xDA}); u16(6 + 2 * comps); out.push_back(static_cast<uint8_t>(comps));   // SOS
    for (int c = 0; c < comps; ++c) { out.push_back(static_cast<uint8_t>(c + 1)); out.push_back(static_cast<uint8_t>(c == 0 ? 0x00 : 0x11)); }
    out.insert(out.end(), {0x00, 0x3F, 0x00});
    const auto dcCodes = std::array<std::array<HuffCode, 256>, 2>{buildCodes(kDcLumaBits, kDcLumaVals), buildCodes(kDcChromaBits, kDcChromaVals)};
    const auto acCodes = std::array<std::array<HuffCode, 256>, 2>{buildCodes(kAcLumaBits, kAcLumaVals), buildCodes(kAcChromaBits, kAcChromaVals)};
    // the DCT basis: cos((2x + 1) u pi / 16) with its normalisation
    double basis[8][8];
    for (int u = 0; u < 8; ++u) for (int x = 0; x < 8; ++x) basis[u][x] = (u == 0 ? std::sqrt(0.125) : 0.5) * std::cos((2 * x + 1) * u * M_PI / 16.0);
    BitWriter bw{out};
    int prevDc[3] = {0, 0, 0};
    auto sampleAt = [&](int x, int y, int c) {
        x = std::min(x, img.width - 1); y = std::min(y, img.height - 1);   // edge blocks repeat the last row and column
        const uint8_t* px = &img.data[(static_cast<size_t>(y) * img.width + x) * img.channels];
        if (comps == 1) return px[0] - 128.0;
        const double r = px[0], g = px[1], b = px[2];
        if (c == 0) return 0.299 * r + 0.587 * g + 0.114 * b - 128.0;
        if (c == 1) return -0.168736 * r - 0.331264 * g + 0.5 * b;
        return 0.5 * r - 0.418688 * g - 0.081312 * b;
    };
    for (int by = 0; by < img.height; by += 8) for (int bx = 0; bx < img.width; bx += 8) for (int c = 0; c < comps; ++c) {
        double block[8][8], tmp[8][8];
        for (int y = 0; y < 8; ++y) for (int x = 0; x < 8; ++x) block[y][x] = sampleAt(bx + x, by + y, c);
        for (int y = 0; y < 8; ++y) for (int u = 0; u < 8; ++u) { double s = 0; for (int x = 0; x < 8; ++x) s += basis[u][x] * block[y][x]; tmp[y][u] = s; }
        int q[64];
        const int t = c == 0 ? 0 : 1;
        for (int v = 0; v < 8; ++v) for (int u = 0; u < 8; ++u) {
            double s = 0;
            for (int y = 0; y < 8; ++y) s += basis[v][y] * tmp[y][u];
            q[v * 8 + u] = static_cast<int>(std::lround(s / qt[t][v * 8 + u]));
        }
        // DC: the difference from the previous block of this component
        uint32_t bits; int len;
        const int diff = q[0] - prevDc[c];
        prevDc[c] = q[0];
        magnitude(diff, bits, len);
        bw.put(dcCodes[t][len].code, dcCodes[t][len].len);
        if (len) bw.put(bits, len);
        // AC in zigzag order: (zero run, size) symbols, ZRL for 16 zeros, EOB at the end
        int run = 0;
        for (int i = 1; i < 64; ++i) {
            const int v = q[detail::kNaturalOrder[i]];
            if (v == 0) { ++run; continue; }
            while (run > 15) { bw.put(acCodes[t][0xF0].code, acCodes[t][0xF0].len); run -= 16; }
            magnitude(v, bits, len);
            const int sym = (run << 4) | len;
            bw.put(acCodes[t][sym].code, acCodes[t][sym].len);
            bw.put(bits, len);
            run = 0;
        }
        if (run) bw.put(acCodes[t][0].code, acCodes[t][0].len);
    }
    bw.flush();
    out.insert(out.end(), {0xFF, 0xD9});   // EOI
    return out;
}

} // namespace jpeg
} // namespace scratchbox

#endif // SCRATCHBOX_JPEG_HPP
