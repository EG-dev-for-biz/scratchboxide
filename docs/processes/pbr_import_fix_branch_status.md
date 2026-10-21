# pbr-import-fix: box-projection PBR texturing, paused unverified at its tip

**Date:** 2026-10-21
**Status:** Not merged; tip explicitly marked "do not merge as is" by its own author

## Why this branch is not merged

Found during an integration pass that checked every worktree branch with unpushed or unmerged
work against `main` (per a user request to merge everything that genuinely had work pending).
`pbr-import-fix` is 6 commits ahead of `origin/main` (none duplicated elsewhere), but its own
top commit's message is explicit:

> `wip(pbr): unreviewed edits when the work was paused (not verified; do not merge as is)`

That marker was treated as a hard stop, independent of the general merge authorization — an
author's own "do not merge" note on their tip commit overrides a later, general instruction to
merge branches, since the general instruction cannot have been meant to override a specific one
left by whoever did the work.

## What the branch actually contains

| Commit | What it does |
|---|---|
| `9071c5b8` | fix: runtime imports resolve under the server's ts-node CommonJS loader |
| `7fbbb086` | feat: box-projection texturing of GLB scenes with per-part materials |
| `34f6807e` | fix: `height_blended_triplanar` / `carrier_conformal_sheet` apply the textures they synthesize |
| `ab468de0` | test: the textured GLB is not the input, and every UV is the dominant-axis projection of its world position |
| `9bbc6e43` | fix: `recipe_hybrid` refuses meshes it would corrupt; the synthesizer that ran is named |
| `84c6cb6c` | **wip, unreviewed, paused — the "do not merge" commit.** Touches `packages/core/src/node.ts`, `adaptive-uv-orchestrator.ts`, `pbr-material-tools.ts`, and its own test file. |

The first five commits look like ordinary, named, tested feature work. Only the last one is
flagged unverified.

## What's actually needed before this can move

1. Whoever paused this branch (or the session that picks it back up) reviews commit `84c6cb6c`
   specifically — what state it left `adaptive-uv-orchestrator.ts` and `pbr-material-tools.ts`
   in, and whether it was a real fix in progress or a rolled-back experiment.
2. If it holds up, drop the "do not merge" framing, keep or amend the commit, and merge normally
   (6 commits ahead of a 897-commits-stale base; expect conflicts in `pbr-material-tools.ts`,
   which main has also touched independently since this branch was cut).
3. If it doesn't hold up, merge only the first five commits (reset to `9bbc6e43`) and drop the
   unreviewed tip.

Not attempted in this pass — this needs the branch owner's judgment, not a guess.
