/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { PRIMITIVE_TYPES, normalizePrimitiveType, type CanvasArtifact, type ArtifactData, type Scene3DData, type PrimitiveType } from '../../../browser/generative-canvas/canvas-types';
import { UNTITLED_DOCUMENT_TITLE, modelDocumentSections, modelSandboxFiles, normalizeModelVideoTimeline } from '../artifact-synthesis';
import { morphArtifact } from '../../../browser/generative-canvas/primitive-transformer-engine';
import { NativePythonRunnerService } from '../../3d-engine/native-python-runner-service';
import { formatSbApiErrors, sbTypeCheckMetadata, typeCheckSbScript } from '../../3d-engine/sb-script-typecheck';
import { SB_API_VERSION } from '../../3d-engine/sb-api.generated';
import { NativeCppCompilerService } from '../../3d-engine/native-compiler-service';
import { DirectDispatchOperatorEngine, type BatchCommand } from '../../../browser/generative-canvas/services/direct-dispatch-operator-engine';
import * as fs from 'fs';
import * as path from 'path';
import { glbToTriangleSoup } from '../../3d-engine/part-connectivity';
import { measureGlbBase64MeshCounts } from '../../../common/glb-mesh-counts';
import { primitiveOutOfScopeReason } from '../../../common/product-scope';
import { auditModelAgainstRequest, callVisionModel } from '../../3d-engine/visual-review';
import type { ToolDeclaration, ToolHandler } from './types';
import { applyFirstPassBaseline, firstPassRenderMode, keepOpenSceneRenderMode } from '../scene3d-first-pass-baseline';
import { isDrawableSceneObject, undrawableSceneObjects } from '../../../browser/generative-canvas/primitives/scene3d/syncSceneContent';
import { liveTilesAnchorProblem, sceneAsksForLiveTiles } from '../../../browser/generative-canvas/primitives/scene3d/liveTilesAnchor';

function asString(val: unknown): string {
    return typeof val === 'string' ? val : '';
}

/**
 * Whether a 3d-scene declares anything the viewport draws, judged as the viewport judges it: an object it loads
 * (a .glb / .gltf model or a .splat / .spz splat; see isDrawableSceneObject), a splat file (splatUrl), a generator
 * with its model inline (glbBase64) or its source, a live three.js script, or live tiles (a geoAnchor or a map-3d
 * object) at an anchor the tiles layer accepts (see liveTilesAnchorProblem). A generator known only by a server file
 * path (glbPath) is not loaded by the viewport. A scene with none of these would mount as an empty "No geometry"
 * viewport.
 */
export function sceneDeclaresContent(scene: Partial<Scene3DData>): boolean {
    const objects = Array.isArray(scene.objects) ? scene.objects : [];
    const tiles = { geoAnchor: scene.geoAnchor, objects };
    return !!(
        objects.some(isDrawableSceneObject)
        || scene.splatUrl
        || scene.pythonGenerator?.glbBase64 || scene.pythonGenerator?.sourceCode?.trim()
        || scene.cppGenerator?.glbBase64 || scene.cppGenerator?.sourceCode?.trim()
        || (scene.customScript || scene.code || '').trim()
        || (sceneAsksForLiveTiles(tiles) && liveTilesAnchorProblem(tiles) === null)
    );
}

