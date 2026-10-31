# Preregistration (draft): today's build modes judged as whole places, K at the benchmark places and the district at Penn 2

Date: 2026-10-31. Status: **draft, not approved, nothing run.** No paid judge call and no live build happen until the user
approves this document. Three things block the run as written:
- **The Penn 2 comparison waits for kd's merge.** It cannot run until kd is merged onto the code the other arms run (see
  "Arms").
- **The Penn 2 comparison also waits for a tool argument.** Its two corner views need an argument for fixed views that the
  tool does not have (see "Places and views").
- **The benchmark-place run waits for a labelling fix.** The tool must first label a whole-place arm by the isolate when
  the isolate is the target (see "The reference at the benchmark places").

The method is `.claude/skills/judge-preregister/SKILL.md`; the judge is described in
`docs/processes/photo_match_world_regions.md`. The user's decisions of 2026-10-31 are recorded in the plan
(`docs/research/2026-10-30-hyper-realistic-real-world-plan.md`: M1, M2 and Decisions):
- kd joins as a district arm, and DS stays;
- every district test runs at Penn Station, at 7th Avenue and West 32nd Street, with Penn 2 as the target.

## Question

This comparison settles two things.

1. **The M1 exit.** Is the judge repeatable within its spread, and does it rank known-bad builds clearly lower on the
   regions they break?
   - The judge is tested at every benchmark place and at Penn 2. K, today's building mode, is scored at all of them.
     Today's district mode, DM, is scored at Penn 2 only.
   - If yes, the judge's region scores and metrics become the measure for M2 to M8.
   - If no, the judge or its views are fixed before any milestone is judged by them.
