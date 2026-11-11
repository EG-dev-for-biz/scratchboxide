/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { CanvasArtifact, Scene3DData } from '../../../browser/generative-canvas/canvas-types';
import type { ToolDeclaration, ToolHandler } from './types';
import { getVirtualGeometryBuildService, VirtualGeometryBuildError } from '../../3d-engine/virtual-geometry-service';
import { MetalPathTracerError, MetalPathTracerService, readSbvgOrigin, type MetalPathTraceRequest } from '../../3d-engine/metal-path-tracer-service';
import { PathTraversalError, resolveWithinRoot } from '../../security/path-guard';
import { resolveSceneModelPath } from './canvas-tools';
import { heightPx, verticalFovDeg, type ShotCamera } from '../../../common/spatial/shot-detail-budget';

export const VIRTUAL_GEOMETRY_TOOL_DECLARATIONS: ToolDeclaration[] = [
    {
        name: 'virtual_geometry_open_glb',
        description: 'Open a GLB from the workspace in the WebGPU virtual geometry viewport. The native C++20 builder turns the mesh into a Nanite-style cluster LOD hierarchy (.sbvg), which the app streams coarsest level first while the GPU picks per-cluster detail every frame (one indirect draw). Use it for meshes too heavy for the regular 3D viewport (hundreds of thousands to millions of triangles: scans, 3D tiles, CAD). The WebGPU view shows the geometry in clay; its "Path traced" toggle (macOS with a ray tracing GPU) shades it with the GLB\'s own materials and textures. The GLB must use float32 positions without Draco or meshopt compression. The viewport needs WebGPU in the app\'s browser.',
        parameters: {
            type: 'OBJECT',
            properties: {
                glbPath: { type: 'STRING', description: 'Path of the .glb inside the workspace (relative to the workspace root, or absolute within it).' },
                title: { type: 'STRING', description: 'Tab title for the scene.' },
                errorThresholdPx: { type: 'NUMBER', description: 'Allowed screen-space geometric error in pixels (default 1; larger draws fewer triangles).' },
                doubleSided: { type: 'BOOLEAN', description: 'Draw back faces too, for meshes with inconsistent winding (disables back-face and cone culling).' }
            },
            required: ['glbPath']
        }
    },
    {
        name: 'path_trace_render',
        description: 'Render a GLB from the workspace as one physically lit, denoised still with the native Metal path tracer (bounce light, soft sky occlusion, the sun\'s shadows, the GLB\'s own materials and textures, and its own lights: emissive materials and its point, spot and directional lights), saved as a PNG under renders/path-traced/ in the workspace with a JSON of how it was made beside it. macOS with a ray tracing GPU only: anywhere else it fails and says so. Lighting is the neutral studio dome unless a sun is given, plus the GLB\'s own lights. The camera is in the GLB\'s own coordinates (Y up); without one the whole model is framed. The GLB must use float32 positions without Draco or meshopt compression. The user can also path trace the open 3D scene live from the viewport toolstrip.',
        parameters: {
            type: 'OBJECT',
            properties: {
                glbPath: { type: 'STRING', description: 'Path of the .glb inside the workspace (relative to the workspace root, or absolute within it), or a published model (/models/<file>.glb, as a scene\'s objects name it). Omit to render the open 3D scene\'s own model.' },
                camera: {
                    type: 'OBJECT',
                    description: 'Camera in the GLB\'s coordinates. Omit to use the open scene\'s first declared shot (sb.shot) at its own frame size when rendering that scene\'s model, else to frame the whole model.',
                    properties: {
                        position: { type: 'ARRAY', items: { type: 'NUMBER' }, description: '[x, y, z] eye position.' },
                        target: { type: 'ARRAY', items: { type: 'NUMBER' }, description: '[x, y, z] point looked at.' },
                        verticalFovDeg: { type: 'NUMBER', description: 'Vertical field of view in degrees (default 45).' }
                    },
                    required: ['position', 'target']
                },
                framing: {
                    type: 'OBJECT',
                    description: 'Automatic framing when no camera is given.',
                    properties: {
                        headingDeg: { type: 'NUMBER', description: 'Compass direction the camera looks from, degrees.' },
                        pitchDeg: { type: 'NUMBER', description: 'Downward tilt, degrees.' },
                        distanceScale: { type: 'NUMBER', description: 'Distance as a multiple of the model\'s size (default 1).' }
                    }
                },
                sun: {
                    type: 'OBJECT',
                    description: 'A physical sun and sky instead of the studio dome.',
                    properties: {
                        elevationDeg: { type: 'NUMBER', description: 'Sun height above the horizon, degrees.' },
                        azimuthDeg: { type: 'NUMBER', description: 'Sun direction: 0 toward -Z, 90 toward +X, degrees.' }
                    },
                    required: ['elevationDeg', 'azimuthDeg']
                },
                width: { type: 'NUMBER', description: 'Image width in pixels (default 1920, at most 8192).' },
                height: { type: 'NUMBER', description: 'Image height in pixels (default 1080, at most 8192).' },
                samplesPerPixel: { type: 'NUMBER', description: 'Samples per pixel (default 1024).' },
                exposureEv: { type: 'NUMBER', description: 'Fixed exposure in EV; by default it is metered from the image.' }
            },
            required: []
        }
    }
];

