/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as React from 'react';
import { ChatMessage } from '../canvas-types';
import { CanvasErrorBoundary } from '../CanvasErrorBoundary';
import {
    AgentExecutionStepper,
    ChatMarkdownRenderer,
    ThinkingDisclosure,
    cleanMessageTextSmart,
    extractArtifactFromJson
} from '../ChatMarkdownRenderer';
import { resolveModeForArtifact } from '../guardrails-service';
import { useStudioActions } from '../state/StudioContext';
import { getPrimitiveIcon, getPrimitiveLabel } from '../studio/canvas-labels';
import { AudioNarratedCard, CinematicVideoCard, GoogleMapsCard, ImageGeneratedCard, TextureMatrixCard } from './MediaCards';
import { QuestionCard } from './QuestionCard';
import { ExecutionPlanCard } from './ExecutionPlanCard';

export interface MessageItemProps {
    message: ChatMessage;
    /** Id/version of the artifact currently shown on the canvas, used to highlight the active chip. */
    activeArtifactId: string | undefined;
    activeArtifactVersion: number | undefined;
    /** Draft feedback text for this message's Deep-Write checkpoint (if any). */
    checkpointFeedbackValue: string;
}

const MessageItemInner: React.FC<MessageItemProps> = ({ message, activeArtifactId, activeArtifactVersion, checkpointFeedbackValue }) => {
    const msg = message;
    const {
        executeDeepWritePipeline,
        handleDeepWriteResume,
        setCheckpointFeedback,
        handleOpenInAppBrowser,
        handlePreviewCodeInCanvas,
        onExecuteCommand,
        showToast,
        handleSelectVersion,
        sendMessage
    } = useStudioActions();

    const isUser = msg.sender === 'user';
    const cleanText = isUser ? msg.text : cleanMessageTextSmart(msg.text, msg.artifacts?.[0]);

    if (msg.deepWriteOffer && msg.deepWritePlan) {
        const plan = msg.deepWritePlan;
        return (
            <div key={msg.id} className="sb-drawer-msg-row sb-msg-assistant-row animate-fadeIn">
                <div className="sb-chat-bubble-content" style={{ borderLeft: '3px solid #3b82f6', paddingLeft: '12px' }}>
                    <div className="sb-bubble-header">
                        <span className="sb-bubble-sender">Scratchbox AI Co-Planner</span>
                        <span className="sb-bubble-time">{msg.timestamp}</span>
                    </div>
                    <div className="text-xs text-slate-300 space-y-2 mt-2">
                        <p><strong>Proposed Plan Goal:</strong> {plan.goal}</p>
                        <p><strong>Target Platforms:</strong> {plan.domains.map((d: string) => `[${d}]`).join(', ')}</p>
                        <p><strong>Expressive Canvas Primitives:</strong> {plan.deliverables.primitives.map((p: string) => `[${p}]`).join(', ')}</p>
                        <div className="bg-slate-900/60 p-2 rounded border border-slate-800 font-mono text-[10px] leading-relaxed text-slate-400 max-h-[120px] overflow-y-auto">
                            <strong>Strategic Rationale:</strong><br />
                            {plan.analysisReasoning}
                        </div>
                        <button
                            type="button"
                            className="sb-btn sb-btn-primary w-full py-1.5 mt-2 text-xs font-semibold rounded"
                            onClick={() => executeDeepWritePipeline(plan.goal, plan)}
                        >
                            Confirm & Run Planning Pipeline
                        </button>
                    </div>
                </div>
            </div>
        );
    }

    if (msg.deepWriteProgress) {
        const p = msg.deepWriteProgress;
        const plan = msg.deepWritePlan || p.plan;
        const stages = plan?.stages || [
            { id: 'requirements', name: 'Analyze Project Goal & Constraints', stage: '01', description: 'Inspect user memories and active canvas context.' },
            { id: 'scaffold', name: 'Formulate Platform Deliverables & Primitives', stage: '02', description: 'Decompose goal into optimal file structures.' },
            { id: 'research', name: 'Research Academic Papers & Grounding Citations', stage: '03', description: 'Execute multi-turn deep web research.' },
            { id: 'architecture', name: 'Architect System Interfaces & Module Dependencies', stage: '04', description: 'Define schemas, API protocols, and boundaries.' },
            { id: 'scaffolding', name: 'Scaffold Multi-Platform Source Directory Trees', stage: '05', description: 'Generate CMake, Cargo, or Node packages.' },
            { id: 'graphics', name: 'Generate Procedural Geometry & Shader Algorithms', stage: '06', description: 'Write WebGL/WebGPU render and physics models.' },
            { id: 'compilation', name: 'Compile Native C++ & WebAssembly Modules', stage: '07', description: 'Integrate native computational solvers.' },
            { id: 'telemetry', name: 'Execute Performance Telemetry & Security Audit', stage: '08', description: 'Examine container sandboxing resource profiles.' },
            { id: 'self_healing', name: 'Verify Compilations & Self-Healing Auto-Repair', icon: '🛡️', stage: '09', description: 'Compile, analyze error logs, and auto-patch.' },
            { id: 'artifact', name: 'Spawn Coordinated Artifacts to Workspace Canvas', stage: '10', description: 'Deliver live Spec, Sandbox, and 3D scenes.' }
        ];

        const total = p.totalStages || stages.length;
        let currentIdx = stages.findIndex((s: any) => s.id === p.currentStageId);
        if (currentIdx === -1) {
            // If it's a fallback list, approximate active index based on message text
            const msgLower = (p.message || '').toLowerCase();
            if (msgLower.includes('complete') || p.type === 'pipeline_complete') currentIdx = stages.length;
            else if (msgLower.includes('error')) currentIdx = -1;
            else if (msgLower.includes('compile') || msgLower.includes('repair')) currentIdx = 8;
            else if (msgLower.includes('shader') || msgLower.includes('render')) currentIdx = 5;
            else if (msgLower.includes('folder') || msgLower.includes('scaffold')) currentIdx = 4;
            else if (msgLower.includes('architect') || msgLower.includes('design')) currentIdx = 3;
            else if (msgLower.includes('research')) currentIdx = 2;
            else currentIdx = 1;
        }
        
        const progress = p.type === 'pipeline_complete' ? 100 : Math.max(p.progressPercent || Math.round(((currentIdx + 1) / total) * 100), 5);
        const isDone = p.type === 'pipeline_complete';
        const isError = p.type === 'error';

        return (
            <div key={msg.id} className="sb-drawer-msg-row sb-msg-assistant-row animate-fadeIn">
                <div className="sb-chat-bubble-content" style={{ borderLeft: `3px solid ${isError ? '#ef4444' : isDone ? '#10b981' : '#3b82f6'}`, paddingLeft: '12px', width: '100%' }}>
                    <div className="sb-bubble-header">
                        <span className="sb-bubble-sender">Scratchbox AI Pipeline</span>
                        <span className="sb-bubble-time">{msg.timestamp}</span>
                    </div>
                    <div className="text-xs text-slate-300 space-y-3 mt-2">
                        <div className="flex items-center justify-between">
                            <strong className="text-sm">{isError ? 'Deep-Write Error' : isDone ? 'Deep-Write Completed!' : 'Planning & Scaffolding...'}</strong>
                            <span className="font-mono font-bold text-blue-400">{progress}%</span>
                        </div>
                        <div className="w-full bg-slate-800 rounded-full h-1.5 overflow-hidden">
                            <div className={`h-full rounded-full transition-all duration-500 ${isError ? 'bg-red-500' : isDone ? 'bg-emerald-500' : 'bg-blue-500'}`} style={{ width: `${progress}%` }} />
                        </div>

                        {p.message && <p className="italic text-slate-400 text-xs bg-slate-900/40 p-1.5 rounded">{p.message}</p>}

                        {/* Dynamic Step-by-Step Interactive Timeline */}
                        <div className="space-y-2 mt-4 border-t border-slate-900 pt-3">
                            <span className="text-[10px] uppercase tracking-wider font-semibold text-slate-500 block mb-2">Live Synthesis Steps</span>
                            <div className="relative pl-4 space-y-3 border-l border-slate-800/60 ml-2">
                                {stages.map((stage: any, sIdx: number) => {
                                    const isStageDone = isDone || sIdx < currentIdx;
                                    const isStageActive = !isDone && sIdx === currentIdx;
                                    const isStagePending = sIdx > currentIdx;

                                    return (
                                        <div key={stage.id} className="relative group">
                                            {/* Bullet Indicator */}
                                            <div className="absolute -left-[21px] top-0.5 flex items-center justify-center">
                                                {isStageDone ? (
                                                    <div className="w-3.5 h-3.5 rounded-full bg-emerald-500/20 border border-emerald-500 flex items-center justify-center text-[8px] text-emerald-400 font-bold">✓</div>
                                                ) : isStageActive ? (
                                                    <div className="w-3.5 h-3.5 rounded-full bg-blue-500/20 border border-blue-500 flex items-center justify-center relative">
                                                        <span className="absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75 animate-ping" />
                                                        <div className="w-1.5 h-1.5 rounded-full bg-blue-400" />
                                                    </div>
                                                ) : (
                                                    <div className="w-3.5 h-3.5 rounded-full bg-slate-900 border border-slate-700/80" />
                                                )}
                                            </div>

                                            <div className={`transition-all duration-300 ${isStageActive ? 'text-white' : isStagePending ? 'text-slate-500' : 'text-slate-400'}`}>
                                                <span className="text-xs font-semibold block">{stage.name}</span>
                                                {isStageActive && (
                                                    <div className="mt-1.5 space-y-1.5 text-[11px] text-slate-300 animate-fadeIn">
                                                        <p className="text-slate-400">{stage.description}</p>
                                                        {p.thinking && (
                                                            <div className="bg-slate-950 border border-slate-900 p-2 rounded font-mono text-[10px] text-blue-400 max-h-[100px] overflow-y-auto leading-relaxed whitespace-pre-wrap">
                                                                💡 {p.thinking}
                                                            </div>
                                                        )}
                                                        {p.query && (
                                                            <div className="text-[10px] text-indigo-400 font-mono flex items-center gap-1.5">
                                                                <span>🔎 Grounding:</span>
                                                                <span className="bg-indigo-950/60 border border-indigo-900/50 px-1.5 py-0.5 rounded text-indigo-300">{p.query}</span>
                                                            </div>
                                                        )}
                                                    </div>
                                                )}
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        );
    }

    if (msg.deepWriteCheckpoint && msg.deepWriteCheckpoint.status === 'awaiting_feedback') {
        const checkpoint = msg.deepWriteCheckpoint;
        const feedbackValue = checkpointFeedbackValue;

        return (
            <div key={msg.id} className="sb-drawer-msg-row sb-msg-assistant-row animate-fadeIn">
                <div className="sb-chat-bubble-content" style={{ borderLeft: '3px solid #f59e0b', paddingLeft: '12px' }}>
                    <div className="sb-bubble-header">
                        <span className="sb-bubble-sender">Scratchbox Checkpoint Gate</span>
                        <span className="sb-bubble-time">{msg.timestamp}</span>
                    </div>
                    <div className="text-xs text-slate-300 space-y-2 mt-2">
                        <p>Pipeline paused at checkpoint: <strong>{checkpoint.stageName}</strong> for style review.</p>
                        <div className="bg-slate-900/50 p-2 rounded border border-slate-800/80 font-mono text-[10px] text-slate-400 space-y-1">
                            <strong>Active Decision Points:</strong>
                            {checkpoint.decisionPoints.map((d: string) => (
                                <div key={d}>• {d}</div>
                            ))}
                        </div>
                        <textarea
                            className="w-full bg-slate-950 border border-slate-800 rounded p-2 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-amber-500"
                            placeholder="Steer the pipeline with style/framework overrides..."
                            rows={2}
                            value={feedbackValue}
                            onChange={(e) => setCheckpointFeedback(prev => ({ ...prev, [msg.id]: e.target.value }))}
                        />
                        <button
                            type="button"
                            className="sb-btn sb-btn-primary w-full py-1.5 text-xs font-semibold rounded"
                            onClick={() => {
                                handleDeepWriteResume(checkpoint.sessionId, feedbackValue);
                                setCheckpointFeedback(prev => ({ ...prev, [msg.id]: '' }));
                                msg.deepWriteCheckpoint!.status = 'resumed';
                            }}
                        >
                            Steer & Resume Planning Pipeline
                        </button>
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div
            key={msg.id}
            className={`sb-drawer-msg-row ${
                isUser ? 'sb-msg-user-row' : 'sb-msg-assistant-row'
            }`}
        >
            <div className="sb-chat-bubble-content">
                <div className="sb-bubble-header">
                    <span className="sb-bubble-sender">
                        {isUser ? 'You' : 'Scratchbox AI'}
                    </span>
                    <span className="sb-bubble-time">{msg.timestamp}</span>
                </div>

                {msg.attachedSkills && msg.attachedSkills.length > 0 && (
                    <div className="sb-bubble-skills-row">
                        {msg.attachedSkills.map(sk => (
                            <span key={sk} className="sb-bubble-skill-tag">
                                {sk}
                            </span>
                        ))}
                        {msg.attachedMcpTools && msg.attachedMcpTools.map(m => (
                            <span key={m} className="sb-bubble-mcp-tag">
                                {m}
                            </span>
                        ))}
                    </div>
                )}

                {/* Cupertino / ChatGPT Style Thinking Disclosure */}
                {!isUser && msg.thinkingText && (
                    <ThinkingDisclosure
                        thinkingText={msg.thinkingText}
                        durationSeconds={msg.thinkingDurationSeconds}
                    />
                )}

                {/* Interactive Agent Execution Stepper */}
                {!isUser && msg.steps && msg.steps.length > 0 && (
                    <AgentExecutionStepper
                        steps={msg.steps}
                    />
                )}

                {cleanText && (
                    <ChatMarkdownRenderer
                        text={cleanText}
                        className="sb-bubble-text"
                        onOpenInBrowser={handleOpenInAppBrowser}
                        onPreviewInCanvas={handlePreviewCodeInCanvas}
                        onExecuteCommand={cmd => {
                            if (onExecuteCommand) {
                                onExecuteCommand(cmd);
                                showToast('Command sent to Scratchbox terminal');
                            }
                        }}
                    />
                )}

                {/* Structured Interactive Question Clarification Card (Cursor-grade) */}
                {msg.questionCard && (
                    <QuestionCard
                        card={msg.questionCard}
                        messageId={msg.id}
                        onSubmit={(answerText, selections) => {
                            if (msg.questionCard) {
                                msg.questionCard.submitted = true;
                                msg.questionCard.selectedOptions = selections;
                            }
                            if (sendMessage) {
                                sendMessage(answerText);
                            }
                        }}
                    />
                )}

                {/* Structured Execution Confirmation Plan Card (Cursor-grade) */}
                {msg.executionPlanCard && (
                    <ExecutionPlanCard
                        card={msg.executionPlanCard}
                        messageId={msg.id}
                        onConfirm={() => {
                            if (msg.executionPlanCard) {
                                msg.executionPlanCard.confirmed = true;
                            }
                            if (sendMessage) {
                                sendMessage('Confirmed. Proceed with the proposed execution plan.');
                            }
                        }}
                        onAdjust={() => {
                            if (sendMessage) {
                                sendMessage('I would like to adjust the plan: ');
                            }
                        }}
                    />
                )}

                {/* High-Design ChatGPT Canvas Style Artifact Card with Version & Quick Actions */}
                {(() => {
                    const effectiveArtifacts = (msg.artifacts && msg.artifacts.length > 0)
                        ? msg.artifacts
                        : (!isUser && extractArtifactFromJson(msg.text) ? [extractArtifactFromJson(msg.text)!] : []);

                    if (!effectiveArtifacts || effectiveArtifacts.length === 0) return null;

                    return (
                        <div className="sb-bubble-artifacts-list">
                            {effectiveArtifacts.map(art => {
                                const isCurrent = activeArtifactId === art.id && (activeArtifactVersion || 1) === (art.version || 1);
                                const targetMode = resolveModeForArtifact(art.type);
                                const actionLabel = targetMode === '3d' ? 'Open 3D' : `Open ${targetMode.charAt(0).toUpperCase() + targetMode.slice(1)}`;

                                return (
                                    <div
                                        key={`${art.id}-v${art.version || 1}`}
                                        className={`sb-chat-artifact-chip sb-chip-${art.type} ${isCurrent ? 'sb-chip-active' : ''}`}
                                        onClick={() => {
                                            handleSelectVersion(art);
                                        }}
                                        title={`Click to view v${art.version || 1} on ${targetMode.toUpperCase()} surface`}
                                    >
                                        <div className="sb-chip-icon-box">
                                            {getPrimitiveIcon(art.type)}
                                        </div>
                                        <div className="sb-chip-info">
                                            <span className="sb-chip-title">{art.title}</span>
                                            <span className="sb-chip-subtitle">
                                                {getPrimitiveLabel(art.type)} · {actionLabel}
                                            </span>
                                        </div>
                                        <div className="sb-chip-actions" onClick={e => e.stopPropagation()}>
                                            <button
                                                type="button"
                                                className="sb-btn sb-btn-xs sb-chip-action-btn"
                                                onClick={() => {
                                                    handleSelectVersion(art);
                                                }}
                                                title={`Open ${art.title} in Canvas`}
                                            >
                                                {actionLabel}
                                            </button>
                                        </div>
                                        <div className="sb-chip-badge-wrap">
                                            {isCurrent ? (
                                                <span className="sb-chip-badge sb-badge-active" title="Currently active version">
                                                    Active (v{art.version || 1})
                                                </span>
                                            ) : (
                                                <span className="sb-chip-badge" title={`Historical version snapshot v${art.version || 1} — click to view`}>
                                                    v{art.version || 1}
                                                </span>
                                            )}
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    );
                })()}

                {/* Inline MCP & CLI Tool Execution Cards with Structured Outputs */}
                {msg.mcpExecutions && msg.mcpExecutions.map(exec => (
                    <div key={exec.id} className="sb-chat-inline-mcp-card">
                        <div className="sb-inline-mcp-top">
                            <div className="sb-inline-mcp-title-wrap">
                                <span className="sb-mcp-pulse-dot" />
                                <span className="sb-inline-mcp-title">{exec.humanTitle}</span>
                            </div>
                            <span className={`sb-inline-mcp-status sb-status-${exec.status}`}>
                                {exec.status === 'completed' ? '✓ Done' : exec.status === 'running' ? 'Running…' : 'Failed'}
                            </span>
                        </div>

                        {/* Execution step telemetry */}
                        <div className="sb-inline-mcp-steps">
                            {exec.steps.map(st => (
                                <div key={st.id} className={`sb-inline-mcp-step-item sb-step-${st.status}`}>
                                    <div className="sb-step-icon-state">
                                        {st.status === 'done' ? (
                                            <span className="sb-step-check">✓</span>
                                        ) : st.status === 'running' ? (
                                            <span className="sb-step-spinner" />
                                        ) : (
                                            <span className="sb-step-bullet">•</span>
                                        )}
                                    </div>
                                    <span className="sb-step-title">{st.title}</span>
                                    {st.durationMs && <span className="sb-inline-step-dur">{st.durationMs}ms</span>}
                                </div>
                            ))}
                        </div>

                        {/* Human-friendly Card Render (Table, Metric Items, Status Badges) */}
                        {exec.humanFriendlyOutput && (
                            <div className="sb-inline-mcp-output-card">
                                <div className="sb-mcp-card-head">
                                    <span className="sb-mcp-card-title">{exec.humanFriendlyOutput.title}</span>
                                    {exec.humanFriendlyOutput.note && (
                                        <span className="sb-mcp-card-note">{exec.humanFriendlyOutput.note}</span>
                                    )}
                                </div>

                                {exec.humanFriendlyOutput.cardType === 'metric' && exec.humanFriendlyOutput.items && (
                                    <div className="sb-mcp-metric-grid">
                                        {exec.humanFriendlyOutput.items.map((item, itmIdx) => (
                                            <div key={`${item.label}-${itmIdx}`} className={`sb-mcp-metric-pill sb-accent-${item.color || 'blue'}`}>
                                                <span className="sb-mcp-metric-label">{item.label}</span>
                                                <span className="sb-mcp-metric-value">{item.value}</span>
                                            </div>
                                        ))}
                                    </div>
                                )}

                                {exec.humanFriendlyOutput.cardType === 'table' && exec.humanFriendlyOutput.headers && exec.humanFriendlyOutput.rows && (
                                    <div className="sb-mcp-table-wrapper">
                                        <table className="sb-mcp-mini-table">
                                            <thead>
                                                <tr>
                                                    {exec.humanFriendlyOutput.headers.map((h, hIdx) => (
                                                        <th key={`${h}-${hIdx}`}>{h}</th>
                                                    ))}
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {exec.humanFriendlyOutput.rows.map((row, rIdx) => (
                                                    <tr key={`${row.join('|')}-${rIdx}`}>
                                                        {row.map((cell, cIdx) => (
                                                            <td key={`${cell}-${cIdx}`}>{cell}</td>
                                                        ))}
                                                    </tr>
                                                ))}
                                            </tbody>
                                        </table>
                                    </div>
                                )}

                                {exec.humanFriendlyOutput.cardType === 'badge-list' && exec.humanFriendlyOutput.items && (
                                    <div className="sb-mcp-badge-list">
                                        {exec.humanFriendlyOutput.items.map((bItem, bIdx) => (
                                            <div key={`${bItem.label}-${bIdx}`} className={`sb-mcp-badge-tag sb-accent-${bItem.color || 'indigo'}`}>
                                                <span className="sb-badge-tag-lbl">{bItem.label}:</span>
                                                <span className="sb-badge-tag-val">{bItem.value}</span>
                                            </div>
                                        ))}
                                    </div>
                                )}

                                {exec.humanFriendlyOutput.cardType === 'status-card' && exec.humanFriendlyOutput.items && (
                                    <div className="sb-mcp-status-grid">
                                        {exec.humanFriendlyOutput.items.map((sItem, sIdx) => (
                                            <div key={`${sItem.label}-${sIdx}`} className="sb-mcp-status-row">
                                                <span className="sb-status-k">{sItem.label}</span>
                                                <span className={`sb-status-v sb-accent-${sItem.color || 'emerald'}`}>{sItem.value}</span>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>
                        )}

                        {exec.summaryResult && !exec.humanFriendlyOutput && (
                            <div className="sb-inline-mcp-summary">
                                {exec.summaryResult}
                            </div>
                        )}
                    </div>
                ))}

                {/* Inline Google Search Grounding & Citations Card */}
                {msg.groundingMetadata && ((msg.groundingMetadata.webSearchQueries && msg.groundingMetadata.webSearchQueries.length > 0) || (msg.groundingMetadata.groundingChunks && msg.groundingMetadata.groundingChunks.length > 0)) && (
                    <div className="sb-chat-inline-grounding-card">
                        <div className="sb-inline-grounding-header">
                            <div className="sb-inline-grounding-title-wrap">
                                <span className="sb-grounding-pulse-dot" />
                                <span className="sb-inline-grounding-title">Google Search Grounding &amp; Citations</span>
                            </div>
                            <span className="sb-inline-grounding-badge">
                                ✓ Verified Live
                            </span>
                        </div>

                        {/* Search Queries Telemetry */}
                        {msg.groundingMetadata.webSearchQueries && msg.groundingMetadata.webSearchQueries.length > 0 && (
                            <div className="sb-grounding-queries-list">
                                <span className="sb-grounding-section-label">Web Queries:</span>
                                {msg.groundingMetadata.webSearchQueries.map((query, qIdx) => (
                                    <span
                                        key={`${query}-${qIdx}`}
                                        className="sb-grounding-query-pill"
                                        style={{ cursor: 'pointer' }}
                                        onClick={() => handleOpenInAppBrowser(`https://www.google.com/search?q=${encodeURIComponent(query)}`, `Google: ${query}`)}
                                        title={`Search "${query}" in In-App Web Browser`}
                                    >
                                        <span className="sb-query-icon">🔍</span>
                                        {query}
                                    </span>
                                ))}
                            </div>
                        )}

                        {/* Grounded Web Sources and Citation Links */}
                        {msg.groundingMetadata.groundingChunks && msg.groundingMetadata.groundingChunks.length > 0 && (
                            <div className="sb-grounding-sources-grid">
                                {msg.groundingMetadata.groundingChunks.filter(c => c.web && (c.web.uri || c.web.title)).map((chunk, cIdx) => (
                                    <a
                                        key={`${chunk.web?.uri || chunk.web?.title}-${cIdx}`}
                                        href={chunk.web?.uri || '#'}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="sb-grounding-source-chip"
                                        title={chunk.web?.uri || chunk.web?.title}
                                        onClick={e => {
                                            if (chunk.web?.uri) {
                                                e.preventDefault();
                                                e.stopPropagation();
                                                handleOpenInAppBrowser(chunk.web.uri, chunk.web.title || chunk.web.uri);
                                            }
                                        }}
                                    >
                                        <span className="sb-grounding-source-num">[{cIdx + 1}]</span>
                                        <span className="sb-grounding-source-title">{chunk.web?.title || chunk.web?.uri}</span>
                                        <span className="sb-grounding-external-icon">↗</span>
                                    </a>
                                ))}
                            </div>
                        )}
                    </div>
                )}

                {/* High-Fidelity Multimedia & Maps Grounding Cards */}
                {(msg.imageContent || (msg.imagesContent && msg.imagesContent.length > 0)) && (
                    <ImageGeneratedCard imageContent={msg.imageContent} imagesContent={msg.imagesContent} />
                )}
                {msg.textureMatrixContent && (
                    <TextureMatrixCard result={msg.textureMatrixContent} />
                )}
                {msg.audioContent && (
                    <AudioNarratedCard audioContent={msg.audioContent} />
                )}
                {msg.videoContent && (
                    <CinematicVideoCard videoContent={msg.videoContent} />
                )}
                {msg.mapContent && (
                    <GoogleMapsCard mapContent={msg.mapContent} />
                )}
            </div>
        </div>
    );
};

/**
 * A single chat bubble (user, assistant, Deep-Write plan/progress/checkpoint) with artifact chips,
 * MCP execution cards, grounding citations and media cards. Memoized: the list only re-renders the
 * bubbles whose message object, active-artifact highlight or checkpoint draft actually changed.
 */
export const MessageItem = React.memo(function MessageItem(props: MessageItemProps) {
    return (
        <CanvasErrorBoundary compact fallbackTitle="Message Render Notice">
            <MessageItemInner {...props} />
        </CanvasErrorBoundary>
    );
});
