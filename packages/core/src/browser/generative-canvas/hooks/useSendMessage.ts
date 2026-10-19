/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
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
    SkillItem,
    StudioLayoutMode,
    StudioSettingsTab,
    TerminalExecutionError,
    TokenBudgetMetrics,
    InteractiveQuestionCardData,
    ExecutionPlanCardData
} from '../canvas-types';
import { AttachedMcpToolContext, AttachedSkillContext, type ModelAnswerProvenance } from '../../../common/gemini-protocol';
import { ChatRequestError, GeminiClient, type ChatFailureKind } from '../gemini-client';
import { describeChatFailure } from './chatFailureMessage';
import {
    buildFailedReply,
    buildStoppedReply,
    committedSessionCanvas,
    mcpExecutionToStep,
    mediaModelNoteOf,
    recordExecution,
    recordMediaModelNote,
    settleRunningExecution,
    settleRunningSteps,
    STREAM_CANCELLED,
    STREAM_ENDED,
    STREAM_FAILED,
    upsertExecution,
    withCommittedArtifact,
    upsertStep,
    USER_STOP,
    type PartialReply,
    type StepCutoff
} from './toolStepState';
import { resolveModeForArtifact } from '../guardrails-service';
import { cleanMessageTextSmart } from '../ChatMarkdownRenderer';
import { ProjectArtifactController } from '../project-artifact-controller';
import { WorkspaceConfigClient } from '../workspace-config-client';
import { markStagedRun, publishStageEvent, settleStagedRunInSession } from '../primitives/scene3d/stagedBuild/stagedBuildState';
import type { StageEvent } from '../../../common/spatial/staged-location-contracts';
import { ProjectItem } from '../ProjectsModal';

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

/**
 * What the backend stream has shown so far: the record the saved reply is built from, whether the
 * stream finishes, fails or is stopped. It is kept whichever session the user is viewing (the live
 * React state only follows the visible session), and lets Stop build the reply at once (the abort
 * handler cannot read state updates React has not rendered yet).
 */
interface StreamProgress {
    text: string;
    thinking: string;
    steps: AgentExecutionStep[];
    execs: McpExecutionState[];
    artifact?: CanvasArtifact;
    groundingMetadata?: GroundingMetadata;
    questionCard?: InteractiveQuestionCardData;
    executionPlanCard?: ExecutionPlanCardData;
    /** Which model and credential answered (from the stream's `done` event). */
    modelProvenance?: ModelAnswerProvenance;
    /** Notes from tool results whose media a model other than the requested one made (recordMediaModelNote). */
    mediaModelNotes: string[];
}

interface GenerationContext {
    text: string;
    textToSend: string | undefined;
    targetPrimitiveType: PrimitiveType | undefined;
    targetSessionId: string;
    updatedMessages: ChatMessage[];
    generationStartTime: number;
    thinkingTimer: ReturnType<typeof setInterval>;
    progress: StreamProgress;
}

interface BackendStreamResult {
    usedBackend: boolean;
    connectionError?: string;
    failureKind?: ChatFailureKind;
    failureStatus?: number;
    generatedArtifact: CanvasArtifact | undefined;
    finalResponseText: string;
    streamGroundingMetadata: GroundingMetadata | undefined;
    streamExecs: McpExecutionState[];
    streamQuestionCard?: InteractiveQuestionCardData;
    streamExecutionPlanCard?: ExecutionPlanCardData;
}

const cleanMessageText = (rawText: string, artifact?: CanvasArtifact): string => cleanMessageTextSmart(rawText, artifact);

/**
 * Runs an @terminal mention's command in the workspace sandbox (POST /workspace/run-command) and returns the mention
 * with the real exit code, stdout and stderr as its payload; a refused or failed run is attached as that failure.
 */
