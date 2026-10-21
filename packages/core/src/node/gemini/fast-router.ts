/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/
import type { GeminiThinkingConfig } from './thinking-config';
import { thinkingConfigFor } from './thinking-config';

/**
 * The routing call: the first model call of a chat request, whose job is to choose and fill the first tool call (or
 * to answer). Which model routes is decided by this role, never by words in the request (AGENTS.md ADA 1.2).
 *
 * With a router configured, the first call is sent twice at once with the same system instruction, tools and
 * contents: to the router (a faster model, or the chat model at a lower thinking level) and to the chat model as
 * usual. Whichever decides first answers the call:
 *   - the router decides when its reply ends with a function call: that call runs and the chat model's request is
 *     cancelled;
 *   - the chat model decides when its first function call or reply text arrives before that, or when the router
 *     answers in text, fails or ends without a call (the router hands off).
 * Only the deciding stream reaches the chat; the other is discarded unseen. Every later call (after tool results)
 * goes to the chat model. The outcome (who routed, why) is logged and shown on the reply's provenance.
 *
 * SCRATCHBOX_CHAT_ROUTER selects the router: `off`, a Gemini model id, or `<model>@<LOW|MEDIUM|HIGH>` for a
 * thinking level. The default is chosen from the chat routing eval (docs/processes/fast_chat_routing.md).
 */
export const DEFAULT_CHAT_ROUTER = 'off';

export interface RouterConfig {
    model: string;
    thinkingConfig?: GeminiThinkingConfig;
    /** As configured, for logs ("gemini-3.8-flash", "gemini-4-argon@LOW"). */
    label: string;
}

/** The router for a chat model, or undefined when routing is off or the router would be the chat call itself. */
export function routerConfig(chatModel: string, setting: string | undefined = process.env.SCRATCHBOX_CHAT_ROUTER ?? DEFAULT_CHAT_ROUTER): RouterConfig | undefined {
    const value = (setting || '').trim();
    if (!value || value === 'off' || value === '0' || value === 'false') return undefined;
    const [model, level] = value.split('@');
    if (!/^gemini-[\w.-]+$/.test(model)) throw new Error(`SCRATCHBOX_CHAT_ROUTER must be "off", a Gemini model id or <model>@<LOW|MEDIUM|HIGH>; got "${value}"`);
    let thinkingConfig: GeminiThinkingConfig | undefined;
    if (level) {
        const upper = level.toUpperCase();
        if (upper !== 'LOW' && upper !== 'MEDIUM' && upper !== 'HIGH') throw new Error(`SCRATCHBOX_CHAT_ROUTER thinking level must be LOW, MEDIUM or HIGH; got "${level}"`);
        thinkingConfig = thinkingConfigFor(model, upper === 'LOW' ? 512 : upper === 'MEDIUM' ? 1024 : 4096);
    }
    if (model === chatModel && !thinkingConfig) return undefined;
    return { model, thinkingConfig, label: value };
}

/** What a streamed reply has shown so far. */
export interface StreamDecision {
    functionCalls: string[];
    /** Reply text (not thoughts) seen. */
    text: boolean;
}

/** Reads one SSE line of a streamGenerateContent reply into `seen`. */
export function noteSseLine(line: string, seen: StreamDecision): void {
    if (!line.startsWith('data:')) return;
    let chunk: any;
    try {
        chunk = JSON.parse(line.slice(5));
    } catch {
        return;
    }
    for (const cand of chunk?.candidates || []) {
        for (const part of cand?.content?.parts || []) {
            if (part?.functionCall) seen.functionCalls.push(String(part.functionCall.name || ''));
            else if (part?.text && !part.thought) seen.text = true;
        }
    }
}

export type RouteOutcome =
    | { decidedBy: 'router'; router: string; functionCalls: string[]; routerMs: number }
    | { decidedBy: 'chat'; router: string; reason: string; routerMs?: number };

/** One sentence for the reply's provenance and the [chat-turn] line. */
export function describeRouteOutcome(outcome: RouteOutcome, chatModel: string): string {
    return outcome.decidedBy === 'router'
        ? `${outcome.router} chose the first tool call (${outcome.functionCalls.join(', ')}) in ${(outcome.routerMs / 1000).toFixed(1)} s; ${chatModel} did the rest`
        : `${chatModel} answered the first call (router ${outcome.router}: ${outcome.reason})`;
}

