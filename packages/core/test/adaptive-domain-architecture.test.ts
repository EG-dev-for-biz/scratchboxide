import { describe, it, expect } from "vitest";
import {
    classifyDomain,
    extractPromptEntities,
    synthesizeAdaptiveKanban,
    synthesizeAdaptiveMetrics,
    synthesizeAdaptiveNodeGraph,
    synthesizeAdaptiveSandbox,
    synthesizeAdaptiveVideoTimeline,
    synthesizeAdaptive3DScene
} from "../src/browser/generative-canvas/services/adaptive-domain-engine";
import {
    morphDocToChecklistKanban,
    morphDocToMetrics,
    morphDocToNodeGraph,
    morphDocToSandbox
} from "../src/browser/generative-canvas/primitive-transformer-engine";
import {
    generateAdaptiveSandboxCode,
    synthesizeKanbanFallback,
    synthesizeGraphFallback,
    synthesizeMetricsFallback
} from "../src/browser/generative-canvas/hooks/sendMessageFallbacks";
import { synthesizeContextual3DScene } from "../src/browser/generative-canvas/procedural-3d-synthesizer";
import { synthesizeContextualVideoTimeline } from "../src/browser/generative-canvas/services/video/videoTimelineSynthesizer";
import type { MarkdownDocumentData } from "../src/browser/generative-canvas/canvas-types";

