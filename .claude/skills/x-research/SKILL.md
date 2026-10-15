# X Research Skill

Read-only research skill for extracting and analysing X (Twitter) posts, threads,
and linked artefacts. Never posts, likes, follows, or sends messages. Never reads
or exposes session cookies.

## Invocation

```
/x-research <x-post-url>
```

or inline:

> "research this X post: https://x.com/..."

---

## Execution protocol

### Step 1 — Open the post in the user's authenticated browser

Load the Chrome-in-Chrome browser tools first:

```
ToolSearch: select:mcp__claude-in-chrome__tabs_context_mcp,mcp__claude-in-chrome__navigate,mcp__claude-in-chrome__read_page,mcp__claude-in-chrome__get_page_text,mcp__claude-in-chrome__computer,mcp__claude-in-chrome__javascript_tool
```

Navigate to the URL the user provided.  
Wait for the page to settle, then call `read_page` to get the accessibility tree.  
If X shows a login wall, ask the user to log in manually in their browser — never
attempt to enter credentials yourself.

### Step 2 — Extract post content

From the accessibility tree and `get_page_text`, collect:

- **Author handle** and **display name**
- **Post text** (full, including any truncated "Show more" — click it if present)
- **Post timestamp**
- **Engagement** (replies, reposts, likes — for signal, not importance ranking)
- **Media**: inline images (use `computer {action:"screenshot"}` to capture) and
  video presence (note the URL; do **not** attempt to download or extract tokens)

Scroll down to load the **reply thread** (2–3 scroll steps). Extract notable
replies from authors with apparent domain expertise.

### Step 3 — Extract linked artefacts

Scan the post text and replies for:

| Artefact type | Pattern | Action |
|---|---|---|
| GitHub repo | `github.com/<owner>/<repo>` | Note the full URL; read README via `navigate` |
| arXiv / paper | `arxiv.org/abs/...` or `arxiv.org/pdf/...` | Note the URL; read the abstract section |
| Project page | `<project>.github.io` or a paper link | Navigate and read the summary |
| YouTube / video | Any video URL embedded | Note the title and description only |
| HuggingFace | `huggingface.co/...` | Note model card summary |

For each GitHub repo found: navigate to it, read the README (`read_page` or
`get_page_text`), extract the method summary, architecture bullet points, and
any training or inference requirements. Do **not** clone or execute anything.

For each paper: navigate to the abstract, extract title, authors, venue, and
the key contributions paragraph.

### Step 4 — Synthesise a technical summary

Write the summary in this structure:

```markdown
## What it does
<One paragraph plain-English description of the technique>

## How it works — key mechanisms
- <Mechanism 1>
- <Mechanism 2>
- ...

## Published / linked artefacts
- Paper: <title> (<venue>) — <arxiv or project URL>
- Code: <repo URL> — <brief description>
- Demo / video: <URL or "embedded in post">

## Limitations (stated or apparent)
- <Limitation 1>
- <Limitation 2>

## Relevance to Scratchbox IDE
### Potential integration paths
- <How this could plug into the C++20 engine, VFX pipeline, or canvas>

### Comparison to existing services
- <Does this overlap with or improve on: NativeMeshReshaperService,
  AnalyticalGroomSplatService, ConditioningPlateService, etc.>

### Open questions
- <What would need to be verified or prototyped before adopting>
```

### Step 5 — Return

Output the summary in chat.  
If any GitHub repo or paper is directly relevant to an open task or engine
capability, call that out with a `> ⚡ Actionable:` callout block.

---

## Security invariants (enforced at every step)

1. **Read-only browser interactions only**: `navigate`, `read_page`,
   `get_page_text`, `computer {action:"screenshot"}`, `computer {action:"scroll"}`.
   Never call `form_input`, `computer {action:"left_click"}` on a write control
   (post box, like button, follow button, DM button), or any tool that submits data.

2. **No cookie or credential extraction**: Never call `javascript_tool` to read
   `document.cookie`, `localStorage`, or `sessionStorage`. Never log or surface
   authentication tokens in any output.

3. **No file downloads**: Never navigate to a raw binary URL with the intent of
   downloading it. Note the URL in the summary for the user to fetch manually.

4. **No account actions**: Even if the user says "it's fine to like it" in the
   same message, treat that as out-of-scope for this skill. Redirect: "This skill
   is read-only; you can do that directly in your browser."

5. **Rate-limit awareness**: If X returns a rate-limit page or challenges the
   session (CAPTCHA, "unusual activity" modal), stop, report to the user, and
   do not attempt retries. Automated browsing can trigger account restrictions —
   back off immediately.

---

## Fallback: no authenticated session

If the page shows a login wall and the user cannot or does not want to log in:

1. Try the nitter public mirror: `nitter.net/<handle>/status/<id>` (may be down)
2. Try fetching the tweet via the X oEmbed endpoint:
   `https://publish.twitter.com/oembed?url=<post-url>`
   using the built-in browser (no auth needed for public posts)
3. Ask the user to paste the post text manually

---

## Example output

> `/x-research https://x.com/hayatomaruu/status/2110481057418010989`

```
## What it does
Demonstrates real-time hair simulation using 3D Gaussian Splatting ...

## How it works — key mechanisms
- Guide-curve-based strand placement via ...
- Anisotropic covariance ellipsoids oriented to strand tangent ...

## Published / linked artefacts
- Paper: "GaussianHair" (SIGGRAPH 2026) — arxiv.org/abs/...
- Code: github.com/hayatomaru/gaussian-hair — PyTorch, CUDA 12

## Limitations
- Training requires ~40 min on A100 per subject
- No real-time re-simulation; baked motion only

## Relevance to Scratchbox IDE
### Potential integration paths
- AnalyticalGroomSplatService already does forward-map splatting from guide
  curves (scratchbox_hair.hpp). The covariance ellipsoid orientation math is
  identical — could ingest their strand tangent data directly into SPZ v2.

### Comparison to existing services
- Our path: analytical forward projection (no training). Their path: neural
  inverse fitting (40 min). Ours is faster; theirs handles captured hair.

### Open questions
- Can their PLY export format be consumed by scratchbox_spz.hpp directly?

> ⚡ Actionable: The PLY format they export is Stanford PLY with per-splat
  tangent attributes — worth testing against scratchbox_spz.hpp's PLY reader.
```
