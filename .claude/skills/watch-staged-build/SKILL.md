---
name: watch-staged-build
description: Watch a staged location build (the 3D Building button, google_3d_tiles_get_clay with isolate/procedural) as it runs in the live app, read its run records, and score the result against the Haughwout baseline the user set on 2026-10-23. Use whenever a staged build is started, tested or compared - before claiming any building pipeline change is good, and whenever a build finishes degraded, to name the first cause.
---

# Watch a staged build and score it against the baseline

## Why this exists

A staged build runs 5-40 minutes through twenty stages, and the chat's finish summary lists every degraded stage
without saying which one caused the rest (on 2026-10-23 the Flatiron summary listed eight degraded stages; the only
cause was the massing check, two minutes in). The run writes everything needed to tell to disk as it goes. This skill
reads it, during the run and after, and compares the result with the user's standing benchmark: **every single-building
pipeline change must match or beat the Haughwout build** (0 degradations, pipeline G ran, 38k triangles, 2 of 6 plates
read, 149 of 164 elements kept, 3 of 5 facade textures). That baseline lives in `references/haughwout_baseline.json`;
update it only when the user sets a new benchmark.

## 1. Find the run

Runs live under `.scratchbox/cache/staged_location/runs/<8-hex-id>/` of the worktree the app instance runs from
(`stages.json` has the request and resolved place; `timeline.jsonl` grows per stage; `pipeline_e.json` is the massing
check; `pipeline_g.json` the G steps; `facade_grammar.json`, `texture_fit.json` the old pipeline's). The newest directory
is the run just started. The massing itself (its `check`, `solar` report and `notes`) is in
`.scratchbox/cache/staged_location/pipeline_e/<key>/massing.json`, newest by mtime.

## 2. Watch it as it runs

Start a background monitor the moment the build is sent, so nothing is missed and no polling is needed:

```bash
python3 .claude/skills/watch-staged-build/scripts/staged_run_report.py --wait
```

(`--wait` blocks until the run's `finish` stage is written, then prints the report; run it with `run_in_background`.)
Meanwhile read the live progress panel in the Browser pane with `get_page_text` (the staged-build panel lists each
stage with its status, time and reason) and take a screenshot at each milestone that changes the viewport: the raw
tiles, the remeshed scan, the clean massing, the G layer, the textured twin. Save milestone screenshots under
`docs/screenshots/<topic>_<date>/` and send them into the chat as they land (user rule).

The first degraded or failed stage is the cause; everything after it that says "fell to simpler real data" follows from
it. Check the massing as soon as `pipeline_e.json` exists (about a minute in): a failed check means pipeline G will not
run, and the rest of the run is the old pipeline's fallback. Stop and diagnose then, not after ten minutes.

## 3. Read the report

`python3 .claude/skills/watch-staged-build/scripts/staged_run_report.py [run-id-prefix] [--json]` prints:

* the stage table with each stage's status, time, triangles and reason;
* the massing check (IoU, roof error at the median and p90, and why it failed);
* every pipeline G step as accepted / proposed, with its notes, and the native build's rejected openings counted by
  reading group (280 rejections in one group `g10` is one bad reading, not 280 problems);
* a verdict per baseline measure, `met` / `BELOW` / `n/a`, and one line: meets the baseline or not.

What the numbers mean, from the runs read on 2026-10-23:

| Symptom in the report | Usual cause | Where to look |
|---|---|---|
| `vector skipped: no building within 40 m` and `tiles degraded: extends past 150 m` | the geocode is the street address, not the building (Fallingwater: 116 m off) | `stages.json` place vs the real building; probe `fetchVectorEvidence` at 200 m |
| massing check `roof N m off the scan` with `solar.pitchedKept` > 0 | Solar facets taken as roof planes that contradict the scan | `massing.json` `solar` and `notes`; `massing-spec.ts` lock branch |
| `native build` share far below 0.9, rejections concentrated in one group | a reading continued its repeats across the wall edge or over other openings | `pipeline_g.json` native build notes; the plate and reading in the brief |
| `facade reading` explains 1-2 % of the plate | the wall was hardly seen (coverage near the 35 % floor) or the reading is wrong | `wall plates` coverage, the plate PNGs under `pipeline_g/<key>/plates/` |
| `scan_fit timeout 30 s`, lattice grammar chamfer miss, textures 600 s timeout | the old pipeline running because E/G did not: not the cause, the consequence | the first degraded stage above them |

## 4. Record

Findings go in `docs/processes/<slug>.md` with a README row (the `operate-scratchbox` skill's template). Quote the
report's verdict line and the first-cause stage, and attach the milestone screenshots. Never call a run good from the
chat summary alone: the summary is the model's prose; the report is the record.
