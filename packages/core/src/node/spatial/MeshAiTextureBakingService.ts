/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { mapBounded } from '../../common/async/bounded-concurrency';
import * as fs from 'fs-extra';
import * as path from 'path';
import { RenderMesh3D } from './HeadlessMeshSilhouetteRenderer';
import { CameraPose6DOF } from './SubPixelEdgeAlignmentOptimizer';
import { NativeAiRenderEngineService } from './NativeAiRenderEngineService';
import { createDefaultStationImageGenerator, StationImageGenerator } from './BeautifyStationService';
import { SurveyTextureUnprojector, type StationPlate, type UnprojectionMetrics } from './SurveyTextureUnprojector';
import { AlgorithmicUvEngine } from './AlgorithmicUvEngine';
import { decodeImageToRgba } from '../image-codec-ffmpeg';
import { resampleRgba } from '../texture-processing';
import { GeneratorFailedError, MissingInputError } from '../../common/errors/pipeline-errors';
import type { ColmapCameraPose } from '../../common/spatial/colmap-vector-reference-types';

export interface OrthogonalCamera {
    name: 'Front' | 'Back' | 'Left' | 'Right' | 'Top' | 'Bottom';
    pose: CameraPose6DOF;
}

export interface BakedView {
    name: 'Front' | 'Back' | 'Left' | 'Right' | 'Top' | 'Bottom';
    image: Buffer;
    pose: CameraPose6DOF;
    /** The image model that produced the view and, when it was not the requested one, why. */
    imageSource: string;
    modelUsed?: string;
}

/** A view whose image could not be projected (it came back at another aspect ratio, or did not decode). */
export interface RejectedBakeView {
    name: OrthogonalCamera['name'];
    reason: string;
    imageSource: string;
}

export interface MeshAiTextureBakeRequest {
    /** The mesh to texture: a GLB whose primitives carry UVs (TEXCOORD_0). */
    glbPath: string;
    stylePrompt: string;
    /** Size of each rendered and restyled view (default 512 x 512). */
    width?: number;
    height?: number;
    /** Where the textured copy is written; the input GLB is not changed. */
    outGlbPath: string;
    /** Atlas size per primitive (default: its current base colour texture size, else 1024). */
    resolution?: number;
    signal?: AbortSignal;
    onProgress?: (message: string, fraction: number) => void;
}

export interface MeshAiTextureBakeResult {
    outGlbPath: string;
    /** The views whose images were projected onto the mesh. */
    views: BakedView[];
    rejectedViews: RejectedBakeView[];
    metrics: UnprojectionMetrics;
    /** Texels of painted primitives that no view saw; they keep the mesh's own colour. */
    unobservedTexels: number;
    imageSources: string[];
    modelsUsed: string[];
}

export interface MeshAiTextureBakingServiceOptions {
    generator?: StationImageGenerator;
    workspaceRoot?: string;
}

/** Answers further than this from the view's aspect ratio were re-framed by the model and would not line up. */
const VIEW_ASPECT_TOLERANCE = 0.04;

export class MeshAiTextureBakingService {
    private generator: StationImageGenerator;
    private workspaceRoot: string;

    constructor(options?: MeshAiTextureBakingServiceOptions) {
        this.workspaceRoot = options?.workspaceRoot || process.cwd();
        this.generator = options?.generator || createDefaultStationImageGenerator({
            workspaceRoot: this.workspaceRoot
        });
    }

