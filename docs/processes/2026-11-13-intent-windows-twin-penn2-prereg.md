# Preregistration: the procedural twin with the structure intent's windows, at Penn 2

Date: 2026-11-13. Status: **written before any paid call.** Nothing below changes after this line except the run record
and the report. Branch `feat/building-line-drawing` (PR #226) at fe77db8a; the twin generator is PR #189's
(`measured-twin/2`, untracked in this worktree).

## Question

Does the measured procedural twin of Penn 2 look more like the real building when its windows are the structure
intent's (the windows read, plus those the intent infers from each face's lattice) than with pipeline K's window
readings alone, judged blind against held-out Street View photos?

- **Met (bars 1-2):** the intent's windows improve a build where K's reading is sparse; the next step is an adapter
  from the intent to the twin's window input, put to MAIN as class 1.
- **Missed, or the judge cannot tell:** the intent stays a drawing and material-map tool (class 2); no adapter.

## Arms

All in the frame of the Penn Station extraction (anchor 40.750316, -73.991722, ellipsoidal height -26.664 m; tile
`tiles/2476fd70…/textured_tile_seams_3.glb`, run e124077c in the `agent-abd470f80513bb72b` worktree's cache), each drawn
as the target in its street (`scope: target`).

| id | Build |
|---|---|
| raw | the raw scan cut to the target (`baseline: true`) |
| A | the measured twin of run e124077c from its K records (K's window fit: 1,661 windows given, 1,463 placed) |
| B | the same spec with every `win` line replaced by the structure intent's windows on the same planes (structure-intent/5: 1,754 measured, 1,188 pattern, 12 repeat; 2,954 given, 2,077 placed) |

Both twins were generated today by the same binary from the same scan and photos; they differ only in the windows.
Labels shown to the judge are neutral.

## Places and views

- **Place:** Penn 2 (2 Pennsylvania Plaza, New York) only: the one cached building where the intent changed the
  windows materially. Named to the judge by its address.
- **Views:** up to 4, held out, chosen by the tool from the cached Street View metadata in the free dry run, then
  pinned for the paid call (`autoViews: false`, the dry run's `heldOut.judgedPoses`).
- **Era:** MAIN put Penn 2's views on hold on 2026-11-01 because the tiles and the photos show the station entrance
  from different years. Both arms carry the same tile-era photo texture, so an era difference costs both the same and
  the comparison between them stands; absolute scores here mean little. Each judged photo is checked against the tile
  before any score is read: a view whose photo shows a different facade than the tile is dropped and said so.

## Bars

Means over the judged views, each view's score the mean of its runs. Building criteria only.

| # | Metric | Bar | A miss means |
|---|---|---|---|
| 1 | Clay shape, B against A | B ≥ A + the larger of their run spreads | the intent's windows do not read as better geometry |
| 2 | Overall (textured), B against A | B ≥ A | the intent's windows make the build look less like the building |
| V1 | Judge spread (mean per-view run spread, overall and clay shape) | ≤ 0.75 for A and B | the judge is too noisy to separate the arms |
| V2 | Placement, decoy X2 against B (`placement.mean.errorPx`) | X2 ≥ B + D, D = half of X2 − B in the dry run, at least 2 px | placement cannot rank a 4 m move |
| V3 | Materials, B against decoy X3 | B ≥ X3 + 1.0 | the judge cannot see texture |

Reported, deciding nothing: materials, detail, errors, realism, identity, SSIM, edge chamfer, CIEDE2000, the raw scan.

## Decoys

| id | How | Must lose by |
|---|---|---|
| X2 | B with every vertex moved 4 m east (positions baked) | V2 |
| X3 | B with its texture and normal map removed and one flat colour (the texture's mean) | V3 |

## Stop rules

- A decoy that passes (V2 or V3 missed): the judge cannot answer; report, conclude nothing.
- V1 missed, or the B − A gap within the larger of their spreads: "the judge cannot tell".
- Fewer than 3 judged views after the era check: indicative only.
- Spend cap $10; stop on any 403 or spend-cap error.
- A render that fails or is empty at any pinned pose: stop before the paid call and fix the render.

## Exposure

Neither twin used Street View. Run e124077c's records are passed as the reference, so any pano its K build used is
excluded by the tool. No earlier comparison judged these twins.

## Cost, estimated

4 views x 3 runs x 2 (clay) = 24 judge calls with 5 renders each, about $0.05-0.10 a call: **about $1.50 to $3**, plus
4 Street View photos (about $0.03). Under the $10 cap and the user's $100 (no approval needed).

## Order

1. Commit this.
2. Free dry run (`photo-match-dryrun.test.ts`, stand-ins at the billed edges, credentials unreachable).
3. Pin the poses and D in the run record below; commit.
4. One paid call with every arm and decoy.
5. Report against the bars with the grid image.

## Run record

## Report
