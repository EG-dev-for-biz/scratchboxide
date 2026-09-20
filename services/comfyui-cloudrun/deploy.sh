#!/usr/bin/env bash
###############################################################################
# Scratchbox IDE - ComfyUI Cloud Run Deployment Script
# Deploys containerized ComfyUI API runner to Google Cloud Run
# Maintains parity with upstream ComfyUI and hot-loads dynamic custom nodes.
###############################################################################

set -euo pipefail

SERVICE_NAME="${SERVICE_NAME:-scratchbox-comfyui-runner}"
REGION="${REGION:-us-central1}"
PROJECT_ID="${PROJECT_ID:-$(gcloud config get-value project 2>/dev/null || echo '')}"
ENABLE_GPU="${ENABLE_GPU:-false}"
COMFYUI_BRANCH="${COMFYUI_BRANCH:-master}"
PULL_LATEST="${PULL_LATEST:-true}"

if [ -z "$PROJECT_ID" ]; then
  echo "Error: No Google Cloud project configured. Set PROJECT_ID or run 'gcloud config set project <PROJECT_ID>'."
  exit 1
fi

echo "============================================================"
echo "Deploying Scratchbox ComfyUI Service to Cloud Run"
echo "Project:        $PROJECT_ID"
echo "Service:        $SERVICE_NAME"
echo "Region:         $REGION"
echo "GPU Enabled:    $ENABLE_GPU"
echo "ComfyUI Branch: $COMFYUI_BRANCH"
echo "Pull Latest:    $PULL_LATEST"
echo "============================================================"

IMAGE_TAG="gcr.io/${PROJECT_ID}/${SERVICE_NAME}:latest"

echo "Step 1: Building container image via Google Cloud Build..."
BUILD_ARGS=""
if [ "$PULL_LATEST" = "true" ]; then
  BUILD_ARGS="--no-cache"
fi

gcloud builds submit \
  --project="$PROJECT_ID" \
  --tag="$IMAGE_TAG" \
  .

echo "Step 2: Deploying to Google Cloud Run..."
if [ "$ENABLE_GPU" = "true" ]; then
  echo "Configuring Cloud Run deployment with NVIDIA L4 GPU acceleration..."
  gcloud run deploy "$SERVICE_NAME" \
    --project="$PROJECT_ID" \
    --image="$IMAGE_TAG" \
    --region="$REGION" \
    --platform=managed \
    --allow-unauthenticated \
    --port=8080 \
    --cpu=4 \
    --memory=16Gi \
    --gpu=1 \
    --gpu-type=nvidia-l4 \
    --no-cpu-throttling \
    --timeout=3600 \
    --concurrency=4
else
  echo "Configuring Cloud Run deployment with high-memory CPU profile..."
  gcloud run deploy "$SERVICE_NAME" \
    --project="$PROJECT_ID" \
    --image="$IMAGE_TAG" \
    --region="$REGION" \
    --platform=managed \
    --allow-unauthenticated \
    --port=8080 \
    --cpu=4 \
    --memory=8Gi \
    --timeout=1800 \
    --concurrency=8
fi

SERVICE_URL=$(gcloud run services describe "$SERVICE_NAME" --project="$PROJECT_ID" --region="$REGION" --format='value(status.url)')

echo "============================================================"
echo "Deployment Complete!"
echo "Service URL: $SERVICE_URL"
echo "============================================================"
