/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { NativeCppCompilerService } from './native-compiler-service';
import { PhotorealismEvaluator, PhotorealismMetricReport } from './photorealism-evaluator';
import * as fs from 'fs';
import * as path from 'path';

export interface PhotorealismExerciseResult {
    id: string;
    title: string;
    category: 'hard-surface' | 'organic-mineral' | 'architectural' | 'mechatronic';
    cppSource: string;
    report: PhotorealismMetricReport;
    glbBase64: string;
    executionTimeMs: number;
}

export class PhotorealismExerciseRunner {
    private compiler: NativeCppCompilerService;
    private evaluator: PhotorealismEvaluator;

    constructor(compiler?: NativeCppCompilerService) {
        this.compiler = compiler || new NativeCppCompilerService();
        this.evaluator = new PhotorealismEvaluator();
    }

    // =========================================================================
    // Exercise 1: Aerospace Turbine Engine Assembly (Hard-Surface Precision)
    // =========================================================================
    public getAerospaceTurbineSource(): string {
        return `#include "scratchbox_engine.hpp"
#include <iostream>
#include <cmath>

int main() {
    using namespace scratchbox::geometry;
    using namespace scratchbox::math;

    ScratchboxMesh assembly("aerospace_turbine_assembly");
    assembly.material = PbrMaterial::titanium();

    // 1. Central Spinner Cone (Parabolic Nose Cone)
    const int radialSegs = 36;
    const int heightSegs = 24;
    float coneLength = 3.5f;
    float baseRadius = 1.2f;

    for (int y = 0; y < heightSegs; ++y) {
        float v0 = static_cast<float>(y) / heightSegs;
        float v1 = static_cast<float>(y + 1) / heightSegs;
        float r0 = baseRadius * (1.0f - std::pow(v0, 1.8f));
        float r1 = baseRadius * (1.0f - std::pow(v1, 1.8f));
        float z0 = (v0 - 0.5f) * coneLength;
        float z1 = (v1 - 0.5f) * coneLength;

        for (int x = 0; x < radialSegs; ++x) {
            float u0 = (static_cast<float>(x) / radialSegs) * TWO_PI;
            float u1 = (static_cast<float>(x + 1) / radialSegs) * TWO_PI;

            Vec3 p00(std::cos(u0) * r0, std::sin(u0) * r0, z0);
            Vec3 p10(std::cos(u1) * r0, std::sin(u1) * r0, z0);
            Vec3 p01(std::cos(u0) * r1, std::sin(u0) * r1, z1);
            Vec3 p11(std::cos(u1) * r1, std::sin(u1) * r1, z1);

            uint32_t idx = static_cast<uint32_t>(assembly.vertices.size());
            assembly.addVertex({p00, p00.normalized(), {static_cast<float>(x)/radialSegs, v0}, {0.92f, 0.94f, 0.98f, 1.0f}});
            assembly.addVertex({p10, p10.normalized(), {static_cast<float>(x+1)/radialSegs, v0}, {0.92f, 0.94f, 0.98f, 1.0f}});
            assembly.addVertex({p11, p11.normalized(), {static_cast<float>(x+1)/radialSegs, v1}, {0.92f, 0.94f, 0.98f, 1.0f}});
            assembly.addVertex({p01, p01.normalized(), {static_cast<float>(x)/radialSegs, v1}, {0.92f, 0.94f, 0.98f, 1.0f}});

            assembly.addTriangle(idx, idx + 1, idx + 2);
            assembly.addTriangle(idx, idx + 2, idx + 3);
        }
    }

    // 2. 26 Curved Titanium Rotor Blades with Aerodynamic Camber & Twist
    const int numBlades = 26;
    const int bladeSpanSegs = 16;
    const int bladeChordSegs = 8;
    float hubRadius = 1.15f;
    float tipRadius = 4.2f;

    for (int b = 0; b < numBlades; ++b) {
        float bladeAngle = (static_cast<float>(b) / numBlades) * TWO_PI;

        for (int s = 0; s < bladeSpanSegs; ++s) {
            float spanT0 = static_cast<float>(s) / bladeSpanSegs;
            float spanT1 = static_cast<float>(s + 1) / bladeSpanSegs;
            float r0 = hubRadius + spanT0 * (tipRadius - hubRadius);
            float r1 = hubRadius + spanT1 * (tipRadius - hubRadius);

            // Twist decreases from 35 degrees at root to 15 degrees at tip
            float twist0 = (35.0f - spanT0 * 20.0f) * (PI / 180.0f);
            float twist1 = (35.0f - spanT1 * 20.0f) * (PI / 180.0f);
            float chord = 0.8f * (1.0f - spanT0 * 0.35f);

            for (int c = 0; c < bladeChordSegs; ++c) {
                float chordT0 = (static_cast<float>(c) / bladeChordSegs) - 0.5f;
                float chordT1 = (static_cast<float>(c + 1) / bladeChordSegs) - 0.5f;

                // Airfoil camber curve
                float camber0 = 0.08f * std::sin((chordT0 + 0.5f) * PI);
                float camber1 = 0.08f * std::sin((chordT1 + 0.5f) * PI);

                auto makeBladePt = [&](float r, float twist, float cT, float camb) {
                    float localX = cT * chord;
                    float localY = camb;
                    // Rotate by twist around radial vector
                    float twistedX = localX * std::cos(twist) - localY * std::sin(twist);
                    float twistedZ = localX * std::sin(twist) + localY * std::cos(twist);
                    // Rotate by bladeAngle around turbine axis
                    float wx = std::cos(bladeAngle) * r - std::sin(bladeAngle) * twistedX;
                    float wy = std::sin(bladeAngle) * r + std::cos(bladeAngle) * twistedX;
                    float wz = twistedZ - 0.3f;
                    return Vec3(wx, wy, wz);
                };

                Vec3 pt00 = makeBladePt(r0, twist0, chordT0, camber0);
                Vec3 pt10 = makeBladePt(r0, twist0, chordT1, camber1);
                Vec3 pt11 = makeBladePt(r1, twist1, chordT1, camber1);
                Vec3 pt01 = makeBladePt(r1, twist1, chordT0, camber0);

                uint32_t idx = static_cast<uint32_t>(assembly.vertices.size());
                // Titanium with subtle gold heat tint at roots
                Vec4 col0 = (spanT0 < 0.2f) ? Vec4(0.85f, 0.78f, 0.65f, 1.0f) : Vec4(0.78f, 0.80f, 0.84f, 1.0f);
                Vec4 col1 = (spanT1 < 0.2f) ? Vec4(0.85f, 0.78f, 0.65f, 1.0f) : Vec4(0.78f, 0.80f, 0.84f, 1.0f);

                assembly.addVertex({pt00, {0, 0, 1}, {spanT0, chordT0 + 0.5f}, col0});
                assembly.addVertex({pt10, {0, 0, 1}, {spanT0, chordT1 + 0.5f}, col0});
                assembly.addVertex({pt11, {0, 0, 1}, {spanT1, chordT1 + 0.5f}, col1});
                assembly.addVertex({pt01, {0, 0, 1}, {spanT1, chordT0 + 0.5f}, col1});

                assembly.addTriangle(idx, idx + 1, idx + 2);
                assembly.addTriangle(idx, idx + 2, idx + 3);
            }
        }
    }

    // 3. Containment Cowling Ring
    float cowlInner = 4.25f;
    float cowlOuter = 4.65f;
    float cowlDepth = 2.4f;
    const int cowlRadSegs = 48;

    for (int i = 0; i < cowlRadSegs; ++i) {
        float a0 = (static_cast<float>(i) / cowlRadSegs) * TWO_PI;
        float a1 = (static_cast<float>(i + 1) / cowlRadSegs) * TWO_PI;

        Vec3 in0(std::cos(a0) * cowlInner, std::sin(a0) * cowlInner, -cowlDepth * 0.5f);
        Vec3 in1(std::cos(a1) * cowlInner, std::sin(a1) * cowlInner, -cowlDepth * 0.5f);
        Vec3 out0(std::cos(a0) * cowlOuter, std::sin(a0) * cowlOuter, -cowlDepth * 0.5f);
        Vec3 out1(std::cos(a1) * cowlOuter, std::sin(a1) * cowlOuter, -cowlDepth * 0.5f);

        Vec3 in0F(std::cos(a0) * cowlInner, std::sin(a0) * cowlInner, cowlDepth * 0.5f);
        Vec3 in1F(std::cos(a1) * cowlInner, std::sin(a1) * cowlInner, cowlDepth * 0.5f);
        Vec3 out0F(std::cos(a0) * cowlOuter, std::sin(a0) * cowlOuter, cowlDepth * 0.5f);
        Vec3 out1F(std::cos(a1) * cowlOuter, std::sin(a1) * cowlOuter, cowlDepth * 0.5f);

        uint32_t idx = static_cast<uint32_t>(assembly.vertices.size());
        Vec4 cowlCol(0.68f, 0.70f, 0.74f, 1.0f);
        assembly.addVertex({in0, in0.normalized() * -1.0f, {0, 0}, cowlCol});
        assembly.addVertex({in1, in1.normalized() * -1.0f, {1, 0}, cowlCol});
        assembly.addVertex({in1F, in1F.normalized() * -1.0f, {1, 1}, cowlCol});
        assembly.addVertex({in0F, in0F.normalized() * -1.0f, {0, 1}, cowlCol});
        assembly.addTriangle(idx, idx + 1, idx + 2);
        assembly.addTriangle(idx, idx + 2, idx + 3);

        uint32_t idx2 = static_cast<uint32_t>(assembly.vertices.size());
        assembly.addVertex({out0, out0.normalized(), {0, 0}, cowlCol});
        assembly.addVertex({out1, out1.normalized(), {1, 0}, cowlCol});
        assembly.addVertex({out1F, out1F.normalized(), {1, 1}, cowlCol});
        assembly.addVertex({out0F, out0F.normalized(), {0, 1}, cowlCol});
        assembly.addTriangle(idx2, idx2 + 2, idx2 + 1);
        assembly.addTriangle(idx2, idx2 + 3, idx2 + 2);
    }

    // Photorealistic normals & crevice AO baking
    assembly.recomputeSmoothNormals();
    assembly.computeCurvatureAO(0.75f);
    assembly.applyProceduralWeathering(4.0f, 0.08f);

    std::vector<uint8_t> glb = scratchbox::io::GlbWriter::serializeToGlb(assembly);
    scratchbox::io::GlbWriter::streamChunk("aerospace_turbine_assembly", glb);
    return 0;
}`;
    }

