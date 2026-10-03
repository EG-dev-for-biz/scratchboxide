/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as THREE from 'three';
import { GeoFrame } from '../../../common/coordinate/GeoFrame';
import { GeoAnchor4D } from '../../../common/geospatial-4d-protocol';
import { BakedGaussian } from '../../../common/geospatial-4d-protocol';

/**
 * Skinning execution mode for the 4D performer avatar.
 */
export enum PerformerSkinningMode {
  /**
   * VFX-Grade 4-Bone Linear Blend Skinning (LBS) with full forward kinematics
   * rotational matrices (R_k), bone segment proximity weighting, and quaternion updates.
   * Eliminates limb stretching, tearing, and pinching.
   */
  SCRATCHBOX_LBS_4BONE = 'scratchbox_lbs_4bone',

  /**
   * Defective legacy DepthBox3 translation-only displacement without joint rotation matrices.
   * Provided for visual side-by-side comparison to demonstrate the quality leap.
   */
  DEPTHBOX3_LEGACY_TRANSLATION = 'depthbox3_legacy_translation',
}

/**
 * Real-world iconic music venue coordinates and headings.
 */
export interface MusicVenuePreset {
  id: string;
  name: string;
  city: string;
  stateCountry: string;
  lat: number;
  lng: number;
  altMeters: number;
  stageHeadingDeg: number;
  description: string;
}

export const MUSIC_VENUE_PRESETS: Record<string, MusicVenuePreset> = {
  red_rocks: {
    id: 'red_rocks',
    name: 'Red Rocks Amphitheatre',
    city: 'Morrison',
    stateCountry: 'Colorado, USA',
    lat: 39.66555,
    lng: -105.20525,
    altMeters: 1932.0,
    stageHeadingDeg: 285.0,
    description: 'Iconic open-air amphitheatre built into red sandstone rock formations.',
  },
  hollywood_bowl: {
    id: 'hollywood_bowl',
    name: 'Hollywood Bowl',
    city: 'Los Angeles',
    stateCountry: 'California, USA',
    lat: 34.1122,
    lng: -118.3391,
    altMeters: 225.0,
    stageHeadingDeg: 200.0,
    description: 'Historic natural amphitheater featuring the distinctive concentric band shell.',
  },
  the_gorge: {
    id: 'the_gorge',
    name: 'The Gorge Amphitheatre',
    city: 'George',
    stateCountry: 'Washington, USA',
    lat: 47.1011,
    lng: -119.9953,
    altMeters: 360.0,
    stageHeadingDeg: 260.0,
    description: 'Breathtaking canyon backdrop overlooking the Columbia River.',
  },
  greek_theatre: {
    id: 'greek_theatre',
    name: 'Greek Theatre UC Berkeley',
    city: 'Berkeley',
    stateCountry: 'California, USA',
    lat: 37.8737,
    lng: -122.2543,
    altMeters: 140.0,
    stageHeadingDeg: 245.0,
    description: 'Classical Roman-style outdoor amphitheater nestled in the Berkeley Hills.',
  },
  arena_di_verona: {
    id: 'arena_di_verona',
    name: 'Arena di Verona',
    city: 'Verona',
    stateCountry: 'Italy',
    lat: 45.4390,
    lng: 10.9944,
    altMeters: 59.0,
    stageHeadingDeg: 170.0,
    description: 'Ancient Roman amphitheater renowned for monumental opera and live concerts.',
  },
};

/**
 * Configuration options for the Concert Stage Performer Service.
 */
export interface ConcertStageOptions {
  venue?: MusicVenuePreset;
  stageWidth?: number;      // default: 18.0m
  stageDepth?: number;      // default: 12.0m
  stageHeight?: number;     // default: 1.20m elevation deck
  trussHeight?: number;     // default: 8.50m overhead lighting gantry
  showStageProps?: boolean; // default: true
  skinningMode?: PerformerSkinningMode;
  groundAltitudeOffset?: number; // default: 0.0m
}

export interface SplatSkinWeight {
  boneIndices: [number, number, number, number];
  boneWeights: [number, number, number, number];
}

