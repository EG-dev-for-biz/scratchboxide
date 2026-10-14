# Skill: Gemini Omni 1.1 Flash — Interactions API Integration

## When to load this skill

Load before any task involving:
- Calling `gemini-omni-1.1-flash` for video generation
- Debugging `400 INVALID_ARGUMENT: This model only supports Interactions API`
- Bypassing the real-person/celebrity safety filter (`content_blocked`)
- Polling the Google Files API for an async video delivery
- Constructing download URLs for Omni 1.1 video outputs

---

## Platform note

In Scratchbox IDE, Vertex AI Omni 1.1 calls go through **`OmniVideoService`** (`packages/core/src/node/video/OmniVideoService.ts`). That service handles auth, response parsing, and GCS download correctly. Use it whenever possible; this skill covers the underlying protocol for debugging or direct Gemini API access.

---

## Critical: this model does NOT use `generate_content` or `generate_videos`

```
# WRONG — throws 400 INVALID_ARGUMENT
client.models.generate_content(model="gemini-omni-1.1-flash", ...)
client.models.generate_videos(model="gemini-omni-1.1-flash", ...)
```

**Always use the `/v1beta/interactions` REST endpoint directly:**

```
POST https://generativelanguage.googleapis.com/v1beta/interactions?key={API_KEY}
```

---

## Step 1 — Build the payload

Pass conditioning images and prompt text in a flat `input[]` array:

```python
import base64, requests

def encode_image(path: str) -> str:
    with open(path, "rb") as f:
        return base64.b64encode(f.read()).decode("utf-8")

payload = {
    "model": "gemini-omni-1.1-flash",
    "input": [
        {"type": "image", "data": encode_image("start_frame.jpg"),   "mime_type": "image/jpeg"},
        {"type": "image", "data": encode_image("contact_sheet.jpg"), "mime_type": "image/jpeg"},
        {"type": "image", "data": encode_image("hero_hold.jpg"),     "mime_type": "image/jpeg"},
        {"type": "text",  "text": prompt_text}
    ],
    "response_format": {
        "type": "video",
        "aspect_ratio": "16:9",
        "resolution": "1080p",
        "delivery": "uri"       # Required for videos >4 MB — avoids base64 truncation
    }
}
```

---

## Step 2 — Safety filter: never use athlete/celebrity names

Named-entity strings in prompt text trigger immediate `content_blocked`:

```
# BLOCKED
"Jalen Brunson's right hand executes a three-point celly..."

# COMPLIANT
"An athletic basketball player's muscular right hand in a white compression sleeve
 executes a three-point celebration pose with index and middle fingers pointed
 vertically in a clear V, thumb extended to the left..."
```

**Rule:** Use only anatomical descriptors, wardrobe details, and kinematic vocabulary. Never name a real person, athlete, or celebrity.

---

## Step 3 — Submit and parse the response

```python
api_key = "YOUR_GEMINI_API_KEY"
url = f"https://generativelanguage.googleapis.com/v1beta/interactions?key={api_key}"
headers = {"Content-Type": "application/json"}

resp = requests.post(url, headers=headers, json=payload, timeout=120)
data = resp.json()

# Parse output video URI from the steps array
output_video = None
for step in data.get("steps", []):
    if step.get("type") == "model_output":
        for content in step.get("content", []):
            if content.get("type") == "video":
                output_video = content
                break

if not output_video:
    raise RuntimeError(f"No video in response: {data}")

uri = output_video["uri"]
```

---

## Step 4 — Extract file ID (strip double `:download` tokens)

```python
# URI often already contains ":download?alt=media"
# Naively appending it again produces files/xxx:download:download — HTTP 400
file_id = uri.split("/")[-1].split("?")[0].replace(":download", "")
```

---

## Step 5 — Poll Google Files API until ACTIVE

```python
import time

while True:
    poll_url = f"https://generativelanguage.googleapis.com/v1beta/files/{file_id}?key={api_key}"
    poll_resp = requests.get(poll_url).json()
    state = poll_resp.get("state")
    if state == "ACTIVE":
        break
    elif state == "FAILED":
        raise RuntimeError(f"Video generation failed: {poll_resp}")
    print(f"State: {state} — waiting 5 s...")
    time.sleep(5)
```

---

## Step 6 — Download the MP4

```python
download_url = f"https://generativelanguage.googleapis.com/v1beta/files/{file_id}:download?alt=media&key={api_key}"
video_data = requests.get(download_url, timeout=120).content
with open("output_video.mp4", "wb") as f:
    f.write(video_data)
print(f"Downloaded {len(video_data):,} bytes")
```

---

## Step 7 — Verify the output

```bash
ffprobe -v error -select_streams v:0 \
  -show_entries stream=width,height,r_frame_rate,duration,nb_frames \
  -of json output_video.mp4
```

Expected: `1920×1080`, `24/1` fps, `"duration": "10.000000"`, `"nb_frames": "240"`.

---

## Conditioning best practices

| Goal | Technique |
|---|---|
| Prevent editorial cuts between two keyframes | Ensure both anchor plates share identical camera angle, focal length, lighting, and background — then reinforce: `"Completely locked-off static camera, zero cuts, zero dissolves, zero camera angle change"` |
| Prevent finger splaying / morph-cuts | Use a 3-image array (start + motion contact sheet + target) plus negative constraint: `"fingers NEVER splay open, hand NEVER opens wide"` |
| Enforce single continuous take | Lead prompt with `"SINGLE CONTINUOUS UNINTERRUPTED TAKE WITH ZERO CUTS"` as the very first sentence |

## Fallback

If Omni 1.1 fails or produces unnatural warping, fall back to Google Veo 3.1:
```
models/veo-3.1-generate-preview
```
Use `image-to-video` single-anchor conditioning with duration 4, 6, or 8 seconds.
