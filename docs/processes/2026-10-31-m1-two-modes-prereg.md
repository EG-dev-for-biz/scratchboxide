# Preregistration (draft): today's build modes judged as whole places, K at the benchmark places and the district at Penn 2

Date: 2026-10-31. Status: **draft, not approved, nothing run.** No paid judge call and no live build happen until the user
approves this document.

**The code the run uses.** kd, this judge branch and the `poses` input are merged on one local branch, `feat/m1-run`
(worktree `.claude/worktrees/m1-run`, not pushed; the user asked for it). It is fast-forwarded to `feat/m1-world-judge`
with X1's labelling fix, and holds:
- `feat/kd-on-switches`, kd moved onto the district switch;
- `claude/elastic-jennings-e32939`, the parks session's views, eye height and `poses` input;
- `feat/m1-world-judge`: the judge, this draft, and whole-place arms labelled by the isolate's plan outline when the
  isolate is the target (see "The reference at the benchmark places").

Every arm is built, and every dry run and the paid run are made, from that one branch, so KD and the K arm carry the same
K. Its checks:
- **At the merge (6febae69):** a clean typecheck across all packages, and 55 test files passing with credentials
  unreachable.
- **On the labelling fix:** the photo-match tests pass with credentials unreachable, and `packages/core` typechecks
  clean.
- **One failure that predates the merges:** `photo-match-eval-tree-cutout` "card-only tree" fails (clay coverage 0.8396
  against a bar of 0.8352). It fails the same way on the merged branches on their own.

The `poses` input was checked on a synthetic block and in a dry run at the ESB. No Penn Station tile is cached, so it has
not been tried at Penn 2.

The method is `.claude/skills/judge-preregister/SKILL.md`; the judge is described in
`docs/processes/photo_match_world_regions.md`. Decisions of 2026-10-31:
- **The user's, recorded in the plan.** These are in
  `docs/research/2026-10-30-hyper-realistic-real-world-plan.md` (M1, M2 and Decisions):
  - kd joins as a district arm, and DS stays;
  - every district test runs at Penn Station, at 7th Avenue and West 32nd Street, with Penn 2 as the target.
- **The main session's, on the user's go-ahead** ("if it doesn't work do what you think is best"):
  - the two fixed poses and their swap rules;
  - the 11 Penn Plaza fallback target.

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

All arms at a place are built fresh and uncached from the same query text, on `feat/m1-run`: clear the stage caches,
then restart the server. The arms must resolve to one geocoded point (one frame).

A district build names its look in the request with the staged tool's `district` argument. That argument comes before the
server's `SCRATCHBOX_STAGED_DISTRICT`, so the arms need no change to the environment between them. Leave that variable
unset, so that nothing but the argument decides.

| Id | Label | Build | Scope | Where |
|---|---|---|---|---|
| DM | District, massing neighbours | `isolate: false` (radius 250 m), trees on, `district: 'massing'` (the default, given explicitly) | place (named first at Penn 2: the reference) | Penn 2 |
| DS | District, cleaned-scan neighbours | as DM, `district: 'scan'` | place | Penn 2 |
| KD | District, kd neighbours | as DM, `district: 'kd'`: K over the whole district in 120 m chunks, the scan kept, no massing (a kd district never isolates) | place | Penn 2 |
| K | Pipeline K, one building | `isolate: true`, `pipeline: 'k'`, everything else default | target (named first at the benchmark places: the reference) | every place |
| raw | The raw scan cut to the target | `baseline` (on) | target | every place |

- **KD is on the code the other arms run.**
  - kd is merged on `feat/m1-run` with the district switch. `SCRATCHBOX_STAGED_DISTRICT=kd` and the staged tool's older
    `pipeline: 'kd'` select the same look, but this draft uses `district: 'kd'` only.
  - Built from its old branch, `feat/pipeline-kd`, KD would carry an older K than the K arm's. So no arm is built from
    that branch.
- **DR stays out of the first run.** DR is the rebuilt district (`district: 'rebuilt'`).
- **The reference arm.** At Penn 2, DM is named first, because the first run is the reference:
  - its tile has the widest single extraction (KD's run tile is its centre chunk's);
  - it gives the masks and the automatic views;
  - its vector stage gives the target's footprint.

  K is drawn there in DM's tile, with the target DM picks cut out. At the benchmark places, K is named first (see "The
  reference at the benchmark places").
