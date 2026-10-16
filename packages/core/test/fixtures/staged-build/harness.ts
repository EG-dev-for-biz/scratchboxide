/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The headless-Chrome WebGL harness for the staged-build viewport tests (bundled by esbuild in
 * helpers/staged-build-chrome.ts). It mounts the REAL Scene3DPrimitive, with its loader, clay swap, render loop and
 * the staged-build hook, and exposes a small API to the test over the DevTools protocol: mount and update the scene
 * data, step frames on a controlled clock, read the canvas pixels the viewport drew, project nodes to the screen and
 * read the guard's own per-frame cost. Nothing here draws or changes the scene itself.
 */

import * as React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import * as THREE from 'three';
import { Scene3DPrimitive } from '../../../src/browser/generative-canvas/primitives/Scene3DPrimitive';
import { stagedRevealStats } from '../../../src/browser/generative-canvas/primitives/scene3d/stagedBuild/useStagedBuild';
import { stagedMaterialUniforms } from '../../../src/browser/generative-canvas/primitives/scene3d/stagedBuild/revealMaterial';
import { publishStageEvent } from '../../../src/browser/generative-canvas/primitives/scene3d/stagedBuild/stagedBuildState';
import '../../../src/style.css';

type AnyData = Record<string, unknown>;

interface Win {
    __SB_3D_EXTERNAL_OBJECTS__?: Map<string, THREE.Object3D>;
    __SB_3D_STACK__?: { scene: THREE.Scene; camera: THREE.PerspectiveCamera; renderer: THREE.WebGLRenderer; container: HTMLElement };
    __SB_SET_CAMERA_VIEW__?: (target: [number, number, number], rot: { theta: number; phi: number; distance: number }) => void;
    sbHarness?: unknown;
}
const w = window as unknown as Win;

let root: Root | undefined;

let reference: Uint8Array | undefined;
const prompts: string[] = [];
let lastUpdate: AnyData | undefined;

function render(data: AnyData): void {
    const el = document.getElementById('root')!;
    root ??= createRoot(el);
    root.render(React.createElement(Scene3DPrimitive as React.FC<any>, {
        data,
        onUpdate: (d: AnyData) => { lastUpdate = d; },
        onPromptAction: (p: string) => { prompts.push(p); }
    }));
}

function readPixels(): { data: Uint8Array; width: number; height: number } {
    const stack = w.__SB_3D_STACK__!;
    const gl = stack.renderer.getContext();
    const width = gl.drawingBufferWidth, height = gl.drawingBufferHeight;
    const data = new Uint8Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, data);
    return { data, width, height };
}

/** Pixels that differ from the reference frame (or from `bg` when no reference was taken). */
function coverage(threshold = 12): { covered: number; total: number } {
    const { data, width, height } = readPixels();
    let covered = 0;
    for (let i = 0; i < width * height; i++) {
        const o = i * 4;
        const r = reference;
        const d = r ? Math.max(Math.abs(data[o] - r[o]), Math.abs(data[o + 1] - r[o + 1]), Math.abs(data[o + 2] - r[o + 2])) : 255;
        if (d > threshold) covered++;
    }
    return { covered, total: width * height };
}

/**
 * Which node of a layer draws each pixel: an ID pass (every visible mesh drawn in a flat unique colour, through the same
 * camera, into a render target; the staged guard is bypassed for it), then the colour the viewport actually drew at
 * those pixels in its last frame. Pixels on a node's edge (antialiased with what is behind) and pattern gaps (the
 * background colour between legend-coloured pixels) are left out.
 */