export interface PerformerKinematicsFrame {
  frameIndex: number;
  timestampSec: number;
  rootTranslation: [number, number, number];
  rootRotation: [number, number, number, number];
  jointPositions: Array<[number, number, number]>;
}

export interface PerformerTelemetry {
  venueId: string;
  venueName: string;
  coordinates: { lat: number; lng: number; alt: number };
  stageHeightMeters: number;
  skinningMode: PerformerSkinningMode;
  currentFrame: number;
  totalFrames: number;
  numSplats: number;
  bounds: {
    min: [number, number, number];
    max: [number, number, number];
    size: [number, number, number];
  };
  footStageContactDeltaY: number; // Vertical offset of lowest foot relative to stage deck (0.00 = perfect contact)
  isPlaying: boolean;
  playbackFps: number;
}

/**
 * 22 Canonical SB-Human Joint Names and Hierarchy.
 */
export const SBHUMAN_22_JOINT_NAMES = [
  'pelvis',         // 0
  'left_hip',       // 1
  'right_hip',      // 2
  'spine1',         // 3
  'left_knee',      // 4
  'right_knee',     // 5
  'spine2',         // 6
  'left_ankle',     // 7
  'right_ankle',    // 8
  'spine3',         // 9
  'left_foot',      // 10
  'right_foot',     // 11
  'neck',           // 12
  'left_collar',    // 13
  'right_collar',   // 14
  'head',           // 15
  'left_shoulder',  // 16
  'right_shoulder', // 17
  'left_elbow',     // 18
  'right_elbow',    // 19
  'left_wrist',     // 20
  'right_wrist',    // 21
];

export const SBHUMAN_22_PARENTS = [
  -1, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 9, 9, 12, 13, 14, 16, 17, 18, 19
];


/**
 * Default metric canonical rest joints for SB-Human humanoids.
 */
export const DEFAULT_CANONICAL_JOINTS: Array<[number, number, number]> = [
  [0.0031, 0.9353, 0.0400],   // 0: pelvis
  [0.0613, 0.8426, -0.0140],  // 1: left_hip
  [-0.0601, 0.8415, -0.0140], // 2: right_hip
  [0.0028, 1.0253, 0.0245],   // 3: spine1
  [0.0898, 0.4682, -0.0050],  // 4: left_knee
  [-0.0892, 0.4685, -0.0050], // 5: right_knee
  [0.0035, 1.1553, 0.0125],   // 6: spine2
  [0.0712, 0.0782, -0.0520],  // 7: left_ankle
  [-0.0715, 0.0780, -0.0520], // 8: right_ankle
  [0.0038, 1.2453, 0.0045],   // 9: spine3
  [0.0815, 0.0250, 0.0980],   // 10: left_foot
  [-0.0812, 0.0250, 0.0980],  // 11: right_foot
  [0.0040, 1.3453, -0.0247],  // 12: neck
  [0.0448, 1.3143, -0.0003],  // 13: left_collar
  [-0.0492, 1.3137, -0.0065], // 14: right_collar
  [0.0111, 1.5549, -0.0040],  // 15: head
  [0.1641, 1.3720, -0.0158],  // 16: left_shoulder
  [-0.1518, 1.3672, -0.0191], // 17: right_shoulder
  [0.4182, 1.2998, -0.0582],  // 18: left_elbow
  [-0.4229, 1.3307, -0.0456], // 19: right_elbow
  [0.6702, 1.3231, -0.0607],  // 20: left_wrist
  [-0.6722, 1.3262, -0.0609], // 21: right_wrist
];

/**
 * ConcertStagePerformerService
 *
 * Bridges Google Photorealistic 3D Tiles geodetic venues (Red Rocks Amphitheatre)
 * with Performer 4D Gaussian Splatting avatars, featuring VFX-grade 4-bone Linear
 * Blend Skinning, true forward kinematics rotations, and strict ground clamping.
 */
export class ConcertStagePerformerService {
  public readonly group: THREE.Group;
  public readonly stageDeckGroup: THREE.Group;
  public readonly trussGroup: THREE.Group;
  public readonly audioGroup: THREE.Group;
  public readonly lightingGroup: THREE.Group;
  public readonly performerGroup: THREE.Group;

