import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GltfBinaryPacker } from '../src/node/3d-engine/gltf-binary-packer';
import { SurveySplatPipelineService } from '../src/node/spatial/SurveySplatPipelineService';
import { readGlbScene, sceneToRenderMesh } from '../src/node/spatial/StreetViewPoseRegistrar';
import { WALK_SURFACE_FILE, writeWalkSurface } from '../src/node/spatial/street-walk-surface';
import { WalkCollisionWorld } from '../src/browser/generative-canvas/primitives/scene3d/walkCollision';
import { WALK_DEFAULTS, Walker } from '../src/browser/generative-canvas/primitives/scene3d/walkMode';

/** A scan of two parts: a 20 m street square at y = 0, and a wall 4 m high standing at x = 5 (a node moved there). */
function writeScan(file: string): void {
    const street = new Float32Array([-10, 0, -10, 10, 0, -10, 10, 0, 10, -10, 0, 10]);
    const wall = new Float32Array([0, 0, -10, 0, 0, 10, 0, 4, 10, 0, 4, -10]);
    const quad = new Uint32Array([0, 1, 2, 0, 2, 3]);
    const buf = (a: Float32Array | Uint32Array) => Buffer.from(a.buffer, a.byteOffset, a.byteLength);
    GltfBinaryPacker.writeGlb(file, {
        asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0, 1] }],
        nodes: [{ mesh: 0 }, { mesh: 1, translation: [5, 0, 0] }],
        meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 2, mode: 4 }] }, { primitives: [{ attributes: { POSITION: 1 }, indices: 2, mode: 4 }] }],
        accessors: [
            { bufferView: 0, componentType: 5126, count: 4, type: 'VEC3', min: [-10, 0, -10], max: [10, 0, 10] },
            { bufferView: 1, componentType: 5126, count: 4, type: 'VEC3', min: [0, 0, -10], max: [0, 4, 10] },
            { bufferView: 2, componentType: 5125, count: 6, type: 'SCALAR' }
        ],
        bufferViews: [{ target: 34962 }, { target: 34962 }, { target: 34963 }]
    }, [buf(street), buf(wall), buf(quad)]);
}

describe('the walk surface of a splat world', () => {
    let tmp: string;
    beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sb_walk_surface_')); });
    afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

    it('is the scan\'s own triangles in the scan\'s frame, as one untextured mesh', () => {
        const scan = path.join(tmp, 'scan.glb'), out = path.join(tmp, WALK_SURFACE_FILE);
        writeScan(scan);
        const report = writeWalkSurface(scan, out);
        expect(report).toMatchObject({ path: out, vertices: 8, triangles: 4, bytes: fs.statSync(out).size });
        const glb = fs.readFileSync(out);
        expect(glb.subarray(0, 4).toString('latin1')).toBe('glTF');
        const json = JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)).toString('utf8'));
        expect(json.meshes).toHaveLength(1);
        expect(json.materials).toBeUndefined();
        expect(json.images).toBeUndefined();
        // the wall's node moved it to x = 5: the surface holds it there
        expect(json.accessors[0].min).toEqual([-10, 0, -10]);
        expect(json.accessors[0].max).toEqual([10, 4, 10]);
        const back = sceneToRenderMesh(readGlbScene(out));
        expect(back.indices.length).toBe(12);
        const xs = Array.from(back.vertices).filter((_, i) => i % 3 === 0);
        expect(xs.filter(x => x === 5)).toHaveLength(4);
    });

    it('holds a walker the viewport never draws it for: feet on the street, stopped at the wall', () => {
        const scan = path.join(tmp, 'scan.glb'), out = path.join(tmp, WALK_SURFACE_FILE);
        writeScan(scan);
        writeWalkSurface(scan, out);
        const read = sceneToRenderMesh(readGlbScene(out));
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(Float32Array.from(read.vertices), 3));
        geometry.setIndex(new THREE.Uint32BufferAttribute(Uint32Array.from(read.indices), 1));
        // as the viewport holds it: a helper group on a layer no camera reads, which the walker is told to meet
        const surface = new THREE.Group();
        surface.userData.isHelper = true;
        const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
        mesh.layers.set(7);
        surface.add(mesh);
        const scene = new THREE.Scene();
        scene.add(surface);
        scene.updateMatrixWorld(true);
        const meets = (m: THREE.Mesh) => {
            for (let cur: THREE.Object3D | null = m; cur; cur = cur.parent) {
                if (cur === surface) return true;
                if (cur.userData.isHelper) return false;
            }
            return true;
        };
        const walker = new Walker(new WalkCollisionWorld(scene, meets));
        // a street panorama's eye, 2.5 m up: walking starts with the feet on the street under it
        walker.placeAt(new THREE.Vector3(0, 2.5, 0), -Math.PI / 2, 0, 'walk');
        expect(walker.grounded).toBe(true);
        expect(walker.feet.y).toBeCloseTo(0, 4);
        expect(walker.eye(new THREE.Vector3()).y).toBeCloseTo(WALK_DEFAULTS.eyeHeight, 4);
        // ten seconds toward +x (yaw -90 degrees) would cover 14 m; the wall at x = 5 stops it a body's radius short
        for (let i = 0; i < 600; i++) walker.step(1 / 60, { forward: 1, right: 0, up: 0, run: false });
        expect(walker.feet.y).toBeCloseTo(0, 4);
        expect(walker.feet.x).toBeGreaterThan(4);
        expect(walker.feet.x).toBeLessThan(5 - WALK_DEFAULTS.radius + 0.02);
    });

    it('is named in the world\'s scene, which then opens first person', () => {
        const dir = path.join(process.cwd(), 'public', 'tilesets', 'x');
        const result = { success: true, stations: [], fusedSplatPath: path.join(dir, 'fused.splat'), fusedSplatCount: 10, tilesetPath: path.join(dir, 'tileset.json'), metaPath: '', cropBox: { min: [-50, -2, -50] as [number, number, number], max: [50, 40, 50] as [number, number, number] }, durationMs: 0 };
        const anchor = { lat: 40.7505, lng: -73.9925, elevationMeters: 12, headingDeg: 0, formattedAddress: 'test vantage' };
        const { scene3DData } = SurveySplatPipelineService.toScene3DData(result as any, anchor, 'Test Place', { vantage: { eye: [3, 1.6, -4], headingDeg: 90 }, walkSurfacePath: path.join(dir, WALK_SURFACE_FILE) });
        expect(scene3DData.cameraMode).toBe('fps');
        expect(scene3DData.walkSurface).toEqual({ url: `/tilesets/x/${WALK_SURFACE_FILE}` });
        expect(SurveySplatPipelineService.toScene3DData(result as any, anchor, 'Test Place').scene3DData.walkSurface).toBeUndefined();
    });
});
