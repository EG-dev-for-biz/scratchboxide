#!/usr/bin/env bash
# Bundles the third-party interop page (3d-tiles-renderer + 3dgs plugin + gaussian-splat-lite)
# into public/js/splat_tiles_interop.js. Run from the repo root.
set -euo pipefail
cd "$(dirname "$0")/../.."
mkdir -p public/js
npx esbuild scripts/interop/splat_tiles_interop.ts \
  --bundle --format=iife --platform=browser --target=es2022 \
  --outfile=public/js/splat_tiles_interop.js \
  --log-level=warning
echo "built public/js/splat_tiles_interop.js"
