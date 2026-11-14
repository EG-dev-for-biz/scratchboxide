# District twin: plan (scan-first)

Date: 2026-11-13. Status: plan; a scratch trial has run (below), nothing is in the app. Depends on PR #189 (the
measured procedural twin) landing first.
Background: [the twin system](2026-11-13-twin-system-concept.md), [the hybrid twin plan](2026-11-08-hybrid-twin-plan.md).

## Method: scan-first (user decision, 2026-11-13)

**The scan is the district. A building becomes a twin only when a declared shot comes close to it.**

This replaces the first version of this plan, which twinned every building (three tiers, every building "near" with no
model calls when no shot was declared). The trial below is why: a district of twins looks much like the scan, because
the twin's walls carry the scan's own photo, at twice the size and with the roofs lost; and the raw scan has scored
above every rebuild judged so far (ESB: scan 6.67, hybrid twin 5.00, pipeline K 4.55). The twin earns its place close
up, where the scan's walls look melted and the twin has flat walls and real recessed windows. That is a few buildings
a shot, not a district.

1. **Every building starts as its scan,** on the district's remeshed ground, streets and trees (K-D's ground cells).
   With no shot declared the district is the scan and nothing is twinned: no model calls.
2. **A building is twinned when a shot is close to it.** The rule is a number, never a name for what the building is:
   its largest on-screen size over the declared shots (`sb.shot`) passes a threshold. Those buildings get the hybrid
   twin (pipeline K's detail stages on the building's wall photos, then the shell): real window readings, about 10-16
   model calls each.
3. **A twin keeps the scan's roof and street level.** The two places the twin has looked worst in every test stay as
   scanned: the scan's own surface above the parapet line and for the lowest storeys. The twin's shell is used for the
   walls between.
4. **One run.** One request builds the whole district: plan, ground cells, cut each chosen building's scan out of its
   cell by its footprint, build the twins in parallel, join. No building gets an extraction of its own.

## Goal

A district that reads as the real place at any distance: the scan where it reads well, and clean, windowed twins for
the buildings a shot comes close to. The user judges districts by eye from a labelled sheet; there is no judge
preregistration for this.

## What already exists and is reused unchanged

| Need | Existing piece |
|---|---|
| Cutting a district into work units without cutting a building | K-D's chunk plan (`pipeline-k/district-chunks.ts`): 120 m cells, each building wholly in one cell |
| Ground, streets, trees, and the scan of every building not twinned | K-D's ground cells (`KD_GROUND_CELL_STEPS`) and the seam stage (`district-seams.ts`) |
| Cutting a layer by a keep rule and placing it in the district's frame | `joinChunkGlb`, `cutChunkLayer` |
| One building's twin | `buildMeasuredTwin` (PR #189), hybrid mode |
| Which buildings a shot is close to | the shot plan (`scratchbox/shot_plan.py`) and the shot detail budget (`common/spatial/shot-detail-budget.ts`) |
| Keeping each building between runs | the scene object store (`building/<Google vector feature id>`, versioned) and the place store |
| Measuring what a district leaves incomplete | the district completeness audit, per building |

## Design decisions

1. **The unit is the building.** A twin is read from its own cut-out scan, so neighbours cannot leak into its tiers
   or window readings.
2. **The scan is the fallback at every step.** A building whose twin fails, or whose twin measures worse than its scan
   in the completeness audit, is shown as its scan, with the reason in its object's extras.
