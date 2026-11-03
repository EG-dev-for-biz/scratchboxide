# Preregistration: the street-level splat world against the mesh district at Penn 2

Date: 2026-10-31. Status: **approved by the user on 2026-10-31** (this draft as first written). Nothing below changes after
this line except the report and the run record. The user's answer, word for word: "Approve draft" (the choice offered:
"Approve the splat-vs-mesh preregistration as drafted, including its cost (about $5 to $22)."). Nothing is built or paid
for until:
- the M1 report (`docs/processes/2026-10-31-m1-two-modes-prereg.md`, PR 5) is committed, because its fresh Penn 2 runs
  are this comparison's mesh arms and its session is the one writer of `photo-match-evaluate.ts` until then;
- the splat arm hook is merged on its own branch (cut from `feat/m1-judge-kd`, or from `main` once PR 5 merges), and the
  free dry run below passes.

The method is `.claude/skills/judge-preregister/SKILL.md`. The judge is `photo_match_evaluate`
(`docs/processes/photo_match_world_regions.md`). A splat world is drawn by `renderSplatArm`
(`staged-location/splat-arm-render.ts`, native `scratchbox_splat_raster.hpp`). It uses the viewer's EWA projection and
the judge's neutral light, clay and background. Its coverage agrees with the app's own splat mesh in headless Chrome at
IoU 0.994, 0.979 and 0.987 in three 7th Ave views. One splat's peak opacity is within 1% and its footprint covariance
within 3% of the viewer's `projectSplatEwa`.

## Question

At Penn 2 (7th Ave and W 32nd St), does the street-level splat world read more like the real place, from the street,
than today's mesh district modes? Judged blind against held-out Street View photos, per region.

- **If the splat world beats every mesh arm** on the whole frame, the ground or the neighbours (bar 5), it becomes the
  candidate for M2's street-level presentation. Its next work goes first: the era-mismatched wall on Penn Plaza and the
  folded parked cars.
- **If one mesh arm beats it on every region** (bar 5), splat development pauses and that mesh arm leads.
- **Otherwise**, report the regions each side wins, and where the judge cannot tell. Nothing changes until the user
  decides.

## Arms

| Id | Label | Build | Scope | Frame |
|---|---|---|---|---|
| DM | District, massing neighbours | M1's fresh Penn 2 run, its GLBs as M1 passes them | place (named first: the reference) | DM's |
| DS | District, cleaned-scan neighbours | M1's fresh Penn 2 run | place | DM's |
| KD | District, kd neighbours | M1's fresh Penn 2 run | place | DM's |
| K | Pipeline K, Penn 2 alone | M1's fresh Penn 2 run | target | DM's |
| SW | The street-level splat world | built fresh and uncached on the hook branch: `location_generate_3dgs` with the chat's arguments, `{ location: "7th Avenue & West 32nd Street, New York", vantageSideDeg: 270, vantageHeadingDeg: 90 }` | place | its own extraction, moved into DM's (below) |
| raw | The raw scan cut to the target | `baseline` (on) | target | DM's |

- **SW is built fresh.** Clear the stage caches, Street View plates and station splats in its output folder, and the
  world cache's local copy, then restart the server. No cloud copy is fetched: the request carries `refresh: true`.
- **SW's frame.** Its splats are in the frame of its own extraction, anchored at the snapped vantage. The hook moves them
  into DM's frame by their anchors' east, north and up offset (`LocalTangentPlane`; the two tangent planes differ by
  under 1e-5 radians over 100 m).
  - The offset is recorded as `offsetM`.
  - The dry run checks that SW's street meets DM's tile street at the poses within 0.3 m (stop rules).
- **The mesh arms are not rebuilt.** They are M1's own runs, so both comparisons see the same builds.

## Places and views

One place: Penn 2, with the target DM picks (or M1's fallback, 11 Penn Plaza, if M1 used it). Eight views, the tool's
maximum, in one call.

- **Four fixed poses** from the corner M1 uses (40.7497146, -73.9915593), all `pitchDeg: 12` and `fovDeg: 80`, with
  headings from the avenue's bearing as M1 measures it:
  - **A**, Penn 2's facade: bearing + 270 (about 299°);
  - **B**, uptown: bearing (about 29°);
  - **C**, across the avenue to W 32nd St: bearing + 90 (about 119°);
  - **D**, downtown: bearing + 180 (about 209°).
- **Four automatic views**, chosen by the tool's own rules.
- **Pose swaps, by M1's rule.** SW used the corner's nearest pano (`feKTMhN8YAZUGcqdatV7rw`), so every pose takes the
  next nearest unused pano on 7th Ave with its heading. The swap is made by naming it as `panoId`, before the paid run.
- **SW's reach.** The splat world covers a 150 m square round its vantage, and colours only what its stations saw. A view
  where SW covers less than half of what DM covers (coverage of at least 0.5, counted over the frame) is outside SW's
  reach. It is reported on its own, and kept out of bar 5 for SW. This is fixed now, before any render.

## Bars

"Spread" is the judge's run spread (`runSd`) as the tool reports it. "Judged views" are the views that lock (at most 5 px).

| # | Metric | Mask | Bar | Direction | A miss means |
|---|---|---|---|---|---|
| 1 | Judge run spread, SW and its decoys | whole frame (overall) | mean runSd at most 0.75 | lower | the judge is not repeatable on a splat world; nothing below decides |
| 2 | Decoy Y1 against SW | whole frame and building (overall) | at least 1.0 lower than SW's at all but one judged view | lower for Y1 | registration does not cost points; stop |
| 3 | Decoy Y2 against SW | whole frame (judge materials) | mean at least 2.0 lower than SW's | lower for Y2 | the judge does not see the splats' colour; stop |
| 4 | Decoy Y3 against SW | ground (judge region score, and `agreement` at most 0.3) | at least 2.0 lower than SW's | lower for Y3 | the judge or the masks do not see a missing street; stop |
| 5 | SW against each mesh arm (DM, DS, KD; K on the building only) | whole frame, building, ground, neighbours, skyline | the pair's gap (difference of means over the judged views within SW's reach) is wider than both arms' spread, and has the same sign at 6 or more of 8 views (three quarters with fewer, indicative only under 6) | either | the judge cannot tell that pair apart on that region |
| 6 | raw | whole frame (`agreement`) | exactly 1.00 at every view | equal | the reference or the cut is broken; stop |

