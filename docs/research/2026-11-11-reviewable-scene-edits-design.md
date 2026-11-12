# Reviewable scene edits: see what the agent changed, then keep it or not

Date: 2026-11-11. Status: phase 1 built (`services/scene-proposals.ts`; see "Phase 1 as built" at the end); phases 2-5
to do. Scope: agent edits to an open 3D scene (`Scene3DData`) in the generative canvas. Video timelines are a later
phase on the same model.

## 1. Why

Cursor's core loop is: the agent proposes a change to *your* work, you see the diff, you accept or reject each part,
and nothing lands that you did not see. Scratchbox's agent today replaces the open scene with a new version when its
tool call returns. The user can step back through versions (v1, v2, v3...) or undo, but cannot see what changed before
it changed, keep half of it, or tell the agent which half was wrong.

There is also a real data-loss bug behind this. `scene_3d_dispatch_operators` (`node/gemini/tools/canvas-tools.ts`)
runs the operators on the copy of the scene the browser sent with the request and returns a whole new scene. In the
browser, `mergeExternalSceneData` (`primitives/Scene3DPrimitive.tsx`) spreads that scene over the live one
(`{ ...prev, ...data }`). Anything the user moved, recoloured or sculpted while the agent was working is overwritten.

## 2. What already exists (most of the engine is built)

| Piece | Where | What it gives us |
|---|---|---|
| Scene delta | `services/viewport-history-deltas.ts`: `computeSceneDelta`, `applySceneDelta`, `mergeSceneDeltas` | A structural diff of two scenes: top-level fields `{before, after}` and id-keyed collections (`customMeshes`, `objects`, ...) as added / removed / changed items, applied or reverted in either direction. This is the diff format. |
| Agent edits already measured | `primitives/scene3d/viewportHistoryController.ts` `recordExternalChange` | Each agent tool call is already turned into one delta, with generated content (`stagedBuild`, `pythonGenerator`, `cppGenerator`) and staged-build layers left out, labelled from the operators it ran ("Agent: Set material, Translate"), and recorded as one undo step. |
| Undo / redo | `services/viewport-history.ts` `ViewportHistory`, `SceneEditEntry` | Accepted changes become ordinary undo steps for free. |
| Versions | `state/chatStore.ts` `artifactVersions` / `recordVersionInMap` | Full snapshots per artifact version: the base a proposal was made against can always be found. |
| Operator log | `operatorStack` / `actionLog` in the scene; `operatorResults` in the tool result | Human labels for each change ("Set material on Rotor Hub"). |
| Diff editor | `@monaco-editor/react` (a root dependency) | Side-by-side code diff for generator sources. |

What is missing: holding a change before it applies, a review surface, per-change accept, a viewport preview, a check
against the user's own edits made meanwhile, and telling the agent what was rejected.

## 3. The model

A **proposal** is what one agent tool call wants to do to an open scene:

```ts
interface SceneProposal {
    id: string;                    // one per tool call
    artifactId: string;
    baseVersion: number;           // the artifact version the request carried
    label: string;                 // from the operators run ("Set material, Translate x3")
    toolCallId: string;
    kind: 'edit' | 'regenerate' | 'build';
    delta: SceneDelta | null;      // kind 'edit': the structural change, base -> proposed
    regenerated?: {                // kind 'regenerate': a generator's source and model changed
        generator: 'pythonGenerator' | 'cppGenerator';
        sourceBefore?: string; sourceAfter: string;
        glbBefore?: string; glbAfter: string;   // durable URIs, not base64, so a proposal stays small
    };
    hunks: ProposalHunk[];         // the delta split into the units the user accepts or rejects
    status: 'pending' | 'applied' | 'rejected' | 'partial';
}

interface ProposalHunk {
    id: string;
    path: string;                  // 'camera' | 'environment' | 'customMeshes/rotor-hub' | ...
    change: 'add' | 'remove' | 'modify';
    label: string;                 // "Rotor Hub: material roughness 0.35 -> 0.2, moved +1.5 m Y"
    properties?: Array<{ key: string; before: unknown; after: unknown }>;  // display only, for a modified item
    decision: 'pending' | 'accepted' | 'rejected';
    conflict?: { yours: unknown }; // the user changed the same thing since baseVersion
}
```

