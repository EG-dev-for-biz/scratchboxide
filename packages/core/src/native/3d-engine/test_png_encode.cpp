// texture::encodePng (filtered scanlines + self-contained fixed-Huffman DEFLATE) round-trips through the zlib-backed
// png::decode bit-exactly, and compresses: a smooth/noisy texture is far smaller than the stored-block size.
// Build: clang++ -std=c++20 -O2 -I include test_png_encode.cpp -lz
#include "scratchbox_texture.hpp"
#include "scratchbox_png.hpp"
#include <cassert>
#include <cstdio>
#include <random>

using namespace scratchbox;

static void roundTrip(const char* name, const texture::ImageBuffer& img) {
    std::vector<uint8_t> bytes = texture::encodePng(img);
    auto fmt = img.channels == 4 ? png::OutputFormat::Rgba : img.channels == 1 ? png::OutputFormat::Luma : png::OutputFormat::Rgb;
    png::DecodeResult r = png::decode(bytes.data(), bytes.size(), fmt);
    assert(r.ok && "zlib must accept the stream");
    assert(r.image.width == img.width && r.image.height == img.height && r.image.channels == img.channels);
    assert(r.image.data == img.data && "pixels must round-trip exactly");
    size_t stored = static_cast<size_t>(img.width) * img.height * img.channels;
    std::printf("  %-22s %dx%dx%d  raw %zu B -> png %zu B (%.1fx)\n", name, img.width, img.height, img.channels, stored, bytes.size(), double(stored) / bytes.size());
}

int main() {
    std::mt19937 rng(7);
    // smooth gradient with mild noise (like a baked albedo/AO map)
    texture::ImageBuffer grad(512, 512, 3);
    for (int y = 0; y < 512; ++y) for (int x = 0; x < 512; ++x) for (int c = 0; c < 3; ++c)
        grad.data[(y * 512 + x) * 3 + c] = static_cast<uint8_t>((x / 2 + y / 3 + c * 40 + int(rng() % 5)) & 0xFF);
    roundTrip("gradient+noise RGB", grad);

    // flat normal map (mostly 128,128,255)
    texture::ImageBuffer normal(1024, 1024, 3, 128);
    for (size_t i = 2; i < normal.data.size(); i += 3) normal.data[i] = 255;
    roundTrip("flat normal RGB", normal);

    // RGBA with alpha + pure noise (worst case: must still be valid, may not shrink)
    texture::ImageBuffer noise(257, 131, 4);
    for (auto& b : noise.data) b = static_cast<uint8_t>(rng());
    roundTrip("random RGBA", noise);

    // grayscale, odd sizes, empty-ish
    texture::ImageBuffer luma(3, 1, 1, 9);
    roundTrip("tiny luma", luma);

    // the compressible cases must actually compress well
    assert(texture::encodePng(normal).size() * 50 < normal.data.size());
    assert(texture::encodePng(grad).size() * 2 < grad.data.size());
    std::printf("[PASS] encodePng round-trips through zlib and compresses\n");
    return 0;
}
