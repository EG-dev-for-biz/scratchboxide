/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, it, expect } from 'vitest';

// ============================================================================
// Core Kinematic & Branching Contracts
// ============================================================================

export interface Joint2D {
    id: string;
    label: string;
    x: number; // Normalized [0, 1]
    y: number; // Normalized [0, 1]
    color: string;
    parent?: string;
}

export interface SkeletonBone {
    from: string;
    to: string;
    color: string;
}

export interface CameraPosePoint {
    time: number; // Normalized [0, 1] or seconds
    azimuthDeg: number;
    elevationDeg: number;
    distance: number;
    rollDeg?: number;
}

export type FootageDomain = 'architectural' | 'aerial' | 'character' | 'object' | 'landscape';

export interface SpatialFocalAnchor {
    x: number; // Normalized [0, 1]
    y: number; // Normalized [0, 1]
    label?: string;
    domain: FootageDomain;
}

export interface MidClipBranchConfig {
    originalVideoUrl: string;
    totalDurationSec: number;
    forkTimeSec: number;
    footageDomain?: FootageDomain;
    focalAnchor?: SpatialFocalAnchor | null;
    figureSelected?: {
        id: string;
        box: { x: number; y: number; width: number; height: number };
        joints: Record<string, Joint2D>;
        activePreset: string;
    } | null;
    cameraBranch: {
        maneuverPreset: string;
        divergentKeyframes: CameraPosePoint[];
    };
    narrativeAction: string;
    atmosphere: string;
    promptDirective?: string;
}

export interface Adaptive3DSubjectResolution {
    domain: FootageDomain;
    renderHumanoid: boolean;
    subjectType: 'character_avatar' | 'architectural_massing' | 'aerial_target_grid' | 'spatial_anchor_reticle';
    targetLookAt: { x: number; y: number; z: number };
    subjectLabel: string;
}

export function resolveAdaptive3DSubject(
    domain: FootageDomain,
    hasTrackedCharacter: boolean,
    focalAnchor?: SpatialFocalAnchor | null
): Adaptive3DSubjectResolution {
    if (hasTrackedCharacter || domain === 'character') {
        return {
            domain: 'character',
            renderHumanoid: true,
            subjectType: 'character_avatar',
            targetLookAt: { x: 0, y: 0.35, z: 0 },
            subjectLabel: 'Subject #1 (Actor Pose Anchor)'
        };
    }

    if (domain === 'architectural') {
        return {
            domain: 'architectural',
            renderHumanoid: false,
            subjectType: 'architectural_massing',
            targetLookAt: { x: 0, y: 0.45, z: 0 },
            subjectLabel: focalAnchor?.label || 'Plaza Hotel Architectural Crown & Facade'
        };
    }

    if (domain === 'aerial') {
        return {
            domain: 'aerial',
            renderHumanoid: false,
            subjectType: 'aerial_target_grid',
            targetLookAt: { x: 0, y: 0.0, z: 0 },
            subjectLabel: focalAnchor?.label || 'Urban Ground Coordinate Target (Lat/Lon Standoff)'
        };
    }

    return {
        domain: domain || 'object',
        renderHumanoid: false,
        subjectType: 'spatial_anchor_reticle',
        targetLookAt: { x: 0, y: 0.2, z: 0 },
        subjectLabel: focalAnchor?.label || 'Spatial Focus Anchor (POI)'
    };
}

// Canonical OpenPose 18-joint topology
export const OPENPOSE_18_CONNECTIONS: SkeletonBone[] = [
    { from: 'nose', to: 'neck', color: '#ff0055' },
    { from: 'neck', to: 'r_shoulder', color: '#ff5500' },
    { from: 'r_shoulder', to: 'r_elbow', color: '#ffaa00' },
    { from: 'r_elbow', to: 'r_wrist', color: '#ffff00' },
    { from: 'neck', to: 'l_shoulder', color: '#aaff00' },
    { from: 'l_shoulder', to: 'l_elbow', color: '#55ff00' },
    { from: 'l_elbow', to: 'l_wrist', color: '#00ff55' },
    { from: 'neck', to: 'r_hip', color: '#00ffaa' },
    { from: 'r_hip', to: 'r_knee', color: '#00ffff' },
    { from: 'r_knee', to: 'r_ankle', color: '#00aaff' },
    { from: 'neck', to: 'l_hip', color: '#0055ff' },
    { from: 'l_hip', to: 'l_knee', color: '#0000ff' },
    { from: 'l_knee', to: 'l_ankle', color: '#5500ff' },
    { from: 'nose', to: 'r_eye', color: '#aa00ff' },
    { from: 'r_eye', to: 'r_ear', color: '#ff00ff' },
    { from: 'nose', to: 'l_eye', color: '#ff00aa' },
    { from: 'l_eye', to: 'l_ear', color: '#ff0055' }
];

