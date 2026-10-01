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
    InteractiveBrowserData,
    PrimitiveType
} from '../canvas-types';

export class InteractiveBrowserLens implements CodebaseLens<InteractiveBrowserData> {
    readonly primitiveType: PrimitiveType = 'interactive-browser';

    canHandle(filePathOrFiles: string | Record<string, string>): boolean {
        if (typeof filePathOrFiles === 'string') {
            const lower = filePathOrFiles.toLowerCase();
            return (
                lower.endsWith('.browser.json') ||
                lower.endsWith('.url') ||
                lower.endsWith('.webloc') ||
                lower.endsWith('.web.json') ||
                lower.startsWith('http://') ||
                lower.startsWith('https://') ||
                lower.startsWith('localhost:') ||
                lower.includes('/browser/') ||
                lower.includes('/sessions/browser/') ||
                lower.startsWith('browser/')
            );
        }
        return Object.keys(filePathOrFiles).some(p => this.canHandle(p));
    }

    project(
        sourceContent: Record<string, string> | string,
        context?: LensContext
    ): LensProjectionResult<InteractiveBrowserData> {
        const filePath = typeof sourceContent === 'object' ? Object.keys(sourceContent)[0] || 'session.browser.json' : 'session.browser.json';
        const rawText = typeof sourceContent === 'string'
            ? sourceContent
            : Object.values(sourceContent)[0] || '';

        const lowerPath = filePath.toLowerCase();
        const trimmed = rawText.trim();

        // 1. Plain URL or Windows Internet Shortcut (.url)
        if (lowerPath.endsWith('.url') || trimmed.startsWith('http://') || trimmed.startsWith('https://') || trimmed.startsWith('[InternetShortcut]')) {
            let extractedUrl = 'http://localhost:3000';
            if (trimmed.startsWith('[InternetShortcut]')) {
                const match = trimmed.match(/URL=(.+)$/m);
                if (match) extractedUrl = match[1].trim();
            } else if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
                extractedUrl = trimmed.split('\n')[0].trim();
            }

            const data: InteractiveBrowserData = {
                url: extractedUrl,
                title: filePath.split('/').pop()?.replace(/\.[^/.]+$/, '') || 'Interactive Web Browser',
                viewportMode: 'desktop',
                history: [extractedUrl],
                historyIndex: 0,
                isLoading: false,
                inspectMode: false,
                consoleLogs: []
            };

            return {
                data,
                contentHash: computeMultiFileHash(rawText)
            };
        }

        // 2. Structured JSON (.browser.json / .web.json)
        try {
            const parsed = JSON.parse(rawText);
            const targetUrl = parsed.url || 'http://localhost:3000';
            const data: InteractiveBrowserData = {
                url: targetUrl,
                title: parsed.title || 'Interactive Web Browser',
                favicon: parsed.favicon,
                viewportMode: parsed.viewportMode || 'desktop',
                history: Array.isArray(parsed.history) && parsed.history.length > 0 ? parsed.history : [targetUrl],
                historyIndex: parsed.historyIndex ?? 0,
                isLoading: Boolean(parsed.isLoading),
                inspectMode: Boolean(parsed.inspectMode),
                consoleLogs: Array.isArray(parsed.consoleLogs) ? parsed.consoleLogs : [],
                networkRequests: Array.isArray(parsed.networkRequests) ? parsed.networkRequests : []
            };

            return {
                data,
                contentHash: computeMultiFileHash(rawText)
            };
        } catch (error) {
            const defaultData: InteractiveBrowserData = {
                url: 'http://localhost:3000',
                title: 'Interactive Web Browser',
                viewportMode: 'desktop',
                history: ['http://localhost:3000'],
                historyIndex: 0,
                isLoading: false,
                inspectMode: false,
                consoleLogs: []
            };

            return {
                data: defaultData,
                contentHash: computeMultiFileHash(rawText || JSON.stringify(defaultData))
            };
        }
    }

    unproject(
        primitiveData: InteractiveBrowserData,
        currentDiskContent: Record<string, string> | string,
        context?: LensContext
    ): LensUnprojectionResult {
        const primaryFileName = typeof currentDiskContent === 'object' && Object.keys(currentDiskContent).length > 0
            ? Object.keys(currentDiskContent)[0]
            : 'session.browser.json';

        const lower = primaryFileName.toLowerCase();
        let serialized: string;

        if (lower.endsWith('.url')) {
            serialized = `[InternetShortcut]\nURL=${primitiveData.url}\n`;
        } else {
            serialized = JSON.stringify({
                url: primitiveData.url,
                title: primitiveData.title,
                viewportMode: primitiveData.viewportMode,
                history: primitiveData.history,
                historyIndex: primitiveData.historyIndex,
                isLoading: primitiveData.isLoading,
                inspectMode: primitiveData.inspectMode,
                consoleLogs: primitiveData.consoleLogs,
                networkRequests: primitiveData.networkRequests
            }, null, 2) + '\n';
        }

        const files: Record<string, string> = {
            [primaryFileName]: serialized
        };

        return {
            files,
            contentHash: computeMultiFileHash(files),
            modifiedFilePaths: [primaryFileName],
            changeSummary: `Unprojected browser session at ${primitiveData.url}`
        };
    }
}
