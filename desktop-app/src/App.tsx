/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import React from 'react';
import { GenerativeCanvasStudio, CanvasErrorBoundary } from '@scratchbox/core';
import '@scratchbox/core/style.css';

export function App(): JSX.Element {
    const handleOpenFolder = React.useCallback(async () => {
        try {
            if ('showDirectoryPicker' in window) {
                const dirHandle = await (window as any).showDirectoryPicker();
                if (dirHandle && dirHandle.name) {
                    console.log(`[Scratchbox] Selected directory: ${dirHandle.name}`);
                }
            }
        } catch (e) {
            console.log('[Scratchbox] Open folder cancelled or unsupported', e);
        }
    }, []);

    const handleCreateFile = React.useCallback(() => {
        console.log('[Scratchbox] Create file requested');
    }, []);

    const handleOpenWorkspace = React.useCallback(async () => {
        try {
            if ('showDirectoryPicker' in window) {
                const dirHandle = await (window as any).showDirectoryPicker();
                if (dirHandle && dirHandle.name) {
                    console.log(`[Scratchbox] Selected workspace directory: ${dirHandle.name}`);
                }
            }
        } catch (e) {
            console.log('[Scratchbox] Open workspace cancelled or unsupported', e);
        }
    }, []);

    const handleOpenPreferences = React.useCallback(() => {
        console.log('[Scratchbox] Open preferences requested');
    }, []);

    const handleOpenKeyboardShortcuts = React.useCallback(() => {
        console.log('[Scratchbox] Open keyboard shortcuts requested');
    }, []);

    const handleExecuteCommand = React.useCallback((cmdId: string) => {
        console.log(`[Scratchbox] Execute command: ${cmdId}`);
    }, []);

    return (
        <div className="sb-desktop-app-container" style={{ width: '100vw', height: '100vh', overflow: 'hidden' }}>
            <CanvasErrorBoundary fallbackTitle="Scratchbox Studio Workspace Error">
                <GenerativeCanvasStudio
                    onOpenFolder={handleOpenFolder}
                    onCreateFile={handleCreateFile}
                    onOpenWorkspace={handleOpenWorkspace}
                    onOpenPreferences={handleOpenPreferences}
                    onOpenKeyboardShortcuts={handleOpenKeyboardShortcuts}
                    onExecuteCommand={handleExecuteCommand}
                />
            </CanvasErrorBoundary>
        </div>
    );
}

export default App;
