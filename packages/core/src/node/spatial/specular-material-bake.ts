/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Writes a projectMaskedViewsToUv result back into the mesh it was read from: a new metallicRoughness texture, baked
 * at the mesh's own UV layout, with the accepted regions at the given glass roughness/metalness (dielectric) and every
 * other texel left at the mesh's own existing roughness/metalness (so nothing outside the accepted regions changes).
 * The mesh's existing base colour (factor and, where it has one, its own texture) is re-embedded unchanged.
 *
 * Scoped to one material: a mesh read with more than one throws, naming the count, rather than silently keeping only
 * one or dropping the others. Multi-material meshes need writeMultiMeshToFile, not attempted here.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { execFile } from 'child_process';
import { compileNativeCached, defaultNativeFlags } from '../3d-engine/native-build-cache';
import { NativeCppCompilerService } from '../3d-engine/native-compiler-service';
import { GLASS_ROUGHNESS } from '../3d-engine/staged-location/facade-materials';
import type { SpecularProjectionResult } from './specular-material-projection';

const compiler = NativeCppCompilerService.getInstance();
const FLAGS = defaultNativeFlags();

const BAKE_SOURCE = `
#include "scratchbox_gltf_scene.hpp"
#include "scratchbox_png.hpp"
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <vector>
using namespace scratchbox;

int main(int argc, char** argv) {
    if (argc < 9) { std::fprintf(stderr, "usage: inGlb outGlb votesFile outSize glassRoughness glassMetalness uMin vMin uMax vMax gridSize\\n"); return 1; }
    const char* inGlb = argv[1];
    const char* outGlb = argv[2];
    const char* votesPath = argv[3];
    int outSize = std::atoi(argv[4]);
    float glassRoughness = static_cast<float>(std::atof(argv[5]));
    float glassMetalness = static_cast<float>(std::atof(argv[6]));
    float uMin = static_cast<float>(std::atof(argv[7]));
    float vMin = static_cast<float>(std::atof(argv[8]));
    float uMax = static_cast<float>(std::atof(argv[9]));
    float vMax = static_cast<float>(std::atof(argv[10]));
    int gridSize = std::atoi(argv[11]);

    gltf::GltfScene scene = gltf::GlbSceneReader::readFile(inGlb);
    if (!scene.ok) { std::fprintf(stderr, "read failed: %s\\n", scene.error.c_str()); return 1; }
    if (scene.materials.size() != 1) { std::fprintf(stderr, "needs exactly one material, this mesh has %zu\\n", scene.materials.size()); return 1; }
    const auto& m = scene.materials[0];

    std::vector<uint8_t> votes(static_cast<size_t>(gridSize) * gridSize);
    {
        std::ifstream vf(votesPath, std::ios::binary);
        if (!vf) { std::fprintf(stderr, "cannot open votes file %s\\n", votesPath); return 1; }
        vf.read(reinterpret_cast<char*>(votes.data()), static_cast<std::streamsize>(votes.size()));
        if (!vf) { std::fprintf(stderr, "votes file %s is short\\n", votesPath); return 1; }
    }

    texture::ImageBuffer mr(outSize, outSize, 3, 0);
    const uint8_t defaultG = static_cast<uint8_t>(std::round(std::min(1.0f, std::max(0.0f, m.roughnessFactor)) * 255.0f));
    const uint8_t defaultB = static_cast<uint8_t>(std::round(std::min(1.0f, std::max(0.0f, m.metallicFactor)) * 255.0f));
    const uint8_t glassG = static_cast<uint8_t>(std::round(std::min(1.0f, std::max(0.0f, glassRoughness)) * 255.0f));
    const uint8_t glassB = static_cast<uint8_t>(std::round(std::min(1.0f, std::max(0.0f, glassMetalness)) * 255.0f));
    long acceptedTexels = 0;
    const float uSpan = std::max(1e-6f, uMax - uMin), vSpan = std::max(1e-6f, vMax - vMin);
    for (int py = 0; py < outSize; py++) {
        // glTF: texture (0,0) is the image's upper-left, v increasing downward, matching the row index directly.
        float v = (py + 0.5f) / outSize;
        int gy = static_cast<int>((v - vMin) / vSpan * gridSize);
        for (int px = 0; px < outSize; px++) {
            float u = (px + 0.5f) / outSize;
            int gx = static_cast<int>((u - uMin) / uSpan * gridSize);
            uint8_t vote = (gx >= 0 && gx < gridSize && gy >= 0 && gy < gridSize) ? votes[static_cast<size_t>(gy) * gridSize + gx] : 0;
            size_t idx = (static_cast<size_t>(py) * outSize + px) * 3;
            mr.data[idx] = 255;
            if (vote) { mr.data[idx + 1] = glassG; mr.data[idx + 2] = glassB; acceptedTexels++; }
            else { mr.data[idx + 1] = defaultG; mr.data[idx + 2] = defaultB; }
        }
    }
    std::vector<uint8_t> mrPng = png::encode(mr);

    scene.mesh.material.baseColorFactor = m.baseColorFactor;
    scene.mesh.material.roughnessFactor = 1.0f; // the texture is authoritative everywhere now
    scene.mesh.material.metallicFactor = 1.0f;

    std::vector<io::EmbeddedTexture> textures;
    bool hadBaseColorTexture = m.baseColorImage >= 0 && m.baseColorImage < static_cast<int>(scene.images.size()) && !scene.images[m.baseColorImage].encoded.empty();
    if (hadBaseColorTexture) {
        io::EmbeddedTexture bc;
        bc.usage = io::TextureUsage::BASE_COLOR;
        bc.mimeType = scene.images[m.baseColorImage].mimeType.empty() ? "image/png" : scene.images[m.baseColorImage].mimeType;
        bc.data = scene.images[m.baseColorImage].encoded;
        textures.push_back(bc);
    }
    io::EmbeddedTexture mrTex;
    mrTex.usage = io::TextureUsage::METALLIC_ROUGHNESS;
    mrTex.mimeType = "image/png";
    mrTex.data = mrPng;
    textures.push_back(mrTex);

    if (!io::GlbWriter::writeToFile(scene.mesh, outGlb, textures)) { std::fprintf(stderr, "write failed\\n"); return 1; }

    // re-read the file just written, as independent confirmation the metallicRoughness texture actually round-trips
    gltf::GltfScene after = gltf::GlbSceneReader::readFile(outGlb);
    if (!after.ok) { std::fprintf(stderr, "wrote %s but could not read it back: %s\\n", outGlb, after.error.c_str()); return 1; }
    bool hasMrAfter = after.materials.size() == 1 && after.materials[0].metallicRoughnessImage >= 0
        && after.materials[0].metallicRoughnessImage < static_cast<int>(after.images.size());

    std::printf("{\\"vertices\\":%zu,\\"triangles\\":%zu,\\"hadBaseColorTexture\\":%s,\\"acceptedTexels\\":%ld,\\"totalTexels\\":%d,\\"hasMetallicRoughnessTextureAfter\\":%s,\\"materialsAfter\\":%zu,\\"imagesAfter\\":%zu}\\n",
        scene.mesh.vertices.size(), scene.mesh.indices.size() / 3, hadBaseColorTexture ? "true" : "false", acceptedTexels, outSize * outSize,
        hasMrAfter ? "true" : "false", after.materials.size(), after.images.size());
    return 0;
}
`;

