/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Adaptive Domain Architecture Motion-Adaptive Keyframing Optimizer.
 *
 * Solves the variable-density keyframe allocation problem across arbitrary sequences:
 * - Allocates dense keyframes during rapid camera movement, sharp turns, and accelerations.
 * - Allocates sparse keyframes during linear moves, constant velocity, or hover periods.
 * - Strictly pins Frame 1 (t=0) and Frame N (t=end) as immutable boundary anchors.
 * - Supports Recursive Error-Bisection (Douglas-Peucker with spline drift guarantees)
 *   and Cumulative Motion Saliency Integration.
 */

export interface TrajectoryInputPoint {
  timeSec: number;
  position: [number, number, number];
  target: [number, number, number];
  up?: [number, number, number];
  fov?: number;
}

export interface MotionAdaptiveConfig {
  /** Optimization strategy: 'error_bisection' (tolerance-driven) or 'cumulative_saliency' (budget-driven) */
  mode?: 'error_bisection' | 'cumulative_saliency' | 'hybrid';
  /** Target keyframe count for budget-driven or hybrid modes. Default: 25 */
  targetKeyframeCount?: number;
  /** Maximum allowable 3D interpolation drift (meters/units). Default: 0.05 */
  maxDriftTolerance?: number;
  /** Minimum time interval between adjacent keyframes (seconds) to prevent micro-jitter. Default: 0.15 */
  minIntervalSec?: number;
  /** Maximum time interval between adjacent keyframes (seconds) to prevent blind spans. Default: 3.0 */
  maxIntervalSec?: number;
  /** Frenet-Serret spatial curvature sensitivity weight kappa(t). Default: 1.5 */
  curvatureWeight?: number;
  /** Angular look-at velocity sensitivity weight omega(t). Default: 1.2 */
  angularRateWeight?: number;
  /** Linear velocity magnitude sensitivity weight. Default: 0.4 */
  velocityWeight?: number;
}

export interface SelectedKeyframeAnchor {
  index: number;
  frameNumber: number;
  timeSec: number;
  position: [number, number, number];
  target: [number, number, number];
  motionSaliency: number;
  curvature: number;
  angularRate: number;
  velocity: number;
}

export interface KeyframeSelectionResult {
  selectedIndices: number[];
  selectedKeyframes: SelectedKeyframeAnchor[];
  saliencyProfile: Array<{
    index: number;
    timeSec: number;
    curvature: number;
    angularRate: number;
    velocity: number;
    saliency: number;
  }>;
  maxInterpolationDrift: number;
  meanInterpolationDrift: number;
  compressionRatio: number;
  totalKeyframes: number;
  totalFrames: number;
  mode: 'error_bisection' | 'cumulative_saliency' | 'hybrid';
  motionContrastRatio: number; // Ratio of keyframe density in high-motion vs low-motion zones
}

