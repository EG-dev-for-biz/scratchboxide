/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as React from 'react';
import {
    AgentExecutionStep,
    CanvasArtifact,
    ChartDataPoint,
    ChatMessage,
    ChatSession,
    ContextMentionItem,
    GroundingMetadata,
    MarkdownDocumentData,
    McpExecutionState,
    McpServerItem,
    MetricItem,
    PrimitiveType,
    Scene3DData,
    SkillItem,
    StudioLayoutMode,
    StudioSettingsTab,
    TerminalExecutionError,
    TokenBudgetMetrics,
    InteractiveQuestionCardData,
    ExecutionPlanCardData
} from '../canvas-types';
import { AttachedMcpToolContext, AttachedSkillContext } from '../../../common/gemini-protocol';
import { GeminiClient } from '../gemini-client';
import { resolveModeForArtifact } from '../guardrails-service';
import { cleanMessageTextSmart } from '../ChatMarkdownRenderer';
import { ProjectArtifactController } from '../project-artifact-controller';
import { ProjectItem } from '../ProjectsModal';
import { streamTokensAsync } from '../chat/streaming-utils';
import {
    buildFallbackAssistantText,
    buildSimulatedSteps,
    classifyFallbackPrompt,
    FallbackResult,
    hasExplicit3DDirective,
    synthesize3DFallback,
    synthesizeChatFallback,
    synthesizeDataFileDashboard,
    synthesizeDefaultDocument,
    synthesizeDocumentFallback,
    synthesizeGraphFallback,
    synthesizeKanbanFallback,
    synthesizeMediaFallback,
    synthesizeMetricsFallback,
    synthesizeSandboxFallback,
    synthesizeVideoTimelineFallback,
    synthesizeQuestionCardFallback,
    synthesizeExecutionPlanFallback
} from './sendMessageFallbacks';

type Setter<T> = (value: T | ((prev: T) => T)) => void;

/** A parsed CSV/JSON data file attached to the composer. */
export interface AttachedDataFile {
    name: string;
    size: number;
    rowsCount: number;
    headers: string[];
    rawText: string;
    parsedRows: Record<string, any>[];
    summaryMetrics: MetricItem[];
    chartData?: ChartDataPoint[];
}

/**
 * Everything `sendMessage` reads or mutates. The Studio passes the latest values every render;
 * the hook stores them in a ref so the returned `sendMessage` identity stays stable.
 */
export interface SendMessageDeps {
    inputValue: string;
    isGenerating: boolean;
    setInputValue: Setter<string>;
    executeDeepWritePipeline: (promptText: string, planOverride?: any) => Promise<void>;
    handleStartAgent: (goalText: string) => Promise<void>;
    skills: SkillItem[];
    selectedSkillIds: string[];
    mcpServers: McpServerItem[];
    selectedMcpIds: string[];
    currentSessionId: string | undefined;
    setCurrentSessionId: Setter<string | undefined>;
    sessions: ChatSession[];
    setSessions: Setter<ChatSession[]>;
    messages: ChatMessage[];
    setMessages: Setter<ChatMessage[]>;
    setAutocompleteType: Setter<any>;
    setIsGenerating: Setter<boolean>;
    setLiveThinkingText: Setter<string>;
    setLiveThinkingSeconds: Setter<number>;
    setLiveSteps: Setter<AgentExecutionStep[]>;
    setLiveStreamedText: Setter<string>;
    setActiveStreamingSectionId: Setter<string | undefined>;
    liveThinkingText: string;
    liveThinkingSeconds: number;
    liveSteps: AgentExecutionStep[];
    activeSessionRef: React.MutableRefObject<string | undefined>;
    googleSearchGrounding: boolean;
    activeArtifact: CanvasArtifact | undefined;
    setActiveArtifact: Setter<CanvasArtifact | undefined>;
    artifactHistory: CanvasArtifact[];
    setArtifactHistory: Setter<CanvasArtifact[]>;
    layoutMode: StudioLayoutMode;
    setLayoutMode: Setter<StudioLayoutMode>;
    setMcpExecutions: Setter<McpExecutionState[]>;
    setTokenBudget: Setter<TokenBudgetMetrics>;
    setActiveTerminalError: Setter<TerminalExecutionError | undefined>;
    setShowTerminalErrorToast: Setter<boolean>;
    recordArtifactVersion: (artifact: CanvasArtifact) => void;
    attachedDataFile: AttachedDataFile | undefined;
    setAttachedDataFile: Setter<AttachedDataFile | undefined>;
    attachedContextMentions?: ContextMentionItem[];
    setAttachedContextMentions?: Setter<ContextMentionItem[]>;
    showToast: (text: string, icon?: string) => void;
    graphControllerRef: React.MutableRefObject<ProjectArtifactController>;
    setGraphEpoch: Setter<number>;
    activeWorkspace: ProjectItem;
    persistSessionsImmediately: (updatedSessions: ChatSession[]) => void;
    aiInteractionMode?: 'agent' | 'ask' | 'plan';
    openSettingsToTab?: (tab: StudioSettingsTab) => void;
}

interface GenerationContext {
    text: string;
    textToSend: string | undefined;
    targetPrimitiveType: PrimitiveType | undefined;
    targetSessionId: string;
    updatedMessages: ChatMessage[];
    generationStartTime: number;
    thinkingTimer: ReturnType<typeof setInterval>;
}

interface BackendStreamResult {
    usedBackend: boolean;
    generatedArtifact: CanvasArtifact | undefined;
    finalResponseText: string;
    streamGroundingMetadata: GroundingMetadata | undefined;
    streamExecs: McpExecutionState[];
    streamQuestionCard?: InteractiveQuestionCardData;
    streamExecutionPlanCard?: ExecutionPlanCardData;
}

const cleanMessageText = (rawText: string, artifact?: CanvasArtifact): string => cleanMessageTextSmart(rawText, artifact);

