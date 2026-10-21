# pbr-import-fix: fully superseded, nothing to merge

**Date:** 2026-10-21
**Status:** No action needed — the branch is redundant, not pending

## Correction

An earlier pass of this same investigation checked this branch's 6 commits against `origin/main`
by commit hash alone, found 0 ahead by that measure... then, confusingly, re-checked by content
and initially reported 6 unique commits with 5 of them "clean, tested, mergeable work" and only
the 6th blocked. That was wrong. Checked properly (byte-for-byte diff of each commit's patch
against commits already in `main`, not just hash or message), **all 6 are either duplicates or
moot**:

| `pbr-import-fix` commit | Message | In `main` as | Content match |
|---|---|---|---|
| `9071c5b8` | fix: runtime imports resolve under the server's ts-node CommonJS loader | `7d5ff891` | Byte-identical |
| `7fbbb086` | feat: box-projection texturing of GLB scenes with per-part materials | `288f2b4b` | Byte-identical |
| `34f6807e` | fix: `height_blended_triplanar` / `carrier_conformal_sheet` apply the textures they synthesize | `228851a0` | Byte-identical |
| `ab468de0` | test: the textured GLB is not the input, every UV is the dominant-axis projection of its world position | `fb534484` | Byte-identical |
| `9bbc6e43` | fix: `recipe_hybrid` refuses meshes it would corrupt; the synthesizer that ran is named | `1315dd6c` | Byte-identical |
| `84c6cb6c` | wip, unreviewed, paused — "do not merge as is" | — | Not in `main`, and its own author said not to merge it |

This matches [[pbr-synthesize-material-paused]] (memory), which already recorded that
`pbr-import-fix` was superseded by `bee76cd9` et al. back on 2026-10-17 — this doc exists only to
leave the verified receipts (exact duplicate commit hashes) in the repo itself, not just in
session memory, so a future pass doesn't have to redo the hash-matching.

**Bottom line:** this branch needs no merge, no review, and no decision. It can be deleted
outright whenever its owner wants to; nothing in it is missing from `main`.