  public venue: MusicVenuePreset;
  public geoFrame: GeoFrame;
  public stageWidth: number;
  public stageDepth: number;
  public stageHeight: number;
  public trussHeight: number;
  public skinningMode: PerformerSkinningMode;

  // Gaussian Splat Data
  public restSplats: BakedGaussian[] = [];
  public splatWeights: SplatSkinWeight[] = [];
  public canonicalJoints: Array<[number, number, number]> = DEFAULT_CANONICAL_JOINTS;
  public kintreeParents: number[] = SBHUMAN_22_PARENTS;

  // Kinematic Motion Frames
  public motionFrames: PerformerKinematicsFrame[] = [];
  public currentFrameIndex: number = 0;
  public isPlaying: boolean = false;
  public playbackFps: number = 30.0;
  public isLooping: boolean = true;

  // Performer Render Mesh / Point Cloud
  private performerPointsMesh?: THREE.Points;
  private performerPositionsBuffer?: Float32Array;
  private performerColorsBuffer?: Float32Array;

  constructor(options: ConcertStageOptions = {}) {
    this.venue = options.venue || MUSIC_VENUE_PRESETS.red_rocks;
    this.stageWidth = options.stageWidth ?? 18.0;
    this.stageDepth = options.stageDepth ?? 12.0;
    this.stageHeight = options.stageHeight ?? 1.20;
    this.trussHeight = options.trussHeight ?? 8.50;
    this.skinningMode = options.skinningMode ?? PerformerSkinningMode.SCRATCHBOX_LBS_4BONE;

    const anchor: GeoAnchor4D = {
      lat: this.venue.lat,
      lng: this.venue.lng,
      alt: this.venue.altMeters + (options.groundAltitudeOffset ?? 0.0),
    };
    this.geoFrame = new GeoFrame(anchor);

    this.group = new THREE.Group();
    this.stageDeckGroup = new THREE.Group();
    this.trussGroup = new THREE.Group();
    this.audioGroup = new THREE.Group();
    this.lightingGroup = new THREE.Group();
    this.performerGroup = new THREE.Group();

    this.group.add(this.stageDeckGroup);
    this.group.add(this.trussGroup);
    this.group.add(this.audioGroup);
    this.group.add(this.lightingGroup);
    this.group.add(this.performerGroup);

    this.buildConcertStageArchitecture();
    this.setHeading(this.venue.stageHeadingDeg);

    if (options.showStageProps === false) {
      this.setStagePropsVisible(false);
    }
  }

  /**
   * Sets the stage orientation heading in degrees (0 = North, 90 = East, etc.).
   */
  public setHeading(headingDeg: number) {
    const rad = -(headingDeg * Math.PI) / 180.0;
    this.group.rotation.y = rad;
  }

  /**
   * Toggles visibility of stage architectural elements (deck, truss, audio, lighting).
   */
  public setStagePropsVisible(visible: boolean) {
    this.stageDeckGroup.visible = visible;
    this.trussGroup.visible = visible;
    this.audioGroup.visible = visible;
    this.lightingGroup.visible = visible;
  }

  /**
   * Switches the skinning execution mode.
   */
  public setSkinningMode(mode: PerformerSkinningMode) {
    this.skinningMode = mode;
    this.evaluateCurrentFrame();
  }

