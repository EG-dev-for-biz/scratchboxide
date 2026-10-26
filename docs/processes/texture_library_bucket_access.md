# Process: Reading the GCS texture library from the app (signing route, bucket access, CORS)

> **Recorded:** 2026-10-26
> **Status:** Verified at `http://localhost:3000` (a library texture signed, read and rendered in a 3D material); Needs Fix for every other app origin (bucket CORS)
> **Tags:** `operate-scratchbox` `textures` `gcs` `signed-urls` `iam` `cors`
> **Target Domain:** Desktop app backend (`/api/textures/sign`) / texture-library loading in the viewport

---

## 1. Session Context

* **What prompted this session:** the user asked to use the Google Cloud texture library for building surfaces. Listing it showed the app could not read it at all: the signing route only accepted `textures/` and `extracted_textures/` paths, the bucket's sets sit at its root, and the app's service account had no read access.
* **Instances used:** web port `3400`, API port `3401`, tools port `3402` for the route checks; then web port `3000`, API `3501`, tools `3502` for the 3D material check, since `http://localhost:3000` is an origin the bucket's CORS already allows (own `scratchbox-texture-access` entry in `.claude/launch.json`, removed afterwards).
* **Scope tested:** `GET /api/textures/sign` for library, legacy, missing and out-of-root paths, before and after the bucket grant; loading the signed URL as an image, in CORS mode and plain; loading a library texture into a three.js `MeshPhysicalMaterial` and rendering it.

### The bucket (`gs://scratchbox-library-training-textures`, project `scratchbox-library-training`)

* 26,653 objects, 1.82 TiB, at the bucket root: about 2,211 ambientCG sets (`Bricks001/`, `Granite003A/`: Color, NormalGL/DX, Roughness, Displacement, often Metalness, mostly 8K, plus `.mtlx`, `.usdc`, `.blend`, `.tres`) and 322 Poly Haven sets (`castle_brick_02_white/`, 8K PNG).
* **No index.** No JSON, CSV or catalogue anywhere. The `.mtlx` files carry no real-world size (`uvtiling 1, 1`).
* **Junk:** three interrupted uploads (`dark_paneled_wood/…_arm_8k.png.part`, `dark_rock_02/…_nor_dx_8k.png.part`, `gingham_check/…_nor_gl_8k.png.part`), `gcloud/tmp/parallel_composite_uploads/…`, `.DS_Store`, three `Thumbs.db`.
* **Nothing under `textures/` or `extracted_textures/`:** the 78 files of `public/textures/` (e.g. `pbr50/indiana_limestone_albedo.png`) were never uploaded, yet `app.ts` has 404'd those paths locally since commit 9f100986.

---

## 2. What Was Tested & What Worked (Verified)

* **New root `texture-library/<set>/<file>`** (`desktop-app/server/routes/textureRoutes.ts`, `textureObjectKey`) maps to the set at the bucket root. After the grant, `texture-library/Facade001/Facade001.png` → 200, key `Facade001/Facade001.png`, a v4 URL on `storage.googleapis.com` carrying `X-Goog-Signature`; `texture-library/Bricks001/Bricks001_8K-JPG_Color.jpg` → 200.
* **Read checked before signing.** A signature is minted locally whatever the signer may read, which is how 9f100986 was recorded as verified while the app could read nothing. The route now reads the object's metadata first.
  - Before the grant, every library path → 403 `agentplatform@scoutscan.iam.gserviceaccount.com cannot read gs://scratchbox-library-training-textures: grant it roles/storage.objectViewer on the bucket`.
  - After it, a missing object → 404 `No texture "NoSuchSet/x.png" in gs://scratchbox-library-training-textures`; `textures/pbr50/indiana_limestone_albedo.png` → 404 the same way.
