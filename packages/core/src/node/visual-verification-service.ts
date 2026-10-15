/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/
import type { GoogleGenAI } from '@google/genai';
import {
    isVisualAuditUnavailable,
    parseImagePayload,
    VisualAuditResult,
    VisualAuditUnavailable,
    VisualVerificationOutcome,
    VisualSelfCorrectionLoopResult,
    VisualSelfCorrectionOptions,
    VisualVerificationRequest,
    VISUAL_VERIFICATION_CRITERIA,
    DEFAULT_VIEWPORT_ANGLES,
    VisualAudit3DDefect,
    MultiAngleVisualAuditResult,
    MultiAngleAuditOptions,
    VisualSelfCorrection3DOptions,
    VisualSelfCorrection3DLoopResult,
    auditCameraFraming,
    auditMayMoveCamera
} from '../common/visual-verification-protocol';
import { restoreChosenEnvironment, sceneShowsSky, withoutEnvironmentChanges } from '../common/scene-atmosphere-opt-in';
import { CanvasArtifact, Scene3DData, LiveCodeSandboxData } from '../browser/generative-canvas/canvas-types';
import {
    DirectDispatchOperatorEngine,
    type OperatorResult,
    createOperatorEngine
} from '../browser/generative-canvas/services/direct-dispatch-operator-engine';
import { GeminiClient } from './gemini/gemini-client';

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
/** The part of GeminiClient the vision check uses: the same Vertex-global-or-API-key client as chat. */
export interface VisionModelClient {
    getGenAIClient(): Promise<Pick<GoogleGenAI, 'models'> | undefined>;
    /** Which credential that client uses, recorded on the outcome. */
    genAIClientCredential?(): 'vertex' | 'api-key' | undefined;
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

export class VisualVerificationService {
    private readonly client: VisionModelClient;