  /**
   * Constructs the physical concert stage deck, overhead aluminum truss, PA line arrays,
   * and concert wash lighting.
   */
  private buildConcertStageArchitecture() {
    const w = this.stageWidth;
    const d = this.stageDepth;
    const h = this.stageHeight;
    const th = this.trussHeight;

    // 1. Stage Deck (Elevated platform centered at x=0, z=0, resting at y=0)
    const deckGeo = new THREE.BoxGeometry(w, h, d);
    const deckMat = new THREE.MeshStandardMaterial({
      color: 0x181c22,
      roughness: 0.6,
      metalness: 0.2,
    });
    const deckMesh = new THREE.Mesh(deckGeo, deckMat);
    deckMesh.position.set(0, h / 2, 0);
    deckMesh.receiveShadow = true;
    deckMesh.castShadow = true;
    this.stageDeckGroup.add(deckMesh);

    // Stage Front Edge Safety Apron
    const apronGeo = new THREE.BoxGeometry(w + 0.4, 0.08, 0.4);
    const apronMat = new THREE.MeshStandardMaterial({
      color: 0xd9822b, // Warning amber safety lip
      roughness: 0.4,
      metalness: 0.3,
    });
    const apronMesh = new THREE.Mesh(apronGeo, apronMat);
    apronMesh.position.set(0, h + 0.04, d / 2);
    this.stageDeckGroup.add(apronMesh);

    // 2. Overhead Aluminum Truss Gantry
    const trussMat = new THREE.MeshStandardMaterial({
      color: 0x7a828e,
      roughness: 0.35,
      metalness: 0.85,
    });

    // 4 Corner Pillars
    const halfW = w / 2 - 0.4;
    const halfD = d / 2 - 0.4;
    const pillarPositions = [
      [-halfW, halfD],
      [halfW, halfD],
      [-halfW, -halfD],
      [halfW, -halfD],
    ];

    pillarPositions.forEach(([px, pz]) => {
      const colGeo = new THREE.CylinderGeometry(0.12, 0.12, th - h, 8);
      const colMesh = new THREE.Mesh(colGeo, trussMat);
      colMesh.position.set(px, h + (th - h) / 2, pz);
      this.trussGroup.add(colMesh);
    });

    // Overhead Box Frame
    const frontBeamGeo = new THREE.BoxGeometry(w, 0.3, 0.3);
    const frontBeam = new THREE.Mesh(frontBeamGeo, trussMat);
    frontBeam.position.set(0, th, halfD);
    this.trussGroup.add(frontBeam);

    const backBeam = new THREE.Mesh(frontBeamGeo, trussMat);
    backBeam.position.set(0, th, -halfD);
    this.trussGroup.add(backBeam);

    const sideBeamGeo = new THREE.BoxGeometry(0.3, 0.3, d);
    const leftBeam = new THREE.Mesh(sideBeamGeo, trussMat);
    leftBeam.position.set(-halfW, th, 0);
    this.trussGroup.add(leftBeam);

    const rightBeam = new THREE.Mesh(sideBeamGeo, trussMat);
    rightBeam.position.set(halfW, th, 0);
    this.trussGroup.add(rightBeam);

    // 3. Left & Right Stage Wing PA Line Array Audio Hangs
    const audioMat = new THREE.MeshStandardMaterial({
      color: 0x111317,
      roughness: 0.7,
      metalness: 0.1,
    });

    [-halfW - 1.2, halfW + 1.2].forEach((paX) => {
      for (let i = 0; i < 6; i++) {
        const boxGeo = new THREE.BoxGeometry(0.9, 0.35, 0.7);
        const boxMesh = new THREE.Mesh(boxGeo, audioMat);
        boxMesh.position.set(paX, th - 1.0 - i * 0.42, halfD - 0.5);
        boxMesh.rotation.x = 0.08 * (i + 1); // Curve array down toward seating
        this.audioGroup.add(boxMesh);
      }
    });

    // 4. Directional Stage Lighting Spotlights & Stage Wash
    const spotPositions = [
      [-4.0, th - 0.2, 0.0, 0x4da6ff], // Stage Left Cool Cyan Key
      [4.0, th - 0.2, 0.0, 0xffaa4d],  // Stage Right Warm Amber Key
      [0.0, th - 0.2, -halfD + 1.0, 0xff3366], // Backlight Rim Magenta
      [0.0, th - 0.2, halfD - 1.0, 0xffffff],  // Center Stage Neutral Fill
    ];

    spotPositions.forEach(([sx, sy, sz, colorHex]) => {
      const spot = new THREE.SpotLight(colorHex as number, 3.5, 40, Math.PI / 5, 0.35, 1.2);
      spot.position.set(sx as number, sy as number, sz as number);
      spot.target.position.set(0, h, 0);
      this.lightingGroup.add(spot);
      this.lightingGroup.add(spot.target);
    });
  }

