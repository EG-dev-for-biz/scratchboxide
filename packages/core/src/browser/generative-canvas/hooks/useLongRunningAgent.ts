/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * useLongRunningAgent
 *
 * Long-running agent session state (milestones/events) and the start/pause/resume/cancel handlers.
 *
 * Extracted verbatim from GenerativeCanvasStudio.tsx.
 */
import * as React from 'react';
import { AgentSessionState, AgentStepRecord, AgentStreamEvent } from '../../../common/agent-checkpoint-protocol';
import { AudioPlayer, GeminiClient } from '../gemini-client';

export function useLongRunningAgent() {
    // Long-Running Agent State & UI integration
    const [agentSession, setAgentSession] = React.useState<AgentSessionState | undefined>(undefined);
    const [agentEvents, setAgentEvents] = React.useState<AgentStreamEvent[]>([]);

    /**
     * Starts an autonomous run on the backend agent (POST /agent/session, then the /agent/stream events). The
     * milestones, steps and checkpoints shown are the backend's; when the backend cannot start or stream the run,
     * the session is shown as failed with its error (nothing is simulated in its place).
     */
    const handleStartAgent = async (goalText: string) => {
        const placeholderId = `agent-session-${Date.now()}`;
        setAgentSession({
            sessionId: placeholderId,
            goal: goalText,
            status: 'running',
            milestones: [],
            currentMilestoneIndex: 0,
            history: [],
            budget: { maxIterations: 15, maxDurationMs: 600000, usedIterations: 0, usedDurationMs: 0 },
            checkpoints: []
        });
        setAgentEvents([
            { type: 'agent_init', sessionId: placeholderId, timestamp: Date.now(), message: `Starting the agent for: "${goalText}"` }
        ]);

        try {
            const backendSession = await GeminiClient.getInstance().createAgentSession({
                goal: goalText,
                maxIterations: 15,
                maxDurationMs: 600000
            });
            if (!backendSession || !backendSession.sessionId) {
                throw new Error('the agent backend returned no session');
            }
            setAgentSession(backendSession);
            await GeminiClient.getInstance().streamAgentSession(backendSession.sessionId, rawEvent => {
                // The stream reports a failed loop as { type: 'error', error }.
                const raw = rawEvent as AgentStreamEvent & { error?: string };
                const event: AgentStreamEvent = (raw.type as string) === 'error'
                    ? { type: 'agent_error', sessionId: backendSession.sessionId, timestamp: Date.now(), message: `The agent failed: ${raw.error || 'unknown error'}` }
                    : raw;
                setAgentEvents(prev => [...prev, event]);
                if (event.type === 'milestone_complete') {
                    const desc = event.message ? event.message.replace('Successfully completed milestone:', '').trim() : 'Active milestone';
                    AudioPlayer.speak(`Successfully completed milestone: ${desc}`);
                } else if (event.type === 'agent_done') {
                    AudioPlayer.speak(`All milestones verified. Agent finished successfully!`);
                } else if (event.type === 'agent_error' || event.type === 'budget_exhausted') {
                    AudioPlayer.speak(`Milestone execution stalled. Incomplete criteria.`);
                }
                setAgentSession(current => {
                    if (!current) return current;
                    const updated = { ...current };
                    if (event.type === 'milestone_complete') {
                        updated.currentMilestoneIndex = Math.min(updated.currentMilestoneIndex + 1, updated.milestones.length);
                        if (updated.milestones[current.currentMilestoneIndex]) {
                            updated.milestones[current.currentMilestoneIndex].status = 'completed';
                        }
                    } else if (event.type === 'agent_done') {
                        updated.status = 'completed';
                    } else if (event.type === 'agent_error' || event.type === 'budget_exhausted') {
                        updated.status = 'failed';
                    }
                    return updated;
                });
            });
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            setAgentEvents(prev => [...prev, {
                type: 'agent_error',
                sessionId: placeholderId,
                timestamp: Date.now(),
                message: `The agent could not run: ${message}`
            }]);
            setAgentSession(current => current ? { ...current, status: 'failed' } : current);
        }
    };

    const handlePauseAgent = () => {
        setAgentSession(current => {
            if (!current) return current;
            GeminiClient.getInstance().sendAgentAction(current.sessionId, 'pause').catch(() => {});
            setAgentEvents(prev => [...prev, {
                type: 'step_failed',
                sessionId: current.sessionId,
                timestamp: Date.now(),
                message: 'Long-running agent execution paused by user'
            }]);
            return { ...current, status: 'paused' };
        });
    };

    const handleResumeAgent = () => {
        setAgentSession(current => {
            if (!current) return current;
            GeminiClient.getInstance().sendAgentAction(current.sessionId, 'resume').catch(() => {});
            setAgentEvents(prev => [...prev, {
                type: 'step_start',
                sessionId: current.sessionId,
                timestamp: Date.now(),
                message: 'Resumed agent loop execution'
            }]);
            return { ...current, status: 'running' };
        });
    };

    const handleCancelAgent = () => {
        setAgentSession(current => {
            if (!current) return current;
            GeminiClient.getInstance().sendAgentAction(current.sessionId, 'cancel').catch(() => {});
            setAgentEvents(prev => [...prev, {
                type: 'agent_error',
                sessionId: current.sessionId,
                timestamp: Date.now(),
                message: 'Execution stopped and session cancelled'
            }]);
            return { ...current, status: 'failed' };
        });
        setTimeout(() => {
            setAgentSession(undefined);
            setAgentEvents([]);
        }, 1500);
    };

    return { agentEvents, agentSession, handleCancelAgent, handlePauseAgent, handleResumeAgent, handleStartAgent };
}
