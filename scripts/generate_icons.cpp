/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * Asset Generation Pipeline: Modern C++20 + CoreGraphics + ImageIO
 * Generates multi-resolution icon assets from the canonical impossible cube logo.
 ********************************************************************************/

#include <CoreGraphics/CoreGraphics.h>
#include <ImageIO/ImageIO.h>
#include <CoreServices/CoreServices.h>
#include <iostream>
#include <vector>
#include <string>
#include <filesystem>
#include <fstream>

namespace fs = std::filesystem;

void writePNG(CGImageRef img, const std::string& path) {
    fs::create_directories(fs::path(path).parent_path());
    CFURLRef url = CFURLCreateFromFileSystemRepresentation(kCFAllocatorDefault, (const UInt8*)path.c_str(), path.length(), false);
    CGImageDestinationRef dest = CGImageDestinationCreateWithURL(url, kUTTypePNG, 1, NULL);
    if (!dest) {
        std::cerr << "Failed to create PNG destination: " << path << std::endl;
        CFRelease(url);
        return;
    }
    CGImageDestinationAddImage(dest, img, NULL);
    CGImageDestinationFinalize(dest);
    CFRelease(dest);
    CFRelease(url);
    std::cout << "Wrote PNG: " << path << std::endl;
}

CGImageRef renderSquareLogo(CGImageRef srcImg, int targetSize) {
    size_t srcW = CGImageGetWidth(srcImg);
    size_t srcH = CGImageGetHeight(srcImg);

    CGColorSpaceRef colorSpace = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
    CGContextRef ctx = CGBitmapContextCreate(
        NULL,
        targetSize,
        targetSize,
        8,
        targetSize * 4,
        colorSpace,
        kCGImageAlphaPremultipliedLast | kCGBitmapByteOrder32Big
    );
    CGColorSpaceRelease(colorSpace);

    CGContextSetInterpolationQuality(ctx, kCGInterpolationHigh);
    CGContextClearRect(ctx, CGRectMake(0, 0, targetSize, targetSize));

    // Calculate aspect-preserving centered rect with ~6% margin
    double margin = targetSize * 0.05;
    double availW = targetSize - (margin * 2.0);
    double availH = targetSize - (margin * 2.0);
    double scale = std::min(availW / (double)srcW, availH / (double)srcH);
    double drawW = srcW * scale;
    double drawH = srcH * scale;
    double drawX = (targetSize - drawW) / 2.0;
    double drawY = (targetSize - drawH) / 2.0;

    CGContextDrawImage(ctx, CGRectMake(drawX, drawY, drawW, drawH), srcImg);
    CGImageRef result = CGBitmapContextCreateImage(ctx);
    CGContextRelease(ctx);
    return result;
}