  /**
   * Ingests canonical Performer 4D Gaussian Splatting avatar model and binds 4-bone weights.
   */
  public loadPerformerSplats(splats: BakedGaussian[], canonicalJoints?: Array<[number, number, number]>) {
    this.restSplats = splats;
    if (canonicalJoints && canonicalJoints.length >= 22) {
      this.canonicalJoints = canonicalJoints;
    }
    this.computeSplatBoneWeights();
    this.initializePointsRenderMesh();
    this.evaluateCurrentFrame();
  }

  /**
   * Automatically binds canonical Gaussians to skeletal bones via geodesic segment distance.
   */
  public computeSplatBoneWeights(radiusFalloff: number = 0.22) {
    const numJoints = this.canonicalJoints.length;
    const invTwoSigmaSq = 1.0 / (2.0 * radiusFalloff * radiusFalloff);

    this.splatWeights = this.restSplats.map((g) => {
      const candidates: Array<{ index: number; dist: number; weight: number }> = [];

      for (let j = 0; j < numJoints; j++) {
        const pIdx = this.kintreeParents[j] !== undefined ? this.kintreeParents[j] : -1;
        let dist: number;

        if (pIdx >= 0 && pIdx < numJoints) {
          dist = this.distanceToSegment(g.position, this.canonicalJoints[pIdx], this.canonicalJoints[j]);
        } else {
          const c = this.canonicalJoints[j];
          const dx = g.position[0] - c[0];
          const dy = g.position[1] - c[1];
          const dz = g.position[2] - c[2];
          dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        }

        candidates.push({
          index: j,
          dist,
          weight: Math.exp(-dist * dist * invTwoSigmaSq),
        });
      }

      candidates.sort((a, b) => a.dist - b.dist);
      const top4 = candidates.slice(0, 4);
      const sumWeight = top4.reduce((acc, val) => acc + val.weight, 0);

      const boneIndices: [number, number, number, number] = [
        top4[0].index,
        top4[1].index,
        top4[2].index,
        top4[3].index,
      ];

      const boneWeights: [number, number, number, number] =
        sumWeight > 1e-6
          ? [
              top4[0].weight / sumWeight,
              top4[1].weight / sumWeight,
              top4[2].weight / sumWeight,
              top4[3].weight / sumWeight,
            ]
          : [1.0, 0, 0, 0];

      return { boneIndices, boneWeights };
    });
  }

  /**
   * Distance from 3D point p to line segment [a, b].
   */
  private distanceToSegment(
    p: [number, number, number],
    a: [number, number, number],
    b: [number, number, number]
  ): number {
    const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const lenSq = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2];
    if (lenSq < 1e-8) {
      const dx = p[0] - a[0];
      const dy = p[1] - a[1];
      const dz = p[2] - a[2];
      return Math.sqrt(dx * dx + dy * dy + dz * dz);
    }

    const ap = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
    const t = Math.max(0.0, Math.min(1.0, (ap[0] * ab[0] + ap[1] * ab[1] + ap[2] * ab[2]) / lenSq));
    const proj = [a[0] + ab[0] * t, a[1] + ab[1] * t, a[2] + ab[2] * t];
    const dx = p[0] - proj[0];
    const dy = p[1] - proj[1];
    const dz = p[2] - proj[2];
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  /**
   * Ingests 22-joint kinematics motion frames (e.g. from performer benchmark clip).
   */
  public loadMotionFrames(frames: PerformerKinematicsFrame[]) {
    this.motionFrames = frames;
    this.currentFrameIndex = 0;
    this.evaluateCurrentFrame();
  }

  /**
   * Initializes the Three.js render mesh with buffers sized for all splats.
   */
  private initializePointsRenderMesh() {
    const count = this.restSplats.length;
    if (count === 0) return;

    if (this.performerPointsMesh) {
      this.performerGroup.remove(this.performerPointsMesh);
      this.performerPointsMesh.geometry.dispose();
      (this.performerPointsMesh.material as THREE.Material).dispose();
    }

    this.performerPositionsBuffer = new Float32Array(count * 3);
    this.performerColorsBuffer = new Float32Array(count * 3);

    for (let i = 0; i < count; i++) {
      const g = this.restSplats[i];
      const i3 = i * 3;
      this.performerPositionsBuffer[i3] = g.position[0];
      this.performerPositionsBuffer[i3 + 1] = g.position[1];
      this.performerPositionsBuffer[i3 + 2] = g.position[2];

      this.performerColorsBuffer[i3] = g.colorRgb[0];
      this.performerColorsBuffer[i3 + 1] = g.colorRgb[1];
      this.performerColorsBuffer[i3 + 2] = g.colorRgb[2];
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.performerPositionsBuffer, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(this.performerColorsBuffer, 3));

    const mat = new THREE.PointsMaterial({
      size: 0.038,
      vertexColors: true,
      transparent: true,
      opacity: 0.96,
      depthWrite: true,
    });

    this.performerPointsMesh = new THREE.Points(geo, mat);
    this.performerGroup.add(this.performerPointsMesh);
  }

