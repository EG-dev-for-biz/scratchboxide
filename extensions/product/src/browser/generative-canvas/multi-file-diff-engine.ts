/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import type {
    CodeFileTab,
    FileDiffEntry,
    FileDiffLine,
    FileDiffStatus,
    MultiFilePatch,
    SandboxLanguage
} from './canvas-types';

export type {
    CodeFileTab,
    FileDiffEntry,
    FileDiffLine,
    FileDiffStatus,
    MultiFilePatch,
    SandboxLanguage
};

/**
 * Calculates a structured line-by-line diff with additions and deletions between two text contents.
 */
export function computeLineDiff(
    oldContent: string = '',
    newContent: string = ''
): { lines: FileDiffLine[]; additions: number; deletions: number } {
    const oldLines = oldContent.split('\n');
    const newLines = newContent.split('\n');

    const lines: FileDiffLine[] = [];
    let additions = 0;
    let deletions = 0;

    // Fast simple line comparison algorithm
    let i = 0;
    let j = 0;

    while (i < oldLines.length || j < newLines.length) {
        if (i < oldLines.length && j < newLines.length) {
            if (oldLines[i] === newLines[j]) {
                lines.push({
                    type: 'context',
                    oldLineNo: i + 1,
                    newLineNo: j + 1,
                    content: oldLines[i]
                });
                i++;
                j++;
            } else {
                // Check ahead for match
                const nextMatchInNew = newLines.indexOf(oldLines[i], j);
                const nextMatchInOld = oldLines.indexOf(newLines[j], i);

                if (nextMatchInNew !== -1 && (nextMatchInOld === -1 || nextMatchInNew - j <= nextMatchInOld - i)) {
                    // Added lines in new
                    while (j < nextMatchInNew) {
                        lines.push({
                            type: 'add',
                            newLineNo: j + 1,
                            content: newLines[j]
                        });
                        additions++;
                        j++;
                    }
                } else if (nextMatchInOld !== -1) {
                    // Deleted lines from old
                    while (i < nextMatchInOld) {
                        lines.push({
                            type: 'del',
                            oldLineNo: i + 1,
                            content: oldLines[i]
                        });
                        deletions++;
                        i++;
                    }
                } else {
                    // Modified / replaced lines
                    lines.push({
                        type: 'del',
                        oldLineNo: i + 1,
                        content: oldLines[i]
                    });
                    deletions++;
                    i++;

                    lines.push({
                        type: 'add',
                        newLineNo: j + 1,
                        content: newLines[j]
                    });
                    additions++;
                    j++;
                }
            }
        } else if (i < oldLines.length) {
            lines.push({
                type: 'del',
                oldLineNo: i + 1,
                content: oldLines[i]
            });
            deletions++;
            i++;
        } else if (j < newLines.length) {
            lines.push({
                type: 'add',
                newLineNo: j + 1,
                content: newLines[j]
            });
            additions++;
            j++;
        }
    }

    return { lines, additions, deletions };
}

/**
 * Generates multi-file diff entries by comparing existing files with newly proposed files.
 */
export function generateMultiFileDiff(
    originalFiles: Array<{ path?: string; name?: string; content: string }>,
    proposedFiles: Array<{ path: string; content: string }>
): FileDiffEntry[] {
    const diffEntries: FileDiffEntry[] = [];
    const origMap = new Map<string, string>();

    for (const f of originalFiles) {
        const key = f.path || f.name || '';
        origMap.set(key, f.content);
    }

    // Process proposed files (Modified or Added)
    for (const prop of proposedFiles) {
        const oldContent = origMap.get(prop.path);
        if (oldContent !== undefined) {
            if (oldContent !== prop.content) {
                const diff = computeLineDiff(oldContent, prop.content);
                diffEntries.push({
                    path: prop.path,
                    oldContent,
                    newContent: prop.content,
                    additions: diff.additions,
                    deletions: diff.deletions,
                    status: 'modified',
                    lines: diff.lines,
                    isAccepted: true
                });
            } else {
                diffEntries.push({
                    path: prop.path,
                    oldContent,
                    newContent: prop.content,
                    additions: 0,
                    deletions: 0,
                    status: 'unchanged',
                    isAccepted: true
                });
            }
        } else {
            // Newly added file
            const diff = computeLineDiff('', prop.content);
            diffEntries.push({
                path: prop.path,
                oldContent: '',
                newContent: prop.content,
                additions: diff.additions,
                deletions: 0,
                status: 'added',
                lines: diff.lines,
                isAccepted: true
            });
        }
    }

    return diffEntries;
}

/**
 * Applies selected diff entries from a patch onto the working file tabs list.
 */
export function applyMultiFilePatch(
    currentFiles: CodeFileTab[],
    patch: MultiFilePatch,
    selectedPaths?: string[]
): CodeFileTab[] {
    const activePaths = selectedPaths
        ? new Set(selectedPaths)
        : new Set(patch.files.filter(f => f.isAccepted !== false).map(f => f.path));

    const updatedFiles: CodeFileTab[] = [...currentFiles];

    for (const diff of patch.files) {
        if (!activePaths.has(diff.path)) {
            continue; // Skipped / Rejected by user
        }

        const existingIndex = updatedFiles.findIndex(
            f => (f.path || f.name) === diff.path || f.name === diff.path
        );

        if (diff.status === 'deleted') {
            if (existingIndex !== -1) {
                updatedFiles.splice(existingIndex, 1);
            }
        } else if (existingIndex !== -1) {
            // Update existing file
            updatedFiles[existingIndex] = {
                ...updatedFiles[existingIndex],
                content: diff.newContent
            };
        } else {
            // Add new file
            const fileName = diff.path.split('/').pop() || diff.path;
            const lang = inferLanguageFromFileName(fileName);
            updatedFiles.push({
                id: `file-patched-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
                name: fileName,
                path: diff.path,
                language: lang,
                content: diff.newContent
            });
        }
    }

    return updatedFiles;
}

function inferLanguageFromFileName(fileName: string): SandboxLanguage {
    if (fileName.endsWith('.tsx') || fileName.endsWith('.jsx')) return 'react';
    if (fileName.endsWith('.ts')) return 'typescript';
    if (fileName.endsWith('.js')) return 'javascript';
    if (fileName.endsWith('.css')) return 'css';
    if (fileName.endsWith('.json')) return 'json';
    if (fileName.endsWith('.html')) return 'html';
    if (fileName.endsWith('.py')) return 'python';
    if (fileName.endsWith('.md')) return 'markdown';
    if (fileName.endsWith('.yaml') || fileName.endsWith('.yml')) return 'yaml';
    return 'javascript';
}
