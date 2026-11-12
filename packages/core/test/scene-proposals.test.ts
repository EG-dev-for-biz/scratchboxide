/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Reviewable agent edits (services/scene-proposals.ts, phase 1 of docs/research/2026-11-11-reviewable-scene-edits-design.md).
 * The agent's scenes are made the way `scene_3d_dispatch_operators` makes them: the real operator engine run on the copy
 * of the scene the request carried. The user's edits meanwhile are made on the live scene, as the viewport makes them.
 */

import { describe, expect, it } from 'vitest';
import type { CanvasArtifact, Scene3DData } from '../src/browser/generative-canvas/canvas-types';
import { DirectDispatchOperatorEngine } from '../src/browser/generative-canvas/services/direct-dispatch-operator-engine';
import type { BatchCommand } from '../src/browser/generative-canvas/services/direct-dispatch-operator-engine';
import {
    applySceneProposal,
    proposalNeedsReview,
    revertSceneProposal,
    routeAgentSceneArtifact,
    sceneUpdateKind
} from '../src/browser/generative-canvas/services/scene-proposals';
import { mergeExternalSceneData } from '../src/browser/generative-canvas/primitives/Scene3DPrimitive';
import { chatRequestBody, isOmittedGlbNote } from '../src/browser/generative-canvas/gemini-client';

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));

function baseScene(): Scene3DData {
    return {
        title: 'Rotor rig',
        renderMode: 'pbr',
        environment: { skybox: 'studio', lighting: 'studio' },
        camera: { position: [5, 5, 10], target: [0, 1, 0], fov: 45 },
        customMeshes: [
            { id: 'hub', name: 'Rotor Hub', type: 'custom', position: [0, 1.5, 0], rotation: [0, 0, 0], scale: [1, 1, 1], material: { color: '#88929a', roughness: 0.35, metalness: 0.85 } },
            { id: 'mast', name: 'Mast', type: 'custom', position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], material: { color: '#d8d2c5', roughness: 0.75, metalness: 0.05 } }
        ],
        objects: []
    } as Scene3DData;
}

const artifact = (data: Scene3DData, version: number): CanvasArtifact => ({
    id: 'scene-rig', type: '3d-scene', title: 'Rotor rig', summary: '', createdAt: 'now', version, data
});

/** The agent's scene: the operators run on a copy of `from`, as the server does. */
function agentEdit(from: CanvasArtifact, commands: BatchCommand[]): CanvasArtifact {
    const engine = new DirectDispatchOperatorEngine(clone(from.data as Scene3DData));
    const result = engine.executeBatch(commands, { atomic: true });
    expect(result.success).toBe(true);
    return { ...from, data: engine.getSceneData(), version: (from.version ?? 1) + 1 };
}

const mesh = (data: Scene3DData, id: string) => (data.customMeshes ?? []).find(m => m.id === id)!;
const withMesh = (data: Scene3DData, id: string, change: (m: any) => any): Scene3DData =>
    ({ ...data, customMeshes: (data.customMeshes ?? []).map(m => (m.id === id ? change(clone(m)) : m)) });

