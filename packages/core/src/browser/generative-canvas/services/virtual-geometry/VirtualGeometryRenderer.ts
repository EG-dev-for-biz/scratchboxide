/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * WebGPU virtual geometry renderer for `.sbvg` cluster LOD DAGs.
 *
 * Per frame, on the GPU:
 *   1. A compute pass tests every loaded cluster: it is drawn when its projected self error is
 *      within the pixel threshold and its projected parent error is not (the crack-free DAG cut),
 *      and it survives frustum and normal-cone culling. Survivors are appended to a visible list
 *      and counted into the indirect draw arguments.
 *   2. One drawIndirect renders every visible cluster as an instance. The vertex shader pulls
 *      triangles, cluster-local indices and vertices straight from storage buffers; invocations
 *      past a cluster's triangle count emit a clipped degenerate vertex.
 *
 * The file is streamed coarsest level first. Each level block is uploaded as soon as it has fully
 * arrived and becomes the finest loaded level; clusters of that level are treated as leaves, so
 * the model is complete on screen from the first block and sharpens as later blocks land.
 *
 * Statistics are read back from the GPU (visible clusters/triangles) and timed with
 * timestamp queries where the adapter supports them; nothing is estimated.
 */

import type { ClusterSelectionParams } from './cluster-selection';
import {
    parseSbvgHeader,
    sbvgHeaderBytesNeeded,
    splitSbvgLevelBlock,
    SBVG_CLUSTER_BYTES,
    SBVG_HEADER_BYTES,
    SBVG_VERTEX_BYTES,
    type SbvgHeader
} from './sbvg-format';

// WebGPU enum values (the repo does not ship @webgpu/types).
const BUFFER_MAP_READ = 0x0001;
const BUFFER_COPY_SRC = 0x0004;
const BUFFER_COPY_DST = 0x0008;
const BUFFER_UNIFORM = 0x0040;
const BUFFER_STORAGE = 0x0080;
const BUFFER_INDIRECT = 0x0100;
const BUFFER_QUERY_RESOLVE = 0x0200;
const TEXTURE_RENDER_ATTACHMENT = 0x10;
const MAP_MODE_READ = 0x0001;

/** How fragments are coloured. */
export type VirtualGeometryShading = 'clay' | 'clusters' | 'lod-levels';
const SHADING_CODE: Record<VirtualGeometryShading, number> = { clay: 0, clusters: 1, 'lod-levels': 2 };

export interface VirtualGeometryStats {
    adapter: string;
    /** Frames presented per second over the last ~0.5 s. */
    fps: number;
    /** CPU time to record and submit one frame. */
    cpuFrameMs: number;
    /** GPU time of the culling compute pass (null without timestamp-query). */
    gpuCullMs: number | null;
    /** GPU time of the render pass (null without timestamp-query). */
    gpuDrawMs: number | null;
    drawCalls: number;
    clusterCount: number;
    loadedClusters: number;
    visibleClusters: number;
    visibleTriangles: number;
    /** Triangles of the full-detail mesh. */
    leafTriangles: number;
    /** Source primitives the builder left out (points, lines, no POSITION). */
    skippedPrimitives: number;
    levelCount: number;
    loadedLevels: number;
    /** Finest level resident on the GPU (0 = full detail). */
    finestLoadedLevel: number;
    bytesReceived: number;
    bytesTotal: number;
    errorThresholdPx: number;
}

export interface VirtualGeometryRendererOptions {
    /** Allowed screen-space geometric error in pixels before a finer level is selected. */
    errorThresholdPx?: number;
    shading?: VirtualGeometryShading;
    frustumCulling?: boolean;
    /** Normal-cone back-face culling; disable for meshes with inconsistent winding. */
    coneCulling?: boolean;
    /** Render back faces (also disables cone culling). */
    doubleSided?: boolean;
    clearColor?: [number, number, number];
}

const UNIFORM_FLOATS = 64; // 256 bytes

