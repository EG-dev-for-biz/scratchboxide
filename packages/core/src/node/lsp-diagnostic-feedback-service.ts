/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/
import {
    CompilerDiagnosticsBatch,
    DiagnosticFeedbackSummary,
    DiagnosticSeverity,
    LspDiagnostic,
    SelfHealingDiagnosticPrompt
} from '../common/lsp-diagnostic-protocol';

export type DiagnosticChangeListener = (summary: DiagnosticFeedbackSummary) => void;
export class LspDiagnosticFeedbackService {
    private fileDiagnostics: Map<string, LspDiagnostic[]> = new Map();
    private batches: CompilerDiagnosticsBatch[] = [];
    private listeners: Set<DiagnosticChangeListener> = new Set();

    /**
     * Subscribe to diagnostic state changes.
     */
    onDiagnosticsChanged(listener: DiagnosticChangeListener): { dispose: () => void } {
        this.listeners.add(listener);
        return {
            dispose: () => this.listeners.delete(listener)
        };
    }

    private notifyListeners(): void {
        const summary = this.getSummary();
        for (const listener of this.listeners) {
            try {
                listener(summary);
            } catch {
                // Ignore listener callback exceptions safely
            }
        }
    }

    /**
     * Ingest language server diagnostics for a specific file.
     */
    ingestDiagnostics(filePath: string, diagnostics: LspDiagnostic[]): void {
        const cleanPath = filePath.replace(/\\/g, '/');
        if (diagnostics.length === 0) {
            this.fileDiagnostics.delete(cleanPath);
        } else {
            this.fileDiagnostics.set(cleanPath, diagnostics);
        }
        this.notifyListeners();
    }

    /**
     * Clear diagnostics for a specific file or all files.
     */
    clearDiagnostics(filePath?: string): void {
        if (filePath) {
            this.fileDiagnostics.delete(filePath.replace(/\\/g, '/'));
        } else {
            this.fileDiagnostics.clear();
        }
        this.notifyListeners();
    }

    /**
     * Parse raw compiler / linter / test runner console output into structured LSP diagnostics.
     */
    ingestCompilerOutput(
        rawOutput: string,
        toolchain: string = 'typescript',
        exitCode: number = 1
    ): CompilerDiagnosticsBatch {
        const diagnostics: LspDiagnostic[] = [];
        const lines = rawOutput.split('\n');

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line) continue;

            // 1. TypeScript tsc standard error: "src/foo.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'."
            const tsMatch1 = line.match(/^([a-zA-Z0-9_\-./\\]+)\((\d+),(\d+)\):\s*(error|warning)\s*(TS\d+)?:\s*(.*)$/i);
            if (tsMatch1) {
                const [, fPath, lNum, cNum, sev, code, msg] = tsMatch1;
                const severity: DiagnosticSeverity = sev.toLowerCase() === 'warning' ? 'warning' : 'error';
                diagnostics.push({
                    id: `diag-ts-${Date.now()}-${diagnostics.length}`,
                    filePath: fPath.replace(/\\/g, '/'),
                    range: {
                        startLine: parseInt(lNum, 10),
                        startColumn: parseInt(cNum, 10),
                        endLine: parseInt(lNum, 10),
                        endColumn: parseInt(cNum, 10) + 1
                    },
                    severity,
                    code: code || 'TS_COMPILER_ERROR',
                    source: 'tsc',
                    message: msg.trim(),
                    timestamp: Date.now()
                });
                continue;
            }

            // 2. TypeScript tsc alternative format: "src/foo.ts:12:5 - error TS2322: Type 'string'..."
            const tsMatch2 = line.match(/^([a-zA-Z0-9_\-./\\]+):(\d+):(\d+)\s*-\s*(error|warning)\s*(TS\d+)?:\s*(.*)$/i);
            if (tsMatch2) {
                const [, fPath, lNum, cNum, sev, code, msg] = tsMatch2;
                const severity: DiagnosticSeverity = sev.toLowerCase() === 'warning' ? 'warning' : 'error';
                diagnostics.push({
                    id: `diag-ts-${Date.now()}-${diagnostics.length}`,
                    filePath: fPath.replace(/\\/g, '/'),
                    range: {
                        startLine: parseInt(lNum, 10),
                        startColumn: parseInt(cNum, 10),
                        endLine: parseInt(lNum, 10),
                        endColumn: parseInt(cNum, 10) + 1
                    },
                    severity,
                    code: code || 'TS_COMPILER_ERROR',
                    source: 'tsc',
                    message: msg.trim(),
                    timestamp: Date.now()
                });
                continue;
            }