// Mathematical Pose Generator for Presets
export function generatePosePreset(preset: string, cx = 0.5, cy = 0.5, scale = 1.0): Record<string, Joint2D> {
    const s = scale;
    const joints: Record<string, { x: number; y: number; color: string; label: string }> = {
        nose: { x: cx, y: cy - 0.28 * s, color: '#ff0055', label: 'Nose' },
        neck: { x: cx, y: cy - 0.20 * s, color: '#ff5500', label: 'Neck' },
        r_shoulder: { x: cx - 0.08 * s, y: cy - 0.18 * s, color: '#ffaa00', label: 'R Shoulder' },
        r_elbow: { x: cx - 0.14 * s, y: cy - 0.08 * s, color: '#ffaa00', label: 'R Elbow' },
        r_wrist: { x: cx - 0.16 * s, y: cy + 0.02 * s, color: '#ffff00', label: 'R Wrist' },
        l_shoulder: { x: cx + 0.08 * s, y: cy - 0.18 * s, color: '#aaff00', label: 'L Shoulder' },
        l_elbow: { x: cx + 0.14 * s, y: cy - 0.08 * s, color: '#55ff00', label: 'L Elbow' },
        l_wrist: { x: cx + 0.16 * s, y: cy + 0.02 * s, color: '#00ff55', label: 'L Wrist' },
        r_hip: { x: cx - 0.06 * s, y: cy + 0.05 * s, color: '#00ffaa', label: 'R Hip' },
        r_knee: { x: cx - 0.07 * s, y: cy + 0.18 * s, color: '#00ffff', label: 'R Knee' },
        r_ankle: { x: cx - 0.07 * s, y: cy + 0.32 * s, color: '#00aaff', label: 'R Ankle' },
        l_hip: { x: cx + 0.06 * s, y: cy + 0.05 * s, color: '#0055ff', label: 'L Hip' },
        l_knee: { x: cx + 0.07 * s, y: cy + 0.18 * s, color: '#0000ff', label: 'L Knee' },
        l_ankle: { x: cx + 0.07 * s, y: cy + 0.32 * s, color: '#5500ff', label: 'L Ankle' },
        r_eye: { x: cx - 0.02 * s, y: cy - 0.30 * s, color: '#aa00ff', label: 'R Eye' },
        r_ear: { x: cx - 0.05 * s, y: cy - 0.28 * s, color: '#ff00ff', label: 'R Ear' },
        l_eye: { x: cx + 0.02 * s, y: cy - 0.30 * s, color: '#ff00aa', label: 'L Eye' },
        l_ear: { x: cx + 0.05 * s, y: cy - 0.28 * s, color: '#ff0055', label: 'L Ear' }
    };

    if (preset === 't_pose') {
        joints.r_shoulder.y = cy - 0.18 * s;
        joints.r_elbow.x = cx - 0.22 * s;
        joints.r_elbow.y = cy - 0.18 * s;
        joints.r_wrist.x = cx - 0.35 * s;
        joints.r_wrist.y = cy - 0.18 * s;

        joints.l_shoulder.y = cy - 0.18 * s;
        joints.l_elbow.x = cx + 0.22 * s;
        joints.l_elbow.y = cy - 0.18 * s;
        joints.l_wrist.x = cx + 0.35 * s;
        joints.l_wrist.y = cy - 0.18 * s;
    } else if (preset === 'wave_salute') {
        // Right hand waving high
        joints.r_elbow.x = cx - 0.18 * s;
        joints.r_elbow.y = cy - 0.24 * s;
        joints.r_wrist.x = cx - 0.22 * s;
        joints.r_wrist.y = cy - 0.38 * s;
    } else if (preset === 'superhero_landing') {
        // Crouched one fist on ground
        joints.neck.y = cy - 0.05 * s;
        joints.r_shoulder.y = cy - 0.03 * s;
        joints.l_shoulder.y = cy - 0.03 * s;
        joints.r_wrist.x = cx - 0.02 * s;
        joints.r_wrist.y = cy + 0.22 * s; // fist touching floor
        joints.r_knee.y = cy + 0.12 * s;
        joints.l_knee.y = cy + 0.08 * s;
        joints.l_ankle.x = cx + 0.25 * s; // trailing leg out
        joints.l_ankle.y = cy + 0.22 * s;
    } else if (preset === 'action_kick') {
        // High martial arts kick with left leg
        joints.l_hip.y = cy + 0.02 * s;
        joints.l_knee.x = cx + 0.18 * s;
        joints.l_knee.y = cy - 0.10 * s;
        joints.l_ankle.x = cx + 0.36 * s;
        joints.l_ankle.y = cy - 0.22 * s;
    }

    const result: Record<string, Joint2D> = {};
    for (const [key, val] of Object.entries(joints)) {
        result[key] = {
            id: key,
            label: val.label,
            x: Math.max(0, Math.min(1, val.x)),
            y: Math.max(0, Math.min(1, val.y)),
            color: val.color
        };
    }
    return result;
}

