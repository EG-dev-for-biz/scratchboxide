/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * "Switch location": the other places Google found for ambiguous text become clickable pills in the chat, and a click
 * redoes the staged build at that exact place (its coordinates), with no second geocode and the original settings.
 */

import { describe, it, expect, afterAll, vi } from 'vitest';
import * as React from 'react';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChatMarkdownRenderer } from '../src/browser/generative-canvas/ChatMarkdownRenderer';
import { buildSwitchLocationPills, switchLocationLabel, switchLocationMarkdown } from '../src/common/spatial/switch-location';
import { runStagedLocationTool } from '../src/node/3d-engine/staged-location/staged-location-tool';
import { StageCache } from '../src/node/3d-engine/staged-location/stage-cache';
import type { StagedLocationDeps } from '../src/node/3d-engine/staged-location/orchestrator';
import type { ToolContext } from '../src/node/gemini/tools/types';
import { fakeNative, type WorldSpec } from './helpers/staged-synthetic-world';
import { htmlScreenshotChrome, saveHtmlScreenshot } from './helpers/html-screenshot';
import { withReason } from './helpers/requirements';

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-switch-loc-')));
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

const PARK: WorldSpec = { ground: 80, buildings: [[30, 44, 30, 40, 9]], trees: [{ x: -12, z: -10, r: 4, h: 7, id: 3 }] };
const NYC = { lat: 40.78256, lng: -73.96558, formattedAddress: 'Central Park, New York, NY, USA', placeId: 'ChIJ-nyc' };
const ALTS = [
    { name: 'Central Park', formattedAddress: 'Central Park, Santa Clarita, CA 91350, USA', lat: 34.4208, lng: -118.5084, placeId: 'ChIJ-sc', userRatingCount: 2414 },
    { name: 'Central Park', formattedAddress: 'Central Park, Pasadena, CA 91101, USA', lat: 34.1478, lng: -118.1445, placeId: 'ChIJ-pas', userRatingCount: 900 }
];

/** The pill buttons in a rendered chat message, found by walking the element tree the way React would render it. */
function pillButtons(text: string, onPromptAction: (p: string) => void): Array<{ label: string; click: () => void }> {
    const found: Array<{ label: string; click: () => void }> = [];
    const text0 = (n: unknown): string => typeof n === 'string' ? n : Array.isArray(n) ? n.map(text0).join('') : (n as any)?.props ? text0((n as any).props.children) : '';
    const walk = (node: any): void => {
        if (Array.isArray(node)) return node.forEach(walk);
        if (!node || typeof node !== 'object' || !node.type) return;
        if (typeof node.type === 'function') return walk(node.type.prototype?.isReactComponent ? node.props.children : node.type(node.props));
        if (node.type === 'button' && String(node.props.className).includes('sb-chat-action-pill')) {
            found.push({ label: text0(node.props.children).replace(/^✦/, ''), click: () => node.props.onClick({ preventDefault() { /* */ }, stopPropagation() { /* */ } }) });
        }
        walk(node.props?.children);
    };
    // the components are called directly, outside a render: give them the one hook they use
    const dispatcher = (React as any).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher;
    const previous = dispatcher.current;
    dispatcher.current = { useMemo: (f: () => unknown) => f() };
    try { walk(React.createElement(ChatMarkdownRenderer, { text, onPromptAction })); } finally { dispatcher.current = previous; }
    return found;
}

