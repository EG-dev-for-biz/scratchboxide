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
    const { agentAutocomplete, autoAcceptWebSearch, autoApproveTransitions, autoParseLinks, defaultAgentModel, defaultEnvironment, importClaudeCode, includeThirdPartyConfigs, keepComputerAwake, legacyTerminalTool, manualQueueBehavior, newMessagesBehavior, remoteControlEnabled, runModeSetting, setAgentAutocomplete, setAutoAcceptWebSearch, setAutoApproveTransitions, setAutoParseLinks, setDefaultAgentModel, setDefaultEnvironment, setImportClaudeCode, setIncludeThirdPartyConfigs, setKeepComputerAwake, setLegacyTerminalTool, setManualQueueBehavior, setNewMessagesBehavior, setRemoteControlEnabled, setRunModeSetting, setSubmitWithCmdEnter, setUsageSummaryBehavior, setWaitForMcpAuth, setWebFetchToolEnabled, setWebSearchToolEnabled, submitWithCmdEnter, usageSummaryBehavior, waitForMcpAuth, webFetchToolEnabled, webSearchToolEnabled } = useSettingsContext();
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
                            <option value="last-used">Last Used ▾</option>
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
                            <option value="cursor-default">Cursor Default ▾</option>
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
                            <option value="steer">Steer ▾</option>
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
                            <option value="interrupt">Interrupt ▾</option>
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
                            <option value="auto">Auto ▾</option>
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
                            <div className="sb-cursor-row-desc">Allow agent to switch to modes like Plan or Debug without asking. When off, Cursor asks first, but skips if unanswered within 15 seconds.</div>
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
                            <div className="mt-2">
                                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded bg-zinc-800 border border-zinc-700 text-xs text-zinc-300 font-mono">
                                    submit <span className="cursor-pointer text-zinc-500 hover:text-zinc-300">×</span>
                                </span>
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
                            <div className="sb-cursor-row-title">Include Third-Party Plugins, Skills, and Other Configs</div>
                            <div className="sb-cursor-row-desc">Automatically import agent configs from other tools</div>
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
                            <div className="sb-cursor-row-title">Import Claude Code Conversations</div>
                            <div className="sb-cursor-row-desc">Sync chats and continue them in Cursor</div>
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
                            <div className="sb-cursor-row-title">Remote Control</div>
                            <div className="sb-cursor-row-desc">Allow agents on this machine to be controlled remotely from mobile</div>
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
                            <option value="unsandboxed">Run Everything (Unsandboxed) ▾</option>
                            <option value="guarded">Guarded Confirmation</option>
                            <option value="strict">Strict Sandboxed</option>
                        </select>
                    </div>
                    <div className="text-[11px] text-zinc-500">
                        All commands will run without approval, classification or sandboxing.
                    </div>
                    <a href="#learn-more" className="text-[11px] text-blue-400 hover:underline block pt-1">
                        Learn more
                    </a>
                </div>
            </div>

            {/* Terminal and Editing */}
            <div className="sb-cursor-section-block">
                <div className="sb-cursor-section-header">Terminal and Editing</div>
                <div className="sb-cursor-group-card">
                    <div className="sb-cursor-row-item">
                        <div className="sb-cursor-row-info">
                            <div className="sb-cursor-row-title">Legacy Terminal Tool</div>
                            <div className="sb-cursor-row-desc">Use the legacy terminal tool in agent mode, for use on systems with unsupported shell configurations</div>
                        </div>
                        <button
                            type="button"
                            role="switch"
                            aria-checked={legacyTerminalTool}
                            className={`sb-cursor-toggle ${legacyTerminalTool ? 'sb-cursor-toggle-on' : ''}`}
                            onClick={() => setLegacyTerminalTool(!legacyTerminalTool)}
                        >
                            <span className="sb-cursor-toggle-thumb" />
                        </button>
                    </div>

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
