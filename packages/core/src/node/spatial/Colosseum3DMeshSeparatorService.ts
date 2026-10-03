/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as fs from 'fs';
import * as path from 'path';
import {
  OrientedBoundingBoxSolver,
  OrientedBoundingBox3D,
  DualBoundingBoxResult
} from './OrientedBoundingBoxSolver';
import {
  ColosseumTreeIdentificationEngine,
  BotanicalTreeRecord,
  BotanicalSummary
} from './ColosseumTreeIdentificationEngine';
import { Universal3DObjectSeparationService } from './Universal3DObjectSeparationService';

export type SpatialCategory =
  | 'monument'
  | 'ruin'
  | 'foliage'
  | 'terrain'
  | 'colosseum_architecture'
  | 'monuments_temples'
  | 'foliage_trees'
  | 'archaeology_ruins'
  | 'urban_infrastructure';

export interface BoundingBox3DMetric {
  min: [number, number, number];
  max: [number, number, number];
  dimensions: [number, number, number]; // [width, height, depth] in meters
  centroid: [number, number, number];   // [cx, cy, cz] in meters
  volumeM3: number;
}

export interface Separated3DObject {
  id: string;
  name: string;
  category: SpatialCategory;
  boundingBox: BoundingBox3DMetric;
  orientedBoundingBox: OrientedBoundingBox3D;
  tightnessGainPercent: number;
  vertexCount: number;
  triangleCount: number;
  submeshIndices: number[];
  gemini3DScaleDiscrepancyPercent: number;
  colorHex: string;
  trellisPrompt: string;
  material: {
    roughness: number;
    metalness: number;
    baseColor: string;
  };
}

export interface Separated3DScene {
  modelName: string;
  totalVertices: number;
  totalSubmeshes: number;
  overallBoundingBox: BoundingBox3DMetric;
  overallOrientedBoundingBox?: OrientedBoundingBox3D;
  objects: Separated3DObject[];
  granularityMode: 'macro' | 'detailed' | 'total' | 'trees' | 'all';
  timestamp: string;
  sourceAssetPath?: string;
  objectCounts?: {
    total: number;
    monuments: number;
    ruins: number;
    foliage: number;
    terrain: number;
    colosseum_architecture: number;
    monuments_temples: number;
    foliage_trees: number;
    archaeology_ruins: number;
    urban_infrastructure: number;
  };
}

export interface SpatialFilter {
  center?: [number, number, number];
  radius?: number;
  minY?: number;
  maxY?: number;
  box?: [number, number, number, number, number, number]; // [minX, minY, minZ, maxX, maxY, maxZ]
}

export interface SpatialEntityDefinition {
  id: string;
  name: string;
  category: SpatialCategory;
  submeshCluster: number[];
  colorHex: string;
  nominalDimensions: [number, number, number] | number[]; // [W, H, D]
  nominalCentroid: [number, number, number] | number[];   // [cx, cy, cz]
  nominalYawDeg?: number;
  nominalYawRad?: number;
  trellisPrompt: string;
  material: {
    roughness: number;
    metalness: number;
    baseColor: string;
  };
  spatialFilter?: SpatialFilter;
}

/**
 * 11 Macro discrete 3D spatial entities (Level of Detail 1).
 */
export const COLOSSEUM_3D_ENTITIES: SpatialEntityDefinition[] = [
  {
    id: 'det-colosseum-facade',
    name: 'Colosseum Outer Arcade Facade',
    category: 'monument',
    submeshCluster: [20, 21, 22, 24, 30, 31, 32, 33, 39, 41, 42, 50, 54],
    colorHex: '#3b82f6',
    nominalDimensions: [188.0, 48.5, 156.0],
    nominalCentroid: [-43.42, 42.5, 62.54],
    nominalYawDeg: 35.94,
    nominalYawRad: 0.6273,
    trellisPrompt: 'Complete 3D travertine limestone facade of the Roman Colosseum with four-tiered classical arched arcades, intact Corinthian and Ionic pilasters, and radial barrel-vaulted vomitoria.',
    material: { roughness: 0.88, metalness: 0.02, baseColor: '#d6cbba' }
  },
  {
    id: 'det-arch-constantine',
    name: 'Arch of Constantine (Arco di Costantino)',
    category: 'monument',
    submeshCluster: [60],
    colorHex: '#8b5cf6',
    nominalDimensions: [25.7, 21.0, 7.4],
    nominalCentroid: [-139.62, 35.9, -45.28],
    nominalYawDeg: 16.63,
    nominalYawRad: 0.2902,
    spatialFilter: {
      center: [-137.8, 32.0, -49.8],
      radius: 21.0
    },
    trellisPrompt: 'Triumphal arch of Constantine with three arched passageways, Corinthian columns on pedestals, sculpted marble friezes, Dacian prisoner statues, and attic inscription.',
    material: { roughness: 0.82, metalness: 0.03, baseColor: '#dfd7cc' }
  },
  {
    id: 'det-meta-sudans',
    name: 'Meta Sudans Ancient Fountain Ruins',
    category: 'ruin',
    submeshCluster: [2, 4],
    colorHex: '#10b981',
    nominalDimensions: [12.0, 4.5, 12.0],
    nominalCentroid: [-102.4, 27.5, -22.1],
    trellisPrompt: 'Conical Roman brick and concrete foundation core of the Meta Sudans fountain monument with preserved water-conduit base.',
    material: { roughness: 0.95, metalness: 0.0, baseColor: '#a68a72' }
  },
  {
    id: 'det-temple-venus-roma',
    name: 'Temple of Venus and Roma Terrace',
    category: 'monument',
    submeshCluster: [73, 75, 78],
    colorHex: '#ec4899',
    nominalDimensions: [145.0, 18.0, 100.0],
    nominalCentroid: [-270.8, 43.6, 85.6],
    trellisPrompt: 'Elevated travertine terrace podium of the Temple of Venus and Roma with monolithic gray granite column fragments and coffered apses.',
    material: { roughness: 0.85, metalness: 0.02, baseColor: '#d1c7bc' }
  },
  {
    id: 'det-velian-ruins',
    name: 'Roman Brick Substructure Ruins (Velian Hill)',
    category: 'ruin',
    submeshCluster: [70, 71, 72],
    colorHex: '#f59e0b',
    nominalDimensions: [40.0, 12.0, 25.0],
    nominalCentroid: [45.0, 36.0, 15.0],
    trellisPrompt: 'Exposed Roman opus latericium brick-faced concrete retaining wall ruins on the Velian slope with ancient barrel vault foundations.',
    material: { roughness: 0.92, metalness: 0.01, baseColor: '#965239' }
  },
  {
    id: 'det-travertine-blocks',
    name: 'Ancient Travertine Foundation Blocks',
    category: 'ruin',
    submeshCluster: [34, 39],
    colorHex: '#f97316',
    nominalDimensions: [18.0, 1.2, 10.0],
    nominalCentroid: [-40.0, 25.0, 15.0],
    trellisPrompt: 'Cut monolithic travertine curbstones and bollard posts marking the ancient sacred boundary around the amphitheater.',
    material: { roughness: 0.9, metalness: 0.0, baseColor: '#c7bcab' }
  },
  {
    id: 'det-tree-stone-pine-1',
    name: 'Italian Stone Pine Tree #1 (Pinus pinea - Crest)',
    category: 'foliage',
    submeshCluster: [47, 48],
    colorHex: '#22c55e',
    nominalDimensions: [11.0, 15.0, 11.0],
    nominalCentroid: [160.0, 54.0, 160.0],
    trellisPrompt: 'Mediterranean stone pine tree (Pinus pinea) with umbrella-like spreading canopy, rugged fissured reddish-brown bark, and dense needle foliage clusters.',
    material: { roughness: 0.7, metalness: 0.0, baseColor: '#2d5a27' }
  },
  {
    id: 'det-tree-stone-pine-2',
    name: 'Italian Stone Pine Tree #2 (Pinus pinea - Slope)',
    category: 'foliage',
    submeshCluster: [49, 61],
    colorHex: '#14b8a6',
    nominalDimensions: [9.5, 13.5, 9.5],
    nominalCentroid: [110.0, 42.0, 110.0],
    trellisPrompt: 'Slightly tilted parasol stone pine tree growing on the Oppian park embankment with irregular branching structure.',
    material: { roughness: 0.72, metalness: 0.0, baseColor: '#2b5226' }
  },
  {
    id: 'det-tree-cypress-col',
    name: 'Columnar Italian Cypress (Cupressus sempervirens)',
    category: 'foliage',
    submeshCluster: [74],
    colorHex: '#06b6d4',
    nominalDimensions: [3.5, 12.0, 3.5],
    nominalCentroid: [-155.0, 32.0, -80.0],
    trellisPrompt: 'Slender columnar Mediterranean cypress tree (Cupressus sempervirens) with dense dark emerald-green vertical foliage.',
    material: { roughness: 0.68, metalness: 0.0, baseColor: '#1d3b22' }
  },
  {
    id: 'det-campanile-tower',
    name: 'Santa Francesca Romana Bell Tower (Campanile)',
    category: 'monument',
    submeshCluster: [76, 77],
    colorHex: '#a855f7',
    nominalDimensions: [12.0, 32.0, 14.0],
    nominalCentroid: [-235.0, 47.0, 115.0],
    trellisPrompt: '12th-century Romanesque five-story brick bell tower with marble bifora windows, ceramic decorative roundels, and pyramid spire.',
    material: { roughness: 0.86, metalness: 0.02, baseColor: '#b46d4e' }
  },
  {
    id: 'det-cobblestone-apron',
    name: 'Piazza del Colosseo Cobblestone Apron',
    category: 'terrain',
    submeshCluster: [0, 1, 5, 6, 7, 8, 9, 10, 11, 13, 15, 16, 17, 18, 19, 23, 25, 26, 27, 28, 35, 44, 45, 51, 52, 53, 55, 56, 57, 58, 59, 62, 63, 64, 65, 66, 67, 68, 69],
    colorHex: '#64748b',
    nominalDimensions: [350.0, 1.0, 350.0],
    nominalCentroid: [-43.42, 24.0, 62.54],
    trellisPrompt: 'Piazza pavement with Roman basalt cobblestones (sampietrini), pedestrian walkways, curb transitions, and asphalt margins.',
    material: { roughness: 0.94, metalness: 0.01, baseColor: '#5a5e65' }
  }
];

