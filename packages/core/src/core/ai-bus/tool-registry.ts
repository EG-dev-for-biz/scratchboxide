/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { CancellationToken, Emitter, Event, IDisposable, toDisposable } from '../events';

export interface JSONSchemaProperty {
    type?: 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array' | string;
    description?: string;
    enum?: any[];
    properties?: Record<string, JSONSchemaProperty>;
    items?: JSONSchemaProperty;
    required?: string[];
}

export interface JSONSchema {
    type: 'object' | string;
    properties?: Record<string, JSONSchemaProperty>;
    required?: string[];
    description?: string;
}

export interface IToolExecutionContext {
    cancellationToken?: CancellationToken;
    sessionId?: string;
    logger?: (message: string) => void;
}

export interface IToolDefinition<TArgs = any, TResult = any> {
    name: string;
    description: string;
    parameters?: JSONSchema;
    handler: (args: TArgs, context?: IToolExecutionContext) => Promise<TResult> | TResult;
}

export type ToolMiddleware = (
    tool: IToolDefinition,
    args: any,
    next: () => Promise<any>
) => Promise<any>;

export class ToolRegistry implements IDisposable {
    private readonly _tools = new Map<string, IToolDefinition>();
    private readonly _middlewares: ToolMiddleware[] = [];
    private readonly _onDidRegisterTool = new Emitter<string>();
    private readonly _onDidInvokeTool = new Emitter<{ name: string; args: any; result?: any; error?: any }>();

    readonly onDidRegisterTool: Event<string> = this._onDidRegisterTool.event;
    readonly onDidInvokeTool: Event<{ name: string; args: any; result?: any; error?: any }> = this._onDidInvokeTool.event;

    registerTool(tool: IToolDefinition): IDisposable {
        if (!tool.name) {
            throw new Error('Tool definition must have a name');
        }
        this._tools.set(tool.name, tool);
        this._onDidRegisterTool.fire(tool.name);

        return toDisposable(() => {
            if (this._tools.get(tool.name) === tool) {
                this._tools.delete(tool.name);
            }
        });
    }

    hasTool(name: string): boolean {
        return this._tools.has(name);
    }

    getTool(name: string): IToolDefinition | undefined {
        return this._tools.get(name);
    }

    getTools(): IToolDefinition[] {
        return Array.from(this._tools.values());
    }

    addMiddleware(middleware: ToolMiddleware): IDisposable {
        this._middlewares.push(middleware);
        return toDisposable(() => {
            const idx = this._middlewares.indexOf(middleware);
            if (idx !== -1) {
                this._middlewares.splice(idx, 1);
            }
        });
    }

    validateArgs(tool: IToolDefinition, args: any): { valid: boolean; errors: string[] } {
        const errors: string[] = [];
        if (!tool.parameters) {
            return { valid: true, errors };
        }

        if (tool.parameters.type === 'object' && (typeof args !== 'object' || args === null)) {
            errors.push('Expected arguments object');
            return { valid: false, errors };
        }

        const required = tool.parameters.required || [];
        for (const req of required) {
            if (args === undefined || args === null || args[req] === undefined) {
                errors.push(`Missing required parameter: '${req}'`);
            }
        }

        const props = tool.parameters.properties || {};
        for (const [key, propDef] of Object.entries(props)) {
            const val = args ? args[key] : undefined;
            if (val !== undefined && propDef.type) {
                const actualType = Array.isArray(val) ? 'array' : typeof val;
                if (propDef.type === 'number' || propDef.type === 'integer') {
                    if (typeof val !== 'number' || isNaN(val)) {
                        errors.push(`Parameter '${key}' must be a ${propDef.type}, got ${typeof val}`);
                    }
                } else if (actualType !== propDef.type) {
                    errors.push(`Parameter '${key}' must be a ${propDef.type}, got ${actualType}`);
                }
            }
        }

        return { valid: errors.length === 0, errors };
    }

    async invokeTool(name: string, args: any, context?: IToolExecutionContext): Promise<any> {
        const tool = this._tools.get(name);
        if (!tool) {
            const err = new Error(`Tool not found: ${name}`);
            this._onDidInvokeTool.fire({ name, args, error: err });
            throw err;
        }

        if (context?.cancellationToken?.isCancellationRequested) {
            const err = new Error(`Tool invocation for '${name}' cancelled`);
            this._onDidInvokeTool.fire({ name, args, error: err });
            throw err;
        }

        const validation = this.validateArgs(tool, args);
        if (!validation.valid) {
            const err = new Error(`Schema validation failed for tool '${name}': ${validation.errors.join('; ')}`);
            this._onDidInvokeTool.fire({ name, args, error: err });
            throw err;
        }

        // Run through middlewares
        let index = 0;
        const next = async (): Promise<any> => {
            if (index < this._middlewares.length) {
                const mw = this._middlewares[index++];
                return mw(tool, args, next);
            }
            return tool.handler(args, context);
        };

        try {
            const result = await next();
            this._onDidInvokeTool.fire({ name, args, result });
            return result;
        } catch (error) {
            this._onDidInvokeTool.fire({ name, args, error });
            throw error;
        }
    }

    dispose(): void {
        this._tools.clear();
        this._middlewares.length = 0;
        this._onDidRegisterTool.dispose();
        this._onDidInvokeTool.dispose();
    }
}
