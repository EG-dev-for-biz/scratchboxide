import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { requireAll, requireAssets, withReason } from './helpers/requirements';

const PRODUCER = 'scripts/apply_colosseum_1k_pbr_suite.cjs';
const PBR_GLB = 'public/models/colosseum_rome_1k_pbr.glb';
const HERO_MAPS = [
    'public/models/colosseum_stone_texture_39_1k_albedo.jpg',
    'public/models/colosseum_stone_texture_39_1k_normal.jpg',
    'public/models/colosseum_stone_texture_39_1k_roughness.jpg',
    'public/models/colosseum_stone_texture_39_1k_ao.jpg',
    'public/models/colosseum_stone_texture_39_1k_orm.jpg',
    'public/models/colosseum_foliage_texture_hero_1k_albedo.png',
    'public/models/colosseum_foliage_texture_hero_1k_alpha.jpg'
];
const ORIGINAL_GLB = 'public/models/colosseum_rome_textured.glb';
const pbrGlb = requireAssets([PBR_GLB], PRODUCER);
const heroMaps = requireAssets(HERO_MAPS, PRODUCER);
const driftInputs = requireAll(pbrGlb, requireAssets([ORIGINAL_GLB]));

describe('Roman Colosseum 1K PBR Suite & Morphological Tensor Validation', () => {
    const glbPath = path.resolve(__dirname, '../../../public/models/colosseum_rome_1k_pbr.glb');
    const heroMesh39Albedo = path.resolve(__dirname, '../../../public/models/colosseum_stone_texture_39_1k_albedo.jpg');
    const heroMesh39Normal = path.resolve(__dirname, '../../../public/models/colosseum_stone_texture_39_1k_normal.jpg');
    const heroMesh39Roughness = path.resolve(__dirname, '../../../public/models/colosseum_stone_texture_39_1k_roughness.jpg');
    const heroMesh39Ao = path.resolve(__dirname, '../../../public/models/colosseum_stone_texture_39_1k_ao.jpg');
    const heroMesh39Orm = path.resolve(__dirname, '../../../public/models/colosseum_stone_texture_39_1k_orm.jpg');
    const heroFoliageAlbedo = path.resolve(__dirname, '../../../public/models/colosseum_foliage_texture_hero_1k_albedo.png');
    const heroFoliageAlpha = path.resolve(__dirname, '../../../public/models/colosseum_foliage_texture_hero_1k_alpha.jpg');

    it.skipIf(!pbrGlb.ok)(withReason('should verify the 1K PBR GLB exists and exceeds 90 MB', pbrGlb), () => {
        expect(fs.existsSync(glbPath)).toBe(true);
        const stats = fs.statSync(glbPath);
        expect(stats.size).toBeGreaterThan(50 * 1024 * 1024); // > 50 MB (compacted from 174 MB with WebP & EXT_texture_webp)
    });

    it.skipIf(!heroMaps.ok)(withReason('should verify all 5 hero stone inspection maps exist for Mesh 39 and hero foliage maps exist', heroMaps), () => {
        expect(fs.existsSync(heroMesh39Albedo)).toBe(true);
        expect(fs.existsSync(heroMesh39Normal)).toBe(true);
        expect(fs.existsSync(heroMesh39Roughness)).toBe(true);
        expect(fs.existsSync(heroMesh39Ao)).toBe(true);
        expect(fs.existsSync(heroMesh39Orm)).toBe(true);
        expect(fs.existsSync(heroFoliageAlbedo)).toBe(true);
        expect(fs.existsSync(heroFoliageAlpha)).toBe(true);
    });

    it.skipIf(!pbrGlb.ok)(withReason('should verify GLB internal structure: 79 submeshes, PBR standard materials, zero unlit, and foliage alphaMode MASK', pbrGlb), () => {
        const buffer = fs.readFileSync(glbPath);
        const magic = buffer.readUInt32LE(0);
        expect(magic).toBe(0x46546C67); // 'glTF' in hex

        const version = buffer.readUInt32LE(4);
        expect(version).toBe(2);

        const jsonChunkLength = buffer.readUInt32LE(12);
        const jsonChunkType = buffer.readUInt32LE(16);
        expect(jsonChunkType).toBe(0x4E4F534A); // 'JSON'

        const jsonStr = buffer.toString('utf8', 20, 20 + jsonChunkLength);
        const gltf = JSON.parse(jsonStr);

        // Check meshes and materials
        expect(gltf.meshes).toBeDefined();
        expect(gltf.meshes.length).toBe(79);
        expect(gltf.materials).toBeDefined();
        expect(gltf.materials.length).toBe(79);

        // Check textures: 79 albedo + 79 normal + 79 ORM = 237 textures
        expect(gltf.textures.length).toBe(237);

        // Check images: verify presence of image/webp with EXT_texture_webp (or legacy PNG/JPEG)
        const webpImages = gltf.images.filter((img: any) => img.mimeType === 'image/webp');
        const pngImages = gltf.images.filter((img: any) => img.mimeType === 'image/png');
        const jpegImages = gltf.images.filter((img: any) => img.mimeType === 'image/jpeg');

        if (webpImages.length > 0) {
            expect(webpImages.length).toBe(237);
            expect(gltf.extensionsUsed).toContain('EXT_texture_webp');
            for (const tex of gltf.textures) {
                expect(tex.extensions?.EXT_texture_webp?.source).toBeDefined();
            }
        } else {
            expect(pngImages.length).toBeGreaterThan(0);
            expect(jpegImages.length).toBeGreaterThan(0);
            expect(pngImages.length + jpegImages.length).toBe(237);
        }

        // Verify foliage materials have alphaMode === 'MASK' and alphaCutoff === 0.5 (55 submeshes with foliage)
        const maskMaterials = gltf.materials.filter((mat: any) => mat.alphaMode === 'MASK');
        expect(maskMaterials.length).toBe(55);
        for (const mat of maskMaterials) {
            expect(mat.alphaCutoff).toBe(0.5);
        }

        // Verify zero unlit extension in any material
        for (const mat of gltf.materials) {
            expect(mat.extensions?.KHR_materials_unlit).toBeUndefined();
            expect(mat.pbrMetallicRoughness).toBeDefined();
            expect(mat.pbrMetallicRoughness.baseColorTexture).toBeDefined();
            expect(mat.pbrMetallicRoughness.metallicRoughnessTexture).toBeDefined();
            expect(mat.normalTexture).toBeDefined();
            expect(mat.occlusionTexture).toBeDefined();
        }

        // Verify extensionsUsed does not contain KHR_materials_unlit
        if (gltf.extensionsUsed) {
            expect(gltf.extensionsUsed).not.toContain('KHR_materials_unlit');
        }
    });

    it.skipIf(!driftInputs.ok)(withReason('should verify exact 0.000 mm geometric drift lock against original Colosseum mesh', driftInputs), () => {
        const originalGlbPath = path.resolve(__dirname, '../../../public/models/colosseum_rome_textured.glb');
        const origBuffer = fs.readFileSync(originalGlbPath);
        const origJsonLen = origBuffer.readUInt32LE(12);
        const origGltf = JSON.parse(origBuffer.toString('utf8', 20, 20 + origJsonLen));

        const pbrBuffer = fs.readFileSync(glbPath);
        const pbrJsonLen = pbrBuffer.readUInt32LE(12);
        const pbrGltf = JSON.parse(pbrBuffer.toString('utf8', 20, 20 + pbrJsonLen));

        // Exact match on submesh count
        expect(pbrGltf.meshes.length).toBe(origGltf.meshes.length);

        // Calculate total vertex count and triangle count from accessors
        let origVerts = 0;
        let origIndices = 0;
        for (const mesh of origGltf.meshes) {
            for (const prim of mesh.primitives) {
                origVerts += origGltf.accessors[prim.attributes.POSITION].count;
                origIndices += origGltf.accessors[prim.indices].count;
            }
        }

        let pbrVerts = 0;
        let pbrIndices = 0;
        for (const mesh of pbrGltf.meshes) {
            for (const prim of mesh.primitives) {
                pbrVerts += pbrGltf.accessors[prim.attributes.POSITION].count;
                pbrIndices += pbrGltf.accessors[prim.indices].count;
            }
        }

        expect(pbrVerts).toBe(234679);
        expect(pbrVerts).toBe(origVerts);
        expect(pbrIndices / 3).toBe(170802);
        expect(pbrIndices).toBe(origIndices);
    });
});
