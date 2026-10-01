/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { IDisposable, toDisposable } from './disposable';

export class CancellationError extends Error {
    constructor(message: string = 'Operation cancelled') {
        super(message);
        this.name = 'CancellationError';
    }
}

export interface CancellationToken {
    readonly isCancellationRequested: boolean;
    readonly onCancellationRequested: (listener: (e: void) => any) => IDisposable;
}

class MutableToken implements CancellationToken {
    private _isCancelled = false;
    private readonly _listeners = new Set<(e: void) => any>();

    get isCancellationRequested(): boolean {
        return this._isCancelled;
    }

    readonly onCancellationRequested = (listener: (e: void) => any): IDisposable => {
        if (this._isCancelled) {
            listener();
            return { dispose() { } };
        }
        this._listeners.add(listener);
        return toDisposable(() => {
            this._listeners.delete(listener);
        });
    };

    cancel(): void {
        if (this._isCancelled) {
            return;
        }
        this._isCancelled = true;
        for (const listener of this._listeners) {
            try {
                listener();
            } catch (err) {
                console.error('Error in onCancellationRequested listener:', err);
            }
        }
        this._listeners.clear();
    }
}

export class CancellationTokenSource implements IDisposable {
    private readonly _token = new MutableToken();

    get token(): CancellationToken {
        return this._token;
    }

    cancel(): void {
        this._token.cancel();
    }

    dispose(): void {
        this.cancel();
    }
}
