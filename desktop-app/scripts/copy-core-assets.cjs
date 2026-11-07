/**
 * The standalone (Electron) build compiles @scratchbox/core's TypeScript into dist-electron/packages/core/src, but tsc
 * emits only JavaScript: files the code reads beside itself at run time (packages/core/data, such as the EGM96 geoid grid
 * the 3D Tiles extraction needs, and the non-TypeScript files under packages/core/src: Python sidecars, data JSON,
 * styles, icons) would be missing, and every build that reads one would fail. This copies them into dist-electron at the
 * same relative paths. The native engine's sources are left out: they are compiled from the checkout's own tree.
 *
 *   node scripts/copy-core-assets.cjs [outDir]   (default: dist-electron, beside this script's package)
 */
const fs = require('fs');
const path = require('path');

const CORE = path.resolve(__dirname, '../../packages/core');
const SKIP_DIRS = new Set(['native', 'node_modules', '__pycache__']);
const SKIP_EXT = new Set(['.ts', '.tsx']);

function copyTree(from, to, filter, counts) {
    if (!fs.existsSync(from)) return;
    for (const e of fs.readdirSync(from, { withFileTypes: true })) {
        const src = path.join(from, e.name);
        const dst = path.join(to, e.name);
        if (e.isDirectory()) {
            if (SKIP_DIRS.has(e.name)) continue;
            copyTree(src, dst, filter, counts);
        } else if (e.isFile() && filter(e.name)) {
            fs.mkdirSync(to, { recursive: true });
            fs.copyFileSync(src, dst);
            counts.files++;
            counts.bytes += fs.statSync(src).size;
        }
    }
}

/** Copies core's run-time files into `outDir`; returns what was copied. */
function copyCoreAssets(outDir) {
    const counts = { files: 0, bytes: 0 };
    const base = path.join(outDir, 'packages', 'core');
    copyTree(path.join(CORE, 'data'), path.join(base, 'data'), () => true, counts);
    copyTree(path.join(CORE, 'src'), path.join(base, 'src'), name => !SKIP_EXT.has(path.extname(name)) && !name.endsWith('.d.ts'), counts);
    return counts;
}

module.exports = { copyCoreAssets };

if (require.main === module) {
    const outDir = path.resolve(process.argv[2] ?? path.join(__dirname, '..', 'dist-electron'));
    const c = copyCoreAssets(outDir);
    console.log(`copied ${c.files} core run-time files (${(c.bytes / 1e6).toFixed(1)} MB) into ${outDir}`);
}
