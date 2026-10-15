/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * When a model other than the requested one produced an image or video, the UI says so: on media cards, on node
 * graph image/video nodes, and in the credit line of document media. Rendered with react-dom/server; a headless
 * Chrome screenshot of the rendered notices is saved to test-results/screenshots/ when Chrome is installed.
 */

import { describe, it, expect } from 'vitest';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { spawn } from 'child_process';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { mediaJobAttribution, substitutedModelNote, type MediaGenerationResult } from '../src/common/media-generation-protocol';
import { CinematicVideoCard, ImageGeneratedCard, MediaModelNotice } from '../src/browser/generative-canvas/chat/MediaCards';
import { NodeMediaStatus } from '../src/browser/generative-canvas/primitives/NodeGraphPrimitive';
import type { GraphNode } from '../src/browser/generative-canvas/canvas-types';

const asset = { uri: 'media://a', contentHash: 'a', mimeType: 'image/png', byteLength: 1, relativePath: 'a.png' };
const substituted: MediaGenerationResult = {
    asset,
    modelUsed: 'veo-3.1-fast-generate-preview',
    requestedModels: ['google/omni-1.1', 'veo-3.1-fast-generate-preview'],
    skippedModels: [{ model: 'google/omni-1.1', code: 'unsupported', reason: 'not served: models/google/omni-1.1 is not found' }],
    modelNote: 'Generated with veo-3.1-fast-generate-preview, not the requested google/omni-1.1: skipped google/omni-1.1 (not served: models/google/omni-1.1 is not found).'
};
const asRequested: MediaGenerationResult = {
    asset,
    modelUsed: 'gemini-3.1-flash-image',
    requestedModels: ['gemini-3.1-flash-image'],
    skippedModels: [],
    modelNote: 'Generated with gemini-3.1-flash-image.'
};

function node(parameters: Record<string, unknown>): GraphNode {
    return { id: 'n1', label: 'Hero shot', category: 'video', x: 0, y: 0, parameters } as unknown as GraphNode;
}

describe('Which model answered is visible when it is not the requested one', () => {
    it('substitutedModelNote is the note only when another model answered', () => {
        expect(substitutedModelNote(substituted)).toBe(substituted.modelNote);
        expect(substitutedModelNote(asRequested)).toBeUndefined();
        expect(substitutedModelNote({ modelUsed: 'b', requestedModels: ['a', 'b'] })).toBe('Generated with b, not the requested a.');
        expect(substitutedModelNote(undefined)).toBeUndefined();
    });

    it('document media credit the model that answered, not a hard-coded product name', () => {
        expect(mediaJobAttribution({ result: asRequested })).toBe('Generated with gemini-3.1-flash-image.');
        expect(mediaJobAttribution({ result: substituted })).toContain('not the requested google/omni-1.1');
        expect(mediaJobAttribution({ modelUsed: 'gemini-3-pro-image' })).toBe('Generated with gemini-3-pro-image.');
        expect(mediaJobAttribution({})).toBeUndefined();
    });

    it('media cards show the note under the media, and nothing extra without one', () => {
        const withNote = renderToStaticMarkup(React.createElement(CinematicVideoCard, { videoContent: '/v.mp4', modelNote: substitutedModelNote(substituted) }));
        expect(withNote).toContain('data-testid="sb-media-model-note"');
        expect(withNote).toContain('not the requested google/omni-1.1');
        const image = renderToStaticMarkup(React.createElement(ImageGeneratedCard, { imageContent: '/i.png', modelNote: substitutedModelNote(asRequested) }));
        expect(image).not.toContain('sb-media-model-note');
    });

    it('a node graph media node shows the substitution note, or the generation error, over its preview', () => {
        const noted = renderToStaticMarkup(React.createElement(NodeMediaStatus, { node: node({ mediaUrl: '/v.mp4', modelNote: substitutedModelNote(substituted) }) }));
        expect(noted).toContain('data-testid="sb-media-model-note"');
        expect(noted).toContain('veo-3.1-fast-generate-preview');
        const failed = renderToStaticMarkup(React.createElement(NodeMediaStatus, { node: node({ generationError: 'Media model google/omni-1.1 is unavailable: quota' }) }));
        expect(failed).toContain('data-testid="sb-node-media-error"');
        expect(failed).toContain('quota');
        expect(renderToStaticMarkup(React.createElement(NodeMediaStatus, { node: node({ mediaUrl: '/i.png' }) }))).toBe('');
        expect(renderToStaticMarkup(React.createElement(NodeMediaStatus, { node: node({ isGenerating: true, modelNote: 'x' }) }))).toBe('');
    });

    it('renders the notices for a screenshot', async () => {
        const chromePath = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser']
            .find(p => fs.existsSync(p));
        const nodeCard = (parameters: Record<string, unknown>) => `<div style="position:relative;width:240px;height:110px;background:#0a0a0a;border-radius:8px;overflow:hidden;margin:12px">
            <div style="color:#666;font:11px sans-serif;padding:40px 60px">video preview</div>${renderToStaticMarkup(React.createElement(NodeMediaStatus, { node: node(parameters) }))}</div>`;
        const html = `<!doctype html><html><body style="background:#18181b;margin:0;padding:12px;font-family:sans-serif">
            ${nodeCard({ mediaUrl: '/v.mp4', modelNote: substitutedModelNote(substituted) })}
            ${nodeCard({ generationError: 'Media model google/omni-1.1 is unavailable: Resource exhausted (after skipping veo-3.1: not served)' })}
            <div style="width:360px;margin:12px">${renderToStaticMarkup(React.createElement(MediaModelNotice, { note: substitutedModelNote(substituted) }))}</div>
        </body></html>`;
        expect(html).toContain('sb-node-media-error');
        if (!chromePath) return;

        const shotDir = path.resolve(__dirname, '../../../test-results/screenshots');
        await fs.ensureDir(shotDir);
        const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-model-notice-'));
        const page = path.join(work, 'notice.html');
        const shot = path.join(shotDir, 'media_model_notice_node_graph.png');
        await fs.writeFile(page, html);
        await fs.remove(shot);
        try {
            await new Promise<void>(resolve => {
                const proc = spawn(chromePath, ['--headless=new', '--hide-scrollbars', '--no-first-run', '--use-mock-keychain', '--window-size=420,420',
                    `--user-data-dir=${path.join(work, 'profile')}`, `--screenshot=${shot}`, `file://${page}`], { stdio: 'ignore' });
                let last = -1;
                const finish = () => { clearInterval(poll); clearTimeout(deadline); if (proc.exitCode === null) proc.kill('SIGKILL'); resolve(); };
                const poll = setInterval(() => {
                    const size = fs.existsSync(shot) ? fs.statSync(shot).size : -1;
                    if (size > 0 && size === last) finish();
                    last = size;
                }, 300);
                const deadline = setTimeout(finish, 60_000);
                proc.on('close', finish);
                proc.on('error', finish);
            });
            expect(fs.existsSync(shot)).toBe(true);
            expect(fs.statSync(shot).size).toBeGreaterThan(2000);
        } finally {
            // Chrome's helper processes can still be writing the profile when the main process is killed.
            await fs.promises.rm(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
        }
    }, 90_000);
});
