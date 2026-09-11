/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { GoogleAuth, type GoogleAuthOptions } from 'google-auth-library';
import { GoogleGenAI, type Content, type GenerateContentResponseUsageMetadata } from '@google/genai';
import type { GeminiGenerateRequest, GeminiStatus, GroundingMetadata } from '../../common/gemini-protocol';
import { FileKeyStore, type KeyStore } from '../key-store';

export const DEFAULT_GEMINI_MODEL = 'gemini-3.7-flash';
export const FALLBACK_GEMINI_MODELS = ['gemini-2.5-flash', 'gemini-2.5-pro'];

export const DEFAULT_SUBAGENT_MODEL = 'gemini-3.5-flash-lite';
export const FALLBACK_SUBAGENT_MODELS = ['gemini-3.1-flash-lite-preview', 'gemini-3.1-flash-lite', 'gemini-2.5-flash'];

export const DEFAULT_THINKING_BUDGET = 1024;
export const VERTEX_LOCATION = 'us-central1';

const GOOGLE_AUTH_SCOPES = [
    'https://www.googleapis.com/auth/cloud-platform',
    'https://www.googleapis.com/auth/generative-language'
];

/** Shape of the fields we read from a Google service-account JSON file. */
export interface ServiceAccountJson {
    project_id: string;
    private_key: string;
    client_email?: string;
    [key: string]: unknown;
}

export interface GeminiClientOptions {
    /** Explicit service-account file candidates; defaults to the well-known Scratchbox locations. */
    serviceAccountCandidatePaths?: string[];
    defaultModel?: string;
    fallbackModels?: string[];
    defaultSubagentModel?: string;
    fallbackSubagentModels?: string[];
    thinkingBudget?: number;
    /** Credential store used for API-key lookup; defaults to `FileKeyStore`. */
    keyStore?: KeyStore;
    /** Retries for transient (429/5xx/network) failures inside `withModelFallback`. */
    transientRetries?: number;
    /** Base delay for exponential backoff between transient retries. */
    retryBaseDelayMs?: number;
}

export interface ModelFallbackOptions {
    /** Called with the model that succeeded so callers can remember it as preferred. */
    onSuccess?: (model: string) => void;
    /** Error message when every candidate failed without a concrete error. */
    exhaustedMessage?: string;
    /**
     * Retry transient failures with backoff. Disable for streaming calls where partial
     * output may already have been emitted to the caller.
     */
    retryTransient?: boolean;
}

export interface AccessTokenResult {
    token: string;
    projectId: string;
}

export type FetchLike = (input: string, init?: Record<string, unknown>) => Promise<{
    ok: boolean;
    status: number;
    text(): Promise<string>;
    json(): Promise<unknown>;
    body?: unknown;
}>;

/** Vertex AI `generateContent` / SSE chunk JSON as returned by the REST endpoint. */
export interface VertexGenerateContentJson {
    id?: string;
    candidates?: Array<{
        content?: Content;
        groundingMetadata?: GroundingMetadata;
        finishReason?: string;
    }>;
    groundingMetadata?: GroundingMetadata;
    usageMetadata?: GenerateContentResponseUsageMetadata;
}

export const KEY_STORE_SERVICE = 'scratchbox-ide';
export const KEY_STORE_GEMINI_ACCOUNT = 'gemini-api-key';

export function isServiceAccountJson(value: unknown): value is ServiceAccountJson {
    return !!value
        && typeof value === 'object'
        && typeof (value as ServiceAccountJson).project_id === 'string'
        && typeof (value as ServiceAccountJson).private_key === 'string';
}

export function maskEmail(email: string): string {
    const parts = email.split('@');
    if (parts.length !== 2) return email;
    const prefix = parts[0];
    const masked = prefix.length > 4 ? `${prefix.slice(0, 3)}***${prefix.slice(-2)}` : '***';
    return `${masked}@${parts[1]}`;
}

export function errorMessage(err: unknown): string {
    if (err instanceof Error) return err.message;
    if (typeof err === 'string') return err;
    return String(err);
}

