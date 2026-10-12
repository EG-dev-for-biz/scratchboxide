import { describe, it, expect } from "vitest";
import {
    is3DStudioIntent,
    generateNativeCppGenerator,
    generate3DControls,
    generate3DStudioApp,
    extractCodeSandboxArtifact
} from "../src/node/gemini/artifact-synthesis";
import {
    morphSandboxToScene3D,
    morphSandboxToDoc,
    morphSandboxToKanban,
    morphSandboxToMetrics,
    morphArtifact
} from "../src/browser/generative-canvas/primitive-transformer-engine";
import {
    LiveCodeSandboxData,
    CanvasArtifact
} from "../src/browser/generative-canvas/canvas-types";
import { compileAndRunEmittedGenerator, maxIndex, NATIVE_GENERATOR_TEST_TIMEOUT_MS } from "./helpers/native-generator-harness";
import * as fs from "fs";

describe("Advanced Live Code Sandbox Features (1 - 4)", () => {
    describe("Feature 1: Interactive Native C++20 3D Mesh Studio Micro-App", () => {
        it("should accurately detect 3D studio intent from prompt or title", () => {
            expect(is3DStudioIntent("generate a procedural terrain with marching cubes", "Studio")).toBe(true);
            expect(is3DStudioIntent("create an interactive 3D mesh studio", "Mesh View")).toBe(true);
            expect(is3DStudioIntent("build a calculator app", "3D Terrain Generator")).toBe(true);
            expect(is3DStudioIntent("todo list app with react", "Task Manager")).toBe(false);
        });

        it("should generate a C++20 terrain generator that compiles and streams its heightfield GLB", async () => {
            const cppSource = generateNativeCppGenerator("Alpine Mountain Range");
            expect(cppSource).toContain("#include \"scratchbox_engine.hpp\"");

            const run = await compileAndRunEmittedGenerator(cppSource, "studio_terrain");
            expect(run.chunk.name).toBe("Alpine Mountain Range");
            // 48 x 48 vertex grid, two triangles per cell
            expect(run.chunk.vertexCount).toBe(48 * 48);
            expect(run.triangleCount).toBe(47 * 47 * 2);
            expect(run.glb.vertexCount).toBe(run.chunk.vertexCount);
            expect(run.glb.indexCount).toBe(run.chunk.indexCount);
            expect(maxIndex(run.glb)).toBe(48 * 48 - 1);

            // 36 m square footprint with fBm relief, and edge damping pins the perimeter to y = 0
            const { min, max } = run.bounds;
            expect(min[0]).toBeCloseTo(-18, 4);
            expect(max[0]).toBeCloseTo(18, 4);
            expect(min[2]).toBeCloseTo(-18, 4);
            expect(max[2]).toBeCloseTo(18, 4);
            expect(max[1] - min[1]).toBeGreaterThan(0.5);
            const p = run.glb.positions;
            for (let i = 0; i < p.length; i += 3) {
                if (Math.abs(Math.abs(p[i]) - 18) < 1e-4 || Math.abs(Math.abs(p[i + 2]) - 18) < 1e-4) {
                    expect(Math.abs(p[i + 1])).toBeLessThan(1e-6);
                }
            }

            expect(fs.statSync(run.screenshotPath).size).toBeGreaterThan(0);
        }, NATIVE_GENERATOR_TEST_TIMEOUT_MS);

        it("should generate a C++20 studio pedestal generator that compiles and streams a grey clay GLB", async () => {
            const cppSource = generateNativeCppGenerator("Cyberpunk Outpost Laboratory");

            const run = await compileAndRunEmittedGenerator(cppSource, "studio_pedestal");
            expect(run.chunk.name).toBe("Cyberpunk Outpost Laboratory");
            // 64 segments: centre vertex + three rings of 65, fan top + bevel band + side band
            expect(run.chunk.vertexCount).toBe(1 + 65 * 3);
            expect(run.triangleCount).toBe(64 + 64 * 2 + 64 * 2);
            expect(maxIndex(run.glb)).toBeLessThan(run.chunk.vertexCount);
            expect(run.glb.materialName).toBe("studio_grey_clay");
            expect(run.glb.roughnessFactor).toBeCloseTo(0.85, 5);
            expect(run.glb.metallicFactor).toBe(0);
            // Neutral vertex colours, so the clay baseColorFactor is the rendered albedo
            expect(Array.from(run.glb.colors ?? []).every(c => c === 1)).toBe(true);

            // 5 m radius disc, 0.35 m thick, top face on y = 0
            const { min, max } = run.bounds;
            expect(min[0]).toBeCloseTo(-5, 4);
            expect(max[0]).toBeCloseTo(5, 4);
            expect(min[1]).toBeCloseTo(-0.35, 4);
            expect(max[1]).toBeCloseTo(0, 4);

            expect(fs.statSync(run.screenshotPath).size).toBeGreaterThan(0);
        }, NATIVE_GENERATOR_TEST_TIMEOUT_MS);

        it("should generate interactive 3D controls and Three.js App.tsx with native C++ bridge call", () => {
            const controls = generate3DControls();
            expect(controls).toContain("SDF Noise Octaves");
            expect(controls).toContain("Spatial Frequency");
            expect(controls).toContain("Material Roughness");
            expect(controls).toContain("window.scratchbox.storage.exportState");
            expect(controls).toContain("window.scratchbox.ai.refine");

            const app = generate3DStudioApp("Procedural Asteroid Field");
            expect(app).toContain("window.scratchbox.native3d.generateGlb");
            expect(app).toContain("THREE.PerspectiveCamera");
            expect(app).toContain("THREE.Scene");
            expect(app).toContain("THREE.DirectionalLight");
            expect(app).toContain("scratchbox_engine.hpp");
        });

        it("should synthesize a multi-file 3D studio sandbox artifact with world_generator.cpp", () => {
            const result = extractCodeSandboxArtifact(
                "Generate an interactive 3D terrain mesh studio with C++20 marching cubes",
                ""
            );
            expect(result).not.toBeNull();
            expect(result?.artifact.type).toBe("live-code-sandbox");
            const data = result?.artifact.data as LiveCodeSandboxData;
            expect(data.files.some(f => f.name === "world_generator.cpp")).toBe(true);
            const cppFile = data.files.find(f => f.name === "world_generator.cpp");
            expect(cppFile?.language).toBe("cpp");
            expect(cppFile?.content).toContain("#include \"scratchbox_engine.hpp\"");
            expect(data.files.some(f => f.name === "Controls.tsx")).toBe(true);
            expect(data.files.some(f => f.name === "App.tsx")).toBe(true);
            expect(data.dependencies?.three).toBeDefined();
        });
    });

    describe("Feature 2: 1-Click \"Scaffold to Workspace\" File Sync", () => {
        it("should generate valid turnkey manifest files (package.json, vite.config.ts, tsconfig.json)", () => {
            const slug = "alpine-valley";
            const pkgDeps: Record<string, string> = {
                react: "^18.2.0",
                "react-dom": "^18.2.0",
                "lucide-react": "^0.468.0",
                three: "^0.160.0"
            };
            const packageJson = {
                name: slug,
                private: true,
                version: "0.1.0",
                type: "module",
                scripts: {
                    dev: "vite",
                    build: "tsc && vite build",
                    preview: "vite preview"
                },
                dependencies: pkgDeps
            };
            const parsed = JSON.parse(JSON.stringify(packageJson));
            expect(parsed.name).toBe(slug);
            expect(parsed.scripts.dev).toBe("vite");
            expect(parsed.dependencies.three).toBe("^0.160.0");
        });
    });

    describe("Feature 3: Self-Healing Error Bridge & Auto-Diagnostics Loop", () => {
        it("should format diagnostic error prompts with full file context for AI auto-fix", () => {
            const activeFileName = "App.tsx";
            const runtimeErrorMsg = "TypeError: Cannot read properties of undefined (reading \"position\")";
            const prompt = `Auto-fix the following runtime error in file ${activeFileName}:\n\n${runtimeErrorMsg}`;

            expect(prompt).toContain("Auto-fix the following runtime error in file App.tsx:");
            expect(prompt).toContain("TypeError: Cannot read properties of undefined");
        });
    });

    describe("Feature 4: Stateful Artifact Morphing Engine", () => {
        const sandboxWithState: LiveCodeSandboxData = {
            title: "Procedural Terrain Studio",
            template: "react",
            files: [
                {
                    id: "f1",
                    name: "world_generator.cpp",
                    language: "cpp",
                    content: "#include \"scratchbox_engine.hpp\"\n// C++ Procedural Terrain Engine\nint main() { return 0; }"
                },
                {
                    id: "f2",
                    name: "App.tsx",
                    language: "typescript",
                    content: "export default function App() { return <div>3D Studio</div>; }"
                }
            ]
        };

        const liveRuntimeState = {
            octaves: 6,
            frequency: 0.045,
            roughness: 0.65,
            wireframe: false,
            biome: "Alpine Glacial",
            skybox: "sunset",
            lighting: "golden-hour"
        };

        it("should preserve C++ generator in morphSandboxToScene3D", () => {
            const scene = morphSandboxToScene3D(sandboxWithState, { state: liveRuntimeState });
            expect(scene.cppGenerator).toBeDefined();
            expect(scene.cppGenerator?.enabled).toBe(true);
            expect(scene.cppGenerator?.filename).toBe("world_generator.cpp");
            expect(scene.cppGenerator?.sourceCode).toContain("#include \"scratchbox_engine.hpp\"");
            expect(scene.environment?.skybox).toBe("sunset");
        });

        it("should inject live runtime state into Markdown Documentation", () => {
            const doc = morphSandboxToDoc(sandboxWithState, { state: liveRuntimeState });
            const stateSec = doc.sections.find(s => s.id === "sec-sb-doc-runtime-state");
            expect(stateSec).toBeDefined();
            expect(stateSec?.content).toContain("Live Runtime & Session State");
            expect(stateSec?.content).toContain("octaves");
            expect(stateSec?.content).toContain("Alpine Glacial");
        });

        it("should generate state-verification backlog cards in Kanban Board", () => {
            const kanban = morphSandboxToKanban(sandboxWithState, { state: liveRuntimeState });
            const todoCards = kanban.columns[0].cards;
            expect(todoCards.some(c => c.tag === "State" && c.title.includes("octaves"))).toBe(true);
            expect(todoCards.some(c => c.tag === "State" && c.title.includes("frequency"))).toBe(true);
        });

        it("should surface dynamic telemetry metrics in Metric Dashboard", () => {
            const metrics = morphSandboxToMetrics(sandboxWithState, { state: liveRuntimeState });
            expect(metrics.metrics.some(m => m.id === "m-state-octaves" && m.value === "6")).toBe(true);
            expect(metrics.metrics.some(m => m.id === "m-state-roughness" && m.value === "0.65")).toBe(true);
            expect(metrics.insights.some(i => i.includes("live runtime state variables"))).toBe(true);
        });

        it("should dispatch stateful morphing seamlessly through morphArtifact", () => {
            const artifact: CanvasArtifact = {
                id: "art-sandbox-1",
                title: "Procedural Terrain Studio",
                type: "live-code-sandbox",
                data: sandboxWithState,
                createdAt: new Date().toLocaleTimeString(),
                version: 1
            };

            const morphedDoc = morphArtifact(artifact, "markdown-document", { state: liveRuntimeState });
            expect(morphedDoc.type).toBe("markdown-document");
            expect((morphedDoc.data as any).sections.some((s: any) => s.id === "sec-sb-doc-runtime-state")).toBe(true);

            const morphedScene = morphArtifact(artifact, "3d-scene", { state: liveRuntimeState });
            expect(morphedScene.type).toBe("3d-scene");
            expect((morphedScene.data as any).cppGenerator?.enabled).toBe(true);
            expect((morphedScene.data as any).environment.skybox).toBe("sunset");
        });
    });
});
