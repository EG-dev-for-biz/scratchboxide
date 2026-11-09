/**
 * One district chunk built on this machine from a cloud job's request (kd-jobs/<run>/<chunk>/request.json), with the
 * services a job task makes, under the run id the job used: for profiling a chunk (run under node --cpu-prof) or
 * comparing its layers with the job's. Writes its outcome beside the request.
 *
 *   SCRATCHBOX_KD_CHUNK_JOB=1 SCRATCHBOX_CPUS=8 node -r ts-node/register scripts/kd_chunk_local.ts --request <request.json> --root <workspace>
 */
import * as fs from 'fs';
import * as path from 'path';

function arg(name: string): string | undefined {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
    const file = arg('request'), root = arg('root');
    if (!file || !root) throw new Error('--request and --root are required');
    const env = arg('env');
    if (env && fs.existsSync(env)) for (const line of fs.readFileSync(env, 'utf8').split('\n')) {
        const m = /^\s*([A-Z0-9_]+)\s*=\s*"?([^"\r\n]*)"?\s*$/.exec(line);
        if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
    }
    process.env.SCRATCHBOX_ROOT ??= path.resolve(root);
    const spec = JSON.parse(fs.readFileSync(file, 'utf8')) as { runId: string; request: Parameters<typeof import('../packages/core/src/node/3d-engine/staged-location/orchestrator').runStagedLocation>[0] };
    const { createStagedLocationDeps } = await import('../packages/core/src/node/3d-engine/staged-location/staged-location-tool');
    const { runStagedLocation } = await import('../packages/core/src/node/3d-engine/staged-location/orchestrator');
    const deps = await createStagedLocationDeps(path.resolve(root));
    const { prefetchTiles: _p, runChunk: _r, ...rest } = deps;
    const t0 = Date.now();
    const outcome = await runStagedLocation(spec.request, { ...rest, newRunId: () => spec.runId }, { reportProgress: m => console.log(`${((Date.now() - t0) / 1000).toFixed(1)} s  ${m}`) });
    fs.writeFileSync(path.join(path.dirname(file), 'local-outcome.json'), JSON.stringify(outcome, null, 1));
    console.log(`built (${outcome.result.status}) in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}

main().then(() => process.exit(0), err => { console.error(err); process.exit(1); });
