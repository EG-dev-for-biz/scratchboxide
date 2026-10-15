/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import type {
    AgentExecutionStep,
    CanvasArtifact,
    ChatMessage,
    ChatSession,
    ExecutionPlanCardData,
    GroundingMetadata,
    InteractiveQuestionCardData,
    McpExecutionState,
    StudioLayoutMode
} from '../canvas-types';
import type { ModelAnswerProvenance } from '../../../common/gemini-protocol';
import { substitutedModelNote } from '../../../common/media-generation-protocol';

/**
 * How a chat reply's tool steps look while a tool runs, and what becomes of the ones still running
 * when the stream ends early or fails, so no finished message keeps a spinner forever. Also how the
 * finished reply is saved to its session when the user has moved to another one meanwhile.
 */

/** Why steps were cut off: `label` prefixes the step title, `reason` becomes the tool call's summary. */
export interface StepCutoff {
    label: string;
    reason: string;
}

/** The user pressed Stop. */
export const USER_STOP: StepCutoff = { label: 'Stopped', reason: 'Stopped by the user before it finished' };
/** A newer message replaced the stream, or the chat closed. */
export const STREAM_CANCELLED: StepCutoff = { label: 'Cancelled', reason: 'Cancelled before it finished' };
/** The stream closed normally while a tool had not reported a result. */
export const STREAM_ENDED: StepCutoff = { label: 'Interrupted', reason: 'The reply ended before this tool reported a result' };
/** The stream failed (a model error, a dropped connection) while a tool had not reported a result. */
export const STREAM_FAILED: StepCutoff = { label: 'Failed', reason: 'The reply failed before this tool reported a result' };

/** Shown as the reply when Stop arrives before any text streamed. */
export const STOPPED_NOTE = 'Stopped.';

const isFinished = (status: string): boolean => status === 'completed' || status === 'failed';

/**
 * True for a "still running" report about a call whose card already finished. Progress reports come
 * from a timer on the server and can arrive after the result; they must not turn a finished card
 * back into a spinner.
 */
export function isLateProgressReport(known: ReadonlyArray<{ id: string; status: string }>, report: { id: string; status: string }): boolean {
    if (report.status !== 'running') {
        return false;
    }
    const existing = known.find(k => k.id === report.id);
    return !!existing && isFinished(existing.status);
}

/**
 * The step row for a tool call. While the tool runs, the server's `summaryResult` carries its latest
 * progress and elapsed seconds, so the title reads e.g. "Running render_scene: compiling (45s)".
 */
export function mcpExecutionToStep(exec: McpExecutionState): AgentExecutionStep {
    const toolName = exec.toolName || 'MCP Tool';
    const status: AgentExecutionStep['status'] = exec.status === 'completed' ? 'completed'
        : exec.status === 'failed' ? 'failed'
        : 'running';
    const progress = exec.summaryResult?.trim();
    const title = status === 'running'
        ? (progress ? `Running ${toolName}: ${progress}` : `Running ${toolName}`)
        : `Executed tool: ${toolName}`;
    return {
        id: exec.id || `mcp-step-${Date.now()}`,
        title,
        status,
        durationMs: exec.durationMs,
        durationFormatted: exec.durationMs ? `${exec.durationMs}ms` : undefined,
        details: exec.args ? JSON.stringify(exec.args, null, 2) : undefined,
        kind: 'tool'
    };
}

/**
 * Inserts or replaces (by id) a step, keeping its position so a running card updates in place. A late
 * "running" report for a step that already finished is ignored.
 */
export function upsertStep(steps: AgentExecutionStep[], step: AgentExecutionStep): AgentExecutionStep[] {
    if (isLateProgressReport(steps, step)) {
        return steps;
    }
    const idx = steps.findIndex(s => s.id === step.id);
    if (idx < 0) {
        return [...steps, step];
    }
    const next = [...steps];
    next[idx] = step;
    return next;
}

