/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The composer's model picker: which model this chat's agent runs on (Gemini, Claude or OpenAI). The choice is kept on
 * the chat (ChatSession.chatModel) and sent with each request; a provider without a key on the server is marked, and
 * a turn sent to it answers with a message saying which key is missing.
 */

import * as React from 'react';
import { CHAT_PROVIDER_LABEL, chatModelLabel, type ChatModelAvailability, type ChatProviderId } from '../../../common/chat-models';

export interface ModelPickerProps {
    /** The chat's model; empty for the server default. */
    value: string;
    onChange: (model: string) => void;
    models: ChatModelAvailability[];
    defaultModel?: string;
    disabled?: boolean;
}

const PROVIDER_ORDER: ChatProviderId[] = ['gemini', 'anthropic', 'openai'];

export const ModelPicker: React.FC<ModelPickerProps> = ({ value, onChange, models, defaultModel, disabled }) => {
    const current = value || defaultModel || '';
    const listed = models.some(m => m.id === current);
    const selected = models.find(m => m.id === current);
    const title = selected
        ? `${CHAT_PROVIDER_LABEL[selected.provider]}: ${selected.description}${selected.configured ? '' : ' (no API key configured on the server)'}`
        : 'The model this chat runs on';
    return (
        <select
            className="sb-composer-model-picker"
            aria-label="Chat model"
            data-testid="chat-model-picker"
            value={current}
            title={title}
            disabled={disabled}
            onChange={e => onChange(e.target.value)}
        >
            {!listed && current && <option value={current}>{chatModelLabel(current)}</option>}
            {PROVIDER_ORDER.map(provider => {
                const group = models.filter(m => m.provider === provider);
                if (group.length === 0) return null;
                const keyed = group[0].configured;
                return (
                    <optgroup key={provider} label={`${CHAT_PROVIDER_LABEL[provider]}${keyed ? '' : ' (no key)'}`}>
                        {group.map(m => (
                            <option key={m.id} value={m.id} title={m.description}>
                                {m.label}{m.configured ? '' : ' (no key)'}
                            </option>
                        ))}
                    </optgroup>
                );
            })}
        </select>
    );
};
