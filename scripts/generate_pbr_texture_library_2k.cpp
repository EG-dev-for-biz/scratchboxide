/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * 50-Material 2K PBR Texture Library Generator & Multi-Source Synthesis CLI
 * Synthesizes 50 biophysically calibrated PBR material sets at up to 2K resolution,
 * packing Albedo, Normal, Roughness, Metallic, Cavity AO, and packed ORM maps.
 ********************************************************************************/

#include "scratchbox_engine.hpp"
#include <iostream>
#include <fstream>
#include <vector>
#include <string>
#include <chrono>
#include <filesystem>
#include <iomanip>

namespace fs = std::filesystem;
using namespace scratchbox;
using namespace scratchbox::pbr_texture;

// Helper to write binary PPM (P6)
bool writePpm(const ImageBuffer& buf, const std::string& path) {
    std::ofstream out(path, std::ios::binary);
    if (!out) return false;
    out << "P6\n" << buf.width << " " << buf.height << "\n255\n";
    for (int y = 0; y < buf.height; ++y) {
        for (int x = 0; x < buf.width; ++x) {
            Vec3 c = buf.getPixelRGB(x, y);
            uint8_t rgb[3] = {
                static_cast<uint8_t>(std::clamp(c.x, 0.0f, 1.0f) * 255.0f + 0.5f),
                static_cast<uint8_t>(std::clamp(c.y, 0.0f, 1.0f) * 255.0f + 0.5f),
                static_cast<uint8_t>(std::clamp(c.z, 0.0f, 1.0f) * 255.0f + 0.5f)
            };
            out.write(reinterpret_cast<char*>(rgb), 3);
        }
    }
    return true;
}

