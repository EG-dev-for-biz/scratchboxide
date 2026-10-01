/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/
import {
    ConversationTurnDiffRecord,
    DiffHunk,
    DiffMemoryPromptContext,
    DiffMemoryPromptOptions,
    FileEvolutionLineage,
    TurnDiffEntry
} from '../common/conversation-diff-protocol';
import { computeLineDiff } from '../browser/generative-canvas/multi-file-diff-engine';
import { MultiFilePatch } from '../browser/generative-canvas/canvas-types';
export class ConversationDiffMemoryService {
    private turnRecords: ConversationTurnDiffRecord[] = [];
    private fileLineages: Map<string, FileEvolutionLineage> = new Map();
    private uncommittedBuffers: Map<string, { baselineContent: string; workingContent: string; lastModified: number }> = new Map();

    /**
     * Record a set of file modifications made in a conversation turn.
     */
    recordTurnEdits(
        turnId: string,
        files: Array<{ filePath: string; oldContent: string; newContent: string }>,
        options: { userPrompt?: string; aiSummary?: string } = {}
    ): ConversationTurnDiffRecord {
        const turnIndex = this.turnRecords.length + 1;
        const diffEntries: TurnDiffEntry[] = [];
        let totalAdditions = 0;
        let totalDeletions = 0;

        for (const f of files) {
            const cleanPath = f.filePath.replace(/\\/g, '/');
            const diff = computeLineDiff(f.oldContent || '', f.newContent || '');
            totalAdditions += diff.additions;
            totalDeletions += diff.deletions;

            const changeType = !f.oldContent && f.newContent ? 'added'
                : f.oldContent && !f.newContent ? 'deleted'
                : 'modified';

            // Group changed lines into compact hunks
            const hunks = this.extractDiffHunks(diff.lines);

            const entry: TurnDiffEntry = {
                filePath: cleanPath,
                changeType,
                additions: diff.additions,
                deletions: diff.deletions,
                hunks,
                summary: `${changeType.toUpperCase()} (+${diff.additions}/-${diff.deletions})`,
                oldContent: f.oldContent,
                newContent: f.newContent
            };

            diffEntries.push(entry);

            // Update file evolution lineage
            this.updateFileLineage(cleanPath, f.oldContent, f.newContent, turnId, turnIndex, entry);

            // Clear uncommitted buffer for this file since it is now recorded in a turn
            this.uncommittedBuffers.delete(cleanPath);
        }

        const record: ConversationTurnDiffRecord = {
            turnId,
            turnIndex,
            timestamp: Date.now(),
            userPrompt: options.userPrompt,
            aiSummary: options.aiSummary,
            filesModified: diffEntries,
            totalAdditions,
            totalDeletions,
            isCommitted: false
        };

        this.turnRecords.push(record);
        return record;
    }

    /**
     * Record a MultiFilePatch from the multi-file diff engine.
     */
    recordMultiFilePatch(
        turnId: string,
        patch: MultiFilePatch,
        userPrompt?: string
    ): ConversationTurnDiffRecord {
        const filesToRecord = patch.files.map(f => ({
            filePath: f.path,
            oldContent: f.oldContent || '',
            newContent: f.newContent || ''
        }));

        return this.recordTurnEdits(turnId, filesToRecord, {
            userPrompt,
            aiSummary: patch.summary || `Applied multi-file patch across ${patch.files.length} files.`
        });
    }

    /**
     * Track live uncommitted working edits in the editor before turn submission.
     */
    recordUncommittedChange(filePath: string, baselineContent: string, workingContent: string): void {
        const cleanPath = filePath.replace(/\\/g, '/');
        if (baselineContent === workingContent) {
            this.uncommittedBuffers.delete(cleanPath);
        } else {
            this.uncommittedBuffers.set(cleanPath, {
                baselineContent,
                workingContent,
                lastModified: Date.now()
            });
        }
    }

