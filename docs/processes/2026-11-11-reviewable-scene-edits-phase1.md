# Process: Reviewable agent edits to an open 3D scene, phase 1, live in the app

> **Recorded:** 2026-11-11
> **Status:** Verified (phase 1); phases 2-5 to do
> **Tags:** `operate-scratchbox` `scene-edits` `agent-ux` `3d-viewport`
> **Target Domain:** Gemini agent chat / 3D viewport

---

## 1. Session Context

* **What prompted this session:** phase 1 of `docs/research/2026-11-11-reviewable-scene-edits-design.md`: an agent's edit
  to an open scene lands as a reviewable proposal applied as a delta onto the live scene (the user's own edits since
  the request stand), with a bar over the viewport.
* **Instance used:** web `3950`, API `3951`, tools `3952`, launch entry `scratchbox-reviewable-scene-edits` running the
  worktree `.claude/worktrees/review-scene-edits` (branch `feat/reviewable-scene-edits`, cut from `origin/main` d7a8d522).
* **Scope tested:** a scripted scene built by the agent (a table and a lamp), then camera edits through
  `scene_3d_dispatch_operators`; the bar's Keep, Undo all, Accept all and Reject all; a reload with a proposal waiting.

---

## 2. What Was Tested & What Worked (Verified)

Proof sheet: `docs/screenshots/reviewable-scene-edits_2026-11-11/proof-sheet.png` (gitignored), its five panels checked
by a separate vision pass against stated claims, all supported.

* **Applied edit** — "Move the camera to position 4, 3, 5 ... 45 degree field of view" → the viewport moved at once and
  the bar read "Agent changed 1 thing: Set camera" with Undo all / Keep; the artifact went to v8. Through the whole turn
  (two `sb_set_camera` calls, each scene sent twice) the stored proposal ended `applied`, no conflict.
* **Undo all** → the camera went back to (2, 1.8, 3) at 35 degrees, saved as v9 ("v9 of 9"), proposal gone from the
  session store.
* **Reject all** on a held proposal → camera back to (3, 2.5, 4) at 40 degrees, v5, proposal cleared and saved.
* **Accept all** on a held proposal whose change was already on the scene → nothing changed, version kept, cleared.
* **Reload** with a proposal waiting → the bar came back (proposals are saved with the session).
* **A clean turn end to end** ("Set the camera field of view to 50 degrees") → reply saved with its 8 tool calls, the
  edit applied (v10), no false conflict, no console errors from this change.
* **Tests:** `test/scene-proposals.test.ts` (10, the agent's scenes made by the real operator engine), and 58 test files
  importing the changed modules (482 passed, 1 file skipped by its own condition), on Node 22 with no credentials;
  `npm run typecheck` exit 0; eslint no errors; `lint:primitives` clean.

---

## 3. What Broke / Didn't Work

Found while verifying, all fixed before the runs above:

* **A bug on main: operator edits broke scenes with a large generated model.** `chatRequestBody` replaces a
  `glbBase64` over 1 MB with a note; `scene_3d_dispatch_operators` returned the note in the scene, and the viewport
  showed "Model build failed: The generated model (GLB) could not be read: Failed to execute 'atob' on 'Window'". The
  router now reads the note as the model unchanged (`isOmittedGlbNote`) and an edit never writes generator fields.
* **False "you also changed" on the agent's own change.** The backend sends each tool's scene twice
  (`artifact_start`, `artifact_complete`); the second arrived before the stage re-rendered, so the live scene read was
  the previous call's. Fixed by reading the scene the turn last showed when newer, and treating any value an earlier
  call of the turn left as the agent's (`agentLeft`).
* **Proposal decisions were not saved on their own:** the persistence effects did not watch `sceneProposals`.
* **An undone change could come back** when a later call of the same turn arrived: a decision now closes the turn's
  proposal and later calls are read from the agent's scene as it stood.
* **Not fixed (seen live, phase 5):** after Undo the agent set the camera position it remembered from the conversation
  (it reads the chat, not the scene): telling it what was undone is phase 5.
* **Unrelated:** two `409 Conflict` from `POST /workspace/project-artifacts/merge` at start-up, before the workspace root
  resolves; the same calls succeed right after.

---

## 4. Candidate Tool/Service Ideas

* **One artifact event per tool call** — the stream sends `artifact_start` and `artifact_complete` with the same scene;
  every consumer that reacts to artifacts does its work twice and races the render. One event, or a flag on the second,
  would remove a class of race.
* **Scene edits from the server as deltas** — `scene_3d_dispatch_operators` returns the whole scene, carrying back
  whatever the request stripped (the 1 MB note). Returning the delta it made (the operator engine already records it)
  would make edits smaller and never echo stripped fields.
* **A state reader for the review bar** — verifying needed `localStorage` reads through the page; a small read-only
  route or debug panel listing the open chat's proposals would make this checkable without poking storage.

---

## 5. Reproduction Steps

1. Start `scratchbox-reviewable-scene-edits` (or any build of the branch), open `http://127.0.0.1:3950/`, New Chat.
2. "Make a simple 3D scene in the studio: a wooden table with a red lamp standing on it." (stop the turn once the scene is
   up if its review rounds run long).
3. "Move the camera to position 4, 3, 5, aimed at the lamp, with a 45 degree field of view. Use
   scene_3d_dispatch_operators." → the bar with Undo all / Keep.
4. Undo all → the camera returns; Keep → the bar closes and the change stays.
