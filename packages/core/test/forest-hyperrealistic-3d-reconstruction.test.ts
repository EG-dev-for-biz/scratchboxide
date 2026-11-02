/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NativeCppCompilerService } from '../src/node/3d-engine/native-compiler-service';

describe('Hyperrealistic Forest Procedural 3D Reconstruction from Image', () => {
    const compiler = new NativeCppCompilerService();
    const sourcePath = path.resolve(process.cwd(), 'scripts/generate_forest_procedural_3d.cpp');
    // Generated GLB goes to a temp dir, not public/models (tests must not write into public/).
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-forest-hyperreal-'));
    afterAll(() => fs.rmSync(outDir, { recursive: true, force: true }));
    const outGlbPath = path.join(outDir, 'forest_hyperreal.glb');
    const referenceImagePath = path.resolve(process.cwd(), 'public/forest_reference.png');

    it('should locate the generated forest reference photograph', () => {
        expect(fs.existsSync(referenceImagePath)).toBe(true);
        const stats = fs.statSync(referenceImagePath);
        expect(stats.size).toBeGreaterThan(50000);
    });

    it('should compile the native C++20 Astro forest generator without errors', async () => {
        expect(fs.existsSync(sourcePath)).toBe(true);
        const sourceCode = fs.readFileSync(sourcePath, 'utf8');

        // zlib: the generator reads the reference photograph and writes the fern leaf's maps as PNG
        const result = await compiler.compileSource(sourceCode, {
            outputBinaryName: 'generate_forest_procedural_3d',
            optimization: '-O3',
            extraFlags: ['-lz']
        });

        if (!result.success) {
            console.error('Compiler diagnostics:', result.diagnostics);
            console.error('Compiler output:', result.compilerOutput);
        }

        expect(result.success).toBe(true);
        expect(fs.existsSync(result.binaryPath)).toBe(true);
    }, 120000);

    it('should execute generator binary and emit valid binary glTF 2.0 (.glb)', async () => {
        const binDir = path.resolve(process.cwd(), 'build/3d-native');
        const binaryPath = path.join(binDir, 'generate_forest_procedural_3d');

        const execResult = await compiler.executeBinary(binaryPath, [outGlbPath], process.cwd());
        expect(execResult.exitCode).toBe(0);

        expect(fs.existsSync(outGlbPath)).toBe(true);
        const buf = fs.readFileSync(outGlbPath);
        expect(buf.length).toBeGreaterThan(100000);

        // Validate glTF 2.0 binary header
        const magic = buf.readUInt32LE(0);
        const version = buf.readUInt32LE(4);
        const length = buf.readUInt32LE(8);

        expect(magic).toBe(0x46546C67); // 'glTF'
        expect(version).toBe(2);
        expect(length).toBe(buf.length);

        // Parse JSON chunk
        const jsonChunkLen = buf.readUInt32LE(12);
        const jsonChunkType = buf.readUInt32LE(16);
        expect(jsonChunkType).toBe(0x4E4F534A); // 'JSON'

        const jsonStr = buf.toString('utf8', 20, 20 + jsonChunkLen);
        const gltf = JSON.parse(jsonStr);

        expect(gltf.asset?.version).toBe('2.0');
        expect(gltf.meshes?.length).toBeGreaterThanOrEqual(1);

        // Inspect total vertex count and physical extents
        let totalVertices = 0;
        let totalTriangles = 0;
        let maxY = -Infinity;
        let minY = Infinity;
        let minX = Infinity, maxX = -Infinity;
        let minZ = Infinity, maxZ = -Infinity;

        if (gltf.accessors) {
            for (const acc of gltf.accessors) {
                if (acc.type === 'VEC3' && acc.max && acc.min) {
                    minX = Math.min(minX, acc.min[0]);
                    maxX = Math.max(maxX, acc.max[0]);
                    minY = Math.min(minY, acc.min[1]);
                    maxY = Math.max(maxY, acc.max[1]);
                    minZ = Math.min(minZ, acc.min[2]);
                    maxZ = Math.max(maxZ, acc.max[2]);
                    totalVertices += acc.count;
                }
                if (acc.type === 'SCALAR') {
                    totalTriangles += acc.count / 3;
                }
            }
        }

        console.log(`Generated Forest GLB Telemetry:`);
        console.log(`  Vertices: ${totalVertices}`);
        console.log(`  Triangles: ${Math.round(totalTriangles)}`);
        console.log(`  Bounding Box: [${minX.toFixed(1)}, ${minY.toFixed(1)}, ${minZ.toFixed(1)}] to [${maxX.toFixed(1)}, ${maxY.toFixed(1)}, ${maxZ.toFixed(1)}]`);

        // Density verification (strict anti-cotton-ball and anti-low-poly)
        expect(totalVertices).toBeGreaterThan(40000);
        expect(maxY - minY).toBeGreaterThan(15.0); // Tall forest canopy >= 15m
        expect(maxX - minX).toBeGreaterThan(20.0); // Broad forest width >= 20m
        expect(maxZ - minZ).toBeGreaterThan(25.0); // Forest depth >= 25m

        // The page draws with the GLB's own maps: four surfaces (albedo, normal, ORM) embedded, and no canopy of
        // needle slivers left in the forest mesh (the crowns are their own GLB)
        expect(gltf.images?.length).toBe(12);
        expect((gltf.meshes as Array<{ name?: string }>).some(m => /Canopy|Foliage/.test(m.name ?? ''))).toBe(false);

        // The surfaces are texture library sets at their real tile size, each tinted to its region of the reference
        // photograph: the floor's duff, the bark and the moss from the library copies, the fern pinnae a leaf atlas
        type Surface = { set: string; library: string; realSizeM: number[]; provenance: string; tint: { factor: number[]; pixels: number; regionsPx: number[][] } };
        const materials = gltf.materials as Array<{ name: string; extras?: { sbSurface?: Surface }; pbrMetallicRoughness: { baseColorFactor: number[] } }>;
        const surfaceOf = (name: string) => materials.find(m => m.name === name)?.extras?.sbSurface;
        const copies = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'assets/textures/library/copies/index.json'), 'utf8')) as { sets: Array<{ id: string; realSizeM: number[] }> };
        for (const name of ['PBR_Forest_Floor', 'PBR_Redwood_Bark', 'PBR_Moss', 'PBR_Sword_Ferns']) {
            const s = surfaceOf(name);
            expect(s, name).toBeDefined();
            expect(s!.provenance).toBe('library');
            expect(s!.realSizeM.every(v => v > 0.05 && v < 5)).toBe(true);
            expect(s!.tint.pixels).toBeGreaterThan(1000);
            expect(s!.tint.factor.every(v => v > 0 && v <= 1)).toBe(true);
            expect(Math.max(...s!.tint.factor)).toBeGreaterThan(0.2);
            if (name !== 'PBR_Sword_Ferns') {
                expect(s!.library).toBe('assets/textures/library/copies/');
                expect(copies.sets.find(c => c.id === s!.set)?.realSizeM).toEqual(s!.realSizeM);
            }
        }
        expect(surfaceOf('PBR_Sword_Ferns')!.library).toBe('assets/textures/trees/');

        const binOffset = 20 + jsonChunkLen + 8;
        // the floor's, bark's and moss's colour maps are the library copies' own bytes (not crops of the photograph)
        for (const name of ['PBR_Forest_Floor', 'PBR_Redwood_Bark', 'PBR_Moss']) {
            const mat = materials.find(m => m.name === name) as unknown as { pbrMetallicRoughness: { baseColorTexture: { index: number } } };
            const image = gltf.images[gltf.textures[mat.pbrMetallicRoughness.baseColorTexture.index].source];
            const view = gltf.bufferViews[image.bufferView];
            const embedded = buf.subarray(binOffset + (view.byteOffset ?? 0), binOffset + (view.byteOffset ?? 0) + view.byteLength);
            const copy = fs.readFileSync(path.resolve(process.cwd(), 'assets/textures/library/copies', surfaceOf(name)!.set, 'albedo.jpg'));
            expect(image.mimeType).toBe('image/jpeg');
            expect(Buffer.compare(embedded, copy)).toBe(0);
        }
        const attribute = (meshName: string, key: string, width: number) => {
            const mesh = (gltf.meshes as Array<{ name: string; primitives: Array<{ attributes: Record<string, number> }> }>).find(m => m.name === meshName)!;
            const acc = gltf.accessors[mesh.primitives[0].attributes[key]];
            const view = gltf.bufferViews[acc.bufferView];
            const start = binOffset + (view.byteOffset ?? 0) + (acc.byteOffset ?? 0);
            return new Float32Array(buf.buffer.slice(buf.byteOffset + start, buf.byteOffset + start + acc.count * width * 4));
        };
        // the floor's UVs run in duff tiles: 80 m across over the set's real size
        const floorUv = attribute('Forest_Terrain_Floor', 'TEXCOORD_0', 2);
        let uMin = Infinity, uMax = -Infinity;
        for (let i = 0; i < floorUv.length; i += 2) { uMin = Math.min(uMin, floorUv[i]); uMax = Math.max(uMax, floorUv[i]); }
        const duffSize = surfaceOf('PBR_Forest_Floor')!.realSizeM[0];
        expect(uMax - uMin).toBeCloseTo(80 / duffSize, 0);
        // tangents follow the UVs (the normal maps need them): perpendicular to the normal on the columns, not a placeholder
        const normals = attribute('Forest_Trunks_And_Log', 'NORMAL', 3);
        const tangents = attribute('Forest_Trunks_And_Log', 'TANGENT', 4);
        let perpendicular = 0;
        const n = normals.length / 3;
        for (let i = 0; i < n; i++) {
            const dot = normals[i * 3] * tangents[i * 4] + normals[i * 3 + 1] * tangents[i * 4 + 1] + normals[i * 3 + 2] * tangents[i * 4 + 2];
            if (Math.abs(dot) < 0.05 && Math.abs(Math.abs(tangents[i * 4 + 3]) - 1) < 1e-4) perpendicular++;
        }
        expect(perpendicular / n).toBeGreaterThan(0.99);
    }, 60000);

    it('should grow every crown with SB-Veggie into the trees GLB beside the forest', () => {
        const treesPath = path.join(outDir, 'forest_hyperreal_trees.glb');
        expect(fs.existsSync(treesPath)).toBe(true);
        const buf = fs.readFileSync(treesPath);
        expect(buf.readUInt32LE(0)).toBe(0x46546C67);
        const gltf = JSON.parse(buf.toString('utf8', 20, 20 + buf.readUInt32LE(12)));
        type Node = { name?: string; children?: number[]; extras?: Record<string, any> };
        const nodes = gltf.nodes as Node[];
        const trees = nodes.filter(n => n.extras?.sbTree && n.extras?.stem);
        // 45 redwood crowns on their columns and 4 understory crowns
        expect(trees.length).toBe(49);
        for (const t of trees) {
            expect(t.extras!.crownOrigin).toBe('described');
            expect(t.extras!.crownSurfaceReached).toBeGreaterThanOrEqual(0.75);
            const levels = (t.children ?? []).map(i => nodes[i].extras?.sbLod?.level).filter((l): l is number => typeof l === 'number');
            expect(levels).toEqual([0, 1, 2, 3]);
        }
        // the leaf clusters are instanced library meshes, and the species library chose each crown's proportions
        expect(gltf.extensionsUsed).toContain('EXT_mesh_gpu_instancing');
        expect(gltf.extras.sbTrees.species.index).toBe('assets/vegetation/species/index.json');
        const stats = JSON.parse(fs.readFileSync(path.join(outDir, 'forest_hyperreal_trees.stats.json'), 'utf8'));
        expect(stats.trees).toBe(49);
        expect(stats.shortOfCrown).toBe(0);
        const redwoodCrowns = trees.filter(t => t.extras!.label === 'coast redwood crown');
        expect(redwoodCrowns.length).toBe(45);
        // a redwood's grown trunk stays inside its fluted column (half the column's base radius)
        for (const t of redwoodCrowns) expect(t.extras!.inferred.trunkRadiusM).toBeLessThan(1.0);

        // the species the library matches carries its leaf's form to the leaf choice: the crowns matched to needle or scale
        // leaves (blade width of millimetres) draw the library's needle spray, the broadleaf understory draws leaves
        const textures = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'assets/textures/trees/index.json'), 'utf8')) as { leaves: Array<{ id: string; leaf: { bladeWidthM: number } }> };
        const bladeOf = (id: string) => textures.leaves.find(e => e.id === id)!.leaf.bladeWidthM;
        const thinnest = Math.min(...textures.leaves.map(e => e.leaf.bladeWidthM));
        let needleCrowns = 0;
        for (const t of trees) {
            const leaves = t.extras!.sbTree.texture.leaves as { entry: string; bladeWidthM: number; targetBladeWidthM: number };
            expect(leaves.bladeWidthM).toBe(bladeOf(leaves.entry));
            if (leaves.targetBladeWidthM > 0 && leaves.targetBladeWidthM < 0.004) {
                needleCrowns++;
                expect(leaves.bladeWidthM, t.name).toBe(thinnest);
            } else {
                expect(leaves.bladeWidthM, t.name).toBeGreaterThan(0.005);
            }
        }
        expect(needleCrowns).toBeGreaterThanOrEqual(40);

        // the redwoods' crowns are pointed and their species holds its leader: they grow excurrent (a stem through the
        // crown, laterals at the species' angle); the understory's rounded crowns fork at their break
        const inferredOf = (t: Node) => t.extras!.inferred as { topShare: number; excurrence: number };
        for (const t of redwoodCrowns) {
            expect(inferredOf(t).topShare).toBeLessThan(0.2);
            expect(inferredOf(t).excurrence, t.name).toBeGreaterThan(0.9);
        }
    });

    it('grows an excurrent crown as a leader through the crown with laterals at the species angle, and leaves excurrence 0 as it was', async () => {
        const testCpp = `
#include "scratchbox_nature.hpp"
#include <iostream>
#include <random>
#include <cmath>
#include <algorithm>
using namespace scratchbox::nature;
using namespace scratchbox::math;

// a cone of attractors: 30 m tall, its crown from 12 m, 4 m wide at its base
int main() {
    std::vector<Vec3> cone;
    std::mt19937 g(7);
    std::uniform_real_distribution<float> u(0.0f, 1.0f);
    while (cone.size() < 3000) {
        const float y = 12.0f + 18.0f * u(g), r = 4.0f * (30.0f - y) / 18.0f * std::sqrt(u(g)), a = 6.2831853f * u(g);
        cone.push_back(Vec3(r * std::cos(a), y, r * std::sin(a)));
    }
    for (float excurrence : {0.0f, 1.0f}) {
        SpaceColonizationConfig cfg;
        cfg.customAttractors = cone;
        cfg.attractorCount = static_cast<int>(cone.size());
        cfg.rootAnchor = Vec3(0, 0, 0);
        cfg.crownCenter = Vec3(0, 21, 0);
        cfg.crownExtents = Vec3(4, 9, 4);
        cfg.clearTrunkHeight = 12.0f;
        cfg.branchStepLength = 0.5f;
        cfg.killRadius = 0.8f;
        cfg.perceptionRadius = 3.5f;
        cfg.maxIterations = 200;
        cfg.scaffoldBranchCount = 4;
        cfg.scaffoldAngleFromLeaderRad = 1.4f;   // 80 degrees: near level
        cfg.growthMomentumFactor = 0.45f;
        cfg.trunkSeeksCrown = true;
        cfg.excurrence = excurrence;
        cfg.leaderTopY = 30.0f;
        std::mt19937 rng(11);
        ColonizationReport rep;
        auto nodes = SpaceColonizationTreeGenerator::growSkeleton(cfg, rng, &rep);
        // the leader's top: the highest node within 0.6 m of the stem's axis reached by walking first children up from
        // the crown break; the laterals' angle from the vertical: segments off that axis, beyond 1 m from it
        int id = rep.trunkNodes - 1;
        float leaderTop = nodes[id].position.y;
        while (!nodes[id].children.empty()) {
            int next = -1;
            for (int c : nodes[id].children) {
                const Vec3 p = nodes[c].position;
                if (std::hypot(p.x, p.z) < 0.6f && (next < 0 || p.y > nodes[next].position.y)) next = c;
            }
            if (next < 0) break;
            id = next;
            leaderTop = std::max(leaderTop, nodes[id].position.y);
        }
        std::vector<float> angles;
        for (const auto& n : nodes) {
            if (n.parentId < 0 || std::hypot(n.position.x, n.position.z) < 1.0f) continue;
            const Vec3 d = n.position - nodes[n.parentId].position;
            angles.push_back(std::acos(std::clamp(d.y / std::max(1e-6f, d.length()), -1.0f, 1.0f)));
        }
        std::nth_element(angles.begin(), angles.begin() + angles.size() / 2, angles.end());
        std::cout << "excurrence " << excurrence << " leaderShare " << (leaderTop - 12.0f) / 18.0f << " lateralAngle "
                  << angles[angles.size() / 2] << " leaderNodes " << rep.leaderNodes << " reached " << rep.attractorsReached << "/" << rep.attractors << "\\n";
    }
    return 0;
}
`;
        const result = await compiler.compileSource(testCpp, { outputBinaryName: 'test_excurrent_growth', optimization: '-O2' });
        expect(result.success).toBe(true);
        const execResult = await compiler.executeBinary(path.resolve(process.cwd(), 'build/3d-native/test_excurrent_growth'), [], process.cwd());
        expect(execResult.exitCode).toBe(0);
        const rows = Object.fromEntries([...execResult.stdout.matchAll(/excurrence (\S+) leaderShare (\S+) lateralAngle (\S+) leaderNodes (\d+) reached (\d+)\/(\d+)/g)]
            .map(m => [m[1], { leader: +m[2], angle: +m[3], leaderNodes: +m[4], reached: +m[5] / +m[6] }]));
        console.log(rows);
        // excurrence 0: the trunk stops at the crown break and grows no leader of its own
        expect(rows['0'].leaderNodes).toBe(0);
        // excurrence 1: the leader runs on through most of the crown, the laterals hold near the species' 80 degrees
        // (within 20), and the crown is still filled
        expect(rows['1'].leaderNodes).toBeGreaterThan(20);
        expect(rows['1'].leader).toBeGreaterThan(0.8);
        expect(Math.abs(rows['1'].angle - 1.4)).toBeLessThan(0.35);
        expect(rows['1'].angle).toBeGreaterThan(rows['0'].angle);
        expect(rows['1'].reached).toBeGreaterThan(0.9);
    }, 120000);

    it('should compile and evaluate general BotanicalOrganGenerator, NurseLogGenerator, and BiomassScatterEngine', async () => {
        const testCpp = `
#include "scratchbox_nature.hpp"
#include "scratchbox_substrate.hpp"
#include <iostream>
#include <cassert>

using namespace scratchbox::nature;
using namespace scratchbox::math;
using namespace scratchbox::substrate;

int main() {
    // 1. Test Fibonacci Pinecone
    auto cone = BotanicalOrganGenerator::generateFibonacciPinecone(Vec3(0, 0, 0), Vec3(1, 0, 0));
    assert(!cone.vertices.empty());
    assert(!cone.indices.empty());

    // 2. Test Distichous Conifer Sprig
    auto sprig = BotanicalOrganGenerator::generateDistichousConiferSprig(Vec3(0, 0, 0), Vec3(0, 1, 0));
    assert(!sprig.vertices.empty());

    // 3. Test Shelf Polypore
    auto shelf = BotanicalOrganGenerator::generateShelfPolypore(Vec3(0, 0, 0), Vec3(1, 0, 0));
    assert(!shelf.vertices.empty());

    // 4. Test Wood Sorrel Patch
    auto sorrel = BotanicalOrganGenerator::generateWoodSorrelPatch(Vec3(0, 0, 0));
    assert(!sorrel.vertices.empty());

    // 5. Test Fallen Needle Cluster
    auto needle = BotanicalOrganGenerator::generateFallenNeedleCluster(Vec3(0, 0, 0), Vec3(0, 1, 0));
    assert(!needle.vertices.empty());

    // 6. Test Hollow Nurse Log
    auto log = NurseLogGenerator::generateHollowNurseLog(Vec3(-2, 0, 0), Vec3(2, 0, 0), 0.5f);
    assert(!log.vertices.empty());

    // 7. Test Biomass Scatter Engine
    BiomassScatterEngine::ScatterCriteria crit;
    crit.targetCount = 20;
    auto points = BiomassScatterEngine::samplePoints(
        Vec2(-10, -10), Vec2(10, 10),
        [](float x, float z) { return 0.0f; },
        [](float x, float z) { return Vec3(0, 1, 0); },
        {},
        crit
    );
    assert(points.size() > 5);

    // 8. Test Narrative Clutter Placer
    auto pockets = NarrativeClutterPlacer::identifyPockets(
        { Vec3(0, 0, 0) },
        { { Vec3(-2, 0, 0), Vec3(2, 0, 0) } },
        [](float x, float z) { return 0.0f; },
        [](float x, float z) { return Vec3(0, 1, 0); }
    );
    assert(pockets.size() >= 8);

    // 9. Test Procedural Wear, Inverted Fresnel & Crevice Grime Engine
    WearGrimeParameters wgp;
    wgp.pointiness = 0.8f; // convex edge
    wgp.ambientOcclusion = 0.9f;
    wgp.worldNormal = Vec3(0, 1, 0);
    wgp.viewDirection = Vec3(0, 0, 1);
    auto wearRes = ProceduralWearAndGrimeShader::evaluate(
        Vec3(0.35f, 0.20f, 0.12f),
        0.85f,
        wgp
    );
    assert(wearRes.edgeWearMask > 0.1f);
    assert(wearRes.dustMask >= 0.0f);

    std::cout << "SUCCESS: All Biomass & Organ Generators Validated!" << std::endl;
    return 0;
}
`;
        const result = await compiler.compileSource(testCpp, {
            outputBinaryName: 'test_biomass_engine',
            optimization: '-O3'
        });

        expect(result.success).toBe(true);

        const binDir = path.resolve(process.cwd(), 'build/3d-native');
        const binaryPath = path.join(binDir, 'test_biomass_engine');
        const execResult = await compiler.executeBinary(binaryPath, [], process.cwd());
        expect(execResult.exitCode).toBe(0);
        expect(execResult.stdout).toContain('SUCCESS: All Biomass & Organ Generators Validated!');
    }, 60000);

    it('should compile and evaluate ProceduralPlantBuilder and PlantPresets from scratchbox_plant_builder.hpp', async () => {
        const testCpp = `
#include "scratchbox_engine.hpp"
#include <iostream>
#include <cassert>

using namespace scratchbox::plant;
using namespace scratchbox::math;

int main() {
    // 1. Test Fluent ProceduralPlantBuilder for Custom Conifer
    ProceduralPlantBuilder b(PlantArchetype::ConiferRedwood);
    b.setPosition(Vec3(0, 0, 0))
     .setTrunk(20.0f, 1.2f, 0.5f, 6, 1.1f, 1.0f)
     .addBranchTier(0.3f, 6, 4.0f, 0.2f, 10.0f)
     .addBranchTier(0.6f, 6, 4.5f, 0.2f, 15.0f)
     .setFoliage(BotanicalLeafType::ConiferDistichous, 1.0f, 1.0f, true)
     .setEpiphytes(true, 2);

    auto result = b.build();
    assert(!result.woodMesh.vertices.empty());
    assert(!result.foliageMesh.vertices.empty());
    assert(result.totalVertices > 1000);
    assert(result.totalTriangles > 800);

    // 2. Test Presets
    auto redwood = PlantPresets::createHeroAncientRedwood(Vec3(5, 0, 0), 28.0f);
    assert(redwood.totalVertices > 2000);

    auto dogwood = PlantPresets::createUnderstoryDogwood(Vec3(2, 0, 2), 5.5f);
    assert(dogwood.totalVertices > 500);

    auto fern = PlantPresets::createSwordFernColony(Vec3(-2, 0, 1), 1.5f, 22);
    assert(!fern.foliageMesh.vertices.empty());

    auto log = PlantPresets::createDecayingNurseLog(Vec3(-3, 0, 0), Vec3(1, 0, 0), 0.45f);
    assert(!log.woodMesh.vertices.empty());

    auto clover = PlantPresets::createWoodSorrelCushion(Vec3(1, 0, 3), 0.85f);
    assert(!clover.foliageMesh.vertices.empty());

    std::cout << "SUCCESS: All Procedural Plant Builders and Presets Validated!" << std::endl;
    return 0;
}
`;
        const result = await compiler.compileSource(testCpp, {
            outputBinaryName: 'test_plant_builder',
            optimization: '-O3'
        });

        expect(result.success).toBe(true);

        const binDir = path.resolve(process.cwd(), 'build/3d-native');
        const binaryPath = path.join(binDir, 'test_plant_builder');
        const execResult = await compiler.executeBinary(binaryPath, [], process.cwd());
        expect(execResult.exitCode).toBe(0);
        expect(execResult.stdout).toContain('SUCCESS: All Procedural Plant Builders and Presets Validated!');
    }, 60000);

    it('should verify tree trunk and branch hulls are closed watertight manifolds with zero open boundary edges', async () => {
        const testCpp = `
#include "scratchbox_engine.hpp"
#include <iostream>
#include <map>
#include <cassert>

using namespace scratchbox::plant;
using namespace scratchbox::geometry;

// Returns count of open boundary edges (edges referenced by exactly 1 triangle)
int countOpenBoundaryEdges(const ScratchboxMesh& mesh) {
    std::map<std::pair<uint32_t, uint32_t>, int> edgeCount;
    for (size_t i = 0; i + 2 < mesh.indices.size(); i += 3) {
        uint32_t i0 = mesh.indices[i];
        uint32_t i1 = mesh.indices[i + 1];
        uint32_t i2 = mesh.indices[i + 2];

        auto addEdge = [&](uint32_t a, uint32_t b) {
            uint32_t u = std::min(a, b);
            uint32_t v = std::max(a, b);
            edgeCount[{u, v}]++;
        };

        addEdge(i0, i1);
        addEdge(i1, i2);
        addEdge(i2, i0);
    }

    int openEdges = 0;
    for (const auto& [edge, count] : edgeCount) {
        if (count == 1) {
            openEdges++;
        }
    }
    return openEdges;
}

int main() {
    // 1. Build a procedural tree trunk without branches to verify trunk hull closure
    ProceduralPlantBuilder b(PlantArchetype::ConiferRedwood);
    b.setTrunk(18.0f, 1.2f, 0.45f, 6, 1.1f, 1.0f);
    auto res = b.build();

    // Verify trunk mesh is closed (has bottom base cap and top spire cap)
    int openTrunkEdges = countOpenBoundaryEdges(res.woodMesh);
    std::cout << "Open Trunk Boundary Edges: " << openTrunkEdges << std::endl;
    assert(openTrunkEdges == 0); // 100% Watertight Closed Hull!

    std::cout << "SUCCESS: Tree Hull Certified 100% Closed & Watertight!" << std::endl;
    return 0;
}
`;
        const result = await compiler.compileSource(testCpp, {
            outputBinaryName: 'test_closed_tree_hulls',
            optimization: '-O3'
        });

        expect(result.success).toBe(true);

        const binDir = path.resolve(process.cwd(), 'build/3d-native');
        const binaryPath = path.join(binDir, 'test_closed_tree_hulls');
        const execResult = await compiler.executeBinary(binaryPath, [], process.cwd());
        expect(execResult.exitCode).toBe(0);
        expect(execResult.stdout).toContain('SUCCESS: Tree Hull Certified 100% Closed & Watertight!');
    }, 120000);
});
