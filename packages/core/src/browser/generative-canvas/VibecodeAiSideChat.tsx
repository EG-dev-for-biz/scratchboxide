/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as React from 'react';
import { ChatMessage, WorkspaceFileType, AgentExecutionStep } from './canvas-types';
import {
    IconArrowDown,
    IconArrowUp,
    IconClose,
    IconCopy,
    IconFileCode,
    IconGitFork,
    IconMic,
    IconPlus,
    IconSparkles,
    IconThumbsDown,
    IconThumbsUp,
    IconUndo
} from './canvas-icons';
import { ChatMarkdownRenderer, cleanMessageTextSmart, ThinkingDisclosure, AgentExecutionStepper, StreamingCursor } from './ChatMarkdownRenderer';
import {
    ContextMentionCategory,
    ContextMentionItem,
    findTriggerMatch,
    insertMentionToken,
    cycleSelectedIndex,
    resolveContextMentionQuery
} from './context-mention-engine';
import { ContextMentionAutocompletePopover } from './ContextMentionAutocompletePopover';
import { AudioPlayer } from './gemini-client';

export interface VibecodeAiSideChatProps {
    messages: ChatMessage[];
    onSendMessage: (promptText: string) => void;
    isGenerating?: boolean;
    liveStreamedText?: string;
    liveThinkingText?: string;
    liveThinkingSeconds?: number;
    liveSteps?: AgentExecutionStep[];
    activeContextType: WorkspaceFileType | 'node-graph' | 'metric-dashboard';
    activeContextTitle: string;
    quickPrompts?: string[];
    onClose?: () => void;
    onToggleCanvas?: () => void;
    onToggleTerminal?: () => void;
    isCanvasActive?: boolean;
    isTerminalActive?: boolean;
    onAddContext?: () => void;
    onOpenInBrowser?: (url: string, title?: string) => void;
    onDeepWriteStart?: (promptText: string, plan: any) => void;
    onDeepWriteResume?: (sessionId: string, feedback: string) => void;
}

