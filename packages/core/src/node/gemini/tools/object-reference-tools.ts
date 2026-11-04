/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * build_3d_object_from_reference: one object or abstract form asked for in words becomes native geometry
 * (reference-object-builder.ts), each part with its own PBR material factors read from the full-colour reference
 * (inferred from a generated image, and labelled so), shown in the viewport's 'pbr' mode; or, when the user asks
 * for clay, all studio clay in 'clay' mode. Given specJson instead (an edit of an earlier build's spec), it rebuilds that spec
 * exactly, with no reference image and no model call.
 *
 * With a location, the object is staged on the same geocoded, remeshed clay tiles that google_3d_tiles_get_clay
 * returns, at the placement the model gives relative to the place's anchor, with the camera framed on the object.
 * The viewport stands an object on the highest surface under its base (whatever mesh that is), so the object may
 * only stand where that surface is ground: the staged layers marked isGround (the tiles, including their roofs). A
 * spot under a tree crown or on another object fails, naming what covers it and the nearest clear spots. Once built,
 * the object's whole footprint is checked: it must not cover the base of an object already there, nor pass through a
 * crown, a trunk, another object or the tiles themselves (ground rising into it more than a slope or kerb would);
 * such a build fails with its spec and the nearest spots where it fits. A new build checks its spot before any model
 * is called; a given spec is built first, so a spec that cannot be built makes no billed staging call. Staged models
 * are read and measured in slices, and kept between calls while unchanged, so the server stays responsive.
 *
 * When the active scene is an object build staged at the same location, or the call passes addToActiveScene (for a
 * place google_3d_tiles_get_clay staged), its staging is reused (no new geocode or extraction) and everything staged
 * there is kept: the new object is added beside the objects built there, or replaces the one replaceObjectId names.
 * Every built object carries its own spec and placement in its metadata, so each can be changed later. A staging or
 * placement failure fails the call, and a stop while staging or placing is reported as a stop. The result never
 * carries the reference image.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { ToolContext, ToolDeclaration, ToolHandler, ToolHandlerOutcome } from './types';
import { google3DTilesHandlers } from './spatial-tools';
import {
    REFERENCE_IMAGE_MODEL,
    ReferenceObjectBuildError,
    buildObjectFromReference,
    buildObjectFromSpec,
    type ModelUse,
    type ObjectBuildChecks,
    type ObjectBuildPass,
    type ReferenceObjectBuildRequest,
    type ReferenceObjectBuildResult,
    type ReferenceObjectBuilderDeps,
    type MaterialProvenance,
    type SpecObjectBuildResult,
    type VisionModelUse
} from '../../3d-engine/reference-object-builder';
import { glbToTriangleSoup, glbToTriangleSoupAsync, glbWorldBounds, runInSlices, runToEnd, type GlbInstanceMode, type TriangleSoup } from '../../3d-engine/part-connectivity';
import type { ObjectBuildLive } from '../../../common/object-build-live';
import type { StageEvent } from '../../../common/spatial/staged-location-contracts';
import type { CanvasArtifact } from '../../../browser/generative-canvas/canvas-types';
import { implausibleLayerBounds } from '../../3d-engine/layer-bounds-guard';
import { errorMessage } from '../gemini-client';
import { materialModeOf, withStagedMaterialMode, type StagedMaterialModeFields } from '../../../browser/generative-canvas/primitives/scene3d/stagedBuild/texturedTwins';
import { OBJECT_BUILD_SOURCE, type BuiltObjectRecord, type ObjectBuildSpec, type Vec3 } from '../../../common/spatial/object-build-spec';

export const OBJECT_REFERENCE_TOOL_DECLARATIONS: ToolDeclaration[] = [
    {
        name: 'build_3d_object_from_reference',
        description: 'Build one specific object or an abstract form (a single prop, vehicle, creature, character, piece of furniture, sculpture or artifact) as native 3D geometry with a physical material on every part (colour, roughness, metalness, transmission, clearcoat, emission), or all in studio grey clay when the user asks for clay. ' +
            `It draws an internal reference picture with Nano Banana Lite (${REFERENCE_IMAGE_MODEL}; never shown or saved), reads it with the chat's model into a metric build spec of swept, revolved, replicated and relief parts with each part's material, builds that in the native Python engine, and checks that every part is built and attached and that the build's shape matches the reference (up to two revisions). The materials are read from a generated picture, so they are inferred, not measured (factor values only, no texture maps). ` +
            'It builds one object per call, not a place or a scene: for an imagined environment, a landscape or several objects with no real place, write a script for execute_3d_python_script; for a real place alone, use google_3d_tiles_get_clay. To stand the object at a real place, pass location and placement. ' +
            'Several objects at one real place take one call each with the same location and each its own placement: when the active scene is an object build staged at that location, the call reuses its tiles and adds the new object beside the objects already built there. When the active scene already shows the place (google_3d_tiles_get_clay staged it, or objects were built there) and the object belongs in that scene, pass addToActiveScene: true to add it there without staging the place again. ' +
            'The object must fit where it is placed: a spot under a tree crown or on another object fails before anything is built, and a build that would pass through a crown, a trunk, another object or a wall of the tiles fails with its spec and the nearest spots where it fits. ' +
            'To change an object it built (its shape, its size, or a base or plinth added as parts), pass specJson: the edited spec from that object\'s metadata.objectBuild.spec (or the result\'s data.objectBuild.spec). That spec is built exactly as given, with no new reference and no comparison; at a place, pass the same location, its placement (or a new one to move it) and replaceObjectId set to that object\'s id.',
        parameters: {
            type: 'OBJECT',
            properties: {
                request: {
                    type: 'STRING',
                    description: 'What to build, in the user\'s words plus any details from the conversation (parts, counts, proportions, style of form). With specJson: what the object is and the change being made.'
                },
                clay: {
                    type: 'BOOLEAN',
                    description: 'True only when the user asked for clay (grey, untextured, a blockout or a shape study): every part is studio clay, no materials are read and the scene shows clay. Omit it otherwise: the object gets its materials and the scene shows them, except that a clay view chosen on the active scene it is added to stays (staged_location_material_mode with mode "textured" shows the materials when the user asks for them).'
                },
                specJson: {
                    type: 'STRING',
                    description: 'Optional: a complete build spec as JSON text, normally an earlier object\'s spec with the user\'s change made to it. When given, no reference is drawn: the spec is built and checked as is, and the call fails with every problem listed if it cannot be.'
                },
                dimensionsHintMeters: {
                    type: 'ARRAY',
                    items: { type: 'NUMBER' },
                    description: 'Optional [width, height, depth] in metres when the user gave a size (new builds only; with specJson, set sizes in the spec).'
                },
                location: {
                    type: 'STRING',
                    description: 'Optional real-world place (name or address, or coordinates the user gave) to stage the object at. It is geocoded and returned as remeshed Google 3D Tiles in clay, or the tiles already staged in the active scene are reused (same location as its object builds, or addToActiveScene); omit it for a studio void. Requires placement.'
                },
                placement: {
                    type: 'OBJECT',
                    description: 'Required with location: where the object stands relative to the place\'s geocoded anchor and which way it faces, worked out from what the user said (for example in front of the entrance, facing the square). The anchor is often the middle of a building, so an object beside it needs an offset; 0 and 0 stands it at the anchor. The object rests on the ground of the staged tiles there (or a roof, when the spot is on one). A spot under a tree crown or on top of another object cannot hold it: the call then fails before anything is built, naming the nearest clear spots. Leave room for the object\'s whole footprint: one that would pass through a crown, a trunk, another object or a wall fails after its build, naming spots where it fits.',
                    properties: {
                        eastMeters: { type: 'NUMBER', description: 'Metres east of the anchor (negative for west).' },
                        northMeters: { type: 'NUMBER', description: 'Metres north of the anchor (negative for south).' },
                        headingDeg: { type: 'NUMBER', description: 'Compass heading the object\'s front faces, degrees clockwise from north (0 north, 90 east, 180 south, 270 west).' }
                    },
                    required: ['eastMeters', 'northMeters', 'headingDeg']
                },
                addToActiveScene: {
                    type: 'BOOLEAN',
                    description: 'With location: true when the object belongs in the active scene, which already shows that place (staged by google_3d_tiles_get_clay, or by earlier builds there). Its tiles, trees and objects are kept, nothing is staged again, and placement is relative to that scene\'s anchor. The call fails, without staging, if the active scene has no staged tiles to stand on.'
                },
                replaceObjectId: {
                    type: 'STRING',
                    description: 'With location only: the id of an object this tool built in the active scene, staged at the same location, that this build replaces (an edit or a swap). Omit it to add the object beside the ones already there.'
                }
            },
            required: ['request']
        }
    }
];

export interface ObjectReferenceToolDeps {
    build?: (input: ReferenceObjectBuildRequest, deps?: ReferenceObjectBuilderDeps) => Promise<ReferenceObjectBuildResult>;
    builder?: ReferenceObjectBuilderDeps;
    /** Stages at a place; defaults to the google_3d_tiles_get_clay handler. */
    stageAtLocation?: ToolHandler;
    /** Where the built GLB is published for the viewport (/models/...), and where staged /models/ files are read. */
    publicModelsDir?: string;
}

/**
 * Where the object stands in the staged scene (tile frame: x east, y up, z south; origin at the anchor's street
 * level). There is no lift above the surface: the viewport seats a non-zero spatial3d.y as an offset above the
 * ground when the ground model loads after the object, but leaves it as an absolute height when the object loads
 * last, so only y = 0 (rest on the surface) lands in the same place whatever the load order.
 */
export interface ObjectPlacement {
    eastMeters: number;
    northMeters: number;
    headingDeg: number;
    /** Scene position of the object's base. */
    sceneX: number;
    sceneZ: number;
    /** Rotation about +Y that turns the object's front (+Z) to the heading. */
    yawDeg: number;
    /** Height of the highest surface at that spot, which is a ground layer's: where the base rests. */
    surfaceYMeters: number;
    /** The staged ground layer that surface belongs to. */
    restsOn: { id: string; source?: string };
}

/** A spot near the requested one where the highest surface is ground, as a placement would give it. */
export interface ClearSpot {
    eastMeters: number;
    northMeters: number;
    /** Distance from the requested spot. */
    distanceMeters: number;
}

interface Staging {
    /** The staged scene; data.objects holds everything staged there, including objects built there earlier. */
    artifact: any;
    payload: Record<string, unknown>;
    /** True when the active scene's staging was reused. */
    reused: boolean;
}

/** A placement that cannot hold the object, with what the model needs to choose another. */
class PlacementError extends Error {
    constructor(message: string, readonly details: Record<string, unknown> = {}) {
        super(message);
        this.name = 'PlacementError';
    }
}

function repoRoot(): string {
    return process.env.SCRATCHBOX_ROOT || (fs.existsSync(path.resolve(process.cwd(), 'packages')) ? process.cwd() : path.resolve(process.cwd(), '..'));
}

function failed(message: string, details: Record<string, unknown> = {}): ToolHandlerOutcome {
    return {
        status: 'failed',
        summaryResult: `Failed: ${message}`,
        // The outcome fields come last so no detail (such as an HTTP status) can overwrite them.
        resultPayload: { ...details, status: 'failed', success: false, error: message }
    };
}

function parseDimensions(value: unknown): Vec3 | undefined | 'invalid' {
    if (value === undefined || value === null) return undefined;
    if (Array.isArray(value) && value.length === 3 && value.every(v => typeof v === 'number' && Number.isFinite(v) && v > 0)) {
        return [value[0], value[1], value[2]];
    }
    return 'invalid';
}

type PlacementArgs = Pick<ObjectPlacement, 'eastMeters' | 'northMeters' | 'headingDeg'>;
const PLACEMENT_KEYS = ['eastMeters', 'northMeters', 'headingDeg'];

function parsePlacement(value: unknown): PlacementArgs | undefined | string {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'object' || Array.isArray(value)) return 'placement must be an object {eastMeters, northMeters, headingDeg}.';
    const v = value as Record<string, unknown>;
    const unknownKeys = Object.keys(v).filter(k => !PLACEMENT_KEYS.includes(k));
    if (unknownKeys.length) {
        return `placement takes only eastMeters, northMeters and headingDeg (not ${unknownKeys.join(', ')}): the object always rests on the ground at that spot.`;
    }
    const num = (key: string) => typeof v[key] === 'number' && Number.isFinite(v[key] as number) ? v[key] as number : undefined;
    const east = num('eastMeters'), north = num('northMeters'), heading = num('headingDeg');
    if (east === undefined || north === undefined || heading === undefined) return 'placement needs eastMeters, northMeters and headingDeg as numbers.';
    if (Math.hypot(east, north) > 5000) return 'placement is more than 5 km from the anchor; give metres from the place, not coordinates.';
    return { eastMeters: east, northMeters: north, headingDeg: heading };
}

