/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/
import { GeminiService } from '../gemini-service';
import { UserLearningService } from './user-learning-service';
import { DiscoveredGoalPlan, PlatformDomain } from '../../common/deep-write/deep-write-protocol';
export class GoalAnalyzer {
    constructor(
        protected readonly geminiService: GeminiService,
        protected readonly learningService: UserLearningService
    ) {}

    /**
     * Analyze a boundless user prompt/goal and return a highly structured DiscoveredGoalPlan.
     */
    public async analyzeGoal(
        prompt: string,
        workspaceRoot?: string,
        activeArtifactSummary?: string
    ): Promise<DiscoveredGoalPlan> {
        // Retrieve learned user preferences
        const preferences = await this.learningService.getUserPreferences(workspaceRoot);
        
        const systemInstruction = `You are the Strategic Meta-Architect and Project Formulator of the Scratchbox IDE.
Your task is to analyze an unconstrained, boundless user prompt/goal and output a highly structured project plan conforming strictly to the requested JSON format.

Supported platform domains:
- 'web': Modern React/Next.js UI, layouts, Tailwind CSS.
- 'mobile': iOS Swift, Android Kotlin, React Native, or Flutter.
- 'desktop': Electron, Tauri, or C++ Qt apps.
- 'cloud_backend': Cloud services (Go, Rust, Python FastAPI, Docker, Kubernetes).
- 'native_systems': Low-level system code, performance models (C, C++, Rust, Zig, Make, CMake).
- 'spatial_3d': Interactive 3D graphics (Three.js WebGL/WebGPU shaders, WGSL, GLSL, procedurals).
- 'cross_platform': Bridges and FFI between multiple domains (e.g. C++ physics bridge to iOS/Android).
- 'universal': Multi-layer systems spanning frontend, backend, and low-level Native.

Based on the prompt, decide:
1. Which platform domains apply (array).
2. What target files should be created/scaffolded.
3. What scratchbox canvas primitives are ideal to express this goal. Supported primitives:
   - '3d-scene': For rendering spatial WebGL/WebGPU graphics.
   - 'live-code-sandbox': For writing and running code/scripts (Three.js, C++ WebAssembly, HTML, JS).
   - 'markdown-document': For specs, RFCs, documentation, math derivations.
   - 'node-graph': For system module topologies, dependency charts, narrative arcs.
   - 'kanban-board': For phased milestone tracking and sprints.
   - 'metric-dashboard': For KPI metrics, physics statistics, benchmarking charts.
4. Construct a sequence of specialized stages (dynamic pipeline) to execute this plan. Each stage should represent a logical milestone, specify an agent role (e.g. 'researcher', 'system_architect', 'graphics_engineer', 'wasm_integrator', 'quality_assurance'), and determine if it's a checkpoint for human feedback.

Injected User Style/Preferences:
- Preferred Languages: ${preferences.languages.join(', ')}
- Preferred Platforms: ${preferences.platforms.join(', ')}
- Preferred Coding Style: ${preferences.codingStyle || 'Standard idiomatic conventions'}

You MUST respond with a single valid JSON object containing no markdown codeblocks, following this exact schema:
{
  "goal": "Brief summary of the target goal",
  "domains": ["web", "spatial_3d", ...],
  "deliverables": {
    "filePaths": ["src/main.cpp", "shaders/mesh.wgsl", ...],
    "primitives": ["3d-scene", "live-code-sandbox", "markdown-document", ...],
    "config": {
      "platforms": ["spatial_3d", "native_systems"],
      "languages": ["cpp", "typescript"],
      "toolchain": "cmake", // npm, yarn, cargo, gradle, swiftpm, go, cmake, none
      "environment": "wasm" // sandbox, wasm, container, webgpu, none
    }
  },
  "stages": [
    {
      "id": "requirements_stage",
      "name": "Phase 1: Scope & Setup",
      "stage": "01_requirements",
      "description": "Establish core simulation boundaries, viewport scale, and environment style",
      "assignedAgentRole": "system_architect",
      "isCheckpoint": true
    },
    ...
  ],
  "analysisReasoning": "Your concise strategic rationale explaining the architectural decisions, toolchain choices, and platform selections."
}
`;

        const contextInfo = activeArtifactSummary ? `Active Canvas State: ${activeArtifactSummary}` : '';
        const userPrompt = `User Prompt/Goal: "${prompt}"\n${contextInfo}\nGenerate the complete structured JSON project plan.`;

        let accumulatedText = '';
        try {
            await this.geminiService.streamGenerate(
                {
                    prompt: userPrompt,
                    systemInstruction,
                    model: 'gemini-3.7-flash',
                    temperature: 0.1, // low temperature for high JSON structure accuracy
                    thinkingBudget: 512
                },
                event => {
                    if (event.text) {
                        accumulatedText += event.text;
                    }
                }
            );
        } catch (err) {
            console.error('[GoalAnalyzer] Failed to stream generate goal plan:', err);
            throw err;
        }

        // Extract JSON block if surrounded by prose or code blocks
        const cleaned = accumulatedText.trim();
        let jsonStr = cleaned;
        const codeBlockMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
        if (codeBlockMatch) {
            jsonStr = codeBlockMatch[1].trim();
        } else {
            const objectMatch = cleaned.match(/\{[\s\S]*\}/);
            if (objectMatch) {
                jsonStr = objectMatch[0].trim();
            }
        }

        try {
            const plan = JSON.parse(jsonStr) as DiscoveredGoalPlan;
            if (!plan.domains || plan.domains.length === 0) {
                plan.domains = ['web'];
            }
            if (!plan.deliverables || !plan.deliverables.primitives) {
                plan.deliverables = {
                    filePaths: [],
                    primitives: ['markdown-document'],
                    config: {
                        platforms: ['web'],
                        languages: ['typescript'],
                        toolchain: 'none',
                        environment: 'none'
                    }
                };
            }
            if (!plan.stages || plan.stages.length === 0) {
                plan.stages = this.generateFallbackStages(plan.domains, prompt);
            }
            return plan;
        } catch (parseErr) {
            console.warn('[GoalAnalyzer] Falling back to heuristic plan synthesis. Raw Text:', cleaned);
            return this.generateFallbackGoalPlan(prompt, preferences);
        }
    }