    /**
     * Get uncommitted diff entries.
     */
    getUncommittedDiffs(): TurnDiffEntry[] {
        const entries: TurnDiffEntry[] = [];
        for (const [filePath, buffer] of this.uncommittedBuffers.entries()) {
            const diff = computeLineDiff(buffer.baselineContent, buffer.workingContent);
            if (diff.additions > 0 || diff.deletions > 0) {
                const hunks = this.extractDiffHunks(diff.lines);
                entries.push({
                    filePath,
                    changeType: !buffer.baselineContent ? 'added' : 'modified',
                    additions: diff.additions,
                    deletions: diff.deletions,
                    hunks,
                    summary: `UNCOMMITTED (+${diff.additions}/-${diff.deletions})`,
                    oldContent: buffer.baselineContent,
                    newContent: buffer.workingContent
                });
            }
        }
        return entries;
    }

    /**
     * Mark all or specific turns as committed.
     */
    markCommitted(turnId?: string): void {
        for (const t of this.turnRecords) {
            if (!turnId || t.turnId === turnId) {
                t.isCommitted = true;
            }
        }
        if (!turnId) {
            this.uncommittedBuffers.clear();
        }
    }

    /**
     * Retrieve full turn history.
     */
    getTurnHistory(maxTurns?: number): ConversationTurnDiffRecord[] {
        if (!maxTurns || maxTurns >= this.turnRecords.length) {
            return [...this.turnRecords];
        }
        return this.turnRecords.slice(this.turnRecords.length - maxTurns);
    }

    /**
     * Retrieve file evolution lineage tracking how a specific file has changed across turns.
     */
    getFileLineage(filePath: string): FileEvolutionLineage | undefined {
        return this.fileLineages.get(filePath.replace(/\\/g, '/'));
    }

    /**
     * Synthesize structured prompt context block containing multi-turn diff history and uncommitted edits.
     */
    buildDiffMemoryPromptContext(options: DiffMemoryPromptOptions = {}): DiffMemoryPromptContext {
        const maxTurns = options.maxTurns || 5;
        const maxTokens = options.maxTokens || 2000;
        const includeUncommitted = options.includeUncommitted ?? true;
        const includeHunks = options.includeHunks ?? true;

        const recentTurns = this.getTurnHistory(maxTurns);
        const uncommittedDiffs = includeUncommitted ? this.getUncommittedDiffs() : [];
        const activeFilesSet = new Set<string>();

        const turnLines: string[] = [];
        for (const turn of recentTurns) {
            const promptLabel = turn.userPrompt ? ` "${turn.userPrompt.slice(0, 80)}"` : '';
            turnLines.push(`• Turn #${turn.turnIndex}${promptLabel} (+${turn.totalAdditions}/-${turn.totalDeletions}):`);

            for (const file of turn.filesModified) {
                activeFilesSet.add(file.filePath);
                turnLines.push(`    - \`${file.filePath}\` [${file.changeType.toUpperCase()}] (+${file.additions}/-${file.deletions})`);

                if (includeHunks && file.hunks.length > 0) {
                    for (const hunk of file.hunks.slice(0, 2)) {
                        turnLines.push(`        @@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`);
                        for (const line of hunk.lines.slice(0, 6)) {
                            turnLines.push(`        ${line.slice(0, 100)}`);
                        }
                    }
                }
            }
        }

        const uncommittedLines: string[] = [];
        if (uncommittedDiffs.length > 0) {
            uncommittedLines.push('Active Uncommitted Working Edits:');
            for (const u of uncommittedDiffs) {
                activeFilesSet.add(u.filePath);
                uncommittedLines.push(`  - \`${u.filePath}\`: +${u.additions}/-${u.deletions}`);
                if (includeHunks && u.hunks.length > 0) {
                    for (const hunk of u.hunks.slice(0, 2)) {
                        uncommittedLines.push(`      @@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`);
                        for (const line of hunk.lines.slice(0, 6)) {
                            uncommittedLines.push(`      ${line.slice(0, 100)}`);
                        }
                    }
                }
            }
        }

        const recentTurnsSummary = turnLines.join('\n');
        const uncommittedChangesSummary = uncommittedLines.join('\n');

        const fullPromptParts: string[] = [
            `[CONVERSATION_DIFF_MEMORY: turns_tracked=${this.turnRecords.length} files_touched=${activeFilesSet.size}]`
        ];

        if (recentTurnsSummary) {
            fullPromptParts.push('### RECENT TURNS CODE EVOLUTION & MODIFICATION HISTORY:');
            fullPromptParts.push(recentTurnsSummary);
        }

        if (uncommittedChangesSummary) {
            fullPromptParts.push('\n### PENDING UNCOMMITTED WORKING EDITS (AWARENESS REQUIRED):');
            fullPromptParts.push(uncommittedChangesSummary);
        }

        let fullPromptSection = fullPromptParts.join('\n');
        if (fullPromptSection.length > maxTokens * 4) {
            fullPromptSection = fullPromptSection.slice(0, maxTokens * 4) + '...[TRUNCATED]';
        }

        return {
            recentTurnsSummary,
            uncommittedChangesSummary,
            fullPromptSection,
            tokensEstimate: Math.ceil(fullPromptSection.length / 4),
            activeFilesTouched: Array.from(activeFilesSet)
        };
    }

