/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
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
    /**
     * Set only by a caller acting on an explicit user action. Unlocks commands
     * outside the default allowlist; destructive commands stay blocked.
     */
    confirmedByUser?: boolean;
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
