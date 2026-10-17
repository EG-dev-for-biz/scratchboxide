/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The viewport tool strip's undo / redo buttons: the real component rendered from a live
 * ViewportHistory snapshot (disabled states, tooltip text, history count), then looked at in
 * headless Chrome. The page carries a small stand-in stylesheet for the utility classes the strip uses.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ViewportHistoryButtons } from '../src/browser/generative-canvas/primitives/scene3d/ViewportHistoryButtons';
import { ViewportHistory } from '../src/browser/generative-canvas/services/viewport-history';
import type { HistoryEntry } from '../src/browser/generative-canvas/services/viewport-history';
import { REPO_ROOT } from './helpers/requirements';
import { htmlScreenshotChrome, saveHtmlScreenshot } from './helpers/html-screenshot';

const entry = (label: string): HistoryEntry => ({ label, bytes: 1, apply: () => undefined, revert: () => undefined });

const render = (history: ViewportHistory): string =>
    renderToStaticMarkup(React.createElement(ViewportHistoryButtons, { snapshot: history.getSnapshot(), onUndo: () => undefined, onRedo: () => undefined }));

const STYLE = `<style>
 .strip{display:inline-flex;flex-direction:column;align-items:center;gap:2px;padding:4px;border-radius:12px;background:rgba(18,18,22,.9);border:1px solid rgba(255,255,255,.1);zoom:5;vertical-align:top}
 .sb-3d-toolstrip-btn{display:flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:6px;background:none;border:1px solid transparent;padding:0}
 .text-zinc-300{color:#d4d4d8}.text-zinc-600{color:#52525b}.text-zinc-500{color:#71717a}.opacity-40{opacity:.4}
 .w-2\\.5{width:10px}.h-2\\.5{height:10px}.sb-3d-history-count{font-size:8px;line-height:1;font-variant-numeric:tabular-nums}
 .card{display:inline-block;margin:14px 26px;text-align:center;font:13px -apple-system,sans-serif;color:#d4d4d8}
 .card .cap{margin-top:8px;max-width:210px}
 body{background:#2a2d34}
</style>`;

describe('viewport undo/redo toolbar', () => {
    it('shows disabled / enabled states, the next undo label and the history count from the live timeline', async () => {
        const history = new ViewportHistory({ now: () => 0 });
        const empty = render(history);
        expect(empty).toContain('disabled=""');
        expect(empty).toContain('title="Nothing to undo"');
        expect(empty).toContain('title="Nothing to redo"');
        expect(empty).toMatch(/data-testid="sb-3d-history-count"[^>]*>0</);

        history.record(entry('Move cube'));
        history.record(entry('Set material: cube'));
        history.record(entry('Delete mesh: prop'));
        const edited = render(history);
        expect(edited).toContain('title="Undo: Delete mesh: prop (⌘Z / Ctrl+Z)"');
        expect(edited).toContain('title="Nothing to redo"');
        expect(edited).toMatch(/data-testid="sb-3d-history-count"[^>]*>3</);

        history.undo();
        const undone = render(history);
        expect(undone).toContain('title="Undo: Set material: cube (⌘Z / Ctrl+Z)"');
        expect(undone).toContain('title="Redo: Delete mesh: prop (⌘⇧Z / Ctrl+Y)"');
        expect(undone).toMatch(/data-testid="sb-3d-history-count"[^>]*>2\/3</);
        expect((undone.match(/disabled=""/g) ?? []).length).toBe(0);

        const card = (html: string, caption: string) => `<div class="card"><div class="strip">${html}</div><div class="cap">${caption}</div></div>`;
        const page = `${STYLE}${card(empty, 'No edits yet: both disabled, count 0')}${card(edited, 'Undo: Delete mesh: prop &middot; count 3')}${card(undone, 'After one undo: Redo: Delete mesh: prop &middot; 2/3')}`;
        if (!htmlScreenshotChrome.ok) throw new Error(htmlScreenshotChrome.reason);
        const shot = await saveHtmlScreenshot('viewport_undo_toolbar', page, { width: 900, height: 470, background: '#2a2d34' });
        const dir = path.join(REPO_ROOT, 'test-results', 'screenshots', 'viewport_undo');
        fs.mkdirSync(dir, { recursive: true });
        fs.copyFileSync(shot.path, path.join(dir, 'toolbar_states.png'));
        expect(shot.png.length).toBeGreaterThan(5_000);
    }, 90_000);
});