int main(int argc, char* argv[]) {
    int res = 2048;
    std::string outDir = "public/textures/pbr50";
    bool generateAtlas = true;
    int singleMaterial = -1;

    for (int i = 1; i < argc; ++i) {
        std::string arg = argv[i];
        if (arg == "--resolution" && i + 1 < argc) {
            res = std::stoi(argv[++i]);
        } else if (arg == "--output-dir" && i + 1 < argc) {
            outDir = argv[++i];
        } else if (arg == "--single" && i + 1 < argc) {
            singleMaterial = std::stoi(argv[++i]);
        }
    }

    std::cout << "========================================================\n";
    std::cout << "Scratchbox IDE: 50-Material 2K PBR Texture Library Engine\n";
    std::cout << "========================================================\n";
    std::cout << "Target Resolution: " << res << " x " << res << " per channel (2K Native)\n";
    std::cout << "Output Directory:  " << outDir << "\n";
    std::cout << "Hardware Threads:   " << std::thread::hardware_concurrency() << "\n\n";

    fs::create_directories(outDir);

    const auto& catalog = get50PbrMaterialCatalog();
    std::cout << "Loaded " << catalog.size() << " PBR Material Archetypes across 7 Architectural Categories:\n";

    // Print Category Summary
    std::string lastCat = "";
    int catCount = 0;
    for (const auto& item : catalog) {
        if (item.category != lastCat) {
            lastCat = item.category;
            catCount++;
            std::cout << "  [" << catCount << "] " << lastCat << "\n";
        }
        std::cout << "      #" << std::setw(2) << std::setfill('0') << static_cast<int>(item.id)
                  << ": " << item.displayName
                  << " (Roughness: " << std::fixed << std::setprecision(2) << item.baseRoughness
                  << ", Metallic: " << item.baseMetallic << ")\n";
    }

    auto t0 = std::chrono::high_resolution_clock::now();

    // Generate JSON manifest
    std::ofstream jsonOut(outDir + "/manifest.json");
    jsonOut << "{\n  \"version\": \"2.0.0\",\n  \"resolution\": " << res << ",\n  \"materialCount\": " << catalog.size() << ",\n  \"materials\": [\n";

    // 50-material Contact Sheet: 10 columns x 5 rows
    int swatchSize = 256;
    int gridCols = 10;
    int gridRows = 5;
    ImageBuffer atlasAlbedo(gridCols * swatchSize, gridRows * swatchSize, 3);
    ImageBuffer atlasNormal(gridCols * swatchSize, gridRows * swatchSize, 3);
    ImageBuffer atlasOrm(gridCols * swatchSize, gridRows * swatchSize, 3);

    size_t processed = 0;
    for (size_t i = 0; i < catalog.size(); ++i) {
        if (singleMaterial >= 0 && static_cast<int>(i) != singleMaterial) continue;

        const auto& desc = catalog[i];
        std::cout << "\n[" << (i + 1) << "/50] Synthesizing 2K PBR set: " << desc.displayName << " ... " << std::flush;

        auto matT0 = std::chrono::high_resolution_clock::now();
        PbrTextureSet pbrSet = generatePbrMaterial(desc.id, res, res, 1337 + static_cast<uint32_t>(i) * 17);
        auto matT1 = std::chrono::high_resolution_clock::now();
        double matMs = std::chrono::duration<double, std::milli>(matT1 - matT0).count();

        std::cout << "Done (" << std::fixed << std::setprecision(1) << matMs << " ms)\n";

        // Blit downscaled swatch into the 50-material contact sheet
        int col = static_cast<int>(i % gridCols);
        int row = static_cast<int>(i / gridCols);
        int startX = col * swatchSize;
        int startY = row * swatchSize;

        for (int sy = 0; sy < swatchSize; ++sy) {
            float v = static_cast<float>(sy) / static_cast<float>(swatchSize);
            for (int sx = 0; sx < swatchSize; ++sx) {
                float u = static_cast<float>(sx) / static_cast<float>(swatchSize);
                Vec3 alb = pbrSet.albedo.sampleBilinear(u, v);
                Vec3 norm = pbrSet.normal.sampleBilinear(u, v);
                Vec3 orm = pbrSet.orm.sampleBilinear(u, v);

                // Add subtle border around each swatch
                if (sx == 0 || sx == swatchSize - 1 || sy == 0 || sy == swatchSize - 1) {
                    alb = Vec3(0.1f, 0.1f, 0.12f);
                }

                atlasAlbedo.setPixelRGB(startX + sx, startY + sy, alb);
                atlasNormal.setPixelRGB(startX + sx, startY + sy, norm);
                atlasOrm.setPixelRGB(startX + sx, startY + sy, orm);
            }
        }

        // Write individual high-res preview files for sample archetypes (first 10, or selected)
        if (i < 12 || static_cast<int>(i) == singleMaterial) {
            std::string sampleBase = outDir + "/" + desc.key;
            writePpm(pbrSet.albedo, sampleBase + "_albedo.ppm");
            writePpm(pbrSet.normal, sampleBase + "_normal.ppm");
            writePpm(pbrSet.orm, sampleBase + "_orm.ppm");
        }

        // Add to JSON manifest
        jsonOut << "    {\n"
                << "      \"id\": " << static_cast<int>(desc.id) << ",\n"
                << "      \"key\": \"" << desc.key << "\",\n"
                << "      \"name\": \"" << desc.displayName << "\",\n"
                << "      \"category\": \"" << desc.category << "\",\n"
                << "      \"baseRoughness\": " << desc.baseRoughness << ",\n"
                << "      \"baseMetallic\": " << desc.baseMetallic << ",\n"
                << "      \"normalStrength\": " << desc.defaultNormalStrength << ",\n"
                << "      \"description\": \"" << desc.description << "\"\n"
                << "    }" << (i + 1 < catalog.size() ? "," : "") << "\n";

        processed++;
    }

    jsonOut << "  ]\n}\n";
    jsonOut.close();

    // Export 50-material contact sheet atlas
    if (generateAtlas) {
        std::cout << "\nWriting 50-material 10x5 Contact Sheet Atlas (Albedo, Normal, ORM)...\n";
        writePpm(atlasAlbedo, outDir + "/pbr50_atlas_albedo.ppm");
        writePpm(atlasNormal, outDir + "/pbr50_atlas_normal.ppm");
        writePpm(atlasOrm, outDir + "/pbr50_atlas_orm.ppm");
    }

    auto t1 = std::chrono::high_resolution_clock::now();
    double totalSec = std::chrono::duration<double>(t1 - t0).count();

    std::cout << "\n========================================================\n";
    std::cout << "SUCCESS: Synthesized " << processed << " PBR Material Sets at " << res << "x" << res << "\n";
    std::cout << "Total Elapsed Time: " << std::fixed << std::setprecision(2) << totalSec << " seconds\n";
    std::cout << "Average Throughput: " << std::fixed << std::setprecision(1) << (totalSec / processed * 1000.0) << " ms per material set\n";
    std::cout << "Manifest File:      " << outDir << "/manifest.json\n";
    std::cout << "Contact Sheet Atlas: " << outDir << "/pbr50_atlas_albedo.ppm\n";
    std::cout << "PBR_50_SYNTHESIS_SUCCESS\n";
    std::cout << "========================================================\n";

    return 0;
}
