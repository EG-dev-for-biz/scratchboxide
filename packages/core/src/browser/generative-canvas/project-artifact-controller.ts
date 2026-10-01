/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import {
    ArtifactActor,
    ArtifactAnchor,
    ArtifactCapability,
    ArtifactEdgeType,
    ArtifactRef,
    ProjectArtifactGraph,
    ProjectArtifactGraphEngine,
    ProjectGraphDomainEvent,
    RelatedArtifact,
    createEmptyProjectGraph,
    migrateCanvasSessions,
    stableProjectArtifactId
} from '../../common/project-artifact-graph-protocol';
import {
    CanvasArtifact,
    ChatSession,
    InteractiveBrowserData,
    KanbanBoardData,
    LiveCodeSandboxData,
    MarkdownDocumentData,
    NodeGraphData,
    Scene3DData
} from './canvas-types';
import {
    projectGraphArtifactToCanvas,
    registerCanvasArtifact
} from './project-artifact-adapter';
import { ProjectArtifactStoreClient } from './project-artifact-store-client';

const DEFAULT_CAPABILITIES: ArtifactCapability[] = [
    'artifact.read',
    'artifact.write',
    'artifact.link',
    'artifact.select'
];

export class ProjectArtifactController {
    private engine: ProjectArtifactGraphEngine;
    private persistTimer: ReturnType<typeof setTimeout> | undefined;
    private workspaceRoot: string | undefined;

    constructor(
        readonly projectId: string,
        private readonly actor: ArtifactActor,
        private readonly client = new ProjectArtifactStoreClient(),
        graph = createEmptyProjectGraph(projectId, {
            grants: DEFAULT_CAPABILITIES.map(capability => ({ capability, effect: 'allow' as const }))
        })
    ) {
        this.engine = new ProjectArtifactGraphEngine(graph);
        this.ensureDefaultCapabilities();
    }

    get graph(): ProjectArtifactGraph {
        return this.engine.graph;
    }

    get selectors(): ProjectArtifactGraphEngine['selectors'] {
        return this.engine.selectors;
    }

    async initialize(sessions: ChatSession[], workspaceRoot?: string): Promise<ProjectArtifactGraph> {
        this.workspaceRoot = workspaceRoot;
        const loaded = await this.client.load(this.projectId, workspaceRoot);
        this.engine = new ProjectArtifactGraphEngine(loaded);
        this.ensureDefaultCapabilities();
        migrateCanvasSessions(loaded, sessions, this.actor);
        await this.client.save(loaded, workspaceRoot);
        return loaded;
    }

    registerArtifact(artifact: CanvasArtifact, correlationId: string, lineage?: ArtifactRef): CanvasArtifact {
        const registered = registerCanvasArtifact(this.engine, artifact, this.actor, correlationId, lineage);
        this.projectTypedRelations(registered, correlationId);
        this.schedulePersist();
        return registered;
    }

    selectArtifact(artifactId: string, correlationId: string): CanvasArtifact | undefined {
        const result = this.engine.dispatch({
            type: 'artifact.select',
            commandId: `select-${correlationId}-${artifactId}`,
            correlationId,
            idempotencyKey: `select:${correlationId}:${artifactId}`,
            projectId: this.projectId,
            actor: this.actor,
            capability: 'artifact.select',
            artifactId
        });
        this.schedulePersist();
        return projectGraphArtifactToCanvas(this.graph, result.artifactRef);
    }

    link(
        type: ArtifactEdgeType,
        source: ArtifactRef,
        target: ArtifactRef,
        correlationId: string,
        sourceAnchor?: ArtifactAnchor
    ): void {
        this.engine.dispatch({
            type: 'artifact.link',
            commandId: `link-${correlationId}-${type}-${source.artifactId}-${target.artifactId}`,
            correlationId,
            idempotencyKey: `link:${type}:${source.artifactId}:${target.artifactId}:${JSON.stringify(sourceAnchor || {})}`,
            projectId: this.projectId,
            actor: this.actor,
            capability: 'artifact.link',
            edge: { type, source, target, sourceAnchor }
        });
        this.schedulePersist();
    }

    related(artifactId: string): RelatedArtifact[] {
        return this.selectors.relatedArtifacts(artifactId);
    }

    findBrowserByUrl(url: string): CanvasArtifact | undefined {
        for (const artifactId of Object.keys(this.graph.artifacts)) {
            const node = this.graph.artifacts[artifactId];
            if (node.kind !== 'interactive-browser' && node.kind !== 'browser') {
                continue;
            }
            const revision = this.selectors.activeRevision(artifactId);
            if (revision && (revision.payload as InteractiveBrowserData | undefined)?.url === url) {
                return projectGraphArtifactToCanvas(this.graph, {
                    projectId: this.projectId,
                    artifactId,
                    revisionId: revision.id
                });
            }
        }
        return undefined;
    }

    onEvent(listener: (event: ProjectGraphDomainEvent) => void): () => void {
        return this.engine.onEvent(listener);
    }

    async persist(workspaceRoot?: string): Promise<void> {
        if (this.persistTimer) {
            clearTimeout(this.persistTimer);
            this.persistTimer = undefined;
        }
        await this.client.save(this.graph, workspaceRoot || this.workspaceRoot);
    }

    private schedulePersist(): void {
        if (this.persistTimer) {
            clearTimeout(this.persistTimer);
        }
        this.persistTimer = setTimeout(() => {
            this.client.save(this.graph, this.workspaceRoot).catch(error => console.warn('Failed to persist project artifact graph', error));
        }, 250);
    }