/** A started streaming request: lines are delivered to `onLine` as they arrive. */
export type StartStream = (signal: AbortSignal, onLine: (line: string) => void) => Promise<void>;

/**
 * Runs the routing race described above. `handle(line, model)` receives the deciding stream's lines, buffered ones
 * first, in order; the chat model's stream stays live until it ends. Rejects with the chat model's error when the
 * chat model failed and the router did not decide.
 */
export async function raceRoutedCall(options: {
    router: RouterConfig;
    chatModel: string;
    startRouter: StartStream;
    startChat: StartStream;
    handle: (line: string, model: string) => void;
    signal?: AbortSignal;
    now?: () => number;
}): Promise<RouteOutcome> {
    const now = options.now ?? Date.now;
    const startedAt = now();
    const routerCtl = new AbortController();
    const chatCtl = new AbortController();
    const onAbort = () => { routerCtl.abort(); chatCtl.abort(); };
    options.signal?.addEventListener('abort', onAbort, { once: true });

    const routerLines: string[] = [];
    const routerSeen: StreamDecision = { functionCalls: [], text: false };
    const chatLines: string[] = [];
    const chatSeen: StreamDecision = { functionCalls: [], text: false };
    let chatLive = false;
    let winner: 'router' | 'chat' | undefined;
    let routerEnded = false;
    let routerError: unknown;
    let chatError: unknown;
    let chatEnded = false;
    let decide: () => void = () => undefined;
    const decided = new Promise<void>(resolve => { decide = resolve; });

    const evaluate = () => {
        if (winner) return;
        const routerHasCall = routerEnded && !routerError && routerSeen.functionCalls.length > 0;
        if (routerHasCall) { winner = 'router'; decide(); return; }
        const chatDecisive = chatSeen.functionCalls.length > 0 || chatSeen.text;
        // The chat model answers when it decides first, when the router is done without a call, or when the chat
        // stream ended (or failed) and the router has not produced a call either.
        if (chatDecisive || routerEnded || (chatEnded && routerEnded)) { winner = 'chat'; decide(); return; }
        if (chatEnded && chatError !== undefined && routerEnded) { winner = 'chat'; decide(); }
    };

    const routerRun = options.startRouter(routerCtl.signal, line => {
        if (winner === 'chat') return;
        routerLines.push(line);
        noteSseLine(line, routerSeen);
    }).then(
        () => { routerEnded = true; evaluate(); },
        err => { routerEnded = true; routerError = err; evaluate(); }
    );
    let routerMs: number | undefined;
    void routerRun.then(() => { routerMs = now() - startedAt; });

    const chatRun = options.startChat(chatCtl.signal, line => {
        if (winner === 'router') return;
        if (chatLive) { options.handle(line, options.chatModel); return; }
        chatLines.push(line);
        noteSseLine(line, chatSeen);
        evaluate();
    }).then(
        () => { chatEnded = true; evaluate(); },
        err => { chatEnded = true; chatError = err; evaluate(); }
    );

    try {
        await decided;
        if (winner === 'router') {
            chatCtl.abort();
            void chatRun;
            for (const line of routerLines) options.handle(line, options.router.model);
            return { decidedBy: 'router', router: options.router.label, functionCalls: [...routerSeen.functionCalls], routerMs: routerMs ?? now() - startedAt };
        }
        routerCtl.abort();
        const reason = routerError !== undefined
            ? `failed: ${routerError instanceof Error ? routerError.message : String(routerError)}`.slice(0, 300)
            : routerEnded
                ? (routerSeen.functionCalls.length === 0 ? (routerSeen.text ? 'answered in text, handed off' : 'ended without a call, handed off') : 'decided later')
                : 'the chat model decided first';
        // Replay what the chat model sent so far, then let the rest through as it arrives (one synchronous step, so
        // no line can arrive in between).
        for (const line of chatLines) options.handle(line, options.chatModel);
        chatLive = true;
        await chatRun;
        if (chatError !== undefined) throw chatError;
        return { decidedBy: 'chat', router: options.router.label, reason, ...(routerEnded && routerMs !== undefined ? { routerMs } : {}) };
    } finally {
        options.signal?.removeEventListener('abort', onAbort);
    }
}
