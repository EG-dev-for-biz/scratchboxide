/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * useDeepWritePipeline
 *
 * Deep-write (multi-section document) pipeline: plan → checkpoint → resume, writing progress into the chat store.
 *
 * Extracted verbatim from GenerativeCanvasStudio.tsx.
 */
import * as React from 'react';
import { ChatState, ChatStore } from '../state/chatStore';
import { ProjectItem } from '../ProjectsModal';
import { CanvasArtifact, ChatMessage } from '../canvas-types';

export interface UseDeepWritePipelineDeps {
    activeArtifact: ChatState['activeArtifact'];
    activeWorkspace: ProjectItem;
    artifactHistory: ChatState['artifactHistory'];
    currentSessionId: ChatState['currentSessionId'];
    setActiveArtifact: ChatStore['setActiveArtifact'];
    setCurrentSessionId: ChatStore['setCurrentSessionId'];
    setIsGenerating: React.Dispatch<React.SetStateAction<boolean>>;
    setMessages: ChatStore['setMessages'];
    setSessions: ChatStore['setSessions'];
}

export function useDeepWritePipeline(deps: UseDeepWritePipelineDeps) {
    const { activeArtifact, activeWorkspace, artifactHistory, currentSessionId, setActiveArtifact, setCurrentSessionId, setIsGenerating, setMessages, setSessions } = deps;

    const executeDeepWritePipeline = async (promptText: string, planOverride?: any) => {
        setIsGenerating(true);
        const targetSessionId = currentSessionId || `session-chat-${Date.now()}`;
        if (!currentSessionId) {
            setCurrentSessionId(targetSessionId);
        }

        const userMsg: ChatMessage = {
            id: `msg-user-${Date.now()}`,
            sender: 'user',
            text: promptText,
            timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        };

        const asstMsgId = `msg-asst-${Date.now()}`;
        const asstMsg: ChatMessage = {
            id: asstMsgId,
            sender: 'assistant',
            text: 'Strategic Meta-Architect formulating comprehensive project blueprints...',
            timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            isStreaming: true
        };

        setMessages(prev => [...prev, userMsg, asstMsg]);

        try {
            const res = await fetch('/gemini/deep-write/pipeline', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    prompt: promptText,
                    sessionId: targetSessionId,
                    workspaceRoot: activeWorkspace?.path,
                    activeArtifact
                })
            });

            if (!res.body) throw new Error('No stream body received from backend.');

            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';

                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        const eventData = JSON.parse(line.substring(6));
                        
                        setMessages(prev => prev.map(m => {
                            if (m.id !== asstMsgId) return m;

                            if (eventData.type === 'goal_analyzed') {
                                return {
                                    ...m,
                                    text: 'Formulated custom project plan and stages based on user memories & goal preferences.',
                                    deepWriteOffer: true,
                                    deepWritePlan: eventData.plan
                                };
                            }

                            if (eventData.type === 'stage_start' || eventData.type === 'stage_complete' || eventData.type === 'research_thinking' || eventData.type === 'research_query_sent' || eventData.type === 'execution_output') {
                                return {
                                    ...m,
                                    text: eventData.message || 'Executing stage...',
                                    deepWriteOffer: false,
                                    deepWriteProgress: eventData
                                };
                            }

                            if (eventData.type === 'checkpoint_paused') {
                                return {
                                    ...m,
                                    text: 'Pipeline paused at checkpoint. Review intermediate results and submit steering feedback.',
                                    deepWriteOffer: false,
                                    deepWriteCheckpoint: eventData.checkpoint
                                };
                            }

                            if (eventData.type === 'pipeline_complete') {
                                // Spawning the compiled artifacts dynamically onto the canvas!
                                if (eventData.bundle && eventData.bundle.artifacts) {
                                    const primaryArtifact = eventData.bundle.artifacts[0];
                                    if (primaryArtifact) {
                                        const canvasArt: CanvasArtifact = {
                                            id: `art-dw-${Date.now()}`,
                                            type: primaryArtifact.type,
                                            title: primaryArtifact.title,
                                            summary: eventData.bundle.summary,
                                            version: 1,
                                            createdAt: new Date().toLocaleTimeString(),
                                            data: primaryArtifact.data
                                        };
                                        setActiveArtifact(canvasArt);
                                        setSessions(prevSess => prevSess.map(s => {
                                            if (s.id !== targetSessionId) return s;
                                            return {
                                                ...s,
                                                activeArtifact: canvasArt,
                                                artifactHistory: [canvasArt, ...(s.artifactHistory || [])],
                                                updatedAt: 'Just now'
                                            };
                                        }));
                                    }
                                }

                                return {
                                    ...m,
                                    text: eventData.message || 'Pipeline completed successfully.',
                                    deepWriteOffer: false,
                                    deepWriteProgress: eventData,
                                    isStreaming: false
                                };
                            }

                            if (eventData.type === 'error') {
                                return {
                                    ...m,
                                    text: `Deep-Write error: ${eventData.error}`,
                                    deepWriteProgress: eventData,
                                    isStreaming: false
                                };
                            }

                            return m;
                        }));
                    }
                }
            }
        } catch (err: any) {
            console.error('[GenerativeCanvasStudio] Deep-write stream failed:', err);
            setMessages(prev => prev.map(m => {
                if (m.id !== asstMsgId) return m;
                return {
                    ...m,
                    text: `Fatal execution error: ${err.message || err}`,
                    isStreaming: false
                };
            }));
        } finally {
            setIsGenerating(false);
        }
    };

    const handleDeepWriteResume = async (sessionId: string, feedback: string) => {
        try {
            await fetch('/gemini/deep-write/resume', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    sessionId,
                    feedback,
                    workspaceRoot: activeWorkspace?.path
                })
            });
        } catch (err) {
            console.error('[GenerativeCanvasStudio] Failed to resume pipeline:', err);
        }
    };

    return { executeDeepWritePipeline, handleDeepWriteResume };
}