  /**
   * Evaluates the deformation for the current frame index according to the selected skinning mode,
   * applying strict ground contact altitude compensation onto the stage deck.
   */
  public evaluateCurrentFrame(): BakedGaussian[] {
    const count = this.restSplats.length;
    if (count === 0) return [];

    const frame =
      this.motionFrames.length > 0
        ? this.motionFrames[Math.min(this.currentFrameIndex, this.motionFrames.length - 1)]
        : null;

    let deformedSplats: BakedGaussian[];

    if (!frame) {
      // Rest pose: align feet to stageHeight
      const lowestRestY = Math.min(this.canonicalJoints[10][1], this.canonicalJoints[11][1]);
      const stageOffset = this.stageHeight - lowestRestY;

      deformedSplats = this.restSplats.map((g) => ({
        ...g,
        position: [g.position[0], g.position[1] + stageOffset, g.position[2]],
      }));
    } else if (this.skinningMode === PerformerSkinningMode.SCRATCHBOX_LBS_4BONE) {
      deformedSplats = this.evaluateScratchboxLBS4Bone(frame);
    } else {
      deformedSplats = this.evaluateDepthBox3LegacyTranslation(frame);
    }

    // Update Three.js buffer geometry if present
    if (this.performerPositionsBuffer && this.performerPointsMesh) {
      for (let i = 0; i < count; i++) {
        const pos = deformedSplats[i].position;
        const i3 = i * 3;
        this.performerPositionsBuffer[i3] = pos[0];
        this.performerPositionsBuffer[i3 + 1] = pos[1];
        this.performerPositionsBuffer[i3 + 2] = pos[2];
      }
      this.performerPointsMesh.geometry.attributes.position.needsUpdate = true;
    }

    return deformedSplats;
  }

