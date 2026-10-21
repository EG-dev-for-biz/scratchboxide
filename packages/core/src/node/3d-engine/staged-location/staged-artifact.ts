/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The staged build's scene artifact, composed from the committed layers each time a stage commits, degrades or the run
 * finishes.
 *
 * - Its id is "scene-stg-<runId>" (8 hex), or the active scene's when staging into it: it never ends in a run of 10 or
 *   more digits, so the end-of-turn commit (resolveCanvasArtifactId) keeps it and the viewport is not remounted. An
 *   active scene whose own id ends in such a run gets "<id>-s", since the commit would re-key it anyway.
 * - One objects[] entry per committed, unretired layer, with id = StagedLayer.objectId (from the stage cache key) and
 *   role 'environment', so a later staging replaces them (isLocationLayer); a structure rebuild's layers (source
 *   'scan_fit') are kept by a later district staged into the scene (kept-structure.ts).
 * - The camera is computed once, from L1's bounds when it commits, and never changes during the run: elevation 28°,
 *   azimuth 45° (the app's auto-framing defaults), distance max(the stand-off for the structure, 1.2 × L1's bounding
 *   sphere radius), the elevation raised in 5° steps up to 70° until the eye is outside L1's box. Every later layer is
 *   no larger than L1, so calculateStandoffCamera keeps it on every attach.
 * - A neutral studio (AGENTS.md): skybox and lighting 'studio', no ground plane, clay.
 */

import * as fs from 'fs';
import type { CanvasArtifact, Media4DObject } from '../../../browser/generative-canvas/canvas-types';
import type { StagedBuildState, StagedLayer } from '../../../common/spatial/staged-location-contracts';
import { anchorOffset, isLocationLayer, offsetObjects, partitionActiveScene, type ActiveScenePartition } from './kept-structure';

export type Vec3 = [number, number, number];
export interface Bounds3 { min: Vec3; max: Vec3 }

/** A layer id is "stg-<key8>-<layer>": the first 8 hex of the stage key that produced it. */
export function layerObjectId(stageKeyHex: string, layer: string): string {
    return `stg-${stageKeyHex.slice(0, 8)}-${layer}`;
}

/** The scene's artifact id: never ends in a run of 10 or more digits (resolveCanvasArtifactId would re-key it). */
export function stagedArtifactId(runId: string, activeSceneId?: string): string {
    if (activeSceneId) return /\d{10,}$/.test(activeSceneId) ? `${activeSceneId}-s` : activeSceneId;
    if (!/^[0-9a-f]{8}$/.test(runId)) throw new Error(`staged artifact: run id must be 8 hex digits, got "${runId}"`);
    return `scene-stg-${runId}`;
}

/** Bounds of a GLB from its POSITION accessors' min/max (glTF requires them), with node translations applied. */
export function glbBounds(file: string): Bounds3 | undefined {
    const buf = fs.readFileSync(file);
    if (buf.length < 20 || buf.readUInt32LE(0) !== 0x46546c67) return undefined;
    const json = JSON.parse(buf.toString('utf8', 20, 20 + buf.readUInt32LE(12)));
    const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
    const visit = (ni: number, offset: Vec3) => {
        const node = json.nodes?.[ni];
        if (!node) return;
        if (node.matrix || node.rotation || node.scale) throw new Error('glbBounds: rotated or scaled nodes are not supported');
        const t = node.translation ?? [0, 0, 0];
        const o: Vec3 = [offset[0] + t[0], offset[1] + t[1], offset[2] + t[2]];
        if (node.mesh !== undefined) {
            for (const prim of json.meshes[node.mesh].primitives ?? []) {
                const acc = json.accessors?.[prim.attributes?.POSITION];
                if (!acc?.min || !acc?.max || !acc.count) continue;
                for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], acc.min[k] + o[k]); max[k] = Math.max(max[k], acc.max[k] + o[k]); }
            }
        }
        for (const c of node.children ?? []) visit(c, o);
    };
    for (const r of json.scenes?.[json.scene ?? 0]?.nodes ?? []) visit(r, [0, 0, 0]);
    return Number.isFinite(min[0]) ? { min, max } : undefined;
}