export const CANVAS_TOOL_DECLARATIONS: ToolDeclaration[] = [
    {
        name: 'mount_canvas_primitive',
        description: 'Mount or update an interactive visual canvas primitive on the stage (3D scene, video timeline, live code sandbox, kanban board, markdown document, or node graph). Use this tool whenever the user asks to create, build, design, edit, or visualize something.',
        parameters: {
            type: 'OBJECT',
            properties: {
                primitiveType: {
                    type: 'STRING',
                    description: 'The type of canvas primitive: "3d-scene", "video-timeline", "live-code-sandbox", "kanban-board", "markdown-document", "metric-dashboard", or "node-graph"'
                },
                title: {
                    type: 'STRING',
                    description: 'The user-facing title of the canvas primitive'
                },
                summary: {
                    type: 'STRING',
                    description: 'Brief 1-2 sentence description of what was synthesized'
                },
                payloadJson: {
                    type: 'STRING',
                    description: 'The primitive data as one JSON object written out in a string: send it here (it keeps nested objects, such as each scene object\'s content {durableUri, mimeType} and space {spatial3d}). Everything said under payload applies to it; when both are given this one is used.'
                },
                payload: {
                    type: 'OBJECT',
                    description: 'Prefer payloadJson: nested objects sent here can arrive empty. The strongly-typed primitive data (Scene3DData, VideoTimelineData, SandboxData, KanbanData, DocumentData, or GraphData). For "3d-scene", you can supply payload.script (or payload.pythonGenerator.sourceCode) with procedural Python code importing scratchbox as sb to compile native C++20 geometry and stream binary .glb directly into the viewport. If the script fails or writes no model, the call fails with the interpreter\'s error output and nothing is mounted. A mount starts a new canvas artifact, so the scene must declare something the viewport draws (objects whose content.durableUri is a .glb / .gltf model or a .splat / .spz splat, a script, a generator GLB as glbBase64, a splatUrl, a customScript or a geoAnchor {lat, lng} for live tiles); an object the viewport cannot draw, or a geoAnchor that is 0, 0, out of range or not numbers, fails the mount, and payload.customMeshes (client-side primitive meshes) are refused. A first 3D scene is always built in grey clay (renderMode "clay"); while a scene is open its render mode is kept unless you set payload.renderMode, so set "pbr" only when the user asks for colours, textures or materials. For "markdown-document", send payload.sections (or the document as markdown in payload.markdown); a document with neither is not mounted. For "live-code-sandbox", send payload.files as [{name, language, content}] holding the code of the app (one file isEntry: true); a sandbox with no file content is not mounted.'
                }
            },
            // payloadJson or payload: the handler says which is missing
            required: ['primitiveType', 'title']
        }
    },
    {
        name: 'morph_canvas_primitive',
        description: 'Convert the currently active canvas primitive on the stage into a different primitive VIEW of the same underlying content — e.g. show a 3D scene\'s existing meshes as a node graph, a document as a kanban board, a node graph back as a 3D scene. This projects the real structured data already on stage; it never regenerates or invents new content. Use this whenever the user asks to "view/show/convert/switch this as/to" a different primitive type. Do NOT use mount_canvas_primitive for this — that creates something new instead of re-viewing what is already there.',
        parameters: {
            type: 'OBJECT',
            properties: {
                targetType: {
                    type: 'STRING',
                    description: 'The primitive type to morph the active artifact into: "3d-scene", "node-graph", "kanban-board", "markdown-document", "metric-dashboard", or "live-code-sandbox"'
                }
            },
            required: ['targetType']
        }
    },
    {
        name: 'ask_user_question',
        description: 'Ask the user a structured multiple-choice clarifying question with radio/checkbox choices and an optional recommended path. Use when user intent is ambiguous, when deciding between alternative asset approaches (e.g. 3D blockout vs procedural C++ mesh vs neural Gaussian splat), or when confirming creative preferences.',
        parameters: {
            type: 'OBJECT',
            properties: {
                title: {
                    type: 'STRING',
                    description: 'Headline for the question card (e.g. "Select 3D Asset Format & Pipeline")'
                },
                questions: {
                    type: 'ARRAY',
                    description: 'Array of questions to present to the user',
                    items: {
                        type: 'OBJECT',
                        properties: {
                            id: { type: 'STRING' },
                            prompt: { type: 'STRING', description: 'The question text to display' },
                            allow_multiple: { type: 'BOOLEAN', description: 'Whether multiple options can be chosen' },
                            options: {
                                type: 'ARRAY',
                                items: {
                                    type: 'OBJECT',
                                    properties: {
                                        id: { type: 'STRING' },
                                        label: { type: 'STRING', description: 'Short display text for this option' },
                                        description: { type: 'STRING', description: 'Technical trade-off or engine details' },
                                        isRecommended: { type: 'BOOLEAN', description: 'Whether this is the recommended path' }
                                    },
                                    required: ['id', 'label']
                                }
                            }
                        },
                        required: ['id', 'prompt', 'options']
                    }
                }
            },
            required: ['questions']
        }
    },
    {
        name: 'update_task_list',
        description: 'Keep a visible checklist of the work for a multi-step task. Call it once you understand the task (all items pending, the first in_progress), then again each time an item starts or finishes, sending the whole list every time. Exactly one item should be in_progress while you work. Mark an item completed only after you have checked the result, not when you have merely attempted it. Skip it for single-step requests.',
        parameters: {
            type: 'OBJECT',
            properties: {
                tasks: {
                    type: 'ARRAY',
                    items: {
                        type: 'OBJECT',
                        properties: {
                            title: { type: 'STRING', description: 'Short imperative description of the item' },
                            status: { type: 'STRING', enum: ['pending', 'in_progress', 'completed'] }
                        },
                        required: ['title', 'status']
                    }
                }
            },
            required: ['tasks']
        }
    },
    {
        name: 'present_execution_plan',
        description: 'Present a structured execution plan card for user review and explicit confirmation before initiating complex, multi-step, or compute-heavy 3D/VFX/code tasks. Lists steps and deliverables, and offers [Confirm & Execute] and [Adjust Plan] actions.',
        parameters: {
            type: 'OBJECT',
            properties: {
                title: { type: 'STRING', description: 'Title of the execution plan' },
                goal: { type: 'STRING', description: 'Core user objective being solved' },
                deliverables: {
                    type: 'ARRAY',
                    items: {
                        type: 'OBJECT',
                        properties: {
                            canvasType: { type: 'STRING', description: '3d-scene, video-timeline, live-code-sandbox, etc.' },
                            assetFormat: { type: 'STRING', description: 'e.g. .glb, .mp4, .otio, React TSX' },
                            description: { type: 'STRING', description: 'What this deliverable accomplishes' }
                        },
                        required: ['canvasType', 'description']
                    }
                },
                steps: {
                    type: 'ARRAY',
                    items: {
                        type: 'OBJECT',
                        properties: {
                            id: { type: 'STRING' },
                            title: { type: 'STRING' },
                            description: { type: 'STRING' },
                            engine: { type: 'STRING', description: 'Specific engine, e.g. C++20 Astro, Omni 1.1, Three.js' }
                        },
                        required: ['id', 'title']
                    }
                },
                estimatedLatency: { type: 'STRING', description: 'Estimated time (e.g. "Instant (<100ms)" or "~15-30s")' },
                openQuestions: {
                    type: 'ARRAY',
                    items: { type: 'STRING' },
                    description: 'Optional open questions or assumptions'
                }
            },
            required: ['title', 'goal', 'steps']
        }
    },
    {
        name: 'scene_3d_dispatch_operators',
        description: 'Dispatches high-performance in-memory 3D scene operators against the active 3D canvas stage via DirectDispatchOperatorEngine. Runs on the scene data: transforms (sb_set_transform, sb_translate, sb_rotate, sb_scale), PBR material properties (sb_set_material_pbr), lighting and sun (sb_setup_lighting, sb_set_diurnal_time_of_day), physics and keyframes (sb_add_physics, sb_insert_keyframe), camera framing (sb_set_camera, sb_frame_bounds), and a colour harmony grade on the viewport (sb_set_color_harmony: the objects\' hues moved toward a hue template; sb_set_look_match: the strength of, or clearing, a look the user matched from a reference photo), without re-compiling geometry. Operators that edit mesh geometry need the live 3D viewport and fail here with errorCode not_available_here.',
        parameters: {
            type: 'OBJECT',
            properties: {
                commands: {
                    type: 'ARRAY',
                    description: 'Ordered list of operator commands to execute.',
                    items: {
                        type: 'OBJECT',
                        properties: {
                            operator: {
                                type: 'STRING',
                                description: 'Operator name (e.g. "sb_set_transform", "sb_set_material_pbr", "sb_setup_lighting", "sb_set_diurnal_time_of_day", "sb_frame_bounds")'
                            },
                            params: {
                                type: 'OBJECT',
                                description: 'Parameters specific to the operator'
                            }
                        },
                        required: ['operator']
                    }
                },
                atomic: {
                    type: 'BOOLEAN',
                    description: 'Whether to rollback all changes if any single operator fails (default true).'
                }
            },
            required: ['commands']
        }
    },
    {
        name: 'audit_3d_scene_viewport',
        description: 'Check the finished 3D model against the user\'s request by rendering the actual model file from four angles in its real material colors and having a vision model inspect the images. Returns the requirements it confirmed, the problems it saw, and the paths of the renders. Use it before telling the user a 3D model is done, and fix any problems it reports.',
        parameters: {
            type: 'OBJECT',
            properties: {
                targetPrompt: {
                    type: 'STRING',
                    description: 'Every requirement the model must meet, in the user\'s words: parts, counts, materials, colors, proportions. Include requirements from earlier messages, not just the latest one.'
                }
            }
        }
    }
];

