/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * GFM pipe tables in the chat: a model reply holding a table renders a real `<table>` (header, alignment, inline
 * markdown in cells), text that merely contains pipes stays text, and a table that is still streaming stays a table.
 */

import { describe, it, expect } from 'vitest';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChatMarkdownRenderer, parseMarkdownBlocks, splitTableRow, type MarkdownBlock } from '../src/browser/generative-canvas/ChatMarkdownRenderer';

/** The assistant reply in desktop-app/.scratchbox/sessions/session-chat-1793410152235.json (2026-10-30, the 3D/VFX gate on). */
const SHOT_LIST_REPLY = 'This build of Scratchbox is limited to 3D and VFX projects, so interactive Kanban boards are not available on the canvas stage, but here is a shot-tracking board directly in chat:\n\n| Shot ID | Scene / Description | Lens & Framing | Storyboard | Shoot | Edit | Done |\n| :--- | :--- | :--- | :---: | :---: | :---: | :---: |\n| **SH-010** | Opening establishing wide | 24mm Wide — Slow push-in | `[x]` | `[ ]` | `[ ]` | `[ ]` |\n| **SH-020** | Protagonist enters frame | 35mm Medium — Tracking | `[x]` | `[ ]` | `[ ]` | `[ ]` |\n| **SH-030** | Close-up reaction beat | 50mm Close-Up — Locked | `[ ]` | `[ ]` | `[ ]` | `[ ]` |\n| **SH-040** | Action sequence / VFX hero beat | 28mm Handheld — Dynamic | `[ ]` | `[ ]` | `[ ]` | `[ ]` |\n| **SH-050** | Final resolve & cut to black | 35mm Wide — Crane up | `[ ]` | `[ ]` | `[ ]` | `[ ]` |\n\nIf you share your shot list, I can update this table or set up the production in the canvas:\n\n- **Open a Video Timeline NLE** with your shots laid out as timed clips across Storyboard/Animatic, A-Roll, VFX, and Audio tracks.\n- **Generate storyboard frames** for specific shots right here in the chat.\n- **Stage a 3D previz scene** (at a real-world location from Google 3D Tiles or in a studio scene) to block out camera angles and lenses.';

const HEADER = ['Shot ID', 'Scene / Description', 'Lens & Framing', 'Storyboard', 'Shoot', 'Edit', 'Done'];

type TableBlock = Extract<MarkdownBlock, { type: 'table' }>;
const tablesOf = (text: string) => parseMarkdownBlocks(text).filter((b): b is TableBlock => b.type === 'table');
const render = (text: string, isStreaming = false) => renderToStaticMarkup(React.createElement(ChatMarkdownRenderer, { text, isStreaming }));
const count = (html: string, pattern: RegExp) => (html.match(pattern) || []).length;

