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
 * (reference-object-builder.ts). With a location, the object is staged on the same geocoded, remeshed clay tiles
 * that google_3d_tiles_get_clay returns, at the placement the model gives relative to the place's anchor, with the
 * camera framed on the object; a staging or placement failure fails the call before any model is asked. The
 * result carries the build script and the spec for later edits, never the reference image.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { ToolContext, ToolDeclaration, ToolHandler, ToolHandlerOutcome } from './types';
import { google3DTilesHandlers } from './spatial-tools';
import {
    REFERENCE_IMAGE_MODEL,
    ReferenceObjectBuildError,
    buildObjectFromReference,
    type ModelUse,
    type ReferenceObjectBuildRequest,
    type ReferenceObjectBuildResult,
    type ReferenceObjectBuilderDeps,
    type VisionModelUse
} from '../../3d-engine/reference-object-builder';
import { glbToTriangleSoup } from '../../3d-engine/part-connectivity';
import { errorMessage } from '../gemini-client';
import type { Vec3 } from '../../../common/spatial/object-build-spec';

export const OBJECT_REFERENCE_TOOL_DECLARATIONS: ToolDeclaration[] = [
    {
        name: 'build_3d_object_from_reference',
        description: 'Build one specific object or an abstract form (a single prop, vehicle, creature, character, piece of furniture, sculpture or artifact) as native 3D geometry in studio grey clay. ' +
            `It draws an internal reference picture with Nano Banana Lite (${REFERENCE_IMAGE_MODEL}; never shown or saved), reads it with the chat's model into a metric build spec of swept, revolved, replicated and relief parts, builds that in the native Python engine, and checks that every part is built and attached and that the build matches the reference (up to two revisions). ` +
            'It builds one object, not a place or a scene: for an imagined environment, a landscape or several objects, write a script for execute_3d_python_script; for a real place, use google_3d_tiles_get_clay. To stand the object at a real place, pass location and placement. ' +
            'The result includes the build script (pythonGenerator.sourceCode, with an editable SPEC) for later changes.',
        parameters: {
            type: 'OBJECT',
            properties: {
                request: {
                    type: 'STRING',
                    description: 'What to build, in the user\'s words plus any details from the conversation (parts, counts, proportions, style of form).'
                },
                dimensionsHintMeters: {
                    type: 'ARRAY',
                    items: { type: 'NUMBER' },
                    description: 'Optional [width, height, depth] in metres when the user gave a size.'
                },
                location: {
                    type: 'STRING',
                    description: 'Optional real-world place (name or address, or coordinates the user gave) to stage the object at. It is geocoded and returned as remeshed Google 3D Tiles in clay; omit it for a studio void.'
                },
                placement: {
                    type: 'OBJECT',
                    description: 'With location: where the object stands relative to the place\'s geocoded anchor, worked out from what the user said (for example in front of the entrance). The anchor is often the middle of a building, so an object beside it needs an offset. Omit to stand it at the anchor.',
                    properties: {
                        eastMeters: { type: 'NUMBER', description: 'Metres east of the anchor (negative for west).' },
                        northMeters: { type: 'NUMBER', description: 'Metres north of the anchor (negative for south).' },
                        headingDeg: { type: 'NUMBER', description: 'Compass heading the object\'s front faces, degrees clockwise from north (0 north, 90 east, 180 south, 270 west).' },
                        upMeters: { type: 'NUMBER', description: 'Optional height of the object\'s base above the surface at that spot (0, the default, rests it on the ground or roof there).' }
                    },
                    required: ['eastMeters', 'northMeters', 'headingDeg']
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

/** Where the object stands in the staged scene (tile frame: x east, y up, z south; origin at the anchor's street level). */
export interface ObjectPlacement {
    eastMeters: number;
    northMeters: number;
    headingDeg: number;
    upMeters: number;
    /** Scene position of the object's base. */
    sceneX: number;
    sceneZ: number;
    /** Rotation about +Y that turns the object's front (+Z) to the heading. */
    yawDeg: number;
    /** Height of the highest staged surface at that spot, measured from the tiles. */
    surfaceYMeters: number;
}

function repoRoot(): string {
    return process.env.SCRATCHBOX_ROOT || (fs.existsSync(path.resolve(process.cwd(), 'packages')) ? process.cwd() : path.resolve(process.cwd(), '..'));
}

function failed(message: string, details: Record<string, unknown> = {}): ToolHandlerOutcome {
    return {
        status: 'failed',
        summaryResult: `Failed: ${message}`,
        resultPayload: { status: 'failed', success: false, error: message, ...details }
    };
}

function parseDimensions(value: unknown): Vec3 | undefined | 'invalid' {
    if (value === undefined || value === null) return undefined;
    if (Array.isArray(value) && value.length === 3 && value.every(v => typeof v === 'number' && Number.isFinite(v) && v > 0)) {
        return [value[0], value[1], value[2]];
    }
    return 'invalid';
}

type PlacementArgs = Pick<ObjectPlacement, 'eastMeters' | 'northMeters' | 'headingDeg' | 'upMeters'>;

function parsePlacement(value: unknown): PlacementArgs | undefined | string {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'object' || Array.isArray(value)) return 'placement must be an object {eastMeters, northMeters, headingDeg, upMeters?}.';
    const v = value as Record<string, unknown>;
    const num = (key: string) => typeof v[key] === 'number' && Number.isFinite(v[key] as number) ? v[key] as number : undefined;
    const east = num('eastMeters'), north = num('northMeters'), heading = num('headingDeg');
    const up = v.upMeters === undefined || v.upMeters === null ? 0 : num('upMeters');
    if (east === undefined || north === undefined || heading === undefined) return 'placement needs eastMeters, northMeters and headingDeg as numbers.';
    if (up === undefined || up < 0) return 'placement.upMeters must be a number of at least 0.';
    if (Math.hypot(east, north) > 5000) return 'placement is more than 5 km from the anchor; give metres from the place, not coordinates.';
    return { eastMeters: east, northMeters: north, headingDeg: heading, upMeters: up };
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
async function stage(location: string, ctx: ToolContext, handler: ToolHandler): Promise<{ artifact: any; payload: Record<string, unknown> }> {
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
    return { artifact: payload.artifact, payload };
}

/** Local file behind a served /models/... URI. */
function modelFile(uri: string, modelsDirs: string[]): string | undefined {
    const match = /^\/models\/(.+)$/.exec(uri);
    if (!match) return fs.existsSync(uri) ? uri : undefined;
    const rel = decodeURIComponent(match[1]);
    for (const dir of modelsDirs) {
        const file = path.resolve(dir, rel);
        if (file.startsWith(path.resolve(dir) + path.sep) && fs.existsSync(file)) return file;
    }
    return undefined;
}

/** Height of the highest triangle of the soup straight above or below (x, z), or undefined when none covers it. */
export function surfaceHeightAt(glb: Buffer, x: number, z: number): number | undefined {
    const soup = glbToTriangleSoup(glb, { colors: false });
    if (!soup) return undefined;
    const p = soup.positions, idx = soup.indices;
    let best: number | undefined;
    for (let t = 0; t < idx.length; t += 3) {
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

/**
 * Works out where the object stands on the staged tiles and checks there is something to stand on, by reading the
 * staged environment models (role environment / ground) the scene will show.
 */
function placeOnStagedTiles(artifact: any, args: PlacementArgs, modelsDirs: string[]): ObjectPlacement {
    const sceneX = args.eastMeters, sceneZ = -args.northMeters;
    const environment = (Array.isArray(artifact?.data?.objects) ? artifact.data.objects : [])
        .filter((o: any) => o?.content?.metadata?.role === 'environment' || o?.content?.metadata?.isGround === true)
        .map((o: any) => String(o?.content?.durableUri || ''))
        .filter((uri: string) => /\.glb($|\?)/i.test(uri));
    if (environment.length === 0) throw new Error('the staged scene has no ground model to place the object on');
    let surface: number | undefined;
    for (const uri of environment) {
        const file = modelFile(uri.replace(/\?.*$/, ''), modelsDirs);
        if (!file) throw new Error(`could not read the staged tiles ${uri} to place the object (looked in ${modelsDirs.join(', ')})`);
        const y = surfaceHeightAt(fs.readFileSync(file), sceneX, sceneZ);
        if (y !== undefined && (surface === undefined || y > surface)) surface = y;
    }
    if (surface === undefined) {
        throw new Error(`placement ${args.eastMeters} m east, ${args.northMeters} m north of the anchor is outside the staged tiles, so there is nothing to stand on there`);
    }
    return { ...args, sceneX, sceneZ, yawDeg: yawForHeading(args.headingDeg), surfaceYMeters: +surface.toFixed(3) };
}

export function createObjectReferenceHandlers(deps: ObjectReferenceToolDeps = {}): Record<string, ToolHandler> {
    return {
        build_3d_object_from_reference: async (args, ctx): Promise<ToolHandlerOutcome> => {
            const request = typeof args.request === 'string' ? args.request.trim() : '';
            if (!request) return failed('build_3d_object_from_reference needs a request describing what to build.');
            const dimensions = parseDimensions(args.dimensionsHintMeters);
            if (dimensions === 'invalid') return failed('dimensionsHintMeters must be three positive numbers [width, height, depth] in metres.');
            const location = typeof args.location === 'string' && args.location.trim() ? args.location.trim() : undefined;
            const placementArgs = parsePlacement(args.placement);
            if (typeof placementArgs === 'string') return failed(placementArgs);
            if (placementArgs && !location) return failed('placement is relative to a place: pass location with it, or drop placement for a studio void.');

            const modelsDir = deps.publicModelsDir ?? path.resolve(repoRoot(), 'public/models');
            const modelsDirs = [...new Set([modelsDir, path.resolve(process.cwd(), 'public/models'), path.resolve(process.cwd(), '..', 'public/models')])];

            let staged: { artifact: any; payload: Record<string, unknown> } | undefined;
            let placement: ObjectPlacement | undefined;
            if (location) {
                try {
                    staged = await stage(location, ctx, deps.stageAtLocation ?? google3DTilesHandlers.google_3d_tiles_get_clay);
                } catch (err) {
                    return failed(errorMessage(err), { stage: 'staging', location });
                }
                try {
                    placement = placeOnStagedTiles(staged.artifact, placementArgs ?? { eastMeters: 0, northMeters: 0, headingDeg: 180, upMeters: 0 }, modelsDirs);
                } catch (err) {
                    return failed(`Placing the object at ${location} failed: ${errorMessage(err)}`, { stage: 'placement', location });
                }
            }

            let result: ReferenceObjectBuildResult;
            try {
                result = await (deps.build ?? buildObjectFromReference)({
                    request,
                    requestedModel: ctx.request?.model || undefined,
                    dimensionsHintMeters: dimensions,
                    signal: ctx.signal,
                    reportProgress: ctx.reportProgress
                }, deps.builder);
            } catch (err) {
                if (err instanceof ReferenceObjectBuildError) {
                    return failed(err.message, { stage: err.stage, ...err.details });
                }
                return failed(errorMessage(err));
            }

            // Publish the GLB where the viewport serves models; the reference never touches disk.
            const fileName = path.basename(result.glbPath);
            const publishedPath = path.join(modelsDir, fileName);
            try {
                fs.mkdirSync(modelsDir, { recursive: true });
                fs.writeFileSync(publishedPath, result.glb);
            } catch (err) {
                return failed(`The object was built (${result.glbPath}) but could not be published to ${publishedPath}: ${errorMessage(err)}`, { stage: 'publish', glbPath: result.glbPath });
            }
            const modelUri = `/models/${fileName}`;

            const checks = result.checks;
            const bodiesNote = checks.connectivity.bodies === 1 ? 'one connected piece' : `${checks.connectivity.bodies} separate pieces as intended`;
            const remaining = result.remainingDifferences.map(d => (d.partId ? `part "${d.partId}": ` : '') + d.problem);
            const subject = result.spec.subject.trim() || request;
            const objectBuild = {
                spec: result.spec,
                imageModel: result.imageModel,
                visionModel: result.visionModel,
                backend: result.backend,
                passes: result.passes,
                resultPass: result.resultPass,
                ...(result.revisionFailed ? { revisionFailed: result.revisionFailed } : {}),
                remainingDifferences: result.remainingDifferences,
                ...(result.openProblems.length ? { openProblems: result.openProblems } : {}),
                checks: {
                    vertexCount: checks.vertexCount,
                    triangleCount: checks.triangleCount,
                    parts: checks.parts,
                    missingParts: checks.missingParts,
                    detachedParts: checks.detachedParts,
                    connectivity: checks.connectivity,
                    differences: checks.differences,
                    builtBoundingMeters: checks.builtBoundingMeters
                },
                ...(placement ? { placement } : {})
            };
            // The base sits on the ground (y 0 lets the viewport seat it on the surface there) unless lifted.
            const heroY = placement && placement.upMeters > 0 ? +(placement.surfaceYMeters + placement.upMeters).toFixed(3) : 0;
            const heroObject = {
                id: `hero-${Date.now()}`,
                content: {
                    type: '3d-model',
                    durableUri: modelUri,
                    mimeType: 'model/gltf-binary',
                    metadata: {
                        role: 'hero',
                        description: subject,
                        source: 'build_3d_object_from_reference',
                        originalPath: result.glbPath,
                        metricScale: 1.0,
                        groundSnapped: heroY === 0
                    }
                },
                space: { spatial3d: placement ? { x: placement.sceneX, y: heroY, z: placement.sceneZ, yaw: placement.yawDeg } : { x: 0, y: 0, z: 0 } },
                time: { startMs: 0, durationMs: 20000 },
                lineage: { version: 1 }
            };
            const pythonGenerator = {
                enabled: true,
                filename: 'object_spec_build.py',
                sourceCode: result.sourceCode,
                glbBase64: result.glb.toString('base64'),
                glbPath: result.glbPath,
                lastCompiledTimeMs: Date.now()
            };
            const summaryLine = `Native clay build from an internal reference: ${checks.vertexCount.toLocaleString()} vertices, ${result.spec.parts.length} parts.`;

            let artifact: Record<string, unknown>;
            if (staged && placement) {
                const tileData = (staged.artifact.data || {}) as Record<string, unknown>;
                const place = String(staged.payload.resolvedAddress || location);
                const base: Vec3 = [placement.sceneX, placement.surfaceYMeters + placement.upMeters, placement.sceneZ];
                artifact = {
                    ...staged.artifact,
                    id: `artifact-3d-${Date.now()}`,
                    title: `${subject} at ${place}`,
                    summary: `${summaryLine} Staged on remeshed Google 3D Tiles in clay at ${place}.`,
                    data: {
                        ...tileData,
                        title: `${subject} at ${place}`,
                        subtitle: summaryLine,
                        renderMode: 'clay',
                        cameraMode: 'orbit',
                        camera: frameCamera(checks.builtBoundingMeters, base, placement.yawDeg),
                        objects: [...(Array.isArray(tileData.objects) ? tileData.objects : []), heroObject],
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

            const backendName = result.backend === 'vertex' ? 'Vertex AI' : result.backend === 'api-key' ? 'the Gemini API key' : 'an injected client';
            const modelsLine = `Reference drawn internally by ${describeImageModel(result.imageModel)} (not saved or shown); spec read by ${describeVisionModel(result.visionModel)}, via ${backendName}.`;
            const lastPass = result.passes[result.passes.length - 1].pass;
            const resultLine = result.revisionFailed
                ? `Revision pass ${result.revisionFailed.pass} failed (${result.revisionFailed.stage}: ${result.revisionFailed.reason}), so the result is pass ${result.resultPass}, the last build that passed every check.`
                : result.resultPass !== lastPass
                    ? `The result is pass ${result.resultPass}.`
                    : '';
            const placeLine = staged && placement
                ? `Staged at ${String(staged.payload.resolvedAddress || location)} on remeshed Google 3D Tiles in clay, ${placement.eastMeters} m east and ${placement.northMeters} m north of the anchor, facing ${placement.headingDeg} degrees; the surface there is ${placement.surfaceYMeters} m above the anchor's street level${placement.surfaceYMeters > 3 ? ' (likely a roof or raised structure)' : ''}.`
                : 'Shown in a studio grey clay void.';
            const summary = [
                `Built "${subject}" as native clay geometry: ${checks.vertexCount.toLocaleString()} vertices, ${checks.triangleCount.toLocaleString()} triangles, ${checks.parts.filter(p => p.built).length} of ${checks.parts.length} listed parts built and attached, ${bodiesNote}, ${checks.builtBoundingMeters.join(' x ')} m, after ${result.passes.length} pass${result.passes.length === 1 ? '' : 'es'}.`,
                resultLine,
                modelsLine,
                remaining.length
                    ? `Differences from the reference that remain in pass ${result.resultPass}: ${remaining.map(r => `"${r}"`).join('; ')}.`
                    : `The clay render of pass ${result.resultPass} matched the reference with no high-confidence differences.`,
                result.openProblems.length ? `Also unresolved: ${result.openProblems.join(' ')}` : '',
                placeLine,
                'To change it, edit SPEC in pythonGenerator.sourceCode and run that script with execute_3d_python_script.'
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
                    vertexCount: checks.vertexCount,
                    triangleCount: checks.triangleCount,
                    partCount: result.spec.parts.length,
                    imageModel: result.imageModel,
                    visionModel: result.visionModel,
                    backend: result.backend,
                    passes: result.passes,
                    resultPass: result.resultPass,
                    ...(result.revisionFailed ? { revisionFailed: result.revisionFailed } : {}),
                    remainingDifferences: result.remainingDifferences,
                    checks: objectBuild.checks,
                    ...(staged ? { location: { query: location, resolvedAddress: staged.payload.resolvedAddress, geoAnchor: staged.payload.geoAnchor, placement } } : {}),
                    artifact
                }
            };
        }
    };
}

export const objectReferenceHandlers: Record<string, ToolHandler> = createObjectReferenceHandlers();
