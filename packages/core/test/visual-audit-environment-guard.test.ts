/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { VisualVerificationService } from '../src/node/visual-verification-service';
import {
    computeCameraForViewportAngle,
    VisualAuditResult
} from '../src/common/visual-verification-protocol';
import { sceneOptsIntoAtmosphere, sceneShowsSky, withoutEnvironmentChanges } from '../src/common/scene-atmosphere-opt-in';
import { backgroundAuditRepair, backgroundAuditRepairData, shouldAuditArtifactInBackground } from '../src/browser/generative-canvas/hooks/useArtifactSync';
import { classifyAtmosphere, CLAY_GREY_HEX } from '../src/browser/generative-canvas/primitives/scene3d/syncAtmosphere';
import { syncCustomMeshes, type CustomMeshRegistry } from '../src/browser/generative-canvas/primitives/scene3d/syncCustomMeshes';
import { applyClayRenderMode, CLAY_SURFACE } from '../src/browser/generative-canvas/primitives/scene3d/clayRenderMode';
import type { RendererStack } from '../src/browser/generative-canvas/primitives/scene3d/types';
import { CanvasArtifact, Scene3DData } from '../src/browser/generative-canvas/canvas-types';
import { saveViewportSnapshot } from './helpers/scene3d-viewport-snapshot';

const FRAME = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR42mNk+M9Qz8DAwMTAwAAAEAEDAT4qV4QAAAAASUVORK5CYII=';

/** The repair guards are tested on audits shaped like the vision model's; no test reaches a live endpoint. */
const verifier = new VisualVerificationService({ getGenAIClient: async () => undefined });

function sceneArtifact(data: Scene3DData, version = 1): CanvasArtifact {
    return { id: 'scene-under-audit', type: '3d-scene', title: data.title, summary: '', createdAt: 'now', version, data };
}

/** A vision audit that fails the framing of `scene` and proposes the framed camera for it. */
function farCameraAudit(scene: Scene3DData): VisualAuditResult {
    return {
        pass: false,
        fidelityScore: 62,
        critique: 'The subject is small and off centre.',
        issues: ['camera too far from the subject'],
        strengths: [],
        defects3D: [{ defectType: 'off_center_camera', severity: 'warning', description: 'Subject occupies a small part of the frame' }],
        visualFixes: { camera: computeCameraForViewportAngle('perspective', scene) }
    };
}

/** A vision audit that finds the scene unlit and suggests the three-point lighting operator. */
const unlitAudit = (): VisualAuditResult => ({
    pass: false,
    fidelityScore: 48,
    critique: 'The model is unlit.',
    issues: ['no key light'],
    strengths: [],
    defects3D: [{ defectType: 'unlit', severity: 'critical', description: 'No key light', suggestedOperator: 'sb_setup_lighting', suggestedParams: { preset: 'three-point', ambientIntensity: 0.5 } }],
    operatorDispatches: [{ operator: 'sb_setup_lighting', params: { preset: 'three-point', ambientIntensity: 0.5 } }]
});

const passingAudit = (): VisualAuditResult => ({ pass: true, fidelityScore: 91, critique: 'Clean clay massing.', issues: [], strengths: ['clear silhouette'] });

function serverRepair(scene: Scene3DData, audit: VisualAuditResult): Scene3DData {
    return verifier.applyVisualAutoRepair(sceneArtifact(scene), audit).data as Scene3DData;
}

function atmosphereOf(scene: Scene3DData) {
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
    });
}

/** What Scene3DPrimitive feeds the renderer's sky classifier for this scene. */
function rendersSkyDome(scene: Scene3DData): boolean {
    return atmosphereOf(scene).hasAtmosphere;
}

/** The part of a scene a background audit must never touch. */
function chosenEnvironment(scene: Scene3DData) {
    const loose = scene as { atmosphere?: unknown; worldBranch?: unknown };
    return {
        skybox: scene.environment?.skybox,
        ground: scene.environment?.ground,
        renderMode: scene.renderMode,
        worldBranch: loose.worldBranch,
        atmosphere: loose.atmosphere,
        atmosphericScattering: scene.features?.atmosphericScattering,
        volumetricClouds: (scene.features as Record<string, unknown> | undefined)?.volumetricClouds,
        godRays: scene.features?.godRays
    };
}

