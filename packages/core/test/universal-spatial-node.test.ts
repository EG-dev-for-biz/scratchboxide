/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * Universal Spatial Node Unit Tests
 * Validates scale-free tectonic hierarchies, positive mass vs. negative cavity
 * polarities, metric OBB bounding, surface mount planes, and tree traversals.
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import {
    createSpatialNode,
    findSpatialNodeById,
    flattenSpatialTree,
    transformSpatialNode,
    multiplyMatrices4x4,
    createTranslationMatrix,
    createIdentityMatrix,
    classifyMountPlaneFromNormal,
    type UniversalSpatialNode,
    type SurfaceMountPlane
} from '../src/common/spatial/universal-spatial-node';

describe('UniversalSpatialNode (Scale-Free Tectonic Hierarchy)', () => {
    it('creates a root node with positive mass polarity and identity transform', () => {
        const root = createSpatialNode({
            id: 'building-root',
            name: 'Empire Tower',
            polarity: 'positive_mass',
            localBounds: {
                center: [0, 50, 0],
                halfExtents: [20, 50, 20]
            },
            tags: ['commercial_skyscraper', 'mass']
        });

        expect(root.id).toBe('building-root');
        expect(root.polarity).toBe('positive_mass');
        expect(root.localTransform).toEqual(createIdentityMatrix());
        expect(root.children).toEqual([]);
        expect(root.mountPlanes).toEqual([]);
        expect(root.tags).toContain('commercial_skyscraper');
    });

    it('attaches negative cavity floor nodes with surface mount planes', () => {
        const floorMount: SurfaceMountPlane = {
            id: 'mount_floor_1',
            name: 'Floor 1 Slab Top',
            planeType: 'floor',
            planeEquation: [0, 1, 0, 0],
            normal: [0, 1, 0],
            center: [0, 0, 0],
            dimensions: [38, 38]
        };

        const ceilingMount: SurfaceMountPlane = {
            id: 'mount_ceiling_1',
            name: 'Floor 1 Ceiling Soffit',
            planeType: 'ceiling',
            planeEquation: [0, -1, 0, 3.2],
            normal: [0, -1, 0],
            center: [0, 3.2, 0],
            dimensions: [38, 38]
        };

        const floorNode = createSpatialNode({
            id: 'floor_1_cavity',
            name: 'Level 1 Interior Cavity',
            polarity: 'negative_cavity',
            localBounds: {
                center: [0, 1.6, 0],
                halfExtents: [19, 1.6, 19]
            },
            mountPlanes: [floorMount, ceilingMount],
            tags: ['floor_1', 'cavity']
        });

        const root = createSpatialNode({
            id: 'building-root',
            name: 'Office Building',
            polarity: 'positive_mass',
            children: [floorNode]
        });

        expect(root.children.length).toBe(1);
        expect(root.children[0].polarity).toBe('negative_cavity');
        expect(root.children[0].mountPlanes.length).toBe(2);
        expect(root.children[0].mountPlanes[0].planeType).toBe('floor');
        expect(root.children[0].mountPlanes[1].planeType).toBe('ceiling');
    });

    it('finds spatial nodes by ID and flattens hierarchy correctly', () => {
        const deskNode = createSpatialNode({
            id: 'desk_executive_1',
            name: 'Executive Travertine Desk',
            polarity: 'positive_mass',
            tags: ['furniture', 'prop']
        });

        const roomNode = createSpatialNode({
            id: 'office_room_101',
            name: 'Corner Office',
            polarity: 'negative_cavity',
            children: [deskNode]
        });

        const floorNode = createSpatialNode({
            id: 'floor_10',
            name: 'Floor 10',
            polarity: 'negative_cavity',
            children: [roomNode]
        });

        const root = createSpatialNode({
            id: 'skyscraper_root',
            name: 'Skyscraper Tower',
            polarity: 'positive_mass',
            children: [floorNode]
        });

        // Test findSpatialNodeById
        const foundDesk = findSpatialNodeById(root, 'desk_executive_1');
        expect(foundDesk).toBeDefined();
        expect(foundDesk?.name).toBe('Executive Travertine Desk');

        const foundMissing = findSpatialNodeById(root, 'non_existent_node');
        expect(foundMissing).toBeUndefined();

        // Test flattenSpatialTree
        const flattened = flattenSpatialTree(root);
        expect(flattened.length).toBe(4);
        expect(flattened.map(n => n.id)).toEqual([
            'skyscraper_root',
            'floor_10',
            'office_room_101',
            'desk_executive_1'
        ]);
    });

    it('transforms spatial node matrices and propagates translation', () => {
        const node = createSpatialNode({
            id: 'prop_chair',
            name: 'Office Chair',
            localBounds: {
                center: [0, 0.5, 0],
                halfExtents: [0.3, 0.5, 0.3]
            }
        });

        const translation = createTranslationMatrix(10, 0, -25);
        const transformedNode = transformSpatialNode(node, translation);

        expect(transformedNode.localTransform[12]).toBe(10);
        expect(transformedNode.localTransform[13]).toBe(0);
        expect(transformedNode.localTransform[14]).toBe(-25);
        expect(transformedNode.localBounds?.center).toEqual([10, 0.5, -25]);
    });

    it('defaults localBounds to unit OBB when omitted, avoiding runtime exceptions', () => {
        const nodeWithoutBounds = createSpatialNode({
            id: 'unbounded_prop',
            name: 'Unbounded Prop'
        });

        expect(nodeWithoutBounds.localBounds).toBeDefined();
        expect(nodeWithoutBounds.localBounds.center).toEqual([0, 0, 0]);
        expect(nodeWithoutBounds.localBounds.halfExtents).toEqual([0.5, 0.5, 0.5]);
    });

    it('classifies mount planes continuously from normal vectors and supports open literal types', () => {
        // Upward normal -> floor
        expect(classifyMountPlaneFromNormal([0, 1, 0])).toBe('floor');
        expect(classifyMountPlaneFromNormal([0.05, 0.99, 0])).toBe('floor');

        // Downward normal -> ceiling
        expect(classifyMountPlaneFromNormal([0, -1, 0])).toBe('ceiling');

        // Lateral normal -> wall
        expect(classifyMountPlaneFromNormal([1, 0, 0])).toBe('wall');
        expect(classifyMountPlaneFromNormal([0, 0.1, 1])).toBe('wall');

        // Angled normal -> inclined_plane
        expect(classifyMountPlaneFromNormal([0.707, 0.707, 0])).toBe('inclined_plane');

        // Open literal mount plane types (Alien Planet / Custom test)
        const alienMount: SurfaceMountPlane = {
            id: 'mount_alien_1',
            name: 'Plasma Conduit Dock',
            planeType: 'plasma_conduit_dock', // arbitrary string & {} open literal
            planeEquation: [0, 1, 0, -2.5],
            normal: [0, 1, 0],
            center: [0, 2.5, 0],
            dimensions: [1.2, 0.8]
        };
        expect(alienMount.planeType).toBe('plasma_conduit_dock');
    });
});
