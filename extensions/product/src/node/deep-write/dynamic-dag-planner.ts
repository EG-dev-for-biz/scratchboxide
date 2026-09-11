/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { injectable, inject, optional } from '@theia/core/shared/inversify';
import { GeminiService } from '../gemini-service';
import { DynamicAgentStage, DiscoveredGoalPlan } from '../../common/deep-write/deep-write-protocol';
import { CodebasePatternEngine } from '../codebase-pattern-engine';
import { ProjectContextGraphService } from '../project-context-graph-service';
import { Scene3DData } from '../../browser/generative-canvas/canvas-types';
import {
    DirectDispatchOperatorEngine,
    createOperatorEngine,
    BatchCommand,
    OperatorResult
} from '../../browser/generative-canvas/services/direct-dispatch-operator-engine';
import {
    detect3DSceneTheme,
    detectRealWorldLocationIntent
} from '../../browser/generative-canvas/procedural-3d-synthesizer';

// ============================================================================
// Autonomous 3D Planning Types (PocoLibre/blender-mcp paradigm)
// ============================================================================

export type Autonomous3DStageType =
    | 'reasoning_inspect'
    | 'scaffolding'
    | 'base_geometry'
    | 'modifiers_and_edit'
    | 'materials_and_shading'
    | 'lighting_and_atmosphere'
    | 'camera_framing_and_dynamics';

export interface Autonomous3DExpectedStateChecks {
    minObjectCount?: number;
    requiredMeshIds?: string[];
    requiredMaterials?: string[];
    lightingConfigured?: boolean;
    cameraFramed?: boolean;
    customVerification?: (scene: Scene3DData, stats?: any) => boolean;
}

export interface Autonomous3DStage {
    id: string;
    type: Autonomous3DStageType;
    name: string;
    description: string;
    dependencies: string[];
    operators: BatchCommand[];
    expectedStateChecks?: Autonomous3DExpectedStateChecks;
}

export interface SceneReasoningSummary {
    initialObjectCount: number;
    existingMeshIds: string[];
    renderMode: string;
    currentLighting?: string;
    currentCamera?: any;
    topologicalProfile: Array<{ id: string; type: string; position: [number, number, number]; scale: [number, number, number] }>;
}

export interface Autonomous3DStageDAG {
    goal: string;
    theme: string;
    sceneReasoningSummary: SceneReasoningSummary;
    stages: Autonomous3DStage[];
}

export interface Autonomous3DStageExecutionResult {
    stageId: string;
    stageName: string;
    type: Autonomous3DStageType;
    success: boolean;
    operatorResults: OperatorResult[];
    verification: {
        passed: boolean;
        details?: string;
        sceneStats?: any;
    };
    error?: string;
    durationMs: number;
}

export interface Autonomous3DPlanResult {
    success: boolean;
    goal: string;
    finalScene: Scene3DData;
    executedStages: Autonomous3DStageExecutionResult[];
    totalOperatorsExecuted: number;
    totalExecutionTimeMs: number;
    actionLog: any[];
    error?: string;
}

@injectable()
export class DynamicDagPlanner {
    private fallbackPatternEngine = new CodebasePatternEngine();
    private fallbackContextGraph = new ProjectContextGraphService();

    constructor(
        @inject(GeminiService) @optional() protected readonly geminiService?: GeminiService,
        @inject(CodebasePatternEngine) @optional() protected readonly patternEngine?: CodebasePatternEngine,
        @inject(ProjectContextGraphService) @optional() protected readonly contextGraphService?: ProjectContextGraphService
    ) {}

    public getPatternEngine(): CodebasePatternEngine {
        return this.patternEngine || this.fallbackPatternEngine;
    }

    public getContextGraphService(): ProjectContextGraphService {
        return this.contextGraphService || this.fallbackContextGraph;
    }

    // ========================================================================
    // Autonomous Multi-Step 3D Planning Agent (PocoLibre/blender-mcp paradigm)
    // ========================================================================

    /**
     * 1. Scene Reasoning: Queries current scene state and inspects topology before deciding changes.
     */
    public inspectAndReasonScene(
        scene?: Scene3DData,
        engine?: DirectDispatchOperatorEngine
    ): SceneReasoningSummary {
        const eng = engine || createOperatorEngine(scene);

        const sceneInspect = eng.dispatch('sb_inspect_scene', {});
        const objectsList = eng.dispatch('sb_list_objects', {});

        const sceneData = eng.getSceneData();
        const initialObjectCount = objectsList.success ? objectsList.data.count : 0;
        const objects: any[] = objectsList.success ? objectsList.data.objects : [];

        const topologicalProfile = objects.map(o => ({
            id: o.id,
            type: o.type,
            position: o.position as [number, number, number],
            scale: o.scale as [number, number, number]
        }));

        const existingMeshIds = objects.map(o => o.id);

        return {
            initialObjectCount,
            existingMeshIds,
            renderMode: sceneInspect.success && sceneInspect.data?.renderMode ? sceneInspect.data.renderMode : (sceneData.renderMode || 'pbr'),
            currentLighting: sceneInspect.success && sceneInspect.data?.environment?.lighting ? sceneInspect.data.environment.lighting : sceneData.environment?.lighting,
            currentCamera: sceneInspect.success && sceneInspect.data?.camera ? sceneInspect.data.camera : sceneData.camera,
            topologicalProfile
        };
    }

