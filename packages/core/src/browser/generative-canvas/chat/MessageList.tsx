/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as React from 'react';
import { AgentExecutionStep, ChatMessage } from '../canvas-types';
import { CanvasErrorBoundary } from '../CanvasErrorBoundary';
import {
    AgentExecutionStepper,
    ChatMarkdownRenderer,
    StreamingCursor,
    ThinkingDisclosure,
    cleanMessageTextSmart
} from '../ChatMarkdownRenderer';
import { useStudioActions } from '../state/StudioContext';
import { MessageItem } from './MessageItem';

export interface StreamingAssistantBubbleProps {
    liveThinkingText: string;
    liveThinkingSeconds: number;
    liveSteps: AgentExecutionStep[];
    liveStreamedText: string;
}

/** The in-progress assistant bubble shown while a response is streaming. */
export const StreamingAssistantBubble: React.FC<StreamingAssistantBubbleProps> = ({
    liveThinkingText,
    liveThinkingSeconds,
    liveSteps,
    liveStreamedText
}) => {
    const { handleOpenInAppBrowser, handlePreviewCodeInCanvas } = useStudioActions();
    return (
    <CanvasErrorBoundary compact fallbackTitle="Streaming Assistant Notice">
        <div className="sb-drawer-msg-row sb-msg-assistant-row animate-fadeIn">
            <div className="sb-chat-bubble-content">
                <div className="sb-bubble-header">
                    <span className="sb-bubble-sender">Scratchbox AI</span>
                    <span className="sb-bubble-time">Just now</span>
                </div>
                {(liveThinkingText || liveThinkingSeconds > 0) ? (
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
                {liveStreamedText ? (
                    <div style={{ position: 'relative' }}>
                        <ChatMarkdownRenderer
                            text={cleanMessageTextSmart(liveStreamedText)}
                            className="sb-bubble-text"
                            isStreaming={true}
                            onOpenInBrowser={handleOpenInAppBrowser}
                            onPreviewInCanvas={handlePreviewCodeInCanvas}
                        />
                        <StreamingCursor />
                    </div>
                ) : !liveThinkingText && (!liveSteps || liveSteps.length === 0) ? (
                    <div className="sb-ide-msg-thinking animate-pulse" style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 0', fontSize: '13px', color: 'var(--sb-cadence-medium, #8e8e93)' }}>
                        <span className="animate-spin" style={{ color: '#3b82f6' }}>○</span>
                        <span>Reasoning and synthesizing response...</span>
                        <StreamingCursor />
                    </div>
                ) : null}
            </div>
        </div>
    </CanvasErrorBoundary>
    );
};

export interface MessageListProps extends StreamingAssistantBubbleProps {
    messages: ChatMessage[];
    isGenerating: boolean;
    activeArtifactId: string | undefined;
    activeArtifactVersion: number | undefined;
    checkpointFeedback: Record<string, string>;
    messagesEndRef: React.RefObject<HTMLDivElement>;
    className?: string;
    style?: React.CSSProperties;
}

/** Scrollable chat stream: memoized message bubbles, the live streaming bubble and the scroll anchor. */
export const MessageList: React.FC<MessageListProps> = ({
    messages,
    isGenerating,
    activeArtifactId,
    activeArtifactVersion,
    checkpointFeedback,
    messagesEndRef,
    className,
    style,
    liveThinkingText,
    liveThinkingSeconds,
    liveSteps,
    liveStreamedText
}) => (
    <div className={className} style={style}>
        {messages.map(msg => (
            <MessageItem
                key={msg.id}
                message={msg}
                activeArtifactId={activeArtifactId}
                activeArtifactVersion={activeArtifactVersion}
                checkpointFeedbackValue={checkpointFeedback[msg.id] || ''}
            />
        ))}

        {isGenerating && (
            <StreamingAssistantBubble
                liveThinkingText={liveThinkingText}
                liveThinkingSeconds={liveThinkingSeconds}
                liveSteps={liveSteps}
                liveStreamedText={liveStreamedText}
            />
        )}
        <div ref={messagesEndRef} />
    </div>
);