            // 3. ESLint style: "  10:5  error  'x' is defined but never used  @typescript-eslint/no-unused-vars"
            const eslintMatch = line.match(/^(\d+):(\d+)\s+(error|warning)\s+(.*?)\s+([@a-zA-Z0-9\-_/]+)$/i);
            if (eslintMatch && i > 0) {
                const prevLine = lines[i - 1].trim();
                const possibleFile = prevLine.replace(/\\/g, '/');
                if (possibleFile.includes('/') || possibleFile.includes('.')) {
                    const [, lNum, cNum, sev, msg, rule] = eslintMatch;
                    diagnostics.push({
                        id: `diag-eslint-${Date.now()}-${diagnostics.length}`,
                        filePath: possibleFile,
                        range: {
                            startLine: parseInt(lNum, 10),
                            startColumn: parseInt(cNum, 10),
                            endLine: parseInt(lNum, 10),
                            endColumn: parseInt(cNum, 10) + 1
                        },
                        severity: sev.toLowerCase() === 'warning' ? 'warning' : 'error',
                        code: rule,
                        source: 'eslint',
                        message: msg.trim(),
                        timestamp: Date.now()
                    });
                    continue;
                }
            }

            // 4. Rust / C++ / Clang style: "error[E0425]: cannot find value 'x' in this scope --> src/main.rs:10:5"
            const rustMatch = line.match(/^-->\s*([a-zA-Z0-9_\-./\\]+):(\d+):(\d+)/);
            if (rustMatch && i > 0) {
                const prevLine = lines[i - 1].trim();
                const [, fPath, lNum, cNum] = rustMatch;
                diagnostics.push({
                    id: `diag-native-${Date.now()}-${diagnostics.length}`,
                    filePath: fPath.replace(/\\/g, '/'),
                    range: {
                        startLine: parseInt(lNum, 10),
                        startColumn: parseInt(cNum, 10),
                        endLine: parseInt(lNum, 10),
                        endColumn: parseInt(cNum, 10) + 1
                    },
                    severity: 'error',
                    code: prevLine.includes('error[') ? prevLine.split(':')[0] : 'NATIVE_BUILD_ERROR',
                    source: toolchain,
                    message: prevLine,
                    timestamp: Date.now()
                });
                continue;
            }

            // 5. Python traceback / mypy style: "src/app.py:20: error: Incompatible types..."
            const pyMatch = line.match(/^([a-zA-Z0-9_\-./\\]+\.py):(\d+):\s*(error|warning):\s*(.*)$/i);
            if (pyMatch) {
                const [, fPath, lNum, sev, msg] = pyMatch;
                diagnostics.push({
                    id: `diag-py-${Date.now()}-${diagnostics.length}`,
                    filePath: fPath.replace(/\\/g, '/'),
                    range: {
                        startLine: parseInt(lNum, 10),
                        startColumn: 1,
                        endLine: parseInt(lNum, 10),
                        endColumn: 80
                    },
                    severity: sev.toLowerCase() === 'warning' ? 'warning' : 'error',
                    code: 'PYTHON_LINT_ERROR',
                    source: 'python',
                    message: msg.trim(),
                    timestamp: Date.now()
                });
                continue;
            }

