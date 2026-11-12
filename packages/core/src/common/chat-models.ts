/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The models the chat agent can run on, and which provider serves each. The chat's agent loop (tools, cards,
 * verification, artifacts) is the same on every provider; only the model call differs (node/chat-agent/).
 * Image, video and vision tools keep their own Google services whatever the chat runs on.
 */

export type ChatProviderId = 'gemini' | 'anthropic' | 'openai';

export interface ChatModelOption {
    id: string;
    provider: ChatProviderId;
    /** Short name shown in the composer's picker. */
    label: string;
    /** One line on what it is for (the picker's tooltip). */
    description: string;
}

export const CHAT_PROVIDER_LABEL: Record<ChatProviderId, string> = {
    gemini: 'Google Gemini',
    anthropic: 'Anthropic Claude',
    openai: 'OpenAI'
};

/** Where a provider's key comes from (named in the "no key" message). */
export const CHAT_PROVIDER_KEY_HINT: Record<ChatProviderId, string> = {
    gemini: 'a Google Cloud service account or GEMINI_API_KEY',
    anthropic: 'ANTHROPIC_API_KEY',
    openai: 'OPENAI_API_KEY'
};

/**
 * The picker's list. Ids checked against each provider's model catalogue on 2026-11-11 (Anthropic's current models;
 * OpenAI's API model list, whose gpt-6-astra is also Codex's top model). Any other id of a provider still runs: the
 * provider is read from the id (providerForChatModel).
 */
export const CHAT_MODEL_OPTIONS: ChatModelOption[] = [
    { id: 'gemini-4-argon', provider: 'gemini', label: 'Gemini 4 Argon', description: 'Google flagship reasoning model (the default)' },
    { id: 'gemini-3.8-flash', provider: 'gemini', label: 'Gemini 3.8 Flash', description: 'Google fast reasoning model' },
    { id: 'claude-opus-5-5', provider: 'anthropic', label: 'Claude Opus 5.5', description: 'Anthropic flagship for agentic coding and long tool loops' },
    { id: 'claude-sonnet-5-5', provider: 'anthropic', label: 'Claude Sonnet 5.5', description: 'Anthropic speed and capability for everyday agent work' },
    { id: 'claude-fable-5-2', provider: 'anthropic', label: 'Claude Fable 5.2', description: 'Anthropic most capable model (higher price)' },
    { id: 'claude-haiku-5-5', provider: 'anthropic', label: 'Claude Haiku 5.5', description: 'Anthropic fastest, lowest-cost model' },
    { id: 'gpt-6-astra', provider: 'openai', label: 'GPT-6 Astra', description: 'OpenAI flagship for complex reasoning and coding (Codex top model)' },
    { id: 'gpt-6.1-sol', provider: 'openai', label: 'GPT-6.1 Sol', description: 'OpenAI balance of intelligence and cost' },
    { id: 'gpt-6.1-terra', provider: 'openai', label: 'GPT-6.1 Terra', description: 'OpenAI fast and efficient' }
];

/** The provider that serves a model id, read from the id's vendor prefix; Gemini for anything else (the server default). */
export function providerForChatModel(model: string | undefined): ChatProviderId {
    const id = (model || '').trim().toLowerCase();
    const listed = CHAT_MODEL_OPTIONS.find(m => m.id === id);
    if (listed) return listed.provider;
    if (id.startsWith('claude-')) return 'anthropic';
    if (id.startsWith('gpt-') || id.startsWith('codex-') || /^o\d/.test(id)) return 'openai';
    return 'gemini';
}

/** The picker's label for a model id (the id itself when it is not listed). */
export function chatModelLabel(model: string): string {
    return CHAT_MODEL_OPTIONS.find(m => m.id === model)?.label || model;
}

/** What the server tells the picker: each model and whether its provider has a key here (never the key). */
export interface ChatModelAvailability extends ChatModelOption {
    configured: boolean;
}
