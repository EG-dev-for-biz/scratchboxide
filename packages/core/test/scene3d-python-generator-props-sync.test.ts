/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const SCENE3D_PATH = path.resolve(__dirname, '../src/browser/generative-canvas/primitives/Scene3DPrimitive.tsx');

function sliceBalanced(source: string, openIdx: number): string {
    const open = source[openIdx];
    const close = open === '{' ? '}' : ')';
    let depth = 0;
    for (let i = openIdx; i < source.length; i++) {
        if (source[i] === open) depth++;
        else if (source[i] === close && --depth === 0) return source.slice(openIdx, i + 1);
    }
    throw new Error('unbalanced');
}

describe('Scene3DPrimitive props -> state projection keeps Python-generated GLBs', () => {
    const source = fs.readFileSync(SCENE3D_PATH, 'utf-8');

    it('initial useState projection carries pythonGenerator and only the C++ generator the data holds', () => {
        const start = source.indexOf('React.useState<Scene3DData>(() => ({');
        expect(start).toBeGreaterThan(0);
        const init = sliceBalanced(source, source.indexOf('(', source.indexOf('=>', start)));
        expect(init).toMatch(/pythonGenerator:\s*data\?\.pythonGenerator/);
        // No template generator of the viewport's own (it used to inject a "Procedural Biosphere" C++ source).
        expect(init).toMatch(/cppGenerator:\s*data\?\.cppGenerator,/);
        expect(init).not.toContain('sourceCode');
    });

    it('every whole-object projection from props (the object built from `...data` that setSceneData receives) carries pythonGenerator', () => {
        // The projection is the object literal that spreads the props' data and sets its title. It is passed to
        // setSceneData directly, or first through carryStagedChoice (the clay/textured choice held over a running
        // staged build's later commits), so the match starts at the literal, not at the call around it.
        const re = /\{(?:\s*\/\/[^\n]*\n)*\s*\.\.\.data,\s*\n\s*title:\s*data\.title/g;
        let m: RegExpExecArray | null;
        let count = 0;
        while ((m = re.exec(source)) !== null) {
            const obj = sliceBalanced(source, m.index);
            // what is built here is what setSceneData gets
            const after = source.slice(m.index + obj.length, m.index + obj.length + 400);
            expect(after).toMatch(/setSceneData\(/);
            expect(obj).toMatch(/pythonGenerator:\s*data\.pythonGenerator/);
            count++;
        }
        expect(count).toBeGreaterThan(0);
    });
});