export class AdaptiveKeyframeDensityOptimizer {
  /**
   * Optimizes keyframe density from a 3D camera trajectory.
   * Guaranteed: First frame (index 0) and Last frame (index N-1) are always selected.
   */
  public static optimizeFromTrajectory(
    frames: TrajectoryInputPoint[],
    durationSec?: number,
    config: MotionAdaptiveConfig = {}
  ): KeyframeSelectionResult {
    const N = frames.length;
    const dur = durationSec && durationSec > 0
      ? durationSec
      : (N > 1 ? frames[N - 1].timeSec - frames[0].timeSec : 1.0);

    // Degenerate sequence handling
    if (N <= 2) {
      const selected = frames.map((f, i) => ({
        index: i,
        frameNumber: i + 1,
        timeSec: f.timeSec,
        position: [...f.position] as [number, number, number],
        target: [...f.target] as [number, number, number],
        motionSaliency: 1.0,
        curvature: 0.0,
        angularRate: 0.0,
        velocity: 0.0
      }));
      return {
        selectedIndices: frames.map((_, i) => i),
        selectedKeyframes: selected,
        saliencyProfile: selected.map(s => ({
          index: s.index,
          timeSec: s.timeSec,
          curvature: 0,
          angularRate: 0,
          velocity: 0,
          saliency: 1
        })),
        maxInterpolationDrift: 0.0,
        meanInterpolationDrift: 0.0,
        compressionRatio: 1.0,
        totalKeyframes: N,
        totalFrames: N,
        mode: config.mode || 'error_bisection',
        motionContrastRatio: 1.0
      };
    }

    const mode = config.mode || 'error_bisection';
    const minInterval = config.minIntervalSec ?? 0.15;
    const maxInterval = config.maxIntervalSec ?? 3.0;
    const maxDrift = config.maxDriftTolerance ?? 0.05;
    const wKappa = config.curvatureWeight ?? 1.5;
    const wOmega = config.angularRateWeight ?? 1.2;
    const wVel = config.velocityWeight ?? 0.4;

    const dt = dur / Math.max(1, N - 1);

    // 1. Compute kinematic motion profiles & saliency across all frames
    const velocities: number[] = new Array(N).fill(0);
    const curvatures: number[] = new Array(N).fill(0);
    const angularRates: number[] = new Array(N).fill(0);
    const saliencies: number[] = new Array(N).fill(1.0);

    for (let i = 1; i < N - 1; i++) {
      const prev = frames[i - 1];
      const curr = frames[i];
      const next = frames[i + 1];

      // Velocity: v = (next - prev) / (2 * dt)
      const vx = (next.position[0] - prev.position[0]) / (2 * dt);
      const vy = (next.position[1] - prev.position[1]) / (2 * dt);
      const vz = (next.position[2] - prev.position[2]) / (2 * dt);
      const vMag = Math.hypot(vx, vy, vz) || 1e-4;
      velocities[i] = vMag;

      // Acceleration: a = (next - 2*curr + prev) / dt^2
      const ax = (next.position[0] - 2 * curr.position[0] + prev.position[0]) / (dt * dt);
      const ay = (next.position[1] - 2 * curr.position[1] + prev.position[1]) / (dt * dt);
      const az = (next.position[2] - 2 * curr.position[2] + prev.position[2]) / (dt * dt);

      // Frenet-Serret Curvature: kappa = |v x a| / |v|^3
      const crossX = vy * az - vz * ay;
      const crossY = vz * ax - vx * az;
      const crossZ = vx * ay - vy * ax;
      const crossMag = Math.hypot(crossX, crossY, crossZ);
      const kappa = crossMag / Math.pow(vMag, 3);
      curvatures[i] = Math.min(kappa, 15.0); // bound numerical spikes

      // Angular Look-At rate
      const d1x = curr.target[0] - curr.position[0];
      const d1y = curr.target[1] - curr.position[1];
      const d1z = curr.target[2] - curr.position[2];
      const len1 = Math.hypot(d1x, d1y, d1z) || 1e-4;

      const d2x = next.target[0] - next.position[0];
      const d2y = next.target[1] - next.position[1];
      const d2z = next.target[2] - next.position[2];
      const len2 = Math.hypot(d2x, d2y, d2z) || 1e-4;

      const dot = Math.max(-1, Math.min(1, (d1x * d2x + d1y * d2y + d1z * d2z) / (len1 * len2)));
      const angularDelta = Math.acos(dot);
      angularRates[i] = angularDelta / dt;
    }

    // Velocity scale-invariance: normalize by average velocity
    const vSum = velocities.reduce((a, b) => a + b, 0);
    const vMean = vSum / Math.max(1, N);
    const vNorm = vMean > 1e-4 ? 1.0 / vMean : 1.0;

    for (let i = 1; i < N - 1; i++) {
      const vNormalized = velocities[i] * vNorm;
      saliencies[i] = 1.0 + wVel * vNormalized + wKappa * curvatures[i] + wOmega * angularRates[i];
    }
    velocities[0] = velocities[1];
    velocities[N - 1] = velocities[N - 2];
    curvatures[0] = curvatures[1];
    curvatures[N - 1] = curvatures[N - 2];
    angularRates[0] = angularRates[1];
    angularRates[N - 1] = angularRates[N - 2];
    saliencies[0] = saliencies[1];
    saliencies[N - 1] = saliencies[N - 2];

    const saliencyProfile = frames.map((f, i) => ({
      index: i,
      timeSec: Number(f.timeSec.toFixed(4)),
      curvature: Number(curvatures[i].toFixed(4)),
      angularRate: Number(angularRates[i].toFixed(4)),
      velocity: Number(velocities[i].toFixed(3)),
      saliency: Number(saliencies[i].toFixed(3))
    }));

    // 2. Select Keyframes based on Mode
    let selectedIndices: number[];

    if (mode === 'error_bisection') {
      selectedIndices = this.recursiveErrorBisection(
        frames,
        saliencies,
        maxDrift,
        minInterval,
        maxInterval
      );
    } else if (mode === 'cumulative_saliency') {
      const targetCount = config.targetKeyframeCount ?? 25;
      selectedIndices = this.partitionCumulativeSaliency(
        frames,
        saliencies,
        targetCount,
        minInterval,
        dt
      );
    } else {
      // Hybrid mode: runs error bisection first, then caps or supplements to reach target count
      const bisection = this.recursiveErrorBisection(frames, saliencies, maxDrift, minInterval, maxInterval);
      const targetCount = config.targetKeyframeCount ?? 25;
      if (bisection.length >= targetCount) {
        selectedIndices = bisection;
      } else {
        const saliencySet = this.partitionCumulativeSaliency(frames, saliencies, targetCount, minInterval, dt);
        const merged = Array.from(new Set([...bisection, ...saliencySet])).sort((a, b) => a - b);
        selectedIndices = merged;
      }
    }

    // 3. Strictly Enforce Boundary Conditions: Pin First (0) and Last (N-1)
    if (!selectedIndices.includes(0)) {
      selectedIndices.unshift(0);
    }
    if (!selectedIndices.includes(N - 1)) {
      selectedIndices.push(N - 1);
    }
    selectedIndices.sort((a, b) => a - b);

    // 4. Evaluate Interpolation Residuals & Drift Metrics across full sequence
    const { maxDriftActual, meanDriftActual } = this.evaluateTrajectoryInterpolationDrift(
      frames,
      selectedIndices
    );

    // 5. Measure Motion Contrast Ratio (Keyframe Density in Top 30% Saliency vs Bottom 30%)
    const sortedSaliency = [...saliencies].sort((a, b) => a - b);
    const hiThresh = sortedSaliency[Math.floor(N * 0.70)];
    const loThresh = sortedSaliency[Math.floor(N * 0.30)];

    let hiFrames = 0, hiKeys = 0;
    let loFrames = 0, loKeys = 0;
    const keySet = new Set(selectedIndices);

    for (let i = 0; i < N; i++) {
      if (saliencies[i] >= hiThresh) {
        hiFrames++;
        if (keySet.has(i)) hiKeys++;
      } else if (saliencies[i] <= loThresh) {
        loFrames++;
        if (keySet.has(i)) loKeys++;
      }
    }
    const hiDensity = hiFrames > 0 ? hiKeys / hiFrames : 1.0;
    const loDensity = loFrames > 0 ? loKeys / loFrames : 0.1;
    const motionContrastRatio = Number((hiDensity / Math.max(0.01, loDensity)).toFixed(2));

    const selectedKeyframes: SelectedKeyframeAnchor[] = selectedIndices.map(idx => {
      const f = frames[idx];
      return {
        index: idx,
        frameNumber: idx + 1,
        timeSec: Number(f.timeSec.toFixed(4)),
        position: [...f.position],
        target: [...f.target],
        motionSaliency: Number(saliencies[idx].toFixed(3)),
        curvature: Number(curvatures[idx].toFixed(4)),
        angularRate: Number(angularRates[idx].toFixed(4)),
        velocity: Number(velocities[idx].toFixed(3))
      };
    });

    return {
      selectedIndices,
      selectedKeyframes,
      saliencyProfile,
      maxInterpolationDrift: Number(maxDriftActual.toFixed(4)),
      meanInterpolationDrift: Number(meanDriftActual.toFixed(4)),
      compressionRatio: Number((N / selectedIndices.length).toFixed(2)),
      totalKeyframes: selectedIndices.length,
      totalFrames: N,
      mode,
      motionContrastRatio
    };
  }

