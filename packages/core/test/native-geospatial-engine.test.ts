/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { NativeCppCompilerService } from '../src/node/3d-engine/native-compiler-service';

describe('Native C++20 Geospatial, Ephemeris & Photoreal Engine Modules', () => {
    const compiler = new NativeCppCompilerService();

    it('should verify all new native headers exist in SDK include directory', () => {
        const includePath = compiler.getSdkIncludePath();
        expect(fs.existsSync(path.join(includePath, 'scratchbox_ephemeris.hpp'))).toBe(true);
        expect(fs.existsSync(path.join(includePath, 'scratchbox_geospatial.hpp'))).toBe(true);
        expect(fs.existsSync(path.join(includePath, 'scratchbox_footprints.hpp'))).toBe(true);
        expect(fs.existsSync(path.join(includePath, 'scratchbox_physics.hpp'))).toBe(true);
    });

    it('should compile and verify NOAA Ephemeris, solar angles, and Planckian blackbody temperatures', async () => {
        const source = `#include "scratchbox_engine.hpp"
#include <iostream>
#include <cassert>

int main() {
    using namespace scratchbox::ephemeris;

    // San Francisco (37.7749° N, 122.4194° W) on Summer Solstice 2024 at ~noon UTC
    int64_t timestamp = 1718971200; // June 21, 2024
    auto ephem = EphemerisService::calculate(37.7749f, -122.4194f, timestamp);

    // Verify solar angles are within valid astronomical boundaries
    assert(ephem.angles.elevationDeg >= -90.0f && ephem.angles.elevationDeg <= 90.0f);
    assert(ephem.angles.azimuthDeg >= 0.0f && ephem.angles.azimuthDeg <= 360.0f);
    assert(ephem.angles.zenithDeg >= 0.0f && ephem.angles.zenithDeg <= 180.0f);

    // Verify Three.js coordinate mapping: X=East, Y=Up, Z=-North (normalized length = 1.0)
    float len = ephem.sunDirectionThreeJS.length();
    assert(std::abs(len - 1.0f) < 1e-4f);

    // Verify Kelvin to RGB blackbody spectrum
    auto noonColor = EphemerisService::kelvinToRgb(5800.0f);
    assert(noonColor.x > 0.9f && noonColor.y > 0.85f); // Bright daylight white/warm

    auto sunsetColor = EphemerisService::kelvinToRgb(2200.0f);
    assert(sunsetColor.x > sunsetColor.z * 2.0f); // Sunset red dominance over blue

    std::cout << "EPHEMERIS_OK: Elev=" << ephem.angles.elevationDeg
              << " Az=" << ephem.angles.azimuthDeg
              << " TempK=" << ephem.colorTemperatureK << std::endl;
    return 0;
}
`;
        const res = await compiler.compileSource(source, {
            outputBinaryName: `test_ephemeris_${Date.now()}`
        });

        expect(res.success).toBe(true);
        expect(res.binaryPath).toBeDefined();

        const execRes = await compiler.executeBinary(res.binaryPath!);
        expect(execRes.exitCode).toBe(0);
        expect(execRes.stdout).toContain('EPHEMERIS_OK');
    });

    it('should compile and verify WGS-84 geodetic transformations and Street View depth unprojection', async () => {
        const source = `#include "scratchbox_engine.hpp"
#include <iostream>
#include <cassert>

int main() {
    using namespace scratchbox::geospatial;
    using namespace scratchbox::geospatial::wgs84;

    // 1. Verify WGS-84 coordinate transformation
    // Equator / Prime Meridian (0°, 0°, 0m)
    Vec3 ecef = geodeticToECEF(0.0, 0.0, 0.0);
    assert(std::abs(ecef.x - 6378137.0f) < 5.0f);
    assert(std::abs(ecef.y) < 1.0f);
    assert(std::abs(ecef.z) < 1.0f);

    GeodeticCoord backGeo = ecefToGeodetic(ecef);
    assert(std::abs(backGeo.latDeg) < 1e-4);
    assert(std::abs(backGeo.lngDeg) < 1e-4);
    assert(std::abs(backGeo.altitudeMeters) < 1.0);

    // 2. Verify Street View Depth Unprojection
    std::vector<DepthPlane> planes = {
        { Vec3(0, 1, 0), 0.0f },      // Plane 0: Sky/invalid
        { Vec3(0, 0, 1), 10.0f },     // Plane 1: Wall facing camera at 10m
        { Vec3(0, 1, 0), 2.0f }       // Plane 2: Ground plane
    };

    uint8_t planeIndices[16] = {
        0, 0, 0, 0,
        1, 1, 1, 1,
        1, 1, 1, 1,
        2, 2, 2, 2
    };

    auto points = StreetViewDepthUnprojector::unprojectEquirectangular(
        planes,
        planeIndices,
        nullptr,
        4,
        4,
        50.0f
    );

    assert(!points.empty());

    // 3. Verify Voxel Grid Spatial Decimation
    auto downsampled = PointCloudFilter::voxelGridDownsample(points, 0.5f);
    assert(downsampled.size() <= points.size());

    std::cout << "GEOSPATIAL_OK: Points=" << points.size()
              << " Downsampled=" << downsampled.size() << std::endl;
    return 0;
}
`;
        const res = await compiler.compileSource(source, {
            outputBinaryName: `test_geospatial_${Date.now()}`
        });

        expect(res.success).toBe(true);
        expect(res.binaryPath).toBeDefined();

        const execRes = await compiler.executeBinary(res.binaryPath!);
        expect(execRes.exitCode).toBe(0);
        expect(execRes.stdout).toContain('GEOSPATIAL_OK');
    });

    it('should compile and verify building footprint extrusion with binary glTF 2.0 serialization', async () => {
        const source = `#include "scratchbox_engine.hpp"
#include <iostream>
#include <cassert>

int main() {
    using namespace scratchbox;
    using namespace scratchbox::footprints;

    // 1. Define rectangular building footprint (20m x 30m)
    std::vector<math::Vec2> footprint = {
        {0.0f, 0.0f},
        {20.0f, 0.0f},
        {20.0f, 30.0f},
        {0.0f, 30.0f}
    };

    // 2. Extrude Stepped Massing (Podium at 12m, Tower at 45m with 0.70 inset)
    auto mesh = BuildingMassingGenerator::extrudeSteppedMassing(
        footprint,
        0.0f,
        12.0f,
        45.0f,
        0.70f
    );

    assert(mesh.vertices.size() > 0);
    assert(mesh.indices.size() > 0);
    assert(mesh.indices.size() % 3 == 0); // Valid triangle count

    // 3. Serialize to binary glTF 2.0 (.glb)
    auto glbBytes = BuildingMassingGenerator::serializeToGlb(mesh);
    assert(glbBytes.size() > 20);

    // Verify glTF 2.0 Magic Header ("glTF" = 0x46546C67)
    uint32_t magic = *reinterpret_cast<const uint32_t*>(glbBytes.data());
    assert(magic == 0x46546C67);

    // Verify glTF version 2
    uint32_t version = *reinterpret_cast<const uint32_t*>(glbBytes.data() + 4);
    assert(version == 2);

    std::cout << "FOOTPRINTS_OK: Vertices=" << mesh.vertices.size()
              << " Indices=" << mesh.indices.size()
              << " GlbBytes=" << glbBytes.size() << std::endl;
    return 0;
}
`;
        const res = await compiler.compileSource(source, {
            outputBinaryName: `test_footprints_${Date.now()}`
        });

        expect(res.success).toBe(true);
        expect(res.binaryPath).toBeDefined();

        const execRes = await compiler.executeBinary(res.binaryPath!);
        expect(execRes.exitCode).toBe(0);
        expect(execRes.stdout).toContain('FOOTPRINTS_OK');
    });

    it('should compile and verify tile collision sliding vectors and water buoyancy forces', async () => {
        const source = `#include "scratchbox_engine.hpp"
#include <iostream>
#include <cassert>

int main() {
    using namespace scratchbox::physics;
    using namespace scratchbox::math;

    // 1. Sliding Plane Collision Resolution
    // Moving directly into a vertical building wall facing -Z
    Vec3 velocity(2.0f, 0.0f, -5.0f);
    Vec3 wallNormal(0.0f, 0.0f, 1.0f);

    Vec3 slideVel = TileCollisionSolver::resolveSlideVelocity(velocity, wallNormal, 0.1f, 0.0f);

    // Normal component (-Z) should be cancelled to 0; lateral component (+X) should remain
    assert(std::abs(slideVel.z) < 1e-4f);
    assert(std::abs(slideVel.x - 1.8f) < 1e-4f); // 2.0 * (1 - 0.1 friction)

    // 2. Ground Snapping
    float groundSnap = TileCollisionSolver::resolveGroundSnap(10.0f, 10.3f, 0.45f);
    assert(std::abs(groundSnap - 10.3f) < 1e-4f);

    // 3. Water Buoyancy Solver
    // Entity wading in water at depth 0.9m
    Vec3 playerPos(0.0f, -0.9f, 0.0f);
    Vec3 playerVel(0.0f, -1.0f, 0.0f);
    float waterSurfaceY = 0.0f;

    auto buoyancy = WaterBuoyancySolver::computeForces(playerPos, playerVel, waterSurfaceY, 1.8f);

    // Upward buoyant force should counteract gravity
    assert(buoyancy.buoyantForce.y > 0.0f);
    assert(buoyancy.submersionRatio > 0.45f && buoyancy.submersionRatio < 0.55f);
    assert(buoyancy.fluidDragForce.y > 0.0f); // opposes downward velocity

    std::cout << "PHYSICS_OK: SlideX=" << slideVel.x
              << " BuoyancyY=" << buoyancy.buoyantForce.y << std::endl;
    return 0;
}
`;
        const res = await compiler.compileSource(source, {
            outputBinaryName: `test_physics_${Date.now()}`
        });

        expect(res.success).toBe(true);
        expect(res.binaryPath).toBeDefined();

        const execRes = await compiler.executeBinary(res.binaryPath!);
        expect(execRes.exitCode).toBe(0);
        expect(execRes.stdout).toContain('PHYSICS_OK');
    });
});
