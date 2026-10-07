/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/** Display name used when no signed-in profile is available. */
export const DEFAULT_ACTIVE_USER_NAME = 'Scratchbox User';

export function getActiveUserName(customName?: string): string {
    if (customName && customName.trim() && customName.trim() !== 'User') {
        return customName.trim();
    }
    if (typeof window !== 'undefined' && window.localStorage) {
        try {
            const savedProfile = window.localStorage.getItem('sb_user_profile_name');
            if (savedProfile && savedProfile.trim() && savedProfile.trim() !== 'User') {
                return savedProfile.trim();
            }
        } catch (e) {
            // ignore
        }
    }
    return DEFAULT_ACTIVE_USER_NAME;
}

import type { VideoTimelineData, TimelineTrack } from './services/video/videoTypes';
export type { VideoTimelineData, TimelineTrack };
export * from './services/video/videoTypes';

export type PrimitiveType =
    | 'metric-dashboard'
    | 'kanban-board'
    | 'interactive-form'
    | 'mind-map'
    | 'checklist'
    | 'markdown-document'
    | 'node-graph'
    | 'skills-hub'
    | 'mcp-hub'
    | 'live-code-sandbox'
    | '3d-scene'
    | 'interactive-browser'
    | 'browser'
    | 'video-timeline';

export type AccentColor = 'blue' | 'indigo' | 'emerald' | 'amber' | 'purple' | 'rose' | 'cyan';

// ==========================================
// 1. Metric Dashboard Primitive
// ==========================================
export interface MetricItem {
    id: string;
    label: string;
    value: string | number;
    change?: string;
    trend?: 'up' | 'down' | 'neutral';
    icon?: string;
    badge?: string;
    sparkline?: number[];
    color?: AccentColor;
    description?: string;
}

export interface ChartDataPoint {
    label: string;
    value: number;
    secondaryValue?: number;
}

export interface MetricDashboardData {
    title: string;
    subtitle?: string;
    metrics: MetricItem[];
    chart?: {
        title: string;
        type: 'bar' | 'line';
        unit?: string;
        data: ChartDataPoint[];
    };
    insights?: string[];
}

export type MetricCardsData = MetricDashboardData;

// ==========================================
// 2. Kanban Board Primitive
// ==========================================
export interface KanbanCard {
    id: string;
    title: string;
    description?: string;
    tag?: string;
    tagColor?: AccentColor;
    priority?: 'low' | 'medium' | 'high' | 'urgent';
    assignee?: string;
    dueDate?: string;
    completedSubtasks?: number;
    totalSubtasks?: number;
    planSteps?: string[];
    promptProvenance?: string;
}

export interface KanbanColumn {
    id: string;
    title: string;
    color?: AccentColor;
    cards: KanbanCard[];
}

export interface KanbanBoardData {
    title: string;
    subtitle?: string;
    columns: KanbanColumn[];
    drafts?: KanbanCard[];
}

// ==========================================
// 3. Interactive Form Primitive
// ==========================================
export type FormFieldType =
    | 'text'
    | 'number'
    | 'email'
    | 'select'
    | 'textarea'
    | 'checkbox'
    | 'radio'
    | 'range'
    | 'switch';

export interface FormFieldOption {
    label: string;
    value: string;
}

export interface FormField {
    id: string;
    label: string;
    type: FormFieldType;
    placeholder?: string;
    required?: boolean;
    options?: FormFieldOption[];
    defaultValue?: string | number | boolean;
    min?: number;
    max?: number;
    step?: number;
    helpText?: string;
    suffix?: string;
}

export interface InteractiveFormData {
    title: string;
    description?: string;
    submitLabel?: string;
    successMessage?: string;
    fields: FormField[];
}

// ==========================================
// 4. Mind Map Primitive
// ==========================================
export interface MindMapNode {
    id: string;
    label: string;
    description?: string;
    color?: AccentColor;
    badge?: string;
    icon?: string;
    children?: MindMapNode[];
    expanded?: boolean;
}

export interface MindMapData {
    title: string;
    subtitle?: string;
    root: MindMapNode;
}

// ==========================================
// 5. Actionable Checklist Primitive
// ==========================================
export interface ChecklistItem {
    id: string;
    label: string;
    completed: boolean;
    priority?: 'low' | 'medium' | 'high';
    notes?: string;
    tag?: string;
    tagColor?: AccentColor;
    dueDate?: string;
}

export interface ChecklistCategory {
    id: string;
    title: string;
    items: ChecklistItem[];
}

export interface ChecklistData {
    title: string;
    description?: string;
    categories: ChecklistCategory[];
}

// ==========================================
// 6. Rich Document / Artifacts Rendered Document Primitive
// ==========================================
export type MarkdownSectionType =
    | 'heading'
    | 'paragraph'
    | 'callout'
    | 'table'
    | 'quote'
    | 'checklist'
    | 'code'
    | 'badge-grid'
    | 'divider'
    | 'location-image'
    | 'image'
    | 'editorial-image'
    | 'video'
    | 'svg-diagram'
    | 'citation';

export interface CitationItem {
    id: string;
    sourceTitle: string;
    author?: string;
    year?: string;
    url?: string;
    quoteSnippet?: string;
    verified?: boolean;
    badgeText?: string;
    archiveName?: string;
}

export interface GroundingChunk {
    web?: {
        uri?: string;
        title?: string;
    };
}

export interface GroundingSupport {
    groundingChunkIndices?: number[];
    confidenceScores?: number[];
    segment?: {
        startIndex?: number;
        endIndex?: number;
        text?: string;
    };
}

export interface GroundingMetadata {
    webSearchQueries?: string[];
    searchEntryPoint?: {
        renderedContent?: string;
    };
    groundingChunks?: GroundingChunk[];
    groundingSupports?: GroundingSupport[];
    retrievalQueries?: string[];
}

export interface VideoTimelineEvent {
    time: string;
    label: string;
    description?: string;
}

export interface DiagramNode {
    id: string;
    label: string;
    detail?: string;
    x?: number;
    y?: number;
}

export interface AiProvenanceData {
    model?: string;
    timestamp?: string;
    prompt?: string;
    isCollapsible?: boolean;
    isCollapsed?: boolean;
    originalContent?: string;
}

export interface SectionDiffPreview {
    originalText: string;
    proposedText: string;
    actionLabel?: string;
}

export interface MarkdownSection {
    id: string;
    type: MarkdownSectionType;
    level?: 1 | 2 | 3;
    content?: string;
    codeLanguage?: string;
    language?: string;
    calloutType?: 'info' | 'success' | 'warning' | 'tip' | 'ai' | 'note' | 'summary' | 'quote';
    calloutTitle?: string;
    tableHeaders?: string[];
    tableRows?: string[][];
    checklistItems?: { id: string; text: string; done: boolean }[];
    badgeItems?: { label: string; value: string; color?: AccentColor }[];
    aiProvenance?: AiProvenanceData;
    diffPreview?: SectionDiffPreview;

    // 4D Multi-Modal Section Extensions
    // 1. Location Imagery / Spatial Maps & Clean Editorial Imagery (Nano Banana Synthesis)
    imageUrl?: string;
    imageTitle?: string;
    attribution?: string;
    dateTag?: string;
    stylePreset?: string;
    prompt?: string;
    locationName?: string;
    coordinates?: { lat: number; lng: number };
    locationMapUrl?: string;
    caption?: string;
    visualPrompt?: string;
    mapHeading?: number;
    mapZoom?: number;
    alt?: string;

    // 2. Video / Temporal Moment Reconstruction
    videoUrl?: string;
    thumbnailUrl?: string;
    videoTitle?: string;
    description?: string;
    duration?: string;
    timelineEvents?: VideoTimelineEvent[];
    aspectRatio?: '16:9' | '4:3' | '21:9' | '1:1';

    // 3. Rich Interactive SVG Diagrams & Graphs
    svgContent?: string;
    diagramType?: 'timeline' | 'architecture' | 'flow' | 'relational' | 'chart' | 'map' | 'pipeline';
    diagramTitle?: string;
    interactiveNodes?: DiagramNode[];

    // 4. Grounded Citations & Primary Sources
    citationItems?: CitationItem[];
}

export interface MarkdownDocumentData {
    title: string;
    subtitle?: string;
    author?: string;
    lastUpdated?: string;
    tags?: string[];
    sections: MarkdownSection[];
}