// Camera Trajectory Spline Continuity Validator ($C^1$ smoothness at $t_{fork}$)
export function validateTrajectoryContinuity(
    historicalPoints: CameraPosePoint[],
    divergentPoints: CameraPosePoint[],
    forkTime: number
): { continuousC0: boolean; continuousC1: boolean; angleDeltaDeg: number } {
    if (historicalPoints.length === 0 || divergentPoints.length === 0) {
        return { continuousC0: false, continuousC1: false, angleDeltaDeg: 0 };
    }

    const lastHist = historicalPoints[historicalPoints.length - 1];
    const firstDiv = divergentPoints[0];

    const c0Dist = Math.hypot(
        lastHist.azimuthDeg - firstDiv.azimuthDeg,
        lastHist.elevationDeg - firstDiv.elevationDeg,
        (lastHist.distance - firstDiv.distance) * 50
    );

    const continuousC0 = c0Dist < 1.0; // Within 1 degree / metric tolerance

    // Check tangent velocity vector
    let velHist = 0;
    if (historicalPoints.length >= 2) {
        const prev = historicalPoints[historicalPoints.length - 2];
        const dt = lastHist.time - prev.time;
        if (dt > 0) velHist = (lastHist.azimuthDeg - prev.azimuthDeg) / dt;
    }

    let velDiv = 0;
    if (divergentPoints.length >= 2) {
        const next = divergentPoints[1];
        const dt = next.time - firstDiv.time;
        if (dt > 0) velDiv = (next.azimuthDeg - firstDiv.azimuthDeg) / dt;
    }

    const continuousC1 = Math.abs(velHist - velDiv) < 180; // Reasonable kinematic acceleration threshold

    return {
        continuousC0,
        continuousC1,
        angleDeltaDeg: Math.abs(lastHist.azimuthDeg - firstDiv.azimuthDeg)
    };
}

