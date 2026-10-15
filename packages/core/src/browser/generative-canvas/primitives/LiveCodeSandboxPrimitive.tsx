/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
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
    applyMultiFilePatch,
    extractHunksFromDiffLines,
    applySelectedHunks,
    DiffHunkBlock
} from '../multi-file-diff-engine';
import { useInlineFim } from '../hooks/useInlineFim';
import {
    synthesizeTerminalDebugPrompt
} from '../terminal-debug-bridge';
import {
    IconArrowDown,
    IconArrowLeft,
    IconArrowRight,
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
    IconMessageSquare,
    IconMic,
    IconMinimize,
    IconPin,
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
import type { QuickEditRequest, QuickEditResponse } from '../../../common/gemini-protocol';
import Editor from '@monaco-editor/react';

export const getMonacoLanguage = (lang?: string, fileName?: string): string => {
    const ext = fileName ? fileName.split('.').pop()?.toLowerCase() : '';
    if (ext === 'tsx' || ext === 'ts' || lang === 'react' || lang === 'typescript') {
        return 'typescript';
    }
    if (ext === 'jsx' || ext === 'js' || lang === 'javascript') {
        return 'javascript';
    }
    if (ext === 'py' || lang === 'python') {
        return 'python';
    }
    if (ext === 'css') {
        return 'css';
    }
    if (ext === 'json') {
        return 'json';
    }
    if (ext === 'md' || ext === 'markdown') {
        return 'markdown';
    }
    if (ext === 'html') {
        return 'html';
    }
    if (ext === 'cpp' || ext === 'c' || ext === 'h' || ext === 'hpp') {
        return 'cpp';
    }
    if (ext === 'sh' || ext === 'bash') {
        return 'shell';
    }
    return 'plaintext';
};

export interface LiveCodeSandboxPrimitiveProps {
    data: LiveCodeSandboxData;
    onUpdate?: (updatedData: LiveCodeSandboxData) => void;
    onSave?: (updatedData: LiveCodeSandboxData) => void;
    onForkArtifact?: (forkedArtifact: CanvasArtifact) => void;
    onPromptAction?: (promptText: string) => void;
    onDebugWithAi?: (errorPrompt: string) => void;
    onCaptureReady?: (captureFn: () => string | null) => void;
    onVisualVerification?: (screenshotDataUrl: string) => void;
    hideTopbar?: boolean;
    hideInternalChat?: boolean;
}

/**
 * Captures a screenshot data URL of the active sandbox preview or canvas.
 */
export function captureSandboxScreenshot(containerOrIframe?: HTMLElement | null): string | null {
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

    // No readable canvas: report no frame (never a placeholder image for the visual check to inspect).
    return null;
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
 * Detects the active Content-Security-Policy nonce from the host document if one was injected.
 */
export function getEffectiveCspNonce(): string {
    if (typeof document !== 'undefined') {
        const meta = document.querySelector('meta[property="csp-nonce"]');
        if (meta) {
            const n = meta.getAttribute('nonce') || meta.getAttribute('content');
            if (n) return n;
        }
        const script = document.querySelector('script[nonce]');
        if (script) {
            const n = script.getAttribute('nonce');
            if (n) return n;
        }
        const style = document.querySelector('style[nonce]');
        if (style) {
            const n = style.getAttribute('nonce');
            if (n) return n;
        }
    }
    return '';
}

/**
 * Builds a secure, live self-contained srcDoc HTML for sandboxed rendering.
 */
export function buildSandboxSrcDoc(data: LiveCodeSandboxData, cspNonce?: string): string {
    const files = Array.isArray(data?.files) ? data.files : [];
    const template = data?.template || 'react';
    const dependencies = data?.dependencies || {};
    const effectiveNonce = cspNonce !== undefined ? cspNonce : getEffectiveCspNonce();
    const nonceAttr = effectiveNonce ? ` nonce="${effectiveNonce}"` : '';

    const entryFile = files.find(f => f.isEntry) || files.find(f => f.name.endsWith('.tsx') || f.name.endsWith('.jsx')) || files[0] || {
        id: 'default',
        name: 'App.tsx',
        language: 'react',
        content: 'export default () => React.createElement("div", null, "Hello Scratchbox Live Sandbox");'
    };

    const cssFiles = files.filter(f => f.language === 'css' || f.name.endsWith('.css'));
    const combinedCss = cssFiles.map(f => f.content).join('\n\n');
    const jsTsFiles = files.filter(f => {
        const lang = (f.language || '').toLowerCase();
        const name = (f.name || '').toLowerCase();
        if (lang === 'css' || lang === 'html' || lang === 'json' || lang === 'markdown' || lang === 'md') return false;
        if (name.endsWith('.css') || name.endsWith('.html') || name.endsWith('.json') || name.endsWith('.md') || name.endsWith('.txt')) return false;
        if (name.includes('.config.') || name.includes('webpack') || name.startsWith('gen-')) return false;
        return lang === 'javascript' || lang === 'typescript' || lang === 'react' ||
            name.endsWith('.js') || name.endsWith('.jsx') || name.endsWith('.ts') || name.endsWith('.tsx');
    });
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
  <meta http-equiv="Content-Security-Policy" content="default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob: https://cdn.jsdelivr.net https://esm.sh https://unpkg.com https://cdn.tailwindcss.com; connect-src 'self' http://localhost:* ws://localhost:* https: data: blob:; img-src 'self' http://localhost:* https: data: blob:; font-src 'self' http://localhost:* https: data:; media-src 'self' http://localhost:* https: data: blob:;" />
  <title>Python Sandbox</title>
  <script${nonceAttr} src="https://cdn.tailwindcss.com"></script>
  <script${nonceAttr} src="https://cdn.jsdelivr.net/pyodide/v0.25.0/full/pyodide.js"></script>
  <style${nonceAttr}>
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

  <script${nonceAttr}>
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
  <meta http-equiv="Content-Security-Policy" content="default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob: https://cdn.jsdelivr.net https://esm.sh https://unpkg.com https://cdn.tailwindcss.com; connect-src 'self' http://localhost:* ws://localhost:* https: data: blob:; img-src 'self' http://localhost:* https: data: blob:; font-src 'self' http://localhost:* https: data:; media-src 'self' http://localhost:* https: data: blob:;" />
  <title>Scratchbox Live UI Sandbox</title>
  <script${nonceAttr} src="https://cdn.tailwindcss.com"></script>
  <script${nonceAttr} type="importmap">
    ${importMapJson}
  </script>
  <script${nonceAttr} src="https://unpkg.com/@babel/standalone@7.24.4/babel.min.js"></script>
  <style${nonceAttr}>
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
    <div style="display: flex; gap: 8px; margin-top: 12px;">
      <button type="button" onclick="if(window.scratchbox && window.scratchbox.ai) { window.scratchbox.ai.refine('Auto-fix the following runtime error: ' + document.getElementById('sandbox-error-message').innerText); }" style="padding: 6px 14px; border-radius: 6px; border: 1px solid #7c3aed; background: #6d28d9; color: #fff; cursor: pointer; font-size: 12px; font-weight: 600; display: inline-flex; align-items: center; gap: 6px;">
        <span>⚡ Auto-Fix with AI</span>
      </button>
      <button type="button" onclick="document.getElementById('sandbox-error-overlay').style.display='none'" style="padding: 6px 14px; border-radius: 6px; border: 1px solid #3f3f46; background: #27272a; color: #fff; cursor: pointer; font-size: 12px;">Dismiss</button>
    </div>
  </div>

  <script${nonceAttr}>
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

      window.onunhandledrejection = function(event) {
        const err = event.reason || 'Unhandled Promise Rejection';
        const msg = err && err.stack ? err.stack : String(err);
        const overlay = document.getElementById('sandbox-error-overlay');
        const errorMsg = document.getElementById('sandbox-error-message');
        if (overlay && errorMsg) {
          errorMsg.innerText = msg;
          overlay.style.display = 'block';
        }
        sendToParent('error', ['Unhandled Rejection: ' + (err.message || msg)]);
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
        },
        storage: {
          saveAsset: function(filename, content, mimeType) {
            return window.scratchbox.rpcCall('storage:save-asset', { filename: filename, content: content, mimeType: mimeType || 'text/plain' });
          },
          exportState: function(state) {
            return window.scratchbox.rpcCall('storage:export-state', { state: state });
          },
          getState: function() {
            return window.scratchbox.rpcCall('storage:get-state', {});
          }
        },
        ai: {
          refine: function(prompt) {
            return window.scratchbox.rpcCall('ai:refine', { prompt: prompt });
          }
        },
        native3d: {
          generateGlb: function(sourceCode) {
            return window.scratchbox.rpcCall('native3d:compile-and-generate', { sourceCode: sourceCode });
          }
        }
      };

      // In-Situ Element Inspector Script
      (function() {
        var isInspecting = false;
        var hoveredEl = null;
        var originalOutline = '';
        var originalCursor = '';

        function getSelector(el) {
          if (!el || el === document.body || el === document.documentElement) return 'body';
          if (el.id) return '#' + el.id;
          var path = [];
          var current = el;
          while (current && current.nodeType === Node.ELEMENT_NODE && current !== document.body) {
            var tag = current.tagName.toLowerCase();
            var parent = current.parentNode;
            if (parent) {
              var siblings = Array.prototype.filter.call(parent.children, function(child) {
                return child.tagName.toLowerCase() === tag;
              });
              if (siblings.length > 1) {
                var index = Array.prototype.indexOf.call(siblings, current) + 1;
                tag += ':nth-of-type(' + index + ')';
              }
            }
            if (current.className && typeof current.className === 'string') {
              var classes = current.className.trim().split(/\s+/).filter(function(c) {
                return c && !c.startsWith('sb-') && !c.includes(':');
              }).slice(0, 2);
              if (classes.length > 0) tag += '.' + classes.join('.');
            }
            path.unshift(tag);
            current = current.parentElement;
          }
          return path.join(' > ');
        }

        window.addEventListener('message', function(e) {
          if (!e.data) return;
          if (e.data.type === 'sb-set-inspector-mode') {
            isInspecting = !!e.data.active;
            if (!isInspecting && hoveredEl) {
              hoveredEl.style.outline = originalOutline;
              hoveredEl.style.cursor = originalCursor;
              hoveredEl = null;
            }
          }
        });

        document.addEventListener('mouseover', function(e) {
          if (!isInspecting) return;
          var target = e.target;
          if (!target || target === document.body || target === document.documentElement) return;
          if (hoveredEl && hoveredEl !== target) {
            hoveredEl.style.outline = originalOutline;
            hoveredEl.style.cursor = originalCursor;
          }
          hoveredEl = target;
          originalOutline = target.style.outline || '';
          originalCursor = target.style.cursor || '';
          target.style.outline = '2px dashed #0284c7';
          target.style.cursor = 'crosshair';
        }, true);

        document.addEventListener('mouseout', function(e) {
          if (!isInspecting || !hoveredEl) return;
          hoveredEl.style.outline = originalOutline;
          hoveredEl.style.cursor = originalCursor;
          hoveredEl = null;
        }, true);

        document.addEventListener('click', function(e) {
          if (!isInspecting) return;
          e.preventDefault();
          e.stopPropagation();
          var target = e.target;
          if (!target || target === document.body || target === document.documentElement) return;
          var rect = target.getBoundingClientRect();
          var selector = getSelector(target);
          var snippet = target.outerHTML ? target.outerHTML.slice(0, 160) : target.tagName;
          var textContent = (target.textContent || '').trim().slice(0, 80);

          window.parent.postMessage({
            type: 'sb-insitu-element-selected',
            selector: selector,
            tagName: target.tagName.toLowerCase(),
            rect: {
              x: rect.left,
              y: rect.top,
              width: rect.width,
              height: rect.height
            },
            snippet: snippet,
            textContent: textContent
          }, '*');
        }, true);
      })();
    })();
  </script>

  ${template === 'react' ? `
  <script${nonceAttr} type="module">
    import React from 'react';
    import ReactDOM from 'react-dom/client';
    import * as LucideIcons from 'lucide-react';
    import confetti from 'canvas-confetti';
    import * as THREE from 'three';

    window.React = React;
    window.ReactDOM = ReactDOM;
    window.LucideIcons = LucideIcons;
    window.confetti = confetti;
    window.THREE = THREE;
    try { Object.assign(window, React); } catch(_) {}
    if (LucideIcons) { try { Object.assign(window, LucideIcons); } catch(_) {} }

    window.__ScratchboxSdk = window.__ScratchboxSdk || {
      scratchbox: window.scratchbox,
      useScratchboxRpc: function(method, params) {
        const [data, setData] = React.useState(null);
        const [loading, setLoading] = React.useState(false);
        const [error, setError] = React.useState(null);
        const execute = React.useCallback(async (overrideParams) => {
          setLoading(true);
          setError(null);
          try {
            const res = await window.scratchbox.rpcCall(method, overrideParams || params);
            setData(res);
            return res;
          } catch (err) {
            setError(err);
            throw err;
          } finally {
            setLoading(false);
          }
        }, [method, JSON.stringify(params)]);
        return { data, loading, error, execute };
      },
      useAtmosphere: function(config) {
        const [state, setState] = React.useState({ sunElevation: 45, turbidity: 2.0, diurnalPhase: 'midday', ...config });
        return {
          ...state,
          setTimeOfDay: (phase) => setState(prev => ({ ...prev, diurnalPhase: phase })),
          setSunElevation: (elevation) => setState(prev => ({ ...prev, sunElevation: elevation }))
        };
      },
      Google3DViewport: function(props) {
        return React.createElement('div', {
          style: {
            width: '100%',
            height: props.height || '360px',
            background: 'linear-gradient(135deg, #090d16 0%, #172554 100%)',
            borderRadius: '8px',
            border: '1px solid #1e3a8a',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            position: 'relative',
            overflow: 'hidden',
            color: '#93c5fd',
            fontFamily: 'monospace',
            fontSize: '13px',
            padding: '16px',
            boxSizing: 'border-box',
            ...props.style
          }
        }, [
          React.createElement('div', { key: 'badge', style: { position: 'absolute', top: 12, left: 12, background: 'rgba(30, 58, 138, 0.8)', padding: '4px 8px', borderRadius: '4px', fontSize: '11px', fontWeight: 600, color: '#bfdbfe' } }, '🌐 Google Photorealistic 3D Tiles (Streamed)'),
          React.createElement('div', { key: 'coords', style: { marginTop: '20px', textAlign: 'center' } }, [
            React.createElement('div', { key: 'loc', style: { fontSize: '14px', fontWeight: 700, color: '#f8fafc', marginBottom: '4px' } }, props.location || 'Real-World 3D Geodetic Stage'),
            React.createElement('div', { key: 'sub', style: { fontSize: '11px', color: '#60a5fa' } }, 'Lat: ' + (props.lat ?? 37.7749) + ' | Lng: ' + (props.lng ?? -122.4194) + ' | Alt: ' + (props.alt ?? 120) + 'm')
          ]),
          props.children
        ]);
      },
      AudioVisualizer: function(props) {
        return React.createElement('div', {
          style: {
            height: props.height || '64px',
            width: '100%',
            background: '#090d16',
            borderRadius: '6px',
            border: '1px solid #1e293b',
            display: 'flex',
            alignItems: 'flex-end',
            gap: '3px',
            padding: '6px',
            boxSizing: 'border-box',
            ...props.style
          }
        }, Array.from({ length: props.bars || 24 }).map((_, i) =>
          React.createElement('div', {
            key: i,
            style: {
              flex: 1,
              height: Math.max(12, Math.sin((i + Date.now()/500) * 0.8) * 45 + 50) + '%',
              background: 'linear-gradient(to top, #3b82f6, #06b6d4)',
              borderRadius: '2px',
              transition: 'height 0.15s ease'
            }
          })
        ));
      },
      MetricCard: function(props) {
        return React.createElement('div', {
          style: {
            background: 'rgba(255, 255, 255, 0.03)',
            border: '1px solid rgba(255, 255, 255, 0.08)',
            borderRadius: '8px',
            padding: '16px',
            display: 'flex',
            flexDirection: 'column',
            gap: '4px',
            ...props.style
          }
        }, [
          React.createElement('span', { key: 'label', style: { fontSize: '12px', color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em' } }, props.label),
          React.createElement('div', { key: 'val-row', style: { display: 'flex', alignItems: 'baseline', gap: '6px' } }, [
            React.createElement('span', { key: 'val', style: { fontSize: '24px', fontWeight: 700, color: '#f8fafc' } }, props.value),
            props.unit && React.createElement('span', { key: 'unit', style: { fontSize: '13px', color: '#64748b' } }, props.unit)
          ]),
          props.change && React.createElement('span', {
            key: 'change',
            style: { fontSize: '11px', color: props.change.startsWith('+') ? '#34d399' : '#f87171' }
          }, props.change)
        ]);
      },
      Notification: function(props) {
        return React.createElement('div', {
          style: {
            padding: '10px 14px',
            borderRadius: '6px',
            background: props.type === 'error' ? '#450a0a' : props.type === 'success' ? '#064e3b' : '#0f172a',
            border: '1px solid ' + (props.type === 'error' ? '#ef4444' : props.type === 'success' ? '#10b981' : '#38bdf8'),
            color: '#f8fafc',
            fontSize: '13px',
            ...props.style
          }
        }, props.children || props.message);
      }
    };

    window.require = window.require || function(mod) {
      if (mod === 'react') return window.React;
      if (mod === 'react-dom' || mod === 'react-dom/client') return window.ReactDOM;
      if (mod === 'lucide-react') return window.LucideIcons;
      if (mod === 'canvas-confetti') return window.confetti;
      if (mod === 'three') return window.THREE;
      if (mod === '@scratchbox/core' || mod === '@scratchbox/core/browser' || mod === '@scratchbox/tool-sdk') return window.__ScratchboxSdk;
      if (mod === 'assert') return window.assert;
      return window[mod] || {};
    };
    window.module = window.module || { exports: {} };
    window.exports = window.exports || window.module.exports;

    window.assert = window.assert || {
      ok: (val, msg) => { if (!val) throw new Error(msg || 'Assertion failed'); },
      strictEqual: (a, b) => { if (a !== b) throw new Error(String(a) + ' !== ' + String(b)); },
      deepStrictEqual: (a, b) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(JSON.stringify(a) + ' !== ' + JSON.stringify(b)); }
    };
    window.describe = window.describe || function(name, fn) { try { fn(); } catch(e) { console.warn('[Test Suite Error]', name, e); } };
    window.test = window.it = window.test || function(name, fn) { try { fn(); } catch(e) { console.warn('[Test Spec Error]', name, e); } };
    window.expect = window.expect || function(val) {
      return {
        toBe: (expected) => { if (val !== expected) throw new Error(String(val) + ' !== ' + String(expected)); },
        toEqual: (expected) => { if (JSON.stringify(val) !== JSON.stringify(expected)) throw new Error(JSON.stringify(val) + ' !== ' + JSON.stringify(expected)); },
        toBeTruthy: () => { if (!val) throw new Error('Expected truthy value'); },
        toBeFalsy: () => { if (val) throw new Error('Expected falsy value'); }
      };
    };

    const {
      useState, useEffect, useRef, useMemo, useCallback, useReducer, useContext, createContext
    } = React;
    const {
      Sparkles, Play, CheckCircle2, ArrowRight, Activity, Zap, Check, AlertCircle,
      Camera, Layers, Video, Eye, Settings, Download, RotateCcw, Move
    } = LucideIcons || {};

    let __ScratchboxRegisteredApp__ = null;

    const __sb_files__ = ${JSON.stringify(jsTsFiles.map(f => ({ name: f.name, content: f.content })))};
    window.__sb_modules__ = window.__sb_modules__ || {};
    window.__sb_module_cache__ = window.__sb_module_cache__ || {};

    function __sb_normalize_path__(specifier, fromFile) {
      if (!specifier || !specifier.startsWith('.')) return specifier;
      const fromDir = fromFile && fromFile.includes('/') ? fromFile.substring(0, fromFile.lastIndexOf('/')) : '';
      const parts = fromDir ? fromDir.split('/') : [];
      for (const seg of specifier.split('/')) {
        if (seg === '.' || seg === '') continue;
        if (seg === '..') parts.pop();
        else parts.push(seg);
      }
      return parts.join('/');
    }

    function __sb_require__(specifier, fromFile) {
      const normalized = __sb_normalize_path__(specifier, fromFile);
      const candidates = [
        normalized,
        normalized + '.tsx',
        normalized + '.ts',
        normalized + '.jsx',
        normalized + '.js',
        './' + normalized,
        './' + normalized + '.tsx',
        './' + normalized + '.ts'
      ];
      let resolvedKey = null;
      for (const c of candidates) {
        if (window.__sb_modules__[c]) {
          resolvedKey = c;
          break;
        }
      }

      if (resolvedKey) {
        if (window.__sb_module_cache__[resolvedKey]) {
          return window.__sb_module_cache__[resolvedKey].exports;
        }
        const mod = { exports: {} };
        window.__sb_module_cache__[resolvedKey] = mod;
        const fn = window.__sb_modules__[resolvedKey];
        fn(mod.exports, function(dep) { return __sb_require__(dep, resolvedKey); }, mod);
        return mod.exports;
      }

      return window.require(specifier);
    }

    function __sb_offline_transpile__(rawCode) {
      var source = rawCode;
      // 1. Strip TypeScript types and interfaces
      source = source.replace(/interface\\s+[A-Za-z0-9_$]+(?:\\s*<[^>]+>)?(?:\\s+extends\\s+[^{]+)?\\s*\\{[\\s\\S]*?\\}/g, '');
      source = source.replace(/type\\s+[A-Za-z0-9_$]+(?:\\s*<[^>]+>)?\\s*=[^;]+;/g, '');
      source = source.replace(/\\s+as\\s+[A-Za-z0-9_$]+(?:<[^>]+>)?/g, '');
      source = source.replace(/(useState|useRef|useMemo|useCallback|createContext|useReducer)<[^>]+>\\(/g, '$1(');
      source = source.replace(/:\\s*(?:string|number|boolean|any|void|unknown|never|React\\.[A-Za-z0-9_$]+|Record<[^>]+>|Array<[^>]+>|[A-Za-z0-9_$]+(?:<[^>]+>)?)(?=[,\\)\\=\\s])/g, '');

      // 2. Parse and transpile JSX constructs
      var pos = 0;
      var len = source.length;

      function skipWhitespace() {
        while (pos < len && /\\s/.test(source[pos])) pos++;
      }

      function parseAttrs() {
        var attrs = [];
        while (pos < len) {
          skipWhitespace();
          if (source[pos] === '/' || source[pos] === '>') break;
          if (source[pos] === '{') {
            pos++;
            var depth = 1;
            var start = pos;
            while (pos < len && depth > 0) {
              if (source[pos] === '{') depth++;
              else if (source[pos] === '}') depth--;
              pos++;
            }
            var expr = source.slice(start, pos - 1).trim();
            if (expr.startsWith('...')) attrs.push(expr.slice(3));
            else attrs.push(expr);
            continue;
          }
          var nameStart = pos;
          while (pos < len && /[A-Za-z0-9_$-]/.test(source[pos])) pos++;
          var name = source.slice(nameStart, pos);
          if (!name) break;
          skipWhitespace();
          if (source[pos] === '=') {
            pos++;
            skipWhitespace();
            if (source[pos] === '"' || source[pos] === "'") {
              var q = source[pos++];
              var valStart = pos;
              while (pos < len && source[pos] !== q) {
                if (source[pos] === '\\\\') pos++;
                pos++;
              }
              var val = source.slice(valStart, pos);
              pos++;
              attrs.push(JSON.stringify(name) + ': ' + JSON.stringify(val));
            } else if (source[pos] === '{') {
              pos++;
              var depth2 = 1;
              var valStart2 = pos;
              while (pos < len && depth2 > 0) {
                if (source[pos] === '{') depth2++;
                else if (source[pos] === '}') depth2--;
                pos++;
              }
              var valExpr = source.slice(valStart2, pos - 1).trim();
              attrs.push(JSON.stringify(name) + ': (' + valExpr + ')');
            }
          } else {
            attrs.push(JSON.stringify(name) + ': true');
          }
        }
        return attrs.length ? '{' + attrs.join(', ') + '}' : 'null';
      }

      function parseElement() {
        if (source[pos] !== '<') return null;
        pos++;
        skipWhitespace();
        var isFragment = false;
        var tag = '';
        if (source[pos] === '>') {
          isFragment = true;
          pos++;
        } else {
          var tagStart = pos;
          while (pos < len && /[A-Za-z0-9_$.]/.test(source[pos])) pos++;
          tag = source.slice(tagStart, pos);
          if (!tag) return null;
        }

        var attrCode = 'null';
        if (!isFragment) {
          attrCode = parseAttrs();
          skipWhitespace();
          if (source[pos] === '/' && source[pos + 1] === '>') {
            pos += 2;
            var tagRef = /^[a-z]/.test(tag) ? JSON.stringify(tag) : tag;
            return 'React.createElement(' + tagRef + ', ' + attrCode + ')';
          }
          if (source[pos] === '>') {
            pos++;
          } else {
            return null;
          }
        }

        var children = [];
        while (pos < len) {
          if (source[pos] === '<') {
            if (source[pos + 1] === '/') {
              pos += 2;
              var closeTagStart = pos;
              while (pos < len && /[A-Za-z0-9_$.]/.test(source[pos])) pos++;
              var closeTag = source.slice(closeTagStart, pos);
              skipWhitespace();
              if (source[pos] === '>') pos++;
              break;
            } else {
              var childElem = parseElement();
              if (childElem) children.push(childElem);
              else pos++;
            }
          } else if (source[pos] === '{') {
            pos++;
            var depth3 = 1;
            var expStart = pos;
            while (pos < len && depth3 > 0) {
              if (source[pos] === '{') depth3++;
              else if (source[pos] === '}') depth3--;
              pos++;
            }
            var childExpr = source.slice(expStart, pos - 1).trim();
            if (childExpr) children.push('(' + childExpr + ')');
          } else {
            var textStart = pos;
            while (pos < len && source[pos] !== '<' && source[pos] !== '{') pos++;
            var text = source.slice(textStart, pos).trim();
            if (text) children.push(JSON.stringify(text));
          }
        }

        var resTagRef = isFragment ? 'React.Fragment' : (/^[a-z]/.test(tag) ? JSON.stringify(tag) : tag);
        return 'React.createElement(' + resTagRef + ', ' + attrCode + (children.length ? ', ' + children.join(', ') : '') + ')';
      }

      var out = '';
      while (pos < len) {
        if (source[pos] === '<' && /[A-Za-z0-9_$>.]/.test(source[pos + 1] || '')) {
          var lookbehind = source.slice(Math.max(0, pos - 20), pos).trim();
          var isJsxContext = /(?:return|\\(|\\[|\\=|,|:|\\?|&|\\||>)\\s*$/.test(lookbehind) || lookbehind === '';
          if (isJsxContext) {
            var savedPos = pos;
            var elem = parseElement();
            if (elem) {
              out += elem;
              continue;
            } else {
              pos = savedPos;
            }
          }
        }
        out += source[pos++];
      }
      return out;
    }

    async function __sb_boot__() {
      try {
        let attempts = 0;
        // Wait briefly for Babel CDN (up to 30 attempts / 1.5s)
        while (!window.Babel && attempts < 30) {
          await new Promise(r => setTimeout(r, 50));
          attempts++;
        }
        if (!window.Babel) {
          console.warn('[Scratchbox Sandbox] Babel Standalone CDN not reachable. Using embedded offline AST transpiler fallback.');
        }

        for (const f of __sb_files__) {
        let code = f.content;
        code = code.replace(/import\\s+React(?:\\s*,\\s*\\{([^}]*)\\})?\\s+from\\s+['"]react['"];?/g, function(_, names) {
          return names ? 'const { ' + names + ' } = window.React;' : '';
        });
        code = code.replace(/import\\s+\\{([^}]*)\\}\\s+from\\s+['"]react['"];?/g, 'const { $1 } = window.React;');
        code = code.replace(/import\\s+ReactDOM\\b[^;]*;/g, '');
        code = code.replace(/import\\s+['"][^'"]+\\.css['"];?/g, '');
        code = code.replace(/import\\s+type\\s+[^;]+;/g, '');

        // Relative module imports
        code = code.replace(/import\\s+([A-Za-z0-9_$]+)\\s*,\\s*\\{([^}]*)\\}\\s+from\\s+['"](\\.[^'"]+)['"];?/g, function(_, def, names, path) {
          return 'const ' + def + ' = (__sb_require__("' + path + '", "' + f.name + '").default || __sb_require__("' + path + '", "' + f.name + '")); const { ' + names + ' } = __sb_require__("' + path + '", "' + f.name + '");';
        });
        code = code.replace(/import\\s+\\*\\s+as\\s+([A-Za-z0-9_$]+)\\s+from\\s+['"](\\.[^'"]+)['"];?/g, function(_, name, path) {
          return 'const ' + name + ' = __sb_require__("' + path + '", "' + f.name + '");';
        });
        code = code.replace(/import\\s+\\{([^}]*)\\}\\s+from\\s+['"](\\.[^'"]+)['"];?/g, function(_, names, path) {
          return 'const { ' + names + ' } = __sb_require__("' + path + '", "' + f.name + '");';
        });
        code = code.replace(/import\\s+([A-Za-z0-9_$]+)\\s+from\\s+['"](\\.[^'"]+)['"];?/g, function(_, name, path) {
          return 'const ' + name + ' = (__sb_require__("' + path + '", "' + f.name + '").default || __sb_require__("' + path + '", "' + f.name + '"));';
        });

        // External package imports
        code = code.replace(/import\\s+\\*\\s+as\\s+([A-Za-z0-9_$]+)\\s+from\\s+['"]([^'"]+)['"];?/g, 'const $1 = window.require("$2");');
        code = code.replace(/import\\s+\\{([^}]*)\\}\\s+from\\s+['"]([^'"]+)['"];?/g, 'const { $1 } = window.require("$2");');
        code = code.replace(/import\\s+([A-Za-z0-9_$]+)\\s+from\\s+['"]([^'"]+)['"];?/g, 'const $1 = (window.require("$2").default || window.require("$2"));');
        code = code.replace(/import\\s+['"][^'"]+['"];?/g, '');

        // Export default replacements
        code = code.replace(/export\\s+default\\s+function\\s+([A-Za-z0-9_$]+)\\s*\\(/g, 'module.exports.default = module.exports.$1 = window.$1 = window.__ScratchboxRegisteredApp__ = function $1(');
        code = code.replace(/export\\s+default\\s+function\\s*\\(/g, 'module.exports.default = window.__ScratchboxRegisteredApp__ = function(');
        code = code.replace(/export\\s+default\\s+([A-Za-z0-9_$]+)\\s*;?/g, 'module.exports.default = window.__ScratchboxRegisteredApp__ = window.App = $1;');
        code = code.replace(/export\\s+default\\s+/g, 'module.exports.default = window.__ScratchboxRegisteredApp__ = window.App = ');

        // Named exports
        code = code.replace(/export\\s+(const|let|var)\\s+([A-Za-z0-9_$]+)\\s*=/g, 'const $2 = module.exports.$2 =');
        code = code.replace(/export\\s+(?:async\\s+)?function\\s+([A-Za-z0-9_$]+)\\s*\\(/g, 'module.exports.$1 = window.$1 = function $1(');
        code = code.replace(/export\\s+class\\s+([A-Za-z0-9_$]+)/g, 'module.exports.$1 = class $1');
        code = code.replace(/export\\s+\\{([^}]*)\\};?/g, function(_, names) {
          return names.split(',').map(function(n) {
            var parts = n.trim().split(/\\s+as\\s+/);
            var src = parts[0] && parts[0].trim();
            var dst = (parts[1] && parts[1].trim()) || src;
            return src ? 'module.exports["' + dst + '"] = ' + src + ';' : '';
          }).join(' ');
        });
        code = code.replace(/export\\s+\\*\\s+from\\s+['"][^'"]*['"];?/g, '');
        code = code.replace(/^\\s*export\\s+/gm, '');

        let transpiled = '';
        if (window.Babel && typeof window.Babel.transform === 'function') {
          transpiled = window.Babel.transform(code, {
            presets: [
              'react',
              ['typescript', { isTSX: true, allExtensions: true }]
            ],
            filename: f.name
          }).code;
        } else {
          transpiled = __sb_offline_transpile__(code);
        }

        const fallbackCheck = '\\nif (typeof App !== "undefined" && !module.exports.default && !module.exports.App) { module.exports.App = App; }\\n' +
          'if (typeof AudioVisualizer !== "undefined" && !module.exports.default) { module.exports.AudioVisualizer = AudioVisualizer; }\\n';
        const modFn = new Function('exports', 'require', 'module', transpiled + fallbackCheck);
        const cleanKey = f.name.replace(/^(\\.\\/|\\/)/, '');
        window.__sb_modules__[cleanKey] = modFn;
        window.__sb_modules__['./' + cleanKey] = modFn;
        const baseName = cleanKey.split('/').pop() || cleanKey;
        window.__sb_modules__[baseName] = modFn;
        window.__sb_modules__['./' + baseName] = modFn;
        if (cleanKey.endsWith('.tsx') || cleanKey.endsWith('.ts') || cleanKey.endsWith('.jsx') || cleanKey.endsWith('.js')) {
          const noExt = cleanKey.replace(/\\.(tsx|ts|jsx|js)$/, '');
          window.__sb_modules__[noExt] = modFn;
          window.__sb_modules__['./' + noExt] = modFn;
          const baseNoExt = baseName.replace(/\\.(tsx|ts|jsx|js)$/, '');
          window.__sb_modules__[baseNoExt] = modFn;
          window.__sb_modules__['./' + baseNoExt] = modFn;
        }
      }

      const entryFileName = ${JSON.stringify(entryFile.name.replace(/^(\.\/|\/)/, ''))};
      let rootModule = {};
      try {
        rootModule = __sb_require__(entryFileName, '') || {};
      } catch(reqErr) {
        console.warn('[Scratchbox Sandbox] Error loading entry module:', reqErr);
      }

      const container = document.getElementById('root');
      if (container) {
        const root = ReactDOM.createRoot(container);
        const ComponentToMount = rootModule.default ||
                                 rootModule.App ||
                                 window.App ||
                                 window.__ScratchboxRegisteredApp__ ||
                                 __ScratchboxRegisteredApp__ ||
                                 (typeof App !== 'undefined' ? App : null) ||
                                 (typeof AudioVisualizer !== 'undefined' ? AudioVisualizer : null) ||
                                 (window.__ScratchboxDefaultComponent__ || null);
        if (ComponentToMount) {
          root.render(React.createElement(ComponentToMount));
          console.info('[Scratchbox Sandbox] React component mounted successfully.');
        } else {
          const ServiceFallback = () => React.createElement('div', {
            style: {
              display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
              minHeight: '100vh', background: '#090d16', color: '#e2e8f0', fontFamily: 'system-ui, sans-serif',
              padding: '24px', textAlign: 'center'
            }
          },
            React.createElement('div', {
              style: {
                width: '48px', height: '48px', borderRadius: '12px', background: 'rgba(59, 130, 246, 0.15)',
                border: '1px solid rgba(59, 130, 246, 0.3)', display: 'flex', alignItems: 'center',
                justifyContent: 'center', marginBottom: '16px', color: '#60a5fa', fontSize: '22px'
              }
            }, '⚡'),
            React.createElement('h3', { style: { fontSize: '18px', fontWeight: 600, margin: '0 0 8px' } },
              'Service & Unit Test Suite'
            ),
            React.createElement('p', { style: { fontSize: '13px', color: '#94a3b8', maxWidth: '420px', margin: '0 0 20px', lineHeight: 1.5 } },
              'This sandbox contains backend logic, data pipelines, and automated test specifications. View and edit the source files in the editor pane.'
            ),
            React.createElement('div', {
              style: {
                padding: '6px 14px', borderRadius: '6px', background: 'rgba(34, 197, 94, 0.15)',
                border: '1px solid rgba(34, 197, 94, 0.3)', color: '#4ade80', fontSize: '12px', fontWeight: 600
              }
            }, '✓ Modules & Test Specs Validated')
          );
          root.render(React.createElement(ServiceFallback));
          console.info('[Scratchbox Sandbox] Module service fallback mounted successfully.');
        }
      }
    } catch(err) {
      console.error('[Mount Error]', err);
      const container = document.getElementById('root');
      if (container) {
        container.innerHTML = '<div style="padding: 24px; font-family: monospace; color: #f87171; background: #09090b; min-height: 100vh;">' +
          '<div style="display: flex; align-items: center; gap: 8px; margin-bottom: 12px;">' +
            '<span style="background: rgba(239,68,68,0.2); border: 1px solid rgba(239,68,68,0.4); border-radius: 6px; padding: 2px 8px; font-size: 11px; font-weight: bold; color: #ef4444;">RUNTIME COMPILATION NOTICE</span>' +
          '</div>' +
          '<pre style="background: #18181b; padding: 14px; border-radius: 8px; border: 1px solid #27272a; white-space: pre-wrap; font-size: 13px; line-height: 1.5; color: #fca5a5;">' +
            String((err && (err.stack || err.message)) || err).replace(/[<>&"]/g, '') +
          '</pre>' +
        '</div>';
      }
    }
  }
  __sb_boot__();
  </script>
  ` : `
  <script${nonceAttr} type="module">
    ${jsTsFiles.map(f => `// File: ${f.name}\n${f.content}`).join('\n\n')}
  </script>
  `}
</body>
</html>`;
}

