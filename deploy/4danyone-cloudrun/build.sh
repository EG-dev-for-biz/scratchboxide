#!/bin/bash
# Builds the Cloud Run job image with Cloud Build and (re)creates the GPU job.
#   deploy/4danyone-cloudrun/build.sh [4DAnyone checkout, default ~/dev/4DAnyone-main]
#   SKIP_BUILD=1 deploy/4danyone-cloudrun/build.sh   # only (re)create the job
# Cloud Run caps GPU task time at 1 hour; jobs therefore run as separate inference and refine executions.
set -euo pipefail

PROJECT=$(gcloud config get-value project 2>/dev/null)
REGION=us-central1
BUCKET=scratchbox-canvas-4danyone-artifacts
JOB=sbx-4danyone-multiview
IMAGE="$REGION-docker.pkg.dev/$PROJECT/cloud-run-source-deploy/$JOB:latest"
SRC="${1:-$HOME/dev/4DAnyone-main}"
HERE="$(cd "$(dirname "$0")" && pwd)"

CTX=$(mktemp -d)
trap 'rm -rf "$CTX"' EXIT
cp "$HERE/Dockerfile" "$HERE/entrypoint.sh" "$CTX/"
tar -C "$(dirname "$SRC")" --exclude="$(basename "$SRC")/models" --exclude="$(basename "$SRC")/data" \
  --exclude="$(basename "$SRC")/.venv" --exclude='*.png' --exclude='*.jpg' --exclude='__pycache__' \
  --exclude="$(basename "$SRC")/third_party/GVHMR/inputs/checkpoints" \
  -czf "$CTX/4danyone-src.tgz" "$(basename "$SRC")"

[ "${SKIP_BUILD:-0}" = 1 ] || gcloud builds submit "$CTX" --tag "$IMAGE" --machine-type=e2-highcpu-32 --timeout=2h --region "$REGION"

COMMON=(--region "$REGION" --image "$IMAGE" --gpu 1 --gpu-type nvidia-l4 --no-gpu-zonal-redundancy
  --cpu 8 --memory 32Gi --task-timeout 1h --max-retries 0
  # Run the entrypoint shipped with each job's scripts, so script changes never need an image rebuild.
  --command /bin/bash --args "-c,exec bash /mnt/artifacts/jobs/\$JOB_ID/scripts/entrypoint.sh"
  --add-volume "name=artifacts,type=cloud-storage,bucket=$BUCKET"
  --add-volume-mount "volume=artifacts,mount-path=/mnt/artifacts")
if gcloud run jobs describe "$JOB" --region "$REGION" > /dev/null 2>&1; then
  gcloud run jobs update "$JOB" "${COMMON[@]}"
else
  gcloud run jobs create "$JOB" "${COMMON[@]}"
fi
echo "job $JOB ready with $IMAGE"
