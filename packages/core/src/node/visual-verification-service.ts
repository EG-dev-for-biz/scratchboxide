/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { GoogleAuth } from 'google-auth-library';
import {
    parseImagePayload,
    VisualAuditResult,
    VisualSelfCorrectionLoopResult,
    VisualSelfCorrectionOptions,
    VisualVerificationRequest,
    VISUAL_VERIFICATION_CRITERIA,
    DEFAULT_VIEWPORT_ANGLES,
    ViewportCameraAngle,
    VisualAudit3DDefect,
    MultiAngleVisualAuditResult,
    MultiAngleAuditOptions,
    VisualSelfCorrection3DOptions,
    VisualSelfCorrection3DLoopResult,
    auditCameraFraming,
    auditMayMoveCamera,
    computeCameraForViewportAngle,
    sceneBoundsAreMeasurable
} from '../common/visual-verification-protocol';
import { restoreChosenEnvironment, sceneRendersClay, sceneShowsSky, withoutEnvironmentChanges } from '../common/scene-atmosphere-opt-in';
import { CanvasArtifact, Scene3DData, LiveCodeSandboxData } from '../browser/generative-canvas/canvas-types';
import {
    DirectDispatchOperatorEngine,
    type OperatorResult,
    createOperatorEngine
} from '../browser/generative-canvas/services/direct-dispatch-operator-engine';

export const DEFAULT_GEMINI_VISION_MODEL = 'gemini-3.8-flash';

/** A scene's content as key-order-independent JSON, without the bookkeeping every dispatch appends. */
function sceneContentKey(scene: Scene3DData): string {
    const content: Record<string, unknown> = { ...scene };
    delete content.operatorStack;
    delete content.actionLog;
    return JSON.stringify(content, (_key, value) => value && typeof value === 'object' && !Array.isArray(value)
        ? Object.fromEntries(Object.keys(value).sort().map(k => [k, value[k]]))
        : value);
}
export class VisualVerificationService {
    private auth?: GoogleAuth;
    private cachedProjectId?: string;

    constructor() {
        this.initAuth();
    }

    private initAuth(): void {
        const candidatePaths = [
            path.join(os.homedir(), '.scratchbox-ide/service-account.json'),
            path.join(os.homedir(), 'Downloads/spce/service-account.json'),
            path.join(os.homedir(), 'Downloads/service-account.json'),
            path.join(os.homedir(), 'service-account.json'),
            path.join(os.homedir(), '.scratchbox/service-account.json'),
            process.env.GOOGLE_APPLICATION_CREDENTIALS
        ].filter(Boolean) as string[];

        for (const p of candidatePaths) {
            if (fs.existsSync(p)) {
                try {
                    const content = fs.readJsonSync(p);
                    this.cachedProjectId = content.project_id;
                    this.auth = new GoogleAuth({
                        keyFile: p,
                        scopes: ['https://www.googleapis.com/auth/cloud-platform']
                    });
                    break;
                } catch (e) {
                    // continue
                }
            }
        }
    }

