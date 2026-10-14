/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import { VisualVerificationService } from '../src/node/visual-verification-service';
import {
    computeCameraForViewportAngle,
    parseImagePayload,
    VisualAuditResult,
    VisualVerificationRequest
} from '../src/common/visual-verification-protocol';
import { sceneOptsIntoAtmosphere, withoutUninvitedAtmosphere } from '../src/common/scene-atmosphere-opt-in';
import { backgroundAuditRepairData, shouldAuditArtifactInBackground } from '../src/browser/generative-canvas/hooks/useArtifactSync';
import { classifyAtmosphere } from '../src/browser/generative-canvas/primitives/scene3d/syncAtmosphere';
import { CanvasArtifact, Scene3DData } from '../src/browser/generative-canvas/canvas-types';

const FRAME = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR42mNk+M9Qz8DAwMTAwAAAEAEDAT4qV4QAAAAASUVORK5CYII=';

/** Runs the offline heuristic directly, so no test reaches a live Gemini endpoint. */
class HeuristicVerifier extends VisualVerificationService {
    inspect(request: VisualVerificationRequest): VisualAuditResult {
        const { base64Data, dataUrl } = parseImagePayload(request.image);
        return this.heuristicVisualInspection(request, base64Data, dataUrl);
    }
}

const verifier = new HeuristicVerifier();

function sceneArtifact(data: Scene3DData): CanvasArtifact {
    return { id: 'scene-under-audit', type: '3d-scene', title: data.title, summary: '', createdAt: 'now', version: 1, data };
}

function heuristicAudit(scene: Scene3DData, prompt: string): VisualAuditResult {
    return verifier.inspect({ image: FRAME, prompt, artifactType: '3d-scene', context: { sceneData: scene } });
}

/** What Scene3DPrimitive feeds the renderer's sky classifier for this scene. */
function rendersSkyDome(scene: Scene3DData): boolean {
    return classifyAtmosphere({
        skybox: scene.environment?.skybox,
        worldBranch: scene.worldBranch || '',
        renderMode: scene.renderMode || 'clay',
        hasGeoCoordinates: false,
        has3DTiles: false,
        atmosphericScattering: scene.features?.atmosphericScattering,
        atmosphere: (scene as { atmosphere?: unknown }).atmosphere,
        godRays: scene.features?.godRays,
        terrainBiomes: scene.features?.terrainBiomes
    }).hasAtmosphere;
}

/** A first-pass clay hero in a studio void, framed from far out for a large generated GLB. */
const clayStudioScene = (): Scene3DData => ({
    title: 'Hollow asteroid mycelium forest',
    renderMode: 'clay',
    environment: { skybox: 'studio', lighting: 'studio', ground: false },
    features: { curvatureAO: true },
    camera: { position: [90, 40, 90], target: [0, 12, 0], fov: 45 },
    cppGenerator: { enabled: true, sourceCode: '#include "scratchbox_engine.hpp"\n' } as Scene3DData['cppGenerator'],
    customMeshes: [{ id: 'mycelium-trunk', type: 'custom', position: [0, 0, 0], scale: [40, 60, 40] }]
});

const pbrStudioScene = (): Scene3DData => ({
    title: 'Subterranean hyperloop terminal',
    renderMode: 'pbr',
    environment: { skybox: 'studio', lighting: 'studio', ground: true },
    features: { pbrMaterials: true },
    camera: { position: [12, 8, 12], target: [0, 2, 0], fov: 45 }
});

const skyScene = (): Scene3DData => ({
    title: 'Methane geyser field at dusk',
    renderMode: 'pbr',
    environment: { skybox: 'sky', lighting: 'shaded', ground: true },
    features: { atmosphericScattering: { enabled: true, turbidity: 2 } },
    camera: { position: [120, 30, 120], target: [0, 0, 0], fov: 50 }
});