describe('chat markdown: GFM pipe tables', () => {
    it('parses the shot list reply into text, one 7 x 5 table, text and a list', () => {
        const blocks = parseMarkdownBlocks(SHOT_LIST_REPLY);
        expect(blocks.map(b => b.type)).toEqual(['paragraph', 'table', 'paragraph', 'list']);
        const table = blocks[1] as TableBlock;
        expect(table.header).toEqual(HEADER);
        expect(table.align).toEqual(['left', 'left', 'left', 'center', 'center', 'center', 'center']);
        expect(table.rows).toHaveLength(5);
        expect(table.rows.every(row => row.length === 7)).toBe(true);
        expect(table.rows[0]).toEqual(['**SH-010**', 'Opening establishing wide', '24mm Wide — Slow push-in', '`[x]`', '`[ ]`', '`[ ]`', '`[ ]`']);
        expect(table.rows[4][1]).toBe('Final resolve & cut to black');
    });

    it('renders a real table: 7 header cells, 35 body cells, centred status columns, inline markdown in cells', () => {
        const html = render(SHOT_LIST_REPLY);
        expect(count(html, /<table class="sb-chat-table">/g)).toBe(1);
        expect(html).toContain('<div class="sb-chat-table-scroll">');
        expect(count(html, /<th[\s>]/g)).toBe(7);
        expect(count(html, /<td[\s>]/g)).toBe(35);

        const headerCells = [...html.matchAll(/<th(?: style="([^"]*)")?>(.*?)<\/th>/g)];
        expect(headerCells.map(m => m[2])).toEqual(HEADER.map(h => h.replace('&', '&amp;')));
        expect(headerCells.map(m => m[1] ?? '')).toEqual([
            'text-align:left', 'text-align:left', 'text-align:left',
            'text-align:center', 'text-align:center', 'text-align:center', 'text-align:center'
        ]);
        // every body row carries the same alignment as its header
        expect(count(html, /<td style="text-align:center">/g)).toBe(20);
        expect(count(html, /<td style="text-align:left">/g)).toBe(15);

        expect(html).toContain('<td style="text-align:left"><strong class="sb-chat-strong">SH-010</strong></td>');
        expect(count(html, /<code class="sb-chat-inline-code">\[x\]<\/code>/g)).toBe(2);
        expect(count(html, /<code class="sb-chat-inline-code">\[ \]<\/code>/g)).toBe(18);
        // no row of raw pipes left anywhere, and the text around the table still renders
        expect(html).not.toMatch(/\|\s*:?-{3}/);
        expect(html).not.toContain('| **SH');
        expect(html).toContain('a shot-tracking board directly in chat:</p>');
        expect(count(html, /<li class="sb-chat-list-item">/g)).toBe(3);
    });

    it('leaves text that merely contains pipes alone', () => {
        const pipeLine = 'Pick one: Clay | Textured | Wireframe, or pipe it with `ls | grep glb`.';
        expect(parseMarkdownBlocks(pipeLine)).toEqual([{ type: 'paragraph', content: pipeLine }]);
        const html = render(pipeLine);
        expect(html).not.toContain('<table');
        expect(html).toContain('Clay | Textured | Wireframe');
        expect(html).toContain('<code class="sb-chat-inline-code">ls | grep glb</code>');

        // a pipe row with no delimiter row under it, or a delimiter row of the wrong width, is not a table
        expect(tablesOf('| not | a table |\nstill | text')).toHaveLength(0);
        expect(tablesOf('| a | b | c |\n| --- | --- |\n| 1 | 2 | 3 |')).toHaveLength(0);
        // a thematic break under a pipe line is not a delimiter row
        expect(tablesOf('left | right\n---')).toHaveLength(0);
    });

    it('keeps escaped pipes inside their cell and reads every alignment form', () => {
        expect(splitTableRow('| `a \\| b` | either \\| or |')).toEqual(['`a | b`', 'either | or']);
        const [table] = tablesOf('Expr | Meaning | Count | Note\n--- | :---: | ---: | :---\n`a \\| b` | either | 2 | x');
        expect(table.header).toEqual(['Expr', 'Meaning', 'Count', 'Note']);
        expect(table.align).toEqual([null, 'center', 'right', 'left']);
        expect(table.rows).toEqual([['`a | b`', 'either', '2', 'x']]);
        const html = render('| Expr | Count |\n| --- | ---: |\n| `a \\| b` | 2 |');
        expect(html).toContain('<td><code class="sb-chat-inline-code">a | b</code></td>');
        expect(html).toContain('<td style="text-align:right">2</td>');
    });

    it('pads short rows, cuts long ones, and ends the table at a blank or pipe-less line', () => {
        const [table] = tablesOf('| a | b | c |\n|---|---|---|\n| 1 |\n| 1 | 2 | 3 | 4 |');
        expect(table.rows).toEqual([['1', '', ''], ['1', '2', '3']]);

        const blocks = parseMarkdownBlocks('Here it is:\n| a | b |\n|---|---|\n| 1 | 2 |\nSource: the scan.\n\n| c |\n| :-: |\n| 3 |');
        expect(blocks.map(b => b.type)).toEqual(['paragraph', 'table', 'paragraph', 'table']);
        expect((blocks[0] as { content: string }).content).toBe('Here it is:');
        expect((blocks[1] as TableBlock).rows).toEqual([['1', '2']]);
        expect((blocks[2] as { content: string }).content).toBe('Source: the scan.');
        expect((blocks[3] as TableBlock).align).toEqual(['center']);
    });

    it('keeps a streaming table a table: a half-written last row fills in place with the cursor after it', () => {
        const full = SHOT_LIST_REPLY;
        const cut = full.indexOf('Close-up reaction') + 'Close-up rea'.length;
        const partial = full.slice(0, cut);
        const [table] = tablesOf(partial);
        expect(table.rows).toHaveLength(3);
        expect(table.rows[2]).toEqual(['**SH-030**', 'Close-up rea', '', '', '', '', '']);

        const html = render(partial, true);
        expect(count(html, /<table/g)).toBe(1);
        expect(count(html, /<td[\s>]/g)).toBe(21);
        expect(html).toMatch(/<td style="text-align:left">Close-up rea<span class="sb-chat-streaming-cursor[^"]*"[^>]*>▊<\/span><\/td>/);

        // every prefix that already holds the delimiter row parses as exactly one table with the full header
        const delimiterEnd = full.indexOf('\n', full.indexOf('| :--- |')) + 1;
        for (let end = delimiterEnd; end <= full.indexOf('\n\nIf you share'); end += 7) {
            const tables = tablesOf(full.slice(0, end));
            expect(tables).toHaveLength(1);
            expect(tables[0].header).toEqual(HEADER);
        }
    });
});
