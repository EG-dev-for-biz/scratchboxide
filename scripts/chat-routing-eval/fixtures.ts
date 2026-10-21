/**
 * Open-canvas states for the chat routing eval's edit requests. `staged-flatiron` is the artifact the live app held
 * after "Build a 3D scene of the Flatiron Building" (2026-10-20, large fields left out); the others are minimal
 * artifacts of each type with the fields the chat reads.
 */
import STAGED_FLATIRON from './staged-flatiron.json';

const drone = {
    subject: 'sci-fi cargo drone with four rotors',
    boundingMeters: [1.6, 0.45, 1.6],
    expectedBodies: 1,
    observations: ['central disc body', 'four arms at 45 degrees', 'a rotor ring at the end of each arm', 'cargo pod underneath'],
    parts: [
        { id: 'body', label: 'disc body', material: { baseColor: [0.6, 0.62, 0.65], roughness: 0.4, metalness: 0.8, transmission: 0 }, revolve: { profile: [[0, 0], [0.35, 0], [0.4, 0.08], [0.3, 0.16], [0, 0.18]], lobes: 0, twistDeg: 0, segments: 48 } },
        { id: 'arm', label: 'arm', parentId: 'body', material: { baseColor: [0.2, 0.2, 0.22], roughness: 0.5, metalness: 0.6, transmission: 0 }, sweep: { path: [[0.3, 0.1, 0], [0.7, 0.1, 0]], profileRadiusMeters: 0.03 }, replicate: { count: 4, pattern: 'ring', radiusMeters: 0 } },
        { id: 'rotor', label: 'rotor ring', parentId: 'arm', material: { baseColor: [0.1, 0.1, 0.1], roughness: 0.6, metalness: 0.2, transmission: 0 }, revolve: { profile: [[0.18, 0], [0.2, 0], [0.2, 0.04], [0.18, 0.04]], lobes: 0, twistDeg: 0, segments: 64 } }
    ]
};

export const FIXTURES: Record<string, unknown> = {
    'staged-flatiron': STAGED_FLATIRON,
    'object-drone': {
        id: 'scene-drone-1',
        type: '3d-scene',
        title: 'Sci-fi cargo drone',
        data: {
            title: 'Sci-fi cargo drone',
            renderMode: 'pbr',
            environment: { skybox: 'studio', lighting: 'studio' },
            objectBuild: { spec: drone },
            objects: [{
                id: 'obj-drone-1',
                content: { metadata: { source: 'build_3d_object_from_reference', description: 'sci-fi cargo drone', objectBuild: { spec: drone } } }
            }]
        }
    },
    'sandbox-1776': {
        id: 'sandbox-1776',
        type: 'live-code-sandbox',
        title: '1776 Events Tracker',
        data: { files: { '/App.tsx': 'export default function App() { return <div className="p-4"><h1>Events of 1776</h1></div>; }' }, entry: '/App.tsx' }
    },
    'doc-spec': {
        id: 'doc-drone-spec',
        type: 'markdown-document',
        title: 'Drone Delivery Service: Product Spec',
        data: {
            title: 'Drone Delivery Service: Product Spec',
            sections: [
                { id: 's1', title: 'Overview', content: 'A same-hour delivery service for parcels under 2 kg within 10 km.' },
                { id: 's2', title: 'Users', content: 'Urban households and small shops.' },
                { id: 's3', title: 'Requirements', content: 'Autonomous flight, geofenced routes, drop-off by tether.' }
            ]
        }
    }
};