    private generateFallbackGoalPlan(prompt: string, preferences: any): DiscoveredGoalPlan {
        const lower = prompt.toLowerCase();
        const is3D = lower.includes('3d') || lower.includes('wasm') || lower.includes('physics') || lower.includes('spatial') || lower.includes('simulation') || lower.includes('jet') || lower.includes('aircraft');
        const isNative = lower.includes('c++') || lower.includes('cpp') || lower.includes('rust') || lower.includes('native') || lower.includes('engine');
        const isMobile = lower.includes('ios') || lower.includes('android') || lower.includes('swift') || lower.includes('kotlin') || lower.includes('mobile');
        const isBackend = lower.includes('backend') || lower.includes('api') || lower.includes('go') || lower.includes('python') || lower.includes('cloud');

        const domains: PlatformDomain[] = [];
        if (is3D) domains.push('spatial_3d');
        if (isNative) domains.push('native_systems');
        if (isMobile) domains.push('mobile');
        if (isBackend) domains.push('cloud_backend');
        if (domains.length === 0) domains.push('web');

        const primitives: any[] = ['markdown-document'];
        if (is3D) {
            primitives.push('3d-scene');
            primitives.push('live-code-sandbox');
        } else if (isNative || isBackend) {
            primitives.push('live-code-sandbox');
            primitives.push('node-graph');
        } else {
            primitives.push('live-code-sandbox');
            primitives.push('kanban-board');
        }

        const stages = this.generateFallbackStages(domains, prompt);

        return {
            goal: prompt.length > 80 ? `${prompt.slice(0, 77)}...` : prompt,
            domains,
            deliverables: {
                filePaths: is3D ? ['src/engine.cpp', 'include/engine.hpp', 'shaders/custom_mesh.glsl', 'src/scene.ts'] : ['src/main.ts', 'docs/spec.md'],
                primitives,
                config: {
                    platforms: domains,
                    languages: preferences.languages?.length ? preferences.languages : (isNative ? ['cpp'] : ['typescript']),
                    toolchain: isNative ? 'cmake' : 'npm',
                    environment: is3D ? 'wasm' : 'sandbox'
                }
            },
            stages,
            analysisReasoning: `Heuristic adaptive formulation for ${domains.join(', ')} project, targeting ${primitives.join(', ')} primitives.`
        };
    }

    private generateFallbackStages(domains: PlatformDomain[], prompt: string): any[] {
        const is3D = domains.includes('spatial_3d');
        return [
            {
                id: 'requirements_stage',
                name: 'Phase 1: Project Scope & Architecture',
                stage: '01_requirements',
                description: 'Decompose core architecture boundaries, target platforms, and coordinate system constraints.',
                assignedAgentRole: 'system_architect',
                isCheckpoint: true
            },
            {
                id: 'scaffolding_stage',
                name: 'Phase 2: Platform Scaffolding & Directory Tree',
                stage: '02_scaffolding',
                description: 'Generate multi-platform source files, headers, and build manifests.',
                assignedAgentRole: 'codebase_architect',
                isCheckpoint: false
            },
            {
                id: is3D ? 'aerodynamics_stage' : 'logic_stage',
                name: is3D ? 'Phase 3: Computational Physics & Solvers' : 'Phase 3: Core Domain Implementation',
                stage: '03_core_implementation',
                description: is3D ? 'Synthesize C++ aerodynamics/physics solvers and WebAssembly bindings.' : 'Implement primary business logic and interface contracts.',
                assignedAgentRole: is3D ? 'wasm_integrator' : 'domain_engineer',
                isCheckpoint: false
            },
            {
                id: 'qa_stage',
                name: 'Phase 4: Compilation Telemetry & Final Delivery',
                stage: '04_qa_delivery',
                description: 'Verify compilation integrity, check for runtime errors, and spawn canvas artifacts.',
                assignedAgentRole: 'quality_assurance',
                isCheckpoint: false
            }
        ];
    }
}