// ==========================================
// 7. Interactive Node Graph / Flow Canvas Primitive
// ==========================================
export type GraphNodeCategory =
    | 'input'       // Input triggers (Webhook, Cron, Event, Chat)
    | 'ai'          // AI agent processors (Gemini 3.7 Flash, Subagents, Code Gen)
    | 'decision'    // Decision gates (If/Else, Switch, Condition check)
    | 'mcp'         // MCP endpoints (Stripe, GitHub, Figma, Web Search)
    | 'cli'         // CLI scripts (Bash, Test runner, Build pipeline)
    | 'database'    // Database actions (Postgres, Firestore, Vector DB)
    | 'process'     // Logic process / Data transform
    | 'transformation' // Data transformation / mapping node
    | 'output'      // Visual Output / Webhook response
    | 'scene-3d'    // 4D Scene / 4D Media Primitive
    | 'camera-3d'   // 3D Camera Sequencer Node
    | 'map-3d'      // Geo Spatial 3D Map Node
    | 'studio-mcp'  // Scratchbox Studio MCP Tool Node
    | 'image'       // Image Card
    | 'image-card'  // Image Card Node
    | 'video'       // Video Card
    | 'video-card'  // Video Card Node
    | 'audio'       // Audio Card
    | 'audio-card'  // Audio Card Node
    | '3d-card';    // 3D Scene Card Node

export type GraphExecutionStatus = 'active' | 'pending' | 'running' | 'completed' | 'error';

export interface GraphNode {
    id: string;
    label: string;
    subtitle?: string;
    category?: GraphNodeCategory;
    color?: AccentColor;
    x: number;
    y: number;
    icon?: string;
    status?: GraphExecutionStatus;
    details?: string;
    notes?: string;
    parameters?: Record<string, any>;
    rawJson?: string;
    executionDurationMs?: number;
    errorMessage?: string;
    outputData?: any;
}

export interface GraphEdge {
    id: string;
    source: string;
    target: string;
    label?: string;
    style?: 'solid' | 'dashed' | 'animated';
    color?: AccentColor;
    sourceHandle?: 'output' | 'true' | 'false' | 'default';
    targetHandle?: 'input' | 'default';
    status?: 'idle' | 'running' | 'completed' | 'error';
}

export interface NodeGraphData {
    title: string;
    subtitle?: string;
    nodes: GraphNode[];
    edges: GraphEdge[];
    selectedNodeId?: string;
    viewport?: { x: number; y: number; zoom: number };
}

// ==========================================
// 8. AI Skills & Superpowers Hub
// ==========================================
export type SkillCategory = 'Design' | 'Analytics' | 'Engineering' | 'Writing' | 'Research' | 'Custom';

export interface SkillItem {
    id: string;
    name: string;
    tagline: string;
    description: string;
    icon?: string;
    category: SkillCategory;
    accentColor: AccentColor;
    tags: string[];
    isEnabled: boolean;
    isCustom?: boolean;
    author?: string;
    version?: string;
    promptStarters: string[];
    rawContent?: string;
    dateAdded?: string;
}

export interface SkillsManagerData {
    title: string;
    subtitle?: string;
    skills: SkillItem[];
    activeCategory?: string;
    searchQuery?: string;
}

// ==========================================
// 9. MCP (Model Context Protocol) Live Hub
// ==========================================
export type McpCategory = 'Payments' | 'Code & Git' | 'Design Assets' | 'Live Web' | 'Data Storage' | 'Observability' | 'CLI & Terminal' | 'Custom';
export type McpConnectionStatus = 'connected' | 'available' | 'active' | 'error';

export interface McpToolDefinition {
    id: string;
    name: string;
    humanTitle: string;
    description: string;
    samplePrompt: string;
    category?: string;
}

export interface McpServerItem {
    id: string;
    name: string;
    tagline: string;
    icon?: string;
    category: McpCategory;
    status: McpConnectionStatus;
    latencyMs?: number;
    toolsCount: number;
    tools: McpToolDefinition[];
    isEnabled: boolean;
    accentColor: AccentColor;
    endpoint?: string;
    authType?: 'OAuth' | 'API Key' | 'Local Pipe' | 'None';
    lastActive?: string;
}

export interface McpExecutionStep {
    id: string;
    title: string;
    detail?: string;
    status: 'pending' | 'running' | 'done' | 'failed';
    durationMs?: number;
}

export interface AgentExecutionStep {
    id: string;
    title: string;
    status: 'pending' | 'running' | 'completed' | 'failed';
    durationMs?: number;
    durationFormatted?: string;
    details?: string;
    kind?: 'context' | 'tool' | 'thinking' | 'synthesize' | 'verify';
}

export interface McpExecutionState {
    id: string;
    mcpServerId: string;
    mcpName: string;
    toolName: string;
    humanTitle: string;
    status: 'running' | 'completed' | 'failed';
    timestamp: string;
    steps: McpExecutionStep[];
    summaryResult?: string;
    humanFriendlyOutput?: {
        cardType: 'metric' | 'table' | 'json' | 'badge-list' | 'status-card';
        title: string;
        items?: { label: string; value: string; color?: AccentColor }[];
        rows?: string[][];
        headers?: string[];
        note?: string;
    };
    rawPayload?: string;
    durationMs?: number;
    args?: Record<string, any>;
}

export interface McpHubData {
    title: string;
    subtitle?: string;
    servers: McpServerItem[];
    recentExecutions?: McpExecutionState[];
    activeCategory?: string;
    searchQuery?: string;
}

// ==========================================
// 10. Live Code Sandbox Primitive (Interactive Code & UI Playground)
// ==========================================
export type SandboxLanguage = 'html' | 'css' | 'javascript' | 'typescript' | 'react' | 'python' | 'json' | 'wasm' | 'markdown' | 'yaml' | 'cpp' | 'c';
export type SandboxTemplate = 'react' | 'vanilla-html' | 'python' | 'webassembly' | 'node';
export type SandboxViewportMode = 'desktop' | 'tablet' | 'mobile';
export type SandboxViewMode = 'code' | 'split' | 'preview';

export interface CodeFileTab {
    id: string;
    name: string;
    language: SandboxLanguage;
    content: string;
    isEntry?: boolean;
    isLocked?: boolean;
    path?: string;
    isDirty?: boolean;
}

export interface SandboxConsoleLog {
    id?: string;
    type: 'log' | 'info' | 'warn' | 'error';
    message: string;
    timestamp: string;
    args?: any[];
}

export interface LiveCodeSandboxData {
    title: string;
    subtitle?: string;
    template?: SandboxTemplate;
    files: CodeFileTab[];
    activeFileId?: string;
    viewMode?: SandboxViewMode;
    isAiChatOpen?: boolean;
    chatMessages?: ChatMessage[];
    dependencies?: Record<string, string>;
    viewportMode?: SandboxViewportMode;
    autoRun?: boolean;
    consoleLogs?: SandboxConsoleLog[];
    externalStyles?: string[];
    externalScripts?: string[];
}

// ==========================================
// 10b. 4D Scene / 4D Media Primitive & 3D Sculpting
// ==========================================
export type SculptBrushType =
    | 'draw'
    | 'grab'
    | 'clay'
    | 'smooth'
    | 'inflate'
    | 'pinch'
    | 'flatten';

export type SculptFalloffType =
    | 'gaussian'
    | 'smoothstep'
    | 'spherical'
    | 'linear'
    | 'constant'
    | 'sharp';

export interface SculptSymmetry {
    x?: boolean;
    y?: boolean;
    z?: boolean;
}

export interface SculptSettings {
    brush: SculptBrushType;
    falloff: SculptFalloffType;
    radius: number;
    strength: number;
    symmetry: SculptSymmetry;
    wireframeOverlay?: boolean;
    accumulate?: boolean;
    clayOffset?: number;
}

export type TransformGizmoMode = 'translate' | 'rotate' | 'scale' | 'none';
export type TransformGizmoSpace = 'world' | 'local';
export type ViewportToolMode = 'view' | 'sculpt' | 'transform';

export interface SculptableMeshBuffer {
    vertexPositions: Float32Array;
    vertexNormals?: Float32Array;
    indices?: Uint16Array | Uint32Array;
    vertexCount: number;
}

export interface ContentDimension {
    type: 'image' | 'video' | 'audio' | '3d-scene' | '3d-model' | 'map-3d' | 'wasm-shader' | 'gaussian-splat';
    durableUri: string;
    mimeType: string;
    metadata?: {
        dims?: { width: number; height: number; depth?: number };
        vertices?: number;
        vertexCount?: number;
        triangleCount?: number;
        sampleRate?: number;
        codecs?: string;
        material?: any;
        materials?: any;
        geoJson?: any;
        style?: string;
        name?: string;
        type?: string;
        aabb?: any;
        obb?: any;
        volumeReductionPct?: number;
        [key: string]: any;
    };
}

