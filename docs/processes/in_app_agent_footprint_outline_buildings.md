# Process: In-app agent builds L-plan and courtyard buildings from footprint outlines

> **Recorded:** 2026-10-26
> **Status:** Verified
> **Tags:** `operate-scratchbox` `3d-engine` `python-sb` `architecture` `footprint-outline` `agent-behaviour`
> **Target Domain:** Gemini Agent Chat / Python 3D scripts / 3D Viewport

---

## 1. Session Context

* **What prompted this session:** phase 1 of the polygon-footprint building generator (`footprint=` / `courtyards=` on `sb.create_building_parts`: one facade per edge, corners by angle, flat roofs) was built and unit-tested; the user asked for it to be tested in the real app.
* **Instance used:** web port `3070`, API port `3071`, tools port `3072` (own `.claude/launch.json` entry `scratchbox-cartesian-normal-snapping`, main checkout on branch `feat/cartesian-normal-snapping`, uncommitted phase 1 changes).
* **Scope tested:** two plain-language chat prompts (no API names given) asking for an L-shaped and a courtyard building; the agent's `execute_3d_python_script` calls; the result in the 3D viewport.

---

## 2. What Was Tested & What Worked (Verified)

* **L-plan prompt** ("L-shaped 4-storey brick apartment block, flat roof, wings 28 m and 24 m, 12 m deep, quoins on the outside corners, cornice, continuous second-floor balcony, textured brick") → the agent read the script guide and passed a 6-point `footprint` with `roof="flat"` unprompted. Third run succeeded in 16.2 s: 289,512 vertices, 0 floating parts, visual review ok. Viewport: the L massing, quoins on outside corners, plain inside corner, continuous balconies, cornice and coursed brick all visible. The post-turn visual check scored 68/100 for framing (camera too far and low), not for the building.
* **Courtyard prompt** ("5-storey courtyard block 36 × 28 m with a 16 × 10 m open courtyard, flat roof, pilasters between bays, third-floor balconies facing into the courtyard, textured stone") → succeeded on the **first** run (19.7 s, 334,656 vertices). The agent used `courtyards=[...]` and put the balcony rule on `sides=[4, 5, 6, 7]`, which are the courtyard edges (outer edges first, as documented). Viewport: the open court with its own windows, pilasters, parapet and balconies; the outer facades have none.
* **Refusal messages steer the agent:** in the L-plan turn, the first script asked for `chimney_count: 3` on its own initiative. The engine refused ("chimneys and dormers are not placed on a footprint outline yet: set chimney_count and dormer_width_m to 0, or attach them as add-ons") and the next script dropped them.

---

## 3. What Broke / Didn't Work

* **Agent-invented texture parameter** — the L-plan turn's second script passed `color_variation` to a coursed surface → `ValueError: Unknown coursed surface parameter 'color_variation'`; the agent removed it on the next run. Not related to outlines; the error is clear and the stub check does not catch unknown dict keys.
* **Console:** three `404 (Not Found)` resource errors appear at page load, from the previously open Jefferson Market scene's missing models; they are present before either prompt and are not from these builds.
* **Gap, not a failure:** chimneys and pitched roofs are refused on outlines (phase 3 work); a user asking for chimneys on an L-plan gets none unless the agent builds them as add-ons.

---

## 4. Candidate Tool/Service Ideas

* **Expandable tool-result text in the chat** — clicking an `execute_3d_python_script` row did not show its error; the tracebacks had to be read from `desktop-app/.scratchbox/sessions/<id>.json` and the scripts from `build/3d-python/scene_*.py`.
* **Facade selection by heading** (phase 2 of the outline scope) — the agent had to infer that edges 4–7 are the courtyard; a rule selecting "facades facing into a courtyard" or a heading range would not depend on edge order.
* **Typed surface specs** — validating coursed-surface keys against the stubs would catch `color_variation` before running the script.

---

## 5. Reproduction Steps

1. On `feat/cartesian-normal-snapping` with the phase 1 outline changes, add a launch entry with free ports and `SCRATCHBOX_ALLOWED_ORIGINS`, then `preview_start` it and open the token URL from `preview_logs`.
2. New Chat → send the L-plan prompt above; wait about 2 minutes; click **Open 3D**.
3. New Chat → send the courtyard prompt above; the viewport opens with the result.
