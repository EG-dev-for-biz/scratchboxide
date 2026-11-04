#!/usr/bin/env bash
# Runs a command (the app's dev server) on the development machine with the app's environment:
#   - Gemini on Vertex AI and the bucket through the machine's own service account (no key file: SCRATCHBOX_GOOGLE_ADC);
#   - the build caches mirrored to and restored from the training bucket;
#   - the secrets read from Secret Manager into this process's environment only: never written to disk, never printed.
#
#   deploy/devbox/app-env.sh npm run dev
#
# SB_SECRETS lists the secrets as ENV_NAME=secret-name pairs (default: the Maps key the K-D chunk job also reads).
# Only the app gets these: tests run without them (and with the metadata server's credentials switched off, vitest.config.ts).
set -euo pipefail

export GOOGLE_CLOUD_PROJECT="${GOOGLE_CLOUD_PROJECT:-scoutscan}"
export GOOGLE_CLOUD_LOCATION="${GOOGLE_CLOUD_LOCATION:-us-central1}"
export SCRATCHBOX_GOOGLE_ADC=1
export SCRATCHBOX_TRAINING_BUCKET="${SCRATCHBOX_TRAINING_BUCKET:-scoutscan-building-training}"
SB_SECRETS="${SB_SECRETS:-GOOGLE_MAPS_API_KEY=kd-maps-api-key}"

GCLOUD="$(command -v gcloud || echo /snap/bin/gcloud)"
for pair in $SB_SECRETS; do
  var="${pair%%=*}" secret="${pair#*=}"
  value="$("$GCLOUD" secrets versions access latest --secret "$secret" --project "$GOOGLE_CLOUD_PROJECT" 2>/dev/null)" \
    || { echo "app-env: cannot read the secret $secret for $var (does the machine's account have secretAccessor on it?)" >&2; exit 1; }
  export "$var=$value"
done
unset value

exec "$@"