// Auto-Compiling Prompt Directive Synthesizer
export function compileBranchPrompt(config: MidClipBranchConfig): string {
    const hasCharacter = Boolean(config.figureSelected && config.figureSelected.id);

    const cameraText = {
        hero_push_in: 'the camera rapidly pushes in for an intimate cinematic hero close-up',
        crane_reveal: 'the camera cranes dynamically upward into a sweeping high-angle bird\'s-eye view',
        reverse_orbit: 'the camera reverses direction in a fluid 180-degree orbital whip around the focal subject',
        dutch_tilt: 'the camera executes a dramatic low-angle Dutch roll with pronounced perspective tension'
    }[config.cameraBranch.maneuverPreset] || 'camera diverges along the new choreographed spatial trajectory';

    const narrativeText = {
        anti_gravity: 'The scene defies gravity and begins to levitate upwards, surrounded by faint gravitational distortion rings.',
        cybernetic_armor: 'Gleaming cybernetic nanotech armor rapidly deploys across the surfaces with iridescent bioluminescent circuit traces.',
        golden_dust: 'The focal elements subtly begin to dissolve into swirling luminous golden particle embers drifting in the air.',
        matrix_freeze: 'A shimmering temporal shockwave expands outwards as time drastically dilates into bullet-time suspension.'
    }[config.narrativeAction] || 'Action transitions into the directed divergent sequence.';

    const atmosphereText = {
        golden_hour: 'The lighting shifts into radiant golden hour twilight (2800K) with warm low-angle sun rays and long soft shadows.',
        neon_rain: 'The environment transforms into a wet cyberpunk streetscape with glistening rain reflections and vibrant neon magenta/cyan rim lighting.',
        blizzard: 'A sudden turbulent snow squall sweeps across the frame with swirling snowflakes and frosted surfaces.',
        volcanic_eclipse: 'The sky darkens into an atmospheric crimson eclipse with floating incandescent volcanic embers.'
    }[config.atmosphere] || 'Environmental lighting harmonizes with the scene.';

    if (hasCharacter && config.figureSelected) {
        const figurePoseText = {
            original: 'maintaining original tracked anatomical stance',
            t_pose: 'smoothly transitioning into a clean T-pose with arms extended horizontally',
            wave_salute: 'raising the right arm into an energetic wave salute gesture',
            superhero_landing: 'dropping into a dramatic three-point superhero landing with one fist pressed to the ground',
            action_kick: 'executing a dynamic martial arts aerial high-kick'
        }[config.figureSelected.activePreset] || `transitioning into a modified pose (${config.figureSelected.activePreset})`;

        return `At timestamp ${config.forkTimeSec.toFixed(1)}s, the video branches: The focal figure begins ${figurePoseText}. Simultaneously, ${cameraText}. ${narrativeText} ${atmosphereText} Maintain perfect temporal coherence, seed-frame lighting consistency, and zero jitter from the anchor frame forward.`;
    } else {
        const anchorText = config.focalAnchor?.label
            ? ` focusing toward the ${config.focalAnchor.label}`
            : '';
        // Pure camera & environmental divergence (zero tracked character)
        return `At timestamp ${config.forkTimeSec.toFixed(1)}s, the video branches: The camera diverges as ${cameraText}${anchorText}. ${narrativeText} ${atmosphereText} Maintain perfect temporal coherence, seed-frame lighting consistency, and zero jitter from the anchor frame forward.`;
    }
}

// ============================================================================
// Automated Vitest Suite
// ============================================================================