* **Out-of-root paths refused:** `secrets/x` → 400 `Texture path must start with one of: texture-library/, textures/, extracted_textures/`.
* **Bucket grant** (run by the user): `roles/storage.objectViewer` for `serviceAccount:agentplatform@scoutscan.iam.gserviceaccount.com` on the bucket; seen in `get-iam-policy`. The first re-check right after the grant still gave 403 (propagation); a minute later it read.
* **The file is served:** the signed URL loads as a 512×512 image with no `crossOrigin`; opened in a tab it shows ambientCG's `Facade001` preview sphere (glass curtain wall).
* **Into a 3D material** (page at `http://localhost:3000`) — in the running page, the app's own `resolveTextureUrl` (`packages/core/src/common/texture-url-resolver.ts`, loaded through Vite) resolved `texture-library/Facade001/Facade001_4K-PNG_Color.png`, the app's three.js r186 `TextureLoader` (CORS mode) loaded it, and it was set as the `map` of a `MeshPhysicalMaterial` on a plane and rendered by a `WebGLRenderer`. Evidence: image 4096×4096, `material.map` set, `readPixels` 35,344 lit pixels in 48 distinct colours (mean RGB 81, 87, 92); the screenshot shows the curtain-wall grid on the plane. This is the chain `loadPbrTexture` in `syncCustomMeshes.ts` runs; no scene node was used, because the agent's canvas tools refuse `customMeshes` (`canvas-tools.ts:306`), so no live session reaches that loader with a library texture.
* **Control:** the same load from `http://127.0.0.1:3000` fails, console: `Access to image at 'https://storage.googleapis.com/scratchbox-library-training-textures/Facade001/Facade001_4K-PNG_Color.png?…' from origin 'http://127.0.0.1:3000' has been blocked by CORS policy: The 'Access-Control-Allow-Origin' header has a value 'http://localhost:3000' that is not equal to the supplied origin.`
* **Tests:** `desktop-app/test/texture-routes.test.ts`, 4/4 passing with credentials unreachable (new: each root's mapping, a bare root and traversal refused). Typecheck: no errors in the changed files (the one remaining error, `treeCrownShading.ts:763` `ShaderChunk`, predates this work).

---

## 3. What Broke / Didn't Work

* **Textures cannot reach WebGL from the usual app origins** — from `http://127.0.0.1:3400` the same signed URL with `img.crossOrigin = 'anonymous'` (what `THREE.TextureLoader` sets) → `failed to load`; `fetch(url)` → `Failed to fetch`. A CORS update to add the dev origins was attempted after this, but the bucket still showed the original three origins when re-read.
  - Console evidence: none from the image itself (load error only); `fetch` rejects with `TypeError: Failed to fetch`.
  - Network evidence: the bucket's CORS config allows only `http://localhost:3000`, `https://app.scratchbox.com`, `http://localhost:5173` (GET/HEAD, header `Content-Type`). The app runs at `http://127.0.0.1:<web-port>` (Electron's `DEV_RENDERER_URL` defaults to `http://<host>:3030`), so no request from it gets `Access-Control-Allow-Origin`.
  - Suspected cause: bucket CORS config. Fix: add the app's origins (`http://127.0.0.1:3030`, `http://localhost:3030`, and any other port in use) to the bucket's CORS, or serve the bytes through the backend instead of a redirect to GCS. Not changed in this session (a bucket setting, the owner's call).
* **Legacy `textures/…` paths 404** — not changed: the objects are not in the bucket, and the server no longer serves `public/textures/`. Either upload them under `textures/` or serve them locally again.

---

## 4. Candidate Tool/Service Ideas

* **Texture library index builder** — writes the bucket's sets into `assets/textures/surfaces/index.json` (`scratchbox.surface-textures/1`): real size from the ambientCG / Poly Haven metadata, colour and relief statistics from the maps. This session could only list folder names.
* **`/api/textures/check`** — signs a path and loads it the way three.js does (CORS mode) server-side or in a headless page, reporting signing, reading and CORS separately. This session hand-rolled all three in the page console.
* **Bucket hygiene report** — lists `.part` uploads, gcloud temp objects and incomplete sets (missing a Color or Normal map), so broken sets are never offered.

---

## 5. Reproduction Steps

1. Add a launch entry on free ports (here 3400/3401/3402, with `SCRATCHBOX_ALLOWED_ORIGINS` for 3400) and `preview_start` it; open the token URL from `preview_logs`.
2. In the page console: `await (await fetch('/api/textures/sign?path=texture-library/Facade001/Facade001.png')).json()` → `success: true`, a `storage.googleapis.com` URL.
3. Load that URL with `new Image()`: plain → 512×512; with `crossOrigin = 'anonymous'` → error until the bucket's CORS allows the page's origin.
4. For the material check, run the instance with `SCRATCHBOX_WEB_PORT=3000` and open the token URL on `localhost` (not `127.0.0.1`). In the console, `import()` the resolver from `/@fs/<repo>/packages/core/src/common/texture-url-resolver.ts` and three.js from `/node_modules/.vite/deps/three.js?v=<hash>` (the hash is in the network log), load the texture with `TextureLoader`, set it as a `MeshPhysicalMaterial` map, render and `readPixels`.
4. `gcloud storage buckets describe gs://scratchbox-library-training-textures --format="json(cors_config)"` shows the allowed origins.