/**
 * The reply's own tool calls, in call order: a report replaces the card with the same id in place. A
 * late "running" report for a call that already finished is ignored.
 */
export function upsertExecution(execs: McpExecutionState[], exec: McpExecutionState): McpExecutionState[] {
    if (isLateProgressReport(execs, exec)) {
        return execs;
    }
    const idx = execs.findIndex(e => e.id === exec.id);
    if (idx < 0) {
        return [...execs, exec];
    }
    const next = [...execs];
    next[idx] = exec;
    return next;
}

/**
 * The Studio-wide tool list, newest report first. A late "running" report for a call that already
 * finished is ignored.
 */
export function recordExecution(list: McpExecutionState[], exec: McpExecutionState): McpExecutionState[] {
    if (isLateProgressReport(list, exec)) {
        return list;
    }
    return [exec, ...list.filter(e => e.id !== exec.id)];
}

/** A tool call that never reported back is marked failed, with the cutoff reason and its last progress. */
export function settleRunningExecution(exec: McpExecutionState, cutoff: StepCutoff): McpExecutionState {
    if (exec.status !== 'running') {
        return exec;
    }
    const lastProgress = exec.summaryResult?.trim();
    return {
        ...exec,
        status: 'failed',
        summaryResult: lastProgress ? `${cutoff.reason} (last progress: ${lastProgress})` : cutoff.reason,
        steps: (exec.steps || []).map(s => (s.status === 'running' ? { ...s, status: 'failed' as const } : s))
    };
}

/**
 * Steps still running when the stream ended: a tool step becomes failed "<label>: <tool>", an agent
 * checklist item goes back to pending (it did not finish), and any other step becomes failed
 * "<label>: <title>". Steps that already finished are kept as they are.
 */
export function settleRunningSteps(steps: AgentExecutionStep[], execs: McpExecutionState[], cutoff: StepCutoff): AgentExecutionStep[] {
    const toolNames = new Map(execs.map(e => [e.id, e.toolName]));
    return steps.map(step => {
        if (step.status !== 'running') {
            return step;
        }
        if (step.kind === 'task') {
            return { ...step, status: 'pending' };
        }
        const name = step.kind === 'tool'
            ? (toolNames.get(step.id) || /^Running (\S+?):?(?:\s|$)/.exec(step.title)?.[1] || step.title)
            : step.title;
        return { ...step, status: 'failed', title: `${cutoff.label}: ${name}`, durationFormatted: undefined };
    });
}

/** Whatever a reply had streamed when it was cut short. `text` is already cleaned for display. */
export interface PartialReply {
    text: string;
    thinkingText: string;
    thinkingDurationSeconds: number;
    steps: AgentExecutionStep[];
    execs: McpExecutionState[];
    artifact?: CanvasArtifact;
    groundingMetadata?: GroundingMetadata;
    questionCard?: InteractiveQuestionCardData;
    executionPlanCard?: ExecutionPlanCardData;
    /** Which model and credential had answered (when the stream said so): kept so a cut-short reply still shows it. */
    modelProvenance?: ModelAnswerProvenance;
    /** Which model made the media the reply's tools had already generated, when it was not the requested one. */
    mediaModelNote?: string;
}

/**
 * Adds a tool result's media-model note to `notes` (once): the note substitutedModelNote gives when the result says
 * a model other than the requested one produced its media, and why. A result from the requested model, or one that
 * names no model, adds nothing.
 */
export function recordMediaModelNote(notes: readonly string[], toolResult: unknown): string[] {
    const note = toolResult && typeof toolResult === 'object' ? substitutedModelNote(toolResult as Parameters<typeof substitutedModelNote>[0]) : undefined;
    return note && !notes.includes(note) ? [...notes, note] : [...notes];
}

/** The reply's media-model note: every distinct note its tool results recorded, or undefined when there is none. */
export function mediaModelNoteOf(notes: readonly string[]): string | undefined {
    return notes.length ? notes.join(' ') : undefined;
}