/** Rotation about +Y (degrees) that turns +Z, the object's front, toward a compass heading in the tile frame. */
export function yawForHeading(headingDeg: number): number {
    // Tile frame: +X east, -Z north. Front +Z rotated by yaw points to (sin yaw, cos yaw) in (x, z).
    const yaw = 180 - headingDeg;
    return +(((yaw % 360) + 540) % 360 - 180).toFixed(6);
}

/** The model that answered; when the API names a different version than the one requested, both are given. */
function describeImageModel(use: ModelUse): string {
    if (use.fallbackReason) return `${use.answered} (${use.fallbackReason})`;
    if (use.requested === 'scratchbox-studio/style-dna') return use.answered;
    return use.answered === use.requested ? use.requested : `${use.requested} (the API reports ${use.answered} answered)`;
}

function describeVisionModel(use: VisionModelUse): string {
    const version = use.answered !== use.used ? ` (the API reports ${use.answered})` : '';
    const origin = use.source === 'chat-default' ? 'the chat\'s default model' : 'the chat\'s model';
    if (use.used === use.requested) return `${use.used}${version}, ${origin}`;
    const why = use.skipped.map(s => `${s.model}: ${s.reason}`).join('; ');
    return `${use.used}${version} instead of ${origin} ${use.requested}, which is not served (${why})`;
}

/** Camera that frames an object of `bounds` standing at `base`, from a three-quarter view of its front. */
function frameCamera(bounds: Vec3, base: Vec3, yawDeg: number): { position: Vec3; target: Vec3; fov: number } {
    const fov = 45;
    const radius = Math.max(0.05, Math.hypot(bounds[0], bounds[1], bounds[2]) / 2);
    const distance = (radius / Math.sin((fov * Math.PI) / 360)) * 1.3;
    const target: Vec3 = [base[0], base[1] + bounds[1] / 2, base[2]];
    // The object's front is +Z turned by yaw; look at it from 35 degrees to its right and 22 degrees above.
    const az = ((yawDeg + 35) * Math.PI) / 180, el = (22 * Math.PI) / 180;
    const position: Vec3 = [
        target[0] + distance * Math.cos(el) * Math.sin(az),
        target[1] + distance * Math.sin(el),
        target[2] + distance * Math.cos(el) * Math.cos(az)
    ];
    return { position: position.map(v => +v.toFixed(3)) as Vec3, target: target.map(v => +v.toFixed(3)) as Vec3, fov };
}

/**
 * Shows a studio object build while it runs (common/object-build-live.ts): the internal reference as soon as it is
 * drawn, then each pass's own native build, published like the finished one, while that pass is checked. Every view is
 * one 3D-scene artifact with the id the finished build then takes, so the canvas updates one scene in place. Without
 * emitStage (no live chat turn) it does nothing.
 */
export class ObjectBuildLiveView {
    readonly artifactId = `artifact-3d-${Date.now()}`;
    private readonly startedAtMs = Date.now();
    private readonly runId = `object-build-${this.startedAtMs}`;
    private seq = 0;
    private referenceUri?: string;

    constructor(private readonly ctx: Pick<ToolContext, 'emitStage'>, private readonly title: string, private readonly modelsDir: string, private readonly clay: boolean) {}

    reference(image: { data: Buffer; mimeType: string }): void {
        if (!this.ctx.emitStage) return;
        // inline, never on disk: the live scene carries it only until the finished scene (same id) replaces it
        this.referenceUri = `data:${image.mimeType};base64,${image.data.toString('base64')}`;
        this.emit({ status: 'reference', message: 'Reference drawn (generated); reading it into a build spec' });
    }

    passBuilt(pass: { pass: number; glb: Buffer; glbPath: string }): void {
        if (!this.ctx.emitStage) return;
        const fileName = path.basename(pass.glbPath);
        fs.mkdirSync(this.modelsDir, { recursive: true });
        fs.writeFileSync(path.join(this.modelsDir, fileName), pass.glb);
        const b = glbWorldBounds(pass.glb);
        const size: Vec3 = b ? [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]] : [1, 1, 1];
        this.emit({ status: 'checking', pass: pass.pass, message: pass.pass === 1 ? 'First build from the reference; checking it' : `Pass ${pass.pass} built; checking it against the reference` }, { uri: `/models/${fileName}`, size });
    }

    /**
     * The build ended without a result (failed or stopped) after the live view showed something: the scene keeps the
     * last pass it showed, or none, with the reason and without the live overlay or the reference, so nothing is left
     * spinning or holding the reference.
     */
    end(reason: string): void {
        if (!this.ctx.emitStage || this.seq === 0) return;
        this.referenceUri = undefined;
        this.emit({ status: 'checking', message: reason }, this.lastModel, 'failed');
    }

    private lastModel?: { uri: string; size: Vec3; pass?: number };

    private emit(live: Omit<ObjectBuildLive, 'startedAtMs' | 'referenceUri'>, model?: { uri: string; size: Vec3; pass?: number }, ended?: 'failed'): void {
        const now = Date.now();
        if (model && !ended) this.lastModel = { ...model, pass: live.pass };
        const objectBuildLive: ObjectBuildLive = { ...live, startedAtMs: this.startedAtMs, ...(this.referenceUri ? { referenceUri: this.referenceUri } : {}) };
        const stage: StageEvent = {
            schema: 'scratchbox.stage-event/2', runId: this.runId, seq: ++this.seq, stage: 'object-build', order: 0, status: ended ?? 'running',
            title: live.message, source: 'build_3d_object_from_reference', degradations: [], timings: { startedAtMs: this.startedAtMs, cached: false, ms: now - this.startedAtMs, ...(ended ? { endedAtMs: now } : {}) }
        };
        const pass = model?.pass ?? live.pass;
        const objects = model ? [{
            id: `live-pass-${pass}`,
            content: { type: '3d-model', durableUri: model.uri, mimeType: 'model/gltf-binary', metadata: { role: 'hero', description: ended ? `${this.title} (pass ${pass}; the build did not finish)` : `${this.title} (pass ${pass}, being checked)`, source: OBJECT_BUILD_SOURCE, metricScale: 1.0, groundSnapped: true } },
            space: { spatial3d: { x: 0, y: 0, z: 0 } },
            time: { startMs: 0, durationMs: 20000 },
            lineage: { version: 1 }
        }] : [];
        const artifact = {
            id: this.artifactId,
            type: '3d-scene',
            title: this.title,
            summary: live.message,
            version: 1,
            data: {
                title: this.title,
                subtitle: live.message,
                worldBranch: 'procedural/object-from-reference',
                sceneType: 'custom',
                renderMode: this.clay ? 'clay' : 'pbr',
                ...(this.clay ? { clayPreset: 'studio-grey' } : {}),
                cameraMode: 'orbit',
                ...(model ? { camera: frameCamera(model.size, [0, 0, 0], 0) } : {}),
                environment: { skybox: 'studio', lighting: 'studio', ground: false },
                objects,
                ...(ended ? {} : { objectBuildLive })
            }
        } as unknown as CanvasArtifact;
        this.ctx.emitStage!(stage, artifact);
    }
}

/**
 * Stages first so an unknown place fails before any model is called. The staging outcome must be a mounted clay
 * scene; a failed, unremeshed or artifact-less result fails the call.
 */
async function stage(location: string, ctx: ToolContext, handler: ToolHandler): Promise<Staging> {
    ctx.reportProgress?.(`Staging at ${location}`);
    let outcome: ToolHandlerOutcome;
    try {
        outcome = await handler({ query: location }, ctx);
    } catch (err) {
        throw new Error(`Staging at "${location}" failed: ${errorMessage(err)}`);
    }
    const payload = outcome.resultPayload || {};
    if (outcome.status === 'failed' || payload.success === false) {
        throw new Error(`Staging at "${location}" failed: ${String(payload.error || outcome.summaryResult || 'google_3d_tiles_get_clay reported a failure')}`);
    }
    const remesh = payload.remesh as { ok?: boolean; error?: string } | undefined;
    if (remesh && remesh.ok === false) {
        throw new Error(`Staging at "${location}" failed: the tiles were not remeshed (${remesh.error || 'no reason given'})`);
    }
    if (!payload.artifact || typeof payload.artifact !== 'object') {
        throw new Error(`Staging at "${location}" failed: google_3d_tiles_get_clay returned no scene to stage on`);
    }
    return { artifact: payload.artifact, payload, reused: false };
}

const glbUriOf = (o: any): string => String(o?.content?.durableUri || '').replace(/\?.*$/, '');
const isGlbUri = (uri: string) => /\.glb$/i.test(uri);
const objectsOf = (artifact: any): any[] => Array.isArray(artifact?.data?.objects) ? artifact.data.objects : [];

