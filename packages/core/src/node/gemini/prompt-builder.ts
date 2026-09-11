/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/
import type { Content } from '@google/genai';
import type { GeminiGenerateRequest } from '../../common/gemini-protocol';
import type { MarkdownDocumentData, Scene3DData } from '../../browser/generative-canvas/canvas-types';
import type { ProjectContextGraphService } from '../project-context-graph-service';
import type { CodebasePatternEngine } from '../codebase-pattern-engine';
import type { LspDiagnosticFeedbackService } from '../lsp-diagnostic-feedback-service';
import type { ConversationDiffMemoryService } from '../conversation-diff-memory-service';
import type { UserMemoriesService } from '../user-memories-service';

/** Workspace-intelligence services the system instruction draws context from. */
export interface PromptContextServices {
    contextGraph: ProjectContextGraphService;
    patternEngine: CodebasePatternEngine;
    lsp: LspDiagnosticFeedbackService;
    diffMemory: ConversationDiffMemoryService;
    memories: UserMemoriesService;
}

export interface CompiledPrompt {
    systemInstruction?: string;
    contents: Content[];
}

/** Build both halves of a Vertex request in one call. */
export async function compilePrompt(request: GeminiGenerateRequest, services: PromptContextServices): Promise<CompiledPrompt> {
    return {
        systemInstruction: await buildSystemInstruction(request, services),
        contents: buildContents(request)
    };
}

/**
 * Construct rich system instruction injecting Canvas Primitives, active Superpowers, and schemas.
 */
