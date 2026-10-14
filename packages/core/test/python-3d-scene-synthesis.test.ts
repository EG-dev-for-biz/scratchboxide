import { describe, it, expect } from 'vitest';
import { parseOrSynthesizeArtifact, generateNativeCppGenerator } from '../src/node/gemini/artifact-synthesis';
import { Scene3DData } from '../src/browser/generative-canvas/canvas-types';

describe('Python 3D Scene Architecture & Grounded Zero-Defaults Verification', () => {
    it('1. Synthesizes 3d-scene artifact directly from python scratchbox code block without falling back to live-code-sandbox', () => {
        const pythonCode = `\`\`\`python
import scratchbox as sb

# Create a grounded showcase pedestal
pedestal = sb.geometry.create_studio_pedestal(radius=3.5, height=0.3, bevel_radius=0.04)

# Create an architectural test cube
cube = sb.geometry.create_cube(width=1.5, height=1.5, depth=1.5)
cube.translate(0.0, 1.0, 0.0)

# Merge and stream directly
scene = sb.geometry.Mesh()
scene.append(pedestal)
scene.append(cube)
sb.io.write_glb(OUTPUT_GLB_PATH, scene)
\`\`\``;

        const modelResponse = `Here is the procedural 3D scene designed using the Blender mental model:\n\n${pythonCode}\n\nThe scene is now rendered with a grounded pedestal.`;

        const artifact = parseOrSynthesizeArtifact(
            'Create a procedural 3D sculpture on a pedestal',
            modelResponse,
            { prompt: 'Create a procedural 3D sculpture on a pedestal' } as any,
            []
        );

        expect(artifact).toBeDefined();
        expect(artifact?.type).toBe('3d-scene');

        const sceneData = artifact?.data as Scene3DData;
        expect(sceneData.pythonGenerator).toBeDefined();
        expect(sceneData.pythonGenerator?.enabled).toBe(true);
        expect(sceneData.pythonGenerator?.sourceCode).toContain('import scratchbox as sb');
        expect(sceneData.pythonGenerator?.glbBase64).toBeDefined();
        expect(typeof sceneData.pythonGenerator?.glbBase64).toBe('string');
        expect(sceneData.pythonGenerator?.glbBase64?.length).toBeGreaterThan(50);
    });

    it('2. Neutralizes floating wavy cloth by emitting a grounded studio pedestal when terrain is not explicitly requested', () => {
        const cppCode = generateNativeCppGenerator('Cyberpunk Outpost Laboratory');
        expect(cppCode).toContain('generateStudioPedestal');
        expect(cppCode).not.toContain('ProceduralTerrainSDF');
        expect(cppCode).not.toContain('sphereBound * 0.15f');
    });

    it('3. Generates grounded geological terrain with edge damping to ground plane (y=0) when terrain is explicitly requested', () => {
        const cppCode = generateNativeCppGenerator('Rocky Canyon Mountain Landscape');
        expect(cppCode).toContain('Grounded Geological Terrain');
        expect(cppCode).toContain('edgeFade');
        expect(cppCode).not.toContain('ProceduralTerrainSDF');
        expect(cppCode).not.toContain('sphereBound * 0.15f');
    });

    it('4. Executes the 5-Stage Spatial Architect pipeline with relative sockets, non-linear deformers, and catenary splines', async () => {
        const { NativePythonRunnerService } = await import('../src/node/3d-engine/native-python-runner-service');
        const runner = NativePythonRunnerService.getInstance();

        const script = `
import scratchbox as sb
import math

scene = sb.geometry.Mesh("SpatialArchitectOrganism")

# PASS 1: Analytical Blockout & Sockets
bounds = sb.layout.BoundingVolume(extents=(16.0, 4.0, 20.0), center=(0.0, 2.0, 0.0))
socket_tail = bounds.get_socket("tail")
socket_wing_l = bounds.get_socket("left")
socket_wing_r = bounds.get_socket("right")

# PASS 2: Primary Massing
body = sb.create_sphere(radius=3.0, segments=24)
body.scale(1.4, 0.45, 2.2)
body.taper(factor=0.3, axis=2)
body.displace(freq=1.5, amp=0.06)
body.apply_material(sb.pbr.PbrMaterial(base_color="#1e293b", roughness=0.3, metalness=0.9))
scene.merge(body)

# PASS 3 & 4: Deformed Wings & Catenary Cables
wing_l = sb.create_box(width=6.5, height=0.2, depth=5.0)
wing_l.taper(factor=0.2, axis=0)
wing_l.bend(angle_deg=20.0, radius=4.0)
wing_l.translate(socket_wing_l.x - 2.5, socket_wing_l.y + 0.2, socket_wing_l.z)
wing_l.apply_material(sb.pbr.PbrMaterial(base_color="#0ea5e9", roughness=0.2, metalness=0.9))
scene.merge(wing_l)

cable = sb.geometry.create_catenary_cable(start=socket_tail, end=(socket_tail.x, socket_tail.y - 2.0, socket_tail.z - 8.0), sag=0.8, radius=0.06)
cable.apply_material(sb.pbr.PbrMaterial.polished_brass())
scene.merge(cable)

# PASS 5: Curvature AO & Export
scene.compute_curvature_ao(intensity=0.7)
sb.io.write_glb(OUTPUT_GLB_PATH, scene)
`;

        const result = await runner.runScript(script);
        expect(result.success).toBe(true);
        expect(result.exitCode).toBe(0);
        expect(result.glbBase64).toBeDefined();
        expect(result.glbBase64?.length).toBeGreaterThan(100);

        // Test GLTF parsing & camera calculation
        const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
        const { computeSceneGeometryBounds, calculateStandoffCamera } = await import('../src/browser/generative-canvas/primitives/scene3d/autoFraming');
        const THREE = await import('three');

        const b64 = result.glbBase64!;
        const binaryStr = Buffer.from(b64, 'base64').toString('binary');
        const bytes = new Uint8Array(binaryStr.length);
        for (let i = 0; i < binaryStr.length; i++) {
            bytes[i] = binaryStr.charCodeAt(i);
        }

        const loader = new GLTFLoader();
        let parsedGltf: any = null;
        await new Promise<void>((resolve, reject) => {
            loader.parse(bytes.buffer, '', (gltf) => {
                parsedGltf = gltf;
                resolve();
            }, reject);
        });

        expect(parsedGltf).toBeDefined();
        const testScene = new THREE.Scene();
        testScene.add(parsedGltf.scene);

        const bounds = computeSceneGeometryBounds(testScene);
        expect(bounds.hasGeometry).toBe(true);
        expect(bounds.box.isEmpty()).toBe(false);

        const autoFrame = calculateStandoffCamera(bounds, undefined, { fovDegrees: 45, force: true });
        console.log('Bounds:', bounds.box.min, bounds.box.max, 'Sphere:', bounds.sphere.center, bounds.sphere.radius);
        console.log('AutoFrame:', autoFrame);
        expect(autoFrame).toBeDefined();
        expect(autoFrame?.distance).toBeGreaterThan(1);
    });
});
