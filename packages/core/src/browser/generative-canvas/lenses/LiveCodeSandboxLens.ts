/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import {
    CodebaseLens,
    LensContext,
    LensProjectionResult,
    LensUnprojectionResult,
    computeMultiFileHash
} from '../../../common/codebase-lens-protocol';
import {
    CodeFileTab,
    LiveCodeSandboxData,
    PrimitiveType,
    SandboxLanguage
} from '../canvas-types';

function detectLanguage(filePath: string): SandboxLanguage {
    const ext = filePath.split('.').pop()?.toLowerCase();
    switch (ext) {
        case 'ts':
        case 'tsx':
            return 'typescript';
        case 'js':
        case 'jsx':
            return 'javascript';
        case 'css':
            return 'css';
        case 'html':
        case 'htm':
            return 'html';
        case 'json':
            return 'json';
        case 'py':
            return 'python';
        case 'md':
            return 'markdown';
        case 'yaml':
        case 'yml':
            return 'yaml';
        default:
            return 'javascript';
    }
}

function extractBaseName(filePath: string): string {
    return filePath.split('/').pop() || filePath;
}

export class LiveCodeSandboxLens implements CodebaseLens<LiveCodeSandboxData> {
    readonly primitiveType: PrimitiveType = 'live-code-sandbox';

    canHandle(filePathOrFiles: string | Record<string, string>): boolean {
        if (typeof filePathOrFiles === 'string') {
            const ext = filePathOrFiles.split('.').pop()?.toLowerCase();
            return ['ts', 'tsx', 'js', 'jsx', 'html', 'css', 'json', 'py', 'wasm'].includes(ext || '');
        }
        return Object.keys(filePathOrFiles).some(path => this.canHandle(path));
    }

    project(
        sourceContent: Record<string, string> | string,
        context?: LensContext
    ): LensProjectionResult<LiveCodeSandboxData> {
        const fileMap: Record<string, string> = typeof sourceContent === 'string'
            ? { 'src/index.tsx': sourceContent }
            : sourceContent;

        const filePaths = Object.keys(fileMap);
        const tabs: CodeFileTab[] = [];

        for (let i = 0; i < filePaths.length; i++) {
            const path = filePaths[i];
            const content = fileMap[path];
            const name = extractBaseName(path);
            const language = detectLanguage(path);

            const isEntry = i === 0 || name.startsWith('index.') || name.startsWith('App.') || (!path.includes('test') && !path.includes('README'));

            tabs.push({
                id: `tab-${path.replace(/[^a-zA-Z0-9_-]/g, '_')}`,
                name,
                path,
                language,
                content,
                isEntry,
                isDirty: false
            });
        }

        const activeFileId = tabs.find(t => t.isEntry)?.id || tabs[0]?.id;

        const data: LiveCodeSandboxData = {
            title: tabs[0]?.name ? `${tabs[0].name} Playground` : 'Code Sandbox',
            template: 'react',
            viewMode: 'split',
            viewportMode: 'desktop',
            activeFileId,
            files: tabs,
            consoleLogs: []
        };

        return {
            data,
            contentHash: computeMultiFileHash(fileMap)
        };
    }

    unproject(
        primitiveData: LiveCodeSandboxData,
        currentDiskContent: Record<string, string> | string,
        context?: LensContext
    ): LensUnprojectionResult {
        const originalMap: Record<string, string> = typeof currentDiskContent === 'string'
            ? { 'src/index.tsx': currentDiskContent }
            : { ...currentDiskContent };

        const updatedFiles: Record<string, string> = {};
        const modifiedFilePaths: string[] = [];

        // Ingest updated tabs
        for (const tab of primitiveData.files || []) {
            const filePath = tab.path || (tab.name.startsWith('src/') ? tab.name : `src/${tab.name}`);
            updatedFiles[filePath] = tab.content;

            if (originalMap[filePath] !== tab.content) {
                modifiedFilePaths.push(filePath);
            }
        }

        // Retain original files that were not in the tabs if any
        for (const origPath of Object.keys(originalMap)) {
            if (updatedFiles[origPath] === undefined) {
                updatedFiles[origPath] = originalMap[origPath];
            }
        }

        return {
            files: updatedFiles,
            contentHash: computeMultiFileHash(updatedFiles),
            modifiedFilePaths,
            changeSummary: `Unprojected ${modifiedFilePaths.length} modified files in sandbox`
        };
    }
}
