/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

export interface DiffHunk {
    oldStart: number;
    oldLines: number;
    newStart: number;
    newLines: number;
    lines: string[];
}

export interface TurnDiffEntry {
    filePath: string;
    changeType: 'added' | 'modified' | 'deleted' | 'renamed';
    additions: number;
    deletions: number;
    hunks: DiffHunk[];
    summary: string;
    oldContentHash?: string;
    newContentHash?: string;
    oldContent?: string;
    newContent?: string;
}

export interface ConversationTurnDiffRecord {
    turnId: string;
    turnIndex: number;
    timestamp: number;
    userPrompt?: string;
    aiSummary?: string;
    filesModified: TurnDiffEntry[];
    totalAdditions: number;
    totalDeletions: number;
    isCommitted: boolean;
}

export interface FileEvolutionLineage {
    filePath: string;
    originalContent: string;
    currentContent: string;
    turnSnapshots: Array<{
        turnId: string;
        turnIndex: number;
        timestamp: number;
        content: string;
        diffSummary: string;
    }>;
    cumulativeAdditions: number;
    cumulativeDeletions: number;
}

export interface DiffMemoryPromptOptions {
    maxTurns?: number;
    maxTokens?: number;
    includeUncommitted?: boolean;
    includeHunks?: boolean;
    filterFiles?: string[];
}

export interface DiffMemoryPromptContext {
    recentTurnsSummary: string;
    uncommittedChangesSummary: string;
    fullPromptSection: string;
    tokensEstimate: number;
    activeFilesTouched: string[];
}