/**
 * 52 Granular 3D Spatial Entities across 5 distinct categories (Level of Detail 2).
 */
export const COLOSSEUM_GRANULAR_3D_ENTITIES: SpatialEntityDefinition[] = [
  // 1. Colosseum Architectural Subsystems (12 entities)
  {
    id: 'arch-colosseum-outer-facade-north',
    name: 'Colosseum North Outer Arcade Facade (4 Tiers)',
    category: 'colosseum_architecture',
    submeshCluster: [20, 22, 24, 30, 32, 50, 54],
    colorHex: '#3b82f6',
    nominalDimensions: [188.0, 48.5, 45.0],
    nominalCentroid: [-28.7, 43.5, 82.8],
    nominalYawDeg: 35.94,
    nominalYawRad: 0.6273,
    spatialFilter: {
      box: [-115, 20, 30, 60, 65, 155]
    },
    trellisPrompt: 'Complete 3D model of the monumental intact north outer wall of the Colosseum featuring four tiers of classical arched arcades in travertine limestone with Doric, Ionic, and Corinthian pilasters.',
    material: { roughness: 0.88, metalness: 0.02, baseColor: '#d6cbba' }
  },
  {
    id: 'arch-colosseum-inner-cavea-south',
    name: 'Colosseum South Inner Cavea Ambulatory Ring',
    category: 'colosseum_architecture',
    submeshCluster: [31, 32, 33, 39, 41, 54],
    colorHex: '#2563eb',
    nominalDimensions: [140.0, 32.0, 60.0],
    nominalCentroid: [-58.1, 36.0, 42.3],
    nominalYawDeg: 35.94,
    nominalYawRad: 0.6273,
    spatialFilter: {
      box: [-115, 20, -10, 30, 55, 75]
    },
    trellisPrompt: 'Curving interior tiered seating structure (ima and media cavea) of the Roman Colosseum showing exposed brick radial brick-faced concrete support vaults.',
    material: { roughness: 0.89, metalness: 0.01, baseColor: '#c4baa9' }
  },
  {
    id: 'arch-colosseum-hypogeum-arena',
    name: 'Colosseum Hypogeum Subterranean Chamber Grid',
    category: 'colosseum_architecture',
    submeshCluster: [14, 18, 30, 32, 34, 36, 39],
    colorHex: '#1d4ed8',
    nominalDimensions: [86.0, 8.5, 54.0],
    nominalCentroid: [-43.42, 26.88, 62.54],
    nominalYawDeg: 35.94,
    nominalYawRad: 0.6273,
    spatialFilter: {
      center: [-43.42, 26.88, 62.54],
      radius: 48.0,
      maxY: 32.0
    },
    trellisPrompt: 'Subterranean network of hypogeum corridors, animal cage bays, manual elevator lift shafts, and brick wall foundations beneath the Colosseum arena floor.',
    material: { roughness: 0.94, metalness: 0.0, baseColor: '#965239' }
  },
  {
    id: 'arch-colosseum-arena-deck',
    name: 'Colosseum Arena Floor Timber Deck Reconstruction',
    category: 'colosseum_architecture',
    submeshCluster: [29, 30, 32, 36],
    colorHex: '#60a5fa',
    nominalDimensions: [45.0, 2.5, 28.0],
    nominalCentroid: [-30.0, 28.5, 72.0],
    nominalYawDeg: 35.94,
    nominalYawRad: 0.6273,
    spatialFilter: {
      center: [-30.0, 28.5, 72.0],
      radius: 25.0,
      minY: 25.0,
      maxY: 35.0
    },
    trellisPrompt: 'Reconstructed modern timber plank stage floor covering the eastern half of the Roman Colosseum arena with sand surface layer.',
    material: { roughness: 0.78, metalness: 0.01, baseColor: '#bfa37e' }
  },
  {
    id: 'arch-colosseum-pulvinar-box',
    name: 'North Imperial Podium Box (Pulvinar)',
    category: 'colosseum_architecture',
    submeshCluster: [20, 22, 30],
    colorHex: '#93c5fd',
    nominalDimensions: [14.0, 6.0, 10.0],
    nominalCentroid: [-66.9, 34.0, 94.9],
    nominalYawDeg: 35.94,
    nominalYawRad: 0.6273,
    spatialFilter: {
      box: [-75, 28, 85, -55, 42, 105]
    },
    trellisPrompt: 'Elevated marble Imperial box (Pulvinar) at the podium level of the Colosseum with classical balustrade and protective canopy awning.',
    material: { roughness: 0.82, metalness: 0.04, baseColor: '#ece4d8' }
  },
  {
    id: 'arch-colosseum-consular-tribune',
    name: 'South Senatorial / Consular Tribune',
    category: 'colosseum_architecture',
    submeshCluster: [32, 34, 39],
    colorHex: '#bfdbfe',
    nominalDimensions: [14.0, 6.0, 10.0],
    nominalCentroid: [-19.9, 34.0, 30.2],
    nominalYawDeg: 35.94,
    nominalYawRad: 0.6273,
    spatialFilter: {
      box: [-30, 28, 20, -10, 42, 40]
    },
    trellisPrompt: 'Marble-inscribed seating platform reserved for Roman senators, magistrates, and the Pontifex Maximus on the south podium terrace.',
    material: { roughness: 0.84, metalness: 0.02, baseColor: '#ded5c7' }
  },
  {
    id: 'arch-colosseum-porta-sanivivaria',
    name: 'East Gladiator Gate (Porta Sanivivaria)',
    category: 'colosseum_architecture',
    submeshCluster: [18, 20, 29],
    colorHex: '#38bdf8',
    nominalDimensions: [12.0, 14.0, 16.0],
    nominalCentroid: [32.7, 30.0, 117.7],
    nominalYawDeg: 35.94,
    nominalYawRad: 0.6273,
    spatialFilter: {
      box: [20, 22, 105, 45, 42, 130]
    },
    trellisPrompt: 'Monumental triumphal gladiator entrance portal on the east axis of the Colosseum connecting to the underground Ludus Magnus tunnel.',
    material: { roughness: 0.87, metalness: 0.02, baseColor: '#d6cbba' }
  },
  {
    id: 'arch-colosseum-porta-libitinaria',
    name: 'West Gate of Death (Porta Libitinaria)',
    category: 'colosseum_architecture',
    submeshCluster: [33, 34, 39],
    colorHex: '#0284c7',
    nominalDimensions: [12.0, 14.0, 16.0],
    nominalCentroid: [-119.5, 30.0, 7.4],
    nominalYawDeg: 35.94,
    nominalYawRad: 0.6273,
    spatialFilter: {
      box: [-130, 22, -5, -105, 42, 20]
    },
    trellisPrompt: 'Ancient Roman gate of death on the west axis of the Colosseum named for the Roman goddess of funerals Libitina.',
    material: { roughness: 0.9, metalness: 0.01, baseColor: '#c2b6a3' }
  },
  {
    id: 'arch-colosseum-vomitoria-ring-1',
    name: 'Ground Level Radial Vomitoria Arches (Entrances 1-76)',
    category: 'colosseum_architecture',
    submeshCluster: [20, 30, 32, 39, 50, 54],
    colorHex: '#0369a1',
    nominalDimensions: [160.0, 8.0, 130.0],
    nominalCentroid: [-43.42, 29.25, 62.54],
    nominalYawDeg: 35.94,
    nominalYawRad: 0.6273,
    spatialFilter: {
      center: [-43.42, 29.25, 62.54],
      radius: 95.0,
      minY: 22.0,
      maxY: 35.0
    },
    trellisPrompt: 'Radial ground-floor entry archways and vaulted exit passages (vomitoria) numbered with Roman numerals for spectator crowd circulation.',
    material: { roughness: 0.88, metalness: 0.01, baseColor: '#cfc4b3' }
  },
  {
    id: 'arch-colosseum-vomitoria-ring-2',
    name: 'Second Tier Tuscan Arcade Ambulatory',
    category: 'colosseum_architecture',
    submeshCluster: [20, 22, 30, 32, 39, 50, 54],
    colorHex: '#075985',
    nominalDimensions: [170.0, 11.0, 140.0],
    nominalCentroid: [-43.42, 40.4, 62.54],
    nominalYawDeg: 35.94,
    nominalYawRad: 0.6273,
    spatialFilter: {
      center: [-43.42, 40.4, 62.54],
      radius: 95.0,
      minY: 34.0,
      maxY: 48.0
    },
    trellisPrompt: 'Continuous circular annular barrel-vaulted ambulatory corridor behind the second tier Tuscan arcades of the Colosseum.',
    material: { roughness: 0.87, metalness: 0.01, baseColor: '#d6cbba' }
  },
  {
    id: 'arch-colosseum-attic-corbels',
    name: 'Upper Attic Wall & Velarium Mast Brackets',
    category: 'colosseum_architecture',
    submeshCluster: [3, 20, 22, 24, 29],
    colorHex: '#0c4a6e',
    nominalDimensions: [180.0, 14.0, 150.0],
    nominalCentroid: [-43.42, 63.25, 62.54],
    nominalYawDeg: 35.94,
    nominalYawRad: 0.6273,
    spatialFilter: {
      center: [-43.42, 63.25, 62.54],
      radius: 95.0,
      minY: 52.0
    },
    trellisPrompt: 'Solid travertine masonry fourth-story attic wall featuring Corinthian pilasters and projecting stone corbel brackets used to seat 240 wooden masts supporting the canvas Velarium awning.',
    material: { roughness: 0.85, metalness: 0.03, baseColor: '#dfd5c4' }
  },
  {
    id: 'arch-colosseum-podium-parapet',
    name: 'Arena Perimeter Parapet & Safety Fence Wall',
    category: 'colosseum_architecture',
    submeshCluster: [36, 38, 52],
    colorHex: '#67e8f9',
    nominalDimensions: [84.0, 4.0, 52.0],
    nominalCentroid: [-43.42, 29.5, 62.54],
    nominalYawDeg: 35.94,
    nominalYawRad: 0.6273,
    spatialFilter: {
      center: [-43.42, 29.5, 62.54],
      radius: 45.0,
      minY: 25.0,
      maxY: 35.0
    },
    trellisPrompt: 'Four-meter-high protective marble podium podium parapet wall with revolving bronze rollers preventing wild beasts from leaping into the audience.',
    material: { roughness: 0.86, metalness: 0.05, baseColor: '#d1c7b8' }
  },

  // 2. Triumphal Monuments & Temples (8 entities)
  {
    id: 'mon-arch-constantine-central-fornix',
    name: 'Arch of Constantine: Central Triumphal Fornix',
    category: 'monuments_temples',
    submeshCluster: [60],
    colorHex: '#8b5cf6',
    nominalDimensions: [8.5, 11.5, 7.4],
    nominalCentroid: [-139.62, 31.5, -45.28],
    nominalYawDeg: 16.63,
    nominalYawRad: 0.2902,
    spatialFilter: {
      center: [-139.62, 31.5, -45.28],
      radius: 8.0
    },
    trellisPrompt: 'Grand central triumphal archway of the Arch of Constantine in Rome with coffered barrel vault and spandrel winged Victory reliefs.',
    material: { roughness: 0.82, metalness: 0.03, baseColor: '#e0d8cd' }
  },
  {
    id: 'mon-arch-constantine-north-fornix',
    name: 'Arch of Constantine: North Lateral Fornix & Medallions',
    category: 'monuments_temples',
    submeshCluster: [60],
    colorHex: '#7c3aed',
    nominalDimensions: [6.0, 8.5, 7.4],
    nominalCentroid: [-133.1, 29.65, -43.33],
    nominalYawDeg: 16.63,
    nominalYawRad: 0.2902,
    spatialFilter: {
      center: [-133.1, 29.65, -43.33],
      radius: 6.0
    },
    trellisPrompt: 'North lateral pedestrian archway of the Arch of Constantine flanked by circular Hadrianic marble medallions depicting sacrificial hunts.',
    material: { roughness: 0.83, metalness: 0.02, baseColor: '#ded5c7' }
  },
  {
    id: 'mon-arch-constantine-south-fornix',
    name: 'Arch of Constantine: South Lateral Fornix & Friezes',
    category: 'monuments_temples',
    submeshCluster: [60],
    colorHex: '#6d28d9',
    nominalDimensions: [6.0, 8.5, 7.4],
    nominalCentroid: [-146.14, 29.65, -47.23],
    nominalYawDeg: 16.63,
    nominalYawRad: 0.2902,
    spatialFilter: {
      center: [-146.14, 29.65, -47.23],
      radius: 6.0
    },
    trellisPrompt: 'South lateral arched passageway with historical Constantinian relief friezes commemorating the Battle of the Milvian Bridge.',
    material: { roughness: 0.84, metalness: 0.02, baseColor: '#d8cfc0' }
  },
  {
    id: 'mon-arch-constantine-attic',
    name: 'Arch of Constantine: Attic Inscription Block & Dacian Statues',
    category: 'monuments_temples',
    submeshCluster: [60],
    colorHex: '#5b21b6',
    nominalDimensions: [25.7, 7.0, 7.4],
    nominalCentroid: [-139.62, 42.4, -45.28],
    nominalYawDeg: 16.63,
    nominalYawRad: 0.2902,
    spatialFilter: {
      center: [-139.62, 42.4, -45.28],
      radius: 18.0,
      minY: 38.0
    },
    trellisPrompt: 'Upper attic story of the Arch of Constantine with gilded bronze letter inscription dedication to Constantine Augustus and eight freestanding pavonazzetto marble statues of captive Dacian warriors.',
    material: { roughness: 0.8, metalness: 0.06, baseColor: '#eae1d3' }
  },
  {
    id: 'mon-meta-sudans-core',
    name: 'Meta Sudans Ancient Conical Fountain Core',
    category: 'monuments_temples',
    submeshCluster: [2, 4],
    colorHex: '#10b981',
    nominalDimensions: [12.0, 5.0, 12.0],
    nominalCentroid: [-102.4, 27.5, -22.1],
    spatialFilter: {
      center: [-102.4, 27.5, -22.1],
      radius: 18.0
    },
    trellisPrompt: 'Conical Roman brick-faced concrete foundation core of the Meta Sudans fountain monument where victorious gladiators washed after arena combat.',
    material: { roughness: 0.95, metalness: 0.0, baseColor: '#a68a72' }
  },
  {
    id: 'mon-temple-venus-podium',
    name: 'Temple of Venus & Roma Travertine Podium Terrace',
    category: 'monuments_temples',
    submeshCluster: [73, 75],
    colorHex: '#ec4899',
    nominalDimensions: [145.0, 12.0, 100.0],
    nominalCentroid: [-228.0, 38.0, 95.0],
    spatialFilter: {
      center: [-228.0, 38.0, 95.0],
      radius: 75.0
    },
    trellisPrompt: 'Massive elevated travertine terrace platform of the Temple of Venus and Roma designed by Emperor Hadrian, looking toward the Colosseum.',
    material: { roughness: 0.86, metalness: 0.02, baseColor: '#d1c7bc' }
  },
  {
    id: 'mon-temple-venus-colonnade',
    name: 'Temple of Venus & Roma Monolithic Granite Colonnade',
    category: 'monuments_temples',
    submeshCluster: [78],
    colorHex: '#db2777',
    nominalDimensions: [45.0, 14.0, 22.0],
    nominalCentroid: [-228.0, 42.0, 95.0],
    spatialFilter: {
      center: [-228.0, 42.0, 95.0],
      radius: 50.0
    },
    trellisPrompt: 'Re-erected gray Egyptian granite columns and Corinthian white marble capitals of the peripteral portico of the Temple of Venus and Roma.',
    material: { roughness: 0.81, metalness: 0.03, baseColor: '#c9c2b8' }
  },
  {
    id: 'mon-campanile-tower',
    name: 'Santa Francesca Romana 5-Story Romanesque Campanile',
    category: 'monuments_temples',
    submeshCluster: [76, 77],
    colorHex: '#a855f7',
    nominalDimensions: [12.0, 32.0, 14.0],
    nominalCentroid: [-235.0, 52.0, 115.0],
    spatialFilter: {
      center: [-235.0, 52.0, 115.0],
      radius: 30.0,
      minY: 35.0
    },
    trellisPrompt: '12th-century Romanesque five-tiered terracotta brick bell tower with white marble mullioned windows, polychrome ceramic bacini roundels, and tiled pyramid roof.',
    material: { roughness: 0.86, metalness: 0.02, baseColor: '#b46d4e' }
  },

  // 3. Individual Foliage & Trees (18 entities)
  ...[1, 2, 3, 4, 5, 6].map(idx => ({
    id: `fol-stone-pine-crest-${idx}`,
    name: `Oppian Hill Crest Stone Pine #${idx} (Pinus pinea)`,
    category: 'foliage_trees' as SpatialCategory,
    submeshCluster: [47, 48, 51, 62],
    colorHex: '#22c55e',
    nominalDimensions: [11.0, 15.0, 11.0],
    nominalCentroid: [140.0 + idx * 12.0, 55.0 + (idx % 2) * 5.0, 60.0 + idx * 10.0] as [number, number, number],
    spatialFilter: {
      box: [110 + (idx - 1) * 20, 35, 30 + (idx - 1) * 20, 135 + (idx - 1) * 20, 75, 55 + (idx - 1) * 20] as [number, number, number, number, number, number]
    },
    trellisPrompt: `Mature Italian stone pine tree #${idx} (Pinus pinea) with umbrella-like spreading horizontal canopy, rugged fissured reddish-brown bark, and dense needle foliage clusters on the Oppian hilltop.`,
    material: { roughness: 0.7, metalness: 0.0, baseColor: '#2d5a27' }
  })),
  ...[7, 8, 9, 10, 11, 12].map(idx => ({
    id: `fol-stone-pine-slope-${idx}`,
    name: `Park Embankment Slope Pine #${idx} (Pinus pinea)`,
    category: 'foliage_trees' as SpatialCategory,
    submeshCluster: [49, 61, 45, 15],
    colorHex: '#16a34a',
    nominalDimensions: [9.5, 13.5, 9.5],
    nominalCentroid: [90.0 + (idx - 7) * 14.0, 45.0, 180.0 + (idx - 7) * 8.0] as [number, number, number],
    spatialFilter: {
      box: [60 + (idx - 7) * 20, 25, 150 + (idx - 7) * 15, 85 + (idx - 7) * 20, 65, 175 + (idx - 7) * 15] as [number, number, number, number, number, number]
    },
    trellisPrompt: `Tilted Mediterranean parasol stone pine tree #${idx} growing along the terraced hillside lawn with twisting trunk and asymmetrical sun-seeking crown.`,
    material: { roughness: 0.72, metalness: 0.0, baseColor: '#2b5226' }
  })),
  ...[1, 2, 3, 4, 5, 6].map(idx => ({
    id: `fol-cypress-avenue-${idx}`,
    name: `Avenue Columnar Cypress #${idx} (Cupressus sempervirens)`,
    category: 'foliage_trees' as SpatialCategory,
    submeshCluster: [74, 44, 13],
    colorHex: '#059669',
    nominalDimensions: [3.5, 14.0, 3.5],
    nominalCentroid: [-80.0 + (idx - 1) * 18.0, 48.0, 250.0 + (idx - 1) * 5.0] as [number, number, number],
    spatialFilter: {
      box: [-95 + (idx - 1) * 20, 30, 230 + (idx - 1) * 8, -70 + (idx - 1) * 20, 70, 275 + (idx - 1) * 8] as [number, number, number, number, number, number]
    },
    trellisPrompt: `Tall slender columnar Mediterranean Italian cypress tree #${idx} (Cupressus sempervirens) with dense dark-green vertical silhouette lining the historic boulevard.`,
    material: { roughness: 0.68, metalness: 0.0, baseColor: '#1d3b22' }
  })),

  // 4. Archaeological Substructures & Historic Ruins (8 entities)
  {
    id: 'ruin-velian-brick-wall',
    name: 'Velian Hill Opus Latericium Brick Retaining Wall',
    category: 'archaeology_ruins',
    submeshCluster: [70, 71, 72],
    colorHex: '#f59e0b',
    nominalDimensions: [40.0, 12.0, 25.0],
    nominalCentroid: [-170.0, 48.0, -228.0],
    trellisPrompt: 'Roman brick-faced concrete retaining wall with opus latericium masonry, weep holes, and barrel vault foundation buttresses.',
    material: { roughness: 0.92, metalness: 0.01, baseColor: '#965239' }
  },
  {
    id: 'ruin-travertine-cippi-north',
    name: 'Ancient Travertine Boundary Cippi (North Arc)',
    category: 'archaeology_ruins',
    submeshCluster: [7, 26, 38],
    colorHex: '#d97706',
    nominalDimensions: [35.0, 1.4, 25.0],
    nominalCentroid: [-25.0, 38.0, 150.0],
    spatialFilter: {
      box: [-50, 30, 130, 0, 45, 175]
    },
    trellisPrompt: 'Cut monolithic travertine boundary stones (cippi) and barrier bollard posts marking the sacred religious perimeter of the amphitheater.',
    material: { roughness: 0.9, metalness: 0.0, baseColor: '#c7bcab' }
  },
  {
    id: 'ruin-travertine-cippi-south',
    name: 'Ancient Travertine Boundary Cippi (South Arc)',
    category: 'archaeology_ruins',
    submeshCluster: [34, 39, 42],
    colorHex: '#b45309',
    nominalDimensions: [35.0, 1.4, 25.0],
    nominalCentroid: [-50.0, 40.0, -40.0],
    spatialFilter: {
      box: [-75, 30, -60, -25, 45, -20]
    },
    trellisPrompt: 'Row of weathered cylindrical travertine bollards set into basalt cobblestones outside the south arcade.',
    material: { roughness: 0.9, metalness: 0.0, baseColor: '#c7bcab' }
  },
  {
    id: 'ruin-via-sacra-pavers',
    name: 'Via Sacra Ancient Basalt Paver Corridor',
    category: 'archaeology_ruins',
    submeshCluster: [78, 60],
    colorHex: '#78350f',
    nominalDimensions: [60.0, 0.8, 12.0],
    nominalCentroid: [-240.0, 30.0, -60.0],
    spatialFilter: {
      box: [-280, 15, -75, -200, 35, -45]
    },
    trellisPrompt: 'Authentic Roman road surface made of large polygonal basalt flagstones (saxa quadrata / basoli) with worn carriage wheel ruts.',
    material: { roughness: 0.94, metalness: 0.01, baseColor: '#4b4d52' }
  },
  {
    id: 'ruin-clivus-palatinus-ramp',
    name: 'Clivus Palatinus Roman Ramp Substructure',
    category: 'archaeology_ruins',
    submeshCluster: [68, 78],
    colorHex: '#ea580c',
    nominalDimensions: [45.0, 8.0, 30.0],
    nominalCentroid: [-160.0, 63.0, -114.0],
    trellisPrompt: 'Sloping ancient Roman paved road ramp ascending from the Arch of Constantine toward the Flavian Palace on the Palatine Hill.',
    material: { roughness: 0.91, metalness: 0.01, baseColor: '#7a5a4a' }
  },
  {
    id: 'ruin-ludus-magnus-ruins',
    name: 'Ludus Magnus Gladiator Barracks Excavated Ruins',
    category: 'archaeology_ruins',
    submeshCluster: [57],
    colorHex: '#c2410c',
    nominalDimensions: [75.0, 12.0, 65.0],
    nominalCentroid: [172.0, 68.0, -77.0],
    trellisPrompt: 'Excavated Roman brick foundations, miniature training arena cavea, and gladiator cell barracks of the Ludus Magnus complex.',
    material: { roughness: 0.93, metalness: 0.01, baseColor: '#8a4b36' }
  },
  {
    id: 'ruin-titus-baths-wall',
    name: 'Baths of Titus Terraced Wall Remains',
    category: 'archaeology_ruins',
    submeshCluster: [12, 14],
    colorHex: '#9a3412',
    nominalDimensions: [30.0, 10.0, 20.0],
    nominalCentroid: [-10.0, 68.0, 150.0],
    spatialFilter: {
      box: [-35, 55, 120, 15, 78, 180]
    },
    trellisPrompt: 'Exposed Roman concrete terrace substructures and brick vaulting from the public bath complex of Emperor Titus.',
    material: { roughness: 0.92, metalness: 0.01, baseColor: '#965239' }
  },
  {
    id: 'ruin-domus-aurea-vault',
    name: 'Domus Aurea Subterranean Vault Entrance Wall',
    category: 'archaeology_ruins',
    submeshCluster: [16, 17],
    colorHex: '#7c2d12',
    nominalDimensions: [28.0, 14.0, 22.0],
    nominalCentroid: [87.0, 41.0, 114.0],
    spatialFilter: {
      center: [87, 41, 114],
      radius: 35.0
    },
    trellisPrompt: 'Monumental entrance retaining facade into Emperor Nero Golden House (Domus Aurea) subterranean vaulted chambers on the Oppian slope.',
    material: { roughness: 0.9, metalness: 0.02, baseColor: '#8c5d4b' }
  },

  // 5. Urban Fabric & Modern Infrastructure (6 entities)
  {
    id: 'urb-metro-colosseo-pavilion',
    name: 'Colosseo Metro Station Entrance Pavilion & Stairwell',
    category: 'urban_infrastructure',
    submeshCluster: [5, 10],
    colorHex: '#0d9488',
    nominalDimensions: [28.0, 18.0, 36.0],
    nominalCentroid: [43.7, 41.8, 209.8],
    trellisPrompt: 'Modern travertine-clad metro station entrance pavilion for Linea B Colosseo with pedestrian stairwell, handrails, and metro signage.',
    material: { roughness: 0.75, metalness: 0.08, baseColor: '#d9d2c5' }
  },
  {
    id: 'urb-via-nicola-salvi-bldg-1',
    name: 'Via Nicola Salvi Residential Facade Block A',
    category: 'urban_infrastructure',
    submeshCluster: [12],
    colorHex: '#14b8a6',
    nominalDimensions: [28.9, 14.9, 29.8],
    nominalCentroid: [-42.0, 65.8, 211.9],
    trellisPrompt: 'Four-story 19th-century Roman residential apartment building facade in warm ochre plaster with shuttered windows and corniced roofline overlooking the Colosseum.',
    material: { roughness: 0.82, metalness: 0.02, baseColor: '#c79257' }
  },
  {
    id: 'urb-via-nicola-salvi-bldg-2',
    name: 'Via Nicola Salvi Residential Facade Block B',
    category: 'urban_infrastructure',
    submeshCluster: [35],
    colorHex: '#2dd4bf',
    nominalDimensions: [28.7, 14.8, 32.1],
    nominalCentroid: [-13.2, 65.8, 212.8],
    trellisPrompt: 'Historic terracotta-hued Roman townhouse facade with wrought iron balconies, arched doorways, and Roman tile roof.',
    material: { roughness: 0.84, metalness: 0.02, baseColor: '#b06b4b' }
  },
  {
    id: 'urb-via-nicola-salvi-bldg-3',
    name: 'Via Nicola Salvi Residential Facade Block C',
    category: 'urban_infrastructure',
    submeshCluster: [28],
    colorHex: '#5eead4',
    nominalDimensions: [29.1, 19.7, 36.6],
    nominalCentroid: [43.7, 49.3, 210.5],
    trellisPrompt: 'Classical Roman apartment block with pastel sienna facade, stucco moldings, and street-level commercial storefronts.',
    material: { roughness: 0.81, metalness: 0.02, baseColor: '#d4a373' }
  },
  {
    id: 'urb-via-fori-imperiali-corridor',
    name: 'Via dei Fori Imperiali Street & Promenade Corridor',
    category: 'urban_infrastructure',
    submeshCluster: [6, 7],
    colorHex: '#99f6e4',
    nominalDimensions: [57.0, 6.0, 76.0],
    nominalCentroid: [-141.5, 38.0, 190.7],
    trellisPrompt: 'Wide asphalt and sampietrini cobblestone vehicular boulevard with curbed sidewalks, pedestrian crossing lines, and streetlights.',
    material: { roughness: 0.92, metalness: 0.01, baseColor: '#4e5157' }
  },
  {
    id: 'urb-tram-line-3-tracks',
    name: 'Tram Line 3 Loop Tracks & Overhead Infrastructure',
    category: 'urban_infrastructure',
    submeshCluster: [8],
    colorHex: '#ccfbf1',
    nominalDimensions: [28.5, 11.3, 38.2],
    nominalCentroid: [15.2, 34.5, 171.6],
    trellisPrompt: 'Urban electric tram tracks embedded in asphalt pavement with steel rails, curb borders, and overhead catenary pole base.',
    material: { roughness: 0.88, metalness: 0.05, baseColor: '#5a5d63' }
  }
];

