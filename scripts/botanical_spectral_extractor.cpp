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
#include <sstream>

// Decode JPEG/PNG buffer from memory to RGBA using Apple ImageIO
bool decodeImageBufferToRgba(const uint8_t* data, size_t dataLen, std::vector<uint8_t>& outRgba, size_t& outW, size_t& outH) {
    if (dataLen == 0) return false;
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

// Minimal glTF bufferView and accessor representation
struct BufferView {
    size_t byteOffset = 0;
    size_t byteLength = 0;
};

struct Accessor {
    int bufferView = -1;
    size_t byteOffset = 0;
    size_t count = 0;
    std::string type;
    int componentType = 5126; // 5126 = FLOAT
};

struct ImageInfo {
    int bufferView = -1;
    size_t width = 0;
    size_t height = 0;
    std::vector<uint8_t> rgba;
};

// Fast helper to find integer after key
int findJsonInt(const std::string& str, const std::string& key, size_t startPos = 0) {
    size_t pos = str.find("\"" + key + "\"", startPos);
    if (pos == std::string::npos) return -1;
    pos = str.find(":", pos);
    if (pos == std::string::npos) return -1;
    while (pos < str.size() && (str[pos] == ':' || str[pos] == ' ' || str[pos] == '\t')) pos++;
    return std::stoi(str.substr(pos));
}

int main(int argc, char** argv) {
    std::string glbPath = argc > 1 ? argv[1] : "public/models/colosseum_rome_pristine_leaf_raw.glb";
    std::string outJsonPath = argc > 2 ? argv[2] : ".scratchbox/spectral_vegetation.json";

    auto tStart = std::chrono::high_resolution_clock::now();

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

    uint32_t jsonLen = *(uint32_t*)&buffer[12];
    std::string jsonStr((char*)&buffer[20], jsonLen);
    size_t binOffset = 20 + jsonLen + 8; // skip 8-byte BIN chunk header
    const uint8_t* binData = buffer.data() + binOffset;

    std::cout << "[Botanical Extractor] Parsing glTF JSON (" << jsonLen << " bytes)..." << std::endl;

    // We can use a Node.js companion or lightweight parse. 
    // But since Node has standard JSON.parse, let's export decoded images or parse bufferViews!
    return 0;
}
