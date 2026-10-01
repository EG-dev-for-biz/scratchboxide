/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import {
  lerpScalar,
  lerpVector3,
  slerpQuaternion,
  evaluateAnimationTrack,
  evaluateAnimationClip,
  toCameraSolveTrack,
  fromCameraSolveTrack,
  fromVideoDiffusionCameraBlockout,
  toTimelineElement,
  UniversalAnimationClip,
  UniversalAnimationTrack
} from '../src/common/spatial/universal-animation-types';
import { Universal3DStructureFoundation } from '../src/node/spatial/Universal3DStructureFoundation';
import type { VideoDiffusionCameraBlockout } from '../src/common/spatial/universal-3d-structure-types';
import type { CameraSolveTrack } from '../src/common/vfx-plate-protocol';

describe('Universal Animation Engine & Temporal Interpolation', () => {
  describe('Mathematical Evaluators', () => {
    it('accurately performs scalar linear interpolation', () => {
      expect(lerpScalar(10, 20, 0.0)).toBe(10);
      expect(lerpScalar(10, 20, 0.5)).toBe(15);
      expect(lerpScalar(10, 20, 1.0)).toBe(20);
    });

    it('accurately performs 3D vector linear interpolation', () => {
      const v1: [number, number, number] = [0, 10, 20];
      const v2: [number, number, number] = [10, 20, 30];
      const mid = lerpVector3(v1, v2, 0.5);
      expect(mid[0]).toBeCloseTo(5);
      expect(mid[1]).toBeCloseTo(15);
      expect(mid[2]).toBeCloseTo(25);
    });

    it('accurately performs Spherical Linear Interpolation (SLERP) on unit quaternions', () => {
      // 90-degree rotation around Y axis
      // q1 = identity [0, 0, 0, 1]
      // q2 = 90 deg around Y -> [0, sin(45°), 0, cos(45°)] = [0, 0.707106, 0, 0.707106]
      const q1: [number, number, number, number] = [0, 0, 0, 1];
      const q2: [number, number, number, number] = [0, Math.SQRT1_2, 0, Math.SQRT1_2];

      const half = slerpQuaternion(q1, q2, 0.5);
      // 45 deg around Y -> [0, sin(22.5°), 0, cos(22.5°)]
      const expectedY = Math.sin(Math.PI / 8);
      const expectedW = Math.cos(Math.PI / 8);
      expect(half[0]).toBeCloseTo(0);
      expect(half[1]).toBeCloseTo(expectedY, 4);
      expect(half[2]).toBeCloseTo(0);
      expect(half[3]).toBeCloseTo(expectedW, 4);
    });
  });

  describe('Track & Clip Evaluation', () => {
    const translationTrack: UniversalAnimationTrack = {
      id: 'track-cam-pos',
      name: 'Camera Position',
      targetNodeId: 'camera',
      property: 'translation',
      interpolation: 'linear',
      keyframes: [
        { timeSeconds: 0.0, value: [0, 5, 10] },
        { timeSeconds: 2.0, value: [10, 5, 0] },
        { timeSeconds: 4.0, value: [20, 10, -10] }
      ]
    };

    const rotationTrack: UniversalAnimationTrack = {
      id: 'track-cam-rot',
      name: 'Camera Rotation',
      targetNodeId: 'camera',
      property: 'rotation',
      interpolation: 'slerp',
      keyframes: [
        { timeSeconds: 0.0, value: [0, 0, 0, 1] },
        { timeSeconds: 2.0, value: [0, Math.SQRT1_2, 0, Math.SQRT1_2] }
      ]
    };

    const clip: UniversalAnimationClip = {
      id: 'clip-orbit-01',
      name: 'Hero Camera Arc',
      durationSeconds: 4.0,
      fps: 24,
      tracks: [translationTrack, rotationTrack]
    };

    it('evaluates translation track at sub-frame continuous timestamps', () => {
      // Clamped before start
      const tPre = evaluateAnimationTrack(translationTrack, -1.0);
      expect(tPre).toEqual([0, 5, 10]);

      // Exactly at keyframe 0
      const t0 = evaluateAnimationTrack(translationTrack, 0.0);
      expect(t0).toEqual([0, 5, 10]);

      // Midpoint between kf0 and kf1 (t = 1.0s, halfway through 0s..2s)
      const t1 = evaluateAnimationTrack(translationTrack, 1.0);
      expect(t1![0]).toBeCloseTo(5);
      expect(t1![1]).toBeCloseTo(5);
      expect(t1![2]).toBeCloseTo(5);

      // Clamped after end
      const tPost = evaluateAnimationTrack(translationTrack, 10.0);
      expect(tPost).toEqual([20, 10, -10]);
    });

    it('evaluates complete clip containing synchronized channels', () => {
      const stateAt1s = evaluateAnimationClip(clip, 1.0);
      expect(stateAt1s.has('camera.translation')).toBe(true);
      expect(stateAt1s.has('camera.rotation')).toBe(true);

      const pos = stateAt1s.get('camera.translation');
      expect(pos[0]).toBeCloseTo(5);

      const rot = stateAt1s.get('camera.rotation');
      expect(rot[1]).toBeCloseTo(Math.sin(Math.PI / 8), 4);
    });
  });

  describe('Bidirectional Adapters', () => {
    it('converts UniversalAnimationClip to standard CameraSolveTrack', () => {
      const clip: UniversalAnimationClip = {
        id: 'clip-solve-test',
        name: 'VFX Solve Test',
        durationSeconds: 1.0,
        fps: 24,
        tracks: [
          {
            id: 't-pos',
            name: 'Position',
            targetNodeId: 'camera',
            property: 'translation',
            interpolation: 'linear',
            keyframes: [
              { timeSeconds: 0.0, value: [0, 2, 5] },
              { timeSeconds: 1.0, value: [5, 2, 0] }
            ]
          },
          {
            id: 't-fov',
            name: 'FOV',
            targetNodeId: 'camera',
            property: 'fov',
            interpolation: 'linear',
            keyframes: [
              { timeSeconds: 0.0, value: 45.0 },
              { timeSeconds: 1.0, value: 60.0 }
            ]
          }
        ]
      };

      const solveTrack = toCameraSolveTrack(clip);
      expect(solveTrack.fps).toBe(24);
      expect(solveTrack.totalFrames).toBe(24);
      expect(solveTrack.frames.length).toBe(24);
      expect(solveTrack.frames[0].position).toEqual([0, 2, 5]);
      expect(solveTrack.frames[0].fovDegrees).toBe(45.0);
      expect(solveTrack.isSolved).toBe(true);
    });

    it('ingests CameraSolveTrack back into UniversalAnimationClip', () => {
      const solveTrack: CameraSolveTrack = {
        id: 'solve-incoming',
        name: 'Matchmove Solver',
        coordinateSystem: 'threejs',
        fps: 30,
        totalFrames: 3,
        durationSeconds: 0.1,
        isSolved: true,
        sourceSoftware: 'Syntheyes',
        frames: [
          { frameNumber: 0, timeSeconds: 0.0, position: [1, 2, 3], rotationQuaternion: [0, 0, 0, 1], fovDegrees: 50 },
          { frameNumber: 1, timeSeconds: 0.033, position: [1.1, 2.1, 3.1], rotationQuaternion: [0, 0.1, 0, 0.99], fovDegrees: 50 },
          { frameNumber: 2, timeSeconds: 0.066, position: [1.2, 2.2, 3.2], rotationQuaternion: [0, 0.2, 0, 0.98], fovDegrees: 50 }
        ]
      };

      const clip = fromCameraSolveTrack(solveTrack);
      expect(clip.id).toBe('clip-solve-incoming');
      expect(clip.tracks.length).toBe(3);
      expect(clip.tracks[0].property).toBe('translation');
      expect(clip.tracks[1].property).toBe('rotation');
      expect(clip.tracks[2].property).toBe('fov');
      expect(clip.tracks[0].keyframes.length).toBe(3);
    });

    it('converts VideoDiffusionCameraBlockout to UniversalAnimationClip', () => {
      const blockout: VideoDiffusionCameraBlockout = {
        videoRef: '<VIDEO_REF_0>',
        trajectoryType: 'cinematic_arc',
        fps: 24,
        durationSeconds: 2.0,
        frames: [
          { frameIndex: 0, timestampSeconds: 0.0, position: [0, 10, 20], lookAt: [0, 0, 0], fovDegrees: 45 },
          { frameIndex: 1, timestampSeconds: 2.0, position: [20, 10, 0], lookAt: [0, 0, 0], fovDegrees: 45 }
        ]
      };

      const clip = fromVideoDiffusionCameraBlockout(blockout);
      expect(clip.name).toContain('cinematic_arc');
      expect(clip.durationSeconds).toBe(2.0);
      expect(clip.tracks.length).toBe(2);
      expect(clip.tracks[0].property).toBe('translation');
    });

    it('adapts UniversalAnimationClip to NLE TimelineElement with keyframe markers', () => {
      const clip: UniversalAnimationClip = {
        id: 'clip-nle',
        name: 'Shot 01 3D Orbit',
        durationSeconds: 3.5,
        fps: 24,
        tracks: [
          {
            id: 'tr-pos',
            name: 'Position',
            targetNodeId: 'hero_car',
            property: 'translation',
            interpolation: 'linear',
            keyframes: [
              { timeSeconds: 0.0, value: [0, 0, 0] },
              { timeSeconds: 1.5, value: [10, 0, 0] },
              { timeSeconds: 3.5, value: [30, 0, 0] }
            ]
          }
        ]
      };

      const element = toTimelineElement(clip, { startTime: 2.0 });
      expect(element.type).toBe('3d');
      expect(element.startTime).toBe(2.0);
      expect(element.duration).toBe(3.5);
      expect(element.animationClipName).toBe('Shot 01 3D Orbit');
      expect(element.keyframes['hero_car.translation']).toBeDefined();
      expect(element.keyframes['hero_car.translation'].length).toBe(3);
      // Keyframe offset relative to clip startTime
      expect(element.keyframes['hero_car.translation'][0].time).toBe(0.0);
      expect(element.keyframes['hero_car.translation'][1].time).toBe(1.5);
      expect(element.keyframes['hero_car.translation'][2].time).toBe(3.5);
    });
  });

  describe('Universal3DStructureFoundation Integration', () => {
    it('embeds animation clips and packages standard glTF 2.0 binary animations chunk', () => {
      const structure = Universal3DStructureFoundation.createAlpineMatterhornComplex({
        name: 'alpine_matterhorn'
      });

      const animClip: UniversalAnimationClip = {
        id: 'flyby-01',
        name: 'Peak Flyby Survey',
        durationSeconds: 2.0,
        fps: 24,
        tracks: [
          {
            id: 't-cam-pos',
            name: 'Camera Position',
            targetNodeId: 'camera',
            property: 'translation',
            interpolation: 'linear',
            keyframes: [
              { timeSeconds: 0.0, value: [0, 100, 200] },
              { timeSeconds: 2.0, value: [200, 150, 0] }
            ]
          },
          {
            id: 't-cam-rot',
            name: 'Camera Rotation',
            targetNodeId: 'camera',
            property: 'rotation',
            interpolation: 'slerp',
            keyframes: [
              { timeSeconds: 0.0, value: [0, 0, 0, 1] },
              { timeSeconds: 2.0, value: [0, Math.SQRT1_2, 0, Math.SQRT1_2] }
            ]
          }
        ]
      };

      structure.addAnimation(animClip);
      expect(structure.animations.length).toBe(1);

      // Export to CameraSolveTrack
      const solve = structure.toCameraSolveTrack();
      expect(solve).toBeDefined();
      expect(solve!.name).toContain('Peak Flyby Survey');

      // Export binary glTF 2.0 (.glb) with animations chunk
      const glb = structure.toGlbBuffer({ includeAnimations: true });
      expect(glb).toBeInstanceOf(Buffer);
      expect(glb.length).toBeGreaterThan(100);

      // Validate glTF 2.0 Magic Header
      expect(glb.readUInt32LE(0)).toBe(0x46546C67); // 'glTF'
      expect(glb.readUInt32LE(4)).toBe(2);          // version 2

      // Parse JSON chunk
      const jsonLength = glb.readUInt32LE(12);
      const jsonText = glb.subarray(20, 20 + jsonLength).toString('utf8');
      const gltf = JSON.parse(jsonText);

      expect(gltf.asset.version).toBe('2.0');
      expect(gltf.animations).toBeDefined();
      expect(gltf.animations.length).toBe(1);
      expect(gltf.animations[0].name).toBe('Peak Flyby Survey');
      expect(gltf.animations[0].channels.length).toBe(2);
      expect(gltf.animations[0].samplers.length).toBe(2);

      // Channel 0: translation targeting camera node
      expect(gltf.animations[0].channels[0].target.path).toBe('translation');
      expect(gltf.animations[0].channels[1].target.path).toBe('rotation');

      // Validate exportAll includes animation_track
      const exportResult = structure.exportAll();
      expect(exportResult.formatsExported).toContain('animation_track');
      expect(exportResult.animations).toBeDefined();
      expect(exportResult.animations!.length).toBe(1);
      expect(exportResult.cameraSolveTrack).toBeDefined();
    });
  });
});
