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
import { VisualVerificationService } from '../../visual-verification-service';
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
        name: 'present_execution_plan',
        description: 'Present a structured execution plan card for user review and explicit confirmation before initiating complex, multi-step, or compute-heavy 3D/VFX/code tasks. Groups plan steps by pipeline tier (Tier 1 Native C++20 vs Tier 2 ComfyUI/Cloud Run), lists deliverables, and offers [Confirm & Execute] and [Adjust Plan] actions.',
        parameters: {
            type: 'OBJECT',
            properties: {
                title: { type: 'STRING', description: 'Title of the execution plan' },
                goal: { type: 'STRING', description: 'Core user objective being solved' },
                pipelineTier: {
                    type: 'STRING',
                    enum: ['tier1-native', 'tier2-comfyui', 'hybrid'],
                    description: 'Execution architecture tier'
                },
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
                            tier: { type: 'STRING', enum: ['tier1-native', 'tier2-comfyui'] },
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
            required: ['title', 'goal', 'pipelineTier', 'steps']
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
        description: 'Audits the active 3D canvas viewport across multi-angle camera perspectives (cinematic 3/4, top-down, eye-level, detail) using the 8-Dimension Visual Fidelity Rubric. Detects geometry clipping, floating objects, under-exposed lighting, and scale mismatches, and returns actionable direct-dispatch repair operators.',
        parameters: {
            type: 'OBJECT',
            properties: {
                targetPrompt: {
                    type: 'STRING',
                    description: 'The target scene prompt or artistic intention to evaluate against.'
                },
                minPassingScore: {
                    type: 'NUMBER',
                    description: 'Minimum passing fidelity score 0-100 (default 80).'
                },
                autoRepair: {
                    type: 'BOOLEAN',
                    description: 'If true, automatically applies corrective operators to repair defects (default true).'
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
        } else if (primitiveType === '3d-scene' || /3d|scene|mesh|pedestal|orbit|spatial|monolith/i.test(prompt) || /3d|scene/i.test(title)) {
            primitiveType = '3d-scene';
            const contextual3D = synthesizeContextual3DScene(prompt, {
                activeArtifact: _ctx?.request?.activeArtifact,
                chatHistory: _ctx?.request?.chatHistory,
                docTitle: title !== 'Visual Creation' ? title : undefined
            });

            const p = payload && typeof payload === 'object' ? (payload as any) : {};

            let pythonScript = p.pythonGenerator?.sourceCode || p.script || p.pythonScript || p.python || contextual3D.pythonGenerator?.sourceCode;
            let pythonGlbBase64 = p.pythonGenerator?.glbBase64 || p.glbBase64 || contextual3D.pythonGenerator?.glbBase64;
            let pythonGlbPath = p.pythonGenerator?.glbPath || p.glbPath || contextual3D.pythonGenerator?.glbPath;

            const isArchPrompt = /\b(?:procedural|building|architecture|palace|palais|hall|wings?|facade|fenestration|mansard|hip\s*roof|gable|plaza|promenade|pedestal|trees?|ivy|botanical|civic|citadel|castle|outpost)\b/i.test(prompt) || /\b(?:procedural|building|architecture|plaza|promenade|civic)\b/i.test(title);

            if (!pythonScript && !pythonGlbBase64 && isArchPrompt) {
                    pythonScript = `import scratchbox as sb

scene = sb.geometry.Mesh("${(title || 'CivicPlaza').replace(/[^a-zA-Z0-9]/g, '')}")

# 1. Elevated stone promenade pedestal
promenade = sb.geometry.create_studio_pedestal(radius=30.0, height=0.7, bevel=0.08, segments=64)
promenade.material = sb.geometry.PbrMaterial.stone_limestone()
scene.merge(promenade)

# 2. Central municipal hall with Mansard roof & rhythmic window reveals
central_hall = sb.create_building(
    width=22.0, depth=14.0, floors=4, floor_height=3.6,
    ground_floor_height=4.4, plinth_height=0.7,
    bay_width=3.2, window_width=1.8, window_height=2.2, window_recess_depth=0.26,
    roof='mansard', roof_pitch_degrees=38.0, roof_overhang=0.8,
    name='CentralMunicipalPalais'
)
central_hall.translate(0, 0.7, -5.0)
scene.merge(central_hall)

# 3. Flanking East & West wings with Hip roofs
east_wing = sb.create_building(
    width=12.0, depth=10.0, floors=3, floor_height=3.4,
    ground_floor_height=4.0, plinth_height=0.5,
    bay_width=3.0, window_width=1.6, window_height=2.0, window_recess_depth=0.22,
    roof='hip', name='EastWing'
)
east_wing.translate(-16.0, 0.7, 0.0)
scene.merge(east_wing)

west_wing = sb.create_building(
    width=12.0, depth=10.0, floors=3, floor_height=3.4,
    ground_floor_height=4.0, plinth_height=0.5,
    bay_width=3.0, window_width=1.6, window_height=2.0, window_recess_depth=0.22,
    roof='hip', name='WestWing'
)
west_wing.translate(16.0, 0.7, 0.0)
scene.merge(west_wing)

# 4. Botanical Space-Colonization Shade Trees
tree_coords = [(-8.0, 0.7, 9.0), (8.0, 0.7, 9.0), (-15.0, 0.7, 12.0), (15.0, 0.7, 12.0)]
for tx, ty, tz in tree_coords:
    tree = sb.create_tree(attractor_count=130, crown_center=(0, 5, 0), crown_extents=(2.6, 3.8, 2.6))
    tree.translate(tx, ty, tz)
    scene.merge(tree)

# 5. Clinging Ivy on East wing foundation
ivy = sb.create_ivy(root=(-10.0, 0.7, 3.0), obstacle_min=(-16, 0.7, -5), obstacle_max=(-10, 6, 5), max_steps=80)
scene.merge(ivy)

# 6. Stream binary glTF 2.0
sb.io.write_glb(OUTPUT_GLB_PATH, scene)
`;
            }

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

            if (cppSource && !cppGlbBase64 && !pythonGlbBase64) {
                try {
                    const compiler = NativeCppCompilerService.getInstance();
                    const compRes = await compiler.compileSource(cppSource);
                    if (compRes.success && compRes.binaryPath) {
                        const execRes = await compiler.executeBinary(compRes.binaryPath);
                        if (execRes.success && execRes.glbBase64) {
                            cppGlbBase64 = execRes.glbBase64;
                            cppGlbPath = execRes.glbPath;
                        }
                    }
                } catch (e) {
                    console.warn('[mount_canvas_primitive] Error compiling C++ source:', e);
                }
            }

            const pyGenerator = (pythonGlbBase64 || pythonScript) ? {
                enabled: true,
                filename: 'procedural_scene.py',
                sourceCode: pythonScript || p.pythonGenerator?.sourceCode || '',
                glbBase64: pythonGlbBase64,
                glbPath: pythonGlbPath,
                lastCompiledTimeMs: Date.now()
            } : (p.pythonGenerator || contextual3D.pythonGenerator);

            const cppGen = (cppGlbBase64 || cppSource) ? {
                enabled: true,
                filename: 'world_generator.cpp',
                sourceCode: cppSource || p.cppGenerator?.sourceCode || '',
                glbBase64: cppGlbBase64,
                glbPath: cppGlbPath,
                vertexCount: p.cppGenerator?.vertexCount || 50000,
                triangleCount: p.cppGenerator?.triangleCount || 30000
            } : (p.cppGenerator || contextual3D.cppGenerator);

            payload = {
                ...contextual3D,
                ...p,
                worldBranch: p.worldBranch || contextual3D.worldBranch,
                sceneType: p.sceneType || contextual3D.sceneType,
                splatUrl: p.splatUrl || contextual3D.splatUrl,
                splatTilesetUrl: p.splatTilesetUrl || contextual3D.splatTilesetUrl,
                splatOptions: p.splatOptions || contextual3D.splatOptions,
                customMeshes: (pyGenerator?.glbBase64 || cppGen?.glbBase64)
                    ? []
                    : ((p.customMeshes && Array.isArray(p.customMeshes) && p.customMeshes.length > 0)
                        ? p.customMeshes
                        : contextual3D.customMeshes),
                environment: p.environment || contextual3D.environment,
                camera: p.camera || contextual3D.camera,
                objects: (Array.isArray(p.objects) && p.objects.length > 0) ? p.objects : (contextual3D.objects || []),
                features: {
                    ...(contextual3D.features || {}),
                    ...(p.features || {})
                },
                cppGenerator: cppGen,
                pythonGenerator: pyGenerator,
                mesh: p.mesh || (contextual3D as any).mesh
            };
            const active3D = _ctx?.request?.activeArtifact?.type === '3d-scene' ? _ctx.request.activeArtifact.data as any : undefined;
            payload = active3D
                ? releaseClayOnMaterialRequest(payload as any, prompt, active3D.renderMode)
                : applyClayFirstPassBaseline(payload as any, prompt);
            title = p.title && p.title !== '4D Scene Workspace' ? p.title : (contextual3D.title || title);
            summary = p.subtitle || contextual3D.subtitle || summary;
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

    present_execution_plan(args, _ctx) {
        const title = asString(args.title) || 'Proposed Execution Plan';
        const goal = asString(args.goal) || 'Fulfill user goal';
        const pipelineTier = (asString(args.pipelineTier) || 'tier1-native') as any;
        const deliverables = Array.isArray(args.deliverables) ? args.deliverables : [];
        const steps = Array.isArray(args.steps) ? args.steps : [];
        const estimatedLatency = asString(args.estimatedLatency) || undefined;
        const openQuestions = Array.isArray(args.openQuestions) ? args.openQuestions : [];

        const executionPlanCard = {
            title,
            goal,
            pipelineTier,
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
            summaryResult: `Presented execution plan "${title}" (${pipelineTier}) for user review.`
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
        const targetPrompt = asString(args.targetPrompt) || _ctx?.request?.prompt || 'Verify photorealistic 3D scene';
        const minPassingScore = typeof args.minPassingScore === 'number' ? args.minPassingScore : 80;
        const autoRepair = args.autoRepair !== false;

        const activeArtifact = _ctx?.request?.activeArtifact;
        const currentData: Scene3DData = (activeArtifact && activeArtifact.type === '3d-scene' && activeArtifact.data)
            ? (activeArtifact.data as Scene3DData)
            : {
                title: '3D Scene',
                renderMode: 'pbr',
                customMeshes: [],
                objects: []
            };

        const verifier = new VisualVerificationService();
        const audit = await verifier.audit3DSceneMultiAngle({
            prompt: targetPrompt,
            sceneData: currentData
        });

        let repairResult: any = undefined;
        let updatedArtifact: CanvasArtifact | undefined = undefined;

        if (autoRepair && audit.combinedOperatorDispatches.length > 0 && audit.averageFidelityScore < minPassingScore) {
            const engine = new DirectDispatchOperatorEngine(currentData);
            const batchCommands: BatchCommand[] = audit.combinedOperatorDispatches.map(d => ({
                operator: d.operator,
                params: d.params || {}
            }));
            const batchResult = engine.executeBatch(batchCommands, { atomic: false });
            const updatedData = engine.getSceneData();
            const repairedCount = batchResult.results.filter(r => r.success).length;

            updatedArtifact = {
                id: activeArtifact?.id || `artifact-3d-${Date.now()}`,
                type: '3d-scene',
                title: updatedData.title || '3D Scene (Repaired)',
                summary: `Auto-repaired ${repairedCount} defect(s) via 3D visual audit.`,
                data: updatedData,
                version: ((activeArtifact as any)?.version || 1) + 1,
                createdAt: activeArtifact?.createdAt || new Date().toISOString()
            };

            repairResult = {
                appliedCount: repairedCount,
                executionTimeMs: batchResult.totalExecutionTimeMs || 0.1
            };
        }

        return {
            resultPayload: {
                overallPass: audit.overallPass,
                averageFidelityScore: audit.averageFidelityScore,
                summaryCritique: audit.summaryCritique,
                detectedDefects: audit.detectedDefects,
                repairOperators: audit.combinedOperatorDispatches,
                autoRepaired: !!repairResult,
                repairResult,
                artifact: updatedArtifact
            },
            summaryResult: `Visual audit complete: Score ${audit.averageFidelityScore}/100 (${audit.overallPass ? 'PASSED' : 'NEEDS_REPAIR'}). Detected ${audit.detectedDefects.length} defect(s).${repairResult ? ` Auto-applied ${repairResult.appliedCount} repair operators.` : ''}`
        };
    }
};
