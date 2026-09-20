const fs = require('fs');
const path = require('path');

const glbPath = path.resolve('public/models/colosseum_rome_textured.glb');
const glbBuffer = fs.readFileSync(glbPath);

const jsonLen = glbBuffer.readUInt32LE(12);
const jsonStr = glbBuffer.toString('utf8', 20, 20 + jsonLen);
const gltf = JSON.parse(jsonStr);

const binOffset = 20 + jsonLen;
const binChunkLen = glbBuffer.readUInt32LE(binOffset);
const binBuffer = glbBuffer.subarray(binOffset + 8, binOffset + 8 + binChunkLen);

function getAccessorData(accIndex) {
  const acc = gltf.accessors[accIndex];
  const bv = gltf.bufferViews[acc.bufferView];
  const offset = (bv.byteOffset || 0) + (acc.byteOffset || 0);
  const count = acc.count;
  if (acc.componentType === 5126) {
    const numComponents = acc.type === 'VEC3' ? 3 : acc.type === 'VEC2' ? 2 : 1;
    return new Float32Array(binBuffer.buffer, binBuffer.byteOffset + offset, count * numComponents);
  } else if (acc.componentType === 5123) {
    return new Uint16Array(binBuffer.buffer, binBuffer.byteOffset + offset, count);
  } else if (acc.componentType === 5125) {
    return new Uint32Array(binBuffer.buffer, binBuffer.byteOffset + offset, count);
  }
}

const targetMeshIndex = 39;
const prim = gltf.meshes[targetMeshIndex].primitives[0];
const positions = getAccessorData(prim.attributes.POSITION);
const uvs = getAccessorData(prim.attributes.TEXCOORD_0);
const indices = getAccessorData(prim.indices);

const numTris = indices.length / 3;
const parent = new Int32Array(numTris);
for (let i = 0; i < numTris; i++) parent[i] = i;
function find(i) {
  while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
  return i;
}
function union(i, j) {
  const rootI = find(i), rootJ = find(j);
  if (rootI !== rootJ) parent[rootI] = rootJ;
}

// Group by UV vertices
const uvMap = new Map();
const UV_GRID_RES = 4096;
for (let t = 0; t < numTris; t++) {
  for (let c = 0; c < 3; c++) {
    const vIdx = indices[t * 3 + c];
    const u = Math.round(uvs[vIdx * 2] * UV_GRID_RES);
    const v = Math.round(uvs[vIdx * 2 + 1] * UV_GRID_RES);
    const key = `${u}_${v}`;
    if (!uvMap.has(key)) uvMap.set(key, []);
    uvMap.get(key).push(t);
  }
}
for (const tris of uvMap.values()) {
  for (let i = 1; i < tris.length; i++) {
    union(tris[0], tris[i]);
  }
}

const islands = new Map();
for (let t = 0; t < numTris; t++) {
  const root = find(t);
  if (!islands.has(root)) islands.set(root, []);
  islands.get(root).push(t);
}

