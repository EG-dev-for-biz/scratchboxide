/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { buildBeautifyPrompt } from '../../../browser/generative-canvas/services/location-beautify-service';
import { HeadlessVideoEditorService } from '../../video/HeadlessVideoEditorService';
import { HeadlessVideoCompositorService } from '../../video/HeadlessVideoCompositorService';
import type { VideoTimelineData } from '../../../browser/generative-canvas/services/video/videoTypes';
import type { ToolDeclaration, ToolHandler } from './types';

function asString(val: unknown): string {
    return typeof val === 'string' ? val : '';
}

function asNumber(val: unknown): number | undefined {
    if (typeof val === 'number' && !Number.isNaN(val)) return val;
    if (typeof val === 'string' && val.trim() !== '') {
        const parsed = parseFloat(val);
        return !Number.isNaN(parsed) ? parsed : undefined;
    }
    return undefined;
}

function asBoolean(val: unknown): boolean {
    if (typeof val === 'boolean') return val;
    if (typeof val === 'string') return val.toLowerCase() === 'true';
    return false;
}

const editorService = new HeadlessVideoEditorService();
const compositorService = new HeadlessVideoCompositorService();

// ============================================================================
// 1. AI Beautify Tools
// ============================================================================

export const AI_BEAUTIFY_TOOL_DECLARATIONS: ToolDeclaration[] = [
    {
        name: 'build_beautify_prompt',
        description: 'Construct the exact AI Beautify instruction prompt to transform a photorealistic 3D tiles rendering into a photorealistic photograph with non-negotiable 3D camera framing rules, matching canvas aspect ratio, and authentic physical materials.',
        parameters: {
            type: 'OBJECT',
            properties: {
                locationName: {
                    type: 'STRING',
                    description: 'Name of the geographic location or architectural landmark (e.g. "Independence Hall, Philadelphia", "Midtown Manhattan Empire State Building")'
                },
                coords: {
                    type: 'STRING',
                    description: 'Camera geographic coordinates formatted as "latitude, longitude" (e.g. "39.948900, -75.150000")'
                },
                heading: {
                    type: 'NUMBER',
                    description: 'Camera heading azimuth in degrees (0 = North, 90 = East, 180 = South, 270 = West)'
                },
                earthUrl: {
                    type: 'STRING',
                    description: 'Optional Google Earth web vantage reference link'
                },
                aspectRatio: {
                    type: 'STRING',
                    description: 'Canvas aspect ratio (e.g. "16:9", "9:16", "1:1", "4:3")'
                },
                moodPromptContext: {
                    type: 'STRING',
                    description: 'Optional atmospheric lighting and environmental mood context'
                },
                distance: {
                    type: 'NUMBER',
                    description: 'Optional approximate subject distance in meters from camera for depth-of-field and aerial perspective'
                },
                styleSuffix: {
                    type: 'STRING',
                    description: 'Optional caller-supplied artistic style and related generation modifiers'
                }
            },
            required: ['locationName']
        }
    }
];

export const aiBeautifyHandlers: Record<string, ToolHandler> = {
    build_beautify_prompt: (args, _ctx) => {
        const locationName = asString(args.locationName);
        if (!locationName) throw new Error('build_beautify_prompt: "locationName" argument is required.');

        const coords = asString(args.coords) || undefined;
        const heading = asNumber(args.heading);
        const earthUrl = asString(args.earthUrl) || undefined;
        const aspectRatio = asString(args.aspectRatio) || '16:9';
        const moodPromptContext = asString(args.moodPromptContext) || undefined;
        const distance = asNumber(args.distance);
        const styleSuffix = asString(args.styleSuffix) || undefined;

        const prompt = buildBeautifyPrompt({
            locationName,
            coords,
            heading,
            earthUrl,
            aspectRatio,
            moodPromptContext,
            distance,
            styleSuffix
        });

        return {
            resultPayload: {
                success: true,
                prompt,
                locationName,
                coords: coords || '0.000000, 0.000000',
                heading: heading !== undefined ? Math.round(heading) : 0,
                aspectRatio
            },
            summaryResult: `Constructed AI Beautify prompt for ${locationName} with non-negotiable 3D framing rules.`
        };
    }
};

