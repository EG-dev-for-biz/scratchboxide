/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/
import type { Content, Part } from '@google/genai';
import type { SubagentRequest, SubagentResponse } from '../../common/gemini-protocol';
import type { Scene3DData } from '../../browser/generative-canvas/canvas-types';
import {
    SubagentPoolService,
    type SubagentDAGPlan,
    type SubagentDAGResult,
    type SubagentPoolMetrics
} from '../subagent-pool-service';
import {
    DynamicDagPlanner,
    type Autonomous3DPlanResult,
    type Autonomous3DStageDAG
} from '../deep-write/dynamic-dag-planner';
import { GeminiClient, resolveFetch, type VertexGenerateContentJson } from './gemini-client';

/** The host object `DynamicDagPlanner` expects (structurally the GeminiService facade). */
export type DynamicDagPlannerHost = NonNullable<ConstructorParameters<typeof DynamicDagPlanner>[0]>;

/** Anything that can run a subagent task; the pool calls back into it for worker execution. */
export interface SubagentExecutor {
    executeSubagentTask(request: SubagentRequest): Promise<SubagentResponse>;
}

export interface SwarmBridgeOptions {
    client: GeminiClient;
    /** Executor handed to the subagent pool (normally the facade, so subclass overrides are honoured). */
    subagentExecutor: SubagentExecutor;
    /** Host handed to `DynamicDagPlanner` for autonomous 3D planning. */
    plannerHost: DynamicDagPlannerHost;
    maxConcurrentWorkers?: number;
}

interface SubagentGeneratePayload {
    contents: Content[];
    systemInstruction: Content;
    generationConfig: { temperature: number; maxOutputTokens: number };
    tools?: Array<{ googleSearch: Record<string, never> }>;
}

/**
 * Subagent swarm orchestration: lightweight background model calls, the subagent pool/DAG
 * executor, subagent model routing, and the autonomous 3D planning entry points.
 */
export class SwarmBridge {
    private readonly client: GeminiClient;
    private readonly plannerHost: DynamicDagPlannerHost;
    private readonly pool: SubagentPoolService;

    constructor(options: SwarmBridgeOptions) {
        this.client = options.client;
        this.plannerHost = options.plannerHost;
        this.pool = new SubagentPoolService({
            maxConcurrentWorkers: options.maxConcurrentWorkers ?? 64,
            orchestratorModel: this.client.defaultModel,
            workerModel: this.client.defaultSubagentModel
        }, options.subagentExecutor);
    }

    getSubagentPoolService(): SubagentPoolService {
        return this.pool;
    }

    getPoolMetrics(): SubagentPoolMetrics {
        return this.pool.getPoolMetrics();
    }

    async executeSwarmDAG(dag: SubagentDAGPlan): Promise<SubagentDAGResult> {
        return this.pool.executeDAG(dag);
    }

    /** Candidate models for subagent tasks (preferred lite model first, then fallbacks). */
    getSubagentModelCandidates(requestedModel?: string): string[] {
        return this.client.getSubagentModelCandidates(requestedModel);
    }

    /** Targeted system prompt for lightweight subagent tasks. */
    buildSubagentInstruction(request: SubagentRequest): string {
        return `You are Scratchbox AI Subagent, an ultra-fast, intelligent assistant for background orchestration.
Task type: ${request.taskType}
Analyze the prompt and provided context to deliver concise, precise, structured execution output without unnecessary fluff.
${request.context ? `Context:\n${request.context}` : ''}`;
    }

    /** Execute a subagent background task against the lite model tier with fallbacks. */
    async executeSubagentTask(request: SubagentRequest): Promise<SubagentResponse> {
        let auth: { type: 'vertex'; token: string; projectId: string } | { type: 'api-key'; apiKey: string };
        try {
            const { token, projectId } = await this.client.getAccessToken();
            auth = { type: 'vertex', token, projectId };
        } catch {
            const apiKey = await this.client.resolveApiKey();
            if (apiKey) {
                auth = { type: 'api-key', apiKey };
            } else {
                throw new Error('No Google Cloud service account or Gemini API key configured.');
            }
        }

        const candidates = this.getSubagentModelCandidates(request.model);
        const fetchFn = resolveFetch();

        return this.client.withModelFallback(
            candidates,
            async targetModel => {
                const url = auth.type === 'vertex'
                    ? this.client.vertexModelUrl(auth.projectId, targetModel, 'generateContent')
                    : `https://generativelanguage.googleapis.com/v1beta/models/${targetModel}:generateContent?key=${encodeURIComponent(auth.apiKey)}`;
                const payload: SubagentGeneratePayload = {
                    contents: [{ role: 'user', parts: [{ text: request.prompt }] }],
                    systemInstruction: { role: 'system', parts: [{ text: this.buildSubagentInstruction(request) }] },
                    generationConfig: { temperature: 0.2, maxOutputTokens: 2048 }
                };
                if (request.enableGoogleSearch !== false) {
                    payload.tools = [{ googleSearch: {} }];
                }

                const headers: Record<string, string> = {
                    'Content-Type': 'application/json'
                };
                if (auth.type === 'vertex') {
                    headers['Authorization'] = `Bearer ${auth.token}`;
                }

                const response = await fetchFn(url, {
                    method: 'POST',
                    headers,
                    body: JSON.stringify(payload)
                });

                if (!response.ok) {
                    const errBody = await response.text();
                    throw new Error(`Subagent request failed (${response.status}): ${errBody}`);
                }

                const json = (await response.json()) as VertexGenerateContentJson;
                const candidate = json.candidates?.[0];
                const text = (candidate?.content?.parts || []).map((p: Part) => p.text || '').join('');
                const groundingMetadata = candidate?.groundingMetadata || json.groundingMetadata;

                return {
                    success: true,
                    result: text,
                    groundingMetadata,
                    modelUsed: targetModel
                } satisfies SubagentResponse;
            },
            {
                // The answering model is reported as modelUsed; it is not made the default for later subagent calls.
                exhaustedMessage: 'Failed to execute subagent with available models'
            }
        );
    }

    /** Autonomous multi-step 3D planning agent workflow (PocoLibre/blender-mcp paradigm). */
    async plan3DAutonomousWorkflow(prompt: string, currentScene?: Scene3DData): Promise<Autonomous3DPlanResult> {
        const planner = new DynamicDagPlanner(this.plannerHost);
        return planner.executeAutonomous3DWorkflow(prompt, currentScene);
    }

    /** Dependency-resolved 3D planning DAG for a prompt and scene. */
    generate3DPlanDAG(prompt: string, currentScene?: Scene3DData): Autonomous3DStageDAG {
        const planner = new DynamicDagPlanner(this.plannerHost);
        return planner.generate3DPlanDAG(prompt, currentScene);
    }
}
