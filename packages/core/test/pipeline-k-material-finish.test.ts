/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Each appearance class's finish read by the vision model (pipeline-k/material-finish.ts): the reply parsed into numbers
 * per row, and what the ranking takes from it: the roughness only at minConf, metal only at metalConf and metalness metalAt;
 * below that the matte dielectric finish it had before.
 */

import { describe, expect, it } from 'vitest';
import { FINISH_READ, finishPrompt, finishTarget, parseClassFinish } from '../src/node/3d-engine/staged-location/pipeline-k/material-finish';
import { REGION_FINISH } from '../src/node/3d-engine/staged-location/pipeline-k/material-sets';

describe('pipeline K material finish', () => {
    it('parses one finish per row, clamped, and skips rows it cannot read', () => {
        const reply = '```json\n{"classes":[{"row":1,"roughness":0.35,"metalness":0.9,"conf":82,"seen":"anodized aluminium panel"},{"row":2,"roughness":1.4,"metalness":-1,"conf":120},{"row":3,"roughness":"x","metalness":0},{"row":9,"roughness":0.5,"metalness":0,"conf":50}]}\n```';
        const f = parseClassFinish(reply, 3);
        expect(f[0]).toEqual({ roughness: 0.35, metalness: 0.9, conf: 82, seen: 'anodized aluminium panel' });
        expect(f[1]).toEqual({ roughness: 1, metalness: 0, conf: 100 });
        expect(f[2]).toBeUndefined();
        expect(() => parseClassFinish('no json', 3)).toThrow();
    });

    it('takes metal only from a confident metal reading, and the roughness from a confident one; else the matte dielectric finish', () => {
        const matte = { roughness: REGION_FINISH.roughness, metallic: REGION_FINISH.metallic };
        expect(finishTarget(undefined, matte)).toEqual({ ...matte, metal: false, plain: false });
        expect(finishTarget({ roughness: 0.35, metalness: 0.9, conf: FINISH_READ.metalConf }, matte)).toEqual({ roughness: 0.35, metallic: 0.9, metal: true, plain: false });
        // sure enough of the roughness, not of the metal
        expect(finishTarget({ roughness: 0.35, metalness: 0.9, conf: FINISH_READ.metalConf - 1 }, matte)).toEqual({ roughness: 0.35, metallic: 0, metal: false, plain: false });
        // a confident smooth dielectric (glass, polished stone): a plain finish, no library set
        expect(finishTarget({ roughness: 0.3, metalness: 0.1, conf: 95 }, matte)).toEqual({ roughness: 0.3, metallic: 0, metal: false, plain: true });
        expect(finishTarget({ roughness: 0.6, metalness: 0.1, conf: 95 }, matte)).toEqual({ roughness: 0.6, metallic: 0, metal: false, plain: false });
        // unsure of everything: matte as before
        expect(finishTarget({ roughness: 0.2, metalness: 1, conf: FINISH_READ.minConf - 1 }, matte)).toEqual({ ...matte, metal: false, plain: false });
    });

    it('asks for numbers per row, never a material category to route on', () => {
        const p = finishPrompt([{ meanLab: [38, 0, 0], share: 0.2, wall: false }, { meanLab: [70, 1, 2], share: 0.5, wall: true }], { building: 'Penn 2' });
        expect(p).toContain('row 2');
        expect(p).toContain('"roughness"');
        expect(p).toContain('"metalness"');
        expect(p).toContain('A dark colour alone is not metal');
    });
});
