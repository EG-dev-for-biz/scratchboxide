/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * Generates public/models/cg_architectural_monolith.glb
 * Production-grade binary glTF asset matching the VFX Plate Anti-Drift specification:
 * - Chamfered modern architectural monolith obelisk
 * - Stepped pedestal base plinth
 * - Horizontal architectural reveal grooves
 * - Metallic-roughness PBR materials (#06b6d4 cyan / titan finish)
 ********************************************************************************/

import fs from 'fs';
import path from 'path';
import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';

if (typeof globalThis.FileReader === 'undefined') {
  globalThis.FileReader = class {
    readAsArrayBuffer(blob) {
      blob.arrayBuffer().then(buf => {
        this.result = buf;
        if (typeof this.onloadend === 'function') this.onloadend();
        if (typeof this.onload === 'function') this.onload();
      });
    }
  };
}

const rootDir = process.cwd();
const publicDir = path.join(rootDir, 'public/models');
const desktopDir = path.join(rootDir, 'desktop-app/dist/models');

if (!fs.existsSync(publicDir)) fs.mkdirSync(publicDir, { recursive: true });
if (!fs.existsSync(desktopDir)) fs.mkdirSync(desktopDir, { recursive: true });

const scene = new THREE.Scene();

// 1. Stepped Pedestal Base Plinth
const baseMat = new THREE.MeshStandardMaterial({
  color: 0x1e293b,
  roughness: 0.75,
  metalness: 0.35,
  name: 'MonolithPedestalPlinth'
});

const plinthBottom = new THREE.Mesh(new THREE.BoxGeometry(4.2, 0.4, 4.2), baseMat);
plinthBottom.position.y = 0.2;
scene.add(plinthBottom);

const plinthMid = new THREE.Mesh(new THREE.BoxGeometry(3.6, 0.35, 3.6), baseMat);
plinthMid.position.y = 0.575;
scene.add(plinthMid);

const plinthTop = new THREE.Mesh(new THREE.BoxGeometry(3.0, 0.25, 3.0), baseMat);
plinthTop.position.y = 0.875;
scene.add(plinthTop);

// 2. Main Architectural Monolith Body (Tapering Modern Column)
const monolithMat = new THREE.MeshStandardMaterial({
  color: 0x06b6d4, // Vibrant Cyan Titanium
  roughness: 0.28,
  metalness: 0.82,
  name: 'MonolithTitaniumFacade'
});

const towerHeight = 12.0;
const towerGeo = new THREE.CylinderGeometry(1.0, 1.45, towerHeight, 8);
const tower = new THREE.Mesh(towerGeo, monolithMat);
tower.position.y = 1.0 + towerHeight * 0.5;
tower.rotation.y = Math.PI / 8; // align facet faces
scene.add(tower);

// 3. Architectural Horizontal Reveal Bands (Grooves)
const accentMat = new THREE.MeshStandardMaterial({
  color: 0x38bdf8,
  emissive: 0x0ea5e9,
  emissiveIntensity: 0.4,
  roughness: 0.15,
  metalness: 0.95,
  name: 'MonolithAccentBands'
});

for (let i = 1; i <= 6; i++) {
  const bandY = 1.0 + (towerHeight * (i / 7));
  const bandRadius = 1.45 - (0.45 * (i / 7)) + 0.04;
  const band = new THREE.Mesh(new THREE.CylinderGeometry(bandRadius, bandRadius, 0.12, 8), accentMat);
  band.position.y = bandY;
  band.rotation.y = Math.PI / 8;
  scene.add(band);
}

// 4. Crown Apex Pyramid
const crownGeo = new THREE.ConeGeometry(1.0, 1.8, 8);
const crown = new THREE.Mesh(crownGeo, accentMat);
crown.position.y = 1.0 + towerHeight + 0.9;
crown.rotation.y = Math.PI / 8;
scene.add(crown);

console.log('Exporting binary glTF for Architectural Monolith...');
const exporter = new GLTFExporter();
exporter.parse(
  scene,
  (glbBuffer) => {
    const pubPath = path.join(publicDir, 'cg_architectural_monolith.glb');
    const distPath = path.join(desktopDir, 'cg_architectural_monolith.glb');
    const buf = Buffer.from(glbBuffer);

    fs.writeFileSync(pubPath, buf);
    console.log(`✅ Saved ${pubPath} (${(buf.length / 1024).toFixed(1)} KB)`);

    fs.writeFileSync(distPath, buf);
    console.log(`✅ Mirrored to ${distPath}`);
  },
  (err) => {
    console.error('Failed to export GLB:', err);
    process.exit(1);
  },
  { binary: true }
);