    /** `client` defaults to a GeminiClient, which prefers the Vertex `global` service account and else the API key. */
    constructor(client?: VisionModelClient) {
        this.client = client ?? new GeminiClient();
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
     * Has the vision model inspect a captured canvas frame. Returns its audit, or `{status: 'unavailable', error}`
     * when there is no frame, no credentials, the call fails, or the reply carries no fidelityScore. Nothing is
     * scored without the model, so an unavailable check can never pass, fail or trigger a repair.
     */
    public async verifyVisual(request: VisualVerificationRequest): Promise<VisualVerificationOutcome> {
        const model = request.model || DEFAULT_GEMINI_VISION_MODEL;
        let credential: 'vertex' | 'api-key' | undefined;
        const unavailable = (error: string): VisualAuditUnavailable => ({
            status: 'unavailable',
            error,
            modelUsed: model,
            ...(credential ? { credential } : {}),
            targetArtifactId: request.context?.artifactId,
            timestamp: new Date().toLocaleTimeString()
        });

        const { base64Data, dataUrl } = parseImagePayload(request.image);
        if (!base64Data) {
            return unavailable('No frame of the canvas was captured, so there was nothing to inspect.');
        }

        let genai: Pick<GoogleGenAI, 'models'> | undefined;
        try {
            genai = await this.client.getGenAIClient();
        } catch (err) {
            return unavailable(`The vision model's credentials could not be loaded: ${errorText(err)}`);
        }
        if (!genai) {
            return unavailable('No Google Cloud service account or Gemini API key is configured for the vision model.');
        }
        credential = this.client.genAIClientCredential?.();

        const { systemInstruction, userPrompt, inlineData } = this.buildMultimodalPrompt(request);
        let text: string;
        try {
            const response = await genai.models.generateContent({
                model,
                contents: [{ role: 'user', parts: [{ inlineData }, { text: userPrompt }] }],
                config: {
                    systemInstruction,
                    temperature: 0.2,
                    // Thinking models spend part of this budget before the JSON; 2048 cut audits off mid-object.
                    maxOutputTokens: 8192,
                    responseMimeType: 'application/json'
                }
            });
            text = response.text ?? '';
        } catch (err) {
            return unavailable(`${model} could not inspect the frame: ${errorText(err)}`);
        }

        const parsed = this.parseVisionResponseJson(text);
        if (!parsed) {
            return unavailable(`${model} did not return the audit JSON${text.trim() ? '' : ' (empty reply)'}.`);
        }
        if (typeof parsed.fidelityScore !== 'number' || !Number.isFinite(parsed.fidelityScore)) {
            return unavailable(`${model}'s audit has no fidelityScore, so the frame was not scored.`);
        }

        const fidelityScore = parsed.fidelityScore;
        const defects3D = Array.isArray(parsed.defects3D) ? parsed.defects3D : [];
        const operatorDispatches = parsed.operatorDispatches || parsed.visualFixes?.operatorDispatches || this.mapDefectsToOperators(defects3D);
        return {
            status: 'verified',
            pass: fidelityScore >= 80,
            fidelityScore,
            critique: typeof parsed.critique === 'string' ? parsed.critique : '',
            issues: Array.isArray(parsed.issues) ? parsed.issues : [],
            strengths: Array.isArray(parsed.strengths) ? parsed.strengths : [],
            visualFixes: parsed.visualFixes,
            defects3D,
            operatorDispatches,
            angle: request.context?.angle || 'perspective',
            thumbnail: dataUrl,
            timestamp: new Date().toLocaleTimeString(),
            iteration: request.context?.iteration || 1,
            modelUsed: model,
            ...(credential ? { credential } : {}),
            targetArtifactId: request.context?.artifactId
        };
    }

    /**
     * The operators the vision model suggested for its defects, de-duplicated. A defect without a suggested operator
     * gets none: no lighting preset, material or subdivision is invented for it.
     */
    public mapDefectsToOperators(defects: VisualAudit3DDefect[]): Array<{ operator: string; params?: any }> {
        const operators: Array<{ operator: string; params?: any }> = [];
        const seen = new Set<string>();
        for (const defect of defects) {
            if (!defect.suggestedOperator) continue;
            const key = `${defect.suggestedOperator}:${JSON.stringify(defect.suggestedParams || {})}`;
            if (seen.has(key)) continue;
            seen.add(key);
            operators.push({
                operator: defect.suggestedOperator,
                params: defect.suggestedParams ? JSON.parse(JSON.stringify(defect.suggestedParams)) : {}
            });
        }
        return operators;
    }

    /**
     * Executes a multi-angle visual audit across canonical viewport camera angles. Every angle needs a captured
     * frame and a vision audit; if any angle has neither, the whole audit is unavailable (no score is averaged
     * from the angles that did run).
     */
    public async audit3DSceneMultiAngle(options: MultiAngleAuditOptions): Promise<MultiAngleVisualAuditResult | VisualAuditUnavailable> {
        const angles = options.angles && options.angles.length > 0 ? options.angles : DEFAULT_VIEWPORT_ANGLES;
        const angleResults: Record<string, VisualAuditResult> = {};
        const combinedOperatorDispatches: Array<{ operator: string; params?: any }> = [];
        const detectedDefects: VisualAudit3DDefect[] = [];
        const seenOperators = new Set<string>();
        const unavailable = (error: string): VisualAuditUnavailable => ({
            status: 'unavailable',
            error,
            modelUsed: options.model || DEFAULT_GEMINI_VISION_MODEL,
            timestamp: new Date().toLocaleTimeString()
        });

        if (!options.captureAngleFrame) {
            return unavailable('No viewport capture was provided, so no angle could be rendered for the vision check.');
        }

        let scoreSum = 0;
        for (const angle of angles) {
            let frame: string;
            try {
                frame = options.captureAngleFrame(angle, options.sceneData);
            } catch (err) {
                return unavailable(`The ${angle} view could not be captured: ${errorText(err)}`);
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
            if (isVisualAuditUnavailable(audit)) {
                return { ...audit, error: `${angle} view: ${audit.error}` };
            }

            angleResults[angle] = audit;
            scoreSum += audit.fidelityScore;
            if (audit.defects3D) {
                detectedDefects.push(...audit.defects3D);
            }
            for (const op of audit.operatorDispatches || this.mapDefectsToOperators(audit.defects3D || [])) {
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
            : `Multi-angle visual inspection identified flaws across viewports (${angles.join(', ')}). Average score: ${averageFidelityScore}/100. ${combinedOperatorDispatches.length} operator fixes suggested by the vision model.`;

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
     * Runs an iterative multi-turn 3D self-correction loop using DirectDispatchOperatorEngine: audits the rendered
     * viewports and dispatches the operators the vision model suggested, until fidelity >= minPassingScore. It stops
     * when the vision check is unavailable or suggests nothing; it never dispatches operators of its own.
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

        let initialFidelityScore: number | undefined;
        let finalFidelityScore: number | undefined;
        let visionUnavailable: VisualAuditUnavailable | undefined;
        let iteration = 0;
        let converged = false;

        while (iteration < maxIterations) {
            iteration++;
            const multiAngleAudit = await this.audit3DSceneMultiAngle({
                sceneData: operatorEngine.getSceneData(),
                prompt: options.targetPrompt,
                angles,
                captureAngleFrame: options.captureAngleFrame,
                model: options.model
            });
            if (isVisualAuditUnavailable(multiAngleAudit)) {
                visionUnavailable = multiAngleAudit;
                break;
            }

            initialFidelityScore ??= multiAngleAudit.averageFidelityScore;
            finalFidelityScore = multiAngleAudit.averageFidelityScore;
            auditHistory.push({ iteration, multiAngleAudit });

            if (multiAngleAudit.overallPass || multiAngleAudit.averageFidelityScore >= minPassingScore) {
                converged = true;
                break;
            }

            const opsToDispatch = multiAngleAudit.combinedOperatorDispatches;
            if (opsToDispatch.length === 0 || !autoDispatch) {
                break;
            }
            for (const cmd of opsToDispatch) {
                // This loop is invoked explicitly to reframe and relight, so it may move the camera; never the environment.
                const res = this.dispatchAuditOperator(operatorEngine, cmd, true).result;
                executedOperators.push({ operator: cmd.operator, params: cmd.params, result: res });
            }
        }

        return {
            sceneData: operatorEngine.getSceneData(),
            operatorEngine,
            iterations: iteration,
            converged,
            initialFidelityScore,
            finalFidelityScore,
            visionUnavailable,
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
     * Executes the full automated visual self-correction loop until fidelity >= minPassingScore. It stops, repairing
     * nothing more, as soon as the vision check is unavailable.
     */
    public async runVisualSelfCorrectionLoop(options: VisualSelfCorrectionOptions): Promise<VisualSelfCorrectionLoopResult> {
        const maxIterations = options.maxIterations || 3;
        const minPassingScore = options.minPassingScore || 80;
        const history: VisualAuditResult[] = [];

        let currentArtifact = { ...options.artifact };
        let latestAudit: VisualVerificationOutcome | undefined;
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
            latestAudit = audit;
            if (isVisualAuditUnavailable(audit)) {
                break;
            }
            history.push(audit);

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