describe('reviewable agent edits to an open scene', () => {
    it('applies the agent edit as a delta, so a move the user made meanwhile survives', () => {
        const base = artifact(baseScene(), 3);
        const agent = agentEdit(base, [
            { operator: 'sb_set_material_pbr', params: { objectId: 'hub', roughness: 0.2 } },
            { operator: 'sb_set_camera', params: { position: [8, 6, 12] } }
        ]);
        // while the agent worked the user dragged the mast up 2 m
        const live = artifact(withMesh(base.data as Scene3DData, 'mast', m => ({ ...m, position: [0, 2, 0] })), 3);

        const routed = routeAgentSceneArtifact({ incoming: agent, base, live, proposalId: 'p1', now: 1 });
        const shown = routed.show.data as Scene3DData;
        expect(mesh(shown, 'hub').material?.roughness).toBe(0.2);
        expect(shown.camera?.position).toEqual([8, 6, 12]);
        expect(mesh(shown, 'mast').position).toEqual([0, 2, 0]);
        // the whole agent scene would have put the mast back at 0
        expect(mesh(agent.data as Scene3DData, 'mast').position).toEqual([0, 0, 0]);

        expect(routed.proposal?.status).toBe('applied');
        expect(routed.proposal?.hunks.map(h => h.id).sort()).toEqual(['camera', 'customMeshes/hub']);
        expect(routed.proposal?.hunks.find(h => h.id === 'customMeshes/hub')?.label).toBe('Rotor Hub: material');
        expect(routed.proposal?.label).toBe('Set material pbr, Set camera');
        expect(routed.show.version).toBe(4);
        // the operators carried once (an atomic batch logs to the action log), so the viewport records the change as one labelled undo step
        expect((shown.actionLog ?? []).map(o => o.operator)).toEqual(['sb_set_material_pbr', 'sb_set_camera']);
    });

    it('holds an edit to something the user also changed, and keeps the user\'s value when accepted', () => {
        const base = artifact(baseScene(), 3);
        const agent = agentEdit(base, [
            { operator: 'sb_set_material_pbr', params: { objectId: 'hub', roughness: 0.2 } },
            { operator: 'sb_set_camera', params: { fov: 30 } }
        ]);
        const live = artifact(withMesh(base.data as Scene3DData, 'hub', m => ({ ...m, material: { ...m.material, color: '#ff0000' } })), 3);

        const routed = routeAgentSceneArtifact({ incoming: agent, base, live, proposalId: 'p2' });
        expect(routed.proposal?.status).toBe('pending');
        expect(routed.show).toBe(live);
        expect(routed.proposal?.hunks.find(h => h.id === 'customMeshes/hub')?.conflict).toBe(true);
        expect(routed.proposal?.hunks.find(h => h.id === 'camera')?.conflict).toBeUndefined();

        const accepted = applySceneProposal(live.data as Scene3DData, routed.proposal!);
        expect(accepted.applied).toEqual(['camera']);
        expect(accepted.keptYours).toEqual(['customMeshes/hub']);
        expect(mesh(accepted.data, 'hub').material).toEqual({ color: '#ff0000', roughness: 0.35, metalness: 0.85 });
        expect(accepted.data.camera?.fov).toBe(30);
    });

    it('holds a removal under the default policy, applies it under "never", and Reject leaves the scene as it was', () => {
        const base = artifact(baseScene(), 3);
        const removed = clone(base.data as Scene3DData);
        removed.customMeshes = removed.customMeshes!.filter(m => m.id !== 'mast');
        const agent = { ...base, version: 4, data: removed };

        const held = routeAgentSceneArtifact({ incoming: agent, base, live: base, proposalId: 'p3' });
        expect(held.proposal?.status).toBe('pending');
        expect(held.proposal?.hunks).toEqual([{ id: 'customMeshes/mast', key: 'customMeshes', itemId: 'mast', change: 'remove', label: 'Removed Mast' }]);
        expect(held.show).toBe(base);
        expect(proposalNeedsReview(held.proposal!, 'never')).toBe(false);

        const unreviewed = routeAgentSceneArtifact({ incoming: agent, base, live: base, proposalId: 'p3', policy: 'never' });
        expect((unreviewed.show.data as Scene3DData).customMeshes!.map(m => m.id)).toEqual(['hub']);

        // rejecting a held proposal reverts nothing it never applied
        expect(revertSceneProposal(base.data as Scene3DData, held.proposal!).data).toBe(base.data);
    });

    it('undoes an applied edit, except where the user has changed it since', () => {
        const base = artifact(baseScene(), 3);
        const agent = agentEdit(base, [
            { operator: 'sb_set_material_pbr', params: { objectId: 'hub', roughness: 0.2 } },
            { operator: 'sb_set_camera', params: { fov: 30 } }
        ]);
        const routed = routeAgentSceneArtifact({ incoming: agent, base, live: base, proposalId: 'p4' });
        const after = routed.show.data as Scene3DData;
        // then the user nudged the camera themselves
        const live = { ...after, camera: { ...after.camera!, fov: 50 } };

        const undone = revertSceneProposal(live, routed.proposal!);
        expect(undone.applied).toEqual(['customMeshes/hub']);
        expect(undone.keptYours).toEqual(['camera']);
        expect(mesh(undone.data, 'hub').material?.roughness).toBe(0.35);
        expect(undone.data.camera?.fov).toBe(50);
    });

    it('collects a turn\'s chained tool calls into one proposal whose Undo takes back both', () => {
        const base = artifact(baseScene(), 3);
        const call1 = agentEdit(base, [{ operator: 'sb_set_material_pbr', params: { objectId: 'hub', roughness: 0.2 } }]);
        const first = routeAgentSceneArtifact({ incoming: call1, base, live: base, proposalId: 'turn' });
        // the server starts the next call from the previous call's scene
        const call2 = agentEdit(call1, [{ operator: 'sb_translate', params: { objectId: 'mast', delta: [1, 0, 0] } }]);
        const second = routeAgentSceneArtifact({ incoming: call2, base, live: first.show, proposalId: 'turn', previous: first.proposal });

        expect(second.proposal?.applied?.sort()).toEqual(['customMeshes/hub', 'customMeshes/mast']);
        const shown = second.show.data as Scene3DData;
        expect(mesh(shown, 'mast').position).toEqual([1, 0, 0]);
        expect((shown.actionLog ?? []).map(o => o.operator)).toEqual(['sb_set_material_pbr', 'sb_translate']);

        const undone = revertSceneProposal(shown, second.proposal!);
        expect(mesh(undone.data, 'hub').material?.roughness).toBe(0.35);
        expect(mesh(undone.data, 'mast').position).toEqual([0, 0, 0]);

        // routed again at commit with nothing new: the stage stays as it is, no new version
        const commit = routeAgentSceneArtifact({ incoming: call2, base, live: second.show, proposalId: 'turn', previous: second.proposal });
        expect(commit.show).toBe(second.show);
        expect(commit.proposal?.applied?.sort()).toEqual(['customMeshes/hub', 'customMeshes/mast']);
    });

    it('does not take the turn\'s own earlier change for the user\'s when a later call changes the same thing again', () => {
        // seen live: the agent set the camera, then aimed it again in a second call
        const base = artifact(baseScene(), 1);
        const call1 = agentEdit(base, [{ operator: 'sb_set_camera', params: { position: [3, 2.5, 4], fov: 40 } }]);
        const first = routeAgentSceneArtifact({ incoming: call1, base, live: base, proposalId: 'turn' });
        const call2 = agentEdit(call1, [{ operator: 'sb_set_camera', params: { target: [0.24, 1.07, -0.06] } }]);
        const second = routeAgentSceneArtifact({ incoming: call2, base, live: first.show, proposalId: 'turn', previous: first.proposal });

        expect(second.proposal?.status).toBe('applied');
        expect(second.proposal?.hunks.find(h => h.id === 'camera')?.conflict).toBeUndefined();
        expect((second.show.data as Scene3DData).camera).toEqual({ position: [3, 2.5, 4], target: [0.24, 1.07, -0.06], fov: 40 });

        // seen live: the backend sends the same scene again (artifact_complete) before the stage shows the first copy
        const again = routeAgentSceneArtifact({ incoming: call2, base, live: first.show, proposalId: 'turn', previous: second.proposal });
        expect(again.proposal?.status).toBe('applied');
        expect(again.proposal?.hunks.find(h => h.id === 'camera')?.conflict).toBeUndefined();

        // a third call held for another reason still takes the camera back on Reject
        const held = { ...second.proposal!, status: 'pending' as const };
        const undone = revertSceneProposal(second.show.data as Scene3DData, held);
        expect(undone.data.camera).toEqual((base.data as Scene3DData).camera);
    });

    it('after the user undoes mid-turn, a later call is read from the agent\'s scene as it stood, so the undone change stays undone', () => {
        const base = artifact(baseScene(), 1);
        const call1 = agentEdit(base, [{ operator: 'sb_set_camera', params: { fov: 30 } }]);
        const first = routeAgentSceneArtifact({ incoming: call1, base, live: base, proposalId: 'turn' });
        // the user presses Undo all while the turn runs
        const undone = { ...first.show, version: (first.show.version ?? 1) + 1, data: revertSceneProposal(first.show.data as Scene3DData, first.proposal!).data };
        expect((undone.data as Scene3DData).camera?.fov).toBe(45);
        // the next call carries the agent's whole scene, the undone camera included; read from call1's scene, only its own change is new
        const call2 = agentEdit(call1, [{ operator: 'sb_translate', params: { objectId: 'mast', delta: [0, 1, 0] } }]);
        const later = routeAgentSceneArtifact({ incoming: call2, base: call1, live: undone, proposalId: 'turn-1' });
        expect(later.proposal?.hunks.map(h => h.id)).toEqual(['customMeshes/mast']);
        expect((later.show.data as Scene3DData).camera?.fov).toBe(45);
        expect(mesh(later.show.data as Scene3DData, 'mast').position).toEqual([0, 1, 0]);
        // and at commit with nothing new, the stage stays as the user left it
        expect(routeAgentSceneArtifact({ incoming: call1, base: call1, live: undone, proposalId: 'turn-1' }).show).toBe(undone);
    });

    it('passes through a new scene, a regenerated model and a build\'s progress unchanged', () => {
        const base = artifact(baseScene(), 3);
        const other = { ...artifact(baseScene(), 1), id: 'scene-other' };
        expect(routeAgentSceneArtifact({ incoming: other, base, live: base, proposalId: 'x' })).toEqual({ show: other });

        const regenerated = { ...base, data: { ...(base.data as Scene3DData), pythonGenerator: { sourceCode: 'import scratchbox as sb' } } as Scene3DData };
        expect(sceneUpdateKind(base.data as Scene3DData, regenerated.data as Scene3DData)).toBe('regenerate');
        expect(routeAgentSceneArtifact({ incoming: regenerated, base, live: base, proposalId: 'x' }).show).toBe(regenerated);

        const building = { ...base, data: { ...(base.data as Scene3DData), stagedBuild: { schema: 'scratchbox.staged-build/2', runId: 'r1', stages: [], layers: [] } } as unknown as Scene3DData };
        expect(sceneUpdateKind(base.data as Scene3DData, building.data as Scene3DData)).toBe('build');
        expect(routeAgentSceneArtifact({ incoming: building, base, live: base, proposalId: 'x' }).show).toBe(building);
    });

    it('keeps a generated model the request left out, instead of writing the request\'s note into the scene', () => {
        // a generated scene whose model is over the chat request's 1 MB cut: the request carries a note in its place
        const model = 'Z2xURg'.repeat(200_000);
        const scene = { ...baseScene(), pythonGenerator: { sourceCode: 'import scratchbox as sb', glbBase64: model, glbPath: '/tmp/scene.glb' } } as Scene3DData;
        const base = artifact(scene, 1);
        const sent = artifact(JSON.parse(chatRequestBody(scene)) as Scene3DData, 1);
        expect(isOmittedGlbNote(sent.data && (sent.data as Scene3DData).pythonGenerator?.glbBase64)).toBe(true);
        const agent = agentEdit(sent, [{ operator: 'sb_set_camera', params: { fov: 30 } }]);

        expect(sceneUpdateKind(base.data as Scene3DData, agent.data as Scene3DData)).toBe('edit');
        const routed = routeAgentSceneArtifact({ incoming: agent, base, live: base, proposalId: 'big' });
        const shown = routed.show.data as Scene3DData;
        expect(shown.camera?.fov).toBe(30);
        expect(shown.pythonGenerator?.glbBase64).toBe(model);
        expect(routed.proposal?.hunks.map(h => h.id)).toEqual(['camera']);
    });
});

describe('the viewport takes in an applied edit', () => {
    it('takes in a change to the camera alone, and returns the same scene for its own round trip', () => {
        const prev = baseScene();
        const next = mergeExternalSceneData(prev, { ...prev, camera: { position: [8, 6, 12], target: [0, 1, 0], fov: 45 } });
        expect(next).not.toBe(prev);
        expect(next.camera?.position).toEqual([8, 6, 12]);

        expect(mergeExternalSceneData(prev, { ...prev })).toBe(prev);
        expect(mergeExternalSceneData(prev, clone(prev))).toBe(prev);
    });
});
