/**
 * Extracts 25 dense keyframe snapshots from 4K matchmove video assets using ffmpeg.
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const publicDir = path.resolve(__dirname, '../public');
const imagesDir = path.join(publicDir, 'images');

const DENSE_SCHEDULE = [
  { kf: 1, frame: 1, time: 0.00 },
  { kf: 2, frame: 15, time: 0.60 },
  { kf: 3, frame: 30, time: 1.20 },
  { kf: 4, frame: 46, time: 1.88 },
  { kf: 5, frame: 61, time: 2.50 },
  { kf: 6, frame: 76, time: 3.13 },
  { kf: 7, frame: 91, time: 3.76 },
  { kf: 8, frame: 106, time: 4.38 },
  { kf: 9, frame: 121, time: 5.01 },
  { kf: 10, frame: 136, time: 5.64 },
  { kf: 11, frame: 151, time: 6.26 },
  { kf: 12, frame: 166, time: 6.89 },
  { kf: 13, frame: 181, time: 7.52 },
  { kf: 14, frame: 196, time: 8.14 },
  { kf: 15, frame: 211, time: 8.77 },
  { kf: 16, frame: 226, time: 9.40 },
  { kf: 17, frame: 241, time: 10.02 },
  { kf: 18, frame: 256, time: 10.65 },
  { kf: 19, frame: 271, time: 11.28 },
  { kf: 20, frame: 286, time: 11.90 },
  { kf: 21, frame: 301, time: 12.53 },
  { kf: 22, frame: 316, time: 13.16 },
  { kf: 23, frame: 331, time: 13.78 },
  { kf: 24, frame: 346, time: 14.41 },
  { kf: 25, frame: 361, time: 15.00 }
];

const blockoutVideo = path.join(publicDir, 'videos/plaza_hotel_blockout_camera.mp4');
const omniVideo = path.join(publicDir, 'videos/plaza_hotel_omni_restyled.mp4');
const compVideo = path.join(publicDir, 'videos/plaza_hotel_vs_omni_comparison.mp4');

console.log('Extracting dense keyframes...');

for (const item of DENSE_SCHEDULE) {
  const padKf = String(item.kf).padStart(2, '0');
  const outBlockout = path.join(imagesDir, `dense_plaza_blockout_kf${padKf}_f${item.frame}.png`);
  const outOmni = path.join(imagesDir, `dense_plaza_omni_kf${padKf}_f${item.frame}.png`);
  const outComp = path.join(imagesDir, `dense_plaza_comparison_kf${padKf}_f${item.frame}.png`);

  if (!fs.existsSync(outBlockout) && fs.existsSync(blockoutVideo)) {
    execSync(`ffmpeg -ss ${item.time} -i "${blockoutVideo}" -vframes 1 -q:v 2 "${outBlockout}" -y 2>/dev/null`);
    console.log(`Extracted blockout kf ${padKf} at ${item.time}s`);
  }
  if (!fs.existsSync(outOmni) && fs.existsSync(omniVideo)) {
    execSync(`ffmpeg -ss ${item.time} -i "${omniVideo}" -vframes 1 -q:v 2 "${outOmni}" -y 2>/dev/null`);
    console.log(`Extracted omni kf ${padKf} at ${item.time}s`);
  }
  if (!fs.existsSync(outComp) && fs.existsSync(compVideo)) {
    execSync(`ffmpeg -ss ${item.time} -i "${compVideo}" -vframes 1 -q:v 2 "${outComp}" -y 2>/dev/null`);
    console.log(`Extracted comparison kf ${padKf} at ${item.time}s`);
  }
}

console.log('Dense keyframe extraction complete!');
