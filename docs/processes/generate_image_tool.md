# Process: `generate_image`, a real image tool for the in-app agent

> **Recorded:** 2026-10-20
> **Status:** Verified
> **Tags:** `operate-scratchbox` `tools` `images` `nano-banana` `directors-treatment` `drift-test`
> **Target Domain:** Gemini Agent Chat / Generative Canvas (markdown document)

---

## 1. Session Context

* **What prompted this session:** the tool consolidation plan (§5) found that the `directors-treatment` skill tells the model to make storyboard frames with `generate_image`, but no such tool was registered (four `KNOWN_DRIFT` entries in `instruction-tool-drift.test.ts`). The user approved a real tool on 2026-10-20, knowing it lets the model start billed image calls on its own.
* **Instance used:** web port `3072`, API port `3070`, tools port `3071` (`scratchbox-generate-image-tool` launch entry, branch `generate-image-tool`, removed afterwards). Credentials came from a temporary `secrets.json` symlink, removed afterwards.
* **Scope tested:** one chat asking for three 16:9 storyboard frames of a short scene; the tool's unit tests with a fake client; typecheck, lint, the primitives lint, the drift test, the registry and pack tests.

---

## 2. Design

**Where:** `packages/core/src/node/gemini/tools/nano-banana-tools.ts` exports `IMAGE_GENERATION_TOOL_DECLARATIONS` and `imageGenerationHandlers` next to the palette tool. Registered through the pack pattern in `tool-registry.ts` (one loop, no handler code there), in `tools/index.ts`, in the `core_workspace` pack (`domain-tool-packs.ts`, so every turn that has workspace tools can make a picture, not only 3D or mesh turns), and in the standalone MCP server (`scratchbox-mcp-server.ts`, where the turnaround and other image-making tools already are).

**Parameters:** `prompt` (required), `aspectRatio` (one of the labels the models accept; default `16:9`; anything else is an `InvalidInputError` naming the accepted values), `referenceImages` (workspace paths, absolute paths, http(s) URLs or data URIs, sent as inline parts for edits and consistency across frames), `model` (open string; product names `nano-banana-2`, `nano-banana-pro`, `nano-banana-lite` resolve to API ids; when given, only that model is asked), `fast` (asks `gemini-3.1-flash-lite-image` first, then the standard list), `count` (1–4, each a separate billed call), `name` (file-name stem) and `outputDir` (default `build/generated-images` under the repository root).

**Model choice and fallback:** with no `model`, the standard list `IMAGE_MODEL_PRIORITY` (`gemini-3.1-flash-image`, `gemini-3-pro-image`, `gemini-2.5-flash-image`) through `generateImageWithModels`, which moves to the next model only when one is not served (404) and records each skipped model with its reason. Quota, safety and empty answers end the call with a `MediaModelUnavailableError`. The result carries `modelUsed`, `modelVersion`, `skippedModels`, `modelNote` and `credential` (`api-key` or `vertex-ai`, read from the client), per image and overall.

**Files and URLs:** images are written with the model's own bytes and extension (`<stem>_<timestamp>[_n].png|jpg|webp`). `build/` is gitignored; `desktop-app/server/app.ts` serves `build/generated-images` at `/build/generated-images/` (the Vite dev server already proxies `/build`), so the chat (`![title](url)`) and a document's image sections can show the files. A file written to another `outputDir` gets no URL and the summary says so; nothing is invented.

**Provenance and failure:** every result carries `provenance: 'generated'`. No credential, no served model, a refused prompt or an unreadable reference is a typed error (`MediaModelUnavailableError`, `MissingInputError`, `InvalidInputError`) and no file is written. There is no placeholder image path.

**Instructions:** the four `directors-treatment` files now call the tool with its real parameters and embed the returned URL; the system prompt (`prompt-builder.ts`) lists the tool and, in the picture-output guidance, says to make the picture with it and use its URL (no keyword routing). The four `KNOWN_DRIFT` entries are gone.

---

## 3. What Was Tested & What Worked (Verified)