/**
 * A staged layer the object can stand on: the tiles, which google_3d_tiles_get_clay marks isGround (their roofs
 * included). Everything else staged with them is not ground, whatever its role: the trees rebuilt in the tiles (role
 * 'environment', layer 'vegetation'), and the objects built there.
 */
function isGroundLayer(o: any): boolean {
    return o?.content?.metadata?.isGround === true;
}

/** An object this tool built. */
function isBuiltObject(o: any): boolean {
    return o?.content?.metadata?.source === OBJECT_BUILD_SOURCE;
}

function describeLayer(o: any): string {
    const meta = o?.content?.metadata || {};
    if (isBuiltObject(o)) return `"${meta.description || o.id}" (${o.id}), an object built there earlier`;
    const kind = typeof meta.layer === 'string' ? meta.layer : typeof meta.role === 'string' ? meta.role : 'staged';
    return `the ${kind} layer ${o.id}${typeof meta.source === 'string' ? ` (${meta.source})` : ''}`;
}

/** Local file behind a served /models/... URI, or undefined when it cannot be found or the URI is malformed. */
function modelFile(uri: string, modelsDirs: string[]): string | undefined {
    const match = /^\/models\/(.+)$/.exec(uri);
    if (!match) return fs.existsSync(uri) ? uri : undefined;
    let rel: string;
    try {
        rel = decodeURIComponent(match[1]);
    } catch {
        return undefined;
    }
    for (const dir of modelsDirs) {
        const file = path.resolve(dir, rel);
        if (file.startsWith(path.resolve(dir) + path.sep) && fs.existsSync(file)) return file;
    }
    return undefined;
}

/**
 * The active scene's staging, reused (no new geocode or extraction) when the active scene is an object build staged at
 * this same location query, or when the call says the object goes into the active scene (addToActiveScene: the place
 * google_3d_tiles_get_clay staged there, or an earlier build at a place given in other words), and every staged model
 * is still on disk. The new object then stands on the same tiles, beside the trees and objects there. Otherwise the
 * reason it cannot be reused, and, when the scene was meant to be reused, the objects built there (which a fresh
 * staging does not carry over).
 */
function stagingFromActiveScene(ctx: ToolContext, location: string, modelsDirs: string[], addToActiveScene: boolean): { staging?: Staging; reason: string; leftBehind?: any[]; otherLocation?: string } {
    const active = ctx.request?.activeArtifact as { type?: string; data?: any } | undefined;
    if (active?.type !== '3d-scene') return { reason: 'the active canvas artifact is not a 3D scene' };
    const data = active.data || {};
    const where = data.objectBuild?.location;
    if (!addToActiveScene) {
        if (!where) return { reason: `the active scene is not an object build staged at "${location}" (and addToActiveScene was not set)` };
        if (where.query !== location) {
            return { reason: `the active scene is an object build staged at "${where.query}", not at "${location}"`, ...(typeof where.query === 'string' ? { otherLocation: where.query } : {}) };
        }
    }
    const objects: any[] = Array.isArray(data.objects) ? data.objects : [];
    const leftBehind = objects.filter(isBuiltObject);
    const ground = objects.find(isGroundLayer);
    if (!ground) return { reason: 'the active scene has no staged ground layer (tiles marked isGround) to stand on', leftBehind };
    const unreadable = objects.map(glbUriOf).filter(isGlbUri).find((uri: string) => !modelFile(uri, modelsDirs));
    if (unreadable) return { reason: `the staged model ${unreadable} can no longer be read`, leftBehind };
    const groundMeta = ground.content?.metadata || {};
    const resolvedAddress = where?.resolvedAddress ?? (typeof groundMeta.resolvedAddress === 'string' ? groundMeta.resolvedAddress : undefined);
    return {
        staging: { artifact: active, payload: { resolvedAddress, geoAnchor: where?.geoAnchor ?? data.geoAnchor }, reused: true },
        reason: ''
    };
}

/**
 * What the staged tiles are: remeshed when the staging result said so (`remeshed`) or their ground layer records it,
 * and in photo texture when that layer came from google_3d_tiles_get_full_texture.
 */
function describeStagedTiles(objects: any[], remeshed?: boolean): string {
    const meta = objects.find(isGroundLayer)?.content?.metadata || {};
    const isRemeshed = remeshed ?? (typeof meta.remeshed === 'boolean' ? meta.remeshed : undefined);
    const look = meta.source === 'Google3DTilesFullTexture' ? 'in photo texture' : 'in clay';
    return isRemeshed === true ? `remeshed Google 3D Tiles ${look}` : isRemeshed === false ? `Google 3D Tiles ${look} (not remeshed)` : `Google 3D Tiles ${look}`;
}

/** Where a staged model stands: its spatial3d, with a built object's lowest point on the surface it was seated on. */
function placedAt(o: any): SamplerPlace {
    const s = o?.space?.spatial3d || {};
    const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v) ? v : 0;
    const seated = o?.content?.metadata?.objectBuild?.placement?.surfaceYMeters;
    const built = isBuiltObject(o) && typeof seated === 'number';
    return { x: num(s.x), y: built ? seated : num(s.y), z: num(s.z), yawDeg: num(s.yaw), ...(built ? { seatBase: true } : {}) };
}

/** Where a staged model stands: turned by yawDeg about +Y (as Three.js rotation.y), then moved by (x, y, z). */
export interface SamplerPlace {
    x: number;
    y: number;
    z: number;
    yawDeg: number;
    /** Lift the model so its lowest point is at y, as the viewport seats a hero on the surface by its bounds. */
    seatBase?: boolean;
}

/** Triangles binned per yield point while a sampler is built. */
const TRIANGLES_PER_YIELD = 16_384;

/**
 * Heights of a triangle soup's surfaces by vertical ray, as the viewport's ground seating casts them: the highest
 * triangle straight above or below a point (walls, seen edge-on, are never hit), or the lowest and highest together.
 * Triangles are binned on a grid in x and z once, so a model of a million triangles answers many points quickly.
 */
export class SurfaceSampler {
    private constructor(
        private readonly p: Float32Array,
        private readonly idx: Uint32Array,
        private readonly minX: number,
        private readonly minZ: number,
        private readonly cell: number,
        private readonly nx: number,
        private readonly nz: number,
        private readonly start: Uint32Array,
        private readonly tris: Uint32Array,
        /** Extent of the placed model in x and z, and in height. */
        readonly bounds: { minX: number; maxX: number; minZ: number; maxZ: number; minY: number; maxY: number }
    ) {}

    /** Memory the sampler holds, in bytes. */
    get byteSize(): number {
        return this.p.byteLength + this.idx.byteLength + this.start.byteLength + this.tris.byteLength;
    }

    /** Builds a sampler in steps, yielding about every TRIANGLES_PER_YIELD triangles. */
    private static *steps(soup: TriangleSoup, place: SamplerPlace): Generator<void, SurfaceSampler, void> {
        const yaw = (place.yawDeg * Math.PI) / 180, c = Math.cos(yaw), s = Math.sin(yaw);
        let lift = place.y;
        if (place.seatBase) {
            let minY = Infinity;
            for (let i = 1; i < soup.positions.length; i += 3) minY = Math.min(minY, soup.positions[i]);
            if (Number.isFinite(minY)) lift -= minY;
        }
        const p = new Float32Array(soup.positions.length);
        let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, minY = Infinity, maxY = -Infinity;
        for (let i = 0; i < p.length; i += 3) {
            const x = soup.positions[i], y = soup.positions[i + 1], z = soup.positions[i + 2];
            p[i] = c * x + s * z + place.x;
            p[i + 1] = y + lift;
            p[i + 2] = -s * x + c * z + place.z;
            minX = Math.min(minX, p[i]); maxX = Math.max(maxX, p[i]);
            minZ = Math.min(minZ, p[i + 2]); maxZ = Math.max(maxZ, p[i + 2]);
            minY = Math.min(minY, p[i + 1]); maxY = Math.max(maxY, p[i + 1]);
            if (i % (TRIANGLES_PER_YIELD * 3) === 0) yield;
        }
        const triCount = soup.indices.length / 3;
        if (triCount === 0) return new SurfaceSampler(p, soup.indices, 0, 0, 1, 0, 0, new Uint32Array(1), new Uint32Array(0), { minX: 0, maxX: 0, minZ: 0, maxZ: 0, minY: 0, maxY: 0 });
        const n = Math.min(256, Math.max(1, Math.ceil(Math.sqrt(triCount / 2))));
        const cell = Math.max(maxX - minX, maxZ - minZ, 1e-6) / n;
        const nx = Math.max(1, Math.ceil((maxX - minX) / cell) + 1), nz = Math.max(1, Math.ceil((maxZ - minZ) / cell) + 1);
        const range = (t: number): [number, number, number, number] => {
            const a = soup.indices[t * 3] * 3, b = soup.indices[t * 3 + 1] * 3, d = soup.indices[t * 3 + 2] * 3;
            const cx = (v: number) => Math.min(nx - 1, Math.max(0, Math.floor((v - minX) / cell)));
            const cz = (v: number) => Math.min(nz - 1, Math.max(0, Math.floor((v - minZ) / cell)));
            return [cx(Math.min(p[a], p[b], p[d])), cx(Math.max(p[a], p[b], p[d])), cz(Math.min(p[a + 2], p[b + 2], p[d + 2])), cz(Math.max(p[a + 2], p[b + 2], p[d + 2]))];
        };
        const counts = new Uint32Array(nx * nz + 1);
        for (let t = 0; t < triCount; t++) {
            const [x0, x1, z0, z1] = range(t);
            for (let j = z0; j <= z1; j++) for (let i = x0; i <= x1; i++) counts[j * nx + i + 1]++;
            if (t % TRIANGLES_PER_YIELD === TRIANGLES_PER_YIELD - 1) yield;
        }
        for (let k = 1; k < counts.length; k++) counts[k] += counts[k - 1];
        const start = counts.slice();
        const fill = counts.slice(0, nx * nz);
        const tris = new Uint32Array(start[nx * nz]);
        for (let t = 0; t < triCount; t++) {
            const [x0, x1, z0, z1] = range(t);
            for (let j = z0; j <= z1; j++) for (let i = x0; i <= x1; i++) tris[fill[j * nx + i]++] = t;
            if (t % TRIANGLES_PER_YIELD === TRIANGLES_PER_YIELD - 1) yield;
        }
        return new SurfaceSampler(p, soup.indices, minX, minZ, cell, nx, nz, start, tris, { minX, maxX, minZ, maxZ, minY, maxY });
    }

