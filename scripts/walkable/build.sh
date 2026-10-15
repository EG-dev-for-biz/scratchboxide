#!/usr/bin/env bash
# Bundles the walkable 3DGS viewer (the app's PhotorealGaussianSplatMesh renderer) into
# public/js/walkable_3dgs_viewer.js. Run from anywhere.
set -euo pipefail
cd "$(dirname "$0")/../.."
mkdir -p public/js
npx esbuild scripts/walkable/walkable_3dgs_viewer.ts \
  --bundle --format=iife --platform=browser --target=es2022 \
  --outfile=public/js/walkable_3dgs_viewer.js \
  --log-level=warning
echo "built public/js/walkable_3dgs_viewer.js"