One hunk is one top-level field or one collection item: the units `SceneDelta` already uses, so accepting a subset is
`applySceneDelta(live, deltaOf(acceptedHunks), 'apply')`. A modified item shows its changed properties (computed by a
shallow property diff for display), but is accepted or rejected whole; property-level acceptance is a later step if
users ask for it. Nothing here names a kind of object: hunks are paths into the scene contract (ADA §1.3-1.4).

Three kinds of change, three treatments:

| Kind | What it is | Review |
|---|---|---|
| **edit** | Operators changed fields or items (`scene_3d_dispatch_operators`, `sb_set_material_pbr`, camera, lights, transforms, scene graph) | Per-hunk accept/reject, with a viewport preview. |
| **regenerate** | A generator's source changed and produced a new model (`execute_3d_python_script`, a C++ generator, `build_3d_object_from_reference`) | A code diff of the generator source (Monaco) plus an A/B toggle in the viewport; keep or discard as one unit. This is Cursor's own case: the generator is code. |
| **build** | Progressive layers of a build the user asked for (staged locations: tiles, remesh, textures) | Not held. Layers stream in as today; the finished build gets one "Keep build / Discard" at the end, and discarding returns to the base version. |

A **new** scene (no artifact on stage with that id) has nothing to diff and opens as today.

## 4. Flow

1. **Request.** The browser sends the active artifact with its `version` (already in the request). The server echoes
   `baseVersion` in the tool result, and `scene_3d_dispatch_operators` also returns its `delta` (computed server-side
   with the same `computeSceneDelta`, which is pure TypeScript) and the operator list. The full artifact stays in the
   result for compatibility.
2. **Hold.** `applyStreamedArtifact` (`hooks/useCanvasOpeners.ts`) is the hold point. When the incoming artifact is a
   `3d-scene` already open, with the same id, and review is on, it builds a `SceneProposal` against the base version
   (from `artifactVersions`) and stores it, instead of replacing the scene. The live scene is untouched.
3. **Conflicts.** For each hunk, compare the live scene's value at `path` with the hunk's `before` (`deepEqual`). If
   they differ, the user changed it since the request: mark `conflict` and show both. A hunk with a conflict is never
   auto-accepted.
4. **Review.** A review bar over the viewport ("Agent proposes 4 changes · Accept all · Reject all · Review") and a
   panel listing hunks with check boxes, labels and before/after values. Keys: `Enter` accept all, `Esc` reject all,
   `J`/`K` move between hunks, `Space` toggles one.
5. **Preview.** While a proposal is pending the viewport draws the proposed scene on a copy
   (`applySceneDelta(live, delta, 'apply', true)`), with each touched object outlined (green added, amber modified, red
   ghost for removed, kept in the scene at low opacity), and `Tab` flips between before and after. Hovering a hunk
   frames its object. Nothing is written to scene data until accepted.
6. **Apply.** Accepted hunks are applied to the live scene as one `SceneEditEntry` (one undo step, labelled with the
   proposal), and a new artifact version is recorded. Rejected hunks are dropped.
7. **Tell the agent.** The next turn's context carries a short note: what was accepted, what was rejected, and any
   conflict the user resolved in their own favour ("Rejected: Rotor Hub material change. Kept the user's camera move").
   `Scene3DWorldLens.summarizeSceneStateForAgent` is the place: it already projects selection, playhead and recent
   actions into the prompt.

## 5. Settings