    /** The soup placed as `place` says. */
    static fromSoup(soup: TriangleSoup, place: SamplerPlace = { x: 0, y: 0, z: 0, yawDeg: 0 }): SurfaceSampler {
        return runToEnd(SurfaceSampler.steps(soup, place));
    }

    /** The same, built in slices of about 20 ms so a large model does not hold up the event loop. */
    static fromSoupAsync(soup: TriangleSoup, place: SamplerPlace, options: { signal?: AbortSignal; abortError?: () => Error } = {}): Promise<SurfaceSampler> {
        return runInSlices(SurfaceSampler.steps(soup, place), options);
    }

    static fromGlb(glb: Buffer, place?: SamplerPlace): SurfaceSampler | undefined {
        const soup = glbToTriangleSoup(glb, { colors: false });
        return soup ? SurfaceSampler.fromSoup(soup, place) : undefined;
    }

    /** Reads and bins the GLB in slices; `instances` as glbToTriangleSoup takes it. */
    static async fromGlbAsync(glb: Buffer, place: SamplerPlace, options: { signal?: AbortSignal; abortError?: () => Error; instances?: GlbInstanceMode } = {}): Promise<SurfaceSampler | undefined> {
        const soup = await glbToTriangleSoupAsync(glb, { colors: false, ...options });
        return soup ? SurfaceSampler.fromSoupAsync(soup, place, options) : undefined;
    }

    /** Height of the highest triangle straight above or below (x, z), or undefined when none covers it. */
    heightAt(x: number, z: number): number | undefined {
        return this.extentAt(x, z)?.high;
    }

    /** Heights of the lowest and highest triangles straight above or below (x, z), or undefined when none covers it. */
    extentAt(x: number, z: number): { low: number; high: number } | undefined {
        const i = Math.floor((x - this.minX) / this.cell), j = Math.floor((z - this.minZ) / this.cell);
        if (this.nx === 0 || i < 0 || j < 0 || i >= this.nx || j >= this.nz) return undefined;
        const p = this.p, idx = this.idx;
        let low: number | undefined, high: number | undefined;
        for (let k = this.start[j * this.nx + i]; k < this.start[j * this.nx + i + 1]; k++) {
            const t = this.tris[k] * 3;
            const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
            const ax = p[a], az = p[a + 2], bx = p[b], bz = p[b + 2], cx = p[c], cz = p[c + 2];
            if (x < Math.min(ax, bx, cx) || x > Math.max(ax, bx, cx) || z < Math.min(az, bz, cz) || z > Math.max(az, bz, cz)) continue;
            const det = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
            if (Math.abs(det) < 1e-12) continue;
            const l1 = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / det;
            const l2 = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / det;
            const l3 = 1 - l1 - l2;
            if (l1 < -1e-9 || l2 < -1e-9 || l3 < -1e-9) continue;
            const y = l1 * p[a + 1] + l2 * p[b + 1] + l3 * p[c + 1];
            if (high === undefined || y > high) high = y;
            if (low === undefined || y < low) low = y;
        }
        return high === undefined || low === undefined ? undefined : { low, high };
    }
}

/** Height of the highest triangle of a GLB straight above or below (x, z), or undefined when none covers it. */
export function surfaceHeightAt(glb: Buffer, x: number, z: number): number | undefined {
    return SurfaceSampler.fromGlb(glb)?.heightAt(x, z);
}

/** Below this, a non-ground surface counts as level with the ground under it. */
const LEVEL_TOLERANCE_METERS = 0.01;

/** Every staged model, read once, with whether it is ground. */
interface StagedSurface { object: any; ground: boolean; sampler: SurfaceSampler }

/** Stops placement work when the call is stopped. */
class PlacementStoppedError extends Error {
    constructor() {
        super('Stopped by the user.');
        this.name = 'PlacementStoppedError';
    }
}

/**
 * Samplers of staged models read earlier, by file, modification time, size and placement, least recently used first:
 * every object added at a place reads the same tiles, trees and earlier objects. Kept within a memory budget.
 */
const SAMPLER_CACHE_BYTES = 384 * 1024 * 1024;
const samplerCache = new Map<string, SurfaceSampler>();

async function cachedSampler(file: string, place: SamplerPlace, signal: AbortSignal | undefined, instances: GlbInstanceMode): Promise<SurfaceSampler | undefined> {
    const stat = await fs.promises.stat(file);
    const key = JSON.stringify([path.resolve(file), stat.mtimeMs, stat.size, place.x, place.y, place.z, place.yawDeg, !!place.seatBase, instances]);
    const hit = samplerCache.get(key);
    if (hit) {
        samplerCache.delete(key);
        samplerCache.set(key, hit);
        return hit;
    }
    const sampler = await SurfaceSampler.fromGlbAsync(await fs.promises.readFile(file), place, { signal, abortError: () => new PlacementStoppedError(), instances });
    if (!sampler) return undefined;
    samplerCache.set(key, sampler);
    let bytes = [...samplerCache.values()].reduce((n, s) => n + s.byteSize, 0);
    for (const [k, s] of samplerCache) {
        if (bytes <= SAMPLER_CACHE_BYTES || k === key) break;
        samplerCache.delete(k);
        bytes -= s.byteSize;
    }
    return sampler;
}

/**
 * A layer the viewport draws where its spatial3d puts it, without seating it: the tiles and anything else marked as
 * environment (the rebuilt trees, vector worlds), as Scene3DPrimitive's isEnvironmentDef tells them apart.
 */
function isEnvironmentLayer(o: any): boolean {
    const meta = o?.content?.metadata || {};
    const source = String(meta.source || '').toLowerCase();
    return meta.role === 'environment' || meta.isGround === true || source.includes('google3dtiles') || source.includes('googlevectortile');
}

/** A built object this tool placed: its recorded seat is where the viewport stands it. */
function hasRecordedSeat(o: any): boolean {
    return isBuiltObject(o) && typeof o?.content?.metadata?.objectBuild?.placement?.surfaceYMeters === 'number';
}

/**
 * Reads every staged GLB model (from the cache when unchanged), in slices so the event loop keeps running. Each model
 * stands where the viewport draws it: environment layers at their spatial3d; a built object on its recorded seat; and
 * any other model (an object built in a studio void and then staged, a script's hero) the way the viewport seats it,
 * its lowest point on the highest surface under its origin (raised by a non-zero spatial3d.y), not at its raw height.
 */
async function loadSurfaces(objects: any[], modelsDirs: string[], signal: AbortSignal | undefined): Promise<StagedSurface[]> {
    const models = objects.filter(o => isGlbUri(glbUriOf(o)));
    const byObject = new Map<any, StagedSurface>();
    const load = async (o: any, place: SamplerPlace): Promise<StagedSurface> => {
        if (signal?.aborted) throw new PlacementStoppedError();
        const file = modelFile(glbUriOf(o), modelsDirs);
        if (!file) throw new PlacementError(`could not read the staged model ${glbUriOf(o)} to place the object (looked in ${modelsDirs.join(', ')})`);
        // a trees layer's instanced leaf clusters lie inside its far level's crown masses, which are read; expanding every
        // leaf of a district would take millions of triangles for no change in what covers a spot
        const sampler = await cachedSampler(file, place, signal, o?.content?.metadata?.vegetation === true ? 'skip' : 'expand');
        if (!sampler) throw new PlacementError(`the staged model ${glbUriOf(o)} is not a readable GLB`);
        // a layer no real place can have would otherwise read as covering every spot (or none): refuse it, saying why
        const b = sampler.bounds;
        const impossible = implausibleLayerBounds({ min: [b.minX, b.minY, b.minZ], max: [b.maxX, b.maxY, b.maxZ] });
        if (impossible) {
            throw new PlacementError(`${describeLayer(o)} cannot be placed against: ${impossible}, so it is broken and was not used. Stage the place again to rebuild it` +
                `${o?.content?.metadata?.vegetation === true ? ', or stage it with trees: false' : ''}.`);
        }
        return { object: o, ground: isGroundLayer(o), sampler };
    };
    const seatedByViewport = (o: any) => !isEnvironmentLayer(o) && !hasRecordedSeat(o);
    for (const o of models.filter(o => !seatedByViewport(o))) byObject.set(o, await load(o, placedAt(o)));
    const fixed = [...byObject.values()];
    for (const o of models.filter(seatedByViewport)) {
        const s = o?.space?.spatial3d || {};
        const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v) ? v : 0;
        const x = num(s.x), z = num(s.z);
        let top: number | undefined;
        for (const layer of fixed) {
            const y = layer.sampler.heightAt(x, z);
            if (y !== undefined && (top === undefined || y > top)) top = y;
        }
        // Nothing under it: the viewport leaves it where its spatial3d puts it.
        const place: SamplerPlace = top === undefined ? placedAt(o) : { x, y: top + num(s.y), z, yawDeg: num(s.yaw), seatBase: true };
        byObject.set(o, await load(o, place));
    }
    return models.map(o => byObject.get(o)!);
}

/** What the viewport would seat an object on at (x, z): the ground under it, and any other layer above that ground. */
function surfaceAt(surfaces: StagedSurface[], x: number, z: number): { groundY?: number; ground?: StagedSurface; cover?: { surface: StagedSurface; topY: number } } {
    let groundY: number | undefined, ground: StagedSurface | undefined;
    for (const s of surfaces.filter(s => s.ground)) {
        const y = s.sampler.heightAt(x, z);
        if (y !== undefined && (groundY === undefined || y > groundY)) { groundY = y; ground = s; }
    }
    if (groundY === undefined) return {};
    let cover: { surface: StagedSurface; topY: number } | undefined;
    for (const s of surfaces.filter(s => !s.ground)) {
        const y = s.sampler.heightAt(x, z);
        if (y !== undefined && y > groundY + LEVEL_TOLERANCE_METERS && (!cover || y > cover.topY)) cover = { surface: s, topY: y };
    }
    return { groundY, ground, cover };
}

/**
 * A spot whose centre the viewport would seat an object on ground at the requested spot's level: ground there within
 * half a metre of `groundY` (so a street spot is not offered a roof), and nothing else staged above it.
 */
function centreClear(surfaces: StagedSurface[], x: number, z: number, groundY: number): number | undefined {
    const at = surfaceAt(surfaces, x, z);
    return at.groundY !== undefined && Math.abs(at.groundY - groundY) <= 0.5 && !at.cover ? at.groundY : undefined;
}

/**
 * Up to three spots nearest (x, z), in different directions, that `fits` accepts, as placements (metres east and north
 * of the anchor), searched in rings 1 m apart out to `maxRadiusMeters`.
 */
