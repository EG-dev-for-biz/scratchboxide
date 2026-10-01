/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

export interface AttemptDetail {
    attemptNumber: number;
    action: string;
    codeSnippet?: string;
    outcome: 'success' | 'failure';
    errorMessage?: string;
    stackTrace?: string;
    resolutionNotes?: string;
}

export interface ExecutionTrace {
    traceId: string;
    taskPrompt: string;
    timestamp: number;
    attempts: AttemptDetail[];
    finalStatus: 'resolved' | 'failed' | 'abandoned';
    contextFilePaths?: string[];
}

export interface LearnedInsight {
    id: string;
    category: 'typescript_compilation' | 'test_failure' | 'runtime_exception' | 'api_misuse' | 'style_rule';
    title: string;
    triggerPattern: string;
    resolutionGuidance: string;
    confidenceScore: number;
    occurrencesCount: number;
    lastUpdated: number;
    associatedFiles?: string[];
}

export interface TddIterationRecord {
    iteration: number;
    testsPassed: number;
    testsTotal: number;
    status: 'passed' | 'failing' | 'error';
    errorOutput?: string;
}

export interface TddFeedbackLoopResult {
    converged: boolean;
    totalIterations: number;
    finalStatus: 'green' | 'red';
    passRate: number;
    history: TddIterationRecord[];
}

export interface SelfImprovementQuery {
    errorText?: string;
    taskPrompt?: string;
    category?: string;
}

// =========================================================================
// Titans / MIRAS 3-Tier Neural Memory Protocol
// (Core Working Memory, Test-Time Contextual Memory, Persistent Invariants)
// =========================================================================

export interface TitansPersistentMemoryItem {
    id: string;
    title: string;
    content: string;
    category: string;
    tags?: string[];
}

export interface TitansContextualMemoryItem {
    id: string;
    triggerKey: string;
    resolutionValue: string;
    surpriseScore: number;
    decayWeight: number;
    accessCount: number;
    lastUpdated: number;
    associatedFiles?: string[];
}

export interface TitansMemoryQuery {
    query: string;
    workingContext?: string[];
    minSurpriseScore?: number;
    minDecayWeight?: number;
}

export interface TitansMemorySnapshot {
    coreWorkingMemory: string[];
    contextualMemories: TitansContextualMemoryItem[];
    persistentMemories: TitansPersistentMemoryItem[];
    promptInjectionText: string;
}