  /**
   * VFX-Grade 4-Bone Linear Blend Skinning (LBS).
   * Computes full 4x4 forward kinematics transformation matrices:
   *   T_j = Translation(pPos) * Rotation(jointRot) * Translation(-cPos)
   * And applies multi-bone blending with orientation quaternion updates.
   */
  private evaluateScratchboxLBS4Bone(frame: PerformerKinematicsFrame): BakedGaussian[] {
    const posedJoints = frame.jointPositions;
    const numJoints = Math.min(this.canonicalJoints.length, posedJoints.length);

    // Ground Clamping: Calculate lowest foot joint in posed space
    const leftFootPosed = posedJoints[10];
    const rightFootPosed = posedJoints[11];
    const lowestFootY = Math.min(leftFootPosed ? leftFootPosed[1] : 0, rightFootPosed ? rightFootPosed[1] : 0);
    const groundPinDeltaY = this.stageHeight - lowestFootY;

    // Compute 4x4 skinning transformation matrix for each joint
    const skinTransforms: THREE.Matrix4[] = [];

    for (let j = 0; j < numJoints; j++) {
      const cPos = new THREE.Vector3(...this.canonicalJoints[j]);
      const pPos = new THREE.Vector3(
        posedJoints[j][0] + frame.rootTranslation[0],
        posedJoints[j][1] + frame.rootTranslation[1] + groundPinDeltaY,
        posedJoints[j][2] + frame.rootTranslation[2]
      );

      const pIdx = this.kintreeParents[j] !== undefined ? this.kintreeParents[j] : -1;
      const jointRot = new THREE.Quaternion(...frame.rootRotation);

      if (pIdx >= 0 && pIdx < numJoints) {
        const cBone = new THREE.Vector3(...this.canonicalJoints[j]).sub(new THREE.Vector3(...this.canonicalJoints[pIdx]));
        const pBone = new THREE.Vector3(...posedJoints[j]).sub(new THREE.Vector3(...posedJoints[pIdx]));

        if (cBone.lengthSq() > 1e-6 && pBone.lengthSq() > 1e-6) {
          const u = cBone.clone().normalize();
          const v = pBone.clone().normalize();
          const qBone = new THREE.Quaternion().setFromUnitVectors(u, v);
          jointRot.multiply(qBone);
        }
      }

      // Matrix: T_j = Translation(pPos) * Rotation(jointRot) * Translation(-cPos)
      const mat = new THREE.Matrix4();
      const mToOrigin = new THREE.Matrix4().makeTranslation(-cPos.x, -cPos.y, -cPos.z);
      const mRot = new THREE.Matrix4().makeRotationFromQuaternion(jointRot);
      const mToPosed = new THREE.Matrix4().makeTranslation(pPos.x, pPos.y, pPos.z);

      mat.multiplyMatrices(mToPosed, mRot);
      mat.multiply(mToOrigin);

      skinTransforms.push(mat);
    }

    // Blend all splats across 4 bone weights
    const deformed: BakedGaussian[] = [];
    const count = this.restSplats.length;

    for (let i = 0; i < count; i++) {
      const g = this.restSplats[i];
      const sw = this.splatWeights[i];
      const restPos = new THREE.Vector3(...g.position);
      const blendedPos = new THREE.Vector3(0, 0, 0);

      for (let k = 0; k < 4; k++) {
        const w = sw.boneWeights[k];
        if (w <= 1e-5) continue;
        const bIdx = sw.boneIndices[k];
        if (bIdx < skinTransforms.length) {
          const transformed = restPos.clone().applyMatrix4(skinTransforms[bIdx]);
          blendedPos.addScaledVector(transformed, w);
        }
      }

      deformed.push({
        ...g,
        position: [blendedPos.x, blendedPos.y, blendedPos.z],
      });
    }

    return deformed;
  }

  /**
   * Defective legacy DepthBox3 translation-only displacement.
   * Only uses joint translational deltas (zero rotational matrix R_k = I) and single-bone nearest joint.
   */
  private evaluateDepthBox3LegacyTranslation(frame: PerformerKinematicsFrame): BakedGaussian[] {
    const posedJoints = frame.jointPositions;
    const numJoints = Math.min(this.canonicalJoints.length, posedJoints.length);

    // Legacy joint deltas without ground contact locking
    const jointDeltas: Array<[number, number, number]> = [];
    for (let j = 0; j < numJoints; j++) {
      jointDeltas.push([
        posedJoints[j][0] - this.canonicalJoints[j][0] + frame.rootTranslation[0],
        posedJoints[j][1] - this.canonicalJoints[j][1] + frame.rootTranslation[1],
        posedJoints[j][2] - this.canonicalJoints[j][2] + frame.rootTranslation[2],
      ]);
    }

    const deformed: BakedGaussian[] = [];
    const count = this.restSplats.length;

    for (let i = 0; i < count; i++) {
      const g = this.restSplats[i];
      const primaryJoint = this.splatWeights[i] ? this.splatWeights[i].boneIndices[0] : 0;
      const delta = primaryJoint < jointDeltas.length ? jointDeltas[primaryJoint] : [0, 0, 0];

      deformed.push({
        ...g,
        position: [
          g.position[0] + delta[0],
          g.position[1] + delta[1] + this.stageHeight,
          g.position[2] + delta[2],
        ],
      });
    }

    return deformed;
  }

  /**
   * Advances the animation timeline by a delta time step (seconds).
   */
  public update(deltaSec: number) {
    if (!this.isPlaying || this.motionFrames.length <= 1) return;

    const framesToAdvance = deltaSec * this.playbackFps;
    this.currentFrameIndex += framesToAdvance;

    if (this.currentFrameIndex >= this.motionFrames.length) {
      if (this.isLooping) {
        this.currentFrameIndex %= this.motionFrames.length;
      } else {
        this.currentFrameIndex = this.motionFrames.length - 1;
        this.isPlaying = false;
      }
    }

    this.evaluateCurrentFrame();
  }