/** A first-pass clay hero in a studio void, all of it in customMeshes, framed from too far out. */
const clayStudioScene = (): Scene3DData => ({
    title: 'Hollow asteroid mycelium forest',
    renderMode: 'clay',
    environment: { skybox: 'studio', lighting: 'studio', ground: false },
    features: { curvatureAO: true },
    camera: { position: [90, 40, 90], target: [0, 12, 0], fov: 45 },
    customMeshes: [
        { id: 'mycelium-trunk', type: 'cylinder', position: [0, 12, 0], scale: [3, 6, 3] },
        { id: 'spore-cap', type: 'sphere', position: [0, 26, 0], scale: [7, 2.5, 7] },
        { id: 'geyser-ring', type: 'torus', position: [0, 1, 0], rotation: [Math.PI / 2, 0, 0], scale: [5, 5, 3] }
    ]
});

/** The clay hero framed where a framing fix would put the camera. */
const framedClayScene = (): Scene3DData => {
    const scene = clayStudioScene();
    scene.camera = computeCameraForViewportAngle('perspective', scene);
    return scene;
};

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

/** Scenes whose geometry is not (only) in customMeshes, each framed from far out on purpose. */
const unmeasuredScenes = (): Array<[string, Scene3DData]> => [
    ['GLB object', {
        title: 'Ferroconcrete caisson hall',
        renderMode: 'clay',
        environment: { skybox: 'studio', lighting: 'studio', ground: false },
        camera: { position: [140, 60, 140], target: [0, 20, 0], fov: 45 },
        objects: [{
            id: 'caisson-hall',
            content: { type: '3d-model', durableUri: '/models/caisson_hall.glb', mimeType: 'model/gltf-binary' },
            space: { spatial3d: { x: 0, y: 0, z: 0 } }
        }]
    }],
    ['cppGenerator', {
        ...clayStudioScene(),
        cppGenerator: { enabled: true, sourceCode: '#include "scratchbox_engine.hpp"\n', glbPath: 'build/mycelium.glb' }
    }],
    ['location (geoAnchor)', {
        title: 'Hero rover on the real street',
        renderMode: 'clay',
        environment: { skybox: 'studio', lighting: 'studio', ground: false },
        camera: { position: [380, 160, 380], target: [0, 0, 0], fov: 45 },
        geoAnchor: { lat: 40.7681, lng: -73.9819, active: true },
        customMeshes: [{ id: 'rover-chassis', type: 'box', position: [0, 1, 0], scale: [4, 2, 6] }]
    }]
];

/** A live Gemini audit that reports a framing defect and proposes a small camera near the origin. */
const framingAudit = (camera = { position: [13.5, 10.5, 13.5] as [number, number, number], target: [0, 0, 0] as [number, number, number] }): VisualAuditResult => ({
    pass: false,
    fidelityScore: 60,
    critique: 'Subject too small in frame.',
    issues: ['camera too far'],
    strengths: [],
    defects3D: [{ defectType: 'framing_offset', severity: 'warning', description: 'Subject occupies a small part of the frame' }],
    visualFixes: { camera }
});

