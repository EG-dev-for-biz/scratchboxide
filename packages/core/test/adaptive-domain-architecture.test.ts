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
import { classifySceneContent } from "../src/browser/generative-canvas/primitives/scene3d/syncSceneContent";
import type { Scene3DData } from "../src/browser/generative-canvas/canvas-types";
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
            expect(scene.features?.pbrMaterials).toBe(true);
        });

        it("synthesizes adaptive 3D scenes across diverse domains with 70-20-10 hierarchy", () => {
            // Technology / Quantum / Robotics
            const techScene = synthesizeAdaptive3DScene("technology", "Quantum Fusion Reactor", "Magnetic confinement plasma fusion thruster");
            expect(techScene.renderMode).toBe("pbr");
            expect(techScene.environment?.skybox).toBe("studio");
            expect(techScene.features?.cinematic3PointLighting).toBe(true);
            expect(techScene.customMeshes?.some(m => m.tier === "primary")).toBe(true);
            expect(techScene.customMeshes?.some(m => m.tier === "secondary")).toBe(true);
            expect(techScene.customMeshes?.some(m => m.tier === "tertiary")).toBe(true);
            expect(techScene.customMeshes?.some(m => m.material.preset === "titanium_grade5")).toBe(true);

            // History / Archaeology
            const histScene = synthesizeAdaptive3DScene("history", "Babylonian Ziggurat Excavation", "Ancient Mesopotamian temple complex ruins");
            expect(histScene.environment?.skybox).toBe("golden_hour");
            expect(histScene.customMeshes?.some(m => m.material.preset === "weathered_limestone")).toBe(true);

            // Geology / Terrain
            const geoScene = synthesizeAdaptive3DScene("geology", "Alpine Glacial Massif", "Matterhorn alpine mountain peak ridge");
            expect(geoScene.environment?.skybox).toBe("realistic-sky");
            expect(geoScene.customMeshes?.some(m => m.material.preset === "granite")).toBe(true);

            // Infrastructure
            const infraScene = synthesizeAdaptive3DScene("infrastructure", "Spanning Viaduct Overpass", "Reinforced concrete highway interchange");
            expect(infraScene.environment?.skybox).toBe("overcast");
            expect(infraScene.customMeshes?.some(m => m.material.preset === "weathered_concrete")).toBe(true);

            // Open-Ended Novel Domain
            const openScene = synthesizeAdaptive3DScene("general", "Brewing Science Fermentation Column", "Bioreactor column with feedback sensors");
            expect(openScene.sceneType).toBe("adaptive");
            expect(openScene.customMeshes?.length).toBeGreaterThanOrEqual(3);
        });

        it("establishes hierarchical scene graph parenting across adaptive domain assemblies", () => {
            const techScene = synthesizeAdaptive3DScene("technology", "Tokamak Fusion Reactor", "Magnetic confinement torus and core");
            const primaryTech = techScene.customMeshes?.find(m => m.tier === "primary" && m.id === "tech-primary-chassis");
            const secondaryTech = techScene.customMeshes?.find(m => m.id === "tech-secondary-ring");
            const tertiaryTech = techScene.customMeshes?.find(m => m.id === "tech-tertiary-emitter");
            expect(primaryTech).toBeDefined();
            expect(secondaryTech?.parentId).toBe(primaryTech?.id);
            expect(tertiaryTech?.parentId).toBe(primaryTech?.id);

            const geoScene = synthesizeAdaptive3DScene("geology", "Alpine Massif", "Granite buttress and summit horn");
            const primaryGeo = geoScene.customMeshes?.find(m => m.id === "geo-massif-primary");
            const secondaryGeo = geoScene.customMeshes?.find(m => m.id === "geo-scree-secondary");
            const tertiaryGeo = geoScene.customMeshes?.find(m => m.id === "geo-summit-tertiary");
            expect(primaryGeo).toBeDefined();
            expect(secondaryGeo?.parentId).toBe(primaryGeo?.id);
            expect(tertiaryGeo?.parentId).toBe(primaryGeo?.id);
        });

        it("enforces Structured Types When Needed over presets in classifySceneContent", () => {
            // Scene with customMeshes matching an alpine prompt must NOT be hijacked to 'alpine_valley' preset
            const alpineSceneWithMeshes: Scene3DData = {
                title: "Alpine Matterhorn Custom Scan",
                sceneType: "adaptive",
                customMeshes: [
                    { id: "m1", name: "Custom Mountain", type: "box", position: [0, 0, 0], scale: [1, 1, 1], material: { color: 0xffffff } }
                ]
            };
            const alpineClassification = classifySceneContent({
                title: "Alpine Matterhorn Custom Scan",
                sceneType: "adaptive",
                worldBranch: "alpine/matterhorn",
                customMeshes: [
                    { id: "m1", name: "Custom Mountain", type: "box", position: [0, 0, 0], scale: [1, 1, 1], material: { color: 0xffffff } }
                ],
                hasCustomMeshes: true,
                hasActiveScript: false,
                has3DTiles: false,
                hasCppGenerator: false,
                hasNonFallbackObjects: false,
                isAirplane: false,
                hasContrails: false,
                selectedShape: 'box',
                sculptWireframe: false
            });
            expect(alpineClassification).toBe("custom-meshes");

            // Scene with cppGenerator matching an overpass prompt must NOT be hijacked to 'highway_overpass' preset
            const overpassClassification = classifySceneContent({
                title: "Highway Overpass Astra Engine",
                sceneType: "adaptive",
                worldBranch: "infrastructure/highway",
                cppGenerator: {
                    sourceCode: '// C++20 engine',
                    status: 'compiled'
                },
                hasCustomMeshes: false,
                hasActiveScript: false,
                has3DTiles: false,
                hasCppGenerator: true,
                hasNonFallbackObjects: false,
                isAirplane: false,
                hasContrails: false,
                selectedShape: 'box',
                sculptWireframe: false
            });
            expect(overpassClassification).toBe("objects");

            // Scene with active script matching space prompt must be classified as 'script'
            const scriptClassification = classifySceneContent({
                title: "Space Orbital Flight Simulation",
                sceneType: "adaptive",
                worldBranch: "space/orbital",
                customScript: "console.log('orbit');",
                hasCustomMeshes: false,
                hasActiveScript: true,
                has3DTiles: false,
                hasCppGenerator: false,
                hasNonFallbackObjects: false,
                isAirplane: false,
                hasContrails: false,
                selectedShape: 'box',
                sculptWireframe: false
            });
            expect(scriptClassification).toBe("script");
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

        it("synthesizes anatomical botanical 3D scene with stem, foliage, calyx, stamen, and radial petals", () => {
            const flowerScene = synthesizeAdaptive3DScene(
                "botanical",
                "English Rose Blossom",
                "a beautiful blooming rose in a garden with petals and foliage"
            );
            expect(flowerScene.customMeshes.length).toBeGreaterThanOrEqual(10); // soil + stem + 2 leaves + calyx + stamen + 6 petals
            const stem = flowerScene.customMeshes.find(m => m.id === "botanical-stem-primary");
            expect(stem).toBeDefined();
            expect(stem?.type).toBe("cylinder");

            const petals = flowerScene.customMeshes.filter(m => m.id.startsWith("botanical-petal-"));
            expect(petals.length).toBe(6);
            petals.forEach(p => {
                expect(p.parentId).toBe("botanical-stem-primary");
                expect(p.material?.roughness).toBeLessThanOrEqual(0.4);
            });

            const stamen = flowerScene.customMeshes.find(m => m.id === "botanical-pollen-core");
            expect(stamen).toBeDefined();
            expect(stamen?.type).toBe("sphere");
            expect(stamen?.material?.emissive).toBeDefined();
        });

        it("synthesizes entity-aware open-ended 3D scene without static 4-primitive fallback", () => {
            // Vertical bioreactor column
            const columnScene = synthesizeAdaptive3DScene(
                "general",
                "Brewing Fermentation Bioreactor",
                "industrial fermentation column with cooling jacket and monitoring telemetry"
            );
            expect(columnScene.customMeshes.length).toBeGreaterThanOrEqual(4);
            const columnPrimary = columnScene.customMeshes.find(m => m.id === "adaptive-primary-core");
            expect(columnPrimary).toBeDefined();
            expect(columnPrimary?.type).toBe("cylinder");
            expect(columnPrimary?.name).toContain("Bioreactor Primary Column");

            // Planar chassis
            const chassisScene = synthesizeAdaptive3DScene(
                "general",
                "Autonomous Rover Platform",
                "heavy duty industrial flatbed chassis platform with telemetry subframe"
            );
            const chassisPrimary = chassisScene.customMeshes.find(m => m.id === "adaptive-primary-core");
            expect(chassisPrimary).toBeDefined();
            expect(chassisPrimary?.type).toBe("box");
            expect(chassisPrimary?.name).toContain("Chassis Platform");

            // Spherical sensor orb
            const orbScene = synthesizeAdaptive3DScene(
                "general",
                "Environmental Telemetry Orb",
                "spherical atmospheric probe sensor core with gimbal ring"
            );
            const orbPrimary = orbScene.customMeshes.find(m => m.id === "adaptive-primary-core");
            expect(orbPrimary).toBeDefined();
            expect(orbPrimary?.type).toBe("sphere");
            expect(orbPrimary?.name).toContain("Spherical Core");
        });
    });
});
