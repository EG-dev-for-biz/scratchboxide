/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/** Models settings tab. Extracted verbatim from SettingsModal.tsx. */
import * as React from 'react';
import { useSettingsContext } from '../SettingsContext';

export const ModelsTab: React.FC = () => {
    const { credentialsInput, credsFeedback, geminiStatus, handleSaveCredentials, handleSaveMapsKey, handleSaveWorkspaceSettings, handleTestMapsKey, isSavingCreds, isSavingWorkspace, isTestingMapsKey, mapsFeedback, mapsKeyInput, mapsState, saveFeedback, setCredentialsInput, setMapsKeyInput, setWorkspaceSettings, workspaceSettings } = useSettingsContext();
    return (
        <div className="sb-cursor-settings-content animate-fadeIn">
            <h2 className="sb-cursor-content-title">Models &amp; AI Engine</h2>

            <div className="sb-cursor-group-card space-y-4 p-4">
                <div className="sb-pref-info">
                    <h4 className="sb-pref-title">Google Reasoning Intelligence</h4>
                    <p className="sb-pref-desc">
                        High-performance multimodal models power multi-step agent planning, TDD verification, and canvas synthesis.
                    </p>
                </div>

                <div className="grid grid-cols-2 gap-4">
                    <div>
                        <label className="sb-form-label">Preferred AI Reasoning Engine</label>
                        <select
                            className="sb-form-select"
                            value={workspaceSettings.defaultModel || 'gemini-3.7-flash'}
                            onChange={e => setWorkspaceSettings({ ...workspaceSettings, defaultModel: e.target.value })}
                        >
                            <option value="gemini-3.7-flash">High Reasoning Engine (Autonomous &amp; Deep Thought)</option>
                            <option value="gemini-2.5-pro">Deep Architecture Analysis (Comprehensive Context)</option>
                            <option value="gemini-2.5-flash">Fast Intelligence (Instant Code &amp; Generation)</option>
                        </select>
                    </div>

                    <div>
                        <label className="sb-form-label">Thinking Budget (Tokens)</label>
                        <select
                            className="sb-form-select"
                            value={workspaceSettings.thinkingBudget || 1024}
                            onChange={e => setWorkspaceSettings({ ...workspaceSettings, thinkingBudget: Number(e.target.value) })}
                        >
                            <option value={512}>512 tokens (Fast)</option>
                            <option value={1024}>1024 tokens (Standard Balanced)</option>
                            <option value={2048}>2048 tokens (Deep Spec &amp; Logic)</option>
                            <option value={4096}>4096 tokens (Exhaustive Architecture)</option>
                        </select>
                    </div>
                </div>

                <div>
                    <label className="sb-form-label">Custom Project Instructions (System Directive)</label>
                    <textarea
                        className="sb-form-textarea"
                        rows={3}
                        value={workspaceSettings.customPromptInstructions || ''}
                        onChange={e => setWorkspaceSettings({ ...workspaceSettings, customPromptInstructions: e.target.value })}
                        placeholder="e.g. Adhere to Apple Human Interface Guidelines and 8-pt spacing tokens across all UI components."
                    />
                </div>

                <div className="flex items-center justify-between pt-2 border-t border-zinc-800/60">
                    <div className="text-xs text-zinc-400">
                        {saveFeedback && <span className="text-emerald-400 font-medium">✓ {saveFeedback}</span>}
                    </div>
                    <button
                        type="button"
                        className="sb-btn sb-btn-primary sb-btn-sm"
                        onClick={handleSaveWorkspaceSettings}
                        disabled={isSavingWorkspace}
                    >
                        {isSavingWorkspace ? 'Saving...' : 'Save Config'}
                    </button>
                </div>
            </div>

            {/* Credentials & Authentication */}
            <div className="sb-cursor-section-block">
                <div className="sb-cursor-section-header">Authentication &amp; API Key</div>
                <div className="sb-cursor-group-card p-4 space-y-3">
                    <div className="flex items-center justify-between">
                        <div className="sb-pref-info">
                            <h4 className="sb-pref-title">Google Cloud Service Account / API Key</h4>
                            <p className="sb-pref-desc">
                                Saved securely to <code>~/.scratchbox-ide/service-account.json</code> for Vertex AI &amp; model execution.
                            </p>
                        </div>
                        {geminiStatus && (
                            <span className={`sb-badge-unified ${geminiStatus.connected ? 'sb-badge-emerald' : 'sb-badge-zinc'}`}>
                                {geminiStatus.connected ? '● Authenticated' : '○ Not Connected'}
                            </span>
                        )}
                    </div>

                    {geminiStatus && geminiStatus.connected && (
                        <div className="p-3 rounded-xl bg-emerald-950/20 border border-emerald-800/40 text-xs space-y-1">
                            <div className="flex items-center gap-2 text-emerald-300 font-medium">
                                <span>Project: {geminiStatus.projectId || 'Default'}</span>
                                <span>•</span>
                                <span>Account: {geminiStatus.serviceAccount || 'Google Cloud IAM'}</span>
                            </div>
                            <div className="text-zinc-400 text-[11px]">
                                Engine: High Reasoning AI • Subagents: Autonomous Workers Active
                            </div>
                        </div>
                    )}

                    <div>
                        <label className="sb-form-label">Paste Service Account JSON or API Key</label>
                        <textarea
                            className="sb-form-textarea font-mono text-[11px]"
                            rows={3}
                            value={credentialsInput}
                            onChange={e => setCredentialsInput(e.target.value)}
                            placeholder='Paste { "type": "service_account", "project_id": "...", "private_key": "..." } or AIzaSy...'
                        />
                    </div>

                    <div className="flex items-center justify-between pt-2 border-t border-zinc-800/60">
                        <div className="text-xs">
                            {credsFeedback && (
                                <span className={credsFeedback.error ? 'text-rose-400 font-medium' : 'text-emerald-400 font-medium'}>
                                    {credsFeedback.error ? '✕ ' : '✓ '}{credsFeedback.message}
                                </span>
                            )}
                        </div>
                        <button
                            type="button"
                            className="sb-btn sb-btn-primary sb-btn-sm"
                            onClick={handleSaveCredentials}
                            disabled={isSavingCreds || !credentialsInput.trim()}
                        >
                            {isSavingCreds ? 'Validating...' : 'Save & Authenticate'}
                        </button>
                    </div>
                </div>
            </div>

            {/* Google Maps Platform Configuration */}
            <div className="sb-cursor-section-block">
                <div className="sb-cursor-section-header">Google Maps Platform &amp; Geospatial Intelligence</div>
                <div className="sb-cursor-group-card p-4 space-y-3">
                    <div className="flex items-center justify-between">
                        <div className="sb-pref-info">
                            <h4 className="sb-pref-title flex items-center gap-1.5">
                                <span>🗺️</span>
                                <span>Google Maps API Key</span>
                            </h4>
                            <p className="sb-pref-desc">
                                Powers Geocoding, Google Static Maps, Photorealistic 3D Tiles, Places, and dynamic embedded map rendering.
                            </p>
                        </div>
                        <span className={`sb-badge-unified ${mapsState.status === 'ready' ? 'sb-badge-emerald' : 'sb-badge-zinc'}`}>
                            {mapsState.status === 'ready' ? '● Key Active' : '○ Missing Key (Fallback Mode)'}
                        </span>
                    </div>

                    <div>
                        <label className="sb-form-label">Google Maps API Key (AIzaSy...)</label>
                        <input
                            type="password"
                            className="sb-form-input font-mono text-xs"
                            value={mapsKeyInput}
                            onChange={e => setMapsKeyInput(e.target.value)}
                            placeholder="AIzaSy..."
                        />
                    </div>

                    <div className="flex items-center justify-between pt-2 border-t border-zinc-800/60">
                        <div className="text-xs">
                            {mapsFeedback && (
                                <span className={mapsFeedback.error ? 'text-rose-400 font-medium' : 'text-emerald-400 font-medium'}>
                                    {mapsFeedback.error ? '✕ ' : '✓ '}{mapsFeedback.message}
                                </span>
                            )}
                        </div>
                        <div className="flex items-center gap-2">
                            <button
                                type="button"
                                className="sb-btn sb-btn-secondary sb-btn-sm"
                                onClick={handleTestMapsKey}
                                disabled={isTestingMapsKey}
                            >
                                {isTestingMapsKey ? 'Testing...' : 'Test Geocode'}
                            </button>
                            <button
                                type="button"
                                className="sb-btn sb-btn-primary sb-btn-sm"
                                onClick={handleSaveMapsKey}
                            >
                                Save Key
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};