/** Vertex returns 404 for unknown model ids; we advance to the next fallback candidate in that case. */
export function isModelNotFoundError(err: unknown): boolean {
    const message = errorMessage(err);
    return message.includes('404') || message.includes('not found');
}

/** Transient upstream failures that are worth one or two backoff retries. */
export function isTransientError(err: unknown): boolean {
    const message = errorMessage(err);
    return /\b(429|500|502|503|504)\b|ECONNRESET|ETIMEDOUT|EAI_AGAIN|overloaded|RESOURCE_EXHAUSTED|UNAVAILABLE/i.test(message);
}

/** Resolve the global fetch implementation (Node 18+) with a node-fetch fallback. */
export function resolveFetch(): FetchLike {
    const globalFetch = (globalThis as { fetch?: unknown }).fetch;
    if (typeof globalFetch === 'function') {
        return globalFetch as FetchLike;
    }
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('node-fetch') as FetchLike;
}

export function defaultServiceAccountCandidatePaths(): string[] {
    return [
        process.env.GOOGLE_APPLICATION_CREDENTIALS,
        process.env.GEMINI_SERVICE_ACCOUNT_PATH,
        path.join(os.homedir(), '.scratchbox/service-account.json'),
        path.join(os.homedir(), '.scratchbox-ide/service-account.json'),
        path.join(process.cwd(), 'service-account.json'),
        path.join(process.cwd(), '.scratchbox-ide/service-account.json'),
        path.join(process.cwd(), '.scratchbox/service-account.json')
    ].filter((p): p is string => typeof p === 'string' && p.length > 0);
}

/**
 * Owns Google Cloud authentication, model selection/fallback, thinking-budget config,
 * and retry/backoff for the Gemini/Vertex AI surface. It has no knowledge of prompts,
 * tools or artifacts; higher-level modules compose it.
 */
export class GeminiClient {
    auth?: GoogleAuth;
    cachedServiceAccountPath?: string;
    cachedProjectId?: string;
    cachedClientEmail?: string;
    preferredModel: string;
    preferredSubagentModel: string;

    readonly defaultModel: string;
    readonly fallbackModels: string[];
    readonly defaultSubagentModel: string;
    readonly fallbackSubagentModels: string[];
    readonly thinkingBudget: number;

    private readonly candidatePaths?: string[];
    private readonly keyStore: KeyStore;
    private readonly transientRetries: number;
    private readonly retryBaseDelayMs: number;
    private genAiClient?: GoogleGenAI;
    private genAiClientKey?: string;

    constructor(options: GeminiClientOptions = {}) {
        this.defaultModel = options.defaultModel || DEFAULT_GEMINI_MODEL;
        this.fallbackModels = options.fallbackModels || FALLBACK_GEMINI_MODELS;
        this.defaultSubagentModel = options.defaultSubagentModel || DEFAULT_SUBAGENT_MODEL;
        this.fallbackSubagentModels = options.fallbackSubagentModels || FALLBACK_SUBAGENT_MODELS;
        this.thinkingBudget = options.thinkingBudget ?? DEFAULT_THINKING_BUDGET;
        this.preferredModel = this.defaultModel;
        this.preferredSubagentModel = this.defaultSubagentModel;
        this.candidatePaths = options.serviceAccountCandidatePaths;
        this.keyStore = options.keyStore || new FileKeyStore();
        this.transientRetries = options.transientRetries ?? 1;
        this.retryBaseDelayMs = options.retryBaseDelayMs ?? 300;
        this.initAuth();
    }

    // ------------------------------------------------------------------
    // Authentication
    // ------------------------------------------------------------------