// ============================================================================
// 2. Headless FFmpeg Editor Tools
// ============================================================================

export const FFMPEG_TOOL_DECLARATIONS: ToolDeclaration[] = [
    {
        name: 'vfx_ffmpeg_quick_edit',
        description: 'Perform atomic video editing on a media file: trimming, scaling, cropping, retiming, Planckian Kelvin white balance / filter baking, audio muting/remuxing, and transcoding with guaranteed web/QuickTime playback compatibility.',
        parameters: {
            type: 'OBJECT',
            properties: {
                inputPath: {
                    type: 'STRING',
                    description: 'Path to source input video or media file'
                },
                outputPath: {
                    type: 'STRING',
                    description: 'Path for the output video file (.mp4, .webm, .gif, or .mov)'
                },
                startSec: {
                    type: 'NUMBER',
                    description: 'Optional trim start timestamp in seconds'
                },
                durationSec: {
                    type: 'NUMBER',
                    description: 'Optional trim duration in seconds'
                },
                endSec: {
                    type: 'NUMBER',
                    description: 'Optional trim end timestamp in seconds'
                },
                scaleWidth: {
                    type: 'NUMBER',
                    description: 'Optional target width (even pixel clamping enforced)'
                },
                scaleHeight: {
                    type: 'NUMBER',
                    description: 'Optional target height (even pixel clamping enforced)'
                },
                scaleFit: {
                    type: 'STRING',
                    description: 'Scaling mode: "contain" (with padding), "cover", or "stretch"'
                },
                cropAspectRatio: {
                    type: 'STRING',
                    description: 'Target aspect ratio crop: "16:9", "9:16", "1:1", or "4:3"'
                },
                cropBox: {
                    type: 'OBJECT',
                    description: 'Explicit bounding box for cropping { x, y, width, height }'
                },
                fps: {
                    type: 'NUMBER',
                    description: 'Conform frame rate (e.g. 24, 30, 60)'
                },
                speedMultiplier: {
                    type: 'NUMBER',
                    description: 'Playback speed multiplier (e.g. 0.5 for half speed, 2.0 for 2x speedup)'
                },
                colorTemperatureKelvin: {
                    type: 'NUMBER',
                    description: 'Planckian Kelvin color temperature adjustment (1,000K to 40,000K; standard daylight is 6500K)'
                },
                brightness: {
                    type: 'NUMBER',
                    description: 'Brightness offset (-1.0 to 1.0, 0 is neutral)'
                },
                contrast: {
                    type: 'NUMBER',
                    description: 'Contrast multiplier (0.0 to 2.0, 1.0 is neutral)'
                },
                saturation: {
                    type: 'NUMBER',
                    description: 'Saturation multiplier (0.0 to 2.0, 1.0 is neutral)'
                },
                grainIntensity: {
                    type: 'NUMBER',
                    description: 'Temporal film grain noise intensity (0 to 100)'
                },
                vignetteAngle: {
                    type: 'NUMBER',
                    description: 'Vignette lens shading angle (0 to 1.57 radians)'
                },
                muteAudio: {
                    type: 'BOOLEAN',
                    description: 'Strip all audio tracks from output'
                },
                remuxAudioPath: {
                    type: 'STRING',
                    description: 'Path to audio/video file to remux original audio from (e.g. plate audio onto AI video)'
                },
                format: {
                    type: 'STRING',
                    description: 'Output format: "mp4" (default), "webm", "gif", or "mov"'
                },
                crf: {
                    type: 'NUMBER',
                    description: 'Constant Rate Factor quality (18-28, default 20)'
                },
                dryRun: {
                    type: 'BOOLEAN',
                    description: 'If true, validates parameters and returns FFmpeg command without executing'
                }
            },
            required: ['inputPath', 'outputPath']
        }
    },
    {
        name: 'vfx_ffmpeg_extract_frames',
        description: 'Extract high-resolution still image keyframes (PNG/JPG) using fast keyframe seek (-ss before -i). Essential for Visual Critic inspection and AI Beautify start frames.',
        parameters: {
            type: 'OBJECT',
            properties: {
                inputPath: {
                    type: 'STRING',
                    description: 'Path to source video file'
                },
                outputPathPattern: {
                    type: 'STRING',
                    description: 'Output image path or pattern containing %d (e.g. "/path/to/frame_%03d.png")'
                },
                outputDir: {
                    type: 'STRING',
                    description: 'Output directory where extracted frames should be written'
                },
                timestampsSec: {
                    type: 'ARRAY',
                    description: 'Array of timestamps in seconds to extract (e.g. [0, 1.5, 3.0])'
                },
                heroFrameOnly: {
                    type: 'BOOLEAN',
                    description: 'Extract only the hero start frame at timestamp 0'
                },
                format: {
                    type: 'STRING',
                    description: 'Output image format: "png" (lossless default) or "jpg"'
                },
                dryRun: {
                    type: 'BOOLEAN',
                    description: 'If true, returns FFmpeg extraction commands without writing files'
                }
            },
            required: ['inputPath']
        }
    },
    {
        name: 'vfx_ffmpeg_split_screen',
        description: 'Compile a synchronized 50/50 side-by-side or vertical split comparison video (e.g. Blockout vs Neural Synthesis). Enforces matched heights, frame rates, and safe audio mapping.',
        parameters: {
            type: 'OBJECT',
            properties: {
                leftVideoPath: {
                    type: 'STRING',
                    description: 'Path to left / primary video (e.g. 3D blockout)'
                },
                rightVideoPath: {
                    type: 'STRING',
                    description: 'Path to right / secondary video (e.g. Omni neural synthesis)'
                },
                outputPath: {
                    type: 'STRING',
                    description: 'Path for output comparison video (.mp4 or .webm)'
                },
                layout: {
                    type: 'STRING',
                    description: 'Layout split: "horizontal" (side-by-side 50/50, default) or "vertical" (stacked top/bottom)'
                },
                format: {
                    type: 'STRING',
                    description: 'Output container format: "mp4" or "webm"'
                },
                crf: {
                    type: 'NUMBER',
                    description: 'Constant Rate Factor quality (default 19)'
                },
                dryRun: {
                    type: 'BOOLEAN',
                    description: 'If true, returns FFmpeg filtergraph command without running'
                }
            },
            required: ['leftVideoPath', 'rightVideoPath', 'outputPath']
        }
    }
];

