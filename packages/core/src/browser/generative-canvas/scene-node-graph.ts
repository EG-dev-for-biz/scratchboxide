/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Every new 3D scene gets a node graph of its own, as a canvas tab beside it: a staged build's stage view (the build
 * node and its stages), any other scene's scene graph (camera, environment, meshes, renderer). The graph follows its
 * scene: it is redrawn when the scene changes, keeping where the user dragged its nodes. Each scene gets one once:
 * closing its graph does not bring it back, and scenes already in a session when it loads get none. A scene the chat
 * is still streaming under a temporary id gets its graph once the app has given it its project id.
 */

import type { CanvasArtifact, GraphNode, NodeGraphData, Scene3DData } from './canvas-types';
import { morphScene3DToNodeGraph } from './primitive-transformer-engine';
import { refreshStageGraph } from '../../common/staged-build-graph';
import { SCENE_GRAPH_VERSION, sceneGraphKey } from './scene-graph-key';
import { isTimestampArtifactId } from '../../common/project-artifact-graph-protocol';

export { SCENE_GRAPH_VERSION, sceneGraphKey };

/** The scene's graph data as the scene now stands, linked back to it. */
export function sceneNodeGraphData(scene: CanvasArtifact): NodeGraphData {
    const d = scene.data as Scene3DData;
    const graph = morphScene3DToNodeGraph(d);
    return {
        ...graph,
        title: d?.stagedBuild ? graph.title : `${scene.title} — node graph`,
        stageViewOf: { artifactId: scene.id, updatedAtMs: d?.stagedBuild?.updatedAtMs ?? 0, key: sceneGraphKey(scene) }
    };
}

export function companionNodeGraph(scene: CanvasArtifact): CanvasArtifact {
    const data = sceneNodeGraphData(scene);
    return {
        id: `art-graph-${scene.id}`,
        type: 'node-graph',
        title: data.title,
        summary: data.subtitle || `Node graph of ${scene.title}`,
        version: 1,
        createdAt: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        data
    };
}

/**
 * The graphs to add for the scenes in a session's history. `done` is the session's record of scenes already handled;
 * undefined means the session has none yet (it predates this rule, or is just loaded): every scene in it counts as
 * handled and none gets a graph, so only scenes made from now on do.
 */
export function planCompanionGraphs(history: CanvasArtifact[], done: string[] | undefined): { graphs: CanvasArtifact[]; done: string[] } {
    // a scene still under the chat's temporary (timestamp) id waits: the app gives it its project id when the turn
    // ends, and the graph links to that one (a link to the temporary id would break, and an early id would split it)
    const scenes = history.filter(a => a.type === '3d-scene' && !isTimestampArtifactId(a.id));
    if (!done) return { graphs: [], done: scenes.map(s => s.id) };
    const handled = new Set(done);
    const fresh = scenes.filter(s => !handled.has(s.id));
    // a scene that already has a graph following it (opened by hand) is handled, without a second graph
    const followed = new Set(history.filter(a => a.type === 'node-graph').map(g => (g.data as NodeGraphData)?.stageViewOf?.artifactId).filter(Boolean));
    return {
        graphs: fresh.filter(s => !followed.has(s.id)).map(companionNodeGraph),
        done: [...done, ...fresh.map(s => s.id)]
    };
}

/**
 * The graph redrawn for its scene's new state, or undefined when the scene has not changed since it was drawn.
 * Node positions the user set are kept; a staged view keeps its build node's own run too (refreshStageGraph).
 */
export function refreshSceneNodeGraph(current: NodeGraphData, scene: CanvasArtifact): NodeGraphData | undefined {
    const link = current.stageViewOf;
    if (!link || link.artifactId !== scene.id) return undefined;
    const d = scene.data as Scene3DData;
    if (d?.stagedBuild) {
        // a staged view redraws only from a newer run record, or once when it was drawn by an older graph version
        // or when its step switches changed
        const outdated = !link.key?.startsWith(`${SCENE_GRAPH_VERSION}:`);
        const toggles = JSON.stringify(d.stagedStepToggles ?? {});
        if (d.stagedBuild.updatedAtMs <= link.updatedAtMs && !outdated && toggles === (link.toggles ?? '{}')) return undefined;
        const next = refreshStageGraph(current.nodes, d.stagedBuild, d.stagedStepToggles);
        return { ...current, title: next.title, subtitle: next.subtitle, nodes: next.nodes as GraphNode[], edges: next.edges, stageViewOf: { ...next.stageViewOf, key: sceneGraphKey(scene), toggles } };
    }
    const key = sceneGraphKey(scene);
    if (link.key === key) return undefined;
    const next = sceneNodeGraphData(scene);
    // the compiled model's parts are read from its binary, which a saved copy of the scene may not carry: parts the
    // graph has stay when this copy cannot read them
    const isPart = (id: string) => id.startsWith('glb-node-');
    if (!next.nodes.some(n => isPart(n.id)) && current.nodes.some(n => isPart(n.id))) {
        const out = next.nodes.findIndex(n => n.parameters?.output);
        const parts = current.nodes.filter(n => isPart(n.id));
        next.nodes = out >= 0 ? [...next.nodes.slice(0, out), ...parts, ...next.nodes.slice(out)] : [...next.nodes, ...parts];
        next.edges = [...next.edges, ...current.edges.filter(e => isPart(e.source) || isPart(e.target))];
    }
    // the redraw is a merge, not a reset: nodes the user added (tool nodes) and the user's wiring stay, scene nodes
    // the scene no longer has go, and only nodes new to the scene are wired as drawn
    const old = new Map(current.nodes.map(n => [n.id, n]));
    const drawn = new Set(next.nodes.map(n => n.id));
    const userNodes = current.nodes.filter(n => !drawn.has(n.id) && !isSceneDrawnNode(n));
    const nodes = [...next.nodes.map(n => old.has(n.id) ? { ...n, x: old.get(n.id)!.x, y: old.get(n.id)!.y } : n), ...userNodes];
    const kept = new Set(nodes.map(n => n.id));
    const fresh = new Set(next.nodes.filter(n => !old.has(n.id)).map(n => n.id));
    const edges = [
        ...current.edges.filter(e => kept.has(e.source) && kept.has(e.target)),
        ...next.edges.filter(e => (fresh.has(e.source) || fresh.has(e.target)) && !current.edges.some(c => c.source === e.source && c.target === e.target))
    ];
    return { ...current, subtitle: next.subtitle, nodes, edges, sourceArtifact: next.sourceArtifact, stageViewOf: next.stageViewOf };
}

/** Nodes a scene graph draws from the scene itself (as opposed to nodes the user placed on it). */
function isSceneDrawnNode(n: GraphNode): boolean {
    return n.id === 'n-cam' || n.id === 'n-env' || n.id === 'n-weather' || n.id === 'n-render' || !!n.parameters?.output
        || n.id.startsWith('obj-') || n.id.startsWith('mesh-') || n.id.startsWith('glb-node-');
}
