const fs = require('fs');
const path = require('path');

const rootDir = process.cwd();
const isPrune = process.argv.includes('--prune');

const mediaExts = new Set([
  '.png', '.jpg', '.jpeg', '.webp', '.gif',
  '.mp4', '.webm', '.mov',
  '.glb', '.gltf', '.ply', '.splat', '.spz',
  '.hdr', '.exr'
]);

const codeExts = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.cjs', '.mjs',
  '.json', '.html', '.css', '.md', '.cpp', '.hpp', '.py'
]);

console.log('======================================================================');
console.log(`🧹 SCRATCHBOX IDE MEDIA ASSET AUDIT & PRUNING TOOL [Mode: ${isPrune ? 'PRUNE / DELETE' : 'DRY-RUN / AUDIT'}]`);
console.log('======================================================================\n');

console.log('1. Indexing all code, demo, documentation, and test files across repo...');
const codeTokens = new Set();
let codeCorpus = '';

const searchDirs = ['packages', 'public', 'desktop-app', 'scripts', 'models', 'projects', 'docs', 'tools'];
for (const sd of searchDirs) {
  const abs = path.join(rootDir, sd);
  if (!fs.existsSync(abs)) continue;

  function walkCode(dir) {
    for (const item of fs.readdirSync(dir)) {
      if (item === 'node_modules' || item === '.git' || item === '.gemini' || item === 'dist' || item === '.cache' || item === '.scratchbox' || item === 'temp_unwrap_rewrap') continue;
      const full = path.join(dir, item);
      const stat = fs.lstatSync(full);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        walkCode(full);
      } else {
        const ext = path.extname(item).toLowerCase();
        if (codeExts.has(ext)) {
          try {
            const content = fs.readFileSync(full, 'utf8');
            codeCorpus += '\n' + content;
            const matches = content.match(/[a-zA-Z0-9_\-\.\/]+/g);
            if (matches) {
              for (const m of matches) codeTokens.add(m);
            }
          } catch (e) {}
        }
      }
    }
  }
  walkCode(abs);
}
console.log(`   Indexed ${codeTokens.size} distinct tokens from code/demos.\n`);

// 2. Gather candidate directories
const targetDirs = [
  { dir: '.', recursive: false, label: 'Root Directory Stray Artifacts' },
  { dir: 'scratch/audit_frames', recursive: true, label: 'Scratch Audit Frames' },
  { dir: 'ref_frames', recursive: true, label: 'Stale Reference Frames' },
  { dir: 'public/uploads', recursive: true, label: 'Public Uploads (Relics)' },
  { dir: 'public/screenshots', recursive: true, label: 'Public Screenshots (Stale Dumps)' },
  { dir: 'public/flight_frames', recursive: true, label: 'Public Flight Frames (Intermediates)' },
  { dir: 'public/visual_proof_locations', recursive: true, label: 'Public Visual Proof (Test Dumps)' },
  { dir: 'public/tiles/processed_pbr', recursive: true, label: 'Public Tiles Processed PBR' },
  { dir: 'public/tiles/processed_pbr_esb', recursive: true, label: 'Public Tiles Processed PBR ESB' },
  { dir: 'public/models', recursive: false, label: 'Public Models (Stale CloudRun & Temp Meshes)' },
  { dir: 'public/images', recursive: false, label: 'Public Images (Stale Frame Dumps)' }
];

// Ephemeral runners in public/ and desktop-app/public/
const ephemeralRunners = [];
['public', 'desktop-app/public'].forEach(p => {
  const abs = path.join(rootDir, p);
  if (fs.existsSync(abs)) {
    fs.readdirSync(abs).forEach(f => {
      if (/^s4d_tile_blockout_runner_\d+_\d+\.html$/.test(f)) {
        ephemeralRunners.push(path.join(abs, f));
      }
    });
  }
});

let totalExamined = 0;
let totalKept = 0;
let totalDeletable = 0;
let totalDeletableBytes = 0;

const deletableFiles = [];

for (const target of targetDirs) {
  const absDir = path.join(rootDir, target.dir);
  if (!fs.existsSync(absDir)) continue;

  const candidates = [];
  function gather(curr, rec) {
    const list = fs.readdirSync(curr);
    for (const item of list) {
      const full = path.join(curr, item);
      const stat = fs.lstatSync(full);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        if (rec) gather(full, rec);
      } else {
        const ext = path.extname(item).toLowerCase();
        if (mediaExts.has(ext)) {
          candidates.push(full);
        }
      }
    }
  }
  gather(absDir, target.recursive);

  let dirKept = 0;
  let dirDeletable = 0;
  let dirBytes = 0;

  for (const file of candidates) {
    totalExamined++;
    const base = path.basename(file);
    const relFromRoot = path.relative(rootDir, file);
    const pubRel = relFromRoot.startsWith('public/') ? path.relative('public', relFromRoot) : relFromRoot;

    // Check if referenced anywhere in tokens or exact substring
    const isReferenced = (
      codeTokens.has(base) ||
      codeTokens.has(relFromRoot) ||
      codeTokens.has('/' + relFromRoot) ||
      codeTokens.has(pubRel) ||
      codeTokens.has('/' + pubRel) ||
      codeCorpus.includes(base)
    );

    if (isReferenced) {
      dirKept++;
      totalKept++;
    } else {
      const size = fs.statSync(file).size;
      dirDeletable++;
      dirBytes += size;
      totalDeletable++;
      totalDeletableBytes += size;
      deletableFiles.push({ file, rel: relFromRoot, size, label: target.label });
    }
  }

  console.log(`${target.label.padEnd(45)} | Scanned: ${candidates.length.toString().padStart(4)} | Keep: ${dirKept.toString().padStart(4)} | Delete: ${dirDeletable.toString().padStart(4)} (${(dirBytes / 1048576).toFixed(1)} MB)`);
}

if (ephemeralRunners.length > 0) {
  console.log(`Ephemeral Blockout Runners (Leftover Test HTML) | Found: ${ephemeralRunners.length.toString().padStart(6)} | Delete: ${ephemeralRunners.length.toString().padStart(4)}`);
  for (const r of ephemeralRunners) {
    const size = fs.statSync(r).size;
    totalDeletable++;
    totalDeletableBytes += size;
    deletableFiles.push({ file: r, rel: path.relative(rootDir, r), size, label: 'Ephemeral HTML Runner' });
  }
}

console.log('\n======================================================================');
console.log(`AUDIT SUMMARY: ${totalDeletable} unneeded media files identified (${(totalDeletableBytes / 1048576).toFixed(1)} MB total)`);
console.log(`PRESERVED: ${totalKept} referenced active assets 100% untouched`);
console.log('======================================================================\n');

if (isPrune) {
  console.log('🗑️  Pruning unneeded media files...');
  let prunedCount = 0;
  for (const item of deletableFiles) {
    try {
      fs.unlinkSync(item.file);
      prunedCount++;
    } catch (err) {
      console.error(`Failed to delete ${item.rel}: ${err.message}`);
    }
  }
  console.log(`✅ Successfully pruned ${prunedCount} unneeded media files!`);
} else {
  console.log('To prune these files, run with --prune:');
  console.log('  node scripts/audit_and_prune_dead_media.cjs --prune\n');
}
