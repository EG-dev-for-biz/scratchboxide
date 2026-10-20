# AGENTS.md cut to coding rules, plus an instruction-to-tool drift test

**Date:** 2026-10-20
**Status:** Done

## Why

- **Wrong reader.** AGENTS.md (780 lines, 64 rules) is read only by coding agents. About half of it listed in-app tools and their parameters for the chat model, which never reads it.
- **Drift.** It named two tools that do not exist (`mesh_reshape_via_prompt`, `utdra_decompose_tile`).
- **Promises the code does not make:** a Veo 2 backbone, "< 0.05 px RMS", "SSIM ≥ 0.95", gallery districts whose media were deleted.
- **Contradictions:**
  - the visual-critic rubric demanded a full sky dome while the zero-defaults rule demands a studio void;
  - the tile-decomposition rule classified tiles into 9 fixed area types, against the first architecture rule.

## What changed

- **`AGENTS.md` is now 118 lines of coding rules:**
  1. the architecture audit (including the feature-type vocabulary line);
  2. what the app can and cannot do;
  3. the 3D engine rules;
  4. product behaviour, one paragraph each, naming the code that enforces it;
  5. real-world data and tiles;
  6. engineering practice.
- **Every symbol and path it names was checked to exist.**
- **Removed from AGENTS.md,** and where each now lives:

| Removed section | Lives in |
|---|---|
| Per-directive in-app tool catalogues: atmosphere, WebXR, resection, de-lighting, mesh reshaping, matchmove, tile decomposition, AI Beautify | The tool declarations in `packages/core/src/node/gemini/tools/` (reference: `npm run docs:mcp`) and the matching `.agents/skills/` |
| Gallery district asset rules | Deleted; the media was removed (see `demo_media_regeneration.md`) |
| Veo 2 / Omni performer video conditioning detail | `omniVideoPromptService.ts` and its skills |
| The 8-dimension visual rubric | The `visual-critic` skill |
| Code-first live preview, In-Situ commenting | The system prompt (`prompt-builder.ts`) |
| Full follow-up pill catalogue | The system prompt |

  The previous text is in git history (the commit before this one).
- **New test `packages/core/test/instruction-tool-drift.test.ts`:**
  - **What it reads:** AGENTS.md, the system prompt, the capability resolver and every skill under `.agents/skills` and `.claude/skills`.
  - **What it checks:** every tool-like name in backticks whose first word matches a real tool or viewport operator must be registered.
  - **Exceptions:** names that only look like tools are listed with a reason in `NOT_TOOLS`. Real drift still to fix is listed in `KNOWN_DRIFT`, and the test fails if that list goes out of date.
- **Fixed now:** `adaptive_matchmove_solve_spline` → `adaptive_matchmove_synthesize_trajectory` in three skill files and a preflight script, with the example arguments corrected to the tool's real parameters.
- **Left for the tool clean-up (step 3):**
  - `generate_image`: the directors-treatment skill tells the model to call it, but no such tool is registered;
  - `adaptive_matchmove_render_blockout` in the geo-camera-matchmove skill.

## Tests

- `instruction-tool-drift`: 103 checks pass.
- The two older tests that checked AGENTS.md headings (`no-js-primitives-hardening`, `tile-extraction-building-integrity`) now check the same rules' new wording, and pass.
- `npm run typecheck` passes.