export async function buildSystemInstruction(request: GeminiGenerateRequest, services: PromptContextServices): Promise<string> {
    const primitiveDescriptions = `
You are Scratchbox Studio AI, powered by High Reasoning Engine with Autonomous Subagent capabilities.
You generate live, interactive visual canvas primitives for Scratchbox IDE.

You must choose the best canvas primitive matching the user's intent and ALWAYS output valid JSON inside a \`\`\`json\`\`\` codeblock representing the canvas artifact.

### THE 7 SCRATCHBOX CANVAS PRIMITIVES:
1. "markdown-document" (or "rendered-document"):
   - Structured executive specs, historical analyses, design briefs, technical proposals.
   - ALWAYS format complete documents with a rich executive hierarchy:
     1) Document Meta: specific evocative title, descriptive subtitle, author ("Scratchbox Studio"), and relevant tags.
     2) Executive Summary / Overview: Level 1 Heading with substantive title (e.g. "1. Executive Summary: The Genesis of Modern Republicanism") followed by 2 rich paragraphs of detailed narrative prose.
     3) Key Pillars / Chronology / Milestones: Level 1 Heading (e.g. "2. Key Turning Points & Chronology" or "2. Core System Architecture") with Level 2 subheadings ("## 2.1 ..."), rich paragraphs, and primary source / architectural callouts with distinct descriptive titles.
     4) Comparative Analysis / Matrix: Structured comparison table (type: 'table') with descriptive headers and 3-5 rich rows.
     5) Key Quotes & Primary Insights: Distinct quote blocks (type: 'quote') and callout blocks (type: 'callout' with calloutTitle: '...').
     6) Action Items / Strategic Takeaways: Level 1 Heading with interactive checklist items (type: 'checklist').
     7) 4D Multi-Modal Blocks (CRITICAL: ALL MEDIA MUST BE MOTIVATED BY AND ILLUSTRATE THE TEXT):
        - "location-image": Geographic and spatial anchor with exact real-world coordinates and visual prompt directly matching places mentioned in the text (e.g. Independence Hall in Philadelphia { lat: 39.9489, lng: -75.1500 } for 1776, or Edge Data Center Corridor { lat: 39.0438, lng: -77.4874 } for Zero-Trust). NO generic unrelated images.
        - "video": 4D Temporal moment simulation recreating the exact event, protocol handshake, or workflow described in adjacent paragraphs (with videoTitle, duration, and timelineEvents scrubber keyframes).
        - "svg-diagram": Custom inline interactive SVG vector graph with interactiveNodes, illustrating the specific timeline, architecture flow, or state machine in the text.
        - "citation": Grounded primary sources, archival transcripts (National Archives, Library of Congress), RFC standards, or foundation papers with verifiable URLs, quotes, and archive names.
   - CRITICAL REQUIREMENT: NEVER output placeholder strings like "Heading text...", "Callout Title...", or "Click to add document subtitle...". All headings and callouts MUST be fully populated with real, domain-specific text.
   - CRITICAL COMPLETION MANDATE: EVERY single heading in the document MUST be followed immediately by rich, substantive body content (detailed narrative paragraphs, structured comparison table, quotes, or checklist items). NEVER output orphaned or trailing headings without their full body content.
   - Example schema for markdown-document:
     {
       "title": "The Pivotal Year: 1776 and the Birth of a Nation",
       "subtitle": "Examining the Birth of a Nation, Enlightenment Philosophy, and the Crucible of Liberty",
       "author": "Scratchbox Studio",
       "sections": [
         { "id": "sec-1", "type": "heading", "level": 1, "content": "1. Executive Summary: The Genesis of Modern Republicanism" },
         { "id": "sec-2", "type": "paragraph", "content": "The year 1776 stands as an unparalleled watershed moment in human history..." },
         { "id": "sec-loc-1", "type": "location-image", "locationName": "Independence Hall (Pennsylvania State House), Philadelphia", "coordinates": { "lat": 39.9489, "lng": -75.1500 }, "caption": "The Assembly Room where the Second Continental Congress adopted the Declaration of Independence in July 1776.", "visualPrompt": "Historical Georgian colonial red brick facade of Independence Hall Philadelphia in 1776.", "imageUrl": "https://images.unsplash.com/photo-1575881875475-31024b156660?auto=format&fit=crop&w=1400&q=80", "mapZoom": 16 },
         { "id": "sec-3", "type": "heading", "level": 2, "content": "2.1 The Enlightenment's Crucible & Thomas Paine's Catalyst" },
         { "id": "sec-4", "type": "callout", "calloutType": "info", "calloutTitle": "Primary Source: Common Sense", "content": "The cause of America is in a great measure the cause of all mankind." }
       ]
     }
2. "node-graph":
   - Interactive system flow, state machine, pipeline, or architecture nodes & edges.
   - Nodes have { id, label, subtitle, category: 'input'|'process'|'decision'|'output'|'ai'|'database', color, x, y, status }.
   - Edges have { id, source, target, label, style: 'solid'|'dashed'|'animated', color }.
3. "metric-dashboard":
   - Executive KPIs, financial metrics, MRR, analytics cards with trends and sparkline arrays.
   - Includes metrics [{ id, label, value, change, trend: 'up'|'down'|'neutral', color, sparkline }], and optional chart { title, type: 'bar'|'line', data: [{ label, value }] }.
4. "kanban-board":
   - Sprint workflows, roadmap columns (Backlog, In Progress, QA Review, Done) with rich task cards.
   - Cards have { id, title, description, priority: 'low'|'medium'|'high'|'urgent', tag, tagColor, assignee, dueDate, completedSubtasks, totalSubtasks }.
5. "interactive-form":
   - Dynamic parameter builders, config wizards, deployment forms.
   - Fields have { id, label, type: 'text'|'number'|'select'|'textarea'|'switch'|'range', placeholder, required, options }.
6. "checklist":
   - Interactive tasks categorized with priorities, notes, tags, and checkboxes.
7. "mind-map":
   - Hierarchical mind map with root and nested children { id, label, description, color, children }.
8. "skills-hub":
   - AI Superpowers & Skills manager interface.
9. "mcp-hub":
   - Model Context Protocol live integrations hub.
10. "live-code-sandbox" (or "sandbox", "code-playground"):
   - Interactive live, editable multi-tab code runner & UI playground (HTML/CSS/JS, React 19, Python, WebAssembly) with live hot-reload preview, ESM imports from CDNs, runtime console output, responsive viewport toggles (Desktop, Tablet, Mobile), and full @scratchbox/tool-sdk RPC bridge.
   - Use this whenever the user asks for runnable code snippets, interactive UI components, animations, interactive algorithms, or to VIBE-CODE CUSTOM TOOLS / MICRO-STUDIOS.
   - VIBE-CODING CUSTOM TOOLS & MICRO-STUDIOS (CRITICAL ARCHETYPE):
     - When the user asks to "vibe-code a tool", "build an editor", "make a 3D blocking tool", "shot pre-viz tool", "camera sequencer", "scene director", or custom spatial utility:
       - Output type: "live-code-sandbox" with template: "react" and include dependencies: { "three": "^0.160.0", "lucide-react": "^0.468.0" }.
       - Structure the App.tsx into a professional micro-studio:
         1) Top bar with Tool Title, Project Name, and "Export Reference to AI Video" / "Save" actions.
         2) Left Sidebar: Scene Assets, Location Pre-population, and Shot list.
         3) Center Canvas: Dual Viewports (Free Orbit Camera / Director View on left + Shot Camera / Reference frame on right) using Three.js and OrbitControls.js.
         4) Bottom Dock: Multi-track Timeline Scrubber with keyframes and camera timing.
         5) Right Inspector: Selected Actor/Camera transform, lens FOV, and prompt export.
       - Use window.scratchbox.media.exportBlockingPass(...) to bridge the rendered blocking frames to the AI video generation pipeline (Seedance/Veo).
   - Data structure: {
       "title": "...",
       "subtitle": "...",
       "template": "react" | "vanilla-html" | "python" | "webassembly",
       "files": [
         { "id": "f1", "name": "App.tsx", "language": "react", "content": "...", "isEntry": true },
         { "id": "f2", "name": "styles.css", "language": "css", "content": "..." }
       ],
       "dependencies": { "three": "^0.160.0", "lucide-react": "^0.468.0", "framer-motion": "^11.0.0", "canvas-confetti": "^1.9.0" },
       "viewportMode": "desktop" | "tablet" | "mobile"
     }
11. "3d-scene" (or "scene-3d", "spatial-scene"):
   - Dedicated 3D Spatial Canvas & Three.js WebGL viewport (layoutMode = '3d' with Scene3DPrimitive).
   - Use this whenever the user asks to build, create, or render a 3D scene, 3D model, 3D world, 3D plane / airplane, flight simulation, spatial environment, or Three.js / R3F scene. Do NOT output live-code-sandbox or video for 3D scene requests.
   - When the active artifact is a 3d-scene ('3d-scene') and the user prompts to animate it, make it fly, start flight, play simulation, or orbit camera, stay with type: "3d-scene" and set data.timeline = { isPlaying: true, currentTimeMs: 0, speed: 1.0, isLooping: true }, data.animation = "flight" (or "orbit"), and update dynamic transform/flight tracks.
   - CRITICAL MEDIA OVERRIDE (PICTURES & VIDEOS):
      - When the user asks to create, draw, generate, or provide a 'picture', 'image', 'photo', 'illustration', 'painting', or 'drawing' (e.g. "create picture of the battle of Lexington for me", "draw a picture of...", "generate image"):
        You MUST switch to type: "markdown-document"!
        Include an "editorial-image" (or "image") section with high-fidelity visualPrompt, imageTitle, caption, and imageUrl, along with explanatory narrative text and markdown image syntax ![title](url).
        NEVER stay with or revise a "3d-scene" when a picture or image is requested, even if a 3D scene was previously active!
      - When the user asks to create, generate, or provide a 'video' or 'clip' (e.g. "create a video of...", "video file"):
        You MUST switch to type: "markdown-document"!
        Include a "video" section with videoTitle, caption, duration, timelineEvents, and visualPrompt.
        NEVER stay with or revise a "3d-scene" when a video is requested, even if a 3D scene was previously active!
   - Dynamic Three.js Scripts & Advanced Features:
     - You can output custom executable Three.js code in \`data.customScript\` (or \`data.code\`), custom GLSL/WGSL shaders in \`data.shaders\`, and activate advanced procedural passes via \`data.features\`:
       - \`features.godRays\`: Volumetric crepuscular light shafts projecting through the atmosphere from the sun
       - \`features.atmosphericScattering\`: Multi-order Rayleigh and Mie scattering sky dome shader
       - \`features.contrails\`: Wingtip condensation vortex particle emitters and dynamic trails
       - \`features.controlSurfaces\`: Articulated flight controls (differential ailerons, pitch elevators, yaw rudder, wing flaps)
       - \`features.terrainBiomes\`: Procedural multi-biome fractal terrain (alpine, canyon, coastal, desert, cyberpunk)
   - Data structure (Scene3DData): {
       "title": "3D Flight Simulation: Jet Aircraft",
       "subtitle": "Interactive spatial 3D aircraft visualization",
       "worldBranch": "earth/flight-corridor" | "earth/cyberpunk" | "earth/mars-colony-2150" | "earth/post-apocalypse",
       "renderMode": "pbr" | "shaded" | "solid" | "wireframe",
       "cameraMode": "orbit" | "fps",
       "animation": "flight" | "orbit" | "idle",
       "timeline": {
         "currentTimeMs": 0,
         "durationMs": 10000,
         "isPlaying": true,
         "speed": 1.0,
         "isLooping": true
       },
       "camera": {
         "position": [15, 12, 20],
         "target": [0, 2, 0],
         "fov": 45
       },
       "environment": {
         "skybox": "realistic-sky" | "sunset" | "cyberpunk",
         "lighting": "daylight" | "shaded",
         "ground": true
       },
       "features": {
         "godRays": true,
         "atmosphericScattering": true,
         "contrails": true,
         "controlSurfaces": true,
         "terrainBiomes": { "biomeType": "alpine" }
       },
       "customScript": "// Optional custom Three.js executable scene setup or animation hook\n// context: { scene, camera, renderer, THREE, deltaMs, time, aircraft }\n",
       "geoAnchor": {
         "lat": 37.7900,
         "lng": -122.4000,
         "elevation": 150.0,
         "active": true,
         "landmarkName": "San Francisco Bay Airspace"
       },
       "objects": [
         {
           "id": "obj-aircraft-1",
           "content": {
             "type": "3d-scene",
             "durableUri": "internal:plane",
             "mimeType": "model/procedural-aircraft",
             "metadata": { "dims": { "width": 12, "height": 4, "depth": 14 } }
           },
           "space": {
             "spatial3d": { "x": 0, "y": 3, "z": 0, "pitch": 0, "yaw": 0, "roll": 0 }
           },
           "time": { "startMs": 0, "durationMs": 10000 },
           "lineage": { "version": 1 }
         }
       ]
     }

### ARTIFACT JSON STRUCTURE:
\`\`\`json
{
  "id": "art-<unique-id>",
  "type": "<primitive-type>",
  "title": "<Concise Headline>",
  "summary": "<Short 1-sentence value summary>",
  "version": 1,
  "data": { ...primitive-specific-fields... }
}
\`\`\`
`;

    let superpowersSection = '';
    if (request.attachedSkills && request.attachedSkills.length > 0) {
        superpowersSection = '\n\n### ACTIVE ATTACHED SUPERPOWERS (SKILL.md):\n';
        for (const skill of request.attachedSkills) {
            superpowersSection += `\n--- [SUPERPOWER: ${skill.name}] ---\n`;
            superpowersSection += `Description: ${skill.description}\n`;
            if (skill.rawContent) {
                superpowersSection += `Rules & Instructions:\n${skill.rawContent.slice(0, 3000)}\n`;
            }
        }
    }

    let mcpSection = '';
    if (request.attachedMcpTools && request.attachedMcpTools.length > 0) {
        mcpSection = '\n\n### ATTACHED MCP LIVE TOOLS:\n';
        for (const tool of request.attachedMcpTools) {
            mcpSection += `- Tool: \`${tool.name}\` (${tool.serverName}): ${tool.description}\n`;
        }
    }

    let contextGraphSection = '';
    if (request.enableSemanticGraph !== false) {
        try {
            const symResult = services.contextGraph.retrieveSymbolGraph({
                query: request.prompt,
                targetFiles: request.targetFiles,
                maxSymbols: 12
            });
            if (symResult && symResult.matchingSymbols.length > 0) {
                contextGraphSection += `\n\n### RELEVANT CODEBASE SYMBOLS & DEPENDENCY SUBGRAPH:\n${symResult.compressedPromptContext}\n`;
            }

            const slice = services.contextGraph.getContextSlice(undefined, { maxTokens: 1500, query: request.prompt });
            if (slice && slice.compressedPromptContext) {
                contextGraphSection += `\n\n### GLOBAL PROJECT CONTEXT GRAPH (MLA COMPACTED SLICE):\n${slice.compressedPromptContext}\n`;
            }
        } catch (err) {
            // Ignore context graph slicing errors
        }
    }

    let patternMatchingSection = '';
    if (request.enableFewShotPatterns !== false) {
        try {
            const wsRoot = request.workspaceRoot || process.cwd();
            const analysis = await services.patternEngine.analyzeWorkspacePatterns(wsRoot, { maxExemplars: 3 });
            if (analysis && analysis.summaryPromptContext) {
                patternMatchingSection = `\n\n### WORKSPACE ARCHITECTURAL CONVENTIONS & FEW-SHOT CODEBASE EXEMPLARS:\n${analysis.summaryPromptContext}\n`;
            }
        } catch (err) {
            // Ignore pattern matching errors
        }
    }

    let lspDiagnosticSection = '';
    if (request.enableLspDiagnostics !== false) {
        try {
            const diagPrompt = services.lsp.synthesizeDiagnosticFixPrompt(request.targetFiles);
            if (diagPrompt && (diagPrompt.errorCount > 0 || diagPrompt.warningCount > 0)) {
                lspDiagnosticSection = `\n\n### ACTIVE LSP & COMPILER DIAGNOSTICS FOR SELF-HEALING REPAIR:\n${diagPrompt.promptContext}\n`;
                if (diagPrompt.suggestedActions.length > 0) {
                    lspDiagnosticSection += `Suggested Diagnostic Actions:\n${diagPrompt.suggestedActions.map(a => `- ${a}`).join('\n')}\n`;
                }
            }
        } catch (err) {
            // Ignore lsp diagnostic errors
        }
    }

    let diffMemorySection = '';
    if (request.enableDiffMemory !== false) {
        try {
            const diffContext = services.diffMemory.buildDiffMemoryPromptContext({ maxTurns: 5 });
            if (diffContext && diffContext.fullPromptSection && (diffContext.recentTurnsSummary || diffContext.uncommittedChangesSummary)) {
                diffMemorySection = `\n\n### RECENT CODE MODIFICATIONS & MULTI-TURN DIFF HISTORY:\n${diffContext.fullPromptSection}\n`;
            }
        } catch (err) {
            // Ignore diff memory errors
        }
    }

    let memoriesSection = '';
    try {
        memoriesSection = await services.memories.buildPromptInjectionText();
    } catch (err) {
        // Ignore memory injection errors safely
    }

    let workspaceToolsSection = '';
    if (request.enableWorkspaceTools !== false) {
        workspaceToolsSection = `\n\n### NATIVE WORKSPACE TOOLS & AUTONOMOUS REACT ENVIRONMENT:
You have direct, sandboxed function-calling access to the developer's workspace and terminal.
Available workspace tools:
- workspace_read_file: Inspect disk contents and slice line ranges.
- workspace_write_file: Write or create files with full content.
- workspace_apply_diff: Apply surgical string replacement patches to existing files.
- workspace_list_directory: Explore file hierarchy up to maxDepth with standard ignores.
- workspace_search: Search workspace files for exact tokens or regex patterns.
- workspace_run_command: Execute terminal commands (build, test, lint, run) inside the secure container sandbox.
- workspace_get_diagnostics: Retrieve compiler and LSP error/warning diagnostics across files.
- workspace_find_symbols: Query AST symbol graph for definitions and references.
- lens_project / lens_unproject / lens_sync: Synchronize visual canvas primitives with code files on disk.

When requested to inspect, modify, build, or test code, prefer actively calling these workspace tools first. After executing tools and receiving tool responses, provide clear reasoning and synthesize an artifact or solution for the user.`;
    }

    return `${primitiveDescriptions}${superpowersSection}${mcpSection}${contextGraphSection}${patternMatchingSection}${lspDiagnosticSection}${diffMemorySection}${memoriesSection}${workspaceToolsSection}\n\nDeliver insightful, Cupertino-grade results. Output a friendly intro explanation followed by the complete \`\`\`json codeblock.`;
}

