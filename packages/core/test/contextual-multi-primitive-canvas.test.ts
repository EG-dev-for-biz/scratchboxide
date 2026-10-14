import { test } from 'vitest';
/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as assert from 'assert';
import {
    synthesizeContextual3DScene,
    detect3DSceneTheme,
    createHistoricalBattlefieldScene,
    createProceduralCityScene,
    createSolarSystemScene,
    createMolecularPhysicsScene,
    createArchitecturalRoomScene
} from '../src/browser/generative-canvas/procedural-3d-synthesizer';
import {
    morphArtifact,
    morphDocToScene3D,
    morphDocToMetrics,
    morphDocToSandbox,
    morphDocToChecklistKanban,
    morphDocToNodeGraph,
    morphScene3DToDoc,
    morphScene3DToKanban,
    morphScene3DToNodeGraph,
    morphScene3DToMetrics,
    morphKanbanToDoc,
    morphKanbanToNodeGraph,
    morphKanbanToMetrics,
    morphKanbanToScene3D,
    morphNodeGraphToDoc,
    morphNodeGraphToKanban,
    morphNodeGraphToMetrics,
    morphNodeGraphToSandbox,
    morphNodeGraphToScene3D,
    morphMetricsToDoc,
    morphMetricsToKanban,
    morphMetricsToNodeGraph,
    morphMetricsToScene3D
} from '../src/browser/generative-canvas/primitive-transformer-engine';
import {
    CanvasArtifact,
    MarkdownDocumentData,
    Scene3DData,
    KanbanBoardData,
    NodeGraphData,
    MetricCardsData
} from '../src/browser/generative-canvas/canvas-types';
import * as THREE from 'three';