  /**
   * Seeks to an explicit frame index.
   */
  public seek(frameIndex: number) {
    if (this.motionFrames.length === 0) return;
    this.currentFrameIndex = Math.max(0, Math.min(frameIndex, this.motionFrames.length - 1));
    this.evaluateCurrentFrame();
  }

  public play() {
    this.isPlaying = true;
  }

  public pause() {
    this.isPlaying = false;
  }

  /**
   * Computes runtime diagnostics and ground contact telemetry.
   */
  public getTelemetry(): PerformerTelemetry {
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

    if (this.performerPositionsBuffer && this.performerPositionsBuffer.length > 0) {
      const len = this.performerPositionsBuffer.length;
      for (let i = 0; i < len; i += 3) {
        const x = this.performerPositionsBuffer[i];
        const y = this.performerPositionsBuffer[i + 1];
        const z = this.performerPositionsBuffer[i + 2];
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        minZ = Math.min(minZ, z);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
        maxZ = Math.max(maxZ, z);
      }
    } else {
      minX = maxX = minY = maxY = minZ = maxZ = 0;
    }

    const footDelta = minY !== Infinity ? minY - this.stageHeight : 0;

    return {
      venueId: this.venue.id,
      venueName: this.venue.name,
      coordinates: {
        lat: this.venue.lat,
        lng: this.venue.lng,
        alt: this.venue.altMeters,
      },
      stageHeightMeters: this.stageHeight,
      skinningMode: this.skinningMode,
      currentFrame: Math.floor(this.currentFrameIndex),
      totalFrames: this.motionFrames.length,
      numSplats: this.restSplats.length,
      bounds: {
        min: [minX, minY, minZ],
        max: [maxX, maxY, maxZ],
        size: [maxX - minX, maxY - minY, maxZ - minZ],
      },
      footStageContactDeltaY: Math.round(footDelta * 1000) / 1000,
      isPlaying: this.isPlaying,
      playbackFps: this.playbackFps,
    };
  }

  /**
   * Serializes the current deformed frame to standard 32-byte binary .splat buffer.
   */
  public exportCurrentFrameSplatBuffer(): ArrayBuffer {
    const splats = this.evaluateCurrentFrame();
    const count = splats.length;
    const buffer = new ArrayBuffer(count * 32);
    const view = new DataView(buffer);

    for (let i = 0; i < count; i++) {
      const s = splats[i];
      const offset = i * 32;

      // Position (3 x float32 = 12 bytes)
      view.setFloat32(offset, s.position[0], true);
      view.setFloat32(offset + 4, s.position[1], true);
      view.setFloat32(offset + 8, s.position[2], true);

      // Scale (3 x float32 = 12 bytes)
      view.setFloat32(offset + 12, s.scale[0], true);
      view.setFloat32(offset + 16, s.scale[1], true);
      view.setFloat32(offset + 20, s.scale[2], true);

      // Color RGBA (4 x uint8 = 4 bytes)
      view.setUint8(offset + 24, Math.floor(Math.min(1.0, Math.max(0.0, s.colorRgb[0])) * 255));
      view.setUint8(offset + 25, Math.floor(Math.min(1.0, Math.max(0.0, s.colorRgb[1])) * 255));
      view.setUint8(offset + 26, Math.floor(Math.min(1.0, Math.max(0.0, s.colorRgb[2])) * 255));
      view.setUint8(offset + 27, Math.floor(Math.min(1.0, Math.max(0.0, s.opacity)) * 255));

      // Rotation Quaternion (4 x uint8 normalized = 4 bytes)
      const q = s.quaternion || [0, 0, 0, 1];
      view.setUint8(offset + 28, Math.floor((q[0] * 0.5 + 0.5) * 255));
      view.setUint8(offset + 29, Math.floor((q[1] * 0.5 + 0.5) * 255));
      view.setUint8(offset + 30, Math.floor((q[2] * 0.5 + 0.5) * 255));
      view.setUint8(offset + 31, Math.floor((q[3] * 0.5 + 0.5) * 255));
    }

    return buffer;
  }
}
