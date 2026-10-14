#include <CoreFoundation/CoreFoundation.h>
#include <CoreGraphics/CoreGraphics.h>
#include <ImageIO/ImageIO.h>
#include <iostream>
#include <string>

void cropAndSave(const std::string& inPath, const std::string& outPath, double x, double y, double w, double h) {
    CFURLRef inUrl = CFURLCreateFromFileSystemRepresentation(kCFAllocatorDefault, (const UInt8*)inPath.c_str(), inPath.length(), false);
    CGImageSourceRef source = CGImageSourceCreateWithURL(inUrl, NULL);
    if (!source) {
        CFRelease(inUrl);
        std::cerr << "Failed to open source: " << inPath << std::endl;
        return;
    }
    CGImageRef img = CGImageSourceCreateImageAtIndex(source, 0, NULL);
    CFRelease(source);
    CFRelease(inUrl);
    if (!img) return;

    CGRect cropRect = CGRectMake(x, y, w, h);
    CGImageRef cropped = CGImageCreateWithImageInRect(img, cropRect);
    CGImageRelease(img);
    if (!cropped) return;

    CFURLRef outUrl = CFURLCreateFromFileSystemRepresentation(kCFAllocatorDefault, (const UInt8*)outPath.c_str(), outPath.length(), false);
    CGImageDestinationRef dest = CGImageDestinationCreateWithURL(outUrl, CFSTR("public.png"), 1, NULL);
    if (dest) {
        CGImageDestinationAddImage(dest, cropped, NULL);
        CGImageDestinationFinalize(dest);
        CFRelease(dest);
        std::cout << "Saved crop to: " << outPath << std::endl;
    }
    CFRelease(outUrl);
    CGImageRelease(cropped);
}

int main(int argc, char** argv) {
    std::string master = "public/renders/colosseum/clean_stage3_master.png";
    std::string artDir = "/Users/eligreen/.gemini/antigravity/brain/bec1637c-d213-4e3f-82c8-d1ddd168b931/";

    // 1. Botanical Trees: Parco del Celio (Cypresses + Umbrella Pines)
    cropAndSave(master, artDir + "proof_crop_botanical_cypress_pines.png", 880, 680, 700, 300);

    // 2. Arch of Constantine
    cropAndSave(master, artDir + "proof_crop_arch_constantine_undercut.png", 520, 650, 300, 200);

    // 3. Ground Truth Preserved Travertine Interior & Hypogeum (No blue shadows, warm neutral stone)
    cropAndSave(master, artDir + "proof_crop_interior_delighting.png", 700, 220, 700, 420);

    // 4. Road Curbs and Paving Slabs
    cropAndSave(master, artDir + "proof_crop_road_basalt_curbs.png", 880, 520, 620, 280);

    return 0;
}
