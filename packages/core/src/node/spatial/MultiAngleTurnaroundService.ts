/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { mapBounded } from '../../common/async/bounded-concurrency';
import * as fs from 'fs';
import * as path from 'path';
import { IMAGE_MODEL_PRIORITY, SkippedMediaModel, describeModelUsed, resolveImageModelId, resolveRequestedModels } from '../../common/media-generation-protocol';
import { GeneratorFailedError, MediaModelUnavailableError, MissingInputError } from '../../common/errors/pipeline-errors';
import { GoogleMediaCredentialsService } from '../google-media-credentials-service';
import { generateImageWithModels, mediaRequestAborted, withMediaFailureContext } from '../google-media-generation-service';
import { FalTrellisService, type FalTrellisMultiInput, type FalTrellisResult } from './FalTrellisService';
import { FalMeshyService, type FalMeshyMultiInput, type FalMeshyResult } from './FalMeshyService';

/** Image models a turnaround tries when none is named: Nano Banana Lite first, then the standard image list. */
export const TURNAROUND_DEFAULT_MODELS = [resolveImageModelId('nano-banana-lite'), ...IMAGE_MODEL_PRIORITY];

export type RigPreset = 'dcc-ortho-4' | 'turntable-8' | 'dome-hemisphere-12' | 'custom' | (string & {});

export interface CameraPoseConfig {
    azimuthDeg: number;
    elevationDeg: number;
    label: string;
    description?: string;
}

export interface CameraStation extends CameraPoseConfig {
    stationIndex: number;
    cartesianPosition: [number, number, number]; // [X, Y, Z]
    promptAngleDescriptor: string;
    referenceStationIndices: number[]; // Indices of images to pass as references
}

export interface IsolationOptions {
    /** Whether subject must float in 100% white void with zero ground or pedestal (default: true). */
    floatingVoid?: boolean;
    /** Whether directional cast shadows must be strictly eliminated (default: true). */
    suppressShadows?: boolean;
    /** Whether text, dimensions, and labels must be strictly eliminated (default: true). */
    suppressText?: boolean;
}

export interface MultiAngleCaptureOptions {
    /** Open-domain subject description (ADA Alien Planet Test compliant). */
    subject: string;
    /** Camera orbit rig preset or custom station poses. */
    rigPreset?: RigPreset;
    /** Custom camera poses when rigPreset === 'custom'. */
    customPoses?: CameraPoseConfig[];
    /** Standoff distance radius multiplier (default: 2.0). */
    standoffRadius?: number;
    /** Visual / material style contract (default: '18-percent-studio-clay'). */
    stylePreset?: '18-percent-studio-clay' | 'pbr-delighted' | 'photorealistic' | (string & {});
    /** Non-negotiable isolation invariants for clean 3D neural reconstruction. */
    isolation?: IsolationOptions;
    /** Output directory for reference image artifacts. */
    outputDir?: string;
    /** Downstream reconstruction pipeline target (default 'none'; Trellis and Meshy run only when asked for). */
    downstreamTarget?: 'trellis-fal' | 'meshy-7.1-fal' | 'trellis' | 'none';
    /**
     * The subject's real-world size, returned with the result as the target size for scaling the GLB in the
     * scene. The GLB itself is not rescaled; its measured bounds are reported separately.
     */
    metricDimensions?: {
        lengthMeters?: number;
        widthMeters?: number;
        heightMeters?: number;
    };
    /** Image model id. When given, only that model is used; otherwise TURNAROUND_DEFAULT_MODELS, in order. */
    model?: string;
    /**
     * Stops the capture with an AbortError: checked before every station and before Trellis, and passed to each
     * image-model call, so nothing more is generated (or billed) after the caller has stopped.
     */
    signal?: AbortSignal;
    /** Progress after each captured station (fraction 0..1). */
    onProgress?: (fraction: number, message: string) => void;
    /**
     * How later stations are conditioned. 'hero-parallel' (default): station 0 first, then every other station at
     * once, each conditioned on the hero view only; wall time ~ two image calls whatever the rig size. 'chained':
     * one station at a time, each conditioned on the hero view and the previous view; slower (one call per
     * station, in order) but neighbouring views share more detail, as each sees the view next to it. The trade-off
     * is consistency between adjacent non-hero views (chained is tighter) against wall time (parallel is ~N/2x
     * faster for an N-station rig).
     */
    conditioning?: 'hero-parallel' | 'chained';
}