describe('a clay studio scene after a failing audit', () => {
    it('the in-app loop writes only a camera change', () => {
        const scene = clayStudioScene();
        const data = backgroundAuditRepairData(sceneArtifact(scene), farCameraAudit(scene)) as Scene3DData;
        expect(data).not.toBeNull();
        expect(data.camera).not.toEqual(scene.camera);
        expect({ ...data, camera: scene.camera }).toEqual(scene);
        expect(rendersSkyDome(data)).toBe(false);
    });

    it('the server repair keeps the studio, the clay, the void and the empty sky', () => {
        const scene = clayStudioScene();
        const repaired = serverRepair(scene, farCameraAudit(scene));
        expect(chosenEnvironment(repaired)).toEqual(chosenEnvironment(scene));
        expect(repaired.camera).not.toEqual(scene.camera);
        expect(rendersSkyDome(repaired)).toBe(false);
    });

    it('is saved as a rendered frame that stays clay grey in a clay grey studio', () => {
        const scene = clayStudioScene();
        const failing = farCameraAudit(scene);
        expect(failing.fidelityScore).toBeLessThan(80);
        const everything: VisualAuditResult = {
            ...failing,
            visualFixes: {
                ...failing.visualFixes,
                environment: { skybox: 'sky', ground: true, lighting: 'shaded' },
                features: { atmosphericScattering: true, godRays: true },
                scenePatches: { renderMode: 'pbr', worldBranch: 'earth/outdoor' }
            },
            operatorDispatches: [
                { operator: 'sb_configure_atmospheric_scattering', params: { enabled: true } },
                { operator: 'sb_setup_lighting', params: { preset: 'sunset' } },
                { operator: 'sb_frame_bounds', params: { paddingFactor: 1.5 } }
            ]
        };
        const repaired = serverRepair(scene, everything);
        expect(repaired.renderMode).toBe('clay');
        const atmosphere = atmosphereOf(repaired);
        expect(atmosphere.hasAtmosphere).toBe(false);
        expect(atmosphere.backgroundHex).toBe(CLAY_GREY_HEX);

        // The renderer's own mesh sync and clay pass, drawn through the repaired camera.
        const three = new THREE.Scene();
        const registry: CustomMeshRegistry = new Map();
        syncCustomMeshes({ scene: three } as RendererStack, repaired.customMeshes, registry, { terrainManager: null, has3DTiles: false });
        expect(applyClayRenderMode([three], repaired.renderMode === 'clay')).toBe(3);
        const camera = new THREE.PerspectiveCamera(repaired.camera!.fov ?? 45, 4 / 3, 0.1, 2000);
        camera.position.set(...repaired.camera!.position);
        camera.lookAt(new THREE.Vector3(...repaired.camera!.target));
        const shot = saveViewportSnapshot('visual_audit_environment_guard_clay_studio_after_failing_audit', three, camera, {
            background: atmosphere.backgroundHex,
            materialColors: true
        });

        expect(shot.drawnPixels).toBeGreaterThan(2000);
        const clay = [(CLAY_SURFACE.color >> 16) & 0xff, (CLAY_SURFACE.color >> 8) & 0xff, CLAY_SURFACE.color & 0xff];
        const grey = [(CLAY_GREY_HEX >> 16) & 0xff, (CLAY_GREY_HEX >> 8) & 0xff, CLAY_GREY_HEX & 0xff];
        expect([...shot.rgba.subarray(0, 3)]).toEqual(grey);
        // Every pixel is the clay grey studio or a shade of the clay surface (no sky blue, no PBR colour).
        for (let i = 0; i < shot.rgba.length; i += 4) {
            const px = [shot.rgba[i], shot.rgba[i + 1], shot.rgba[i + 2]];
            if (px.every((c, k) => c === grey[k])) continue;
            const shade = px[2] / clay[2];
            px.forEach((c, k) => expect(Math.abs(c - clay[k] * shade)).toBeLessThanOrEqual(2));
        }
    });
});

describe('item 1: a clay scene that keeps atmosphere settings never draws a sky', () => {
    const clayKeepingSky = (): Scene3DData => ({
        ...framedClayScene(),
        environment: { lighting: 'studio', ground: false },
        features: { curvatureAO: true, atmosphericScattering: { enabled: true, turbidity: 2 } }
    });

    it('opts into a sky but does not show one', () => {
        expect(sceneOptsIntoAtmosphere(clayKeepingSky())).toBe(true);
        expect(sceneShowsSky(clayKeepingSky())).toBe(false);
        expect(rendersSkyDome(clayKeepingSky())).toBe(false);
    });

    it('a passing audit repairs nothing', () => {
        const scene = clayKeepingSky();
        const audit = passingAudit();
        expect(backgroundAuditRepair(sceneArtifact(scene), audit, new Set())).toBeNull();
        const artifact = sceneArtifact(scene);
        expect(verifier.applyVisualAutoRepair(artifact, audit)).toBe(artifact);
    });

    it('the vision prompt tells the model the clay backdrop is intended', () => {
        const prompt = verifier.buildMultimodalPrompt({ image: FRAME, prompt: 'a hollow asteroid at sunset', context: { sceneData: clayKeepingSky() } });
        expect(prompt.systemInstruction).toContain('never report a missing sky');
        expect(prompt.systemInstruction).not.toContain('report a missing or broken sky as a defect');
    });

    it('a live sky critique with sky fixes changes nothing', () => {
        const artifact = sceneArtifact(clayKeepingSky());
        const repaired = verifier.applyVisualAutoRepair(artifact, {
            pass: false,
            fidelityScore: 55,
            critique: 'Flat grey background; missing sky dome.',
            issues: ['missing sky dome'],
            strengths: [],
            defects3D: [{ defectType: 'missing_skybox', severity: 'critical', description: 'No sky' }],
            visualFixes: {
                environment: { skybox: 'sky' },
                features: { atmosphericScattering: { enabled: true, turbidity: 6 } },
                scenePatches: { renderMode: 'pbr' }
            }
        });
        expect(repaired).toBe(artifact);
    });
});