export const ffmpegHandlers: Record<string, ToolHandler> = {
    vfx_ffmpeg_quick_edit: async (args, _ctx) => {
        const inputPath = asString(args.inputPath);
        const outputPath = asString(args.outputPath);
        if (!inputPath || !outputPath) {
            throw new Error('vfx_ffmpeg_quick_edit: "inputPath" and "outputPath" arguments are required.');
        }

        const startSec = asNumber(args.startSec);
        const durationSec = asNumber(args.durationSec);
        const endSec = asNumber(args.endSec);
        const scaleWidth = asNumber(args.scaleWidth);
        const scaleHeight = asNumber(args.scaleHeight);
        const scaleFit = (args.scaleFit as 'contain' | 'cover' | 'stretch') || undefined;
        const cropAspectRatio = (args.cropAspectRatio as '16:9' | '9:16' | '1:1' | '4:3') || undefined;
        const cropBox = args.cropBox && typeof args.cropBox === 'object' ? (args.cropBox as { x: number; y: number; width: number; height: number }) : undefined;
        const fps = asNumber(args.fps);
        const speedMultiplier = asNumber(args.speedMultiplier);

        const colorTemperatureKelvin = asNumber(args.colorTemperatureKelvin);
        const brightness = asNumber(args.brightness);
        const contrast = asNumber(args.contrast);
        const saturation = asNumber(args.saturation);
        const grainIntensity = asNumber(args.grainIntensity);
        const vignetteAngle = asNumber(args.vignetteAngle);

        const filterBake = (colorTemperatureKelvin || brightness !== undefined || contrast !== undefined || saturation !== undefined || grainIntensity || vignetteAngle) ? {
            colorTemperatureKelvin,
            brightness,
            contrast,
            saturation,
            grainIntensity,
            vignetteAngle
        } : undefined;

        const muteAudio = asBoolean(args.muteAudio);
        const remuxAudioPath = asString(args.remuxAudioPath) || undefined;
        const format = (args.format as 'mp4' | 'webm' | 'gif' | 'mov') || 'mp4';
        const crf = asNumber(args.crf);
        const dryRun = asBoolean(args.dryRun);

        const result = await editorService.quickEdit({
            inputPath,
            outputPath,
            trim: (startSec !== undefined || durationSec !== undefined || endSec !== undefined) ? {
                startSec,
                durationSec,
                endSec
            } : undefined,
            scale: (scaleWidth || scaleHeight) ? {
                width: scaleWidth,
                height: scaleHeight,
                fit: scaleFit
            } : undefined,
            crop: (cropAspectRatio || cropBox) ? {
                aspectRatio: cropAspectRatio,
                box: cropBox
            } : undefined,
            fps,
            speedMultiplier,
            filterBake,
            muteAudio,
            remuxAudioPath,
            format,
            crf,
            dryRun
        });

        return {
            resultPayload: result,
            summaryResult: dryRun
                ? `Planned FFmpeg edit for ${outputPath} (dry run).`
                : `Successfully edited ${outputPath} (${result.outputSizeBytes || 0} bytes).`
        };
    },

    vfx_ffmpeg_extract_frames: async (args, _ctx) => {
        const inputPath = asString(args.inputPath);
        if (!inputPath) throw new Error('vfx_ffmpeg_extract_frames: "inputPath" is required.');

        const outputPathPattern = asString(args.outputPathPattern) || undefined;
        const outputDir = asString(args.outputDir) || undefined;
        const heroFrameOnly = asBoolean(args.heroFrameOnly);
        const format = (args.format as 'png' | 'jpg') || 'png';
        const dryRun = asBoolean(args.dryRun);

        let timestampsSec: number[] | undefined;
        if (Array.isArray(args.timestampsSec)) {
            timestampsSec = args.timestampsSec.map(t => asNumber(t) || 0);
        }

        const result = await editorService.extractKeyframes({
            inputPath,
            outputPathPattern,
            outputDir,
            heroFrameOnly,
            timestampsSec,
            format,
            dryRun
        });

        return {
            resultPayload: result,
            summaryResult: `Extracted ${result.outputPaths?.length || 0} keyframe(s) from ${inputPath}.`
        };
    },

    vfx_ffmpeg_split_screen: async (args, _ctx) => {
        const leftVideoPath = asString(args.leftVideoPath);
        const rightVideoPath = asString(args.rightVideoPath);
        const outputPath = asString(args.outputPath);
        if (!leftVideoPath || !rightVideoPath || !outputPath) {
            throw new Error('vfx_ffmpeg_split_screen: "leftVideoPath", "rightVideoPath", and "outputPath" are required.');
        }

        const layout = (args.layout as 'horizontal' | 'vertical') || 'horizontal';
        const format = (args.format as 'mp4' | 'webm') || 'mp4';
        const crf = asNumber(args.crf);
        const dryRun = asBoolean(args.dryRun);

        const result = await editorService.createSplitScreen({
            leftVideoPath,
            rightVideoPath,
            outputPath,
            layout,
            format,
            crf,
            dryRun
        });

        return {
            resultPayload: result,
            summaryResult: dryRun
                ? `Prepared 50/50 split comparison for ${outputPath} (dry run).`
                : `Compiled 50/50 comparison video at ${outputPath} (${result.outputSizeBytes || 0} bytes).`
        };
    }
};