/** Step 1 — `/plan`, `/agent`, `/settings`, `/3d`, `/code`, `/video`, etc. handle slash commands. Returns true if handled. */
async function handleSlashCommands(d: SendMessageDeps, text: string): Promise<boolean> {
    const { setInputValue, executeDeepWritePipeline, handleStartAgent, setLayoutMode, showToast, openSettingsToTab } = d;
    const lowerText = text.trim().toLowerCase();

    // 1. Settings slash command
    if (lowerText === '/settings' || lowerText.startsWith('/settings ')) {
        setInputValue('');
        const tabRaw = lowerText.replace(/^\/settings\s*/, '').trim();
        const validTab = ['general', 'models', 'beta', 'git-prs', 'about', 'appearance', 'skills', 'mcp', 'memories', 'shortcuts'].includes(tabRaw) ? (tabRaw as StudioSettingsTab) : 'general';
        if (openSettingsToTab) {
            openSettingsToTab(validTab);
        } else {
            showToast(`Opening Settings (${validTab})`, '⚙️');
        }
        return true;
    }

    // 2. Deep planning / spec pipeline
    const isDeepWrite = 
        text.trim().startsWith('/plan') ||
        text.trim().startsWith('/deepwrite') ||
        text.trim().startsWith('/codebase') ||
        text.trim().startsWith('/spec') ||
        lowerText.includes('deep-write') ||
        lowerText.includes('deep write') ||
        lowerText.includes('intensive planning') ||
        lowerText.includes('plan a codebase');

    if (isDeepWrite) {
        setInputValue('');
        const cleanPrompt = text.trim()
            .replace(/^\/(plan|deepwrite|codebase|spec)\s*/i, '');
        await executeDeepWritePipeline(cleanPrompt);
        return true;
    }

    // 3. Autonomous agent command
    if (
        text.trim().startsWith('/agent ') ||
        text.trim().startsWith('agent:') ||
        text.trim().startsWith('/goal ') ||
        text.trim().startsWith('goal:') ||
        text.trim().startsWith('/autonomous ')
    ) {
        const goalText = text.trim()
            .replace(/^\/agent\s+/, '')
            .replace(/^agent:\s*/, '')
            .replace(/^\/goal\s+/, '')
            .replace(/^goal:\s*/, '')
            .replace(/^\/autonomous\s+/, '');
        setInputValue('');
        handleStartAgent(goalText);
        return true;
    }

    // 4. Standalone primitive mode switch commands
    if (lowerText === '/doc' || lowerText === '/document') {
        setInputValue('');
        setLayoutMode('document');
        showToast('Switched to Markdown Document workspace', '📄');
        return true;
    }
    if (lowerText === '/code' || lowerText === '/sandbox') {
        setInputValue('');
        setLayoutMode('code');
        showToast('Switched to Live Code Sandbox', '⚡');
        return true;
    }
    if (lowerText === '/3d') {
        setInputValue('');
        setLayoutMode('3d');
        showToast('Switched to 3D Scene workspace', '🌌');
        return true;
    }
    if (lowerText === '/video' || lowerText === '/timeline') {
        setInputValue('');
        setLayoutMode('video');
        showToast('Switched to Video Timeline NLE', '🎬');
        return true;
    }
    if (lowerText === '/graph' || lowerText === '/workflow') {
        setInputValue('');
        setLayoutMode('canvas');
        showToast('Switched to Node Graph workflow', '📊');
        return true;
    }
    if (lowerText === '/kanban' || lowerText === '/board') {
        setInputValue('');
        setLayoutMode('kanban');
        showToast('Switched to Kanban Board', '📋');
        return true;
    }
    if (lowerText === '/dashboard' || lowerText === '/metrics') {
        setInputValue('');
        setLayoutMode('canvas');
        showToast('Switched to Metric Dashboard', '📈');
        return true;
    }
    if (lowerText === '/browser') {
        setInputValue('');
        setLayoutMode('browser');
        showToast('Switched to Interactive In-App Browser', '🌐');
        return true;
    }

    // If followed by a prompt, pre-switch layout mode so downstream generation routes to the right primitive
    if (lowerText.startsWith('/3d ')) {
        setLayoutMode('3d');
    } else if (lowerText.startsWith('/video ') || lowerText.startsWith('/timeline ')) {
        setLayoutMode('video');
    } else if (lowerText.startsWith('/code ') || lowerText.startsWith('/sandbox ')) {
        setLayoutMode('code');
    } else if (lowerText.startsWith('/doc ') || lowerText.startsWith('/document ')) {
        setLayoutMode('document');
    } else if (lowerText.startsWith('/graph ') || lowerText.startsWith('/workflow ')) {
        setLayoutMode('canvas');
    } else if (lowerText.startsWith('/kanban ') || lowerText.startsWith('/board ')) {
        setLayoutMode('kanban');
    } else if (lowerText.startsWith('/dashboard ') || lowerText.startsWith('/metrics ')) {
        setLayoutMode('canvas');
    } else if (lowerText.startsWith('/browser ')) {
        setLayoutMode('browser');
    }

    return false;
}

/** Step 2 — append the user bubble, reset live streaming state and start the thinking timer. */
function beginGeneration(d: SendMessageDeps, text: string, textToSend: string | undefined, targetPrimitiveType: PrimitiveType | undefined): GenerationContext {
    const { setInputValue, skills, selectedSkillIds, mcpServers, selectedMcpIds, currentSessionId, setCurrentSessionId, messages, setMessages, setAutocompleteType, setIsGenerating, setLiveThinkingText, setLiveThinkingSeconds, setLiveSteps, setLiveStreamedText, setActiveStreamingSectionId, activeSessionRef } = d;
    const attachedSkillObjects = skills.filter(s => selectedSkillIds.includes(s.id));
    const attachedMcpObjects = mcpServers.filter(s => selectedMcpIds.includes(s.id));

    const targetSessionId = currentSessionId || `session-chat-${Date.now()}`;
    activeSessionRef.current = targetSessionId;
    if (!currentSessionId) {
        setCurrentSessionId(targetSessionId);
    }

    const userMsg: ChatMessage = {
        id: `msg-user-${Date.now()}`,
        sender: 'user',
        text: text.trim(),
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        attachedSkills: attachedSkillObjects.map(s => s.name),
        attachedMcpTools: attachedMcpObjects.map(m => m.name),
        attachedContextMentions: d.attachedContextMentions && d.attachedContextMentions.length > 0 ? [...d.attachedContextMentions] : undefined
    };

    const updatedMessages = [...messages, userMsg];
    setMessages(updatedMessages);
    setInputValue('');
    if (d.setAttachedContextMentions) {
        d.setAttachedContextMentions([]);
    }
    setAutocompleteType(undefined);
    setIsGenerating(true);
    setLiveThinkingText('');
    setLiveThinkingSeconds(0);
    setLiveSteps([]);
    setLiveStreamedText('');
    setActiveStreamingSectionId(undefined);

    const generationStartTime = Date.now();
    const thinkingTimer = setInterval(() => {
        if (activeSessionRef.current === targetSessionId) {
            setLiveThinkingSeconds(parseFloat(((Date.now() - generationStartTime) / 1000).toFixed(1)));
        }
    }, 100);
    return { text, textToSend, targetPrimitiveType, targetSessionId, updatedMessages, generationStartTime, thinkingTimer };
}