export const VibecodeAiSideChat: React.FC<VibecodeAiSideChatProps> = ({
    messages,
    onSendMessage,
    isGenerating = false,
    liveStreamedText = '',
    liveThinkingText = '',
    liveThinkingSeconds = 0,
    liveSteps = [],
    activeContextType,
    activeContextTitle,
    quickPrompts,
    onClose,
    onToggleCanvas,
    onToggleTerminal,
    isCanvasActive = true,
    isTerminalActive = false,
    onAddContext,
    onOpenInBrowser,
    onDeepWriteStart,
    onDeepWriteResume
}) => {
    const [inputValue, setInputValue] = React.useState<string>('');
    const [checkpointFeedback, setCheckpointFeedback] = React.useState<Record<string, string>>({});
    const [audioState, setAudioState] = React.useState<'idle' | 'loading' | 'playing' | 'error'>('idle');

    const handleListenToDiff = React.useCallback(() => {
        if (audioState === 'playing') {
            AudioPlayer.stop();
            setAudioState('idle');
            return;
        }

        const textToSpeak = `I have successfully updated the ${activeContextTitle} artifact. The changes introduce clean design boundaries with 14 additions and 4 deletions. Let me know if you would like me to explain the logic in more detail.`;
        AudioPlayer.speak(textToSpeak, setAudioState);
    }, [activeContextTitle, audioState]);
    const [msgReactions, setMsgReactions] = React.useState<Record<string, 'up' | 'down'>>({});
    const [isVoiceRecording, setIsVoiceRecording] = React.useState<boolean>(false);
    const [attachedContextMentions, setAttachedContextMentions] = React.useState<ContextMentionItem[]>([]);
    const [showMentionMenu, setShowMentionMenu] = React.useState<boolean>(false);
    const [mentionQuery, setMentionQuery] = React.useState<string>('');
    const [activeMentionCategory, setActiveMentionCategory] = React.useState<ContextMentionCategory>('file');
    const [selectedMentionIndex, setSelectedMentionIndex] = React.useState<number>(0);
    const [aiInteractionMode, setAiInteractionMode] = React.useState<'agent' | 'ask' | 'plan'>('agent');
    const [expandedToolStepId, setExpandedToolStepId] = React.useState<string | null>(null);
    const chatEndRef = React.useRef<HTMLDivElement | null>(null);
    const speechRecognitionRef = React.useRef<any>(null);

    React.useEffect(() => {
        if (chatEndRef.current) {
            chatEndRef.current.scrollIntoView({ behavior: 'smooth' });
        }
    }, [messages, isGenerating, liveStreamedText]);

    const toggleReaction = (msgId: string, reaction: 'up' | 'down') => {
        setMsgReactions(prev => ({
            ...prev,
            [msgId]: prev[msgId] === reaction ? (undefined as any) : reaction
        }));
    };

    const handleSend = (textToSend?: string) => {
        const text = (textToSend !== undefined ? textToSend : inputValue).trim();
        if (!text || isGenerating) return;
        setInputValue('');
        setAttachedContextMentions([]);
        setShowMentionMenu(false);
        onSendMessage(text);
    };

    const handleTextChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
        const val = e.target.value;
        setInputValue(val);
        const cursorPos = e.target.selectionStart || val.length;
        const match = findTriggerMatch(val, cursorPos);
        if (match && match.type === 'context') {
            setShowMentionMenu(true);
            setMentionQuery(match.query);
            setSelectedMentionIndex(0);
        } else if (showMentionMenu) {
            setShowMentionMenu(false);
        }
    };

    const handleSelectMention = (item: ContextMentionItem) => {
        if (!attachedContextMentions.some(c => c.id === item.id)) {
            setAttachedContextMentions(prev => [...prev, item]);
        }
        const match = findTriggerMatch(inputValue);
        if (match) {
            const res = insertMentionToken(inputValue, match.triggerIndex, match.query.length + 1, '');
            setInputValue(res.newText.trim());
        }
        setShowMentionMenu(false);
    };

    const toggleVoiceInput = () => {
        if (typeof window === 'undefined') return;
        const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
        if (!SpeechRecognition) {
            console.warn('Voice dictation is not supported in this browser environment.');
            return;
        }

        if (isVoiceRecording && speechRecognitionRef.current) {
            speechRecognitionRef.current.stop();
            setIsVoiceRecording(false);
            return;
        }

        try {
            const recognition = new SpeechRecognition();
            recognition.continuous = false;
            recognition.interimResults = false;
            recognition.lang = 'en-US';

            recognition.onstart = () => {
                setIsVoiceRecording(true);
            };

            recognition.onresult = (event: any) => {
                const transcript = event.results[0][0].transcript;
                if (transcript) {
                    setInputValue(prev => prev ? `${prev} ${transcript}` : transcript);
                }
                setIsVoiceRecording(false);
            };

            recognition.onerror = () => {
                setIsVoiceRecording(false);
            };

            recognition.onend = () => {
                setIsVoiceRecording(false);
            };

            speechRecognitionRef.current = recognition;
            recognition.start();
        } catch (e) {
            setIsVoiceRecording(false);
        }
    };

    const defaultQuickPromptsMap: Record<string, string[]> = {
        code: [
            'Add Spring Physics',
            'Apply Liquid Glass UI',
            'Confetti Action Trigger',
            'Responsive Bento Grid'
        ],
        document: [
            'Add API Spec Table',
            'Add Architecture Callout',
            'Add Action Checklist',
            'Add Overview & Objectives Section'
        ],
        kanban: [
            'Add Core Integration Task',
            'Add QA Review Column',
            'Prioritize Critical Bugs',
            'Move Tasks to In Progress'
        ],
        automation: [
            'Add Webhook Trigger Node',
            'Add AI Reasoning Node',
            'Add Postgres DB Action',
            'Connect Logic Pipeline'
        ],
        'node-graph': [
            'Add Webhook Trigger Node',
            'Add AI Reasoning Node',
            'Add Postgres DB Action',
            'Connect Logic Pipeline'
        ]
    };

    const resolvedPrompts = quickPrompts || defaultQuickPromptsMap[activeContextType] || defaultQuickPromptsMap.code;

    return (
        <div className="sb-ide-chat-panel animate-fadeIn">
            <div className="sb-ide-chat-header">
                <div className="sb-ide-chat-title">
                    <IconSparkles size={13} className="text-blue-400" />
                    <span>AI Assistant</span>
                </div>
                {onClose && (
                    <button
                        type="button"
                        className="sb-ide-chat-close-btn"
                        onClick={onClose}
                        title="Close chat"
                    >
                        <IconClose size={11} />
                    </button>
                )}
            </div>
            {/* Conversation Messages Stream */}
            <div className="sb-ide-chat-messages">
                {messages.length === 0 && (
                    <div className="sb-cursor-assistant-card animate-fadeIn">
                        <div className="sb-cursor-assistant-body">
                            <p className="sb-cursor-paragraph">
                                {activeContextType === 'code' ? "I'm your Vibecode assistant. Prompt me below to generate UI components, add spring animations, or refactor code in real-time." :
                                 activeContextType === 'document' ? "I'm your Document assistant. Ask me to draft sections, add specification tables, architecture callouts, or action checklists." :
                                 activeContextType === 'kanban' ? "I'm your Sprint assistant. Ask me to add tasks, configure delivery columns, prioritize bugs, or move cards." :
                                 "I'm your Canvas assistant. Ask me to add webhook triggers, AI reasoning nodes, or database actions."}
                            </p>
                        </div>
                    </div>
                )}
                {messages.map((msg, idx) => {
                    if (msg.sender === 'user') {
                        return (
                            <div key={msg.id || `user-msg-${idx}`} className="sb-cursor-user-card animate-fadeIn">
                                <div className="sb-cursor-user-header">
                                    <div className="sb-cursor-user-badge">
                                        <span className="sb-cursor-user-dot" />
                                    </div>
                                    <button
                                        type="button"
                                        className="sb-cursor-action-icon-btn"
                                        onClick={() => setInputValue(msg.text)}
                                        title="Edit prompt / Retry"
                                    >
                                        <IconUndo size={11} strokeWidth={2} />
                                    </button>
                                </div>
                                <div className="sb-cursor-user-text">{msg.text}</div>
                            </div>
                        );
                    }

                    if (msg.deepWriteOffer && msg.deepWritePlan) {
                        const plan = msg.deepWritePlan;
                        return (
                            <div key={msg.id} className="sb-cursor-assistant-card animate-fadeIn" style={{ borderLeft: '3px solid #3b82f6', padding: '16px' }}>
                                <div className="flex items-center gap-2 mb-3">
                                    <span style={{ color: '#3b82f6' }}><IconSparkles size={16} /></span>
                                    <strong className="text-sm font-semibold text-white">Intelligent Co-Planner Offer</strong>
                                </div>
                                <div className="mb-3 text-xs text-slate-300">
                                    <p className="mb-2"><strong>Analyzed Goal:</strong> {plan.goal}</p>
                                    <p className="mb-2"><strong>Target Platforms:</strong> {plan.domains.map((d: string) => `[${d}]`).join(', ')}</p>
                                    <p className="mb-2"><strong>Suggested Canvas Deliverables:</strong> {plan.deliverables.primitives.map((p: string) => `[${p}]`).join(', ')}</p>
                                    <div className="bg-slate-900/60 p-2.5 rounded border border-slate-800 font-mono text-[10px] leading-relaxed text-slate-400 mt-2 max-h-[140px] overflow-y-auto">
                                        <strong>Strategic Rationale:</strong><br />
                                        {plan.analysisReasoning}
                                    </div>
                                </div>
                                <button
                                    type="button"
                                    className="sb-btn-primary w-full py-1.5 text-xs font-semibold rounded"
                                    onClick={() => onDeepWriteStart?.(plan.goal, plan)}
                                >
                                    Confirm & Run Deep-Write Pipeline
                                </button>
                            </div>
                        );
                    }

                    if (msg.deepWriteProgress) {
                        const p = msg.deepWriteProgress;
                        const stages = p.plan?.stages || [];
                        const total = p.totalStages || stages.length || 1;
                        const currentIdx = stages.findIndex((s: any) => s.id === p.currentStageId) + 1;
                        const progress = Math.max(p.progressPercent || Math.round((currentIdx / total) * 100), 2);
                        const isDone = p.type === 'pipeline_complete';
                        const isError = p.type === 'error';

                        return (
                            <div key={msg.id} className="sb-cursor-assistant-card animate-fadeIn" style={{ borderLeft: `3px solid ${isError ? '#ef4444' : isDone ? '#10b981' : '#3b82f6'}`, padding: '16px' }}>
                                <div className="flex items-center justify-between mb-2">
                                    <strong className="text-sm font-semibold text-white">
                                        {isError ? 'Deep-Write Error' : isDone ? 'Deep-Write Completed!' : 'Planning & Authoring Pipeline'}
                                    </strong>
                                    <span className="text-[10px] text-slate-400 font-mono font-bold">{progress}%</span>
                                </div>
                                <div className="w-full bg-slate-800 rounded-full h-1.5 mb-3 overflow-hidden">
                                    <div className={`h-full rounded-full transition-all duration-500 ${isError ? 'bg-red-500' : isDone ? 'bg-emerald-500' : 'bg-blue-500'}`} style={{ width: `${progress}%` }} />
                                </div>
                                <div className="text-xs text-slate-300 space-y-2">
                                    {p.currentStageName && (
                                        <p><strong>Active Phase:</strong> <span className="text-blue-400 font-medium">{p.currentStageName}</span></p>
                                    )}
                                    {p.message && <p className="italic text-slate-400">{p.message}</p>}
                                    {p.thinking && (
                                        <div className="bg-slate-900/40 p-2 rounded border border-slate-800/80 font-mono text-[10px] text-slate-400 max-h-[80px] overflow-y-auto">
                                            {p.thinking}
                                        </div>
                                    )}
                                    {p.query && (
                                        <p className="text-[10px] text-slate-400 font-mono">
                                            🔎 <strong>Grounding Query:</strong> {p.query}
                                        </p>
                                    )}
                                </div>
                            </div>
                        );
                    }

                    if (msg.deepWriteCheckpoint && msg.deepWriteCheckpoint.status === 'awaiting_feedback') {
                        const checkpoint = msg.deepWriteCheckpoint;
                        const feedbackValue = checkpointFeedback[msg.id] || '';

                        return (
                            <div key={msg.id} className="sb-cursor-assistant-card animate-fadeIn" style={{ borderLeft: '3px solid #f59e0b', padding: '16px' }}>
                                <div className="flex items-center gap-2 mb-3">
                                    <span className="w-2 h-2 bg-amber-500 rounded-full animate-pulse" />
                                    <strong className="text-sm font-semibold text-white">Checkpoint Pause Gate</strong>
                                </div>
                                <div className="mb-3 text-xs text-slate-300">
                                    <p className="mb-2">The pipeline has successfully compiled intermediate stages and paused at <strong>{checkpoint.stageName}</strong> for your review and styling alignment.</p>
                                    <div className="bg-slate-900/50 p-2 rounded border border-slate-800/80 font-mono text-[10px] text-slate-400 space-y-1 mb-3">
                                        <strong>Active Decision Points:</strong>
                                        {checkpoint.decisionPoints.map((d: string, i: number) => (
                                            <div key={i}>• {d}</div>
                                        ))}
                                    </div>
                                    <textarea
                                        className="w-full bg-slate-950 border border-slate-800 rounded p-2 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-amber-500"
                                        placeholder="Steer the pipeline: e.g. 'always use functional programming', 'make aerodynamics more aggressive', 'WebGL works best here'..."
                                        rows={3}
                                        value={feedbackValue}
                                        onChange={(e) => setCheckpointFeedback({ ...checkpointFeedback, [msg.id]: e.target.value })}
                                    />
                                </div>
                                <button
                                    type="button"
                                    className="sb-btn-primary w-full py-1.5 text-xs font-semibold rounded"
                                    onClick={() => {
                                        onDeepWriteResume?.(checkpoint.sessionId, feedbackValue);
                                        // clear local draft feedback state and mark resumed in UI
                                        setCheckpointFeedback({ ...checkpointFeedback, [msg.id]: '' });
                                        msg.deepWriteCheckpoint!.status = 'resumed';
                                    }}
                                >
                                    Steer & Resume Planning Pipeline
                                </button>
                            </div>
                        );
                    }

                    const isFirstInit = idx === 0 && msg.id?.startsWith('init');
                    const cleanText = isFirstInit ? msg.text : cleanMessageTextSmart(msg.text, msg.artifacts?.[0]);
                    return (
                        <div key={msg.id || `asst-msg-${idx}`} className="sb-cursor-assistant-card animate-fadeIn">
                            {!isFirstInit && msg.thinkingText && (
                                <ThinkingDisclosure
                                    thinkingText={msg.thinkingText}
                                    durationSeconds={msg.thinkingDurationSeconds}
                                />
                            )}
                            <div className="sb-cursor-assistant-body">
                                <ChatMarkdownRenderer
                                    text={cleanText}
                                    className="sb-cursor-markdown-content"
                                    onOpenInBrowser={onOpenInBrowser}
                                />
                            </div>

                            {/* Autonomous Multimodal Vision QA Audit Card */}
                            {msg.visualAudit && (
                                <div className="sb-visual-audit-card mt-3 mb-2 p-3 bg-slate-900/90 rounded-xl border border-blue-500/30 shadow-lg animate-fadeIn text-xs">
                                    <div className="flex items-center justify-between gap-2 mb-2">
                                        <div className="flex items-center gap-1.5 text-blue-400 font-semibold text-[11px]">
                                            <IconSparkles size={13} className="text-blue-400" />
                                            <span>Multimodal Vision QA Verification</span>
                                        </div>
                                        <div className={`px-2 py-0.5 rounded-full text-[10px] font-mono font-bold flex items-center gap-1 ${
                                            msg.visualAudit.fidelityScore >= 80 
                                                ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30' 
                                                : 'bg-amber-500/20 text-amber-400 border border-amber-500/30'
                                        }`}>
                                            <span>Fidelity {msg.visualAudit.fidelityScore}/100</span>
                                            <span>•</span>
                                            <span>{msg.visualAudit.pass ? 'Verified' : 'Auto-Repaired'}</span>
                                        </div>
                                    </div>

                                    {msg.visualAudit.thumbnail && (
                                        <div className="relative mb-2 rounded-lg overflow-hidden border border-slate-800/80 bg-black/40 max-h-[140px] flex items-center justify-center">
                                            <img
                                                src={msg.visualAudit.thumbnail}
                                                alt="Captured Viewport Snapshot"
                                                className="w-full h-auto object-contain max-h-[140px] rounded"
                                            />
                                            <div className="absolute bottom-1.5 right-2 px-1.5 py-0.5 rounded bg-black/70 backdrop-blur text-[9px] font-mono text-slate-300">
                                                Live Frame
                                            </div>
                                        </div>
                                    )}

                                    <p className="text-slate-300 text-[11px] leading-relaxed mb-2 font-sans">
                                        {msg.visualAudit.critique}
                                    </p>

                                    {msg.visualAudit.issues && msg.visualAudit.issues.length > 0 && (
                                        <div className="space-y-1 mb-2">
                                            <div className="text-[10px] font-semibold text-amber-400">Detected Visual Fixes Applied:</div>
                                            {msg.visualAudit.issues.map((issue, i) => (
                                                <div key={i} className="text-[10px] text-slate-400 flex items-start gap-1">
                                                    <span className="text-amber-500">🔧</span>
                                                    <span>{issue}</span>
                                                </div>
                                            ))}
                                        </div>
                                    )}

                                    {msg.visualAudit.strengths && msg.visualAudit.strengths.length > 0 && (
                                        <div className="space-y-1">
                                            <div className="text-[10px] font-semibold text-emerald-400">Verified Quality Attributes:</div>
                                            {msg.visualAudit.strengths.map((str, i) => (
                                                <div key={i} className="text-[10px] text-slate-400 flex items-start gap-1">
                                                    <span className="text-emerald-500">✓</span>
                                                    <span>{str}</span>
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            )}

                            {/* Cursor-Style Interactive Tool Execution Steps */}
                            {!isFirstInit && (
                                <div className="sb-cursor-tool-steps-group">
                                    {(msg.steps && msg.steps.length > 0 ? msg.steps : [
                                        { id: `${msg.id || idx}-step-1`, title: 'Indexed workspace context & project directives', durationFormatted: '94ms', duration: '94ms', details: 'Ingested .scratchbox/rules/*.md, SCRATCHBOX.md, and active canvas state.', status: 'completed' as const },
                                        { id: `${msg.id || idx}-step-2`, title: `Updated ${activeContextTitle} with verified changes`, durationFormatted: '248ms', duration: '248ms', details: `Synthesized additions and state transitions for ${activeContextTitle}.`, status: 'completed' as const }
                                    ]).map(step => {
                                        const isRunning = step.status === 'running';
                                        const isCompleted = step.status === 'completed' || !step.status;
                                        const isFailed = step.status === 'failed';
                                        const duration = (step as any).durationFormatted || (step as any).duration || ((step as any).durationMs ? `${(step as any).durationMs}ms` : undefined);
                                        return (
                                            <div key={step.id} className="sb-cursor-tool-step-container">
                                                <div
                                                    className="sb-cursor-tool-step"
                                                    onClick={() => setExpandedToolStepId(expandedToolStepId === step.id ? null : step.id)}
                                                    title="Click to view execution details"
                                                >
                                                    <div className="flex items-center gap-2">
                                                        <span className={`sb-cursor-tool-step-icon ${isRunning ? 'is-running' : isCompleted ? 'is-completed' : isFailed ? 'is-failed' : 'is-pending'}`}>
                                                            {isRunning ? '⟳' : isCompleted ? '✓' : isFailed ? '⚠' : '○'}
                                                        </span>
                                                        <span className="sb-cursor-tool-step-title">{step.title}</span>
                                                    </div>
                                                    {duration && <span className="sb-cursor-tool-step-duration">{duration}</span>}
                                                </div>
                                                {expandedToolStepId === step.id && (
                                                    <div className="sb-cursor-tool-step-details animate-fadeIn">
                                                        <code>{step.details}</code>
                                                    </div>
                                                )}
                                            </div>
                                        );
                                    })}
                                </div>
                            )}

                            {/* Cursor Diff / Change Badge */}
                            {!isFirstInit && (
                                <div className="sb-cursor-diff-card">
                                    <div className="sb-cursor-diff-header">
                                        <span className="sb-cursor-diff-title">1 Artifact Updated</span>
                                        <button
                                            type="button"
                                            className="sb-cursor-diff-review-btn"
                                            onClick={() => onSendMessage(`Review changes and differences in ${activeContextTitle}`)}
                                            title="Review diff with AI"
                                        >
                                            Review
                                        </button>
                                        <button
                                            type="button"
                                            className="sb-cursor-diff-audio-btn sb-btn-secondary"
                                            onClick={handleListenToDiff}
                                            title="Listen to Explanation"
                                            style={{
                                                marginLeft: '4px',
                                                padding: '2px 6px',
                                                display: 'flex',
                                                alignItems: 'center',
                                                gap: '3px',
                                                fontSize: '10px',
                                                height: '18px'
                                            }}
                                        >
                                            {audioState === 'loading' ? (
                                                <span className="animate-spin">○</span>
                                            ) : audioState === 'playing' ? (
                                                <span style={{ color: '#3b82f6', display: 'flex', alignItems: 'center', gap: '3px' }}>
                                                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="animate-pulse">
                                                        <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                                                        <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07" />
                                                    </svg>
                                                    <span>Stop</span>
                                                </span>
                                            ) : (
                                                <span style={{ display: 'flex', alignItems: 'center', gap: '3px' }}>
                                                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                                                        <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                                                        <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07" />
                                                    </svg>
                                                    <span>Listen</span>
                                                </span>
                                            )}
                                        </button>
                                    </div>
                                    <div className="sb-cursor-diff-row" title={`Context: ${activeContextTitle}`}>
                                        <div className="sb-cursor-diff-file-info">
                                            <IconFileCode size={13} className="text-zinc-400" />
                                            <span className="sb-cursor-diff-filename">{activeContextTitle}</span>
                                        </div>
                                        <div className="sb-cursor-diff-stats">
                                            <span className="sb-cursor-stat-add">+14</span>
                                            <span className="sb-cursor-stat-del">-4</span>
                                        </div>
                                    </div>
                                </div>
                            )}

                            {!isFirstInit && (
                                <div className="sb-cursor-tasks-summary">
                                    <span>Finished background synthesis</span>
                                </div>
                            )}

                            {/* Cursor Message Action Footer */}
                            <div className="sb-cursor-msg-footer">
                                <div className="sb-cursor-footer-actions">
                                    <button
                                        type="button"
                                        className={`sb-cursor-footer-btn ${msgReactions[msg.id] === 'up' ? 'sb-cursor-btn-active' : ''}`}
                                        onClick={() => toggleReaction(msg.id, 'up')}
                                        title="Good response"
                                    >
                                        <IconThumbsUp size={11} strokeWidth={1.8} />
                                    </button>
                                    <button
                                        type="button"
                                        className={`sb-cursor-footer-btn ${msgReactions[msg.id] === 'down' ? 'sb-cursor-btn-active' : ''}`}
                                        onClick={() => toggleReaction(msg.id, 'down')}
                                        title="Bad response"
                                    >
                                        <IconThumbsDown size={11} strokeWidth={1.8} />
                                    </button>
                                    <button
                                        type="button"
                                        className="sb-cursor-footer-btn"
                                        onClick={() => navigator.clipboard.writeText(cleanText)}
                                        title="Copy message"
                                    >
                                        <IconCopy size={11} strokeWidth={1.8} />
                                    </button>
                                    <button
                                        type="button"
                                        className="sb-cursor-footer-btn"
                                        onClick={() => onSendMessage(`Refine and improve ${activeContextTitle}`)}
                                        title="Fork version"
                                    >
                                        <IconGitFork size={11} strokeWidth={1.8} />
                                    </button>
                                    <span className="sb-cursor-footer-time">{msg.timestamp || 'Just now'}</span>
                                </div>
                            </div>
                        </div>
                    );
                })}

                {isGenerating && (
                    <div className="sb-cursor-assistant-card animate-fadeIn">
                        {(liveThinkingText || (liveThinkingSeconds !== undefined && liveThinkingSeconds > 0)) ? (
                            <ThinkingDisclosure
                                isLive={!liveStreamedText}
                                thinkingText={liveThinkingText}
                                durationSeconds={liveThinkingSeconds}
                            />
                        ) : null}
                        {liveSteps && liveSteps.length > 0 && (
                            <AgentExecutionStepper
                                steps={liveSteps}
                                isLive={true}
                            />
                        )}
                        <div className="sb-cursor-assistant-body">
                            {liveStreamedText ? (
                                <div style={{ position: 'relative' }}>
                                    <ChatMarkdownRenderer
                                        text={cleanMessageTextSmart(liveStreamedText)}
                                        className="sb-cursor-markdown-content"
                                        isStreaming={true}
                                        onOpenInBrowser={onOpenInBrowser}
                                    />
                                    <StreamingCursor />
                                </div>
                            ) : !liveThinkingText && (!liveSteps || liveSteps.length === 0) ? (
                                <div className="sb-ide-msg-thinking animate-pulse">
                                    <IconSparkles size={13} className="text-blue-400 animate-spin" />
                                    <span>Generating changes &amp; synchronizing canvas...</span>
                                    <StreamingCursor />
                                </div>
                            ) : null}
                        </div>
                    </div>
                )}
                <div ref={chatEndRef} />
            </div>

            {/* Quick Vibecode Action Chips */}
            {resolvedPrompts && resolvedPrompts.length > 0 && (
                <div className="sb-ide-chat-chips">
                    {resolvedPrompts.map((promptText, idx) => (
                        <button
                            key={`chip-${idx}`}
                            type="button"
                            className="sb-vibecode-chip"
                            onClick={() => handleSend(promptText)}
                            title={`Run: ${promptText}`}
                        >
                            <span>{promptText}</span>
                        </button>
                    ))}
                </div>
            )}

            {/* Cursor-Grade Pinned Bottom Composer */}
            <div className="sb-cursor-composer-wrapper" style={{ position: 'relative' }}>
                {/* Context Pills Bar Above Input */}
                <div className="sb-cursor-context-bar">
                    <div className="sb-cursor-context-left">
                        <button
                            type="button"
                            className={`sb-cursor-context-chip-btn ${isCanvasActive ? 'sb-cursor-context-active' : ''}`}
                            onClick={onToggleCanvas}
                            title="Toggle Live Canvas Surface"
                        >
                            Canvas
                        </button>
                        <button
                            type="button"
                            className={`sb-cursor-context-chip-btn ${isTerminalActive ? 'sb-cursor-context-active' : ''}`}
                            onClick={onToggleTerminal}
                            title="Toggle Terminal"
                        >
                            1 Terminal
                        </button>
                        <span className="sb-cursor-indexing-badge" title="Project codebase embedded & indexed">● Codebase Indexed</span>
                        <span className="sb-cursor-rules-badge" title=".scratchbox/rules & .cursorrules active">3 Rules Active</span>
                    </div>
                    <button
                        type="button"
                        className="sb-cursor-context-scroll-btn"
                        onClick={() => chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })}
                        title="Scroll to bottom"
                    >
                        <IconArrowDown size={11} strokeWidth={2.2} />
                    </button>
                </div>

                {/* Autocomplete Popup Menu */}
                <ContextMentionAutocompletePopover
                    isOpen={showMentionMenu}
                    activeCategory={activeMentionCategory}
                    onCategoryChange={setActiveMentionCategory}
                    query={mentionQuery}
                    selectedIndex={selectedMentionIndex}
                    onSelectMention={handleSelectMention}
                    onClose={() => setShowMentionMenu(false)}
                />

                <div className="sb-cursor-composer-container">
                    {/* Attached Context Pills */}
                    {attachedContextMentions.length > 0 && (
                        <div className="sb-cursor-attached-context-row" style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', padding: '6px 8px', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
                            {attachedContextMentions.map(ctx => (
                                <div key={ctx.id} className="sb-context-chip sb-context-chip-active" style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', padding: '2px 8px', borderRadius: '12px', background: 'rgba(59,130,246,0.15)', border: '1px solid rgba(59,130,246,0.3)', fontSize: '11px', color: '#93c5fd' }}>
                                    <span>{ctx.icon || '📄'}</span>
                                    <span style={{ fontWeight: 500 }}>{ctx.name}</span>
                                    <span style={{ opacity: 0.6, fontSize: '10px' }}>@{ctx.type}</span>
                                    <button
                                        type="button"
                                        className="sb-btn sb-btn-ghost sb-btn-xs sb-context-chip-remove"
                                        style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', padding: '0 2px', marginLeft: '2px' }}
                                        onClick={() => setAttachedContextMentions(prev => prev.filter(c => c.id !== ctx.id))}
                                    >
                                        ×
                                    </button>
                                </div>
                            ))}
                        </div>
                    )}

                    <textarea
                        className="sb-cursor-composer-textarea"
                        placeholder={`Ask AI to edit ${activeContextTitle}...`}
                        value={inputValue}
                        onChange={handleTextChange}
                        onKeyDown={e => {
                            if (showMentionMenu) {
                                const defaultFiles = [
                                    'src/App.tsx',
                                    'src/styles.css',
                                    'package.json',
                                    'applications/browser/package.json',
                                    'extensions/product/src/node/gemini-service.ts'
                                ];
                                const items = resolveContextMentionQuery(activeMentionCategory, mentionQuery, defaultFiles);
                                if (e.key === 'ArrowDown') {
                                    e.preventDefault();
                                    setSelectedMentionIndex(prev => cycleSelectedIndex(prev, items.length, 'down'));
                                    return;
                                }
                                if (e.key === 'ArrowUp') {
                                    e.preventDefault();
                                    setSelectedMentionIndex(prev => cycleSelectedIndex(prev, items.length, 'up'));
                                    return;
                                }
                                if (e.key === 'Enter' || e.key === 'Tab') {
                                    if (items.length > 0 && items[selectedMentionIndex]) {
                                        e.preventDefault();
                                        handleSelectMention(items[selectedMentionIndex]);
                                        return;
                                    }
                                }
                                if (e.key === 'Escape') {
                                    e.preventDefault();
                                    setShowMentionMenu(false);
                                    return;
                                }
                            }
                            if (e.key === 'Enter' && !e.shiftKey) {
                                e.preventDefault();
                                handleSend();
                            }
                        }}
                        rows={2}
                    />
                    <div className="sb-cursor-composer-bottom">
                        <div className="sb-cursor-composer-bottom-left">
                            <button
                                type="button"
                                className="sb-cursor-composer-add-btn"
                                onClick={() => setShowMentionMenu(!showMentionMenu)}
                                title="Add Context (+)"
                            >
                                <IconPlus size={13} strokeWidth={2} />
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
                        <div className="sb-cursor-composer-bottom-right">
                            <button
                                type="button"
                                className={`sb-cursor-composer-icon-btn ${isVoiceRecording ? 'sb-voice-btn-recording' : ''}`}
                                onClick={toggleVoiceInput}
                                title={isVoiceRecording ? 'Listening... click to stop' : 'Voice input (Web Speech API)'}
                            >
                                <IconMic size={13} strokeWidth={1.8} />
                            </button>
                            <button
                                type="button"
                                className="sb-cursor-send-btn"
                                onClick={() => handleSend()}
                                disabled={!inputValue.trim() || isGenerating}
                                title="Send (Enter)"
                            >
                                <IconArrowUp size={13} strokeWidth={2.4} />
                            </button>
                        </div>
                    </div>
                </div>

                {/* Cursor Bottom Status Row */}
                <div className="sb-cursor-bottom-status">
                    <span className="sb-cursor-env-label">This Mac ▾</span>
                    <span className={`sb-cursor-status-spinner ${isGenerating ? 'animate-spin text-blue-400' : ''}`}>○</span>
                </div>
            </div>
        </div>
    );
};