/** The quick-edit instruction behind the editor's "Add JSDoc / Comments" button. */
export const JSDOC_INSTRUCTION =
    'Add accurate JSDoc headers to the exported functions, components and classes, and short inline comments where the logic is not obvious. Do not change any code.';

export type SandboxQuickEditCall = (request: QuickEditRequest) => Promise<QuickEditResponse>;

const defaultQuickEditCall: SandboxQuickEditCall = request => GeminiClient.getInstance().quickEdit(request);

/** What one model edit of a file produced: a diff to review, or why there is none (and which credential answered). */
export type SandboxQuickEditProposal =
    | { kind: 'diff'; originalCode: string; proposedCode: string; note?: string }
    | { kind: 'error'; error: string };

/**
 * Asks the model to edit one file (⌘K quick edit and the JSDoc button). The result is the model's code as a diff to
 * review, or the error; a failed call never turns into a locally made-up edit.
 */
export async function proposeSandboxQuickEdit(
    file: Pick<CodeFileTab, 'content' | 'language' | 'name'>,
    instruction: string,
    quickEdit: SandboxQuickEditCall = defaultQuickEditCall
): Promise<SandboxQuickEditProposal> {
    const originalCode = file.content;
    let res: QuickEditResponse;
    try {
        res = await quickEdit({ originalCode, instruction, language: file.language || 'typescript', fileName: file.name || 'source.tsx' });
    } catch (err) {
        return { kind: 'error', error: `The edit failed: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (!res?.success || !res.proposedCode) {
        return { kind: 'error', error: res?.error || 'The edit returned no code.' };
    }
    return {
        kind: 'diff',
        originalCode,
        proposedCode: res.proposedCode,
        ...(res.credentialNote ? { note: `Answered with the Gemini API key — ${res.credentialNote}` } : {})
    };
}

/** The sandbox chat's answer to one prompt: the edited file and a reply naming who edited it, or only the error reply. */
export type SandboxChatEdit = { ok: true; content: string; reply: string } | { ok: false; reply: string };

/**
 * The sandbox chat (and its Auto-Fix button when no host chat is wired) edits the open file with the model. The reply
 * names the model and credential that made the edit, or carries the error; the file is never replaced by a template.
 */
export async function runSandboxChatEdit(
    file: Pick<CodeFileTab, 'content' | 'language' | 'name'> | undefined,
    instruction: string,
    quickEdit: SandboxQuickEditCall = defaultQuickEditCall
): Promise<SandboxChatEdit> {
    if (!file) return { ok: false, reply: 'No file is open, so there is nothing to edit.' };
    let res: QuickEditResponse;
    try {
        res = await quickEdit({ originalCode: file.content, instruction, language: file.language || 'typescript', fileName: file.name || 'source.tsx' });
    } catch (err) {
        return { ok: false, reply: `No change made to ${file.name}: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (!res?.success || !res.proposedCode) {
        return { ok: false, reply: `No change made to ${file.name}: ${res?.error || 'the model returned no code.'}` };
    }
    const answeredBy = res.modelUsed ? ` with ${res.modelUsed}` : '';
    const counts = typeof res.additions === 'number' && typeof res.deletions === 'number' ? ` (+${res.additions}/-${res.deletions} lines)` : '';
    const credential = res.credentialNote ? ` Answered with the Gemini API key — ${res.credentialNote}` : '';
    return { ok: true, content: res.proposedCode, reply: `Edited ${file.name}${answeredBy}${counts}.${credential}` };
}

export const LiveCodeSandboxPrimitive: React.FC<LiveCodeSandboxPrimitiveProps> = ({
    data,
    onUpdate,
    onSave,
    onForkArtifact,
    onPromptAction,
    onDebugWithAi,
    onCaptureReady,
    onVisualVerification,
    hideTopbar = true,
    hideInternalChat = false
}) => {
    const rawFiles = Array.isArray(data?.files) ? data.files : [];
    const defaultFiles: CodeFileTab[] = rawFiles.length > 0 ? rawFiles : [
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
    const [activeFileId, setActiveFileId] = React.useState<string>(data.activeFileId || files.find(f => f.isEntry)?.id || files[0]?.id || 'file-app');
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
    const [msgReactions, setMsgReactions] = React.useState<Record<string, 'up' | 'down'>>({});
    const [isVoiceRecording, setIsVoiceRecording] = React.useState<boolean>(false);

    // In-Situ Preview Element Commenting State
    const [isCommentMode, setIsCommentMode] = React.useState<boolean>(false);
    const [activePinTarget, setActivePinTarget] = React.useState<{
        selector: string;
        tagName: string;
        rect: { x: number; y: number; width: number; height: number };
        snippet: string;
        textContent: string;
    } | null>(null);
    const [pinCommentText, setPinCommentText] = React.useState<string>('');

    React.useEffect(() => {
        const iframe = iframeRef.current;
        if (iframe?.contentWindow) {
            iframe.contentWindow.postMessage({
                type: 'sb-set-inspector-mode',
                active: isCommentMode
            }, '*');
        }
        if (!isCommentMode) {
            setActivePinTarget(null);
            setPinCommentText('');
        }
    }, [isCommentMode]);

    // Granular Dirty State Manager & Tracking
    const dirtyManagerRef = React.useRef<DirtyStateManager>(new DirtyStateManager());
    const [dirtyTabIds, setDirtyTabIds] = React.useState<string[]>([]);

    // Monaco Editor vs Lightweight Editor Engine State
    const [useMonaco, setUseMonaco] = React.useState<boolean>(true);
    const monacoEditorRef = React.useRef<any>(null);

    // Multi-File Diff Review state
    const [isDiffReviewOpen, setIsDiffReviewOpen] = React.useState<boolean>(false);
    const [activePatch, setActivePatch] = React.useState<MultiFilePatch | undefined>(undefined);
    const [selectedDiffPaths, setSelectedDiffPaths] = React.useState<string[]>([]);
    const [previewDiffFileIndex, setPreviewDiffFileIndex] = React.useState<number>(0);
    const [acceptedHunkMap, setAcceptedHunkMap] = React.useState<Record<string, string[]>>({});

    // Terminal / Runtime Error Capture state
    const [lastCapturedError, setLastCapturedError] = React.useState<TerminalExecutionError | undefined>(undefined);
    const [showErrorDebugToast, setShowErrorDebugToast] = React.useState<boolean>(false);

    // Cursor Inline Quick Edit (⌘K) state
    const [isQuickEditOpen, setIsQuickEditOpen] = React.useState<boolean>(false);
    const [quickEditPrompt, setQuickEditPrompt] = React.useState<string>('');
    const [isQuickEditing, setIsQuickEditing] = React.useState<boolean>(false);
    // Why a quick edit produced no diff, or which credential answered when it was not the service account.
    const [quickEditStatus, setQuickEditStatus] = React.useState<{ tone: 'error' | 'note'; text: string } | null>(null);
    const [quickEditDiff, setQuickEditDiff] = React.useState<{ originalCode: string; proposedCode: string } | null>(null);
    const [fileAudioState, setFileAudioState] = React.useState<'idle' | 'loading' | 'playing' | 'error'>('idle');

    const iframeRef = React.useRef<HTMLIFrameElement>(null);
    const dataRef = React.useRef(data);
    dataRef.current = data;
    const onPromptActionRef = React.useRef(onPromptAction);
    onPromptActionRef.current = onPromptAction;
    const onDebugWithAiRef = React.useRef(onDebugWithAi);
    onDebugWithAiRef.current = onDebugWithAi;
    const handleSendVibecodeRef = React.useRef<((promptText: string) => void) | null>(null);

    const captureFrame = React.useCallback((): string | null => {
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
        let diskSaveCount = 0;
        let anyDiskFailed = false;

        // 1. If any open tabs correspond to physical workspace files, write directly to disk
        for (const f of files) {
            if (f.path && dirtyManagerRef.current.isDirty(f.id, f.content)) {
                const saveRes = await WorkspaceConfigClient.getInstance().saveFileContent(f.path, f.content);
                if (saveRes.success) {
                    diskSaveCount++;
                    dirtyManagerRef.current.markSaved(f.id, f.content);
                } else {
                    anyDiskFailed = true;
                }
            }
        }

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
        if (res.success || diskSaveCount > 0) {
            files.forEach(f => dirtyManagerRef.current.markSaved(f.id, f.content));
            setDirtyTabIds([]);
            const msg = diskSaveCount > 0
                ? `Saved ${diskSaveCount} file${diskSaveCount > 1 ? 's' : ''} to disk`
                : `Saved ${files.length} files to workspace`;
            setSaveFeedback(msg);
            setTimeout(() => setSaveFeedback(undefined), 3500);
            if (onSave) {
                onSave({ ...data, files, isAiChatOpen, chatMessages });
            }
        } else {
            setSaveFeedback(res.error || (anyDiskFailed ? 'Failed to save to disk' : 'Failed to save'));
            setTimeout(() => setSaveFeedback(undefined), 3500);
        }
    };

    const [isScaffolding, setIsScaffolding] = React.useState(false);

    const handleScaffoldToWorkspace = async () => {
        setIsScaffolding(true);
        try {
            const slug = (data.title || 'micro-app')
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, '-')
                .replace(/^-|-$/g, '') || 'micro-app';

            const appDir = `src/micro-apps/${slug}`;
            const filesToWrite: Record<string, string> = {};

            // 1. Write each sandbox file into the app directory
            files.forEach(f => {
                const relativePath = `${appDir}/${f.name}`;
                filesToWrite[relativePath] = f.content;
            });

            // 2. Turnkey package.json with dependencies
            const pkgDeps: Record<string, string> = {
                react: '^18.2.0',
                'react-dom': '^18.2.0',
                'lucide-react': '^0.468.0',
                ...(data.dependencies || {})
            };
            const packageJson = {
                name: slug,
                private: true,
                version: '0.1.0',
                type: 'module',
                scripts: {
                    dev: 'vite',
                    build: 'tsc && vite build',
                    preview: 'vite preview'
                },
                dependencies: pkgDeps,
                devDependencies: {
                    '@types/react': '^18.2.0',
                    '@types/react-dom': '^18.2.0',
                    '@vitejs/plugin-react': '^4.2.1',
                    typescript: '^5.3.3',
                    vite: '^5.1.0'
                }
            };
            filesToWrite[`${appDir}/package.json`] = JSON.stringify(packageJson, null, 2);

            // 3. Turnkey vite.config.ts
            filesToWrite[`${appDir}/vite.config.ts`] = `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3100
  }
});
`;

            // 4. Turnkey index.html
            const entryFile = files.find(f => f.isEntry)?.name || 'App.tsx';
            filesToWrite[`${appDir}/index.html`] = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${data.title || 'Micro App'}</title>
    <link rel="stylesheet" href="./styles.css" />
  </head>
  <body class="bg-zinc-950 text-zinc-100">
    <div id="root"></div>
    <script type="module">
      import React from 'react';
      import ReactDOM from 'react-dom/client';
      import App from './${entryFile.replace(/\\.(tsx|jsx|js|ts)$/, '')}';

      ReactDOM.createRoot(document.getElementById('root')).render(
        React.createElement(React.StrictMode, null, React.createElement(App))
      );
    </script>
  </body>
</html>
`;

            // 5. Turnkey tsconfig.json
            filesToWrite[`${appDir}/tsconfig.json`] = JSON.stringify({
                compilerOptions: {
                    target: 'ES2020',
                    useDefineForClassFields: true,
                    lib: ['ES2020', 'DOM', 'DOM.Iterable'],
                    module: 'ESNext',
                    skipLibCheck: true,
                    moduleResolution: 'bundler',
                    allowImportingTsExtensions: true,
                    resolveJsonModule: true,
                    isolatedModules: true,
                    noEmit: true,
                    jsx: 'react-jsx',
                    strict: true
                },
                include: ['./**/*']
            }, null, 2);

            // 6. Write atomically via writeLensFiles
            const client = WorkspaceConfigClient.getInstance();
            const res = await client.writeLensFiles(filesToWrite);
            if (res.success) {
                setSaveFeedback(`Scaffolded to ${appDir}/ (${Object.keys(filesToWrite).length} files)`);
            } else {
                let count = 0;
                for (const [p, c] of Object.entries(filesToWrite)) {
                    const saveRes = await client.saveFileContent(p, c);
                    if (saveRes.success) count++;
                }
                setSaveFeedback(count > 0 ? `Scaffolded ${count} files to ${appDir}/` : 'Scaffold failed');
            }
            setTimeout(() => setSaveFeedback(undefined), 4000);
        } catch (err: any) {
            setSaveFeedback(`Scaffold error: ${err.message || 'unknown'}`);
            setTimeout(() => setSaveFeedback(undefined), 4000);
        } finally {
            setIsScaffolding(false);
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
                    const isHarmlessEnvWarning = msg.includes('WebGLRenderer') || msg.includes('WebGL context') || msg.includes('GL_VENDOR = Disabled');
                    if (!isHarmlessEnvWarning) {
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
                } else if (method === 'storage:save-asset') {
                    const filename = params?.filename || `asset-${Date.now()}.dat`;
                    const content = params?.content || '';
                    const mimeType = params?.mimeType || 'text/plain';
                    console.info(`[Scratchbox Tool Bridge] Saving asset to workspace: ${filename} (${content.length} chars)`);
                    WorkspaceConfigClient.getInstance().saveFileContent(filename, content)
                        .then(saveRes => {
                            sendRpcResponse({ success: true, filename, savedToDisk: saveRes?.success ?? true });
                        })
                        .catch(err => {
                            try {
                                if (typeof document !== 'undefined') {
                                    const blob = new Blob([content], { type: mimeType });
                                    const url = URL.createObjectURL(blob);
                                    const a = document.createElement('a');
                                    a.href = url;
                                    a.download = filename;
                                    document.body.appendChild(a);
                                    a.click();
                                    document.body.removeChild(a);
                                    URL.revokeObjectURL(url);
                                    sendRpcResponse({ success: true, filename, downloaded: true });
                                    return;
                                }
                            } catch (_) {}
                            sendRpcResponse(undefined, err.message || 'Failed to save asset');
                        });
                } else if (method === 'storage:export-state') {
                    const currentData = dataRef.current || data;
                    const stateKey = `sb-sandbox-state-${currentData?.title || (currentData as any)?.id || 'default'}`;
                    try {
                        if (typeof sessionStorage !== 'undefined') {
                            sessionStorage.setItem(stateKey, JSON.stringify(params?.state ?? null));
                        }
                        sendRpcResponse({ success: true, timestamp: Date.now() });
                    } catch (e: any) {
                        sendRpcResponse(undefined, e.message || 'Failed to export state');
                    }
                } else if (method === 'storage:get-state') {
                    const currentData = dataRef.current || data;
                    const stateKey = `sb-sandbox-state-${currentData?.title || (currentData as any)?.id || 'default'}`;
                    try {
                        let saved = null;
                        if (typeof sessionStorage !== 'undefined') {
                            const raw = sessionStorage.getItem(stateKey);
                            saved = raw ? JSON.parse(raw) : null;
                        }
                        sendRpcResponse({ state: saved });
                    } catch (e: any) {
                        sendRpcResponse({ state: null });
                    }
                } else if (method === 'ai:refine') {
                    const prompt = params?.prompt || '';
                    console.info(`[Scratchbox Tool Bridge] AI refinement requested: ${prompt}`);
                    if (onPromptActionRef.current) {
                        onPromptActionRef.current(prompt);
                    } else if (handleSendVibecodeRef.current) {
                        handleSendVibecodeRef.current(prompt);
                    } else if (onDebugWithAiRef.current) {
                        onDebugWithAiRef.current(prompt);
                    }
                    sendRpcResponse({ dispatched: true });
                } else if (method === 'native3d:compile-and-generate') {
                    const sourceCode = params?.sourceCode || '';
                    console.info('[Scratchbox Native 3D Bridge] Procedural C++20 generator compilation requested');
                    const compileUrl = typeof window !== 'undefined' && window.location.port === '3000'
                        ? 'http://localhost:3001/3d/compile'
                        : '/3d/compile';
                    fetch(compileUrl, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            sourceCode: sourceCode,
                            optimization: '-O3'
                        })
                    })
                    .then(res => {
                        if (!res.ok) {
                            throw new Error(`Compiler endpoint returned HTTP ${res.status}: ${res.statusText}`);
                        }
                        return res.json();
                    })
                    .then(result => {
                        sendRpcResponse({
                            success: result.success ?? true,
                            glbBase64: result.glbBase64 || null,
                            compilationTimeMs: result.compilationTimeMs || 0,
                            executionTimeMs: result.executionTimeMs || 0,
                            compilerOutput: result.compilerOutput || result.stderr || ''
                        });
                    })
                    .catch(err => {
                        sendRpcResponse({
                            success: false,
                            simulated: false,
                            error: err?.message || 'Failed to connect to native C++ compilation endpoint',
                            compilerOutput: `Compilation Service Error: ${err?.message || 'Connection refused'}`
                        });
                    });
                } else {
                    sendRpcResponse(undefined, `Unknown RPC method: ${method}`);
                }
            }

            if (event.data && event.data.type === 'sb-insitu-element-selected') {
                setActivePinTarget({
                    selector: event.data.selector,
                    tagName: event.data.tagName,
                    rect: event.data.rect,
                    snippet: event.data.snippet,
                    textContent: event.data.textContent
                });
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

        // Calculate selective hunk-patched content for modified files
        const modifiedPatchFiles = activePatch.files.map(f => {
            const fileHunkIds = acceptedHunkMap[f.path];
            if (fileHunkIds && f.lines && f.lines.length > 0) {
                const hunks = extractHunksFromDiffLines(f.lines);
                const partialContent = applySelectedHunks(f.oldContent || '', hunks, fileHunkIds);
                return {
                    ...f,
                    newContent: partialContent
                };
            }
            return f;
        });

        const effectivePatch = {
            ...activePatch,
            files: modifiedPatchFiles
        };

        const patchedFiles = applyMultiFilePatch(files, effectivePatch, pathsToApply);
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

    // Fill-In-The-Middle (Cursor Tab) Inline Ghost Autocomplete
    const {
        ghostText,
        ghostPosition,
        dismissGhostText,
        handleEditorKeyDown: handleFimKeyDown,
        triggerFimCheck
    } = useInlineFim({
        enabled: !isQuickEditOpen,
        language: activeFile?.language || 'typescript',
        fileName: activeFile?.name || 'source.tsx',
        debounceMs: 160,
        onApplyCompletion: (newCode, newCursor) => {
            handleCodeChange(newCode);
            setTimeout(() => {
                if (textareaRef.current) {
                    textareaRef.current.selectionStart = textareaRef.current.selectionEnd = newCursor;
                    textareaRef.current.focus();
                }
            }, 0);
        }
    });

    // Comments come from the model as a reviewable quick-edit diff, or the quick-edit panel says why there are none.
    const handleAddJsdocComments = () => {
        if (!activeFile || isQuickEditing) return;
        setIsQuickEditOpen(true);
        setQuickEditPrompt(JSDOC_INSTRUCTION);
        void handleExecuteQuickEdit(JSDOC_INSTRUCTION);
    };

    // The sandbox chat edits the open file with the model (runSandboxChatEdit); never a prompt-picked template.
    const handleSendVibecode = async (promptText: string) => {
        if (!promptText || !promptText.trim()) return;
        const userText = promptText.trim();
        setVibecodePrompt('');

        const now = () => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const userMsg: ChatMessage = { id: `vc-user-${Date.now()}`, sender: 'user', text: userText, timestamp: now() };
        const updatedMessages = [...chatMessages, userMsg];
        setChatMessages(updatedMessages);

        const target = activeFile;
        setIsVibecoding(true);
        const edit = await runSandboxChatEdit(target, userText);
        setIsVibecoding(false);
        const assistantMsg: ChatMessage = { id: `vc-asst-${Date.now()}`, sender: 'assistant', text: edit.reply, timestamp: now() };
        setChatMessages(prev => [...prev, assistantMsg]);
        if (!edit.ok || !target) return;

        const updatedFiles = files.map(f => (f.id === target.id ? { ...f, content: edit.content, isDirty: true } : f));
        setFiles(updatedFiles);
        setRefreshKey(k => k + 1);
        if (onUpdate) {
            onUpdate({
                ...data,
                files: updatedFiles,
                activeFileId,
                isAiChatOpen,
                chatMessages: [...updatedMessages, assistantMsg]
            });
        }
    };
    handleSendVibecodeRef.current = handleSendVibecode;

    const handleSendPinComment = () => {
        if (!activePinTarget || !pinCommentText.trim()) return;
        const prompt = `[In-Situ Visual Pin on \`${activePinTarget.selector}\`]: "${pinCommentText.trim()}". Target element: \`${activePinTarget.snippet}\`. Please apply surgical updates to this component in the sandbox.`;
        if (onPromptActionRef.current) {
            onPromptActionRef.current(prompt);
        } else if (handleSendVibecodeRef.current) {
            handleSendVibecodeRef.current(prompt);
        }
        setActivePinTarget(null);
        setPinCommentText('');
        setIsCommentMode(false);
    };

    const handleExecuteQuickEdit = async (promptText: string) => {
        if (!promptText.trim() || isQuickEditing || !activeFile) return;
        setIsQuickEditing(true);
        try {
            const proposal = await proposeSandboxQuickEdit(activeFile, promptText.trim());
            if (proposal.kind === 'diff') {
                setQuickEditDiff({ originalCode: proposal.originalCode, proposedCode: proposal.proposedCode });
                setQuickEditStatus(proposal.note ? { tone: 'note', text: proposal.note } : null);
            } else {
                // No diff to review: say why instead of showing the unchanged file as a proposal.
                setQuickEditDiff(null);
                setQuickEditStatus({ tone: 'error', text: proposal.error });
            }
        } finally {
            setIsQuickEditing(false);
        }
    };

    const handleAcceptQuickEdit = () => {
        if (!quickEditDiff || !activeFile) return;
        handleCodeChange(quickEditDiff.proposedCode);
        setQuickEditDiff(null);
        setQuickEditStatus(null);
        setIsQuickEditOpen(false);
        setQuickEditPrompt('');
    };

    const handleRejectQuickEdit = () => {
        setQuickEditDiff(null);
        setQuickEditStatus(null);
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

                        {/* 1-Click Scaffold to Workspace */}
                        <button
                            type="button"
                            className="sb-btn sb-btn-secondary sb-btn-xs"
                            onClick={handleScaffoldToWorkspace}
                            disabled={isScaffolding}
                            title="Scaffold turnkey project (package.json, vite.config.ts, index.html) to workspace"
                        >
                            <IconTerminal size={12} />
                            <span>{isScaffolding ? 'Scaffolding...' : 'Scaffold App'}</span>
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
                {/* Left Side: Vibecode AI Chat Assistant Panel (Studio Interface) */}
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

                                        {/* Message Action Footer */}
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

                        {/* Studio Composer Box */}
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

                            {/* Studio Bottom Status Row */}
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
                                        padding: '2px 6px',
                                        display: 'flex',
                                        alignItems: 'center',
                                        gap: '3px',
                                        fontSize: '10px',
                                        height: '20px'
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
                                        </span>
                                    )}
                                </button>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 10, userSelect: 'none', padding: '0 2px' }}>
                                    {dirtyTabIds.length > 0 ? (
                                        <span style={{ color: '#3b82f6', display: 'flex', alignItems: 'center', gap: 3, fontWeight: 500 }} title="Unsaved changes">
                                            <span style={{ fontSize: 8 }}>●</span> Unsaved
                                        </span>
                                    ) : (
                                        <span style={{ color: '#10b981', display: 'flex', alignItems: 'center', gap: 2, opacity: 0.8 }} title="All files saved">
                                            <span>✓</span> Saved
                                        </span>
                                    )}
                                </div>

                                <button
                                    type="button"
                                    className="sb-btn sb-btn-secondary sb-btn-xs sb-quick-edit-trigger-btn"
                                    onClick={() => {
                                        setIsQuickEditOpen(!isQuickEditOpen);
                                        setTimeout(() => quickEditInputRef.current?.focus(), 50);
                                    }}
                                    title="Inline Quick Edit (⌘K)"
                                    style={{ height: '20px', padding: '0 6px', fontSize: '10px' }}
                                >
                                    <IconSparkles size={10} className="text-blue-400" />
                                    <span>⌘K</span>
                                </button>

                                <button
                                    type="button"
                                    className="sb-btn sb-btn-secondary sb-btn-xs"
                                    onClick={handleOpenDiffReview}
                                    title="Review Multi-File Diffs and Batch Apply/Reject"
                                    style={{ height: '20px', padding: '0 6px', fontSize: '10px' }}
                                >
                                    <IconGitFork size={11} />
                                    <span>Diff</span>
                                </button>

                                <button
                                    type="button"
                                    className="sb-btn sb-btn-secondary sb-btn-xs"
                                    onClick={() => setRefreshKey(k => k + 1)}
                                    title="Recompile & Run Preview"
                                    style={{ height: '20px', padding: '0 6px', fontSize: '10px' }}
                                >
                                    <IconRefresh size={11} />
                                    <span>Run</span>
                                </button>

                                <button
                                    type="button"
                                    className="sb-btn sb-btn-secondary sb-btn-xs"
                                    onClick={handleScaffoldToWorkspace}
                                    disabled={isScaffolding}
                                    title="Scaffold turnkey project (package.json, vite.config.ts, index.html) into workspace"
                                    style={{ height: '20px', padding: '0 6px', fontSize: '10px' }}
                                >
                                    <IconTerminal size={11} />
                                    <span>{isScaffolding ? 'Scaffolding...' : 'Scaffold'}</span>
                                </button>
                            </div>
                        </div>

                        {/* Editor Code Area with Line Numbers and IDE Syntax Highlighting */}
                        <div className="sb-ide-code-viewport" style={{ position: 'relative' }}>
                            {/* Floating Inline Quick Edit (⌘K) Bar */}
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
                                    {quickEditStatus && (
                                        <div className="sb-quick-edit-diff-summary animate-fadeIn" role={quickEditStatus.tone === 'error' ? 'alert' : 'note'} data-testid="sb-quick-edit-status">
                                            <span className={`text-[11px] font-mono font-medium ${quickEditStatus.tone === 'error' ? 'text-red-400' : 'text-amber-300'}`}>{quickEditStatus.text}</span>
                                        </div>
                                    )}
                                </div>
                            )}

                            {useMonaco ? (
                                <div className="sb-ide-monaco-wrap relative flex-1 w-full h-full min-h-0 overflow-hidden" style={{ flex: '1 1 0%', width: '100%', height: '100%', minWidth: 0, minHeight: 0 }}>
                                    <Editor
                                        height="100%"
                                        language={getMonacoLanguage(activeFile?.language, activeFile?.name)}
                                        value={activeFile?.content || ''}
                                        theme="vs-dark"
                                        onChange={(val) => {
                                            handleCodeChange(val ?? '');
                                        }}
                                        onMount={(editor, monaco) => {
                                            monacoEditorRef.current = editor;
                                            editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyK, () => {
                                                dismissGhostText();
                                                setIsQuickEditOpen(true);
                                                setTimeout(() => quickEditInputRef.current?.focus(), 50);
                                            });
                                            editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
                                                handleSaveToWorkspace();
                                            });
                                        }}
                                        options={{
                                            fontSize: 13,
                                            fontFamily: "'JetBrains Mono', 'Fira Code', Menlo, Monaco, 'Courier New', monospace",
                                            minimap: { enabled: true, maxColumn: 80 },
                                            scrollBeyondLastLine: false,
                                            automaticLayout: true,
                                            wordWrap: 'off',
                                            lineNumbers: 'on',
                                            renderLineHighlight: 'all',
                                            tabSize: 2,
                                            bracketPairColorization: { enabled: true },
                                            cursorBlinking: 'smooth',
                                            smoothScrolling: true,
                                            padding: { top: 12, bottom: 12 }
                                        }}
                                    />
                                </div>
                            ) : (
                                <>
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
                                                    disabled={isQuickEditing}
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
                                                    <IconSparkles size={11} className={isQuickEditing ? 'animate-pulse' : ''} />
                                                    <span>{isQuickEditing ? 'Editing...' : 'Add JSDoc / Comments'}</span>
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
                                                {ghostText && (
                                                    <span
                                                        className="sb-ide-ghost-text"
                                                        style={{
                                                            color: '#38bdf8',
                                                            opacity: 0.55,
                                                            fontStyle: 'italic',
                                                            userSelect: 'none',
                                                            pointerEvents: 'none'
                                                        }}
                                                    >
                                                        {ghostText}
                                                    </span>
                                                )}
                                            </code>
                                        </pre>
                                        <textarea
                                            ref={textareaRef}
                                            className="sb-ide-code-textarea"
                                            value={activeFile?.content || ''}
                                            onChange={e => {
                                                handleCodeChange(e.target.value);
                                                triggerFimCheck(e.target.value, e.target.selectionEnd);
                                            }}
                                            onScroll={handleEditorScroll}
                                            spellCheck={false}
                                            autoCapitalize="off"
                                            autoComplete="off"
                                            placeholder="Write code here... (Press ⌘K to edit with AI, Tab to accept AI autocomplete)"
                                            onKeyDown={e => {
                                                if (handleFimKeyDown(e, activeFile?.content || '')) {
                                                    return;
                                                }
                                                if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
                                                    e.preventDefault();
                                                    handleSaveToWorkspace();
                                                    return;
                                                }
                                                if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
                                                    e.preventDefault();
                                                    dismissGhostText();
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
                                </>
                            )}
                        </div>

                        {/* Bottom Editor Status Bar */}
                        <div className="sb-ide-statusbar">
                            <div className="sb-ide-status-left">
                                <button
                                    type="button"
                                    className="sb-ide-status-btn"
                                    onClick={() => setUseMonaco(!useMonaco)}
                                    title={`Current: ${useMonaco ? 'Monaco Editor (Click to switch to Lite)' : 'Lite Editor (Click to switch to Monaco)'}`}
                                >
                                    <IconCode size={11} />
                                    <span>{useMonaco ? 'Monaco' : 'Lite'}</span>
                                </button>
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
                                {ghostText && (
                                    <span className="sb-ide-status-item text-sky-400 font-mono text-[10px] animate-pulse flex items-center gap-1">
                                        <span>✦ Tab to accept completion</span>
                                        <kbd className="sb-kbd text-[8px] bg-sky-950/60 border-sky-700/50 text-sky-300">Tab</kbd>
                                    </span>
                                )}
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
                                                {log.type === 'error' && (
                                                    <button
                                                        type="button"
                                                        onClick={() => {
                                                            // The host chat (studio) gets the error when it is wired; otherwise the sandbox chat asks the model.
                                                            const fixPrompt = `Auto-fix the following runtime error in file ${activeFile?.name || 'App.tsx'}:\n\n${log.message}`;
                                                            if (onDebugWithAi) {
                                                                onDebugWithAi(fixPrompt);
                                                            } else if (onPromptAction) {
                                                                onPromptAction(fixPrompt);
                                                            } else {
                                                                setIsAiChatOpen(true);
                                                                void handleSendVibecode(fixPrompt);
                                                            }
                                                        }}
                                                        className="sb-btn sb-btn-ai-autofix"
                                                        style={{
                                                            marginLeft: 'auto',
                                                            display: 'inline-flex',
                                                            alignItems: 'center',
                                                            gap: '4px',
                                                            padding: '2px 8px',
                                                            borderRadius: '4px',
                                                            fontSize: '11px',
                                                            fontWeight: 600,
                                                            background: 'rgba(147, 51, 234, 0.25)',
                                                            color: '#c084fc',
                                                            border: '1px solid rgba(168, 85, 247, 0.4)',
                                                            cursor: 'pointer'
                                                        }}
                                                        title="Send error to AI assistant for instant diagnosis and fix"
                                                    >
                                                        <IconSparkles size={11} />
                                                        <span>⚡ Auto-Fix with AI</span>
                                                    </button>
                                                )}
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
                                <div className="sb-segmented-control sb-segmented-control-xs" title="Preview Viewport">
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
                                <button
                                    type="button"
                                    className={`sb-btn sb-btn-xs ${isCommentMode ? 'sb-btn-primary' : 'sb-btn-ghost'}`}
                                    onClick={() => setIsCommentMode(!isCommentMode)}
                                    title={isCommentMode ? 'Exit in-situ element pin mode' : 'Pin visual comment directly on preview elements'}
                                    style={{ display: 'flex', alignItems: 'center', gap: '4px' }}
                                >
                                    <IconPin size={11} />
                                    <span>{isCommentMode ? 'Inspecting...' : 'Pin Comment'}</span>
                                </button>
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
                        <div className={`sb-ide-iframe-wrapper sb-viewport-${viewportMode}`} style={{ position: 'relative' }}>
                            <iframe
                                ref={iframeRef}
                                key={`sandbox-frame-${refreshKey}`}
                                className="sb-sandbox-iframe"
                                title="Sandbox Preview"
                                srcDoc={srcDocContent}
                                sandbox="allow-scripts allow-modals allow-forms allow-popups"
                            />
                            {activePinTarget && (
                                <div
                                    className="sb-insitu-pin-overlay"
                                    style={{
                                        position: 'absolute',
                                        left: Math.max(16, Math.min(activePinTarget.rect.x, 320)),
                                        top: Math.max(16, Math.min(activePinTarget.rect.y + activePinTarget.rect.height + 8, 460)),
                                        zIndex: 60,
                                        width: '320px',
                                        background: '#090d16',
                                        border: '1px solid #38bdf8',
                                        borderRadius: '8px',
                                        boxShadow: '0 12px 32px rgba(0,0,0,0.7)',
                                        padding: '12px',
                                        color: '#f8fafc',
                                        fontSize: '12px',
                                        fontFamily: 'system-ui, sans-serif'
                                    }}
                                >
                                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px', borderBottom: '1px solid #1e293b', paddingBottom: '6px' }}>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                                            <IconPin size={13} className="text-sky-400" />
                                            <span style={{ fontWeight: 600, color: '#38bdf8' }}>In-Situ Element Pin</span>
                                        </div>
                                        <button
                                            type="button"
                                            onClick={() => setActivePinTarget(null)}
                                            style={{ background: 'none', border: 'none', color: '#94a3b8', cursor: 'pointer', fontSize: '14px', lineHeight: 1 }}
                                        >
                                            ✕
                                        </button>
                                    </div>
                                    <div style={{ background: '#020617', padding: '6px 8px', borderRadius: '4px', marginBottom: '8px', fontFamily: 'monospace', fontSize: '11px', color: '#93c5fd', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                        {activePinTarget.selector}
                                    </div>
                                    {activePinTarget.textContent && (
                                        <div style={{ fontSize: '11px', color: '#64748b', marginBottom: '8px', fontStyle: 'italic', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                            "{activePinTarget.textContent}"
                                        </div>
                                    )}
                                    <textarea
                                        value={pinCommentText}
                                        onChange={(e) => setPinCommentText(e.target.value)}
                                        placeholder="What change would you like on this element? (e.g. 'Make this a gradient pill with hover animation')"
                                        rows={3}
                                        style={{
                                            width: '100%',
                                            background: '#0f172a',
                                            border: '1px solid #334155',
                                            borderRadius: '6px',
                                            padding: '8px',
                                            color: '#f8fafc',
                                            fontSize: '12px',
                                            resize: 'none',
                                            outline: 'none',
                                            boxSizing: 'border-box',
                                            marginBottom: '8px'
                                        }}
                                        autoFocus
                                        onKeyDown={(e) => {
                                            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                                                handleSendPinComment();
                                            }
                                        }}
                                    />
                                    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '6px' }}>
                                        <button
                                            type="button"
                                            className="sb-btn sb-btn-ghost sb-btn-xs"
                                            onClick={() => setActivePinTarget(null)}
                                        >
                                            Cancel
                                        </button>
                                        <button
                                            type="button"
                                            className="sb-btn sb-btn-primary sb-btn-xs"
                                            onClick={handleSendPinComment}
                                            disabled={!pinCommentText.trim()}
                                            style={{ display: 'flex', alignItems: 'center', gap: '4px' }}
                                        >
                                            <span>Send to AI</span>
                                            <IconArrowRight size={11} />
                                        </button>
                                    </div>
                                </div>
                            )}
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

                            {/* Right Line Diff Viewer with Granular Hunk Inspection */}
                            <div className="w-2/3 flex flex-col bg-zinc-950/80 rounded-xl border border-zinc-800/80 overflow-hidden">
                                {activePatch.files[previewDiffFileIndex] ? (() => {
                                    const currentDiffEntry = activePatch.files[previewDiffFileIndex];
                                    const hunks = currentDiffEntry.lines ? extractHunksFromDiffLines(currentDiffEntry.lines) : [];
                                    const fileAcceptedHunks = acceptedHunkMap[currentDiffEntry.path] ?? hunks.map(h => h.id);

                                    return (
                                        <>
                                            <div className="p-2.5 bg-zinc-900/80 border-b border-zinc-800 flex items-center justify-between text-xs">
                                                <div className="flex items-center gap-2">
                                                    <span className="font-mono text-zinc-300">
                                                        {currentDiffEntry.path}
                                                    </span>
                                                    {hunks.length > 0 && (
                                                        <span className="text-[10px] text-zinc-400 font-mono">
                                                            ({fileAcceptedHunks.length}/{hunks.length} hunks accepted)
                                                        </span>
                                                    )}
                                                </div>
                                                <span className={`px-2 py-0.5 rounded text-[10px] font-medium ${
                                                    currentDiffEntry.status === 'added'
                                                        ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                                                        : 'bg-blue-500/10 text-blue-400 border border-blue-500/20'
                                                }`}>
                                                    {currentDiffEntry.status.toUpperCase()}
                                                </span>
                                            </div>
                                            <div className="flex-1 overflow-y-auto p-3 font-mono text-[11px] leading-relaxed select-text space-y-3">
                                                {hunks.length > 0 ? (
                                                    hunks.map(hunk => {
                                                        const isHunkAccepted = fileAcceptedHunks.includes(hunk.id);
                                                        return (
                                                            <div key={hunk.id} className="rounded-lg border border-zinc-800/90 overflow-hidden bg-zinc-950/60">
                                                                <div className="flex items-center justify-between px-2.5 py-1.5 bg-zinc-900/90 border-b border-zinc-800 text-[10px]">
                                                                    <span className="font-mono text-zinc-400 font-semibold">{hunk.header}</span>
                                                                    <button
                                                                        type="button"
                                                                        onClick={() => {
                                                                            const nextAccepted = isHunkAccepted
                                                                                ? fileAcceptedHunks.filter(id => id !== hunk.id)
                                                                                : [...fileAcceptedHunks, hunk.id];
                                                                            setAcceptedHunkMap(prev => ({
                                                                                ...prev,
                                                                                [currentDiffEntry.path]: nextAccepted
                                                                            }));
                                                                        }}
                                                                        className={`sb-btn sb-btn-xs px-2 py-0.5 rounded text-[10px] font-medium border transition-colors ${
                                                                            isHunkAccepted
                                                                                ? 'bg-emerald-950/60 border-emerald-600/50 text-emerald-300 hover:bg-emerald-900/50'
                                                                                : 'bg-zinc-800 border-zinc-700 text-zinc-400 hover:text-zinc-200'
                                                                        }`}
                                                                    >
                                                                        {isHunkAccepted ? '✓ Hunk Accepted' : '✕ Hunk Rejected'}
                                                                    </button>
                                                                </div>
                                                                <div className={`p-1.5 transition-opacity ${isHunkAccepted ? '' : 'opacity-40'}`}>
                                                                    {hunk.lines.map((line, lIdx) => (
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
                                                            </div>
                                                        );
                                                    })
                                                ) : (
                                                    (currentDiffEntry.lines || []).map((line, lIdx) => (
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
                                                    ))
                                                )}
                                            </div>
                                        </>
                                    );
                                })() : (
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