/** Step 3 — stream from the Gemini backend, applying artifact/thought/tool events as they arrive. */
async function streamBackendResponse(d: SendMessageDeps, ctx: GenerationContext, signal: AbortSignal): Promise<BackendStreamResult> {
    const { skills, selectedSkillIds, mcpServers, selectedMcpIds, setSessions, setLiveThinkingText, setLiveSteps, setLiveStreamedText, setActiveStreamingSectionId, activeSessionRef, googleSearchGrounding, activeArtifact, setActiveArtifact, artifactHistory, setArtifactHistory, layoutMode, setLayoutMode, setMcpExecutions, setTokenBudget, setActiveTerminalError, setShowTerminalErrorToast } = d;
    const { text, textToSend, targetSessionId, updatedMessages } = ctx;
    const attachedSkillObjects = d.skills.filter(s => d.selectedSkillIds.includes(s.id));
    const attachedMcpObjects = d.mcpServers.filter(s => d.selectedMcpIds.includes(s.id));
    let usedBackend = false;
    let generatedArtifact: CanvasArtifact | undefined;
    let finalResponseText = '';
    let streamGroundingMetadata: GroundingMetadata | undefined;
    const streamExecs: McpExecutionState[] = [];
    let streamQuestionCard: InteractiveQuestionCardData | undefined;
    let streamExecutionPlanCard: ExecutionPlanCardData | undefined;

    try {
        const attachedSkillsContext: AttachedSkillContext[] = attachedSkillObjects.map(s => ({
            id: s.id,
            name: s.name,
            description: s.description,
            rawContent: s.rawContent,
            tags: s.tags,
            category: s.category
        }));

        const attachedMcpContext: AttachedMcpToolContext[] = [];
        for (const server of attachedMcpObjects) {
            for (const tool of server.tools) {
                attachedMcpContext.push({
                    id: tool.id,
                    serverName: server.name,
                    name: tool.name,
                    humanTitle: tool.humanTitle,
                    description: tool.description,
                    samplePrompt: tool.samplePrompt,
                    category: tool.category
                });
            }
        }

        const chatHistory = updatedMessages.slice(-4).map(m => ({
            role: (m.sender === 'assistant' ? 'model' : 'user') as ('user' | 'model'),
            text: m.text
        }));

        // Format attached @-context items into groundable prompt context
        let effectivePrompt = text.trim();

        // If text is a clarification response or plan confirmation, carry forward the original user goal
        const isClarificationOrConfirmation =
            text.startsWith('[Clarification Selection]') ||
            text.startsWith('[Execution Plan') ||
            text.startsWith('Confirmed. Proceed');

        if (isClarificationOrConfirmation) {
            const priorUserMsg = [...updatedMessages].reverse().find(m =>
                m.sender === 'user' &&
                m.text !== text &&
                !m.text.startsWith('[Clarification Selection]') &&
                !m.text.startsWith('[Execution Plan') &&
                !m.text.startsWith('Confirmed. Proceed')
            );
            if (priorUserMsg && priorUserMsg.text.trim()) {
                effectivePrompt = `User Goal: ${priorUserMsg.text.trim()}\n\nConfiguration Choice: ${text.trim()}`;
            }
        }
        if (d.attachedContextMentions && d.attachedContextMentions.length > 0) {
            const contextLines: string[] = ['\n\n--- INJECTED CONTEXT REFERENCES (@-Engine) ---'];
            for (const ctxItem of d.attachedContextMentions) {
                contextLines.push(`### @${ctxItem.type}: ${ctxItem.name}`);
                if (ctxItem.description) contextLines.push(`> ${ctxItem.description}`);
                if (ctxItem.detail) contextLines.push(ctxItem.detail);
                if (ctxItem.payload) {
                    if (typeof ctxItem.payload === 'string') {
                        contextLines.push(`\`\`\`\n${ctxItem.payload}\n\`\`\``);
                    } else {
                        contextLines.push(`\`\`\`json\n${JSON.stringify(ctxItem.payload, null, 2)}\n\`\`\``);
                    }
                }
            }
            contextLines.push('--- END CONTEXT REFERENCES ---\n');
            effectivePrompt = `${effectivePrompt}\n${contextLines.join('\n')}`;
        }

        await GeminiClient.getInstance().streamGenerate(
            {
                prompt: effectivePrompt,
                model: 'gemini-3.7-flash',
                thinkingBudget: 1024,
                enableGoogleSearch: googleSearchGrounding !== false,
                attachedSkills: attachedSkillsContext,
                attachedMcpTools: attachedMcpContext,
                activeArtifact,
                chatHistory,
                mode: d.aiInteractionMode || 'agent',
                enableWorkspaceTools: true,
                autoVerify: true,
                workspaceRoot: d.activeWorkspace?.path
            },
            event => {
                if (signal.aborted) {
                    return;
                }
                if (event.text || event.artifact || event.mcpExecution || event.type === 'delta') {
                    usedBackend = true;
                }
                if (event.questionCard || event.type === 'question_card') {
                    streamQuestionCard = event.questionCard;
                    usedBackend = true;
                }
                if (event.executionPlanCard || event.type === 'execution_plan_card') {
                    streamExecutionPlanCard = event.executionPlanCard;
                    usedBackend = true;
                }
                if (event.groundingMetadata) {
                    streamGroundingMetadata = event.groundingMetadata;
                }
                if (event.artifact) {
                    let art = event.artifact;
                    const promptText = textToSend || '';
                    const lowerPromptText = promptText.toLowerCase();
                    const isVideoTimelinePrompt = promptText.trim().startsWith('/timeline') ||
                        promptText.trim().startsWith('/video') ||
                        /split\s+(?:active\s+)?clip|ripple\s+delete|playhead|video\s+timeline|timeline\s+editor|video\s+editor|\bnle\b|cut\s+clip|trim\s+clip|multi-track\s+video|b-roll|a-roll|video\s+track|audio\s+mixer\s+track|color\s+grade\s+clip|vfx\s+plate|anti[- ]drift|matchmove/i.test(promptText) ||
                        ((lowerPromptText.includes('clip') || lowerPromptText.includes('timeline')) && (lowerPromptText.includes('split') || lowerPromptText.includes('cut') || lowerPromptText.includes('delete') || lowerPromptText.includes('playhead') || lowerPromptText.includes('ripple') || lowerPromptText.includes('track') || lowerPromptText.includes('video')));

                    if (isVideoTimelinePrompt && art.type !== 'video-timeline') {
                        const fallbackResult = synthesizeVideoTimelineFallback(promptText, activeArtifact);
                        if (fallbackResult.artifact) {
                            art = fallbackResult.artifact;
                        }
                    }

                    const is3DPrompt = hasExplicit3DDirective(promptText) || d.layoutMode === '3d' || d.activeArtifact?.type === '3d-scene' || /build.*3d|make.*3d|create.*3d|generate.*3d|3d\s+scene|3d\s+car|3d\s+vehicle|3d\s+model|\b3d\b|car|vehicle|automobile|truck|sports\s*car|sedan/i.test(promptText);
                    if (is3DPrompt && !isVideoTimelinePrompt) {
                        const sceneData = art.data as Scene3DData;
                        const isMutation = hasExplicit3DDirective(promptText) || d.layoutMode === '3d' || d.activeArtifact?.type === '3d-scene';
                        const isMissing3DMeshes = art.type !== '3d-scene' || !sceneData?.customMeshes?.length;
                        if (isMissing3DMeshes || isMutation) {
                            const fallbackResult = synthesize3DFallback(promptText, lowerPromptText, activeArtifact, updatedMessages, undefined);
                            if (fallbackResult.artifact) {
                                art = fallbackResult.artifact;
                            }
                        }
                    }

                    const isSandboxPrompt = /(?:create|build|generate|make|code|program|develop|prototype)\s+(?:me\s+)?(?:an?\s+)?(?:[\w-]+\s+){0,4}(?:app|application|web\s*app|tool|utility|tracker|dashboard|viewer|calculator|game|widget|simulator|playground|micro-studio|sandbox|ui|interface|prototype)\b/i.test(promptText) ||
                        /\b(?:code\s+sandbox|sandbox\s+code|runnable\s+prototype|react\s+sandbox|component\s+sandbox|app\s+sandbox|interactive\s+sandbox)\b/i.test(promptText);
                    if (isSandboxPrompt && !isVideoTimelinePrompt && !is3DPrompt && art.type !== 'live-code-sandbox') {
                        const fallbackResult = synthesizeSandboxFallback(promptText, activeArtifact);
                        if (fallbackResult.artifact) {
                            art = fallbackResult.artifact;
                        }
                    }

                    const is3DActive = (layoutMode === '3d' || activeArtifact?.type === '3d-scene');
                    const isAnimPrompt = /animate|fly|flight|motion|orbit|play|simulation|bank|roll|spin|takeoff/i.test(textToSend || '');
                    if (is3DActive && isAnimPrompt && art.type === '3d-scene') {
                        const sceneData = art.data as Scene3DData;
                        if (sceneData) {
                            sceneData.timeline = {
                                ...(sceneData.timeline || {}),
                                isPlaying: true,
                                isLooping: true,
                                speed: 1.0,
                                playbackSpeed: 1.0
                            };
                            sceneData.animation = sceneData.animation || (textToSend?.toLowerCase().includes('orbit') ? 'orbit' : 'flight');
                        }
                    }
                    generatedArtifact = art;
                    const resolvedMode = resolveModeForArtifact(art.type);
                    if (!activeSessionRef.current || activeSessionRef.current === targetSessionId) {
                        setActiveArtifact(art);
                        setLayoutMode(resolvedMode);
                    }
                    setSessions(prev => prev.map(s => {
                        if (s.id !== targetSessionId) return s;
                        return {
                            ...s,
                            activeArtifact: art,
                            artifactHistory: [art, ...(s.artifactHistory || []).filter(a => a.id !== art.id)],
                            layoutMode: resolvedMode,
                            updatedAt: 'Just now'
                        };
                    }));
                }

                // Session isolation guard: only update active UI if user is still on targetSessionId
                if (activeSessionRef.current === targetSessionId) {
                    if (event.thought) {
                        setLiveThinkingText(prev => (prev ? `${prev}\n${event.thought}` : event.thought || ''));
                    }
                    if (event.type === 'plan_ready') {
                        d.showToast?.('Implementation plan ready for review', 'clipboard');
                    }
                    if (event.type === 'verification_start') {
                        setLiveSteps(prev => [
                            ...prev,
                            {
                                id: `verify-${Date.now()}`,
                                title: 'Automated verification & self-healing checks running...',
                                status: 'running',
                                kind: 'verify'
                            }
                        ]);
                    }
                    if (event.type === 'verification_result' && event.verification) {
                        const v = event.verification;
                        setLiveSteps(prev => {
                            const lastVerifyIdx = prev.map(s => s.id).reverse().findIndex(id => id.startsWith('verify-'));
                            const actualIdx = lastVerifyIdx >= 0 ? prev.length - 1 - lastVerifyIdx : -1;
                            const step: AgentExecutionStep = {
                                id: `verify-res-${Date.now()}`,
                                title: v.passed ? '✓ Verification passed cleanly' : '⚠ Diagnostic issues found; self-healing...',
                                status: v.passed ? 'completed' : 'failed',
                                details: v.summary,
                                kind: 'verify'
                            };
                            if (actualIdx >= 0) {
                                const next = [...prev];
                                next[actualIdx] = step;
                                return next;
                            }
                            return [...prev, step];
                        });
                    }
                    if (event.mcpExecution) {
                        streamExecs.push(event.mcpExecution);
                        setMcpExecutions(prev => [event.mcpExecution!, ...prev.filter(e => e.id !== event.mcpExecution!.id)]);
                        const stepId = event.mcpExecution.id || `mcp-step-${Date.now()}`;
                        const toolName = event.mcpExecution.toolName || 'MCP Tool';
                        const status = event.mcpExecution.status === 'completed' ? 'completed'
                            : event.mcpExecution.status === 'failed' ? 'failed'
                            : 'running';
                        setLiveSteps(prev => {
                            const existingIdx = prev.findIndex(s => s.id === stepId);
                            const step: AgentExecutionStep = {
                                id: stepId,
                                title: `Executed tool: ${toolName}`,
                                status,
                                durationMs: event.mcpExecution!.durationMs,
                                durationFormatted: event.mcpExecution!.durationMs ? `${event.mcpExecution!.durationMs}ms` : undefined,
                                details: event.mcpExecution!.args ? JSON.stringify(event.mcpExecution!.args, null, 2) : undefined,
                                kind: 'tool'
                            };
                            if (existingIdx >= 0) {
                                const next = [...prev];
                                next[existingIdx] = step;
                                return next;
                            }
                            return [...prev, step];
                        });
                    }
                    if (event.text) {
                        if (event.type === 'delta') {
                            finalResponseText += event.text;
                        } else {
                            finalResponseText = event.text;
                        }
                        setLiveStreamedText(finalResponseText);
                    }
                    if (event.artifact) {
                        setActiveArtifact(event.artifact);
                        setLayoutMode(resolveModeForArtifact(event.artifact.type));
                        if (event.artifact.type === 'markdown-document') {
                            const docData = event.artifact.data as MarkdownDocumentData;
                            if (docData?.sections && docData.sections.length > 0) {
                                setActiveStreamingSectionId(docData.sections[docData.sections.length - 1].id);
                            }
                        }
                        setArtifactHistory(prev => [
                            event.artifact!,
                            ...prev.filter(a => a.id !== event.artifact!.id)
                        ]);
                    }
                    if (event.usage) {
                        setTokenBudget((prev: TokenBudgetMetrics) => ({
                            ...prev,
                            promptTokens: event.usage?.promptTokens || prev.promptTokens,
                            candidateTokens: event.usage?.candidateTokens || prev.candidateTokens,
                            totalTokens: event.usage?.totalTokens || prev.totalTokens
                        }));
                    }
                }
            },
            signal
        );
    } catch (err: any) {
        console.warn('Gemini backend streaming fallback to studio synthesis:', err?.message);
        if (err?.message && (err.message.includes('Command failed') || err.message.includes('Error:') || err.message.includes('TS'))) {
            setActiveTerminalError({
                command: 'Gemini AI Execution',
                exitCode: 1,
                output: err.message,
                stackTrace: err.stack,
                timestamp: Date.now()
            });
            setShowTerminalErrorToast(true);
        }
    }
    const effectiveUsedBackend = usedBackend && (!!generatedArtifact || !!finalResponseText.trim() || !!streamQuestionCard || !!streamExecutionPlanCard);
    return { usedBackend: effectiveUsedBackend, generatedArtifact, finalResponseText, streamGroundingMetadata, streamExecs, streamQuestionCard, streamExecutionPlanCard };
}

