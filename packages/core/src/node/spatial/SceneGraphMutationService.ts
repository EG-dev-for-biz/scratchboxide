/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * Scene Graph Mutation Service
 * Persistent, versioned authority for LLM-driven spatial scene graphs.
 * Enforces transactional leases, optimistic concurrency, non-destructive
 * modifier chains, DAG dirty-propagation, and rollback semantics.
 ********************************************************************************/

import {
    UniversalSpatialNode,
    SpatialModifier,
    SpatialProvenance,
    SpatialGeneratorRecipe,
    SurfaceMountPlane,
    findSpatialNodeById,
    markNodeDirty,
    getDirtyNodes,
    clearDirtyFlags,
    computeNodeContentHash,
    createIdentityMatrix,
    createTranslationMatrix,
    multiplyMatrices4x4,
    createSpatialNode
} from '../../common/spatial/universal-spatial-node';

export interface SpatialLease {
    leaseId: string;
    sceneId: string;
    nodeId: string;
    agentId: string;
    acquiredAt: number;
    expiresAt: number;
}

export type MutationOperationType =
    | 'set_parameters'
    | 'apply_modifier'
    | 'remove_modifier'
    | 'insert_child'
    | 'remove_node'
    | 'attach_to_mount'
    | 'tag_uncertainty';

export interface SpatialMutationDelta {
    transactionId: string;
    nodeId: string;
    operation: MutationOperationType;
    payload: Record<string, any>;
    /** Agent issuing the mutation; checked against the node's lease holder and recorded as provenance author. */
    agentId?: string;
    /** Alias of `agentId`. */
    authorAgent?: string;
    sourcePrompt?: string;
    ruleId?: string;
    expectedVersion?: number;
}

export type SpatialSceneGraphMutation = SpatialMutationDelta;

export interface MutationCommitRecord {
    transactionId: string;
    sceneId: string;
    timestamp: number;
    authorAgent: string;
    affectedNodeIds: string[];
    snapshotBefore: string; // JSON snapshot of affected subtree for rollback
}

export interface MutationResult {
    success: boolean;
    transactionId: string;
    sceneId: string;
    affectedNodeId: string;
    newVersion: number;
    dirtyNodeCount: number;
    error?: string;
}

export class SceneGraphMutationService {
    private static instance: SceneGraphMutationService;

    /** Map of sceneId -> Root UniversalSpatialNode */
    private scenes: Map<string, UniversalSpatialNode> = new Map();

    /** Active spatial leases: leaseId -> SpatialLease */
    private activeLeases: Map<string, SpatialLease> = new Map();

    /** Scene node locks: `${sceneId}:${nodeId}` -> leaseId */
    private nodeLocks: Map<string, string> = new Map();

    /** Commit history log for audit and rollback */
    private commitLog: MutationCommitRecord[] = [];

    public constructor() {}

    public static getInstance(): SceneGraphMutationService {
        if (!SceneGraphMutationService.instance) {
            SceneGraphMutationService.instance = new SceneGraphMutationService();
        }
        return SceneGraphMutationService.instance;
    }

    /**
     * Registers or replaces a scene graph root.
     */
    public registerScene(sceneId: string, root: UniversalSpatialNode): void {
        this.scenes.set(sceneId, root);
    }

    public registerSceneGraph(sceneId: string, root: UniversalSpatialNode): void {
        this.registerScene(sceneId, root);
    }

    /**
     * Retrieves the scene root node, or undefined if not found.
     */
    public getScene(sceneId: string): UniversalSpatialNode | undefined {
        return this.scenes.get(sceneId);
    }

