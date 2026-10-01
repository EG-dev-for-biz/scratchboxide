/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

export const PROJECT_ARTIFACT_GRAPH_SCHEMA_VERSION = 1;

export type ArtifactId = string;
export type RevisionId = string;
export type EdgeId = string;

export type ArtifactEdgeType =
    | 'source'
    | 'derives-from'
    | 'embeds'
    | 'previews'
    | 'controls'
    | 'cites'
    | 'tests'
    | 'deploys'
    | 'references';

export type ArtifactCapability =
    | 'artifact.read'
    | 'artifact.write'
    | 'artifact.link'
    | 'artifact.select'
    | 'browser.fetch'
    | 'browser.proxy'
    | 'tool.execute'
    | 'map.read'
    | 'media.generate'
    | 'workspace.write'
    | 'deploy';

export interface ArtifactActor {
    id: string;
    displayName?: string;
    kind: 'user' | 'agent' | 'workflow' | 'system';
}

export interface ArtifactRef {
    projectId: string;
    artifactId: ArtifactId;
    revisionId?: RevisionId;
}

export type ArtifactAnchor =
    | { type: 'section'; sectionId: string }
    | { type: 'range'; sectionId?: string; start: number; end: number }
    | { type: 'node'; nodeId: string }
    | { type: 'file'; path: string; startLine?: number; endLine?: number }
    | { type: 'spatial'; lat: number; lng: number; altitude?: number };

export interface ContentAddressedBlobRef {
    uri: string;
    contentHash: string;
    mimeType: string;
    byteLength?: number;
}

export interface ArtifactCapabilityGrant {
    capability: ArtifactCapability;
    effect: 'allow' | 'deny';
    actorId?: string;
    artifactId?: ArtifactId;
    targetOrigins?: string[];
    expiresAt?: string;
}

export interface ProjectGraphPolicy {
    grants: ArtifactCapabilityGrant[];
}

export interface ProjectGraphContext {
    summary?: string;
    facts?: Record<string, string>;
    grounding?: Record<string, unknown>;
}

export interface ProjectGraphStyle {
    writing?: Record<string, unknown>;
    visual?: Record<string, unknown>;
}

export interface ArtifactNode {
    id: ArtifactId;
    kind: string;
    title: string;
    lifecycle: 'active' | 'archived';
    createdAt: string;
    createdBy: ArtifactActor;
    requiredCapabilities?: ArtifactCapability[];
    legacy?: {
        canvasArtifactId?: string;
        sessionIds?: string[];
    };
}

export interface ArtifactRevision {
    id: RevisionId;
    artifactId: ArtifactId;
    parentRevisionId?: RevisionId;
    revision: number;
    title: string;
    payload: unknown;
    contentHash: string;
    blobs?: ContentAddressedBlobRef[];
    author: ArtifactActor;
    commandId: string;
    createdAt: string;
    grounding?: Record<string, unknown>;
    style?: Record<string, unknown>;
    compensatesRevisionId?: RevisionId;
}

export interface ArtifactEdge {
    id: EdgeId;
    type: ArtifactEdgeType;
    source: ArtifactRef;
    target: ArtifactRef;
    sourceAnchor?: ArtifactAnchor;
    targetAnchor?: ArtifactAnchor;
    createdAt: string;
    createdBy: ArtifactActor;
    commandId: string;
    lifecycle: 'active' | 'archived';
    metadata?: Record<string, unknown>;
}

export interface ProjectArtifactGraph {
    schemaVersion: number;
    project: {
        id: string;
        createdAt: string;
        updatedAt: string;
        context: ProjectGraphContext;
        style: ProjectGraphStyle;
        policy: ProjectGraphPolicy;
    };
    artifacts: Record<ArtifactId, ArtifactNode>;
    revisions: Record<RevisionId, ArtifactRevision>;
    edges: Record<EdgeId, ArtifactEdge>;
    heads: Record<ArtifactId, RevisionId>;
    selection?: ArtifactRef;
    processedCommands: Record<string, ProjectGraphCommandResult>;
}

interface ProjectGraphCommandEnvelope {
    commandId: string;
    correlationId: string;
    idempotencyKey: string;
    projectId: string;
    actor: ArtifactActor;
    capability: ArtifactCapability;
}