- **Secondary, deciding nothing:** SSIM, edge chamfer and CIEDE2000 per region for every arm, and the clay scores
  (shape only). SW's clay is the scan it was built on, drawn as surfels.
- **Bar 5's chance level** is the one M1 gives: a 6-of-8 split one way happens by chance about 29% of the time. The gap
  wider than both spreads is what makes it a difference.

## Decoys

All three are made locally from SW's own file, at no cost, and judged blind in the same call.

- **Y1, SW moved:** every splat translated 4 m along +x. It must lose on the whole frame and the building (bar 2).
- **Y2, SW in one colour:** every splat set to the world's mean colour, its geometry kept. It must lose on materials
  (bar 3) and keep its clay scores.
- **Y3, SW without its street:** every splat labelled ground removed. Labels are each splat's nearest labelled
  triangle of DM's tile, within 0.5 m (`labelSplats`). It must lose on the ground (bar 4).

## Stop rules

- **Spend cap:** 48 judge calls (8 views × 3 runs × textured and clay), 16 Street View grounding images for the judge
  (8 in the run, 8 for pose swaps), and SW's one fresh build. Anything past that stops the run.
- **A decoy that passes:** if bar 2, 3 or 4 misses, stop, and fix the judge or the views, not the build.
- **Spread wider than the gap:** if bar 5 misses for a pair and region, report "the judge cannot tell" there, not a
  winner.
- **The dry run, before any paid call.** Stop if any of these shows:
  - an empty or black render, or an arm with nothing drawn;
  - `frame_mismatch`, or SW's `offsetM` over 200 m (the wrong extraction);
  - SW's street more than 0.3 m from DM's tile street at any fixed pose;
  - a pano SW used among the held-out views;
  - more than 2% of SW's splats without a triangle within 0.5 m (it was 0.9% against its own scan).
- **The poses.** Review the four swapped pose photos with `screenshot-review` before any judge call. Each must show what
  its pose names (A: Penn 2's facade; B: uptown; C: W 32nd St across the avenue; D: downtown). A pose that does not
  register is reported as missing, and an automatic view takes its slot, as in M1.

## Exposure

- **Panos SW's build uses** go in `excludePanoIds`, because a splat arm is not a staged run and the tool cannot read
  its records. The last build used 6: `feKTMhN8YAZUGcqdatV7rw`, `3yGYmP_GtUNsJeCOvHYQuQ`, `VVmScUGcit0trRrsom8QVw`,
  `iUK9l3UhfCZHHy9QO0I_LQ`, `hx0IwVbvJVs8xE2TpAt17Q`, `hFvT5jKCCB_v_yOFfPyjfw`. The fresh build's own list
  (`tileset.meta.json` `groundingPanoId`) replaces this one before the dry run.
- **Panos the mesh arms used** are excluded by the tool from their runs' records, as in M1.
- **Panos M1 judged at Penn 2** are kept in, as M1 kept earlier comparisons' views in (the judge does not learn).
- **The seams work of 2026-10-31** rendered SW's world from these poses for review. It made no judge call.

## Step 2: the free dry run

On the hook branch, with credentials unreachable, through M1's dry-run driver (`photo-match-dryrun.test.ts`) and a
config naming DM's run as the reference and SW and its decoys as splat arms:

```bash
env -i PATH="$PATH" HOME="$(mktemp -d)" PHOTO_MATCH_DRYRUN=<config.json> ./node_modules/.bin/vitest run packages/core/test/photo-match-dryrun.test.ts
```

It must show every arm and decoy rendered at every pose, the excluded panos, SW's `offsetM` and its street against DM's,
48 calls, and the grids reviewed with `screenshot-review`.

## Cost

Prices are those M1 read on 2026-10-31 (Vertex AI and Google Maps Platform price pages), labelled the same way.

| Part | Low | High | Label |
|---|---|---|---|
| Judge, 48 calls: the photo and 9 renders each (10 × 1,089 image tokens, measured per image in M1), about 760 prompt tokens, 2,500 to 25,000 output | $2.40 | $13.10 | price page × estimated tokens, through 2026-11-30 (double from 2026-12-01) |
| SW's fresh build: about 40 station images (24 street views and 16 survey stations, some rerolled) | $2.00 | $8.00 | estimated |
| Street View grounding: SW's 24 views and the judge's 16 | $0.28 | $0.56 | estimated at $7 to $14 per 1,000 (no published price) |
| 3D Tiles root requests | $0 | $0.02 | price page |
| **All** | **about $5** | **about $22** | |

Under the $100 the user set on 2026-10-31 for spending that needs no approval. This draft still asks for approval,
because it is a new comparison.

## Report

After the single paid run, in this file:
- one row per bar, with each arm's value and spread and each decoy's value, met or missed (bar 5: one row per pair and
  region);
- the views outside SW's reach, and the pose swaps;
- the decision the question names;
- the grids and mask grids.
