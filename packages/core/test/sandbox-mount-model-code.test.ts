/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * A code sandbox mounts only with the model's code. A live-code-sandbox mount (or envelope) without files used to report
 * success, and the sandbox then showed its own built-in demo app ("Trigger Interactive Action") as if the model had
 * written it.
 */
import { describe, it, expect } from 'vitest';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { canvasHandlers } from '../src/node/gemini/tools/canvas-tools';
import { parseOrSynthesizeArtifact } from '../src/node/gemini/artifact-synthesis';
import { LiveCodeSandboxPrimitive } from '../src/browser/generative-canvas/primitives/LiveCodeSandboxPrimitive';
import type { CanvasArtifact, LiveCodeSandboxData } from '../src/browser/generative-canvas/canvas-types';
import type { GeminiGenerateRequest } from '../src/common/gemini-protocol';
import { decodePng } from '../src/node/texture-processing';
import { htmlScreenshotChrome, saveHtmlScreenshot } from './helpers/html-screenshot';
import { withReason } from './helpers/requirements';

const mount = (args: Record<string, unknown>) => canvasHandlers.mount_canvas_primitive(args, { request: { prompt: '', chatHistory: [] } } as any) as Promise<any>;
const request = (): GeminiGenerateRequest => ({ prompt: 'make me an app', chatHistory: [] } as any);

describe('a live-code-sandbox mounts only with the model\'s code', () => {
    const appCode = 'export default function App() {\n  return <h1>Budget</h1>;\n}\n';

    it('a mount with no file holding code fails and mounts nothing', async () => {
        for (const payload of [{ title: 'Budget app' }, { code: appCode }, { files: [] }, { files: [{ name: 'App.tsx', content: '   ' }] }, { files: [{ content: appCode }] }]) {
            const res = await mount({ primitiveType: 'live-code-sandbox', title: 'Budget app', payload });
            expect(res.status).toBe('failed');
            expect(res.resultPayload.success).toBe(false);
            expect(res.resultPayload.artifact).toBeUndefined();
            expect(res.resultPayload.error).toContain('payload.files');
        }
    });

    it('a mount with files keeps exactly the model\'s code, filling in only a missing id or language', async () => {
        const res = await mount({ primitiveType: 'live-code-sandbox', title: 'Budget app', payload: { files: [{ name: 'App.tsx', content: appCode, isEntry: true }, { id: 'css', name: 'budget.css', language: 'css', content: 'h1 { color: teal; }' }] } });
        expect(res.resultPayload.status).toBe('success');
        const data = (res.resultPayload.artifact as CanvasArtifact).data as LiveCodeSandboxData;
        expect(data.files).toEqual([
            { id: 'file-1', name: 'App.tsx', language: 'react', content: appCode, isEntry: true },
            { id: 'css', name: 'budget.css', language: 'css', content: 'h1 { color: teal; }' }
        ]);
        // A {name: content} map is the same files.
        const asMap = await mount({ primitiveType: 'live-code-sandbox', title: 'Budget app', payload: { files: { 'src/App.tsx': appCode } } });
        expect(((asMap.resultPayload.artifact as CanvasArtifact).data as LiveCodeSandboxData).files.map(f => [f.name, f.content])).toEqual([['App.tsx', appCode]]);
    });

    it('an envelope or tag with no code opens no sandbox; one with code opens the model\'s files', () => {
        expect(parseOrSynthesizeArtifact('make me an app', '```json\n{"type":"live-code-sandbox","data":{}}\n```', request(), [])).toBeUndefined();
        expect(parseOrSynthesizeArtifact('make me an app', '```json\n{"type":"live-code-sandbox","data":{"title":"Budget","files":[]}}\n```', request(), [])).toBeUndefined();
        expect(parseOrSynthesizeArtifact('make me an app', '<scratchboxPrimitive type="live-code-sandbox" title="Budget">{"title":"Budget"}</scratchboxPrimitive>', request(), [])).toBeUndefined();

        const envelope = parseOrSynthesizeArtifact('make me an app', '```json\n' + JSON.stringify({ type: 'live-code-sandbox', data: { title: 'Budget', files: [{ name: 'App.tsx', content: appCode }] } }) + '\n```', request(), []);
        expect(envelope?.type).toBe('live-code-sandbox');
        expect((envelope?.data as LiveCodeSandboxData).files.map(f => f.content)).toEqual([appCode]);

        const tag = parseOrSynthesizeArtifact('make me an app', '<scratchboxPrimitive type="live-code-sandbox" title="Budget">\n```tsx\n' + appCode + '```\n</scratchboxPrimitive>', request(), []);
        expect((tag?.data as LiveCodeSandboxData).files[0].content).toBe(appCode.trim());
    });

    it('a sandbox with no files says so instead of showing a built-in demo app', () => {
        for (const viewMode of ['code', 'preview'] as const) {
            const html = renderToStaticMarkup(React.createElement(LiveCodeSandboxPrimitive, { data: { title: 'Budget app', files: [], viewMode } as any }));
            expect(html).toContain('This sandbox has no files');
            expect(html).toContain('&quot;Budget app&quot; was opened without any code');
            for (const demo of ['Trigger Interactive Action', 'Scratchbox Live UI Sandbox', 'title="App.tsx"', 'title="styles.css"', 'title="package.json"']) expect(html).not.toContain(demo);
        }
        const missing = renderToStaticMarkup(React.createElement(LiveCodeSandboxPrimitive, { data: { title: 'Budget app' } as any }));
        expect(missing).toContain('This sandbox has no files');

        // With the model's files it shows them, and only them.
        const withFiles = renderToStaticMarkup(React.createElement(LiveCodeSandboxPrimitive, { data: { title: 'Budget app', viewMode: 'code', files: [{ id: 'f', name: 'Budget.tsx', language: 'react', content: appCode, isEntry: true }] } as any }));
        expect(withFiles).toContain('title="Budget.tsx"');
        expect(withFiles).not.toContain('This sandbox has no files');
        for (const demoTab of ['title="App.tsx"', 'title="styles.css"', 'title="package.json"']) expect(withFiles).not.toContain(demoTab);
    });

    it.skipIf(!htmlScreenshotChrome.ok)(withReason('screenshots the empty sandbox state', htmlScreenshotChrome), async () => {
        const html = renderToStaticMarkup(React.createElement(LiveCodeSandboxPrimitive, { data: { title: 'Budget app', files: [] } as any, onUpdate: () => undefined }));
        expect(html).toContain('New empty App.tsx');
        const shot = await saveHtmlScreenshot('live_code_sandbox_no_files', html, { background: '#09090b' });
        const { data } = decodePng(shot.png);
        // Light text on the dark panel: some bright pixels, and not the demo app's blue gradient button.
        let bright = 0;
        let blue = 0;
        for (let i = 0; i < data.length; i += 4) {
            if (data[i] > 180 && data[i + 1] > 180 && data[i + 2] > 180) bright++;
            if (data[i + 2] > 180 && data[i] < 90 && data[i + 1] < 140) blue++;
        }
        expect(bright).toBeGreaterThan(300);
        expect(blue).toBe(0);
    });
});
