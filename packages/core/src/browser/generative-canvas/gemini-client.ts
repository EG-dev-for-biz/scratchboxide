/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import type { ChatModelAvailability } from '../../common/chat-models';
import { Endpoint } from './endpoint';
import {
    AgentSessionCreateRequest,
    FimCompletionRequest,
    FimCompletionResponse,
    GeminiGenerateRequest,
    GeminiGenerateResponse,
    GeminiStatus,
    GeminiStreamEvent,
    McpPingRequest,
    McpPingResponse,
    QuickEditRequest,
    QuickEditResponse,
    SaveCredentialsRequest,
    SaveCredentialsResponse,
    SubagentRequest,
    SubagentResponse,
    GeminiTtsRequest,
    GeminiTtsResponse,
    ModelAnswerProvenance
} from '../../common/gemini-protocol';
import { AgentSessionState, AgentStreamEvent } from '../../common/agent-checkpoint-protocol';
import { VisualVerificationRequest, VisualVerificationOutcome } from '../../common/visual-verification-protocol';

/** Where a chat request failed: the local server was unreachable, it returned an error, or the AI request itself failed. */
export type ChatFailureKind = 'unreachable' | 'server' | 'ai';

/**
 * A request body for the chat and visual-check routes, with any large generated-model bytes (a scene's
 * pythonGenerator / cppGenerator glbBase64) replaced by a short note: the server reads models from their glbPath, and a
 * built skyscraper's base64 alone outgrew the server's 50 MB body limit, so every later turn in that chat failed (413).
 * The note keeps the field present, so nothing takes the scene for an uncompiled script.
 */
export function chatRequestBody(request: unknown): string {
    return JSON.stringify(request, (key, value) =>
        key === 'glbBase64' && typeof value === 'string' && value.length > 1_000_000
            ? `[omitted from the chat request: ${value.length} base64 characters; the model is at glbPath]`
            : value);
}

export class ChatRequestError extends Error {
    constructor(
        message: string,
        readonly kind: ChatFailureKind,
        readonly status?: number,
        /** Which model and credential answered before the failure (a fallback model, the API key), when known. */
        readonly modelProvenance?: ModelAnswerProvenance
    ) {
        super(message);
        this.name = 'ChatRequestError';
    }
}

export class GeminiClient {
    private static instance: GeminiClient;

    public static getInstance(): GeminiClient {
        if (!GeminiClient.instance) {
            GeminiClient.instance = new GeminiClient();
        }
        return GeminiClient.instance;
    }

    protected endpoint(): string {
        try {
            const url = new Endpoint({ path: 'gemini' }).getRestUrl().toString();
            return url.endsWith('/') ? url.slice(0, -1) : url;
        } catch {
            return '/gemini';
        }
    }

    /**
     * Check real-time connection status with AI backend service.
     */
    async checkStatus(): Promise<GeminiStatus> {
        try {
            const res = await fetch(`${this.endpoint()}/status`, {
                method: 'GET',
                headers: { 'Accept': 'application/json' }
            });
            if (res.ok) {
                return await res.json();
            }
            return {
                connected: false,
                activeModel: 'gemini-4-argon',
                availableModels: ['gemini-4-argon', 'gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-2.5-flash', 'gemini-2.5-pro'],
                subagentModel: 'gemini-3.5-flash-lite',
                availableSubagentModels: ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite-preview', 'gemini-3.1-flash-lite'],
                thinkingBudget: 1024,
                authMethod: 'unauthenticated',
                error: `HTTP ${res.status}: ${res.statusText}`
            };
        } catch (err: any) {
            return {
                connected: false,
                activeModel: 'gemini-4-argon',
                availableModels: ['gemini-4-argon', 'gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-2.5-flash', 'gemini-2.5-pro'],
                subagentModel: 'gemini-3.5-flash-lite',
                availableSubagentModels: ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite-preview', 'gemini-3.1-flash-lite'],
                thinkingBudget: 1024,
                authMethod: 'unauthenticated',
                error: err.message || 'Service unreachable'
            };
        }
    }

