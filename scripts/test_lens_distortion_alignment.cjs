const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const outDir = path.join(__dirname, '../public/videos/lens_analysis');
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

console.log('🔬 Testing Lens Distortion & Correction on Keyframes...');

// Test 1: Frame 0 with varying k1 on the blockout to match Omni
const k1Values = [0.0, -0.015, -0.030, -0.045];
for (const k of k1Values) {
  const kStr = k === 0 ? 'k000' : `k${Math.abs(Math.round(k * 1000)).toString().padStart(3, '0')}`;
  const blockoutDist = path.join(outDir, `blockout_f0_${kStr}.jpg`);
  
  if (k === 0) {
    fs.copyFileSync(path.join(outDir, 'blockout_f0.jpg'), blockoutDist);
  } else {
    execSync(`ffmpeg -y -i "${path.join(outDir, 'blockout_f0.jpg')}" -vf "lenscorrection=cx=0.5:cy=0.5:k1=${k}:k2=0.005" "${blockoutDist}"`, { stdio: 'pipe' });
  }

  // Generate 50/50 split with Omni F0
  const splitOut = path.join(outDir, `split_f0_${kStr}.jpg`);
  execSync(`ffmpeg -y -i "${blockoutDist}" -i "${path.join(outDir, 'omni_f0.jpg')}" -filter_complex "[0:v]scale=960:1080:flags=lanczos:force_original_aspect_ratio=increase,crop=960:1080[left];[1:v]scale=960:1080:flags=lanczos:force_original_aspect_ratio=increase,crop=960:1080[right];[left][right]hstack[v]" -map "[v]" -vframes 1 "${splitOut}"`, { stdio: 'pipe' });
  console.log(`✓ Generated Frame 0 split with k1=${k}: ${path.basename(splitOut)}`);
}

// Test 2: Frame 360 (Nadir Ground Touchdown) with varying k1
for (const k of [0.0, -0.020, -0.035]) {
  const kStr = k === 0 ? 'k000' : `k${Math.abs(Math.round(k * 1000)).toString().padStart(3, '0')}`;
  const blockoutDist = path.join(outDir, `blockout_f360_${kStr}.jpg`);
  
  if (k === 0) {
    fs.copyFileSync(path.join(outDir, 'blockout_f360.jpg'), blockoutDist);
  } else {
    execSync(`ffmpeg -y -i "${path.join(outDir, 'blockout_f360.jpg')}" -vf "lenscorrection=cx=0.5:cy=0.5:k1=${k}:k2=0.004" "${blockoutDist}"`, { stdio: 'pipe' });
  }

  // Generate 50/50 split with Omni F360
  const splitOut = path.join(outDir, `split_f360_${kStr}.jpg`);
  execSync(`ffmpeg -y -i "${blockoutDist}" -i "${path.join(outDir, 'omni_f360.jpg')}" -filter_complex "[0:v]scale=960:1080:flags=lanczos:force_original_aspect_ratio=increase,crop=960:1080[left];[1:v]scale=960:1080:flags=lanczos:force_original_aspect_ratio=increase,crop=960:1080[right];[left][right]hstack[v]" -map "[v]" -vframes 1 "${splitOut}"`, { stdio: 'pipe' });
  console.log(`✓ Generated Frame 360 split with k1=${k}: ${path.basename(splitOut)}`);
}

// Test 3: Video Undistortion (Correcting Omni video plate back to rectilinear)
const omniF0Undist = path.join(outDir, 'omni_f0_undistorted_rectilinear.jpg');
execSync(`ffmpeg -y -i "${path.join(outDir, 'omni_f0.jpg')}" -vf "lenscorrection=cx=0.5:cy=0.5:k1=0.025:k2=-0.003" "${omniF0Undist}"`, { stdio: 'pipe' });

const splitUndistF0 = path.join(outDir, 'split_f0_undistorted_plate.jpg');
execSync(`ffmpeg -y -i "${path.join(outDir, 'blockout_f0.jpg')}" -i "${omniF0Undist}" -filter_complex "[0:v]scale=960:1080:flags=lanczos:force_original_aspect_ratio=increase,crop=960:1080[left];[1:v]scale=960:1080:flags=lanczos:force_original_aspect_ratio=increase,crop=960:1080[right];[left][right]hstack[v]" -map "[v]" -vframes 1 "${splitUndistF0}"`, { stdio: 'pipe' });
console.log(`✓ Generated Undistorted Plate Frame 0 split: ${path.basename(splitUndistF0)}`);

console.log('🎉 Lens distortion test suite completed successfully!');
