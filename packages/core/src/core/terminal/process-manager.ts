/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as child_process from 'child_process';
import { CancellationToken, CancellationError, Emitter, Event, IDisposable } from '../events';

export interface IProcessOptions {
    cwd?: string;
    env?: Record<string, string>;
    timeout?: number;
    cancellationToken?: CancellationToken;
    onStdout?: (data: string) => void;
    onStderr?: (data: string) => void;
    shell?: boolean | string;
}

export interface IProcessResult {
    exitCode: number | null;
    signal?: string | null;
    stdout: string;
    stderr: string;
    killed?: boolean;
}

export interface IProcessExecution extends IDisposable {
    readonly pid?: number;
    readonly onStdout: Event<string>;
    readonly onStderr: Event<string>;
    readonly onExit: Event<{ exitCode: number | null; signal: string | null }>;
    readonly promise: Promise<IProcessResult>;
    kill(signal?: NodeJS.Signals | number): void;
}

export class ProcessManager implements IDisposable {
    private readonly _activeExecutions = new Set<IProcessExecution>();

    spawn(command: string, args: string[] = [], options: IProcessOptions = {}): IProcessExecution {
        const onStdoutEmitter = new Emitter<string>();
        const onStderrEmitter = new Emitter<string>();
        const onExitEmitter = new Emitter<{ exitCode: number | null; signal: string | null }>();

        let stdoutBuf = '';
        let stderrBuf = '';
        let killed = false;
        let timeoutHandle: any = null;
        let tokenSub: IDisposable | null = null;

        const mergedEnv = options.env ? { ...process.env, ...options.env } : process.env;

        const child = child_process.spawn(command, args, {
            cwd: options.cwd || process.cwd(),
            env: mergedEnv,
            shell: options.shell ?? false
        });

        const pid = child.pid;

        if (child.stdout) {
            child.stdout.on('data', chunk => {
                const text = chunk.toString('utf-8');
                stdoutBuf += text;
                onStdoutEmitter.fire(text);
                if (options.onStdout) {
                    options.onStdout(text);
                }
            });
        }

        if (child.stderr) {
            child.stderr.on('data', chunk => {
                const text = chunk.toString('utf-8');
                stderrBuf += text;
                onStderrEmitter.fire(text);
                if (options.onStderr) {
                    options.onStderr(text);
                }
            });
        }

        const promise = new Promise<IProcessResult>((resolve, reject) => {
            if (options.timeout && options.timeout > 0) {
                timeoutHandle = setTimeout(() => {
                    killed = true;
                    try {
                        child.kill('SIGTERM');
                    } catch { }
                    setTimeout(() => {
                        try {
                            child.kill('SIGKILL');
                        } catch { }
                    }, 500);
                }, options.timeout);
            }

            if (options.cancellationToken) {
                if (options.cancellationToken.isCancellationRequested) {
                    killed = true;
                    try {
                        child.kill('SIGTERM');
                    } catch { }
                    reject(new CancellationError('Process cancelled before start'));
                    return;
                }
                tokenSub = options.cancellationToken.onCancellationRequested(() => {
                    killed = true;
                    try {
                        child.kill('SIGTERM');
                    } catch { }
                });
            }

            child.on('error', err => {
                cleanup();
                reject(err);
            });

            child.on('close', (exitCode, signal) => {
                cleanup();
                onExitEmitter.fire({ exitCode, signal });

                if (killed || (options.cancellationToken && options.cancellationToken.isCancellationRequested)) {
                    reject(new CancellationError(`Process was killed or cancelled (signal: ${signal})`));
                    return;
                }

                resolve({
                    exitCode,
                    signal,
                    stdout: stdoutBuf,
                    stderr: stderrBuf,
                    killed
                });
            });
        });

        const cleanup = () => {
            if (timeoutHandle) {
                clearTimeout(timeoutHandle);
                timeoutHandle = null;
            }
            if (tokenSub) {
                tokenSub.dispose();
                tokenSub = null;
            }
            this._activeExecutions.delete(execution);
        };

        const execution: IProcessExecution = {
            pid,
            onStdout: onStdoutEmitter.event,
            onStderr: onStderrEmitter.event,
            onExit: onExitEmitter.event,
            promise,
            kill: (signal?: NodeJS.Signals | number) => {
                killed = true;
                try {
                    child.kill(signal || 'SIGTERM');
                } catch { }
            },
            dispose: () => {
                cleanup();
                try {
                    child.kill('SIGTERM');
                } catch { }
                onStdoutEmitter.dispose();
                onStderrEmitter.dispose();
                onExitEmitter.dispose();
            }
        };

        this._activeExecutions.add(execution);
        return execution;
    }

    async exec(command: string, args: string[] = [], options: IProcessOptions = {}): Promise<IProcessResult> {
        const execution = this.spawn(command, args, options);
        return execution.promise;
    }

    dispose(): void {
        for (const exec of this._activeExecutions) {
            exec.dispose();
        }
        this._activeExecutions.clear();
    }
}
