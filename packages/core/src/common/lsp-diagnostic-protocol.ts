/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

export type DiagnosticSeverity = 'error' | 'warning' | 'info' | 'hint';

export interface LspDiagnosticRange {
    startLine: number;
    startColumn: number;
    endLine: number;
    endColumn: number;
}

export interface LspDiagnosticRelatedInformation {
    filePath: string;
    range: LspDiagnosticRange;
    message: string;
}

export interface LspDiagnostic {
    id: string;
    filePath: string;
    range: LspDiagnosticRange;
    severity: DiagnosticSeverity;
    code?: string | number;
    source?: string;
    message: string;
    relatedInformation?: LspDiagnosticRelatedInformation[];
    suggestedFixes?: string[];
    timestamp: number;
}

export interface CompilerDiagnosticsBatch {
    batchId: string;
    toolchain: string;
    exitCode: number;
    rawOutput: string;
    diagnostics: LspDiagnostic[];
    timestamp: number;
}

export interface SelfHealingDiagnosticPrompt {
    errorCount: number;
    warningCount: number;
    topErrors: LspDiagnostic[];
    targetedFiles: string[];
    promptContext: string;
    suggestedActions: string[];
    rootCauseAnalysis?: string;
}

export interface DiagnosticFeedbackSummary {
    totalCount: number;
    errorCount: number;
    warningCount: number;
    affectedFiles: string[];
    clean: boolean;
    diagnosticsByFile: Record<string, LspDiagnostic[]>;
}