            // 6. Generic assertion error / stack trace locator: "AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:"
            if (line.includes('AssertionError') || line.includes('ReferenceError') || line.includes('TypeError')) {
                // Look ahead for stack frame
                let foundStackFile = '';
                let foundLine = 1;
                for (let j = i + 1; j < Math.min(lines.length, i + 6); j++) {
                    const stackMatch = lines[j].match(/at\s+.*\(?([a-zA-Z0-9_\-./\\]+\.[a-zA-Z0-9]+):(\d+):(\d+)\)?/);
                    if (stackMatch && !stackMatch[1].includes('node_modules')) {
                        foundStackFile = stackMatch[1];
                        foundLine = parseInt(stackMatch[2], 10);
                        break;
                    }
                }

                if (foundStackFile) {
                    diagnostics.push({
                        id: `diag-assert-${Date.now()}-${diagnostics.length}`,
                        filePath: foundStackFile.replace(/\\/g, '/'),
                        range: {
                            startLine: foundLine,
                            startColumn: 1,
                            endLine: foundLine,
                            endColumn: 80
                        },
                        severity: 'error',
                        code: 'TEST_ASSERTION_FAILURE',
                        source: 'test-runner',
                        message: line,
                        timestamp: Date.now()
                    });
                }
            }
        }

        // Group by file and store
        const groupedByFile = new Map<string, LspDiagnostic[]>();
        for (const diag of diagnostics) {
            const list = groupedByFile.get(diag.filePath) || [];
            list.push(diag);
            groupedByFile.set(diag.filePath, list);
        }

        for (const [fPath, list] of groupedByFile.entries()) {
            this.fileDiagnostics.set(fPath, list);
        }

        const batch: CompilerDiagnosticsBatch = {
            batchId: `batch-${Date.now()}`,
            toolchain,
            exitCode,
            rawOutput,
            diagnostics,
            timestamp: Date.now()
        };

        this.batches.push(batch);
        this.notifyListeners();
        return batch;
    }

    /**
     * Get all diagnostics for a specific file.
     */
    getDiagnosticsForFile(filePath: string): LspDiagnostic[] {
        return this.fileDiagnostics.get(filePath.replace(/\\/g, '/')) || [];
    }

    /**
     * Get all currently collected diagnostics across all files.
     */
    getAllDiagnostics(severity?: DiagnosticSeverity): LspDiagnostic[] {
        const all: LspDiagnostic[] = [];
        for (const list of this.fileDiagnostics.values()) {
            if (severity) {
                all.push(...list.filter(d => d.severity === severity));
            } else {
                all.push(...list);
            }
        }
        return all;
    }

    /**
     * Get a comprehensive diagnostic summary.
     */
    getSummary(): DiagnosticFeedbackSummary {
        const all = this.getAllDiagnostics();
        const errorCount = all.filter(d => d.severity === 'error').length;
        const warningCount = all.filter(d => d.severity === 'warning').length;
        const affectedFiles = Array.from(this.fileDiagnostics.keys());

        const diagnosticsByFile: Record<string, LspDiagnostic[]> = {};
        for (const [fPath, list] of this.fileDiagnostics.entries()) {
            diagnosticsByFile[fPath] = [...list];
        }

        return {
            totalCount: all.length,
            errorCount,
            warningCount,
            affectedFiles,
            clean: errorCount === 0,
            diagnosticsByFile
        };
    }

    /**
     * Synthesize high-reasoning self-healing feedback prompt from active LSP & compiler diagnostics.
     */
    synthesizeDiagnosticFixPrompt(
        targetedFiles?: string[],
        fileContents?: Record<string, string>
    ): SelfHealingDiagnosticPrompt {
        let allDiags = this.getAllDiagnostics();
        if (targetedFiles && targetedFiles.length > 0) {
            const targets = new Set(targetedFiles.map(f => f.replace(/\\/g, '/')));
            allDiags = allDiags.filter(d => targets.has(d.filePath));
        }

        const errorDiags = allDiags.filter(d => d.severity === 'error');
        const warningDiags = allDiags.filter(d => d.severity === 'warning');
        const affectedFiles = Array.from(new Set(allDiags.map(d => d.filePath)));

        const suggestedActions: string[] = [];
        const promptLines: string[] = [
            `[LSP_COMPILER_DIAGNOSTIC_FEEDBACK: errors=${errorDiags.length} warnings=${warningDiags.length} affected_files=${affectedFiles.length}]`
        ];

        // Group diagnostics by file
        for (const fPath of affectedFiles) {
            const fDiags = allDiags.filter(d => d.filePath === fPath);
            promptLines.push(`\nFILE \`${fPath}\`:`);

            for (const diag of fDiags) {
                const codePart = diag.code ? ` (${diag.code})` : '';
                promptLines.push(`  • [${diag.severity.toUpperCase()}] Line ${diag.range.startLine}:${diag.range.startColumn}${codePart}: ${diag.message}`);

                // Analyze diagnostic code for smart recommendations
                if (String(diag.code).includes('TS2322')) {
                    suggestedActions.push(`Fix type incompatibility in \`${fPath}\` at line ${diag.range.startLine}.`);
                } else if (String(diag.code).includes('TS2304') || String(diag.code).includes('TS2307')) {
                    suggestedActions.push(`Add missing import declaration in \`${fPath}\` for unresolved symbol.`);
                } else if (String(diag.code).includes('TS2554')) {
                    suggestedActions.push(`Update function call arguments in \`${fPath}\` at line ${diag.range.startLine}.`);
                } else if (String(diag.code).includes('TS6133')) {
                    suggestedActions.push(`Remove or utilize unused declaration in \`${fPath}\` at line ${diag.range.startLine}.`);
                }
            }

            // Include snippet around error line if file content is available
            if (fileContents && fileContents[fPath]) {
                const contentLines = fileContents[fPath].split('\n');
                for (const diag of fDiags.slice(0, 3)) {
                    const lIdx = diag.range.startLine - 1;
                    const start = Math.max(0, lIdx - 2);
                    const end = Math.min(contentLines.length, lIdx + 3);
                    promptLines.push(`    Context (lines ${start + 1}-${end}):`);
                    for (let k = start; k < end; k++) {
                        const marker = k === lIdx ? '>> ' : '   ';
                        promptLines.push(`    ${marker}${k + 1}| ${contentLines[k]}`);
                    }
                }
            }
        }

        const promptContext = promptLines.join('\n');

        return {
            errorCount: errorDiags.length,
            warningCount: warningDiags.length,
            topErrors: errorDiags.slice(0, 10),
            targetedFiles: affectedFiles,
            promptContext,
            suggestedActions: Array.from(new Set(suggestedActions)),
            rootCauseAnalysis: errorDiags.length > 0
                ? `Identified ${errorDiags.length} compilation/type error(s) across ${affectedFiles.length} file(s).`
                : 'All files compiled cleanly without errors.'
        };
    }
}