// ============================================================================
// 3. Headless Compositor Tools
// ============================================================================

export const COMPOSITOR_TOOL_DECLARATIONS: ToolDeclaration[] = [
    {
        name: 'vfx_composite_patch',
        description: 'Composite a localized generative inpaint patch or VFX element onto a background video plate with Lanczos downscaling, analytical soft-feathered alpha edge masking (geq), and matching temporal film grain.',
        parameters: {
            type: 'OBJECT',
            properties: {
                backgroundVideo: {
                    type: 'STRING',
                    description: 'Path to background master video plate'
                },
                patchMedia: {
                    type: 'STRING',
                    description: 'Path to generative inpaint patch video or image'
                },
                outputPath: {
                    type: 'STRING',
                    description: 'Path for output composited video'
                },
                bbox: {
                    type: 'OBJECT',
                    description: 'Target bounding box on canvas { x: number, y: number, width: number, height: number }'
                },
                featherPixels: {
                    type: 'NUMBER',
                    description: 'Alpha edge feather radius in pixels (default 12)'
                },
                grainIntensity: {
                    type: 'NUMBER',
                    description: 'Film grain noise matching intensity (default 14)'
                },
                duration: {
                    type: 'NUMBER',
                    description: 'Optional total composite duration in seconds'
                },
                prompt: {
                    type: 'STRING',
                    description: 'Optional semantic context for the generative patch'
                },
                crf: {
                    type: 'NUMBER',
                    description: 'Output CRF quality factor (default 18)'
                },
                dryRun: {
                    type: 'BOOLEAN',
                    description: 'If true, returns FFmpeg filtergraph command without running'
                }
            },
            required: ['backgroundVideo', 'patchMedia', 'outputPath', 'bbox']
        }
    },
    {
        name: 'vfx_composite_timeline',
        description: 'Execute complete multi-track video timeline compositing (V1 background to overlay tracks, chroma keying, despill suppression, 2D affine transforms, and audio mixing).',
        parameters: {
            type: 'OBJECT',
            properties: {
                timeline: {
                    type: 'OBJECT',
                    description: 'VideoTimelineData document containing tracks, elements, and layers'
                },
                outputPath: {
                    type: 'STRING',
                    description: 'Output path for composited media file'
                },
                width: {
                    type: 'NUMBER',
                    description: 'Output width (default 1920)'
                },
                height: {
                    type: 'NUMBER',
                    description: 'Output height (default 1080)'
                },
                fps: {
                    type: 'NUMBER',
                    description: 'Render frame rate (default 30)'
                },
                crf: {
                    type: 'NUMBER',
                    description: 'Output CRF factor (default 20)'
                },
                preset: {
                    type: 'STRING',
                    description: 'Encoder speed preset: "ultrafast", "fast", "medium"'
                },
                format: {
                    type: 'STRING',
                    description: 'Output format: "mp4", "webm", "gif", or "mov"'
                },
                dryRun: {
                    type: 'BOOLEAN',
                    description: 'If true, returns command without executing'
                }
            },
            required: ['timeline', 'outputPath']
        }
    }
];

