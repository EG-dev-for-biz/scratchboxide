/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import type { CanvasArtifact, PrimitiveType, ArtifactData, VideoTimelineData, Scene3DData } from '../../../browser/generative-canvas/canvas-types';
import { synthesizeContextualVideoTimeline } from '../../../browser/generative-canvas/services/video/videoTimelineSynthesizer';
import { synthesizeContextual3DScene } from '../../../browser/generative-canvas/procedural-3d-synthesizer';
import { NativePythonRunnerService } from '../../3d-engine/native-python-runner-service';
import { NativeCppCompilerService } from '../../3d-engine/native-compiler-service';
import { DirectDispatchOperatorEngine, type BatchCommand } from '../../../browser/generative-canvas/services/direct-dispatch-operator-engine';
import * as fs from 'fs';
import * as path from 'path';
import { glbToTriangleSoup } from '../../3d-engine/part-connectivity';
import { auditModelAgainstRequest, callVisionModel } from '../../3d-engine/visual-review';
import type { ToolDeclaration, ToolHandler } from './types';
import { applyClayFirstPassBaseline, releaseClayOnMaterialRequest } from '../scene3d-clay-baseline';

function asString(val: unknown): string {
    return typeof val === 'string' ? val : '';
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
                payload: {
                    type: 'OBJECT',
                    description: 'The strongly-typed primitive data (Scene3DData, VideoTimelineData, SandboxData, KanbanData, DocumentData, or GraphData). For "3d-scene", you can supply payload.script (or payload.pythonGenerator.sourceCode) with procedural Python code importing scratchbox as sb to compile native C++20 geometry and stream binary .glb directly into the viewport.'
                }
            },
            required: ['primitiveType', 'title', 'payload']
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
        description: 'Dispatches high-performance in-memory 3D scene operators against the active 3D canvas stage via DirectDispatchOperatorEngine. Executes transformations (sb_transform_object), PBR material properties (sb_set_material_pbr), lighting & sun angles (sb_set_sun_position, sb_setup_lighting), physics, and dynamic camera auto-framing in <1ms without re-compiling geometry or re-uploading GLB files.',
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
                                description: 'Operator name (e.g. "sb_transform_object", "sb_set_material_pbr", "sb_set_sun_position", "sb_setup_lighting", "sb_frame_bounds")'
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
        let primitiveType = (asString(args.primitiveType) || '3d-scene') as PrimitiveType;
        let title = asString(args.title) || 'Visual Creation';
        let summary = asString(args.summary) || `Synthesized ${title} on visual canvas.`;
        let payload = (args.payload && typeof args.payload === 'object') ? args.payload as ArtifactData : ({} as any);

        const prompt = _ctx?.request?.prompt || '';
        const lowerPrompt = prompt.toLowerCase();
        const isVideoTimelinePrompt = /split\s+(?:active\s+)?clip|ripple\s+delete|playhead|video\s+timeline|timeline\s+editor|video\s+editor|\bnle\b|cut\s+clip|trim\s+clip|multi-track\s+video|b-roll|a-roll|video\s+track|audio\s+mixer\s+track|color\s+grade\s+clip/i.test(prompt) ||
            ((lowerPrompt.includes('clip') || lowerPrompt.includes('timeline')) && (lowerPrompt.includes('split') || lowerPrompt.includes('cut') || lowerPrompt.includes('delete') || lowerPrompt.includes('playhead') || lowerPrompt.includes('ripple') || lowerPrompt.includes('track') || lowerPrompt.includes('video')));

        if (isVideoTimelinePrompt || primitiveType === 'video-timeline' || (primitiveType as string) === 'video-editor' || (primitiveType as string) === 'timeline' || (primitiveType as string) === 'nle') {
            primitiveType = 'video-timeline';
            const activeVideoData = _ctx?.request?.activeArtifact?.type === 'video-timeline' ? (_ctx.request.activeArtifact.data as VideoTimelineData) : undefined;
            const timelineData = synthesizeContextualVideoTimeline(prompt, title !== 'Visual Creation' ? title : undefined, activeVideoData);
            if (payload && typeof payload === 'object') {
                const p = payload as any;
                if (p.tracks && Array.isArray(p.tracks) && p.tracks.length > 0) timelineData.tracks = p.tracks;
                if (p.aspectRatio) timelineData.aspectRatio = p.aspectRatio;
                if (p.fps) timelineData.fps = p.fps;
                if (p.duration) timelineData.duration = p.duration;
                if (p.currentTime !== undefined) timelineData.currentTime = p.currentTime;
            }
            payload = timelineData as any;
            title = timelineData.title;
            summary = timelineData.subtitle || 'Multi-track non-linear video editing timeline with real-time WebGL compositor';
        } else if (primitiveType === '3d-scene') {
            const contextual3D = synthesizeContextual3DScene(prompt, {
                activeArtifact: _ctx?.request?.activeArtifact,
                chatHistory: _ctx?.request?.chatHistory,
                docTitle: title !== 'Visual Creation' ? title : undefined
            });

            const p = payload && typeof payload === 'object' ? (payload as any) : {};

            // Geometry comes only from the model's payload. The prompt synthesizer's template generators drew
            // a domed tower and trees the model never asked for between the objects it placed.
            const pythonScript = p.pythonGenerator?.sourceCode || p.script || p.pythonScript || p.python;
            let pythonGlbBase64 = p.pythonGenerator?.glbBase64 || p.glbBase64;
            let pythonGlbPath = p.pythonGenerator?.glbPath || p.glbPath;

            if (pythonScript && !pythonGlbBase64) {
                try {
                    console.log('[mount_canvas_primitive] Executing procedural Python script, source length:', pythonScript.length);
                    const runner = NativePythonRunnerService.getInstance();
                    const res = await runner.runScript(pythonScript);
                    console.log('[mount_canvas_primitive] Python runner result:', {
                        success: res.success,
                        executionTimeMs: res.executionTimeMs,
                        glbBase64Length: res.glbBase64?.length,
                        glbPath: res.glbPath,
                        errorDetails: res.errorDetails,
                        stderr: res.stderr ? res.stderr.slice(0, 300) : undefined
                    });
                    if (res.success && res.glbBase64) {
                        pythonGlbBase64 = res.glbBase64;
                        pythonGlbPath = res.glbPath;
                    }
                } catch (e) {
                    console.warn('[mount_canvas_primitive] Error executing python script:', e);
                }
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
                lastCompiledTimeMs: Date.now()
            } : p.pythonGenerator;

            const cppGen = (cppGlbBase64 || cppSource) ? {
                enabled: true,
                filename: 'world_generator.cpp',
                sourceCode: cppSource || p.cppGenerator?.sourceCode || '',
                glbBase64: cppGlbBase64,
                glbPath: cppGlbPath,
                vertexCount: p.cppGenerator?.vertexCount || 50000,
                triangleCount: p.cppGenerator?.triangleCount || 30000
            } : p.cppGenerator;

            // The title is the model's too; the synthesizer's would name the tab after prompt keywords.
            title = p.title && p.title !== '4D Scene Workspace' ? p.title : (asString(args.title) || '3D Scene');
            summary = p.subtitle || summary;

            // Only viewpoint, lighting and render settings may default from the synthesizer. Its meshes,
            // scripts, operator stack (which replays its generator) and geodetic anchor are not carried over.
            payload = {
                ...p,
                title,
                subtitle: summary,
                worldBranch: p.worldBranch || contextual3D.worldBranch,
                sceneType: p.sceneType || contextual3D.sceneType,
                renderMode: p.renderMode || contextual3D.renderMode,
                cameraMode: p.cameraMode || contextual3D.cameraMode,
                splatUrl: p.splatUrl || contextual3D.splatUrl,
                splatTilesetUrl: p.splatTilesetUrl || contextual3D.splatTilesetUrl,
                splatOptions: p.splatOptions || contextual3D.splatOptions,
                customMeshes: [], // STRICT TIER-0 JS PRIMITIVE BAN: No fake mock arrays.
                environment: p.environment || contextual3D.environment,
                camera: p.camera || contextual3D.camera,
                objects: Array.isArray(p.objects) ? p.objects : [],
                features: {
                    ...(contextual3D.features || {}),
                    ...(p.features || {})
                },
                cppGenerator: cppGen,
                pythonGenerator: pyGenerator
            };
            const active3D = _ctx?.request?.activeArtifact?.type === '3d-scene' ? _ctx.request.activeArtifact.data as any : undefined;
            payload = active3D
                ? releaseClayOnMaterialRequest(payload as any, prompt, active3D.renderMode)
                : applyClayFirstPassBaseline(payload as any, prompt);
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
            : {
                title: '3D Scene',
                renderMode: 'pbr',
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