describe('item 2: a scene that opted into a sky keeps it, in both directions', () => {
    const turnsSkyOff: VisualAuditResult = {
        pass: false,
        fidelityScore: 50,
        critique: 'Sky is distracting; use a studio.',
        issues: [],
        strengths: [],
        visualFixes: {
            environment: { skybox: 'studio', ground: false },
            features: { atmosphericScattering: false, volumetricClouds: true },
            scenePatches: { renderMode: 'clay', worldBranch: 'earth/indoor', atmosphere: { enabled: false } } as Partial<Scene3DData>
        },
        operatorDispatches: [
            { operator: 'sb_configure_atmospheric_scattering', params: { enabled: false } },
            { operator: 'sb_setup_lighting', params: { preset: 'studio', skybox: 'studio' } }
        ]
    };

    it('through the server repair: no sky switched off, no skybox swapped, no move to clay', () => {
        const scene = skyScene();
        const repaired = serverRepair(scene, turnsSkyOff);
        expect(chosenEnvironment(repaired)).toEqual(chosenEnvironment(scene));
        expect(rendersSkyDome(repaired)).toBe(true);
        // The lighting operator still relights the scene.
        expect(repaired.environment?.lightingPreset).toBe('studio');
    });

    it('against sb_configure_atmospheric_scattering { enabled: false } alone', () => {
        const artifact = sceneArtifact(skyScene());
        const repaired = verifier.applyVisualAutoRepair(artifact, {
            pass: false, fidelityScore: 50, critique: '', issues: [], strengths: [],
            operatorDispatches: [{ operator: 'sb_configure_atmospheric_scattering', params: { enabled: false } }]
        });
        expect(repaired).toBe(artifact);
        expect(rendersSkyDome(repaired.data as Scene3DData)).toBe(true);
    });

    it('against operators that retune the sky it has', () => {
        const scene = skyScene();
        const repaired = serverRepair(scene, {
            pass: false, fidelityScore: 50, critique: '', issues: [], strengths: [],
            operatorDispatches: [
                { operator: 'sb_configure_atmospheric_scattering', params: { turbidity: 9 } },
                { operator: 'sb_set_diurnal_time_of_day', params: { preset: 'night' } },
                { operator: 'sb_add_volumetric_god_rays', params: { intensity: 0.4 } }
            ]
        });
        expect(chosenEnvironment(repaired)).toEqual(chosenEnvironment(scene));
        expect(repaired.environment?.timeOfDay).toBeUndefined();
    });

    it('through the in-app loop, which writes nothing', () => {
        expect(backgroundAuditRepairData(sceneArtifact(skyScene()), turnsSkyOff)).toBeNull();
    });

    it('withoutEnvironmentChanges strips the same carriers for opted-in and studio scenes', () => {
        expect(withoutEnvironmentChanges(turnsSkyOff.visualFixes!)).toEqual({});
        expect(withoutEnvironmentChanges({
            environment: { skybox: 'sky', lighting: 'shaded' },
            features: { atmosphericScattering: { enabled: true, turbidity: 4 }, pbrMaterials: true },
            scenePatches: { environment: { skybox: 'sky', lighting: 'studio' }, renderMode: 'pbr' }
        })).toEqual({
            environment: { lighting: 'shaded' },
            features: { pbrMaterials: true },
            scenePatches: { environment: { lighting: 'studio' } }
        });
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
        const scene = pbrStudioScene();
        const repaired = serverRepair(scene, geminiAudit);
        expect(chosenEnvironment(repaired)).toEqual(chosenEnvironment(scene));
        expect(repaired.features).toEqual({ pbrMaterials: true });
        expect(rendersSkyDome(repaired)).toBe(false);
    });

    it('a bare scenePatches.atmosphere fix leaves the server repair with nothing to write', () => {
        const artifact = sceneArtifact(pbrStudioScene());
        const repaired = verifier.applyVisualAutoRepair(artifact, { ...geminiAudit, visualFixes: { scenePatches: { atmosphere: { enabled: true } } as unknown as Partial<Scene3DData> } });
        expect(repaired).toBe(artifact);
    });

    it('writes no new version through the in-app loop', () => {
        expect(backgroundAuditRepairData(sceneArtifact(pbrStudioScene()), geminiAudit)).toBeNull();
    });
});

