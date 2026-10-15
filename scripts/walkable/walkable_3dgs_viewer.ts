/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Walkable 3DGS viewer: renders a .splat or .spz with the app's own splat renderer
 * (PhotorealGaussianSplatMesh), so the page and the in-app viewport share one implementation.
 *
 * Bundled by scripts/walkable/build.sh into public/js/walkable_3dgs_viewer.js and loaded by
 * public/demos/showcase/walkable_3dgs_viewer.html. Query params:
 *   splat=<url>          default /tilesets/red_rocks/fused.splat
 *   tileset=<url>        a survey tileset (tileset.json): loads the fused.splat it was baked from, next to it
 *   glb=<url>            mesh to show under the splats (e.g. the survey's clay ground)
 *   meta=<url>           capture metadata with stations and cropBox (default: tileset.meta.json next to the splat)
 *   station=<n>          start at capture station n (1-based, default 1)
 *   cam=x,y,z            camera position (overrides the station)
 *   target=x,y,z         look-at point (default: 10 m ahead of the camera)
 *   walk=right,forward   offset from the start pose in metres
 *   crop=x0,y0,z0,x1,y1,z1  keep only splats inside this box (default: the metadata's cropBox)
 *   hud=0                hide the overlay (for screenshots)
 *   hold=<ms>            keep the load event pending this long (headless screenshots; needs a /__hold server route)
 * Sets window.__viewerReady once the first sorted frame has been drawn.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { PhotorealGaussianSplatMesh } from '../../packages/core/src/browser/generative-canvas/services/spatial/PhotorealGaussianSplatMesh';

type Vec3 = [number, number, number];

const params = new URLSearchParams(location.search);
const tilesetUrl = params.get('tileset');
const splatUrl = params.get('splat') || (tilesetUrl ? tilesetUrl.replace(/[^/]*$/, 'fused.splat') : '/tilesets/red_rocks/fused.splat');
const glbUrl = params.get('glb');
const metaUrl = params.get('meta') || splatUrl.replace(/[^/]+$/, 'tileset.meta.json');
const hud = document.getElementById('hud')!;
const statusEl = document.getElementById('status')!;
if (params.get('hud') === '0') hud.hidden = true;
const holdMs = Number(params.get('hold') || 0);
if (holdMs > 0) {
    // An image added before `load` delays it, so a headless --screenshot waits for the splats.
    const hold = new Image();
    hold.src = `/__hold?ms=${Math.min(60000, holdMs)}`;
    document.body.appendChild(hold);
    hold.style.display = 'none';
}

function vecParam(name: string, n: number): number[] | null {
    const raw = params.get(name);
    if (!raw) return null;
    const v = raw.split(',').map(Number);
    if (v.length !== n || v.some(x => !Number.isFinite(x))) throw new Error(`${name} must be ${n} comma-separated numbers`);
    return v;
}

function fail(message: string): void {
    statusEl.textContent = message;
    statusEl.hidden = false;
    (window as any).__viewerError = message;
}

const renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setClearColor(0x14171c, 1);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.05, 2000);
const yawPitch = { yaw: 0, pitch: 0 };
let splatMesh: PhotorealGaussianSplatMesh | null = null;

function setLook(from: THREE.Vector3, to: THREE.Vector3): void {
    camera.position.copy(from);
    const d = to.clone().sub(from).normalize();
    yawPitch.yaw = Math.atan2(-d.x, -d.z);
    yawPitch.pitch = Math.asin(THREE.MathUtils.clamp(d.y, -1, 1));
    applyLook();
}

function applyLook(): void {
    camera.quaternion.setFromEuler(new THREE.Euler(yawPitch.pitch, yawPitch.yaw, 0, 'YXZ'));
}

let metaPromise: Promise<any | null> | null = null;
function loadMeta(): Promise<any | null> {
    metaPromise ??= fetch(metaUrl).then(r => (r.ok ? r.json() : null)).catch(() => null);
    return metaPromise;
}

async function loadStartPose(): Promise<{ from: THREE.Vector3; to: THREE.Vector3; label: string }> {
    const cam = vecParam('cam', 3);
    const target = vecParam('target', 3);
    if (cam) {
        const from = new THREE.Vector3(...(cam as Vec3));
        return { from, to: target ? new THREE.Vector3(...(target as Vec3)) : from.clone().add(new THREE.Vector3(0, 0, -10)), label: 'custom camera' };
    }
    const stationIndex = Number(params.get('station') || '1');
    const meta = await loadMeta();
    if (!meta) throw new Error(`No camera given and no capture metadata at ${metaUrl}; pass cam=x,y,z`);
    const station = (meta.stations || [])[stationIndex - 1];
    if (!station?.positionLocalENU || !station?.forwardVector) throw new Error(`Capture metadata has no station ${stationIndex}`);
    const from = new THREE.Vector3(...(station.positionLocalENU as Vec3));
    const forward = new THREE.Vector3(...(station.forwardVector as Vec3)).normalize();
    return { from, to: target ? new THREE.Vector3(...(target as Vec3)) : from.clone().addScaledVector(forward, 10), label: station.name || `station ${stationIndex}` };
}

async function loadSplat(): Promise<void> {
    const res = await fetch(splatUrl);
    if (!res.ok) throw new Error(`Could not load ${splatUrl} (HTTP ${res.status})`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const data = /\.spz$/i.test(splatUrl)
        ? await PhotorealGaussianSplatMesh.parseSpzBuffer(bytes)
        : PhotorealGaussianSplatMesh.parseSplatBuffer(bytes);
    if (data.count === 0) throw new Error(`${splatUrl} has no splats`);

    // True scale: without an explicit splatScale the renderer shrinks splats wider than 2 cm to 22%.
    splatMesh = new PhotorealGaussianSplatMesh(data, {
        splatScale: 1.0,
        enableDepthSort: true,
        enableAsyncWorkerSort: false,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight
    });
    const crop = vecParam('crop', 6);
    const metaCrop = (await loadMeta())?.cropBox;
    if (crop) {
        splatMesh.setClipBox(new THREE.Box3(new THREE.Vector3(crop[0], crop[1], crop[2]), new THREE.Vector3(crop[3], crop[4], crop[5])));
    } else if (Array.isArray(metaCrop?.min) && Array.isArray(metaCrop?.max)) {
        splatMesh.setClipBox(new THREE.Box3(new THREE.Vector3(...(metaCrop.min as Vec3)), new THREE.Vector3(...(metaCrop.max as Vec3))));
    }
    scene.add(splatMesh);

    const start = await loadStartPose();
    setLook(start.from, start.to);
    const walk = vecParam('walk', 2);
    if (walk) {
        const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion).setY(0).normalize();
        const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion).setY(0).normalize();
        camera.position.addScaledVector(right, walk[0]).addScaledVector(forward, walk[1]);
    }
    hud.innerHTML = `<strong>Walkable 3DGS</strong><br>${data.count.toLocaleString()} splats · ${start.label}<br>` +
        `<span class="hint">Drag to look · W A S D to walk · Q / E down / up</span>`;
    statusEl.hidden = true;

    if (glbUrl) {
        // The overlay is optional: if it fails, keep showing the splats and say what is missing.
        try {
            const gltf = await new GLTFLoader().loadAsync(glbUrl);
            scene.add(gltf.scene);
            scene.add(new THREE.HemisphereLight(0xffffff, 0x6b6f76, 1.4));
            const sun = new THREE.DirectionalLight(0xffffff, 1.6);
            sun.position.set(40, 80, 30);
            scene.add(sun);
        } catch (err: any) {
            fail(`Splats loaded, but the mesh overlay ${glbUrl} could not be loaded: ${err?.message || err}`);
        }
    }
}