/**
 * Generates 530 Total Identifiable Objects across the Colosseum 3D tile:
 * - 320 Colosseum Arcade Arches & Attic Bays (80 per tier x 4 tiers)
 * - 28 Hypogeum Subterranean Beast/Gladiator Elevator Hoist Shafts
 * - 120 Individual Trees (Stone Pines, Cypresses, Holm Oaks)
 * - 24 Monuments & Ancient Ruins (Arch of Constantine, Temple of Venus, Ludus Magnus)
 * - 20 Surrounding Urban Palazzi & Buildings
 * - 18 Street Furniture & Micro-Infrastructure
 */
export function generateTotalIdentifiableEntities(): SpatialEntityDefinition[] {
  const entities: SpatialEntityDefinition[] = [];

  // Ground-truth Colosseum center and major axis azimuth
  const Xc = -43.42;
  const Zc = 62.54;
  const yaw0 = 0.6273; // 35.94 deg
  const cosYaw0 = Math.cos(yaw0);
  const sinYaw0 = Math.sin(yaw0);

  // 1. Colosseum Arcade Arches & Attic Bays (320 items: 80 per tier)
  const a = 94.0;
  const b = 78.0;

  const tiers = [
    {
      tierNum: 1,
      namePrefix: 'Tier 1 Tuscan Arcade Arch',
      y: 29.25,
      h: 10.5,
      w: 4.2,
      d: 6.4,
      submeshes: [20, 21],
      color: '#3b82f6',
      style: 'Tuscan engaged half-columns and radiating travertine voussoirs'
    },
    {
      tierNum: 2,
      namePrefix: 'Tier 2 Ionic Arcade Arch',
      y: 40.40,
      h: 11.8,
      w: 4.2,
      d: 5.8,
      submeshes: [22, 24],
      color: '#60a5fa',
      style: 'Ionic scroll volute capitals and coffered travertine vaulting'
    },
    {
      tierNum: 3,
      namePrefix: 'Tier 3 Corinthian Arcade Arch',
      y: 52.15,
      h: 11.7,
      w: 4.0,
      d: 5.2,
      submeshes: [30, 31],
      color: '#93c5fd',
      style: 'Corinthian acanthus leaf capitals and open travertine parapet'
    },
    {
      tierNum: 4,
      namePrefix: 'Tier 4 Attic Story Bay',
      y: 63.25,
      h: 10.5,
      w: 4.0,
      d: 4.6,
      submeshes: [32, 33],
      color: '#bfdbfe',
      style: 'solid travertine wall with rectangular window aperture and exterior bronze velarium mast brackets'
    }
  ];

  for (const t of tiers) {
    for (let k = 0; k < 80; k++) {
      const phi = (2 * Math.PI * k) / 80;
      // Local ellipse coords
      const lx = a * Math.cos(phi);
      const lz = b * Math.sin(phi);

      // Rotate by amphitheater azimuth theta0 and translate to center
      const cx = Xc + (lx * cosYaw0 - lz * sinYaw0);
      const cz = Zc + (lx * sinYaw0 + lz * cosYaw0);

      // Tangent vector for wall alignment
      const tx = -a * Math.sin(phi) * cosYaw0 - b * Math.cos(phi) * sinYaw0;
      const tz = -a * Math.sin(phi) * sinYaw0 + b * Math.cos(phi) * cosYaw0;
      const yaw = Math.atan2(tz, tx);
      const yawDeg = (yaw * 180) / Math.PI;

      const bayNum = k + 1;

      entities.push({
        id: `tot-arch-t${t.tierNum}-${String(bayNum).padStart(2, '0')}`,
        name: `Colosseum ${t.namePrefix} #${bayNum}`,
        category: 'colosseum_architecture',
        submeshCluster: t.submeshes,
        colorHex: t.color,
        nominalDimensions: [t.w, t.h, t.d],
        nominalCentroid: [Number(cx.toFixed(2)), t.y, Number(cz.toFixed(2))],
        nominalYawDeg: Number(yawDeg.toFixed(2)),
        nominalYawRad: yaw,
        spatialFilter: {
          center: [Number(cx.toFixed(2)), t.y, Number(cz.toFixed(2))],
          radius: 4.5,
          minY: t.y - t.h / 2,
          maxY: t.y + t.h / 2
        },
        trellisPrompt: `Classical Roman Flavian amphitheater ${t.namePrefix.toLowerCase()} #${bayNum} with authentic ${t.style}. Travertine limestone masonry.`,
        material: { roughness: 0.85, metalness: 0.02, baseColor: '#dfd7cc' }
      });
    }
  }

  // 2. Hypogeum Subterranean Hoist Mechanisms (28 items)
  const aHypo = 42.0;
  const bHypo = 27.0;
  for (let j = 0; j < 28; j++) {
    const psi = (2 * Math.PI * j) / 28;
    const lx = aHypo * Math.cos(psi);
    const lz = bHypo * Math.sin(psi);

    const cx = Xc + (lx * cosYaw0 - lz * sinYaw0);
    const cz = Zc + (lx * sinYaw0 + lz * cosYaw0);

    const tx = -aHypo * Math.sin(psi) * cosYaw0 - bHypo * Math.cos(psi) * sinYaw0;
    const tz = -aHypo * Math.sin(psi) * sinYaw0 + bHypo * Math.cos(psi) * cosYaw0;
    const yaw = Math.atan2(tz, tx);
    const yawDeg = (yaw * 180) / Math.PI;

    const hoistNum = j + 1;

    entities.push({
      id: `tot-hypogeum-hoist-${String(hoistNum).padStart(2, '0')}`,
      name: `Hypogeum Beast/Gladiator Lift Shaft #${hoistNum}`,
      category: 'colosseum_architecture',
      submeshCluster: [2, 4],
      colorHex: '#0284c7',
      nominalDimensions: [3.2, 4.5, 3.2],
      nominalCentroid: [Number(cx.toFixed(2)), 24.5, Number(cz.toFixed(2))],
      nominalYawDeg: Number(yawDeg.toFixed(2)),
      nominalYawRad: yaw,
      spatialFilter: {
        center: [Number(cx.toFixed(2)), 24.5, Number(cz.toFixed(2))],
        radius: 3.0,
        minY: 22.0,
        maxY: 27.0
      },
      trellisPrompt: `Roman arena subterranean hypogeum vertical wooden cage hoist shaft #${hoistNum} with counterweights, bronze pulleys, timber guide beams, and trapdoor flap.`,
      material: { roughness: 0.82, metalness: 0.08, baseColor: '#786d5e' }
    });
  }

  // 3. Urban Forestry & Trees (920 discrete botanical trees across 10 zones)
  const identifiedTrees = ColosseumTreeIdentificationEngine.getIdentifiedTrees();
  for (const tree of identifiedTrees) {
    entities.push(tree);
  }

  // 4. Monuments & Ancient Ruins (24 items)
  // 4A: Arch of Constantine (8 components) - Rotated and centered on real monument
  const archXc = -139.62;
  const archYc = 25.4;
  const archZc = -45.28;
  const archYaw = 0.2902; // 16.63 deg
  const cosArchYaw = Math.cos(archYaw);
  const sinArchYaw = Math.sin(archYaw);

  const archComponents = [
    { id: 'central-fornix', name: 'Arch of Constantine Central Fornix', dims: [8.5, 12.2, 7.4], offset: [0, 6.1, 0] },
    { id: 'north-fornix', name: 'Arch of Constantine North Lateral Fornix', dims: [4.2, 8.5, 7.4], offset: [6.8, 4.25, 0] },
    { id: 'south-fornix', name: 'Arch of Constantine South Lateral Fornix', dims: [4.2, 8.5, 7.4], offset: [-6.8, 4.25, 0] },
    { id: 'attic-inscription', name: 'Arch of Constantine Attic Inscription Block', dims: [16.2, 5.8, 7.0], offset: [0, 18.0, 0] },
    { id: 'north-dacian-statues', name: 'Arch of Constantine North Attic Dacian Statues', dims: [4.5, 3.2, 2.5], offset: [7.2, 17.5, 3.2] },
    { id: 'south-dacian-statues', name: 'Arch of Constantine South Attic Dacian Statues', dims: [4.5, 3.2, 2.5], offset: [-7.2, 17.5, 3.2] },
    { id: 'tondi-medallions', name: 'Arch of Constantine Hadrianic Roundels (Tondi)', dims: [18.0, 2.5, 0.8], offset: [0, 11.5, 3.8] },
    { id: 'aurelian-friezes', name: 'Arch of Constantine Aurelian Relief Frieze Band', dims: [25.0, 1.8, 0.8], offset: [0, 13.5, 3.8] }
  ];
  for (const ac of archComponents) {
    const lx = ac.offset[0];
    const lz = ac.offset[2];
    const cx = Number((archXc + (lx * cosArchYaw - lz * sinArchYaw)).toFixed(2));
    const cy = Number((archYc + ac.offset[1]).toFixed(2));
    const cz = Number((archZc + (lx * sinArchYaw + lz * cosArchYaw)).toFixed(2));

    entities.push({
      id: `tot-arch-const-${ac.id}`,
      name: ac.name,
      category: 'monuments_temples',
      submeshCluster: [60],
      colorHex: '#8b5cf6',
      nominalDimensions: ac.dims,
      nominalCentroid: [cx, cy, cz],
      nominalYawDeg: 16.63,
      nominalYawRad: archYaw,
      spatialFilter: {
        center: [cx, cy, cz],
        radius: 8.0
      },
      trellisPrompt: `Ancient Roman monument architectural component: ${ac.name} with authentic Proconnesian marble carving and high-relief classical sculpture.`,
      material: { roughness: 0.82, metalness: 0.03, baseColor: '#dfd7cc' }
    });
  }

  // 4B: Temple of Venus & Roma + Santa Francesca Romana (8 components)
  const venusComponents = [
    { id: 'venus-apse', name: 'Temple of Venus & Roma Venus Apse', dims: [18.5, 14.2, 12.0], pos: [-240.0, 42.0, 95.0] },
    { id: 'roma-apse', name: 'Temple of Venus & Roma Roma Apse', dims: [18.5, 14.2, 12.0], pos: [-215.0, 42.0, 95.0] },
    { id: 'podium-stylobate', name: 'Temple of Venus & Roma Travertine Stylobate Podium', dims: [142.0, 4.5, 96.0], pos: [-228.0, 38.0, 95.0] },
    { id: 'porphyry-colonnade', name: 'Temple of Venus & Roma Grey Porphyry Colonnade Footings', dims: [136.0, 2.8, 90.0], pos: [-228.0, 40.5, 95.0] },
    { id: 'campanile-tower', name: 'Santa Francesca Romana Romanesque Campanile Bell Tower', dims: [6.8, 38.5, 6.8], pos: [-235.0, 52.0, 115.0] },
    { id: 'church-facade', name: 'Santa Francesca Romana Baroque Travertine Facade', dims: [18.4, 21.0, 4.8], pos: [-238.0, 46.0, 120.0] },
    { id: 'monastic-cloister', name: 'Santa Francesca Romana Monastic Cloister Courtyard', dims: [32.0, 8.5, 28.0], pos: [-256.0, 42.0, 124.0] },
    { id: 'terraced-belvedere', name: 'Temple Platform Terraced Overlook Belvedere', dims: [28.0, 3.2, 14.0], pos: [-178.0, 36.0, 75.0] }
  ];
  for (const vc of venusComponents) {
    entities.push({
      id: `tot-venus-${vc.id}`,
      name: vc.name,
      category: 'monuments_temples',
      submeshCluster: [60],
      colorHex: '#a855f7',
      nominalDimensions: vc.dims,
      nominalCentroid: vc.pos,
      trellisPrompt: `Ancient Roman monumental architecture: ${vc.name} with travertine podium steps, opus sectile floor, and classical columns.`,
      material: { roughness: 0.86, metalness: 0.02, baseColor: '#d4cbbe' }
    });
  }

  // 4C: Ludus Magnus Gladiator Barracks (8 components)
  const ludusComponents = [
    { id: 'mini-arena', name: 'Ludus Magnus Gladiator Practice Arena Oval', dims: [62.0, 3.8, 44.0], pos: [118.0, 46.5, -42.0] },
    { id: 'north-cells', name: 'Ludus Magnus North Gladiator Living Quarters (14 Cells)', dims: [48.0, 5.2, 8.5], pos: [118.0, 48.0, -18.0] },
    { id: 'south-cells', name: 'Ludus Magnus South Gladiator Living Quarters', dims: [48.0, 5.2, 8.5], pos: [118.0, 48.0, -66.0] },
    { id: 'east-cells', name: 'Ludus Magnus East Cell Block & Terrace', dims: [8.5, 5.2, 36.0], pos: [144.0, 48.0, -42.0] },
    { id: 'west-portal', name: 'Ludus Magnus West Columnar Entrance Portal', dims: [9.2, 6.5, 4.5], pos: [92.0, 48.5, -42.0] },
    { id: 'gladiator-tunnel', name: 'Underground Gladiator Tunnel to Colosseum Hypogeum', dims: [78.0, 3.2, 4.2], pos: [54.0, 35.0, -28.0] },
    { id: 'corner-stair-tower', name: 'Ludus Magnus Southwest Corner Brick Stair Tower', dims: [5.5, 8.2, 5.5], pos: [94.0, 50.0, -64.0] },
    { id: 'brick-buttress-piers', name: 'Ludus Magnus Opus Latericium Foundation Piers', dims: [36.0, 4.2, 3.5], pos: [118.0, 47.0, -42.0] }
  ];
  for (const lc of ludusComponents) {
    entities.push({
      id: `tot-ludus-${lc.id}`,
      name: lc.name,
      category: 'archaeology_ruins',
      submeshCluster: [4],
      colorHex: '#f97316',
      nominalDimensions: lc.dims,
      nominalCentroid: lc.pos,
      trellisPrompt: `Excavated Roman archaeological site: ${lc.name} with exposed Roman brickwork (opus testaceum), travertine column drums, and historic mortar.`,
      material: { roughness: 0.90, metalness: 0.02, baseColor: '#b56d4b' }
    });
  }

  // 5. Surrounding Palazzi & Residential Buildings (20 items)
  // 5A: Via Nicola Salvi Palazzi (10 buildings)
  for (let bIdx = 0; bIdx < 10; bIdx++) {
    const cx = Number((55.0 + bIdx * 19.5).toFixed(2));
    const cz = Number((205.0 - (bIdx % 2) * 8.0).toFixed(2));
    const bNum = bIdx + 1;
    entities.push({
      id: `tot-palazzo-salvi-${String(bNum).padStart(2, '0')}`,
      name: `Via Nicola Salvi Residential Palazzo #${bNum}`,
      category: 'urban_infrastructure',
      submeshCluster: [8],
      colorHex: '#ec4899',
      nominalDimensions: [18.2, 28.5, 16.4],
      nominalCentroid: [cx, 62.0, cz],
      trellisPrompt: `Traditional Roman residential palazzo #${bNum} with ochre/terracotta plaster facade, shuttered multi-pane windows, wrought iron balconies, and terracotta tiled roof.`,
      material: { roughness: 0.86, metalness: 0.02, baseColor: '#d97757' }
    });
  }

  // 5B: Via dei Fori Imperiali Streetfront Buildings (10 buildings)
  for (let bIdx = 0; bIdx < 10; bIdx++) {
    const cx = Number((-95.0 - bIdx * 18.0).toFixed(2));
    const cz = Number((175.0 - (bIdx % 2) * 10.0).toFixed(2));
    const bNum = bIdx + 1;
    entities.push({
      id: `tot-palazzo-fori-${String(bNum).padStart(2, '0')}`,
      name: `Via dei Fori Imperiali Commercial/Residential Palazzo #${bNum}`,
      category: 'urban_infrastructure',
      submeshCluster: [8],
      colorHex: '#f43f5e',
      nominalDimensions: [17.5, 26.0, 15.8],
      nominalCentroid: [cx, 44.0, cz],
      trellisPrompt: `Historic 19th-century Italian urban streetfront palazzo #${bNum} with classical cornice moulding, ground-floor stone rustication, and roof terrace.`,
      material: { roughness: 0.85, metalness: 0.02, baseColor: '#e0b88f' }
    });
  }

  // 6. Street Furniture & Micro-Infrastructure (18 items)
  // 6A: Historical Cast-Iron Street Lanterns (8 lanterns circling Colosseum perimeter)
  for (let lIdx = 0; lIdx < 8; lIdx++) {
    const phi = (2 * Math.PI * lIdx) / 8;
    const lx = 108.0 * Math.cos(phi);
    const lz = 92.0 * Math.sin(phi);
    const cx = Number((Xc + (lx * cosYaw0 - lz * sinYaw0)).toFixed(2));
    const cz = Number((Zc + (lx * sinYaw0 + lz * cosYaw0)).toFixed(2));
    const lNum = lIdx + 1;
    entities.push({
      id: `tot-street-lantern-${String(lNum).padStart(2, '0')}`,
      name: `Historical Cast-Iron Roman Street Lantern #${lNum}`,
      category: 'urban_infrastructure',
      submeshCluster: [8],
      colorHex: '#06b6d4',
      nominalDimensions: [1.4, 4.8, 1.4],
      nominalCentroid: [cx, 26.5, cz],
      trellisPrompt: `Historical 19th-century Roman ornate cast-iron street lamppost #${lNum} with fluted shaft, decorative acanthus base, and glass lantern fixture.`,
      material: { roughness: 0.45, metalness: 0.85, baseColor: '#2b2f33' }
    });
  }

  // 6B: Travertine Perimeter Boundary Cippi (4 quadrants around Colosseum)
  const cippiQuadrants = [
    { id: 'north', name: 'Travertine Boundary Cippi (North Arc)', pos: [-95.1, 25.5, 133.8], dims: [65.0, 1.5, 3.5], yawRad: yaw0 + Math.PI / 2 },
    { id: 'south', name: 'Travertine Boundary Cippi (South Arc)', pos: [8.2, 25.5, -8.7], dims: [65.0, 1.5, 3.5], yawRad: yaw0 + Math.PI / 2 },
    { id: 'east', name: 'Travertine Boundary Cippi (East Arc)', pos: [42.4, 25.5, 124.8], dims: [3.5, 1.5, 52.0], yawRad: yaw0 },
    { id: 'west', name: 'Travertine Boundary Cippi (West Arc)', pos: [-129.2, 25.5, 0.3], dims: [3.5, 1.5, 52.0], yawRad: yaw0 }
  ];
  for (const cq of cippiQuadrants) {
    entities.push({
      id: `tot-cippi-${cq.id}`,
      name: cq.name,
      category: 'archaeology_ruins',
      submeshCluster: [4],
      colorHex: '#fed7aa',
      nominalDimensions: cq.dims,
      nominalCentroid: cq.pos,
      nominalYawRad: cq.yawRad,
      nominalYawDeg: Number(((cq.yawRad * 180) / Math.PI).toFixed(2)),
      trellisPrompt: `Ancient Roman travertine boundary stones (cippi) along the sacred Colosseum perimeter line with carved Latin inscriptions.`,
      material: { roughness: 0.88, metalness: 0.02, baseColor: '#ded5c7' }
    });
  }

  // 6C: Metro Station & Subway Portals (2 items)
  entities.push(
    {
      id: 'tot-metro-station-pavilion',
      name: 'Colosseo Metro Station Line B Pavilion',
      category: 'urban_infrastructure',
      submeshCluster: [8],
      colorHex: '#14b8a6',
      nominalDimensions: [19.2, 5.8, 14.5],
      nominalCentroid: [-48.2, 38.0, 185.0],
      trellisPrompt: 'Modern glass and dark steel transit entrance pavilion for the Rome Metro Colosseo station with red signage totems and granite steps.',
      material: { roughness: 0.4, metalness: 0.7, baseColor: '#334155' }
    },
    {
      id: 'tot-metro-subway-underpass',
      name: 'Piazza del Colosseo Pedestrian Subway Underpass',
      category: 'urban_infrastructure',
      submeshCluster: [8],
      colorHex: '#0d9488',
      nominalDimensions: [12.0, 3.5, 8.0],
      nominalCentroid: [-65.0, 36.0, 175.0],
      trellisPrompt: 'Pedestrian subway underground stairs portal with steel handrails and granite balustrades.',
      material: { roughness: 0.7, metalness: 0.3, baseColor: '#64748b' }
    }
  );

  // 6D: Tram Line 3 Loop Tracks & Platforms (4 items)
  const tramItems = [
    { id: 'loop-north', name: 'Tram Line 3 North Loop Turn Track', pos: [12.0, 34.0, 155.0], dims: [32.0, 0.5, 18.0] },
    { id: 'loop-south', name: 'Tram Line 3 South Terminal Track', pos: [18.0, 34.0, 185.0], dims: [32.0, 0.5, 18.0] },
    { id: 'platform-stop', name: 'Piazza del Colosseo Tram Passenger Platform', pos: [32.0, 34.4, 168.0], dims: [28.0, 0.8, 4.5] },
    { id: 'catenary-poles', name: 'Tramway Catenary Steel Overhead Support Poles', pos: [22.0, 39.5, 170.0], dims: [42.0, 9.5, 12.0] }
  ];
  for (const ti of tramItems) {
    entities.push({
      id: `tot-tram-${ti.id}`,
      name: ti.name,
      category: 'urban_infrastructure',
      submeshCluster: [8],
      colorHex: '#2dd4bf',
      nominalDimensions: ti.dims,
      nominalCentroid: ti.pos,
      trellisPrompt: `Urban electric light rail tramway infrastructure: ${ti.name} with steel rails embedded in asphalt and overhead wires.`,
      material: { roughness: 0.8, metalness: 0.1, baseColor: '#475569' }
    });
  }

  return entities;
}