describe('item 3: an audit moves the camera only for a framing defect, on bounds it can measure, once per version', () => {
    it('a lighting failure writes no camera, though the old fix carried the computed default', () => {
        const scene: Scene3DData = { ...clayStudioScene(), environment: { skybox: 'studio', ground: false }, camera: { position: [20, 15, 20], target: [0, 10, 0], fov: 45 } };
        const audit = unlitAudit();
        expect(audit.visualFixes?.camera).toBeUndefined();
        expect(backgroundAuditRepairData(sceneArtifact(scene), audit)).toBeNull();
        expect(serverRepair(scene, audit).camera).toEqual(scene.camera);
    });

    it('a live camera fix without a framing defect writes nothing; with one it frames the scene', () => {
        const scene = clayStudioScene();
        const unflagged: VisualAuditResult = { ...framingAudit(), defects3D: [{ defectType: 'unlit', severity: 'warning', description: 'dim' }] };
        expect(backgroundAuditRepairData(sceneArtifact(scene), unflagged)).toBeNull();
        expect(serverRepair(scene, unflagged).camera).toEqual(scene.camera);

        const flagged = backgroundAuditRepairData(sceneArtifact(scene), framingAudit()) as Scene3DData;
        expect(flagged.camera).toEqual({ position: [13.5, 10.5, 13.5], target: [0, 0, 0], fov: 45 });

        const server = serverRepair(scene, {
            ...framingAudit(),
            visualFixes: undefined,
            operatorDispatches: [{ operator: 'sb_set_camera', params: { position: [20, 10, 20], target: [0, 12, 0] } }]
        });
        expect(server.camera?.position).toEqual([20, 10, 20]);
        expect((server.operatorStack || []).map(op => op.operator)).toEqual(['sb_set_camera']);
    });

    for (const [label, scene] of unmeasuredScenes()) {
        it(`never resets the camera of a ${label} scene to the customMeshes default`, () => {
            // Even a live audit that flags framing and proposes a 10 m camera leaves it alone.
            expect(backgroundAuditRepairData(sceneArtifact(scene), framingAudit())).toBeNull();
            const repaired = serverRepair(scene, {
                ...framingAudit(),
                operatorDispatches: [{ operator: 'sb_frame_bounds', params: { paddingFactor: 1.5 } }]
            });
            expect(repaired.camera).toEqual(scene.camera);
            expect(repaired.operatorStack || []).toEqual([]);
        });
    }

    it('repairs a version at most once, and never repairs the version a repair wrote', () => {
        const repairWritten = new Set<string>();
        const v1 = sceneArtifact(clayStudioScene());
        const audit = farCameraAudit(clayStudioScene());

        const v2 = backgroundAuditRepair(v1, audit, repairWritten);
        expect(v2?.version).toBe(2);
        expect(backgroundAuditRepair(v1, audit, repairWritten)).toBeNull();

        // A live audit of the repaired version proposing yet another framing writes no v3.
        expect(backgroundAuditRepair(v2!, framingAudit({ position: [30, 30, 30], target: [0, 10, 0] }), repairWritten)).toBeNull();

        // A version someone else writes later gets its own single repair.
        const v3 = sceneArtifact({ ...(v2!.data as Scene3DData), camera: { position: [200, 80, 200], target: [0, 0, 0], fov: 45 } }, 3);
        const v4 = backgroundAuditRepair(v3, farCameraAudit(v3.data as Scene3DData), repairWritten);
        expect(v4?.version).toBe(4);
        expect(backgroundAuditRepair(v3, farCameraAudit(v3.data as Scene3DData), repairWritten)).toBeNull();
    });

    it('a passing audit or one without fixes writes nothing', () => {
        const artifact = sceneArtifact(clayStudioScene());
        expect(backgroundAuditRepair(artifact, { ...framingAudit(), fidelityScore: 85 }, new Set())).toBeNull();
        expect(backgroundAuditRepair(artifact, { ...framingAudit(), visualFixes: undefined }, new Set())).toBeNull();
    });
});