export interface StagedCamera { position: Vec3; target: Vec3; fov: number }

/**
 * The run's fixed camera. `target` is the footprint centroid at half the structure's height (isolated) or the anchor
 * on the ground (district); `focusRadiusM` is the structure's (or district's) own radius for the stand-off.
 */
export function stagedCamera(l1: Bounds3, target: Vec3, focusRadiusM: number, fovDeg = 60): StagedCamera {
    const half = [(l1.max[0] - l1.min[0]) / 2, (l1.max[1] - l1.min[1]) / 2, (l1.max[2] - l1.min[2]) / 2];
    const sphereRadius = Math.hypot(half[0], half[1], half[2]);
    const standoff = (Math.max(focusRadiusM, 0.05) / Math.sin((fovDeg * Math.PI) / 360)) * 1.35;
    const distance = Math.max(standoff, 1.2 * sphereRadius);
    const azimuth = (45 * Math.PI) / 180;
    const inside = (p: Vec3) => p.every((v, k) => v >= l1.min[k] && v <= l1.max[k]);
    let position: Vec3 = target;
    // from 18° above the ground, so the skyline and a band of sky (an atmosphere's clouds) are in the first frame;
    // steeper only when that point would be inside the tiles
    for (let elevation = 18; elevation <= 70; elevation += 5) {
        const phi = ((90 - elevation) * Math.PI) / 180;
        position = [
            target[0] + distance * Math.sin(phi) * Math.sin(azimuth),
            target[1] + distance * Math.cos(phi),
            target[2] + distance * Math.sin(phi) * Math.cos(azimuth)
        ];
        if (!inside(position)) break;
    }
    const round = (v: Vec3): Vec3 => v.map(x => Math.round(x * 1000) / 1000) as Vec3;
    return { position: round(position), target: round(target), fov: fovDeg };
}

export interface StagedLayerObjectMeta {
    /** "Google3DTilesClay" for scan layers, "SB-Veggie" for regrown trees, "scan_fit" for the rebuild. */
    source: string;
    /** The layer the object builder may stand objects on (the remeshed scan or its rung): one per scene. */
    isGround?: boolean;
    /** Vegetation layers are marked so the viewport never seats anything on them. */
    vegetation?: boolean;
    resolvedAddress: string;
    /** More facts for the object's metadata (the raw extraction it came from, the tree counts), kept beside the standard ones. */
    extra?: Record<string, unknown>;
}

/** One objects[] entry for a committed layer. */
export function layerObject(layer: StagedLayer, meta: StagedLayerObjectMeta): Media4DObject {
    return {
        id: layer.objectId,
        content: {
            type: '3d-model',
            durableUri: layer.url,
            mimeType: 'model/gltf-binary',
            metadata: {
                source: meta.source,
                role: 'environment',
                ...(meta.vegetation ? { layer: 'vegetation' } : {}),
                isGround: meta.isGround === true,
                metricScale: 1.0,
                groundDatumMeters: 0.0,
                resolvedAddress: meta.resolvedAddress,
                stagedLayer: layer.layer,
                stage: layer.stage,
                provenance: layer.provenance.label,
                remeshed: layer.provenanceLabels.includes('remeshed'),
                vertexCount: layer.counts.vertices,
                triangleCount: layer.counts.triangles,
                ...(meta.extra ?? {})
            }
        } as Media4DObject['content'],
        space: { spatial3d: { x: 0, y: 0, z: 0 } } as Media4DObject['space'],
        time: { startMs: 0, durationMs: 20000 } as Media4DObject['time'],
        lineage: { version: 1 } as Media4DObject['lineage']
    };
}