async function compileAndRun(args: string[]): Promise<string> {
    const result = await compileNativeCached({ sourceCode: BAKE_SOURCE, includeDirs: [compiler.getSdkIncludePath()], flags: FLAGS, libs: ['-lz'], name: 'specular_material_bake' });
    return new Promise<string>((resolve, reject) => {
        execFile(result.binaryPath, args, { timeout: 2 * 60_000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
            if (err) reject(Object.assign(err, { stderr })); else resolve(stdout);
        });
    });
}

export interface BakeSpecularMaterialsOptions {
    /** Side length of the baked metallicRoughness texture (default 1024). */
    textureSize?: number;
    /** Roughness written at accepted texels (default facade-materials.ts's measured float-glass value). */
    glassRoughness?: number;
    /** Metalness written at accepted texels (default 0: dielectric, so the viewer's own environment gives the Fresnel reflection). */
    glassMetalness?: number;
}

export interface BakeSpecularMaterialsResult {
    glbPath: string;
    vertices: number;
    triangles: number;
    hadBaseColorTexture: boolean;
    acceptedTexels: number;
    totalTexels: number;
    /** Independent confirmation: the output file was re-read and its metallicRoughness texture found, not just written. */
    hasMetallicRoughnessTextureAfter: boolean;
    materialsAfter: number;
    imagesAfter: number;
}

/** Bakes a projectMaskedViewsToUv result into a new copy of the mesh it was read from, at outputGlbPath. */
export async function bakeSpecularMaterials(glbPath: string, result: SpecularProjectionResult, outputGlbPath: string, opts: BakeSpecularMaterialsOptions = {}): Promise<BakeSpecularMaterialsResult> {
    const textureSize = opts.textureSize ?? 1024;
    const glassRoughness = opts.glassRoughness ?? GLASS_ROUGHNESS;
    const glassMetalness = opts.glassMetalness ?? 0;

    const votesPath = path.join(os.tmpdir(), `specular-votes-${process.pid}-${crypto.randomBytes(6).toString('hex')}.bin`);
    fs.writeFileSync(votesPath, Buffer.from(result.votes));
    try {
        const stdout = await compileAndRun([
            glbPath, outputGlbPath, votesPath, String(textureSize), String(glassRoughness), String(glassMetalness),
            String(result.uvMin[0]), String(result.uvMin[1]), String(result.uvMax[0]), String(result.uvMax[1]), String(result.gridSize)
        ]);
        const parsed = JSON.parse(stdout.trim()) as {
            vertices: number; triangles: number; hadBaseColorTexture: boolean; acceptedTexels: number; totalTexels: number;
            hasMetallicRoughnessTextureAfter: boolean; materialsAfter: number; imagesAfter: number;
        };
        return { glbPath: outputGlbPath, ...parsed };
    } finally {
        fs.rmSync(votesPath, { force: true });
    }
}
