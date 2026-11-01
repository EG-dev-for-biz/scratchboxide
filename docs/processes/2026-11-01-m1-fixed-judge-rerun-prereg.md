# Preregistration: the M1 judge rerun on the fixed judge, at the benchmark places

Date: 2026-11-01. Status: **written before any paid call of this rerun.** Nothing below changes after this line except
the run record and the report.

**The decision it follows.** The user's answer after the ESB's stop, relayed by the main session: "Fix judge,
re-prereg". The instructions were:
- fix the judge's defects;
- write a new short preregistration, keeping everything else the same;
- run the free dry run at all four places before any paid call;
- rerun the ESB, then judge the Haughwout Building, the Ferry Building and Griffith Observatory, each era-checked first
  by amendment 7's method;
- keep Penn 2 out.

Everything not named here is as in
[the first preregistration](./2026-10-31-m1-two-modes-prereg.md) (approved 2026-10-31), with its amendments 1 to 7.

## Why

The first run stopped twice on "A decoy that passes" (its report, "The result: stopped at the ESB").

- **At Penn 2**, X1 was not 2.0 below K on the ground. The photo and the tiles showed the station's entrance from
  different eras.
- **At the ESB**, X2 (K moved 4 m) was not 1.0 below K on the building. The grids showed four defects in the judge or
  its views:
  - **a region scored where the view does not show it:** v3 holds no ground, yet every arm's ground scored 5;
  - **a view with a wrong camera:** v1 (w4nU8T). The first report called its eye under the street. It is not. Its pano
    stands past the tile's edge, so its eye fell back to the building's base: 2.13 m, which is 0.83 m over the street
    (1.30 m, 6 m away). What looked like the street seen from below is the tile's cut edge and the empty space under it;
  - **the tile ending inside the frame:** listed by hand, after the bars had been printed;
  - **a vision score that cannot see a 4 m move** at 83 to 127 m.

## What changed: the judge, commit 0c7cdb13

The commit is on `feat/m1-world-judge`, and `feat/m1-run` is fast-forwarded to it. Each check is made by code before
any score is read.

1. **Regions outside the frame.** The judge is asked only about the ground, the neighbours and the skyline where that
   region holds at least 1% of the frame in the reference's masks (`regionsInFrame`).
   - Otherwise the region's score is null, and no mean or bar reads it (`views[].judgedRegions`, `regionsLeftOut`).
   - A view that shows all three regions is asked in the same words as before, byte for byte.
2. **A camera under the street.** A view whose registered eye stands below the street is not used, whatever its edge
   residual (`eyeUnderStreet`).
   - The street is the terrain at the pano, else the lowest surface there, else the nearest terrain round it within
     25 m.
   - This check does not catch the ESB's v1, whose eye is above the street; check 3 flags that view.
3. **The tile ending inside the frame.** A view is flagged when at least 1% of the frame is past the tile's edge
   (`tileEdgeInFrame`, `views[].tileEdge`, `viewChecks.tileEdgeFlagged`).
   - A pixel counts as past the edge when the reference labels it sky and its ray leaves the tile lower than the tile's
     surfaces stand within 20 m of where it leaves.
   - A flagged view's regions are not asked of the judge, and it is left out of the region means, so it is out of
     bars 2 to 4.
   - Its building is judged as before, so it stays in bars 1 and 5.
4. **Placement measured from edges, not by the judge** (`targetPlacement`, `views[].placement`, `placement.mean`).
   - **The photo's silhouette of the target:** its structural edges within 8 px of the scan's target outline, at the
     registered pose, at 640 px wide.
   - **Each build:** drawn alone from the same pose.
   - **`errorPx`:** the mean distance from that silhouette to the build's outline, truncated at 24 px. It grows with a
     move and with a wrong shape.
   - **Beside it:** the best image shift within 40 px, and the error left there.
   - **Which views count:** the mean is over the views where the target fills at least 6% of the frame.

The dry-run driver's pano filter now uses the app's own Google-capture check (`isGoogleCapture`). Its `/Google/` match
also took "From a Google User" photospheres, which the real lookup and the grounding API refuse.

## What stays the same

- **Arms:** raw (the scan cut to the target), K, X1 (K's GLBs as a whole place) and X2 (K moved 4 m along +x).
- **Builds:** the fresh K runs already built and dry-run. No build is rebuilt, and none uses the K session's work (a
  later, separate comparison).

  | Place | K run |
  |---|---|
  | ESB | 0bb20154 |
  | Haughwout | f4f25a8e |
  | Ferry | cdbda9bb |
  | Griffith | d04c4274 |

- **Views:** 4 per place, chosen by the tool, 8 fetched.
- **Judging:** 3 runs per view, clay on, `judgeRegions` on, trees on, the baseline on.
- **The tool's arguments:** each place's `*_args.json` as in the first run.
- **Bars 1, 2, 3, 4, 7 and 8:** as written in the first preregistration. Bars 2 to 4 read only the views and regions the
  checks above leave in. A bar that no view can test at a place is reported as untested, not as met.
