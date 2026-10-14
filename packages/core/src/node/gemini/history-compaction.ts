/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

export type HistoryMessage = { role: 'user' | 'model'; text: string };

/** Conversation sent verbatim while it fits (~100k tokens); older turns are summarized past that. */
export const HISTORY_VERBATIM_BUDGET_CHARS = 400_000;
/** Most recent messages always kept word for word when compacting. */
export const HISTORY_KEEP_RECENT = 12;

export type HistorySummarizer = (transcript: string) => Promise<string>;

/**
 * Keep the whole conversation while it fits the budget. Past that, summarize everything but the
 * most recent messages into a single leading turn, so long sessions keep their decisions and facts
 * without overflowing the model's context.
 */
export async function compactChatHistory(
    history: HistoryMessage[] | undefined,
    summarize: HistorySummarizer,
    budgetChars = HISTORY_VERBATIM_BUDGET_CHARS,
    keepRecent = HISTORY_KEEP_RECENT
): Promise<HistoryMessage[]> {
    const messages = (history || []).filter(m => m.text && m.text.trim());
    const total = messages.reduce((n, m) => n + m.text.length, 0);
    if (total <= budgetChars || messages.length <= keepRecent) {
        return messages;
    }

    const older = messages.slice(0, messages.length - keepRecent);
    const recent = messages.slice(messages.length - keepRecent);
    const transcript = older
        .map(m => `${m.role === 'model' ? 'ASSISTANT' : 'USER'}: ${m.text}`)
        .join('\n\n')
        .slice(-budgetChars);

    let summary: string;
    try {
        summary = (await summarize(transcript)).trim();
    } catch (err) {
        console.warn('[Gemini] History summarization failed; dropping older turns', err);
        summary = '';
    }

    const lead: HistoryMessage = {
        role: 'user',
        text: summary
            ? `[Summary of the earlier part of this conversation (${older.length} messages)]\n${summary}`
            : `[${older.length} earlier messages were dropped to fit the context window]`
    };
    return [lead, ...recent];
}

export const HISTORY_SUMMARY_INSTRUCTION = `Summarize this conversation between a user and an AI assistant so the assistant can continue the work without the full transcript. Keep: the user's goals and requirements, decisions made and why, facts established (file paths, names, numbers, parameters), what was built or changed, open problems, and anything the user said not to do. Drop pleasantries and repetition. Use terse bullet points.`;
