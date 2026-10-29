import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { polishRemesh } from '../src/node/3d-engine/staged-location/remesh-polish';
import { writeStagedGlbFile } from '../src/node/3d-engine/staged-location/staged-glb-writer';
import { parseGlbBytes, readAccessor } from '../src/node/3d-engine/staged-location/glb-bytes';

/** A 10 x 30 x 10 m box wound outward, each side a 1 m grid; the +x side wound inward when `inward`. */
function box(inward: boolean): Float32Array {
    const out: number[] = [];
    // a side: origin o, axes a and b (a x b points outward), sizes na x nb metres
    const side = (o: number[], a: number[], b: number[], na: number, nb: number, flip: boolean) => {
        for (let i = 0; i < na; i++) for (let j = 0; j < nb; j++) {
            const p = (x: number, y: number) => [0, 1, 2].map(k => o[k] + a[k] * x + b[k] * y);
            const q = [p(i, j), p(i + 1, j), p(i + 1, j + 1), p(i, j + 1)];
            const tris = flip ? [[0, 2, 1], [0, 3, 2]] : [[0, 1, 2], [0, 2, 3]];
            for (const t of tris) for (const v of t) out.push(...q[v]);
        }
    };
    side([10, 0, 0], [0, 0, -1], [0, 1, 0], 10, 30, inward); // +x: (0,0,-1) x (0,1,0) = (1,0,0)
    side([0, 0, -10], [0, 0, 1], [0, 1, 0], 10, 30, false); // -x
    side([0, 0, 0], [1, 0, 0], [0, 1, 0], 10, 30, false); // +z
    side([10, 0, -10], [-1, 0, 0], [0, 1, 0], 10, 30, false); // -z
    side([0, 30, 0], [1, 0, 0], [0, 0, -1], 10, 10, false); // top
    side([0, 0, -10], [1, 0, 0], [0, 0, 1], 10, 10, false); // bottom
    return Float32Array.from(out);
}

function glb(soup: Float32Array): Buffer {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'polish-steps-')), 'scan.glb');
    writeStagedGlbFile(file, [{ name: 'scan', positions: soup, indices: Uint32Array.from({ length: soup.length / 3 }, (_, i) => i) }], {});
    return fs.readFileSync(file);
}


describe('the polish keeps each step\'s result for the node graph', () => {
    it('writes the model after each step that ran, the last one equal to the polished output', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'polish-steps-'));
        const clay = path.join(dir, 'clay.glb');
        fs.writeFileSync(clay, glb(box(true)));
        const steps: string[] = [];
        const pol = polishRemesh({ clayGlb: clay, cacheKey: 'k', cleanup: false, orient: true, lattice: false, onStep: (s, st) => steps.push(`${s}:${st}`) });
        expect(steps).toEqual(['orient:running', 'orient:done']);
        expect(Object.keys(pol.snapshots)).toEqual(['orient']);
        expect(fs.readFileSync(pol.snapshots.orient).equals(fs.readFileSync(pol.clayGlb))).toBe(true);
        // a real mesh: glTF magic and the box's triangles
        const bytes = fs.readFileSync(pol.snapshots.orient);
        expect(bytes.readUInt32LE(0)).toBe(0x46546c67);
        const g = parseGlbBytes(bytes);
        expect(readAccessor(g, g.json.meshes[0].primitives[0].indices).data.length).toBe(box(true).length / 3);
        // a cache hit still names the snapshots
        expect(polishRemesh({ clayGlb: clay, cacheKey: 'k', cleanup: false, orient: true, lattice: false }).snapshots).toEqual(pol.snapshots);
    });

    it('names no snapshot when nothing runs', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'polish-steps-'));
        const clay = path.join(dir, 'clay.glb');
        fs.writeFileSync(clay, glb(box(false)));
        expect(polishRemesh({ clayGlb: clay, cacheKey: 'k', cleanup: false, orient: false, lattice: false }).snapshots).toEqual({});
    });
});