- **What each run arm passes.** Each run arm passes `glbs`: the run's visible layers as `visibleStagedLayers` selects them
  (textured twins where they exist, the trees layer included). For KD, that is every joined chunk's layers. Only one run
  can be the open scene.

### The reference at the benchmark places

With no district arm there, the reference is K's own run. No reference district build is needed. Of the three things DM
gave, K's run gives the first two itself, and the third came from a tool fix, not a build:

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
- **X1's labels: K's isolate's plan outline** (the tool fix, found while writing this draft).
  - **The gap.** The tool used to label a whole-place arm (`scope: 'place'`) by the target's footprint only when the
    target was picked. With an isolate as the target every standing triangle of X1 was a neighbour, so its hero
    "agreed" with the reference's neighbours wherever the photo had a building in front of the hero. That is what bar 4
    reads.
  - **The rule now.** On the terrain grid (1 m), the outline is:
    - every cell whose centre lies within 1 m in plan of one of the isolate's standing triangles;
    - every cell those enclose.

    A whole-place arm's standing triangle is the target when its centroid falls in the outline, else a neighbour. It is
    decided by geometry alone. The tile's labels and the `scope: 'target'` arms are unchanged. The method is in
    `docs/processes/photo_match_world_regions.md` and in the tool's `regions.placeOutline`.
  - **In the free dry run at the ESB** (run 7f594cd6), X1's standing triangles were 933,344 target and 10 neighbours.
    Its building agreement was 1.00 in all four views, its neighbours agreement 0.00 and its ground agreement 0.03 to
    0.08.
  - **At Penn 2,** DM's pick gives the footprint, and X1 is labelled by it as before.

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
  poses: [
    { label: 'A facade', lat: <corner>, lng: <corner>, headingDeg: <avenue bearing + 270>, pitchDeg: 12, fovDeg: 80 },
    { label: 'B uptown', lat: <corner>, lng: <corner>, headingDeg: <avenue bearing>, pitchDeg: 12, fovDeg: 80 }
  ],
  views: 8, runs: 3, clay: true, judgeRegions: true, trees: true, baseline: true, includeSatelliteOrtho: false
}
```

- **`views: 8` counts the poses.** The registered fixed views come first, in the order given, and the nearest automatic
  views fill the other six, never from a pose's pano.
- **A swapped pose names its pano.** It is given as `panoId` in place of `lat`/`lng` (see "Views at Penn 2").
- **The values in angle brackets** are filled in as "Views at Penn 2" says.

The number of renders per call differs by place:
- **At Penn 2:** raw, DM, DS, KD, K, X1 and X2, 7 in all. That is one more than the earlier draft's 6, and three more than
  at the benchmark places.
- **At the benchmark places:** raw, K, X1 and X2, 4 in all.

## Places and views

The query text is fixed here and used for every arm at the place.

| Place | Query | Tests | Note |
|---|---|---|---|
| Penn Station at 32nd: Penn 2 | `2 Penn Plaza, New York` | district (bar 6) and judge calibration | The user's place for every district test (2026-10-31): Penn Station at 7th Ave and W 32nd St, Manhattan, with Penn 2 as the target. Penn 2 stands on the west side of 7th Ave, where W 32nd St ends at its facade. The 250 m radius reaches Macy's at 34th to 35th St. **The query text is the main session's choice, not yet confirmed by the user.** |
| Fallback: 11 Penn Plaza | `11 Penn Plaza, New York` | as above, only if the fallback is taken | The building on the east side of 7th Ave between W 31st and W 32nd St, at the same corner, where the user's map line ended. See "The target at Penn 2, and its fallback". |
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
- **Blocked places.** At a park the structure rule finds nothing within 30 m of the place. **Decision for the user:**
  - either judge the parks with the open-place view rule, now merged on `feat/m1-run` (views look at the place itself
    when no structure stands at it);
  - or query a building on the park's edge, which would change what the place tests.

### Views at Penn 2: two fixed poses and six automatic

Eight views in one call, the tool's maximum. The tool chooses six by the rules above. Two are fixed here, before any build
exists, so they are not picked after seeing results. Today's rule cannot give them: it aims every view at the structure,
and it needs the structure to fill 6% of the frame, so the look up 7th Ave cannot pass.

- **The poses.**
  - **Pose A, Penn 2's facade.** From the pano nearest 7th Ave and W 32nd St, facing Penn 2's 7th Ave facade across the
    avenue, where the user's photo shows the Chase sign. The heading is perpendicular to the avenue: its bearing plus
    270°, about 299°.
  - **Pose B, uptown.** From the same pano, looking uptown along 7th Ave toward Primark and Macy's. The heading is the
    avenue's bearing, about 29°.
- **How a pose is given to the tool** (the `poses` input as it landed):
  - **Position.** `lat`/`lng` is the corner of 7th Ave and W 32nd St, written into this draft before any build. The tool
    looks from the nearest Google-captured pano within 20 m of it, its eye 2.5 m over the street there.
  - **Headings.** Both headings come from the avenue's line in the reference frame: the vector stage's road line, else
    Penn 2's 7th Ave facade line in the tile. They are measured once DM's reference exists, before the dry run, and
    entered as `headingDeg` (clockwise from true north). They are not taken from a map, and they are computed, not chosen
    after any score.
  - **Pitch and field of view.** `pitchDeg: 12` (up) and `fovDeg: 80`, the tool's own framing for a close view (4:3).
    These are set explicitly, because the input's defaults are 0° and 90°.
- **What a pose must pass.** These are the tool's own checks:
  - **Held out.** A pano any build used is refused (`used-by-build`).
  - **Registered.** A view that does not register by edges to at most 5 px is not used (`not-registered`).
  - **No target-share gate.** The target's share of the frame is reported in `heldOut.fixed[].targetScreenShare`, not
    used to decide.
- **Swaps, made before the paid run.** The tool never swaps a pano by itself, so swaps are made by hand, by naming the
  next pano as `panoId`:
  - **If a pose's pano was used** (`used-by-build` in the dry run), take the next nearest unused pano on 7th Ave with the
    same heading: between 31st and 33rd St for pose A, between 32nd and 33rd St for pose B. Report the swap.
  - **If the photo and the tile show Penn 2's facade from different eras** (Penn 2 was reclad), or a sign is unreadable
    in the sign check, take the next pano by date at that spot. Note it in the dry run.
- **A pose that does not register.** Registration happens only inside the paid call; the tool has no register-only
  pass. So a `not-registered` pose is not swapped: an automatic view fills its slot, and the pose is reported as missing,
  with its residuals. A swap there would need a second paid call.
- **If no pose is left.** Judge Penn 2 on its automatic views, and report the fixed poses as missing.
- **No names in code.** The poses name only pano ids and angles. No sign or brand name goes into a tool argument, a prompt
  or code.
- **Bar 6 counts views here.** With one place there are no places to agree, so bar 6 counts views over all eight. Eight
  views let the sign hold at three quarters of them, the rate the earlier draft asked of places (3 of 4). The two poses
  are also reported on their own beside the bar; they decide nothing alone.

### The target at Penn 2, and its fallback

Penn 2 shares one superblock with Madison Square Garden and the station, so its target is checked before the district
builds. **Build K first at Penn 2, and read its records.** Use the fallback if any of these shows:
- **The geocode is off.** `2 Penn Plaza, New York` geocodes more than about 50 m from 7th Ave and W 32nd St (the run's
  geocoded point).
- **No footprint of its own.** Penn 2 has no vector footprint of its own. Either the run's footprint note says "footprint
  from the scan's geometry alone", or the footprint holding the place is one feature for the whole block.
- **It grows into the complex.** Penn 2's footprint or K's isolate grows into Madison Square Garden or the station:
  - it reaches past the middle of the block from 7th Ave (the isolate GLB's plan extent);
  - or, seen in the mask grids, it takes in the arena.

The same checks apply to DM's picked target in DM's dry run.

- **Report, either way:**
  - the footprint the vector stage gives the place: the run's note "footprint from Google vector data", with its feature
    ids and area, the share raised in the scan, and whether it encloses the structure;
  - DM's `regions.target`: `areaM2`, `heightM` and `footprintSource`;
  - the plan extent and area of K's isolate.
- **The fallback.** Every arm runs at `11 Penn Plaza, New York`, in one frame, with its own building as the target. It is
  at the same corner, and it is the building the user's map line ended on.
  - **The views stay at 7th Ave and W 32nd St.** Poses A and B keep their panos and headings, and the six automatic
    views aim at 11 Penn Plaza.
  - **Under the fallback, pose A shows Penn 2 as a neighbour.**
  - **The report records** which target was used and why.

### What each arm shows at the poses

Recorded, deciding nothing. Fill it from the dry run's renders (what each arm draws) and the paid run's grids (the photo
beside them). For each arm, say what it draws where the photo shows each sign: for example the tile photo's sign, the
arm's own texture, a blank wall, massing, or nothing.

| View | The photo | raw | DM | DS | KD | K | X1 | X2 |
|---|---|---|---|---|---|---|---|---|
| A: Penn 2's 7th Ave facade, the Chase sign | | | | | | | | |
| B: uptown along 7th Ave, Primark and Macy's | | | | | | | | |

## Bars

Fixed before any paid call. "Spread" means the judge's run spread (`runSd`) as the tool reports it. "Judged places" are
the benchmark places not blocked, plus Penn 2 (or its fallback).

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

- **How bar 4 labels X1.** X1 is scored on the reference tile's ground and neighbours masks; its own labels say what it
  shows there.
  - **At the benchmark places,** K's isolate is the target. X1's standing triangles inside the isolate's plan outline on
    the terrain grid (every cell whose centre lies within 1 m of the isolate's standing triangles, and every cell they
    enclose) are the target, and the rest are neighbours. The tool reports the outline in `regions.placeOutline`, and X1's
    triangles by label in `regions.armTriangles.X1`.
  - **At Penn 2,** DM's picked footprint labels X1 instead.
  - **What it reads.** Either way X1 holds only the hero, so its agreement on ground and neighbours measures the street
    and the buildings it lacks. In the free dry run at the ESB it was 0.00 on the neighbours and 0.03 to 0.08 on the
    ground, in all four views.
- **Bar 6 with fewer views.** If fewer than 8 views lock, the sign must hold at three quarters of the judged views. With
  fewer than 6 judged views, bar 6 is indicative only.
- **Bar 6's chance level.** On its own, a 6-of-8 split one way happens by chance about 29% of the time. The gap wider than
  both spreads is what makes it a difference.
- **What bar 6's score covers.**
  - The judge scores the neighbours over the whole photo. The neighbours mask covers only what DM's tile reaches.
  - Past that reach (`radius_truncated`), DM and DS both show vector massing, and KD shows its chunks. So a gap between
    KD and the other two includes the far field, which is part of what kd changes. A gap between DM and DS does not
    include it.
  - Pose B, uptown to Macy's, is where this shows most. The report says so.
- **Bar 5 and the poses.** Bar 5 leaves out a pose whose `heldOut.fixed[].targetScreenShare` is under 0.06, because the
  move it tests barely shows there. That is expected for pose B, and for pose A as well under the fallback.

Secondary, reported and deciding nothing: SSIM, edge chamfer, CIEDE2000 and agreement per region, for every arm.

## Decoys

Both are made locally from the arms' own files, at no cost, and judged blind in the same calls as the arms.

- **X1: the hero with no place round it.** K's GLBs with `scope: 'place'`, drawn alone, with no street and no neighbours.
  - It must lose on ground and neighbours (bars 3 and 4).
  - Its building can stay close to K's.
  - At the benchmark places it is labelled by K's isolate's plan outline (see "How bar 4 labels X1").
- **X2: the hero moved.** K's GLBs with the root node translated 4 m along +x (one node translation in the glTF JSON),
  `scope: 'target'`. It must lose on the building (bar 5).

## Stop rules

- **Spend cap.**
  - **Judge calls** are views × runs × 2 (textured and clay): 24 per benchmark place (96 for the four that are not
    blocked), 48 at Penn 2, 144 in all.
  - **Street View grounding images:** at most 8 per benchmark place. At Penn 2, at most 18:
    - 12 in the run;
    - the two pose photos, fetched first for the sign check;
    - up to 4 for pose swaps (2 per pose).

    That is 50 in all.
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
    - X1's building agreement under 0.9 (a check of the outline labelling; 1.00 in every view of the ESB dry run on
      run 7f594cd6);
  - at Penn 2:
    - no `vector-footprint` target at DM;
    - K's hero not inside DM's target mask in the mask grids (K isolated another building than the one DM picks).

    The target checks above lead to the fallback, not to a stop.
- **The poses (at Penn 2).**
  - **Their outcomes, in the dry run.** Read `heldOut.fixed`, which gives each pose's pano, its distance from the corner,
    and its status.
    - `used-by-build` leads to the swap above.
    - `no-pano` there may only mean that the Street View metadata cache lacks the corner's panos: the dry run's lookup
      reads that cache. Check it again with the real lookup in the sign check.
  - **In frame, in the dry run.** The dry run's photos are stand-ins rendered from DM's tile, so it can show the poses
    and every arm's render there.
    - Pose A must face Penn 2's 7th Ave facade across the avenue.
    - Pose B must look uptown along 7th Ave.
    - Review both with the `screenshot-review` skill. If either is off, its heading was computed wrong. Fix it from the
      avenue's line before any paid call.
  - **The signs readable, before any judge call.** The stand-in photos cannot show the photo's signs. So fetch the two
    real pose photos first (inside the cap above) and review them with `screenshot-review`:
    - in pose A, the Chase sign on Penn 2's facade is readable;
    - in pose B, Primark's and Macy's signs up 7th Ave are readable;
    - the facade in the photo is the one in the tile (the same era).

    If not, use the swap and era rules in "Views at Penn 2". With no pano left, judge on the automatic views, and report
    the pose as missing.
  - **The table above** is filled at the same time.
- **KD's own dry-run rules (at Penn 2).** The record names below were checked on `feat/m1-run` at 6febae69. They are the
  ones kd's own branch used, and the chunk grid is unchanged. Stop if:
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

- **Panos any arm's build used** are excluded by the tool.
  - It reads the runs' notes, stage entries, scene and GLB extras, and since this branch also views named after a pano
    (`<panoId>_h<deg>_p<deg>`). On the ESB K run 7f594cd6, the 16 panos its Street View score used are now excluded.
  - At Penn 2, K's Street View score may use the corner's panos. A pose then takes the next nearest unused pano (see
    "Views at Penn 2").
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

The reference run is K's at a benchmark place and DM's at Penn 2. At Penn 2 the arguments carry the poses. The driver
(as merged on `feat/m1-run`) finds their panos in the Street View metadata cache, and stand-in registration is the
identity, so `not-registered` cannot show before the paid run. Run it in the `feat/m1-run` worktree.

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
  - **At Penn 2:** four builds, K first (for the target checks), then DM, DS and KD.
  - **The fallback:** it adds one build, K again at 11 Penn Plaza. The districts are then built there, not at Penn 2.
  - **In all:** 8 builds, 9 with the fallback, 2 more with the parks.
  - **KD's time:** on its branch, Shibuya at 350 m was 44 chunks round the centre in about 106 minutes. At 250 m, kd's
    plan has 20 chunks round the centre, so about 50 minutes. That is an estimate scaled by chunk count, not a
    measurement.
- **Judge.** 144 calls on the default judge (`gemini-4-argon`) with a 24,576-token thinking budget:
  - 96 at the benchmark places, each with the photo and 4 renders;
  - 48 at Penn 2, each with the photo and 7 renders.

  **The price per call is to be filled in before approval.**
- **Street View grounding.** Up to 50 images.
- **Decoys and dry runs.** Free.

## Report

After the single paid run:
- Fill one row per bar with each arm's value and spread, each decoy's value, and met or missed. For bar 6, give one row
  per pair.
- Say which target was used at Penn 2 (Penn 2 or 11 Penn Plaza) and why, and any pose swap.
- Give the poses on their own, with the table of what each arm shows there.
- Give the two decisions named in the question.
- Attach the grids and mask grids.
