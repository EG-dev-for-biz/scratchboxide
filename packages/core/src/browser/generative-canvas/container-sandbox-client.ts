/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import {
    ContainerEnvironment,
    ContainerEnvironmentConfig,
    ExecutionResult,
    LocalExecutionOptions,
    SystemCapabilities
} from '../../common/container-sandbox-protocol';

export class ContainerSandboxClient {
    private static instance: ContainerSandboxClient;

    public static getInstance(): ContainerSandboxClient {
        if (!ContainerSandboxClient.instance) {
            ContainerSandboxClient.instance = new ContainerSandboxClient();
        }
        return ContainerSandboxClient.instance;
    }

    protected endpoint(): string {
        return '/sandbox';
    }

    /**
     * Request creation of a localized sandbox environment.
     */
    async createEnvironment(config: ContainerEnvironmentConfig): Promise<ContainerEnvironment> {
        const res = await fetch(`${this.endpoint()}/create`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(config)
        });
        if (!res.ok) {
            throw new Error(`Failed to create sandbox: ${await res.text()}`);
        }
        return await res.json();
    }

    /**
     * Execute a command safely in the isolated sandbox.
     */
    async executeCommand(environmentId: string, options: LocalExecutionOptions): Promise<ExecutionResult> {
        const res = await fetch(`${this.endpoint()}/execute`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ environmentId, options })
        });
        if (!res.ok) {
            throw new Error(`Execution failed: ${await res.text()}`);
        }
        return await res.json();
    }

    /**
     * Query host capabilities.
     */
    async getCapabilities(): Promise<SystemCapabilities> {
        try {
            const res = await fetch(`${this.endpoint()}/capabilities`);
            if (res.ok) {
                return await res.json();
            }
        } catch {
            // Fallback
        }
        return {
            hasDocker: false,
            hasNode: true,
            availableRuntimes: ['node', 'typescript'],
            osPlatform: 'browser',
            cpuCores: navigator.hardwareConcurrency || 4,
            totalMemoryMb: 4096
        };
    }
}