export interface SpaceDimension {
    position?: { x: number; y: number; zIndex?: number; parentId?: string };
    spatial3d?: { x: number; y: number; z: number; pitch?: number; yaw?: number; roll?: number };
    camera?: { azimuth?: number; elevation?: number; distance?: number; zoom?: number };
    geoAnchor?: { lat: number; lng: number; alt?: number; heading?: number; pitch?: number; zoom?: number };
    boundingBox?: { min: [number, number, number]; max: [number, number, number] };
    connections?: any[];
}

export interface TimeDimension {
    timelineId?: string;
    startMs: number;
    durationMs: number;
    trimInMs?: number;
    trimOutMs?: number;
    keyframes?: any[];
    transitions?: any;
}

export interface LineageDimension {
    version: number;
    generation?: { model: string; prompt: string; seed?: number; params?: any };
    parentAssetIds?: string[];
    transformations?: any[];
    references?: any;
    author?: string;
    timestamp?: string;
}

export interface Media4DObject {
    id: string;
    content: ContentDimension;
    space: SpaceDimension;
    time?: TimeDimension;
    lineage?: LineageDimension;
}

export interface PbrTextureSet {
    albedoUrl?: string;
    normalUrl?: string;
    roughnessUrl?: string;
    metallicUrl?: string;
    aoUrl?: string;
    ormUrl?: string;
    heightUrl?: string;
    albedoMap?: string;
    normalMap?: string;
    roughnessMap?: string;
    metalnessMap?: string;
    aoMap?: string;
    ormMap?: string;
    heightMap?: string;
    displacementMap?: string;
    emissiveMap?: string;
    opacityMap?: string;
    repeat?: [number, number];
    mappingPreset?: 'triplanar' | 'uv' | 'spherical';
}

export interface VectorRoadmapConfig {
    enabled?: boolean;
    mapId?: string;
    groundBlueprint?: boolean;
    groundBlueprintOpacity?: number;
    groundBlueprintSize?: number;
    groundElevationOffset?: number;
    minimap?: boolean;
    minimapZoom?: number;
    styleJson?: any;
}

export interface Scene3DData {
    title: string;
    subtitle?: string;
    worldBranch?: string;
    /**
     * Optional semantic domain or classification token.
     * 
     * ARCHITECTURAL DIRECTIVE: Scene synthesis must NEVER use preset structures or
     * hardcoded sceneType enums as a generation guide. Instead:
     * 1. Structured Types When Needed: Explicit typed geometry (customMeshes, cppGenerator,
     *    objects, geoAnchor, customScript) must be directly honored without preset overrides.
     * 2. Adaptive Domain Architecture When Possible: For open-ended procedural generation,
     *    dynamically derive geometry, scale, PBR materials, and environment from semantic
     *    entity extraction and domain physics rather than canned preset templates.
     */
    sceneType?: 'adaptive' | 'custom' | string;
    domainOrTopic?: string;
    splatUrl?: string;
    splatTilesetUrl?: string;
    splatOptions?: {
        splatScale?: number;
        maxSplats?: number;
        enableRTC?: boolean;
        enableSoftZ?: boolean;
        contactShadow?: boolean;
        cropBox?: { min: [number, number, number]; max: [number, number, number] };
    };
    parentCommitId?: string;
    objects?: Media4DObject[];
    renderMode?: 'wireframe' | 'solid' | 'shaded' | 'pbr' | 'clay';
    clayPreset?: 'warm-clay' | 'alabaster' | 'onyx' | 'studio-grey' | 'terracotta' | 'porcelain' | 'concrete' | string;
    restructuringTelemetry?: {
        vertices?: number;
        triangles?: number;
        latency?: string;
        style?: string;
        terraformOps?: number;
        primitivesGrafted?: number;
        outputGlbPath?: string;
    };
    cameraMode?: 'orbit' | 'fps';
    toolMode?: ViewportToolMode;
    sculptSettings?: SculptSettings;
    transformMode?: TransformGizmoMode;
    transformSpace?: TransformGizmoSpace;
    selectedMeshId?: string;
    animation?: 'flight' | 'orbit' | 'idle' | string;
    camera?: {
        position: [number, number, number];
        target: [number, number, number];
        fov?: number;
    };
    environment?: {
        skybox?: string;
        lighting?: string;
        ground?: boolean;
        timeOfDay?: number;
        sunElevation?: number;
        sunAzimuth?: number;
        lightingPreset?: string;
        latitude?: number;
        longitude?: number;
        kelvinTemperature?: number;
        fog?: boolean | { color?: string | number; density?: number; near?: number; far?: number };
        groundColor?: string | number;
        ambientIntensity?: number;
        lightingRig?: any;
        aerialPerspective?: boolean | {
            enabled?: boolean;
            inscatteringIntensity?: number;
            aerialPerspectiveRange?: number;
            albedoScale?: number;
            fogDensity?: number;
            fogHeight?: number;
        };
        cloudShadows?: boolean | {
            enabled?: boolean;
            intensity?: number;
            scale?: number;
            altitude?: number;
            atmosphereShadowLength?: number;
            windVector?: [number, number];
        };
        cinematicRig?: any;
        lightingKelvin?: number;
        exposure?: number;
        ibl?: {
            enabled?: boolean;
            preset?: 'golden_hour' | 'clear_daylight' | 'overcast_studio' | 'cyberpunk_neon';
            intensity?: number;
            shCoefficients?: number[];
        };
        tonemapping?: {
            curve?: 'aces' | 'reinhard' | 'linear';
            exposure?: number;
            vignette?: number;
        };
    };
    geoAnchor?: {
        lat: number;
        lng: number;
        elevation?: number;
        elevationSource?: 'google_elevation' | 'offline_verified' | 'procedural' | string;
        datum?: 'MSL_EGM96' | string;
        active?: boolean;
        landmarkName?: string;
        castingRationale?: string;
        castingArchetype?: string;
    };
    droneRoute?: {
        pinA: { lat: number; lng: number };
        pinB: { lat: number; lng: number };
        active?: boolean;
    };
    vectorRoadmap?: VectorRoadmapConfig;
    wasmPhysics?: {
        waveActive?: boolean;
        deformFactor?: number;
        lastExecTimeUs?: number;
        statusText?: string;
    };
    timeline?: {
        currentTimeMs?: number;
        durationMs?: number;
        isPlaying?: boolean;
        playbackSpeed?: number;
        speed?: number;
        isLooping?: boolean;
        tracks?: TimelineTrack[];
        animationClip?: any;
    };
    customScript?: string;
    code?: string;
    cppGenerator?: {
        enabled?: boolean;
        sourceCode?: string;
        filename?: string;
        lastCompiledTimeMs?: number;
        lastExecutionDurationMs?: number;
        vertexCount?: number;
        triangleCount?: number;
        glbBase64?: string;
        glbPath?: string;
        diagnostics?: any[];
    };
    pythonGenerator?: {
        enabled?: boolean;
        sourceCode?: string;
        filename?: string;
        lastCompiledTimeMs?: number;
        lastExecutionDurationMs?: number;
        vertexCount?: number;
        triangleCount?: number;
        glbBase64?: string;
        glbPath?: string;
        diagnostics?: any[];
    };
    fallbackTier2ComfyUi?: {
        triggered: boolean;
        goal?: string;
        reason?: string;
        blueprintId?: string;
        promptId?: string;
        status?: 'pending' | 'running' | 'completed' | 'failed';
        assetUrls?: string[];
        error?: string;
        timestamp?: number;
    };
    shaders?: Record<string, {
        vertexShader?: string;
        fragmentShader?: string;
        uniforms?: Record<string, any>;
        transparent?: boolean;
        blending?: string;
        side?: string;
    }>;
    features?: {
        godRays?: boolean | {
            enabled?: boolean;
            intensity?: number;
            decay?: number;
            density?: number;
            weight?: number;
            samples?: number;
            color?: number | string;
        };
        atmosphericScattering?: boolean | {
            enabled?: boolean;
            rayleigh?: number;
            mie?: number;
            turbidity?: number;
            mieDirectionalG?: number;
            sunPosition?: [number, number, number];
            sunElevation?: number;
            sunAzimuth?: number;
            timeOfDay?: number;
            latitude?: number;
            longitude?: number;
            cloudCoverage?: number;
            cloudDensity?: number;
            cloudAltitude?: number;
            volumetricClouds?: boolean;
            kelvinTemperature?: number;
            wavelengthDispersion?: [number, number, number];

            // Aerial Perspective & Depth Inscattering
            aerialPerspectiveEnabled?: boolean;
            inscatteringIntensity?: number;
            aerialPerspectiveRange?: number;
            fogDensity?: number;
            fogBaseAltitude?: number;
            fogHeight?: number;
            albedoScale?: number;

            // Terrain Cloud Shadows
            cloudShadowsEnabled?: boolean;
            cloudShadowIntensity?: number;
            cloudShadowScale?: number;
            atmosphereShadowLength?: number;
            windVector?: [number, number];
        };
        contrails?: boolean | {
            enabled?: boolean;
            particleCount?: number;
            trailLength?: number;
            lifetime?: number;
            dispersion?: number;
            opacity?: number;
            color?: number | string;
        };
        controlSurfaces?: boolean | {
            enabled?: boolean;
            aileronRangeDeg?: number;
            elevatorRangeDeg?: number;
            rudderRangeDeg?: number;
            flapDeflectionDeg?: number;
        };
        terrainBiomes?: boolean | {
            enabled?: boolean;
            biomeType?: 'alpine' | 'canyon' | 'coastal' | 'desert' | 'cyberpunk' | 'volcanic';
            scale?: number;
            roughness?: number;
            heightVariation?: number;
            waterLevel?: number;
        };
        particleSystems?: boolean | Array<{
            id: string;
            type: 'contrail' | 'exhaust' | 'weather' | 'sparks' | 'afterburner';
            count?: number;
            color?: number | string;
            size?: number;
        }>;
        pbrMaterials?: boolean;
        curvatureAO?: boolean;
        multiLayerWeathering?: boolean;
        cinematic3PointLighting?: boolean;
        studioPedestal?: boolean;
        showBoundingBoxes?: boolean;
        objectSeparation?: boolean;
        resectionOverlay?: {
            opticalCenter?: [number, number, number];
            headingDeg?: number;
            pitchDeg?: number;
            rollDeg?: number;
            focalLengthMm?: number;
            subPixelResidualPx?: number;
            edgeAlignmentScore?: number;
        };
        utdraDecomposition?: {
            macroDomain?: string;
            buildingShaftRectified?: boolean;
            crownPreserved?: boolean;
            planarSutherlandHodgman?: boolean;
            bridgeVoidCarved?: boolean;
        };
        algorithmicUvRewrap?: {
            mode?: string;
            spatialDriftMm?: number;
            travertineCavitation?: boolean;
            calciteBeddingStrata?: boolean;
            sobelJointDeepening?: boolean;
        };
    };
    customMeshes?: Array<{
        id: string;
        name?: string;
        parentId?: string;
        type?: 'box' | 'sphere' | 'cylinder' | 'cone' | 'plane' | 'torus' | 'custom' | 'procedural';
        geometry?: { type?: string; params?: any[] };
        tier?: 'primary' | 'secondary' | 'tertiary';
        material?: {
            type?: string;
            color?: number | string;
            roughness?: number;
            metalness?: number;
            wireframe?: boolean;
            shaderKey?: string;
            preset?: string;
            emissive?: number | string;
            emissiveIntensity?: number;
            clearcoat?: number;
            clearcoatRoughness?: number;
            transmission?: number;
            ior?: number;
            sheen?: number;
            anisotropy?: number;
            weathering?: any;
        };
        position?: [number, number, number];
        rotation?: [number, number, number];
        scale?: [number, number, number];
        script?: string;
        isContrail?: boolean;
        isControlSurface?: boolean;
        controlSurfaceType?: 'leftAileron' | 'rightAileron' | 'leftElevator' | 'rightElevator' | 'rudder' | 'flaps' | 'spoilers';
        triplanar?: any;
        subsurface?: any;
        generator?: any;
        terrainParams?: any;
        foliageParams?: any;
        pbrTextures?: PbrTextureSet;
        normalTransfer?: any;
        decimation?: { enabled: boolean; ratio?: number; targetTriangles?: number; method?: 'qem' | 'uniform' };
        tangents?: { generated: boolean; standard?: 'mikktspace' };
        uvUnwrap?: { method?: 'harmonic' | 'spherical' | 'lscm'; maxIterations?: number };
        instanceTransforms?: Array<{
            position: [number, number, number];
            scale?: [number, number, number];
            rotation?: [number, number, number, number] | [number, number, number];
        }>;
        lodLevels?: Array<{
            geometryType?: string;
            distance: number;
        }>;
        bvhAccelerated?: boolean;
        rigidBody?: {
            mass?: number;
            isStatic?: boolean;
            restitution?: number;
            friction?: number;
        };
        xpbdCloth?: {
            compliance?: number;
            bendingCompliance?: number;
            damping?: number;
        };
        hairStrands?: {
            guideCount?: number;
            strandCount?: number;
            length?: number;
            clumping?: number;
            curlRadius?: number;
            eumelanin?: number;
            pheomelanin?: number;
        };
        fabric?: {
            pattern?: 'plain' | 'twill' | 'satin' | 'knit';
            warpCompliance?: number;
            weftCompliance?: number;
            shearCompliance?: number;
            shearLockAngle?: number;
            sheenIntensity?: number;
            sheenRoughness?: number;
            airDragCoeff?: number;
        };
        ragdoll?: {
            scale?: number;
            rootPosition?: [number, number, number];
            bones?: string[];
        };
        triangles?: any[];
    }>;
    customLights?: any[];
    hairGroom?: {
        guideCount?: number;
        strandCount?: number;
        length?: number;
        clumping?: number;
        curlRadius?: number;
        eumelanin?: number;
        pheomelanin?: number;
    };
    fabricProperties?: {
        pattern?: 'plain' | 'twill' | 'satin' | 'knit';
        warpCompliance?: number;
        weftCompliance?: number;
        shearCompliance?: number;
        shearLockAngle?: number;
        sheenIntensity?: number;
        airDragCoeff?: number;
    };
    ragdoll?: {
        scale?: number;
        rootPosition?: [number, number, number];
        bones?: string[];
    };
    operatorStack?: Array<{
        operator: string;
        params?: any;
        timestamp?: number;
        result?: any;
    }>;
    actionLog?: Array<{
        operator: string;
        params?: any;
        timestamp: number;
        executionTimeMs?: number;
        success: boolean;
        error?: string;
    }>;
    metadata?: Record<string, any>;
}

