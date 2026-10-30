#!/usr/bin/env bash
set -euo pipefail

################################################################################
# Pipeline K-D cloud chunk job (docs/research/2026-10-29-kd-cloud-chunk-runner-plan.md).
#
#   deploy/kd-chunk-job/deploy.sh setup   bucket, secrets, service account, IAM (once)
#   deploy/kd-chunk-job/deploy.sh grants  the IAM bindings alone (needs Owner or Secret Manager Admin)
#   deploy/kd-chunk-job/deploy.sh build   the image of HEAD, tagged with its commit (Cloud Build)
#   deploy/kd-chunk-job/deploy.sh job     the Cloud Run job, pointed at HEAD's image
#   deploy/kd-chunk-job/deploy.sh all     the three in order
#
# Needs your own `gcloud auth login`. Every step creates or changes billed resources in the project.
#
#   SA_KEY_FILE          the app's service-account key (default ~/.scratchbox-ide/service-account.json)
#   GOOGLE_MAPS_API_KEY  the Maps key (setup only)
#   PROJECT / REGION     default scoutscan / us-central1
################################################################################

PROJECT="${PROJECT:-scoutscan}"
REGION="${REGION:-us-central1}"
JOB="kd-chunk-job"
JOB_BUCKET="scoutscan-kd-jobs"
TRAINING_BUCKET="scoutscan-building-training"
JOB_SA="kd-chunk-job@${PROJECT}.iam.gserviceaccount.com"
SA_SECRET="kd-service-account"
MAPS_SECRET="kd-maps-api-key"
SA_KEY_FILE="${SA_KEY_FILE:-$HOME/.scratchbox-ide/service-account.json}"
REPO_ROOT="$(git rev-parse --show-toplevel)"
COMMIT="$(git -C "$REPO_ROOT" rev-parse HEAD)"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT}/depthbox3-repo/${JOB}:${COMMIT}"
G=(gcloud --project "$PROJECT" --quiet)

app_sa() { python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["client_email"])' "$SA_KEY_FILE"; }

setup() {
  [ -f "$SA_KEY_FILE" ] || { echo "no service-account key at $SA_KEY_FILE (set SA_KEY_FILE)"; exit 1; }
  [ -n "${GOOGLE_MAPS_API_KEY:-}" ] || { echo "set GOOGLE_MAPS_API_KEY"; exit 1; }
  local app; app="$(app_sa)"
  echo "[setup] APIs"
  "${G[@]}" services enable run.googleapis.com cloudbuild.googleapis.com secretmanager.googleapis.com artifactregistry.googleapis.com

  echo "[setup] gs://$JOB_BUCKET with a 7-day lifecycle"
  "${G[@]}" storage buckets describe "gs://$JOB_BUCKET" >/dev/null 2>&1 \
    || "${G[@]}" storage buckets create "gs://$JOB_BUCKET" --location "$REGION" --uniform-bucket-level-access
  local rules; rules="$(mktemp)"
  echo '{"rule":[{"action":{"type":"Delete"},"condition":{"age":7}}]}' > "$rules"
  "${G[@]}" storage buckets update "gs://$JOB_BUCKET" --lifecycle-file "$rules"
  rm -f "$rules"

  echo "[setup] service account $JOB_SA"
  "${G[@]}" iam service-accounts describe "$JOB_SA" >/dev/null 2>&1 \
    || "${G[@]}" iam service-accounts create "$JOB_ID" --display-name "Pipeline K-D chunk job"

  echo "[setup] secrets (a version only when the secret is new)"
  "${G[@]}" secrets describe "$SA_SECRET" >/dev/null 2>&1 \
    || { "${G[@]}" secrets create "$SA_SECRET" --replication-policy automatic && "${G[@]}" secrets versions add "$SA_SECRET" --data-file "$SA_KEY_FILE"; }
  "${G[@]}" secrets describe "$MAPS_SECRET" >/dev/null 2>&1 \
    || { "${G[@]}" secrets create "$MAPS_SECRET" --replication-policy automatic && printf '%s' "$GOOGLE_MAPS_API_KEY" | "${G[@]}" secrets versions add "$MAPS_SECRET" --data-file -; }
  grants
  echo "[setup] done. Cloud Run quota in $REGION must cover SCRATCHBOX_KD_CLOUD_PARALLEL x 8 vCPU (48 x 8 = 384):"
  echo "        https://console.cloud.google.com/iam-admin/quotas?project=$PROJECT&service=run.googleapis.com"
}

