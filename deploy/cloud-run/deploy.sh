#!/usr/bin/env bash
set -euo pipefail

################################################################################
# Deploy Scratchbox 3D Photogrammetry & Tile Cleanup Service to Google Cloud Run
#
# Usage:
#   ./deploy/cloud-run/deploy.sh [PROJECT_ID] [REGION]
################################################################################

PROJECT_ID="${1:-$(gcloud config get-value project 2>/dev/null || echo "")}"
REGION="${2:-us-central1}"
SERVICE_NAME="scratchbox-tile-cleanup"
IMAGE_TAG="gcr.io/${PROJECT_ID}/${SERVICE_NAME}:latest"

if [ -z "${PROJECT_ID}" ]; then
  echo "Error: Google Cloud project ID not specified and could not be detected."
  echo "Usage: ./deploy/cloud-run/deploy.sh <PROJECT_ID> [REGION]"
  exit 1
fi

echo "=========================================================="
echo "Deploying ${SERVICE_NAME} to Google Cloud Run"
echo "Project: ${PROJECT_ID}"
echo "Region:  ${REGION}"
echo "Image:   ${IMAGE_TAG}"
echo "=========================================================="

# 1. Build and push multi-stage container image via Google Cloud Build
echo "[1/3] Building container image via Google Cloud Build..."
gcloud builds submit --tag "${IMAGE_TAG}" --project "${PROJECT_ID}" .

# 2. Deploy to Google Cloud Run
echo "[2/3] Deploying service to Cloud Run..."
gcloud run deploy "${SERVICE_NAME}" \
  --image "${IMAGE_TAG}" \
  --platform managed \
  --region "${REGION}" \
  --project "${PROJECT_ID}" \
  --allow-unauthenticated \
  --port 3001 \
  --cpu 2 \
  --memory 2Gi \
  --concurrency 80 \
  --timeout 300 \
  --set-env-vars NODE_ENV=production,HOST=0.0.0.0,PORT=3001

# 3. Retrieve service URL
SERVICE_URL=$(gcloud run services describe "${SERVICE_NAME}" --platform managed --region "${REGION}" --project "${PROJECT_ID}" --format 'value(status.url)')

echo "=========================================================="
echo "Deployment Complete!"
echo "Service URL: ${SERVICE_URL}"
echo "Health Check: curl ${SERVICE_URL}/health"
echo "Tile Status: curl ${SERVICE_URL}/api/3d/tiles/status"
echo "=========================================================="
