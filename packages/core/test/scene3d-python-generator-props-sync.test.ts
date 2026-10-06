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

    it('initial useState projection carries pythonGenerator and skips the C++ template when Python geometry exists', () => {
        const start = source.indexOf('React.useState<Scene3DData>(() => ({');
        expect(start).toBeGreaterThan(0);
        const init = sliceBalanced(source, source.indexOf('(', source.indexOf('=>', start)));
        expect(init).toMatch(/pythonGenerator:\s*data\?\.pythonGenerator/);
        expect(init).toMatch(/cppGenerator:\s*data\?\.cppGenerator\s*\|\|\s*\(data\?\.pythonGenerator\s*\?\s*undefined/);
    });

    it('every whole-object setSceneData({...}) projection from props carries pythonGenerator', () => {
        const re = /setSceneData\(\{\s*\n\s*title:\s*data\.title/g;
        let m: RegExpExecArray | null;
        let count = 0;
        while ((m = re.exec(source)) !== null) {
            const obj = sliceBalanced(source, source.indexOf('{', m.index));
            expect(obj).toMatch(/pythonGenerator:\s*data\.pythonGenerator/);
            count++;
        }
        expect(count).toBeGreaterThan(0);
    });
});
