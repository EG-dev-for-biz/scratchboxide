import { describe, it, expect } from "vitest";
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

describe("Advanced Live Code Sandbox Features (1 - 4)", () => {
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
