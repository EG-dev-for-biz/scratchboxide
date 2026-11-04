#!/usr/bin/env bash
# Prepares a checkout on the development machine, as its developer (not root), from the checkout's root:
#
#   deploy/devbox/bootstrap-user.sh [WEB_PORT]
#
#   - the Node packages (npm ci, on the machine's Node 22.18);
#   - the project's Python venv (.venv) from requirements.txt: PyPI's Linux torch wheels carry CUDA, and the check below
#     fails unless torch sees the L4;
#   - Depth Anything V2 Small's weights in .model-cache/;
#   - a launch entry in .claude/launch.json (scratchbox-devbox): the app on 127.0.0.1 ports WEB_PORT..+2 (default
#     3730-3732), wrapped by app-env.sh so it gets Vertex AI, the bucket and the secrets.
#
# The build caches are not copied here: a stage this workspace lacks is restored from gs://scoutscan-building-training/
# cache/v1 when a build asks for it (cache-mirror.ts restoreCacheEntry), with its absolute paths moved onto this checkout.
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"
WEB_PORT="${1:-3730}"
API_PORT=$((WEB_PORT + 1)) TOOLS_PORT=$((WEB_PORT + 2))

echo "[bootstrap] node $(node --version), npm $(npm --version) in $ROOT"
npm ci --no-audit --no-fund

if [ ! -x .venv/bin/python ]; then
  python3 -m venv .venv
fi
.venv/bin/pip install -q --upgrade pip
.venv/bin/pip install -q -r requirements.txt
.venv/bin/python - <<'PY'
import torch
assert torch.cuda.is_available(), f"torch {torch.__version__} does not see a CUDA device (built for CUDA {torch.version.cuda})"
print(f"[bootstrap] torch {torch.__version__} on CUDA {torch.version.cuda}: {torch.cuda.get_device_name(0)}")
PY
[ -f tools/depth/fetch_depth_model.py ] && .venv/bin/python tools/depth/fetch_depth_model.py

mkdir -p .claude
python3 - "$ROOT" "$WEB_PORT" "$API_PORT" "$TOOLS_PORT" <<'PY'
import json, os, sys
root, web, api, tools = sys.argv[1], *map(int, sys.argv[2:])
path = os.path.join(root, '.claude', 'launch.json')
try:
    launch = json.load(open(path))
except FileNotFoundError:
    launch = {'version': '0.0.1', 'configurations': []}
entry = {
    'name': 'scratchbox-devbox',
    'runtimeExecutable': os.path.join(root, 'deploy', 'devbox', 'app-env.sh'),
    'runtimeArgs': ['env', 'SCRATCHBOX_NO_ELECTRON=true', f'PORT={api}', f'SCRATCHBOX_WEB_PORT={web}', f'SCRATCHBOX_TOOLS_PORT={tools}',
                    f'SCRATCHBOX_ALLOWED_ORIGINS=http://127.0.0.1:{web},http://localhost:{web}', 'npm', '--prefix', root, 'run', 'dev'],
    'port': web,
    'autoPort': False,
}
launch['configurations'] = [c for c in launch.get('configurations', []) if c.get('name') != entry['name']] + [entry]
json.dump(launch, open(path, 'w'), indent=2)
print(f'[bootstrap] launch entry scratchbox-devbox: web {web}, API {api}, tools {tools}')
PY
echo "[bootstrap] done"
