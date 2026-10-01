/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { GoogleGenAI, type GoogleGenAIOptions } from '@google/genai';
import { SaveCredentialsResponse } from '../common/gemini-protocol';
import { FileKeyStore, KeyStore } from './key-store';

const KEYCHAIN_SERVICE = 'scratchbox-ide.google-genai';
const KEYCHAIN_ACCOUNT = 'api-key';

export class GoogleMediaCredentialsService {
    protected readonly keyStore: KeyStore;

    constructor(keyStore?: KeyStore) {
        this.keyStore = keyStore || new FileKeyStore();
    }

    async createClient(): Promise<GoogleGenAI> {
        const apiKey = await this.getApiKey();
        if (apiKey) {
            return new GoogleGenAI({ apiKey });
        }
        return this.createVertexClient();
    }

    /** Vertex AI client from service-account or project credentials; never uses an API key. */
    async createVertexClient(location: string = process.env.GOOGLE_CLOUD_LOCATION || 'us-central1'): Promise<GoogleGenAI> {
        const auth = await this.getVertexAuth();
        return new GoogleGenAI({
            vertexai: true,
            project: auth.project,
            location,
            ...(auth.googleAuthOptions ? { googleAuthOptions: auth.googleAuthOptions } : {})
        });
    }

    /**
     * Project and auth options for Vertex AI: a service-account file, GOOGLE_SERVICE_ACCOUNT_JSON, or
     * application default credentials with GOOGLE_CLOUD_PROJECT.
     */
    async getVertexAuth(): Promise<{ project: string; googleAuthOptions?: GoogleGenAIOptions['googleAuthOptions'] }> {
        const keyFile = this.findServiceAccountPath();
        if (keyFile) {
            const credential = await fs.readJSON(keyFile);
            return { project: credential.project_id, googleAuthOptions: { keyFile } };
        }

        if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
            try {
                let raw = typeof process.env.GOOGLE_SERVICE_ACCOUNT_JSON === 'string'
                    ? process.env.GOOGLE_SERVICE_ACCOUNT_JSON.trim()
                    : process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
                if (typeof raw === 'string') {
                    if ((raw.startsWith("'") && raw.endsWith("'")) || (raw.startsWith('"') && raw.endsWith('"'))) {
                        raw = raw.slice(1, -1);
                    }
                    raw = raw.replace(/\\\\\"/g, '"');
                }
                const credential = typeof raw === 'string' ? JSON.parse(raw) : raw;
                if (credential?.private_key) {
                    credential.private_key = credential.private_key.replace(/\\n/g, '\n');
                }
                if (credential?.project_id) {
                    return {
                        project: credential.project_id,
                        googleAuthOptions: { credentials: credential, projectId: credential.project_id }
                    };
                }
            } catch {
                // Ignore parse errors
            }
        }

        const project = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT;
        if (project) {
            return { project };
        }
        throw Object.assign(new Error('Google media credentials are not configured'), { status: 401 });
    }

    async saveApiKey(apiKey: string): Promise<SaveCredentialsResponse> {
        const trimmed = apiKey.trim();
        if (!/^AIza[0-9A-Za-z_-]{20,}$/.test(trimmed)) {
            return {
                success: false,
                authMethod: 'unauthenticated',
                error: 'Invalid Gemini API key format'
            };
        }
        if (!this.keyStore) {
            return {
                success: false,
                authMethod: 'unauthenticated',
                error: 'OS credential storage is unavailable; use the GEMINI_API_KEY environment variable'
            };
        }
        await this.keyStore.setPassword(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT, trimmed);
        await this.removeLegacyPlaintextKey();
        return { success: true, authMethod: 'api-key' };
    }

    async saveServiceAccount(credentialsRaw: string, targetPath?: string): Promise<SaveCredentialsResponse> {
        try {
            const parsed = JSON.parse(credentialsRaw);
            if (!parsed.project_id || !parsed.private_key || !parsed.client_email) {
                throw new Error('Service account JSON requires project_id, private_key, and client_email');
            }
            const destination = path.resolve(targetPath || path.join(os.homedir(), '.scratchbox-ide', 'service-account.json'));
            await fs.ensureDir(path.dirname(destination));
            await fs.writeJSON(destination, parsed, { spaces: 2, mode: 0o600 });
            await fs.chmod(destination, 0o600);
            return {
                success: true,
                authMethod: 'service-account',
                projectId: parsed.project_id,
                serviceAccount: this.maskEmail(parsed.client_email),
                savedPath: destination
            };
        } catch (error: any) {
            return {
                success: false,
                authMethod: 'unauthenticated',
                error: error.message || 'Failed to save service account credentials'
            };
        }
    }

    private async getApiKey(): Promise<string | undefined> {
        const envKey = (process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_API_KEY)?.trim();
        if (envKey && /^AIza[0-9A-Za-z_-]{20,}$/.test(envKey)) {
            return envKey;
        }
        const stored = await this.keyStore?.getPassword(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);
        if (stored && /^AIza[0-9A-Za-z_-]{20,}$/.test(stored.trim())) {
            return stored.trim();
        }
        return this.migrateLegacyPlaintextKey();
    }

    private async migrateLegacyPlaintextKey(): Promise<string | undefined> {
        if (!this.keyStore) {
            return undefined;
        }
        const configPath = path.join(os.homedir(), '.scratchbox-ide', 'config.json');
        if (!await fs.pathExists(configPath)) {
            return undefined;
        }
        try {
            const config = await fs.readJSON(configPath);
            const apiKey = typeof config.apiKey === 'string' ? config.apiKey : undefined;
            if (!apiKey) {
                return undefined;
            }
            await this.keyStore.setPassword(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT, apiKey);
            delete config.apiKey;
            await fs.writeJSON(configPath, config, { spaces: 2, mode: 0o600 });
            return apiKey;
        } catch {
            return undefined;
        }
    }

    private async removeLegacyPlaintextKey(): Promise<void> {
        const configPath = path.join(os.homedir(), '.scratchbox-ide', 'config.json');
        if (!await fs.pathExists(configPath)) {
            return;
        }
        const config = await fs.readJSON(configPath);
        if (config.apiKey) {
            delete config.apiKey;
            await fs.writeJSON(configPath, config, { spaces: 2, mode: 0o600 });
        }
    }

    private findServiceAccountPath(): string | undefined {
        const candidates = [
            process.env.GOOGLE_APPLICATION_CREDENTIALS,
            process.env.GEMINI_SERVICE_ACCOUNT_PATH,
            path.join(process.cwd(), 'service-account.json'),
            path.join(process.cwd(), '.scratchbox-ide', 'service-account.json'),
            path.join(os.homedir(), '.scratchbox-ide', 'service-account.json'),
            path.join(os.homedir(), 'service-account.json')
        ].filter(Boolean) as string[];
        return candidates.find(candidate => fs.existsSync(candidate));
    }

    private maskEmail(email: string): string {
        const [name, domain] = email.split('@');
        if (!domain) {
            return '***';
        }
        return `${name.slice(0, 2)}***@${domain}`;
    }
}