    /**
     * Acquires a scoped spatial lease on a node for an agent.
     * Prevents concurrent agents (e.g. Façade Agent vs Road Agent) from conflicting.
     */
    public acquireSpatialLease(
        sceneId: string,
        nodeId: string,
        agentId: string,
        timeoutMs: number = 30000
    ): SpatialLease {
        const lockKey = `${sceneId}:${nodeId}`;
        const existingLeaseId = this.nodeLocks.get(lockKey);

        const now = Date.now();
        if (existingLeaseId) {
            const existing = this.activeLeases.get(existingLeaseId);
            if (existing && existing.expiresAt > now) {
                if (existing.agentId !== agentId) {
                    throw new Error(
                        `SpatialConcurrencyError: Node '${nodeId}' in scene '${sceneId}' is already locked by agent '${existing.agentId}' until ${new Date(existing.expiresAt).toISOString()}`
                    );
                }
                // Renew own lease
                existing.expiresAt = now + timeoutMs;
                return existing;
            }
            // Expired lease cleanup
            if (existing) {
                this.activeLeases.delete(existingLeaseId);
            }
            this.nodeLocks.delete(lockKey);
        }

        const leaseId = `lease_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
        const lease: SpatialLease = {
            leaseId,
            sceneId,
            nodeId,
            agentId,
            acquiredAt: now,
            expiresAt: now + timeoutMs
        };

        this.activeLeases.set(leaseId, lease);
        this.nodeLocks.set(lockKey, leaseId);
        return lease;
    }

    /**
     * Releases a spatial lease.
     */
    public releaseSpatialLease(leaseId: string): void {
        const lease = this.activeLeases.get(leaseId);
        if (lease) {
            const lockKey = `${lease.sceneId}:${lease.nodeId}`;
            this.nodeLocks.delete(lockKey);
            this.activeLeases.delete(leaseId);
        }
    }

    /**
     * Applies a structured mutation delta to the scene graph.
     * Validates leases, executes the operation non-destructively, marks DAG dirty,
     * and logs the commit for rollback support.
     */
    public applyMutation(
        sceneId: string,
        delta: SpatialMutationDelta,
        lease?: SpatialLease
    ): MutationResult {
        const root = this.scenes.get(sceneId);
        if (!root) {
            return {
                success: false,
                transactionId: delta.transactionId,
                sceneId,
                affectedNodeId: delta.nodeId,
                newVersion: 0,
                dirtyNodeCount: 0,
                error: `Scene '${sceneId}' not found in registry.`
            };
        }
        const authorAgent = delta.agentId || delta.authorAgent;

        // Validate lease if node is locked
        const lockKey = `${sceneId}:${delta.nodeId}`;
        const lockedLeaseId = this.nodeLocks.get(lockKey);
        if (lockedLeaseId) {
            const activeLease = this.activeLeases.get(lockedLeaseId);
            const now = Date.now();
            if (activeLease && now <= activeLease.expiresAt) {
                const leaseMatches = (lease && lease.leaseId === lockedLeaseId) || (Boolean(authorAgent) && activeLease.agentId === authorAgent);
                if (!leaseMatches) {
                    return {
                        success: false,
                        transactionId: delta.transactionId,
                        sceneId,
                        affectedNodeId: delta.nodeId,
                        newVersion: 0,
                        dirtyNodeCount: 0,
                        error: `LeaseViolationError: Node '${delta.nodeId}' is locked under exclusive lease held by agent '${activeLease.agentId}'.`
                    };
                }
            } else {
                // Expired lease
                this.activeLeases.delete(lockedLeaseId);
                this.nodeLocks.delete(lockKey);
            }
        }

        const targetNode = findSpatialNodeById(root, delta.nodeId);
        if (!targetNode) {
            return {
                success: false,
                transactionId: delta.transactionId,
                sceneId,
                affectedNodeId: delta.nodeId,
                newVersion: 0,
                dirtyNodeCount: 0,
                error: `Node '${delta.nodeId}' not found in scene '${sceneId}'.`
            };
        }

        // Optimistic concurrency check
        if (delta.expectedVersion !== undefined && targetNode.version !== undefined) {
            if (targetNode.version !== delta.expectedVersion) {
                return {
                    success: false,
                    transactionId: delta.transactionId,
                    sceneId,
                    affectedNodeId: delta.nodeId,
                    newVersion: targetNode.version,
                    dirtyNodeCount: 0,
                    error: `OptimisticConcurrencyError: Target node version is ${targetNode.version}, expected ${delta.expectedVersion}.`
                };
            }
        }

        // Capture snapshot before mutation for rollback
        const snapshotBefore = JSON.stringify(targetNode);

        try {
            switch (delta.operation) {
                case 'set_parameters': {
                    if (!targetNode.generatorRecipe) {
                        targetNode.generatorRecipe = { generatorId: 'custom', parameters: {} };
                    }
                    targetNode.generatorRecipe.parameters = {
                        ...targetNode.generatorRecipe.parameters,
                        ...delta.payload
                    };
                    targetNode.parameters = {
                        ...(targetNode.parameters || {}),
                        ...delta.payload
                    };
                    break;
                }

                case 'apply_modifier': {
                    if (!targetNode.modifierStack) {
                        targetNode.modifierStack = [];
                    }
                    const modPayload = delta.payload as Partial<SpatialModifier>;
                    const modId = modPayload.id || `mod_${Date.now()}`;
                    const existingIdx = targetNode.modifierStack.findIndex(m => m.id === modId);
                    const modifier: SpatialModifier = {
                        id: modId,
                        type: modPayload.type || 'generic',
                        enabled: modPayload.enabled !== false,
                        parameters: modPayload.parameters || {}
                    };

                    if (existingIdx >= 0) {
                        targetNode.modifierStack[existingIdx] = modifier;
                    } else {
                        targetNode.modifierStack.push(modifier);
                    }
                    break;
                }

                case 'remove_modifier': {
                    if (targetNode.modifierStack) {
                        const targetModId = delta.payload.modifierId;
                        targetNode.modifierStack = targetNode.modifierStack.filter(m => m.id !== targetModId);
                    }
                    break;
                }

                case 'insert_child': {
                    const child = delta.payload.child as UniversalSpatialNode;
                    if (!child || !child.id) {
                        throw new Error("Invalid child node in payload.");
                    }
                    targetNode.children.push(child);
                    break;
                }

                case 'remove_node': {
                    // Remove from parent
                    const removeChild = (parent: UniversalSpatialNode, id: string): boolean => {
                        const idx = parent.children.findIndex(c => c.id === id);
                        if (idx >= 0) {
                            parent.children.splice(idx, 1);
                            return true;
                        }
                        for (const c of parent.children) {
                            if (removeChild(c, id)) return true;
                        }
                        return false;
                    };
                    removeChild(root, delta.nodeId);
                    break;
                }

                case 'attach_to_mount': {
                    const mountFace = (delta.payload.mountFace || delta.payload.mountId || 'front') as string;
                    let childNode = delta.payload.child as UniversalSpatialNode;
                    if (!childNode && delta.payload.childId) {
                        childNode = createSpatialNode(delta.payload.childId, delta.payload.childType || 'mesh', {
                            name: delta.payload.childName || 'Accessory',
                            role: delta.payload.childRole || 'accessory'
                        });
                    }
                    if (!childNode) throw new Error("Child node required for attach_to_mount");

                    const plane = targetNode.mountPlanes?.find(p => p.id === mountFace || p.planeType === mountFace);
                    const standoff = delta.payload.standoff ?? 0.05;
                    const offsetU = delta.payload.offsetU ?? 0.0;
                    const offsetV = delta.payload.offsetV ?? 0.0;

                    let tx = offsetU;
                    let ty = offsetV;
                    let tz = standoff;

                    if (plane) {
                        tx += plane.center[0];
                        ty += plane.center[1];
                        tz += plane.center[2];
                    }

                    const mountTransform = createTranslationMatrix(tx, ty, tz);
                    childNode.localTransform = multiplyMatrices4x4(mountTransform, childNode.localTransform);

                    targetNode.children.push(childNode);
                    break;
                }

                case 'tag_uncertainty': {
                    if (!targetNode.provenance) {
                        targetNode.provenance = {};
                    }
                    if (delta.payload.confidence !== undefined) {
                        targetNode.provenance.confidence = Number(delta.payload.confidence);
                    }
                    if (delta.payload.isInferred !== undefined) {
                        targetNode.provenance.isInferred = Boolean(delta.payload.isInferred);
                    }
                    break;
                }

                default:
                    throw new Error(`Unsupported mutation operation '${delta.operation}'`);
            }

            // Update provenance
            if (!targetNode.provenance) targetNode.provenance = {};
            targetNode.provenance.authorAgent = authorAgent || targetNode.provenance.authorAgent;
            targetNode.provenance.sourcePrompt = delta.sourcePrompt || targetNode.provenance.sourcePrompt;
            targetNode.provenance.ruleId = delta.ruleId || targetNode.provenance.ruleId;
            targetNode.provenance.timestamp = Date.now();

            // Mark dirty in DAG
            markNodeDirty(root, targetNode.id);

            // Record commit for rollback capability
            this.commitLog.push({
                transactionId: delta.transactionId,
                sceneId,
                timestamp: Date.now(),
                authorAgent: authorAgent || 'system',
                affectedNodeIds: [targetNode.id],
                snapshotBefore
            });

            const dirtyNodes = getDirtyNodes(root);

            return {
                success: true,
                transactionId: delta.transactionId,
                sceneId,
                affectedNodeId: targetNode.id,
                newVersion: targetNode.version ?? 1,
                dirtyNodeCount: dirtyNodes.length
            };
        } catch (err: any) {
            return {
                success: false,
                transactionId: delta.transactionId,
                sceneId,
                affectedNodeId: delta.nodeId,
                newVersion: targetNode.version ?? 0,
                dirtyNodeCount: 0,
                error: err.message || String(err)
            };
        }
    }

    /**
     * Rolls back a transaction using its pre-commit snapshot.
     */
    public rollbackTransaction(sceneIdOrTxId: string, maybeTxId?: string): boolean {
        const transactionId = maybeTxId ?? sceneIdOrTxId;
        const recordIdx = this.commitLog.findIndex(c => c.transactionId === transactionId);
        if (recordIdx < 0) return false;

        const record = this.commitLog[recordIdx];
        const root = this.scenes.get(record.sceneId);
        if (!root) return false;

        try {
            const restoredNode: UniversalSpatialNode = JSON.parse(record.snapshotBefore);
            const target = findSpatialNodeById(root, restoredNode.id);
            if (target) {
                Object.assign(target, restoredNode);
                markNodeDirty(root, target.id);
            }
            this.commitLog.splice(recordIdx, 1);
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Evaluates dirty subtrees incrementally via a generator callback.
     * Only invokes the generator for nodes that have changed, preserving clean nodes.
     * Returns the number of nodes evaluated.
     */
    public async evaluateDirtySubtrees(
        sceneId: string,
        evaluator: (node: UniversalSpatialNode) => Promise<void>
    ): Promise<number> {
        const root = this.scenes.get(sceneId);
        if (!root) return 0;

        const dirtyNodes = getDirtyNodes(root);
        for (const node of dirtyNodes) {
            await evaluator(node);
        }

        clearDirtyFlags(root);
        return dirtyNodes.length;
    }
}
