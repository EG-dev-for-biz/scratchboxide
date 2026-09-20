import * as THREE from 'three';
import {
  analyzeTextureAutocorrelation,
  calibrateNormalScaleFromRgba,
  classifyGeometrySurfaces,
  ArchitecturalZone,
  UniversalTextureInducer,
} from '../packages/core/src/browser/generative-canvas/services/UniversalTextureInducer';

console.log('Testing Universal Texture Inducer (TypeScript)...');

// 1. Synthesize 256x256 Roman brick image buffer (course height 16px, brick width 64px)
const W = 256;
const H = 256;
const rgba = new Uint8Array(W * H * 4);

for (let y = 0; y < H; y++) {
  const courseIdx = Math.floor(y / 16);
  const isHorizMortar = y % 16 < 2;

  for (let x = 0; x < W; x++) {
    const xOffset = courseIdx % 2 === 0 ? 0 : 32;
    const isVertMortar = (x + xOffset) % 64 < 2;

    const idx = (y * W + x) * 4;
    if (isHorizMortar || isVertMortar) {
      rgba[idx] = 90;
      rgba[idx + 1] = 90;
      rgba[idx + 2] = 95;
      rgba[idx + 3] = 255;
    } else {
      rgba[idx] = 210;
      rgba[idx + 1] = 175;
      rgba[idx + 2] = 130;
      rgba[idx + 3] = 255;
    }
  }
}

// 2. Test Autocorrelation
const profile = analyzeTextureAutocorrelation(W, H, rgba, 2.0);
console.log('-> Autocorrelation Profile:', {
  isPeriodic: profile.isPeriodic,
  dominantPeriodX: profile.dominantPeriodX,
  dominantPeriodY: profile.dominantPeriodY,
  aspectRatio: profile.aspectRatio,
  module: `${profile.physicalModuleWidthMeters}m x ${profile.physicalModuleHeightMeters}m`,
  repeats: `(${profile.recommendedRepeatU}, ${profile.recommendedRepeatV})`,
});

if (!profile.isPeriodic || profile.dominantPeriodY === 0) {
  throw new Error('Failed to detect texture periodicity');
}

// 3. Synthesize Normal Map and test Adaptive Normal Scale Calibration
const normalRgba = new Uint8Array(W * H * 4);
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const idx = (y * W + x) * 4;
    const lumaL = rgba[(y * W + Math.max(0, x - 1)) * 4];
    const lumaR = rgba[(y * W + Math.min(W - 1, x + 1)) * 4];
    const lumaD = rgba[(Math.max(0, y - 1) * W + x) * 4];
    const lumaU = rgba[(Math.min(H - 1, y + 1) * W + x) * 4];

    const dx = (lumaR - lumaL) / 255.0;
    const dy = (lumaU - lumaD) / 255.0;

    const len = Math.sqrt(dx * dx + dy * dy + 1.0);
    normalRgba[idx] = Math.floor(((-dx / len) * 0.5 + 0.5) * 255);
    normalRgba[idx + 1] = Math.floor(((-dy / len) * 0.5 + 0.5) * 255);
    normalRgba[idx + 2] = Math.floor(((1.0 / len) * 0.5 + 0.5) * 255);
    normalRgba[idx + 3] = 255;
  }
}

const normCalib = calibrateNormalScaleFromRgba(W, H, normalRgba);
console.log('-> Normal Scale Calibrated:', {
  gradientVariance: normCalib.gradientVariance,
  recommendedNormalScale: normCalib.recommendedNormalScale,
  recommendedAoIntensity: normCalib.recommendedAoIntensity,
});

if (normCalib.recommendedNormalScale < 1.2 || normCalib.recommendedNormalScale > 3.2) {
  throw new Error(`Unexpected normal scale: ${normCalib.recommendedNormalScale}`);
}

// 4. Test Semantic Surface Classification on Compound Architecture
const plinthGeom = new THREE.BoxGeometry(22, 4, 22);
plinthGeom.translate(0, 2, 0);

const shaftGeom = new THREE.BoxGeometry(18, 50, 18);
shaftGeom.translate(0, 29, 0);

// Combine into single BufferGeometry
const pos1 = plinthGeom.getAttribute('position');
const norm1 = plinthGeom.getAttribute('normal');
const pos2 = shaftGeom.getAttribute('position');
const norm2 = shaftGeom.getAttribute('normal');

const combinedPos = new Float32Array(pos1.array.length + pos2.array.length);
combinedPos.set(pos1.array, 0);
combinedPos.set(pos2.array, pos1.array.length);

const combinedNorm = new Float32Array(norm1.array.length + norm2.array.length);
combinedNorm.set(norm1.array, 0);
combinedNorm.set(norm2.array, norm1.array.length);

const buildingGeom = new THREE.BufferGeometry();
buildingGeom.setAttribute('position', new THREE.BufferAttribute(combinedPos, 3));
buildingGeom.setAttribute('normal', new THREE.BufferAttribute(combinedNorm, 3));

const surfaceClassification = classifyGeometrySurfaces(buildingGeom, {
  groundDatumY: 0,
  plinthHeightMeters: 4.0,
});

console.log('-> Surface Classification Zone Counts:', surfaceClassification.zoneCounts);

if (surfaceClassification.zoneCounts[ArchitecturalZone.GroundPlinth] === 0) {
  throw new Error('Failed to classify GroundPlinth faces');
}
if (surfaceClassification.zoneCounts[ArchitecturalZone.MainShaft] === 0) {
  throw new Error('Failed to classify MainShaft faces');
}
if (surfaceClassification.zoneCounts[ArchitecturalZone.HorizontalDeck] === 0) {
  throw new Error('Failed to classify HorizontalDeck faces');
}

// 5. Test Universal PBR Application
const mesh = new THREE.Mesh(buildingGeom, new THREE.MeshStandardMaterial());
UniversalTextureInducer.applyUniversalPbrToMesh(mesh, {});
const appliedMat = mesh.material as THREE.MeshStandardMaterial;

console.log('-> Applied Universal PBR Material:', {
  roughness: appliedMat.roughness,
  metalness: appliedMat.metalness,
});

console.log('ALL UNIVERSAL TEXTURE INDUCER TYPESCRIPT TESTS PASSED SUCCESSFULLY!');
