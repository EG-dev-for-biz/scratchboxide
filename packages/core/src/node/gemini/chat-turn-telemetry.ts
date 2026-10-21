/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Timing and size of each model call in a chat turn, logged as one `[chat-turn]` line: when the request was sent,
 * its first streamed byte, its first complete functionCall part and the end of the stream (all in ms from the moment
 * the turn reached the server), the usage the model reported (prompt, cached, thought and reply tokens), and the size
 * of what was sent (system instruction, tool declarations, contents). These are measurements of the request as it
 * ran; nothing here is estimated.
 */

export interface ChatTurnUsage {
    promptTokenCount?: number;
    cachedContentTokenCount?: number;
    thoughtsTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
}

export interface ChatTurnShape {
    /** Characters of the system instruction sent (0 when an explicit cache holds it). */
    systemChars: number;
    /** Characters of the static prefix of the system instruction (byte-identical across turns of one workspace). */
    staticSystemChars: number;
    /** Characters of per-request context moved out of the system instruction into the contents. */
    turnContextChars: number;
    /** Function declarations offered and their JSON size. */
    toolCount: number;
    toolBytes: number;
    /** JSON size of the contents (history, the request and its context). */
    contentsBytes: number;
    /** The explicit context cache the call referenced, if any. */
    cachedContent?: string;
}

export interface ChatTurnRecord extends ChatTurnShape {
    model: string;
    /** 1 for the first model call of the turn, 2 for the call after the first tool results, ... */
    call: number;
    /** What this call was for: 'route' (choose the first tool or answer) or 'continue' (after tool results). */
    role: 'route' | 'continue';
    thinking: string;
    /** ms from the turn reaching the server to the request being sent (payload building, history compaction). */
    sentMs: number;
    firstByteMs?: number;
    firstFunctionCallMs?: number;
    /** ms from the turn reaching the server to the first tool starting (set when one ran in this call). */
    toolStartMs?: number;
    endMs?: number;
    functionCalls: string[];
    usage?: ChatTurnUsage;
    finishReason?: string;
    /** When another model routed the turn: which, and why the chat model took over (see fast-router.ts). */
    routedBy?: string;
}

/** Collects one model call's timings; `log()` prints the `[chat-turn]` line. */
export class ChatTurnTimer {
    private readonly record: ChatTurnRecord;

    constructor(
        private readonly turnStartedAt: number,
        init: Omit<ChatTurnRecord, 'sentMs' | 'functionCalls'>,
        private readonly now: () => number = Date.now
    ) {
        this.record = { ...init, sentMs: this.now() - turnStartedAt, functionCalls: [] };
    }

    private elapsed(): number {
        return this.now() - this.turnStartedAt;
    }

    sent(): void {
        this.record.sentMs = this.elapsed();
    }

    firstByte(): void {
        if (this.record.firstByteMs === undefined) this.record.firstByteMs = this.elapsed();
    }

    functionCall(name: string): void {
        if (this.record.firstFunctionCallMs === undefined) this.record.firstFunctionCallMs = this.elapsed();
        this.record.functionCalls.push(name);
    }

    toolStarted(): void {
        if (this.record.toolStartMs === undefined) this.record.toolStartMs = this.elapsed();
    }

    usage(usage: ChatTurnUsage | undefined, finishReason?: string): void {
        if (usage) {
            this.record.usage = {
                promptTokenCount: usage.promptTokenCount,
                cachedContentTokenCount: usage.cachedContentTokenCount ?? 0,
                thoughtsTokenCount: usage.thoughtsTokenCount ?? 0,
                candidatesTokenCount: usage.candidatesTokenCount ?? 0,
                totalTokenCount: usage.totalTokenCount
            };
        }
        if (finishReason) this.record.finishReason = finishReason;
    }

    end(): ChatTurnRecord {
        if (this.record.endMs === undefined) this.record.endMs = this.elapsed();
        return this.record;
    }

    snapshot(): ChatTurnRecord {
        return { ...this.record, functionCalls: [...this.record.functionCalls] };
    }

    log(sink: (line: string) => void = line => console.log(line)): ChatTurnRecord {
        const r = this.end();
        sink(`[chat-turn] ${JSON.stringify(r)}`);
        return r;
    }
}
