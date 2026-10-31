/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * A refusal from the 3D/VFX product gate (common/product-scope.ts), said in the chat as a local assistant note. Toasts
 * are not shown in this app, so a refusal sent to one fails silently.
 */
import type { ChatMessage } from '../canvas-types';

let noteSequence = 0;

export function scopeNote(text: string): ChatMessage {
    return {
        id: `msg-scope-${Date.now()}-${noteSequence++}`,
        sender: 'assistant',
        text,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };
}

/** Adds the note after the chat's messages. */
export function postScopeNote(setMessages: (update: (prev: ChatMessage[]) => ChatMessage[]) => void, text: string): void {
    setMessages(prev => [...prev, scopeNote(text)]);
}
