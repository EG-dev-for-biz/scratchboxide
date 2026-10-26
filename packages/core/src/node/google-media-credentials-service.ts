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
import { Storage, type StorageOptions } from '@google-cloud/storage';
import { SaveCredentialsResponse } from '../common/gemini-protocol';
import { FileKeyStore, KeyStore } from './key-store';
import { resolveVertexLocation } from './gemini/gemini-client';

const KEYCHAIN_SERVICE = 'scratchbox-ide.google-genai';
const KEYCHAIN_ACCOUNT = 'api-key';

const CREDENTIAL_ERROR_HINTS: Record<string, string> = {
    API_KEY_SERVICE_BLOCKED: 'This key is not allowed to call the Gemini API. Create a key at https://aistudio.google.com/apikey, or add "Generative Language API" to the key\'s API restrictions.',
    API_KEY_INVALID: 'Check that the full key was pasted.',
    IAM_PERMISSION_DENIED: 'Grant the service account the "Vertex AI User" role in this project.'
};

/** Turns a Google API or auth failure into a message a user can act on. */
export function describeGoogleCredentialError(err: unknown): string {
    const raw = err instanceof Error ? err.message : String(err);
    let message = raw;
    let hint = /invalid_grant/i.test(raw) ? 'Google rejected the service account key; it may have been deleted or revoked.' : '';
    const jsonStart = raw.indexOf('{');
    if (jsonStart >= 0) {
        try {
            const body = JSON.parse(raw.slice(jsonStart));
            const apiError = body?.error ?? body;
            if (typeof apiError?.message === 'string') {
                message = apiError.message;
            }
            const reason = (apiError?.details || []).map((d: any) => d?.reason).find((r: unknown) => typeof r === 'string');
            if (reason && CREDENTIAL_ERROR_HINTS[reason]) {
                hint = CREDENTIAL_ERROR_HINTS[reason];
            }
        } catch {
            // Not a JSON error body; keep the raw message
        }
    }
    return `Could not verify credentials with Google: ${message}${hint ? ` ${hint}` : ''}`;
}

const warnedCloudLocations = new Set<string>();

/**
 * GOOGLE_CLOUD_LOCATION no longer picks the Vertex region for chat or media (Gemini 3.x is served from the global
 * endpoint; us-central1 serves only gemini-2.5-flash-image). Say so once when it is set to something else, so a
 * deployment that relied on it for data residency finds SCRATCHBOX_VERTEX_LOCATION instead of being moved silently.
 */
function warnIfIgnoredCloudLocation(location: string): void {
    const legacy = process.env.GOOGLE_CLOUD_LOCATION?.trim();
    if (!legacy || legacy === location || warnedCloudLocations.has(`${legacy}>${location}`)) return;
    warnedCloudLocations.add(`${legacy}>${location}`);
    console.warn(`[Scratchbox] Vertex AI requests use location "${location}", not GOOGLE_CLOUD_LOCATION="${legacy}". Set SCRATCHBOX_VERTEX_LOCATION to choose the region.`);
}

export class GoogleMediaCredentialsService {
    protected readonly keyStore: KeyStore;

    constructor(keyStore?: KeyStore) {
        this.keyStore = keyStore || new FileKeyStore();
    }

    /**
     * Vertex AI first (user decision, 2026-10-22: the app's Google calls run on Vertex), whenever service-account or
     * project credentials are configured; a Gemini API key only where there are none.
     */
    async createClient(): Promise<GoogleGenAI> {
        if (this.hasVertexCredentials()) return this.createVertexClient();
        const apiKey = await this.getApiKey();
        if (apiKey) {
            return new GoogleGenAI({ apiKey });
        }
        return this.createVertexClient();
    }

    /** Whether Vertex AI credentials are configured: a service-account file, GOOGLE_SERVICE_ACCOUNT_JSON, or a project for ADC. */
    hasVertexCredentials(): boolean {
        return !!(this.findServiceAccountPath() || process.env.GOOGLE_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT);
    }