/** Injected collaborators (tests pass fakes; production uses Google Gen AI credentials and Fal.ai). */
export interface MultiAngleTurnaroundDependencies {
    /** Creates the Google Gen AI client that generates the views. */
    createClient?: () => Promise<any>;
    /** Runs the downstream Trellis reconstruction. */
    trellis?: { generate3DFromImages(input: FalTrellisMultiInput): Promise<FalTrellisResult> };
    /** Runs the downstream Meshy 7.1 reconstruction. */
    meshy?: { generate3DFromImages(input: FalMeshyMultiInput): Promise<FalMeshyResult> };
}

export interface CapturedView {
    stationIndex: number;
    label: string;
    azimuthDeg: number;
    elevationDeg: number;
    cartesianPosition: [number, number, number];
    promptUsed: string;
    imagePath: string;
    mimeType: string;
    /** The image model that produced this view. */
    generatedBy: string;
    buffer: Buffer;
}

export interface MultiAngleCaptureResult {
    success: boolean;
    subject: string;
    rigPreset: string;
    stylePreset: string;
    /** How the views after the hero were conditioned (see MultiAngleCaptureOptions.conditioning). */
    conditioning: 'hero-parallel' | 'chained';
    views: CapturedView[];
    /** The image model that produced every view. */
    modelUsed: string;
    /** Image models tried before modelUsed that produced nothing, with the reason (empty when the first answered). */
    skippedModels: SkippedMediaModel[];
    /** Which model produced the views and, when it was not the requested one, why. */
    modelNote: string;
    /** The downstream 3D model service used (if any). */
    downstreamTarget?: 'trellis-fal' | 'meshy-7.1-fal' | 'trellis' | 'none';
    downstreamGlb?: {
        path: string;
        vertexCount: number;
        triangleCount: number;
        byteLength: number;
        /** Extent of the reconstructed mesh in its own units, from the GLB's POSITION bounds (absent when the GLB has none). */
        measuredExtent?: [number, number, number];
        /** The size the caller gave for the subject (metricDimensions), for scaling the GLB in the scene. */
        requestedDimensionsMeters?: { lengthMeters?: number; widthMeters?: number; heightMeters?: number };
    };
    totalDurationMs: number;
}

/** Extent [x, y, z] of a GLB's meshes from the POSITION accessor min/max that glTF requires; undefined when absent. */
export function measureGlbExtent(glb: Buffer): [number, number, number] | undefined {
    if (glb.length < 20 || glb.toString('utf8', 0, 4) !== 'glTF') return undefined;
    const jsonLength = glb.readUInt32LE(12);
    const gltf = JSON.parse(glb.toString('utf8', 20, 20 + jsonLength));
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    let found = false;
    for (const mesh of gltf.meshes || []) {
        for (const prim of mesh.primitives || []) {
            const accessor = gltf.accessors?.[prim.attributes?.POSITION];
            if (!Array.isArray(accessor?.min) || !Array.isArray(accessor?.max)) continue;
            for (let i = 0; i < 3; i++) {
                min[i] = Math.min(min[i], accessor.min[i]);
                max[i] = Math.max(max[i], accessor.max[i]);
            }
            found = true;
        }
    }
    return found ? [max[0] - min[0], max[1] - min[1], max[2] - min[2]] : undefined;
}

function extensionFor(mimeType: string): string {
    if (mimeType === 'image/jpeg') return 'jpg';
    if (mimeType === 'image/webp') return 'webp';
    return 'png';
}

export class MultiAngleTurnaroundService {
    constructor(private readonly deps: MultiAngleTurnaroundDependencies = {}) {}