const CULL_WGSL = /* wgsl */ `
struct Cluster {
    refOffset: u32, vertexCount: u32, triOffset: u32, triCount: u32,
    level: u32, group: u32, pad0: u32, pad1: u32,
    bounds: vec4<f32>,
    cone: vec4<f32>,
    selfLod: vec4<f32>,
    selfError: f32, pad2: f32, pad3: f32, pad4: f32,
    parentLod: vec4<f32>,
    parentError: f32, pad5: f32, pad6: f32, pad7: f32,
};

struct Frame {
    viewProj: mat4x4<f32>,
    eye: vec4<f32>,
    planes: array<vec4<f32>, 6>,
    // x: lodScale (pixels per unit error at distance 1), y: threshold px, z: near, w: unused
    lod: vec4<f32>,
    // x: loaded cluster count, y: finest loaded level, z: flags (1 frustum, 2 cone), w: shading
    counts: vec4<u32>,
};

struct DrawArgs {
    vertexCount: u32,
    instanceCount: atomic<u32>,
    firstVertex: u32,
    firstInstance: u32,
    visibleTriangles: atomic<u32>,
    pad0: u32, pad1: u32, pad2: u32,
};

@group(0) @binding(0) var<uniform> frame: Frame;
@group(0) @binding(1) var<storage, read> clusters: array<Cluster>;
@group(0) @binding(2) var<storage, read_write> draw: DrawArgs;
@group(0) @binding(3) var<storage, read_write> visible: array<u32>;

// Same rule as projectedLodError / clusterSelected in cluster-selection.ts (the CPU copy the tests compare against).
fn projectedError(sphere: vec4<f32>, err: f32) -> f32 {
    if (err <= 0.0) { return 0.0; }
    if (err >= 1.0e37) { return 1.0e30; }
    let d = length(sphere.xyz - frame.eye.xyz) - sphere.w;
    if (d <= frame.lod.z) { return 1.0e30; }
    return err * frame.lod.x / d;
}

@compute @workgroup_size(64)
fn cull(@builtin(global_invocation_id) gid: vec3<u32>) {
    let i = gid.x;
    if (i >= frame.counts.x) { return; }
    let c = clusters[i];
    let finest = frame.counts.y;
    if (c.level < finest) { return; }

    let threshold = frame.lod.y;
    if (projectedError(c.parentLod, c.parentError) <= threshold) { return; }
    if (c.level != finest && projectedError(c.selfLod, c.selfError) > threshold) { return; }

    let center = c.bounds.xyz;
    let radius = c.bounds.w;
    if ((frame.counts.z & 1u) != 0u) {
        for (var p = 0u; p < 6u; p++) {
            let plane = frame.planes[p];
            if (dot(plane.xyz, center) + plane.w < -radius) { return; }
        }
    }
    if ((frame.counts.z & 2u) != 0u && c.cone.w < 1.0) {
        let toCenter = center - frame.eye.xyz;
        if (dot(toCenter, c.cone.xyz) >= c.cone.w * length(toCenter) + radius) { return; }
    }

    let slot = atomicAdd(&draw.instanceCount, 1u);
    visible[slot] = i;
    atomicAdd(&draw.visibleTriangles, c.triCount);
}
`;

const RENDER_WGSL = /* wgsl */ `
struct Cluster {
    refOffset: u32, vertexCount: u32, triOffset: u32, triCount: u32,
    level: u32, group: u32, pad0: u32, pad1: u32,
    bounds: vec4<f32>,
    cone: vec4<f32>,
    selfLod: vec4<f32>,
    selfError: f32, pad2: f32, pad3: f32, pad4: f32,
    parentLod: vec4<f32>,
    parentError: f32, pad5: f32, pad6: f32, pad7: f32,
};

struct Frame {
    viewProj: mat4x4<f32>,
    eye: vec4<f32>,
    planes: array<vec4<f32>, 6>,
    lod: vec4<f32>,
    counts: vec4<u32>,
};

@group(0) @binding(0) var<uniform> frame: Frame;
@group(0) @binding(1) var<storage, read> clusters: array<Cluster>;
@group(0) @binding(2) var<storage, read> visible: array<u32>;
@group(0) @binding(3) var<storage, read> vertices: array<f32>;
@group(0) @binding(4) var<storage, read> refs: array<u32>;
@group(0) @binding(5) var<storage, read> triangles: array<u32>;

struct VsOut {
    @builtin(position) position: vec4<f32>,
    @location(0) normal: vec3<f32>,
    @location(1) worldPos: vec3<f32>,
    @location(2) @interpolate(flat) cluster: u32,
    @location(3) @interpolate(flat) level: u32,
};

@vertex
fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VsOut {
    var out: VsOut;
    let ci = visible[ii];
    let c = clusters[ci];
    let tri = vi / 3u;
    if (tri >= c.triCount) {
        out.position = vec4<f32>(0.0, 0.0, 2.0, 1.0); // outside the depth range: clipped
        return out;
    }
    let packed = triangles[c.triOffset + tri];
    let local = (packed >> ((vi % 3u) * 8u)) & 0xffu;
    let v = refs[c.refOffset + local] * 8u; // position, normal, uv (SBVG_VERTEX_FLOATS)
    let p = vec3<f32>(vertices[v], vertices[v + 1u], vertices[v + 2u]);
    out.position = frame.viewProj * vec4<f32>(p, 1.0);
    out.normal = vec3<f32>(vertices[v + 3u], vertices[v + 4u], vertices[v + 5u]);
    out.worldPos = p;
    out.cluster = ci;
    out.level = c.level;
    return out;
}

fn hashColor(seed: u32) -> vec3<f32> {
    var h = seed * 747796405u + 2891336453u;
    h = ((h >> ((h >> 28u) + 4u)) ^ h) * 277803737u;
    h = (h >> 22u) ^ h;
    return vec3<f32>(f32(h & 255u), f32((h >> 8u) & 255u), f32((h >> 16u) & 255u)) / 255.0 * 0.75 + 0.2;
}

@fragment
fn fs(in: VsOut, @builtin(front_facing) front: bool) -> @location(0) vec4<f32> {
    var n = normalize(in.normal);
    if (!front) { n = -n; }
    var albedo = vec3<f32>(0.55, 0.57, 0.60); // 18% studio grey clay
    let mode = frame.counts.w;
    if (mode == 1u) { albedo = hashColor(in.cluster); }
    if (mode == 2u) { albedo = hashColor(in.level * 7919u + 13u); }
    let key = normalize(vec3<f32>(0.45, 0.80, 0.35));
    let viewDir = normalize(frame.eye.xyz - in.worldPos);
    let diffuse = max(dot(n, key), 0.0);
    let hemi = 0.5 + 0.5 * n.y;
    let ambient = mix(vec3<f32>(0.20, 0.20, 0.21), vec3<f32>(0.42, 0.43, 0.45), hemi);
    let rim = pow(1.0 - max(dot(n, viewDir), 0.0), 4.0) * 0.08;
    let color = albedo * (ambient + diffuse * 0.85) + vec3<f32>(rim);
    return vec4<f32>(pow(color, vec3<f32>(1.0 / 2.2)), 1.0);
}
`;

