# Preregistration: today's build modes judged as whole places, K at the benchmark places and the district at Penn 2

Date: 2026-10-31. Status: **approved by the user on 2026-10-31** (the draft at a14558d2). Nothing below changes after
this line except the report. The user's answers, word for word:
- **Approval:** "Approve and run (Recommended)".
- **Penn 2's query text, `2 Penn Plaza, New York`:** "Use it (Recommended)".
- **The parks (Bryant Park, Dolores Park):** "Leave them out (Recommended)". The run is the four benchmark places and
  Penn 2, the 144 judge calls the cost assumes.
- **The views earlier comparisons judged at the ESB and the Haughwout Building:** "Keep them in (Recommended)". No
  `excludePanoIds` are given for them.
- **Spending:** "any budget within $100 does not need to be approved". The estimate below is $15 to $75 through
  2026-11-30. If the actual spend would pass $100 at any point, the run stops and is reported.

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

**Amendment, 2026-10-31, before any paid call: the tile's target is labelled by the isolate's surface.**
- **The evidence.** The ESB dry run on the fresh K run 0bb20154 hit the stop rule `matchedShare` under 0.99, at 0.967. Every
  stage of that run was a cache miss: the extraction and the remesh were fresh, from one extraction. In
  `docs/screenshots/m1_prereg/esb_dryrun/masks_view1.png` a straight diagonal wedge of the building's own 34th St facade is
  labelled neighbour in the reference mask. That is a broken reference mask, not a property of the build.
- **The premise that was wrong.** This draft said that on a fresh build the isolate and the tile are one extraction, so
  `matchedShare` should be 1.00. It is not. tile_refine cuts the isolate's triangles at its outline, so the isolate does
  not hold the tile's triangles one for one:
  - 4.9% of the isolate's triangles had no tile triangle with the same centroid, even at a 5 cm tolerance;
  - 1.4% of its standing triangles (2.5% of their area) had none;
  - the tile triangles they were cut from were left out of the target.

  The 0.967 on run 7f594cd6, put down to a mixed extraction, is the same effect: the fresh build gives the same figure.