// ==========================================
// 10c. Interactive Web Browser Primitive
// ==========================================
export type BrowserViewportMode = 'desktop' | 'tablet' | 'mobile' | 'responsive';

export interface BrowserConsoleLogItem {
    id?: string;
    type: 'log' | 'warn' | 'error' | 'info';
    text: string;
    timestamp: string;
    source?: string;
}

export interface InteractiveBrowserData {
    url: string;
    title: string;
    favicon?: string;
    viewportMode?: BrowserViewportMode;
    history?: string[];
    historyIndex?: number;
    isLoading?: boolean;
    consoleLogs?: BrowserConsoleLogItem[];
    inspectMode?: boolean;
    deviceScale?: number;
    mockPageHtml?: string;
    deviceOrientation?: 'portrait' | 'landscape';
    customUserAgent?: string;
    isAiInteracting?: boolean;
    aiActionMessage?: string;
    lastActionTimestamp?: string;
    clickMarker?: { x: number; y: number; label?: string };
    networkRequests?: Array<{
        id: string;
        url: string;
        method: string;
        status: number;
        durationMs: number;
        type: string;
    }>;
}

// ==========================================
// 11. Studio Settings & User Preferences
// ==========================================
export type StudioSettingsTab =
    | 'general'
    | 'appearance'
    | 'models'
    | 'workspace'
    | 'skills'
    | 'mcp'
    | 'memories'
    | 'shortcuts'
    | 'admin'
    | 'about';
export type StudioLayoutMode = 'chat' | 'code' | 'document' | 'kanban' | 'automation' | 'canvas' | '3d' | 'browser' | 'video';

export interface StudioAppearanceConfig {
    glassBlur: 'subtle' | 'standard' | 'vibrant';
    canvasDensity: 'spacious' | 'standard' | 'compact';
    enableSpringMotion: boolean;
    showLineNumbersInCode: boolean;
    autoAttachSuperpowers: boolean;
    hapticFeedback: boolean;
}

// ==========================================
// Generic Canvas Artifact & Chat Protocol
// ==========================================
export type ArtifactData =
    | MetricDashboardData
    | KanbanBoardData
    | InteractiveFormData
    | MindMapData
    | ChecklistData
    | MarkdownDocumentData
    | NodeGraphData
    | SkillsManagerData
    | McpHubData
    | LiveCodeSandboxData
    | Scene3DData
    | InteractiveBrowserData
    | VideoTimelineData;

