/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as React from 'react';
import { McpServerItem, SkillItem, StudioLayoutMode } from '../canvas-types';
import type { ContextMentionCategory, ContextMentionItem } from '../context-mention-engine';
import { ContextMentionAutocompletePopover } from '../ContextMentionAutocompletePopover';
import { IconClose, IconMic, IconPlus } from '../canvas-icons';
import type { AttachedDataFile } from '../hooks/useSendMessage';
import type { WorkspaceGitStatusSnapshot } from '../state/studio-defaults';

export function getComposerPlaceholder(
    attachedDataFile: AttachedDataFile | undefined,
    activeArtifactTitle: string | undefined,
    layoutMode: StudioLayoutMode
): string {
    if (attachedDataFile) {
        return `Ask about ${attachedDataFile.name} (e.g. Generate KPI metrics and charts)...`;
    }
    if (activeArtifactTitle && layoutMode !== 'chat') {
        return `Ask AI to edit ${activeArtifactTitle}...`;
    }
    if (layoutMode === 'code') {
        return 'Ask AI to edit Live React UI Sandbox...';
    }
    if (layoutMode === 'document') {
        return 'Ask AI to edit Project Specification...';
    }
    if (layoutMode === 'kanban') {
        return 'Ask AI to edit Sprint Roadmap...';
    }
    if (layoutMode === 'automation' || layoutMode === 'canvas') {
        return 'Ask AI to edit Canvas Workflow...';
    }
    return 'Prompt any creation (3D, apps, specs, boards)... (/ for skills, @ for context)';
}

export interface ComposerProps {
    inSplitPane?: boolean;
    inputValue: string;
    isGenerating: boolean;
    isVoiceActive: boolean;
    isDraggingDataFile: boolean;
    setIsDraggingDataFile: React.Dispatch<React.SetStateAction<boolean>>;
    aiInteractionMode: 'agent' | 'ask' | 'plan';
    setAiInteractionMode: React.Dispatch<React.SetStateAction<'agent' | 'ask' | 'plan'>>;
    attachedDataFile: AttachedDataFile | undefined;
    setAttachedDataFile: React.Dispatch<React.SetStateAction<AttachedDataFile | undefined>>;
    attachedContextMentions: ContextMentionItem[];
    setAttachedContextMentions: React.Dispatch<React.SetStateAction<ContextMentionItem[]>>;
    skills: SkillItem[];
    mcpServers: McpServerItem[];
    selectedSkillIds: string[];
    selectedMcpIds: string[];
    autocompleteType: 'skill' | 'mcp' | 'context' | undefined;
    setAutocompleteType: React.Dispatch<React.SetStateAction<'skill' | 'mcp' | 'context' | undefined>>;
    autocompleteQuery: string | undefined;
    selectedAutocompleteIndex: number;
    activeContextCategory: ContextMentionCategory;
    setActiveContextCategory: React.Dispatch<React.SetStateAction<ContextMentionCategory>>;
    filteredAutocompleteSkills: SkillItem[];
    workspaceFilesList: string[];
    workspaceGitStatus: WorkspaceGitStatusSnapshot;
    activeArtifactTitle: string | undefined;
    layoutMode: StudioLayoutMode;
    inputRef: React.RefObject<HTMLTextAreaElement>;
    fileInputRef: React.RefObject<HTMLInputElement>;
    handleFileDrop: (file: File) => void;
    handleFileInputChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
    handleInputChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
    handleKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
    handleVoiceToggle: () => void;
    handleToggleComposerSkill: (skillId: string) => void;
    handleToggleComposerMcp: (mcpId: string) => void;
    handleSelectAutocompleteSkill: (skill: SkillItem) => void;
    handleSelectAutocompleteContext: (item: ContextMentionItem) => void;
    sendMessage: () => void;
}

/**
 * The unified chat composer capsule: attachments/data-file pills, `/` skill and `@` context
 * autocomplete, voice dictation, mode selector, auto-growing textarea and send button.
 */
