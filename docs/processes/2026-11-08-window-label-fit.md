# Pipeline K: the window-check labels' first consumer, a site decision fitted and scored against the array's cut-offs

Date: 2026-11-08. Branch `claude/window-label-fit-11bde3`. Follows [the window check](./2026-11-07-window-check.md) (PR #186, PR #195), which stores a person's answers about the window array's least certain sites in `labels.jsonl`, each joined to the evidence the array recorded for the site (`window-array.ts` `SITE_EVIDENCE_FIELDS`). Until now nothing read that file.

## What was built

- **`pipeline-k/window-label-fit.ts`** (`packages/core/src/node/3d-engine/staged-location/pipeline-k/`): reads every `labels.jsonl` found (a file as given, a folder searched eight deep), keeps the rows whose check passed both control images (`trusted`), joins each to its evidence **by the row's own `fields`** (an extra field is kept and ignored, a row missing one of the fit's fields or the decision is skipped with its reason, as is a torn line), counts rows, trusted and untrusted, per source building (the ortho folder's `tile_refine` key), per array decision (`SITE_DECISION`) and the answers' balance, then:
  - **replays the current rule** from the recorded decision: a site the array added, continued or filled behind an occluder is predicted a window, one left outside or withheld a wall; scored as accuracy, precision, recall and log loss (its hard answer at 0.95 / 0.05);
  - **fits a logistic regression** on the standardised evidence fields (`contrast`, `covered`, `occluded`, `rowContrast`, `colContrast`, `rowBoxes`, `colBoxes`, plus an indicator for a contrast the photo could not read; a null stands at the field's mean), L2 regularised (1.0 in standardised units, the bias free), by Newton's method; no dependency added;
  - **scores it out of sample**: leave-one-source-out when the trusted rows come from two or more buildings (a building never scores itself), else leave-one-row-out, and says so;
  - **gates the weights**: under 30 trusted rows, or under 5 of either answer, the report carries the counts and the current rule's score only and publishes no weights.
- **`scripts/window_label_fit.ts`**, `npm run window-labels:fit [-- --labels <file-or-dir>... --out <dir> --no-default]`: the default store (`window_labels` under `.scratchbox/cache`, or `SCRATCHBOX_WINDOW_LABELS_DIR`) plus any paths given; writes `window_label_fit.json` (default `.scratchbox/cache/window_label_fit/`) and prints the summary. It writes nothing into the label store and changes nothing in the array.
- **Tests** (`packages/core/test/pipeline-k-window-label-fit.test.ts`, 7, no network): synthetic labels from three buildings whose answer is a known function of contrast and occlusion plus noise (the fit recovers both signs, contrast the strongest weight, 85 %+ across buildings against a coin-flip current rule); one building only falls back to leave-one-out and says so; under the floor the gate fails and no `weights` key appears; one answer nearly absent fails the gate too; version drift (extra field kept, missing field skipped, mismatched lengths skipped, fields in another order read by name, a torn line skipped); files found under folders and a key read once across files; and the real rows below as a fixture (`test/fixtures/window-labels/labels.jsonl`, paths shortened) checked for counts and the current rule's confusion matrix.

## The real labels on this machine

Three stores exist (the k-height worktree's, tx-main's, k-texture-expert's); the fixture is the first. Run over all three:

```
Read 28 window-check labels from 3 label files (0 lines skipped): 21 trusted (4 windows, 17 walls) and 7 untrusted,
from 2 buildings (1 with trusted rows). The array's current rule gets 71% of the trusted answers right (precision 0.000,
recall 0.000, log loss 0.893). Too few labels for any conclusion about a fitted rule: 21 trusted rows, under the floor
of 30; no weights are published. The floor needs at least 30 trusted rows with 5 or more of each answer, from more than
one building for the fit to be scored across buildings.
```

| | rows | trusted | trusted windows |
| :--- | ---: | ---: | ---: |
| building `9bffd2e1…` (k-height and k-texture-expert stores) | 21 | 21 | 4 |
| building `72a30e5d…` (tx-main store, PR #195's live test, controls missed) | 7 | 0 | 0 |

Over the 21 trusted rows by the array's decision: 17 `outside` (4 of them windows), 2 `withheld` (walls), 2 `added` (both walls). So the current rule's confusion matrix is 0 true windows, 2 false windows, 15 true walls, 4 missed windows: every window a person found was a site the array had left outside, and both sites it added on dim evidence were walls. These are the sites the check chose *because* the array was unsure, so the 71 % says nothing about the array over all its sites; it is the number a fitted rule has to beat on exactly the sites that matter.

**Honest reading.** Twenty-one trusted rows, four of them windows, all from one building, is far under the floor: no weights are published and none should be read into. The floor needs at least 30 trusted rows with 5 or more of each answer; for the across-building score to mean anything it needs trusted rows from at least two buildings, so the window check has to be answered (controls right) on builds of other buildings. Each check yields 7 labels, so two more passed checks on the same building reach the row floor, and one passed check on a second building makes the leave-one-source-out score possible.

## Next step (not this change)

The fitted rule behind a switch in `window-array.ts`, in place of `addMinContrast` / `contradict` / `stepContrast` for the empty-site decision, read from a committed `window_label_fit.json` the way `material-set-fit.ts` reads its regressor; only once the gate passes and the across-building score beats the current rule.
