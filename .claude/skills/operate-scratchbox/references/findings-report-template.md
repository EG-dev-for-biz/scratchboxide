# Process: <Short, specific title of what was tested>

> **Recorded:** <YYYY-MM-DD>
> **Status:** <Verified | Needs Fix | Unverified>
> **Tags:** `operate-scratchbox` `<feature-area>` `<more-tags>`
> **Target Domain:** <e.g. "Generative Canvas / 3D Viewport", "Gemini Agent Chat", "Workspace & Git Panel">

---

## 1. Session Context

* **What prompted this session:** <the task/request that led to operating the app — one or two sentences>
* **Instance used:** web port `<N>`, API port `<N>`, tools port `<N>` (set in `.claude/launch.json`'s `scratchbox-dev` entry)
* **Scope tested:** <the specific feature(s)/flow(s) exercised — be specific, not "the app in general">

---

## 2. What Was Tested & What Worked (Verified)

For each thing exercised, state the concrete action and the concrete evidence — not "it works," but what you clicked/called and what you observed:

* **<Feature/flow name>** — <action taken> → <observed result>. Evidence: <console output / network response / screenshot description>.

---

## 3. What Broke / Didn't Work

Only include items you actually observed fail in this live session — not speculation.

* **<Feature/flow name>** — <action taken> → <what went wrong>.
  - Console evidence: ```<exact error text, or "none — failed silently">```
  - Network evidence: ```<failed request + status, or "n/a">```
  - Suspected cause (if known): <file:line or component, if you traced it; otherwise "not investigated">

If nothing broke, say so explicitly rather than omitting this section.

---

## 4. Candidate Tool/Service Ideas

Concrete, scoped gaps noticed while operating the app — things that needed a manual UI workaround, a hand-rolled verification step, or an API call that doesn't exist yet. Not vague wishes ("better testing") — name the specific capability and why it would have helped in this session.

* **<Idea name>** — <what it would do> — <what this session had to do manually instead, that this would replace>.

---

## 5. Reproduction Steps

Minimal steps for someone (or a future Claude Code session) to get back to this exact state, so findings don't go stale as unverifiable claims:

1. <step>
2. <step>
3. ...
