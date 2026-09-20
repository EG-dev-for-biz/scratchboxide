import { test } from 'vitest';
import * as assert from 'assert';
import { buildSandboxSrcDoc } from '../src/browser/generative-canvas/primitives/LiveCodeSandboxPrimitive';
import { LiveCodeSandboxData } from '../src/browser/generative-canvas/canvas-types';

test('In-Memory Modular ESM Runtime, Local CSP Extensions, and Bidirectional Host Bridge', async () => {
    console.log('🧪 Starting Modular ESM & Bidirectional Bridge Test Suite...\n');

    // =========================================================================
    // SECTION 1: Local Vendor & WebSocket CSP Permissions
    // =========================================================================
    console.log('--- SECTION 1: Content Security Policy (CSP) Permissiveness ---');

    const sampleReactData: LiveCodeSandboxData = {
        title: 'Modular Micro-App',
        sandboxType: 'react',
        files: [
            {
                id: 'file-1',
                name: 'App.tsx',
                content: 'export default function App() { return <div>App</div>; }',
                language: 'typescript'
            }
        ],
        activeFileId: 'file-1'
    };

    const reactSrcDoc = buildSandboxSrcDoc(sampleReactData);

    // 1.1 Verify React sandbox CSP includes localhost and WebSockets
    assert.ok(
        reactSrcDoc.includes('http://localhost:*'),
        'React sandbox CSP must permit http://localhost:* for local vendor bundles and dev servers'
    );
    assert.ok(
        reactSrcDoc.includes('ws://localhost:*'),
        'React sandbox CSP must permit ws://localhost:* for live HMR and local socket connections'
    );
    console.log('  ✓ 1.1 React sandbox CSP permits local HTTP and WebSocket endpoints');

    // 1.2 Verify Python sandbox CSP includes localhost and WebSockets
    const samplePythonData: LiveCodeSandboxData = {
        title: 'Pyodide Data App',
        sandboxType: 'python',
        files: [
            {
                id: 'py-1',
                name: 'main.py',
                content: 'print("Hello from Python")',
                language: 'python'
            }
        ],
        activeFileId: 'py-1'
    };

    const pySrcDoc = buildSandboxSrcDoc(samplePythonData);
    assert.ok(
        pySrcDoc.includes('http://localhost:*'),
        'Python sandbox CSP must permit http://localhost:*'
    );
    assert.ok(
        pySrcDoc.includes('ws://localhost:*'),
        'Python sandbox CSP must permit ws://localhost:*'
    );
    console.log('  ✓ 1.2 Python sandbox CSP permits local HTTP and WebSocket endpoints');

    // =========================================================================
    // SECTION 2: Bidirectional Host Bridge & RPC Methods
    // =========================================================================
    console.log('\n--- SECTION 2: Bidirectional Host Bridge (`window.scratchbox`) ---');

    // 2.1 Storage methods exist in client bridge script
    assert.ok(
        reactSrcDoc.includes('storage: {'),
        'window.scratchbox must include storage namespace'
    );
    assert.ok(
        reactSrcDoc.includes("saveAsset: function(filename, content, mimeType)"),
        'window.scratchbox.storage must provide saveAsset method'
    );
    assert.ok(
        reactSrcDoc.includes("rpcCall('storage:save-asset'"),
        'saveAsset must dispatch storage:save-asset RPC'
    );
    assert.ok(
        reactSrcDoc.includes("exportState: function(state)"),
        'window.scratchbox.storage must provide exportState method'
    );
    assert.ok(
        reactSrcDoc.includes("rpcCall('storage:export-state'"),
        'exportState must dispatch storage:export-state RPC'
    );
    assert.ok(
        reactSrcDoc.includes("getState: function()"),
        'window.scratchbox.storage must provide getState method'
    );
    assert.ok(
        reactSrcDoc.includes("rpcCall('storage:get-state'"),
        'getState must dispatch storage:get-state RPC'
    );
    console.log('  ✓ 2.1 Storage bridge methods (saveAsset, exportState, getState) wired to RPC');

    // 2.2 AI Refinement method exists in client bridge script
    assert.ok(
        reactSrcDoc.includes('ai: {'),
        'window.scratchbox must include ai namespace'
    );
    assert.ok(
        reactSrcDoc.includes("refine: function(prompt)"),
        'window.scratchbox.ai must provide refine method'
    );
    assert.ok(
        reactSrcDoc.includes("rpcCall('ai:refine'"),
        'refine must dispatch ai:refine RPC'
    );
    console.log('  ✓ 2.2 AI refinement bridge method wired to RPC');

    // 2.3 Native C++20 3D Engine method exists in client bridge script
    assert.ok(
        reactSrcDoc.includes('native3d: {'),
        'window.scratchbox must include native3d namespace'
    );
    assert.ok(
        reactSrcDoc.includes("generateGlb: function(sourceCode)"),
        'window.scratchbox.native3d must provide generateGlb method'
    );
    assert.ok(
        reactSrcDoc.includes("rpcCall('native3d:compile-and-generate'"),
        'generateGlb must dispatch native3d:compile-and-generate RPC'
    );
    console.log('  ✓ 2.3 Native C++20 3D engine bridge method (generateGlb) wired to RPC');

    // =========================================================================
    // SECTION 3: In-Memory Modular ESM Runtime & Path Normalization
    // =========================================================================
    console.log('\n--- SECTION 3: Modular Multi-File In-Memory Compilation ---');

    const multiFileData: LiveCodeSandboxData = {
        title: 'Multi-File Brick Breaker',
        sandboxType: 'react',
        files: [
            {
                id: 'f-paddle',
                name: 'components/Paddle.tsx',
                content: `
import React from 'react';
export function Paddle({ x, width }: { x: number; width: number }) {
    return <div style={{ position: 'absolute', left: x, width, height: 12, background: 'cyan' }} />;
}
export default Paddle;
`,
                language: 'typescript'
            },
            {
                id: 'f-utils',
                name: 'utils/physics.ts',
                content: `
export function clamp(v: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, v));
}
`,
                language: 'typescript'
            },
            {
                id: 'f-app',
                name: 'App.tsx',
                content: `
import React, { useState } from 'react';
import { Paddle } from './components/Paddle';
import { clamp } from './utils/physics';

export default function App() {
    const [x, setX] = useState(100);
    return (
        <div>
            <h1>Modular Game</h1>
            <Paddle x={clamp(x, 0, 400)} width={80} />
        </div>
    );
}
`,
                language: 'typescript'
            }
        ],
        activeFileId: 'f-app'
    };

    const multiFileSrcDoc = buildSandboxSrcDoc(multiFileData);

    // 3.1 Verify module registry initialization
    assert.ok(
        multiFileSrcDoc.includes('window.__sb_modules__ = window.__sb_modules__ || {};'),
        'Runtime must initialize window.__sb_modules__ registry'
    );
    assert.ok(
        multiFileSrcDoc.includes('window.__sb_module_cache__ = window.__sb_module_cache__ || {};'),
        'Runtime must initialize window.__sb_module_cache__ export cache'
    );
    console.log('  ✓ 3.1 Module registry and cache initialized in preview runtime');

    // 3.2 Verify all files are individually compiled and registered
    assert.ok(
        multiFileSrcDoc.includes('components/Paddle.tsx'),
        'components/Paddle.tsx must be transpiled and registered'
    );
    assert.ok(
        multiFileSrcDoc.includes('utils/physics.ts'),
        'utils/physics.ts must be transpiled and registered'
    );
    assert.ok(
        multiFileSrcDoc.includes('App.tsx'),
        'App.tsx must be transpiled and registered'
    );
    console.log('  ✓ 3.2 Every project file compiled into isolated module closure');

    // 3.3 Verify __sb_normalize_path__ and __sb_require__ are embedded
    assert.ok(
        multiFileSrcDoc.includes('function __sb_normalize_path__('),
        '__sb_normalize_path__ must be defined to handle relative path resolution'
    );
    assert.ok(
        multiFileSrcDoc.includes('function __sb_require__('),
        '__sb_require__ loader must be present to resolve and link dependencies'
    );
    console.log('  ✓ 3.3 Modular path normalizer and require loader embedded in DOM');

    // 3.4 Verify root application component mounting
    assert.ok(
        multiFileSrcDoc.includes('const root = ReactDOM.createRoot(container);'),
        'ReactDOM createRoot container must be initialized'
    );
    assert.ok(
        multiFileSrcDoc.includes('root.render(React.createElement(ComponentToMount));'),
        'ReactDOM must render the resolved entry component'
    );
    console.log('  ✓ 3.4 Root application component correctly resolved and mounted');

    console.log('\n🎉 All Modular ESM & Bidirectional Bridge test suites passed successfully!\n');
});