export const canvasHandlers: Record<string, ToolHandler> = {
    async mount_canvas_primitive(args, _ctx) {
        // The model names the primitive; an alias maps to its primitive, and prompt words never re-type it.
        const requestedType = asString(args.primitiveType);
        const primitiveType = normalizePrimitiveType(requestedType);
        if (!primitiveType) {
            const error = requestedType
                ? `Unknown primitiveType "${requestedType}". Use one of: ${PRIMITIVE_TYPES.join(', ')}.`
                : `primitiveType is required. Use one of: ${PRIMITIVE_TYPES.join(', ')}.`;
            return {
                status: 'failed',
                resultPayload: { success: false, error },
                summaryResult: `Failed: ${error}`
            };
        }
        const outOfScope = primitiveOutOfScopeReason(primitiveType);
        if (outOfScope) {
            return { status: 'failed', resultPayload: { success: false, error: outOfScope }, summaryResult: `Failed: ${outOfScope}` };
        }
        let title = asString(args.title) || 'Visual Creation';
        let summary = asString(args.summary) || `Synthesized ${title} on visual canvas.`;
        // The payload is the primitive's data as the model wrote it; anything else fails the call so the model can resend it.
        // payloadJson (a string) comes first: an untyped OBJECT parameter loses its nested objects in Gemini's function
        // calling (they arrive as {} or as numbers), so a scene object's content and space only survive written as JSON.
        let rawPayload: unknown = args.payload;
        if (typeof args.payloadJson === 'string' && args.payloadJson.trim()) {
            try {
                rawPayload = JSON.parse(args.payloadJson);
            } catch (err) {
                const error = `payloadJson is not valid JSON (${(err as Error).message}); send the ${primitiveType} data as one JSON object. Nothing was mounted.`;
                return { status: 'failed', resultPayload: { success: false, error }, summaryResult: `Failed: ${error}` };
            }
        }
        if (!rawPayload || typeof rawPayload !== 'object' || Array.isArray(rawPayload)) {
            const got = rawPayload === undefined ? 'nothing' : Array.isArray(rawPayload) ? 'an array' : `a ${typeof rawPayload}`;
            const error = `payload must be a JSON object holding the ${primitiveType} data (send it written out as payloadJson); got ${got}. Nothing was mounted.`;
            return { status: 'failed', resultPayload: { success: false, error }, summaryResult: `Failed: ${error}` };
        }
        let payload = rawPayload as ArtifactData;

        const prompt = _ctx?.request?.prompt || '';

        if (primitiveType === 'video-timeline') {
            // The model's tracks, clips and media as sent; only editor state (fps, playhead, zoom) is defaulted.
            const timelineData = normalizeModelVideoTimeline(payload as Record<string, any>, title !== 'Visual Creation' ? title : undefined);
            payload = timelineData as any;
            title = timelineData.title;
            summary = asString(args.summary) || timelineData.subtitle || summary;
        } else if (primitiveType === 'markdown-document') {
            // The document's own sections or markdown; an empty document is not mounted (nothing fills it in).
            const p = payload as Record<string, any>;
            const sections = modelDocumentSections(p);
            if (sections.length === 0) {
                const error = 'The markdown-document payload has no content: send payload.sections (heading, paragraph, ... sections) or the document as markdown in payload.markdown. Nothing was mounted.';
                return { status: 'failed', resultPayload: { success: false, error }, summaryResult: `Failed: ${error}` };
            }
            const named = (t: unknown) => (typeof t === 'string' && t.trim() && t !== 'Markdown Document' ? t.trim() : undefined);
            const firstHeading = sections.find(s => s?.type === 'heading')?.content;
            const docTitle = named(p.title) || named(args.title) || named(firstHeading) || UNTITLED_DOCUMENT_TITLE;
            payload = { ...p, title: docTitle, sections } as any;
            title = docTitle;
        } else if (primitiveType === 'live-code-sandbox') {
            // The app's own files or nothing: an empty sandbox is not mounted (the sandbox has no app of its own).
            const files = modelSandboxFiles(payload);
            if (files.length === 0) {
                const error = 'The live-code-sandbox payload has no code: send payload.files as [{name, language, content}] with the files of the app (one marked isEntry: true). Nothing was mounted.';
                return { status: 'failed', resultPayload: { success: false, error }, summaryResult: `Failed: ${error}` };
            }
            const p = payload as Record<string, any>;
            const activeFileId = typeof p.activeFileId === 'string' && files.some(f => f.id === p.activeFileId) ? p.activeFileId : undefined;
            payload = { ...p, title: (typeof p.title === 'string' && p.title.trim()) || title, files, activeFileId } as any;
        } else if (primitiveType === '3d-scene') {
            const p = payload as any;

            // Client-side primitive meshes (box, sphere, cylinder ...) are not scene geometry (AGENTS.md Tier-0 ban).
            // They used to be dropped without a word while the mount reported success.
            if (Array.isArray(p.customMeshes) && p.customMeshes.length > 0) {
                const error = `payload.customMeshes (${p.customMeshes.length}) cannot be mounted: client-side primitive meshes are not used for scene geometry. Build the geometry with a Python script (payload.script, import scratchbox as sb) or execute_3d_python_script and mount the model it writes. Nothing was mounted.`;
                return { status: 'failed', resultPayload: { success: false, error }, summaryResult: `Failed: ${error}` };
            }

            // Geometry comes only from the model's payload. The prompt synthesizer's template generators drew
            // a domed tower and trees the model never asked for between the objects it placed.
            const pythonScript = p.pythonGenerator?.sourceCode || p.script || p.pythonScript || p.python;
            let pythonGlbBase64 = p.pythonGenerator?.glbBase64 || p.glbBase64;
            let pythonGlbPath = p.pythonGenerator?.glbPath || p.glbPath;

            let typeCheckMeta: ReturnType<typeof sbTypeCheckMetadata> | undefined;
            if (pythonScript && !pythonGlbBase64) {
                // Checked against the generated scratchbox stubs first: calls to names the API does not have go back
                // to the model without running; a check that could not finish lets the script run (logged).
                const typeCheck = await typeCheckSbScript(pythonScript);
                typeCheckMeta = sbTypeCheckMetadata(typeCheck);
                if (typeCheck.status === 'rejected') {
                    const error = `The scene's Python script was not run. ${formatSbApiErrors(typeCheck.errors)}`;
                    return {
                        status: 'failed',
                        resultPayload: { success: false, error, apiErrors: typeCheck.errors, typeCheck: typeCheckMeta },
                        summaryResult: `Failed: the scene's Python script calls ${typeCheck.errors.length} name(s) or argument(s) the scratchbox API does not have. ${typeCheck.errors.slice(0, 3).map(e => `line ${e.line}: ${e.message}`).join('; ')}`
                    };
                }
                if (typeCheck.status !== 'passed') {
                    console.warn(`[mount_canvas_primitive] scratchbox type check ${typeCheck.status} after ${typeCheck.durationMs}ms; running unchecked: ${typeCheck.note}`);
                }
                // The script is the scene's geometry: if it does not produce a model, nothing is mounted.
                let res: Awaited<ReturnType<NativePythonRunnerService['runScript']>>;
                try {
                    res = await NativePythonRunnerService.getInstance().runScript(pythonScript);
                } catch (e: any) {
                    const error = `The scene's Python script could not be run: ${e?.message || String(e)}`;
                    return { status: 'failed', resultPayload: { success: false, error }, summaryResult: `Failed: ${error}` };
                }
                if (!res.success || !res.glbBase64) {
                    const stderr = (res.errorDetails || res.stderr || '').trim();
                    const detail = stderr ? stderr.slice(-4000) : (res.success ? 'it ran but wrote no model (GLB)' : `exit code ${res.exitCode}`);
                    const error = `The scene's Python script failed: ${detail}`;
                    return {
                        status: 'failed',
                        resultPayload: { success: false, error, exitCode: res.exitCode, stderr: res.stderr },
                        summaryResult: `Failed: the scene's Python script did not produce a model. ${detail.split('\n').filter(Boolean).pop() || ''}`.trim()
                    };
                }
                pythonGlbBase64 = res.glbBase64;
                pythonGlbPath = res.glbPath;
            }

            let cppSource = p.cppGenerator?.sourceCode || p.cppSource;
            let cppGlbBase64 = p.cppGenerator?.glbBase64 || (!pythonGlbBase64 ? p.glbBase64 : undefined);
            let cppGlbPath = p.cppGenerator?.glbPath;

            if (cppSource) {
                return {
                    status: 'failed',
                    resultPayload: { success: false, error: 'Direct C++ generation via mount_canvas_primitive is deprecated and flawed. You MUST use the execute_3d_python_script tool for all 3D scene generation (import scratchbox as sb).' },
                    summaryResult: 'Failed: Attempted to use deprecated C++ generation path.'
                };
            }

            const pyGenerator = (pythonGlbBase64 || pythonScript) ? {
                enabled: true,
                filename: 'procedural_scene.py',
                sourceCode: pythonScript || p.pythonGenerator?.sourceCode || '',
                glbBase64: pythonGlbBase64,
                glbPath: pythonGlbPath,
                lastCompiledTimeMs: Date.now(),
                ...(typeCheckMeta ? { sbApiVersion: SB_API_VERSION, typeCheck: typeCheckMeta } : {})
            } : p.pythonGenerator;

            const cppGen = (cppGlbBase64 || cppSource) ? {
                enabled: true,
                filename: 'world_generator.cpp',
                sourceCode: cppSource || p.cppGenerator?.sourceCode || '',
                glbBase64: cppGlbBase64,
                glbPath: cppGlbPath,
                // Counts are measured from the GLB bytes; the payload's own numbers are not stored, and without bytes there are none.
                ...(cppGlbBase64 ? measureGlbBase64MeshCounts(cppGlbBase64) : undefined)
            } : p.cppGenerator;

            // The title is the model's too; the synthesizer's would name the tab after prompt keywords.
            title = p.title && p.title !== '4D Scene Workspace' ? p.title : (asString(args.title) || '3D Scene');
            summary = p.subtitle || summary;

            // Everything comes from the payload: no prompt synthesizer supplies a camera, lighting, render
            // settings, meshes, scripts, an anchor or splat files. Unset fields take the viewport's neutral studio
            // defaults and the first-pass baseline below.
            payload = {
                ...p,
                title,
                subtitle: summary,
                customMeshes: [],
                objects: Array.isArray(p.objects) ? p.objects : [],
                features: { ...(p.features || {}) },
                cppGenerator: cppGen,
                pythonGenerator: pyGenerator
            };
            const active3D = _ctx?.request?.activeArtifact?.type === '3d-scene' ? _ctx.request.activeArtifact.data as any : undefined;
            // A first scene opens textured (clay when the user asked for it); with a scene open, the open render mode
            // carries unless the payload sets one.
            payload = active3D
                ? keepOpenSceneRenderMode(payload as any, active3D.renderMode)
                : applyFirstPassBaseline(payload as any, prompt);

            // Objects the viewport would skip (internal:plane, an image, an .obj) would be reported as mounted while
            // nothing of them is drawn. Every object here is one the model sent, so the app's own placeholder URIs
            // (internal:mesh, internal:grid, internal:sunlight) are not exempt either.
            const undrawable = undrawableSceneObjects(payload as Scene3DData, { appPlaceholdersExempt: false });
            if (undrawable.length > 0) {
                const error = `${undrawable.length === 1 ? 'An object' : `${undrawable.length} objects`} in payload.objects cannot be drawn: ${undrawable.map(o => `${o.id} (${o.reason})`).join('; ')}. Each object's content.durableUri must be a .glb / .gltf model or a .splat / .spz splat the app serves; build geometry with a Python script (payload.script) or execute_3d_python_script. Nothing was mounted.`;
                return { status: 'failed', resultPayload: { success: false, error }, summaryResult: `Failed: ${error}` };
            }
            // Live tiles the scene asks for (geoAnchor or a map-3d object) at an anchor the tiles layer refuses would
            // mount as an error panel in the viewport.
            const anchorProblem = liveTilesAnchorProblem(payload as Scene3DData);
            if (anchorProblem) {
                const error = `The scene asks for live 3D tiles, but ${anchorProblem}, so the viewport cannot place them. Send the place's real latitude and longitude in payload.geoAnchor (resolve a place with google_3d_tiles_get_clay), or leave geoAnchor and map-3d objects out. Nothing was mounted.`;
                return { status: 'failed', resultPayload: { success: false, error }, summaryResult: `Failed: ${error}` };
            }
            // A generator known only by a server file path is not loaded by the viewport.
            const gen = (payload as Scene3DData).pythonGenerator;
            if (gen?.glbPath && !gen.glbBase64 && !gen.sourceCode?.trim() && !sceneDeclaresContent(payload as Scene3DData)) {
                const error = `pythonGenerator.glbPath (${gen.glbPath}) is a file on the server that the viewport does not load. Send the script (payload.script) so it runs here, or reference a served model in payload.objects. Nothing was mounted.`;
                return { status: 'failed', resultPayload: { success: false, error }, summaryResult: `Failed: ${error}` };
            }
            // A mount replaces the canvas: a scene that declares nothing to draw would be an empty viewport
            // reported as mounted.
            if (!sceneDeclaresContent(payload as Scene3DData)) {
                const error = 'The 3d-scene payload has no content to draw: send objects, a Python script (payload.script), a generator GLB, a splat (splatUrl), a customScript, or a geoAnchor {lat, lng} for live 3D tiles. To change the open scene (camera, lighting, materials), use scene_3d_dispatch_operators. Nothing was mounted.';
                return { status: 'failed', resultPayload: { success: false, error }, summaryResult: `Failed: ${error}` };
            }
        }

        const artifactId = `art-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        const artifact: CanvasArtifact = {
            id: artifactId,
            type: primitiveType,
            title,
            summary,
            data: payload,
            createdAt: new Date().toISOString(),
            version: 1
        };

        return {
            resultPayload: {
                status: 'success',
                artifactId,
                primitiveType,
                title,
                summary,
                artifact
            },
            summaryResult: `Mounted ${primitiveType} primitive: "${title}".`
        };
    },

    morph_canvas_primitive(args, _ctx) {
        const requestedTarget = asString(args.targetType);
        const targetType = normalizePrimitiveType(requestedTarget);
        const active = _ctx?.request?.activeArtifact;
        if (!active) {
            return {
                status: 'failed',
                resultPayload: { status: 'error', message: 'No active canvas primitive to convert. Mount something first, then ask to view it differently.' },
                summaryResult: 'No active artifact to morph.'
            };
        }
        if (!targetType) {
            const message = requestedTarget
                ? `Unknown targetType "${requestedTarget}". Use one of: ${PRIMITIVE_TYPES.join(', ')}.`
                : 'targetType is required.';
            return {
                status: 'failed',
                resultPayload: { status: 'error', message },
                summaryResult: requestedTarget ? `Failed: ${message}` : 'Missing targetType.'
            };
        }
        const outOfScope = primitiveOutOfScopeReason(targetType);
        if (outOfScope) {
            return { status: 'failed', resultPayload: { status: 'error', message: outOfScope }, summaryResult: `Failed: ${outOfScope}` };
        }
        if (active.type === targetType) {
            return {
                resultPayload: { status: 'success', artifactId: active.id, primitiveType: active.type, title: active.title, summary: active.summary, artifact: active },
                summaryResult: `"${active.title}" is already a ${targetType}.`
            };
        }

        const morphed = morphArtifact(active, targetType);

        return {
            resultPayload: {
                status: 'success',
                artifactId: morphed.id,
                primitiveType: morphed.type,
                title: morphed.title,
                summary: morphed.summary,
                artifact: morphed
            },
            summaryResult: `Converted "${active.title}" to a ${targetType} view: "${morphed.title}".`
        };
    },

    ask_user_question(args, _ctx) {
        const title = asString(args.title) || 'Clarification & Configuration Required';
        const questionsRaw = Array.isArray(args.questions) ? args.questions : [];
        const questionCard = {
            title,
            questions: questionsRaw.map((q: any) => ({
                id: asString(q.id) || `q-${Math.random().toString(36).slice(2, 6)}`,
                prompt: asString(q.prompt),
                allowMultiple: !!q.allow_multiple || !!q.allowMultiple,
                defaultOptionId: q.default_option || q.defaultOptionId,
                options: Array.isArray(q.options) ? q.options.map((opt: any) => ({
                    id: asString(opt.id),
                    label: asString(opt.label),
                    description: asString(opt.description),
                    isRecommended: !!opt.isRecommended || !!opt.recommended
                })) : []
            }))
        };

        return {
            resultPayload: {
                status: 'pending_user_answer',
                questionCard
            },
            summaryResult: `Presented clarifying question card to user: "${questionCard.questions[0]?.prompt || title}".`
        };
    },

    update_task_list(args, _ctx) {
        const raw = Array.isArray(args.tasks) ? args.tasks : [];
        const taskList = raw
            .map((t: any) => ({
                title: asString(t?.title).trim(),
                status: (t?.status === 'completed' || t?.status === 'in_progress' ? t.status : 'pending') as 'pending' | 'in_progress' | 'completed'
            }))
            .filter(t => t.title);
        const done = taskList.filter(t => t.status === 'completed').length;
        return {
            resultPayload: { status: 'task_list_updated', taskList },
            summaryResult: `Task list: ${done}/${taskList.length} completed.`
        };
    },

    present_execution_plan(args, _ctx) {
        const title = asString(args.title) || 'Proposed Execution Plan';
        const goal = asString(args.goal) || 'Fulfill user goal';
        const deliverables = Array.isArray(args.deliverables) ? args.deliverables : [];
        const steps = Array.isArray(args.steps) ? args.steps : [];
        const estimatedLatency = asString(args.estimatedLatency) || undefined;
        const openQuestions = Array.isArray(args.openQuestions) ? args.openQuestions : [];

        const executionPlanCard = {
            title,
            goal,
            deliverables,
            steps,
            estimatedLatency,
            openQuestions,
            confirmed: false
        };

        return {
            resultPayload: {
                status: 'plan_presented',
                executionPlanCard
            },
            summaryResult: `Presented execution plan "${title}" for user review.`
        };
    },

    async scene_3d_dispatch_operators(args, _ctx) {
        const rawCommands = Array.isArray(args.commands) ? args.commands : [];
        const atomic = args.atomic !== false;

        const activeArtifact = _ctx?.request?.activeArtifact;
        const currentData: Scene3DData = (activeArtifact && activeArtifact.type === '3d-scene' && activeArtifact.data)
            ? (activeArtifact.data as Scene3DData)
            // With no scene open, operators start from an empty first pass in a studio, like every first scene.
            : {
                title: '3D Scene',
                renderMode: firstPassRenderMode(_ctx?.request?.prompt),
                environment: { skybox: 'studio', lighting: 'studio' },
                customMeshes: [],
                objects: []
            };

        const engine = new DirectDispatchOperatorEngine(currentData);
        const batchCommands: BatchCommand[] = rawCommands.map((c: any) => ({
            operator: asString(c.operator),
            params: (c.params && typeof c.params === 'object') ? c.params : {}
        }));

        const result = engine.executeBatch(batchCommands, { atomic });
        const updatedData = engine.getSceneData();
        const executedCount = result.results.filter(r => r.success).length;
        const failedCount = result.results.filter(r => !r.success).length;
        const executionTimeMs = result.totalExecutionTimeMs || 0.1;
        const errors = result.results.filter(r => !r.success).map(r => r.error).filter(Boolean);

        const artifactId = activeArtifact?.id || `artifact-3d-${Date.now()}`;
        const artifact: CanvasArtifact = {
            id: artifactId,
            type: '3d-scene',
            title: updatedData.title || activeArtifact?.title || '3D Scene',
            summary: `Dispatched ${executedCount} 3D operator(s) in ${executionTimeMs.toFixed(1)}ms.`,
            data: updatedData,
            version: ((activeArtifact as any)?.version || 1) + 1,
            createdAt: activeArtifact?.createdAt || new Date().toISOString()
        };

        return {
            resultPayload: {
                success: result.success,
                executedCount,
                failedCount,
                executionTimeMs,
                errors,
                operatorResults: result.results,
                artifact
            },
            summaryResult: `Dispatched ${executedCount} operator(s) in ${executionTimeMs.toFixed(1)}ms (${result.success ? 'all succeeded' : failedCount + ' failed'}).`
        };
    },

    async audit_3d_scene_viewport(args, _ctx) {
        const request = asString(args.targetPrompt) || _ctx?.request?.prompt || '';
        const activeArtifact = _ctx?.request?.activeArtifact;
        const modelPath = activeArtifact?.type === '3d-scene' ? resolveSceneModelPath(activeArtifact.data as Scene3DData) : undefined;
        if (!modelPath) {
            const error = 'No generated model file was found for the active 3D scene, so nothing could be rendered or checked.';
            return { status: 'failed', resultPayload: { success: false, error }, summaryResult: error };
        }

        const soup = glbToTriangleSoup(fs.readFileSync(modelPath));
        if (!soup || soup.indices.length === 0) {
            const error = `The model file ${modelPath} has no triangles to render.`;
            return { status: 'failed', resultPayload: { success: false, error }, summaryResult: error };
        }

        const { result, views } = await auditModelAgainstRequest(soup, request, (prompt, images) => callVisionModel(prompt, images, _ctx?.request?.model));
        const renderPaths = views.map((v, i) => {
            const p = modelPath.replace(/\.glb$/i, `_audit_${i}.png`);
            try { fs.writeFileSync(p, v.png); } catch { return undefined; }
            return p;
        }).filter(Boolean);

        const summary = result.verdict === 'ok'
            ? `Rendered ${views.length} views of the model; the vision check found no problems against the request.`
            : result.verdict === 'problems'
                ? `Rendered ${views.length} views; found ${result.problems.length} problem(s): ${result.problems.map(p => p.problem).join('; ')}`
                : `Rendered ${views.length} views, but the check could not complete: ${result.reason}`;
        return {
            status: result.verdict === 'skipped' ? 'failed' : 'completed',
            resultPayload: {
                success: result.verdict !== 'skipped',
                verdict: result.verdict,
                confirmed: result.checked,
                problems: result.problems,
                reason: result.reason,
                modelPath,
                renderPaths,
                note: 'Renders show real geometry and material base colors with simple lighting; textures are not shown.'
            },
            summaryResult: summary
        };
    }
};

/** The hero model file behind a 3D scene, resolved to a path on disk. */
export function resolveSceneModelPath(data: Scene3DData | undefined): string | undefined {
    if (!data) return undefined;
    const repoRoot = process.env.SCRATCHBOX_ROOT || (fs.existsSync(path.resolve(process.cwd(), 'packages')) ? process.cwd() : path.resolve(process.cwd(), '..'));
    const candidates: string[] = [];
    const objects: any[] = Array.isArray((data as any).objects) ? (data as any).objects : [];
    const ordered = [...objects.filter(o => o?.content?.metadata?.role === 'hero'), ...objects.filter(o => o?.content?.metadata?.role !== 'environment')];
    for (const o of ordered) {
        const meta = o?.content?.metadata || {};
        if (typeof meta.originalPath === 'string') candidates.push(meta.originalPath);
        const uri = o?.content?.durableUri;
        if (typeof uri === 'string' && uri.startsWith('/models/')) candidates.push(path.join(repoRoot, 'public', uri));
    }
    const cpp = (data as any).cppGenerator;
    if (typeof cpp?.glbPath === 'string') candidates.push(cpp.glbPath);
    return candidates.find(p => p.toLowerCase().endsWith('.glb') && fs.existsSync(p));
}
