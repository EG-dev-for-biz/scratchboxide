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
    const {  } = useSettingsContext();
    return (
        <div className="space-y-4">
            <div className="sb-cursor-group-card p-6 space-y-4 text-center">
                <div className="w-12 h-12 rounded-2xl bg-gradient-to-tr from-blue-600 to-indigo-600 flex items-center justify-center mx-auto shadow-lg shadow-blue-500/20 text-white font-black text-xl">
                    SB
                </div>
                <div>
                    <h3 className="text-base font-bold text-white">Scratchbox IDE</h3>
                    <div className="text-xs text-blue-400 font-mono font-semibold mt-0.5">Version 1.67.100 · Scratchbox Canvas 2.0</div>
                    <p className="text-xs text-zinc-400 max-w-md mx-auto mt-2">
                        Universal AI Software Architecture &amp; Intelligence Environment with WebAssembly and local sandbox runtime.
                    </p>
                </div>

                <div className="grid grid-cols-2 gap-3 max-w-md mx-auto text-left pt-2">
                    <div className="p-3 bg-zinc-900/80 rounded-xl border border-zinc-800">
                        <div className="text-[10px] uppercase font-bold text-zinc-500">Primary Model</div>
                        <div className="text-xs font-semibold text-zinc-200 mt-0.5">Gemini 3.7 Flash</div>
                    </div>
                    <div className="p-3 bg-zinc-900/80 rounded-xl border border-zinc-800">
                        <div className="text-[10px] uppercase font-bold text-zinc-500">Subagent Pool</div>
                        <div className="text-xs font-semibold text-zinc-200 mt-0.5">Gemini 3.5 Flash Lite (64x)</div>
                    </div>
                    <div className="p-3 bg-zinc-900/80 rounded-xl border border-zinc-800">
                        <div className="text-[10px] uppercase font-bold text-zinc-500">Design System</div>
                        <div className="text-xs font-semibold text-zinc-200 mt-0.5">Apple Liquid Glass HIG</div>
                    </div>
                    <div className="p-3 bg-zinc-900/80 rounded-xl border border-zinc-800">
                        <div className="text-[10px] uppercase font-bold text-zinc-500">License</div>
                        <div className="text-xs font-semibold text-zinc-200 mt-0.5">MIT Open License</div>
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
