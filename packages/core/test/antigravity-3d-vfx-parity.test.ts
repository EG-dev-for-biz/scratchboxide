/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { afterEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type {
    AgentExecutionStep,
    CanvasArtifact,
    ChatMessage,
    ChatSession,
    McpExecutionState,
    Scene3DData,
    StudioLayoutMode,
    VideoTimelineData
} from '../src/browser/generative-canvas/canvas-types';
import { Composer, type ComposerProps } from '../src/browser/generative-canvas/chat/Composer';
import { summarizeGroupedToolStatus } from '../src/browser/generative-canvas/chat/MessageItem';
import {
    CONTEXT_MENTION_TAGS,
    parseContextMentions,
    resolveContextMentionQuery
} from '../src/browser/generative-canvas/context-mention-engine';
import { GeminiClient } from '../src/browser/generative-canvas/gemini-client';
import { useSendMessage, type SendMessageDeps, type UseSendMessageResult } from '../src/browser/generative-canvas/hooks/useSendMessage';
import { Scene3DWorldLens, summarizeSceneStateForAgent } from '../src/browser/generative-canvas/lenses/Scene3DWorldLens';
import type { ProjectArtifactController } from '../src/browser/generative-canvas/project-artifact-controller';
import type { ProjectItem } from '../src/browser/generative-canvas/ProjectsModal';
import {
    buildToolCallGraphArtifact,
    CHAT_UI_META_TOOLS,
    hasGraphableToolCalls,
    isRunnableChatToolName
} from '../src/browser/generative-canvas/tool-call-graph-artifact';
import { ToolNodeClient } from '../src/browser/generative-canvas/tool-node-client';
import { WorkspaceConfigClient, type FullWorkspaceConfig } from '../src/browser/generative-canvas/workspace-config-client';
import type { GeminiGenerateRequest } from '../src/common/gemini-protocol';
import {
    AgentVerificationService,
    extractGeometryVerificationInput
} from '../src/node/gemini/agent-verification-service';
import { buildContents } from '../src/node/gemini/prompt-builder';
import { ContainerSandboxService } from '../src/node/container-sandbox-service';
import { LspDiagnosticFeedbackService } from '../src/node/lsp-diagnostic-feedback-service';

function makeExec(overrides: Partial<McpExecutionState>): McpExecutionState {
    return {
        id: 'call-1',
        mcpServerId: 'scratchbox-3d',
        mcpName: 'Scratchbox 3D',
        toolName: 'execute_3d_python_script',
        humanTitle: 'execute_3d_python_script',
        status: 'completed',
        timestamp: '12:00:00',
        steps: [{ id: 's1', title: 'Run execute_3d_python_script', status: 'completed' }],
        ...overrides
    };
}

function makeComposerProps(overrides: Partial<ComposerProps> = {}): ComposerProps {
    const noop = () => undefined;
    return {
        inSplitPane: false,
        inputValue: '',
        isGenerating: false,
        isVoiceActive: false,
        isDraggingDataFile: false,
        setIsDraggingDataFile: noop,
        aiInteractionMode: 'agent',
        setAiInteractionMode: noop,
        attachedDataFile: undefined,
        setAttachedDataFile: noop,
        attachedContextMentions: [],
        setAttachedContextMentions: noop,
        attachedImages: [],
        addImageFiles: noop,
        removeAttachedImage: noop,
        skills: [],
        mcpServers: [],
        selectedSkillIds: [],
        selectedMcpIds: [],
        autocompleteType: undefined,
        setAutocompleteType: noop,
        autocompleteQuery: undefined,
        selectedAutocompleteIndex: 0,
        activeContextCategory: 'files',
        setActiveContextCategory: noop,
        filteredAutocompleteSkills: [],
        workspaceFilesList: [],
        workspaceGitStatus: {} as ComposerProps['workspaceGitStatus'],
        activeArtifactTitle: undefined,
        layoutMode: 'chat',
        inputRef: React.createRef<HTMLTextAreaElement>(),
        fileInputRef: React.createRef<HTMLInputElement>(),
        handleFileDrop: noop,
        handleFileInputChange: noop,
        handleInputChange: noop,
        handleKeyDown: noop,
        handleVoiceToggle: noop,
        handleToggleComposerSkill: noop,
        handleToggleComposerMcp: noop,
        handleSelectAutocompleteSkill: noop,
        handleSelectAutocompleteContext: noop,
        sendMessage: noop,
        stopGenerating: noop,
        canStop: false,
        ...overrides
    };
}

function createTestStudio() {
    const initialSession: ChatSession = {
        id: 'session-1',
        title: 'New Chat',
        dateCategory: 'Today',
        updatedAt: 'Just now',
        messages: [],
        artifactHistory: [],
        layoutMode: 'chat'
    };
    const state = {
        sessions: [initialSession],
        messages: [] as ChatMessage[],
        isGenerating: false,
        liveSteps: [] as AgentExecutionStep[],
        liveStreamedText: '',
        liveThinkingText: '',
        mcpExecutions: [] as McpExecutionState[],
        artifactHistory: [] as CanvasArtifact[],
        activeArtifact: undefined as CanvasArtifact | undefined,
        layoutMode: 'chat' as StudioLayoutMode,
        autocompleteType: undefined as 'skill' | 'context' | undefined,
        toasts: [] as string[]
    };
    const activeSessionRef = { current: 'session-1' as string | undefined };
    const noop = () => undefined;

    const deps: SendMessageDeps = {
        inputValue: '',
        isGenerating: false,
        setInputValue: v => {
            deps.inputValue = typeof v === 'function' ? v(deps.inputValue) : v;
        },
        executeDeepWritePipeline: async () => undefined,
        handleStartAgent: async () => undefined,
        skills: [],
        selectedSkillIds: [],
        mcpServers: [],
        selectedMcpIds: [],
        currentSessionId: 'session-1',
        setCurrentSessionId: noop,
        sessions: state.sessions,
        setSessions: v => {
            state.sessions = typeof v === 'function' ? v(state.sessions) : v;
            deps.sessions = state.sessions;
        },
        messages: state.messages,
        setMessages: v => {
            state.messages = typeof v === 'function' ? v(state.messages) : v;
            deps.messages = state.messages;
        },
        setAutocompleteType: v => {
            state.autocompleteType = typeof v === 'function' ? v(state.autocompleteType) : v;
        },
        setIsGenerating: v => {
            state.isGenerating = typeof v === 'function' ? v(state.isGenerating) : v;
            deps.isGenerating = state.isGenerating;
        },
        setLiveThinkingText: v => {
            state.liveThinkingText = typeof v === 'function' ? v(state.liveThinkingText) : v;
        },
        setLiveThinkingSeconds: noop,
        setLiveSteps: v => {
            state.liveSteps = typeof v === 'function' ? v(state.liveSteps) : v;
        },
        setLiveStreamedText: v => {
            state.liveStreamedText = typeof v === 'function' ? v(state.liveStreamedText) : v;
        },
        setActiveStreamingSectionId: noop,
        liveThinkingText: '',
        liveThinkingSeconds: 0,
        liveSteps: [],
        activeSessionRef,
        googleSearchGrounding: false,
        activeArtifact: undefined,
        setActiveArtifact: v => {
            state.activeArtifact = typeof v === 'function' ? v(state.activeArtifact) : v;
            deps.activeArtifact = state.activeArtifact;
        },
        artifactHistory: [],
        setArtifactHistory: v => {
            state.artifactHistory = typeof v === 'function' ? v(state.artifactHistory) : v;
            deps.artifactHistory = state.artifactHistory;
        },
        layoutMode: 'chat',
        setLayoutMode: v => {
            state.layoutMode = typeof v === 'function' ? v(state.layoutMode) : v;
            deps.layoutMode = state.layoutMode;
        },
        setMcpExecutions: v => {
            state.mcpExecutions = typeof v === 'function' ? v(state.mcpExecutions) : v;
        },
        setTokenBudget: noop,
        setActiveTerminalError: noop,
        setShowTerminalErrorToast: noop,
        recordArtifactVersion: noop,
        attachedDataFile: undefined,
        setAttachedDataFile: noop,
        showToast: text => {
            state.toasts.push(text);
        },
        graphControllerRef: {
            current: { registerArtifact: (a: CanvasArtifact) => a } as unknown as ProjectArtifactController
        },
        setGraphEpoch: noop,
        activeWorkspace: { id: 'ws', name: 'ws', path: '/tmp/ws', lastActive: 'now', tags: [] } as ProjectItem,
        persistSessionsImmediately: noop,
        aiInteractionMode: 'agent'
    };

    let hook!: UseSendMessageResult;
    const Harness = () => {
        hook = useSendMessage(deps);
        return null;
    };
    renderToStaticMarkup(React.createElement(Harness));
    return { state, deps, hook };
}

afterEach(() => {
    vi.restoreAllMocks();
});

describe('Antigravity 3D & VFX Interaction Parity (7 Pillars)', () => {
    describe('Pillar 1: Non-Blocking Prompt Queue & Mid-Flight Steering', () => {
        it('queues follow-up prompts while a 3D build is streaming without aborting, then drains FIFO on completion', async () => {
            const studio = createTestStudio();
            const requests: GeminiGenerateRequest[] = [];
            let resolveFirstStream!: () => void;
            const firstStreamGate = new Promise<void>(r => {
                resolveFirstStream = r;
            });
            let resolveSecondStreamDone!: () => void;
            const secondStreamDone = new Promise<void>(r => {
                resolveSecondStreamDone = r;
            });

            vi.spyOn(WorkspaceConfigClient.getInstance(), 'fetchWorkspaceConfig').mockResolvedValue({
                workspaceRoot: '/tmp/ws',
                rules: [],
                customSkills: [],
                customMcpServers: []
            } as FullWorkspaceConfig);

            vi.spyOn(GeminiClient.getInstance(), 'streamGenerate').mockImplementation(async (req, onEvent) => {
                requests.push(req);
                if (requests.length === 1) {
                    onEvent({ type: 'delta', text: 'Built the hero turbine mesh.' });
                    await firstStreamGate;
                } else {
                    onEvent({ type: 'delta', text: 'Applied brushed titanium material to the blades.' });
                    resolveSecondStreamDone();
                }
            });

            const firstTurnPromise = studio.hook.sendMessage('Build a 12-blade hero turbine');
            // Wait a tick for streamGenerate to start
            await new Promise(r => setTimeout(r, 10));
            expect(studio.state.isGenerating).toBe(true);

            // Queue two follow-up messages while the first turn is still running
            studio.hook.queueMessage('Give the blades brushed titanium');
            studio.hook.queueMessage('Cancel me before running');
            expect(studio.hook.queuedMessages.length).toBe(2);
            expect(studio.hook.queuedMessages[0].text).toBe('Give the blades brushed titanium');

            // Remove the second queued message
            studio.hook.removeQueuedMessage(studio.hook.queuedMessages[1].id);
            expect(studio.hook.queuedMessages.length).toBe(1);

            // Finish the first stream; the remaining queued prompt should drain automatically
            resolveFirstStream();
            await firstTurnPromise;
            await secondStreamDone;
            await new Promise(r => setTimeout(r, 40));

            expect(requests.length).toBe(2);
            expect(requests[0].prompt).toContain('Build a 12-blade hero turbine');
            expect(requests[1].prompt).toContain('Give the blades brushed titanium');
            expect(studio.hook.queuedMessages.length).toBe(0);
            expect(studio.state.messages.map(m => `${m.sender}:${m.text}`)).toEqual([
                'user:Build a 12-blade hero turbine',
                'assistant:Built the hero turbine mesh.',
                'user:Give the blades brushed titanium',
                'assistant:Applied brushed titanium material to the blades.'
            ]);
        });

        it('keeps the Composer textarea enabled during generation when queueMessage is provided and renders the Queue button + pills', () => {
            let queuedCalls = 0;
            let stopCalls = 0;
            const html = renderToStaticMarkup(
                React.createElement(
                    Composer,
                    makeComposerProps({
                        isGenerating: true,
                        canStop: true,
                        inputValue: 'Add bevel to the outer rim',
                        queueMessage: () => {
                            queuedCalls++;
                        },
                        queuedMessages: [
                            { id: 'q-1', text: 'Switch render mode to PBR', queuedAt: '12:01 PM' }
                        ],
                        stopGenerating: () => {
                            stopCalls++;
                        }
                    })
                )
            );

            expect(html).toContain('Queued (1):');
            expect(html).toContain('Switch render mode to PBR');
            expect(html).toContain('aria-label="Queue follow-up message"');
            expect(html).toContain('aria-label="Stop generating"');
            expect(html).not.toContain('<textarea disabled=""');
            expect(queuedCalls).toBe(0);
            expect(stopCalls).toBe(0);
        });
    });

    describe('Pillar 2: Closed-Loop 3D Geometry Verification', () => {
        it('extracts geometry metrics from 3D tool result payloads and verifies topology invariants', () => {
            const extracted = extractGeometryVerificationInput({
                status: 'success',
                glbPath: '/tmp/turbine.glb',
                vertexCount: 28400,
                triangleCount: 54200,
                bounds: { min: [-2.5, 0, -2.5], max: [2.5, 4.2, 2.5] },
                isManifold: true
            });
            expect(extracted).toEqual({
                vertexCount: 28400,
                triangleCount: 54200,
                bounds: { min: [-2.5, 0, -2.5], max: [2.5, 4.2, 2.5] },
                isManifold: true
            });

            // Ignore error payloads
            expect(extractGeometryVerificationInput({ error: 'Clang failed', vertexCount: 0, triangleCount: 0 })).toBeUndefined();

            const verifier = new AgentVerificationService(
                new LspDiagnosticFeedbackService(),
                new ContainerSandboxService()
            );
            const passOutcome = verifier.verifyGeometry(extracted!);
            expect(passOutcome.passed).toBe(true);
            expect(passOutcome.geometryVerification?.vertexCount).toBe(28400);

            const failUnderground = verifier.verifyGeometry({
                vertexCount: 1200,
                triangleCount: 2400,
                bounds: { min: [-5, -10, -5], max: [5, -1, 5] },
                enforcePositiveYMax: true
            });
            expect(failUnderground.passed).toBe(false);
            expect(failUnderground.summary).toContain('maxY=-1');
        });
    });

    describe('Pillar 3: Spatial & Temporal @Context Mentions (@scene, @mesh, @camera, @timeline)', () => {
        const sceneArtifact: CanvasArtifact = {
            id: 'art-scene-1',
            type: '3d-scene',
            title: 'Staged Plaza District',
            summary: 'Staged location build',
            createdAt: '2026-10-29T12:00:00Z',
            version: 2,
            data: {
                title: 'Staged Plaza District',
                renderMode: 'pbr',
                selectedMeshId: 'mesh-spire',
                camera: {
                    position: [14.2, 18.5, 32.0],
                    target: [0, 6.0, 0],
                    fov: 38
                },
                environment: {
                    skybox: 'studio',
                    lighting: 'studio'
                },
                customMeshes: [
                    {
                        id: 'mesh-podium',
                        name: 'Limestone Podium',
                        type: 'custom',
                        position: [0, 0, 0],
                        rotation: [0, 0, 0],
                        scale: [1, 1, 1],
                        material: { color: '#d8d2c5', roughness: 0.75, metalness: 0.05 }
                    },
                    {
                        id: 'mesh-spire',
                        name: 'Copper Spire Crown',
                        type: 'custom',
                        position: [0, 24, 0],
                        rotation: [0, 0, 0],
                        scale: [1, 1, 1],
                        material: { color: '#4c7a67', roughness: 0.42, metalness: 0.65 }
                    }
                ],
                timeline: {
                    durationMs: 12000,
                    currentTimeMs: 3500,
                    isPlaying: false,
                    tracks: [{
                        id: 'track-3d', name: 'Spire', type: '3d', locked: false, visible: true,
                        elements: [{
                            id: 'el-spire', name: 'Spire rise', type: '3d', startTime: 0, duration: 12, trimStart: 0, trimEnd: 0,
                            keyframes: { y: [{ id: 'kf-1', time: 0, value: 0 }, { id: 'kf-2', time: 6, value: 24 }] }
                        }]
                    }]
                }
            } as Scene3DData
        };

        it('registers @scene, @mesh, @camera, and @timeline tags and parses aliases', () => {
            expect(CONTEXT_MENTION_TAGS).toEqual(expect.arrayContaining(['scene', 'mesh', 'camera', 'timeline']));

            const parsed = parseContextMentions('Match @cam:hero to @object:spire and align @clip:intro on @3d:plaza');
            expect(parsed.mentions.map(p => p.type)).toEqual(['camera', 'mesh', 'timeline', 'scene']);
        });

        it('resolves live 3D scene, selected mesh first, camera pose, and timeline state from activeArtifact', () => {
            const sceneItems = resolveContextMentionQuery('scene', '', [], undefined, [], sceneArtifact);
            expect(sceneItems.length).toBeGreaterThan(0);
            expect(sceneItems[0].name).toContain('scene: Staged Plaza District');
            expect(sceneItems[0].detail).toContain('"selectedMeshId":"mesh-spire"');

            const meshItems = resolveContextMentionQuery('mesh', '', [], undefined, [], sceneArtifact);
            expect(meshItems.length).toBe(2);
            // Selected mesh in the viewport is prioritized first
            expect(meshItems[0].id).toContain('mesh-spire');
            expect(meshItems[0].name).toContain('(selected)');

            const cameraItems = resolveContextMentionQuery('camera', '', [], undefined, [], sceneArtifact);
            expect(cameraItems.length).toBe(1);
            expect(cameraItems[0].name).toContain('38° FOV');
            expect(cameraItems[0].detail).toContain('14.2');

            const timelineItems = resolveContextMentionQuery('timeline', '', [], undefined, [], sceneArtifact);
            expect(timelineItems.length).toBeGreaterThan(0);
            expect(timelineItems[0].name).toContain('3.50s / 12.00s');
            expect(timelineItems[0].description).toBe('1 track • 2 keyframes');
        });

        it('resolves NLE video-timeline clips and playhead frame when a video-timeline artifact is active', () => {
            const videoArtifact: CanvasArtifact = {
                id: 'art-video-1',
                type: 'video-timeline',
                title: 'Hero Reveal Cut',
                summary: 'NLE timeline',
                createdAt: '2026-10-29T12:00:00Z',
                version: 1,
                data: {
                    title: 'Hero Reveal Cut',
                    duration: 8,
                    currentTime: 2.0,
                    fps: 24,
                    aspectRatio: '16:9',
                    zoom: 40,
                    mediaAssets: [],
                    tracks: [
                        {
                            id: 'track-v1',
                            name: 'V1 Plate',
                            type: 'video',
                            locked: false,
                            visible: true,
                            elements: [
                                { id: 'clip-1', name: 'Matchmove_Blockout.mp4', type: 'video', startTime: 0, duration: 4, trimStart: 0, trimEnd: 4 }
                            ]
                        }
                    ]
                } satisfies VideoTimelineData
            };

            const timelineItems = resolveContextMentionQuery('timeline', '', [], undefined, [], videoArtifact);
            expect(timelineItems.length).toBe(2);
            expect(timelineItems[0].name).toContain('frame 48');
            expect(timelineItems[1].name).toContain('clip: Matchmove_Blockout.mp4');
        });
    });

    describe('Pillar 4: Tool-Call Node Graph Parity for 3D & VFX Tools', () => {
        it('treats execute_3d_python_script, scene_3d_dispatch_operators, and audit_3d_scene_viewport as runnable graph nodes while excluding UI meta tools', async () => {
            expect(isRunnableChatToolName('execute_3d_python_script')).toBe(true);
            expect(isRunnableChatToolName('scene_3d_dispatch_operators')).toBe(true);
            expect(isRunnableChatToolName('audit_3d_scene_viewport')).toBe(true);

            for (const metaTool of CHAT_UI_META_TOOLS) {
                expect(isRunnableChatToolName(metaTool)).toBe(false);
            }

            vi.spyOn(ToolNodeClient.getInstance(), 'listTools').mockResolvedValue([
                { name: 'execute_3d_python_script', description: 'Run 3D Python', pack: 'Canvas', parameters: [] },
                { name: 'scene_3d_dispatch_operators', description: 'Dispatch 3D operators', pack: 'Canvas', parameters: [] },
                { name: 'audit_3d_scene_viewport', description: 'Audit 3D viewport', pack: 'Canvas', parameters: [] },
                { name: 'mount_canvas_primitive', description: 'Mount card', pack: 'Canvas', parameters: [] }
            ] as any);

            const execs: McpExecutionState[] = [
                makeExec({
                    id: 'call-py',
                    toolName: 'execute_3d_python_script',
                    args: { script_code: 'import scratchbox as sb' },
                    resultFields: { glbPath: '/tmp/arch.glb', vertexCount: 32000 }
                }),
                makeExec({
                    id: 'call-op',
                    toolName: 'scene_3d_dispatch_operators',
                    args: { meshPath: '/tmp/arch.glb', operators: [] },
                    resultFields: { glbPath: '/tmp/arch_bevel.glb' }
                }),
                makeExec({
                    id: 'call-audit',
                    toolName: 'audit_3d_scene_viewport',
                    args: { glbPath: '/tmp/arch_bevel.glb' },
                    resultFields: { passed: true }
                }),
                makeExec({
                    id: 'call-mount',
                    toolName: 'mount_canvas_primitive',
                    args: { type: '3d-scene' }
                })
            ];

            expect(hasGraphableToolCalls(execs)).toBe(true);
            const { artifact: graphArtifact, graph } = await buildToolCallGraphArtifact(execs, 'Arch Build');
            expect(graphArtifact).toBeDefined();
            expect(graph.nodes.length).toBe(3);
            expect(graph.edges.length).toBeGreaterThanOrEqual(2);
            expect((graphArtifact.data as any).nodes.length).toBe(3);
        });
    });

    describe('Pillar 5: Multi-Turn Structured Tool Result & Card Memory', () => {
        it('preserves structured resultFields (glbPath, vertexCount) and questionCard context in multi-turn chatHistory', async () => {
            const studio = createTestStudio();
            studio.deps.messages = [
                {
                    id: 'm-1',
                    sender: 'user',
                    text: 'Generate the turbine housing',
                    timestamp: '12:00'
                },
                {
                    id: 'm-2',
                    sender: 'assistant',
                    text: 'Generated the turbine housing.',
                    timestamp: '12:01',
                    mcpExecutions: [
                        makeExec({
                            toolName: 'execute_3d_python_script',
                            summaryResult: 'Compiled housing mesh',
                            resultFields: {
                                glbPath: '/tmp/sb_housing_01.glb',
                                vertexCount: 31400,
                                triangleCount: 62800
                            }
                        })
                    ],
                    questionCard: {
                        id: 'q-mat',
                        title: 'Housing Finish',
                        questions: [
                            {
                                id: 'finish',
                                prompt: 'Which surface finish should we apply?',
                                options: [
                                    { id: 'anodized', label: 'Anodized Aluminium' },
                                    { id: 'ceramic', label: 'Matte Ceramic' }
                                ]
                            }
                        ]
                    }
                }
            ];

            let capturedRequest: GeminiGenerateRequest | undefined;
            vi.spyOn(WorkspaceConfigClient.getInstance(), 'fetchWorkspaceConfig').mockResolvedValue({
                workspaceRoot: '/tmp/ws',
                rules: [],
                customSkills: [],
                customMcpServers: []
            } as FullWorkspaceConfig);
            vi.spyOn(GeminiClient.getInstance(), 'streamGenerate').mockImplementation(async (req, onEvent) => {
                capturedRequest = req;
                onEvent({ type: 'delta', text: 'Applying Anodized Aluminium to /tmp/sb_housing_01.glb.' });
            });

            await studio.hook.sendMessage('Use Anodized Aluminium');
            expect(capturedRequest).toBeDefined();
            const assistantHistoryTurn = capturedRequest!.chatHistory?.find(h => h.role === 'model');
            expect(assistantHistoryTurn).toBeDefined();
            expect(assistantHistoryTurn!.text).toContain('/tmp/sb_housing_01.glb');
            expect(assistantHistoryTurn!.text).toContain('"vertexCount":31400');
            expect(assistantHistoryTurn!.text).toContain('[Clarification Questions Asked: Which surface finish should we apply?]');
        });
    });

    describe('Pillar 6: Tri-Directional Viewport <-> Agent State Sync', () => {
        it('projects selectedMeshId, timeline playhead, recentOperators, and recentActions into the agent prompt', () => {
            const sceneData: Scene3DData = {
                title: 'Kinetic Rig Scene',
                renderMode: 'pbr',
                toolMode: 'translate',
                selectedMeshId: 'rotor-hub',
                camera: { position: [5, 5, 10], target: [0, 1, 0], fov: 45 },
                environment: { skybox: 'studio', lighting: 'studio' },
                customMeshes: [
                    {
                        id: 'rotor-hub',
                        name: 'Rotor Hub',
                        type: 'custom',
                        position: [0, 1.5, 0],
                        rotation: [0, 0, 0],
                        scale: [1, 1, 1],
                        material: { color: '#88929a', roughness: 0.35, metalness: 0.85 }
                    }
                ],
                timeline: {
                    currentTimeMs: 4250,
                    durationMs: 10000,
                    isPlaying: true,
                    tracks: [{
                        id: 'track-hub', name: 'Rotor Hub', type: '3d', locked: false, visible: true,
                        elements: [{
                            id: 'el-hub', name: 'Hub spin', type: '3d', startTime: 0, duration: 10, trimStart: 0, trimEnd: 0,
                            keyframes: { yaw: [{ id: 'k1', time: 0, value: 0 }, { id: 'k2', time: 4.25, value: 180 }] }
                        }]
                    }]
                },
                operatorStack: [
                    { id: 'op-1', type: 'bevel', label: 'Chamfer Hub Rim', params: { width: 0.02 } } as any
                ],
                actionLog: [
                    { id: 'act-1', timestamp: '12:02:10', label: 'Selected Rotor Hub and translated +1.5m Y' } as any
                ]
            };

            const summary = summarizeSceneStateForAgent(sceneData);
            expect(summary.selectedMeshId).toBe('rotor-hub');
            expect((summary.customMeshes as any[])[0].selected).toBe(true);
            expect((summary.timeline as any).currentTime).toBe(4.25);
            expect((summary.timeline as any).keyframeCount).toBe(2);
            expect((summary.recentActions as any[]).length).toBe(1);
            expect(Scene3DWorldLens.summarizeSceneStateForAgent(sceneData)).toEqual(summary);

            const contents = buildContents({
                prompt: 'Bevel the selected mesh',
                activeArtifact: {
                    id: 'scene-rig',
                    type: '3d-scene',
                    title: 'Kinetic Rig Scene',
                    summary: '',
                    createdAt: 'now',
                    version: 1,
                    data: sceneData
                }
            });
            const lastUserText = (contents[contents.length - 1].parts?.[0] as any)?.text || '';
            expect(lastUserText).toContain('"selectedMeshId":"rotor-hub"');
            expect(lastUserText).toContain('"currentTime":4.25');
            expect(lastUserText).toContain('Selected Rotor Hub and translated +1.5m Y');
        });
    });

    describe('Pillar 7: Composer Bare-Trigger Guard & Recovered Retry Status', () => {
        it('intercepts bare "/" and "@" submissions and opens the autocomplete popover without calling the backend', async () => {
            const studio = createTestStudio();
            const streamSpy = vi.spyOn(GeminiClient.getInstance(), 'streamGenerate');

            await studio.hook.sendMessage('/');
            expect(streamSpy).not.toHaveBeenCalled();
            expect(studio.state.autocompleteType).toBe('skill');

            await studio.hook.sendMessage('@');
            expect(streamSpy).not.toHaveBeenCalled();
            expect(studio.state.autocompleteType).toBe('context');
        });

        it('distinguishes recovered tool retries from unrecovered failures in grouped tool headers', () => {
            const recoveredRun: McpExecutionState[] = [
                makeExec({ id: 'c1', toolName: 'execute_3d_python_script', status: 'failed' }),
                makeExec({ id: 'c2', toolName: 'execute_3d_python_script', status: 'completed' }),
                makeExec({ id: 'c3', toolName: 'audit_3d_scene_viewport', status: 'completed' })
            ];
            const recoveredSummary = summarizeGroupedToolStatus(recoveredRun);
            expect(recoveredSummary.hasUnrecoveredFailure).toBe(false);
            expect(recoveredSummary.retriedCount).toBe(1);
            expect(recoveredSummary.completedCount).toBe(2);
            expect(recoveredSummary.statusText).toBe('✓ 2 Completed (1 retried)');

            const unrecoveredRun: McpExecutionState[] = [
                makeExec({ id: 'c1', toolName: 'execute_3d_python_script', status: 'completed' }),
                makeExec({ id: 'c2', toolName: 'execute_3d_python_script', status: 'failed' })
            ];
            const unrecoveredSummary = summarizeGroupedToolStatus(unrecoveredRun);
            expect(unrecoveredSummary.hasUnrecoveredFailure).toBe(true);
            expect(unrecoveredSummary.statusText).toBe('Failed');
        });
    });
});