/** The ID pass: every visible mesh drawn in a flat unique colour through the viewport's camera (the staged guard bypassed). */
function idPass(): { ids: Uint8Array; idOf: Map<THREE.Mesh, number>; width: number; height: number } {
    const stack = w.__SB_3D_STACK__!;
    const { width, height } = readPixels();
    const renderer = stack.renderer, scene = stack.scene, camera = stack.camera;
    const meshes: THREE.Mesh[] = [];
    scene.traverseVisible(o => { if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh); });
    const saved = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>();
    const idOf = new Map<THREE.Mesh, number>();
    meshes.forEach((m, i) => {
        const id = i + 1;
        idOf.set(m, id);
        saved.set(m, m.material);
        const mat = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, toneMapped: false });
        mat.color.setRGB((id & 255) / 255, ((id >> 8) & 255) / 255, ((id >> 16) & 255) / 255, THREE.LinearSRGBColorSpace);
        m.material = mat;
    });
    const hiddenLines: THREE.Object3D[] = [];
    scene.traverseVisible(o => { if ((o as THREE.Line).isLine || (o as THREE.Points).isPoints || (o as THREE.Sprite).isSprite) hiddenLines.push(o); });
    hiddenLines.forEach(o => { o.visible = false; });
    const bg = scene.background, guard = scene.onBeforeRender, tm = renderer.toneMapping;
    scene.background = new THREE.Color(0, 0, 0);
    scene.onBeforeRender = () => undefined;
    renderer.toneMapping = THREE.NoToneMapping;
    const rt = new THREE.WebGLRenderTarget(width, height);
    renderer.setRenderTarget(rt);
    renderer.render(scene, camera);
    const ids = new Uint8Array(width * height * 4);
    renderer.readRenderTargetPixels(rt, 0, 0, width, height, ids);
    renderer.setRenderTarget(null);
    rt.dispose();
    renderer.toneMapping = tm;
    scene.onBeforeRender = guard;
    scene.background = bg;
    hiddenLines.forEach(o => { o.visible = true; });
    for (const [m, mat] of saved) { (m.material as THREE.Material).dispose(); m.material = mat; }
    return { ids, idOf, width, height };
}

/** The interior pixels (all four neighbours on the same mesh) of each node of a layer, as indices into the frame. */
function nodeInteriors(objectId: string, ids: Uint8Array, idOf: Map<THREE.Mesh, number>, width: number, height: number): Map<THREE.Object3D, { set: Set<number>; interior: number[] }> {
    const rootObj = w.__SB_3D_EXTERNAL_OBJECTS__?.get(objectId);
    const out = new Map<THREE.Object3D, { set: Set<number>; interior: number[] }>();
    if (!rootObj) return out;
    const idAt = (x: number, y: number) => { const o = (y * width + x) * 4; return ids[o] | (ids[o + 1] << 8) | (ids[o + 2] << 16); };
    rootObj.traverse(o => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh || !idOf.has(mesh)) return;
        let node: THREE.Object3D = mesh;
        for (let p: THREE.Object3D | null = mesh; p && p !== rootObj; p = p.parent) if ((p.userData as { sb?: unknown }).sb) { node = p; break; }
        if (!out.has(node)) out.set(node, { set: new Set(), interior: [] });
        out.get(node)!.set.add(idOf.get(mesh)!);
    });
    for (const entry of out.values()) {
        for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++) {
            const id = idAt(x, y);
            if (!entry.set.has(id)) continue;
            if (idAt(x + 1, y) !== id || idAt(x - 1, y) !== id || idAt(x, y + 1) !== id || idAt(x, y - 1) !== id) continue;
            entry.interior.push(y * width + x);
        }
    }
    return out;
}

/**
 * The share of each node's interior pixels the provenance pattern takes (dots, stripes), measured exactly: the pattern
 * mixes the surface colour toward the provenance background, so drawing the same frame again with a magenta background
 * colour changes every pixel by (share of that pixel) × (magenta - background), and the mean of that share over the
 * node's interior is what the user sees as the pattern's coverage. The viewport's own frame is the baseline.
 */
function patternShare(objectId: string): Array<{ node: string; label?: string; pixels: number; share: number }> {
    const stack = w.__SB_3D_STACK__!;
    const scene = stack.scene, renderer = stack.renderer, camera = stack.camera;
    const base = readPixels();
    const { ids, idOf, width, height } = idPass();
    const staged: Array<{ background: THREE.Vector3; saved: THREE.Vector3 }> = [];
    scene.traverse(o => {
        const m = (o as THREE.Mesh).material as THREE.Material | undefined;
        const u = m && !Array.isArray(m) ? stagedMaterialUniforms(m) : undefined;
        if (u) staged.push({ background: u.background, saved: u.background.clone() });
    });
    const bg = [0x1c, 0x20, 0x26];
    const magenta = [255, 0, 255];
    for (const u of staged) u.background.set(1, 0, 1);
    const guard = scene.onBeforeRender;
    scene.onBeforeRender = () => undefined;
    renderer.render(scene, camera);
    const mixed = readPixels();
    scene.onBeforeRender = guard;
    for (const u of staged) u.background.copy(u.saved);
    const denom = magenta.reduce((a, m, c) => a + (m - bg[c]) ** 2, 0);
    const out: Array<{ node: string; label?: string; pixels: number; share: number }> = [];
    for (const [node, { interior }] of nodeInteriors(objectId, ids, idOf, width, height)) {
        if (interior.length === 0) continue;
        let sum = 0;
        for (const i of interior) {
            const o = i * 4;
            let num = 0;
            for (let c = 0; c < 3; c++) num += (mixed.data[o + c] - base.data[o + c]) * (magenta[c] - bg[c]);
            sum += Math.min(1, Math.max(0, num / denom));
        }
        const label = (node.userData as { sb?: { provenance?: { label?: string } } }).sb?.provenance?.label;
        out.push({ node: node.name, label, pixels: interior.length, share: sum / interior.length });
    }
    return out;
}

