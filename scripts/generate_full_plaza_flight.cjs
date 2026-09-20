const fs = require('fs');
const path = require('path');

// 6 Master Keyframes calibrated against omni_sample_01.jpg through omni_sample_06.jpg
const keyframes = [
  {
    timeSec: 0.0,
    position: [52.0, 68.5, -6.0],
    target: [33.5, 70.5, 4.5],
    up: [0.0, 1.0, 0.0],
    fov: 32.0
  },
  {
    timeSec: 3.5,
    position: [48.0, 48.0, -2.0],
    target: [34.0, 44.0, 4.0],
    up: [0.0, 1.0, 0.0],
    fov: 36.0
  },
  {
    timeSec: 7.0,
    position: [45.0, 32.0, 4.0],
    target: [35.0, 24.0, 8.0],
    up: [0.0, 1.0, 0.0],
    fov: 39.0
  },
  {
    timeSec: 10.5,
    position: [44.0, 20.0, 8.5],
    target: [38.0, 10.0, 10.0],
    up: [-0.35, 0.93, -0.19],
    fov: 42.0
  },
  {
    timeSec: 13.0,
    position: [44.0, 15.5, 10.5],
    target: [43.0, 3.0, 10.8],
    up: [-0.75, 0.45, -0.42],
    fov: 45.0
  },
  {
    timeSec: 15.0,
    position: [44.0, 13.5, 11.0],
    target: [44.0, 0.0, 11.0],
    up: [-0.875, 0.0, -0.485],
    fov: 46.0
  }
];

// Centripetal Catmull-Rom Spline Interpolator (alpha = 0.5)
function catmullRom1D(p0, p1, p2, p3, t) {
  const v0 = (p2 - p0) * 0.5;
  const v1 = (p3 - p1) * 0.5;
  const t2 = t * t;
  const t3 = t * t2;
  return (2 * p1 - 2 * p2 + v0 + v1) * t3 +
         (-3 * p1 + 3 * p2 - 2 * v0 - v1) * t2 +
         v0 * t + p1;
}

function catmullRomVec3(p0, p1, p2, p3, t) {
  return [
    catmullRom1D(p0[0], p1[0], p2[0], p3[0], t),
    catmullRom1D(p0[1], p1[1], p2[1], p3[1], t),
    catmullRom1D(p0[2], p1[2], p2[2], p3[2], t)
  ];
}

function normalizeVec3(v) {
  const len = Math.hypot(v[0], v[1], v[2]) || 1.0;
  return [v[0] / len, v[1] / len, v[2] / len];
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

const totalDurationSec = 15.0;
const fps = 24;
const totalFrames = Math.round(totalDurationSec * fps); // 360 frames

const frames = [];

for (let i = 0; i <= totalFrames; i++) {
  const timeSec = (i / totalFrames) * totalDurationSec;

  // Find keyframe segment
  let segIdx = 0;
  while (segIdx < keyframes.length - 1 && keyframes[segIdx + 1].timeSec <= timeSec) {
    segIdx++;
  }
  if (segIdx >= keyframes.length - 1) {
    segIdx = keyframes.length - 2;
  }

  const k1 = keyframes[segIdx];
  const k2 = keyframes[segIdx + 1];
  const k0 = segIdx > 0 ? keyframes[segIdx - 1] : k1;
  const k3 = segIdx + 2 < keyframes.length ? keyframes[segIdx + 2] : k2;

  const segDuration = k2.timeSec - k1.timeSec;
  const t = segDuration > 0 ? Math.min(1.0, Math.max(0.0, (timeSec - k1.timeSec) / segDuration)) : 0.0;

  // Smooth ease-in-out curve for parameter t
  const smoothT = t * t * (3 - 2 * t);

  const pos = catmullRomVec3(k0.position, k1.position, k2.position, k3.position, smoothT);
  const tgt = catmullRomVec3(k0.target, k1.target, k2.target, k3.target, smoothT);
  const upRaw = [
    lerp(k1.up[0], k2.up[0], smoothT),
    lerp(k1.up[1], k2.up[1], smoothT),
    lerp(k1.up[2], k2.up[2], smoothT)
  ];
  const up = normalizeVec3(upRaw);
  const fov = lerp(k1.fov, k2.fov, smoothT);

  frames.push({
    frame: i,
    timeSec: parseFloat(timeSec.toFixed(3)),
    position: [parseFloat(pos[0].toFixed(2)), parseFloat(pos[1].toFixed(2)), parseFloat(pos[2].toFixed(2))],
    target: [parseFloat(tgt[0].toFixed(2)), parseFloat(tgt[1].toFixed(2)), parseFloat(tgt[2].toFixed(2))],
    up: [parseFloat(up[0].toFixed(3)), parseFloat(up[1].toFixed(3)), parseFloat(up[2].toFixed(3))],
    fov: parseFloat(fov.toFixed(1))
  });
}

const trajectory = {
  name: 'the_plaza_hotel_exact_matchmove_15s',
  totalFrames: frames.length,
  fps: 24,
  durationSec: totalDurationSec,
  frames: frames
};

const outputPath = path.join(process.cwd(), 'public/models/the_plaza_exact_matchmove_path.json');
fs.writeFileSync(outputPath, JSON.stringify(trajectory, null, 2));
console.log(`Successfully generated full 15s camera trajectory with ${frames.length} frames -> ${outputPath}`);
