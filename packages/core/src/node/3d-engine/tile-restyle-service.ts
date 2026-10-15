/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Restyles a real photogrammetric tile GLB from continuous fields (scratchbox_tile_restyle.hpp).
 *
 *  1. The native CLI applies the fields to the tile's vertices and builds the forms.
 *  2. `applyRectification` writes the moved positions back in place: images, UVs and materials
 *     stay byte-identical, so the photo texture survives the edit.
 *  3. The forms GLB is merged into the tile as a new root node in the same world frame.
 *  4. Optionally, the surface textures are regraded toward a palette (`recolor3DTilesGlb`).
 *
 * The config is plain numbers. There are no style names here or in the native code; the model
 * turns "brutalist", "overgrown", "terraced" or anything else into these quantities.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { NativeCppCompilerService } from './native-compiler-service';
import { applyRectification, parseGlb, readSbrxSidecar, serializeGlb, type GlbDocument, type GltfJson } from './glb-geometry-patcher';
import { recolor3DTilesGlb } from '../spatial/GlbTextureRecolorService';

const execFileAsync = promisify(execFile);

export interface TileRestyleField {
    /** Tile-normalised placement in [-1, 1] across the tile's XZ bounds. */
    center: [number, number];
    radiusMeters: number;
    blendMeters?: number;
    offsetMeters?: number;
    /** Height above the tile datum to pull toward, with levelWeight in [0, 1]. */
    levelMeters?: number;
    levelWeight?: number;
    terraceStepMeters?: number;
    reliefAmplitudeMeters?: number;
    reliefWavelengthMeters?: number;
    reliefHeadingDeg?: number;
}

export interface TileRestyleForm {
    center: [number, number];
    baseOffsetMeters?: number;
    groundSnap?: boolean;
    rotationYDeg?: number;
    /** Revolve: (radius m, height m) from bottom to top. Used when `path` has fewer than 2 points. */
    profile?: Array<[number, number]>;
    segments?: number;
    lobes?: number;
    lobeAmplitude?: number;
    helixTurns?: number;
    /** Sweep: polyline in metres relative to the form origin (x, y up, z). */
    path?: Array<[number, number, number]>;
    radiusStartMeters?: number;
    radiusEndMeters?: number;
    sides?: number;
    twistTurns?: number;
    replicate?: { count?: number; ringRadiusMeters?: number; stepMeters?: [number, number] };
    material?: { albedo?: [number, number, number]; roughness?: number; metalness?: number; emissive?: [number, number, number] };
}

export interface TileRestyleSurface {
    shadowHex?: string;
    midtoneHex?: string;
    highlightHex?: string;
    accentHex?: string;
    shadowLift?: number;
    highlightCompress?: number;
    protectFoliage?: boolean;
    protectAsphalt?: boolean;
}

export interface TileRestyleRequest {
    inputGlbPath: string;
    outputGlbPath: string;
    fields?: TileRestyleField[];
    forms?: TileRestyleForm[];
    surface?: TileRestyleSurface;
}

export interface TileRestyleResult {
    outputGlbPath: string;
    vertexCount: number;
    movedVertices: number;
    maxDisplacementMeters: number;
    formMeshes: number;
    formVertices: number;
    formTriangles: number;
    texturesRegraded: number;
    bounds: { min: [number, number, number]; max: [number, number, number] };
    durationMs: number;
}

export class TileRestyleService {
    private readonly compiler = new NativeCppCompilerService();
    private readonly binaryPath = path.resolve(process.cwd(), 'build/3d-native/run_tile_restyle');

