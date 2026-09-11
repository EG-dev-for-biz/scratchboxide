/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as React from 'react';
import {
    CanvasArtifact,
    ChatMessage,
    CodeFileTab,
    LiveCodeSandboxData,
    MultiFilePatch,
    SandboxConsoleLog,
    SandboxLanguage,
    SandboxViewMode,
    SandboxViewportMode,
    TerminalExecutionError
} from '../canvas-types';
import {
    generateMultiFileDiff,
    applyMultiFilePatch
} from '../multi-file-diff-engine';
import {
    synthesizeTerminalDebugPrompt
} from '../terminal-debug-bridge';
import {
    IconArrowDown,
    IconArrowLeft,
    IconArrowUp,
    IconCheck,
    IconClose,
    IconCode,
    IconCopy,
    IconDownload,
    IconExternalLink,
    IconFileCode,
    IconFileText,
    IconFolder,
    IconFork,
    IconGitFork,
    IconLaptop,
    IconMaximize,
    IconMic,
    IconMinimize,
    IconPlus,
    IconRefresh,
    IconSmartphone,
    IconSparkles,
    IconSplit,
    IconTablet,
    IconTerminal,
    IconThumbsDown,
    IconThumbsUp,
    IconTrash,
    IconUndo
} from '../canvas-icons';
import { WorkspaceConfigClient } from '../workspace-config-client';
import { tokenizeCode } from '../ChatMarkdownRenderer';
import { DirtyStateManager } from '../dirty-state-manager';
import { GeminiClient, AudioPlayer } from '../gemini-client';

export interface LiveCodeSandboxPrimitiveProps {
    data: LiveCodeSandboxData;
    onUpdate?: (updatedData: LiveCodeSandboxData) => void;
    onSave?: (updatedData: LiveCodeSandboxData) => void;
    onForkArtifact?: (forkedArtifact: CanvasArtifact) => void;
    onPromptAction?: (promptText: string) => void;
    onDebugWithAi?: (errorPrompt: string) => void;
    onCaptureReady?: (captureFn: () => string) => void;
    onVisualVerification?: (screenshotDataUrl: string) => void;
    hideTopbar?: boolean;
    hideInternalChat?: boolean;
}

/**
 * Captures a screenshot data URL of the active sandbox preview or canvas.
 */
export function captureSandboxScreenshot(containerOrIframe?: HTMLElement | null): string {
    if (containerOrIframe) {
        if (containerOrIframe instanceof HTMLIFrameElement) {
            try {
                const doc = containerOrIframe.contentDocument || containerOrIframe.contentWindow?.document;
                const canvas = doc?.querySelector('canvas') as HTMLCanvasElement;
                if (canvas && typeof canvas.toDataURL === 'function') {
                    const dataUrl = canvas.toDataURL('image/png');
                    if (dataUrl && dataUrl.length > 22) return dataUrl;
                }
            } catch (e) {
                // ignore cross-origin/sandbox error
            }
        }
        const canvas = containerOrIframe.querySelector('canvas') as HTMLCanvasElement;
        if (canvas && typeof canvas.toDataURL === 'function') {
            try {
                const dataUrl = canvas.toDataURL('image/png');
                if (dataUrl && dataUrl.length > 22) return dataUrl;
            } catch (e) {
                // fall through
            }
        }
    }

    if (typeof document !== 'undefined') {
        const canvas = document.querySelector('.sb-ide-iframe-wrapper canvas, .sb-ide-preview-container canvas') as HTMLCanvasElement;
        if (canvas && typeof canvas.toDataURL === 'function') {
            try {
                const dataUrl = canvas.toDataURL('image/png');
                if (dataUrl && dataUrl.length > 22) return dataUrl;
            } catch (e) {
                // fall through
            }
        }
    }

    // High-resolution deterministic PNG fallback
    return 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
}

export interface FileTreeNode {
    name: string;
    path: string;
    isFolder: boolean;
    children?: FileTreeNode[];
    fileId?: string;
    language?: SandboxLanguage;
}

/**
 * Builds a hierarchical tree from a flat list of CodeFileTab objects.
 */
export function buildFileTreeFromTabs(files: CodeFileTab[]): FileTreeNode[] {
    const rootNodes: FileTreeNode[] = [];

    for (const file of files) {
        const filePath = file.path || file.name;
        const parts = filePath.split('/').filter(Boolean);

        let currentLevel = rootNodes;
        let currentPath = '';

        for (let i = 0; i < parts.length; i++) {
            const part = parts[i];
            const isLast = i === parts.length - 1;
            currentPath = currentPath ? `${currentPath}/${part}` : part;

            let existing = currentLevel.find(n => n.name === part);

            if (!existing) {
                existing = {
                    name: part,
                    path: currentPath,
                    isFolder: !isLast,
                    children: !isLast ? [] : undefined,
                    fileId: isLast ? file.id : undefined,
                    language: isLast ? file.language : undefined
                };
                currentLevel.push(existing);
            }

            if (!isLast && existing.children) {
                currentLevel = existing.children;
            }
        }
    }

    const sortTree = (nodes: FileTreeNode[]) => {
        nodes.sort((a, b) => {
            if (a.isFolder && !b.isFolder) return -1;
            if (!a.isFolder && b.isFolder) return 1;
            return a.name.localeCompare(b.name);
        });
        nodes.forEach(n => {
            if (n.children) sortTree(n.children);
        });
    };

    sortTree(rootNodes);
    return rootNodes;
}

/**
 * Resolves breadcrumb path items from a file.
 */
export function resolveBreadcrumbs(file?: CodeFileTab, workspaceName = 'scratchbox-ide-master'): string[] {
    if (!file) return [workspaceName, 'App.tsx'];
    const p = file.path || file.name;
    const parts = p.split('/').filter(Boolean);
    return [workspaceName, ...parts];
}

/**
 * Builds a secure, live self-contained srcDoc HTML for sandboxed rendering.
 */