export interface StagedArtifactInput {
    state: StagedBuildState;
    camera: StagedCamera;
    /** objects[] metadata per layer object id. */
    layerMeta: Record<string, StagedLayerObjectMeta>;
    geoAnchor: { lat: number; lng: number; elevation?: number; [k: string]: unknown };
    /** The active scene to stage into (its own objects other than location layers are kept). */
    activeScene?: CanvasArtifact;
    /**
     * The active scene split by partitionActiveScene: its other objects and an earlier build's structure rebuild are
     * kept (the structure moved into this build's frame, its layer records carried so its twins and provenance stay),
     * its location layers replaced. Computed from activeScene when absent.
     */
    carried?: ActiveScenePartition;
    /** One line for the artifact summary (staged-summary's digest). */
    summary: string;
    version: number;
}

export { isLocationLayer };

export function composeStagedArtifact(input: StagedArtifactInput): CanvasArtifact {
    const { state } = input;
    const place = state.place.resolvedAddress || state.place.query;
    const objects = state.layers.filter(l => !l.retired).map(l => {
        const meta = input.layerMeta[l.objectId];
        if (!meta) throw new Error(`staged artifact: no object metadata for layer ${l.objectId}`);
        return layerObject(l, meta);
    });
    const groundDatum = { coordinateSystem: 'metric-enu', units: 'meters', scale: 1.0, groundDatumMeters: 0.0, groundLogic: 'shared-metric-ground' };
    const base = {
        renderMode: 'clay' as const,
        clayPreset: 'studio-grey',
        groundDatum,
        groundTileMode: 'photoreal-clay' as const,
        geoAnchor: input.geoAnchor,
        camera: input.camera,
        stagedBuild: state
    };
    if (input.activeScene) {
        const prev = (input.activeScene.data as any) || {};
        const carried = input.carried ?? partitionActiveScene(input.activeScene);
        // the kept structure, moved into this build's frame; its layer records join this build's so the viewport keeps
        // drawing it (and its textured twins) as it was
        const structure = offsetObjects(carried.structure, anchorOffset(carried.anchor, input.geoAnchor));
        const ownIds = new Set(state.layers.map(l => l.objectId));
        const keptLayers = carried.structureLayers.filter(l => !ownIds.has(l.objectId));
        const stagedBuild: StagedBuildState = {
            ...state,
            layers: [...keptLayers, ...state.layers],
            ...(state.materialMode === undefined && carried.materialMode !== undefined && keptLayers.length ? { materialMode: carried.materialMode } : {})
        };
        return {
            ...input.activeScene,
            id: state.artifactId,
            version: input.version,
            summary: input.summary,
            data: { ...prev, ...base, stagedBuild, objects: [...carried.other, ...structure.filter(o => !ownIds.has(o.id)), ...objects] }
        } as CanvasArtifact;
    }
    return {
        id: state.artifactId,
        type: '3d-scene',
        title: `${place} (staged clay)`,
        summary: input.summary,
        version: input.version,
        data: {
            title: `${place} — staged clay from Google 3D Tiles`,
            subtitle: 'Google 3D Tiles in studio clay, built in stages as each one finishes.',
            cameraMode: 'orbit',
            environment: { skybox: 'studio', lighting: 'studio', ground: false },
            ...base,
            objects
        }
    } as unknown as CanvasArtifact;
}

/** Superseded layers larger than this are retired at finish (removed from objects[]) to free memory. */
export const RETIRE_SUPERSEDED_BYTES = 8 * 1024 * 1024;

/**
 * At finish: superseded layers over RETIRE_SUPERSEDED_BYTES are retired (kept in state, marked, not in objects[]).
 * `keep` (the ground layer objects stand on) is never retired.
 */
export function retireSupersededLayers(layers: StagedLayer[], keep: ReadonlySet<string> = new Set()): StagedLayer[] {
    const superseded = new Set(layers.flatMap(l => l.supersedes));
    return layers.map(l => (superseded.has(l.objectId) && !keep.has(l.objectId) && l.bytes > RETIRE_SUPERSEDED_BYTES ? { ...l, retired: true } : l));
}
