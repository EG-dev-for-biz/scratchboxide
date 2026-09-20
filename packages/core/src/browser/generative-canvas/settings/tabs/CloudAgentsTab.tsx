/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/** CloudAgents settings tab. Extracted verbatim from SettingsModal.tsx. */
import * as React from 'react';
import { useSettingsContext } from '../SettingsContext';

export const CloudAgentsTab: React.FC = () => {
    const { bidirectionalFilesystemSync, cloudAgentTarget, cloudCpuCores, cloudRamGb, cloudTimeoutSeconds, gcpProjectIdMapping, googleSearchGrounding, handleToggleGoogleSearchGrounding, pythonCodeExecution, setBidirectionalFilesystemSync, setCloudAgentTarget, setCloudCpuCores, setCloudRamGb, setCloudTimeoutSeconds, setGcpProjectIdMapping, setPythonCodeExecution } = useSettingsContext();
    return (
        <div className="sb-cursor-settings-content animate-fadeIn">
            <h2 className="sb-cursor-content-title">Cloud Agents</h2>

            {/* Group Card 1: Active Google Cloud Agent Target */}
            <div className="sb-cursor-section-block">
                <div className="sb-cursor-section-header">Active Google Cloud Agent Target</div>
                <div className="sb-cursor-group-card p-4 space-y-4">
                    <div className="flex items-center justify-between">
                        <div className="sb-cursor-row-info">
                            <div className="sb-cursor-row-title">Managed Agent Type</div>
                            <div className="sb-cursor-row-desc">
                                Managed agents run in safe, remote sandboxed Linux containers hosted on Google Cloud.
                            </div>
                        </div>
                        <select
                            className="sb-cursor-select-dropdown"
                            value={cloudAgentTarget}
                            onChange={e => setCloudAgentTarget(e.target.value)}
                        >
                            <option value="antigravity-preview-05-2026">Scratchbox Cloud Agent (Preview) (Recommended)</option>
                            <option value="deep-research-preview-04-2026">deep-research-preview-04-2026</option>
                            <option value="deep-research-max-preview-04-2026">deep-research-max-preview-04-2026</option>
                            <option value="code-reviewer">code-reviewer</option>
                        </select>
                    </div>
                    <div className="p-3 rounded-xl bg-zinc-100/70 dark:bg-zinc-900/50 border border-zinc-200 dark:border-zinc-800 text-xs text-zinc-600 dark:text-zinc-400">
                        {cloudAgentTarget === 'antigravity-preview-05-2026' && (
                            <span><strong>Active:</strong> Scratchbox Autonomous Cloud Agent runs high-fidelity autonomous agent loops with built-in sandbox bash execution.</span>
                        )}
                        {cloudAgentTarget === 'deep-research-preview-04-2026' && (
                            <span><strong>Active:</strong> &quot;deep-research-preview-04-2026&quot; recursively queries documents and search engines to construct deep blueprints.</span>
                        )}
                        {cloudAgentTarget === 'deep-research-max-preview-04-2026' && (
                            <span><strong>Active:</strong> &quot;deep-research-max-preview-04-2026&quot; allocates maximum thinking tokens to explore extensive codebases.</span>
                        )}
                        {cloudAgentTarget === 'code-reviewer' && (
                            <span><strong>Active:</strong> Custom project reviewer agent. Inspects modifications and provides Apple HIG feedback.</span>
                        )}
                    </div>
                </div>
            </div>

            {/* Group Card 2: Sandbox Resource Allocations */}
            <div className="sb-cursor-section-block">
                <div className="sb-cursor-section-header">Sandbox Resource Allocations</div>
                <div className="sb-cursor-group-card">
                    <div className="sb-cursor-row-item">
                        <div className="sb-cursor-row-info">
                            <div className="sb-cursor-row-title">CPU Cores Allocation</div>
                            <div className="sb-cursor-row-desc">Configure the virtual CPU cores dedicated to the remote container sandbox.</div>
                        </div>
                        <div className="sb-cursor-stepper">
                            <button type="button" className="sb-stepper-btn" onClick={() => setCloudCpuCores(Math.max(1, cloudCpuCores - 1))}>−</button>
                            <span className="sb-stepper-val">{cloudCpuCores}</span>
                            <button type="button" className="sb-stepper-btn" onClick={() => setCloudCpuCores(Math.min(8, cloudCpuCores + 1))}>+</button>
                        </div>
                    </div>

                    <div className="sb-cursor-row-item">
                        <div className="sb-cursor-row-info">
                            <div className="sb-cursor-row-title">RAM / Memory Allocation</div>
                            <div className="sb-cursor-row-desc">Slide to adjust virtual memory bounds. Higher values prevent OOM failures during heavy compilation.</div>
                        </div>
                        <div className="flex items-center gap-3">
                            <input
                                type="range"
                                min="2"
                                max="16"
                                step="2"
                                className="sb-cursor-slider"
                                value={cloudRamGb}
                                onChange={e => setCloudRamGb(Number(e.target.value))}
                            />
                            <span className="text-xs text-zinc-700 dark:text-zinc-300 font-mono font-bold w-12 text-right">{cloudRamGb} GB</span>
                        </div>
                    </div>

                    <div className="sb-cursor-row-item">
                        <div className="sb-cursor-row-info">
                            <div className="sb-cursor-row-title">Execution Timeout Limit</div>
                            <div className="sb-cursor-row-desc">Maximum execution budget in seconds for a single cloud agent milestone run.</div>
                        </div>
                        <div className="sb-cursor-stepper">
                            <button type="button" className="sb-stepper-btn" onClick={() => setCloudTimeoutSeconds(Math.max(60, cloudTimeoutSeconds - 60))}>−</button>
                            <span className="sb-stepper-val" style={{ width: '48px', textAlign: 'center' }}>{cloudTimeoutSeconds}s</span>
                            <button type="button" className="sb-stepper-btn" onClick={() => setCloudTimeoutSeconds(Math.min(3600, cloudTimeoutSeconds + 60))}>+</button>
                        </div>
                    </div>
                </div>
            </div>

            {/* Group Card 3: Cloud Agent Capabilities (Google Built-In Tools) */}
            <div className="sb-cursor-section-block">
                <div className="sb-cursor-section-header">Cloud Agent Capabilities (Google Built-In Tools)</div>
                <div className="sb-cursor-group-card">
                    <div className="sb-cursor-row-item">
                        <div className="sb-cursor-row-info">
                            <div className="sb-cursor-row-title">Google Search Grounding</div>
                            <div className="sb-cursor-row-desc">Enables real-time web retrieval during generations for up-to-date documentation and verified citations.</div>
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

                    <div className="sb-cursor-row-item">
                        <div className="sb-cursor-row-info">
                            <div className="sb-cursor-row-title">Python Code Execution</div>
                            <div className="sb-cursor-row-desc">Allows autonomous execution and testing inside Google&apos;s hosted sandboxes.</div>
                        </div>
                        <button
                            type="button"
                            role="switch"
                            aria-checked={pythonCodeExecution}
                            className={`sb-cursor-toggle ${pythonCodeExecution ? 'sb-cursor-toggle-on' : ''}`}
                            onClick={() => setPythonCodeExecution(!pythonCodeExecution)}
                        >
                            <span className="sb-cursor-toggle-thumb" />
                        </button>
                    </div>

                    <div className="sb-cursor-row-item">
                        <div className="sb-cursor-row-info">
                            <div className="sb-cursor-row-title">GCP Project ID Mapping</div>
                            <div className="sb-cursor-row-desc">Toggles routing of cloud operations using active GCP service credentials.</div>
                        </div>
                        <button
                            type="button"
                            role="switch"
                            aria-checked={gcpProjectIdMapping}
                            className={`sb-cursor-toggle ${gcpProjectIdMapping ? 'sb-cursor-toggle-on' : ''}`}
                            onClick={() => setGcpProjectIdMapping(!gcpProjectIdMapping)}
                        >
                            <span className="sb-cursor-toggle-thumb" />
                        </button>
                    </div>

                    <div className="sb-cursor-row-item">
                        <div className="sb-cursor-row-info">
                            <div className="sb-cursor-row-title">Bi-directional Filesystem Sync</div>
                            <div className="sb-cursor-row-desc">Persists sandboxed container edits back to your local environment workspace.</div>
                        </div>
                        <button
                            type="button"
                            role="switch"
                            aria-checked={bidirectionalFilesystemSync}
                            className={`sb-cursor-toggle ${bidirectionalFilesystemSync ? 'sb-cursor-toggle-on' : ''}`}
                            onClick={() => setBidirectionalFilesystemSync(!bidirectionalFilesystemSync)}
                        >
                            <span className="sb-cursor-toggle-thumb" />
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
};
