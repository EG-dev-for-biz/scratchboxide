/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { GoogleGenAI } from '@google/genai';
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

        const keyFile = this.findServiceAccountPath();
        if (keyFile) {
            const credential = await fs.readJSON(keyFile);
            return new GoogleGenAI({
                vertexai: true,
                project: credential.project_id,
                location: process.env.GOOGLE_CLOUD_LOCATION || 'us-central1',
                googleAuthOptions: { keyFile }
            });
        }

        if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
            try {
                const credential = typeof process.env.GOOGLE_SERVICE_ACCOUNT_JSON === 'string'
                    ? JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON)
                    : process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
                if (credential?.project_id) {
                    return new GoogleGenAI({
                        vertexai: true,
                        project: credential.project_id,
                        location: process.env.GOOGLE_CLOUD_LOCATION || 'us-central1',
                        googleAuthOptions: {
                            credentials: credential,
                            projectId: credential.project_id
                        }
                    });
                }
            } catch {
                // Ignore parse errors
            }
        }

        const project = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT;
        if (project) {
            return new GoogleGenAI({
                vertexai: true,
                project,
                location: process.env.GOOGLE_CLOUD_LOCATION || 'us-central1'
            });
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
        if (process.env.GEMINI_API_KEY) {
            return process.env.GEMINI_API_KEY;
        }
        const stored = await this.keyStore?.getPassword(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);
        if (stored) {
            return stored;
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
