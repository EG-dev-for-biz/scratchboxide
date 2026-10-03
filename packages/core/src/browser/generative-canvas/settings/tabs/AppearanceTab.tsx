/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as React from 'react';
import { StudioAppearanceConfig } from '../../canvas-types';
import { useSettingsContext } from '../SettingsContext';

export const AppearanceTab: React.FC = () => {
    const { appearanceConfig, onAppearanceConfigChange } = useSettingsContext();

    const updateConfig = (patch: Partial<StudioAppearanceConfig>) => {
        if (onAppearanceConfigChange && appearanceConfig) {
            onAppearanceConfigChange({
                ...appearanceConfig,
                ...patch
            });
        }
    };

    if (!appearanceConfig) {
        return null;
    }

    return (
        <div className="sb-cursor-settings-content animate-fadeIn space-y-4">
            <div>
                <h2 className="sb-cursor-content-title">Appearance &amp; Canvas Display</h2>
                <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
                    Customize the studio layout density, glass surface blur, editor typography, and tactile motion.
                </p>
            </div>

            {/* Layout Density */}
            <div className="sb-cursor-section-block">
                <div className="sb-cursor-section-header">Canvas Layout &amp; Surface</div>
                <div className="sb-cursor-group-card">
                    <div className="sb-cursor-row-item">
                        <div className="sb-cursor-row-info">
                            <div className="sb-cursor-row-title">Canvas Density</div>
                            <div className="sb-cursor-row-desc">Adjust the compact spacing of canvas stages, toolbars, and cards</div>
                        </div>
                        <div className="flex items-center gap-1.5 bg-zinc-100 dark:bg-zinc-900/80 p-1 rounded-xl border border-zinc-200 dark:border-zinc-800/80">
                            {(['spacious', 'standard', 'compact'] as const).map(density => (
                                <button
                                    key={density}
                                    type="button"
                                    className={`sb-segment-btn capitalize ${appearanceConfig.canvasDensity === density ? 'sb-segment-active' : ''}`}
                                    onClick={() => updateConfig({ canvasDensity: density })}
                                >
                                    {density}
                                </button>
                            ))}
                        </div>
                    </div>

                    <div className="sb-cursor-row-item">
                        <div className="sb-cursor-row-info">
                            <div className="sb-cursor-row-title">Glass Surface Blur</div>
                            <div className="sb-cursor-row-desc">Intensity of translucent Apple Liquid Glass backdrop blur filters</div>
                        </div>
                        <div className="flex items-center gap-1.5 bg-zinc-100 dark:bg-zinc-900/80 p-1 rounded-xl border border-zinc-200 dark:border-zinc-800/80">
                            {(['subtle', 'standard', 'vibrant'] as const).map(blur => (
                                <button
                                    key={blur}
                                    type="button"
                                    className={`sb-segment-btn capitalize ${appearanceConfig.glassBlur === blur ? 'sb-segment-active' : ''}`}
                                    onClick={() => updateConfig({ glassBlur: blur })}
                                >
                                    {blur}
                                </button>
                            ))}
                        </div>
                    </div>
                </div>
            </div>

            {/* Motion & Interaction */}
            <div className="sb-cursor-section-block">
                <div className="sb-cursor-section-header">Motion &amp; Interaction</div>
                <div className="sb-cursor-group-card">
                    <div className="sb-cursor-row-item">
                        <div className="sb-cursor-row-info">
                            <div className="sb-cursor-row-title">Spring Animations &amp; Physics Motion</div>
                            <div className="sb-cursor-row-desc">Fluid elastic transitions for canvas popovers, modals, and panel drawer state</div>
                        </div>
                        <button
                            type="button"
                            role="switch"
                            aria-checked={appearanceConfig.enableSpringMotion}
                            className={`sb-cursor-toggle ${appearanceConfig.enableSpringMotion ? 'sb-cursor-toggle-on' : ''}`}
                            onClick={() => updateConfig({ enableSpringMotion: !appearanceConfig.enableSpringMotion })}
                        >
                            <span className="sb-cursor-toggle-thumb" />
                        </button>
                    </div>

                    <div className="sb-cursor-row-item">
                        <div className="sb-cursor-row-info">
                            <div className="sb-cursor-row-title">Haptic &amp; Tactile Feedback</div>
                            <div className="sb-cursor-row-desc">Subtle vibration or audio pulse cues during canvas actions and node connections</div>
                        </div>
                        <button
                            type="button"
                            role="switch"
                            aria-checked={appearanceConfig.hapticFeedback}
                            className={`sb-cursor-toggle ${appearanceConfig.hapticFeedback ? 'sb-cursor-toggle-on' : ''}`}
                            onClick={() => updateConfig({ hapticFeedback: !appearanceConfig.hapticFeedback })}
                        >
                            <span className="sb-cursor-toggle-thumb" />
                        </button>
                    </div>
                </div>
            </div>

            {/* Code & Superpowers Display */}
            <div className="sb-cursor-section-block">
                <div className="sb-cursor-section-header">Code Editor &amp; Superpowers</div>
                <div className="sb-cursor-group-card">
                    <div className="sb-cursor-row-item">
                        <div className="sb-cursor-row-info">
                            <div className="sb-cursor-row-title">Show Line Numbers in Code Views</div>
                            <div className="sb-cursor-row-desc">Display line numbering gutter in live sandboxes, code diffs, and artifact viewers</div>
                        </div>
                        <button
                            type="button"
                            role="switch"
                            aria-checked={appearanceConfig.showLineNumbersInCode}
                            className={`sb-cursor-toggle ${appearanceConfig.showLineNumbersInCode ? 'sb-cursor-toggle-on' : ''}`}
                            onClick={() => updateConfig({ showLineNumbersInCode: !appearanceConfig.showLineNumbersInCode })}
                        >
                            <span className="sb-cursor-toggle-thumb" />
                        </button>
                    </div>

                    <div className="sb-cursor-row-item">
                        <div className="sb-cursor-row-info">
                            <div className="sb-cursor-row-title">Auto-Attach Recommended Superpowers</div>
                            <div className="sb-cursor-row-desc">Automatically suggest and mount relevant domain skills based on your chat prompt intent</div>
                        </div>
                        <button
                            type="button"
                            role="switch"
                            aria-checked={appearanceConfig.autoAttachSuperpowers}
                            className={`sb-cursor-toggle ${appearanceConfig.autoAttachSuperpowers ? 'sb-cursor-toggle-on' : ''}`}
                            onClick={() => updateConfig({ autoAttachSuperpowers: !appearanceConfig.autoAttachSuperpowers })}
                        >
                            <span className="sb-cursor-toggle-thumb" />
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
};
