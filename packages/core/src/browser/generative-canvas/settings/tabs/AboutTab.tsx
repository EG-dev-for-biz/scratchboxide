/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/** AboutTab content of the Customize settings group. Extracted verbatim from SettingsModal.tsx. */
import * as React from 'react';
import { useSettingsContext } from '../SettingsContext';

export const AboutTab: React.FC = () => {
    return (
        <div className="sb-cursor-settings-content animate-fadeIn">
            <h2 className="sb-cursor-content-title">About Scratchbox IDE</h2>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mb-4">
                Architecture runtime specifications, AI model orchestration, and license information.
            </p>
            <div className="sb-cursor-group-card p-6 space-y-4 text-center">
                <div style={{ width: '64px', height: '64px', borderRadius: '18px', background: 'linear-gradient(135deg, #27272a 0%, #09090b 100%)', border: '1px solid rgba(255, 255, 255, 0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto', padding: '10px', boxShadow: '0 12px 32px rgba(0, 0, 0, 0.35)', backdropFilter: 'blur(12px)' }}>
                    <img src="/icons/ScratchboxIDE.png" alt="Scratchbox IDE Logo" style={{ width: '100%', height: '100%', objectFit: 'contain', filter: 'drop-shadow(0 2px 8px rgba(255,255,255,0.2))' }} />
                </div>
                <div>
                    <h3 className="text-base font-bold text-zinc-900 dark:text-white">Scratchbox IDE</h3>
                    <div className="text-xs text-blue-500 dark:text-blue-400 font-mono font-semibold mt-0.5">Version 1.67.100 · Scratchbox Canvas 2.0</div>
                    <p className="text-xs text-zinc-500 dark:text-zinc-400 max-w-md mx-auto mt-2">
                        Universal AI Software Architecture &amp; Intelligence Environment with WebAssembly and local sandbox runtime.
                    </p>
                </div>

                <div className="grid grid-cols-2 gap-3 max-w-md mx-auto text-left pt-2">
                    <div className="p-3 bg-zinc-100/70 dark:bg-zinc-900/80 rounded-xl border border-zinc-200 dark:border-zinc-800">
                        <div className="text-xs uppercase font-bold tracking-wider text-zinc-500 dark:text-zinc-400">Primary Model</div>
                        <div className="text-xs font-semibold text-zinc-800 dark:text-zinc-200 mt-0.5">Gemini 3.7 Flash</div>
                    </div>
                    <div className="p-3 bg-zinc-100/70 dark:bg-zinc-900/80 rounded-xl border border-zinc-200 dark:border-zinc-800">
                        <div className="text-xs uppercase font-bold tracking-wider text-zinc-500 dark:text-zinc-400">Subagent Pool</div>
                        <div className="text-xs font-semibold text-zinc-800 dark:text-zinc-200 mt-0.5">Gemini 3.5 Flash Lite (64x)</div>
                    </div>
                    <div className="p-3 bg-zinc-100/70 dark:bg-zinc-900/80 rounded-xl border border-zinc-200 dark:border-zinc-800">
                        <div className="text-xs uppercase font-bold tracking-wider text-zinc-500 dark:text-zinc-400">Design System</div>
                        <div className="text-xs font-semibold text-zinc-800 dark:text-zinc-200 mt-0.5">Apple Liquid Glass HIG</div>
                    </div>
                    <div className="p-3 bg-zinc-100/70 dark:bg-zinc-900/80 rounded-xl border border-zinc-200 dark:border-zinc-800">
                        <div className="text-xs uppercase font-bold tracking-wider text-zinc-500 dark:text-zinc-400">License</div>
                        <div className="text-xs font-semibold text-zinc-800 dark:text-zinc-200 mt-0.5">MIT Open License</div>
                    </div>
                </div>

                <div className="flex items-center justify-center gap-3 pt-2">
                    <button
                        type="button"
                        className="sb-cursor-row-btn"
                        onClick={() => {
                            if (typeof window !== 'undefined') window.open('https://github.com/scratchbox/scratchbox-ide', '_blank');
                        }}
                    >
                        <span>GitHub Repository</span>
                    </button>
                    <button
                        type="button"
                        className="sb-btn sb-btn-primary sb-btn-sm"
                        onClick={() => {
                            if (typeof window !== 'undefined') window.open('https://www.scratchbox.ai', '_blank');
                        }}
                    >
                        <span>Visit scratchbox.ai</span>
                    </button>
                </div>
            </div>
        </div>
    );
};