    // =========================================================================
    // Exercise 2: Volcanic Basalt Rock & Quartz Crystal Geode (Organic & Mineral)
    // =========================================================================
    public getVolcanicGeodeSource(): string {
        return `#include "scratchbox_engine.hpp"
#include <iostream>
#include <cmath>

int main() {
    using namespace scratchbox::geometry;
    using namespace scratchbox::math;
    using namespace scratchbox::sdf;

    // 1. Carved Basalt Rock Exterior with Hollow Chamber
    FastNoise3D noise(42);
    float isoLevel = 0.0f;
    AABB bounds(Vec3(-4.0f, -4.0f, -4.0f), Vec3(4.0f, 4.0f, 4.0f));

    auto geodeSDF = [&](const Vec3& p) -> float {
        // Outer eroded rock sphere
        float rock = sdSphere(p, 3.2f);
        // Multi-frequency noise displacement for geological basalt roughness
        float displacement = noise.fBm(p.x * 0.9f, p.y * 0.9f, p.z * 0.9f, 4, 0.5f, 2.1f) * 0.75f;
        rock += displacement;

        // Inner hollow geode chamber (carved out smoothly)
        float hollow = sdSphere(p - Vec3(0.3f, 0.2f, 0.4f), 2.1f);
        return opSmoothSubtraction(hollow, rock, 0.4f);
    };

    MarchingCubes mc;
    ScratchboxMesh rockMesh = mc.polygonize(geodeSDF, bounds, 36, isoLevel);
    rockMesh.name = "volcanic_basalt_shell";
    rockMesh.material = PbrMaterial::basaltRock();

    // Dark volcanic basalt with mineral oxidation streaks
    for (auto& v : rockMesh.vertices) {
        float n = noise.perlin(v.position.x * 2.5f, v.position.y * 2.5f, v.position.z * 2.5f);
        float oxidation = std::max(0.0f, std::min(1.0f, (n + 1.0f) * 0.5f));
        v.color = Vec4(0.18f + oxidation * 0.08f, 0.16f + oxidation * 0.04f, 0.17f, 1.0f);
    }

    // 2. Faceted Amethyst Quartz Crystals Growing Inside the Hollow
    const int crystalCount = 18;
    for (int i = 0; i < crystalCount; ++i) {
        float phi = std::acos(1.0f - 2.0f * (static_cast<float>(i) + 0.5f) / crystalCount);
        float theta = PI * (1.0f + std::sqrt(5.0f)) * static_cast<float>(i);

        Vec3 inwardDir(std::sin(phi) * std::cos(theta), std::sin(phi) * std::sin(theta), std::cos(phi));
        Vec3 basePos = inwardDir * 1.8f;
        Vec3 tipPos = basePos - inwardDir * 1.1f; // Points toward center of hollow

        // Hexagonal crystal prism
        const int sides = 6;
        float crystalRadius = 0.22f + (static_cast<float>(i % 4) * 0.04f);

        Vec3 up = (std::abs(inwardDir.y) < 0.9f) ? Vec3(0, 1, 0) : Vec3(1, 0, 0);
        Vec3 side1 = inwardDir.cross(up).normalized();
        Vec3 side2 = inwardDir.cross(side1).normalized();

        for (int s = 0; s < sides; ++s) {
            float a0 = (static_cast<float>(s) / sides) * TWO_PI;
            float a1 = (static_cast<float>(s + 1) / sides) * TWO_PI;

            Vec3 r0 = side1 * (std::cos(a0) * crystalRadius) + side2 * (std::sin(a0) * crystalRadius);
            Vec3 r1 = side1 * (std::cos(a1) * crystalRadius) + side2 * (std::sin(a1) * crystalRadius);

            Vec3 p0 = basePos + r0;
            Vec3 p1 = basePos + r1;
            Vec3 p0Tip = tipPos + r0 * 0.3f;
            Vec3 p1Tip = tipPos + r1 * 0.3f;

            uint32_t idx = static_cast<uint32_t>(rockMesh.vertices.size());
            // Vivid amethyst purple with crystalline gradient
            Vec4 deepPurple(0.45f, 0.18f, 0.72f, 0.95f);
            Vec4 brightViolet(0.82f, 0.55f, 0.98f, 0.9f);

            rockMesh.addVertex({p0, r0.normalized(), {0, 0}, deepPurple});
            rockMesh.addVertex({p1, r1.normalized(), {1, 0}, deepPurple});
            rockMesh.addVertex({p1Tip, (p1Tip - tipPos).normalized(), {1, 1}, brightViolet});
            rockMesh.addVertex({p0Tip, (p0Tip - tipPos).normalized(), {0, 1}, brightViolet});

            rockMesh.addTriangle(idx, idx + 1, idx + 2);
            rockMesh.addTriangle(idx, idx + 2, idx + 3);

            // Crystal Point Tip Facet
            uint32_t tipIdx = static_cast<uint32_t>(rockMesh.vertices.size());
            rockMesh.addVertex({p0Tip, (p0Tip - tipPos).normalized(), {0, 0}, brightViolet});
            rockMesh.addVertex({p1Tip, (p1Tip - tipPos).normalized(), {1, 0}, brightViolet});
            rockMesh.addVertex({tipPos, (-inwardDir).normalized(), {0.5f, 1.0f}, Vec4(0.95f, 0.85f, 1.0f, 1.0f)});
            rockMesh.addTriangle(tipIdx, tipIdx + 1, tipIdx + 2);
        }
    }

    // Smooth normals & deep cavity ambient occlusion
    rockMesh.recomputeSmoothNormals();
    rockMesh.computeCurvatureAO(0.9f);

    std::vector<uint8_t> glb = scratchbox::io::GlbWriter::serializeToGlb(rockMesh);
    scratchbox::io::GlbWriter::streamChunk("volcanic_geode", glb);
    return 0;
}`;
    }

