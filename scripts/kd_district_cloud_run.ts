/**
 * One pipeline K-D district built headless, as the app's server builds it (runStagedLocation with createStagedLocationDeps),
 * for timing: every chunk a Cloud Run job when SCRATCHBOX_KD_CHUNK_RUNNER=cloud, a task per building with
 * SCRATCHBOX_KD_CHUNK_UNIT=building. Writes the run's progress, its outcome and a timing summary (wall time, each chunk's
 * cloud seconds and cost) into --out.
 *
 *   SCRATCHBOX_KD_CHUNK_RUNNER=cloud SCRATCHBOX_KD_CHUNK_UNIT=building SCRATCHBOX_KD_CLOUD_PARALLEL=200 \
 *     node -r ts-node/register scripts/kd_district_cloud_run.ts --query "2 Penn Plaza, New York" --radius 150 \
 *     --root /Volumes/3DTESTING/Scratchbox-drive/kd-penn-fanout --out /Volumes/3DTESTING/Scratchbox-drive/kd-penn-fanout/report
 *
 * --root is the build's workspace (its stage caches and models; an empty one is a build from nothing on this side), --env
 * a .env file whose keys are added where unset (the Maps key; never printed).
 */
import * as fs from 'fs';
import * as path from 'path';

function arg(name: string, fallback?: string): string | undefined {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

function loadEnvFile(file: string | undefined): void {
    if (!file || !fs.existsSync(file)) return;
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        const m = /^\s*([A-Z0-9_]+)\s*=\s*"?([^"\r\n]*)"?\s*$/.exec(line);
        if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
    }
}

async function main(): Promise<void> {
    const query = arg('query', '2 Penn Plaza, New York')!;
    const radiusM = Number(arg('radius', '150'));
    const root = path.resolve(arg('root') ?? '');
    const out = path.resolve(arg('out') ?? path.join(root, 'report'));
    if (!arg('root')) throw new Error('--root is required (the build\'s workspace)');
    loadEnvFile(arg('env'));
    process.env.SCRATCHBOX_ROOT ??= root;
    fs.mkdirSync(out, { recursive: true });
    const { createStagedLocationDeps } = await import('../packages/core/src/node/3d-engine/staged-location/staged-location-tool');
    const { runStagedLocation } = await import('../packages/core/src/node/3d-engine/staged-location/orchestrator');
    const t0 = Date.now();
    const progressFile = path.join(out, 'progress.log');
    fs.writeFileSync(progressFile, '');
    const line = (m: string) => fs.appendFileSync(progressFile, `${String(Math.round((Date.now() - t0) / 1000)).padStart(6)} s  ${m}\n`);
    line(`district ${query}, ${radiusM} m; runner ${process.env.SCRATCHBOX_KD_CHUNK_RUNNER ?? 'local'}, unit ${process.env.SCRATCHBOX_KD_CHUNK_UNIT ?? 'cell'}, job ${process.env.SCRATCHBOX_KD_CLOUD_JOB ?? 'kd-chunk-job'}, width ${process.env.SCRATCHBOX_KD_CLOUD_PARALLEL ?? 'default'}`);
    const own = new AbortController();
    process.once('SIGINT', () => own.abort(Object.assign(new Error('stopped'), { name: 'AbortError' })));
    const deps = await createStagedLocationDeps(root, { signal: own.signal });
    const outcome = await runStagedLocation({ query, isolate: false, radiusM, trees: true, stageIntoActiveScene: false, district: 'kd' } as Parameters<typeof runStagedLocation>[0], deps, {
        signal: own.signal, reportProgress: m => line(m)
    });
    const wallMs = Date.now() - t0;
    line(`district built (${outcome.result.status}) in ${Math.round(wallMs / 1000)} s`);
    fs.writeFileSync(path.join(out, 'outcome.json'), JSON.stringify(outcome, null, 1));
    // each chunk's cloud record (cloud-job.json in its run record)
    const runs = path.join(root, '.scratchbox', 'cache', 'staged_location', 'runs');
    const chunks: Array<Record<string, unknown>> = [];
    for (const id of fs.existsSync(runs) ? fs.readdirSync(runs) : []) {
        const f = path.join(runs, id, 'cloud-job.json');
        if (fs.existsSync(f)) chunks.push({ runId: id, ...JSON.parse(fs.readFileSync(f, 'utf8')) });
    }
    fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify({ query, radiusM, wallMs, status: outcome.result.status, runId: outcome.result.runId ?? undefined, env: Object.fromEntries(Object.entries(process.env).filter(([k]) => /^SCRATCHBOX_(KD_|CACHE_|PLACE_|MODEL_CALL)/.test(k))), chunks }, null, 1));
}

main().then(() => process.exit(0), err => { console.error(err); process.exit(1); });