function setup(geocode: StagedLocationDeps['geocode']) {
    const root = path.join(TMP, `ws${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(root, { recursive: true });
    const native = fakeNative(path.join(root, 'native'), PARK, {});
    const extracts: Array<{ lat: number; lng: number; address: string }> = [];
    let runs = 0;
    const deps: StagedLocationDeps = {
        cache: new StageCache({ workspaceRoot: root }),
        geocode,
        extract: async req => { extracts.push({ lat: req.lat, lng: req.lng, address: req.place.formattedAddress }); return native.deps.extract(req); },
        vegetation: native.deps.vegetation, refine: native.deps.refine,
        newRunId: () => (0xc0ffee00 + ++runs).toString(16), sleep: async () => undefined
    };
    const ctx = { emitStage: () => undefined, reportProgress: () => undefined, request: {} } as unknown as ToolContext;
    return { deps, ctx, extracts };
}

describe('Switch location', () => {
    it('labels a place by its name and the locality that follows it in its address', () => {
        expect(switchLocationLabel(ALTS[0])).toBe('Central Park, Santa Clarita');
        expect(switchLocationLabel({ formattedAddress: 'Main St, Ohio, USA' })).toBe('Main St, Ohio');
        expect(switchLocationLabel({ formattedAddress: 'Atlantis' })).toBe('Atlantis');
    });

    it('makes no pills when Google found nothing else', () => {
        expect(buildSwitchLocationPills({ ...NYC }, { query: 'central park', isolate: false, trees: true })).toEqual([]);
        expect(buildSwitchLocationPills({ ...NYC, alternatives: [] }, { query: 'central park', isolate: false, trees: true })).toEqual([]);
        expect(switchLocationMarkdown([])).toBe('');
    });

    it('a staged build with alternatives puts one pill per alternative in the summary; with none, no pills', async () => {
        const withAlts = setup(async () => ({ ...NYC, alternatives: ALTS }));
        const out = await runStagedLocationTool('google_3d_tiles_get_clay', { query: 'Central Park', radiusMeters: 60 }, withAlts.ctx, withAlts.deps);
        const summary = (out.resultPayload as any).summary as string;
        expect(summary).toContain('Switch location');
        expect(summary.match(/\]\(prompt:/g)).toHaveLength(2);
        expect(summary).toContain('[Central Park, Santa Clarita](prompt:');
        expect(summary).toContain('[Central Park, Pasadena](prompt:');

        const none = setup(async () => ({ ...NYC }));
        const out2 = await runStagedLocationTool('google_3d_tiles_get_clay', { query: 'Central Park', radiusMeters: 60 }, none.ctx, none.deps);
        expect((out2.resultPayload as any).summary).not.toContain('Switch location');
        expect((out2.resultPayload as any).summary).not.toContain('](prompt:');
    });

    it('the chat renders those lines as pill buttons, and a click sends the prompt for that exact place', async () => {
        const s = setup(async () => ({ ...NYC, alternatives: ALTS }));
        const out = await runStagedLocationTool('google_3d_tiles_get_clay', { query: 'Central Park', radiusMeters: 60, isolate: false }, s.ctx, s.deps);
        const summary = (out.resultPayload as any).summary as string;
        const reply = `Built Central Park in clay.\n\n${summary.slice(summary.indexOf('Switch location'))}`;
        const sent: string[] = [];
        const pills = pillButtons(reply, p => sent.push(p));
        expect(pills.map(p => p.label)).toEqual(['Central Park, Santa Clarita', 'Central Park, Pasadena']);
        pills[0].click();
        expect(sent).toHaveLength(1);
        expect(sent[0]).toContain('google_3d_tiles_get_clay');
        expect(sent[0]).toContain('"Central Park"');
        expect(sent[0]).toContain('radiusMeters: 60');
        expect(sent[0]).toContain('trees: true');
        expect(sent[0]).toContain('34.4208');
        expect(JSON.parse(/place (\{.*\}) exactly/.exec(sent[0])![1])).toMatchObject({ lat: 34.4208, lng: -118.5084, placeId: 'ChIJ-sc' });
    });

    it('running the call a pill sends builds at that place without geocoding the text', async () => {
        const first = setup(async () => ({ ...NYC, alternatives: ALTS }));
        const out = await runStagedLocationTool('google_3d_tiles_get_clay', { query: 'Central Park', radiusMeters: 60 }, first.ctx, first.deps);
        const summary = (out.resultPayload as any).summary as string;
        const sent: string[] = [];
        pillButtons(summary.slice(summary.indexOf('Switch location')), p => sent.push(p))[0].click();
        const placeJson = /place (\{.*\}) exactly as given/.exec(sent[0])![1];

        const geocode = vi.fn(async () => { throw new Error('the text must not be geocoded again'); });
        const second = setup(geocode as never);
        const out2 = await runStagedLocationTool('google_3d_tiles_get_clay', { query: 'Central Park', radiusMeters: 60, trees: true, place: JSON.parse(placeJson) }, second.ctx, second.deps);
        expect(geocode).not.toHaveBeenCalled();
        expect(second.extracts).toEqual([{ lat: 34.4208, lng: -118.5084, address: 'Central Park, Santa Clarita, CA 91350, USA' }]);
        expect((out2.resultPayload as any).resolvedAddress).toBe('Central Park, Santa Clarita, CA 91350, USA');
        // the places still on offer include the one that was shown first, so the user can switch back
        const s2 = (out2.resultPayload as any).summary as string;
        expect(s2).toContain('[Central Park, New York](prompt:');
        expect(s2).toContain('[Central Park, Pasadena](prompt:');
        expect(s2).not.toContain('[Central Park, Santa Clarita](prompt:');
    });

    it('rejects a place without coordinates instead of filling them in', async () => {
        const s = setup(async () => ({ ...NYC }));
        await expect(runStagedLocationTool('google_3d_tiles_get_clay', { query: 'q', place: { formattedAddress: 'x' } }, s.ctx, s.deps)).rejects.toThrow(/place of \{lat, lng, formattedAddress\}/);
    });

    it.skipIf(!htmlScreenshotChrome.ok)(withReason('shows the pills in the chat (screenshot)', htmlScreenshotChrome), async () => {
        const reply = 'Built **Central Park, New York** in clay (most prominent match).\n\nSwitch location:\n' + switchLocationMarkdown(buildSwitchLocationPills({ ...NYC, alternatives: ALTS }, { query: 'central park', isolate: false, radiusM: 250, trees: true }));
        const html = renderToStaticMarkup(React.createElement(ChatMarkdownRenderer, { text: reply, onPromptAction: () => undefined }));
        expect(html).toContain('Central Park, Santa Clarita');
        const css = fs.readFileSync(path.join(__dirname, '../src/browser/style/unified-ui.css'), 'utf8');
        const pillCss = css.slice(css.indexOf('.sb-chat-action-pill-item {'), css.indexOf('.sb-chat-action-pill:active'));
        const shot = await saveHtmlScreenshot('switch_location_pills', `<style>${pillCss}</style><div style="padding:20px;font-size:14px;line-height:1.6">${html}</div>`, { width: 640, height: 220, background: '#18181b' });
        const dest = path.resolve(__dirname, '../../../test-results/screenshots/switch_location');
        fs.mkdirSync(dest, { recursive: true });
        fs.copyFileSync(shot.path, path.join(dest, 'switch_location_pills.png'));
        expect(shot.png.length).toBeGreaterThan(3000);
    });
});
