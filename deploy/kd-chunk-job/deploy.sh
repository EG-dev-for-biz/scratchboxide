#!/usr/bin/env bash
set -euo pipefail

################################################################################
# Pipeline K-D cloud chunk job (docs/research/2026-10-29-kd-cloud-chunk-runner-plan.md).
#
#   deploy/kd-chunk-job/deploy.sh setup   bucket, secrets, service account, IAM (once)
#   deploy/kd-chunk-job/deploy.sh grants  the IAM bindings alone (needs Owner or Secret Manager Admin)
#   deploy/kd-chunk-job/deploy.sh build   the image of HEAD, tagged with its commit (Cloud Build)
#   deploy/kd-chunk-job/deploy.sh job     the Cloud Run job, pointed at HEAD's image
#   deploy/kd-chunk-job/deploy.sh job-app the job as the app's account, the Maps key from the main checkout's .env
#   deploy/kd-chunk-job/deploy.sh all     the three in order
#   deploy/kd-chunk-job/deploy.sh service the warm worker pool: the same image as a Cloud Run service (kd-chunk-job.ts --serve),
#                                         0 instances between districts, one chunk an instance, as the app's account
#                                         (SERVICE, MAX_INSTANCES; the runner's SCRATCHBOX_KD_CLOUD_SERVICE names it)
#   deploy/kd-chunk-job/deploy.sh vms     the fast VMs: COUNT (default 6) Compute Engine VMs kd-fast-1.. (MACHINE, default
#                                         c3-standard-8) running the image's --poll worker, spread over ZONES (default
#                                         us-central1-a,b,c,f: one zone ran out of C3s at 16), each suspended once its worker
#                                         is ready; a name that exists is kept (the runner's SCRATCHBOX_KD_CLOUD_VMS names
#                                         them as name@zone, SCRATCHBOX_KD_FAST_CHUNKS sets how many chunks go there)
#   deploy/kd-chunk-job/deploy.sh vms-delete  every kd-fast-* VM deleted
#
# Needs your own `gcloud auth login`. Every step creates or changes billed resources in the project.
#
#   SA_KEY_FILE          the app's service-account key (default ~/.scratchbox-ide/service-account.json)
#   GOOGLE_MAPS_API_KEY  the Maps key (setup, and job with KD_JOB_AUTH=app)
#   KD_JOB_AUTH=app      job runs as the app's account, no secrets (when nobody may grant access to them)
#   PROJECT / REGION     default scoutscan / us-central1
#   IMAGE                the job's image (default HEAD's, as build tags it)
#   JOB / CPU / MEMORY   the job's name and task size (default kd-chunk-job, 8, 32Gi); a second size is a second job,
#                        e.g. JOB=kd-chunk-job-4c CPU=4 MEMORY=16Gi, chosen by the runner's SCRATCHBOX_KD_CLOUD_JOB
################################################################################

PROJECT="${PROJECT:-scoutscan}"
REGION="${REGION:-us-central1}"
JOB="${JOB:-kd-chunk-job}"
CPU="${CPU:-8}"
MEMORY="${MEMORY:-32Gi}"
JOB_BUCKET="scoutscan-kd-jobs"
TRAINING_BUCKET="scoutscan-building-training"
JOB_SA="kd-chunk-job@${PROJECT}.iam.gserviceaccount.com"
SA_SECRET="kd-service-account"
MAPS_SECRET="kd-maps-api-key"
SA_KEY_FILE="${SA_KEY_FILE:-$HOME/.scratchbox-ide/service-account.json}"
REPO_ROOT="$(git rev-parse --show-toplevel)"
COMMIT="$(git -C "$REPO_ROOT" rev-parse HEAD)"
IMAGE="${IMAGE:-${REGION}-docker.pkg.dev/${PROJECT}/depthbox3-repo/kd-chunk-job:${COMMIT}}"
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
    package.json package-lock.json tsconfig.json packages/core scripts tools deploy/kd-chunk-job assets/textures \
    packages/cli/package.json desktop-app/package.json
  echo "[build] $IMAGE from $(du -h "$tgz" | cut -f1) of source"
  [ -n "$(git -C "$REPO_ROOT" status --porcelain)" ] && echo "[build] note: the working tree has changes; the image is HEAD ($COMMIT) without them"
  "${G[@]}" builds submit "$tgz" --region "$REGION" --config "$REPO_ROOT/deploy/kd-chunk-job/cloudbuild.yaml" --substitutions "_COMMIT=$COMMIT"
}

