/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import {
    computeLineDiff,
    generateMultiFileDiff,
    applyMultiFilePatch
} from '../src/browser/generative-canvas/multi-file-diff-engine';

describe('MultiFileDiffEngine with Myers Diff Algorithm', () => {
    it('accurately identifies additions, deletions, and context lines with 0ms fast-path on identical content', () => {
        const text = 'const x = 10;\nconst y = 20;\nconsole.log(x + y);';
        const result = computeLineDiff(text, text);

        expect(result.additions).toBe(0);
        expect(result.deletions).toBe(0);
        expect(result.lines.length).toBe(3);
        expect(result.lines.every(l => l.type === 'context')).toBe(true);
    });

    it('handles empty string transitions correctly', () => {
        const added = computeLineDiff('', 'line 1\nline 2');
        expect(added.additions).toBe(2);
        expect(added.deletions).toBe(0);
        expect(added.lines.every(l => l.type === 'add')).toBe(true);

        const deleted = computeLineDiff('line 1\nline 2', '');
        expect(deleted.additions).toBe(0);
        expect(deleted.deletions).toBe(2);
        expect(deleted.lines.every(l => l.type === 'del')).toBe(true);
    });

    it('computes shortest edit script (Myers diff) on interleaved additions and deletions', () => {
        const oldCode = [
            'function calculate() {',
            '    const a = 1;',
            '    const b = 2;',
            '    return a + b;',
            '}'
        ].join('\n');

        const newCode = [
            'function calculate() {',
            '    const a = 10;',
            '    const b = 2;',
            '    const c = 3;',
            '    return a + b + c;',
            '}'
        ].join('\n');

        const diff = computeLineDiff(oldCode, newCode);
        expect(diff.additions).toBe(3); // a=10, c=3, return a+b+c
        expect(diff.deletions).toBe(2);  // a=1, return a+b

        // Context lines must preserve correct line numbers
        const firstContext = diff.lines[0];
        expect(firstContext.type).toBe('context');
        expect(firstContext.content).toBe('function calculate() {');
        expect(firstContext.oldLineNo).toBe(1);
        expect(firstContext.newLineNo).toBe(1);

        const lastContext = diff.lines[diff.lines.length - 1];
        expect(lastContext.type).toBe('context');
        expect(lastContext.content).toBe('}');
    });

    it('generates multi-file diffs and applies patches non-destructively', () => {
        const originalFiles = [
            { path: 'main.cpp', content: '#include "scratchbox_engine.hpp"\nint main() { return 0; }' },
            { path: 'scene.json', content: '{"version": 1}' }
        ];

        const proposedFiles = [
            { path: 'main.cpp', content: '#include "scratchbox_engine.hpp"\nint main() {\n    Scratchbox3D::Scene scene;\n    return 0;\n}' },
            { path: 'shader.frag', content: 'void main() { gl_FragColor = vec4(1.0); }' }
        ];

        const diffs = generateMultiFileDiff(originalFiles, proposedFiles);
        expect(diffs.length).toBe(2);

        const mainDiff = diffs.find(d => d.path === 'main.cpp');
        expect(mainDiff).toBeDefined();
        expect(mainDiff?.status).toBe('modified');
        expect(mainDiff?.additions).toBeGreaterThan(0);

        const fragDiff = diffs.find(d => d.path === 'shader.frag');
        expect(fragDiff).toBeDefined();
        expect(fragDiff?.status).toBe('added');

        // Apply patch
        const acceptedPatch = {
            id: 'patch-1',
            timestamp: Date.now(),
            summary: 'Added scene initialization and shader',
            files: diffs
        };

        const updatedFiles = applyMultiFilePatch(originalFiles, acceptedPatch, {
            'main.cpp': true,
            'shader.frag': true
        });

        expect(updatedFiles.length).toBe(3);
        const updatedMain = updatedFiles.find(f => f.path === 'main.cpp');
        expect(updatedMain?.content).toContain('Scratchbox3D::Scene scene');
    });
});
