/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import React from 'react';
import { GenerativeCanvasStudio, CanvasErrorBoundary } from '@scratchbox/core';
import '@scratchbox/core/style.css';

export function App(): JSX.Element {
    const handleOpenFolder = React.useCallback(async () => {
        try {
            const desktop = (window as any).scratchboxDesktop;
            if (desktop?.showOpenDialog) {
                const result = await desktop.showOpenDialog({ properties: ['openDirectory'] });
                if (!result.canceled && result.filePaths?.[0]) {
                    const selectedPath = result.filePaths[0];
                    console.log(`[Scratchbox Desktop] Selected directory: ${selectedPath}`);
                    window.dispatchEvent(new CustomEvent('scratchbox:workspace-changed', { detail: { path: selectedPath } }));
                    return;
                }
            }
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
        window.dispatchEvent(new CustomEvent('scratchbox:create-file-requested'));
    }, []);

    const handleOpenWorkspace = React.useCallback(async () => {
        try {
            const desktop = (window as any).scratchboxDesktop;
            if (desktop?.showOpenDialog) {
                const result = await desktop.showOpenDialog({ properties: ['openDirectory'] });
                if (!result.canceled && result.filePaths?.[0]) {
                    const selectedPath = result.filePaths[0];
                    console.log(`[Scratchbox Desktop] Selected workspace directory: ${selectedPath}`);
                    window.dispatchEvent(new CustomEvent('scratchbox:workspace-changed', { detail: { path: selectedPath } }));
                    return;
                }
            }
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
        window.dispatchEvent(new CustomEvent('scratchbox:open-preferences'));
    }, []);

    const handleOpenKeyboardShortcuts = React.useCallback(() => {
        console.log('[Scratchbox] Open keyboard shortcuts requested');
        window.dispatchEvent(new CustomEvent('scratchbox:open-shortcuts'));
    }, []);

    const handleExecuteCommand = React.useCallback(async (cmdId: string) => {
        console.log(`[Scratchbox] Execute command: ${cmdId}`);
        const desktop = (window as any).scratchboxDesktop;
        if (desktop?.executeCommand) {
            try {
                const result = await desktop.executeCommand(cmdId);
                console.log(`[Scratchbox] Command result:`, result);
                return result;
            } catch (err) {
                console.error(`[Scratchbox] Command execution failed:`, err);
            }
        }
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