    /** Builds the CLI when it is missing or older than its sources. */
    async ensureBinary(): Promise<string> {
        const src = path.resolve(process.cwd(), 'scripts/run_tile_restyle.cpp');
        if (!fs.existsSync(src)) throw new Error(`Tile restyle source not found: ${src}`);
        const include = this.compiler.getSdkIncludePath();
        const header = path.join(include, 'scratchbox_tile_restyle.hpp');
        const newestSource = Math.max(fs.statSync(src).mtimeMs, fs.statSync(header).mtimeMs);
        if (fs.existsSync(this.binaryPath) && fs.statSync(this.binaryPath).mtimeMs >= newestSource) return this.binaryPath;
        fs.mkdirSync(path.dirname(this.binaryPath), { recursive: true });
        // CXX may carry a launcher/flags (e.g. "ccache clang++"): split it into argv, no shell involved.
        const [cxx, ...cxxArgs] = (process.env.CXX || 'clang++').trim().split(/\s+/);
        await execFileAsync(cxx, [...cxxArgs, '-std=c++20', '-O3', '-I', include, src, '-o', this.binaryPath, '-lz'], { maxBuffer: 16 * 1024 * 1024 });
        return this.binaryPath;
    }

    async restyle(request: TileRestyleRequest): Promise<TileRestyleResult> {
        const t0 = Date.now();
        const fields = request.fields ?? [];
        const forms = request.forms ?? [];
        if (!fs.existsSync(request.inputGlbPath)) throw new Error(`Tile GLB not found: ${request.inputGlbPath}`);
        if (fields.length === 0 && forms.length === 0 && !request.surface) {
            throw new Error('A restyle needs at least one field, form or surface change');
        }
        validateNumbers({ fields, forms }, 'restyle');

        const bin = await this.ensureBinary();
        const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sb_restyle_'));
        try {
            const configPath = path.join(work, 'restyle.json');
            const sidecarPath = path.join(work, 'tile.sbrx');
            const formsPath = path.join(work, 'forms.glb');
            fs.writeFileSync(configPath, JSON.stringify({ fields, forms }));
            const { stdout } = await execFileAsync(bin, [
                '--input', request.inputGlbPath, '--config', configPath, '--sidecar', sidecarPath, '--forms', formsPath
            ], { maxBuffer: 16 * 1024 * 1024 });
            const stats = JSON.parse(stdout.trim().split('\n').pop() || '{}');

            const tile = parseGlb(fs.readFileSync(request.inputGlbPath));
            let doc = applyRectification(tile, readSbrxSidecar(fs.readFileSync(sidecarPath))).doc;
            if (fs.existsSync(formsPath)) doc = appendGlbScene(doc, parseGlb(fs.readFileSync(formsPath)), 'restyle_forms');

            fs.mkdirSync(path.dirname(request.outputGlbPath), { recursive: true });
            fs.writeFileSync(request.outputGlbPath, serializeGlb(doc));

            let texturesRegraded = 0;
            if (request.surface) {
                const s = request.surface;
                const recolor = await recolor3DTilesGlb({
                    inputGlb: request.outputGlbPath,
                    outputGlbPath: request.outputGlbPath,
                    palettePreset: 'custom',
                    customPalette: { shadowHex: s.shadowHex, midtoneHex: s.midtoneHex, highlightHex: s.highlightHex, accentHex: s.accentHex },
                    segmentation: { enableSegmentation: true, protectFoliage: s.protectFoliage ?? true, protectAsphalt: s.protectAsphalt ?? true },
                    pbr: { generateNormalMaps: false, generateRoughnessMaps: false },
                    shadowLift: s.shadowLift,
                    highlightCompress: s.highlightCompress
                });
                if (!recolor.success) throw new Error(`Surface regrade failed: ${recolor.summary}`);
                texturesRegraded = recolor.textureCount;
            }

            return {
                outputGlbPath: request.outputGlbPath,
                vertexCount: stats.vertexCount,
                movedVertices: stats.movedVertices,
                maxDisplacementMeters: stats.maxDisplacementMeters,
                formMeshes: stats.formMeshes,
                formVertices: stats.formVertices,
                formTriangles: stats.formTriangles,
                texturesRegraded,
                bounds: stats.bounds,
                durationMs: Date.now() - t0
            };
        } finally {
            fs.rmSync(work, { recursive: true, force: true });
        }
    }
}

