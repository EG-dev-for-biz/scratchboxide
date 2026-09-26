/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import type { ComfyPipelineCategory } from '../../common/comfyui-protocol';

export type TaskDomain = '3d' | 'vfx' | 'generative' | 'code' | 'general';

export type PrimaryNativeEngine =
    | 'cpp-3d-engine'
    | 'threejs-webgl'
    | 'vfx-matchmove-nle'
    | 'adaptive-matchmove-calibration'
    | 'google-models'
    | 'workspace-coding'
    | 'skills'
    | 'none';

export interface Tier1Assessment {
    /** True if the app's native code, pipelines, skills, or Google models can fully solve the problem. */
    canSolveNatively: boolean;
    /** Primary native subsystem best suited to solve this task. */
    primaryNativeEngine: PrimaryNativeEngine;
    /** Specific native capabilities, services, or protocols identified. */
    nativeCapabilitiesUsed: string[];
    /** Technical rationale describing how native capabilities address the task. */
    rationale: string;
    /** Concrete action or configuration recommendation for Tier 1. */
    suggestedNativeAction?: {
        primitiveType?: '3d-scene' | 'video-timeline' | 'live-code-sandbox' | 'markdown-document' | 'node-graph';
        serviceOrTool?: string;
        details?: string;
    };
}

export interface Tier2ComfyUiFallback {
    /** True if native capabilities are incapable and spinning up a ComfyUI solution is required. */
    needed: boolean;
    /** Detailed technical justification explaining why native code / Google models cannot solve this. */
    gapReason?: string;
    /** Recommended ComfyUI pipeline category to instantiate. */
    recommendedPipelineCategory?: ComfyPipelineCategory;
    /** Target execution environment (local or Cloud Run GPU). */
    executionTarget: 'cloud-run' | 'local' | 'auto';
    /** Suggested ComfyUI node class types required for this pipeline. */
    suggestedNodes: string[];
    /** Whether dynamic Python custom node code synthesis & injection is required. */
    requiresDynamicNodes: boolean;
    /** Specific dynamic node classes that should be synthesized. */
    suggestedDynamicClasses?: string[];
}

export interface CapabilityResolutionResult {
    /** The evaluated task goal or prompt. */
    taskGoal: string;
    /** Primary domain classification. */
    taskDomain: TaskDomain;
    /** Evaluation of what the app can do currently via coding, pipelines, skills, and Google models. */
    tier1Assessment: Tier1Assessment;
    /** Fallback evaluation for spinning up a ComfyUI solution if native capabilities are insufficient. */
    tier2Fallback: Tier2ComfyUiFallback;
    /** Recommended resolution route. */
    recommendedResolutionRoute: 'tier1-native' | 'tier2-comfyui';
    /** Convenience alias for recommendedResolutionRoute matching TwoTierExecutionResult */
    tier?: 'tier1-native' | 'tier2-comfyui';
    /** Convenience alias for tier1Assessment.rationale */
    rationale?: string;
    /** Convenience alias for recommended native tool */
    recommendedNativeTool?: string;
}

export interface CapabilityOptions {
    domainHint?: TaskDomain | 'auto';
    promptContext?: string;
    userGoal?: string;
    goal?: string;
    hasInputImage?: boolean;
    hasInputVideo?: boolean;
    hasCameraTrack?: boolean;
    targetEnvironment?: 'local' | 'cloud-run' | 'auto';
    forceComfyUi?: boolean;
}

export class TaskCapabilityResolver {
    /**
     * Classifies the primary domain of a task goal.
     */
    static classifyTaskDomain(taskGoal: string): TaskDomain {
        const lower = (taskGoal || '').toLowerCase();

        // Generative Diffusion / Neural (Check first so neural diffusion doesn't get masked by generic mesh/video keywords)
        if (
            /diffusion|lora|checkpoint|latent|controlnet|trellis|triposr|marigold|depth-anything|animatediff|omni\s*restyle|svd|cogvideo|wan2\.[12]|4danyone|inpaint|outpaint|image-to-3d|video-to-video|color\s*transfer|palette|nano\s*banana/i.test(lower)
        ) {
            return 'generative';
        }

        // VFX & Video
        if (
            /vfx|visual\s*effects|matchmove|camera\s*solve|keyframe\s*calibrat|camera\s*track|ephemeris|solar\s*position|holdout|occlusion\s*matte|nle|video\s*timeline|clip\s*split|ripple\s*delete|audio\s*track|b-roll/i.test(lower)
        ) {
            return 'vfx';
        }

        // 3D & XR
        if (
            /3d|mesh|geometry|sdf|marching\s*cubes|terrain|biome|glb|gltf|three\.js|webgl|c\+\+|clang|polygon|voxel|photorealistic\s*3d\s*tiles|cesium|quad\s*remesh|utdra|uldra|tile|void\s*carv|bridge\s*void|underpass|webxr|geospatial\s*anchor|arcore|resect(?:ion)?|geobox|image\s*location|optical\s*center|edge\s*overlap|sub-?pixel|solvepnp|pnp|feature\s*match|point\s*correspondence|lens\s*distortion|barrel\s*distortion|pincushion|chromatic\s*aberration|optical\s*lens|lens\s*shader|anamorphic\s*squeeze|atmosphere|lighting|rayleigh|mie|scattering|turbidity|sky\s*dome|aerial\s*perspective|god\s*rays|diurnal|kelvin|cloud\s*shadow|uv|unwrap|rewrap|pbr|cavitation|texture\s*atlas/i.test(lower)
        ) {
            return '3d';
        }

        // Code / Programming
        if (
            /code|function|class|typescript|refactor|compile|build|test|debug|lint|diagnostics|git|api\s*endpoint|fastapi/i.test(lower)
        ) {
            return 'code';
        }

        return 'general';
    }