  /**
   * Mode A: Recursive Error-Bisection (Douglas-Peucker with Spline Tolerance)
   * Recursively bisects segments at the peak interpolation error until drift <= maxDrift.
   */
  private static recursiveErrorBisection(
    frames: TrajectoryInputPoint[],
    saliencies: number[],
    maxDrift: number,
    minIntervalSec: number,
    maxIntervalSec: number
  ): number[] {
    const N = frames.length;
    const selected = new Set<number>([0, N - 1]);

    const bisectSegment = (startIdx: number, endIdx: number) => {
      if (endIdx - startIdx <= 1) return;

      const tStart = frames[startIdx].timeSec;
      const tEnd = frames[endIdx].timeSec;
      const segDuration = tEnd - tStart;

      let maxRawError = -1;
      let maxWeightedError = -1;
      let bestValidIdx = -1;

      for (let i = startIdx + 1; i < endIdx; i++) {
        const t = frames[i].timeSec;
        const alpha = (t - tStart) / (segDuration || 1e-4);

        // Linear chord interpolation between anchors
        const p0 = frames[startIdx].position;
        const p1 = frames[endIdx].position;
        const interpX = p0[0] + alpha * (p1[0] - p0[0]);
        const interpY = p0[1] + alpha * (p1[1] - p0[1]);
        const interpZ = p0[2] + alpha * (p1[2] - p0[2]);

        const actual = frames[i].position;
        const posError = Math.hypot(actual[0] - interpX, actual[1] - interpY, actual[2] - interpZ);

        if (posError > maxRawError) {
          maxRawError = posError;
        }

        const saliencyBoost = 1.0 + 0.3 * Math.max(0, saliencies[i] - 1.0);
        const weightedError = posError * saliencyBoost;

        const satisfiesMinInterval =
          (t - tStart >= minIntervalSec - 1e-4) &&
          (tEnd - t >= minIntervalSec - 1e-4);

        if (satisfiesMinInterval && weightedError > maxWeightedError) {
          maxWeightedError = weightedError;
          bestValidIdx = i;
        }
      }

      // Compute segment average saliency
      let segSaliencySum = 0;
      for (let i = startIdx; i <= endIdx; i++) {
        segSaliencySum += saliencies[i];
      }
      const avgSaliency = segSaliencySum / Math.max(1, endIdx - startIdx + 1);

      // Dynamic maximum interval: inversely proportional to motion saliency.
      // High motion forces dense keyframes; low motion allows sparse intervals.
      const effectiveMaxInterval = Math.max(
        minIntervalSec * 1.5,
        maxIntervalSec / (1.0 + 0.8 * Math.max(0, avgSaliency - 1.0))
      );

      // Determine split index: prefer bestValidIdx, fallback to candidate with highest saliency / midpoint
      let splitIdx = bestValidIdx;
      if (splitIdx === -1 && (maxRawError > maxDrift || segDuration > effectiveMaxInterval)) {
        let maxSal = -1;
        let bestSalIdx = -1;
        for (let i = startIdx + 1; i < endIdx; i++) {
          const t = frames[i].timeSec;
          if ((t - tStart >= minIntervalSec - 1e-4) && (tEnd - t >= minIntervalSec - 1e-4)) {
            if (saliencies[i] > maxSal) {
              maxSal = saliencies[i];
              bestSalIdx = i;
            }
          }
        }
        if (bestSalIdx !== -1) {
          splitIdx = bestSalIdx;
        } else if (endIdx - startIdx >= 2) {
          splitIdx = Math.floor((startIdx + endIdx) / 2);
        }
      }

      const shouldSplit = (maxRawError > maxDrift || maxWeightedError > maxDrift || segDuration > effectiveMaxInterval);

      if (shouldSplit && splitIdx !== -1 && splitIdx !== startIdx && splitIdx !== endIdx) {
        selected.add(splitIdx);
        bisectSegment(startIdx, splitIdx);
        bisectSegment(splitIdx, endIdx);
      }
    };

    bisectSegment(0, N - 1);
    return Array.from(selected).sort((a, b) => a - b);
  }

