const fs = require('fs');
const path = require('path');

// Read GLB header and chunk 0 (JSON)
const glbPath = path.join(process.cwd(), 'public/models/google_tiles_textured_area.glb');
const buf = fs.readFileSync(glbPath);

const magic = buf.readUInt32LE(0);
const version = buf.readUInt32LE(4);
const length = buf.readUInt32LE(8);
const jsonChunkLen = buf.readUInt32LE(12);
const jsonChunkType = buf.readUInt32LE(16);

const jsonStr = buf.toString('utf8', 20, 20 + jsonChunkLen);
const gltf = JSON.parse(jsonStr);

console.log('GLB Header:', { magic: magic.toString(16), version, length, jsonChunkLen });
console.log('Accessors count:', gltf.accessors?.length);
console.log('Nodes count:', gltf.nodes?.length);

// Find POSITION accessors min/max
if (gltf.accessors) {
  gltf.accessors.forEach((acc, i) => {
    if (acc.min && acc.max && acc.type === 'VEC3') {
      const [minX, minY, minZ] = acc.min;
      const [maxX, maxY, maxZ] = acc.max;
      if (maxX > -100 && minX < 100 && maxZ > -100 && minZ < 100) {
        console.log(`Accessor ${i} near origin: X=[${minX.toFixed(1)}, ${maxX.toFixed(1)}], Y=[${minY.toFixed(1)}, ${maxY.toFixed(1)}], Z=[${minZ.toFixed(1)}, ${maxZ.toFixed(1)}]`);
      }
    }
  });
}