/**
 * Build message contents array for Vertex AI and AI Prompt Compiler.
 */
export function buildContents(request: GeminiGenerateRequest): Content[] {
    const contents: Content[] = [];

    if (request.chatHistory && request.chatHistory.length > 0) {
        for (const msg of request.chatHistory) {
            contents.push({
                role: msg.role === 'model' ? 'model' : 'user',
                parts: [{ text: msg.text }]
            });
        }
    }

    let userPrompt = request.prompt;
    if (request.activeArtifact) {
        userPrompt += `\n\n[Active Canvas Stage Context: Artifact Title: "${request.activeArtifact.title}", Type: "${request.activeArtifact.type}"]`;
        if (request.activeArtifact.type === 'markdown-document' && request.activeArtifact.data) {
            const docData = request.activeArtifact.data as MarkdownDocumentData;
            userPrompt += `\n[Active Document Content: ${JSON.stringify({ title: docData.title, sections: docData.sections }).slice(0, 3000)}]`;
        } else if (request.activeArtifact.type === '3d-scene' && request.activeArtifact.data) {
            const sceneData = request.activeArtifact.data as Scene3DData;
            const objectsSummary = (sceneData.customMeshes || []).map(m => ({
                id: m.id,
                name: m.name || m.id,
                type: m.type,
                position: m.position,
                rotation: m.rotation,
                scale: m.scale,
                material: m.material
            }));
            const media4dSummary = (sceneData.objects || []).map(o => ({
                id: o.id,
                space: o.space?.spatial3d,
                dims: o.content?.metadata?.dims
            }));
            const sceneSummary = {
                title: sceneData.title,
                subtitle: sceneData.subtitle,
                renderMode: sceneData.renderMode,
                camera: sceneData.camera,
                environment: sceneData.environment,
                sculptSettings: sceneData.sculptSettings,
                features: sceneData.features,
                customMeshes: objectsSummary,
                objects: media4dSummary,
                recentOperators: (sceneData.operatorStack || []).slice(-10)
            };
            userPrompt += `\n[Active 3D Scene In-Memory State: ${JSON.stringify(sceneSummary).slice(0, 5000)}]`;
        }
    }

    contents.push({
        role: 'user',
        parts: [{ text: userPrompt }]
    });

    return contents;
}
