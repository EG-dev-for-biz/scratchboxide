import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    SHARP_CHECKPOINT_NAME, SHARP_FLOOR_FOV_DEG, SHARP_LEVEL_FOV_DEG, SHARP_STREET_VERSION, SHARP_VIEW_SIZE,
    SharpStreetSplatService, sharpPanoViews, sharpStreetAvailability
} from '../src/node/spatial/SharpStreetSplatService';

/** The SHARP street step: what it asks of each panorama, and that a machine without SHARP is told so, with nothing made. */
describe('SHARP street splats', () => {
    let tmp: string;
    beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sb_sharp_test_')); });
    afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

    it('asks four level views a quarter turn apart and one straight down, all from the corrected eye', () => {
        const views = sharpPanoViews({
            panoId: 'p', eye: [10, 2.5, -4], method: 'drive',
            correction: { dx: 1, dy: 0.5, dz: -2, dyawDeg: 0, dpitchDeg: 0, drollDeg: 0, referenceHeadingDeg: 0 } as any
        });
        expect(views.map(v => v.name)).toEqual(['h0', 'h90', 'h180', 'h270', 'floor']);
        for (const v of views) {
            expect(v.camera.eye).toEqual([11, 3, -6]);
            expect(v.camera.width).toBe(SHARP_VIEW_SIZE);
            expect(v.camera.fx).toBeCloseTo(SHARP_VIEW_SIZE / 2 / Math.tan((v.hfovDeg * Math.PI) / 360), 3);
        }
        expect(views.slice(0, 4).every(v => v.hfovDeg === SHARP_LEVEL_FOV_DEG)).toBe(true);
        expect(views[4].hfovDeg).toBe(SHARP_FLOOR_FOV_DEG);
        // scan frame: x east, y up, z south. Heading 0 looks north (-z), 90 east (+x); the floor view looks down
        expect(views[0].camera.fwd[2]).toBeCloseTo(-1, 5);
        expect(views[1].camera.fwd[0]).toBeCloseTo(1, 5);
        expect(views[2].camera.fwd[2]).toBeCloseTo(1, 5);
        expect(views[3].camera.fwd[0]).toBeCloseTo(-1, 5);
        expect(views[4].camera.fwd[1]).toBeLessThan(-0.9999);
    });

    it('says why it cannot run: switched off, no interpreter, no checkpoint', () => {
        expect(sharpStreetAvailability({ SCRATCHBOX_STREET_SHARP: '0' }, tmp)).toEqual({ reason: 'off (SCRATCHBOX_STREET_SHARP=0)' });
        const none = sharpStreetAvailability({}, tmp);
        expect('reason' in none && none.reason).toMatch(/not installed: no interpreter/);
        const python = path.join(tmp, '.cache', 'scratchbox-sharp', 'venv', 'bin', 'python');
        fs.mkdirSync(path.dirname(python), { recursive: true });
        fs.writeFileSync(python, '');
        const noWeights = sharpStreetAvailability({ SCRATCHBOX_SHARP_CHECKPOINT: path.join(tmp, 'missing.pt') }, tmp);
        expect('reason' in noWeights && noWeights.reason).toMatch(/no checkpoint/);
        const checkpoint = path.join(tmp, '.cache', 'scratchbox-sharp', SHARP_CHECKPOINT_NAME);
        fs.writeFileSync(checkpoint, '');
        expect(sharpStreetAvailability({ SCRATCHBOX_SHARP_CHECKPOINT: checkpoint }, tmp)).toEqual({ python, checkpoint });
    });

    it('leaves the base layer untouched and makes nothing when it cannot run', async () => {
        const base = path.join(tmp, 'fused.splat');
        const rows = Buffer.alloc(64, 7);
        fs.writeFileSync(base, rows);
        const saved = { ...process.env };
        process.env.SCRATCHBOX_STREET_SHARP = '0';
        try {
            const report = await new SharpStreetSplatService().run({
                glbPath: path.join(tmp, 'none.glb'), panos: [{ panoId: 'p', eye: [0, 2.5, 0], method: 'nominal' }],
                baseSplatPath: base, outSplatPath: base, workDir: path.join(tmp, 'work'),
                fetchViews: async () => { throw new Error('must not fetch'); }
            });
            expect(report).toEqual({ ran: false, reason: 'off (SCRATCHBOX_STREET_SHARP=0)' });
        } finally {
            process.env = saved;
        }
        expect(fs.readFileSync(base).equals(rows)).toBe(true);
        expect(fs.existsSync(path.join(tmp, 'work'))).toBe(false);
    });

    it('reports a failed panorama by its reason and keeps the base layer when none could be drawn', async () => {
        const python = path.join(tmp, 'python'), checkpoint = path.join(tmp, 'w.pt'), base = path.join(tmp, 'fused.splat');
        fs.writeFileSync(python, ''); fs.writeFileSync(checkpoint, '');
        const rows = Buffer.alloc(96, 3);
        fs.writeFileSync(base, rows);
        // a GLB that cannot be read: the step fails before any view is fetched, and says so
        const report = await new SharpStreetSplatService().run({
            glbPath: path.join(tmp, 'none.glb'), panos: [{ panoId: 'p', eye: [0, 2.5, 0], method: 'nominal' }],
            baseSplatPath: base, outSplatPath: base, workDir: path.join(tmp, 'work'), pythonExecutable: python, checkpoint,
            fetchViews: async () => { throw new Error('must not fetch'); }
        });
        expect(report.ran).toBe(false);
        expect(!report.ran && report.reason).toMatch(/SHARP street step failed/);
        expect(SHARP_STREET_VERSION).toBe(5);
        expect(fs.readFileSync(base).equals(rows)).toBe(true);
        expect(fs.existsSync(path.join(tmp, 'work'))).toBe(false);
    });

    // the worker's cleanup formulas, on made-up arrays (numpy and scipy only: no model, no photograph)
    const PYTHON = process.env.SCRATCHBOX_SHARP_PYTHON || 'python3';
    const hasNumpy = spawnSync(PYTHON, ['-c', 'import numpy, scipy'], { encoding: 'utf8' }).status === 0;
    const worker = (code: string) => {
        const run = spawnSync(PYTHON, ['-c', `import sys, json\nsys.path.insert(0, ${JSON.stringify(path.resolve(__dirname, '../../../tools/depth'))})\nimport numpy as np\nimport sharp_street_worker as w\n${code}`], { encoding: 'utf8' });
        if (run.status !== 0) throw new Error(run.stderr);
        return JSON.parse(run.stdout.trim().split('\n').pop()!);
    };

    it.skipIf(!hasNumpy)('drops the splats hanging between a near and a far surface, and none on either surface or on a sloping one', () => {
        const out = worker(`
g = 768
vv, uu = np.mgrid[0:g, 0:g]
u = ((uu.reshape(-1) + 0.5) * 640 / g).astype(np.float32)
v = ((vv.reshape(-1) + 0.5) * 640 / g).astype(np.float32)
# layer 0: a wall 5 m away on the left, one 20 m away on the right, and a 3-column curtain between them at the edge
z0 = np.where(u < 320, 5.0, 20.0)
col = uu.reshape(-1) - g // 2
curtain = (col >= 0) & (col < 3)
z0[curtain] = 8.0 + 3.0 * col[curtain]
# layer 1: ground receding 3% a column: steep, and no streak
z1 = 4.0 * 1.03 ** (uu.reshape(-1) / 4.0)
u2, v2, z = np.concatenate([u, u + 0.6]), np.concatenate([v, v + 0.6]), np.concatenate([z0, z1])
layers = w.splat_layers(u2, v2)
m = w.streak_mask(u2, v2, z, np.ones(len(z), bool), 640)
n = len(u)
print(json.dumps({"layers": [len(l) for l in layers], "curtain": int(curtain.sum()), "curtainHit": int(m[:n][curtain].sum()),
                  "wallHit": int(m[:n][~curtain].sum()), "groundHit": int(m[n:].sum())}))
`);
        expect(out.layers).toEqual([589824, 589824]);
        expect(out.curtain).toBe(2304);
        expect(out.curtainHit).toBe(2304);
        expect(out.wallHit).toBe(0);
        expect(out.groundHit).toBe(0);
    });

    it.skipIf(!hasNumpy)('holds an edit that only removed something, and refuses one that moved or replaced the view', () => {
        const out = worker(`
rng = np.random.default_rng(11)
img = np.full((640, 640, 3), 120, np.uint8)
for _ in range(40):   # a street of rectangles: walls, windows, markings
    x, y, w_, h = rng.integers(0, 560), rng.integers(0, 560), rng.integers(20, 80), rng.integers(20, 80)
    img[y:y + h, x:x + w_] = rng.integers(0, 255, 3)
removed = img.copy()
removed[400:520, 200:420] = 120            # a vehicle painted out
moved = np.roll(img, 16, axis=1)           # the same view, 16 px to the right
other = rng.integers(0, 255, (640, 640, 3)).astype(np.uint8)
res = {k: w.framing_held(img, v) for k, v in {"same": img, "removed": removed, "moved": moved, "other": other}.items()}
print(json.dumps({k: {"held": r[0], "ncc": round(r[1], 3), "shift": list(r[2])} for k, r in res.items()}))
`);
        expect(out.same).toEqual({ held: true, ncc: 1, shift: [0, 0] });
        expect(out.removed.held).toBe(true);
        expect(out.removed.shift).toEqual([0, 0]);
        expect(out.removed.ncc).toBeGreaterThan(0.6);
        expect(out.moved.held).toBe(false);
        expect(out.moved.shift).toEqual([4, 0]);
        expect(out.other.held).toBe(false);
    });

    it.skipIf(!hasNumpy)('hard cells: each panorama keeps only the splats nearer to it on the plan than to any other', () => {
        const out = worker(`
eyes = [[0.0, 2.5, 0.0], [10.0, 2.5, 0.0]]
# both panoramas predict the same row of splats along x, one every metre from -2 to 12, at two heights
xs = np.arange(-2.0, 12.5, 1.0)
def row(height):
    s = np.zeros(len(xs), w.ROW)
    s["p"] = np.stack([xs, np.full(len(xs), height), np.full(len(xs), 0.5)], 1)
    s["s"] = 0.05
    return s
keep0 = w.cell_keep(row(1.0)["p"], 0, eyes)
keep1 = w.cell_keep(row(20.0)["p"], 1, eyes)
merged, counts = w.merge_splats([row(1.0), row(1.0)], eyes, None, 10_000, None, True)
print(json.dumps({"n": len(xs), "keep0": xs[keep0].tolist(), "keep1": xs[keep1].tolist(),
                  "outsideCell": counts["outsideCell"], "doubled": counts["doubled"], "perPano": counts["perPano"], "street": counts["street"]}))
`);
        // the cut is the line halfway between the eyes (x = 5), at any height; a splat on it belongs to the first panorama only
        expect(out.keep0).toEqual([-2, -1, 0, 1, 2, 3, 4, 5]);
        expect(out.keep1).toEqual([6, 7, 8, 9, 10, 11, 12]);
        expect(out.perPano).toEqual([8, 7]);
        expect(out.street).toBe(out.n);
        expect(out.outsideCell).toBe(out.n);
        expect(out.doubled).toBe(0);
    });

    it.skipIf(!hasNumpy)('keeps the base layer above a panorama\'s street top, and replaces it below where street splats stand', () => {
        const out = worker(`
rng = np.random.default_rng(3)
street = np.zeros(400, w.ROW)
street["p"] = np.stack([rng.uniform(0.1, 0.9, 400), np.linspace(0, 6.99, 400), rng.uniform(0.1, 0.9, 400)], 1)
street["s"] = 0.05
base = np.zeros(4, w.ROW)
base["p"] = [[0.5, 0.0, 0.5], [0.5, 5.5, 0.5], [0.5, 6.5, 0.5], [0.5, 30.0, 0.5]]
base["s"] = 0.1
eyes = [[0.5, 2.5, 0.5]]
_, capped = w.merge_splats([street.copy()], eyes, base.copy(), 10_000, [6.0])
_, plain = w.merge_splats([street.copy()], eyes, base.copy(), 10_000)
print(json.dumps({"capped": {k: capped[k] for k in ("baseKept", "baseReplaced", "baseKeptAboveStreet", "street")},
                  "plain": {k: plain.get(k, 0) for k in ("baseKept", "baseReplaced", "baseKeptAboveStreet")}}))
`);
        // voxels of 2 m from 1 m under the lowest splat: [5, 7) holds street splats and the base splats at 5.5 and 6.5
        expect(out.plain).toEqual({ baseKept: 1, baseReplaced: 3, baseKeptAboveStreet: 0 });
        expect(out.capped).toEqual({ baseKept: 2, baseReplaced: 2, baseKeptAboveStreet: 1, street: 400 });
    });
});
