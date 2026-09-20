/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/** Agents settings tab. Extracted verbatim from SettingsModal.tsx. */
import * as React from 'react';
import { useSettingsContext } from '../SettingsContext';

export const AgentsTab: React.FC = () => {
    const { agentAutocomplete, autoAcceptWebSearch, autoApproveTransitions, autoParseLinks, defaultAgentModel, defaultEnvironment, importClaudeCode, includeThirdPartyConfigs, keepComputerAwake, manualQueueBehavior, newMessagesBehavior, remoteControlEnabled, runModeSetting, setAgentAutocomplete, setAutoAcceptWebSearch, setAutoApproveTransitions, setAutoParseLinks, setDefaultAgentModel, setDefaultEnvironment, setImportClaudeCode, setIncludeThirdPartyConfigs, setKeepComputerAwake, setManualQueueBehavior, setNewMessagesBehavior, setRemoteControlEnabled, setRunModeSetting, setSubmitWithCmdEnter, setUsageSummaryBehavior, setWaitForMcpAuth, setWebFetchToolEnabled, setWebSearchToolEnabled, submitWithCmdEnter, usageSummaryBehavior, waitForMcpAuth, webFetchToolEnabled, webSearchToolEnabled } = useSettingsContext();

    const [voiceKeywords, setVoiceKeywords] = React.useState<string[]>(['submit', 'send', 'execute']);
    const [newKeywordInput, setNewKeywordInput] = React.useState('');
    const [isAddingKeyword, setIsAddingKeyword] = React.useState(false);
    const [showRunModeInfo, setShowRunModeInfo] = React.useState(false);

    const handleAddKeyword = () => {
        if (newKeywordInput.trim()) {
            const cleaned = newKeywordInput.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
            if (cleaned && !voiceKeywords.includes(cleaned)) {
                setVoiceKeywords(prev => [...prev, cleaned]);
            }
            setNewKeywordInput('');
            setIsAddingKeyword(false);
        }
    };

    const handleRemoveKeyword = (kw: string) => {
        setVoiceKeywords(prev => prev.filter(k => k !== kw));
    };

    return (
        <div className="sb-cursor-settings-content animate-fadeIn">
            <h2 className="sb-cursor-content-title">Agents</h2>

            {/* Conversation */}
            <div className="sb-cursor-section-block">
                <div className="sb-cursor-section-header">Conversation</div>
                <div className="sb-cursor-group-card">
                    <div className="sb-cursor-row-item">
                        <div className="sb-cursor-row-info">
                            <div className="sb-cursor-row-title">Submit with ⌘ + Enter</div>
                            <div className="sb-cursor-row-desc">⌘Enter submits chat, Enter inserts a newline, and primary actions move to ⌥⇧Enter</div>
                        </div>
                        <button
                            type="button"
                            role="switch"
                            aria-checked={submitWithCmdEnter}
                            className={`sb-cursor-toggle ${submitWithCmdEnter ? 'sb-cursor-toggle-on' : ''}`}
                            onClick={() => setSubmitWithCmdEnter(!submitWithCmdEnter)}
                        >
                            <span className="sb-cursor-toggle-thumb" />
                        </button>
                    </div>

                    <div className="sb-cursor-row-item">
                        <div className="sb-cursor-row-info">
                            <div className="sb-cursor-row-title">Default Environment</div>
                            <div className="sb-cursor-row-desc">Where new agents start by default</div>
                        </div>
                        <select
                            className="sb-cursor-select-dropdown"
                            value={defaultEnvironment}
                            onChange={e => setDefaultEnvironment(e.target.value)}
                        >
                            <option value="last-used">Last Used</option>
                            <option value="local">Local Machine</option>
                            <option value="cloud">Isolated Worktree</option>
                        </select>
                    </div>

                    <div className="sb-cursor-row-item">
                        <div className="sb-cursor-row-info">
                            <div className="sb-cursor-row-title">Default Model</div>
                            <div className="sb-cursor-row-desc">What model new agents use by default</div>
                        </div>
                        <select
                            className="sb-cursor-select-dropdown"
                            value={defaultAgentModel}
                            onChange={e => setDefaultAgentModel(e.target.value)}
                        >
                            <option value="cursor-default">Scratchbox Default</option>
                            <option value="high-reasoning">High Reasoning Engine</option>
                            <option value="fast">Fast Intelligence</option>
                        </select>
                    </div>

                    <div className="sb-cursor-row-item">
                        <div className="sb-cursor-row-info">
                            <div className="sb-cursor-row-title">New Messages</div>
                            <div className="sb-cursor-row-desc">Choose the default behavior of messages sent while Agent is working</div>
                        </div>
                        <select
                            className="sb-cursor-select-dropdown"
                            value={newMessagesBehavior}
                            onChange={e => setNewMessagesBehavior(e.target.value)}
                        >
                            <option value="steer">Steer</option>
                            <option value="queue">Queue</option>
                            <option value="interrupt">Interrupt</option>
                        </select>
                    </div>

                    <div className="sb-cursor-row-item">
                        <div className="sb-cursor-row-info">
                            <div className="sb-cursor-row-title">Manually Sent Messages from Queue</div>
                            <div className="sb-cursor-row-desc">Choose the default behavior of messages sent from the queue</div>
                        </div>
                        <select
                            className="sb-cursor-select-dropdown"
                            value={manualQueueBehavior}
                            onChange={e => setManualQueueBehavior(e.target.value)}
                        >
                            <option value="interrupt">Interrupt</option>
                            <option value="steer">Steer</option>
                        </select>
                    </div>

                    <div className="sb-cursor-row-item">
                        <div className="sb-cursor-row-info">
                            <div className="sb-cursor-row-title">Usage Summary</div>
                            <div className="sb-cursor-row-desc">When to show the usage summary at the bottom of the chat pane</div>
                        </div>
                        <select
                            className="sb-cursor-select-dropdown"
                            value={usageSummaryBehavior}
                            onChange={e => setUsageSummaryBehavior(e.target.value)}
                        >
                            <option value="auto">Auto</option>
                            <option value="always">Always</option>
                            <option value="never">Never</option>
                        </select>
                    </div>

                    <div className="sb-cursor-row-item">
                        <div className="sb-cursor-row-info">
                            <div className="sb-cursor-row-title">Agent Autocomplete</div>
                            <div className="sb-cursor-row-desc">Contextual suggestions while prompting Agent</div>
                        </div>
                        <button
                            type="button"
                            role="switch"
                            aria-checked={agentAutocomplete}
                            className={`sb-cursor-toggle ${agentAutocomplete ? 'sb-cursor-toggle-on' : ''}`}
                            onClick={() => setAgentAutocomplete(!agentAutocomplete)}
                        >
                            <span className="sb-cursor-toggle-thumb" />
                        </button>
                    </div>

                    <div className="sb-cursor-row-item">
                        <div className="sb-cursor-row-info">
                            <div className="sb-cursor-row-title">Auto-Approve Mode Transitions</div>
                            <div className="sb-cursor-row-desc">Allow agent to switch to modes like Plan or Debug without asking. When off, Scratchbox asks first, but skips if unanswered within 15 seconds.</div>
                        </div>
                        <button
                            type="button"
                            role="switch"
                            aria-checked={autoApproveTransitions}
                            className={`sb-cursor-toggle ${autoApproveTransitions ? 'sb-cursor-toggle-on' : ''}`}
                            onClick={() => setAutoApproveTransitions(!autoApproveTransitions)}
                        >
                            <span className="sb-cursor-toggle-thumb" />
                        </button>
                    </div>

                    <div className="sb-cursor-row-item">
                        <div className="sb-cursor-row-info">
                            <div className="sb-cursor-row-title">Voice Submit Keywords</div>
                            <div className="sb-cursor-row-desc">Custom words that submit a voice prompt. Spaces and punctuation are ignored.</div>
                            <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                                {voiceKeywords.map(kw => (
                                    <span
                                        key={kw}
                                        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded bg-zinc-800/80 border border-zinc-700/80 text-xs text-zinc-300 font-mono"
                                    >
                                        <span>{kw}</span>
                                        <button
                                            type="button"
                                            className="sb-btn-ghost text-zinc-500 hover:text-red-400 leading-none"
                                            onClick={() => handleRemoveKeyword(kw)}
                                            title={`Remove keyword "${kw}"`}
                                        >
                                            ×
                                        </button>
                                    </span>
                                ))}

                                {isAddingKeyword ? (
                                    <div className="inline-flex items-center gap-1">
                                        <input
                                            type="text"
                                            className="sb-cursor-text-input text-xs py-0.5 px-2 w-24 h-7"
                                            value={newKeywordInput}
                                            onChange={e => setNewKeywordInput(e.target.value)}
                                            placeholder="word"
                                            onKeyDown={e => {
                                                if (e.key === 'Enter') handleAddKeyword();
                                                if (e.key === 'Escape') setIsAddingKeyword(false);
                                            }}
                                            autoFocus
                                        />
                                        <button
                                            type="button"
                                            className="sb-btn sb-btn-primary sb-btn-xs h-7 px-2"
                                            onClick={handleAddKeyword}
                                        >
                                            Add
                                        </button>
                                        <button
                                            type="button"
                                            className="sb-btn sb-btn-ghost sb-btn-xs text-zinc-400 h-7 px-1.5"
                                            onClick={() => {
                                                setIsAddingKeyword(false);
                                                setNewKeywordInput('');
                                            }}
                                        >
                                            Cancel
                                        </button>
                                    </div>
                                ) : (
                                    <button
                                        type="button"
                                        className="sb-btn sb-btn-ghost sb-btn-xs text-blue-400 hover:text-blue-300"
                                        onClick={() => setIsAddingKeyword(true)}
                                    >
                                        + Add keyword
                                    </button>
                                )}
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            {/* Third-Party Imports */}
            <div className="sb-cursor-section-block">
                <div className="sb-cursor-section-header">Third-Party Imports</div>
                <div className="sb-cursor-group-card">
                    <div className="sb-cursor-row-item">
                        <div className="sb-cursor-row-info">
                            <div className="sb-cursor-row-title">Include Third-Party Configs</div>
                            <div className="sb-cursor-row-desc">Read and apply rules and tools from other tools, such as Claude Code</div>
                        </div>
                        <button
                            type="button"
                            role="switch"
                            aria-checked={includeThirdPartyConfigs}
                            className={`sb-cursor-toggle ${includeThirdPartyConfigs ? 'sb-cursor-toggle-on' : ''}`}
                            onClick={() => setIncludeThirdPartyConfigs(!includeThirdPartyConfigs)}
                        >
                            <span className="sb-cursor-toggle-thumb" />
                        </button>
                    </div>

                    <div className="sb-cursor-row-item">
                        <div className="sb-cursor-row-info">
                            <div className="sb-cursor-row-title">Import from Claude Code</div>
                            <div className="sb-cursor-row-desc">Import Claude Code configuration and history</div>
                        </div>
                        <button
                            type="button"
                            role="switch"
                            aria-checked={importClaudeCode}
                            className={`sb-cursor-toggle ${importClaudeCode ? 'sb-cursor-toggle-on' : ''}`}
                            onClick={() => setImportClaudeCode(!importClaudeCode)}
                        >
                            <span className="sb-cursor-toggle-thumb" />
                        </button>
                    </div>
                </div>
            </div>

            {/* Remote Control */}
            <div className="sb-cursor-section-block">
                <div className="sb-cursor-section-header">Remote Control</div>
                <div className="sb-cursor-group-card">
                    <div className="sb-cursor-row-item">
                        <div className="sb-cursor-row-info">
                            <div className="sb-cursor-row-title">Enable Remote Control</div>
                            <div className="sb-cursor-row-desc">Allow remote control of this computer from other devices</div>
                        </div>
                        <button
                            type="button"
                            role="switch"
                            aria-checked={remoteControlEnabled}
                            className={`sb-cursor-toggle ${remoteControlEnabled ? 'sb-cursor-toggle-on' : ''}`}
                            onClick={() => setRemoteControlEnabled(!remoteControlEnabled)}
                        >
                            <span className="sb-cursor-toggle-thumb" />
                        </button>
                    </div>

                    <div className="sb-cursor-row-item">
                        <div className="sb-cursor-row-info">
                            <div className="sb-cursor-row-title">Keep This Computer Awake</div>
                            <div className="sb-cursor-row-desc">Prevent sleep when this computer is plugged in and Remote Control is enabled</div>
                        </div>
                        <button
                            type="button"
                            role="switch"
                            aria-checked={keepComputerAwake}
                            className={`sb-cursor-toggle ${keepComputerAwake ? 'sb-cursor-toggle-on' : ''}`}
                            onClick={() => setKeepComputerAwake(!keepComputerAwake)}
                        >
                            <span className="sb-cursor-toggle-thumb" />
                        </button>
                    </div>
                </div>
            </div>

            {/* Context and Tools */}
            <div className="sb-cursor-section-block">
                <div className="sb-cursor-section-header">Context and Tools</div>
                <div className="sb-cursor-group-card">
                    <div className="sb-cursor-row-item">
                        <div className="sb-cursor-row-info">
                            <div className="sb-cursor-row-title">Web Search Tool</div>
                            <div className="sb-cursor-row-desc">Allow Agent to search the web for relevant information</div>
                        </div>
                        <button
                            type="button"
                            role="switch"
                            aria-checked={webSearchToolEnabled}
                            className={`sb-cursor-toggle ${webSearchToolEnabled ? 'sb-cursor-toggle-on' : ''}`}
                            onClick={() => setWebSearchToolEnabled(!webSearchToolEnabled)}
                        >
                            <span className="sb-cursor-toggle-thumb" />
                        </button>
                    </div>

                    <div className="sb-cursor-row-item">
                        <div className="sb-cursor-row-info">
                            <div className="sb-cursor-row-title">Auto-Accept Web Search</div>
                            <div className="sb-cursor-row-desc">Enabled by Run Everything Auto-Run Mode: Agent bypasses approval prompts for tools including Web Search.</div>
                        </div>
                        <button
                            type="button"
                            role="switch"
                            aria-checked={autoAcceptWebSearch}
                            className={`sb-cursor-toggle ${autoAcceptWebSearch ? 'sb-cursor-toggle-on' : ''}`}
                            onClick={() => setAutoAcceptWebSearch(!autoAcceptWebSearch)}
                        >
                            <span className="sb-cursor-toggle-thumb" />
                        </button>
                    </div>

                    <div className="sb-cursor-row-item">
                        <div className="sb-cursor-row-info">
                            <div className="sb-cursor-row-title">Web Fetch Tool</div>
                            <div className="sb-cursor-row-desc">Allow Agent to fetch content from URLs</div>
                        </div>
                        <button
                            type="button"
                            role="switch"
                            aria-checked={webFetchToolEnabled}
                            className={`sb-cursor-toggle ${webFetchToolEnabled ? 'sb-cursor-toggle-on' : ''}`}
                            onClick={() => setWebFetchToolEnabled(!webFetchToolEnabled)}
                        >
                            <span className="sb-cursor-toggle-thumb" />
                        </button>
                    </div>

                    <div className="sb-cursor-row-item">
                        <div className="sb-cursor-row-info">
                            <div className="sb-cursor-row-title">Wait for MCP Authentication</div>
                            <div className="sb-cursor-row-desc">Wait indefinitely to authenticate when prompted. When off, skip authentication prompts after 30 seconds.</div>
                        </div>
                        <button
                            type="button"
                            role="switch"
                            aria-checked={waitForMcpAuth}
                            className={`sb-cursor-toggle ${waitForMcpAuth ? 'sb-cursor-toggle-on' : ''}`}
                            onClick={() => setWaitForMcpAuth(!waitForMcpAuth)}
                        >
                            <span className="sb-cursor-toggle-thumb" />
                        </button>
                    </div>
                </div>
            </div>

            {/* Execution and Approvals */}
            <div className="sb-cursor-section-block">
                <div className="sb-cursor-section-header">Execution and Approvals</div>
                <div className="sb-cursor-group-card p-4 space-y-2">
                    <div className="flex items-center justify-between">
                        <div>
                            <div className="sb-cursor-row-title">Run Mode</div>
                            <div className="sb-cursor-row-desc">Choose how Agents run tools like command execution, MCP, and file writes.</div>
                        </div>
                        <select
                            className="sb-cursor-select-dropdown"
                            value={runModeSetting}
                            onChange={e => setRunModeSetting(e.target.value)}
                        >
                            <option value="unsandboxed">Run Everything (Unsandboxed)</option>
                            <option value="guarded">Guarded Confirmation</option>
                            <option value="strict">Strict Sandboxed</option>
                        </select>
                    </div>
                    <div className="text-xs text-zinc-500">
                        {runModeSetting === 'unsandboxed' && 'All commands will run directly without approval, classification or sandboxing.'}
                        {runModeSetting === 'guarded' && 'Commands with high blast radius require interactive user confirmation before execution.'}
                        {runModeSetting === 'strict' && 'All terminal processes and filesystem writes run in isolated containers.'}
                    </div>
                    <button
                        type="button"
                        onClick={() => setShowRunModeInfo(!showRunModeInfo)}
                        className="sb-btn-ghost text-xs text-blue-400 hover:underline block pt-1 text-left bg-transparent border-0 p-0 cursor-pointer"
                    >
                        {showRunModeInfo ? 'Hide policy details ▲' : 'Learn more about execution policies ▾'}
                    </button>
                    {showRunModeInfo && (
                        <div className="mt-2 p-3 bg-zinc-900/80 rounded-lg border border-zinc-800 text-xs text-zinc-300 space-y-1.5 animate-fadeIn">
                            <div className="font-semibold text-zinc-200">Execution Policy Levels:</div>
                            <ul className="list-disc list-inside space-y-1 text-zinc-400">
                                <li><strong className="text-zinc-200">Unsandboxed:</strong> Direct local execution for rapid iterative prototyping.</li>
                                <li><strong className="text-zinc-200">Guarded:</strong> Heuristic inspection prompts on git push, rm -rf, and network calls.</li>
                                <li><strong className="text-zinc-200">Strict:</strong> Total process isolation with zero network escalation without explicit token.</li>
                            </ul>
                        </div>
                    )}
                </div>
            </div>

            {/* Editing and Links */}
            <div className="sb-cursor-section-block">
                <div className="sb-cursor-section-header">Editing and Links</div>
                <div className="sb-cursor-group-card">
                    <div className="sb-cursor-row-item">
                        <div className="sb-cursor-row-info">
                            <div className="sb-cursor-row-title">Auto-Parse Links</div>
                            <div className="sb-cursor-row-desc">Automatically parse links when pasted into Quick Edit (⌘K) input</div>
                        </div>
                        <button
                            type="button"
                            role="switch"
                            aria-checked={autoParseLinks}
                            className={`sb-cursor-toggle ${autoParseLinks ? 'sb-cursor-toggle-on' : ''}`}
                            onClick={() => setAutoParseLinks(!autoParseLinks)}
                        >
                            <span className="sb-cursor-toggle-thumb" />
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
};