/**
 * Which node of a layer draws each pixel (the ID pass), then the colour the viewport actually drew at those pixels in its
 * last frame. Pixels on a node's edge (antialiased with what is behind) and pattern gaps (the background colour between
 * legend-coloured pixels) are left out.
 */
function sampleNodes(objectId: string, perNode = 24): Array<{ node: string; label?: string; pixels: number; gapFraction: number; samples: Array<{ x: number; y: number; rgb: [number, number, number] }> }> {
    const rootObj = w.__SB_3D_EXTERNAL_OBJECTS__?.get(objectId);
    if (!rootObj) return [];
    const frame = readPixels();
    const { width, height, ids, idOf } = idPass();
    const isGap = (o: number) => Math.abs(frame.data[o] - 0x1c) + Math.abs(frame.data[o + 1] - 0x20) + Math.abs(frame.data[o + 2] - 0x26) < 24;
    const out: Array<{ node: string; label?: string; pixels: number; gapFraction: number; samples: Array<{ x: number; y: number; rgb: [number, number, number] }> }> = [];
    for (const [node, { interior: all }] of nodeInteriors(objectId, ids, idOf, width, height)) {
        const interior: number[] = [];
        let gaps = 0;
        for (const i of all) { if (isGap(i * 4)) gaps++; else interior.push(i); }
        const step = Math.max(1, Math.floor(interior.length / perNode));
        const samples: Array<{ x: number; y: number; rgb: [number, number, number] }> = [];
        for (let k = 0; k < interior.length && samples.length < perNode; k += step) {
            const i = interior[k], o = i * 4;
            samples.push({ x: i % width, y: height - 1 - Math.floor(i / width), rgb: [frame.data[o], frame.data[o + 1], frame.data[o + 2]] });
        }
        const label = (node.userData as { sb?: { provenance?: { label?: string } } }).sb?.provenance?.label;
        if (samples.length > 0) out.push({ node: node.name, label, pixels: interior.length, gapFraction: gaps / Math.max(1, gaps + interior.length), samples });
    }
    return out;
}

function boxes(): Record<string, { x: number; y: number; width: number; height: number } | null> {
    const q = (sel: string) => {
        const el = document.querySelector(sel) as HTMLElement | null;
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 ? { x: r.x, y: r.y, width: r.width, height: r.height } : null;
    };
    return {
        overlay: q('[data-testid="sb-staged-overlay"]'),
        toolstrip: q('.sb-3d-toolstrip'),
        hud: q('.sb-3d-minimal-badge-container'),
        scrubber: q('.sb-3d-timeline-scrubber'),
        timeline: q('.sb-3d-docked-timeline'),
        container: q('.sb-scene3d-primitive-container')
    };
}

