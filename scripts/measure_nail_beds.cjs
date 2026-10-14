const fs = require('fs');
const glb = fs.readFileSync('public/models/sbhuman_hand_hyperreal.glb');
const jsonLen = glb.readUInt32LE(12);
const gltf = JSON.parse(glb.toString('utf8', 20, 20 + jsonLen));
const binChunkOffset = 20 + jsonLen + 8;

function getAccessorData(accIdx, isVec2) {
  const acc = gltf.accessors[accIdx];
  const bv = gltf.bufferViews[acc.bufferView];
  const byteOffset = binChunkOffset + (bv.byteOffset || 0) + (acc.byteOffset || 0);
  const count = acc.count;
  return new Float32Array(glb.buffer, glb.byteOffset + byteOffset, count * (isVec2 ? 2 : 3));
}

const prim = gltf.meshes[0].primitives[0];
const pos = getAccessorData(prim.attributes.POSITION, false);
const uvs = getAccessorData(prim.attributes.TEXCOORD_0, true);
const norms = getAccessorData(prim.attributes.NORMAL, false);

let verts = [];
for (let i = 0; i < pos.length / 3; i++) {
  verts.push({
    i,
    x: pos[i*3], y: pos[i*3+1], z: pos[i*3+2],
    u: uvs[i*2], v: uvs[i*2+1],
    nx: norms[i*3], ny: norms[i*3+1], nz: norms[i*3+2]
  });
}

// Dorsal island is u < 0.50
const dorsalVerts = verts.filter(v => v.u < 0.50);

const fingers = {
  Middle: dorsalVerts.filter(v => v.x > 0.165 && v.z > -0.032 && v.z < -0.002),
  Index:  dorsalVerts.filter(v => v.x > 0.155 && v.z >= -0.002 && v.z < 0.040),
  Ring:   dorsalVerts.filter(v => v.x > 0.150 && v.z <= -0.032 && v.z > -0.060),
  Pinky:  dorsalVerts.filter(v => v.x > 0.115 && v.z <= -0.060),
  Thumb:  dorsalVerts.filter(v => v.x > 0.070 && v.z > 0.045)
};

for (const [name, list] of Object.entries(fingers)) {
  list.sort((a,b) => b.x - a.x);
  const tip = list[0];
  
  // Find vertices on the dorsal surface (normal Y > 0.15) within the distal 16mm
  const dorsalD = list.filter(v => v.ny > 0.15 && v.x > tip.x - 0.016);
  const avgU = dorsalD.reduce((s,v)=>s+v.u,0)/dorsalD.length;
  const avgV = dorsalD.reduce((s,v)=>s+v.v,0)/dorsalD.length;
  
  const minU = Math.min(...dorsalD.map(v=>v.u));
  const maxU = Math.max(...dorsalD.map(v=>v.u));
  const minV = Math.min(...dorsalD.map(v=>v.v));
  const maxV = Math.max(...dorsalD.map(v=>v.v));
  
  // Calculate orientation of UV coordinates along the finger length (x vs u, v)
  // Fit a line through (u, v) along the distal phalanx
  const p1 = dorsalD[0];
  const pLast = dorsalD[dorsalD.length - 1];
  const du = p1.u - pLast.u;
  const dv = p1.v - pLast.v;
  const angle = Math.atan2(du, -dv); // angle relative to vertical V axis

  console.log('--- ' + name + ' ---');
  console.log('  Tip Pos: [' + tip.x.toFixed(4) + ', ' + tip.y.toFixed(4) + ', ' + tip.z.toFixed(4) + ']');
  console.log('  Tip UV:  u=' + tip.u.toFixed(4) + ', v=' + tip.v.toFixed(4));
  console.log('  Nail Center UV: u=' + avgU.toFixed(4) + ', v=' + avgV.toFixed(4));
  console.log('  Width (du): ' + (maxU - minU).toFixed(4) + ' (' + ((maxU - minU)*2048).toFixed(1) + ' px)');
  console.log('  Length (dv): ' + (maxV - minV).toFixed(4) + ' (' + ((maxV - minV)*2048).toFixed(1) + ' px)');
  console.log('  Distal edge V: ' + minV.toFixed(4) + ', Proximal cuticle V: ' + maxV.toFixed(4));
  console.log('  Fitted Angle: ' + (angle * 180 / Math.PI).toFixed(1) + ' deg');
}