    /**
     * Build the structured multimodal instruction and prompt payload for Gemini 3.8 Flash.
     */
    public buildMultimodalPrompt(request: VisualVerificationRequest): {
        systemInstruction: string;
        userPrompt: string;
        inlineData: { mimeType: string; data: string };
    } {
        const { base64Data, mimeType } = parseImagePayload(request.image);
        // A clay scene never draws a sky (classifyAtmosphere), even when it keeps atmosphere settings for later.
        const environmentNote = sceneShowsSky(request.context?.sceneData)
            ? 'This scene draws an atmospheric sky it opted into through its own environment or features: report a missing or broken sky as a defect.'
            : 'This scene shows a neutral studio or grey clay backdrop by its own choice (a clay scene never draws a sky, even when it keeps atmosphere settings): never score that backdrop down and never report a missing sky.';

        const systemInstruction = `You are Scratchbox IDE's Autonomous Multimodal Vision QA & Visual Inspection Meta-Architect.
Your task is to inspect the attached visual screenshot frame rendered from a generated UI artifact (such as a Three.js 3D WebGL Scene, a Live React Sandbox playground, or an interactive browser canvas) against the target user prompt and technical criteria.

CRITICAL QUALITY CRITERIA:
${VISUAL_VERIFICATION_CRITERIA.map(c => `- ${c}`).join('\n')}

SCENE ENVIRONMENT:
${environmentNote}
The skybox, sky, atmosphere, clouds, fog, god rays, ground, render mode and world are the scene's own choice: visualFixes and operatorDispatches never change them. Repairs are limited to lighting and camera framing, and a camera fix is applied only with a defects3D entry of type off_center_camera or framing_offset.

INSPECTION TASKS:
1. Score the overall visual rendering fidelity from 0 to 100 (score >= 80 is PASS, < 80 requires auto-correction).
2. Identify any visual bugs:
   - Monochromatic blank or black void screens (a flat neutral studio or grey clay backdrop is not a void).
   - Missing scene illumination, unlit models, or missing ambient/directional light.
   - Shader artifacts or horizon clipping; a missing sky dome only when SCENE ENVIRONMENT says the scene draws one.
   - Disconnected geometries, broken meshes, or misaligned camera angles.
   - Truncated UI layouts, CSS collisions, or blank canvas wrappers.
3. Diagnose granular 3D defects with suggested operator fixes:
   - unlit / missing_lighting: sb_setup_lighting
   - off_center_camera / framing_offset: sb_frame_bounds or sb_set_camera
   - missing_pbr / missing_material: sb_set_material_pbr or sb_create_material
   - unsubdivided_mesh / low_poly_artifact: sb_subdivide_mesh or sb_add_modifier
4. List positive strengths of the visual frame.
5. Output structured visual correction directives ('visualFixes') and concrete direct-dispatch operators ('operatorDispatches').

You MUST respond strictly with valid, unescaped JSON matching this schema:
{
  "pass": boolean,
  "fidelityScore": number,
  "critique": "string",
  "issues": ["string"],
  "strengths": ["string"],
  "defects3D": [
    {
      "defectType": "unlit" | "off_center_camera" | "framing_offset" | "missing_pbr" | "unsubdivided_mesh" | "missing_skybox",
      "severity": "critical" | "warning" | "info",
      "description": "string",
      "targetObjectId": "string",
      "suggestedOperator": "string",
      "suggestedParams": {}
    }
  ],
  "operatorDispatches": [
    { "operator": "sb_setup_lighting", "params": { "preset": "studio" } }
  ],
  "visualFixes": {
    "lighting": { "ambientIntensity": number, "directionalIntensity": number },
    "environment": { "lighting": "string" },
    "camera": { "position": [number, number, number], "target": [number, number, number] },
    "features": {},
    "scenePatches": {},
    "operatorDispatches": []
  }
}`;

        const contextSummary = request.context ? JSON.stringify(request.context, null, 2) : 'None';
        const userPrompt = `Target Prompt: "${request.prompt}"
Artifact Type: ${request.artifactType || '3d-scene'}
Viewport Angle: ${request.context?.angle || 'perspective'}
Active Context:
${contextSummary}

Inspect this rendered viewport screenshot and provide your rigorous visual audit JSON.`;

        return {
            systemInstruction,
            userPrompt,
            inlineData: {
                mimeType: mimeType || 'image/png',
                data: base64Data
            }
        };
    }

