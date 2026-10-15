/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/


export type TaskDomain = '3d' | 'vfx' | 'generative' | 'code' | 'general' | (string & {});

export type PrimaryNativeEngine =
    | 'cpp-3d-engine'
    | 'python-3d-engine'
    | 'threejs-webgl'
    | 'vfx-matchmove-nle'
    | 'adaptive-matchmove-calibration'
    | 'google-models'
    | 'workspace-coding'
    | 'code-first'
    | 'skills'
    | 'none'
    | (string & {});

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
        targetTool?: string;
        targetService?: string;
        details?: string;
    };
}

export interface CapabilityResolutionResult {
    /** The evaluated task goal or prompt. */
    taskGoal: string;
    /** Primary domain classification. */
    taskDomain: TaskDomain;
    /** Evaluation of what the app can do currently via coding, pipelines, skills, and Google models. */
    tier1Assessment: Tier1Assessment;
    canSolveNatively: boolean;
    primaryNativeEngine?: PrimaryNativeEngine;
    nativeCapabilities?: string[];
    suggestedNativeAction?: Tier1Assessment['suggestedNativeAction'];
    /** Convenience alias for tier1Assessment.rationale */
    rationale?: string;
    /** Convenience alias for recommended native tool */
    recommendedNativeTool?: string;
}

export type TaskCapabilityResult = CapabilityResolutionResult;

export interface CapabilityOptions {
    domainHint?: TaskDomain | 'auto';
    promptContext?: string;
    userGoal?: string;
    goal?: string;
    hasInputImage?: boolean;
    hasInputVideo?: boolean;
    hasCameraTrack?: boolean;
    activeArtifact?: any;
}

export class TaskCapabilityResolver {
    /**
     * Classifies the primary domain of a task goal.
     */
    static classifyTaskDomain(taskGoal: string, options?: CapabilityOptions): TaskDomain {
        const lower = (taskGoal || '').toLowerCase();

        // Generative Diffusion / Neural (Check first so neural diffusion doesn't get masked by generic mesh/video keywords)
        if (
            /\b(?:diffusion|lora|checkpoint|latent|controlnet|trellis|triposr|marigold|depth-anything|animatediff|omni\s*restyle|svd|cogvideo|wan2\.[12]|inpaint|outpaint|image-to-3d|video-to-video|color\s*transfer|palette|nano\s*banana)\b/i.test(lower)
        ) {
            return 'generative';
        }

        // VFX & Video
        if (
            /vfx|visual\s*effects|matchmove|camera\s*solve|keyframe\s*calibrat|camera\s*track|ephemeris|solar\s*position|holdout|occlusion\s*matte|nle|video\s*timeline|clip\s*split|ripple\s*delete|audio\s*track|b-roll/i.test(lower)
        ) {
            return 'vfx';
        }

        // 3D & XR (Adaptive Domain Architecture: Physical/Spatial Synthesis & Dimensional Representations)
        // 1. Explicit 3D representations, rendering engines, and geospatial/optical formats:
        const hasExplicit3DTerms = /3d|mesh|geometry|sdf|marching\s*cubes|terrain|biome|glb|gltf|three\.js|webgl|c\+\+|clang|polygon|voxel|photorealistic\s*3d\s*tiles|cesium|quad\s*remesh|utdra|uldra|tile|void\s*carv|bridge\s*void|underpass|webxr|geospatial\s*anchor|arcore|resect(?:ion)?|geobox|image\s*location|optical\s*center|edge\s*overlap|sub-?pixel|solvepnp|pnp|feature\s*match|point\s*correspondence|lens\s*distortion|barrel\s*distortion|pincushion|chromatic\s*aberration|optical\s*lens|lens\s*shader|anamorphic\s*squeeze|atmosphere|lighting|rayleigh|mie|scattering|turbidity|sky\s*dome|aerial\s*perspective|god\s*rays|diurnal|kelvin|cloud\s*shadow|uv|unwrap|rewrap|pbr|cavitation|texture\s*atlas|splat|gaussian|3dgs|radiance\s*field|blender|\b(?:stage|staging|plinth|pedestal|cyclorama|curved\s*cove|hero\s*staging|vector\s*world|vector\s*tile|population\s*staging)\b/i.test(lower);

        if (hasExplicit3DTerms) {
            return '3d';
        }

        // 2. Open-Domain Spatial Synthesis (ADA):
        // Detect dimensional fabrication verbs operating on structural/spatial envelopes or physical materials
        // rather than closed taxonomies of specific human or alien architectural nouns.
        const hasSpatialVerb = /\b(model|sculpt|extrude|carve|mesh|construct|build|render|synthesize|assemble|fabricate|shape|forge|procedural\w*|create|generate|design|place|stage|situate|anchor|ground|relocate|position)\b/i.test(lower);
        const hasSpatialEntity = /\b(scene|structure|building|tower|facility|station|habitat|outpost|compound|terminal|pavilion|monument|landmark|hall|chamber|room|corridor|interior|exterior|facade|roof|roofs|mansard|window|windows|column|columns|wall|floor|foundation|elevation|canopy|foliage|tree|trees|vegetation|landscape|terrain|topograph\w*|monolith|cavern|subterranean|orbital|fenestration|cantilever|spatial|biome|space[- ]colonization|beach|plinth|pedestal|cyclorama|cove|boardwalk|stage|world|district)\b/i.test(lower);
        const hasPhysicalMaterial = /\b(stone|wood|timber|marble|granite|basalt|obsidian|metal|steel|iron|concrete|ferroconcrete|glass|brick|clay|foliage|water|sand|rock|ice|snow)\b/i.test(lower);

        if (hasSpatialVerb && (hasSpatialEntity || hasPhysicalMaterial)) {
            return '3d';
        }

        // Code / Programming
        if (
            /\bcode\b|function|\bclass\b|typescript|refactor|compile|\bbuild\b|\btest\b|debug|lint|diagnostics|git|api\s*endpoint|fastapi/i.test(lower)
        ) {
            return 'code';
        }

        if (options?.activeArtifact?.type === '3d-scene' && !/document|doc\b|spec|write\s+(?:a\s+)?(?:doc|document|spec|essay|report|paper)|article/i.test(lower)) {
            return '3d';
        }

        return 'general';
    }