job() {
  local app; app="$(app_sa)"
  local common="SCRATCHBOX_TRAINING_BUCKET=$TRAINING_BUCKET,SCRATCHBOX_STORE_BUCKET=off,SCRATCHBOX_CPUS=$CPU,SCRATCHBOX_TEXTURE_WORKERS=$((CPU > 1 ? CPU - 1 : 1))"
  local auth
  if [ "${KD_JOB_AUTH:-secrets}" = "app" ]; then
    # the job runs as the app's account with no key file (the Gemini client's SCRATCHBOX_GOOGLE_ADC fallback), and the Maps
    # key as a plain variable of the job: for a project where nobody here may grant access to the secrets
    [ -n "${GOOGLE_MAPS_API_KEY:-}" ] || { echo "set GOOGLE_MAPS_API_KEY"; exit 1; }
    echo "[job] $JOB -> $IMAGE, as $app, the Maps key a plain job variable"
    auth=(--service-account "$app" --clear-secrets --clear-volumes --clear-volume-mounts --set-env-vars "GOOGLE_CLOUD_PROJECT=$PROJECT,SCRATCHBOX_GOOGLE_ADC=1,GOOGLE_MAPS_API_KEY=$GOOGLE_MAPS_API_KEY,$common")
  else
    echo "[job] $JOB -> $IMAGE, as $JOB_SA, keys from Secret Manager"
    auth=(--service-account "$JOB_SA" \
      --set-secrets "/secrets/sa/key.json=$SA_SECRET:latest,GOOGLE_MAPS_API_KEY=$MAPS_SECRET:latest" \
      --set-env-vars "GOOGLE_APPLICATION_CREDENTIALS=/secrets/sa/key.json,$common")
  fi
  "${G[@]}" run jobs deploy "$JOB" --region "$REGION" --image "$IMAGE" \
    --tasks 1 --max-retries 0 --task-timeout 3h --cpu "$CPU" --memory "$MEMORY" --execution-environment gen2 "${auth[@]}"
  # a job run as the app's own account needs no grant for the app to run it (Editor)
  [ "${KD_JOB_AUTH:-secrets}" = "app" ] \
    || "${G[@]}" run jobs add-iam-policy-binding "$JOB" --region "$REGION" --member "serviceAccount:$app" --role roles/run.developer >/dev/null
}

# The warm worker pool. Request-based billing (CPU only while a chunk is built: the worker answers once its caches are
# mirrored, so nothing runs after), min 0 instances (nothing billed between districts), concurrency 1, an hour a chunk.
service() {
  local app; app="$(app_sa)"
  local name="${SERVICE:-kd-chunk-worker}"
  [ -n "${GOOGLE_MAPS_API_KEY:-}" ] || { echo "set GOOGLE_MAPS_API_KEY"; exit 1; }
  echo "[service] $name -> $IMAGE, as $app, ${CPU} vCPU / ${MEMORY}, 0 to ${MAX_INSTANCES:-100} instances"
  "${G[@]}" run deploy "$name" --region "$REGION" --image "$IMAGE" --service-account "$app" --no-allow-unauthenticated \
    --cpu "$CPU" --memory "$MEMORY" --concurrency 1 --timeout 3600 --min-instances 0 --max-instances "${MAX_INSTANCES:-100}" \
    --execution-environment gen2 --cpu-boost --cpu-throttling \
    --command node --args="--max-old-space-size=28672,-r,ts-node/register,packages/core/src/node/3d-engine/staged-location/kd-chunk-job.js,--serve" \
    --set-env-vars "GOOGLE_CLOUD_PROJECT=$PROJECT,SCRATCHBOX_GOOGLE_ADC=1,GOOGLE_MAPS_API_KEY=$GOOGLE_MAPS_API_KEY,SCRATCHBOX_TRAINING_BUCKET=$TRAINING_BUCKET,SCRATCHBOX_STORE_BUCKET=off,SCRATCHBOX_CPUS=$CPU,SCRATCHBOX_TEXTURE_WORKERS=$((CPU > 1 ? CPU - 1 : 1)),SCRATCHBOX_KD_CHUNK_JOB=1"
}