    /**
     * Execute subagent task (using Gemini 3.5 Flash Lite / 3.1 Flash Lite).
     */
    async executeSubagent(request: SubagentRequest): Promise<SubagentResponse> {
        const res = await fetch(`${this.endpoint()}/subagent`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            },
            body: JSON.stringify(request)
        });

        if (!res.ok) {
            const errText = await res.text();
            throw new Error(`Subagent task failed (${res.status}): ${errText}`);
        }

        return await res.json();
    }

    /**
     * Fetch real-time subagent worker pool metrics (active workers, queued tasks, latency).
     */
    async getSubagentPoolMetrics(): Promise<{ success: boolean; metrics: any }> {
        const res = await fetch(`${this.endpoint()}/subagent/pool-status`, {
            method: 'GET',
            headers: {
                'Accept': 'application/json'
            }
        });

        if (!res.ok) {
            return {
                success: false,
                metrics: {
                    maxWorkers: 64,
                    activeWorkers: 0,
                    queuedTasks: 0,
                    completedTasks: 0,
                    failedTasks: 0,
                    averageExecutionLatencyMs: 0,
                    concurrencyUtilizationPercent: 0
                }
            };
        }

        return await res.json();
    }

    /**
     * Multimodal Vision QA inspection of rendered canvas viewport.
     */
    async verifyVisual(request: VisualVerificationRequest): Promise<VisualVerificationOutcome> {
        const res = await fetch(`${this.endpoint()}/verify-visual`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            },
            body: chatRequestBody(request)
        });

        if (!res.ok) {
            const errText = await res.text();
            throw new Error(`Visual verification failed (${res.status}): ${errText}`);
        }

        return await res.json();
    }

    /**
     * Multimodal Vision QA with auto-repair directives applied to artifact.
     */
    async verifyAndRepair(request: VisualVerificationRequest, artifact?: any): Promise<{ success: boolean; audit: VisualVerificationOutcome; repairedArtifact?: any }> {
        const res = await fetch(`${this.endpoint()}/verify-and-repair`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            },
            body: JSON.stringify({ request, artifact })
        });

        if (!res.ok) {
            const errText = await res.text();
            throw new Error(`Visual verify and repair failed (${res.status}): ${errText}`);
        }

        return await res.json();
    }

    /**
     * Execute a Directed Acyclic Graph (DAG) of parallel subagent tasks.
     */
    async executeSubagentSwarm(dag: any): Promise<any> {
        const res = await fetch(`${this.endpoint()}/subagent/swarm`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            },
            body: JSON.stringify(dag)
        });

        if (!res.ok) {
            const errText = await res.text();
            throw new Error(`Subagent swarm execution failed (${res.status}): ${errText}`);
        }

        return await res.json();
    }

    /**
     * Execute structured generation (non-streaming).
     */
    async generate(request: GeminiGenerateRequest): Promise<GeminiGenerateResponse> {
        const res = await fetch(`${this.endpoint()}/generate`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            },
            body: JSON.stringify(request)
        });

        if (!res.ok) {
            const errText = await res.text();
            throw new Error(`Generation failed (${res.status}): ${errText}`);
        }

        return await res.json();
    }

    /**
     * Stream generation with real-time thoughts, MCP execution telemetry, and canvas artifacts.
     */
    async streamGenerate(
        request: GeminiGenerateRequest,
        onEvent: (event: GeminiStreamEvent) => void,
        signal?: AbortSignal
    ): Promise<void> {
        let res: Response;
        const timeoutController = new AbortController();
        const timeoutId = setTimeout(() => {
            timeoutController.abort(new Error('Backend connection timeout (300s)'));
        }, 300000);

        const onParentAbort = () => timeoutController.abort(signal?.reason);
        if (signal) {
            if (signal.aborted) {
                clearTimeout(timeoutId);
                return;
            }
            signal.addEventListener('abort', onParentAbort, { once: true });
        }

        try {
            try {
                res = await fetch(`${this.endpoint()}/generate-stream`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Accept': 'text/event-stream'
                    },
                    body: chatRequestBody(request),
                    signal: timeoutController.signal
                });
                if (res.status === 404) {
                    res = await fetch(`${this.endpoint()}/stream`, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Accept': 'text/event-stream'
                        },
                        body: chatRequestBody(request),
                        signal: timeoutController.signal
                    });
                }
            } catch (fetchErr) {
                if (signal?.aborted) return;
                try {
                    res = await fetch(`${this.endpoint()}/stream`, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Accept': 'text/event-stream'
                        },
                        body: chatRequestBody(request),
                        signal: timeoutController.signal
                    });
                } catch (retryErr: any) {
                    if (signal?.aborted) return;
                    throw new ChatRequestError(retryErr?.message || 'Connection to the Scratchbox server failed', 'unreachable');
                }
            }

            if (!res.ok) {
                const errText = await res.text();
                let serverMessage = errText;
                try {
                    const body = JSON.parse(errText);
                    serverMessage = body?.message || body?.error || errText;
                } catch {
                    // Non-JSON error body
                }
                throw new ChatRequestError(`HTTP ${res.status}: ${serverMessage}`, 'server', res.status);
            }

            // Connection established and headers received: clear connection timeout
            clearTimeout(timeoutId);

            if (!res.body) {
                throw new Error('Response body is not readable');
            }

            const reader = res.body.getReader();
            const decoder = new TextDecoder('utf-8');
            let buffer = '';

            while (true) {
                let chunk: ReadableStreamReadResult<Uint8Array>;
                try {
                    chunk = await reader.read();
                } catch (readErr: any) {
                    if (signal?.aborted) return;
                    throw new ChatRequestError(`The connection dropped mid-reply: ${readErr?.message || readErr}`, 'unreachable');
                }
                const { done, value } = chunk;
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';

                for (const line of lines) {
                    const trimmed = line.trim();
                    if (trimmed.startsWith('data:')) {
                        const jsonStr = trimmed.replace(/^data:\s*/, '');
                        if (jsonStr === '[DONE]') {
                            return;
                        }
                        if (jsonStr) {
                            try {
                                const event: GeminiStreamEvent = JSON.parse(jsonStr);
                                if (event.type === 'error') {
                                    throw new ChatRequestError(event.error || 'AI backend generation error', 'ai', undefined, event.modelProvenance);
                                }
                                onEvent(event);
                            } catch (parseErr) {
                                // Only partial JSON chunks are skipped; Google's error bodies can mention "JSON" too.
                                if (!(parseErr instanceof SyntaxError)) {
                                    throw parseErr;
                                }
                            }
                        }
                    }
                }
            }
        } catch (err) {
            // Once the caller aborted (Stop, a newer message), whatever fails next — e.g. reading an
            // error body — is that abort, not a server or AI failure to report.
            if (signal?.aborted) return;
            throw err;
        } finally {
            clearTimeout(timeoutId);
            if (signal) {
                signal.removeEventListener('abort', onParentAbort);
            }
        }
    }

    /**
     * Save Service Account JSON or API Key credentials.
     */
    /** The chat's model picker: each model with whether its provider has a key on the server (never the key). */
    async listChatModels(): Promise<{ models: ChatModelAvailability[]; defaultModel?: string; error?: string }> {
        try {
            const res = await fetch(`${this.endpoint()}/chat-models`, { method: 'GET', headers: { 'Accept': 'application/json' } });
            const body = await res.json().catch(() => ({}));
            if (!res.ok) return { models: [], error: body?.error || `HTTP ${res.status}` };
            return { models: Array.isArray(body.models) ? body.models : [], defaultModel: body.defaultModel };
        } catch (err: any) {
            return { models: [], error: err?.message || String(err) };
        }
    }

    /** Saves (or, with an empty key, clears) the Claude or OpenAI key on the server. */
    async saveProviderKey(provider: 'anthropic' | 'openai', apiKey: string): Promise<{ success: boolean; configured?: boolean; error?: string }> {
        try {
            const res = await fetch(`${this.endpoint()}/provider-key`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
                body: JSON.stringify({ provider, apiKey })
            });
            const body = await res.json().catch(() => ({}));
            if (!res.ok) return { success: false, error: body?.error || `HTTP ${res.status}` };
            return { success: true, configured: body.configured === true };
        } catch (err: any) {
            return { success: false, error: err?.message || String(err) };
        }
    }

    async saveCredentials(request: SaveCredentialsRequest): Promise<SaveCredentialsResponse> {
        try {
            const res = await fetch(`${this.endpoint()}/save-credentials`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                },
                body: JSON.stringify(request)
            });
            if (res.ok) {
                return await res.json();
            }
            const errText = await res.text();
            let serverError: string | undefined;
            try {
                serverError = JSON.parse(errText)?.error;
            } catch {
                // Non-JSON error body
            }
            return {
                success: false,
                authMethod: 'unauthenticated',
                error: typeof serverError === 'string' ? serverError : `Save failed (${res.status}): ${errText}`
            };
        } catch (err: any) {
            return {
                success: false,
                authMethod: 'unauthenticated',
                error: err.message || 'Network error saving credentials'
            };
        }
    }

    /**
     * Ping MCP Server to verify live connectivity and latency.
     */
    async pingMcp(server: McpPingRequest['server']): Promise<McpPingResponse> {
        try {
            const res = await fetch(`${this.endpoint()}/mcp/ping`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                },
                body: JSON.stringify({ server })
            });
            if (res.ok) {
                return await res.json();
            }
            return {
                serverId: server.id,
                status: 'offline',
                latencyMs: 0,
                availableToolsCount: 0,
                error: `HTTP ${res.status}`
            };
        } catch (err: any) {
            return {
                serverId: server.id,
                status: 'offline',
                latencyMs: 0,
                availableToolsCount: 0,
                error: err.message || 'Ping failed'
            };
        }
    }

    /**
     * Complete code in-line using Fill-In-The-Middle (Tab Autocomplete style).
     */
    async completeFim(request: FimCompletionRequest): Promise<FimCompletionResponse> {
        try {
            const res = await fetch(`${this.endpoint()}/fim`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                },
                body: JSON.stringify(request)
            });
            if (res.ok) {
                return await res.json();
            }
            const errText = await res.text();
            return {
                success: false,
                completion: '',
                modelUsed: 'none',
                error: `FIM request failed (${res.status}): ${errText}`
            };
        } catch (err: any) {
            return {
                success: false,
                completion: '',
                modelUsed: 'none',
                error: err.message || 'Network error during FIM request'
            };
        }
    }

    /**
     * Transform code via user instruction and calculate diff (Cursor ⌘K style).
     */
    async quickEdit(request: QuickEditRequest): Promise<QuickEditResponse> {
        try {
            const res = await fetch(`${this.endpoint()}/quick-edit`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                },
                body: JSON.stringify(request)
            });
            if (res.ok) {
                return await res.json();
            }
            const errText = await res.text();
            return {
                success: false,
                proposedCode: request.originalCode,
                error: `Quick-edit failed (${res.status}): ${errText}`
            };
        } catch (err: any) {
            return {
                success: false,
                proposedCode: request.originalCode,
                error: err.message || 'Network error during quick-edit'
            };
        }
    }

    /**
     * Initialize an Autonomous Long-Running Goal Session.
     */
    async createAgentSession(request: AgentSessionCreateRequest): Promise<AgentSessionState> {
        const res = await fetch(`${this.endpoint()}/agent/session`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            },
            body: JSON.stringify(request)
        });

        if (!res.ok) {
            const errText = await res.text();
            throw new Error(`Failed to create agent session (${res.status}): ${errText}`);
        }

        // The route answers { success, session }.
        const body = await res.json();
        if (!body?.session?.sessionId) {
            throw new Error(`the agent backend returned no session${body?.error ? `: ${body.error}` : ''}`);
        }
        return body.session as AgentSessionState;
    }

    /**
     * Pause, Resume, or Cancel an active agent session.
     */
    async sendAgentAction(sessionId: string, action: 'pause' | 'resume' | 'cancel'): Promise<{ success: boolean; status?: string }> {
        const res = await fetch(`${this.endpoint()}/agent/action`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            },
            body: JSON.stringify({ sessionId, action })
        });

        if (!res.ok) {
            const errText = await res.text();
            throw new Error(`Agent action failed (${res.status}): ${errText}`);
        }

        return await res.json();
    }

    /**
     * Stream an autonomous long-running agent session with real-time milestones and verification output.
     */
    async streamAgentSession(
        sessionId: string,
        onEvent: (event: AgentStreamEvent) => void
    ): Promise<void> {
        const res = await fetch(`${this.endpoint()}/agent/stream`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'text/event-stream'
            },
            body: JSON.stringify({ sessionId })
        });

        if (!res.ok) {
            const errText = await res.text();
            throw new Error(`Agent stream request failed (${res.status}): ${errText}`);
        }

        if (!res.body) {
            throw new Error('Response body is not readable');
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let buffer = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                const trimmed = line.trim();
                if (trimmed.startsWith('data:')) {
                    const jsonStr = trimmed.replace(/^data:\s*/, '');
                    if (jsonStr === '[DONE]') {
                        return;
                    }
                    if (jsonStr) {
                        try {
                            const event: AgentStreamEvent = JSON.parse(jsonStr);
                            onEvent(event);
                        } catch {
                            // ignore partial JSON chunks
                        }
                    }
                }
            }
        }
    }

    /**
     * Synthesize speech from text.
     */
    async synthesizeSpeech(request: GeminiTtsRequest): Promise<GeminiTtsResponse> {
        const res = await fetch(`${this.endpoint()}/tts`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            },
            body: JSON.stringify(request)
        });

        if (!res.ok) {
            const errText = await res.text();
            throw new Error(`TTS synthesis failed (${res.status}): ${errText}`);
        }

        return await res.json();
    }
}

