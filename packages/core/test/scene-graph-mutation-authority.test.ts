/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * Test suite for Persistent Scene Graph Authority, Transactional Leases,
 * DAG Incremental Dirty Evaluation, and Provenance Verification.
 ********************************************************************************/

import { describe, it, expect, beforeEach } from 'vitest';
import {
  createSpatialNode,
  computeNodeContentHash,
  markNodeDirty,
  getDirtyNodes,
  clearDirtyFlags,
  type UniversalSpatialNode
} from '../src/common/spatial/universal-spatial-node';
import {
  SceneGraphMutationService,
  type SpatialSceneGraphMutation
} from '../src/node/spatial/SceneGraphMutationService';
import { Universal3DStructureFoundation } from '../src/node/spatial/Universal3DStructureFoundation';

describe('Persistent Scene Graph Authority & Transactional Scopes', () => {
  let service: SceneGraphMutationService;
  let rootNode: UniversalSpatialNode;
  let buildingNode: UniversalSpatialNode;
  let facadeNode: UniversalSpatialNode;
  let roadNode: UniversalSpatialNode;

  beforeEach(() => {
    service = new SceneGraphMutationService();

    // Create hierarchy:
    // root (CityBlock)
    //   ├── building (Manhattan1920)
    //   │     └── facade_front (FrontFacade)
    //   └── road (MadisonAvenue)

    facadeNode = createSpatialNode('facade_front', 'mesh', {
      name: 'Front Façade',
      role: 'facade',
      parameters: { windowCount: 12, apertureWidth: 1.2 }
    });

    buildingNode = createSpatialNode('building_1920', 'assembly', {
      name: '1920s Manhattan Building',
      role: 'building',
      parameters: { floors: 4, floorHeight: 3.5, width: 20.0, depth: 15.0 },
      children: [facadeNode]
    });

    roadNode = createSpatialNode('road_madison', 'mesh', {
      name: 'Madison Avenue Road Corridor',
      role: 'road',
      parameters: { lanes: 4, width: 14.0 }
    });

    rootNode = createSpatialNode('city_root', 'group', {
      name: 'Manhattan City Block',
      children: [buildingNode, roadNode]
    });

    service.registerSceneGraph('test_scene', rootNode);
  });

  describe('Principle 1 & Rule 1: The Scene Graph is the Authority & Leased Scopes', () => {
    it('allows Façade Agent to acquire an exclusive lease on a building subtree', () => {
      const lease = service.acquireSpatialLease(
        'test_scene',
        'building_1920',
        'facade_agent',
        10000
      );

      expect(lease).toBeDefined();
      expect(lease.nodeId).toBe('building_1920');
      expect(lease.agentId).toBe('facade_agent');
      expect(lease.expiresAt).toBeGreaterThan(Date.now());
    });

    it('prevents Road Agent from mutating a building leased by Façade Agent', () => {
      service.acquireSpatialLease('test_scene', 'building_1920', 'facade_agent', 10000);

      const unauthorizedMutation: SpatialSceneGraphMutation = {
        transactionId: 'tx_road_01',
        agentId: 'road_agent',
        nodeId: 'building_1920',
        operation: 'set_parameters',
        expectedVersion: 1,
        payload: { floors: 6 }
      };

      expect(() => {
        service.applyMutation('test_scene', unauthorizedMutation);
      }).toThrow(/exclusive lease held by agent 'facade_agent'/);
    });

    it('allows Road Agent to concurrently mutate road nodes without stomping building', () => {
      service.acquireSpatialLease('test_scene', 'building_1920', 'facade_agent', 10000);

      const roadMutation: SpatialSceneGraphMutation = {
        transactionId: 'tx_road_02',
        agentId: 'road_agent',
        nodeId: 'road_madison',
        operation: 'set_parameters',
        expectedVersion: 1,
        payload: { lanes: 6 }
      };

      const result = service.applyMutation('test_scene', roadMutation);
      expect(result.success).toBe(true);
      expect(roadNode.parameters.lanes).toBe(6);
      expect(roadNode.version).toBe(2);
    });
  });

  describe('Principle 5 & 10: Non-Destructive Editing & Incremental DAG Regeneration', () => {
    it('applies modifiers non-destructively and updates node version and hash', () => {
      const initialHash = buildingNode.contentHash;
      expect(initialHash).toBeDefined();

      const mutation: SpatialSceneGraphMutation = {
        transactionId: 'tx_height_change',
        agentId: 'facade_agent',
        nodeId: 'building_1920',
        operation: 'set_parameters',
        expectedVersion: 1,
        payload: { floors: 6 }
      };

      const result = service.applyMutation('test_scene', mutation);
      expect(result.success).toBe(true);
      expect(buildingNode.parameters.floors).toBe(6);
      expect(buildingNode.version).toBe(2);
      expect(buildingNode.contentHash).not.toBe(initialHash);
      expect(buildingNode.isDirty).toBe(true);

      // DAG Dirty propagation: parent root is marked dirty, but sibling road is NOT dirty!
      expect(rootNode.isDirty).toBe(true);
      expect(roadNode.isDirty).toBe(false);
    });

    it('attaches a fire escape accessory to the front façade with surface mounting alignment', () => {
      const attachMutation: SpatialSceneGraphMutation = {
        transactionId: 'tx_fire_escape',
        agentId: 'facade_agent',
        nodeId: 'building_1920',
        operation: 'attach_to_mount',
        expectedVersion: 1,
        payload: {
          childId: 'fire_escape_01',
          childType: 'mesh',
          childName: 'Exterior Fire Escape',
          childRole: 'fire_escape',
          mountFace: 'front',
          offsetU: 3.5,
          offsetV: 0.0,
          standoff: 0.05
        }
      };

      const result = service.applyMutation('test_scene', attachMutation);
      expect(result.success).toBe(true);
      expect(buildingNode.children?.length).toBe(2);

      const fireEscape = buildingNode.children?.find(c => c.id === 'fire_escape_01');
      expect(fireEscape).toBeDefined();
      expect(fireEscape?.parent).toBe(buildingNode);
      expect(fireEscape?.localTransform).toBeDefined();
      expect(fireEscape?.localTransform?.[14]).toBeCloseTo(0.05, 2); // Z standoff
    });

    it('supports atomic rollback when a multi-step operation fails', () => {
      const initialFloors = buildingNode.parameters.floors;

      // Apply valid mutation
      service.applyMutation('test_scene', {
        transactionId: 'tx_batch_01',
        agentId: 'facade_agent',
        nodeId: 'building_1920',
        operation: 'set_parameters',
        expectedVersion: 1,
        payload: { floors: 10 }
      });

      expect(buildingNode.parameters.floors).toBe(10);

      // Rollback transaction
      const rolledBack = service.rollbackTransaction('test_scene', 'tx_batch_01');
      expect(rolledBack).toBe(true);

      // Node should revert to original state
      expect(buildingNode.parameters.floors).toBe(initialFloors);
      expect(buildingNode.version).toBe(1);
    });

    it('evaluates only dirty nodes during incremental re-generation', async () => {
      // Mark building dirty
      markNodeDirty(buildingNode);

      const evaluatedIds: string[] = [];
      const evaluated = await service.evaluateDirtySubtrees('test_scene', async (node) => {
        evaluatedIds.push(node.id);
      });

      expect(evaluated).toBeGreaterThanOrEqual(1);
      expect(evaluatedIds).toContain('building_1920');
      expect(evaluatedIds).not.toContain('road_madison');

      // After evaluation, dirty flags should be cleared
      expect(buildingNode.isDirty).toBe(false);
      expect(getDirtyNodes(rootNode).length).toBe(0);
    });
  });

  describe('Principle 11 & Rule 5: Explicit Uncertainty & Provenance', () => {
    it('tags inferred geometry with uncertainty scalar and provenance metadata', () => {
      const uncertaintyMutation: SpatialSceneGraphMutation = {
        transactionId: 'tx_uncertainty_tag',
        agentId: 'tile_reconstruction_agent',
        nodeId: 'facade_front',
        operation: 'tag_uncertainty',
        expectedVersion: 1,
        payload: {
          confidence: 0.35,
          isInferred: true,
          sourcePrompt: 'Inferred rear wall from Manhattan 1920s zoning typology'
        }
      };

      const result = service.applyMutation('test_scene', uncertaintyMutation);
      expect(result.success).toBe(true);
      expect(facadeNode.provenance?.confidence).toBe(0.35);
      expect(facadeNode.provenance?.isInferred).toBe(true);
      expect(facadeNode.provenance?.authorAgent).toBe('tile_reconstruction_agent');
    });

    it('encodes confidence values into GLB COLOR_0 vertex stream and asset extras', () => {
      const positions = new Float32Array([
        -1, -1, 0,
         1, -1, 0,
         1,  1, 0,
        -1,  1, 0
      ]);
      const confidences = new Float32Array([1.0, 1.0, 0.2, 0.2]); // 2 measured, 2 inferred vertices
      const indices = new Uint32Array([0, 1, 2, 0, 2, 3]);

      const foundation = new Universal3DStructureFoundation({
        id: 'test_building_provenance',
        name: 'Provenance Test Building',
        mesh: {
          positions,
          indices,
          vertexCount: 4,
          triangleCount: 2,
          confidences
        },
        metadata: {
          provenance: {
            ruleId: 'rule-5-uncertainty',
            sourcePrompt: 'Reconstruct Manhattan building',
            confidence: 0.6,
            isInferred: true
          }
        }
      });

      const glbBuffer = foundation.toGlbBuffer();
      expect(glbBuffer).toBeDefined();
      expect(glbBuffer.length).toBeGreaterThan(100);

      // Verify glTF JSON chunk in GLB contains COLOR_0 attribute and provenance extras
      const jsonLength = glbBuffer.readUInt32LE(12);
      const jsonStr = glbBuffer.toString('utf8', 20, 20 + jsonLength);
      const gltf = JSON.parse(jsonStr);

      expect(gltf.meshes[0].primitives[0].attributes.COLOR_0).toBeDefined();
      expect(gltf.asset.extras.scratchbox_provenance).toBeDefined();
      expect(gltf.asset.extras.scratchbox_provenance.confidence).toBe(0.6);
      expect(gltf.asset.extras.scratchbox_provenance.isInferred).toBe(true);
    });
  });
});