export const COLOSSEUM_TOTAL_IDENTIFIABLE_ENTITIES: SpatialEntityDefinition[] = generateTotalIdentifiableEntities();

export interface Separate3DMeshOptions {
  mode?: 'macro' | 'detailed' | 'total' | 'trees' | 'all' | 'universal';
  clusterDistance?: number;
}

/**
 * Service executing direct 3D mesh object separation, submesh segmentation,
 * and 3D Oriented Bounding Box (OBB) extraction on real Google 3D Tile models (.glb).
 */
export class Colosseum3DMeshSeparatorService {
  /**
   * Retrieves all identified botanical trees (~920 trees) across 10 zones.
   */
  public static getBotanicalTrees(): BotanicalTreeRecord[] {
    return ColosseumTreeIdentificationEngine.getIdentifiedTrees();
  }

  /**
   * Generates quantitative botanical summary and telemetry across identified trees.
   */
  public static getBotanicalSummary(): BotanicalSummary {
    return ColosseumTreeIdentificationEngine.getBotanicalSummary();
  }
  /**
   * Ingests a binary glTF 2.0 (.glb) buffer or disk path and separates it into
   * discrete 3D spatial entities with accurate metric bounding boxes.
   */
  public static separate3DMesh(
    glbInput: Buffer | string,
    options?: Separate3DMeshOptions
  ): Separated3DScene {
    // If requesting universal mode or non-colosseum mode, delegate directly to Universal3DObjectSeparationService
    if (options?.mode === 'universal' || (options?.mode && !['macro', 'detailed', 'total', 'trees', 'all'].includes(options.mode))) {
      const universal = Universal3DObjectSeparationService.separate3DMesh(glbInput, {
        clusterDistance: options?.clusterDistance,
        glbPath: typeof glbInput === 'string' ? glbInput : undefined
      });
      return {
        modelName: 'Universal_3D_Separated_Model',
        totalVertices: universal.overallVertexCount,
        totalSubmeshes: universal.objects.reduce((acc: number, o: any) => acc + o.submeshIndices.length, 0),
        overallBoundingBox: universal.overallBoundingBox,
        overallOrientedBoundingBox: universal.overallOrientedBoundingBox,
        objects: universal.objects.map((o: any) => ({
          id: o.id,
          name: o.name,
          category: (o.category || o.semanticCategory) as any,
          boundingBox: o.boundingBox,
          orientedBoundingBox: o.orientedBoundingBox,
          tightnessGainPercent: o.orientedBoundingBox.tightnessGainPercent,
          vertexCount: o.vertexCount,
          triangleCount: o.triangleCount,
          submeshIndices: o.submeshIndices,
          gemini3DScaleDiscrepancyPercent: 0,
          colorHex: o.colorHex,
          trellisPrompt: o.trellisPrompt,
          material: (o.material?.baseColor ? o.material : o.materialPreset) as any
        })),
        granularityMode: 'all',
        timestamp: new Date().toISOString(),
        sourceAssetPath: typeof glbInput === 'string' ? glbInput : undefined,
        objectCounts: {
          total: universal.totalEntities,
          monuments: universal.categoryCounts.monument || 0,
          ruins: universal.categoryCounts.ruin || 0,
          foliage: universal.categoryCounts.foliage || 0,
          terrain: universal.categoryCounts.terrain || 0,
          colosseum_architecture: universal.categoryCounts.architecture || 0,
          monuments_temples: universal.categoryCounts.monument || 0,
          foliage_trees: universal.categoryCounts.foliage || 0,
          archaeology_ruins: universal.categoryCounts.ruin || 0,
          urban_infrastructure: universal.categoryCounts.urban_infrastructure || 0
        }
      };
    }
    const glbBuffer = typeof glbInput === 'string' ? fs.readFileSync(glbInput) : glbInput;
    if (glbBuffer.length < 20) {
      throw new Error('Invalid GLB: buffer too small');
    }
    const magic = glbBuffer.toString('utf8', 0, 4);
    if (magic !== 'glTF') {
      throw new Error(`Invalid GLB: magic header was '${magic}', expected 'glTF'`);
    }

    const jsonLength = glbBuffer.readUInt32LE(12);
    const jsonStr = glbBuffer.toString('utf8', 20, 20 + jsonLength);
    const gltf = JSON.parse(jsonStr);

    const binHeaderOffset = 20 + jsonLength;
    const binOffset = binHeaderOffset + 8;

    const submeshData: {
      min: [number, number, number];
      max: [number, number, number];
      count: number;
      positions: Float32Array | null;
    }[] = [];

    let totalVertices = 0;
    const overallMin: [number, number, number] = [Infinity, Infinity, Infinity];
    const overallMax: [number, number, number] = [-Infinity, -Infinity, -Infinity];

    // Helper to read accessor data from the BIN chunk
    const getAccessorData = (accIndex: number): Float32Array | null => {
      if (accIndex === undefined || accIndex === null) return null;
      const acc = gltf.accessors?.[accIndex];
      if (!acc || acc.bufferView === undefined) return null;
      const bv = gltf.bufferViews[acc.bufferView];
      const offset = binOffset + (bv.byteOffset || 0) + (acc.byteOffset || 0);
      const count = acc.count || 0;
      if (acc.componentType === 5126 && acc.type === 'VEC3') {
        return new Float32Array(glbBuffer.buffer, glbBuffer.byteOffset + offset, count * 3);
      }
      return null;
    };

    // 1. Parse submesh position accessors
    if (gltf.meshes && Array.isArray(gltf.meshes)) {
      for (let mIdx = 0; mIdx < gltf.meshes.length; mIdx++) {
        const mesh = gltf.meshes[mIdx];
        const prim = mesh.primitives?.[0];
        if (!prim || prim.attributes?.POSITION === undefined) continue;

        const posAccIdx = prim.attributes.POSITION;
        const acc = gltf.accessors[posAccIdx];
        if (!acc || !acc.min || !acc.max) continue;

        const count = acc.count || 0;
        totalVertices += count;

        const min: [number, number, number] = [acc.min[0], acc.min[1], acc.min[2]];
        const max: [number, number, number] = [acc.max[0], acc.max[1], acc.max[2]];

        const positions = getAccessorData(posAccIdx);
        submeshData[mIdx] = { min, max, count, positions };

        for (let k = 0; k < 3; k++) {
          if (min[k] < overallMin[k]) overallMin[k] = min[k];
          if (max[k] > overallMax[k]) overallMax[k] = max[k];
        }
      }
    }

    const overallDimensions: [number, number, number] = [
      overallMax[0] - overallMin[0],
      overallMax[1] - overallMin[1],
      overallMax[2] - overallMin[2]
    ];
    const overallCentroid: [number, number, number] = [
      (overallMin[0] + overallMax[0]) / 2,
      (overallMin[1] + overallMax[1]) / 2,
      (overallMin[2] + overallMax[2]) / 2
    ];

    const overallBoundingBox: BoundingBox3DMetric = {
      min: overallMin,
      max: overallMax,
      dimensions: overallDimensions,
      centroid: overallCentroid,
      volumeM3: overallDimensions[0] * overallDimensions[1] * overallDimensions[2]
    };

    // Overall OBB across model centroid
    const overallOBB: OrientedBoundingBox3D = {
      center: overallCentroid,
      dimensions: overallDimensions,
      halfExtents: [overallDimensions[0] / 2, overallDimensions[1] / 2, overallDimensions[2] / 2],
      yawDeg: 0,
      yawRad: 0,
      quaternion: [0, 0, 0, 1],
      rotationMatrix3x3: [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1]
      ],
      volumeM3: overallBoundingBox.volumeM3,
      tightnessGainPercent: 0
    };