    public static readonly STANDARD_PRESETS: Record<string, CameraPoseConfig[]> = {
        'dcc-ortho-4': [
            { azimuthDeg: 45, elevationDeg: 30, label: 'iso', description: '3/4 isometric perspective down-angle' },
            { azimuthDeg: 90, elevationDeg: 0, label: 'side', description: 'pure horizontal side profile elevation' },
            { azimuthDeg: 0, elevationDeg: 0, label: 'front', description: 'direct front-facing orthographic view' },
            { azimuthDeg: 180, elevationDeg: 0, label: 'rear', description: 'direct rear-facing three-quarter angle' }
        ],
        'turntable-8': [
            { azimuthDeg: 0, elevationDeg: 15, label: 'turntable_000', description: '0 degrees azimuth, front elevation' },
            { azimuthDeg: 45, elevationDeg: 15, label: 'turntable_045', description: '45 degrees azimuth, front-right quarter' },
            { azimuthDeg: 90, elevationDeg: 15, label: 'turntable_090', description: '90 degrees azimuth, right profile' },
            { azimuthDeg: 135, elevationDeg: 15, label: 'turntable_135', description: '135 degrees azimuth, rear-right quarter' },
            { azimuthDeg: 180, elevationDeg: 15, label: 'turntable_180', description: '180 degrees azimuth, direct rear view' },
            { azimuthDeg: 225, elevationDeg: 15, label: 'turntable_225', description: '225 degrees azimuth, rear-left quarter' },
            { azimuthDeg: 270, elevationDeg: 15, label: 'turntable_270', description: '270 degrees azimuth, left profile' },
            { azimuthDeg: 315, elevationDeg: 15, label: 'turntable_315', description: '315 degrees azimuth, front-left quarter' }
        ],
        'dome-hemisphere-12': [
            // 8 Horizon orbit stations at 15 deg elevation
            { azimuthDeg: 0, elevationDeg: 15, label: 'dome_h_000', description: 'horizon front' },
            { azimuthDeg: 45, elevationDeg: 15, label: 'dome_h_045', description: 'horizon front-right' },
            { azimuthDeg: 90, elevationDeg: 15, label: 'dome_h_090', description: 'horizon right profile' },
            { azimuthDeg: 135, elevationDeg: 15, label: 'dome_h_135', description: 'horizon rear-right' },
            { azimuthDeg: 180, elevationDeg: 15, label: 'dome_h_180', description: 'horizon rear' },
            { azimuthDeg: 225, elevationDeg: 15, label: 'dome_h_225', description: 'horizon rear-left' },
            { azimuthDeg: 270, elevationDeg: 15, label: 'dome_h_270', description: 'horizon left profile' },
            { azimuthDeg: 315, elevationDeg: 15, label: 'dome_h_315', description: 'horizon front-left' },
            // 4 High-angle diagonal stations at 45 deg elevation
            { azimuthDeg: 45, elevationDeg: 45, label: 'dome_high_045', description: 'high-angle diagonal front-right' },
            { azimuthDeg: 135, elevationDeg: 45, label: 'dome_high_135', description: 'high-angle diagonal rear-right' },
            { azimuthDeg: 225, elevationDeg: 45, label: 'dome_high_225', description: 'high-angle diagonal rear-left' },
            { azimuthDeg: 315, elevationDeg: 45, label: 'dome_high_315', description: 'high-angle diagonal front-left' }
        ]
    };

