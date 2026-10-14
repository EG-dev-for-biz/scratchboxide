#!/usr/bin/env bash
set -euo pipefail

################################################################################
# Deploy Scratchbox Spatial Separator & 3D Bounding Box Service to Cloud Run
#
# Usage:
#   ./deploy/cloud-run/spatial-separator/deploy.sh [PROJECT_ID] [REGION]
################################################################################

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "${REPO_ROOT}"

PROJECT_ID="${1:-scoutscan}"
REGION="${2:-us-central1}"
SERVICE_NAME="scratchbox-spatial-separator"
IMAGE_TAG="us-central1-docker.pkg.dev/${PROJECT_ID}/cloud-run-source-deploy/${SERVICE_NAME}:latest"

echo "=========================================================="
echo "🚀 Deploying ${SERVICE_NAME} to Google Cloud Run"
echo "Project: ${PROJECT_ID}"
echo "Region:  ${REGION}"
echo "Image:   ${IMAGE_TAG}"
echo "=========================================================="

# 0. Bundle standalone microservice and ensure assets
echo "[0/3] Bundling standalone microservice into dist/server.cjs..."
npx esbuild deploy/cloud-run/spatial-separator/server.ts \
  --bundle \
  --platform=node \
  --target=node20 \
  --format=cjs \
  --outfile=deploy/cloud-run/spatial-separator/dist/server.cjs \
  --external:node-fetch \
  --external:fsevents

# 1. Submit lightweight build context (< 4 MB) to Google Cloud Build
echo "[1/3] Submitting self-contained context to Google Cloud Build..."
cd "${REPO_ROOT}/deploy/cloud-run/spatial-separator"
gcloud builds submit \
  --config cloudbuild.yaml \
  --project "${PROJECT_ID}" \
  .

cd "${REPO_ROOT}"

# 2. Retrieve service URL and run verification
echo "[2/3] Retrieving live Cloud Run service endpoint..."
SERVICE_URL=$(gcloud run services describe "${SERVICE_NAME}" --platform managed --region "${REGION}" --project "${PROJECT_ID}" --format 'value(status.url)')

echo "=========================================================="
echo "✨ Deployment Complete!"
echo "Service URL:   ${SERVICE_URL}"
echo "Health Check:  curl -s ${SERVICE_URL}/health"
echo "Run 3D Test:   curl -s ${SERVICE_URL}/api/test/run"
echo "HTML Viewer:   ${SERVICE_URL}/viewer"
echo "=========================================================="

# 3. Verify live endpoints
echo "[3/3] Running live test against Cloud Run service..."
curl -s "${SERVICE_URL}/health"
echo ""
curl -s "${SERVICE_URL}/api/test/run"
echo ""