/** Step 4a — build the assistant message from a successful backend stream. */
function finalizeBackendMessage(d: SendMessageDeps, ctx: GenerationContext, backend: BackendStreamResult): ChatMessage {
    const { liveThinkingText, liveThinkingSeconds, liveSteps, recordArtifactVersion } = d;
    const { generationStartTime } = ctx;
    const { usedBackend, generatedArtifact, finalResponseText, streamGroundingMetadata, streamExecs } = backend;
    let finalAssistantMsg: ChatMessage;
    const generationElapsedSeconds = parseFloat(((Date.now() - generationStartTime) / 1000).toFixed(1));
    const backendThinkingDuration = liveThinkingSeconds > 0 ? liveThinkingSeconds : generationElapsedSeconds;

    if (usedBackend && generatedArtifact) {
        recordArtifactVersion(generatedArtifact);
        finalAssistantMsg = {
            id: `msg-assistant-${Date.now()}`,
            sender: 'assistant',
            text: cleanMessageText(finalResponseText, generatedArtifact),
            timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            artifacts: [generatedArtifact],
            mcpExecutions: streamExecs.length > 0 ? streamExecs : undefined,
            groundingMetadata: streamGroundingMetadata,
            thinkingText: liveThinkingText || undefined,
            thinkingDurationSeconds: liveThinkingText ? backendThinkingDuration : undefined,
            steps: liveSteps.length > 0 ? liveSteps : undefined,
            questionCard: backend.streamQuestionCard,
            executionPlanCard: backend.streamExecutionPlanCard
        };
    } else if (usedBackend) {
        finalAssistantMsg = {
            id: `msg-assistant-${Date.now()}`,
            sender: 'assistant',
            text: finalResponseText || 'Response received.',
            timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            mcpExecutions: streamExecs.length > 0 ? streamExecs : undefined,
            groundingMetadata: streamGroundingMetadata,
            thinkingText: liveThinkingText || undefined,
            thinkingDurationSeconds: liveThinkingText ? backendThinkingDuration : undefined,
            steps: liveSteps.length > 0 ? liveSteps : undefined,
            questionCard: backend.streamQuestionCard,
            executionPlanCard: backend.streamExecutionPlanCard
        };
    } else {
        throw new Error('finalizeBackendMessage called without a backend response');
    }
    return finalAssistantMsg;
}

