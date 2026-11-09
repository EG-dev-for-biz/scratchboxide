/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The window check card's presentation (WindowCheckCard.tsx): drawn in the viewport's own chrome, a popup centred on a
 * backdrop while the remesh stage runs and a corner card otherwise, with the selection state and the two buttons; and
 * the predicate that decides which (stagedBuildState.ts isRemeshRunning).
 */

import { describe, expect, test } from 'vitest';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { WindowCheckPanel, type WindowCheckPanelProps } from '../src/browser/generative-canvas/primitives/scene3d/stagedBuild/WindowCheckCard';
import { isRemeshRunning } from '../src/browser/generative-canvas/primitives/scene3d/stagedBuild/stagedBuildState';
import { CHROME_ACCENT, CHROME_PANEL } from '../src/browser/generative-canvas/primitives/scene3d/stagedBuild/viewportChrome';
import { fixtureState } from './helpers/staged-glb-fixture';

const PNG = 'iVBORw0KGgo=';
const check = { id: '0123456789abcdef', detail: 'Select every image where the yellow box is on a window.', tiles: Array.from({ length: 9 }, (_, i) => ({ id: `t${i}`, png: PNG })) };

function markup(extra: Partial<WindowCheckPanelProps> = {}): string {
    const noop = () => undefined;
    const props: WindowCheckPanelProps = { check, selected: new Set(), state: 'idle', note: '', modal: false, topPx: 12, leftPx: 72, onToggle: noop, onSend: noop, ...extra };
    return renderToStaticMarkup(React.createElement(WindowCheckPanel, props));
}

describe('the window check card', () => {
    test('as a popup: a backdrop over the whole viewport, the dialog modal and centred, in the viewport chrome', () => {
        const html = markup({ modal: true });
        expect(html).toContain('data-testid="sb-window-check-backdrop"');
        expect(html).toMatch(/sb-window-check-backdrop" style="position:absolute;inset:0;z-index:45;[^"]*display:flex;align-items:center;justify-content:center/);
        expect(html).toContain('aria-modal="true"');
        expect(html).toContain('data-placement="popup"');
        expect(html).toContain(`background:${CHROME_PANEL.background as string}`);
        expect(html).toContain('border-radius:10px');
        expect(html).toContain('while the building is remeshed');
        // none of the Material look it replaced
        expect(html).not.toContain('#1a73e8');
        expect(html).not.toContain('Roboto');
    });

    test('in the corner: no backdrop, absolute beside the toolstrip, not modal', () => {
        const html = markup({ modal: false, topPx: 12, leftPx: 72 });
        expect(html).not.toContain('sb-window-check-backdrop');
        expect(html).not.toContain('aria-modal');
        expect(html).toContain('data-placement="corner"');
        expect(html).toMatch(/position:absolute;top:12px;left:72px;z-index:40/);
    });

    test('nine tiles; a selected tile is pressed, bordered in the accent and badged; the count says so', () => {
        const html = markup({ selected: new Set(['t2', 't5']) });
        expect(html.match(/class="sb-window-check-tile"/g)?.length).toBe(9);
        expect(html.match(/aria-pressed="true"/g)?.length).toBe(2);
        expect(html).toContain(`border:2px solid ${CHROME_ACCENT}`);
        expect(html).toContain('aria-label="Image 3, selected"');
        expect(html).toContain('>2 selected<');
    });

    test('Skip is the secondary button and Verify the primary; the thank-you note replaces the grid', () => {
        const html = markup();
        expect(html).toMatch(/class="sb-window-check-skip"[^>]*style="[^"]*background:rgba\(255, 255, 255, 0\.08\)/);
        expect(html).toMatch(new RegExp(`class="sb-window-check-verify"[^>]*style="[^"]*background:${CHROME_ACCENT}`));
        expect(html).toContain('>Skip<');
        expect(html).toContain('>Verify<');
        const thanks = markup({ state: 'thanks', note: 'Thanks: 7 answers saved.' });
        expect(thanks).toContain('role="status"');
        expect(thanks).toContain('Thanks: 7 answers saved.');
        expect(thanks).not.toContain('class="sb-window-check-tile"');
    });
});

describe('the same card for the blob check', () => {
    test('its heading, note and JPEG tiles come from the check; the eyebrow is not the window check\'s', () => {
        const blob = {
            id: 'fedcba9876543210', base: '/3d/blob-check', lead: 'Select every image where the magenta box is on a', subject: 'car',
            note: 'Seen from straight above. Leave the others.', detail: 'Select every image where the magenta box is on a car.',
            tiles: Array.from({ length: 9 }, (_, i) => ({ id: `b${i}`, jpg: '/9j/4AAQ' }))
        };
        const html = markup({ check: blob, modal: true });
        expect(html).toContain('aria-label="Select every image where the magenta box is on a car."');
        expect(html).toContain(`magenta box is on a <span style="color:${CHROME_ACCENT}">car</span>.`);
        expect(html).toContain('Seen from straight above. Leave the others.');
        expect(html).toContain('>Quick check<');
        expect(html.match(/src="data:image\/jpeg;base64,/g)?.length).toBe(9);
        expect(markup()).toContain('>Window check<');
    });
});

describe('when the popup shows', () => {
    const now = Date.now();
    test('while the remesh stage runs in a live run', () => {
        const st = fixtureState([], { running: ['remesh'], updatedAtMs: now });
        expect(isRemeshRunning(st, now - 60_000)).toBe(true);
    });
    test('not while another stage runs, nor once the run is over or interrupted', () => {
        expect(isRemeshRunning(fixtureState([], { running: ['fit'], updatedAtMs: now }), now - 60_000)).toBe(false);
        expect(isRemeshRunning(fixtureState([], { running: ['remesh'], runState: 'finished', updatedAtMs: now }), now - 60_000)).toBe(false);
        expect(isRemeshRunning(fixtureState([], { running: ['remesh'], runState: 'interrupted', updatedAtMs: now }), now - 60_000)).toBe(false);
        // a running state saved before this page loaded: no stream survives a page load
        expect(isRemeshRunning(fixtureState([], { running: ['remesh'], updatedAtMs: now - 120_000 }), now)).toBe(false);
    });
});
