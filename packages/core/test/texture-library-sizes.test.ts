import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseSizes, previewSheet, scoreEstimates, sizePrompt } from '../src/node/3d-engine/texture-library-sizes';
import { loadTextureLibraryIndex } from '../src/node/3d-engine/texture-library';

const flat = (w: number, h: number, v: number) => ({ width: w, height: h, rgba: new Uint8Array(w * h * 4).fill(v) });

describe('estimated real sizes for library sets without a publisher size', () => {
    it('lays the previews out numbered on a grid, reads the widths back and scores them against known sizes', () => {
        const sheet = previewSheet([flat(384, 384, 10), flat(384, 192, 200), flat(100, 100, 90), flat(50, 50, 60), flat(64, 64, 120)]);
        // four columns of 192 px cells with 10 px gaps, two rows
        expect([sheet.width, sheet.height]).toEqual([4 * 202 + 10, 2 * 202 + 10]);
        const at = (x: number, y: number) => sheet.rgba[(y * sheet.width + x) * 4];
        expect(at(10 + 96, 10 + 96)).toBe(10);
        // the wide preview keeps its aspect: half height, white below
        expect(at(212 + 96, 10 + 50)).toBe(200);
        expect(at(212 + 96, 10 + 150)).toBe(255);
        // the fifth starts the second row
        expect(at(10 + 50, 212 + 50)).toBe(120);
        expect(sizePrompt(['Bricks 024. Bricks.', 'Metal 032.'])).toContain('2. Metal 032.');
        const sizes = parseSizes('{"sets":[{"n":2,"widthM":1.5,"conf":70},{"n":1,"widthM":0},{"n":3,"widthM":2}]}', 2);
        expect(sizes).toEqual([undefined, { widthM: 1.5, conf: 70 }]);
        expect(() => parseSizes('{"sets":[{"n":1}]}', 1)).toThrow();
        expect(scoreEstimates([{ estimatedM: 2, knownM: 2 }, { estimatedM: 3, knownM: 2 }, { estimatedM: 1, knownM: 4 }])).toEqual({ sets: 3, medianRatio: 1.5, within1_5x: 0.667, within2x: 0.667 });
    });

    it('gives a set without a publisher size its estimate, labelled, and never overrides a publisher size', () => {
        const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'lib-sizes-'));
        try {
            const dir = path.join(repo, 'assets', 'textures', 'library');
            fs.mkdirSync(dir, { recursive: true });
            const set = (id: string, extra: object) => ({ id, publisher: 'ambientCG', maps: { color: `${id}/c.png` }, sizeSource: 'unknown', appearance: id, tags: [], ...extra });
            fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({ schema: 'scratchbox.texture-library/1', sets: [set('Plaster001', { pixels: [4096, 2048], notes: ['its publisher gives no real size: a script must estimate it'] }), set('Bricks001', { realSizeM: [2, 2], sizeSource: 'ambientCG metadata' })] }));
            fs.writeFileSync(path.join(dir, 'estimated-sizes.json'), JSON.stringify({ schema: 'scratchbox.texture-library-sizes/1', model: 'm', sets: { Plaster001: { widthM: 3, conf: 60 }, Bricks001: { widthM: 9, conf: 90 } } }));
            const sets = loadTextureLibraryIndex(repo)!.sets;
            const plaster = sets.find(e => e.id === 'Plaster001')!, bricks = sets.find(e => e.id === 'Bricks001')!;
            expect(plaster.realSizeM).toEqual([3, 1.5]);
            expect(plaster.sizeSource).toMatch(/estimated .*generated/);
            expect(plaster.notes ?? []).toEqual([]);
            expect(bricks.realSizeM).toEqual([2, 2]);
            expect(bricks.sizeSource).toBe('ambientCG metadata');
        } finally { fs.rmSync(repo, { recursive: true, force: true }); }
    });
});
