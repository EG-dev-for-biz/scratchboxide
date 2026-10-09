/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * Mechanical Reality Grounding: Scene Graph Authority, Transactional Leases,
 * DAG Dirty Propagation, and Multi-Representation Provenance Verifier.
 ********************************************************************************/

import {
  createSpatialNode,
  computeNodeContentHash,
  markNodeDirty,
  getDirtyNodes,
  clearDirtyFlags,
  findSpatialNodeById,
  type UniversalSpatialNode
} from '../packages/core/src/common/spatial/universal-spatial-node';
import {
  SceneGraphMutationService,
  type SpatialSceneGraphMutation
} from '../packages/core/src/node/spatial/SceneGraphMutationService';
import { Universal3DStructureFoundation } from '../packages/core/src/node/spatial/Universal3DStructureFoundation';

const COLORS = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  dim: '\x1b[2m'
};

let totalChecks = 0;
let passedChecks = 0;
let failedChecks = 0;

function assertInvariant(name: string, condition: boolean, details: string = '') {
  totalChecks++;
  if (condition) {
    passedChecks++;
    console.log(`  ${COLORS.green}✔ [PASS]${COLORS.reset} ${name}`);
  } else {
    failedChecks++;
    console.log(`  ${COLORS.red}✖ [FAIL]${COLORS.reset} ${COLORS.bold}${name}${COLORS.reset}`);
    if (details) console.log(`     ${COLORS.yellow}Violation: ${details}${COLORS.reset}`);
  }
}