export interface CreateArtifactCommand extends ProjectGraphCommandEnvelope {
    type: 'artifact.create';
    artifact: {
        id?: ArtifactId;
        kind: string;
        title: string;
        payload: unknown;
        blobs?: ContentAddressedBlobRef[];
        grounding?: Record<string, unknown>;
        style?: Record<string, unknown>;
        requiredCapabilities?: ArtifactCapability[];
        legacy?: ArtifactNode['legacy'];
    };
}

export interface UpdateArtifactCommand extends ProjectGraphCommandEnvelope {
    type: 'artifact.update';
    artifactId: ArtifactId;
    expectedRevision: RevisionId;
    title?: string;
    payload: unknown;
    blobs?: ContentAddressedBlobRef[];
    grounding?: Record<string, unknown>;
    style?: Record<string, unknown>;
    compensatesRevisionId?: RevisionId;
}

export interface LinkArtifactCommand extends ProjectGraphCommandEnvelope {
    type: 'artifact.link';
    edge: {
        id?: EdgeId;
        type: ArtifactEdgeType;
        source: ArtifactRef;
        target: ArtifactRef;
        sourceAnchor?: ArtifactAnchor;
        targetAnchor?: ArtifactAnchor;
        metadata?: Record<string, unknown>;
    };
}

export interface UnlinkArtifactCommand extends ProjectGraphCommandEnvelope {
    type: 'artifact.unlink';
    edgeId: EdgeId;
}

export interface LifecycleArtifactCommand extends ProjectGraphCommandEnvelope {
    type: 'artifact.archive' | 'artifact.restore';
    artifactId: ArtifactId;
    expectedRevision?: RevisionId;
}

export interface SelectArtifactCommand extends ProjectGraphCommandEnvelope {
    type: 'artifact.select';
    artifactId: ArtifactId;
    revisionId?: RevisionId;
}

export type ProjectGraphCommand =
    | CreateArtifactCommand
    | UpdateArtifactCommand
    | LinkArtifactCommand
    | UnlinkArtifactCommand
    | LifecycleArtifactCommand
    | SelectArtifactCommand;

export interface ProjectGraphCommandResult {
    status: 'applied' | 'duplicate';
    commandId: string;
    correlationId: string;
    artifactRef: ArtifactRef;
    edgeId?: EdgeId;
}

export type ProjectGraphDomainEventType =
    | 'artifact.created'
    | 'artifact.revised'
    | 'artifact.archived'
    | 'artifact.restored'
    | 'artifact.selected'
    | 'artifact.linked'
    | 'artifact.unlinked';

export interface ProjectGraphDomainEvent {
    id: string;
    type: ProjectGraphDomainEventType;
    projectId: string;
    artifactRef: ArtifactRef;
    edgeId?: EdgeId;
    commandId: string;
    correlationId: string;
    actor: ArtifactActor;
    occurredAt: string;
}

export interface RelatedArtifact {
    artifact: ArtifactNode;
    revision?: ArtifactRevision;
    edge: ArtifactEdge;
    direction: 'outgoing' | 'incoming';
}

export class ProjectGraphConflictError extends Error {
    constructor(
        public readonly artifactId: ArtifactId,
        public readonly expectedRevision: RevisionId,
        public readonly actualRevision?: RevisionId
    ) {
        super(`Revision conflict for ${artifactId}: expected ${expectedRevision}, actual ${actualRevision || 'none'}`);
        this.name = 'ProjectGraphConflictError';
    }
}

export class ProjectGraphCapabilityError extends Error {
    constructor(public readonly capability: ArtifactCapability) {
        super(`Capability denied: ${capability}`);
        this.name = 'ProjectGraphCapabilityError';
    }
}

function now(): string {
    return new Date().toISOString();
}

export function stableProjectArtifactId(kind: string, seed: string): ArtifactId {
    return `artifact-${slug(kind)}-${hashValue(seed)}`;
}