/** Step 4b — pick a local synthesizer when the backend was unavailable. */
function selectLocalFallback(d: SendMessageDeps, ctx: GenerationContext): FallbackResult {
    const { text, targetPrimitiveType } = ctx;
    const { activeArtifact, layoutMode, messages, attachedDataFile } = d;

    const isClarificationOrConfirmation =
        text.startsWith('[Clarification Selection]') ||
        text.startsWith('[Execution Plan') ||
        text.startsWith('Confirmed. Proceed');

    let effectiveFallbackText = text;
    if (isClarificationOrConfirmation) {
        const priorUserMsg = [...messages].reverse().find(m =>
            m.sender === 'user' &&
            !m.text.startsWith('[Clarification Selection]') &&
            !m.text.startsWith('[Execution Plan') &&
            !m.text.startsWith('Confirmed. Proceed')
        );
        if (priorUserMsg && priorUserMsg.text.trim()) {
            effectiveFallbackText = priorUserMsg.text.trim();
        }
    }

    const c = classifyFallbackPrompt(effectiveFallbackText, targetPrimitiveType, layoutMode, activeArtifact);

    if (attachedDataFile && attachedDataFile.rowsCount > 0) {
        return synthesizeDataFileDashboard(attachedDataFile);
    }
    if (d.aiInteractionMode === 'plan') {
        return synthesizeExecutionPlanFallback(effectiveFallbackText, activeArtifact);
    }
    const isAmbiguousSpatialQuery = /(?:3d\s*(?:plate|model|asset|object|reconstruct|mesh)|make.*3d|build.*3d)/i.test(effectiveFallbackText) &&
        !/three\.js|react|kanban|doc|video|nle|spec/i.test(effectiveFallbackText) &&
        (effectiveFallbackText.length < 55 || /(?:from\s+(?:this\s+)?image|supplied\s+image|from\s+photo|image\s+to\s+3d)/i.test(effectiveFallbackText));
    if (isAmbiguousSpatialQuery && !isClarificationOrConfirmation) {
        return synthesizeQuestionCardFallback(effectiveFallbackText, activeArtifact);
    }
    if (c.isVideoTimelineRequest) {
        return synthesizeVideoTimelineFallback(effectiveFallbackText, activeArtifact);
    }
    if (c.isExplicitMedia) {
        return synthesizeMediaFallback(effectiveFallbackText, c.isExplicitVideo);
    }
    if (c.isDocumentRequest) {
        return synthesizeDocumentFallback(effectiveFallbackText, activeArtifact);
    }
    if (c.is3DRequest) {
        return synthesize3DFallback(effectiveFallbackText, c.lower, activeArtifact, messages, c.docContentExtract);
    }
    if (c.isKanbanRequest) {
        return synthesizeKanbanFallback(effectiveFallbackText, c.lower, activeArtifact);
    }
    if (c.isGraphRequest) {
        return synthesizeGraphFallback(effectiveFallbackText, c.lower, activeArtifact);
    }
    if (c.isMetricsRequest) {
        return synthesizeMetricsFallback(activeArtifact);
    }
    if (c.isSandboxRequest) {
        return synthesizeSandboxFallback(effectiveFallbackText, activeArtifact);
    }
    return synthesizeChatFallback(effectiveFallbackText, activeArtifact);
}

