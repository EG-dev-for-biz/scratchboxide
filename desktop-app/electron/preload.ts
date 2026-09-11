/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('scratchboxDesktop', {
    platform: process.platform,
    versions: {
        node: process.versions.node,
        chrome: process.versions.chrome,
        electron: process.versions.electron
    },
    send: (channel: string, data: any) => {
        ipcRenderer.send(channel, data);
    },
    on: (channel: string, func: (...args: any[]) => void) => {
        ipcRenderer.on(channel, (_event, ...args) => func(...args));
    }
});
