/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { Emitter, Event, IDisposable, toDisposable } from '../events';
import { ICommandRegistry } from './commands';
import { IContextKeyService } from './contextkey';

export type Platform = 'darwin' | 'win32' | 'linux' | 'all';

export interface IKeybinding {
    command: string;
    keybinding: string;
    when?: string;
    platform?: Platform;
    args?: any;
}

export type KeybindingResolution =
    | { status: 'matched'; commandId: string; args?: any }
    | { status: 'chord_pending'; chordPrefix: string }
    | { status: 'unmatched' };

export class KeybindingRegistry implements IDisposable {
    private readonly _keybindings: IKeybinding[] = [];
    private readonly _onDidRegisterKeybinding = new Emitter<IKeybinding>();
    private _pendingChord: string | null = null;
    private _chordTimer: any = null;

    readonly onDidRegisterKeybinding: Event<IKeybinding> = this._onDidRegisterKeybinding.event;

    get commandRegistry(): ICommandRegistry | undefined {
        return this._commandRegistry;
    }

    get contextKeyService(): IContextKeyService | undefined {
        return this._contextKeyService;
    }

    constructor(
        private readonly _commandRegistry?: ICommandRegistry,
        private readonly _contextKeyService?: IContextKeyService,
        private readonly _defaultPlatform: Platform = typeof process !== 'undefined' && process.platform === 'darwin' ? 'darwin' : 'linux'
    ) {}

    registerKeybinding(keybinding: IKeybinding): IDisposable {
        this._keybindings.push(keybinding);
        this._onDidRegisterKeybinding.fire(keybinding);

        return toDisposable(() => {
            const idx = this._keybindings.indexOf(keybinding);
            if (idx !== -1) {
                this._keybindings.splice(idx, 1);
            }
        });
    }

    getKeybindings(): IKeybinding[] {
        return [...this._keybindings];
    }

    getKeybindingsForCommand(commandId: string): IKeybinding[] {
        return this._keybindings.filter(k => k.command === commandId);
    }

    resetChordState(): void {
        this._pendingChord = null;
        if (this._chordTimer) {
            clearTimeout(this._chordTimer);
            this._chordTimer = null;
        }
    }

    resolveKeypress(rawKey: string, platform: Platform = this._defaultPlatform): KeybindingResolution {
        const normalizedKey = this._normalizeKeypress(rawKey, platform);
        const currentSequence = this._pendingChord ? `${this._pendingChord} ${normalizedKey}` : normalizedKey;

        // Find candidate bindings for this platform
        const activeBindings = this._keybindings.filter(kb => {
            if (kb.platform && kb.platform !== 'all' && kb.platform !== platform) {
                return false;
            }
            if (this._contextKeyService && kb.when) {
                if (!this._contextKeyService.evaluate(kb.when)) {
                    return false;
                }
            }
            return true;
        });

        // Check for exact full match
        const exactMatch = activeBindings.find(kb => {
            const normalizedBinding = this._normalizeBindingString(kb.keybinding, platform);
            return normalizedBinding === currentSequence;
        });

        if (exactMatch) {
            this.resetChordState();
            return {
                status: 'matched',
                commandId: exactMatch.command,
                args: exactMatch.args
            };
        }

        // Check if currentSequence is a prefix of any multi-chord keybinding
        const isPrefix = activeBindings.some(kb => {
            const normalizedBinding = this._normalizeBindingString(kb.keybinding, platform);
            return normalizedBinding.startsWith(`${currentSequence} `);
        });

        if (isPrefix) {
            this._pendingChord = currentSequence;
            if (this._chordTimer) {
                clearTimeout(this._chordTimer);
            }
            this._chordTimer = setTimeout(() => {
                this.resetChordState();
            }, 1500);

            return {
                status: 'chord_pending',
                chordPrefix: currentSequence
            };
        }

        this.resetChordState();
        return { status: 'unmatched' };
    }

    private _normalizeKeypress(raw: string, platform: Platform): string {
        const parts = raw.split('+').map(p => p.trim());
        const modifiers: string[] = [];
        let key = '';

        for (const p of parts) {
            const lower = p.toLowerCase();
            if (lower === 'cmd' || lower === 'command' || lower === 'meta') {
                modifiers.push(platform === 'darwin' ? 'Meta' : 'Ctrl');
            } else if (lower === 'ctrl' || lower === 'control') {
                modifiers.push('Ctrl');
            } else if (lower === 'alt' || lower === 'opt' || lower === 'option') {
                modifiers.push('Alt');
            } else if (lower === 'shift') {
                modifiers.push('Shift');
            } else {
                key = p;
            }
        }

        // Normalize single letters to KeyX if passed as single letter or KeyX
        if (/^[a-zA-Z]$/.test(key)) {
            key = `Key${key.toUpperCase()}`;
        }

        modifiers.sort();
        return [...modifiers, key].filter(Boolean).join('+');
    }

    private _normalizeBindingString(binding: string, platform: Platform): string {
        const chords = binding.split(/\s+/).filter(Boolean);
        return chords.map(chord => this._normalizeKeypress(chord, platform)).join(' ');
    }

    dispose(): void {
        this.resetChordState();
        this._onDidRegisterKeybinding.dispose();
        this._keybindings.length = 0;
    }
}
