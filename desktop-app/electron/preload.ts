/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { contextBridge, ipcRenderer } from 'electron';

/** IPC channels the renderer may invoke. Nothing else is reachable. */
const INVOKE_CHANNELS = new Set<string>([
    'scratchbox:open-external',
    'scratchbox:get-launch-token',
    'scratchbox:window-minimize',
    'scratchbox:window-maximize',
    'scratchbox:window-close',
    'scratchbox:window-is-maximized',
    'scratchbox:show-open-dialog',
    'scratchbox:show-save-dialog',
    'scratchbox:execute-command',
    'scratchbox:capture-page'
]);

function readArg(prefix: string): string {
    const match = process.argv.find(arg => arg.startsWith(prefix));
    return match ? match.slice(prefix.length) : '';
}

const launchToken = readArg('--scratchbox-token=');
const apiBase = readArg('--scratchbox-api-base=') || 'http://127.0.0.1:3001';

function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    if (!INVOKE_CHANNELS.has(channel)) {
        return Promise.reject(new Error(`IPC channel "${channel}" is not allowed`));
    }
    return ipcRenderer.invoke(channel, ...args);
}

// Launch credentials for the API client (see packages/core/src/common/api-client-config.ts).
contextBridge.exposeInMainWorld('scratchbox', {
    launchToken,
    apiBase
});

contextBridge.exposeInMainWorld('scratchboxDesktop', {
    platform: process.platform,
    versions: {
        node: process.versions.node,
        chrome: process.versions.chrome,
        electron: process.versions.electron
    },
    openExternal: (url: string) => invoke('scratchbox:open-external', url),
    getLaunchToken: () => invoke('scratchbox:get-launch-token'),
    minimize: () => invoke('scratchbox:window-minimize'),
    maximize: () => invoke('scratchbox:window-maximize'),
    close: () => invoke('scratchbox:window-close'),
    isMaximized: () => invoke('scratchbox:window-is-maximized'),
    showOpenDialog: (options?: unknown) => invoke('scratchbox:show-open-dialog', options),
    showSaveDialog: (options?: unknown) => invoke('scratchbox:show-save-dialog', options),
    executeCommand: (command: string, cwd?: string) => invoke('scratchbox:execute-command', command, cwd),
    /** PNG data URL of the window's pixels in rect (CSS pixels of the page), iframes included. */
    capturePage: (rect: { x: number; y: number; width: number; height: number }) => invoke('scratchbox:capture-page', rect),
    invoke
});