- **The change.** It is in `photo-match-evaluate.ts`:
  - A tile triangle is the target when its centroid lies on the isolate's surface: point to triangle, within 3 cm
    (`PHOTO_MATCH_ISOLATE_SURFACE_M`, the seam weld's tolerance), in `onSurfaceFlags`. This replaces centroid-to-centroid
    matching (`nearTriangleFlags`).
  - A tile triangle the isolate's cut runs through goes by where its centroid falls.
  - Penn 2's picked-footprint path is unchanged.
- **Bar 8's measure.** Bar 8 keeps its 0.99 and its meaning: how much of the isolate the tile's target covers. With cut
  triangles a count no longer measures that, so `matchedShare` is now by area (`surfaceCoverShare`): the share of the
  isolate's area within 3 cm of the tile triangles labelled target. The earlier count is reported beside it as
  `matchedShareByTriangles`. The dry-run stop rule `matchedShare` under 0.99 reads the same field.
- **On run 0bb20154:** 105,452 tile triangles are the target (95,646 before), and `matchedShare` is 0.996 by area. The
  triangle count share is 0.967.
- **Unchanged.** No bar, arm, decoy, place, view, pose or stop rule changed.

**Amendment 2, 2026-10-31, before any paid call: the dry run's X1 check counts X1's labels.**
- **The evidence.** The ESB dry run, redone on amendment 1, passed `matchedShare` at 0.996. It then hit the stop rule
  "X1's building agreement under 0.9" in one view. X1's building agreement per view was 1.00, 0.998, 1.00, and 0.895 in
  v3.
- **The cause.** v3 looks past a neighbour's wall at the building's corner.
  - There the reference's target includes a narrow angled wall strip, about 6% of the frame width.
  - The strip is in tile_refine's isolate and in the raw scan. K's polish clips at its footprint plus 0.3 m, so K and X1
    (K's own GLB) show the street behind it. K's own building agreement in v3 is 0.895 too.
  - X1's labels are right: 951,696 of its 951,701 standing triangles are the target.
- **Why it is amended, not waived.** The rule's own text says it checks the outline labelling. As written it measured
  geometry K removed, which is something else.
- **The change.** At every benchmark place the dry run's X1 check is now: the share of X1's standing triangles labelled
  target (`regions.armTriangles.X1`: target over target, neighbours and trees) is at least 0.99. X1's building agreement
  per view stays in the dry-run record as information.
- **A finding about K, for the report.** K drops scanned wall that the isolate keeps. Bars 1 and 5 and the building scores
  will see it. Nothing is done about it in this run.
- **Unchanged.** No bar, arm, decoy, place, view, pose or other stop rule changed.

**Amendment 3, 2026-10-31, before any paid call: a `matchedShare` miss is resolved by bar 8's own consequence** (the
user's decision: "Yes, use bar 8").
- **The rule.** A benchmark place whose `matchedShare` is under 0.99 is not stopped. As bar 8 says, its building mask is
  unreliable there, so:
  - it is left out of bars 1 and 5 (the building);
  - it is counted in bars 2, 3, 4 and 7 (the regions and the raw scan).

  The measure and the 0.99 stay as amendment 1 left them. The on-scan measure proposed while the dry runs were made (the
  share over the part of the isolate that lies on the scan) is withdrawn and was never applied.
- **The record, from the dry runs on the fresh builds.** "On-scan" is the share over the part of the isolate within 3 cm
  of the scan. "Standing" and "ground" split the isolate's area by the ground band.

  | Place | K run | `matchedShare` (area) | By count | On-scan | Standing | Ground | Cause |
  |---|---|---|---|---|---|---|---|
  | ESB | 0bb20154 | 0.996 | 0.967 | 0.999 | 0.999 | 0.936 | - (passes) |
  | Haughwout Building | f4f25a8e | 0.875 | 0.880 | 0.992 | 0.896 | 0.698 | tile_refine's closure geometry: 471 m² of the isolate's 3,957 m² (365 standing, 106 ground) is not in the scan |
  | Ferry Building | cdbda9bb | 0.862 | 0.824 | 0.986 | 0.903 | 0.635 | the same: 396 m² of 3,071 m² (247 standing, 149 ground) is not in the scan |
  | Griffith Observatory | d04c4274 | 0.871 | 0.789 | 0.890 | 0.995 | 0.705 | ground triangles straddling the isolate's edge: the isolate holds 13,288 m² of ground-level terraces, and large tile ground triangles across its edge have their centroids outside it (the masks label those triangles ground either way); only 713 m² of 32,599 m² is off the scan |

- **What is left for the building bars.** Bars 1 and 5 now rest on the ESB and Penn 2.
  - Bar 5's "all but one judged place" then means one of two places. The bar is not changed; the report states it.
  - The three places still count in bars 2, 3, 4 and 7.
- **The Ferry Building's target is part of the building.** K isolated a 428 m² Google footprint at the geocoded point,
  the central pavilion. The clock tower rising from it and the long wings are neighbours there, and the report says so.
- **Griffith Observatory.** It has three judged views (14 panos near the place, one used by the build and excluded).
  That is within the draft's minimum: a place is indicative only below three.
- **The other dry-run checks passed at all three places.**
  - Every arm and decoy rendered at every view, with no empty render and no arm without triangles.
  - The raw scan's frame agreement is 1.00 in every view.
  - X1's standing triangles are labelled target: 100% at the Haughwout and the Ferry Building, 99.98% at Griffith.
  - No arm was lifted, and no frame mismatched.
- **Unchanged.** No bar, arm, decoy, place, view or pose changed.

**Amendment 4, 2026-10-31, before any paid call: Penn 2's geocode test is that the geocode lies on Penn 2's own
footprint** (the user's decision: "Keep Penn 2").
- **The change.** In "The target at Penn 2, and its fallback", the condition "The geocode is off" (`2 Penn Plaza, New
  York` geocodes more than about 50 m from 7th Ave and W 32nd St) is replaced by: the geocode lies on the target's own
  Google footprint. The other conditions stay:
  - Penn 2 has a footprint of its own;
  - the target does not grow into Madison Square Garden or the station.
- **The evidence, from K run 1ef02345.**
  - The geocode is 68.3 m from the corner. The 50 m was a proxy, set for the draft, for the wrong building being picked.
  - The run chose footprint 17/38596/49262/f46 "because it covers the geocoded point". It is 5,593 m², and its IoU with
    the scan's structure is 0.92.
  - K's isolate stops about 100 m west of 7th Ave, short of the middle of the block.

  So the geocode lies on Penn 2's own footprint, and the checks for a wrong building pass.
- **The record.** The fallback was never applied. 11 Penn Plaza's K build, started under it, is kept aside and not
  judged. Every Penn 2 arm is built with `2 Penn Plaza, New York`, and K's arm is run 1ef02345.
- **Unchanged.** No bar, arm, decoy, view, pose or other place changed.

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
  - On a fresh build the isolate and the reference tile are one extraction, so `matchedShare` should be 1.00. (Wrong as a
    count: see the amendment. By area it is 0.996 on fresh run 0bb20154.)
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
| Penn Station at 32nd: Penn 2 | `2 Penn Plaza, New York` | district (bar 6) and judge calibration | The user's place for every district test (2026-10-31): Penn Station at 7th Ave and W 32nd St, Manhattan, with Penn 2 as the target. Penn 2 stands on the west side of 7th Ave, where W 32nd St ends at its facade. The 250 m radius reaches Macy's at 34th to 35th St. **The query text was confirmed by the user on 2026-10-31.** |
| Fallback: 11 Penn Plaza | `11 Penn Plaza, New York` | as above, only if the fallback is taken | The building on the east side of 7th Ave between W 31st and W 32nd St, at the same corner, where the user's map line ended. See "The target at Penn 2, and its fallback". |
| Empire State Building | `Empire State Building, New York` | judge calibration | dense, tall |
| Haughwout Building | `Haughwout Building, 488 Broadway, New York` | judge calibration | low-rise street |
| Bryant Park | `Bryant Park, New York` | - | **left out** (the user, 2026-10-31): no structure at the place (see below) |
| Ferry Building | `Ferry Building, San Francisco` | judge calibration | waterfront, plaza |
| Dolores Park | `Dolores Park, San Francisco` | - | **left out** (the user, 2026-10-31): no structure at the place |
| Griffith Observatory | `Griffith Observatory, Los Angeles` | judge calibration | hillside, horizon |

- **Views at the benchmark places: four per place.** They are held out and registered, and the tool chooses them:
  - Google-captured panos that no arm's build used, aimed at the target;
  - kept when the target fills at least 6% of the frame and at least 30% of it is unhidden;
  - registered by edges to at most 5 px, and the nearest four that lock are used.
- **The parks: left out of this run** (the user's decision, 2026-10-31). At a park the structure rule finds nothing
  within 30 m of the place. A later run could judge them with the open-place view rule, now merged on `feat/m1-run`, or
  query a building on the park's edge.

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
  geocoded point). **Amended 2026-10-31 (amendment 4):** the geocode does not lie on the target's own Google footprint.
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
    - `regions.target.matchedShare` under 0.99 (**amended 2026-10-31, amendment 3:** not a stop; the place is left out of
      bars 1 and 5, as bar 8 says);
    - X1's building agreement under 0.9 (a check of the outline labelling; 1.00 in every view of the ESB dry run on
      run 7f594cd6). **Amended 2026-10-31 (amendment 2):** the share of X1's standing triangles labelled target under
      0.99; the building agreement per view is kept as information;
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
  - **Kept in** (the user's decision, 2026-10-31): no `excludePanoIds` are given for them.
  - No earlier comparison is known at Penn 2.
- **The stand-in dry run** on run 7f594cd6 (2026-10-31) judged nothing real.

## Step 2: the free dry run (before any paid call)

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
  - **KD's time (measured).** On the k-d branch, a kd district at Union Square with the same plan (250 m, 120 m cells,
    20 chunks round the centre) took 86 minutes from its start to its last chunk's end (run 75354746, 2026-10-30). Its
    chunks took 4 to 19 minutes each, 3 at a time. Shibuya at 350 m was 44 chunks in about 106 minutes.
- **Decoys and dry runs.** Free.

### Price

Every figure below is labelled:
- **measured:** from the app's own records;
- **price page:** from Google's published price;
- **estimated.**

Prices are in US dollars and were read on 2026-10-31.

**Sources.**
- Vertex AI generative AI pricing, <https://cloud.google.com/vertex-ai/generative-ai/pricing>, which now serves
  <https://cloud.google.com/model-garden/pricing>. The page shows no update date.
- Google Maps Platform core services pricing list, <https://developers.google.com/maps/billing-and-pricing/pricing>,
  last updated 2026-10-30.
- Map Tiles API usage and billing, <https://developers.google.com/maps/documentation/tile/usage-and-billing>, last
  updated 2026-10-30.

#### The judge: 144 calls

**What the code calls.**
- **Model:** `gemini-4-argon` (`PHOTO_MATCH_DEFAULT_JUDGE`), through `VisionModelChain`. The fallbacks
  (`gemini-3.8-flash` and older) cost less.
- **Endpoint:** Vertex AI, with the app's service account (`GeminiClient.getGenAIClient` prefers it), at the `global`
  location (`VERTEX_LOCATION`).
- **Thinking.** The judge asks for a 24,576-token budget. Gemini 4 takes a level instead, so the budget becomes
  `thinkingLevel: HIGH` (`thinking-config.ts`). It is not a token cap, and the call sets no `maxOutputTokens`.
- **Other settings:** temperature 1 and a JSON reply. A reply that does not parse is asked once more.

**Price (price page).** Gemini 4 Argon on the global endpoint costs, per million tokens:

| Period | Input (text, image) | Output (response and reasoning) |
|---|---|---|
| Through 2026-11-30 | $2.00 | $10.00 |
| From 2026-12-01 | $4.00 | $20.00 |

The page gives the lower price as a promotion paid as 50% credits back on net spend, so an invoice may show the list price
before the credit.

**Tokens per call.**
- **Images (measured).** Each image is billed a fixed number of tokens, whatever its size:
  - 1,064 tokens in 27 `gemini-4-argon` replies of ESB run 7f594cd6 (the staged vision-reply cache);
  - 1,089 tokens each in 109 replies on the k-d branch (1 to 6 images per call, exact multiples).

  The figures below use 1,089.
  - A benchmark-place call (the photo and 4 renders) is 5,445 image tokens.
  - A Penn 2 call (the photo and 7 renders) is 8,712.
- **Prompt text (estimated).** The prompts are built by the tool's own functions and counted offline at about 4
  characters a token: about 760 tokens textured (2,970 to 3,027 characters with the region criteria) and about 400
  clay (1,504 to 1,561).
- **Reply (estimated).** About 75 tokens per render textured and about 37 clay: 150 to 520 a call.
- **Thinking (estimated).**
  - **Low:** 2,000 tokens.
  - **High:** 24,576 tokens, the budget the judge names, used as the planning bound.

  No judge call at HIGH has been made, so neither figure is measured.

**Per call, through 2026-11-30** (twice this from 2026-12-01):

| Call | Input tokens | Output tokens (low to high) | Price (low to high) |
|---|---|---|---|
| Benchmark place, textured | 6,205 | 2,300 to 24,876 | $0.035 to $0.26 |
| Benchmark place, clay | 5,845 | 2,150 to 24,726 | $0.033 to $0.26 |
| Penn 2, textured | 9,472 | 2,520 to 25,096 | $0.044 to $0.27 |
| Penn 2, clay | 9,112 | 2,260 to 24,836 | $0.041 to $0.27 |

**In all, 144 calls** (96 at the benchmark places, 48 at Penn 2, half of each textured):
- **$5.33 to $37.84** through 2026-11-30;
- **$10.66 to $75.68** from 2026-12-01.

**Outside that range.**
- A retried reply is one more call at the same price, and the spend cap counts it.
- On HIGH, thinking is not bounded at 24,576 tokens. The price page notes Gemini 4 completions can run to 1 million
  tokens. A call that thinks past the bound costs $0.01 more per 1,000 tokens.

#### The builds: 8, or 9 with the fallback

All builds run on this Mac. KD's chunks build in local worker threads (`runChunk` is `runStagedLocationOffThread` on
`feat/m1-run`; there is no cloud chunk job in that code). So no build pays for compute; what they pay for is Google's APIs.

- **K, 5 builds (6 with the fallback): about $1.20 each (measured, at the ESB).** On run 7f594cd6, every vision reply
  in its build window (17:19 to 17:27, 387 in the vision-reply cache) was:
  - **360 calls on `gemini-3.8-flash`:** 550,333 input and 121,970 output tokens, $0.87. Most of them are the facade
    reader: 351 calls reading 120 planes, its maximum. Flash costs $0.75 / $3.75 per million (price page, introductory
    through 2026-12-31).
  - **27 calls on `gemini-4-argon`:** 49,312 input and 23,324 output tokens, $0.33 ($0.66 from 2026-12-01).

  The ESB is the largest building here, so the other places should cost less.
  - **Material choice** adds one call per build, with two sheets of patches (estimated under $0.02).
  - **Measuring library tile sizes** is one Flash call per set not yet measured, done once and kept (estimated at most
    $1 in all).
- **KD: $2.99 (measured, at Union Square on the k-d branch).**
  - **What was recorded:** in run 75354746's window, 87 `gemini-4-argon` calls, 504,216 input and 198,238 output
    tokens ($5.98 from 2026-12-01).
  - **What may be missing:** no Flash calls were recorded, so its chunks may not have run the facade reader, or ran it
    outside the reply cache. If every chunk reads its planes as the ESB build did, the 20 chunks add up to $17.40.
  - **High: $20.39.**
- **DM and DS: $0 to $3 each (estimated).** These district builds were not measured. The high is KD's measured cost.
- **Street View survey images in K: up to 16 per K build (`MAX_STREET_VIEW_IMAGES_PER_BUILDING`).** That is 80 to 96
  images through the Imagery Grounding API, fetched again because the caches are cleared before each build.
- **3D Tiles (price page).** Only a root tileset request is billed: $6.00 per 1,000 after 1,000 free a month. Tile
  requests within its three-hour session are not billed. Each extraction opens about one session (estimated). That
  is about 30 with KD's 21 extractions, so under 50 in all: under $0.30, and nothing if the month stays within the
  free 1,000.
- **Street View metadata:** free (price page).

#### Street View grounding: the judge's up to 50 images

The Imagery Grounding API (`retrieveGroundingImage`) needs an allowlisted project and is not on the Maps Platform price
list. Its price is estimated:
- at Static Street View's $7.00 per 1,000 (price page): $0.35 for the judge's 50, or $0.91 to $1.02 with the builds'
  survey images;
- at Dynamic Street View's $14.00 per 1,000: $2.04 for all 146.

#### Total

| Part | Low | High | Label |
|---|---|---|---|
| Judge, 144 calls | $5.33 | $37.84 | price page × estimated tokens (images measured) |
| K, 5 to 6 builds | $6.00 | $7.32 | measured at the ESB |
| KD | $2.99 | $20.39 | measured at Union Square; high estimated |
| DM and DS | $0 | $6.00 | estimated |
| Library sizes, once | $0 | $1.00 | estimated |
| Street View grounding, 130 to 146 images | $0.91 | $2.04 | estimated (no published price) |
| 3D Tiles root requests | $0 | $0.30 | price page × estimated count |
| **All** | **about $15** | **about $75** | |

- **Through 2026-11-30: about $15 to $75.** This is **under the $100 the user set on 2026-10-31** for spending that
  needs no approval.
- **From 2026-12-01, when Gemini 4 Argon's price doubles: about $25 to $124.** The high end is over $100.
- **The parks, if added later:** about $1.20 each for the K build, plus their judge calls.
- **Approved.** The user approved the run on 2026-10-31. It is made by 2026-11-30, while the judge's price is
  $2 / $10 per million.

## Report

After the single paid run:
- Fill one row per bar with each arm's value and spread, each decoy's value, and met or missed. For bar 6, give one row
  per pair.
- Say which target was used at Penn 2 (Penn 2 or 11 Penn Plaza) and why, and any pose swap.
- Give the poses on their own, with the table of what each arm shows there.
- Give the two decisions named in the question.
- Attach the grids and mask grids.

### Run record

Values the procedure above fills in, written as they are fixed. Each is written before the step that uses it.

- **The corner of 7th Ave and W 32nd St** (poses A and B, `lat`/`lng`): 40.7497146, -73.9915593. This is the Google
  Geocoding API's intersection result for "7th Ave & W 32nd St, New York, NY" (type `intersection`, geometric centre),
  read on 2026-10-31 before any build at Penn 2.
- **The app the arms are built and judged in.** `feat/m1-run`, from its worktree, on its own launch entry
  `scratchbox-m1-run` (web 3620, API 3621, tools 3622), with `SCRATCHBOX_STAGED_DISTRICT` unset (`env -u`). The builds
  and the paid run go through the app's own tool endpoint (`/gemini/tools/run-stream`, the node graph's tool runner).
  The stage caches are those of that worktree (`.scratchbox/cache`). Before each place's builds they are moved aside,
  so nothing is reused, and the server is restarted. Each place's cache is put back only to judge that place.