    /**
     * Calculates the spherical and Cartesian camera station poses for a given rig configuration. An unknown rig,
     * or 'custom' without poses, is an error rather than another rig.
     */
    public static computeStations(
        rigPreset: RigPreset = 'dcc-ortho-4',
        customPoses?: CameraPoseConfig[],
        standoffRadius = 2.0
    ): CameraStation[] {
        let rawConfigs: CameraPoseConfig[];
        if (rigPreset === 'custom') {
            if (!customPoses?.length) {
                throw new MissingInputError('generate_multi_angle_turnaround', 'customPoses', 'a custom rig needs at least one { azimuthDeg, elevationDeg, label } pose');
            }
            rawConfigs = customPoses;
        } else if (Object.prototype.hasOwnProperty.call(this.STANDARD_PRESETS, rigPreset)) {
            rawConfigs = this.STANDARD_PRESETS[rigPreset];
        } else {
            throw new MissingInputError('generate_multi_angle_turnaround', 'rigPreset',
                `unknown rig "${rigPreset}"; use ${Object.keys(this.STANDARD_PRESETS).join(', ')} or custom with customPoses`);
        }

        return rawConfigs.map((cfg, idx) => {
            const thetaRad = (cfg.azimuthDeg * Math.PI) / 180;
            const phiRad = (cfg.elevationDeg * Math.PI) / 180;

            const x = standoffRadius * Math.cos(phiRad) * Math.sin(thetaRad);
            const y = standoffRadius * Math.sin(phiRad);
            const z = standoffRadius * Math.cos(phiRad) * Math.cos(thetaRad);

            // Dual-Anchor Reference Graph:
            // - Station 0: No references (text anchor)
            // - Station 1: Reference Station 0 (Hero Anchor)
            // - Station >= 2: Reference Station 0 (Hero Anchor) + Station i - 1 (Adjacent Continuity)
            const refIndices: number[] = [];
            if (idx === 1) {
                refIndices.push(0);
            } else if (idx >= 2) {
                refIndices.push(0, idx - 1);
            }

            return {
                ...cfg,
                stationIndex: idx,
                cartesianPosition: [Number(x.toFixed(4)), Number(y.toFixed(4)), Number(z.toFixed(4))],
                promptAngleDescriptor: cfg.description || `${cfg.azimuthDeg} degrees azimuth, ${cfg.elevationDeg} degrees elevation`,
                referenceStationIndices: refIndices
            };
        });
    }

    /**
     * Synthesizes the positive prompt enforcing ADA continuous physical descriptors and isolation rules.
     */
    public static buildPrompt(
        subject: string,
        station: CameraStation,
        stylePreset = '18-percent-studio-clay',
        isolation: IsolationOptions = {}
    ): { positive: string; negative: string } {
        const floatingVoid = isolation.floatingVoid !== false;
        const noShadows = isolation.suppressShadows !== false;
        const noText = isolation.suppressText !== false;

        // Named styles have tuned wording; any other style text is used as given rather than replaced by clay.
        let styleDesc = `rendered in this style: ${stylePreset}`;
        if (stylePreset === '18-percent-studio-clay') {
            styleDesc = 'sculpted entirely in 18 percent neutral studio grey clay with a matte ceramic surface finish';
        } else if (stylePreset === 'pbr-delighted') {
            styleDesc = 'rendered with clean unshadowed PBR textures and intrinsic diffuse albedo';
        } else if (stylePreset === 'photorealistic') {
            styleDesc = 'photorealistic high-fidelity physical capture';
        }

        let isolationDesc = '';
        if (floatingVoid) {
            isolationDesc += 'The subject is completely isolated and floating freely in the center of an infinite, pure solid white void. No ground plane, no floor, no pedestal, no plinth beneath the object. ';
        }
        if (noShadows) {
            isolationDesc += 'Completely shadow-free, zero cast shadows, zero drop shadow, lit exclusively by uniform omnidirectional diffuse ambient light with soft ambient occlusion in crevices. ';
        }
        if (noText) {
            isolationDesc += 'No text, no letters, no typography, no labels, no watermarks, no annotations, no measurement lines, no grid. ';
        }

        const isSequential = station.stationIndex > 0;
        const referencePrefix = isSequential
            ? 'Exact same 3D digital sculpt maquette shown in the reference image(s), maintaining identical geometry, proportions, micro-relief, and surface details. '
            : 'A 3D digital sculpt maquette of ';

        const positive = `${referencePrefix}${subject}, ${styleDesc}. ${isolationDesc}High surface curvature relief. Clean, razor-sharp silhouette boundaries. Viewed from ${station.promptAngleDescriptor}.`;

        const negative = [
            'ground', 'floor', 'floor plane', 'pavement', 'grass', 'terrain', 'concrete slab', 'dirt',
            'shadow', 'cast shadow', 'drop shadow', 'contact shadow', 'pedestal', 'plinth', 'stand',
            'table', 'display base', 'text', 'typography', 'letters', 'watermark', 'signature',
            'font', 'caption', 'callout', 'title', 'numbers', 'dimensions', 'grid', 'ruler', 'border', 'frame'
        ].join(', ');

        return { positive, negative };
    }