export function hashValue(value: unknown): string {
    const input = typeof value === 'string' ? value : stableStringify(value);
    let hash = 2166136261;
    for (let i = 0; i < input.length; i++) {
        hash ^= input.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
}

function slug(value: string): string {
    return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'artifact';
}

function stableStringify(value: unknown): string {
    if (value === undefined) {
        return 'null';
    }
    if (value === null || typeof value !== 'object') {
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
        return `[${value.map(stableStringify).join(',')}]`;
    }
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${stableStringify(object[key])}`).join(',')}}`;
}

export function createEmptyProjectGraph(projectId: string, policy: ProjectGraphPolicy = { grants: [] }): ProjectArtifactGraph {
    const createdAt = now();
    return {
        schemaVersion: PROJECT_ARTIFACT_GRAPH_SCHEMA_VERSION,
        project: {
            id: projectId,
            createdAt,
            updatedAt: createdAt,
            context: {},
            style: {},
            policy
        },
        artifacts: {},
        revisions: {},
        edges: {},
        heads: {},
        processedCommands: {}
    };
}

export function isCapabilityGranted(
    policy: ProjectGraphPolicy,
    capability: ArtifactCapability,
    actorId?: string,
    artifactId?: ArtifactId,
    targetUrl?: string
): boolean {
    const origin = targetUrl ? new URL(targetUrl).origin : undefined;
    const grants = policy.grants.filter(grant =>
        grant.capability === capability &&
        (!grant.actorId || grant.actorId === actorId) &&
        (!grant.artifactId || grant.artifactId === artifactId) &&
        (!grant.expiresAt || new Date(grant.expiresAt).getTime() > Date.now()) &&
        (!origin || !grant.targetOrigins || grant.targetOrigins.includes(origin))
    );
    return grants.some(grant => grant.effect === 'allow') && !grants.some(grant => grant.effect === 'deny');
}

export function serializeProjectGraph(graph: ProjectArtifactGraph): string {
    return JSON.stringify(graph, undefined, 2);
}

export function parseProjectGraph(serialized: string): ProjectArtifactGraph {
    const graph = JSON.parse(serialized) as ProjectArtifactGraph;
    if (!graph || graph.schemaVersion !== PROJECT_ARTIFACT_GRAPH_SCHEMA_VERSION || !graph.project?.id) {
        throw new Error('Unsupported or invalid project artifact graph');
    }
    graph.processedCommands = graph.processedCommands || {};
    graph.project.context = graph.project.context || {};
    graph.project.style = graph.project.style || {};
    graph.project.policy = graph.project.policy || { grants: [] };
    Object.keys(graph.revisions).forEach(id => {
        graph.revisions[id] = freezeRevision(graph.revisions[id]);
    });
    return graph;
}

export class ProjectArtifactGraphSelectors {
    constructor(private readonly graph: ProjectArtifactGraph) {}

    node(artifactId: ArtifactId): ArtifactNode | undefined {
        return this.graph.artifacts[artifactId];
    }

    activeRevision(artifactId: ArtifactId): ArtifactRevision | undefined {
        return this.revision({ projectId: this.graph.project.id, artifactId });
    }

    revision(ref: ArtifactRef): ArtifactRevision | undefined {
        return this.graph.revisions[ref.revisionId || this.graph.heads[ref.artifactId]];
    }

    neighbors(artifactId: ArtifactId): RelatedArtifact[] {
        return this.relatedArtifacts(artifactId).filter(item => item.direction === 'outgoing');
    }

    backlinks(artifactId: ArtifactId): RelatedArtifact[] {
        return this.relatedArtifacts(artifactId).filter(item => item.direction === 'incoming');
    }

    relatedArtifacts(artifactId: ArtifactId, types?: ArtifactEdgeType[]): RelatedArtifact[] {
        return Object.keys(this.graph.edges)
            .map(id => this.graph.edges[id])
            .filter(edge => edge.lifecycle === 'active' && (!types || types.includes(edge.type)))
            .filter(edge => edge.source.artifactId === artifactId || edge.target.artifactId === artifactId)
            .map(edge => {
                const outgoing = edge.source.artifactId === artifactId;
                const ref = outgoing ? edge.target : edge.source;
                return {
                    artifact: this.graph.artifacts[ref.artifactId],
                    revision: this.revision(ref),
                    edge,
                    direction: outgoing ? 'outgoing' as const : 'incoming' as const
                };
            })
            .filter(item => !!item.artifact);
    }
}

export class ProjectArtifactGraphEngine {
    readonly selectors: ProjectArtifactGraphSelectors;
    readonly events: ProjectGraphDomainEvent[] = [];
    private readonly listeners: Array<(event: ProjectGraphDomainEvent) => void> = [];

    constructor(public readonly graph: ProjectArtifactGraph) {
        this.selectors = new ProjectArtifactGraphSelectors(graph);
    }

    onEvent(listener: (event: ProjectGraphDomainEvent) => void): () => void {
        this.listeners.push(listener);
        return () => {
            const index = this.listeners.indexOf(listener);
            if (index >= 0) {
                this.listeners.splice(index, 1);
            }
        };
    }

    dispatch(command: ProjectGraphCommand): ProjectGraphCommandResult {
        if (command.projectId !== this.graph.project.id) {
            throw new Error(`Command project ${command.projectId} does not match graph ${this.graph.project.id}`);
        }
        const duplicate = this.graph.processedCommands[command.idempotencyKey];
        if (duplicate) {
            return { ...duplicate, status: 'duplicate' };
        }
        this.assertCapability(command);

        let result: ProjectGraphCommandResult;
        switch (command.type) {
            case 'artifact.create':
                result = this.create(command);
                break;
            case 'artifact.update':
                result = this.update(command);
                break;
            case 'artifact.link':
                result = this.link(command);
                break;
            case 'artifact.unlink':
                result = this.unlink(command);
                break;
            case 'artifact.archive':
            case 'artifact.restore':
                result = this.lifecycle(command);
                break;
            case 'artifact.select':
                result = this.select(command);
                break;
            default:
                throw new Error('Unsupported graph command');
        }
        this.graph.processedCommands[command.idempotencyKey] = result;
        this.graph.project.updatedAt = now();
        return result;
    }

    undo(commandId: string, envelope: Omit<UpdateArtifactCommand, 'type' | 'projectId' | 'artifactId' | 'expectedRevision' | 'payload'>): ProjectGraphCommandResult {
        const target = Object.keys(this.graph.revisions)
            .map(id => this.graph.revisions[id])
            .find(revision => revision.commandId === commandId);
        if (!target) {
            throw new Error(`Cannot undo unknown revision command ${commandId}`);
        }
        const parent = target.parentRevisionId ? this.graph.revisions[target.parentRevisionId] : undefined;
        if (!parent) {
            throw new Error(`Revision ${target.id} has no parent to restore`);
        }
        return this.dispatch({
            ...envelope,
            type: 'artifact.update',
            projectId: this.graph.project.id,
            artifactId: target.artifactId,
            expectedRevision: this.graph.heads[target.artifactId],
            title: parent.title,
            payload: parent.payload,
            blobs: parent.blobs,
            grounding: parent.grounding,
            style: parent.style,
            compensatesRevisionId: target.id
        });
    }

    private create(command: CreateArtifactCommand): ProjectGraphCommandResult {
        const artifactId = command.artifact.id || stableProjectArtifactId(
            command.artifact.kind,
            `${this.graph.project.id}:${command.idempotencyKey}`
        );
        if (this.graph.artifacts[artifactId]) {
            throw new Error(`Artifact ${artifactId} already exists`);
        }
        const createdAt = now();
        this.graph.artifacts[artifactId] = {
            id: artifactId,
            kind: command.artifact.kind,
            title: command.artifact.title,
            lifecycle: 'active',
            createdAt,
            createdBy: command.actor,
            requiredCapabilities: command.artifact.requiredCapabilities,
            legacy: command.artifact.legacy
        };
        const revision = this.appendRevision(
            artifactId,
            command.artifact.title,
            command.artifact.payload,
            command,
            undefined,
            command.artifact
        );
        const artifactRef = this.ref(artifactId, revision.id);
        this.emit('artifact.created', command, artifactRef);
        return this.result(command, artifactRef);
    }

    private update(command: UpdateArtifactCommand): ProjectGraphCommandResult {
        const head = this.graph.heads[command.artifactId];
        if (head !== command.expectedRevision) {
            throw new ProjectGraphConflictError(command.artifactId, command.expectedRevision, head);
        }
        const node = this.requireNode(command.artifactId);
        const previous = this.graph.revisions[head];
        const title = command.title || previous.title;
        const revision = this.appendRevision(command.artifactId, title, command.payload, command, head, command);
        node.title = title;
        const artifactRef = this.ref(command.artifactId, revision.id);
        this.emit('artifact.revised', command, artifactRef);
        return this.result(command, artifactRef);
    }

    private link(command: LinkArtifactCommand): ProjectGraphCommandResult {
        this.requireNode(command.edge.source.artifactId);
        this.requireNode(command.edge.target.artifactId);
        const edgeId = command.edge.id || `edge-${hashValue({
            type: command.edge.type,
            source: command.edge.source,
            target: command.edge.target,
            sourceAnchor: command.edge.sourceAnchor,
            targetAnchor: command.edge.targetAnchor
        })}`;
        const existing = this.graph.edges[edgeId];
        if (!existing) {
            this.graph.edges[edgeId] = {
                ...command.edge,
                id: edgeId,
                createdAt: now(),
                createdBy: command.actor,
                commandId: command.commandId,
                lifecycle: 'active'
            };
        } else {
            existing.lifecycle = 'active';
        }
        const artifactRef = this.ref(command.edge.source.artifactId);
        this.emit('artifact.linked', command, artifactRef, edgeId);
        return this.result(command, artifactRef, edgeId);
    }

    private unlink(command: UnlinkArtifactCommand): ProjectGraphCommandResult {
        const edge = this.graph.edges[command.edgeId];
        if (!edge) {
            throw new Error(`Unknown edge ${command.edgeId}`);
        }
        edge.lifecycle = 'archived';
        const artifactRef = this.ref(edge.source.artifactId);
        this.emit('artifact.unlinked', command, artifactRef, edge.id);
        return this.result(command, artifactRef, edge.id);
    }

    private lifecycle(command: LifecycleArtifactCommand): ProjectGraphCommandResult {
        const node = this.requireNode(command.artifactId);
        const head = this.graph.heads[command.artifactId];
        if (command.expectedRevision && command.expectedRevision !== head) {
            throw new ProjectGraphConflictError(command.artifactId, command.expectedRevision, head);
        }
        node.lifecycle = command.type === 'artifact.archive' ? 'archived' : 'active';
        const artifactRef = this.ref(command.artifactId);
        this.emit(command.type === 'artifact.archive' ? 'artifact.archived' : 'artifact.restored', command, artifactRef);
        return this.result(command, artifactRef);
    }

    private select(command: SelectArtifactCommand): ProjectGraphCommandResult {
        this.requireNode(command.artifactId);
        const artifactRef = this.ref(command.artifactId, command.revisionId);
        this.graph.selection = artifactRef;
        this.emit('artifact.selected', command, artifactRef);
        return this.result(command, artifactRef);
    }

    private appendRevision(
        artifactId: ArtifactId,
        title: string,
        payload: unknown,
        command: ProjectGraphCommandEnvelope,
        parentRevisionId?: RevisionId,
        options: {
            blobs?: ContentAddressedBlobRef[];
            grounding?: Record<string, unknown>;
            style?: Record<string, unknown>;
            compensatesRevisionId?: RevisionId;
        } = {}
    ): ArtifactRevision {
        const parent = parentRevisionId ? this.graph.revisions[parentRevisionId] : undefined;
        const contentHash = hashValue({ title, payload, blobs: options.blobs });
        const id = `revision-${artifactId}-${(parent?.revision || 0) + 1}-${hashValue(`${command.commandId}:${contentHash}`)}`;
        const revision = freezeRevision({
            id,
            artifactId,
            parentRevisionId,
            revision: (parent?.revision || 0) + 1,
            title,
            payload: cloneSnapshot(payload),
            contentHash,
            blobs: options.blobs,
            author: command.actor,
            commandId: command.commandId,
            createdAt: now(),
            grounding: options.grounding,
            style: options.style,
            compensatesRevisionId: options.compensatesRevisionId
        });
        this.graph.revisions[id] = revision;
        this.graph.heads[artifactId] = id;
        return revision;
    }

    private assertCapability(command: ProjectGraphCommand): void {
        const artifactId = 'artifactId' in command ? command.artifactId : undefined;
        if (!isCapabilityGranted(this.graph.project.policy, command.capability, command.actor.id, artifactId)) {
            throw new ProjectGraphCapabilityError(command.capability);
        }
    }

    private requireNode(artifactId: ArtifactId): ArtifactNode {
        const node = this.graph.artifacts[artifactId];
        if (!node) {
            throw new Error(`Unknown artifact ${artifactId}`);
        }
        return node;
    }

    private ref(artifactId: ArtifactId, revisionId?: RevisionId): ArtifactRef {
        return {
            projectId: this.graph.project.id,
            artifactId,
            revisionId: revisionId || this.graph.heads[artifactId]
        };
    }

    private result(command: ProjectGraphCommandEnvelope, artifactRef: ArtifactRef, edgeId?: EdgeId): ProjectGraphCommandResult {
        return {
            status: 'applied',
            commandId: command.commandId,
            correlationId: command.correlationId,
            artifactRef,
            edgeId
        };
    }

    private emit(
        type: ProjectGraphDomainEventType,
        command: ProjectGraphCommandEnvelope,
        artifactRef: ArtifactRef,
        edgeId?: EdgeId
    ): void {
        const event: ProjectGraphDomainEvent = {
            id: `event-${hashValue(`${command.commandId}:${type}:${edgeId || artifactRef.revisionId || artifactRef.artifactId}`)}`,
            type,
            projectId: this.graph.project.id,
            artifactRef,
            edgeId,
            commandId: command.commandId,
            correlationId: command.correlationId,
            actor: command.actor,
            occurredAt: now()
        };
        this.events.push(event);
        this.listeners.slice().forEach(listener => listener(event));
    }
}

function cloneSnapshot<T>(value: T): T {
    if (value === undefined || value === null) {
        return value;
    }
    return JSON.parse(JSON.stringify(value)) as T;
}

function freezeRevision(revision: ArtifactRevision): ArtifactRevision {
    deepFreeze(revision.payload);
    if (revision.blobs) {
        deepFreeze(revision.blobs);
    }
    return Object.freeze(revision);
}

function deepFreeze(value: unknown): void {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) {
        return;
    }
    Object.freeze(value);
    Object.keys(value as Record<string, unknown>).forEach(key =>
        deepFreeze((value as Record<string, unknown>)[key])
    );
}