function* nearestSpots(x: number, z: number, fits: (px: number, pz: number) => Generator<void, boolean, void>, maxRadiusMeters = 40): Generator<void, ClearSpot[], void> {
    const spots: Array<ClearSpot & { angle: number }> = [];
    for (let r = 1; r <= maxRadiusMeters && spots.length < 3; r += 1) {
        for (let k = 0; k < 16 && spots.length < 3; k++) {
            const angle = (k * 2 * Math.PI) / 16;
            const px = x + r * Math.sin(angle), pz = z - r * Math.cos(angle);
            const apart = spots.every(s => Math.abs(((angle - s.angle + 3 * Math.PI) % (2 * Math.PI)) - Math.PI) >= Math.PI / 3);
            if (!apart || !(yield* fits(px, pz))) continue;
            spots.push({ eastMeters: +px.toFixed(1), northMeters: +(-pz).toFixed(1), distanceMeters: r, angle });
        }
        yield;
    }
    return spots.map(({ angle: _angle, ...spot }) => spot);
}

/**
 * Before the object is built (its footprint is not known yet): spots whose centre and four points 0.75 m around it
 * are clear ground at the level of the ground at (x, z).
 */
function clearSpotsNear(surfaces: StagedSurface[], x: number, z: number, groundY: number): ClearSpot[] {
    return runToEnd(nearestSpots(x, z, function* (px, pz) {
        return [[0, 0], [0.75, 0], [-0.75, 0], [0, 0.75], [0, -0.75]].every(([dx, dz]) => centreClear(surfaces, px + dx, pz + dz, groundY) !== undefined);
    }));
}

const describeSpots = (spots: ClearSpot[]) => spots.length
    ? `the nearest clear spots are ${spots.map(s => `${s.eastMeters} m east, ${s.northMeters} m north (${s.distanceMeters} m away)`).join('; ')}`
    : 'there is no clear spot at that ground level within 40 m';

/**
 * Where the object stands on the staged tiles. The viewport seats it on the highest surface under its base, so that
 * surface must be ground: a spot off the tiles, or under a tree crown or another object, fails with what covers it
 * and the nearest clear spots.
 */
function placeOnStagedTiles(surfaces: StagedSurface[], args: PlacementArgs): ObjectPlacement {
    const sceneX = args.eastMeters, sceneZ = -args.northMeters;
    if (!surfaces.some(s => s.ground)) throw new PlacementError('the staged scene has no ground model (a layer staged as ground) to place the object on');
    const at = surfaceAt(surfaces, sceneX, sceneZ);
    if (at.groundY === undefined || !at.ground) {
        throw new PlacementError(`placement ${args.eastMeters} m east, ${args.northMeters} m north of the anchor is outside the staged tiles, so there is nothing to stand on there`);
    }
    if (at.cover) {
        const spots = clearSpotsNear(surfaces, sceneX, sceneZ, at.groundY);
        const covering = at.cover.surface.object;
        throw new PlacementError(
            `At ${args.eastMeters} m east, ${args.northMeters} m north of the anchor the highest surface is ${describeLayer(covering)}, ${+at.cover.topY.toFixed(2)} m up, above the ground there at ${+at.groundY.toFixed(2)} m. ` +
            `The viewport stands an object on the highest surface under it, so the object would be drawn on top of that, not on the ground. Choose a placement clear of it: ${describeSpots(spots)}.` +
            (isBuiltObject(covering) ? ` To replace that object instead, pass replaceObjectId "${covering.id}".` : ''),
            { coveredBy: { id: String(covering.id), topYMeters: +at.cover.topY.toFixed(3) }, groundYMeters: +at.groundY.toFixed(3), clearSpots: spots }
        );
    }
    const meta = at.ground.object?.content?.metadata || {};
    return {
        ...args, sceneX, sceneZ, yawDeg: yawForHeading(args.headingDeg), surfaceYMeters: +at.groundY.toFixed(3),
        restsOn: { id: String(at.ground.object.id), ...(typeof meta.source === 'string' ? { source: meta.source } : {}) }
    };
}

/**
 * The built object's footprint, turned to its heading: points on a grid over its extent in x and z (relative to its
 * base centre) where a vertical line meets it, with the heights of its lowest and highest surface there above its
 * base. Sampled every `spacingMeters` (at most `maxPerAxis` points across), so parts thinner than that can fall
 * between samples.
 */
interface Footprint {
    samples: Array<{ dx: number; dz: number; low: number; high: number }>;
    spacingMeters: number;
    /** Farthest sample from the base centre. */
    radiusMeters: number;
}

function* footprintSteps(object: SurfaceSampler, maxPerAxis: number): Generator<void, Footprint, void> {
    const { minX, maxX, minZ, maxZ } = object.bounds;
    const spacing = Math.max(0.02, Math.max(maxX - minX, maxZ - minZ) / (maxPerAxis - 1));
    const samples: Footprint['samples'] = [];
    let radius = 0;
    for (let x = minX; x <= maxX + 1e-9; x += spacing) {
        for (let z = minZ; z <= maxZ + 1e-9; z += spacing) {
            const e = object.extentAt(x, z);
            if (!e) continue;
            samples.push({ dx: x, dz: z, low: e.low, high: e.high });
            radius = Math.max(radius, Math.hypot(x, z));
        }
        yield;
    }
    return { samples, spacingMeters: spacing, radiusMeters: radius };
}

/** Two bodies closer than this in height count as touching, not intersecting. */
const CONTACT_TOLERANCE_METERS = 0.02;
/** Ground under the footprint may rise this much above the object's underside before it counts as a wall or step into it... */
const GROUND_RISE_FLOOR_METERS = 0.3;
/** ...or this much per metre from the base centre (a slope of about 27 degrees), whichever is more. */
const GROUND_RISE_PER_METER = 0.5;

/** A staged layer the placed object would pass through. */
interface Intersection {
    surface: StagedSurface;
    /**
     * Deepest vertical overlap found between the object and the layer; for a ground layer, how far the ground rises
     * above the object's underside there.
     */
    depthMeters: number;
    /** Scene position of that sample. */
    x: number;
    z: number;
}

/**
 * The staged layers the object would pass through if its base centre stood at (cx, baseY, cz): every other layer
 * (tree crowns and trunks, objects built there earlier) whose vertical extent overlaps the object's at a footprint
 * sample, and the ground layers where the ground under the footprint rises into the object by more than a slope or a
 * kerb would (a wall, a building, a parked car in the tiles). With `firstOnly`, stops at the first one found.
 */
function* intersectionsAt(footprint: Footprint, cx: number, cz: number, baseY: number, surfaces: StagedSurface[], firstOnly: boolean): Generator<void, Intersection[], void> {
    const found = new Map<StagedSurface, Intersection>();
    const note = (surface: StagedSurface, depth: number, x: number, z: number) => {
        const known = found.get(surface);
        if (!known || depth > known.depthMeters) found.set(surface, { surface, depthMeters: depth, x, z });
    };
    const others = surfaces.filter(s => !s.ground), grounds = surfaces.filter(s => s.ground);
    let n = 0;
    for (const sample of footprint.samples) {
        const x = cx + sample.dx, z = cz + sample.dz;
        const low = baseY + sample.low, high = baseY + sample.high;
        for (const s of others) {
            const e = s.sampler.extentAt(x, z);
            if (e && e.low < high - CONTACT_TOLERANCE_METERS && low < e.high - CONTACT_TOLERANCE_METERS) note(s, Math.min(high, e.high) - Math.max(low, e.low), x, z);
        }
        let groundY: number | undefined, ground: StagedSurface | undefined;
        for (const s of grounds) {
            const y = s.sampler.heightAt(x, z);
            if (y !== undefined && (groundY === undefined || y > groundY)) { groundY = y; ground = s; }
        }
        const allowed = Math.max(GROUND_RISE_FLOOR_METERS, GROUND_RISE_PER_METER * Math.hypot(sample.dx, sample.dz));
        if (ground && groundY !== undefined && groundY - low > allowed) note(ground, groundY - low, x, z);
        if (firstOnly && found.size) break;
        if (++n % 256 === 0) yield;
    }
    return [...found.values()].sort((a, b) => b.depthMeters - a.depthMeters);
}

/**
 * The objects built there earlier whose base centre the new object (`object`: its sampler at the origin, turned to its
 * heading) would stand over at its placement: the viewport would seat such an object on top of the new one (or the
 * new one on it, by load order).
 */
function basesCoveredBy(object: SurfaceSampler, placement: ObjectPlacement, kept: any[]): Array<{ object: any; distanceMeters: number }> {
    return kept.filter(isBuiltObject).flatMap(o => {
        const { x, z } = placedAt(o);
        return object.heightAt(x - placement.sceneX, z - placement.sceneZ) === undefined ? [] : [{ object: o, distanceMeters: +Math.hypot(x - placement.sceneX, z - placement.sceneZ).toFixed(2) }];
    });
}

/** The built object either path produces, with what the result says about how it was made. */
interface BuiltObject {
    spec: ObjectBuildSpec;
    sourceCode: string;
    glb: Buffer;
    glbPath: string;
    checks: Omit<ObjectBuildChecks, 'differences'> & { differences?: ObjectBuildChecks['differences'] };
    /** data.objectBuild fields particular to how it was built. */
    record: Record<string, unknown>;
    /** Summary sentences particular to how it was built. */
    lines: string[];
}

const quoteDifferences = (list: Array<{ partId?: string; problem: string }>) =>
    list.map(d => `"${d.partId ? `part "${d.partId}": ` : ''}${d.problem}"`).join('; ');

/** The result's sentence on materials, and what data.objectBuild keeps about them. */
function materialFacts(clay: boolean, materials: MaterialProvenance, spec: ObjectBuildSpec): { record: Record<string, unknown>; line: string } {
    const parts = spec.parts.filter(p => p.material && !materials.clayParts.includes(p.id));
    const describe = (p: ObjectBuildSpec['parts'][number]) => {
        const m = p.material!;
        return `${p.id}${m.description ? ` "${m.description}"` : ''} (metalness ${m.metalness}, roughness ${m.roughness}${m.transmission > 0 ? `, transmission ${m.transmission}` : ''}${m.emissive ? ', emissive' : ''})`;
    };
    return {
        record: { clay, materials: { label: materials.label, note: materials.note, ...(materials.clayParts.length ? { clayParts: materials.clayParts } : {}) } },
        line: clay
            ? 'Every part is studio clay, as asked.'
            : `${materials.note}${parts.length ? ` Surfaces: ${parts.slice(0, 12).map(describe).join('; ')}${parts.length > 12 ? `; and ${parts.length - 12} more` : ''}.` : ''}`
    };
}

/**
 * The result's sentence on the material check: what the comparison of the build's material render with the reference
 * found and corrected, what remains, and when it could not be had. Empty for a clay build.
 */
