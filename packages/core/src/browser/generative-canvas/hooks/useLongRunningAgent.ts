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

    const handleStartAgent = async (goalText: string) => {
        const sessionId = `agent-session-${Date.now()}`;
        const initialSession: AgentSessionState = {
            sessionId,
            goal: goalText,
            status: 'running',
            milestones: [
                { id: 'm1', description: 'Deconstruct workspace AST patterns', status: 'pending', acceptanceCriteria: 'All file endpoints indexed' },
                { id: 'm2', description: 'Apply localized sandboxing patch', status: 'pending', acceptanceCriteria: 'Sandbox processes initialized' },
                { id: 'm3', description: 'Execute strict verification suite', status: 'pending', acceptanceCriteria: 'Yarn test returns exit code 0' }
            ],
            currentMilestoneIndex: 0,
            history: [],
            budget: {
                maxIterations: 15,
                maxDurationMs: 600000,
                usedIterations: 0,
                usedDurationMs: 0
            },
            checkpoints: []
        };

        setAgentSession(initialSession);
        setAgentEvents([
            { type: 'agent_init', sessionId, timestamp: Date.now(), message: `Initialized autonomous loop for: "${goalText}"` }
        ]);

        let usedBackend = false;
        try {
            const backendSession = await GeminiClient.getInstance().createAgentSession({
                goal: goalText,
                maxIterations: 15,
                maxDurationMs: 600000
            });
            if (backendSession && backendSession.sessionId) {
                usedBackend = true;
                setAgentSession(backendSession);
                await GeminiClient.getInstance().streamAgentSession(backendSession.sessionId, event => {
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
                return;
            }
        } catch {
            // Fallback to local simulation runner
        }

        if (!usedBackend) {
            let iteration = 0;
            let milestoneIdx = 0;
            const startTime = Date.now();

            const runNextStep = () => {
                setAgentSession(current => {
                    if (!current || current.status !== 'running') return current;

                    iteration++;
                    const elapsed = Date.now() - startTime;

                    if (iteration > current.budget.maxIterations || elapsed > current.budget.maxDurationMs) {
                        setAgentEvents(prev => [...prev, {
                            type: 'budget_exhausted',
                            sessionId,
                            timestamp: Date.now(),
                            message: 'Execution budget exceeded limits'
                        }]);
                        AudioPlayer.speak(`Milestone execution stalled. Incomplete criteria.`);
                        return { ...current, status: 'failed' };
                    }

                    const updatedMilestones = [...current.milestones];
                    const activeMilestone = updatedMilestones[milestoneIdx];

                    if (!activeMilestone) {
                        setAgentEvents(prev => [...prev, {
                            type: 'agent_done',
                            sessionId,
                            timestamp: Date.now(),
                            message: 'All milestones verified. Agent finished successfully!'
                        }]);
                        AudioPlayer.speak(`All milestones verified. Agent finished successfully!`);
                        return { ...current, status: 'completed' };
                    }

                    activeMilestone.status = 'in_progress';

                    const stepRecord: AgentStepRecord = {
                        stepNumber: iteration,
                        description: `Step ${iteration}: Validating logic boundaries for ${activeMilestone.description}`,
                        status: 'success',
                        timestamp: Date.now(),
                        actionType: 'patch_files',
                        filesModified: ['src/core.ts']
                    };

                    const eventType = iteration % 2 === 0 ? 'step_complete' : 'checkpoint_saved';
                    const messageText = iteration % 2 === 0
                        ? `Successfully verified test boundaries for: ${activeMilestone.description}`
                        : `Saved checkpoint: chk-${iteration}`;

                    setAgentEvents(prev => [...prev, {
                        type: eventType as any,
                        sessionId,
                        timestamp: Date.now(),
                        message: messageText
                    }]);

                    if (iteration % 3 === 0) {
                        activeMilestone.status = 'completed';
                        setAgentEvents(prev => [...prev, {
                            type: 'milestone_complete',
                            sessionId,
                            timestamp: Date.now(),
                            message: `Successfully completed milestone: ${activeMilestone.description}`
                        }]);
                        AudioPlayer.speak(`Successfully completed milestone: ${activeMilestone.description}`);
                        milestoneIdx++;
                    }

                    return {
                        ...current,
                        milestones: updatedMilestones,
                        currentMilestoneIndex: milestoneIdx,
                        history: [...current.history, stepRecord],
                        budget: {
                            ...current.budget,
                            usedIterations: iteration,
                            usedDurationMs: elapsed
                        }
                    };
                });

                setAgentSession(current => {
                    if (current && current.status === 'running') {
                        setTimeout(runNextStep, 2200);
                    }
                    return current;
                });
            };

            setTimeout(runNextStep, 1200);
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
