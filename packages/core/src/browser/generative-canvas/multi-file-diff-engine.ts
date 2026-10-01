/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
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
 * Calculates a structured line-by-line diff with additions and deletions between two text contents
 * using the optimal Myers Diff Algorithm (shortest edit script).
 */
export function computeLineDiff(
    oldContent: string = '',
    newContent: string = ''
): { lines: FileDiffLine[]; additions: number; deletions: number } {
    const oldLines = oldContent.split('\n');
    const newLines = newContent.split('\n');

    const N = oldLines.length;
    const M = newLines.length;

    // Fast-path identical contents
    if (oldContent === newContent) {
        return {
            lines: oldLines.map((content, idx) => ({
                type: 'context',
                oldLineNo: idx + 1,
                newLineNo: idx + 1,
                content
            })),
            additions: 0,
            deletions: 0
        };
    }

    // Fast-path: completely empty old or new
    if (N === 1 && oldLines[0] === '' && oldContent === '') {
        return {
            lines: newLines.map((content, idx) => ({
                type: 'add',
                newLineNo: idx + 1,
                content
            })),
            additions: M,
            deletions: 0
        };
    }
    if (M === 1 && newLines[0] === '' && newContent === '') {
        return {
            lines: oldLines.map((content, idx) => ({
                type: 'del',
                oldLineNo: idx + 1,
                content
            })),
            additions: 0,
            deletions: N
        };
    }

    // Myers Diff: computes shortest edit script in O(ND)
    const max = N + M;
    const vOffset = max;
    const v = new Int32Array(2 * max + 1);
    const trace: Int32Array[] = [];

    v[vOffset + 1] = 0;

    let foundD = -1;
    for (let d = 0; d <= max; d++) {
        trace.push(new Int32Array(v));
        for (let k = -d; k <= d; k += 2) {
            let x: number;
            if (k === -d || (k !== d && v[vOffset + k - 1] < v[vOffset + k + 1])) {
                x = v[vOffset + k + 1];
            } else {
                x = v[vOffset + k - 1] + 1;
            }
            let y = x - k;
            while (x < N && y < M && oldLines[x] === newLines[y]) {
                x++;
                y++;
            }
            v[vOffset + k] = x;
            if (x >= N && y >= M) {
                foundD = d;
                break;
            }
        }
        if (foundD !== -1) break;
    }

    // Backtrack to assemble minimal edit script
    let x = N;
    let y = M;
    type EditOp = { type: 'context' | 'add' | 'del'; x: number; y: number };
    const script: EditOp[] = [];

    for (let d = (foundD !== -1 ? foundD : trace.length - 1); d > 0; d--) {
        const vPrev = trace[d];
        const k = x - y;
        let prevK: number;
        if (k === -d || (k !== d && vPrev[vOffset + k - 1] < vPrev[vOffset + k + 1])) {
            prevK = k + 1;
        } else {
            prevK = k - 1;
        }
        const prevX = vPrev[vOffset + prevK];
        const prevY = prevX - prevK;

        while (x > prevX && y > prevY) {
            script.push({ type: 'context', x: x - 1, y: y - 1 });
            x--;
            y--;
        }

        if (d > 0) {
            if (x === prevX) {
                script.push({ type: 'add', x: prevX, y: y - 1 });
                y--;
            } else {
                script.push({ type: 'del', x: x - 1, y: prevY });
                x--;
            }
        }
    }

    while (x > 0 && y > 0) {
        script.push({ type: 'context', x: x - 1, y: y - 1 });
        x--;
        y--;
    }

    script.reverse();

    const lines: FileDiffLine[] = [];
    let additions = 0;
    let deletions = 0;

    for (const op of script) {
        if (op.type === 'context') {
            lines.push({
                type: 'context',
                oldLineNo: op.x + 1,
                newLineNo: op.y + 1,
                content: oldLines[op.x]
            });
        } else if (op.type === 'add') {
            lines.push({
                type: 'add',
                newLineNo: op.y + 1,
                content: newLines[op.y]
            });
            additions++;
        } else if (op.type === 'del') {
            lines.push({
                type: 'del',
                oldLineNo: op.x + 1,
                content: oldLines[op.x]
            });
            deletions++;
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
    selectedPaths?: string[] | Set<string> | Record<string, boolean>
): CodeFileTab[] {
    let activePaths: Set<string>;
    if (selectedPaths instanceof Set) {
        activePaths = selectedPaths;
    } else if (Array.isArray(selectedPaths)) {
        activePaths = new Set(selectedPaths);
    } else if (selectedPaths && typeof selectedPaths === 'object') {
        activePaths = new Set(Object.keys(selectedPaths).filter(k => Boolean((selectedPaths as Record<string, boolean>)[k])));
    } else {
        activePaths = new Set(patch.files.filter(f => f.isAccepted !== false).map(f => f.path));
    }

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

export interface DiffHunkBlock {
    id: string;
    oldStart: number;
    oldLength: number;
    newStart: number;
    newLength: number;
    header: string;
    lines: FileDiffLine[];
    isAccepted?: boolean;
}

/**
 * Groups raw line-diff entries into semantic hunks with context windows.
 */
export function extractHunksFromDiffLines(lines: FileDiffLine[]): DiffHunkBlock[] {
    const hunks: DiffHunkBlock[] = [];
    let currentHunkLines: FileDiffLine[] = [];
    let hunkIdx = 0;
    let hasChanges = false;
    let contextTrailing = 0;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        if (line.type === 'add' || line.type === 'del') {
            hasChanges = true;
            contextTrailing = 0;
            currentHunkLines.push(line);
        } else {
            // context line
            if (hasChanges) {
                contextTrailing++;
                currentHunkLines.push(line);
                // After 3 context lines following changes, close the hunk
                if (contextTrailing >= 3 || i === lines.length - 1) {
                    const firstOld = currentHunkLines.find(l => l.oldLineNo)?.oldLineNo || 1;
                    const firstNew = currentHunkLines.find(l => l.newLineNo)?.newLineNo || 1;
                    hunks.push({
                        id: `hunk-${hunkIdx++}`,
                        oldStart: firstOld,
                        oldLength: currentHunkLines.filter(l => l.type !== 'add').length,
                        newStart: firstNew,
                        newLength: currentHunkLines.filter(l => l.type !== 'del').length,
                        header: `@@ -${firstOld} +${firstNew} @@`,
                        lines: [...currentHunkLines],
                        isAccepted: true
                    });
                    currentHunkLines = [];
                    hasChanges = false;
                    contextTrailing = 0;
                }
            } else {
                currentHunkLines.push(line);
                if (currentHunkLines.length > 2) {
                    currentHunkLines.shift();
                }
            }
        }
    }

    if (hasChanges && currentHunkLines.length > 0) {
        const firstOld = currentHunkLines.find(l => l.oldLineNo)?.oldLineNo || 1;
        const firstNew = currentHunkLines.find(l => l.newLineNo)?.newLineNo || 1;
        hunks.push({
            id: `hunk-${hunkIdx++}`,
            oldStart: firstOld,
            oldLength: currentHunkLines.filter(l => l.type !== 'add').length,
            newStart: firstNew,
            newLength: currentHunkLines.filter(l => l.type !== 'del').length,
            header: `@@ -${firstOld} +${firstNew} @@`,
            lines: [...currentHunkLines],
            isAccepted: true
        });
    }

    return hunks;
}

/**
 * Selectively applies accepted hunks onto the original file content.
 */
export function applySelectedHunks(
    oldContent: string,
    hunks: DiffHunkBlock[],
    acceptedHunkIds: string[] | Set<string>
): string {
    if (!hunks || hunks.length === 0) {
        return oldContent;
    }

    const acceptedSet = acceptedHunkIds instanceof Set ? acceptedHunkIds : new Set(acceptedHunkIds);
    const lines = oldContent.length > 0 ? oldContent.split('\n') : [];

    // Sort descending by oldStart so line position shifts do not affect prior hunk indices
    const sortedHunks = [...hunks].sort((a, b) => b.oldStart - a.oldStart);

    for (const hunk of sortedHunks) {
        if (!acceptedSet.has(hunk.id)) {
            continue; // Rejected: leave original lines intact
        }

        // Gather lines that should replace the hunk's old range
        const replacementLines = hunk.lines
            .filter(l => l.type === 'context' || l.type === 'add')
            .map(l => l.content);

        const startIdx = Math.max(0, hunk.oldStart - 1);
        const deleteCount = Math.max(0, hunk.oldLength);

        if (lines.length === 0 && hunk.oldLength === 0) {
            lines.push(...replacementLines);
        } else {
            lines.splice(startIdx, deleteCount, ...replacementLines);
        }
    }

    return lines.join('\n');
}
