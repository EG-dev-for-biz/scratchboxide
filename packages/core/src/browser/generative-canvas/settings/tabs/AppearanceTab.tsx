/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/** Appearance settings tab. Extracted verbatim from SettingsModal.tsx. */
import * as React from 'react';
import { useSettingsContext } from '../SettingsContext';

export const AppearanceTab: React.FC = () => {
    const { codeBlockWordWrap, codeFontFamily, codeFontSize, colorHue, colorIntensity, followSystemHighContrast, fontSmoothing, reduceMotionSetting, reduceTransparency, selectedTheme, setCodeBlockWordWrap, setCodeFontFamily, setCodeFontSize, setColorHue, setColorIntensity, setFollowSystemHighContrast, setFontSmoothing, setReduceMotionSetting, setReduceTransparency, setSelectedTheme, setThemedDiffBackgrounds, setToolCallDensity, setUiFontFamily, setUiFontSize, themedDiffBackgrounds, toolCallDensity, uiFontFamily, uiFontSize } = useSettingsContext();
    return (
        <div className="sb-cursor-settings-content animate-fadeIn">
            <h2 className="sb-cursor-content-title">Appearance</h2>

            {/* Theme */}
            <div className="sb-cursor-group-card">
                <div className="sb-cursor-row-item">
                    <div className="sb-cursor-row-info">
                        <div className="sb-cursor-row-title">Theme</div>
                        <div className="sb-cursor-row-desc">Choose between light, dark, or high contrast themes</div>
                    </div>
                    <select
                        className="sb-cursor-select-dropdown"
                        value={selectedTheme}
                        onChange={e => setSelectedTheme(e.target.value as any)}
                    >
                        <option value="system">System</option>
                        <option value="dark">Dark</option>
                        <option value="light">Light</option>
                        <option value="high-contrast">High Contrast</option>
                    </select>
                </div>
            </div>

            {/* Agent Conversations */}
            <div className="sb-cursor-section-block">
                <div className="sb-cursor-section-header">Agent Conversations</div>
                <div className="sb-cursor-group-card">
                    <div className="sb-cursor-row-item">
                        <div className="sb-cursor-row-info">
                            <div className="sb-cursor-row-title">Tool Call Density</div>
                            <div className="sb-cursor-row-desc">Adjust how much detail is shown for tool calls</div>
                        </div>
                        <div className="flex items-center gap-3">
                            <input
                                type="range"
                                min="0"
                                max="100"
                                className="sb-cursor-slider"
                                value={toolCallDensity}
                                onChange={e => setToolCallDensity(Number(e.target.value))}
                            />
                            <span className="text-xs text-zinc-600 dark:text-zinc-400 font-medium w-14 text-right">
                                {toolCallDensity <= 33 ? 'Compact' : toolCallDensity <= 66 ? 'Normal' : 'Detailed'}
                            </span>
                        </div>
                    </div>

                    <div className="sb-cursor-row-item">
                        <div className="sb-cursor-row-info">
                            <div className="sb-cursor-row-title">Code Block Word Wrap</div>
                            <div className="sb-cursor-row-desc">Wrap long lines in Agent conversation code blocks</div>
                        </div>
                        <button
                            type="button"
                            role="switch"
                            aria-checked={codeBlockWordWrap}
                            className={`sb-cursor-toggle ${codeBlockWordWrap ? 'sb-cursor-toggle-on' : ''}`}
                            onClick={() => setCodeBlockWordWrap(!codeBlockWordWrap)}
                        >
                            <span className="sb-cursor-toggle-thumb" />
                        </button>
                    </div>

                    <div className="sb-cursor-row-item">
                        <div className="sb-cursor-row-info">
                            <div className="sb-cursor-row-title">Themed Diff Backgrounds</div>
                            <div className="sb-cursor-row-desc">Use themed background colors for inline code diffs</div>
                        </div>
                        <button
                            type="button"
                            role="switch"
                            aria-checked={themedDiffBackgrounds}
                            className={`sb-cursor-toggle ${themedDiffBackgrounds ? 'sb-cursor-toggle-on' : ''}`}
                            onClick={() => setThemedDiffBackgrounds(!themedDiffBackgrounds)}
                        >
                            <span className="sb-cursor-toggle-thumb" />
                        </button>
                    </div>
                </div>
            </div>

            {/* Colors */}
            <div className="sb-cursor-section-block">
                <div className="sb-cursor-section-header">Colors</div>
                <div className="sb-cursor-group-card">
                    <div className="sb-cursor-row-item">
                        <div className="sb-cursor-row-info">
                            <div className="sb-cursor-row-title">Hue</div>
                            <div className="sb-cursor-row-desc">Choose a tint color</div>
                        </div>
                        <div className="flex items-center gap-2">
                            <input
                                type="range"
                                min="0"
                                max="360"
                                className="sb-cursor-slider"
                                value={colorHue}
                                onChange={e => setColorHue(Number(e.target.value))}
                            />
                            <span className="w-4 h-4 rounded-full border border-zinc-700" style={{ background: `hsl(${colorHue}, 80%, 50%)` }} />
                        </div>
                    </div>

                    <div className="sb-cursor-row-item">
                        <div className="sb-cursor-row-info">
                            <div className="sb-cursor-row-title">Intensity</div>
                            <div className="sb-cursor-row-desc">Control how strongly the tint is applied</div>
                        </div>
                        <div className="flex items-center gap-2">
                            <input
                                type="range"
                                min="0"
                                max="100"
                                className="sb-cursor-slider"
                                value={colorIntensity}
                                onChange={e => setColorIntensity(Number(e.target.value))}
                            />
                            <span className="text-xs text-zinc-400 font-mono w-8 text-right">{colorIntensity}%</span>
                        </div>
                    </div>

                    <div className="sb-cursor-row-item">
                        <div className="sb-cursor-row-info">
                            <div className="sb-cursor-row-title">Reduce Transparency</div>
                            <div className="sb-cursor-row-desc">Replace translucent surfaces with opaque backgrounds</div>
                        </div>
                        <button
                            type="button"
                            role="switch"
                            aria-checked={reduceTransparency}
                            className={`sb-cursor-toggle ${reduceTransparency ? 'sb-cursor-toggle-on' : ''}`}
                            onClick={() => setReduceTransparency(!reduceTransparency)}
                        >
                            <span className="sb-cursor-toggle-thumb" />
                        </button>
                    </div>
                </div>
            </div>

            {/* Typography */}
            <div className="sb-cursor-section-block">
                <div className="sb-cursor-section-header">Typography</div>
                <div className="sb-cursor-group-card">
                    <div className="sb-cursor-row-item">
                        <div className="sb-cursor-row-info">
                            <div className="sb-cursor-row-title">UI Font Size</div>
                            <div className="sb-cursor-row-desc">Font size for the Scratchbox user interface</div>
                        </div>
                        <div className="sb-cursor-stepper">
                            <button type="button" className="sb-stepper-btn" onClick={() => setUiFontSize(Math.max(10, uiFontSize - 1))}>−</button>
                            <span className="sb-stepper-val">{uiFontSize}</span>
                            <button type="button" className="sb-stepper-btn" onClick={() => setUiFontSize(Math.min(24, uiFontSize + 1))}>+</button>
                        </div>
                    </div>

                    <div className="sb-cursor-row-item">
                        <div className="sb-cursor-row-info">
                            <div className="sb-cursor-row-title">Code Font Size</div>
                            <div className="sb-cursor-row-desc">Font size for code editors and diffs</div>
                        </div>
                        <div className="sb-cursor-stepper">
                            <button type="button" className="sb-stepper-btn" onClick={() => setCodeFontSize(Math.max(10, codeFontSize - 1))}>−</button>
                            <span className="sb-stepper-val">{codeFontSize}</span>
                            <button type="button" className="sb-stepper-btn" onClick={() => setCodeFontSize(Math.min(24, codeFontSize + 1))}>+</button>
                        </div>
                    </div>

                    <div className="sb-cursor-row-item">
                        <div className="sb-cursor-row-info">
                            <div className="sb-cursor-row-title">UI Font Family</div>
                            <div className="sb-cursor-row-desc">Override the Scratchbox user interface typeface</div>
                        </div>
                        <select
                            className="sb-cursor-select-dropdown"
                            value={uiFontFamily}
                            onChange={e => setUiFontFamily(e.target.value)}
                        >
                            <option value="system">System font</option>
                            <option value="sf-pro">SF Pro</option>
                            <option value="inter">Inter</option>
                            <option value="geist">Geist</option>
                        </select>
                    </div>

                    <div className="sb-cursor-row-item">
                        <div className="sb-cursor-row-info">
                            <div className="sb-cursor-row-title">Code Font Family</div>
                            <div className="sb-cursor-row-desc">Override the font for code editors and diffs</div>
                        </div>
                        <select
                            className="sb-cursor-select-dropdown"
                            value={codeFontFamily}
                            onChange={e => setCodeFontFamily(e.target.value)}
                        >
                            <option value="system-mono">System monospace</option>
                            <option value="menlo">Menlo</option>
                            <option value="fira-code">Fira Code</option>
                            <option value="jetbrains-mono">JetBrains Mono</option>
                        </select>
                    </div>

                    {/* Live Code Diff Preview Box */}
                    <div className="p-3 bg-zinc-950/60 border-t border-zinc-800/80">
                        <div
                            className="sb-cursor-diff-preview"
                            style={{
                                fontSize: `${codeFontSize}px`,
                                fontFamily: codeFontFamily === 'system-mono'
                                    ? 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace'
                                    : codeFontFamily
                            }}
                        >
                            <div className="sb-diff-line sb-diff-del">
                                <span className="sb-diff-num">1</span>
                                <span className="sb-diff-content">return a + b;</span>
                            </div>
                            <div className="sb-diff-line sb-diff-add">
                                <span className="sb-diff-num">1</span>
                                <span className="sb-diff-content">const result = a + b;</span>
                            </div>
                            <div className="sb-diff-line sb-diff-add">
                                <span className="sb-diff-num">2</span>
                                <span className="sb-diff-content">return result;</span>
                            </div>
                        </div>
                    </div>

                    <div className="sb-cursor-row-item">
                        <div className="sb-cursor-row-info">
                            <div className="sb-cursor-row-title">Font Smoothing</div>
                            <div className="sb-cursor-row-desc">Use native macOS font anti-aliasing</div>
                        </div>
                        <button
                            type="button"
                            role="switch"
                            aria-checked={fontSmoothing}
                            className={`sb-cursor-toggle ${fontSmoothing ? 'sb-cursor-toggle-on' : ''}`}
                            onClick={() => setFontSmoothing(!fontSmoothing)}
                        >
                            <span className="sb-cursor-toggle-thumb" />
                        </button>
                    </div>
                </div>
            </div>

            {/* High Contrast */}
            <div className="sb-cursor-section-block">
                <div className="sb-cursor-section-header">High Contrast</div>
                <div className="sb-cursor-group-card">
                    <div className="sb-cursor-row-item">
                        <div className="sb-cursor-row-info">
                            <div className="sb-cursor-row-title">Follow System High Contrast</div>
                            <div className="sb-cursor-row-desc">Switch to a high contrast theme when your OS is in a high contrast mode</div>
                        </div>
                        <button
                            type="button"
                            role="switch"
                            aria-checked={followSystemHighContrast}
                            className={`sb-cursor-toggle ${followSystemHighContrast ? 'sb-cursor-toggle-on' : ''}`}
                            onClick={() => setFollowSystemHighContrast(!followSystemHighContrast)}
                        >
                            <span className="sb-cursor-toggle-thumb" />
                        </button>
                    </div>
                </div>
            </div>

            {/* Motion */}
            <div className="sb-cursor-section-block">
                <div className="sb-cursor-section-header">Motion</div>
                <div className="sb-cursor-group-card">
                    <div className="sb-cursor-row-item">
                        <div className="sb-cursor-row-info">
                            <div className="sb-cursor-row-title">Reduce Motion</div>
                            <div className="sb-cursor-row-desc">Minimize interface animations. System follows your OS preference.</div>
                        </div>
                        <select
                            className="sb-cursor-select-dropdown"
                            value={reduceMotionSetting}
                            onChange={e => setReduceMotionSetting(e.target.value)}
                        >
                            <option value="system">System</option>
                            <option value="always">Always Reduce</option>
                            <option value="never">Full Motion</option>
                        </select>
                    </div>
                </div>
            </div>
        </div>
    );
};
