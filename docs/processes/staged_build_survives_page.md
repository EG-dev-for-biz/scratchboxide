# A staged build survives the page: run registry, re-attach, Resume

**Date:** 2026-10-21
**Status:** Verified (live in the user's app: a reload at +50 s of an isolated-structure run; the page re-attached, the server finished the run at +103 s and the page took the textured result)

## Why

On 2026-10-20 a code update hot-reloaded the user's app while a Paris district build ran; the chat stream dropped, the
server aborted the run and every stage went "stopped". A build must not depend on the page that started it, and a run
that stopped should be resumable without re-asking for everything.

## What exists now

- **The run has its own stop.** `runStagedLocationTool` (`staged-location-tool.ts`) gives the run an `AbortController`
  of its own. The chat's signal is forwarded to it only when its reason is not a client disconnect: `geminiRoutes.ts`
  names a dropped SSE connection (`clientDisconnectedError`, name `ClientDisconnected`) and the chat's tool wrapper
  (`streaming.ts`) carries the reason through. The user's Stop and the tool's deadlines still stop the run.
- **The run registry** (`staged-run-registry.ts`, process-wide) keeps every stage event and the latest scene artifact
  a run emitted, for 30 minutes after it ends. The chat stream, while connected, is one listener among others.
- **Re-attach.** `GET /gemini/staged-runs/:runId?after=seq` returns the events after `seq`, the latest artifact when a
  newer one exists, and the status; 404 when this server has no such run (it restarted). `useStagedBuild` follows any
  scene whose staged build is `running` or `interrupted` (`stagedRunClient.ts`: one shared poll per run per page,
  every 2 s), publishes the events to the overlay, applies newer artifacts to the scene, and stamps the run live again.
  `POST /gemini/staged-runs/:runId/stop` is the Stop for a run whose chat stream is gone.
- **Resume.** The overlay offers "Resume build" on a run that stopped, failed or was interrupted. It asks the chat to
  call `google_3d_tiles_get_clay` with the new `resumeRunId` argument: the recorded request is rebuilt from the run
  record, cached stages are reused, nothing is bypassed (`ctx.resume` in `orchestrator.ts`).

## Evidence (the user's app, 2026-10-21)

- Resume: the stopped Paris run (`eedfadd9`) resumed as `32b0ab27`; tiles, remesh and grammar came from cache and the
  trees were grown in 3.7 s.
- Survival: an isolated National Gallery build (`b85ca72a`) was reloaded at about +50 s (remesh committed, texture pass
  starting). After the reload the overlay showed "Real textures — running", the page polled
  `/gemini/staged-runs/b85ca72a?after=28`, and at +103 s the server's finish reached the page: "Finished: Google 3D
  Tiles, Remeshed scan, Trees, Real textures in the scene".
- Tests: `staged-run-registry.test.ts` (registry, follower, shared follower), `staged-location-tool.test.ts`
  (`resumeRunId` parsing), `staged-build-overlay.test.ts` (Resume button), the staged, server-route and tool suites.

## What the live run also showed

- A district build (not an isolated structure) ends in clay: "Real textures (the texture pass runs on an isolated
  structure)". The textured by default policy is not met for districts by the pipeline itself; the photogrammetric
  textured extraction (`…_r250_textured.glb`) is on disk and could stand as the district layers' textured twin.
- The first re-attach polled many times a second: several effect runs each started a follower. Fixed the same day
  with one shared follower per run per page.
