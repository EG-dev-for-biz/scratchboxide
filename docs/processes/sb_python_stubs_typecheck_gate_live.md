# Process: Generated scratchbox stubs, pre-run type check and API summary, measured on the live in-app agent

> **Recorded:** 2026-10-19
> **Status:** Verified (gate catches API misuse before running with 0 false rejections on 464 scripts that ran; no measurable drop in failed builds on either model, see section 2.4)
> **Tags:** `operate-scratchbox` `python-3d` `type-stubs` `basedpyright` `agent-reliability`
> **Target Domain:** Gemini Agent Chat / execute_3d_python_script

---

## 1. Session Context

* **What prompted this session:** the in-app agent writes `import scratchbox as sb` scripts against an API it only knows from hand-maintained prompt text and 16 hand-written `.pyi` stubs that nothing used. The task: generate stubs from the live module, check scripts against them before running, give the model a generated API summary, stamp the API version into scenes, and measure the effect.
* **Instances used:** after = branch `sb-stubs` (web `3161`, API `3162`, tools `3163`); before = `d2e81d57` (the fork point, web `3171`, API `3172`, tools `3173`). Both started with `desktop-app/scripts/dev.js` and `SCRATCHBOX_NO_ELECTRON=true`; turns were sent to `POST /gemini/stream` (the endpoint the chat UI uses) by a harness that records every SSE event, and two turns per condition were also driven through the chat UI for screenshots.
* **Scope tested:** stub generation (`npm run stubs:sb`), the drift test, the gate in `execute_3d_python_script` and the 3d-scene payload script path, the generated summary in the tool description and `read_sb_script_guide`, `pythonGenerator.sbApiVersion`.

---

## 2. What Was Tested & What Worked (Verified)

### 2.1 What drifted in the old hand-written stubs

Compared with the live module (`git show origin/main:packages/core/src/python/scratchbox/*.pyi`):

* **Wrong location.** `scratchbox/__init__.pyi` imported `from scratchbox_native import ...`, but the native stubs sat inside the `scratchbox` package as `scratchbox/scratchbox_native.pyi`, so a checker could not resolve the native types at all. The copy in `native/3d-engine/scratchbox/` was a stale duplicate.
* **Names that do not exist at runtime:** `sb.Mesh`, `sb.Vec2/Vec3/Vec4/Quat/AABB`, `sb.create_torus`, `sb.render_sensor_passes`, `sb.export_glb_bytes`, `sb.geometry.validate_scene`; `sb.nature` and `sb.architecture` were typed as the native modules, but at runtime they are small facade namespaces (so `sb.nature.LSystemTreeParams`, `sb.nature.generate_ivy` and the like fail).
* **Wrong signatures (the Python patches were never reflected):** `Mesh.translate/scale/bulge` and `sb.create_box` take `*args`; `Mesh.set_material/apply_material` take `mat`, not `material`; `taper(factor, axis)`, `twist(angle_deg, axis)`, `bend(angle_deg, radius, ...)` have a different parameter order; `decimate_qem(ratio, target_triangles, **kw)`; `create_sphere/cylinder/plane/lathe/beveled_box/subdivided_box/envelope/arched_blister/catenary_cable/studio_pedestal` all have different or extra parameters (e.g. `create_lathe(segments=)` not `radial_segments`, `create_catenary_cable(start, end, ...)` not `p1, p2`, `create_beveled_box(bevel=)` not `bevel_radius`); `write_glb/export_glb(arg1, arg2=None)`.
* **Missing:** 212 public names, among them 12 Python-only `Mesh` methods (`snap_to`, `ground_on`, `displace`, `merge`, `subtract`, `align_to_terrain`, `bake_curvature_ao`, `slice`, ...), the 30 PbrMaterial presets on `sb.PbrMaterial`, the facade namespaces (`sb.layout`, `sb.pbr`, `sb.validation`, `sb.geospatial`, `sb.constants`), `sb.human` and 55 names of `scratchbox.human`, `RomanOrder`, and the attributes Python classes set on `self` (e.g. `Human.height`).

### 2.2 Generator, drift test, summary

