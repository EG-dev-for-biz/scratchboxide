const fs = require('fs');
const path = require('path');

const glbBuf = fs.readFileSync('public/models/colosseum_rome_pristine_leaf_raw.glb');
const jsonLen = glbBuf.readUInt32LE(12);
const gltf = JSON.parse(glbBuf.toString('utf8', 20, 20 + jsonLen));
const binOffset = 20 + jsonLen + 8;

console.log(`Analyzing ${gltf.meshes.length} primitives...`);

let totalVerts = 0;
let minY = Infinity, maxY = -Infinity;
let minX = Infinity, maxX = -Infinity;
let minZ = Infinity, maxZ = -Infinity;

for (const mesh of gltf.meshes) {
    for (const prim of mesh.primitives) {
        if (prim.attributes.POSITION !== undefined) {
            const acc = gltf.accessors[prim.attributes.POSITION];
            const bv = gltf.bufferViews[acc.bufferView];
            const byteOffset = binOffset + (bv.byteOffset || 0) + (acc.byteOffset || 0);
            const posArr = new Float32Array(glbBuf.buffer, glbBuf.byteOffset + byteOffset, acc.count * 3);
            for (let i = 0; i < acc.count; i++) {
                totalVerts++;
                const x = posArr[i * 3];
                const y = posArr[i * 3 + 1];
                const z = posArr[i * 3 + 2];
                if (x < minX) minX = x; if (x > maxX) maxX = x;
                if (y < minY) minY = y; if (y > maxY) maxY = y;
                if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
            }
        }
    }
}

console.log(`Total vertices: ${totalVerts.toLocaleString()}`);
console.log(`Bounds: X [${minX.toFixed(1)}, ${maxX.toFixed(1)}], Y [${minY.toFixed(1)}, ${maxY.toFixed(1)}], Z [${minZ.toFixed(1)}, ${maxZ.toFixed(1)}]`);