3. **The ground stays the scan's.** A twin stands on the cell's remeshed ground, at a street level taken from that
   ground just outside its footprint (not guessed per building: the trial's first run hung shells below the street).
4. **The shell is held to the footprint.** A twin is kept inside its Google vector footprint grown by K-D's
   `buildingReachM` (1 m); nothing is added past it or above the scan's height.
5. **The cut is by each triangle's middle.** A building's scan is removed from the ground layer whole when it is
   twinned, so no scrap of it stays inside the twin (the trial's cut left scraps).
6. **Buildings win over trees.** A planted crown that would enter a twin's volume is clipped, moved or shrunk.
7. **A twin matches its neighbours' exposure.** The hybrid's exposure gain is fitted against the scan around the
   building, so a twin does not stand brighter or darker than the scanned buildings beside it.
8. **Every part keeps its label.** Massing measured; windows photo-inferred (generated where continued); reveal depth
   generated unless read; the kept roof and street level measured.

## Known problems the plan has to solve

| Problem | Where it shows | Plan |
|---|---|---|
| Street-level podiums and entrances come out as coarse blocks | every twin so far (ESB, Penn 2) | the scan's surface kept for the lowest storeys (method 3) |
| Roofs drawn as one colour, roof plant lost | the trial's large roof | the scan's surface kept above the parapet line (method 3) |
| A cut scan renders with scrambled triangles where the cut was | the Penn trial's run 2; the ESB layered trial | the cut functions (`hideFootprintInGlb`, `joinChunkGlb`) leave primitives whose index list is empty, and the path tracer draws such a primitive as if it had no index list (its vertices in order). Dropping the empty primitives after the cut removes it. To be fixed where it is made, not worked round |
| Twins heavier than the scan | the trial: 44.7 MB against 23.5 MB for nine | few twins a district now; JPEG atlases for those |
| Overlapping window readings dropped | Penn 2: 543 of 2,954 | merge readings per wall before the generator (the structure intent's wall lattices); only if the sheets show gaps |
| The twin's base is open underneath | judge renders at Penn 2 | closed by the kept street-level scan |

## Stages and budget (cold, per district, one run)

| # | Stage | Time | Calls |
|---|---|---|---|
| 0 | Plan: cells, buildings, and which buildings a declared shot is close to | seconds | 0 |
| 1 | Ground cells: extraction, remesh, ground, streets, trees, every building's scan (K-D's, unchanged) | as K-D today | as K-D today |
| 2 | Cut each chosen building's scan out of its cell by its footprint | seconds a building | 0 |
| 3 | Hybrid twin of each chosen building, in parallel; the scan's roof and street level kept | 5-8 min a building | about 10-16 a building |
| 4 | Join in the district frame; completeness audit; the scan kept where the twin measures worse | as K-D today | 0 |
| 5 | Object store and place store sync | as K-D today | 0 |

With no shot declared, stages 2 and 3 do nothing and the district is K-D's ground cells with every building scanned.

## Work items, in order

1. **Land PR #189.** The twin's code is not on main.
2. **Which buildings a shot is close to.** From the declared shots, each building's largest on-screen size; the
   threshold a parameter. Done when a Penn district plan lists every building with its size in each shot and whether
   it is twinned.
3. **The twin keeps the scan's roof and street level.** The scan's surface above the parapet line and for the lowest
   storeys, joined to the shell without a step. Done when Penn 2's entrance and one large roof read as the scan does.
4. **One run at Penn with one or two close shots.** A `district: 'twin'` mode beside `kd`: ground cells, the chosen
   buildings cut by footprint (by triangle middles) and twinned, joined, audited. Done when an uncached run shows the
   scanned district with the chosen buildings as twins, no scrap, gap or overlap at their feet.
5. **Exposure against the neighbours.** Done when a twin and the scanned building beside it read alike in a top-down
   render.
6. **Store.** Each twin a `building/<feature id>` version with its audit measures, current only when no measure is
   worse than the scan's.
7. **Proof sheet.** The same shots three ways on one labelled sheet: scan only, K-D, scan with twins. The close shots
   are the ones that matter; with per-mode triangle count, file size, build time and model calls.

Each item is tested on the cached Penn tiles, with the touched tests and the typecheck only (no full suite on this
machine), and a fast visual check before it is called done.

## Settled

- Scan-first: twins only for buildings a declared shot is close to; nothing twinned with no shot (2026-11-13;
  supersedes "every building near tier").
- The whole district in one run (2026-11-13).

## Left to my recommendation (user, 2026-11-13: "whatever you recommend")

- **The threshold** for twinning a building is set from the proof sheet: start at a building filling a third of the
  frame's height in a shot, and move it only on what the sheet shows.
- **The proof runs at two places.** The district sheet stays at Penn (the district test place), judged by eye against
  the tile's own era, since current Street View shows Penn 2 reclad. The close-shot check of a twin against real
  photos is made at the Empire State Building, whose photos match its tile and whose hybrid twin has already been
  judged there.

## The trial behind this decision (2026-11-13): every building twinned, the Penn district in one run

The runs below twinned every building, the plan's first version. They are kept as the evidence for scan-first.

### Run 1

A scratch driver (not committed) ran the whole plan's shape on the cached Penn tile (the 121 m extraction of run
e124077c, 265,000 triangles) and Google's footprints cached for the same anchor: plan, cut each building's scan by its
footprint with `joinChunkGlb`, the K-free twin of each in a pool of 4, merge with the ground. No model calls.

| Measure | Value |
|---|---|
| Buildings planned (middle within 115 m, footprint 80 m2 or more) | 9 of 289 in the footprint file |
| Twins built / failed | 9 / 0 |
| Time | 29 s in all: cut 17 s, twins 11 s (the largest 11 s, the rest 2-4 s), join under 1 s |
| Windows placed | 0 on every building |
| Size | 55 MB, against the scan's 23.5 MB |

What the renders show (scan beside twin, four views):

- **It works end to end and is fast.** The district reads as the same place from an oblique view; the tower and the
  mid-rises stand where the scan's do, with flat walls and sharp corners.
- **No windows.** The K-free self-read found none on any wall at this tile's photo resolution. So the near tier, as it
  is, gives massing and colour only here. Windows need K's readings or the hybrid's, which is what the plan called hero.
- **Shells hang below the street.** With the street level left to each twin ("ground auto") several took a level far
  below the tile's ground, and their walls run down past it as grey blocks. The ground level must come from the
  district's ground at each footprint, not be guessed per building.
- **Roofs and round or glazed buildings lose their look.** The arena became a plain drum and its roof flat stripes; the
  glass building's wall detail became vertical smears. The storey-median wall detail suits a regular masonry tower and
  not these.
- **It is heavier, not lighter.** Each twin carries its own detail atlas. A district needs one shared atlas, or JPEG
  atlases, before the size claim in the goal can hold.
- **Only buildings whose middle lies in the radius were twinned.** The rest stayed as scan in the ground layer, and the
  ground was not cut cleanly around the twins.


### Second run, the same day: street level from the district, windows from the wall photos

Two changes in the scratch driver, still with no model calls:

- **Street level.** Each building's level is the low end (20th percentile) of the district's up-facing surfaces within
  4 m outside its footprint. Every twin now stands at 4.4-6.1 m, the district's ground; none hangs below it.
- **Windows.** Two passes per building, as the twin's inferred mode does: the first writes each wall's own photo, then
  pipeline K's window fit and window arrays run on those photos, then the second pass builds from them.

| Measure | Run 1 | Run 2 |
|---|---|---|
| Twins built / failed | 9 / 0 | 8 / 1 (kept as scan) |
| Windows placed | 0 | 1,226, on 3 buildings (1,057 on the Penn 2 block, 150 and 19 on two others) |
| Time | 29 s | 100 s (the Penn 2 block 59 s, the rest 4-10 s each) |
| Size | 55 MB | 65 MB |

What the renders show:

- **Better at distance.** No shells below the street; the glazed mid-rise reads as a window grid again and the arena
  no longer becomes a plain drum.
- **Worse close up.** The second pass leaves large stray triangles across the tower's face and broken geometry round
  the podium that run 1 did not have. The cause is not yet found (the second pass turns on the pier-depth and
  turned-band parameters, measured here from a coarse district scan; that is the first suspect).
- **Five buildings still have no windows.** Their walls are split by setback tier into small pieces (a few metres
  tall), too small for the window fit or the array to read a pattern. Reading each wall whole, across its tiers, is
  the fix, not a model call.
- **One building failed** in the inference step (an empty class list) and was left as scan, as designed.
- **Still heavier than the scan.**

### The stray triangles, found (same day)

They were not the twin generator's. Every twin's geometry is clean (no slanted surface in any of them). They came
from the one building whose second pass failed: the driver merged that building's raw scan cut-out into the district,
and rendering the district without that one file removed every stray triangle. (The cut-out was not scrambled by the
merge, as first written here: the later ESB trial found the real cause, the empty primitives a cut leaves, which the
path tracer draws without their index list.)

The driver now steps down one rung instead: a building whose second pass fails keeps its first-pass twin (no windows),
and no raw cut-out is merged. Run 4: 9 twins (one on its first pass), 1,226 windows, 34 s, 44.7 MB, no stray
triangles in any view.

Still open after run 4:

- **The ground layer holds scraps of the buildings.** The cut keeps a scan triangle when any corner lies outside the
  footprints, so pieces of each building's scan stay in the ground, hidden inside the twins. A cut by each triangle's
  middle is needed before anything is shown.
- **Roofs.** One large roof is drawn as a single dark colour where the scan shows its plant; the glazed mid-rise's
  top storeys are bleached.
- **Five buildings have no windows** (walls split by tier into pieces too small to read).
- **Size:** 44.7 MB against the scan's 23.5 MB.
- **This tile is not at leaf detail across the district** (wall photos come out at 0.15 m a pixel), so the window
  results here understate what a leaf-detail extraction would give.

What the trial says about the approach: from the views rendered, the district twin looks much like the scan, because
its walls carry the scan's own photo. It is cleaner at the edges and stands on true levels, and it costs twice the
size and the roofs. On this evidence a district of twins is not yet an improvement over the scan at district distance.


## The layered combination, tried at the Empire State Building (2026-11-13)

The method above, composed once from cached files with no model calls: the ESB district's scan (run 493d1ee7's tile),
pipeline K's colour steps on it, the ESB's scan cut out by its Google footprint (`hideFootprintInGlb`), and the hybrid
twin that was judged on 2026-11-08 placed in its stead.