* `npm run stubs:sb` builds `scratchbox_native` if its sources changed, then `scripts/gen_sb_stubs.py` writes 24 stub files to `packages/core/src/python/typings` and `packages/core/src/node/3d-engine/sb-api.generated.ts` in about 2 s (one basedpyright pass infers 35 Python return types). Two consecutive runs give byte-identical output.
* `packages/core/test/sb-stubs.test.ts` regenerates into a temp dir and fails with "Run `npm run stubs:sb` and commit ..." when anything differs; it also checks every public name of the live `sb` and `Mesh` is in the stubs, the version hash, and the summary budgets (full ≤ 3,500 tokens, core ≤ 1,800 tokens).

### 2.3 The gate

* basedpyright 1.40.2 from `.venv`, `standard` mode, stubs on `extraPaths`, `OUTPUT_GLB_PATH` declared in a `__builtins__.pyi`. Time limit 2 s (`SCRATCHBOX_SB_TYPECHECK_TIMEOUT_MS` overrides).
* **Timings (live runs):** p50 511–608 ms, p90 533–1,064 ms. 2 of 52 checks in the gemini-4-argon run exceeded 2 s while three agent streams and their vision reviews ran on the same machine (max 2,012 ms); both failed open (`typeCheck.status: timed_out`, a console warning, the script ran) and both scripts built.
* **Strictness (what blocks):** unknown attribute of a scratchbox class or module; unknown import from the package; wrong keyword names or counts (`reportCallIssue`: no parameter named, expected N positional, missing arguments, not callable); a plain tuple/list/number passed or assigned where a native `Vec3/Vec4/...` is required (nanobind registers no implicit conversion, so these always raise "incompatible function arguments"). Not blocking: other argument types, `No overloads for ...` (it mixes arity with type mismatches), Optional access, third-party stubs, syntax errors. A missing name the script guards with `hasattr/getattr` or a `try/except AttributeError` is not blocked. Classes whose instances take new attributes (nanobind `dynamic_attr`, e.g. `Mesh`) get a `__setattr__` in the stub, and reading back an attribute the script sets is allowed.
* **Precision, measured against real outcomes** (gate run on scripts whose runtime result is known):
  * 156 unique past scripts from `build/3d-python` that run today: 0 rejected. 175 that fail today: all rejected (one stale API, `adaptive_object.AdaptiveHeroObjectSynthesizer`). 18 that fail for value errors (`replicate_metric_array` without `seed_geometry`, assertion failures): not rejected, correctly.
  * 317 live agent scripts from both conditions that ran: 308 that built, 0 rejected; the 1 baseline runtime API error (`lamp_glow.emissive = [2.0, 1.7, 1.0]`) is rejected.
  * Live gate rejections in the final after runs: 3. Two were real (`sb.Flora.PlantPreset`, `scene.compute_curvature_ao` on a `World`); running them without the gate fails with the same AttributeError. **One was a false rejection:** `sb.PbrManager if hasattr(sb, 'PbrManager') else ...` (gemini-3.5-flash-lite, stage prompt). The hasattr/try guard was added after that run; the script now passes.

### 2.4 Before/after on the live in-app agent

24 prompts (stool, cathedral facade, locomotive, coral reef, desk lamp, footbridge, mushroom forest, lighthouse, sports car, chess set, pagoda, windmill, dragon skeleton, spiral staircase, rover, bonsai, castle gate, orrery, galleon, park bench at night, lit theatre stage, jellyfish, geodesic greenhouse, pipe organ), each "Write a scratchbox Python script and run it with execute_3d_python_script to build ...". "Failed" counts script calls that did not build (gate rejections included). "Error retries" are calls made right after a failed call; other repeat calls are the agent refining a model that already built.

| Model / condition | Script calls | Runtime API errors | Gate rejections | Failed calls | Error retries | Prompts built | Median time to first build |
|---|---|---|---|---|---|---|---|
| gemini-4-argon, before | 43 | 0 | – | 0 | 0 | 23/24 (bonsai: server "fetch failed", no script) | 115.0 s |
| gemini-4-argon, after | 52 | 0 | 1 | 3 | 3 | 24/24 | 123.3 s |
| flash-lite, before (3 runs × 24) | 113 | 1 | – | 4 | 4 | 72/72 | 13.4 / 12.4 / 11.8 s |
| flash-lite, after (3 runs × 24) | 112 | 0 | 2 (+1 false, see 2.3) | 5 | 5 | 72/72 | 13.1 / 14.4 / 14.3 s |

