/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import type { Vector3Tuple } from '../../node/spatial/ProceduralSfMDatasetService';
import type { VideoDiffusionCameraBlockout } from './universal-3d-structure-types';
import type { CameraSolveTrack, CameraSolveFrame } from '../vfx-plate-protocol';

/**
 * Supported animation property targets across 3D, VFX, and NLE tracks.
 */
export type UniversalAnimationProperty =
  | 'translation'
  | 'rotation'
  | 'scale'
  | 'fov'
  | 'focalLength'
  | 'focusDistance'
  | 'weight'       // Blendshape / morph target weight [0, 1]
  | 'opacity'
  | 'color'
  | 'custom';

/**
 * Standard interpolation models matching glTF 2.0 and NLE curves.
 */
export type UniversalInterpolationType =
  | 'linear'
  | 'step'
  | 'slerp'
  | 'cubicspline'
  | 'cubicBezier';

/**
 * Universal Keyframe with timestamp in continuous seconds and typed value.
 */
export interface UniversalKeyframe<T = any> {
  timeSeconds: number;
  value: T;
  interpolation?: UniversalInterpolationType;
  inTangent?: T;
  outTangent?: T;
  controlPoints?: [number, number, number, number]; // [x1, y1, x2, y2] for cubic bezier
}

/**
 * Single animated channel driving a specific node property.
 */
export interface UniversalAnimationTrack<T = any> {
  id: string;
  name: string;
  targetNodeId?: string; // Target mesh, camera, or skeletal bone identifier
  property: UniversalAnimationProperty;
  interpolation: UniversalInterpolationType;
  keyframes: UniversalKeyframe<T>[];
  channelIndex?: number;
}

/**
 * Complete reusable animation clip containing multiple synchronized tracks.
 */
export interface UniversalAnimationClip {
  id: string;
  name: string;
  durationSeconds: number;
  fps: number;
  tracks: UniversalAnimationTrack[];
  isLooping?: boolean;
}

/**
 * Universal Temporal Timeline coordinating multiple tracks across 3D viewports and NLE.
 */
export interface UniversalAnimationTimeline {
  id: string;
  durationSeconds: number;
  fps: number;
  currentTimeSeconds: number;
  isPlaying: boolean;
  clips: UniversalAnimationClip[];
}

/**
 * Linear interpolation between two scalar numbers.
 */
export function lerpScalar(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Linear interpolation between two 3D vectors.
 */
export function lerpVector3(a: Vector3Tuple, b: Vector3Tuple, t: number): Vector3Tuple {
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t
  ];
}

/**
 * Spherical Linear Interpolation (SLERP) for unit quaternions [x, y, z, w].
 */
export function slerpQuaternion(
  q1: [number, number, number, number],
  q2: [number, number, number, number],
  t: number
): [number, number, number, number] {
  let cosHalfTheta = q1[0] * q2[0] + q1[1] * q2[1] + q1[2] * q2[2] + q1[3] * q2[3];

  let targetQ = q2;
  if (cosHalfTheta < 0) {
    targetQ = [-q2[0], -q2[1], -q2[2], -q2[3]];
    cosHalfTheta = -cosHalfTheta;
  }

  if (Math.abs(cosHalfTheta) >= 1.0) {
    return [q1[0], q1[1], q1[2], q1[3]];
  }

  const halfTheta = Math.acos(Math.min(1.0, Math.max(-1.0, cosHalfTheta)));
  const sinHalfTheta = Math.sqrt(1.0 - cosHalfTheta * cosHalfTheta);

  if (Math.abs(sinHalfTheta) < 0.001) {
    return [
      q1[0] * 0.5 + targetQ[0] * 0.5,
      q1[1] * 0.5 + targetQ[1] * 0.5,
      q1[2] * 0.5 + targetQ[2] * 0.5,
      q1[3] * 0.5 + targetQ[3] * 0.5
    ];
  }

  const ratioA = Math.sin((1 - t) * halfTheta) / sinHalfTheta;
  const ratioB = Math.sin(t * halfTheta) / sinHalfTheta;

  return [
    q1[0] * ratioA + targetQ[0] * ratioB,
    q1[1] * ratioA + targetQ[1] * ratioB,
    q1[2] * ratioA + targetQ[2] * ratioB,
    q1[3] * ratioA + targetQ[3] * ratioB
  ];
}

/**
 * Evaluates a single animation track at continuous time `timeSeconds`.
 */