export class VirtualGeometryFetchError extends Error {
    constructor(readonly status: number, readonly url: string) {
        super(`Virtual geometry fetch failed: HTTP ${status} (${url})`);
    }
}

interface OrbitCamera {
    target: [number, number, number];
    yaw: number;
    pitch: number;
    distance: number;
    fovY: number;
}

export class VirtualGeometryRenderer {
    private readonly canvas: HTMLCanvasElement;
    private device: any = null;
    private context: any = null;
    private format = 'bgra8unorm';
    private adapterName = 'unknown';
    private hasTimestamps = false;

    private header: SbvgHeader | null = null;
    private clusterBuffer: any = null;
    private vertexBuffer: any = null;
    private refBuffer: any = null;
    private triangleBuffer: any = null;
    private visibleBuffer: any = null;
    private drawBuffer: any = null;
    private uniformBuffer: any = null;
    private statsReadback: any = null;
    private querySet: any = null;
    private queryResolve: any = null;
    private queryReadback: any = null;
    private depthTexture: any = null;
    private cullPipeline: any = null;
    private renderPipeline: any = null;
    private cullBindGroup: any = null;
    private renderBindGroup: any = null;

    private loadedClusters = 0;
    private loadedLevels = 0;
    private finestLoadedLevel = 0;
    private bytesReceived = 0;
    private abort: AbortController | null = null;

    private options: Required<VirtualGeometryRendererOptions>;
    private camera: OrbitCamera = { target: [0, 0, 0], yaw: 0.6, pitch: 0.35, distance: 10, fovY: (45 * Math.PI) / 180 };
    private running = false;
    private frameHandle: number | null = null;
    private statsPending = false;
    private timingPending = false;
    private framesSinceStats = 0;
    private fpsFrames = 0;
    private fpsWindowStart = 0;
    private stats: VirtualGeometryStats;
    private listeners: Array<(s: VirtualGeometryStats) => void> = [];
    private detachInput: (() => void) | null = null;
    private lastSelection: ClusterSelectionParams | null = null;

    constructor(canvas: HTMLCanvasElement, options: VirtualGeometryRendererOptions = {}) {
        this.canvas = canvas;
        this.options = {
            errorThresholdPx: options.errorThresholdPx ?? 1,
            shading: options.shading ?? 'clay',
            frustumCulling: options.frustumCulling ?? true,
            coneCulling: options.coneCulling ?? true,
            doubleSided: options.doubleSided ?? false,
            clearColor: options.clearColor ?? [0.16, 0.165, 0.175]
        };
        this.stats = {
            adapter: 'unknown', fps: 0, cpuFrameMs: 0, gpuCullMs: null, gpuDrawMs: null, drawCalls: 0,
            clusterCount: 0, loadedClusters: 0, visibleClusters: 0, visibleTriangles: 0, leafTriangles: 0, skippedPrimitives: 0,
            levelCount: 0, loadedLevels: 0, finestLoadedLevel: 0, bytesReceived: 0, bytesTotal: 0,
            errorThresholdPx: this.options.errorThresholdPx
        };
    }

    static isSupported(): boolean {
        return typeof navigator !== 'undefined' && Boolean((navigator as any).gpu);
    }

