import { test } from 'vitest';
/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import {
    InteractiveBrowserData,
    PrimitiveType,
    StudioLayoutMode,
    WorkspaceFileType,
    CanvasArtifact
} from '../src/browser/generative-canvas/canvas-types';
import { resolveModeForArtifact, sanitizeLayoutMode } from '../src/browser/generative-canvas/guardrails-service';
import { morphArtifact } from '../src/browser/generative-canvas/primitive-transformer-engine';
import { BrowserProxyService } from '../src/node/browser-proxy-service';
import { readStudioSources } from './source-helpers';

async function runInteractiveBrowserTests() {
    console.log('🧪 Running Interactive Web Browser Canvas Primitive Test Suite...');

    // -------------------------------------------------------------------------
    // Test 1: Validate Data Model & Type System
    // -------------------------------------------------------------------------
    console.log('  [Test 1] Validating Type Definitions & Interfaces...');

    const validPrimitives: PrimitiveType[] = [
        'metric-dashboard',
        'kanban-board',
        'interactive-form',
        'mind-map',
        'checklist',
        'markdown-document',
        'node-graph',
        'skills-hub',
        'mcp-hub',
        'live-code-sandbox',
        '3d-scene',
        'interactive-browser',
        'browser'
    ];

    assert.ok(validPrimitives.includes('interactive-browser'), 'PrimitiveType must include interactive-browser');
    assert.ok(validPrimitives.includes('browser'), 'PrimitiveType must include browser');

    const validLayoutModes: StudioLayoutMode[] = ['chat', 'code', 'document', 'kanban', 'automation', 'canvas', '3d', 'browser'];
    assert.ok(validLayoutModes.includes('browser'), 'StudioLayoutMode must include browser');

    const validFileTypes: WorkspaceFileType[] = ['chat', 'code', 'document', 'kanban', 'automation', '3d', 'browser'];
    assert.ok(validFileTypes.includes('browser'), 'WorkspaceFileType must include browser');

    const sampleBrowserData: InteractiveBrowserData = {
        url: 'http://localhost:3000',
        title: 'Scratchbox IDE Dev Server',
        favicon: 'https://example.com/favicon.ico',
        viewportMode: 'desktop',
        history: ['http://localhost:3000', 'https://news.ycombinator.com'],
        historyIndex: 1,
        isLoading: false,
        consoleLogs: [
            { type: 'info', text: 'Browser initialized', timestamp: '12:00:00 PM' },
            { type: 'warn', text: 'Third-party cookies blocked in sandboxed iframe', timestamp: '12:00:01 PM' },
            { type: 'error', text: 'Failed to load resource: net::ERR_CONNECTION_REFUSED', timestamp: '12:00:02 PM' },
            { type: 'log', text: 'Page navigation complete', timestamp: '12:00:03 PM' }
        ],
        inspectMode: true,
        deviceScale: 1
    };

    assert.strictEqual(sampleBrowserData.url, 'http://localhost:3000');
    assert.strictEqual(sampleBrowserData.viewportMode, 'desktop');
    assert.strictEqual(sampleBrowserData.history?.length, 2);
    assert.strictEqual(sampleBrowserData.consoleLogs?.length, 4);
    assert.strictEqual(sampleBrowserData.inspectMode, true);
    console.log('  ✓ Test 1 Passed: InteractiveBrowserData and type unions properly structured.');

    // -------------------------------------------------------------------------
    // Test 2: Mode Resolver and Guardrails Sanitization
    // -------------------------------------------------------------------------
    console.log('  [Test 2] Validating Mode Resolver & Guardrails for Browser...');

    assert.strictEqual(resolveModeForArtifact('interactive-browser'), 'browser');
    assert.strictEqual(resolveModeForArtifact('browser'), 'browser');

    const browserArtifact: CanvasArtifact = {
        id: 'art-browser-test',
        type: 'interactive-browser',
        title: 'Live Web Browser',
        summary: 'AI-controllable web canvas',
        data: sampleBrowserData,
        createdAt: '12:00 PM',
        version: 1
    };

    assert.strictEqual(sanitizeLayoutMode('browser', browserArtifact), 'browser');
    assert.strictEqual(sanitizeLayoutMode(undefined, browserArtifact), 'browser');
    console.log('  ✓ Test 2 Passed: Mode resolver and guardrails accurately map browser artifacts.');

    // -------------------------------------------------------------------------
    // Test 3: Primitive Transformer Engine Morphing
    // -------------------------------------------------------------------------
    console.log('  [Test 3] Validating Polymorphic Morphing to/from Browser...');

    const sandboxArtifact: CanvasArtifact = {
        id: 'art-sandbox-test',
        type: 'live-code-sandbox',
        title: 'React Weather App',
        summary: 'Live React component sandbox',
        data: {
            title: 'React Weather App',
            template: 'react',
            files: [
                {
                    id: 'file-1',
                    name: 'App.tsx',
                    language: 'react',
                    content: 'export default function App() { return <h1>Weather in SF: 68°F</h1>; }',
                    isEntry: true
                }
            ],
            viewportMode: 'mobile'
        },
        createdAt: '12:00 PM',
        version: 1
    };

    const morphedToBrowser = morphArtifact(sandboxArtifact, 'interactive-browser');
    assert.strictEqual(morphedToBrowser.type, 'interactive-browser');
    assert.ok(morphedToBrowser.title.includes('React Weather App'));
    const morphedBrowserData = morphedToBrowser.data as InteractiveBrowserData;
    assert.ok(morphedBrowserData.url, 'Morphed browser must have a URL or sandbox preview');
    assert.ok(morphedBrowserData.consoleLogs && morphedBrowserData.consoleLogs.length > 0, 'Must initialize console logs');

    const morphedBackToSandbox = morphArtifact(morphedToBrowser, 'live-code-sandbox');
    assert.strictEqual(morphedBackToSandbox.type, 'live-code-sandbox');
    console.log('  ✓ Test 3 Passed: Artifact morphing between sandbox and browser canvas works seamlessly.');

    // -------------------------------------------------------------------------
    // Test 4: Verify InteractiveBrowserPrimitive.tsx Component Source
    // -------------------------------------------------------------------------
    console.log('  [Test 4] Verifying InteractiveBrowserPrimitive.tsx implementation...');

    const primitiveFilePath = path.resolve(__dirname, '../src/browser/generative-canvas/primitives/InteractiveBrowserPrimitive.tsx');
    assert.ok(fs.existsSync(primitiveFilePath), 'InteractiveBrowserPrimitive.tsx file must exist');

    const primitiveSource = fs.readFileSync(primitiveFilePath, 'utf-8');

    // Check top chrome controls
    assert.ok(primitiveSource.includes('sb-browser-chrome'), 'Must contain top browser chrome bar');
    assert.ok(primitiveSource.includes('sb-browser-address-bar'), 'Must contain URL address bar');
    assert.ok(primitiveSource.includes('sb-browser-nav-btn'), 'Must contain navigation buttons (Back, Forward, Refresh)');
    assert.ok(primitiveSource.includes('viewportMode'), 'Must support viewport modes (desktop, tablet, mobile, responsive)');

    // Check main viewport and sandbox iframe / proxy support
    assert.ok(primitiveSource.includes('sb-browser-viewport-frame'), 'Must contain device viewport frame');
    assert.ok(primitiveSource.includes('<iframe'), 'Must render interactive iframe');
    assert.ok(primitiveSource.includes('sandbox='), 'Must enforce security sandbox attribute on iframe');
    assert.ok(primitiveSource.includes('/api/browser/proxy') || primitiveSource.includes('resolveFrameUrl'), 'Must support backend proxy URL routing');
    assert.ok(primitiveSource.includes('scratchbox-browser-navigate'), 'Must support bridge message listener for in-page navigation sync');

    // Check developer drawer and AI prompt action
    assert.ok(primitiveSource.includes('sb-browser-console-drawer'), 'Must contain developer console drawer');
    assert.ok(primitiveSource.includes('onPromptAction'), 'Must support AI Agent Prompt Action triggers');
    assert.ok(primitiveSource.includes('Inspect DOM') || primitiveSource.includes('inspectMode'), 'Must support inspect mode');
    assert.ok(primitiveSource.includes('timelineSteps'), 'Must contain timelineSteps state for AI Agent timeline tracking');
    assert.ok(primitiveSource.includes('clickMarker'), 'Must contain clickMarker state for visual action feedback');
    assert.ok(primitiveSource.includes('triggerSnapshotFetch'), 'Must support triggerSnapshotFetch to request DOM updates');
    assert.ok(primitiveSource.includes('/api/browser/pending-actions'), 'Must poll /api/browser/pending-actions for AI actions');

    console.log('  ✓ Test 4 Passed: InteractiveBrowserPrimitive has all required controls, device frame, and developer drawer.');

    // -------------------------------------------------------------------------
    // Test 5: Verify GenerativeCanvasStudio.tsx Integration
    // -------------------------------------------------------------------------
    console.log('  [Test 5] Verifying GenerativeCanvasStudio.tsx Integration...');

    const studioFilePath = path.resolve(__dirname, '../src/browser/generative-canvas/GenerativeCanvasStudio.tsx');
    assert.ok(fs.existsSync(studioFilePath), 'GenerativeCanvasStudio.tsx file must exist');
    const studioSource = readStudioSources();

    assert.ok(studioSource.includes("handleCreateWorkspaceFile('browser')") || studioSource.includes("type === 'browser'"), 'Must support creating browser workspace files');
    assert.ok(studioSource.includes("layoutMode === 'browser'"), 'Must support layout rendering for browser mode');
    assert.ok(studioSource.includes('InteractiveBrowserPrimitive'), 'Must render InteractiveBrowserPrimitive inside studio');
    assert.ok(studioSource.includes('navigate to') || studioSource.includes('interactive-browser'), 'Must support AI chat reactive navigation for browser');

    console.log('  ✓ Test 5 Passed: GenerativeCanvasStudio integration verified.');

    // -------------------------------------------------------------------------
    // Test 6: Verify Unified CSS Styling
    // -------------------------------------------------------------------------
    console.log('  [Test 6] Verifying Unified UI CSS Styles...');

    const cssFilePath = path.resolve(__dirname, '../src/browser/style/unified-ui.css');
    assert.ok(fs.existsSync(cssFilePath), 'unified-ui.css must exist');
    const cssSource = fs.readFileSync(cssFilePath, 'utf-8');

    assert.ok(cssSource.includes('.sb-browser-primitive-container'), 'CSS must define .sb-browser-primitive-container');
    assert.ok(cssSource.includes('.sb-browser-chrome'), 'CSS must define .sb-browser-chrome');
    assert.ok(cssSource.includes('.sb-browser-address-bar'), 'CSS must define .sb-browser-address-bar');
    assert.ok(cssSource.includes('.sb-browser-viewport-frame'), 'CSS must define .sb-browser-viewport-frame');
    assert.ok(cssSource.includes('.sb-browser-console-drawer'), 'CSS must define .sb-browser-console-drawer');

    console.log('  ✓ Test 6 Passed: Unified UI CSS classes present.');

    // -------------------------------------------------------------------------
    // Test 7: BrowserProxyService URL Normalization & Header Sanitization
    // -------------------------------------------------------------------------
    console.log('  [Test 7] Verifying BrowserProxyService URL Normalization & Header Sanitization...');

    const proxyService = new BrowserProxyService();
    assert.strictEqual(proxyService.normalizeUrl('github.com'), 'https://github.com');
    assert.strictEqual(proxyService.normalizeUrl('localhost:3000'), 'http://localhost:3000');
    assert.strictEqual(proxyService.normalizeUrl('http://127.0.0.1:8080/test'), 'http://127.0.0.1:8080/test');
    assert.strictEqual(proxyService.normalizeUrl('https://news.ycombinator.com'), 'https://news.ycombinator.com');

    const headersWithRestrictions = {
        'x-frame-options': 'DENY',
        'content-security-policy': "default-src 'self'; frame-ancestors 'none'",
        'content-security-policy-report-only': "frame-ancestors 'none'",
        'strict-transport-security': 'max-age=31536000; includeSubDomains',
        'cross-origin-embedder-policy': 'require-corp',
        'cross-origin-opener-policy': 'same-origin',
        'cross-origin-resource-policy': 'same-origin',
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'public, max-age=3600'
    };

    const sanitized = proxyService.sanitizeResponseHeaders(headersWithRestrictions);
    assert.strictEqual(sanitized['x-frame-options'], undefined, 'Must strip x-frame-options');
    assert.strictEqual(sanitized['content-security-policy'], undefined, 'Must strip content-security-policy');
    assert.strictEqual(sanitized['content-security-policy-report-only'], undefined, 'Must strip content-security-policy-report-only');
    assert.strictEqual(sanitized['cross-origin-embedder-policy'], undefined, 'Must strip cross-origin-embedder-policy');
    assert.strictEqual(sanitized['cross-origin-opener-policy'], undefined, 'Must strip cross-origin-opener-policy');
    assert.strictEqual(sanitized['cross-origin-resource-policy'], undefined, 'Must strip cross-origin-resource-policy');
    assert.strictEqual(sanitized['access-control-allow-origin'], '*', 'Must add CORS allow-origin wildcard');
    assert.strictEqual(sanitized['content-type'], 'text/html; charset=utf-8', 'Must retain content-type');

    // Verify BrowserOS state management and action queuing logic
    assert.strictEqual(proxyService.getActiveState().url, 'https://example.com');
    proxyService.updateState({ url: 'https://scratchbox.ai', title: 'Scratchbox Studio' });
    assert.strictEqual(proxyService.getActiveState().url, 'https://scratchbox.ai');
    assert.strictEqual(proxyService.getActiveState().title, 'Scratchbox Studio');

    const actionPromise = proxyService.queueAction('click', { elementId: '5' });
    const pending = proxyService.getPendingActions();
    assert.strictEqual(pending.length, 1, 'Must have 1 pending action queued');
    assert.strictEqual(pending[0].action, 'click');
    assert.strictEqual(pending[0].params.elementId, '5');

    proxyService.resolveAction(pending[0].id, true, { coords: { x: 100, y: 200 } });
    const resolvedResult = await actionPromise;
    assert.strictEqual(resolvedResult.coords.x, 100);
    assert.strictEqual(resolvedResult.coords.y, 200);

    console.log('  ✓ Test 7 Passed: BrowserProxyService accurately normalizes URLs, strips framing restrictions, and manages active session state/action queues.');

    // -------------------------------------------------------------------------
    // Test 8: BrowserProxyService HTML Rewriting & Bridge Injection
    // -------------------------------------------------------------------------
    console.log('  [Test 8] Verifying HTML Rewriting, <base href>, and Client Bridge Script...');

    const sampleHtml = `<!DOCTYPE html><html><head><title>GitHub: Let’s build from here</title><link rel="stylesheet" href="/assets/style.css"></head><body><h1>Welcome to GitHub</h1><a href="/login">Sign In</a></body></html>`;
    const targetUrl = 'https://github.com';
    const rewritten = proxyService.rewriteHtml(sampleHtml, targetUrl, targetUrl);

    assert.ok(rewritten.includes('<base href="https://github.com"'), 'Rewritten HTML must contain <base href="https://github.com">');
    assert.ok(rewritten.includes('scratchbox-browser-bridge'), 'Rewritten HTML must include scratchbox-browser-bridge script');
    assert.ok(rewritten.includes('scratchbox-browser-navigate'), 'Rewritten HTML bridge script must include scratchbox-browser-navigate handler');
    assert.ok(rewritten.includes('scratchbox-browser-metadata'), 'Rewritten HTML bridge script must include scratchbox-browser-metadata handler');
    assert.ok(rewritten.includes('scratchbox-browser-console'), 'Rewritten HTML bridge script must include scratchbox-browser-console interceptor');
    assert.ok(rewritten.includes('indexElements'), 'Rewritten HTML bridge script must include indexElements');
    assert.ok(rewritten.includes('convertHtmlToMarkdown'), 'Rewritten HTML bridge script must include convertHtmlToMarkdown');
    assert.ok(rewritten.includes('generateAccessibilityTree'), 'Rewritten HTML bridge script must include generateAccessibilityTree');
    assert.ok(rewritten.includes('scratchbox-browser-action'), 'Rewritten HTML bridge script must include scratchbox-browser-action message listener');

    console.log('  ✓ Test 8 Passed: HTML base href injection and client bridge script successfully injected.');

    // -------------------------------------------------------------------------
    // Test 9: Verify BrowserProxyEndpoint Registration in Backend Module
    // -------------------------------------------------------------------------
    console.log('  [Test 9] Verifying Backend Module Registration...');

    const serverAppPath = path.resolve(__dirname, '../../../desktop-app/server/app.ts');
    assert.ok(fs.existsSync(serverAppPath), 'desktop-app/server/app.ts must exist');
    const serverAppSource = fs.readFileSync(serverAppPath, 'utf-8');
    assert.ok(serverAppSource.includes('BrowserProxyService'), 'Standalone server must wire BrowserProxyService');
    assert.ok(serverAppSource.includes("'/api/browser'"), 'Standalone server must mount the /api/browser router');

    console.log('  ✓ Test 9 Passed: BrowserProxyService wired into the standalone server.');

    // -------------------------------------------------------------------------
    // Test 10: Mock Proxy Endpoint HTTP Response Synthesis
    // -------------------------------------------------------------------------
    console.log('  [Test 10] Verifying Proxy Engine URL Fetch Simulation...');

    const simulatedHtml = `<html><head><title>Hacker News</title></head><body><a href="https://news.ycombinator.com/news">Hacker News</a></body></html>`;
    const simulatedRewritten = proxyService.rewriteHtml(simulatedHtml, 'https://news.ycombinator.com', 'https://news.ycombinator.com');
    assert.ok(simulatedRewritten.includes('<base href="https://news.ycombinator.com"'), 'Simulated HTML must have base href');
    assert.ok(simulatedRewritten.includes('Hacker News'), 'Simulated HTML must contain content');

    console.log('  ✓ Test 10 Passed: Proxy Engine response processing verified.');

    // -------------------------------------------------------------------------
    // Test 11: Verify Link Routing & Grounding Interception to In-App Browser
    // -------------------------------------------------------------------------
    console.log('  [Test 11] Verifying External Link Routing & In-App Browser Canvas Interception...');

    const chatRendererPath = path.resolve(__dirname, '../src/browser/generative-canvas/ChatMarkdownRenderer.tsx');
    const chatRendererSource = fs.readFileSync(chatRendererPath, 'utf-8');
    assert.ok(chatRendererSource.includes('onOpenInBrowser?: (url: string, title?: string) => void'), 'ChatMarkdownRenderer must support onOpenInBrowser prop');
    assert.ok(chatRendererSource.includes('onOpenInBrowser(linkUrl, linkTitle)'), 'InlineMarkdown must route link clicks to onOpenInBrowser');

    const docPrimitivePath = path.resolve(__dirname, '../src/browser/generative-canvas/primitives/MarkdownDocumentPrimitive.tsx');
    const docPrimitiveSource = fs.readFileSync(docPrimitivePath, 'utf-8');
    assert.ok(docPrimitiveSource.includes('onOpenInBrowser?: (url: string, title?: string) => void'), 'MarkdownDocumentPrimitive must support onOpenInBrowser prop');
    assert.ok(docPrimitiveSource.includes('onOpenInBrowser(cite.url, cite.sourceTitle'), 'Citation card clicks must route to onOpenInBrowser');

    assert.ok(studioSource.includes('handleOpenInAppBrowser'), 'GenerativeCanvasStudio must define handleOpenInAppBrowser handler');
    assert.ok(studioSource.includes('handleOpenInAppBrowser(chunk.web.uri'), 'Grounding citation chips must route to handleOpenInAppBrowser');
    assert.ok(studioSource.includes('onOpenInBrowser={handleOpenInAppBrowser}'), 'Chat and Document components must receive onOpenInBrowser handler');

    console.log('  ✓ Test 11 Passed: Link click interception and in-app browser routing verified across all components.');

    console.log('\n🎉 ALL INTERACTIVE BROWSER PRIMITIVE TESTS PASSED SUCCESSFULLY!');
}

test('interactive-browser-primitive.test', async () => {
    await runInteractiveBrowserTests();
}, 180_000);
