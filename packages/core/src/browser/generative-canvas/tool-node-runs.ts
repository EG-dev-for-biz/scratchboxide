/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The rules that keep canvas tool node runs in step with the scene, the chat and the stage:
 * - a run belongs to the app, not to the graph on screen: it goes on when its graph leaves the stage (another canvas
 *   tab) and is found again when the graph comes back (ToolNodeRunRegistry);
 * - no two runs build into one scene at once, from any graph;
 * - an artifact a run streams, and a result that lands while its graph is off stage, update the session by id and
 *   never take the stage (upsertArtifact, artifactOnStage, patchGraphNode);
 * - a graph keeps its other fields (sourceArtifact, stageViewOf) through every edit (sanitizeNodeGraph).
 */

import type { CanvasArtifact, GraphNode, NodeGraphData } from './canvas-types';

export interface ToolNodeRun {
    controller: AbortController;
    /** The scene the run builds into, when it builds into one. */
    targetId?: string;
}

export class ToolNodeRunRegistry {
    private readonly runs = new Map<string, ToolNodeRun>();

    private static key(graphKey: string, nodeId: string): string {
        return `${graphKey}::${nodeId}`;
    }

    /** Starts a run, or says why it cannot: the node is already running, or its scene is being built by another run. */
    start(graphKey: string, nodeId: string, targetId?: string): { run: ToolNodeRun } | { refused: string } {
        const key = ToolNodeRunRegistry.key(graphKey, nodeId);
        if (this.runs.has(key)) return { refused: 'This node is already running' };
        if (targetId && [...this.runs.values()].some(r => r.targetId === targetId)) {
            return { refused: 'This scene is already being built by another node; wait for it or stop it first' };
        }
        const run: ToolNodeRun = { controller: new AbortController(), targetId };
        this.runs.set(key, run);
        return { run };
    }

    finish(graphKey: string, nodeId: string): void {
        this.runs.delete(ToolNodeRunRegistry.key(graphKey, nodeId));
    }

    get(graphKey: string, nodeId: string): ToolNodeRun | undefined {
        return this.runs.get(ToolNodeRunRegistry.key(graphKey, nodeId));
    }

    /** The nodes of one graph that are running now: what a graph coming back on stage shows as running. */
    runningNodes(graphKey: string): string[] {
        const prefix = `${graphKey}::`;
        return [...this.runs.keys()].filter(k => k.startsWith(prefix)).map(k => k.slice(prefix.length));
    }

    stopGraph(graphKey: string): void {
        for (const nodeId of this.runningNodes(graphKey)) this.get(graphKey, nodeId)?.controller.abort();
    }
}

/** The app's one registry: shared by every graph, outliving any of them. */
export const toolNodeRuns = new ToolNodeRunRegistry();

/** The artifact replaced in place (a canvas tab keeps its position), or added in front when new. */
export function upsertArtifact(list: CanvasArtifact[] | undefined, art: CanvasArtifact): CanvasArtifact[] {
    const l = list || [];
    return l.some(a => a.id === art.id) ? l.map(a => a.id === art.id ? art : a) : [art, ...l];
}

/** What the stage shows after an artifact streams in: the new version if it is the one on stage, else what was there. */
export function artifactOnStage(onStage: CanvasArtifact | undefined, art: CanvasArtifact): CanvasArtifact | undefined {
    return onStage?.id === art.id ? art : onStage;
}

/** A graph artifact with one node updated: how a run's result reaches a graph that is off stage. */
export function patchGraphNode(art: CanvasArtifact, nodeId: string, updates: Partial<GraphNode>): CanvasArtifact {
    const data = art.data as NodeGraphData;
    return { ...art, data: { ...data, nodes: data.nodes.map(n => n.id === nodeId ? { ...n, ...updates } : n) } };
}

/** A graph as the canvas holds it: lists always present, every other field (sourceArtifact, stageViewOf, viewport) kept. */
export function sanitizeNodeGraph(raw: NodeGraphData): NodeGraphData {
    return {
        ...(raw || {}),
        title: raw?.title || (raw as any)?.graphTitle || 'Interactive Node Graph',
        subtitle: raw?.subtitle || (raw as any)?.graphSubtitle,
        nodes: Array.isArray(raw?.nodes) ? raw.nodes : [],
        edges: Array.isArray(raw?.edges) ? raw.edges : []
    };
}
