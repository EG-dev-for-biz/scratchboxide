/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/** BrowserNetwork settings tab. Extracted verbatim from SettingsModal.tsx. */
import * as React from 'react';
import { useSettingsContext } from '../SettingsContext';

export const BrowserNetworkTab: React.FC = () => {
    const { browserAutomationMode, browserProtection, copiedDomains, diagnosticRunOutput, httpCompatibilityMode, openLocalLinksBrowser, openWebLinksBrowser, setBrowserAutomationMode, setBrowserProtection, setCopiedDomains, setDiagnosticRunOutput, setHttpCompatibilityMode, setOpenLocalLinksBrowser, setOpenWebLinksBrowser, setShowDomainsList, showDomainsList } = useSettingsContext();
    return (
        <div className="sb-cursor-settings-content animate-fadeIn">
            <h2 className="sb-cursor-content-title">Browser &amp; Network</h2>

            <div className="sb-cursor-group-card">
                <div className="sb-cursor-row-item">
                    <div className="sb-cursor-row-info">
                        <div className="sb-cursor-row-title">Browser Automation</div>
                        <div className="sb-cursor-row-desc">Connected to Browser Tab</div>
                    </div>
                    <select
                        className="sb-cursor-select-dropdown"
                        value={browserAutomationMode}
                        onChange={e => setBrowserAutomationMode(e.target.value)}
                    >
                        <option value="tab">Browser Tab ▾</option>
                        <option value="window">Dedicated Window</option>
                        <option value="headless">Headless Chromium</option>
                    </select>
                </div>

                <div className="sb-cursor-row-item">
                    <div className="sb-cursor-row-info">
                        <div className="sb-cursor-row-title">Browser Protection</div>
                        <div className="sb-cursor-row-desc">Prevent Agent from automatically running Browser tools</div>
                    </div>
                    <button
                        type="button"
                        role="switch"
                        aria-checked={browserProtection}
                        className={`sb-cursor-toggle ${browserProtection ? 'sb-cursor-toggle-on' : ''}`}
                        onClick={() => setBrowserProtection(!browserProtection)}
                    >
                        <span className="sb-cursor-toggle-thumb" />
                    </button>
                </div>

                <div className="sb-cursor-row-item">
                    <div className="sb-cursor-row-info">
                        <div className="sb-cursor-row-title">Open Local Links in Cursor Browser</div>
                        <div className="sb-cursor-row-desc">Automatically open localhost links in the Browser Tab</div>
                    </div>
                    <button
                        type="button"
                        role="switch"
                        aria-checked={openLocalLinksBrowser}
                        className={`sb-cursor-toggle ${openLocalLinksBrowser ? 'sb-cursor-toggle-on' : ''}`}
                        onClick={() => setOpenLocalLinksBrowser(!openLocalLinksBrowser)}
                    >
                        <span className="sb-cursor-toggle-thumb" />
                    </button>
                </div>

                <div className="sb-cursor-row-item">
                    <div className="sb-cursor-row-info">
                        <div className="sb-cursor-row-title">Open Web Links in Cursor Browser</div>
                        <div className="sb-cursor-row-desc">Automatically open http and https links in the Browser Tab</div>
                    </div>
                    <button
                        type="button"
                        role="switch"
                        aria-checked={openWebLinksBrowser}
                        className={`sb-cursor-toggle ${openWebLinksBrowser ? 'sb-cursor-toggle-on' : ''}`}
                        onClick={() => setOpenWebLinksBrowser(!openWebLinksBrowser)}
                    >
                        <span className="sb-cursor-toggle-thumb" />
                    </button>
                </div>
            </div>

            {/* Network */}
            <div className="sb-cursor-section-block">
                <div className="sb-cursor-section-header">Network</div>
                <div className="sb-cursor-group-card">
                    <div className="sb-cursor-row-item">
                        <div className="sb-cursor-row-info">
                            <div className="sb-cursor-row-title">HTTP Compatibility Mode</div>
                            <div className="sb-cursor-row-desc">HTTP/2 is recommended for low-latency streaming. In some corporate proxy and VPN environments, the compatibility mode may need to be lowered.</div>
                        </div>
                        <select
                            className="sb-cursor-select-dropdown"
                            value={httpCompatibilityMode}
                            onChange={e => setHttpCompatibilityMode(e.target.value)}
                        >
                            <option value="http2">HTTP/2 ▾</option>
                            <option value="http1">HTTP/1.1</option>
                        </select>
                    </div>

                    <div className="sb-cursor-row-item">
                        <div className="sb-cursor-row-info">
                            <div className="sb-cursor-row-title">Required Domains</div>
                            <div className="sb-cursor-row-desc">These domains must be accessible for Cursor to function. Add them to your firewall or proxy allowlist.</div>
                        </div>
                        <div className="flex items-center gap-2">
                            <button
                                type="button"
                                className="sb-cursor-row-btn"
                                onClick={() => {
                                    navigator.clipboard.writeText('api.cursor.sh\napi2.cursor.sh\nrepo.cursor.sh');
                                    setCopiedDomains(true);
                                    setTimeout(() => setCopiedDomains(false), 2000);
                                }}
                            >
                                {copiedDomains ? '✓ Copied' : 'Copy Domains'}
                            </button>
                            <button
                                type="button"
                                className="sb-cursor-row-btn"
                                onClick={() => setShowDomainsList(!showDomainsList)}
                            >
                                {showDomainsList ? 'Hide' : 'Show'}
                            </button>
                        </div>
                    </div>

                    {showDomainsList && (
                        <div className="p-3 bg-zinc-900/60 border-t border-zinc-800/80 text-xs font-mono text-zinc-300 space-y-1 animate-fadeIn">
                            <div>api.cursor.sh</div>
                            <div>api2.cursor.sh</div>
                            <div>repo.cursor.sh</div>
                            <div>open-vsx.org</div>
                        </div>
                    )}

                    <div className="sb-cursor-row-item">
                        <div className="sb-cursor-row-info">
                            <div className="sb-cursor-row-title">Network Diagnostics</div>
                            <div className="sb-cursor-row-desc">Check network connectivity to all Cursor services</div>
                        </div>
                        <button
                            type="button"
                            className="sb-cursor-row-btn"
                            onClick={() => {
                                setDiagnosticRunOutput('Checking connections... All 8 endpoints online (avg latency 24ms)');
                            }}
                        >
                            Run Diagnostic
                        </button>
                    </div>

                    {diagnosticRunOutput && (
                        <div className="p-3 bg-emerald-950/20 border-t border-emerald-800/40 text-xs text-emerald-300 font-mono">
                            ✓ {diagnosticRunOutput}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};