    /**
     * Computes the axis-aligned bounding box (AABB) of the mesh, and constructs
     * a 6-camera cardinal orthogonal camera rig focusing on the center of the mesh.
     */
    public generateOrthogonalCameraRig(mesh: RenderMesh3D): OrthogonalCamera[] {
        const verts = mesh.vertices;
        let minX = Infinity, minY = Infinity, minZ = Infinity;
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

        const count = verts.length;
        for (let i = 0; i < count; i += 3) {
            const x = verts[i];
            const y = verts[i + 1];
            const z = verts[i + 2];

            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
            if (z < minZ) minZ = z;
            if (z > maxZ) maxZ = z;
        }

        if (minX === Infinity) {
            throw new MissingInputError('mesh_bake_ai_textures', 'a mesh with vertices', 'there is nothing to frame the views around');
        }

        const centerX = (minX + maxX) / 2;
        const centerY = (minY + maxY) / 2;
        const centerZ = (minZ + maxZ) / 2;

        const dx = maxX - minX;
        const dy = maxY - minY;
        const dz = maxZ - minZ;
        const diagonal = Math.hypot(dx, dy, dz) || 1.0;

        // Ensure cameras are positioned at a safe non-zero standoff distance
        const distance = Math.max(diagonal * 1.5, 2.5);

        const names: ('Front' | 'Back' | 'Left' | 'Right' | 'Top' | 'Bottom')[] = [
            'Front', 'Back', 'Left', 'Right', 'Top', 'Bottom'
        ];

        return names.map((name) => {
            let cx = centerX;
            let cy = centerY;
            let cz = centerZ;
            let up: [number, number, number] = [0, 1, 0];

            switch (name) {
                case 'Front':
                    cz = centerZ + distance;
                    break;
                case 'Back':
                    cz = centerZ - distance;
                    break;
                case 'Left':
                    cx = centerX - distance;
                    break;
                case 'Right':
                    cx = centerX + distance;
                    break;
                case 'Top':
                    cy = centerY + distance;
                    up = [0, 0, -1]; // Facing straight down the -Y axis
                    break;
                case 'Bottom':
                    cy = centerY - distance;
                    up = [0, 0, 1]; // Facing straight up the +Y axis
                    break;
            }

            return {
                name,
                pose: {
                    x: cx,
                    y: cy,
                    z: cz,
                    targetX: centerX,
                    targetY: centerY,
                    targetZ: centerZ,
                    up,
                    fov: 50 // Standard perspective lens
                }
            };
        });
    }