/** Frame pacing and render cost, recorded while `frameLog.on` (real clock only). */
const frameLog = { on: false, times: [] as number[], renderMs: [] as number[], gpuMs: [] as number[], triangles: [] as number[], calls: [] as number[] };
function startFrameLog(): void {
    frameLog.on = true;
    frameLog.times = []; frameLog.renderMs = []; frameLog.gpuMs = []; frameLog.triangles = []; frameLog.calls = [];
    const stack = w.__SB_3D_STACK__!;
    const renderer = stack.renderer as THREE.WebGLRenderer & { __sbTimed?: boolean };
    if (!renderer.__sbTimed) {
        renderer.__sbTimed = true;
        const gl = renderer.getContext() as WebGL2RenderingContext;
        const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2') as { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null;
        const pending: WebGLQuery[] = [];
        const original = renderer.render.bind(renderer);
        renderer.render = (scene: THREE.Object3D, camera: THREE.Camera) => {
            const t0 = performance.now();
            let q: WebGLQuery | null = null;
            if (ext && frameLog.on) { q = gl.createQuery(); if (q) gl.beginQuery(ext.TIME_ELAPSED_EXT, q); }
            original(scene, camera);
            if (q && ext) { gl.endQuery(ext.TIME_ELAPSED_EXT); pending.push(q); }
            if (frameLog.on) {
                frameLog.renderMs.push(performance.now() - t0);
                frameLog.triangles.push(renderer.info.render.triangles);
                frameLog.calls.push(renderer.info.render.calls);
            }
            while (ext && pending.length > 0 && gl.getQueryParameter(pending[0], gl.QUERY_RESULT_AVAILABLE)) {
                const done = pending.shift()!;
                if (!gl.getParameter(ext.GPU_DISJOINT_EXT)) frameLog.gpuMs.push(gl.getQueryParameter(done, gl.QUERY_RESULT) / 1e6);
                gl.deleteQuery(done);
            }
        };
    }
    const tick = (t: number) => { if (!frameLog.on) return; frameLog.times.push(t); requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
}

w.sbHarness = {
    startFrameLog,
    stopFrameLog: () => { frameLog.on = false; return { times: frameLog.times, renderMs: frameLog.renderMs, gpuMs: frameLog.gpuMs, triangles: frameLog.triangles, calls: frameLog.calls }; },
    gpuInfo: () => {
        const gl = w.__SB_3D_STACK__!.renderer.getContext();
        const dbg = gl.getExtension('WEBGL_debug_renderer_info');
        return { renderer: String(gl.getParameter(dbg ? dbg.UNMASKED_RENDERER_WEBGL : gl.RENDERER)), timerQuery: !!gl.getExtension('EXT_disjoint_timer_query_webgl2') };
    },
    /** A fresh viewport (unmounts the previous one), as a newly opened scene. */
    mount: (data: AnyData) => { reference = undefined; root?.unmount(); root = undefined; render(data); },
    update: (data: AnyData) => render(data),
    unmount: () => { root?.unmount(); root = undefined; },
    attached: (id: string) => !!w.__SB_3D_EXTERNAL_OBJECTS__?.get(id)?.parent,
    ready: () => !!w.__SB_3D_STACK__,
    setReference: () => { reference = readPixels().data.slice(); },
    clearReference: () => { reference = undefined; },
    coverage,
    sampleNodes,
    patternShare,
    boxes,
    camera: () => {
        const c = w.__SB_3D_STACK__!.camera;
        return [c.position.x, c.position.y, c.position.z];
    },
    setCameraView: (target: [number, number, number], rot: { theta: number; phi: number; distance: number }) => w.__SB_SET_CAMERA_VIEW__?.(target, rot),
    meshStates: (id: string) => {
        const r = w.__SB_3D_EXTERNAL_OBJECTS__?.get(id);
        const out: Array<{ name: string; node: string; visible: boolean; staged: string | null; material: string; uniforms: { progress: number; stagger: number; fade: number; presence: number } | null }> = [];
        r?.traverse(o => {
            const m = o as THREE.Mesh;
            if (!m.isMesh && !(o as THREE.Line).isLine) return;
            const mat = m.material as THREE.Material;
            let node: THREE.Object3D = o;
            for (let p: THREE.Object3D | null = o; p && p !== r; p = p.parent) if ((p.userData as { sb?: unknown }).sb) { node = p; break; }
            out.push({ name: o.name, node: node.name, visible: o.visible, staged: (mat?.userData?.sbStagedPatch as string) ?? null, material: mat?.type ?? '', uniforms: (mat && stagedMaterialUniforms(mat)) ?? null });
        });
        return out;
    },
    background: () => {
        const bg = w.__SB_3D_STACK__?.scene.background as THREE.Color | null;
        return bg && bg.isColor ? `#${bg.getHexString()}` : null;
    },
    layer: (id: string) => stagedRevealStats.layers.find(l => l.objectId === id) ?? null,
    stats: () => ({ ...stagedRevealStats, guardMs: [...stagedRevealStats.guardMs], newMaterials: [...stagedRevealStats.newMaterials], drawnStagedMeshes: [...stagedRevealStats.drawnStagedMeshes] }),
    resetStats: () => { stagedRevealStats.guardMs.length = 0; stagedRevealStats.newMaterials.length = 0; stagedRevealStats.drawnStagedMeshes.length = 0; },
    renderInfo: () => {
        const info = w.__SB_3D_STACK__!.renderer.info;
        return { calls: info.render.calls, triangles: info.render.triangles, programs: info.programs?.length ?? 0 };
    },
    publishStageEvent,
    prompts: () => [...prompts],
    lastUpdate: () => lastUpdate,
    click: (selector: string) => { (document.querySelector(selector) as HTMLElement | null)?.click(); return !!document.querySelector(selector); },
    text: (selector: string) => (document.querySelector(selector) as HTMLElement | null)?.innerText ?? null
};