async function run() {
  console.log(`${COLORS.bold}${COLORS.cyan}🏛 [Procedural 3D Scene Graph Authority & Transaction Verifier]${COLORS.reset}`);
  console.log(`${COLORS.dim}Verifying Scene Graph Authority, Leased Scopes, DAG Dirty Evaluation, and Provenance...${COLORS.reset}\n`);

  const service = new SceneGraphMutationService();

  // 1. Hierarchy Setup
  const facadeNode = createSpatialNode('facade_front', 'mesh', {
    name: 'Front Façade',
    role: 'facade',
    parameters: { windowCount: 12, apertureWidth: 1.2 }
  });

  const buildingNode = createSpatialNode('building_1920', 'assembly', {
    name: '1920s Manhattan Building',
    role: 'building',
    parameters: { floors: 4, floorHeight: 3.5, width: 20.0, depth: 15.0 },
    children: [facadeNode]
  });

  const roadNode = createSpatialNode('road_madison', 'mesh', {
    name: 'Madison Avenue Road Corridor',
    role: 'road',
    parameters: { lanes: 4, width: 14.0 }
  });

  const rootNode = createSpatialNode('city_root', 'group', {
    name: 'Manhattan City Block',
    children: [buildingNode, roadNode]
  });

  service.registerSceneGraph('manhattan_block', rootNode);

  // ============================================================================
  // Principle 1 & Rule 1: The Scene Graph is the Authority & Spatial Leases
  // ============================================================================
  console.log(`${COLORS.bold}1. Persistent Scene Graph Authority & Spatial Leases${COLORS.reset}`);

  // Test 1.1: Façade Agent acquires exclusive lease on building
  const lease = service.acquireSpatialLease('manhattan_block', 'building_1920', 'facade_agent', 10000);
  assertInvariant(
    'Façade Agent acquires exclusive lease on building subtree',
    lease !== null && lease.nodeId === 'building_1920' && lease.agentId === 'facade_agent'
  );

  // Test 1.2: Road Agent cannot mutate leased building
  const roadStompResult = service.applyMutation('manhattan_block', {
    transactionId: 'tx_road_stomp',
    agentId: 'road_agent',
    nodeId: 'building_1920',
    operation: 'set_parameters',
    expectedVersion: 1,
    payload: { floors: 8 }
  });
  const roadStompBlocked = !roadStompResult.success && Boolean(roadStompResult.error?.includes("exclusive lease held by agent 'facade_agent'"));
  assertInvariant(
    'Road Agent is prevented from mutating building leased by Façade Agent',
    roadStompBlocked
  );

  // Test 1.3: Road Agent CAN concurrently mutate unleased road node
  const roadMutation = service.applyMutation('manhattan_block', {
    transactionId: 'tx_road_valid',
    agentId: 'road_agent',
    nodeId: 'road_madison',
    operation: 'set_parameters',
    expectedVersion: 1,
    payload: { lanes: 6 }
  });
  assertInvariant(
    'Road Agent concurrently mutates road corridor without conflict',
    roadMutation.success && roadNode.parameters.lanes === 6 && roadNode.version === 2
  );

  // ============================================================================
  // Principle 5 & 10: Non-Destructive Editing & DAG Dirty Propagation
  // ============================================================================
  console.log(`\n${COLORS.bold}2. Non-Destructive Parametric Editing & DAG Dirty Propagation${COLORS.reset}`);

  clearDirtyFlags(rootNode);
  const initialHash = buildingNode.contentHash;

  // Test 2.1: Mutate floors from 4 to 6
  const paramMutation = service.applyMutation('manhattan_block', {
    transactionId: 'tx_height_change',
    agentId: 'facade_agent',
    nodeId: 'building_1920',
    operation: 'set_parameters',
    expectedVersion: 1,
    payload: { floors: 6 }
  });

  assertInvariant(
    'Building floor count parametrically updated to 6',
    paramMutation.success && buildingNode.parameters.floors === 6 && buildingNode.version === 2
  );

  assertInvariant(
    'Content hash recalculation reflects parameter mutation',
    buildingNode.contentHash !== initialHash
  );

  assertInvariant(
    'DAG dirty propagation marks ancestors dirty while siblings remain untouched',
    buildingNode.isDirty === true && rootNode.isDirty === true && roadNode.isDirty === false
  );

  // Test 2.2: Attach fire escape accessory to front façade mount plane
  const attachMutation = service.applyMutation('manhattan_block', {
    transactionId: 'tx_fire_escape_mount',
    agentId: 'facade_agent',
    nodeId: 'building_1920',
    operation: 'attach_to_mount',
    expectedVersion: 2,
    payload: {
      childId: 'fire_escape_01',
      childType: 'mesh',
      childName: 'Exterior Fire Escape',
      childRole: 'fire_escape',
      mountFace: 'front',
      offsetU: 4.0,
      offsetV: 0.0,
      standoff: 0.05
    }
  });

  const fireEscape = buildingNode.children?.find(c => c.id === 'fire_escape_01');
  assertInvariant(
    'Fire escape attached to front façade with metric mount alignment',
    attachMutation.success && fireEscape !== undefined && Math.abs((fireEscape?.localTransform?.[14] ?? 0) - 0.05) < 1e-3
  );

  // Test 2.3: Atomic Rollback on Failure
  const preRollbackFloors = buildingNode.parameters.floors;
  service.applyMutation('manhattan_block', {
    transactionId: 'tx_failing_batch',
    agentId: 'facade_agent',
    nodeId: 'building_1920',
    operation: 'set_parameters',
    expectedVersion: 3,
    payload: { floors: 12 }
  });

  const rollbackOk = service.rollbackTransaction('manhattan_block', 'tx_failing_batch');
  assertInvariant(
    'Atomic rollback reverts scene graph to pre-commit snapshot',
    rollbackOk && buildingNode.parameters.floors === preRollbackFloors
  );

  // Test 2.4: Incremental DAG Dirty Evaluation
  let evaluatedCount = 0;
  const evaluatedIds: string[] = [];
  evaluatedCount = await service.evaluateDirtySubtrees('manhattan_block', async (node) => {
    evaluatedIds.push(node.id);
  });

  assertInvariant(
    'Incremental evaluator re-evaluates only dirty nodes and skips clean siblings',
    evaluatedIds.length >= 1 && evaluatedIds.includes('building_1920') && !evaluatedIds.includes('road_madison')
  );

  assertInvariant(
    'Dirty flags cleared post-evaluation',
    getDirtyNodes(rootNode).length === 0 && buildingNode.isDirty === false
  );

  // Release lease so reconstruction agent can tag uncertainty
  service.releaseSpatialLease('manhattan_block', lease.leaseId);

  // ============================================================================
  // Principle 11, 12 & Rule 5: Explicit Uncertainty & Provenance Invariants
  // ============================================================================
  console.log(`\n${COLORS.bold}3. Explicit Uncertainty & Provenance Multi-Representation${COLORS.reset}`);

  // Test 3.1: Uncertainty Tagging
  const uncertaintyMutation = service.applyMutation('manhattan_block', {
    transactionId: 'tx_rear_uncertainty',
    agentId: 'tile_reconstruction_agent',
    nodeId: 'facade_front',
    operation: 'tag_uncertainty',
    expectedVersion: 1,
    payload: {
      confidence: 0.45,
      isInferred: true,
      sourcePrompt: 'Inferred obscured rear wall geometry from Manhattan 1920s typology'
    }
  });

  const currentFacade = findSpatialNodeById(rootNode, 'facade_front');
  assertInvariant(
    'Uncertainty tagged with explicit confidence and provenance',
    uncertaintyMutation.success && currentFacade?.provenance?.confidence === 0.45 && currentFacade?.provenance?.isInferred === true
  );

  // Test 3.2: Universal3DStructureFoundation binary glTF 2.0 packing with COLOR_0 confidence
  const positions = new Float32Array([
    -1, -1, 0,
     1, -1, 0,
     1,  1, 0,
    -1,  1, 0
  ]);
  const confidences = new Float32Array([1.0, 1.0, 0.45, 0.45]);
  const indices = new Uint32Array([0, 1, 2, 0, 2, 3]);

  const foundation = new Universal3DStructureFoundation({
    id: 'bldg_provenance_test',
    name: '1920s Building Multi-Rep',
    mesh: {
      vertices: positions,
      indices,
      vertexCount: 4,
      triangleCount: 2,
      confidences
    },
    metadata: {
      provenance: {
        ruleId: 'rule-5-uncertainty',
        sourcePrompt: 'Make 1920s Manhattan building 6 stories tall',
        confidence: 0.75,
        isInferred: false
      }
    }
  });

  const glbBuffer = foundation.toGlbBuffer();
  const jsonLength = glbBuffer.readUInt32LE(12);
  const jsonStr = glbBuffer.toString('utf8', 20, 20 + jsonLength);
  const gltf = JSON.parse(jsonStr);

  assertInvariant(
    'GLB binary stream contains COLOR_0 attribute for uncertainty visualization',
    gltf.meshes[0].primitives[0].attributes.COLOR_0 !== undefined
  );

  assertInvariant(
    'GLB asset extras preserves machine-readable scratchbox provenance manifest',
    gltf.asset?.extras?.scratchbox_provenance?.confidence === 0.75 &&
    gltf.asset?.extras?.scratchbox_provenance?.ruleId === 'rule-5-uncertainty'
  );

  // Summary
  console.log(`\n${COLORS.bold}================================================================================${COLORS.reset}`);
  console.log(`${COLORS.bold}RESULTS: ${passedChecks}/${totalChecks} Invariants Passed, ${failedChecks} Failed.${COLORS.reset}`);
  if (failedChecks === 0) {
    console.log(`${COLORS.green}${COLORS.bold}ALL PROCEDURAL 3D SCENE GRAPH & PROVENANCE INVARIANTS SATISFIED!${COLORS.reset}\n`);
    process.exit(0);
  } else {
    console.log(`${COLORS.red}${COLORS.bold}VERIFICATION FAILED!${COLORS.reset}\n`);
    process.exit(1);
  }
}

run().catch((err) => {
  console.error('Fatal verification error:', err);
  process.exit(1);
});
