#include <CoreFoundation/CoreFoundation.h>
#include <CoreGraphics/CoreGraphics.h>
#include <ImageIO/ImageIO.h>
#include <iostream>
#include <vector>
#include <string>
#include <fstream>
#include <cmath>
#include <algorithm>
#include <chrono>

// Decode JPEG/PNG buffer from memory to RGBA using Apple ImageIO
bool decodeImageBufferToRgba(const uint8_t* data, size_t dataLen, std::vector<uint8_t>& outRgba, size_t& outW, size_t& outH) {
    CFDataRef cfData = CFDataCreate(kCFAllocatorDefault, data, dataLen);
    if (!cfData) return false;

    CGImageSourceRef src = CGImageSourceCreateWithData(cfData, NULL);
    CFRelease(cfData);
    if (!src) return false;

    CGImageRef img = CGImageSourceCreateImageAtIndex(src, 0, NULL);
    CFRelease(src);
    if (!img) return false;

    outW = CGImageGetWidth(img);
    outH = CGImageGetHeight(img);
    outRgba.resize(outW * outH * 4);

    CGColorSpaceRef colorSpace = CGColorSpaceCreateDeviceRGB();
    CGContextRef ctx = CGBitmapContextCreate(
        outRgba.data(), outW, outH, 8, outW * 4, colorSpace,
        kCGImageAlphaPremultipliedLast | kCGBitmapByteOrder32Big
    );

    CGContextDrawImage(ctx, CGRectMake(0, 0, outW, outH), img);

    CGContextRelease(ctx);
    CGColorSpaceRelease(colorSpace);
    CGImageRelease(img);
    return true;
}

// Simple JSON helper to extract string values or array offsets
int main(int argc, char** argv) {
    std::string glbPath = argc > 1 ? argv[1] : "public/models/colosseum_rome_pristine_leaf_raw.glb";
    std::ifstream file(glbPath, std::ios::binary);
    if (!file) {
        std::cerr << "Cannot open " << glbPath << std::endl;
        return 1;
    }

    file.seekg(0, std::ios::end);
    size_t fileSize = file.tellg();
    file.seekg(0, std::ios::beg);

    std::vector<uint8_t> buffer(fileSize);
    file.read((char*)buffer.data(), fileSize);

    uint32_t magic = *(uint32_t*)&buffer[0];
    uint32_t version = *(uint32_t*)&buffer[4];
    uint32_t totalLen = *(uint32_t*)&buffer[8];
    uint32_t jsonLen = *(uint32_t*)&buffer[12];

    std::string jsonStr((char*)&buffer[20], jsonLen);
    size_t binOffset = 20 + jsonLen + 8; // skip BIN chunk header

    std::cout << "[test_botanical_exg] GLB size: " << fileSize / (1024 * 1024) << " MB, JSON len: " << jsonLen << std::endl;

    return 0;
}