- **Penn 2's target checks, on K run 1ef02345** (fresh, every stage a cache miss). The fallback is taken.
  - **The geocode is off.** `2 Penn Plaza, New York` resolved to 2 Pennsylvania Plaza at 40.750316, -73.991722. That is
    68.3 m from the corner of 7th Ave and W 32nd St (66.9 m north, 13.7 m west), past the 50 m in "The target at
    Penn 2, and its fallback". That alone takes the fallback.
  - **The footprint.** Google's vector footprint, 5,593 m², with an IoU of 0.92 against the scan's structure. Its 7th Ave
    frontage runs at x ≈ 7 to 10 m in the run's frame, and it reaches about 95 m west of the avenue.
  - **K's isolate.** It spans x −88 to 15 m and z −22 to 100 m (about 103 by 122 m in plan), with a top at 143 m, in
    37,219 triangles. It reaches about 100 m west of 7th Ave, short of the middle of the block.
  - **The rest of the build.** The structure stands 75.8 m from the geocoded point. The build is degraded:
    - 2.2% through holes;
    - the survey read 13 of 16 faces, and two images timed out.
  - **Superseded by amendment 4 (the user kept Penn 2): the fallback was not applied.** Every Penn 2 arm is built with
    `2 Penn Plaza, New York`, and K's arm is run 1ef02345. The text below was the record before that decision.
  - **So every arm runs at `11 Penn Plaza, New York`** (K, then DM, DS and KD), with its own building as the target. The
    views stay at the corner: poses A and B keep their position and headings, and the automatic views aim at 11 Penn
    Plaza. Under the fallback, pose A shows Penn 2 as a neighbour. K run 1ef02345 is kept aside and not judged.
