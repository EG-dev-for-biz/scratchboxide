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

- **The ESB's paid call on the fixed judge**: eval `empire_state_building_20_w_34th__20261101T070440_fd3a`. Images are
  in `docs/screenshots/m1_prereg/esb_paid_fixed/`. The server was restarted on 108e37fb with the ESB's cache at the
  build-time path and `SCRATCHBOX_CACHE_RESTORE=off`.
  - **Views.** 8 fetched (amendment 7's list), 5 registered, 4 judged. No eye under the street.
    - Judged: VqOxFz9R (2024-09, 83 m), w4nU8TkI (90 m), uPcMge9M (92 m), hi-cmKU8 (127 m), the last three 2026-04.
    - Not registered: G8sOFZp8 (12 to 6.4 px), QcCvIfC8 and Q1IjAWuz (12 to 12 px).
    These are the same views as the first ESB call.
  - **The view checks, by code.**
    - The tile ends inside the frame in v1 (10.1%), v2 (5.2%) and v3 (4.7%). These are the three views the first run
      listed by hand.
    - v3 also holds no ground.
    - So bars 2 to 4 rest on v0, as before, and bars 1 and 5 on all four views.
  - **Bars.**

    | Bar | Views | Value | Result |
    |---|---|---|---|
    | 1 | 4 | mean runSd 0.35 (raw 0.47, K 0.35, X1 0.12, X2 0.47) | met |
    | 2 | v0 | ground 0.00, neighbours 0.35, skyline 0.76 | met |
    | 3 | v0 | ground: K 5.00, X1 3.00, gap 2.00; neighbours: K 6.33, X1 3.00, gap 3.33 | met |
    | 4 | v0 | X1 agreement: ground 0.02, neighbours 0.00 | met |
    | 5 (placement) | 4 | errorPx raw 3.64, K 5.34, X2 14.03; X2 − K 8.70, D 4.5 | met |
    | 7 | 4 | 1.00 in every view | met |
    | 8 | - | `matchedShare` 0.996 | met |

  - **Placement per view** (errorPx; the best shift in brackets):

    | View | raw | K | X2 |
    |---|---|---|---|
    | v0 | 3.62 | 8.16 [-5, -7] | 19.00 [36, -40] |
    | v1 | 3.27 | 5.54 [0, 1] | 12.14 [0, -7] |
    | v2 | 3.70 | 3.60 [1, 2] | 11.48 [-10, -1] |
    | v3 | 3.95 | 4.05 [1, 4] | 13.51 [-11, 24] |

    X2 stands 6.9 to 10.8 px further from the photo's silhouette than K in every view. The raw scan sits 3.3 to 4.0 px
    from it: the registration's residual and the photo's edges.
  - **The judge, deciding nothing.** On the building, K against X2 scores:
    - overall 4.75 against 4.00 (gap 0.75);
    - shape 5.67 against 4.75 (gap 0.92);
    - clay shape 5.33 against 4.33 (gap 1.00).

    The raw scan's overall is 6.75. The judge still barely sees the 4 m move; the edges do.
  - **Cost.** Judge: 24 calls, all answered by `gemini-4-argon`: 141,989 tokens in, 4,592 out and 31,100 thinking; $0.64.
    Grounding: 8 images, about $0.06. No 403, spend-cap or failed call.
  - **No stop rule fired.** The run goes on to the Haughwout Building.

- **The era check at the Ferry Building** (amendment 7's method). The 8 views the paid call will fetch were fetched
  through the app, and each was set beside the tile at its stand-in pose. Pairs are in
  `docs/screenshots/m1_prereg/era_check/ferry/`. **All 8 are kept.** Every photo shows the building the tile holds: the
  arcade along the Embarcadero, the clock tower, the bays and the massing.

  | View | Photo date | Distance from the origin | Kept, and why |
  |---|---|---|---|
  | ZR9VHLtY h53 | 2026-09 | 32 m | kept: the same arched bays and entrance as the tile |
  | tDezGI3E h104 | 2025-05 | 142 m | kept: the arcade and tower behind the palms, as in the tile |
  | XL-oDO4u h334 | 2026-09 | 112 m | kept: the tower and the north arcade; a construction fence at the right where the tile has market tents (temporary) |
  | 4sXa5k8s h121 | 2026-09 | 62 m | kept: the tower and the arcade's corner, as in the tile |
  | nF68xO_p h61 | 2025-05 | 102 m | kept: the arcade across the plaza; a palm trunk in front in both |
  | dl-5J1q- h28 | 2025-05 | 137 m | kept: the tower over the plaza and its spheres, as in the tile |
  | z6iR0rUI h14 | 2026-09 | 50 m | kept: the tower and the main facade; market tents in the tile only (temporary) |
  | GOgaHhj9 h133 | 2026-09 | 118 m | kept: the tower up the Embarcadero, as in the tile |

- **The era check at the Haughwout Building.** Of its 8 views:
  - **5 show the building the tile holds:** the cast-iron arcades and the corner clock. The storefront signs differ.
    These are Q9Oq9D-1 h18, 1qMtd3bC h109, iqiqiEgp h183, dXtEY_Zc h63 and AHxVmFrj h105, all 2026-04.
  - **3 do not show the building at all:** EZhhT_bT h256 (80 m), ChWZuxgr h343 (72 m) and 3rYZd7kq h298 (56 m).
    - Each pano stands past the tile's edge, its eye at the structure's base.
    - Each photo is filled by a building a few metres from the camera that the tile does not hold: a cast-iron
      storefront, a brick wall with murals, a glass front. The tile at the same pose shows the Haughwout down the street.
    - With no target in the photo, its era cannot be read. These views are dropped and swapped by amendment 7's method:
      the dry run is made again with them excluded, and the new views are fetched and checked before the paid call.
- **The Haughwout's swaps** (pairs in `docs/screenshots/m1_prereg/era_check/haughwout/`, the final list in
  `views_final.json`). Three rounds of the free dry run with the dropped panos in `excludePanoIds`.

  | Round | Excluded | New views | Outcome |
  |---|---|---|---|
  | 1 | the 3 above | hN4AIglX h334 (38 m), 3bPztYzZ h313 (77 m), bEK_FLEJ h269 (67 m) | hN4AIglX kept: the same cast-iron street as the tile. 3bPztYzZ and bEK_FLEJ dropped: a glass corner building and a cast-iron storefront a few metres from the camera, which the tile does not hold |
  | 2 | 5 | uHC_00kK h319 (58 m), wDMyXU2L h286 (58 m) | uHC_00kK kept: the same street of cast-iron and glass fronts. wDMyXU2L dropped: a glass storefront at the camera |
  | 3 | 6 | omuGS9re h359 (30 m) | kept: the arcaded cast-iron facade and the shop beside it, as in the tile |

  - **The paid call's list.** It fetches Q9Oq9D-1, 1qMtd3bC, iqiqiEgp, uHC_00kK, dXtEY_Zc, AHxVmFrj, hN4AIglX and omuGS9re
    (all 2026-04). All 8 show the building the tile holds, and all are kept.
  - **The six dropped panos** are passed as `excludePanoIds`: EZhhT_bT, ChWZuxgr, 3rYZd7kq, 3bPztYzZ, bEK_FLEJ and
    wDMyXU2L.
  - **Why they all failed.** Every dropped pano stood past the tile's edge, where the tool's candidate check sees the
    target through the empty space the tile leaves.
  - **Photos fetched for the check:** 14 (8 + 3 + 2 + 1), about $0.10.
  - **Placement on the final list (stand-ins):** mean errorPx raw 3.85, K 12.16, X2 19.88, a gap of 7.72. Half of it,
    3.9, is under the preregistered D of 6.3, so D stays 6.3.

## Report

After the last place:
- each place's views kept, dropped or swapped;
- the results against each bar;
- the cost per place and in all.
