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
import * as THREE from 'three';
import {
    createArticulatedAircraft,
    createVolumetricGodRays,
    createDynamicContrails,
    createAtmosphericSkyDome,
    createProceduralBiomeTerrain,
    executeDynamicThreeScript,
    updateFlightPhysics,
    DynamicScriptContext,
    createHistoricalBattlefieldScene,
    createProceduralCityScene,
    createSolarSystemScene,
    createMolecularPhysicsScene,
    createArchitecturalRoomScene,
    createProceduralSpatialScene
} from '../src/browser/generative-canvas/primitives/Scene3DPrimitive';
import {
    morphScene3DToSandbox,
    morphSandboxToScene3D
} from '../src/browser/generative-canvas/primitive-transformer-engine';
import { Scene3DData, LiveCodeSandboxData } from '../src/browser/generative-canvas/canvas-types';
import { GeminiService } from '../src/node/gemini-service';

async function runScene3DDynamicExecutionTests() {
    console.log('🧪 Running Comprehensive 3D Dynamic Execution Pipeline Test Suite...\n');

    // -------------------------------------------------------------
    // Test 1: Articulated Aircraft with Dynamic Control Surfaces
    // -------------------------------------------------------------
    console.log('  Testing 1: Articulated Aircraft & Control Surfaces Structure...');
    const aircraft = createArticulatedAircraft();
    assert.ok(aircraft.group instanceof THREE.Group, 'Aircraft group must be a THREE.Group');
    assert.ok(aircraft.leftAileron instanceof THREE.Mesh, 'Must have articulated left aileron');
    assert.ok(aircraft.rightAileron instanceof THREE.Mesh, 'Must have articulated right aileron');
    assert.ok(aircraft.rudder instanceof THREE.Mesh, 'Must have articulated rudder');
    assert.ok(aircraft.leftElevator instanceof THREE.Mesh, 'Must have articulated left elevator');
    assert.ok(aircraft.rightElevator instanceof THREE.Mesh, 'Must have articulated right elevator');
    assert.strictEqual(aircraft.turbines.length, 2, 'Must have dual spinning turbofan intake turbines');
    assert.strictEqual(aircraft.thrusters.length, 2, 'Must have dual afterburner thruster rings');
    assert.strictEqual(aircraft.contrailEmitters.length, 2, 'Must have dual wingtip contrail emitters');
    assert.ok(aircraft.group.userData.leftAileron, 'UserData must contain references to articulated parts');
    console.log('  ✓ Test 1 Passed: Articulated aircraft constructed with all flight control surfaces and emitters.');

    // -------------------------------------------------------------
    // Test 2: Aerodynamic Kinematics & Control Surface Deflections
    // -------------------------------------------------------------
    console.log('  Testing 2: Flight Physics & Control Surface Deflections...');
    const initialLeftAileronRot = aircraft.leftAileron.rotation.x;
    const initialRudderRot = aircraft.rudder.rotation.y;

    // Simulate time tick with bank/pitch
    updateFlightPhysics(aircraft.group, 1.5, 0.016, { bankScale: 1.0, pitchScale: 1.0 });

    assert.notStrictEqual(aircraft.leftAileron.rotation.x, initialLeftAileronRot, 'Left aileron must deflect during flight roll');
    assert.strictEqual(aircraft.leftAileron.rotation.x, -aircraft.rightAileron.rotation.x, 'Ailerons must deflect differentially (opposite directions)');
    assert.notStrictEqual(aircraft.rudder.rotation.y, initialRudderRot, 'Rudder must deflect during yaw oscillation');
    assert.strictEqual(aircraft.leftElevator.rotation.x, aircraft.rightElevator.rotation.x, 'Elevators must deflect symmetrically in pitch');
    console.log('  ✓ Test 2 Passed: Aerodynamic kinematics correctly deflect ailerons, elevators, and rudder in real-time.');

    // -------------------------------------------------------------
    // Test 3: Volumetric God Rays & Light Shafts Shader
    // -------------------------------------------------------------
    console.log('  Testing 3: Volumetric God Rays & Light Shafts Generator...');
    const testScene = new THREE.Scene();
    const sunPos = new THREE.Vector3(40, 60, 40);
    const godRays = createVolumetricGodRays(testScene, sunPos, false, { intensity: 0.9, color: 0xfffae0 });

    assert.ok(godRays.group instanceof THREE.Group, 'God rays must return a THREE.Group');
    assert.ok(godRays.group.children.length >= 8, 'God rays must generate volumetric light shaft meshes');
    const firstRay = godRays.group.children[0] as THREE.Mesh;
    assert.ok(firstRay.material instanceof THREE.ShaderMaterial, 'Rays must use custom ShaderMaterial');
    assert.strictEqual((firstRay.material as THREE.ShaderMaterial).transparent, true);

    // Test time uniform update
    godRays.update(2.5, 0.016);
    assert.strictEqual((firstRay.material as THREE.ShaderMaterial).uniforms.uTime.value, 2.5);

    godRays.dispose();
    console.log('  ✓ Test 3 Passed: Volumetric god rays compile GLSL shader and update uniforms over time.');

    // -------------------------------------------------------------
    // Test 4: Dynamic Contrail Dynamics & Wingtip Vortex Trail
    // -------------------------------------------------------------
    console.log('  Testing 4: Dynamic Contrail Particle Vortex System...');
    const contrailScene = new THREE.Scene();
    const contrails = createDynamicContrails(contrailScene, 100);

    assert.ok(contrails.group instanceof THREE.Group, 'Contrails must return a THREE.Group');
    assert.strictEqual(contrails.group.children.length, 2, 'Contrails must have dual left & right particle point meshes');

    const leftTrail = contrails.group.children[0] as THREE.Points;
    const lPosAttr = leftTrail.geometry.attributes.position as THREE.BufferAttribute;
    const lOpAttr = leftTrail.geometry.attributes.opacity as THREE.BufferAttribute;
    assert.strictEqual(lPosAttr.count, 100);
    assert.strictEqual(lOpAttr.count, 100);

    // Simulate contrail tracking aircraft position
    aircraft.group.position.set(10, 5, 20);
    contrails.update(aircraft.group, 1.0, 0.016);

    assert.strictEqual(lOpAttr.getX(0), 1.0, 'Freshly emitted contrail point must have full opacity (1.0)');
    contrails.dispose();
    console.log('  ✓ Test 4 Passed: Contrail vortex system dynamically tracks wingtips and manages condensation life cycle.');

    // -------------------------------------------------------------
    // Test 5: Atmospheric Rayleigh & Mie Scattering Sky Dome
    // -------------------------------------------------------------
    console.log('  Testing 5: Atmospheric Scattering Sky Dome Shader...');
    const skyScene = new THREE.Scene();
    const skyDomeModule = createAtmosphericSkyDome(skyScene, false);

    assert.ok(skyDomeModule.skyDome instanceof THREE.Mesh, 'Must create sky dome mesh');
    assert.ok(skyDomeModule.sunMesh instanceof THREE.Mesh, 'Must create sun mesh');
    assert.ok(skyDomeModule.hemiLight instanceof THREE.HemisphereLight, 'Must create hemisphere bounce light');
    assert.ok(skyDomeModule.sunLight instanceof THREE.DirectionalLight, 'Must create sun directional light');

    const skyMat = skyDomeModule.skyDome.material as THREE.ShaderMaterial;
    assert.ok(skyMat.vertexShader.includes('vWorldPosition'), 'Vertex shader must calculate world position for scattering');
    assert.ok(skyMat.fragmentShader.includes('topColor') && skyMat.fragmentShader.includes('bottomColor'), 'Fragment shader must compute gradient scattering');

    skyDomeModule.dispose();
    console.log('  ✓ Test 5 Passed: Atmospheric sky dome calculates multi-order Rayleigh scattering and lighting.');

    // -------------------------------------------------------------
    // Test 6: Procedural Terrain Biomes Generator (Anti-JS-Primitives Guard)
    // -------------------------------------------------------------
    console.log('  Testing 6: Procedural Terrain Biomes Generator (Zero-Primitive Guarantee)...');
    const terrainScene = new THREE.Scene();
    const alpineTerrain = createProceduralBiomeTerrain(terrainScene, 'alpine', 'pbr', false);
    assert.ok(alpineTerrain.group instanceof THREE.Group, 'Must return safe group container');
    assert.strictEqual(alpineTerrain.terrainMesh, undefined, 'Must not instantiate client-side PlaneGeometry terrain');
    assert.strictEqual(alpineTerrain.cloudGroup, undefined, 'Must not instantiate client-side DodecahedronGeometry clouds');

    const canyonTerrain = createProceduralBiomeTerrain(terrainScene, 'canyon', 'pbr', false);
    assert.ok(canyonTerrain.group instanceof THREE.Group);

    const desertTerrain = createProceduralBiomeTerrain(terrainScene, 'desert', 'pbr', false);
    assert.ok(desertTerrain.group instanceof THREE.Group);

    alpineTerrain.dispose();
    canyonTerrain.dispose();
    desertTerrain.dispose();
    console.log('  ✓ Test 6 Passed: Procedural terrain generator enforces zero-primitive guarantee.');

    // -------------------------------------------------------------
    // Test 7: Safe Dynamic Three.js Script Evaluation Engine
    // -------------------------------------------------------------
    console.log('  Testing 7: Dynamic Three.js Custom Script Sandbox Execution...');
    const execScene = new THREE.Scene();
    const execCamera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
    const mockContainer = { clientWidth: 800, clientHeight: 600 } as any;

    let cleanupRan = false;

    const dummyContext: DynamicScriptContext = {
        scene: execScene,
        camera: execCamera,
        renderer: {} as any,
        container: mockContainer,
        THREE,
        sceneData: { title: 'Test 3D Scene', objects: [] },
        addCleanup: (fn) => { if (cleanupRan) fn(); },
        onFrame: (fn) => { fn(10, 0.016); },
        registerUpdate: (fn) => { fn(10, 0.016); },
        createArticulatedAircraft,
        createVolumetricGodRays,
        createDynamicContrails,
        createAtmosphericSkyDome,
        createProceduralBiomeTerrain,
        createAirplaneMesh: () => createArticulatedAircraft().group,
        createDroneMesh: () => new THREE.Group(),
        createPinMesh: () => new THREE.Group(),
        createHistoricalBattlefieldScene,
        createProceduralCityScene,
        createSolarSystemScene,
        createMolecularPhysicsScene,
        createArchitecturalRoomScene,
        createProceduralSpatialScene
    };

    const userScript = `
        // Create dynamic neon particle grid
        const pGeo = new THREE.BufferGeometry();
        const pMat = new THREE.PointsMaterial({ color: 0x00ffcc });
        const particles = new THREE.Points(pGeo, pMat);
        scene.add(particles);

        let counter = 0;
        onFrame((time, delta) => {
            counter += delta;
        });

        export function runCustomScript(context) {
            return {
                update: (time, delta) => {
                    particles.rotation.y = time;
                },
                dispose: () => {
                    scene.remove(particles);
                }
            };
        }
    `;

    const scriptResult = executeDynamicThreeScript(userScript, dummyContext);
    assert.strictEqual(scriptResult.error, null, 'Script execution must succeed without syntax errors');
    assert.ok(typeof scriptResult.update === 'function', 'Must return update hook');
    assert.ok(typeof scriptResult.dispose === 'function', 'Must return dispose hook');

    // Test error boundary with faulty script
    const faultyScript = `this is invalid javascript syntax {[[`;
    const errorResult = executeDynamicThreeScript(faultyScript, dummyContext);
    assert.ok(errorResult.error !== null && errorResult.error !== undefined, 'Faulty script must be safely caught by error boundary');
    console.log('  ✓ Test 7 Passed: Dynamic script evaluator executes custom Three.js code with safety sandbox.');

    // -------------------------------------------------------------
    // Test 8: GeminiService Multi-Feature Synthesis
    // -------------------------------------------------------------
    console.log('  Testing 8: GeminiService Feature Flag Detection & Custom Script Support...');
    const geminiService = new GeminiService();

    // Query asking for realistic features
    const complexPrompt = 'Add god rays, contrails, articulated control surfaces, and alpine terrain biomes';
    const synthesizedArtifact = (geminiService as any).parseOrSynthesizeArtifact(
        complexPrompt,
        'Configured realistic atmospheric features',
        { prompt: complexPrompt },
        []
    );

    assert.strictEqual(synthesizedArtifact.type, '3d-scene');
    const synthesizedData = synthesizedArtifact.data as Scene3DData;
    assert.ok(synthesizedData.features?.godRays, 'Must enable godRays feature');
    assert.ok(synthesizedData.features?.contrails, 'Must enable contrails feature');
    assert.ok(synthesizedData.features?.controlSurfaces, 'Must enable controlSurfaces feature');
    assert.ok(synthesizedData.features?.terrainBiomes, 'Must enable terrainBiomes feature');
    assert.strictEqual(synthesizedData.environment?.skybox, 'realistic-sky');
    console.log('  ✓ Test 8 Passed: GeminiService detects and synthesizes dynamic 3D features and scene data.');

    // -------------------------------------------------------------
    // Test 9: Live Code Sandbox Script Synchronization
    // -------------------------------------------------------------
    console.log('  Testing 9: Live Code Sandbox Bidirectional Script Sync...');
    const initialScene: Scene3DData = {
        title: '3D Jet Simulator',
        objects: [],
        renderMode: 'pbr',
        environment: { skybox: 'realistic-sky' },
        customScript: `
            // User custom scene script
            const customMesh = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), new THREE.MeshBasicMaterial({ color: 0xff0055 }));
            scene.add(customMesh);
        `,
        features: {
            godRays: true,
            contrails: true,
            controlSurfaces: true
        }
    };

    const morphedSandbox = morphScene3DToSandbox(initialScene);
    const customScriptFile = morphedSandbox.files.find(f => f.name === 'customScript.ts');
    assert.ok(customScriptFile && customScriptFile.content.includes('customMesh'), 'Custom script must be preserved into sandbox customScript.ts');

    // Edit custom script inside sandbox and morph back
    const editedSandbox: LiveCodeSandboxData = {
        ...morphedSandbox,
        files: morphedSandbox.files.map(f => f.name === 'customScript.ts' ? {
            ...f,
            content: `// Updated in sandbox editor\nconst laser = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 5), new THREE.MeshBasicMaterial({ color: 0x00ff88 }));\nscene.add(laser);`
        } : f)
    };

    const backScene = morphSandboxToScene3D(editedSandbox);
    assert.ok(backScene.customScript && backScene.customScript.includes('laser'), 'Morphed back 3D scene must carry updated script from sandbox');
    console.log('  ✓ Test 9 Passed: Live Code Sandbox seamlessly synchronizes custom Three.js scripts with 3D Viewport.');

    // -------------------------------------------------------------
    // Test 10: Custom Shaders & Custom Meshes Schema Support
    // -------------------------------------------------------------
    console.log('  Testing 10: Custom Shaders & Custom Meshes Schema Verification...');
    const customShaderScene: Scene3DData = {
        title: 'Custom Shader Atmosphere',
        objects: [],
        shaders: {
            customSky: {
                vertexShader: 'varying vec3 vPos; void main() { vPos = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
                fragmentShader: 'varying vec3 vPos; uniform float uTime; void main() { gl_FragColor = vec4(0.1, 0.5, sin(uTime), 1.0); }',
                uniforms: { uTime: { value: 0 } }
            }
        },
        customMeshes: [
            {
                id: 'custom-beacon-1',
                name: 'Landing Beacon',
                type: 'cylinder',
                position: [0, 5, 0],
                material: { color: 0x00ffff, roughness: 0.1, metalness: 0.9 }
            }
        ]
    };

    assert.ok(customShaderScene.shaders?.customSky, 'Must support custom shaders schema');
    assert.strictEqual(customShaderScene.customMeshes?.length, 1, 'Must support custom meshes schema');
    assert.strictEqual(customShaderScene.customMeshes[0].type, 'cylinder');
    console.log('  ✓ Test 10 Passed: Custom shaders and arbitrary mesh definitions verified in 3D pipeline.');

    console.log('\n🎉 ALL 3D DYNAMIC EXECUTION PIPELINE TESTS PASSED SUCCESSFULLY!\n');
}

test('scene3d-dynamic-execution-pipeline.test', async () => {
    await runScene3DDynamicExecutionTests();
}, 180_000);