export interface InteractiveQuestionOption {
    id: string;
    label: string;
    description?: string;
    isRecommended?: boolean;
}

export interface InteractiveQuestionItem {
    id: string;
    prompt: string;
    options: InteractiveQuestionOption[];
    allowMultiple?: boolean;
    defaultOptionId?: string;
}

export interface InteractiveQuestionCardData {
    title?: string;
    questions: InteractiveQuestionItem[];
    submitted?: boolean;
    selectedOptions?: Record<string, string[]>;
}

export interface ExecutionPlanStep {
    id: string;
    title: string;
    description?: string;
    tier?: 'tier1-native' | 'tier2-comfyui';
    engine?: string;
}

export interface ExecutionPlanCardData {
    title: string;
    goal: string;
    pipelineTier: 'tier1-native' | 'tier2-comfyui' | 'hybrid';
    deliverables: {
        canvasType: PrimitiveType;
        assetFormat?: string;
        description: string;
    }[];
    steps: ExecutionPlanStep[];
    estimatedLatency?: string;
    openQuestions?: string[];
    confirmed?: boolean;
}

export interface CanvasArtifact {
    id: string;
    type: PrimitiveType;
    title: string;
    summary: string;
    data: ArtifactData;
    createdAt: string;
    version: number;
    graphRef?: import('../../common/project-artifact-graph-protocol').ArtifactRef;
}

export interface ChatMessage {
    id: string;
    sender: 'user' | 'assistant' | 'system';
    text: string;
    timestamp: string;
    artifacts?: CanvasArtifact[];
    artifactRefs?: import('../../common/project-artifact-graph-protocol').ArtifactRef[];
    isStreaming?: boolean;
    suggestedFollowUps?: string[];
    attachedSkills?: string[];
    attachedMcpTools?: string[];
    attachedContextMentions?: ContextMentionItem[];
    mcpExecutions?: McpExecutionState[];
    groundingMetadata?: GroundingMetadata;
    thinkingText?: string;
    thinkingDurationSeconds?: number;
    steps?: AgentExecutionStep[];
    imagesContent?: string[];
    imageContent?: string;
    videoContent?: string;
    audioContent?: string;
    mapContent?: { lat: number; lng: number; placeName: string; address?: string };
    deepWriteOffer?: boolean;
    deepWritePlan?: import('../../common/deep-write/deep-write-protocol').DiscoveredGoalPlan;
    deepWriteProgress?: import('../../common/deep-write/deep-write-protocol').DeepWriteStreamEvent;
    deepWriteCheckpoint?: import('../../common/deep-write/deep-write-protocol').DeepWriteCheckpointEvent;
    deepWriteResumed?: boolean;
    visualAudit?: import('../../common/visual-verification-protocol').VisualAuditResult;
    textureMatrixContent?: import('../../common/media-generation-protocol').TextureMatrixResult;
    questionCard?: InteractiveQuestionCardData;
    executionPlanCard?: ExecutionPlanCardData;
}

export type WorkspaceFileType = 'chat' | 'code' | 'document' | 'kanban' | 'automation' | '3d' | 'browser' | 'video';

export interface SessionViewState {
    activeSandboxTabId?: string;
    sandboxViewMode?: SandboxViewMode;
    sandboxViewportMode?: SandboxViewportMode;
    documentScrollTop?: number;
    nodeGraphViewport?: { x: number; y: number; zoom: number };
    selectedTab?: string;
    layoutMode?: StudioLayoutMode;
    browserUrl?: string;
    browserViewportMode?: BrowserViewportMode;
    browserInspectMode?: boolean;
}

export class SessionViewStateCache {
    private cache: Map<string, SessionViewState> = new Map();

    saveViewState(sessionId: string, state: SessionViewState): void {
        this.cache.set(sessionId, { ...state });
    }

    updateViewState(sessionId: string, partialState: Partial<SessionViewState>): void {
        const existing = this.cache.get(sessionId) || {};
        this.cache.set(sessionId, { ...existing, ...partialState });
    }

    getViewState(sessionId: string): SessionViewState | undefined {
        const state = this.cache.get(sessionId);
        return state ? { ...state } : undefined;
    }

    clear(): void {
        this.cache.clear();
    }
}

export type ModalType = 'spotlight' | 'projects' | 'automations' | 'settings' | 'google-drive' | 'git-review';

export class ModalStackManager {
    private stack: ModalType[] = [];

    openModal(modal: ModalType): void {
        this.stack = [...this.stack.filter(m => m !== modal), modal];
    }

    closeModal(modal: ModalType): void {
        this.stack = this.stack.filter(m => m !== modal);
    }

    closeTopModal(): ModalType | undefined {
        return this.stack.pop();
    }

    toggleModal(modal: ModalType): void {
        if (this.isModalOpen(modal)) {
            this.closeModal(modal);
        } else {
            this.openModal(modal);
        }
    }

    isModalOpen(modal: ModalType): boolean {
        return this.stack.includes(modal);
    }

    getTopModal(): ModalType | undefined {
        return this.stack.length > 0 ? this.stack[this.stack.length - 1] : undefined;
    }

    getStack(): ModalType[] {
        return [...this.stack];
    }

    hasOpenModals(): boolean {
        return this.stack.length > 0;
    }

    clear(): void {
        this.stack = [];
    }
}

export interface ChatSession {
    id: string;
    title: string;
    dateCategory: 'Today' | 'Yesterday' | 'Previous 7 Days' | 'Older';
    updatedAt: string;
    messages: ChatMessage[];
    activeArtifact?: CanvasArtifact;
    artifactHistory: CanvasArtifact[];
    layoutMode?: StudioLayoutMode;
    fileType?: WorkspaceFileType;
    workspaceId?: string;
    workspaceName?: string;
    relativeTime?: string;
    viewState?: SessionViewState;
}

export interface PromptSuggestion {
    id: string;
    title: string;
    subtitle: string;
    icon?: string;
    prompt: string;
    primitiveType: PrimitiveType;
    category: 'Productivity' | 'Analytics' | 'Design' | 'Planning' | 'Survey' | 'Docs' | 'Flow' | 'Skills' | 'MCP';
    attachedSkillId?: string;
    attachedMcpId?: string;
}

export interface ArtifactQuickAction {
    id: string;
    label: string;
    icon: string;
    promptTemplate: (artifact: CanvasArtifact) => string;
}