export const Composer: React.FC<ComposerProps> = ({
    inSplitPane = false,
    inputValue,
    isGenerating,
    isVoiceActive,
    isDraggingDataFile,
    setIsDraggingDataFile,
    aiInteractionMode,
    setAiInteractionMode,
    attachedDataFile,
    setAttachedDataFile,
    attachedContextMentions,
    setAttachedContextMentions,
    skills,
    mcpServers,
    selectedSkillIds,
    selectedMcpIds,
    autocompleteType,
    setAutocompleteType,
    autocompleteQuery,
    selectedAutocompleteIndex,
    activeContextCategory,
    setActiveContextCategory,
    filteredAutocompleteSkills,
    workspaceFilesList,
    workspaceGitStatus,
    activeArtifactTitle,
    layoutMode,
    inputRef,
    fileInputRef,
    handleFileDrop,
    handleFileInputChange,
    handleInputChange,
    handleKeyDown,
    handleVoiceToggle,
    handleToggleComposerSkill,
    handleToggleComposerMcp,
    handleSelectAutocompleteSkill,
    handleSelectAutocompleteContext,
    sendMessage
}) => (
    <div
        className={`sb-unified-composer-capsule ${inSplitPane ? 'sb-split-pane-composer' : ''} ${isDraggingDataFile ? 'sb-composer-drag-over' : ''}`}
        onDragOver={e => {
            e.preventDefault();
            setIsDraggingDataFile(true);
        }}
        onDragLeave={e => {
            e.preventDefault();
            setIsDraggingDataFile(false);
        }}
        onDrop={e => {
            e.preventDefault();
            setIsDraggingDataFile(false);
            if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
                handleFileDrop(e.dataTransfer.files[0]);
            }
        }}
    >
        {/* Hidden file picker input */}
        <input
            ref={fileInputRef}
            type="file"
            style={{ display: 'none' }}
            accept=".csv,.tsv,.txt,.json"
            onChange={handleFileInputChange}
        />

        {/* Drag & Drop Highlight Overlay */}
        {isDraggingDataFile && (
            <div className="sb-composer-drag-hint-overlay animate-fadeIn">
                <span className="sb-drag-hint-icon">📊</span>
                <span className="sb-drag-hint-text">Drop CSV or data file to generate instant KPI Metric Dashboard &amp; Table</span>
            </div>
        )}

        {/* Active Capabilities & Attached Data File Pills Bar */}
        {(selectedSkillIds.length > 0 || selectedMcpIds.length > 0 || attachedDataFile !== undefined || attachedContextMentions.length > 0) && (
            <div className="sb-composer-active-pills-row sb-cursor-attached-context-row">
                <span className="sb-composer-pills-label">Assisting:</span>

                {/* Attached CSV / Data File Pill */}
                {attachedDataFile && (
                    <span className="sb-composer-pill sb-composer-pill-data">
                        <span className="sb-composer-pill-icon">📊</span>
                        <span className="sb-composer-pill-text max-w-[140px] truncate" title={`${attachedDataFile.name} (${attachedDataFile.rowsCount} rows)`}>
                            {attachedDataFile.name} ({attachedDataFile.rowsCount} rows)
                        </span>
                        <button
                            type="button"
                            className="sb-composer-pill-remove"
                            onClick={() => setAttachedDataFile(undefined)}
                            title="Remove attached data file"
                        >
                            <IconClose size={9} strokeWidth={2.5} />
                        </button>
                    </span>
                )}

                {selectedSkillIds.map(skId => {
                    const sk = skills.find(s => s.id === skId);
                    if (!sk) return undefined;
                    return (
                        <span key={sk.id} className="sb-composer-pill">
                            <span className="sb-composer-pill-text max-w-[140px] truncate" title={sk.name}>{sk.name}</span>
                            <button
                                type="button"
                                className="sb-composer-pill-remove"
                                onClick={() => handleToggleComposerSkill(sk.id)}
                                title={`Detach ${sk.name}`}
                            >
                                <IconClose size={9} strokeWidth={2.5} />
                            </button>
                        </span>
                    );
                })}

                {selectedMcpIds.map(mcpId => {
                    const mcp = mcpServers.find(m => m.id === mcpId);
                    if (!mcp) return undefined;
                    return (
                        <span key={mcp.id} className="sb-composer-pill sb-composer-pill-mcp">
                            <span className="sb-composer-pill-text max-w-[140px] truncate" title={mcp.name}>{mcp.name}</span>
                            <button
                                type="button"
                                className="sb-composer-pill-remove"
                                onClick={() => handleToggleComposerMcp(mcp.id)}
                                title={`Detach ${mcp.name}`}
                            >
                                <IconClose size={9} strokeWidth={2.5} />
                            </button>
                        </span>
                    );
                })}

                {/* Attached Context Mention Pills (@file, @git, @terminal, etc.) */}
                {attachedContextMentions.map(ctx => (
                    <span key={ctx.id} className="sb-composer-pill" style={{ background: 'rgba(59, 130, 246, 0.15)', borderColor: 'rgba(59, 130, 246, 0.3)', color: '#93c5fd' }}>
                        <span className="sb-composer-pill-icon">{ctx.icon || '📄'}</span>
                        <span className="sb-composer-pill-text max-w-[140px] truncate" title={ctx.name}>{ctx.name}</span>
                        <button
                            type="button"
                            className="sb-composer-pill-remove"
                            onClick={() => setAttachedContextMentions(prev => prev.filter(c => c.id !== ctx.id))}
                            title={`Detach @${ctx.type}`}
                        >
                            <IconClose size={9} strokeWidth={2.5} />
                        </button>
                    </span>
                ))}
            </div>
        )}

        {/* Autocomplete Popup Menu */}
        {autocompleteType === 'context' && (
            <ContextMentionAutocompletePopover
                isOpen={true}
                activeCategory={activeContextCategory}
                onCategoryChange={setActiveContextCategory}
                query={autocompleteQuery || ''}
                selectedIndex={selectedAutocompleteIndex}
                workspaceFiles={workspaceFilesList}
                gitStatus={workspaceGitStatus}
                mcpServers={mcpServers}
                onSelectMention={handleSelectAutocompleteContext}
                onClose={() => setAutocompleteType(undefined)}
                width="420px"
                maxHeight="240px"
            />
        )}

        {autocompleteType === 'skill' && (
            <div className="sb-composer-autocomplete-popover animate-popover" style={{ width: '420px', maxHeight: '340px' }}>
                <div className="sb-autocomplete-header">
                    <span>Select Superpower (/)</span>
                    <span className="sb-autocomplete-hint">Esc to dismiss</span>
                </div>

                <div className="sb-autocomplete-list" style={{ maxHeight: '240px' }}>
                    {filteredAutocompleteSkills.length > 0 ? (
                        filteredAutocompleteSkills.map((sk, idx) => (
                            <div
                                key={sk.id}
                                className={`sb-autocomplete-item ${idx === selectedAutocompleteIndex ? 'sb-autocomplete-item-selected' : ''}`}
                                style={idx === selectedAutocompleteIndex ? { background: 'rgba(59, 130, 246, 0.15)', borderColor: 'rgba(59, 130, 246, 0.3)' } : undefined}
                                onClick={() => handleSelectAutocompleteSkill(sk)}
                            >
                                <div className="sb-auto-info">
                                    <span className="sb-auto-title">{sk.name}</span>
                                    <span className="sb-auto-tagline">{sk.tagline}</span>
                                </div>
                                <span className="sb-auto-category">{sk.category}</span>
                            </div>
                        ))
                    ) : (
                        <div className="sb-autocomplete-empty">No matching superpowers</div>
                    )}
                </div>
            </div>
        )}

        {isVoiceActive && (
            <div className="sb-voice-active-indicator animate-fadeIn">
                <div className="sb-voice-wave-bars">
                    <span className="sb-voice-bar sb-vb-1" />
                    <span className="sb-voice-bar sb-vb-2" />
                    <span className="sb-voice-bar sb-vb-3" />
                    <span className="sb-voice-bar sb-vb-4" />
                    <span className="sb-voice-bar sb-vb-5" />
                </div>
                <span className="sb-voice-label">Listening... Speak prompt in real time</span>
                <button
                    type="button"
                    className="sb-voice-stop-btn"
                    onClick={handleVoiceToggle}
                >
                    Done
                </button>
            </div>
        )}

        {/* Authentic Cursor-Grade Composer Main Row */}
        <div className="sb-composer-main-row">
            {/* Left: '+' Tools / Superpowers / File Attach button and Mode Selector */}
            <div className="sb-composer-left-actions">
                <button
                    type="button"
                    className="sb-composer-attach-btn"
                    onClick={() => fileInputRef.current?.click()}
                    title="Attach CSV / Data file or Superpowers (/ for skills, @ for MCP)"
                >
                    <IconPlus size={14} strokeWidth={2.2} />
                </button>
                <div className="sb-cursor-mode-selector">
                    <button
                        type="button"
                        className={`sb-cursor-mode-pill ${aiInteractionMode === 'agent' ? 'sb-cursor-mode-pill-active' : ''}`}
                        onClick={() => setAiInteractionMode('agent')}
                        title="Agent Mode: Autonomous multi-step code & canvas execution"
                    >
                        Agent
                    </button>
                    <button
                        type="button"
                        className={`sb-cursor-mode-pill ${aiInteractionMode === 'ask' ? 'sb-cursor-mode-pill-active' : ''}`}
                        onClick={() => setAiInteractionMode('ask')}
                        title="Ask Mode: Direct questions, code explanations, & doc search"
                    >
                        Ask
                    </button>
                    <button
                        type="button"
                        className={`sb-cursor-mode-pill ${aiInteractionMode === 'plan' ? 'sb-cursor-mode-pill-active' : ''}`}
                        onClick={() => setAiInteractionMode('plan')}
                        title="Plan Mode: Architecture breakdown & execution blueprints"
                    >
                        Plan
                    </button>
                </div>
            </div>

            {/* Center: Multi-line Auto-Expanding Textarea Input */}
            <div className="sb-composer-input-area">
                <textarea
                    ref={inputRef}
                    rows={1}
                    className="sb-composer-main-input"
                    placeholder={getComposerPlaceholder(attachedDataFile, activeArtifactTitle, layoutMode)}
                    value={inputValue}
                    disabled={isGenerating}
                    onChange={handleInputChange}
                    onKeyDown={handleKeyDown}
                    autoFocus
                />
            </div>

            {/* Right: Voice & Send */}
            <div className="sb-composer-actions-right">
                {/* Voice Dictation Trigger */}
                <button
                    type="button"
                    className={`sb-composer-voice-trigger ${isVoiceActive ? 'sb-voice-on' : ''}`}
                    onClick={handleVoiceToggle}
                    title={isVoiceActive ? 'Stop listening' : 'Voice input (Web Speech API)'}
                >
                    <IconMic size={15} strokeWidth={1.8} />
                </button>

                <button
                    type="button"
                    className={`sb-composer-send-circle ${inputValue.trim() || attachedDataFile ? 'sb-send-ready' : ''}`}
                    disabled={(!inputValue.trim() && !attachedDataFile) || isGenerating}
                    onClick={() => sendMessage()}
                    title="Send message (Enter)"
                >
                    {isGenerating ? (
                        <span className="sb-send-loading-dot" />
                    ) : (
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                            <line x1="12" y1="19" x2="12" y2="5" />
                            <polyline points="5 12 12 5 19 12" />
                        </svg>
                    )}
                </button>
            </div>
        </div>
    </div>
);
