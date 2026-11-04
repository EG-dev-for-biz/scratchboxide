/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import { STARTER_BUTTONS, pickStarterPrompt } from '../src/browser/generative-canvas/studio/starterPrompts';

function memoryStorage() {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
}
const button = (label: string) => STARTER_BUTTONS.find(b => b.label === label)!;

describe('new-chat starter buttons pick a varied example', () => {
    it('3D Scene has many distinct examples', () => {
        for (const label of ['3D Scene']) {
            const prompts = button(label).prompts;
            expect(prompts.length, label).toBeGreaterThanOrEqual(8);
            expect(new Set(prompts).size, `${label} has duplicates`).toBe(prompts.length);
        }
    });

    it('never sends the same example twice in a row, and over many clicks uses most of them', () => {
        const storage = memoryStorage();
        let seed = 7;
        const random = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
        const b = button('3D Scene');
        const seen = new Set<string>();
        let last = '';
        for (let i = 0; i < 200; i++) {
            const p = pickStarterPrompt(b, random, storage);
            expect(b.prompts).toContain(p);
            expect(p).not.toBe(last);
            last = p;
            seen.add(p);
        }
        expect(seen.size).toBe(b.prompts.length);
    });

    it('3D Building always sends the Empire State Building, straightened from Google Maps (pipeline K), never a procedural rebuild', () => {
        const b = button('3D Building');
        expect(b.prompts).toHaveLength(1);
        const p = pickStarterPrompt(b, () => 0.99, memoryStorage());
        expect(p).toBe(b.prompts[0]);
        expect(p).toMatch(/^Build a 3D building of the Empire State Building at 350 Fifth Avenue, New York: isolate it and straighten it from Google Maps/);
        expect(p).not.toMatch(/procedural/);
    });

    it('3D Object sends one of several distinct single-object examples, each a textured object with no real place', () => {
        const b = button('3D Object');
        expect(b.makes).toBe('3d-scene');
        expect(b.prompts.length).toBeGreaterThanOrEqual(6);
        expect(new Set(b.prompts).size).toBe(b.prompts.length);
        for (const p of b.prompts) {
            expect(p).toMatch(/^Build a textured 3D object of /);
            expect(p).not.toMatch(/ in [A-Z]| at \d|script/);
        }
        const storage = memoryStorage();
        const first = pickStarterPrompt(b, () => 0, storage);
        expect(pickStarterPrompt(b, () => 0, storage)).not.toBe(first);
    });

    it('the front page offers 3D World, opening the 7th Avenue splat world, and no System Spec or KPI Dashboard', () => {
        expect(STARTER_BUTTONS.map(b => b.label)).toEqual(['Interactive App', '3D Scene', '3D Building', '3D Object', '3D World', 'Video NLE']);
        const w = button('3D World');
        expect(w.world!.scenePath).toBe('/tilesets/7th_avenue_west_32nd_street_new_york_40.74974_-73.99163/scene3d.json');
        // without the built world on this machine, the button builds it from the chat
        expect(w.prompts[0]).toMatch(/west sidewalk of 7th Ave at the Penn Station/);
    });

    it('a single-example button always sends it, and storage that throws still works', () => {
        expect(pickStarterPrompt(button('Video NLE'), () => 0.5, memoryStorage())).toBe(button('Video NLE').prompts[0]);
        const broken = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
        expect(button('3D Scene').prompts).toContain(pickStarterPrompt(button('3D Scene'), () => 0.999, broken));
    });
});
