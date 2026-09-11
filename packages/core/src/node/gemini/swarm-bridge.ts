/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
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
        const { token, projectId } = await this.client.getAccessToken();
        const candidates = this.getSubagentModelCandidates(request.model);
        const fetchFn = resolveFetch();

        return this.client.withModelFallback(
            candidates,
            async targetModel => {
                const url = this.client.vertexModelUrl(projectId, targetModel, 'generateContent');
                const payload: SubagentGeneratePayload = {
                    contents: [{ role: 'user', parts: [{ text: request.prompt }] }],
                    systemInstruction: { role: 'system', parts: [{ text: this.buildSubagentInstruction(request) }] },
                    generationConfig: { temperature: 0.2, maxOutputTokens: 2048 }
                };
                if (request.enableGoogleSearch !== false) {
                    payload.tools = [{ googleSearch: {} }];
                }

                const response = await fetchFn(url, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'Content-Type': 'application/json'
                    },
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
                onSuccess: model => { this.client.preferredSubagentModel = model; },
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
