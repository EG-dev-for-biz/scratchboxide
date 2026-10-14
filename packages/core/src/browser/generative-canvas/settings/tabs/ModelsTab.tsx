/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/** Models settings tab. Extracted verbatim from SettingsModal.tsx. */
import * as React from 'react';
import { IconGlobe } from '../../canvas-icons';
import { useSettingsContext } from '../SettingsContext';

export const ModelsTab: React.FC = () => {
    const {
        credentialsInput,
        credsFeedback,
        geminiStatus,
        googleSearchGrounding,
        handleSaveCredentials,
        handleSaveMapsKey,
        handleSaveWorkspaceSettings,
        handleTestMapsKey,
        handleToggleGoogleSearchGrounding,
        isSavingCreds,
        isSavingWorkspace,
        isTestingMapsKey,
        mapsFeedback,
        mapsKeyInput,
        mapsState,
        saveFeedback,
        setCredentialsInput,
        setMapsKeyInput,
        setWorkspaceSettings,
        workspaceSettings
    } = useSettingsContext();

    return (
        <div className="sb-cursor-settings-content animate-fadeIn">
            <h2 className="sb-cursor-content-title">Models &amp; AI Engine</h2>

            {/* Google Reasoning Intelligence */}
            <div className="sb-cursor-section-block">
                <div className="sb-cursor-section-header">Reasoning Engine &amp; Prompt Directives</div>
                <div className="sb-cursor-group-card p-4 space-y-4">
                    <div className="sb-cursor-row-info">
                        <div className="sb-cursor-row-title">Google Reasoning Intelligence</div>
                        <div className="sb-cursor-row-desc">
                            High-performance multimodal models power multi-step agent planning, TDD verification, and canvas synthesis.
                        </div>
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                        <div className="sb-form-group">
                            <label className="sb-form-label">Preferred AI Reasoning Engine</label>
                            <select
                                className="sb-form-select"
                                value={workspaceSettings.defaultModel || 'gemini-4-argon'}
                                onChange={e => setWorkspaceSettings({ ...workspaceSettings, defaultModel: e.target.value })}
                            >
                                <option value="gemini-4-argon">Flagship Reasoning Engine (Gemini 4 Argon)</option>
                                <option value="gemini-3.8-flash">High Reasoning Engine (Gemini 3.8 Flash)</option>
                                <option value="gemini-3.7-flash">Previous Reasoning Engine (Gemini 3.7 Flash)</option>
                                <option value="gemini-2.5-pro">Deep Architecture Analysis (Comprehensive Context)</option>
                                <option value="gemini-2.5-flash">Fast Intelligence (Instant Code &amp; Generation)</option>
                            </select>
                        </div>

                        <div className="sb-form-group">
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

                    <div className="sb-form-group">
                        <label className="sb-form-label">Custom Project Instructions (System Directive)</label>
                        <textarea
                            className="sb-form-textarea"
                            rows={3}
                            value={workspaceSettings.customPromptInstructions || ''}
                            onChange={e => setWorkspaceSettings({ ...workspaceSettings, customPromptInstructions: e.target.value })}
                        />
                    </div>

                    <div className="sb-cursor-card-footer">
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
            </div>

            {/* Live Search Grounding */}
            <div className="sb-cursor-section-block">
                <div className="sb-cursor-section-header">Live Knowledge &amp; Search Grounding</div>
                <div className="sb-cursor-group-card">
                    <div className="sb-cursor-row-item">
                        <div className="sb-cursor-row-info">
                            <div className="flex items-center gap-2">
                                <IconGlobe size={14} className="text-blue-400" />
                                <span className="sb-cursor-row-title">Google Search Grounding</span>
                                <span className={`sb-badge-unified ${googleSearchGrounding ? 'sb-badge-emerald' : 'sb-badge-zinc'}`}>
                                    {googleSearchGrounding ? 'Enabled' : 'Disabled'}
                                </span>
                            </div>
                            <div className="sb-cursor-row-desc">
                                Ground model reasoning with real-time Google Search citations, web verification, and live external documentation.
                            </div>
                        </div>
                        <button
                            type="button"
                            role="switch"
                            aria-checked={googleSearchGrounding}
                            className={`sb-cursor-toggle ${googleSearchGrounding ? 'sb-cursor-toggle-on' : ''}`}
                            onClick={() => handleToggleGoogleSearchGrounding(!googleSearchGrounding)}
                        >
                            <span className="sb-cursor-toggle-thumb" />
                        </button>
                    </div>
                </div>
            </div>

            {/* Credentials & Authentication */}
            <div className="sb-cursor-section-block">
                <div className="sb-cursor-section-header">Authentication &amp; API Key</div>
                <div className="sb-cursor-group-card p-4 space-y-3">
                    <div className="flex items-center justify-between">
                        <div className="sb-cursor-row-info">
                            <div className="sb-cursor-row-title">Google Cloud Service Account / API Key</div>
                            <div className="sb-cursor-row-desc">
                                Saved securely to <code>~/.scratchbox-ide/service-account.json</code> for Vertex AI &amp; model execution.
                            </div>
                        </div>
                        {geminiStatus && (
                            <span className={`sb-badge-unified ${geminiStatus.connected ? 'sb-badge-emerald' : 'sb-badge-zinc'}`}>
                                {geminiStatus.connected ? '● Authenticated' : '○ Not Connected'}
                            </span>
                        )}
                    </div>

                    {geminiStatus && geminiStatus.connected && (
                        <div className="p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-xs space-y-1">
                            <div className="flex items-center gap-2 text-emerald-700 dark:text-emerald-300 font-medium">
                                <span>Project: {geminiStatus.projectId || 'Default'}</span>
                                <span>•</span>
                                <span>Account: {geminiStatus.serviceAccount || 'Google Cloud IAM'}</span>
                            </div>
                            <div className="text-zinc-500 dark:text-zinc-400 text-xs">
                                Engine: High Reasoning AI • Subagents: Autonomous Workers Active
                            </div>
                        </div>
                    )}

                    <div className="sb-form-group">
                        <label className="sb-form-label">Paste Service Account JSON or API Key</label>
                        <textarea
                            className="sb-form-textarea font-mono text-xs"
                            rows={3}
                            value={credentialsInput}
                            onChange={e => setCredentialsInput(e.target.value)}
                            placeholder='Paste { "type": "service_account", "project_id": "...", "private_key": "..." } or AIzaSy...'
                        />
                    </div>

                    <div className="sb-cursor-card-footer">
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
                        <div className="sb-cursor-row-info">
                            <div className="sb-cursor-row-title flex items-center gap-1.5">
                                <IconGlobe size={15} className="text-emerald-600 dark:text-emerald-400" />
                                <span>Google Maps API Key</span>
                            </div>
                            <div className="sb-cursor-row-desc">
                                Powers Geocoding, Google Static Maps, Photorealistic 3D Tiles, Places, and dynamic embedded map rendering.
                            </div>
                        </div>
                        <span className={`sb-badge-unified ${mapsState.status === 'ready' ? 'sb-badge-emerald' : 'sb-badge-zinc'}`}>
                            {mapsState.status === 'ready' ? '● Key Active' : '○ Missing Key (Fallback Mode)'}
                        </span>
                    </div>

                    <div className="sb-form-group">
                        <label className="sb-form-label">Google Maps API Key (AIzaSy...)</label>
                        <input
                            type="password"
                            className="sb-form-input font-mono text-xs"
                            value={mapsKeyInput}
                            onChange={e => setMapsKeyInput(e.target.value)}
                            placeholder="AIzaSy..."
                        />
                    </div>

                    <div className="sb-cursor-card-footer">
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