  /**
   * Mode B: Cumulative Motion Saliency Integration
   * Partitions total motion energy into equal quanta, placing keyframes at equal saliency intervals.
   */
  private static partitionCumulativeSaliency(
    frames: TrajectoryInputPoint[],
    saliencies: number[],
    targetCount: number,
    minIntervalSec: number,
    dt: number
  ): number[] {
    const N = frames.length;
    const cum = new Float64Array(N);
    cum[0] = 0;
    for (let i = 1; i < N; i++) {
      cum[i] = cum[i - 1] + (saliencies[i - 1] + saliencies[i]) * 0.5 * dt;
    }
    const totalSaliency = cum[N - 1];

    const selected: number[] = [0];
    const segmentSaliency = totalSaliency / Math.max(1, targetCount - 1);

    let lastIdx = 0;
    for (let k = 1; k < targetCount - 1; k++) {
      const targetS = k * segmentSaliency;
      let bestIdx = lastIdx + 1;
      let minDiff = Infinity;

      for (let j = lastIdx + 1; j < N - 1; j++) {
        const diff = Math.abs(cum[j] - targetS);
        if (diff < minDiff) {
          minDiff = diff;
          bestIdx = j;
        }
      }

      const prevTime = frames[selected[selected.length - 1]].timeSec;
      const proposedTime = frames[bestIdx].timeSec;
      if (proposedTime - prevTime >= minIntervalSec) {
        selected.push(bestIdx);
        lastIdx = bestIdx;
      }
    }

    if (!selected.includes(N - 1)) {
      selected.push(N - 1);
    }
    return selected;
  }

