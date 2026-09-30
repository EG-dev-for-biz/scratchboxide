#!/bin/bash
# Cloud Run job task: one stage of a multi-view job, described by environment overrides from
# MultiviewCloudService (JOB_ID, CLIP, VIEWS, PITCHES, ITERS, REUSE_FROM, STAGE, REFINE_MAX_SECONDS,
# VIEWS_PER_GROUP).
# Cloud Run caps GPU tasks at 1 hour, so a job runs as STAGE=inference (stages the diffusion output)
# followed by STAGE=refine (reads the stage); STAGE=all does both in one task.
# The artifacts bucket is mounted at /mnt/artifacts:
#   runtime/models/        cached weights
#   models/body_models/    licensed SMPL-X
#   jobs/<JOB_ID>/         input.mp4, scripts/, status.json, log.txt, stage/, output/
set -euo pipefail

A=/mnt/artifacts
JOBDIR="$A/jobs/$JOB_ID"
CLIP="${CLIP:-performer}"
STAGE="${STAGE:-all}"
LOG=/tmp/multiview-job.log
export PATH="/usr/local/cuda/bin:/opt/venv/bin:$PATH"
export PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True
exec > >(tee -a "$LOG") 2>&1

status() {
  printf '{"state":"%s","detail":"%s","time":"%s","execution":"%s"}\n' \
    "$1" "$2" "$(date -Is)" "${CLOUD_RUN_EXECUTION:-}" > "$JOBDIR/status.json"
}
trap 'status failed "line $LINENO"; cp "$LOG" "$JOBDIR/log.txt" || true' ERR

cd /opt/multiview-main
status setup "linking weights"
mkdir -p models/body_models input out
for d in diffusion gvhmr birefnet perceptual; do [ -d "$A/runtime/models/$d" ] && ln -sfn "$A/runtime/models/$d" "models/$d"; done
ln -sfn "$A/models/body_models/smplx" models/body_models/smplx
python -c "from fdanyone.download import ensure_smplx, ensure_models; ensure_smplx('models', 'third_party/GVHMR'); ensure_models('models', 'third_party/GVHMR')" || true
python -c "import torch; assert torch.cuda.is_available(); print('cuda', torch.cuda.get_device_name(0))"
cp "$JOBDIR/input.mp4" "input/$CLIP.mp4"
rm -rf scripts && cp -r "$JOBDIR/scripts" scripts

STAGE_SRC="$JOBDIR/stage"
[ -n "${REUSE_FROM:-}" ] && STAGE_SRC="$A/jobs/$REUSE_FROM/stage"
if [ -f "$STAGE_SRC/fdanyone/$CLIP/cameras.json" ] && [ "$STAGE" != inference ]; then
  status inference "reusing staged multi-view videos from ${REUSE_FROM:-this job}"
  mkdir -p data/fdanyone data/gvhmr/results
  cp -r "$STAGE_SRC/fdanyone/$CLIP" data/fdanyone/
  cp -r "$STAGE_SRC/gvhmr/$CLIP" data/gvhmr/results/
elif [ "$STAGE" = refine ]; then
  echo "no staged diffusion output at $STAGE_SRC"; false
else
  status inference "Multi-view diffusion ($VIEWS views/layer, pitches $PITCHES)"
  python inference.py --video_path "input/$CLIP.mp4" --views_per_layer "$VIEWS" \
    --layer_pitches "$PITCHES" --views_per_group "${VIEWS_PER_GROUP:-auto}" --data_dir data --model_dir models
  mkdir -p "$JOBDIR/stage/fdanyone" "$JOBDIR/stage/gvhmr"
  cp -r "data/fdanyone/$CLIP" "$JOBDIR/stage/fdanyone/"
  cp -r "data/gvhmr/results/$CLIP" "$JOBDIR/stage/gvhmr/"
fi
if [ "$STAGE" = inference ]; then
  cp "$LOG" "$JOBDIR/log.txt"
  status staged "multi-view videos staged"
  exit 0
fi

status export "SMPL-X body export from GVHMR motion"
python scripts/run_gvhmr.py --video "input/$CLIP.mp4" --out-dir out --device cuda \
  --gvhmr-root third_party/GVHMR --motion-dir "data/gvhmr/results/$CLIP"

status refine "animatable Gaussian avatar training ($ITERS iterations)"
python scripts/refine_multiview_avatar.py --body out/gvhmr_body.json \
  --result-dir "data/fdanyone/$CLIP" --source out/gvhmr_input.mp4 --out-dir out/refined \
  --birefnet models/birefnet --fdanyone-root . --iters "$ITERS" --max-seconds "${REFINE_MAX_SECONDS:-0}"

status upload "writing results"
mkdir -p "$JOBDIR/output"
cp out/gvhmr_body.json "$JOBDIR/output/"
cp -r out/refined "data/fdanyone/$CLIP/cameras.json" "data/fdanyone/$CLIP/metadata.json" \
  "data/fdanyone/$CLIP/videos" "$JOBDIR/output/"
cp "$LOG" "$JOBDIR/log.txt"
status done "complete"