    // =========================================================================
    // Exercise 3: Parametric Sky-Citadel Neo-Spire (Architectural Megastructure)
    // =========================================================================
    public getSkyCitadelSpireSource(): string {
        return `#include "scratchbox_engine.hpp"
#include <iostream>
#include <cmath>

int main() {
    using namespace scratchbox::geometry;
    using namespace scratchbox::math;

    ScratchboxMesh citadel("sky_citadel_neo_spire");
    citadel.material = PbrMaterial::carbonComposite();

    // 1. Interlaced Helical Pylons using 3D Bezier Spline Tube Extrusions
    const int numPylons = 4;
    const float towerHeight = 16.0f;
    const float baseRadius = 3.6f;
    const float waistRadius = 1.4f;
    const float crownRadius = 2.8f;

    for (int p = 0; p < numPylons; ++p) {
        float baseAngle = (static_cast<float>(p) / numPylons) * TWO_PI;

        Vec3 p0(std::cos(baseAngle) * baseRadius, -towerHeight * 0.5f, std::sin(baseAngle) * baseRadius);
        Vec3 p1(std::cos(baseAngle + 0.8f) * waistRadius, -towerHeight * 0.15f, std::sin(baseAngle + 0.8f) * waistRadius);
        Vec3 p2(std::cos(baseAngle + 1.6f) * waistRadius, towerHeight * 0.2f, std::sin(baseAngle + 1.6f) * waistRadius);
        Vec3 p3(std::cos(baseAngle + 2.2f) * crownRadius, towerHeight * 0.5f, std::sin(baseAngle + 2.2f) * crownRadius);

        Spline3D spline(p0, p1, p2, p3);
        ScratchboxMesh pylonTube = spline.extrudeTube(0.32f, 36, 12);

        // Apply dark metallic carbon tint
        for (auto& v : pylonTube.vertices) {
            v.color = Vec4(0.16f, 0.17f, 0.20f, 1.0f);
        }
        citadel.merge(pylonTube);
    }

    // 2. Tiered Observation Skydecks (Cantilevered Rings)
    const int deckCount = 3;
    float deckHeights[deckCount] = {-towerHeight * 0.25f, 0.0f, towerHeight * 0.35f};
    float deckRadii[deckCount] = {4.2f, 3.2f, 3.8f};

    for (int d = 0; d < deckCount; ++d) {
        float y = deckHeights[d];
        float r = deckRadii[d];
        const int ringSegs = 48;

        for (int i = 0; i < ringSegs; ++i) {
            float a0 = (static_cast<float>(i) / ringSegs) * TWO_PI;
            float a1 = (static_cast<float>(i + 1) / ringSegs) * TWO_PI;

            Vec3 in0(std::cos(a0) * (r - 0.9f), y, std::sin(a0) * (r - 0.9f));
            Vec3 in1(std::cos(a1) * (r - 0.9f), y, std::sin(a1) * (r - 0.9f));
            Vec3 out0(std::cos(a0) * r, y, std::sin(a0) * r);
            Vec3 out1(std::cos(a1) * r, y, std::sin(a1) * r);

            uint32_t idx = static_cast<uint32_t>(citadel.vertices.size());
            Vec4 deckCol(0.24f, 0.26f, 0.32f, 1.0f);
            citadel.addVertex({in0, {0, 1, 0}, {0, 0}, deckCol});
            citadel.addVertex({in1, {0, 1, 0}, {1, 0}, deckCol});
            citadel.addVertex({out1, {0, 1, 0}, {1, 1}, deckCol});
            citadel.addVertex({out0, {0, 1, 0}, {0, 1}, deckCol});

            citadel.addTriangle(idx, idx + 1, idx + 2);
            citadel.addTriangle(idx, idx + 2, idx + 3);

            // Ring edge bevel (brushed chrome trim)
            uint32_t edgeIdx = static_cast<uint32_t>(citadel.vertices.size());
            Vec3 bOut0(std::cos(a0) * r, y - 0.25f, std::sin(a0) * r);
            Vec3 bOut1(std::cos(a1) * r, y - 0.25f, std::sin(a1) * r);
            Vec4 chromeCol(0.85f, 0.88f, 0.94f, 1.0f);

            citadel.addVertex({out0, out0.normalized(), {0, 0}, chromeCol});
            citadel.addVertex({out1, out1.normalized(), {1, 0}, chromeCol});
            citadel.addVertex({bOut1, bOut1.normalized(), {1, 1}, chromeCol});
            citadel.addVertex({bOut0, bOut0.normalized(), {0, 1}, chromeCol});

            citadel.addTriangle(edgeIdx, edgeIdx + 1, edgeIdx + 2);
            citadel.addTriangle(edgeIdx, edgeIdx + 2, edgeIdx + 3);
        }
    }

    // 3. Central Photonic Luminescence Reactor Core
    const int coreSegs = 28;
    float coreRadius = 0.55f;
    float coreHeight = 7.0f;
    for (int y = 0; y < 16; ++y) {
        float t0 = (static_cast<float>(y) / 16) - 0.5f;
        float t1 = (static_cast<float>(y + 1) / 16) - 0.5f;
        float cy0 = t0 * coreHeight;
        float cy1 = t1 * coreHeight;
        float r0 = coreRadius * (1.0f - std::abs(t0) * 0.4f);
        float r1 = coreRadius * (1.0f - std::abs(t1) * 0.4f);

        for (int x = 0; x < coreSegs; ++x) {
            float a0 = (static_cast<float>(x) / coreSegs) * TWO_PI;
            float a1 = (static_cast<float>(x + 1) / coreSegs) * TWO_PI;

            Vec3 p00(std::cos(a0) * r0, cy0, std::sin(a0) * r0);
            Vec3 p10(std::cos(a1) * r0, cy0, std::sin(a1) * r0);
            Vec3 p11(std::cos(a1) * r1, cy1, std::sin(a1) * r1);
            Vec3 p01(std::cos(a0) * r1, cy1, std::sin(a0) * r1);

            uint32_t idx = static_cast<uint32_t>(citadel.vertices.size());
            // Radiant Cyan Emissive Core
            Vec4 cyanGlow(0.2f, 0.95f, 1.0f, 1.0f);
            citadel.addVertex({p00, p00.normalized(), {0, 0}, cyanGlow});
            citadel.addVertex({p10, p10.normalized(), {1, 0}, cyanGlow});
            citadel.addVertex({p11, p11.normalized(), {1, 1}, cyanGlow});
            citadel.addVertex({p01, p01.normalized(), {0, 1}, cyanGlow});

            citadel.addTriangle(idx, idx + 1, idx + 2);
            citadel.addTriangle(idx, idx + 2, idx + 3);
        }
    }

    // Architectural normal smoothing & crevice occlusion
    citadel.recomputeSmoothNormals();
    citadel.computeCurvatureAO(0.8f);
    citadel.applyProceduralWeathering(3.0f, 0.05f);

    std::vector<uint8_t> glb = scratchbox::io::GlbWriter::serializeToGlb(citadel);
    scratchbox::io::GlbWriter::streamChunk("sky_citadel_spire", glb);
    return 0;
}`;
    }