* The baseline already produced very few API errors (1 in 156 script calls), so the gate had little to catch, and the after numbers are within run-to-run noise (the three baseline flash-lite runs alone range from 0 to 3 failed calls). The other failures in both conditions are Python mistakes the type check does not cover (syntax errors, `create_cylinder() got multiple values for keyword argument`, value errors).
* **The generated summary first made things worse.** Before the "Vec types take sb.math.Vec4(...), never tuples" note was added to the summary text, the after flash-lite runs had 7 gate rejections per 24 prompts, almost all `glass_tinted(color=(r, g, b, a))` / `emissive_glow(color=(...))`: the summary lists those presets' `color` parameters (the hand-written reference never mentioned them) and the model passed tuples. Every one of those would have failed at runtime; the gate turned them into a sub-second rejection with the fix. With the note the rate dropped to 0–1 per 24.
* Time to first build: the gate adds about 0.5 s per call; on gemini-4-argon the medians differ by 8 s with turns of 1–3 minutes dominated by model latency and the vision review.

### 2.5 Screenshots (gitignored, `test-results/screenshots/sb_stubs/`)

* `05_final_rejected_then_fixed_lantern_errors.jpg`: final code (API `59a49d8fb054`). A lantern script with `glass_tinted(color=(0.8, 0.9, 1.0, 0.4))` and `cage.round_edges(0.01)`: the first call is rejected in 496 ms (red), the chat lists both errors, the second call builds (green). The bad script was supplied in the prompt to show the path.
* `06_final_rejected_then_fixed_lantern_fixed_script.jpg`: the fixed script (`sb.math.Vec4(...)`, `round_edges` removed) and the built model.
* `07_final_successful_build_lighthouse.jpg`: an unprompted build (lighthouse, outcrop, gallery railing, cottage) on the final code; 3 tool actions completed.
* `01`–`04`: the same two flows on an earlier build of the branch (API `147af91f8252`): a 24-tooth gear the model built while avoiding the two non-existent methods the prompt asked for (it cites the stub check), and a lamp post rejected for `bevel_edges` and `duplicate` and then fixed.

---

## 3. What Broke / Didn't Work

* **False rejection of a guarded name** (fixed after the run): `sb.PbrManager if hasattr(sb, 'PbrManager') else ...` was rejected because pyright does not narrow a module on `hasattr`. Fix: `guardedAgainstMissing` in `sb-script-typecheck.ts`, with a test.
* **Two fail-open timeouts** under load (2,012 ms against the 2 s limit); see 2.3.
* **Not caught by design:** wrong keywords to functions that take `**kwargs` (`create_cylinder(radius_bottom=...)` through `create_cone`), wrong argument counts against overloaded native functions (pyright reports these as "No overloads", which also covers plain type mismatches).
* Harness: turns longer than 9 minutes were cut by the harness (7 turns across the two gemini-4-argon runs); script calls made before the cut are counted.

---

## 4. Candidate Tool/Service Ideas

* **Implicit Vec conversions in the bindings** (`nb::implicitly_convertible` from tuples to `Vec2/3/4`, or Python wrappers for the PbrMaterial presets): the single most common API error in these runs was a tuple passed to a native `Vec3/Vec4` parameter. Accepting tuples would remove the error class instead of catching it.
* **A run-metrics endpoint** (`GET /gemini/turns/:id/tools`): the harness had to parse the SSE stream to count script calls, outcomes and timings; the server already has all of it.
* **Syntax errors in the gate**: pyright already reports them; returning them before running would save a Python start per broken script (3 of the 8 non-API failures in these runs were syntax errors).

---

## 5. Reproduction Steps

1. `npm run stubs:sb` (regenerates stubs and summary; commit both if they change). `packages/core/test/sb-stubs.test.ts` and `sb-script-typecheck.test.ts` cover the generator, drift, summary and gate.
2. Start two instances with distinct ports (`desktop-app/scripts/dev.js`, `SCRATCHBOX_NO_ELECTRON=true PORT=… SCRATCHBOX_WEB_PORT=… SCRATCHBOX_TOOLS_PORT=… SCRATCHBOX_LAUNCH_TOKEN=…`), one on this branch and one on the fork point, with credentials available to the server.
3. For each prompt, `POST /gemini/stream` with `{ prompt, chatHistory: [] }` (and `model: "gemini-3.5-flash-lite"` for the second set) and the `X-Scratchbox-Token` header; record `tool_call` / `tool_result` events for `execute_3d_python_script`. `resultPayload.typeCheck` carries the gate's status and duration; rejected calls also carry `apiErrors`.
