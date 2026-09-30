const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

/**
 * Bakes high-fidelity authentic video textures from canonical_frame.jpg
 * directly into 120,000 dense Gaussian splats (human_4dgs.ply & 10331522.splat).
 *
 * Samples 120,000 points uniformly across the authentic sbhuman_neutral mesh topology,
 * computes normal-aligned quaternions and millimeter anisotropic surfel scales,
 * poses Gaussians into Frame 0 Hero Stance using 4-bone partition-of-unity LBS with Rodrigues rotations,
 * then backprojects camera rays through calibrated pinhole intrinsics from:
 *   C = [0.00, 0.902, 1.375], vFOV = 75.405°
 * to sample true photorealistic albedos (dark skin, purple headphones, pastel tie-dye silk, cream pants with magenta cuffs, white sneakers).
 */
async function main() {
  const demoDir = path.resolve(__dirname, '../public/models/performer_4dgs/demos/10331522');
  const heroFramePath = path.join(demoDir, 'canonical_frame.jpg');
  const plyPath = path.join(demoDir, 'human_4dgs.ply');
  const motionPath = path.join(demoDir, 'motion.json');
  const camPath = path.join(demoDir, 'cameras.json');
  const splatPath = path.join(demoDir, '10331522.splat');
  const sbHumanPath = path.resolve(__dirname, '../public/models/sbhuman_neutral.sbhuman');

  console.log('[Backprojector] Loading assets for demo #10331522...');
  if (!fs.existsSync(heroFramePath) || !fs.existsSync(motionPath) || !fs.existsSync(sbHumanPath)) {
    throw new Error('Required assets missing in ' + demoDir);
  }

  // 1. Decode hero frame RGB buffer via ffmpeg
  const cam = JSON.parse(fs.readFileSync(camPath, 'utf8'));
  const W = cam.w || 2160;
  const H = cam.h || 3840;
  console.log(`[Backprojector] Decoding ${heroFramePath} (${W}x${H} UHD)...`);
  const rgbBuf = execSync(
    `ffmpeg -v error -i "${heroFramePath}" -f rawvideo -pix_fmt rgb24 pipe:1`,
    { maxBuffer: 50 * 1024 * 1024 }
  );
  if (rgbBuf.length !== W * H * 3) {
    throw new Error(`Invalid RGB buffer size: got ${rgbBuf.length}, expected ${W * H * 3}`);
  }

  function getPixelRGB(u, v) {
    const px = Math.min(W - 1, Math.max(0, Math.round(u)));
    const py = Math.min(H - 1, Math.max(0, Math.round(v)));
    const idx = (py * W + px) * 3;
    return [rgbBuf[idx] / 255.0, rgbBuf[idx + 1] / 255.0, rgbBuf[idx + 2] / 255.0];
  }

  // 2. Load motion.json and canonical joints
  const motion = JSON.parse(fs.readFileSync(motionPath, 'utf8'));
  const canonJoints = motion.canonical_joints;
  const heroJoints = motion.frames[0].joint_positions_3d;
  const numJoints = canonJoints.length;

  // 3. Load SbHumanLoader and sample 120,000 uniform surface points
  const { SbHumanLoader } = await import('../packages/core/dist/common/spatial/SbHumanLoader.js');
  const { CharacterClothingMorphology } = await import('../packages/core/dist/node/spatial/CharacterClothingMorphology.js');
  const sbHumanBuf = fs.readFileSync(sbHumanPath);
  const loader = SbHumanLoader.parse(sbHumanBuf);

  const numPoints = 120000;
  console.log(`[Backprojector] Uniformly sampling ${numPoints} Gaussians across authentic humanoid mesh with solved betas...`);
  // Solved morphological betas for performer #10331522:
  const solvedBetas = [0.875, -0.450, -0.820, 0.200, 0.650, -0.320, -0.150, -0.420];
  const sampled = loader.sampleUniformSurface(numPoints, solvedBetas);

  // Compute height scale to calibrate exactly with canonical joints
  let minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < sampled.count; i++) {
    const y = sampled.positions[i * 3 + 1];
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const meshHeight = (maxY - minY) || 1.72;
  const targetHeight = 1.74308;
  const heightScale = targetHeight / meshHeight;

  // Joint mapping from 55 joints down to 22 body joints
  const mapJointTo22 = (jId) => {
    let curr = jId;
    while (curr >= 22 && curr >= 0 && curr < loader.joints.length) {
      curr = loader.joints[curr].parent;
    }
    return Math.max(0, Math.min(21, curr));
  };

  // Scale positions and map bones
  const scaledPos = new Float32Array(sampled.count * 3);
  const mappedBones = new Uint8Array(sampled.count * 4);
  for (let i = 0; i < sampled.count; i++) {
    scaledPos[i * 3]     = sampled.positions[i * 3] * heightScale;
    scaledPos[i * 3 + 1] = (sampled.positions[i * 3 + 1] - minY) * heightScale;
    scaledPos[i * 3 + 2] = sampled.positions[i * 3 + 2] * heightScale;

    mappedBones[i * 4]     = mapJointTo22(sampled.boneIndices[i * 4]);
    mappedBones[i * 4 + 1] = mapJointTo22(sampled.boneIndices[i * 4 + 1]);
    mappedBones[i * 4 + 2] = mapJointTo22(sampled.boneIndices[i * 4 + 2]);
    mappedBones[i * 4 + 3] = mapJointTo22(sampled.boneIndices[i * 4 + 3]);
  }

  console.log('[Backprojector] Applying authentic character clothing morphology (wide palazzo pants, boxy tunic, headphones, wide stance)...');
  CharacterClothingMorphology.applyMorphology(scaledPos, mappedBones, sampled.count, {
    palazzoPantsRadius: 0.135,
    palazzoFlareRadius: 0.025,
    tunicHalfWidth: 0.225,
    tunicHalfDepth: 0.135,
    tunicHemY: 0.72,
    sleeveRadius: 0.088,
    headphoneLateralOffset: 0.118,
    headbandArchLift: 0.025,
    legStanceSpread: 0.30
  });

  // 4. Calibrated Camera Setup: Closed-form optical resection
  // C = [0.0, 0.902, 1.375], vFOV = 75.405 deg
  const camPos = [0.0, 0.902, 1.375];
  const fx = cam.fl_x || 2484.0;
  const fy = cam.fl_y || 2484.0;
  const cx = cam.cx || (W * 0.5);
  const cy = cam.cy || (H * 0.5);
  const C0 = 0.28209479177387814;

  function norm3(v) {
    const l = Math.hypot(v[0], v[1], v[2]) || 1.0;
    return [v[0] / l, v[1] / l, v[2] / l];
  }

  function getRotationMatrix(vFrom, vTo) {
    const v1 = norm3(vFrom);
    const v2 = norm3(vTo);
    const ax = v1[1] * v2[2] - v1[2] * v2[1];
    const ay = v1[2] * v2[0] - v1[0] * v2[2];
    const az = v1[0] * v2[1] - v1[1] * v2[0];
    const sinA = Math.hypot(ax, ay, az);
    const cosA = Math.max(-1.0, Math.min(1.0, v1[0] * v2[0] + v1[1] * v2[1] + v1[2] * v2[2]));
    if (sinA < 1e-5) return [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    const u = [ax / sinA, ay / sinA, az / sinA];
    const oneMinusCos = 1 - cosA;
    return [
      [cosA + u[0] * u[0] * oneMinusCos, u[0] * u[1] * oneMinusCos - u[2] * sinA, u[0] * u[2] * oneMinusCos + u[1] * sinA],
      [u[1] * u[0] * oneMinusCos + u[2] * sinA, cosA + u[1] * u[1] * oneMinusCos, u[1] * u[2] * oneMinusCos - u[0] * sinA],
      [u[2] * u[0] * oneMinusCos - u[1] * sinA, u[2] * u[1] * oneMinusCos + u[0] * sinA, cosA + u[2] * u[2] * oneMinusCos]
    ];
  }

  // Precompute bone rotation matrices using explicit bone-pair pivots:
  // Each bone connects pivot joint P to child joint C. Points skinned to P pivot around P.
  const boneR = Array.from({ length: 22 }, () => [[1, 0, 0], [0, 1, 0], [0, 0, 1]]);
  const bonePairs = [
    [0, 3],   // Pelvis -> Spine1
    [3, 6],   // Spine1 -> Spine2
    [6, 9],   // Spine2 -> Spine3
    [9, 12],  // Spine3 -> Neck
    [12, 15], // Neck -> Head
    [9, 13],  // Spine3 -> LeftCollar
    [9, 14],  // Spine3 -> RightCollar
    [13, 16], // LeftCollar -> LeftShoulder
    [14, 17], // RightCollar -> RightShoulder
    [16, 18], // LeftShoulder -> LeftElbow (Upper Arm)
    [17, 19], // RightShoulder -> RightElbow (Upper Arm)
    [18, 20], // LeftElbow -> LeftWrist (Forearm)
    [19, 21], // RightElbow -> RightWrist (Forearm)
    [0, 1],   // Pelvis -> LeftHip
    [0, 2],   // Pelvis -> RightHip
    [1, 4],   // LeftHip -> LeftKnee (Thigh)
    [2, 5],   // RightHip -> RightKnee (Thigh)
    [4, 7],   // LeftKnee -> LeftAnkle (Shin)
    [5, 8],   // RightKnee -> RightAnkle (Shin)
    [7, 10],  // LeftAnkle -> LeftFoot
    [8, 11]   // RightAnkle -> RightFoot
  ];
  for (const [p, c] of bonePairs) {
    const vC = [canonJoints[c][0] - canonJoints[p][0], canonJoints[c][1] - canonJoints[p][1], canonJoints[c][2] - canonJoints[p][2]];
    const vH = [heroJoints[c][0] - heroJoints[p][0], heroJoints[c][1] - heroJoints[p][1], heroJoints[c][2] - heroJoints[p][2]];
    boneR[p] = getRotationMatrix(vC, vH);
  }
  boneR[20] = boneR[18];
  boneR[21] = boneR[19];
  boneR[10] = boneR[7];
  boneR[11] = boneR[8];
  boneR[15] = boneR[12];

  // Tangent-aligned millimeter surfel scales:
  // For 120,000 points, surface spacing is ~3.5mm.
  // sx = 3.5mm, sy = 5.0mm, sz = 1.0mm
  const sx = 0.0035;
  const sy = 0.0050;
  const sz = 0.0010;
  const logS0 = Math.log(sx);
  const logS1 = Math.log(sy);
  const logS2 = Math.log(sz);
  const opLogit = Math.log(0.96 / (1.0 - 0.96)); // ~3.1781

  let frontalCount = 0;
  let rearCount = 0;
  const gaussians = [];

  for (let i = 0; i < sampled.count; i++) {
    const px = scaledPos[i * 3];
    const py = scaledPos[i * 3 + 1];
    const pz = scaledPos[i * 3 + 2];

    let nx = sampled.normals[i * 3];
    let ny = sampled.normals[i * 3 + 1];
    let nz = sampled.normals[i * 3 + 2];

    const j0 = mappedBones[i * 4];
    if ([1, 4, 7, 10].includes(j0) && py >= 0.11 && py < 0.88) { // Left leg trousers (above ankle cuff)
      const axisX = 0.075 + 0.30 * Math.max(0, Math.min(1.0, (0.88 - py) / 0.85));
      const axisZ = -0.02;
      const dx = px - axisX;
      const dz = pz - axisZ;
      const r = Math.hypot(dx, dz) || 0.001;
      nx = dx / r; ny = 0; nz = dz / r;
    } else if ([2, 5, 8, 11].includes(j0) && py >= 0.11 && py < 0.88) { // Right leg trousers (above ankle cuff)
      const axisX = -0.075 - 0.30 * Math.max(0, Math.min(1.0, (0.88 - py) / 0.85));
      const axisZ = -0.02;
      const dx = px - axisX;
      const dz = pz - axisZ;
      const r = Math.hypot(dx, dz) || 0.001;
      nx = dx / r; ny = 0; nz = dz / r;
    }

    // Compute partition-of-unity skinning weights mapped to 22 body joints
    const j1 = mappedBones[i * 4 + 1];
    const j2 = mappedBones[i * 4 + 2];
    const j3 = mappedBones[i * 4 + 3];

    const weightMap = new Map();
    weightMap.set(j0, (weightMap.get(j0) || 0) + sampled.boneWeights[i * 4]);
    weightMap.set(j1, (weightMap.get(j1) || 0) + sampled.boneWeights[i * 4 + 1]);
    weightMap.set(j2, (weightMap.get(j2) || 0) + sampled.boneWeights[i * 4 + 2]);
    weightMap.set(j3, (weightMap.get(j3) || 0) + sampled.boneWeights[i * 4 + 3]);

    const sorted = Array.from(weightMap.entries()).sort((a, b) => b[1] - a[1]);
    let wSum = 0;
    const weights = [];
    for (let k = 0; k < 4; k++) {
      const j = sorted[k] ? sorted[k][0] : 0;
      const w = sorted[k] ? sorted[k][1] : 0;
      weights.push({ joint: j, w });
      wSum += w;
    }
    const invW = wSum > 1e-6 ? 1.0 / wSum : 1.0;
    for (let k = 0; k < 4; k++) weights[k].w *= invW;

    // Forward LBS skinning with Rodrigues rotation to Frame 0 hero pose
    let posedX = 0, posedY = 0, posedZ = 0;
    for (let k = 0; k < 4; k++) {
      const j = weights[k].joint;
      const w = weights[k].w;
      const R = boneR[j];
      const rx = px - canonJoints[j][0];
      const ry = py - canonJoints[j][1];
      const rz = pz - canonJoints[j][2];
      const rotX = R[0][0] * rx + R[0][1] * ry + R[0][2] * rz;
      const rotY = R[1][0] * rx + R[1][1] * ry + R[1][2] * rz;
      const rotZ = R[2][0] * rx + R[2][1] * ry + R[2][2] * rz;
      posedX += (heroJoints[j][0] + rotX) * w;
      posedY += (heroJoints[j][1] + rotY) * w;
      posedZ += (heroJoints[j][2] + rotZ) * w;
    }

    // View direction vector from surface point to camera optical center
    const camX = posedX - camPos[0];
    const camY = posedY - camPos[1];
    const camZ = camPos[2] - posedZ;

    const cDist = Math.hypot(camX, camY, camZ) || 1.0;
    const vx = -camX / cDist;
    const vy = -camY / cDist;
    const vz = camZ / cDist;

    // Primary bone rotation for surface normal in posed camera space
    const R0 = boneR[weights[0].joint];
    const posedNx = R0[0][0] * nx + R0[0][1] * ny + R0[0][2] * nz;
    const posedNy = R0[1][0] * nx + R0[1][1] * ny + R0[1][2] * nz;
    const posedNz = R0[2][0] * nx + R0[2][1] * ny + R0[2][2] * nz;

    // Normal dot view (surface facing in posed camera space)
    const dot = posedNx * vx + posedNy * vy + posedNz * vz;

    // Project onto film plane
    const u = fx * (camX / camZ) + cx;
    const v = fy * (-camY / camZ) + cy;

    let rgb;
    if (dot > -0.05) {
      // Frontal facing: direct ray sampling from hero frame
      rgb = getPixelRGB(u, v);
      if (rgb[0] < 0.32 && rgb[1] > rgb[2] && rgb[1] < 0.30) {
        const inwardU = u + (cx - u) * 0.12;
        const inwardRgb = getPixelRGB(inwardU, v);
        if (inwardRgb[0] > 0.35 || inwardRgb[2] > 0.30) {
          rgb = inwardRgb;
        }
      }
      frontalCount++;
    } else {
      // Rear facing: bilateral coronal symmetry with subtle subsurface bounce
      const symU = 2 * cx - u;
      let baseRgb = getPixelRGB(symU, v);
      if (baseRgb[0] < 0.32 && baseRgb[1] > baseRgb[2] && baseRgb[1] < 0.30) {
        const inwardSymU = symU + (cx - symU) * 0.12;
        const inwardRgb = getPixelRGB(inwardSymU, v);
        if (inwardRgb[0] > 0.35 || inwardRgb[2] > 0.30) {
          baseRgb = inwardRgb;
        }
      }
      const rearDim = 0.88 + 0.10 * (1.0 + dot); // gentle depth modulation
      rgb = [
        Math.min(1.0, baseRgb[0] * rearDim),
        Math.min(1.0, baseRgb[1] * rearDim),
        Math.min(1.0, baseRgb[2] * rearDim)
      ];
      rearCount++;
    }

    // Normal-aligned shortest-arc quaternion from (0, 0, 1) to (nx, ny, nz)
    let qx = 0, qy = 0, qz = 0, qw = 1;
    const dotZ = nz;
    if (dotZ >= 0.9999) {
      qx = 0; qy = 0; qz = 0; qw = 1;
    } else if (dotZ <= -0.9999) {
      qx = 0; qy = 1; qz = 0; qw = 0;
    } else {
      const ax = -ny;
      const ay = nx;
      const s = Math.sqrt((1 + dotZ) * 2);
      const invS = 1 / s;
      qx = ax * invS;
      qy = ay * invS;
      qz = 0;
      qw = s * 0.5;
    }
    const qLen = Math.hypot(qx, qy, qz, qw) || 1.0;
    qx /= qLen; qy /= qLen; qz /= qLen; qw /= qLen;

    gaussians.push({
      x: px,
      y: py,
      z: pz,
      nx,
      ny,
      nz,
      f_dc_0: (rgb[0] - 0.5) / C0,
      f_dc_1: (rgb[1] - 0.5) / C0,
      f_dc_2: (rgb[2] - 0.5) / C0,
      opacity: opLogit,
      scale_0: logS0,
      scale_1: logS1,
      scale_2: logS2,
      rot_0: qx,
      rot_1: qy,
      rot_2: qz,
      rot_3: qw,
      joint_id: weights[0].joint,
      b0: weights[0].joint,
      b1: weights[1].joint,
      b2: weights[2].joint,
      b3: weights[3].joint,
      w0: weights[0].w,
      w1: weights[1].w,
      w2: weights[2].w,
      w3: weights[3].w,
      colorRgb: rgb
    });
  }

  console.log(`[Backprojector] Successfully baked ${gaussians.length} Gaussians (Frontal: ${frontalCount}, Bilateral: ${rearCount}).`);

  // 5. Serialize standard ASCII PLY
  console.log(`[Backprojector] Writing ${plyPath}...`);
  const plyHeader = [
    'ply',
    'format ascii 1.0',
    `element vertex ${gaussians.length}`,
    'property float x',
    'property float y',
    'property float z',
    'property float nx',
    'property float ny',
    'property float nz',
    'property float f_dc_0',
    'property float f_dc_1',
    'property float f_dc_2',
    'property float opacity',
    'property float scale_0',
    'property float scale_1',
    'property float scale_2',
    'property float rot_0',
    'property float rot_1',
    'property float rot_2',
    'property float rot_3',
    'property int joint_id',
    'property uchar bone_idx_0',
    'property uchar bone_idx_1',
    'property uchar bone_idx_2',
    'property uchar bone_idx_3',
    'property float bone_weight_0',
    'property float bone_weight_1',
    'property float bone_weight_2',
    'property float bone_weight_3',
    'end_header\n'
  ].join('\n');

  const plyBody = gaussians.map(g => [
    g.x.toFixed(5),
    g.y.toFixed(5),
    g.z.toFixed(5),
    g.nx.toFixed(4),
    g.ny.toFixed(4),
    g.nz.toFixed(4),
    g.f_dc_0.toFixed(4),
    g.f_dc_1.toFixed(4),
    g.f_dc_2.toFixed(4),
    g.opacity.toFixed(4),
    g.scale_0.toFixed(4),
    g.scale_1.toFixed(4),
    g.scale_2.toFixed(4),
    g.rot_0.toFixed(4),
    g.rot_1.toFixed(4),
    g.rot_2.toFixed(4),
    g.rot_3.toFixed(4),
    g.joint_id,
    g.b0,
    g.b1,
    g.b2,
    g.b3,
    g.w0.toFixed(4),
    g.w1.toFixed(4),
    g.w2.toFixed(4),
    g.w3.toFixed(4)
  ].join(' ')).join('\n');

  fs.writeFileSync(plyPath, plyHeader + plyBody + '\n', 'utf8');

  // 6. Serialize standard 32-byte binary .splat
  console.log(`[Backprojector] Writing ${splatPath}...`);
  const BYTES_PER_SPLAT = 32;
  const splatBuf = Buffer.alloc(gaussians.length * BYTES_PER_SPLAT);

  for (let i = 0; i < gaussians.length; i++) {
    const g = gaussians[i];
    const off = i * BYTES_PER_SPLAT;

    // Canonical position
    splatBuf.writeFloatLE(g.x, off);
    splatBuf.writeFloatLE(g.y, off + 4);
    splatBuf.writeFloatLE(g.z, off + 8);

    // Linear scale (convert from log scale in PLY)
    splatBuf.writeFloatLE(sx, off + 12);
    splatBuf.writeFloatLE(sy, off + 16);
    splatBuf.writeFloatLE(sz, off + 20);

    // RGB uint8
    const r = Math.min(255, Math.max(0, Math.round(g.colorRgb[0] * 255.0)));
    const gr = Math.min(255, Math.max(0, Math.round(g.colorRgb[1] * 255.0)));
    const b = Math.min(255, Math.max(0, Math.round(g.colorRgb[2] * 255.0)));
    const a = Math.min(255, Math.max(0, Math.round(0.96 * 255.0)));

    splatBuf.writeUInt8(r, off + 24);
    splatBuf.writeUInt8(gr, off + 25);
    splatBuf.writeUInt8(b, off + 26);
    splatBuf.writeUInt8(a, off + 27);

    // Rotation quaternion (normalized uint8 encoding: q * 128 + 128)
    splatBuf.writeUInt8(Math.min(255, Math.max(0, Math.round(g.rot_0 * 128.0 + 128.0))), off + 28);
    splatBuf.writeUInt8(Math.min(255, Math.max(0, Math.round(g.rot_1 * 128.0 + 128.0))), off + 29);
    splatBuf.writeUInt8(Math.min(255, Math.max(0, Math.round(g.rot_2 * 128.0 + 128.0))), off + 30);
    splatBuf.writeUInt8(Math.min(255, Math.max(0, Math.round(g.rot_3 * 128.0 + 128.0))), off + 31);
  }

  fs.writeFileSync(splatPath, splatBuf);

  // Also sync performer_canonical_frame_1790097067659.splat if it exists
  const altSplat = path.join(demoDir, 'performer_canonical_frame_1790097067659.splat');
  if (fs.existsSync(altSplat)) {
    fs.writeFileSync(altSplat, splatBuf);
  }

  const repoDemoDir = path.resolve(__dirname, '../models/performer_4dgs/demos/10331522');
  if (fs.existsSync(repoDemoDir)) {
    fs.writeFileSync(path.join(repoDemoDir, 'human_4dgs.ply'), fs.readFileSync(plyPath));
    fs.writeFileSync(path.join(repoDemoDir, '10331522.splat'), splatBuf);
  }

  console.log(`[Backprojector] Complete! Updated human_4dgs.ply (${(fs.statSync(plyPath).size / 1024 / 1024).toFixed(2)} MB) and 10331522.splat (${(splatBuf.length / 1024 / 1024).toFixed(2)} MB) with 120,000 Gaussians.`);
}

main().catch(err => {
  console.error('[Backprojector] Fatal error:', err);
  process.exit(1);
});