- **Stop rules:** as written.
  - A decoy that passes (bars 3 to 5 miss at a place) stops the run there.
  - A place with fewer than 3 judged views is indicative only and kept out of bars 3 and 5.
  - Stop on any 403 or spend-cap error, or cost past $60.
- **The tile-edge listing by hand** is replaced by check 3.
- **Spend so far:** about $1.44 (Penn 2 $0.62, the ESB $0.82).
- **Penn 2:** out of this run. Its redo with era-matched views is a separate preregistration.

## Bar 5, replaced

| # | Metric | Bar | A miss means |
|---|---|---|---|
| 5 | Decoy X2 against K, `placement.mean[arm].errorPx` over the bar-5 views | X2's mean is at least **D** higher than K's, at all but one judged place | the placement measure cannot rank a 4 m misplacement; stop at that place |

- **The bar-5 views** are the judged views where the target fills at least 6% of the frame and both K and X2 have a
  placement. Views flagged for the tile's edge stay in.
- **D per place** is half the X2 − K gap in the free stand-in dry run on the fixed judge, and at least 2 px. The table
  below gives it, set before any paid call.
- **No view to test it.** A place with no bar-5 view cannot test bar 5, and is reported so.
- **The judge's own X2 numbers** (overall, shape, clay shape) are still reported, and decide nothing.

## The free dry run on the fixed judge (2026-11-01)

**How it ran.** The run used the real pano lookup (Street View metadata, no charge). Every billed step was a stand-in:
- the photo was the reference tile rendered from the view;
- registration was the identity;
- the judge returned a constant.

It ran with the fixed code on m1-run's caches, each place's cache at its build-time path, the server stopped. Images and
reports are in `docs/screenshots/m1_prereg/<place>_dryrun_fixed/` (gitignored).

| Place | Fetch list | Views judged (stand-in) | Flagged for the tile's edge | Eye under the street | Placement, mean errorPx (raw / K / X2) | X2 − K per view | D |
|---|---|---|---|---|---|---|---|
| ESB | the same 8 as the first run and amendment 7 | 4 | v3 (w4nU8T, 10.7% past the edge) | none | 2.2 / 7.6 / 16.6 | 9.3, 8.2, 11.2, 7.4 | **4.5** |
| Haughwout | 8 new | 4 (3 with a placement) | v2 (13.2%), v3 (10.4%) | none | 2.8 / 5.9 / 18.5 | 6.8, 12.6, 18.6 | **6.3** |
| Ferry | 8 new | 4 | none | none | 2.6 / 6.2 / 14.8 | 12.1, 8.1, 11.2, 2.9 | **4.3** |
| Griffith | none | **0: no held-out view** | - | - | - | - | - |

- **Every render drew** at every pose, for every arm.
- **The raw scan's frame agreement** was 1.00 in every view.
- **No regions were left out wrongly.**
  - The ESB's v1 (Q1IjAW) asks the ground alone: neighbours and skyline hold under 1% of it.
  - The Ferry's v0 asks the ground and skyline; its v2 asks the neighbours and skyline.
- **Griffith Observatory is not judged.** Of the panos near its structure, the real lookup finds no Google capture. The
  metadata holds user photospheres only ("© From a Google User" and private names, 505 of them).
  - The first dry run's 3 Griffith views were such photospheres, which the old driver filter let through. The paid call
    would fail with `no_heldout_candidates` before anything is billed.
  - So it falls below its minimum views. As the main session said, it is reported, not judged.
- **Haughwout's eyes.** 8 of its 20 candidates stand past the tile's edge, so their eyes fall back to the structure's
  base, as the ESB's v1 did. Check 3 flags such a view's regions, and its building is still judged.

## Era check

**The method** is amendment 7's:
- fetch every view the paid call will fetch;
- set each photo beside the tile at its pose;
- compare the target's structure, not its lettering or signs;
- drop or swap any view from another era.

**The ESB:** its fetch list is unchanged, so amendment 7's check stands: all 8 kept.

**Haughwout and the Ferry:** checked before their paid calls. Each outcome is written into the run record and committed
before that place's call. A place that falls below 3 judgeable views is reported, not judged.

## Cost

| Item | Estimate |
|---|---|
| Judge, per place | 24 calls, about $0.65 (the ESB's, measured) |
| Grounding, per place | 8 images, about $0.06 |
| Era check, Haughwout and Ferry | 16 images, about $0.11 |
| **Three places in all** | **about $2.3** |
| **With the spend so far** | **about $3.7, against the $60 stop** |

## Order

1. The ESB.
2. Haughwout.
3. The Ferry Building.

At each place: put its cache at the build-time path, restart the server, era-check (Haughwout and the Ferry), commit the
outcome, make the paid call, then record and commit.

## Run record

Values written as they are fixed.

## Report

After the last place:
- each place's views kept, dropped or swapped;
- the results against each bar;
- the cost per place and in all.