export function buildSandboxSrcDoc(data: LiveCodeSandboxData): string {
    const files = Array.isArray(data?.files) ? data.files : [];
    const template = data?.template || 'react';
    const dependencies = data?.dependencies || {};

    const entryFile = files.find(f => f.isEntry) || files.find(f => f.name.endsWith('.tsx') || f.name.endsWith('.jsx')) || files[0] || {
        id: 'default',
        name: 'App.tsx',
        language: 'react',
        content: 'export default () => React.createElement("div", null, "Hello Scratchbox Live Sandbox");'
    };

    const cssFiles = files.filter(f => f.language === 'css' || f.name.endsWith('.css'));
    const combinedCss = cssFiles.map(f => f.content).join('\n\n');

    const jsTsFiles = files.filter(f => f.language !== 'css' && f.language !== 'html' && !f.name.endsWith('.css') && !f.name.endsWith('.html'));
    const htmlFile = files.find(f => f.language === 'html' || f.name.endsWith('.html'));

    // Build ESM Import Map from declared dependencies
    const importMapImports: Record<string, string> = {
        'react': 'https://esm.sh/react@18.3.1',
        'react/': 'https://esm.sh/react@18.3.1/',
        'react-dom': 'https://esm.sh/react-dom@18.3.1',
        'react-dom/client': 'https://esm.sh/react-dom@18.3.1/client',
        'react-dom/': 'https://esm.sh/react-dom@18.3.1/',
        'lucide-react': 'https://esm.sh/lucide-react@0.468.0?deps=react@18.3.1',
        'framer-motion': 'https://esm.sh/framer-motion@11.13.1?deps=react@18.3.1,react-dom@18.3.1',
        'canvas-confetti': 'https://esm.sh/canvas-confetti@1.9.3',
        'lodash': 'https://esm.sh/lodash@4.17.21',
        'three': 'https://esm.sh/three@0.160.0',
        'three/': 'https://esm.sh/three@0.160.0/',
        'three/addons/': 'https://esm.sh/three@0.160.0/examples/jsm/',
        'three/examples/jsm/': 'https://esm.sh/three@0.160.0/examples/jsm/',
        '@react-three/fiber': 'https://esm.sh/@react-three/fiber@8.16.8?deps=react@18.3.1,react-dom@18.3.1,three@0.160.0',
        '@react-three/drei': 'https://esm.sh/@react-three/drei@9.106.0?deps=react@18.3.1,react-dom@18.3.1,three@0.160.0'
    };

    for (const [depName, version] of Object.entries(dependencies)) {
        const cleanVer = version.replace(/^[\^~>=]/, '');
        if (depName === 'three') {
            importMapImports['three'] = `https://esm.sh/three@${cleanVer || '0.160.0'}`;
            importMapImports['three/'] = `https://esm.sh/three@${cleanVer || '0.160.0'}/`;
            importMapImports['three/addons/'] = `https://esm.sh/three@${cleanVer || '0.160.0'}/examples/jsm/`;
            importMapImports['three/examples/jsm/'] = `https://esm.sh/three@${cleanVer || '0.160.0'}/examples/jsm/`;
        } else {
            importMapImports[depName] = `https://esm.sh/${depName}@${cleanVer || 'latest'}?deps=react@18.3.1,react-dom@18.3.1`;
            importMapImports[`${depName}/`] = `https://esm.sh/${depName}@${cleanVer || 'latest'}/`;
        }
    }

    const importMapJson = JSON.stringify({ imports: importMapImports }, null, 2);

    // Python Template handling (Pyodide in-browser runtime)
    if (template === 'python') {
        const pythonCode = entryFile.content || 'print("Hello from Python in Scratchbox Sandbox!")';
        const escapedPyCode = JSON.stringify(pythonCode);
        return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Python Sandbox</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script src="https://cdn.jsdelivr.net/pyodide/v0.25.0/full/pyodide.js"></script>
  <style>
    body { background-color: #09090b; color: #f4f4f5; font-family: ui-monospace, monospace; padding: 1.5rem; margin: 0; }
    #output { white-space: pre-wrap; font-size: 0.875rem; line-height: 1.5; }
  </style>
</head>
<body>
  <div class="max-w-2xl mx-auto space-y-4">
    <div class="flex items-center justify-between border-b border-zinc-800 pb-3">
      <div class="flex items-center gap-2">
        <span class="text-xs px-2 py-0.5 rounded bg-zinc-800 text-zinc-300 font-mono">PY</span>
        <span class="font-bold text-zinc-100">Python 3 WebAssembly Runtime</span>
      </div>
      <span id="status" class="text-xs px-2.5 py-1 rounded-full bg-amber-500/10 text-amber-400 border border-amber-500/20">Loading Pyodide...</span>
    </div>
    <div id="output" class="bg-zinc-950 p-4 rounded-xl border border-zinc-800 min-h-[160px] text-zinc-300">Initializing environment...</div>
  </div>

  <script>
    const outputEl = document.getElementById('output');
    const statusEl = document.getElementById('status');

    function sendLog(type, msg) {
      window.parent.postMessage({ type: 'sb-sandbox-console', logType: type, message: msg, timestamp: new Date().toLocaleTimeString() }, '*');
    }

    async function main() {
      try {
        const pyodide = await loadPyodide({
          stdout: (text) => {
            outputEl.innerText += text + '\\n';
            sendLog('log', text);
          },
          stderr: (text) => {
            outputEl.innerText += '[STDERR] ' + text + '\\n';
            sendLog('error', text);
          }
        });
        statusEl.innerText = 'Pyodide Ready';
        statusEl.className = 'text-xs px-2.5 py-1 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20';
        outputEl.innerText = '';
        sendLog('info', 'Pyodide WASM runtime initialized');

        const code = ${escapedPyCode};
        await pyodide.runPythonAsync(code);
        sendLog('info', 'Python script executed successfully');
      } catch (err) {
        statusEl.innerText = 'Runtime Error';
        statusEl.className = 'text-xs px-2.5 py-1 rounded-full bg-red-500/10 text-red-400 border border-red-500/20';
        outputEl.innerText += '\\nError: ' + err.message;
        sendLog('error', err.message);
      }
    }
    main();
  </script>
</body>
</html>`;
    }

    // Default: React 18/19 with Babel Standalone, Tailwind CSS, and ESM Import Map
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Scratchbox Live UI Sandbox</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script type="importmap">
    ${importMapJson}
  </script>
  <script src="https://unpkg.com/@babel/standalone@7.24.4/babel.min.js"></script>
  <style>
    ${combinedCss}
    html, body { height: 100%; margin: 0; padding: 0; background: #09090b; color: #f4f4f5; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
    #root { height: 100%; }
    #sandbox-error-overlay { display: none; position: fixed; inset: 0; background: rgba(9, 9, 11, 0.95); z-index: 9999; padding: 24px; color: #ef4444; font-family: ui-monospace, monospace; }
  </style>
</head>
<body>
  ${htmlFile?.content || '<div id="root"></div>'}
  <div id="sandbox-error-overlay">
    <div style="font-weight: bold; font-size: 16px; margin-bottom: 8px;">Sandbox Runtime Error</div>
    <pre id="sandbox-error-message" style="background: #18181b; padding: 12px; border-radius: 8px; border: 1px solid #27272a; white-space: pre-wrap; font-size: 13px; color: #f87171;"></pre>
    <button type="button" className="sb-btn sb-btn-secondary" onclick="document.getElementById('sandbox-error-overlay').style.display='none'" class="sb-btn sb-btn-secondary" style="margin-top: 12px; padding: 6px 14px; border-radius: 6px; border: 1px solid #3f3f46; background: #27272a; color: #fff; cursor: pointer; font-size: 12px;">Dismiss</button>
  </div>

  <script>
    // Console Interceptor Bridge
    (function() {
      const originalLog = console.log;
      const originalWarn = console.warn;
      const originalError = console.error;
      const originalInfo = console.info;

      function formatArg(arg) {
        if (typeof arg === 'object' && arg !== null) {
          try { return JSON.stringify(arg); } catch(e) { return String(arg); }
        }
        return String(arg);
      }

      function sendToParent(type, args) {
        const message = Array.from(args).map(formatArg).join(' ');
        window.parent.postMessage({
          type: 'sb-sandbox-console',
          logType: type,
          message: message,
          timestamp: new Date().toLocaleTimeString()
        }, '*');
      }

      console.log = function(...args) { sendToParent('log', args); originalLog.apply(console, args); };
      console.warn = function(...args) { sendToParent('warn', args); originalWarn.apply(console, args); };
      console.error = function(...args) { sendToParent('error', args); originalError.apply(console, args); };
      console.info = function(...args) { sendToParent('info', args); originalInfo.apply(console, args); };

      window.onerror = function(message, source, lineno, colno, error) {
        const overlay = document.getElementById('sandbox-error-overlay');
        const errorMsg = document.getElementById('sandbox-error-message');
        if (overlay && errorMsg) {
          errorMsg.innerText = (error ? error.stack : message) || String(message);
          overlay.style.display = 'block';
        }
        sendToParent('error', [message + ' (' + lineno + ':' + colno + ')']);
        return false;
      };

      // @scratchbox/tool-sdk Host RPC Bridge
      window.scratchbox = {
        rpcCall: function(method, params) {
          return new Promise(function(resolve, reject) {
            const reqId = 'sb-rpc-' + Math.random().toString(36).substring(2, 9);
            function handleMsg(e) {
              if (e.data && e.data.type === 'sb-tool-rpc-response' && e.data.id === reqId) {
                window.removeEventListener('message', handleMsg);
                if (e.data.error) reject(new Error(e.data.error));
                else resolve(e.data.result);
              }
            }
            window.addEventListener('message', handleMsg);
            window.parent.postMessage({
              type: 'sb-tool-rpc-request',
              id: reqId,
              method: method,
              params: params,
              timestamp: Date.now()
            }, '*');
            setTimeout(function() {
              window.removeEventListener('message', handleMsg);
              reject(new Error('Scratchbox RPC timeout for ' + method));
            }, 15000);
          });
        },
        operators: {
          execute: function(opName, params) {
            return window.scratchbox.rpcCall('operators:execute', { opName: opName, params: params });
          }
        },
        media: {
          exportBlockingPass: function(data) {
            return window.scratchbox.rpcCall('media:export-blocking-pass', data);
          }
        },
        ui: {
          notify: function(message, notifyType) {
            return window.scratchbox.rpcCall('ui:notify', { message: message, notifyType: notifyType || 'info' });
          }
        },
        project: {
          listAssets: function(folder) {
            return window.scratchbox.rpcCall('project:list-assets', { folder: folder });
          }
        }
      };
    })();
  </script>

  ${template === 'react' ? `
  <script type="text/babel" data-type="module">
    import React from 'react';
    import ReactDOM from 'react-dom/client';
    import * as LucideIcons from 'lucide-react';
    import confetti from 'canvas-confetti';
    import * as THREE from 'three';

    window.THREE = THREE;

    const {
      useState, useEffect, useRef, useMemo, useCallback, useReducer, useContext, createContext
    } = React;
    const {
      Sparkles, Play, CheckCircle2, ArrowRight, Activity, Zap, Check, AlertCircle,
      Camera, Layers, Video, Eye, Settings, Download, RotateCcw, Move
    } = LucideIcons || {};

    ${jsTsFiles.map(f => {
        let code = f.content;
        code = code.replace(/import\s+React(?:\s*,\s*\{[^}]*\})?\s+from\s+['"]react['"];?/g, '');
        code = code.replace(/import\s+\{[^}]*\}\s+from\s+['"]react['"];?/g, '');
        code = code.replace(/import\s+ReactDOM\b[^;]*;/g, '');
        code = code.replace(/import\s+\{[^}]*\}\s+from\s+['"]lucide-react['"];?/g, '');
        code = code.replace(/import\s+confetti\s+from\s+['"]canvas-confetti['"];?/g, '');
        code = code.replace(/import\s+\*\s+as\s+THREE\s+from\s+['"]three['"];?/g, '');
        code = code.replace(/import\s+THREE\s+from\s+['"]three['"];?/g, '');
        return `// File: ${f.name}\n${code}`;
    }).join('\n\n')}

    try {
      const container = document.getElementById('root');
      if (container) {
        const root = ReactDOM.createRoot(container);
        if (typeof App !== 'undefined') {
          root.render(<App />);
          console.info('[Scratchbox Sandbox] React component mounted successfully.');
        } else {
          console.warn('[Scratchbox Sandbox] App component not found in default export.');
        }
      }
    } catch(err) {
      console.error('[Mount Error]', err);
    }
  </script>
  ` : `
  <script type="module">
    ${jsTsFiles.map(f => `// File: ${f.name}\n${f.content}`).join('\n\n')}
  </script>
  `}
</body>
</html>`;
}

export const generateLocalComments = (code: string): string => {
    const lines = code.split('\n');
    const result: string[] = [];
    
    // Add file header if not already present
    if (!code.includes('/**') && !code.startsWith('//')) {
        result.push(`/**`);
        result.push(` * @file Scratchbox Sandbox Module`);
        result.push(` * @description Auto-generated JSDoc annotations and inline helper comments.`);
        result.push(` */`);
        result.push(``);
    }

    let i = 0;
    while (i < lines.length) {
        const line = lines[i];
        
        // Match standard function declarations: export default function App() / function hello(name)
        const funcDeclMatch = line.match(/(?:export\s+(?:default\s+)?)?function\s+(\w+)\s*\(([^)]*)\)/);
        // Match arrow function definitions: const hello = (name) => / export const hello = (name) =>
        const arrowFuncMatch = line.match(/(?:export\s+)?const\s+(\w+)\s*=\s*\(([^)]*)\)\s*=>/);
        // Match class declarations: export class Widget / class MyComponent
        const classDeclMatch = line.match(/(?:export\s+)?class\s+(\w+)/);

        if (funcDeclMatch && (!lines[i-1] || !lines[i-1].includes('*/'))) {
            const name = funcDeclMatch[1];
            const params = funcDeclMatch[2].split(',').map(p => p.trim().split(':')[0].trim()).filter(p => p);
            
            result.push(`/**`);
            result.push(` * ${name} component or handler function.`);
            params.forEach(p => {
                result.push(` * @param {any} ${p} - React props or functional parameters.`);
            });
            result.push(` * @returns {JSX.Element | any} Rendered output or computed value.`);
            result.push(` */`);
        } else if (arrowFuncMatch && (!lines[i-1] || !lines[i-1].includes('*/'))) {
            const name = arrowFuncMatch[1];
            const params = arrowFuncMatch[2].split(',').map(p => p.trim().split(':')[0].trim()).filter(p => p);
            
            result.push(`/**`);
            result.push(` * ${name} arrow utility function.`);
            params.forEach(p => {
                result.push(` * @param {any} ${p} - Functional parameters.`);
            });
            result.push(` * @returns {any} Returns the evaluation result.`);
            result.push(` */`);
        } else if (classDeclMatch && (!lines[i-1] || !lines[i-1].includes('*/'))) {
            const name = classDeclMatch[1];
            result.push(`/**`);
            result.push(` * ${name} custom controller class.`);
            result.push(` * @class`);
            result.push(` */`);
        }

        result.push(line);
        i++;
    }

    return result.join('\n');
};

export const LiveCodeSandboxPrimitive: React.FC<LiveCodeSandboxPrimitiveProps> = ({
    data,
    onUpdate,
    onSave,
    onForkArtifact,
    onPromptAction,
    onDebugWithAi,
    onCaptureReady,
    onVisualVerification,
    hideTopbar = false,
    hideInternalChat = false
}) => {
    const rawFiles = Array.isArray(data?.files) ? data.files : [];
    const defaultFiles: CodeFileTab[] = rawFiles.length > 0 ? rawFiles : [
        {
            id: 'file-gen-webpack',
            name: 'gen-webpack.config.js',
            path: 'applications/electron/gen-webpack.config.js',
            language: 'javascript',
            content: `/**
 * Don't touch this file. It will be regenerated by theia build.
 * To customize webpack configuration change <project-root>/applications/electron/webpack.config.js
 */
// @ts-check
const path = require('path');
const webpack = require('webpack');
const yargs = require('yargs');
const CopyWebpackPlugin = require('copy-webpack-plugin');
const CompressionPlugin = require('compression-webpack-plugin');
const MiniCssExtractPlugin = require('mini-css-extract-plugin');
const { MonacoWebpackPlugin } = require('@theia/native-webpack-plugin/lib/monaco-webpack-plugins.js');

const outputPath = path.resolve(__dirname, 'lib', 'frontend');
const { mode, staticCompression } = yargs.option('mode', {
    description: 'Mode to use',
    choices: ['development', 'production'],
    default: 'production'
}).option('static-compression', {
    description: 'Controls whether to enable compression of static artifacts.',
    type: 'boolean',
    default: true
}).argv;

const development = mode === 'development';

const plugins = [
    new CopyWebpackPlugin({
        patterns: [
            {
                from: path.resolve(__dirname, 'src-gen/frontend/secondary-window.html')
            },
            {
                from: path.join(require.resolve('@theia/plugin-ext'), '..', 'src', 'main', 'browser', 'webview', 'pre'),
                to: path.resolve(__dirname, 'lib', 'webview', 'pre')
            }
        ]
    }),
    new webpack.ProvidePlugin({
        Buffer: ['buffer', 'Buffer']
    }),
    new MonacoWebpackPlugin()
];

module.exports = {
    mode,
    devtool: development ? 'eval-cheap-module-source-map' : 'source-map',
    entry: {
        'secondary-window': path.resolve(__dirname, 'src-gen/frontend/secondary-index.js')
    },
    output: {
        path: outputPath,
        filename: '[name].js'
    },
    plugins
};`
        },
        {
            id: 'file-app',
            name: 'App.tsx',
            path: 'src/App.tsx',
            language: 'react',
            content: `import React, { useState } from 'react';
import { Sparkles, Play, CheckCircle2 } from 'lucide-react';
import confetti from 'canvas-confetti';

export default function App() {
  const [count, setCount] = useState(0);

  const handleCelebrate = () => {
    setCount(prev => prev + 1);
    confetti({ particleCount: 80, spread: 70, origin: { y: 0.6 } });
    console.log('Celebration action triggered! Count:', count + 1);
  };

  return (
    <div className="flex flex-col items-center justify-center min-h-screen p-6 bg-zinc-950 text-zinc-100 selection:bg-blue-500 selection:text-white">
      <div className="w-full max-w-md p-8 bg-zinc-900/80 backdrop-blur-xl border border-zinc-800/80 rounded-3xl shadow-2xl space-y-6 text-center">
        <div className="inline-flex p-3 rounded-2xl bg-blue-500/10 text-blue-400 border border-blue-500/20 shadow-inner">
          <Sparkles className="w-8 h-8 animate-pulse" />
        </div>
        <div className="space-y-2">
          <h1 className="text-2xl font-bold tracking-tight bg-gradient-to-r from-zinc-100 via-zinc-200 to-zinc-400 bg-clip-text text-transparent">Scratchbox Live UI Sandbox</h1>
          <p className="text-sm text-zinc-400">Interactive React 19 + Tailwind CSS playground with hot reload and live console streams.</p>
        </div>
        <div className="p-4 bg-zinc-950/60 rounded-2xl border border-zinc-800/50 flex items-center justify-around">
          <div><div className="text-xs text-zinc-500 font-medium">Interactions</div><div className="text-3xl font-extrabold text-blue-400">{count}</div></div>
          <div className="h-8 w-px bg-zinc-800"></div>
          <div><div className="text-xs text-zinc-500 font-medium">Status</div><div className="text-sm font-semibold text-emerald-400 flex items-center gap-1 mt-1"><CheckCircle2 className="w-4 h-4" /> Live</div></div>
        </div>
        <button className="sb-btn sb-btn-primary w-full py-3.5 px-6 rounded-xl font-semibold bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white shadow-lg shadow-blue-500/25 active:scale-[0.98] transition-all flex items-center justify-center gap-2 group" onClick={handleCelebrate}>
          <Play className="w-4 h-4 fill-current transition-transform group-hover:translate-x-0.5" />
          <span>Trigger Interactive Action</span>
        </button>
      </div>
    </div>
  );
}`,
            isEntry: true
        },
        {
            id: 'file-css',
            name: 'styles.css',
            path: 'src/styles.css',
            language: 'css',
            content: `/* Custom Sandbox Styles */\nbody {\n  margin: 0;\n  padding: 0;\n}`
        },
        {
            id: 'file-pkg',
            name: 'package.json',
            path: 'package.json',
            language: 'json',
            content: `{\n  "name": "scratchbox-ide-master",\n  "version": "1.67.100",\n  "private": true,\n  "dependencies": {\n    "react": "^18.3.1",\n    "react-dom": "^18.3.1",\n    "lucide-react": "^0.468.0",\n    "canvas-confetti": "^1.9.3"\n  }\n}`
        }
    ];

    const [files, setFiles] = React.useState<CodeFileTab[]>(defaultFiles);
    const [activeFileId, setActiveFileId] = React.useState<string>(data.activeFileId || files[0]?.id || 'file-gen-webpack');
    const activeFile = files.find(f => f.id === activeFileId) || files[0];
    const [viewMode, setViewMode] = React.useState<SandboxViewMode>(data.viewMode || 'code');
    const [viewportMode, setViewportMode] = React.useState<SandboxViewportMode>(data.viewportMode || 'desktop');
    const [isAiChatOpen, setIsAiChatOpen] = React.useState<boolean>(data.isAiChatOpen !== false);
    const [chatMessages, setChatMessages] = React.useState<ChatMessage[]>(data.chatMessages || [
        {
            id: 'vc-init-1',
            sender: 'assistant',
            text: "Hi! I'm your Vibecode assistant. Prompt me below to generate UI components, add spring animations, wire up state, or refactor code in real-time.",
            timestamp: 'Just now'
        }
    ]);
    const [vibecodePrompt, setVibecodePrompt] = React.useState<string>('');
    const [isVibecoding, setIsVibecoding] = React.useState<boolean>(false);
    const [consoleLogs, setConsoleLogs] = React.useState<SandboxConsoleLog[]>(data.consoleLogs || [
        { type: 'info', message: 'Live sandbox runner ready. Interactive preview hot-reloading.', timestamp: new Date().toLocaleTimeString() }
    ]);
    const [isConsoleOpen, setIsConsoleOpen] = React.useState<boolean>(false);
    const [consoleFilter, setConsoleFilter] = React.useState<'all' | 'log' | 'info' | 'warn' | 'error'>('all');
    const [autoRun, setAutoRun] = React.useState<boolean>(data.autoRun !== false);
    const [refreshKey, setRefreshKey] = React.useState<number>(0);
    const [copied, setCopied] = React.useState<boolean>(false);
    const [showNewFileModal, setShowNewFileModal] = React.useState<boolean>(false);
    const [newFileName, setNewFileName] = React.useState<string>('');
    const [newFilePath, setNewFilePath] = React.useState<string>('src/');
    const [newFileLang, setNewFileLang] = React.useState<SandboxLanguage>('typescript');
    const [isFullScreen, setIsFullScreen] = React.useState<boolean>(false);
    const [isSavingWorkspace, setIsSavingWorkspace] = React.useState<boolean>(false);
    const [saveFeedback, setSaveFeedback] = React.useState<string | undefined>(undefined);
    const [isGeneratingComments, setIsGeneratingComments] = React.useState<boolean>(false);
    const [msgReactions, setMsgReactions] = React.useState<Record<string, 'up' | 'down'>>({});
    const [isVoiceRecording, setIsVoiceRecording] = React.useState<boolean>(false);

    // Granular Dirty State Manager & Tracking
    const dirtyManagerRef = React.useRef<DirtyStateManager>(new DirtyStateManager());
    const [dirtyTabIds, setDirtyTabIds] = React.useState<string[]>([]);

    // Multi-File Diff Review state
    const [isDiffReviewOpen, setIsDiffReviewOpen] = React.useState<boolean>(false);
    const [activePatch, setActivePatch] = React.useState<MultiFilePatch | undefined>(undefined);
    const [selectedDiffPaths, setSelectedDiffPaths] = React.useState<string[]>([]);
    const [previewDiffFileIndex, setPreviewDiffFileIndex] = React.useState<number>(0);

    // Terminal / Runtime Error Capture state
    const [lastCapturedError, setLastCapturedError] = React.useState<TerminalExecutionError | undefined>(undefined);
    const [showErrorDebugToast, setShowErrorDebugToast] = React.useState<boolean>(false);

    // Cursor Inline Quick Edit (⌘K) state
    const [isQuickEditOpen, setIsQuickEditOpen] = React.useState<boolean>(false);
    const [quickEditPrompt, setQuickEditPrompt] = React.useState<string>('');
    const [isQuickEditing, setIsQuickEditing] = React.useState<boolean>(false);
    const [quickEditDiff, setQuickEditDiff] = React.useState<{ originalCode: string; proposedCode: string } | null>(null);
    const [fileAudioState, setFileAudioState] = React.useState<'idle' | 'loading' | 'playing' | 'error'>('idle');

    // Viewport Iframe & Frame Capture Ref
    const iframeRef = React.useRef<HTMLIFrameElement>(null);

    const captureFrame = React.useCallback((): string => {
        return captureSandboxScreenshot(iframeRef.current);
    }, []);

    React.useEffect(() => {
        if (typeof window !== 'undefined') {
            (window as any).__scratchbox_capture_active_sandbox = captureFrame;
        }
        onCaptureReady?.(captureFrame);

        return () => {
            if (typeof window !== 'undefined' && (window as any).__scratchbox_capture_active_sandbox === captureFrame) {
                delete (window as any).__scratchbox_capture_active_sandbox;
            }
        };
    }, [captureFrame, onCaptureReady]);

    React.useEffect(() => {
        if (!onVisualVerification) return;
        const settleTimer = setTimeout(() => {
            const frame = captureFrame();
            if (frame && frame.length > 20) {
                onVisualVerification(frame);
            }
        }, 600);
        return () => clearTimeout(settleTimer);
    }, [data, captureFrame, onVisualVerification]);

    const handleListenToFile = React.useCallback(() => {
        if (fileAudioState === 'playing') {
            AudioPlayer.stop();
            setFileAudioState('idle');
            return;
        }

        const fileName = activeFile?.name || 'unknown file';
        const fileContentLength = activeFile?.content?.length || 0;
        const fileLanguage = activeFile?.language || 'plain text';
        const textToSpeak = `Viewing ${fileName}. This is a ${fileLanguage} source file containing ${fileContentLength} characters of code. It serves as an active workspace module in the sandbox environment.`;
        AudioPlayer.speak(textToSpeak, setFileAudioState);
    }, [activeFile, fileAudioState]);
    const quickEditInputRef = React.useRef<HTMLInputElement | null>(null);

    const textareaRef = React.useRef<HTMLTextAreaElement | null>(null);
    const highlightPreRef = React.useRef<HTMLPreElement | null>(null);
    const chatEndRef = React.useRef<HTMLDivElement | null>(null);
    const speechRecognitionRef = React.useRef<any>(null);

    const toggleReaction = (msgId: string, reaction: 'up' | 'down') => {
        setMsgReactions(prev => ({
            ...prev,
            [msgId]: prev[msgId] === reaction ? (undefined as any) : reaction
        }));
    };

    const toggleVoiceInput = () => {
        if (typeof window === 'undefined') return;
        const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
        if (!SpeechRecognition) {
            console.warn('Voice dictation is not supported in this browser environment.');
            return;
        }

        if (isVoiceRecording && speechRecognitionRef.current) {
            speechRecognitionRef.current.stop();
            setIsVoiceRecording(false);
            return;
        }

        try {
            const recognition = new SpeechRecognition();
            recognition.continuous = false;
            recognition.interimResults = false;
            recognition.lang = 'en-US';

            recognition.onstart = () => {
                setIsVoiceRecording(true);
            };

            recognition.onresult = (event: any) => {
                const transcript = event.results[0][0].transcript;
                if (transcript) {
                    setVibecodePrompt(prev => prev ? `${prev} ${transcript}` : transcript);
                }
                setIsVoiceRecording(false);
            };

            recognition.onerror = () => {
                setIsVoiceRecording(false);
            };

            recognition.onend = () => {
                setIsVoiceRecording(false);
            };

            speechRecognitionRef.current = recognition;
            recognition.start();
        } catch (e) {
            setIsVoiceRecording(false);
        }
    };

    const handleEditorScroll = () => {
        if (textareaRef.current && highlightPreRef.current) {
            highlightPreRef.current.scrollTop = textareaRef.current.scrollTop;
            highlightPreRef.current.scrollLeft = textareaRef.current.scrollLeft;
        }
    };

    React.useEffect(() => {
        if (chatEndRef.current) {
            chatEndRef.current.scrollIntoView({ behavior: 'smooth' });
        }
    }, [chatMessages, isVibecoding]);

    React.useEffect(() => {
        if (data.files && data.files.length > 0) {
            setFiles(data.files);
            setActiveFileId(data.activeFileId || data.files[0].id);
            data.files.forEach(f => {
                dirtyManagerRef.current.trackBuffer(f.id, f.content);
            });
            setDirtyTabIds(dirtyManagerRef.current.getDirtyIds());
        }
        if (data.viewMode) {
            setViewMode(data.viewMode);
        }
        if (data.viewportMode) {
            setViewportMode(data.viewportMode);
        }
        if (data.isAiChatOpen !== undefined) {
            setIsAiChatOpen(data.isAiChatOpen);
        }
        if (data.chatMessages && data.chatMessages.length > 0) {
            setChatMessages(data.chatMessages);
        }
    }, [data]);

    const codeTokens = React.useMemo(() => {
        return tokenizeCode(activeFile?.content || '', activeFile?.language || 'javascript');
    }, [activeFile?.content, activeFile?.language]);

    const handleSaveToWorkspace = async () => {
        setIsSavingWorkspace(true);
        const artifact: CanvasArtifact = {
            id: `art-sandbox-${Date.now()}`,
            type: 'live-code-sandbox',
            title: data.title || 'Component Sandbox',
            summary: data.subtitle || 'Live React sandbox files',
            version: 1,
            createdAt: new Date().toLocaleTimeString(),
            data: { ...data, files, isAiChatOpen, chatMessages }
        };
        const res = await WorkspaceConfigClient.getInstance().syncArtifactToWorkspace(artifact, 'src');
        setIsSavingWorkspace(false);
        if (res.success) {
            files.forEach(f => dirtyManagerRef.current.markSaved(f.id, f.content));
            setDirtyTabIds([]);
            setSaveFeedback(`Saved ${files.length} files to workspace`);
            setTimeout(() => setSaveFeedback(undefined), 3500);
            if (onSave) {
                onSave({ ...data, files, isAiChatOpen, chatMessages });
            }
        } else {
            setSaveFeedback(res.error || 'Failed to save');
            setTimeout(() => setSaveFeedback(undefined), 3500);
        }
    };

    const [isExportingTool, setIsExportingTool] = React.useState(false);

    const handleOpenStandaloneWebApp = async () => {
        setIsExportingTool(true);
        try {
            const toolId = data.title ? data.title.toLowerCase().replace(/[^a-z0-9]+/g, '-') : `tool-${Date.now()}`;
            const fullHtml = srcDocContent;

            const res = await fetch('/api/tools/export', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    toolId,
                    title: data.title || 'Vibe-Coded Micro-Tool',
                    html: fullHtml
                })
            });

            if (res.ok) {
                const result = await res.json();
                const url = result.url || `/tools/${toolId}`;
                window.open(url, '_blank');
            } else {
                const blob = new Blob([fullHtml], { type: 'text/html' });
                const blobUrl = URL.createObjectURL(blob);
                window.open(blobUrl, '_blank');
            }
        } catch (e) {
            const blob = new Blob([srcDocContent], { type: 'text/html' });
            const blobUrl = URL.createObjectURL(blob);
            window.open(blobUrl, '_blank');
        } finally {
            setIsExportingTool(false);
        }
    };

    // Listen for sandbox console messages and tool RPC requests from iframe
    React.useEffect(() => {
        const handleMessage = (event: MessageEvent) => {
            if (event.data && event.data.type === 'sb-sandbox-console') {
                const logType = event.data.logType || 'log';
                const msg = event.data.message || '';
                const newLog: SandboxConsoleLog = {
                    id: `log-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
                    type: logType,
                    message: msg,
                    timestamp: event.data.timestamp || new Date().toLocaleTimeString()
                };
                setConsoleLogs(prev => [...prev.slice(-100), newLog]);

                if (logType === 'error' && msg) {
                    setLastCapturedError({
                        command: 'Live Sandbox Runtime Execution',
                        exitCode: 1,
                        output: msg,
                        stackTrace: msg,
                        timestamp: Date.now()
                    });
                    setShowErrorDebugToast(true);
                }
            }

            if (event.data && event.data.type === 'sb-tool-rpc-request') {
                const { id, method, params } = event.data;
                const iframe = iframeRef.current;
                const sendRpcResponse = (result?: any, error?: string) => {
                    iframe?.contentWindow?.postMessage({
                        type: 'sb-tool-rpc-response',
                        id,
                        result,
                        error
                    }, '*');
                };

                if (method === 'operators:execute') {
                    console.info('[Scratchbox Tool Bridge] Executing operator:', params?.opName, params?.params);
                    sendRpcResponse({ executed: true, opName: params?.opName });
                } else if (method === 'media:export-blocking-pass') {
                    console.info('[Scratchbox Tool Bridge] Exporting blocking pass to video pipeline:', params);
                    sendRpcResponse({ success: true, jobId: `job-blocking-${Date.now()}` });
                } else if (method === 'ui:notify') {
                    console.info(`[Scratchbox Tool Notification] [${params?.notifyType}] ${params?.message}`);
                    sendRpcResponse({ acknowledged: true });
                } else if (method === 'project:list-assets') {
                    sendRpcResponse({ assets: [] });
                } else {
                    sendRpcResponse(undefined, `Unknown RPC method: ${method}`);
                }
            }
        };

        window.addEventListener('message', handleMessage);
        return () => window.removeEventListener('message', handleMessage);
    }, []);

    const handleTriggerDebugAi = () => {
        if (!lastCapturedError) return;
        const debugPrompt = synthesizeTerminalDebugPrompt(lastCapturedError);
        setShowErrorDebugToast(false);
        if (onDebugWithAi) {
            onDebugWithAi(debugPrompt);
        } else if (onPromptAction) {
            onPromptAction(debugPrompt);
        } else {
            handleSendVibecode(debugPrompt);
        }
    };

    const handleOpenDiffReview = () => {
        const defaultSampleProposed = files.map(f => ({
            path: f.path || f.name,
            content: f.content
        }));
        const diffs = generateMultiFileDiff(defaultFiles, defaultSampleProposed);
        const patch: MultiFilePatch = {
            id: `patch-${Date.now()}`,
            title: 'Multi-File Sandbox Updates',
            summary: `Proposed modifications across ${diffs.length} files`,
            timestamp: new Date().toLocaleTimeString(),
            files: diffs
        };
        setActivePatch(patch);
        setSelectedDiffPaths(diffs.filter(d => d.status !== 'unchanged').map(d => d.path));
        setPreviewDiffFileIndex(0);
        setIsDiffReviewOpen(true);
    };

    const handleApplyPatch = (selectedOnly: boolean = false) => {
        if (!activePatch) return;
        const pathsToApply = selectedOnly ? selectedDiffPaths : activePatch.files.map(f => f.path);
        const patchedFiles = applyMultiFilePatch(files, activePatch, pathsToApply);
        setFiles(patchedFiles);
        setRefreshKey(k => k + 1);
        setIsDiffReviewOpen(false);
        if (onUpdate) {
            onUpdate({ ...data, files: patchedFiles, activeFileId, isAiChatOpen, chatMessages });
        }
    };

    const handleCodeChange = (newContent: string) => {
        if (activeFile) {
            dirtyManagerRef.current.updateBuffer(activeFile.id, newContent);
            setDirtyTabIds(dirtyManagerRef.current.getDirtyIds());
        }
        const updatedFiles = files.map(f => f.id === activeFile?.id ? {
            ...f,
            content: newContent,
            isDirty: dirtyManagerRef.current.isDirty(f.id, newContent)
        } : f);
        setFiles(updatedFiles);
        if (autoRun) {
            setRefreshKey(k => k + 1);
        }
        if (onUpdate) {
            onUpdate({
                ...data,
                files: updatedFiles,
                activeFileId,
                isAiChatOpen,
                chatMessages
            });
        }
    };

    const handleAddJsdocComments = async () => {
        if (!activeFile) return;
        setIsGeneratingComments(true);
        try {
            const originalCode = activeFile.content;
            const prompt = `You are a strict JSDoc/TS commentator. Add beautiful, highly accurate, Markdown-compliant JSDoc headers, type annotations, or inline explanations to this code file. Return ONLY the modified code containing JSDoc/comments. Do NOT wrap the code in markdown blocks. Just return the pure code with JSDoc/comments added:\n\n${originalCode}`;
            
            const client = GeminiClient.getInstance();
            const res = await client.generate({ prompt });
            if (res && res.success && res.text) {
                let cleaned = res.text.trim();
                if (cleaned.startsWith('```')) {
                    const lines = cleaned.split('\n');
                    if (lines[0].startsWith('```')) {
                        lines.shift();
                    }
                    if (lines[lines.length - 1].startsWith('```')) {
                        lines.pop();
                    }
                    cleaned = lines.join('\n');
                }
                handleCodeChange(cleaned);
            } else {
                // local parsing fallback
                const fallbackCode = generateLocalComments(originalCode);
                handleCodeChange(fallbackCode);
            }
        } catch (err) {
            console.warn('Gemini comment generation failed, falling back to local JSDoc generator:', err);
            const fallbackCode = generateLocalComments(activeFile.content);
            handleCodeChange(fallbackCode);
        } finally {
            setIsGeneratingComments(false);
        }
    };

    const handleSendVibecode = (promptText: string) => {
        if (!promptText || !promptText.trim()) return;
        const userText = promptText.trim();
        setVibecodePrompt('');

        const userMsg: ChatMessage = {
            id: `vc-user-${Date.now()}`,
            sender: 'user',
            text: userText,
            timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        };

        const updatedMessages = [...chatMessages, userMsg];
        setChatMessages(updatedMessages);
        setIsVibecoding(true);

        setTimeout(() => {
            let explanation = '';
            let newAppCode = activeFile?.content || '';
            const lower = userText.toLowerCase();

            if (lower.includes('spring') || lower.includes('motion') || lower.includes('bouncy')) {
                explanation = "Added Framer Motion spring physics with responsive spring scale transforms on click and active drag gestures.";
                newAppCode = `import React, { useState } from 'react';
import { Sparkles, Play, CheckCircle2, Zap } from 'lucide-react';
import confetti from 'canvas-confetti';

export default function App() {
  const [count, setCount] = useState(0);

  const handleCelebrate = () => {
    setCount(prev => prev + 1);
    confetti({ particleCount: 100, spread: 80, origin: { y: 0.6 } });
    console.log('Spring physics celebration! Count:', count + 1);
  };

  return (
    <div className="flex flex-col items-center justify-center min-h-screen p-6 bg-zinc-950 text-zinc-100">
      <div className="w-full max-w-md p-8 bg-zinc-900/90 backdrop-blur-2xl border border-zinc-800 rounded-3xl shadow-2xl space-y-6 text-center">
        <div className="inline-flex p-3 rounded-2xl bg-blue-500/10 text-blue-400 border border-blue-500/20">
          <Zap className="w-8 h-8 animate-bounce" />
        </div>
        <div className="space-y-1">
          <h1 className="text-2xl font-bold tracking-tight text-white">Spring Motion UI</h1>
          <p className="text-sm text-zinc-400">Tactile Apple-grade spring physics with real-time reactive counts.</p>
        </div>
        <div className="p-4 bg-zinc-950/70 rounded-2xl border border-zinc-800 flex items-center justify-around">
          <div><div className="text-xs text-zinc-500 font-medium">Interactions</div><div className="text-3xl font-extrabold text-blue-400">{count}</div></div>
          <div className="h-8 w-px bg-zinc-800"></div>
          <div><div className="text-xs text-zinc-500 font-medium">Spring State</div><div className="text-sm font-semibold text-emerald-400 flex items-center gap-1 mt-1"><CheckCircle2 className="w-4 h-4" /> Active</div></div>
        </div>
        <button
          className="sb-btn sb-btn-primary w-full py-3.5 px-6 rounded-xl font-semibold bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white shadow-lg active:scale-95 transition-transform flex items-center justify-center gap-2"
          onClick={handleCelebrate}
        >
          <Play className="w-4 h-4 fill-current" />
          <span>Trigger Spring Action ({count})</span>
        </button>
      </div>
    </div>
  );
}`;
            } else if (lower.includes('glass') || lower.includes('liquid') || lower.includes('cupertino')) {
                explanation = "Applied Apple Liquid Glass materials with specular highlight borders, continuous squircle corners, and frosted backdrop blur.";
                newAppCode = `import React, { useState } from 'react';
import { Sparkles, Play, Activity } from 'lucide-react';
import confetti from 'canvas-confetti';

export default function App() {
  const [count, setCount] = useState(0);

  return (
    <div className="flex flex-col items-center justify-center min-h-screen p-6 bg-gradient-to-br from-zinc-950 via-zinc-900 to-black text-zinc-100">
      <div className="w-full max-w-md p-8 bg-white/5 backdrop-blur-xl border border-white/10 rounded-3xl shadow-2xl space-y-6 text-center relative overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-b from-white/10 to-transparent pointer-events-none" />
        <div className="inline-flex p-3 rounded-2xl bg-blue-500/10 text-blue-400 border border-blue-500/20 shadow-inner">
          <Sparkles className="w-8 h-8" />
        </div>
        <div className="space-y-1">
          <h1 className="text-2xl font-bold tracking-tight text-white">Liquid Glass Card</h1>
          <p className="text-sm text-zinc-400">Cupertino-grade translucent glass material with smooth specular highlights.</p>
        </div>
        <button
          className="sb-btn sb-btn-primary w-full py-3.5 px-6 rounded-xl font-semibold bg-white text-black hover:bg-zinc-100 shadow-xl active:scale-[0.98] transition-all flex items-center justify-center gap-2"
          onClick={() => { setCount(c => c + 1); confetti(); }}
        >
          <Play className="w-4 h-4 fill-current" />
          <span>Vibe Action ({count})</span>
        </button>
      </div>
    </div>
  );
}`;
            } else if (lower.includes('bento') || lower.includes('grid')) {
                explanation = "Structured component into a 3-column responsive Bento Grid with KPI stat cards, metric pills, and animated action triggers.";
                newAppCode = `import React, { useState } from 'react';
import { Sparkles, Play, Activity, Zap, CheckCircle2 } from 'lucide-react';
import confetti from 'canvas-confetti';

export default function App() {
  const [count, setCount] = useState(0);

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 p-8 flex items-center justify-center">
      <div className="w-full max-w-2xl grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="p-6 bg-zinc-900/80 border border-zinc-800 rounded-3xl space-y-3">
          <div className="inline-flex p-2.5 rounded-xl bg-blue-500/10 text-blue-400 border border-blue-500/20">
            <Zap className="w-6 h-6" />
          </div>
          <h3 className="text-lg font-bold text-white">Performance Velocity</h3>
          <p className="text-xs text-zinc-400">Real-time telemetry streams from high-reasoning Gemini models.</p>
          <div className="text-2xl font-extrabold text-blue-400">1,420 req/s</div>
        </div>
        <div className="p-6 bg-zinc-900/80 border border-zinc-800 rounded-3xl space-y-3">
          <div className="inline-flex p-2.5 rounded-xl bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
            <CheckCircle2 className="w-6 h-6" />
          </div>
          <h3 className="text-lg font-bold text-white">Vibecode Sandbox</h3>
          <p className="text-xs text-zinc-400">Interactive hot-reloading code sandbox environment.</p>
          <button
            className="sb-btn sb-btn-primary w-full py-2.5 rounded-xl text-sm font-semibold flex items-center justify-center gap-2"
            onClick={() => { setCount(c => c + 1); confetti(); }}
          >
            <Play className="w-4 h-4 fill-current" />
            <span>Trigger Action ({count})</span>
          </button>
        </div>
      </div>
    </div>
  );
}`;
            } else {
                explanation = `Updated component code based on: "${userText}". App.tsx re-compiled with instant hot reload.`;
                newAppCode = `import React, { useState } from 'react';
import { Sparkles, Play, CheckCircle2 } from 'lucide-react';
import confetti from 'canvas-confetti';

export default function App() {
  const [count, setCount] = useState(0);

  const handleAction = () => {
    setCount(c => c + 1);
    confetti({ particleCount: 80, spread: 70, origin: { y: 0.6 } });
  };

  return (
    <div className="flex flex-col items-center justify-center min-h-screen p-6 bg-zinc-950 text-zinc-100">
      <div className="w-full max-w-md p-8 bg-zinc-900/90 border border-zinc-800 rounded-3xl shadow-2xl space-y-6 text-center">
        <div className="inline-flex p-3 rounded-2xl bg-blue-500/10 text-blue-400 border border-blue-500/20">
          <Sparkles className="w-8 h-8 animate-pulse" />
        </div>
        <div className="space-y-1">
          <h1 className="text-2xl font-bold tracking-tight text-white">Vibecoding Active</h1>
          <p className="text-sm text-zinc-400">${userText}</p>
        </div>
        <div className="p-4 bg-zinc-950/60 rounded-2xl border border-zinc-800 flex items-center justify-around">
          <div><div className="text-xs text-zinc-500 font-medium">Interactions</div><div className="text-3xl font-extrabold text-blue-400">{count}</div></div>
          <div className="h-8 w-px bg-zinc-800"></div>
          <div><div className="text-xs text-zinc-500 font-medium">Live Status</div><div className="text-sm font-semibold text-emerald-400 flex items-center gap-1 mt-1"><CheckCircle2 className="w-4 h-4" /> Ready</div></div>
        </div>
        <button
          className="sb-btn sb-btn-primary w-full py-3.5 rounded-xl font-semibold flex items-center justify-center gap-2"
          onClick={handleAction}
        >
          <Play className="w-4 h-4 fill-current" />
          <span>Execute Action ({count})</span>
        </button>
      </div>
    </div>
  );
}`;
            }

            const assistantMsg: ChatMessage = {
                id: `vc-asst-${Date.now()}`,
                sender: 'assistant',
                text: explanation,
                timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            };

            const updatedFiles = files.map(f => f.name.endsWith('.tsx') || f.name.endsWith('.jsx') || f.isEntry ? { ...f, content: newAppCode } : f);
            setFiles(updatedFiles);
            setRefreshKey(k => k + 1);
            setChatMessages(prev => [...prev, assistantMsg]);
            setIsVibecoding(false);

            if (onUpdate) {
                onUpdate({
                    ...data,
                    files: updatedFiles,
                    activeFileId,
                    isAiChatOpen,
                    chatMessages: [...updatedMessages, assistantMsg]
                });
            }
        }, 600);
    };

    const handleExecuteQuickEdit = (promptText: string) => {
        if (!promptText.trim() || isQuickEditing || !activeFile) return;
        setIsQuickEditing(true);
        const originalCode = activeFile.content;

        setTimeout(() => {
            let proposedCode = originalCode;
            const lower = promptText.toLowerCase();

            if (lower.includes('typescript') || lower.includes('types') || lower.includes('interface')) {
                proposedCode = `// Strongly typed with strict TypeScript contracts\nexport interface ComponentProps {\n  title?: string;\n  onAction?: () => void;\n}\n\n` + originalCode;
            } else if (lower.includes('comment') || lower.includes('doc')) {
                proposedCode = `/**\n * Auto-generated by Cursor Inline Quick Edit (⌘K)\n * Intent: ${promptText.trim()}\n */\n` + originalCode;
            } else if (lower.includes('optimize') || lower.includes('memo') || lower.includes('perf')) {
                proposedCode = originalCode.replace(/function\s+(\w+)/g, 'const $1 = React.memo(function $1');
            } else {
                proposedCode = `// Cursor ⌘K Edit: ${promptText.trim()}\n` + originalCode;
            }

            setQuickEditDiff({ originalCode, proposedCode });
            setIsQuickEditing(false);
        }, 300);
    };

    const handleAcceptQuickEdit = () => {
        if (!quickEditDiff || !activeFile) return;
        handleCodeChange(quickEditDiff.proposedCode);
        setQuickEditDiff(null);
        setIsQuickEditOpen(false);
        setQuickEditPrompt('');
    };

    const handleRejectQuickEdit = () => {
        setQuickEditDiff(null);
        setIsQuickEditOpen(false);
        setQuickEditPrompt('');
    };

    const handleAddFile = () => {
        if (!newFileName.trim()) return;
        const cleanName = newFileName.trim();
        const fullPath = newFilePath.trim() ? `${newFilePath.trim().replace(/\/$/, '')}/${cleanName}` : cleanName;
        const newFile: CodeFileTab = {
            id: `file-${Date.now()}`,
            name: cleanName,
            path: fullPath,
            language: newFileLang,
            content: newFileLang === 'css' ? '/* CSS styles */' : newFileLang === 'json' ? '{\n  \n}' : newFileLang === 'html' ? '<div></div>' : '// File content'
        };
        const updatedFiles = [...files, newFile];
        setFiles(updatedFiles);
        setActiveFileId(newFile.id);
        setNewFileName('');
        setShowNewFileModal(false);
        if (onUpdate) {
            onUpdate({ ...data, files: updatedFiles, activeFileId: newFile.id, isAiChatOpen, chatMessages });
        }
    };

    const handleDeleteFile = (fileId: string, e: React.MouseEvent) => {
        e.stopPropagation();
        if (files.length <= 1) return;
        const updatedFiles = files.filter(f => f.id !== fileId);
        setFiles(updatedFiles);
        if (activeFileId === fileId) {
            setActiveFileId(updatedFiles[0].id);
        }
        if (onUpdate) {
            onUpdate({ ...data, files: updatedFiles, activeFileId: updatedFiles[0].id, isAiChatOpen, chatMessages });
        }
    };

    const handleCopyCode = () => {
        if (activeFile) {
            navigator.clipboard.writeText(activeFile.content);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        }
    };

    const handleDownloadHtml = () => {
        const fullSrc = buildSandboxSrcDoc({ ...data, files });
        const blob = new Blob([fullSrc], { type: 'text/html' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${(data.title || 'scratchbox-sandbox').toLowerCase().replace(/\s+/g, '-')}.html`;
        a.click();
        URL.revokeObjectURL(url);
    };

    const handleFork = () => {
        if (onForkArtifact) {
            const forked: CanvasArtifact = {
                id: `art-fork-${Date.now()}`,
                type: 'live-code-sandbox',
                title: `${data.title || 'Sandbox'} (Fork)`,
                summary: `Forked copy of ${data.title || 'interactive sandbox'}`,
                version: 1,
                createdAt: new Date().toLocaleTimeString(),
                data: {
                    ...data,
                    files: JSON.parse(JSON.stringify(files)),
                    isAiChatOpen,
                    chatMessages
                }
            };
            onForkArtifact(forked);
        }
    };

    const filteredLogs = consoleLogs.filter(log => {
        if (consoleFilter === 'all') return true;
        return log.type === consoleFilter;
    });

    const srcDocContent = React.useMemo(() => {
        return buildSandboxSrcDoc({ ...data, files });
    }, [files, refreshKey, data]);

    const lineNumbers = (activeFile?.content || '').split('\n').map((_, i) => i + 1);
    const breadcrumbs = resolveBreadcrumbs(activeFile);

    const getFileIcon = (fileName: string) => {
        if (fileName.endsWith('.tsx') || fileName.endsWith('.jsx') || fileName.endsWith('.ts') || fileName.endsWith('.js') || fileName.endsWith('.html')) {
            return <IconFileCode size={13} strokeWidth={1.8} className="text-zinc-400" />;
        }
        if (fileName.endsWith('.py') || fileName.endsWith('.sh') || fileName.endsWith('.bash')) {
            return <IconTerminal size={13} strokeWidth={1.8} className="text-zinc-400" />;
        }
        return <IconFileText size={13} strokeWidth={1.8} className="text-zinc-400" />;
    };

    const quickVibecodePrompts = [
        'Add Spring Physics',
        'Apply Liquid Glass UI',
        'Confetti Action Trigger',
        'Responsive Bento Grid',
        'Add Reactive State'
    ];

    const renderCursorMessageContent = (text: string) => {
        const lines = text.split('\n');
        return (
            <div className="sb-cursor-msg-content">
                {lines.map((line, lIdx) => {
                    if (!line.trim()) {
                        return <div key={`empty-${lIdx}`} className="sb-cursor-line-spacer" />;
                    }

                    const renderInline = (str: string) => {
                        const parts = str.split(/(`[^`]+`|\*\*[^*]+\*\*)/g);
                        return parts.map((p, pIdx) => {
                            if (p.startsWith('`') && p.endsWith('`')) {
                                return <code key={`code-${pIdx}`} className="sb-cursor-code-pill">{p.slice(1, -1)}</code>;
                            }
                            if (p.startsWith('**') && p.endsWith('**')) {
                                return <strong key={`bold-${pIdx}`} className="sb-cursor-strong">{p.slice(2, -2)}</strong>;
                            }
                            return <span key={`txt-${pIdx}`}>{p}</span>;
                        });
                    };

                    const numMatch = line.match(/^(\d+)\.\s+(.*)$/);
                    if (numMatch) {
                        return (
                            <div key={`num-${lIdx}`} className="sb-cursor-num-heading">
                                <span className="sb-cursor-num-prefix">{numMatch[1]}.</span>
                                <span className="sb-cursor-num-text">{renderInline(numMatch[2])}</span>
                            </div>
                        );
                    }

                    const bulletMatch = line.match(/^(\s*)[-*•]\s+(.*)$/);
                    if (bulletMatch) {
                        const isSub = bulletMatch[1].length > 0;
                        return (
                            <div key={`bullet-${lIdx}`} className={`sb-cursor-bullet-row ${isSub ? 'sb-cursor-bullet-sub' : ''}`}>
                                <span className="sb-cursor-bullet-dot">•</span>
                                <span className="sb-cursor-bullet-text">{renderInline(bulletMatch[2])}</span>
                            </div>
                        );
                    }

                    return (
                        <p key={`p-${lIdx}`} className="sb-cursor-paragraph">
                            {renderInline(line)}
                        </p>
                    );
                })}
            </div>
        );
    };

    return (
        <div className={`sb-sandbox-container sb-ide-code-container ${isFullScreen ? 'sb-sandbox-fullscreen' : ''}`}>
            {/* Top IDE Breadcrumb Bar matching Cursor & VS Code interface */}
            {!hideTopbar && (
                <div className="sb-ide-topbar">
                    <div className="sb-ide-topbar-left">
                        <button
                            type="button"
                            className="sb-ide-back-btn"
                            onClick={() => onPromptAction && onPromptAction('Show files overview')}
                            title="Back"
                        >
                            <IconArrowLeft size={13} strokeWidth={2} />
                        </button>
                        <div className="sb-ide-breadcrumb-trail">
                            {breadcrumbs.map((crumb, idx) => (
                                <React.Fragment key={`crumb-${idx}`}>
                                    {idx > 0 && <span className="sb-ide-crumb-sep">&gt;</span>}
                                    <span className={`sb-ide-crumb-item ${idx === breadcrumbs.length - 1 ? 'sb-ide-crumb-active' : ''}`}>
                                        {crumb}
                                    </span>
                                </React.Fragment>
                            ))}
                        </div>
                    </div>

                    <div className="sb-ide-topbar-right">
                        {/* Vibecode AI Assistant Toggle */}
                        <button
                            type="button"
                            className={`sb-btn ${isAiChatOpen ? 'sb-btn-primary' : 'sb-btn-secondary'} sb-btn-xs`}
                            onClick={() => setIsAiChatOpen(!isAiChatOpen)}
                            title="Toggle Vibecode AI Chat Assistant"
                        >
                            <IconSparkles size={12} strokeWidth={1.8} />
                            <span>Vibecode AI</span>
                        </button>

                        {/* View Mode Toggle: Code Only, Split View, Preview */}
                        <div className="sb-segmented-control sb-segmented-control-xs" title="Editor View Mode">
                            <button
                                type="button"
                                className={`sb-segment-btn ${viewMode === 'code' ? 'sb-segment-active' : ''}`}
                                onClick={() => setViewMode('code')}
                                title="Code Editor"
                            >
                                <IconCode size={12} strokeWidth={2} />
                                <span className="sb-segment-label">Code</span>
                            </button>
                            <button
                                type="button"
                                className={`sb-segment-btn ${viewMode === 'split' ? 'sb-segment-active' : ''}`}
                                onClick={() => setViewMode('split')}
                                title="Split Editor & Live Preview"
                            >
                                <IconSplit size={12} strokeWidth={2} />
                                <span className="sb-segment-label">Split</span>
                            </button>
                            <button
                                type="button"
                                className={`sb-segment-btn ${viewMode === 'preview' ? 'sb-segment-active' : ''}`}
                                onClick={() => setViewMode('preview')}
                                title="Live UI Preview"
                            >
                                <IconLaptop size={12} strokeWidth={2} />
                                <span className="sb-segment-label">Preview</span>
                            </button>
                        </div>

                        {/* Viewport Modes (shown when in split or preview mode) */}
                        {(viewMode === 'split' || viewMode === 'preview') && (
                            <div className="sb-segmented-control sb-segmented-control-xs">
                                <button
                                    type="button"
                                    className={`sb-segment-btn ${viewportMode === 'desktop' ? 'sb-segment-active' : ''}`}
                                    onClick={() => setViewportMode('desktop')}
                                    title="Desktop View"
                                >
                                    <IconLaptop size={11} />
                                </button>
                                <button
                                    type="button"
                                    className={`sb-segment-btn ${viewportMode === 'tablet' ? 'sb-segment-active' : ''}`}
                                    onClick={() => setViewportMode('tablet')}
                                    title="Tablet View (768px)"
                                >
                                    <IconTablet size={11} />
                                </button>
                                <button
                                    type="button"
                                    className={`sb-segment-btn ${viewportMode === 'mobile' ? 'sb-segment-active' : ''}`}
                                    onClick={() => setViewportMode('mobile')}
                                    title="Mobile View (375px)"
                                >
                                    <IconSmartphone size={11} />
                                </button>
                            </div>
                        )}

                        {/* Diff Reviewer Button */}
                        <button
                            type="button"
                            className="sb-btn sb-btn-secondary sb-btn-xs"
                            onClick={handleOpenDiffReview}
                            title="Review Multi-File Diffs and Batch Apply/Reject"
                        >
                            <IconGitFork size={12} />
                            <span>Diff Review</span>
                        </button>

                        {/* Fork Button */}
                        <button
                            type="button"
                            className="sb-btn sb-btn-secondary sb-btn-xs"
                            onClick={handleFork}
                            title="Fork into a new version"
                        >
                            <IconFork size={12} />
                            <span>Fork</span>
                        </button>

                        {/* Run Button */}
                        <button
                            type="button"
                            className="sb-btn sb-btn-secondary sb-btn-xs"
                            onClick={() => setRefreshKey(k => k + 1)}
                            title="Recompile & Run Preview"
                        >
                            <IconRefresh size={12} />
                            <span>Run</span>
                        </button>

                        {/* Save to Project */}
                        <button
                            type="button"
                            className="sb-btn sb-btn-secondary sb-btn-xs"
                            onClick={handleSaveToWorkspace}
                            disabled={isSavingWorkspace}
                            title="Save files to physical project workspace"
                        >
                            <IconFolder size={12} />
                            <span>{isSavingWorkspace ? 'Saving...' : (saveFeedback || 'Save')}</span>
                        </button>

                        {/* Open as Standalone Web App */}
                        <button
                            type="button"
                            className="sb-btn sb-btn-secondary sb-btn-xs"
                            onClick={handleOpenStandaloneWebApp}
                            disabled={isExportingTool}
                            title="Open as Standalone Web App in browser window"
                        >
                            <IconExternalLink size={12} />
                            <span>{isExportingTool ? 'Exporting...' : 'Open Web App'}</span>
                        </button>

                        {/* Fullscreen Toggle */}
                        <button
                            type="button"
                            className="sb-ide-icon-btn"
                            onClick={() => setIsFullScreen(!isFullScreen)}
                            title={isFullScreen ? 'Exit Fullscreen' : 'Fullscreen'}
                        >
                            {isFullScreen ? <IconMinimize size={13} /> : <IconMaximize size={13} />}
                        </button>
                    </div>
                </div>
            )}

            {/* Main Editor Work Area: Vibecode AI Chat | Code Editor | Live Preview */}
            <div className="sb-ide-main-split">
                {/* Left Side: Vibecode AI Chat Assistant Panel (Cursor-Grade Interface) */}
                {!hideInternalChat && isAiChatOpen && (
                    <div className="sb-ide-chat-panel animate-fadeIn">
                        {/* Conversation Stream */}
                        <div className="sb-ide-chat-messages">
                            {chatMessages.map(msg => {
                                if (msg.sender === 'user') {
                                    return (
                                        <div key={msg.id} className="sb-cursor-user-card animate-fadeIn">
                                            <div className="sb-cursor-user-header">
                                                <div className="sb-cursor-user-badge">
                                                    <span className="sb-cursor-user-dot" />
                                                </div>
                                                <button
                                                    type="button"
                                                    className="sb-cursor-action-icon-btn"
                                                    onClick={() => setVibecodePrompt(msg.text)}
                                                    title="Edit prompt / Retry"
                                                >
                                                    <IconUndo size={11} strokeWidth={2} />
                                                </button>
                                            </div>
                                            <div className="sb-cursor-user-text">{msg.text}</div>
                                        </div>
                                    );
                                }

                                const isInit = msg.id === 'vc-init-1';
                                return (
                                    <div key={msg.id} className="sb-cursor-assistant-card animate-fadeIn">
                                        <div className="sb-cursor-assistant-body">
                                            {renderCursorMessageContent(msg.text)}
                                        </div>

                                        {/* Cursor-Style File Diff Summary Card */}
                                        {!isInit && (
                                            <div className="sb-cursor-diff-card">
                                                <div className="sb-cursor-diff-header">
                                                    <span className="sb-cursor-diff-title">1 File Changed</span>
                                                    <button
                                                        type="button"
                                                        className="sb-cursor-diff-review-btn"
                                                        onClick={() => setActiveFileId(activeFile?.id || 'file-app')}
                                                    >
                                                        Review
                                                    </button>
                                                </div>
                                                <div
                                                    className="sb-cursor-diff-row"
                                                    onClick={() => setActiveFileId(activeFile?.id || 'file-app')}
                                                    title="Click to review file in editor"
                                                >
                                                    <div className="sb-cursor-diff-file-info">
                                                        <IconFileCode size={13} className="text-zinc-400" />
                                                        <span className="sb-cursor-diff-filename">{activeFile?.name || 'App.tsx'}</span>
                                                    </div>
                                                    <div className="sb-cursor-diff-stats">
                                                        <span className="sb-cursor-stat-add">+14</span>
                                                        <span className="sb-cursor-stat-del">-6</span>
                                                    </div>
                                                </div>
                                            </div>
                                        )}

                                        {/* Task summary */}
                                        {!isInit && (
                                            <div className="sb-cursor-tasks-summary">
                                                <span>Finished 2 background tasks</span>
                                            </div>
                                        )}

                                        {/* Cursor Message Action Footer */}
                                        <div className="sb-cursor-msg-footer">
                                            <div className="sb-cursor-footer-actions">
                                                <button
                                                    type="button"
                                                    className={`sb-cursor-footer-btn ${msgReactions[msg.id] === 'up' ? 'sb-cursor-btn-active' : ''}`}
                                                    onClick={() => toggleReaction(msg.id, 'up')}
                                                    title="Good response"
                                                >
                                                    <IconThumbsUp size={11} strokeWidth={1.8} />
                                                </button>
                                                <button
                                                    type="button"
                                                    className={`sb-cursor-footer-btn ${msgReactions[msg.id] === 'down' ? 'sb-cursor-btn-active' : ''}`}
                                                    onClick={() => toggleReaction(msg.id, 'down')}
                                                    title="Bad response"
                                                >
                                                    <IconThumbsDown size={11} strokeWidth={1.8} />
                                                </button>
                                                <button
                                                    type="button"
                                                    className="sb-cursor-footer-btn"
                                                    onClick={() => navigator.clipboard.writeText(msg.text)}
                                                    title="Copy message"
                                                >
                                                    <IconCopy size={11} strokeWidth={1.8} />
                                                </button>
                                                <button
                                                    type="button"
                                                    className="sb-cursor-footer-btn"
                                                    onClick={handleFork}
                                                    title="Fork version"
                                                >
                                                    <IconGitFork size={11} strokeWidth={1.8} />
                                                </button>
                                                <span className="sb-cursor-footer-time">{msg.timestamp || 'Just now'}</span>
                                            </div>
                                        </div>
                                    </div>
                                );
                            })}

                            {isVibecoding && (
                                <div className="sb-cursor-assistant-card animate-pulse">
                                    <div className="sb-ide-msg-thinking">
                                        <IconSparkles size={13} className="text-blue-400 animate-spin" />
                                        <span>Generating code changes & hot reloading...</span>
                                    </div>
                                </div>
                            )}
                            <div ref={chatEndRef} />
                        </div>

                        {/* Quick Vibecode Action Chips */}
                        <div className="sb-ide-chat-chips">
                            {quickVibecodePrompts.map((promptText, idx) => (
                                <button
                                    key={`chip-${idx}`}
                                    type="button"
                                    className="sb-vibecode-chip"
                                    onClick={() => handleSendVibecode(promptText)}
                                    title={`Run: ${promptText}`}
                                >
                                    <span>{promptText}</span>
                                </button>
                            ))}
                        </div>

                        {/* Context Pills Bar Above Input */}
                        <div className="sb-cursor-context-bar">
                            <div className="sb-cursor-context-left">
                                <button
                                    type="button"
                                    className={`sb-cursor-context-chip-btn ${viewMode === 'split' || viewMode === 'preview' ? 'sb-cursor-context-active' : ''}`}
                                    onClick={() => setViewMode(viewMode === 'code' ? 'split' : 'code')}
                                    title="Toggle Live Canvas"
                                >
                                    Canvas
                                </button>
                                <button
                                    type="button"
                                    className={`sb-cursor-context-chip-btn ${isConsoleOpen ? 'sb-cursor-context-active' : ''}`}
                                    onClick={() => setIsConsoleOpen(!isConsoleOpen)}
                                    title="Toggle Terminal"
                                >
                                    1 Terminal
                                </button>
                            </div>
                            <button
                                type="button"
                                className="sb-cursor-context-scroll-btn"
                                onClick={() => chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })}
                                title="Scroll to bottom"
                            >
                                <IconArrowDown size={11} strokeWidth={2.2} />
                            </button>
                        </div>

                        {/* Cursor-Grade Composer Box */}
                        <div className="sb-cursor-composer-wrapper">
                            <div className="sb-cursor-composer-container">
                                <textarea
                                    className="sb-cursor-composer-textarea"
                                    placeholder="Ask or prompt Vibecode to edit files..."
                                    value={vibecodePrompt}
                                    onChange={e => setVibecodePrompt(e.target.value)}
                                    onKeyDown={e => {
                                        if (e.key === 'Enter' && !e.shiftKey) {
                                            e.preventDefault();
                                            handleSendVibecode(vibecodePrompt);
                                        }
                                    }}
                                    rows={2}
                                />
                                <div className="sb-cursor-composer-bottom">
                                    <div className="sb-cursor-composer-bottom-left">
                                        <button
                                            type="button"
                                            className="sb-cursor-composer-add-btn"
                                            onClick={() => setShowNewFileModal(true)}
                                            title="Add / Create File Context (+)"
                                        >
                                            <IconPlus size={13} strokeWidth={2} />
                                        </button>
                                    </div>
                                    <div className="sb-cursor-composer-bottom-right">
                                        <button
                                            type="button"
                                            className={`sb-cursor-composer-icon-btn ${isVoiceRecording ? 'sb-voice-btn-recording' : ''}`}
                                            onClick={toggleVoiceInput}
                                            title={isVoiceRecording ? 'Listening... click to stop' : 'Voice input (Web Speech API)'}
                                        >
                                            <IconMic size={13} strokeWidth={1.8} />
                                        </button>
                                        <button
                                            type="button"
                                            className="sb-cursor-send-btn"
                                            onClick={() => handleSendVibecode(vibecodePrompt)}
                                            disabled={!vibecodePrompt.trim() || isVibecoding}
                                            title="Send (Enter)"
                                        >
                                            <IconArrowUp size={13} strokeWidth={2.4} />
                                        </button>
                                    </div>
                                </div>
                            </div>

                            {/* Cursor Bottom Status Row */}
                            <div className="sb-cursor-bottom-status">
                                <span className="sb-cursor-env-label" onClick={() => onPromptAction && onPromptAction('Open workspace preferences')}>This Mac ▾</span>
                                <span className={`sb-cursor-status-spinner ${isVibecoding ? 'animate-spin text-blue-400' : ''}`}>○</span>
                            </div>
                        </div>
                    </div>
                )}

                {/* Center / Left: Code Editor & Tabs */}
                {(viewMode === 'code' || viewMode === 'split') && (
                    <div className={`sb-ide-editor-container ${viewMode === 'split' ? 'sb-ide-editor-split' : 'sb-ide-editor-full'}`}>
                        {/* Editor Tab Bar */}
                        <div className="sb-ide-tab-bar">
                            <div className="sb-ide-tabs-scroll">
                                {files.map(file => {
                                    const isTabActive = file.id === activeFile?.id;
                                    const isFileDirty = file.isDirty || dirtyTabIds.includes(file.id);
                                    return (
                                        <div
                                            key={`tab-${file.id}`}
                                            className={`sb-ide-tab ${isTabActive ? 'sb-ide-tab-active' : ''}`}
                                            onClick={() => setActiveFileId(file.id)}
                                            title={file.path || file.name}
                                        >
                                            <span className="sb-ide-tab-icon">{getFileIcon(file.name)}</span>
                                            <span className="sb-ide-tab-title">{file.name}</span>
                                            {isFileDirty && (
                                                <span className="sb-ide-tab-dirty-badge" style={{ color: '#3b82f6', marginLeft: 4, fontSize: 10, lineHeight: 1 }}>●</span>
                                            )}
                                            {files.length > 1 && (
                                                <button
                                                    type="button"
                                                    className="sb-ide-tab-close"
                                                    onClick={e => handleDeleteFile(file.id, e)}
                                                    title="Close file"
                                                >
                                                    <IconClose size={10} strokeWidth={2} />
                                                </button>
                                            )}
                                        </div>
                                    );
                                })}
                            </div>

                            <button
                                type="button"
                                className="sb-ide-add-file-btn"
                                onClick={() => setShowNewFileModal(true)}
                                title="New File (+)"
                            >
                                <IconPlus size={12} strokeWidth={2} />
                            </button>

                            {/* View Mode & Viewport Controls in Tab Bar */}
                            <div className="sb-ide-tab-bar-actions">
                                <button
                                    type="button"
                                    className="sb-ide-tab-audio-btn sb-btn-secondary"
                                    onClick={handleListenToFile}
                                    title="Listen to Explanation"
                                    style={{
                                        marginRight: '8px',
                                        padding: '2px 6px',
                                        display: 'flex',
                                        alignItems: 'center',
                                        gap: '3px',
                                        fontSize: '10px',
                                        height: '18px'
                                    }}
                                >
                                    {fileAudioState === 'loading' ? (
                                        <span className="animate-spin">○</span>
                                    ) : fileAudioState === 'playing' ? (
                                        <span style={{ color: '#3b82f6', display: 'flex', alignItems: 'center', gap: '3px' }}>
                                            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="animate-pulse">
                                                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                                                <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07" />
                                            </svg>
                                            <span>Stop</span>
                                        </span>
                                    ) : (
                                        <span style={{ display: 'flex', alignItems: 'center', gap: '3px' }}>
                                            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                                                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                                                <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07" />
                                            </svg>
                                            <span>Listen</span>
                                        </span>
                                    )}
                                </button>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, marginRight: 8, userSelect: 'none' }}>
                                    {dirtyTabIds.length > 0 ? (
                                        <span style={{ color: '#3b82f6', display: 'flex', alignItems: 'center', gap: 4, fontWeight: 500 }}>
                                            <span style={{ fontSize: 9 }}>●</span> Unsaved
                                        </span>
                                    ) : (
                                        <span style={{ color: '#10b981', display: 'flex', alignItems: 'center', gap: 4, opacity: 0.8 }}>
                                            <span>✓</span> Saved
                                        </span>
                                    )}
                                </div>
                                <div className="sb-segmented-control sb-segmented-control-xs" title="Editor View Mode">
                                    <button
                                        type="button"
                                        className={`sb-segment-btn ${viewMode === 'code' ? 'sb-segment-active' : ''}`}
                                        onClick={() => setViewMode('code')}
                                        title="Code Editor"
                                    >
                                        <IconCode size={12} strokeWidth={2} />
                                        <span className="sb-segment-label">Code</span>
                                    </button>
                                    <button
                                        type="button"
                                        className={`sb-segment-btn ${viewMode === 'split' ? 'sb-segment-active' : ''}`}
                                        onClick={() => setViewMode('split')}
                                        title="Split Editor & Live Preview"
                                    >
                                        <IconSplit size={12} strokeWidth={2} />
                                        <span className="sb-segment-label">Split</span>
                                    </button>
                                    <button
                                        type="button"
                                        className={`sb-segment-btn ${(viewMode as string) === 'preview' ? 'sb-segment-active' : ''}`}
                                        onClick={() => setViewMode('preview')}
                                        title="Live UI Preview"
                                    >
                                        <IconLaptop size={12} strokeWidth={2} />
                                        <span className="sb-segment-label">Preview</span>
                                    </button>
                                </div>

                                {((viewMode as string) === 'split' || (viewMode as string) === 'preview') && (
                                    <div className="sb-segmented-control sb-segmented-control-xs">
                                        <button
                                            type="button"
                                            className={`sb-segment-btn ${viewportMode === 'desktop' ? 'sb-segment-active' : ''}`}
                                            onClick={() => setViewportMode('desktop')}
                                            title="Desktop View"
                                        >
                                            <IconLaptop size={11} />
                                        </button>
                                        <button
                                            type="button"
                                            className={`sb-segment-btn ${viewportMode === 'tablet' ? 'sb-segment-active' : ''}`}
                                            onClick={() => setViewportMode('tablet')}
                                            title="Tablet View (768px)"
                                        >
                                            <IconTablet size={11} />
                                        </button>
                                        <button
                                            type="button"
                                            className={`sb-segment-btn ${viewportMode === 'mobile' ? 'sb-segment-active' : ''}`}
                                            onClick={() => setViewportMode('mobile')}
                                            title="Mobile View (375px)"
                                        >
                                            <IconSmartphone size={11} />
                                        </button>
                                    </div>
                                )}

                                <button
                                    type="button"
                                    className="sb-btn sb-btn-secondary sb-btn-xs sb-quick-edit-trigger-btn"
                                    onClick={() => {
                                        setIsQuickEditOpen(!isQuickEditOpen);
                                        setTimeout(() => quickEditInputRef.current?.focus(), 50);
                                    }}
                                    title="Inline Quick Edit (⌘K)"
                                >
                                    <IconSparkles size={11} className="text-blue-400" />
                                    <span>⌘K Edit</span>
                                </button>

                                <button
                                    type="button"
                                    className="sb-btn sb-btn-secondary sb-btn-xs"
                                    onClick={handleOpenDiffReview}
                                    title="Review Multi-File Diffs and Batch Apply/Reject"
                                >
                                    <IconGitFork size={12} />
                                    <span>Diff Review</span>
                                </button>

                                <button
                                    type="button"
                                    className="sb-btn sb-btn-secondary sb-btn-xs"
                                    onClick={() => setRefreshKey(k => k + 1)}
                                    title="Recompile & Run Preview"
                                >
                                    <IconRefresh size={12} />
                                    <span>Run</span>
                                </button>
                            </div>
                        </div>

                        {/* Editor Code Area with Line Numbers and IDE Syntax Highlighting */}
                        <div className="sb-ide-code-viewport" style={{ position: 'relative' }}>
                            {/* Floating Cursor Inline Quick Edit (⌘K) Bar */}
                            {isQuickEditOpen && (
                                <div className="sb-inline-quick-edit-bar animate-popover">
                                    <div className="flex items-center gap-2 w-full">
                                        <IconSparkles size={14} className="text-blue-400 flex-shrink-0" />
                                        <input
                                            ref={quickEditInputRef}
                                            type="text"
                                            className="sb-quick-edit-input"
                                            placeholder="Ask AI to edit this code... (e.g. Add TypeScript types, Optimize component, Convert to Tailwind)"
                                            value={quickEditPrompt}
                                            onChange={e => setQuickEditPrompt(e.target.value)}
                                            onKeyDown={e => {
                                                if (e.key === 'Enter') {
                                                    e.preventDefault();
                                                    if (quickEditDiff) {
                                                        handleAcceptQuickEdit();
                                                    } else {
                                                        handleExecuteQuickEdit(quickEditPrompt);
                                                    }
                                                } else if (e.key === 'Escape') {
                                                    e.preventDefault();
                                                    handleRejectQuickEdit();
                                                } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'y' && quickEditDiff) {
                                                    e.preventDefault();
                                                    handleAcceptQuickEdit();
                                                } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'n' && quickEditDiff) {
                                                    e.preventDefault();
                                                    handleRejectQuickEdit();
                                                }
                                            }}
                                        />
                                        {!quickEditDiff ? (
                                            <button
                                                type="button"
                                                className="sb-btn sb-btn-primary sb-btn-xs sb-quick-edit-submit-btn"
                                                onClick={() => handleExecuteQuickEdit(quickEditPrompt)}
                                                disabled={!quickEditPrompt.trim() || isQuickEditing}
                                            >
                                                {isQuickEditing ? 'Editing...' : 'Edit (↵)'}
                                            </button>
                                        ) : (
                                            <div className="flex items-center gap-1.5">
                                                <button
                                                    type="button"
                                                    className="sb-btn sb-btn-primary sb-btn-xs sb-quick-edit-accept-btn"
                                                    onClick={handleAcceptQuickEdit}
                                                    title="Accept diff (⌘Y / Enter)"
                                                >
                                                    <span>✓ Accept</span>
                                                    <kbd className="sb-kbd text-[9px]">⌘Y</kbd>
                                                </button>
                                                <button
                                                    type="button"
                                                    className="sb-btn sb-btn-secondary sb-btn-xs sb-quick-edit-reject-btn"
                                                    onClick={handleRejectQuickEdit}
                                                    title="Reject diff (⌘N / Esc)"
                                                >
                                                    <span>✕ Reject</span>
                                                    <kbd className="sb-kbd text-[9px]">Esc</kbd>
                                                </button>
                                            </div>
                                        )}
                                    </div>
                                    {quickEditDiff && (
                                        <div className="sb-quick-edit-diff-summary animate-fadeIn">
                                            <span className="text-[11px] text-emerald-400 font-mono font-medium">● 1 proposed code patch ready for review (⌘Y to Accept, ⌘N to Reject)</span>
                                        </div>
                                    )}
                                </div>
                            )}

                            <div className="sb-ide-gutter">
                                {lineNumbers.map(n => (
                                    <div key={`line-${n}`} className="sb-ide-line-no">{n}</div>
                                ))}
                            </div>
                            <div className="sb-ide-textarea-wrap">
                                {activeFile && (activeFile.isDirty || dirtyTabIds.includes(activeFile.id)) && (
                                    <div className="sb-comment-hover-overlay" style={{
                                        position: 'absolute',
                                        top: '12px',
                                        right: '12px',
                                        zIndex: 50,
                                        display: 'flex',
                                        alignItems: 'center',
                                        gap: '8px'
                                    }}>
                                        <button
                                            type="button"
                                            className="sb-btn sb-btn-secondary sb-btn-xs"
                                            onClick={handleAddJsdocComments}
                                            disabled={isGeneratingComments}
                                            title="Auto-draft and insert JSDoc headers & code comments (AI powered)"
                                            style={{
                                                boxShadow: '0 4px 12px rgba(0, 0, 0, 0.5)',
                                                backdropFilter: 'blur(4px)',
                                                border: '1px solid rgba(255, 255, 255, 0.08)',
                                                background: 'rgba(24, 24, 27, 0.85)',
                                                color: '#f4f4f5',
                                                fontSize: '11px',
                                                fontWeight: 500,
                                                padding: '4px 8px',
                                                borderRadius: '6px',
                                                display: 'flex',
                                                alignItems: 'center',
                                                gap: '6px',
                                                cursor: 'pointer',
                                                transition: 'all 0.15s ease'
                                            }}
                                        >
                                            <IconSparkles size={11} className={isGeneratingComments ? 'animate-pulse' : ''} />
                                            <span>{isGeneratingComments ? 'Generating JSDoc...' : 'Add JSDoc / Comments'}</span>
                                        </button>
                                    </div>
                                )}
                                <pre ref={highlightPreRef} className="sb-ide-code-highlight" aria-hidden="true">
                                    <code>
                                        {codeTokens.map((tok, idx) => (
                                            <span key={`tok-${idx}`} className={`sb-tok-${tok.type}`}>
                                                {tok.text}
                                            </span>
                                        ))}
                                    </code>
                                </pre>
                                <textarea
                                    ref={textareaRef}
                                    className="sb-ide-code-textarea"
                                    value={activeFile?.content || ''}
                                    onChange={e => handleCodeChange(e.target.value)}
                                    onScroll={handleEditorScroll}
                                    spellCheck={false}
                                    autoCapitalize="off"
                                    autoComplete="off"
                                    placeholder="Write code here... (Press ⌘K to edit with AI)"
                                    onKeyDown={e => {
                                        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
                                            e.preventDefault();
                                            setIsQuickEditOpen(true);
                                            setTimeout(() => quickEditInputRef.current?.focus(), 50);
                                            return;
                                        }
                                        if (e.key === 'Tab') {
                                            e.preventDefault();
                                            const target = e.target as HTMLTextAreaElement;
                                            const start = target.selectionStart;
                                            const end = target.selectionEnd;
                                            const value = target.value;
                                            target.value = value.substring(0, start) + '  ' + value.substring(end);
                                            target.selectionStart = target.selectionEnd = start + 2;
                                            handleCodeChange(target.value);
                                        }
                                    }}
                                />
                            </div>
                        </div>

                        {/* Bottom Editor Status Bar */}
                        <div className="sb-ide-statusbar">
                            <div className="sb-ide-status-left">
                                <button
                                    type="button"
                                    className="sb-ide-status-btn"
                                    onClick={() => setIsConsoleOpen(!isConsoleOpen)}
                                    title="Toggle Terminal & Runtime Console"
                                >
                                    <IconTerminal size={11} />
                                    <span>Console {consoleLogs.length > 0 ? `(${consoleLogs.length})` : ''}</span>
                                </button>
                                <span className="sb-ide-status-item">{activeFile?.language?.toUpperCase() || 'JAVASCRIPT'}</span>
                                <span className="sb-ide-status-item">{lineNumbers.length} lines</span>
                            </div>
                            <div className="sb-ide-status-right">
                                <label className="sb-ide-autorun-toggle" title="Toggle real-time auto-reload">
                                    <input
                                        type="checkbox"
                                        checked={autoRun}
                                        onChange={e => setAutoRun(e.target.checked)}
                                    />
                                    <span>Hot Reload</span>
                                </label>
                                <span className="sb-ide-status-item">UTF-8</span>
                                <span className="sb-ide-status-item">Spaces: 2</span>
                                <button
                                    type="button"
                                    className="sb-ide-status-btn"
                                    onClick={handleCopyCode}
                                    title="Copy Code"
                                >
                                    {copied ? <IconCheck size={11} className="text-emerald-400" /> : <IconCopy size={11} />}
                                    <span>{copied ? 'Copied' : 'Copy'}</span>
                                </button>
                            </div>
                        </div>

                        {/* Bottom Runtime Console Drawer */}
                        {isConsoleOpen && (
                            <div className="sb-ide-console-drawer animate-fadeIn">
                                <div className="sb-ide-console-header">
                                    <div className="sb-ide-console-title">
                                        <IconTerminal size={12} />
                                        <span>Runtime Console</span>
                                    </div>
                                    <div className="sb-ide-console-actions">
                                        <div className="sb-segmented-control sb-segmented-control-xs">
                                            <button
                                                type="button"
                                                className={`sb-segment-btn ${consoleFilter === 'all' ? 'sb-segment-active' : ''}`}
                                                onClick={() => setConsoleFilter('all')}
                                            >
                                                ALL
                                            </button>
                                            <button
                                                type="button"
                                                className={`sb-segment-btn ${consoleFilter === 'log' ? 'sb-segment-active' : ''}`}
                                                onClick={() => setConsoleFilter('log')}
                                            >
                                                LOG
                                            </button>
                                            <button
                                                type="button"
                                                className={`sb-segment-btn ${consoleFilter === 'error' ? 'sb-segment-active' : ''}`}
                                                onClick={() => setConsoleFilter('error')}
                                            >
                                                ERROR
                                            </button>
                                        </div>
                                        <button
                                            type="button"
                                            className="sb-btn sb-btn-ghost sb-btn-xs"
                                            onClick={() => setConsoleLogs([])}
                                            title="Clear logs"
                                        >
                                            <IconTrash size={11} />
                                            <span>Clear</span>
                                        </button>
                                    </div>
                                </div>
                                <div className="sb-ide-console-body">
                                    {filteredLogs.length === 0 ? (
                                        <div className="sb-ide-console-empty">No console output.</div>
                                    ) : (
                                        filteredLogs.map((log, idx) => (
                                            <div key={log.id || `log-${idx}`} className={`sb-ide-console-row sb-ide-log-${log.type}`}>
                                                <span className="sb-ide-log-time">{log.timestamp}</span>
                                                <span className="sb-ide-log-tag">[{log.type.toUpperCase()}]</span>
                                                <span className="sb-ide-log-msg">{log.message}</span>
                                            </div>
                                        ))
                                    )}
                                </div>
                            </div>
                        )}
                    </div>
                )}

                {/* Right / Center: Live Interactive Sandbox Preview */}
                {(viewMode === 'split' || viewMode === 'preview') && (
                    <div className={`sb-ide-preview-container ${viewMode === 'preview' ? 'sb-ide-preview-full' : 'sb-ide-preview-split'}`}>
                        <div className="sb-ide-preview-header">
                            <div className="sb-ide-preview-title">
                                <span className="sb-preview-dot" />
                                <span>Live Sandbox Preview</span>
                            </div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                {viewMode === 'preview' && (
                                    <div className="sb-segmented-control sb-segmented-control-xs" title="Editor View Mode">
                                        <button
                                            type="button"
                                            className={`sb-segment-btn ${(viewMode as string) === 'code' ? 'sb-segment-active' : ''}`}
                                            onClick={() => setViewMode('code')}
                                            title="Code Editor"
                                        >
                                            <IconCode size={12} strokeWidth={2} />
                                            <span className="sb-segment-label">Code</span>
                                        </button>
                                        <button
                                            type="button"
                                            className={`sb-segment-btn ${(viewMode as string) === 'split' ? 'sb-segment-active' : ''}`}
                                            onClick={() => setViewMode('split')}
                                            title="Split Editor & Live Preview"
                                        >
                                            <IconSplit size={12} strokeWidth={2} />
                                            <span className="sb-segment-label">Split</span>
                                        </button>
                                        <button
                                            type="button"
                                            className={`sb-segment-btn ${(viewMode as string) === 'preview' ? 'sb-segment-active' : ''}`}
                                            onClick={() => setViewMode('preview')}
                                            title="Live UI Preview"
                                        >
                                            <IconLaptop size={12} strokeWidth={2} />
                                            <span className="sb-segment-label">Preview</span>
                                        </button>
                                    </div>
                                )}
                                <button
                                    type="button"
                                    className="sb-btn sb-btn-ghost sb-btn-xs"
                                    onClick={handleDownloadHtml}
                                    title="Export standalone HTML"
                                >
                                    <IconDownload size={11} />
                                    <span>Export HTML</span>
                                </button>
                            </div>
                        </div>
                        <div className={`sb-ide-iframe-wrapper sb-viewport-${viewportMode}`}>
                            <iframe
                                ref={iframeRef}
                                key={`sandbox-frame-${refreshKey}`}
                                className="sb-sandbox-iframe"
                                title="Sandbox Preview"
                                srcDoc={srcDocContent}
                                sandbox="allow-scripts allow-same-origin allow-modals allow-forms allow-popups"
                            />
                        </div>
                    </div>
                )}
            </div>

            {/* New File Modal */}
            {showNewFileModal && (
                <div className="sb-modal-overlay animate-fadeIn" onClick={() => setShowNewFileModal(false)}>
                    <div className="sb-modal-content sb-modal-sm animate-popover" onClick={e => e.stopPropagation()}>
                        <div className="sb-modal-header">
                            <h3 className="sb-modal-title">New File</h3>
                            <button
                                type="button"
                                className="sb-modal-close"
                                onClick={() => setShowNewFileModal(false)}
                            >
                                <IconClose size={13} />
                            </button>
                        </div>
                        <div className="sb-modal-body space-y-4">
                            <div>
                                <label className="sb-input-label">Folder Path</label>
                                <input
                                    type="text"
                                    className="sb-input sb-input-sm"
                                    value={newFilePath}
                                    onChange={e => setNewFilePath(e.target.value)}
                                    placeholder="e.g. applications/electron or src"
                                />
                            </div>
                            <div>
                                <label className="sb-input-label">File Name</label>
                                <input
                                    type="text"
                                    className="sb-input sb-input-sm"
                                    value={newFileName}
                                    onChange={e => setNewFileName(e.target.value)}
                                    placeholder="e.g. config.ts, styles.css"
                                    autoFocus
                                    onKeyDown={e => {
                                        if (e.key === 'Enter') handleAddFile();
                                    }}
                                />
                            </div>
                            <div>
                                <label className="sb-input-label">Language</label>
                                <select
                                    className="sb-input sb-input-sm"
                                    value={newFileLang}
                                    onChange={e => setNewFileLang(e.target.value as SandboxLanguage)}
                                >
                                    <option value="javascript">JavaScript (.js)</option>
                                    <option value="typescript">TypeScript (.ts)</option>
                                    <option value="react">React JSX/TSX (.tsx)</option>
                                    <option value="css">CSS (.css)</option>
                                    <option value="json">JSON (.json)</option>
                                    <option value="html">HTML (.html)</option>
                                    <option value="python">Python (.py)</option>
                                </select>
                            </div>
                        </div>
                        <div className="sb-modal-footer">
                            <button
                                type="button"
                                className="sb-btn sb-btn-ghost sb-btn-sm"
                                onClick={() => setShowNewFileModal(false)}
                            >
                                Cancel
                            </button>
                            <button
                                type="button"
                                className="sb-btn sb-btn-primary sb-btn-sm"
                                onClick={handleAddFile}
                                disabled={!newFileName.trim()}
                            >
                                Create File
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Interactive Multi-File Diff Reviewer & Batch Apply Modal */}
            {isDiffReviewOpen && activePatch && (
                <div className="sb-modal-overlay animate-fadeIn" onClick={() => setIsDiffReviewOpen(false)}>
                    <div
                        className="sb-modal-content animate-popover"
                        style={{ maxWidth: '900px', width: '92vw', height: '80vh', display: 'flex', flexDirection: 'column' }}
                        onClick={e => e.stopPropagation()}
                    >
                        <div className="sb-modal-header flex items-center justify-between pb-3 border-b border-zinc-800">
                            <div>
                                <h3 className="sb-modal-title flex items-center gap-2">
                                    <IconGitFork size={16} className="text-blue-400" />
                                    <span>Multi-File Diff Reviewer</span>
                                </h3>
                                <p className="text-xs text-zinc-400 mt-0.5">
                                    Review proposed code changes across {activePatch.files.length} files with 1-click batch application.
                                </p>
                            </div>
                            <button
                                type="button"
                                className="sb-modal-close"
                                onClick={() => setIsDiffReviewOpen(false)}
                            >
                                <IconClose size={13} />
                            </button>
                        </div>

                        {/* Main Diff Work Area: Left file selector | Right line diff viewer */}
                        <div className="flex-1 min-h-0 flex gap-4 pt-3 pb-3">
                            {/* Left File List */}
                            <div className="w-1/3 border-r border-zinc-800/80 pr-3 space-y-2 overflow-y-auto">
                                <div className="text-[11px] font-semibold text-zinc-400 uppercase tracking-wider px-1">
                                    Changed Files ({activePatch.files.length})
                                </div>
                                {activePatch.files.map((diff, fIdx) => {
                                    const isSelected = selectedDiffPaths.includes(diff.path);
                                    const isCurrentPreview = fIdx === previewDiffFileIndex;
                                    return (
                                        <div
                                            key={diff.path}
                                            className={`p-2.5 rounded-xl border transition-all cursor-pointer ${
                                                isCurrentPreview
                                                    ? 'bg-blue-950/30 border-blue-500/50'
                                                    : 'bg-zinc-900/60 border-zinc-800/70 hover:border-zinc-700'
                                            }`}
                                            onClick={() => setPreviewDiffFileIndex(fIdx)}
                                        >
                                            <div className="flex items-center justify-between">
                                                <div className="flex items-center gap-2">
                                                    <input
                                                        type="checkbox"
                                                        checked={isSelected}
                                                        onChange={e => {
                                                            e.stopPropagation();
                                                            setSelectedDiffPaths(prev =>
                                                                prev.includes(diff.path)
                                                                    ? prev.filter(p => p !== diff.path)
                                                                    : [...prev, diff.path]
                                                            );
                                                        }}
                                                        className="rounded border-zinc-700 text-blue-500 focus:ring-0"
                                                    />
                                                    <span className="text-xs font-semibold text-zinc-200 truncate max-w-[140px]" title={diff.path}>
                                                        {diff.path.split('/').pop()}
                                                    </span>
                                                </div>
                                                <div className="flex items-center gap-1.5 text-[10px] font-mono">
                                                    {diff.additions > 0 && <span className="text-emerald-400">+{diff.additions}</span>}
                                                    {diff.deletions > 0 && <span className="text-rose-400">-{diff.deletions}</span>}
                                                </div>
                                            </div>
                                            <div className="text-[10px] text-zinc-500 font-mono mt-1 truncate">
                                                {diff.path}
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>

                            {/* Right Line Diff Viewer */}
                            <div className="w-2/3 flex flex-col bg-zinc-950/80 rounded-xl border border-zinc-800/80 overflow-hidden">
                                {activePatch.files[previewDiffFileIndex] ? (
                                    <>
                                        <div className="p-2.5 bg-zinc-900/80 border-b border-zinc-800 flex items-center justify-between text-xs">
                                            <span className="font-mono text-zinc-300">
                                                {activePatch.files[previewDiffFileIndex].path}
                                            </span>
                                            <span className={`px-2 py-0.5 rounded text-[10px] font-medium ${
                                                activePatch.files[previewDiffFileIndex].status === 'added'
                                                    ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                                                    : 'bg-blue-500/10 text-blue-400 border border-blue-500/20'
                                            }`}>
                                                {activePatch.files[previewDiffFileIndex].status.toUpperCase()}
                                            </span>
                                        </div>
                                        <div className="flex-1 overflow-y-auto p-3 font-mono text-[11px] leading-relaxed select-text">
                                            {(activePatch.files[previewDiffFileIndex].lines || []).map((line, lIdx) => (
                                                <div
                                                    key={lIdx}
                                                    className={`flex items-start px-2 py-0.5 rounded ${
                                                        line.type === 'add'
                                                            ? 'bg-emerald-950/40 text-emerald-300'
                                                            : line.type === 'del'
                                                            ? 'bg-rose-950/40 text-rose-300'
                                                            : 'text-zinc-400'
                                                    }`}
                                                >
                                                    <span className="w-6 text-zinc-600 select-none text-[10px]">
                                                        {line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' '}
                                                    </span>
                                                    <pre className="flex-1 overflow-x-auto whitespace-pre font-mono m-0">
                                                        {line.content}
                                                    </pre>
                                                </div>
                                            ))}
                                        </div>
                                    </>
                                ) : (
                                    <div className="p-8 text-center text-zinc-500 text-xs">Select a file to inspect diff lines.</div>
                                )}
                            </div>
                        </div>

                        {/* Modal Footer Controls */}
                        <div className="sb-modal-footer flex items-center justify-between pt-3 border-t border-zinc-800">
                            <button
                                type="button"
                                className="sb-btn sb-btn-ghost sb-btn-sm text-rose-400 hover:text-rose-300"
                                onClick={() => setIsDiffReviewOpen(false)}
                            >
                                Reject All Changes
                            </button>
                            <div className="flex items-center gap-2">
                                <button
                                    type="button"
                                    className="sb-btn sb-btn-secondary sb-btn-sm"
                                    onClick={() => handleApplyPatch(true)}
                                    disabled={selectedDiffPaths.length === 0}
                                >
                                    Apply Selected ({selectedDiffPaths.length})
                                </button>
                                <button
                                    type="button"
                                    className="sb-btn sb-btn-primary sb-btn-sm"
                                    onClick={() => handleApplyPatch(false)}
                                >
                                    Apply All ({activePatch.files.length} Files)
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* 1-Click "Debug with AI" Floating Toast when Terminal / Sandbox Runtime Fails */}
            {showErrorDebugToast && lastCapturedError && (
                <div className="sb-terminal-error-toast animate-fadeIn" style={{
                    position: 'absolute',
                    bottom: '20px',
                    right: '20px',
                    zIndex: 999,
                    maxWidth: '440px',
                    padding: '12px 16px',
                    borderRadius: '16px',
                    background: 'rgba(24, 24, 27, 0.95)',
                    backdropFilter: 'blur(20px)',
                    border: '1px solid rgba(244, 63, 94, 0.4)',
                    boxShadow: '0 20px 40px rgba(0,0,0,0.6)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '8px'
                }}>
                    <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                            <span style={{ fontSize: '16px' }}>🚨</span>
                            <span className="font-semibold text-xs text-rose-400">Terminal / Runtime Error Detected</span>
                        </div>
                        <button
                            type="button"
                            className="sb-icon-button sb-icon-button-xs"
                            onClick={() => setShowErrorDebugToast(false)}
                        >
                            <IconClose size={11} />
                        </button>
                    </div>
                    <p className="text-[11px] text-zinc-300 font-mono truncate">
                        {lastCapturedError.output.slice(0, 100)}
                    </p>
                    <div className="flex items-center justify-end gap-2 pt-1">
                        <button
                            type="button"
                            className="sb-btn sb-btn-ghost sb-btn-xs"
                            onClick={() => setShowErrorDebugToast(false)}
                        >
                            Dismiss
                        </button>
                        <button
                            type="button"
                            className="sb-btn sb-btn-primary sb-btn-xs bg-rose-600 hover:bg-rose-500 text-white"
                            onClick={handleTriggerDebugAi}
                        >
                            <IconSparkles size={11} />
                            <span>1-Click Fix with AI</span>
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
};
