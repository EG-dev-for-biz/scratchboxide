/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { contextBridge, ipcRenderer } from 'electron';

/** IPC channels the renderer may invoke. Nothing else is reachable. */
const INVOKE_CHANNELS = new Set<string>([
    'scratchbox:open-external',
    'scratchbox:get-launch-token'
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
    invoke
});