    /**
     * 2. Goal Breakdown & DAG Generation: Decomposes 3D goal into a dependency-resolved sequence of operator commands.
     * Sequence: Reasoning -> Scaffolding -> Base Geometry -> Modifiers & Mesh Edit -> Materials & Shading -> Lighting & Atmosphere -> Camera Framing & Dynamics.
     */
    public generate3DPlanDAG(
        prompt: string,
        currentScene?: Scene3DData
    ): Autonomous3DStageDAG {
        const engine = createOperatorEngine(currentScene);
        const reasoning = this.inspectAndReasonScene(currentScene, engine);
        const theme = detect3DSceneTheme(prompt, { docTitle: currentScene?.title });
        const isIncremental = reasoning.initialObjectCount > 0 && !/reset|fresh|clear|new scene/i.test(prompt);

        const stages: Autonomous3DStage[] = [];

        // --------------------------------------------------------------------
        // Stage 1: Scaffolding / Scene Init
        // --------------------------------------------------------------------
        const scaffoldingOps: BatchCommand[] = [];
        if (!isIncremental) {
            scaffoldingOps.push({
                operator: 'sb_reset_scene',
                params: {
                    title: prompt.length > 30 ? `${prompt.slice(0, 45)}...` : prompt,
                    renderMode: 'pbr',
                    sceneType: theme as any
                }
            });
        } else {
            scaffoldingOps.push({
                operator: 'sb_inspect_scene',
                params: {}
            });
        }

        stages.push({
            id: 'stage_01_scaffolding',
            type: 'scaffolding',
            name: 'Phase 1: Scene Foundation & Workspace Layout',
            description: 'Establish viewport coordinate system, render mode, and scene hierarchy.',
            dependencies: [],
            operators: scaffoldingOps,
            expectedStateChecks: {
                minObjectCount: isIncremental ? reasoning.initialObjectCount : 0
            }
        });

        // --------------------------------------------------------------------
        // Determine Mesh Blueprint specifications based on Theme / Prompt
        // --------------------------------------------------------------------
        const meshBlueprints = this.deriveMeshBlueprints(theme, prompt, isIncremental);

        // --------------------------------------------------------------------
        // Stage 2: Base Geometry Spawning & Transforms
        // --------------------------------------------------------------------
        const baseGeometryOps: BatchCommand[] = [];
        const requiredMeshIds: string[] = [];

        const realWorldLoc = detectRealWorldLocationIntent(prompt, { docTitle: currentScene?.title });
        if (realWorldLoc && realWorldLoc.isRealWorld && !isIncremental) {
            baseGeometryOps.unshift({
                operator: 'sb_import_3d_tile',
                params: {
                    query: realWorldLoc.query,
                    lat: realWorldLoc.lat,
                    lng: realWorldLoc.lng,
                    clayPreset: 'warm-clay'
                }
            });
        }

        for (const bp of meshBlueprints) {
            requiredMeshIds.push(bp.id);
            // Spawn / register mesh in scene
            baseGeometryOps.push({
                operator: 'sb_set_transform',
                params: {
                    objectId: bp.id,
                    name: bp.name,
                    type: bp.type,
                    position: bp.position,
                    rotation: bp.rotation,
                    scale: bp.scale
                }
            });
        }

        stages.push({
            id: 'stage_02_base_geometry',
            type: 'base_geometry',
            name: 'Phase 2: Base Geometry Generation & Spatial Placement',
            description: 'Construct core geometric volumes and establish spatial transform hierarchy.',
            dependencies: ['stage_01_scaffolding'],
            operators: baseGeometryOps,
            expectedStateChecks: {
                requiredMeshIds,
                minObjectCount: (isIncremental ? reasoning.initialObjectCount : 0) + meshBlueprints.length
            }
        });

        // --------------------------------------------------------------------
        // Stage 3: Geometry Refinement & Modifiers / Mesh Edit
        // --------------------------------------------------------------------
        const modifierOps: BatchCommand[] = [];

        for (const bp of meshBlueprints) {
            if (bp.subdivisions && bp.subdivisions > 0) {
                modifierOps.push({
                    operator: 'sb_subdivide_mesh',
                    params: { objectId: bp.id, iterations: bp.subdivisions }
                });
            }
            if (bp.modifiers) {
                for (const mod of bp.modifiers) {
                    modifierOps.push({
                        operator: 'sb_add_modifier',
                        params: { objectId: bp.id, modifierType: mod.type, params: mod.params }
                    });
                }
            }
            if (bp.smoothing) {
                modifierOps.push({
                    operator: 'sb_smooth_mesh',
                    params: { objectId: bp.id, factor: bp.smoothing.factor, iterations: bp.smoothing.iterations }
                });
            }
            if (bp.extrusions) {
                modifierOps.push({
                    operator: 'sb_extrude_faces',
                    params: { objectId: bp.id, direction: bp.extrusions.direction, distance: bp.extrusions.distance }
                });
            }
        }

        stages.push({
            id: 'stage_03_modifiers_and_edit',
            type: 'modifiers_and_edit',
            name: 'Phase 3: Topological Refinement, Modifiers & Mesh Editing',
            description: 'Apply subdivision levels, procedural modifiers, surface extrusions, and Laplacian smoothing.',
            dependencies: ['stage_02_base_geometry'],
            operators: modifierOps,
            expectedStateChecks: {
                requiredMeshIds
            }
        });

        // --------------------------------------------------------------------
        // Stage 4: Materials & PBR Shading
        // --------------------------------------------------------------------
        const materialOps: BatchCommand[] = [];
        const requiredMaterials: string[] = [];

        for (const bp of meshBlueprints) {
            if (bp.material) {
                const matId = `mat-${bp.id}`;
                requiredMaterials.push(matId);
                materialOps.push({
                    operator: 'sb_create_material',
                    params: {
                        materialId: matId,
                        name: `${bp.name} PBR Material`,
                        color: bp.material.color,
                        roughness: bp.material.roughness,
                        metalness: bp.material.metalness,
                        transmission: bp.material.transmission,
                        ior: bp.material.ior,
                        emissive: bp.material.emissive,
                        clearcoat: bp.material.clearcoat
                    }
                });
                materialOps.push({
                    operator: 'sb_assign_material',
                    params: {
                        objectId: bp.id,
                        materialId: matId
                    }
                });
            }
        }

        stages.push({
            id: 'stage_04_materials_and_shading',
            type: 'materials_and_shading',
            name: 'Phase 4: Physically Based Materials & Surface Shading',
            description: 'Synthesize PBR material assets (microfacet roughness, metallic response, transmission, clearcoat) and assign across scene meshes.',
            dependencies: ['stage_03_modifiers_and_edit'],
            operators: materialOps,
            expectedStateChecks: {
                requiredMaterials,
                requiredMeshIds
            }
        });

        // --------------------------------------------------------------------
        // Stage 5: Lighting & Atmosphere
        // --------------------------------------------------------------------
        const lightingPreset = this.deriveLightingPreset(theme, prompt);
        const lightingParams: any = {
            preset: lightingPreset.preset,
            ambientIntensity: lightingPreset.ambientIntensity,
            keyLight: lightingPreset.keyLight,
            fillLight: lightingPreset.fillLight,
            rimLight: lightingPreset.rimLight
        };
        if (realWorldLoc && realWorldLoc.isRealWorld) {
            lightingParams.latitude = realWorldLoc.lat;
            lightingParams.longitude = realWorldLoc.lng;
        }

        const lightingOps: BatchCommand[] = [
            {
                operator: 'sb_setup_lighting',
                params: lightingParams
            }
        ];

        stages.push({
            id: 'stage_05_lighting_and_atmosphere',
            type: 'lighting_and_atmosphere',
            name: 'Phase 5: Illumination Rigs & Atmospheric Scattering',
            description: 'Configure multi-point studio key/fill/rim lighting or natural solar lighting.',
            dependencies: ['stage_04_materials_and_shading'],
            operators: lightingOps,
            expectedStateChecks: {
                lightingConfigured: true
            }
        });

        // --------------------------------------------------------------------
        // Stage 6: Camera Framing & Physics / Animation Dynamics
        // --------------------------------------------------------------------
        const dynamicsOps: BatchCommand[] = [];

        // Optimal camera framing
        if (meshBlueprints.length > 0) {
            dynamicsOps.push({
                operator: 'sb_frame_bounds',
                params: {
                    targetId: meshBlueprints[0].id,
                    paddingFactor: 1.6
                }
            });
        } else {
            dynamicsOps.push({
                operator: 'sb_set_camera',
                params: {
                    position: [18, 14, 22],
                    target: [0, 2, 0],
                    fov: 45,
                    cameraMode: 'orbit'
                }
            });
        }

        // Physics & Animation keyframes for dynamic objects
        for (const bp of meshBlueprints) {
            if (bp.physics) {
                dynamicsOps.push({
                    operator: 'sb_add_physics',
                    params: {
                        objectId: bp.id,
                        bodyType: bp.physics.bodyType || 'dynamic',
                        mass: bp.physics.mass || 1.0,
                        friction: bp.physics.friction || 0.5,
                        restitution: bp.physics.restitution || 0.5,
                        colliderShape: bp.physics.colliderShape || 'box'
                    }
                });
            }
            if (bp.keyframes) {
                for (const kf of bp.keyframes) {
                    dynamicsOps.push({
                        operator: 'sb_insert_keyframe',
                        params: {
                            objectId: bp.id,
                            property: kf.property,
                            timeMs: kf.timeMs,
                            value: kf.value,
                            easing: kf.easing || 'linear'
                        }
                    });
                }
            }
        }

        stages.push({
            id: 'stage_06_camera_framing_and_dynamics',
            type: 'camera_framing_and_dynamics',
            name: 'Phase 6: Camera Framing, Physics Colliders & Motion Keyframes',
            description: 'Calculate tight bounding box camera framing and attach rigid body physics with animation keyframes.',
            dependencies: ['stage_05_lighting_and_atmosphere'],
            operators: dynamicsOps,
            expectedStateChecks: {
                cameraFramed: true
            }
        });

        return {
            goal: prompt,
            theme,
            sceneReasoningSummary: reasoning,
            stages
        };
    }