describe("Antigravity-Style Adaptive Domain Architecture", () => {
    describe("Semantic Domain Classifier & Entity Extractor", () => {
        it("accurately extracts domain keywords without restricting open-ended classification", () => {
            expect(classifyDomain("James Webb Space Telescope exoplanet transit spectroscopy")).toBe("astrophysics");
            expect(classifyDomain("CRISPR-Cas9 guide RNA gene knockout and protein folding kinetics")).toBe("biology");
            expect(classifyDomain("ICU patient cardiac monitor telemetry and arrhythmia tracking")).toBe("healthcare");
            expect(classifyDomain("Unreal Engine 5 ragdoll physics character collider mechanics")).toBe("game-dev");
            expect(classifyDomain("Harmonic audio synthesizer filter cutoff frequency sound design")).toBe("creative-arts");
            expect(classifyDomain("SaaS annual recurring revenue churn retention EBITDA projections")).toBe("business");
            expect(classifyDomain("Roman Empire legionary tactics during the Punic wars in ancient antiquity")).toBe("history");
            expect(classifyDomain("A simple note about miscellaneous things")).toBe("general");
        });

        it("extracts rich prompt entities (subject, action, keywords) from natural language", () => {
            const entities = extractPromptEntities("Autonomous robotic rover navigation and obstacle avoidance across Martian terrain");
            expect(entities.subject).toContain("Autonomous robotic rover");
            expect(entities.action).toBe("navigation");
            expect(entities.keywords.length).toBeGreaterThanOrEqual(3);
        });
    });

    describe("Zero-Preset Schema-Guided Synthesizers", () => {
        it("synthesizes adaptive Kanban board parameterized by prompt entities rather than static presets", () => {
            const kanban = synthesizeAdaptiveKanban("astrophysics", "JWST Mission Roadmap", "Exoplanet transit spectroscopy observation");
            expect(kanban.columns.length).toBeGreaterThanOrEqual(3);
            expect(kanban.title).toBe("JWST Mission Roadmap");
            const allCards = kanban.columns.flatMap(c => c.cards);
            expect(allCards.some(card => card.title.includes("Exoplanet") || card.description.includes("Exoplanet") || card.description.includes("JWST"))).toBe(true);
            for (const col of kanban.columns) {
                expect(col.id).toBeDefined();
                expect(col.title).toBeDefined();
                expect(Array.isArray(col.cards)).toBe(true);
            }
        });

        it("synthesizes adaptive metrics parameterized by prompt entities with dynamic KPIs", () => {
            const metrics = synthesizeAdaptiveMetrics("biology", "CRISPR Target Efficacy", "Guide RNA cleavage efficiency analysis");
            expect(metrics.metrics.length).toBeGreaterThanOrEqual(4);
            expect(metrics.title).toBe("CRISPR Target Efficacy");
            expect(metrics.metrics.some(m => m.label.includes("Target Efficacy") || m.label.includes("Reliability") || m.label.includes("Yield"))).toBe(true);
            expect(metrics.chart).toBeDefined();
            expect(metrics.chart.data.length).toBeGreaterThanOrEqual(4);
            expect(metrics.insights.length).toBeGreaterThanOrEqual(2);
        });

        it("synthesizes adaptive node graph with DAG structure tailored to the workflow", () => {
            const graph = synthesizeAdaptiveNodeGraph("game-dev", "Physics Simulation Pipeline", "Rigid body collider ingestion and solver");
            expect(graph.nodes.length).toBeGreaterThanOrEqual(4);
            expect(graph.edges.length).toBeGreaterThanOrEqual(3);
            expect(graph.title).toBe("Physics Simulation Pipeline");
            expect(graph.nodes.some(n => n.category === "input")).toBe(true);
            expect(graph.nodes.some(n => n.category === "process")).toBe(true);
            expect(graph.nodes.some(n => n.category === "output")).toBe(true);
        });

        it("synthesizes adaptive video timeline with multi-track layout", () => {
            const timeline = synthesizeAdaptiveVideoTimeline("creative-arts", "Symphonic Music Video", "Multi-camera concert orchestra capture");
            expect(timeline.tracks.length).toBeGreaterThanOrEqual(3);
            expect(timeline.title).toBe("Symphonic Music Video");
            expect(timeline.tracks.some(t => t.type === "video")).toBe(true);
            expect(timeline.tracks.some(t => t.type === "audio")).toBe(true);
        });

        it("synthesizes adaptive 3D scene with PBR materials and spatial geometry", () => {
            const scene = synthesizeAdaptive3DScene("astrophysics", "Exoplanet Transit System", "Deep space planetary orbital system");
            expect(scene.renderMode).toBe("pbr");
            expect(scene.environment?.skybox).toBe("deep_space");
            expect(scene.customMeshes?.length).toBeGreaterThanOrEqual(2);
        });
    });

    describe("Subsystem 1 & 2: Procedural 3D & Video Timeline Integration", () => {
        it("synthesizes contextual 3D scene for space prompt", () => {
            const scene = synthesizeContextual3DScene("Exoplanetary Keplerian orbital mechanics simulation");
            expect(scene.environment?.skybox).toBe("deep_space");
            expect(scene.customMeshes?.length).toBeGreaterThanOrEqual(1);
        });

        it("synthesizes contextual video tracks for prompt", () => {
            const timeline = synthesizeContextualVideoTimeline("Hubble Deep Field James Webb telescope visualization");
            expect(timeline.tracks.length).toBeGreaterThanOrEqual(2);
            expect(timeline.tracks.some(t => t.type === "video")).toBe(true);
        });
    });

    describe("Subsystem 3: Grounded AST Document Morphing (Zero Fake Presets)", () => {
        it("morphs document with explicit checklist items strictly into user tasks without fake domain injection", () => {
            const doc: MarkdownDocumentData = {
                title: "CRISPR Cas9 Gene Knockout Protocol",
                sections: [
                    {
                        id: "s1",
                        type: "text",
                        title: "Phase 1 Preparation",
                        checklistItems: [
                            { id: "item-1", text: "Order Oligonucleotides from IDT", done: false },
                            { id: "item-2", text: "Autoclave LB broth and pipette tips", done: true }
                        ]
                    }
                ]
            };
            const kanban = morphDocToChecklistKanban(doc);
            const allCards = kanban.columns.flatMap(c => c.cards);
            expect(allCards.length).toBe(2);
            expect(allCards.some(c => c.title === "Order Oligonucleotides from IDT")).toBe(true);
            expect(allCards.some(c => c.title === "Autoclave LB broth and pipette tips")).toBe(true);
            expect(allCards.some(c => c.title.includes("Keplerian"))).toBe(false);
            expect(allCards.some(c => c.title.includes("In Silico Screen"))).toBe(false);
        });

        it("morphs document with markdown checkboxes strictly into authentic Kanban cards", () => {
            const doc: MarkdownDocumentData = {
                title: "Space Mission Launch Readiness",
                sections: [
                    {
                        id: "s1",
                        type: "text",
                        title: "Pre-flight Checklist",
                        content: "- [ ] Cryogenic propellant loading\n- [x] Avionics telemetry lock verified\n- [ ] Range safety radar handshake"
                    }
                ]
            };
            const kanban = morphDocToChecklistKanban(doc);
            const allCards = kanban.columns.flatMap(c => c.cards);
            expect(allCards.length).toBe(3);
            expect(allCards.some(c => c.title === "Cryogenic propellant loading")).toBe(true);
            expect(allCards.some(c => c.title === "Avionics telemetry lock verified")).toBe(true);
            expect(allCards.some(c => c.title === "Range safety radar handshake")).toBe(true);
        });

        it("morphs document with text and metrics into authentic KPIs without fake domain override", () => {
            const doc: MarkdownDocumentData = {
                title: "James Webb Exoplanet Transit Analysis",
                sections: [
                    {
                        id: "s1",
                        type: "text",
                        title: "Observational Metrics",
                        content: "Transit Depth = 1.45%.\nOrbital Period: 3.2 days.\nSignal SNR: 48.2 dB."
                    }
                ]
            };
            const metrics = morphDocToMetrics(doc);
            expect(metrics.metrics.some(m => m.label === "Spec Completeness")).toBe(true);
            expect(metrics.metrics.some(m => m.label === "Document Sections")).toBe(true);
            expect(metrics.metrics.some(m => m.value.includes("1.45%") || m.value.includes("3.2 days") || m.value.includes("48.2 dB"))).toBe(true);
            expect(metrics.metrics.some(m => m.label.includes("AlphaFold pLDDT"))).toBe(false);
        });

        it("morphs empty spec document gracefully via dynamic synthesizer", () => {
            const doc: MarkdownDocumentData = {
                title: "Quantum Key Distribution Architecture",
                sections: []
            };
            const kanban = morphDocToChecklistKanban(doc);
            expect(kanban.columns.length).toBeGreaterThanOrEqual(3);
            expect(kanban.title).toContain("Quantum Key");

            const metrics = morphDocToMetrics(doc);
            expect(metrics.metrics.length).toBeGreaterThanOrEqual(4);
            expect(metrics.title).toContain("Quantum Key");

            const sandbox = morphDocToSandbox(doc);
            expect(sandbox.files.length).toBeGreaterThanOrEqual(1);
            expect(sandbox.files[0].content).toContain("Quantum Key");
        });
    });

    describe("Subsystem 4 & 5: sendMessageFallbacks Dynamic Titles & Synthesis", () => {
        it("generates prompt-adaptive React code in generateAdaptiveSandboxCode", () => {
            const code = generateAdaptiveSandboxCode("Keplerian planetary orbital mechanics", "Orbital Engine");
            expect(code).toContain("Orbital Engine");
            expect(code).toContain("useState");
        });

        it("synthesizes prompt-derived dynamic title in synthesizeKanbanFallback", () => {
            const result = synthesizeKanbanFallback("Sourdough fermentation schedule", "sourdough fermentation schedule", undefined);
            const board = result.artifact.data as any;
            expect(board.title).toContain("Sourdough");
            expect(board.title).not.toContain("GENERAL");
            expect(board.columns.length).toBeGreaterThanOrEqual(3);
        });

        it("synthesizes prompt-derived dynamic title in synthesizeGraphFallback", () => {
            const result = synthesizeGraphFallback("Ancient Greek inscription epigraphy", "ancient greek inscription epigraphy", undefined);
            const graph = result.artifact.data as any;
            expect(graph.title).toContain("Ancient Greek");
            expect(graph.title).not.toContain("GENERAL");
            expect(graph.nodes.length).toBeGreaterThanOrEqual(4);
        });

        it("synthesizes prompt-derived dynamic title in synthesizeMetricsFallback", () => {
            const fakeArtifact: any = {
                id: "art-1",
                type: "metric-dashboard",
                title: "Deep Ocean Trench Bathymetry Telemetry",
                data: { title: "Deep Ocean Trench Bathymetry Telemetry", metrics: [] }
            };
            const result = synthesizeMetricsFallback(fakeArtifact);
            const metrics = result.artifact.data as any;
            expect(metrics.title).toContain("Deep Ocean");
            expect(metrics.title).not.toContain("GENERAL");
            expect(metrics.metrics.length).toBeGreaterThanOrEqual(4);
        });
    });

    describe("Modern AI Way: Zero-Preset & Schema-Guided Generation for Novel Domains", () => {
        it("synthesizes open-ended Kanban board for novel unconstrained domain (Brewing Science)", () => {
            const kanban = synthesizeAdaptiveKanban(
                "brewing-science",
                "Belgian Lambic Spontaneous Fermentation",
                "wild Brettanomyces yeast barrel aging and blending protocol"
            );
            expect(kanban.columns.length).toBeGreaterThanOrEqual(3);
            expect(kanban.columns[0].cards.length).toBeGreaterThan(0);
            expect(kanban.title).toContain("Belgian Lambic");
        });

        it("synthesizes open-ended Metrics dashboard for novel unconstrained domain (Quantum Cryptography)", () => {
            const metrics = synthesizeAdaptiveMetrics(
                "quantum-cryptography",
                "BB84 Quantum Key Distribution Telemetry",
                "single-photon quantum state polarization error tracking"
            );
            expect(metrics.metrics.length).toBeGreaterThanOrEqual(4);
            expect(metrics.title).toContain("BB84");
            expect(metrics.insights.length).toBeGreaterThan(0);
        });

        it("synthesizes open-ended Node Graph for novel unconstrained domain (Agricultural Robotics)", () => {
            const graph = synthesizeAdaptiveNodeGraph(
                "agricultural-robotics",
                "Autonomous Crop Harvesting Pipeline",
                "computer vision fruit detection and soft-gripper articulation"
            );
            expect(graph.nodes.length).toBeGreaterThanOrEqual(4);
            expect(graph.edges.length).toBeGreaterThanOrEqual(3);
            expect(graph.title).toContain("Autonomous Crop");
        });
    });
});
