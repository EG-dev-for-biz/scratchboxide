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
- **A rule this preregistration carried over without saying so: amendment 3.** "Everything else the same" keeps amendment
  3. A place whose `matchedShare` is under 0.99 stays out of bars 1 and 5 (the building) and counts in bars 2, 3, 4 and 7.
  - The Haughwout (0.875) and the Ferry Building (0.862) are such places. Their bar-5 D values above should have said
    so.
  - Their placement and building numbers are reported as information. Bar 5 rests on the ESB.
- **The Haughwout's paid call**: eval `e_v_haughwout_building_488_broad_20261101T071808_fff2`, on a server restarted
  with its cache at the build-time path. Images are in `docs/screenshots/m1_prereg/haughwout_paid_fixed/`.
  - **Views.** 8 fetched (the swapped list), 5 registered, 4 judged. No eye under the street.
    - Judged: hN4AIglX (37 m), dXtEY_Zc (39 m), iqiqiEgp (43 m) and uHC_00kK (57 m), all 2026-04. Their edge residuals
      went from 12 px to 1.2 to 4.6 px.
    - Not registered: Q9Oq9D-1, AHxVmFrj and omuGS9re (12 to 12 px).
  - **The tile ends inside every judged frame:** 11.3%, 11.8%, 9.9% and 22.0%. The mask grids bear it out: the photos
    show buildings down Broadway and Broome St where the masks show sky. So no region was asked of the judge, and bars 2
    to 4 are untested at the Haughwout.
  - **Bars.**

    | Bar | Value | Result |
    |---|---|---|
    | 1 | mean runSd 0.41 (raw 0.53, K 0.44, X1 0.35, X2 0.32) | met; out of the bars by amendment 3 |
    | 2, 3, 4 | no view within the tile | untested |
    | 5 (placement) | errorPx raw 3.67, K 8.47, X2 15.80; X2 − K 7.34 (D 6.3) | met; out of the bars by amendment 3 |
    | 7 | 1.00 in every view | met |
    | 8 | `matchedShare` 0.875 | missed, as in the dry run (amendment 3) |

    Placement per view (errorPx, raw / K / X2): hN4AIglX 3.44 / 11.66 / 17.49; dXtEY_Zc 3.84 / 4.86 / 13.06;
    iqiqiEgp 3.72 / 6.93 / 16.64; uHC_00kK 3.69 / 10.42 / 16.02. X2 is above K in every view, by 5.6 to 9.7 px.
  - **The judge, information only.** Overall: raw 3.92, K 3.50, X1 2.75, X2 2.67. Clay shape: raw 5.83, K 4.33,
    X2 3.50.
  - **Cost.** Judge: 24 calls, all `gemini-4-argon`: 142,738 tokens in, 4,222 out and 31,257 thinking; $0.64.
    Grounding: 8 images, about $0.06. No 403 or failed call.
  - **No stop rule fired.** Bars 3 and 4 are untested, not missed, and bar 5 is out by amendment 3. On to the Ferry
    Building.
- **The Ferry Building's paid call**: eval `1_ferry_building_san_francisco_c_20261101T073009_632f`, on a server
  restarted with its cache at the build-time path. Images are in `docs/screenshots/m1_prereg/ferry_paid_fixed/`.
  - **Views.** 8 fetched (all 8 kept by the era check), 8 registered, the nearest 4 judged. No eye under the street, and
    no view where the tile ends inside the frame (the most is 0.9%, in v2).
    - Judged: ZR9VHLtY (22 m), z6iR0rUI (44 m), 4sXa5k8s (57 m), all 2026-09; and nF68xO_p (92 m, 2025-05).
    - Edge residuals went from 12 px to 0.9 to 2.2 px.
  - **Regions.** v2 holds no ground, so it was not asked about the ground. Every other region was judged in every
    view.
  - **Bars.**

    | Bar | Views | Value | Result |
    |---|---|---|---|
    | 1 | 4 | mean runSd 0.49 (raw 0.53, K 0.47, X1 0.47, X2 0.47) | met; out of the bars by amendment 3 |
    | 2 | 3 / 4 / 4 | ground 0.24, neighbours 0.35, skyline 0.40 | met |
    | 3 | 3 / 4 | ground: K 3.89, X1 1.22, gap 2.67; neighbours: K 5.66, X1 3.25, gap 2.41 | met |
    | 4 | 3 / 4 | X1 agreement: ground 0.01, neighbours 0.00 | met |
    | 5 (placement) | 4 | errorPx raw 2.91, K 6.47, X2 15.67; X2 − K 9.20 (D 4.3) | met; out of the bars by amendment 3 |
    | 7 | 4 | 1.00 in every view | met |
    | 8 | - | `matchedShare` 0.862 | missed, as in the dry run (amendment 3) |

    Placement per view (errorPx, raw / K / X2): ZR9VHLtY 2.74 / 6.84 / 18.90; z6iR0rUI 3.16 / 6.06 / 16.81;
    4sXa5k8s 1.99 / 8.18 / 15.96; nF68xO_p 3.74 / 4.82 / 11.01. X2 is above K in every view, by 6.2 to 12.1 px.
  - **The judge, information only.** Overall: raw 5.33, K 4.09, X2 3.50, X1 2.25. Clay shape: raw 4.83, K 3.59,
    X2 2.75.
  - **Cost.** Judge: 24 calls, all `gemini-4-argon`: 143,057 tokens in, 4,870 out and 31,957 thinking; $0.65.
    Grounding: 8 images, about $0.06. No 403 or failed call.
  - **No stop rule fired.** This was the last place. Griffith Observatory is not judged (see the dry run).
  - **After the run.** The Ferry's cache is the one at m1-run's build-time path. The ESB's and the Haughwout's are under
    `places/esb/cache` and `places/haughwout/cache`.

