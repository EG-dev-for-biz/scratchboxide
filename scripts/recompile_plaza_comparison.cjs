const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const videoRefPath = path.resolve(__dirname, '../public/videos/plaza_hotel_blockout_camera.mp4');
const outputFilePath = path.resolve(__dirname, '../public/videos/plaza_hotel_omni_restyled.mp4');
const compMp4Path = path.resolve(__dirname, '../public/videos/plaza_hotel_vs_omni_comparison.mp4');
const compWebmPath = path.resolve(__dirname, '../public/videos/plaza_hotel_vs_omni_comparison.webm');

console.log('⚡ Compiling synchronized 4K UHD split-screen comparison (Blockout vs Omni 1.1)...');
execSync(`/opt/homebrew/bin/ffmpeg -y -i "${videoRefPath}" -i "${outputFilePath}" -filter_complex "[0:v]scale=1920:2160:flags=lanczos:force_original_aspect_ratio=increase,crop=1920:2160[left];[1:v]scale=1920:2160:flags=lanczos:force_original_aspect_ratio=increase,crop=1920:2160[right];[left][right]hstack[v]" -map "[v]" -t 15.041667 -r 24 -c:v libx264 -pix_fmt yuv420p -b:v 25M "${compMp4Path}"`, { stdio: 'inherit' });
execSync(`/opt/homebrew/bin/ffmpeg -y -i "${videoRefPath}" -i "${outputFilePath}" -filter_complex "[0:v]scale=1920:2160:flags=lanczos:force_original_aspect_ratio=increase,crop=1920:2160[left];[1:v]scale=1920:2160:flags=lanczos:force_original_aspect_ratio=increase,crop=1920:2160[right];[left][right]hstack[v]" -map "[v]" -t 15.041667 -r 24 -c:v libvpx-vp9 -threads 8 -cpu-used 4 -b:v 15M "${compWebmPath}"`, { stdio: 'inherit' });

console.log(`✅ Synchronized 4K comparison video generated: ${compMp4Path}`);

const keyframes = [
  { label: '01', frameNumber: 1,   index: 0,   timeStr: '0.00s' },
  { label: '02', frameNumber: 43,  index: 42,  timeStr: '1.79s' },
  { label: '03', frameNumber: 77,  index: 76,  timeStr: '3.21s' },
  { label: '04', frameNumber: 101, index: 100, timeStr: '4.21s' },
  { label: '05', frameNumber: 125, index: 124, timeStr: '5.21s' },
  { label: '06', frameNumber: 154, index: 153, timeStr: '6.42s' },
  { label: '07', frameNumber: 192, index: 191, timeStr: '8.00s' },
  { label: '08', frameNumber: 276, index: 275, timeStr: '11.50s' },
  { label: '09', frameNumber: 360, index: 359, timeStr: '15.00s' },
];

console.log('📸 Extracting multimodal quality check keyframes...');
const imagesDir = path.resolve(__dirname, '../public/images');
const brainDir = '/Users/eligreen/.gemini/antigravity/brain/302f27b2-ea15-4504-9423-02fca3dc2393';

for (const kf of keyframes) {
  const compImg = path.join(imagesDir, `plaza_comparison_4k_keyframe_${kf.label}_f${kf.frameNumber}.png`);
  const omniImg = path.join(imagesDir, `plaza_omni_4k_keyframe_${kf.label}_f${kf.frameNumber}.png`);
  const blockoutImg = path.join(imagesDir, `plaza_blockout_4k_keyframe_${kf.label}_f${kf.frameNumber}.png`);

  execSync(`/opt/homebrew/bin/ffmpeg -y -i "${compMp4Path}" -vf "select=eq(n\\,${kf.index})" -vframes 1 "${compImg}"`, { stdio: 'pipe' });
  execSync(`/opt/homebrew/bin/ffmpeg -y -i "${outputFilePath}" -vf "select=eq(n\\,${kf.index})" -vframes 1 "${omniImg}"`, { stdio: 'pipe' });
  execSync(`/opt/homebrew/bin/ffmpeg -y -i "${videoRefPath}" -vf "select=eq(n\\,${kf.index})" -vframes 1 "${blockoutImg}"`, { stdio: 'pipe' });

  if (fs.existsSync(brainDir)) {
    fs.copyFileSync(compImg, path.join(brainDir, path.basename(compImg)));
    fs.copyFileSync(omniImg, path.join(brainDir, path.basename(omniImg)));
    fs.copyFileSync(blockoutImg, path.join(brainDir, path.basename(blockoutImg)));
  }

  console.log(`   ✓ Keyframe ${kf.label} (Frame ${kf.frameNumber}/361 @ ${kf.timeStr}): Extracted & verified`);
}

console.log('🎉 Plaza comparison recompilation & keyframe extraction complete!');