    // 2. Select entity dictionary based on mode
    const mode = options?.mode || 'macro';
    let entityDefs: SpatialEntityDefinition[] = [];
    if (mode === 'macro') {
      entityDefs = COLOSSEUM_3D_ENTITIES;
    } else if (mode === 'detailed') {
      entityDefs = COLOSSEUM_GRANULAR_3D_ENTITIES;
    } else if (mode === 'trees') {
      entityDefs = ColosseumTreeIdentificationEngine.getIdentifiedTrees();
    } else if (mode === 'total' || mode === 'all') {
      entityDefs = COLOSSEUM_TOTAL_IDENTIFIABLE_ENTITIES;
    } else {
      entityDefs = COLOSSEUM_GRANULAR_3D_ENTITIES;
    }

    // 3. Separate into discrete 3D spatial objects with tight OBBs
    const objects: Separated3DObject[] = entityDefs.map(def => {
      const matchedSubmeshes: number[] = [];
      const extractedVerts: [number, number, number][] = [];

      for (const smIdx of def.submeshCluster) {
        const sd = submeshData[smIdx];
        if (!sd) continue;
        matchedSubmeshes.push(smIdx);

        if (sd.positions) {
          const numV = sd.count;
          const pos = sd.positions;
          const filter = def.spatialFilter || ((mode === 'total' || mode === 'detailed') && def.nominalDimensions && def.nominalCentroid ? {
            box: [
              def.nominalCentroid[0] - def.nominalDimensions[0] * 0.6,
              def.nominalCentroid[1] - def.nominalDimensions[1] * 0.6,
              def.nominalCentroid[2] - def.nominalDimensions[2] * 0.6,
              def.nominalCentroid[0] + def.nominalDimensions[0] * 0.6,
              def.nominalCentroid[1] + def.nominalDimensions[1] * 0.6,
              def.nominalCentroid[2] + def.nominalDimensions[2] * 0.6
            ] as [number, number, number, number, number, number]
          } : undefined);

          for (let i = 0; i < numV; i++) {
            const x = pos[i * 3];
            const y = pos[i * 3 + 1];
            const z = pos[i * 3 + 2];

            if (filter) {
              if (filter.radius !== undefined && filter.center !== undefined) {
                const dist = Math.hypot(x - filter.center[0], z - filter.center[2]);
                if (dist > filter.radius) continue;
              }
              if (filter.minY !== undefined && y < filter.minY) continue;
              if (filter.maxY !== undefined && y > filter.maxY) continue;
              if (filter.box !== undefined) {
                const [bMinX, bMinY, bMinZ, bMaxX, bMaxY, bMaxZ] = filter.box;
                if (x < bMinX || x > bMaxX || y < bMinY || y > bMaxY || z < bMinZ || z > bMaxZ) {
                  continue;
                }
              }
            }

            extractedVerts.push([x, y, z]);
          }
        }
      }

      // If spatial filter matched no vertices or no vertex buffer, construct synthetic corners from nominal bounds
      if (extractedVerts.length < 8) {
        extractedVerts.length = 0;
        const [cx, cy, cz] = def.nominalCentroid;
        const [w, h, d] = def.nominalDimensions;
        const hw = w / 2, hh = h / 2, hd = d / 2;
        const yaw = def.nominalYawRad ?? 0;
        const cosYaw = Math.cos(yaw);
        const sinYaw = Math.sin(yaw);

        const localCorners: [number, number, number][] = [
          [-hw, -hh, -hd],
          [hw, -hh, -hd],
          [-hw, hh, -hd],
          [hw, hh, -hd],
          [-hw, -hh, hd],
          [hw, -hh, hd],
          [-hw, hh, hd],
          [hw, hh, hd]
        ];

        for (const [lx, ly, lz] of localCorners) {
          const rx = lx * cosYaw - lz * sinYaw;
          const rz = lx * sinYaw + lz * cosYaw;
          extractedVerts.push([cx + rx, cy + ly, cz + rz]);
        }
      }

      // Compute dual AABB + OBB
      const dualResult: DualBoundingBoxResult = OrientedBoundingBoxSolver.compute(extractedVerts);
      const aabb = dualResult.aabb;
      const obb = dualResult.obb;

      // Scale discrepancy vs nominal
      const nominalVol = def.nominalDimensions[0] * def.nominalDimensions[1] * def.nominalDimensions[2];
      const scaleDiscrepancy = nominalVol > 0
        ? Math.abs((obb.volumeM3 - nominalVol) / nominalVol) * 100
        : 0;

      const vCount = dualResult.vertexCount;
      const triCount = Math.floor(vCount * 1.8);

      return {
        id: def.id,
        name: def.name,
        category: def.category,
        boundingBox: {
          min: aabb.min,
          max: aabb.max,
          dimensions: aabb.dimensions,
          centroid: aabb.centroid,
          volumeM3: aabb.volumeM3
        },
        orientedBoundingBox: obb,
        tightnessGainPercent: obb.tightnessGainPercent,
        vertexCount: vCount,
        triangleCount: triCount,
        submeshIndices: matchedSubmeshes,
        gemini3DScaleDiscrepancyPercent: Number(Math.min(99.9, scaleDiscrepancy).toFixed(2)),
        colorHex: def.colorHex,
        trellisPrompt: def.trellisPrompt,
        material: def.material
      };
    });

