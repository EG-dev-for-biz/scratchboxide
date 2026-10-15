/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * A file opened from the workspace explorer shows what the file holds.
 *
 * It used to show made-up content: a file that could not be read opened with "Mock content loaded from <path>", any
 * .json file (or KanbanBoardPrimitive.tsx) opened as a two-card sprint board about the file, an .automation file as a
 * "Gemini 3.8 Flash" node graph, and a .3d file as a placeholder mesh under a cyberpunk sky.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { artifactForOpenedFile } from '../src/browser/generative-canvas/hooks/useWorkspaceFiles';
import type { KanbanBoardData, LiveCodeSandboxData, MarkdownDocumentData, NodeGraphData, Scene3DData } from '../src/browser/generative-canvas/canvas-types';

describe('a file opened from the explorer shows its own contents', () => {
    it('a JSON file that is not a board, graph or scene opens as text, not as a template board', () => {
        const opened = artifactForOpenedFile('package.json', 'package.json', '{"name": "x", "version": "1.0.0"}', null, 1);
        expect(opened.layoutMode).toBe('code');
        const sandbox = opened.artifact.data as LiveCodeSandboxData;
        expect(sandbox.files.map(f => f.content)).toEqual(['{"name": "x", "version": "1.0.0"}']);
        expect(JSON.stringify(opened.artifact)).not.toMatch(/Setup workflow|Implementing file|Delivery board/);
    });

    it('a primitive source file opens as its source, not as a demo of the primitive', () => {
        for (const name of ['KanbanBoardPrimitive.tsx', 'NodeGraphPrimitive.tsx', 'Scene3DPrimitive.tsx']) {
            const opened = artifactForOpenedFile(`src/${name}`, name, 'export const X = 1;\n', null, 1);
            expect(opened.layoutMode, name).toBe('code');
            expect((opened.artifact.data as LiveCodeSandboxData).files[0].content).toBe('export const X = 1;\n');
        }
    });

    it('a board, graph or scene file opens as that primitive with only what it holds', () => {
        const board = artifactForOpenedFile('b.json', 'b.json', JSON.stringify({ columns: [{ id: 'a', title: 'A', cards: [] }] }), null, 1);
        expect(board.layoutMode).toBe('kanban');
        expect((board.artifact.data as KanbanBoardData).columns).toEqual([{ id: 'a', title: 'A', cards: [] }]);

        const graph = artifactForOpenedFile('g.automation', 'g.automation', JSON.stringify({ nodes: [{ id: 'n', label: 'N', x: 0, y: 0 }] }), null, 1);
        expect(graph.layoutMode).toBe('automation');
        expect((graph.artifact.data as NodeGraphData).nodes.map(n => n.id)).toEqual(['n']);
        expect((graph.artifact.data as NodeGraphData).edges).toEqual([]);

        const scene = artifactForOpenedFile('s.3d', 's.3d', JSON.stringify({ objects: [] }), null, 1);
        expect(scene.layoutMode).toBe('3d');
        const data = scene.artifact.data as Scene3DData;
        expect(data.objects).toEqual([]);
        expect(data.environment).toBeUndefined();
        expect(JSON.stringify(data)).not.toMatch(/internal:mesh|cyberpunk/);
    });

    it('a Markdown file is a document with no invented tags', () => {
        const opened = artifactForOpenedFile('docs/a.md', 'a.md', '# Title\n\nBody text.', null, 1);
        const doc = opened.artifact.data as MarkdownDocumentData;
        expect(opened.layoutMode).toBe('document');
        expect(doc.tags).toEqual([]);
        expect(doc.sections.map(s => s.content)).toEqual(['Title', 'Body text.']);
    });

    it('a file that cannot be read is not opened with stand-in content', () => {
        const source = fs.readFileSync(path.resolve(__dirname, '../src/browser/generative-canvas/hooks/useWorkspaceFiles.ts'), 'utf8');
        expect(source).not.toContain('getMockFileContent');
        expect(source).not.toMatch(/Mock content loaded from|mock markdown specification/);
        expect(source).toContain('Could not open ${fileName}: ${readError}');
    });
});