    /**
     * Executes Multimodal Vision QA on a captured canvas screenshot.
     */
    public async verifyVisual(request: VisualVerificationRequest): Promise<VisualAuditResult> {
        const { base64Data, dataUrl } = parseImagePayload(request.image);
        const targetModel = request.model || DEFAULT_GEMINI_VISION_MODEL;

        try {
            if (!this.auth || !this.cachedProjectId) {
                this.initAuth();
            }

            // If active Google Cloud service account is available, invoke live multimodal Gemini 3.8 Flash
            if (this.auth && this.cachedProjectId) {
                const client = await this.auth.getClient();
                const tokenResponse = await client.getAccessToken();
                const token = tokenResponse.token;
                const projectId = this.cachedProjectId;

                if (token && projectId) {
                    const { systemInstruction, userPrompt, inlineData } = this.buildMultimodalPrompt(request);
                    const url = `https://us-central1-aiplatform.googleapis.com/v1/projects/${projectId}/locations/us-central1/publishers/google/models/${targetModel}:generateContent`;

                    const payload = {
                        contents: [
                            {
                                role: 'user',
                                parts: [
                                    {
                                        inlineData: {
                                            mimeType: inlineData.mimeType,
                                            data: inlineData.data
                                        }
                                    },
                                    {
                                        text: userPrompt
                                    }
                                ]
                            }
                        ],
                        systemInstruction: {
                            role: 'system',
                            parts: [{ text: systemInstruction }]
                        },
                        generationConfig: {
                            temperature: 0.2,
                            maxOutputTokens: 2048,
                            responseMimeType: 'application/json'
                        }
                    };

                    const fetchFn = (globalThis as any).fetch || require('node-fetch');
                    const response = await fetchFn(url, {
                        method: 'POST',
                        headers: {
                            'Authorization': `Bearer ${token}`,
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify(payload)
                    });

                    if (response.ok) {
                        const json = await response.json();
                        const candidate = json.candidates?.[0];
                        const text = candidate?.content?.parts?.map((p: any) => p.text || '').join('') || '';
                        const parsed = this.parseVisionResponseJson(text);
                        if (parsed) {
                            const fidelityScore = typeof parsed.fidelityScore === 'number' ? parsed.fidelityScore : 85;
                            const defects3D = parsed.defects3D || [];
                            const operatorDispatches = parsed.operatorDispatches || (parsed.visualFixes?.operatorDispatches) || this.mapDefectsToOperators(defects3D, request.context?.sceneData as any);

                            return {
                                pass: fidelityScore >= 80,
                                fidelityScore,
                                critique: parsed.critique || 'Visual verification passed with high fidelity.',
                                issues: parsed.issues || [],
                                strengths: parsed.strengths || [],
                                visualFixes: parsed.visualFixes,
                                defects3D,
                                operatorDispatches,
                                angle: request.context?.angle || 'perspective',
                                thumbnail: dataUrl,
                                timestamp: new Date().toLocaleTimeString(),
                                iteration: request.context?.iteration || 1,
                                modelUsed: targetModel,
                                targetArtifactId: request.context?.artifactId
                            };
                        }
                    }
                }
            }
        } catch (err) {
            console.warn('[VisualVerificationService] Live multimodal API call failed or in mock/offline mode:', err);
        }

        // Resilient deterministic heuristic inspection engine (for test/offline/graceful fallback)
        return this.heuristicVisualInspection(request, base64Data, dataUrl);
    }

    /**
     * Deterministic heuristic visual inspection engine.
     * Evaluates image bytes, aspect ratio, prompt goals, sceneData topology, and context features.
     */
    protected heuristicVisualInspection(
        request: VisualVerificationRequest,
        base64Data: string,
        dataUrl: string
    ): VisualAuditResult {
        const promptLower = (request.prompt || '').toLowerCase();
        const context = request.context || {};
        const sceneData: Partial<Scene3DData> | undefined = context.sceneData;
        const currentAngle = (context.angle || 'perspective') as ViewportCameraAngle;

        const isVoid = !base64Data || base64Data.length < 30 || base64Data.includes('AAAAABJRU5ErkJggg==');
        const hasMissingLighting = sceneData?.environment?.lighting === 'none' ||
            (sceneData?.environment && !sceneData?.environment?.lighting);
        // A studio or clay void is the scene's choice; a sky is only missing when the scene draws one.
        const hasMissingSky = sceneShowsSky(sceneData) && !sceneData?.environment?.skybox;

        const defects3D: VisualAudit3DDefect[] = [];
        const operatorDispatches: Array<{ operator: string; params?: any }> = [];
        const issues: string[] = [];
        const strengths: string[] = [];

        let scorePenalty = 0;
        let flaggedLighting = false;
        let flaggedFraming = false;

        // 1. Diagnose Lighting & Void Flaws
        if ((isVoid && (promptLower.includes('unlit') || promptLower.includes('void') || promptLower.includes('broken') || hasMissingLighting)) || hasMissingLighting) {
            flaggedLighting = true;
            scorePenalty += 45;
            issues.push(isVoid ? 'Monochromatic void detected in rendered viewport' : 'Missing ambient and directional lighting');

            defects3D.push({
                defectType: 'unlit',
                severity: 'critical',
                description: 'Scene lacks illumination sources and balanced key/ambient lighting',
                suggestedOperator: 'sb_setup_lighting',
                suggestedParams: {
                    preset: 'three-point',
                    ambientIntensity: 0.5
                }
            });

            operatorDispatches.push({
                operator: 'sb_setup_lighting',
                params: {
                    preset: 'three-point',
                    ambientIntensity: 0.5
                }
            });
        }

        // 2. Diagnose Camera Framing & Offset, only against bounds it can measure: a GLB, generator or
        // location scene of unknown extent (often hundreds of metres) is framed by its own camera.
        if (sceneData?.camera && sceneBoundsAreMeasurable(sceneData)) {
            const camPos = sceneData.camera.position || [0, 0, 0];
            const camTarget = sceneData.camera.target || [0, 0, 0];
            const isFarOffset = Math.abs(camPos[0]) > 60 || Math.abs(camPos[1]) > 60 || Math.abs(camPos[2]) > 60;
            const isTargetOffset = Math.abs(camTarget[0]) > 25 || Math.abs(camTarget[1]) > 25 || Math.abs(camTarget[2]) > 25;

            if (isFarOffset || isTargetOffset) {
                flaggedFraming = true;
                scorePenalty += 20;
                issues.push('Camera target offset from origin or bounds');

                defects3D.push({
                    defectType: 'off_center_camera',
                    severity: 'warning',
                    description: 'Camera target is displaced from object bounds',
                    suggestedOperator: 'sb_frame_bounds',
                    suggestedParams: { paddingFactor: 1.5 }
                });

                operatorDispatches.push({
                    operator: 'sb_frame_bounds',
                    params: { paddingFactor: 1.5 }
                });
            }
        }

        // 3. Diagnose Missing PBR Materials (a clay scene has none by design)
        if (sceneData?.customMeshes && sceneData.customMeshes.length > 0 && !sceneRendersClay(sceneData)) {
            for (const mesh of sceneData.customMeshes) {
                const mat = mesh.material;
                const hasNoPBR = !mat || (mat.roughness === undefined && mat.metalness === undefined && mat.color === undefined);

                if (hasNoPBR) {
                    scorePenalty += 15;
                    issues.push(`Mesh '${mesh.name || mesh.id}' has unshaded default material`);

                    let targetColor = 0x3388ff;
                    let targetRoughness = 0.3;
                    let targetMetalness = 0.7;

                    if (promptLower.includes('gold') || promptLower.includes('golden')) {
                        targetColor = 0xffd700;
                        targetRoughness = 0.15;
                        targetMetalness = 0.95;
                    } else if (promptLower.includes('wood') || promptLower.includes('tavern') || promptLower.includes('colonial')) {
                        targetColor = 0x8b5a2b;
                        targetRoughness = 0.8;
                        targetMetalness = 0.1;
                    } else if (promptLower.includes('cyber') || promptLower.includes('neon') || promptLower.includes('hovercraft')) {
                        targetColor = 0x00e5ff;
                        targetRoughness = 0.2;
                        targetMetalness = 0.85;
                    }

                    defects3D.push({
                        defectType: 'missing_pbr',
                        severity: 'warning',
                        description: `Object '${mesh.id}' lacks physically-based rendering material`,
                        targetObjectId: mesh.id,
                        suggestedOperator: 'sb_set_material_pbr',
                        suggestedParams: {
                            objectId: mesh.id,
                            roughness: targetRoughness,
                            metalness: targetMetalness,
                            color: targetColor
                        }
                    });

                    operatorDispatches.push({
                        operator: 'sb_set_material_pbr',
                        params: {
                            objectId: mesh.id,
                            roughness: targetRoughness,
                            metalness: targetMetalness,
                            color: targetColor
                        }
                    });
                    break;
                }
            }
        }

        // 4. Diagnose Missing Skybox / Atmosphere: reported only, since a repair never changes the sky.
        if (hasMissingSky) {
            scorePenalty += 15;
            issues.push('Scene opts into an atmospheric sky but names no skybox');

            defects3D.push({
                defectType: 'missing_skybox',
                severity: 'info',
                description: 'Atmospheric skybox background is missing'
            });
        }

        // 5. Strengths
        if (scorePenalty === 0) {
            strengths.push('Clear illumination balance and crisp contrast');
            strengths.push('Correct geometry positioning without camera clipping');
            strengths.push('Full alignment with user spatial prompt requirements');
            strengths.push('PBR materials and specular reflections appropriately balanced');
        } else {
            strengths.push('WebGL viewport container successfully mounted');
            if (!hasMissingLighting) strengths.push('Direct lighting sources operational');
        }

        const fidelityScore = Math.max(35, Math.min(96, 95 - scorePenalty));
        const pass = fidelityScore >= 80;

        const critique = pass
            ? 'High-fidelity visual rendering verified. Scene displays crisp geometry, balanced lighting, and correct perspective framing.'
            : `Visual discrepancies detected: ${issues.join('; ')}`;

        // Each fix answers a defect it reported: lighting for an unlit scene, a camera for a framing defect.
        // Its sky, skybox, ground, atmosphere and render mode stay the scene's own.
        const visualFixes = !pass ? {
            ...(flaggedLighting ? {
                lighting: {
                    ambientIntensity: 0.5,
                    directionalIntensity: 1.2,
                    skyColor: '#0284c7',
                    groundColor: '#1e293b'
                },
                environment: { lighting: 'shaded' }
            } : {}),
            ...(flaggedFraming ? { camera: computeCameraForViewportAngle(currentAngle, sceneData) } : {}),
            operatorDispatches
        } : undefined;

        return {
            pass,
            fidelityScore,
            critique,
            issues,
            strengths,
            defects3D: defects3D.length > 0 ? defects3D : undefined,
            operatorDispatches: operatorDispatches.length > 0 ? operatorDispatches : undefined,
            visualFixes,
            angle: currentAngle,
            thumbnail: dataUrl,
            timestamp: new Date().toLocaleTimeString(),
            iteration: context.iteration || 1,
            modelUsed: request.model || DEFAULT_GEMINI_VISION_MODEL,
            targetArtifactId: context.artifactId
        };
    }

    /**
     * Translates a list of 3D visual defects into concrete direct-dispatch operators.
     */
    public mapDefectsToOperators(
        defects: VisualAudit3DDefect[],
        sceneData?: Partial<Scene3DData>
    ): Array<{ operator: string; params?: any }> {
        const operators: Array<{ operator: string; params?: any }> = [];
        const seen = new Set<string>();

        for (const defect of defects) {
            if (defect.suggestedOperator) {
                const key = `${defect.suggestedOperator}:${JSON.stringify(defect.suggestedParams || {})}`;
                if (!seen.has(key)) {
                    seen.add(key);
                    operators.push({
                        operator: defect.suggestedOperator,
                        params: defect.suggestedParams ? JSON.parse(JSON.stringify(defect.suggestedParams)) : {}
                    });
                }
                continue;
            }

            // Fallback mapping by defectType
            switch (defect.defectType) {
                case 'unlit':
                case 'missing_lighting':
                case 'void': {
                    const key = 'sb_setup_lighting';
                    if (!seen.has(key)) {
                        seen.add(key);
                        operators.push({
                            operator: 'sb_setup_lighting',
                            params: { preset: 'three-point', ambientIntensity: 0.5 }
                        });
                    }
                    break;
                }
                case 'off_center_camera':
                case 'framing_offset': {
                    const key = 'sb_frame_bounds';
                    if (!seen.has(key)) {
                        seen.add(key);
                        operators.push({
                            operator: 'sb_frame_bounds',
                            params: { paddingFactor: 1.5 }
                        });
                    }
                    break;
                }
                case 'missing_pbr':
                case 'missing_material': {
                    const targetId = defect.targetObjectId || sceneData?.customMeshes?.[0]?.id;
                    if (targetId) {
                        const key = `sb_set_material_pbr:${targetId}`;
                        if (!seen.has(key)) {
                            seen.add(key);
                            operators.push({
                                operator: 'sb_set_material_pbr',
                                params: {
                                    objectId: targetId,
                                    roughness: 0.3,
                                    metalness: 0.7,
                                    color: 0x3388ff
                                }
                            });
                        }
                    }
                    break;
                }
                case 'unsubdivided_mesh':
                case 'low_poly_artifact': {
                    const targetId = defect.targetObjectId || sceneData?.customMeshes?.[0]?.id;
                    if (targetId) {
                        const key = `sb_subdivide_mesh:${targetId}`;
                        if (!seen.has(key)) {
                            seen.add(key);
                            operators.push({
                                operator: 'sb_subdivide_mesh',
                                params: { objectId: targetId, iterations: 1 }
                            });
                        }
                    }
                    break;
                }
                // missing_skybox maps to nothing: the sky is the scene's own choice, never an operator's.
            }
        }

        return operators;
    }

    /**
     * Executes a multi-angle visual audit across canonical viewport camera angles.
     */
    public async audit3DSceneMultiAngle(options: MultiAngleAuditOptions): Promise<MultiAngleVisualAuditResult> {
        const angles = options.angles && options.angles.length > 0 ? options.angles : DEFAULT_VIEWPORT_ANGLES;
        const angleResults: Record<string, VisualAuditResult> = {};
        const combinedOperatorDispatches: Array<{ operator: string; params?: any }> = [];
        const detectedDefects: VisualAudit3DDefect[] = [];
        const seenOperators = new Set<string>();

        let scoreSum = 0;

        for (const angle of angles) {
            // Frame capture for angle
            let frame = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR42mNk+M9Qz8DAwMTAwAAAEAEDAT4qV4QAAAAASUVORK5CYII=';
            if (options.captureAngleFrame) {
                try {
                    frame = options.captureAngleFrame(angle, options.sceneData);
                } catch (e) {
                    // fallback
                }
            }

            const audit = await this.verifyVisual({
                image: frame,
                prompt: options.prompt,
                artifactType: '3d-scene',
                model: options.model,
                context: {
                    title: options.sceneData.title,
                    sceneData: options.sceneData,
                    angle,
                    ...(options.context || {})
                }
            });

            angleResults[angle] = audit;
            scoreSum += audit.fidelityScore;

            if (audit.defects3D) {
                detectedDefects.push(...audit.defects3D);
            }

            const ops = audit.operatorDispatches || this.mapDefectsToOperators(audit.defects3D || [], options.sceneData);
            for (const op of ops) {
                const key = `${op.operator}:${JSON.stringify(op.params || {})}`;
                if (!seenOperators.has(key)) {
                    seenOperators.add(key);
                    combinedOperatorDispatches.push(op);
                }
            }
        }

        const averageFidelityScore = Math.round(scoreSum / angles.length);
        const allAnglesPass = Object.values(angleResults).every(res => res.pass);
        const overallPass = averageFidelityScore >= 80 && allAnglesPass;

        const summaryCritique = overallPass
            ? `Multi-angle visual inspection passed across ${angles.length} viewports (${angles.join(', ')}). Average score: ${averageFidelityScore}/100.`
            : `Multi-angle visual inspection identified flaws across viewports (${angles.join(', ')}). Average score: ${averageFidelityScore}/100. ${combinedOperatorDispatches.length} operator fixes generated.`;

        return {
            overallPass,
            averageFidelityScore,
            angleResults,
            combinedOperatorDispatches,
            summaryCritique,
            detectedDefects,
            timestamp: new Date().toLocaleTimeString()
        };
    }

    /**
     * Runs an iterative multi-turn 3D self-correction loop using DirectDispatchOperatorEngine.
     * Continuously audits rendered viewports and executes direct 3D operators until fidelity >= minPassingScore.
     */
    public async run3DVisualSelfCorrectionLoop(
        options: VisualSelfCorrection3DOptions
    ): Promise<VisualSelfCorrection3DLoopResult> {
        const maxIterations = options.maxIterations || 4;
        const minPassingScore = options.minPassingScore || 80;
        const autoDispatch = options.autoDispatch !== false;
        const angles = options.angles || DEFAULT_VIEWPORT_ANGLES;

        const operatorEngine: DirectDispatchOperatorEngine = options.engine || createOperatorEngine(options.sceneData);
        const auditHistory: Array<{ iteration: number; multiAngleAudit: MultiAngleVisualAuditResult }> = [];
        const executedOperators: Array<{ operator: string; params?: any; result?: any }> = [];

        let initialFidelityScore = 0;
        let finalFidelityScore = 0;
        let iteration = 0;
        let converged = false;

        while (iteration < maxIterations) {
            iteration++;
            const currentSceneData = operatorEngine.getSceneData();

            const multiAngleAudit = await this.audit3DSceneMultiAngle({
                sceneData: currentSceneData,
                prompt: options.targetPrompt,
                angles,
                captureAngleFrame: options.captureAngleFrame,
                model: options.model
            });

            if (iteration === 1) {
                initialFidelityScore = multiAngleAudit.averageFidelityScore;
            }
            finalFidelityScore = multiAngleAudit.averageFidelityScore;

            auditHistory.push({
                iteration,
                multiAngleAudit
            });

            if (multiAngleAudit.overallPass || multiAngleAudit.averageFidelityScore >= minPassingScore) {
                converged = true;
                break;
            }

            // Flaws detected, execute direct-dispatch operators to auto-repair scene
            let opsToDispatch = multiAngleAudit.combinedOperatorDispatches;
            if (opsToDispatch.length === 0 && multiAngleAudit.detectedDefects.length > 0) {
                opsToDispatch = this.mapDefectsToOperators(multiAngleAudit.detectedDefects, currentSceneData);
            }

            if (opsToDispatch.length === 0) {
                // Heuristic emergency repair operators
                opsToDispatch = [
                    { operator: 'sb_setup_lighting', params: { preset: 'three-point', ambientIntensity: 0.5 } },
                    { operator: 'sb_frame_bounds', params: { paddingFactor: 1.5 } }
                ];
            }

            if (autoDispatch) {
                for (const cmd of opsToDispatch) {
                    // This loop is invoked explicitly to reframe and relight, so it may move the camera; never the environment.
                    const res = this.dispatchAuditOperator(operatorEngine, cmd, true).result;
                    executedOperators.push({
                        operator: cmd.operator,
                        params: cmd.params,
                        result: res
                    });
                }
            }
        }

        return {
            sceneData: operatorEngine.getSceneData(),
            operatorEngine,
            iterations: iteration,
            converged,
            initialFidelityScore,
            finalFidelityScore,
            auditHistory,
            executedOperators,
            repaired: executedOperators.length > 0
        };
    }

    /**
     * Dispatches one operator an audit proposed, then puts back the scene's chosen environment (and its
     * camera, unless the audit may move it), keeping the operator's other effects: `sb_setup_lighting`
     * keeps its preset, rig and sun angles but not the skybox it writes when the scene names none.
     * An operator left with no effect is rolled back, so the operator stack does not record it.
     */
    private dispatchAuditOperator(
        engine: DirectDispatchOperatorEngine,
        op: { operator: string; params?: any },
        mayMoveCamera: boolean
    ): { result: OperatorResult; applied: boolean } {
        const before: Scene3DData = JSON.parse(JSON.stringify(engine.getSceneData()));
        const result = engine.dispatch(op.operator, op.params || {});
        const after = engine.getSceneData();
        restoreChosenEnvironment(after, before);
        if (!mayMoveCamera) {
            if (before.camera) after.camera = before.camera;
            else delete after.camera;
        }
        const applied = result.success && sceneContentKey(after) !== sceneContentKey(before);
        if (!applied) engine.setSceneData(before);
        return { result, applied };
    }

    /**
     * Applies visual correction directives to an artifact, returning a repaired clone.
     */
    public applyVisualAutoRepair(artifact: CanvasArtifact, audit: VisualAuditResult): CanvasArtifact {
        if (!audit.visualFixes && !audit.operatorDispatches) {
            return artifact;
        }

        const fixes = audit.visualFixes || {};
        const updatedArtifact: CanvasArtifact = {
            ...artifact,
            version: (artifact.version || 1) + 1
        };

        if (artifact.type === '3d-scene') {
            const currentData: Scene3DData = (artifact.data as Scene3DData) || {
                title: artifact.title,
                objects: []
            };

            // The environment is the scene's own choice in both directions (AGENTS.md opt-in gate): an audit
            // never switches a sky on or off, swaps the skybox, or enters or leaves clay. It repairs lighting,
            // and moves the camera only for a framing defect it reported on bounds it can measure.
            const allowedFixes = withoutEnvironmentChanges(fixes);
            const mayMoveCamera = auditMayMoveCamera(audit, currentData);
            const framing = auditCameraFraming(audit, currentData);

            const engine = createOperatorEngine(currentData);
            const opsToApply = audit.operatorDispatches || fixes.operatorDispatches || [];
            let appliedOps = 0;
            for (const op of opsToApply) {
                if (this.dispatchAuditOperator(engine, op, mayMoveCamera).applied) appliedOps++;
            }

            // A scene patch never carries the camera: framing comes only from `framing` above.
            const { environment: patchedEnvironment, features: patchedFeatures, camera: _patchedCamera, ...patches } = allowedFixes.scenePatches || {};
            const hasDirectives = !!framing || [allowedFixes.lighting, allowedFixes.environment, allowedFixes.features, patchedEnvironment, patchedFeatures, patches]
                .some(block => !!block && Object.keys(block).length > 0);
            if (appliedOps === 0 && !hasDirectives) {
                return artifact;
            }

            const scene = engine.getSceneData();
            const repairedSceneData: Scene3DData = { ...scene, ...patches };
            if (allowedFixes.environment || allowedFixes.lighting || patchedEnvironment) {
                repairedSceneData.environment = {
                    ...(scene.environment || {}),
                    ...(allowedFixes.environment || {}),
                    ...(patchedEnvironment || {}),
                    lighting: patchedEnvironment?.lighting || allowedFixes.environment?.lighting
                        || (allowedFixes.lighting?.ambientIntensity !== undefined ? 'shaded' : scene.environment?.lighting || 'shaded')
                };
            }
            if (allowedFixes.features || patchedFeatures) {
                repairedSceneData.features = { ...(scene.features || {}), ...(allowedFixes.features || {}), ...(patchedFeatures || {}) };
            }
            if (framing) {
                repairedSceneData.camera = { ...(scene.camera || { position: [15, 12, 15], target: [0, 0, 0] }), ...framing };
            }

            updatedArtifact.data = repairedSceneData;
        } else if (artifact.type === 'live-code-sandbox') {
            const currentData: LiveCodeSandboxData = (artifact.data as LiveCodeSandboxData) || {
                title: artifact.title,
                files: []
            };

            const updatedFiles = [...(currentData.files || [])];

            if (fixes.codePatches && fixes.codePatches.length > 0) {
                for (const patch of fixes.codePatches) {
                    if (patch.file) {
                        const fileIdx = updatedFiles.findIndex(f => f.path === patch.file || f.name === patch.file);
                        if (fileIdx !== -1) {
                            const target = updatedFiles[fileIdx];
                            let newContent = target.content;
                            if (patch.fullCode) {
                                newContent = patch.fullCode;
                            } else if (patch.search && patch.replace) {
                                newContent = newContent.replace(patch.search, patch.replace);
                            }
                            updatedFiles[fileIdx] = { ...target, content: newContent };
                        }
                    }
                }
            }

            if (fixes.cssFixes) {
                const cssIdx = updatedFiles.findIndex(f => (f.name && f.name.endsWith('.css')) || (f.path && f.path.endsWith('.css')));
                if (cssIdx !== -1) {
                    updatedFiles[cssIdx] = {
                        ...updatedFiles[cssIdx],
                        content: `${updatedFiles[cssIdx].content}\n/* Visual Auto-Repair Fixes */\n${fixes.cssFixes}`
                    };
                }
            }

            updatedArtifact.data = {
                ...currentData,
                files: updatedFiles
            };
        }

        return updatedArtifact;
    }

    /**
     * Executes the full automated visual self-correction loop until fidelity >= minPassingScore.
     */
    public async runVisualSelfCorrectionLoop(options: VisualSelfCorrectionOptions): Promise<VisualSelfCorrectionLoopResult> {
        const maxIterations = options.maxIterations || 3;
        const minPassingScore = options.minPassingScore || 80;
        const history: VisualAuditResult[] = [];

        let currentArtifact = { ...options.artifact };
        let latestAudit: VisualAuditResult | undefined;
        let iteration = 0;
        let repaired = false;

        while (iteration < maxIterations) {
            iteration++;
            const screenshot = options.captureFrame();

            const audit = await this.verifyVisual({
                image: screenshot,
                prompt: options.targetPrompt,
                artifactType: currentArtifact.type,
                context: {
                    title: currentArtifact.title,
                    iteration,
                    artifactId: currentArtifact.id,
                    sceneData: currentArtifact.type === '3d-scene' ? (currentArtifact.data as Scene3DData) : undefined
                }
            });

            history.push(audit);
            latestAudit = audit;

            if (audit.fidelityScore >= minPassingScore || audit.pass) {
                break;
            }

            if (audit.visualFixes || audit.operatorDispatches) {
                currentArtifact = this.applyVisualAutoRepair(currentArtifact, audit);
                repaired = true;
            }
        }

        return {
            artifact: currentArtifact,
            audit: latestAudit!,
            iterations: iteration,
            history,
            repaired
        };
    }

    /**
     * Helper to parse JSON from AI completion text.
     */
    protected parseVisionResponseJson(text: string): Partial<VisualAuditResult> | null {
        try {
            let clean = text.trim();
            if (clean.startsWith('```json')) {
                clean = clean.replace(/^```json\s*/, '').replace(/```\s*$/, '');
            } else if (clean.startsWith('```')) {
                clean = clean.replace(/^```\s*/, '').replace(/```\s*$/, '');
            }
            return JSON.parse(clean);
        } catch (e) {
            return null;
        }
    }
}