### The result (2026-11-01)

**Every counted bar is met at every place it can be read, and no stop rule fired.**

| Place | Judged views | Views for bars 2 to 4 | Bar 1 | Bars 2, 3, 4 | Bar 5 (placement, X2 − K / D) | Bar 7 | Bar 8 |
|---|---|---|---|---|---|---|---|
| ESB | 4 | v0 (the tile ends inside v1 to v3) | 0.35, met | met | 8.70 / 4.5, met | met | 0.996, met |
| Haughwout | 4 | none (the tile ends inside all 4) | 0.41, information | untested | 7.34 / 6.3, information | met | 0.875, missed (amendment 3) |
| Ferry Building | 4 | all 4 (the ground in 3) | 0.49, information | met | 9.20 / 4.3, information | met | 0.862, missed (amendment 3) |
| Griffith Observatory | 0 | - | - | not judged: no Google-captured pano near it | - | - | - |

- **Against the bars, the M1 exit is met.**
  - The judge repeats itself within its spread (bars 1 and 2).
  - X1, the hero with no street round it, loses at least 2.4 on the ground and the neighbours wherever they can be read
    (bars 3 and 4: the ESB and the Ferry).
  - X2, moved 4 m, is ranked lower by placement measured from edges. At the ESB, where it counts, it is 8.7 px further
    from the photo's silhouette than K. At the two places where it counts only as information, it is 7.3 and 9.2 px
    further.
- **The limits of that result.** These are why the evidence is thin:
  - The building bars rest on one place, the ESB. Penn 2 is out of this run, and amendment 3 keeps the Haughwout and the
    Ferry out.
  - The region bars rest on one view at the ESB and on the Ferry. At the Haughwout the tile ends inside every view.
  - Griffith Observatory has no held-out view.
  - The vision judge still scores X2 only 0.6 to 0.8 below K overall. Bar 5 is met because it now reads edges, not
    the judge.
- **M2's neighbours** are not part of this run. Penn 2's redo is a separate preregistration.
- **What the run showed about the views.** Panos past the tile's edge give wrong eyes and photos without the target.
  - At the Haughwout, 6 of its candidates were such views. The era check caught them and they were swapped.
  - At the ESB, v1 was such a view. The tile-edge check flagged it.
  - The tool's candidate check uses the tile to test whether the target is hidden. Past the edge, the tile holds
    nothing near the camera, so the check passes them. That is a follow-up for the view selection, not a rule of this
    run.
- **After the run: the view selection is fixed** (the user's "Yes, fix it here", 2026-11-01; the commit after this one).
  - **The change.** A pano with no ground under it (neither the tile's terrain nor a surface within 1.5 m) stands past
    the reference tile's edge, and is no longer a candidate. A fixed pose there was already refused. Before, it was kept
    with its eye 2.5 m over the structure's base.
  - **What it changes, in free dry runs on the same caches.**
    - **The ESB:** w4nU8T, hi-cmKU8 and Wf4-XFAA are no longer candidates. These are v1 and v3 of both paid ESB calls.
      AGFKaBOw, lui1N8rP and p88-CBpq take their places in the fetch list, and no dry-run view is flagged for the tile's
      edge.
    - **The Haughwout:** its 8 such candidates go, the 6 dropped here among them. VVmGDj2p, 4rnMoRUG and nygqgDGF come
      in.
  - **Nothing above is redone.** The results stand as run. A later run on this code era-checks its own new views.
- **Cost of this rerun.**

  | Place | Judge | Grounding | Era-check photos | Total |
  |---|---|---|---|---|
  | ESB | $0.64 | about $0.06 | none (amendment 7's) | about $0.70 |
  | Haughwout | $0.64 | about $0.06 | 14 (8, then 6 for the swaps), about $0.10 | about $0.80 |
  | Ferry | $0.65 | about $0.06 | 8, about $0.06 | about $0.77 |

  The rerun cost about $2.26: judge $1.94, 46 photos about $0.32. With the first run's $1.44, the total is about $3.70,
  against the $60 stop.

## Report

After the last place:
- each place's views kept, dropped or swapped;
- the results against each bar;
- the cost per place and in all.