    /**
     * 3. Direct-Dispatch Stage Execution with state verification.
     */
    public async execute3DStageWithVerification(
        stage: Autonomous3DStage,
        engine: DirectDispatchOperatorEngine
    ): Promise<Autonomous3DStageExecutionResult> {
        const stageStart = process.hrtime.bigint();

        // 1. Execute operators atomically
        const batchResult = engine.executeBatch(stage.operators, { atomic: true });

        const stageEnd = process.hrtime.bigint();
        const durationMs = Number(stageEnd - stageStart) / 1000000;

        if (!batchResult.success) {
            return {
                stageId: stage.id,
                stageName: stage.name,
                type: stage.type,
                success: false,
                operatorResults: batchResult.results,
                verification: {
                    passed: false,
                    details: `Stage execution failed during operator execution: ${batchResult.error}`
                },
                error: batchResult.error,
                durationMs
            };
        }

        // 2. Perform State Invariant Verification
        const verification = this.verifyStageInvariants(stage, engine);

        return {
            stageId: stage.id,
            stageName: stage.name,
            type: stage.type,
            success: verification.passed,
            operatorResults: batchResult.results,
            verification,
            error: verification.passed ? undefined : verification.details,
            durationMs
        };
    }

    /**
     * 4. End-to-End Autonomous 3D Multi-Step Planning Workflow (PocoLibre/blender-mcp Agent Loop).
     */
    public async executeAutonomous3DWorkflow(
        prompt: string,
        initialScene?: Scene3DData,
        options?: {
            atomic?: boolean;
            abortOnError?: boolean;
        }
    ): Promise<Autonomous3DPlanResult> {
        const totalStart = process.hrtime.bigint();
        const engine = createOperatorEngine(initialScene);

        // Stage 0: Scene Reasoning & DAG generation
        const dag = this.generate3DPlanDAG(prompt, engine.getSceneData());
        const executedStages: Autonomous3DStageExecutionResult[] = [];
        let totalOps = 0;

        // Stage Execution Loop with State Verification
        for (const stage of dag.stages) {
            const stageRes = await this.execute3DStageWithVerification(stage, engine);
            executedStages.push(stageRes);
            totalOps += stage.operators.length;

            if (!stageRes.success && options?.abortOnError !== false) {
                const totalEnd = process.hrtime.bigint();
                return {
                    success: false,
                    goal: prompt,
                    finalScene: engine.getSceneData(),
                    executedStages,
                    totalOperatorsExecuted: totalOps,
                    totalExecutionTimeMs: Number(totalEnd - totalStart) / 1000000,
                    actionLog: engine.getActionLog(),
                    error: `Autonomous 3D Plan aborted at stage '${stage.name}': ${stageRes.error}`
                };
            }
        }

        const totalEnd = process.hrtime.bigint();
        return {
            success: true,
            goal: prompt,
            finalScene: engine.getSceneData(),
            executedStages,
            totalOperatorsExecuted: totalOps,
            totalExecutionTimeMs: Number(totalEnd - totalStart) / 1000000,
            actionLog: engine.getActionLog()
        };
    }

