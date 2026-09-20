/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

#ifndef SCRATCHBOX_PBR_50_LIBRARY_HPP
#define SCRATCHBOX_PBR_50_LIBRARY_HPP

#include "scratchbox_math.hpp"
#include "scratchbox_texture.hpp"
#include "scratchbox_pbr_texture_expert.hpp"
#include <vector>
#include <string>
#include <cmath>
#include <algorithm>
#include <cstdint>
#include <thread>
#include <future>
#include <functional>

namespace scratchbox {
namespace pbr_texture {

using math::Vec2;
using math::Vec3;
using math::Vec4;
using math::FastNoise3D;
using texture::ImageBuffer;
using texture::PbrTextureSet;
using texture::packOrmTexture;

// ============================================================================
// 1. Complete 50-Material Taxonomy Enumeration
// ============================================================================

enum class PbrMaterialArchetype : uint32_t {
    // Category 1: Architectural Stone & Masonry (0..9)
    INDIANA_LIMESTONE_HONED          = 0,
    PORTLAND_STONE_WEATHERED         = 1,
    ROMAN_TRAVERTINE_POLISHED        = 2,
    STRATIFIED_SANDSTONE             = 3,
    CARRARA_STATUARIO_MARBLE         = 4,
    NERO_MARQUINA_BLACK_MARBLE       = 5,
    CHARCOAL_GRANITE_PLINTH          = 6,
    GREY_FLAMED_GRANITE              = 7,
    VOLCANIC_BASALT_VESICULAR        = 8,
    WELSH_ROOFING_SLATE              = 9,

    // Category 2: Structural Concrete & Paving (10..17)
    WEATHERED_STRUCTURAL_CONCRETE    = 10,
    SCORED_SIDEWALK_PAVEMENT         = 11,
    EXPOSED_AGGREGATE_CONCRETE       = 12,
    HEAVY_ASPHALT_ROADWAY            = 13,
    EUROPEAN_COBBLESTONE_PAVERS      = 14,
    FLEMISH_BOND_RED_BRICK           = 15,
    WEATHERED_EXTERIOR_STUCCO        = 16,
    POLISHED_ARCHITECTURAL_TERRAZZO  = 17,

    // Category 3: Architectural Metals & Alloys (18..29)
    STATUARY_CAST_BRONZE             = 18,
    POLISHED_ARCHITECTURAL_BRASS     = 19,
    AEROSPACE_BRUSHED_TITANIUM       = 20,
    TURNED_LATHE_ALUMINUM            = 21,
    HOT_DIPPED_GALVANIZED_STEEL      = 22,
    CORTEN_WEATHERING_STEEL          = 23,
    WROUGHT_ORNAMENTAL_IRON          = 24,
    MIRROR_FINISH_CHROME             = 25,
    OXIDIZED_COPPER_VERDIGRIS        = 26,
    ANODIZED_CHAMPAGNE_GOLD          = 27,
    BRUSHED_STAINLESS_STEEL_316      = 28,
    CAST_PEWTER_LEAD_FLASHING        = 29,

    // Category 4: Architectural Glazing & Translucent (30..35)
    SOLAR_LOW_E_REFLECTIVE_GLASS     = 30,
    ULTRA_CLEAR_LOW_IRON_GLASS       = 31,
    FLUTED_REEDED_ARCHITECTURAL_GLASS= 32,
    ACID_ETCHED_FROSTED_GLASS        = 33,
    WIRE_REINFORCED_SAFETY_GLASS     = 34,
    TINTED_BRONZE_SOLAR_GLASS        = 35,

    // Category 5: Roofing & Waterproofing Systems (36..41)
    BITUMEN_TAR_GRAVEL_BALLAST       = 36,
    STANDING_SEAM_COPPER_ROOF        = 37,
    CORRUGATED_GALVANIZED_ROOF       = 38,
    CLAY_SPANISH_BARREL_TILES        = 39,
    STANDING_SEAM_DARK_ZINC          = 40,
    EPDM_WATERPROOFING_MEMBRANE      = 41,

    // Category 6: Timbers & Architectural Woodwork (42..45)
    WEATHERED_EXTERIOR_OAK           = 42,
    CONCENTRIC_ENDGRAIN_TIMBER       = 43,
    POLISHED_QUARTERSAWN_WALNUT      = 44,
    MARINE_TEAK_DECKING              = 45,