function materialCheckLine(result: ReferenceObjectBuildResult): string {
    if (result.clay || result.materialChecks.length === 0) return '';
    const corrected = result.materialChecks.flatMap(c => c.applied);
    const last = result.materialChecks[result.materialChecks.length - 1];
    const fixedLine = corrected.length
        ? `The material render was compared with the reference and ${corrected.length} part surface${corrected.length === 1 ? ' was' : 's were'} corrected: ${corrected.slice(0, 8).map(c => `${c.partId} (${c.problem})`).join('; ')}${corrected.length > 8 ? `; and ${corrected.length - 8} more` : ''}.`
        : 'The material render was compared with the reference; no surface needed a correction.';
    const remaining = last.error
        ? `The material render of pass ${result.resultPass} could not be compared with the reference (${last.error}), so whether its surfaces match is unchecked.`
        : result.remainingMaterialDifferences.length
            ? `Surface differences that remain in pass ${result.resultPass}: ${quoteDifferences(result.remainingMaterialDifferences)}.`
            : '';
    return [corrected.length || !last.error ? fixedLine : '', remaining].filter(Boolean).join(' ');
}

function fromReference(result: ReferenceObjectBuildResult): BuiltObject {
    const backendName = result.backend === 'vertex' ? 'Vertex AI' : result.backend === 'api-key' ? 'the Gemini API key' : 'an injected client';
    const lastPass = result.passes[result.passes.length - 1].pass;
    const compared = result.comparisonFailed
        ? [
            `The clay render of pass ${result.resultPass} could not be compared with the reference (${result.comparisonFailed.reason}), so how closely it matches the reference is unchecked.`,
            result.comparisonFailed.unverifiedDifferences.length
                ? `Pass ${result.resultPass} was asked to fix these differences pass ${result.resultPass - 1} had; whether it did is unknown: ${quoteDifferences(result.comparisonFailed.unverifiedDifferences)}.`
                : ''
        ]
        : [result.remainingDifferences.length
            ? `Differences from the reference that remain in pass ${result.resultPass}: ${quoteDifferences(result.remainingDifferences)}.`
            : `The clay render of pass ${result.resultPass} matched the reference with no high-confidence differences.`];
    return {
        spec: result.spec,
        sourceCode: result.sourceCode,
        glb: result.glb,
        glbPath: result.glbPath,
        checks: result.checks,
        record: {
            source: 'reference',
            ...materialFacts(result.clay, result.materials, result.spec).record,
            imageModel: result.imageModel,
            visionModel: result.visionModel,
            backend: result.backend,
            passes: result.passes,
            resultPass: result.resultPass,
            ...(result.revisionFailed ? { revisionFailed: result.revisionFailed } : {}),
            ...(result.comparisonFailed ? { comparisonFailed: result.comparisonFailed } : {}),
            remainingDifferences: result.remainingDifferences,
            ...(result.clay ? {} : { materialChecks: result.materialChecks, remainingMaterialDifferences: result.remainingMaterialDifferences }),
            timings: { totalMs: result.totalMs, stages: result.timings },
            ...(result.openProblems.length ? { openProblems: result.openProblems } : {})
        },
        lines: [
            `after ${result.passes.length} pass${result.passes.length === 1 ? '' : 'es'}.`,
            result.revisionFailed
                ? `Revision pass ${result.revisionFailed.pass} failed (${result.revisionFailed.stage}: ${result.revisionFailed.reason}), so the result is pass ${result.resultPass}, the last build that passed every check.`
                : result.resultPass !== lastPass ? `The result is pass ${result.resultPass}.` : '',
            `Reference drawn internally by ${describeImageModel(result.imageModel)} (not saved or shown); spec read by ${describeVisionModel(result.visionModel)}, via ${backendName}.`,
            materialFacts(result.clay, result.materials, result.spec).line,
            ...compared,
            materialCheckLine(result),
            result.openProblems.length ? `Also unresolved: ${result.openProblems.join(' ')}` : ''
        ]
    };
}

function fromSpec(result: SpecObjectBuildResult): BuiltObject {
    const c = result.checks;
    const pass: ObjectBuildPass = {
        pass: 1,
        source: 'spec',
        outcome: 'built',
        vertexCount: c.vertexCount,
        triangleCount: c.triangleCount,
        partsBuilt: c.parts.filter(p => p.built).length,
        partsListed: c.parts.length,
        detachedParts: c.detachedParts.map(d => d.id),
        bodies: c.connectivity.bodies,
        expectedBodies: c.connectivity.expectedBodies,
        passedChecks: true,
        problems: result.openProblems,
        buildMs: result.buildMs
    };
    return {
        spec: result.spec,
        sourceCode: result.sourceCode,
        glb: result.glb,
        glbPath: result.glbPath,
        checks: result.checks,
        record: {
            source: 'spec',
            ...materialFacts(result.clay, result.materials, result.spec).record,
            passes: [pass],
            resultPass: 1,
            ...(result.openProblems.length ? { openProblems: result.openProblems } : {})
        },
        lines: [
            'from the given spec, built exactly as given.',
            'No reference image was drawn and no model was called or compared the result.',
            materialFacts(result.clay, result.materials, result.spec).line,
            result.openProblems.length ? `Unresolved: ${result.openProblems.join(' ')}` : ''
        ]
    };
}

/** Where the object goes at a place: the staging it stands on, the objects kept there, and its placement. */
interface Site {
    staged: Staging;
    /** Everything staged there that stays: the layers and the objects built earlier (minus a replaced one). */
    kept: any[];
    /** The object this build replaces, when replaceObjectId named one. */
    replaced?: any;
    surfaces: StagedSurface[];
    placement: ObjectPlacement;
    /** When the active scene was staged at this location but could not be reused: why, and its objects not carried over. */
    notReused?: { reason: string; objects: any[] };
    /** The location the active scene's objects were built at, when it is another location query than this one. */
    otherLocation?: string;
}