    /**
     * Vertex AI client from service-account or project credentials; never uses an API key. Defaults to the
     * same location as chat, since regional endpoints such as us-central1 serve only gemini-2.5-flash-image.
     */
    async createVertexClient(location: string = resolveVertexLocation()): Promise<GoogleGenAI> {
        warnIfIgnoredCloudLocation(location);
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

    /**
     * Auth options for Google Cloud Storage: a service-account file or GOOGLE_SERVICE_ACCOUNT_JSON
     * first (both carry a private key, required to mint v4 signed URLs), falling back to application
     * default credentials with GOOGLE_CLOUD_PROJECT (signing then needs the IAM signBlob role on a
     * metadata-attached service account, e.g. Cloud Run/GCE).
     */
    private resolveStorageOptions(): StorageOptions {
        const keyFile = this.findServiceAccountPath();
        if (keyFile) {
            return { keyFilename: keyFile };
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
                const credentials = typeof raw === 'string' ? JSON.parse(raw) : raw;
                if (credentials?.private_key) {
                    credentials.private_key = credentials.private_key.replace(/\\n/g, '\n');
                }
                if (credentials?.project_id) {
                    return { credentials, projectId: credentials.project_id };
                }
            } catch {
                // Ignore parse errors; fall through to ADC below.
            }
        }

        const projectId = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT;
        return projectId ? { projectId } : {};
    }

    /** Google Cloud Storage client for reading the private texture-library bucket and minting signed URLs. */
    createStorageClient(): Storage {
        return new Storage(this.resolveStorageOptions());
    }

    async saveApiKey(apiKey: string): Promise<SaveCredentialsResponse> {
        const trimmed = apiKey.trim();
        if (!/^(AIza[0-9A-Za-z_-]{20,}|AQ\.[0-9A-Za-z_-]{20,}|[0-9A-Za-z_.-]{20,})$/.test(trimmed)) {
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

    /** Proves a key against the live Gemini API; returns a user-facing error, or undefined when it works. */
    async verifyApiKey(apiKey: string, model: string): Promise<string | undefined> {
        return this.probeModel(new GoogleGenAI({ apiKey: apiKey.trim() }), model);
    }

    /** Proves a service account against Vertex AI; returns a user-facing error, or undefined when it works. */
    async verifyServiceAccount(credentialsRaw: string, model: string): Promise<string | undefined> {
        let parsed: any;
        try {
            parsed = JSON.parse(credentialsRaw);
        } catch {
            return 'Service account JSON could not be parsed';
        }
        if (!parsed.project_id || !parsed.private_key || !parsed.client_email) {
            return 'Service account JSON requires project_id, private_key, and client_email';
        }
        return this.probeModel(new GoogleGenAI({
            vertexai: true,
            project: parsed.project_id,
            location: resolveVertexLocation(),
            googleAuthOptions: { credentials: parsed, scopes: ['https://www.googleapis.com/auth/cloud-platform'] }
        }), model);
    }

    // countTokens is free and goes through the same auth, API enablement and IAM checks as generation.
    private async probeModel(client: GoogleGenAI, model: string): Promise<string | undefined> {
        try {
            await client.models.countTokens({ model, contents: 'ping' });
            return undefined;
        } catch (err) {
            return describeGoogleCredentialError(err);
        }
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
        if (envKey && /^(AIza[0-9A-Za-z_-]{20,}|AQ\.[0-9A-Za-z_-]{20,}|[0-9A-Za-z_.-]{20,})$/.test(envKey)) {
            return envKey;
        }
        const stored = await this.keyStore?.getPassword(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);
        if (stored && /^(AIza[0-9A-Za-z_-]{20,}|AQ\.[0-9A-Za-z_-]{20,}|[0-9A-Za-z_.-]{20,})$/.test(stored.trim())) {
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