    // ------------------------------------------------------------------------
    // Internal Helper Verification & Heuristic Blueprint Builders
    // ------------------------------------------------------------------------

    private verifyStageInvariants(
        stage: Autonomous3DStage,
        engine: DirectDispatchOperatorEngine
    ): { passed: boolean; details?: string; sceneStats?: any } {
        const scene = engine.getSceneData();
        const checks = stage.expectedStateChecks;
        if (!checks) return { passed: true };

        const listRes = engine.dispatch('sb_list_objects', {});
        const sceneStats = listRes.success ? listRes.data : { count: 0, objects: [] };

        // 1. Min Object Count check
        if (checks.minObjectCount !== undefined && sceneStats.count < checks.minObjectCount) {
            return {
                passed: false,
                details: `Expected at least ${checks.minObjectCount} objects, but found ${sceneStats.count}.`,
                sceneStats
            };
        }

        // 2. Required Mesh IDs check
        if (checks.requiredMeshIds) {
            for (const id of checks.requiredMeshIds) {
                const obj = engine.getObject(id);
                if (!obj) {
                    return {
                        passed: false,
                        details: `Required object with id '${id}' was not found in scene state.`,
                        sceneStats
                    };
                }
            }
        }

        // 3. Required Materials check
        if (checks.requiredMaterials) {
            for (const matId of checks.requiredMaterials) {
                const mat = engine.getMaterial(matId);
                if (!mat) {
                    return {
                        passed: false,
                        details: `Required material '${matId}' was not registered in engine material registry.`,
                        sceneStats
                    };
                }
            }
        }

        // 4. Lighting check
        if (checks.lightingConfigured && !scene.environment?.lighting) {
            return {
                passed: false,
                details: 'Lighting environment was not configured.',
                sceneStats
            };
        }

        // 5. Camera Framed check
        if (checks.cameraFramed && (!scene.camera || !scene.camera.position)) {
            return {
                passed: false,
                details: 'Camera was not properly framed or configured.',
                sceneStats
            };
        }

        // 6. Custom verification callback
        if (checks.customVerification && !checks.customVerification(scene, sceneStats)) {
            return {
                passed: false,
                details: 'Custom stage verification assertion failed.',
                sceneStats
            };
        }

        return {
            passed: true,
            details: `Stage '${stage.name}' successfully verified all invariants.`,
            sceneStats
        };
    }

