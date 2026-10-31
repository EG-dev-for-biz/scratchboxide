# Preregistration (draft): today's two build modes, judged as whole places at the benchmark places

Date: 2026-10-31. Status: **draft, not approved, nothing run.** No paid judge call and no live build happen until the user
approves this document. The method is `.claude/skills/judge-preregister/SKILL.md`; the judge is described in
`docs/processes/photo_match_world_regions.md`.

## Question

This comparison settles two things.

1. **The M1 exit.** Are today's two modes scored at every benchmark place, repeatably within the judge's spread, and does
   the judge rank known-bad builds clearly lower on the regions they break?
   - If yes, the judge's region scores and metrics become the measure for M2 to M8.
   - If no, the judge or its views are fixed before any milestone is judged by them.
2. **M2's neighbours.** On the neighbours region, do the district's neighbours as massing score differently from the
   cleaned scan?
   - If one is clearly higher, it becomes M2's neighbours.
   - If the judge cannot tell, massing stays (today's default) and M2 decides on cost.

## Arms

All arms at a place are built fresh and uncached from the same query text: clear the stage caches, then restart the server.
The arms must resolve to one geocoded point (one frame). The district switch is read from the server's environment, so set
it and restart before each district build.

| Id | Label | Build | Scope |
|---|---|---|---|
| DM | District, massing neighbours | `isolate: false` (radius 250 m), trees on, `SCRATCHBOX_STAGED_DISTRICT` unset (massing, today's default) | place (named first: the reference) |
| DS | District, cleaned-scan neighbours | as DM, `SCRATCHBOX_STAGED_DISTRICT=scan` | place |
| K | Pipeline K, one building | `isolate: true`, `pipeline: 'k'`, everything else default | target |
| raw | The raw scan cut to the target | `baseline` (on) | target |

- DM is named first because the first run is the reference. Its tile has the widest extraction, it gives the masks and the
  views, and its vector stage gives the target's footprint.
- K is drawn in DM's tile with the picked target cut out.
- Each run arm passes `glbs`: the run's visible layers as `visibleStagedLayers` selects them (textured twins where they
  exist, the trees layer included). Only one run can be the open scene.
- **Open decision.** The plan's M0 names the second mode as "a non-isolate build with the procedural district on"
  (`SCRATCHBOX_STAGED_DISTRICT=rebuilt`). Adding it as arm DR answers that too, but puts one more render in every judge
  call. Proposal: leave DR out of the first run, and add it in a second preregistration if M0 shows the rebuilt district is
  a candidate.

Tool arguments, the same at every place:

```
photo_match_evaluate {
  arms: [DM, DS, K, X1, X2 as above, each { id, label, runId, glbs, scope }],
  views: 4, runs: 3, clay: true, judgeRegions: true, trees: true, baseline: true, includeSatelliteOrtho: false
}
```

## Places and views

The six places proposed in the plan's M1 table. The query text is fixed here and used for every arm at the place.

| Place | Query | Note |
|---|---|---|
| Empire State Building | `Empire State Building, New York` | dense, tall |
| Haughwout Building | `Haughwout Building, 488 Broadway, New York` | low-rise street |
| Bryant Park | `Bryant Park, New York` | **blocked**: no structure at the place (see below) |
| Ferry Building | `Ferry Building, San Francisco` | waterfront, plaza |
| Dolores Park | `Dolores Park, San Francisco` | **blocked**: no structure at the place |
| Griffith Observatory | `Griffith Observatory, Los Angeles` | hillside, horizon |

- **Views.** Four per place, held out and registered, chosen by the tool: Google-captured panos no arm's build used,
  aimed at the target, kept when the target fills at least 6% of the frame and at least 30% of it is unhidden. Registered
  by edges to at most 5 px; the nearest four that lock.
- **Blocked places.** At a park the structure rule finds nothing within 30 m of the place, and views fall back to the
  district as a whole, so none qualifies. **Decision for the user:** either build the view rule for a place with no
  structure first (the follow-up in the process note), or query a building on the park's edge. That would change what
  the place tests.

## Bars

Fixed before any paid call. "Spread" means the judge's run spread (`runSd`) as the tool reports it.

| # | Metric | Mask | Bar | Direction | A miss means |
|---|---|---|---|---|---|
| 1 | Judge run spread, every arm | building (overall) | mean runSd at most 0.75 | lower | the judge is not repeatable here; M1 exit fails at that place |
| 2 | Judge run spread, every arm | ground, neighbours, skyline (`regionScores`) | mean runSd at most 1.0 each | lower | the region criteria are not repeatable; the region scores cannot decide anything |
| 3 | Decoy X1 against K | ground, neighbours | judge score at least 2.0 lower than K's, at every judged place | lower for X1 | the judge does not see a missing street or missing neighbours; stop |
| 4 | Decoy X1 against K | ground, neighbours (`agreement`) | at most 0.3 | lower for X1 | the masks or the arm scopes are wrong; stop |
| 5 | Decoy X2 against K | building (overall and shape) | at least 1.0 lower than K's at all but one judged place | lower for X2 | registration does not cost points; the building scores cannot rank small misfits |
| 6 | DM against DS | neighbours (judge) | the gap is wider than both arms' spread, with the same sign at 3 or more of the 4 judged places | either | the judge cannot tell; massing stays |
| 7 | raw | frame (`agreement`) | exactly 1.00 at every view | equal | the reference or the cut is broken; stop |
| 8 | The target | `regions.target` | `footprintSource` is `vector-footprint` at the reference | - | the building mask is unreliable at that place; it stays out of the building bars |

Secondary, reported and deciding nothing: SSIM, edge chamfer, CIEDE2000 and agreement per region, for every arm.

## Decoys

Both are made locally from the arms' own files, at no cost, and judged blind in the same calls as the arms.

- **X1: the hero with no place round it.** K's GLBs with `scope: 'place'`, drawn alone, with no street and no neighbours.
  It must lose on ground and neighbours (bars 3 and 4). Its building can stay close to K's.
- **X2: the hero moved.** K's GLBs with the root node translated 4 m along +x (one node translation in the glTF JSON),
  `scope: 'target'`. It must lose on the building (bar 5).

## Stop rules

- **Spend cap.** Judge calls are views × runs × 2 (textured and clay) = 24 per place, 96 for the four unblocked places.
  Street View grounding fetches at most 8 images per place. Anything past that stops the run.
- **A decoy that passes.** Bars 3 to 5 missed at a place: stop, and fix the judge or the views, not the builds.
- **Spread wider than the gap.** Bar 6 missed: report "the judge cannot tell", not a winner.
- **The dry run, at every place, before any paid call.** Stop at a place if any of these shows:
  - an empty or black render, or an arm with 0 triangles;
  - `frame_mismatch`;
  - `liftedM` over 1 m;
  - `regions.target.matchedShare` under 0.99, where an isolate is the target (an isolate from another extraction than
    the reference);
  - no `vector-footprint` target at the district reference.
- **Too few views.** A place with fewer than 3 judged views is reported as indicative only, and kept out of bars 3, 5 and 6.

## Exposure

- **Panos any arm's build used** are excluded by the tool. It reads the runs' notes, stage entries, scene and GLB extras,
  and since this branch also views named after a pano (`<panoId>_h<deg>_p<deg>`). On the ESB K run 7f594cd6, the 16 panos
  its Street View score used are now excluded.
- **Panos earlier comparisons judged.** The ESB and the Haughwout Building were judged in earlier work
  (`staged_location_photo_match_bakeoff.md`, `facade_materials_merge_eval.md`, `streetview_value.md` and others). Their
  `report.json` files went with the cache clears, so the pano lists survive only where those docs recorded them.
  - They are not excluded: the judge does not learn from them.
  - **Decision for the user:** add the recorded ones to `excludePanoIds` if a fully unseen set is wanted.
- **The stand-in dry run** on run 7f594cd6 (2026-10-31) judged nothing real.

## Step 2: the free dry run (before approval of the spend)

When the fresh builds exist at a place, write a config and run the driver. Config:

```
{ "root": "<staged workspace root>", "tile": "<DM's textured tile: the welded one when the run welded it>",
  "out": "docs/screenshots/m1_prereg/<place>", "args": { ...the tool arguments above... } }
```

Run it with credentials unreachable:

```bash
env -i PATH="$PATH" HOME="$(mktemp -d)" PHOTO_MATCH_DRYRUN=<config.json> ./node_modules/.bin/vitest run packages/core/test/photo-match-dryrun.test.ts
```

It must show:

- every arm and decoy rendering at every held-out pose;
- the excluded panos;
- the call count, 24 per place;
- the mask grids looked at with the `screenshot-review` skill.

## Cost

- **Builds.** Three fresh builds per place (DM, DS, K), uncached, one after another. That is 12 for the four unblocked
  places, 18 with the parks. The Mac is heavily loaded, so they run one place at a time.
- **Judge.** 96 calls on the default judge (`gemini-4-argon`), each with the photo and 6 renders (raw, DM, DS, K, X1, X2)
  and a 24,576-token thinking budget. **The price per call is to be filled in before approval.**
- **Street View grounding.** Up to 32 images.
- **Decoys and dry runs.** Free.

## Report

After the single paid run, fill one row per bar with each arm's value and spread, each decoy's value, and met or missed.
Then give the two decisions named in the question, and attach the grids and mask grids.
