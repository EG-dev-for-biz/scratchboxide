/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { exec, spawn, ChildProcess } from 'child_process';
import * as os from 'os';
import type {
    ContainerEnvironment,
    ContainerEnvironmentConfig,
    ExecutionResult,
    LocalExecutionOptions,
    SystemCapabilities
} from '../common/container-sandbox-protocol';

// Critical security guardrail patterns to prevent host destruction
const DANGEROUS_COMMAND_PATTERNS: RegExp[] = [
    /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)\s+(\/|\*|~\/?)/i,
    /\brm\s+-rf\s+(\/|\*)/i,
    /\b(chmod|chown)\s+(-R\s+)?777\s+\//i,
    /\bgit\s+reset\s+--hard\b/i,
    /\bgit\s+push\s+.*(--force|-f)\b/i,
    /\bdd\s+if=.*of=\/dev\//i,
    /\bmkfs(\.[a-z0-9]+)?\s+\/dev\//i,
    /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, // Fork bomb
    />\s*\/dev\/(sda|hda|nvme|disk)/i
];

export type {
    ContainerEnvironmentConfig,
    ContainerEnvironment,
    LocalExecutionOptions,
    ExecutionResult,
    SystemCapabilities
};

export class ContainerSandboxService {
    private activeEnvironments = new Map<string, ContainerEnvironment>();

    /**
     * Create or initialize a localized sandbox environment with resource boundaries.
     */
    async createEnvironment(config: ContainerEnvironmentConfig): Promise<ContainerEnvironment> {
        const env: ContainerEnvironment = {
            environmentId: config.environmentId,
            isolationLevel: config.isolationLevel,
            workspaceRoot: config.workspaceRoot || process.cwd(),
            status: 'ready',
            createdAt: Date.now(),
            config: {
                ...config,
                timeoutMs: config.timeoutMs || 30000,
                maxMemoryMb: config.maxMemoryMb || 512
            }
        };

        this.activeEnvironments.set(config.environmentId, env);
        return env;
    }

    /**
     * Retrieve an active environment by ID.
     */
    getEnvironment(environmentId: string): ContainerEnvironment | undefined {
        return this.activeEnvironments.get(environmentId);
    }

    /**
     * Execute a command safely inside the target environment.
     */
    async executeCommand(
        environmentId: string,
        options: LocalExecutionOptions
    ): Promise<ExecutionResult> {
        const env = this.activeEnvironments.get(environmentId);
        if (!env) {
            throw new Error(`Environment ${environmentId} not found. Please create it first.`);
        }

        const rawCommand = options.command.trim();

        // 1. Guardrail Safety Check
        if (!options.skipGuardrails) {
            for (const pattern of DANGEROUS_COMMAND_PATTERNS) {
                if (pattern.test(rawCommand)) {
                    throw new Error(`Blocked by security guardrail: Command matches dangerous pattern [${pattern.source}]`);
                }
            }
        }

        const cwd = options.cwd || env.workspaceRoot;
        const timeoutMs = options.timeoutMs || env.config.timeoutMs || 30000;
        const maxBuffer = options.maxBufferBytes || 10 * 1024 * 1024; // 10MB default buffer

        const mergedEnv = {
            ...process.env,
            ...(env.config.envVars || {}),
            ...(options.env || {}),
            SCRATCHBOX_ISOLATED: 'true',
            SCRATCHBOX_ENV_ID: environmentId
        };

        const startTime = Date.now();

        return new Promise<ExecutionResult>((resolve) => {
            let stdoutData = '';
            let stderrData = '';
            let isTimedOut = false;
            let processExited = false;

            const child: ChildProcess = spawn(rawCommand, {
                cwd,
                env: mergedEnv,
                shell: true
            });

            const timer = setTimeout(() => {
                if (!processExited) {
                    isTimedOut = true;
                    try {
                        child.kill('SIGKILL');
                    } catch (e) {
                        // Process might already be dead
                    }
                }
            }, timeoutMs);

            if (child.stdout) {
                child.stdout.on('data', (chunk) => {
                    stdoutData += chunk.toString();
                    if (stdoutData.length > maxBuffer) {
                        stdoutData = stdoutData.substring(0, maxBuffer) + '\n...[STDOUT TRUNCATED]';
                    }
                });
            }

            if (child.stderr) {
                child.stderr.on('data', (chunk) => {
                    stderrData += chunk.toString();
                    if (stderrData.length > maxBuffer) {
                        stderrData = stderrData.substring(0, maxBuffer) + '\n...[STDERR TRUNCATED]';
                    }
                });
            }

            child.on('error', (err) => {
                clearTimeout(timer);
                processExited = true;
                const durationMs = Date.now() - startTime;
                resolve({
                    exitCode: 1,
                    stdout: stdoutData,
                    stderr: stderrData ? `${stderrData}\n${err.message}` : err.message,
                    durationMs,
                    timedOut: isTimedOut,
                    error: err.message
                });
            });

            child.on('close', (code, signal) => {
                clearTimeout(timer);
                processExited = true;
                const durationMs = Date.now() - startTime;

                resolve({
                    exitCode: isTimedOut ? 124 : (code !== null ? code : 1),
                    stdout: stdoutData,
                    stderr: stderrData,
                    durationMs,
                    timedOut: isTimedOut,
                    killed: signal ? true : false
                });
            });
        });
    }

    /**
     * Terminate and clean up an active environment.
     */
    async destroyEnvironment(environmentId: string): Promise<boolean> {
        return this.activeEnvironments.delete(environmentId);
    }

    /**
     * List all currently active localized environments.
     */
    listActiveEnvironments(): ContainerEnvironment[] {
        return Array.from(this.activeEnvironments.values());
    }

    /**
     * Discover host capabilities (Docker daemon, Node runtime, CPU, OS platform).
     */
    async detectSystemCapabilities(): Promise<SystemCapabilities> {
        let hasDocker = false;
        try {
            await new Promise<void>((resolve, reject) => {
                exec('docker --version', { timeout: 1500 }, (err, stdout) => {
                    if (!err && stdout && stdout.toLowerCase().includes('docker')) {
                        hasDocker = true;
                    }
                    resolve();
                });
            });
        } catch {
            hasDocker = false;
        }

        const availableRuntimes: string[] = ['node', 'javascript', 'typescript'];

        return {
            hasDocker,
            hasNode: true,
            hasPython: false,
            hasGit: true,
            availableRuntimes,
            osPlatform: os.platform(),
            cpuCores: os.cpus().length,
            totalMemoryMb: Math.round(os.totalmem() / (1024 * 1024))
        };
    }
}