    /**
     * Discover Google Cloud service-account credentials from well-known locations
     * (`GOOGLE_APPLICATION_CREDENTIALS`, `~/.scratchbox`, `~/.scratchbox-ide`, `<cwd>`)
     * or from the inline `GOOGLE_SERVICE_ACCOUNT_JSON` environment variable.
     */
    initAuth(): void {
        const candidatePaths = this.candidatePaths || defaultServiceAccountCandidatePaths();

        for (const credPath of candidatePaths) {
            try {
                if (!fs.existsSync(credPath)) continue;
                const content: unknown = fs.readJSONSync(credPath);
                if (isServiceAccountJson(content)) {
                    this.applyServiceAccount(content, credPath);
                    break;
                }
            } catch {
                // Continue checking next candidate path
            }
        }

        if (!this.auth && process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
            try {
                const content: unknown = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
                if (isServiceAccountJson(content)) {
                    this.cachedProjectId = content.project_id;
                    this.cachedClientEmail = content.client_email;
                    this.auth = new GoogleAuth({
                        credentials: content as GoogleAuthOptions['credentials'],
                        projectId: content.project_id,
                        scopes: GOOGLE_AUTH_SCOPES
                    });
                }
            } catch {
                // Ignore parse errors
            }
        }
    }

    /** Point the client at a service-account key file that has just been written to disk. */
    applyServiceAccount(content: ServiceAccountJson, keyFile: string): void {
        this.cachedServiceAccountPath = keyFile;
        this.cachedProjectId = content.project_id;
        this.cachedClientEmail = content.client_email;
        this.auth = new GoogleAuth({
            keyFile,
            projectId: content.project_id,
            scopes: GOOGLE_AUTH_SCOPES
        });
    }

    isAuthenticated(): boolean {
        return !!this.auth && !!this.cachedProjectId;
    }

    /** Re-run discovery when credentials are missing, then return whether we are authenticated. */
    ensureAuth(): boolean {
        if (!this.auth || !this.cachedProjectId) {
            this.initAuth();
        }
        return this.isAuthenticated();
    }

    /** Obtain a bearer token for Vertex AI REST calls. Throws when unauthenticated. */
    async getAccessToken(): Promise<AccessTokenResult> {
        if (!this.ensureAuth() || !this.auth || !this.cachedProjectId) {
            throw new Error('Google Cloud service account is not authenticated.');
        }
        const client = await this.auth.getClient();
        const tokenResponse = await client.getAccessToken();
        const token = tokenResponse.token;
        if (!token) {
            throw new Error('Could not obtain Google Cloud access token.');
        }
        return { token, projectId: this.cachedProjectId };
    }

    /** Resolve a Gemini API key from the environment or the encrypted credential store. */
    async resolveApiKey(): Promise<string | undefined> {
        const fromEnv = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
        if (fromEnv && fromEnv.trim()) {
            return fromEnv.trim();
        }
        try {
            return await this.keyStore.getPassword(KEY_STORE_SERVICE, KEY_STORE_GEMINI_ACCOUNT);
        } catch {
            return undefined;
        }
    }

    /**
     * Lazily construct a `@google/genai` client. Prefers Vertex AI with the discovered
     * service account; falls back to an API key when one is available.
     */
    async getGenAIClient(): Promise<GoogleGenAI | undefined> {
        if (this.ensureAuth() && this.cachedProjectId && this.auth) {
            const cacheKey = `vertex:${this.cachedProjectId}:${this.cachedServiceAccountPath || 'inline'}`;
            if (!this.genAiClient || this.genAiClientKey !== cacheKey) {
                this.genAiClient = new GoogleGenAI({
                    vertexai: true,
                    project: this.cachedProjectId,
                    location: VERTEX_LOCATION,
                    googleAuthOptions: this.cachedServiceAccountPath
                        ? { keyFile: this.cachedServiceAccountPath, scopes: GOOGLE_AUTH_SCOPES }
                        : undefined
                });
                this.genAiClientKey = cacheKey;
            }
            return this.genAiClient;
        }

        const apiKey = await this.resolveApiKey();
        if (!apiKey) {
            return undefined;
        }
        const cacheKey = `api-key:${apiKey.slice(-6)}`;
        if (!this.genAiClient || this.genAiClientKey !== cacheKey) {
            this.genAiClient = new GoogleGenAI({ apiKey });
            this.genAiClientKey = cacheKey;
        }
        return this.genAiClient;
    }

