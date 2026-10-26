/**
 * Publishes the PBR texture library's index beside its Cloud Storage copy, so the matcher (pbr-library-match.ts) can shortlist
 * without downloading maps: gs://<library>_index/index.json (every material and its maps by role) and
 * gs://<library>_index/thumbs/<name>.jpg (160 px). Reads the local copy of the library; uses the app's service account.
 *
 *   npx vite-node scripts/publish_pbr_library_index.ts --local "/Volumes/G-RAID MIRROR/PBR_Textures_Library" \
 *     [--library gs://scoutscan-pbr-library/PBR_Textures_Library] [--thumbs-from <dir of <name>.jpg made earlier>]
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { cloudStore, DEFAULT_PBR_LIBRARY, PBR_INDEX_SUFFIX, publishPbrLibraryIndex } from '../packages/core/src/node/spatial/pbr-library-match';

async function main() {
    const argv = process.argv.slice(2);
    const arg = (k: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
    const local = arg('--local');
    if (!local) throw new Error('usage: --local <library folder> [--library gs://...] [--thumbs-from <dir>]');
    const library = arg('--library') ?? DEFAULT_PBR_LIBRARY;
    const thumbsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pbr-thumbs-'));
    // thumbnails made earlier are copied into the layout openPbrLibrary uses (<cacheDir>/<location>/thumbs)
    const from = arg('--thumbs-from');
    if (from) {
        const dest = path.join(thumbsDir, local.replace(/[^a-z0-9]+/gi, '_'), 'thumbs');
        fs.mkdirSync(dest, { recursive: true });
        for (const f of fs.readdirSync(from)) if (f.endsWith('.jpg')) fs.copyFileSync(path.join(from, f), path.join(dest, f));
    }
    const index = await publishPbrLibraryIndex(local, library, await cloudStore(`${library}${PBR_INDEX_SUFFIX}`), { thumbsDir, concurrency: 16, onProgress: m => console.log(m) });
    console.log(`published ${index.materials.length} materials to ${library}${PBR_INDEX_SUFFIX}/index.json`);
}
main().catch(e => { console.error(e); process.exit(1); });
