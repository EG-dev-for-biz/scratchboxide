/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, it, expect, beforeEach } from 'vitest';
import * as THREE from 'three';
import {
  ConcertStagePerformerService,
  PerformerSkinningMode,
  MUSIC_VENUE_PRESETS,
  DEFAULT_CANONICAL_JOINTS,
  PerformerKinematicsFrame
} from '../src/browser/generative-canvas/services/ConcertStagePerformerService';
import { BakedGaussian } from '../src/common/geospatial-4d-protocol';

describe('ConcertStagePerformerService (Red Rocks Amphitheatre & 4D Performer)', () => {
  let service: ConcertStagePerformerService;

  // Mock synthetic test performer splats (torso, arms, legs)
  const mockSplats: BakedGaussian[] = [
    // Pelvis / Torso
    { position: [0.0, 0.95, 0.0], scale: [0.02, 0.02, 0.02], colorRgb: [0.8, 0.2, 0.2], opacity: 1.0, quaternion: [0, 0, 0, 1] },
    { position: [0.02, 1.15, 0.01], scale: [0.02, 0.02, 0.02], colorRgb: [0.8, 0.2, 0.2], opacity: 1.0, quaternion: [0, 0, 0, 1] },
    // Left Arm / Wrist
    { position: [0.42, 1.30, -0.05], scale: [0.015, 0.015, 0.015], colorRgb: [0.2, 0.8, 0.2], opacity: 1.0, quaternion: [0, 0, 0, 1] },
    { position: [0.65, 1.32, -0.06], scale: [0.015, 0.015, 0.015], colorRgb: [0.2, 0.8, 0.2], opacity: 1.0, quaternion: [0, 0, 0, 1] },
    // Right Arm / Wrist
    { position: [-0.42, 1.33, -0.04], scale: [0.015, 0.015, 0.015], colorRgb: [0.2, 0.8, 0.2], opacity: 1.0, quaternion: [0, 0, 0, 1] },
    { position: [-0.66, 1.32, -0.06], scale: [0.015, 0.015, 0.015], colorRgb: [0.2, 0.8, 0.2], opacity: 1.0, quaternion: [0, 0, 0, 1] },
    // Left Leg / Foot
    { position: [0.08, 0.45, -0.01], scale: [0.02, 0.02, 0.02], colorRgb: [0.2, 0.2, 0.8], opacity: 1.0, quaternion: [0, 0, 0, 1] },
    { position: [0.08, 0.05, 0.08], scale: [0.02, 0.02, 0.02], colorRgb: [0.2, 0.2, 0.8], opacity: 1.0, quaternion: [0, 0, 0, 1] },
    // Right Leg / Foot
    { position: [-0.08, 0.45, -0.01], scale: [0.02, 0.02, 0.02], colorRgb: [0.2, 0.2, 0.8], opacity: 1.0, quaternion: [0, 0, 0, 1] },
    { position: [-0.08, 0.05, 0.08], scale: [0.02, 0.02, 0.02], colorRgb: [0.2, 0.2, 0.8], opacity: 1.0, quaternion: [0, 0, 0, 1] },
  ];

  // 3-Frame kinematic motion (arm raise + dance step)
  const mockMotionFrames: PerformerKinematicsFrame[] = [
    {
      frameIndex: 0,
      timestampSec: 0.0,
      rootTranslation: [0, 0, 0],
      rootRotation: [0, 0, 0, 1],
      jointPositions: DEFAULT_CANONICAL_JOINTS.map(j => [...j]),
    },
    {
      frameIndex: 1,
      timestampSec: 0.033,
      rootTranslation: [0.05, 0.02, 0.01],
      rootRotation: [0, 0, 0, 1],
      jointPositions: DEFAULT_CANONICAL_JOINTS.map((j, idx) => {
        // Raise left arm joints (18: left_elbow, 20: left_wrist)
        if (idx === 18) return [j[0], j[1] + 0.15, j[2] + 0.05];
        if (idx === 20) return [j[0], j[1] + 0.35, j[2] + 0.10];
        return [...j];
      }),
    },
    {
      frameIndex: 2,
      timestampSec: 0.066,
      rootTranslation: [0.10, 0.04, 0.02],
      rootRotation: [0, 0, 0, 1],
      jointPositions: DEFAULT_CANONICAL_JOINTS.map((j, idx) => {
        // Further raise left arm, step right foot
        if (idx === 18) return [j[0], j[1] + 0.25, j[2] + 0.10];
        if (idx === 20) return [j[0], j[1] + 0.50, j[2] + 0.15];
        if (idx === 11) return [j[0], j[1] + 0.08, j[2] + 0.05]; // right foot lifted
        return [...j];
      }),
    },
  ];

  beforeEach(() => {
    service = new ConcertStagePerformerService({
      venue: MUSIC_VENUE_PRESETS.red_rocks,
      stageHeight: 1.20,
      stageWidth: 18.0,
      stageDepth: 12.0,
      trussHeight: 8.50,
      skinningMode: PerformerSkinningMode.SCRATCHBOX_LBS_4BONE,
    });
  });

  it('1. Initializes Red Rocks Amphitheatre geodetic stage setup', () => {
    expect(service.venue.id).toBe('red_rocks');
    expect(service.venue.lat).toBeCloseTo(39.66555, 4);
    expect(service.venue.lng).toBeCloseTo(-105.20525, 4);
    expect(service.venue.altMeters).toBe(1932.0);
    expect(service.stageHeight).toBe(1.20);
    expect(service.group.children.length).toBeGreaterThanOrEqual(5); // Deck, Truss, Audio, Lights, Performer
  });

  it('2. Constructs physical stage architecture with deck, overhead truss, and lighting', () => {
    expect(service.stageDeckGroup.children.length).toBeGreaterThanOrEqual(2); // Main deck + safety apron
    expect(service.trussGroup.children.length).toBeGreaterThanOrEqual(4);     // Columns + overhead beams
    expect(service.audioGroup.children.length).toBeGreaterThan(0);            // Left & Right PA line arrays
    expect(service.lightingGroup.children.length).toBeGreaterThan(0);         // Stage spotlights
  });

  it('3. Binds 4-bone weights with normalized partition of unity (sum = 1.0)', () => {
    service.loadPerformerSplats(mockSplats);
    expect(service.splatWeights.length).toBe(mockSplats.length);

    service.splatWeights.forEach((sw) => {
      const sum = sw.boneWeights.reduce((a, b) => a + b, 0);
      expect(sum).toBeCloseTo(1.0, 4);
      expect(sw.boneIndices.length).toBe(4);
    });
  });

  it('4. Evaluates Scratchbox 4-Bone LBS with ground clamping to stage deck', () => {
    service.loadPerformerSplats(mockSplats);
    service.loadMotionFrames(mockMotionFrames);

    // Frame 0
    const frame0Splats = service.evaluateCurrentFrame();
    expect(frame0Splats.length).toBe(mockSplats.length);

    // Ground clamping check: lowest foot splat should be at or just above stage height (1.20m)
    const minY0 = Math.min(...frame0Splats.map(s => s.position[1]));
    expect(minY0).toBeGreaterThanOrEqual(1.18); // Within 2cm of deck
    expect(minY0).toBeLessThan(1.30);

    // Frame 2: arm raised
    service.seek(2);
    const frame2Splats = service.evaluateCurrentFrame();
    const wristSplatF0 = frame0Splats[3]; // Left wrist
    const wristSplatF2 = frame2Splats[3];

    // Left wrist should have moved up significantly due to bone rotation & translation
    expect(wristSplatF2.position[1]).toBeGreaterThan(wristSplatF0.position[1] + 0.3);
  });

  it('5. Compares Scratchbox 4-Bone LBS against DepthBox3 legacy translation-only mode', () => {
    service.loadPerformerSplats(mockSplats);
    service.loadMotionFrames(mockMotionFrames);
    service.seek(2);

    // 1. Evaluate with Scratchbox 4-Bone LBS (Rotational kinematics)
    service.setSkinningMode(PerformerSkinningMode.SCRATCHBOX_LBS_4BONE);
    const lbsSplats = service.evaluateCurrentFrame();

    // 2. Evaluate with DepthBox3 Legacy Translation (Zero rotation R=I)
    service.setSkinningMode(PerformerSkinningMode.DEPTHBOX3_LEGACY_TRANSLATION);
    const legacySplats = service.evaluateCurrentFrame();

    expect(lbsSplats.length).toBe(legacySplats.length);

    // There should be a measurable difference between full rotational skinning and translation-only
    let totalPosDelta = 0;
    for (let i = 0; i < lbsSplats.length; i++) {
      const p1 = lbsSplats[i].position;
      const p2 = legacySplats[i].position;
      const dx = p1[0] - p2[0];
      const dy = p1[1] - p2[1];
      const dz = p1[2] - p2[2];
      totalPosDelta += Math.sqrt(dx * dx + dy * dy + dz * dz);
    }

    expect(totalPosDelta).toBeGreaterThan(0.05); // Noticeable geometric difference
  });

  it('6. Updates timeline playback and outputs comprehensive telemetry', () => {
    service.loadPerformerSplats(mockSplats);
    service.loadMotionFrames(mockMotionFrames);

    service.play();
    expect(service.isPlaying).toBe(true);

    // Advance 1/30 second
    service.update(0.034);
    expect(service.currentFrameIndex).toBeGreaterThan(0);

    const telemetry = service.getTelemetry();
    expect(telemetry.venueId).toBe('red_rocks');
    expect(telemetry.venueName).toBe('Red Rocks Amphitheatre');
    expect(telemetry.currentFrame).toBeGreaterThanOrEqual(1);
    expect(telemetry.totalFrames).toBe(3);
    expect(telemetry.numSplats).toBe(mockSplats.length);
    expect(telemetry.bounds.size[1]).toBeGreaterThan(0); // Height > 0
  });

  it('7. Exports current deformed frame to standard 32-byte binary .splat buffer', () => {
    service.loadPerformerSplats(mockSplats);
    service.loadMotionFrames(mockMotionFrames);

    const buffer = service.exportCurrentFrameSplatBuffer();
    expect(buffer.byteLength).toBe(mockSplats.length * 32);

    const view = new DataView(buffer);
    // Position float32
    const posX = view.getFloat32(0, true);
    const posY = view.getFloat32(4, true);
    const posZ = view.getFloat32(8, true);

    expect(posY).toBeGreaterThan(1.0); // Should be elevated above ground on stage deck
  });
});
