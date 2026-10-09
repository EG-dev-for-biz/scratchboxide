import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
    computeMelaninAlbedo,
    HumanoidSkinModality,
    CANONICAL_22_JOINT_NAMES,
    DEFAULT_CANONICAL_JOINTS
} from '../src/common';
import {
    SbHumanAvatarService,
    PbrMeshSkinAdapter,
    Gaussian4DGSSkinAdapter,
    PerformerSurfaceMeshService,
    decodeSurfaceGlb
} from '../src/node';
import {
    HUMANOID_AVATAR_TOOL_DECLARATIONS,
    humanoidAvatarHandlers,
    avatar4dgsHandlers
} from '../src/node/gemini/tools/spatial-tools';
import {
    ConcertStagePerformerService,
    PerformerSkinningMode
} from '../src/browser/generative-canvas/services/ConcertStagePerformerService';

describe('Humanoid Avatar Pipeline & Multi-Modality Skinning', () => {
    it('computes biophysical melanin albedos conforming to physical optical absorption', () => {
        // Test pale/light skin tone (low melanin)
        const paleAlbedo = computeMelaninAlbedo(0.1, 0.2);
        expect(paleAlbedo[0]).toBeGreaterThan(0.6);
        expect(paleAlbedo[1]).toBeGreaterThan(0.4);
        expect(paleAlbedo[2]).toBeGreaterThan(0.25);
        expect(paleAlbedo[3]).toBe(1.0);

        // Test deep dark skin tone (high melanin)
        const darkAlbedo = computeMelaninAlbedo(0.9, 0.1);
        expect(darkAlbedo[0]).toBeLessThan(0.3);
        expect(darkAlbedo[1]).toBeLessThan(0.2);
        expect(darkAlbedo[2]).toBeLessThan(0.15);
        expect(darkAlbedo[3]).toBe(1.0);

        // Melanin monotonicity: higher melanin must strictly reduce luminance
        const lumPale = 0.2126 * paleAlbedo[0] + 0.7152 * paleAlbedo[1] + 0.0722 * paleAlbedo[2];
        const lumDark = 0.2126 * darkAlbedo[0] + 0.7152 * darkAlbedo[1] + 0.0722 * darkAlbedo[2];
        expect(lumDark).toBeLessThan(lumPale);

        // Warm pheomelanin shift: higher pheomelanin enhances red-to-green ratio
        const eumelanin = computeMelaninAlbedo(0.5, 0.0);
        const pheomelanin = computeMelaninAlbedo(0.5, 1.0);
        const redRatioEu = eumelanin[0] / (eumelanin[1] + 1e-4);
        const redRatioPheo = pheomelanin[0] / (pheomelanin[1] + 1e-4);
        expect(redRatioPheo).toBeGreaterThanOrEqual(redRatioEu);
    });

    it('SbHumanAvatarService lists actors and catalogs multi-modal skinning adapters', async () => {
        const service = new SbHumanAvatarService();
        const actors = await service.listActors();

        expect(actors.length).toBeGreaterThan(0);
        const demo = actors.find(a => a.actorId === '2785536');
        expect(demo).toBeDefined();
        if (demo) {
            expect(demo.canonicalJoints.length).toBe(22);
            expect(demo.availableModalities).toContain('4dgs-radiance');
            expect(demo.availableModalities).toContain('pbr-standard');
            expect(demo.availableModalities).toContain('pbr-melanin');
            expect(demo.availableModalities).toContain('2dgs-planar-surfel');
            expect(demo.heightMeters).toBeGreaterThan(1.0);
            expect(demo.heightMeters).toBeLessThan(2.5);
        }
    });

    it('PbrMeshSkinAdapter evaluates frame and exports rigged glTF 2.0 with skin and bones', async () => {
        const service = new SbHumanAvatarService();
        const adapter = await service.getSkinAdapter('2785536', 'pbr-standard');
        expect(adapter).toBeInstanceOf(PbrMeshSkinAdapter);
        expect(adapter.modality).toBe('pbr-standard');

        const frame0 = await adapter.evaluateFrame(0);
        expect(frame0.positions.length).toBeGreaterThan(0);
        expect(frame0.normals.length).toBe(frame0.positions.length);
        expect(frame0.joints.length).toBe((frame0.positions.length / 3) * 4);
        expect(frame0.weights.length).toBe((frame0.positions.length / 3) * 4);
        expect(frame0.vertexCount).toBe(frame0.positions.length / 3);

        // Verify partition of unity: sum of 4 bone weights == 1.0
        const weights = frame0.weights;
        for (let i = 0; i < Math.min(100, weights.length); i += 4) {
            const sumW = weights[i] + weights[i + 1] + weights[i + 2] + weights[i + 3];
            expect(sumW).toBeCloseTo(1.0, 3);
        }

        // Export rigged GLB
        const glbBuffer = await adapter.exportArtifact({
            format: 'glb',
            modality: 'pbr-standard'
        });
        expect(glbBuffer).toBeDefined();
        expect(glbBuffer.byteLength).toBeGreaterThan(1000);

        // Verify GLB magic header: 0x46546C67 ("glTF")
        const magic = Buffer.from(glbBuffer).readUInt32LE(0);
        expect(magic).toBe(0x46546C67);

        // Decode surface GLB and verify roundtrip fidelity
        const decoded = decodeSurfaceGlb(glbBuffer);
        expect(decoded.positions.length).toBe(frame0.positions.length);
        expect(decoded.normals!.length).toBe(frame0.normals!.length);
        expect(decoded.indices.length).toBeGreaterThan(0);
        expect(decoded.skinIndices.length).toBe(frame0.joints!.length);
        expect(decoded.skinWeights.length).toBe(frame0.weights!.length);

        // Verify glTF JSON structure contains skins and bone hierarchy
        const jsonLength = Buffer.from(glbBuffer).readUInt32LE(12);
        const jsonText = Buffer.from(glbBuffer).subarray(20, 20 + jsonLength).toString('utf8');
        const gltf = JSON.parse(jsonText);

        expect(gltf.skins).toBeDefined();
        expect(gltf.skins.length).toBe(1);
        expect(gltf.skins[0].joints.length).toBe(22);
        expect(gltf.skins[0].inverseBindMatrices).toBeDefined();

        // Nodes: node 0 is mesh, nodes 1..22 are bones
        expect(gltf.nodes.length).toBe(23);
        expect(gltf.nodes[0].mesh).toBe(0);
        expect(gltf.nodes[0].skin).toBe(0);
        expect(gltf.nodes[1].name).toBe('pelvis');
    });

    it('PbrMeshSkinAdapter applies melanin pigmentation in exportArtifact', async () => {
        const service = new SbHumanAvatarService();
        const adapter = await service.getSkinAdapter('2785536', 'pbr-melanin');

        const glbBuffer = await adapter.exportArtifact({
            format: 'glb',
            modality: 'pbr-melanin',
            melaninFraction: 0.8,
            pheomelaninRatio: 0.3
        });

        const jsonLength = Buffer.from(glbBuffer).readUInt32LE(12);
        const jsonText = Buffer.from(glbBuffer).subarray(20, 20 + jsonLength).toString('utf8');
        const gltf = JSON.parse(jsonText);

        const material = gltf.materials[0];
        expect(material).toBeDefined();
        expect(material.pbrMetallicRoughness.baseColorFactor).toBeDefined();
        const baseColor = material.pbrMetallicRoughness.baseColorFactor;
        expect(baseColor.length).toBe(4);
        // Rich dark skin tone: R < 0.4
        expect(baseColor[0]).toBeLessThan(0.4);
    });

    it('Gaussian4DGSSkinAdapter evaluates frames and exports valid .splat binary', async () => {
        const service = new SbHumanAvatarService();
        const adapter = await service.getSkinAdapter('2785536', '4dgs-radiance');
        expect(adapter).toBeInstanceOf(Gaussian4DGSSkinAdapter);

        const frame0 = await adapter.evaluateFrame(0);
        expect(frame0.gaussianCount).toBeGreaterThan(0);
        expect(frame0.positions.length).toBe((frame0.gaussianCount ?? 0) * 3);

        const splatBuffer = await adapter.exportArtifact({
            format: 'splat',
            modality: '4dgs-radiance',
            frameIndex: 0
        });

        expect(splatBuffer.byteLength).toBe((frame0.gaussianCount ?? 0) * 32);
    });

    it('humanoid avatar Gemini spatial tools respond with correct schemas and payloads', async () => {
        expect(HUMANOID_AVATAR_TOOL_DECLARATIONS.length).toBe(4);
        const names = HUMANOID_AVATAR_TOOL_DECLARATIONS.map(d => d.name);
        expect(names).toContain('humanoid_avatar_list');
        expect(names).toContain('humanoid_avatar_get');
        expect(names).toContain('humanoid_avatar_skin');
        expect(names).toContain('humanoid_avatar_animate');

        // Test humanoid_avatar_list
        const listRes = await humanoidAvatarHandlers.humanoid_avatar_list({});
        expect(listRes.summaryResult).toContain('Found');
        const listPayload = listRes.resultPayload as any;
        expect(listPayload.totalActors).toBeGreaterThan(0);

        // Test humanoid_avatar_get
        const getRes = await humanoidAvatarHandlers.humanoid_avatar_get({ actorId: '2785536' });
        expect(getRes.summaryResult).toContain('Retrieved actor');
        const getPayload = getRes.resultPayload as any;
        expect(getPayload.actor.actorId).toBe('2785536');
        expect(getPayload.actor.canonicalJoints.length).toBe(22);

        // Test humanoid_avatar_skin with PBR
        const skinRes = await humanoidAvatarHandlers.humanoid_avatar_skin({
            actorId: '2785536',
            modality: 'pbr-standard',
            format: 'glb'
        });
        expect(skinRes.summaryResult).toContain('Evaluated actor');
        const skinPayload = skinRes.resultPayload as any;
        expect(skinPayload.vertexCount).toBeGreaterThan(0);
        expect(skinPayload.artifactBytes).toBeGreaterThan(1000);

        // Test humanoid_avatar_animate
        const animRes = await humanoidAvatarHandlers.humanoid_avatar_animate({
            actorId: '2785536',
            frameIndex: 5,
            modality: 'pbr-standard'
        });
        expect(animRes.summaryResult).toContain('Animated actor');
        const animPayload = animRes.resultPayload as any;
        expect(animPayload.bounds).toBeDefined();

        // Cross-compatibility in avatar4dgsHandlers
        expect(typeof avatar4dgsHandlers.humanoid_avatar_list).toBe('function');
        expect(typeof avatar4dgsHandlers.humanoid_avatar_get).toBe('function');
        expect(typeof avatar4dgsHandlers.humanoid_avatar_skin).toBe('function');
        expect(typeof avatar4dgsHandlers.humanoid_avatar_animate).toBe('function');
    });

    it('ConcertStagePerformerService seamlessly accepts rigged PBR SkinnedMesh and updates skeleton', () => {
        const service = new ConcertStagePerformerService();
        expect(service.skinningMode).toBe(PerformerSkinningMode.SCRATCHBOX_LBS_4BONE);

        // Create a 22-bone Three.js SkinnedMesh
        const bones: THREE.Bone[] = [];
        for (let i = 0; i < 22; i++) {
            const bone = new THREE.Bone();
            bone.name = CANONICAL_22_JOINT_NAMES[i];
            bone.position.set(...DEFAULT_CANONICAL_JOINTS[i]);
            bones.push(bone);
        }
        const skeleton = new THREE.Skeleton(bones);
        const geometry = new THREE.BoxGeometry(0.5, 1.8, 0.3);
        const material = new THREE.MeshStandardMaterial({ color: 0x999999, roughness: 0.6 });
        const skinnedMesh = new THREE.SkinnedMesh(geometry, material);
        skinnedMesh.bind(skeleton);

        service.loadPerformerMesh(skinnedMesh);
        expect(service.performerGroup.children).toContain(skinnedMesh);

        // Test visibility toggles
        service.setMeshVisibility(false);
        expect(skinnedMesh.visible).toBe(false);
        service.setMeshVisibility(true);
        expect(skinnedMesh.visible).toBe(true);

        // Set skinning mode to PBR
        service.setSkinningMode(PerformerSkinningMode.PBR_RIGGED_MESH);
        expect(service.skinningMode).toBe(PerformerSkinningMode.PBR_RIGGED_MESH);

        // Ingest kinematics motion frames and evaluate
        const motionFrames = [
            {
                frameIndex: 0,
                timestamp: 0.0,
                jointPositions: DEFAULT_CANONICAL_JOINTS.map(j => [j[0], j[1] + 0.1, j[2]] as [number, number, number]),
                rootTranslation: [0, 0, 0] as [number, number, number],
                rootRotation: [0, 0, 0, 1] as [number, number, number, number]
            }
        ];
        service.loadMotionFrames(motionFrames);
        service.evaluateCurrentFrame();

        // Verify bones were updated with stage deck ground altitude compensation
        const pelvisBone = bones[0];
        expect(pelvisBone.position.y).toBeGreaterThan(0);
    });
});
