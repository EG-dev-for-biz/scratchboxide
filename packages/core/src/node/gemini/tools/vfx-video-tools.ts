/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { buildBeautifyPrompt } from '../../../browser/generative-canvas/services/location-beautify-service';
import {
    buildNeutralPerformerPrompt,
    buildFrameMotivatedPerformerVideoPrompt,
    type MultiViewCameraPosition
} from '../../../browser/generative-canvas/services/video/omniVideoPromptService';
import { HeadlessVideoEditorService } from '../../video/HeadlessVideoEditorService';
import { HeadlessVideoCompositorService } from '../../video/HeadlessVideoCompositorService';
import { MediaPipeVideoDirectorService } from '../../video/MediaPipeVideoDirectorService';
import { buildContactSheet, normalizePlates } from '../../video/ConditioningPlateService';
import { checkVideo, VideoQAError } from '../../video/GenerativeVideoQAService';
import { VfxSubjectSegmenterService } from '../../video/VfxSubjectSegmenterService';
import { ObjectSegmenterService } from '../../video/ObjectSegmenterService';
import type { NormBox, NormPoint } from '../../video/segment-target-locator';
import { GeneratorFailedError, InvalidInputError, MissingInputError } from '../../../common/errors/pipeline-errors';
import type { VideoTimelineData } from '../../../browser/generative-canvas/services/video/videoTypes';
import type { ToolDeclaration, ToolHandler, ToolParameterSchema } from './types';

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

/**
 * The MediaPipe director tools read the real video and have no dry run (a plan made without the video was a canned
 * pose track, crop or score). A call that still asks for one is refused before anything runs, with nothing analysed.
 */
function refuseDryRun(tool: string, args: Record<string, unknown>) {
    if (!asBoolean(args.dryRun)) return undefined;
    const error = `${tool} has no dry run: it only reports what it measured in the video itself. Dry run, nothing analysed; call it without dryRun to analyse the video.`;
    return { resultPayload: { success: false, dryRun: true, error }, status: 'failed' as const, summaryResult: error };
}

const editorService = new HeadlessVideoEditorService();
const compositorService = new HeadlessVideoCompositorService();
const directorService = new MediaPipeVideoDirectorService(editorService);

// ============================================================================
// 1. AI Beautify Tools
// ============================================================================

export const AI_BEAUTIFY_TOOL_DECLARATIONS: ToolDeclaration[] = [
    {
        name: 'build_beautify_prompt',
        description: 'DEPRECATED (hidden since 2026-10-20; remove after one release): the AI Beautify template is applied automatically by the tools that generate from a render (survey_beautify_station, survey_beautify_to_splats, survey_beautify_to_texture, spatial_ai_render_scene), so there is nothing to build by hand. Still fills the exact AI Beautify prompt for a 3D tiles rendering (locationName, coords, heading, aspectRatio, distance, styleSuffix) when a saved script calls it.',
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
                    description: 'Optional atmospheric lighting and environmental mood context. Leave empty unless explicitly requested by the user.'
                },
                distance: {
                    type: 'NUMBER',
                    description: 'Optional approximate subject distance in meters from camera for depth-of-field and aerial perspective'
                },
                styleSuffix: {
                    type: 'STRING',
                    description: 'Optional caller-supplied artistic style and related generation modifiers. In accordance with style neutrality, extra prompt injections should ONLY happen here, and MUST be left empty unless the user explicitly prompts a style.'
                }
            },
            required: ['locationName']
        }
    },
    {
        name: 'build_neutral_performer_prompt',
        description: 'DEPRECATED (hidden since 2026-10-20; remove after one release): no in-app tool generates performer images or video, so this template has no generation step to run inside; the function buildNeutralPerformerPrompt (omniVideoPromptService.ts) is the template. Still fills the head-to-toe, flat shadowless #808080 studio, symmetrical A-frame pose prompt (subject, wardrobe, aspectRatio, kind, isAFramePose) when a saved script calls it.',
        parameters: {
            type: 'OBJECT',
            properties: {
                subject: {
                    type: 'STRING',
                    description: 'Description of the performer or subject (e.g. "A female vocalist", "A humanoid dancer")'
                },
                wardrobe: {
                    type: 'STRING',
                    description: 'Detailed clothing and footwear description (e.g. "oversized white linen tunic, wide-leg palazzo trousers, chunky white sneakers")'
                },
                aspectRatio: {
                    type: 'STRING',
                    description: 'Canvas aspect ratio (default "9:16" for uncropped head-to-toe vertical portrait, or "1:1", "16:9")'
                },
                kind: {
                    type: 'STRING',
                    description: 'Media target kind: "image" (default, still portrait) or "video" (motion calibration plate)'
                },
                isAFramePose: {
                    type: 'BOOLEAN',
                    description: 'Whether to enforce the canonical symmetrical A-frame pose (default true)'
                },
                videoMotion: {
                    type: 'STRING',
                    description: 'Optional subtle motion instructions if kind is "video" (defaults to stationary resting calibration with subtle breathing)'
                },
                extraNegativePrompt: {
                    type: 'STRING',
                    description: 'Optional additional negative prompt clauses to append to the standard negative prompt'
                }
            }
        }
    },
    {
        name: 'build_frame_motivated_performer_prompt',
        description: 'DEPRECATED (hidden since 2026-10-20; remove after one release): no in-app tool generates performer video, so this template has no generation step to run inside; the function buildFrameMotivatedPerformerVideoPrompt (omniVideoPromptService.ts) is the template. Still fills the <FIRST_FRAME>/<LAST_FRAME> closed-loop A-pose video prompt (referenceFrameRef, subject, wardrobe, cameraPosition, videoMotion, videoModelBackbone) when a saved script calls it.',
        parameters: {
            type: 'OBJECT',
            properties: {
                referenceFrameRef: {
                    type: 'STRING',
                    description: 'Reference hero frame media tag or identifier (e.g. "<IMAGE_REF_0>", "performer_frame_00.png")'
                },
                subject: {
                    type: 'STRING',
                    description: 'Subject description (e.g. "A female vocalist", "A humanoid dancer")'
                },
                wardrobe: {
                    type: 'STRING',
                    description: 'Clothing and footwear description (e.g. "oversized white linen tunic, wide-leg trousers, white sneakers")'
                },
                cameraPosition: {
                    type: 'STRING',
                    description: 'Capture camera position: "front" (0°), "left_45" (45°), "right_45" (-45°), "rear_180" (180°), or "orbit_360"'
                },
                heroPoseType: {
                    type: 'STRING',
                    description: 'Hero frame pose: "casual" (natural organic pose from video, never forced into A-pose), "a-pose" (symmetrical A-frame), or "as-input"'
                },
                heroPoseDescription: {
                    type: 'STRING',
                    description: 'Optional description of hero frame pose (e.g. "arms resting along flanks, relaxed natural standing posture")'
                },
                isAFramePose: {
                    type: 'BOOLEAN',
                    description: 'Set to false if the reference frame is in a casual stance and should NOT be forced into an A-pose'
                },
                cameraRigPreset: {
                    type: 'STRING',
                    description: 'Multi-view camera rig preset: "6-view-orbit", "24-view-dense", "48-view-multipitch", or "24-view-frontal-arc"'
                },
                actionPrompt: {
                    type: 'STRING',
                    description: 'Subtle motion action description originating smoothly from the initial pose (e.g. "maintains natural casual posture while subtly breathing")'
                },
                durationSeconds: {
                    type: 'NUMBER',
                    description: 'Duration in seconds (default 4.0)'
                },
                videoDiffusionModel: {
                    type: 'STRING',
                    description: 'Target video diffusion model architecture: "veo-2.0-generate-001" (default), "Wan2.2-TI2V-5B", or "Omni1.1"'
                },
                extraNegativePrompt: {
                    type: 'STRING',
                    description: 'Additional negative prompt clauses'
                }
            },
            required: ['referenceFrameRef']
        }
    }
];

