import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { polishRemesh, type PolishedRemesh } from '../src/node/3d-engine/staged-location/remesh-polish';
import { RemeshWorkerError, runRemeshJob } from '../src/node/3d-engine/staged-location/remesh-worker-pool';
import { writeStagedGlbFile } from '../src/node/3d-engine/staged-location/staged-glb-writer';

/** A 10 x 30 x 10 m box, each side a 1 m grid, its +x side wound inward (so the orient step turns it). */
function box(): Float32Array {
    const out: number[] = [];
    const side = (o: number[], a: number[], b: number[], na: number, nb: number, flip: boolean) => {
        for (let i = 0; i < na; i++) for (let j = 0; j < nb; j++) {
            const p = (x: number, y: number) => [0, 1, 2].map(k => o[k] + a[k] * x + b[k] * y);
            const q = [p(i, j), p(i + 1, j), p(i + 1, j + 1), p(i, j + 1)];
            for (const t of flip ? [[0, 2, 1], [0, 3, 2]] : [[0, 1, 2], [0, 2, 3]]) for (const v of t) out.push(...q[v]);
        }
    };
    side([10, 0, 0], [0, 0, -1], [0, 1, 0], 10, 30, true);
    side([0, 0, -10], [0, 0, 1], [0, 1, 0], 10, 30, false);
    side([0, 0, 0], [1, 0, 0], [0, 1, 0], 10, 30, false);
    side([10, 0, -10], [-1, 0, 0], [0, 1, 0], 10, 30, false);
    side([0, 30, 0], [1, 0, 0], [0, 0, -1], 10, 10, false);
    side([0, 0, -10], [1, 0, 0], [0, 0, 1], 10, 10, false);
    return Float32Array.from(out);
}

function clayIn(dir: string): string {
    const file = path.join(dir, 'clay.glb'), soup = box();
    writeStagedGlbFile(file, [{ name: 'scan', positions: soup, indices: Uint32Array.from({ length: soup.length / 3 }, (_, i) => i) }], {});
    return file;
}

describe('the remesh steps on worker threads', () => {
    it('polishes on a thread of its own to the same bytes as on this thread, its steps passed back', async () => {
        const here = clayIn(fs.mkdtempSync(path.join(os.tmpdir(), 'remesh-pool-a-'))), there = clayIn(fs.mkdtempSync(path.join(os.tmpdir(), 'remesh-pool-b-')));
        const local = polishRemesh({ clayGlb: here, cacheKey: 'k', cleanup: false, orient: true, lattice: false });
        const steps: string[] = [];
        const worker = await runRemeshJob<PolishedRemesh>({ kind: 'polish', input: { clayGlb: there, cacheKey: 'k', cleanup: false, orient: true, lattice: false } }, { onStep: (s, st) => steps.push(`${s}:${st}`) });
        expect(steps).toEqual(['orient:running', 'orient:done']);
        // the stats but their timings
        const untimed = (o: unknown): unknown => JSON.parse(JSON.stringify(o, (k, v) => (k === 'ms' ? undefined : v)));
        expect(untimed(worker.stats)).toEqual(untimed(local.stats));
        const bytes = fs.readFileSync(worker.clayGlb);
        expect(bytes.readUInt32LE(0)).toBe(0x46546c67);
        expect(bytes.equals(fs.readFileSync(local.clayGlb))).toBe(true);
    }, 120_000);

    it('rejects with the step and its error when a job throws on its thread', async () => {
        const missing = path.join(os.tmpdir(), `remesh-pool-missing-${process.pid}`);
        await expect(runRemeshJob({ kind: 'wallGrammar', orthosDir: missing, fit: { version: 'x', params: {} as never, ms: 0, facades: [] } })).rejects.toThrow(RemeshWorkerError);
        await expect(runRemeshJob({ kind: 'wallGrammar', orthosDir: missing, fit: { version: 'x', params: {} as never, ms: 0, facades: [] } })).rejects.toThrow(/wallGrammar failed on a worker thread/);
    }, 120_000);

    it('stops at once when the stage is stopped', async () => {
        const ctl = new AbortController();
        ctl.abort(new Error('stopped by the user'));
        await expect(runRemeshJob({ kind: 'polish', input: { clayGlb: 'nowhere.glb', cacheKey: 'k' } }, { signal: ctl.signal })).rejects.toThrow('stopped by the user');
    });
});
