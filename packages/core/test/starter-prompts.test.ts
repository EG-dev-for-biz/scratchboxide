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

describe('new-chat starter buttons send a plain request, never a canned example', () => {
    it('every button sends one request that names no place, so the chat asks which one before building', () => {
        for (const b of STARTER_BUTTONS) {
            expect(b.prompts, b.label).toHaveLength(1);
            expect(b.prompts[0], b.label).not.toMatch(/Empire State|Central Park|Flatiron|Penn Station|Madison|Shibuya|Trafalgar|\d{3} Fifth/);
        }
    });

    it('3D Building and 3D Scene send a bare request, and the picker returns it', () => {
        expect(pickStarterPrompt(button('3D Building'), () => 0.99, memoryStorage())).toBe('Make a 3D building');
        expect(pickStarterPrompt(button('3D Scene'), () => 0.01, memoryStorage())).toBe('Make a 3D scene');
    });

    it('the front page offers 3D World, opening the 7th Avenue splat world, and no System Spec or KPI Dashboard', () => {
        expect(STARTER_BUTTONS.map(b => b.label)).toEqual(['Interactive App', '3D Scene', '3D Building', '3D World', 'Video NLE']);
        const w = button('3D World');
        expect(w.world!.scenePath).toBe('/tilesets/7th_avenue_west_32nd_street_new_york_40.74974_-73.99163/scene3d.json');
        // without the built world on this machine, the button sends its request and the chat asks which place
        expect(w.prompts[0]).toBe('Make a walkable 3D world');
    });

    it('a button with its request still works when storage throws', () => {
        const broken = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
        expect(pickStarterPrompt(button('3D Scene'), () => 0.999, broken)).toBe('Make a 3D scene');
    });
});