async function runTerminalMention(item: ContextMentionItem, workspaceRoot?: string): Promise<ContextMentionItem> {
    const command = (item.payload as { command?: string } | undefined)?.command;
    if (!command) return item;
    try {
        const res = await fetch('/workspace/run-command', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ command, workspaceRoot })
        });
        const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        if (!res.ok || !body.success) {
            return { ...item, detail: `The command did not run: ${body.error || `HTTP ${res.status}`}`, payload: undefined };
        }
        const clip = (t: string) => (t && t.length > 8000 ? `${t.slice(0, 8000)}\n[... ${t.length - 8000} more characters]` : t);
        return {
            ...item,
            detail: `$ ${command}\n(exit code ${body.exitCode}${body.timedOut ? ', timed out' : ''}, ${body.durationMs} ms, cwd ${body.cwd})`,
            payload: `stdout:\n${clip(body.stdout || '')}\n\nstderr:\n${clip(body.stderr || '')}`
        };
    } catch (err) {
        return { ...item, detail: `The command did not run: ${err instanceof Error ? err.message : String(err)}`, payload: undefined };
    }
}

/** Step 1 — `/plan`, `/agent`, `/settings`, `/3d`, `/code`, `/video`, etc. handle slash commands. Returns true if handled. */
async function handleSlashCommands(d: SendMessageDeps, text: string): Promise<boolean> {
    const { setInputValue, executeDeepWritePipeline, handleStartAgent, setLayoutMode, showToast, openSettingsToTab } = d;
    const lowerText = text.trim().toLowerCase();

    // 1. Settings slash command
    if (lowerText === '/settings' || lowerText.startsWith('/settings ')) {
        setInputValue('');
        const tabRaw = lowerText.replace(/^\/settings\s*/, '').trim();
        const validTab = ['general', 'appearance', 'models', 'workspace', 'skills', 'mcp', 'memories', 'shortcuts', 'admin', 'about'].includes(tabRaw) ? (tabRaw as StudioSettingsTab) : 'general';
        if (openSettingsToTab) {
            openSettingsToTab(validTab);
        } else {
            showToast(`Opening Settings (${validTab})`, '⚙️');
        }
        return true;
    }

    // 2. Deep planning / spec pipeline: only its slash commands start it. Words in an ordinary message ("deep
    // write", "plan a codebase") are the model's to read, never a route.
    const isDeepWrite = /^\/(plan|deepwrite|codebase|spec)(\s|$)/i.test(text.trim());

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
    const progress: StreamProgress = { text: '', thinking: '', steps: [], execs: [], mediaModelNotes: [] };
    return { text, textToSend, targetPrimitiveType, targetSessionId, updatedMessages, generationStartTime, thinkingTimer, progress };
}

