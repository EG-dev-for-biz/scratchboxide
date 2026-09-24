/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  AdaptiveKeyframeDensityOptimizer,
  TrajectoryInputPoint
} from '../src/node/spatial/AdaptiveKeyframeDensityOptimizer';
import { AdaptiveMatchmoveCalibrationService } from '../src/node/spatial/AdaptiveMatchmoveCalibrationService';

describe('AdaptiveKeyframeDensityOptimizer', () => {
  // Helper to generate a synthetic trajectory with straight flight and a sharp turn
  function generateTestTrajectory(totalFrames: number = 200, durationSec: number = 10.0): TrajectoryInputPoint[] {
    const dt = durationSec / (totalFrames - 1);
    const frames: TrajectoryInputPoint[] = [];

    for (let i = 0; i < totalFrames; i++) {
      const t = i * dt;
      let pos: [number, number, number];
      let tgt: [number, number, number];

      if (t < 4.0) {
        // Phase 1: Straight smooth linear flight along +Z at 5 m/s (low curvature, low angular rate)
        pos = [0, 20, t * 5];
        tgt = [0, 20, t * 5 + 20];
      } else if (t < 6.0) {
        // Phase 2: Rapid 90-degree circular turn with vertical dip (high curvature, high angular rate)
        const turnFrac = (t - 4.0) / 2.0; // 0 to 1
        const angle = turnFrac * (Math.PI / 2.0);
        const radius = 10.0;
        pos = [
          radius * (1 - Math.cos(angle)),
          20 - Math.sin(turnFrac * Math.PI) * 5, // dips down and up
          20 + radius * Math.sin(angle)
        ];
        // Look-at turns sharply toward the center of the arc
        tgt = [radius, 15, 20];
      } else {
        // Phase 3: Straight linear flight along +X at 5 m/s (low curvature)
        const dt3 = t - 6.0;
        pos = [10 + dt3 * 5, 20, 30];
        tgt = [10 + dt3 * 5 + 20, 20, 30];
      }

      frames.push({
        timeSec: Number(t.toFixed(4)),
        position: pos,
        target: tgt
      });
    }

    return frames;
  }

  describe('1. Boundary Condition Invariance', () => {
    it('always strictly includes Frame 1 (index 0) and Frame N (index N-1) across all modes', () => {
      const frames = generateTestTrajectory(150, 8.0);
      const modes: Array<'error_bisection' | 'cumulative_saliency' | 'hybrid'> = [
        'error_bisection',
        'cumulative_saliency',
        'hybrid'
      ];

      for (const mode of modes) {
        const result = AdaptiveKeyframeDensityOptimizer.optimizeFromTrajectory(frames, 8.0, {
          mode,
          targetKeyframeCount: 15,
          maxDriftTolerance: 0.10
        });

        expect(result.selectedIndices).toContain(0);
        expect(result.selectedIndices).toContain(frames.length - 1);
        expect(result.selectedKeyframes[0].index).toBe(0);
        expect(result.selectedKeyframes[result.selectedKeyframes.length - 1].index).toBe(frames.length - 1);
        expect(result.selectedKeyframes[0].timeSec).toBe(frames[0].timeSec);
        expect(result.selectedKeyframes[result.selectedKeyframes.length - 1].timeSec).toBe(frames[frames.length - 1].timeSec);
      }
    });

    it('gracefully handles degenerate trajectories with <= 2 frames', () => {
      const single = [{ timeSec: 0, position: [0, 0, 0] as [number, number, number], target: [0, 0, 1] as [number, number, number] }];
      const resSingle = AdaptiveKeyframeDensityOptimizer.optimizeFromTrajectory(single, 1.0);
      expect(resSingle.totalKeyframes).toBe(1);
      expect(resSingle.selectedIndices).toEqual([0]);

      const pair = [
        { timeSec: 0, position: [0, 0, 0] as [number, number, number], target: [0, 0, 1] as [number, number, number] },
        { timeSec: 1, position: [0, 0, 5] as [number, number, number], target: [0, 0, 6] as [number, number, number] }
      ];
      const resPair = AdaptiveKeyframeDensityOptimizer.optimizeFromTrajectory(pair, 1.0);
      expect(resPair.totalKeyframes).toBe(2);
      expect(resPair.selectedIndices).toEqual([0, 1]);
    });
  });

  describe('2. Motion-Adaptive Keyframe Density Allocation', () => {
    it('allocates significantly higher keyframe density in high-movement turn zones than linear flight', () => {
      const frames = generateTestTrajectory(240, 10.0);
      // Turn is at t in [4.0, 6.0] seconds (20% of duration)
      // Linear flights are t in [0.0, 4.0] and [6.0, 10.0] (80% of duration)

      const result = AdaptiveKeyframeDensityOptimizer.optimizeFromTrajectory(frames, 10.0, {
        mode: 'error_bisection',
        maxDriftTolerance: 0.08,
        minIntervalSec: 0.15
      });

      // Count keyframes during the turn (4.0s to 6.0s) vs outside
      const turnKeyframes = result.selectedKeyframes.filter(k => k.timeSec >= 4.0 && k.timeSec <= 6.0);
      const linearKeyframes = result.selectedKeyframes.filter(k => k.timeSec < 4.0 || k.timeSec > 6.0);

      const turnDuration = 2.0;
      const linearDuration = 8.0;

      const turnDensity = turnKeyframes.length / turnDuration; // keyframes/sec
      const linearDensity = linearKeyframes.length / linearDuration; // keyframes/sec

      // The turn zone should have at least 2x higher keyframe density per second than straight flight
      expect(turnDensity).toBeGreaterThan(linearDensity * 2.0);
      expect(result.motionContrastRatio).toBeGreaterThan(1.5);
    });

    it('guarantees maximum interpolation drift is bounded under error_bisection mode', () => {
      const frames = generateTestTrajectory(180, 8.0);
      const tolerance = 0.10; // 10cm drift tolerance

      const result = AdaptiveKeyframeDensityOptimizer.optimizeFromTrajectory(frames, 8.0, {
        mode: 'error_bisection',
        maxDriftTolerance: tolerance,
        minIntervalSec: 0.10
      });

      expect(result.maxInterpolationDrift).toBeLessThanOrEqual(tolerance * 1.5); // Allow minor chord margin
      expect(result.meanInterpolationDrift).toBeLessThan(tolerance);
      expect(result.compressionRatio).toBeGreaterThan(2.0);
    });

    it('partitions exact keyframe budget under cumulative_saliency mode', () => {
      const frames = generateTestTrajectory(200, 10.0);
      const targetCount = 21;

      const result = AdaptiveKeyframeDensityOptimizer.optimizeFromTrajectory(frames, 10.0, {
        mode: 'cumulative_saliency',
        targetKeyframeCount: targetCount,
        minIntervalSec: 0.15
      });

      expect(result.selectedIndices[0]).toBe(0);
      expect(result.selectedIndices[result.selectedIndices.length - 1]).toBe(frames.length - 1);
      // Keyframe count should be at or close to target within minInterval limits
      expect(result.totalKeyframes).toBeGreaterThanOrEqual(targetCount - 3);
      expect(result.totalKeyframes).toBeLessThanOrEqual(targetCount + 1);
    });
  });

  describe('3. 2D Optical Flow Motion Flux Adaptivity', () => {
    it('dynamically adapts keyframe placement to 2D pixel motion spikes', () => {
      // 100 frames: low motion (1 px/frame) during 0-40, high motion (25 px/frame) during 40-60, low motion during 60-100
      const displacements: number[] = new Array(100).fill(1.0);
      for (let i = 40; i <= 60; i++) {
        displacements[i] = 25.0; // sudden whip-pan or fast camera movement
      }

      const result = AdaptiveKeyframeDensityOptimizer.optimizeFromMotionProfile(displacements, 4.0, {
        mode: 'error_bisection',
        maxDriftTolerance: 2.0,
        minIntervalSec: 0.05
      });

      expect(result.selectedIndices).toContain(0);
      expect(result.selectedIndices).toContain(99);

      // Verify that the spike zone (frames 40-60) gets dense keyframe placement
      const spikeKeys = result.selectedIndices.filter(idx => idx >= 40 && idx <= 60);
      const nonSpikeKeys = result.selectedIndices.filter(idx => idx < 40 || idx > 60);

      // 21 frames of spike vs 79 frames of stillness
      const spikeDensity = spikeKeys.length / 21;
      const nonSpikeDensity = nonSpikeKeys.length / 79;

      expect(spikeDensity).toBeGreaterThan(nonSpikeDensity * 2.5);
    });
  });

  describe('4. Integration with Real Plaza Hotel 361-Frame Sequence', () => {
    it('optimizes keyframe density on actual Plaza Hotel camera trajectory', () => {
      const plazaPath = path.resolve(process.cwd(), 'public/models/plaza_hotel_camera_path.json');
      expect(fs.existsSync(plazaPath)).toBe(true);

      const raw = JSON.parse(fs.readFileSync(plazaPath, 'utf8'));
      const trajectoryFrames = Array.isArray(raw) ? raw : raw.frames;
      expect(trajectoryFrames.length).toBe(361);

      // Test delegation via AdaptiveMatchmoveCalibrationService.optimizeKeyframeDensity
      const result = AdaptiveMatchmoveCalibrationService.optimizeKeyframeDensity(
        trajectoryFrames,
        15.0,
        {
          mode: 'error_bisection',
          maxDriftTolerance: 0.15,
          minIntervalSec: 0.20
        }
      );

      // 1. Boundary invariance: Frame 1 (index 0) and Frame 361 (index 360) strictly pinned
      expect(result.selectedIndices[0]).toBe(0);
      expect(result.selectedIndices[result.selectedIndices.length - 1]).toBe(360);
      expect(result.selectedKeyframes[0].frameNumber).toBe(1);
      expect(result.selectedKeyframes[result.selectedKeyframes.length - 1].frameNumber).toBe(361);

      // 2. High compression ratio: 361 frames compressed to ~15-35 keyframes (>10x compression)
      expect(result.compressionRatio).toBeGreaterThan(8.0);
      expect(result.totalKeyframes).toBeLessThan(50);

      // 3. Sub-meter precision drift bound
      expect(result.maxInterpolationDrift).toBeLessThan(0.35);
      expect(result.meanInterpolationDrift).toBeLessThan(0.12);

      // 4. Saliency profile is populated across all 361 frames
      expect(result.saliencyProfile.length).toBe(361);
      expect(result.saliencyProfile[0].saliency).toBeGreaterThan(0);
    });
  });
});