// ==========================================
// Default Preset Catalog for Skills & MCP
// ==========================================
export const DEFAULT_SKILLS_CATALOG: SkillItem[] = [
    {
        id: 'skill-universal-3d-structure',
        name: 'Universal 3D Structure Foundation',
        tagline: 'Single source of truth geometric anchor across solid meshes, 3DGS, cameras, collision envelopes & animations.',
        description: 'Maintains a single authoritative 3D geometric anchor across solid surface geometry, surface point constellations (3DGS seeds), calibrated 6-DoF camera rigs, physics collision envelopes, continuous animation tracks, and real-world WGS-84 coordinates. Deterministically projects outward to glTF 2.0 (.glb), COLMAP, Nerfstudio, video camera blockouts (<VIDEO_REF_0>), collision hulls, and GeoJSON.',
        category: 'Engineering',
        accentColor: 'cyan',
        tags: ['Universal 3D', 'glTF 2.0', '3DGS', 'COLMAP', 'Collision Hull', 'Continuous Animation'],
        isEnabled: true,
        author: 'Scratchbox Spatial',
        version: '1.0.0',
        promptStarters: [
            'Create a Universal 3D Structure Foundation with collision envelope and camera trajectory',
            'Export canonical 3D foundation to glTF 2.0, Nerfstudio, and COLMAP datasets',
            'Extract simplified convex collision hull for drone obstacle avoidance'
        ],
        rawContent: `### UNIVERSAL 3D STRUCTURE FOUNDATION DIRECTIVE:
1. Single Source of Truth: Never daisy-chain incompatible 3D formats. Always anchor in Universal3DStructureFoundation.
2. Synchronized Layers: Maintain solid metric mesh (positions/indices/normals/UVs), surface point constellation for 3DGS, calibrated 6-DoF camera rigs, physics collision envelope (AABB, sphere, simplified convex hull), continuous animation tracks, and WGS-84 geodetic coordinates.
3. Deterministic Outward Projections: Consume outward projections generated by the foundation: .toGlbBuffer(), .toColmap(), .toNerfstudio(), .toVideoCameraBlockout(), .toCollisionHull(), and .toGeoJson().`
    },
    {
        id: 'skill-universal-animation-timeline',
        name: 'Universal Animation & Timeline NLE',
        tagline: 'Continuous-time temporal engine unifying 3D keyframe tracks, VFX camera solves, and NLE timeline clips.',
        description: 'Continuous-time animation engine (t in R) with sub-frame LERP and SLERP interpolation, glTF 2.0 binary animation chunk generation, VFX camera solve track conversion, and interactive keyframe diamond rendering on the video timeline.',
        category: 'Design',
        accentColor: 'indigo',
        tags: ['Continuous Time', 'SLERP', 'glTF Animation', 'NLE Video Timeline', 'Keyframe Diamonds'],
        isEnabled: true,
        author: 'Scratchbox VFX',
        version: '1.0.0',
        promptStarters: [
            'Animate a continuous 3D camera arc and mount to video timeline',
            'Interpolate sub-frame quaternion SLERP trajectory for drone flight',
            'Synchronize 3D object animation tracks with NLE video timeline clips'
        ],
        rawContent: `### UNIVERSAL ANIMATION & TIMELINE NLE DIRECTIVE:
1. Continuous-Time Temporal Contract: Animation tracks are functions of continuous seconds t in R, never discrete frames alone.
2. High-Precision Interpolation: Translation and scale evaluate via vector linear interpolation (LERP); rotations evaluate via normalized unit quaternion spherical linear interpolation (SLERP).
3. glTF 2.0 Binary Animation: Export animation tracks directly into standard binary glTF 2.0 chunks with target paths ("translation", "rotation", "scale").
4. Video Timeline NLE Bridge: Use toTimelineElement() to mount animation clips to the Video Timeline primitive with dictionary-based keyframe diamonds (offsetSec * pxPerSec) for interactive scrubbing and seeking.`
    },
    {
        id: 'skill-3d-artist',
        name: 'Master 3D Environmental Artist',
        tagline: '70-20-10 form hierarchy, botanical morphogenesis, procedural PBR rhytidome & Mie scattering.',
        description: 'Executes like a senior VFX environmental supervisor to sculpt, proceduralize, and light 3D natural assets with photographic fidelity, transferred envelope foliage normals, and physically-grounded aerial perspective.',
        category: 'Design',
        accentColor: 'emerald',
        tags: ['70-20-10 Hierarchy', 'Procedural PBR', 'Botanical Branching', 'Mie Scattering', 'Envelope Normals'],
        isEnabled: true,
        author: 'Scratchbox 3D',
        version: '1.0.0',
        promptStarters: [
            'Generate an ancient mossy oak with botanical branching and fluted root buttresses',
            'Apply transferred envelope normals and procedural bark shaders to foliage'
        ]
    },
    {
        id: 'skill-universal-tile-decomposition',
        name: 'Universal Tile Decomposition (UTDRA)',
        tagline: 'Classifies 9 macro-geographic domains, rectifies building facades, and excises bridge curtains.',
        description: 'Universal Tile Decomposition & Rectification Algorithm (UTDRA / ULDRA) via native C++20 engine: segments building crowns, rectifies vertical facade walls, excises planar bridge curtains, and slices elevation datum with zero non-manifold holes.',
        category: 'Engineering',
        accentColor: 'blue',
        tags: ['UTDRA', '3D Tiles', 'Mesh Rectification', 'Bridge Curtain Cleansing', 'C++20 Engine'],
        isEnabled: true,
        author: 'Scratchbox Spatial',
        version: '1.0.0',
        promptStarters: [
            'Decompose photogrammetric 3D tile into terrain, building shafts, and architectural crowns',
            'Excise curtain wall under bridge deck and rectify vertical building facades'
        ]
    },
    {
        id: 'skill-google-3d-tiles',
        name: 'Google 3D Tiles & Clay Blockout Engine',
        tagline: 'Streams photorealistic geodetic tiles and studio clay blockouts (<VIDEO_REF_0>) with zero presets.',
        description: 'Ingests real-world addresses and geocoordinates directly from Google Maps Photorealistic 3D Tiles in full photogrammetric texture or studio grey clay blockout mode. Guarantees leaf LOD fidelity, 4K screen-space error bounds, and produces standard binary glTF 2.0 (.glb).',
        category: 'Engineering',
        accentColor: 'amber',
        tags: ['Google 3D Tiles', 'Clay Blockout', '<VIDEO_REF_0>', 'glTF 2.0', 'Geodetic'],
        isEnabled: true,
        author: 'Scratchbox Spatial',
        version: '1.0.0',
        promptStarters: [
            'Ingest photorealistic 3D tile model for coordinates [37.7749, -122.4194]',
            'Render studio grey clay blockout flight path for video diffusion conditioning'
        ]
    },
    {
        id: 'skill-two-tier-problem-solving',
        name: 'Two-Tier Problem Solving (C++20 + ComfyUI)',
        tagline: 'Tier 1 Native C++20 Astro 3D & WebGL with transactional failover to Tier 2 Cloud Run ComfyUI.',
        description: 'Evaluates user goals against Scratchbox native capabilities (C++20 Astro 3D engine, Three.js, Video Timeline, NOAA solar ephemeris) and seamlessly spins up ComfyUI neural pipelines (Trellis, Marigold, AnimateDiff) with automatic failover.',
        category: 'Engineering',
        accentColor: 'purple',
        tags: ['Two-Tier Architecture', 'C++20 Engine', 'ComfyUI Fallback', 'Cloud Run L4 GPU'],
        isEnabled: true,
        author: 'Scratchbox Core',
        version: '1.0.0',
        promptStarters: [
            'Assess task capability and execute procedural C++20 generation',
            'Spin up ComfyUI Trellis pipeline with dynamic node injection for neural 3D synthesis'
        ]
    },
    {
        id: 'skill-geo-camera-matchmove',
        name: 'Geo Camera Matchmove & Spline Trajectory',
        tagline: 'Matches 6-DoF camera solves into real-world geographic coordinates with Catmull-Rom splines.',
        description: 'Matches 6-DoF camera motion and trajectory from reference video into real-world geographic coordinates, solves Catmull-Rom spline camera paths, renders Google 3D Tiles blockout in 4K UHD (<VIDEO_REF_0>), and compiles synchronized comparisons.',
        category: 'Design',
        accentColor: 'rose',
        tags: ['Camera Matchmove', '6-DoF Solve', 'Catmull-Rom Spline', '<VIDEO_REF_0>', 'VFX'],
        isEnabled: true,
        author: 'Scratchbox VFX',
        version: '1.0.0',
        promptStarters: [
            'Solve 6-DoF camera trajectory and match to geodetic landmark coordinates',
            'Render synchronized 50/50 split comparison for matchmove validation'
        ]
    },
    {
        id: 'skill-native-mesh-reshaping',
        name: 'Native C++20 Mesh Reshaper & Deformer',
        tagline: 'Parametric non-linear deformers, Bernstein FFD lattices & sculpt brushes in sub-milliseconds.',
        description: 'Reshapes and deforms 3D meshes via natural language prompts or explicit parametric operators using the native C++20 Astro 3D engine (scratchbox_shaper.hpp): non-linear deformers (taper, twist, bend, bulge, squash), Bernstein FFD tensor lattices, and manifold healing.',
        category: 'Engineering',
        accentColor: 'cyan',
        tags: ['Astro 3D Engine', 'FFD Lattices', 'C++20 Deformers', 'Sub-millisecond', 'Manifold Healing'],
        isEnabled: true,
        author: 'Scratchbox 3D',
        version: '1.0.0',
        promptStarters: [
            'Apply non-linear taper and twist deformers to mesh vertices',
            'Deform geometry using a 4x4x4 Bernstein FFD tensor lattice'
        ]
    }
];

