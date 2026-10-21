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
    it('3D Scene, System Spec and KPI Dashboard each have many distinct examples', () => {
        for (const label of ['3D Scene', 'System Spec', 'KPI Dashboard']) {
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

    it('a single-example button always sends it, and storage that throws still works', () => {
        expect(pickStarterPrompt(button('Video NLE'), () => 0.5, memoryStorage())).toBe(button('Video NLE').prompts[0]);
        const broken = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
        expect(button('KPI Dashboard').prompts).toContain(pickStarterPrompt(button('KPI Dashboard'), () => 0.999, broken));
    });
});
