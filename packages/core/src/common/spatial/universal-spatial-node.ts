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

export interface SurfaceMountPlane {
    id: string;
    name: string;
    planeType: 'floor' | 'ceiling' | 'wall' | 'window_sill' | 'roof_deck' | 'curb_top';
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
 */
export function createSpatialNode(params: {
    id: string;
    name: string;
    polarity?: SpatialPolarity;
    localTransform?: Float32Array;
    localBounds: MetricOBB;
    geometry?: NodeGeometryChunk;
    mountPlanes?: SurfaceMountPlane[];
    children?: UniversalSpatialNode[];
    tags?: string[];
    metadata?: Record<string, unknown>;
}): UniversalSpatialNode {
    return {
        id: params.id,
        name: params.name,
        polarity: params.polarity ?? 'positive_mass',
        localTransform: params.localTransform ?? createIdentityMatrix(),
        localBounds: params.localBounds,
        geometry: params.geometry,
        mountPlanes: params.mountPlanes ?? [],
        children: params.children ?? [],
        tags: params.tags ?? [],
        metadata: params.metadata ?? {}
    };
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

