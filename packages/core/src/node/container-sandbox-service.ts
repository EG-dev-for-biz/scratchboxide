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
import { resolveWithinRoot } from './security/path-guard';
import {
    assertCommandAllowed,
    buildScrubbedEnv,
    SandboxCommandRejectedError
} from './security/sandbox-policy';

export { SandboxCommandRejectedError, DEFAULT_COMMAND_ALLOWLIST } from './security/sandbox-policy';

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

        const rawCommand = (options.command || '').trim();

        // 1. Confine the working directory to the environment's workspace root.
        //    Throws PathTraversalError (code: 'path_traversal') on escape.
        const cwd = resolveWithinRoot(env.workspaceRoot, options.cwd || '.');

        // 2. Command policy: allowlist + hard denylist. Throws SandboxCommandRejectedError
        //    (code: 'command_not_allowed') unless the caller passes confirmedByUser from a real user action.
        assertCommandAllowed(rawCommand, {
            cwd,
            confirmedByUser: options.confirmedByUser === true
        });

        const timeoutMs = options.timeoutMs || env.config.timeoutMs || 30000;
        const maxBuffer = options.maxBufferBytes || 10 * 1024 * 1024; // 10MB default buffer

        // 3. Scrubbed environment: small host allowlist + explicit vars, secrets removed.
        const mergedEnv = buildScrubbedEnv(process.env, env.config.envVars, options.env, {
            SCRATCHBOX_ISOLATED: 'true',
            SCRATCHBOX_ENV_ID: environmentId
        });

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
