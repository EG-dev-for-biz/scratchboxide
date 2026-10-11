const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

async function runMasterPbrPipeline() {
    const baseGlbPath = path.resolve('public/models/colosseum_stage3_master_base.glb');
    const outGlbPath = path.resolve('public/models/colosseum_stage3_master_pbr.glb');
    const batchExe = path.resolve('scripts/pbr_texture_batch');

    console.log(`[Master PBR Pipeline] Ingesting base harmonized GLB: ${baseGlbPath}...`);
    const glbBuf = fs.readFileSync(baseGlbPath);
    const jsonLen = glbBuf.readUInt32LE(12);
    const gltf = JSON.parse(glbBuf.toString('utf8', 20, 20 + jsonLen));

    const binOffset = 20 + jsonLen;
    const binChunkLen = glbBuf.readUInt32LE(binOffset);
    const binBuf = glbBuf.subarray(binOffset + 8, binOffset + 8 + binChunkLen);

    console.log(`[Master PBR Pipeline] Base GLB has ${gltf.meshes.length} meshes, ${gltf.images.length} images, ${gltf.materials.length} materials.`);

    // 252 base tile images
    const numBaseTiles = 252;
    const tempInDir = path.resolve('.scratchbox/pbr_in');
    const tempOutDir = path.resolve('.scratchbox/pbr_out');
    fs.mkdirSync(tempInDir, { recursive: true });
    fs.mkdirSync(tempOutDir, { recursive: true });

    console.log(`[Master PBR Pipeline] Unpacking ${numBaseTiles} base tile textures to ${tempInDir}...`);
    for (let i = 0; i < numBaseTiles; i++) {
        const img = gltf.images[i];
        const bv = gltf.bufferViews[img.bufferView];
        const imgBuf = binBuf.subarray(bv.byteOffset, bv.byteOffset + bv.byteLength);
        fs.writeFileSync(path.join(tempInDir, `img_${i}.jpg`), imgBuf);
    }

    console.log(`[Master PBR Pipeline] Running native C++ Apple ImageIO PBR batch kernel...`);
    const t0 = Date.now();
    execFileSync(batchExe, [tempInDir, tempOutDir, String(numBaseTiles)], { stdio: 'inherit' });
    console.log(`[Master PBR Pipeline] Batch kernel completed in ${Date.now() - t0}ms.`);

    // Now re-assemble GLB
    // We will build a new buffer chunk
    // First, keep all bufferViews that are NOT images, or keep existing bufferViews and append new images!
    console.log(`[Master PBR Pipeline] Rebuilding glTF buffer views and material PBR bindings...`);

    // Let us clone the binary buffer and append the new textures
    const newBufferChunks = [binBuf];
    let currentOffset = binBuf.length;

    // Pad buffer to 4 bytes
    const padBin = (buf) => {
        const pad = (4 - (buf.length % 4)) % 4;
        return pad > 0 ? Buffer.concat([buf, Buffer.alloc(pad, 0)]) : buf;
    };

    // Helper to add image buffer to glTF
    function addImageBuffer(imgData, mimeType = 'image/jpeg') {
        const paddedData = padBin(imgData);
        const bvIndex = gltf.bufferViews.length;
        gltf.bufferViews.push({
            buffer: 0,
            byteOffset: currentOffset,
            byteLength: imgData.length // byteLength of actual image
        });
        currentOffset += paddedData.length;
        newBufferChunks.push(paddedData);

        const imgIndex = gltf.images.length;
        gltf.images.push({
            bufferView: bvIndex,
            mimeType: mimeType
        });

        const texIndex = gltf.textures.length;
        gltf.textures.push({
            source: imgIndex
        });

        return texIndex;
    }

    // Replace the base image buffer with the de-lighted image
    for (let i = 0; i < numBaseTiles; i++) {
        const delightedPath = path.join(tempOutDir, `delighted_${i}.jpg`);
        const delightedBuf = fs.readFileSync(delightedPath);
        const delightedTexIdx = addImageBuffer(delightedBuf);

        const normPath = path.join(tempOutDir, `norm_${i}.jpg`);
        const normBuf = fs.readFileSync(normPath);
        const normTexIdx = addImageBuffer(normBuf);

        const ormPath = path.join(tempOutDir, `orm_${i}.jpg`);
        const ormBuf = fs.readFileSync(ormPath);
        const ormTexIdx = addImageBuffer(ormBuf);

        // Bind to material i
        const mat = gltf.materials[i];
        if (mat) {
            mat.pbrMetallicRoughness = mat.pbrMetallicRoughness || {};
            mat.pbrMetallicRoughness.baseColorTexture = { index: delightedTexIdx };
            mat.pbrMetallicRoughness.metallicRoughnessTexture = { index: ormTexIdx };
            mat.pbrMetallicRoughness.roughnessFactor = 1.0;
            mat.pbrMetallicRoughness.metallicFactor = 0.0;

            mat.normalTexture = {
                index: normTexIdx,
                scale: 1.2
            };

            mat.occlusionTexture = {
                index: ormTexIdx,
                strength: 1.0
            };

            if (mat.extensions) {
                delete mat.extensions.KHR_materials_unlit;
                if (Object.keys(mat.extensions).length === 0) delete mat.extensions;
            }
        }
    }

    if (gltf.extensionsUsed) {
        gltf.extensionsUsed = gltf.extensionsUsed.filter(e => e !== 'KHR_materials_unlit');
        if (gltf.extensionsUsed.length === 0) delete gltf.extensionsUsed;
    }
    if (gltf.extensionsRequired) {
        gltf.extensionsRequired = gltf.extensionsRequired.filter(e => e !== 'KHR_materials_unlit');
        if (gltf.extensionsRequired.length === 0) delete gltf.extensionsRequired;
    }

    gltf.buffers[0].byteLength = currentOffset;

    // Serialize new GLB
    const newJsonStr = JSON.stringify(gltf);
    const newJsonBuf = Buffer.from(newJsonStr, 'utf8');
    const jsonPad = (4 - (newJsonBuf.length % 4)) % 4;
    const finalJsonBuf = jsonPad > 0 ? Buffer.concat([newJsonBuf, Buffer.alloc(jsonPad, 0x20)]) : newJsonBuf;

    const totalBinChunk = Buffer.concat(newBufferChunks);

    const header = Buffer.alloc(12);
    header.writeUInt32LE(0x46546C67, 0); // 'glTF'
    header.writeUInt32LE(2, 4);
    const totalGlbLen = 12 + 8 + finalJsonBuf.length + 8 + totalBinChunk.length;
    header.writeUInt32LE(totalGlbLen, 8);

    const jsonHeader = Buffer.alloc(8);
    jsonHeader.writeUInt32LE(finalJsonBuf.length, 0);
    jsonHeader.writeUInt32LE(0x4E4F534A, 4); // 'JSON'

    const binHeader = Buffer.alloc(8);
    binHeader.writeUInt32LE(totalBinChunk.length, 0);
    binHeader.writeUInt32LE(0x004E4942, 4); // 'BIN\0'

    const finalGlb = Buffer.concat([header, jsonHeader, finalJsonBuf, binHeader, totalBinChunk]);
    fs.writeFileSync(outGlbPath, finalGlb);

    console.log(`[Master PBR Pipeline] Successfully compiled Master PBR Suite GLB!`);
    console.log(`  Output: ${outGlbPath}`);
    console.log(`  Size: ${(finalGlb.length / (1024 * 1024)).toFixed(2)} MB`);
    console.log(`  Total Images in glTF: ${gltf.images.length}`);
    console.log(`  Total Textures in glTF: ${gltf.textures.length}`);
    console.log(`  Total Materials bound: ${numBaseTiles}`);

    // Cleanup temp dirs
    fs.rmSync(tempInDir, { recursive: true, force: true });
    fs.rmSync(tempOutDir, { recursive: true, force: true });
}

runMasterPbrPipeline().catch(err => {
    console.error('Master PBR Pipeline error:', err);
    process.exit(1);
});
