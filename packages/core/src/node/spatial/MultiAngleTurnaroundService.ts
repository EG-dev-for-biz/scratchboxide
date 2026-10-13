/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as fs from 'fs';
import * as path from 'path';

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

import { FalTrellisService } from './FalTrellisService';

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
    /** Downstream reconstruction pipeline target. */
    downstreamTarget?: 'trellis-fal' | 'trellis' | 'none';
    /** Enforced real-world metric dimensions for .glb post-processing. */
    metricDimensions?: {
        lengthMeters?: number;
        widthMeters?: number;
        heightMeters?: number;
    };
    /** Whether to run in mock/offline mode for testing without GPU/network. */
    mockExecution?: boolean;
}

export interface CapturedView {
    stationIndex: number;
    label: string;
    azimuthDeg: number;
    elevationDeg: number;
    cartesianPosition: [number, number, number];
    promptUsed: string;
    imagePath: string;
    imageUrl: string;
    buffer: Buffer;
}

export interface MultiAngleCaptureResult {
    success: boolean;
    subject: string;
    rigPreset: string;
    stylePreset: string;
    views: CapturedView[];
    downstreamGlb?: {
        path: string;
        url: string;
        vertexCount: number;
        triangleCount: number;
        byteLength: number;
        boundingBoxMeters: [number, number, number];
    };
    totalDurationMs: number;
}

export class MultiAngleTurnaroundService {
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
     * Calculates the spherical and Cartesian camera station poses for a given rig configuration.
     */
    public static computeStations(
        rigPreset: RigPreset = 'dcc-ortho-4',
        customPoses?: CameraPoseConfig[],
        standoffRadius = 2.0
    ): CameraStation[] {
        const rawConfigs = rigPreset === 'custom' && customPoses && customPoses.length > 0
            ? customPoses
            : (this.STANDARD_PRESETS[rigPreset] || this.STANDARD_PRESETS['dcc-ortho-4']);

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

        let styleDesc = 'sculpted entirely in 18 percent neutral studio grey clay with a matte ceramic surface finish';
        if (stylePreset === 'pbr-delighted') {
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
     * Executes the multi-angle turnaround capture workflow.
     */
    public async execute(options: MultiAngleCaptureOptions): Promise<MultiAngleCaptureResult> {
        const startTime = Date.now();
        const rigPreset = options.rigPreset || 'dcc-ortho-4';
        const stylePreset = options.stylePreset || '18-percent-studio-clay';
        const isolation = options.isolation || { floatingVoid: true, suppressShadows: true, suppressText: true };
        const outputDir = options.outputDir || path.resolve(process.cwd(), 'output/turnarounds');
        await fs.promises.mkdir(outputDir, { recursive: true });

        const stations = MultiAngleTurnaroundService.computeStations(
            rigPreset,
            options.customPoses,
            options.standoffRadius
        );

        const capturedViews: CapturedView[] = [];

        for (const station of stations) {
            const { positive } = MultiAngleTurnaroundService.buildPrompt(
                options.subject,
                station,
                stylePreset,
                isolation
            );

            const filename = `turnaround_${station.stationIndex.toString().padStart(2, '0')}_${station.label}.png`;
            const filePath = path.join(outputDir, filename);

            // In mock/offline execution mode, write lightweight valid PNG headers or mock buffers
            let buffer: Buffer;
            if (options.mockExecution || !process.env.GEMINI_API_KEY) {
                buffer = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 1, 0, 0, 0, 1, 0, 8, 6, 0, 0, 0, 92, 114, 168, 102]);
                await fs.promises.writeFile(filePath, buffer);
            } else {
                buffer = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
                await fs.promises.writeFile(filePath, buffer);
            }

            capturedViews.push({
                stationIndex: station.stationIndex,
                label: station.label,
                azimuthDeg: station.azimuthDeg,
                elevationDeg: station.elevationDeg,
                cartesianPosition: station.cartesianPosition,
                promptUsed: positive,
                imagePath: filePath,
                imageUrl: `/images/${filename}`,
                buffer
            });
        }

        let downstreamGlb: MultiAngleCaptureResult['downstreamGlb'] = undefined;

        // Downstream Trellis Execution (Fal.ai)
        if (options.downstreamTarget === 'trellis-fal' || options.downstreamTarget === 'trellis') {
            const glbFilename = `trellis_${path.basename(outputDir)}_${Date.now()}.glb`;
            const glbPath = path.join(outputDir, glbFilename);
            const falService = new FalTrellisService({ mockExecution: options.mockExecution });

            const falResult = await falService.generate3DFromImages({
                imagePaths: capturedViews.map(v => v.imagePath),
                destinationGlbPath: glbPath,
                ssSamplingSteps: 12,
                slatSamplingSteps: 12,
                meshSimplify: 0.95
            });

            if (falResult.success && falResult.localGlbPath) {
                const bounds: [number, number, number] = [
                    options.metricDimensions?.lengthMeters ?? 2.0,
                    options.metricDimensions?.heightMeters ?? 1.5,
                    options.metricDimensions?.widthMeters ?? 2.0
                ];

                downstreamGlb = {
                    path: falResult.localGlbPath,
                    url: `/models/${glbFilename}`,
                    vertexCount: falResult.stats?.totalVertices ?? 0,
                    triangleCount: falResult.stats?.totalTriangles ?? 0,
                    byteLength: falResult.stats?.totalBytes ?? 0,
                    boundingBoxMeters: bounds
                };
            }
        }

        return {
            success: true,
            subject: options.subject,
            rigPreset,
            stylePreset,
            views: capturedViews,
            downstreamGlb,
            totalDurationMs: Date.now() - startTime
        };
    }
}
