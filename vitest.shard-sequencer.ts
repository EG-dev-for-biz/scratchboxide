import * as fs from 'fs';
import * as path from 'path';
import type { TestSequencer, Vitest, WorkspaceSpec } from 'vitest/node';

// `vitest run --shard=i/n` cut into shards of equal measured time, not vitest's equal file counts in hash order, which
// on the 2-vCPU Ubuntu CI runner put several of the slowest files in one shard that outlasted the job limit while
// others finished in minutes. Each file weighs its time in vitest.shard-durations.json (measured on that runner;
// refresh it with scripts/update_shard_durations.mjs), a file not in it the median, plus the time it takes to load;
// the files go slowest first, each to the shard with the least time so far. Every shard computes the same split from
// the same file list, so together the shards run every file exactly once.
export default class DurationShardSequencer implements TestSequencer {
    // What a file costs on that runner besides its tests (import and collection): 233 files took 100 s more than theirs.
    static readonly LOAD_SECONDS = 0.45;

    private base?: Promise<TestSequencer>;

    constructor(private readonly ctx: Vitest) {}

    async shard(files: WorkspaceSpec[]): Promise<WorkspaceSpec[]> {
        const { index, count } = this.ctx.config.shard!;
        const root = this.ctx.config.root;
        const seconds: Record<string, number> = JSON.parse(fs.readFileSync(path.join(root, 'vitest.shard-durations.json'), 'utf8'));
        const measured = Object.values(seconds).sort((a, b) => a - b);
        const median = measured.length ? measured[Math.floor(measured.length / 2)] : 1;
        const weighed = files
            .map(spec => {
                const file = path.relative(root, spec.moduleId).split(path.sep).join('/');
                return { spec, file, weight: (seconds[file] ?? median) + DurationShardSequencer.LOAD_SECONDS };
            })
            .sort((a, b) => b.weight - a.weight || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
        const loads = new Array<number>(count).fill(0);
        const mine: WorkspaceSpec[] = [];
        for (const { spec, weight } of weighed) {
            const lightest = loads.indexOf(Math.min(...loads));
            loads[lightest] += weight;
            if (lightest === index - 1) mine.push(spec);
        }
        return mine;
    }

    // vitest's own order. vitest/node is ESM only and this config is bundled as CommonJS, so it is loaded when needed.
    async sort(files: WorkspaceSpec[]): Promise<WorkspaceSpec[]> {
        this.base ??= import('vitest/node').then(({ BaseSequencer }) => new BaseSequencer(this.ctx));
        return (await this.base).sort(files);
    }
}