    private deriveMeshBlueprints(
        theme: string,
        prompt: string,
        isIncremental: boolean
    ): Array<{
        id: string;
        name: string;
        type: string;
        position: [number, number, number];
        rotation: [number, number, number];
        scale: [number, number, number];
        material?: any;
        subdivisions?: number;
        modifiers?: Array<{ type: string; params: any }>;
        smoothing?: { factor: number; iterations: number };
        extrusions?: { direction: [number, number, number]; distance: number };
        physics?: any;
        keyframes?: any[];
    }> {
        const prefix = isIncremental ? `mesh-inc-${Date.now().toString().slice(-4)}` : 'mesh';

        if (theme === 'battlefield') {
            return [
                {
                    id: `${prefix}-buckman-tavern`,
                    name: 'Buckman Tavern',
                    type: 'box',
                    position: [-22, 4, -14],
                    rotation: [0, 0, 0],
                    scale: [12, 8, 14],
                    material: { color: 0x8b5a2b, roughness: 0.85, metalness: 0.05 },
                    subdivisions: 1
                },
                {
                    id: `${prefix}-meetinghouse`,
                    name: 'Lexington Meetinghouse & Belfry',
                    type: 'box',
                    position: [18, 7, -20],
                    rotation: [0, 0, 0],
                    scale: [14, 14, 18],
                    material: { color: 0xd4c5b9, roughness: 0.75, metalness: 0.05 },
                    subdivisions: 1
                },
                {
                    id: `${prefix}-minutemen-line`,
                    name: 'Colonial Minutemen Line',
                    type: 'cylinder',
                    position: [-6, 1.2, 5],
                    rotation: [0, Math.PI / 4, 0],
                    scale: [14, 2.2, 1.5],
                    material: { color: 0x2b4c7e, roughness: 0.6, metalness: 0.2 },
                    physics: { bodyType: 'static', mass: 0, friction: 0.8 }
                },
                {
                    id: `${prefix}-redcoat-regiment`,
                    name: 'British Redcoat Regiment',
                    type: 'cylinder',
                    position: [8, 1.2, 12],
                    rotation: [0, -Math.PI / 1.3, 0],
                    scale: [18, 2.2, 1.8],
                    material: { color: 0xb22222, roughness: 0.5, metalness: 0.3 },
                    physics: { bodyType: 'static', mass: 0, friction: 0.8 }
                },
                {
                    id: `${prefix}-fieldstone-wall`,
                    name: 'Fieldstone Boundary Wall',
                    type: 'box',
                    position: [-10, 0.6, -2],
                    rotation: [0, 0.05, 0],
                    scale: [28, 1.2, 1.2],
                    material: { color: 0x708090, roughness: 0.9, metalness: 0.05 }
                }
            ];
        }

        if (theme === 'city') {
            return [
                {
                    id: `${prefix}-central-spire`,
                    name: 'Central Financial Spire',
                    type: 'box',
                    position: [0, 16, 0],
                    rotation: [0, 0, 0],
                    scale: [8, 32, 8],
                    material: { color: 0x0f172a, roughness: 0.2, metalness: 0.85, emissive: 0x00d2ff },
                    subdivisions: 1,
                    extrusions: { direction: [0, 1, 0], distance: 2 }
                },
                {
                    id: `${prefix}-arcology-tower`,
                    name: 'Arcology Plaza Tower',
                    type: 'box',
                    position: [-14, 12, -10],
                    rotation: [0, 0, 0],
                    scale: [10, 24, 10],
                    material: { color: 0x1e293b, roughness: 0.3, metalness: 0.7 }
                },
                {
                    id: `${prefix}-transit-hub`,
                    name: 'Autonomous Transit Hub',
                    type: 'cylinder',
                    position: [12, 4, 8],
                    rotation: [0, 0, 0],
                    scale: [12, 2, 12],
                    material: { color: 0x38bdf8, roughness: 0.4, metalness: 0.6 }
                }
            ];
        }

        if (theme === 'solar-system') {
            return [
                {
                    id: `${prefix}-sun-core`,
                    name: 'Central Star (Sol)',
                    type: 'sphere',
                    position: [0, 0, 0],
                    rotation: [0, 0, 0],
                    scale: [6, 6, 6],
                    material: { color: 0xffaa00, roughness: 0.1, metalness: 0.1, emissive: 0xff8800 },
                    subdivisions: 1
                },
                {
                    id: `${prefix}-planet-terrestrial`,
                    name: 'Inner Terrestrial Planet',
                    type: 'sphere',
                    position: [16, 0, 0],
                    rotation: [0, 0, 0],
                    scale: [1.8, 1.8, 1.8],
                    material: { color: 0x38bdf8, roughness: 0.5, metalness: 0.1 },
                    keyframes: [
                        { property: 'rotation.y', timeMs: 0, value: 0 },
                        { property: 'rotation.y', timeMs: 10000, value: Math.PI * 2 }
                    ]
                },
                {
                    id: `${prefix}-gas-giant`,
                    name: 'Outer Gas Giant',
                    type: 'sphere',
                    position: [32, 0, 0],
                    rotation: [0, 0, 0],
                    scale: [3.5, 3.5, 3.5],
                    material: { color: 0xd97706, roughness: 0.4, metalness: 0.1 }
                }
            ];
        }

        if (theme === 'molecular') {
            return [
                {
                    id: `${prefix}-primary-carbon`,
                    name: 'Carbon Valence Center',
                    type: 'sphere',
                    position: [0, 0, 0],
                    rotation: [0, 0, 0],
                    scale: [2, 2, 2],
                    material: { color: 0x1f2937, roughness: 0.3, metalness: 0.7 }
                },
                {
                    id: `${prefix}-nitrogen-node`,
                    name: 'Nitrogen Orbital Node',
                    type: 'sphere',
                    position: [3, 1.5, 0],
                    rotation: [0, 0, 0],
                    scale: [1.6, 1.6, 1.6],
                    material: { color: 0x3b82f6, roughness: 0.2, metalness: 0.8 }
                },
                {
                    id: `${prefix}-oxygen-node`,
                    name: 'Oxygen Double Bond Node',
                    type: 'sphere',
                    position: [-3, 1.5, 0],
                    rotation: [0, 0, 0],
                    scale: [1.6, 1.6, 1.6],
                    material: { color: 0xef4444, roughness: 0.2, metalness: 0.8 }
                }
            ];
        }

        if (theme === 'architecture') {
            return [
                {
                    id: `${prefix}-room-foundation`,
                    name: 'Polished Concrete Foundation',
                    type: 'plane',
                    position: [0, 0, 0],
                    rotation: [-Math.PI / 2, 0, 0],
                    scale: [32, 32, 1],
                    material: { color: 0x0f172a, roughness: 0.2, metalness: 0.8 }
                },
                {
                    id: `${prefix}-blueprint-plinth`,
                    name: 'Holographic Blueprint Plinth',
                    type: 'cylinder',
                    position: [0, 0.8, 0],
                    rotation: [0, 0, 0],
                    scale: [4, 1.6, 4],
                    material: { color: 0x1e293b, roughness: 0.1, metalness: 0.9 }
                },
                {
                    id: `${prefix}-spatial-monolith`,
                    name: 'Floating Architectural Monolith',
                    type: 'box',
                    position: [0, 4.5, 0],
                    rotation: [0, Math.PI / 4, 0],
                    scale: [3, 3, 3],
                    material: { color: 0x00f3ff, roughness: 0.1, metalness: 0.9, wireframe: true },
                    modifiers: [{ type: 'subdivision', params: { levels: 1 } }]
                }
            ];
        }

        if (theme === 'flight') {
            return [
                {
                    id: `${prefix}-aircraft-fuselage`,
                    name: 'Aerodynamic Fuselage Core',
                    type: 'cylinder',
                    position: [0, 2.5, 0],
                    rotation: [Math.PI / 2, 0, 0],
                    scale: [2.2, 12, 2.2],
                    material: { color: 0x38bdf8, roughness: 0.2, metalness: 0.85 },
                    subdivisions: 1,
                    physics: { bodyType: 'kinematic', mass: 1200, friction: 0.1 }
                },
                {
                    id: `${prefix}-aircraft-wings`,
                    name: 'Delta Wing Assembly',
                    type: 'box',
                    position: [0, 2.4, -1],
                    rotation: [0, 0, 0],
                    scale: [16, 0.4, 4.5],
                    material: { color: 0x1e293b, roughness: 0.3, metalness: 0.8 }
                },
                {
                    id: `${prefix}-vertical-stabilizer`,
                    name: 'Vertical Fin Stabilizer',
                    type: 'box',
                    position: [0, 4.2, 4.5],
                    rotation: [0, 0, 0],
                    scale: [0.3, 3.2, 2.5],
                    material: { color: 0x00f3ff, roughness: 0.2, metalness: 0.9 }
                }
            ];
        }

        // Default General Spatial Scene Blueprint
        return [
            {
                id: `${prefix}-spatial-core`,
                name: 'Central Spatial Monolith',
                type: 'box',
                position: [0, 3, 0],
                rotation: [0, 0, 0],
                scale: [4, 6, 4],
                material: { color: 0x00f3ff, roughness: 0.2, metalness: 0.9 },
                subdivisions: 1,
                modifiers: [{ type: 'bevel', params: { offset: 0.1 } }]
            },
            {
                id: `${prefix}-ground-platform`,
                name: 'Platform Foundation',
                type: 'cylinder',
                position: [0, -0.5, 0],
                rotation: [0, 0, 0],
                scale: [18, 1, 18],
                material: { color: 0x1e293b, roughness: 0.6, metalness: 0.4 }
            }
        ];
    }