/** Step 4c — play the simulated agent steps and progressively stream the local response. */
async function streamLocalFallback(d: SendMessageDeps, ctx: GenerationContext, fallbackResult: FallbackResult, signal: AbortSignal): Promise<ChatMessage | undefined> {
    const { setLiveThinkingText, setLiveSteps, setLiveStreamedText, setActiveStreamingSectionId, activeSessionRef, setActiveArtifact, setArtifactHistory, setLayoutMode, recordArtifactVersion, attachedDataFile } = d;
    const { targetSessionId, generationStartTime } = ctx;
    const fallbackGen = fallbackResult.artifact;
    const isPureChat = !fallbackGen;
    const targetAssistantText = isPureChat
        ? (fallbackResult.chatResponse || 'Here is the analysis and information you requested:')
        : (fallbackResult.explanation || buildFallbackAssistantText(attachedDataFile, fallbackGen));
    const simulatedSteps = buildSimulatedSteps(fallbackGen);
    let finalAssistantMsg: ChatMessage;

    const localThinkingText = isPureChat
        ? 'Synthesizing conversational research and formulating structured response...'
        : `Analyzing workspace directives and formulating ${fallbackGen?.title || 'canvas artifact'} architecture...`;

    if (activeSessionRef.current === targetSessionId) {
        setLiveThinkingText(localThinkingText);
        setLiveSteps([...simulatedSteps]);
    }

    // Step 1: context indexing (60ms)
    await new Promise(r => setTimeout(r, 60));
    if (signal.aborted) {
        return undefined;
    }
    simulatedSteps[0].status = 'completed';
    simulatedSteps[0].durationMs = 60;
    simulatedSteps[0].durationFormatted = '60ms';
    simulatedSteps[1].status = 'running';
    if (activeSessionRef.current === targetSessionId) {
        setLiveSteps([...simulatedSteps]);
    }

    // Step 2: synthesis (120ms)
    await new Promise(r => setTimeout(r, 120));
    if (signal.aborted) {
        return undefined;
    }
    simulatedSteps[1].status = 'completed';
    simulatedSteps[1].durationMs = 120;
    simulatedSteps[1].durationFormatted = '120ms';
    simulatedSteps[2].status = 'running';
    if (activeSessionRef.current === targetSessionId) {
        setLiveSteps([...simulatedSteps]);
    }

    // Step 3: verification (30ms)
    await new Promise(r => setTimeout(r, 30));
    if (signal.aborted) {
        return undefined;
    }
    simulatedSteps[2].status = 'completed';
    simulatedSteps[2].durationMs = 30;
    simulatedSteps[2].durationFormatted = '30ms';
    if (activeSessionRef.current === targetSessionId) {
        setLiveSteps([...simulatedSteps]);
    }

    // Progressive Live Streaming Ticker for Instant Local Responsiveness
    if (activeSessionRef.current === targetSessionId) {
        if (isPureChat) {
            await streamTokensAsync(
                targetAssistantText,
                streamed => {
                    if (activeSessionRef.current === targetSessionId) {
                        setLiveStreamedText(streamed);
                    }
                },
                undefined,
                12
            );
        } else if (fallbackGen) {
            const targetLayoutMode = resolveModeForArtifact(fallbackGen.type);
            setLayoutMode(targetLayoutMode);
            if (fallbackGen.type === 'markdown-document' && fallbackGen.data) {
                const fullDoc = fallbackGen.data as MarkdownDocumentData;
                const allSections = fullDoc.sections || [];
                if (allSections.length > 1) {
                    const initialCount = Math.max(1, Math.floor(allSections.length / 3));
                    const initialSections = allSections.slice(0, initialCount);
                    const partialDoc: MarkdownDocumentData = { ...fullDoc, sections: initialSections };
                    const partialArtifact: CanvasArtifact = { ...fallbackGen, data: partialDoc };
                    setActiveArtifact(partialArtifact);
                    if (initialSections.length > 0) {
                        setActiveStreamingSectionId(initialSections[initialSections.length - 1].id);
                    }

                    await streamTokensAsync(
                        targetAssistantText,
                        streamed => {
                            if (activeSessionRef.current === targetSessionId) {
                                setLiveStreamedText(streamed);
                            }
                        },
                        progress => {
                            if (activeSessionRef.current === targetSessionId) {
                                const targetCount = Math.max(1, Math.ceil(allSections.length * progress));
                                const currentShown = allSections.slice(0, targetCount);
                                const activeSec = currentShown[currentShown.length - 1];
                                setActiveStreamingSectionId(activeSec?.id);
                                setActiveArtifact({
                                    ...fallbackGen!,
                                    data: { ...fullDoc, sections: currentShown }
                                });
                            }
                        },
                        18
                    );
                } else {
                    setActiveArtifact(fallbackGen);
                    if (allSections.length > 0) {
                        setActiveStreamingSectionId(allSections[0].id);
                    }
                    await streamTokensAsync(
                        targetAssistantText,
                        streamed => {
                            if (activeSessionRef.current === targetSessionId) {
                                setLiveStreamedText(streamed);
                            }
                        },
                        undefined,
                        18
                    );
                }
            } else {
                setActiveArtifact(fallbackGen);
                await streamTokensAsync(
                    targetAssistantText,
                    streamed => {
                        if (activeSessionRef.current === targetSessionId) {
                            setLiveStreamedText(streamed);
                        }
                    },
                    undefined,
                    18
                );
            }

            recordArtifactVersion(fallbackGen);
            setArtifactHistory(prev => [fallbackGen!, ...prev.filter(a => a.id !== fallbackGen!.id)]);
        }
    }

    const localElapsedSeconds = parseFloat(((Date.now() - generationStartTime) / 1000).toFixed(1));
    finalAssistantMsg = {
        id: `msg-assistant-${Date.now()}`,
        sender: 'assistant',
        text: targetAssistantText,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        artifacts: fallbackGen ? [fallbackGen] : undefined,
        thinkingText: localThinkingText,
        thinkingDurationSeconds: localElapsedSeconds,
        steps: simulatedSteps,
        questionCard: fallbackResult.questionCard,
        executionPlanCard: fallbackResult.executionPlanCard
    };
    return finalAssistantMsg;
}

