#include <iostream>
#include <cassert>
#include <cmath>
#include "scratchbox_engine.hpp"

using namespace scratchbox;
using namespace scratchbox::abstractor;

int main() {
    std::cout << "=========================================================\n";
    std::cout << "TEST SUITE: TileShapeExtractor Geometry Verification\n";
    std::cout << "=========================================================\n";

    std::string glbPath = "scripts/models/empire_state_building_cleaned_tile.glb";
    auto dna = TileBuildingAbstractor::abstractFromGlb(glbPath, "Empire State Building");

    auto shape = TileShapeExtractor::extractBuildingShape(glbPath, dna, true);

    std::cout << "\n[ASSERTION CHECKS]\n";
    std::cout << "1. Checking total tile triangles preserved: " << shape.totalOriginalTriangles << " -> " << shape.totalExtractedTriangles << "\n";
    assert(shape.totalOriginalTriangles >= 2328 && "Tile mesh must contain at least 2328 triangles");
    assert(shape.totalExtractedTriangles >= shape.totalOriginalTriangles && "Extracted mesh must preserve or enhance triangle count");

    size_t plinthTris = shape.granitePlinth.indices.size() / 3;
    size_t facadeTris = shape.limestoneFacade.indices.size() / 3;
    size_t roofTris = shape.terraceRoofs.indices.size() / 3;
    size_t mastTris = shape.mooringMast.indices.size() / 3;
    size_t glassTris = shape.windowGlazing.indices.size() / 3;
    size_t spandrelTris = shape.spandrelMetal.indices.size() / 3;
    size_t bronzeTris = shape.castBronzePortals.indices.size() / 3;
    size_t sidewalkTris = shape.sidewalkStreet.indices.size() / 3;

    std::cout << "2. Submesh Triangle Counts:\n";
    std::cout << "   - Granite Plinth:    " << plinthTris << "\n";
    std::cout << "   - Limestone Facade:  " << facadeTris << "\n";
    std::cout << "   - Terrace Roofs:     " << roofTris << "\n";
    std::cout << "   - Mooring Mast:      " << mastTris << "\n";
    std::cout << "   - Window Glazing:    " << glassTris << "\n";
    std::cout << "   - Spandrels:         " << spandrelTris << "\n";
    std::cout << "   - Bronze Portals:    " << bronzeTris << "\n";
    std::cout << "   - Sidewalk/Street:   " << sidewalkTris << "\n";

    assert(plinthTris >= 40 && "Plinth must contain at least 40 triangles");
    assert(facadeTris >= 1300 && "Limestone facade must contain at least 1300 triangles");
    assert(roofTris >= 600 && "Terrace roofs must contain at least 600 triangles");
    assert(glassTris > 0 && "Fenestration window glazing must be generated");
    assert(spandrelTris > 0 && "Cast aluminum spandrels must be generated");
    assert(sidewalkTris >= 1000 && "Sidewalk street plane must contain at least 1000 triangles");

    std::cout << "3. Checking Terrace Roof Normal Orientations (+Y up)...\n";
    for (size_t t = 0; t < roofTris; ++t) {
        auto v0 = shape.terraceRoofs.vertices[shape.terraceRoofs.indices[t * 3]];
        auto v1 = shape.terraceRoofs.vertices[shape.terraceRoofs.indices[t * 3 + 1]];
        auto v2 = shape.terraceRoofs.vertices[shape.terraceRoofs.indices[t * 3 + 2]];

        math::Vec3 fn = (v1.position - v0.position).cross(v2.position - v0.position);
        float len = fn.length();
        if (len > 1e-6f) fn = fn / len;
        assert(fn.y > 0.5f && "Roof triangle normal must point UP (+Y)");
    }
    std::cout << "   -> All " << roofTris << " terrace roof triangles verified pointing upwards!\n";

    std::cout << "\n>>> ALL TILE SHAPE EXTRACTION VERIFICATION TESTS PASSED SUCCESSFULLY! <<<\n";
    return 0;
}
