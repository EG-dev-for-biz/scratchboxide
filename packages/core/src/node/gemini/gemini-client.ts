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
import { GoogleAuth, type GoogleAuthOptions } from 'google-auth-library';
import { GoogleGenAI, type Content, type GenerateContentResponseUsageMetadata } from '@google/genai';
import type { GeminiGenerateRequest, GeminiStatus, GroundingMetadata } from '../../common/gemini-protocol';
import { FileKeyStore, type KeyStore } from '../key-store';

export const DEFAULT_GEMINI_MODEL = 'gemini-4-argon';
export const FALLBACK_GEMINI_MODELS = ['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-2.5-flash', 'gemini-2.5-pro'];

export const DEFAULT_SUBAGENT_MODEL = 'gemini-3.5-flash-lite';
export const FALLBACK_SUBAGENT_MODELS = ['gemini-3.1-flash-lite-preview', 'gemini-3.1-flash-lite', 'gemini-2.5-flash'];

export const DEFAULT_THINKING_BUDGET = 1024;

export type GeminiThinkingConfig = { thinkingBudget: number } | { thinkingLevel: 'LOW' | 'MEDIUM' | 'HIGH' };
/** Gemini 3.x publisher models are served only from the `global` location; regional endpoints 404. */
export const VERTEX_LOCATION = 'global';

export function resolveVertexLocation(): string {
    return process.env.SCRATCHBOX_VERTEX_LOCATION?.trim() || VERTEX_LOCATION;
}

export function vertexHost(location: string): string {
    return location === 'global' ? 'aiplatform.googleapis.com' : `${location}-aiplatform.googleapis.com`;
}

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
    /** Called with the model that succeeded. */
    onSuccess?: (model: string) => void;
    /**
     * Called when a candidate is not served and the next one will be tried, so callers can say which model
     * answered instead and why (the fallback is never silent).
     */
    onFallback?: (skippedModel: string, reason: string, nextModel: string) => void;
    /** Error message when every candidate failed without a concrete error. */
    exhaustedMessage?: string;
    /**
     * Retry transient failures with backoff. Disable for streaming calls where partial
     * output may already have been emitted to the caller.
     */
    retryTransient?: boolean;
    /** Whether a model-not-found error may still move on to the next candidate (default: always). */
    canFallback?: (err: unknown) => boolean;
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

/**
 * Which credential answered a request. The Gemini API key answers when no service account is configured, or when one
 * is configured but cannot issue a token; the second case is a credential fallback, so `credentialNote` says why.
 */
export interface CredentialAnswer {
    credential: 'vertex' | 'api-key';
    credentialNote?: string;
}

/** Key-store slot shared with `GeminiService.saveCredentialsDirectly`. */
export const KEY_STORE_SERVICE = 'scratchbox-ide.google-genai';
export const KEY_STORE_GEMINI_ACCOUNT = 'api-key';

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