// Generate Windows .ico with embedded PNG frames
void writeICO(const std::vector<std::pair<int, std::string>>& pngFiles, const std::string& outIcoPath) {
    fs::create_directories(fs::path(outIcoPath).parent_path());
    std::ofstream out(outIcoPath, std::ios::binary);
    if (!out.is_open()) {
        std::cerr << "Failed to open ICO for writing: " << outIcoPath << std::endl;
        return;
    }

    uint16_t reserved = 0;
    uint16_t type = 1; // 1 = ICO
    uint16_t count = (uint16_t)pngFiles.size();
    out.write((char*)&reserved, 2);
    out.write((char*)&type, 2);
    out.write((char*)&count, 2);

    std::vector<std::vector<char>> pngData(count);
    uint32_t currentOffset = 6 + (16 * count);

    for (size_t i = 0; i < pngFiles.size(); ++i) {
        std::ifstream in(pngFiles[i].second, std::ios::binary);
        pngData[i] = std::vector<char>((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
    }

    for (size_t i = 0; i < pngFiles.size(); ++i) {
        int s = pngFiles[i].first;
        uint8_t w = (s >= 256) ? 0 : (uint8_t)s;
        uint8_t h = (s >= 256) ? 0 : (uint8_t)s;
        uint8_t colorCount = 0;
        uint8_t bReserved = 0;
        uint16_t planes = 1;
        uint16_t bitCount = 32;
        uint32_t bytesInRes = (uint32_t)pngData[i].size();
        uint32_t imageOffset = currentOffset;

        out.write((char*)&w, 1);
        out.write((char*)&h, 1);
        out.write((char*)&colorCount, 1);
        out.write((char*)&bReserved, 1);
        out.write((char*)&planes, 2);
        out.write((char*)&bitCount, 2);
        out.write((char*)&bytesInRes, 4);
        out.write((char*)&imageOffset, 4);

        currentOffset += bytesInRes;
    }

    for (size_t i = 0; i < pngFiles.size(); ++i) {
        out.write(pngData[i].data(), pngData[i].size());
    }
    out.close();
    std::cout << "Wrote ICO: " << outIcoPath << std::endl;
}

// Generate Windows installer sidebar BMP (164x314) with dark slate gradient and centered logo
void writeSidebarBMP(CGImageRef logoImg, const std::string& outBmpPath) {
    fs::create_directories(fs::path(outBmpPath).parent_path());
    int w = 164;
    int h = 314;
    
    CGColorSpaceRef colorSpace = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
    CGContextRef ctx = CGBitmapContextCreate(
        NULL,
        w,
        h,
        8,
        w * 4,
        colorSpace,
        kCGImageAlphaNoneSkipLast | kCGBitmapByteOrder32Big
    );
    CGColorSpaceRelease(colorSpace);

    // Draw dark vertical gradient
    for (int y = 0; y < h; ++y) {
        double t = (double)y / (double)h;
        double r = (15.0 * (1.0 - t) + 30.0 * t) / 255.0;
        double g = (23.0 * (1.0 - t) + 58.0 * t) / 255.0;
        double b = (42.0 * (1.0 - t) + 138.0 * t) / 255.0;
        CGContextSetRGBFillColor(ctx, r, g, b, 1.0);
        CGContextFillRect(ctx, CGRectMake(0, y, w, 1));
    }

    // Draw centered logo (size 84x84)
    int logoS = 84;
    int logoX = (w - logoS) / 2;
    int logoY = h - logoS - 50; // CGContext y starts from bottom
    CGContextDrawImage(ctx, CGRectMake(logoX, logoY, logoS, logoS), logoImg);

    CGImageRef result = CGBitmapContextCreateImage(ctx);
    CGContextRelease(ctx);

    CFURLRef url = CFURLCreateFromFileSystemRepresentation(kCFAllocatorDefault, (const UInt8*)outBmpPath.c_str(), outBmpPath.length(), false);
    CGImageDestinationRef dest = CGImageDestinationCreateWithURL(url, kUTTypeBMP, 1, NULL);
    if (dest) {
        CGImageDestinationAddImage(dest, result, NULL);
        CGImageDestinationFinalize(dest);
        CFRelease(dest);
        std::cout << "Wrote BMP: " << outBmpPath << std::endl;
    }
    CFRelease(url);
    CGImageRelease(result);
}

int main(int argc, char* argv[]) {
    if (argc < 3) {
        std::cerr << "Usage: " << argv[0] << " <input-image-path> <project-root-dir>" << std::endl;
        return 1;
    }

    std::string inputPath = argv[1];
    std::string rootDir = argv[2];

    CFURLRef inUrl = CFURLCreateFromFileSystemRepresentation(kCFAllocatorDefault, (const UInt8*)inputPath.c_str(), inputPath.length(), false);
    CGImageSourceRef src = CGImageSourceCreateWithURL(inUrl, NULL);
    if (!src) {
        std::cerr << "Failed to open image source: " << inputPath << std::endl;
        return 1;
    }
    CGImageRef srcImg = CGImageSourceCreateImageAtIndex(src, 0, NULL);
    if (!srcImg) {
        std::cerr << "Failed to decode image from source: " << inputPath << std::endl;
        return 1;
    }

    std::cout << "Loaded source image: " << inputPath << " (" << CGImageGetWidth(srcImg) << "x" << CGImageGetHeight(srcImg) << ")" << std::endl;

    // Standard icon resolutions
    std::vector<int> sizes = {16, 24, 32, 48, 64, 128, 256, 512, 1024};
    std::string tmpDir = "/tmp/scratchbox_iconset";
    fs::create_directories(tmpDir);

    std::vector<std::pair<int, std::string>> icoInputs;
    for (int s : sizes) {
        CGImageRef scaled = renderSquareLogo(srcImg, s);
        std::string tmpPath = tmpDir + "/icon_" + std::to_string(s) + ".png";
        writePNG(scaled, tmpPath);
        if (s <= 256) {
            icoInputs.push_back({s, tmpPath});
        }
        CGImageRelease(scaled);
    }

    CGImageRef img1024 = renderSquareLogo(srcImg, 1024);
    CGImageRef img512 = renderSquareLogo(srcImg, 512);

    // 1. Primary repository logo directories
    writePNG(img1024, rootDir + "/ScratchboxIDE logo/ScratchboxIDE.png");
    writePNG(img512, rootDir + "/packages/core/src/browser/icons/ScratchboxIDE.png");
    writePNG(img512, rootDir + "/desktop-app/public/icons/ScratchboxIDE.png");
    writePNG(img512, rootDir + "/desktop-app/resources/icon.png");

    // 2. Electron resource locations
    std::string electronRes = rootDir + "/applications/electron/resources";
    writePNG(img512, electronRes + "/icons/WindowIcon/512-512.png");
    writePNG(img512, electronRes + "/icons/LinuxLauncherIcons/512x512.png");
    writePNG(img512, electronRes + "/icons/512x512.png");
    writePNG(img512, electronRes + "/icon.png");

    // 3. Multi-resolution Windows ICO
    writeICO(icoInputs, electronRes + "/icons/WindowsLauncherIcon/ScratchboxIDE.ico");
    writeICO(icoInputs, electronRes + "/icon.ico");
    writeICO(icoInputs, rootDir + "/desktop-app/public/favicon.ico");
    writeICO(icoInputs, rootDir + "/desktop-app/resources/icon.ico");

    // 4. Installer Sidebar BMP
    writeSidebarBMP(img512, electronRes + "/icons/InstallerSidebarImage/164-314Windows.bmp");
    writeSidebarBMP(img512, electronRes + "/icons/InstallerSidebarImage/164-314IOS.bmp");
    writeSidebarBMP(img512, electronRes + "/installerSidebar.bmp");

    // 5. macOS .icns via Apple iconutil
    std::string iconsetPath = tmpDir + "/Scratchbox.iconset";
    fs::create_directories(iconsetPath);

    std::vector<std::pair<int, std::string>> macSizes = {
        {16, "icon_16x16.png"},
        {32, "icon_16x16@2x.png"},
        {32, "icon_32x32.png"},
        {64, "icon_32x32@2x.png"},
        {128, "icon_128x128.png"},
        {256, "icon_128x128@2x.png"},
        {256, "icon_256x256.png"},
        {512, "icon_256x256@2x.png"},
        {512, "icon_512x512.png"},
        {1024, "icon_512x512@2x.png"}
    };

    for (const auto& item : macSizes) {
        CGImageRef scaled = renderSquareLogo(srcImg, item.first);
        writePNG(scaled, iconsetPath + "/" + item.second);
        CGImageRelease(scaled);
    }

    std::string macIconDir = electronRes + "/icons/MacLauncherIcon";
    fs::create_directories(macIconDir);
    std::string icnsOut1 = macIconDir + "/512-512-2.icns";
    std::string icnsOut2 = electronRes + "/icon.icns";
    std::string icnsDesktop = rootDir + "/desktop-app/resources/icon.icns";

    std::string cmd = "iconutil -c icns '" + iconsetPath + "' -o '" + icnsOut1 + "'";
    int ret = system(cmd.c_str());
    if (ret == 0) {
        fs::copy_file(icnsOut1, icnsOut2, fs::copy_options::overwrite_existing);
        fs::copy_file(icnsOut1, icnsDesktop, fs::copy_options::overwrite_existing);
        std::cout << "Successfully generated macOS ICNS: " << icnsOut1 << std::endl;
    } else {
        std::cerr << "Warning: iconutil returned code: " << ret << std::endl;
    }

    CGImageRelease(img1024);
    CGImageRelease(img512);
    CGImageRelease(srcImg);
    CFRelease(src);
    CFRelease(inUrl);

    std::cout << "Icon generation completed successfully!" << std::endl;
    return 0;
}
