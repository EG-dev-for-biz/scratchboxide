# Preregistration 4: pipeline K, fixed, against the raw scan at the ESB, the Haughwout and the Ferry

Date: 2026-11-02. Status: **written before any of its builds, probes or paid calls.** Nothing below changes after this line
except the run record and the report. A bar, arm, place or view changed after a paid call is a new preregistration that names
this one.

## The earlier runs, and why this one is made

- **[Preregistration 1](./2026-11-02-k-step-ablation-prereg.md)** asked, at the ESB, which K step scores worse than the raw
  scan. It was indicative, with 2 views registered.
  - It put 1.17 of K's 1.83 overall gap in the twin's de-light.
  - That de-light is since fixed (it keeps the photo's chroma).
- **[Preregistration 2](./2026-11-02-k-step-ablation-2-prereg.md)** judged the fixed de-light at the Haughwout and the Ferry.
  - Both were indicative (`matchedShare` under 0.99), and the ESB was not judged.
  - The de-light no longer cost anything.
  - The Ferry stayed 1.20 below raw overall, on geometry.
- **[Preregistration 3](./2026-11-02-k-ferry-stage-cuts-prereg.md)** cut K at the Ferry stage by stage. It was indicative.
  - The cleanup and the footprint clip each lost 2.27 on clay shape.
  - The clip also lost 2.38 px of placement.
- **[The tower fix](./2026-11-02-ferry-tower-vector-tile-copies.md)** traced the clip's tear to the vector evidence: one
  building that two feature tiles carry was kept as two. With that fixed, the Ferry is built whole and the clip removes none
  of its tower.
- **This run** judges K with every fix, against the raw scan, at all three benchmark places. The ESB can be judged again on
  main's #21 views.
  - **Requested by** the parent session, under the user's "Do what you think is best".
  - **Left out:** the sky-visibility de-light (MAIN's uncommitted work, which widens the seams) and the Haughwout's magenta
    white balance. Each is a later arm.

## Question

At each place, does the fixed K score level with the raw scan or above it?
- **Level or above:** K's straightening costs nothing the judge sees there.
- **Below:** the report says on what (shape, clay shape, placement, materials). That is where to look next.

## Arms

Per place, built fresh and uncached on `fix/k-twin-delight` with main merged. Main's merge changes only the judge
(`photo-match-evaluate.ts`) and its skill, not the build. Every switch is at its default.

| Id | Label (reports only) | What |
|---|---|---|
| raw | RAW SCAN (CUT TO TARGET) | `baseline: true` |
| K | PIPELINE K | `google_3d_tiles_get_clay` `{query, isolate: true, trees: true, pipeline: 'k'}`, its twin by `runId` |
| X2 | DECOY MOVED 4 M | K's twin moved [4, 0, 0] (`make_decoys.py`) |
| X3 | DECOY FLAT COLOUR | K's twin in one flat colour (`make_decoys.py`) |

The places' queries are the earlier runs':
- ESB: "Empire State Building, New York";
- Haughwout: "Haughwout Building, 488 Broadway, New York";
- Ferry: "Ferry Building, San Francisco".

The Ferry's fresh K is run 526b7580, built for the tower fix on the same code. It was built before this was written, and
nothing about it was read against the judge.

## Places and views

The procedure is the judge-preregister skill as main has it (#15).
1. **Probe.** One probe call per place, with every arm: `views: 6`, `runs: 1`, `clay: false`, `judgeRegions: false`. Views
   are found for real.
2. **Era check.** Run it on exactly the probe's `heldOut.judgedPoses`. A view is kept when its photo shows the building as
   the scan does: the same massing, and no scaffold or demolition the scan lacks.
3. **Pin.** The kept views become this place's `poses`, with `autoViews: false`. A place needs at least 3. Fewer, and it is
   not judged.
4. **Record.** The poses go into the run record before the dry run.

## Bars

Unchanged from preregistrations 2 and 3:

| # | What it checks | Bar |
|---|---|---|
| V1 | judge spread, mean over all arms | at most 0.75 |
| V2 | X2 against K, placement | X2 at least D above K (D = half X2 − K in this place's dry run, at least 2 px), over at least 2 views with a placement |
| V3 | X3 against K, materials and overall | each at least 1.0 below K |
| V4 | raw frame agreement; `matchedShare` | 1.00; at least 0.99 (a miss makes the place indicative, as before) |

- **The reading, per place:** **K level** when K is at least raw − (the larger of K's and raw's spread) on overall, at three
  quarters of the judged views and at least 3, with V1 to V3 met.
  - **Otherwise K is below.** Its shortfall on shape, clay shape, placement and materials is reported, read the same way.
- **Secondary, deciding nothing:** detail, the region scores, and the earlier runs' numbers set beside these.

## Decoys

- **X2** (moved 4 m) must lose on placement by D (V2).
- **X3** (one flat colour) must lose by 1.0 on materials and on overall (V3).

Both are made locally from each place's K twin, at no cost.

## Stop rules

- **Spend:** stop past **$35** and on any 403 or spend cap.
- **Builds:** a build that fails or degrades on a time limit is finished with the app's retry (`retryRunId` /
  `retryStage`), once. Otherwise the place is not judged.
- **Dry run:** an empty or black render, an arm with 0 triangles, or `frame_mismatch` stops that place.
- **V1 to V3 missed:** nothing is read at that place. **V4 missed:** indicative.
- **One paid call per place, no re-run.**

## Exposure

The panos each build used are excluded by the tool. The Haughwout and Ferry views judged in run 2 may come back from the
probes. They are not excluded, by the M1 rule kept in every earlier run.

## The free dry run, per place

The pinned poses, all four arms, `fakeJudge`, under vitest with credentials unreachable. It must show:
- every arm rendered at every pose;
- no build's pano held out;
- the call count as estimated;
- D set from X2 − K.

## Cost, estimated before any of it

| Item | Basis | Low | High |
|---|---|---|---|
| Builds | ESB and Haughwout K fresh (the Ferry's done): about $0.85 a build in vision calls, measured today | $1.70 | $3.00 |
| Probes | 3 x (6 views x 1 run, 4 arms in one image, about $0.05 a call, plus 12 photos at $0.007) | $1.15 | $2.50 |
| Paid calls | 3 places x up to 6 views x 3 runs x 2 (clay), about $0.05 a call measured in run 3, up to 2x with thinking | $5.40 | $10.80 |
| **In all** | | **about $8** | **about $16**, against the $35 stop |

Under the user's $100, so no approval is needed. The actual spend is reported after.

## Order

1. Commit this; sync main into `fix/k-twin-delight`.
2. Build the ESB and Haughwout K fresh.
3. Probe each place, era-check, and pin the poses in the run record.
4. Make the decoys; dry-run each place and set D.
5. Make the paid calls, one per place.
6. Report against the bars, with a labelled proof sheet.

## Run record

(none yet)

## Report

(after the paid calls)
