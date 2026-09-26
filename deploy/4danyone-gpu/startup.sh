#!/bin/bash
# GCE startup script for one 4DAnyone multi-view job (submitted by FourDAnyoneCloudService).
# Instance metadata: job-id, bucket, clip, views-per-layer, layer-pitches, refine-iters.
# Reads gs://<bucket>/runtime/4danyone-src.tgz, gs://<bucket>/models/body_models/smplx and
# gs://<bucket>/jobs/<job-id>/{input.mp4,scripts/}; writes status.json, log.txt and output/ back to
# the job prefix, then deletes this instance.
set -euo pipefail
export HOME="${HOME:-/root}"  # startup scripts run without HOME; git and pip need it

META=http://metadata.google.internal/computeMetadata/v1/instance
get() { curl -sf -H 'Metadata-Flavor: Google' "$META/$1"; }
JOB=$(get attributes/job-id)
BUCKET=$(get attributes/bucket)
CLIP=$(get attributes/clip)
VIEWS=$(get attributes/views-per-layer)
PITCHES=$(get attributes/layer-pitches)
ITERS=$(get attributes/refine-iters)
REUSE=$(get attributes/reuse-from || true)
ZONE=$(get zone | awk -F/ '{print $NF}')
NAME=$(get name)
JOBURI="gs://$BUCKET/jobs/$JOB"
LOG=/var/log/4danyone-job.log
exec > >(tee -a "$LOG") 2>&1

status() {
  printf '{"state":"%s","detail":"%s","time":"%s","instance":"%s"}\n' "$1" "$2" "$(date -Is)" "$NAME" \
    | gsutil -q cp - "$JOBURI/status.json"
}
finish() {
  gsutil -q cp "$LOG" "$JOBURI/log.txt" || true
  # The submitting client deletes the instance on done/failed; the default compute service account
  # usually cannot, so power off to stop GPU billing either way (max-run-duration deletes as a backstop).
  timeout 120 gcloud compute instances delete "$NAME" --zone "$ZONE" --quiet || true
  shutdown -h now
}
trap 'status failed "line $LINENO"; finish' ERR

status setup "installing runtime"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq && apt-get install -y -qq ffmpeg python3-venv python3-dev build-essential > /dev/null
mkdir -p /opt/job && cd /opt/job
gsutil -q cp "gs://$BUCKET/runtime/4danyone-src.tgz" . && tar --no-same-owner -xzf 4danyone-src.tgz 2>/dev/null
# 4DAnyone pins the GVHMR revision via git rev-parse; the tarball's checkout was made on another machine.
git config --global --add safe.directory '*'
cd 4DAnyone-main
mkdir -p models/body_models input out
# In-region weight cache: GCS objects are whole files, so a partial cache is safe; inference downloads
# whatever is missing from Hugging Face and the job syncs it back.
MODEL_CACHE="gs://$BUCKET/runtime/models"
status setup "pulling cached weights"
gsutil -q -m rsync -r "$MODEL_CACHE" models/ || true
gsutil -q -m cp -r "gs://$BUCKET/models/body_models/smplx" models/body_models/
gsutil -q cp "$JOBURI/input.mp4" "input/$CLIP.mp4"
gsutil -q -m cp -r "$JOBURI/scripts" .
python3 -m venv venv
venv/bin/pip install -q --upgrade pip
venv/bin/pip install -q -r requirements.txt scipy ninja gsplat
# gsplat JIT-compiles its CUDA kernels on first use.
export CUDA_HOME=/usr/local/cuda PATH="/usr/local/cuda/bin:$PWD/venv/bin:$PATH"
venv/bin/python -c "import torch; assert torch.cuda.is_available(); print('cuda', torch.cuda.get_device_name(0))"
# Downloads anything the cache lacks and creates GVHMR's checkpoint/body-model links (also needed
# when inference is skipped via reuse-from).
venv/bin/python -c "from fdanyone.download import ensure_smplx, ensure_models; ensure_smplx('models', 'third_party/GVHMR'); ensure_models('models', 'third_party/GVHMR')"

# Diffusion output is staged to GCS as soon as it exists so later failures never repeat it;
# reuse-from=<job-id> resumes from another job's stage.
STAGE_SRC="$JOBURI/stage"
[ -n "$REUSE" ] && STAGE_SRC="gs://$BUCKET/jobs/$REUSE/stage"
if gsutil -q stat "$STAGE_SRC/fdanyone/$CLIP/cameras.json"; then
  status inference "reusing staged multi-view videos from $STAGE_SRC"
  mkdir -p data/fdanyone data/gvhmr/results
  gsutil -q -m cp -r "$STAGE_SRC/fdanyone/$CLIP" data/fdanyone/
  gsutil -q -m cp -r "$STAGE_SRC/gvhmr/$CLIP" data/gvhmr/results/
else
  status inference "4DAnyone multi-view diffusion ($VIEWS views/layer, pitches $PITCHES)"
  venv/bin/python inference.py --video_path "input/$CLIP.mp4" --views_per_layer "$VIEWS" \
    --layer_pitches "$PITCHES" --data_dir data --model_dir models
  gsutil -q -m cp -r "data/fdanyone/$CLIP" "$JOBURI/stage/fdanyone/"
  gsutil -q -m cp -r "data/gvhmr/results/$CLIP" "$JOBURI/stage/gvhmr/"
fi

gsutil -q -m rsync -r -x 'body_models/.*' models/ "$MODEL_CACHE" &
CACHE_SYNC_PID=$!

status export "SMPL-X body export from 4DAnyone's GVHMR motion"
venv/bin/python scripts/run_gvhmr.py --video "input/$CLIP.mp4" --out-dir out --device cuda \
  --gvhmr-root third_party/GVHMR --motion-dir "data/gvhmr/results/$CLIP"

status refine "animatable Gaussian avatar training ($ITERS iterations)"
venv/bin/python scripts/refine_multiview_avatar.py --body out/gvhmr_body.json \
  --result-dir "data/fdanyone/$CLIP" --source out/gvhmr_input.mp4 --out-dir out/refined \
  --birefnet models/birefnet --fdanyone-root . --iters "$ITERS"

status upload "uploading results"
gsutil -q -m cp out/gvhmr_body.json "$JOBURI/output/"
gsutil -q -m cp -r out/refined "data/fdanyone/$CLIP/cameras.json" "data/fdanyone/$CLIP/metadata.json" \
  "data/fdanyone/$CLIP/videos" "$JOBURI/output/"
# Only wait for the cache sync: a bare `wait` would also wait on the tee log process substitution.
wait "$CACHE_SYNC_PID" || true
status done "complete"
finish