describe('background visual auto-repair keeps a clay studio scene in its studio', () => {
    it('the heuristic fails the far camera but proposes no sky, atmosphere or render mode', () => {
        const audit = heuristicAudit(clayStudioScene(), 'a bioluminescent mycelium forest inside a hollow asteroid');
        expect(audit.fidelityScore).toBeLessThan(80);
        expect(audit.visualFixes?.features).toBeUndefined();
        expect(audit.visualFixes?.scenePatches).toBeUndefined();
        expect(audit.visualFixes?.environment?.skybox).toBe('studio');
        expect(audit.issues.join(' ')).not.toMatch(/sky|atmospher/i);
    });

    it('the in-app loop writes only a camera change from that audit', () => {
        const scene = clayStudioScene();
        const audit = heuristicAudit(scene, 'a bioluminescent mycelium forest inside a hollow asteroid');
        const data = backgroundAuditRepairData(sceneArtifact(scene), audit.visualFixes!) as Scene3DData;
        expect(data).not.toBeNull();
        expect(data.camera).not.toEqual(scene.camera);
        expect({ ...data, camera: scene.camera }).toEqual(scene);
        expect(rendersSkyDome(data)).toBe(false);
    });

    it('the in-app loop writes no new version when the audit leaves nothing it may change', () => {
        const scene: Scene3DData = { ...clayStudioScene(), environment: { skybox: 'studio', ground: false } };
        scene.camera = computeCameraForViewportAngle('perspective', scene);
        const audit = heuristicAudit(scene, 'a bioluminescent mycelium forest inside a hollow asteroid');
        expect(audit.fidelityScore).toBeLessThan(80);
        expect(backgroundAuditRepairData(sceneArtifact(scene), audit.visualFixes!)).toBeNull();
    });

    it('the server repair keeps the studio, the clay and the empty sky', () => {
        const scene = clayStudioScene();
        const audit = heuristicAudit(scene, 'a bioluminescent mycelium forest inside a hollow asteroid');
        const repaired = verifier.applyVisualAutoRepair(sceneArtifact(scene), audit).data as Scene3DData;
        expect(repaired.renderMode).toBe('clay');
        expect(repaired.environment?.skybox).toBe('studio');
        expect(repaired.features?.atmosphericScattering).toBeUndefined();
        expect(rendersSkyDome(repaired)).toBe(false);
    });
});

describe('a live-Gemini-shaped atmosphere fix on a scene that never asked for a sky', () => {
    const geminiAudit: VisualAuditResult = {
        pass: false,
        fidelityScore: 55,
        critique: 'Flat grey background; missing sky dome.',
        issues: ['missing sky dome'],
        strengths: [],
        visualFixes: {
            environment: { skybox: 'sky', lighting: 'shaded' },
            features: { atmosphericScattering: true, godRays: true, volumetricClouds: true },
            scenePatches: { atmosphere: { enabled: true }, worldBranch: 'earth/outdoor', renderMode: 'pbr' } as Partial<Scene3DData>
        }
    };

    it('adds no atmosphere through the server repair', () => {
        const repaired = verifier.applyVisualAutoRepair(sceneArtifact(pbrStudioScene()), geminiAudit).data as Scene3DData;
        expect((repaired as { atmosphere?: unknown }).atmosphere).toBeUndefined();
        expect(repaired.features).toEqual({ pbrMaterials: true });
        expect(repaired.environment?.skybox).toBe('studio');
        expect(repaired.worldBranch).toBeUndefined();
        expect(rendersSkyDome(repaired)).toBe(false);
    });

    it('a bare scenePatches.atmosphere fix leaves the server repair with nothing to write', () => {
        const artifact = sceneArtifact(pbrStudioScene());
        const repaired = verifier.applyVisualAutoRepair(artifact, { ...geminiAudit, visualFixes: { scenePatches: { atmosphere: { enabled: true } } as unknown as Partial<Scene3DData> } });
        expect(repaired).toBe(artifact);
    });

    it('writes no new version through the in-app loop', () => {
        expect(backgroundAuditRepairData(sceneArtifact(pbrStudioScene()), geminiAudit.visualFixes!)).toBeNull();
    });
});

describe('operator dispatches that write atmosphere', () => {
    const audit: VisualAuditResult = {
        pass: false,
        fidelityScore: 50,
        critique: 'Scene needs a sky and better framing.',
        issues: [],
        strengths: [],
        operatorDispatches: [
            { operator: 'sb_configure_atmospheric_scattering', params: { enabled: true, turbidity: 3 } },
            { operator: 'sb_set_diurnal_time_of_day', params: { preset: 'sunset' } },
            { operator: 'sb_add_volumetric_god_rays', params: { intensity: 0.4 } },
            { operator: 'sb_set_camera', params: { position: [20, 10, 20], target: [0, 2, 0] } }
        ]
    };

    it('are dropped for a scene that did not opt in, while the camera operator still applies', () => {
        const repaired = verifier.applyVisualAutoRepair(sceneArtifact(pbrStudioScene()), audit).data as Scene3DData;
        expect(repaired.features?.atmosphericScattering).toBeUndefined();
        expect(repaired.features?.godRays).toBeUndefined();
        expect(repaired.environment?.timeOfDay).toBeUndefined();
        expect(repaired.camera?.position).toEqual([20, 10, 20]);
        expect((repaired.operatorStack || []).map(op => op.operator)).toEqual(['sb_set_camera']);
        expect(rendersSkyDome(repaired)).toBe(false);
    });

    it('still apply to a scene that already has a sky', () => {
        const repaired = verifier.applyVisualAutoRepair(sceneArtifact(skyScene()), audit).data as Scene3DData;
        const atmosphere = repaired.features?.atmosphericScattering as { turbidity?: number; sunElevation?: number };
        expect(atmosphere.turbidity).toBe(3);
        expect(typeof atmosphere.sunElevation).toBe('number');
        expect(rendersSkyDome(repaired)).toBe(true);
    });
});

