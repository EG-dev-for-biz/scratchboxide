/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/** GitPrs settings tab. Extracted verbatim from SettingsModal.tsx. */
import * as React from 'react';
import { useSettingsContext } from '../SettingsContext';

export const GitPrsTab: React.FC = () => {
    const { branchPrefix, commitAttribution, prAttribution, prLinkDestination, reviewProvider, setBranchPrefix, setCommitAttribution, setPrAttribution, setPrLinkDestination, setReviewProvider } = useSettingsContext();
    return (
        <div className="sb-cursor-settings-content animate-fadeIn">
            <h2 className="sb-cursor-content-title">Git &amp; PRs</h2>

            {/* Pull Requests */}
            <div className="sb-cursor-section-block">
                <div className="sb-cursor-section-header">Pull Requests</div>
                <div className="sb-cursor-group-card">
                    <div className="sb-cursor-row-item">
                        <div className="sb-cursor-row-info">
                            <div className="sb-cursor-row-title">Review Provider</div>
                            <div className="sb-cursor-row-desc">Choose Origin (cursor.com/codebase), GitHub, or Graphite for pull request links on web and desktop</div>
                        </div>
                        <select
                            className="sb-cursor-select-dropdown"
                            value={reviewProvider}
                            onChange={e => setReviewProvider(e.target.value)}
                        >
                            <option value="github">GitHub ▾</option>
                            <option value="origin">Origin</option>
                            <option value="graphite">Graphite</option>
                        </select>
                    </div>

                    <div className="sb-cursor-row-item">
                        <div className="sb-cursor-row-info">
                            <div className="sb-cursor-row-title">PR Link Destination</div>
                            <div className="sb-cursor-row-desc">Open pull request links inside Cursor or in the default browser</div>
                        </div>
                        <select
                            className="sb-cursor-select-dropdown"
                            value={prLinkDestination}
                            onChange={e => setPrLinkDestination(e.target.value)}
                        >
                            <option value="inside">Inside Cursor ▾</option>
                            <option value="browser">Default Browser</option>
                        </select>
                    </div>
                </div>
            </div>

            {/* Attribution */}
            <div className="sb-cursor-section-block">
                <div className="sb-cursor-section-header">Attribution</div>
                <div className="sb-cursor-group-card">
                    <div className="sb-cursor-row-item">
                        <div className="sb-cursor-row-info">
                            <div className="sb-cursor-row-title">Commit Attribution</div>
                            <div className="sb-cursor-row-desc">Mark Agent commits as 'Made with Cursor'</div>
                        </div>
                        <button
                            type="button"
                            role="switch"
                            aria-checked={commitAttribution}
                            className={`sb-cursor-toggle ${commitAttribution ? 'sb-cursor-toggle-on' : ''}`}
                            onClick={() => setCommitAttribution(!commitAttribution)}
                        >
                            <span className="sb-cursor-toggle-thumb" />
                        </button>
                    </div>

                    <div className="sb-cursor-row-item">
                        <div className="sb-cursor-row-info">
                            <div className="sb-cursor-row-title">PR Attribution</div>
                            <div className="sb-cursor-row-desc">Mark pull requests as made with Cursor</div>
                        </div>
                        <button
                            type="button"
                            role="switch"
                            aria-checked={prAttribution}
                            className={`sb-cursor-toggle ${prAttribution ? 'sb-cursor-toggle-on' : ''}`}
                            onClick={() => setPrAttribution(!prAttribution)}
                        >
                            <span className="sb-cursor-toggle-thumb" />
                        </button>
                    </div>
                </div>
            </div>

            {/* Branches */}
            <div className="sb-cursor-section-block">
                <div className="sb-cursor-section-header">Branches</div>
                <div className="sb-cursor-group-card">
                    <div className="sb-cursor-row-item">
                        <div className="sb-cursor-row-info">
                            <div className="sb-cursor-row-title">Branch Prefix</div>
                            <div className="sb-cursor-row-desc">Prefix for new branches created by Agent (e.g., cursor/, username/)</div>
                        </div>
                        <input
                            type="text"
                            className="sb-cursor-text-input"
                            value={branchPrefix}
                            onChange={e => setBranchPrefix(e.target.value)}
                            placeholder="cursor/"
                        />
                    </div>
                </div>
            </div>
        </div>
    );
};