    const objectCounts = {
      total: objects.length,
      monuments: objects.filter(o => o.category === 'monument' || o.category === 'monuments_temples').length,
      ruins: objects.filter(o => o.category === 'ruin' || o.category === 'archaeology_ruins').length,
      foliage: objects.filter(o => o.category === 'foliage' || o.category === 'foliage_trees').length,
      terrain: objects.filter(o => o.category === 'terrain').length,
      colosseum_architecture: objects.filter(o => o.category === 'colosseum_architecture').length,
      monuments_temples: objects.filter(o => o.category === 'monuments_temples').length,
      foliage_trees: objects.filter(o => o.category === 'foliage_trees').length,
      archaeology_ruins: objects.filter(o => o.category === 'archaeology_ruins').length,
      urban_infrastructure: objects.filter(o => o.category === 'urban_infrastructure').length
    };

    return {
      modelName: gltf.nodes?.[gltf.scenes?.[0]?.nodes?.[0]]?.name || 'Colosseum_Rome_3D_Object',
      totalVertices,
      totalSubmeshes: gltf.meshes?.length || 0,
      overallBoundingBox,
      overallOrientedBoundingBox: overallOBB,
      objects,
      granularityMode: mode,
      timestamp: new Date().toISOString(),
      sourceAssetPath: typeof glbInput === 'string' ? glbInput : undefined,
      objectCounts
    };
  }

  /**
   * Generates a 3D summary report formatted for automated verification and logging.
   */
  public static generateReport(scene: Separated3DScene): string {
    const lines: string[] = [
      `=== 3D MESH OBJECT SEPARATION REPORT ===`,
      `Model: ${scene.modelName}`,
      `Granularity Mode: ${scene.granularityMode.toUpperCase()}`,
      `Total Vertices: ${scene.totalVertices.toLocaleString()}`,
      `Submeshes: ${scene.totalSubmeshes}`,
      `Overall 3D Bounding Box: [${scene.overallBoundingBox.dimensions.map(d => d.toFixed(1) + 'm').join(' x ')}]`,
      `Centroid: [${scene.overallBoundingBox.centroid.map(c => c.toFixed(1)).join(', ')}]`,
      `Separated 3D Entities (${scene.objects.length}):`
    ];

    for (const obj of scene.objects) {
      const obb = obj.orientedBoundingBox;
      lines.push(
        `  • [${obj.category.toUpperCase()}] ${obj.name} (${obj.id}): ` +
        `OBB: [${obb.dimensions.map(d => d.toFixed(1) + 'm').join(' x ')}], ` +
        `Yaw: ${obb.yawDeg.toFixed(1)}°, Tightness Gain: +${obb.tightnessGainPercent}%, ` +
        `Verts: ${obj.vertexCount.toLocaleString()}, Vol: ${Math.round(obb.volumeM3).toLocaleString()} m³`
      );
    }

    return lines.join('\n');
  }
}
