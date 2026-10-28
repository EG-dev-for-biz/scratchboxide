/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as React from 'react';
import {
    GraphEdge,
    GraphNode,
    NodeGraphData,
    AccentColor,
    GraphNodeCategory,
    McpExecutionState,
    Scene3DData,
    SceneDisplayFlag
} from '../canvas-types';
import {
    IconClose,
    IconInfo,
    IconSparkles,
    IconZap,
    IconTerminal,
    IconDatabase,
    IconFork,
    IconMcp,
    IconPlay,
    IconPause,
    IconStepForward,
    IconTrash,
    IconEdit,
    IconCode,
    IconCheck,
    Icon3D,
    IconCamera3D,
    IconMap3D,
    IconStudioMcp,
    IconImage,
    IconVideo,
    IconMic
} from '../canvas-icons';
import { MediaGenerationClient } from '../media-generation-client';
import { ToolNodeClient } from '../tool-node-client';
import { patchGraphNode, sanitizeNodeGraph, toolNodeRuns } from '../tool-node-runs';
import { graphHistories, recordGraphEdit, redoGraphEdit, undoGraphEdit } from '../graph-edit-history';
import type { ToolNodeCatalogEntry } from '../../../common/tool-node-protocol';
import { compactResultFields, isToolNode, resolveToolNodeArgs, toolNodeLabel, toolNodeParameters, toolRunOrder } from '../../../common/tool-node-graph';
import { refreshSceneNodeGraph } from '../scene-node-graph';
import { displayFlagFor, withDisplayFlag, withStepToggle } from '../scene-display-flag';
import { DisplayFlagToggle, SceneOutputBody, StepSwitch } from './SceneOutputParts';
import { ParamPanel } from './ParamControls';
import { applySceneNodeParam, sceneNodeFields } from '../scene-node-params';
import { resolveModeForArtifact } from '../guardrails-service';
import { OTHER_TOOLS, TOOL_TASK_GROUPS, taskGroupOf } from '../tool-task-groups';
import { useOptionalStudioActions, useOptionalStudioState } from '../state/StudioContext';
import { ToolNodeCardBody, ToolNodeInspector } from './ToolNodeParts';
import { useMediaJobPoller } from '../hooks/useMediaJobPolling';
import { IMAGE_MODEL_PRIORITY, VIDEO_MODEL_PRIORITY, resolveImageModelId, substitutedModelNote } from '../../../common/media-generation-protocol';
import { MediaModelNotice } from '../chat/MediaCards';

export interface NodeGraphPrimitiveProps {
    data: NodeGraphData;
    onUpdate?: (updatedData: NodeGraphData) => void;
    onPromptAction?: (promptText: string) => void;
    workspacePath?: string;
    /** The graph's artifact id: a tool run that finishes after the graph left the stage writes its result there. */
    artifactId?: string;
}


const ACCENT_COLORS: { color: AccentColor; label: string; hex: string }[] = [
    { color: 'blue', label: 'Blue', hex: 'var(--sb-system-blue, #007aff)' },
    { color: 'indigo', label: 'Indigo', hex: 'var(--sb-system-indigo, #5856d6)' },
    { color: 'purple', label: 'Purple', hex: 'var(--sb-system-purple, #af52de)' },
    { color: 'emerald', label: 'Emerald', hex: 'var(--sb-system-emerald, #34c759)' },
    { color: 'amber', label: 'Amber', hex: 'var(--sb-system-amber, #ff9500)' },
    { color: 'rose', label: 'Rose', hex: 'var(--sb-system-rose, #ff2d55)' },
    { color: 'cyan', label: 'Cyan', hex: 'var(--sb-system-cyan, #32ade6)' }
];

const NODE_CARD_WIDTH = 240;

/**
 * Overlaid at the bottom of an image or video node's preview: the generation error, or, when a model other than
 * the node's own produced the output, which one did and why.
 */
export const NodeMediaStatus: React.FC<{ node: GraphNode }> = ({ node }) => {
    if (node.parameters?.isGenerating) return null;
    const overlay: React.CSSProperties = { position: 'absolute', left: 4, right: 4, bottom: 4, zIndex: 2 };
    if (node.parameters?.generationError) {
        return (
            <div data-testid="sb-node-media-error" role="alert" title={node.parameters.generationError} style={{
                ...overlay, fontSize: '10.5px', lineHeight: 1.35, color: '#fecaca', background: 'rgba(127, 29, 29, 0.75)',
                borderRadius: '6px', padding: '3px 6px', overflowWrap: 'anywhere', maxHeight: '60%', overflow: 'hidden'
            }}>
                {node.parameters.generationError}
            </div>
        );
    }
    return <MediaModelNotice note={node.parameters?.modelNote} style={{ ...overlay, background: 'rgba(69, 26, 3, 0.85)', maxHeight: '60%', overflow: 'hidden' }} />;
};

/**
 * The parameters a finished media job writes onto its node, merged over the node's parameters as they are when the
 * job ends. A success clears any error left by an earlier run; a failure clears the previous output's model note
 * (the error is what the node shows now).
 */
export function mediaJobOutcomeParameters(
    current: Record<string, any> | undefined,
    outcome: { resultUrl: string; result?: Parameters<typeof substitutedModelNote>[0] & { modelUsed?: string } } | { error: string }
): Record<string, any> {
    if ('error' in outcome) {
        return { ...current, isGenerating: false, generationError: outcome.error, modelNote: undefined };
    }
    const { resultUrl, result } = outcome;
    return {
        ...current,
        isGenerating: false,
        generationError: undefined,
        mediaUrl: resultUrl,
        imageUrl: resultUrl,
        videoUrl: resultUrl,
        audioUrl: resultUrl,
        // Which model made the output; the note is shown on the node when it is not the node's model.
        generatedBy: result?.modelUsed,
        modelNote: substitutedModelNote(result)
    };
}

const getNodePort = (node: GraphNode) => {
    let nodeHeight = node.notes ? 126 : 96;
    if (node.category === 'scene-3d' || node.category === '3d-card') {
        nodeHeight = 310;
    } else if (node.category === 'camera-3d') {
        nodeHeight = 220;
    } else if (node.category === 'map-3d') {
        nodeHeight = 200;
    } else if (node.category === 'studio-mcp') {
        nodeHeight = 180;
    } else if (node.category === 'image' || node.category === 'image-card') {
        nodeHeight = 290;
    } else if (node.category === 'video' || node.category === 'video-card') {
        nodeHeight = 290;
    } else if (node.category === 'audio' || node.category === 'audio-card') {
        nodeHeight = 250;
    }
    const portY = node.y + nodeHeight / 2;
    return {
        input: { x: node.x, y: portY },
        output: { x: node.x + NODE_CARD_WIDTH, y: portY }
    };
};

const getNodeCategoryIcon = (category?: GraphNodeCategory) => {
    switch (category) {
        case 'input':
            return <IconZap size={13} strokeWidth={2} />;
        case 'ai':
            return <IconSparkles size={13} strokeWidth={1.8} />;
        case 'decision':
            return <IconFork size={13} strokeWidth={1.8} />;
        case 'mcp':
            return <IconMcp size={13} strokeWidth={1.8} />;
        case 'cli':
            return <IconTerminal size={13} strokeWidth={1.8} />;
        case 'database':
            return <IconDatabase size={13} strokeWidth={1.8} />;
        case 'output':
            return <IconCheck size={13} strokeWidth={2} />;
        case 'scene-3d':
        case '3d-card':
            return <Icon3D size={13} strokeWidth={1.8} />;
        case 'camera-3d':
            return <IconCamera3D size={13} strokeWidth={1.8} />;
        case 'map-3d':
            return <IconMap3D size={13} strokeWidth={1.8} />;
        case 'studio-mcp':
            return <IconStudioMcp size={13} strokeWidth={1.8} />;
        case 'image':
        case 'image-card':
            return <IconImage size={13} strokeWidth={1.8} />;
        case 'video':
        case 'video-card':
            return <IconVideo size={13} strokeWidth={1.8} />;
        case 'audio':
        case 'audio-card':
            return <IconMic size={13} strokeWidth={1.8} />;
        case 'process':
        default:
            return <IconCode size={13} strokeWidth={1.8} />;
    }
};

const IconBoxes: React.FC<{ size?: number; className?: string }> = ({ size = 15, className = '' }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className}>
        <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
        <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
        <line x1="12" y1="22.08" x2="12" y2="12" />
    </svg>
);

interface LibraryItem {
    id: string;
    label: string;
    subtitle: string;
    category: GraphNodeCategory;
    color: AccentColor;
    description: string;
    icon: React.ReactNode;
    parameters?: Record<string, any>;
    notes?: string;
}

const LIBRARY_SECTIONS: { title: string; items: LibraryItem[] }[] = [
    {
        title: 'Core Elements',
        items: [
            {
                id: 'core-box-frame',
                label: 'Box (Frame)',
                subtitle: 'Procedural Box Frame',
                category: 'process' as GraphNodeCategory,
                color: 'indigo' as AccentColor,
                description: 'Define a layout group region',
                icon: <IconCode size={13} strokeWidth={1.8} />,
                parameters: { meshType: 'frame' }
            },
            {
                id: 'core-sticky-note',
                label: 'Text (Sticky Note)',
                subtitle: 'Specification Note',
                category: 'process' as GraphNodeCategory,
                color: 'amber' as AccentColor,
                description: 'Add comments or specifications',
                icon: <IconCode size={13} strokeWidth={1.8} />,
                notes: 'Double click to edit sticky notes',
                parameters: {}
            },
            {
                id: 'core-relational-edge',
                label: 'Relational Edge',
                subtitle: 'Logical Connection',
                category: 'process' as GraphNodeCategory,
                color: 'blue' as AccentColor,
                description: 'Logical connector bridge',
                icon: <IconFork size={13} strokeWidth={1.8} />,
                parameters: { type: 'bridge' }
            }
        ]
    },
    {
        title: 'Creative Media & AI',
        items: [
            {
                id: 'ai-processor',
                label: 'AI Processor',
                subtitle: 'Gemini 3.8 Flash & Subagents',
                category: 'ai' as GraphNodeCategory,
                color: 'purple' as AccentColor,
                description: 'Run LLM reasoning and code generation steps',
                icon: <IconSparkles size={13} strokeWidth={1.8} />,
                parameters: { model: 'gemini-3.8-flash', temperature: 0.2 }
            },
            {
                id: 'decision-gate',
                label: 'Decision Gate',
                subtitle: 'Condition Check',
                category: 'decision' as GraphNodeCategory,
                color: 'amber' as AccentColor,
                description: 'Branch execution with conditional logic expressions',
                icon: <IconFork size={13} strokeWidth={1.8} />,
                parameters: { conditionType: 'expression', rule: 'payload.confidence > 0.85' }
            },
            {
                id: 'image-generator',
                label: 'Image Generator (Nano Banana 2)',
                subtitle: 'Nano Banana 2 (Google)',
                category: 'ai' as GraphNodeCategory,
                color: 'purple' as AccentColor,
                description: 'Synthesize images using Google Nano Banana 2',
                icon: <IconSparkles size={13} strokeWidth={1.8} />,
                parameters: { generatorType: 'nano-banana-2', model: 'gemini-3.1-flash-image', prompt: 'Cinematic masterwork composition' }
            },
            {
                id: 'image-editor',
                label: 'Image Editor (Nano Banana 2)',
                subtitle: 'Nano Banana 2 Edit (Google)',
                category: 'image-card' as GraphNodeCategory,
                color: 'purple' as AccentColor,
                description: 'Edit, inpaint, or restyle images via Google Nano Banana 2 endpoint',
                icon: <IconEdit size={13} strokeWidth={1.8} />,
                parameters: { generatorType: 'nano-banana-2-edit', model: 'gemini-3.1-flash-image', prompt: 'Restyle with dramatic cinematic lighting' }
            },
            {
                id: 'video-synthesizer',
                label: 'Video Synthesizer (Omni 1.1)',
                subtitle: 'Google Omni 1.1 Video',
                category: 'ai' as GraphNodeCategory,
                color: 'purple' as AccentColor,
                description: 'Generate rich cinematic videos on the canvas via Google Omni 1.1',
                icon: <IconSparkles size={13} strokeWidth={1.8} />,
                parameters: { generatorType: 'google-omni-video', model: 'google/omni-1.1', durationSeconds: 6 }
            },
            {
                id: 'omni-product-studio',
                label: 'Product Studio (Omni 1.1)',
                subtitle: 'Google Omni 1.1 Product Video',
                category: 'video-card' as GraphNodeCategory,
                color: 'rose' as AccentColor,
                description: 'Generate studio-grade product reveal video from product and setting references via Google Omni 1.1',
                icon: <IconVideo size={13} strokeWidth={1.8} />,
                parameters: { generatorType: 'omni-product', model: 'google/omni-1.1', toolId: 'omni-product', prompt: 'Cinematic product reveal on polished surface' }
            },
            {
                id: 'tts-audio',
                label: 'TTS Audio Generator',
                subtitle: 'Voice Synthesizer',
                category: 'process' as GraphNodeCategory,
                color: 'indigo' as AccentColor,
                description: 'Convert text to realistic voice speech audio',
                icon: <IconCode size={13} strokeWidth={1.8} />,
                parameters: { audioType: 'speech' }
            },
            {
                id: '3d-scene',
                label: '3D Scene Node',
                subtitle: 'Spatial 3D Scene',
                category: 'scene-3d' as GraphNodeCategory,
                color: 'cyan' as AccentColor,
                description: 'Start an editable 3D Composition scene',
                icon: <Icon3D size={13} strokeWidth={1.8} />,
                parameters: { meshType: 'cube', skybox: 'sunset', position: { x: 0, y: 0, z: 0 }, environment: 'studio' }
            },
            {
                id: '3d-camera',
                label: '3D Camera Sequencer',
                subtitle: 'Camera Animation Sequencer',
                category: 'camera-3d' as GraphNodeCategory,
                color: 'rose' as AccentColor,
                description: 'Animate coordinates and path frames',
                icon: <IconCamera3D size={13} strokeWidth={1.8} />,
                parameters: { pathType: 'bezier', durationSeconds: 5, loop: true, keyframesCount: 4 }
            },
            {
                id: 'geo-spatial-map',
                label: 'Geo Spatial 3D Map',
                subtitle: 'Google Photorealistic Tiles',
                category: 'map-3d' as GraphNodeCategory,
                color: 'emerald' as AccentColor,
                description: 'Render Photorealistic 3D cityscapes',
                icon: <IconMap3D size={13} strokeWidth={1.8} />,
                parameters: { latitude: 37.7749, longitude: -122.4194, zoom: 17, style: 'realistic', poiEnabled: true }
            }
        ]
    },
    {
        title: 'Connections & Integrations',
        items: [
            {
                id: 'mcp-endpoint',
                label: 'MCP Endpoint',
                subtitle: 'Stripe & GitHub Tools',
                category: 'mcp' as GraphNodeCategory,
                color: 'indigo' as AccentColor,
                description: 'Consume MCP tools like Stripe or GitHub',
                icon: <IconMcp size={13} strokeWidth={1.8} />,
                parameters: { server: 'mcp-stripe', tool: 'get_balance', timeoutMs: 5000 }
            },
            {
                id: 'studio-mcp',
                label: 'Studio MCP Node',
                subtitle: 'Scratchbox Studio Connector',
                category: 'studio-mcp' as GraphNodeCategory,
                color: 'indigo' as AccentColor,
                description: 'Link to high-fidelity Scratchbox Studio servers',
                icon: <IconStudioMcp size={13} strokeWidth={1.8} />,
                parameters: { targetEndpoint: 'mcp://localhost:4000', activeTools: ['scene3d_create'], activeConnections: 2 }
            },
            {
                id: 'database-action',
                label: 'Database Action',
                subtitle: 'Postgres / Vector Store Query',
                category: 'database' as GraphNodeCategory,
                color: 'cyan' as AccentColor,
                description: 'Query SQL tables or Vector stores',
                icon: <IconDatabase size={13} strokeWidth={1.8} />,
                parameters: { database: 'postgresql', operation: 'SELECT', table: 'events' }
            },
            {
                id: 'cli-script',
                label: 'CLI Script',
                subtitle: 'Isolated Script Action',
                category: 'cli' as GraphNodeCategory,
                color: 'emerald' as AccentColor,
                description: 'Execute isolated terminal script actions',
                icon: <IconTerminal size={13} strokeWidth={1.8} />,
                parameters: { command: 'yarn test', cwd: './extensions/product', sandbox: true }
            }
        ]
    }
];