describe('a scene that opted into a sky keeps it', () => {
    it('through the heuristic audit and both repair paths', () => {
        const scene = skyScene();
        const audit = heuristicAudit(scene, 'a methane geyser field');
        expect(audit.fidelityScore).toBeLessThan(80);
        expect(audit.visualFixes?.environment?.skybox).toBe('sky');

        const server = verifier.applyVisualAutoRepair(sceneArtifact(scene), audit).data as Scene3DData;
        expect(server.environment?.skybox).toBe('sky');
        expect(server.features?.atmosphericScattering).toEqual({ enabled: true, turbidity: 2 });
        expect(rendersSkyDome(server)).toBe(true);

        const client = backgroundAuditRepairData(sceneArtifact(scene), audit.visualFixes!) as Scene3DData;
        expect({ ...client, camera: scene.camera }).toEqual(scene);
        expect(rendersSkyDome(client)).toBe(true);
    });

    it('lets a fix tune that sky, and a patched environment block cannot drop it', () => {
        const repaired = verifier.applyVisualAutoRepair(sceneArtifact(skyScene()), {
            pass: false,
            fidelityScore: 60,
            critique: 'Sky too hazy.',
            issues: [],
            strengths: [],
            visualFixes: {
                features: { atmosphericScattering: { enabled: true, turbidity: 4 } },
                scenePatches: { environment: { lighting: 'shaded' } }
            }
        }).data as Scene3DData;
        expect(repaired.features?.atmosphericScattering).toEqual({ enabled: true, turbidity: 4 });
        expect(repaired.environment?.skybox).toBe('sky');
    });

    it('counts a sky skybox or an atmosphere block as the opt-in, and never god rays alone', () => {
        expect(sceneOptsIntoAtmosphere({ environment: { skybox: 'sky' } })).toBe(true);
        expect(sceneOptsIntoAtmosphere({ atmosphere: { enabled: true } } as Partial<Scene3DData>)).toBe(true);
        expect(sceneOptsIntoAtmosphere({ features: { atmosphericScattering: { enabled: false } } })).toBe(false);
        expect(sceneOptsIntoAtmosphere({ features: { godRays: true }, environment: { skybox: 'studio' } })).toBe(false);
    });

    it('keeps clay even when the clay scene opted into a sky', () => {
        const clayWithSky: Scene3DData = { ...skyScene(), renderMode: 'clay' };
        const fixes = withoutUninvitedAtmosphere({
            features: { atmosphericScattering: { enabled: true, turbidity: 5 } },
            scenePatches: { renderMode: 'pbr' }
        }, clayWithSky);
        expect(fixes.scenePatches).toBeUndefined();
        expect(fixes.features).toEqual({ atmosphericScattering: { enabled: true, turbidity: 5 } });
    });
});

describe('the vision prompt follows the scene\'s own environment', () => {
    it('tells the model a studio or clay void is intended unless the scene opts into a sky', () => {
        const clay = verifier.buildMultimodalPrompt({ image: FRAME, prompt: 'clay hero', context: { sceneData: clayStudioScene() } });
        expect(clay.systemInstruction).toContain('does not opt into an atmospheric sky');
        expect(clay.systemInstruction).not.toContain('"atmosphericScattering": boolean');
        expect(clay.systemInstruction).not.toContain('missing sky dome / atmospheric scattering');

        const sky = verifier.buildMultimodalPrompt({ image: FRAME, prompt: 'geysers', context: { sceneData: skyScene() } });
        expect(sky.systemInstruction).toContain('opts into an atmospheric sky through its own environment or features');
    });
});

describe('background verification while a reply is generating', () => {
    it('waits until the reply is done', () => {
        const artifact = sceneArtifact(clayStudioScene());
        expect(shouldAuditArtifactInBackground(artifact, true)).toBe(false);
        expect(shouldAuditArtifactInBackground(artifact, false)).toBe(true);
        expect(shouldAuditArtifactInBackground(null, false)).toBe(false);
    });
});