/**
 * Prompt-template tools: registered but not offered (hidden since 2026-10-20; remove after one release). The
 * generation paths apply their templates themselves (survey beautify and the mesh render restyle read
 * buildBeautifyPrompt / buildClayRenderBeautifyPrompt), so the model no longer has to call them first.
 */
export const PROMPT_TEMPLATE_TOOL_NAMES: readonly string[] = AI_BEAUTIFY_TOOL_DECLARATIONS.map(d => d.name);

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
    },

    build_neutral_performer_prompt: (args, _ctx) => {
        const subject = asString(args.subject) || undefined;
        const wardrobe = asString(args.wardrobe) || undefined;
        const aspectRatio = asString(args.aspectRatio) || '9:16';
        const kind = (asString(args.kind).toLowerCase() === 'video') ? 'video' : 'image';
        const isAFramePose = args.isAFramePose !== undefined ? asBoolean(args.isAFramePose) : true;
        const videoMotion = asString(args.videoMotion) || undefined;
        const extraNegativePrompt = asString(args.extraNegativePrompt) || undefined;

        const result = buildNeutralPerformerPrompt({
            subject,
            wardrobe,
            aspectRatio,
            kind,
            isAFramePose,
            videoMotion,
            extraNegativePrompt
        });

        return {
            resultPayload: {
                success: true,
                prompt: result.prompt,
                negativePrompt: result.negativePrompt,
                aspectRatio: result.aspectRatio,
                kind: result.kind,
                isAFramePose: result.isAFramePose
            },
            summaryResult: `Constructed neutral ${result.kind} prompt from head to toe in ${result.isAFramePose ? 'A-frame' : 'neutral'} pose with zero context and flat shadowless lighting.`
        };
    },

    build_frame_motivated_performer_prompt: (args, _ctx) => {
        const referenceFrameRef = asString(args.referenceFrameRef) || asString(args.referenceFramePath);
        if (!referenceFrameRef) throw new Error('build_frame_motivated_performer_prompt: "referenceFrameRef" or "referenceFramePath" is required.');

        const subject = asString(args.subject) || asString(args.characterDescription) || undefined;
        const wardrobe = asString(args.wardrobe) || undefined;
        const cameraPosition = (asString(args.cameraPosition) || 'front') as MultiViewCameraPosition;
        const videoMotion = asString(args.actionPrompt) || asString(args.videoMotion) || undefined;
        const videoModelBackbone = asString(args.videoDiffusionModel) || asString(args.videoModelBackbone) || 'Wan2.2-TI2V-5B';
        const extraNegativePrompt = asString(args.extraNegativePrompt) || undefined;
        const heroPoseType = (asString(args.heroPoseType) as 'casual' | 'a-pose' | 'as-input') || undefined;
        const heroPoseDescription = asString(args.heroPoseDescription) || undefined;
        const isAFramePose = typeof args.isAFramePose === 'boolean' ? args.isAFramePose : undefined;
        const cameraRigPreset = (asString(args.cameraRigPreset) as any) || undefined;

        const result = buildFrameMotivatedPerformerVideoPrompt({
            referenceFrameRef,
            subject,
            wardrobe,
            cameraPosition,
            videoMotion,
            videoModelBackbone,
            extraNegativePrompt,
            heroPoseType,
            heroPoseDescription,
            isAFramePose,
            cameraRigPreset
        });

        return {
            resultPayload: {
                success: true,
                prompt: result.prompt,
                negativePrompt: result.negativePrompt,
                referenceFrameRef: result.referenceFrameRef,
                cameraPosition: result.cameraPosition,
                videoModelBackbone: result.videoModelBackbone,
                aspectRatio: result.aspectRatio,
                isAFramePose: result.isAFramePose,
                heroPoseType: result.heroPoseType,
                cameraRig: result.cameraRig,
                firstFrameSyntax: result.firstFrameSyntax
            },
            summaryResult: `Constructed frame-motivated video prompt conditioned on ${result.referenceFrameRef} (${result.cameraPosition} viewpoint, pose: ${result.heroPoseType}) for ${result.videoModelBackbone}.`
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
                    description: 'Array of timestamps in seconds to extract (e.g. [0, 1.5, 3.0])',
                    items: { type: 'NUMBER' }
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
    },
    {
        name: 'vfx_ffmpeg_storyboard_sheet',
        description: 'Compile a video into a single high-resolution contact sheet mosaic grid (tile filter) with burned-in timecodes for token-efficient multimodal Gemini Vision inspection.',
        parameters: {
            type: 'OBJECT',
            properties: {
                inputPath: {
                    type: 'STRING',
                    description: 'Path to source video file'
                },
                outputPath: {
                    type: 'STRING',
                    description: 'Output contact sheet image path (e.g. "/path/to/storyboard.png" or ".jpg")'
                },
                columns: {
                    type: 'NUMBER',
                    description: 'Number of columns in mosaic grid (default 3)'
                },
                rows: {
                    type: 'NUMBER',
                    description: 'Number of rows in mosaic grid (default 3)'
                },
                totalFrames: {
                    type: 'NUMBER',
                    description: 'Total frames to sample across the video duration (default columns * rows)'
                },
                durationSec: {
                    type: 'NUMBER',
                    description: 'Length of the input in seconds; only needed for a dry run of an input that is not on disk (otherwise measured with ffprobe)'
                },
                cellWidth: {
                    type: 'NUMBER',
                    description: 'Width of each individual cell in pixels (default 640)'
                },
                cellHeight: {
                    type: 'NUMBER',
                    description: 'Height of each individual cell in pixels (default 360)'
                },
                labelTimecode: {
                    type: 'BOOLEAN',
                    description: 'Whether to burn PTS timecode timestamps onto each cell (default true)'
                },
                dryRun: {
                    type: 'BOOLEAN',
                    description: 'If true, returns FFmpeg command without executing'
                }
            },
            required: ['inputPath', 'outputPath']
        }
    },
    {
        name: 'vfx_ffmpeg_lut_grade',
        description: 'Apply an industry-standard 3D .cube or .3dl color grading LUT (ACEScc, Kodak 2383, ARRI LogC) via lut3d filter with configurable intensity blending.',
        parameters: {
            type: 'OBJECT',
            properties: {
                inputPath: {
                    type: 'STRING',
                    description: 'Path to source video file'
                },
                lutPath: {
                    type: 'STRING',
                    description: 'Path to .cube or .3dl color grading LUT file'
                },
                outputPath: {
                    type: 'STRING',
                    description: 'Path for color graded output video'
                },
                intensity: {
                    type: 'NUMBER',
                    description: 'LUT blend intensity from 0.0 (bypass) to 1.0 (100% grade, default 1.0)'
                },
                interpolation: {
                    type: 'STRING',
                    description: 'LUT interpolation: "nearest", "trilinear", or "tetrahedral" (default "tetrahedral")'
                },
                crf: {
                    type: 'NUMBER',
                    description: 'Constant Rate Factor quality (default 18)'
                },
                dryRun: {
                    type: 'BOOLEAN',
                    description: 'If true, returns FFmpeg command without executing'
                }
            },
            required: ['inputPath', 'lutPath', 'outputPath']
        }
    },
    {
        name: 'pro_color_match_imagery',
        description: 'Color-matches a source image to a reference image. Solves per-channel 3-way primary wheels (Lift, Gamma, Gain) from the 5th/50th/95th percentile tones of each image (the images may differ in size), applies them with optional vectorscope skin-tone protection, can export a 3D LUT (.cube), and reports scopes (waveform, RGB parade, vectorscope incl. measured dominant hue) and the mean per-pixel CIEDE2000 to the reference before and after (the reference is resampled to the source size when they differ; the result states the basis and sample count).',
        parameters: {
            type: 'OBJECT',
            properties: {
                sourceImagePath: {
                    type: 'STRING',
                    description: 'Path or data URI of the source image to be graded'
                },
                referenceImagePath: {
                    type: 'STRING',
                    description: 'Path or data URI of the reference image containing target color mood and lighting'
                },
                outputPath: {
                    type: 'STRING',
                    description: 'Optional path to write the color-matched image'
                },
                outputLutPath: {
                    type: 'STRING',
                    description: 'Optional path to export an industry-standard 3D LUT (.cube) file'
                },
                generate3DLut: {
                    type: 'BOOLEAN',
                    description: 'Whether to synthesize a 3D LUT (.cube) (default true)'
                },
                lutSize: {
                    type: 'NUMBER',
                    description: '3D LUT grid size (17, 33, or 65, default 17)'
                },
                preserveSkinTones: {
                    type: 'BOOLEAN',
                    description: 'Whether to protect natural human skin tones along the vectorscope I-axis (default true)'
                }
            },
            required: ['sourceImagePath', 'referenceImagePath']
        }
    },
    {
        name: 'vfx_ffmpeg_chromakey',
        description: 'Execute green or blue screen chroma keying with despill color suppression and optional background plate compositing.',
        parameters: {
            type: 'OBJECT',
            properties: {
                inputPath: {
                    type: 'STRING',
                    description: 'Path to foreground video with green/blue screen'
                },
                outputPath: {
                    type: 'STRING',
                    description: 'Path for output composited video'
                },
                backgroundPath: {
                    type: 'STRING',
                    description: 'Optional path to background video plate or image'
                },
                keyColor: {
                    type: 'STRING',
                    description: 'Key color in hex ("0x00FF00") or named ("green", "blue") (default "0x00FF00")'
                },
                similarity: {
                    type: 'NUMBER',
                    description: 'Chroma tolerance similarity threshold (0.01 to 1.0, default 0.12)'
                },
                blend: {
                    type: 'NUMBER',
                    description: 'Edge softness blend (0.0 to 0.5, default 0.08)'
                },
                spillSuppression: {
                    type: 'BOOLEAN',
                    description: 'Apply color despill suppression (default true)'
                },
                crf: {
                    type: 'NUMBER',
                    description: 'Constant Rate Factor quality (default 18)'
                },
                dryRun: {
                    type: 'BOOLEAN',
                    description: 'If true, returns FFmpeg command without executing'
                }
            },
            required: ['inputPath', 'outputPath']
        }
    },
    {
        name: 'vfx_ffmpeg_controlnet_map',
        description: 'Extract zero-inference video conditioning maps (Sobel edge or height/luminance displacement) in a single fast FFmpeg pass for diffusion/ControlNet.',
        parameters: {
            type: 'OBJECT',
            properties: {
                inputPath: {
                    type: 'STRING',
                    description: 'Path to source video file'
                },
                outputPath: {
                    type: 'STRING',
                    description: 'Path for output conditioning map video'
                },
                mapType: {
                    type: 'STRING',
                    description: 'Map type: "edge" (Sobel edges) or "height" / "luminance_contrast" (depth/displacement)'
                },
                strength: {
                    type: 'NUMBER',
                    description: 'Edge scale or contrast multiplier (default 1.5)'
                },
                threshold: {
                    type: 'NUMBER',
                    description: 'Luminance floor threshold (0.0 to 1.0, default 0.1)'
                },
                invert: {
                    type: 'BOOLEAN',
                    description: 'Invert pixel polarity (default false)'
                },
                crf: {
                    type: 'NUMBER',
                    description: 'Constant Rate Factor quality (default 20)'
                },
                dryRun: {
                    type: 'BOOLEAN',
                    description: 'If true, returns FFmpeg command without executing'
                }
            },
            required: ['inputPath', 'outputPath', 'mapType']
        }
    },
    {
        name: 'vfx_ffmpeg_audio_normalize',
        description: 'Normalize audio loudness conforming to EBU R128 (-14 LUFS for web/streaming or -23 LUFS for broadcast) with lossless video stream copy.',
        parameters: {
            type: 'OBJECT',
            properties: {
                inputPath: {
                    type: 'STRING',
                    description: 'Path to source video file'
                },
                outputPath: {
                    type: 'STRING',
                    description: 'Path for loudness-normalized output video'
                },
                targetLufs: {
                    type: 'NUMBER',
                    description: 'Integrated loudness target in LUFS (-14 for web/streaming, -23 for broadcast, default -14)'
                },
                loudnessRange: {
                    type: 'NUMBER',
                    description: 'Loudness range target in LU (default 7)'
                },
                truePeak: {
                    type: 'NUMBER',
                    description: 'Maximum true peak in dBTP (default -1.0)'
                },
                dryRun: {
                    type: 'BOOLEAN',
                    description: 'If true, returns FFmpeg command without executing'
                }
            },
            required: ['inputPath', 'outputPath']
        }
    },
    {
        name: 'vfx_ffmpeg_seamless_loop',
        description: 'Synthesize an infinite seamless video loop using ping-pong reflection or temporal crossfade transitions.',
        parameters: {
            type: 'OBJECT',
            properties: {
                inputPath: {
                    type: 'STRING',
                    description: 'Path to source video file'
                },
                outputPath: {
                    type: 'STRING',
                    description: 'Path for output seamless looping video'
                },
                mode: {
                    type: 'STRING',
                    description: 'Looping mode: "ping_pong" (forward-reverse) or "crossfade" (tail-to-head blend, default "ping_pong")'
                },
                crossfadeDurationSec: {
                    type: 'NUMBER',
                    description: 'Crossfade blend duration in seconds for crossfade mode (default 1.0)'
                },
                crf: {
                    type: 'NUMBER',
                    description: 'Constant Rate Factor quality (default 19)'
                },
                dryRun: {
                    type: 'BOOLEAN',
                    description: 'If true, returns FFmpeg command without executing'
                }
            },
            required: ['inputPath', 'outputPath']
        }
    },
    {
        name: 'vfx_ffmpeg_encode_sequence',
        description: 'Ingest numbered image sequences (e.g. frame_%04d.png) rendered from 3D viewports or Gaussian splats into broadcast video with faststart.',
        parameters: {
            type: 'OBJECT',
            properties: {
                framePattern: {
                    type: 'STRING',
                    description: 'Image sequence path pattern (e.g. "/path/to/frame_%04d.png")'
                },
                outputPath: {
                    type: 'STRING',
                    description: 'Path for output encoded video file'
                },
                fps: {
                    type: 'NUMBER',
                    description: 'Frame rate in frames per second (default 24)'
                },
                audioSourcePath: {
                    type: 'STRING',
                    description: 'Optional path to audio track to mux into video'
                },
                codec: {
                    type: 'STRING',
                    description: 'Video codec: "h264" (default), "prores", or "vp9"'
                },
                crf: {
                    type: 'NUMBER',
                    description: 'Constant Rate Factor quality (default 18)'
                },
                preset: {
                    type: 'STRING',
                    description: 'Encoder preset (default "medium")'
                },
                faststart: {
                    type: 'BOOLEAN',
                    description: 'Enable progressive streaming faststart moov atom (default true)'
                },
                dryRun: {
                    type: 'BOOLEAN',
                    description: 'If true, returns FFmpeg command without executing'
                }
            },
            required: ['framePattern', 'outputPath']
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
    },

    vfx_ffmpeg_storyboard_sheet: async (args, _ctx) => {
        const inputPath = asString(args.inputPath);
        const outputPath = asString(args.outputPath);
        if (!inputPath || !outputPath) {
            throw new Error('vfx_ffmpeg_storyboard_sheet: "inputPath" and "outputPath" are required.');
        }

        const columns = asNumber(args.columns);
        const rows = asNumber(args.rows);
        const totalFrames = asNumber(args.totalFrames);
        const cellWidth = asNumber(args.cellWidth);
        const cellHeight = asNumber(args.cellHeight);
        const labelTimecode = args.labelTimecode !== undefined ? asBoolean(args.labelTimecode) : undefined;
        const dryRun = asBoolean(args.dryRun);

        const result = await editorService.generateStoryboardSheet({
            inputPath,
            outputPath,
            columns,
            rows,
            totalFrames,
            cellWidth,
            cellHeight,
            labelTimecode,
            durationSec: asNumber(args.durationSec),
            dryRun
        });

        return {
            resultPayload: result,
            summaryResult: dryRun
                ? `Planned storyboard contact sheet for ${outputPath} (dry run).`
                : `Generated storyboard contact sheet at ${outputPath} (${result.outputSizeBytes || 0} bytes).`
        };
    },

    vfx_ffmpeg_lut_grade: async (args, _ctx) => {
        const inputPath = asString(args.inputPath);
        const lutPath = asString(args.lutPath);
        const outputPath = asString(args.outputPath);
        if (!inputPath || !lutPath || !outputPath) {
            throw new Error('vfx_ffmpeg_lut_grade: "inputPath", "lutPath", and "outputPath" are required.');
        }

        const intensity = asNumber(args.intensity);
        const interpolation = (args.interpolation as 'nearest' | 'trilinear' | 'tetrahedral') || undefined;
        const crf = asNumber(args.crf);
        const dryRun = asBoolean(args.dryRun);

        const result = await editorService.applyLutGrade({
            inputPath,
            lutPath,
            outputPath,
            intensity,
            interpolation,
            crf,
            dryRun
        });

        return {
            resultPayload: result,
            summaryResult: dryRun
                ? `Planned 3D LUT grade for ${outputPath} (dry run).`
                : `Applied 3D LUT grade to ${outputPath} (${result.outputSizeBytes || 0} bytes).`
        };
    },

    pro_color_match_imagery: async (args, _ctx) => {
        const sourceImagePath = asString(args.sourceImagePath);
        const referenceImagePath = asString(args.referenceImagePath);
        if (!sourceImagePath || !referenceImagePath) {
            throw new Error('pro_color_match_imagery: "sourceImagePath" and "referenceImagePath" are required.');
        }

        const outputPath = asString(args.outputPath) || undefined;
        const outputLutPath = asString(args.outputLutPath) || undefined;
        const generate3DLut = args.generate3DLut !== undefined ? asBoolean(args.generate3DLut) : true;
        const lutSize = asNumber(args.lutSize) || 17;
        const preserveSkinTones = args.preserveSkinTones !== undefined ? asBoolean(args.preserveSkinTones) : true;

        const { ProColorGradeMatchingService } = await import('../../image/ProColorGradeMatchingService');
        const result = await ProColorGradeMatchingService.matchImages(
            sourceImagePath,
            referenceImagePath,
            {
                outputPath,
                outputLutPath,
                generate3DLut,
                lutSize,
                preserveSkinTones
            }
        );
        // The graded pixels go to outputPath; the raw RGBA buffer is not sent back to the model.
        const { gradedBuffer: _graded, ...payload } = result;

        return {
            resultPayload: payload as unknown as import('./types').ToolResultPayload,
            summaryResult: `Hollywood-grade color match complete in ${result.telemetry.executionTimeMs}ms. Perceptual Delta E reduced by ${result.telemetry.deltaEReductionPercent}% (initial: ${result.telemetry.initialDeltaE00} -> final: ${result.telemetry.finalDeltaE00}). Lift=[${result.wheels.lift.r.toFixed(3)}, ${result.wheels.lift.g.toFixed(3)}, ${result.wheels.lift.b.toFixed(3)}], Gain=[${result.wheels.gain.r.toFixed(3)}, ${result.wheels.gain.g.toFixed(3)}, ${result.wheels.gain.b.toFixed(3)}].${result.lutPath ? ` Generated 3D LUT: ${result.lutPath}` : ''}`
        };
    },

    vfx_ffmpeg_chromakey: async (args, _ctx) => {
        const inputPath = asString(args.inputPath);
        const outputPath = asString(args.outputPath);
        if (!inputPath || !outputPath) {
            throw new Error('vfx_ffmpeg_chromakey: "inputPath" and "outputPath" are required.');
        }

        const backgroundPath = asString(args.backgroundPath) || undefined;
        const keyColor = asString(args.keyColor) || undefined;
        const similarity = asNumber(args.similarity);
        const blend = asNumber(args.blend);
        const spillSuppression = args.spillSuppression !== undefined ? asBoolean(args.spillSuppression) : undefined;
        const crf = asNumber(args.crf);
        const dryRun = asBoolean(args.dryRun);

        const result = await editorService.applyChromaKey({
            inputPath,
            backgroundPath,
            outputPath,
            keyColor,
            similarity,
            blend,
            spillSuppression,
            crf,
            dryRun
        });

        return {
            resultPayload: result,
            summaryResult: dryRun
                ? `Planned chroma key composite for ${outputPath} (dry run).`
                : `Rendered chroma key composite to ${outputPath} (${result.outputSizeBytes || 0} bytes).`
        };
    },

    vfx_ffmpeg_controlnet_map: async (args, _ctx) => {
        const inputPath = asString(args.inputPath);
        const outputPath = asString(args.outputPath);
        const mapType = (asString(args.mapType) as 'edge' | 'height' | 'luminance_contrast') || 'edge';
        if (!inputPath || !outputPath) {
            throw new Error('vfx_ffmpeg_controlnet_map: "inputPath" and "outputPath" are required.');
        }

        const strength = asNumber(args.strength);
        const threshold = asNumber(args.threshold);
        const invert = asBoolean(args.invert);
        const crf = asNumber(args.crf);
        const dryRun = asBoolean(args.dryRun);

        const result = await editorService.generateConditioningMap({
            inputPath,
            outputPath,
            mapType,
            strength,
            threshold,
            invert,
            crf,
            dryRun
        });

        return {
            resultPayload: result,
            summaryResult: dryRun
                ? `Planned ${mapType} conditioning map for ${outputPath} (dry run).`
                : `Generated ${mapType} conditioning map at ${outputPath} (${result.outputSizeBytes || 0} bytes).`
        };
    },

    vfx_ffmpeg_audio_normalize: async (args, _ctx) => {
        const inputPath = asString(args.inputPath);
        const outputPath = asString(args.outputPath);
        if (!inputPath || !outputPath) {
            throw new Error('vfx_ffmpeg_audio_normalize: "inputPath" and "outputPath" are required.');
        }

        const targetLufs = asNumber(args.targetLufs);
        const loudnessRange = asNumber(args.loudnessRange);
        const truePeak = asNumber(args.truePeak);
        const dryRun = asBoolean(args.dryRun);

        const result = await editorService.normalizeAudioLoudness({
            inputPath,
            outputPath,
            targetLufs,
            loudnessRange,
            truePeak,
            dryRun
        });

        return {
            resultPayload: result,
            summaryResult: dryRun
                ? `Planned audio loudness normalization for ${outputPath} (dry run).`
                : `Normalized audio loudness for ${outputPath} (${result.outputSizeBytes || 0} bytes).`
        };
    },

    vfx_ffmpeg_seamless_loop: async (args, _ctx) => {
        const inputPath = asString(args.inputPath);
        const outputPath = asString(args.outputPath);
        if (!inputPath || !outputPath) {
            throw new Error('vfx_ffmpeg_seamless_loop: "inputPath" and "outputPath" are required.');
        }

        const mode = (asString(args.mode) as 'ping_pong' | 'crossfade') || 'ping_pong';
        const crossfadeDurationSec = asNumber(args.crossfadeDurationSec);
        const crf = asNumber(args.crf);
        const dryRun = asBoolean(args.dryRun);

        const result = await editorService.createSeamlessLoop({
            inputPath,
            outputPath,
            mode,
            crossfadeDurationSec,
            crf,
            dryRun
        });

        return {
            resultPayload: result,
            summaryResult: dryRun
                ? `Planned seamless ${mode} loop for ${outputPath} (dry run).`
                : `Generated seamless ${mode} loop at ${outputPath} (${result.outputSizeBytes || 0} bytes).`
        };
    },

    vfx_ffmpeg_encode_sequence: async (args, _ctx) => {
        const framePattern = asString(args.framePattern);
        const outputPath = asString(args.outputPath);
        if (!framePattern || !outputPath) {
            throw new Error('vfx_ffmpeg_encode_sequence: "framePattern" and "outputPath" are required.');
        }

        const fps = asNumber(args.fps);
        const audioSourcePath = asString(args.audioSourcePath) || undefined;
        const codec = (asString(args.codec) as 'h264' | 'prores' | 'vp9') || undefined;
        const crf = asNumber(args.crf);
        const preset = asString(args.preset) || undefined;
        const faststart = args.faststart !== undefined ? asBoolean(args.faststart) : undefined;
        const dryRun = asBoolean(args.dryRun);

        const result = await editorService.encodeFrameSequence({
            framePattern,
            outputPath,
            fps,
            audioSourcePath,
            codec,
            crf,
            preset,
            faststart,
            dryRun
        });

        return {
            resultPayload: result,
            summaryResult: dryRun
                ? `Planned image sequence encode for ${outputPath} (dry run).`
                : `Encoded image sequence to ${outputPath} (${result.outputSizeBytes || 0} bytes).`
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
                    description: 'Composite duration in seconds (default: the background plate\'s measured length; the call fails if it cannot be measured)'
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
        description: 'Execute complete multi-track video timeline compositing (V1 background to overlay tracks, chroma keying, despill suppression, 2D affine transforms, and audio mixing). Every clip on a visible video or overlay track needs a media file: its url must be a video or image file path or http(s) URL. The call fails, naming the clip, for a clip without one, including text, 3D and adjustment elements (not rendered headlessly) and clips whose media is a browser-only blob: or data: URL.',
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

        // The patch spans the background plate: its length is the caller's or the plate's measured one, never assumed.
        let durationSec = asNumber(args.duration);
        if (!durationSec) {
            let probe;
            try {
                probe = await editorService.probeMedia(backgroundVideo);
            } catch (err: any) {
                throw new GeneratorFailedError('ffprobe', `vfx_composite_patch could not measure the length of the background plate ${backgroundVideo} (pass "duration" to set it): ${err?.stderr || err?.message || String(err)}`);
            }
            if (!(Number.isFinite(probe.durationSec) && probe.durationSec > 0)) {
                throw new GeneratorFailedError('ffprobe', `vfx_composite_patch could not measure the length of the background plate ${backgroundVideo}: ffprobe reported ${probe.durationSec} s (pass "duration" to set it)`);
            }
            durationSec = probe.durationSec;
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

        if (!result.success) {
            return {
                resultPayload: result,
                status: 'failed',
                summaryResult: `The generative patch composite into ${outputPath} failed, so no video was written: ${result.error || 'FFmpeg reported no error'}`
            };
        }
        return {
            resultPayload: result,
            summaryResult: dryRun
                ? `Planned localized inpaint patch composite for ${outputPath} (dry run, nothing rendered).`
                : `Composited the generative patch into ${outputPath} (${durationSec} s).`
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

        if (!result.success) {
            return {
                resultPayload: result,
                status: 'failed',
                summaryResult: `The timeline composite to ${outputPath} failed, so no video was written: ${result.error || 'FFmpeg reported no error'}`
            };
        }
        return {
            resultPayload: result,
            summaryResult: dryRun
                ? `Planned multi-track timeline composite for ${outputPath} (dry run, nothing rendered).`
                : `Rendered timeline composite to ${outputPath}.`
        };
    }
};

// ============================================================================
// 4. MediaPipe Video Director Tools (FFmpeg + MediaPipe + Gemini Coordination)
// ============================================================================

export const DIRECTOR_TOOL_DECLARATIONS: ToolDeclaration[] = [
    {
        name: 'vfx_mediapipe_track_video_motion',
        description: 'Ingest video footage, track full-body 3D anatomical joint kinematics across frames using MediaPipe and FFmpeg, apply temporal smoothing, and export articulated motion tracks ready for the native C++20 SB-Human engine or Three.js.',
        parameters: {
            type: 'OBJECT',
            properties: {
                videoPath: {
                    type: 'STRING',
                    description: 'Absolute path to input video file'
                },
                fps: {
                    type: 'NUMBER',
                    description: 'Sampling frame rate (default 15)'
                },
                startTime: {
                    type: 'NUMBER',
                    description: 'Start offset in seconds (default 0)'
                },
                duration: {
                    type: 'NUMBER',
                    description: 'Duration to analyze in seconds (default: entire clip)'
                },
                smoothingWindow: {
                    type: 'NUMBER',
                    description: 'Moving average window size for joint smoothing (default 3 frames)'
                },
                minConfidence: {
                    type: 'NUMBER',
                    description: 'Minimum pose confidence threshold (default 0.4)'
                },
                outputJsonPath: {
                    type: 'STRING',
                    description: 'Optional path to write JSON motion telemetry'
                }
            },
            required: ['videoPath']
        }
    },
    {
        name: 'vfx_video_auto_reframe',
        description: 'Re-frame a video into vertical (9:16), square (1:1) or any W:H format: MediaPipe finds the person in frames sampled across the clip, and FFmpeg renders one static crop at the average of the tracked positions (the crop does not pan). Fails when MediaPipe cannot run or finds nobody; focusMode "center" crops the middle without tracking.',
        parameters: {
            type: 'OBJECT',
            properties: {
                inputVideoPath: {
                    type: 'STRING',
                    description: 'Absolute path to input video file'
                },
                outputVideoPath: {
                    type: 'STRING',
                    description: 'Absolute path to output re-framed video file'
                },
                targetAspectRatio: {
                    type: 'STRING',
                    description: 'Target aspect ratio: "9:16", "1:1", "4:5", "16:9", or custom "W:H"'
                },
                focusMode: {
                    type: 'STRING',
                    description: 'Subject tracking focus mode: "body" (default), "face", "action", or "center"'
                },
                sampleIntervalSec: {
                    type: 'NUMBER',
                    description: 'Seconds between the frames the person is tracked in (default 0.5)'
                }
            },
            required: ['inputVideoPath', 'targetAspectRatio']
        }
    },
    {
        name: 'vfx_visual_critic_audit',
        description: 'Audit a video or VFX composite against the 8-Dimension Visual Fidelity Rubric: FFmpeg makes a 3x3 contact sheet, MediaPipe measures how steady the limbs of a person in it stay, and a Gemini vision model scores every dimension from the sheet. Passes only when every dimension reaches minPassingScore; a failing audit includes the model\'s fixes. Fails (no score) when the sheet cannot be made, motion tracking cannot run, or the vision model is unavailable.',
        parameters: {
            type: 'OBJECT',
            properties: {
                videoPath: {
                    type: 'STRING',
                    description: 'Absolute path to the video file to audit'
                },
                promptContext: {
                    type: 'STRING',
                    description: 'Context description of the intended VFX shot or prompt'
                },
                referencePlatePath: {
                    type: 'STRING',
                    description: 'Optional path to original reference plate'
                },
                minPassingScore: {
                    type: 'NUMBER',
                    description: 'Score every dimension must reach to pass (default 8.5)'
                }
            },
            required: ['videoPath']
        }
    }
];

export const directorHandlers: Record<string, ToolHandler> = {
    vfx_mediapipe_track_video_motion: async (args, ctx) => {
        const videoPath = asString(args.videoPath);
        if (!videoPath) {
            return {
                resultPayload: { error: 'videoPath is required' },
                summaryResult: 'Failed: videoPath is required.'
            };
        }

        const fps = asNumber(args.fps);
        const startTime = asNumber(args.startTime);
        const duration = asNumber(args.duration);
        const smoothingWindow = asNumber(args.smoothingWindow);
        const minConfidence = asNumber(args.minConfidence);
        const outputJsonPath = asString(args.outputJsonPath) || undefined;
        const noDryRun = refuseDryRun('vfx_mediapipe_track_video_motion', args);
        if (noDryRun) return noDryRun;

        const result = await directorService.trackVideoMotion({
            videoPath,
            fps,
            startTime,
            duration,
            smoothingWindow,
            minConfidence,
            outputJsonPath,
            signal: ctx?.signal,
            onProgress: ctx?.reportProgress
        });

        if (!result.success) {
            return {
                resultPayload: result as unknown as Record<string, unknown>,
                status: 'failed',
                summaryResult: `Motion tracking failed for ${videoPath}: ${result.error}`
            };
        }
        return {
            resultPayload: result as unknown as Record<string, unknown>,
            summaryResult: `Tracked video motion: ${result.totalFramesAnalyzed} frames at ${result.sampleFps}fps (avg confidence ${(result.averageConfidence * 100).toFixed(1)}%, max displacement ${result.maxDisplacementMeters.toFixed(2)}m)`
                + (result.undetectedFrames?.length ? `; ${result.undetectedFrames.length} sampled frame(s) showed no person and were left out.` : '.')
        };
    },

    vfx_video_auto_reframe: async (args, ctx) => {
        const inputVideoPath = asString(args.inputVideoPath);
        const targetAspectRatio = asString(args.targetAspectRatio);
        if (!inputVideoPath || !targetAspectRatio) {
            return {
                resultPayload: { error: 'inputVideoPath and targetAspectRatio are required' },
                summaryResult: 'Failed: inputVideoPath and targetAspectRatio are required.'
            };
        }

        const outputVideoPath = asString(args.outputVideoPath) || undefined;
        const focusMode = (asString(args.focusMode) as 'face' | 'body' | 'action' | 'center') || 'body';
        const sampleIntervalSec = asNumber(args.sampleIntervalSec);
        const noDryRun = refuseDryRun('vfx_video_auto_reframe', args);
        if (noDryRun) return noDryRun;

        const result = await directorService.autoReframeVideo({
            inputVideoPath,
            outputVideoPath,
            targetAspectRatio,
            focusMode,
            sampleIntervalSec,
            signal: ctx?.signal,
            onProgress: ctx?.reportProgress
        });

        return {
            resultPayload: result as unknown as Record<string, unknown>,
            summaryResult: `Auto-reframed video to ${result.targetAspectRatio} (${result.cropDimensions.width}x${result.cropDimensions.height}) -> ${result.outputVideoPath}, `
                    + (focusMode === 'center'
                        ? 'cropped on the frame centre as asked (no subject tracking).'
                        : `framed on the person MediaPipe tracked in ${result.waypoints.length} sampled frame(s)${result.undetectedSamples?.length ? `; ${result.undetectedSamples.length} sampled frame(s) showed no person and were left out` : ''}.`)
        };
    },

    vfx_visual_critic_audit: async (args, ctx) => {
        const videoPath = asString(args.videoPath);
        if (!videoPath) {
            return {
                resultPayload: { error: 'videoPath is required' },
                summaryResult: 'Failed: videoPath is required.'
            };
        }

        const promptContext = asString(args.promptContext) || undefined;
        const referencePlatePath = asString(args.referencePlatePath) || undefined;
        const minPassingScore = asNumber(args.minPassingScore);
        const noDryRun = refuseDryRun('vfx_visual_critic_audit', args);
        if (noDryRun) return noDryRun;

        // Sheet, tracking or vision failures throw: the registry reports the audit as failed with the reason. A Stop
        // (ctx.signal) ends it at the frame or step it is on and cancels the vision request.
        const result = await directorService.auditVideoFidelity({
            videoPath,
            promptContext,
            referencePlatePath,
            minPassingScore,
            signal: ctx?.signal,
            onProgress: ctx?.reportProgress
        });

        const anatomy = result.anatomicalConsistency;
        const anatomyNote = anatomy.limbLengthStabilityRatio !== undefined
            ? `limb-length stability ${(anatomy.limbLengthStabilityRatio * 100).toFixed(0)}% over ${anatomy.framesWithPerson}/${anatomy.framesSampled} sampled frames with a person`
            : `body consistency not measured: ${anatomy.notMeasuredReason}`;
        return {
            resultPayload: result as unknown as Record<string, unknown>,
            summaryResult: `Visual Critic audit by ${result.visionModel} on a 3x3 contact sheet: ${result.passed ? 'PASSED' : 'FAILED'} `
                + `(mean ${result.overallScore.toFixed(2)}/10; ${result.passed ? `every dimension >= ${result.minPassingScore}` : `below ${result.minPassingScore}: ${result.failedDimensions.map(d => `${d} ${result.dimensionAudits[d].score}`).join(', ')}`}); ${anatomyNote}.`
        };
    }
};

// ============================================================================
// 5. Conditioning Plate Tools
// ============================================================================

export const CONDITIONING_TOOL_DECLARATIONS: ToolDeclaration[] = [
    {
        name: 'build_conditioning_contact_sheet',
        description: 'Composites multiple conditioning images into a single borderless multi-panel strip. More panels = higher constraint density when used as an Omni keyframe conditioning input. Returns path, dimensions, and panel count.',
        parameters: {
            type: 'OBJECT',
            properties: {
                imagePaths: {
                    type: 'ARRAY',
                    items: { type: 'STRING' },
                    description: 'Absolute paths to input images for the panels.'
                },
                panelWidthPx: { type: 'NUMBER', description: 'Width of each panel in pixels (default: 512).' },
                panelHeightPx: { type: 'NUMBER', description: 'Height of each panel in pixels (default: 512).' },
                columns: { type: 'NUMBER', description: 'Number of columns (default: all images in one row).' },
                outputPath: { type: 'STRING', description: 'Absolute output path for the composited strip PNG.' }
            },
            required: ['imagePaths', 'outputPath']
        }
    },
    {
        name: 'normalize_conditioning_plates',
        description: 'Normalizes conditioning plates to a uniform size and checks spatial anchor stability. Scans the bottom 25 rows for non-transparent pixels to derive the base center anchor. Spread > maxAnchorDriftPx (default: 5px) indicates detectable spatial drift.',
        parameters: {
            type: 'OBJECT',
            properties: {
                imagePaths: {
                    type: 'ARRAY',
                    items: { type: 'STRING' },
                    description: 'Absolute paths to input images.'
                },
                targetWidth: { type: 'NUMBER', description: 'Target width for all output plates.' },
                targetHeight: { type: 'NUMBER', description: 'Target height for all output plates.' },
                outputDir: { type: 'STRING', description: 'Directory to write normalized plates.' },
                maxAnchorDriftPx: { type: 'NUMBER', description: 'Max allowed anchor drift in pixels before check fails (default: 5).' }
            },
            required: ['imagePaths', 'targetWidth', 'targetHeight', 'outputDir']
        }
    }
];

export const conditioningHandlers: Record<string, ToolHandler> = {
    build_conditioning_contact_sheet: async (args, _ctx) => {
        const imagePaths = Array.isArray(args.imagePaths) ? (args.imagePaths as string[]) : [];
        const outputPath = asString(args.outputPath);
        if (!imagePaths.length || !outputPath) {
            return { resultPayload: { error: 'imagePaths and outputPath are required' }, summaryResult: 'Failed: missing required args.' };
        }
        const result = await buildContactSheet({
            imagePaths,
            panelWidthPx: asNumber(args.panelWidthPx),
            panelHeightPx: asNumber(args.panelHeightPx),
            columns: asNumber(args.columns),
            outputPath
        });
        return {
            resultPayload: result as unknown as Record<string, unknown>,
            summaryResult: `Contact sheet: ${result.panelCount} panels → ${result.widthPx}×${result.heightPx}px at ${result.outputPath}`
        };
    },

    normalize_conditioning_plates: async (args, _ctx) => {
        const imagePaths = Array.isArray(args.imagePaths) ? (args.imagePaths as string[]) : [];
        const targetWidth = asNumber(args.targetWidth) ?? 0;
        const targetHeight = asNumber(args.targetHeight) ?? 0;
        const outputDir = asString(args.outputDir);
        if (!imagePaths.length || !targetWidth || !targetHeight || !outputDir) {
            return { resultPayload: { error: 'imagePaths, targetWidth, targetHeight, outputDir are required' }, summaryResult: 'Failed: missing required args.' };
        }
        const result = await normalizePlates({
            imagePaths,
            targetWidth,
            targetHeight,
            outputDir,
            maxAnchorDriftPx: asNumber(args.maxAnchorDriftPx)
        });
        const status = result.driftCheckPassed ? '✅ drift check passed' : `⚠️ drift ${result.maxDriftPx.toFixed(1)}px exceeds threshold`;
        return {
            resultPayload: result as unknown as Record<string, unknown>,
            summaryResult: `Normalized ${result.outputPaths.length} plates — ${status}`
        };
    }
};

// ============================================================================
// 6. Video QA Tool
// ============================================================================

export const VIDEO_QA_TOOL_DECLARATIONS: ToolDeclaration[] = [
    {
        name: 'video_qa_check',
        description: 'Decodes every frame of a video and runs multi-metric QA from the decoded pixels: delta spike detection (RMS DN between consecutive frames; < 4.1 clean, 4.1–15.0 acceptable, > 15.0 = morph-cut; gated by default), consecutive-frame PSNR (min/mean), worst aligned 8×8 block PSNR over all consecutive pairs, blockiness (8×8 grid-boundary vs interior luma discontinuity ratio, ≈1 when free of block artefacts), temporal stability, and colour drift (max per-channel mean drift from frame 0). PSNR, blockiness and colour drift are reported, and gated only when a threshold is supplied. Returns a structured QA report.',
        parameters: {
            type: 'OBJECT',
            properties: {
                videoPath: { type: 'STRING', description: 'Absolute path to the video file to analyze.' },
                deltaSpikeThreshold: { type: 'NUMBER', description: 'Max acceptable per-frame RMS delta in DN (default: 15.0).' },
                temporalPsnrMin: { type: 'NUMBER', description: 'Optional gate: min consecutive-frame PSNR in dB.' },
                worstBlockPsnrMin: { type: 'NUMBER', description: 'Optional gate: min worst 8×8 block PSNR in dB.' },
                blockinessMax: { type: 'NUMBER', description: 'Optional gate: max per-frame blockiness ratio.' },
                colorDriftMax: { type: 'NUMBER', description: 'Optional gate: max colour drift per channel in DN.' }
            },
            required: ['videoPath']
        }
    }
];

export const videoQAHandlers: Record<string, ToolHandler> = {
    video_qa_check: async (args, _ctx) => {
        const videoPath = asString(args.videoPath);
        if (!videoPath) {
            return { resultPayload: { error: 'videoPath is required' }, summaryResult: 'Failed: videoPath is required.' };
        }
        let report;
        try {
            report = await checkVideo(videoPath, {
                deltaSpikeThreshold: asNumber(args.deltaSpikeThreshold),
                temporalPsnrMin: asNumber(args.temporalPsnrMin),
                worstBlockPsnrMin: asNumber(args.worstBlockPsnrMin),
                blockinessMax: asNumber(args.blockinessMax),
                colorDriftMax: asNumber(args.colorDriftMax)
            });
        } catch (err) {
            if (err instanceof VideoQAError) {
                return { resultPayload: { error: err.message, code: err.code }, summaryResult: `Failed (${err.code}): ${err.message}` };
            }
            throw err;
        }
        const icon = report.passed ? '✅' : '❌';
        return {
            resultPayload: report as unknown as Record<string, unknown>,
            summaryResult: `${icon} Video QA: ${report.summary} (${report.frameCount} frames, max delta ${report.deltaSpike.maxDelta.toFixed(1)}, min temporal PSNR ${report.temporalPsnr.minDb.toFixed(1)} dB)`
        };
    }
};

// ============================================================================
// 7. Subject Segmentation / Holdout Matte Tools
// ============================================================================

const segmenterService = new VfxSubjectSegmenterService();
const objectSegmenterService = new ObjectSegmenterService();

const POINT_LIST: { type: 'ARRAY'; items: ToolParameterSchema } = {
    type: 'ARRAY',
    items: { type: 'ARRAY', items: { type: 'NUMBER' } }
};

export const SEGMENTATION_TOOL_DECLARATIONS: ToolDeclaration[] = [
    {
        name: 'vfx_segment_subject',
        description: 'Cut out any object in an image or a video as binary masks and soft mattes (open vocabulary: whatever the user names, not a fixed list of kinds). Say what to cut out with `target` in words (e.g. "the statue on the left pier", "the red car", "the tree in front of the arch") and/or `positivePoints` / `negativePoints` / `box` in normalised 0..1 image coordinates. A description is turned into a box and points on the object (and points on neighbouring things) by the chat\'s vision model; the MediaPipe Interactive Segmenter then makes the mask from those prompts and OpenCV GrabCut refines its edge (refine: false to skip). Video: the first frame is segmented from the prompts and each later frame follows the previous mask by matching the object\'s motion; with a description the vision model re-checks every recheckEveryFrames frames and whenever the mask jumps, and the result lists every re-check. Writes mask_0000.png… (255 = the object) and matte_0000.png… (soft edge) plus segment_report.json with per-frame area, centroid, box and where each frame\'s prompts came from. Fails with a typed error when the described object is not in the image; it never cuts out something else instead. With none of target/points/box and a video, or with selfieSegmenter: true, it makes person masks with the MediaPipe selfie segmenter (the earlier behaviour).',
        parameters: {
            type: 'OBJECT',
            properties: {
                imagePath: { type: 'STRING', description: 'Absolute path to one image to segment (PNG / JPEG). Give this or videoPath.' },
                videoPath: { type: 'STRING', description: 'Absolute path to a video to segment frame by frame (MP4, MOV, WebM, …). Give this or imagePath.' },
                outputDir: { type: 'STRING', description: 'Absolute path to the directory for the masks, mattes and report. Created if absent.' },
                target: { type: 'STRING', description: 'The object to cut out, described in the user\'s words, as specifically as the conversation allows (position, colour, what it is next to).' },
                positivePoints: { ...POINT_LIST, description: 'Points on the object as [x, y] normalised to 0..1 of the image width and height. When given, no vision model is asked.' },
                negativePoints: { ...POINT_LIST, description: 'Points on things that are NOT the object (neighbours, occluders), as [x, y] normalised 0..1.' },
                box: { type: 'ARRAY', items: { type: 'NUMBER' }, description: 'A box around the object as [x0, y0, x1, y1] normalised 0..1.' },
                refine: { type: 'BOOLEAN', description: 'Refine the mask edge with GrabCut (default true).' },
                fps: { type: 'NUMBER', description: 'Video frame sampling rate (default 5, 1..30).' },
                recheckEveryFrames: { type: 'NUMBER', description: 'Video with a target: the vision model re-checks the object every this many frames (default 10; 0 = only when the mask jumps).' },
                selfieSegmenter: { type: 'BOOLEAN', description: 'Make person masks for a video with the MediaPipe selfie segmenter instead of an object mask.' },
                dryRun: { type: 'BOOLEAN', description: 'Person masks only: validate and return the expected output without segmenting.' }
            },
            required: ['outputDir']
        }
    }
];

function pointList(name: string, v: unknown): NormPoint[] | undefined {
    if (v === undefined || v === null) return undefined;
    if (!Array.isArray(v)) throw new InvalidInputError('vfx_segment_subject', name, 'must be a list of [x, y] points');
    return v as NormPoint[];
}

export const segmentationHandlers: Record<string, ToolHandler> = {
    vfx_segment_subject: async (args, ctx) => {
        const str = (k: string) => typeof args[k] === 'string' && (args[k] as string).trim() ? (args[k] as string).trim() : undefined;
        const videoPath = str('videoPath');
        const imagePath = str('imagePath');
        const outputDir = str('outputDir');
        const target = str('target');
        const fps = typeof args.fps === 'number' ? args.fps : undefined;
        const positivePoints = pointList('positivePoints', args.positivePoints);
        const negativePoints = pointList('negativePoints', args.negativePoints);
        const box = args.box === undefined || args.box === null ? undefined : args.box as NormBox;
        if (!outputDir) throw new MissingInputError('vfx_segment_subject', 'outputDir');

        const prompted = !!target || !!positivePoints?.length || box !== undefined;
        if (args.selfieSegmenter === true || !prompted) {
            if (prompted) throw new InvalidInputError('vfx_segment_subject', 'selfieSegmenter', 'the person segmenter takes no target, points or box; leave selfieSegmenter off to cut out the described object');
            if (!videoPath) throw new MissingInputError('vfx_segment_subject', 'target, positivePoints or box', 'say what to cut out of the image (the person segmenter only runs on a video)');
            const dryRun = args.dryRun === true;
            // A missing video, a failed probe or extraction, or any frame the segmenter cannot do throws a typed error,
            // which fails the call; a result is a complete mask sequence.
            const result = await segmenterService.segmentSubject({ videoPath, outputDir, fps, dryRun });
            const madeBy = result.models.length ? ` with ${result.models.join(', ')}` : '';
            const notes = result.modelNotes.length ? ` ${result.modelNotes.join(' ')}` : '';
            return {
                resultPayload: { ...result, segmenter: 'person (MediaPipe selfie segmenter)' } as Record<string, unknown>,
                status: 'completed',
                summaryResult: dryRun
                    ? `Dry run: would produce ${result.totalFrames} person masks at ${result.sampleFps} fps → ${outputDir} (nothing segmented)`
                    : `Generated ${result.totalFrames} person holdout masks (${result.width}×${result.height}, every sampled frame)${madeBy} → ${outputDir}.${notes}`
            };
        }

        const result = await objectSegmenterService.segment({
            imagePath, videoPath, outputDir, target, positivePoints, negativePoints, box,
            refine: args.refine !== false,
            fps,
            recheckEveryFrames: typeof args.recheckEveryFrames === 'number' ? args.recheckEveryFrames : undefined,
            requestedModel: ctx?.request?.model || undefined,
            signal: ctx?.signal,
            reportProgress: ctx?.reportProgress
        });
        const p = result.prompts;
        const from = p.visionModel ? `prompts from ${p.visionModel.model} ("${p.visionModel.label}")` : 'the given prompts';
        const area = result.frames.reduce((s, f) => s + f.areaFraction, 0) / result.frames.length;
        const rechecks = result.mode === 'video'
            ? ` ${result.rechecks.length} vision re-check${result.rechecks.length === 1 ? '' : 's'}${result.unrecheckedJumps.length ? `; mask jumps not re-checked at frames ${result.unrecheckedJumps.join(', ')}` : ''}.`
            : '';
        return {
            resultPayload: result as Record<string, unknown>,
            status: 'completed',
            summaryResult: `Cut out ${target ? JSON.stringify(target) : 'the prompted object'} in ${result.totalFrames} ${result.mode === 'video' ? 'frames' : 'image'} (${result.width}×${result.height}, mean ${(area * 100).toFixed(1)}% of the frame) from ${from}, MediaPipe Interactive Segmenter${result.refinement === 'grabcut' ? ' + GrabCut edge' : ''} → ${outputDir}.${rechecks}`
        };
    }
};

// ============================================================================
// 8. Aggregated Tool Declarations & Handlers
// ============================================================================

export const VFX_VIDEO_TOOL_DECLARATIONS: ToolDeclaration[] = [
    ...AI_BEAUTIFY_TOOL_DECLARATIONS,
    ...FFMPEG_TOOL_DECLARATIONS,
    ...COMPOSITOR_TOOL_DECLARATIONS,
    ...DIRECTOR_TOOL_DECLARATIONS,
    ...CONDITIONING_TOOL_DECLARATIONS,
    ...VIDEO_QA_TOOL_DECLARATIONS,
    ...SEGMENTATION_TOOL_DECLARATIONS
];

export const vfxVideoHandlers: Record<string, ToolHandler> = {
    ...aiBeautifyHandlers,
    ...ffmpegHandlers,
    ...compositorHandlers,
    ...directorHandlers,
    ...conditioningHandlers,
    ...videoQAHandlers,
    ...segmentationHandlers
};