export const DEFAULT_MCP_SERVERS: McpServerItem[] = [
    {
        id: 'mcp-google-drive',
        name: 'Google Drive & Docs',
        tagline: 'Export documents to Google Docs, manage Drive files, real-time sync & search.',
        category: 'Data Storage',
        status: 'connected',
        latencyMs: 18,
        toolsCount: 4,
        isEnabled: true,
        accentColor: 'blue',
        endpoint: 'mcp://drive.google.com/v3',
        authType: 'OAuth',
        lastActive: 'Just now',
        tools: [
            {
                id: 'gdrive-create-doc',
                name: 'create_document',
                humanTitle: 'Create & Export Google Doc',
                description: 'Converts markdown and rich structured specifications into formatted Google Docs with live URLs.',
                samplePrompt: 'Export this document to Google Docs and get sharing link'
            },
            {
                id: 'gdrive-upload-file',
                name: 'upload_file',
                humanTitle: 'Upload File to Google Drive',
                description: 'Uploads markdown files, JSON datasets, and media assets to Google Drive folders.',
                samplePrompt: 'Upload workspace specification to Google Drive'
            },
            {
                id: 'gdrive-list-files',
                name: 'list_drive_files',
                humanTitle: 'List Files in Google Drive',
                description: 'Lists and filters documents, spreadsheets, and files in Google Drive.',
                samplePrompt: 'List recent Google Docs in my Drive workspace'
            },
            {
                id: 'gdrive-search-drive',
                name: 'search_drive',
                humanTitle: 'Search Google Drive Knowledge',
                description: 'Full-text semantic and keyword search across Google Drive files and docs.',
                samplePrompt: 'Search Google Drive for architecture specifications'
            }
        ]
    },
    {
        id: 'mcp-stripe',
        name: 'Stripe Payments',
        tagline: 'Live access to balances, invoices, customer subscriptions & payment flows.',
        category: 'Payments',
        status: 'available',
        latencyMs: 14,
        toolsCount: 6,
        isEnabled: false,
        accentColor: 'indigo',
        endpoint: 'mcp://api.stripe.com/v1',
        authType: 'API Key',
        tools: [
            {
                id: 'stripe-get-balance',
                name: 'get_balance',
                humanTitle: 'Fetch Live Balance & Net Revenue',
                description: 'Retrieves current available and pending balances across all settlement currencies.',
                samplePrompt: 'Fetch live balance from Stripe and summarize in a metric card'
            },
            {
                id: 'stripe-list-customers',
                name: 'list_customers',
                humanTitle: 'Query Active Customers & MRR',
                description: 'Fetches recent customer accounts, active subscriptions, and lifetime value.',
                samplePrompt: 'Query active Stripe customers and create an interactive customer table'
            },
            {
                id: 'stripe-create-checkout',
                name: 'create_checkout',
                humanTitle: 'Generate One-Click Checkout Session',
                description: 'Creates an Apple Pay / Credit Card checkout session for any product or tier.',
                samplePrompt: 'Create a test Stripe checkout session for $29 Pro plan'
            }
        ]
    },
    {
        id: 'mcp-github',
        name: 'GitHub Repository',
        tagline: 'Live sync with pull requests, commit history, branch changes & issue triage.',
        category: 'Code & Git',
        status: 'available',
        latencyMs: 22,
        toolsCount: 8,
        isEnabled: false,
        accentColor: 'purple',
        endpoint: 'mcp://api.github.com/v3',
        authType: 'OAuth',
        tools: [
            {
                id: 'github-list-prs',
                name: 'list_pull_requests',
                humanTitle: 'Inspect Open Pull Requests & CI Checks',
                description: 'Fetches open pull requests with review status and passing CI checks.',
                samplePrompt: 'List all open PRs and display them in a sprint Kanban board'
            },
            {
                id: 'github-get-diff',
                name: 'inspect_diff',
                humanTitle: 'Analyze Branch Code Changes & Commits',
                description: 'Retrieves full git diff summaries between main and working branch.',
                samplePrompt: 'Analyze recent git commits and summarize in an executive brief'
            }
        ]
    },
    {
        id: 'mcp-figma',
        name: 'Figma Visual Assets',
        tagline: 'Extracts live design tokens, color variables, vector icons & component trees.',
        category: 'Design Assets',
        status: 'connected',
        latencyMs: 38,
        toolsCount: 4,
        isEnabled: true,
        accentColor: 'rose',
        endpoint: 'mcp://api.figma.com/v1',
        authType: 'OAuth',
        lastActive: '3m ago',
        tools: [
            {
                id: 'figma-get-tokens',
                name: 'get_design_tokens',
                humanTitle: 'Sync Design Tokens & Color Palette',
                description: 'Pulls color styles, spacing tokens, and typography specs directly from Figma.',
                samplePrompt: 'Import Figma design tokens and build an Apple HIG color palette'
            },
            {
                id: 'figma-search-icons',
                name: 'search_components',
                humanTitle: 'Search Figma Component Library',
                description: 'Searches for published UI components, badges, and icon sets.',
                samplePrompt: 'Search Figma components for Glassmorphic cards'
            }
        ]
    },
    {
        id: 'mcp-websearch',
        name: 'Web Real-time Search',
        tagline: 'Fetches live market data, documentation, news & verified web citations.',
        category: 'Live Web',
        status: 'connected',
        latencyMs: 85,
        toolsCount: 3,
        isEnabled: true,
        accentColor: 'cyan',
        endpoint: 'mcp://search.internal/live',
        authType: 'None',
        lastActive: '5m ago',
        tools: [
            {
                id: 'web-search-query',
                name: 'search_live_web',
                humanTitle: 'Real-Time Web Knowledge Query',
                description: 'Queries live web sources and returns verified answers with citations.',
                samplePrompt: 'Search the web for latest Apple HIG Liquid Glass design updates'
            }
        ]
    },
    {
        id: 'mcp-postgres',
        name: 'PostgreSQL Database',
        tagline: 'Executes secure schema inspections, metric aggregations & live readouts.',
        category: 'Data Storage',
        status: 'available',
        latencyMs: 12,
        toolsCount: 5,
        isEnabled: false,
        accentColor: 'blue',
        endpoint: 'mcp://db.local:5432/scratchbox',
        authType: 'Local Pipe',
        tools: [
            {
                id: 'pg-inspect-schema',
                name: 'inspect_schema',
                humanTitle: 'Inspect Tables, Columns & Relations',
                description: 'Generates visual relational schema maps of database tables.',
                samplePrompt: 'Inspect Postgres database schema and render as a node flow graph'
            },
            {
                id: 'pg-run-query',
                name: 'run_read_query',
                humanTitle: 'Execute Safe Analytics Readout',
                description: 'Executes read-only aggregation queries for dashboards.',
                samplePrompt: 'Query weekly signups from database and display in metric cards'
            }
        ]
    },
    {
        id: 'mcp-sentry',
        name: 'Sentry Crash & Error Telemetry',
        tagline: 'Monitors real-time exceptions, performance traces & release health.',
        category: 'Observability',
        status: 'available',
        latencyMs: 45,
        toolsCount: 3,
        isEnabled: false,
        accentColor: 'amber',
        endpoint: 'mcp://sentry.io/api/0',
        authType: 'API Key',
        tools: [
            {
                id: 'sentry-get-trends',
                name: 'get_issue_trends',
                humanTitle: 'Fetch Crash Rates & Issue Volume',
                description: 'Summarizes top exceptions and latency anomalies across active releases.',
                samplePrompt: 'Query Sentry crash telemetry and build a production readiness checklist'
            }
        ]
    },
    {
        id: 'mcp-cli',
        name: 'Terminal & CLI Bridge',
        tagline: 'Execute shell scripts, tests, and git commands with safety guardrails & confirmation badges.',
        category: 'CLI & Terminal',
        status: 'connected',
        latencyMs: 5,
        toolsCount: 4,
        isEnabled: true,
        accentColor: 'emerald',
        endpoint: 'mcp://terminal.local/pty',
        authType: 'Local Pipe',
        lastActive: 'Just now',
        tools: [
            {
                id: 'cli-run-tests',
                name: 'run_tests',
                humanTitle: 'Execute Automated Test Suites',
                description: 'Runs project unit and integration tests with live streaming progress & error stack trace extraction.',
                samplePrompt: 'Run test suite and display results in a verified status card'
            },
            {
                id: 'cli-git-status',
                name: 'git_status_diff',
                humanTitle: 'Inspect Git Working Tree & Diffs',
                description: 'Analyzes unstaged changes, modified files, and branch divergence with read-only safety.',
                samplePrompt: 'Inspect git working tree status and format as a structured card'
            },
            {
                id: 'cli-build-project',
                name: 'build_project',
                humanTitle: 'Compile & Verify TypeScript Build',
                description: 'Executes tsc build check and reports type errors or bundle metrics.',
                samplePrompt: 'Run TypeScript compiler build check across extensions/product'
            }
        ]
    },
    {
        id: 'mcp-scratchbox-studio',
        name: 'Scratchbox Studio',
        tagline: 'Connects to our sister creative media app for 3D worlds, videos, images, and maps.',
        category: 'Design Assets',
        status: 'connected',
        latencyMs: 8,
        toolsCount: 63,
        isEnabled: true,
        accentColor: 'rose',
        endpoint: 'mcp://localhost:4000/api/mcp/canvas',
        authType: 'API Key',
        lastActive: 'Just now',
        tools: [
            {
                id: 'studio-scene3d-create',
                name: 'scene3d_create_scene_node',
                humanTitle: 'Create 3D Spatial Scene Node',
                description: 'Initializes a new 3D spatial canvas coordinate system with meshes and skybox properties.',
                samplePrompt: 'Create a 3D procedural cyberpunk city scene'
            },
            {
                id: 'studio-ai-generate-images',
                name: 'generate_images',
                humanTitle: 'Generate High-Resolution Assets',
                description: 'Invokes Google Imagen/Gemini 3 Pro to synthesize brand-aligned image vectors and textures.',
                samplePrompt: 'Generate a futuristic neon background texture'
            },
            {
                id: 'studio-video-generate',
                name: 'generate_video',
                humanTitle: 'Synthesize Motion Video Clip',
                description: 'Invokes Google Veo/Video Gen to compile a 4-second temporal cinematic camera flythrough.',
                samplePrompt: 'Generate a drone flythrough of the 3D city scene'
            },
            {
                id: 'studio-location-scout',
                name: 'scout_locations',
                humanTitle: 'Scout Geographic Places & 3D maps',
                description: 'Queries real-world coordinates and pulls Google 3D photorealistic tiles for scene mapping.',
                samplePrompt: 'Scout locations around San Francisco financial district'
            }
        ]
    }
];