export const NodeGraphPrimitive: React.FC<NodeGraphPrimitiveProps> = ({
    data,
    onUpdate,
    onPromptAction,
    workspacePath,
    artifactId
}) => {
    // a scene's graph opens on the scene's nodes; the library is a click away (an automation graph opens on it)
    const [showLibraryPanel, setShowLibraryPanel] = React.useState<boolean>(() => !data?.stageViewOf);
    const [libraryGroup, setLibraryGroup] = React.useState<string | undefined>(undefined);
    const [librarySearchQuery, setLibrarySearchQuery] = React.useState<string>('');
    const mediaJobPoller = useMediaJobPoller();

    const sanitizeGraph = sanitizeNodeGraph;

    const viewportRef = React.useRef<HTMLDivElement>(null);
    const [graph, setGraph] = React.useState<NodeGraphData>(() => sanitizeGraph(data));
    // The latest graph, for updates that land after an await (media jobs): those must merge into the graph as it is
    // then, not as it was when the job started, or they would bring back stale state (an old error) and drop edits.
    const graphRef = React.useRef<NodeGraphData>(graph);
    graphRef.current = graph;

    // Tool nodes: every chat tool, listed in the library from the backend catalog and run through the same handlers
    const [toolCatalog, setToolCatalog] = React.useState<ToolNodeCatalogEntry[]>([]);
    const [toolCatalogError, setToolCatalogError] = React.useState<string | undefined>(undefined);
    const studioActions = useOptionalStudioActions();
    const studioState = useOptionalStudioState();
    const latestStudioState = React.useRef(studioState);
    latestStudioState.current = studioState;
    const graphKey = artifactId || graph.title;

    // Undo / redo of the user's edits (graph-edit-history.ts); tool-run status updates are not steps
    const [, setHistoryTick] = React.useState(0);
    const recordEdit = (before: NodeGraphData, after: NodeGraphData, mergeKey?: string) => {
        graphHistories.set(graphKey, recordGraphEdit(graphHistories.get(graphKey), before, after, mergeKey));
        setHistoryTick(t => t + 1);
    };
    const stepHistory = (direction: 'undo' | 'redo') => {
        const h = graphHistories.get(graphKey);
        const step = direction === 'undo' ? undoGraphEdit(h, graphRef.current) : redoGraphEdit(h, graphRef.current);
        if (!step) return false;
        graphHistories.set(graphKey, step.history);
        graphRef.current = step.graph;
        setGraph(step.graph);
        setSelectedNodeId(undefined);
        setSelectedEdgeId(undefined);
        setHistoryTick(t => t + 1);
        onUpdate?.(step.graph);
        return true;
    };
    const dragStartGraph = React.useRef<NodeGraphData | undefined>(undefined);
    const mountedRef = React.useRef(true);
    React.useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; }; }, []);
    // progress lines while a tool works: shown on its card, never saved into the graph
    const [liveDetails, setLiveDetails] = React.useState<Record<string, string>>({});
    /** A node update that lands after the graph left the stage goes into the saved graph, without taking the stage. */
    const updateNodeAnywhere = (nodeId: string, updates: Partial<GraphNode>) => {
        if (mountedRef.current) { handleUpdateNode(nodeId, updates); return; }
        const art = artifactId ? latestStudioState.current?.artifactHistory.find(a => a.id === artifactId) : undefined;
        if (!art || !studioActions) return;
        studioActions.applyStreamedArtifact(patchGraphNode(art, nodeId, updates));
    };
    // a scene's graph follows its scene: redrawn (node positions and a stage view's own build run kept) when the scene changes
    const stageScene = graph.stageViewOf ? (studioState?.artifactHistory.find(a => a.id === graph.stageViewOf!.artifactId)
        ?? (studioState?.activeArtifact?.id === graph.stageViewOf.artifactId ? studioState.activeArtifact : undefined)) : undefined;
    // the scene's display flag: which node's result its viewport shows (none: the final scene, the Output node)
    const graphScene = stageScene?.data as Scene3DData | undefined;
    const displayFlag = graphScene?.displayFlag;
    const setDisplayFlag = (flag: SceneDisplayFlag | undefined) => {
        if (stageScene && studioActions) studioActions.applyStreamedArtifact(withDisplayFlag(stageScene, flag));
    };
    /** A build step switched on or off for the next run: saved on the scene, which redraws this graph and the build node's arguments. */
    const setStepToggle = (key: string, on: boolean) => {
        if (stageScene && studioActions) studioActions.applyStreamedArtifact(withStepToggle(stageScene, key, on));
    };
    /** A node's live parameter set in its scene: the scene's data changes, and the viewport and this graph follow. */
    const setSceneParam = (node: GraphNode, key: string, value: unknown) => {
        if (!stageScene || !studioActions || !graphScene) return;
        studioActions.applyStreamedArtifact({ ...stageScene, data: applySceneNodeParam(graphScene, node, key, value) });
    };
    const openViewport = stageScene && studioActions ? () => {
        studioActions.setActiveArtifact(stageScene);
        studioActions.setLayoutMode(resolveModeForArtifact(stageScene.type));
    } : undefined;
    React.useEffect(() => {
        if (!stageScene) return;
        const updated = refreshSceneNodeGraph(graphRef.current, stageScene);
        if (!updated) return;
        graphRef.current = updated;
        setGraph(updated);
        onUpdate?.(updated);
    }, [stageScene]);
    // a graph back on stage picks up its runs that went on while it was away
    const [runningToolNodes, setRunningToolNodes] = React.useState<string[]>(() =>
        toolNodeRuns.runningNodes(artifactId || data?.title));
    const [toolFlowRunning, setToolFlowRunning] = React.useState(false);
    React.useEffect(() => {
        let live = true;
        ToolNodeClient.getInstance().listTools()
            .then(tools => { if (live) { setToolCatalog(tools); setToolCatalogError(undefined); } })
            .catch(err => { if (live) setToolCatalogError(err instanceof Error ? err.message : String(err)); });
        return () => { live = false; };
    }, []);
    const toolEntry = (node: GraphNode) => toolCatalog.find(t => t.name === node.parameters?.toolName);
    // a scene's graph or a graph of tool nodes is a 3D graph: real runs, the 3D library, no automation presets
    const is3DGraph = !!graph.stageViewOf || graph.nodes.some(isToolNode);
    const toolRunStatus = (() => {
        const tools = graph.nodes.filter(isToolNode);
        if (runningToolNodes.length) return `Running: ${runningToolNodes.map(id => graph.nodes.find(n => n.id === id)?.label || id).join(', ')}`;
        if (!tools.length) return graph.stageViewOf ? 'Scene graph' : 'No tool nodes';
        const done = tools.filter(n => n.status === 'completed').length, failed = tools.filter(n => n.status === 'error').length;
        return `${done} of ${tools.length} tool node${tools.length === 1 ? '' : 's'} done${failed ? `, ${failed} failed` : ''}`;
    })();
    const toolSections = React.useMemo(() => {
        const byPack = new Map<string, LibraryItem[]>();
        for (const tool of toolCatalog) {
            const item: LibraryItem = {
                id: `tool-${tool.name}`,
                label: toolNodeLabel(tool.name),
                subtitle: tool.name,
                category: 'tool',
                color: 'cyan',
                description: tool.description.split(/(?<=\.)\s/)[0].slice(0, 140),
                icon: <IconBoxes size={13} />,
                parameters: toolNodeParameters(tool)
            };
            byPack.set(tool.pack, [...(byPack.get(tool.pack) || []), item]);
        }
        // grouped by task, in the order 3D tools present them (tool-task-groups.ts); labels only
        const byGroup = new Map<string, LibraryItem[]>();
        for (const [pack, items] of byPack) {
            const group = taskGroupOf(pack);
            byGroup.set(group, [...(byGroup.get(group) || []), ...items]);
        }
        const order = [...TOOL_TASK_GROUPS.map(g => g.title), OTHER_TOOLS];
        return [...byGroup.entries()].sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0])).map(([group, items]) => ({ title: group, items }));
    }, [toolCatalog]);
    const [selectedNodeId, setSelectedNodeId] = React.useState<string | undefined>(undefined);
    const [selectedEdgeId, setSelectedEdgeId] = React.useState<string | undefined>(undefined);
    const [draggingNodeId, setDraggingNodeId] = React.useState<string | undefined>(undefined);
    const [dragOffset, setDragOffset] = React.useState<{ x: number; y: number }>({ x: 0, y: 0 });
    const [isPanning, setIsPanning] = React.useState<boolean>(false);
    const [panPosition, setPanPosition] = React.useState<{ x: number; y: number }>({ x: 0, y: 0 });
    const [panStart, setPanStart] = React.useState<{ x: number; y: number }>({ x: 0, y: 0 });
    const [zoomLevel, setZoomLevel] = React.useState<number>(1);
    const [showAddMenu, setShowAddMenu] = React.useState<boolean>(false);

    // Double-click Modal / Full Node Parameter & JSON Inspector state
    const [editingNodeModalId, setEditingNodeModalId] = React.useState<string | undefined>(undefined);
    const [modalTab, setModalTab] = React.useState<'params' | 'json' | 'test'>('params');
    const [rawJsonBuffer, setRawJsonBuffer] = React.useState<string>('');
    const [jsonError, setJsonError] = React.useState<string | undefined>(undefined);

    // Bi-directional Interactive Drag-to-Connect state
    /** True while a connection is being dragged from a port (rather than started by a click). */
    const connectingDragged = React.useRef(false);
    const [connectingState, setConnectingState] = React.useState<{
        originNodeId: string;
        originPortType: 'input' | 'output';
        mousePos: { x: number; y: number };
    } | undefined>(undefined);

    // Live Flow Simulation Engine State
    const [simStatus, setSimStatus] = React.useState<'idle' | 'playing' | 'paused'>('idle');
    const [simStep, setSimStep] = React.useState<number>(0);
    const [nodeExecutionDurations, setNodeExecutionDurations] = React.useState<Record<string, number>>({});

    // Compute execution stages (Topological / BFS layer grouping)
    const executionStages = React.useMemo(() => {
        if (!graph.nodes || graph.nodes.length === 0) return [];
        const inDegree: Record<string, number> = {};
        graph.nodes.forEach(n => { inDegree[n.id] = 0; });
        graph.edges.forEach(e => {
            if (inDegree[e.target] !== undefined) {
                inDegree[e.target] += 1;
            }
        });

        const visited = new Set<string>();
        const stages: string[][] = [];

        // Layer 0: Root nodes (inDegree === 0 or 'input' category)
        let currentLayer = graph.nodes
            .filter(n => inDegree[n.id] === 0 || n.category === 'input')
            .map(n => n.id);

        if (currentLayer.length === 0 && graph.nodes.length > 0) {
            currentLayer = [graph.nodes[0].id];
        }

        currentLayer.forEach(id => visited.add(id));
        if (currentLayer.length > 0) {
            stages.push(currentLayer);
        }

        while (visited.size < graph.nodes.length) {
            const nextLayer: string[] = [];
            const prevStage = stages[stages.length - 1] || [];

            graph.edges.forEach(edge => {
                if (prevStage.includes(edge.source) && !visited.has(edge.target)) {
                    if (!nextLayer.includes(edge.target)) {
                        nextLayer.push(edge.target);
                    }
                }
            });

            if (nextLayer.length === 0) {
                // Pick any remaining unvisited nodes
                const remaining = graph.nodes.filter(n => !visited.has(n.id)).map(n => n.id);
                if (remaining.length > 0) {
                    stages.push(remaining);
                    remaining.forEach(id => visited.add(id));
                }
                break;
            }

            nextLayer.forEach(id => visited.add(id));
            stages.push(nextLayer);
        }

        return stages;
    }, [graph.nodes, graph.edges]);

    // Live Flow Simulation Timer Loop
    React.useEffect(() => {
        if (simStatus !== 'playing' || executionStages.length === 0) {
            return;
        }

        const timer = setInterval(() => {
            setSimStep(prev => {
                const next = prev + 1;
                if (next >= executionStages.length) {
                    // Completed full cycle
                    return 0;
                }
                return next;
            });
        }, 1400);

        return () => clearInterval(timer);
    }, [simStatus, executionStages]);

    const activeSimNodeIds = React.useMemo(() => {
        if (simStatus === 'idle' || executionStages.length === 0) return [];
        return executionStages[simStep] || [];
    }, [simStatus, simStep, executionStages]);

    const activeSimEdgeIds = React.useMemo(() => {
        if (simStatus === 'idle' || executionStages.length === 0) return [];
        const currentStageNodes = executionStages[simStep] || [];
        const nextStageIndex = (simStep + 1) % executionStages.length;
        const nextStageNodes = executionStages[nextStageIndex] || [];

        return graph.edges
            .filter(e => currentStageNodes.includes(e.source) || (nextStageNodes.includes(e.target) && currentStageNodes.includes(e.source)))
            .map(e => e.id);
    }, [simStatus, simStep, executionStages, graph.edges]);

    const handlePlayFlow = () => {
        setSimStatus('playing');
    };

    const handlePauseFlow = () => {
        setSimStatus('paused');
    };

    const handleStepFlow = () => {
        setSimStatus('paused');
        setSimStep(prev => (prev + 1) % Math.max(1, executionStages.length));
    };

    const handleResetFlow = () => {
        setSimStatus('idle');
        setSimStep(0);
    };

    /**
     * Auto-Fit & Bounding Box Centering.
     */
    const autoFit = React.useCallback((nodes: GraphNode[]) => {
        if (!nodes || nodes.length === 0) return;
        const viewport = viewportRef.current;
        const containerWidth = viewport?.clientWidth || 900;
        const containerHeight = viewport?.clientHeight || 600;

        const nodeWidth = 240;
        const nodeHeight = 110;

        const minX = Math.min(...nodes.map(n => n.x));
        const maxX = Math.max(...nodes.map(n => n.x + nodeWidth));
        const minY = Math.min(...nodes.map(n => n.y));
        const maxY = Math.max(...nodes.map(n => n.y + nodeHeight));

        const graphWidth = Math.max(maxX - minX, 100);
        const graphHeight = Math.max(maxY - minY, 100);

        const padding = 60;
        const availableWidth = Math.max(containerWidth - padding * 2, 200);
        const availableHeight = Math.max(containerHeight - padding * 2, 200);

        const scaleX = availableWidth / graphWidth;
        const scaleY = availableHeight / graphHeight;
        const fitScale = Math.max(0.45, Math.min(1.0, Math.min(scaleX, scaleY)));

        // Center calculation
        const scaledGraphWidth = graphWidth * fitScale;
        const scaledGraphHeight = graphHeight * fitScale;

        const offsetX = (containerWidth - scaledGraphWidth) / 2 - minX * fitScale;
        const offsetY = (containerHeight - scaledGraphHeight) / 2 - minY * fitScale;

        setPanPosition({ x: Math.round(offsetX), y: Math.round(offsetY) });
        setZoomLevel(Number(fitScale.toFixed(2)));
    }, []);

    React.useEffect(() => {
        const sanitized = sanitizeGraph(data);
        setGraph(sanitized);
        const timer = setTimeout(() => {
            autoFit(sanitized.nodes);
        }, 60);
        return () => clearTimeout(timer);
    }, [data, autoFit]);

    const handleMouseDownNode = (node: GraphNode, e: React.MouseEvent) => {
        e.stopPropagation();
        setSelectedNodeId(node.id);
        setSelectedEdgeId(undefined);
        setDraggingNodeId(node.id);
        dragStartGraph.current = graphRef.current;
        const rect = viewportRef.current?.getBoundingClientRect();
        setDragOffset({
            x: (e.clientX - (rect?.left ?? 0) - panPosition.x) / zoomLevel - node.x,
            y: (e.clientY - (rect?.top ?? 0) - panPosition.y) / zoomLevel - node.y
        });
    };

    const handleDoubleClickNode = (node: GraphNode, e: React.MouseEvent) => {
        e.stopPropagation();
        setSelectedNodeId(node.id);
        setEditingNodeModalId(node.id);
        setModalTab('params');
        setJsonError(undefined);
        const nodeJsonObj = {
            id: node.id,
            label: node.label,
            subtitle: node.subtitle,
            category: node.category,
            color: node.color,
            status: node.status,
            parameters: node.parameters || {},
            notes: node.notes || ''
        };
        setRawJsonBuffer(JSON.stringify(nodeJsonObj, null, 2));
    };

    const handleMouseDownCanvas = () => {
        if (connectingState) {
            setConnectingState(undefined);
            return;
        }
        // Clicking canvas background deselects active node and edge
        setSelectedNodeId(undefined);
        setSelectedEdgeId(undefined);
        setIsPanning(true);
        setPanStart({
            x: (window.event as any)?.clientX ? (window.event as any).clientX - panPosition.x : 0,
            y: (window.event as any)?.clientY ? (window.event as any).clientY - panPosition.y : 0
        });
    };

    const handleMouseMove = (e: React.MouseEvent) => {
        // the draft connection is drawn in surface coordinates, measured from the viewport's own corner
        const rect = viewportRef.current?.getBoundingClientRect();
        const surfaceX = (e.clientX - (rect?.left ?? 0) - panPosition.x) / zoomLevel;
        const surfaceY = (e.clientY - (rect?.top ?? 0) - panPosition.y) / zoomLevel;

        if (connectingState) {
            setConnectingState(prev => (prev ? { ...prev, mousePos: { x: surfaceX, y: surfaceY } } : undefined));
        }

        if (draggingNodeId) {
            const newNodes = graph.nodes.map(n => {
                if (n.id === draggingNodeId) {
                    return {
                        ...n,
                        x: Math.max(-200, Math.min(2500, Math.round(surfaceX - dragOffset.x))),
                        y: Math.max(-400, Math.min(1800, Math.round(surfaceY - dragOffset.y)))
                    };
                }
                return n;
            });

            const newGraph = { ...graph, nodes: newNodes };
            setGraph(newGraph);
        } else if (isPanning) {
            setPanPosition({
                x: e.clientX - panStart.x,
                y: e.clientY - panStart.y
            });
        }
    };

    const handleMouseUp = () => {
        // a connection dragged out and let go over empty canvas is dropped (one let go over a card completes there)
        if (connectingState && connectingDragged.current) setConnectingState(undefined);
        connectingDragged.current = false;
        if (draggingNodeId) {
            setDraggingNodeId(undefined);
            if (dragStartGraph.current) recordEdit(dragStartGraph.current, graph);
            dragStartGraph.current = undefined;
            if (onUpdate) {
                onUpdate(graph);
            }
        }
        if (isPanning) {
            setIsPanning(false);
        }
    };

    const handleDragOver = (e: React.DragEvent) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
    };

    const handleDrop = (e: React.DragEvent) => {
        e.preventDefault();
        try {
            const rawData = e.dataTransfer.getData('application/json') || e.dataTransfer.getData('text/plain');
            if (!rawData) return;
            const payload = JSON.parse(rawData);
            if (payload.type !== 'file_node' && payload.type !== 'library_node') return;

            const rect = viewportRef.current?.getBoundingClientRect();
            const dropX = rect ? e.clientX - rect.left : e.clientX;
            const dropY = rect ? e.clientY - rect.top : e.clientY;

            const surfaceX = (dropX - panPosition.x) / zoomLevel;
            const surfaceY = (dropY - panPosition.y) / zoomLevel;

            let label = 'Node';
            let category: GraphNodeCategory = 'process';
            let color: AccentColor = 'blue';
            let parameters: Record<string, any> = {};
            let subtitle = '';
            let notes: string | undefined;

            if (payload.type === 'library_node') {
                label = payload.label || 'Node';
                category = payload.category || 'process';
                color = payload.color || 'blue';
                parameters = payload.parameters || {};
                subtitle = payload.subtitle || '';
                notes = payload.notes;
            } else if (payload.type === 'file_node') {
                const { name, path, extension } = payload;
                const ext = (extension || '').toLowerCase();
                subtitle = name;

                if (['.tsx', '.ts', '.glb', '.3d'].includes(ext)) {
                    if (['.glb', '.3d'].includes(ext)) {
                        label = '3D Scene Node';
                        category = 'scene-3d';
                        color = 'cyan';
                        parameters = {
                            targetSource: path,
                            meshType: 'cube',
                            skybox: 'sunset',
                            position: { x: 0, y: 0, z: 0 },
                            environment: 'studio'
                        };
                    } else {
                        label = 'WASM Procedural Geometry Node';
                        category = 'process';
                        color = 'indigo';
                        parameters = {
                            targetSource: path,
                            transform: 'JSON.stringify(payload)'
                        };
                    }
                } else if (['.png', '.webp', '.jpg'].includes(ext)) {
                    label = 'Image Generator / Inpainter Node';
                    category = 'ai';
                    color = 'purple';
                    parameters = {
                        baselineTexture: path,
                        model: 'gemini-3.8-flash',
                        temperature: 0.2
                    };
                } else if (['.wav', '.mp3', '.md'].includes(ext)) {
                    if (['.wav', '.mp3'].includes(ext)) {
                        label = 'TTS Audio Generator Node';
                    } else {
                        label = 'Story/Podcast Script Node';
                    }
                    category = 'process';
                    color = 'indigo';
                    parameters = {
                        targetSource: path
                    };
                }
            }

            const newNodeId = `node-${category}-${Date.now()}`;
            const newNode: GraphNode = {
                id: newNodeId,
                label,
                subtitle,
                category,
                color,
                x: surfaceX,
                y: surfaceY,
                status: 'pending',
                parameters,
                notes
            };

            // a node added from the library is not wired to anything: the user connects it (ports, or Branch)
            const newEdges: GraphEdge[] = graph.edges;

            const updatedGraph: NodeGraphData = {
                ...graph,
                nodes: [...graph.nodes, newNode],
                edges: newEdges
            };

            recordEdit(graph, updatedGraph);
            setGraph(updatedGraph);
            setSelectedNodeId(newNodeId);

            if (onUpdate) {
                onUpdate(updatedGraph);
            }
        } catch (err) {
            console.error('Failed to parse drag-and-drop payload', err);
        }
    };

    // ==========================================
    // Bi-Directional Port Connection Handlers
    // ==========================================
    const handleStartConnecting = (nodeId: string, portType: 'input' | 'output', e: React.MouseEvent) => {
        e.stopPropagation();
        const node = graph.nodes.find(n => n.id === nodeId);
        if (!node) return;

        const portCoords = getNodePort(node)[portType];
        connectingDragged.current = true;
        setConnectingState({
            originNodeId: nodeId,
            originPortType: portType,
            mousePos: { x: portCoords.x, y: portCoords.y }
        });
    };

    const handleCompleteConnection = (targetNodeId: string, targetPortType: 'input' | 'output', e: React.MouseEvent) => {
        e.stopPropagation();
        connectingDragged.current = false;
        if (!connectingState) return;

        const { originNodeId, originPortType } = connectingState;

        // Prevent self connection
        if (originNodeId === targetNodeId) {
            setConnectingState(undefined);
            return;
        }

        // Must connect output to input OR input to output
        let sourceId: string | undefined;
        let destId: string | undefined;

        if (originPortType === 'output' && targetPortType === 'input') {
            sourceId = originNodeId;
            destId = targetNodeId;
        } else if (originPortType === 'input' && targetPortType === 'output') {
            sourceId = targetNodeId;
            destId = originNodeId;
        } else {
            // Port type mismatch or drag directly to card (auto-infer)
            if (originPortType === 'output') {
                sourceId = originNodeId;
                destId = targetNodeId;
            } else {
                sourceId = targetNodeId;
                destId = originNodeId;
            }
        }

        if (sourceId && destId && sourceId !== destId) {
            const exists = graph.edges.some(edge => edge.source === sourceId && edge.target === destId);
            if (!exists) {
                const sourceNode = graph.nodes.find(n => n.id === sourceId);
                const newEdge: GraphEdge = {
                    id: `edge-${Date.now()}`,
                    source: sourceId,
                    target: destId,
                    label: 'Passes to',
                    style: 'animated',
                    color: sourceNode?.color || 'blue'
                };

                const updatedGraph: NodeGraphData = {
                    ...graph,
                    edges: [...graph.edges, newEdge]
                };

                recordEdit(graph, updatedGraph);
                setGraph(updatedGraph);
                if (onUpdate) {
                    onUpdate(updatedGraph);
                }
            }
        }

        setConnectingState(undefined);
    };

    const handleAddConnectedNode = (sourceNodeId: string) => {
        const sourceNode = graph.nodes.find(n => n.id === sourceNodeId);
        if (!sourceNode) { return; }

        const newNodeId = `node-${Date.now()}`;
        const newNode: GraphNode = {
            id: newNodeId,
            label: 'AI Agent Processor',
            subtitle: 'Gemini 3.8 Reasoning Stage',
            category: 'ai',
            color: 'purple',
            x: sourceNode.x + 360,
            y: sourceNode.y + (Math.random() > 0.5 ? 40 : -40),
            status: 'pending',
            parameters: {
                model: 'gemini-3.8-flash',
                temperature: 0.2,
                systemPrompt: 'Process and enrich upstream pipeline payload'
            }
        };

        const newEdge: GraphEdge = {
            id: `edge-${Date.now()}`,
            source: sourceNodeId,
            target: newNodeId,
            label: 'Passes to',
            style: 'animated',
            color: 'purple'
        };

        const updatedGraph: NodeGraphData = {
            ...graph,
            nodes: [...graph.nodes, newNode],
            edges: [...graph.edges, newEdge]
        };

        recordEdit(graph, updatedGraph);
        setGraph(updatedGraph);
        setSelectedNodeId(newNodeId);
        if (onUpdate) {
            onUpdate(updatedGraph);
        }
    };

    const handleAddCustomNode = (category: GraphNodeCategory) => {
        const colors: Record<GraphNodeCategory, AccentColor> = {
            input: 'blue',
            ai: 'purple',
            decision: 'amber',
            mcp: 'indigo',
            cli: 'emerald',
            database: 'cyan',
            process: 'indigo',
            transformation: 'indigo',
            output: 'emerald',
            'scene-3d': 'cyan',
            'camera-3d': 'rose',
            'map-3d': 'emerald',
            'studio-mcp': 'indigo',
            image: 'purple',
            'image-card': 'purple',
            video: 'rose',
            'video-card': 'rose',
            audio: 'indigo',
            'audio-card': 'indigo',
            '3d-card': 'cyan'
        };

        const defaultLabels: Record<GraphNodeCategory, { label: string; sub: string; params: Record<string, any> }> = {
            input: {
                label: 'Webhook Trigger',
                sub: 'POST /api/v1/webhook',
                params: { triggerType: 'webhook', endpoint: '/api/v1/webhook', httpMethod: 'POST' }
            },
            ai: {
                label: 'AI Agent Processor',
                sub: 'Gemini 3.8 Flash Reasoning',
                params: { model: 'gemini-3.8-flash', temperature: 0.2, systemPrompt: 'You are an autonomous workflow reasoner.' }
            },
            decision: {
                label: 'Decision Gate',
                sub: 'If / Else Condition',
                params: { conditionType: 'expression', rule: 'payload.confidence > 0.85', trueBranch: 'Continue', falseBranch: 'Fallback' }
            },
            mcp: {
                label: 'MCP Tool Endpoint',
                sub: 'Stripe / GitHub Tool',
                params: { server: 'mcp-stripe', tool: 'get_balance', timeoutMs: 5000 }
            },
            cli: {
                label: 'CLI Script Runner',
                sub: 'yarn test:e2e',
                params: { command: 'yarn test', cwd: './extensions/product', sandbox: true }
            },
            database: {
                label: 'Database Action',
                sub: 'Postgres Query / Vector Lookup',
                params: { database: 'postgresql', operation: 'SELECT', table: 'events' }
            },
            process: {
                label: 'Logic Process',
                sub: 'Payload Transform',
                params: { transform: 'JSON.stringify(payload)' }
            },
            transformation: {
                label: 'Data Transform',
                sub: 'Map & Filter Stage',
                params: { transform: 'payload.map(x => x)' }
            },
            output: {
                label: 'Visual Output Stage',
                sub: 'Rendered Canvas Card',
                params: { targetSurface: 'canvas' }
            },
            'scene-3d': {
                label: '3D Spatial Scene',
                sub: 'Procedural coordinate framework',
                params: { meshType: 'cube', skybox: 'sunset', position: { x: 0, y: 0, z: 0 }, environment: 'studio' }
            },
            'camera-3d': {
                label: '3D Camera Sequencer',
                sub: 'Path tracking & animation lanes',
                params: { pathType: 'bezier', durationSeconds: 5, loop: true, keyframesCount: 4 }
            },
            'map-3d': {
                label: 'Geo Spatial 3D Map',
                sub: 'Google Photorealistic 3D Tiles',
                params: { latitude: 37.7749, longitude: -122.4194, zoom: 17, style: 'realistic', poiEnabled: true }
            },
            'studio-mcp': {
                label: 'Scratchbox Studio Connector',
                sub: 'Creative media pipeline MCP tool',
                params: { targetEndpoint: 'mcp://localhost:4000', activeTools: ['scene3d_create', 'scout_locations'], activeConnections: 2 }
            },
            image: {
                label: 'Image Card (Nano Banana 2)',
                sub: 'Google Nano Banana 2',
                params: { prompt: 'A cinematic high-fidelity digital art rendering', aspectRatio: '16:9', model: 'gemini-3.1-flash-image' }
            },
            'image-card': {
                label: 'Image Card (Nano Banana 2)',
                sub: 'Google Nano Banana 2',
                params: { prompt: 'A cinematic high-fidelity digital art rendering', aspectRatio: '16:9', model: 'gemini-3.1-flash-image' }
            },
            video: {
                label: 'Video Card (Omni 1.1)',
                sub: 'Google Omni 1.1 Video',
                params: { prompt: 'Camera pan left showing dramatic sunbeams through clouds', durationSeconds: 6, model: 'google/omni-1.1' }
            },
            'video-card': {
                label: 'Video Card (Omni 1.1)',
                sub: 'Google Omni 1.1 Video',
                params: { prompt: 'Camera pan left showing dramatic sunbeams through clouds', durationSeconds: 6, model: 'google/omni-1.1' }
            },
            audio: {
                label: 'Audio Card',
                sub: 'Speech & Scores Player',
                params: { prompt: 'Warm narrative male voice speaking clearly', audioKind: 'speech' }
            },
            'audio-card': {
                label: 'Audio Card',
                sub: 'Speech & Scores Player',
                params: { prompt: 'Warm narrative male voice speaking clearly', audioKind: 'speech' }
            },
            '3d-card': {
                label: '3D Scene Node',
                sub: 'Interactive 3D Viewport',
                params: { prompt: 'A high-fidelity low-poly space station', meshType: 'cube', environment: 'studio' }
            }
        };

        const preset = defaultLabels[category];
        const newNodeId = `node-${category}-${Date.now()}`;
        const newNode: GraphNode = {
            id: newNodeId,
            label: preset.label,
            subtitle: preset.sub,
            category,
            color: colors[category] || 'blue',
            x: 200 + Math.random() * 150,
            y: 150 + Math.random() * 120,
            status: 'pending',
            parameters: preset.params
        };

        const updatedGraph: NodeGraphData = {
            ...graph,
            nodes: [...graph.nodes, newNode]
        };

        recordEdit(graph, updatedGraph);
        setGraph(updatedGraph);
        setSelectedNodeId(newNodeId);
        setShowAddMenu(false);
        if (onUpdate) {
            onUpdate(updatedGraph);
        }
    };

    const handleDragStartLibrary = (e: React.DragEvent, item: LibraryItem) => {
        const payload = {
            type: 'library_node',
            category: item.category,
            label: item.label,
            subtitle: item.subtitle,
            color: item.color,
            parameters: item.parameters,
            notes: item.notes
        };
        e.dataTransfer.setData('application/json', JSON.stringify(payload));
        e.dataTransfer.effectAllowed = 'copy';
    };

    const handleAddLibraryNode = (item: LibraryItem) => {
        const rect = viewportRef.current?.getBoundingClientRect();
        const viewportWidth = rect ? rect.width : 900;
        const viewportHeight = rect ? rect.height : 600;

        // Formula translates active viewport center using active pan and zoom matrix offsets
        // the view's centre, or the nearest free card-sized slot around it (rings of slots one card apart), so an added
        // node never lands on top of another card and hides its buttons
        const cx = (viewportWidth / 2 - panPosition.x) / zoomLevel;
        const cy = (viewportHeight / 2 - panPosition.y) / zoomLevel;
        const SLOT_X = NODE_CARD_WIDTH + 40, SLOT_Y = 340;
        const free = (x: number, y: number) => !graph.nodes.some(n => Math.abs(n.x - x) < SLOT_X - 20 && Math.abs(n.y - y) < SLOT_Y - 20);
        let surfaceX = cx, surfaceY = cy;
        search: for (let ring = 1; !free(surfaceX, surfaceY) && ring <= 8; ring++) {
            for (let dy = -ring; dy <= ring; dy++) for (let dx = -ring; dx <= ring; dx++) {
                if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring || !free(cx + dx * SLOT_X, cy + dy * SLOT_Y)) continue;
                surfaceX = cx + dx * SLOT_X;
                surfaceY = cy + dy * SLOT_Y;
                break search;
            }
        }

        const newNodeId = `node-${item.category}-${Date.now()}`;
        const newNode: GraphNode = {
            id: newNodeId,
            label: item.label,
            subtitle: item.subtitle,
            category: item.category,
            color: item.color,
            x: surfaceX,
            y: surfaceY,
            status: 'pending',
            parameters: item.parameters || {},
            notes: item.notes
        };

        // a node added from the library is not wired to anything: the user connects it (ports, or Branch)
        const newEdges: GraphEdge[] = graph.edges;

        const updatedGraph: NodeGraphData = {
            ...graph,
            nodes: [...graph.nodes, newNode],
            edges: newEdges
        };

        recordEdit(graph, updatedGraph);
        setGraph(updatedGraph);
        setSelectedNodeId(newNodeId);

        if (onUpdate) {
            onUpdate(updatedGraph);
        }
    };

    const handleUpdateNode = (nodeId: string, updates: Partial<GraphNode>, record = false) => {
        const latest = graphRef.current;
        const updatedNodes = latest.nodes.map(n => (n.id === nodeId ? { ...n, ...updates } : n));
        const updatedGraph = { ...latest, nodes: updatedNodes };
        // the user's own field edits are undo steps (typing into one field is one step); run updates are not
        if (record) recordEdit(latest, updatedGraph, `node:${nodeId}:${Object.keys(updates).sort().join(',')}`);
        graphRef.current = updatedGraph;
        setGraph(updatedGraph);
        if (onUpdate) {
            onUpdate(updatedGraph);
        }
    };

    /** An edit the user makes in the inspector or editor: one undo step. */
    const handleEditNode = (nodeId: string, updates: Partial<GraphNode>) => handleUpdateNode(nodeId, updates, true);

    const handleExecutePromptBox = async (node: GraphNode) => {
        const prompt = node.parameters?.prompt || '';
        if (!prompt || !prompt.trim()) return;

        // Set card to isGenerating state
        handleUpdateNode(node.id, {
            parameters: { ...node.parameters, isGenerating: true, generationError: undefined }
        });
        const currentParameters = () => graphRef.current.nodes.find(n => n.id === node.id)?.parameters;

        if (onPromptAction) {
            onPromptAction(`Generate ${node.category || 'media'} with prompt "${prompt}" for node "${node.label}" in flow "${graph.title}"`);
        }

        try {
            const client = MediaGenerationClient.getInstance();
            const wsPath = workspacePath || '';
            const idempotencyKey = `${node.id}-${Date.now()}`;

            // Aggregate Upstream Context (Conditioning)
            const upstreamNodeIds = graph.edges
                .filter(e => e.target === node.id)
                .map(e => e.source);

            const referenceAssets: any[] = [];
            let sourceAsset: any = undefined;

            upstreamNodeIds.forEach(upstreamId => {
                const upstreamNode = graph.nodes.find(n => n.id === upstreamId);
                if (upstreamNode) {
                    const mediaUrl = upstreamNode.parameters?.mediaUrl || upstreamNode.parameters?.imageUrl || upstreamNode.outputData?.url;
                    if (mediaUrl) {
                        const assetRef = {
                            uri: mediaUrl,
                            contentHash: mediaUrl,
                            mimeType: upstreamNode.category?.includes('video') ? 'video/mp4' : 'image/jpeg',
                            byteLength: 1024,
                            relativePath: mediaUrl
                        };
                        referenceAssets.push(assetRef);
                        if (!sourceAsset) {
                            sourceAsset = assetRef;
                        }
                    }
                }
            });

            let job: any;
            if (node.category === 'image' || node.category === 'image-card') {
                const requestedModel = node.parameters?.model || IMAGE_MODEL_PRIORITY[0];
                job = await client.start({
                    kind: 'image',
                    prompt,
                    workspaceRoot: wsPath,
                    idempotencyKey,
                    aspectRatio: node.parameters?.aspectRatio || '16:9',
                    modelPriority: [requestedModel, ...IMAGE_MODEL_PRIORITY],
                    sourceAsset: sourceAsset || (referenceAssets.length > 0 ? referenceAssets[0] : undefined),
                    referenceAssets: referenceAssets.length > 0 ? referenceAssets : undefined
                });
            } else if (node.category === 'video' || node.category === 'video-card') {
                const requestedModel = node.parameters?.model || 'google/omni-1.1';
                job = await client.start({
                    kind: 'video',
                    prompt,
                    workspaceRoot: wsPath,
                    idempotencyKey,
                    aspectRatio: '16:9',
                    durationSeconds: node.parameters?.durationSeconds || 6,
                    // The node's model first, then the default video list (Omni, then Veo); the job says which one answered.
                    modelPriority: [requestedModel, ...VIDEO_MODEL_PRIORITY],
                    sourceAsset: sourceAsset || (referenceAssets.length > 0 ? referenceAssets[0] : undefined)
                });
            } else if (node.category === 'audio' || node.category === 'audio-card') {
                job = await client.start({
                    kind: 'audio' as any,
                    prompt,
                    workspaceRoot: wsPath,
                    idempotencyKey,
                    audioKind: node.parameters?.audioKind || 'speech',
                    voiceId: node.parameters?.voiceId || 'Chirp-1'
                } as any);
            } else if (node.category === 'scene-3d' || node.category === '3d-card') {
                job = await client.start({
                    kind: '3d' as any,
                    prompt,
                    workspaceRoot: wsPath,
                    idempotencyKey,
                    meshType: node.parameters?.meshType || 'cube',
                    environment: node.parameters?.environment || 'studio'
                } as any);
            }

            if (job) {
                // Polling is owned by useMediaJobPoller: aborted + interval cleared on unmount.
                mediaJobPoller.startPolling({
                    jobId: job.id,
                    workspaceRoot: wsPath,
                    intervalMs: 1000,
                    onComplete: (done) => {
                        const resultUrl = client.contentUrl(job.id, wsPath);
                        handleUpdateNode(node.id, {
                            parameters: mediaJobOutcomeParameters(currentParameters(), { resultUrl, result: done.result }),
                            outputData: { url: resultUrl, modelUsed: done.result?.modelUsed }
                        });
                    },
                    onError: (pollErr, failedJob) => {
                        handleUpdateNode(node.id, {
                            parameters: mediaJobOutcomeParameters(currentParameters(), {
                                error: pollErr?.message || (failedJob?.error?.message ?? 'Media generation failed')
                            })
                        });
                    }
                });
            } else {
                throw new Error('Could not start media job');
            }

        } catch (err: any) {
            handleUpdateNode(node.id, {
                parameters: mediaJobOutcomeParameters(currentParameters(), { error: err?.message || 'Media generation request failed' })
            });
        }
    };

    const handleDeleteNode = (nodeId: string) => {
        // a tool node that is running stops with it; its card in the chat says so
        toolNodeRuns.get(graphKey, nodeId)?.controller.abort();
        const latest = graphRef.current;
        const updatedNodes = latest.nodes.filter(n => n.id !== nodeId);
        const updatedEdges = latest.edges.filter(e => e.source !== nodeId && e.target !== nodeId);
        const updatedGraph = { ...latest, nodes: updatedNodes, edges: updatedEdges };
        recordEdit(latest, updatedGraph);
        graphRef.current = updatedGraph;
        setGraph(updatedGraph);
        setSelectedNodeId(undefined);
        if (editingNodeModalId === nodeId) {
            setEditingNodeModalId(undefined);
        }
        if (onUpdate) {
            onUpdate(updatedGraph);
        }
    };

    const handleDeleteEdge = (edgeId: string) => {
        const latest = graphRef.current;
        const updatedEdges = latest.edges.filter(e => e.id !== edgeId);
        const updatedGraph = { ...latest, edges: updatedEdges };
        recordEdit(latest, updatedGraph);
        graphRef.current = updatedGraph;
        setGraph(updatedGraph);
        setSelectedEdgeId(undefined);
        if (onUpdate) {
            onUpdate(updatedGraph);
        }
    };

    // Delete / Backspace removes the selected node (or edge), except while typing in a field or with the editor open
    const deleteSelection = React.useRef<() => boolean>(() => false);
    const historyStep = React.useRef<(d: 'undo' | 'redo') => boolean>(() => false);
    historyStep.current = stepHistory;
    deleteSelection.current = () => {
        if (editingNodeModalId) return false;
        if (selectedNodeId && graphRef.current.nodes.some(n => n.id === selectedNodeId)) { handleDeleteNode(selectedNodeId); return true; }
        if (selectedEdgeId) { handleDeleteEdge(selectedEdgeId); return true; }
        return false;
    };
    React.useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            const key = e.key.toLowerCase();
            const mod = e.metaKey || e.ctrlKey;
            const isUndo = mod && key === 'z' && !e.shiftKey;
            const isRedo = mod && ((key === 'z' && e.shiftKey) || (key === 'y' && e.ctrlKey && !e.metaKey));
            if (e.key !== 'Delete' && e.key !== 'Backspace' && !isUndo && !isRedo) return;
            // a text field keeps its own typing and its own undo
            const t = e.target as HTMLElement | null;
            if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
            // only when the pointer or focus is in this graph, so another surface's keys are left alone
            if (!viewportRef.current || !(viewportRef.current.matches(':hover') || viewportRef.current.contains(document.activeElement))) return;
            if (isUndo || isRedo) { if (historyStep.current(isUndo ? 'undo' : 'redo')) e.preventDefault(); return; }
            if (deleteSelection.current()) e.preventDefault();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, []);

    const handlePromptForNode = (node: GraphNode, action: string) => {
        if (!onPromptAction) { return; }
        onPromptAction(`${action} for node "${node.label}" (${node.category || 'node'}) in flow diagram "${graph.title}".`);
    };

    /** Runs one tool node for real; empty inputs come from upstream outputs. Resolves true when the tool completed. */
    const handleRunToolNode = async (nodeId: string): Promise<boolean> => {
        const node = graphRef.current.nodes.find(n => n.id === nodeId);
        if (!node || !isToolNode(node) || toolNodeRuns.get(graphKey, nodeId)) return false;
        const entry = toolEntry(node);
        if (!entry) {
            handleUpdateNode(nodeId, { status: 'error', errorMessage: `Tool ${node.parameters?.toolName} is not in the tool catalog` });
            return false;
        }
        const { args, filledFrom, missingRequired } = resolveToolNodeArgs(node, graphRef.current.nodes, graphRef.current.edges, entry.parameters);
        if (missingRequired.length) {
            handleUpdateNode(nodeId, { status: 'error', errorMessage: `Needs ${missingRequired.join(', ')}: set it in the node or connect a node whose output has it` });
            return false;
        }
        // a node that builds into a scene (a stage view's build node) runs against that scene, one run per scene at a time
        const targetId: string | undefined = node.parameters?.targetArtifactId;
        const startedRun = toolNodeRuns.start(graphKey, nodeId, targetId);
        if ('refused' in startedRun) {
            handleUpdateNode(nodeId, { status: 'error', errorMessage: startedRun.refused });
            return false;
        }
        const { controller } = startedRun.run;
        const targetScene = targetId ? studioState?.artifactHistory.find(a => a.id === targetId) ?? (studioState?.activeArtifact?.id === targetId ? studioState.activeArtifact : undefined) : undefined;
        setRunningToolNodes(ids => [...ids, nodeId]);
        handleUpdateNode(nodeId, { status: 'running', errorMessage: undefined });
        const started = Date.now();
        const record = (status: 'completed' | 'failed', resultPayload: Record<string, unknown>, summary: string | undefined, durationMs: number) => {
            // the run, in the chat as a tool card and a line the model reads: what ran, with what, from where, and what came back
            const exec: McpExecutionState = {
                id: `toolnode-${nodeId}-${started}`, mcpServerId: 'scratchbox-canvas', mcpName: 'Scratchbox canvas', toolName: entry.name,
                humanTitle: `${entry.name} (node graph)`, status, timestamp: new Date().toLocaleTimeString(),
                steps: [{ id: 's1', title: `Run ${entry.name}`, status: status === 'completed' ? 'done' : 'failed', durationMs }],
                summaryResult: summary, durationMs, args, resultFields: compactResultFields(resultPayload)
            };
            const argText = Object.entries(args).map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join(', ').slice(0, 400);
            studioActions?.recordToolNodeRun(exec, `Ran \`${entry.name}\` from the node graph "${graphRef.current.title}"${argText ? ` with ${argText}` : ''}: ${status === 'completed' ? 'completed' : 'failed'}${summary ? `. ${summary}` : ''}`);
        };
        try {
            const res = await ToolNodeClient.getInstance().runStream({ name: entry.name, args, workspaceRoot: workspacePath || '', activeArtifact: targetScene }, event => {
                const line = event.type === 'progress' ? event.message : `${event.stage.title}: ${event.stage.status}${event.stage.message ? ` (${event.stage.message})` : ''}`;
                if (mountedRef.current) setLiveDetails(d => ({ ...d, [nodeId]: line }));
                // each staged commit carries the scene as it now stands: the scene's tab and the viewport follow it
                if (event.type === 'stage' && event.artifact) studioActions?.applyStreamedArtifact(event.artifact);
            }, controller.signal);
            const outputData = { resultPayload: res.resultPayload, summary: res.summary, filledFrom, recorded: false };
            record(res.status, res.resultPayload, res.summary || res.error?.message, res.durationMs);
            if (res.status === 'completed') {
                updateNodeAnywhere(nodeId, { status: 'completed', outputData, executionDurationMs: res.durationMs, errorMessage: undefined });
                if (mountedRef.current) setNodeExecutionDurations(prev => ({ ...prev, [nodeId]: res.durationMs }));
                return true;
            }
            updateNodeAnywhere(nodeId, { status: 'error', outputData, executionDurationMs: res.durationMs, errorMessage: res.error?.message || `${entry.name} failed` });
            return false;
        } catch (err) {
            const stopped = controller.signal.aborted;
            const message = stopped ? 'Stopped' : (err instanceof Error ? err.message : String(err));
            record('failed', {}, message, Date.now() - started);
            updateNodeAnywhere(nodeId, { status: 'error', errorMessage: message });
            return false;
        } finally {
            toolNodeRuns.finish(graphKey, nodeId);
            if (mountedRef.current) {
                setRunningToolNodes(ids => ids.filter(id => id !== nodeId));
                setLiveDetails(({ [nodeId]: _, ...rest }) => rest);
            }
        }
    };

    const handleStopToolNode = (nodeId: string) => toolNodeRuns.get(graphKey, nodeId)?.controller.abort();

    /** Runs every tool node in dependency order, each after the ones it reads from; stops at the first failure. */
    const handleRunToolFlow = async () => {
        if (toolFlowRunning) {
            toolNodeRuns.stopGraph(graphKey);
            return;
        }
        setToolFlowRunning(true);
        try {
            for (const node of toolRunOrder(graphRef.current.nodes, graphRef.current.edges)) {
                if (!(await handleRunToolNode(node.id))) break;
            }
        } finally {
            setToolFlowRunning(false);
        }
    };

    /** Runs the next tool node (dependency order) that has not completed. */
    const handleStepToolFlow = () => {
        const next = toolRunOrder(graphRef.current.nodes, graphRef.current.edges).find(n => (n as GraphNode).status !== 'completed');
        if (next) void handleRunToolNode(next.id);
    };

    /** Clears the tool nodes' run results, back to ready; what the runs did to the scene and the chat stays. */
    const handleResetToolRuns = () => {
        const latest = graphRef.current;
        const updated: NodeGraphData = { ...latest, nodes: latest.nodes.map(n => isToolNode(n) && !n.outputData?.recorded ? { ...n, status: 'pending', outputData: undefined, errorMessage: undefined, executionDurationMs: undefined } : n) };
        graphRef.current = updated;
        setGraph(updated);
        onUpdate?.(updated);
    };

    // Dry Run Test for single node
    const handleDryRunNode = (nodeId: string) => {
        // a tool node has a real run; a simulated "completed" would claim the tool ran
        const target = graphRef.current.nodes.find(n => n.id === nodeId);
        if (target && isToolNode(target)) {
            void handleRunToolNode(nodeId);
            return;
        }
        handleUpdateNode(nodeId, { status: 'running' });
        const latency = Math.floor(12 + Math.random() * 45);
        setTimeout(() => {
            handleUpdateNode(nodeId, {
                status: 'completed',
                executionDurationMs: latency
            });
            setNodeExecutionDurations(prev => ({ ...prev, [nodeId]: latency }));
        }, 600);
    };

    // Save JSON buffer to node
    const handleSaveJsonBuffer = (nodeId: string) => {
        try {
            const parsed = JSON.parse(rawJsonBuffer);
            if (typeof parsed !== 'object' || parsed === null) {
                setJsonError('JSON payload must be an object');
                return;
            }
            handleEditNode(nodeId, {
                label: typeof parsed.label === 'string' ? parsed.label : undefined,
                subtitle: typeof parsed.subtitle === 'string' ? parsed.subtitle : undefined,
                category: parsed.category,
                color: parsed.color,
                status: parsed.status,
                parameters: parsed.parameters || {},
                notes: parsed.notes
            });
            setJsonError(undefined);
            setEditingNodeModalId(undefined);
        } catch (err: any) {
            setJsonError(`Invalid JSON: ${err.message}`);
        }
    };

    const selectedNode = graph.nodes.find(n => n.id === selectedNodeId);
    const editingNode = graph.nodes.find(n => n.id === editingNodeModalId);

    // Compute Bezier Curve for Edge
    const renderEdge = (edge: GraphEdge) => {
        const sourceNode = graph.nodes.find(n => n.id === edge.source);
        const targetNode = graph.nodes.find(n => n.id === edge.target);
        if (!sourceNode || !targetNode) {
            return null;
        }

        const sourcePort = getNodePort(sourceNode).output;
        const targetPort = getNodePort(targetNode).input;

        const sourceX = sourcePort.x;
        const sourceY = sourcePort.y;
        const targetX = targetPort.x;
        const targetY = targetPort.y;

        const dx = targetX - sourceX;
        const dy = targetY - sourceY;

        let cp1X: number, cp1Y: number, cp2X: number, cp2Y: number;

        if (dx > 0) {
            const curvature = Math.max(Math.min(dx * 0.55, 180), Math.min(Math.abs(dy) * 0.4, 100), 50);
            cp1X = sourceX + curvature;
            cp1Y = sourceY;
            cp2X = targetX - curvature;
            cp2Y = targetY;
        } else {
            const curvature = Math.max(Math.abs(dy) * 0.45, 80);
            cp1X = sourceX + curvature;
            cp1Y = sourceY;
            cp2X = targetX - curvature;
            cp2Y = targetY;
        }

        const d = `M ${sourceX} ${sourceY} C ${cp1X} ${cp1Y}, ${cp2X} ${cp2Y}, ${targetX} ${targetY}`;
        const strokeColor = `var(--sb-system-${edge.color || 'blue'})`;
        const isSimActive = activeSimEdgeIds.includes(edge.id);
        const isSelected = selectedEdgeId === edge.id;

        // Exact cubic Bezier midpoint at t = 0.5
        const midX = 0.125 * sourceX + 0.375 * cp1X + 0.375 * cp2X + 0.125 * targetX;
        const midY = 0.125 * sourceY + 0.375 * cp1Y + 0.375 * cp2Y + 0.125 * targetY;
        const pathId = `edge-path-${edge.id}`;

        const labelText = edge.label;
        const pillWidth = labelText ? Math.max(labelText.length * 6.2 + 14, 36) : 0;

        return (
            <g
                key={edge.id}
                className={`sb-graph-edge-group ${isSimActive ? 'sb-edge-sim-active' : ''} ${
                    isSelected ? 'sb-edge-selected' : ''
                }`}
                // a press on an edge (or its Unlink pill) is not a canvas press, which would deselect it before the click
                onMouseDown={e => e.stopPropagation()}
                onClick={e => {
                    e.stopPropagation();
                    setSelectedEdgeId(edge.id);
                    setSelectedNodeId(undefined);
                }}
            >
                {/* Invisible wide hit target for easier edge clicking */}
                <path
                    d={d}
                    fill="none"
                    stroke="transparent"
                    strokeWidth="14"
                    className="sb-edge-hit-area"
                />

                <path
                    id={pathId}
                    d={d}
                    fill="none"
                    stroke={isSelected ? 'var(--sb-system-blue)' : strokeColor}
                    strokeWidth={isSimActive ? '3' : isSelected ? '2.5' : '2'}
                    strokeDasharray={edge.style === 'dashed' || edge.style === 'animated' ? '5,5' : 'none'}
                    className={`${edge.style === 'animated' ? 'sb-edge-animated' : ''} ${
                        isSimActive ? 'sb-edge-pulsing' : ''
                    }`}
                    markerEnd={`url(#arrow-${edge.color || 'blue'})`}
                />

                {/* Animated Flow Pulse Particle during Simulation */}
                {simStatus === 'playing' && isSimActive && (
                    <circle r="4.5" fill={strokeColor} className="sb-flow-pulse-particle">
                        <animateMotion
                            dur="1.2s"
                            repeatCount="indefinite"
                            path={d}
                        />
                    </circle>
                )}

                {labelText && (
                    <g className="sb-graph-edge-label-badge" transform={`translate(${midX}, ${midY})`}>
                        <rect
                            x={-pillWidth / 2}
                            y={-8}
                            width={pillWidth}
                            height={16}
                            rx={8}
                            className="sb-edge-label-pill"
                        />
                        <text
                            y={3}
                            textAnchor="middle"
                            className="sb-graph-edge-label"
                        >
                            {labelText}
                        </text>
                    </g>
                )}

                {/* Selected Edge Quick Disconnect Action */}
                {isSelected && (
                    <g className="sb-edge-action-group" transform={`translate(${midX}, ${midY - 18})`}>
                        <rect
                            x="-32"
                            y="-10"
                            width="64"
                            height="20"
                            rx="10"
                            className="sb-edge-action-pill"
                            onClick={e => {
                                e.stopPropagation();
                                handleDeleteEdge(edge.id);
                            }}
                        />
                        <text
                            y="4"
                            textAnchor="middle"
                            className="sb-edge-action-text"
                            onClick={e => {
                                e.stopPropagation();
                                handleDeleteEdge(edge.id);
                            }}
                        >
                            ✕ Unlink
                        </text>
                    </g>
                )}
            </g>
        );
    };

    // Render Draft Connection Curve (Bi-directional)
    const renderDraftConnection = () => {
        if (!connectingState) return null;
        const { originNodeId, originPortType, mousePos } = connectingState;
        const originNode = graph.nodes.find(n => n.id === originNodeId);
        if (!originNode) return null;

        const portCoords = getNodePort(originNode)[originPortType];
        let sourceX: number, sourceY: number, targetX: number, targetY: number;

        if (originPortType === 'output') {
            sourceX = portCoords.x;
            sourceY = portCoords.y;
            targetX = mousePos.x;
            targetY = mousePos.y;
        } else {
            sourceX = mousePos.x;
            sourceY = mousePos.y;
            targetX = portCoords.x;
            targetY = portCoords.y;
        }

        const dx = targetX - sourceX;
        const dy = targetY - sourceY;

        let cp1X: number, cp1Y: number, cp2X: number, cp2Y: number;

        if (dx > 0) {
            const curvature = Math.max(Math.min(dx * 0.55, 180), Math.min(Math.abs(dy) * 0.4, 100), 50);
            cp1X = sourceX + curvature;
            cp1Y = sourceY;
            cp2X = targetX - curvature;
            cp2Y = targetY;
        } else {
            const curvature = Math.max(Math.abs(dy) * 0.45, 80);
            cp1X = sourceX + curvature;
            cp1Y = sourceY;
            cp2X = targetX - curvature;
            cp2Y = targetY;
        }

        const d = `M ${sourceX} ${sourceY} C ${cp1X} ${cp1Y}, ${cp2X} ${cp2Y}, ${targetX} ${targetY}`;

        return (
            <path
                d={d}
                fill="none"
                stroke="var(--sb-system-blue)"
                strokeWidth="2.5"
                strokeDasharray="6,4"
                className="sb-edge-connecting-draft"
            />
        );
    };

    // Render Status Badge for Node
    const renderNodeStatusBadge = (node: GraphNode, isSimActive: boolean) => {
        if (isSimActive) {
            return (
                <span className="sb-node-status-badge sb-status-running animate-pulse">
                    <span className="sb-status-spinner" />
                    <span>Running...</span>
                </span>
            );
        }

        const status = node.status || 'pending';
        const duration = node.executionDurationMs || nodeExecutionDurations[node.id];

        switch (status) {
            case 'running':
                return (
                    <span className="sb-node-status-badge sb-status-running">
                        <span className="sb-status-spinner" />
                        <span>Running</span>
                    </span>
                );
            case 'completed':
                return (
                    <span className="sb-node-status-badge sb-status-completed">
                        <span>✓ Done</span>
                        {duration ? <span className="sb-status-duration">{duration}ms</span> : null}
                    </span>
                );
            case 'error':
                return (
                    <span className="sb-node-status-badge sb-status-error" title={node.errorMessage || 'Execution failed'}>
                        <span>✕ Error</span>
                    </span>
                );
            case 'pending':
            case 'active':
            default:
                return (
                    <span className="sb-node-status-badge sb-status-pending">
                        <span>⏳ Ready</span>
                    </span>
                );
        }
    };

    return (
        <div className="sb-primitive-node-graph">
            {/* Top Flow Controller & Status Header */}
            <div className="sb-graph-topbar">
                <div className="sb-graph-title-block">
                    <h3 className="sb-primitive-main-title">{graph.title}</h3>
                    {graph.subtitle && <p className="sb-primitive-subtitle">{graph.subtitle}</p>}
                </div>

                {/* Flow controls: a 3D graph runs its tool nodes for real; an automation graph keeps its flow simulation */}
                <div className="sb-graph-sim-controller">
                    {is3DGraph ? (
                        <>
                            <div className="sb-sim-status-pill" title="What has run in this graph (real tool runs only)">
                                <span className={`sb-sim-indicator-dot sb-sim-${runningToolNodes.length ? 'playing' : 'idle'}`} />
                                <span className="sb-sim-status-text">{toolRunStatus}</span>
                            </div>
                            {graph.nodes.some(isToolNode) && (
                                <div className="sb-sim-btn-group">
                                    <button type="button" className={`sb-btn sb-btn-sim ${toolFlowRunning ? 'sb-btn-secondary' : 'sb-btn-primary'}`} onClick={handleRunToolFlow}
                                        title={toolFlowRunning ? 'Stop the running tools' : 'Run every tool node in dependency order'}>
                                        <IconPlay size={13} />
                                        <span>{toolFlowRunning ? 'Stop' : 'Run'}</span>
                                    </button>
                                    <button type="button" className="sb-btn sb-btn-secondary sb-btn-sim" onClick={handleStepToolFlow} disabled={toolFlowRunning || runningToolNodes.length > 0}
                                        title="Run the next tool node that has not run yet">
                                        <IconStepForward size={13} />
                                        <span>Step</span>
                                    </button>
                                    <button type="button" className="sb-btn sb-btn-secondary sb-btn-sim" onClick={handleResetToolRuns} disabled={toolFlowRunning || runningToolNodes.length > 0}
                                        title="Clear the tool nodes' results (the scene and the chat keep theirs)">
                                        <span>↺ Reset</span>
                                    </button>
                                </div>
                            )}
                        </>
                    ) : (<>
                    <div className="sb-sim-status-pill">
                        <span className={`sb-sim-indicator-dot sb-sim-${simStatus}`} />
                        <span className="sb-sim-status-text">
                            {simStatus === 'playing'
                                ? `Running Flow (Stage ${simStep + 1}/${Math.max(1, executionStages.length)})`
                                : simStatus === 'paused'
                                ? `Flow Paused (Stage ${simStep + 1}/${Math.max(1, executionStages.length)})`
                                : 'Flow Simulation Ready'}
                        </span>
                    </div>

                    <div className="sb-sim-btn-group">
                        {simStatus === 'playing' ? (
                            <button
                                type="button"
                                className="sb-btn sb-btn-secondary sb-btn-sim"
                                onClick={handlePauseFlow}
                                title="Pause flow simulation"
                            >
                                <IconPause size={13} />
                                <span>Pause</span>
                            </button>
                        ) : (
                            <button
                                type="button"
                                className="sb-btn sb-btn-primary sb-btn-sim sb-btn-sim-play"
                                onClick={handlePlayFlow}
                                title="Play live execution flow simulation"
                            >
                                <IconPlay size={13} />
                                <span>Play Flow</span>
                            </button>
                        )}

                        <button
                            type="button"
                            className="sb-btn sb-btn-secondary sb-btn-sim"
                            onClick={handleStepFlow}
                            title="Step forward 1 stage"
                        >
                            <IconStepForward size={13} />
                            <span>Step</span>
                        </button>

                        <button
                            type="button"
                            className="sb-btn sb-btn-secondary sb-btn-sim"
                            onClick={handleResetFlow}
                            title="Reset simulation"
                        >
                            <span>↺ Reset</span>
                        </button>

                    </div>
                    </>)}

                    <div className="sb-graph-dock-divider" style={{ height: '20px', margin: '0 4px' }} />

                    <button
                        type="button"
                        className={`sb-btn sb-btn-secondary sb-btn-sim ${showLibraryPanel ? 'sb-active' : ''}`}
                        onClick={() => setShowLibraryPanel(!showLibraryPanel)}
                        title="Toggle Node Library Panel"
                        style={{ display: 'flex', alignItems: 'center', gap: '6px' }}
                    >
                        <IconBoxes size={13} />
                        <span>Library</span>
                    </button>
                </div>

                {/* Quick Node Addition Triggers (automation graphs) */}
                {!is3DGraph && (
                <div className="sb-graph-quick-actions" style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '10px', paddingTop: '8px', borderTop: '1px solid var(--sb-surface-border)', flexWrap: 'wrap' }}>
                    <button
                        type="button"
                        className="sb-btn sb-btn-secondary sb-btn-xs sb-graph-quick-btn"
                        onClick={() => handleAddCustomNode('input')}
                        title="Add Webhook Trigger Node"
                    >
                        <IconZap size={11} />
                        <span>+ Add Webhook Trigger Node</span>
                    </button>
                    <button
                        type="button"
                        className="sb-btn sb-btn-secondary sb-btn-xs sb-graph-quick-btn"
                        onClick={() => handleAddCustomNode('ai')}
                        title="Add AI Reasoning Node"
                    >
                        <IconSparkles size={11} />
                        <span>+ Add AI Reasoning Node</span>
                    </button>
                    <button
                        type="button"
                        className="sb-btn sb-btn-secondary sb-btn-xs sb-graph-quick-btn"
                        onClick={() => handleAddCustomNode('database')}
                        title="Add PostgreSQL Database Action"
                    >
                        <IconDatabase size={11} />
                        <span>+ Add Postgres DB Action</span>
                    </button>
                </div>
                )}
            </div>

            {/* Main Layout Container: Canvas on left, Collapsible Library Panel on right */}
            <div className="sb-canvas-layout-container">
                {/* Interactive SVG Canvas Viewport */}
                <div
                    ref={viewportRef}
                    className={`sb-graph-canvas-viewport ${connectingState ? 'sb-canvas-connecting' : ''}`}
                    // panning is the surface's transform; a browser scroll of this box (bringing a focused field or a
                    // node into view) would shift the dock and cut nodes off, so it is always put back
                    onScroll={e => { if (e.currentTarget.scrollTop || e.currentTarget.scrollLeft) { e.currentTarget.scrollTop = 0; e.currentTarget.scrollLeft = 0; } }}
                    onMouseDown={handleMouseDownCanvas}
                    onMouseMove={handleMouseMove}
                    onMouseUp={handleMouseUp}
                    onDragOver={handleDragOver}
                    onDrop={handleDrop}
                >
                <div
                    className="sb-graph-canvas-surface"
                    style={{
                        transform: `translate(${panPosition.x}px, ${panPosition.y}px) scale(${zoomLevel})`,
                        transformOrigin: '0 0'
                    }}
                >
                    {/* SVG Connector Layer */}
                    <svg className="sb-graph-svg-layer" style={{ overflow: 'visible' }}>
                        <defs>
                            {['blue', 'indigo', 'emerald', 'amber', 'purple', 'rose', 'cyan'].map(color => (
                                <marker
                                    key={color}
                                    id={`arrow-${color}`}
                                    viewBox="0 0 12 12"
                                    refX="9"
                                    refY="6"
                                    markerWidth="6"
                                    markerHeight="6"
                                    orient="auto"
                                    overflow="visible"
                                >
                                    <path
                                        d="M 1 2 L 10 6 L 1 10 z"
                                        fill={`var(--sb-system-${color}, #007aff)`}
                                    />
                                </marker>
                            ))}
                        </defs>
                        {graph.edges.map(edge => renderEdge(edge))}
                        {renderDraftConnection()}
                    </svg>

                    {/* Nodes Layer */}
                    {graph.nodes.map(node => {
                        const isSelected = selectedNodeId === node.id;
                        const isDragging = draggingNodeId === node.id;
                        const isSimActive = activeSimNodeIds.includes(node.id);
                        const accent = node.color || 'blue';
                        const category = node.category || 'process';

                        let cardHeight: string | undefined = undefined;
                        if (category === 'scene-3d' || category === '3d-card') {
                            cardHeight = '310px';
                        } else if (category === 'camera-3d') {
                            cardHeight = '220px';
                        } else if (category === 'map-3d') {
                            cardHeight = '200px';
                        } else if (category === 'studio-mcp') {
                            cardHeight = '180px';
                        } else if (category === 'image' || category === 'image-card') {
                            cardHeight = '290px';
                        } else if (category === 'video' || category === 'video-card') {
                            cardHeight = '290px';
                        } else if (category === 'audio' || category === 'audio-card') {
                            cardHeight = '250px';
                        }

                        return (
                            <div
                                key={node.id}
                                className={`sb-graph-node-card sb-accent-${accent} ${
                                    isSelected ? 'sb-node-selected' : ''
                                } ${isDragging ? 'sb-node-dragging' : ''} ${
                                    isSimActive ? 'sb-node-sim-active' : ''
                                }`}
                                style={{ left: `${node.x}px`, top: `${node.y}px`, height: cardHeight, ...(node.parameters?.off ? { opacity: 0.45 } : {}), ...(displayFlag?.nodeId === node.id ? { outline: '2px solid rgba(10,132,255,0.8)', outlineOffset: '2px' } : {}) }}
                                onMouseDown={e => handleMouseDownNode(node, e)}
                                onDoubleClick={e => handleDoubleClickNode(node, e)}
                                onMouseUp={e => {
                                    if (connectingState && connectingDragged.current && connectingState.originNodeId !== node.id) {
                                        connectingDragged.current = false;
                                        handleCompleteConnection(node.id, connectingState.originPortType === 'output' ? 'input' : 'output', e);
                                    }
                                }}
                                onClick={e => {
                                    if (connectingState && connectingState.originNodeId !== node.id) {
                                        handleCompleteConnection(
                                            node.id,
                                            connectingState.originPortType === 'output' ? 'input' : 'output',
                                            e
                                        );
                                    }
                                }}
                            >
                                {/* Left Input Port (Bi-directional) */}
                                <div
                                    className={`sb-node-port sb-node-port-in ${
                                        connectingState?.originNodeId === node.id && connectingState.originPortType === 'input'
                                            ? 'sb-port-connecting'
                                            : ''
                                    }`}
                                    title="Input port (drag to connect from or drop to connect to)"
                                    onMouseDown={e => handleStartConnecting(node.id, 'input', e)}
                                    onMouseUp={e => handleCompleteConnection(node.id, 'input', e)}
                                >
                                    <span className="sb-port-dot" />
                                </div>

                                {/* Right Output Port (Bi-directional) */}
                                <div
                                    className={`sb-node-port sb-node-port-out ${
                                        connectingState?.originNodeId === node.id && connectingState.originPortType === 'output'
                                            ? 'sb-port-connecting'
                                            : ''
                                    }`}
                                    title="Output port (drag to connect downstream node)"
                                    onMouseDown={e => handleStartConnecting(node.id, 'output', e)}
                                    onMouseUp={e => handleCompleteConnection(node.id, 'output', e)}
                                >
                                    <span className="sb-port-dot" />
                                </div>

                                {/* Header with Icon & Category */}
                                <div className="sb-graph-node-header">
                                    <div className="sb-graph-node-title-group">
                                        <div className="sb-node-cat-badge">
                                            <span className="sb-node-cat-icon">{getNodeCategoryIcon(category)}</span>
                                            <span>{category.toUpperCase()}</span>
                                        </div>
                                        <h5 className="sb-graph-node-title" title={node.label}>{node.label}</h5>
                                        {node.subtitle && (
                                            <span className="sb-graph-node-sub" title={node.subtitle}>{node.subtitle}</span>
                                        )}
                                    </div>
                                    <div className="sb-node-header-status">
                                        {renderNodeStatusBadge(node, isSimActive)}
                                    </div>
                                </div>

                                {/* Custom Node Bodies for Generative Media Cards */}
                                {(category === 'image' || category === 'image-card') && (
                                    <div style={{ display: 'flex', flexDirection: 'column', height: '180px', gap: '8px', margin: '8px 0' }}>
                                        <div className="sb-node-image-container" style={{
                                            height: '110px',
                                            borderRadius: '8px',
                                            border: '1px solid rgba(255, 255, 255, 0.1)',
                                            background: '#0a0a0a',
                                            overflow: 'hidden',
                                            position: 'relative',
                                            display: 'flex',
                                            alignItems: 'center',
                                            justifyContent: 'center'
                                        }}>
                                            {node.parameters?.isGenerating ? (
                                                <div className="sb-node-generating-overlay" style={{
                                                    position: 'absolute',
                                                    inset: 0,
                                                    background: 'rgba(0,0,0,0.6)',
                                                    display: 'flex',
                                                    flexDirection: 'column',
                                                    alignItems: 'center',
                                                    justifyContent: 'center',
                                                    gap: '8px',
                                                    fontSize: '11px',
                                                    color: 'var(--sb-text-secondary)'
                                                }}>
                                                    <div className="sb-spinner" style={{
                                                        width: '16px',
                                                        height: '16px',
                                                        borderRadius: '50%',
                                                        border: '2px solid rgba(255,255,255,0.2)',
                                                        borderTopColor: '#af52de',
                                                        animation: 'sb-spin 1s linear infinite'
                                                    }} />
                                                    <span>Synthesizing Image...</span>
                                                </div>
                                            ) : null}
                                            {node.parameters?.mediaUrl || node.parameters?.imageUrl || node.outputData?.url ? (
                                                <img
                                                    src={node.parameters?.mediaUrl || node.parameters?.imageUrl || node.outputData?.url}
                                                    alt={node.label}
                                                    style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                                                />
                                            ) : (
                                                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px', color: 'var(--sb-text-tertiary)', fontSize: '11px' }}>
                                                    <IconImage size={24} strokeWidth={1.2} />
                                                    <span>No Image Synthesized</span>
                                                </div>
                                            )}
                                            <NodeMediaStatus node={node} />
                                        </div>
                                        <div className="sb-node-prompt-box" style={{
                                            display: 'flex',
                                            alignItems: 'center',
                                            gap: '4px',
                                            background: 'rgba(0, 0, 0, 0.25)',
                                            borderRadius: '8px',
                                            border: '1px solid rgba(255, 255, 255, 0.12)',
                                            padding: '2px 6px',
                                            marginTop: 'auto'
                                        }}>
                                            <IconSparkles size={11} color="var(--sb-system-purple)" />
                                            <input
                                                type="text"
                                                value={node.parameters?.prompt || ''}
                                                placeholder="Describe image scenery..."
                                                onMouseDown={e => e.stopPropagation()}
                                                onChange={e => handleEditNode(node.id, {
                                                    parameters: { ...node.parameters, prompt: e.target.value }
                                                })}
                                                onKeyDown={e => {
                                                    if (e.key === 'Enter') {
                                                        e.preventDefault();
                                                        handleExecutePromptBox(node);
                                                    }
                                                }}
                                                style={{
                                                    background: 'transparent',
                                                    border: 'none',
                                                    outline: 'none',
                                                    fontSize: '11px',
                                                    color: 'var(--sb-text-label)',
                                                    flex: 1,
                                                    minWidth: 0,
                                                    padding: '4px 0'
                                                }}
                                            />
                                            <button
                                                type="button"
                                                className="sb-btn sb-node-prompt-btn"
                                                onClick={() => handleExecutePromptBox(node)}
                                                style={{
                                                    background: 'transparent',
                                                    border: 'none',
                                                    cursor: 'pointer',
                                                    color: 'var(--sb-system-purple)',
                                                    display: 'flex',
                                                    alignItems: 'center',
                                                    justifyContent: 'center',
                                                    padding: '2px'
                                                }}
                                            >
                                                <IconPlay size={10} />
                                            </button>
                                        </div>
                                    </div>
                                )}

                                {(category === 'video' || category === 'video-card') && (
                                    <div style={{ display: 'flex', flexDirection: 'column', height: '180px', gap: '8px', margin: '8px 0' }}>
                                        <div className="sb-node-video-container" style={{
                                            height: '110px',
                                            borderRadius: '8px',
                                            border: '1px solid rgba(255, 255, 255, 0.1)',
                                            background: '#0a0a0a',
                                            overflow: 'hidden',
                                            position: 'relative',
                                            display: 'flex',
                                            alignItems: 'center',
                                            justifyContent: 'center'
                                        }}>
                                            {node.parameters?.isGenerating ? (
                                                <div className="sb-node-generating-overlay" style={{
                                                    position: 'absolute',
                                                    inset: 0,
                                                    background: 'rgba(0,0,0,0.6)',
                                                    display: 'flex',
                                                    flexDirection: 'column',
                                                    alignItems: 'center',
                                                    justifyContent: 'center',
                                                    gap: '8px',
                                                    fontSize: '11px',
                                                    color: 'var(--sb-text-secondary)'
                                                }}>
                                                    <div className="sb-spinner" style={{
                                                        width: '16px',
                                                        height: '16px',
                                                        borderRadius: '50%',
                                                        border: '2px solid rgba(255,255,255,0.2)',
                                                        borderTopColor: '#ff2d55',
                                                        animation: 'sb-spin 1s linear infinite'
                                                    }} />
                                                    <span>Synthesizing Video...</span>
                                                </div>
                                            ) : null}
                                            {node.parameters?.mediaUrl || node.parameters?.videoUrl || node.outputData?.url ? (
                                                <video
                                                    src={node.parameters?.mediaUrl || node.parameters?.videoUrl || node.outputData?.url}
                                                    style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                                                    controls={true}
                                                    preload="metadata"
                                                />
                                            ) : (
                                                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px', color: 'var(--sb-text-tertiary)', fontSize: '11px' }}>
                                                    <IconVideo size={24} strokeWidth={1.2} />
                                                    <span>No Video Synthesized</span>
                                                </div>
                                            )}
                                            <NodeMediaStatus node={node} />
                                        </div>
                                        <div className="sb-node-prompt-box" style={{
                                            display: 'flex',
                                            alignItems: 'center',
                                            gap: '4px',
                                            background: 'rgba(0, 0, 0, 0.25)',
                                            borderRadius: '8px',
                                            border: '1px solid rgba(255, 255, 255, 0.12)',
                                            padding: '2px 6px',
                                            marginTop: 'auto'
                                        }}>
                                            <IconSparkles size={11} color="var(--sb-system-rose)" />
                                            <input
                                                type="text"
                                                value={node.parameters?.prompt || ''}
                                                placeholder="Describe motion or camera..."
                                                onMouseDown={e => e.stopPropagation()}
                                                onChange={e => handleEditNode(node.id, {
                                                    parameters: { ...node.parameters, prompt: e.target.value }
                                                })}
                                                onKeyDown={e => {
                                                    if (e.key === 'Enter') {
                                                        e.preventDefault();
                                                        handleExecutePromptBox(node);
                                                    }
                                                }}
                                                style={{
                                                    background: 'transparent',
                                                    border: 'none',
                                                    outline: 'none',
                                                    fontSize: '11px',
                                                    color: 'var(--sb-text-label)',
                                                    flex: 1,
                                                    minWidth: 0,
                                                    padding: '4px 0'
                                                }}
                                            />
                                            <button
                                                type="button"
                                                className="sb-btn sb-node-prompt-btn"
                                                onClick={() => handleExecutePromptBox(node)}
                                                style={{
                                                    background: 'transparent',
                                                    border: 'none',
                                                    cursor: 'pointer',
                                                    color: 'var(--sb-system-rose)',
                                                    display: 'flex',
                                                    alignItems: 'center',
                                                    justifyContent: 'center',
                                                    padding: '2px'
                                                }}
                                            >
                                                <IconPlay size={10} />
                                            </button>
                                        </div>
                                    </div>
                                )}

                                {(category === 'audio' || category === 'audio-card') && (
                                    <div style={{ display: 'flex', flexDirection: 'column', height: '140px', gap: '8px', margin: '8px 0' }}>
                                        <div className="sb-node-audio-container" style={{
                                            height: '70px',
                                            borderRadius: '8px',
                                            border: '1px solid rgba(255, 255, 255, 0.1)',
                                            background: '#0a0a0a',
                                            overflow: 'hidden',
                                            position: 'relative',
                                            display: 'flex',
                                            flexDirection: 'column',
                                            justifyContent: 'space-between',
                                            padding: '8px'
                                        }}>
                                            {node.parameters?.isGenerating ? (
                                                <div className="sb-node-generating-overlay" style={{
                                                    position: 'absolute',
                                                    inset: 0,
                                                    background: 'rgba(0,0,0,0.6)',
                                                    display: 'flex',
                                                    flexDirection: 'column',
                                                    alignItems: 'center',
                                                    justifyContent: 'center',
                                                    gap: '4px',
                                                    fontSize: '11px',
                                                    color: 'var(--sb-text-secondary)'
                                                }}>
                                                    <div className="sb-spinner" style={{
                                                        width: '12px',
                                                        height: '12px',
                                                        borderRadius: '50%',
                                                        border: '2px solid rgba(255,255,255,0.2)',
                                                        borderTopColor: '#5856d6',
                                                        animation: 'sb-spin 1s linear infinite'
                                                    }} />
                                                    <span>Generating Audio...</span>
                                                </div>
                                            ) : null}
                                            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flex: 1 }}>
                                                <button
                                                    type="button"
                                                    className="sb-btn sb-audio-play-btn"
                                                    onMouseDown={e => e.stopPropagation()}
                                                    onClick={() => {
                                                        const audioUrl = node.parameters?.mediaUrl || node.parameters?.audioUrl || node.outputData?.url;
                                                        if (audioUrl) {
                                                            const existingAudio = (window as any)[`audio_${node.id}`] as HTMLAudioElement;
                                                            if (existingAudio) {
                                                                if (existingAudio.paused) {
                                                                    existingAudio.play();
                                                                } else {
                                                                    existingAudio.pause();
                                                                }
                                                            } else {
                                                                const a = new Audio(audioUrl);
                                                                (window as any)[`audio_${node.id}`] = a;
                                                                a.play();
                                                            }
                                                        }
                                                    }}
                                                    style={{
                                                        width: '28px',
                                                        height: '28px',
                                                        borderRadius: '50%',
                                                        background: 'rgba(255,255,255,0.1)',
                                                        border: 'none',
                                                        cursor: 'pointer',
                                                        display: 'flex',
                                                        alignItems: 'center',
                                                        justifyContent: 'center',
                                                        color: 'var(--sb-text-label)'
                                                    }}
                                                >
                                                    <IconPlay size={12} />
                                                </button>
                                                
                                                <div className="sb-waveform-viz" style={{
                                                    flex: 1,
                                                    height: '24px',
                                                    display: 'flex',
                                                    alignItems: 'center',
                                                    gap: '2px'
                                                }}>
                                                    {Array.from({ length: 24 }).map((_, idx) => {
                                                        const heights = [4, 12, 18, 8, 22, 14, 6, 20, 16, 12, 24, 18, 10, 22, 14, 8, 16, 20, 6, 14, 12, 18, 4, 8];
                                                        return (
                                                            <div key={idx} style={{
                                                                flex: 1,
                                                                height: `${heights[idx]}px`,
                                                                background: node.parameters?.mediaUrl || node.parameters?.audioUrl || node.outputData?.url ? 'var(--sb-system-indigo)' : 'rgba(255,255,255,0.15)',
                                                                borderRadius: '1px'
                                                            }} />
                                                        );
                                                    })}
                                                </div>
                                            </div>
                                            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '9px', color: 'var(--sb-text-tertiary)' }}>
                                                <span>{node.parameters?.audioKind?.toUpperCase() || 'AUDIO'}</span>
                                                <span>00:15 / 00:15</span>
                                            </div>
                                        </div>
                                        <div className="sb-node-prompt-box" style={{
                                            display: 'flex',
                                            alignItems: 'center',
                                            gap: '4px',
                                            background: 'rgba(0, 0, 0, 0.25)',
                                            borderRadius: '8px',
                                            border: '1px solid rgba(255, 255, 255, 0.12)',
                                            padding: '2px 6px',
                                            marginTop: 'auto'
                                        }}>
                                            <IconSparkles size={11} color="var(--sb-system-indigo)" />
                                            <input
                                                type="text"
                                                value={node.parameters?.prompt || ''}
                                                placeholder="Describe voice script..."
                                                onMouseDown={e => e.stopPropagation()}
                                                onChange={e => handleEditNode(node.id, {
                                                    parameters: { ...node.parameters, prompt: e.target.value }
                                                })}
                                                onKeyDown={e => {
                                                    if (e.key === 'Enter') {
                                                        e.preventDefault();
                                                        handleExecutePromptBox(node);
                                                    }
                                                }}
                                                style={{
                                                    background: 'transparent',
                                                    border: 'none',
                                                    outline: 'none',
                                                    fontSize: '11px',
                                                    color: 'var(--sb-text-label)',
                                                    flex: 1,
                                                    minWidth: 0,
                                                    padding: '4px 0'
                                                }}
                                            />
                                            <button
                                                type="button"
                                                className="sb-btn sb-node-prompt-btn"
                                                onClick={() => handleExecutePromptBox(node)}
                                                style={{
                                                    background: 'transparent',
                                                    border: 'none',
                                                    cursor: 'pointer',
                                                    color: 'var(--sb-system-indigo)',
                                                    display: 'flex',
                                                    alignItems: 'center',
                                                    justifyContent: 'center',
                                                    padding: '2px'
                                                }}
                                            >
                                                <IconPlay size={10} />
                                            </button>
                                        </div>
                                    </div>
                                )}

                                {(category === 'scene-3d' || category === '3d-card') && (
                                    <div style={{ display: 'flex', flexDirection: 'column', height: '200px', gap: '8px', margin: '8px 0' }}>
                                        <div className="sb-node-custom-body sb-body-scene-3d" style={{
                                            height: '110px',
                                            borderRadius: '8px',
                                            border: '1px dashed rgba(255, 255, 255, 0.15)',
                                            background: 'rgba(0, 0, 0, 0.2)',
                                            overflow: 'hidden',
                                            display: 'flex',
                                            flexDirection: 'column',
                                            justifyContent: 'space-between',
                                            padding: '6px 8px',
                                            fontSize: '11px'
                                        }}>
                                            {/* Wireframe Grid Visualization */}
                                            <div style={{ display: 'flex', flex: 1, gap: '6px', alignItems: 'center' }}>
                                                <div style={{
                                                    width: '40px',
                                                    height: '40px',
                                                    borderRadius: '4px',
                                                    background: 'radial-gradient(circle, rgba(50, 173, 230, 0.3) 0%, rgba(0,0,0,0.5) 100%)',
                                                    border: '1px solid rgba(50, 173, 230, 0.4)',
                                                    display: 'flex',
                                                    alignItems: 'center',
                                                    justifyContent: 'center',
                                                    position: 'relative',
                                                    overflow: 'hidden'
                                                }}>
                                                    {/* Simulated 3D wireframe cube */}
                                                    <div className={isSimActive ? "sb-wireframe-cube-spinning" : ""} style={{
                                                        width: '18px',
                                                        height: '18px',
                                                        border: '1px solid var(--sb-system-cyan)',
                                                        transform: 'rotateX(45deg) rotateY(45deg)'
                                                    }} />
                                                    <div style={{
                                                        position: 'absolute',
                                                        width: '100%',
                                                        height: '100%',
                                                        background: 'linear-gradient(rgba(255,255,255,0.05) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.05) 1px, transparent 1px)',
                                                        backgroundSize: '4px 4px'
                                                    }} />
                                                </div>
                                                <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', flex: 1 }}>
                                                    <div style={{ fontWeight: 600, color: 'var(--sb-text-label)' }}>Procedural Frame</div>
                                                    <div style={{ color: 'var(--sb-text-secondary)', fontSize: '10px' }}>Mesh: <span style={{ color: 'var(--sb-system-cyan)' }}>{node.parameters?.meshType || 'cube'}</span></div>
                                                    <div style={{ color: 'var(--sb-text-secondary)', fontSize: '10px' }}>Sky: <span style={{ color: 'var(--sb-system-indigo)' }}>{node.parameters?.skybox || 'sunset'}</span></div>
                                                </div>
                                            </div>
                                            {/* Coord variables */}
                                            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '4px', background: 'rgba(255,255,255,0.03)', padding: '4px', borderRadius: '4px', border: '1px solid rgba(255,255,255,0.05)' }}>
                                                <div>X: <span style={{ color: 'var(--sb-text-label)' }}>{node.parameters?.position?.x ?? 0}</span></div>
                                                <div>Y: <span style={{ color: 'var(--sb-text-label)' }}>{node.parameters?.position?.y ?? 0}</span></div>
                                                <div>Z: <span style={{ color: 'var(--sb-text-label)' }}>{node.parameters?.position?.z ?? 0}</span></div>
                                                <div>Env: <span style={{ color: 'var(--sb-system-cyan)', textTransform: 'capitalize' }}>{node.parameters?.environment ?? 'studio'}</span></div>
                                            </div>
                                        </div>
                                        <div className="sb-node-prompt-box" style={{
                                            display: 'flex',
                                            alignItems: 'center',
                                            gap: '4px',
                                            background: 'rgba(0, 0, 0, 0.25)',
                                            borderRadius: '8px',
                                            border: '1px solid rgba(255, 255, 255, 0.12)',
                                            padding: '2px 6px',
                                            marginTop: 'auto'
                                        }}>
                                            <IconSparkles size={11} color="var(--sb-system-cyan)" />
                                            <input
                                                type="text"
                                                value={node.parameters?.prompt || ''}
                                                placeholder="Describe 3D geometry..."
                                                onMouseDown={e => e.stopPropagation()}
                                                onChange={e => handleEditNode(node.id, {
                                                    parameters: { ...node.parameters, prompt: e.target.value }
                                                })}
                                                onKeyDown={e => {
                                                    if (e.key === 'Enter') {
                                                        e.preventDefault();
                                                        handleExecutePromptBox(node);
                                                    }
                                                }}
                                                style={{
                                                    background: 'transparent',
                                                    border: 'none',
                                                    outline: 'none',
                                                    fontSize: '11px',
                                                    color: 'var(--sb-text-label)',
                                                    flex: 1,
                                                    minWidth: 0,
                                                    padding: '4px 0'
                                                }}
                                            />
                                            <button
                                                type="button"
                                                className="sb-btn sb-node-prompt-btn"
                                                onClick={() => handleExecutePromptBox(node)}
                                                style={{
                                                    background: 'transparent',
                                                    border: 'none',
                                                    cursor: 'pointer',
                                                    color: 'var(--sb-system-cyan)',
                                                    display: 'flex',
                                                    alignItems: 'center',
                                                    justifyContent: 'center',
                                                    padding: '2px'
                                                }}
                                            >
                                                <IconPlay size={10} />
                                            </button>
                                        </div>
                                    </div>
                                )}

                                {category === 'camera-3d' && (
                                    <div className="sb-node-custom-body sb-body-camera-3d" style={{
                                        margin: '8px 0',
                                        height: '120px',
                                        borderRadius: '8px',
                                        border: '1px dashed rgba(255, 255, 255, 0.15)',
                                        background: 'rgba(0, 0, 0, 0.2)',
                                        overflow: 'hidden',
                                        display: 'flex',
                                        flexDirection: 'column',
                                        justifyContent: 'space-between',
                                        padding: '6px 8px',
                                        fontSize: '11px'
                                    }}>
                                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                            <span style={{ fontWeight: 600 }}>Spline Path Track</span>
                                            <span style={{ fontSize: '9px', padding: '1px 4px', borderRadius: '3px', background: 'rgba(255, 45, 85, 0.2)', border: '1px solid rgba(255, 45, 85, 0.3)', color: '#ff2d55' }}>
                                                {node.parameters?.pathType?.toUpperCase() || 'BEZIER'}
                                            </span>
                                        </div>

                                        {/* Keyframe Track Timeline with diamonds */}
                                        <div style={{ position: 'relative', height: '24px', background: 'rgba(255, 255, 255, 0.04)', borderRadius: '4px', display: 'flex', alignItems: 'center', padding: '0 8px', border: '1px solid rgba(255, 255, 255, 0.05)' }}>
                                            <div style={{ width: '100%', height: '2px', background: 'rgba(255, 255, 255, 0.2)', borderRadius: '1px' }} />
                                            {/* Keyframe diamonds */}
                                            <div style={{ position: 'absolute', left: '15%', width: '6px', height: '6px', background: '#ff2d55', transform: 'rotate(45deg)', boxShadow: '0 0 4px #ff2d55' }} title="Keyframe 1" />
                                            <div style={{ position: 'absolute', left: '40%', width: '6px', height: '6px', background: '#ff2d55', transform: 'rotate(45deg)', boxShadow: '0 0 4px #ff2d55' }} title="Keyframe 2" />
                                            <div style={{ position: 'absolute', left: '65%', width: '6px', height: '6px', background: '#ff2d55', transform: 'rotate(45deg)', boxShadow: '0 0 4px #ff2d55' }} title="Keyframe 3" />
                                            <div style={{ position: 'absolute', left: '90%', width: '6px', height: '6px', background: '#ff2d55', transform: 'rotate(45deg)', boxShadow: '0 0 4px #ff2d55' }} title="Keyframe 4" />
                                            
                                            {/* Sliding Scrubber */}
                                            <div className="sb-camera-scrubber" style={{
                                                position: 'absolute',
                                                left: '8px',
                                                top: '3px',
                                                bottom: '3px',
                                                width: '2px',
                                                background: '#fff',
                                                boxShadow: '0 0 6px #fff',
                                                animation: isSimActive || simStatus === 'playing' ? 'sb-scrub 5s linear infinite' : 'none'
                                            }} />
                                        </div>

                                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '10px', color: 'var(--sb-text-secondary)' }}>
                                            <span>Duration: <span style={{ color: 'var(--sb-text-label)', fontWeight: 600 }}>{node.parameters?.durationSeconds || 5}s</span></span>
                                            <span>Loop: <span style={{ color: '#34c759', fontWeight: 600 }}>{node.parameters?.loop ? 'YES' : 'NO'}</span></span>
                                            <span>Keys: <span style={{ color: 'var(--sb-text-label)', fontWeight: 600 }}>{node.parameters?.keyframesCount || 4} pts</span></span>
                                        </div>
                                    </div>
                                )}

                                {category === 'map-3d' && (
                                    <div className="sb-node-custom-body sb-body-map-3d" style={{
                                        margin: '8px 0',
                                        height: '100px',
                                        borderRadius: '8px',
                                        border: '1px dashed rgba(255, 255, 255, 0.15)',
                                        background: 'rgba(0, 0, 0, 0.2)',
                                        overflow: 'hidden',
                                        display: 'flex',
                                        flexDirection: 'column',
                                        justifyContent: 'space-between',
                                        padding: '6px 8px',
                                        fontSize: '11px'
                                    }}>
                                        {/* Globe & Coordinates info */}
                                        <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flex: 1 }}>
                                            <div className={isSimActive ? "sb-wireframe-cube-spinning" : ""} style={{
                                                width: '36px',
                                                height: '36px',
                                                borderRadius: '50%',
                                                background: 'radial-gradient(circle at 30% 30%, #34c759 0%, #007aff 80%)',
                                                border: '1px solid rgba(255,255,255,0.2)',
                                                boxShadow: isSimActive ? '0 0 10px rgba(52, 199, 89, 0.4)' : 'none',
                                                position: 'relative'
                                            }}>
                                                {/* Map markers representation */}
                                                <div style={{ position: 'absolute', top: '25%', left: '45%', width: '4px', height: '4px', background: '#ff2d55', borderRadius: '50%' }} />
                                                <div style={{ position: 'absolute', top: '55%', left: '65%', width: '4px', height: '4px', background: '#ff9500', borderRadius: '50%' }} />
                                            </div>
                                            <div style={{ display: 'flex', flexDirection: 'column', gap: '1px', flex: 1 }}>
                                                <div style={{ fontWeight: 600, color: 'var(--sb-text-label)' }}>Photorealistic 3D Tiles</div>
                                                <div style={{ color: 'var(--sb-text-secondary)', fontSize: '10px' }}>Lat: <span style={{ color: 'var(--sb-text-label)' }}>{node.parameters?.latitude ?? 37.7749}</span></div>
                                                <div style={{ color: 'var(--sb-text-secondary)', fontSize: '10px' }}>Lng: <span style={{ color: 'var(--sb-text-label)' }}>{node.parameters?.longitude ?? -122.4194}</span></div>
                                            </div>
                                        </div>

                                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '10px', background: 'rgba(0,0,0,0.15)', padding: '3px 6px', borderRadius: '4px' }}>
                                            <span>Zoom: <span style={{ color: 'var(--sb-system-emerald)' }}>{node.parameters?.zoom || 17}x</span></span>
                                            <span>Style: <span style={{ color: 'var(--sb-text-label)' }}>{node.parameters?.style || 'realistic'}</span></span>
                                            <span>POI: <span style={{ color: node.parameters?.poiEnabled !== false ? '#34c759' : '#ff2d55' }}>{node.parameters?.poiEnabled !== false ? 'ON' : 'OFF'}</span></span>
                                        </div>
                                    </div>
                                )}

                                {category === 'studio-mcp' && (
                                    <div className="sb-node-custom-body sb-body-studio-mcp" style={{
                                        margin: '8px 0',
                                        height: '80px',
                                        borderRadius: '8px',
                                        border: '1px dashed rgba(255, 255, 255, 0.15)',
                                        background: 'rgba(0, 0, 0, 0.2)',
                                        overflow: 'hidden',
                                        display: 'flex',
                                        flexDirection: 'column',
                                        justifyContent: 'space-between',
                                        padding: '6px 8px',
                                        fontSize: '11px'
                                    }}>
                                        {/* Pulse Connection Status Indicator */}
                                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                            <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
                                                <span className={`sb-studio-pulse ${isSimActive ? 'sb-pulse-active' : ''}`} style={{
                                                    width: '6px',
                                                    height: '6px',
                                                    borderRadius: '50%',
                                                    background: '#34c759',
                                                    boxShadow: '0 0 6px #34c759',
                                                    display: 'inline-block'
                                                }} />
                                                <span style={{ fontWeight: 600 }}>Active Host</span>
                                            </div>
                                            <span style={{ fontSize: '9px', color: 'var(--sb-text-secondary)' }}>mcp://localhost:4000</span>
                                        </div>

                                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '3px', margin: '2px 0' }}>
                                            {Array.isArray(node.parameters?.activeTools) ? (
                                                node.parameters?.activeTools?.slice(0, 2).map((t: string) => (
                                                    <span key={t} style={{ fontSize: '9px', padding: '1px 4px', borderRadius: '3px', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)', color: 'var(--sb-text-secondary)' }}>
                                                        🛠️ {t}
                                                    </span>
                                                ))
                                            ) : (
                                                <>
                                                    <span style={{ fontSize: '9px', padding: '1px 4px', borderRadius: '3px', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)', color: 'var(--sb-text-secondary)' }}>🛠️ scene3d_create</span>
                                                    <span style={{ fontSize: '9px', padding: '1px 4px', borderRadius: '3px', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)', color: 'var(--sb-text-secondary)' }}>🛠️ scout_locations</span>
                                                </>
                                            )}
                                        </div>

                                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '9px', color: 'var(--sb-text-tertiary)' }}>
                                            <span>Active connections: {node.parameters?.activeConnections ?? 2}</span>
                                            <span style={{ color: '#34c759' }}>RTT: ~8ms</span>
                                        </div>
                                    </div>
                                )}

                                {node.parameters?.output && graph.stageViewOf && (
                                    <SceneOutputBody
                                        flag={displayFlag}
                                        finalSummary={node.details}
                                        onShowFinal={() => setDisplayFlag(undefined)}
                                        onOpenViewport={openViewport}
                                    />
                                )}
                                {(() => {
                                    const flag = displayFlagFor(node, graphScene);
                                    const toggle = node.parameters?.toggle as { key: string; on: boolean; whenOff: string } | undefined;
                                    return flag || toggle ? (
                                        <div style={{ display: 'flex', alignItems: 'center' }}>
                                            {flag && <DisplayFlagToggle on={displayFlag?.nodeId === node.id} onToggle={() => setDisplayFlag(displayFlag?.nodeId === node.id ? undefined : flag)} />}
                                            {toggle && stageScene && <StepSwitch on={toggle.on} whenOff={toggle.whenOff} onToggle={() => setStepToggle(toggle.key, !toggle.on)} />}
                                        </div>
                                    ) : null;
                                })()}
                                {isToolNode(node) && (
                                    <ToolNodeCardBody
                                        node={node}
                                        entry={toolEntry(node)}
                                        running={runningToolNodes.includes(node.id)}
                                        progress={liveDetails[node.id]}
                                        onRun={() => { void handleRunToolNode(node.id); }}
                                        onStop={() => handleStopToolNode(node.id)}
                                    />
                                )}

                                {/* Note Snippet Preview */}
                                {node.notes && !['image', 'image-card', 'video', 'video-card', 'audio', 'audio-card', 'scene-3d', '3d-card'].includes(category) && (
                                    <div className="sb-node-notes-preview">
                                        <span className="sb-notes-icon">📝</span>
                                        <span className="sb-notes-text">{node.notes}</span>
                                    </div>
                                )}

                                {/* Bottom Node Actions Bar */}
                                {!['image', 'image-card', 'video', 'video-card', 'audio', 'audio-card', 'scene-3d', '3d-card'].includes(category) && (
                                    <div className="sb-graph-node-actions">
                                        <button
                                            type="button"
                                            className="sb-btn sb-node-action-btn"
                                            onClick={e => {
                                                e.stopPropagation();
                                                handleDoubleClickNode(node, e);
                                            }}
                                            title="Edit JSON & parameters (Double-click card)"
                                        >
                                            <IconEdit size={11} />
                                            <span>Edit JSON</span>
                                        </button>

                                        <button
                                            type="button"
                                            className="sb-btn sb-node-action-btn sb-node-action-branch"
                                            onClick={e => {
                                                e.stopPropagation();
                                                handleAddConnectedNode(node.id);
                                            }}
                                            title="Branch new connected node"
                                        >
                                            <span>+ Branch</span>
                                        </button>

                                        <button
                                            type="button"
                                            className="sb-btn sb-node-action-btn sb-node-action-delete"
                                            onClick={e => {
                                                e.stopPropagation();
                                                handleDeleteNode(node.id);
                                            }}
                                            title="Delete node (Delete / Backspace when selected)"
                                            aria-label={`Delete node ${node.label}`}
                                        >
                                            <IconTrash size={11} />
                                        </button>
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>

                {/* Floating Glassmorphic Canvas Controls Dock (Bottom-Left) */}
                <div className="sb-graph-floating-dock" onMouseDown={e => e.stopPropagation()}>
                    <button
                        type="button"
                        className="sb-graph-dock-btn sb-dock-btn-add"
                        onClick={() => setShowAddMenu(!showAddMenu)}
                        title="Add node preset"
                    >
                        <span>+ Node</span>
                    </button>

                    <div className="sb-graph-dock-divider" />

                    <button
                        type="button"
                        className="sb-graph-dock-btn"
                        onClick={() => stepHistory('undo')}
                        disabled={graphHistories.get(graphKey).past.length === 0}
                        title="Undo (⌘Z)"
                        aria-label="Undo"
                    >
                        ↶
                    </button>
                    <button
                        type="button"
                        className="sb-graph-dock-btn"
                        onClick={() => stepHistory('redo')}
                        disabled={graphHistories.get(graphKey).future.length === 0}
                        title="Redo (⇧⌘Z)"
                        aria-label="Redo"
                    >
                        ↷
                    </button>

                    <div className="sb-graph-dock-divider" />

                    <button
                        type="button"
                        className="sb-graph-dock-btn"
                        onClick={() => setZoomLevel(prev => Math.max(0.3, prev - 0.1))}
                        title="Zoom out"
                    >
                        −
                    </button>

                    <span className="sb-graph-dock-zoom">{Math.round(zoomLevel * 100)}%</span>

                    <button
                        type="button"
                        className="sb-graph-dock-btn"
                        onClick={() => setZoomLevel(prev => Math.min(1.6, prev + 0.1))}
                        title="Zoom in"
                    >
                        +
                    </button>

                    <div className="sb-graph-dock-divider" />

                    <button
                        type="button"
                        className="sb-graph-dock-btn sb-dock-btn-highlight"
                        onClick={() => autoFit(graph.nodes)}
                        title="Auto-center and fit all nodes"
                    >
                        ⤢ Fit View
                    </button>
                </div>

                {/* Quick Add Node Floating Menu (6 Core Node Types) */}
                {showAddMenu && is3DGraph && (
                    <div className="sb-graph-add-floating-menu" onMouseDown={e => e.stopPropagation()}>
                        <span className="sb-add-menu-header">Add a tool node</span>
                        <div className="sb-add-menu-grid">
                            {toolSections.map(sec => (
                                <button key={sec.title} type="button" className="sb-btn sb-add-menu-item" onClick={() => { setLibraryGroup(sec.title); setLibrarySearchQuery(''); setShowLibraryPanel(true); setShowAddMenu(false); }}
                                    title={`${sec.items.length} tools`}>
                                    <IconBoxes size={14} />
                                    <span>{sec.title}</span>
                                </button>
                            ))}
                        </div>
                    </div>
                )}
                {showAddMenu && !is3DGraph && (
                    <div className="sb-graph-add-floating-menu" onMouseDown={e => e.stopPropagation()}>
                        <span className="sb-add-menu-header">Add Workflow Node</span>
                        <div className="sb-add-menu-grid">
                            <button className="sb-btn sb-add-menu-item sb-menu-input" onClick={() => handleAddCustomNode('input')}>
                                <IconZap size={14} />
                                <span>Input Trigger</span>
                            </button>
                            <button className="sb-btn sb-add-menu-item sb-menu-ai" onClick={() => handleAddCustomNode('ai')}>
                                <IconSparkles size={14} />
                                <span>AI Processor</span>
                            </button>
                            <button className="sb-btn sb-add-menu-item sb-menu-decision" onClick={() => handleAddCustomNode('decision')}>
                                <IconFork size={14} />
                                <span>Decision Gate</span>
                            </button>
                            <button className="sb-btn sb-add-menu-item sb-menu-mcp" onClick={() => handleAddCustomNode('mcp')}>
                                <IconMcp size={14} />
                                <span>MCP Endpoint</span>
                            </button>
                            <button className="sb-btn sb-add-menu-item sb-menu-cli" onClick={() => handleAddCustomNode('cli')}>
                                <IconTerminal size={14} />
                                <span>CLI Script</span>
                            </button>
                            <button className="sb-btn sb-add-menu-item sb-menu-database" onClick={() => handleAddCustomNode('database')}>
                                <IconDatabase size={14} />
                                <span>Database Action</span>
                            </button>
                            <button className="sb-btn sb-add-menu-item sb-menu-scene-3d" onClick={() => handleAddCustomNode('scene-3d')}>
                                <Icon3D size={14} />
                                <span>3D Scene Node</span>
                            </button>
                            <button className="sb-btn sb-add-menu-item sb-menu-camera-3d" onClick={() => handleAddCustomNode('camera-3d')}>
                                <IconCamera3D size={14} />
                                <span>3D Camera Sequencer</span>
                            </button>
                            <button className="sb-btn sb-add-menu-item sb-menu-map-3d" onClick={() => handleAddCustomNode('map-3d')}>
                                <IconMap3D size={14} />
                                <span>Geo Spatial 3D Map</span>
                            </button>
                            <button className="sb-btn sb-add-menu-item sb-menu-studio-mcp" onClick={() => handleAddCustomNode('studio-mcp')}>
                                <IconStudioMcp size={14} />
                                <span>Studio MCP Node</span>
                            </button>
                            <button className="sb-btn sb-add-menu-item sb-menu-image" style={{ color: 'var(--sb-system-purple)' }} onClick={() => handleAddCustomNode('image-card')}>
                                <IconImage size={14} />
                                <span>Image Card</span>
                            </button>
                            <button className="sb-btn sb-add-menu-item sb-menu-video" style={{ color: 'var(--sb-system-rose)' }} onClick={() => handleAddCustomNode('video-card')}>
                                <IconVideo size={14} />
                                <span>Video Card</span>
                            </button>
                            <button className="sb-btn sb-add-menu-item sb-menu-audio" style={{ color: 'var(--sb-system-indigo)' }} onClick={() => handleAddCustomNode('audio-card')}>
                                <IconMic size={14} />
                                <span>Audio Card</span>
                            </button>
                        </div>
                    </div>
                )}

                {/* Floating Single Node Quick Inspector (Bottom-Right) */}
                {selectedNode && !editingNodeModalId && (
                    <div className="sb-graph-node-floating-inspector" onMouseDown={e => e.stopPropagation()}>
                        <div className="sb-inspector-top">
                            <div className="sb-inspector-tag-group">
                                <span className="sb-inspector-tag">Inspector</span>
                                <span className="sb-inspector-cat-pill">{selectedNode.category || 'node'}</span>
                            </div>
                            <button
                                type="button"
                                className="sb-btn sb-btn-ghost sb-icon-button sb-inspector-close"
                                onClick={() => setSelectedNodeId(undefined)}
                            >
                                <IconClose size={12} />
                            </button>
                        </div>

                        {/* Editable Title & Subtitle */}
                        <div className="sb-inspector-form-group">
                            <label className="sb-inspector-label">Label</label>
                            <input
                                type="text"
                                className="sb-inspector-input"
                                value={selectedNode.label}
                                onChange={e => handleEditNode(selectedNode.id, { label: e.target.value })}
                            />
                        </div>

                        <div className="sb-inspector-form-group">
                            <label className="sb-inspector-label">Subtitle</label>
                            <input
                                type="text"
                                className="sb-inspector-input"
                                value={selectedNode.subtitle || ''}
                                placeholder="Module description..."
                                onChange={e => handleEditNode(selectedNode.id, { subtitle: e.target.value })}
                            />
                        </div>

                        {/* Category Selector (a tool node's kind is its tool: its inputs are edited in the full editor; a scene
                            node's parameters are its scene's, edited here and written back) */}
                        {sceneNodeFields(selectedNode, graphScene) ? (
                            <div className="sb-inspector-form-group">
                                <ParamPanel fields={sceneNodeFields(selectedNode, graphScene)!} workspacePath={workspacePath} onChange={(k, v) => setSceneParam(selectedNode, k, v)} />
                            </div>
                        ) : isToolNode(selectedNode) ? (
                            <div className="sb-inspector-form-group">
                                <label className="sb-inspector-label">Tool</label>
                                <button type="button" className="sb-btn-inspector-action" onClick={e => handleDoubleClickNode(selectedNode, e)} title="Edit this tool's inputs">
                                    <IconCode size={13} strokeWidth={1.8} />
                                    <span>Edit {selectedNode.parameters?.toolName} inputs</span>
                                </button>
                            </div>
                        ) : (
                        <div className="sb-inspector-form-group">
                            <label className="sb-inspector-label">Category</label>
                            <select
                                className="sb-inspector-select"
                                value={selectedNode.category || 'process'}
                                onChange={e => handleEditNode(selectedNode.id, { category: e.target.value as any })}
                            >
                                <option value="input">Input Trigger</option>
                                <option value="ai">AI Agent Processor</option>
                                <option value="decision">Decision Gate</option>
                                <option value="mcp">MCP Endpoint</option>
                                <option value="cli">CLI Script</option>
                                <option value="database">Database Action</option>
                                <option value="process">Logic Process</option>
                                <option value="output">Visual Output</option>
                                <option value="image-card">Image Card</option>
                                <option value="video-card">Video Card</option>
                                <option value="audio-card">Audio Card</option>
                                <option value="scene-3d">3D Scene Card</option>
                            </select>
                        </div>
                        )}

                        {/* Color Swatch Picker */}
                        <div className="sb-inspector-form-group">
                            <label className="sb-inspector-label">Accent Color</label>
                            <div className="sb-inspector-swatches">
                                {ACCENT_COLORS.map(c => (
                                    <button
                                        key={c.color}
                                        type="button"
                                        className={`sb-btn sb-inspector-swatch ${(selectedNode.color || 'blue') === c.color ? 'sb-swatch-selected' : ''}`}
                                        style={{ backgroundColor: c.hex }}
                                        onClick={() => handleEditNode(selectedNode.id, { color: c.color })}
                                        title={c.label}
                                    />
                                ))}
                            </div>
                        </div>

                        {/* Markdown / Text Notes */}
                        <div className="sb-inspector-form-group">
                            <label className="sb-inspector-label">Notes & Parameters</label>
                            <textarea
                                className="sb-inspector-notes"
                                rows={2}
                                placeholder="Add notes, specifications, or memo..."
                                value={selectedNode.notes || ''}
                                onChange={e => handleEditNode(selectedNode.id, { notes: e.target.value })}
                            />
                        </div>

                        {/* Actions */}
                        <div className="sb-inspector-actions">
                            <button
                                type="button"
                                className="sb-btn-inspector-action"
                                onClick={e => handleDoubleClickNode(selectedNode, e)}
                                title="Open full JSON & Parameter Editor Modal"
                            >
                                <IconCode size={13} strokeWidth={1.8} />
                                <span>Edit JSON</span>
                            </button>
                            {/* a 3D graph has no simulated runs: only a tool node runs, for real */}
                            {(!is3DGraph || isToolNode(selectedNode)) && (
                            <button
                                type="button"
                                className="sb-btn-inspector-action"
                                onClick={() => handleDryRunNode(selectedNode.id)}
                                title={isToolNode(selectedNode) ? 'Run this tool for real' : 'Dry run this node'}
                            >
                                <IconPlay size={12} strokeWidth={1.8} />
                                <span>{isToolNode(selectedNode) ? 'Run tool' : 'Dry Run'}</span>
                            </button>
                            )}
                            <button
                                type="button"
                                className="sb-btn-inspector-action"
                                onClick={() => handlePromptForNode(selectedNode, 'Explain this architecture step')}
                            >
                                <IconInfo size={13} strokeWidth={1.8} />
                                <span>Explain</span>
                            </button>
                            <button
                                type="button"
                                className="sb-btn-inspector-action sb-btn-inspector-delete"
                                onClick={() => handleDeleteNode(selectedNode.id)}
                                title="Delete node"
                            >
                                <IconTrash size={13} />
                            </button>
                        </div>
                    </div>
                )}

                {/* =========================================================
                    Double-Click Node Parameters & Raw JSON Editor Modal Dialog
                   ========================================================= */}
                {editingNode && (
                    <div
                        className="sb-graph-modal-backdrop"
                        onClick={() => setEditingNodeModalId(undefined)}
                        onMouseDown={e => e.stopPropagation()}
                    >
                        <div
                            className="sb-graph-modal-dialog"
                            onClick={e => e.stopPropagation()}
                            onMouseDown={e => e.stopPropagation()}
                        >
                            {/* Modal Header */}
                            <div className="sb-modal-header">
                                <div className="sb-modal-title-group">
                                    <div className="sb-modal-icon-badge">
                                        {getNodeCategoryIcon(editingNode.category)}
                                    </div>
                                    <div>
                                        <h4 className="sb-modal-title">{editingNode.label}</h4>
                                        <p className="sb-modal-subtitle">
                                            {editingNode.category?.toUpperCase()} Node Configuration & Parameters
                                        </p>
                                    </div>
                                </div>
                                <div className="sb-modal-header-actions">
                                    {(!is3DGraph || isToolNode(editingNode)) && (
                                    <button
                                        type="button"
                                        className="sb-btn sb-btn-secondary sb-btn-sm"
                                        onClick={() => handleDryRunNode(editingNode.id)}
                                    >
                                        <IconPlay size={12} />
                                        <span>{isToolNode(editingNode) ? 'Run tool' : 'Test Run'}</span>
                                    </button>
                                    )}
                                    <button
                                        type="button"
                                        className="sb-btn sb-btn-ghost sb-icon-button sb-modal-close-btn"
                                        onClick={() => setEditingNodeModalId(undefined)}
                                    >
                                        <IconClose size={14} />
                                    </button>
                                </div>
                            </div>

                            {/* Modal Tabs Header */}
                            <div className="sb-modal-tabs">
                                <button
                                    type="button"
                                    className={`sb-btn sb-segment-btn sb-modal-tab-btn ${modalTab === 'params' ? 'sb-tab-active' : ''}`}
                                    onClick={() => setModalTab('params')}
                                >
                                    <span>Visual Parameters</span>
                                </button>
                                <button
                                    type="button"
                                    className={`sb-btn sb-segment-btn sb-modal-tab-btn ${modalTab === 'json' ? 'sb-tab-active' : ''}`}
                                    onClick={() => setModalTab('json')}
                                >
                                    <span>Raw JSON Config</span>
                                </button>
                            </div>

                            {/* Modal Content */}
                            <div className="sb-modal-body">
                                {modalTab === 'params' ? (
                                    <div className="sb-modal-params-form">
                                        <div className="sb-form-row">
                                            <div className="sb-form-col">
                                                <label className="sb-input-label">Node Label</label>
                                                <input
                                                    type="text"
                                                    className="sb-text-input"
                                                    value={editingNode.label}
                                                    onChange={e => handleEditNode(editingNode.id, { label: e.target.value })}
                                                />
                                            </div>
                                            <div className="sb-form-col">
                                                <label className="sb-input-label">Subtitle</label>
                                                <input
                                                    type="text"
                                                    className="sb-text-input"
                                                    value={editingNode.subtitle || ''}
                                                    onChange={e => handleEditNode(editingNode.id, { subtitle: e.target.value })}
                                                />
                                            </div>
                                        </div>

                                        {/* Dynamic category-specific parameters */}
                                        {editingNode.category === 'input' && (
                                            <div className="sb-category-params-block">
                                                <span className="sb-params-section-title">Trigger Configuration</span>
                                                <div className="sb-form-row">
                                                    <div className="sb-form-col">
                                                        <label className="sb-input-label">Trigger Type</label>
                                                        <select
                                                            className="sb-select-input"
                                                            value={editingNode.parameters?.triggerType || 'webhook'}
                                                            onChange={e =>
                                                                handleEditNode(editingNode.id, {
                                                                    parameters: { ...editingNode.parameters, triggerType: e.target.value }
                                                                })
                                                            }
                                                        >
                                                            <option value="webhook">Webhook (HTTP POST/GET)</option>
                                                            <option value="cron">Cron Schedule</option>
                                                            <option value="event">IDE File Event</option>
                                                            <option value="chat">Chat Prompt Trigger</option>
                                                        </select>
                                                    </div>
                                                    <div className="sb-form-col">
                                                        <label className="sb-input-label">Endpoint / Schedule</label>
                                                        <input
                                                            type="text"
                                                            className="sb-text-input"
                                                            value={editingNode.parameters?.endpoint || '/api/v1/webhook'}
                                                            onChange={e =>
                                                                handleEditNode(editingNode.id, {
                                                                    parameters: { ...editingNode.parameters, endpoint: e.target.value }
                                                                })
                                                            }
                                                        />
                                                    </div>
                                                </div>
                                            </div>
                                        )}

                                        {editingNode.category === 'ai' && (
                                            <div className="sb-category-params-block">
                                                <span className="sb-params-section-title">AI Model & Reasoning Configuration</span>
                                                <div className="sb-form-row">
                                                    <div className="sb-form-col">
                                                        <label className="sb-input-label">AI Model</label>
                                                        <select
                                                            className="sb-select-input"
                                                            value={editingNode.parameters?.model || 'gemini-3.8-flash'}
                                                            onChange={e =>
                                                                handleEditNode(editingNode.id, {
                                                                    parameters: { ...editingNode.parameters, model: e.target.value }
                                                                })
                                                            }
                                                        >
                                                            <option value="gemini-3.8-flash">High Reasoning Engine</option>
                                                            <option value="gemini-3.5-flash-lite">Fast Subagent Intelligence</option>
                                                            <option value="gemini-3.1-flash-lite">Instant Local Fallback</option>
                                                        </select>
                                                    </div>
                                                    <div className="sb-form-col">
                                                        <label className="sb-input-label">Temperature: {editingNode.parameters?.temperature ?? 0.2}</label>
                                                        <input
                                                            type="range"
                                                            min="0"
                                                            max="1"
                                                            step="0.05"
                                                            className="sb-range-input"
                                                            value={editingNode.parameters?.temperature ?? 0.2}
                                                            onChange={e =>
                                                                handleEditNode(editingNode.id, {
                                                                    parameters: { ...editingNode.parameters, temperature: parseFloat(e.target.value) }
                                                                })
                                                            }
                                                        />
                                                    </div>
                                                </div>
                                                <div className="sb-form-row">
                                                    <div className="sb-form-col sb-col-full">
                                                        <label className="sb-input-label">System Instruction / Prompt Template</label>
                                                        <textarea
                                                            className="sb-textarea-input"
                                                            rows={3}
                                                            value={editingNode.parameters?.systemPrompt || 'You are an autonomous workflow reasoner.'}
                                                            onChange={e =>
                                                                handleEditNode(editingNode.id, {
                                                                    parameters: { ...editingNode.parameters, systemPrompt: e.target.value }
                                                                })
                                                            }
                                                        />
                                                    </div>
                                                </div>
                                            </div>
                                        )}

                                        {(editingNode.category === 'image' || editingNode.category === 'image-card') && (
                                            <div className="sb-category-params-block">
                                                <span className="sb-params-section-title">Image Synthesis &amp; Editing (Google Nano Banana 2)</span>
                                                <div className="sb-form-row">
                                                    <div className="sb-form-col">
                                                        <label className="sb-input-label">Model Endpoint</label>
                                                        <select
                                                            className="sb-select-input"
                                                            value={resolveImageModelId(editingNode.parameters?.model || IMAGE_MODEL_PRIORITY[0])}
                                                            onChange={e =>
                                                                handleEditNode(editingNode.id, {
                                                                    parameters: { ...editingNode.parameters, model: e.target.value }
                                                                })
                                                            }
                                                        >
                                                            <option value="gemini-3.1-flash-image">Nano Banana 2 (Google Endpoint - Default)</option>
                                                            <option value="gemini-3-pro-image">Nano Banana Pro (Google)</option>
                                                            <option value="gemini-2.5-flash-image">Gemini 2.5 Flash Image</option>
                                                        </select>
                                                    </div>
                                                    <div className="sb-form-col">
                                                        <label className="sb-input-label">Aspect Ratio</label>
                                                        <select
                                                            className="sb-select-input"
                                                            value={editingNode.parameters?.aspectRatio || '16:9'}
                                                            onChange={e =>
                                                                handleEditNode(editingNode.id, {
                                                                    parameters: { ...editingNode.parameters, aspectRatio: e.target.value }
                                                                })
                                                            }
                                                        >
                                                            <option value="16:9">Widescreen (16:9)</option>
                                                            <option value="1:1">Square (1:1)</option>
                                                            <option value="9:16">Portrait (9:16)</option>
                                                            <option value="4:3">Standard (4:3)</option>
                                                            <option value="21:9">Cinematic (21:9)</option>
                                                        </select>
                                                    </div>
                                                </div>
                                            </div>
                                        )}

                                        {(editingNode.category === 'video' || editingNode.category === 'video-card') && (
                                            <div className="sb-category-params-block">
                                                <span className="sb-params-section-title">Video Synthesis &amp; Product Studio (Google Omni 1.1)</span>
                                                <div className="sb-form-row">
                                                    <div className="sb-form-col">
                                                        <label className="sb-input-label">Model Endpoint</label>
                                                        <select
                                                            className="sb-select-input"
                                                            value={editingNode.parameters?.model || 'google/omni-1.1'}
                                                            onChange={e =>
                                                                handleEditNode(editingNode.id, {
                                                                    parameters: { ...editingNode.parameters, model: e.target.value }
                                                                })
                                                            }
                                                        >
                                                            <option value="google/omni-1.1">Google Omni 1.1 (Default)</option>
                                                            <option value="gemini-omni-flash-video">Gemini Omni Flash Video</option>
                                                            <option value="veo-3.1-generate-preview">Google Veo 3.1</option>
                                                        </select>
                                                    </div>
                                                    <div className="sb-form-col">
                                                        <label className="sb-input-label">Duration</label>
                                                        <select
                                                            className="sb-select-input"
                                                            value={editingNode.parameters?.durationSeconds || 6}
                                                            onChange={e =>
                                                                handleEditNode(editingNode.id, {
                                                                    parameters: { ...editingNode.parameters, durationSeconds: parseInt(e.target.value) }
                                                                })
                                                            }
                                                        >
                                                            <option value="4">4 Seconds</option>
                                                            <option value="6">6 Seconds</option>
                                                            <option value="8">8 Seconds</option>
                                                        </select>
                                                    </div>
                                                </div>
                                            </div>
                                        )}

                                        {(editingNode.category === 'audio' || editingNode.category === 'audio-card') && (
                                            <div className="sb-category-params-block">
                                                <span className="sb-params-section-title">Audio & Sound Configuration</span>
                                                <div className="sb-form-row">
                                                    <div className="sb-form-col">
                                                        <label className="sb-input-label">Audio Kind</label>
                                                        <select
                                                            className="sb-select-input"
                                                            value={editingNode.parameters?.audioKind || 'speech'}
                                                            onChange={e =>
                                                                handleEditNode(editingNode.id, {
                                                                    parameters: { ...editingNode.parameters, audioKind: e.target.value }
                                                                })
                                                            }
                                                        >
                                                            <option value="speech">Voice / Narration Speech</option>
                                                            <option value="music">Ambient Music / Theme</option>
                                                            <option value="sound_effect">Sound Effect (SFX)</option>
                                                        </select>
                                                    </div>
                                                    <div className="sb-form-col">
                                                        <label className="sb-input-label">Voice Speaker Preset</label>
                                                        <select
                                                            className="sb-select-input"
                                                            value={editingNode.parameters?.voiceId || 'Chirp-1'}
                                                            onChange={e =>
                                                                handleEditNode(editingNode.id, {
                                                                    parameters: { ...editingNode.parameters, voiceId: e.target.value }
                                                                })
                                                            }
                                                            disabled={editingNode.parameters?.audioKind !== 'speech'}
                                                        >
                                                            <option value="Chirp-1">Narrator (Studio Deep Male)</option>
                                                            <option value="Chirp-2">Assistant (Warm Soft Female)</option>
                                                            <option value="Chirp-3">Dynamic (Energetic Modern Neutral)</option>
                                                        </select>
                                                    </div>
                                                </div>
                                            </div>
                                        )}

                                        {editingNode.category === 'decision' && (
                                            <div className="sb-category-params-block">
                                                <span className="sb-params-section-title">Decision Gate Logic</span>
                                                <div className="sb-form-row">
                                                    <div className="sb-form-col sb-col-full">
                                                        <label className="sb-input-label">Condition Expression</label>
                                                        <input
                                                            type="text"
                                                            className="sb-text-input"
                                                            value={editingNode.parameters?.rule || 'payload.confidence > 0.85'}
                                                            onChange={e =>
                                                                handleEditNode(editingNode.id, {
                                                                    parameters: { ...editingNode.parameters, rule: e.target.value }
                                                                })
                                                            }
                                                        />
                                                    </div>
                                                </div>
                                            </div>
                                        )}

                                        {sceneNodeFields(editingNode, graphScene) && (
                                            <div className="sb-category-params-block">
                                                <ParamPanel title="Scene parameters (written to the scene)" fields={sceneNodeFields(editingNode, graphScene)!} workspacePath={workspacePath} onChange={(k, v) => setSceneParam(editingNode, k, v)} />
                                            </div>
                                        )}

                                        {isToolNode(editingNode) && (
                                            <ToolNodeInspector
                                                workspacePath={workspacePath}
                                                node={editingNode}
                                                entry={toolEntry(editingNode)}
                                                onArgsChange={toolArgs => handleEditNode(editingNode.id, { parameters: { ...editingNode.parameters, toolArgs } })}
                                            />
                                        )}

                                        {editingNode.category === 'mcp' && (
                                            <div className="sb-category-params-block">
                                                <span className="sb-params-section-title">MCP Integration Parameters</span>
                                                <div className="sb-form-row">
                                                    <div className="sb-form-col">
                                                        <label className="sb-input-label">MCP Server</label>
                                                        <select
                                                            className="sb-select-input"
                                                            value={editingNode.parameters?.server || 'mcp-stripe'}
                                                            onChange={e =>
                                                                handleEditNode(editingNode.id, {
                                                                    parameters: { ...editingNode.parameters, server: e.target.value }
                                                                })
                                                            }
                                                        >
                                                            <option value="mcp-stripe">Stripe Payments</option>
                                                            <option value="mcp-github">GitHub Repository</option>
                                                            <option value="mcp-figma">Figma Assets</option>
                                                            <option value="mcp-websearch">Web Real-time Search</option>
                                                            <option value="mcp-cli">CLI & Terminal Bridge</option>
                                                        </select>
                                                    </div>
                                                    <div className="sb-form-col">
                                                        <label className="sb-input-label">Tool Name</label>
                                                        <input
                                                            type="text"
                                                            className="sb-text-input"
                                                            value={editingNode.parameters?.tool || 'get_balance'}
                                                            onChange={e =>
                                                                handleEditNode(editingNode.id, {
                                                                    parameters: { ...editingNode.parameters, tool: e.target.value }
                                                                })
                                                            }
                                                        />
                                                    </div>
                                                </div>
                                            </div>
                                        )}

                                        {editingNode.category === 'cli' && (
                                            <div className="sb-category-params-block">
                                                <span className="sb-params-section-title">CLI Script Execution</span>
                                                <div className="sb-form-row">
                                                    <div className="sb-form-col sb-col-full">
                                                        <label className="sb-input-label">Command</label>
                                                        <input
                                                            type="text"
                                                            className="sb-text-input"
                                                            value={editingNode.parameters?.command || 'yarn test'}
                                                            onChange={e =>
                                                                handleEditNode(editingNode.id, {
                                                                    parameters: { ...editingNode.parameters, command: e.target.value }
                                                                })
                                                            }
                                                        />
                                                    </div>
                                                </div>
                                            </div>
                                        )}

                                        {editingNode.category === 'database' && (
                                            <div className="sb-category-params-block">
                                                <span className="sb-params-section-title">Database Action</span>
                                                <div className="sb-form-row">
                                                    <div className="sb-form-col">
                                                        <label className="sb-input-label">Engine</label>
                                                        <select
                                                            className="sb-select-input"
                                                            value={editingNode.parameters?.database || 'postgresql'}
                                                            onChange={e =>
                                                                handleEditNode(editingNode.id, {
                                                                    parameters: { ...editingNode.parameters, database: e.target.value }
                                                                })
                                                            }
                                                        >
                                                            <option value="postgresql">PostgreSQL</option>
                                                            <option value="firestore">Cloud Firestore</option>
                                                            <option value="vector">Vector Embedding DB</option>
                                                            <option value="redis">Redis Cache</option>
                                                        </select>
                                                    </div>
                                                    <div className="sb-form-col">
                                                        <label className="sb-input-label">Table / Collection</label>
                                                        <input
                                                            type="text"
                                                            className="sb-text-input"
                                                            value={editingNode.parameters?.table || 'events'}
                                                            onChange={e =>
                                                                handleEditNode(editingNode.id, {
                                                                    parameters: { ...editingNode.parameters, table: e.target.value }
                                                                })
                                                            }
                                                        />
                                                    </div>
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                ) : (
                                    <div className="sb-modal-json-editor">
                                        <div className="sb-json-editor-top">
                                            <span className="sb-json-label">Live JSON Schema Payload</span>
                                            <button
                                                type="button"
                                                className="sb-btn sb-btn-secondary sb-btn-xs"
                                                onClick={() => {
                                                    try {
                                                        const parsed = JSON.parse(rawJsonBuffer);
                                                        setRawJsonBuffer(JSON.stringify(parsed, null, 2));
                                                        setJsonError(undefined);
                                                    } catch (err: any) {
                                                        setJsonError(err.message);
                                                    }
                                                }}
                                            >
                                                <span>Format JSON</span>
                                            </button>
                                        </div>

                                        <textarea
                                            className="sb-modal-json-textarea"
                                            rows={14}
                                            value={rawJsonBuffer}
                                            onChange={e => {
                                                setRawJsonBuffer(e.target.value);
                                                try {
                                                    JSON.parse(e.target.value);
                                                    setJsonError(undefined);
                                                } catch (err: any) {
                                                    setJsonError(err.message);
                                                }
                                            }}
                                        />

                                        {jsonError && (
                                            <div className="sb-json-error-banner">
                                                <span>⚠️ {jsonError}</span>
                                            </div>
                                        )}
                                    </div>
                                )}
                            </div>

                            {/* Modal Footer */}
                            <div className="sb-modal-footer">
                                <button
                                    type="button"
                                    className="sb-btn sb-btn-danger sb-btn-sm"
                                    onClick={() => handleDeleteNode(editingNode.id)}
                                >
                                    <IconTrash size={12} />
                                    <span>Delete Node</span>
                                </button>

                                <div className="sb-modal-footer-right">
                                    <button
                                        type="button"
                                        className="sb-btn sb-btn-secondary sb-btn-sm"
                                        onClick={() => setEditingNodeModalId(undefined)}
                                    >
                                        <span>Cancel</span>
                                    </button>
                                    <button
                                        type="button"
                                        className="sb-btn sb-btn-primary sb-btn-sm"
                                        onClick={() => {
                                            if (modalTab === 'json') {
                                                handleSaveJsonBuffer(editingNode.id);
                                            } else {
                                                setEditingNodeModalId(undefined);
                                            }
                                        }}
                                    >
                                        <span>Save & Apply</span>
                                    </button>
                                </div>
                            </div>
                        </div>
                    </div>
                )}
            </div>

            {/* Right-Side Collapsible Node Library Panel */}
            {showLibraryPanel && (
                <div className="sb-canvas-library-panel" onMouseDown={e => e.stopPropagation()}>
                    <div className="sb-library-search-container">
                        <div className="sb-library-search-wrapper">
                            <input
                                type="text"
                                className="sb-library-search-input"
                                placeholder="Search tools, nodes..."
                                value={librarySearchQuery}
                                onChange={e => setLibrarySearchQuery(e.target.value)}
                            />
                            {librarySearchQuery && (
                                <button
                                    type="button"
                                    className="sb-library-search-clear sb-btn"
                                    onClick={() => setLibrarySearchQuery('')}
                                    title="Clear search"
                                >
                                    <IconClose size={12} />
                                </button>
                            )}
                        </div>
                    </div>

                    <div className="sb-library-sections-container">
                        {toolCatalogError && (
                            <div className="sb-library-section">
                                <h4 className="sb-library-section-title">Tools unavailable: {toolCatalogError}</h4>
                            </div>
                        )}
                        {is3DGraph && libraryGroup && (
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', padding: '4px 4px 0' }}>
                                <span style={{ fontSize: '11px', color: 'var(--sb-text-secondary)' }}>Showing {libraryGroup}</span>
                                <button type="button" className="sb-btn" style={{ fontSize: '10px', padding: '1px 8px' }} onClick={() => setLibraryGroup(undefined)}>All tools</button>
                            </div>
                        )}
                        {(is3DGraph
                            // the picked task group first; the core elements (notes, frames) after the tools
                            ? [...toolSections.filter(sec => !libraryGroup || sec.title === libraryGroup), ...LIBRARY_SECTIONS.filter(sec => sec.title === 'Core Elements')]
                            : [...LIBRARY_SECTIONS, ...toolSections]).map(section => {
                            const filteredItems = section.items.filter(item =>
                                item.label.toLowerCase().includes(librarySearchQuery.toLowerCase()) ||
                                item.subtitle.toLowerCase().includes(librarySearchQuery.toLowerCase()) ||
                                item.description.toLowerCase().includes(librarySearchQuery.toLowerCase())
                            );

                            if (filteredItems.length === 0) {
                                return undefined;
                            }

                            return (
                                <div key={section.title} className="sb-library-section">
                                    <h4 className="sb-library-section-title">{section.title}</h4>
                                    <div className="sb-library-section-cards">
                                        {filteredItems.map(item => (
                                            <div
                                                key={item.id}
                                                className="sb-library-card cursor-grab active:cursor-grabbing"
                                                draggable={true}
                                                onDragStart={e => handleDragStartLibrary(e, item)}
                                                onClick={() => handleAddLibraryNode(item)}
                                                title={`${item.label}: ${item.description}`}
                                            >
                                                <div className={`sb-library-card-icon-wrapper ${item.color}`}>
                                                    {item.icon}
                                                </div>
                                                <div className="sb-library-card-content">
                                                    <span className="sb-library-card-title">{item.label}</span>
                                                    <span className="sb-library-card-description">{item.description}</span>
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                </div>
            )}
        </div>
    </div>
);
};