- **The pose headings** (measured before the dry run, from DM's reference tile, run 0ced0b89). DM's vector stage holds
  building footprints but no road lines, so the second source in "Views at Penn 2" is used: Penn 2's 7th Ave facade line
  in the tile.
  - **How it was measured.** Take the scanned wall triangles within 45 m of the corner on the avenue's west side: 4 to
    40 m above the ground, near vertical, facing east of north-south. Their dominant plane is the 233 triangles (3,062 m²)
    within 20° of the median normal.
  - **The result.** The plane's area-weighted normal bearing is 118.98°, so the avenue bears 28.98° uptown. A line fitted
    through the same triangles agrees at 28.5°.
  - **Pose A** (Penn 2's facade): `headingDeg` 299.0. **Pose B** (uptown): `headingDeg` 29.0. Both use the corner above,
    `pitchDeg` 12 and `fovDeg` 80.
- **DM and DS are one build at Penn 2.**
  - DM (run 0ced0b89) asked for `district: 'massing'`, but its massing pass rebuilt 0 of 8 buildings, each for "the
    footprint runs past the extraction". The 524-leaf cap stopped the scan at 81 m (`radius_truncated`).
  - DS (run 5d29b92d, `district: 'scan'`) hit every stage in DM's cache, and its visible layers are the same files:
    the remeshed scan within 81 m, Google's vector buildings beyond, and the trees.
  - For bar 6 the DM-DS pair compares identical builds, so it can only read "the judge cannot tell". It also gives a
    check of the judge's noise on two identical images in one blind call.
- **KD's first attempt failed on disk space.** Run 85d60523 ran for 61 minutes and joined 19 of its 20 chunks.
  - **The failure.** Chunk 20 failed with `ENOSPC: no space left on device`: the Mac's disk was full, 320 MB free of
    1.8 TB, with every session on it writing. The run recorded `chunk_failed` and `chunks_failed`, and one vector-outer
    layer (l0o) was still showing. Both are KD stop rules.
  - **The cause.** It was the disk, not anything in KD's own pipeline.
  - **What was removed.** With the user's approval, only what that run alone wrote went to the Trash
    (`~/.Trash/m1-kd-85d60523-failed`): 214 entries, 23.42 GB.
    - 21 tile_refine entries (11.22 GB);
    - 21 tiles entries (0.86 GB);
    - 20 remesh records;
    - 77 chunk GLBs in district-chunks (5.7 GB);
    - 74 published chunk GLBs (4.8 GB).

    No kept run (K 1ef02345, DM 0ced0b89, DS 5d29b92d) referenced any of them. The run's record, timeline and logs are
    kept.
  - **The rebuild.** KD is rebuilt fresh from `feat/m1-run` once at least 30 GB is free, on a server restarted with
    `SCRATCHBOX_CACHE_RESTORE=off`, so no stage comes back from the Cloud Storage bucket. No bar changes.