    /**
     * Textures a mesh from its six axis-aligned views: each view is rendered from the mesh (clay and depth), restyled
     * by the image model to the style prompt, and projected back onto the mesh's own UVs with depth occlusion
     * (SurveyTextureUnprojector). The textured copy is written to outGlbPath. A view whose image comes back at another
     * aspect ratio is left out and reported; texels of a painted primitive that no view sees keep the mesh's own
     * colour. Throws MissingInputError for a GLB without UVs (or with accessors the reader cannot decode), and
     * GeneratorFailedError, writing nothing, when no view could be projected or any primitive was painted by no view.
     */
    public async bakeMeshTexturesWithAi(request: MeshAiTextureBakeRequest): Promise<MeshAiTextureBakeResult> {
        const width = request.width || 512;
        const height = request.height || 512;
        if (!request.stylePrompt) throw new MissingInputError('mesh_bake_ai_textures', 'stylePrompt');
        if (!request.outGlbPath) throw new MissingInputError('mesh_bake_ai_textures', 'outGlbPath');
        if (!request.glbPath || !(await fs.pathExists(request.glbPath))) {
            throw new MissingInputError('mesh_bake_ai_textures', 'glbPath', `${request.glbPath || '(none)'} does not exist`);
        }
        const glbBuffer = await fs.readFile(request.glbPath);
        const mesh = MeshAiTextureBakingService.meshWithUvsFromGlb(glbBuffer, request.glbPath);

        const rig = this.generateOrthogonalCameraRig(mesh);
        const renderer = new NativeAiRenderEngineService({ generator: this.generator, workspaceRoot: this.workspaceRoot });
        const views: BakedView[] = [];
        const rejectedViews: RejectedBakeView[] = [];
        const plates: StationPlate[] = [];

        if (request.signal?.aborted) {
            throw Object.assign(new Error('Texture bake was stopped'), { name: 'AbortError' });
        }
        // The six views are independent model calls: restyle them all at once (wall time ~ one call, not six),
        // then assemble in rig order so the result does not depend on which call answered first.
        let finished = 0;
        request.onProgress?.(`Restyling ${rig.length} views at once`, 0);
        const answers = await mapBounded(rig, async (camera, _index, signal) => {
            const beauty = await renderer.renderAiBeautyFrame({
                mesh,
                pose: camera.pose,
                prompt: `A close-up view of ${request.stylePrompt} material surface, high definition, flat uniform studio lighting, perfectly seamless textures. View direction: ${camera.name}`,
                width,
                height,
                signal
            });
            finished++;
            request.onProgress?.(`Restyled the ${camera.name} view (${finished}/${rig.length})`, 0.8 * (finished / rig.length));
            return beauty;
        }, { signal: request.signal });

        for (const [index, camera] of rig.entries()) {
            const beauty = answers[index];
            let decoded: { rgba: Buffer; width: number; height: number };
            try {
                decoded = await decodeImageToRgba(beauty.image);
            } catch (err: any) {
                rejectedViews.push({ name: camera.name, reason: `the image did not decode (${err?.message || err})`, imageSource: beauty.imageSource });
                continue;
            }
            const asked = width / height;
            const answered = decoded.width / decoded.height;
            if (Math.abs(answered - asked) / asked > VIEW_ASPECT_TOLERANCE) {
                rejectedViews.push({
                    name: camera.name,
                    reason: `asked for ${width}x${height}, the model answered ${decoded.width}x${decoded.height}, which would not line up with the mesh`,
                    imageSource: beauty.imageSource
                });
                continue;
            }
            const rgba = decoded.width === width && decoded.height === height
                ? decoded.rgba
                : resampleRgba(decoded.rgba, decoded.width, decoded.height, width, height);
            views.push({ name: camera.name, image: beauty.image, pose: camera.pose, imageSource: beauty.imageSource, modelUsed: beauty.modelUsed });
            const fovRad = (camera.pose.fov * Math.PI) / 180;
            const fy = (height / 2) / Math.tan(fovRad / 2);
            plates.push({
                // The unprojector identifies a plate's camera by id; the pose and intrinsics below carry the optics.
                station: { id: index + 1, name: camera.name } as unknown as ColmapCameraPose,
                rgba,
                width,
                height,
                depth: beauty.passes.depth,
                pose: camera.pose,
                intrinsics: {
                    width, height, fx: fy, fy, cx: width / 2, cy: height / 2,
                    horizontalFovDegrees: (2 * Math.atan((width / 2) / fy) * 180) / Math.PI,
                    verticalFovDegrees: camera.pose.fov
                },
                imageSource: beauty.imageSource,
                modelUsed: beauty.modelUsed
            });
        }
        if (plates.length === 0) {
            throw new GeneratorFailedError('image model', `no view of ${request.glbPath} could be projected: `
                + rejectedViews.map(v => `${v.name}: ${v.reason} (${v.imageSource})`).join('; '));
        }

        request.onProgress?.('Projecting the views onto the mesh UVs', 0.85);
        const diagonal = MeshAiTextureBakingService.diagonal(mesh);
        // The unprojector reads the GLB with the same loader the render mesh came from, so the views are projected
        // onto exactly the triangles they were rendered from. Nothing is written until every primitive is painted.
        const result = await SurveyTextureUnprojector.processGlbWithSurveyStations({
            glbPath: request.glbPath,
            stations: [],
            precomputedPlates: plates,
            options: {
                resolution: request.resolution,
                // Occlusion tolerance scaled to the object (the survey default of 20 cm suits buildings, not props).
                depthTolerance: Math.max(1e-4, diagonal * 0.01),
                skipPbrDecomposition: true
            },
            signal: request.signal
        });
        const submeshes = result.submeshes || [];
        const unpainted = submeshes.filter(sub => !(sub.metrics.directlyPaintedTexels > 0));
        if (submeshes.length === 0 || unpainted.length > 0) {
            const viewNames = views.map(v => v.name).join(', ');
            const detail = submeshes.length === 0
                ? `${request.glbPath} has no primitive the unprojector could read`
                : unpainted.length === submeshes.length
                    ? `no texel of ${request.glbPath} was painted by the ${views.length} projected view(s) (${viewNames})`
                    : `${unpainted.length} of ${submeshes.length} primitives of ${request.glbPath} were painted by none of the ${views.length} projected view(s) (${viewNames}): `
                        + unpainted.map(sub => `primitive ${sub.primitiveIndex} (${sub.metrics.coveredMeshTexels > 0 ? 'hidden from every view' : 'its UVs cover no texel of the atlas'})`).join(', ');
            throw new GeneratorFailedError('texture bake', `${detail}; the textured copy was not written`);
        }
        await fs.ensureDir(path.dirname(request.outGlbPath));
        await fs.writeFile(request.outGlbPath, result.glbBuffer);
        return {
            outGlbPath: request.outGlbPath,
            views,
            rejectedViews,
            metrics: result.metrics,
            unobservedTexels: result.unobservedTexels,
            imageSources: result.imageSources,
            modelsUsed: result.modelsUsed
        };
    }

