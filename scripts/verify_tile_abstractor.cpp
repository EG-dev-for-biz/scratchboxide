#include "scratchbox_engine.hpp"
#include <iostream>
#include <cassert>

int main() {
    std::string tilePath = "scripts/models/empire_state_building_raw_tile.glb";
    std::cout << "[Verify] Abstracting Architectural DNA from: " << tilePath << std::endl;

    auto dna = sb::abstractor::TileBuildingAbstractor::abstractFromGlb(tilePath, "Empire State Building");
    dna.printSummary();

    // Verification Assertions
    if (dna.totalVerticesSampled == 0) {
        std::cerr << "FAIL: No vertices sampled!" << std::endl;
        return 1;
    }

    std::cout << "[Verification Checks]:\n";
    std::cout << "  Vertices: " << dna.totalVerticesSampled << " (Expected ~4656)\n";
    std::cout << "  Triangles: " << (dna.totalIndicesSampled / 3) << " (Expected ~2328)\n";
    std::cout << "  Height: " << dna.totalHeight << " m (Expected ~443.2 m)\n";
    std::cout << "  Width: " << dna.footprintWidth << " m (Expected ~129.5 m)\n";
    std::cout << "  Depth: " << dna.footprintDepth << " m (Expected ~57.3 m)\n";
    std::cout << "  Setbacks detected: " << dna.setbacks.size() << " tiers\n";
    std::cout << "  Floor Height: " << dna.rhythm.detectedFloorHeight << " m\n";
    std::cout << "  Floor Count: " << dna.rhythm.estimatedFloorCount << "\n";
    std::cout << "  Materials Clustered: " << dna.allMaterials.size() << "\n";

    assert(dna.totalHeight > 400.0f);
    assert(dna.footprintWidth > 120.0f);
    assert(dna.footprintDepth > 50.0f);
    assert(!dna.setbacks.empty());
    assert(dna.rhythm.detectedFloorHeight >= 3.0f && dna.rhythm.detectedFloorHeight <= 4.5f);
    assert(dna.allMaterials.size() >= 6);

    std::cout << "\n>>> ALL ARCHITECTURAL DNA ABSTRACTION CHECKS PASSED SUCCESSFULLY! <<<\n";
    return 0;
}