    private updateFileLineage(
        cleanPath: string,
        oldContent: string,
        newContent: string,
        turnId: string,
        turnIndex: number,
        entry: TurnDiffEntry
    ): void {
        const existing = this.fileLineages.get(cleanPath);
        if (existing) {
            existing.currentContent = newContent;
            existing.cumulativeAdditions += entry.additions;
            existing.cumulativeDeletions += entry.deletions;
            existing.turnSnapshots.push({
                turnId,
                turnIndex,
                timestamp: Date.now(),
                content: newContent,
                diffSummary: entry.summary
            });
        } else {
            this.fileLineages.set(cleanPath, {
                filePath: cleanPath,
                originalContent: oldContent,
                currentContent: newContent,
                turnSnapshots: [
                    {
                        turnId,
                        turnIndex,
                        timestamp: Date.now(),
                        content: newContent,
                        diffSummary: entry.summary
                    }
                ],
                cumulativeAdditions: entry.additions,
                cumulativeDeletions: entry.deletions
            });
        }
    }

    private extractDiffHunks(lines: any[]): DiffHunk[] {
        const hunks: DiffHunk[] = [];
        let currentHunkLines: string[] = [];
        let oldStart = 1;
        let newStart = 1;
        let oldLinesCount = 0;
        let newLinesCount = 0;
        let inHunk = false;

        for (const line of lines) {
            if (line.type === 'add' || line.type === 'del') {
                if (!inHunk) {
                    inHunk = true;
                    oldStart = line.oldLineNo || 1;
                    newStart = line.newLineNo || 1;
                    oldLinesCount = 0;
                    newLinesCount = 0;
                    currentHunkLines = [];
                }

                if (line.type === 'add') {
                    newLinesCount++;
                    currentHunkLines.push(`+ ${line.content}`);
                } else {
                    oldLinesCount++;
                    currentHunkLines.push(`- ${line.content}`);
                }
            } else if (inHunk) {
                // End of hunk
                hunks.push({
                    oldStart,
                    oldLines: Math.max(1, oldLinesCount),
                    newStart,
                    newLines: Math.max(1, newLinesCount),
                    lines: [...currentHunkLines]
                });
                inHunk = false;
            }
        }

        if (inHunk && currentHunkLines.length > 0) {
            hunks.push({
                oldStart,
                oldLines: Math.max(1, oldLinesCount),
                newStart,
                newLines: Math.max(1, newLinesCount),
                lines: [...currentHunkLines]
            });
        }

        return hunks;
    }

    /**
     * Clear all recorded history and diffs.
     */
    clear(): void {
        this.turnRecords = [];
        this.fileLineages.clear();
        this.uncommittedBuffers.clear();
    }
}