    // =========================================================================
    // Exercise 4: Autonomous Biomechanical Rover (Complex Mechatronic Assembly)
    // =========================================================================
    public getBiomechanicalRoverSource(): string {
        return `#include "scratchbox_engine.hpp"
#include <iostream>
#include <cmath>

int main() {
    using namespace scratchbox::geometry;
    using namespace scratchbox::math;

    ScratchboxMesh rover("biomechanical_exploration_rover");
    rover.material = PbrMaterial::titanium();

    // 1. Central Aerodynamic Equipment Chassis
    ScratchboxMesh mainBody = ScratchboxMesh::createBox(Vec3(3.6f, 1.2f, 2.2f), Vec4(0.76f, 0.78f, 0.82f, 1.0f));
    rover.merge(mainBody);

    // 2. Solar Panel Array on Top Deck
    ScratchboxMesh solarDeck = ScratchboxMesh::createBox(Vec3(3.0f, 0.08f, 1.8f), Vec4(0.08f, 0.12f, 0.28f, 1.0f));
    for (auto& v : solarDeck.vertices) {
        v.position.y += 0.65f;
    }
    rover.merge(solarDeck);

    // 3. Articulated Sensor Mast & Optics Turret
    ScratchboxMesh mast = ScratchboxMesh::createCylinder(0.12f, 1.8f, 24, Vec4(0.65f, 0.68f, 0.72f, 1.0f));
    for (auto& v : mast.vertices) {
        v.position.x += 1.4f;
        v.position.y += 1.5f;
    }
    rover.merge(mast);

    ScratchboxMesh turret = ScratchboxMesh::createSphere(0.42f, 24, 24, Vec4(0.92f, 0.94f, 0.98f, 1.0f));
    for (auto& v : turret.vertices) {
        v.position.x += 1.4f;
        v.position.y += 2.45f;
    }
    rover.merge(turret);

    // 4. Six Heavy-Duty Wheels with Deep Radial Tread Grooves
    const int wheelCount = 6;
    float wheelPositionsX[wheelCount] = {-1.5f, 0.0f, 1.5f, -1.5f, 0.0f, 1.5f};
    float wheelPositionsZ[wheelCount] = {-1.65f, -1.65f, -1.65f, 1.65f, 1.65f, 1.65f};
    float wheelRadius = 0.65f;
    float wheelWidth = 0.55f;
    const int wheelRadialSegs = 48;

    for (int w = 0; w < wheelCount; ++w) {
        float wx = wheelPositionsX[w];
        float wz = wheelPositionsZ[w];
        float wy = -0.75f;

        for (int i = 0; i < wheelRadialSegs; ++i) {
            float a0 = (static_cast<float>(i) / wheelRadialSegs) * TWO_PI;
            float a1 = (static_cast<float>(i + 1) / wheelRadialSegs) * TWO_PI;

            // Deep tread pattern (lug teeth)
            float tread0 = (i % 2 == 0) ? 0.06f : 0.0f;
            float tread1 = ((i + 1) % 2 == 0) ? 0.06f : 0.0f;
            float r0 = wheelRadius + tread0;
            float r1 = wheelRadius + tread1;

            Vec3 p00(wx + std::cos(a0) * r0, wy + std::sin(a0) * r0, wz - wheelWidth * 0.5f);
            Vec3 p10(wx + std::cos(a1) * r1, wy + std::sin(a1) * r1, wz - wheelWidth * 0.5f);
            Vec3 p11(wx + std::cos(a1) * r1, wy + std::sin(a1) * r1, wz + wheelWidth * 0.5f);
            Vec3 p01(wx + std::cos(a0) * r0, wy + std::sin(a0) * r0, wz + wheelWidth * 0.5f);

            uint32_t idx = static_cast<uint32_t>(rover.vertices.size());
            // Dark vulcanized rubber wheel tread
            Vec4 treadCol(0.12f, 0.12f, 0.14f, 1.0f);
            rover.addVertex({p00, {std::cos(a0), std::sin(a0), 0}, {0, 0}, treadCol});
            rover.addVertex({p10, {std::cos(a1), std::sin(a1), 0}, {1, 0}, treadCol});
            rover.addVertex({p11, {std::cos(a1), std::sin(a1), 0}, {1, 1}, treadCol});
            rover.addVertex({p01, {std::cos(a0), std::sin(a0), 0}, {0, 1}, treadCol});

            rover.addTriangle(idx, idx + 1, idx + 2);
            rover.addTriangle(idx, idx + 2, idx + 3);

            // Wheel Rim Hub (Machined Gold/Titanium)
            uint32_t hubIdx = static_cast<uint32_t>(rover.vertices.size());
            float hubR = wheelRadius * 0.55f;
            Vec3 h00(wx + std::cos(a0) * hubR, wy + std::sin(a0) * hubR, wz + wheelWidth * 0.52f);
            Vec3 h10(wx + std::cos(a1) * hubR, wy + std::sin(a1) * hubR, wz + wheelWidth * 0.52f);
            Vec3 hCenter(wx, wy, wz + wheelWidth * 0.52f);
            Vec4 rimCol(0.85f, 0.82f, 0.70f, 1.0f);

            rover.addVertex({h00, {0, 0, 1}, {0, 0}, rimCol});
            rover.addVertex({h10, {0, 0, 1}, {1, 0}, rimCol});
            rover.addVertex({hCenter, {0, 0, 1}, {0.5f, 0.5f}, rimCol});
            rover.addTriangle(hubIdx, hubIdx + 1, hubIdx + 2);

            // Inner Wheel Rim Hub
            uint32_t inHubIdx = static_cast<uint32_t>(rover.vertices.size());
            Vec3 ih00(wx + std::cos(a0) * hubR, wy + std::sin(a0) * hubR, wz - wheelWidth * 0.52f);
            Vec3 ih10(wx + std::cos(a1) * hubR, wy + std::sin(a1) * hubR, wz - wheelWidth * 0.52f);
            Vec3 ihCenter(wx, wy, wz - wheelWidth * 0.52f);

            rover.addVertex({ih00, {0, 0, -1}, {0, 0}, rimCol});
            rover.addVertex({ih10, {0, 0, -1}, {1, 0}, rimCol});
            rover.addVertex({ihCenter, {0, 0, -1}, {0.5f, 0.5f}, rimCol});
            rover.addTriangle(inHubIdx, inHubIdx + 2, inHubIdx + 1);
        }

        // Suspension linkage rocker arms
        ScratchboxMesh strut = ScratchboxMesh::createCylinder(0.06f, 1.2f, 16, Vec4(0.45f, 0.48f, 0.52f, 1.0f));
        for (auto& v : strut.vertices) {
            v.position.x += wx;
            v.position.y += wy + 0.5f;
            v.position.z += wz * 0.6f;
        }
        rover.merge(strut);
    }

    // Smooth normals & edge wear / crevice occlusion
    rover.recomputeSmoothNormals();
    rover.computeCurvatureAO(0.85f);
    rover.applyProceduralWeathering(5.0f, 0.12f);

    std::vector<uint8_t> glb = scratchbox::io::GlbWriter::serializeToGlb(rover);
    scratchbox::io::GlbWriter::streamChunk("biomechanical_rover", glb);
    return 0;
}`;
    }