/** Rejects NaN, Infinity and non-numeric values anywhere a number is expected. */
function validateNumbers(value: unknown, where: string): void {
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) throw new Error(`${where} must be a finite number`);
    } else if (Array.isArray(value)) {
        value.forEach((v, i) => validateNumbers(v, `${where}[${i}]`));
    } else if (value && typeof value === 'object') {
        for (const [k, v] of Object.entries(value)) {
            if (typeof v === 'string') throw new Error(`${where}.${k} must be numeric, got a string`);
            validateNumbers(v, `${where}.${k}`);
        }
    }
}

/**
 * Appends every root node of `extra` (with its meshes, materials, accessors and buffer views) to
 * `base` under one new root node. `extra` must be self-contained in its BIN chunk and carry no
 * images, skins or animations (the restyle forms GLB satisfies this).
 */
export function appendGlbScene(base: GlbDocument, extra: GlbDocument, name: string): GlbDocument {
    const x = extra.json;
    if ((x.images?.length ?? 0) > 0 || (x.skins?.length ?? 0) > 0 || (x.animations?.length ?? 0) > 0) {
        throw new Error('appendGlbScene only merges plain mesh geometry');
    }
    const json = JSON.parse(JSON.stringify(base.json)) as GltfJson;
    const pad = (4 - (base.bin.length % 4)) % 4;
    const binOffset = base.bin.length + pad;
    const bin = Buffer.concat([base.bin, Buffer.alloc(pad), extra.bin]);

    json.buffers = json.buffers && json.buffers.length > 0 ? json.buffers : [{ byteLength: 0 }];
    json.buffers[0].byteLength = bin.length;
    json.bufferViews = json.bufferViews ?? [];
    json.accessors = json.accessors ?? [];
    json.meshes = json.meshes ?? [];
    json.nodes = json.nodes ?? [];
    const materials = ((json as any).materials ?? ((json as any).materials = [])) as unknown[];

    const viewBase = json.bufferViews.length;
    for (const v of x.bufferViews ?? []) {
        json.bufferViews.push({ ...v, buffer: 0, byteOffset: ((v.byteOffset as number | undefined) ?? 0) + binOffset });
    }
    const accessorBase = json.accessors.length;
    for (const a of x.accessors ?? []) {
        json.accessors.push(a.bufferView === undefined ? { ...a } : { ...a, bufferView: (a.bufferView as number) + viewBase });
    }
    const materialBase = materials.length;
    for (const m of ((x as any).materials ?? []) as unknown[]) materials.push(m);
    const meshBase = json.meshes.length;
    for (const m of x.meshes ?? []) {
        json.meshes.push({
            ...m,
            primitives: (m.primitives as any[]).map(p => ({
                ...p,
                attributes: Object.fromEntries(Object.entries(p.attributes as Record<string, number>).map(([k, v]) => [k, v + accessorBase])),
                ...(p.indices !== undefined ? { indices: p.indices + accessorBase } : {}),
                ...(p.material !== undefined ? { material: p.material + materialBase } : {})
            }))
        });
    }
    const nodeBase = json.nodes.length;
    for (const n of x.nodes ?? []) {
        json.nodes.push({
            ...n,
            ...(n.mesh !== undefined ? { mesh: (n.mesh as number) + meshBase } : {}),
            ...(n.children ? { children: (n.children as number[]).map(c => c + nodeBase) } : {})
        });
    }
    const extraScene = x.scenes?.[x.scene ?? 0];
    const extraRoots = (extraScene?.nodes ?? (x.nodes ?? []).map((_, i) => i)).map(i => i + nodeBase);
    const groupIndex = json.nodes.length;
    json.nodes.push({ name, children: extraRoots });
    json.scenes = json.scenes && json.scenes.length > 0 ? json.scenes : [{ nodes: [] }];
    const scene = json.scenes[json.scene ?? 0];
    scene.nodes = [...(scene.nodes ?? []), groupIndex];
    return { json, bin };
}
