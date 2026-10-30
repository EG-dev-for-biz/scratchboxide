import { describe, expect, it } from 'vitest';
import { classSwatchSheet, type RegionClass } from '../src/node/3d-engine/staged-location/pipeline-k/material-regions';
import { betweenSeen, glassSeen, materialClassesExtras, namingPrompt, parseClassWords } from '../src/node/3d-engine/staged-location/pipeline-k/material-naming';
import type { FacadeReadRecord } from '../src/node/3d-engine/staged-location/pipeline-k/facade-reader';

const STONE = [205, 196, 178], SPANDREL = [70, 56, 48];
// a rebuilt facade's photo: light stone on the left half, dark spandrels on the right
function facadeJson() {
    const W = 200, H = 120, rgba = new Uint8Array(W * H * 4);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) rgba.set([...(x < W / 2 ? STONE : SPANDREL), 255], (y * W + x) * 4);
    const json = { meshes: [{ name: 'facade_lattice_7', primitives: [{ material: 0 }] }], materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }], textures: [{ source: 0 }] };
    return { json, images: new Map([[0, { width: W, height: H, rgba }]]) };
}
const lab = (rgb: number[]) => {
    const lin = rgb.map(v => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
    const X = (0.4124 * lin[0] + 0.3576 * lin[1] + 0.1805 * lin[2]) / 0.95047, Y = 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2], Z = (0.0193 * lin[0] + 0.1192 * lin[1] + 0.9505 * lin[2]) / 1.08883;
    const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
    return [116 * f(Y) - 16, 500 * (f(X) - f(Y)), 200 * (f(Y) - f(Z))] as [number, number, number];
};
const cls = (index: number, rgb: number[], wall: boolean, share: number): RegionClass => ({ index, meanLab: lab(rgb), meanLinear: rgb.map(v => (v / 255) ** 2.2) as [number, number, number], spreadLab: [1, 1, 1], share, wall });

describe("the building's materials, saved with it", () => {
    it('pictures each appearance class with patches of the photo it covers, one row a class', () => {
        const { json, images } = facadeJson();
        const classes = [cls(0, SPANDREL, false, 0.5), cls(1, STONE, true, 0.5)];
        const sheet = classSwatchSheet(json, images, classes, { patch: 16, perClass: 3, zoom: 2 })!;
        expect(sheet).toBeDefined();
        // row 1 (the spandrel class) dark, row 2 (the stone) light: the middle of each row's first patch
        const at = (row: number) => { const cell = 32, gap = 8, y = gap + row * (cell + gap) + cell / 2, x = gap + cell / 2, q = (y * sheet.width + x) * 4; return [sheet.rgba[q], sheet.rgba[q + 1], sheet.rgba[q + 2]]; };
        expect(at(0)).toEqual(SPANDREL);
        expect(at(1)).toEqual(STONE);
        expect(classSwatchSheet({ meshes: [] }, images, classes)).toBeUndefined();
    });

    it("reads the namer's words row by row, and saves each class's colour, library set and words with their provenance", () => {
        const classes = [cls(0, SPANDREL, false, 0.3), cls(1, STONE, true, 0.7)];
        const prompt = namingPrompt(classes, { building: 'Empire State Building, New York', brief: 'Art Deco limestone tower', between: ['cast-aluminium spandrels'], glass: ['clear, slightly green'] });
        expect(prompt).toContain('row 2: 70% of the facades\' texels');
        expect(prompt).toContain('the lightest (the wall)');
        expect(prompt).toContain('cast-aluminium spandrels');
        const words = parseClassWords('ok {"classes":[{"row":2,"words":"Indiana limestone ashlar","conf":85},{"row":1,"words":"cast-aluminium spandrel panel","conf":70},{"row":9,"words":"x"}]}', 2);
        expect(words).toEqual([{ words: 'cast-aluminium spandrel panel', conf: 70 }, { words: 'Indiana limestone ashlar', conf: 85 }]);
        expect(() => parseClassWords('{"classes":[{"row":1}]}', 2)).toThrow();
        const records: FacadeReadRecord[] = [
            { facadeId: 1, outcome: 'replaced', why: '', ms: 0, zones: [{ region: { x0: 0, y0: 0, x1: 1, y1: 1 }, outcome: 'drawn', why: '', reading: { rows: 1, openings: 1, conf: 80, between: 'cast-aluminium spandrels' }, glass: { label: 'clear, slightly green', transparency: 0.7, reflectivity: 0.3, tint: '#7a8f88', opaque: false } }] },
            { facadeId: 2, outcome: 'replaced', why: '', ms: 0, zones: [{ region: { x0: 0, y0: 0, x1: 1, y1: 1 }, outcome: 'drawn', why: '', glass: { label: 'clear, slightly green', transparency: 0.5, reflectivity: 0.5, opaque: false } }, { region: { x0: 0, y0: 0, x1: 1, y1: 1 }, outcome: 'rejected', why: '', glass: { label: 'mirror', transparency: 0, reflectivity: 1, opaque: false } }] }
        ];
        const glass = glassSeen(records);
        expect(glass).toEqual([{ words: 'clear, slightly green', planes: 2, transparency: 0.6, reflectivity: 0.4, tint: '#7a8f88', opaque: false }]);
        expect(betweenSeen(records)).toEqual(['cast-aluminium spandrels']);
        const saved = materialClassesExtras([{ ...classes[0], set: 'Metal_Painted_Dark', distance: 0.12345 }, { ...classes[1], set: 'Limestone_Ashlar', distance: 0.05 }], [words[0], undefined], glass);
        expect(saved.schema).toBe('scratchbox.material-classes/1');
        expect(saved.classes[0]).toMatchObject({ set: { name: 'Metal_Painted_Dark', distance: 0.123, label: 'generated' }, words: { text: 'cast-aluminium spandrel panel', label: 'photo-inferred' }, colour: { label: 'photo-inferred' } });
        expect(saved.classes[0].colour.srgb).toMatch(/^#[0-9a-f]{6}$/);
        expect(saved.classes[1].words).toBeUndefined();
        expect(saved.glass![0]).toMatchObject({ words: 'clear, slightly green', label: 'photo-inferred' });
    });
});
