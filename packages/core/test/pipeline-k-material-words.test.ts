/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/** The sets named for what a class was seen to be (pipeline-k/material-words.ts): the prompt, the reply and the key. */

import { describe, expect, it } from 'vitest';
import { parseWordCandidates, poolLines, WORD_CANDIDATES, wordsKey, wordsPrompt } from '../src/node/3d-engine/staged-location/pipeline-k/material-words';

describe('pipeline K material words', () => {
    it('lists the pool one set a line with its size, free text and tags, and asks for set ids per class', () => {
        const lines = poolLines([
            { id: 'castle_wall_slates', appearance: 'Castle Wall Slates. Brick & Block/Stone Block & Paver/Ashlar & Coursed Stone. Free 8K texture of castle slate wall: stacked slates', tags: ['wall', 'rough', 'blocks'], realSizeM: [2.5, 2.5] },
            { id: 'Concrete014', appearance: 'Concrete 014. Concrete. Height field photogrammetry', tags: ['clean', 'concrete', 'light', 'smooth'], realSizeM: [2, 2] }
        ]);
        expect(lines[0]).toMatch(/^castle_wall_slates \(2\.5 m\): Castle Wall Slates\. .*\[wall, rough, blocks\]$/);
        expect(lines[1]).toMatch(/^Concrete014 \(2 m\): Concrete 014\./);
        const prompt = wordsPrompt([{ seen: 'limestone cladding' }, { seen: 'window glass' }], lines, { building: 'Empire State Building, New York', brief: 'a limestone tower' });
        expect(prompt).toContain('- class 1: limestone cladding');
        expect(prompt).toContain('- class 2: window glass');
        expect(prompt).toContain('Empire State Building, New York');
        expect(prompt).toContain('a limestone tower');
        expect(prompt).toContain(`up to ${WORD_CANDIDATES} set ids`);
        expect(prompt.indexOf('The library:')).toBeLessThan(prompt.indexOf('castle_wall_slates (2.5 m)'));
    });

    it('reads the reply per class, keeping only ids of the pool, in order, without repeats, at most WORD_CANDIDATES', () => {
        const valid = new Set(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
        const out = parseWordCandidates('```json\n{"classes":[{"class":1,"sets":["b","zzz","a","b","c","d","e","f","g","h"]},{"class":2,"sets":[]},{"class":9,"sets":["a"]}]}\n```', 3, valid);
        expect(out[0]).toEqual(['b', 'a', 'c', 'd', 'e', 'f']);
        expect(out[1]).toEqual([]);
        expect(out[2]).toBeUndefined();
        expect(() => parseWordCandidates('no json here', 1, valid)).toThrow(/no JSON/);
        expect(() => parseWordCandidates('{"rows":[]}', 1, valid)).toThrow(/"classes"/);
        expect(() => parseWordCandidates('{"classes":[{"sets":["a"]}]}', 1, valid)).toThrow(/"class"/);
    });

    it('keys the kept answer by the seen words, the pool and the model', () => {
        const k = wordsKey(['limestone cladding'], ['a', 'b'], 'm1');
        expect(k).toMatch(/^material-words\/[0-9a-f]{64}$/);
        expect(wordsKey(['limestone cladding'], ['a', 'b'], 'm1')).toBe(k);
        expect(wordsKey(['limestone cladding'], ['a', 'c'], 'm1')).not.toBe(k);
        expect(wordsKey(['limestone ashlar'], ['a', 'b'], 'm1')).not.toBe(k);
        expect(wordsKey(['limestone cladding'], ['a', 'b'], 'm2')).not.toBe(k);
    });
});
