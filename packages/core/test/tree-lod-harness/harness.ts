/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/


/**
 * Browser side of the tree level-of-detail checks: loads a trees GLB that follows the LOD contract into a three.js scene
 * with the real TreeLodController and the real clay pass, then (through window.H, driven over the devtools protocol by
 * runHarness.ts) measures frame times and triangles per camera and renders the level / transition shots.
 * Bundled with esbuild into harness.bundle.js; not shipped.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { TreeLodController } from '../../src/browser/generative-canvas/primitives/scene3d/treeLod/TreeLodController';
import { applyClayRenderMode } from '../../src/browser/generative-canvas/primitives/scene3d/clayRenderMode';
import { BREAKUP_FRAGMENT_PARS, breakupDepthMaterial, crownShadingUniforms, type CrownBreakupInput } from '../../src/browser/generative-canvas/primitives/scene3d/treeLod/treeCrownShading';

const W = 1280, H = 800;
let clock = 0;
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(1);
renderer.setSize(W, H);
const shaderErrors: string[] = [];
renderer.debug.onShaderError = (gl, program, vs, fs) => { shaderErrors.push(`${gl.getShaderInfoLog(vs) ?? ''}${gl.getShaderInfoLog(fs) ?? ''}${gl.getProgramInfoLog(program) ?? ''}`.slice(0, 2000)); };
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0xd6d9dd);
scene.add(new THREE.HemisphereLight(0xf2f4f8, 0x6e6a64, 1.2));
const sun = new THREE.DirectionalLight(0xffffff, 2.0);
sun.position.set(-120, 260, 90);
scene.add(sun);
const ground = new THREE.Mesh(new THREE.CircleGeometry(900, 48), new THREE.MeshStandardMaterial({ color: 0xa8aaa6, roughness: 1 }));
ground.rotation.x = -Math.PI / 2;
scene.add(ground);
const camera = new THREE.PerspectiveCamera(42, W / H, 0.05, 4000);
let root: THREE.Object3D | undefined;
let lod: TreeLodController | undefined;
const hero = { center: new THREE.Vector3(), radius: 10 };

const syncPx = new Uint8Array(4);
const sleep = () => new Promise<void>(r => setTimeout(r, 0));
const frame = (): { ms: number; updateMs: number } => {
    clock += 16.7;
    const t0 = performance.now();
    lod!.update(camera, renderer.shadowMap.enabled ? sun.shadow.camera : null);
    const t1 = performance.now();
    renderer.render(scene, camera);
    // finish() can return before the GPU is done; reading one pixel back cannot
    const gl = renderer.getContext(); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, syncPx);
    return { ms: performance.now() - t0, updateMs: t1 - t0 };
};
const pct = (a: number[], p: number): number => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };

type Cam = 'overview' | 'mid' | 'eye';
function place(cam: Cam, u: number): void {
    // u in [0,1): a slow path through the park so levels change while measuring
    if (cam === 'overview') { const a = 0.6 + u * 0.8; camera.position.set(Math.sin(a) * 560, 330, Math.cos(a) * 560); camera.lookAt(0, 0, 0); camera.fov = 42; }
    else if (cam === 'mid') { camera.position.set(-220 + u * 440, 28, 230 - u * 120); camera.lookAt(0, 8, -40); camera.fov = 48; }
    else { camera.position.set(-90 + u * 180, 1.7, 160 - u * 120); camera.lookAt(camera.position.x * 0.3, 7, -300); camera.fov = 62; }
    camera.aspect = W / H; camera.updateProjectionMatrix();
}

async function init(url: string): Promise<{ trees: number; ms: number }> {
    const t0 = performance.now();
    const buf = await (await fetch(url)).arrayBuffer();
    const gltf = await new GLTFLoader().parseAsync(buf, '');
    root = gltf.scene;
    scene.add(root);
    lod = new TreeLodController(root, { now: () => clock });
    applyClayRenderMode([root], true);
    // hero: the tree closest to the middle of the park, with its crown sphere
    let best = Infinity; let heroNode: THREE.Object3D | undefined;
    root.traverse(o => { if (o.userData?.sbTree) { const d = Math.hypot(o.position.x, o.position.z); if (d < best) { best = d; heroNode = o; } } });
    const b = new THREE.Box3().setFromObject(heroNode!);
    b.getBoundingSphere(new THREE.Sphere()).center && hero.center.copy(b.getCenter(new THREE.Vector3()));
    hero.radius = b.getBoundingSphere(new THREE.Sphere()).radius;
    return { trees: lod.treeCount, ms: performance.now() - t0 };
}

async function perf(cam: Cam, frames: number, force?: 0 | 1 | 2): Promise<Record<string, unknown>> {
    lod!.forceLevel(force ?? null);
    place(cam, 0); for (let i = 0; i < 12; i++) frame();          // settle, compile the programs
    const ms: number[] = [], upd: number[] = [], tris: number[] = [], calls: number[] = [], est: number[] = [];
    const levels = [0, 0, 0, 0];
    for (let i = 0; i < frames; i++) {
        place(cam, i / frames);
        const f = frame();
        ms.push(f.ms); upd.push(f.updateMs); tris.push(renderer.info.render.triangles); calls.push(renderer.info.render.calls); est.push(lod!.stats.estimatedTriangles);
        if (i === Math.floor(frames / 2)) { const s = lod!.stats; levels[0] = s.atLevel[0]; levels[1] = s.atLevel[1]; levels[2] = s.atLevel[2]; levels[3] = s.fading; }
        if (i % 8 === 0) await sleep();
    }
    const s = lod!.stats;
    return {
        camera: cam, forcedLevel: force ?? null, frames,
        frameMs: { median: pct(ms, 0.5), p95: pct(ms, 0.95), max: Math.max(...ms) }, updateMs: { median: pct(upd, 0.5), max: Math.max(...upd) },
        drawnTriangles: { median: pct(tris, 0.5), p95: pct(tris, 0.95), max: Math.max(...tris) }, drawCalls: { median: pct(calls, 0.5), max: Math.max(...calls) },
        estimatedTriangles: { median: pct(est, 0.5), max: Math.max(...est) },
        atMidpoint: { level0: levels[0], level1: levels[1], level2: levels[2], fading: levels[3], visibleTrees: s.visibleTrees, culledTrees: s.culledTrees, demotedTrees: s.demotedTrees },
        trees: s.trees
    };
}

/** Camera `distM` metres from the hero's crown sphere (nearest point), `heightM` up, looking at its centre. */
function heroView(distM: number, lift: number, fov: number): void {
    const dir = new THREE.Vector3(0.35, 0, 0.94).normalize();
    camera.position.copy(hero.center).addScaledVector(dir, hero.radius + distM); camera.position.y = lift;
    camera.lookAt(hero.center); camera.fov = fov; camera.aspect = W / H; camera.updateProjectionMatrix();
}