const sortedIslands = Array.from(islands.entries())
  .map(([rootId, triList]) => {
    let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
    let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity, zMin = Infinity, zMax = -Infinity;
    let normX = 0, normY = 0, normZ = 0;
    let totalArea3D = 0;

    for (const t of triList) {
      const i0 = indices[t * 3], i1 = indices[t * 3 + 1], i2 = indices[t * 3 + 2];
      for (const vIdx of [i0, i1, i2]) {
        const u = uvs[vIdx * 2], v = uvs[vIdx * 2 + 1];
        if (u < uMin) uMin = u; if (u > uMax) uMax = u;
        if (v < vMin) vMin = v; if (v > vMax) vMax = v;

        const x = positions[vIdx * 3], y = positions[vIdx * 3 + 1], z = positions[vIdx * 3 + 2];
        if (x < xMin) xMin = x; if (x > xMax) xMax = x;
        if (y < yMin) yMin = y; if (y > yMax) yMax = y;
        if (z < zMin) zMin = z; if (z > zMax) zMax = z;
      }

      const ax = positions[i1*3] - positions[i0*3], ay = positions[i1*3+1] - positions[i0*3+1], az = positions[i1*3+2] - positions[i0*3+2];
      const bx = positions[i2*3] - positions[i0*3], by = positions[i2*3+1] - positions[i0*3+1], bz = positions[i2*3+2] - positions[i0*3+2];
      const nx = ay*bz - az*by, ny = az*bx - ax*bz, nz = ax*by - ay*bx;
      const triArea = 0.5 * Math.hypot(nx, ny, nz);
      totalArea3D += triArea;
      normX += nx; normY += ny; normZ += nz;
    }

    const len = Math.hypot(normX, normY, normZ) || 1;
    const avgN = [normX / len, normY / len, normZ / len];

    // Classification based on Normal Vector
    let classification = 'Slanted / Facet';
    let architecturalRole = 'Facade stone';
    if (avgN[1] > 0.6) {
      classification = 'Horizontal Ledge / Shelf (Facing Up)';
      architecturalRole = 'Cornice / Entablature Upper Shelf (Catches sunlight and dust)';
    } else if (avgN[1] < -0.6) {
      classification = 'Downward Ceiling / Arch Soffit (Facing Down)';
      architecturalRole = 'Arch Barrel Vault Ceiling (Cast in deep shadow / ambient occlusion)';
    } else {
      classification = 'Vertical Wall (Facade)';
      architecturalRole = 'Outer Arcade Ashlar Wall (Stacked horizontal Roman stone blocks)';
    }

    const widthMeters = Math.hypot(xMax - xMin, zMax - zMin);
    const heightMeters = yMax - yMin;

    return {
      islandRootId: rootId,
      triangleCount: triList.length,
      area3DMetersSq: parseFloat(totalArea3D.toFixed(2)),
      physicalDimensions: {
        widthMeters: parseFloat(widthMeters.toFixed(2)),
        heightMeters: parseFloat(heightMeters.toFixed(2)),
        elevationRangeY: [parseFloat(yMin.toFixed(2)), parseFloat(yMax.toFixed(2))]
      },
      uvBounds: {
        uMin: parseFloat(uMin.toFixed(4)),
        vMin: parseFloat(vMin.toFixed(4)),
        uMax: parseFloat(uMax.toFixed(4)),
        vMax: parseFloat(vMax.toFixed(4))
      },
      uvPixelBounds2048: {
        xMin: Math.round(uMin * 2048),
        yMin: Math.round((1 - vMax) * 2048),
        xMax: Math.round(uMax * 2048),
        yMax: Math.round((1 - vMin) * 2048)
      },
      avgNormal: avgN.map(n => parseFloat(n.toFixed(3))),
      classification,
      architecturalRole
    };
  })
  .sort((a, b) => b.triangleCount - a.triangleCount);

const profile = {
  meshIndex: targetMeshIndex,
  totalVertices: positions.length / 3,
  totalTriangles: numTris,
  totalIslands: sortedIslands.length,
  dominantIslands: sortedIslands.slice(0, 15)
};

fs.writeFileSync('public/models/mesh39_geometric_profile.json', JSON.stringify(profile, null, 2));
console.log('Successfully exported public/models/mesh39_geometric_profile.json');
console.log('Top 5 dominant architectural islands:');
profile.dominantIslands.slice(0, 5).forEach((isl, i) => {
  console.log(`[${i+1}] ${isl.classification} | ${isl.triangleCount} tris | UV: [${isl.uvBounds.uMin}, ${isl.uvBounds.vMin}] to [${isl.uvBounds.uMax}, ${isl.uvBounds.vMax}] | Y: ${isl.physicalDimensions.elevationRangeY.join(' - ')}m | ${isl.architecturalRole}`);
});