One setting, `Review agent changes to my scene`: **Always** / **Only when the agent removes or regenerates something**
(default) / **Never** (today's behaviour). With "only when", pure additions and modifications apply at once, and still
land as one undoable, labelled step; removals and regenerations wait for review. In any mode, a conflicting hunk always
waits.

## 6. Fixes that come with it

- **Lost updates.** Proposals are applied as deltas onto the live scene, not as a spread of the agent's whole copy, so
  edits the user made meanwhile survive (step 3). This fix is worth landing on its own in phase 1, even with review off.
- **Agent edits that may not reach the viewport.** `mergeExternalSceneData` returns the previous scene unless the
  generators, `objects`, the title or the staged build changed. An operator batch that only touches `customMeshes`,
  `camera` or `environment` looks like it would be dropped there. To check first (it may be applied elsewhere); applying
  through the delta removes the question either way.

## 7. Phases

| Phase | Work | Done when |
|---|---|---|
| 1 | Server returns `baseVersion` and `delta`; the hold point builds a proposal; apply by delta onto the live scene (lost-update fix); the review bar with Accept all / Reject all; proposals persist with the session so a reload keeps them | An agent edit made while the user moves an object keeps the user's move; a proposal can be rejected whole |
| 2 | Per-hunk accept/reject, conflict marking, property lists for modified items, keyboard | Accepting 2 of 4 hunks yields exactly the scene `applySceneDelta(base, deltaOf(those 2))` predicts |
| 3 | Viewport preview: proposed copy, outlines, before/after flip, hover to frame | Screenshots of add / modify / remove previews, judged with the visual-critic skill |
| 4 | Regenerations: Monaco source diff + A/B toggle + keep/discard; builds: keep/discard at the end | A rejected `execute_3d_python_script` regeneration leaves the previous model and source in place |
| 5 | Agent feedback note; the review setting; video timelines on the same model (tracks and elements are id-keyed collections already) | The agent's next turn quotes what was rejected and does not redo it |

## 8. Tests (none bill)

- Unit: proposal construction from recorded tool results; hunk splitting; partial apply equals the predicted scene;
  conflict detection when the live scene changed a hunk's path; rejected proposals leave the scene byte-identical.
- Live, through the app (operate-scratchbox): an object build, then an operator edit while dragging an object in the
  viewport, then partial accept; screenshots of each step on a labelled sheet.

## 9. Open questions for the user

1. Default mode: "only when removing or regenerating" (above), or "always" like Cursor's agent mode?
2. Property-level accept inside one object (accept the move, reject the recolour), now or only if asked?
3. Should a discarded build delete its cached stages, or keep them so "Keep build" can be undone later?

## 10. Phase 1 as built (2026-11-11)

Where it follows the plan and where it departs, with the reason:

- **Applied and held, not only held.** No viewport operator removes an object, so under the "only when removing"
  default nothing an operator does would ever wait, and the bar would never show. So an edit that needs no review is
  applied at once and still shown, with **Keep / Undo all** (Cursor's model: the change is on screen, Undo takes it
  back); an edit that needs review (a removal, or anything the user also changed) waits with **Accept all / Reject
  all**. Undo and Reject take back only what the agent put there and the user has not changed since.
- **The diff is computed in the browser, not returned by the server.** The browser holds the scene the request carried
  (the base) and the agent's scene, so `computeSceneDelta(base, agent)` gives the same delta without a server change.
  The server already starts each tool call from the previous call's scene, so one proposal per turn and scene, from the
  request's base to the latest agent scene, is the turn's whole change.
- **Hold point:** the stream's artifact branch in `useSendMessage.ts` (not `applyStreamedArtifact`, which the node
  graph uses for the user's own edits), routed again at commit against the live scene then, so edits made while the
  reply streams stand.
- **Found and fixed while verifying live:**
  - A tool call's scene is sent twice (`artifact_start`, `artifact_complete`) and the second can arrive before the
    stage re-renders: the router reads the scene the turn last put on the stage when it is newer, and a hunk holding any
    value an earlier call of the turn left (`agentLeft`) is the agent's, not the user's.
  - A decision made while the turn still runs closes its proposal: later calls are read from the agent's scene as it
    stood, so an undone change is not put back.
  - **A bug on main:** `chatRequestBody` replaces a generated model over 1 MB with a note; `scene_3d_dispatch_operators`
    handed that note back, and the viewport failed to decode it ("Model build failed ... atob"). The router treats the
    note as the model unchanged (`isOmittedGlbNote`), and an edit never writes generator fields.
  - `mergeExternalSceneData` took in an agent scene only when generators, `objects`, the title or the staged build
    changed; it now takes in any top-level field whose value changed.
  - Proposals were not saved on their own (the persistence effects did not watch them); now they are.
- **Not yet:** field-level removal reaching the viewport (a removed top-level field stays there until reload, since the
  merge spreads over the previous scene), the review setting (the policy is the module default), per-hunk accept,
  the viewport preview, regeneration diffs, and telling the agent what was undone. The last one showed live: after an
  Undo the agent, reading the conversation and not the scene, set the camera position it remembered.
