/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { IDisposable, toDisposable, DisposableCollection } from './disposable';

export type Event<T> = (
    listener: (e: T) => any,
    thisArgs?: any,
    disposables?: IDisposable[] | DisposableCollection
) => IDisposable;

export namespace Event {
    export const None: Event<any> = () => ({ dispose() { } });
}

export class Emitter<T> implements IDisposable {
    private _listeners = new Set<{ fn: (e: T) => any; thisArg?: any }>();
    private _disposed = false;
    private _event?: Event<T>;

    get disposed(): boolean {
        return this._disposed;
    }

    get listenerCount(): number {
        return this._listeners.size;
    }

    get event(): Event<T> {
        if (!this._event) {
            this._event = (
                listener: (e: T) => any,
                thisArgs?: any,
                disposables?: IDisposable[] | DisposableCollection
            ): IDisposable => {
                if (this._disposed) {
                    return { dispose() { } };
                }
                const entry = { fn: listener, thisArg: thisArgs };
                this._listeners.add(entry);

                const result = toDisposable(() => {
                    this._listeners.delete(entry);
                });

                if (Array.isArray(disposables)) {
                    disposables.push(result);
                } else if (disposables instanceof DisposableCollection) {
                    disposables.push(result);
                }

                return result;
            };
        }
        return this._event;
    }

    fire(event: T): void {
        if (this._disposed) {
            return;
        }
        const listenersCopy = Array.from(this._listeners);
        for (const entry of listenersCopy) {
            try {
                if (entry.thisArg) {
                    entry.fn.call(entry.thisArg, event);
                } else {
                    entry.fn(event);
                }
            } catch (err) {
                console.error('Error invoking event listener:', err);
            }
        }
    }

    dispose(): void {
        if (this._disposed) {
            return;
        }
        this._disposed = true;
        this._listeners.clear();
    }
}

export class AsyncEmitter<T> implements IDisposable {
    private _listeners = new Set<{ fn: (e: T) => Promise<any> | any; thisArg?: any }>();
    private _disposed = false;
    private _event?: Event<T>;

    get disposed(): boolean {
        return this._disposed;
    }

    get event(): Event<T> {
        if (!this._event) {
            this._event = (
                listener: (e: T) => any,
                thisArgs?: any,
                disposables?: IDisposable[] | DisposableCollection
            ): IDisposable => {
                if (this._disposed) {
                    return { dispose() { } };
                }
                const entry = { fn: listener, thisArg: thisArgs };
                this._listeners.add(entry);

                const result = toDisposable(() => {
                    this._listeners.delete(entry);
                });

                if (Array.isArray(disposables)) {
                    disposables.push(result);
                } else if (disposables instanceof DisposableCollection) {
                    disposables.push(result);
                }

                return result;
            };
        }
        return this._event;
    }

    async fireAsync(event: T): Promise<void> {
        if (this._disposed) {
            return;
        }
        const listenersCopy = Array.from(this._listeners);
        for (const entry of listenersCopy) {
            try {
                if (entry.thisArg) {
                    await entry.fn.call(entry.thisArg, event);
                } else {
                    await entry.fn(event);
                }
            } catch (err) {
                console.error('Error in fireAsync listener:', err);
            }
        }
    }

    dispose(): void {
        if (this._disposed) {
            return;
        }
        this._disposed = true;
        this._listeners.clear();
    }
}

export function debounceEvent<T, R = T>(
    event: Event<T>,
    merger: (last: R | undefined, current: T) => R,
    delay: number = 100
): Event<R> {
    return (listener: (e: R) => any, thisArgs?: any, disposables?: IDisposable[] | DisposableCollection): IDisposable => {
        let handle: any;
        let lastVal: R | undefined;

        const sub = event(current => {
            lastVal = merger(lastVal, current);
            clearTimeout(handle);
            handle = setTimeout(() => {
                const valToEmit = lastVal!;
                lastVal = undefined;
                if (thisArgs) {
                    listener.call(thisArgs, valToEmit);
                } else {
                    listener(valToEmit);
                }
            }, delay);
        });

        const dispose = toDisposable(() => {
            clearTimeout(handle);
            sub.dispose();
        });

        if (Array.isArray(disposables)) {
            disposables.push(dispose);
        } else if (disposables instanceof DisposableCollection) {
            disposables.push(dispose);
        }

        return dispose;
    };
}

export function filterEvent<T>(event: Event<T>, filter: (e: T) => boolean): Event<T> {
    return (listener: (e: T) => any, thisArgs?: any, disposables?: IDisposable[] | DisposableCollection): IDisposable => {
        return event(
            e => {
                if (filter(e)) {
                    if (thisArgs) {
                        listener.call(thisArgs, e);
                    } else {
                        listener(e);
                    }
                }
            },
            undefined,
            disposables
        );
    };
}

export function mapEvent<T, R>(event: Event<T>, map: (e: T) => R): Event<R> {
    return (listener: (e: R) => any, thisArgs?: any, disposables?: IDisposable[] | DisposableCollection): IDisposable => {
        return event(
            e => {
                const mapped = map(e);
                if (thisArgs) {
                    listener.call(thisArgs, mapped);
                } else {
                    listener(mapped);
                }
            },
            undefined,
            disposables
        );
    };
}

export function onceEvent<T>(event: Event<T>): Event<T> {
    return (listener: (e: T) => any, thisArgs?: any, disposables?: IDisposable[] | DisposableCollection): IDisposable => {
        let sub: IDisposable;
        let didFire = false;
        sub = event(
            e => {
                if (!didFire) {
                    didFire = true;
                    sub.dispose();
                    if (thisArgs) {
                        listener.call(thisArgs, e);
                    } else {
                        listener(e);
                    }
                }
            },
            undefined,
            disposables
        );
        return sub;
    };
}