export function createObjectReferenceHandlers(deps: ObjectReferenceToolDeps = {}): Record<string, ToolHandler> {
    return {
        build_3d_object_from_reference: async (args, ctx): Promise<ToolHandlerOutcome> => {
            const request = typeof args.request === 'string' ? args.request.trim() : '';
            if (!request) return failed('build_3d_object_from_reference needs a request describing what to build.');
            const dimensions = parseDimensions(args.dimensionsHintMeters);
            if (dimensions === 'invalid') return failed('dimensionsHintMeters must be three positive numbers [width, height, depth] in metres.');
            let givenSpec: unknown;
            if (args.specJson !== undefined && args.specJson !== null && args.specJson !== '') {
                if (typeof args.specJson !== 'string') return failed('specJson must be the spec as JSON text.', { stage: 'build-spec' });
                try {
                    givenSpec = JSON.parse(args.specJson);
                } catch (err) {
                    return failed(`specJson is not valid JSON: ${errorMessage(err)}`, { stage: 'build-spec' });
                }
                if (dimensions) return failed('dimensionsHintMeters is for new builds; with specJson, set the sizes in the spec itself.', { stage: 'build-spec' });
            }
            const location = typeof args.location === 'string' && args.location.trim() ? args.location.trim() : undefined;
            const placementArgs = parsePlacement(args.placement);
            if (typeof placementArgs === 'string') return failed(placementArgs);
            if (placementArgs && !location) return failed('placement is relative to a place: pass location with it, or drop placement for a studio void.');
            if (location && !placementArgs) {
                return failed('With location, pass placement {eastMeters, northMeters, headingDeg}: where the object stands relative to the place\'s geocoded anchor and the compass heading its front faces (0 and 0 stands it at the anchor).');
            }
            if (args.replaceObjectId !== undefined && args.replaceObjectId !== null && typeof args.replaceObjectId !== 'string') {
                return failed('replaceObjectId must be the id of an object in the active scene, as a string.');
            }
            const replaceObjectId = typeof args.replaceObjectId === 'string' && args.replaceObjectId.trim() ? args.replaceObjectId.trim() : undefined;
            if (replaceObjectId && !location) {
                return failed('replaceObjectId replaces an object staged at a place: pass it with that location and a placement. In a studio void every build is a scene of its own.');
            }
            if (args.addToActiveScene !== undefined && args.addToActiveScene !== null && typeof args.addToActiveScene !== 'boolean') {
                return failed('addToActiveScene must be true or false.');
            }
            const addToActiveScene = args.addToActiveScene === true;
            if (args.clay !== undefined && args.clay !== null && typeof args.clay !== 'boolean') {
                return failed('clay must be true or false.');
            }
            const clay = args.clay === true;
            if (addToActiveScene && !location) {
                return failed('addToActiveScene adds the object to the place the active scene shows: pass that place as location, and a placement.');
            }

            const modelsDir = deps.publicModelsDir ?? path.resolve(repoRoot(), 'public/models');
            const modelsDirs = [...new Set([modelsDir, path.resolve(process.cwd(), 'public/models'), path.resolve(process.cwd(), '..', 'public/models')])];

            /** A stop while staging or placing: said as a stop, as a stop anywhere else in the build is. */
            const stopped = (stage: string) => failed('Stopped by the user.', { stage, aborted: true, ...(location ? { location } : {}) });

            // Whether the active scene's staging can be reused is known before anything is built or billed; a call
            // that asked to add to the active scene fails here when it cannot be.
            const reuse = location ? stagingFromActiveScene(ctx, location, modelsDirs, addToActiveScene) : undefined;
            if (location && addToActiveScene && !reuse?.staging) {
                return failed(`addToActiveScene: the object cannot be added to the active scene, because ${reuse?.reason}. Nothing was staged or built. Omit addToActiveScene to stage "${location}" afresh as a new scene.`, { stage: 'staging', location });
            }

            /** Stages at the location (or reuses the active scene's staging there) and places the object. */
            const stageAndPlace = async (beforeStaging?: () => void): Promise<{ site?: Site; failure?: ToolHandlerOutcome }> => {
                if (!location || !placementArgs || !reuse) return {};
                let replaced: any;
                if (replaceObjectId) {
                    if (!reuse.staging) {
                        return { failure: failed(`replaceObjectId "${replaceObjectId}" names an object in the active scene, but ${reuse.reason}, so there is nothing there to replace.`, { stage: 'placement', location }) };
                    }
                    const built = objectsOf(reuse.staging.artifact).filter(isBuiltObject);
                    replaced = built.find(o => o.id === replaceObjectId);
                    if (!replaced) {
                        return {
                            failure: failed(`replaceObjectId "${replaceObjectId}" is not an object build_3d_object_from_reference built in the active scene; the objects it built there are ${built.length ? built.map(o => `"${o.content?.metadata?.description || o.id}" (${o.id})`).join(', ') : 'none'}.`, { stage: 'placement', location })
                        };
                    }
                }
                // The request is valid to here: anything slow from now on (staging, reading the staged models) can run
                // alongside the build.
                beforeStaging?.();
                let staged = reuse.staging;
                if (staged) {
                    ctx.reportProgress?.(`Reusing the tiles already staged in the active scene for ${location}`);
                } else {
                    try {
                        staged = await stage(location, ctx, deps.stageAtLocation ?? google3DTilesHandlers.google_3d_tiles_get_clay);
                    } catch (err) {
                        if (ctx.signal?.aborted) return { failure: stopped('staging') };
                        return { failure: failed(errorMessage(err), { stage: 'staging', location }) };
                    }
                }
                if (ctx.signal?.aborted) return { failure: stopped('staging') };
                const kept = objectsOf(staged.artifact).filter(o => !replaced || o.id !== replaced.id);
                const notReused = !reuse.staging && reuse.leftBehind?.length ? { reason: reuse.reason, objects: reuse.leftBehind } : undefined;
                try {
                    ctx.reportProgress?.('Reading the staged models to place the object');
                    const surfaces = await loadSurfaces(kept, modelsDirs, ctx.signal);
                    return {
                        site: {
                            staged, kept, surfaces, placement: placeOnStagedTiles(surfaces, placementArgs),
                            ...(replaced ? { replaced } : {}), ...(notReused ? { notReused } : {}), ...(reuse.otherLocation ? { otherLocation: reuse.otherLocation } : {})
                        }
                    };
                } catch (err) {
                    if (err instanceof PlacementStoppedError || ctx.signal?.aborted) return { failure: stopped('placement') };
                    const details = err instanceof PlacementError ? err.details : {};
                    return { failure: failed(`Placing the object at ${location} failed: ${errorMessage(err)}`, { ...details, stage: 'placement', location }) };
                }
            };

            /**
             * After the build, with its footprint known: the object must not stand over an earlier object's base, nor
             * pass through anything staged there (tree crowns and trunks, objects built earlier, walls of the tiles).
             * A failure carries the spec, so the object can be rebuilt at another spot without a new reference.
             */
            const checkFit = async (object: BuiltObject, at: Site): Promise<{ failure?: ToolHandlerOutcome; spacingMeters?: number }> => {
                const p = at.placement;
                const subject = object.spec.subject.trim() || request;
                const opts = { signal: ctx.signal, abortError: () => new PlacementStoppedError() };
                try {
                    const sampler = await SurfaceSampler.fromGlbAsync(object.glb, { x: 0, y: 0, z: 0, yawDeg: p.yawDeg, seatBase: true }, opts);
                    if (!sampler) return { failure: failed(`The built object ${object.glbPath} is not a readable GLB, so it cannot be placed.`, { stage: 'placement', location }) };
                    const footprint = await runInSlices(footprintSteps(sampler, 48), opts);
                    const covered = basesCoveredBy(sampler, p, at.kept);
                    if (covered.length) {
                        const needed = +(footprint.radiusMeters + 0.5).toFixed(1);
                        return { failure: failed(
                            `Placing the object at ${location} failed: "${subject}" as built would stand over the base of ${covered.map(c => `${describeLayer(c.object)}, ${c.distanceMeters} m away`).join('; ')}, so the viewport would seat one on the other. ` +
                            `Place it at least ${needed} m from ${covered.length === 1 ? 'that object' : 'those objects'}, or pass replaceObjectId to replace one. Its spec is in this result's spec, to rebuild with specJson without a new reference.`,
                            { stage: 'placement', location, coversBasesOf: covered.map(c => c.object.id), spec: object.spec }
                        ) };
                    }
                    const through = await runInSlices(intersectionsAt(footprint, p.sceneX, p.sceneZ, p.surfaceYMeters, at.surfaces, false), opts);
                    if (!through.length) return { spacingMeters: footprint.spacingMeters };
                    ctx.reportProgress?.('Looking for spots where the object fits');
                    const coarse = await runInSlices(footprintSteps(sampler, 16), opts);
                    const spots = await runInSlices(nearestSpots(p.sceneX, p.sceneZ, function* (px, pz) {
                        const baseY = centreClear(at.surfaces, px, pz, p.surfaceYMeters);
                        if (baseY === undefined || basesCoveredBy(sampler, { ...p, sceneX: px, sceneZ: pz }, at.kept).length) return false;
                        // A quick pass with a coarse footprint, then the full one.
                        return (yield* intersectionsAt(coarse, px, pz, baseY, at.surfaces, true)).length === 0 &&
                            (yield* intersectionsAt(footprint, px, pz, baseY, at.surfaces, true)).length === 0;
                    }), opts);
                    const size = object.checks.builtBoundingMeters.join(' x ');
                    const what = (hit: Intersection) => hit.surface.ground
                        ? `${describeLayer(hit.surface.object)}, whose surface rises ${+hit.depthMeters.toFixed(2)} m above the object's underside there (a wall, a building or something else standing in the tiles)`
                        : `${describeLayer(hit.surface.object)}, overlapping it by up to ${+hit.depthMeters.toFixed(2)} m`;
                    return { failure: failed(
                        `Placing the object at ${location} failed: "${subject}" as built (${size} m) would pass through ${through.map(hit => `${what(hit)}, around ${+hit.x.toFixed(1)} m east, ${+(-hit.z).toFixed(1)} m north of the anchor`).join('; ')}. ` +
                        `The viewport would draw them through each other. Choose a placement where it fits whole (checked every ${+footprint.spacingMeters.toFixed(2)} m across its footprint): ${describeSpots(spots)}. ` +
                        `Its spec is in this result's spec, to rebuild there with specJson without a new reference.`,
                        {
                            stage: 'placement', location,
                            intersects: through.map(hit => ({ id: String(hit.surface.object.id), ground: hit.surface.ground, depthMeters: +hit.depthMeters.toFixed(3), eastMeters: +hit.x.toFixed(2), northMeters: +(-hit.z).toFixed(2) })),
                            clearSpots: spots, spec: object.spec
                        }
                    ) };
                } catch (err) {
                    if (err instanceof PlacementStoppedError || ctx.signal?.aborted) return { failure: stopped('placement') };
                    return { failure: failed(`Placing the object at ${location} failed: ${errorMessage(err)}`, { stage: 'placement', location, spec: object.spec }) };
                }
            };

            let built: BuiltObject;
            let site: Site | undefined;
            let live: ObjectBuildLiveView | undefined;
            try {
                if (givenSpec !== undefined) {
                    // A given spec costs no model call: build and check it before any billed staging call.
                    built = fromSpec(await buildObjectFromSpec(givenSpec, { signal: ctx.signal, reportProgress: ctx.reportProgress, clay }, deps.builder));
                    const staging = await stageAndPlace();
                    if (staging.failure) return staging.failure;
                    site = staging.site;
                } else {
                    // The build (reference draw, spec, native build, checks) and the staging of its spot are
                    // independent, so once the request has passed its checks they run at once. A staging or placement
                    // failure (an unknown place, a covered spot) stops the build through its own signal and is the
                    // result; the user's Stop ends both.
                    const buildStop = new AbortController();
                    const buildSignal = ctx.signal ? AbortSignal.any([ctx.signal, buildStop.signal]) : buildStop.signal;
                    let building: Promise<ReferenceObjectBuildResult> | undefined;
                    let buildSettled: Promise<void> | undefined;
                    // a studio build shows its reference and each pass while it runs; a staged one shows its staging
                    if (!location) live = new ObjectBuildLiveView(ctx, request, modelsDir, clay);
                    const startBuild = () => {
                        if (building) return building;
                        building = (deps.build ?? buildObjectFromReference)({
                            request,
                            requestedModel: ctx.request?.model || undefined,
                            dimensionsHintMeters: dimensions,
                            clay,
                            signal: buildSignal,
                            reportProgress: ctx.reportProgress,
                            ...(live ? { onReferenceImage: (image: { data: Buffer; mimeType: string }) => live!.reference(image), onPassBuilt: (pass: { pass: number; glb: Buffer; glbPath: string }) => live!.passBuilt(pass) } : {})
                        }, deps.builder);
                        // Observed at once, so a build that fails while staging runs is not an unhandled rejection.
                        buildSettled = building.then(() => undefined, () => undefined);
                        return building;
                    };
                    const stopBuild = async () => { buildStop.abort(); await buildSettled; };
                    let staging: Awaited<ReturnType<typeof stageAndPlace>>;
                    try {
                        staging = await stageAndPlace(startBuild);
                    } catch (err) {
                        await stopBuild();
                        throw err;
                    }
                    if (staging.failure) {
                        await stopBuild();
                        return staging.failure;
                    }
                    site = staging.site;
                    built = fromReference(await startBuild());
                }
            } catch (err) {
                live?.end(err instanceof ReferenceObjectBuildError && err.details.aborted ? 'Build stopped' : `Build failed: ${errorMessage(err)}`.slice(0, 200));
                if (err instanceof ReferenceObjectBuildError) {
                    return failed(err.message, { ...err.details, stage: err.stage });
                }
                return failed(errorMessage(err));
            }

            const subject = built.spec.subject.trim() || request;
            const placement = site?.placement;
            let fitSpacing: number | undefined;
            if (site) {
                const fit = await checkFit(built, site);
                if (fit.failure) return fit.failure;
                fitSpacing = fit.spacingMeters;
            }
            const staged = site?.staged;

            // Publish the GLB where the viewport serves models (a studio build's live view has already written its pass
            // builds there, to show while it ran); the reference never touches disk.
            const fileName = path.basename(built.glbPath);
            const publishedPath = path.join(modelsDir, fileName);
            try {
                fs.mkdirSync(modelsDir, { recursive: true });
                fs.writeFileSync(publishedPath, built.glb);
            } catch (err) {
                return failed(`The object was built (${built.glbPath}) but could not be published to ${publishedPath}: ${errorMessage(err)}`, { stage: 'publish', glbPath: built.glbPath });
            }
            const modelUri = `/models/${fileName}`;

            const checks = built.checks;
            const bodiesNote = checks.connectivity.bodies === 1 ? 'one connected piece' : `${checks.connectivity.bodies} separate pieces as intended`;
            const place = staged ? String(staged.payload.resolvedAddress || location) : undefined;
            const tiles = staged ? describeStagedTiles(objectsOf(staged.artifact), staged.reused ? undefined : (staged.payload.remesh as { ok?: boolean } | undefined)?.ok === true ? true : undefined) : '';
            // With addToActiveScene the object joins the place the active scene shows, whatever words the call used for
            // it: that place is recorded (the scene's own location query, else its resolved address), so a later call
            // naming another place does not reuse these tiles as that place.
            const activeWhere = (ctx.request?.activeArtifact as { data?: any } | undefined)?.data?.objectBuild?.location;
            const recordedQuery = staged && addToActiveScene && staged.reused
                ? (typeof activeWhere?.query === 'string' && activeWhere.query ? activeWhere.query : String(staged.payload.resolvedAddress || location))
                : location;
            const where = staged && placement
                ? { query: recordedQuery, resolvedAddress: staged.payload.resolvedAddress, geoAnchor: staged.payload.geoAnchor, staging: staged.reused ? 'reused from the active scene' : 'staged' }
                : undefined;
            const keptBuilt = (site?.kept || []).filter(isBuiltObject);
            const usedIds = new Set((site?.kept || []).map(o => String(o?.id)));
            let heroId = `hero-${Date.now()}`;
            for (let n = 2; usedIds.has(heroId); n++) heroId = `hero-${Date.now()}-${n}`;
            const ownRecord: BuiltObjectRecord = {
                spec: built.spec,
                ...(clay ? { clay: true } : {}),
                ...(placement ? { placement: { eastMeters: placement.eastMeters, northMeters: placement.northMeters, headingDeg: placement.headingDeg, surfaceYMeters: placement.surfaceYMeters } } : {})
            };
            const objectBuild = {
                spec: built.spec,
                objectId: heroId,
                ...built.record,
                checks: {
                    vertexCount: checks.vertexCount,
                    triangleCount: checks.triangleCount,
                    parts: checks.parts,
                    missingParts: checks.missingParts,
                    detachedParts: checks.detachedParts,
                    connectivity: checks.connectivity,
                    ...(checks.differences ? { differences: checks.differences } : {}),
                    builtBoundingMeters: checks.builtBoundingMeters
                },
                ...(where && placement ? { location: where, placement } : {}),
                ...(site?.replaced ? { replacedObjectId: String(site.replaced.id) } : {}),
                ...(staged?.reused ? { keptObjectIds: keptBuilt.map(o => String(o.id)) } : {}),
                ...(site?.notReused ? { notCarriedOver: { reason: site.notReused.reason, objectIds: site.notReused.objects.map(o => String(o.id)) } } : {})
            };
            // y 0: the viewport seats the base on the surface under (x, z), whichever of the object and the tiles
            // finishes loading first.
            const heroObject = {
                id: heroId,
                content: {
                    type: '3d-model',
                    durableUri: modelUri,
                    mimeType: 'model/gltf-binary',
                    metadata: {
                        role: 'hero',
                        description: subject,
                        source: OBJECT_BUILD_SOURCE,
                        originalPath: built.glbPath,
                        metricScale: 1.0,
                        groundSnapped: true,
                        objectBuild: ownRecord
                    }
                },
                space: { spatial3d: placement ? { x: placement.sceneX, y: 0, z: placement.sceneZ, yaw: placement.yawDeg } : { x: 0, y: 0, z: 0 } },
                time: { startMs: 0, durationMs: 20000 },
                lineage: { version: 1 }
            };
            // The viewport draws a generator's inline GLB itself, at the origin and unturned, and then skips any object
            // that loads the same file. Staged, the object must be drawn by the hero object with its placement, so
            // the generator keeps only the script and the file it wrote.
            const pythonGenerator = {
                enabled: true,
                filename: 'object_spec_build.py',
                sourceCode: built.sourceCode,
                ...(placement ? {} : { glbBase64: built.glb.toString('base64') }),
                glbPath: built.glbPath,
                lastCompiledTimeMs: Date.now()
            };
            const summaryLine = `Native ${clay ? 'clay ' : ''}build: ${checks.vertexCount.toLocaleString()} vertices, ${built.spec.parts.length} parts${clay ? '' : ', a material per part'}.`;

            let artifact: Record<string, unknown>;
            /** The object has its materials but the reused scene keeps the clay view the user chose. */
            let shownInClayView = false;
            if (staged && placement && site) {
                const tileData = (staged.artifact.data || {}) as Record<string, unknown>;
                const base: Vec3 = [placement.sceneX, placement.surfaceYMeters, placement.sceneZ];
                const title = keptBuilt.length ? `${[...keptBuilt.map(o => String(o.content?.metadata?.description || o.id)), subject].join(', ')} at ${place}` : `${subject} at ${place}`;
                // A clay request shows clay. Otherwise the object's materials show ('pbr'; the staged clay tiles keep their
                // own look), unless a reused scene already shows another non-clay mode (or did before a clay view), which
                // it keeps. A clay view the user chose on the reused scene (staged_location_material_mode or the overlay)
                // stays: the object is built with its materials, shown in clay, and textured shows them.
                const reusedShown = tileData.renderMode === 'clay' ? (tileData.stagedBuildView as StagedMaterialModeFields['stagedBuildView'])?.renderModeBeforeClay : tileData.renderMode;
                const reusedMode = staged.reused && typeof reusedShown === 'string' && reusedShown !== 'clay' ? reusedShown : undefined;
                const keepsClayView = staged.reused && materialModeOf((tileData.stagedBuild as { materialMode?: unknown } | undefined)?.materialMode) === 'clay';
                const sceneData: Record<string, unknown> & StagedMaterialModeFields = {
                    ...tileData,
                    title,
                    subtitle: summaryLine,
                    renderMode: clay ? 'clay' : reusedMode ?? 'pbr',
                    cameraMode: 'orbit',
                    camera: frameCamera(checks.builtBoundingMeters, base, placement.yawDeg),
                    objects: [...site.kept, heroObject],
                    pythonGenerator,
                    objectBuild
                };
                shownInClayView = keepsClayView && !clay;
                artifact = {
                    ...staged.artifact,
                    id: `artifact-3d-${Date.now()}`,
                    title,
                    summary: `${summaryLine} Staged on ${tiles} at ${place}.`,
                    data: keepsClayView ? withStagedMaterialMode(sceneData, 'clay') : sceneData
                };
            } else {
                artifact = {
                    // the scene the live view showed becomes the finished one
                    id: live?.artifactId ?? `artifact-3d-${Date.now()}`,
                    type: '3d-scene',
                    title: subject,
                    summary: summaryLine,
                    version: 1,
                    data: {
                        title: subject,
                        subtitle: summaryLine,
                        worldBranch: 'procedural/object-from-reference',
                        sceneType: 'custom',
                        renderMode: clay ? 'clay' : 'pbr',
                        ...(clay ? { clayPreset: 'studio-grey' } : {}),
                        cameraMode: 'orbit',
                        animation: 'orbit',
                        camera: frameCamera(checks.builtBoundingMeters, [0, 0, 0], 0),
                        environment: { skybox: 'studio', lighting: 'studio', ground: false },
                        groundDatum: {
                            coordinateSystem: 'metric-enu',
                            units: 'meters',
                            scale: 1.0,
                            groundDatumMeters: 0.0,
                            groundLogic: 'shared-metric-ground'
                        },
                        objects: [heroObject],
                        pythonGenerator,
                        objectBuild
                    }
                };
            }

            const named = (o: any) => `"${o.content?.metadata?.description || o.id}" (${o.id})`;
            const placeLine = staged && placement && site
                ? [
                    `${staged.reused ? `Reused the ${tiles} already staged at ${place} in the active scene (no new geocode or extraction)` : `Staged at ${place} on ${tiles}`}, ${placement.eastMeters} m east and ${placement.northMeters} m north of the anchor, facing ${placement.headingDeg} degrees, resting on the ground surface of the tiles there, ${placement.surfaceYMeters} m above the anchor's street level${placement.surfaceYMeters > 3 ? ' (likely a roof or raised structure)' : ''}; nothing else staged there rises above that spot${fitSpacing !== undefined ? `, and nothing staged there passes through the object (checked every ${+fitSpacing.toFixed(2)} m across its footprint)` : ''}.`,
                    recordedQuery !== location ? `It was added to the place the active scene shows (addToActiveScene), so "${location}" was not geocoded; the object is recorded at "${recordedQuery}".` : '',
                    site.replaced ? `It replaces ${named(site.replaced)}.` : '',
                    keptBuilt.length ? `Kept ${keptBuilt.length === 1 ? 'the object' : `the ${keptBuilt.length} objects`} built there earlier: ${keptBuilt.map(named).join(', ')}.` : '',
                    site.notReused ? `The active scene's staging there could not be reused (${site.notReused.reason}), so the place was staged afresh and the objects built there earlier are not in this scene: ${site.notReused.objects.map(named).join(', ')}.` : '',
                    site.otherLocation ? `The active scene's objects were built at location "${site.otherLocation}", a different location from "${location}", so this is a new scene without them (pass that same location, or addToActiveScene: true, to add to that scene).` : '',
                    shownInClayView ? 'The scene keeps the clay view chosen on it (scene render mode: clay), so the object is shown in clay; its materials are built and staged_location_material_mode with mode "textured" shows them.' : ''
                ].filter(Boolean).join(' ')
                : clay ? 'Shown in a studio grey clay void.' : 'Shown in a neutral studio void with its materials (the viewport\'s PBR mode).';
            const editLine = staged && placement
                ? `This object's id is ${heroId}. To change it, edit its spec (data.objectBuild.spec, also in its metadata.objectBuild; part materials are in each part's material) and call build_3d_object_from_reference with specJson set to the edited spec, location "${recordedQuery}", this placement, and replaceObjectId "${heroId}"${clay ? ', and clay: true' : ''}.`
                : `To change it (shape or part materials), edit data.objectBuild.spec and call build_3d_object_from_reference with specJson set to the edited spec${clay ? ' and clay: true' : ''}.`;
            const [howBuilt, ...builtLines] = built.lines;
            const summary = [
                `Built "${subject}" as native ${clay ? 'clay ' : ''}geometry${clay ? '' : ' with a material per part'}: ${checks.vertexCount.toLocaleString()} vertices, ${checks.triangleCount.toLocaleString()} triangles, ${checks.parts.filter(p => p.built).length} of ${checks.parts.length} listed parts built and attached, ${bodiesNote}, ${checks.builtBoundingMeters.join(' x ')} m, ${howBuilt}`,
                ...builtLines,
                placeLine,
                editLine
            ].filter(Boolean).join(' ');

            return {
                status: 'completed',
                summaryResult: summary,
                resultPayload: {
                    status: 'completed',
                    success: true,
                    summary,
                    glbPath: publishedPath,
                    modelUri,
                    objectId: heroId,
                    vertexCount: checks.vertexCount,
                    triangleCount: checks.triangleCount,
                    partCount: built.spec.parts.length,
                    ...built.record,
                    checks: objectBuild.checks,
                    ...(where ? { location: { ...where, placement } } : {}),
                    ...(site?.replaced ? { replacedObjectId: String(site.replaced.id) } : {}),
                    artifact
                }
            };
        }
    };
}

export const objectReferenceHandlers: Record<string, ToolHandler> = createObjectReferenceHandlers();