    /** Acquires the GPU device and builds the pipelines. Throws with the reason when WebGPU is unavailable. */
    async initialize(): Promise<void> {
        if (!VirtualGeometryRenderer.isSupported()) {
            throw new Error('WebGPU is not available in this browser (navigator.gpu is missing).');
        }
        const gpu = (navigator as any).gpu;
        const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
        if (!adapter) throw new Error('WebGPU adapter request returned null (GPU blocked or unsupported).');
        const info = adapter.info ?? {};
        this.adapterName = [info.vendor, info.architecture, info.description].filter(Boolean).join(' ') || 'WebGPU adapter';
        this.hasTimestamps = adapter.features.has('timestamp-query');
        this.device = await adapter.requestDevice({
            requiredFeatures: this.hasTimestamps ? ['timestamp-query'] : [],
            requiredLimits: {
                maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
                maxBufferSize: adapter.limits.maxBufferSize
            }
        });
        this.device.lost.then((info: any) => {
            if (info?.reason !== 'destroyed') console.error('[VirtualGeometryRenderer] GPU device lost:', info?.message);
            this.running = false;
        });
        this.context = this.canvas.getContext('webgpu');
        if (!this.context) throw new Error('Canvas refused a WebGPU context (it may already hold a WebGL context).');
        this.format = gpu.getPreferredCanvasFormat();
        this.context.configure({ device: this.device, format: this.format, alphaMode: 'opaque' });
        this.stats.adapter = this.adapterName;

        const cullModule = this.device.createShaderModule({ code: CULL_WGSL });
        const renderModule = this.device.createShaderModule({ code: RENDER_WGSL });
        this.cullPipeline = await this.device.createComputePipelineAsync({
            layout: 'auto',
            compute: { module: cullModule, entryPoint: 'cull' }
        });
        this.renderPipeline = await this.device.createRenderPipelineAsync({
            layout: 'auto',
            vertex: { module: renderModule, entryPoint: 'vs' },
            fragment: { module: renderModule, entryPoint: 'fs', targets: [{ format: this.format }] },
            primitive: { topology: 'triangle-list', cullMode: this.options.doubleSided ? 'none' : 'back', frontFace: 'ccw' },
            depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less' }
        });

        this.uniformBuffer = this.device.createBuffer({ size: UNIFORM_FLOATS * 4, usage: BUFFER_UNIFORM | BUFFER_COPY_DST });
        this.drawBuffer = this.device.createBuffer({ size: 32, usage: BUFFER_INDIRECT | BUFFER_STORAGE | BUFFER_COPY_DST | BUFFER_COPY_SRC });
        this.statsReadback = this.device.createBuffer({ size: 32, usage: BUFFER_MAP_READ | BUFFER_COPY_DST });
        if (this.hasTimestamps) {
            this.querySet = this.device.createQuerySet({ type: 'timestamp', count: 4 });
            this.queryResolve = this.device.createBuffer({ size: 32, usage: BUFFER_QUERY_RESOLVE | BUFFER_COPY_SRC });
            this.queryReadback = this.device.createBuffer({ size: 32, usage: BUFFER_MAP_READ | BUFFER_COPY_DST });
        }
    }

    /**
     * Streams an .sbvg file. Resolves when the whole file has been uploaded; the model is drawn
     * from the first completed level block onward. Rejects on network or format errors.
     */
    async load(url: string, onLevel?: (stats: VirtualGeometryStats) => void): Promise<SbvgHeader> {
        if (!this.device) throw new Error('VirtualGeometryRenderer.initialize() must complete before load().');
        this.abort?.abort();
        this.abort = new AbortController();
        const response = await fetch(url, { signal: this.abort.signal });
        if (!response.ok || !response.body) throw new VirtualGeometryFetchError(response.status, url);

        const reader = response.body.getReader();
        // Until the header is known the bytes accumulate in a growing buffer; after that they land
        // in one allocation of the declared file size.
        let buffer = new Uint8Array(0);
        let header: SbvgHeader | null = null;
        let nextLevel = 0;

        this.resetGeometry();
        for (;;) {
            const { done, value } = await reader.read();
            if (value) {
                const end = this.bytesReceived + value.byteLength;
                if (header) {
                    if (end > header.fileBytes) throw new Error('Virtual geometry stream is longer than its header declares.');
                } else {
                    const grown = new Uint8Array(end);
                    grown.set(buffer.subarray(0, this.bytesReceived));
                    buffer = grown;
                }
                buffer.set(value, this.bytesReceived);
                this.bytesReceived = end;
            }
            if (!header) {
                const need = sbvgHeaderBytesNeeded(buffer.subarray(0, this.bytesReceived));
                if (need > 0 && this.bytesReceived >= Math.max(need, SBVG_HEADER_BYTES)) {
                    header = parseSbvgHeader(buffer.subarray(0, this.bytesReceived));
                    if (this.bytesReceived > header.fileBytes) throw new Error('Virtual geometry stream is longer than its header declares.');
                    const full = new Uint8Array(header.fileBytes);
                    full.set(buffer.subarray(0, this.bytesReceived));
                    buffer = full;
                    this.allocate(header);
                }
            }
            while (header && nextLevel < header.levels.length) {
                const level = header.levels[nextLevel];
                if (this.bytesReceived < level.byteOffset + level.byteLength) break;
                this.uploadLevel(header, nextLevel, buffer);
                nextLevel++;
                this.publishStats();
                onLevel?.({ ...this.stats });
            }
            if (done) break;
        }
        if (!header) throw new Error('Virtual geometry stream ended before its header.');
        if (nextLevel < header.levels.length) throw new Error(`Virtual geometry stream truncated after ${nextLevel} of ${header.levels.length} levels.`);
        return header;
    }

