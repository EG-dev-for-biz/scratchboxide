import { describe, expect, it } from 'vitest';
import { candidatePatch, candidateSheet, choicePrompt, parseChoices, type ChoiceCandidate, type ChoiceRow } from '../src/node/3d-engine/staged-location/pipeline-k/material-choice';
import { materialClassesExtras } from '../src/node/3d-engine/staged-location/pipeline-k/material-naming';

// a 1 m tile, 100 px: black and white stripes 10 px (10 cm) wide, mid grey overall
function stripes(): ChoiceCandidate {
    const W = 100, rgba = new Uint8Array(W * W * 4);
    for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) { const v = Math.floor(x / 10) % 2 ? 255 : 0; rgba.set([v, v, v, 255], (y * W + x) * 4); }
    return { id: 'Stripes', realSizeM: [1, 1], preview: { width: W, height: W, rgba } };
}
const toLinear = (v: number) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };

describe('the library set chosen by its look', () => {
    it('draws each candidate at the real size of the class patches, recoloured to the class mean', () => {
        const want: [number, number, number] = [0.2, 0.1, 0.05];
        const cell = 40, patch = candidatePatch(stripes(), 2, want, cell);
        // 2 m across a 40 px cell: the 1 m tile twice, 20 stripes, each 2 px
        const row = Array.from({ length: cell }, (_, x) => patch[(10 * cell + x) * 4]);
        const edges = row.slice(1).filter((v, x) => v !== row[x]).length;
        expect(edges).toBe(19);
        // its mean, in linear light, the class's
        const mean = [0, 1, 2].map(k => { let s = 0; for (let i = 0; i < cell * cell; i++) s += toLinear(patch[i * 4 + k]); return s / (cell * cell); });
        mean.forEach((m, k) => expect(m).toBeCloseTo(want[k], 2));
        // red stays above green above blue: one hue, the stripes' contrast kept
        expect(patch[0]).toBeGreaterThanOrEqual(patch[1]);
        const rows: ChoiceRow[] = [{ meanLinear: want, candidates: [stripes(), stripes()] }, { meanLinear: [0.5, 0.5, 0.5], candidates: [stripes()] }];
        const sheet = candidateSheet(rows, 1, cell);
        expect([sheet.width, sheet.height]).toEqual([2 * (cell + 8) + 8, 2 * (cell + 8) + 8]);
        // the second row's empty second cell stays white
        const q = ((8 + cell + 8 + 5) * sheet.width + 8 + cell + 8 + 5) * 4;
        expect([sheet.rgba[q], sheet.rgba[q + 1], sheet.rgba[q + 2]]).toEqual([255, 255, 255]);
        expect(choicePrompt(rows, 1.5, { building: 'Empire State Building' })).toContain('each a patch 1.5 m across');
    });

    it("reads the chooser's pick per row, and saves how each set was chosen with the building", () => {
        const rows: ChoiceRow[] = [{ meanLinear: [0.1, 0.1, 0.1], candidates: [stripes(), stripes(), stripes()] }, { meanLinear: [0.5, 0.5, 0.5], candidates: [stripes()] }];
        const picks = parseChoices('```json\n{"rows":[{"row":1,"pick":3,"seen":"smooth honed limestone","conf":80},{"row":2,"pick":4},{"row":7,"pick":1}]}\n```', rows);
        expect(picks).toEqual([{ pick: 3, seen: 'smooth honed limestone', conf: 80 }, undefined]);
        expect(parseChoices('{"rows":[{"row":2,"pick":0}]}', rows)).toEqual([undefined, { pick: 0, conf: 50 }]);
        // the chooser's own vote on bare metal, 0 or 1
        expect(parseChoices('{"rows":[{"row":1,"pick":2,"metal":1,"conf":70},{"row":2,"pick":1,"metal":0.2}]}', rows).map(p => p?.metal)).toEqual([1, 0]);
        expect(choicePrompt(rows, 1.5)).toContain('"metal"');
        expect(() => parseChoices('{"rows":[{"row":1}]}', rows)).toThrow();
        expect(() => parseChoices('no', rows)).toThrow();
        const c = { index: 0, meanLab: [70, 2, 5] as [number, number, number], meanLinear: [0.4, 0.38, 0.35] as [number, number, number], spreadLab: [1, 1, 1] as [number, number, number], share: 1, wall: true };
        const saved = materialClassesExtras([{ ...c, set: 'concrete_wall_007', distance: 1.2, choice: { by: 'appearance', seen: 'smooth honed limestone' } }], undefined);
        expect(saved.classes[0].set).toMatchObject({ name: 'concrete_wall_007', label: 'generated', by: 'appearance', seen: 'smooth honed limestone' });
    });
});