* **Unit tests** (`packages/core/test/generate-image-tool.test.ts`, 8 tests, run through the guarded vitest wrapper with credentials unreachable). The Google Gen AI client is a fake injected at the SDK boundary (`GoogleMediaCredentialsService.prototype.createClient`). They check: the request each model call receives (model id, prompt text, reference bytes as inline PNG, `imageConfig.aspectRatio`, `responseModalities`), the files written (PNG magic bytes and byte-for-byte the model's answer, 16×9 dimensions read back, paths with the stem and index), the URL only for files under `build/generated-images`, the named model and the `fast` order, the visible fallback (404 on the first model → second model answered, `skippedModels`, `modelNote`, `credential: vertex-ai`), and that no credential / no served model / quota / bad input write nothing. Evidence: `8 passed`, exit 0.
* **Registry, packs, drift:** `tool-registry-handlers` (1), `instruction-tool-drift` (103, with the four entries removed), `domain-tool-packs-and-coercion` (19), `nano-banana-color-service` (19), `agent-stress-all-tools-and-prompts` (46) and `tts-and-mcp-no-stubs` (5) all pass. `npm run typecheck` exit 0; `npm run lint` 0 errors (the warnings are pre-existing); `npm run lint:primitives` passes.
* **Live chat** — prompt: *"Storyboard a short scene for me: a lighthouse keeper climbing the spiral stairs at dawn as a storm breaks over the sea. Make 3 storyboard frames as real 16:9 images and show them here in the chat."* The chat model (gemini-4-argon, Vertex AI) called `generate_image` three times with `name: storyboard_frame_01_spiral_ascent` / `..._02_storm_window` / `..._03_lantern_room_dawn` and `aspectRatio: 16:9` (9.8 s, 18.6 s and 18.3 s), then `mount_canvas_primitive` with a markdown document. Each tool summary read `Generated 1 image (16:9) with gemini-3.1-flash-image via api-key -> …/build/generated-images/storyboard_frame_0N_….jpg. Generated with gemini-3.1-flash-image.` (no fallback). The three files are JPEGs (`ff d8 ff e0`, 870 KB / 768 KB / 795 KB), served with `200 image/jpeg` on both the API origin and the Vite origin, and the browser fetched them (`GET /build/generated-images/… → 200 OK`). The chat shows the three frames inline under "Frame 01/02/03" with the lens and lighting notes; the canvas document "The Dawn Watch: Lighthouse Storm Sequence" shows them as image sections with the caption "generated with gemini-3.1-flash-image". Screenshots: `test-results/screenshots/generate_image/01…05.jpg` plus the three frames.

---

## 4. What Broke / Didn't Work

* Nothing in the tested scope. The console's four `404` errors on page load came from the restored earlier session's missing model files in this worktree, before the new chat, and are unrelated.
* Not tested live: `referenceImages`, `fast`, `count > 1` and a credential-less run (covered by the unit tests only).

---

## 5. Candidate Tool/Service Ideas

* **Image cards on tool results** — the chat card for `generate_image` shows the summary text only; the picture appears because the model writes `![…](url)`. A card that renders `resultPayload.images[].url` directly would show the frames even when the model forgets the markdown.
* **Session-scoped output folders** — the request carries no chat-session id, so the default folder is one flat `build/generated-images`. Passing the session id to `ToolContext` would allow one folder per chat and a clean-up of old sessions' images.

---

## 6. Reproduction Steps

1. `git checkout generate-image-tool` (or main after the merge); add a `scratchbox-<branch>` launch entry on free ports (operate-scratchbox skill) and start it.
2. Open the token URL from `preview_logs`, start a new chat and send the prompt in §3.
3. Expect three `generate_image` cards, files under `build/generated-images/`, the frames inline in the reply and in the mounted document; each summary names the model and credential.
4. Tests: `bash <guarded-vitest> packages/core/test/generate-image-tool.test.ts packages/core/test/instruction-tool-drift.test.ts packages/core/test/tool-registry-handlers.test.ts packages/core/test/domain-tool-packs-and-coercion.test.ts`.
