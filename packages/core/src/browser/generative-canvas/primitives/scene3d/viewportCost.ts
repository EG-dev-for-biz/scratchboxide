/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Dev-only viewport cost probe: what the drawn frame costs, split by what it draws. Opt in with `?sbViewportCost=1` in the
 * page URL or `localStorage['sb.viewportCost'] = '1'`; the viewport then exposes `window.__SB_VIEWPORT_COST__`:
 *  - `breakdown()`: per group (a staged layer by stage, layer and building, its nodes split by their own stage; the trees by
 *    their current level; anything else by its top-level object), the meshes, draw calls and triangles the main pass submits
 *    this frame (visible, inside the camera frustum; an instanced mesh is one call of `count` instances), and the GPU memory
 *    of their geometry and textures (unique buffers, mip chain counted as 4/3);
 *  - `measure({ frames, hide })`: GPU time of whole frames (the app's own render, tree levels updated first) with
 *    EXT_disjoint_timer_query_webgl2 when the context has it, else the wall time of the frame plus a 1-pixel readback that waits
 *    for the GPU; `hide` takes groups out (visible false) for the measurement, so a group's share is the difference;
 *  - `setLens(focalMm)`: the lens for a measurement (full-frame 24 mm sensor height); place the camera with the viewport's
 *    `__SB_SET_CAMERA_VIEW__`.
 * Nothing here runs unless opted in; it changes nothing it does not restore.
 */

import * as THREE from 'three';

export interface ViewportCostGroup {
    key: string;
    meshes: number;
    drawCalls: number;
    triangles: number;
    instances: number;
    geometryBytes: number;
    textureBytes: number;
}

export interface ViewportCostBreakdown {
    groups: ViewportCostGroup[];
    total: Omit<ViewportCostGroup, 'key'>;
    /** renderer.info after the last frame the app drew (every pass of it, shadow and post included). */
    rendererInfo: { calls: number; triangles: number; geometries: number; textures: number; programs: number };
    camera: { position: [number, number, number]; fovDeg: number; focalMm: number; aspect: number };
    drawingBuffer: [number, number];
    jsHeapMB?: number;
}

export interface ViewportCostMeasure { method: 'gpu-timer-query' | 'wall-with-readback'; frames: number; meanMs: number; p50Ms: number; p95Ms: number; hidden: string[] }

/** The probe is installed only on opt-in. */
export function viewportCostProbeEnabled(): boolean {
    try {
        if (typeof window === 'undefined') return false;
        if (/[?&]sbViewportCost=1\b/.test(window.location?.search ?? '')) return true;
        return window.localStorage?.getItem('sb.viewportCost') === '1';
    } catch {
        return false;
    }
}

interface LayerLike { objectId: string; stage?: string; layer?: string; buildingId?: string; role?: string; retired?: boolean }

export interface ViewportCostDeps {
    renderer: THREE.WebGLRenderer;
    scene: THREE.Scene;
    camera: THREE.Camera;
    /** Draws one whole frame as the app does (tree levels updated first). */
    renderFrame: () => void;
    /** The staged build's layers and the loaded roots by objectId. */
    layers: () => LayerLike[];
    layerRoots: () => Map<string, THREE.Object3D>;
}

const SENSOR_HEIGHT_MM = 24;

function visibleChain(o: THREE.Object3D): boolean {
    for (let p: THREE.Object3D | null = o; p; p = p.parent) if (!p.visible) return false;
    return true;
}

function trianglesOf(g: THREE.BufferGeometry): number {
    const n = g.index ? g.index.count : (g.getAttribute('position')?.count ?? 0);
    const range = g.drawRange.count === Infinity ? n : Math.min(n, g.drawRange.count);
    return Math.floor(range / 3);
}

function textureBytes(t: THREE.Texture): number {
    const img = (t as THREE.Texture & { image?: { width?: number; height?: number } }).image;
    const w = img?.width ?? 0, h = img?.height ?? 0;
    return Math.round(w * h * 4 * (t.generateMipmaps !== false ? 4 / 3 : 1));
}

/** The group a mesh belongs to: trees by level, staged layers by layer and node stage, else its top-level object. */
function groupKeyOf(mesh: THREE.Object3D, rootToLayer: Map<THREE.Object3D, LayerLike>, scene: THREE.Scene): string {
    let lodGate: string | undefined, nodeStage: string | undefined, layer: LayerLike | undefined, top: THREE.Object3D = mesh;
    for (let p: THREE.Object3D | null = mesh; p && p !== scene; p = p.parent) {
        if (!lodGate && p.name.startsWith('sb-lod-gate-')) lodGate = p.name.slice('sb-lod-gate-'.length);
        const sb = (p.userData as { sb?: { schema?: string; stage?: string } })?.sb;
        if (!nodeStage && sb?.schema === 'scratchbox.staged-node/2' && sb.stage) nodeStage = sb.stage;
        if (!layer) layer = rootToLayer.get(p);
        top = p;
    }
    if (lodGate !== undefined) return `trees/level ${lodGate}`;
    if (layer) {
        const base = `${layer.stage ?? '?'}:${layer.layer ?? '?'}${layer.buildingId ? `#${layer.buildingId}` : ''}${layer.role ? `(${layer.role})` : ''}`;
        return nodeStage && nodeStage !== layer.stage ? `${base}/${nodeStage}` : base;
    }
    return `other/${top.name || top.type}`;
}

export function createViewportCostProbe(d: ViewportCostDeps) {
    const frustum = new THREE.Frustum(), pv = new THREE.Matrix4(), sphere = new THREE.Sphere();

    const rootMap = (): Map<THREE.Object3D, LayerLike> => {
        const byId = new Map(d.layers().filter(l => !l.retired).map(l => [l.objectId, l] as const));
        const out = new Map<THREE.Object3D, LayerLike>();
        d.layerRoots().forEach((root, id) => {
            const l = byId.get(id) ?? { objectId: id, stage: (root.userData as { sb?: { stage?: string } })?.sb?.stage ?? 'object' };
            out.set(root, l);
        });
        return out;
    };

    const meshesByGroup = (): Map<string, THREE.Mesh[]> => {
        const roots = rootMap();
        const out = new Map<string, THREE.Mesh[]>();
        d.scene.traverse(o => {
            const m = o as THREE.Mesh;
            if (!m.isMesh || !m.geometry) return;
            const key = groupKeyOf(m, roots, d.scene);
            (out.get(key) ?? out.set(key, []).get(key)!).push(m);
        });
        return out;
    };

    function breakdown(): ViewportCostBreakdown {
        const cam = d.camera as THREE.PerspectiveCamera;
        cam.updateMatrixWorld();
        frustum.setFromProjectionMatrix(pv.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
        const groups: ViewportCostGroup[] = [];
        const seenBuf = new Set<ArrayBufferLike | object>(), seenTex = new Set<THREE.Texture>();
        meshesByGroup().forEach((meshes, key) => {
            const g: ViewportCostGroup = { key, meshes: 0, drawCalls: 0, triangles: 0, instances: 0, geometryBytes: 0, textureBytes: 0 };
            for (const m of meshes) {
                const geo = m.geometry as THREE.BufferGeometry;
                // memory: every mesh loaded, drawn or not
                for (const a of [...Object.values(geo.attributes), ...(geo.index ? [geo.index] : [])]) {
                    const arr = (a as THREE.BufferAttribute).array as ArrayLike<number> & { buffer?: ArrayBufferLike; byteLength?: number };
                    const id = arr.buffer ?? arr;
                    if (!seenBuf.has(id)) { seenBuf.add(id); g.geometryBytes += arr.byteLength ?? 0; }
                }
                const inst = (m as THREE.InstancedMesh).isInstancedMesh ? (m as THREE.InstancedMesh) : undefined;
                if (inst && !seenBuf.has(inst.instanceMatrix.array.buffer)) { seenBuf.add(inst.instanceMatrix.array.buffer); g.geometryBytes += inst.instanceMatrix.array.byteLength; }
                const mats = Array.isArray(m.material) ? m.material : [m.material];
                for (const mat of mats) for (const v of Object.values(mat ?? {})) {
                    const t = v as THREE.Texture;
                    if (t && t.isTexture && !seenTex.has(t)) { seenTex.add(t); g.textureBytes += textureBytes(t); }
                }
                // the main pass: visible and in the frustum (as three culls it)
                if (!visibleChain(m)) continue;
                if (m.frustumCulled) {
                    if (!geo.boundingSphere) geo.computeBoundingSphere();
                    if (inst) { if (!inst.boundingSphere) inst.computeBoundingSphere(); sphere.copy(inst.boundingSphere!); } else sphere.copy(geo.boundingSphere!);
                    sphere.applyMatrix4(m.matrixWorld);
                    if (!frustum.intersectsSphere(sphere)) continue;
                }
                const count = inst ? inst.count : 1;
                if (count <= 0) continue;
                const calls = Array.isArray(m.material) ? Math.max(1, geo.groups.length) : 1;
                g.meshes++; g.drawCalls += calls; g.instances += count; g.triangles += trianglesOf(geo) * count;
            }
            groups.push(g);
        });
        groups.sort((a, b) => b.triangles - a.triangles);
        const total = groups.reduce((t, g) => ({
            meshes: t.meshes + g.meshes, drawCalls: t.drawCalls + g.drawCalls, triangles: t.triangles + g.triangles, instances: t.instances + g.instances,
            geometryBytes: t.geometryBytes + g.geometryBytes, textureBytes: t.textureBytes + g.textureBytes
        }), { meshes: 0, drawCalls: 0, triangles: 0, instances: 0, geometryBytes: 0, textureBytes: 0 });
        const info = d.renderer.info;
        const size = d.renderer.getDrawingBufferSize(new THREE.Vector2());
        const fov = cam.isPerspectiveCamera ? (2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2) / (cam.zoom || 1)) * 180) / Math.PI : 0;
        const mem = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
        return {
            groups, total,
            rendererInfo: { calls: info.render.calls, triangles: info.render.triangles, geometries: info.memory.geometries, textures: info.memory.textures, programs: info.programs?.length ?? 0 },
            camera: { position: cam.position.toArray() as [number, number, number], fovDeg: fov, focalMm: fov ? SENSOR_HEIGHT_MM / (2 * Math.tan(THREE.MathUtils.degToRad(fov) / 2)) : 0, aspect: cam.aspect },
            drawingBuffer: [size.x, size.y],
            ...(mem ? { jsHeapMB: Math.round(mem.usedJSHeapSize / 1048576) } : {})
        };
    }

    async function measure(opts: { frames?: number; warmup?: number; hide?: string[] } = {}): Promise<ViewportCostMeasure> {
        const frames = Math.max(3, opts.frames ?? 40), warmup = opts.warmup ?? 8;
        const hidden: THREE.Object3D[] = [];
        if (opts.hide?.length) {
            meshesByGroup().forEach((meshes, key) => {
                if (!opts.hide!.some(h => key.startsWith(h))) return;
                for (const m of meshes) if (m.visible) { m.visible = false; hidden.push(m); }
            });
        }
        const gl = d.renderer.getContext() as WebGL2RenderingContext;
        const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2') as { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null;
        const nextFrame = () => new Promise<void>(r => requestAnimationFrame(() => r()));
        const times: number[] = [];
        try {
            for (let i = 0; i < warmup; i++) { d.renderFrame(); await nextFrame(); }
            if (ext) {
                const pending: WebGLQuery[] = [];
                for (let i = 0; i < frames; i++) {
                    const q = gl.createQuery()!;
                    gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
                    d.renderFrame();
                    gl.endQuery(ext.TIME_ELAPSED_EXT);
                    pending.push(q);
                    await nextFrame();
                }
                for (let tries = 0; pending.length && tries < 200; tries++) {
                    for (let k = pending.length - 1; k >= 0; k--) {
                        const q = pending[k];
                        if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) continue;
                        if (!gl.getParameter(ext.GPU_DISJOINT_EXT)) times.push(Number(gl.getQueryParameter(q, gl.QUERY_RESULT)) / 1e6);
                        gl.deleteQuery(q);
                        pending.splice(k, 1);
                    }
                    if (pending.length) await nextFrame();
                }
            } else {
                const px = new Uint8Array(4);
                for (let i = 0; i < frames; i++) {
                    const t0 = performance.now();
                    d.renderFrame();
                    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
                    times.push(performance.now() - t0);
                    await nextFrame();
                }
            }
        } finally {
            for (const o of hidden) o.visible = true;
        }
        const s = [...times].sort((a, b) => a - b);
        const q = (p: number) => (s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN);
        const r3 = (v: number) => Math.round(v * 1000) / 1000;
        return { method: ext ? 'gpu-timer-query' : 'wall-with-readback', frames: s.length, meanMs: r3(s.reduce((a, b) => a + b, 0) / Math.max(1, s.length)), p50Ms: r3(q(0.5)), p95Ms: r3(q(0.95)), hidden: opts.hide ?? [] };
    }

    function setLens(focalMm: number): void {
        const cam = d.camera as THREE.PerspectiveCamera;
        if (!cam.isPerspectiveCamera) return;
        cam.fov = (2 * Math.atan(SENSOR_HEIGHT_MM / (2 * focalMm)) * 180) / Math.PI;
        cam.zoom = 1;
        cam.updateProjectionMatrix();
    }

    return { breakdown, measure, setLens, groups: () => [...meshesByGroup().keys()] };
}

export type ViewportCostProbe = ReturnType<typeof createViewportCostProbe>;