    /**
     * Resolves which native subsystem (C++20 3D engine, Python engine, VFX/NLE, Google models, workspace tools) handles a task,
     * or reports that the task is not natively supported (e.g. neural image-to-3D, video restyling, monocular depth).
     */
    static resolveTaskCapability(
        taskGoal: string | CapabilityOptions,
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
        let domain = (opts.domainHint && opts.domainHint !== 'auto')
            ? opts.domainHint
            : this.classifyTaskDomain(goal, opts);

        if (domain === 'general' && opts.activeArtifact?.type === '3d-scene' && !/document|doc\b|spec|write\s+(?:a\s+)?(?:doc|document|spec|essay|report|paper)|article/i.test(lower)) {
            domain = '3d';
        }

        // Check for specific neural/generative triggers that exceed native algorithmic and Google model capabilities.
        // Trellis can be used to create discrete objects/props in a scene, but scenes themselves are created in codebase.
        const isSceneOrEnvironment = /scene|urban|city|district|world|environment|street|layout|architecture|building|floorplan|landscape|terrain/i.test(lower);

        const isAnalyticalGroomSplat = /groom|hair\s*strand|fur(?:ry)?(?:\s+(?:creature|star|sphere|monster|animal|surface))?|biophysical\s*(?:hair|groom)|volumetric\s*fur|analytical\s*splat|splat[\s\w-]{0,30}groom|harmonic\s*(?:star|creature)|marschner/i.test(lower);

        // Neural image-to-3D runs only when the user names it (AGENTS.md); object requests go to the model's own choice.
        const isLocalSf3DOrganicProp = /\b(?:sf3d|stable[\s-]fast[\s-]3d)\b/i.test(lower);

        const isNeuralImageTo3D = !isAnalyticalGroomSplat && !isLocalSf3DOrganicProp && !isSceneOrEnvironment && ((/image-to-3d|photo\s+to\s+3d|picture\s+to\s+mesh|2d\s+to\s+3d|trellis|triposr|sv3d|crm|hunyuan3d/i.test(lower) &&
            !/point\s*correspondence|keypoint|pnp|solvepnp|feature\s*match|optical\s*center|resect/i.test(lower)) ||
            ((lower.includes('image') || lower.includes('photo') || options.hasInputImage) && (lower.includes('reconstruct 3d') || lower.includes('generate 3d mesh') || lower.includes('convert to 3d mesh'))));

        const isNeuralVideoRestyle = /video-to-video|restyle\s+video|neural\s+video|animatediff|omni\s*restyle|temporal\s+restyl|video\s+style\s+transfer/i.test(lower) ||
            ((lower.includes('video') || options.hasInputVideo) && (lower.includes('restyle') || lower.includes('stylize video') || lower.includes('anime style') || lower.includes('cyberpunk restyle')));

        const isMonocularNeuralDepth = /monocular\s+depth|depth\s+estimation|marigold|depth-anything|zoedepth|dense\s+depth\s+map/i.test(lower) &&
            !lower.includes('camera solve') && !lower.includes('tracking marker');

        const isLatentDiffusionInpaint = /latent\s+inpaint|controlnet|stable\s+diffusion|sdxl|flux|lora\s+inpaint/i.test(lower);

        // Check if Tier 1 can natively solve this
        let canSolveNatively = true;
        let primaryNativeEngine: PrimaryNativeEngine = 'workspace-coding';
        const nativeCapabilities: string[] = [];
        let rationale = '';
        let suggestedNativeAction: Tier1Assessment['suggestedNativeAction'] | undefined;

        const isAdaptiveMatchmove = /adaptive\s*matchmove|calibrat\w*[\s\w-]{0,60}keyframe|keyframe[\s\w-]{0,60}calibrat|matchmove[\s\w-]{0,60}calibrat|calibrat[\s\w-]{0,60}matchmove|bundle\s*adjust|camera\s*track|6-?dof\s*resect|hermite\s*spline/i.test(lower);

        const isFrameMotivatedPerformerPrompt =
            /build_?frame_?motivated_?performer_?prompt|buildframemotivatedperformerprompt|frame\s*motivated[\s\w-]{0,40}(?:prompt|video)|motivated\s*by\s*the\s*frame[\s\w-]{0,40}(?:prompt|format)|format[\s\w-]{0,40}motivated\s*by/i.test(lower) ||
            (opts.promptContext ? /buildframemotivatedperformerprompt|frame_?motivated/i.test(opts.promptContext) : false);

        const isWanMultiviewDiffusionExecution =
            (/wan2\.2|multiview\s*(?:video|diffusion)|all\s*(?:the\s*)?different\s*video\s*positions/i.test(lower) &&
            /video\s*model|capture|diffusion|generate|run/i.test(lower) &&
            !/prompt\s*only|format\s*prompt|text\s*only|author/i.test(lower)) ||
            (opts.promptContext ? /wan2\.2/i.test(opts.promptContext) && !/prompt/i.test(lower) : false);

        const isNeutralPerformerPrompt = /buildneutralperformerprompt|neutral[\s\w-]{0,40}(?:prompt|video|image|portrait|performer|avatar)|(?:performer|avatar|character|dancer|vocalist)[\s\w-]{0,40}(?:neutral|a[\s-]frame|prompt)|(?:prompt|video|image)[\s\w-]{0,40}(?:neutral|a[\s-]frame)|a[\s-]frame/i.test(lower);

        const hasSplatKeyword = /(?:gaussian\s*splats?|3dgs|\bsplats?\b|radiance\s*fields?)/i.test(lower);
        // Steered to the location pipeline only when the request says it is about a real place in general terms.
        // Whether a named subject ("the Colosseum", "my cat") is a place is the model's call: no list of place names
        // or building nouns, and no "splat of <anything>" pattern. location_generate_3dgs is offered either way.
        const hasRealWorldIntent = /\b(?:locations?|landmarks?|real[- ]world|geographic(?:al)?|geodetic|surveys?|beautify|nano\s*banana|restyl\w*|google\s*3d\s*tiles?)\b/i.test(lower);
        const isLocationSplat = !isAnalyticalGroomSplat && hasSplatKeyword && hasRealWorldIntent;

        if (isWanMultiviewDiffusionExecution) {
            canSolveNatively = false;
            primaryNativeEngine = 'none';
            rationale = 'Multi-view video diffusion (Wan2.2-TI2V-5B) is not natively supported: it requires a self-hosted GPU video diffusion backbone that this app does not run.';
        } else if (isLocationSplat) {
            canSolveNatively = true;
            primaryNativeEngine = 'cpp-3d-engine';
            nativeCapabilities.push('Closed-Loop Survey-to-Splat Reconstruction Pipeline (SurveySplatPipelineService)');
            nativeCapabilities.push('Adaptive Scene-Aware Rig & Station Placement (AdaptiveSurveyRigService / plan_adaptive_survey_rig)');
            nativeCapabilities.push('Google 3D Tiles Grounded Mesh Ingestion & Camera Station Synthesis (SurveySynthesisEngine)');
            nativeCapabilities.push('AI Beautify Location Pipeline & Nano Banana Multi-View Restyling (BeautifyStationService)');
            nativeCapabilities.push('Native C++20 Depth-to-Gaussian Unprojection & Spatial Voxel-Hash Fusion (station_to_splats.cpp)');
            nativeCapabilities.push('OGC 3D Tiles 1.1 Packaging (KHR_gaussian_splatting & Niantic SPZ v2)');
            nativeCapabilities.push('PhotorealGaussianSplatMesh Interactive Viewport Rendering (2D EWA Screen-Space Covariance)');
            nativeCapabilities.push('Location 3D Gaussian Splatting Service (Location3DGaussianSplatService / Location3DGSService)');
            nativeCapabilities.push('In-App Agent Tools: location_generate_3dgs, plan_adaptive_survey_rig, survey_beautify_to_splats, splat_to_3dtiles, panorama_to_3dgs');
            rationale = 'Native Closed-Loop Survey-to-Splat Reconstruction Pipeline automatically assumes and executes our Nano Banana multi-view restyling pipeline without requiring the user to invoke or mention Nano Banana explicitly: renders pose-exact blockouts from Google 3D Tiles, restyles camera viewpoints using Nano Banana / Gemini image models with sub-pixel edge QC and chained forward-warp consistency, unprojects them onto metric depth using C++20 station_to_splats, and streams photorealistic Gaussian splats directly into the 3D viewport.';
            suggestedNativeAction = {
                primitiveType: '3d-scene',
                serviceOrTool: 'location_generate_3dgs or Location3DGaussianSplatService',
                targetTool: 'location_generate_3dgs',
                targetService: 'Location3DGaussianSplatService',
                details: 'Invoke location_generate_3dgs or generateLocation3DGS to autonomously synthesize a high-fidelity 3D Gaussian Splatting scene of the location and mount it into the 3D viewport.'
            };
        } else if (isFrameMotivatedPerformerPrompt) {
            canSolveNatively = true;
            primaryNativeEngine = 'google-models';
            nativeCapabilities.push('Frame-Motivated Performer Video Prompt Pipeline (buildFrameMotivatedPerformerVideoPrompt)');
            nativeCapabilities.push('build_frame_motivated_performer_prompt Agent Tool (<FIRST_FRAME> Syntax, A-Pose Invariant, Multi-View Video Positions)');
            nativeCapabilities.push('Google Veo 2 / Wan2.2 conditioning tags & A-pose continuity');
            rationale = 'Native Frame-Motivated Performer Video Prompt Pipeline formulates exact <FIRST_FRAME> conditioning, A-pose continuity clauses, camera viewpoint angles (0°, 45°, 180°), and prompt neutrality rules.';
            suggestedNativeAction = {
                primitiveType: 'markdown-document',
                serviceOrTool: 'build_frame_motivated_performer_prompt',
                targetTool: 'build_frame_motivated_performer_prompt',
                targetService: 'FrameMotivatedPerformerService',
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
                targetTool: 'build_neutral_performer_prompt',
                targetService: 'NeutralPerformerStudioService',
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
                rationale = 'Not natively supported: neural video restyling / temporal diffusion (e.g. AnimateDiff) cannot be computed by the native Video NLE timeline or VFX plate matchmove services.';
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
                    targetTool: 'adaptive_matchmove_calibrate_sequence',
                    targetService: 'AdaptiveMatchmoveCalibrationService',
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
                    targetTool: 'vfx_solve_matchmove',
                    targetService: 'VfxPlateMatchmoveService',
                    details: 'Mount video-timeline with cameraSolveTrack and ephemerisAnchor.'
                };
            } else if (/universal\s*animation|continuous\s*(?:time\s*)?animation|keyframe\s*diamonds?|camera\s*arc\s*animation|slerp\s*camera/i.test(lower)) {
                canSolveNatively = true;
                primaryNativeEngine = 'vfx-matchmove-nle';
                nativeCapabilities.push('Universal Continuous-Time Animation Engine (UniversalAnimationClip, LERP/SLERP)');
                nativeCapabilities.push('Video Timeline NLE Integration (toTimelineElement, VideoTimelineTracks Keyframe Diamonds)');
                nativeCapabilities.push('In-App Agent Tools: universal_3d_structure_animate');
                rationale = 'Native Universal Continuous-Time Animation Engine interpolates sub-frame LERP and SLERP tracks and unifies them directly with the Video Timeline NLE primitive via keyframe diamond markers.';
                suggestedNativeAction = {
                    primitiveType: 'video-timeline',
                    serviceOrTool: 'universal_3d_structure_animate',
                    targetTool: 'universal_3d_structure_animate',
                    targetService: 'Universal3DStructureFoundation',
                    details: 'Invoke universal_3d_structure_animate with mountToVideoTimeline: true to compile keyframe diamonds and mount directly onto video-timeline.'
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
                    targetService: 'VideoTimelineSynthesizer',
                    details: 'Mount video-timeline primitive with custom tracks and holdouts.'
                };
            } else {
                canSolveNatively = true;
                primaryNativeEngine = 'vfx-matchmove-nle';
                nativeCapabilities.push('Video NLE Pipeline');
                rationale = 'Native video timeline and VFX plate services can orchestrate video elements, 3D layers, and audio tracks.';
            }
        } else if (domain === '3d') {
            if (isAnalyticalGroomSplat) {
                canSolveNatively = true;
                primaryNativeEngine = 'cpp-3d-engine';
                nativeCapabilities.push('Native C++20 Astro Hair & Biophysical Grooming Engine (scratchbox_hair.hpp)');
                nativeCapabilities.push('Analytical Forward 3D Gaussian Splatting & Niantic SPZ v2 Exporter (scratchbox_spz.hpp)');
                nativeCapabilities.push('Continuous Spherical Harmonic Surface Synthesis (Harmonic Radial Modes, Axial Taper)');
                nativeCapabilities.push('Biophysical Morphology (Voronoi Clumping, Helical Curl, Wave Noise)');
                nativeCapabilities.push('Marschner Melanin Albedo Pigmentation (Eumelanin / Pheomelanin)');
                nativeCapabilities.push('In-App Agent Tool: splat_synthesize_analytical_groom');
                rationale = 'Native Scratchbox C++20 Astro hair engine synthesizes biophysical hair strands, Voronoi clumping, and procedural curl noise, then analytically forward-projects them into anisotropic 3D Gaussian Splats (.spz / .ply / .glb) in milliseconds without slow inverse training or external tools.';
                suggestedNativeAction = {
                    primitiveType: '3d-scene',
                    serviceOrTool: 'splat_synthesize_analytical_groom or AnalyticalGroomSplatService',
                    targetTool: 'splat_synthesize_analytical_groom',
                    targetService: 'AnalyticalGroomSplatService',
                    details: 'Invoke splat_synthesize_analytical_groom with continuous dimensional parameters (harmonic frequencies, amplitudes, grooming dimensions) to stream binary SPZ directly into 3d-scene.'
                };
            } else if (isLocalSf3DOrganicProp) {
                canSolveNatively = true;
                primaryNativeEngine = 'python-3d-engine';
                nativeCapabilities.push('Local Stable Fast 3D Organic Prop Engine (LocalSf3DService)');
                nativeCapabilities.push('Fast no_pbr 18% Studio Grey Clay Geometry Extraction (< 500ms)');
                nativeCapabilities.push('Metric Physical Grounding & Contact Plane Snapping (targetScaleMeters, groundCut)');
                nativeCapabilities.push('In-App Agent Tool: generate_local_sf3d_organic_prop');
                rationale = 'Native Local SF3D Service executes local Stable Fast 3D inference directly on desktop (Apple Silicon Metal/MPS, CUDA, or CPU) in < 500ms with dedicated no_pbr mode, bypassing UV unwrapping and neural texture baking to produce 18% Studio Grey Clay geometry with metric scale grounding and flat contact planes.';
                suggestedNativeAction = {
                    primitiveType: '3d-scene',
                    serviceOrTool: 'generate_local_sf3d_organic_prop or LocalSf3DService',
                    targetTool: 'generate_local_sf3d_organic_prop',
                    targetService: 'LocalSf3DService',
                    details: 'Invoke generate_local_sf3d_organic_prop with imagePath, noPbr=true, and targetScaleMeters to synthesize a local organic 3D prop and mount it into the 3d-scene stage.'
                };
            } else if (isNeuralImageTo3D) {
                canSolveNatively = false;
                primaryNativeEngine = 'none';
                rationale = 'Not natively supported: single-image to 3D mesh reconstruction needs a neural diffusion model (e.g. Trellis / TripoSR). 3D scenes, environments, and architecture are generated natively by the C++20 / Python engines.';
            } else if (/universal\s*3d\s*structure|canonical\s*3d\s*(?:anchor|foundation)|single\s*source\s*of\s*truth\s*3d|multi-?format\s*(?:3d|projection)|collision\s*(?:envelope|hull)|convex\s*bumper\s*hull|universal\s*animation|continuous\s*(?:time\s*)?animation|keyframe\s*diamonds?|animation[\s\w-]{0,30}(?:timeline|nle)|(?:export|project)\s*(?:to\s*)?(?:colmap|nerfstudio|3dgs)/i.test(lower)) {
                canSolveNatively = true;
                primaryNativeEngine = 'cpp-3d-engine';
                nativeCapabilities.push('Universal 3D Structure Foundation (Universal3DStructureFoundation)');
                nativeCapabilities.push('Universal Continuous-Time Animation Engine (UniversalAnimationClip, LERP/SLERP)');
                nativeCapabilities.push('Deterministic Outward Projections (glTF 2.0 with Animation Chunks, COLMAP, Nerfstudio 3DGS, Video Camera Blockout, Collision Hull, GeoJSON)');
                nativeCapabilities.push('Physics Collision Envelope (AABB, Bounding Sphere, Simplified Convex Bumper Hull)');
                nativeCapabilities.push('Video Timeline NLE Integration (toTimelineElement, VideoTimelineTracks Keyframe Diamonds)');
                nativeCapabilities.push('In-App Agent Tools: universal_3d_structure_create, universal_3d_structure_export, universal_3d_structure_animate, universal_3d_structure_get_collision_hull');
                rationale = 'Native Universal 3D Structure Foundation maintains a single authoritative geometric anchor across solid meshes, 3DGS point constellations, 6-DoF cameras, physics collision envelopes, continuous animation tracks, and WGS-84 coordinates, with deterministic outward projections and NLE video timeline synchronization.';
                suggestedNativeAction = {
                    primitiveType: '3d-scene',
                    serviceOrTool: 'universal_3d_structure_create or universal_3d_structure_export',
                    targetTool: 'universal_3d_structure_create',
                    targetService: 'Universal3DStructureFoundation',
                    details: 'Invoke universal_3d_structure_create to instantiate canonical anchor, export outward to target format(s), or animate with universal_3d_structure_animate and mount to video-timeline.'
                };
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
                    targetTool: 'adaptive_matchmove_calibrate_sequence',
                    targetService: 'AdaptiveMatchmoveCalibrationService',
                    details: 'Calibrate sequence milestones, optimize Brown-Conrady lens breathing, and synthesize continuous C2 Hermite camera trajectory.'
                };
            } else if (/reshape|deform|taper|twist|bend|bulge|squash|shear|sculpt[\s\w-]{0,30}mesh|mesh[\s\w-]{0,30}shaping|lattice[\s\w-]{0,30}deform/i.test(lower)) {
                canSolveNatively = true;
                primaryNativeEngine = 'cpp-3d-engine';
                nativeCapabilities.push('Native C++20 Astro Mesh Reshaper Engine (scratchbox_shaper.hpp)');
                nativeCapabilities.push('NativeMeshReshaperService / MeshReshapingService');
                nativeCapabilities.push('Parametric Non-Linear Deformers (Taper, Twist, Bend, Bulge, Shear) with parameters relative to the mesh bounds');
                nativeCapabilities.push('Trivariate Bernstein FFD 3D Tensor Lattice (Lattice3D)');
                nativeCapabilities.push('Multi-Brush Digital Sculpt Engine (Clay, Crease, Smooth, Flatten, Inflate)');
                nativeCapabilities.push('Loop Subdivision & Manifold Topology Repair');
                nativeCapabilities.push('In-App Agent Tool: mesh_apply_deformers (explicit operations on a given GLB)');
                rationale = 'Native Scratchbox C++20 Astro 3D engine executes sub-second parametric deformers, Bernstein FFD lattices, sculpt strokes, and loop subdivision directly on meshes, compiling via Apple Clang with zero external dependencies.';
                suggestedNativeAction = {
                    primitiveType: '3d-scene',
                    serviceOrTool: 'mesh_apply_deformers or NativeMeshReshaperService',
                    targetTool: 'mesh_apply_deformers',
                    targetService: 'NativeMeshReshaperService',
                    details: 'Turn the request into explicit operations (values relative to the mesh bounding box) and call mesh_apply_deformers on the given GLB; stream the binary .glb into 3d-scene.'
                };
            } else if (/utdra|uldra|tile\s*decomposition|rectif(?:y|ication)|bridge\s*void|underpass\s*void|sutherland\s*-?\s*hodgman|slope\s*stratified|domain\s*probe/i.test(lower)) {
                canSolveNatively = true;
                primaryNativeEngine = 'cpp-3d-engine';
                nativeCapabilities.push('UniversalTileDecompositionService / UtdraService / UldraService (UTDRA / ULDRA)');
                nativeCapabilities.push('Tile measurements: bounds, relief, area by slope band, wall orientation (no classification)');
                nativeCapabilities.push('Sutherland-Hodgman elevation slicer and a span-box curtain-wall carver');
                nativeCapabilities.push('C++20 Native Pipeline (run_utdra_pipeline)');
                rationale = 'Native C++20 UTDRA pipeline measures a given tile, keeps what lies above an elevation, or removes the near-vertical triangles inside a span box the caller gives; it reports what it measured and removed, and classifies nothing.';
                suggestedNativeAction = {
                    primitiveType: '3d-scene',
                    serviceOrTool: 'utdra_probe_tile, utdra_slice_elevation or utdra_carve_bridge_voids',
                    targetTool: 'utdra_probe_tile',
                    targetService: 'UniversalTileDecompositionService',
                    details: 'Call utdra_probe_tile on the given GLB to measure it; slice with utdra_slice_elevation (an elevation) or carve with utdra_carve_bridge_voids (a span box in the tile\'s coordinates).'
                };
            } else if (/beautif|nano\s*banana[\s\w-]{0,30}(?:prompt|location)|buildbeautifyprompt/i.test(lower)) {
                canSolveNatively = true;
                primaryNativeEngine = 'google-models';
                nativeCapabilities.push('AI Beautify Location Pipeline (buildBeautifyPrompt)');
                nativeCapabilities.push('build_beautify_prompt Agent Tool (exact framing & aspect ratio rules)');
                nativeCapabilities.push('Google 3D Tiles Vantage Alignment');
                rationale = 'Native AI Beautify Location Pipeline constructs non-negotiable 3D tile framing prompts, preserving exact camera pitch/yaw, vanishing points, horizon line, and canvas aspect ratio for photorealistic restyling.';
                suggestedNativeAction = {
                    primitiveType: 'markdown-document',
                    serviceOrTool: 'buildBeautifyPrompt or build_beautify_prompt tool',
                    targetTool: 'build_beautify_prompt',
                    targetService: 'BeautifyStationService',
                    details: 'Invoke build_beautify_prompt with locationName, coords, heading, and styleSuffix.'
                };
            } else if (/algorithmic\s*uv|unwrap[\s\w-]{0,30}rewrap|rewrap[\s\w-]{0,30}unwrap|uv\s*(?:unwrap|re-?wrap|parameteriz|atlas\s*pack|maxrects)|cavitation\s*pore|calcite\s*strata|pbr\s*material\s*decompos|conformal\s*reparameteriz/i.test(lower)) {
                canSolveNatively = true;
                primaryNativeEngine = 'cpp-3d-engine';
                nativeCapabilities.push('Algorithmic UV Unwrap & Rewrap Engine (AlgorithmicUvEngine)');
                nativeCapabilities.push('Native C++20 Astro UV Acceleration (scratchbox_uv_engine.hpp)');
                nativeCapabilities.push('MaxRects BSSF Atlas Bin Packing with 90° Chart Rotation (85-92% Fill Density)');
                nativeCapabilities.push('Continuous 2D-to-3D Inverse Barycentric Projection & Analytical Cavitation Synthesis');
                nativeCapabilities.push('Photometric De-Lighting & True PBR Material Suite Decomposition');
                nativeCapabilities.push('Preserve-100-Lock (0.000 mm Vertex Drift) & Conformal Reparameterization Modes');
                nativeCapabilities.push('In-App Agent Tools: algorithmic_uv_unwrap_rewrap, pbr_material_decompose, atlas_maxrects_pack');
                rationale = 'Native C++20 Algorithmic UV Unwrap & Rewrap Engine performs analytical travertine micro-cavitation, calcite bedding strata, MaxRects high-efficiency chart packing, and PBR material suite decomposition with 100% vertex/UV lock option.';
                suggestedNativeAction = {
                    primitiveType: '3d-scene',
                    serviceOrTool: 'AlgorithmicUvEngine.processGlb or algorithmic_uv_unwrap_rewrap tool',
                    targetTool: 'algorithmic_uv_unwrap_rewrap',
                    targetService: 'AlgorithmicUvEngine',
                    details: 'Invoke algorithmic_uv_unwrap_rewrap to enhance 3D model textures and stream binary .glb into 3d-scene primitive.'
                };
            } else if (/(?:recolor|re-color|grade|re-?grade|texture\s*atlas|material\s*harmoniz|pbr)[\s\w-]{0,40}(?:3d\s*tile|glb|model|photometry|photogrammetr)|(?:3d\s*tile|glb|texture\s*atlas)[\s\w-]{0,40}(?:recolor|re-color|grade|re-?grade|palette|foliage\s*protect|pbr)/i.test(lower)) {
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
                    targetTool: 'google_3d_tiles_recolor_glb',
                    targetService: 'GlbTextureRecolorService',
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
                    targetTool: 'google_3d_tiles_get_full_texture',
                    targetService: 'Google3DTileService',
                    details: 'Call google_3d_tiles_get_full_texture / google_3d_tiles_get_clay to ingest high-fidelity 3D object, then mount to 3d-scene.'
                };
            } else if (/webxr|geospatial\s*anchor|arcore|gps\s*(?:to|<->|alignment|metric)|metric\s*space\s*alignment|sensor\s*fusion\s*calibration|optical\s*pin\s*calibration|project\s*(?:road|parcel)[\s\w-]{0,40}webxr/i.test(lower)) {
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
                    targetTool: 'webxr_align_geospatial',
                    targetService: 'WebXRGeospatialAnchorBridge',
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
                    targetTool: 'optics_configure_lens_distortion',
                    targetService: 'LensDistortionEffect',
                    details: 'Instantiate LensDistortionEffect, apply optical profile or calculate focal coefficients, and chain into post-processing pipeline.'
                };
            } else if (/geobox|resection|optical\s*center|camera\s*resection|edge\s*overlap|sub-?pixel\s*(?:edge|alignment)|brown-?conrady|image\s*location|localize\s*photo|solvepnp|pnp|2d-to-3d|feature\s*match|pose\s*estimation/i.test(lower)) {
                canSolveNatively = true;
                primaryNativeEngine = 'threejs-webgl';
                nativeCapabilities.push('Spatial Pose Estimator (SpatialPoseEstimatorService.solvePnP, solvePnPRansac)');
                nativeCapabilities.push('Visual Feature Matcher (VisualFeatureMatcherService, Harris/FAST, 128-D descriptors, Lowe ratio)');
                nativeCapabilities.push('Headless Mesh Silhouette & Edge Renderer (HeadlessMeshSilhouetteRenderer, binary .glb loading)');
                nativeCapabilities.push('Closed-Loop Edge Alignment (SubPixelEdgeAlignmentOptimizer: refines a camera pose against a given photo and model, reports the edge correlation it measured)');
                nativeCapabilities.push('GeoBox Precision Resection Service (GeoBoxPrecisionResectionService)');
                nativeCapabilities.push('Brown-Conrady Lens Calibration (k1, k2, p1, p2, chromatic aberration)');
                nativeCapabilities.push('spatial_solve_pnp, spatial_match_features_2d_3d, spatial_closed_loop_edge_align, geobox_resect_image_location Tools');
                rationale = 'Native Spatial Pose Estimation and GeoBox resection pipeline calculates exact analytical 6-DOF camera poses via solvePnP/DLT/Levenberg-Marquardt from 2D-to-3D feature matches, with pure Node.js headless silhouette rasterization and closed-loop edge alignment that refines the pose against the photo and reports the edge correlation it measured (it certifies no overlap it did not reach).';
                suggestedNativeAction = {
                    primitiveType: '3d-scene',
                    serviceOrTool: 'GeoBoxPrecisionResectionService / SpatialPoseEstimatorService (spatial_solve_pnp / geobox_resect_image_location)',
                    targetTool: 'spatial_solve_pnp',
                    targetService: 'GeoBoxPrecisionResectionService',
                    details: 'Invoke spatial_solve_pnp, spatial_match_features_2d_3d, or geobox_resect_image_location to resect photo vantage point and lock camera pose.'
                };
            } else if (/atmosphere|lighting|rayleigh|mie|scattering|turbidity|sky\s*dome|aerial\s*perspective|god\s*rays|diurnal|kelvin|cloud\s*shadow|match\s*lighting|de-?light|delighting|harmonize\s*lighting|lighting[\s\w-]{0,30}3d\s*object|portal\s*fixture|window\s*(?:illumination|backlight)|gaffer|rembrandt|butterfly|film\s*noir|cinematic\s*light|photographic\s*light|key-?to-?fill|inverse\s*light/i.test(lower)) {
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
                nativeCapabilities.push('Agent Tools (lighting_estimate_from_photo, lighting_configure_gaffer_rig, geobox_harmonize_location_lighting)');
                rationale = 'Native LightingGafferService and InverseLightingEstimatorService provide photographic gaffer reasoning (Rembrandt, Split, Butterfly), beam modifiers and inverse photo estimation directly in Tier 1.';
                suggestedNativeAction = {
                    primitiveType: '3d-scene',
                    serviceOrTool: 'LocationObjectLightingService & geobox_harmonize_location_lighting / LightingGafferService / lighting_* tools',
                    targetTool: 'geobox_harmonize_location_lighting',
                    targetService: 'LocationObjectLightingService',
                    details: 'Invoke lighting_estimate_from_photo to read the lighting from a photo, or lighting_configure_gaffer_rig to build a rig.'
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
                    targetTool: 'panorama_generate_4k',
                    targetService: 'Google360PanoramaPipelineService',
                    details: 'Invoke panorama_generate_4k, panorama_heal_seam, panorama_reproject_zenith, or panorama_inpaint to synthesize seamless equirectangular environment skyboxes.'
                };
            } else if (/python|blender|script|procedural\s*building|mansard|pedestal|space\s*colonization|botanical\s*tree|ivy|roof\s*type|execute_3d_python_script/i.test(lower)) {
                canSolveNatively = true;
                primaryNativeEngine = 'python-3d-engine';
                nativeCapabilities.push('Procedural Python 3D Engine (import scratchbox as sb)');
                nativeCapabilities.push('NativePythonRunnerService (/3d/python/run endpoint)');
                nativeCapabilities.push('Blender-Compatible Procedural Scene Graph Mental Model');
                nativeCapabilities.push('Procedural Architecture (sb.create_building, RoofType.MANSARD, HIP, GABLE, FLAT, DOME)');
                nativeCapabilities.push('Botanical Space-Colonization Trees & Ivy Generation (sb.create_tree, sb.create_ivy)');
                nativeCapabilities.push('Studio Pedestals & Custom Geometry (sb.geometry.create_studio_pedestal, sb.Mesh)');
                nativeCapabilities.push('Google Elevation Ground-Truth Topography & Archetype Anchoring');
                nativeCapabilities.push('execute_3d_python_script Gemini Agent Tool');
                nativeCapabilities.push('Streaming Binary glTF 2.0 (.glb) Viewport Integration');
                rationale = 'Native Scratchbox Python 3D engine leverages a Blender-compatible procedural scripting workflow backed by high-performance C++20 nanobind bindings. It synthesizes complex architectural facades, multi-story buildings, mansard roofs, and botanical nature directly into standard binary .glb chunks in under 1 second.';
                suggestedNativeAction = {
                    primitiveType: '3d-scene',
                    serviceOrTool: 'execute_3d_python_script & NativePythonRunnerService (/3d/python/run)',
                    targetTool: 'execute_3d_python_script',
                    targetService: 'NativePythonRunnerService',
                    details: 'Synthesize procedural Python script using import scratchbox as sb, invoke execute_3d_python_script or mount 3d-scene with pythonGenerator, and stream binary .glb into the Three.js canvas.'
                };
            } else {
                // Which 3D tool fits (a place, an object, or a script) is the model's decision under the system
                // instruction's 3D policy, so nothing is suggested here.
                canSolveNatively = true;
                primaryNativeEngine = 'python-3d-engine';
                nativeCapabilities.push('Real-world places: google_3d_tiles_get_clay (geocoded, remeshed Google 3D Tiles in studio grey clay)');
                nativeCapabilities.push('Objects and abstract forms: build_3d_object_from_reference (internal Nano Banana Lite reference, Gemini vision build spec, native Python build in clay)');
                nativeCapabilities.push('Model-written procedural scripts: execute_3d_python_script (import scratchbox as sb)');
                nativeCapabilities.push('Binary glTF 2.0 (.glb) streaming to Three.js viewport');
                rationale = 'Native 3D tools cover places, objects and scripts; the agent picks the one the request calls for.';
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
                    targetTool: 'panorama_generate_4k',
                    targetService: 'Google360PanoramaPipelineService',
                    details: 'Invoke panorama_generate_4k, panorama_heal_seam, or panorama_reproject_zenith to seamlessly blend or restore the 360 equirectangular panorama.'
                };
            } else if (isNeuralImageTo3D || isNeuralVideoRestyle || isMonocularNeuralDepth || isLatentDiffusionInpaint) {
                canSolveNatively = false;
                primaryNativeEngine = 'none';
                rationale = 'Not natively supported: this task needs a self-hosted neural model (image-to-3D, video-to-video restyling, monocular depth, or latent diffusion inpainting) that this app does not run.';
            } else if (/(?:recolor|re-color|grade|re-?grade|texture\s*atlas|material\s*harmoniz|pbr)[\s\w-]{0,40}(?:3d\s*tile|glb|model|photometry|photogrammetr)|(?:3d\s*tile|glb|texture\s*atlas)[\s\w-]{0,40}(?:recolor|re-color|grade|re-?grade|palette|foliage\s*protect|pbr)/i.test(lower)) {
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
                    targetTool: 'google_3d_tiles_recolor_glb',
                    targetService: 'GlbTextureRecolorService',
                    details: 'Call recolor3DTilesGlb / google_3d_tiles_recolor_glb to re-grade the 3D tile GLB texture atlas and synthesize PBR maps.'
                };
            } else if (/color\s*match|grade\s*match|match\s*color|colorist|lift[\s\w-]{0,30}gamma[\s\w-]{0,30}gain|primary\s*wheels|3d\s*lut[\s\w-]{0,30}match/i.test(lower)) {
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
                    targetTool: 'pro_color_match_imagery',
                    targetService: 'ProColorGradeMatchingService',
                    details: 'Invoke pro_color_match_imagery or ProColorGradeMatchingService.matchImages to match grading and export 3D LUTs.'
                };
            } else if (/color\s*transfer|extract[\s\w-]{0,30}(?:and\s+)?apply[\s\w-]{0,30}color|palette\s*(?:transfer|override)|nano\s*banana[\s\w-]{0,30}color/i.test(lower)) {
                canSolveNatively = true;
                primaryNativeEngine = 'google-models';
                nativeCapabilities.push('Nano Banana Color Transfer Pipeline (Method 2: Extract-then-Apply)');
                nativeCapabilities.push('NanoBananaColorService (buildExtractPalettePrompt, parseExtractedPalette, buildApplyPalettePrompt)');
                nativeCapabilities.push('nano_banana_apply_color_palette Agent Tool (geometry-locked color override prompt from a complete palette)');
                rationale = 'Read the palette and lighting atmosphere from the reference image, then nano_banana_apply_color_palette builds the global color override prompt that applies it to the target image with strict non-negotiable geometry locking.';
                suggestedNativeAction = {
                    primitiveType: 'markdown-document',
                    serviceOrTool: 'NanoBananaColorService & nano_banana_apply_color_palette tool',
                    targetTool: 'nano_banana_apply_color_palette',
                    targetService: 'NanoBananaColorService',
                    details: 'Read the reference palette, then invoke nano_banana_apply_color_palette with the complete palette to build the geometry-locked color override prompt.'
                };
            } else if (/beautif|nano\s*banana[\s\w-]{0,30}(?:prompt|location)|buildbeautifyprompt/i.test(lower)) {
                canSolveNatively = true;
                primaryNativeEngine = 'google-models';
                nativeCapabilities.push('AI Beautify Location Pipeline (buildBeautifyPrompt)');
                nativeCapabilities.push('build_beautify_prompt Agent Tool (exact framing & aspect ratio rules)');
                rationale = 'Native AI Beautify Location Pipeline constructs non-negotiable 3D tile framing prompts, preserving exact camera pitch/yaw, vanishing points, horizon line, and canvas aspect ratio for photorealistic restyling.';
                suggestedNativeAction = {
                    primitiveType: 'markdown-document',
                    serviceOrTool: 'buildBeautifyPrompt or build_beautify_prompt tool',
                    targetTool: 'build_beautify_prompt',
                    targetService: 'BeautifyStationService',
                    details: 'Invoke build_beautify_prompt with locationName, coords, heading, and styleSuffix.'
                };
            } else {
                // Text prompts and multimodal understanding; there is no generic image tool to point at, so the
                // model chooses among the tools it is offered.
                canSolveNatively = true;
                primaryNativeEngine = 'google-models';
                nativeCapabilities.push('Google Gemini 3.8 / 2.5 Multimodal Reasoning');
                rationale = 'Native Google models handle text prompts and multimodal image understanding.';
            }
        } else if (domain === 'code') {
            canSolveNatively = true;
            primaryNativeEngine = 'workspace-coding';
            nativeCapabilities.push('Workspace File Tools (workspace_read_file, workspace_write_file, workspace_apply_diff)');
            nativeCapabilities.push('Workspace Terminal Execution (workspace_run_command)');
            nativeCapabilities.push('LSP Diagnostics & AST Symbol Search');
            nativeCapabilities.push('Gemini 3.8 High Reasoning Pair-Programming');
            rationale = 'Native workspace tools, compiler services, and Gemini code synthesis can read, modify, compile, test, and debug code directly.';
        } else {
            // General
            canSolveNatively = true;
            primaryNativeEngine = 'google-models';
            nativeCapabilities.push('Gemini High Reasoning & Planning');
            nativeCapabilities.push('Canvas Primitives (Document, Kanban, NodeGraph, Sandbox)');
            rationale = 'Standard requests are natively handled by Gemini reasoning and canvas primitives.';
        }

        return {
            taskGoal: goal,
            taskDomain: domain,
            canSolveNatively,
            primaryNativeEngine,
            nativeCapabilities,
            suggestedNativeAction,
            tier1Assessment: {
                canSolveNatively,
                primaryNativeEngine,
                nativeCapabilitiesUsed: nativeCapabilities,
                rationale,
                suggestedNativeAction
            },
            rationale,
            recommendedNativeTool: suggestedNativeAction?.serviceOrTool
        };
    }
}

export function resolveTaskCapability(
    taskGoal: string | CapabilityOptions,
    options?: CapabilityOptions
): CapabilityResolutionResult {
    return TaskCapabilityResolver.resolveTaskCapability(taskGoal, options);
}