    private ensureDefaultCapabilities(): void {
        DEFAULT_CAPABILITIES.forEach(capability => {
            if (!this.graph.project.policy.grants.some(grant =>
                grant.capability === capability && grant.effect === 'allow' && !grant.actorId
            )) {
                this.graph.project.policy.grants.push({ capability, effect: 'allow' });
            }
        });
    }

    private projectTypedRelations(artifact: CanvasArtifact, correlationId: string): void {
        if (!artifact.graphRef) {
            return;
        }
        const artifactRef = artifact.graphRef;
        if (artifact.type === 'markdown-document') {
            const document = artifact.data as MarkdownDocumentData;
            (document.sections || []).forEach(section => {
                (section.citationItems || []).filter(citation => !!citation.url).forEach(citation => {
                    const browserRef = this.ensureProjectionNode(
                        'interactive-browser',
                        citation.sourceTitle,
                        { url: citation.url, title: citation.sourceTitle, viewportMode: 'desktop' },
                        `citation:${citation.url}`,
                        correlationId,
                        ['browser.fetch', 'browser.proxy']
                    );
                    this.link('cites', artifactRef, browserRef, correlationId, {
                        type: 'section',
                        sectionId: section.id
                    });
                });
                if (section.imageUrl && ['image', 'editorial-image', 'location-image'].includes(section.type)) {
                    const mediaRef = this.ensureProjectionNode(
                        'image/media',
                        section.imageTitle || section.locationName || section.caption || 'Generated image',
                        {
                            uri: section.imageUrl,
                            alt: section.alt,
                            prompt: section.prompt || section.visualPrompt,
                            coordinates: section.coordinates
                        },
                        `media:${artifact.id}:${section.id}:${section.imageUrl}`,
                        correlationId,
                        ['media.generate']
                    );
                    this.link('derives-from', mediaRef, artifactRef, correlationId, {
                        type: 'section',
                        sectionId: section.id
                    });
                    this.link('embeds', artifactRef, mediaRef, correlationId, {
                        type: 'section',
                        sectionId: section.id
                    });
                }
            });
        } else if (artifact.type === 'kanban-board') {
            const board = artifact.data as KanbanBoardData;
            (board.columns || []).forEach(column => column.cards.forEach(card => {
                const refs = (card as typeof card & { artifactRefs?: ArtifactRef[] }).artifactRefs;
                (refs || []).forEach(ref => this.link('controls', artifactRef, ref, correlationId, {
                    type: 'node',
                    nodeId: card.id
                }));
            }));
        } else if (artifact.type === 'node-graph') {
            const workflow = artifact.data as NodeGraphData;
            (workflow.nodes || []).forEach(node => {
                const ref = node.parameters?.artifactRef as ArtifactRef | undefined;
                if (ref?.artifactId && this.graph.artifacts[ref.artifactId]) {
                    this.link('controls', artifactRef, ref, correlationId, { type: 'node', nodeId: node.id });
                }
            });
        } else if (artifact.type === '3d-scene') {
            const scene = artifact.data as Scene3DData;
            if (scene.geoAnchor) {
                const mapRef = this.ensureProjectionNode(
                    'map',
                    `${scene.title} map grounding`,
                    scene.geoAnchor,
                    `map:${scene.geoAnchor.lat}:${scene.geoAnchor.lng}`,
                    correlationId,
                    ['map.read']
                );
                this.link('derives-from', artifactRef, mapRef, correlationId, {
                    type: 'spatial',
                    lat: scene.geoAnchor.lat,
                    lng: scene.geoAnchor.lng,
                    altitude: scene.geoAnchor.elevation
                });
            }
            (scene.objects || []).forEach(object => {
                const mediaRef = this.ensureProjectionNode(
                    'spatial-media',
                    `${scene.title} spatial media`,
                    object,
                    `spatial-media:${artifact.id}:${object.id}`,
                    correlationId,
                    ['media.generate']
                );
                this.link('embeds', artifactRef, mediaRef, correlationId, { type: 'node', nodeId: object.id });
            });
        } else if (artifact.type === 'live-code-sandbox') {
            const sandbox = artifact.data as LiveCodeSandboxData;
            const previewRef = (sandbox as LiveCodeSandboxData & { previewArtifactRef?: ArtifactRef }).previewArtifactRef;
            if (previewRef?.artifactId && this.graph.artifacts[previewRef.artifactId]) {
                this.link('previews', artifactRef, previewRef, correlationId);
            }
        }
    }

    private ensureProjectionNode(
        kind: string,
        title: string,
        payload: unknown,
        seed: string,
        correlationId: string,
        requiredCapabilities?: ArtifactCapability[]
    ): ArtifactRef {
        const artifactId = stableProjectArtifactId(kind, `${this.projectId}:${seed}`);
        if (this.graph.artifacts[artifactId]) {
            return {
                projectId: this.projectId,
                artifactId,
                revisionId: this.graph.heads[artifactId]
            };
        }
        return this.engine.dispatch({
            type: 'artifact.create',
            commandId: `projection-create-${artifactId}`,
            correlationId,
            idempotencyKey: `projection:create:${artifactId}`,
            projectId: this.projectId,
            actor: this.actor,
            capability: 'artifact.write',
            artifact: { id: artifactId, kind, title, payload, requiredCapabilities }
        }).artifactRef;
    }
}