export const compositorHandlers: Record<string, ToolHandler> = {
    vfx_composite_patch: async (args, _ctx) => {
        const backgroundVideo = asString(args.backgroundVideo);
        const patchMedia = asString(args.patchMedia);
        const outputPath = asString(args.outputPath);
        if (!backgroundVideo || !patchMedia || !outputPath) {
            throw new Error('vfx_composite_patch: "backgroundVideo", "patchMedia", and "outputPath" are required.');
        }

        const bbox = args.bbox as { x: number; y: number; width: number; height: number };
        if (!bbox || typeof bbox.width !== 'number' || typeof bbox.height !== 'number') {
            throw new Error('vfx_composite_patch: "bbox" with x, y, width, and height is required.');
        }

        const featherPixels = asNumber(args.featherPixels) || 12;
        const grainIntensity = asNumber(args.grainIntensity) || 14;
        const prompt = asString(args.prompt) || 'Generative inpaint patch blending';
        const crf = asNumber(args.crf) || 18;
        const dryRun = asBoolean(args.dryRun);

        let durationSec = asNumber(args.duration);
        if (!durationSec) {
            try {
                const probe = await editorService.probeMedia(backgroundVideo);
                durationSec = probe.durationSec || 10;
            } catch {
                durationSec = 10;
            }
        }

        const timeline: VideoTimelineData = {
            title: `Generative Patch Composite ${Date.now()}`,
            fps: 30,
            duration: durationSec,
            currentTime: 0,
            zoom: 50,
            aspectRatio: '16:9',
            mediaAssets: [],
            tracks: [
                {
                    id: 'track_bg',
                    name: 'Background Plate',
                    type: 'video',
                    visible: true,
                    locked: false,
                    muted: false,
                    elements: [
                        {
                            id: 'el_bg',
                            name: 'Background Plate',
                            type: 'video',
                            startTime: 0,
                            duration: durationSec,
                            trimStart: 0,
                            trimEnd: durationSec,
                            url: backgroundVideo,
                            generativePatch: {
                                enabled: true,
                                mode: (asString(args.mode) as any) || 'insert',
                                targetBox: bbox,
                                prompt,
                                aspectRatio: '16:9',
                                resolutionTier: '1080p',
                                featherRadius: featherPixels,
                                matchGrain: true,
                                grainIntensity
                            }
                        }
                    ]
                }
            ]
        };

        const result = await compositorService.execute({
            timeline,
            outputPath,
            customInputs: {
                el_bg: backgroundVideo,
                el_bg_patch: patchMedia
            },
            crf,
            format: 'mp4',
            dryRun
        });

        return {
            resultPayload: result,
            summaryResult: dryRun
                ? `Planned localized inpaint patch composite for ${outputPath} (dry run).`
                : `Successfully composited generative patch into ${outputPath}.`
        };
    },

    vfx_composite_timeline: async (args, _ctx) => {
        const timeline = args.timeline as VideoTimelineData;
        const outputPath = asString(args.outputPath);
        if (!timeline || !outputPath) {
            throw new Error('vfx_composite_timeline: "timeline" and "outputPath" are required.');
        }

        const width = asNumber(args.width) || 1920;
        const height = asNumber(args.height) || 1080;
        const crf = asNumber(args.crf) || 20;
        const preset = asString(args.preset) || 'fast';
        const format = (args.format as 'mp4' | 'webm' | 'gif' | 'mov') || 'mp4';
        const dryRun = asBoolean(args.dryRun);

        const result = await compositorService.execute({
            timeline,
            resolution: { width, height },
            outputPath,
            crf,
            preset,
            format,
            dryRun
        });

        return {
            resultPayload: result,
            summaryResult: dryRun
                ? `Planned multi-track timeline composite for ${outputPath} (dry run).`
                : `Successfully rendered timeline composite to ${outputPath}.`
        };
    }
};

// ============================================================================
// 4. Aggregated Tool Declarations & Handlers
// ============================================================================

export const VFX_VIDEO_TOOL_DECLARATIONS: ToolDeclaration[] = [
    ...AI_BEAUTIFY_TOOL_DECLARATIONS,
    ...FFMPEG_TOOL_DECLARATIONS,
    ...COMPOSITOR_TOOL_DECLARATIONS
];

export const vfxVideoHandlers: Record<string, ToolHandler> = {
    ...aiBeautifyHandlers,
    ...ffmpegHandlers,
    ...compositorHandlers
};
