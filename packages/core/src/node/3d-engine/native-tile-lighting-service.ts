/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';
import { NativeCppCompilerService } from './native-compiler-service';

const execAsync = promisify(exec);

export interface NativeSunEstimateOptions {
    meshVertices: Float32Array | number[]; // [x, y, z, ...]
    meshIndices: Uint32Array | number[];
    meshUvs: Float32Array | number[];      // [u, v, ...]
    meshNormals?: Float32Array | number[];
    textureWidth: number;
    textureHeight: number;
    textureRgbBytes: Buffer | Uint8Array;
}

export interface NativeSunEstimateResult {
    success: boolean;
    sunDirection: [number, number, number];
    elevationDeg: number;
    azimuthDeg: number;
    correlationScore: number;
    samplePointsTested: number;
}

export interface NativeDelightOptions {
    epsilonClamp?: number;
    directSunWeight?: number;
    skyDomeWeight?: number;
    groundBounceWeight?: number;
    rtaoSamplesPerVertex?: number;
    rtaoMaxDistance?: number;
    enableBilateralFilter?: boolean;
}

export interface NativePerFaceMaterialResult {
    faceIndex: number;
    classId: number;
    className: string;
    roughness: number;
    metalness: number;
    specular: number;
}

export interface NativeMaterialClassifyOptions {
    buildingFootprints?: Array<Array<[number, number]>>;
    roadCorridors?: Array<Array<[number, number]>>;
    waterBoundaries?: Array<Array<[number, number]>>;
}

/**
 * Service exposing native C++20 physical de-lighting, sun vector estimation,
 * shadow removal, and per-face material classification.
 */
export class NativeTileLightingService {
    private compiler: NativeCppCompilerService;

    constructor(customIncludePath?: string) {
        this.compiler = new NativeCppCompilerService(customIncludePath);
    }

