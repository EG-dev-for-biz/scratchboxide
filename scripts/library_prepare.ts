/**
 * Fills the prepared texture library (packages/core/src/node/3d-engine/prepared-library.ts): every library set with a
 * known tile size (the ones the material regions can choose) fetched, prepared by the engine exactly as a build prepares
 * it (material-sets.ts fetchAndPrepareSets) and kept in GCS, with its publisher previews. A set already there is skipped.
 * Run it where the library bucket is near (a Cloud Run job: deploy.sh library-prepare), the sets shared across the job's
 * tasks (CLOUD_RUN_TASK_INDEX / CLOUD_RUN_TASK_COUNT); each set's full maps are deleted once it is prepared.
 *
 *   node -r ts-node/register scripts/library_prepare.ts [--ids a,b,c] [--limit n]
 */
import * as fs from 'fs';
import * as path from 'path';

function arg(name: string): string | undefined {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
    const { preparedLibrary } = await import('../packages/core/src/node/3d-engine/prepared-library');
    const { fetchAndPrepareSets, PREPARED_VERSION, PREPARED_SIZE, libraryRepoRoot } = await import('../packages/core/src/node/3d-engine/staged-location/pipeline-k/material-sets');
    const { loadTextureLibraryIndex, libraryPreview } = await import('../packages/core/src/node/3d-engine/texture-library');
    const lib = preparedLibrary();
    if (!lib) throw new Error('no prepared library (SCRATCHBOX_PREPARED_LIBRARY is off, or no training bucket)');
    const repoRoot = libraryRepoRoot();
    const index = loadTextureLibraryIndex(repoRoot);
    if (!index) throw new Error(`no texture library index under ${repoRoot}`);
    const ids = arg('ids')?.split(',').map(s => s.trim()).filter(Boolean);
    const all = index.sets.filter(e => (ids ? ids.includes(e.id) : !!e.realSizeM)).sort((a, b) => a.id.localeCompare(b.id));
    const task = Number(process.env.CLOUD_RUN_TASK_INDEX ?? 0), tasks = Math.max(1, Number(process.env.CLOUD_RUN_TASK_COUNT ?? 1));
    const mine = all.filter((_, i) => i % tasks === task).slice(0, Number(arg('limit') ?? Infinity));
    console.log(`[library-prepare] task ${task + 1} of ${tasks}: ${mine.length} of ${all.length} sets into ${lib.label}`);
    let prepared = 0, kept = 0, failed = 0, previews = 0;
    const t0 = Date.now();
    for (const e of mine) {
        try {
            if (await lib.getMaps(PREPARED_VERSION, PREPARED_SIZE, e.id)) kept++;
            else {
                const maps = (await fetchAndPrepareSets([e.id], { repoRoot })).get(e.id);
                if (!maps) throw new Error('nothing prepared');
                await lib.putMaps(PREPARED_VERSION, PREPARED_SIZE, e.id, { normal: Buffer.from(maps.normal).toString('base64'), orm: Buffer.from(maps.orm).toString('base64') });
                prepared++;
            }
            // the previews the ranking, the pick by look and the height maps read (libraryPreview keeps them in the library)
            for (const role of ['color', ...(e.maps.height ? ['height'] : [])] as Array<'color' | 'height'>) if (await libraryPreview(e, role, repoRoot).catch(() => undefined)) previews++;
        } catch (err) {
            failed++;
            console.error(`[library-prepare] ${e.id}: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
            fs.rmSync(path.join(repoRoot, 'build', 'texture-library', e.id), { recursive: true, force: true });
        }
        if ((prepared + kept + failed) % 20 === 0) console.log(`[library-prepare] ${prepared + kept + failed} of ${mine.length}: ${prepared} prepared, ${kept} already there, ${failed} failed (${Math.round((Date.now() - t0) / 1000)} s)`);
    }
    console.log(`[library-prepare] done: ${prepared} prepared, ${kept} already there, ${failed} failed, ${previews} previews, in ${Math.round((Date.now() - t0) / 1000)} s`);
    if (failed && !prepared && !kept) process.exitCode = 1;
}

main().catch(err => { console.error(err); process.exit(1); });
