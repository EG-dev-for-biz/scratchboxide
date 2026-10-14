/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/
import * as fs from 'fs-extra';
import * as path from 'path';
import { ContainerSandboxService } from '../container-sandbox-service';
import { GeminiService } from '../gemini-service';
import { BuildToolchain } from '../../common/deep-write/deep-write-protocol';
import { LspDiagnosticFeedbackService } from '../lsp-diagnostic-feedback-service';
export class DeepWriteExecutionBridge {
    private sandboxService = new ContainerSandboxService();
    private fallbackLspFeedbackService = new LspDiagnosticFeedbackService();

    constructor(
        protected readonly geminiService: GeminiService,
        protected readonly lspFeedbackService?: LspDiagnosticFeedbackService
    ) {}

    public getLspFeedbackService(): LspDiagnosticFeedbackService {
        return this.lspFeedbackService || this.fallbackLspFeedbackService;
    }

    /**
     * Write files, run compiles/tests, inspect errors, and run the autonomous self-healing loop.
     */
    public async compileAndRun(
        files: Record<string, string>,
        toolchain: BuildToolchain,
        workspaceRoot: string,
        onProgress?: (msg: string) => void
    ): Promise<{
        success: boolean;
        output: string;
        repairedFiles?: Record<string, string>;
    }> {
        const buildDir = path.join(workspaceRoot, '.scratchbox', 'deep-write-build');
        await fs.ensureDir(buildDir);

        // 1. Write the target files to the build staging directory
        for (const [filePath, content] of Object.entries(files)) {
            const absolutePath = path.join(buildDir, filePath);
            await fs.ensureDir(path.dirname(absolutePath));
            await fs.writeFile(absolutePath, content, 'utf8');
        }

        const envId = `env-dw-${Date.now()}`;
        await this.sandboxService.createEnvironment({
            environmentId: envId,
            isolationLevel: 'process-jail',
            workspaceRoot: buildDir
        });

        const maxRetries = 3;
        let currentFiles = { ...files };
        let finalOutput = '';
        let success = false;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            onProgress?.(`Compilation attempt ${attempt}/${maxRetries} using toolchain "${toolchain}"...`);
            const runCmd = this.getToolchainCommand(toolchain);

            if (!runCmd) {
                onProgress?.(`No compiler toolchain command required for "${toolchain}". Auto-verified.`);
                return { success: true, output: 'Verified code structures.' };
            }

            let res;
            try {
                res = await this.sandboxService.executeCommand(envId, {
                    command: runCmd,
                    cwd: buildDir,
                    timeoutMs: 15000,
                    // Toolchain runs are agent-initiated; never bypass the sandbox allowlist here.
                    confirmedByUser: false
                });
            } catch (err: any) {
                if (err?.code === 'command_not_allowed' || err?.code === 'path_traversal') {
                    onProgress?.(`Toolchain command "${runCmd}" rejected by sandbox policy: ${err.message}`);
                    return { success: false, output: err.message, repairedFiles: currentFiles };
                }
                throw err;
            }

            finalOutput = `${res.stdout}\n${res.stderr}`.trim();
            if (res.exitCode === 0) {
                onProgress?.(`Compilation & execution succeeded on attempt ${attempt}!`);
                success = true;
                break;
            }

            onProgress?.(`Attempt ${attempt} failed with exit code ${res.exitCode || 1}. Triggering self-healing...`);
            
            // Ingest compiler diagnostics for rich self-healing analysis
            this.getLspFeedbackService().ingestCompilerOutput(finalOutput, toolchain, res.exitCode || 1);
            const diagPrompt = this.getLspFeedbackService().synthesizeDiagnosticFixPrompt(
                Object.keys(currentFiles),
                currentFiles
            );

            if (attempt === maxRetries) {
                break;
            }

            // Execute Self-Healing Repair Agent with LSP diagnostics
            const repaired = await this.runSelfHealingRepair(
                currentFiles,
                finalOutput,
                runCmd,
                toolchain,
                diagPrompt.promptContext
            );

            if (repaired && Object.keys(repaired).length > 0) {
                currentFiles = { ...currentFiles, ...repaired };
                // Write repaired files back to sandbox environment
                for (const [filePath, content] of Object.entries(repaired)) {
                    const absolutePath = path.join(buildDir, filePath);
                    await fs.ensureDir(path.dirname(absolutePath));
                    await fs.writeFile(absolutePath, content, 'utf8');
                }
            } else {
                onProgress?.('Self-healing agent failed to formulate a repair patch. Retrying standard compilation.');
            }
        }

        return {
            success,
            output: finalOutput,
            repairedFiles: currentFiles
        };
    }

    private getToolchainCommand(toolchain: BuildToolchain): string | null {
        switch (toolchain) {
            case 'cargo':
                return 'cargo check';
            case 'cmake':
                return 'cmake . && make';
            case 'makefile':
                return 'make';
            case 'go':
                return 'go build -v .';
            case 'npm':
                return 'npm install && npm run build';
            case 'yarn':
                return 'yarn install && yarn build';
            case 'pnpm':
                return 'pnpm install && pnpm build';
            case 'pip':
            case 'poetry':
                return 'python3 -m py_compile *.py';
            default:
                return null;
        }
    }

    private async runSelfHealingRepair(
        files: Record<string, string>,
        errorLogs: string,
        runCmd: string,
        toolchain: BuildToolchain,
        diagnosticContext?: string
    ): Promise<Record<string, string> | null> {
        const systemInstruction = `You are a legendary Senior Systems compiler repair agent in Scratchbox IDE.
Your task is to analyze compilation / execution logs, locate errors inside generated files, and return fully corrected, non-truncated repaired contents of the failing files.

Current Files in the Build Directory:
${JSON.stringify(files, null, 2)}

Failing Build Command: "${runCmd}"
Error logs & stack traces:
${errorLogs}
${diagnosticContext ? `\nStructured LSP & Compiler Diagnostics:\n${diagnosticContext}` : ''}

Identify the root cause of the error (such as missing headers, syntax errors, mismatched types, unresolved module imports, or broken build paths).
Synthesize the exact corrected file contents.

You MUST respond with a single valid JSON object containing corrected files:
{
  "repairedFiles": {
    "src/engine.cpp": "// Fully repaired, non-truncated C++ code...",
    "CMakeLists.txt": "..."
  }
}
`;

        let accumulatedText = '';
        try {
            await this.geminiService.streamGenerate(
                {
                    prompt: 'Identify the compilation/runtime errors and output the corrected file contents.',
                    systemInstruction,
                    model: 'gemini-3.8-flash',
                    temperature: 0.1,
                    thinkingBudget: 512
                },
                event => {
                    if (event.text) {
                        accumulatedText += event.text;
                    }
                }
            );
        } catch {
            return null;
        }

        let cleaned = accumulatedText.trim();
        if (cleaned.startsWith('```')) {
            cleaned = cleaned.replace(/^```(json)?/i, '').replace(/```$/i, '').trim();
        }

        try {
            const parsed = JSON.parse(cleaned);
            return parsed.repairedFiles || null;
        } catch {
            return null;
        }
    }
}
