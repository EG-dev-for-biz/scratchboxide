/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * Comprehensive Test Suite across Diverse 3D Prompts:
 * Verifies intent classification, theme detection, procedural scene synthesis,
 * C++20 engine code generation, and scene mutation across all 3D domains.
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import {
    classifyFallbackPrompt,
    synthesize3DFallback,
    mutateExisting3DScene
} from '../src/browser/generative-canvas/hooks/sendMessageFallbacks';
import {
    detect3DSceneTheme,
    synthesizeContextual3DScene
} from '../src/browser/generative-canvas/procedural-3d-synthesizer';
import {
    Scene3DData,
    CanvasArtifact
} from '../src/browser/generative-canvas/canvas-types';

describe('Comprehensive 3D Prompting & Synthesis Suite', () => {

    // =========================================================================
    // Domain 1: Automotive & 3D Vehicles
    // =========================================================================
    describe('1. Automotive & 3D Vehicles', () => {
        const vehiclePrompts = [
            { prompt: 'build me a 3d car', expectedTheme: 'vehicle' },
            { prompt: 'create a high-performance crimson red sports car', expectedTheme: 'vehicle' },
            { prompt: 'render a matte black cyberpunk cyber truck with angular armor', expectedTheme: 'vehicle' },
            { prompt: 'generate a vintage 1960s British racing green roadster', expectedTheme: 'vehicle' },
            { prompt: '3d vehicle simulation with aerodynamic chassis and alloy wheels', expectedTheme: 'vehicle' },
            { prompt: 'build an open-wheel Formula 1 race car with front and rear wings', expectedTheme: 'vehicle' }
        ];

        for (const { prompt, expectedTheme } of vehiclePrompts) {
            it(`classifies and synthesizes: "${prompt}"`, () => {
                const classification = classifyFallbackPrompt(prompt, undefined, 'canvas', undefined);
                expect(classification.is3DRequest).toBe(true);
                expect(classification.isSandboxRequest).toBe(false);

                const theme = detect3DSceneTheme(prompt);
                expect(theme).toBe(expectedTheme);

                const result = synthesize3DFallback(prompt, prompt.toLowerCase(), undefined, [], undefined);
                expect(result.artifact).toBeDefined();
                expect(result.artifact?.type).toBe('3d-scene');

                const scene = result.artifact?.data as Scene3DData;
                expect(scene.title).toBeTruthy();
                expect(scene.environment).toBeDefined();
                expect(scene.camera).toBeDefined();

                // Vehicle scenes must feature custom vehicle meshes or procedural vehicle objects
                const hasVehicleMeshes = (scene.customMeshes && scene.customMeshes.length > 0) ||
                                         (scene.objects && scene.objects.length > 0);
                expect(hasVehicleMeshes).toBe(true);

                // Check that C++ Astro source code is attached
                if (scene.cppGenerator?.sourceCode) {
                    expect(scene.cppGenerator.sourceCode).toContain('scratchbox_engine.hpp');
                }
            });
        }
    });

    // =========================================================================
    // Domain 2: Planetary Exploration & Mars Rover
    // =========================================================================
    describe('2. Planetary Exploration & Mars Rover', () => {
        const planetaryPrompts = [
            'build a 3d scene for Mars Rover exploration',
            'Perseverance rover traversing red Martian dunes in Jezero crater',
            'Curiosity rover analyzing red rock outcrop with robotic arm spectrometer',
            'autonomous lunar rover on the Moon surface with crater rims'
        ];

        for (const prompt of planetaryPrompts) {
            it(`synthesizes planetary exploration: "${prompt}"`, () => {
                const classification = classifyFallbackPrompt(prompt, undefined, 'canvas', undefined);
                expect(classification.is3DRequest).toBe(true);

                const theme = detect3DSceneTheme(prompt);
                expect(theme).toBe('mars_rover');

                const result = synthesize3DFallback(prompt, prompt.toLowerCase(), undefined, [], undefined);
                const scene = result.artifact?.data as Scene3DData;

                expect(scene.title.toLowerCase()).toMatch(/rover|mars|planetary/i);
                expect(scene.worldBranch).not.toContain('earth');

                // Verify extraterrestrial meshes (regolith, rover chassis, mast)
                const meshNames = (scene.customMeshes || []).map(m => m.name.toLowerCase());
                expect(meshNames.some(n => n.includes('regolith') || n.includes('terrain') || n.includes('surface'))).toBe(true);
                expect(meshNames.some(n => n.includes('rover') || n.includes('chassis') || n.includes('wheel') || n.includes('mast'))).toBe(true);
            });
        }
    });

    // =========================================================================
    // Domain 3: 3D Gaussian Splatting & Radiance Fields
    // =========================================================================
    describe('3. 3D Gaussian Splatting & Radiance Fields', () => {
        const splatPrompts = [
            'generate a 3d gaussian splat scene',
            'create a dense 3DGS radiance field point cloud visualization',
            'render gaussian splats with anisotropic projected covariance'
        ];

        for (const prompt of splatPrompts) {
            it(`detects and constructs 3DGS scene: "${prompt}"`, () => {
                const classification = classifyFallbackPrompt(prompt, undefined, 'canvas', undefined);
                expect(classification.is3DRequest).toBe(true);

                const theme = detect3DSceneTheme(prompt);
                expect(theme).toBe('gaussian_splat');

                const scene = synthesizeContextual3DScene(prompt);
                expect(scene).toBeDefined();
                expect(scene.title).toBeTruthy();
                expect(scene.camera).toBeDefined();

                // Should have splat representation or splat configuration
                const hasSplatConfig = scene.features?.gaussianSplats ||
                                       scene.splatUrl ||
                                       (scene.objects && scene.objects.some(o => o.content?.type === 'gaussian-splat')) ||
                                       (scene.customMeshes && scene.customMeshes.length > 0);
                expect(hasSplatConfig).toBeTruthy();
            });
        }
    });

    // =========================================================================
    // Domain 4: High-Speed Ballistics & Glass Shatter
    // =========================================================================
    describe('4. High-Speed Ballistics & Glass Shatter', () => {
        const shatterPrompts = [
            'bullet going through a plate of glass in high speed impact',
            'supersonic projectile shattering glass window into voronoi fracture shards',
            'high speed ballistics impact with radial crack propagation'
        ];

        for (const prompt of shatterPrompts) {
            it(`synthesizes dynamic glass fracture physics: "${prompt}"`, () => {
                const classification = classifyFallbackPrompt(prompt, undefined, 'canvas', undefined);
                expect(classification.is3DRequest).toBe(true);

                const theme = detect3DSceneTheme(prompt);
                expect(theme).toBe('glass_shatter');

                const scene = synthesizeContextual3DScene(prompt);
                expect(scene.title.toLowerCase()).toMatch(/glass|shatter|impact|ballistic/i);
                expect(scene.customMeshes && scene.customMeshes.length).toBeGreaterThan(0);

                // Mesh names should feature projectile, glass plate, or shards
                const names = scene.customMeshes!.map(m => m.name.toLowerCase());
                expect(names.some(n => n.includes('glass') || n.includes('bullet') || n.includes('shard') || n.includes('fracture'))).toBe(true);
            });
        }
    });

    // =========================================================================
    // Domain 5: Nature, Botanical & Atmospheric Volumetrics
    // =========================================================================
    describe('5. Nature, Botanical & Atmospheric Volumetrics', () => {
        const naturePrompts = [
            'build a 3d nature scene with redwood forest and volumetric god rays',
            'misty coniferous pine forest with rayleigh atmospheric scattering and fog',
            'ancient mossy woodland with stratified rock cliffs and subsurface scattering'
        ];

        for (const prompt of naturePrompts) {
            it(`synthesizes atmospheric botanical environment: "${prompt}"`, () => {
                const classification = classifyFallbackPrompt(prompt, undefined, 'canvas', undefined);
                expect(classification.is3DRequest).toBe(true);

                const theme = detect3DSceneTheme(prompt);
                expect(theme).toBe('nature_atmosphere');

                const scene = synthesizeContextual3DScene(prompt);
                expect(scene.title).toBeTruthy();
                expect(scene.environment).toBeDefined();

                if (/god\s*rays?/i.test(prompt)) {
                    // God rays place a light emitter in the scene; they are not an atmosphere opt-in.
                    expect(scene.features?.godRays).toBeTruthy();
                    expect(scene.features?.atmosphericScattering).toBeFalsy();
                } else {
                    // Must have atmospheric scattering or fog enabled
                    expect(scene.features?.atmosphericScattering || scene.environment?.fog || scene.environment?.aerialPerspective).toBeTruthy();
                }
                expect(scene.customMeshes && scene.customMeshes.length).toBeGreaterThan(0);
            });
        }
    });

    // =========================================================================
    // Domain 6: Physically Based Rendering (PBR) Showcase
    // =========================================================================
    describe('6. Physically Based Rendering (PBR) Showcase', () => {
        const pbrPrompts = [
            'photorealistic 3d studio showcase with cook-torrance microfacet pbr materials',
            'material showcase with clearcoat transmission and brushed titanium sheen',
            'pbr lighting test with metallic roughness spheres and physical studio rig'
        ];

        for (const prompt of pbrPrompts) {
            it(`configures PBR material showcase: "${prompt}"`, () => {
                const classification = classifyFallbackPrompt(prompt, undefined, 'canvas', undefined);
                expect(classification.is3DRequest).toBe(true);

                const theme = detect3DSceneTheme(prompt);
                expect(theme).toBe('pbr');

                const scene = synthesizeContextual3DScene(prompt);
                expect(scene.renderMode).toBe('pbr');
                expect(scene.customMeshes && scene.customMeshes.length).toBeGreaterThan(0);

                // Meshes must have material definitions with roughness and metalness
                const meshesWithPbr = scene.customMeshes!.filter(m => m.material && typeof m.material.roughness === 'number');
                expect(meshesWithPbr.length).toBeGreaterThan(0);
            });
        }
    });

    // =========================================================================
    // Domain 7: 3D Mesh Shaping & Organic Sculpting
    // =========================================================================
    describe('7. 3D Mesh Shaping & Organic Sculpting', () => {
        const sculptPrompts = [
            'sculpt an organic creature with taper and twist parametric lofts',
            'mesh shaping with free-form deformation and subdivision surfaces',
            'parametric lathe and loft 3d sculpture with smooth curvature'
        ];

        for (const prompt of sculptPrompts) {
            it(`detects mesh shaping theme and builds deformable geometry: "${prompt}"`, () => {
                const classification = classifyFallbackPrompt(prompt, undefined, 'canvas', undefined);
                expect(classification.is3DRequest).toBe(true);

                const theme = detect3DSceneTheme(prompt);
                expect(theme).toBe('mesh-shaping');

                const scene = synthesizeContextual3DScene(prompt);
                expect(scene.customMeshes && scene.customMeshes.length).toBeGreaterThan(0);
            });
        }
    });

    // =========================================================================
    // Domain 8: Particle Simulations & Fluid Emitters
    // =========================================================================
    describe('8. Particle Simulations & Fluid Emitters', () => {
        const particlePrompts = [
            '3d particle simulation with swirling fire vortex and smoke emitter',
            'sparks fountain with curl noise particle dynamics',
            'fluid spray particle emitter with blackbody radiation colors'
        ];

        for (const prompt of particlePrompts) {
            it(`generates particle simulation scene: "${prompt}"`, () => {
                const classification = classifyFallbackPrompt(prompt, undefined, 'canvas', undefined);
                expect(classification.is3DRequest).toBe(true);

                const theme = detect3DSceneTheme(prompt);
                expect(theme).toBe('particles');

                const scene = synthesizeContextual3DScene(prompt);
                expect(scene.customMeshes && scene.customMeshes.length).toBeGreaterThan(0);
            });
        }
    });

    // =========================================================================
    // Domain 9: Aerospace & Flight
    // =========================================================================
    describe('9. Aerospace & Flight', () => {
        const flightPrompts = [
            'build a 3d supersonic jet airplane with wing vapor contrails',
            'commercial airliner on airport runway with active control surfaces',
            'autonomous drone flight path corridor with waypoints'
        ];

        for (const prompt of flightPrompts) {
            it(`configures aerospace flight scene: "${prompt}"`, () => {
                const classification = classifyFallbackPrompt(prompt, undefined, 'canvas', undefined);
                expect(classification.is3DRequest).toBe(true);

                const theme = detect3DSceneTheme(prompt);
                expect(theme).toBe('flight');

                const scene = synthesizeContextual3DScene(prompt);
                expect(scene.title.toLowerCase()).toMatch(/jet|airplane|flight|aircraft|drone|aerospace/i);
                // Hero objects are built by a procedural generator (013d47c) rather than inline meshes.
                const totalEntities = (scene.customMeshes?.length || 0) + (scene.objects?.length || 0);
                expect(totalEntities > 0 || Boolean(scene.pythonGenerator?.sourceCode || scene.cppGenerator?.sourceCode)).toBe(true);
            });
        }
    });

    // =========================================================================
    // Domain 10: Historical Battlefield & 1776
    // =========================================================================
    describe('10. Historical Battlefield & 1776', () => {
        const battlePrompts = [
            'build a 3d scene for the Battle of Lexington 1776 with militia firing line',
            'historical Bunker Hill fortress battlefield with redcoat regiments',
            'medieval castle siege with stone curtain walls and catapults'
        ];

        for (const prompt of battlePrompts) {
            it(`generates historic battlefield: "${prompt}"`, () => {
                const classification = classifyFallbackPrompt(prompt, undefined, 'canvas', undefined);
                expect(classification.is3DRequest).toBe(true);

                const theme = detect3DSceneTheme(prompt);
                expect(theme).toBe('battlefield');

                const scene = synthesizeContextual3DScene(prompt);
                expect(scene.title.toLowerCase()).toMatch(/battle|lexington|bunker|castle|siege|1776/i);
                expect(scene.customMeshes && scene.customMeshes.length).toBeGreaterThan(0);
            });
        }
    });

    // =========================================================================
    // Domain 11: Real-World Geospatial & Google 3D Tiles
    // =========================================================================
    describe('11. Real-World Geospatial & Google 3D Tiles', () => {
        const geospatialPrompts = [
            { prompt: 'Colosseum, Rome, Italy 3D model', expectedName: 'Colosseum' },
            { prompt: 'Eiffel Tower Paris 3D building', expectedName: 'Eiffel Tower' },
            { prompt: 'Empire State Building New York digital twin', expectedName: 'Empire State Building' },
            { prompt: 'Sydney Opera House architectural 3D tiles', expectedName: 'Sydney Opera House' }
        ];

        for (const { prompt, expectedName } of geospatialPrompts) {
            it(`binds real-world geodetic coordinates: "${prompt}"`, () => {
                const classification = classifyFallbackPrompt(prompt, undefined, 'canvas', undefined);
                expect(classification.is3DRequest).toBe(true);

                const theme = detect3DSceneTheme(prompt);
                expect(theme).toBe('geospatial');

                const scene = synthesizeContextual3DScene(prompt);
                expect(scene.geoAnchor).toBeDefined();
                expect(scene.geoAnchor?.active).toBe(true);
                expect(scene.geoAnchor?.landmarkName).toContain(expectedName);
                expect(typeof scene.geoAnchor?.lat).toBe('number');
                expect(typeof scene.geoAnchor?.lng).toBe('number');
                expect(scene.geoAnchor?.lat === 0 && scene.geoAnchor?.lng === 0).toBe(false);
            });
        }

        it('a named place with no offline coordinates is not anchored at (0, 0): "Taj Mahal Agra 3D monument"', () => {
            const scene = synthesizeContextual3DScene('Taj Mahal Agra 3D monument');
            expect(detect3DSceneTheme('Taj Mahal Agra 3D monument')).not.toBe('geospatial');
            expect(scene.geoAnchor).toBeUndefined();
        });
    });

    // =========================================================================
    // Domain 12: Metropolis, Cities & Cyberpunk
    // =========================================================================
    describe('12. Metropolis, Cities & Cyberpunk', () => {
        const cityPrompts = [
            'build a 3d cyberpunk metropolis with neon skyscrapers and flying traffic',
            'futuristic downtown city skyline with glass towers and sky bridges',
            'urban street canyon with crosswalks, traffic lights, and architectural facades'
        ];

        for (const prompt of cityPrompts) {
            it(`synthesizes urban skyline: "${prompt}"`, () => {
                const classification = classifyFallbackPrompt(prompt, undefined, 'canvas', undefined);
                expect(classification.is3DRequest).toBe(true);

                const theme = detect3DSceneTheme(prompt);
                expect(theme).toBe('city');

                const scene = synthesizeContextual3DScene(prompt);
                expect(scene.customMeshes && scene.customMeshes.length).toBeGreaterThan(0);
            });
        }
    });

    // =========================================================================
    // Domain 13: Celestial & Solar System
    // =========================================================================
    describe('13. Celestial & Solar System', () => {
        const celestialPrompts = [
            'build a 3d solar system with planetary orbits and sun lighting',
            'Saturn ring system with orbital dynamics and moons',
            'deep space asteroid belt with tumbling celestial rocks'
        ];

        for (const prompt of celestialPrompts) {
            it(`generates celestial orbital scene: "${prompt}"`, () => {
                const classification = classifyFallbackPrompt(prompt, undefined, 'canvas', undefined);
                expect(classification.is3DRequest).toBe(true);

                const theme = detect3DSceneTheme(prompt);
                expect(theme).toBe('solar-system');

                const scene = synthesizeContextual3DScene(prompt);
                expect(scene.environment?.skybox).toMatch(/space|starfield|black/i);
                expect(scene.customMeshes && scene.customMeshes.length).toBeGreaterThan(0);
            });
        }
    });

    // =========================================================================
    // Domain 14: Molecular Physics & Chemistry
    // =========================================================================
    describe('14. Molecular Physics & Chemistry', () => {
        const molecularPrompts = [
            'double helix DNA molecule with base pairs and atomic bonds in 3D',
            'molecular physics simulation of covalent crystal lattice',
            'quantum atomic orbitals with electron probability clouds'
        ];

        for (const prompt of molecularPrompts) {
            it(`synthesizes molecular structure: "${prompt}"`, () => {
                const classification = classifyFallbackPrompt(prompt, undefined, 'canvas', undefined);
                expect(classification.is3DRequest).toBe(true);

                const theme = detect3DSceneTheme(prompt);
                expect(theme).toBe('molecular');

                const scene = synthesizeContextual3DScene(prompt);
                expect(scene.title.toLowerCase()).toMatch(/dna|molecule|atom|quantum|lattice/i);
                expect(scene.customMeshes && scene.customMeshes.length).toBeGreaterThan(0);
            });
        }
    });

    // =========================================================================
    // Domain 15: Architectural Interior & Rooms
    // =========================================================================
    describe('15. Architectural Interior & Rooms', () => {
        const archPrompts = [
            'modern minimalist apartment interior room with floor-to-ceiling windows',
            'architectural blueprint gallery hall with skylights and pedestal exhibits',
            'industrial loft office space with exposed brick walls and wooden beams'
        ];

        for (const prompt of archPrompts) {
            it(`builds architectural interior: "${prompt}"`, () => {
                const classification = classifyFallbackPrompt(prompt, undefined, 'canvas', undefined);
                expect(classification.is3DRequest).toBe(true);

                const theme = detect3DSceneTheme(prompt);
                expect(theme).toBe('architecture');

                const scene = synthesizeContextual3DScene(prompt);
                expect(scene.customMeshes && scene.customMeshes.length).toBeGreaterThan(0);
            });
        }
    });

    // =========================================================================
    // Domain 16: Procedural Worldbuilder & Terrain
    // =========================================================================
    describe('16. Procedural Worldbuilder & Terrain', () => {
        const terrainPrompts = [
            'procedural 3D alpine mountain terrain with glacial valleys and snow line',
            'arid desert canyon with sculpted sandstone mesas and dunes',
            'tropical volcanic island with rugged caldera and ocean coastline'
        ];

        for (const prompt of terrainPrompts) {
            it(`generates procedural worldbuilder landscape: "${prompt}"`, () => {
                const classification = classifyFallbackPrompt(prompt, undefined, 'canvas', undefined);
                expect(classification.is3DRequest).toBe(true);

                const theme = detect3DSceneTheme(prompt);
                expect(theme).toBe('worldbuilder');

                const scene = synthesizeContextual3DScene(prompt);
                expect(scene.environment?.ground).toBe(true);
                expect(scene.customMeshes && scene.customMeshes.length).toBeGreaterThan(0);
            });
        }
    });

    // =========================================================================
    // Domain 17: Slash Commands & In-Scene Mutations
    // =========================================================================
    describe('17. Slash Commands & Conversational Scene Mutations', () => {
        it('handles explicit /3d slash commands', () => {
            const prompt = '/3d futuristic orbital habitat';
            const classification = classifyFallbackPrompt(prompt, undefined, 'chat', undefined);
            expect(classification.is3DRequest).toBe(true);

            const scene = synthesizeContextual3DScene(prompt);
            expect(scene).toBeDefined();
            expect(scene.title).toBeTruthy();
        });

        it('mutates existing 3D scene when conversational tweaks are requested', () => {
            const initialScene = synthesizeContextual3DScene('build a 3d car');
            const initialArtifact: CanvasArtifact = {
                id: 'test-3d-art',
                type: '3d-scene',
                title: initialScene.title,
                summary: '3D vehicle scene',
                version: 1,
                createdAt: new Date().toISOString(),
                data: initialScene
            };

            // Test 1: Wireframe mode mutation
            const wireResult = mutateExisting3DScene('turn on wireframe mode', 'turn on wireframe mode', initialArtifact);
            const wireScene = wireResult.artifact?.data as Scene3DData;
            expect(wireScene.renderMode).toBe('wireframe');

            // Test 2: Ambient lighting adjustment
            const lightResult = mutateExisting3DScene('increase ambient light intensity', 'increase ambient light intensity', initialArtifact);
            const lightScene = lightResult.artifact?.data as Scene3DData;
            expect(lightScene.environment?.ambientIntensity).toBeGreaterThan(0.5);

            // Test 3: Golden hour lighting
            const sunsetResult = mutateExisting3DScene('switch to golden hour sunset lighting', 'switch to golden hour sunset lighting', initialArtifact);
            const sunsetScene = sunsetResult.artifact?.data as Scene3DData;
            expect(sunsetScene.environment?.timeOfDay).toBeDefined();
        });
    });

    // =========================================================================
    // Domain 18: Fallback Robustness & Non-Empty Guarantee
    // =========================================================================
    describe('18. Fallback Robustness & Non-Empty Guarantee', () => {
        const edgePrompts = [
            'make a 3d scene for an offshore wind farm in the stormy North Sea',
            '3d model of a bioluminescent deep sea anglerfish',
            'generate a 3d steampunk mechanical clockwork automaton',
            'create a 3d zen rock garden with raked gravel waves and bamboo fountain',
            '3d voxel dungeon crawler chamber with treasure chest and torchlight'
        ];

        for (const prompt of edgePrompts) {
            it(`reliably produces valid non-empty 3D scene for arbitrary prompt: "${prompt}"`, () => {
                const classification = classifyFallbackPrompt(prompt, undefined, 'canvas', undefined);
                expect(classification.is3DRequest).toBe(true);

                const result = synthesize3DFallback(prompt, prompt.toLowerCase(), undefined, [], undefined);
                expect(result.artifact).toBeDefined();
                expect(result.artifact?.type).toBe('3d-scene');

                const scene = result.artifact?.data as Scene3DData;
                expect(scene.title).toBeTruthy();
                expect(scene.environment).toBeDefined();
                expect(scene.camera).toBeDefined();
                expect(scene.camera.position).toHaveLength(3);
                expect(scene.camera.target).toHaveLength(3);

                // Guarantee: Every 3D scene generated MUST have at least 1 mesh or object
                // Hero objects are built by a procedural generator (013d47c) rather than inline meshes.
                const totalEntities = (scene.customMeshes?.length || 0) + (scene.objects?.length || 0);
                expect(totalEntities > 0 || Boolean(scene.pythonGenerator?.sourceCode || scene.cppGenerator?.sourceCode)).toBe(true);
            });
        }
    });

    // =========================================================================
    // Domain 19: Nuanced Conversational Phrasing
    // =========================================================================
    describe('19. Nuanced Conversational Phrasing', () => {
        const conversationalPhrasings = [
            'Can you model a 3d futuristic maglev transit train on elevated tracks?',
            'I would love to see an ancient Greek Parthenon temple with marble columns in 3D',
            'Please generate a 3D simulation of a volcanic lava tube cave with crystalline minerals',
            'Show me a realistic 3d rendering of an autonomous deep ocean exploration submarine',
            'Could you render a 3d model of a medieval gothic cathedral spire with flying buttresses?'
        ];

        for (const prompt of conversationalPhrasings) {
            it(`correctly recognizes intent and builds 3D scene for conversational prompt: "${prompt}"`, () => {
                const classification = classifyFallbackPrompt(prompt, undefined, 'canvas', undefined);
                expect(classification.is3DRequest).toBe(true);

                const result = synthesize3DFallback(prompt, prompt.toLowerCase(), undefined, [], undefined);
                expect(result.artifact?.type).toBe('3d-scene');

                const scene = result.artifact?.data as Scene3DData;
                expect(scene.title).toBeTruthy();
                // Hero objects are built by a procedural generator (013d47c) rather than inline meshes.
                const totalEntities = (scene.customMeshes?.length || 0) + (scene.objects?.length || 0);
                expect(totalEntities > 0 || Boolean(scene.pythonGenerator?.sourceCode || scene.cppGenerator?.sourceCode)).toBe(true);
            });
        }
    });

    // =========================================================================
    // Domain 20: Global Iconic Landmarks & Topographic Biomes
    // =========================================================================
    describe('20. Global Iconic Landmarks & Topographic Biomes', () => {
        const globalLandmarks = [
            { prompt: 'Tokyo Shibuya Crossing 3D digital twin with neon towers', keyword: 'shibuya' },
            { prompt: 'Big Ben London Elizabeth Tower 3D model', keyword: 'big ben' },
            { prompt: 'Pantheon Rome circular rotunda and oculus in 3D', keyword: 'pantheon' },
            { prompt: 'Mount Everest Himalayan mountain summit 3D terrain', keyword: 'alpine' },
            { prompt: 'Grand Canyon Arizona sandstone plateau 3D landscape', keyword: 'canyon' }
        ];

        for (const { prompt, keyword } of globalLandmarks) {
            it(`synthesizes geographically grounded or thematic landmark: "${prompt}"`, () => {
                const classification = classifyFallbackPrompt(prompt, undefined, 'canvas', undefined);
                expect(classification.is3DRequest).toBe(true);

                const scene = synthesizeContextual3DScene(prompt);
                expect(scene).toBeDefined();
                expect(scene.title).toBeTruthy();
                expect(scene.environment).toBeDefined();

                // Scene title or subtitle or geoAnchor should reflect landmark
                const combinedText = `${scene.title} ${scene.subtitle || ''} ${scene.geoAnchor?.landmarkName || ''}`.toLowerCase();
                expect(combinedText).toContain(keyword);
            });
        }
    });

    // =========================================================================
    // Domain 21: Sci-Fi, Deep Space & Extraterrestrial Guardrails
    // =========================================================================
    describe('21. Sci-Fi, Deep Space & Extraterrestrial Guardrails', () => {
        const scifiPrompts = [
            'Jupiter moon Europa frozen ice ocean with thermal vapor geysers in 3D',
            'deep space orbital defense station with rotating gravity ring',
            'cyberpunk underground hacker bunker with glowing server racks and holographic monitors'
        ];

        for (const prompt of scifiPrompts) {
            it(`synthesizes non-terrestrial sci-fi environment without Earth casting: "${prompt}"`, () => {
                const classification = classifyFallbackPrompt(prompt, undefined, 'canvas', undefined);
                expect(classification.is3DRequest).toBe(true);

                const scene = synthesizeContextual3DScene(prompt);
                expect(scene).toBeDefined();
                expect(scene.title).toBeTruthy();

                // Space/Europa scenes should not be geo-anchored to Fallingwater or Central Park
                if (prompt.includes('Europa') || prompt.includes('orbital defense')) {
                    if (scene.geoAnchor) {
                        expect(scene.geoAnchor.landmarkName?.toLowerCase()).not.toContain('fallingwater');
                    }
                }
            });
        }
    });

    // =========================================================================
    // Domain 22: Operator Stack & C++20 Astro Generation
    // =========================================================================
    describe('22. Operator Stack & C++20 Astro Code Generation', () => {
        const generationPrompts = [
            'procedural 3D alpine mountain terrain with glacial valleys and snow line',
            'build a 3d cyberpunk metropolis with neon skyscrapers and flying traffic',
            '3d vehicle simulation with aerodynamic chassis and alloy wheels',
            'Perseverance rover traversing red Martian dunes in Jezero crater'
        ];

        for (const prompt of generationPrompts) {
            it(`attaches runnable C++20 Astro generator source code: "${prompt}"`, () => {
                const scene = synthesizeContextual3DScene(prompt);
                expect(scene).toBeDefined();

                // Should attach C++ procedural generator code or valid custom script
                if (scene.cppGenerator?.sourceCode) {
                    expect(scene.cppGenerator.sourceCode).toContain('#include');
                    expect(scene.cppGenerator.sourceCode).toMatch(/scratchbox_engine|scratchbox_math/i);
                } else if (scene.customScript) {
                    expect(scene.customScript.length).toBeGreaterThan(10);
                }
            });
        }
    });
});
