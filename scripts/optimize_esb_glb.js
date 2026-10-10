const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

function optimizeGlb(inputPath, outputPath) {
    console.log(`[OptimizeGLB] Reading: ${inputPath}...`);
    const inputBuf = fs.readFileSync(inputPath);
    
    // Parse GLB Header
    const magic = inputBuf.readUInt32LE(0);
    const version = inputBuf.readUInt32LE(4);
    const length = inputBuf.readUInt32LE(8);
    
    const jsonLen = inputBuf.readUInt32LE(12);
    const jsonType = inputBuf.readUInt32LE(16);
    const jsonStr = inputBuf.toString('utf8', 20, 20 + jsonLen);
    const gltf = JSON.parse(jsonStr);
    
    const binHeaderOffset = 20 + jsonLen;
    const binLen = inputBuf.readUInt32LE(binHeaderOffset);
    const binDataOffset = binHeaderOffset + 8;
    const binBuf = inputBuf.subarray(binDataOffset, binDataOffset + binLen);
    
    console.log(`[OptimizeGLB] GLTF contains ${gltf.images ? gltf.images.length : 0} images, ${gltf.materials ? gltf.materials.length : 0} materials`);
    
    // Create temporary work dir
    const tmpDir = path.join('/tmp', 'glb_opt_' + Date.now());
    fs.mkdirSync(tmpDir, { recursive: true });
    
    // Process images
    const newImageBuffers = [];
    const newBufferViews = [];
    
    // First, copy all existing non-image buffer views into a base binary buffer
    // Find all bufferViews that are NOT used by images
    const imageBufferViewIndices = new Set((gltf.images || []).map(img => img.bufferView));
    
    let currentNewBinOffset = 0;
    const binChunks = [];
    
    // Re-map geometry buffer views
    const bufferViewMap = new Map();
    gltf.bufferViews.forEach((bv, oldIndex) => {
        if (!imageBufferViewIndices.has(oldIndex)) {
            const data = binBuf.subarray(bv.byteOffset || 0, (bv.byteOffset || 0) + bv.byteLength);
            // Pad to 4 bytes
            const padLen = (4 - (data.length % 4)) % 4;
            const paddedChunk = Buffer.concat([data, Buffer.alloc(padLen)]);
            
            const newBv = {
                buffer: 0,
                byteOffset: currentNewBinOffset,
                byteLength: bv.byteLength
            };
            if (bv.byteStride !== undefined) newBv.byteStride = bv.byteStride;
            if (bv.target !== undefined) newBv.target = bv.target;
            
            bufferViewMap.set(oldIndex, newBufferViews.length);
            newBufferViews.push(newBv);
            binChunks.push(paddedChunk);
            currentNewBinOffset += paddedChunk.length;
        }
    });
    
    // Update accessors to use new bufferView indices
    if (gltf.accessors) {
        gltf.accessors.forEach(acc => {
            if (acc.bufferView !== undefined && bufferViewMap.has(acc.bufferView)) {
                acc.bufferView = bufferViewMap.get(acc.bufferView);
            }
        });
    }
    
    // Process and compress each image
    if (gltf.images) {
        gltf.images.forEach((img, imgIdx) => {
            const oldBv = gltf.bufferViews[img.bufferView];
            const rawImgData = binBuf.subarray(oldBv.byteOffset || 0, (oldBv.byteOffset || 0) + oldBv.byteLength);
            
            const inImgPath = path.join(tmpDir, `img_${imgIdx}.png`);
            fs.writeFileSync(inImgPath, rawImgData);
            
            // Check if this image is a normal map
            const isNormal = (imgIdx % 3 === 1) || (img.name && img.name.includes('Normal'));
            let outImgPath;
            let mimeType;
            
            if (isNormal) {
                // Lossless compressed PNG via macOS ImageIO (sips)
                outImgPath = path.join(tmpDir, `img_${imgIdx}_opt.png`);
                execSync(`sips -s format png "${inImgPath}" --out "${outImgPath}" >/dev/null 2>&1`);
                mimeType = 'image/png';
            } else {
                // High-quality JPEG (quality 92) via macOS ImageIO (sips)
                outImgPath = path.join(tmpDir, `img_${imgIdx}_opt.jpg`);
                execSync(`sips -s format jpeg -s formatOptions 92 "${inImgPath}" --out "${outImgPath}" >/dev/null 2>&1`);
                mimeType = 'image/jpeg';
            }
            
            const compressedData = fs.readFileSync(outImgPath);
            const padLen = (4 - (compressedData.length % 4)) % 4;
            const paddedImg = Buffer.concat([compressedData, Buffer.alloc(padLen)]);
            
            const newBvIndex = newBufferViews.length;
            newBufferViews.push({
                buffer: 0,
                byteOffset: currentNewBinOffset,
                byteLength: compressedData.length
            });
            
            img.bufferView = newBvIndex;
            img.mimeType = mimeType;
            
            binChunks.push(paddedImg);
            currentNewBinOffset += paddedImg.length;
            
            console.log(`[OptimizeGLB] Image ${imgIdx} (${mimeType}) ${(rawImgData.length / 1024 / 1024).toFixed(1)}MB -> ${(compressedData.length / 1024).toFixed(0)}KB`);
        });
    }
    
    // Assemble final binary chunk
    const totalBinBuf = Buffer.concat(binChunks);
    
    // Update GLTF root
    gltf.bufferViews = newBufferViews;
    gltf.buffers = [{ byteLength: totalBinBuf.length }];
    
    const newJsonStr = JSON.stringify(gltf);
    let newJsonBuf = Buffer.from(newJsonStr, 'utf8');
    const jsonPadLen = (4 - (newJsonBuf.length % 4)) % 4;
    if (jsonPadLen > 0) {
        newJsonBuf = Buffer.concat([newJsonBuf, Buffer.from(' '.repeat(jsonPadLen), 'utf8')]);
    }
    
    const totalFileSize = 12 + 8 + newJsonBuf.length + 8 + totalBinBuf.length;
    
    const outHeader = Buffer.alloc(12);
    outHeader.writeUInt32LE(0x46546C67, 0); // 'glTF'
    outHeader.writeUInt32LE(2, 4);          // version 2
    outHeader.writeUInt32LE(totalFileSize, 8);
    
    const jsonHeader = Buffer.alloc(8);
    jsonHeader.writeUInt32LE(newJsonBuf.length, 0);
    jsonHeader.writeUInt32LE(0x4E4F534A, 4); // 'JSON'
    
    const binHeader = Buffer.alloc(8);
    binHeader.writeUInt32LE(totalBinBuf.length, 0);
    binHeader.writeUInt32LE(0x004E4942, 4); // 'BIN\0'
    
    const finalGlb = Buffer.concat([outHeader, jsonHeader, newJsonBuf, binHeader, totalBinBuf]);
    fs.writeFileSync(outputPath, finalGlb);
    
    // Clean up tmp dir
    fs.rmSync(tmpDir, { recursive: true, force: true });
    
    console.log(`[OptimizeGLB] Successfully wrote optimized GLB: ${outputPath} (${(finalGlb.length / 1024 / 1024).toFixed(2)} MB)`);
}

const input = process.argv[2] || 'public/models/empire_state_building_pbr_textured.glb';
const output = process.argv[3] || 'public/models/omnispatial_real_stage3_streetview_pbr.glb';
optimizeGlb(input, output);