/** Step 3 — stream from the Gemini backend, applying artifact/thought/tool events as they arrive. */
async function streamBackendResponse(d: SendMessageDeps, ctx: GenerationContext, signal: AbortSignal): Promise<BackendStreamResult> {
    const { skills, selectedSkillIds, mcpServers, selectedMcpIds, setSessions, setLiveThinkingText, setLiveSteps, setLiveStreamedText, setActiveStreamingSectionId, activeSessionRef, googleSearchGrounding, activeArtifact, setActiveArtifact, artifactHistory, setArtifactHistory, layoutMode, setLayoutMode, setMcpExecutions, setTokenBudget, setActiveTerminalError, setShowTerminalErrorToast } = d;
    const { text, textToSend, targetSessionId, updatedMessages, progress } = ctx;
    const attachedSkillObjects = d.skills.filter(s => d.selectedSkillIds.includes(s.id));
    const attachedMcpObjects = d.mcpServers.filter(s => d.selectedMcpIds.includes(s.id));
    let usedBackend = false;
    // Session isolation: the live UI (steps, streamed text, thinking, toasts, the canvas) follows the
    // session on screen, but `progress`, the Studio-wide tool list and the session record are kept
    // whichever session the user is viewing, so a reply that finishes in the background is saved whole.
    const targetVisible = () => !activeSessionRef.current || activeSessionRef.current === targetSessionId;
    // Step-list changes go to the record first, then (when visible) to the live UI, which is always
    // given the whole list so it catches up when the user comes back to this session.
    const updateSteps = (change: (steps: AgentExecutionStep[]) => AgentExecutionStep[]) => {
        progress.steps = change(progress.steps);
        if (targetVisible()) {
            setLiveSteps(progress.steps);
        }
    };
    let connectionError: string | undefined;
    let failureKind: ChatFailureKind | undefined;
    let failureStatus: number | undefined;

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

        // The whole conversation before this message; the server summarizes older turns when it
        // outgrows the context budget. Assistant turns note which tools ran, since their results
        // are not replayed.
        const chatHistory = updatedMessages
            .slice(0, -1)
            .filter(m => m.sender !== 'system' && !m.isStreaming)
            .map(m => {
                const tools = (m.mcpExecutions || [])
                    .map(e => `${e.toolName} (${e.status})${e.summaryResult ? `: ${e.summaryResult.slice(0, 200)}` : ''}`);
                const text = tools.length > 0 ? `${m.text}\n\n[Tools run: ${tools.join('; ')}]` : m.text;
                return { role: (m.sender === 'assistant' ? 'model' : 'user') as ('user' | 'model'), text };
            })
            .filter(m => m.text.trim());

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
            // @terminal items run now, in the workspace sandbox; the message carries their real output.
            const resolvedMentions = await Promise.all(d.attachedContextMentions.map(item =>
                item.type === 'terminal' ? runTerminalMention(item, d.activeWorkspace?.path) : Promise.resolve(item)));
            for (const ctxItem of resolvedMentions) {
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

        const requiresWebSearch = !!d.attachedContextMentions?.some(m => m.type === 'web');

        // Model and thinking budget come from Settings > Models & AI; when nothing is saved the
        // backend's own defaults apply.
        const { settings: savedSettings } = await WorkspaceConfigClient.getInstance().fetchWorkspaceConfig(d.activeWorkspace?.path);
        await GeminiClient.getInstance().streamGenerate(
            {
                prompt: effectivePrompt,
                model: savedSettings?.defaultModel || undefined,
                thinkingBudget: savedSettings?.thinkingBudget,
                // @web requires a Google Search for this turn, whatever the grounding setting.
                enableGoogleSearch: requiresWebSearch || googleSearchGrounding !== false,
                requireGoogleSearch: requiresWebSearch || undefined,
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
                publishStageEvent((event as { stageEvent?: StageEvent }).stageEvent);
                const visible = targetVisible();
                const isReplyText = !!event.text && event.type !== 'status' && event.type !== 'thought' && event.type !== 'subagent_start' && event.type !== 'subagent_done';
                if (event.artifact || event.mcpExecution || event.type === 'delta' || isReplyText) {
                    usedBackend = true;
                }
                if (event.questionCard || event.type === 'question_card') {
                    progress.questionCard = event.questionCard;
                    usedBackend = true;
                }
                if (event.executionPlanCard || event.type === 'execution_plan_card') {
                    progress.executionPlanCard = event.executionPlanCard;
                    usedBackend = true;
                }
                if (event.groundingMetadata) {
                    progress.groundingMetadata = event.groundingMetadata;
                }
                if (event.modelProvenance) {
                    progress.modelProvenance = event.modelProvenance;
                }
                if (event.type === 'status' && event.text && (event.modelProvenance || event.text.startsWith('@web:'))) {
                    // The fallback list moved on mid-turn ("X is not available (…); trying Y"): shown as it happens,
                    // not only on the finished reply.
                    const text = event.text;
                    updateSteps(prev => [...prev, { id: `model-${Date.now()}-${prev.length}`, title: text, status: 'completed', kind: 'context' }]);
                }
                if (event.artifact) {
                    // Mounted exactly as the backend sent it: words in the prompt never swap in a template
                    // artifact or switch on playback the model did not set.
                    const art = event.artifact;
                    progress.artifact = art;
                    const resolvedMode = resolveModeForArtifact(art.type);
                    if (visible) {
                        setActiveArtifact(art);
                        setLayoutMode(resolvedMode);
                        if (art.type === 'markdown-document') {
                            const docData = art.data as MarkdownDocumentData;
                            if (docData?.sections && docData.sections.length > 0) {
                                setActiveStreamingSectionId(docData.sections[docData.sections.length - 1].id);
                            }
                        }
                        setArtifactHistory(prev => [art, ...prev.filter(a => a.id !== art.id)]);
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
                if (event.thought) {
                    progress.thinking = progress.thinking ? `${progress.thinking}\n${event.thought}` : event.thought;
                    if (visible) {
                        setLiveThinkingText(progress.thinking);
                    }
                }
                if (event.type === 'plan_ready' && visible) {
                    d.showToast?.('Implementation plan ready for review', 'clipboard');
                }
                if (event.type === 'verification_start') {
                    updateSteps(prev => [
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
                    updateSteps(prev => {
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
                if (event.type === 'task_list' && event.taskList) {
                    // The agent's checklist leads the step list and is replaced wholesale on each update.
                    const taskSteps: AgentExecutionStep[] = event.taskList.map((t, i) => ({
                        id: `task-${i}`,
                        title: t.title,
                        status: t.status === 'completed' ? 'completed' : t.status === 'in_progress' ? 'running' : 'pending',
                        kind: 'task'
                    }));
                    updateSteps(prev => [...taskSteps, ...prev.filter(st => st.kind !== 'task')]);
                }
                if (event.mcpExecution && event.mcpExecution.toolName !== 'update_task_list') {
                    // A running tool reports again every few seconds with the same id; its finished
                    // result (same id) replaces the running card, and a late report never undoes it.
                    const exec = event.mcpExecution;
                    progress.execs = upsertExecution(progress.execs, exec);
                    setMcpExecutions(prev => recordExecution(prev, exec));
                    updateSteps(prev => upsertStep(prev, mcpExecutionToStep(exec)));
                }
                if (event.toolResult) {
                    // A tool whose media came from a model other than the one asked for says which and why; the
                    // reply's image and video cards show it.
                    progress.mediaModelNotes = recordMediaModelNote(progress.mediaModelNotes, event.toolResult.result);
                }
                if (isReplyText) {
                    progress.text = event.type === 'delta' ? progress.text + event.text : event.text!;
                    if (visible) {
                        setLiveStreamedText(progress.text);
                    }
                }
                if (event.usage && visible) {
                    setTokenBudget((prev: TokenBudgetMetrics) => ({
                        ...prev,
                        promptTokens: event.usage?.promptTokens || prev.promptTokens,
                        candidateTokens: event.usage?.candidateTokens || prev.candidateTokens,
                        totalTokens: event.usage?.totalTokens || prev.totalTokens
                    }));
                }
            },
            signal
        );
    } catch (err: any) {
        if (signal.aborted) {
            // Stop, a newer message or closing the chat ended the stream; the abort handler already
            // settled the UI, so this is not a failure to report.
            return { ...streamResult(progress), usedBackend: false };
        }
        console.warn('Gemini backend streaming error:', err?.message);
        connectionError = err?.message || 'Connection to backend failed';
        failureKind = err instanceof ChatRequestError ? err.kind : 'unreachable';
        failureStatus = err instanceof ChatRequestError ? err.status : undefined;
        // The failed reply still says which model (or credential) answered before it failed.
        if (err instanceof ChatRequestError && err.modelProvenance) progress.modelProvenance = err.modelProvenance;
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
    const result = streamResult(progress);
    const effectiveUsedBackend = !connectionError && usedBackend && (!!result.generatedArtifact || !!result.finalResponseText.trim() || !!result.streamQuestionCard || !!result.streamExecutionPlanCard);
    return { ...result, usedBackend: effectiveUsedBackend, connectionError, failureKind, failureStatus };
}

/** The stream's outcome, read from its progress record. */
function streamResult(progress: StreamProgress): Omit<BackendStreamResult, 'usedBackend' | 'connectionError' | 'failureKind' | 'failureStatus'> {
    return {
        generatedArtifact: progress.artifact,
        finalResponseText: progress.text,
        streamGroundingMetadata: progress.groundingMetadata,
        streamExecs: progress.execs,
        streamQuestionCard: progress.questionCard,
        streamExecutionPlanCard: progress.executionPlanCard
    };
}

/** What the stream had shown, as the input for a stopped or failed reply. */
function partialReplyFrom(ctx: GenerationContext): PartialReply {
    const { progress } = ctx;
    return {
        text: cleanMessageText(progress.text, progress.artifact),
        thinkingText: progress.thinking,
        thinkingDurationSeconds: parseFloat(((Date.now() - ctx.generationStartTime) / 1000).toFixed(1)),
        steps: progress.steps,
        execs: progress.execs,
        artifact: progress.artifact,
        groundingMetadata: progress.groundingMetadata,
        questionCard: progress.questionCard,
        executionPlanCard: progress.executionPlanCard,
        // A fallback model or the API key may have answered before the stream failed: the notice says so.
        modelProvenance: progress.modelProvenance,
        mediaModelNote: mediaModelNoteOf(progress.mediaModelNotes)
    };
}

/** Step 4a — build the assistant message from a successful backend stream. */
function finalizeBackendMessage(d: SendMessageDeps, ctx: GenerationContext, backend: BackendStreamResult): ChatMessage {
    const { recordArtifactVersion } = d;
    const { generationStartTime } = ctx;
    const { usedBackend, generatedArtifact, finalResponseText, streamGroundingMetadata } = backend;
    let finalAssistantMsg: ChatMessage;
    // Read from the stream's own record: the live thinking state belongs to whichever session is on
    // screen, which may not be this reply's.
    const liveThinkingText = ctx.progress.thinking;
    const backendThinkingDuration = parseFloat(((Date.now() - generationStartTime) / 1000).toFixed(1));
    // The stream is over, so a tool that never reported a result must not keep spinning in the saved message.
    const streamExecs = backend.streamExecs.map(e => settleRunningExecution(e, STREAM_ENDED));
    const liveSteps = settleRunningSteps(ctx.progress.steps, backend.streamExecs, STREAM_ENDED);

    if (usedBackend && generatedArtifact) {
        recordArtifactVersion(generatedArtifact);
        finalAssistantMsg = {
            id: `msg-assistant-${Date.now()}`,
            sender: 'assistant',
            text: cleanMessageText(finalResponseText, generatedArtifact) || `I've synthesized the **${generatedArtifact.title || 'Canvas Artifact'}** on your visual canvas.`,
            timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            artifacts: [generatedArtifact],
            mcpExecutions: streamExecs.length > 0 ? streamExecs : undefined,
            groundingMetadata: streamGroundingMetadata,
            thinkingText: liveThinkingText || undefined,
            thinkingDurationSeconds: liveThinkingText ? backendThinkingDuration : undefined,
            steps: liveSteps.length > 0 ? liveSteps : undefined,
            questionCard: backend.streamQuestionCard,
            executionPlanCard: backend.streamExecutionPlanCard,
            modelProvenance: ctx.progress.modelProvenance,
            mediaModelNote: mediaModelNoteOf(ctx.progress.mediaModelNotes)
        };
    } else if (usedBackend) {
        finalAssistantMsg = {
            id: `msg-assistant-${Date.now()}`,
            sender: 'assistant',
            text: cleanMessageText(finalResponseText) || 'Response received.',
            timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            mcpExecutions: streamExecs.length > 0 ? streamExecs : undefined,
            groundingMetadata: streamGroundingMetadata,
            thinkingText: liveThinkingText || undefined,
            thinkingDurationSeconds: liveThinkingText ? backendThinkingDuration : undefined,
            steps: liveSteps.length > 0 ? liveSteps : undefined,
            questionCard: backend.streamQuestionCard,
            executionPlanCard: backend.streamExecutionPlanCard,
            modelProvenance: ctx.progress.modelProvenance,
            mediaModelNote: mediaModelNoteOf(ctx.progress.mediaModelNotes)
        };
    } else {
        throw new Error('finalizeBackendMessage called without a backend response');
    }
    return finalAssistantMsg;
}

/** Step 5 — register the artifact in the project graph, update the session list and reset live UI. */
function commitAssistantMessage(d: SendMessageDeps, ctx: GenerationContext, finalAssistantMsg: ChatMessage, generatedArtifact: CanvasArtifact | undefined): void {
    const { sessions, setSessions, messages, setMessages, setIsGenerating, setLiveThinkingText, setLiveThinkingSeconds, setLiveSteps, setLiveStreamedText, setActiveStreamingSectionId, activeSessionRef, activeArtifact, setActiveArtifact, artifactHistory, setArtifactHistory, layoutMode, setLayoutMode, recordArtifactVersion, setAttachedDataFile, graphControllerRef, setGraphEpoch, activeWorkspace, persistSessionsImmediately } = d;
    const { text, targetSessionId, updatedMessages, thinkingTimer } = ctx;
    // Clear attached data file after generation
    setAttachedDataFile(undefined);

    const newlyGeneratedArtifact = generatedArtifact;
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

    // The Studio's artifact history and layout belong to the session on screen; when the user has moved
    // to another one, the reply's session keeps its own and only gains the reply's artifact.
    const targetVisible = !activeSessionRef.current || activeSessionRef.current === targetSessionId;
    setSessions(prev => {
        const existingSession = prev.find(s => s.id === targetSessionId);
        const exists = !!existingSession;
        const canvas = committedSessionCanvas({
            targetVisible,
            visible: { artifactHistory, layoutMode },
            stored: existingSession,
            finalArtifact,
            finalArtifactMode: finalArtifact ? resolveModeForArtifact(finalArtifact.type) : undefined,
            streamedArtifactId: generatedArtifact?.id
        });
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
            activeArtifact: canvas.activeArtifact,
            artifactHistory: canvas.artifactHistory,
            layoutMode: canvas.layoutMode
        };
        const updated = exists ? prev.map(s => s.id === targetSessionId ? sessionData : s) : [sessionData, ...prev];
        persistSessionsImmediately(updated);
        return updated;
    });

    clearInterval(thinkingTimer);

    // Only update active UI if user is still on this target session
    if (targetVisible) {
        setMessages(nextFullMessages);
        setIsGenerating(false);
        setLiveThinkingText('');
        setLiveThinkingSeconds(0);
        setLiveSteps([]);
        setLiveStreamedText('');
        setActiveStreamingSectionId(undefined);
        if (finalArtifact) {
            setActiveArtifact(finalArtifact);
            // The tab the artifact streamed into becomes the committed one (the commit may have given it its project id).
            setArtifactHistory(prev => withCommittedArtifact(prev, finalArtifact, generatedArtifact?.id));
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
    /**
     * Stop the reply being generated (the composer's Stop button). The request is aborted, which tells
     * the server to end the turn and stop the running tool; the text, thinking and tool steps that
     * already streamed are kept as the reply, with running tools marked stopped. Does nothing when no
     * reply is streaming.
     */
    cancelInFlight: () => void;
    /**
     * A chat reply from this hook is streaming, so `cancelInFlight` has something to stop. Other work
     * that sets `isGenerating` (the deep-write pipeline) cannot be stopped this way.
     */
    streamInFlight: boolean;
}

/** Marks the running tool cards of one stream as cut off in the Studio-wide tool-execution list. */
function settleGlobalExecutions(d: SendMessageDeps, progress: StreamProgress, cutoff: StepCutoff): void {
    const ids = new Set(progress.execs.map(e => e.id));
    if (ids.size > 0) {
        d.setMcpExecutions(prev => prev.map(e => (ids.has(e.id) ? settleRunningExecution(e, cutoff) : e)));
    }
}

/**
 * The Studio's send pipeline: slash commands → user bubble → Gemini stream → (local fallback) → commit.
 * An `AbortController` per send lets the stream be stopped by the user, replaced by a newer send, or
 * cancelled on unmount, so no state updates land on an unmounted Studio.
 */
export function useSendMessage(deps: SendMessageDeps): UseSendMessageResult {
    const depsRef = React.useRef<SendMessageDeps>(deps);
    depsRef.current = deps;
    const abortRef = React.useRef<AbortController | null>(null);
    /** Mirrors `abortRef` for rendering: true while a chat stream can be stopped. */
    const [streamInFlight, setStreamInFlight] = React.useState(false);
    /** Streams ended by the user's Stop (their partial reply is kept) rather than by a newer send or unmount. */
    const userStopsRef = React.useRef(new WeakSet<AbortSignal>());

    const abortInFlight = React.useCallback((byUser: boolean) => {
        const controller = abortRef.current;
        if (!controller) {
            return;
        }
        abortRef.current = null;
        setStreamInFlight(false);
        if (byUser) {
            userStopsRef.current.add(controller.signal);
        }
        controller.abort();
    }, []);

    const cancelInFlight = React.useCallback(() => abortInFlight(true), [abortInFlight]);

    React.useEffect(() => () => abortInFlight(false), [abortInFlight]);

    const sendMessage = React.useCallback(async (textToSend?: string, targetPrimitiveType?: PrimitiveType) => {
        const d = depsRef.current;
        const text = textToSend !== undefined ? textToSend : d.inputValue;
        if (!text.trim()) {
            return;
        }
        if (d.isGenerating) {
            abortInFlight(false);
            await new Promise(r => setTimeout(r, 60));
        }
        if (await handleSlashCommands(d, text)) {
            return;
        }

        abortInFlight(false);
        const controller = new AbortController();
        abortRef.current = controller;
        setStreamInFlight(true);
        const { signal } = controller;
        const releaseController = () => {
            if (abortRef.current === controller) {
                abortRef.current = null;
                setStreamInFlight(false);
            }
        };

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
        // Stop keeps what already streamed as the reply; no error or "server offline" notice is shown.
        const commitStoppedReply = () => {
            const latest = depsRef.current;
            // A staged build streamed into this turn is kept as stopped, in the reply and on the canvas alike.
            const artifact = markStagedRun(ctx.progress.artifact, 'stopped');
            const stopped = buildStoppedReply({ ...partialReplyFrom(ctx), artifact });
            settleGlobalExecutions(latest, ctx.progress, USER_STOP);
            commitAssistantMessage(latest, ctx, stopped, artifact);
        };
        const onAbort = () => {
            if (!userStopsRef.current.has(signal)) {
                settleGlobalExecutions(depsRef.current, ctx.progress, STREAM_CANCELLED);
                resetLiveState();
                return;
            }
            try {
                commitStoppedReply();
            } catch (err) {
                // Never leave the composer stuck in the generating state.
                console.error('[useSendMessage] Could not keep the stopped reply:', err);
                resetLiveState();
            }
        };
        signal.addEventListener('abort', onAbort, { once: true });

        try {
            const backend = await streamBackendResponse(depsRef.current, ctx, signal);
            if (signal.aborted) {
                return;
            }
            const finalAssistantMsg = buildFinalReply(depsRef.current, ctx, backend);
            signal.removeEventListener('abort', onAbort);
            commitAssistantMessage(depsRef.current, ctx, finalAssistantMsg, backend.generatedArtifact);
        } catch (err) {
            // Never leave the composer stuck in the generating state.
            console.error('[useSendMessage] Could not save the reply:', err);
            if (!signal.aborted) {
                signal.removeEventListener('abort', onAbort);
                settleGlobalExecutions(depsRef.current, ctx.progress, STREAM_FAILED);
                resetLiveState();
            }
        } finally {
            settleStagedRunInSession(depsRef.current, ctx.progress.artifact, 'interrupted');
            releaseController();
        }
    }, [abortInFlight]);

    return { sendMessage, cancelInFlight, streamInFlight };
}

/**
 * Step 4 — the reply for a stream that ran to its end: the model's answer, or, when the stream failed
 * or produced nothing usable, the failure notice below whatever had streamed. Either way the tool steps
 * and results that already arrived are kept (so the next turn knows which tools ran), and any tool card
 * still running is settled in the reply and in the Studio-wide list.
 */
function buildFinalReply(d: SendMessageDeps, ctx: GenerationContext, backend: BackendStreamResult): ChatMessage {
    if (backend.usedBackend) {
        // The model's artifact (or none) is final: no template is swapped in because of words in the prompt.
        settleGlobalExecutions(d, ctx.progress, STREAM_ENDED);
        return finalizeBackendMessage(d, ctx, backend);
    }
    if (backend.connectionError) {
        const failure = describeChatFailure(backend.failureKind || 'unreachable', backend.connectionError, backend.failureStatus);
        settleGlobalExecutions(d, ctx.progress, STREAM_FAILED);
        d.showToast(failure.toast, '⚠️');
        return buildFailedReply(partialReplyFrom(ctx), failure.text, STREAM_FAILED);
    }
    settleGlobalExecutions(d, ctx.progress, STREAM_ENDED);
    d.showToast(`Unable to reach AI model or data sources`, '⚠️');
    return buildFailedReply(
        partialReplyFrom(ctx),
        `⚠️ **Unable to Reach AI Model or Data Sources**\n\nThe AI model or backend generative services could not be reached to process your request. Offline fallbacks have been retired in accordance with our online architecture.\n\nPlease verify that the backend dev server is active (\`npm run dev\`) and that your network connection and API credentials are configured.`,
        STREAM_ENDED
    );
}
