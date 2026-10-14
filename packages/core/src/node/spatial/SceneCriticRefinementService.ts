/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * Scene Critic Refinement Service.
 * Implements the VLM critic refinement loop from "Building Rome from a Single Image":
 * 1. Render 5 camera views of the assembled scene
 * 2. Gemini multimodal compares renders against the original prompt, outputs JSON corrections
 * 3. Apply corrections as dot-path patches to the Adaptive3DSceneContract
 * 4. Recompile (one pass is sufficient per paper's ablation)
 *
 * The viewport capture step is orchestrated by the calling agent (browser_snapshot +
 * camera repositioning) — this service handles correction application and recompilation.
 ********************************************************************************/

import type { Adaptive3DSceneContract } from '../../common/spatial/adaptive-3d-scene-contract';
import type { Adaptive3DSceneSynthesizer, Adaptive3DSceneExecutionResult } from './Adaptive3DSceneSynthesizer';

export interface CriticCorrection {
    /** Dot-path into Adaptive3DSceneContract, e.g. "terrain.peakHeight" or "architecture.structures[0].dimensions.floorCount" */
    path: string;
    value: unknown;
}

export interface CriticRefinementResult {
    correctedContract: Adaptive3DSceneContract;
    correctionsApplied: number;
    skippedPaths: string[];
    result: Adaptive3DSceneExecutionResult;
}

/**
 * Camera poses for the 5-view critic capture.
 * distanceMultiplier is relative to the scene's diagonal extent.
 */
export const CRITIC_CAMERA_POSES = [
    { name: 'front',    azimuthDeg:   0, elevationDeg: 25, distanceMultiplier: 2.2 },
    { name: 'left',     azimuthDeg:  90, elevationDeg: 25, distanceMultiplier: 2.2 },
    { name: 'right',    azimuthDeg: -90, elevationDeg: 25, distanceMultiplier: 2.2 },
    { name: 'rear',     azimuthDeg: 180, elevationDeg: 25, distanceMultiplier: 2.2 },
    { name: 'overhead', azimuthDeg:   0, elevationDeg: 85, distanceMultiplier: 1.8 },
] as const;

export const CRITIC_PROMPT_TEMPLATE = `You are a 3D scene quality director reviewing a procedurally generated scene.

Original request: "{{PROMPT}}"

You are viewing 5 renders of the scene: front, left, right, rear, and overhead views.

Evaluate against the original request:
1. Does the scene geometry match the prompt? What is missing or proportionally wrong?
2. Are building heights and terrain relief plausible for the described subject?
3. Is the composition balanced — is the primary subject visible and well-framed?

Output ONLY a JSON array of targeted corrections (empty array [] if no corrections are needed).
Use dot-path notation matching the Adaptive3DSceneContract schema.
Limit to the 5 most impactful corrections.

Example format:
[
  { "path": "terrain.peakHeight", "value": 45 },
  { "path": "architecture.structures[0].dimensions.floorCount", "value": 5 },
  { "path": "botany.forestPatches[0].density", "value": 32 }
]`;

export class SceneCriticRefinementService {
    constructor(private readonly synthesizer: Adaptive3DSceneSynthesizer) {}

    /**
     * Applies dot-path corrections to a contract clone and recompiles.
     * The caller is responsible for capturing screenshots and invoking a VLM
     * to produce the corrections array; this method handles the patch + recompile.
     */
    async refine(
        contract: Adaptive3DSceneContract,
        corrections: CriticCorrection[],
        options: { outputDir?: string; outputGlbPath?: string } = {}
    ): Promise<CriticRefinementResult> {
        const { corrected, applied, skipped } = this.applyCorrections(contract, corrections);
        const result = await this.synthesizer.synthesizeAndCompile(corrected, options);
        return {
            correctedContract: corrected,
            correctionsApplied: applied,
            skippedPaths: skipped,
            result
        };
    }

    /**
     * Applies corrections to a deep clone of the contract without recompiling.
     * Useful for previewing what the patch looks like before committing to a compile.
     */
    applyCorrections(
        contract: Adaptive3DSceneContract,
        corrections: CriticCorrection[]
    ): { corrected: Adaptive3DSceneContract; applied: number; skipped: string[] } {
        const corrected = JSON.parse(JSON.stringify(contract)) as Adaptive3DSceneContract;
        let applied = 0;
        const skipped: string[] = [];

        for (const correction of corrections) {
            try {
                this.setByPath(corrected, correction.path, correction.value);
                applied++;
            } catch {
                skipped.push(correction.path);
            }
        }

        return { corrected, applied, skipped };
    }

    /** Renders the critic system prompt with the original user prompt interpolated. */
    static buildCriticPrompt(originalPrompt: string): string {
        return CRITIC_PROMPT_TEMPLATE.replace('{{PROMPT}}', originalPrompt);
    }

    // -------------------------------------------------------------------------
    // Private
    // -------------------------------------------------------------------------

    /**
     * Sets a value at a dot-path (with bracket notation for arrays).
     * e.g. "architecture.structures[0].dimensions.floorCount" → 5
     * Throws if any intermediate key is undefined/null.
     */
    private setByPath(obj: unknown, path: string, value: unknown): void {
        // normalise "a[0].b" → "a.0.b"
        const parts = path.replace(/\[(\d+)\]/g, '.$1').split('.');
        let curr: Record<string, unknown> = obj as Record<string, unknown>;

        for (let i = 0; i < parts.length - 1; i++) {
            const key = parts[i];
            if (curr[key] === undefined || curr[key] === null) {
                throw new Error(`Invalid path at "${parts.slice(0, i + 1).join('.')}" in "${path}"`);
            }
            curr = curr[key] as Record<string, unknown>;
        }

        const lastKey = parts[parts.length - 1];
        if (curr[lastKey] === undefined) {
            throw new Error(`Unknown final key "${lastKey}" in path "${path}"`);
        }
        curr[lastKey] = value;
    }
}