/**
 * The assistant message kept after Stop: the text, thinking and tool steps that already streamed, with
 * running tools marked stopped. When no text streamed it reads "Stopped." (an empty reply would
 * otherwise be shown as "Processing completed.").
 */
export function buildStoppedReply(partial: PartialReply, now: Date = new Date()): ChatMessage {
    return buildCutShortReply(partial, USER_STOP, partial.text.trim() ? partial.text : STOPPED_NOTE, now);
}

/**
 * The assistant message kept when the stream fails: the text, thinking, tool steps and tool results
 * that already streamed (so the next turn still knows which tools ran), with running tools settled by
 * `cutoff`, and the failure notice below any partial text.
 */
export function buildFailedReply(partial: PartialReply, notice: string, cutoff: StepCutoff = STREAM_FAILED, now: Date = new Date()): ChatMessage {
    const partialText = partial.text.trim();
    return buildCutShortReply(partial, cutoff, partialText ? `${partialText}\n\n${notice}` : notice, now);
}

function buildCutShortReply(partial: PartialReply, cutoff: StepCutoff, text: string, now: Date): ChatMessage {
    const execs = partial.execs.map(e => settleRunningExecution(e, cutoff));
    const steps = settleRunningSteps(partial.steps, partial.execs, cutoff);
    return {
        id: `msg-assistant-${now.getTime()}`,
        sender: 'assistant',
        text,
        timestamp: now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        artifacts: partial.artifact ? [partial.artifact] : undefined,
        mcpExecutions: execs.length > 0 ? execs : undefined,
        groundingMetadata: partial.groundingMetadata,
        thinkingText: partial.thinkingText || undefined,
        thinkingDurationSeconds: partial.thinkingText ? partial.thinkingDurationSeconds : undefined,
        steps: steps.length > 0 ? steps : undefined,
        questionCard: partial.questionCard,
        executionPlanCard: partial.executionPlanCard,
        modelProvenance: partial.modelProvenance,
        mediaModelNote: partial.mediaModelNote
    };
}

/** The canvas part of a session record: what the session shows when the user opens it. */
export interface SessionCanvas {
    activeArtifact?: CanvasArtifact;
    artifactHistory: CanvasArtifact[];
    layoutMode: StudioLayoutMode;
}

/**
 * The canvas saved with a finished reply. When the reply's session is the one on screen, the Studio's
 * live artifact history and layout are its own; when the user has moved to another session, those
 * belong to that other session, so the reply's session keeps its stored history and layout and only
 * gains the reply's own artifact.
 */
export function committedSessionCanvas(opts: {
    /** The reply's session is the one the user is viewing. */
    targetVisible: boolean;
    /** The Studio's live artifact history and layout (the visible session's). */
    visible: { artifactHistory: CanvasArtifact[]; layoutMode?: StudioLayoutMode };
    /** The reply's session as stored, if it exists yet. */
    stored?: Pick<ChatSession, 'activeArtifact' | 'artifactHistory' | 'layoutMode'>;
    /** The artifact this reply produced, and the layout that shows it. */
    finalArtifact?: CanvasArtifact;
    finalArtifactMode?: StudioLayoutMode;
}): SessionCanvas {
    const { targetVisible, visible, stored, finalArtifact, finalArtifactMode } = opts;
    const baseHistory = targetVisible ? visible.artifactHistory : (stored?.artifactHistory || []);
    return {
        activeArtifact: finalArtifact || stored?.activeArtifact,
        artifactHistory: finalArtifact ? [finalArtifact, ...baseHistory.filter(a => a.id !== finalArtifact.id)] : baseHistory,
        layoutMode: (finalArtifact && finalArtifactMode)
            || stored?.layoutMode
            || (targetVisible ? visible.layoutMode : undefined)
            || 'chat'
    };
}