    private deriveLightingPreset(theme: string, _prompt: string): {
        preset: string;
        ambientIntensity: number;
        keyLight?: any;
        fillLight?: any;
        rimLight?: any;
    } {
        switch (theme) {
            case 'battlefield':
                return {
                    preset: 'dawn',
                    ambientIntensity: 0.5,
                    keyLight: { color: 0xffb74d, intensity: 1.4, position: [-40, 25, 40] },
                    fillLight: { color: 0x7986cb, intensity: 0.6, position: [30, 15, -20] },
                    rimLight: { color: 0xffe082, intensity: 0.8, position: [0, 20, -30] }
                };
            case 'city':
                return {
                    preset: 'cyberpunk',
                    ambientIntensity: 0.6,
                    keyLight: { color: 0x00f3ff, intensity: 1.6, position: [30, 60, 40] },
                    fillLight: { color: 0xff007f, intensity: 0.8, position: [-30, 20, -20] },
                    rimLight: { color: 0x8b5cf6, intensity: 1.0, position: [0, 40, -40] }
                };
            case 'solar-system':
                return {
                    preset: 'deep-space',
                    ambientIntensity: 0.15,
                    keyLight: { color: 0xffeedd, intensity: 2.5, position: [0, 0, 0] },
                    fillLight: { color: 0x38bdf8, intensity: 0.2, position: [20, 20, 20] }
                };
            case 'molecular':
                return {
                    preset: 'studio',
                    ambientIntensity: 0.7,
                    keyLight: { color: 0xffffff, intensity: 1.5, position: [15, 20, 15] },
                    fillLight: { color: 0x00f3ff, intensity: 0.8, position: [-15, 10, -15] }
                };
            case 'architecture':
                return {
                    preset: 'spotlight',
                    ambientIntensity: 0.4,
                    keyLight: { color: 0xffffff, intensity: 1.8, position: [0, 18, 0] },
                    fillLight: { color: 0x94a3b8, intensity: 0.5, position: [15, 10, 15] }
                };
            case 'flight':
                return {
                    preset: 'daylight',
                    ambientIntensity: 0.6,
                    keyLight: { color: 0xfffaf0, intensity: 1.6, position: [30, 40, 20] },
                    fillLight: { color: 0x38bdf8, intensity: 0.7, position: [-20, 10, -20] }
                };
            default:
                return {
                    preset: 'three-point',
                    ambientIntensity: 0.5,
                    keyLight: { color: 0xffffff, intensity: 1.4, position: [20, 25, 20] },
                    fillLight: { color: 0x38bdf8, intensity: 0.6, position: [-20, 15, 10] },
                    rimLight: { color: 0xec4899, intensity: 0.8, position: [0, 20, -25] }
                };
        }
    }