| Layer | What ran | Result |
|---|---|---|
| 1. The scan | the tile as extracted | 20 MB |
| 2. Colour | roof-shadow lift and photo harmonising on the whole district (`correctedScanTexture`) | 50 s; 16,405 m2 of roof and terrace shadow lifted on 147 photos; seams 0.381 to 0.327; 30 MB |
| 3. The twin | 76,201 scan triangles of the ESB removed, the street under it kept; the twin merged in | under 1 s; 60 MB |

By eye, from four rendered views (scan, scan with colour, layered):

- **The shaft is better as the twin.** Straight piers and even bays where the scan's walls waver; it sits in the
  scanned district with no gap or step at its foot.
- **The crown is worse as the twin.** Loose fins and fragments at the foot of the mast, and the observation level is
  blurrier than the scan's. This is the case for method 3 (the twin keeps the scan's roof).
- **The colour layer is a small change** at these views: shadowed roofs read a little lighter. It does no harm.
- **Three times the scan's size** for one building twinned.

On the way, the cause of the "stray triangles" in both trials was found and is not what the Penn section first said:
it is the empty primitives a cut leaves (see the table of known problems). At Penn the twins were clean all along, and
the ground layer's "scraps" seen there were the same fault.

## One building at full detail (2026-11-13)

Penn 2's twin rebuilt from its own full-detail pipeline K reading (run e124077c: wall photos at 0.07-0.08 m a pixel)
with the hybrid's texture settings (an 8192 atlas at 0.07 m, roof cells from the scan's photo seen from above, pier
strips), and swapped into the Penn district in place of the twin made from the district tile.

