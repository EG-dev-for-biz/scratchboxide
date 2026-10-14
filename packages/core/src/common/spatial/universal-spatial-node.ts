/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * Universal Spatial Node (USN) Contract
 * Scale-free, continuous hierarchical spatial graph representation for
 * Scratchbox IDE. Unifies macroscopic urban districts down to microscopic
 * interior furnishings through a single, continuous geometric hierarchy.
 ********************************************************************************/

export type SpatialPolarity = 'positive_mass' | 'negative_cavity';

export interface MetricOBB {
    center: [number, number, number];
    halfExtents: [number, number, number];
    yawRad?: number;
    quaternion?: [number, number, number, number]; // [x, y, z, w]
}

export type MountPlaneType =
    | 'floor'
    | 'ceiling'
    | 'wall'
    | 'window_sill'
    | 'roof_deck'
    | 'curb_top'
    | (string & {});

export interface SurfaceMountPlane {
    id: string;
    name: string;
    planeType: MountPlaneType;
    planeEquation: [number, number, number, number]; // ax + by + cz + d = 0
    normal: [number, number, number];
    center: [number, number, number];
    dimensions: [number, number]; // [width, depth/height]
    boundaryPolygon?: Array<[number, number]>;
}

export interface NodeGeometryChunk {
    positions: Float32Array;
    normals: Float32Array;
    uvs?: Float32Array;
    indices: Uint32Array;
    materialId?: string;
}

export interface SpatialModifier {
    id: string;
    type: 'taper' | 'twist' | 'bend' | 'boolean_cutout' | 'mount_attachment' | 'array_replicator' | (string & {});
    enabled: boolean;
    parameters: Record<string, unknown>;
}

export interface SpatialProvenance {
    ruleId?: string;
    stepId?: string;
    sourcePrompt?: string;
    authorAgent?: string;
    timestamp?: number;
    confidence?: number; // 1.0 = measured, <0.5 = inferred
    isInferred?: boolean;
    dependencies?: string[];
}

export interface SpatialGeneratorRecipe {
    generatorId: string;
    parameters: Record<string, unknown>;
}

export interface UniversalSpatialNode {
    id: string;
    name: string;
    polarity: SpatialPolarity;
    
    /** Local 4x4 metric affine transform matrix relative to parent (column-major) */
    localTransform: Float32Array;

    /** Bounding envelope in local coordinate frame */
    localBounds: MetricOBB;

    /** World-space oriented bounding box (derived or cached) */
    worldBounds?: MetricOBB;

    /** Optional mesh geometry owned directly by this node */
    geometry?: NodeGeometryChunk;

    /** Planar anchoring interfaces for furniture, equipment, or architectural details */
    mountPlanes?: SurfaceMountPlane[];

    /** Child spatial nodes (e.g. Building -> Floors -> Rooms -> Mount Anchors) */
    children: UniversalSpatialNode[];

    /** Semantic search and classification tags */
    tags: string[];

    /** Domain-specific metadata */
    metadata?: Record<string, unknown>;

    /** Monotonically increasing revision counter */
    version?: number;

    /** Semantic spatial type (e.g. assembly, mesh, group, light) */
    type?: string;

    /** Architectural/functional role (e.g. building, facade, road, window) */
    role?: string;

    /** High-level parametric attributes (e.g. floors, width, height) */
    parameters?: Record<string, any>;

    /** SHA/Murmur content hash for DAG dirty-checking */
    contentHash?: string;

    /** Dirty status indicating this node needs geometric re-evaluation */
    isDirty?: boolean;

    /** High-level generator recipe producing base geometry */
    generatorRecipe?: SpatialGeneratorRecipe;

    /** Non-destructive modifier chain evaluated on top of base geometry */
    modifierStack?: SpatialModifier[];

    /** Provenance, inspectability, and uncertainty metadata */
    provenance?: SpatialProvenance;
}