// Walk controls: drag to look, WASD to move on the horizontal plane, Q/E for height.
const keys = new Set<string>();
window.addEventListener('keydown', e => keys.add(e.code));
window.addEventListener('keyup', e => keys.delete(e.code));
let dragging = false;
renderer.domElement.addEventListener('pointerdown', e => { dragging = true; renderer.domElement.setPointerCapture(e.pointerId); });
renderer.domElement.addEventListener('pointerup', () => { dragging = false; });
renderer.domElement.addEventListener('pointermove', e => {
    if (!dragging) return;
    yawPitch.yaw -= e.movementX * 0.003;
    yawPitch.pitch = THREE.MathUtils.clamp(yawPitch.pitch - e.movementY * 0.003, -1.45, 1.45);
    applyLook();
});

window.addEventListener('resize', () => {
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    (splatMesh as any)?.splatMaterial?.uniforms?.viewport?.value.set(window.innerWidth, window.innerHeight);
});

const clock = new THREE.Clock();
let framesSinceLoad = 0;
renderer.setAnimationLoop(() => {
    const dt = Math.min(clock.getDelta(), 0.1);
    const speed = (keys.has('ShiftLeft') ? 12 : 4) * dt;
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion).setY(0).normalize();
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion).setY(0).normalize();
    if (keys.has('KeyW')) camera.position.addScaledVector(forward, speed);
    if (keys.has('KeyS')) camera.position.addScaledVector(forward, -speed);
    if (keys.has('KeyD')) camera.position.addScaledVector(right, speed);
    if (keys.has('KeyA')) camera.position.addScaledVector(right, -speed);
    if (keys.has('KeyE')) camera.position.y += speed;
    if (keys.has('KeyQ')) camera.position.y -= speed;

    if (splatMesh) {
        splatMesh.updateDepthSort(camera, framesSinceLoad === 0);
        framesSinceLoad++;
        if (framesSinceLoad === 3) (window as any).__viewerReady = true;
    }
    renderer.render(scene, camera);
});

loadSplat().catch(err => fail(String(err?.message || err)));