    // =========================================================================
    // Pipeline Execution Engine
    // =========================================================================
    public async runExercise(
        id: string,
        title: string,
        category: 'hard-surface' | 'organic-mineral' | 'architectural' | 'mechatronic',
        cppSource: string
    ): Promise<PhotorealismExerciseResult> {
        const startTime = Date.now();

        // 1. Compile C++20 source code via Clang
        const compileRes = await this.compiler.compileSource(cppSource);
        if (!compileRes.success) {
            const diags = compileRes.diagnostics.map(d => `${d.severity}: ${d.message} (L${d.line})`).join('\n');
            throw new Error(`C++20 compilation failed for exercise '${id}':\n${diags}`);
        }

        // 2. Execute compiled binary in sandbox and extract GLB stream
        const execRes = await this.compiler.executeBinary(compileRes.binaryPath!);
        if (!execRes.success || execRes.exitCode !== 0) {
            throw new Error(`Binary execution failed for exercise '${id}' with code ${execRes.exitCode}:\n${execRes.stderr}`);
        }

        const b64 = execRes.glbBase64 || (execRes.chunks.length > 0 ? execRes.chunks[0].glbBase64 : '');
        if (!b64) {
            throw new Error(`Exercise '${id}' produced no streamed 3D chunks or GLB data.`);
        }

        const binaryStr = Buffer.from(b64, 'base64');
        const glbBytes = new Uint8Array(binaryStr);

        // 3. Evaluate photorealism against physical and geometric criteria
        const report = this.evaluator.evaluateGlb(id, glbBytes);
        const executionTimeMs = Date.now() - startTime;

        return {
            id,
            title,
            category,
            cppSource,
            report,
            glbBase64: b64,
            executionTimeMs
        };
    }

    /**
     * Executes the complete suite of 4 distinct 3D exercises.
     */
    public async runAllExercises(): Promise<PhotorealismExerciseResult[]> {
        const exercises = [
            {
                id: 'exercise-1-aerospace-turbine',
                title: 'Aerospace Turbine Engine Assembly',
                category: 'hard-surface' as const,
                source: this.getAerospaceTurbineSource()
            },
            {
                id: 'exercise-2-volcanic-geode',
                title: 'Volcanic Basalt Rock & Quartz Geode',
                category: 'organic-mineral' as const,
                source: this.getVolcanicGeodeSource()
            },
            {
                id: 'exercise-3-sky-citadel-spire',
                title: 'Parametric Sky-Citadel Neo-Spire',
                category: 'architectural' as const,
                source: this.getSkyCitadelSpireSource()
            },
            {
                id: 'exercise-4-biomechanical-rover',
                title: 'Autonomous Biomechanical Rover',
                category: 'mechatronic' as const,
                source: this.getBiomechanicalRoverSource()
            }
        ];

        const results: PhotorealismExerciseResult[] = [];
        for (const ex of exercises) {
            const res = await this.runExercise(ex.id, ex.title, ex.category, ex.source);
            results.push(res);
        }
        return results;
    }
}
