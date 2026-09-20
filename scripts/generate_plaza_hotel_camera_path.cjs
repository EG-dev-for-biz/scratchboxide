const fs = require('fs');
const path = require('path');

// Avenue grid angle in Manhattan (radians)
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

// Master Keyframes from Frame 0 (Roofline) to Frame 360 (Overhead Nadir)
// Total 15.041667s, 361 frames @ 24fps
const keyframes = [
  {
    time: 0.0, // Frame 0 (0.00s): Roofline framing NE corner turret dome on right & French Renaissance dormer gable on left
    position: [54.0, 71.0, 5.0],
    target: [25.5, 70.0, 1.0],
    tiltFraction: 0.0, // Pure World Up [0, 1, 0] for authentic upright building perspective
    fov: 46.0
  },
  {
    time: 1.8, // Frame 43 (1.79s): Tracking corner turret transition down facade
    position: [53.0, 54.0, 7.0],
    target: [26.0, 52.0, 3.0],
    tiltFraction: 0.02,
    fov: 46.0
  },
  {
    time: 3.2, // Frame 77 (3.21s): ref_frames/frame_04.jpg - North wing recess on left, central entrance pavilion on right
    position: [51.0, 42.0, 13.0],
    target: [24.0, 39.0, 14.0],
    tiltFraction: 0.05,
    fov: 48.0
  },
  {
    time: 4.2, // Frame 101 (4.21s): ref_frames/frame_05.jpg - Centered on Grand Army Plaza arched entryway facade
    position: [47.5, 26.0, 22.2],
    target: [22.0, 22.0, 22.5],
    tiltFraction: 0.10,
    fov: 49.0
  },
  {
    time: 5.2, // Frame 125 (5.21s): ref_frames/frame_06.jpg - Descending towards marquee, revealing marquee fascia & checkered pavement
    position: [46.0, 19.5, 22.4],
    target: [27.0, 11.0, 22.4],
    tiltFraction: 0.38,
    fov: 50.0
  },
  {
    time: 6.4, // Frame 154 (6.42s): ref_frames/frame_07.jpg - Facing marquee awning slope & checkered sidewalk
    position: [44.5, 15.0, 22.6],
    target: [35.0, 5.0, 22.8],
    tiltFraction: 0.65,
    fov: 51.0
  },
  {
    time: 8.0, // Frame 192 (8.00s): ref_frames/frame_09.jpg - Steep pitch facing drop-off lane, checkered pavement & white road line
    position: [43.5, 11.5, 23.0],
    target: [41.5, 2.5, 23.0],
    tiltFraction: 0.82,
    fov: 52.0
  },
  {
    time: 11.5, // Frame 276 (11.50s): ref_frames/frame_12.jpg - Near nadir descent directly over drop-off lane
    position: [42.8, 7.5, 23.4],
    target: [42.7, 0.5, 23.4],
    tiltFraction: 0.96,
    fov: 52.0
  },
  {
    time: 15.041667, // Frame 360 (15.04s): ref_frames/frame_15.jpg - Pure nadir (-90 deg) overhead looking down on Eloise lane marking
    position: [42.6, 4.5, 23.5],
    target: [42.6, 0.0, 23.5],
    tiltFraction: 1.0,
    fov: 52.0
  }
];

function generateTrajectory(totalFrames = 361, fps = 24) {
  const durationSec = (totalFrames - 1) / fps;
  const frames = [];

  for (let i = 0; i < totalFrames; i++) {
    const t = (i / (totalFrames - 1)) * durationSec;

    let segIdx = 0;
    while (segIdx < keyframes.length - 2 && keyframes[segIdx + 1].time < t) {
      segIdx++;
    }

    const k1 = keyframes[segIdx];
    const k2 = keyframes[segIdx + 1];
    const k0 = segIdx > 0 ? keyframes[segIdx - 1] : k1;
    const k3 = segIdx < keyframes.length - 2 ? keyframes[segIdx + 2] : k2;

    const u = (t - k1.time) / (k2.time - k1.time);
    const clampedU = Math.max(0, Math.min(1, u));

    // Spline position & target
    const pos = catmullRom(k0.position, k1.position, k2.position, k3.position, clampedU);
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

    frames.push({
      frame: i,
      timeSec: Number(t.toFixed(4)),
      position: [Number(pos[0].toFixed(3)), Number(pos[1].toFixed(3)), Number(pos[2].toFixed(3))],
      target: [Number(tgt[0].toFixed(3)), Number(tgt[1].toFixed(3)), Number(tgt[2].toFixed(3))],
      up: [Number(up[0].toFixed(4)), Number(up[1].toFixed(4)), Number(up[2].toFixed(4))],
      fov: Number(fov.toFixed(2))
    });
  }

  return {
    fps,
    totalFrames,
    durationSec,
    frames
  };
}

const outputPath = path.join(process.cwd(), 'public/models/plaza_hotel_camera_path.json');
const pathData = generateTrajectory(361, 24);
fs.writeFileSync(outputPath, JSON.stringify(pathData, null, 2));
console.log(`Generated calibrated 361-frame trajectory in ${outputPath}`);