# The fast VMs: each runs a new container of the image per chunk (docker run --rm in a loop: the chunk builds from the
# image's own files, as a job task does), and is suspended between districts (billed for its disk and kept memory only).
# The container uses the host's network: on resume the VM's network service closes every connection and leaves the docker
# bridge unmanaged, and on 2 of 34 VMs the bridged container never reached the bucket again (2026-11-09).
vms() {
  local app; app="$(app_sa)"
  local count="${COUNT:-6}" machine="${MACHINE:-c3-standard-8}" zones="${ZONES:-us-central1-a,us-central1-b,us-central1-c,us-central1-f}"
  [ -n "${GOOGLE_MAPS_API_KEY:-}" ] || { echo "set GOOGLE_MAPS_API_KEY"; exit 1; }
  local work; work="$(mktemp -d)"; chmod 700 "$work"
  printf 'GOOGLE_CLOUD_PROJECT=%s\nSCRATCHBOX_GOOGLE_ADC=1\nGOOGLE_MAPS_API_KEY=%s\nSCRATCHBOX_TRAINING_BUCKET=%s\nSCRATCHBOX_STORE_BUCKET=off\nSCRATCHBOX_CPUS=8\nSCRATCHBOX_TEXTURE_WORKERS=7\nSCRATCHBOX_KD_CHUNK_JOB=1\nKD_VM_BUCKET=%s\n' \
    "$PROJECT" "$GOOGLE_MAPS_API_KEY" "$TRAINING_BUCKET" "$JOB_BUCKET" > "$work/kd.env"
  cat > "$work/startup.sh" <<'EOS'
#!/bin/bash
export HOME=/var/tmp
md() { curl -s -H 'Metadata-Flavor: Google' "http://metadata.google.internal/computeMetadata/v1/instance/attributes/$1"; }
IMAGE="$(md kd-image)"
md kd-env > /var/tmp/kd.env
docker-credential-gcr configure-docker --registries "${IMAGE%%/*}"
docker pull "$IMAGE"
nohup bash -c "while true; do docker run --rm --name kd --network host --env-file /var/tmp/kd.env $IMAGE node --max-old-space-size=28672 -r ts-node/register packages/core/src/node/3d-engine/staged-location/kd-chunk-job.js --poll 2>&1 | logger -t kd-vm; sleep 1; done" >/dev/null 2>&1 &
EOS
  # the VMs already there, name@zone; each missing name made in the next zone with room (a zone out of C3s is passed over)
  local existing; existing="$("${G[@]}" compute instances list --filter="name~^kd-fast-" --format="value(name,zone.basename())" | awk '{print $1"@"$2}')"
  local made=() all=() z
  IFS=, read -r -a zl <<< "$zones"
  local zi=0
  for i in $(seq 1 "$count"); do
    local n="kd-fast-$i" have
    have="$(printf '%s\n' "$existing" | grep -m1 "^$n@" || true)"
    if [ -n "$have" ]; then all+=("$have"); continue; fi
    "${G[@]}" storage rm "gs://$JOB_BUCKET/kd-vm/$n/**" >/dev/null 2>&1 || true
    local ok=""
    for t in $(seq 0 $(( ${#zl[@]} - 1 ))); do
      z="${zl[$(( (zi + t) % ${#zl[@]} ))]}"
      if "${G[@]}" compute instances create "$n" --zone "$z" --machine-type "$machine" --image-family cos-stable --image-project cos-cloud \
        --boot-disk-size 20GB --boot-disk-type pd-balanced --service-account "$app" --scopes cloud-platform \
        --metadata "kd-image=$IMAGE,google-logging-enabled=true" --metadata-from-file "startup-script=$work/startup.sh,kd-env=$work/kd.env" >/dev/null 2>&1; then
        ok="$z"; zi=$(( (zi + t + 1) % ${#zl[@]} )); break
      fi
    done
    [ -n "$ok" ] || { echo "[vms] $n: no zone in $zones had room"; continue; }
    echo "[vms] $n: $machine in $ok"
    made+=("$n@$ok"); all+=("$n@$ok")
  done
  rm -rf "$work"
  for v in "${made[@]}"; do
    local n="${v%@*}" z="${v#*@}"
    until "${G[@]}" storage ls "gs://$JOB_BUCKET/kd-vm/$n/ready.json" >/dev/null 2>&1; do sleep 5; done
    echo "[vms] $n ready: suspending"
    "${G[@]}" compute instances suspend "$n" --zone "$z" --async >/dev/null
  done
  echo "[vms] done: SCRATCHBOX_KD_CLOUD_VMS=$(IFS=,; echo "${all[*]}") SCRATCHBOX_KD_FAST_CHUNKS=${#all[@]}"
}

vms_delete() {
  local rows; rows="$("${G[@]}" compute instances list --filter="name~^kd-fast-" --format="value(name,zone.basename())")"
  [ -n "$rows" ] || { echo "[vms-delete] none"; return; }
  # in parallel (delete has no --async), each waited for
  while read -r n z; do ( "${G[@]}" compute instances delete "$n" --zone "$z" >/dev/null 2>&1 && echo "[vms-delete] $n ($z)" || echo "[vms-delete] $n ($z) FAILED" ) & done <<< "$rows"
  wait
}

JOB_ID="${JOB_SA%%@*}"
case "${1:-}" in
  setup) setup ;;
  grants) grants ;;
  build) build ;;
  job) job ;;
  job-app)
    # the job as the app's account, the Maps key read from the main checkout's .env (never printed)
    export CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE="$SA_KEY_FILE" KD_JOB_AUTH=app
    G=(gcloud --project "$PROJECT" --quiet)
    ENV_FILE="${ENV_FILE:-$(git -C "$REPO_ROOT" worktree list --porcelain | sed -n '1s/^worktree //p')/.env}"
    GOOGLE_MAPS_API_KEY="${GOOGLE_MAPS_API_KEY:-$(grep -m1 '^GOOGLE_MAPS_API_KEY=' "$ENV_FILE" | cut -d= -f2- | tr -d "\"' \r")}"
    export GOOGLE_MAPS_API_KEY
    job ;;
  all) setup; build; job ;;
  vms|vms-delete)
    export CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE="$SA_KEY_FILE"
    G=(gcloud --project "$PROJECT" --quiet)
    ENV_FILE="${ENV_FILE:-$(git -C "$REPO_ROOT" worktree list --porcelain | sed -n '1s/^worktree //p')/.env}"
    GOOGLE_MAPS_API_KEY="${GOOGLE_MAPS_API_KEY:-$(grep -m1 '^GOOGLE_MAPS_API_KEY=' "$ENV_FILE" | cut -d= -f2- | tr -d "\"' \r")}"
    export GOOGLE_MAPS_API_KEY
    if [ "$1" = vms ]; then vms; else vms_delete; fi ;;
  service)
    # as job-app: the app's account, the Maps key from the main checkout's .env (never printed)
    export CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE="$SA_KEY_FILE"
    G=(gcloud --project "$PROJECT" --quiet)
    ENV_FILE="${ENV_FILE:-$(git -C "$REPO_ROOT" worktree list --porcelain | sed -n '1s/^worktree //p')/.env}"
    GOOGLE_MAPS_API_KEY="${GOOGLE_MAPS_API_KEY:-$(grep -m1 '^GOOGLE_MAPS_API_KEY=' "$ENV_FILE" | cut -d= -f2- | tr -d "\"' \r")}"
    export GOOGLE_MAPS_API_KEY
    service ;;
  *) sed -n '4,32p' "$0"; exit 2 ;;
esac