export class AudioPlayer {
    private static audioCtx: AudioContext | null = null;
    private static activeSourceNode: AudioBufferSourceNode | null = null;
    private static currentOnEnded: (() => void) | null = null;

    private static getContext(): AudioContext {
        if (!this.audioCtx) {
            this.audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
        }
        return this.audioCtx;
    }

    public static isPlaying(): boolean {
        return !!this.activeSourceNode;
    }

    public static stop(): void {
        if (this.activeSourceNode) {
            try {
                this.activeSourceNode.stop();
            } catch {
                // Ignore if already stopped
            }
            this.activeSourceNode = null;
        }
        if (this.currentOnEnded) {
            const cb = this.currentOnEnded;
            this.currentOnEnded = null;
            cb();
        }
    }

    private static base64ToArrayBuffer(base64: string): ArrayBuffer {
        const binaryString = atob(base64);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i);
        }
        return bytes.buffer;
    }

    public static async playBase64(base64Data: string, onStart?: () => void, onEnded?: () => void): Promise<void> {
        this.stop();

        const ctx = this.getContext();
        if (ctx.state === 'suspended') {
            await ctx.resume();
        }

        const arrayBuf = this.base64ToArrayBuffer(base64Data);
        const audioBuf = await ctx.decodeAudioData(arrayBuf);

        const source = ctx.createBufferSource();
        source.buffer = audioBuf;
        source.connect(ctx.destination);

        this.activeSourceNode = source;
        this.currentOnEnded = onEnded || null;

        source.onended = () => {
            if (this.activeSourceNode === source) {
                this.activeSourceNode = null;
                if (this.currentOnEnded) {
                    const cb = this.currentOnEnded;
                    this.currentOnEnded = null;
                    cb();
                }
            }
        };

        if (onStart) {
            onStart();
        }
        source.start(0);
    }

    public static async speak(
        text: string,
        onStateChange?: (state: 'idle' | 'loading' | 'playing' | 'error') => void
    ): Promise<void> {
        try {
            if (onStateChange) onStateChange('loading');
            
            const response = await GeminiClient.getInstance().synthesizeSpeech({ text });
            if (!response.success || !response.audioContent) {
                throw new Error(response.error || 'No audio content returned');
            }

            await this.playBase64(
                response.audioContent,
                () => {
                    if (onStateChange) onStateChange('playing');
                },
                () => {
                    if (onStateChange) onStateChange('idle');
                }
            );
        } catch (err) {
            console.error('AudioPlayer.speak failed:', err);
            if (onStateChange) onStateChange('error');
            setTimeout(() => {
                if (onStateChange) onStateChange('idle');
            }, 2000);
        }
    }
}