describe('Mid-Clip Video Branching & Animation Studio Engine', () => {
    describe('1. OpenPose 18-Joint Topology & Pose Presets', () => {
        it('defines all 18 standard anatomical landmarks with valid colors', () => {
            const pose = generatePosePreset('default', 0.5, 0.5, 1.0);
            expect(Object.keys(pose).length).toBe(18);
            expect(pose.nose).toBeDefined();
            expect(pose.neck).toBeDefined();
            expect(pose.r_shoulder).toBeDefined();
            expect(pose.l_wrist).toBeDefined();
            expect(pose.r_ankle).toBeDefined();
            expect(pose.l_ankle).toBeDefined();

            // All coordinates must be clamped [0, 1]
            for (const joint of Object.values(pose)) {
                expect(joint.x).toBeGreaterThanOrEqual(0);
                expect(joint.x).toBeLessThanOrEqual(1);
                expect(joint.y).toBeGreaterThanOrEqual(0);
                expect(joint.y).toBeLessThanOrEqual(1);
                expect(joint.color).toMatch(/^#[0-9a-fA-F]{6}$/);
            }
        });

        it('properly configures T-Pose with horizontal arms', () => {
            const tPose = generatePosePreset('t_pose', 0.5, 0.5, 1.0);
            expect(tPose.r_wrist.x).toBeLessThan(tPose.r_elbow.x);
            expect(tPose.r_elbow.x).toBeLessThan(tPose.r_shoulder.x);
            expect(tPose.l_wrist.x).toBeGreaterThan(tPose.l_elbow.x);
            expect(tPose.l_elbow.x).toBeGreaterThan(tPose.l_shoulder.x);
            // Arms should be nearly horizontal (same Y level as shoulders)
            expect(Math.abs(tPose.r_wrist.y - tPose.r_shoulder.y)).toBeLessThan(0.05);
            expect(Math.abs(tPose.l_wrist.y - tPose.l_shoulder.y)).toBeLessThan(0.05);
        });

        it('properly configures Wave/Salute with elevated right wrist', () => {
            const wave = generatePosePreset('wave_salute', 0.5, 0.5, 1.0);
            // In screen space (Y=0 at top), elevated wrist has lower Y value than neck/shoulder
            expect(wave.r_wrist.y).toBeLessThan(wave.neck.y);
            expect(wave.r_wrist.y).toBeLessThan(wave.r_shoulder.y);
        });

        it('properly configures Superhero Landing with fist ground contact', () => {
            const landing = generatePosePreset('superhero_landing', 0.5, 0.5, 1.0);
            // Fist Y should be close to ankle/floor level
            expect(landing.r_wrist.y).toBeGreaterThan(landing.neck.y);
            expect(landing.neck.y).toBeGreaterThan(0.4); // crouched posture
        });
    });

    describe('2. Camera Trajectory Spline Branching & Kinematics', () => {
        it('validates $C^0$ positional continuity at the fork boundary', () => {
            const historical: CameraPosePoint[] = [
                { time: 0.0, azimuthDeg: 0, elevationDeg: 0, distance: 1.0 },
                { time: 2.0, azimuthDeg: 30, elevationDeg: 5, distance: 1.1 },
                { time: 4.2, azimuthDeg: 60, elevationDeg: 8, distance: 1.2 }
            ];

            // Divergent path starting exactly at the boundary pose
            const divergentContinuous: CameraPosePoint[] = [
                { time: 4.2, azimuthDeg: 60, elevationDeg: 8, distance: 1.2 },
                { time: 6.0, azimuthDeg: 90, elevationDeg: 15, distance: 1.5 },
                { time: 9.0, azimuthDeg: 140, elevationDeg: 25, distance: 1.8 }
            ];

            const check = validateTrajectoryContinuity(historical, divergentContinuous, 4.2);
            expect(check.continuousC0).toBe(true);
            expect(check.angleDeltaDeg).toBe(0);
        });

        it('detects discontinuities when divergent path jumps angle or position', () => {
            const historical: CameraPosePoint[] = [
                { time: 4.2, azimuthDeg: 60, elevationDeg: 8, distance: 1.2 }
            ];
            const discontinuous: CameraPosePoint[] = [
                { time: 4.2, azimuthDeg: 180, elevationDeg: -20, distance: 2.5 }
            ];

            const check = validateTrajectoryContinuity(historical, discontinuous, 4.2);
            expect(check.continuousC0).toBe(false);
            expect(check.angleDeltaDeg).toBe(120);
        });
    });

    describe('3. Automated Prompt Synthesizer & Conditioning Contract', () => {
        it('synthesizes comprehensive video inpainting directive from visual parameters', () => {
            const config: MidClipBranchConfig = {
                originalVideoUrl: 'public/videos/plaza_hotel_omni_15s_720p.mp4',
                totalDurationSec: 15.0,
                forkTimeSec: 4.2,
                figureSelected: {
                    id: 'subject_01',
                    box: { x: 0.4, y: 0.2, width: 0.2, height: 0.6 },
                    joints: generatePosePreset('wave_salute'),
                    activePreset: 'wave_salute'
                },
                cameraBranch: {
                    maneuverPreset: 'crane_reveal',
                    divergentKeyframes: [
                        { time: 4.2, azimuthDeg: 50, elevationDeg: 5, distance: 1.22 },
                        { time: 8.0, azimuthDeg: 90, elevationDeg: 35, distance: 1.8 }
                    ]
                },
                narrativeAction: 'cybernetic_armor',
                atmosphere: 'neon_rain'
            };

            const prompt = compileBranchPrompt(config);
            expect(prompt).toContain('timestamp 4.2s');
            expect(prompt).toContain('wave salute gesture');
            expect(prompt).toContain('high-angle bird\'s-eye view');
            expect(prompt).toContain('cybernetic nanotech armor');
            expect(prompt).toContain('wet cyberpunk streetscape');
            expect(prompt).toContain('temporal coherence');
        });

        it('omits character pose conditioning when no character is tracked in the video', () => {
            const configNoActor: MidClipBranchConfig = {
                originalVideoUrl: 'public/videos/plaza_hotel_omni_15s_720p.mp4',
                totalDurationSec: 15.0,
                forkTimeSec: 4.2,
                figureSelected: null, // No character tracked in this drone/environmental shot
                cameraBranch: {
                    maneuverPreset: 'hero_push_in',
                    divergentKeyframes: [
                        { time: 4.2, azimuthDeg: 0, elevationDeg: 0, distance: 1.0 },
                        { time: 8.0, azimuthDeg: 15, elevationDeg: 10, distance: 0.8 }
                    ]
                },
                narrativeAction: 'golden_dust',
                atmosphere: 'golden_hour'
            };

            const prompt = compileBranchPrompt(configNoActor);
            expect(prompt).toContain('timestamp 4.2s');
            expect(prompt).toContain('camera diverges as the camera rapidly pushes in');
            expect(prompt).not.toContain('focal figure begins');
            expect(prompt).toContain('golden particle embers');
            expect(prompt).toContain('radiant golden hour twilight');
            expect(prompt).toContain('temporal coherence');
        });
    });

    describe('4. Adaptive Footage Domain & 3D Focal Subject Resolution', () => {
        it('resolves humanoid character avatar ONLY when character is tracked or footage domain is character', () => {
            const charSubject = resolveAdaptive3DSubject('character', true);
            expect(charSubject.renderHumanoid).toBe(true);
            expect(charSubject.subjectType).toBe('character_avatar');
            expect(charSubject.subjectLabel).toContain('Subject #1 (Actor');
            expect(charSubject.targetLookAt.y).toBeCloseTo(0.35);
        });

        it('strictly omits humanoid avatar for architectural footage and resolves building massing target', () => {
            const archSubject = resolveAdaptive3DSubject('architectural', false);
            expect(archSubject.renderHumanoid).toBe(false);
            expect(archSubject.subjectType).toBe('architectural_massing');
            expect(archSubject.subjectLabel).toContain('Architectural');
            expect(archSubject.targetLookAt.y).toBeCloseTo(0.45);
        });

        it('strictly omits humanoid avatar for aerial drone footage and resolves ground coordinate target', () => {
            const aerialSubject = resolveAdaptive3DSubject('aerial', false);
            expect(aerialSubject.renderHumanoid).toBe(false);
            expect(aerialSubject.subjectType).toBe('aerial_target_grid');
            expect(aerialSubject.subjectLabel).toContain('Urban Ground Coordinate Target');
            expect(aerialSubject.targetLookAt.y).toBeCloseTo(0.0);
        });

        it('synthesizes spatial focal anchor conditioning into prompt when anchor is selected on canvas', () => {
            const configWithAnchor: MidClipBranchConfig = {
                originalVideoUrl: 'public/videos/plaza_hotel_omni_15s_720p.mp4',
                totalDurationSec: 15.0,
                forkTimeSec: 4.2,
                footageDomain: 'architectural',
                focalAnchor: {
                    x: 0.50,
                    y: 0.38,
                    label: 'Plaza Hotel Central Mansard Cupola',
                    domain: 'architectural'
                },
                figureSelected: null,
                cameraBranch: {
                    maneuverPreset: 'crane_reveal',
                    divergentKeyframes: [
                        { time: 4.2, azimuthDeg: 0, elevationDeg: 0, distance: 1.0 }
                    ]
                },
                narrativeAction: 'cybernetic_armor',
                atmosphere: 'neon_rain'
            };

            const prompt = compileBranchPrompt(configWithAnchor);
            expect(prompt).toContain('timestamp 4.2s');
            expect(prompt).toContain('focusing toward the Plaza Hotel Central Mansard Cupola');
            expect(prompt).not.toContain('focal figure begins');
        });
    });
});