/** A one-line reason for a model error, short enough to show on a chat message ("404: model not found"). */
export function summarizeModelError(err: unknown): string {
    const message = errorMessage(err).replace(/\s+/g, ' ').trim();
    const inner = /"message"\s*:\s*"([^"]+)"/.exec(message)?.[1];
    const status = /\((\d{3})\)/.exec(message)?.[1] ?? /\b(404|403|401|400|429|5\d\d)\b/.exec(message)?.[1];
    const text = inner || message;
    const clipped = text.length > 160 ? `${text.slice(0, 157)}...` : text;
    return status && !clipped.includes(status) ? `${status}: ${clipped}` : clipped;
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
     
    try {
        return require('node-fetch') as FetchLike;
    } catch {
        throw new Error('No global fetch or node-fetch available.');
    }
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
        this.genAiClient = undefined;
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
        const fromEnv = process.env.GEMINI_API_KEY
            || process.env.GOOGLE_AI_API_KEY
            || process.env.GOOGLE_GENAI_API_KEY
            || process.env.GOOGLE_API_KEY;
        if (fromEnv && fromEnv.trim()) {
            return fromEnv.trim();
        }
        try {
            const stored = await this.keyStore.getPassword(KEY_STORE_SERVICE, KEY_STORE_GEMINI_ACCOUNT);
            if (stored && stored.trim()) {
                return stored.trim();
            }
        } catch {
            // Key store lookup failed
        }
        try {
            const candidatePaths = [
                path.resolve(process.cwd(), 'secrets.json'),
                path.resolve(__dirname, '../../secrets.json'),
                path.resolve(__dirname, '../../../secrets.json'),
                path.join(os.homedir(), '.scratchbox', 'secrets.json'),
                path.join(os.homedir(), '.scratchbox-ide', 'config.json')
            ];
            for (const p of candidatePaths) {
                if (fs.existsSync(p)) {
                    const sec = fs.readJSONSync(p);
                    const k = sec.GEMINI_API_KEY || sec.GOOGLE_AI_API_KEY || sec.GOOGLE_GENAI_API_KEY || sec.GOOGLE_API_KEY || sec.apiKey;
                    if (k && typeof k === 'string' && k.trim()) {
                        return k.trim();
                    }
                }
            }
        } catch {
            // Ignore filesystem lookup errors
        }
        return undefined;
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
                    location: resolveVertexLocation(),
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

        const checkApiKeyFallback = async (previousError?: string): Promise<GeminiStatus> => {
            const apiKey = await this.resolveApiKey();
            if (apiKey) {
                return {
                    connected: true,
                    ...base,
                    authMethod: 'api-key',
                    error: undefined
                };
            }
            return {
                connected: false,
                ...base,
                authMethod: 'unauthenticated',
                error: previousError || 'No Google Cloud service account or Gemini API key configured.'
            };
        };

        if (!this.auth) {
            return checkApiKeyFallback('No Google Cloud service account credentials found. Set GOOGLE_APPLICATION_CREDENTIALS or place service-account.json under ~/.scratchbox-ide/');
        }

        const identity = {
            serviceAccount: this.cachedClientEmail ? maskEmail(this.cachedClientEmail) : undefined,
            projectId: this.cachedProjectId
        };

        try {
            const client = await this.auth.getClient();
            const token = await client.getAccessToken();
            const hasToken = !!(token && token.token);
            if (hasToken) {
                return {
                    connected: true,
                    ...identity,
                    ...base,
                    authMethod: 'service-account',
                    error: undefined
                };
            }
            return await checkApiKeyFallback('Failed to retrieve access token from Google Cloud');
        } catch (err: unknown) {
            return await checkApiKeyFallback(errorMessage(err) || 'Authentication error');
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
    /**
     * Gemini 4+ rejects `thinkingBudget` with a 400 and takes a `thinkingLevel` instead, so the
     * token budget from settings is mapped onto a level for those models.
     */
    getThinkingConfig(request: Pick<GeminiGenerateRequest, 'thinkingBudget'>, model?: string): GeminiThinkingConfig {
        const thinkingBudget = request.thinkingBudget !== undefined ? request.thinkingBudget : this.thinkingBudget;
        if (Number(/^gemini-(\d+)/.exec(model ?? '')?.[1] ?? 0) >= 4) {
            return { thinkingLevel: thinkingBudget < 1024 ? 'LOW' : thinkingBudget < 2048 ? 'MEDIUM' : 'HIGH' };
        }
        return { thinkingBudget };
    }

    vertexModelUrl(projectId: string, model: string, method: 'streamGenerateContent' | 'generateContent'): string {
        const suffix = method === 'streamGenerateContent' ? '?alt=sse' : '';
        const location = resolveVertexLocation();
        return `https://${vertexHost(location)}/v1/projects/${projectId}/locations/${location}/publishers/google/models/${model}:${method}${suffix}`;
    }

    vertexAgentUrl(projectId: string, agent: string): string {
        const location = resolveVertexLocation();
        return `https://${vertexHost(location)}/v1/projects/${projectId}/locations/${location}/publishers/google/agents/${agent}:interact?alt=sse`;
    }

    /**
     * Direct non-streaming request to Vertex AI or AI Studio REST endpoint.
     * Used by lightweight services such as FIM completion and ⌘K quick edit.
     */
    async fetchVertexOrAistudio(
        model: string,
        contents: unknown[],
        systemInstruction?: string,
        generationConfig?: {
            temperature?: number;
            maxOutputTokens?: number;
            stopSequences?: string[];
        }
    ): Promise<VertexGenerateContentJson> {
        return (await this.requestGenerateContent(model, contents, systemInstruction, generationConfig)).json;
    }

    /**
     * Non-streaming `generateContent` on the same credential rule as chat: the Vertex service account when one is
     * configured, the Gemini API key when there is none or it cannot issue a token (reported in `credentialNote`).
     * A request Vertex answers with an error fails with that error; it is not re-sent with the API key.
     */
    async requestGenerateContent(
        model: string,
        contents: unknown[],
        systemInstruction?: string,
        generationConfig?: {
            temperature?: number;
            maxOutputTokens?: number;
            stopSequences?: string[];
        }
    ): Promise<{ json: VertexGenerateContentJson } & CredentialAnswer> {
        const fetchFn = resolveFetch();
        const payload: Record<string, unknown> = {
            contents,
            generationConfig: {
                temperature: generationConfig?.temperature ?? 0.2,
                maxOutputTokens: generationConfig?.maxOutputTokens ?? 2048,
                ...(generationConfig?.stopSequences ? { stopSequences: generationConfig.stopSequences } : {})
            }
        };

        if (systemInstruction) {
            payload.systemInstruction = {
                role: 'system',
                parts: [{ text: systemInstruction }]
            };
        }

        let credentialNote: string | undefined;
        if (this.ensureAuth() && this.auth && this.cachedProjectId) {
            let vertexToken: AccessTokenResult | undefined;
            try {
                vertexToken = await this.getAccessToken();
            } catch (err) {
                credentialNote = `the Vertex AI service account could not get an access token (${summarizeModelError(err)})`;
            }
            if (vertexToken) {
                const resp = await fetchFn(this.vertexModelUrl(vertexToken.projectId, model, 'generateContent'), {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${vertexToken.token}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(payload)
                });
                if (!resp.ok) {
                    throw new Error(`Vertex AI error (${resp.status}): ${await resp.text()}`);
                }
                return { json: (await resp.json()) as VertexGenerateContentJson, credential: 'vertex' };
            }
        }

        const apiKey = await this.resolveApiKey();
        if (!apiKey) {
            throw new Error(credentialNote
                ? `No Gemini API key is configured, and ${credentialNote}.`
                : 'No Google Cloud service account or Gemini API key configured.');
        }
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
        const resp = await fetchFn(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        });
        if (!resp.ok) {
            throw new Error(`AI Studio API error (${resp.status}): ${await resp.text()}`);
        }
        return {
            json: (await resp.json()) as VertexGenerateContentJson,
            credential: 'api-key',
            ...(credentialNote ? { credentialNote } : {})
        };
    }

    /**
     * Simplified non-streaming content generation with optional multimodal inline data.
     */
    async generateContent(options: {
        model?: string;
        prompt?: string;
        systemInstruction?: string;
        inlineData?: Array<{ mimeType: string; data: string }>;
        temperature?: number;
        maxOutputTokens?: number;
    }): Promise<{ text: string } & CredentialAnswer> {
        const model = options.model || DEFAULT_GEMINI_MODEL;
        const parts: any[] = [];
        if (options.prompt) {
            parts.push({ text: options.prompt });
        }
        if (options.inlineData) {
            for (const item of options.inlineData) {
                parts.push({
                    inline_data: {
                        mime_type: item.mimeType,
                        data: item.data
                    }
                });
            }
        }
        const contents = [{ role: 'user', parts }];
        const { json, ...answeredWith } = await this.requestGenerateContent(
            model,
            contents,
            options.systemInstruction,
            {
                temperature: options.temperature,
                maxOutputTokens: options.maxOutputTokens
            }
        );
        const text = json?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
        return { text, ...answeredWith };
    }

    // ------------------------------------------------------------------
    // Retry / fallback
    // ------------------------------------------------------------------

    /**
     * Try each candidate model in order. Unknown-model (404) errors advance to the next
     * candidate; transient errors are retried with exponential backoff; anything else throws.
     * `onFallback` reports each skipped model and why, so the caller can say which model answered.
     */
    async withModelFallback<T>(
        candidates: string[],
        attempt: (model: string) => Promise<T>,
        options: ModelFallbackOptions = {}
    ): Promise<T> {
        const { onSuccess, onFallback, exhaustedMessage = 'Failed to generate with available AI models', retryTransient = true } = options;
        let lastError: unknown;
        for (let i = 0; i < candidates.length; i++) {
            const model = candidates[i];
            try {
                const result = retryTransient
                    ? await this.withTransientRetry(() => attempt(model))
                    : await attempt(model);
                onSuccess?.(model);
                return result;
            } catch (err: unknown) {
                lastError = err;
                if (isModelNotFoundError(err) && (options.canFallback?.(err) ?? true)) {
                    if (i + 1 < candidates.length) onFallback?.(model, summarizeModelError(err), candidates[i + 1]);
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
