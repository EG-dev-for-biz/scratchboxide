#!/usr/bin/env bash
# ==============================================================================
# Scratchbox IDE & Demos - Google Cloud Run Deployment Script
# ==============================================================================
set -euo pipefail

# Configuration
SERVICE_NAME="${SERVICE_NAME:-scratchbox-demos}"
REGION="${REGION:-us-central1}"
CPU="${CPU:-2}"
MEMORY="${MEMORY:-4Gi}"
MAX_INSTANCES="${MAX_INSTANCES:-10}"
MIN_INSTANCES="${MIN_INSTANCES:-0}" # Scale to zero for cost optimization

echo "================================================================="
echo " Deploying ${SERVICE_NAME} to Google Cloud Run"
echo " Region:        ${REGION}"
echo " CPU / Memory:  ${CPU} vCPUs, ${MEMORY}"
echo "================================================================="

# 1. Verify gcloud is installed
if ! command -v gcloud &> /dev/null; then
    echo "Error: 'gcloud' CLI is not found. Please install the Google Cloud SDK."
    exit 1
fi

# 2. Get active GCP Project
PROJECT_ID=$(gcloud config get-value project 2>/dev/null || true)
if [ -z "${PROJECT_ID}" ]; then
    echo "Error: No active Google Cloud project set."
    echo "Run: gcloud auth login && gcloud config set project YOUR_PROJECT_ID"
    exit 1
fi
echo "Active GCP Project: ${PROJECT_ID}"

# 3. Enable necessary Google Cloud APIs
echo "Enabling Cloud Run & Cloud Build APIs..."
gcloud services enable \
    run.googleapis.com \
    cloudbuild.googleapis.com \
    artifactregistry.googleapis.com \
    --project="${PROJECT_ID}"

# 4. Deploy directly to Cloud Run from source
echo "Deploying source container to Google Cloud Run..."
gcloud run deploy "${SERVICE_NAME}" \
    --source . \
    --region="${REGION}" \
    --project="${PROJECT_ID}" \
    --allow-unauthenticated \
    --cpu="${CPU}" \
    --memory="${MEMORY}" \
    --min-instances="${MIN_INSTANCES}" \
    --max-instances="${MAX_INSTANCES}" \
    --set-env-vars="PORT=8080,PYTHON_BIN=python3" \
    --timeout=300

# 5. Output Service URL
SERVICE_URL=$(gcloud run services describe "${SERVICE_NAME}" --platform managed --region "${REGION}" --project "${PROJECT_ID}" --format 'value(status.url)')
echo "================================================================="
echo " Deployment Complete!"
echo " Public Service URL: ${SERVICE_URL}"
echo " Showcase Hub:       ${SERVICE_URL}/index.html"
echo " Model Showcase:     ${SERVICE_URL}/model_showcase.html"
echo " DepthBox Studio:    ${SERVICE_URL}/depthbox_demo.html"
echo " 4D Gallery:         ${SERVICE_URL}/s4d_multi_gallery.html"
echo "================================================================="