    /**
     * Captures every station with an image model: station 0 from the prompt alone, then (default 'hero-parallel')
     * every later station at once conditioned on the hero view, or ('chained') one at a time conditioned on the hero
     * view and the previous view. The first model that answers produces every view (one model per rig
     * keeps the subject consistent). With downstreamTarget 'trellis-fal' the views then go to Trellis on Fal.ai.
     * Any step that cannot do its job throws (MissingInputError, MediaModelUnavailableError,
     * GeneratorFailedError); no placeholder image or mesh is written in its place.
     */
    public async execute(options: MultiAngleCaptureOptions): Promise<MultiAngleCaptureResult> {
        const startTime = Date.now();
        if (!options.subject?.trim()) {
            throw new MissingInputError('generate_multi_angle_turnaround', 'subject', 'describe what to capture');
        }
        const rigPreset = options.rigPreset || 'dcc-ortho-4';
        const stylePreset = options.stylePreset || '18-percent-studio-clay';
        const isolation = options.isolation || { floatingVoid: true, suppressShadows: true, suppressText: true };
        const outputDir = options.outputDir || path.resolve(process.cwd(), 'output/turnarounds');

        const stations = MultiAngleTurnaroundService.computeStations(
            rigPreset,
            options.customPoses,
            options.standoffRadius
        );

        let models = resolveRequestedModels(options.model, TURNAROUND_DEFAULT_MODELS);
        let client: any;
        try {
            client = await (this.deps.createClient ? this.deps.createClient() : new GoogleMediaCredentialsService().createClient());
        } catch (err: any) {
            throw new MediaModelUnavailableError(models[0], `Google media credentials are not available (${err?.message || err})`);
        }
        await fs.promises.mkdir(outputDir, { recursive: true });

        const capturedViews: CapturedView[] = [];
        let modelUsed: string | undefined;
        let skippedModels: SkippedMediaModel[] = [];

        const stopIfAborted = () => {
            if (options.signal?.aborted) throw mediaRequestAborted();
        };
        const conditioning = options.conditioning ?? 'hero-parallel';
        const captureStation = async (station: typeof stations[number], references: CapturedView[], signal?: AbortSignal): Promise<CapturedView> => {
            if (signal?.aborted) throw mediaRequestAborted();
            const { positive, negative } = MultiAngleTurnaroundService.buildPrompt(
                options.subject,
                station,
                stylePreset,
                isolation
            );
            const contents = [
                { text: `${positive} Avoid: ${negative}.` },
                ...references.map(view => ({ inlineData: { data: view.buffer.toString('base64'), mimeType: view.mimeType } }))
            ];
            let answer;
            try {
                answer = await generateImageWithModels(client, { models, contents, imageConfig: { aspectRatio: '1:1' }, signal });
            } catch (err) {
                // Model failures gain the station name; any other error (a bug, a local failure) propagates as it is.
                throw withMediaFailureContext(err, `station ${station.label}`);
            }
            if (!modelUsed) {
                modelUsed = answer.modelUsed;
                skippedModels = answer.skippedModels;
                models = [answer.modelUsed];
            }

            const filename = `turnaround_${station.stationIndex.toString().padStart(2, '0')}_${station.label}.${extensionFor(answer.mimeType)}`;
            const filePath = path.join(outputDir, filename);
            await fs.promises.writeFile(filePath, answer.data);
            done++;
            options.onProgress?.(done / stations.length, `Captured station ${station.label} (${done}/${stations.length}) with ${answer.modelUsed}`);
            return {
                stationIndex: station.stationIndex,
                label: station.label,
                azimuthDeg: station.azimuthDeg,
                elevationDeg: station.elevationDeg,
                cartesianPosition: station.cartesianPosition,
                promptUsed: positive,
                imagePath: filePath,
                mimeType: answer.mimeType,
                generatedBy: answer.modelUsed,
                buffer: answer.data
            };
        };
        let done = 0;
        if (conditioning === 'chained') {
            for (const station of stations) {
                stopIfAborted();
                capturedViews.push(await captureStation(station, station.referenceStationIndices.map(i => capturedViews[i]), options.signal));
            }
        } else if (stations.length > 0) {
            // The hero view fixes the model and is the one reference every other station is drawn from.
            stopIfAborted();
            const hero = await captureStation(stations[0], [], options.signal);
            capturedViews.push(hero);
            capturedViews.push(...await mapBounded(stations.slice(1), (station, _i, signal) => captureStation(station, [hero], signal), { signal: options.signal }));
        }

        let downstreamGlb: MultiAngleCaptureResult['downstreamGlb'] = undefined;

        // Downstream Trellis Execution (Fal.ai), only when asked for
        if (options.downstreamTarget === 'trellis-fal' || options.downstreamTarget === 'trellis') {
            stopIfAborted();
            const glbPath = path.join(outputDir, `trellis_${path.basename(outputDir)}_${Date.now()}.glb`);
            const trellis = this.deps.trellis || new FalTrellisService();
            const falResult = await trellis.generate3DFromImages({
                imagePaths: capturedViews.map(v => v.imagePath),
                destinationGlbPath: glbPath,
                ssSamplingSteps: 12,
                slatSamplingSteps: 12,
                meshSimplify: 0.95,
                signal: options.signal
            });
            if (!falResult.localGlbPath || !fs.existsSync(falResult.localGlbPath)) {
                throw new GeneratorFailedError('fal-trellis', `Trellis returned no GLB at ${glbPath}`);
            }
            const glb = await fs.promises.readFile(falResult.localGlbPath);
            if (!falResult.stats || falResult.stats.totalVertices <= 0) {
                throw new GeneratorFailedError('fal-trellis', `Trellis returned a GLB with no vertices (${falResult.localGlbPath})`);
            }
            downstreamGlb = {
                path: falResult.localGlbPath,
                vertexCount: falResult.stats.totalVertices,
                triangleCount: falResult.stats.totalTriangles,
                byteLength: glb.length,
                measuredExtent: measureGlbExtent(glb),
                requestedDimensionsMeters: options.metricDimensions
            };
        }

        // Downstream Meshy 7.1 Execution (Fal.ai), only when asked for
        if (options.downstreamTarget === 'meshy-7.1-fal') {
            stopIfAborted();
            const glbPath = path.join(outputDir, `meshy_${path.basename(outputDir)}_${Date.now()}.glb`);
            const meshy = this.deps.meshy || new FalMeshyService();
            const falResult = await meshy.generate3DFromImages({
                imagePaths: capturedViews.map(v => v.imagePath),
                destinationGlbPath: glbPath,
                enableRemesher: true,
                remeshingThreshold: 0.1,
                textureResolution: 2048,
                signal: options.signal
            });
            if (!falResult.localGlbPath || !fs.existsSync(falResult.localGlbPath)) {
                throw new GeneratorFailedError('fal-meshy', `Meshy returned no GLB at ${glbPath}`);
            }
            const glb = await fs.promises.readFile(falResult.localGlbPath);
            if (!falResult.stats || falResult.stats.totalVertices <= 0) {
                throw new GeneratorFailedError('fal-meshy', `Meshy returned a GLB with no vertices (${falResult.localGlbPath})`);
            }
            downstreamGlb = {
                path: falResult.localGlbPath,
                vertexCount: falResult.stats.totalVertices,
                triangleCount: falResult.stats.totalTriangles,
                byteLength: glb.length,
                measuredExtent: measureGlbExtent(glb),
                requestedDimensionsMeters: options.metricDimensions
            };
        }

        const used = modelUsed || models[0];
        return {
            success: true,
            subject: options.subject,
            rigPreset,
            stylePreset,
            conditioning,
            views: capturedViews,
            modelUsed: used,
            skippedModels,
            modelNote: describeModelUsed(used, skippedModels),
            downstreamTarget: options.downstreamTarget,
            downstreamGlb,
            totalDurationMs: Date.now() - startTime
        };
    }
}
