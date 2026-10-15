/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * build_3d_object_from_reference: one object or abstract form asked for in words becomes native clay geometry
 * (reference-object-builder.ts). Given specJson instead (an edit of an earlier build's spec), it rebuilds that spec
 * exactly, with no reference image and no model call.
 *
 * With a location, the object is staged on the same geocoded, remeshed clay tiles that google_3d_tiles_get_clay
 * returns, at the placement the model gives relative to the place's anchor, with the camera framed on the object.
 * The viewport stands an object on the highest surface under its base (whatever mesh that is), so the object may
 * only stand where that surface is ground: the staged layers marked isGround (the tiles, including their roofs). A
 * spot under a tree crown or on another object fails, naming what covers it and the nearest clear spots, and so does
 * a build whose footprint would cover the base of an object already there. A new build checks its spot before any
 * model is called; a given spec is built first, so a spec that cannot be built makes no billed staging call.
 *
 * When the active scene is an object build staged at the same location, its staging is reused (no new geocode or
 * extraction) and the objects built there earlier are kept: the new object is added beside them, or replaces the one
 * replaceObjectId names. Every built object carries its own spec and placement in its metadata, so each can be
 * changed later. A staging or placement failure fails the call. The result never carries the reference image.
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
    type SpecObjectBuildResult,
    type VisionModelUse
} from '../../3d-engine/reference-object-builder';
import { glbToTriangleSoup, type TriangleSoup } from '../../3d-engine/part-connectivity';
import { errorMessage } from '../gemini-client';
import { OBJECT_BUILD_SOURCE, type BuiltObjectRecord, type ObjectBuildSpec, type Vec3 } from '../../../common/spatial/object-build-spec';

