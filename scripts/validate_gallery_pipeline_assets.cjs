const fs = require('fs');
const path = require('path');

const publicDir = path.resolve(__dirname, '../public');
const galleryPath = path.join(publicDir, 's4d_multi_gallery.html');

if (!fs.existsSync(galleryPath)) {
  console.error(`❌ Gallery file not found: ${galleryPath}`);
  process.exit(1);
}

const html = fs.readFileSync(galleryPath, 'utf8');
const dataMatch = html.match(/const evaluationsData = (\[.*?\]);/s);

if (!dataMatch) {
  console.error('❌ Could not parse evaluationsData from gallery HTML');
  process.exit(1);
}

const evaluationsData = JSON.parse(dataMatch[1]);
console.log(`🔍 Auditing ${evaluationsData.length} districts in s4d_multi_gallery.html...\n`);

let hasErrors = false;

evaluationsData.forEach((dist, idx) => {
  console.log(`[District ${idx}] ${dist.name} (${dist.id})`);
  const isTextured = dist.id.includes('textured');
  const isClay = dist.id.includes('clay');

  if (dist.videoSources) {
    const requiredKeys = ['synthesis', 'blockout', 'comparison'];
    for (const key of requiredKeys) {
      const srcObj = dist.videoSources[key];
      if (!srcObj || !srcObj.local) {
        console.error(`  ❌ Missing videoSources.${key} for ${dist.id}`);
        hasErrors = true;
        continue;
      }

      const filePath = path.join(publicDir, srcObj.local);
      if (!fs.existsSync(filePath)) {
        console.error(`  ❌ File does not exist on disk: ${srcObj.local} (${key})`);
        hasErrors = true;
        continue;
      }

      const stat = fs.statSync(filePath);
      if (stat.size === 0) {
        console.error(`  ❌ File is 0 bytes: ${srcObj.local} (${key})`);
        hasErrors = true;
        continue;
      }

      // Semantic isolation checks
      if (isTextured) {
        if (srcObj.local.toLowerCase().includes('clay')) {
          console.error(`  ❌ Semantic violation: Textured district references clay asset: ${srcObj.local} (${key})`);
          hasErrors = true;
        }
      }

      if (isClay) {
        if (srcObj.local.toLowerCase().includes('textured')) {
          console.error(`  ❌ Semantic violation: Clay district references textured asset: ${srcObj.local} (${key})`);
          hasErrors = true;
        }
      }

      console.log(`  ✓ ${key}: ${srcObj.local} (${(stat.size / (1024 * 1024)).toFixed(2)} MB)`);
    }
  }

  // Check storyboard beats if present
  if (dist.storyboardBeats && dist.storyboardBeats.length > 0) {
    dist.storyboardBeats.forEach((beat, bIdx) => {
      const beatPath = path.join(publicDir, beat);
      if (!fs.existsSync(beatPath)) {
        console.error(`  ❌ Storyboard beat missing: ${beat}`);
        hasErrors = true;
      } else if (isTextured && beat.includes('clay')) {
        console.error(`  ❌ Semantic violation: Textured district references clay storyboard: ${beat}`);
        hasErrors = true;
      } else if (isClay && beat.includes('textured')) {
        console.error(`  ❌ Semantic violation: Clay district references textured storyboard: ${beat}`);
        hasErrors = true;
      }
    });
    console.log(`  ✓ Storyboard beats: ${dist.storyboardBeats.length} frames verified`);
  }
  console.log('');
});

if (hasErrors) {
  console.error('❌ Validation FAILED: Detected broken links or semantic asset cross-contamination.');
  process.exit(1);
} else {
  console.log('✅ Validation PASSED: All district video sources and storyboards are coherent, non-empty, and isolated.');
  process.exit(0);
}
