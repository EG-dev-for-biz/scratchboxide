/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { ContainerSandboxService } from './container-sandbox-service';
import { SelfImprovementService } from './self-improvement-service';
import { GeminiService } from './gemini-service';
import {
    ContainerEnvironment,
    ExecutionResult,
    LocalExecutionOptions
} from '../common/container-sandbox-protocol';
import {
    GeminiGenerateRequest,
    GeminiGenerateResponse
} from '../common/gemini-protocol';

export class GoogleNativeIdeService {
    private sandboxService: ContainerSandboxService;
    private selfImprovementService: SelfImprovementService;
    private geminiService: GeminiService;
    private defaultEnvironmentId = 'scratchbox-local-default';

    constructor(
        sandboxService?: ContainerSandboxService,
        selfImprovementService?: SelfImprovementService,
        geminiService?: GeminiService
    ) {
        this.sandboxService = sandboxService || new ContainerSandboxService();
        this.selfImprovementService = selfImprovementService || new SelfImprovementService();
        this.geminiService = geminiService || new GeminiService();
    }

    /**
     * Initialize the localized workspace environment.
     */
    async initializeWorkspace(workspaceRoot: string): Promise<ContainerEnvironment> {
        return this.sandboxService.createEnvironment({
            environmentId: this.defaultEnvironmentId,
            isolationLevel: 'process-jail',
            workspaceRoot: workspaceRoot || process.cwd(),
            envVars: {
                SCRATCHBOX_IDE: '1',
                GOOGLE_GENAI_ENABLED: '1'
            }
        });
    }

    /**
     * Execute a shell command inside the localized sandbox.
     */
    async runTerminalCommand(options: LocalExecutionOptions): Promise<ExecutionResult> {
        return this.sandboxService.executeCommand(this.defaultEnvironmentId, options);
    }

    /**
     * Execute a prompt using Google Gemini with attached learned memory and project context.
     */
    async generateWithGoogleAi(request: GeminiGenerateRequest): Promise<GeminiGenerateResponse> {
        const learnedMemory = this.selfImprovementService.exportSystemInstructionMemory();
        const augmentedSystemInstruction = request.systemInstruction
            ? `${request.systemInstruction}\n\n${learnedMemory}`
            : learnedMemory;

        return this.geminiService.generateArtifact({
            ...request,
            systemInstruction: augmentedSystemInstruction
        });
    }

    /**
     * Run an iterative TDD test-and-repair cycle.
     */
    async runTddVerification(testCommand: string): Promise<{
        passed: boolean;
        result: ExecutionResult;
        repairPrompt?: string;
    }> {
        const result = await this.sandboxService.executeCommand(this.defaultEnvironmentId, {
            command: testCommand
        });

        if (result.exitCode === 0 && !result.timedOut) {
            return {
                passed: true,
                result
            };
        }

        const repairPrompt = this.selfImprovementService.buildTddCorrectionPrompt({
            testName: testCommand,
            failingFile: 'test-runner',
            sourceFile: 'workspace',
            errorOutput: result.stderr || result.stdout
        });

        return {
            passed: false,
            result,
            repairPrompt
        };
    }

    /**
     * Access underlying container sandbox service.
     */
    getSandboxService(): ContainerSandboxService {
        return this.sandboxService;
    }

    /**
     * Access self-improvement service.
     */
    getSelfImprovementService(): SelfImprovementService {
        return this.selfImprovementService;
    }
}
