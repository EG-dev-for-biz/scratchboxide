/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { Emitter, Event, IDisposable, toDisposable } from '../events';
import { IContextKeyService } from './contextkey';

export interface ICommand {
    id: string;
    title?: string;
    category?: string;
    icon?: string;
    when?: string;
    handler: (...args: any[]) => any;
}

export interface ICommandRegistry {
    registerCommand(command: ICommand): IDisposable;
    registerHandler(id: string, handler: (...args: any[]) => any): IDisposable;
    executeCommand<T = any>(id: string, ...args: any[]): Promise<T>;
    hasCommand(id: string): boolean;
    getCommand(id: string): ICommand | undefined;
    getCommands(): ICommand[];
    isEnabled(id: string): boolean;
    readonly onDidRegisterCommand: Event<string>;
    readonly onDidExecuteCommand: Event<{ id: string; args: any[]; result?: any; error?: any }>;
}

export class CommandRegistry implements ICommandRegistry, IDisposable {
    private readonly _commands = new Map<string, ICommand>();
    private readonly _onDidRegisterCommand = new Emitter<string>();
    private readonly _onDidExecuteCommand = new Emitter<{ id: string; args: any[]; result?: any; error?: any }>();

    readonly onDidRegisterCommand: Event<string> = this._onDidRegisterCommand.event;
    readonly onDidExecuteCommand: Event<{ id: string; args: any[]; result?: any; error?: any }> = this._onDidExecuteCommand.event;

    constructor(private readonly _contextKeyService?: IContextKeyService) {}

    registerCommand(command: ICommand): IDisposable {
        if (!command.id) {
            throw new Error('Command id is required for registration');
        }
        this._commands.set(command.id, command);
        this._onDidRegisterCommand.fire(command.id);

        return toDisposable(() => {
            if (this._commands.get(command.id) === command) {
                this._commands.delete(command.id);
            }
        });
    }

    registerHandler(id: string, handler: (...args: any[]) => any): IDisposable {
        const existing = this._commands.get(id);
        if (existing) {
            const oldHandler = existing.handler;
            existing.handler = handler;
            return toDisposable(() => {
                existing.handler = oldHandler;
            });
        }
        return this.registerCommand({ id, handler });
    }

    async executeCommand<T = any>(id: string, ...args: any[]): Promise<T> {
        const command = this._commands.get(id);
        if (!command) {
            const err = new Error(`Command not found: ${id}`);
            this._onDidExecuteCommand.fire({ id, args, error: err });
            throw err;
        }

        if (this._contextKeyService && command.when) {
            const enabled = this._contextKeyService.evaluate(command.when);
            if (!enabled) {
                const err = new Error(`Command ${id} is disabled by context condition: ${command.when}`);
                this._onDidExecuteCommand.fire({ id, args, error: err });
                throw err;
            }
        }

        try {
            const result = await Promise.resolve(command.handler(...args));
            this._onDidExecuteCommand.fire({ id, args, result });
            return result as T;
        } catch (error) {
            this._onDidExecuteCommand.fire({ id, args, error });
            throw error;
        }
    }

    hasCommand(id: string): boolean {
        return this._commands.has(id);
    }

    getCommand(id: string): ICommand | undefined {
        return this._commands.get(id);
    }

    getCommands(): ICommand[] {
        return Array.from(this._commands.values());
    }

    isEnabled(id: string): boolean {
        const command = this._commands.get(id);
        if (!command) {
            return false;
        }
        if (!command.when || !this._contextKeyService) {
            return true;
        }
        return this._contextKeyService.evaluate(command.when);
    }

    dispose(): void {
        this._onDidRegisterCommand.dispose();
        this._onDidExecuteCommand.dispose();
        this._commands.clear();
    }
}