export function evaluateAnimationTrack<T = any>(
  track: UniversalAnimationTrack<T>,
  timeSeconds: number
): T | undefined {
  const kfs = track.keyframes;
  if (!kfs || kfs.length === 0) return undefined;
  if (kfs.length === 1 || timeSeconds <= kfs[0].timeSeconds) {
    return kfs[0].value;
  }
  if (timeSeconds >= kfs[kfs.length - 1].timeSeconds) {
    return kfs[kfs.length - 1].value;
  }

  // Binary search or linear scan for the bounding interval [k0, k1]
  let idx = 0;
  while (idx < kfs.length - 1 && kfs[idx + 1].timeSeconds < timeSeconds) {
    idx++;
  }

  const k0 = kfs[idx];
  const k1 = kfs[idx + 1];
  const dt = k1.timeSeconds - k0.timeSeconds;
  const t = dt <= 1e-6 ? 0 : (timeSeconds - k0.timeSeconds) / dt;

  const interp = k0.interpolation || track.interpolation || 'linear';

  if (interp === 'step') {
    return k0.value;
  }

  if (track.property === 'rotation' || interp === 'slerp') {
    const q0 = k0.value as unknown as [number, number, number, number];
    const q1 = k1.value as unknown as [number, number, number, number];
    if (Array.isArray(q0) && q0.length === 4 && Array.isArray(q1) && q1.length === 4) {
      return slerpQuaternion(q0, q1, t) as unknown as T;
    }
  }

  if (typeof k0.value === 'number' && typeof k1.value === 'number') {
    return lerpScalar(k0.value, k1.value, t) as unknown as T;
  }

  if (Array.isArray(k0.value) && Array.isArray(k1.value) && k0.value.length === 3) {
    return lerpVector3(
      k0.value as unknown as Vector3Tuple,
      k1.value as unknown as Vector3Tuple,
      t
    ) as unknown as T;
  }

  return k0.value;
}

/**
 * Evaluates all tracks within an animation clip at time `timeSeconds`.
 * Returns a map of `targetNodeId.property` -> evaluated value.
 */
export function evaluateAnimationClip(
  clip: UniversalAnimationClip,
  timeSeconds: number
): Map<string, any> {
  const result = new Map<string, any>();
  const effectiveTime = clip.isLooping && clip.durationSeconds > 0
    ? timeSeconds % clip.durationSeconds
    : Math.max(0, Math.min(timeSeconds, clip.durationSeconds));

  for (const track of clip.tracks) {
    const val = evaluateAnimationTrack(track, effectiveTime);
    if (val !== undefined) {
      const key = `${track.targetNodeId || 'root'}.${track.property}`;
      result.set(key, val);
    }
  }

  return result;
}

/**
 * Converts a UniversalAnimationClip into a standard VFX Plate CameraSolveTrack.
 */
export function toCameraSolveTrack(
  clip: UniversalAnimationClip,
  options?: { id?: string; name?: string; fps?: number }
): CameraSolveTrack {
  const fps = options?.fps || clip.fps || 24;
  const totalFrames = Math.max(1, Math.round(clip.durationSeconds * fps));
  const frames: CameraSolveFrame[] = [];

  const transTrack = clip.tracks.find(t => t.property === 'translation');
  const rotTrack = clip.tracks.find(t => t.property === 'rotation');
  const fovTrack = clip.tracks.find(t => t.property === 'fov');
  const focalTrack = clip.tracks.find(t => t.property === 'focalLength');

  for (let f = 0; f < totalFrames; f++) {
    const timeSec = f / fps;
    const pos = transTrack
      ? (evaluateAnimationTrack(transTrack, timeSec) as Vector3Tuple)
      : [0, 0, 0];
    const rotVal = rotTrack ? evaluateAnimationTrack(rotTrack, timeSec) : undefined;
    const rot: [number, number, number, number] = (Array.isArray(rotVal) && rotVal.length === 4)
      ? [rotVal[0], rotVal[1], rotVal[2], rotVal[3]]
      : [0, 0, 0, 1];
    const fov = fovTrack
      ? (evaluateAnimationTrack(fovTrack, timeSec) as number)
      : 45.0;
    const focalLengthMm = focalTrack
      ? (evaluateAnimationTrack(focalTrack, timeSec) as number)
      : undefined;

    frames.push({
      frameNumber: f,
      timeSeconds: timeSec,
      position: [pos[0], pos[1], pos[2]],
      rotationQuaternion: rot,
      fovDegrees: fov,
      focalLengthMm
    });
  }

  return {
    id: options?.id || `solve-${clip.id}`,
    name: options?.name || clip.name,
    coordinateSystem: 'threejs',
    fps,
    totalFrames,
    durationSeconds: clip.durationSeconds,
    isSolved: true,
    sourceSoftware: 'Scratchbox Universal Animation Engine',
    frames
  };
}

/**
 * Ingests a CameraSolveTrack into a standard UniversalAnimationClip.
 */