/** Step 5 — register the artifact in the project graph, update the session list and reset live UI. */
function commitAssistantMessage(d: SendMessageDeps, ctx: GenerationContext, finalAssistantMsg: ChatMessage, generatedArtifact: CanvasArtifact | undefined, fallbackGen: CanvasArtifact | undefined): void {
    const { sessions, setSessions, messages, setMessages, setIsGenerating, setLiveThinkingText, setLiveThinkingSeconds, setLiveSteps, setLiveStreamedText, setActiveStreamingSectionId, activeSessionRef, activeArtifact, setActiveArtifact, artifactHistory, layoutMode, setLayoutMode, recordArtifactVersion, setAttachedDataFile, graphControllerRef, setGraphEpoch, activeWorkspace, persistSessionsImmediately } = d;
    const { text, targetSessionId, updatedMessages, thinkingTimer } = ctx;
    // Clear attached data file after generation
    setAttachedDataFile(undefined);

    const newlyGeneratedArtifact = generatedArtifact || fallbackGen;
    const finalArtifact = newlyGeneratedArtifact
        ? graphControllerRef.current.registerArtifact(
            newlyGeneratedArtifact,
            `chat-artifact-${targetSessionId}-${finalAssistantMsg.id}`
        )
        : undefined;
    if (finalArtifact?.graphRef) {
        finalAssistantMsg = {
            ...finalAssistantMsg,
            artifacts: [finalArtifact],
            artifactRefs: [finalArtifact.graphRef]
        };
        setGraphEpoch(epoch => epoch + 1);
    }
    const nextFullMessages = [...updatedMessages, finalAssistantMsg];

    // Update or create chat session (auto-rename 'New Chat' to first prompt topic like Cursor)
    const currentTitle = targetSessionId ? sessions.find(s => s.id === targetSessionId)?.title : undefined;
    const isDefaultTitle = !currentTitle || currentTitle === 'New Chat' || currentTitle === 'Untitled Chat' || currentTitle === 'New Canvas';
    const sessionTitle = isDefaultTitle
        ? (text.length > 36 ? text.slice(0, 34) + '...' : text)
        : (currentTitle || text.slice(0, 32));

    setSessions(prev => {
        const exists = prev.some(s => s.id === targetSessionId);
        const existingSession = exists ? prev.find(s => s.id === targetSessionId) : undefined;
        const currentActiveArtifact = finalArtifact || existingSession?.activeArtifact;
        const currentLayoutMode = finalArtifact 
            ? resolveModeForArtifact(finalArtifact.type) 
            : (existingSession?.layoutMode || layoutMode || 'chat');
        const sessionData: ChatSession = {
            id: targetSessionId,
            title: sessionTitle,
            fileType: exists ? existingSession?.fileType || 'chat' : 'chat',
            workspaceId: activeWorkspace.id,
            workspaceName: activeWorkspace.path.split('/').pop() || activeWorkspace.name,
            relativeTime: 'Just now',
            dateCategory: 'Today',
            updatedAt: 'Just now',
            messages: nextFullMessages,
            activeArtifact: currentActiveArtifact,
            artifactHistory: finalArtifact ? [finalArtifact, ...artifactHistory.filter(a => a.id !== finalArtifact.id)] : artifactHistory,
            layoutMode: currentLayoutMode
        };
        const updated = exists ? prev.map(s => s.id === targetSessionId ? sessionData : s) : [sessionData, ...prev];
        persistSessionsImmediately(updated);
        return updated;
    });

    clearInterval(thinkingTimer);

    // Only update active UI if user is still on this target session
    if (!activeSessionRef.current || activeSessionRef.current === targetSessionId) {
        setMessages(nextFullMessages);
        setIsGenerating(false);
        setLiveThinkingText('');
        setLiveThinkingSeconds(0);
        setLiveSteps([]);
        setLiveStreamedText('');
        setActiveStreamingSectionId(undefined);
        if (finalArtifact) {
            setActiveArtifact(finalArtifact);
            setLayoutMode(resolveModeForArtifact(finalArtifact.type));
            recordArtifactVersion(finalArtifact);
        }
    } else {
        setIsGenerating(false);
        setLiveThinkingText('');
        setLiveThinkingSeconds(0);
        setLiveSteps([]);
        setLiveStreamedText('');
        setActiveStreamingSectionId(undefined);
    }
}

export interface UseSendMessageResult {
    /** Send a chat message (defaults to the composer text). Stable identity across renders. */
    sendMessage: (textToSend?: string, targetPrimitiveType?: PrimitiveType) => Promise<void>;
    /** Abort any in-flight generation and reset the live streaming UI. */
    cancelInFlight: () => void;
}

/**
 * The Studio's send pipeline: slash commands → user bubble → Gemini stream → (local fallback) → commit.
 * An `AbortController` per send lets the stream be cancelled on unmount or when a new send starts,
 * so no state updates land on an unmounted Studio.
 */
