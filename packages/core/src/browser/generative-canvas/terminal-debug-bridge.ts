/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import type { TerminalDebugAnalysis, TerminalExecutionError } from './canvas-types';

export type { TerminalDebugAnalysis, TerminalExecutionError };

/**
 * Extracts compiler diagnostics, TypeScript errors (TSxxxx), line numbers,
 * and stack trace frames from raw terminal command output.
 */
export function extractStackTraceAndDiagnostics(output: string = ''): TerminalDebugAnalysis {
    if (!output || typeof output !== 'string') {
        return {
            diagnostics: [],
            stackFrames: [],
            rootCauseSummary: 'Unknown execution error'
        };
    }

    const lines = output.split('\n');
    const diagnostics: string[] = [];
    const stackFrames: string[] = [];

    const tsErrorPattern = /(?:error\s+TS\d+|TS\d{4,5}:|SyntaxError:|TypeError:|ReferenceError:|AssertionError:)/i;
    const stackPattern = /^\s*at\s+.*\(?.*:\d+:\d+\)?/i;
    const fileLinePattern = /([a-zA-Z0-9_\-./\\]+\.[a-zA-Z0-9]+):(\d+):(\d+)/;

    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        if (stackPattern.test(trimmed)) {
            if (stackFrames.length < 8) {
                stackFrames.push(trimmed);
            }
        } else if (tsErrorPattern.test(trimmed) || fileLinePattern.test(trimmed)) {
            if (diagnostics.length < 12) {
                diagnostics.push(trimmed);
            }
        } else if (trimmed.startsWith('Error:') || trimmed.startsWith('FAILED:') || trimmed.includes('Command failed')) {
            if (diagnostics.length < 12) {
                diagnostics.push(trimmed);
            }
        }
    }

    let rootCauseSummary = 'Terminal process exited with non-zero status.';
    if (diagnostics.some(d => d.includes('TS2339') || d.includes('TS2322') || d.includes('error TS'))) {
        rootCauseSummary = `TypeScript compiler diagnostics detected (${diagnostics.length} type errors).`;
    } else if (diagnostics.some(d => d.includes('SyntaxError'))) {
        rootCauseSummary = 'JavaScript/TypeScript syntax error encountered during build.';
    } else if (diagnostics.some(d => d.includes('AssertionError') || d.includes('failed'))) {
        rootCauseSummary = 'Automated test suite assertion failure detected.';
    }

    return {
        diagnostics,
        stackFrames,
        rootCauseSummary
    };
}

/**
 * Synthesizes a structured, high-reasoning Gemini self-healing debug prompt
 * from terminal errors, failure exit codes, and stack traces.
 */
export function synthesizeTerminalDebugPrompt(
    error: TerminalExecutionError | { command?: string; exitCode?: number; output: string; stackTrace?: string }
): string {
    const analysis = extractStackTraceAndDiagnostics(error.output || '');
    const cmd = error.command || 'terminal execution';
    const exitCode = error.exitCode ?? 1;

    const sections: string[] = [
        '=== [TERMINAL_SELF_HEALING_CONTEXT] ===',
        `Command: \`${cmd}\``,
        `Exit Code: ${exitCode}`,
        `Root Cause Summary: ${analysis.rootCauseSummary}`
    ];

    if (analysis.diagnostics.length > 0) {
        sections.push('\n### Key Compiler & Runtime Diagnostics:');
        analysis.diagnostics.forEach(diag => sections.push(`- ${diag}`));
    }

    if (analysis.stackFrames.length > 0) {
        sections.push('\n### Error Stack Trace Frames:');
        analysis.stackFrames.forEach(frame => sections.push(`  ${frame}`));
    }

    sections.push('\n### Raw Terminal Log Tail:');
    const tailLines = (error.output || '').split('\n').slice(-25).join('\n');
    sections.push('```\n' + tailLines + '\n```');

    sections.push('\n### Self-Healing Instructions for Gemini AI:');
    sections.push('1. Root Cause Analysis: Pinpoint the exact file, line number, and mismatch causing the failure.');
    sections.push('2. Multi-File Patch: Generate complete, corrected replacement code for the affected files.');
    sections.push('3. Verification: Ensure all TypeScript types, exports, and imports compile cleanly with 0 errors.');

    return sections.join('\n');
}
