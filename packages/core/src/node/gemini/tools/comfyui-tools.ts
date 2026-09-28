/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { ComfyUiBridgeService } from '../../comfyui/comfyui-bridge-service';
import { ComfyUiPipelineAgent } from '../../agent/comfyui-pipeline-agent';
import { TaskCapabilityResolver } from '../../agent/task-capability-resolver';
import type { ToolDeclaration, ToolHandler, ToolResultPayload } from './types';

function asString(val: unknown): string {
    return typeof val === 'string' ? val : '';
}

function asNumber(val: unknown): number | undefined {
    if (typeof val === 'number') return val;
    if (typeof val === 'string') {
        const n = parseFloat(val);
        return isNaN(n) ? undefined : n;
    }
    return undefined;
}

export const COMFYUI_TOOL_DECLARATIONS: ToolDeclaration[] = [
    {
        name: 'comfyui_get_status',
        description: 'Check ComfyUI server connectivity, GPU hardware acceleration (MPS/Metal or CUDA), VRAM telemetry, and installed node packages.',
        parameters: {
            type: 'OBJECT',
            properties: {
                hostUrl: { type: 'STRING', description: 'Optional ComfyUI server URL (defaults to http://127.0.0.1:8188)' }
            }
        }
    },
    {
        name: 'comfyui_research_pipeline',
        description: 'Research available ComfyUI nodes, models, and checkpoints to synthesize an optimal node execution graph (blueprint) for a specific user goal (e.g. text-to-image, inpainting, PBR texture matrix, 3D mesh reconstruction from reference image, or video generation).',
        parameters: {
            type: 'OBJECT',
            properties: {
                goal: { type: 'STRING', description: 'The natural language objective to accomplish with ComfyUI' },
                hostUrl: { type: 'STRING', description: 'Optional ComfyUI server URL (defaults to http://127.0.0.1:8188)' },
                mockExecution: { type: 'BOOLEAN', description: 'Run in offline emulation mode if no local ComfyUI server is running' }
            },
            required: ['goal']
        }
    },
    {
        name: 'comfyui_cloudrun_status',
        description: 'Query Google Cloud Run ComfyUI execution service status, GPU hardware acceleration (e.g. NVIDIA L4), region, latency, and model availability.',
        parameters: {
            type: 'OBJECT',
            properties: {
                serviceUrl: { type: 'STRING', description: 'Optional Cloud Run service URL' },
                mockExecution: { type: 'BOOLEAN', description: 'Run in offline emulation mode' }
            }
        }
    },
    {
        name: 'comfyui_cloudrun_sync_upstream',
        description: 'Query Cloud Run ComfyUI parity with upstream comfyanonymous/ComfyUI repository and optionally trigger hot-synchronization/reload.',
        parameters: {
            type: 'OBJECT',
            properties: {
                checkOnly: { type: 'BOOLEAN', description: 'If true, only checks upstream commit parity without triggering git pull/reload' },
                serviceUrl: { type: 'STRING', description: 'Optional Cloud Run service URL' },
                mockExecution: { type: 'BOOLEAN', description: 'Run in offline emulation mode' }
            }
        }
    },
    {
        name: 'comfyui_inject_dynamic_code',
        description: 'Injects and hot-loads a custom Python ComfyUI node module directly into Google Cloud Run runtime for task execution.',
        parameters: {
            type: 'OBJECT',
            properties: {
                moduleName: { type: 'STRING', description: 'Unique module name for the custom node (e.g. "custom_mesh_decimator")' },
                code: { type: 'STRING', description: 'Complete Python source code defining ComfyUI node classes, INPUT_TYPES, RETURN_TYPES, FUNCTION, and NODE_CLASS_MAPPINGS.' },
                nodeClasses: {
                    type: 'ARRAY',
                    items: { type: 'STRING' },
                    description: 'Names of the node classes defined in this module.'
                },
                requirements: {
                    type: 'ARRAY',
                    items: { type: 'STRING' },
                    description: 'Optional pip requirements required by the code module.'
                },
                serviceUrl: { type: 'STRING', description: 'Optional Cloud Run service URL' },
                mockExecution: { type: 'BOOLEAN', description: 'Run in offline emulation mode' }
            },
            required: ['moduleName', 'code']
        }
    },
    {
        name: 'comfyui_execute_pipeline',
        description: 'Autonomously research, construct, and execute a ComfyUI pipeline to achieve a goal. Monitors real-time node execution, self-heals any node input or connection validation errors, retrieves generated assets, and produces a canvas-ready NodeGraphData artifact.',
        parameters: {
            type: 'OBJECT',
            properties: {
                goal: { type: 'STRING', description: 'The natural language objective to accomplish with ComfyUI' },
                workflowJson: { type: 'STRING', description: 'Optional stringified ComfyUI JSON workflow prompt DAG to execute directly' },
                hostUrl: { type: 'STRING', description: 'Optional ComfyUI server URL (defaults to http://127.0.0.1:8188)' },
                targetEnvironment: { type: 'STRING', description: 'Execution environment: "local", "cloud-run", or "auto"' },
                cloudRunServiceUrl: { type: 'STRING', description: 'Optional Google Cloud Run service URL' },
                autoSyncUpstream: { type: 'BOOLEAN', description: 'Check and synchronize with latest upstream ComfyUI before execution' },
                mockExecution: { type: 'BOOLEAN', description: 'Run in offline emulation mode if no local ComfyUI server is running' },
                maxFixAttempts: { type: 'NUMBER', description: 'Maximum self-healing repair attempts (defaults to 3)' }
            },
            required: ['goal']
        }
    },
    {
        name: 'resolve_task_capability',
        description: 'Evaluates whether a VFX, 3D, or generative task can be solved natively using Scratchbox IDE capabilities (C++20 3D engine, Three.js shaders, Video NLE timeline, VFX plate matchmove, solar ephemeris, Google models, or attached skills) or whether it requires spinning up a ComfyUI solution (e.g. for deep neural diffusion, image-to-3D, video restyling, or monocular depth).',
        parameters: {
            type: 'OBJECT',
            properties: {
                taskGoal: { type: 'STRING', description: 'The natural language objective, prompt, or VFX/3D task description.' },
                domainHint: { type: 'STRING', description: 'Optional domain hint: "3d", "vfx", "generative", "code", or "auto"' },
                hasInputImage: { type: 'BOOLEAN', description: 'Whether the user provided an input image or photo reference.' },
                hasInputVideo: { type: 'BOOLEAN', description: 'Whether the user provided an input video plate.' },
                targetEnvironment: { type: 'STRING', description: 'Target ComfyUI environment if needed: "local", "cloud-run", or "auto"' }
            },
            required: ['taskGoal']
        }
    }
];

