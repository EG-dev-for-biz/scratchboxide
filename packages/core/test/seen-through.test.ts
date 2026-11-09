import { describe, expect, it } from 'vitest';
import { seenThroughClusters, seenThroughEvidence, seenThroughJudge } from '../src/node/3d-engine/staged-location/seen-through';
import type { ProudGrid } from '../src/node/3d-engine/staged-location/vehicle-removal';
import type { GroundModel } from '../src/node/spatial/StreetViewSurveyPlanner';
import type { SeenPoint } from '../src/node/3d-engine/staged-location/pano-drive-registration';

/**
 * A flat street at y = 0 with one 3 m tall block standing on it (x 4-6, z -1..1), cells of 0.25 m. Cameras at 2.5 m look
 * past the block at a facade at x = 12.
 */
function street(): { grid: ProudGrid; ground: GroundModel } {
    const cellM = 0.25, x0 = -2, z0 = -5, nx = 64, nz = 40;
    const rel = new Float32Array(nx * nz).fill(0), comp = new Int32Array(nx * nz).fill(-1), st = new Uint8Array(nx * nz).fill(1);
    for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) {
        const x = x0 + (i + 0.5) * cellM, z = z0 + (k + 0.5) * cellM;
        if (x >= 4 && x <= 6 && z >= -1 && z <= 1) { rel[k * nx + i] = 3; comp[k * nx + i] = 0; }
    }
    const ground = { groundAt: () => 0 } as unknown as GroundModel;
    return { grid: { x0, z0, nx, nz, cellM, rel, comp, street: st }, ground };
}
const pt = (X: [number, number, number], a: [number, number, number], b: [number, number, number], pa: string, pb: string): SeenPoint => ({ X, eyes: [a, b], panos: [pa, pb] });

describe('seen-through', () => {
    it('counts lines of sight that pass under a block\'s top and over the street, short of the point they see', () => {
        const { grid, ground } = street();
        // a point on the facade behind the block, seen from two panoramas: both lines cross the block at 1-2 m
        const through = pt([12, 1, 0], [0, 2.5, 0.2], [0, 2.5, -0.2], 'p1', 'p2');
        // a point seen over the block (the lines pass above its 3 m top), and one short of it
        const over = pt([12, 7, 0], [0, 2.5, 0.3], [0, 2.5, -0.3], 'p1', 'p2');
        const short = pt([4.5, 1, 0], [0, 2.5, 0], [0, 2.5, 0.1], 'p1', 'p2');
        const ev = seenThroughEvidence(grid, ground, [through, over, short]);
        expect(ev.lines).toBe(6);
        expect(ev.blocked).toBe(2);
        const cells = [...ev.panos.keys()];
        expect(cells.length).toBeGreaterThan(0);
        for (const c of cells) expect(grid.comp[c]).toBe(0);
    });

    it('boxes the block only when lines from two panoramas pass through it, in tight tiles', async () => {
        const { grid, ground } = street();
        const frame = { x0: -2, z0: -5, widthM: 16, heightM: 10 };
        const onePano = seenThroughEvidence(grid, ground, [pt([12, 1, 0], [0, 2.5, 0.2], [0, 2.5, -0.2], 'p1', 'p1'), pt([12, 1.2, 0.5], [0, 2.5, 0.4], [0, 2.5, 0], 'p1', 'p1')]);
        expect(seenThroughClusters(onePano, frame)).toHaveLength(0);
        const pts: SeenPoint[] = [];
        for (let k = 0; k < 6; k++) pts.push(pt([12, 1 + 0.1 * k, -0.6 + 0.24 * k], [0, 2.5, -0.5 + 0.2 * k], [-1, 2.5, 0.4 - 0.15 * k], 'p1', 'p2'));
        const ev = seenThroughEvidence(grid, ground, pts);
        const boxes = seenThroughClusters(ev, frame);
        expect(boxes.length).toBeGreaterThan(0);
        for (const b of boxes) {
            expect(b.lo[0]).toBeGreaterThanOrEqual(4 - 1e-9); expect(b.hi[0]).toBeLessThanOrEqual(6.25);
            expect(b.hi[0] - b.lo[0]).toBeLessThanOrEqual(4 + 1e-9); expect(b.hi[1] - b.lo[1]).toBeLessThanOrEqual(4 + 1e-9);
            expect(b.panos).toBe(2);
        }
        const readings = await seenThroughJudge(ev)({ index: 3, frame, jpeg: Buffer.alloc(0), widthPx: 1, heightPx: 1, texelM: 0.1 });
        expect(readings.length).toBe(boxes.length);
        expect(readings[0].permanent).toBe(false);
        expect(readings[0].crop).toBe(3);
        expect(readings[0].label).toMatch(/2 registered Street View panoramas/);
    });
});