2. **M2's neighbours.** At Penn 2, do the district's neighbours score differently on the neighbours region when they are
   massing (DM), the cleaned scan (DS) or kd (KD)?
   - If one arm beats both others under bar 6, it becomes M2's neighbours.
   - Otherwise massing stays (today's default), unless another arm beats it under bar 6. In that case M2 chooses on cost
     among the arms that no other arm beats.

## Arms

All arms at a place are built fresh and uncached from the same query text: clear the stage caches, then restart the
server. The arms must resolve to one geocoded point (one frame). The district switch is read from the server's
environment, so set it and restart before each district build.

| Id | Label | Build | Scope | Where |
|---|---|---|---|---|
| DM | District, massing neighbours | `isolate: false` (radius 250 m), trees on, `SCRATCHBOX_STAGED_DISTRICT` unset (massing, today's default) | place (named first at Penn 2: the reference) | Penn 2 |
| DS | District, cleaned-scan neighbours | as DM, `SCRATCHBOX_STAGED_DISTRICT=scan` | place | Penn 2 |
| KD | District, kd neighbours | kd, as merged: K over the whole district in 120 m chunks, the scan kept, no massing; `isolate: false` (radius 250 m), trees on | place | Penn 2 |
| K | Pipeline K, one building | `isolate: true`, `pipeline: 'k'`, everything else default | target (named first at the benchmark places: the reference) | every place |
| raw | The raw scan cut to the target | `baseline` (on) | target | every place |

- **KD is blocked until kd is merged.**
  - kd lives on the unmerged branch `feat/pipeline-kd`. On 2026-10-31 that branch was 20 commits ahead of origin/main and
    77 behind, and its worktree `.claude/worktrees/k-d` held 6 uncommitted files.
  - Built from that branch, KD would carry an older K than today's K arm. So KD is built only from code that holds both
    kd and the K the other arms run.
  - On its branch, kd is selected with `pipeline: 'kd'`. The plan moves it under `SCRATCHBOX_STAGED_DISTRICT` when it
    merges. The switch is written here as "kd, as merged" and named when the merge lands.
- **DR stays out of the first run.** DR is the rebuilt district (`SCRATCHBOX_STAGED_DISTRICT=rebuilt`).
- **The reference arm.** At Penn 2, DM is named first, because the first run is the reference:
  - its tile has the widest single extraction (KD's run tile is its centre chunk's);
  - it gives the masks and the views;
  - its vector stage gives the target's footprint.

  K is drawn there in DM's tile, with the target DM picks cut out. At the benchmark places, K is named first (see "The
  reference at the benchmark places").
- **What each run arm passes.** Each run arm passes `glbs`: the run's visible layers as `visibleStagedLayers` selects them
  (textured twins where they exist, the trees layer included). For KD, that is every joined chunk's layers. Only one run
  can be the open scene.

### The reference at the benchmark places

With no district arm there, the reference is K's own run. No reference district build is needed. Of the three things DM
gave, K's run gives the first two itself, and the third needs a tool fix, not a build:

- **The masks and the street context: K's tile.**
  - At the ESB, K's extraction is the 80 m one. Its welded geometry spans about 175 m east to west and 190 m north to
    south round the place (run 7f594cd6).
  - In the free dry run on that run, the four views held 4% to 84% neighbours and up to 12% sky.
  - Past the tile's edge the masks are sky, and every arm is drawn with that same context (see the exclusion rule under
    "Stop rules").
- **The views: aimed at K's isolate.** That is what the dry run did.
- **The target: K's isolate, matched triangle by triangle.**
  - On a fresh build the isolate and the reference tile are one extraction, so `matchedShare` should be 1.00.
  - Bar 8 reads that share at these places.
- **X1's labels: the tool fix (found while writing this draft).**
  - The tool labels a whole-place arm (`scope: 'place'`) by the target's footprint, but only when the target was picked
    (`placeRule` in `photo-match-evaluate.ts`).
  - With an isolate as the target there is no footprint, so every standing triangle of X1 is labelled neighbours. Its
    hero would then "agree" with the reference's neighbours wherever the photo has a building in front of the hero. That
    is what bar 4 reads.
  - **Fix before the dry run:** with an isolate as the target, a whole-place arm's standing triangles inside the isolate's
    plan outline (on the terrain grid) are the target.
  - At Penn 2, DM's pick gives the footprint, so X1 is labelled correctly there today.

A reference district build would add a wider tile, but there are three reasons not to build one:
- **Cost.** It is one more fresh district build per place.
- **It may not reach 250 m.** In a dense centre a 250 m request can stop at the leaf-tile cap (524 leaves, recorded as
  `radius_truncated`). That is the reason kd builds in chunks.
- **K's isolate would not match it.** K's isolate is cut from another extraction. On run 7f594cd6 the isolate matched
  85% to 97% of a scan it was not cut from. K would then have to be cut by the pick, as at Penn 2, and the exact isolate
  cut would be lost.

### Tool arguments

At the four benchmark places that are not blocked:

```
photo_match_evaluate {
  arms: [K (named first: the reference), X1, X2, each { id, label, runId, glbs, scope }],
  views: 4, runs: 3, clay: true, judgeRegions: true, trees: true, baseline: true, includeSatelliteOrtho: false
}
```

At Penn 2:

```
photo_match_evaluate {
  arms: [DM (named first: the reference), DS, KD, K, X1, X2, each { id, label, runId, glbs, scope }],
  views: 8, runs: 3, clay: true, judgeRegions: true, trees: true, baseline: true, includeSatelliteOrtho: false,
  + the two corner views, each a pano id and a heading, pitch and field of view (an argument the tool does not have yet)
}
```

The number of renders per call differs by place:
- **At Penn 2:** raw, DM, DS, KD, K, X1 and X2, 7 in all. That is one more than the earlier draft's 6, and three more than
  at the benchmark places.
- **At the benchmark places:** raw, K, X1 and X2, 4 in all.

## Places and views

The query text is fixed here and used for every arm at the place.

| Place | Query | Tests | Note |
|---|---|---|---|
| Penn Station at 32nd: Penn 2 | `2 Penn Plaza, New York` | district (bar 6) and judge calibration | the user's place for every district test (2026-10-31): Penn Station at 7th Ave and W 32nd St, Manhattan, with Penn 2 as the target. W 32nd St ends at 7th Ave at Penn 2's facade, and the 250 m radius reaches Macy's at 34th to 35th St. **The query text is this draft's choice, not yet confirmed by the user.** |
| Empire State Building | `Empire State Building, New York` | judge calibration | dense, tall |
| Haughwout Building | `Haughwout Building, 488 Broadway, New York` | judge calibration | low-rise street |
| Bryant Park | `Bryant Park, New York` | - | **blocked**: no structure at the place (see below) |
| Ferry Building | `Ferry Building, San Francisco` | judge calibration | waterfront, plaza |
| Dolores Park | `Dolores Park, San Francisco` | - | **blocked**: no structure at the place |
| Griffith Observatory | `Griffith Observatory, Los Angeles` | judge calibration | hillside, horizon |

- **Views at the benchmark places: four per place.** They are held out and registered, and the tool chooses them:
  - Google-captured panos that no arm's build used, aimed at the target;
  - kept when the target fills at least 6% of the frame and at least 30% of it is unhidden;
  - registered by edges to at most 5 px, and the nearest four that lock are used.
- **Views at Penn 2: eight in one call, the tool's maximum.** Two are fixed corner views, and the tool chooses the other
  six by the rules above.
  - **View A, Penn 2's facade.** From W 32nd St at 7th Ave, facing Penn 2's 7th Ave facade, where the user's photo shows
    the Chase sign. The heading is about 119°, east along W 32nd St (Manhattan's grid runs about 29° east of true north).
  - **View B, up 7th Ave.** From the same corner, looking north up 7th Ave to Primark and Macy's, at a heading of about
    29°. Penn 2 sits at the frame's edge, so this view fails the rule that the target fills at least 6% of the frame.
  - **Both corner views must be held out and registered.** Each must be a Google-captured pano that no arm's build used,
    registered by edges like the others. If every capture at the corner was used by a build, or none locks, the view
    cannot be judged: stop and report it.
  - **Bar 6 counts views here.** With one place there are no places to agree, so bar 6 counts views over all eight.
    Eight views let the sign hold at three quarters of them, the rate the earlier draft asked of places (3 of 4). The
    two corner views are also reported on their own beside the bar; they decide nothing alone.
- **The tool cannot take the corner views today** (checked 2026-10-31).
  - `photo_match_evaluate` has no argument for a fixed pano or pose. Every view comes from its rule: aimed at the target,
    with the 6% and 30% thresholds.
  - `excludePanoIds` can narrow the candidates to the corner's panos. It cannot aim a view or waive the 6% threshold, so it
    cannot give view B.
  - The parks session's new rule (session "Photo-match views at parks and eye height", commit 6d6d25f7 on
    `claude/elastic-jennings-e32939`) applies only where no structure stands at the place. There the views look at the
    place itself. At Penn 2 the pick finds Penn 2, so that rule does not apply.
  - **So the corner views need a new argument:** a fixed held-out view given as a pano id with a heading, pitch and field
    of view. It is checked as held out and registered like the others, and is exempt from the target-share rule. The
    tool is not changed for it in this pass.
  - The fixed views name only pano ids and angles. No sign or brand name goes into a tool argument, a prompt or code.
- **Blocked places.** At a park the structure rule finds nothing within 30 m of the place. **Decision for the user:**
  - either judge the parks with the open-place view rule the parks session is building (above), once it lands;
  - or query a building on the park's edge, which would change what the place tests.

### What each arm shows at the corner views

Recorded, deciding nothing. Fill it from the dry run's renders (what each arm draws) and the paid run's grids (the
photo beside them). For each arm, say what it draws where the photo shows each sign: for example the tile photo's sign,
the arm's own texture, a blank wall, massing, or nothing.

| View | The photo | raw | DM | DS | KD | K | X1 | X2 |
|---|---|---|---|---|---|---|---|---|
| A: Penn 2's 7th Ave facade, the Chase sign | | | | | | | | |
| B: north up 7th Ave, Primark and Macy's | | | | | | | | |

## Bars

Fixed before any paid call. "Spread" means the judge's run spread (`runSd`) as the tool reports it. "Judged places" are
the benchmark places not blocked, plus Penn 2.

| # | Metric | Mask | Bar | Direction | A miss means |
|---|---|---|---|---|---|
| 1 | Judge run spread, every arm | building (overall) | mean runSd at most 0.75 | lower | the judge is not repeatable here; M1 exit fails at that place |
| 2 | Judge run spread, every arm | ground, neighbours, skyline (`regionScores`) | mean runSd at most 1.0 each | lower | the region criteria are not repeatable; the region scores cannot decide anything |
| 3 | Decoy X1 against K | ground, neighbours | judge score at least 2.0 lower than K's, at every judged place | lower for X1 | the judge does not see a missing street or missing neighbours; stop |
| 4 | Decoy X1 against K | ground, neighbours (`agreement`) | at most 0.3 | lower for X1 | the masks or the arm scopes are wrong; stop |
| 5 | Decoy X2 against K | building (overall and shape) | at least 1.0 lower than K's at all but one judged place | lower for X2 | registration does not cost points; the building scores cannot rank small misfits |
| 6 | DM, DS and KD, each pair, at Penn 2 | neighbours (judge) | the pair's gap (difference of means over the judged views) is wider than both arms' spread, and has the same sign at 6 or more of the 8 views | either | the judge cannot tell that pair apart |
| 7 | raw | frame (`agreement`) | exactly 1.00 at every view | equal | the reference or the cut is broken; stop |
| 8 | The target | `regions.target` | at Penn 2 (a picked target), `footprintSource` is `vector-footprint`; at the benchmark places (K's isolate), `matchedShare` is at least 0.99 | - | the building mask is unreliable at that place; it stays out of the building bars |

- **Bar 6 with fewer views.** If fewer than 8 views lock, the sign must hold at three quarters of the judged views. With
  fewer than 6 judged views, bar 6 is indicative only.
- **Bar 6's chance level.** On its own, a 6-of-8 split one way happens by chance about 29% of the time. The gap wider than
  both spreads is what makes it a difference.
- **What bar 6's score covers.**
  - The judge scores the neighbours over the whole photo. The neighbours mask covers only what DM's tile reaches.
  - Past that reach (`radius_truncated`), DM and DS both show vector massing, and KD shows its chunks. So a gap between
    KD and the other two includes the far field, which is part of what kd changes. A gap between DM and DS does not
    include it.
  - View B, up 7th Ave to Macy's, is where this shows most. The report says so.

Secondary, reported and deciding nothing: SSIM, edge chamfer, CIEDE2000 and agreement per region, for every arm.

## Decoys

Both are made locally from the arms' own files, at no cost, and judged blind in the same calls as the arms.

- **X1: the hero with no place round it.** K's GLBs with `scope: 'place'`, drawn alone, with no street and no neighbours.
  - It must lose on ground and neighbours (bars 3 and 4).
  - Its building can stay close to K's.
  - At the benchmark places it needs the labelling fix above.
- **X2: the hero moved.** K's GLBs with the root node translated 4 m along +x (one node translation in the glTF JSON),
  `scope: 'target'`. It must lose on the building (bar 5).

## Stop rules

- **Spend cap.**
  - **Judge calls** are views × runs × 2 (textured and clay): 24 per benchmark place (96 for the four that are not
    blocked), 48 at Penn 2, 144 in all.
  - **Street View grounding images:** at most 8 per benchmark place. At Penn 2, at most 14: 12 in the run, plus the two
    corner photos fetched first for the sign check. That is 46 in all.
  - Anything past that stops the run.
- **A decoy that passes.** If bars 3 to 5 miss at a place, stop, and fix the judge or the views, not the builds.
- **Spread wider than the gap.** If bar 6 misses for a pair, report "the judge cannot tell" for that pair, not a winner.
- **Too few views.** A benchmark place with fewer than 3 judged views is reported as indicative only, and kept out of
  bars 3 and 5.
- **The tile's edge, in the paid run.** Before any score is read, look at the grids' mask overlays.
  - A view where the sky mask lies over buildings in the photo (the reference tile ends inside the view) is listed.
  - It stays in bars 1 and 5 (the building), and is left out of bars 2 to 4 (the regions).
- **The dry run, at every place, before any paid call.** Stop at a place if any of these shows:
  - an empty or black render, or an arm with 0 triangles;
  - `frame_mismatch`;
  - `liftedM` over 1 m;
  - at a benchmark place:
    - `regions.target.matchedShare` under 0.99;
    - X1's building agreement under 0.9 (a check of the labelling fix);
  - at Penn 2:
    - no `vector-footprint` target at DM;
    - K's hero not inside DM's target mask in the mask grids (K isolated another building than the one DM picks).
- **The corner views (at Penn 2).**
  - **In frame, in the dry run.** The dry run's photos are stand-ins rendered from DM's tile, so it can show the poses
    and every arm's render there. View A must face Penn 2's 7th Ave facade, and view B must look up 7th Ave with Penn 2
    at the frame's edge. Review both with the `screenshot-review` skill, and stop if either is not in frame.
  - **The signs readable, before any judge call.** The stand-in photos cannot show the photo's signs. So fetch the two
    real corner photos first (2 grounding images, inside the cap above) and review them with `screenshot-review`:
    - in view A, the Chase sign on Penn 2's facade is readable;
    - in view B, Primark's and Macy's signs up 7th Ave are readable.

    If not (for example an older capture, or a truck in front), take another capture at the corner that no build used.
    If none serves, stop.
  - **The table above** is filled at the same time.
- **The target is Penn 2 alone (at Penn 2).** Penn 2 shares one superblock with Madison Square Garden and the station.
  - **Report** the footprint the vector stage gives the place: the run's note "footprint from Google vector data" (its
    feature ids and area, the share raised in the scan, and whether it encloses the structure). Also report DM's
    `regions.target` (`areaM2`, `heightM`, `footprintSource`), and the plan extent and area of K's isolate (from the
    isolate GLB's bounds).
  - **Stop if** DM's target or K's isolate is the complex rather than Penn 2 alone:
    - the mask grids draw the arena, or the block's buildings toward 8th Ave, as target;
    - or K's isolate reaches past the middle of the block from 7th Ave;
    - or the vector footprint at the place is one feature for the whole block, so neither the pick nor K's footprint clip
      can keep to Penn 2.
- **KD's own dry-run rules (at Penn 2).** The record names below are those on `feat/pipeline-kd`; check them again after
  the merge. Stop if:
  - **Not every chunk was built and joined.** The `chunks` stage must be committed, not degraded, with `failed: 0` and
    `joined` equal to the chunks round the centre. At 250 m kd's plan has 21 cells: 20 chunks and the centre build.
  - **Any chunk failed.** A `chunk_failed` or `chunks_failed` degradation means a chunk that failed after its retry
    falls back to the vector buildings past the centre build's tiles. That would mix massing into KD.
  - **Any chunk was truncated.** A `chunk_truncated` degradation means a chunk's scan stopped short of its cell and left
    part of it empty. This rule is this draft's addition to the two above.
  - **The seam stage did not run.** The run note `district_chunks_joined` must carry `seams`, with `grounds` covering
    every joined chunk and the centre.
  - **The vector buildings are still standing.** The vector buildings layer (`l0o`) is retired only once every chunk is
    joined. If it is still in KD's visible layers, stop.
- **DM's reach (at Penn 2), recorded and not a stop.** Record DM's `radius_truncated` (the radius its tiles reach) in the
  report, against the distance from the place to Macy's. The masks are sky past it (see bar 6).

## Exposure

- **Panos any arm's build used** are excluded by the tool. It reads the runs' notes, stage entries, scene and GLB extras,
  and since this branch also views named after a pano (`<panoId>_h<deg>_p<deg>`). On the ESB K run 7f594cd6, the 16 panos
  its Street View score used are now excluded. At Penn 2, K's Street View score may use the corner's panos. A corner view
  then needs another capture at the corner (see "Places and views").
- **Panos earlier comparisons judged.** The ESB and the Haughwout Building were judged in earlier work
  (`staged_location_photo_match_bakeoff.md`, `facade_materials_merge_eval.md`, `streetview_value.md` and others). Their
  `report.json` files went with the cache clears, so the pano lists survive only where those docs recorded them.
  - They are not excluded: the judge does not learn from them.
  - **Decision for the user:** add the recorded ones to `excludePanoIds` if a fully unseen set is wanted.
  - No earlier comparison is known at Penn 2.
- **The stand-in dry run** on run 7f594cd6 (2026-10-31) judged nothing real.

## Step 2: the free dry run (before approval of the spend)

When the fresh builds exist at a place, write a config and run the driver. Config:

```
{ "root": "<staged workspace root>", "tile": "<the reference run's textured tile: the welded one when the run welded it>",
  "out": "docs/screenshots/m1_prereg/<place>", "args": { ...the tool arguments above for that place... } }
```

The reference run is K's at a benchmark place and DM's at Penn 2. At Penn 2 the driver needs the corner-view argument
too.

Run it with credentials unreachable:

```bash
env -i PATH="$PATH" HOME="$(mktemp -d)" PHOTO_MATCH_DRYRUN=<config.json> ./node_modules/.bin/vitest run packages/core/test/photo-match-dryrun.test.ts
```

It must show:

- every arm and decoy rendering at every held-out pose;
- the excluded panos;
- the call count: 24 at a benchmark place, 48 at Penn 2;
- the mask grids looked at with the `screenshot-review` skill.

## Cost

- **Builds.** All fresh and uncached, one after another, one place at a time (the Mac is heavily loaded).
  - **At the benchmark places:** one build per place (K). That is 4 for the places not blocked, 6 with the parks.
  - **At Penn 2:** four builds (DM, DS, KD, K).
  - **In all:** 8 builds (10 with the parks).
  - **KD's time:** on its branch, Shibuya at 350 m was 44 chunks round the centre in about 106 minutes. At 250 m, kd's
    plan has 20 chunks round the centre, so about 50 minutes. That is an estimate scaled by chunk count, not a
    measurement.
- **Judge.** 144 calls on the default judge (`gemini-4-argon`) with a 24,576-token thinking budget:
  - 96 at the benchmark places, each with the photo and 4 renders;
  - 48 at Penn 2, each with the photo and 7 renders.

  **The price per call is to be filled in before approval.**
- **Street View grounding.** Up to 46 images.
- **Decoys and dry runs.** Free.

## Report

After the single paid run:
- Fill one row per bar with each arm's value and spread, each decoy's value, and met or missed. For bar 6, give one row
  per pair.
- Give the corner views on their own, with the table of what each arm shows there.
- Give the two decisions named in the question.
- Attach the grids and mask grids.