    // Category 7: Relief Ornaments & Weathering Finishes (46..49)
    ART_DECO_CHEVRON_SPANDREL        = 46,
    CHIPPED_ENAMEL_ON_RUSTED_IRON    = 47,
    SALT_EFFLORESCENCE_MASONRY       = 48,
    MOSSY_ROCK_CREVICE_WEATHERING    = 49
};

constexpr size_t PBR_50_ARCHETYPE_COUNT = 50;

// ============================================================================
// 2. Material Metadata Descriptor
// ============================================================================

struct MaterialDescriptor {
    PbrMaterialArchetype id;
    std::string key;
    std::string displayName;
    std::string category;
    Vec3 baseAlbedo;
    float baseRoughness;
    float baseMetallic;
    float defaultNormalStrength;
    std::string description;
};

inline const std::vector<MaterialDescriptor>& get50PbrMaterialCatalog() {
    static const std::vector<MaterialDescriptor> catalog = {
        // Stones (10)
        { PbrMaterialArchetype::INDIANA_LIMESTONE_HONED, "indiana_limestone", "Indiana Limestone (Honed)", "Stones", {0.86f, 0.83f, 0.77f}, 0.76f, 0.02f, 1.8f, "Porous warm-grey oolitic calcarenite limestone with subtle quarry grain" },
        { PbrMaterialArchetype::PORTLAND_STONE_WEATHERED, "portland_stone", "Portland Stone (Weathered)", "Stones", {0.82f, 0.81f, 0.79f}, 0.82f, 0.01f, 2.2f, "Fossiliferous British limestone with micro-shell fragments and weathered pitting" },
        { PbrMaterialArchetype::ROMAN_TRAVERTINE_POLISHED, "roman_travertine", "Roman Travertine (Polished)", "Stones", {0.88f, 0.83f, 0.72f}, 0.28f, 0.02f, 2.4f, "Cream sedimentary limestone with filled linear fibrous pore tracks" },
        { PbrMaterialArchetype::STRATIFIED_SANDSTONE, "stratified_sandstone", "Stratified Sandstone", "Stones", {0.78f, 0.58f, 0.42f}, 0.85f, 0.00f, 2.8f, "Warm ochre architectural sandstone with pronounced geological bedding laminae" },
        { PbrMaterialArchetype::CARRARA_STATUARIO_MARBLE, "carrara_marble", "Carrara Statuario Marble", "Stones", {0.95f, 0.95f, 0.94f}, 0.10f, 0.02f, 1.2f, "Pristine white metamorphic marble with delicate grey curl-warped veining" },
        { PbrMaterialArchetype::NERO_MARQUINA_BLACK_MARBLE, "nero_marquina", "Nero Marquina Black Marble", "Stones", {0.06f, 0.06f, 0.07f}, 0.12f, 0.03f, 1.4f, "Deep midnight-black limestone marble with stark branching white calcite veins" },
        { PbrMaterialArchetype::CHARCOAL_GRANITE_PLINTH, "charcoal_granite", "Charcoal Granite (Polished)", "Stones", {0.18f, 0.19f, 0.20f}, 0.32f, 0.06f, 1.8f, "Speckled dark plutonic granite with quartz, feldspar, and biotite grains" },
        { PbrMaterialArchetype::GREY_FLAMED_GRANITE, "flamed_granite", "Grey Flamed Granite", "Stones", {0.55f, 0.55f, 0.57f}, 0.88f, 0.04f, 3.2f, "Thermal flamed slip-resistant architectural granite with fractured micro-relief" },
        { PbrMaterialArchetype::VOLCANIC_BASALT_VESICULAR, "volcanic_basalt", "Volcanic Basalt (Vesicular)", "Stones", {0.14f, 0.14f, 0.15f}, 0.80f, 0.02f, 2.6f, "Dark aphanitic volcanic basalt with fine spherical gas vesicles" },
        { PbrMaterialArchetype::WELSH_ROOFING_SLATE, "welsh_slate", "Welsh Roofing Slate", "Stones", {0.22f, 0.24f, 0.28f}, 0.45f, 0.01f, 2.5f, "Cleaved metamorphic slate displaying planar sheet foliation" },

        // Concrete & Paving (8)
        { PbrMaterialArchetype::WEATHERED_STRUCTURAL_CONCRETE, "weathered_concrete", "Weathered Structural Concrete", "Concrete & Paving", {0.65f, 0.64f, 0.62f}, 0.78f, 0.02f, 2.5f, "Cast concrete with board form seams, fine aggregate specks, and micro-cracks" },
        { PbrMaterialArchetype::SCORED_SIDEWALK_PAVEMENT, "scored_sidewalk", "Scored Sidewalk Pavement", "Concrete & Paving", {0.72f, 0.71f, 0.69f}, 0.85f, 0.02f, 2.8f, "Light grey broom-finished sidewalk concrete with 1.5m scored contraction joint grid" },
        { PbrMaterialArchetype::EXPOSED_AGGREGATE_CONCRETE, "exposed_aggregate", "Exposed Aggregate Concrete", "Concrete & Paving", {0.58f, 0.54f, 0.50f}, 0.65f, 0.01f, 3.5f, "Washed river pebbles and angular quartz aggregates embedded in cement matrix" },
        { PbrMaterialArchetype::HEAVY_ASPHALT_ROADWAY, "asphalt_roadway", "Heavy Asphalt Roadway", "Concrete & Paving", {0.20f, 0.20f, 0.21f}, 0.92f, 0.01f, 3.0f, "Dense graded bituminous asphalt road with fine crushed basalt aggregates" },
        { PbrMaterialArchetype::EUROPEAN_COBBLESTONE_PAVERS, "cobblestone_pavers", "European Cobblestone Pavers", "Concrete & Paving", {0.42f, 0.40f, 0.38f}, 0.75f, 0.02f, 3.8f, "Worn basalt and granite setts with compacted dirt and fine sand mortar joints" },
        { PbrMaterialArchetype::FLEMISH_BOND_RED_BRICK, "flemish_brick", "Flemish Bond Red Brick", "Concrete & Paving", {0.62f, 0.28f, 0.18f}, 0.82f, 0.00f, 3.2f, "Aged architectural clay brickwork with recessed lime-sand mortar joints" },
        { PbrMaterialArchetype::WEATHERED_EXTERIOR_STUCCO, "exterior_stucco", "Weathered Exterior Stucco", "Concrete & Paving", {0.85f, 0.82f, 0.76f}, 0.88f, 0.00f, 2.2f, "Troweled exterior Portland cement stucco with sandy tactile grain" },
        { PbrMaterialArchetype::POLISHED_ARCHITECTURAL_TERRAZZO, "polished_terrazzo", "Polished Architectural Terrazzo", "Concrete & Paving", {0.88f, 0.86f, 0.84f}, 0.15f, 0.02f, 1.0f, "Honed composite floor featuring multi-colored marble aggregate chips in cement" },

        // Metals & Alloys (12)
        { PbrMaterialArchetype::STATUARY_CAST_BRONZE, "statuary_bronze", "Statuary Cast Bronze", "Metals", {0.58f, 0.42f, 0.22f}, 0.35f, 0.88f, 2.2f, "Architectural bronze with dark brown oxide patina and golden burnished wear" },
        { PbrMaterialArchetype::POLISHED_ARCHITECTURAL_BRASS, "polished_brass", "Polished Architectural Brass", "Metals", {0.92f, 0.78f, 0.38f}, 0.18f, 0.95f, 1.2f, "High-specular warm yellow copper-zinc alloy with subtle buffing grain" },
        { PbrMaterialArchetype::AEROSPACE_BRUSHED_TITANIUM, "brushed_titanium", "Aerospace Brushed Titanium", "Metals", {0.76f, 0.77f, 0.82f}, 0.25f, 0.96f, 2.0f, "Linear anisotropic hairline scratch pattern on durable titanium" },
        { PbrMaterialArchetype::TURNED_LATHE_ALUMINUM, "turned_aluminum", "Turned Lathe Aluminum", "Metals", {0.88f, 0.89f, 0.92f}, 0.22f, 0.95f, 2.2f, "Concentric circular lathe machining marks with anisotropic radial sheen" },
        { PbrMaterialArchetype::HOT_DIPPED_GALVANIZED_STEEL, "galvanized_steel", "Hot-Dipped Galvanized Steel", "Metals", {0.78f, 0.80f, 0.82f}, 0.30f, 0.92f, 1.8f, "Silvery zinc coating with crystalline spangle dendritic flake crystallization" },
        { PbrMaterialArchetype::CORTEN_WEATHERING_STEEL, "corten_steel", "Cor-Ten Weathering Steel", "Metals", {0.55f, 0.26f, 0.12f}, 0.88f, 0.35f, 3.2f, "Velvety iron-oxide rust patina in rich terracotta-orange tones" },
        { PbrMaterialArchetype::WROUGHT_ORNAMENTAL_IRON, "wrought_iron", "Wrought Ornamental Iron", "Metals", {0.12f, 0.12f, 0.13f}, 0.48f, 0.82f, 2.8f, "Hand-hammered black forged iron with ball-peen dimpling and edge wear" },
        { PbrMaterialArchetype::MIRROR_FINISH_CHROME, "mirror_chrome", "Mirror-Finish Chrome", "Metals", {0.98f, 0.98f, 0.99f}, 0.04f, 0.99f, 0.5f, "Ultra-smooth high-reflectance chrome conductor plating" },
        { PbrMaterialArchetype::OXIDIZED_COPPER_VERDIGRIS, "copper_verdigris", "Oxidized Copper Verdigris", "Metals", {0.35f, 0.72f, 0.58f}, 0.82f, 0.15f, 3.0f, "Atmospheric weathered copper with powdery verdigris basic carbonate crust" },
        { PbrMaterialArchetype::ANODIZED_CHAMPAGNE_GOLD, "champagne_gold", "Anodized Champagne Gold", "Metals", {0.85f, 0.75f, 0.58f}, 0.28f, 0.90f, 1.4f, "Satin architectural anodized aluminum with warm champagne gold sheen" },
        { PbrMaterialArchetype::BRUSHED_STAINLESS_STEEL_316, "stainless_steel_316", "Brushed Stainless Steel 316", "Metals", {0.88f, 0.88f, 0.90f}, 0.22f, 0.95f, 1.6f, "Marine-grade exterior stainless steel with fine directional brush lines" },
        { PbrMaterialArchetype::CAST_PEWTER_LEAD_FLASHING, "cast_pewter", "Cast Pewter / Lead Flashing", "Metals", {0.48f, 0.50f, 0.52f}, 0.52f, 0.78f, 2.0f, "Soft malleable dull grey metal with soft specular diffusion for roofing flashings" },

        // Glazing & Translucent (6)
        { PbrMaterialArchetype::SOLAR_LOW_E_REFLECTIVE_GLASS, "solar_low_e_glass", "Solar Low-E Reflective Glass", "Glazing", {0.08f, 0.12f, 0.18f}, 0.06f, 0.92f, 0.4f, "High-performance tinted architectural glazing with deep blue-grey solar reflectance" },
        { PbrMaterialArchetype::ULTRA_CLEAR_LOW_IRON_GLASS, "low_iron_glass", "Ultra-Clear Low-Iron Glass", "Glazing", {0.98f, 0.99f, 0.99f}, 0.03f, 0.02f, 0.2f, "Crystal clear Starphire glass with neutral crisp specular highlights" },
        { PbrMaterialArchetype::FLUTED_REEDED_ARCHITECTURAL_GLASS, "fluted_glass", "Fluted Reeded Architectural Glass", "Glazing", {0.85f, 0.90f, 0.92f}, 0.12f, 0.04f, 3.5f, "Prismatic vertical half-round reeded flutes for privacy and light diffusion" },
        { PbrMaterialArchetype::ACID_ETCHED_FROSTED_GLASS, "frosted_glass", "Acid-Etched Frosted Glass", "Glazing", {0.90f, 0.92f, 0.93f}, 0.45f, 0.02f, 1.2f, "Uniform transmissive micro-roughness with diffuse light scattering" },
        { PbrMaterialArchetype::WIRE_REINFORCED_SAFETY_GLASS, "wire_safety_glass", "Wire-Reinforced Safety Glass", "Glazing", {0.82f, 0.85f, 0.86f}, 0.08f, 0.08f, 1.6f, "Architectural glass with embedded internal steel diamond wire mesh" },
        { PbrMaterialArchetype::TINTED_BRONZE_SOLAR_GLASS, "tinted_bronze_glass", "Tinted Bronze Solar Glass", "Glazing", {0.25f, 0.18f, 0.12f}, 0.08f, 0.85f, 0.4f, "Warm bronze-tinted solar control float glass" },

        // Roofing & Waterproofing (6)
        { PbrMaterialArchetype::BITUMEN_TAR_GRAVEL_BALLAST, "bitumen_gravel_roof", "Bitumen Tar & Gravel Ballast", "Roofing", {0.24f, 0.23f, 0.22f}, 0.92f, 0.01f, 3.5f, "Built-up flat roof with black asphaltic bitumen and crushed mineral chip ballast" },
        { PbrMaterialArchetype::STANDING_SEAM_COPPER_ROOF, "standing_seam_copper", "Standing Seam Copper Roof", "Roofing", {0.38f, 0.65f, 0.52f}, 0.42f, 0.65f, 3.0f, "Longitudinal folded metal standing seams with pre-patinated verdigris copper" },
        { PbrMaterialArchetype::CORRUGATED_GALVANIZED_ROOF, "corrugated_roof", "Corrugated Galvanized Roof", "Roofing", {0.72f, 0.74f, 0.76f}, 0.32f, 0.92f, 3.8f, "Sinusoidal wave corrugated industrial metal sheet roofing" },
        { PbrMaterialArchetype::CLAY_SPANISH_BARREL_TILES, "spanish_clay_tiles", "Clay Spanish Barrel Tiles", "Roofing", {0.68f, 0.34f, 0.20f}, 0.82f, 0.00f, 4.0f, "Interlocking curved terracotta clay roof tiles with sun-baked patina" },
        { PbrMaterialArchetype::STANDING_SEAM_DARK_ZINC, "standing_seam_zinc", "Standing Seam Dark Zinc", "Roofing", {0.22f, 0.23f, 0.25f}, 0.38f, 0.88f, 3.0f, "Pre-weathered anthracite dark zinc standing seam roof panels" },
        { PbrMaterialArchetype::EPDM_WATERPROOFING_MEMBRANE, "epdm_membrane", "EPDM Waterproofing Membrane", "Roofing", {0.10f, 0.10f, 0.11f}, 0.70f, 0.02f, 1.2f, "Smooth black vulcanized synthetic rubber membrane with vulcanized seam tape" },

        // Timbers & Architectural Woodwork (4)
        { PbrMaterialArchetype::WEATHERED_EXTERIOR_OAK, "weathered_oak", "Weathered Exterior Oak", "Wood", {0.60f, 0.58f, 0.55f}, 0.78f, 0.00f, 2.8f, "Weathered silver-grey architectural timber with open grain and micro-fissures" },
        { PbrMaterialArchetype::CONCENTRIC_ENDGRAIN_TIMBER, "endgrain_timber", "Concentric End-Grain Timber", "Wood", {0.72f, 0.52f, 0.34f}, 0.55f, 0.00f, 2.5f, "Cross-cut timber block with circular annual rings and radial medullary rays" },
        { PbrMaterialArchetype::POLISHED_QUARTERSAWN_WALNUT, "polished_walnut", "Polished Quartersawn Walnut", "Wood", {0.38f, 0.24f, 0.14f}, 0.22f, 0.00f, 1.4f, "Fine interior architectural walnut paneling with rich chatoyancy and grain" },
        { PbrMaterialArchetype::MARINE_TEAK_DECKING, "marine_teak", "Marine Teak Decking", "Wood", {0.72f, 0.54f, 0.32f}, 0.45f, 0.00f, 2.6f, "Straight-grain golden teak boards with flexible black polysulfide caulking seams" },

        // Relief Ornaments & Weathering Finishes (4)
        { PbrMaterialArchetype::ART_DECO_CHEVRON_SPANDREL, "art_deco_chevron", "Art Deco Chevron Spandrel", "Reliefs & Finishes", {0.64f, 0.46f, 0.24f}, 0.32f, 0.85f, 3.6f, "Geometric stepped chevron relief spandrel panel in cast bronze" },
        { PbrMaterialArchetype::CHIPPED_ENAMEL_ON_RUSTED_IRON, "chipped_enamel_rust", "Chipped Enamel on Rusted Iron", "Reliefs & Finishes", {0.28f, 0.45f, 0.75f}, 0.65f, 0.40f, 3.2f, "Peeling high-gloss architectural enamel over pitted rust iron substrate" },
        { PbrMaterialArchetype::SALT_EFFLORESCENCE_MASONRY, "salt_efflorescence", "Salt Efflorescence Masonry", "Reliefs & Finishes", {0.78f, 0.55f, 0.45f}, 0.88f, 0.00f, 2.6f, "Crystalline white mineral salt efflorescence bleeding across damp brick/stone" },
        { PbrMaterialArchetype::MOSSY_ROCK_CREVICE_WEATHERING, "mossy_rock_crevice", "Mossy Rock Crevice Weathering", "Reliefs & Finishes", {0.42f, 0.48f, 0.35f}, 0.75f, 0.00f, 3.4f, "Stone masonry with moisture staining and moss/lichen vegetation in crevices" }
    };
    return catalog;
}

// ============================================================================
// 3. Multi-Threaded Parallel 2K Rasterizer Pipeline
// ============================================================================

struct PixelSample {
    Vec3 albedo;
    float height;
    float metallic;
    float roughnessMod; // +/- adjustment to base roughness
};

template <typename PixelShaderFunc>
inline PbrTextureSet synthesizePbrSetParallel(
    int width,
    int height,
    PixelShaderFunc&& shader,
    float normalStrength,
    float baseRoughness,
    float roughnessCurvatureScale = 1.0f,
    float minRoughness = 0.02f,
    float maxRoughness = 0.98f,
    float aoStrength = 1.0f
) {
    PbrTextureSet set;
    set.albedo = ImageBuffer(width, height, 3);
    set.height = ImageBuffer(width, height, 3);
    set.metallic = ImageBuffer(width, height, 3);
    set.roughness = ImageBuffer(width, height, 3);

    int numThreads = std::max(1, static_cast<int>(std::thread::hardware_concurrency()));
    int rowsPerThread = (height + numThreads - 1) / numThreads;
    std::vector<std::future<void>> futures;

    for (int t = 0; t < numThreads; ++t) {
        int y0 = t * rowsPerThread;
        int y1 = std::min(height, y0 + rowsPerThread);
        if (y0 >= height) break;

        futures.push_back(std::async(std::launch::async, [&set, &shader, width, height, y0, y1, baseRoughness]() {
            for (int y = y0; y < y1; ++y) {
                float v = static_cast<float>(y) / static_cast<float>(height);
                for (int x = 0; x < width; ++x) {
                    float u = static_cast<float>(x) / static_cast<float>(width);
                    PixelSample s = shader(u, v, x, y);

                    set.albedo.setPixelRGB(x, y, s.albedo);
                    float h = std::clamp(s.height, 0.0f, 1.0f);
                    set.height.setPixelRGB(x, y, {h, h, h});
                    float m = std::clamp(s.metallic, 0.0f, 1.0f);
                    set.metallic.setPixelRGB(x, y, {m, m, m});
                    float r = std::clamp(baseRoughness + s.roughnessMod, 0.01f, 0.99f);
                    set.roughness.setPixelRGB(x, y, {r, r, r});
                }
            }
        }));
    }

    for (auto& f : futures) {
        f.get();
    }

    // Normal Map calculation via Scharr operator
    set.normal = computeMultiFrequencyNormalMap(set.height, normalStrength);

    // Compute biophysical curvature refinement on roughness
    ImageBuffer bioRoughness = computeBiophysicalRoughness(
        set.height, baseRoughness, roughnessCurvatureScale, minRoughness, maxRoughness
    );

    // Modulate with per-pixel roughness variation
    for (int y = 0; y < height; ++y) {
        for (int x = 0; x < width; ++x) {
            float baseR = bioRoughness.getPixelRGB(x, y).x;
            float modR = set.roughness.getPixelRGB(x, y).x;
            float finalR = std::clamp((baseR * 0.7f + modR * 0.3f), minRoughness, maxRoughness);
            set.roughness.setPixelRGB(x, y, {finalR, finalR, finalR});
        }
    }

    set.ao = texture::extractCavityAO(set.height, aoStrength);
    set.orm = packOrmTexture(set.ao, set.roughness, set.metallic);
    set.isTileable = true;

    return set;
}

// ============================================================================
// 4. Procedural 2K Shaders for All 50 Material Archetypes
// ============================================================================

inline PbrTextureSet generatePbrMaterial(
    PbrMaterialArchetype archetype,
    int width = 2048,
    int height = 2048,
    uint32_t seed = 1337
) {
    const auto& catalog = get50PbrMaterialCatalog();
    uint32_t idx = static_cast<uint32_t>(archetype);
    if (idx >= catalog.size()) idx = 0;
    const auto& desc = catalog[idx];

    switch (archetype) {
        // --------------------------------------------------------------------
        // Category 1: Stones (0..9)
        // --------------------------------------------------------------------
        case PbrMaterialArchetype::INDIANA_LIMESTONE_HONED: {
            return synthesizePbrSetParallel(width, height, [seed, desc](float u, float v, int, int) -> PixelSample {
                // Running-bond ashlar courses (4 courses high, 2 blocks wide per UV tile)
                float courseY = v * 4.0f;
                int row = static_cast<int>(std::floor(courseY));
                float vBlock = courseY - std::floor(courseY);

                float stagger = (row % 2 == 0) ? 0.0f : 0.5f;
                float courseX = u * 2.0f + stagger;
                int col = static_cast<int>(std::floor(courseX));
                float uBlock = courseX - std::floor(courseX);

                // Mortar joints (12mm scale at 1.2m x 0.45m course)
                float mortarW = 0.024f;
                float mortarH = 0.038f;
                bool isMortar = (uBlock < mortarW || vBlock < mortarH);

                // Subtle individual block tone and color temperature shifts (+/- 4%)
                uint32_t blockHash = (static_cast<uint32_t>(row) * 73856093u) ^ (static_cast<uint32_t>(col) * 19349663u) ^ seed;
                float blockRand = static_cast<float>(blockHash % 1000) / 1000.0f;
                float blockTone = (blockRand - 0.5f) * 0.07f;
                Vec3 blockWarmth = (blockRand > 0.5f) ? Vec3(0.02f, 0.01f, -0.015f) : Vec3(-0.015f, 0.00f, 0.02f);

                // Oolitic calcite grit & fine chisel tooth marks
                float ooliticGrit = FastNoise3D::perlin(u * 160.0f, v * 160.0f, 0.0f, seed) * 0.035f;
                float chiselGrain = std::sin(vBlock * 64.0f * 3.14159f) * FastNoise3D::perlin(u * 32.0f, v * 4.0f, 0.0f, seed + 1) * 0.018f;
                float macroVariation = FastNoise3D::fbm(u * 6.0f, v * 6.0f, 0.0f, 4, 2.0f, 0.5f, seed + 2) * 0.045f;

                if (isMortar) {
                    Vec3 mortarCol(0.55f, 0.53f, 0.49f);
                    float h = 0.18f + ooliticGrit; // Recessed mortar channel
                    return { mortarCol, h, 0.0f, 0.16f };
                } else {
                    // Beveled stone edges rolling into recessed mortar
                    float edgeDistU = std::min(uBlock - mortarW, 1.0f - uBlock);
                    float edgeDistV = std::min(vBlock - mortarH, 1.0f - vBlock);
                    float bevel = std::min(edgeDistU / 0.045f, edgeDistV / 0.065f);
                    bevel = std::clamp(bevel, 0.0f, 1.0f);
                    bevel = std::pow(bevel, 0.42f);

                    float h = 0.52f + bevel * 0.32f + ooliticGrit + chiselGrain;
                    Vec3 col = (desc.baseAlbedo + Vec3(blockTone, blockTone, blockTone) + blockWarmth) * (0.96f + ooliticGrit + macroVariation);
                    return { col, h, desc.baseMetallic, -0.02f + ooliticGrit };
                }
            }, 2.4f, desc.baseRoughness);
        }

        case PbrMaterialArchetype::PORTLAND_STONE_WEATHERED: {
            return synthesizePbrSetParallel(width, height, [seed, desc](float u, float v, int, int) -> PixelSample {
                WorleySample w = worley2D(u * 32.0f, v * 32.0f, 0.85f, seed);
                float fossilPit = (w.f1 < 0.18f) ? -0.25f * (1.0f - w.f1 / 0.18f) : 0.0f;
                float nFbm = FastNoise3D::fbm(u * 64.0f, v * 64.0f, 0.0f, 4, 2.0f, 0.5f, seed) * 0.08f;
                float h = 0.6f + fossilPit + nFbm;
                Vec3 col = desc.baseAlbedo * (1.0f + fossilPit * 0.6f + nFbm * 0.3f);
                return { col, h, desc.baseMetallic, (fossilPit < 0.0f ? 0.12f : 0.0f) };
            }, desc.defaultNormalStrength, desc.baseRoughness);
        }

        case PbrMaterialArchetype::ROMAN_TRAVERTINE_POLISHED: {
            return synthesizePbrSetParallel(width, height, [seed, desc](float u, float v, int, int) -> PixelSample {
                float linearBand = std::sin(v * 64.0f + FastNoise3D::perlin(u * 8.0f, v * 8.0f, 0.0f, seed) * 2.0f);
                float poreNoise = FastNoise3D::perlin(u * 128.0f, v * 16.0f, 0.0f, seed + 2);
                float poreMask = math::smoothstep(0.65f, 0.85f, linearBand * 0.5f + poreNoise * 0.5f);
                float h = 0.8f - poreMask * 0.45f;
                Vec3 poreColor(0.55f, 0.48f, 0.38f);
                Vec3 col = desc.baseAlbedo * (1.0f - poreMask * 0.4f) + poreColor * (poreMask * 0.4f);
                return { col, h, desc.baseMetallic, poreMask * 0.5f };
            }, desc.defaultNormalStrength, desc.baseRoughness);
        }

        case PbrMaterialArchetype::STRATIFIED_SANDSTONE: {
            return synthesizePbrSetParallel(width, height, [seed, desc](float u, float v, int, int) -> PixelSample {
                float warp = FastNoise3D::perlin(u * 6.0f, v * 6.0f, 0.0f, seed) * 0.15f;
                float strata = std::sin((v + warp) * 48.0f * 3.14159f);
                float fineSediment = FastNoise3D::fbm(u * 64.0f, v * 64.0f, 0.0f, 4, 2.0f, 0.5f, seed + 3) * 0.12f;
                float h = 0.5f + strata * 0.15f + fineSediment;
                Vec3 darkOchre(0.62f, 0.42f, 0.28f);
                Vec3 col = desc.baseAlbedo * (0.85f + strata * 0.15f) + darkOchre * (fineSediment * 0.5f);
                return { col, h, desc.baseMetallic, strata * 0.08f };
            }, desc.defaultNormalStrength, desc.baseRoughness);
        }

        case PbrMaterialArchetype::CARRARA_STATUARIO_MARBLE: {
            return synthesizePbrSetParallel(width, height, [seed, desc](float u, float v, int, int) -> PixelSample {
                Vec2 warped = curlWarp2D(u * 3.5f, v * 3.5f, 0.45f, 2.0f, 5, seed);
                float vein = std::abs(FastNoise3D::fbm(warped.x, warped.y, 0.0f, 5, 2.0f, 0.5f, seed));
                float veinMask = math::smoothstep(0.10f, 0.01f, vein);
                float h = 0.85f - veinMask * 0.06f;
                Vec3 veinColor(0.38f, 0.40f, 0.42f);
                Vec3 col = desc.baseAlbedo * (1.0f - veinMask) + veinColor * veinMask;
                return { col, h, desc.baseMetallic, veinMask * 0.08f };
            }, desc.defaultNormalStrength, desc.baseRoughness);
        }

        case PbrMaterialArchetype::NERO_MARQUINA_BLACK_MARBLE: {
            return synthesizePbrSetParallel(width, height, [seed, desc](float u, float v, int, int) -> PixelSample {
                Vec2 warped = curlWarp2D(u * 4.0f, v * 4.0f, 0.6f, 2.2f, 5, seed + 88);
                float vein = std::abs(FastNoise3D::fbm(warped.x * 1.5f, warped.y * 1.5f, 0.0f, 5, 2.0f, 0.5f, seed + 1));
                float veinMask = math::smoothstep(0.06f, 0.005f, vein);
                float h = 0.9f - veinMask * 0.08f;
                Vec3 calciteVein(0.96f, 0.96f, 0.98f);
                Vec3 col = desc.baseAlbedo * (1.0f - veinMask) + calciteVein * veinMask;
                return { col, h, desc.baseMetallic, veinMask * 0.06f };
            }, desc.defaultNormalStrength, desc.baseRoughness);
        }

        case PbrMaterialArchetype::CHARCOAL_GRANITE_PLINTH: {
            return synthesizePbrSetParallel(width, height, [seed, desc](float u, float v, int, int) -> PixelSample {
                // Rusticated granite blocks (2 courses high, 1 block wide per UV tile)
                float blockV = v * 2.0f;
                int row = static_cast<int>(std::floor(blockV));
                float vFrac = blockV - std::floor(blockV);

                float stagger = (row % 2 == 0) ? 0.0f : 0.5f;
                float blockU = u + stagger;
                float uFrac = blockU - std::floor(blockU);

                // Deep horizontal V-groove rustication (0.05 height) & vertical joint (0.03 width)
                float grooveV = 0.05f;
                float grooveU = 0.03f;
                bool isJoint = (vFrac < grooveV || uFrac < grooveU);

                // Plutonic mineral crystals: Quartz, Feldspar, Biotite
                WorleySample w = worley2D(u * 80.0f, v * 80.0f, 1.0f, seed);
                float crystalGrain = w.f2_minus_f1;
                float quartzFleck = (crystalGrain > 0.68f) ? 1.0f : 0.0f;
                float biotite = (crystalGrain < 0.12f) ? 1.0f : 0.0f;
                float feldspar = (crystalGrain >= 0.12f && crystalGrain <= 0.68f) ? 1.0f : 0.0f;

                Vec3 quartzCol(0.65f, 0.66f, 0.70f);
                Vec3 biotiteCol(0.04f, 0.04f, 0.05f);
                Vec3 feldsparCol(0.18f, 0.19f, 0.20f);

                Vec3 col = feldsparCol;
                if (quartzFleck > 0.5f) col = quartzCol;
                else if (biotite > 0.5f) col = biotiteCol;

                if (isJoint) {
                    Vec3 mortarCol(0.06f, 0.06f, 0.07f);
                    float h = 0.15f; // Deep recessed rustication groove
                    return { mortarCol, h, 0.01f, 0.25f };
                } else {
                    // Beveled V-groove chamfer around block perimeter
                    float edgeDistU = std::min(uFrac - grooveU, 1.0f - uFrac);
                    float edgeDistV = std::min(vFrac - grooveV, 1.0f - vFrac);
                    float chamfer = std::min(edgeDistU / 0.06f, edgeDistV / 0.08f);
                    chamfer = std::clamp(chamfer, 0.0f, 1.0f);
                    chamfer = std::pow(chamfer, 0.5f);

                    float h = 0.55f + chamfer * 0.35f + crystalGrain * 0.06f;
                    return { col, h, desc.baseMetallic, (biotite > 0.5f ? 0.08f : -0.04f) };
                }
            }, 2.6f, desc.baseRoughness);
        }

        case PbrMaterialArchetype::GREY_FLAMED_GRANITE: {
            return synthesizePbrSetParallel(width, height, [seed, desc](float u, float v, int, int) -> PixelSample {
                float spall = FastNoise3D::fbm(u * 64.0f, v * 64.0f, 0.0f, 5, 2.2f, 0.6f, seed);
                float microChip = FastNoise3D::perlin(u * 256.0f, v * 256.0f, 0.0f, seed + 4) * 0.15f;
                float h = 0.5f + spall * 0.35f + microChip;
                Vec3 col = desc.baseAlbedo * (0.85f + spall * 0.25f);
                return { col, h, desc.baseMetallic, spall * 0.1f };
            }, desc.defaultNormalStrength, desc.baseRoughness);
        }

        case PbrMaterialArchetype::VOLCANIC_BASALT_VESICULAR: {
            return synthesizePbrSetParallel(width, height, [seed, desc](float u, float v, int, int) -> PixelSample {
                WorleySample w = worley2D(u * 48.0f, v * 48.0f, 0.9f, seed);
                float bubble = (w.f1 < 0.16f) ? -0.38f * (1.0f - w.f1 / 0.16f) : 0.0f;
                float grit = FastNoise3D::perlin(u * 128.0f, v * 128.0f, 0.0f, seed) * 0.06f;
                float h = 0.6f + bubble + grit;
                Vec3 col = desc.baseAlbedo * (1.0f + bubble * 0.5f);
                return { col, h, desc.baseMetallic, (bubble < 0.0f ? 0.15f : 0.0f) };
            }, desc.defaultNormalStrength, desc.baseRoughness);
        }

        case PbrMaterialArchetype::WELSH_ROOFING_SLATE: {
            return synthesizePbrSetParallel(width, height, [seed, desc](float u, float v, int, int) -> PixelSample {
                float layerStep = std::floor(v * 24.0f + FastNoise3D::perlin(u * 8.0f, v * 8.0f, 0.0f, seed) * 0.8f);
                float stepVal = std::fmod(layerStep, 3.0f) * 0.08f;
                float grain = FastNoise3D::perlin(u * 256.0f, v * 16.0f, 0.0f, seed + 1) * 0.04f;
                float h = 0.5f + stepVal + grain;
                Vec3 col = desc.baseAlbedo * (0.92f + stepVal * 0.5f);
                return { col, h, desc.baseMetallic, stepVal * 0.1f };
            }, desc.defaultNormalStrength, desc.baseRoughness);
        }

        // --------------------------------------------------------------------
        // Category 2: Structural Concrete & Paving (10..17)
        // --------------------------------------------------------------------
        case PbrMaterialArchetype::WEATHERED_STRUCTURAL_CONCRETE: {
            return synthesizePbrSetParallel(width, height, [seed, desc](float u, float v, int, int) -> PixelSample {
                float formworkSeam = std::abs(std::sin(v * 8.0f * 3.14159f));
                float seamDip = (formworkSeam < 0.03f) ? -0.2f : 0.0f;
                float aggregate = FastNoise3D::fbm(u * 64.0f, v * 64.0f, 0.0f, 5, 2.0f, 0.5f, seed) * 0.12f;
                float h = 0.55f + seamDip + aggregate;
                Vec3 col = desc.baseAlbedo * (1.0f + aggregate * 0.4f + seamDip * 0.5f);
                return { col, h, desc.baseMetallic, aggregate * 0.1f };
            }, desc.defaultNormalStrength, desc.baseRoughness);
        }

        case PbrMaterialArchetype::SCORED_SIDEWALK_PAVEMENT: {
            return synthesizePbrSetParallel(width, height, [seed, desc](float u, float v, int, int) -> PixelSample {
                // 1.5m sidewalk grid contraction joints
                float gridU = std::abs(std::sin(u * 8.0f * 3.14159f));
                float gridV = std::abs(std::sin(v * 8.0f * 3.14159f));
                bool isJoint = (gridU < 0.025f || gridV < 0.025f);
                float broomFinish = FastNoise3D::perlin(u * 512.0f, v * 16.0f, 0.0f, seed) * 0.04f;
                float h = isJoint ? 0.25f : (0.7f + broomFinish);
                Vec3 jointDark(0.25f, 0.24f, 0.23f);
                Vec3 col = isJoint ? jointDark : (desc.baseAlbedo * (1.0f + broomFinish * 0.5f));
                return { col, h, desc.baseMetallic, isJoint ? 0.12f : 0.0f };
            }, desc.defaultNormalStrength, desc.baseRoughness);
        }

        case PbrMaterialArchetype::EXPOSED_AGGREGATE_CONCRETE: {
            return synthesizePbrSetParallel(width, height, [seed, desc](float u, float v, int, int) -> PixelSample {
                WorleySample w = worley2D(u * 40.0f, v * 40.0f, 1.0f, seed);
                float pebble = 1.0f - std::clamp(w.f1 * 1.6f, 0.0f, 1.0f);
                float pebbleCap = std::sqrt(std::max(0.0f, 1.0f - (1.0f - pebble) * (1.0f - pebble)));
                float h = 0.3f + pebbleCap * 0.55f;
                float tone = std::fmod(static_cast<float>(w.cellX * 17 + w.cellY * 31), 5.0f) * 0.1f;
                Vec3 pebbleCol = desc.baseAlbedo * (0.8f + tone);
                Vec3 matrixCol(0.48f, 0.46f, 0.44f);
                Vec3 col = (pebbleCap > 0.2f) ? pebbleCol : matrixCol;
                return { col, h, desc.baseMetallic, (pebbleCap > 0.2f ? -0.1f : 0.15f) };
            }, desc.defaultNormalStrength, desc.baseRoughness);
        }

        case PbrMaterialArchetype::HEAVY_ASPHALT_ROADWAY: {
            return synthesizePbrSetParallel(width, height, [seed, desc](float u, float v, int, int) -> PixelSample {
                float aggregate = FastNoise3D::fbm(u * 128.0f, v * 128.0f, 0.0f, 5, 2.0f, 0.5f, seed);
                float bitumenPore = (FastNoise3D::perlin(u * 64.0f, v * 64.0f, 0.0f, seed + 3) < -0.2f) ? -0.15f : 0.0f;
                float h = 0.5f + aggregate * 0.25f + bitumenPore;
                Vec3 col = desc.baseAlbedo * (0.9f + aggregate * 0.3f);
                return { col, h, desc.baseMetallic, aggregate * 0.05f };
            }, desc.defaultNormalStrength, desc.baseRoughness);
        }

        case PbrMaterialArchetype::EUROPEAN_COBBLESTONE_PAVERS: {
            return synthesizePbrSetParallel(width, height, [seed, desc](float u, float v, int, int) -> PixelSample {
                WorleySample w = worley2D(u * 16.0f, v * 16.0f, 0.9f, seed);
                float stoneDome = std::sqrt(std::max(0.0f, 1.0f - std::min(1.0f, w.f1 * 1.7f)));
                float h = stoneDome * 0.7f + 0.15f;
                Vec3 sandJoint(0.32f, 0.29f, 0.24f);
                Vec3 col = (w.f1 > 0.45f) ? sandJoint : (desc.baseAlbedo * (0.85f + stoneDome * 0.25f));
                return { col, h, desc.baseMetallic, (w.f1 > 0.45f ? 0.2f : -0.05f) };
            }, desc.defaultNormalStrength, desc.baseRoughness);
        }

        case PbrMaterialArchetype::FLEMISH_BOND_RED_BRICK: {
            return synthesizePbrSetParallel(width, height, [seed, desc](float u, float v, int, int) -> PixelSample {
                float row = std::floor(v * 24.0f);
                float rowFrac = std::fmod(v * 24.0f, 1.0f);
                float uShift = (std::fmod(row, 2.0f) > 0.5f) ? 0.5f : 0.0f;
                float colFrac = std::fmod((u + uShift) * 12.0f, 1.0f);
                bool isMortar = (rowFrac < 0.12f || colFrac < 0.08f);
                float brickGrit = FastNoise3D::perlin(u * 128.0f, v * 128.0f, 0.0f, seed) * 0.06f;
                float h = isMortar ? 0.3f : (0.75f + brickGrit);
                Vec3 mortarCol(0.76f, 0.74f, 0.70f);
                Vec3 col = isMortar ? mortarCol : (desc.baseAlbedo * (1.0f + brickGrit * 0.5f));
                return { col, h, desc.baseMetallic, isMortar ? 0.1f : 0.0f };
            }, desc.defaultNormalStrength, desc.baseRoughness);
        }

        case PbrMaterialArchetype::WEATHERED_EXTERIOR_STUCCO: {
            return synthesizePbrSetParallel(width, height, [seed, desc](float u, float v, int, int) -> PixelSample {
                float swirl = FastNoise3D::fbm(u * 32.0f, v * 32.0f, 0.0f, 4, 2.2f, 0.55f, seed) * 0.18f;
                float sandGrit = FastNoise3D::perlin(u * 256.0f, v * 256.0f, 0.0f, seed + 1) * 0.06f;
                float h = 0.5f + swirl + sandGrit;
                Vec3 col = desc.baseAlbedo * (1.0f + swirl * 0.3f);
                return { col, h, desc.baseMetallic, swirl * 0.08f };
            }, desc.defaultNormalStrength, desc.baseRoughness);
        }

        case PbrMaterialArchetype::POLISHED_ARCHITECTURAL_TERRAZZO: {
            return synthesizePbrSetParallel(width, height, [seed, desc](float u, float v, int, int) -> PixelSample {
                WorleySample w = worley2D(u * 32.0f, v * 32.0f, 1.0f, seed);
                bool isChip = (w.f1 < 0.32f);
                float h = 0.85f;
                Vec3 col = desc.baseAlbedo;
                if (isChip) {
                    uint32_t cHash = (w.cellX * 19 + w.cellY * 37) % 4;
                    if (cHash == 0) col = Vec3(0.20f, 0.45f, 0.35f); // Green marble chip
                    else if (cHash == 1) col = Vec3(0.72f, 0.35f, 0.22f); // Terracotta chip
                    else if (cHash == 2) col = Vec3(0.12f, 0.12f, 0.14f); // Black basalt chip
                    else col = Vec3(0.92f, 0.90f, 0.85f); // White quartz chip
                }
                return { col, h, desc.baseMetallic, (isChip ? -0.05f : 0.02f) };
            }, desc.defaultNormalStrength, desc.baseRoughness);
        }

        // --------------------------------------------------------------------
        // Category 3: Metals & Alloys (18..29)
        // --------------------------------------------------------------------
        case PbrMaterialArchetype::STATUARY_CAST_BRONZE: {
            return synthesizePbrSetParallel(width, height, [seed, desc](float u, float v, int, int) -> PixelSample {
                // Art Deco fluted reed molding (8 reeds across UV tile)
                float reedPhase = std::fmod(u * 8.0f, 1.0f) - 0.5f;
                float reedRadius = 0.44f;
                float reedProfile = 0.0f;
                if (std::abs(reedPhase) < reedRadius) {
                    float dist = reedPhase / reedRadius;
                    reedProfile = std::sqrt(std::max(0.0f, 1.0f - dist * dist));
                }

                float microGrit = FastNoise3D::perlin(u * 128.0f, v * 128.0f, 0.0f, seed) * 0.035f;
                float oxideCavity = FastNoise3D::fbm(u * 16.0f, v * 16.0f, 0.0f, 4, 2.0f, 0.5f, seed + 1) * 0.08f;

                // Burnished golden crests on raised flutes, dark brown oxide in troughs
                Vec3 oxideDark(0.24f, 0.16f, 0.09f);
                Vec3 bronzeBase = desc.baseAlbedo;
                Vec3 burnishedGold(0.78f, 0.62f, 0.35f);

                Vec3 col = oxideDark * (1.0f - reedProfile) + (bronzeBase * (1.0f - reedProfile * 0.6f) + burnishedGold * (reedProfile * 0.6f)) * reedProfile;
                col = col * (0.95f + microGrit - oxideCavity * 0.5f);

                float h = 0.35f + reedProfile * 0.55f + microGrit;
                float metal = 0.75f + reedProfile * 0.20f;
                float roughMod = (1.0f - reedProfile) * 0.22f - 0.08f;

                return { col, h, metal, roughMod };
            }, 2.8f, desc.baseRoughness);
        }

        case PbrMaterialArchetype::POLISHED_ARCHITECTURAL_BRASS: {
            return synthesizePbrSetParallel(width, height, [desc](float u, float v, int, int) -> PixelSample {
                float buffLines = gaborAnisotropic2D(u * 128.0f, v * 128.0f, 0.25f, 64.0f, 2.0f) * 0.05f;
                float h = 0.85f + buffLines;
                Vec3 col = desc.baseAlbedo * (1.0f + buffLines * 0.2f);
                return { col, h, desc.baseMetallic, buffLines * 0.05f };
            }, desc.defaultNormalStrength, desc.baseRoughness);
        }

        case PbrMaterialArchetype::AEROSPACE_BRUSHED_TITANIUM: {
            return synthesizePbrSetParallel(width, height, [seed, desc](float u, float v, int, int) -> PixelSample {
                float scratches = gaborAnisotropic2D(u * 96.0f, v * 96.0f, 0.0f, 48.0f, 2.5f) * 0.12f;
                float micro = FastNoise3D::perlin(u * 512.0f, v * 16.0f, 0.0f, seed) * 0.04f;
                float h = 0.7f + scratches + micro;
                Vec3 col = desc.baseAlbedo * (0.96f + scratches * 0.1f);
                return { col, h, desc.baseMetallic, scratches * 0.08f };
            }, desc.defaultNormalStrength, desc.baseRoughness);
        }

        case PbrMaterialArchetype::TURNED_LATHE_ALUMINUM: {
            return synthesizePbrSetParallel(width, height, [desc](float u, float v, int, int) -> PixelSample {
                float dx = u - 0.5f;
                float dy = v - 0.5f;
                float r = std::sqrt(dx * dx + dy * dy);
                float latheRings = std::sin(r * 180.0f * 3.14159f) * 0.08f;
                float h = 0.75f + latheRings;
                Vec3 col = desc.baseAlbedo * (1.0f + latheRings * 0.15f);
                return { col, h, desc.baseMetallic, latheRings * 0.06f };
            }, desc.defaultNormalStrength, desc.baseRoughness);
        }

        case PbrMaterialArchetype::HOT_DIPPED_GALVANIZED_STEEL: {
            return synthesizePbrSetParallel(width, height, [seed, desc](float u, float v, int, int) -> PixelSample {
                WorleySample w = worley2D(u * 20.0f, v * 20.0f, 1.0f, seed);
                float facet = std::fmod(static_cast<float>(w.cellX * 13 + w.cellY * 29), 7.0f) * 0.06f;
                float dendritic = FastNoise3D::perlin(u * 128.0f, v * 128.0f, 0.0f, seed) * 0.04f;
                float h = 0.8f + facet + dendritic;
                Vec3 col = desc.baseAlbedo * (0.88f + facet * 1.5f);
                return { col, h, desc.baseMetallic, facet * 0.1f };
            }, desc.defaultNormalStrength, desc.baseRoughness);
        }

        case PbrMaterialArchetype::CORTEN_WEATHERING_STEEL: {
            return synthesizePbrSetParallel(width, height, [seed, desc](float u, float v, int, int) -> PixelSample {
                float rustFbm = FastNoise3D::fbm(u * 24.0f, v * 24.0f, 0.0f, 5, 2.0f, 0.5f, seed);
                float h = 0.5f + rustFbm * 0.25f;
                Vec3 deepRust(0.42f, 0.18f, 0.08f);
                Vec3 brightRust(0.72f, 0.38f, 0.14f);
                Vec3 col = deepRust * (0.6f - rustFbm * 0.3f) + brightRust * (0.4f + rustFbm * 0.4f);
                return { col, h, desc.baseMetallic, rustFbm * 0.08f };
            }, desc.defaultNormalStrength, desc.baseRoughness);
        }

        case PbrMaterialArchetype::WROUGHT_ORNAMENTAL_IRON: {
            return synthesizePbrSetParallel(width, height, [seed, desc](float u, float v, int, int) -> PixelSample {
                WorleySample w = worley2D(u * 14.0f, v * 14.0f, 0.9f, seed);
                float dimple = std::sqrt(std::max(0.0f, 1.0f - std::min(1.0f, w.f1 * 1.5f))) * 0.18f;
                float h = 0.7f - dimple;
                Vec3 burnish(0.24f, 0.24f, 0.26f);
                Vec3 col = desc.baseAlbedo * (1.0f - dimple) + burnish * dimple;
                return { col, h, desc.baseMetallic, dimple * 0.1f };
            }, desc.defaultNormalStrength, desc.baseRoughness);
        }

        case PbrMaterialArchetype::MIRROR_FINISH_CHROME: {
            return synthesizePbrSetParallel(width, height, [desc](float, float, int, int) -> PixelSample {
                return { desc.baseAlbedo, 0.98f, desc.baseMetallic, 0.0f };
            }, desc.defaultNormalStrength, desc.baseRoughness);
        }

        case PbrMaterialArchetype::OXIDIZED_COPPER_VERDIGRIS: {
            return synthesizePbrSetParallel(width, height, [seed, desc](float u, float v, int, int) -> PixelSample {
                float crustFbm = FastNoise3D::fbm(u * 16.0f, v * 16.0f, 0.0f, 4, 2.0f, 0.5f, seed);
                float h = 0.55f + crustFbm * 0.22f;
                Vec3 rawCopper(0.88f, 0.55f, 0.42f);
                float exposed = math::smoothstep(0.45f, 0.75f, crustFbm);
                Vec3 col = desc.baseAlbedo * (1.0f - exposed) + rawCopper * exposed;
                float metal = desc.baseMetallic * (1.0f - exposed) + 0.92f * exposed;
                return { col, h, metal, (1.0f - exposed) * 0.15f };
            }, desc.defaultNormalStrength, desc.baseRoughness);
        }

        case PbrMaterialArchetype::ANODIZED_CHAMPAGNE_GOLD: {
            return synthesizePbrSetParallel(width, height, [seed, desc](float u, float v, int, int) -> PixelSample {
                float satin = FastNoise3D::perlin(u * 256.0f, v * 256.0f, 0.0f, seed) * 0.03f;
                float h = 0.85f + satin;
                Vec3 col = desc.baseAlbedo * (1.0f + satin * 0.3f);
                return { col, h, desc.baseMetallic, satin * 0.05f };
            }, desc.defaultNormalStrength, desc.baseRoughness);
        }

        case PbrMaterialArchetype::BRUSHED_STAINLESS_STEEL_316: {
            return synthesizePbrSetParallel(width, height, [seed, desc](float u, float v, int, int) -> PixelSample {
                float brush = gaborAnisotropic2D(u * 80.0f, v * 80.0f, 0.0f, 40.0f, 2.0f) * 0.08f;
                float fine = FastNoise3D::perlin(u * 512.0f, v * 8.0f, 0.0f, seed) * 0.03f;
                float h = 0.8f + brush + fine;
                Vec3 col = desc.baseAlbedo * (1.0f + brush * 0.1f);
                return { col, h, desc.baseMetallic, brush * 0.05f };
            }, desc.defaultNormalStrength, desc.baseRoughness);
        }

        case PbrMaterialArchetype::CAST_PEWTER_LEAD_FLASHING: {
            return synthesizePbrSetParallel(width, height, [seed, desc](float u, float v, int, int) -> PixelSample {
                float dent = FastNoise3D::fbm(u * 12.0f, v * 12.0f, 0.0f, 3, 2.0f, 0.5f, seed) * 0.12f;
                float h = 0.65f + dent;
                Vec3 col = desc.baseAlbedo * (1.0f + dent * 0.3f);
                return { col, h, desc.baseMetallic, dent * 0.1f };
            }, desc.defaultNormalStrength, desc.baseRoughness);
        }

        // --------------------------------------------------------------------
        // Category 4: Glazing & Translucent (30..35)
        // --------------------------------------------------------------------
        case PbrMaterialArchetype::SOLAR_LOW_E_REFLECTIVE_GLASS: {
            return synthesizePbrSetParallel(width, height, [desc](float u, float v, int, int) -> PixelSample {
                // Architectural double-hung window frame (2 vertical panes, 2 horizontal sashes)
                float uPane = std::fmod(u * 2.0f, 1.0f);
                float vPane = v; // vertical span 0 to 1

                // Outer frame border (0.06 width) and center mullion / meeting rail
                bool isOuterFrame = (uPane < 0.06f || uPane > 0.94f || vPane < 0.05f || vPane > 0.95f);
                bool isMeetingRail = (vPane >= 0.48f && vPane <= 0.53f);
                bool isFrame = isOuterFrame || isMeetingRail;

                // Venetian blind louvers visible through the glass
                float blindSlat = std::sin(vPane * 48.0f * 3.14159f);
                float blindTint = (blindSlat > 0.2f) ? 0.88f : 1.0f;

                if (isFrame) {
                    Vec3 frameBronze(0.18f, 0.16f, 0.14f);
                    float h = 0.98f; // Raised frame
                    return { frameBronze, h, 0.65f, 0.28f };
                } else {
                    // Deep tinted solar glass pane
                    Vec3 glassCol(0.035f, 0.055f, 0.085f);
                    glassCol = glassCol * blindTint;
                    float h = 0.88f; // Recessed glass surface
                    return { glassCol, h, desc.baseMetallic, -0.03f };
                }
            }, 1.2f, desc.baseRoughness);
        }

        case PbrMaterialArchetype::ULTRA_CLEAR_LOW_IRON_GLASS: {
            return synthesizePbrSetParallel(width, height, [desc](float, float, int, int) -> PixelSample {
                return { desc.baseAlbedo, 0.99f, desc.baseMetallic, 0.0f };
            }, desc.defaultNormalStrength, desc.baseRoughness);
        }

        case PbrMaterialArchetype::FLUTED_REEDED_ARCHITECTURAL_GLASS: {
            return synthesizePbrSetParallel(width, height, [desc](float u, float, int, int) -> PixelSample {
                // Reeded flutes
                float flutePhase = std::fmod(u * 32.0f, 1.0f) - 0.5f;
                float flute = std::sqrt(std::max(0.0f, 0.25f - flutePhase * flutePhase)) * 2.0f;
                float h = 0.4f + flute * 0.55f;
                return { desc.baseAlbedo, h, desc.baseMetallic, 0.0f };
            }, desc.defaultNormalStrength, desc.baseRoughness);
        }

        case PbrMaterialArchetype::ACID_ETCHED_FROSTED_GLASS: {
            return synthesizePbrSetParallel(width, height, [seed, desc](float u, float v, int, int) -> PixelSample {
                float frost = FastNoise3D::perlin(u * 256.0f, v * 256.0f, 0.0f, seed) * 0.08f;
                float h = 0.7f + frost;
                return { desc.baseAlbedo, h, desc.baseMetallic, frost * 0.1f };
            }, desc.defaultNormalStrength, desc.baseRoughness);
        }

        case PbrMaterialArchetype::WIRE_REINFORCED_SAFETY_GLASS: {
            return synthesizePbrSetParallel(width, height, [desc](float u, float v, int, int) -> PixelSample {
                // Diamond wire mesh: diagonal grid lines
                float d1 = std::abs(std::sin((u + v) * 16.0f * 3.14159f));
                float d2 = std::abs(std::sin((u - v) * 16.0f * 3.14159f));
                bool isWire = (d1 < 0.04f || d2 < 0.04f);
                float h = isWire ? 0.95f : 0.75f;
                Vec3 wireCol(0.25f, 0.26f, 0.28f);
                Vec3 col = isWire ? wireCol : desc.baseAlbedo;
                float metal = isWire ? 0.95f : desc.baseMetallic;
                return { col, h, metal, isWire ? 0.15f : 0.0f };
            }, desc.defaultNormalStrength, desc.baseRoughness);
        }

        case PbrMaterialArchetype::TINTED_BRONZE_SOLAR_GLASS: {
            return synthesizePbrSetParallel(width, height, [desc](float, float, int, int) -> PixelSample {
                return { desc.baseAlbedo, 0.95f, desc.baseMetallic, 0.0f };
            }, desc.defaultNormalStrength, desc.baseRoughness);
        }

        // --------------------------------------------------------------------
        // Category 5: Roofing & Waterproofing (36..41)
        // --------------------------------------------------------------------
        case PbrMaterialArchetype::BITUMEN_TAR_GRAVEL_BALLAST: {
            return synthesizePbrSetParallel(width, height, [seed, desc](float u, float v, int, int) -> PixelSample {
                WorleySample w = worley2D(u * 48.0f, v * 48.0f, 1.0f, seed);
                float gravel = 1.0f - std::clamp(w.f1 * 1.5f, 0.0f, 1.0f);
                float h = 0.35f + gravel * 0.5f;
                Vec3 chipCol(0.55f, 0.53f, 0.50f);
                Vec3 col = desc.baseAlbedo * (1.0f - gravel * 0.7f) + chipCol * (gravel * 0.7f);
                return { col, h, desc.baseMetallic, gravel * 0.08f };
            }, desc.defaultNormalStrength, desc.baseRoughness);
        }

        case PbrMaterialArchetype::STANDING_SEAM_COPPER_ROOF: {
            return synthesizePbrSetParallel(width, height, [seed, desc](float u, float v, int, int) -> PixelSample {
                float seamPhase = std::fmod(u * 12.0f, 1.0f);
                bool isSeam = (seamPhase < 0.05f);
                float patFbm = FastNoise3D::fbm(u * 8.0f, v * 8.0f, 0.0f, 3, 2.0f, 0.5f, seed) * 0.1f;
                float h = isSeam ? 0.95f : (0.6f + patFbm);
                Vec3 seamCol(0.18f, 0.35f, 0.28f);
                Vec3 col = isSeam ? seamCol : (desc.baseAlbedo * (1.0f + patFbm * 0.3f));
                return { col, h, desc.baseMetallic, isSeam ? 0.1f : 0.0f };
            }, desc.defaultNormalStrength, desc.baseRoughness);
        }

        case PbrMaterialArchetype::CORRUGATED_GALVANIZED_ROOF: {
            return synthesizePbrSetParallel(width, height, [seed, desc](float u, float v, int, int) -> PixelSample {
                float wave = (std::sin(u * 32.0f * 3.14159f) * 0.5f + 0.5f);
                float zincSpangle = FastNoise3D::perlin(u * 128.0f, v * 128.0f, 0.0f, seed) * 0.04f;
                float h = wave * 0.7f + 0.15f + zincSpangle;
                Vec3 col = desc.baseAlbedo * (0.92f + wave * 0.16f);
                return { col, h, desc.baseMetallic, wave * 0.06f };
            }, desc.defaultNormalStrength, desc.baseRoughness);
        }

        case PbrMaterialArchetype::CLAY_SPANISH_BARREL_TILES: {
            return synthesizePbrSetParallel(width, height, [seed, desc](float u, float v, int, int) -> PixelSample {
                float row = std::floor(v * 16.0f);
                float uShift = (std::fmod(row, 2.0f) > 0.5f) ? 0.5f : 0.0f;
                float tileU = std::fmod((u + uShift) * 12.0f, 1.0f) - 0.5f;
                float arch = std::sqrt(std::max(0.0f, 0.25f - tileU * tileU)) * 2.0f;
                float rowLap = std::fmod(v * 16.0f, 1.0f);
                float lapStep = (rowLap < 0.1f) ? -0.2f : 0.0f;
                float grit = FastNoise3D::perlin(u * 64.0f, v * 64.0f, 0.0f, seed) * 0.05f;
                float h = arch * 0.65f + lapStep + grit + 0.15f;
                Vec3 col = desc.baseAlbedo * (0.85f + arch * 0.3f);
                return { col, h, desc.baseMetallic, arch * 0.08f };
            }, desc.defaultNormalStrength, desc.baseRoughness);
        }

        case PbrMaterialArchetype::STANDING_SEAM_DARK_ZINC: {
            return synthesizePbrSetParallel(width, height, [seed, desc](float u, float v, int, int) -> PixelSample {
                float seamPhase = std::fmod(u * 10.0f, 1.0f);
                bool isSeam = (seamPhase < 0.04f);
                float grain = FastNoise3D::perlin(u * 128.0f, v * 128.0f, 0.0f, seed) * 0.03f;
                float h = isSeam ? 0.95f : (0.7f + grain);
                Vec3 seamCol(0.14f, 0.14f, 0.16f);
                Vec3 col = isSeam ? seamCol : desc.baseAlbedo;
                return { col, h, desc.baseMetallic, isSeam ? 0.1f : 0.0f };
            }, desc.defaultNormalStrength, desc.baseRoughness);
        }

        case PbrMaterialArchetype::EPDM_WATERPROOFING_MEMBRANE: {
            return synthesizePbrSetParallel(width, height, [seed, desc](float u, float v, int, int) -> PixelSample {
                float seamPhase = std::fmod(v * 4.0f, 1.0f);
                bool isTape = (seamPhase < 0.05f);
                float rubberNoise = FastNoise3D::perlin(u * 128.0f, v * 128.0f, 0.0f, seed) * 0.02f;
                float h = isTape ? 0.85f : (0.7f + rubberNoise);
                Vec3 tapeCol(0.06f, 0.06f, 0.07f);
                Vec3 col = isTape ? tapeCol : desc.baseAlbedo;
                return { col, h, desc.baseMetallic, isTape ? -0.1f : 0.0f };
            }, desc.defaultNormalStrength, desc.baseRoughness);
        }

        // --------------------------------------------------------------------
        // Category 6: Timbers & Architectural Woodwork (42..45)
        // --------------------------------------------------------------------
        case PbrMaterialArchetype::WEATHERED_EXTERIOR_OAK: {
            return synthesizePbrSetParallel(width, height, [seed, desc](float u, float v, int, int) -> PixelSample {
                float grain = FastNoise3D::perlin(u * 256.0f, v * 16.0f, 0.0f, seed) * 0.12f;
                float fissure = (FastNoise3D::perlin(u * 32.0f, v * 4.0f, 0.0f, seed + 1) < -0.35f) ? -0.3f : 0.0f;
                float h = 0.6f + grain + fissure;
                Vec3 col = desc.baseAlbedo * (1.0f + grain * 0.5f + fissure * 0.6f);
                return { col, h, desc.baseMetallic, grain * 0.1f };
            }, desc.defaultNormalStrength, desc.baseRoughness);
        }

        case PbrMaterialArchetype::CONCENTRIC_ENDGRAIN_TIMBER: {
            return generateWoodEndgrain(width, height, 14.0f, seed);
        }

        case PbrMaterialArchetype::POLISHED_QUARTERSAWN_WALNUT: {
            return synthesizePbrSetParallel(width, height, [seed, desc](float u, float v, int, int) -> PixelSample {
                float ray = std::sin(v * 48.0f + FastNoise3D::perlin(u * 16.0f, v * 16.0f, 0.0f, seed) * 3.0f);
                float figure = std::abs(ray) * 0.15f;
                float h = 0.85f + figure * 0.5f;
                Vec3 darkGrain(0.24f, 0.14f, 0.08f);
                Vec3 col = desc.baseAlbedo * (1.0f - figure) + darkGrain * figure;
                return { col, h, desc.baseMetallic, figure * 0.05f };
            }, desc.defaultNormalStrength, desc.baseRoughness);
        }

        case PbrMaterialArchetype::MARINE_TEAK_DECKING: {
            return synthesizePbrSetParallel(width, height, [seed, desc](float u, float v, int, int) -> PixelSample {
                float plankPhase = std::fmod(u * 10.0f, 1.0f);
                bool isCaulk = (plankPhase < 0.06f);
                float teakGrain = FastNoise3D::perlin(u * 128.0f, v * 16.0f, 0.0f, seed) * 0.06f;
                float h = isCaulk ? 0.35f : (0.75f + teakGrain);
                Vec3 caulkCol(0.08f, 0.08f, 0.09f);
                Vec3 col = isCaulk ? caulkCol : (desc.baseAlbedo * (1.0f + teakGrain * 0.3f));
                return { col, h, desc.baseMetallic, isCaulk ? 0.2f : 0.0f };
            }, desc.defaultNormalStrength, desc.baseRoughness);
        }

        // --------------------------------------------------------------------
        // Category 7: Relief Ornaments & Weathering Finishes (46..49)
        // --------------------------------------------------------------------
        case PbrMaterialArchetype::ART_DECO_CHEVRON_SPANDREL: {
            return synthesizePbrSetParallel(width, height, [seed](float u, float v, int, int) -> PixelSample {
                // Symmetrical Art Deco chevron fluting (inverted-V)
                float uSym = std::abs(u - 0.5f) * 2.0f; // 0 at center, 1 at side borders

                // 3 tiered chevron ridges
                float chevronAngle = uSym * 0.65f;
                float chevronWave = (v * 3.6f - chevronAngle);
                float chevronFrac = chevronWave - std::floor(chevronWave);

                // Stepped relief profile (sharp crest sloping down to dark recessed trough)
                float ridge = (chevronFrac < 0.28f) ? (chevronFrac / 0.28f) : (1.0f - (chevronFrac - 0.28f) / 0.72f);
                float steppedProfile = std::clamp(ridge, 0.0f, 1.0f);
                steppedProfile = std::pow(steppedProfile, 0.65f);

                // Fluted vertical border ribs flanking the chevron
                bool isBorderRib = (u < 0.05f || u > 0.95f);
                if (isBorderRib) {
                    steppedProfile = 0.88f;
                }

                // Sand-cast pebble micro-texture and weathering
                float sandCast = FastNoise3D::perlin(u * 96.0f, v * 96.0f, 0.0f, seed) * 0.045f;
                float oxideWeathering = FastNoise3D::fbm(u * 14.0f, v * 14.0f, 0.0f, 3, 2.0f, 0.5f, seed + 3) * 0.06f;

                // Dark weathered oxidized gunmetal in troughs, silvery aluminum on ridge crests
                Vec3 oxideDark(0.20f, 0.21f, 0.23f);
                Vec3 aluBright(0.55f, 0.58f, 0.62f);
                Vec3 col = oxideDark * (1.0f - steppedProfile) + aluBright * steppedProfile;
                col = col * (0.96f + sandCast + oxideWeathering);

                float h = 0.22f + steppedProfile * 0.60f + sandCast;
                float metallic = 0.70f + steppedProfile * 0.22f;
                float roughMod = (1.0f - steppedProfile) * 0.18f - 0.04f;

                return { col, h, metallic, roughMod };
            }, 3.4f, 0.38f);
        }

        case PbrMaterialArchetype::CHIPPED_ENAMEL_ON_RUSTED_IRON: {
            return generateChippedPaintOnRust(width, height, Vec3(0.18f, 0.42f, 0.78f), 0.38f, seed);
        }

        case PbrMaterialArchetype::SALT_EFFLORESCENCE_MASONRY: {
            return synthesizePbrSetParallel(width, height, [seed, desc](float u, float v, int, int) -> PixelSample {
                float saltBlobs = FastNoise3D::fbm(u * 12.0f, v * 12.0f, 0.0f, 4, 2.0f, 0.5f, seed);
                float saltMask = math::smoothstep(0.45f, 0.75f, saltBlobs);
                float h = 0.55f + saltMask * 0.12f;
                Vec3 saltWhite(0.94f, 0.94f, 0.92f);
                Vec3 brickBase(0.65f, 0.30f, 0.20f);
                Vec3 col = brickBase * (1.0f - saltMask) + saltWhite * saltMask;
                return { col, h, desc.baseMetallic, saltMask * 0.15f };
            }, desc.defaultNormalStrength, desc.baseRoughness);
        }

        case PbrMaterialArchetype::MOSSY_ROCK_CREVICE_WEATHERING: {
            return synthesizePbrSetParallel(width, height, [seed, desc](float u, float v, int, int) -> PixelSample {
                WorleySample w = worley2D(u * 12.0f, v * 12.0f, 0.9f, seed);
                bool inCrevice = (w.f1 > 0.4f);
                float mossGrowth = FastNoise3D::fbm(u * 24.0f, v * 24.0f, 0.0f, 4, 2.0f, 0.5f, seed + 1);
                float mossMask = inCrevice ? math::smoothstep(0.3f, 0.7f, mossGrowth) : 0.0f;
                float h = inCrevice ? (0.35f + mossMask * 0.2f) : 0.75f;
                Vec3 mossGreen(0.24f, 0.45f, 0.18f);
                Vec3 col = desc.baseAlbedo * (1.0f - mossMask) + mossGreen * mossMask;
                return { col, h, desc.baseMetallic, mossMask * 0.18f };
            }, desc.defaultNormalStrength, desc.baseRoughness);
        }
    }

    return synthesizePbrSetParallel(width, height, [desc](float, float, int, int) -> PixelSample {
        return { desc.baseAlbedo, 0.5f, desc.baseMetallic, 0.0f };
    }, desc.defaultNormalStrength, desc.baseRoughness);
}

} // namespace pbr_texture
} // namespace scratchbox

#endif // SCRATCHBOX_PBR_50_LIBRARY_HPP
