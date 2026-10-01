/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/** Beta settings tab. Extracted verbatim from SettingsModal.tsx. */
import * as React from 'react';
import { useSettingsContext } from '../SettingsContext';

export const BetaTab: React.FC = () => {
    const { deepResearchMode, setDeepResearchMode, setSubagentSpeculative, subagentSpeculative } = useSettingsContext();
    return (
        <div className="sb-cursor-settings-content animate-fadeIn">
            <h2 className="sb-cursor-content-title">Beta Features</h2>

            <div className="sb-cursor-group-card">
                <div className="sb-cursor-row-item">
                    <div className="sb-cursor-row-info">
                        <div className="sb-cursor-row-title">Speculative Subagent Execution (MTP)</div>
                        <div className="sb-cursor-row-desc">Accelerate multi-step code synthesis using parallel draft proposal verification</div>
                    </div>
                    <button
                        type="button"
                        role="switch"
                        aria-checked={subagentSpeculative}
                        className={`sb-cursor-toggle ${subagentSpeculative ? 'sb-cursor-toggle-on' : ''}`}
                        onClick={() => setSubagentSpeculative(!subagentSpeculative)}
                    >
                        <span className="sb-cursor-toggle-thumb" />
                    </button>
                </div>

                <div className="sb-cursor-row-item">
                    <div className="sb-cursor-row-info">
                        <div className="sb-cursor-row-title">Deep Research Mode</div>
                        <div className="sb-cursor-row-desc">Allow agent to recursively query documentation, MCP servers, and files before proposing architectural patches</div>
                    </div>
                    <button
                        type="button"
                        role="switch"
                        aria-checked={deepResearchMode}
                        className={`sb-cursor-toggle ${deepResearchMode ? 'sb-cursor-toggle-on' : ''}`}
                        onClick={() => setDeepResearchMode(!deepResearchMode)}
                    >
                        <span className="sb-cursor-toggle-thumb" />
                    </button>
                </div>
            </div>
        </div>
    );
};