  /**
   * Evaluates the interpolation drift of the selected keyframe set against all ground-truth frames.
   */
  private static evaluateTrajectoryInterpolationDrift(
    frames: TrajectoryInputPoint[],
    keyframeIndices: number[]
  ): { maxDriftActual: number; meanDriftActual: number } {
    let maxDrift = 0;
    let sumDrift = 0;
    let count = 0;

    for (let k = 0; k < keyframeIndices.length - 1; k++) {
      const idxA = keyframeIndices[k];
      const idxB = keyframeIndices[k + 1];
      const fA = frames[idxA];
      const fB = frames[idxB];
      const tA = fA.timeSec;
      const tB = fB.timeSec;
      const span = tB - tA;

      for (let i = idxA; i <= idxB; i++) {
        const t = frames[i].timeSec;
        const alpha = span > 1e-4 ? (t - tA) / span : 0.0;

        const estX = fA.position[0] + alpha * (fB.position[0] - fA.position[0]);
        const estY = fA.position[1] + alpha * (fB.position[1] - fA.position[1]);
        const estZ = fA.position[2] + alpha * (fB.position[2] - fA.position[2]);

        const actual = frames[i].position;
        const dist = Math.hypot(actual[0] - estX, actual[1] - estY, actual[2] - estZ);

        if (dist > maxDrift) maxDrift = dist;
        sumDrift += dist;
        count++;
      }
    }

    return {
      maxDriftActual: maxDrift,
      meanDriftActual: count > 0 ? sumDrift / count : 0
    };
  }

  /**
   * Optimizes keyframe density from 2D optical flow or feature track pixel displacements.
   */
  public static optimizeFromMotionProfile(
    frameDisplacements: number[],
    durationSec: number,
    config: MotionAdaptiveConfig = {}
  ): KeyframeSelectionResult {
    const N = frameDisplacements.length;
    const dt = durationSec / Math.max(1, N - 1);

    // Synthesize 2D pseudo-trajectory from displacement:
    // Large displacements induce both linear translation and camera heading rotation,
    // naturally creating 2D spatial curvature and sagitta drift for error bisection.
    const pseudoFrames: TrajectoryInputPoint[] = [];
    let angle = 0;
    let posX = 0;
    let posY = 0;
    const meanDisp = frameDisplacements.reduce((a, b) => a + b, 0) / Math.max(1, N);
    const angularScale = meanDisp > 0 ? 0.05 / meanDisp : 0.02;

    for (let i = 0; i < N; i++) {
      const disp = frameDisplacements[i];
      angle += disp * angularScale;
      posX += Math.cos(angle) * disp;
      posY += Math.sin(angle) * disp;
      pseudoFrames.push({
        timeSec: Number((i * dt).toFixed(4)),
        position: [posX, posY, 0],
        target: [posX + Math.cos(angle) * 10, posY + Math.sin(angle) * 10, 0]
      });
    }

    return this.optimizeFromTrajectory(pseudoFrames, durationSec, config);
  }
}
