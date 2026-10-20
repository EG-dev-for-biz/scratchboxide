# Process: Tool consolidation steps 1-2 checked live (resection aliases hidden, AI Beautify template inside generation)

> **Recorded:** 2026-10-20
> **Status:** Verified
> **Tags:** `operate-scratchbox` `tools` `aliases` `prompt-templates` `gemini-agent-chat`
> **Target Domain:** Gemini Agent Chat / in-app tool registry

---

## 1. Session Context

* **What prompted this session:** steps 1 and 2 of `tool_consolidation_plan.md`: hide the two resection aliases (`geobox_resect_camera_pose`, `spatial_resect_image_location`) and the three prompt-template tools (`build_beautify_prompt`, `build_neutral_performer_prompt`, `build_frame_motivated_performer_prompt`), and check in the live app that the model picks the kept name.
* **Instance used:** web port `3080`, API port `3081`, tools port `3082` (own `scratchbox-tool-aliases-templates` entry in `.claude/launch.json`, `npm --prefix` at the `tool-aliases-templates` worktree). Credentials through a temporary `secrets.json` symlink to the integration-behaviour worktree, removed afterwards.
* **Scope tested:** one chat asking for a camera resection of a photo from stated heading, pitch and standoff.

---

## 2. What Was Tested & What Worked (Verified)

* **Resection chat uses the kept name** — prompt: "Resect the camera location of the photo public/esb_west_5thave.jpg. It shows the Empire State Building in New York from West 5th Avenue; the camera heading is 60 degrees, pitch 25 degrees, standoff 180 m. Report the camera's latitude, longitude, heading and FOV." → the chat card reads `Executed tool: geobox_resect_image_location` (504 ms), neither alias was called, and the answer reports camera 40.747706, -73.987337, heading 60°, pitch 25°, horizontal FOV 69.39° (26 mm focal length assumed; pixels not analysed), target resolved with Google Places at 40.748441, -73.985664 (ground 18.53 m). Answered by `gemini-4-argon` on Vertex AI. Evidence: `test-results/screenshots/tool_aliases_live_resection_chat.jpg` (gitignored); console had no errors before and after.
* **Clean load** — `read_console_messages({onlyErrors: true})` → "No console logs."; server log shows all three ports bound and the native warm-ups ready.

---

## 3. What Broke / Didn't Work

Nothing broke in this session.

---

## 4. Candidate Tool/Service Ideas

* **Tool-call audit endpoint** — an API that returns, for the last chat turn, the function declarations the model was offered and the calls it made — this session read the chat card's "Executed tool" line from page text instead, which cannot show which tools were *offered*.

---

## 5. Reproduction Steps

1. In the worktree: `ln -s ../../integration-behaviour/secrets.json desktop-app/secrets.json` (remove afterwards).
2. `preview_start({name: "scratchbox-tool-aliases-templates"})`, read the token URL from `preview_logs`, navigate to it.
3. Send the prompt in section 2; read the page text for the `Executed tool:` line.