/**
 * Continuously classifies a surface mount plane based on its normal vector dot product
 * with the gravity/up vector (+Y in right-handed Three.js/glTF space), strictly adhering
 * to Adaptive Domain Architecture (ADA Continuous vs. Discrete Test).
 */
export function classifyMountPlaneFromNormal(
    normal: [number, number, number],
    up: [number, number, number] = [0, 1, 0]
): MountPlaneType {
    const dot = normal[0] * up[0] + normal[1] * up[1] + normal[2] * up[2];
    if (dot > 0.85) {
        return 'floor';
    }
    if (dot < -0.85) {
        return 'ceiling';
    }
    if (Math.abs(dot) < 0.25) {
        return 'wall';
    }
    return 'inclined_plane';
}

/**
 * Creates a default 4x4 identity matrix as a Float32Array.
 */
export function createIdentityMatrix(): Float32Array {
    const m = new Float32Array(16);
    m[0] = 1; m[5] = 1; m[10] = 1; m[15] = 1;
    return m;
}

/**
 * Factory helper for constructing a UniversalSpatialNode.
 * Supports both options-object and positional arguments.
 */
export function createSpatialNode(
    idOrParams: string | (Partial<UniversalSpatialNode> & { id: string; name?: string }),
    typeOrName?: string,
    options?: Partial<UniversalSpatialNode>
): UniversalSpatialNode {
    if (typeof idOrParams === 'object') {
        const params = idOrParams;
        return withInitialContentHash({
            id: params.id,
            name: params.name ?? params.id,
            type: params.type,
            role: params.role,
            parameters: params.parameters ?? {},
            polarity: params.polarity ?? 'positive_mass',
            localTransform: params.localTransform ?? createIdentityMatrix(),
            localBounds: params.localBounds ?? {
                center: [0, 0, 0],
                halfExtents: [0.5, 0.5, 0.5]
            },
            geometry: params.geometry,
            mountPlanes: params.mountPlanes ?? [],
            children: params.children ?? [],
            tags: params.tags ?? [],
            metadata: params.metadata ?? {},
            version: params.version ?? 1,
            contentHash: params.contentHash,
            isDirty: params.isDirty ?? false,
            generatorRecipe: params.generatorRecipe,
            modifierStack: params.modifierStack ?? [],
            provenance: params.provenance
        });
    }

    const id = idOrParams;
    const type = typeOrName;
    const opts = options ?? {};
    return withInitialContentHash({
        id,
        name: opts.name ?? id,
        type: opts.type ?? type,
        role: opts.role,
        parameters: opts.parameters ?? {},
        polarity: opts.polarity ?? 'positive_mass',
        localTransform: opts.localTransform ?? createIdentityMatrix(),
        localBounds: opts.localBounds ?? {
            center: [0, 0, 0],
            halfExtents: [0.5, 0.5, 0.5]
        },
        geometry: opts.geometry,
        mountPlanes: opts.mountPlanes ?? [],
        children: opts.children ?? [],
        tags: opts.tags ?? [],
        metadata: opts.metadata ?? {},
        version: opts.version ?? 1,
        contentHash: opts.contentHash,
        isDirty: opts.isDirty ?? false,
        generatorRecipe: opts.generatorRecipe,
        modifierStack: opts.modifierStack ?? [],
        provenance: opts.provenance
    });
}

/** New nodes carry a content hash from the start so the first mutation can be detected as a change. */
function withInitialContentHash(node: UniversalSpatialNode): UniversalSpatialNode {
    if (!node.contentHash) {
        node.contentHash = computeNodeContentHash(node);
    }
    return node;
}

/**
 * Recursively searches a UniversalSpatialNode hierarchy for a specific node by ID.
 */
export function findSpatialNodeById(root: UniversalSpatialNode, id: string): UniversalSpatialNode | undefined {
    if (root.id === id) {
        return root;
    }
    for (const child of root.children) {
        const found = findSpatialNodeById(child, id);
        if (found) {
            return found;
        }
    }
    return undefined;
}