    private resetGeometry() {
        for (const b of [this.clusterBuffer, this.vertexBuffer, this.refBuffer, this.triangleBuffer, this.visibleBuffer]) b?.destroy();
        this.clusterBuffer = this.vertexBuffer = this.refBuffer = this.triangleBuffer = this.visibleBuffer = null;
        this.cullBindGroup = this.renderBindGroup = null;
        this.header = null;
        this.loadedClusters = this.loadedLevels = this.bytesReceived = 0;
    }

    private allocate(header: SbvgHeader) {
        const limit = this.device.limits.maxStorageBufferBindingSize;
        const sizes = {
            clusters: header.clusterCount * SBVG_CLUSTER_BYTES,
            vertices: header.vertexCount * SBVG_VERTEX_BYTES,
            refs: header.refCount * 4,
            triangles: header.triangleCount * 4
        };
        for (const [name, bytes] of Object.entries(sizes)) {
            if (bytes > limit) {
                throw new Error(`Virtual geometry ${name} buffer (${(bytes / 1048576).toFixed(1)} MB) exceeds this GPU's storage binding limit (${(limit / 1048576).toFixed(0)} MB).`);
            }
        }
        const make = (bytes: number) => this.device.createBuffer({ size: Math.max(16, Math.ceil(bytes / 4) * 4), usage: BUFFER_STORAGE | BUFFER_COPY_DST });
        this.clusterBuffer = make(sizes.clusters);
        this.vertexBuffer = make(sizes.vertices);
        this.refBuffer = make(sizes.refs);
        this.triangleBuffer = make(sizes.triangles);
        this.visibleBuffer = this.device.createBuffer({ size: Math.max(16, header.clusterCount * 4), usage: BUFFER_STORAGE | BUFFER_COPY_DST | BUFFER_COPY_SRC });
        this.header = header;

        this.cullBindGroup = this.device.createBindGroup({
            layout: this.cullPipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: { buffer: this.uniformBuffer } },
                { binding: 1, resource: { buffer: this.clusterBuffer } },
                { binding: 2, resource: { buffer: this.drawBuffer } },
                { binding: 3, resource: { buffer: this.visibleBuffer } }
            ]
        });
        this.renderBindGroup = this.device.createBindGroup({
            layout: this.renderPipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: { buffer: this.uniformBuffer } },
                { binding: 1, resource: { buffer: this.clusterBuffer } },
                { binding: 2, resource: { buffer: this.visibleBuffer } },
                { binding: 3, resource: { buffer: this.vertexBuffer } },
                { binding: 4, resource: { buffer: this.refBuffer } },
                { binding: 5, resource: { buffer: this.triangleBuffer } }
            ]
        });
        this.frameModel(header);
        this.stats.clusterCount = header.clusterCount;
        this.stats.leafTriangles = header.leafTriangleCount;
        this.stats.skippedPrimitives = header.skippedPrimitives;
        this.stats.levelCount = header.levelCount;
        this.stats.bytesTotal = header.fileBytes;
    }

    private uploadLevel(header: SbvgHeader, index: number, file: Uint8Array) {
        const level = header.levels[index];
        const parts = splitSbvgLevelBlock(level, file.subarray(level.byteOffset, level.byteOffset + level.byteLength), header.version);
        const q = this.device.queue;
        const write = (buffer: any, offsetBytes: number, data: Uint8Array) => {
            if (data.byteLength > 0) q.writeBuffer(buffer, offsetBytes, data.buffer, data.byteOffset, data.byteLength);
        };
        write(this.clusterBuffer, level.clusterStart * SBVG_CLUSTER_BYTES, parts.clusters);
        write(this.vertexBuffer, level.vertexStart * SBVG_VERTEX_BYTES, parts.vertices);
        write(this.refBuffer, level.refStart * 4, parts.refs);
        write(this.triangleBuffer, level.triangleStart * 4, parts.triangles);
        this.loadedClusters = level.clusterStart + level.clusterCount;
        this.loadedLevels = index + 1;
        this.finestLoadedLevel = level.level;
    }

    /** Fits the orbit camera to the model bounds. */
    frameModel(header: SbvgHeader | null = this.header) {
        if (!header) return;
        const [a, b] = [header.aabbMin, header.aabbMax];
        this.camera.target = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
        // Fit the box's largest horizontal extent and its height rather than its bounding sphere,
        // so flat scenes (city blocks, terrain) fill the view instead of shrinking to its middle.
        const halfWidth = Math.max(b[0] - a[0], b[2] - a[2]) / 2;
        const halfHeight = (b[1] - a[1]) / 2;
        const aspect = Math.max(1, this.canvas.width) / Math.max(1, this.canvas.height);
        const fitWidth = halfWidth / (Math.tan(this.camera.fovY / 2) * aspect);
        const fitHeight = (halfHeight + halfWidth * Math.sin(Math.abs(this.camera.pitch))) / Math.tan(this.camera.fovY / 2);
        this.camera.distance = Math.max(fitWidth, fitHeight, 1e-3) * 1.1 + halfWidth * Math.cos(this.camera.pitch) * 0.5;
    }

    setCamera(camera: Partial<OrbitCamera>) {
        Object.assign(this.camera, camera);
        this.camera.pitch = Math.max(-1.5, Math.min(1.5, this.camera.pitch));
    }

    getCamera(): OrbitCamera {
        return { ...this.camera, target: [...this.camera.target] as [number, number, number] };
    }

    setErrorThreshold(px: number) {
        this.options.errorThresholdPx = Math.max(0.05, px);
        this.stats.errorThresholdPx = this.options.errorThresholdPx;
    }

    setShading(shading: VirtualGeometryShading) {
        this.options.shading = shading;
    }

    setCulling(culling: { frustum?: boolean; cone?: boolean }) {
        if (culling.frustum !== undefined) this.options.frustumCulling = culling.frustum;
        if (culling.cone !== undefined) this.options.coneCulling = culling.cone;
    }

    onStats(listener: (s: VirtualGeometryStats) => void): () => void {
        this.listeners.push(listener);
        listener({ ...this.stats });
        return () => { this.listeners = this.listeners.filter(l => l !== listener); };
    }

    getStats(): VirtualGeometryStats {
        return { ...this.stats };
    }

    /** Orbit (drag), pan (shift/right drag) and dolly (wheel) on the canvas. */
    attachOrbitControls(): () => void {
        this.detachInput?.();
        const el = this.canvas;
        let dragging: { x: number; y: number; pan: boolean } | null = null;
        const down = (e: PointerEvent) => {
            dragging = { x: e.clientX, y: e.clientY, pan: e.button === 2 || e.shiftKey };
            el.setPointerCapture(e.pointerId);
        };
        const move = (e: PointerEvent) => {
            if (!dragging) return;
            const dx = e.clientX - dragging.x;
            const dy = e.clientY - dragging.y;
            dragging.x = e.clientX;
            dragging.y = e.clientY;
            if (dragging.pan) {
                const { right, up } = this.basis();
                const s = (this.camera.distance * Math.tan(this.camera.fovY / 2) * 2) / Math.max(1, el.clientHeight);
                const t = this.camera.target;
                for (let k = 0; k < 3; k++) t[k] += (-right[k] * dx + up[k] * dy) * s;
            } else {
                this.camera.yaw -= dx * 0.005;
                this.camera.pitch = Math.max(-1.5, Math.min(1.5, this.camera.pitch + dy * 0.005));
            }
        };
        const up = (e: PointerEvent) => {
            dragging = null;
            if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
        };
        const wheel = (e: WheelEvent) => {
            e.preventDefault();
            this.camera.distance *= Math.exp(e.deltaY * 0.001);
        };
        const menu = (e: Event) => e.preventDefault();
        el.addEventListener('pointerdown', down);
        el.addEventListener('pointermove', move);
        el.addEventListener('pointerup', up);
        el.addEventListener('wheel', wheel, { passive: false });
        el.addEventListener('contextmenu', menu);
        this.detachInput = () => {
            el.removeEventListener('pointerdown', down);
            el.removeEventListener('pointermove', move);
            el.removeEventListener('pointerup', up);
            el.removeEventListener('wheel', wheel);
            el.removeEventListener('contextmenu', menu);
        };
        return this.detachInput;
    }

    start() {
        if (this.running) return;
        this.running = true;
        this.fpsWindowStart = performance.now();
        const tick = () => {
            if (!this.running) return;
            this.renderFrame();
            this.frameHandle = requestAnimationFrame(tick);
        };
        this.frameHandle = requestAnimationFrame(tick);
    }

    stop() {
        this.running = false;
        if (this.frameHandle !== null) cancelAnimationFrame(this.frameHandle);
        this.frameHandle = null;
    }

    /** Renders one frame. Exposed for tests and offline captures. */
    renderFrame() {
        if (!this.device || !this.context) return;
        const t0 = performance.now();
        this.ensureDepth();

        const encoder = this.device.createCommandEncoder();
        const view = this.context.getCurrentTexture().createView();
        const clear = this.options.clearColor;
        const ready = Boolean(this.header && this.cullBindGroup && this.loadedClusters > 0);

        if (ready) {
            this.writeFrameUniforms();
            const maxTris = this.header!.maxClusterTriangles;
            this.device.queue.writeBuffer(this.drawBuffer, 0, new Uint32Array([maxTris * 3, 0, 0, 0, 0, 0, 0, 0]));
            const cull = encoder.beginComputePass(this.querySet ? { timestampWrites: { querySet: this.querySet, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 } } : {});
            cull.setPipeline(this.cullPipeline);
            cull.setBindGroup(0, this.cullBindGroup);
            cull.dispatchWorkgroups(Math.ceil(this.loadedClusters / 64));
            cull.end();
        }

        const pass = encoder.beginRenderPass({
            colorAttachments: [{ view, clearValue: { r: clear[0], g: clear[1], b: clear[2], a: 1 }, loadOp: 'clear', storeOp: 'store' }],
            depthStencilAttachment: { view: this.depthTexture.createView(), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' },
            ...(ready && this.querySet ? { timestampWrites: { querySet: this.querySet, beginningOfPassWriteIndex: 2, endOfPassWriteIndex: 3 } } : {})
        });
        if (ready) {
            pass.setPipeline(this.renderPipeline);
            pass.setBindGroup(0, this.renderBindGroup);
            pass.drawIndirect(this.drawBuffer, 0);
        }
        pass.end();

        this.framesSinceStats++;
        const readStats = ready && !this.statsPending && this.framesSinceStats >= 8;
        const readTiming = readStats && this.querySet && !this.timingPending;
        if (readStats) encoder.copyBufferToBuffer(this.drawBuffer, 0, this.statsReadback, 0, 32);
        if (readTiming) {
            encoder.resolveQuerySet(this.querySet, 0, 4, this.queryResolve, 0);
            encoder.copyBufferToBuffer(this.queryResolve, 0, this.queryReadback, 0, 32);
        }
        this.device.queue.submit([encoder.finish()]);

        if (readStats) {
            this.framesSinceStats = 0;
            this.statsPending = true;
            this.statsReadback.mapAsync(MAP_MODE_READ).then(() => {
                const words = new Uint32Array(this.statsReadback.getMappedRange().slice(0));
                this.statsReadback.unmap();
                this.stats.visibleClusters = words[1];
                this.stats.visibleTriangles = words[4];
                this.stats.drawCalls = 1;
                this.statsPending = false;
            }).catch(() => { this.statsPending = false; });
        }
        if (readTiming) {
            this.timingPending = true;
            this.queryReadback.mapAsync(MAP_MODE_READ).then(() => {
                const t = new BigUint64Array(this.queryReadback.getMappedRange().slice(0));
                this.queryReadback.unmap();
                this.stats.gpuCullMs = Number(t[1] - t[0]) / 1e6;
                this.stats.gpuDrawMs = Number(t[3] - t[2]) / 1e6;
                this.timingPending = false;
            }).catch(() => { this.timingPending = false; });
        }

        this.stats.cpuFrameMs = performance.now() - t0;
        this.fpsFrames++;
        const now = performance.now();
        if (now - this.fpsWindowStart >= 500) {
            this.stats.fps = (this.fpsFrames * 1000) / (now - this.fpsWindowStart);
            this.fpsFrames = 0;
            this.fpsWindowStart = now;
            this.publishStats();
        }
    }

    /** Resolves once queued GPU work (including pending stat readbacks) has finished. */
    async settle(): Promise<VirtualGeometryStats> {
        await this.device?.queue.onSubmittedWorkDone();
        for (let i = 0; i < 50 && (this.statsPending || this.timingPending); i++) {
            await new Promise(r => setTimeout(r, 10));
        }
        return { ...this.stats };
    }

    /** LOD selection inputs of the last frame (as float32 on the GPU), for checking the GPU's choice on the CPU. */
    getSelectionParams(): ClusterSelectionParams | null {
        return this.lastSelection ? { ...this.lastSelection, eye: [...this.lastSelection.eye] } : null;
    }

    /** Indices of the clusters the last frame's cull pass selected, ascending. Diagnostic: maps GPU memory. */
    async readVisibleClusters(): Promise<number[]> {
        if (!this.device || !this.visibleBuffer || !this.header) return [];
        const bytes = Math.max(16, this.header.clusterCount * 4);
        const countRead = this.device.createBuffer({ size: 16, usage: BUFFER_MAP_READ | BUFFER_COPY_DST });
        const listRead = this.device.createBuffer({ size: bytes, usage: BUFFER_MAP_READ | BUFFER_COPY_DST });
        const encoder = this.device.createCommandEncoder();
        encoder.copyBufferToBuffer(this.drawBuffer, 0, countRead, 0, 16);
        encoder.copyBufferToBuffer(this.visibleBuffer, 0, listRead, 0, bytes);
        this.device.queue.submit([encoder.finish()]);
        try {
            await Promise.all([countRead.mapAsync(MAP_MODE_READ), listRead.mapAsync(MAP_MODE_READ)]);
            const count = new Uint32Array(countRead.getMappedRange().slice(0))[1];
            const list = Array.from(new Uint32Array(listRead.getMappedRange().slice(0)).subarray(0, count));
            return list.sort((a, b) => a - b);
        } finally {
            countRead.destroy();
            listRead.destroy();
        }
    }

    /** Forces the next frame to read back GPU statistics. */
    requestStats() {
        this.framesSinceStats = Number.MAX_SAFE_INTEGER;
    }

    dispose() {
        this.stop();
        this.abort?.abort();
        this.detachInput?.();
        this.resetGeometry();
        for (const b of [this.uniformBuffer, this.drawBuffer, this.statsReadback, this.queryResolve, this.queryReadback]) b?.destroy();
        this.querySet?.destroy();
        this.depthTexture?.destroy();
        this.device?.destroy();
        this.device = null;
        this.listeners = [];
    }

    private publishStats() {
        this.stats.loadedClusters = this.loadedClusters;
        this.stats.loadedLevels = this.loadedLevels;
        this.stats.finestLoadedLevel = this.finestLoadedLevel;
        this.stats.bytesReceived = this.bytesReceived;
        for (const l of this.listeners) l({ ...this.stats });
    }

    private ensureDepth() {
        const w = Math.max(1, this.canvas.width);
        const h = Math.max(1, this.canvas.height);
        if (this.depthTexture && this.depthTexture.width === w && this.depthTexture.height === h) return;
        this.depthTexture?.destroy();
        this.depthTexture = this.device.createTexture({ size: [w, h], format: 'depth32float', usage: TEXTURE_RENDER_ATTACHMENT });
    }

    private eye(): [number, number, number] {
        const c = this.camera;
        return [
            c.target[0] + Math.sin(c.yaw) * Math.cos(c.pitch) * c.distance,
            c.target[1] + Math.sin(c.pitch) * c.distance,
            c.target[2] + Math.cos(c.yaw) * Math.cos(c.pitch) * c.distance
        ];
    }

    private basis() {
        const eye = this.eye();
        const t = this.camera.target;
        const f = normalize3([t[0] - eye[0], t[1] - eye[1], t[2] - eye[2]]);
        const right = normalize3(cross3(f, [0, 1, 0]));
        const up = cross3(right, f);
        return { eye, forward: f, right, up };
    }

    private writeFrameUniforms() {
        const { eye, forward: f, right: r, up: u } = this.basis();
        const header = this.header!;
        const sceneRadius = Math.hypot(header.aabbMax[0] - header.aabbMin[0], header.aabbMax[1] - header.aabbMin[1], header.aabbMax[2] - header.aabbMin[2]) / 2 || 1;
        const toTarget = Math.hypot(eye[0] - this.camera.target[0], eye[1] - this.camera.target[1], eye[2] - this.camera.target[2]);
        const far = toTarget + sceneRadius * 4;
        const near = Math.max(far * 1e-5, Math.min(toTarget * 0.01, sceneRadius * 0.001));
        const aspect = Math.max(1, this.canvas.width) / Math.max(1, this.canvas.height);

        // Column-major view and WebGPU (0..1 depth) perspective projection.
        const view = new Float32Array([
            r[0], u[0], -f[0], 0,
            r[1], u[1], -f[1], 0,
            r[2], u[2], -f[2], 0,
            -dot3(r, eye), -dot3(u, eye), dot3(f, eye), 1
        ]);
        const k = 1 / Math.tan(this.camera.fovY / 2);
        const proj = new Float32Array(16);
        proj[0] = k / aspect;
        proj[5] = k;
        proj[10] = far / (near - far);
        proj[11] = -1;
        proj[14] = (far * near) / (near - far);
        const vp = mul4(proj, view);

        const data = new Float32Array(UNIFORM_FLOATS);
        data.set(vp, 0);
        data.set([eye[0], eye[1], eye[2], 1], 16);
        // Frustum planes (Gribb-Hartmann) from the rows of vp; WebGPU near plane is row 2 alone.
        const row = (i: number) => [vp[i], vp[4 + i], vp[8 + i], vp[12 + i]];
        const r0 = row(0), r1 = row(1), r2 = row(2), r3 = row(3);
        const planes = [
            r3.map((v, i) => v + r0[i]), r3.map((v, i) => v - r0[i]),
            r3.map((v, i) => v + r1[i]), r3.map((v, i) => v - r1[i]),
            r2, r3.map((v, i) => v - r2[i])
        ];
        planes.forEach((p, i) => {
            const len = Math.hypot(p[0], p[1], p[2]) || 1;
            data.set([p[0] / len, p[1] / len, p[2] / len, p[3] / len], 20 + i * 4);
        });
        const lodScale = this.canvas.height / (2 * Math.tan(this.camera.fovY / 2));
        data.set([lodScale, this.options.errorThresholdPx, near, 0], 44);
        this.lastSelection = { eye: [eye[0], eye[1], eye[2]], lodScale, near, thresholdPx: this.options.errorThresholdPx, finestLevel: this.finestLoadedLevel };
        const flags = (this.options.frustumCulling ? 1 : 0) | (this.options.coneCulling && !this.options.doubleSided ? 2 : 0);
        new Uint32Array(data.buffer).set([this.loadedClusters, this.finestLoadedLevel, flags, SHADING_CODE[this.options.shading]], 48);
        this.device.queue.writeBuffer(this.uniformBuffer, 0, data);
    }
}

type V3 = [number, number, number] | number[];
function dot3(a: V3, b: V3) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function cross3(a: V3, b: V3): [number, number, number] { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function normalize3(a: V3): [number, number, number] { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }
/** Column-major a * b. */
function mul4(a: Float32Array, b: Float32Array): Float32Array {
    const out = new Float32Array(16);
    for (let c = 0; c < 4; c++) {
        for (let r = 0; r < 4; r++) {
            let s = 0;
            for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
            out[c * 4 + r] = s;
        }
    }
    return out;
}