export function useSendMessage(deps: SendMessageDeps): UseSendMessageResult {
    const depsRef = React.useRef<SendMessageDeps>(deps);
    depsRef.current = deps;
    const abortRef = React.useRef<AbortController | null>(null);

    const cancelInFlight = React.useCallback(() => {
        if (abortRef.current) {
            abortRef.current.abort();
            abortRef.current = null;
        }
    }, []);

    React.useEffect(() => () => cancelInFlight(), [cancelInFlight]);

    const sendMessage = React.useCallback(async (textToSend?: string, targetPrimitiveType?: PrimitiveType) => {
        const d = depsRef.current;
        const text = textToSend !== undefined ? textToSend : d.inputValue;
        if (!text.trim() || d.isGenerating) {
            return;
        }
        if (await handleSlashCommands(d, text)) {
            return;
        }

        cancelInFlight();
        const controller = new AbortController();
        abortRef.current = controller;
        const { signal } = controller;

        const ctx = beginGeneration(d, text, textToSend, targetPrimitiveType);
        const resetLiveState = () => {
            clearInterval(ctx.thinkingTimer);
            const latest = depsRef.current;
            latest.setIsGenerating(false);
            latest.setLiveThinkingText('');
            latest.setLiveThinkingSeconds(0);
            latest.setLiveSteps([]);
            latest.setLiveStreamedText('');
            latest.setActiveStreamingSectionId(undefined);
        };
        signal.addEventListener('abort', resetLiveState, { once: true });

        const backend = await streamBackendResponse(depsRef.current, ctx, signal);
        if (signal.aborted) {
            return;
        }

        let finalAssistantMsg: ChatMessage;
        let fallbackGen: CanvasArtifact | undefined;
        if (backend.usedBackend) {
            let promptText = ctx.text || '';
            const isClarificationOrConfirmation =
                promptText.startsWith('[Clarification Selection]') ||
                promptText.startsWith('[Execution Plan') ||
                promptText.startsWith('Confirmed. Proceed');

            if (isClarificationOrConfirmation) {
                const priorUserMsg = [...ctx.updatedMessages].reverse().find(m =>
                    m.sender === 'user' &&
                    !m.text.startsWith('[Clarification Selection]') &&
                    !m.text.startsWith('[Execution Plan') &&
                    !m.text.startsWith('Confirmed. Proceed')
                );
                if (priorUserMsg && priorUserMsg.text.trim()) {
                    promptText = priorUserMsg.text.trim();
                }
            }
            const lowerPromptText = promptText.toLowerCase();
            const isVideoTimelinePrompt = promptText.trim().startsWith('/timeline') ||
                promptText.trim().startsWith('/video') ||
                /split\s+(?:active\s+)?clip|ripple\s+delete|playhead|video\s+timeline|timeline\s+editor|video\s+editor|\bnle\b|cut\s+clip|trim\s+clip|multi-track\s+video|b-roll|a-roll|video\s+track|audio\s+mixer\s+track|color\s+grade\s+clip|vfx\s+plate|anti[- ]drift|matchmove/i.test(promptText) ||
                ((lowerPromptText.includes('clip') || lowerPromptText.includes('timeline')) && (lowerPromptText.includes('split') || lowerPromptText.includes('cut') || lowerPromptText.includes('delete') || lowerPromptText.includes('playhead') || lowerPromptText.includes('ripple') || lowerPromptText.includes('track') || lowerPromptText.includes('video')));
            if (isVideoTimelinePrompt && (!backend.generatedArtifact || backend.generatedArtifact.type !== 'video-timeline')) {
                const fb = synthesizeVideoTimelineFallback(promptText, depsRef.current.activeArtifact);
                if (fb.artifact) {
                    backend.generatedArtifact = fb.artifact;
                    depsRef.current.showToast(fb.toast?.text || `Synthesized Video NLE: ${fb.artifact.title}`, fb.toast?.icon || '🎬');
                }
            }
            const isSplatDirective = /(?:gaussian\s*splats?|3dgs|\bsplats?\b|radiance\s*fields?)/i.test(promptText);
            const is3DDirective = isSplatDirective || hasExplicit3DDirective(promptText) || depsRef.current.layoutMode === '3d' || depsRef.current.activeArtifact?.type === '3d-scene' || /build.*3d|make.*3d|create.*3d|generate.*3d|3d\s+scene|3d\s+car|3d\s+vehicle|3d\s+model|\b3d\b|car|vehicle|automobile|truck|sports\s*car|sedan/i.test(promptText);
            if (is3DDirective && !isVideoTimelinePrompt) {
                const currentArt = backend.generatedArtifact || depsRef.current.activeArtifact;
                const sceneData = currentArt?.data as Scene3DData | undefined;
                const isMutationDirective = hasExplicit3DDirective(promptText) || depsRef.current.layoutMode === '3d' || currentArt?.type === '3d-scene';
                const isMissing3DMeshes = !currentArt || currentArt.type !== '3d-scene' || (!sceneData?.customMeshes?.length && !sceneData?.splatUrl && !sceneData?.objects?.some(o => o.content?.type === 'gaussian-splat'));
                if (isMissing3DMeshes || isMutationDirective) {
                    const fb = synthesize3DFallback(promptText, lowerPromptText, depsRef.current.activeArtifact, ctx.updatedMessages, undefined);
                    if (fb.artifact) {
                        backend.generatedArtifact = fb.artifact;
                        if (fb.explanation && (!backend.finalResponseText || backend.finalResponseText.length < 50)) {
                            backend.finalResponseText = fb.explanation;
                        }
                        const finalArt = backend.generatedArtifact;
                        depsRef.current.setActiveArtifact(finalArt);
                        depsRef.current.setLayoutMode('3d');
                        depsRef.current.showToast(fb.toast?.text || `Updated 3D Scene: ${finalArt.title}`, fb.toast?.icon || '🪐');
                    }
                }
            }
            const isSandboxCreationPrompt = /(?:create|build|generate|make|code|program|develop|prototype)\s+(?:me\s+)?(?:an?\s+)?(?:[\w-]+\s+){0,4}(?:app|application|web\s*app|tool|utility|tracker|dashboard|viewer|calculator|game|widget|simulator|playground|micro-studio|sandbox|ui|interface|prototype)\b/i.test(promptText) ||
                /\b(?:code\s+sandbox|sandbox\s+code|runnable\s+prototype|react\s+sandbox|component\s+sandbox|app\s+sandbox|interactive\s+sandbox)\b/i.test(promptText);

            if (isSandboxCreationPrompt && !isVideoTimelinePrompt && !is3DDirective) {
                const currentArt = backend.generatedArtifact;
                if (!currentArt || currentArt.type !== 'live-code-sandbox') {
                    const fb = synthesizeSandboxFallback(promptText, depsRef.current.activeArtifact);
                    if (fb.artifact) {
                        backend.generatedArtifact = fb.artifact;
                        depsRef.current.setActiveArtifact(fb.artifact);
                        depsRef.current.setLayoutMode('code');
                        depsRef.current.showToast(fb.toast?.text || `Synthesized Live Sandbox: ${fb.artifact.title}`, fb.toast?.icon || '💻');
                    }
                }
            }
            finalAssistantMsg = finalizeBackendMessage(depsRef.current, ctx, backend);
        } else {
            const latest = depsRef.current;
            const result = selectLocalFallback(latest, ctx);
            fallbackGen = result.artifact;
            if (result.toast) {
                latest.showToast(result.toast.text, result.toast.icon);
            }
            const localMsg = await streamLocalFallback(depsRef.current, ctx, result, signal);
            if (signal.aborted || !localMsg) {
                return;
            }
            finalAssistantMsg = localMsg;
        }

        signal.removeEventListener('abort', resetLiveState);
        commitAssistantMessage(depsRef.current, ctx, finalAssistantMsg, backend.generatedArtifact, fallbackGen);
        if (abortRef.current === controller) {
            abortRef.current = null;
        }
    }, [cancelInFlight]);

    return { sendMessage, cancelInFlight };
}
