#include <iostream>
#include <CoreGraphics/CoreGraphics.h>
#include <ImageIO/ImageIO.h>

int main() {
    CFURLRef url = CFURLCreateWithFileSystemPath(kCFAllocatorDefault, 
        CFSTR("/Users/eligreen/.gemini/antigravity/brain/bec1637c-d213-4e3f-82c8-d1ddd168b931/clean_stage3_master.png"), 
        kCFURLPOSIXPathStyle, false);
    CGImageSourceRef src = CGImageSourceCreateWithURL(url, nullptr);
    CGImageRef img = CGImageSourceCreateImageAtIndex(src, 0, nullptr);
    int w = CGImageGetWidth(img);
    int h = CGImageGetHeight(img);
    std::cout << "Image size: " << w << "x" << h << std::endl;
    
    // Create bitmap context
    CGColorSpaceRef cs = CGColorSpaceCreateDeviceRGB();
    std::vector<uint8_t> buf(w * h * 4);
    CGContextRef ctx = CGBitmapContextCreate(buf.data(), w, h, 8, w * 4, cs, kCGImageAlphaPremultipliedLast);
    CGContextDrawImage(ctx, CGRectMake(0, 0, w, h), img);
    
    // Find clusters of black pixels surrounded by non-black pixels (holes inside the model)
    // Black in model-viewer background is 0,0,0,255 or transparent
    // Look for black pixels between x: 200..800, y: 300..800
    for (int y = 200; y < 800; y += 10) {
        for (int x = 200; x < 900; x += 10) {
            uint8_t r = buf[(y * w + x) * 4 + 0];
            uint8_t g = buf[(y * w + x) * 4 + 1];
            uint8_t b = buf[(y * w + x) * 4 + 2];
            uint8_t a = buf[(y * w + x) * 4 + 3];
            // Check if pitch black
            if (r == 0 && g == 0 && b == 0) {
                // Check if neighbors have color (i.e. inside the model)
                int coloredNeighbors = 0;
                for (int dy = -40; dy <= 40; dy += 20) {
                    for (int dx = -40; dx <= 40; dx += 20) {
                        int nx = x + dx, ny = y + dy;
                        if (nx >= 0 && nx < w && ny >= 0 && ny < h) {
                            if (buf[(ny * w + nx) * 4 + 0] > 50 || buf[(ny * w + nx) * 4 + 1] > 50) {
                                coloredNeighbors++;
                            }
                        }
                    }
                }
                if (coloredNeighbors >= 15) {
                    std::cout << "Internal black hole detected near pixel: (" << x << ", " << y << ")" << std::endl;
                }
            }
        }
    }
    return 0;
}