// ==========================================
// 12. Context Mention Engine Types (@file, @folder, @git, @terminal, @web, @docs, @mcp)
// ==========================================
export type ContextMentionCategory =
    | 'file'
    | 'files'
    | 'folder'
    | 'git'
    | 'terminal'
    | 'web'
    | 'docs'
    | 'mcp'
    | 'skill';

export interface ContextMentionItem {
    id: string;
    type: ContextMentionCategory;
    name: string;
    description: string;
    detail?: string;
    icon?: string;
    path?: string;
    payload?: any;
}

export interface ParsedContextMentions {
    cleanPrompt: string;
    mentions: {
        tag: string;
        query?: string;
        type: ContextMentionCategory;
        item?: ContextMentionItem;
    }[];
}

// ==========================================
// 13. External MCP Discovery & Auto-Import
// ==========================================
export interface DiscoveredExternalMcpSource {
    source: 'claude_desktop' | 'cursor' | 'scratchbox';
    sourceLabel: string;
    path: string;
    exists: boolean;
    servers: McpServerItem[];
}

// ==========================================
// 14. Multi-File Diff Reviewer & Patch Engine
// ==========================================
export type FileDiffStatus = 'modified' | 'added' | 'deleted' | 'unchanged';

export interface FileDiffLine {
    type: 'add' | 'del' | 'context';
    oldLineNo?: number;
    newLineNo?: number;
    content: string;
}

export interface FileDiffEntry {
    path: string;
    oldContent: string;
    newContent: string;
    additions: number;
    deletions: number;
    status: FileDiffStatus;
    lines?: FileDiffLine[];
    isAccepted?: boolean;
}

export interface MultiFilePatch {
    id: string;
    title: string;
    summary: string;
    timestamp: string;
    files: FileDiffEntry[];
    applied?: boolean;
    author?: string;
}

// ==========================================
// 15. Terminal Error Capture & AI Debug Bridge
// ==========================================
export interface TerminalExecutionError {
    command: string;
    exitCode: number;
    output: string;
    stackTrace?: string;
    timestamp?: number;
    cwd?: string;
}

export interface TerminalDebugAnalysis {
    diagnostics: string[];
    stackFrames: string[];
    rootCauseSummary: string;
    suggestedFix?: string;
}

// ==========================================
// 16. Live Token Budget & Context Compactor HUD
// ==========================================
export interface TokenBudgetMetrics {
    promptTokens: number;
    candidateTokens: number;
    totalTokens: number;
    maxContextLimit: number;
    compressionRatio: number;
    activeModel: string;
    thinkingBudget: number;
    rawLogTokens?: number;
    compactedTokens?: number;
    anchorsRetainedCount?: number;
}

// ==========================================
// 17. Multi-Surface Bento & Split-View Stage
// ==========================================
export type StageLayoutMode =
    | 'single'
    | 'dual-split-horizontal'
    | 'dual-split-vertical'
    | 'tri-pane-bento'
    | 'quad-grid';

export interface BentoPaneConfig {
    id: string;
    title: string;
    primitiveType: PrimitiveType;
    artifactId?: string;
    artifactRef?: import('../../common/project-artifact-graph-protocol').ArtifactRef;
    sizeRatio?: number;
    minimized?: boolean;
    customData?: any;
}

export interface BentoStageConfig {
    mode: StageLayoutMode;
    activePanes: BentoPaneConfig[];
    focusedPaneId?: string;
}

// ==========================================
// 18. User Memories Architecture & Learning Types
// ==========================================
export type WritingStyleCategory =
    | 'writing_patterns'
    | 'writing_style'
    | 'tone_and_voice'
    | 'formatting';

export type VisualStyleCategory =
    | 'image_style'
    | 'video_style'
    | 'visual_composition'
    | 'style_preferences';

export type ProjectContextCategory =
    | 'canvas_character'
    | 'canvas_location'
    | 'canvas_decisions'
    | 'canvas_narrative'
    | 'canvas_style'
    | 'general';

export type UserMemoryCategory =
    | WritingStyleCategory
    | VisualStyleCategory
    | ProjectContextCategory
    | string;

export type MemoryCategoryGroup = 'all' | 'writing' | 'visual' | 'project';

export const WRITING_STYLE_CATEGORIES: WritingStyleCategory[] = [
    'writing_patterns',
    'writing_style',
    'tone_and_voice',
    'formatting'
];

export const VISUAL_STYLE_CATEGORIES: VisualStyleCategory[] = [
    'image_style',
    'video_style',
    'visual_composition',
    'style_preferences'
];

export const PROJECT_CONTEXT_CATEGORIES: ProjectContextCategory[] = [
    'canvas_character',
    'canvas_location',
    'canvas_decisions',
    'canvas_narrative',
    'canvas_style',
    'general'
];

export function getMemoryCategoryGroup(category: string): MemoryCategoryGroup {
    if (WRITING_STYLE_CATEGORIES.includes(category as WritingStyleCategory)) {
        return 'writing';
    }
    if (VISUAL_STYLE_CATEGORIES.includes(category as VisualStyleCategory)) {
        return 'visual';
    }
    return 'project';
}

export function formatCategoryLabel(category: string): string {
    const labels: Record<string, string> = {
        writing_patterns: 'Writing Patterns',
        writing_style: 'Writing Style',
        tone_and_voice: 'Tone & Voice',
        formatting: 'Formatting Guidelines',
        image_style: 'Image Style',
        video_style: 'Video Style',
        visual_composition: 'Visual Composition',
        style_preferences: 'Style Preferences',
        canvas_character: 'Characters & Entities',
        canvas_location: 'Locations & Settings',
        canvas_decisions: 'Project Decisions',
        canvas_narrative: 'Narrative Arcs',
        canvas_style: 'Canvas Aesthetics',
        general: 'General Facts & Context'
    };
    if (labels[category]) {
        return labels[category];
    }
    return category
        .split('_')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');
}

export interface UserMemoryItem {
    id: string;
    category: UserMemoryCategory;
    key: string;
    value: string;
    workspaceId?: string;
    scope?: 'global' | 'workspace';
    createdAt?: string;
    updatedAt?: string;
}

export interface WritingStyleProfile {
    id: string;
    name: string;
    stylePrompt: string;
    samples?: string[];
    isActive: boolean;
    workspaceId?: string;
    scope?: 'global' | 'workspace';
    createdAt?: string;
    updatedAt?: string;
}

export interface ImageVideoStylePreference {
    id: string;
    name: string;
    description?: string;
    stylePrompt: string;
    category: 'image' | 'video' | 'visual_composition' | 'style_preferences' | string;
    isDefault?: boolean;
    sortOrder?: number;
    workspaceId?: string;
    scope?: 'global' | 'workspace';
    createdAt?: string;
    updatedAt?: string;
}

export interface UserMemoriesConfig {
    enableMemoryInjection: boolean;
    maxInjectedMemories?: number;
    activeWritingProfileId?: string;
}

export interface UserMemoriesStore {
    version: number;
    config: UserMemoriesConfig;
    memories: UserMemoryItem[];
    writingProfiles: WritingStyleProfile[];
    stylePreferences: ImageVideoStylePreference[];
    lastUpdated?: string;
}