# The IAM bindings alone (rerun safely). Setting a secret's policy needs Owner or Secret Manager Admin on the project.
grants() {
  local app; app="$(app_sa)"
  echo "[grants] the job's account reads the two secrets and both buckets"
  for s in "$SA_SECRET" "$MAPS_SECRET"; do
    "${G[@]}" secrets add-iam-policy-binding "$s" --member "serviceAccount:$JOB_SA" --role roles/secretmanager.secretAccessor >/dev/null
  done
  for b in "$JOB_BUCKET" "$TRAINING_BUCKET"; do
    "${G[@]}" storage buckets add-iam-policy-binding "gs://$b" --member "serviceAccount:$JOB_SA" --role roles/storage.objectAdmin >/dev/null
  done
  # the laptop (the app's account) writes requests, reads results, runs and cancels executions as the job's account
  echo "[grants] the app's account ($app) uses the job bucket, the job and the job's account"
  "${G[@]}" storage buckets add-iam-policy-binding "gs://$JOB_BUCKET" --member "serviceAccount:$app" --role roles/storage.objectAdmin >/dev/null
  "${G[@]}" iam service-accounts add-iam-policy-binding "$JOB_SA" --member "serviceAccount:$app" --role roles/iam.serviceAccountUser >/dev/null
  if "${G[@]}" run jobs describe "$JOB" --region "$REGION" >/dev/null 2>&1; then
    "${G[@]}" run jobs add-iam-policy-binding "$JOB" --region "$REGION" --member "serviceAccount:$app" --role roles/run.developer >/dev/null
  else
    echo "[grants] the job does not exist yet: run 'job', which grants run.developer on it"
  fi
  echo "[grants] done"
}

build() {
  # the commit itself, not the working tree: the tag must name exactly what is inside
  local tgz; tgz="$(mktemp -d)/kd-chunk-job-$COMMIT.tgz"
  git -C "$REPO_ROOT" archive --format tar.gz -o "$tgz" "$COMMIT" -- \
    package.json package-lock.json tsconfig.json packages/core scripts tools deploy/kd-chunk-job \
    packages/cli/package.json desktop-app/package.json
  echo "[build] $IMAGE from $(du -h "$tgz" | cut -f1) of source"
  [ -n "$(git -C "$REPO_ROOT" status --porcelain)" ] && echo "[build] note: the working tree has changes; the image is HEAD ($COMMIT) without them"
  "${G[@]}" builds submit "$tgz" --region "$REGION" --config "$REPO_ROOT/deploy/kd-chunk-job/cloudbuild.yaml" --substitutions "_COMMIT=$COMMIT"
}

job() {
  local app; app="$(app_sa)"
  echo "[job] $JOB -> $IMAGE"
  "${G[@]}" run jobs deploy "$JOB" --region "$REGION" --image "$IMAGE" \
    --tasks 1 --max-retries 0 --task-timeout 3h --cpu 8 --memory 32Gi --execution-environment gen2 \
    --service-account "$JOB_SA" \
    --set-secrets "/secrets/sa/key.json=$SA_SECRET:latest,GOOGLE_MAPS_API_KEY=$MAPS_SECRET:latest" \
    --set-env-vars "GOOGLE_APPLICATION_CREDENTIALS=/secrets/sa/key.json,SCRATCHBOX_TRAINING_BUCKET=$TRAINING_BUCKET,SCRATCHBOX_STORE_BUCKET=off,SCRATCHBOX_CPUS=8,SCRATCHBOX_TEXTURE_WORKERS=7"
  "${G[@]}" run jobs add-iam-policy-binding "$JOB" --region "$REGION" --member "serviceAccount:$app" --role roles/run.developer >/dev/null
}

JOB_ID="${JOB_SA%%@*}"
case "${1:-}" in
  setup) setup ;;
  grants) grants ;;
  build) build ;;
  job) job ;;
  all) setup; build; job ;;
  *) sed -n '4,19p' "$0"; exit 2 ;;
esac
