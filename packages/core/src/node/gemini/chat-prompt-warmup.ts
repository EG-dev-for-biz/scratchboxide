/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Warms the chat's first-call payload once the server is listening, so the first chat turn after a restart does not pay
 * for it. Measured before this (docs/processes/fast_chat_routing.md, `[chat-turn]` payloadMs): 0.4-1.2 s on the first turn
 * after a restart and 3.4 s on a brand-new dev server, against 30-600 ms warm, spent in the first run of the prompt
 * builder (the tool catalogue's declarations, the skill, knowledge and memory sections) and the workspace pattern scan
 * (`analyzeWorkspacePatterns`, cached per workspace).
 *
 * The warm-up builds the same payload a first agent-mode turn builds, for the server's default workspace root (the one
 * the renderer resolves when no workspace is open: process.cwd()), and throws the result away. No model is called and
 * nothing is sent. It is started without being awaited after the API server's listen callback (the standalone server and
 * the Electron main process), beside the native warm-up, so the listen is never delayed; a failure is logged and nothing is
 * thrown. SCRATCHBOX_CHAT_WARMUP=0 turns it off.
 */

import type { GeminiGenerateRequest } from '../../common/gemini-protocol';

export interface ChatPromptWarmupReport {
    /** Time the build took (ms). */
    ms: number;
    workspaceRoot: string;
    /** The system instruction's size and the tools declared, as the first turn would send them. */
    systemChars: number;
    toolCount: number;
    /** Set when the warm-up did not run (switched off) or failed. */
    skipped?: string;
    error?: string;
}

export interface ChatPromptWarmupOptions {
    workspaceRoot?: string;
    log?: (message: string) => void;
    now?: () => number;
    env?: NodeJS.ProcessEnv;
}

/** The request the warm-up builds the payload for: a first agent turn at the workspace root, with nothing attached. */
export function chatWarmupRequest(workspaceRoot: string): GeminiGenerateRequest {
    return { prompt: 'warm-up (no model call)', mode: 'agent', workspaceRoot, chatHistory: [] };
}

/**
 * Builds the first-call payload once through `build` and reports its time and shape. Never rejects; meant to be started
 * without awaiting it (`void warmChatPrompt(...)`).
 */
export async function warmChatPrompt(
    build: (request: GeminiGenerateRequest) => Promise<{ shape: { systemChars: number; toolCount: number } }>,
    options: ChatPromptWarmupOptions = {}
): Promise<ChatPromptWarmupReport> {
    const log = options.log ?? ((m: string) => console.log(m));
    const now = options.now ?? Date.now;
    const env = options.env ?? process.env;
    const workspaceRoot = options.workspaceRoot ?? process.cwd();
    if (env.SCRATCHBOX_CHAT_WARMUP === '0') {
        log('[chat warm-up] off (SCRATCHBOX_CHAT_WARMUP=0)');
        return { ms: 0, workspaceRoot, systemChars: 0, toolCount: 0, skipped: 'SCRATCHBOX_CHAT_WARMUP=0' };
    }
    const started = now();
    try {
        const built = await build(chatWarmupRequest(workspaceRoot));
        const ms = now() - started;
        log(`[chat warm-up] first-call payload ready in ${(ms / 1000).toFixed(2)} s (system ${built.shape.systemChars.toLocaleString('en-US')} chars, ${built.shape.toolCount} tools; workspace ${workspaceRoot})`);
        return { ms, workspaceRoot, systemChars: built.shape.systemChars, toolCount: built.shape.toolCount };
    } catch (err) {
        const ms = now() - started;
        const error = err instanceof Error ? err.message : String(err);
        log(`[chat warm-up] failed after ${(ms / 1000).toFixed(2)} s: ${error.slice(0, 400)}`);
        return { ms, workspaceRoot, systemChars: 0, toolCount: 0, error };
    }
}
