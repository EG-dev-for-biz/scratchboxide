/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

export type SandboxIsolationLevel = 'process-jail' | 'docker-container' | 'webassembly' | 'unrestricted';

export interface ContainerEnvironmentConfig {
    environmentId: string;
    isolationLevel: SandboxIsolationLevel;
    workspaceRoot: string;
    envVars?: Record<string, string>;
    timeoutMs?: number;
    maxMemoryMb?: number;
    dockerImage?: string;
    allowedDirectories?: string[];
}

export interface ContainerEnvironment {
    environmentId: string;
    isolationLevel: SandboxIsolationLevel;
    workspaceRoot: string;
    status: 'ready' | 'initializing' | 'stopped' | 'error';
    createdAt: number;
    config: ContainerEnvironmentConfig;
    error?: string;
}

export interface LocalExecutionOptions {
    command: string;
    cwd?: string;
    env?: Record<string, string>;
    timeoutMs?: number;
    maxBufferBytes?: number;
    skipGuardrails?: boolean;
}

export interface ExecutionResult {
    exitCode: number;
    stdout: string;
    stderr: string;
    durationMs: number;
    timedOut: boolean;
    killed?: boolean;
    error?: string;
}

export interface SystemCapabilities {
    hasDocker: boolean;
    hasNode: boolean;
    hasPython?: boolean;
    hasGit?: boolean;
    availableRuntimes: string[];
    osPlatform: string;
    cpuCores: number;
    totalMemoryMb: number;
}