export const comfyuiHandlers: Record<string, ToolHandler> = {
    comfyui_get_status: async (args, _ctx) => {
        const hostUrl = asString(args.hostUrl) || undefined;
        const bridge = new ComfyUiBridgeService({ hostUrl });
        const available = await bridge.isAvailable();
        if (!available) {
            return {
                resultPayload: {
                    status: 'offline',
                    available: false,
                    hostUrl: bridge.getHostUrl(),
                    message: `ComfyUI server at ${bridge.getHostUrl()} is unreachable. Pass mockExecution: true to run in offline emulation mode.`
                },
                summaryResult: `ComfyUI server is offline (${bridge.getHostUrl()}).`
            };
        }
        const stats = await bridge.getSystemStats();
        const models = await bridge.getModels();
        return {
            resultPayload: {
                status: 'online',
                available: true,
                hostUrl: bridge.getHostUrl(),
                stats,
                models
            },
            summaryResult: `ComfyUI online with ${stats.devices.length} accelerator(s) and ${models.checkpoints.length} checkpoint(s).`
        };
    },

    comfyui_research_pipeline: async (args, ctx) => {
        const goal = asString(args.goal);
        if (!goal) throw new Error('comfyui_research_pipeline: "goal" argument is required.');
        const hostUrl = asString(args.hostUrl) || undefined;
        const mockExecution = typeof args.mockExecution === 'boolean' ? args.mockExecution : false;

        const agent = new ComfyUiPipelineAgent({
            hostUrl,
            mockExecution,
            workspaceRoot: ctx.workspaceRoot
        });

        const blueprint = await agent.researchPipeline(goal);
        const apiPrompt = agent.authorApiPrompt(blueprint);
        const nodeGraphData = agent.convertToNodeGraphData(blueprint, apiPrompt);

        return {
            resultPayload: {
                status: 'success',
                blueprint,
                apiPrompt,
                nodeGraphData
            },
            summaryResult: `Researched ComfyUI blueprint "${blueprint.id}" for goal: "${goal}" (${blueprint.nodes.length} nodes).`
        };
    },

    comfyui_cloudrun_status: async (args, ctx) => {
        const serviceUrl = asString(args.serviceUrl) || undefined;
        const mockExecution = typeof args.mockExecution === 'boolean' ? args.mockExecution : false;
        const agent = new ComfyUiPipelineAgent({
            cloudRun: { serviceUrl, mockExecution },
            workspaceRoot: ctx.workspaceRoot
        });
        const status = await agent.getCloudRunService().getServiceStatus();
        return {
            resultPayload: status,
            summaryResult: `Cloud Run service "${status.serviceUrl}" status: ${status.status} (${status.gpuAccelerated ? status.gpuType : 'CPU'}, ${status.latencyMs}ms latency).`
        };
    },

    comfyui_cloudrun_sync_upstream: async (args, ctx) => {
        const checkOnly = typeof args.checkOnly === 'boolean' ? args.checkOnly : false;
        const serviceUrl = asString(args.serviceUrl) || undefined;
        const mockExecution = typeof args.mockExecution === 'boolean' ? args.mockExecution : false;
        const agent = new ComfyUiPipelineAgent({
            cloudRun: { serviceUrl, mockExecution },
            workspaceRoot: ctx.workspaceRoot
        });

        if (checkOnly) {
            const versionInfo = await agent.getCloudRunService().getUpstreamVersionInfo();
            return {
                resultPayload: versionInfo,
                summaryResult: `ComfyUI upstream parity: ${versionInfo.upToDate ? 'Up-to-date' : `${versionInfo.commitsBehind} commit(s) behind`} (current: ${versionInfo.currentCommit}, upstream: ${versionInfo.upstreamCommit}).`
            };
        }

        const syncResult = await agent.getCloudRunService().syncUpstream();
        return {
            resultPayload: syncResult,
            summaryResult: syncResult.message
        };
    },

    comfyui_inject_dynamic_code: async (args, ctx) => {
        const moduleName = asString(args.moduleName);
        if (!moduleName) throw new Error('comfyui_inject_dynamic_code: "moduleName" argument is required.');
        const code = asString(args.code);
        if (!code) throw new Error('comfyui_inject_dynamic_code: "code" argument is required.');
        const nodeClasses = Array.isArray(args.nodeClasses) ? (args.nodeClasses as string[]) : [];
        const requirements = Array.isArray(args.requirements) ? (args.requirements as string[]) : [];
        const serviceUrl = asString(args.serviceUrl) || undefined;
        const mockExecution = typeof args.mockExecution === 'boolean' ? args.mockExecution : false;

        const agent = new ComfyUiPipelineAgent({
            cloudRun: { serviceUrl, mockExecution },
            workspaceRoot: ctx.workspaceRoot
        });

        const injectResult = await agent.getCloudRunService().injectDynamicCode({
            moduleName,
            code,
            nodeClasses,
            requirements
        });

        return {
            resultPayload: injectResult,
            summaryResult: `Injected dynamic code module "${moduleName}" on Cloud Run, registered ${injectResult.registeredClasses.length} custom node classes.`
        };
    },

    comfyui_execute_pipeline: async (args, ctx) => {
        const goal = asString(args.goal);
        if (!goal) throw new Error('comfyui_execute_pipeline: "goal" argument is required.');
        const workflowJson = asString(args.workflowJson);
        const hostUrl = asString(args.hostUrl) || undefined;
        const targetEnvironment = (asString(args.targetEnvironment) as any) || undefined;
        const cloudRunServiceUrl = asString(args.cloudRunServiceUrl) || undefined;
        const autoSyncUpstream = typeof args.autoSyncUpstream === 'boolean' ? args.autoSyncUpstream : false;
        const mockExecution = typeof args.mockExecution === 'boolean' ? args.mockExecution : false;
        const maxFixAttempts = asNumber(args.maxFixAttempts);

        const agent = new ComfyUiPipelineAgent({
            hostUrl,
            mockExecution,
            maxFixAttempts,
            targetEnvironment,
            cloudRun: cloudRunServiceUrl ? { serviceUrl: cloudRunServiceUrl, mockExecution } : { mockExecution },
            workspaceRoot: ctx.workspaceRoot
        });

        let result;
        if (workflowJson) {
            let parsedWorkflow: any;
            try {
                parsedWorkflow = JSON.parse(workflowJson);
            } catch (err: any) {
                throw new Error(`Invalid workflowJson: ${err.message}`);
            }
            result = await agent.executeWorkflowPrompt(parsedWorkflow, goal, {
                targetEnvironment,
                mockExecution,
                autoSyncUpstream
            });
        } else {
            result = await agent.executeAndHeal(goal, {
                targetEnvironment,
                mockExecution,
                autoSyncUpstream
            });
        }

        if (!result.success) {
            return {
                resultPayload: {
                    status: 'failed',
                    error: result.error,
                    diagnostics: result.diagnostics
                },
                status: 'failed',
                summaryResult: `ComfyUI execution failed: ${result.error}`
            };
        }

        return {
            resultPayload: {
                status: 'success',
                promptId: result.promptId,
                blueprint: result.blueprint,
                assets: result.assets,
                nodeGraphData: result.nodeGraphData,
                executionDurationMs: result.executionDurationMs,
                diagnostics: result.diagnostics
            },
            summaryResult: `ComfyUI pipeline executed successfully in ${result.executionDurationMs}ms, generating ${result.assets.length} asset(s).`
        };
    },

    resolve_task_capability: async (args, _ctx) => {
        const taskGoal = asString(args.taskGoal);
        if (!taskGoal) throw new Error('resolve_task_capability: "taskGoal" argument is required.');
        const domainHint = (asString(args.domainHint) as any) || undefined;
        const hasInputImage = typeof args.hasInputImage === 'boolean' ? args.hasInputImage : undefined;
        const hasInputVideo = typeof args.hasInputVideo === 'boolean' ? args.hasInputVideo : undefined;
        const targetEnvironment = (asString(args.targetEnvironment) as any) || undefined;

        const result = TaskCapabilityResolver.resolveTaskCapability(taskGoal, {
            domainHint,
            hasInputImage,
            hasInputVideo,
            targetEnvironment
        });

        const routeDesc = result.recommendedResolutionRoute === 'tier1-native'
            ? `Tier 1 Native Resolution recommended (${result.tier1Assessment.primaryNativeEngine}): ${result.tier1Assessment.rationale}`
            : `Tier 2 ComfyUI Fallback required (${result.tier2Fallback.recommendedPipelineCategory} on ${result.tier2Fallback.executionTarget}): ${result.tier2Fallback.gapReason}`;

        return {
            resultPayload: result as unknown as ToolResultPayload,
            summaryResult: routeDesc
        };
    }
};