export const OBJECT_REFERENCE_TOOL_DECLARATIONS: ToolDeclaration[] = [
    {
        name: 'build_3d_object_from_reference',
        description: 'Build one specific object or an abstract form (a single prop, vehicle, creature, character, piece of furniture, sculpture or artifact) as native 3D geometry in studio grey clay. ' +
            `It draws an internal reference picture with Nano Banana Lite (${REFERENCE_IMAGE_MODEL}; never shown or saved), reads it with the chat's model into a metric build spec of swept, revolved, replicated and relief parts, builds that in the native Python engine, and checks that every part is built and attached and that the build matches the reference (up to two revisions). ` +
            'It builds one object per call, not a place or a scene: for an imagined environment, a landscape or several objects with no real place, write a script for execute_3d_python_script; for a real place alone, use google_3d_tiles_get_clay. To stand the object at a real place, pass location and placement. ' +
            'Several objects at one real place take one call each with the same location and each its own placement: when the active scene is an object build staged at that location, the call reuses its tiles and adds the new object beside the objects already built there. ' +
            'To change an object it built (its shape, its size, or a base or plinth added as parts), pass specJson: the edited spec from that object\'s metadata.objectBuild.spec (or the result\'s data.objectBuild.spec). That spec is built exactly as given, with no new reference and no comparison; at a place, pass the same location, its placement (or a new one to move it) and replaceObjectId set to that object\'s id.',
        parameters: {
            type: 'OBJECT',
            properties: {
                request: {
                    type: 'STRING',
                    description: 'What to build, in the user\'s words plus any details from the conversation (parts, counts, proportions, style of form). With specJson: what the object is and the change being made.'
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
                    description: 'Optional real-world place (name or address, or coordinates the user gave) to stage the object at. It is geocoded and returned as remeshed Google 3D Tiles in clay, or the tiles already staged there in the active scene are reused; omit it for a studio void. Requires placement.'
                },
                placement: {
                    type: 'OBJECT',
                    description: 'Required with location: where the object stands relative to the place\'s geocoded anchor and which way it faces, worked out from what the user said (for example in front of the entrance, facing the square). The anchor is often the middle of a building, so an object beside it needs an offset; 0 and 0 stands it at the anchor. The object rests on the ground of the staged tiles there (or a roof, when the spot is on one). A spot under a tree crown or on top of another object cannot hold it: the call then fails before anything is built, naming the nearest clear spots.',
                    properties: {
                        eastMeters: { type: 'NUMBER', description: 'Metres east of the anchor (negative for west).' },
                        northMeters: { type: 'NUMBER', description: 'Metres north of the anchor (negative for south).' },
                        headingDeg: { type: 'NUMBER', description: 'Compass heading the object\'s front faces, degrees clockwise from north (0 north, 90 east, 180 south, 270 west).' }
                    },
                    required: ['eastMeters', 'northMeters', 'headingDeg']
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
 * The active scene's staging, when that scene is an object build staged at this same location and every staged
 * model is still on disk: the new object then stands on the same tiles, beside the objects built there, without
 * another geocode or extraction. Otherwise the reason it cannot be reused, and, when the scene is staged at this
 * location but cannot be reused, the objects built there (which a fresh staging does not carry over).
 */
function stagingFromActiveScene(ctx: ToolContext, location: string, modelsDirs: string[]): { staging?: Staging; reason: string; leftBehind?: any[] } {
    const active = ctx.request?.activeArtifact as { type?: string; data?: any } | undefined;
    if (active?.type !== '3d-scene') return { reason: 'the active canvas artifact is not a 3D scene' };
    const data = active.data || {};
    const where = data.objectBuild?.location;
    if (!where || where.query !== location) return { reason: `the active scene is not an object build staged at "${location}"` };
    const objects: any[] = Array.isArray(data.objects) ? data.objects : [];
    const leftBehind = objects.filter(isBuiltObject);
    if (!objects.some(isGroundLayer)) return { reason: 'the active scene has no ground layer', leftBehind };
    const unreadable = objects.map(glbUriOf).filter(isGlbUri).find((uri: string) => !modelFile(uri, modelsDirs));
    if (unreadable) return { reason: `the staged model ${unreadable} can no longer be read`, leftBehind };
    return {
        staging: { artifact: active, payload: { resolvedAddress: where.resolvedAddress, geoAnchor: where.geoAnchor ?? data.geoAnchor }, reused: true },
        reason: ''
    };
}

/** Where a staged model stands: its spatial3d, with a built object's base at the surface it was seated on. */
function placedAt(o: any): { x: number; y: number; z: number; yawDeg: number } {
    const s = o?.space?.spatial3d || {};
    const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v) ? v : 0;
    const seated = o?.content?.metadata?.objectBuild?.placement?.surfaceYMeters;
    return { x: num(s.x), y: isBuiltObject(o) && typeof seated === 'number' ? seated : num(s.y), z: num(s.z), yawDeg: num(s.yaw) };
}

/**
 * Heights of a triangle soup's top surface by vertical ray, as the viewport's ground seating casts them: the highest
 * triangle straight above or below a point (walls, seen edge-on, are never hit). Triangles are binned on a grid in
 * x and z once, so a model of a million triangles answers many points quickly.
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
        private readonly tris: Uint32Array
    ) {}

    /** The soup turned by yawDeg about +Y (as Three.js rotation.y) and moved to (x, y, z). */
    static fromSoup(soup: TriangleSoup, place: { x: number; y: number; z: number; yawDeg: number } = { x: 0, y: 0, z: 0, yawDeg: 0 }): SurfaceSampler {
        const yaw = (place.yawDeg * Math.PI) / 180, c = Math.cos(yaw), s = Math.sin(yaw);
        const p = new Float32Array(soup.positions.length);
        let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
        for (let i = 0; i < p.length; i += 3) {
            const x = soup.positions[i], y = soup.positions[i + 1], z = soup.positions[i + 2];
            p[i] = c * x + s * z + place.x;
            p[i + 1] = y + place.y;
            p[i + 2] = -s * x + c * z + place.z;
            minX = Math.min(minX, p[i]); maxX = Math.max(maxX, p[i]);
            minZ = Math.min(minZ, p[i + 2]); maxZ = Math.max(maxZ, p[i + 2]);
        }
        const triCount = soup.indices.length / 3;
        if (triCount === 0) return new SurfaceSampler(p, soup.indices, 0, 0, 1, 0, 0, new Uint32Array(1), new Uint32Array(0));
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
        }
        for (let k = 1; k < counts.length; k++) counts[k] += counts[k - 1];
        const start = counts.slice();
        const fill = counts.slice(0, nx * nz);
        const tris = new Uint32Array(start[nx * nz]);
        for (let t = 0; t < triCount; t++) {
            const [x0, x1, z0, z1] = range(t);
            for (let j = z0; j <= z1; j++) for (let i = x0; i <= x1; i++) tris[fill[j * nx + i]++] = t;
        }
        return new SurfaceSampler(p, soup.indices, minX, minZ, cell, nx, nz, start, tris);
    }

    static fromGlb(glb: Buffer, place?: { x: number; y: number; z: number; yawDeg: number }): SurfaceSampler | undefined {
        const soup = glbToTriangleSoup(glb, { colors: false });
        return soup ? SurfaceSampler.fromSoup(soup, place) : undefined;
    }

    /** Height of the highest triangle straight above or below (x, z), or undefined when none covers it. */
    heightAt(x: number, z: number): number | undefined {
        const i = Math.floor((x - this.minX) / this.cell), j = Math.floor((z - this.minZ) / this.cell);
        if (this.nx === 0 || i < 0 || j < 0 || i >= this.nx || j >= this.nz) return undefined;
        const p = this.p, idx = this.idx;
        let best: number | undefined;
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
            if (best === undefined || y > best) best = y;
        }
        return best;
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

function loadSurfaces(objects: any[], modelsDirs: string[]): StagedSurface[] {
    return objects.filter(o => isGlbUri(glbUriOf(o))).map(o => {
        const file = modelFile(glbUriOf(o), modelsDirs);
        if (!file) throw new PlacementError(`could not read the staged model ${glbUriOf(o)} to place the object (looked in ${modelsDirs.join(', ')})`);
        const sampler = SurfaceSampler.fromGlb(fs.readFileSync(file), placedAt(o));
        if (!sampler) throw new PlacementError(`the staged model ${glbUriOf(o)} is not a readable GLB`);
        return { object: o, ground: isGroundLayer(o), sampler };
    });
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
 * The nearest spots around (x, z) where the highest surface is ground at the same level as the ground at (x, z)
 * (within half a metre, so a street spot is not offered a roof), also 0.75 m around each, in different directions (at
 * most three), as placements: metres east and north of the anchor.
 */
function clearSpotsNear(surfaces: StagedSurface[], x: number, z: number, groundY: number, maxRadiusMeters = 40): ClearSpot[] {
    const clear = (px: number, pz: number) => [[0, 0], [0.75, 0], [-0.75, 0], [0, 0.75], [0, -0.75]]
        .every(([dx, dz]) => {
            const at = surfaceAt(surfaces, px + dx, pz + dz);
            return at.groundY !== undefined && Math.abs(at.groundY - groundY) <= 0.5 && !at.cover;
        });
    const spots: Array<ClearSpot & { angle: number }> = [];
    for (let r = 1; r <= maxRadiusMeters && spots.length < 3; r += 1) {
        for (let k = 0; k < 16 && spots.length < 3; k++) {
            const angle = (k * 2 * Math.PI) / 16;
            const px = x + r * Math.sin(angle), pz = z - r * Math.cos(angle);
            const apart = spots.every(s => Math.abs(((angle - s.angle + 3 * Math.PI) % (2 * Math.PI)) - Math.PI) >= Math.PI / 3);
            if (!apart || !clear(px, pz)) continue;
            spots.push({ eastMeters: +px.toFixed(1), northMeters: +(-pz).toFixed(1), distanceMeters: r, angle });
        }
    }
    return spots.map(({ angle: _angle, ...spot }) => spot);
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
 * The objects built there earlier whose base the new object, as built and placed, would stand over: the viewport
 * would seat such an object on top of the new one (or the new one on it, by load order). Their ids, with distances.
 */
function basesCoveredBy(glb: Buffer, placement: ObjectPlacement, kept: any[]): Array<{ object: any; distanceMeters: number }> {
    const sampler = SurfaceSampler.fromGlb(glb, { x: placement.sceneX, y: placement.surfaceYMeters, z: placement.sceneZ, yawDeg: placement.yawDeg });
    if (!sampler) return [];
    return kept.filter(isBuiltObject).flatMap(o => {
        const { x, z } = placedAt(o);
        return sampler.heightAt(x, z) === undefined ? [] : [{ object: o, distanceMeters: +Math.hypot(x - placement.sceneX, z - placement.sceneZ).toFixed(2) }];
    });
}

/** Distance from the object's base centre to the farthest point of its footprint. */
function footprintRadius(glb: Buffer): number {
    const soup = glbToTriangleSoup(glb, { colors: false });
    let r = 0;
    for (let i = 0; soup && i < soup.positions.length; i += 3) r = Math.max(r, Math.hypot(soup.positions[i], soup.positions[i + 2]));
    return r;
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
            imageModel: result.imageModel,
            visionModel: result.visionModel,
            backend: result.backend,
            passes: result.passes,
            resultPass: result.resultPass,
            ...(result.revisionFailed ? { revisionFailed: result.revisionFailed } : {}),
            ...(result.comparisonFailed ? { comparisonFailed: result.comparisonFailed } : {}),
            remainingDifferences: result.remainingDifferences,
            ...(result.openProblems.length ? { openProblems: result.openProblems } : {})
        },
        lines: [
            `after ${result.passes.length} pass${result.passes.length === 1 ? '' : 'es'}.`,
            result.revisionFailed
                ? `Revision pass ${result.revisionFailed.pass} failed (${result.revisionFailed.stage}: ${result.revisionFailed.reason}), so the result is pass ${result.resultPass}, the last build that passed every check.`
                : result.resultPass !== lastPass ? `The result is pass ${result.resultPass}.` : '',
            `Reference drawn internally by ${describeImageModel(result.imageModel)} (not saved or shown); spec read by ${describeVisionModel(result.visionModel)}, via ${backendName}.`,
            ...compared,
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
            passes: [pass],
            resultPass: 1,
            ...(result.openProblems.length ? { openProblems: result.openProblems } : {})
        },
        lines: [
            'from the given spec, built exactly as given.',
            'No reference image was drawn and no model was called or compared the result.',
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

            const modelsDir = deps.publicModelsDir ?? path.resolve(repoRoot(), 'public/models');
            const modelsDirs = [...new Set([modelsDir, path.resolve(process.cwd(), 'public/models'), path.resolve(process.cwd(), '..', 'public/models')])];

            /** Stages at the location (or reuses the active scene's staging there) and places the object. */
            const stageAndPlace = async (): Promise<{ site?: Site; failure?: ToolHandlerOutcome }> => {
                if (!location || !placementArgs) return {};
                const reuse = stagingFromActiveScene(ctx, location, modelsDirs);
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
                let staged = reuse.staging;
                if (staged) {
                    ctx.reportProgress?.(`Reusing the clay tiles already staged at ${location}`);
                } else {
                    try {
                        staged = await stage(location, ctx, deps.stageAtLocation ?? google3DTilesHandlers.google_3d_tiles_get_clay);
                    } catch (err) {
                        return { failure: failed(errorMessage(err), { stage: 'staging', location }) };
                    }
                }
                const kept = objectsOf(staged.artifact).filter(o => !replaced || o.id !== replaced.id);
                const notReused = !reuse.staging && reuse.leftBehind?.length ? { reason: reuse.reason, objects: reuse.leftBehind } : undefined;
                try {
                    const surfaces = loadSurfaces(kept, modelsDirs);
                    return { site: { staged, kept, ...(replaced ? { replaced } : {}), ...(notReused ? { notReused } : {}), surfaces, placement: placeOnStagedTiles(surfaces, placementArgs) } };
                } catch (err) {
                    const details = err instanceof PlacementError ? err.details : {};
                    return { failure: failed(`Placing the object at ${location} failed: ${errorMessage(err)}`, { ...details, stage: 'placement', location }) };
                }
            };

            let built: BuiltObject;
            let site: Site | undefined;
            try {
                if (givenSpec !== undefined) {
                    // A given spec costs no model call: build and check it before any billed staging call.
                    built = fromSpec(await buildObjectFromSpec(givenSpec, { signal: ctx.signal, reportProgress: ctx.reportProgress }, deps.builder));
                    const staging = await stageAndPlace();
                    if (staging.failure) return staging.failure;
                    site = staging.site;
                } else {
                    // A new build stages and checks its spot first, so an unknown place or a covered spot fails before
                    // any model is called.
                    const staging = await stageAndPlace();
                    if (staging.failure) return staging.failure;
                    site = staging.site;
                    built = fromReference(await (deps.build ?? buildObjectFromReference)({
                        request,
                        requestedModel: ctx.request?.model || undefined,
                        dimensionsHintMeters: dimensions,
                        signal: ctx.signal,
                        reportProgress: ctx.reportProgress
                    }, deps.builder));
                }
            } catch (err) {
                if (err instanceof ReferenceObjectBuildError) {
                    return failed(err.message, { ...err.details, stage: err.stage });
                }
                return failed(errorMessage(err));
            }

            const subject = built.spec.subject.trim() || request;
            const placement = site?.placement;
            if (site && placement) {
                // The object as built must not stand over the base of an object built there earlier.
                const covered = basesCoveredBy(built.glb, placement, site.kept);
                if (covered.length) {
                    const needed = +(footprintRadius(built.glb) + 0.5).toFixed(1);
                    return failed(
                        `Placing the object at ${location} failed: "${subject}" as built would stand over the base of ${covered.map(c => `${describeLayer(c.object)}, ${c.distanceMeters} m away`).join('; ')}, so the viewport would seat one on the other. ` +
                        `Place it at least ${needed} m from ${covered.length === 1 ? 'that object' : 'those objects'}, or pass replaceObjectId to replace one. Its spec is in this result's spec, to rebuild with specJson without a new reference.`,
                        { stage: 'placement', location, coversBasesOf: covered.map(c => c.object.id), spec: built.spec }
                    );
                }
            }
            const staged = site?.staged;

            // Publish the GLB where the viewport serves models; the reference never touches disk.
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
            const where = staged && placement
                ? { query: location, resolvedAddress: staged.payload.resolvedAddress, geoAnchor: staged.payload.geoAnchor, staging: staged.reused ? 'reused from the active scene' : 'staged' }
                : undefined;
            const keptBuilt = (site?.kept || []).filter(isBuiltObject);
            const usedIds = new Set((site?.kept || []).map(o => String(o?.id)));
            let heroId = `hero-${Date.now()}`;
            for (let n = 2; usedIds.has(heroId); n++) heroId = `hero-${Date.now()}-${n}`;
            const ownRecord: BuiltObjectRecord = {
                spec: built.spec,
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
            const summaryLine = `Native clay build: ${checks.vertexCount.toLocaleString()} vertices, ${built.spec.parts.length} parts.`;

            let artifact: Record<string, unknown>;
            if (staged && placement && site) {
                const tileData = (staged.artifact.data || {}) as Record<string, unknown>;
                const base: Vec3 = [placement.sceneX, placement.surfaceYMeters, placement.sceneZ];
                const title = keptBuilt.length ? `${[...keptBuilt.map(o => String(o.content?.metadata?.description || o.id)), subject].join(', ')} at ${place}` : `${subject} at ${place}`;
                artifact = {
                    ...staged.artifact,
                    id: `artifact-3d-${Date.now()}`,
                    title,
                    summary: `${summaryLine} Staged on remeshed Google 3D Tiles in clay at ${place}.`,
                    data: {
                        ...tileData,
                        title,
                        subtitle: summaryLine,
                        renderMode: 'clay',
                        cameraMode: 'orbit',
                        camera: frameCamera(checks.builtBoundingMeters, base, placement.yawDeg),
                        objects: [...site.kept, heroObject],
                        pythonGenerator,
                        objectBuild
                    }
                };
            } else {
                artifact = {
                    id: `artifact-3d-${Date.now()}`,
                    type: '3d-scene',
                    title: subject,
                    summary: summaryLine,
                    version: 1,
                    data: {
                        title: subject,
                        subtitle: summaryLine,
                        worldBranch: 'procedural/object-from-reference',
                        sceneType: 'custom',
                        renderMode: 'clay',
                        clayPreset: 'studio-grey',
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
                    `${staged.reused ? `Reused the remeshed Google 3D Tiles in clay already staged at ${place} in the active scene (no new geocode or extraction)` : `Staged at ${place} on remeshed Google 3D Tiles in clay`}, ${placement.eastMeters} m east and ${placement.northMeters} m north of the anchor, facing ${placement.headingDeg} degrees, resting on the ground surface of the tiles there, ${placement.surfaceYMeters} m above the anchor's street level${placement.surfaceYMeters > 3 ? ' (likely a roof or raised structure)' : ''}; nothing else staged there rises above that spot.`,
                    site.replaced ? `It replaces ${named(site.replaced)}.` : '',
                    keptBuilt.length ? `Kept ${keptBuilt.length === 1 ? 'the object' : `the ${keptBuilt.length} objects`} built there earlier: ${keptBuilt.map(named).join(', ')}.` : '',
                    site.notReused ? `The active scene's staging there could not be reused (${site.notReused.reason}), so the place was staged afresh and the objects built there earlier are not in this scene: ${site.notReused.objects.map(named).join(', ')}.` : ''
                ].filter(Boolean).join(' ')
                : 'Shown in a studio grey clay void.';
            const editLine = staged && placement
                ? `This object's id is ${heroId}. To change it, edit its spec (data.objectBuild.spec, also in its metadata.objectBuild) and call build_3d_object_from_reference with specJson set to the edited spec, this location and placement, and replaceObjectId "${heroId}".`
                : 'To change it, edit data.objectBuild.spec and call build_3d_object_from_reference with specJson set to the edited spec.';
            const [howBuilt, ...builtLines] = built.lines;
            const summary = [
                `Built "${subject}" as native clay geometry: ${checks.vertexCount.toLocaleString()} vertices, ${checks.triangleCount.toLocaleString()} triangles, ${checks.parts.filter(p => p.built).length} of ${checks.parts.length} listed parts built and attached, ${bodiesNote}, ${checks.builtBoundingMeters.join(' x ')} m, ${howBuilt}`,
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