    /** Real-time connection status, including model inventory and masked identity. */
    async getStatus(): Promise<GeminiStatus> {
        if (!this.auth || !this.cachedServiceAccountPath) {
            this.initAuth();
        }

        const base = {
            activeModel: this.preferredModel,
            availableModels: this.getModelCandidates(),
            subagentModel: this.preferredSubagentModel,
            availableSubagentModels: this.getSubagentModelCandidates(),
            thinkingBudget: this.thinkingBudget
        };

        if (!this.auth) {
            return {
                connected: false,
                ...base,
                authMethod: 'unauthenticated',
                error: 'No Google Cloud service account credentials found. Set GOOGLE_APPLICATION_CREDENTIALS or place service-account.json under ~/.scratchbox-ide/'
            };
        }

        const identity = {
            serviceAccount: this.cachedClientEmail ? maskEmail(this.cachedClientEmail) : undefined,
            projectId: this.cachedProjectId
        };

        try {
            const client = await this.auth.getClient();
            const token = await client.getAccessToken();
            const hasToken = !!(token && token.token);
            return {
                connected: hasToken,
                ...identity,
                ...base,
                authMethod: 'service-account',
                error: hasToken ? undefined : 'Failed to retrieve access token from Google Cloud'
            };
        } catch (err: unknown) {
            return {
                connected: false,
                ...identity,
                ...base,
                authMethod: 'service-account',
                error: errorMessage(err) || 'Authentication error'
            };
        }
    }

    // ------------------------------------------------------------------
    // Model selection & generation config
    // ------------------------------------------------------------------

    getModelCandidates(requestedModel?: string): string[] {
        return dedupe([requestedModel || this.preferredModel, ...this.fallbackModels]);
    }

    getSubagentModelCandidates(requestedModel?: string): string[] {
        return dedupe([requestedModel || this.preferredSubagentModel, ...this.fallbackSubagentModels]);
    }

    /** Thinking-budget config for a request, honouring per-request overrides. */
    getThinkingConfig(request: Pick<GeminiGenerateRequest, 'thinkingBudget'>): { thinkingBudget: number } {
        return { thinkingBudget: request.thinkingBudget !== undefined ? request.thinkingBudget : this.thinkingBudget };
    }

    vertexModelUrl(projectId: string, model: string, method: 'streamGenerateContent' | 'generateContent'): string {
        const suffix = method === 'streamGenerateContent' ? '?alt=sse' : '';
        return `https://${VERTEX_LOCATION}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${VERTEX_LOCATION}/publishers/google/models/${model}:${method}${suffix}`;
    }

    vertexAgentUrl(projectId: string, agent: string): string {
        return `https://${VERTEX_LOCATION}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${VERTEX_LOCATION}/publishers/google/agents/${agent}:interact?alt=sse`;
    }

    // ------------------------------------------------------------------
    // Retry / fallback
    // ------------------------------------------------------------------

    /**
     * Try each candidate model in order. Unknown-model (404) errors advance to the next
     * candidate; transient errors are retried with exponential backoff; anything else throws.
     * `onSuccess` lets callers remember the model that worked.
     */
    async withModelFallback<T>(
        candidates: string[],
        attempt: (model: string) => Promise<T>,
        options: ModelFallbackOptions = {}
    ): Promise<T> {
        const { onSuccess, exhaustedMessage = 'Failed to generate with available AI models', retryTransient = true } = options;
        let lastError: unknown;
        for (const model of candidates) {
            try {
                const result = retryTransient
                    ? await this.withTransientRetry(() => attempt(model))
                    : await attempt(model);
                onSuccess?.(model);
                return result;
            } catch (err: unknown) {
                lastError = err;
                if (isModelNotFoundError(err)) {
                    continue;
                }
                throw err;
            }
        }
        throw lastError ?? new Error(exhaustedMessage);
    }

    async withTransientRetry<T>(fn: () => Promise<T>): Promise<T> {
        let attemptIndex = 0;
        for (;;) {
            try {
                return await fn();
            } catch (err: unknown) {
                if (attemptIndex >= this.transientRetries || !isTransientError(err) || isModelNotFoundError(err)) {
                    throw err;
                }
                const delay = this.retryBaseDelayMs * Math.pow(2, attemptIndex);
                attemptIndex++;
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }
}

function dedupe(values: string[]): string[] {
    return values.filter((val, idx, arr) => arr.indexOf(val) === idx);
}