    // ========================================================================
    // General Dynamic Agent Stage Execution (Existing Multi-Agent Deep-Write)
    // ========================================================================

    /**
     * Executes a single dynamic stage of the multi-agent planning DAG.
     */
    public async executeStage(
        goalPlan: DiscoveredGoalPlan,
        stage: DynamicAgentStage,
        previousContext: Record<string, any>,
        userFeedback?: string
    ): Promise<{
        success: boolean;
        output: {
            description: string;
            content: string;
            files?: Record<string, string>;
            artifacts?: Array<{ type: string; title: string; data: any }>;
        };
        error?: string;
    }> {
        // Incorporate codebase patterns & conventions
        let patternPrompt = '';
        try {
            const patternAnalysis = this.getPatternEngine().analyzeFilesPatterns([]);
            if (patternAnalysis && patternAnalysis.summaryPromptContext) {
                patternPrompt = `\n\nWorkspace Conventions:\n${patternAnalysis.summaryPromptContext}`;
            }
        } catch {
            // Ignore pattern analysis errors
        }

        // Incorporate symbol graph context for relevant stage targets
        let symbolPrompt = '';
        try {
            const symResult = this.getContextGraphService().retrieveSymbolGraph({
                query: `${stage.name} ${goalPlan.goal}`,
                maxSymbols: 8
            });
            if (symResult && symResult.matchingSymbols.length > 0) {
                symbolPrompt = `\n\nRelevant Symbols Subgraph:\n${symResult.compressedPromptContext}`;
            }
        } catch {
            // Ignore symbol graph errors
        }

        const systemInstruction = `You are a highly specialized Deep-Planning agent representing the role: "${stage.assignedAgentRole}".
Your current task is: "${stage.name}" - ${stage.description}.

Global Project Goal: "${goalPlan.goal}"
Target Platform Domains: ${goalPlan.domains.join(', ')}
Target Primitives & Canvas Elements: ${goalPlan.deliverables.primitives.join(', ')}
${patternPrompt}${symbolPrompt}

In your output, you MUST address and generate the expected deliverables and files.
Target Files to create or update:
${goalPlan.deliverables.filePaths.map(p => `- ${p}`).join('\n')}

Previous Plan History and Stage Outputs:
${JSON.stringify(previousContext, null, 2)}
${userFeedback ? `\nUser Correction / Feedback for this Stage:\n"${userFeedback}"` : ''}

You MUST produce a comprehensive, exhaustive output. Do NOT write placeholders, truncated snippets, or "insert code here". Write complete implementations, full type contracts, actual shader algorithms, and fully populated specs.

You MUST respond with a single valid JSON object containing no markdown wrapping, matching this exact structure:
{
  "description": "Brief executive summary of what was accomplished, planned, or authored in this stage.",
  "content": "Fully-formed Markdown or HTML documenting the specifications, designs, or mathematical models of this stage.",
  "files": {
    "src/file1.cpp": "// Complete, non-truncated file contents here...",
    "shaders/custom.wgsl": "..."
  },
  "artifacts": [
    {
      "type": "markdown-document",
      "title": "Stage Deliverable Specification",
      "data": { ... }
    }
  ]
}
`;

        if (!this.geminiService) {
            return {
                success: true,
                output: {
                    description: `Completed stage ${stage.name}.`,
                    content: `Deterministic fallback execution for stage ${stage.name}.`,
                    files: {}
                }
            };
        }

        let accumulatedText = '';
        try {
            await this.geminiService.streamGenerate(
                {
                    prompt: `Execute stage "${stage.id}" within the global goal plan. Respond with your structured stage JSON output.`,
                    systemInstruction,
                    model: 'gemini-3.7-flash',
                    temperature: 0.2,
                    thinkingBudget: 1024
                },
                event => {
                    if (event.text) {
                        accumulatedText += event.text;
                    }
                }
            );
        } catch (err: any) {
            console.error(`[DynamicDagPlanner] Failed to execute stage ${stage.id}:`, err);
            return {
                success: false,
                output: { description: '', content: '' },
                error: err.message || 'Error occurred during dynamic stage execution.'
            };
        }

        const cleaned = accumulatedText.trim();
        let jsonStr = cleaned;
        const codeBlockMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
        if (codeBlockMatch) {
            jsonStr = codeBlockMatch[1].trim();
        } else {
            const objectMatch = cleaned.match(/\{[\s\S]*\}/);
            if (objectMatch) {
                jsonStr = objectMatch[0].trim();
            }
        }

        try {
            const result = JSON.parse(jsonStr);
            return {
                success: true,
                output: result
            };
        } catch (parseErr) {
            return {
                success: true,
                output: {
                    description: `Completed stage ${stage.name}.`,
                    content: accumulatedText,
                    files: {}
                }
            };
        }
    }
}
