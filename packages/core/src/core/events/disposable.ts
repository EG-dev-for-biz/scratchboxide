/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

export interface IDisposable {
    dispose(): void | Promise<void>;
}

export type DisposableLike = IDisposable | (() => void);

export function toDisposable(fn: () => void): IDisposable {
    let disposed = false;
    return {
        dispose: () => {
            if (!disposed) {
                disposed = true;
                fn();
            }
        }
    };
}

export class Disposable implements IDisposable {
    static readonly None: IDisposable = Object.freeze({ dispose() { } });

    static create(func: () => void): IDisposable {
        return toDisposable(func);
    }

    private _toDispose = new Set<IDisposable>();
    private _isDisposed = false;

    get isDisposed(): boolean {
        return this._isDisposed;
    }

    protected _register<T extends IDisposable>(t: T): T {
        if (this._isDisposed) {
            t.dispose();
        } else {
            this._toDispose.add(t);
        }
        return t;
    }

    dispose(): void {
        if (this._isDisposed) {
            return;
        }
        this._isDisposed = true;
        for (const item of this._toDispose) {
            try {
                item.dispose();
            } catch (err) {
                console.error('Error during disposable cleanup:', err);
            }
        }
        this._toDispose.clear();
    }
}

export class DisposableCollection implements IDisposable {
    private readonly disposables: IDisposable[] = [];
    private _disposed = false;

    get disposed(): boolean {
        return this._disposed;
    }

    push(...toDispose: DisposableLike[]): void {
        if (this._disposed) {
            for (const item of toDispose) {
                if (typeof item === 'function') {
                    item();
                } else if (item && typeof item.dispose === 'function') {
                    item.dispose();
                }
            }
            return;
        }

        for (const item of toDispose) {
            if (typeof item === 'function') {
                this.disposables.push(toDisposable(item));
            } else if (item && typeof item.dispose === 'function') {
                this.disposables.push(item);
            }
        }
    }

    add(toDispose: DisposableLike): IDisposable {
        const disposable = typeof toDispose === 'function' ? toDisposable(toDispose) : toDispose;
        this.push(disposable);
        return toDisposable(() => {
            const idx = this.disposables.indexOf(disposable);
            if (idx !== -1) {
                this.disposables.splice(idx, 1);
                disposable.dispose();
            }
        });
    }

    dispose(): void {
        if (this._disposed) {
            return;
        }
        this._disposed = true;
        while (this.disposables.length > 0) {
            const item = this.disposables.pop();
            if (item) {
                try {
                    item.dispose();
                } catch (err) {
                    console.error('Error disposing DisposableCollection item:', err);
                }
            }
        }
    }
}

export function combinedDisposable(...disposables: IDisposable[]): IDisposable {
    return toDisposable(() => {
        for (const d of disposables) {
            try {
                d.dispose();
            } catch (err) {
                console.error('Error disposing combined disposable item:', err);
            }
        }
    });
}