    /**
     * Resolves task capability using the Two-Tier Strategy:
     * 1. Inspects native app capabilities (C++20 3D engine, Three.js shaders, Video NLE, VFX matchmoving, solar ephemeris, Google models, skills).
     * 2. If incapable (neural diffusion, image-to-3D, video restyling, monocular depth), formulates Tier 2 ComfyUI fallback.
     */
    static resolveTaskCapability(
        taskGoal: string | { userGoal?: string; goal?: string; promptContext?: string; domainHint?: any },
        options: CapabilityOptions = {}
    ): CapabilityResolutionResult {
        let goal = '';
        let opts: CapabilityOptions = { ...options };
        if (typeof taskGoal === 'object' && taskGoal !== null) {
            goal = taskGoal.userGoal || taskGoal.goal || '';
            opts = { ...(taskGoal as CapabilityOptions), ...options };
        } else {
            goal = taskGoal || '';
        }
        const lower = goal.toLowerCase();
        const domain = (opts.domainHint && opts.domainHint !== 'auto')
            ? opts.domainHint
            : this.classifyTaskDomain(goal);

        // Check for specific neural/generative triggers that exceed native algorithmic and Google model capabilities
        const isNeuralImageTo3D = (/image-to-3d|photo\s+to\s+3d|picture\s+to\s+mesh|2d\s+to\s+3d|trellis|triposr|sv3d|crm|hunyuan3d/i.test(lower) &&
            !/point\s*correspondence|keypoint|pnp|solvepnp|feature\s*match|optical\s*center|resect/i.test(lower)) ||
            ((lower.includes('image') || lower.includes('photo') || options.hasInputImage) && (lower.includes('reconstruct 3d') || lower.includes('generate 3d mesh') || lower.includes('convert to 3d mesh')));

        const isNeuralVideoRestyle = /video-to-video|restyle\s+video|neural\s+video|animatediff|omni\s*restyle|temporal\s+restyl|video\s+style\s+transfer/i.test(lower) ||
            ((lower.includes('video') || options.hasInputVideo) && (lower.includes('restyle') || lower.includes('stylize video') || lower.includes('anime style') || lower.includes('cyberpunk restyle')));

        const isMonocularNeuralDepth = /monocular\s+depth|depth\s+estimation|marigold|depth-anything|zoedepth|dense\s+depth\s+map/i.test(lower) &&
            !lower.includes('camera solve') && !lower.includes('tracking marker');

        const isLatentDiffusionInpaint = /latent\s+inpaint|controlnet|stable\s+diffusion|sdxl|flux|lora\s+inpaint/i.test(lower);

        const isExplicitComfyRequest = options.forceComfyUi || /comfyui|comfy\s+pipeline|node\s+graph\s+diffusion|custom\s+checkpoint/i.test(lower);

        // Check if Tier 1 can natively solve this
        let canSolveNatively = true;
        let primaryNativeEngine: PrimaryNativeEngine = 'workspace-coding';
        const nativeCapabilities: string[] = [];
        let rationale = '';
        let suggestedNativeAction: Tier1Assessment['suggestedNativeAction'] | undefined;

        const isAdaptiveMatchmove = /adaptive\s*matchmove|calibrat\w*.*keyframe|keyframe.*calibrat|matchmove.*calibrat|calibrat.*matchmove|bundle\s*adjust|camera\s*track|6-?dof\s*resect|hermite\s*spline/i.test(lower);

        const isFrameMotivatedPerformerPrompt =
            /build_?frame_?motivated_?performer_?prompt|buildframemotivatedperformerprompt|frame\s*motivated.*(?:prompt|video)|motivated\s*by\s*the\s*frame.*(?:prompt|format)|format.*motivated\s*by/i.test(lower) ||
            (opts.promptContext ? /buildframemotivatedperformerprompt|frame_?motivated/i.test(opts.promptContext) : false);

        const isWan4DAnyoneDiffusionExecution =
            (/wan2\.2|4danyone|all\s*(?:the\s*)?different\s*video\s*positions/i.test(lower) &&
            /video\s*model|capture|diffusion|generate|run/i.test(lower) &&
            !/prompt\s*only|format\s*prompt|text\s*only|author/i.test(lower)) ||
            (opts.promptContext ? /comfyui_execute_pipeline|wan2\.2|4danyone/i.test(opts.promptContext) && !/prompt/i.test(lower) : false);

        const isNeutralPerformerPrompt = /buildneutralperformerprompt|neutral.*(?:prompt|video|image|portrait|performer|avatar)|(?:performer|avatar|character|dancer|vocalist).*(?:neutral|a[\s-]frame|prompt)|(?:prompt|video|image).*(?:neutral|a[\s-]frame)|a[\s-]frame/i.test(lower);

        if (isWan4DAnyoneDiffusionExecution) {
            canSolveNatively = false;
            primaryNativeEngine = 'none';
            rationale = 'Multi-view 360-degree video capture using the 4DAnyone / Wan2.2-TI2V-5B video diffusion backbone requires heavy multi-camera video generation with Reference Context Packing (RCP) and Target Context Routing (TCR), requiring GPU ComfyUI / Cloud Run acceleration.';
        } else if (isFrameMotivatedPerformerPrompt) {
            canSolveNatively = true;
            primaryNativeEngine = 'google-models';
            nativeCapabilities.push('Frame-Motivated Performer Video Prompt Pipeline (buildFrameMotivatedPerformerVideoPrompt)');
            nativeCapabilities.push('build_frame_motivated_performer_prompt Agent Tool (<FIRST_FRAME> Syntax, A-Pose Invariant, Multi-View Video Positions)');
            nativeCapabilities.push('Wan2.2-TI2V-5B conditioning tags & A-pose continuity');
            rationale = 'Native Frame-Motivated Performer Video Prompt Pipeline formulates exact <FIRST_FRAME> conditioning, A-pose continuity clauses, camera viewpoint angles (0°, 45°, 180°), and prompt neutrality rules.';
            suggestedNativeAction = {
                primitiveType: 'markdown-document',
                serviceOrTool: 'build_frame_motivated_performer_prompt',
                details: 'Invoke build_frame_motivated_performer_prompt with referenceFrameRef, subject, wardrobe, and cameraPosition.'
            };
        } else if (isNeutralPerformerPrompt) {
            canSolveNatively = true;
            primaryNativeEngine = 'google-models';
            nativeCapabilities.push('Neutral Performer Studio Prompt Pipeline (buildNeutralPerformerPrompt)');
            nativeCapabilities.push('build_neutral_performer_prompt Agent Tool (Zero Context, Shadowless Lighting, A-Frame Pose)');
            nativeCapabilities.push('Prompt Neutrality Contract & Head-to-Toe Vertical 9:16 Framing');
            rationale = 'Native Neutral Performer Studio Prompt Pipeline constructs strictly uncropped head-to-toe portraits in symmetrical A-frame pose with zero background context (#808080 studio grey) and shadowless high-CRI diffuse lighting to prevent backprojection cavities and SMPL distortion.';
            suggestedNativeAction = {
                primitiveType: 'markdown-document',
                serviceOrTool: 'buildNeutralPerformerPrompt or build_neutral_performer_prompt tool',
                details: 'Invoke build_neutral_performer_prompt with subject, wardrobe, aspectRatio ("9:16"), kind ("image" or "video"), and isAFramePose (true).'
            };
        } else if (domain === 'vfx') {
            const isMatchmoveOrSolar = /matchmove|camera\s*solve|sub-frame|brown-conrady|lens\s*distortion|ephemeris|solar\s*position|sun\s*altitude|sun\s*heading|noaa/i.test(lower);
            const isNleEditing = /timeline|nle|clip\s*split|ripple\s*delete|multi-track|audio\s*track|trim\s*clip|playhead/i.test(lower);
            const isHoldoutMatte = /holdout|occlusion|matte|destination-out|actor\s*occlusion/i.test(lower);

            if (isNeuralVideoRestyle) {
                // Neural video restyling cannot be done by algorithmic NLE or matchmoving
                canSolveNatively = false;
                primaryNativeEngine = 'none';
                rationale = 'The requested video transformation requires deep generative neural restyling / temporal diffusion (e.g. Omni/AnimateDiff), which cannot be computed deterministically by the native Video NLE timeline or VFX plate matchmove services.';
            } else if (isAdaptiveMatchmove) {
                canSolveNatively = true;
                primaryNativeEngine = 'adaptive-matchmove-calibration';
                nativeCapabilities.push('AdaptiveMatchmoveCalibrationService (6-DOF resection, LM bundle adjustment, Hermite splines)');
                nativeCapabilities.push('Brown-Conrady radial lens distortion & breathing model');
                nativeCapabilities.push('Gimbal-free facade-normal slerp & drone kinematic safety audit');
                nativeCapabilities.push('SequenceMetrologyReport (sub-pixel RMS residual & Sobel NCC)');
                rationale = 'Native AdaptiveMatchmoveCalibrationService solves 6-DOF camera resection, Levenberg-Marquardt bundle adjustment across milestones, Hermite trajectory splines, and metrology certification directly in Tier 1.';
                suggestedNativeAction = {
                    primitiveType: '3d-scene',
                    serviceOrTool: 'adaptive_matchmove_calibrate_sequence',
                    details: 'Calibrate sequence milestones, optimize Brown-Conrady lens breathing, and synthesize continuous C2 Hermite camera trajectory.'
                };
            } else if (isMatchmoveOrSolar) {
                canSolveNatively = true;
                primaryNativeEngine = 'vfx-matchmove-nle';
                nativeCapabilities.push('VfxPlateMatchmoveService (6-DOF camera solve, sub-frame interpolation)');
                nativeCapabilities.push('Brown-Conrady lens distortion / undistortion model');
                nativeCapabilities.push('NOAA Geodetic Ephemeris Solar Position Calculator (azimuth & altitude)');
                nativeCapabilities.push('Video3DLayerRenderer (Three.js WebGL compositing)');
                rationale = 'Native Scratchbox VFX Plate Matchmove & Solar Position services solve camera solve tracks, sub-frame interpolation, Brown-Conrady lens undistortion, and celestial sun alignment directly in the browser/core runtime.';
                suggestedNativeAction = {
                    primitiveType: 'video-timeline',
                    serviceOrTool: 'VfxPlateMatchmoveService.interpolateCameraSolve & getSolarPosition',
                    details: 'Mount video-timeline with cameraSolveTrack and ephemerisAnchor.'
                };
            } else if (isNleEditing || isHoldoutMatte) {
                canSolveNatively = true;
                primaryNativeEngine = 'vfx-matchmove-nle';
                nativeCapabilities.push('VideoTimelineSynthesizer (multi-track NLE)');
                nativeCapabilities.push('Destination-Out Holdout Matte Compositor');
                nativeCapabilities.push('TimelineMath (sub-second split, trim, ripple delete)');
                rationale = 'Native Video Timeline Synthesizer supports multi-track video, 3D CG layers, holdout mattes with destination-out blending, and precise NLE clip editing.';
                suggestedNativeAction = {
                    primitiveType: 'video-timeline',
                    serviceOrTool: 'synthesizeContextualVideoTimeline',
                    details: 'Mount video-timeline primitive with custom tracks and holdouts.'
                };
            } else {
                canSolveNatively = true;
                primaryNativeEngine = 'vfx-matchmove-nle';
                nativeCapabilities.push('Video NLE Pipeline');
                rationale = 'Native video timeline and VFX plate services can orchestrate video elements, 3D layers, and audio tracks.';
            }
        } else if (domain === '3d') {
            if (isNeuralImageTo3D) {
                canSolveNatively = false;
                primaryNativeEngine = 'none';
                rationale = 'Single-image to 3D mesh reconstruction requires a neural generative diffusion model (such as Trellis, TripoSR, or SV3D). The native C++20 engine is built for procedural geometry, SDFs, and photogrammetric tiles, not zero-shot 2D-to-3D neural reconstruction.';
            } else if (isAdaptiveMatchmove) {
                canSolveNatively = true;
                primaryNativeEngine = 'adaptive-matchmove-calibration';
                nativeCapabilities.push('AdaptiveMatchmoveCalibrationService (6-DOF resection, LM bundle adjustment, Hermite splines)');
                nativeCapabilities.push('Brown-Conrady radial lens distortion & breathing model');
                nativeCapabilities.push('Gimbal-free facade-normal slerp & drone kinematic safety audit');
                nativeCapabilities.push('SequenceMetrologyReport (sub-pixel RMS residual & Sobel NCC)');
                rationale = 'Native AdaptiveMatchmoveCalibrationService solves 6-DOF camera resection, Levenberg-Marquardt bundle adjustment across milestones, Hermite trajectory splines, and metrology certification directly in Tier 1.';
                suggestedNativeAction = {
                    primitiveType: '3d-scene',
                    serviceOrTool: 'adaptive_matchmove_calibrate_sequence',
                    details: 'Calibrate sequence milestones, optimize Brown-Conrady lens breathing, and synthesize continuous C2 Hermite camera trajectory.'
                };
            } else if (/reshape|deform|taper|twist|bend|bulge|squash|shear|sculpt.*mesh|mesh.*shaping|lattice.*deform/i.test(lower)) {
                canSolveNatively = true;
                primaryNativeEngine = 'cpp-3d-engine';
                nativeCapabilities.push('Native C++20 Astra Mesh Reshaper Engine (scratchbox_shaper.hpp)');
                nativeCapabilities.push('NativeMeshReshaperService / MeshReshapingService');
                nativeCapabilities.push('Parametric Non-Linear Deformers (Taper, Twist, Bend, Bulge, Squash, Shear)');
                nativeCapabilities.push('Trivariate Bernstein FFD 3D Tensor Lattice (Lattice3D)');
                nativeCapabilities.push('Multi-Brush Digital Sculpt Engine (Clay, Crease, Smooth, Flatten, Inflate)');
                nativeCapabilities.push('Loop Subdivision & Manifold Topology Repair');
                nativeCapabilities.push('In-App Agent Tools: mesh_reshape_via_prompt & mesh_apply_deformers');
                rationale = 'Native Scratchbox C++20 Astra 3D engine executes sub-second parametric deformers, Bernstein FFD lattices, sculpt strokes, and loop subdivision directly on meshes, compiling via Apple Clang with zero external dependencies.';
                suggestedNativeAction = {
                    primitiveType: '3d-scene',
                    serviceOrTool: 'mesh_reshape_via_prompt or NativeMeshReshaperService',
                    details: 'Call mesh_reshape_via_prompt with the user prompt or execute NativeMeshReshaperService.reshapeMesh to deform the mesh and stream binary .glb into 3d-scene.'
                };
            } else if (/utdra|uldra|tile\s*decomposition|rectif(?:y|ication)|bridge\s*void|underpass\s*void|sutherland\s*-?\s*hodgman|slope\s*stratified|domain\s*probe/i.test(lower)) {
                canSolveNatively = true;
                primaryNativeEngine = 'cpp-3d-engine';
                nativeCapabilities.push('Universal Tile Decomposition & Rectification Algorithm (UTDRA / ULDRA)');
                nativeCapabilities.push('UniversalTileDecompositionService / UtdraService / UldraService');
                nativeCapabilities.push('DomainClassifier (9 Macro-Geographic Domains)');
                nativeCapabilities.push('Sutherland-Hodgman Non-Destructive Slicer & Multi-Level Void Carver');
                nativeCapabilities.push('C++20 Native Pipeline (run_utdra_pipeline)');
                rationale = 'Native C++20 UTDRA / ULDRA pipeline probes macro-domains, rectifies architectural shafts, carves underpass voids beneath bridges, and performs elevation slicing with 100% geometric manifold preservation.';
                suggestedNativeAction = {
                    primitiveType: '3d-scene',
                    serviceOrTool: 'utdra_decompose_tile or UniversalTileDecompositionService',
                    details: 'Call utdra_decompose_tile / utdra_probe_tile or execute UniversalTileDecompositionService to rectify mesh and stream into 3d-scene primitive.'
                };
            } else if (/beautif|nano\s*banana.*(?:prompt|location)|buildbeautifyprompt/i.test(lower)) {
                canSolveNatively = true;
                primaryNativeEngine = 'google-models';
                nativeCapabilities.push('AI Beautify Location Pipeline (buildBeautifyPrompt)');
                nativeCapabilities.push('build_beautify_prompt Agent Tool (exact framing & aspect ratio rules)');
                nativeCapabilities.push('Google 3D Tiles Vantage Alignment');
                rationale = 'Native AI Beautify Location Pipeline constructs non-negotiable 3D tile framing prompts, preserving exact camera pitch/yaw, vanishing points, horizon line, and canvas aspect ratio for photorealistic restyling.';
                suggestedNativeAction = {
                    primitiveType: 'markdown-document',
                    serviceOrTool: 'buildBeautifyPrompt or build_beautify_prompt tool',
                    details: 'Invoke build_beautify_prompt with locationName, coords, heading, and styleSuffix.'
                };
            } else if (/algorithmic\s*uv|unwrap.*rewrap|rewrap.*unwrap|uv\s*(?:unwrap|re-?wrap|parameteriz|atlas\s*pack|maxrects)|cavitation\s*pore|calcite\s*strata|pbr\s*material\s*decompos|conformal\s*reparameteriz/i.test(lower)) {
                canSolveNatively = true;
                primaryNativeEngine = 'cpp-3d-engine';
                nativeCapabilities.push('Algorithmic UV Unwrap & Rewrap Engine (AlgorithmicUvEngine)');
                nativeCapabilities.push('Native C++20 Astra UV Acceleration (scratchbox_uv_engine.hpp)');
                nativeCapabilities.push('MaxRects BSSF Atlas Bin Packing with 90° Chart Rotation (85-92% Fill Density)');
                nativeCapabilities.push('Continuous 2D-to-3D Inverse Barycentric Projection & Analytical Cavitation Synthesis');
                nativeCapabilities.push('Photometric De-Lighting & True PBR Material Suite Decomposition');
                nativeCapabilities.push('Preserve-100-Lock (0.000 mm Vertex Drift) & Conformal Reparameterization Modes');
                nativeCapabilities.push('In-App Agent Tools: algorithmic_uv_unwrap_rewrap, pbr_material_decompose, atlas_maxrects_pack');
                rationale = 'Native C++20 Algorithmic UV Unwrap & Rewrap Engine performs analytical travertine micro-cavitation, calcite bedding strata, MaxRects high-efficiency chart packing, and PBR material suite decomposition with 100% vertex/UV lock option.';
                suggestedNativeAction = {
                    primitiveType: '3d-scene',
                    serviceOrTool: 'AlgorithmicUvEngine.processGlb or algorithmic_uv_unwrap_rewrap tool',
                    details: 'Invoke algorithmic_uv_unwrap_rewrap to enhance 3D model textures and stream binary .glb into 3d-scene primitive.'
                };
            } else if (/(?:recolor|re-color|grade|re-?grade|texture\s*atlas|material\s*harmoniz|pbr).*(?:3d\s*tile|glb|model|photometry|photogrammetr)|(?:3d\s*tile|glb|texture\s*atlas).*(?:recolor|re-color|grade|re-?grade|palette|foliage\s*protect|pbr)/i.test(lower)) {
                canSolveNatively = true;
                primaryNativeEngine = 'cpp-3d-engine';
                nativeCapabilities.push('Sophisticated 3D Tile Recoloring Engine v2 (GlbTextureRecolorService)');
                nativeCapabilities.push('recolor3DTilesGlb API & google_3d_tiles_recolor_glb Agent Tool');
                nativeCapabilities.push('CIELAB Hue-Aware Semantic Segmentation (Foliage & Asphalt Protection)');
                nativeCapabilities.push('Intrinsic Shadow De-lighting & Crevice Lift');
                nativeCapabilities.push('PBR Normal Map & Metallic-Roughness Synthesis');
                nativeCapabilities.push('100% Geometric Vertex Lock (0.000 mm Drift)');
                rationale = 'Native Sophisticated 3D Tile Recoloring Engine v2 re-grades photogrammetric texture atlases directly in CIELAB, selectively protecting natural foliage and asphalt while synthesizing tactile PBR normal and roughness maps with zero geometric drift.';
                suggestedNativeAction = {
                    primitiveType: '3d-scene',
                    serviceOrTool: 'recolor3DTilesGlb or google_3d_tiles_recolor_glb tool',
                    details: 'Call recolor3DTilesGlb / google_3d_tiles_recolor_glb to re-grade the 3D tile GLB texture atlas and synthesize PBR maps.'
                };
            } else if (/photorealistic\s*3d\s*tiles|google\s*(3d\s*)?tiles|real-world\s*3d|city\s*3d|building\s*mesh|geographic\s*coordinates|manhattan\s*3d|earth\s*3d/i.test(lower)) {
                canSolveNatively = true;
                primaryNativeEngine = 'cpp-3d-engine';
                nativeCapabilities.push('Google Photorealistic 3D Tiles Ingestion (Full Texture & Studio Clay)');
                nativeCapabilities.push('getGoogle3DTilesFullTexture & getGoogle3DTilesClay APIs');
                nativeCapabilities.push('Leaf LOD Ingestion (errorTarget <= 0.5, 4K SSE budget, async settle)');
                rationale = 'Native Google 3D Tiles blockout pipeline retrieves any address or coordinate pair as a high-fidelity 3D GLB mesh in either full photogrammetric texture or studio grey clay mode with zero presets.';
                suggestedNativeAction = {
                    primitiveType: '3d-scene',
                    serviceOrTool: 'getGoogle3DTilesFullTexture or getGoogle3DTilesClay',
                    details: 'Call google_3d_tiles_get_full_texture / google_3d_tiles_get_clay to ingest high-fidelity 3D object, then mount to 3d-scene.'
                };
            } else if (/webxr|geospatial\s*anchor|arcore|gps\s*(?:to|<->|alignment|metric)|metric\s*space\s*alignment|sensor\s*fusion\s*calibration|optical\s*pin\s*calibration|project\s*(?:road|parcel).*webxr/i.test(lower)) {
                canSolveNatively = true;
                primaryNativeEngine = 'threejs-webgl';
                nativeCapabilities.push('WebXR Geospatial Anchor Bridge (WebXRGeospatialAnchorBridge)');
                nativeCapabilities.push('Bidirectional WGS-84 Local Tangent Plane (ENU) to WebXR Metric Space Alignment');
                nativeCapabilities.push('Autonomous Sensor Fusion (Device GPS + Compass + WebXR Viewer Pose)');
                nativeCapabilities.push('Zero-Drift Manual Optical Pin Calibration');
                nativeCapabilities.push('ARCore GeoAnchorDeploymentContract Synchronization');
                nativeCapabilities.push('Google Maps Road Centerline & Parcel Extrusion Projection to WebXR 3D Lines/Meshes');
                rationale = 'Native WebXR Geospatial Anchor Bridge accurately aligns real-world WGS-84 geodetic coordinates to WebXR local-floor metric space with autonomous sensor fusion and zero-drift optical pin calibration.';
                suggestedNativeAction = {
                    primitiveType: '3d-scene',
                    serviceOrTool: 'WebXRGeospatialAnchorBridge & webxr_geospatial_* tools',
                    details: 'Use webxr_geospatial_align_coordinates, webxr_geospatial_calibrate, or webxr_geospatial_project_vectors to synchronize geodetic anchors and render into WebXR viewport.'
                };
            } else if (/lens\s*shader|optical\s*(?:distortion|effect|lens)|lens\s*distortion(?:\s*shader|\s*pass)?|brown-?conrady\s*(?:shader|pass|distortion)|chromatic\s*aberration|barrel\s*distortion|pincushion\s*distortion|anamorphic\s*squeeze/i.test(lower)) {
                canSolveNatively = true;
                primaryNativeEngine = 'threejs-webgl';
                nativeCapabilities.push('LensDistortionEffect & BrownConradyLensDistortionPass (Three.js WebGL post-processing)');
                nativeCapabilities.push('LENS_DISTORTION_SHADER (GLSL Brown-Conrady radial/tangential & chromatic dispersion)');
                nativeCapabilities.push('Analytical Brown-Conrady CPU projection (computeBrownConradyUV)');
                nativeCapabilities.push('Lens archetype presets (LENS_OPTICAL_PRESETS) & focal calibration');
                nativeCapabilities.push('optics_configure_lens_distortion Gemini Agent Tool');
                rationale = 'Native LensDistortionEffect applies hardware-accelerated Brown-Conrady lens distortion, chromatic dispersion, and optical presets directly via Three.js WebGL post-processing and analytical CPU routines.';
                suggestedNativeAction = {
                    primitiveType: '3d-scene',
                    serviceOrTool: 'LensDistortionEffect & optics_configure_lens_distortion tool',
                    details: 'Instantiate LensDistortionEffect, apply optical profile or calculate focal coefficients, and chain into post-processing pipeline.'
                };
            } else if (/geobox|resection|optical\s*center|camera\s*resection|edge\s*overlap|sub-?pixel\s*(?:edge|alignment)|brown-?conrady|image\s*location|localize\s*photo|solvepnp|pnp|2d-to-3d|feature\s*match|pose\s*estimation/i.test(lower)) {
                canSolveNatively = true;
                primaryNativeEngine = 'threejs-webgl';
                nativeCapabilities.push('Spatial Pose Estimator (SpatialPoseEstimatorService.solvePnP, solvePnPRansac)');
                nativeCapabilities.push('Visual Feature Matcher (VisualFeatureMatcherService, Harris/FAST, 128-D descriptors, Lowe ratio)');
                nativeCapabilities.push('Headless Mesh Silhouette & Edge Renderer (HeadlessMeshSilhouetteRenderer, binary .glb loading)');
                nativeCapabilities.push('Closed-Loop Sub-Pixel Edge Alignment Optimizer (SubPixelEdgeAlignmentOptimizer, 100% overlap, < 0.1px)');
                nativeCapabilities.push('GeoBox Precision Resection Service (GeoBoxPrecisionResectionService)');
                nativeCapabilities.push('Brown-Conrady Lens Calibration (k1, k2, p1, p2, chromatic aberration)');
                nativeCapabilities.push('spatial_solve_pnp, spatial_match_features_2d_3d, spatial_closed_loop_edge_align, geobox_resect_image_location Tools');
                rationale = 'Native Spatial Pose Estimation and GeoBox resection pipeline calculates exact analytical 6-DOF camera poses via solvePnP/DLT/Levenberg-Marquardt from 2D-to-3D feature matches, with pure Node.js headless silhouette rasterization and closed-loop edge optimization converging to 100% overlap and sub-pixel residuals (< 0.1 px).';
                suggestedNativeAction = {
                    primitiveType: '3d-scene',
                    serviceOrTool: 'GeoBoxPrecisionResectionService / SpatialPoseEstimatorService (spatial_solve_pnp / geobox_resect_image_location)',
                    details: 'Invoke spatial_solve_pnp, spatial_match_features_2d_3d, or geobox_resect_image_location to resect photo vantage point and lock camera pose.'
                };
            } else if (/atmosphere|lighting|rayleigh|mie|scattering|turbidity|sky\s*dome|aerial\s*perspective|god\s*rays|diurnal|kelvin|cloud\s*shadow|match\s*lighting|de-?light|delighting|harmonize\s*lighting|lighting.*3d\s*object|portal\s*fixture|window\s*(?:illumination|backlight)|gaffer|rembrandt|butterfly|film\s*noir|cinematic\s*light|photographic\s*light|key-?to-?fill|inverse\s*light/i.test(lower)) {
                canSolveNatively = true;
                primaryNativeEngine = 'threejs-webgl';
                nativeCapabilities.push('Photographic Gaffer Engine (LightingGafferService & sb_configure_gaffer_rig)');
                nativeCapabilities.push('Inverse Photometric Image Estimator (InverseLightingEstimatorService)');
                nativeCapabilities.push('Closed-Loop Photometric Matchmove Optimizer (ClosedLoopLightingOptimizerService)');
                nativeCapabilities.push('Atmosphere Service (AtmosphereService & AtmosphereImageEstimationService)');
                nativeCapabilities.push('Location 3D Object Lighting & Photogrammetric De-lighting (LocationObjectLightingService & harmonizeLocationObjectAtmosphere)');
                nativeCapabilities.push('Architectural Portal Window Backlighting (2,850K incandescent ambulatory fixtures)');
                nativeCapabilities.push('Atmospheric Rayleigh & Mie Scattering Dome (AtmosphericSkyDome)');
                nativeCapabilities.push('Diurnal Solar Ephemeris & Planckian Kelvin Radiometry (1,000K - 40,000K)');
                nativeCapabilities.push('Aerial Perspective Koschmieder Extinction & Volumetric God Rays');
                nativeCapabilities.push('Agent Tools (lighting_estimate_from_photo, lighting_configure_gaffer_rig, lighting_optimize_closed_loop, geobox_harmonize_location_lighting)');
                rationale = 'Native LightingGafferService, InverseLightingEstimatorService, and ClosedLoopLightingOptimizerService provide photographic gaffer reasoning (Rembrandt, Split, Butterfly), beam modifiers, inverse photo estimation, and closed-loop lighting alignment directly in Tier 1.';
                suggestedNativeAction = {
                    primitiveType: '3d-scene',
                    serviceOrTool: 'LocationObjectLightingService & geobox_harmonize_location_lighting / LightingGafferService / lighting_* tools',
                    details: 'Invoke lighting_estimate_from_photo or lighting_configure_gaffer_rig, or run lighting_optimize_closed_loop to achieve >=95% photometric correlation.'
                };

            } else if (/360\s*panorama|4k\s*panorama|monumental\s*panorama|equirectangular|seam\s*heal|nadir\s*inpaint|zenith|polar\s*pinch|panorama_heal_seam|panorama_reproject_zenith|panorama_generate_4k/i.test(lower)) {
                canSolveNatively = true;
                primaryNativeEngine = 'google-models';
                nativeCapabilities.push('Google Vertex AI / Imagen 3 Panorama Seam Healing (Google360PanoramaPipelineService)');
                nativeCapabilities.push('4K Monumental 360 Panorama Generator (Google360PanoramaPipelineService.generate4KMonumentalPanorama & panorama_generate_4k)');
                nativeCapabilities.push('Equirectangular 50% Roll & Laplacian 2-Band Seam Equalization');
                nativeCapabilities.push('Google Models Nadir Rig & Floater Inpainting');
                nativeCapabilities.push('Adaptive Two-Pass Zenith Reprojection (Option A 1:1 rectilinear patch inverse gnomonic raycasting)');
                nativeCapabilities.push('Agent Tools (panorama_generate_4k, panorama_heal_seam, panorama_inpaint, panorama_generate_360, panorama_reproject_zenith, panorama_extract_zenith)');
                rationale = 'Native Google 360 Panorama Pipeline Service performs 4K monumental synthesis with Laplacian 2-band seam equalization, clean circle-free polar collapse, equirectangular roll-shift inpainting with Imagen 3 / Gemini, and Option A Zenith Reprojection eliminating polar pinch singularities.';
                suggestedNativeAction = {
                    primitiveType: '3d-scene',
                    serviceOrTool: 'Google360PanoramaPipelineService & panorama_* tools',
                    details: 'Invoke panorama_generate_4k, panorama_heal_seam, panorama_reproject_zenith, or panorama_inpaint to synthesize seamless equirectangular environment skyboxes.'
                };
            } else {
                canSolveNatively = true;
                primaryNativeEngine = 'cpp-3d-engine';
                nativeCapabilities.push('Scratchbox C++20 3D Engine (scratchbox_engine.hpp)');
                nativeCapabilities.push('NativeCppCompilerService (Apple Clang -std=c++20 -O3)');
                nativeCapabilities.push('SIMD Vector Math, Signed Distance Fields (SDFs), Marching Cubes');
                nativeCapabilities.push('FastNoise3D (Perlin, FBM, Worley Cellular)');
                nativeCapabilities.push('Binary glTF 2.0 (.glb) streaming to Three.js viewport');
                nativeCapabilities.push('Google Photorealistic 3D Tiles & Cesium Ingestion');
                rationale = 'Native Scratchbox C++20 3D engine compiles procedural geometry, terrain biomes, SDFs, and architectural landmarks with Apple Clang, streaming binary .glb chunks into the Three.js viewport.';
                suggestedNativeAction = {
                    primitiveType: '3d-scene',
                    serviceOrTool: 'NativeCppCompilerService & LongRunning3DGeneratorAgent',
                    details: 'Synthesize world_generator.cpp, compile via Clang, and stream binary .glb into 3d-scene primitive.'
                };
            }
        } else if (domain === 'generative') {
            const isGooglePanoramaOrInpaint = /360\s*panorama|4k\s*panorama|monumental\s*panorama|equirectangular|seam\s*heal|nadir|zenith|polar\s*pinch|panorama_heal_seam|panorama_inpaint|panorama_generate_360|panorama_reproject_zenith|panorama_generate_4k/i.test(lower) ||
                ((lower.includes('inpaint') || lower.includes('seam') || lower.includes('zenith')) && (lower.includes('google') || lower.includes('imagen') || lower.includes('panorama') || lower.includes('360')));

            if (isGooglePanoramaOrInpaint) {
                canSolveNatively = true;
                primaryNativeEngine = 'google-models';
                nativeCapabilities.push('Google Vertex AI / Imagen 3 Panorama Seam Healing (Google360PanoramaPipelineService)');
                nativeCapabilities.push('4K Monumental 360 Panorama Generator (Google360PanoramaPipelineService.generate4KMonumentalPanorama & panorama_generate_4k)');
                nativeCapabilities.push('Equirectangular 50% Roll & Laplacian 2-Band Seam Equalization');
                nativeCapabilities.push('Google Models Nadir Rig & Floater Inpainting');
                nativeCapabilities.push('Adaptive Two-Pass Zenith Reprojection (Option A 1:1 rectilinear patch inverse gnomonic raycasting)');
                nativeCapabilities.push('Agent Tools (panorama_generate_4k, panorama_heal_seam, panorama_inpaint, panorama_generate_360, panorama_reproject_zenith, panorama_extract_zenith)');
                rationale = 'Native Google 360 Panorama Pipeline Service performs 4K monumental synthesis with Laplacian 2-band seam equalization, clean circle-free polar collapse, equirectangular roll-shift inpainting with Imagen 3 / Gemini, and Option A Zenith Reprojection eliminating polar pinch singularities.';
                suggestedNativeAction = {
                    serviceOrTool: 'panorama_generate_4k or panorama_heal_seam or Google360PanoramaPipelineService',
                    details: 'Invoke panorama_generate_4k, panorama_heal_seam, or panorama_reproject_zenith to seamlessly blend or restore the 360 equirectangular panorama.'
                };
            } else if (isNeuralImageTo3D || isNeuralVideoRestyle || isMonocularNeuralDepth || isLatentDiffusionInpaint || isExplicitComfyRequest) {
                canSolveNatively = false;
                primaryNativeEngine = 'none';
            } else if (/(?:recolor|re-color|grade|re-?grade|texture\s*atlas|material\s*harmoniz|pbr).*(?:3d\s*tile|glb|model|photometry|photogrammetr)|(?:3d\s*tile|glb|texture\s*atlas).*(?:recolor|re-color|grade|re-?grade|palette|foliage\s*protect|pbr)/i.test(lower)) {
                canSolveNatively = true;
                primaryNativeEngine = 'cpp-3d-engine';
                nativeCapabilities.push('Sophisticated 3D Tile Recoloring Engine v2 (GlbTextureRecolorService)');
                nativeCapabilities.push('recolor3DTilesGlb API & google_3d_tiles_recolor_glb Agent Tool');
                nativeCapabilities.push('CIELAB Hue-Aware Semantic Segmentation (Foliage & Asphalt Protection)');
                nativeCapabilities.push('Intrinsic Shadow De-lighting & Crevice Lift');
                nativeCapabilities.push('PBR Normal Map & Metallic-Roughness Synthesis');
                nativeCapabilities.push('100% Geometric Vertex Lock (0.000 mm Drift)');
                rationale = 'Native Sophisticated 3D Tile Recoloring Engine v2 re-grades photogrammetric texture atlases directly in CIELAB, selectively protecting natural foliage and asphalt while synthesizing tactile PBR normal and roughness maps with zero geometric drift.';
                suggestedNativeAction = {
                    primitiveType: '3d-scene',
                    serviceOrTool: 'recolor3DTilesGlb or google_3d_tiles_recolor_glb tool',
                    details: 'Call recolor3DTilesGlb / google_3d_tiles_recolor_glb to re-grade the 3D tile GLB texture atlas and synthesize PBR maps.'
                };
            } else if (/color\s*match|grade\s*match|match\s*color|colorist|lift.*gamma.*gain|primary\s*wheels|3d\s*lut.*match/i.test(lower)) {
                canSolveNatively = true;
                primaryNativeEngine = 'code-first';
                nativeCapabilities.push('Hollywood-Grade Color Matching & Grading Engine (ProColorGradeMatchingService)');
                nativeCapabilities.push('Three-Way Primary Color Wheels Inversion (Lift, Gamma, Gain, Offset)');
                nativeCapabilities.push('Bradford Chromatic Adaptation (CAT02) & Vectorscope Skin Tone Line Protection');
                nativeCapabilities.push('Industry-Standard 3D LUT (.cube) Synthesis & Optical Scopes Metrology (Waveform, RGB Parade, Vectorscope, CIEDE2000)');
                nativeCapabilities.push('pro_color_match_imagery Agent Tool');
                rationale = 'Native ProColorGradeMatchingService analytically matches color grading between imagery using three-way primary color wheels, Bradford white balance, vectorscope skin tone protection, and generates industry-standard 3D LUTs (.cube) with full CIEDE2000 metrology.';
                suggestedNativeAction = {
                    primitiveType: 'live-code-sandbox',
                    serviceOrTool: 'ProColorGradeMatchingService & pro_color_match_imagery tool',
                    details: 'Invoke pro_color_match_imagery or ProColorGradeMatchingService.matchImages to match grading and export 3D LUTs.'
                };
            } else if (/color\s*transfer|extract.*(?:and\s+)?apply.*color|palette\s*(?:transfer|override)|nano\s*banana.*color/i.test(lower)) {
                canSolveNatively = true;
                primaryNativeEngine = 'google-models';
                nativeCapabilities.push('Nano Banana Color Transfer Pipeline (Method 2: Extract-then-Apply)');
                nativeCapabilities.push('NanoBananaColorService (buildExtractPalettePrompt, parseExtractedPalette, buildApplyPalettePrompt)');
                nativeCapabilities.push('nano_banana_transfer_color, nano_banana_extract_color_palette & nano_banana_apply_color_palette Agent Tools');
                rationale = 'Native Nano Banana Two-Step Extract-then-Apply color transfer extracts structured palette DNA and lighting atmosphere from a reference image, and applies global color overrides to the target image with strict non-negotiable geometry locking.';
                suggestedNativeAction = {
                    primitiveType: 'markdown-document',
                    serviceOrTool: 'NanoBananaColorService & nano_banana_transfer_color tool',
                    details: 'Invoke nano_banana_transfer_color or nano_banana_extract_color_palette / nano_banana_apply_color_palette to transfer color palette with geometry locking.'
                };
            } else if (/beautif|nano\s*banana.*(?:prompt|location)|buildbeautifyprompt/i.test(lower)) {
                canSolveNatively = true;
                primaryNativeEngine = 'google-models';
                nativeCapabilities.push('AI Beautify Location Pipeline (buildBeautifyPrompt)');
                nativeCapabilities.push('build_beautify_prompt Agent Tool (exact framing & aspect ratio rules)');
                rationale = 'Native AI Beautify Location Pipeline constructs non-negotiable 3D tile framing prompts, preserving exact camera pitch/yaw, vanishing points, horizon line, and canvas aspect ratio for photorealistic restyling.';
                suggestedNativeAction = {
                    primitiveType: 'markdown-document',
                    serviceOrTool: 'buildBeautifyPrompt or build_beautify_prompt tool',
                    details: 'Invoke build_beautify_prompt with locationName, coords, heading, and styleSuffix.'
                };
            } else {
                // If standard text-to-image or multimodal reasoning
                canSolveNatively = true;
                primaryNativeEngine = 'google-models';
                nativeCapabilities.push('Google Gemini 3.7 / 2.5 Multimodal Reasoning');
                nativeCapabilities.push('Imagen Generative Image Synthesis (generate_image)');
                rationale = 'Native Google generative models (Gemini & Imagen) can handle standard text prompts, multimodal image understanding, and 2D asset synthesis.';
                suggestedNativeAction = {
                    serviceOrTool: 'generate_image or Gemini multimodal analysis',
                    details: 'Generate image asset or perform vision analysis natively.'
                };
            }
        } else if (domain === 'code') {
            canSolveNatively = true;
            primaryNativeEngine = 'workspace-coding';
            nativeCapabilities.push('Workspace File Tools (workspace_read_file, workspace_write_file, workspace_apply_diff)');
            nativeCapabilities.push('Workspace Terminal Execution (workspace_run_command)');
            nativeCapabilities.push('LSP Diagnostics & AST Symbol Search');
            nativeCapabilities.push('Gemini 3.7 High Reasoning Pair-Programming');
            rationale = 'Native workspace tools, compiler services, and Gemini code synthesis can read, modify, compile, test, and debug code directly.';
        } else {
            // General
            canSolveNatively = true;
            primaryNativeEngine = 'google-models';
            nativeCapabilities.push('Gemini High Reasoning & Planning');
            nativeCapabilities.push('Canvas Primitives (Document, Kanban, NodeGraph, Sandbox)');
            rationale = 'Standard requests are natively handled by Gemini reasoning and canvas primitives.';
        }

        // If user explicitly asked for ComfyUI, override canSolveNatively
        if (isExplicitComfyRequest) {
            canSolveNatively = false;
            rationale = 'ComfyUI pipeline generation was explicitly requested or targeted for this workflow.';
        }

        // Tier 2 Fallback Formulation
        let tier2Fallback: Tier2ComfyUiFallback;
        if (!canSolveNatively) {
            let category: ComfyPipelineCategory = 'text-to-image';
            let executionTarget: 'cloud-run' | 'local' | 'auto' = options.targetEnvironment || 'auto';
            const suggestedNodes: string[] = [];
            let requiresDynamicNodes = false;
            const suggestedDynamicClasses: string[] = [];

            if (isNeuralImageTo3D) {
                category = 'image-to-3d';
                executionTarget = options.targetEnvironment || 'cloud-run'; // Heavy 3D offloads to Cloud Run GPU
                if (lower.includes('urban') || lower.includes('tile') || lower.includes('vector') || lower.includes('remesh')) {
                    suggestedNodes.push('TrellisUrbanRemeshNode', 'SaveMesh3D');
                    requiresDynamicNodes = false;
                } else {
                    suggestedNodes.push('LoadImage', 'TrellisImageTo3D', 'MeshDecimatorNode', 'SaveGLB');
                    requiresDynamicNodes = true;
                    suggestedDynamicClasses.push('SaveGLB', 'MeshDecimatorNode');
                }
            } else if (isWan4DAnyoneDiffusionExecution) {
                category = 'video-generation';
                executionTarget = options.targetEnvironment || 'cloud-run'; // Heavy multi-view video offloads to Cloud Run GPU
                suggestedNodes.push(
                    'LoadImage',
                    'Wan22TI2VModelLoader',
                    'SkeletonConditioningNode',
                    'WanMultiViewCameraRigNode',
                    'Wan22MultiViewSampler',
                    'SaveVideo'
                );
                requiresDynamicNodes = true;
                suggestedDynamicClasses.push(
                    'Wan22TI2VModelLoader',
                    'SkeletonConditioningNode',
                    'WanMultiViewCameraRigNode',
                    'Wan22MultiViewSampler'
                );
            } else if (isNeuralVideoRestyle) {
                category = 'video-generation';
                executionTarget = options.targetEnvironment || 'cloud-run'; // Heavy video offloads to Cloud Run GPU
                suggestedNodes.push('LoadVideo', 'AnimateDiffLoader', 'ControlNetApply', 'KSampler', 'SaveVideo');
                requiresDynamicNodes = false;
            } else if (isMonocularNeuralDepth) {
                category = 'depth-estimation';
                executionTarget = options.targetEnvironment || 'auto';
                suggestedNodes.push('LoadImage', 'MarigoldDepthEstimation', 'SaveImage');
                requiresDynamicNodes = false;
            } else if (lower.includes('pbr') || lower.includes('texture')) {
                category = 'pbr-texture-synthesis';
                suggestedNodes.push('LoadImage', 'PBRMaterialComposer', 'SaveImage');
                requiresDynamicNodes = true;
                suggestedDynamicClasses.push('PBRMaterialComposer');
            } else {
                category = 'text-to-image';
                suggestedNodes.push('CheckpointLoaderSimple', 'CLIPTextEncode', 'KSampler', 'VAEDecode', 'SaveImage');
            }

            tier2Fallback = {
                needed: true,
                gapReason: rationale,
                recommendedPipelineCategory: category,
                executionTarget,
                suggestedNodes,
                requiresDynamicNodes,
                suggestedDynamicClasses: suggestedDynamicClasses.length > 0 ? suggestedDynamicClasses : undefined
            };
        } else {
            tier2Fallback = {
                needed: false,
                executionTarget: 'auto',
                suggestedNodes: [],
                requiresDynamicNodes: false
            };
        }

        return {
            taskGoal: goal,
            taskDomain: domain,
            tier1Assessment: {
                canSolveNatively,
                primaryNativeEngine,
                nativeCapabilitiesUsed: nativeCapabilities,
                rationale,
                suggestedNativeAction
            },
            tier2Fallback,
            recommendedResolutionRoute: canSolveNatively ? 'tier1-native' : 'tier2-comfyui',
            tier: canSolveNatively ? 'tier1-native' : 'tier2-comfyui',
            rationale,
            recommendedNativeTool: suggestedNativeAction?.serviceOrTool
        };
    }
}

export function resolveTaskCapability(
    taskGoal: string | { userGoal?: string; goal?: string; promptContext?: string; domainHint?: any },
    options?: CapabilityOptions
): CapabilityResolutionResult {
    return TaskCapabilityResolver.resolveTaskCapability(taskGoal, options);
}