    /**
     * The GLB's primitives as one render mesh, in the same raw vertex space the unprojector reads, after checking
     * that every primitive has UVs to paint (TEXCOORD_0 spanning a non-zero area).
     */
    static meshWithUvsFromGlb(glbBuffer: Buffer, label: string): RenderMesh3D {
        let json: any;
        try {
            json = AlgorithmicUvEngine.parseGlb(glbBuffer).json;
        } catch (err: any) {
            throw new MissingInputError('mesh_bake_ai_textures', 'glbPath', `${label} is not a readable GLB (${err?.message || err})`);
        }
        const prims: any[] = (json.meshes || []).flatMap((m: any) => m?.primitives || []);
        const missing = prims.findIndex(p => p?.attributes?.TEXCOORD_0 === undefined);
        if (prims.length === 0 || missing >= 0) {
            throw new MissingInputError('mesh_bake_ai_textures', 'a GLB with UVs',
                `${label} ${prims.length === 0 ? 'has no primitives' : `primitive ${missing} has no TEXCOORD_0`}; a texture needs UVs to be painted onto (unwrap the mesh first)`);
        }
        const notTriangles = prims.findIndex(p => (p?.mode ?? 4) !== 4);
        if (notTriangles >= 0) {
            throw new MissingInputError('mesh_bake_ai_textures', 'a triangle mesh', `${label} primitive ${notTriangles} has primitive mode ${prims[notTriangles].mode} (not a triangle list), which cannot be textured from views`);
        }
        let primitives: ReturnType<typeof SurveyTextureUnprojector.loadMeshPrimitives>['primitives'];
        try {
            // The loader the unprojector uses, so render and projection see the same triangles.
            primitives = SurveyTextureUnprojector.loadMeshPrimitives(glbBuffer, 1024).primitives;
        } catch (err: any) {
            if (!(err instanceof MissingInputError)) throw err;
            throw new MissingInputError('mesh_bake_ai_textures', 'glbPath', `${label} cannot be read faithfully: ${err.message}`);
        }
        const vertices: number[] = [];
        const indices: number[] = [];
        primitives.forEach((prim, i) => {
            let uvArea = 0;
            for (let t = 0; t + 2 < prim.indices.length; t += 3) {
                const a = prim.indices[t] * 2, b = prim.indices[t + 1] * 2, c = prim.indices[t + 2] * 2;
                uvArea += Math.abs((prim.uvs[b] - prim.uvs[a]) * (prim.uvs[c + 1] - prim.uvs[a + 1]) - (prim.uvs[c] - prim.uvs[a]) * (prim.uvs[b + 1] - prim.uvs[a + 1])) / 2;
            }
            if (!(uvArea > 1e-9)) {
                throw new MissingInputError('mesh_bake_ai_textures', 'a GLB with UVs', `${label} primitive ${i} has UVs that cover no area; a texture cannot be painted onto them (unwrap the mesh first)`);
            }
            const base = vertices.length / 3;
            // A loop, not push(...positions): a large primitive would exceed the argument limit.
            for (let k = 0; k < prim.positions.length; k++) vertices.push(prim.positions[k]);
            for (const idx of prim.indices) indices.push(base + idx);
        });
        return { vertices: new Float32Array(vertices), indices: new Uint32Array(indices) };
    }

    private static diagonal(mesh: RenderMesh3D): number {
        const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
        for (let i = 0; i < mesh.vertices.length; i++) {
            min[i % 3] = Math.min(min[i % 3], mesh.vertices[i]);
            max[i % 3] = Math.max(max[i % 3], mesh.vertices[i]);
        }
        return Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) || 1;
    }
}