interface LegacyCanvasArtifact {
    id: string;
    type: string;
    title: string;
    summary?: string;
    data: unknown;
    version?: number;
}

interface LegacyChatMessage {
    artifacts?: LegacyCanvasArtifact[];
    artifactRefs?: ArtifactRef[];
}

interface LegacyCanvasSession {
    id: string;
    activeArtifact?: LegacyCanvasArtifact;
    artifactHistory?: LegacyCanvasArtifact[];
    messages?: LegacyChatMessage[];
}

export function migrateCanvasSessions<T extends LegacyCanvasSession>(
    graph: ProjectArtifactGraph,
    sessions: T[],
    actor: ArtifactActor
): ProjectArtifactGraph {
    const engine = new ProjectArtifactGraphEngine(graph);
    sessions.forEach(session => {
        const artifacts = ([] as LegacyCanvasArtifact[])
            .concat(session.artifactHistory || [])
            .concat(session.activeArtifact || [])
            .concat(...(session.messages || []).map(message => message.artifacts || []));
        artifacts.forEach(artifact => {
            const artifactId = legacyArtifactId(graph.project.id, artifact);
            if (!graph.artifacts[artifactId]) {
                engine.dispatch({
                    type: 'artifact.create',
                    commandId: `migration-create-${artifactId}`,
                    correlationId: `migration-session-${session.id}`,
                    idempotencyKey: `migration:create:${artifactId}`,
                    projectId: graph.project.id,
                    actor,
                    capability: ensureMigrationCapability(graph, 'artifact.write'),
                    artifact: {
                        id: artifactId,
                        kind: artifact.type,
                        title: artifact.title,
                        payload: artifact.data,
                        legacy: { canvasArtifactId: artifact.id, sessionIds: [session.id] }
                    }
                });
            } else {
                const legacy = graph.artifacts[artifactId].legacy || {};
                legacy.sessionIds = Array.from(new Set([...(legacy.sessionIds || []), session.id]));
                graph.artifacts[artifactId].legacy = legacy;
            }
        });
        (session.messages || []).forEach(message => {
            if (message.artifacts?.length) {
                message.artifactRefs = message.artifacts.map(artifact => ({
                    projectId: graph.project.id,
                    artifactId: legacyArtifactId(graph.project.id, artifact),
                    revisionId: graph.heads[legacyArtifactId(graph.project.id, artifact)]
                }));
            }
        });
    });
    return graph;
}

function legacyArtifactId(projectId: string, artifact: LegacyCanvasArtifact): string {
    if (artifact.id && !/-\d{10,}$/.test(artifact.id)) {
        return artifact.id;
    }
    return stableProjectArtifactId(artifact.type, `${projectId}:${artifact.title}:${JSON.stringify(artifact.data)}`);
}

function ensureMigrationCapability(graph: ProjectArtifactGraph, capability: ArtifactCapability): ArtifactCapability {
    if (!graph.project.policy.grants.some(grant => grant.capability === capability && grant.effect === 'allow')) {
        graph.project.policy.grants.push({ capability, effect: 'allow' });
    }
    return capability;
}
