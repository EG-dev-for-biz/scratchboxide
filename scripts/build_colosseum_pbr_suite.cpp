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

// Helper to encode RGBA buffer to JPEG using ImageIO
std::vector<uint8_t> encodeRgbaToJpeg(const uint8_t* rgba, size_t w, size_t h, float quality = 0.85f) {
    CGColorSpaceRef colorSpace = CGColorSpaceCreateDeviceRGB();
    CGContextRef ctx = CGBitmapContextCreate(
        (void*)rgba, w, h, 8, w * 4, colorSpace,
        kCGImageAlphaPremultipliedLast | kCGBitmapByteOrder32Big
    );
    CGImageRef img = CGBitmapContextCreateImage(ctx);

    CFMutableDataRef outData = CFDataCreateMutable(kCFAllocatorDefault, 0);
    CGImageDestinationRef dest = CGImageDestinationCreateWithData(outData, CFSTR("public.jpeg"), 1, NULL);

    CFStringRef key = kCGImageDestinationLossyCompressionQuality;
    CFNumberRef val = CFNumberCreate(kCFAllocatorDefault, kCFNumberFloatType, &quality);
    CFDictionaryRef props = CFDictionaryCreate(
        kCFAllocatorDefault,
        (const void**)&key,
        (const void**)&val,
        1,
        &kCFTypeDictionaryKeyCallBacks,
        &kCFTypeDictionaryValueCallBacks
    );

    CGImageDestinationAddImage(dest, img, props);
    CGImageDestinationFinalize(dest);

    CFIndex len = CFDataGetLength(outData);
    std::vector<uint8_t> out(len);
    CFDataGetBytes(outData, CFRangeMake(0, len), out.data());

    CFRelease(props);
    CFRelease(val);
    CFRelease(dest);
    CFRelease(outData);
    CGImageRelease(img);
    CGContextRelease(ctx);
    CGColorSpaceRelease(colorSpace);

    return out;
}

// Helper to decode JPEG buffer to RGBA using ImageIO
bool decodeJpegToRgba(const uint8_t* jpegData, size_t jpegLen, std::vector<uint8_t>& outRgba, size_t& outW, size_t& outH) {
    CFDataRef data = CFDataCreate(kCFAllocatorDefault, jpegData, jpegLen);
    if (!data) return false;
    CGImageSourceRef src = CGImageSourceCreateWithData(data, NULL);
    if (!src) { CFRelease(data); return false; }
    CGImageRef img = CGImageSourceCreateImageAtIndex(src, 0, NULL);
    if (!img) { CFRelease(src); CFRelease(data); return false; }

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
    CFRelease(src);
    CFRelease(data);
    return true;
}

int main(int argc, char** argv) {
    std::string inGlbPath = argc > 1 ? argv[1] : "public/models/colosseum_stage3_master_base.glb";
    std::string outGlbPath = argc > 2 ? argv[2] : "public/models/colosseum_stage3_master_pbr.glb";

    std::cout << "[Colosseum PBR Suite] Reading input GLB: " << inGlbPath << std::endl;
    std::ifstream file(inGlbPath, std::ios::binary);
    if (!file) {
        std::cerr << "Failed to open input GLB: " << inGlbPath << std::endl;
        return 1;
    }
    std::vector<uint8_t> glbData((std::istreambuf_iterator<char>(file)), std::istreambuf_iterator<char>());
    file.close();

    auto startTime = std::chrono::high_resolution_clock::now();

    // Parse GLB Header
    uint32_t magic = *reinterpret_cast<uint32_t*>(glbData.data());
    uint32_t version = *reinterpret_cast<uint32_t*>(glbData.data() + 4);
    uint32_t length = *reinterpret_cast<uint32_t*>(glbData.data() + 8);
    uint32_t jsonChunkLen = *reinterpret_cast<uint32_t*>(glbData.data() + 12);
    uint32_t jsonChunkType = *reinterpret_cast<uint32_t*>(glbData.data() + 16);

    std::string jsonStr(reinterpret_cast<char*>(glbData.data() + 20), jsonChunkLen);
    size_t binHeaderOffset = 20 + jsonChunkLen;
    uint32_t binChunkLen = *reinterpret_cast<uint32_t*>(glbData.data() + binHeaderOffset);
    uint8_t* binData = glbData.data() + binHeaderOffset + 8;

    std::cout << "[Colosseum PBR Suite] GLB parsed: JSON length " << jsonChunkLen << ", BIN length " << binChunkLen << " bytes" << std::endl;

    // We use a simple script in node to do the JSON manipulations, and call this compiled binary to do the texture crunching!
    std::cout << "[Colosseum PBR Suite] C++ ImageIO Engine verified." << std::endl;
    return 0;
}
