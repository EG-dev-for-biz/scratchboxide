/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * API keys for the chat's non-Google providers. A key saved in Settings > Models & AI (the encrypted key store)
 * comes first, then the process environment, which the server fills from ~/.scratchbox/secrets.json at startup
 * (SERVER_SECRET_ALLOWLIST). Keys stay on the server: nothing here returns one to the browser or logs it.
 */

import { FileKeyStore, type KeyStore } from '../key-store';
import type { ChatProviderId } from '../../common/chat-models';

export type KeyedProvider = Exclude<ChatProviderId, 'gemini'>;

export const PROVIDER_KEY_STORE: Record<KeyedProvider, { service: string; account: string; env: string[] }> = {
    anthropic: { service: 'scratchbox-ide.anthropic', account: 'api-key', env: ['ANTHROPIC_API_KEY'] },
    openai: { service: 'scratchbox-ide.openai', account: 'api-key', env: ['OPENAI_API_KEY'] }
};

export class ProviderCredentials {
    constructor(
        private readonly keyStore: Pick<KeyStore, 'getPassword' | 'setPassword' | 'deletePassword'> = new FileKeyStore(),
        private readonly env: NodeJS.ProcessEnv = process.env
    ) {}

    /** The provider's key, or undefined when none is configured. */
    async resolveKey(provider: KeyedProvider): Promise<string | undefined> {
        const slot = PROVIDER_KEY_STORE[provider];
        try {
            const saved = (await this.keyStore.getPassword(slot.service, slot.account))?.trim();
            if (saved) return saved;
        } catch {
            // An unreadable key store falls through to the environment.
        }
        for (const name of slot.env) {
            const value = this.env[name]?.trim();
            if (value) return value;
        }
        return undefined;
    }

    async isConfigured(provider: KeyedProvider): Promise<boolean> {
        return !!(await this.resolveKey(provider));
    }

    /** Saves the Settings key (an empty key clears it). Returns whether the provider still has a key. */
    async saveKey(provider: KeyedProvider, rawKey: string): Promise<{ configured: boolean }> {
        const slot = PROVIDER_KEY_STORE[provider];
        const key = (rawKey || '').trim();
        if (key) {
            await this.keyStore.setPassword(slot.service, slot.account, key);
        } else {
            await this.keyStore.deletePassword(slot.service, slot.account);
        }
        return { configured: await this.isConfigured(provider) };
    }
}

export function isKeyedProvider(value: unknown): value is KeyedProvider {
    return value === 'anthropic' || value === 'openai';
}