async function runContextualPrimitiveTests() {
    console.log('🧪 Running Comprehensive Contextual Multi-Primitive Canvas Test Suite...\n');

    // -------------------------------------------------------------
    // Test 1: Historical 3D Scene Synthesis (Lexington / 1776)
    // -------------------------------------------------------------
    console.log('  Testing 1: Historical 3D Scene Synthesis for "Battle at Lexington"...');
    const lexingtonPrompt = 'build me a 3d scene of the battle at lexington';
    const docContext: MarkdownDocumentData = {
        title: 'The Profound Significance of 1776: Liberty, Revolution, and Democratic Thought',
        sections: [
            {
                id: 'sec-1',
                type: 'heading',
                level: 1,
                content: 'The Sparks of Lexington and Concord'
            },
            {
                id: 'sec-2',
                type: 'paragraph',
                content: 'On April 19, 1775, colonial militia gathered on the Lexington Green facing British regulars under Major Pitcairn.'
            }
        ]
    };

    const sceneData1 = synthesizeContextual3DScene(lexingtonPrompt, {
        activeArtifact: {
            id: 'art-doc-1776',
            type: 'markdown-document',
            title: docContext.title,
            summary: '1776 Revolution Spec',
            createdAt: '12:00:00 PM',
            data: docContext,
            version: 1
        }
    });

    assert.ok(sceneData1, 'Scene data should be synthesized');
    assert.strictEqual(sceneData1.sceneType, 'battlefield', 'Scene type should be battlefield');
    assert.ok(sceneData1.title.toLowerCase().includes('lexington'), `Title should mention Lexington, got: ${sceneData1.title}`);
    assert.ok(sceneData1.customMeshes && sceneData1.customMeshes.length > 0, 'Should contain custom meshes for historical landmarks and formations');
    
    const meshNames = sceneData1.customMeshes?.map(m => m.name || m.id).join(' ') || '';
    assert.ok(/tavern|buckman/i.test(meshNames), 'Should contain Buckman Tavern mesh');
    assert.ok(/meetinghouse|church/i.test(meshNames), 'Should contain Meetinghouse mesh');
    assert.ok(/minutemen|militia/i.test(meshNames), 'Should contain Minutemen line mesh');
    assert.ok(/redcoat|british/i.test(meshNames), 'Should contain British Redcoat formation mesh');
    assert.ok(sceneData1.customScript && sceneData1.customScript.length > 50, 'Should contain dynamic Three.js script for battlefield simulation');
    console.log('  ✓ Test 1 Passed: Historical battlefield scene synthesized with tavern, meetinghouse, minutemen, and redcoats.');

    // -------------------------------------------------------------
    // Test 2: Multi-Domain 3D Synthesis (City, Solar System, Molecular, Architecture)
    // -------------------------------------------------------------
    console.log('  Testing 2: Multi-Domain Procedural 3D Scene Themes...');
    const detectedCity = detect3DSceneTheme('build a cyberpunk city with skyscrapers');
    assert.strictEqual(detectedCity, 'city');

    // Since 6e66ca1 ("ground 3D scenes in Google elevation data ...") environmental themes (city,
    // architecture, nature, ...) are creatively cast by CreativeLocationCastingService to a real-world
    // archetype location (cyberpunk city -> Shibuya Crossing) and rendered as a geo-anchored
    // real-world clay 'worldbuilder' scene instead of a synthetic procedural city.
    const cityScene = synthesizeContextual3DScene('build a cyberpunk city with skyscrapers and flying traffic');
    assert.strictEqual(cityScene.sceneType, 'worldbuilder');
    assert.ok(cityScene.worldBranch?.startsWith('real-world/'), `City scene must be real-world grounded, got: ${cityScene.worldBranch}`);
    assert.ok(cityScene.geoAnchor?.active && Number.isFinite(cityScene.geoAnchor.lat) && Number.isFinite(cityScene.geoAnchor.lng), 'City scene must carry an active geo anchor');
    assert.ok(/shibuya|akihabara|tokyo/i.test(cityScene.title), `Cyberpunk city must be cast to the cyberpunk_megacity archetype location, got: ${cityScene.title}`);

    const solarScene = synthesizeContextual3DScene('simulate planetary orbit and solar system with asteroid belt');
    assert.strictEqual(solarScene.sceneType, 'solar-system');
    assert.ok(solarScene.environment?.skybox === 'space-stars');

    const molecularScene = synthesizeContextual3DScene('render molecular physics of caffeine with electron clouds');
    assert.strictEqual(molecularScene.sceneType, 'molecular');

    assert.strictEqual(detect3DSceneTheme('create an architectural blueprint and interior room'), 'architecture');
    // Architecture/interior prompts are cast to the modern_architectural_pavilion archetype (6e66ca1).
    const archScene = synthesizeContextual3DScene('create an architectural blueprint and interior room');
    assert.strictEqual(archScene.sceneType, 'worldbuilder');
    assert.ok(archScene.worldBranch?.startsWith('real-world/'), `Architecture scene must be real-world grounded, got: ${archScene.worldBranch}`);
    assert.ok(/fallingwater|bauhaus/i.test(archScene.title), `Interior/architecture prompt must be cast to the architectural pavilion archetype, got: ${archScene.title}`);
    console.log('  ✓ Test 2 Passed: Procedural themes accurately detected and synthesized for City, Space, Molecular, and Architecture.');

    // -------------------------------------------------------------
    // Test 3: Three.js Procedural Builders Execution (Headless Mock Scene)
    // -------------------------------------------------------------
    console.log('  Testing 3: Procedural Scene Builders in Three.js...');
    const mockScene = new THREE.Scene();

    const battlefieldGroup = createHistoricalBattlefieldScene(mockScene, THREE, {
        tavern: true,
        meetinghouse: true,
        stoneWalls: true,
        minutemenCount: 10,
        redcoatCount: 12,
        smokeParticles: true
    });
    assert.ok(battlefieldGroup, 'Battlefield group created');
    assert.ok(mockScene.children.length > 0, 'Objects added to Three.js scene');
    assert.ok(mockScene.children.some(c => c.name === 'historical-battlefield' || c === battlefieldGroup));

    const mockCityScene = new THREE.Scene();
    const cityGroup = createProceduralCityScene(mockCityScene, THREE, { buildingCount: 15, animatedVehicles: true });
    assert.ok(cityGroup && mockCityScene.children.length > 0, 'City scene created with buildings');

    const mockSolarScene = new THREE.Scene();
    const solarGroup = createSolarSystemScene(mockSolarScene, THREE, { includeAsteroidBelt: true });
    assert.ok(solarGroup && mockSolarScene.children.length > 0, 'Solar system created with planets');

    const mockMolScene = new THREE.Scene();
    const molGroup = createMolecularPhysicsScene(mockMolScene, THREE, { latticeType: 'dna' });
    assert.ok(molGroup && mockMolScene.children.length > 0, 'Molecular physics scene created');

    const mockArchScene = new THREE.Scene();
    const archGroup = createArchitecturalRoomScene(mockArchScene, THREE);
    assert.ok(archGroup && mockArchScene.children.length > 0, 'Architectural room scene created');
    console.log('  ✓ Test 3 Passed: All procedural Three.js builders execute cleanly and attach objects to scene.');

    // -------------------------------------------------------------
    // Test 4: Document -> Multi-Primitive Context Morphing
    // -------------------------------------------------------------
    console.log('  Testing 4: Document Context Morphing into All Primitives...');
    const docArtifact: CanvasArtifact = {
        id: 'art-doc-1776',
        type: 'markdown-document',
        title: 'The Profound Significance of 1776',
        summary: 'Revolutionary War historical analysis',
        version: 1,
        createdAt: '12:00:00 PM',
        data: docContext
    };

    // 4a. Direct Morph Transformers
    const direct3D = morphDocToScene3D(docContext);
    assert.ok(direct3D.title);

    const directMetrics = morphDocToMetrics(docContext);
    assert.ok(directMetrics.metrics && directMetrics.metrics.length > 0);

    const directSandbox = morphDocToSandbox(docContext);
    assert.ok(directSandbox.files && directSandbox.files.length > 0);

    const directKanban = morphDocToChecklistKanban(docContext);
    assert.ok(directKanban.columns && directKanban.columns.length > 0);

    const directGraph = morphDocToNodeGraph(docContext);
    assert.ok(directGraph.nodes && directGraph.nodes.length > 0);

    // 4b. Document -> 3D Scene via morphArtifact
    const morphed3D = morphArtifact(docArtifact, '3d-scene');
    assert.strictEqual(morphed3D.type, '3d-scene');
    const morphed3DData = morphed3D.data as Scene3DData;
    assert.ok(morphed3DData.title.includes('1776') || morphed3DData.title.includes('Lexington') || morphed3DData.sceneType === 'battlefield');

    // 4c. Document -> Kanban Board via morphArtifact
    const morphedKanban = morphArtifact(docArtifact, 'kanban-board');
    assert.strictEqual(morphedKanban.type, 'kanban-board');
    const kanbanData = morphedKanban.data as KanbanBoardData;
    assert.ok(kanbanData.columns && kanbanData.columns.length >= 3, 'Kanban should have columns');

    // 4d. Document -> Node Graph via morphArtifact
    const morphedGraph = morphArtifact(docArtifact, 'node-graph');
    assert.strictEqual(morphedGraph.type, 'node-graph');
    const graphData = morphedGraph.data as NodeGraphData;
    assert.ok(graphData.nodes && graphData.nodes.length > 0, 'Node graph should have nodes');

    // 4e. Document -> Metric Dashboard via morphArtifact
    const morphedMetrics = morphArtifact(docArtifact, 'metric-dashboard');
    assert.strictEqual(morphedMetrics.type, 'metric-dashboard');
    const metricsData = morphedMetrics.data as MetricCardsData;
    assert.ok(metricsData.metrics && metricsData.metrics.length > 0, 'Metrics should contain cards');

    // 4f. Document -> Live Code Sandbox via morphArtifact
    const morphedSandbox = morphArtifact(docArtifact, 'live-code-sandbox');
    assert.strictEqual(morphedSandbox.type, 'live-code-sandbox');
    console.log('  ✓ Test 4 Passed: Document successfully morphed into 3D Scene, Kanban, Node Graph, Metrics, and Sandbox.');

    // -------------------------------------------------------------
    // Test 5: Bidirectional Primitive Transformations Across All Pairs
    // -------------------------------------------------------------
    console.log('  Testing 5: Full Bidirectional Primitive Transformer Matrix...');
    // 3D Scene -> Document, Kanban, Graph, Metrics
    const docFrom3D = morphScene3DToDoc(sceneData1);
    assert.ok(docFrom3D.sections && docFrom3D.sections.length > 0);

    const kanbanFrom3D = morphScene3DToKanban(sceneData1);
    assert.ok(kanbanFrom3D.columns && kanbanFrom3D.columns.length > 0);

    const graphFrom3D = morphScene3DToNodeGraph(sceneData1);
    assert.ok(graphFrom3D.nodes && graphFrom3D.nodes.length > 0);

    const metricsFrom3D = morphScene3DToMetrics(sceneData1);
    assert.ok(metricsFrom3D.metrics && metricsFrom3D.metrics.length > 0);

    // Kanban -> Document, Node Graph, Metrics, 3D Scene
    const docFromKanban = morphKanbanToDoc(kanbanData);
    assert.ok(docFromKanban.sections && docFromKanban.sections.length > 0);

    const graphFromKanban = morphKanbanToNodeGraph(kanbanData);
    assert.ok(graphFromKanban.nodes && graphFromKanban.nodes.length > 0);

    const metricsFromKanban = morphKanbanToMetrics(kanbanData);
    assert.ok(metricsFromKanban.metrics && metricsFromKanban.metrics.length > 0);

    const sceneFromKanban = morphKanbanToScene3D(kanbanData);
    assert.ok(sceneFromKanban.title);

    // Node Graph -> Document, Kanban, Metrics, Sandbox, 3D Scene
    const docFromGraph = morphNodeGraphToDoc(graphData);
    assert.ok(docFromGraph.sections && docFromGraph.sections.length > 0);

    const kanbanFromGraph = morphNodeGraphToKanban(graphData);
    assert.ok(kanbanFromGraph.columns && kanbanFromGraph.columns.length > 0);

    const metricsFromGraph = morphNodeGraphToMetrics(graphData);
    assert.ok(metricsFromGraph.metrics && metricsFromGraph.metrics.length > 0);

    const sandboxFromGraph = morphNodeGraphToSandbox(graphData);
    assert.ok(sandboxFromGraph.files && sandboxFromGraph.files.length > 0);

    const sceneFromGraph = morphNodeGraphToScene3D(graphData);
    assert.ok(sceneFromGraph.title);

    // Metrics -> Document, Kanban, Node Graph, 3D Scene
    const docFromMetrics = morphMetricsToDoc(metricsData);
    assert.ok(docFromMetrics.sections && docFromMetrics.sections.length > 0);

    const kanbanFromMetrics = morphMetricsToKanban(metricsData);
    assert.ok(kanbanFromMetrics.columns && kanbanFromMetrics.columns.length > 0);

    const graphFromMetrics = morphMetricsToNodeGraph(metricsData);
    assert.ok(graphFromMetrics.nodes && graphFromMetrics.nodes.length > 0);

    const sceneFromMetrics = morphMetricsToScene3D(metricsData);
    assert.ok(sceneFromMetrics.title);
    console.log('  ✓ Test 5 Passed: Universal bidirectional morph matrix verified for all primitive pairs.');

    console.log('\n🎉 ALL CONTEXTUAL MULTI-PRIMITIVE CANVAS TESTS PASSED SUCCESSFULLY!');
}

test('contextual-multi-primitive-canvas.test', async () => {
    await runContextualPrimitiveTests();
}, 180_000);
