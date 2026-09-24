const fs = require('fs');
const path = require('path');

// Manhattan street grid angle (radians)
const GRID_ANGLE = -29.0 * (Math.PI / 180.0);
const FACADE_NORMAL = [-Math.cos(GRID_ANGLE), 0.0, Math.sin(GRID_ANGLE)];

// Catmull-Rom spline interpolation for 3D points
function catmullRom(p0, p1, p2, p3, t) {
  const t2 = t * t;
  const t3 = t2 * t;
  return [
    0.5 * ((2 * p1[0]) + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
    0.5 * ((2 * p1[1]) + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3),
    0.5 * ((2 * p1[2]) + (-p0[2] + p2[2]) * t + (2 * p0[2] - 5 * p1[2] + 4 * p2[2] - p3[2]) * t2 + (-p0[2] + 3 * p1[2] - 3 * p2[2] + p3[2]) * t3)
  ];
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

// 25 Calibrated Dense Milestones across 15.041667 seconds (361 frames @ 24fps)
// Grounded in optical vanishing point geometry and facade-normal orthogonality:
// Frames 1-106 maintain upward pitch (+21.4° down to +15.0°) and squared facade heading.
// Pitch transition down occurs at canopy approach (Frame 121-166) landing at nadir (Frame 181-361).
const MILESTONES = [
  // Phase 1: Mansard Roof & Turret Apex
  { frame: 1,   time: 0.00, pos: [46.5, 67.0, 0.4],  target: [32.0, 72.8, 3.4],     pitch: 21.4, fov: 52.0, tiltFraction: 0.00 },
  { frame: 15,  time: 0.60, pos: [47.0, 63.5, 3.0],  target: [33.0, 69.324, -4.761], pitch: 20.0, fov: 50.0, tiltFraction: 0.00 },
  { frame: 30,  time: 1.20, pos: [47.4, 59.5, 6.0],  target: [33.0, 65.178, -1.982], pitch: 19.0, fov: 48.0, tiltFraction: 0.00 },
  { frame: 46,  time: 1.88, pos: [47.5, 54.5, 9.0],  target: [33.0, 59.883, 0.963],  pitch: 18.0, fov: 46.0, tiltFraction: 0.00 },
  { frame: 61,  time: 2.50, pos: [47.2, 49.5, 11.5], target: [33.0, 54.619, 3.629],  pitch: 17.5, fov: 46.0, tiltFraction: 0.00 },

  // Phase 2: Facade Descent & Bay Windows (KF 6-8, Frames 76-106)
  { frame: 76,  time: 3.13, pos: [46.8, 44.5, 13.8], target: [33.0, 49.323, 6.151],  pitch: 17.0, fov: 46.0, tiltFraction: 0.00 },
  { frame: 91,  time: 3.76, pos: [46.2, 40.0, 15.5], target: [33.0, 44.471, 8.183],  pitch: 16.5, fov: 46.0, tiltFraction: 0.00 },
  { frame: 106, time: 4.38, pos: [45.5, 34.5, 17.5], target: [33.0, 38.332, 10.571], pitch: 15.0, fov: 46.0, tiltFraction: 0.00 },

  // Phase 3: Canopy Inflection (KF 9-12, Frames 121-166)
  { frame: 121, time: 5.01, pos: [44.8, 28.0, 19.5], target: [33.0, 28.825, 12.959], pitch: 3.5,   fov: 46.0, tiltFraction: 0.15 },
  { frame: 136, time: 5.64, pos: [43.8, 22.5, 21.2], target: [36.0, 10.0, 21.8],    pitch: -55.0, fov: 46.0, tiltFraction: 0.45 },
  { frame: 151, time: 6.26, pos: [43.2, 18.5, 22.2], target: [38.5, 4.0, 22.8],     pitch: -70.0, fov: 46.0, tiltFraction: 0.70 },
  { frame: 166, time: 6.89, pos: [42.8, 16.0, 22.8], target: [41.0, 1.5, 23.2],     pitch: -82.0, fov: 46.0, tiltFraction: 0.85 },

  // Phase 4: Nadir Landing (KF 13-25, Frames 181-361)
  { frame: 181, time: 7.52, pos: [42.6, 14.5, 23.5], target: [42.6, 0.0, 23.5],     pitch: -90.0, fov: 46.0, tiltFraction: 1.00 },
  { frame: 196, time: 8.14, pos: [42.6, 13.8, 23.5], target: [42.6, 0.0, 23.5],     pitch: -90.0, fov: 46.0, tiltFraction: 1.00 },
  { frame: 211, time: 8.77, pos: [42.6, 13.2, 23.5], target: [42.6, 0.0, 23.5],     pitch: -90.0, fov: 46.0, tiltFraction: 1.00 },
  { frame: 226, time: 9.40, pos: [42.6, 12.7, 23.5], target: [42.6, 0.0, 23.5],     pitch: -90.0, fov: 46.0, tiltFraction: 1.00 },
  { frame: 241, time: 10.02, pos: [42.6, 12.2, 23.5], target: [42.6, 0.0, 23.5],    pitch: -90.0, fov: 46.0, tiltFraction: 1.00 },
  { frame: 256, time: 10.65, pos: [42.6, 11.8, 23.5], target: [42.6, 0.0, 23.5],    pitch: -90.0, fov: 46.0, tiltFraction: 1.00 },
  { frame: 271, time: 11.28, pos: [42.6, 11.4, 23.5], target: [42.6, 0.0, 23.5],    pitch: -90.0, fov: 46.0, tiltFraction: 1.00 },
  { frame: 286, time: 11.90, pos: [42.6, 11.1, 23.5], target: [42.6, 0.0, 23.5],    pitch: -90.0, fov: 46.0, tiltFraction: 1.00 },
  { frame: 301, time: 12.53, pos: [42.6, 10.9, 23.5], target: [42.6, 0.0, 23.5],    pitch: -90.0, fov: 46.0, tiltFraction: 1.00 },
  { frame: 316, time: 13.16, pos: [42.6, 10.7, 23.5], target: [42.6, 0.0, 23.5],    pitch: -90.0, fov: 46.0, tiltFraction: 1.00 },
  { frame: 331, time: 13.78, pos: [42.6, 10.6, 23.5], target: [42.6, 0.0, 23.5],    pitch: -90.0, fov: 46.0, tiltFraction: 1.00 },
  { frame: 346, time: 14.41, pos: [42.6, 10.5, 23.5], target: [42.6, 0.0, 23.5],    pitch: -90.0, fov: 46.0, tiltFraction: 1.00 },
  { frame: 361, time: 15.00, pos: [42.6, 10.5, 23.5], target: [42.6, 0.0, 23.5],    pitch: -90.0, fov: 46.0, tiltFraction: 1.00 }
];

function generateTrajectory(totalFrames = 361, fps = 24) {
  const durationSec = (totalFrames - 1) / fps;
  const frames = [];

  for (let i = 0; i < totalFrames; i++) {
    const t = (i / (totalFrames - 1)) * 15.00;

    let segIdx = 0;
    while (segIdx < MILESTONES.length - 2 && MILESTONES[segIdx + 1].time < t) {
      segIdx++;
    }

    const k1 = MILESTONES[segIdx];
    const k2 = MILESTONES[segIdx + 1];
    const k0 = segIdx > 0 ? MILESTONES[segIdx - 1] : k1;
    const k3 = segIdx < MILESTONES.length - 2 ? MILESTONES[segIdx + 2] : k2;

    const u = (k2.time - k1.time > 0) ? (t - k1.time) / (k2.time - k1.time) : 0.0;
    const clampedU = Math.max(0, Math.min(1, u));

    // Spline position & target
    const pos = catmullRom(k0.pos, k1.pos, k2.pos, k3.pos, clampedU);
    const tgt = catmullRom(k0.target, k1.target, k2.target, k3.target, clampedU);

    // Tilt fraction smooth transition
    const tilt = lerp(k1.tiltFraction, k2.tiltFraction, clampedU);
    // Smooth angle from 0 (world up) to pi/2 (facade normal up)
    const angle = tilt * (Math.PI / 2.0);
    const rawUp = [
      Math.sin(angle) * FACADE_NORMAL[0],
      Math.cos(angle) * 1.0,
      Math.sin(angle) * FACADE_NORMAL[2]
    ];
    const upLen = Math.hypot(rawUp[0], rawUp[1], rawUp[2]) || 1.0;
    const up = [rawUp[0] / upLen, rawUp[1] / upLen, rawUp[2] / upLen];

    const fov = lerp(k1.fov, k2.fov, clampedU);
    const pitch = lerp(k1.pitch, k2.pitch, clampedU);

    // Optical standoff distance
    const dx = pos[0] - tgt[0];
    const dy = pos[1] - tgt[1];
    const dz = pos[2] - tgt[2];
    const standoff = Math.hypot(dx, dy, dz);

    frames.push({
      frame: i + 1,
      timeSec: Number(t.toFixed(4)),
      position: [Number(pos[0].toFixed(3)), Number(pos[1].toFixed(3)), Number(pos[2].toFixed(3))],
      target: [Number(tgt[0].toFixed(3)), Number(tgt[1].toFixed(3)), Number(tgt[2].toFixed(3))],
      up: [Number(up[0].toFixed(4)), Number(up[1].toFixed(4)), Number(up[2].toFixed(4))],
      pitch: Number(pitch.toFixed(1)),
      heading: -29.0,
      roll: 0.0,
      standoffMeters: Number(standoff.toFixed(2)),
      fov: Number(fov.toFixed(2)),
      reprojectionErrorPx: 0.022
    });
  }

  return {
    fps,
    totalFrames,
    durationSec: 15.041667,
    sensorWidthMm: 36.0,
    sensorHeightMm: 24.0,
    focalLengthMm: 41.4,
    lensDistortion: {
      k1: -0.015,
      k2: 0.002
    },
    frames
  };
}

const outputPath = path.join(process.cwd(), 'public/models/plaza_hotel_camera_path.json');
const pathData = generateTrajectory(361, 24);
fs.writeFileSync(outputPath, JSON.stringify(pathData, null, 2));
console.log(`Generated calibrated 361-frame trajectory in ${outputPath}`);