describe('item 4: no skybox is proposed for an audit', () => {
    const unlitSkyWithoutSkybox = (): Scene3DData => ({ ...skyScene(), environment: { ground: true } });
    const missingSkyAudit = (): VisualAuditResult => ({
        pass: false,
        fidelityScore: 45,
        critique: 'Dim, and the sky is missing.',
        issues: ['missing sky dome'],
        strengths: [],
        defects3D: [{ defectType: 'missing_skybox', severity: 'critical', description: 'No sky' }],
        visualFixes: { environment: { skybox: 'realistic-sky', lighting: 'shaded' } }
    });

    it('a missing-skybox defect maps to no operator', () => {
        expect(verifier.mapDefectsToOperators([{ defectType: 'missing_skybox', severity: 'info', description: 'no sky' }])).toEqual([]);
    });

    it('and the server repair leaves that scene without a skybox', () => {
        const scene = unlitSkyWithoutSkybox();
        const repaired = serverRepair(scene, missingSkyAudit());
        expect(repaired.environment?.skybox).toBeUndefined();
        expect(chosenEnvironment(repaired)).toEqual(chosenEnvironment(scene));
        expect(repaired.environment?.lighting).toBe('shaded');
    });
});

describe('item 5: the lighting operator relights without touching the environment', () => {
    it('keeps preset, rig and sun angles of sb_setup_lighting on a scene that names no skybox', () => {
        const scene: Scene3DData = { ...pbrStudioScene(), environment: { lighting: 'none', ground: false } };
        const repaired = serverRepair(scene, {
            pass: false, fidelityScore: 50, critique: 'Unlit.', issues: [], strengths: [],
            operatorDispatches: [{ operator: 'sb_setup_lighting', params: { preset: 'three-point', ambientIntensity: 0.5 } }]
        });
        expect(repaired.environment?.lighting).toBe('three-point');
        expect(repaired.environment?.lightingPreset).toBe('three-point');
        expect(repaired.environment?.lightingRig).toMatchObject({ preset: 'three-point', ambientIntensity: 0.5 });
        expect(typeof repaired.environment?.sunElevation).toBe('number');
        expect(typeof repaired.environment?.sunAzimuth).toBe('number');
        expect(repaired.environment?.skybox).toBeUndefined();
        expect(repaired.environment?.ground).toBe(false);
        expect((repaired.operatorStack || []).map(op => op.operator)).toEqual(['sb_setup_lighting']);
    });

    it('an unlit audit\'s lighting repair of a clay void relights it and stays a clay void', () => {
        const scene: Scene3DData = { ...framedClayScene(), environment: { lighting: 'none', ground: false } };
        const repaired = serverRepair(scene, unlitAudit());
        expect(repaired.environment?.lightingPreset).toBe('three-point');
        expect(repaired.environment?.skybox).toBeUndefined();
        expect(chosenEnvironment(repaired)).toEqual(chosenEnvironment(scene));
        expect(rendersSkyDome(repaired)).toBe(false);
    });

    it('drops an operator whose only effect was the environment, so the stack does not replay it', () => {
        const scene = pbrStudioScene();
        const repaired = serverRepair(scene, {
            pass: false, fidelityScore: 50, critique: '', issues: [], strengths: [],
            defects3D: [{ defectType: 'off_center_camera', severity: 'warning', description: 'far' }],
            operatorDispatches: [
                { operator: 'sb_configure_atmospheric_scattering', params: { enabled: true, turbidity: 3 } },
                { operator: 'sb_add_volumetric_god_rays', params: { intensity: 0.4 } },
                { operator: 'sb_set_camera', params: { position: [20, 10, 20], target: [0, 2, 0] } }
            ]
        });
        expect(chosenEnvironment(repaired)).toEqual(chosenEnvironment(scene));
        // pbrStudioScene has no customMeshes, so even a flagged framing cannot move its camera.
        expect(repaired.camera).toEqual(scene.camera);
        expect(repaired.operatorStack || []).toEqual([]);
    });
});

describe('the vision prompt follows the scene\'s own environment', () => {
    it('tells the model a studio or clay void is intended unless the scene draws a sky, and never to change the environment', () => {
        const clay = verifier.buildMultimodalPrompt({ image: FRAME, prompt: 'clay hero', context: { sceneData: clayStudioScene() } });
        expect(clay.systemInstruction).toContain('never report a missing sky');
        expect(clay.systemInstruction).not.toContain('"atmosphericScattering": boolean');
        expect(clay.systemInstruction).not.toContain('"ground": boolean');

        const sky = verifier.buildMultimodalPrompt({ image: FRAME, prompt: 'geysers', context: { sceneData: skyScene() } });
        expect(sky.systemInstruction).toContain('report a missing or broken sky as a defect');
        for (const prompt of [clay, sky]) {
            expect(prompt.systemInstruction).toContain('visualFixes and operatorDispatches never change them');
            expect(prompt.systemInstruction).toContain('defects3D entry of type off_center_camera or framing_offset');
        }
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
