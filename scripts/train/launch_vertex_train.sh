#!/usr/bin/env bash
# ==============================================================================
# Scratchbox IDE - Launch TRELLIS Urban Fine-Tuning Job on GCP Vertex AI
# ==============================================================================
set -euo pipefail

PROJECT_ID="${GCP_PROJECT_ID:-$(gcloud config get-value project 2>/dev/null || echo 'scratchbox-ai')}"
REGION="${GCP_REGION:-us-central1}"
JOB_NAME="trellis-urban-remesh-$(date +%Y%m%d-%H%M%S)"
IMAGE_URI="us-docker.pkg.dev/${PROJECT_ID}/trellis-repo/trellis-trainer:v1"
BUCKET_DATASET="gs://${PROJECT_ID}-trellis-dataset"
BUCKET_CHECKPOINTS="gs://${PROJECT_ID}-trellis-checkpoints"
MACHINE_TYPE="${GCP_MACHINE_TYPE:-a2-ultragpu-8g}" # 8x A100 80GB (or g2-standard-96 for 8x L4)

echo "======================================================================"
echo " Launching TRELLIS Urban Training on Google Cloud Platform"
echo " Project:       ${PROJECT_ID}"
echo " Region:        ${REGION}"
echo " Machine Type:  ${MACHINE_TYPE}"
echo " Image:         ${IMAGE_URI}"
echo " Dataset:       ${BUCKET_DATASET}"
echo " Checkpoints:   ${BUCKET_CHECKPOINTS}"
echo "======================================================================"

# 1. Ensure Buckets Exist
gsutil ls -b "${BUCKET_CHECKPOINTS}" 2>/dev/null || gsutil mb -l "${REGION}" "${BUCKET_CHECKPOINTS}"

# 2. Submit Vertex AI Custom Job
gcloud ai custom-jobs create \
  --region="${REGION}" \
  --display-name="${JOB_NAME}" \
  --worker-pool-spec="machine-type=${MACHINE_TYPE},replica-count=1,container-image-uri=${IMAGE_URI}" \
  --args="--dataset_path=${BUCKET_DATASET}/shards,--output_dir=${BUCKET_CHECKPOINTS},--batch_size=64,--lr=1e-4,--mixed_precision=bf16,--total_steps=100000"

echo "[SUCCESS] Vertex AI Custom Training Job submitted: ${JOB_NAME}"
echo "Monitor logs: gcloud ai custom-jobs describe ${JOB_NAME} --region=${REGION}"