const vec3 = (v: unknown): [number, number, number] | null =>
    Array.isArray(v) && v.length === 3 && v.every(n => typeof n === 'number' && Number.isFinite(n)) ? [v[0], v[1], v[2]] : null;
const clampInt = (v: unknown, fallback: number, min: number, max: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.max(min, Math.min(max, Math.round(v))) : fallback;

let metalPathTracer: MetalPathTracerService | null = null;

/** Where the app publishes generated models (python-3d-tools publishToModels): `<repo>/public/models`, served as /models/. */
function publishedModelsDir(): string {
    const repoRoot = process.env.SCRATCHBOX_ROOT || (fs.existsSync(path.resolve(process.cwd(), 'packages')) ? process.cwd() : path.resolve(process.cwd(), '..'));
    return path.resolve(repoRoot, 'public', 'models');
}

/**
 * The GLB to render: a path inside the workspace; else a published model (a /models/ URL, a public/models path, or a
 * bare file name the app published); else, with no path, the open 3D scene's own model.
 */
export function resolveRenderGlb(glbPath: string, workspaceRoot: string, openScene: Scene3DData | undefined): { file: string; fromOpenScene: boolean } | { error: string } {
    if (!glbPath) {
        const own = resolveSceneModelPath(openScene);
        return own ? { file: own, fromOpenScene: true } : { error: 'glbPath is required (no 3D scene with a model is open): the .glb to render, inside the workspace or a published /models/ file.' };
    }
    let inWorkspace: string | undefined;
    try {
        inWorkspace = resolveWithinRoot(workspaceRoot, glbPath);
    } catch (err) {
        if (!(err instanceof PathTraversalError)) throw err;
    }
    if (inWorkspace && fs.existsSync(inWorkspace)) {
        const own = resolveSceneModelPath(openScene);
        return { file: inWorkspace, fromOpenScene: !!own && fs.realpathSync(own) === fs.realpathSync(inWorkspace) };
    }
    const published = /^(?:\/?public)?\/?models\/([^/\\]+\.glb)$/i.exec(glbPath)?.[1] ?? (/^[^/\\]+\.glb$/i.test(glbPath) ? glbPath : undefined);
    if (published) {
        const file = resolveWithinRoot(publishedModelsDir(), published);
        if (fs.existsSync(file)) {
            const own = resolveSceneModelPath(openScene);
            return { file, fromOpenScene: !!own && path.basename(own) === published };
        }
    }
    return { error: inWorkspace || published ? `${glbPath} does not exist in the workspace (${workspaceRoot}) or among the published models.` : `${glbPath} is outside the workspace (${workspaceRoot}).` };
}

export const virtualGeometryHandlers: Record<string, ToolHandler> = {
    async virtual_geometry_open_glb(args, ctx) {
        const glbPath = typeof args.glbPath === 'string' ? args.glbPath.trim() : '';
        const fail = (error: string) => ({ status: 'failed' as const, resultPayload: { success: false, error }, summaryResult: `Failed: ${error}` });
        if (!glbPath) return fail('glbPath is required: the .glb to open, inside the workspace.');
        let file: string;
        try {
            file = resolveWithinRoot(ctx.workspaceRoot, glbPath);
        } catch (err) {
            if (err instanceof PathTraversalError) return fail(`${glbPath} is outside the workspace (${ctx.workspaceRoot}).`);
            throw err;
        }
        if (!fs.existsSync(file)) return fail(`${glbPath} does not exist in the workspace (${ctx.workspaceRoot}).`);

        let built;
        try {
            built = await getVirtualGeometryBuildService().buildServed(file, { signal: ctx.signal });
        } catch (err) {
            if (err instanceof VirtualGeometryBuildError) return fail(err.message);
            throw err;
        }
        // Stored relative to the root it was resolved against, with that root, so the viewport's rebuild
        // request resolves the same file whatever workspace the canvas has open.
        const workspaceRoot = path.resolve(ctx.workspaceRoot);
        // resolveWithinRoot returns the real path; compare against the root's real path (macOS /var -> /private/var).
        const sourceGlbPath = path.relative(fs.realpathSync(workspaceRoot), fs.realpathSync(file)).split(path.sep).join('/');

        const title = (typeof args.title === 'string' && args.title.trim()) || `${glbPath.split(/[\\/]/).pop()} (virtual geometry)`;
        const threshold = typeof args.errorThresholdPx === 'number' && args.errorThresholdPx > 0 ? args.errorThresholdPx : undefined;
        const data: Scene3DData = {
            title,
            environment: { skybox: 'studio', lighting: 'studio', ground: false },
            virtualGeometry: {
                sourceGlbPath,
                workspaceRoot,
                sbvgUrl: built.sbvgUrl,
                ...(threshold ? { errorThresholdPx: threshold } : {}),
                ...(args.doubleSided === true ? { doubleSided: true } : {}),
                ...(built.stats ? {
                    buildStats: {
                        sourceTriangles: built.stats.sourceTriangles,
                        clusterCount: built.stats.clusterCount,
                        levelCount: built.stats.levelCount,
                        fileBytes: built.stats.fileBytes,
                        buildMs: built.buildMs ?? 0,
                        skippedPrimitives: built.summary.skippedPrimitives
                    }
                } : {})
            }
        };
        const artifact: CanvasArtifact = {
            id: `art-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            type: '3d-scene',
            title,
            summary: 'WebGPU virtual geometry (streamed cluster LOD)',
            data,
            createdAt: new Date().toISOString(),
            version: 1
        };
        const s = built.summary;
        const detail = `${s.sourceTriangles.toLocaleString()} triangles -> ${s.clusterCount.toLocaleString()} clusters in ${s.levelCount} LOD levels (${(s.fileBytes / 1048576).toFixed(1)} MB), `
            + (built.cached ? 'reused the existing build for this GLB' : `built in ${((built.buildMs ?? 0) / 1000).toFixed(1)} s`);
        const skipped = s.skippedPrimitives > 0
            ? ` ${s.skippedPrimitives} primitive${s.skippedPrimitives === 1 ? '' : 's'} without a surface (points, lines or no POSITION) ${s.skippedPrimitives === 1 ? 'was' : 'were'} left out.`
            : '';
        return {
            resultPayload: { status: 'success', artifact, sbvgUrl: built.sbvgUrl, cached: built.cached, summary: built.summary, stats: built.stats },
            summaryResult: `Opened ${sourceGlbPath} in the virtual geometry viewport: ${detail}.${skipped}`
        };
    },

    async path_trace_render(args, ctx) {
        const glbPath = typeof args.glbPath === 'string' ? args.glbPath.trim() : '';
        const fail = (error: string) => ({ status: 'failed' as const, resultPayload: { success: false, error }, summaryResult: `Failed: ${error}` });
        const openScene = ctx.request?.activeArtifact?.type === '3d-scene' ? ctx.request.activeArtifact.data as Scene3DData : undefined;
        const resolved = resolveRenderGlb(glbPath, ctx.workspaceRoot, openScene);
        if ('error' in resolved) return fail(resolved.error);
        const file = resolved.file;

        let camera: MetalPathTraceRequest['camera'];
        // No camera given: the open scene's first declared shot (sb.shot), at its own frame, else automatic framing.
        const shot: ShotCamera | undefined = !args.camera && resolved.fromOpenScene ? openScene?.shots?.[0] : undefined;
        if (shot) {
            args = { ...args, camera: { position: shot.position, target: shot.target, verticalFovDeg: verticalFovDeg(shot) } };
            if (args.width === undefined && args.height === undefined) args = { ...args, width: shot.widthPx, height: heightPx(shot) };
        }
        const cam = args.camera as Record<string, unknown> | undefined;
        let origin: [number, number, number] = [0, 0, 0];
        const built = await (async () => {
            try {
                return await getVirtualGeometryBuildService().buildServed(file, { signal: ctx.signal });
            } catch (err) {
                if (err instanceof VirtualGeometryBuildError) return err;
                throw err;
            }
        })();
        if (built instanceof VirtualGeometryBuildError) return fail(built.message);
        if (cam) {
            const position = vec3(cam.position), target = vec3(cam.target);
            if (!position || !target) return fail('camera needs position and target as [x, y, z].');
            // The file's vertices are relative to its origin; the camera is given in the GLB's coordinates.
            origin = readSbvgOrigin(built.sbvgPath);
            camera = {
                position: [position[0] - origin[0], position[1] - origin[1], position[2] - origin[2]],
                target: [target[0] - origin[0], target[1] - origin[1], target[2] - origin[2]],
                ...(typeof cam.verticalFovDeg === 'number' ? { verticalFovDeg: cam.verticalFovDeg } : {})
            };
        } else {
            const framing = (args.framing ?? {}) as Record<string, unknown>;
            camera = {
                auto: {
                    ...(typeof framing.headingDeg === 'number' ? { headingDeg: framing.headingDeg } : {}),
                    ...(typeof framing.pitchDeg === 'number' ? { pitchDeg: framing.pitchDeg } : {}),
                    ...(typeof framing.distanceScale === 'number' ? { distanceScale: framing.distanceScale } : {})
                }
            };
        }
        const sun = args.sun as { elevationDeg?: unknown; azimuthDeg?: unknown } | undefined;
        if (sun && (typeof sun.elevationDeg !== 'number' || typeof sun.azimuthDeg !== 'number')) return fail('sun needs elevationDeg and azimuthDeg.');

        const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-path-trace-render-'));
        metalPathTracer ??= new MetalPathTracerService();
        let result;
        try {
            result = await metalPathTracer.render({
                sbvgPath: built.sbvgPath,
                outputDir,
                width: clampInt(args.width, 1920, 8, 8192),
                height: clampInt(args.height, 1080, 8, 8192),
                samplesPerPixel: clampInt(args.samplesPerPixel, 1024, 1, 16384),
                maxBounces: 4,
                denoise: true,
                optimizations: { sampler: 'sobol' },
                materials: { glbPath: file },
                camera,
                lighting: sun ? { sun: { elevationDeg: sun.elevationDeg as number, azimuthDeg: sun.azimuthDeg as number } } : { studio: {} },
                ...(typeof args.exposureEv === 'number' ? { exposureEv: args.exposureEv } : {})
            });
        } catch (err) {
            fs.rmSync(outputDir, { recursive: true, force: true });
            if (err instanceof MetalPathTracerError) return fail(`${err.message}${err.detail ? `: ${err.detail.split('\n')[0]}` : ''}`);
            throw err;
        }
        const stem = path.basename(file).replace(/\.glb$/i, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 48) || 'model';
        const relative = path.posix.join('renders', 'path-traced', `${stem}-${new Date().toISOString().replace(/[:.]/g, '-')}.png`);
        const imagePath = path.join(ctx.workspaceRoot, relative);
        fs.mkdirSync(path.dirname(imagePath), { recursive: true });
        fs.copyFileSync(result.beautyPngPath, imagePath);
        const s = result.stats;
        // The camera back in the GLB's coordinates, so the record can be reused as a tool argument.
        const worldCamera = { ...s.camera, position: s.camera.position.map((v, i) => v + origin[i]), target: s.camera.target.map((v, i) => v + origin[i]) };
        const record = {
            renderer: 'Metal path tracer (sbvg_pathtracer)', device: s.device, source: path.relative(ctx.workspaceRoot, file),
            width: s.width, height: s.height, samplesPerPixel: s.samplesPerPixel, maxBounces: s.maxBounces, denoised: s.denoised,
            exposureEv: s.exposureEv, lighting: s.lighting === 'sky' ? { sun: s.sun } : { studio: {} }, camera: worldCamera,
            cut: s.cut, geometryCoverage: s.geometryCoverage, materials: s.materials, renderMs: s.renderMs, raysPerSecond: s.raysPerSecond
        };
        fs.writeFileSync(imagePath.replace(/\.png$/, '.json'), JSON.stringify(record, null, 2), 'utf8');
        fs.rmSync(outputDir, { recursive: true, force: true });
        return {
            resultPayload: { status: 'success', imagePath, workspacePath: relative, ...record },
            summaryResult: `Path traced ${record.source} at ${s.width}x${s.height}, ${s.samplesPerPixel} spp, denoised, ${s.lighting === 'sky' ? 'sun and sky' : 'studio dome'} (${(s.renderMs / 1000).toFixed(1)} s on ${s.device}); saved ${relative}.`
        };
    }
};
