/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * build_3d_object_from_reference: an object or abstract form asked for in words becomes native clay geometry
 * (reference-object-builder.ts). With a location, the object is staged on the same geocoded, remeshed clay tiles
 * that google_3d_tiles_get_clay returns, and a staging failure fails the call. The result carries the build script
 * and the spec for later edits, never the reference image.
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
    type ReferenceObjectBuilderDeps
} from '../../3d-engine/reference-object-builder';
import { errorMessage } from '../gemini-client';
import type { Vec3 } from '../../../common/spatial/object-build-spec';

export const OBJECT_REFERENCE_TOOL_DECLARATIONS: ToolDeclaration[] = [
    {
        name: 'build_3d_object_from_reference',
        description: 'Build a specific object, prop, vehicle, creature, character, artifact or abstract form as native 3D geometry in studio grey clay. ' +
            `It draws an internal reference picture with Nano Banana Lite (${REFERENCE_IMAGE_MODEL}; never shown or saved), reads it with the chat model into a metric build spec of swept, revolved, replicated and relief parts, builds that in the native Python engine, and checks detail, part connections and the match with the reference (up to two revisions). ` +
            'Use it for anything to build that is not a real-world place; for a place use google_3d_tiles_get_clay. To put the object at a real place, pass location. ' +
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
    /** Where the built GLB is published for the viewport (/models/...). */
    publicModelsDir?: string;
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

/** The model that answered; when the API names a different version than the one requested, both are given. */
function describeModel(use: ModelUse): string {
    return use.answered === use.requested ? use.requested : `${use.requested} (the API reports ${use.answered} answered)`;
}

/** Camera that frames the built object from a three-quarter view. */
function frameCamera(bounds: Vec3): { position: Vec3; target: Vec3; fov: number } {
    const fov = 45;
    const radius = Math.max(0.05, Math.hypot(bounds[0], bounds[1], bounds[2]) / 2);
    const distance = (radius / Math.sin((fov * Math.PI) / 360)) * 1.15;
    const target: Vec3 = [0, bounds[1] / 2, 0];
    return {
        position: [target[0] + distance * 0.55, target[1] + distance * 0.4, target[2] + distance * 0.75],
        target,
        fov
    };
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

export function createObjectReferenceHandlers(deps: ObjectReferenceToolDeps = {}): Record<string, ToolHandler> {
    return {
        build_3d_object_from_reference: async (args, ctx): Promise<ToolHandlerOutcome> => {
            const request = typeof args.request === 'string' ? args.request.trim() : '';
            if (!request) return failed('build_3d_object_from_reference needs a request describing what to build.');
            const dimensions = parseDimensions(args.dimensionsHintMeters);
            if (dimensions === 'invalid') return failed('dimensionsHintMeters must be three positive numbers [width, height, depth] in metres.');
            const location = typeof args.location === 'string' && args.location.trim() ? args.location.trim() : undefined;

            let staged: { artifact: any; payload: Record<string, unknown> } | undefined;
            if (location) {
                try {
                    staged = await stage(location, ctx, deps.stageAtLocation ?? google3DTilesHandlers.google_3d_tiles_get_clay);
                } catch (err) {
                    return failed(errorMessage(err), { stage: 'staging', location });
                }
            }

            let result: ReferenceObjectBuildResult;
            try {
                result = await (deps.build ?? buildObjectFromReference)({
                    request,
                    visionModel: ctx.request?.model || '',
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
            const modelsDir = deps.publicModelsDir ?? path.resolve(repoRoot(), 'public/models');
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
            const remaining = result.remainingDifferences.map(d => (d.partId ? `${d.partId}: ` : '') + d.problem);
            const subject = result.spec.subject.trim() || request;
            const objectBuild = {
                spec: result.spec,
                imageModel: result.imageModel,
                visionModel: result.visionModel,
                backend: result.backend,
                passes: result.passes,
                checks: {
                    gate: { passed: checks.gate.passed, totalVertices: checks.gate.totalVertices, totalTriangles: checks.gate.totalTriangles, violations: checks.gate.violations },
                    connectivity: checks.connectivity,
                    differences: checks.differences,
                    builtBoundingMeters: checks.builtBoundingMeters
                }
            };
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
                        groundSnapped: true
                    }
                },
                space: { spatial3d: { x: 0, y: 0, z: 0 } },
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
            const summaryLine = `Native clay build from an internal reference: ${checks.gate.totalVertices.toLocaleString()} vertices, ${result.spec.parts.length} parts.`;

            let artifact: Record<string, unknown>;
            if (staged) {
                const tileData = (staged.artifact.data || {}) as Record<string, unknown>;
                const place = String(staged.payload.resolvedAddress || location);
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
                        camera: frameCamera(checks.builtBoundingMeters),
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

            const modelsLine = `Reference drawn internally by ${describeModel(result.imageModel)} (not saved or shown); spec read by ${describeModel(result.visionModel)} via ${result.backend === 'vertex' ? 'Vertex AI' : result.backend === 'api-key' ? 'the Gemini API key' : 'an injected client'}.`;
            const summary = [
                `Built "${subject}" as native clay geometry: ${checks.gate.totalVertices.toLocaleString()} vertices, ${checks.gate.totalTriangles.toLocaleString()} triangles, ${result.spec.parts.length} parts, ${bodiesNote}, ${checks.builtBoundingMeters.join(' x ')} m, after ${result.passes.length} pass${result.passes.length === 1 ? '' : 'es'}.`,
                modelsLine,
                remaining.length ? `Differences from the reference that remain: ${remaining.join('; ')}.` : 'The final clay render matched the reference with no high-confidence differences.',
                staged ? `Staged at ${String(staged.payload.resolvedAddress || location)} on remeshed Google 3D Tiles in clay.` : 'Shown in a studio grey clay void.',
                'To change it, edit SPEC in pythonGenerator.sourceCode and run that script with execute_3d_python_script.'
            ].join(' ');

            return {
                status: 'completed',
                summaryResult: summary,
                resultPayload: {
                    status: 'completed',
                    success: true,
                    summary,
                    glbPath: publishedPath,
                    modelUri,
                    vertexCount: checks.gate.totalVertices,
                    triangleCount: checks.gate.totalTriangles,
                    partCount: result.spec.parts.length,
                    imageModel: result.imageModel,
                    visionModel: result.visionModel,
                    backend: result.backend,
                    passes: result.passes,
                    checks: objectBuild.checks,
                    ...(remaining.length ? { visualIssues: remaining } : {}),
                    ...(staged ? { location: { query: location, resolvedAddress: staged.payload.resolvedAddress, geoAnchor: staged.payload.geoAnchor } } : {}),
                    artifact
                }
            };
        }
    };
}

export const objectReferenceHandlers: Record<string, ToolHandler> = createObjectReferenceHandlers();