function imageStats(): { nonBackground: number; meanLuma: number; hash: number[] } {
    const gl = renderer.getContext();
    const px = new Uint8Array(W * H * 4);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
    let nb = 0, luma = 0;
    const grid = 16, cells = new Array(grid * grid).fill(0);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4, l = 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
        luma += l;
        if (Math.abs(px[i] - 214) + Math.abs(px[i + 1] - 217) + Math.abs(px[i + 2] - 221) > 24) nb++;
        cells[Math.floor((y / H) * grid) * grid + Math.floor((x / W) * grid)] += l;
    }
    return { nonBackground: nb / (W * H), meanLuma: luma / (W * H), hash: cells.map(c => c / ((W / grid) * (H / grid))) };
}

/** Renders a hero shot. `level` forces a level; null lets distance decide; settle lets the dissolve finish (or not). */
function shot(opts: { level: 0 | 1 | 2 | 3 | null; distM: number; lift: number; fov: number; settleFrames?: number }): Record<string, unknown> {
    lod!.forceLevel(opts.level);
    heroView(opts.distM, opts.lift, opts.fov);
    clock += 5000; frame();
    for (let i = 0; i < (opts.settleFrames ?? 40); i++) frame();
    const info = renderer.info.render;
    return { ...imageStats(), triangles: info.triangles, calls: info.calls, stats: { ...lod!.stats } };
}

/**
 * A frame in the middle of a handover: the hero at `distM` with a filtered distance already there (snap), edges as the distance
 * sets them. The camera creeps (1 cm a frame) so it is not at rest: a camera at rest settles every tree on one level.
 */
function transitionShot(distM: number, lift: number, fov: number): Record<string, unknown> {
    lod!.forceLevel(null);
    clock += 5000;
    for (let i = 1; i <= 3; i++) { heroView(distM + 0.01 * i, lift, fov); frame(); }
    return { ...imageStats(), triangles: renderer.info.render.triangles, stats: { ...lod!.stats } };
}

/** The breakup's factors (a partial override; null restores the defaults). */
function setBreakup(b: CrownBreakupInput | null): void { lod!.setCrownShading(b ? { breakup: b } : null); }

