/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Builds the frames for public/demos/showcase/glass_shatter_demo.html.
 *
 * The fracture engine (scratchbox_fracture.hpp, the same generator glass-shatter scenes use) is
 * compiled ephemerally through NativeCppCompilerService. The program integrates the Voronoi shards
 * once and writes one multi-material binary glTF per frame across the impact, plus a manifest.
 * Nothing here is committed geometry: frames live in public/models/glass_shatter/ (gitignored)
 * and are rebuilt by running this script.
 *
 * Usage:
 *   npx vite-node scripts/build_glass_shatter_demo.ts [--frames 30] [--duration 0.30]
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { NativeCppCompilerService } from '../packages/core/src/node/3d-engine/native-compiler-service';

function argNumber(name: string, fallback: number): number {
    const i = process.argv.indexOf(name);
    if (i < 0) return fallback;
    const v = Number(process.argv[i + 1]);
    if (!Number.isFinite(v) || v <= 0) throw new Error(`${name} must be a positive number`);
    return v;
}

const FRAME_COUNT = Math.round(argNumber('--frames', 30));
const DURATION_SEC = argNumber('--duration', 0.30);
const OUT_DIR = path.resolve(process.cwd(), 'public/models/glass_shatter');

const SOURCE = `#include "scratchbox_engine.hpp"
#include <cstdio>
#include <string>
#include <vector>

using namespace scratchbox;
using namespace scratchbox::geometry;
using namespace scratchbox::fracture;

int main(int argc, char** argv) {
    if (argc < 4) { std::fprintf(stderr, "usage: out_dir frame_count duration_sec\\n"); return 2; }
    const std::string outDir = argv[1];
    const int frameCount = std::stoi(argv[2]);
    const float duration = std::stof(argv[3]);

    // Denser fracture than the in-app default so the demo reads well up close.
    GlassPaneConfig pane;
    pane.outerFractureRadius = 1.35f;
    pane.radialCrackCount = 64;
    pane.concentricRings = 10;
    BulletConfig bullet;

    ScratchboxMesh frame = GlassFractureGenerator::generateFrame(pane);
    frame.name = "frame";
    frame.material = PbrMaterial::metalBrushedSteel();

    ScratchboxMesh intact = GlassFractureGenerator::generateIntactGlassPerimeter(pane, pane.outerFractureRadius);
    intact.name = "intact_glass";
    intact.material = PbrMaterial::opticalGlass();
    intact.material.alphaMode = "BLEND";

    std::vector<VoronoiShard> shards = GlassFractureGenerator::generateVoronoiShards(pane, bullet);
    const int substeps = 40;
    float simTime = 0.0f;

    for (int f = 0; f < frameCount; ++f) {
        const float t = duration * static_cast<float>(f) / static_cast<float>(frameCount - 1);
        // Integrate in small steps so the ballistic arcs stay accurate between frames.
        const float span = t - simTime;
        if (span > 0.0f) {
            const float dt = span / substeps;
            for (int s = 0; s < substeps; ++s) for (auto& shard : shards) shard.update(dt);
            simTime = t;
        }

        ScratchboxMesh glass;
        glass.name = "shards";
        for (const auto& shard : shards) glass.append(shard.getTransformedMesh());
        glass.material = PbrMaterial::opticalGlass();
        glass.material.alphaMode = "BLEND";

        // Same projectile path as GlassFractureGenerator::buildCompleteScene.
        const Vec3 bulletPos(0.0f, 0.0f, bullet.speed * 0.0035f * t + 0.12f);
        ScratchboxMesh round = GlassFractureGenerator::generateBulletMesh(bullet, bulletPos);
        round.name = "bullet";
        round.material = PbrMaterial::copperBullet();

        ScratchboxMesh shock = GlassFractureGenerator::generateSupersonicMachCone(bullet, bulletPos);
        shock.name = "shockwave";
        shock.material = PbrMaterial::glassTinted(Vec4(0.80f, 0.90f, 1.0f, 0.12f), 0.02f, 1.02f);
        shock.material.alphaMode = "BLEND";

        ScratchboxMesh sparks = GlassFractureGenerator::generateGlassDustAndSparks({0.0f, 0.0f, 0.05f}, 600);
        sparks.name = "sparks";
        sparks.material = PbrMaterial::emissiveGlow(Vec3(1.0f, 0.55f, 0.18f), 1.2f);

        const std::vector<ScratchboxMesh> parts{frame, intact, glass, round, shock, sparks};
        char name[64];
        std::snprintf(name, sizeof(name), "frame_%03d.glb", f);
        if (!io::GlbWriter::writeMultiMeshToFile(parts, outDir + "/" + name)) {
            std::fprintf(stderr, "failed to write %s\\n", name);
            return 1;
        }
        size_t verts = 0, tris = 0;
        for (const auto& p : parts) { verts += p.vertices.size(); tris += p.indices.size() / 3; }
        std::printf("{\\"file\\":\\"%s\\",\\"t\\":%.6f,\\"vertices\\":%zu,\\"triangles\\":%zu}\\n", name, t, verts, tris);
    }
    return 0;
}
`;

async function main() {
    if (FRAME_COUNT < 2) throw new Error('--frames must be at least 2');
    fs.mkdirSync(OUT_DIR, { recursive: true });
    for (const f of fs.readdirSync(OUT_DIR)) {
        if (/^frame_\d+\.glb$/.test(f)) fs.unlinkSync(path.join(OUT_DIR, f));
    }

    const compiled = await NativeCppCompilerService.getInstance().compileSource(SOURCE, {
        outputBinaryName: 'glass_shatter_demo_frames'
    });
    if (!compiled.success || !compiled.binaryPath) {
        throw new Error(`C++ compilation failed:\n${compiled.compilerOutput || compiled.error || ''}`);
    }

    const stdout = execFileSync(compiled.binaryPath, [OUT_DIR, String(FRAME_COUNT), String(DURATION_SEC)], {
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024
    });
    const frames = stdout.split('\n').filter(l => l.startsWith('{')).map(l => JSON.parse(l));
    if (frames.length !== FRAME_COUNT) throw new Error(`expected ${FRAME_COUNT} frames, got ${frames.length}`);
    for (const fr of frames) {
        const head = fs.readFileSync(path.join(OUT_DIR, fr.file)).subarray(0, 4).toString('latin1');
        if (head !== 'glTF') throw new Error(`${fr.file} is not a binary glTF`);
    }

    const manifest = {
        generator: 'scratchbox_fracture.hpp GlassFractureGenerator (compiled by scripts/build_glass_shatter_demo.ts)',
        builtAt: new Date().toISOString(),
        durationSec: DURATION_SEC,
        frames
    };
    fs.writeFileSync(path.join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));
    const maxVerts = Math.max(...frames.map(f => f.vertices));
    console.log(`Wrote ${frames.length} frames (${maxVerts} vertices max) to ${path.relative(process.cwd(), OUT_DIR)}`);
}

main().catch(err => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
});
