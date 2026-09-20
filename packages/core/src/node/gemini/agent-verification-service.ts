/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { LspDiagnosticFeedbackService } from '../lsp-diagnostic-feedback-service';
import { ContainerSandboxService } from '../container-sandbox-service';
import { VerificationOutcome, VerificationDiagnostic } from '../../common/gemini-protocol';

export interface VerifyOptions {
    workspaceRoot: string;
    modifiedFiles?: string[];
    runTests?: boolean;
    timeoutMs?: number;
}

export class AgentVerificationService {
    constructor(
        private readonly lsp: LspDiagnosticFeedbackService,
        private readonly sandbox: ContainerSandboxService
    ) {}

    /**
     * Run full verification suite against modified files and workspace:
     * 1. Query LSP diagnostics for compiler errors.
     * 2. If configured and no compiler errors, execute sandboxed verification commands.
     */
    async verify(options: VerifyOptions): Promise<VerificationOutcome> {
        const { workspaceRoot, modifiedFiles = [], runTests = false, timeoutMs = 30000 } = options;
        const diagnostics: VerificationDiagnostic[] = [];

        // 1. LSP Diagnostics inspection
        let errorCount = 0;
        if (modifiedFiles.length > 0) {
            for (const f of modifiedFiles) {
                const fileDiags = this.lsp.getDiagnosticsForFile(f);
                for (const d of fileDiags) {
                    if (d.severity === 'error') {
                        errorCount++;
                        diagnostics.push({
                            file: d.filePath,
                            filePath: d.filePath,
                            line: d.range?.startLine,
                            message: d.message,
                            severity: 'error',
                            source: d.source || 'lsp'
                        });
                    }
                }
            }
        } else {
            const summary = this.lsp.getSummary();
            errorCount = summary.errorCount;
            if (summary.diagnosticsByFile) {
                for (const [filePath, diags] of Object.entries(summary.diagnosticsByFile)) {
                    for (const d of diags) {
                        if (d.severity === 'error') {
                            diagnostics.push({
                                file: filePath,
                                filePath,
                                line: d.range?.startLine,
                                message: d.message,
                                severity: 'error',
                                source: d.source || 'lsp'
                            });
                        }
                    }
                }
            }
        }

        if (errorCount > 0) {
            return {
                passed: false,
                summary: `Verification failed with ${errorCount} compiler error(s) across modified files.`,
                diagnostics
            };
        }

        // 2. Sandboxed test / build check if requested
        if (runTests) {
            try {
                const envId = `verify-${Date.now()}`;
                await this.sandbox.createEnvironment({
                    environmentId: envId,
                    isolationLevel: 'process-jail',
                    workspaceRoot,
                    timeoutMs
                });
                const testRes = await this.sandbox.executeCommand(envId, {
                    command: 'npm test --if-present',
                    cwd: workspaceRoot,
                    timeoutMs
                });
                if (testRes.exitCode !== 0) {
                    return {
                        passed: false,
                        summary: `Automated test run failed with exit code ${testRes.exitCode}.\n${testRes.stderr || testRes.stdout}`,
                        commandResult: {
                            exitCode: testRes.exitCode,
                            stdout: testRes.stdout,
                            stderr: testRes.stderr
                        }
                    };
                }
            } catch (err: any) {
                // If sandbox execution fails, capture error
                return {
                    passed: false,
                    summary: `Verification sandbox error: ${err?.message || String(err)}`
                };
            }
        }

        return {
            passed: true,
            summary: `Automated verification passed cleanly (0 errors detected).`
        };
    }
}