/** Sun shadows on (trees cast, the ground receives), the sun's shadow camera around the hero; `breakupDepth` false gives leaves the renderer's plain depth material. */
function shadows(on: boolean, breakupDepth = true): void {
    renderer.shadowMap.enabled = on;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    sun.castShadow = on;
    sun.position.copy(hero.center).add(new THREE.Vector3(-30, 60, 25));
    sun.target.position.copy(hero.center); sun.target.updateMatrixWorld();
    const cam = sun.shadow.camera as THREE.OrthographicCamera;
    cam.left = cam.bottom = -hero.radius * 3; cam.right = cam.top = hero.radius * 3; cam.near = 1; cam.far = 200; cam.updateProjectionMatrix();
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.map?.dispose(); (sun.shadow as { map: unknown }).map = null;
    ground.receiveShadow = on;
    root!.traverse(o => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        m.userData.sbLodCast = on; m.castShadow = on;
        if (m.userData.sbCrownLeaf) m.customDepthMaterial = breakupDepth ? breakupDepthMaterial() : undefined;
    });
    // the controller assigns castShadow per tree from its casting level at the next update; make it re-evaluate
    (lod as unknown as { trees: Array<{ castLevel: number }> }).trees.forEach(t => { t.castLevel = -1; });
}

/** A shot of the hero (as `shot`) with the breakup on or off. */
function breakupShot(opts: { level: 0 | 1 | 2 | 3 | null; distM: number; lift: number; fov: number; breakup: boolean }): Record<string, unknown> {
    setBreakup({ enabled: opts.breakup });
    return shot({ level: opts.level, distM: opts.distM, lift: opts.lift, fov: opts.fov });
}

/**
 * The GLSL hole test evaluated on an n x n grid of world points (origin + ((i + 0.5) / n) span along x and z), one pixel
 * each: 1 kept, 0 dropped. With the shared uniforms' current factors.
 */
function glslKeepGrid(o: { n: number; origin: [number, number, number]; span: number; depthS: number; slot: number; footprintM: number; dither: number; crownRadiusM: number }): number[] {
    const rt = new THREE.WebGLRenderTarget(o.n, o.n);
    const mat = new THREE.ShaderMaterial({
        uniforms: { ...crownShadingUniforms(), uO: { value: new THREE.Vector3(...o.origin) }, uSpan: { value: o.span }, uDepth: { value: o.depthS }, uInfo: { value: new THREE.Vector4(o.slot, 1, o.crownRadiusM, 0.5) }, uFoot: { value: o.footprintM }, uDither: { value: o.dither } },
        vertexShader: `uniform vec3 uO; uniform float uSpan; uniform float uDepth; uniform vec4 uInfo;
varying vec3 vSbBkW; varying float vSbBkDepth; varying vec4 vSbBkInfo;
void main() { vSbBkW = uO + vec3( uv.x * uSpan, 0.0, uv.y * uSpan ); vSbBkDepth = uDepth; vSbBkInfo = uInfo; gl_Position = vec4( position.xy * 2.0, 0.0, 1.0 ); }`,
        fragmentShader: `${BREAKUP_FRAGMENT_PARS}
uniform float uFoot; uniform float uDither;
void main() { bool k = sbBreakupKeep( vSbBkW, vSbBkDepth, sbBkSlot( vSbBkInfo.x ), uFoot, uDither ); gl_FragColor = vec4( k ? 1.0 : 0.0, 0.0, 0.0, 1.0 ); }`
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
    const s = new THREE.Scene(); s.add(quad);
    renderer.setRenderTarget(rt); renderer.render(s, camera); renderer.setRenderTarget(null);
    const px = new Uint8Array(o.n * o.n * 4);
    renderer.readRenderTargetPixels(rt, 0, 0, o.n, o.n, px);
    rt.dispose(); mat.dispose(); quad.geometry.dispose();
    const out: number[] = [];
    for (let j = 0; j < o.n; j++) for (let i = 0; i < o.n; i++) out.push(px[(j * o.n + i) * 4] > 127 ? 1 : 0);
    return out;
}

(window as unknown as { H: unknown }).H = { init, perf, shot, transitionShot, setBreakup, shadows, breakupShot, glslKeepGrid, shaderErrors: () => [...shaderErrors], stats: () => ({ ...lod!.stats }), hero: () => ({ c: hero.center.toArray(), r: hero.radius }), mem: () => ({ geometries: renderer.info.memory.geometries, programs: renderer.info.programs?.length ?? 0 }) };