/**
 * Flattens a UniversalSpatialNode tree into an array of nodes.
 */
export function flattenSpatialTree(root: UniversalSpatialNode): UniversalSpatialNode[] {
    const result: UniversalSpatialNode[] = [root];
    for (const child of root.children) {
        result.push(...flattenSpatialTree(child));
    }
    return result;
}

/**
 * Creates a 4x4 translation matrix (column-major).
 */
export function createTranslationMatrix(tx: number, ty: number, tz: number): Float32Array {
    const m = createIdentityMatrix();
    m[12] = tx;
    m[13] = ty;
    m[14] = tz;
    return m;
}

/**
 * Multiplies two 4x4 column-major matrices (out = a * b).
 */
export function multiplyMatrices4x4(a: Float32Array, b: Float32Array): Float32Array {
    const out = new Float32Array(16);
    for (let c = 0; c < 4; c++) {
        for (let r = 0; r < 4; r++) {
            let sum = 0;
            for (let k = 0; k < 4; k++) {
                sum += a[k * 4 + r] * b[c * 4 + k];
            }
            out[c * 4 + r] = sum;
        }
    }
    return out;
}

/**
 * Returns a cloned copy of the spatial node with a new transform applied.
 */
export function transformSpatialNode(node: UniversalSpatialNode, transform: Float32Array): UniversalSpatialNode {
    const newTransform = multiplyMatrices4x4(transform, node.localTransform);
    const newCenter: [number, number, number] = [
        node.localBounds.center[0] + transform[12],
        node.localBounds.center[1] + transform[13],
        node.localBounds.center[2] + transform[14]
    ];
    return {
        ...node,
        localTransform: newTransform,
        localBounds: {
            ...node.localBounds,
            center: newCenter
        }
    };
}

/**
 * Computes a deterministic content hash for a node's parameters, modifiers, and child IDs.
 */
export function computeNodeContentHash(node: UniversalSpatialNode): string {
    const raw = JSON.stringify({
        id: node.id,
        parameters: node.parameters,
        recipe: node.generatorRecipe,
        modifiers: node.modifierStack,
        childIds: node.children.map(c => c.id)
    });
    let hash = 5381;
    for (let i = 0; i < raw.length; i++) {
        hash = ((hash << 5) + hash) + raw.charCodeAt(i);
        hash = hash & hash;
    }
    return `ch_${(hash >>> 0).toString(16)}`;
}

/**
 * Traverses a spatial hierarchy and marks the target node and its ancestors as dirty.
 * With no target id, marks `root` itself.
 */
export function markNodeDirty(root: UniversalSpatialNode, targetNodeId: string = root.id): boolean {
    if (root.id === targetNodeId) {
        root.isDirty = true;
        root.version = (root.version ?? 1) + 1;
        root.contentHash = computeNodeContentHash(root);
        return true;
    }
    let found = false;
    for (const child of root.children) {
        if (markNodeDirty(child, targetNodeId)) {
            found = true;
        }
    }
    if (found) {
        root.isDirty = true; // Ancestor dirty propagation for bounds recalculation
    }
    return found;
}

/**
 * Collects all nodes marked dirty in the spatial DAG.
 */
export function getDirtyNodes(root: UniversalSpatialNode): UniversalSpatialNode[] {
    const dirty: UniversalSpatialNode[] = [];
    if (root.isDirty) {
        dirty.push(root);
    }
    for (const child of root.children) {
        dirty.push(...getDirtyNodes(child));
    }
    return dirty;
}

/**
 * Resets all dirty flags across the spatial tree once re-evaluation settles.
 */
export function clearDirtyFlags(root: UniversalSpatialNode): void {
    root.isDirty = false;
    for (const child of root.children) {
        clearDirtyFlags(child);
    }
}