export function fromCameraSolveTrack(solveTrack: CameraSolveTrack): UniversalAnimationClip {
  const transKfs: UniversalKeyframe<Vector3Tuple>[] = [];
  const rotKfs: UniversalKeyframe<[number, number, number, number]>[] = [];
  const fovKfs: UniversalKeyframe<number>[] = [];

  for (const frame of solveTrack.frames) {
    transKfs.push({
      timeSeconds: frame.timeSeconds,
      value: [frame.position[0], frame.position[1], frame.position[2]],
      interpolation: 'linear'
    });
    rotKfs.push({
      timeSeconds: frame.timeSeconds,
      value: frame.rotationQuaternion,
      interpolation: 'slerp'
    });
    fovKfs.push({
      timeSeconds: frame.timeSeconds,
      value: frame.fovDegrees,
      interpolation: 'linear'
    });
  }

  const tracks: UniversalAnimationTrack[] = [
    {
      id: `${solveTrack.id}-translation`,
      name: 'Camera Position',
      targetNodeId: 'camera',
      property: 'translation',
      interpolation: 'linear',
      keyframes: transKfs
    },
    {
      id: `${solveTrack.id}-rotation`,
      name: 'Camera Rotation',
      targetNodeId: 'camera',
      property: 'rotation',
      interpolation: 'slerp',
      keyframes: rotKfs
    },
    {
      id: `${solveTrack.id}-fov`,
      name: 'Camera FOV',
      targetNodeId: 'camera',
      property: 'fov',
      interpolation: 'linear',
      keyframes: fovKfs
    }
  ];

  return {
    id: `clip-${solveTrack.id}`,
    name: solveTrack.name || 'Camera Solve Motion',
    durationSeconds: solveTrack.durationSeconds || (solveTrack.frames.length > 0 ? solveTrack.frames[solveTrack.frames.length - 1].timeSeconds : 1.0),
    fps: solveTrack.fps || 24,
    tracks
  };
}

/**
 * Converts a VideoDiffusionCameraBlockout (<VIDEO_REF_0>) into a UniversalAnimationClip.
 */
export function fromVideoDiffusionCameraBlockout(
  blockout: VideoDiffusionCameraBlockout,
  name?: string
): UniversalAnimationClip {
  const transKfs: UniversalKeyframe<Vector3Tuple>[] = [];
  const fovKfs: UniversalKeyframe<number>[] = [];

  for (const f of blockout.frames) {
    transKfs.push({
      timeSeconds: f.timestampSeconds,
      value: [f.position[0], f.position[1], f.position[2]],
      interpolation: 'linear'
    });
    fovKfs.push({
      timeSeconds: f.timestampSeconds,
      value: f.fovDegrees,
      interpolation: 'linear'
    });
  }

  const tracks: UniversalAnimationTrack[] = [
    {
      id: `blockout-trans`,
      name: 'Blockout Flight Path',
      targetNodeId: 'camera',
      property: 'translation',
      interpolation: 'linear',
      keyframes: transKfs
    },
    {
      id: `blockout-fov`,
      name: 'Blockout FOV',
      targetNodeId: 'camera',
      property: 'fov',
      interpolation: 'linear',
      keyframes: fovKfs
    }
  ];

  return {
    id: `clip-video-blockout`,
    name: name || `AI Camera Flight (${blockout.trajectoryType})`,
    durationSeconds: blockout.durationSeconds,
    fps: blockout.fps,
    tracks
  };
}

/**
 * Adapts a UniversalAnimationClip into a TimelineElement configuration for NLE tracks.
 */
export function toTimelineElement(
  clip: UniversalAnimationClip,
  options?: {
    id?: string;
    startTime?: number;
    trackId?: string;
    assetPath?: string;
  }
): {
  id: string;
  trackId: string;
  name: string;
  type: '3d';
  startTime: number;
  duration: number;
  inPoint: number;
  outPoint: number;
  assetPath: string;
  animationClipName: string;
  keyframes: Record<string, Array<{
    id: string;
    time: number;
    value: number;
    vector?: number[];
    easing?: any;
  }>>;
} {
  const startTime = options?.startTime ?? 0;
  const keyframes: Record<string, Array<{
    id: string;
    time: number;
    value: number;
    vector?: number[];
    easing?: any;
  }>> = {};

  for (const track of clip.tracks) {
    const propKey = `${track.targetNodeId || 'root'}.${track.property}`;
    keyframes[propKey] = track.keyframes.map((kf, k) => ({
      id: `${track.id}-kf-${k}`,
      time: kf.timeSeconds,
      value: typeof kf.value === 'number' ? kf.value : 0,
      vector: Array.isArray(kf.value) ? (kf.value as number[]) : undefined,
      easing: track.interpolation === 'step' ? 'stepped' : 'linear'
    }));
  }

  return {
    id: options?.id || `elem-3d-${clip.id}`,
    trackId: options?.trackId || 'track-3d-0',
    name: clip.name,
    type: '3d',
    startTime,
    duration: clip.durationSeconds,
    inPoint: 0,
    outPoint: clip.durationSeconds,
    assetPath: options?.assetPath || '',
    animationClipName: clip.name,
    keyframes
  };
}