    /**
     * Estimates capture-day sun direction from baked shadows and mesh geometry
     * using scratchbox_delight.hpp and BVH raycasting.
     */
    public async estimateCaptureSunDirection(
        options: NativeSunEstimateOptions
    ): Promise<NativeSunEstimateResult> {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbox_sun_solve_'));
        const sourceFile = path.join(tmpDir, 'sun_solver.cpp');
        const binaryPath = path.join(tmpDir, 'sun_solver');
        const dataPath = path.join(tmpDir, 'scene_data.bin');

        try {
            // Write binary scene data
            // Format:
            // uint32_t vertCount, triCount, texW, texH
            // float[vertCount * 8] (x, y, z, nx, ny, nz, u, v)
            // uint32_t[triCount * 3] indices
            // uint8_t[texW * texH * 3] rgb
            const vertCount = options.meshVertices.length / 3;
            const triCount = options.meshIndices.length / 3;
            const texW = options.textureWidth;
            const texH = options.textureHeight;

            const headerBuf = Buffer.alloc(16);
            headerBuf.writeUInt32LE(vertCount, 0);
            headerBuf.writeUInt32LE(triCount, 4);
            headerBuf.writeUInt32LE(texW, 8);
            headerBuf.writeUInt32LE(texH, 12);

            const vertBuf = Buffer.alloc(vertCount * 8 * 4);
            for (let i = 0; i < vertCount; i++) {
                const vx = options.meshVertices[i * 3];
                const vy = options.meshVertices[i * 3 + 1];
                const vz = options.meshVertices[i * 3 + 2];
                const nx = options.meshNormals ? options.meshNormals[i * 3] : 0;
                const ny = options.meshNormals ? options.meshNormals[i * 3 + 1] : 1;
                const nz = options.meshNormals ? options.meshNormals[i * 3 + 2] : 0;
                const u = options.meshUvs[i * 2];
                const v = options.meshUvs[i * 2 + 1];

                vertBuf.writeFloatLE(vx, (i * 8 + 0) * 4);
                vertBuf.writeFloatLE(vy, (i * 8 + 1) * 4);
                vertBuf.writeFloatLE(vz, (i * 8 + 2) * 4);
                vertBuf.writeFloatLE(nx, (i * 8 + 3) * 4);
                vertBuf.writeFloatLE(ny, (i * 8 + 4) * 4);
                vertBuf.writeFloatLE(nz, (i * 8 + 5) * 4);
                vertBuf.writeFloatLE(u, (i * 8 + 6) * 4);
                vertBuf.writeFloatLE(v, (i * 8 + 7) * 4);
            }

            const idxBuf = Buffer.alloc(triCount * 3 * 4);
            for (let i = 0; i < triCount * 3; i++) {
                idxBuf.writeUInt32LE(options.meshIndices[i], i * 4);
            }

            const rgbBuf = Buffer.from(options.textureRgbBytes);

            const fileStream = fs.createWriteStream(dataPath);
            fileStream.write(headerBuf);
            fileStream.write(vertBuf);
            fileStream.write(idxBuf);
            fileStream.write(rgbBuf);
            await new Promise((resolve) => fileStream.end(resolve));

            const cppCode = `
#include <iostream>
#include <fstream>
#include <vector>
#include "scratchbox_delight.hpp"

using namespace scratchbox;

int main(int argc, char** argv) {
    if (argc < 2) return 1;
    std::ifstream in(argv[1], std::ios::binary);
    if (!in) return 1;

    uint32_t vertCount = 0, triCount = 0, texW = 0, texH = 0;
    in.read(reinterpret_cast<char*>(&vertCount), 4);
    in.read(reinterpret_cast<char*>(&triCount), 4);
    in.read(reinterpret_cast<char*>(&texW), 4);
    in.read(reinterpret_cast<char*>(&texH), 4);

    geometry::ScratchboxMesh mesh;
    mesh.vertices.resize(vertCount);
    for (uint32_t i = 0; i < vertCount; ++i) {
        float data[8];
        in.read(reinterpret_cast<char*>(data), 8 * sizeof(float));
        mesh.vertices[i].position = math::Vec3(data[0], data[1], data[2]);
        mesh.vertices[i].normal = math::Vec3(data[3], data[4], data[5]);
        mesh.vertices[i].uv = math::Vec2(data[6], data[7]);
    }

    mesh.indices.resize(triCount * 3);
    in.read(reinterpret_cast<char*>(mesh.indices.data()), triCount * 3 * sizeof(uint32_t));

    texture::ImageBuffer tex(texW, texH, 3);
    in.read(reinterpret_cast<char*>(tex.data.data()), texW * texH * 3);

    bvh::BvhTree bvh;
    bvh.build(mesh);

    auto result = delight::SunShadowSolver::estimateSunDirection(mesh, tex, bvh);

    std::cout << "{"
              << "\\\"success\\\":" << (result.success ? "true" : "false") << ","
              << "\\\"sunDirection\\\":[" << result.sunDirection.x << "," << result.sunDirection.y << "," << result.sunDirection.z << "],"
              << "\\\"elevationDeg\\\":" << result.elevationDeg << ","
              << "\\\"azimuthDeg\\\":" << result.azimuthDeg << ","
              << "\\\"correlationScore\\\":" << result.correlationScore << ","
              << "\\\"samplePointsTested\\\":" << result.samplePointsTested
              << "}" << std::endl;

    return 0;
}
`;

            fs.writeFileSync(sourceFile, cppCode);

            const compileRes = await this.compiler.compileSource(cppCode, {
                outputDir: tmpDir,
                outputBinaryName: 'sun_solver',
                optimization: '-O3'
            });

            if (!compileRes.success) {
                throw new Error(`Failed to compile C++ sun solver: ${compileRes.diagnostics.map(d => d.message).join('; ')}`);
            }

            const { stdout } = await execAsync(`"${binaryPath}" "${dataPath}"`);
            const parsed = JSON.parse(stdout.trim());
            return parsed;
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    }

    /**
     * Executes real physical de-lighting (dividing out mesh shading) and shadow removal.
     */
    public async delightTextureAndRelight(
        mesh: { vertices: number[]; indices: number[]; uvs: number[]; normals?: number[] },
        texture: { width: number; height: number; rgbBytes: Buffer | Uint8Array },
        sunDirection: [number, number, number],
        options: NativeDelightOptions = {}
    ): Promise<{ delightedRgbBytes: Buffer; relitRgbBytes: Buffer }> {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbox_delight_'));
        const sourceFile = path.join(tmpDir, 'delight_runner.cpp');
        const binaryPath = path.join(tmpDir, 'delight_runner');
        const dataPath = path.join(tmpDir, 'scene_data.bin');
        const outDelightPath = path.join(tmpDir, 'delighted.bin');
        const outRelitPath = path.join(tmpDir, 'relit.bin');

        try {
            const vertCount = mesh.vertices.length / 3;
            const triCount = mesh.indices.length / 3;
            const texW = texture.width;
            const texH = texture.height;

            const headerBuf = Buffer.alloc(16);
            headerBuf.writeUInt32LE(vertCount, 0);
            headerBuf.writeUInt32LE(triCount, 4);
            headerBuf.writeUInt32LE(texW, 8);
            headerBuf.writeUInt32LE(texH, 12);

            const vertBuf = Buffer.alloc(vertCount * 8 * 4);
            for (let i = 0; i < vertCount; i++) {
                const vx = mesh.vertices[i * 3];
                const vy = mesh.vertices[i * 3 + 1];
                const vz = mesh.vertices[i * 3 + 2];
                const nx = mesh.normals ? mesh.normals[i * 3] : 0;
                const ny = mesh.normals ? mesh.normals[i * 3 + 1] : 1;
                const nz = mesh.normals ? mesh.normals[i * 3 + 2] : 0;
                const u = mesh.uvs[i * 2];
                const v = mesh.uvs[i * 2 + 1];

                vertBuf.writeFloatLE(vx, (i * 8 + 0) * 4);
                vertBuf.writeFloatLE(vy, (i * 8 + 1) * 4);
                vertBuf.writeFloatLE(vz, (i * 8 + 2) * 4);
                vertBuf.writeFloatLE(nx, (i * 8 + 3) * 4);
                vertBuf.writeFloatLE(ny, (i * 8 + 4) * 4);
                vertBuf.writeFloatLE(nz, (i * 8 + 5) * 4);
                vertBuf.writeFloatLE(u, (i * 8 + 6) * 4);
                vertBuf.writeFloatLE(v, (i * 8 + 7) * 4);
            }

            const idxBuf = Buffer.alloc(triCount * 3 * 4);
            for (let i = 0; i < triCount * 3; i++) {
                idxBuf.writeUInt32LE(mesh.indices[i], i * 4);
            }

            const rgbBuf = Buffer.from(texture.rgbBytes);

            const fileStream = fs.createWriteStream(dataPath);
            fileStream.write(headerBuf);
            fileStream.write(vertBuf);
            fileStream.write(idxBuf);
            fileStream.write(rgbBuf);
            await new Promise((resolve) => fileStream.end(resolve));

            const toCppFloat = (n: number) => Number.isInteger(n) ? n.toFixed(1) + 'f' : n + 'f';

            const cppCode = `
#include <iostream>
#include <fstream>
#include <vector>
#include "scratchbox_delight.hpp"

using namespace scratchbox;

int main(int argc, char** argv) {
    if (argc < 4) return 1;
    std::ifstream in(argv[1], std::ios::binary);
    if (!in) return 1;

    uint32_t vertCount = 0, triCount = 0, texW = 0, texH = 0;
    in.read(reinterpret_cast<char*>(&vertCount), 4);
    in.read(reinterpret_cast<char*>(&triCount), 4);
    in.read(reinterpret_cast<char*>(&texW), 4);
    in.read(reinterpret_cast<char*>(&texH), 4);

    geometry::ScratchboxMesh mesh;
    mesh.vertices.resize(vertCount);
    for (uint32_t i = 0; i < vertCount; ++i) {
        float data[8];
        in.read(reinterpret_cast<char*>(data), 8 * sizeof(float));
        mesh.vertices[i].position = math::Vec3(data[0], data[1], data[2]);
        mesh.vertices[i].normal = math::Vec3(data[3], data[4], data[5]);
        mesh.vertices[i].uv = math::Vec2(data[6], data[7]);
    }

    mesh.indices.resize(triCount * 3);
    in.read(reinterpret_cast<char*>(mesh.indices.data()), triCount * 3 * sizeof(uint32_t));

    texture::ImageBuffer tex(texW, texH, 3);
    in.read(reinterpret_cast<char*>(tex.data.data()), texW * texH * 3);

    bvh::BvhTree bvh;
    bvh.build(mesh);

    math::Vec3 sunDir(${toCppFloat(sunDirection[0])}, ${toCppFloat(sunDirection[1])}, ${toCppFloat(sunDirection[2])});

    delight::DeLighterOptions opt;
    opt.epsilonClamp = ${toCppFloat(options.epsilonClamp ?? 0.10)};
    opt.directSunWeight = ${toCppFloat(options.directSunWeight ?? 0.75)};
    opt.skyDomeWeight = ${toCppFloat(options.skyDomeWeight ?? 0.20)};
    opt.groundBounceWeight = ${toCppFloat(options.groundBounceWeight ?? 0.05)};
    opt.rtaoSamplesPerVertex = ${options.rtaoSamplesPerVertex ?? 16};
    opt.rtaoMaxDistance = ${toCppFloat(options.rtaoMaxDistance ?? 2.5)};

    // 1. Render mesh shading into UV space
    auto shading = delight::TileShadingRenderer::renderShadingMap(mesh, bvh, sunDir, texW, texH, opt);

    // 2. Real physical de-lighting (dividing out shading)
    auto delighted = delight::TextureDeLighter::deLight(tex, shading, opt);

    // 3. Shadow detection and sunlit color re-lighting
    auto relit = delight::ShadowRelighter::detectAndRelightShadows(tex, shading);

    // Write outputs
    std::ofstream outDelight(argv[2], std::ios::binary);
    outDelight.write(reinterpret_cast<const char*>(delighted.data.data()), texW * texH * 3);

    std::ofstream outRelit(argv[3], std::ios::binary);
    outRelit.write(reinterpret_cast<const char*>(relit.data.data()), texW * texH * 3);

    std::cout << "SUCCESS" << std::endl;
    return 0;
}
`;

            fs.writeFileSync(sourceFile, cppCode);

            const compileRes = await this.compiler.compileSource(cppCode, {
                outputDir: tmpDir,
                outputBinaryName: 'delight_runner',
                optimization: '-O3'
            });

            if (!compileRes.success) {
                throw new Error(`Failed to compile C++ delight runner: ${compileRes.diagnostics.map(d => d.message).join('; ')}`);
            }

            await execAsync(`"${binaryPath}" "${dataPath}" "${outDelightPath}" "${outRelitPath}"`);

            const delightedRgbBytes = fs.readFileSync(outDelightPath);
            const relitRgbBytes = fs.readFileSync(outRelitPath);

            return { delightedRgbBytes, relitRgbBytes };
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    }

    /**
     * Executes deterministic multi-signal per-face material classification in C++.
     */
    public async classifyMeshMaterials(
        mesh: { vertices: number[]; indices: number[]; uvs?: number[]; normals?: number[]; colors?: number[] },
        texture?: { width: number; height: number; rgbBytes: Buffer | Uint8Array },
        options: NativeMaterialClassifyOptions = {}
    ): Promise<NativePerFaceMaterialResult[]> {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbox_mat_'));
        const sourceFile = path.join(tmpDir, 'mat_runner.cpp');
        const binaryPath = path.join(tmpDir, 'mat_runner');
        const dataPath = path.join(tmpDir, 'mesh_data.bin');

        try {
            const vertCount = mesh.vertices.length / 3;
            const triCount = mesh.indices.length / 3;
            const texW = texture ? texture.width : 0;
            const texH = texture ? texture.height : 0;

            const headerBuf = Buffer.alloc(16);
            headerBuf.writeUInt32LE(vertCount, 0);
            headerBuf.writeUInt32LE(triCount, 4);
            headerBuf.writeUInt32LE(texW, 8);
            headerBuf.writeUInt32LE(texH, 12);

            const vertBuf = Buffer.alloc(vertCount * 11 * 4);
            for (let i = 0; i < vertCount; i++) {
                const vx = mesh.vertices[i * 3];
                const vy = mesh.vertices[i * 3 + 1];
                const vz = mesh.vertices[i * 3 + 2];
                const nx = mesh.normals ? mesh.normals[i * 3] : 0;
                const ny = mesh.normals ? mesh.normals[i * 3 + 1] : 1;
                const nz = mesh.normals ? mesh.normals[i * 3 + 2] : 0;
                const u = mesh.uvs ? mesh.uvs[i * 2] : 0;
                const v = mesh.uvs ? mesh.uvs[i * 2 + 1] : 0;
                const cr = mesh.colors ? mesh.colors[i * 3] : 0.5;
                const cg = mesh.colors ? mesh.colors[i * 3 + 1] : 0.5;
                const cb = mesh.colors ? mesh.colors[i * 3 + 2] : 0.5;

                vertBuf.writeFloatLE(vx, (i * 11 + 0) * 4);
                vertBuf.writeFloatLE(vy, (i * 11 + 1) * 4);
                vertBuf.writeFloatLE(vz, (i * 11 + 2) * 4);
                vertBuf.writeFloatLE(nx, (i * 11 + 3) * 4);
                vertBuf.writeFloatLE(ny, (i * 11 + 4) * 4);
                vertBuf.writeFloatLE(nz, (i * 11 + 5) * 4);
                vertBuf.writeFloatLE(u, (i * 11 + 6) * 4);
                vertBuf.writeFloatLE(v, (i * 11 + 7) * 4);
                vertBuf.writeFloatLE(cr, (i * 11 + 8) * 4);
                vertBuf.writeFloatLE(cg, (i * 11 + 9) * 4);
                vertBuf.writeFloatLE(cb, (i * 11 + 10) * 4);
            }

            const idxBuf = Buffer.alloc(triCount * 3 * 4);
            for (let i = 0; i < triCount * 3; i++) {
                idxBuf.writeUInt32LE(mesh.indices[i], i * 4);
            }

            const fileStream = fs.createWriteStream(dataPath);
            fileStream.write(headerBuf);
            fileStream.write(vertBuf);
            fileStream.write(idxBuf);
            if (texture && texture.rgbBytes) {
                fileStream.write(Buffer.from(texture.rgbBytes));
            }
            await new Promise((resolve) => fileStream.end(resolve));

            // Format polygon data into C++ vectors
            let polySetupCode = '';
            const toF = (n: number) => Number.isInteger(n) ? `${n}.0f` : `${n}f`;
            if (options.buildingFootprints && options.buildingFootprints.length > 0) {
                for (let p = 0; p < options.buildingFootprints.length; p++) {
                    const poly = options.buildingFootprints[p];
                    polySetupCode += `{\n  std::vector<math::Vec2> fp = {`;
                    polySetupCode += poly.map(pt => `math::Vec2(${toF(pt[0])}, ${toF(pt[1])})`).join(', ');
                    polySetupCode += `};\n  mapData.buildingFootprints.push_back(fp);\n}\n`;
                }
            }
            if (options.roadCorridors && options.roadCorridors.length > 0) {
                for (let p = 0; p < options.roadCorridors.length; p++) {
                    const poly = options.roadCorridors[p];
                    polySetupCode += `{\n  std::vector<math::Vec2> rc = {`;
                    polySetupCode += poly.map(pt => `math::Vec2(${toF(pt[0])}, ${toF(pt[1])})`).join(', ');
                    polySetupCode += `};\n  mapData.roadCorridors.push_back(rc);\n}\n`;
                }
            }
            if (options.waterBoundaries && options.waterBoundaries.length > 0) {
                for (let p = 0; p < options.waterBoundaries.length; p++) {
                    const poly = options.waterBoundaries[p];
                    polySetupCode += `{\n  std::vector<math::Vec2> wb = {`;
                    polySetupCode += poly.map(pt => `math::Vec2(${toF(pt[0])}, ${toF(pt[1])})`).join(', ');
                    polySetupCode += `};\n  mapData.waterBoundaries.push_back(wb);\n}\n`;
                }
            }

            const cppCode = `
#include <iostream>
#include <fstream>
#include <vector>
#include "scratchbox_material.hpp"

using namespace scratchbox;

int main(int argc, char** argv) {
    if (argc < 2) return 1;
    std::ifstream in(argv[1], std::ios::binary);
    if (!in) return 1;

    uint32_t vertCount = 0, triCount = 0, texW = 0, texH = 0;
    in.read(reinterpret_cast<char*>(&vertCount), 4);
    in.read(reinterpret_cast<char*>(&triCount), 4);
    in.read(reinterpret_cast<char*>(&texW), 4);
    in.read(reinterpret_cast<char*>(&texH), 4);

    geometry::ScratchboxMesh mesh;
    mesh.vertices.resize(vertCount);
    for (uint32_t i = 0; i < vertCount; ++i) {
        float data[11];
        in.read(reinterpret_cast<char*>(data), 11 * sizeof(float));
        mesh.vertices[i].position = math::Vec3(data[0], data[1], data[2]);
        mesh.vertices[i].normal = math::Vec3(data[3], data[4], data[5]);
        mesh.vertices[i].uv = math::Vec2(data[6], data[7]);
        mesh.vertices[i].color = math::Vec4(data[8], data[9], data[10], 1.0f);
    }

    mesh.indices.resize(triCount * 3);
    in.read(reinterpret_cast<char*>(mesh.indices.data()), triCount * 3 * sizeof(uint32_t));

    texture::ImageBuffer tex;
    if (texW > 0 && texH > 0) {
        tex = texture::ImageBuffer(texW, texH, 3);
        in.read(reinterpret_cast<char*>(tex.data.data()), texW * texH * 3);
    }

    material::MapVectorPolygons mapData;
    ${polySetupCode}

    auto signals = material::PerFaceSignalExtractor::extractSignals(mesh, tex, mapData);
    auto materials = material::PerFaceMaterialClassifier::classifyAndAssignPbr(signals);

    std::cout << "[";
    for (size_t i = 0; i < materials.size(); ++i) {
        if (i > 0) std::cout << ",";
        const auto& m = materials[i];
        std::cout << "{"
                  << "\\\"faceIndex\\\":" << i << ","
                  << "\\\"classId\\\":" << static_cast<int>(m.classId) << ","
                  << "\\\"className\\\":\\\"" << material::getMaterialClassName(m.classId) << "\\\","
                  << "\\\"roughness\\\":" << m.roughness << ","
                  << "\\\"metalness\\\":" << m.metalness << ","
                  << "\\\"specular\\\":" << m.specular
                  << "}";
    }
    std::cout << "]" << std::endl;

    return 0;
}
`;

            fs.writeFileSync(sourceFile, cppCode);

            const compileRes = await this.compiler.compileSource(cppCode, {
                outputDir: tmpDir,
                outputBinaryName: 'mat_runner',
                optimization: '-O3'
            });

            if (!compileRes.success) {
                throw new Error(`Failed to compile C++ material runner: ${compileRes.diagnostics.map(d => d.message).join('; ')}`);
            }

            const { stdout } = await execAsync(`"${binaryPath}" "${dataPath}"`, { maxBuffer: 32 * 1024 * 1024 });
            const parsed: NativePerFaceMaterialResult[] = JSON.parse(stdout.trim());
            return parsed;
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    }
}