| | Twin from the district tile | Twin from Penn 2's own reading |
|---|---|---|
| Wall photo | 0.15 m a texel | 0.07 m a texel |
| Windows placed | 1,057 | 1,463 |
| Roof | one colour | 2,083 cells from the scan's photo |
| Triangles / size | 107,000 / 15 MB | 298,000 / 41 MB |
| Model calls | 0 | 0 (K's readings were cached) |

By eye, from matching path-traced views: close up, the fine twin shows single windows with their sashes and mullions
and recessed glass, where the coarse one shows blurred blocks; this is the largest gain seen in any trial today, and it
comes from the source resolution. Not better, or worse: the roof cells read as large pale blotches rather than roof
plant; the top storeys are blocky in both; the pier strips add bright white bands and piers low on one wall whose
rounded ends look like an artefact; and the upper wall's window grid is less even than the coarse twin's.

## Procedural shells for every building, roads removed (user's idea, tried 2026-11-13)

The idea: smooth each building with procedural geometry in its own scanned shape, carve and emboss the detail, texture
it from the photogrammetry, and remove the roads and everything on them.

What ran, on the cached Penn tile with no model calls: every building with a footprint of 40 m2 or more whose middle
lies in the tile (14 buildings, 43,981 m2 of footprint) cut out by its footprint and rebuilt by the twin generator:
tier prisms from its height map, recessed windows where its wall photos gave them (K's window fit and arrays), swept
ledges, roof blocks, relief blocks standing 0.3 m or more off the shell, roof cells and wall detail from the scan's
photo. No ground layer was kept, so the roads, vehicles and street clutter are gone.

| Measure | Value |
|---|---|
| Buildings built / failed | 14 / 0 (one on its first pass) |
| Time | 6 min (cut 52 s, shells 5 min in a pool of 4) |
| Windows carved | 1,972, on 4 buildings |
| Size | 86 MB, against the scan's 23.5 MB |
| Plan overlap with the scan (shell against its cut-out, 1 m cells) | 0.73 for the district; 0.87-0.97 on ten buildings, 0.42 on the worst |
| Roof heights within 1 m of the scan | 66 % of the shared plan (within 3 m: 89 %) |

By eye, from matching path-traced views:

- **It can be done for box-like buildings.** The two large towers come out with flat walls, sharp corners and the
  scan's own photo on them, standing where the scan's do, and the streets are gone.
- **Not "exactly the same shape".** The shells are prisms of each setback tier with squared outlines. Round or
  irregular buildings lose their shape: the arena becomes a fan of flat wedges (plan overlap 0.42), and the station's
  glazed entrance and low podium become plain grey boxes with no texture.
- **Texture is limited by the tile.** Small faces and billboards come out as coarse blocks; the slab's top storeys are
  bleached.
- **No bevel.** The generator has no chamfer or bevel setting. Carving (recessed windows) and embossing (ledges, roof
  blocks, relief blocks) exist; bevelled edges would have to be added (pipeline K's lattice has a 5 cm chamfer rule
  that could be reused).
- **Buildings whose middle lies past the tile are missing,** and with no ground the district floats.

A fault found on the way, in the twin generator (PR #189): it adds the street level twice. Given a street level g, the
shell's base comes out at 2g and its top g too high (tested on one building at g = 0, 5.5 and 11 m). At Penn every
shell today sat about 5 m too high; at the ESB the level is near zero, which hid it. For this trial each shell was
lowered by its street level afterwards. It needs fixing in the generator.

## What this plan does not claim

- The twin has been judged on one building (the ESB). Nothing yet says a district of twins beats K-D or the scan.
- Penn 2, the district's target, cannot be checked against Street View: the photos show it reclad and the tile does
  not. The proof is by eye against the tile's own era.
- Times and call counts above are from single-building runs (ESB hybrid, Penn 2 from K records), not from a district.
